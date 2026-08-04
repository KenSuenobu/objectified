-- Dev seed: sample user.
--
-- Login:    ada@example.com
-- Password: apiome-dev   (bcrypt hash below; DEV ONLY — never load in production)
--
-- The hash must actually verify against "apiome-dev" — sign-in reads it (via the credential
-- account row, see 008_credential_accounts.sql), and test/seed.test.ts asserts it with bcrypt.
--
-- Idempotent: re-running leaves the existing row untouched (ON CONFLICT on the fixed id).
-- Stacks seeded before the hash was fixed (#2560) are healed by 008_credential_accounts.sql.

INSERT INTO apiome.users (id, name, email, password, verified, enabled)
VALUES (
  '00000000-0000-4000-8000-000000000001',
  'Ada Lovelace',
  'ada@example.com',
  '$2b$10$CZ6T5dNM4gGB07ni8rcW5ObIIuOaC3DsBwzM6keX8Sei/8.QpGpdS',
  true,
  true
)
ON CONFLICT (id) DO NOTHING;
