-- Indexes behind the per-repository health badge (REPO-6.5, #2798).
--
-- The badge is rendered on every row of the repositories list (REPO-6.1) and on the
-- repository detail header (REPO-6.2), so its inputs are read once per repository on the
-- busiest repository screen there is. `Database.get_repository_health_signals` answers it
-- with two correlated aggregates per repository:
--
--   * the scan success rate over a trailing 30-day window, from
--     `apiome.tenant_repository_file_scan_jobs`; and
--   * the parse-error count on the default branch, from
--     `apiome.tenant_repository_files`.
--
-- Neither is indexed for that shape today. The scan queue's existing index is on
-- `repository_id` alone, so the window filter is a filter rather than a range scan, and the
-- file table has no index that isolates the handful of rows whose REPO-2.8 quality attempt
-- failed — without one, a tenant with twenty 10k-file monorepos scans 200k rows to draw
-- twenty badges.
--
-- This migration adds only indexes: nothing here changes a row, so it is re-runnable and
-- costs nothing to roll back (drop the indexes).
SET search_path TO apiome, public;

-- Scan success rate: `WHERE repository_id = ? AND created_at >= now() - interval '30 days'`,
-- aggregating status and finished_at. Leading `repository_id` selects the repository, the
-- descending `created_at` makes the window a bounded range scan from the newest end, and the
-- INCLUDE columns let the aggregate be answered without visiting the heap.
CREATE INDEX IF NOT EXISTS idx_tenant_repo_file_scan_jobs_repo_recent
  ON apiome.tenant_repository_file_scan_jobs (repository_id, created_at DESC)
  INCLUDE (status, finished_at);

COMMENT ON INDEX apiome.idx_tenant_repo_file_scan_jobs_repo_recent IS
  'REPO-6.5 health badge: per-repository scan outcomes over a trailing window.';

-- Parse-error count: the same predicate the health DAO filters on, so the partial index
-- holds only rows that actually contribute a parse error. On a healthy monorepo it is
-- empty, which is exactly the point — the common case reads no rows at all.
CREATE INDEX IF NOT EXISTS idx_tenant_repository_files_parse_errors
  ON apiome.tenant_repository_files (repository_id, branch)
  INCLUDE (quality_scored_at)
  WHERE quality_status = 'error' OR quality_reason = 'parse-failed';

COMMENT ON INDEX apiome.idx_tenant_repository_files_parse_errors IS
  'REPO-6.5 health badge: discovered specs whose REPO-2.8 quality attempt errored or could not parse.';
