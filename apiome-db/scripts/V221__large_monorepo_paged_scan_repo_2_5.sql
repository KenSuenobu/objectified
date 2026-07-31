-- Large-monorepo support: sparse / paged repository walk (REPO-2.5, #2766).
--
-- The REPO-2 walker fetched a whole branch tree in one `recursive=1` Trees call,
-- buffered every blob in a Python list, and rewrote `tenant_repository_files` in a
-- single statement. On a monorepo with >25k entries that blows both the memory and
-- the time budget, and GitHub simply flags the response `truncated` — which the
-- walker turned into a hard failure ("repository too large for this scan pass").
--
-- REPO-2.5 makes the walk bounded and resumable. Two schema pieces support it:
--
--   1. `tenant_repository_scan_cursors` — one stored resume cursor per
--      (repository, branch). The walker persists its position (pinned tree SHA,
--      pending sub-tree queue, entries already emitted) whenever a pass stops
--      early, either because the per-scan wall-clock budget ran out or because a
--      transient provider error interrupted it. The next pass resumes from the
--      cursor instead of restarting the walk. A completed scan deletes its row, so
--      the presence of a row means "this branch has an unfinished walk".
--
--   2. `tenants.repository_scan_budget_seconds` — the per-tenant wall-clock budget
--      for a single scan pass, defaulting to 300s (5 minutes). The application
--      clamps it to a configurable floor/ceiling
--      (`APIOME_REPOSITORY_SCAN_BUDGET_MIN` / `_MAX`) at read time, mirroring how
--      the refresh cadence floor works (RAR-3.1).
SET search_path TO apiome, public;

-- 1. Per-tenant wall-clock budget for one scan pass ---------------------------

ALTER TABLE apiome.tenants
  ADD COLUMN IF NOT EXISTS repository_scan_budget_seconds INTEGER NOT NULL DEFAULT 300;

ALTER TABLE apiome.tenants
  DROP CONSTRAINT IF EXISTS ck_tenants_repository_scan_budget_positive;

ALTER TABLE apiome.tenants
  ADD CONSTRAINT ck_tenants_repository_scan_budget_positive
  CHECK (repository_scan_budget_seconds > 0);

COMMENT ON COLUMN apiome.tenants.repository_scan_budget_seconds IS
  'Per-tenant wall-clock budget in seconds for one repository scan pass (REPO-2.5, default 300 = 5 min). When the budget is spent the walker stores a resume cursor in tenant_repository_scan_cursors and the next pass continues from it. Clamped in the application to [APIOME_REPOSITORY_SCAN_BUDGET_MIN, APIOME_REPOSITORY_SCAN_BUDGET_MAX].';

-- 2. Stored resume cursor per (repository, branch) ----------------------------

CREATE TABLE IF NOT EXISTS apiome.tenant_repository_scan_cursors (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  repository_id UUID NOT NULL REFERENCES apiome.tenant_repositories(id) ON DELETE CASCADE,
  branch TEXT NOT NULL,
  cursor_json JSONB NOT NULL,
  entries_indexed INTEGER NOT NULL DEFAULT 0,
  importable_indexed INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_tenant_repository_scan_cursors_repo_branch UNIQUE (repository_id, branch)
);

CREATE INDEX IF NOT EXISTS idx_tenant_repository_scan_cursors_repository
  ON apiome.tenant_repository_scan_cursors (repository_id);

COMMENT ON TABLE apiome.tenant_repository_scan_cursors IS
  'Resume cursor for an unfinished repository tree walk (REPO-2.5). One row per (repository_id, branch); written when a scan pass pauses on its wall-clock budget or a transient provider error, deleted when the walk completes.';

COMMENT ON COLUMN apiome.tenant_repository_scan_cursors.cursor_json IS
  'Opaque walker position: pinned tree SHA + branch-tip recency anchors, walk mode (recursive|sparse), pending sub-tree queue, and the count of entries already emitted. Shape is owned by app.repository_scan_budget.ScanCursor.';

COMMENT ON COLUMN apiome.tenant_repository_scan_cursors.attempt_count IS
  'Consecutive resumed passes that indexed nothing new; a pass that made progress resets it to 0. The walker abandons the cursor (and fails the scan) once it reaches the application cap, so a wedged walk cannot retry forever while a long monorepo walk is never penalized for taking many passes.';

-- 3. Fair queueing for resumed scans -----------------------------------------
--
-- A paused monorepo scan goes back on the queue to be resumed. The queue is
-- claimed oldest-first, so without this a repository needing twenty passes would
-- win every claim and starve every other tenant's scan for the whole walk.
-- `requeued_at` moves a resumed job to the back of the line while leaving
-- `created_at` intact as the original enqueue time.

ALTER TABLE apiome.tenant_repository_file_scan_jobs
  ADD COLUMN IF NOT EXISTS requeued_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_tenant_repo_file_scan_jobs_queued_fair
  ON apiome.tenant_repository_file_scan_jobs ((COALESCE(requeued_at, created_at)))
  WHERE status = 'queued';

COMMENT ON COLUMN apiome.tenant_repository_file_scan_jobs.requeued_at IS
  'When this job was last put back on the queue to resume a paused or interrupted walk (REPO-2.5). NULL for a job that has never paused. The claim order is COALESCE(requeued_at, created_at), so a long monorepo walk yields to other repositories between passes.';
