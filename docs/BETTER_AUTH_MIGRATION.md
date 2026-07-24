# Better Auth Migration — Design & Decision Record

> **Ticket:** [OLO-10.1] Better Auth migration design & decision record — #4996
> **Epic:** [OLO-EPIC-10] Better Auth Migration (gates OLO-9) — #4995
> **Status:** Decided. This is the reference document every OLO-10.x ticket builds on.
> **Roadmap:** `private-suite/docs/roadmaps/ROADMAP_BETTER_AUTH_MIGRATION.md`
> **Suite counterpart:** `private-suite/docs/roadmaps/ROADMAP_BETTER_AUTH_ALIGNMENT.md` (SUITE-EPIC #2538)

This spike gates the whole epic. It records the four decisions that "port as we go" would otherwise
leave implicit and inconsistent — **session strategy**, **schema mapping**, **security-invariant
preservation**, and **cutover/rollback** — plus a risk register. Downstream tickets reference the
section numbers here rather than re-deciding.

## How to use this document

- **§1** decides the session strategy. **✅ Implemented by 10.3 (#4998)** in
  `apiome-ui/lib/auth/better-auth-session.ts` (TTL/refresh/cookie-cache + cross-subdomain cookie &
  trusted-origin parity + secret resolution) and wired into `lib/auth/auth.ts`; consumed suite-side by
  **BAA-1.2–1.5**.
- **§2** is the field-by-field schema map. Implemented by **10.4 (#4999)**, **10.5 (#5000)**,
  **10.10 (#5005)**.
- **§3** is the invariant-preservation plan; each invariant names its downstream ticket. Implemented
  chiefly by **10.6 (#5001)**, **10.7 (#5002)**, **10.8 (#5003)**, **10.9 (#5004)**.
- **§4** decides the cutover/rollback model. Implemented by **10.2 (#4997)** (flag) and
  **10.14 (#5009)** (flip + deprecate).
- **§5** is the risk register with owners (the assignee of the named downstream ticket).

Every file/line citation is against `main` at the time of writing (`next-auth@^4.24.14`); treat
them as anchors, not guarantees, once implementation starts.

---

## 0. Current-state summary (what we are migrating *from*)

The single most important, and initially surprising, fact: **apiome does not use the NextAuth/Auth.js
database adapter.** There are **no `accounts`, `sessions`, or `verification`/`verification_token`
tables** anywhere in `apiome-db/scripts/`. NextAuth runs in **JWT + credentials mode** over a bespoke
schema, and OAuth identities are stored in a hand-rolled `external_auth_providers` table. This means
the migration is a **restructure**, not a column rename.

| Concern | Current implementation | Reference |
|---|---|---|
| Library | `next-auth@^4.24.14` | `apiome-ui/package.json` |
| Config factory | `makeAuthOptions()` — one factory for the static and per-request builds so they can't drift (OLO-8.6) | `apiome-ui/src/app/api/auth/[...nextauth]/route.ts:41` |
| Session strategy | **Implicit JWT** — no `session:` and no `adapter:` key ⇒ NextAuth v4 defaults (JWT, `maxAge` 30d, `updateAge` 24h). Stateless JWE cookie; **no session table** | `route.ts:42-199` |
| Session secret | `NEXTAUTH_SECRET`; JWE also decoded manually via HKDF for stale-cookie cleanup | `route.ts:43`, `apiome-ui/lib/auth/stale-session-cookie.ts:11-13` |
| Cookie | `__Secure-next-auth.session-token` (prod), `httpOnly`, `sameSite=lax`, `secure`, `domain=.apiome.app` for cross-subdomain sharing with the studio | `apiome-ui/lib/auth/cookie-options.ts:100-140` |
| Backend bridge | Server routes read `getServerSession`, then **mint a separate `sub=user_id` JWT** to call apiome-rest; the studio's `designer` mints the same shared-secret JWT for `spire` | `apiome-ui/src/app/api/projects/route.ts:30-59`; alignment roadmap BAA-1.4/1.5 |
| Users | `apiome.users` — `password` (bcrypt hash), `verified` (bool, **not** `emailVerified` timestamp), `enabled`, `deleted_at`, case-insensitive unique `lower(email)` where live | `apiome-db/scripts/V001__…sql:16`, `V180:102` |
| OAuth identities | `apiome.external_auth_providers` — `(user_id, provider, provider_user_id, provider_email, email_verified, access_token, refresh_token, profile_data)`; `UNIQUE(user_id,provider)` + `UNIQUE(provider,provider_user_id)` | `apiome-db/scripts/V010__…sql:16`, `V181:33`, `V198:26` |
| Verification | Boolean `users.verified` only; **no token store** | `V001:16` |
| 2FA / TOTP | **None** — greenfield | grep confirms no `totp/2fa/authenticator` code |
| Security engine | `account-resolution.ts` (pure policy, injectable store) + `credentials.ts` (production store); **mirrored in Python** `apiome-rest/src/app/account_resolution.py` | — |
| Provider config | DB-over-env store `auth_provider_config` (V196) + merge resolver + REST encryption + admin screen (OLO-8.x) | see §3.5 |

---

## 1. Session strategy decision (a)

### The choice

**Adopt Better Auth's native database sessions** (its default), **and** re-establish the
service-to-service bearer token via the Better Auth **JWT/bearer plugin**, signed with the Better
Auth secret. We do **not** try to reproduce today's "stateless JWE session cookie is the whole
session" model.

### Why this is not obvious

Today's model is fully **stateless**: the session *is* a signed/encrypted JWT in the cookie; there is
no `sessions` table; and every backend call is authorized by a **second**, hand-minted `sub=user_id`
JWT. That has been fine because there is no server-side session lifecycle to manage. Better Auth
inverts this: its session is a row in a `session` table addressed by an opaque `token` in the cookie,
validated per request (with an optional signed "cookie cache" to avoid the DB read on the hot path).

### Trade-offs for our multi-service setup

| Factor | DB sessions (chosen) | Stateless JWT-only |
|---|---|---|
| **2FA (the point of the epic)** | Native. `twoFactorRedirect` **discards the pending session** until the second factor verifies, and trusted-device (30-day) + lockout state must live server-side. DB sessions make this first-class. | Fights the plugin: the 2FA plugin assumes a session record it can withhold/attach. |
| **Revocation / "sign out everywhere"** | Real — delete the row(s). Today logout only clears the cookie + in-memory state. | Not possible without a denylist, which reintroduces a DB anyway. |
| **Cross-subdomain (`*.apiome.app`)** | Preserved: the opaque token rides the same shared-domain cookie and is validated against the **shared** DB. Arguably cleaner than re-verifying a JWT signature in every app. | Preserved, but each consumer must hold the secret to verify. |
| **`designer → spire` bearer contract** | Preserved via the **JWT plugin**: mint a short-lived JWT *derived from* the session, signed with the Better Auth secret/claims (this is precisely BAA-1.4 #2542 / BAA-1.5 #2543). | Native, but couples every service to the primary session secret. |
| **Hot-path cost** | One indexed lookup per request; mitigate with Better Auth **cookie cache** (short-TTL signed snapshot) to match today's zero-DB reads for most requests. | Zero DB reads. |
| **IP / user-agent capture** | Free (`session.ipAddress`, `session.userAgent`) — feeds the `auth_events` ledger (V193). | Manual. |

**Decision rationale:** the epic exists for **first-class 2FA**, and every 2FA affordance
(deferred session on second-factor challenge, 30-day trusted devices, lockout) needs server-side
session state. DB sessions also give us real revocation for free and keep cross-subdomain working
through the existing shared cookie. The one thing stateless JWT gave us — a signed token other
services can verify offline — is re-created deliberately and narrowly with the JWT plugin rather than
adopted as the primary session model.

### Concrete session parameters (✅ implemented in 10.3 #4998)

Realised in `apiome-ui/lib/auth/better-auth-session.ts` (pure env-driven builders) and applied in
`lib/auth/auth.ts` on the `session` / `advanced` / `trustedOrigins` / `secret` options:

- **`session.expiresIn`** = **30 days** (`SESSION_EXPIRES_IN_SECONDS`), **`updateAge`/refresh = 24 h**
  (`SESSION_UPDATE_AGE_SECONDS`) — match NextAuth v4 defaults so no user is logged out early at
  cutover.
- **Secret:** `resolveBetterAuthSecret()` reuses `NEXTAUTH_SECRET` by default so existing tooling and
  the suite's shared-secret assumption hold; `BETTER_AUTH_SECRET` overrides it to migrate onto a
  dedicated secret, and Better Auth's native versioned `BETTER_AUTH_SECRETS` (`2:new,1:old`) is the
  **non-destructive rotation path** — because sessions are DB rows, rotating only invalidates the
  signed cookie cache (one extra DB read, ≤ 60 s window) and logs nobody out.
- **Cookie:** `buildBetterAuthAdvancedOptions()` sets `crossSubDomainCookies` scoped to the same
  shared parent domain the legacy engine uses (`getSharedCookieDomain()` → `NEXTAUTH_COOKIE_DOMAIN`
  in prod, inferred otherwise; host-only in dev). Every other attribute (`sameSite=lax`, `secure`,
  `httpOnly`, `__Secure-`/`__Host-` prefixes) is already Better Auth's default and matches
  `buildAuthCookieOverrides()`. Better Auth's cookie name differs (`better-auth.session_token` /
  `__Secure-…`); the studio's mirror (`private-suite/.../designer/lib/auth/cookie-options.ts`) must be
  updated in lockstep (BAA-1.3 #2541) or a studio login stops being an app login.
- **Trusted origins:** `buildBetterAuthTrustedOrigins()` trusts the configured app/studio origins plus
  a `https://*<cookie-domain>` wildcard so a login can still return to a sibling subdomain covered by
  the shared cookie — the Better Auth equivalent of `isAllowedCallbackUrl`'s cookie-domain rule.
- **Cookie cache** ON with a short 60 s TTL (`SESSION_COOKIE_CACHE_MAX_AGE_SECONDS`) to preserve
  today's near-zero session-read cost.
- **JWT/bearer plugin — deferred, not part of 10.3.** Registering the plugin so `designer` can mint a
  `spire`-facing token from the session is the suite-side **BAA-1.4/1.5** work; the existing
  hand-minted `sub=user_id` bearer keeps working unchanged meanwhile, so it is intentionally out of
  this ticket's scope (which is session persistence, TTL, cookies and the secret path).

---

## 2. Field-by-field schema map (b)

Better Auth's core is four tables — `user`, `session`, `account`, `verification` — plus the 2FA
plugin's `twoFactor` table and a `user.twoFactorEnabled` flag (schema quoted from the Better Auth
NextAuth-migration guide and 2FA-plugin docs). apiome has `users` and `external_auth_providers`
today; `session`, `account`, and `verification` **do not exist and must be created**. Implemented by
**10.4 (#4999)** (core tables), **10.5 (#5000)** (credential relocation), **10.10 (#5005)** (2FA
table). New migrations are **V199+**; every migration keeps `SET search_path TO apiome, public;` and
all objects live in the `apiome` schema.

**Strategy: adapt-in-place where a table exists, create where it doesn't.** Better Auth lets you map
model/field names onto existing tables. Because `apiome.users.id` is referenced by many FKs
(entitlements, tenant memberships, auth_events, external_auth_providers, one-time-codes) and by the
Python REST side, we **keep `apiome.users` as the `user` model via field mapping** rather than
building a parallel `user` table, and we **introduce fresh `session`/`account`/`verification`
tables**, backfilling `account` from `external_auth_providers` and from `users.password`.

### 2.1 `user` model → keep `apiome.users` (mapped)

| Better Auth field | Type | Current column | Action |
|---|---|---|---|
| `id` | string PK | `users.id` (UUID) | keep; Better Auth accepts a UUID id |
| `name` | string | `users.name` | keep |
| `email` | string | `users.email` | keep; retain the `lower(email)` live-unique index (§3.1) |
| `emailVerified` | **boolean** | `users.verified` (boolean) | **map field name** `emailVerified → verified` (already boolean — no NextAuth timestamp conversion needed) |
| `image` | string | *(none)* | add nullable `image`, or map to a profile field; low priority |
| `createdAt` | datetime | `users.created_at` | map name |
| `updatedAt` | datetime | `users.updated_at` | map name |
| `twoFactorEnabled` | boolean | *(none)* | **add** (10.10 #5005), default `false` |
| — | — | `users.password` | **relocate** to `account` (§2.3); keep column until cutover for rollback |
| — | — | `users.enabled`, `deleted_at`, `last_login_at` | **retain** as app columns; enforced by the resolution gate (§3), not by Better Auth |

### 2.2 `session` model → **new** `apiome.session`

No source table. Create with Better Auth's shape; populate on first sign-in post-cutover (existing
JWE cookies are honored during parallel-run by the legacy engine — see §4).

| Field | Type | Notes |
|---|---|---|
| `id` | string PK | |
| `userId` | string FK → `users.id` | `ON DELETE CASCADE` |
| `token` | string (unique) | replaces NextAuth's cookie-embedded JWT |
| `expiresAt` | datetime | 30-day TTL (§1) |
| `ipAddress` | string | feed `auth_events.ip_hash` (hashed, never raw — V193) |
| `userAgent` | string | feed `auth_events.user_agent_hash` |
| `createdAt` / `updatedAt` | datetime | |

### 2.3 `account` model → **new** `apiome.account` (backfilled from `external_auth_providers` **and** `users.password`)

This is the load-bearing mapping. Better Auth stores **both** OAuth identities and the credential
password in one `account` table, keyed by `providerId`.

| Better Auth field | Type | Source | Mapping notes |
|---|---|---|---|
| `id` | string PK | new | |
| `userId` | string FK | `external_auth_providers.user_id` | |
| `providerId` | string | `external_auth_providers.provider` | slug is preserved verbatim (`github/gitlab/azure/google`); the credential row uses the literal **`"credential"`** |
| `accountId` | string | `external_auth_providers.provider_user_id` | Better Auth's provider-side id |
| `accessToken` | string | `external_auth_providers.access_token` | |
| `refreshToken` | string | `external_auth_providers.refresh_token` | |
| `accessTokenExpiresAt` | datetime | `external_auth_providers.token_expires_at` | |
| `refreshTokenExpiresAt` | datetime | *(none)* | nullable; not tracked today |
| `scope` | string | derive from provider config | |
| `idToken` | string | *(none / profile_data)* | optional |
| `password` | string | **`users.password`** | **credential relocation (10.5 #5000):** one `account` row per password user with `providerId="credential"`, `accountId=userId` |
| `createdAt`/`updatedAt` | datetime | `external_auth_providers.created_at/updated_at` | |
| — | — | `external_auth_providers.provider_email`, `email_verified`, `profile_data` | **carry into `account`** (extra columns) — the resolution engine needs `email_verified` and `profile_data` for nOAuth re-validation (§3.2); do **not** drop them |

> **✅ Credential relocation implemented (10.5 #5000).** `V200__better_auth_credential_password_relocation_5000.sql`
> copies each usable `users.password` bcrypt hash into an `account` row (`providerId='credential'`,
> `accountId=userId`) verbatim. Better Auth's `emailAndPassword.password` is overridden with bcrypt
> `hash`/`verify` (`apiome-ui/lib/auth/better-auth-credentials.ts`) so the relocated hashes validate
> under Better Auth (default scrypt), the per-account/per-IP limiter is re-applied via sign-in hooks,
> and `apiome-ui/lib/db/credential-account.ts` dual-writes the row on every password write.
> `users.password` stays the rollback source; rollback = `DELETE FROM apiome.account WHERE "providerId" = 'credential';`.

**Uniqueness must be re-expressed on `account`:** today `external_auth_providers` enforces
`UNIQUE(provider, provider_user_id)` and `UNIQUE(user_id, provider)` (V181). The equivalent on
`account` is `UNIQUE(providerId, accountId)` and `UNIQUE(userId, providerId)` (§3.1). This is the
identity-uniqueness invariant (OLO-1.2) and **must** land with the table, not later.

### 2.4 `verification` model → **new** `apiome.verification`

No source table (we only have the `users.verified` boolean). Create Better Auth's shape so the 2FA
plugin and any future email-verification/OTP flow have their store:

| Field | Type | Notes |
|---|---|---|
| `id` | string PK | single key (NextAuth used a composite) |
| `identifier` | string | e.g. email or `2fa:<userId>` |
| `value` | string | replaces NextAuth `token` |
| `expiresAt` | datetime | replaces NextAuth `expires` |
| `createdAt`/`updatedAt` | datetime | |

### 2.5 `twoFactor` model → **new** `apiome.two_factor` (10.10 #5005)

| Field | Type | Notes |
|---|---|---|
| `id` | string PK | |
| `userId` | string FK → `users.id` | |
| `secret` | string | encrypted TOTP secret — the plugin's own symmetric encryption (**R11 resolved**, see below) |
| `backupCodes` | string | single-use recovery codes; regenerated as a set (encrypted at rest by the plugin) |
| `verified` | boolean | secret verified during enrollment (plugin default `true`) |
| `failedVerificationCount` | number | drives lockout (default `0`) |
| `lockedUntil` | datetime (nullable) | lockout expiry; null = not locked |

Plus `user.twoFactorEnabled boolean` (§2.1). Registered via `twoFactor()` on the server instance
(`appName`/`issuer` = the app name) and `twoFactorClient()` on the client. **No enrollment/login UX
here** — that is OLO-9.13 (#5014) / OLO-9.14 (#5006).

> **✅ 2FA foundation implemented (10.10 #5005).** `V201__better_auth_two_factor_5005.sql` creates
> `apiome.two_factor` (the plugin's native quoted camelCase columns; `"userId"` a UUID FK →
> `users(id)` `ON DELETE CASCADE`; indexes on `"userId"`/`"secret"`) and adds `users."twoFactorEnabled"`
> (default `false`). The table is snake_case per apiome convention while the columns stay Better Auth's
> native names — bridged by `twoFactor({ twoFactorTable: 'two_factor' })` (the model→table `modelName`
> override; field names are unmapped). The plugin is registered on the server instance
> (`apiome-ui/lib/auth/auth.ts`, `issuer` = `appName`) and `twoFactorClient()` on the browser client
> (`apiome-ui/lib/auth/auth-client.ts`). Migration is additive/idempotent/reversible (rollback =
> `DROP TABLE apiome.two_factor; ALTER TABLE apiome.users DROP COLUMN "twoFactorEnabled";`).
> **R11 resolved:** the TOTP `secret` and `backupCodes` are encrypted at rest by the plugin's own
> symmetric encryption, keyed on the Better Auth secret (`NEXTAUTH_SECRET`) — chosen over a bespoke
> OLO-8.3 `AUTH_CONFIG_ENC_KEY` envelope so the one auth key already protecting sessions/cookies covers
> 2FA too, adding no new key-management surface.

### 2.6 Tables that stay as-is

`auth_provider_config` (V196), `auth_events` (V193), `oauth_signup_pending` + `auth_one_time_codes`
(V071), `user_entitlements`, and the tenant/RBAC tables are **not** Better Auth models and are
untouched by the core schema move — but the provider-config and boot-validation *plumbing* around
them must be re-pointed (§3.5, §3.4). Note `auth_one_time_codes` is the post-OAuth-signup handoff
token and is unrelated to 2FA.

### Route / API shape changes (for 10.2 #4997, 10.12 #5007)

- Route handler: `src/app/api/auth/[...nextauth]/route.ts` → `src/app/api/auth/[...all]/route.ts`
  exporting Better Auth `handlers` — **behind a flag**, coexisting with the old route (§4).
- Client: `next-auth/react` `signIn`/`signOut`/`useSession` → `authClient.*`
  (`LoginClient.tsx`, `LinkedAccountsClient.tsx`, `OauthSignupClient.tsx`, `SessionWrapper.tsx`, ~29
  `useSession` consumers).
- Server: `getServerSession(authOptions)` (~50+ routes, `server-session.ts`) → Better Auth server
  `auth.api.getSession`. Middleware stays non-gating (it already is — `src/middleware.ts` only clears
  stale cookies and 404s git-like paths); per-route/per-page guards remain the pattern.

#### ✅ Implemented in 10.12 (#5007) — engine-aware compat layer

The swap is realized **without breaking the default `next-auth` engine** (the parallel-run invariant),
so no component imports `next-auth/react` yet both engines still serve the browser:

- **Session contract.** Every surface consumes `{ user: { user_id, email, name, image?,
  current_tenant_id? }, expires }` on either engine. `user_id` = Better Auth `user.id`;
  `current_tenant_id` is **derived at read time** from the durable last-active-tenant cookie,
  re-validated against live memberships (`lib/auth/better-auth-session-shape.ts`) — the exact logic the
  NextAuth `jwt` callback ran at login, moved to read time (no schema change), fail-safe.
- **Server.** A Better Auth `customSession` plugin (`auth.ts`) injects the contract fields so both
  `auth.api.getSession()` and the browser `/get-session` return one shape. `getAuthSession()`
  (`server-session.ts`) dispatches by engine; all ~106 route handlers + page guards read through it.
- **Client.** `lib/auth/session-client.tsx` exposes the legacy `{ data, status, update }` API +
  `signIn`/`signOut`, dispatching to `authClient.*` (`better-auth-client-compat.ts`) or to NextAuth's
  own HTTP endpoints via plain fetch (`next-auth-client-compat.ts`) — the latter so the default engine
  keeps working with **zero** `next-auth/react` imports. The engine is read in the browser from
  `NEXT_PUBLIC_AUTH_ENGINE`, which `next.config.ts` derives from `AUTH_ENGINE` (operators set only
  `AUTH_ENGINE`).
- **Tenant switch.** `update({ current_tenant_id })` → validated `setActiveTenant` server action writes
  the cookie (both engines) + refreshes the NextAuth JWT (next-auth only).
- **Known gap (→ 10.13).** One-time-code credential sign-in (OAuth-signup completion) has no Better
  Auth endpoint; under Better Auth the OAuth callback establishes the session directly, so the compat
  `signIn` treats it as a NextAuth-only bridge and warns on the Better Auth engine.

---

## 3. Security-invariant preservation plan (c)

The OLO-1.x/2.x engine is the security spine of sign-in. Each invariant below states **what it is**,
**where it lives today**, **how it is preserved on Better Auth**, and **its owning downstream ticket**.
The engine is pure policy (`account-resolution.ts`) behind an injectable store — so the plan is to
**keep the engine and re-wire the store to Better Auth's sign-in/callback hooks**, not to rewrite the
policy. The Jest matrix (`tests/account-resolution.test.ts`) and its Python mirror
(`apiome-rest/tests/test_account_resolution.py`) carry over largely unchanged and are the acceptance
gate.

### 3.1 Identity uniqueness — OLO-1.2 → **10.4 (#4999)** + **10.6 (#5001)**

- **Today:** `UNIQUE(provider, provider_user_id)` and `UNIQUE(user_id, provider)` on
  `external_auth_providers` (V181:64-78); case-insensitive live-only uniqueness on
  `lower(users.email)` (V180:102-104); the engine admits an `auto-link` **only if** the identity
  binding actually persists, failing to `identity-linked-elsewhere` otherwise
  (`account-resolution.ts:586-596`).
- **On Better Auth:** re-express both constraints on the new `account` table as
  `UNIQUE(providerId, accountId)` + `UNIQUE(userId, providerId)` **in the same migration that creates
  it** (§2.3), and keep the `lower(email)` index on the mapped `user` table. The store's
  `linkIdentity` still reports persistence failure via a `code` so the "admit only on successful
  bind" behavior is unchanged.
- **Acceptance:** the uniqueness cases in the resolution matrix pass; a second user cannot claim an
  identity already bound elsewhere.

### 3.2 nOAuth hardening — OLO-1.4 → **10.6 (#5001)**

- **Today:** `resolveEntraEmailVerified(profile, account, emailInUse?)`
  (`account-resolution.ts:208-237`), called **only** for `provider === 'azure'`
  (`account-resolution.ts:540-543`). It trusts the Entra email **only** when `xms_edov` is explicitly
  true, or `email_verified` is explicitly true *and* attests the token's own `email` claim, or the
  email equals a non-guest `upn`; an explicit-false claim vetoes; unrecognized ⇒ unverified. Raw
  evidence (`oid/tid/upn/preferred_username/email/email_verified/xms_edov`) is persisted for
  re-validation. A forged token is rejected with the structured `unverified-email` code.
- **On Better Auth:** the Entra provider is expressed as a generic OIDC provider (10.7), and the
  `azure` claims still land in the sign-in hook's `profile`. Call the **same**
  `resolveEntraEmailVerified` from the Better Auth sign-in/`before`-create hook before any
  auto-link/create; persist the same evidence into `account.profile_data` (§2.3). The nOAuth guard is
  provider-gated on the slug `azure`, which survives the migration verbatim.
- **Acceptance:** the nOAuth test suite passes; a forged nOAuth token is still rejected with the
  structured code (epic acceptance criterion).

### 3.3 Verified-email parity — OLO-2.5 → **10.6 (#5001)** + **10.7 (#5002)**

- **Today:** providers don't natively carry `email_verified`, so userinfo hooks normalize it:
  GitHub `githubUserinfoRequest` fetches `/user/emails` and marks verified only on a `verified:true`
  entry (`verified-email.ts:170-231`); GitLab `gitlabUserinfoRequest` requires a non-empty
  `confirmed_at` (`verified-email.ts:196-246`); Google's id token carries a native `email_verified`
  read through the generic path. Everything fails **closed** to unverified → `unverified-email`.
- **On Better Auth:** preserve the normalization by attaching the equivalent of the userinfo/`mapProfile`
  hook per provider in the Better Auth provider config (10.7), so `email_verified` is computed the
  same way before the engine sees it. The generic `resolveOAuthEmailVerified` reader
  (`account-resolution.ts:154-159`) is unchanged.
- **Acceptance:** verified-email parity tests pass for GitHub/GitLab/Google; an unverified provider
  email cannot auto-link or sign up.

### 3.4 Boot-time provider validation — OLO-7.2 → **10.9 (#5004)**

- **Today:** `validateProviderEnv()` (`provider-registry.ts:387-405`) runs at boot from
  `src/instrumentation.ts:13-19`; `AUTH_PROVIDER_VALIDATION` selects **`strict`** (default — throws,
  aborting startup on any partially-configured provider) vs **`warn`** (logs, leaves disabled). The
  Python side validates the **encryption keys** at FastAPI startup
  (`auth_provider_secret_crypto.py:243-257`, `main.py:379`).
- **On Better Auth:** provider completeness is still computed from the shared registry (§3.5), so
  `validateProviderEnv()` stays as-is and continues to run in `instrumentation.ts` **before** the
  Better Auth instance is constructed — an incomplete provider must fail/warn at boot exactly as
  today. The REST encryption-key boot check is untouched.
- **Acceptance:** partial config still fails/warns at boot per `AUTH_PROVIDER_VALIDATION`.

### 3.5 DB-over-env provider config store — OLO-8.x → **10.8 (#5003)** + **10.9 (#5004)**

- **Today:** `auth_provider_config` (V196) overlays env field-by-field; the merge resolver
  `resolveProviderEnv()` (`provider-config-resolver.ts:250-256`) builds the effective env per request
  with a 5–60 s TTL cache and degrade-to-env on outage; secrets are envelope-encrypted
  (AES-256-GCM, `apiome-rest/src/app/auth_provider_secret_crypto.py`) and served decrypted only on the
  internal `/v1/internal/auth-providers/resolved` route; the admin screen
  (`AuthProviderSettingsClient.tsx`) writes minimal partial PUTs; the per-request NextAuth handler
  rebuilds the provider set each request (`route.ts:225`) so a DB toggle lands without redeploy
  (OLO-8.6).
- **On Better Auth:** the merge resolver output is env-shaped and provider-agnostic, so it feeds the
  Better Auth provider construction the same way — **re-point `resolveOAuthProviders()` at the Better
  Auth `socialProviders`/generic-OIDC builder** while keeping the resolver, cache, encryption, admin
  screen, and REST routes intact. Preserve the "options are a function of the request" property so
  per-request DB resolution still works (Better Auth supports per-request options; verify the exact
  hook in 10.8). The registry mirror (`registry.json` ↔ `provider-registry.ts` ↔
  `auth_provider_registry.py`) and its mirror tests remain the single source of enabled providers.
- **Acceptance:** an admin enable/disable + credentials/extras change takes effect on the next
  sign-in; secrets stay write-only + encrypted; completeness/validate checks still work.

### 3.6 Supporting invariants carried along

- **Structured error contract (OLO-1.5):** `AUTH_ERROR_CODES` (`account-resolution.ts:41-75`) and the
  `/login?error=<code>` transport are engine-level and portable; keep the codes **byte-identical**
  (they are a public contract, `docs/AUTH_ERROR_CODES.md`) and re-emit them from the Better Auth
  sign-in hook. Owned by **10.6**.
- **Credentials anti-enumeration + rate limits (OLO-7.1/7.3):** the single-bcrypt-compare decoy
  (`credentials.ts:256-265`) and per-account/per-IP budgets move onto Better Auth's credential
  sign-in hook (10.5 #5000 acceptance criterion). Note the limiter is **in-memory per-process**
  (`login-rate-limit.ts:19-22`) — see Risk R7.
- **Google Workspace `hd` gate (OLO-9.2):** `assertGoogleHostedDomain` throws before resolution
  (`google-provider.ts:114-122`); re-attach it in the Google provider's profile hook (10.7).

---

## 4. Cutover & rollback model (d)

### Decision: **parallel-run behind a feature flag, with an additive (dual-source) data migration.**

> **✅ Cutover completed (10.14 #5009).** Better Auth is now the only engine: `next-auth`, the
> `[...nextauth]` route (now `[...all]`), the `AUTH_ENGINE`/`NEXT_PUBLIC_AUTH_ENGINE` flag, and the
> NextAuth compat layer were removed. The additive schema and the legacy `users.password` /
> `external_auth_providers` columns were **kept** (not dropped) so a redeploy of the prior release
> remains a valid rollback. The parallel-run mechanics below are retained as the historical record of
> how the cutover was reached.

Not a hard swap. Both engines coexist; a flag selects which one serves auth; the schema move is
forward-additive so the legacy columns/tables remain intact for rollback until the epic's final
ticket removes them.

**Engine flag.** Introduce `AUTH_ENGINE=next-auth|better-auth` (default `next-auth`). Mount Better
Auth at `/api/auth/[...all]` alongside the existing `/api/auth/[...nextauth]` (10.2 #4997). With the
flag off, NextAuth flows are byte-for-byte unchanged; with it on, new sign-ins use Better Auth.

**Data migration is additive (10.4/10.5/10.10).**
- Create `session`, `account`, `verification`, `two_factor`; map `users`→`user` and add
  `twoFactorEnabled`.
- Backfill `account` from **both** `external_auth_providers` (OAuth rows) **and** `users.password`
  (one `providerId="credential"` row per password user).
- **Keep `users.password` and `external_auth_providers` in place** (source of truth for rollback)
  until 10.14. Reads during parallel-run come from the new tables; the legacy columns are frozen
  copies.

**Cutover sequence (10.14 #5009).**
1. Ship the additive migration; run the backfill; verify row-count and spot-check parity (a
   `password` account row exists for every enabled password user; an `account` row for every
   `external_auth_providers` identity).
2. Flip `AUTH_ENGINE=better-auth` for a canary, then fleet-wide, with the e2e journey suite green
   (10.13 #5008) including a TOTP path.
3. Bake period. Then remove `next-auth`, the `[...nextauth]` route, and the engine flag; update
   `AUTH_PROVIDER_SETUP.md`, `.env.example`, and docs. **✅ Done in 10.14 (#5009)** — the legacy
   `users.password` / `external_auth_providers` columns were deliberately **kept** (not dropped) to
   preserve a redeploy-based rollback (see below); dropping them is deferred to a later, separate
   cleanup once the bake on Better Auth is proven in production.

**Rollback.**
- **During parallel-run (pre-10.14):** flip `AUTH_ENGINE=next-auth`. Because the legacy columns/tables
  were never dropped and existing JWE session cookies remain valid (30-day TTL), users fall back onto
  the old engine with no data loss.
- **After the 10.14 cutover:** the flag no longer exists, so rollback is **redeploying the prior
  release** (which still bundles `next-auth` and the `[...nextauth]` route) — the retained additive
  schema and legacy columns make that image fully functional. A pre-cutover DB snapshot backs it.

**Divergence window:** anything created *only* under Better Auth after the cutover — new 2FA
enrollments, password changes, newly-linked identities, brand-new signups — does not exist in the
legacy columns. Mitigations: (i) keep the bake short and the canary small; (ii) **dual-write**
credential-password changes and new identity links back to the legacy columns during parallel-run so
a rollback loses nothing but 2FA enrollment (2FA doesn't exist in the old engine anyway); (iii)
snapshot the DB immediately before the fleet flip. This divergence is Risk R1.

---

## 5. Risk register (e)

Owners are **the assignee of the named downstream ticket** (role, not a named individual, until the
ticket is assigned).

| # | Risk | Likelihood × Impact | Mitigation | Owner (ticket) |
|---|---|---|---|---|
| **R1** | **Rollback data divergence** — 2FA enrollments / password changes / new links made under Better Auth are absent from legacy columns after a flip-back | Med × High | Short bake + small canary; dual-write credential + link changes to legacy columns during parallel-run; pre-flip DB snapshot (§4) | 10.14 (#5009) |
| **R2** | **nOAuth regression** — the Entra `resolveEntraEmailVerified` guard isn't wired into the Better Auth hook, reintroducing an account-takeover hole | Low × Critical | Call the *same* function from the Better Auth sign-in hook; the nOAuth Jest + Python suites are the merge gate; forged-token rejection is an explicit acceptance criterion | 10.6 (#5001) |
| **R3** | **Credential lockout at cutover** — password hashes not correctly relocated to `account(providerId="credential")` locks out every password user | Low × Critical | Reversible relocation keeping `users.password`; backfill parity check (a credential row per enabled password user) before flip; bcrypt verify unchanged | 10.5 (#5000) |
| **R4** | **Cross-subdomain session breakage** — Better Auth cookie name/domain not mirrored to the studio, so a studio login stops being an app login | Med × High | Port `cookie-options.ts` overrides to Better Auth's cookie in lockstep app-side (10.3) and suite-side (BAA-1.3 #2541); shared `.apiome.app` domain preserved | 10.3 (#4998) / BAA-1.3 |
| **R5** | **`designer → spire` token contract break** — moving off the hand-minted `sub=user_id` JWT breaks REST/spire authorization | Med × High | Enable the Better Auth JWT/bearer plugin signing with the shared secret/claims; validate on spire (BAA-1.4 #2542 / BAA-1.5 #2543); coordinate cutover with SUITE #2538 | 10.3 (#4998) / BAA-1.4/1.5 |
| **R6** | **Per-request DB-over-env resolution not reproducible** on Better Auth (options frozen at module load) → admin toggles need a redeploy (OLO-8.6 regression) | Med × Med | Confirm Better Auth's per-request options hook in a 10.8 spike before committing; keep the resolver + TTL cache; fall back to short cache TTL if needed | 10.8 (#5003) |
| **R7** | **Rate limiter is in-memory per-process** (`login-rate-limit.ts:19-22`) — brute-force budgets don't hold across replicas; the migration is a natural moment to regress or entrench this | Low × Med | Preserve current behavior on the new hook; log the DB/Redis upgrade as a fast-follow (out of MVP scope but noted here so it isn't lost) | 10.5 (#5000) |
| **R8** | **Provider-config resolver credential drift** — `PROVIDER_CRED_ENV_KEYS` (`provider-config-resolver.ts:52-59`) covers only github/gitlab/azure; **google/aws are missing**, so a DB-stored Google client id/secret is not overlaid onto env (Google `config` extras still overlay) | Med × Med | Fix the gap while re-pointing the resolver (10.8); add a resolver test asserting every `available` registry provider has cred-env keys | 10.8 (#5003) |
| **R9** | **Session-read hot-path cost** — DB sessions add a per-request lookup vs today's stateless read | Low × Med | Enable Better Auth cookie cache (short TTL) to match today's zero-DB reads for most requests (§1) | 10.3 (#4998) |
| **R10** | **Registry mirror drift** — TS/Python registries + `registry.json` fall out of sync while providers are re-expressed | Low × Med | Keep the mirror tests (`provider-registry-mirror.test.ts`, `test_auth_provider_registry.py`) as a CI gate through 10.7/10.9 | 10.7 (#5002) |
| **R11** | ✅ **Resolved (10.10 #5005).** **TOTP secret encryption choice** — the plugin's `two_factor.secret` needs at-rest encryption | Low × Med | **Resolved:** use the twoFactor plugin's built-in symmetric encryption (keyed on the Better Auth secret `NEXTAUTH_SECRET`) for both `secret` and `backupCodes` — no bespoke OLO-8.3 envelope, so no new key-management surface (§2.5) | 10.10 (#5005) ✅ |

---

## 6. Invariant → downstream-ticket traceability (acceptance-criterion index)

| Invariant | Codepath today | Preserved by |
|---|---|---|
| **OLO-1.2** identity uniqueness | `external_auth_providers` UNIQUE constraints; auto-link admit-on-persist | **10.4 (#4999)** + **10.6 (#5001)** |
| **OLO-1.4** nOAuth hardening | `resolveEntraEmailVerified` (`account-resolution.ts:208`) | **10.6 (#5001)** |
| **OLO-2.5** verified-email parity | GitHub/GitLab/Google userinfo normalization (`verified-email.ts`) | **10.6 (#5001)** + **10.7 (#5002)** |
| **OLO-7.2** boot validation | `validateProviderEnv` (`provider-registry.ts:387`) + `instrumentation.ts` | **10.9 (#5004)** |
| **OLO-8.x** DB-over-env config store | `auth_provider_config` (V196) + resolver + REST encryption + admin screen | **10.8 (#5003)** + **10.9 (#5004)** |
| OLO-1.5 structured error contract | `AUTH_ERROR_CODES` (`account-resolution.ts:41`) | 10.6 (#5001) |
| OLO-7.1/7.3 anti-enumeration + rate limits | `credentials.ts:256-265`, `login-rate-limit.ts` | 10.5 (#5000) |
| OLO-9.2 Google Workspace `hd` gate | `assertGoogleHostedDomain` (`google-provider.ts:114`) | 10.7 (#5002) |

---

## 7. Decisions made in this record

1. **Session strategy:** Better Auth **database sessions** (30-day TTL / 24h refresh, cookie cache on)
   + JWT/bearer plugin for the `designer→spire` token. (§1)
2. **Schema strategy:** adapt `apiome.users` in place as the `user` model via field mapping; create
   fresh `session`/`account`/`verification`/`two_factor`; migrate OAuth identities and the credential
   password into `account`. (§2)
3. **Invariant strategy:** keep the pure resolution engine and re-wire its store to Better Auth
   hooks; every invariant maps to a named ticket. (§3, §6)
4. **Cutover:** parallel-run behind `AUTH_ENGINE`, additive migration, flag-flip cutover, flip-back
   rollback with a short bake and dual-write mitigations. (§4)

## Sources

- Better Auth — [NextAuth migration guide](https://better-auth.com/docs/guides/next-auth-migration-guide)
- Better Auth — [Two-Factor Authentication plugin](https://better-auth.com/docs/plugins/2fa)
- Auth.js — [Migrating to Better Auth](https://authjs.dev/getting-started/migrate-to-better-auth)
- Better Auth — ["Auth.js is now part of Better Auth"](https://better-auth.com/blog/authjs-joins-better-auth)
- Internal: `private-suite/docs/roadmaps/ROADMAP_BETTER_AUTH_MIGRATION.md`,
  `private-suite/docs/roadmaps/ROADMAP_BETTER_AUTH_ALIGNMENT.md`,
  `apiome-ui/docs/AUTH_ERROR_CODES.md`, `apiome-ui/docs/AUTH_THREAT_MODEL_REVIEW.md`.
</content>
</invoke>
