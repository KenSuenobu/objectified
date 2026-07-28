-- Evidence-backed verification policy — ECA-3.1 (#4734).
--
-- Problem: a verification result is not useful as a release control until policy can evaluate
-- freshness, consumer impact, and exact supporting evidence. ECA-1.3 stores immutable runs; this
-- migration adds the policy that turns those runs (plus CTG-3.1 whole-spec publish classification)
-- into an auditable pass/fail decision that cites evidence IDs.
--
-- Solution: two additive tables.
--
--   1. ``verification_policies`` — append-only, versioned, tenant-scoped. The highest
--      ``version_number`` is in force. A tenant with **no** row runs the documented default:
--      advisory, no required digests, breaking changes warn only — so upgrading changes no
--      behaviour for any existing tenant.
--
--   2. ``verification_policy_evaluations`` — append-only audit of decisions. Every evaluate call
--      persists one row naming the policy pin, per-gate results, cited evidence run IDs, and
--      warnings. Rows are write-once (immutable UPDATE trigger).
--
-- Breaking-change posture here is whole-spec via ``version_changelogs.max_severity`` (#4475).
-- Consumer-aware findings and acknowledgment (#4479 / #4480) are deliberately out of scope.
--
-- Rollback notes (reverse carefully in shared environments):
--   DROP TABLE IF EXISTS apiome.verification_policy_evaluations;
--   DROP TABLE IF EXISTS apiome.verification_policies;

SET search_path TO apiome, public;

-- ---------------------------------------------------------------------------------------------------
-- verification_policies — append-only versioned tenant policy (latest version is in force).
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS verification_policies (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    -- Monotonic per tenant; application assigns next = max(version_number) + 1.
    version_number INTEGER NOT NULL,

    -- SHA-256 hex of the canonicalized policy body, so a verdict can name the exact policy
    -- content it was produced under even after further edits.
    content_fingerprint TEXT NOT NULL,

    -- ECA-1.1 suite digests that must have a recent passing verification_run.
    -- Empty array = no digest gate (default).
    required_suite_digests TEXT[] NOT NULL DEFAULT '{}'::text[],

    -- Maximum age of cited evidence in seconds. NULL = no freshness gate.
    max_evidence_age_seconds INTEGER
        CONSTRAINT verification_policies_max_age_check
            CHECK (max_evidence_age_seconds IS NULL OR max_evidence_age_seconds >= 1),

    -- Optional ECA-1.2 network class filter on cited evidence. NULL = any class.
    required_target_network_class TEXT
        CONSTRAINT verification_policies_network_class_check
            CHECK (required_target_network_class IS NULL
                   OR required_target_network_class IN ('public', 'private')),

    -- Which evaluate purposes this policy covers.
    purpose TEXT NOT NULL DEFAULT 'both'
        CONSTRAINT verification_policies_purpose_check
            CHECK (purpose IN ('publish', 'deploy', 'both')),

    -- Whole-spec breaking posture against version_changelogs (#4475). Not consumer-aware.
    breaking_change_action TEXT NOT NULL DEFAULT 'warn'
        CONSTRAINT verification_policies_breaking_action_check
            CHECK (breaking_change_action IN ('ignore', 'warn', 'block')),

    -- Overall enforcement: advisory reports failures without blocking; block refuses publish/deploy.
    enforcement TEXT NOT NULL DEFAULT 'advisory'
        CONSTRAINT verification_policies_enforcement_check
            CHECK (enforcement IN ('advisory', 'block')),

    actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    actor_label TEXT,

    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT verification_policies_version_positive_check
        CHECK (version_number >= 1),
    CONSTRAINT verification_policies_tenant_version_uq
        UNIQUE (tenant_id, version_number)
);

COMMENT ON TABLE verification_policies IS
    'Append-only versioned tenant policy for evidence-backed publish/deploy gates; highest version_number is in force, no row = advisory default (ECA-3.1, #4734)';
COMMENT ON COLUMN verification_policies.id IS 'Unique identifier for the policy version';
COMMENT ON COLUMN verification_policies.tenant_id IS 'Tenant the policy governs';
COMMENT ON COLUMN verification_policies.version_number IS 'Monotonic version number per tenant (starts at 1); highest is in force';
COMMENT ON COLUMN verification_policies.content_fingerprint IS 'SHA-256 of the canonicalized policy body, named by every verdict for reproducibility';
COMMENT ON COLUMN verification_policies.required_suite_digests IS 'ECA-1.1 suite digests (sha256:<64 hex>) that must have recent passing evidence; empty = no digest gate';
COMMENT ON COLUMN verification_policies.max_evidence_age_seconds IS 'Maximum age of cited evidence in seconds; NULL = no freshness gate';
COMMENT ON COLUMN verification_policies.required_target_network_class IS 'Optional public/private filter on cited evidence; NULL = any';
COMMENT ON COLUMN verification_policies.purpose IS 'Which evaluate purposes this policy covers: publish, deploy, or both';
COMMENT ON COLUMN verification_policies.breaking_change_action IS 'Whole-spec breaking posture (ignore/warn/block) against version_changelogs; not consumer-aware (#4479 follow-up)';
COMMENT ON COLUMN verification_policies.enforcement IS 'advisory = report shortfalls only; block = refuse publish/deploy when evaluate fails';
COMMENT ON COLUMN verification_policies.actor_user_id IS 'User who published this policy version; NULL if later deleted';
COMMENT ON COLUMN verification_policies.actor_label IS 'Human-readable actor label at publish time';
COMMENT ON COLUMN verification_policies.created_at IS 'When the policy version was recorded (insert-only)';

CREATE INDEX IF NOT EXISTS idx_verification_policies_tenant
    ON verification_policies (tenant_id, version_number DESC);

DROP TRIGGER IF EXISTS trigger_verification_policies_immutable ON verification_policies;
CREATE TRIGGER trigger_verification_policies_immutable
    BEFORE UPDATE ON verification_policies
    FOR EACH ROW
    EXECUTE FUNCTION mcp_forbid_row_mutation();

-- ---------------------------------------------------------------------------------------------------
-- verification_policy_evaluations — append-only auditable decisions citing evidence IDs.
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS verification_policy_evaluations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
    version_record_id UUID REFERENCES versions(id) ON DELETE CASCADE,

    -- Pin the policy that produced this verdict. NULL when the tenant had no saved policy
    -- (documented default was used); content_fingerprint still records what was evaluated.
    policy_version_id UUID REFERENCES verification_policies(id) ON DELETE SET NULL,
    policy_content_fingerprint TEXT NOT NULL,

    purpose TEXT NOT NULL
        CONSTRAINT verification_policy_evaluations_purpose_check
            CHECK (purpose IN ('publish', 'deploy')),

    passed BOOLEAN NOT NULL,
    enforcement TEXT NOT NULL
        CONSTRAINT verification_policy_evaluations_enforcement_check
            CHECK (enforcement IN ('advisory', 'block')),

    -- Per-gate pass/detail array (or object list) for suite_digest, evidence_age, breaking_change.
    gate_results JSONB NOT NULL DEFAULT '[]'::jsonb
        CONSTRAINT verification_policy_evaluations_gate_results_array_check
            CHECK (jsonb_typeof(gate_results) = 'array'),

    -- Exact ECA-1.3 verification_run ids this decision relied on.
    evidence_run_ids UUID[] NOT NULL DEFAULT '{}'::uuid[],

    warnings JSONB NOT NULL DEFAULT '[]'::jsonb
        CONSTRAINT verification_policy_evaluations_warnings_array_check
            CHECK (jsonb_typeof(warnings) = 'array'),

    actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    actor_label TEXT,
    actor_kind TEXT,

    evaluated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE verification_policy_evaluations IS
    'Immutable, append-only evidence-backed policy decisions citing verification_run IDs (ECA-3.1, #4734)';
COMMENT ON COLUMN verification_policy_evaluations.id IS 'Unique identifier for the evaluation row';
COMMENT ON COLUMN verification_policy_evaluations.tenant_id IS 'Tenant the decision belongs to';
COMMENT ON COLUMN verification_policy_evaluations.project_id IS 'Optional project of the subject revision';
COMMENT ON COLUMN verification_policy_evaluations.version_record_id IS 'Optional catalog revision (versions.id) evaluated';
COMMENT ON COLUMN verification_policy_evaluations.policy_version_id IS 'Pinned verification_policies.id, or NULL when the documented default was used';
COMMENT ON COLUMN verification_policy_evaluations.policy_content_fingerprint IS 'Content fingerprint of the policy body evaluated';
COMMENT ON COLUMN verification_policy_evaluations.purpose IS 'Evaluate purpose: publish or deploy';
COMMENT ON COLUMN verification_policy_evaluations.passed IS 'True when every applicable gate passed (warnings do not fail)';
COMMENT ON COLUMN verification_policy_evaluations.enforcement IS 'Policy enforcement at evaluation time (advisory or block)';
COMMENT ON COLUMN verification_policy_evaluations.gate_results IS 'Per-gate {gate, passed, detail, ...} entries';
COMMENT ON COLUMN verification_policy_evaluations.evidence_run_ids IS 'Exact verification_run IDs cited by the decision';
COMMENT ON COLUMN verification_policy_evaluations.warnings IS 'Non-blocking notices (e.g. breaking warn)';
COMMENT ON COLUMN verification_policy_evaluations.actor_user_id IS 'User who triggered the evaluation, if any';
COMMENT ON COLUMN verification_policy_evaluations.actor_label IS 'Human-readable actor label';
COMMENT ON COLUMN verification_policy_evaluations.actor_kind IS 'Actor kind (user, api_key, system)';
COMMENT ON COLUMN verification_policy_evaluations.evaluated_at IS 'When the evaluation was computed';
COMMENT ON COLUMN verification_policy_evaluations.created_at IS 'When the row was recorded (insert-only)';

CREATE INDEX IF NOT EXISTS idx_verification_policy_evaluations_version
    ON verification_policy_evaluations (tenant_id, version_record_id, evaluated_at DESC)
    WHERE version_record_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_verification_policy_evaluations_tenant
    ON verification_policy_evaluations (tenant_id, evaluated_at DESC);

CREATE INDEX IF NOT EXISTS idx_verification_policy_evaluations_policy
    ON verification_policy_evaluations (policy_version_id)
    WHERE policy_version_id IS NOT NULL;

DROP TRIGGER IF EXISTS trigger_verification_policy_evaluations_immutable ON verification_policy_evaluations;
CREATE TRIGGER trigger_verification_policy_evaluations_immutable
    BEFORE UPDATE ON verification_policy_evaluations
    FOR EACH ROW
    EXECUTE FUNCTION mcp_forbid_row_mutation();
