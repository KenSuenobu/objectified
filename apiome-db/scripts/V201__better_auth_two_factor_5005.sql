-- Better Auth 2FA foundation — `two_factor` table + `users.twoFactorEnabled` flag (#5005, OLO-10.10,
-- Epic OLO-EPIC-10 #4995).
--
-- Design of record: docs/BETTER_AUTH_MIGRATION.md §2.5 (twoFactor model) and §2.1 (twoFactorEnabled).
-- This is the DB half of the 2FA foundation; the app half — registering the `twoFactor` plugin on the
-- Better Auth instance (apiome-ui/lib/auth/auth.ts) and `twoFactorClient()` on the browser client
-- (apiome-ui/lib/auth/auth-client.ts) — lands in the same ticket. NO enrollment/login UX is added by
-- OLO-10.10; that is OLO-9.13 (#5014, TOTP enrollment + login step) and OLO-9.14 (#5006, backup
-- codes / trusted devices / lockout). This migration only creates the persistence those tickets build on.
--
-- WHY THE UNUSUAL camelCase, QUOTED COLUMN NAMES.
--   Same reason as the V199 core tables: the Better Auth `twoFactor` plugin talks to Postgres through
--   the Kysely adapter (which quotes every identifier) with its default camelCase field names
--   (`userId`, `backupCodes`, `failedVerificationCount`, `lockedUntil`, …) and NO field mapping. So to
--   be readable by the plugin out of the box these columns MUST be quoted camelCase, deviating from the
--   snake_case convention used everywhere else in apiome. Only the TABLE name is mapped to snake_case
--   (`two_factor`, via `twoFactor({ twoFactorTable: 'two_factor' })` — §2.5): the plugin's model→table
--   `modelName` override changes the table name only, not the field names.
--
-- ID / FK TYPES.
--   `"id"` is TEXT — the plugin generates an opaque string id for each row (matching session/account
--   in V199). `"userId"` is UUID because it is a foreign key onto the pre-existing `apiome.users.id`
--   (UUID); the plugin passes the user's UUID as a string and Postgres accepts it into the UUID column,
--   exactly as for session/account.
--
-- SECRET & BACKUP CODES ARE ENCRYPTED AT REST BY THE PLUGIN (resolves design R11).
--   The plugin encrypts the TOTP `"secret"` and the `"backupCodes"` set with symmetric encryption keyed
--   on the Better Auth secret (`BETTER_AUTH_SECRET` via resolveBetterAuthSecret) before they are written
--   here — so these columns hold ciphertext, never a plaintext secret. OLO-10.10 deliberately chooses
--   the plugin's built-in encryption over a bespoke OLO-8.3 `AUTH_CONFIG_ENC_KEY` envelope: it reuses
--   the one auth key already protecting sessions/cookies and adds no new key-management surface. TEXT is
--   the correct column type for that ciphertext.
--
-- ADDITIVE / REVERSIBLE (cutover model §4).
--   This migration only CREATES a new table and ADDS one nullable-with-default column to `users`; it
--   drops or rewrites nothing. Rollback is:
--       DROP TABLE IF EXISTS apiome.two_factor CASCADE;
--       ALTER TABLE apiome.users DROP COLUMN IF EXISTS "twoFactorEnabled";
--   Every statement is guarded (CREATE TABLE/INDEX IF NOT EXISTS, ADD COLUMN IF NOT EXISTS) so a re-run
--   or a hand-drifted schema converges without error. No data is backfilled: 2FA is opt-in, so every
--   existing user starts with `"twoFactorEnabled" = false` and no `two_factor` row until they enroll
--   (OLO-9.13).

SET search_path TO apiome, public;

-- ---------------------------------------------------------------------------------------------------
-- two_factor — Better Auth twoFactor plugin store (design §2.5). One row per user who has enrolled a
-- TOTP secret. Written by the plugin's enable/verify endpoints; unused until OLO-9.13 wires the UX.
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS apiome.two_factor (
  -- Plugin-generated opaque string id (not a UUID) — TEXT to match the plugin's schema (as session/account).
  "id"                       TEXT PRIMARY KEY,
  -- Owning user. UUID FK onto the reused `users` table; cascade so deleting a user clears its 2FA row.
  "userId"                   UUID NOT NULL REFERENCES apiome.users(id) ON DELETE CASCADE,
  -- Encrypted TOTP secret (ciphertext — see header). Required: the plugin writes it on enrollment.
  "secret"                   TEXT NOT NULL,
  -- Encrypted single-use backup/recovery codes, stored as one encrypted set. Required on enrollment.
  "backupCodes"              TEXT NOT NULL,
  -- Whether the secret has been verified during enrollment. Plugin default is true (§2.5).
  "verified"                 BOOLEAN NOT NULL DEFAULT true,
  -- Consecutive failed second-factor verifications; drives the account lockout (OLO-9.14).
  "failedVerificationCount"  INTEGER NOT NULL DEFAULT 0,
  -- Lockout expiry; NULL = not locked (OLO-9.14).
  "lockedUntil"              TIMESTAMPTZ
);

-- Hot-path indexes mirror the plugin schema's `index: true` fields: owner lookup (the plugin reads the
-- row by userId on every second-factor challenge) and the secret lookup the plugin declares.
CREATE INDEX IF NOT EXISTS idx_two_factor_user_id ON apiome.two_factor ("userId");
CREATE INDEX IF NOT EXISTS idx_two_factor_secret  ON apiome.two_factor ("secret");

COMMENT ON TABLE apiome.two_factor IS
  'Better Auth twoFactor store (OLO-10.10 #5005): one row per user enrolled in TOTP 2FA. "secret" and '
  '"backupCodes" are encrypted at rest by the plugin (keyed on the Better Auth secret). Mapped from the '
  'plugin''s `twoFactor` model via twoFactorTable=''two_factor''. Foundation only — enrollment/login UX '
  'is OLO-9.13/9.14.';
COMMENT ON COLUMN apiome.two_factor."secret" IS
  'Encrypted TOTP secret (ciphertext). Encrypted by the twoFactor plugin with symmetric encryption '
  'keyed on the Better Auth secret before insert — never stored in plaintext.';
COMMENT ON COLUMN apiome.two_factor."lockedUntil" IS
  'Second-factor lockout expiry; NULL = not locked. Driven by "failedVerificationCount" (OLO-9.14).';

-- ---------------------------------------------------------------------------------------------------
-- users.twoFactorEnabled — Better Auth `user.twoFactorEnabled` flag (design §2.1). Added as a Better
-- Auth-native quoted camelCase column on the reused `users` table (the plugin's `user` schema entry
-- carries no field mapping, so it reads this exact identifier). Defaults false; flipped true by the
-- plugin when a user completes enrollment (OLO-9.13). ADD COLUMN IF NOT EXISTS keeps the migration
-- idempotent and re-runnable.
-- ---------------------------------------------------------------------------------------------------
ALTER TABLE apiome.users
  ADD COLUMN IF NOT EXISTS "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN apiome.users."twoFactorEnabled" IS
  'Better Auth twoFactor flag (OLO-10.10 #5005): whether the user has 2FA enabled. Quoted camelCase so '
  'the twoFactor plugin (no field mapping) reads it directly. Defaults false; set true on enrollment '
  '(OLO-9.13).';
