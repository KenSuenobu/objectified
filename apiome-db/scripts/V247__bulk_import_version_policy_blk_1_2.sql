-- Batch reconciliation policy + the provenance index it resolves against (BLK-1.2, #5524).
--
-- `POST …/import/bulk/plan` (MFI-29.5) described every item of a batch as if the tenant were
-- empty: a `specs/` folder re-imported after a change looked byte-for-byte like a first-time
-- import. BLK-1.2 makes the plan answer "does a project for this spec already exist?" before
-- anything is written, and that answer needs two things from the database.
--
--   1. A stored policy saying what a *match* should mean, at the two scopes the ticket calls
--      for — a tenant default, overridable per repository:
--
--          append-when-matched  (default) matched items append a version to the project they
--                               matched; unmatched items create a project. This is the
--                               behaviour the batch flow exists to provide.
--          always-create        every item creates a project. Matches are still *reported*
--                               by the plan, so ignoring them is visible rather than hidden.
--          always-ask           every item is reported unresolved and needs an explicit
--                               per-item choice at apply time.
--
--      `tenants.bulk_import_version_policy` is NOT NULL DEFAULT 'append-when-matched': the
--      default is the useful behaviour, and it is the behaviour a tenant with no opinion
--      gets. `tenant_repositories.bulk_import_version_policy` is **nullable**, and NULL means
--      *inherit the tenant* — an override table/column that defaulted to a value could not
--      express "no opinion", which is the state every existing repository is in. Resolution
--      order, applied in `app/bulk_import_reconciliation.py`:
--
--          repository override ──► tenant default ──► 'append-when-matched'
--
--   2. An index for the strongest match signal. Repository provenance is already recorded on
--      the revision by MFI-29.3 (`git_provenance_metadata`) as `format_metadata->>'gitRepoUrl'`
--      / `->>'gitPath'`; nothing ever read it back, so nothing indexed it. The plan endpoint
--      now looks a path up once per item, which without an index is a sequential scan of
--      `apiome.versions` per item of every batch.
--
-- Nothing here changes what an import *does*. The plan endpoint stays read-only — these
-- columns are read by it and written only by a settings call — and the apply step (BLK-1.4)
-- is what acts on a resolution.
--
-- Rollback:
--   DROP INDEX IF EXISTS apiome.idx_versions_git_provenance_path;
--   ALTER TABLE apiome.tenant_repositories DROP COLUMN IF EXISTS bulk_import_version_policy;
--   ALTER TABLE apiome.tenants DROP COLUMN IF EXISTS bulk_import_version_policy;
SET search_path TO apiome, public;

-- ─── 1. Tenant default ────────────────────────────────────────────────────────

ALTER TABLE apiome.tenants
  ADD COLUMN IF NOT EXISTS bulk_import_version_policy VARCHAR(32) NOT NULL
    DEFAULT 'append-when-matched';

-- Constrained rather than free text, for the same reason RAR-4.5 constrains
-- `refresh_conflict_policy`: an unrecognised policy would have to be interpreted at plan
-- time, and the only safe interpretation ("fall back to the default") silently discards what
-- the operator asked for. Rejecting the write surfaces the typo instead.
ALTER TABLE apiome.tenants
  DROP CONSTRAINT IF EXISTS ck_tenants_bulk_import_version_policy;

ALTER TABLE apiome.tenants
  ADD CONSTRAINT ck_tenants_bulk_import_version_policy
  CHECK (bulk_import_version_policy IN ('append-when-matched', 'always-create', 'always-ask'));

COMMENT ON COLUMN apiome.tenants.bulk_import_version_policy IS
  'Tenant default for what a bulk-import plan does with an item that matches an existing project (BLK-1.2): append-when-matched (default — matched items append a version, unmatched items create a project) | always-create (every item creates a project; matches are still reported) | always-ask (every item is reported unresolved and needs a per-item choice at apply time). A non-NULL tenant_repositories.bulk_import_version_policy takes precedence.';

-- ─── 2. Per-repository override ───────────────────────────────────────────────

-- Nullable on purpose: NULL is "this repository has no opinion, use the tenant's". A NOT NULL
-- DEFAULT would have to invent an opinion for every repository that already exists, and the
-- plan could then never tell an inherited default from a deliberate one — which is exactly
-- what `version_policy_source` on the plan response reports.
ALTER TABLE apiome.tenant_repositories
  ADD COLUMN IF NOT EXISTS bulk_import_version_policy VARCHAR(32);

ALTER TABLE apiome.tenant_repositories
  DROP CONSTRAINT IF EXISTS ck_tenant_repositories_bulk_import_version_policy;

ALTER TABLE apiome.tenant_repositories
  ADD CONSTRAINT ck_tenant_repositories_bulk_import_version_policy
  CHECK (
    bulk_import_version_policy IS NULL
    OR bulk_import_version_policy IN ('append-when-matched', 'always-create', 'always-ask')
  );

COMMENT ON COLUMN apiome.tenant_repositories.bulk_import_version_policy IS
  'Repository-level override of tenants.bulk_import_version_policy for bulk-import plans (BLK-1.2): append-when-matched | always-create | always-ask. NULL — the default for every repository — means inherit the tenant policy.';

-- ─── 3. Repository-provenance lookup index ────────────────────────────────────

-- The plan's strongest match: "which project holds a revision imported from this repository
-- at this path?". `gitPath` leads the key because it is the selective half — a monorepo has
-- one repository URL and thousands of paths — and the partial predicate keeps the index to
-- the git-sourced revisions, which are a small minority of `apiome.versions`.
CREATE INDEX IF NOT EXISTS idx_versions_git_provenance_path
    ON apiome.versions ((format_metadata ->> 'gitPath'), (format_metadata ->> 'gitRepoUrl'))
    WHERE format_metadata ->> 'gitPath' IS NOT NULL;

COMMENT ON INDEX apiome.idx_versions_git_provenance_path IS
    'Repository-provenance reconciliation for bulk-import plans (BLK-1.2): resolves "which project already holds a revision imported from this repo path?" against the MFI-29.3 provenance recorded on format_metadata. Partial — only git-sourced revisions carry gitPath.';
