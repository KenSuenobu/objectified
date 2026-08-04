-- Dev seed: Better Auth credential accounts for the seed users (private-suite#2560, DH-1.2).
--
-- Better Auth's email/password sign-in reads the bcrypt hash off the `apiome.account` row with
-- `providerId = 'credential'` — not off `users.password` (V199 created the table, V200 relocated
-- the data; design of record docs/BETTER_AUTH_MIGRATION.md §2.3). Compose order is
-- migrate → seed, so V200's backfill runs before the seed files insert their users: on a fresh
-- database the seed users had no credential row and every sign-in answered
-- INVALID_EMAIL_OR_PASSWORD. This file closes that gap by creating the credential rows in the
-- seed path itself, mirroring V200's row shape.
--
-- Heal-then-create, both idempotent:
--
--   1. Stacks seeded before #2560 carry a known-broken `users.password` hash that never
--      verified against the documented "apiome-dev" password. Replace exactly that hash with
--      the verified one (test/seed.test.ts proves it against bcrypt). A password a developer
--      has since changed does not match the broken hash and is left alone.
--   2. Insert one `providerId='credential'` account row per seed user, copying
--      `users.password` verbatim (same byte-for-byte relocation rule as V200). On re-runs the
--      row converges to `users.password` only when it actually differs, so a repeated seed is
--      a true no-op.
--
-- Scoped to the fixed seed user ids only — real users' rows are V200's business, never the
-- seed's.

SET search_path TO apiome, public;

-- ─── 1. Heal the pre-#2560 broken seed hash ──────────────────────────────────

UPDATE apiome.users
   SET password   = '$2b$10$CZ6T5dNM4gGB07ni8rcW5ObIIuOaC3DsBwzM6keX8Sei/8.QpGpdS',
       updated_at = CURRENT_TIMESTAMP
 WHERE id IN ('00000000-0000-4000-8000-000000000001',   -- Ada   (001_user.sql)
              '00000000-0000-4000-8000-000000000010')   -- Grace (007_multitenant.sql)
   AND password = '$2b$10$ubOFS2D0e.u2pYFxsDowfOgqXTOHv6fSF1ZuKi.VVaz301rnaLqVG';

-- ─── 2. Credential account rows (V200 shape) ─────────────────────────────────
-- `accountId` is the user's own id — a credential "account" is self-owned (§2.3). The row id is
-- deterministic so re-runs are recognizable; conflict resolution keys on ("providerId",
-- "accountId") regardless. Only users with a usable password get a row (V200's rule): the
-- empty-string password is the "no usable credential" sentinel and must not become a login.

INSERT INTO apiome.account (
  "id", "userId", "accountId", "providerId", "password",
  "createdAt", "updatedAt", provider_email, email_verified
)
SELECT
  'seed-credential-' || u.id::text,
  u.id,
  u.id::text,
  'credential',
  u.password,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  u.email,
  COALESCE(u.verified, false)
FROM apiome.users u
WHERE u.id IN ('00000000-0000-4000-8000-000000000001',
               '00000000-0000-4000-8000-000000000010')
  AND u.password IS NOT NULL
  AND u.password <> ''
  AND u.deleted_at IS NULL
ON CONFLICT ("providerId", "accountId")
DO UPDATE SET
  "password"  = EXCLUDED."password",
  "updatedAt" = CURRENT_TIMESTAMP
WHERE apiome.account."password" IS DISTINCT FROM EXCLUDED."password";
