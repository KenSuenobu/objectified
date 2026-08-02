-- =====================================================================================
-- V237 — Breaking-publish guardrail policy on style guides (CTG-3.4, #4478)
-- =====================================================================================
--
-- CTG-3.1 (#4475) classifies every publish against the previous published revision, but
-- nothing stops a publisher from shipping a breaking change as a minor/patch bump. CTG-3.4
-- adds the guardrail: when the head classifies **breaking** and the semver **major is not
-- bumped**, publish warns — and, per tenant policy, can be escalated to a hard block that
-- only an explicit force-publish (GOV-2.5 pattern, #4437) gets past.
--
-- The policy is a **style-guide setting**, so it resolves through the guide chain GOV-1.4
-- already walks (project assignment → tenant assignment → tenant default). That gives
-- per-project escalation for free and keeps every governance knob on one surface, next to
-- the CLX-1.3 (#4850) draft gate columns (axis_gates / required_coverage / ci_outcomes).
--
-- Levels:
--   off   — never surface the guardrail.
--   warn  — surface the warning in the publish dialog; publish proceeds (DEFAULT).
--   block — refuse publish (422) unless force-published with a reason (audited).
--
-- Additive and backwards compatible: existing guides adopt the 'warn' default, which is the
-- behavior CTG-3.4 specifies, and nothing reads the column until apiome-rest ships with it.
--
-- Rollback notes (additive only):
--   ALTER TABLE apiome.style_guides DROP COLUMN IF EXISTS breaking_publish_policy;
-- =====================================================================================

SET search_path TO apiome, public;

ALTER TABLE apiome.style_guides
    ADD COLUMN IF NOT EXISTS breaking_publish_policy TEXT NOT NULL DEFAULT 'warn';

-- Closed vocabulary; added separately so a re-run against an already-migrated database is a
-- no-op rather than a duplicate-constraint error.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'style_guides_breaking_publish_policy_ck'
          AND conrelid = 'apiome.style_guides'::regclass
    ) THEN
        ALTER TABLE apiome.style_guides
            ADD CONSTRAINT style_guides_breaking_publish_policy_ck
            CHECK (breaking_publish_policy IN ('off', 'warn', 'block'));
    END IF;
END
$$;

COMMENT ON COLUMN style_guides.breaking_publish_policy IS
    'Breaking-publish guardrail level applied at publish time when the head classifies breaking without a semver major bump: off | warn | block (CTG-3.4, #4478)';
