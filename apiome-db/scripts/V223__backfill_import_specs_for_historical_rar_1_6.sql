-- Backfill best-effort import specs for historical repository imports (RAR-1.6, #3517).
--
-- Files imported before spec capture shipped (RAR-1.2, V105) have no
-- `repository_import_spec` row, so the auto-refresh sweep (RAR-3.2) never sees
-- them: they would silently never refresh. This migration seeds one conservative
-- default spec per historical imported-file lineage recorded in
-- `tenant_repository_imports`, flagged `backfilled = TRUE` so a seeded spec is
-- always distinguishable from a user-authored one ("imported before spec
-- capture" in the UI).
--
-- The seeded spec is deliberately minimal:
--   * `options_json = '{}'` — the system import defaults; the RAR-1.4 envelope
--     (spec_schema_version = 1) validates an empty blob into current-shape
--     `SpecImportOptions` defaults on read.
--   * `source_kind` is detected, not invented: `arazzo` when the indexed scan row
--     (`tenant_repository_files.detected_kind`) or the filename says so,
--     otherwise `openapi` — the only two importer kinds the repository import
--     path has ever written, with openapi the dominant default.
--   * Freshness anchors (RAR-2.1): when the historical audit row recorded the
--     imported `blob_sha`, only that checksum is seeded (commit anchors NULL) so
--     the RAR-2.2 comparator falls back to checksum gating and flags the file
--     stale iff its content changed since the import. Without a recorded blob,
--     the anchors are taken from the current scan row — "treat as up to date
--     now, refresh on the next upstream change" — which never triggers a
--     spurious re-import wave.
--
-- Idempotent and re-runnable: the column add is IF NOT EXISTS, the insert skips
-- lineages that already have a spec (NOT EXISTS) and never overwrites a
-- user-authored row (ON CONFLICT DO NOTHING). Soft-deleted repositories and
-- projects are skipped, matching the live capture path's tenant/repository guard.

SET search_path TO apiome, public;

ALTER TABLE apiome.repository_import_spec
  ADD COLUMN IF NOT EXISTS backfilled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN apiome.repository_import_spec.backfilled IS
  'TRUE when this spec was seeded by the RAR-1.6 historical backfill (default options + detected source_kind) rather than captured from a user-authored import; cleared on the next genuine import of the lineage.';

INSERT INTO apiome.repository_import_spec (
  tenant_id, repository_id, branch, path, project_id,
  source_kind, format_override, content_type,
  options_json, spec_schema_version, created_by,
  last_imported_commit_sha, last_imported_committed_at, last_imported_blob_sha,
  backfilled
)
SELECT DISTINCT ON (tri.repository_id, tri.branch, tri.path)
  tri.tenant_id, tri.repository_id, tri.branch, tri.path, tri.project_id,
  CASE
    WHEN trf.detected_kind ILIKE 'arazzo%' THEN 'arazzo'
    WHEN regexp_replace(lower(tri.path), '^.*/', '') LIKE '%arazzo%'
         AND (lower(tri.path) LIKE '%.yaml' OR lower(tri.path) LIKE '%.yml'
              OR lower(tri.path) LIKE '%.json') THEN 'arazzo'
    ELSE 'openapi'
  END,
  NULL, NULL,
  '{}'::jsonb, 1, tri.imported_by,
  CASE WHEN b.imported_blob_sha IS NOT NULL THEN NULL ELSE trf.commit_sha END,
  CASE WHEN b.imported_blob_sha IS NOT NULL THEN NULL ELSE trf.committed_at END,
  COALESCE(b.imported_blob_sha, trf.blob_sha),
  TRUE
FROM apiome.tenant_repository_imports tri
CROSS JOIN LATERAL (SELECT NULLIF(tri.blob_sha, '') AS imported_blob_sha) b
JOIN apiome.tenant_repositories tr
  ON tr.id = tri.repository_id AND tr.deleted_at IS NULL
JOIN apiome.projects p
  ON p.id = tri.project_id AND p.deleted_at IS NULL
LEFT JOIN apiome.tenant_repository_files trf
  ON trf.repository_id = tri.repository_id
 AND trf.branch = tri.branch
 AND trf.path = tri.path
WHERE NOT EXISTS (
  SELECT 1 FROM apiome.repository_import_spec s
  WHERE s.repository_id = tri.repository_id
    AND s.branch = tri.branch
    AND s.path = tri.path
)
ORDER BY tri.repository_id, tri.branch, tri.path, tri.created_at DESC
ON CONFLICT ON CONSTRAINT uq_repository_import_spec_repo_branch_path DO NOTHING;
