-- Tenant import/export quality policy and waivers — IXH-2.3 (#5098).
--
-- Problem: quality thresholds exist for publishing (``lint_finding_decisions`` /
-- ``style_guide_policy_versions``, CLX-1.3) and for style guides (GOV), but nothing governs
-- *intake* or *delivery*. A tenant cannot say "do not let a D-grade spec into the catalog" or
-- "do not export an artifact whose source has open error-severity findings".
--
-- Solution: two additive tables.
--
--   1. ``import_export_quality_policies`` — one append-only, versioned policy record per tenant.
--      The highest ``version_number`` is the policy in force; older rows stay for reproducibility
--      and audit, exactly like ``style_guide_policy_versions`` (V169). A tenant with **no** row
--      runs the documented default: advisory only, nothing blocked, override permitted — so
--      upgrading changes no behaviour for any existing tenant.
--
--   2. ``import_export_quality_waivers`` — accepted risk with a deadline, recorded when a user
--      commits an import (or a delivery) that policy would have blocked. Carries the actor, the
--      reason, the scope, and the expiry, plus ``expiry_notified_at`` so the **existing**
--      CLX-4.2 waiver-expiry sweep can claim these rows the same way it claims
--      ``lint_finding_decisions`` (V176) — one sweep, two sources, not a second mechanism.
--
-- Both tables are tenant-scoped and cascade with the tenant. Nothing here alters an existing
-- table or column, so the migration is additive and reversible.
--
-- Rollback notes (reverse carefully in shared environments):
--   DROP TABLE IF EXISTS apiome.import_export_quality_waivers;
--   DROP TABLE IF EXISTS apiome.import_export_quality_policies;

SET search_path TO apiome, public;

-- ---------------------------------------------------------------------------------------------------
-- import_export_quality_policies — append-only versioned tenant policy (latest version is in force).
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS import_export_quality_policies (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    -- Monotonic per tenant; application assigns next = max(version_number) + 1.
    version_number INTEGER NOT NULL,

    -- SHA-256 hex of the canonicalized policy body, so a verdict can name the exact policy
    -- content it was produced under even after further edits.
    content_fingerprint TEXT NOT NULL,

    -- Import thresholds. NULL = "no floor of this kind"; all NULL = advisory by construction.
    import_min_grade TEXT
        CONSTRAINT import_export_quality_policies_import_grade_check
            CHECK (import_min_grade IS NULL OR import_min_grade IN ('A', 'B', 'C', 'D', 'F')),
    import_min_score INTEGER
        CONSTRAINT import_export_quality_policies_import_score_check
            CHECK (import_min_score IS NULL OR (import_min_score >= 0 AND import_min_score <= 100)),
    import_block_on_severity TEXT
        CONSTRAINT import_export_quality_policies_import_severity_check
            CHECK (import_block_on_severity IS NULL
                   OR import_block_on_severity IN ('error', 'warning', 'info')),
    -- 'advisory' reports the shortfall without blocking; 'block' refuses the commit.
    import_enforcement TEXT NOT NULL DEFAULT 'advisory'
        CONSTRAINT import_export_quality_policies_import_enforcement_check
            CHECK (import_enforcement IN ('advisory', 'block')),

    -- Export thresholds — same vocabulary, applied to delivery instead of intake.
    export_min_grade TEXT
        CONSTRAINT import_export_quality_policies_export_grade_check
            CHECK (export_min_grade IS NULL OR export_min_grade IN ('A', 'B', 'C', 'D', 'F')),
    export_min_score INTEGER
        CONSTRAINT import_export_quality_policies_export_score_check
            CHECK (export_min_score IS NULL OR (export_min_score >= 0 AND export_min_score <= 100)),
    export_block_on_severity TEXT
        CONSTRAINT import_export_quality_policies_export_severity_check
            CHECK (export_block_on_severity IS NULL
                   OR export_block_on_severity IN ('error', 'warning', 'info')),
    export_enforcement TEXT NOT NULL DEFAULT 'advisory'
        CONSTRAINT import_export_quality_policies_export_enforcement_check
            CHECK (export_enforcement IN ('advisory', 'block')),

    -- Per-format overrides keyed by adapter key (openapi, grpc, …):
    --   {"openapi": {"import": {"minGrade": "B", "enforcement": "block"}}}
    -- Resolution is format override -> tenant -> default, and the winner is named in the verdict.
    format_overrides JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- Whether a blocked user may commit anyway by recording a waiver, and which role slugs may.
    allow_override BOOLEAN NOT NULL DEFAULT TRUE,
    override_roles JSONB NOT NULL DEFAULT '["owner", "admin"]'::jsonb,

    -- How long a recorded waiver stays honoured before the sweep retires it.
    waiver_ttl_hours INTEGER NOT NULL DEFAULT 168
        CONSTRAINT import_export_quality_policies_ttl_check
            CHECK (waiver_ttl_hours >= 1 AND waiver_ttl_hours <= 8760),

    actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    actor_label TEXT,

    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT import_export_quality_policies_version_positive_check
        CHECK (version_number >= 1),
    CONSTRAINT import_export_quality_policies_overrides_object_check
        CHECK (jsonb_typeof(format_overrides) = 'object'),
    CONSTRAINT import_export_quality_policies_roles_array_check
        CHECK (jsonb_typeof(override_roles) = 'array'),
    CONSTRAINT import_export_quality_policies_tenant_version_uq
        UNIQUE (tenant_id, version_number)
);

COMMENT ON TABLE import_export_quality_policies IS
    'Append-only versioned tenant policy governing import intake and export delivery quality; highest version_number is in force, no row = advisory default (IXH-2.3, #5098)';
COMMENT ON COLUMN import_export_quality_policies.id IS 'Unique identifier for the policy version';
COMMENT ON COLUMN import_export_quality_policies.tenant_id IS 'Tenant the policy governs';
COMMENT ON COLUMN import_export_quality_policies.version_number IS 'Monotonic version number per tenant (starts at 1); highest is in force';
COMMENT ON COLUMN import_export_quality_policies.content_fingerprint IS 'SHA-256 of the canonicalized policy body, named by every verdict for reproducibility';
COMMENT ON COLUMN import_export_quality_policies.import_min_grade IS 'Lowest acceptable lint grade for an import; NULL = no grade floor';
COMMENT ON COLUMN import_export_quality_policies.import_min_score IS 'Lowest acceptable lint score (0-100) for an import; NULL = no score floor';
COMMENT ON COLUMN import_export_quality_policies.import_block_on_severity IS 'Severity at or above which an import is refused (error/warning/info); NULL = severity is not gated';
COMMENT ON COLUMN import_export_quality_policies.import_enforcement IS 'advisory = report the shortfall only; block = refuse the commit';
COMMENT ON COLUMN import_export_quality_policies.export_min_grade IS 'Lowest acceptable source lint grade for a delivery; NULL = no grade floor';
COMMENT ON COLUMN import_export_quality_policies.export_min_score IS 'Lowest acceptable source lint score (0-100) for a delivery; NULL = no score floor';
COMMENT ON COLUMN import_export_quality_policies.export_block_on_severity IS 'Severity at or above which a delivery is refused; NULL = severity is not gated';
COMMENT ON COLUMN import_export_quality_policies.export_enforcement IS 'advisory = annotate the delivery only; block = refuse it';
COMMENT ON COLUMN import_export_quality_policies.format_overrides IS 'Per-adapter-key threshold overrides, e.g. {"openapi": {"import": {"minGrade": "B"}}}; resolution is format override -> tenant -> default';
COMMENT ON COLUMN import_export_quality_policies.allow_override IS 'Whether a blocked actor may proceed by recording a waiver';
COMMENT ON COLUMN import_export_quality_policies.override_roles IS 'Role slugs permitted to record a waiver (effective role: owner for tenant administrators, else the assigned role, else editor)';
COMMENT ON COLUMN import_export_quality_policies.waiver_ttl_hours IS 'Lifetime of a recorded waiver in hours (1..8760); the CLX-4.2 sweep notifies as it nears expiry';
COMMENT ON COLUMN import_export_quality_policies.actor_user_id IS 'User who published this policy version; NULL if later deleted';
COMMENT ON COLUMN import_export_quality_policies.actor_label IS 'Human-readable actor label at publish time';
COMMENT ON COLUMN import_export_quality_policies.created_at IS 'When the policy version was recorded (insert-only)';

CREATE INDEX IF NOT EXISTS idx_import_export_quality_policies_tenant
    ON import_export_quality_policies (tenant_id, version_number DESC);

DROP TRIGGER IF EXISTS trigger_import_export_quality_policies_immutable ON import_export_quality_policies;
CREATE TRIGGER trigger_import_export_quality_policies_immutable
    BEFORE UPDATE ON import_export_quality_policies
    FOR EACH ROW
    EXECUTE FUNCTION mcp_forbid_row_mutation();

-- ---------------------------------------------------------------------------------------------------
-- import_export_quality_waivers — accepted risk with a deadline, swept by the CLX-4.2 expiry sweep.
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS import_export_quality_waivers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    -- Which gate the waiver applies to.
    scope TEXT NOT NULL
        CONSTRAINT import_export_quality_waivers_scope_check
            CHECK (scope IN ('import', 'export')),

    -- What it applies to: the SHA-256 of the candidate document for an import, or the subject
    -- identity (revision + target) for an export. One opaque key so both gates match the same way.
    subject_key TEXT NOT NULL,
    -- Human-readable label for the waived subject (filename, artifact name) — display only.
    subject_label TEXT,

    -- The adapter key / export target the waiver was granted for, so a waiver cannot silently
    -- cover a different format's gate for the same bytes.
    format_key TEXT,

    -- The verdict that was waived, recorded verbatim for reconciliation.
    report_fingerprint TEXT,
    score INTEGER
        CONSTRAINT import_export_quality_waivers_score_check
            CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
    grade TEXT,
    policy_version_id UUID REFERENCES import_export_quality_policies(id) ON DELETE SET NULL,
    policy_content_fingerprint TEXT,

    -- Accepted risk needs a stated reason and a deadline (the CLX-1.3 waiver contract).
    reason TEXT NOT NULL
        CONSTRAINT import_export_quality_waivers_reason_check
            CHECK (length(btrim(reason)) > 0),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,

    -- Claimed by the shared waiver-expiry sweep (V176 semantics) so the webhook fires once.
    expiry_notified_at TIMESTAMP WITH TIME ZONE,

    actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    actor_label TEXT,
    actor_role TEXT,

    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE import_export_quality_waivers IS
    'Waivers recorded when a user proceeds against a blocking import/export quality verdict; honoured until expires_at, then retired by the shared waiver-expiry sweep (IXH-2.3, #5098)';
COMMENT ON COLUMN import_export_quality_waivers.id IS 'Unique identifier for the waiver';
COMMENT ON COLUMN import_export_quality_waivers.tenant_id IS 'Tenant the waiver belongs to';
COMMENT ON COLUMN import_export_quality_waivers.scope IS 'Gate the waiver applies to: import (intake) or export (delivery)';
COMMENT ON COLUMN import_export_quality_waivers.subject_key IS 'Match key: SHA-256 of the candidate document (import) or the subject identity (export)';
COMMENT ON COLUMN import_export_quality_waivers.subject_label IS 'Display label for the waived subject (filename / artifact name)';
COMMENT ON COLUMN import_export_quality_waivers.format_key IS 'Adapter key (import) or export target the waiver was granted for';
COMMENT ON COLUMN import_export_quality_waivers.report_fingerprint IS 'Fingerprint of the lint report that was waived';
COMMENT ON COLUMN import_export_quality_waivers.score IS 'Lint score at waiver time (0-100)';
COMMENT ON COLUMN import_export_quality_waivers.grade IS 'Lint grade at waiver time';
COMMENT ON COLUMN import_export_quality_waivers.policy_version_id IS 'Policy version in force when the waiver was granted';
COMMENT ON COLUMN import_export_quality_waivers.policy_content_fingerprint IS 'Content fingerprint of that policy version';
COMMENT ON COLUMN import_export_quality_waivers.reason IS 'The actor stated justification for accepting the risk (required)';
COMMENT ON COLUMN import_export_quality_waivers.expires_at IS 'When the waiver stops being honoured (granted_at + policy waiver_ttl_hours)';
COMMENT ON COLUMN import_export_quality_waivers.expiry_notified_at IS 'When the lint.waiver.expiring webhook was enqueued for this waiver; NULL = not yet notified';
COMMENT ON COLUMN import_export_quality_waivers.actor_user_id IS 'User who recorded the waiver; NULL if later deleted';
COMMENT ON COLUMN import_export_quality_waivers.actor_label IS 'Human-readable actor label at grant time';
COMMENT ON COLUMN import_export_quality_waivers.actor_role IS 'Effective role slug the actor held when the waiver was granted';
COMMENT ON COLUMN import_export_quality_waivers.created_at IS 'When the waiver was recorded';

-- Gate lookup: newest active waiver for a tenant + scope + subject.
CREATE INDEX IF NOT EXISTS idx_import_export_quality_waivers_lookup
    ON import_export_quality_waivers (tenant_id, scope, subject_key, expires_at DESC);

-- Sweep scan: only unnotified waivers are indexed (V176 pattern).
CREATE INDEX IF NOT EXISTS idx_import_export_quality_waivers_expiry_due
    ON import_export_quality_waivers (expires_at)
    WHERE expiry_notified_at IS NULL;
