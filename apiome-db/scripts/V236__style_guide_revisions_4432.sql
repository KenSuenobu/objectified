-- Immutable style-guide revisions + lint-result pinning — GOV-1.6 (#4432).
--
-- Problem: guides are mutated in place (V159 style_guides / style_guide_rules). A lint result
-- recorded yesterday names the guide that produced it, but not *what that guide contained* at
-- the time — so once the guide is edited the score can no longer be explained or defended.
-- Compliance narratives ("this version was published under guide revision 4") need an
-- immutable edit history and a pin from every lint result to the exact ruleset that scored it.
--
-- This migration:
--   1. Creates apiome.style_guide_revisions — one append-only, write-once row per edit of a
--      guide (create, rename/re-describe, rule-catalog save, custom-rule save, policy-gate
--      change), carrying the full snapshot of the guide at that moment: name, description,
--      external lint profile, every rule row (enabled / severity / custom_def) and the draft
--      policy gates, plus who changed it and what kind of change it was.
--   2. Adds apiome.lint_evidence_runs.guide_revision_id — the pin from a lint result to the
--      revision it ran against (CLX-1.1's evidence rows are the immutable record of every
--      lint/scan run, so that is where the pin belongs).
--
-- Why a new table rather than reusing style_guide_policy_versions (V169): a policy pack is a
-- deliberately *published* CI artifact (rules + gates) that evaluation pins to, and its
-- fingerprint covers the gates. A revision is the automatic record of *every* guide edit, is
-- never published by hand, and its content_fingerprint covers the rule rows ALONE so it
-- matches, byte for byte, the fingerprint the style-guide engine computes when it compiles a
-- guide (apiome-rest ``style_guide_engine.rules_content_fingerprint``). That equality is what
-- lets a lint run pin itself to a revision without a second, divergent hashing scheme. The two
-- tables answer different questions and are intentionally not merged.
--
-- Revision rows are NOT backfilled here. Fingerprints must be identical to the ones Python
-- computes (canonical JSON, sorted keys, no separator whitespace); reproducing that
-- canonicalization in SQL for arbitrary custom_def documents would create exactly the drift
-- this table exists to prevent. Instead apiome-rest self-heals: the first read of a guide's
-- history, and every edit and every lint run under it, appends the current state as revision 1
-- when the guide has no revisions yet (the ``ensure_builtin_style_guide`` / ``ensure_builtin_roles``
-- pattern). Pre-existing guides therefore gain history on first touch, and no guide is ever
-- edited without its prior state being captured first.
--
-- Idempotent: CREATE / ALTER IF NOT EXISTS throughout; the write-once trigger reuses the
-- shared V128 mcp_forbid_row_mutation() guard (do not drop or redefine it here).
--
-- Rollback notes (additive only):
--   DROP TRIGGER IF EXISTS trigger_style_guide_revisions_immutable ON apiome.style_guide_revisions;
--   ALTER TABLE apiome.lint_evidence_runs DROP COLUMN IF EXISTS guide_revision_id;
--   DROP TABLE IF EXISTS apiome.style_guide_revisions;

SET search_path TO apiome, public;

-- ---------------------------------------------------------------------------------------------------
-- style_guide_revisions — append-only, write-once history of a guide's content.
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS style_guide_revisions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    guide_id UUID NOT NULL REFERENCES style_guides(id) ON DELETE CASCADE,
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    -- Monotonic per guide; the application assigns next = max(revision_number) + 1.
    revision_number INTEGER NOT NULL,

    -- What produced this revision. Closed vocabulary so the history reads as a change log.
    change_kind TEXT NOT NULL,

    -- Guide identity at snapshot time (a rename is itself a revision, so the history keeps
    -- the name each earlier revision was known by).
    name VARCHAR(255) NOT NULL,
    description TEXT,
    external_lint_profile TEXT,

    -- Every style_guide_rules row of the guide at snapshot time, sorted by rule_id:
    -- [{"rule_id": ..., "enabled": bool, "severity": ..., "custom_def": object|null}, ...].
    rules JSONB NOT NULL DEFAULT '[]'::jsonb,

    -- The guide's draft policy gates (V169 columns) at snapshot time:
    -- {"axisGates": {...}, "requiredCoverage": [...], "ciOutcomes": {...}}.
    policy JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- SHA-256 hex over the canonical JSON of `rules` ALONE — identical to the fingerprint the
    -- style-guide engine stamps on a compiled guide, which is how a lint run finds its revision.
    content_fingerprint TEXT NOT NULL,

    -- SHA-256 hex over the canonical JSON of the WHOLE snapshot (identity + rules + policy).
    -- Used to suppress no-op revisions: a save that changes nothing appends nothing.
    snapshot_fingerprint TEXT NOT NULL,

    actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    actor_label TEXT,

    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT style_guide_revisions_number_positive_check
        CHECK (revision_number >= 1),

    CONSTRAINT style_guide_revisions_change_kind_check
        CHECK (change_kind IN ('created', 'edited', 'rules_changed',
                               'custom_rules_changed', 'policy_changed', 'imported')),

    CONSTRAINT style_guide_revisions_rules_array_check
        CHECK (jsonb_typeof(rules) = 'array'),

    CONSTRAINT style_guide_revisions_policy_object_check
        CHECK (jsonb_typeof(policy) = 'object'),

    CONSTRAINT style_guide_revisions_guide_number_uq
        UNIQUE (guide_id, revision_number)
);

COMMENT ON TABLE style_guide_revisions IS
    'Immutable, append-only revisions of a style guide: one row per edit with the full guide snapshot, change kind and actor (GOV-1.6, #4432)';
COMMENT ON COLUMN style_guide_revisions.id IS 'Unique identifier for the revision; what lint results pin to';
COMMENT ON COLUMN style_guide_revisions.guide_id IS 'The live style guide this revision belongs to';
COMMENT ON COLUMN style_guide_revisions.tenant_id IS 'Tenant that owns the guide (denormalized for scoped lookups)';
COMMENT ON COLUMN style_guide_revisions.revision_number IS 'Monotonic revision number per guide (starts at 1)';
COMMENT ON COLUMN style_guide_revisions.change_kind IS 'What produced the revision: created | edited | rules_changed | custom_rules_changed | policy_changed | imported';
COMMENT ON COLUMN style_guide_revisions.name IS 'Guide name at snapshot time (renames are revisions, so history keeps the old names)';
COMMENT ON COLUMN style_guide_revisions.description IS 'Guide description at snapshot time';
COMMENT ON COLUMN style_guide_revisions.external_lint_profile IS 'CLX-2.2 external validation profile at snapshot time';
COMMENT ON COLUMN style_guide_revisions.rules IS 'Frozen style_guide_rules projection (rule_id, enabled, severity, custom_def), sorted by rule_id';
COMMENT ON COLUMN style_guide_revisions.policy IS 'Frozen draft policy gates {axisGates, requiredCoverage, ciOutcomes} at snapshot time';
COMMENT ON COLUMN style_guide_revisions.content_fingerprint IS 'SHA-256 of the canonical rule rows — equals the compiled-guide fingerprint, so lint runs can resolve their revision';
COMMENT ON COLUMN style_guide_revisions.snapshot_fingerprint IS 'SHA-256 of the whole snapshot; equal to the previous revision means the edit changed nothing and no revision is appended';
COMMENT ON COLUMN style_guide_revisions.actor_user_id IS 'User who made the edit; NULL for system/self-healing captures or after the user is deleted';
COMMENT ON COLUMN style_guide_revisions.actor_label IS 'Human-readable actor label at edit time';
COMMENT ON COLUMN style_guide_revisions.created_at IS 'When the revision was recorded (insert-only; rows are write-once)';

-- Newest-first history per guide (the revisions list view).
CREATE INDEX IF NOT EXISTS idx_style_guide_revisions_guide
    ON style_guide_revisions (guide_id, revision_number DESC);

-- Tenant-wide history (compliance exports, GOV-3.3 scorecards over time).
CREATE INDEX IF NOT EXISTS idx_style_guide_revisions_tenant
    ON style_guide_revisions (tenant_id, created_at DESC);

-- The lint-run pin lookup: "which revision of this guide has exactly this rule content?".
CREATE INDEX IF NOT EXISTS idx_style_guide_revisions_content_fingerprint
    ON style_guide_revisions (guide_id, content_fingerprint);

-- ---------------------------------------------------------------------------------------------------
-- Immutability: revisions are write-once. Reuses the generic V128 UPDATE-forbid guard.
-- ---------------------------------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trigger_style_guide_revisions_immutable ON style_guide_revisions;
CREATE TRIGGER trigger_style_guide_revisions_immutable
    BEFORE UPDATE ON style_guide_revisions
    FOR EACH ROW
    EXECUTE FUNCTION mcp_forbid_row_mutation();

-- ---------------------------------------------------------------------------------------------------
-- Lint results pin the revision they ran against.
--
-- Deliberately NOT a foreign key: lint_evidence_runs rows are write-once (the V167 immutability
-- trigger rejects every UPDATE), so an ON DELETE SET NULL action would raise instead of
-- nulling and would make deleting a style guide fail outright. The column is a soft reference
-- that keeps its value for the life of the evidence row — which is also what an audit trail
-- wants: the record of "revision 4 scored this" must survive the guide being deleted.
-- ---------------------------------------------------------------------------------------------------
ALTER TABLE lint_evidence_runs
    ADD COLUMN IF NOT EXISTS guide_revision_id UUID;

COMMENT ON COLUMN lint_evidence_runs.guide_revision_id IS
    'Style-guide revision (style_guide_revisions.id) this run was scored under — soft reference, retained even if the guide is deleted; NULL for runs from scanners no guide governs or from before GOV-1.6 (#4432)';

-- "Every lint result produced under revision X" — the compliance narrative query.
CREATE INDEX IF NOT EXISTS idx_lint_evidence_runs_guide_revision
    ON lint_evidence_runs (guide_revision_id)
    WHERE guide_revision_id IS NOT NULL;
