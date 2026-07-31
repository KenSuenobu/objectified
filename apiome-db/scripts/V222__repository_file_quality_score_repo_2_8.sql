-- Quality scoring per discovered spec (REPO-2.8, #2769).
--
-- The REPO-2 scanner classifies a discovered file by filename only (`detected_kind`), which
-- tells an operator *what* a file is but nothing about whether it is any good. Opening each
-- candidate one by one is the only way to find out today.
--
-- REPO-2.8 attaches a rough 0-100 quality signal to each *classified* spec row. The score is
-- produced by the engines the platform already scores imports with — the OpenAPI path/schema
-- linter (`app.schema_lint.lint_openapi_spec`, the PATH-QUALITY + SCHEMA-QUALITY rules) and,
-- for the other formats, the canonical-model rule packs behind `ImportSource.lint` — so a
-- repository file and an imported revision are graded on one comparable scale.
--
-- Five columns carry it, all nullable so every existing row reads as "not scored yet":
--
--   * `quality_score`            0-100, only for a file the engine actually scored.
--   * `quality_grade`            the matching A-F letter, same roll-up as `versions.quality_grade`.
--   * `quality_status`           'scored' | 'skipped' | 'error'; NULL = never attempted.
--   * `quality_reason`           stable machine reason for a skip/error ('unclassified',
--                                'no-adapter', 'too-large', 'parse-failed', ...), never free text.
--   * `quality_scored_at`        when the attempt ran.
--   * `quality_scored_blob_sha`  the blob the attempt read.
--
-- `quality_scored_blob_sha` is what makes the scoring pass bounded: the sweep claims rows whose
-- stored sha differs from the row's current `blob_sha`, so every (file, blob) pair is attempted
-- exactly once and an unscorable file is not re-fetched on every tick. Editing the file (new
-- blob sha) makes it eligible again.
--
-- The score is informational only. Nothing here gates a scan, a refresh, or an import — spec
-- promotion gating lives in the REPO-5.6 promotion gates.
SET search_path TO apiome, public;

ALTER TABLE apiome.tenant_repository_files
  ADD COLUMN IF NOT EXISTS quality_score SMALLINT,
  ADD COLUMN IF NOT EXISTS quality_grade VARCHAR(2),
  ADD COLUMN IF NOT EXISTS quality_status VARCHAR(32),
  ADD COLUMN IF NOT EXISTS quality_reason VARCHAR(64),
  ADD COLUMN IF NOT EXISTS quality_scored_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS quality_scored_blob_sha VARCHAR(64);

ALTER TABLE apiome.tenant_repository_files
  DROP CONSTRAINT IF EXISTS ck_tenant_repository_files_quality_score_range;

ALTER TABLE apiome.tenant_repository_files
  ADD CONSTRAINT ck_tenant_repository_files_quality_score_range
  CHECK (quality_score IS NULL OR (quality_score >= 0 AND quality_score <= 100));

ALTER TABLE apiome.tenant_repository_files
  DROP CONSTRAINT IF EXISTS ck_tenant_repository_files_quality_status;

ALTER TABLE apiome.tenant_repository_files
  ADD CONSTRAINT ck_tenant_repository_files_quality_status
  CHECK (quality_status IS NULL OR quality_status IN ('scored', 'skipped', 'error'));

-- The scoring sweep's claim predicate: rows never attempted, or attempted against an older
-- blob. Partial so the index stays small on a monorepo where most rows are already settled.
CREATE INDEX IF NOT EXISTS idx_tenant_repository_files_quality_pending
  ON apiome.tenant_repository_files (repository_id, path)
  WHERE quality_scored_blob_sha IS DISTINCT FROM blob_sha;

COMMENT ON COLUMN apiome.tenant_repository_files.quality_score IS
  'Rough 0-100 quality score for a classified spec (REPO-2.8), from the same lint engines that score imports. NULL when the file was never scored or could not be scored. Informational only — never gates sync or import.';

COMMENT ON COLUMN apiome.tenant_repository_files.quality_grade IS
  'A-F letter grade matching quality_score, on the same scale as versions.quality_grade (REPO-2.8).';

COMMENT ON COLUMN apiome.tenant_repository_files.quality_status IS
  'Outcome of the last scoring attempt: scored | skipped | error. NULL means no attempt has run yet (REPO-2.8).';

COMMENT ON COLUMN apiome.tenant_repository_files.quality_reason IS
  'Stable machine reason for a skipped/error attempt (unclassified, no-adapter, adapter-unavailable, too-large, fetch-failed, parse-failed, normalize-failed, lint-failed, unscored). NULL when scored (REPO-2.8).';

COMMENT ON COLUMN apiome.tenant_repository_files.quality_scored_at IS
  'When the last scoring attempt ran (REPO-2.8).';

COMMENT ON COLUMN apiome.tenant_repository_files.quality_scored_blob_sha IS
  'The blob sha the last attempt read. The sweep claims rows where this differs from blob_sha, so each (file, blob) is attempted once and a changed file is re-scored (REPO-2.8).';
