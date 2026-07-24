# Auth Threat-Model Checklist Review (OLO-7.3)

A systematic security pass over the OAuth login / onboarding surface, beyond the individual
feature tickets. Scope: `apiome-ui` (NextAuth + server actions), `apiome-rest` (token read path,
account-resolution mirror), `apiome-db` (migrations V010 / V071).

- **Ticket:** #4225 · **Epic:** OLO-EPIC-7 (#4222) · **Umbrella:** #4184 · **Release:** v2
- **Outcome:** checklist executed; **no criticals open at review end**. The directly-exploitable
  authorization/enumeration issues were fixed on this branch; the remaining gaps (encryption at
  rest, PSL parsing, legacy-signup enumeration, assorted hygiene) are tracked as follow-ups
  **#4960–#4963**.

The method: seven checklist areas, each reviewed against the current code with concrete attack
payloads, then classified as **hardened** (no action), **fixed here**, or **follow-up** (ticketed).

---

## Summary

| # | Checklist area | Verdict |
|---|---|---|
| 1 | OAuth `state` + PKCE on all providers | ✅ Hardened (+ regression insurance added) |
| 2 | Redirect-URI / `callbackUrl` allowlist (OLO-3.4) | ✅ Hardened; 1 latent gap → #4961 |
| 3 | Session fixation on login + cookie hardening | ✅ Hardened; 1 authz gap **fixed here**; 1 → #4963 |
| 4 | CSRF on link routes | ⚠️ 1 IDOR **fixed here**; 2 hygiene → #4963 |
| 5 | Token storage encryption-at-rest (V010) | ❌ Gap → **#4960** (HIGH) |
| 6 | One-time code expiry / rotation (V071) | ✅ Hardened |
| 7 | Enumeration resistance on error codes (OLO-1.5) | ✅ OAuth path resistant; 1 timing oracle **fixed here**; 1 → #4962 |

### Fixed on this branch (ticket #4225)
1. **IDOR on linked-account server actions** (Area 4) — the five (six incl. `addPersonalAccessToken`)
   `'use server'` actions took `userId` as a client argument and used it directly in SQL. Now each
   binds to `getAuthSession()` and refuses when the caller is not that user
   (`lib/db/helper.ts` → `resolveOwnLinkedAccountUserId`).
2. **Tenant-switch privilege check** (Area 3) — the NextAuth `jwt` `update` trigger wrote a
   client-supplied `current_tenant_id` into the signed token without membership re-validation. Now
   routed through `validateTenantSwitch` (`lib/auth/post-login-routing.ts`), which fails closed.
3. **Credentials timing oracle** (Area 7) — a login miss skipped bcrypt, leaking account existence
   by response time. Now every attempt runs exactly one bcrypt compare (decoy hash on the miss
   path) — `lib/auth/credentials.ts`.
4. **Off-contract error string** (Area 7) — the `signIn` callback emitted free-text
   `?error=User account not found`; replaced with the stable, generic `sign-in-failed` contract
   code (`AUTH_ERROR_CODES` / `auth-error-copy.ts` / `AUTH_ERROR_CODES.md`).
5. **PKCE regression insurance** (Area 1) — GitHub's provider now sets `checks: ['state']`
   explicitly so a refactor / dependency bump cannot silently drop CSRF `state`
   (`lib/auth/nextauth-oauth-providers.ts`).

### Follow-up tickets (gaps not fixed here)
- **#4960 (HIGH)** — Encrypt OAuth access/refresh tokens & PATs at rest (V010).
- **#4961 (medium)** — Adopt the Public Suffix List for the callback allowlist / cookie-domain derivation.
- **#4962 (medium)** — Close account-enumeration on the legacy self-signup path.
- **#4963 (medium/low)** — Auth hygiene: link-route GET→POST+Origin, login tenant fail-closed, identity-proxy scoping.

---

## 1. OAuth `state` + PKCE on all providers

**Verdict: hardened.** NextAuth gates each protection on `provider.checks`; `state` is the default
for every provider, PKCE/nonce only when listed.

| Provider | `state` | PKCE | `nonce` | Notes |
|---|---|---|---|---|
| GitHub | ✅ | — | n/a | GitHub OAuth Apps don't support PKCE; confidential client authenticates the code exchange with `GITHUB_SECRET`. State + secret is correct. |
| GitLab | ✅ | ✅ | n/a | Better Auth generic-OAuth with `pkce: true`. |
| Entra ID (`azure`) | ✅ | ✅ | ✅ | Better Auth discovery + PKCE; id-token claims feed nOAuth hardening (OLO-1.4). |
| Google | ✅ | ✅ | n/a | Better Auth discovery (`GOOGLE_ISSUER`); Workspace `hd` gate (OLO-9.2). |
| Okta | ✅ | ✅ | n/a | Better Auth discovery (`OKTA_ISSUER`); native `email_verified` fail-closed (OLO-9.3). |
| AWS Cognito (`aws`) | ✅ | ✅ | n/a | Better Auth discovery (`COGNITO_ISSUER` user-pool issuer); native `email_verified` fail-closed (OLO-9.4). |

No manual/hand-rolled OAuth flow bypasses NextAuth's checks machinery; the CLI is an API-key/bearer
client with no PKCE flow, so it is out of scope.

**Fixed here:** GitHub now declares `checks: ['state']` explicitly (regression insurance) — no
behavior change, but a future refactor can't silently drop `state`. See
`tests/nextauth-oauth-providers.test.ts` → *"enforces CSRF checks per provider capability"*.

## 2. Redirect-URI / `callbackUrl` allowlist (OLO-3.4)

**Verdict: hardened for the production configuration.** The callback value is validated at three
layers, all through `lib/auth/cookie-options.ts`. The following payloads are all **correctly
blocked**: `//evil.com`, `/\evil.com`, `/%2F%2Fevil.com`, `https://evil.com`,
`https://sub.trusted.com.evil.com`, `https://trusted.com@evil.com`, `javascript:…`,
`evil-trusted.com`, `trusted.com.evil.com`, `evilapiome.app`. Userinfo is stripped, backslashes
normalized, the `//` protocol-relative guard holds, HTTPS is required in prod, and the cookie
domain uses leading-dot suffix matching. The NextAuth `redirect` callback fails closed to `baseUrl`.

**Latent gap → #4961:** `registrableDomain()` uses naive last-two-labels instead of the Public
Suffix List. Safe for `apiome.app` / `apiome.dev`, but under a multi-label public suffix or
platform-preview host (`*.vercel.app`, `*.pages.dev`, `*.co.uk`) it collapses to the shared
platform suffix and `https://attacker.vercel.app` would satisfy the trusted-deployment check.

## 3. Session fixation on login + cookie hardening

**Verdict: hardened.** Session strategy is **JWT** (no adapter), so the token is server-minted and
signed with `BETTER_AUTH_SECRET` at successful login — classic session fixation does not apply. Session
/ callback cookies are `httpOnly`, `secure` (prod), `sameSite=lax`, `path=/`; prefixes are correct
(`__Host-` on CSRF with no `Domain`, `__Secure-` on the subdomain-shared session/callback cookies).
The one-shot `oauth_link_intent` / `oauth_signup_intent` cookies are consumed at sign-in and never
survive into the authenticated session.

**Fixed here (High):** the `jwt` `update` trigger (tenant switcher) wrote a client-supplied
`current_tenant_id` into the signed token without membership re-validation. The REST backend
independently re-validates by URL slug, but frontend direct-DB server actions scoped solely by
`current_tenant_id` were exposed to tenant-confusion. Now gated by `validateTenantSwitch`
(fails closed). Tests: `tests/unit/post-login-routing.test.ts` → *"validateTenantSwitch"*.

**Follow-up → #4963(2):** `resolveActiveTenantForLogin` (the *login* path) fails **open** to the
unvalidated candidate on a DB error.

## 4. CSRF on link routes

**Verdict: 1 IDOR fixed here; 2 hygiene follow-ups.** OAuth link *binding* is safe — the link
target `userId` is written into `oauth_link_intent` from the server session (`httpOnly`, not
cross-site forgeable), and `linkExternalAccount` enforces identity uniqueness, so neither
forced-link nor identity theft is reachable. `signup-intent` is the model route (POST-only,
`Origin === Host`, provider allowlist, per-IP rate limit).

**Fixed here (High — IDOR):** `lib/db/helper.ts` is a `'use server'` module, so
`getLinkedAccountsForUser`, `getUserHasPassword`, `unlinkExternalAccount`,
`addPersonalAccessToken`, `updatePersonalAccessToken`, `removePersonalAccessToken` were all
callable server actions taking `userId` as a **client** argument — their `WHERE user_id = $userId`
clauses only ever compared against the attacker-supplied value. Any authenticated user could pass a
victim's id to read the victim's providers / PAT suffixes or unlink / overwrite / wipe their tokens.
Now each calls `resolveOwnLinkedAccountUserId(userId)` and refuses (generic not-found / empty) when
the session user is not that user. Tests: `tests/unlink-last-method-guard.test.ts` →
*"linked-account actions — session binding (OLO-7.3 IDOR guard)"*.

**Follow-ups → #4963(1,3):** link-initiation is a GET with no Origin/CSRF check (limited impact —
convert to POST + Origin check); `/api/identity/link` forwards the body unvalidated to REST (confirm
backend tenant scoping).

## 5. Token storage — encryption at rest (V010)

**Verdict: gap → #4960 (HIGH).** OAuth access/refresh tokens **and** PATs are persisted in plaintext
`TEXT` columns (`V010:23-24`) despite the migration's own *"encrypted in production"* comments, and
despite the codebase already having a sealed-secret helper (webhook / MCP secrets). Any DB-read
exposure yields live provider tokens and long-lived PATs. Not fixed here because it needs a
migration + key management + a coordinated apiome-ui (encrypt-on-write) / apiome-rest
(decrypt-on-read) change. It is a defense-in-depth HIGH (requires DB compromise to exploit), so it
is tracked rather than left as an open critical.

## 6. One-time signup code — expiry / rotation (V071)

**Verdict: hardened.** The `auth_one_time_codes` code (`lib/db/oauth-signup.ts`):
- **TTL:** 15-minute `expires_at`, enforced **in the redemption SQL**
  (`DELETE … WHERE id = $1 AND expires_at > CURRENT_TIMESTAMP RETURNING …`), not just in app code.
- **Single-use / replay-safe:** atomic `DELETE … RETURNING` — a second redemption returns 0 rows.
- **Entropy:** the code is a `crypto.randomUUID()` v4 (~122 bits CSPRNG) — not guessable/enumerable.
- **Brute-force:** bad codes count against the per-IP login lock.

Minor (tracked as related in #4960): the code is stored un-hashed (it is the PK) — single-use +
short TTL bound the risk; hashing is optional defense-in-depth.

## 7. Enumeration resistance on error codes (OLO-1.5)

**Verdict: OAuth path resistant; 1 timing oracle fixed here; 1 follow-up.** The structured contract
uses stable generic codes, never echoes the `?error=` value (unknown codes → fixed generic banner),
gates existence signals behind provider-identity ownership, and auto-links on a verified email
instead of announcing "email exists". `CredentialsSignin` copy is a deliberate "not found **or**
wrong password" merge.

**Fixed here (medium — timing oracle):** `credentialsAuthorize` only ran bcrypt when the account
existed with a usable password, so a non-existent / OAuth-only email answered measurably faster
(an enumeration oracle even within the rate-limit budget). Now a fixed decoy hash is compared on the
miss path so every attempt costs one bcrypt verification. Tests:
`tests/credentials-timing-oracle.test.ts`.

**Fixed here (low — contract hygiene):** the `signIn` callback's free-text `?error=User account not
found` is replaced with the stable generic `sign-in-failed` code.

**Follow-up → #4962:** the legacy self-signup path (`createSignupRequest`) returns distinct
"already requested" vs "accepted" responses (plus a timing delta) — an unauthenticated enumeration
oracle over the waitlist table.

---

## Re-run notes

The review is code-anchored — re-run it by re-reading the cited files after any auth change. The
fixes above ship with regression tests (`tests/unlink-last-method-guard.test.ts`,
`tests/credentials-timing-oracle.test.ts`, `tests/unit/post-login-routing.test.ts`,
`tests/nextauth-oauth-providers.test.ts`, `tests/auth-error-contract.test.ts`,
`tests/login-error-rendering.test.tsx`). Close-out requires #4960 (the only HIGH) to be scheduled;
no criticals remained open at the end of this review.
