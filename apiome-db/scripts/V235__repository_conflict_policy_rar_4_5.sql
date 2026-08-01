-- Per-repository / per-file refresh conflict policy (RAR-4.5, #3531).
--
-- RAR-4.4 (#3530) gave the auto-refresh loop a safety rule: when the catalog version an
-- import produced has been hand-edited since, the refresh is *held* rather than allowed to
-- clobber the edit. Hold-not-clobber is the right default, but it is only one of the three
-- answers teams actually want when a refresh meets a diverged version:
--
--   overwrite        the repository is the source of truth; let the refresh win and
--                    supersede the hand edit (the divergence is still detected and
--                    reported, it just does not stop the refresh).
--   hold-for-review  (default) the refresh is skipped, the file is flagged `diverged`,
--                    and a human decides — the RAR-4.4 behaviour, unchanged.
--   new-branch       neither side loses: the current version is left untouched and the
--                    refresh lands on a new branch/version for review and merge.
--
-- This migration stores that choice at the two scopes the ticket calls for:
--
--   1. `tenant_repositories.refresh_conflict_policy` — the repository-wide policy. NOT NULL
--      DEFAULT 'hold-for-review' so every existing repository keeps the RAR-4.4 behaviour
--      it has today; opting into `overwrite` is an explicit act, never a migration
--      side-effect.
--
--   2. `apiome.repository_conflict_policy_override` — the per-file exception. Rows are
--      *overrides*, not enrolments: a file with no row inherits its repository's policy, so
--      the table stays tiny (one row per genuinely special file) and a partially-written
--      override set degrades to the repository policy rather than to nothing. Keyed on the
--      same `(repository_id, branch, path)` file-lineage tuple RAR-1.1's
--      `repository_import_spec` uses, so an override addresses exactly one imported file.
--
-- Resolution order, applied in the application (`app/repository_conflict_policy.py`):
--
--      per-file override ──► repository policy ──► 'hold-for-review'
--
-- The override lives in its own table rather than as a column on
-- `tenant_repository_files` deliberately: that table is re-written by every successful scan
-- and its rows only exist for paths the scanner currently sees, so an operator's policy
-- choice would be at the mercy of a rescan or a file temporarily disappearing from a
-- branch. Policy is configuration and outlives the scan index.
--
-- Nothing here changes *when* a refresh runs (RAR-3.1 cadence, RAR-3.3 opt-out) or how
-- divergence is *detected* (RAR-4.4). It only selects what happens once divergence is
-- detected.
SET search_path TO apiome, public;

-- ─── 1. Repository-wide policy ────────────────────────────────────────────────

ALTER TABLE apiome.tenant_repositories
  ADD COLUMN IF NOT EXISTS refresh_conflict_policy VARCHAR(32) NOT NULL DEFAULT 'hold-for-review';

-- Constrained rather than free text: an unrecognised policy would have to be interpreted at
-- refresh time, and the only safe interpretation ("fall back to the default") silently
-- discards what the operator asked for. Rejecting the write instead surfaces the typo.
ALTER TABLE apiome.tenant_repositories
  DROP CONSTRAINT IF EXISTS ck_tenant_repositories_refresh_conflict_policy;

ALTER TABLE apiome.tenant_repositories
  ADD CONSTRAINT ck_tenant_repositories_refresh_conflict_policy
  CHECK (refresh_conflict_policy IN ('overwrite', 'hold-for-review', 'new-branch'));

COMMENT ON COLUMN apiome.tenant_repositories.refresh_conflict_policy IS
  'Repository-wide conflict policy applied when an auto-refresh meets a diverged (hand-edited) version (RAR-4.5): overwrite (let the refresh win) | hold-for-review (default, RAR-4.4 hold-not-clobber) | new-branch (land the refresh on a new branch, leave the current version untouched). A per-file row in repository_conflict_policy_override takes precedence.';

-- ─── 2. Per-file override ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS apiome.repository_conflict_policy_override (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id     UUID NOT NULL REFERENCES apiome.tenants(id) ON DELETE CASCADE,
    repository_id UUID NOT NULL REFERENCES apiome.tenant_repositories(id) ON DELETE CASCADE,
    -- The file-lineage tuple, identical to repository_import_spec (RAR-1.1): an override
    -- addresses one imported file on one branch, not a path across every branch.
    branch        TEXT NOT NULL,
    path          TEXT NOT NULL,
    policy        VARCHAR(32) NOT NULL
                  CHECK (policy IN ('overwrite', 'hold-for-review', 'new-branch')),
    -- Who set the override, for the audit answer to "why did this file get clobbered".
    -- SET NULL rather than CASCADE: deleting a user must not silently delete policy.
    created_by    UUID REFERENCES apiome.users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_repository_conflict_policy_override_file
        UNIQUE (repository_id, branch, path)
);

COMMENT ON TABLE apiome.repository_conflict_policy_override IS
    'Per-file conflict-policy override for repository auto-refresh (RAR-4.5, #3531). Rows are exceptions: a file with no row inherits tenant_repositories.refresh_conflict_policy, which itself defaults to hold-for-review. The unique (repository_id, branch, path) key is the conflict target of the upsert the settings API performs.';
COMMENT ON COLUMN apiome.repository_conflict_policy_override.policy IS
    'The policy this one file uses instead of its repository''s: overwrite | hold-for-review | new-branch. CHECK-constrained so a typo cannot be stored as an uninterpretable policy.';
COMMENT ON COLUMN apiome.repository_conflict_policy_override.created_by IS
    'User who set the override, retained for audit. Nulled rather than cascaded when the user is deleted so the policy itself survives.';

-- The refresh executor's only read: "what policy applies to this file", resolved by the
-- unique key above. The tenant-scoped index below serves the settings panel's list read.
CREATE INDEX IF NOT EXISTS idx_repository_conflict_policy_override_tenant_repo
    ON apiome.repository_conflict_policy_override (tenant_id, repository_id);

COMMENT ON INDEX apiome.idx_repository_conflict_policy_override_tenant_repo IS
    'Tenant-scoped listing of a repository''s conflict-policy overrides (RAR-4.5), for the settings panel and the refresh-sweep join.';
