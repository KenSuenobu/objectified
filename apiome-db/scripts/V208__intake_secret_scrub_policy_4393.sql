-- Tenant secret-scrub policy for import intake — MFI-29.6 (#4393).
--
-- Problem: intake scrubs credentials out of the source it persists (IXH-1.4), but the behaviour
-- is fixed. A tenant onboarding a large corpus wants to *see* what would be redacted before the
-- scrubber starts rewriting documents, and a tenant importing HAR/Insomnia/Bruno/Postman
-- captures (MFI-EPIC-32) must never be able to turn redaction off. Neither is expressible today.
--
-- Solution: one additive table, ``intake_secret_scrub_policies`` — an append-only, versioned
-- policy record per tenant, exactly like ``import_export_quality_policies`` (V205) and
-- ``style_guide_policy_versions`` (V169). The highest ``version_number`` is the policy in force;
-- older rows stay readable for the job summaries that named them.
--
--   * ``mode``               — ``enforce`` rewrites the persisted source; ``warn_only`` reports
--                              the same findings and leaves the content untouched.
--   * ``entropy_detection``  — whether the high-entropy heuristic runs alongside the named
--                              credential patterns. The patterns always run.
--   * ``format_overrides``   — per-adapter-key mode, e.g. {"openapi": {"mode": "warn_only"}}.
--
-- A tenant with **no** row runs the documented default: ``enforce``, entropy detection on. That
-- is the behaviour every tenant already has today (IXH-1.4 scrubs unconditionally), so the
-- migration changes nothing for an existing tenant — it only makes warn-only reachable.
--
-- Rollback notes (reverse carefully in shared environments):
--   DROP TABLE IF EXISTS apiome.intake_secret_scrub_policies;

SET search_path TO apiome, public;

-- ---------------------------------------------------------------------------------------------------
-- intake_secret_scrub_policies — append-only versioned tenant policy (latest version is in force).
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS intake_secret_scrub_policies (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

    -- Monotonic per tenant; application assigns next = max(version_number) + 1.
    version_number INTEGER NOT NULL,

    -- SHA-256 hex of the canonicalized policy body, so a scrub report can name the exact policy
    -- content it was produced under even after further edits.
    content_fingerprint TEXT NOT NULL,

    -- 'enforce' redacts the persisted source in place; 'warn_only' reports findings and persists
    -- the content unmodified. 'enforce' is the shipped default.
    mode TEXT NOT NULL DEFAULT 'enforce'
        CONSTRAINT intake_secret_scrub_policies_mode_check
            CHECK (mode IN ('enforce', 'warn_only')),

    -- Whether the Shannon-entropy heuristic runs in addition to the named credential patterns.
    -- The named patterns are not optional; only the heuristic (which is the false-positive-prone
    -- half) can be turned off.
    entropy_detection BOOLEAN NOT NULL DEFAULT TRUE,

    -- Per-format overrides keyed by adapter key (openapi, postman, har, …):
    --   {"openapi": {"mode": "warn_only"}}
    -- Resolution is format override -> format default -> tenant -> default, and the winning tier
    -- is named on every scrub report. The format-default tier is what pins the MFI-EPIC-32
    -- collection/capture formats to 'enforce' without a tenant having to state it.
    format_overrides JSONB NOT NULL DEFAULT '{}'::jsonb,

    actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    actor_label TEXT,

    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT intake_secret_scrub_policies_version_positive_check
        CHECK (version_number >= 1),
    CONSTRAINT intake_secret_scrub_policies_overrides_object_check
        CHECK (jsonb_typeof(format_overrides) = 'object'),
    CONSTRAINT intake_secret_scrub_policies_tenant_version_uq
        UNIQUE (tenant_id, version_number)
);

COMMENT ON TABLE intake_secret_scrub_policies IS
    'Append-only versioned tenant policy governing intake secret scrubbing; highest version_number is in force, no row = enforce with entropy detection on (MFI-29.6, #4393)';
COMMENT ON COLUMN intake_secret_scrub_policies.id IS 'Unique identifier for the policy version';
COMMENT ON COLUMN intake_secret_scrub_policies.tenant_id IS 'Tenant the policy governs';
COMMENT ON COLUMN intake_secret_scrub_policies.version_number IS 'Monotonic version number per tenant (starts at 1); highest is in force';
COMMENT ON COLUMN intake_secret_scrub_policies.content_fingerprint IS 'SHA-256 of the canonicalized policy body, named by every scrub report for reproducibility';
COMMENT ON COLUMN intake_secret_scrub_policies.mode IS 'enforce = redact the persisted source in place; warn_only = report findings and persist content unmodified';
COMMENT ON COLUMN intake_secret_scrub_policies.entropy_detection IS 'Whether the high-entropy heuristic runs alongside the named credential patterns (patterns always run)';
COMMENT ON COLUMN intake_secret_scrub_policies.format_overrides IS 'Per-adapter-key mode overrides, e.g. {"openapi": {"mode": "warn_only"}}; resolution is format override -> format default -> tenant -> default';
COMMENT ON COLUMN intake_secret_scrub_policies.actor_user_id IS 'User who published this policy version; NULL if later deleted';
COMMENT ON COLUMN intake_secret_scrub_policies.actor_label IS 'Human-readable actor label at publish time';
COMMENT ON COLUMN intake_secret_scrub_policies.created_at IS 'When the policy version was recorded (insert-only)';

CREATE INDEX IF NOT EXISTS idx_intake_secret_scrub_policies_tenant
    ON intake_secret_scrub_policies (tenant_id, version_number DESC);

DROP TRIGGER IF EXISTS trigger_intake_secret_scrub_policies_immutable ON intake_secret_scrub_policies;
CREATE TRIGGER trigger_intake_secret_scrub_policies_immutable
    BEFORE UPDATE ON intake_secret_scrub_policies
    FOR EACH ROW
    EXECUTE FUNCTION mcp_forbid_row_mutation();
