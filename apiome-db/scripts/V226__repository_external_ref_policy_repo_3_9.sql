-- Tenant-scoped external `$ref` policy for repository scans (REPO-3.9, #2778).
--
-- A specification discovered by the repository scanner may reference schemas that live
-- outside the repository — `https://schemas.acme.com/common.json#/Money`. The scanner has
-- two bad options and one good one:
--
--   * fetching silently turns every scan into an SSRF primitive and a supply-chain hole;
--   * skipping silently produces a model that is quietly missing definitions;
--   * asking the tenant what it wants, and recording what was done, is the good one.
--
-- REPO-3.9 adds that decision as tenant configuration plus a per-file record of what it
-- cost. Two pieces of schema carry it:
--
--   1. `tenants.repository_external_ref_policy` + `.repository_external_ref_allowlist` —
--      the policy in force for every repository the tenant owns:
--
--        block        (default) nothing is fetched; every external reference is reported
--                     on the file row as a warning listing exactly what is missing.
--        inline       references are fetched at scan time and inlined into the scanned
--                     document — a snapshot, so the imported model is self-contained and
--                     carries no live dependency on the remote host.
--        proxy-fetch  as `inline`, but restricted to the hostname allowlist, which is
--                     mandatory in this mode: an empty allowlist fetches nothing.
--
--      The allowlist is a JSON array of hostname patterns, each either an exact hostname
--      (`schemas.acme.com`), a subdomain wildcard (`*.acme.com`, which matches subdomains
--      at any depth but not the apex), or `*` (any host). It is applied in `inline` mode
--      too whenever it is non-empty, so narrowing a tenant never requires changing mode.
--
--      Every fetch either mode performs writes a `repository.external_ref_fetched` row to
--      the existing `apiome.workflow_audit` ledger (no schema needed for that — the ledger
--      already carries a JSONB `detail`).
--
--   2. `tenant_repository_files.external_ref_warning` — the per-file warning: which
--      references were left unresolved, and why. NULL means "nothing unresolved" (the
--      steady state for the overwhelming majority of files, so the column costs nothing);
--      a JSON object records the policy that applied, when it was recorded, and the
--      itemized references.
--
-- Nothing here gates a scan, a refresh, or an import: the policy decides what may be
-- *fetched*, and the warning reports what that decision cost. A file whose references were
-- blocked is still indexed, still scored, and still importable.
SET search_path TO apiome, public;

-- 1. Per-tenant policy + hostname allowlist ------------------------------------

ALTER TABLE apiome.tenants
  ADD COLUMN IF NOT EXISTS repository_external_ref_policy VARCHAR(32) NOT NULL DEFAULT 'block';

ALTER TABLE apiome.tenants
  ADD COLUMN IF NOT EXISTS repository_external_ref_allowlist JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE apiome.tenants
  DROP CONSTRAINT IF EXISTS ck_tenants_repository_external_ref_policy;

ALTER TABLE apiome.tenants
  ADD CONSTRAINT ck_tenants_repository_external_ref_policy
  CHECK (repository_external_ref_policy IN ('block', 'inline', 'proxy-fetch'));

-- The allowlist is a JSON *array* of patterns; an object or scalar would silently read as
-- "no patterns" in the application and quietly widen or narrow a tenant.
ALTER TABLE apiome.tenants
  DROP CONSTRAINT IF EXISTS ck_tenants_repository_external_ref_allowlist_array;

ALTER TABLE apiome.tenants
  ADD CONSTRAINT ck_tenants_repository_external_ref_allowlist_array
  CHECK (jsonb_typeof(repository_external_ref_allowlist) = 'array');

COMMENT ON COLUMN apiome.tenants.repository_external_ref_policy IS
  'External $ref policy for repository scans (REPO-3.9): block (default, fetch nothing) | inline (fetch and snapshot at scan time) | proxy-fetch (as inline, restricted to repository_external_ref_allowlist, which is mandatory in that mode).';

COMMENT ON COLUMN apiome.tenants.repository_external_ref_allowlist IS
  'JSON array of hostname patterns an external $ref may be fetched from (REPO-3.9). Each entry is an exact hostname (schemas.acme.com), a subdomain wildcard (*.acme.com — subdomains at any depth, not the apex), or * (any host). Empty means: no restriction in inline mode, nothing fetchable in proxy-fetch mode.';

-- 2. Per-file record of what the policy left unresolved -------------------------

ALTER TABLE apiome.tenant_repository_files
  ADD COLUMN IF NOT EXISTS external_ref_warning JSONB;

-- Only rows that actually carry a warning are indexed: on a monorepo virtually every row
-- is NULL, so a partial index keeps "show me the files with unresolved references" cheap
-- without paying for the other 25k rows.
CREATE INDEX IF NOT EXISTS idx_tenant_repository_files_external_ref_warning
  ON apiome.tenant_repository_files (repository_id, branch, path)
  WHERE external_ref_warning IS NOT NULL;

COMMENT ON COLUMN apiome.tenant_repository_files.external_ref_warning IS
  'External $ref warning for this file (REPO-3.9): { policy, recorded_at, unresolved_count, truncated, unresolved: [{location, ref, url, reason, detail}] }. NULL when the file has no unresolved external references. Informational only — never gates a scan, a refresh, or an import.';
