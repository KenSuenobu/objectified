# OLO end-to-end journey suite (OLO-7.4 #4226, rebuilt on Better Auth in OLO-10.13 #5008)

The MVP acceptance gate for the OAuth Login & Onboarding roadmap (#4184): one continuous
Playwright journey through login (all four providers, mocked), the account-resolution
invariants, first-tenant onboarding, Free-license limits, the tenant switcher, credentials
sign-in, and 2FA (TOTP + backup code).

The suite runs entirely on the **Better Auth engine** — the only engine since the OLO-10.14 cutover
(`support/env.ts`). Built as the OLO-10.13 acceptance gate for the migration, it covers the full auth
regression: credentials, all four OAuth providers, account linking, and 2FA.

## What is real, what is mocked

| Piece | Journey uses |
| --- | --- |
| Next.js UI | Real, dedicated dev server on `:3100`, on the Better Auth engine |
| REST API + Postgres | Real (`docker compose up --wait` from the repo root; V201 `two_factor` migration applied) |
| GitHub / GitLab / Microsoft / Google OAuth | Mocked — `e2e/support/mock-oauth-server.mjs` on `:8091` |

The app is pointed at the mock via the base-URL overrides
(`GITHUB_OAUTH_BASE_URL`, `GITHUB_API_BASE_URL`, `GITLAB_BASE_URL`,
`AZURE_AD_AUTHORITY_BASE_URL`, `GOOGLE_ISSUER`) — see `e2e/journey/support/env.ts` for the full
env the server under test boots with. Production deployments never set these vars.

## 2FA legs

There is no 2FA UX yet (the `twoFactor` plugin is foundation-only, #5005), so the enroll /
login-with-code / backup-code legs drive Better Auth's `two-factor` HTTP endpoints directly over
the browser context's session cookies, generating live TOTP codes with the dependency-free
`support/totp.ts` helper (RFC 6238, matching the plugin's SHA1/6-digit/30s defaults).

## Running locally

```bash
# from the repo root — Postgres + migrations + REST must be up
docker compose up --wait

# from apiome-ui/
yarn test:e2e:journey
```

The Playwright config starts the mock provider server and the dedicated UI dev server
itself. Database connectivity comes from `DATABASE_URL` (env or `apiome-ui/.env`).

Runs are re-entrant: every email, slug, and provider-side id carries a per-run suffix,
so repeated runs against the same database never collide.

## Suite layout

- `oauth-onboarding-journey.spec.ts` — the eleven-step journey (serial): four OAuth providers,
  invariants, onboarding, license, switcher, credentials sign-in, and the 2FA legs.
- `support/env.ts` — ports, URLs, and the app-under-test environment (the four provider mock
  overrides).
- `support/mock-oauth.ts` — persona control client for the mock provider.
- `support/db.ts` — seeding (zero-tenant user, credential user, invite targets) and storage-layer
  invariant checks (no-duplicate-account, linked identities, 2FA state).
- `support/totp.ts` — dependency-free RFC 6238 TOTP generator for the 2FA login legs.
- `support/global-setup.ts` — fails fast when REST/Postgres are missing.

The REST-side twin of this journey is `apiome-rest/tests/test_journey_olo.py`.
