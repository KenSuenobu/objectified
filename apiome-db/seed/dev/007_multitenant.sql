-- Dev seed: one user in three tenants with distinct roles and license tiers (OLO-6.4, #4221).
--
-- This is the canonical multi-tenant fixture. It exercises the parts of the product that only
-- appear when a single user belongs to several tenants with *diverging* access:
--
--   * the tenant switcher (GET /v1/tenants/me) listing every membership with its role,
--     lifecycle status, and license tier in one round-trip (OLO-6.2);
--   * per-tenant permission divergence in the RBAC guard (owner vs. editor vs. viewer);
--   * the license-tier chips (Free / Paid / Sponsor) rendered per membership.
--
-- Login:    grace@example.com
-- Password: apiome-dev   (same DEV-ONLY bcrypt hash as the sample user; never load in production)
--
-- Memberships (all for Grace):
--   Aurora Labs        (aurora-labs)        -> Owner  · Free      license
--   Borealis Studio    (borealis-studio)    -> Editor · Paid      license
--   Cascade Foundation (cascade-foundation) -> Viewer · Sponsor   license
--
-- Roles are the built-in per-tenant roles created by apiome.seed_builtin_roles (V118). Licenses
-- reference the V097 catalog rows by name (Free/Paid/Sponsor). Idempotent throughout: fixed ids
-- plus ON CONFLICT DO NOTHING, so re-running leaves existing rows untouched.

SET search_path TO apiome, public;

-- ─── User ────────────────────────────────────────────────────────────────────

INSERT INTO apiome.users (id, name, email, password, verified, enabled)
VALUES (
  '00000000-0000-4000-8000-000000000010',
  'Grace Hopper',
  'grace@example.com',
  '$2b$10$CZ6T5dNM4gGB07ni8rcW5ObIIuOaC3DsBwzM6keX8Sei/8.QpGpdS',
  true,
  true
)
ON CONFLICT (id) DO NOTHING;

-- ─── Tenants ─────────────────────────────────────────────────────────────────

INSERT INTO apiome.tenants (id, name, slug, description, enabled)
VALUES
  ('00000000-0000-4000-8000-000000000011', 'Aurora Labs',        'aurora-labs',
   'Multi-tenant fixture: Grace is the owner here.',  true),
  ('00000000-0000-4000-8000-000000000012', 'Borealis Studio',    'borealis-studio',
   'Multi-tenant fixture: Grace is an editor here.',  true),
  ('00000000-0000-4000-8000-000000000013', 'Cascade Foundation', 'cascade-foundation',
   'Multi-tenant fixture: Grace is a viewer here.',   true)
ON CONFLICT (id) DO NOTHING;

-- Ensure the four built-in roles (owner/admin/editor/viewer) and their permission grids exist for
-- each fixture tenant, so the role assignments below resolve. Idempotent (self-healing).
SELECT apiome.seed_builtin_roles('00000000-0000-4000-8000-000000000011');
SELECT apiome.seed_builtin_roles('00000000-0000-4000-8000-000000000012');
SELECT apiome.seed_builtin_roles('00000000-0000-4000-8000-000000000013');

-- ─── Memberships ─────────────────────────────────────────────────────────────
-- Every tenant gets an active tenant_users row (the membership the switcher lists).

INSERT INTO apiome.tenant_users (tenant_id, user_id)
VALUES
  ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000010'),
  ('00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000010'),
  ('00000000-0000-4000-8000-000000000013', '00000000-0000-4000-8000-000000000010')
ON CONFLICT (tenant_id, user_id) DO NOTHING;

-- Aurora Labs: Grace is the owner. A tenant_administrators row is the authoritative
-- "full access" / Owner-equivalent signal (V118), read as role 'owner' by the switcher query
-- and the permission guard.
INSERT INTO apiome.tenant_administrators (tenant_id, user_id)
VALUES ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000010')
ON CONFLICT (tenant_id, user_id) DO NOTHING;

-- Granular role assignments (V119): resolve each role by (tenant, slug) and bind Grace to it.
--   Aurora   -> owner   Borealis -> editor   Cascade -> viewer
INSERT INTO apiome.tenant_user_roles (tenant_id, user_id, role_id)
SELECT r.tenant_id, '00000000-0000-4000-8000-000000000010', r.id
FROM apiome.roles r
WHERE (r.tenant_id, r.slug) IN (
  ('00000000-0000-4000-8000-000000000011'::uuid, 'owner'),
  ('00000000-0000-4000-8000-000000000012'::uuid, 'editor'),
  ('00000000-0000-4000-8000-000000000013'::uuid, 'viewer')
)
ON CONFLICT (tenant_id, user_id) DO NOTHING;

-- ─── License attachments ─────────────────────────────────────────────────────
-- Attach one catalog plan (V097: Free/Paid/Sponsor) per tenant via tenant_licenses (V182).
-- One row per tenant (UNIQUE tenant_id); reference the catalog by name.
--
-- NOTE: the V183 trigger auto-issues the *Free* plan when a tenant is inserted, so every fixture
-- tenant already holds a tenant_licenses row by the time we get here. To make the tiers actually
-- diverge we UPSERT the intended plan (ON CONFLICT ... DO UPDATE), overwriting that auto-issued
-- Free row for Borealis (Paid) and Cascade (Sponsor). The upsert is idempotent: re-running lands
-- the same plan, and Aurora simply re-lands on Free.

INSERT INTO apiome.tenant_licenses (tenant_id, license_id, notes)
SELECT '00000000-0000-4000-8000-000000000011', l.id, 'Multi-tenant fixture (OLO-6.4): Free tier.'
FROM apiome.licenses l WHERE l.name = 'Free'    AND l.license_type = 'free'    LIMIT 1
ON CONFLICT (tenant_id) DO UPDATE
  SET license_id = EXCLUDED.license_id, notes = EXCLUDED.notes, updated_at = CURRENT_TIMESTAMP;

INSERT INTO apiome.tenant_licenses (tenant_id, license_id, notes)
SELECT '00000000-0000-4000-8000-000000000012', l.id, 'Multi-tenant fixture (OLO-6.4): Paid tier.'
FROM apiome.licenses l WHERE l.name = 'Paid'    AND l.license_type = 'paid'    LIMIT 1
ON CONFLICT (tenant_id) DO UPDATE
  SET license_id = EXCLUDED.license_id, notes = EXCLUDED.notes, updated_at = CURRENT_TIMESTAMP;

INSERT INTO apiome.tenant_licenses (tenant_id, license_id, notes)
SELECT '00000000-0000-4000-8000-000000000013', l.id, 'Multi-tenant fixture (OLO-6.4): Sponsor tier.'
FROM apiome.licenses l WHERE l.name = 'Sponsor' AND l.license_type = 'sponsor' LIMIT 1
ON CONFLICT (tenant_id) DO UPDATE
  SET license_id = EXCLUDED.license_id, notes = EXCLUDED.notes, updated_at = CURRENT_TIMESTAMP;
