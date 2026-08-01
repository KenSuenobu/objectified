-- Cross-repository discovered-spec catalog indexes (REPO-6.4, #2797).
--
-- The catalog at `/ade/dashboard/repositories/catalog` lists every discovered spec a tenant
-- owns, across every repository, with free-text search and server-side pagination. Its
-- acceptance bar is "works at 10k+ files", and the existing indexes do not get it there:
--
--   * The search matches `path ILIKE '%term%'`. A leading wildcard makes the b-tree on
--     `(repository_id, branch)` useless for the predicate, so every keystroke degenerates into
--     a sequential scan of the tenant's whole file table. A trigram GIN index makes the same
--     substring match indexable.
--
--   * Each catalog row resolves its most recent import through a LATERAL keyed on
--     `(repository_id, branch, path)` ordered by `created_at DESC`. The only index on
--     `tenant_repository_imports` starts at `(repository_id, created_at)`, which forces the
--     planner to read and re-sort every import a repository ever made in order to answer
--     "the latest one for this path" — once per row on the page.
--
-- Nothing here changes a column or a value; these are pure read-path indexes and the catalog
-- returns identical results with or without them.
SET search_path TO apiome, public;

-- 1. Trigram search over file paths and repository names ----------------------
--
-- `pg_trgm` is a contrib extension. On a managed Postgres where the migration role cannot
-- install extensions, creating it raises rather than warning — and a missing search index is a
-- performance regression, not a correctness one. So the whole trigram block degrades to a
-- NOTICE: the catalog still returns the right rows, just with a sequential scan behind the
-- search box until an operator installs the extension and re-runs this migration.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;

  CREATE INDEX IF NOT EXISTS idx_tenant_repository_files_path_trgm
    ON apiome.tenant_repository_files USING gin (path gin_trgm_ops);

  CREATE INDEX IF NOT EXISTS idx_tenant_repositories_full_name_trgm
    ON apiome.tenant_repositories USING gin (repository_full_name gin_trgm_ops)
    WHERE deleted_at IS NULL;
EXCEPTION
  WHEN insufficient_privilege OR undefined_file OR feature_not_supported THEN
    RAISE NOTICE
      'pg_trgm unavailable; skipping repository catalog trigram indexes (REPO-6.4). '
      'Catalog search still works, but scans sequentially.';
END
$$;

-- 2. Latest-import lookup per discovered file ---------------------------------
--
-- Matches the LATERAL in `Database.tenant_repository_spec_catalog`: equality on
-- `(repository_id, branch, path)` then `created_at DESC LIMIT 1`, which this index answers
-- with a single backwards index scan.
CREATE INDEX IF NOT EXISTS idx_tenant_repository_imports_repo_branch_path_recent
  ON apiome.tenant_repository_imports (repository_id, branch, path, created_at DESC);

COMMENT ON INDEX apiome.idx_tenant_repository_imports_repo_branch_path_recent IS
  'REPO-6.4: resolves the most recent import of one discovered file for the cross-repo catalog.';

-- 3. Project-mapping lookup by project ----------------------------------------
--
-- The "Project" filter and the project facet both group by
-- `repository_import_spec.project_id`. The table is indexed on `(tenant_id, repository_id)`
-- only, so filtering to one project scans every mapping the tenant has.
CREATE INDEX IF NOT EXISTS idx_repository_import_spec_project
  ON apiome.repository_import_spec (project_id);

COMMENT ON INDEX apiome.idx_repository_import_spec_project IS
  'REPO-6.4: supports filtering and faceting the cross-repo spec catalog by mapped project.';
