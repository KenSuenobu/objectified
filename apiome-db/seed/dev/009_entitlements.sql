-- Dev seed: commercial entitlements for the seed users and the sample tenant
-- (private-suite#2619, DH-3.2).
--
-- Feature entitlement resolves through the *user's* plan, not the tenant's. Both gates —
-- `Database.tenant_has_feature_flag` (apiome-rest) and `userHasFeatureFlag`
-- (apiome-ui/lib/db/feature-entitlements.ts) — join `apiome.license_feature_flags` on
-- `apiome.user_entitlements.license_id`, with per-user and per-tenant overrides layered on
-- top. Seeds 001–008 write `users`, `tenants`, `tenant_licenses` and credential accounts,
-- but never a `user_entitlements` row and no override rows, so every seeded user resolved to
-- **zero** commercial product flags: every Authoring route rendered "Authoring is not
-- enabled", and the 41 UXE-1.4 conformance specs in private-suite's nightly `studio-e2e`
-- job skipped — silently, and as a pass — for as long as that job has been the RC gate
-- (found by the DH-3.1 pre-GA battery, docs/releases/RC1_EVIDENCE.md §4.1).
--
-- `Paid` is the lowest catalog tier that bundles the Authoring products: it carries
-- `authoring` (V192) plus `scribe` / `slate` / `hosted` (V191), on top of V097's
-- `designer` / `paths` / `ai_assistant` / `repositories` and V116's `primitives-registry`.
-- Free bundles `designer` alone, which is why the auto-issued Free plan every tenant gets
-- from the V183 trigger was never enough to reach an Authoring surface.
--
-- Two grants, deliberately:
--
--   1. `user_entitlements` for Ada and Grace — what the gates actually read today.
--   2. `tenant_licenses` for `acme-corp` — what `docs/LICENSING_MODEL.md` §1 says *ought* to
--      decide "what may this organization do". It changes no behaviour today (the sample
--      tenant simply reports Paid in the License & Plan panel instead of the auto-issued
--      Free, which is also the coherent thing for a stack whose user can reach Authoring).
--      It is here so that moving feature composition to tenant scope — a #3484 decision —
--      cannot silently un-entitle the dev stack and re-hide the conformance gate.
--
-- Grace's three fixture tenants keep the diverging Free / Paid / Sponsor tiers 007 gives
-- them: that fixture exists to exercise per-tenant tier divergence, and a user-scoped
-- entitlement does not disturb it.
--
-- Idempotent: `ON CONFLICT (user_id) DO NOTHING` on the user grant, so a developer who
-- re-points a seed user at another plan through the super-admin license manager keeps that
-- choice across re-seeds (the same posture as 001/002/003). The tenant grant upserts,
-- because the V183 `AFTER INSERT` trigger has already auto-issued Free by the time this
-- file runs — exactly the case 007 handles the same way for Borealis and Cascade.

SET search_path TO apiome, public;

-- ─── 1. The sample tenant holds a commercial plan ────────────────────────────

INSERT INTO apiome.tenant_licenses (tenant_id, license_id, notes)
SELECT '00000000-0000-4000-8000-000000000002', l.id,
       'Dev seed (private-suite#2619): commercial tier, so the sample tenant looks like a sold one.'
FROM apiome.licenses l
WHERE l.name = 'Paid' AND l.license_type = 'paid'
LIMIT 1
ON CONFLICT (tenant_id) DO UPDATE
  SET license_id = EXCLUDED.license_id,
      notes      = EXCLUDED.notes,
      updated_at = CURRENT_TIMESTAMP;

-- ─── 2. The seed users hold that plan ────────────────────────────────────────
-- `plan_code` mirrors `licenses.license_type`, matching what the signup path writes
-- (`insertFreeTierEntitlements`, apiome-ui/lib/db/oauth-signup.ts).
--
-- The raw limit columns are derived from the catalog's `seats` JSON rather than restated as
-- literals. They are a mirror of it, and the two are read by *different* consumers — the
-- tenant cap (`provision_first_tenant`, `getMaxTenantsForUser`) reads `max_tenants` off the
-- column, while the project/version quotas prefer the joined catalog (LICENSING_MODEL.md §3,
-- asymmetry 2). Deriving them here is what keeps the seed from being the place those two
-- views of the same plan first disagree.

INSERT INTO apiome.user_entitlements (user_id, plan_code, max_tenants, max_projects, max_versions, license_id)
SELECT
  u.id,
  l.license_type,
  COALESCE((l.seats ->> 'max_tenants')::int,  1),
  COALESCE((l.seats ->> 'max_projects')::int, 1),
  COALESCE((l.seats ->> 'max_versions')::int, 3),
  l.id
FROM apiome.users u
CROSS JOIN LATERAL (
  SELECT id, license_type, seats
  FROM apiome.licenses
  WHERE name = 'Paid' AND license_type = 'paid'
  LIMIT 1
) l
WHERE u.id IN ('00000000-0000-4000-8000-000000000001',   -- Ada   (001_user.sql)
               '00000000-0000-4000-8000-000000000010')   -- Grace (007_multitenant.sql)
  AND u.deleted_at IS NULL
ON CONFLICT (user_id) DO NOTHING;
