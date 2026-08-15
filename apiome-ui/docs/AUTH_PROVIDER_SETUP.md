# Sign-in Provider Setup & Secrets Guide (OLO-7.2)

How to register the OAuth applications Apiome signs users in with (GitHub, GitLab,
Microsoft Entra ID, Google Workspace, Okta, Amazon Cognito, Keycloak, generic OIDC, Auth0, LINE, VK, WeChat), which
settings each provider needs, where those settings can live, and how boot-time validation reacts
when a provider is misconfigured.

The single source of truth for the provider list and each provider's config contract is the
provider registry: [`lib/auth/provider-registry.ts`](../lib/auth/provider-registry.ts)
(OLO-2.3). A provider is **enabled** only when *all* of its required fields resolve to a set,
non-blank value; clearing them all **cleanly disables** it everywhere at once (login button,
linked-accounts panel, Better Auth sign-in route). No code changes are needed either way.

## Config precedence — database first, `.env` fallback

Each required field can be supplied from two places, merged **field by field** on every login
(OLO-8.5/8.6):

| Rank | Source | Written from | Takes effect |
|---|---|---|---|
| **1** | `apiome.auth_provider_config` (server-global table, V196) | **Admin → System Configuration** (`/admin/dashboard/settings`) | at the **next login** — no restart |
| **2** | environment variables | `.env`, `docker-compose.env`, or your orchestrator's secret store | at the **next restart** |

One rule covers every case: **a stored value wins; an absent or blank stored value falls through to
the env var of the same name.** Consequences worth internalising:

- **No DB row** for a provider → it is governed entirely by env, exactly as before OLO-8.
- **A row with a `NULL`/blank field** → that field alone falls back to env. Rows are merged per
  field, not wholesale: a stored client id happily pairs with an env client secret.
- **`enabled = false`** pins the provider **off** even when env sets every var — the stored "off"
  is an explicit operator decision, so it removes the credentials from the merged view.
- **`enabled = NULL`** ("Use .env" in the admin screen) means enablement is derived the usual way:
  the provider is on when every required field resolves from either source.
- Forcing a provider **`enabled = true`** requires its client id *and* secret to be **stored in the
  database** — env values do not count toward that check, so an operator cannot enable a provider
  the DB alone could not serve.

### The env template is the fallback and the local-dev path

The provider variables in [`.env.example`](../.env.example) are **not** the primary configuration
surface for a deployment that uses the admin screen. Treat them as:

- the **local-dev path** — no database row, no admin login, no KEK needed; and
- the **fallback** for anything not stored in the database, including the bootstrap case where the
  admin screen itself is not yet usable.

A production deployment can legitimately leave every provider var unset and configure providers
entirely from Admin → System Configuration. It can equally run env-only and never create a row.
Both are supported; mixing them per field is supported too.

### Switching the database source on

The merge is only consulted when apiome-ui can read the decrypted config from apiome-rest, which is
gated by a shared service token:

| Variable | Where | Purpose |
|---|---|---|
| `INTERNAL_SERVICE_TOKEN` | apiome-ui **and** apiome-rest (identical value) | authorises `GET /v1/internal/auth-providers/resolved`, the login-time read path |
| `AUTH_CONFIG_ENC_KEY` | apiome-rest only | the KEK that seals/unseals stored client secrets — see [Encryption at rest](#encryption-at-rest-and-key-rotation-auth_config_enc_key) |
| `AUTH_PROVIDER_CONFIG_CACHE_TTL_MS` | apiome-ui | optional TTL (ms) of the in-process resolved-config cache; clamped to `[5000, 60000]`, default `30000` |

**Unset `INTERNAL_SERVICE_TOKEN` ⇒ the database layer is switched off entirely**: providers come
from env alone and anything saved in the admin screen has no effect on login. Because that is
indistinguishable from a dropped token, the server logs it **once at startup**:

```
[provider-config-resolver] INTERNAL_SERVICE_TOKEN is not set; sign-in providers are configured
from env only, and admin-screen provider config will have no effect
```

If the token *is* set but apiome-rest is unreachable or errors, sign-in **degrades to env** rather
than breaking (OLO-8.6) — see [Boot-time validation](#boot-time-validation) for how that affects
startup checks.

## Environment variable matrix

Every variable below is the **fallback** source for its field (rank 2 above). Providers whose
config is stored in the database need none of them set; see
[Config precedence](#config-precedence--database-first-env-fallback).

| Variable | Provider / scope | Required | Purpose |
|---|---|---|---|
| `BETTER_AUTH_URL` | all | Yes | Public base URL of the app; every OAuth callback URL below derives from it |
| `BETTER_AUTH_SECRET` | all | Yes | Shared signing secret for the Better Auth session and the downstream REST JWT (`openssl rand -base64 32`) |
| `SENDGRID_API_KEY` | 2FA email OTP | To enable email OTP | SendGrid API key used by `otpOptions.sendOTP` (OLO-9.50) |
| `EMAIL_FROM` | 2FA email OTP | To enable email OTP | Verified SendGrid sender (`addr@domain` or `Name <addr@domain>`) |
| `GITHUB_ID` | GitHub | To enable GitHub | OAuth app **Client ID** |
| `GITHUB_SECRET` | GitHub | To enable GitHub | OAuth app **Client secret** |
| `GITLAB_CLIENT_ID` | GitLab | To enable GitLab | Application **Application ID** |
| `GITLAB_CLIENT_SECRET` | GitLab | To enable GitLab | Application **Secret** |
| `AZURE_AD_CLIENT_ID` | Entra ID | To enable Microsoft | App registration **Application (client) ID** |
| `AZURE_AD_CLIENT_SECRET` | Entra ID | To enable Microsoft | Client secret **value** (not its ID) |
| `AZURE_AD_TENANT` | Entra ID | No (default `common`) | Tenant id/domain to restrict sign-in to one directory |
| `GOOGLE_CLIENT_ID` | Google | To enable Google | OAuth client **Client ID** |
| `GOOGLE_CLIENT_SECRET` | Google | To enable Google | OAuth client **Client secret** |
| `GOOGLE_WORKSPACE_DOMAIN` | Google | No (default: any account) | Restrict sign-in to one Workspace domain (`hd` param + verified claim) |
| `OKTA_CLIENT_ID` | Okta | To enable Okta | OIDC application **Client ID** |
| `OKTA_CLIENT_SECRET` | Okta | To enable Okta | OIDC application **Client secret** |
| `OKTA_ISSUER` | Okta | To enable Okta | Org / authorization-server issuer (e.g. `https://acme.okta.com/oauth2/default`) |
| `COGNITO_CLIENT_ID` | AWS Cognito | To enable AWS | App client **Client ID** |
| `COGNITO_CLIENT_SECRET` | AWS Cognito | To enable AWS | App client **Client secret** |
| `COGNITO_ISSUER` | AWS Cognito | To enable AWS | User-pool issuer (`https://cognito-idp.<region>.amazonaws.com/<userPoolId>`) |
| `KEYCLOAK_CLIENT_ID` | Keycloak | To enable Keycloak | Confidential client **Client ID** |
| `KEYCLOAK_CLIENT_SECRET` | Keycloak | To enable Keycloak | Confidential client **Client secret** |
| `KEYCLOAK_ISSUER` | Keycloak | To enable Keycloak | Realm issuer (`https://kc.example.com/realms/<realm>`) |
| `OIDC_CLIENT_ID` | Generic OIDC | To enable OIDC | Confidential client **Client ID** |
| `OIDC_CLIENT_SECRET` | Generic OIDC | To enable OIDC | Confidential client **Client secret** |
| `OIDC_ISSUER` | Generic OIDC | To enable OIDC | IdP issuer URL (discovery at `<issuer>/.well-known/openid-configuration`) |
| `OIDC_DISPLAY_NAME` | Generic OIDC | No (default `OIDC`) | Login-button and admin-card label (e.g. `Authentik`) |
| `OIDC_SCOPES` | Generic OIDC | No (default `openid profile email`) | Whitespace-separated scopes requested at authorize |
| `AUTH0_CLIENT_ID` | Auth0 | To enable Auth0 | Application **Client ID** |
| `AUTH0_CLIENT_SECRET` | Auth0 | To enable Auth0 | Application **Client Secret** |
| `AUTH0_ISSUER` | Auth0 | To enable Auth0 | Tenant issuer (`https://<tenant>.auth0.com`) |
| `LINE_CLIENT_ID` | LINE | To enable LINE | LINE Login channel **Channel ID** |
| `LINE_CLIENT_SECRET` | LINE | To enable LINE | LINE Login channel **Channel secret** |
| `VK_CLIENT_ID` | VK | To enable VK | VK ID application **App ID** |
| `VK_CLIENT_SECRET` | VK | To enable VK | VK ID application **Secure key** |
| `WECHAT_CLIENT_ID` | WeChat | To enable WeChat | WeChat Open Platform Website App **AppID** |
| `WECHAT_CLIENT_SECRET` | WeChat | To enable WeChat | WeChat Open Platform Website App **AppSecret** |
| `WECHAT_LANG` | WeChat | No (default `cn`) | QR page language: `cn` or `en` |
| `AUTH_PROVIDER_VALIDATION` | validation | No (default `strict`) | `strict` fails startup on partial provider config; `warn` logs and disables |

Rules that apply to every provider:

- Blank or whitespace-only values count as **unset** — a commented-template line like
  `GITHUB_ID=` does not enable a provider, and a blank *stored* value falls back to env rather
  than disabling the field.
- **All fields resolved** → provider enabled. **No fields resolved** → provider cleanly disabled.
  Both are valid deployments.
- **Some-but-not-all resolved** → misconfiguration; see
  [Boot-time validation](#boot-time-validation) below. "Resolved" is judged against the merged
  DB-over-env view, so an env var left unset because the value is stored in the database is not a
  gap.

### Required fields beyond client id/secret (OLO-9.1)

A registry entry declares its required fields structurally (`requiredFields`), each mapped to
an env var. Most providers require exactly a **client id** and a **client secret**. Issuer-based
providers (Okta, Cognito, Keycloak, generic OIDC, Auth0) additionally
require an OIDC **issuer** URL stored in the provider's `config` extras. Setting the id and secret
but leaving the issuer unset is *partial config* and boot-time validation names the missing issuer
var, exactly as it does for a missing secret. In the admin settings screen the same field is
required before the provider can be enabled from the database (the issuer is stored in the
`config` JSONB and overlaid onto its env var). For generic OIDC, a fully configured issuer is also
**probed** at boot and on admin Validate (`GET <issuer>/.well-known/openid-configuration`) so a bad
or unreachable IdP fails loud instead of leaving a broken login page.

## Boot-time validation

At server startup ([`src/instrumentation.ts`](../src/instrumentation.ts) →
`validateProviderEnv()`), every provider's config contract is checked. A *partially*
configured provider — e.g. `GITHUB_ID` set but `GITHUB_SECRET` missing, typically a typo'd
var name or a secret that never reached the deployment — is reported per
`AUTH_PROVIDER_VALIDATION`:

- **`strict`** (default): startup **fails** with one actionable message per issue, naming
  the missing and present fields and both ways to resolve (set them all, or clear them all).
  Misconfiguration fails loud at boot, not silently at first login.
- **`warn`**: each issue is logged via `console.warn` and the provider stays **cleanly
  disabled** (a provider missing any required field is never registered as a sign-in provider).

Any other value of `AUTH_PROVIDER_VALIDATION` is itself a startup error, so a typo cannot
silently weaken validation.

Example strict-mode failure:

```
Error: Refusing to start: 1 sign-in provider(s) partially configured.
  - Sign-in provider 'GitHub' (github) is partially configured: GITHUB_SECRET is unset or
    blank while GITHUB_ID is set. Set all of GITHUB_ID, GITHUB_SECRET to enable GitHub
    sign-in, or unset all of them to disable it. Setup guide: apiome-ui/docs/AUTH_PROVIDER_SETUP.md
Set AUTH_PROVIDER_VALIDATION=warn to log instead and leave the provider(s) disabled.
```

### Validation and the database source (OLO-8.8)

Validation runs against the **merged** DB-over-env config, not raw `process.env`. Boot resolves the
overlay first (which also warms the resolver's cache, so the first login does not pay for the
fetch), then validates what login will actually see. Three cases, distinguished by whether the
stored config could be read:

| Config source | What it means | Strict-mode behaviour |
|---|---|---|
| **env-only** | `INTERNAL_SERVICE_TOKEN` unset — the database layer is off | unchanged: env is the whole truth, partial config fails startup |
| **database** | the resolved endpoint answered; stored values are merged in | a provider completed from the database is **not** flagged; one still partial after the merge fails startup, and its message names the admin screen as well as the env vars |
| **unavailable** | the token is set but the endpoint could not be read | strict is **downgraded to a warning** and startup continues |

The first row is the acceptance criterion this feature exists for: with `GITHUB_ID` in `.env` and
the secret stored from the admin screen, the deployment is complete and boot says nothing.

The **unavailable** downgrade is deliberate. When apiome-rest is unreachable at UI startup — a
common container-ordering situation — the merged view is missing whatever is stored, so a provider
that *looks* partial may be perfectly configured. Refusing to start on that evidence would turn a
transient REST outage into a boot outage. Startup continues, sign-in runs on env config until the
endpoint is reachable again, and the downgrade is never silent:

```
[provider-registry] AUTH_PROVIDER_VALIDATION=strict not enforced: the stored provider config
could not be read, so partial config cannot be told apart from config that lives in the
database. Startup continues on env config; the provider(s) below are disabled until the
resolved endpoint is reachable again.
[provider-registry] Sign-in provider 'GitHub' (github) is partially configured: GITHUB_SECRET is
unset or blank in env, and the stored provider config could not be read, while GITHUB_ID is set.
… This may be a false alarm: GitHub may already be fully configured in the database. … (provider disabled)
```

An invalid `AUTH_PROVIDER_VALIDATION` value still aborts startup in every case — the downgrade
covers unproven partial config only, never a typo'd mode.

## GitHub — OAuth app

1. Go to **GitHub → Settings → Developer settings → OAuth Apps** (org-owned apps: the org's
   **Settings → Developer settings**) and click **New OAuth App**.
2. Fill in:
   - **Application name:** `Apiome` (or your deployment's name)
   - **Homepage URL:** your `BETTER_AUTH_URL`, e.g. `https://app.apiome.dev`
   - **Authorization callback URL:** `{BETTER_AUTH_URL}/api/auth/oauth2/callback/github`
     (e.g. `http://localhost:3000/api/auth/oauth2/callback/github` for local dev)
3. Click **Register application**, then **Generate a new client secret**. Copy the secret
   immediately — GitHub shows it only once.
4. Set the env vars:

```bash
GITHUB_ID=<Client ID>
GITHUB_SECRET=<Client secret>
```

   …or store the same client id and secret from **Admin → System Configuration** instead. The
   stored values take precedence over these vars and take effect at the next login without a
   restart; leave the vars unset if the database is where you keep them
   ([Config precedence](#config-precedence--database-first-env-fallback)).

No extra scopes need configuring in the app — the sign-in flow requests `read:user
user:email` itself so it can resolve a **verified** primary email even when the public
profile email is hidden (OLO-2.5).

## GitLab — application

1. On GitLab, go to **Settings → Applications**
   (<https://gitlab.com/-/user_settings/applications>) — or a group/instance-level
   application for team use — and click **Add new application**.
2. Fill in:
   - **Name:** `Apiome`
   - **Redirect URI:** `{BETTER_AUTH_URL}/api/auth/oauth2/callback/gitlab`
   - **Confidential:** checked
   - **Scopes:** `read_user` (the sign-in flow requests `read_user` — email verification is
     read from the GitLab profile, OLO-2.5)
3. Save, then copy the **Application ID** and **Secret**.
4. Set the env vars:

```bash
GITLAB_CLIENT_ID=<Application ID>
GITLAB_CLIENT_SECRET=<Secret>
```

   …or store the same application id and secret from **Admin → System Configuration** instead —
   along with `GITLAB_BASE_URL` for a self-managed instance, which lives in the same stored `config`
   extras. Stored values take precedence over these vars and take effect at the next login without a
   restart ([Config precedence](#config-precedence--database-first-env-fallback)).

Step-by-step walkthrough with screenshots and self-managed-instance notes:
[`GITLAB_SSO_SETUP.md`](./GITLAB_SSO_SETUP.md).

## Microsoft Entra ID — app registration

1. In the [Entra admin center](https://entra.microsoft.com), go to **Identity →
   Applications → App registrations → New registration**.
2. Fill in:
   - **Name:** `Apiome`
   - **Supported account types:** multi-tenant (any directory) unless you want to restrict
     sign-in to one tenant — then single-tenant and set `AZURE_AD_TENANT` to your tenant id
     or domain.
   - **Redirect URI:** platform **Web**, value `{BETTER_AUTH_URL}/api/auth/oauth2/callback/azure`
3. Under **Certificates & secrets**, create a **client secret** and copy its **Value**
   (not the Secret ID) — it is shown only once.
4. **Required — enable the `xms_edov` optional claim** (OLO-1.4): under **Token
   configuration → Add optional claim**, token type **ID**, select **`xms_edov`** ("email
   domain owner verified"). Without this claim, Entra sign-ins are treated as having
   **unverified** email domains and users fall back to email verification instead of
   auto-joining their tenant. Full rationale, claim matrix, and verification steps:
   [`ENTRA_ID_APP_REGISTRATION.md`](./ENTRA_ID_APP_REGISTRATION.md).
5. Set the env vars:

```bash
AZURE_AD_CLIENT_ID=<Application (client) ID>
AZURE_AD_CLIENT_SECRET=<client secret Value>
# Optional: restrict to one directory (defaults to `common`, multi-tenant)
# AZURE_AD_TENANT=<tenant id or domain>
```

   …or store the same application id and client secret from **Admin → System Configuration**
   instead; `AZURE_AD_TENANT` (and the `AZURE_AD_AUTHORITY_BASE_URL` override) live in the same
   stored `config` extras. Stored values take precedence over these vars and take effect at the next
   login without a restart ([Config precedence](#config-precedence--database-first-env-fallback)).
   The `xms_edov` optional claim in step 4 is configured in Entra either way — it is a property of
   the app registration, not of Apiome's config.

## Google — OAuth client (Workspace sign-in)

1. In the [Google Cloud console](https://console.cloud.google.com/apis/credentials), pick (or
   create) a project, then go to **APIs & Services → Credentials**. Configure the **OAuth consent
   screen** first if prompted — **Internal** for a single Workspace org, **External** otherwise.
2. Click **Create credentials → OAuth client ID**:
   - **Application type:** **Web application**
   - **Authorized redirect URI:** `{BETTER_AUTH_URL}/api/auth/oauth2/callback/google`
     (e.g. `http://localhost:3000/api/auth/oauth2/callback/google` for local dev)
3. Click **Create**, then copy the **Client ID** and **Client secret**.
4. Set the env vars:

```bash
GOOGLE_CLIENT_ID=<Client ID>
GOOGLE_CLIENT_SECRET=<Client secret>
# Optional: restrict sign-in to one Google Workspace domain (defaults to any Google account)
# GOOGLE_WORKSPACE_DOMAIN=example.com
```

The sign-in flow requests the `openid email profile` scopes and reads Google's native
`email_verified` claim, so a verified Google address auto-joins its account exactly like the other
providers (OLO-2.5). No extra scopes need configuring on the OAuth client.

**Workspace domain restriction.** When `GOOGLE_WORKSPACE_DOMAIN` is set, the flow adds Google's
`hd` ("hosted domain") authorization parameter *and* verifies the `hd` claim on the returned id
token, rejecting any account outside that domain. The `hd` parameter alone is only advisory — a
user can still complete the flow with a personal or foreign-domain account — so the claim check is
the real boundary (per Google's OIDC docs). Leave the variable unset to allow any Google account,
including personal `@gmail.com` addresses.

## Okta — OIDC application (workforce IdP)

1. In the [Okta Admin Console](https://login.okta.com/), go to **Applications → Applications →
   Create App Integration**.
2. Choose **OIDC - OpenID Connect**, then **Web Application**.
3. Configure:
   - **Sign-in redirect URIs:** `{BETTER_AUTH_URL}/api/auth/oauth2/callback/okta`
     (e.g. `http://localhost:3000/api/auth/oauth2/callback/okta` for local dev)
   - **Controlled access:** assign the groups / people who may sign in
4. After creation, copy the **Client ID** and **Client secret**.
5. Determine the issuer URL for the authorization server you want to use:
   - Org authorization server (default): `https://{yourOktaDomain}/oauth2/default`
   - Custom authorization server: `https://{yourOktaDomain}/oauth2/{authServerId}`
   - The issuer is also listed under **Security → API → Authorization Servers** (the
     **Issuer URI** column).
6. Set the env vars:

```bash
OKTA_CLIENT_ID=<Client ID>
OKTA_CLIENT_SECRET=<Client secret>
OKTA_ISSUER=https://acme.okta.com/oauth2/default
```

The sign-in flow discovers endpoints from `{OKTA_ISSUER}/.well-known/openid-configuration`,
uses PKCE, requests the `openid email profile` scopes, and reads Okta's native `email_verified`
claim (fail-closed — a missing or false claim is treated as unverified). All three variables are
required; setting only the client id and secret is *partial config* and boot / admin Validate name
`OKTA_ISSUER`.

The same issuer can also be set from **Admin → System Configuration** (stored under `config.OKTA_ISSUER`
and overlaid onto the env var per OLO-8.5 / OLO-10.8).

## Amazon Cognito — user pool + Hosted UI (OLO-9.4)

1. In the [Amazon Cognito console](https://console.aws.amazon.com/cognito/), open (or create) a
   **User pool**.
2. Under **App integration → App clients → Create an app client**:
   - **App type:** Confidential client (client secret generated)
   - **Authentication flows:** allow the Authorization code grant
   - **Allowed callback URLs:** `{BETTER_AUTH_URL}/api/auth/oauth2/callback/aws`
     (e.g. `http://localhost:3000/api/auth/oauth2/callback/aws` for local dev)
3. Under **App integration → Domain**, configure a Cognito domain (or custom domain) so Hosted UI
   can serve the authorize endpoint discovered from the issuer.
4. Copy the app client's **Client ID** and **Client secret**.
5. Build the user-pool issuer URL:
   `https://cognito-idp.<region>.amazonaws.com/<userPoolId>`
   (Region and pool id are on the user-pool overview; the issuer is also the `issuer` claim in
   Cognito id tokens.)
6. Set the env vars:

```bash
COGNITO_CLIENT_ID=<Client ID>
COGNITO_CLIENT_SECRET=<Client secret>
COGNITO_ISSUER=https://cognito-idp.us-east-1.amazonaws.com/us-east-1_AbCdEf
```

The sign-in flow discovers endpoints from `{COGNITO_ISSUER}/.well-known/openid-configuration`,
uses PKCE, requests the `openid email profile` scopes, and reads Cognito's native `email_verified`
claim (fail-closed — a missing or false claim is treated as unverified). All three variables are
required; setting only the client id and secret is *partial config* and boot / admin Validate name
`COGNITO_ISSUER`.

The same issuer can also be set from **Admin → System Configuration** (stored under
`config.COGNITO_ISSUER` and overlaid onto the env var per OLO-8.5 / OLO-10.8).

## Keycloak — realm OIDC client (OLO-9.5)

1. In the Keycloak Admin Console, open (or create) a **realm** (e.g. `apiome`).
2. Under **Clients → Create client**:
   - **Client type:** OpenID Connect
   - **Client authentication:** On (confidential client — secret generated)
   - **Authentication flow:** Standard flow (authorization code)
   - **Valid redirect URIs:** `{BETTER_AUTH_URL}/api/auth/oauth2/callback/keycloak`
     (e.g. `http://localhost:3000/api/auth/oauth2/callback/keycloak` for local dev)
3. Copy the client's **Client ID** and **Client secret** (Credentials tab).
4. Build the realm issuer URL: `https://{keycloakHost}/realms/{realm}`
   (also listed as the `issuer` in `{issuer}/.well-known/openid-configuration`).
5. Ensure the client (or realm) mapper set includes `email`, `email verified`, and ideally
   `preferred_username` / `name` claims on the ID token.
6. Set the env vars:

```bash
KEYCLOAK_CLIENT_ID=<Client ID>
KEYCLOAK_CLIENT_SECRET=<Client secret>
KEYCLOAK_ISSUER=https://kc.example.com/realms/apiome
```

The sign-in flow discovers endpoints from `{KEYCLOAK_ISSUER}/.well-known/openid-configuration`,
uses PKCE, requests the `openid email profile` scopes, and reads Keycloak's native `email_verified`
claim (fail-closed — a missing or false claim is treated as unverified). All three variables are
required; setting only the client id and secret is *partial config* and boot / admin Validate name
`KEYCLOAK_ISSUER`.

The same issuer can also be set from **Admin → System Configuration** (stored under
`config.KEYCLOAK_ISSUER` and overlaid onto the env var per OLO-8.5 / OLO-10.8).

### Local testing with Docker Compose

A minimal Keycloak for local Apiome sign-in (dev credentials only — never reuse in production):

```yaml
# docker-compose.keycloak.yml
services:
  keycloak:
    image: quay.io/keycloak/keycloak:26.0
    command: start-dev
    environment:
      KEYCLOAK_ADMIN: admin
      KEYCLOAK_ADMIN_PASSWORD: admin
      KC_HTTP_PORT: 8080
    ports:
      - "8080:8080"
```

```bash
docker compose -f docker-compose.keycloak.yml up -d
```

Then in the Admin Console (`http://localhost:8080`):

1. Create realm `apiome`.
2. Create a confidential OIDC client (e.g. `apiome-ui`) with redirect
   `http://localhost:3000/api/auth/oauth2/callback/keycloak`.
3. Create a user with a verified email.
4. Point Apiome at:

```bash
KEYCLOAK_CLIENT_ID=apiome-ui
KEYCLOAK_CLIENT_SECRET=<from Credentials tab>
KEYCLOAK_ISSUER=http://localhost:8080/realms/apiome
```

## Generic OIDC — any conformant OpenID Provider (OLO-9.6)

Use this connector when the IdP is OIDC-compliant but has no first-class catalog entry
(PingFederate, OneLogin, JumpCloud, Authentik, ZITADEL, FusionAuth, Duende IdentityServer, …).
**v1 supports exactly one generic OIDC IdP per deployment** — configure a single
`OIDC_ISSUER` / client pair. Prefer a first-class provider (Okta, Keycloak, Auth0, …) when one
exists.

1. In your IdP, register a **confidential** OIDC / OAuth 2.0 client:
   - **Redirect URI / callback:** `{BETTER_AUTH_URL}/api/auth/oauth2/callback/oidc`
     (e.g. `http://localhost:3000/api/auth/oauth2/callback/oidc` for local dev)
   - **Grant:** Authorization code (with PKCE)
   - **Scopes:** at least `openid`, and typically `profile` + `email` (or set `OIDC_SCOPES`)
2. Copy the **Client ID** and **Client secret**.
3. Determine the issuer URL — the value that serves
   `{issuer}/.well-known/openid-configuration` (often the realm/tenant base URL; must match the
   `issuer` claim in id tokens).
4. Ensure the IdP emits `email`, `email_verified`, and ideally `name` / `preferred_username` /
   `sub` on the ID token.
5. Set the env vars:

```bash
OIDC_CLIENT_ID=<Client ID>
OIDC_CLIENT_SECRET=<Client secret>
OIDC_ISSUER=https://auth.example.com
# Optional: login button / admin card label (defaults to "OIDC")
# OIDC_DISPLAY_NAME=Authentik
# Optional: whitespace-separated scopes (defaults to openid profile email)
# OIDC_SCOPES=openid profile email
```

The sign-in flow discovers endpoints from `{OIDC_ISSUER}/.well-known/openid-configuration`,
uses PKCE, requests the configured scopes, and reads the IdP's native `email_verified` claim
(fail-closed — a missing or false claim is treated as unverified). All three required variables
must be set; setting only the client id and secret is *partial config* and boot / admin Validate
name `OIDC_ISSUER`. When the trio is complete, boot and admin Validate also **probe** discovery —
an unreachable or non-conformant issuer surfaces a clear error instead of a broken login page.

The same issuer / display name / scopes can also be set from **Admin → System Configuration**
(stored under `config.OIDC_*` and overlaid onto the env vars per OLO-8.5 / OLO-10.8).

## Auth0 — Regular Web Application (OLO-9.7)

1. In the [Auth0 Dashboard](https://manage.auth0.com/), go to **Applications → Applications →
   Create Application**.
2. Choose **Regular Web Applications**, then create.
3. On the **Settings** tab, configure:
   - **Allowed Callback URLs:** `{BETTER_AUTH_URL}/api/auth/oauth2/callback/auth0`
     (e.g. `http://localhost:3000/api/auth/oauth2/callback/auth0` for local dev)
   - **Allowed Logout URLs** / **Allowed Web Origins:** your app origin as needed
4. Copy the **Client ID** and **Client Secret**.
5. The tenant issuer is `https://{yourTenant}.auth0.com` (shown as **Domain** on Settings —
   prefix with `https://`). Custom domains use that hostname instead.
6. Set the env vars:

```bash
AUTH0_CLIENT_ID=<Client ID>
AUTH0_CLIENT_SECRET=<Client Secret>
AUTH0_ISSUER=https://acme.auth0.com
```

The sign-in flow discovers endpoints from `{AUTH0_ISSUER}/.well-known/openid-configuration`,
uses PKCE, requests the `openid email profile` scopes, and reads Auth0's native `email_verified`
claim (fail-closed — a missing or false claim is treated as unverified). All three variables are
required; setting only the client id and secret is *partial config* and boot / admin Validate name
`AUTH0_ISSUER`.

The same issuer can also be set from **Admin → System Configuration** (stored under
`config.AUTH0_ISSUER` and overlaid onto the env var per OLO-8.5 / OLO-10.8).

## LINE Login (OLO-9.41 — Japan / Taiwan / Thailand country MVP)

1. In the [LINE Developers Console](https://developers.line.biz/console/), create a **LINE Login**
   channel (or open an existing one).
2. On the channel **LINE Login** settings, set:
   - **Callback URL:** `{BETTER_AUTH_URL}/api/auth/oauth2/callback/line`
     (e.g. `http://localhost:3000/api/auth/oauth2/callback/line` for local dev)
3. Copy the **Channel ID** and **Channel secret**.
4. To receive the user's email, apply for **email address permission** under OpenID Connect on the
   channel's Basic settings. Until that permission is approved, LINE will not return an `email`
   claim even if the `email` scope is requested.
5. Set the env vars:

```bash
LINE_CLIENT_ID=<Channel ID>
LINE_CLIENT_SECRET=<Channel secret>
```

The sign-in flow uses LINE Login v2.1 fixed endpoints (`https://access.line.me/oauth2/v2.1/authorize`,
`https://api.line.me/oauth2/v2.1/token`, `https://api.line.me/oauth2/v2.1/userinfo`), PKCE, and the
`openid profile email` scopes. Prefer the ID token for profile claims; fall back to userinfo when
needed. **Email verified semantics:** when an `email_verified` claim arrives it is honored; when
the claim is absent or false the engine fail-closes (**link-first** — explicit link intent or an
already-bound identity). Missing email (permission not granted / user declined) surfaces
`email-required`.

### Multi-channel providerIds (JP / TW / TH)

LINE requires a **separate OAuth channel** per country/market (Japan, Taiwan, Thailand, …), each
with its own Channel ID and secret. Apiome's default registry entry uses a single `providerId`
of `line` with `LINE_CLIENT_ID` / `LINE_CLIENT_SECRET` — correct for a single-country deployment.

When one deployment must serve multiple LINE channels, mirror Better Auth's `line()` helper and
register distinct generic-OAuth configs (e.g. `line-jp`, `line-tw`, `line-th`) each with that
channel's credentials. Persist identities under those slugs; do not reuse a single `line` identity
across countries. Contact the platform team before enabling multi-channel — the DB vocabulary and
registry currently ship the single `line` slug (OLO-9.41); additional slug widenings land with
OLO-9.16 / follow-up tickets.

## VK ID (OLO-9.42 — Russia / CIS country MVP)

1. In the [VK ID Apps](https://id.vk.com/about/business/go/docs/en/vkid/latest/vk-id/connection/create-application)
   console, create an application (or open an existing one).
2. Set the **Redirect URI** to:
   - `{BETTER_AUTH_URL}/api/auth/oauth2/callback/vk`
     (e.g. `http://localhost:3000/api/auth/oauth2/callback/vk` for local dev)
3. Copy the **App ID** and **Secure key**.
4. Set the env vars:

```bash
VK_CLIENT_ID=<App ID>
VK_CLIENT_SECRET=<Secure key>
```

The sign-in flow uses fixed VK ID endpoints (`https://id.vk.com/authorize`,
`https://id.vk.com/oauth2/auth`, `https://id.vk.com/oauth2/user_info`), PKCE, and the
`email phone` scopes (mirroring Better Auth's `vk()` helper). User info is fetched via
**POST** form body (`access_token` + `client_id`). **Email verified semantics:** VK returns
email with the grant but does **not** assert a verified claim (Better Auth hard-codes
`emailVerified: false`). The engine always fail-closes (**link-first** — explicit link intent
or an already-bound identity). Missing email surfaces `email-required`.

### Hosting / compliance (RU / CIS)

VK is the country-MVP SSO provider for Russia / CIS. Prefer hosting Apiome in the
RU/CIS region when enabling VK so identity traffic and personal data stay aligned with local
compliance expectations. Enabling VK from a non-RU/CIS deployment is technically possible but
should be a deliberate operator choice.

## WeChat Open Platform (OLO-9.43 — China country MVP)

1. In the [WeChat Open Platform](https://open.weixin.qq.com/) console, create a **Website App**
   (网站应用) — the QR web login flow Apiome uses.
2. Set the **Authorized callback domain / redirect URI** to:
   - `{BETTER_AUTH_URL}/api/auth/oauth2/callback/wechat`
     (e.g. `http://localhost:3000/api/auth/oauth2/callback/wechat` for local dev)
3. Copy the **AppID** and **AppSecret**.
4. Set the env vars:

```bash
WECHAT_CLIENT_ID=<AppID>
WECHAT_CLIENT_SECRET=<AppSecret>
# Optional: QR page language (cn | en). Defaults to cn.
# WECHAT_LANG=en
```

The sign-in flow mirrors Better Auth's `wechat()` helper:

- Authorize: `https://open.weixin.qq.com/connect/qrconnect` (QR scan) with scope `snsapi_login`,
  credential param `appid`, and hash `#wechat_redirect`
- Token: GET `https://api.weixin.qq.com/sns/oauth2/access_token` with `appid` / `secret` / `code`
  (custom `getToken` — WeChat does not use a standard POST client_id exchange)
- User info: GET `https://api.weixin.qq.com/sns/userinfo` with `access_token` + `openid`

**Email / trust class:** WeChat exposes **no email address**. Sign-in is **link-only** — users must
already have an Apiome account and **explicitly link** WeChat from linked accounts; subsequent
sign-in works via the bound `(wechat, openid|unionid)` identity. Fresh sign-in without a prior link
is rejected with the structured `OAuthEmailRequired` code.

### UnionID (multi-app deployments)

WeChat issues an **openid** per app and, when the developer account has bound multiple apps under
the same open-platform subject, a stable **unionid** across those apps. Apiome keys the identity on
`unionid` when present, otherwise `openid` (matching Better Auth's `wechat()` helper). Prefer
binding every Apiome-related WeChat app under one open-platform account so the same person keeps a
single identity across environments; otherwise each app's openid is a separate identity and users
must re-link.

### Hosting / compliance (CN)

WeChat is the country-MVP SSO provider for China. Prefer hosting Apiome in the CN region when
enabling WeChat so identity traffic and personal data stay aligned with local compliance
expectations. Enabling WeChat from a non-CN deployment is technically possible but should be a
deliberate operator choice.

## Secrets handling

- Never commit client secrets — `.env` files are gitignored; the checked-in
  [`.env.example`](../.env.example) carries placeholders only.
- OAuth client secrets are server-side only: never expose them under a `NEXT_PUBLIC_`
  name.
- When rotating a **provider** secret, register the new secret in the provider console first, then
  update wherever Apiome holds it — the env var (and restart) or the admin screen's secret field
  (effective at the next login). Sessions already issued stay valid either way.
- A secret stored from the admin screen is written **encrypted**; the database never holds
  plaintext. See [Encryption at rest](#encryption-at-rest-and-key-rotation-auth_config_enc_key).
- Docker deployments: see [`.env.docker`](../.env.docker) and
  [`DOCKER_README.md`](./DOCKER_README.md) for where these variables are injected.

## Database provider config store (OLO-8.2, env-fallback)

The store behind the [precedence rule](#config-precedence--database-first-env-fallback): a
deployment can override provider config from the admin UI (OLO-8.4) without editing env and
restarting. The server-global table
`apiome.auth_provider_config` (migration **V196**, `apiome-db`) holds one row per provider
with an explicit `enabled` toggle, `client_id`, an envelope-encrypted `client_secret`
(ciphertext only — the DB never holds plaintext — with an `enc_key_id` for rotation,
OLO-8.3), and a `config` JSONB for provider extras (Azure tenant/authority, GitLab/GitHub
base URLs).

The store is layered **over** env, field by field:

- **No row** for a provider → it is governed entirely by env (the matrix above), unchanged.
- **A row with a `NULL` field** → that field falls back to env (e.g. `enabled = NULL` uses
  the env-derived enablement; `client_id = NULL` uses the env client id).
- **A row with a non-`NULL` field** → the stored value wins over env for that field.

The table is created empty and rows are written lazily on first save, so a fresh deployment
behaves exactly as if the store did not exist.

### Encryption at rest and key rotation (`AUTH_CONFIG_ENC_KEY`)

A plaintext secret in Postgres is strictly worse than one in an env var, so stored client secrets
are **envelope-encrypted** (OLO-8.3) and the key that protects them lives outside the database:

- a random per-secret **data-encryption key (DEK)** encrypts the secret with AES-256-GCM;
- a long-lived **key-encryption key (KEK)** from `AUTH_CONFIG_ENC_KEY` wraps that DEK;
- only the wrapped DEK, the ciphertext, and the non-secret `enc_key_id` are stored.

`AUTH_CONFIG_ENC_KEY` is read by **apiome-rest only** (the one process that seals and unseals
secrets); apiome-ui never sees it. It accepts two forms:

```bash
# Single key — the common case. Sealed under AUTH_CONFIG_ENC_ACTIVE_KEY_ID (default "default").
AUTH_CONFIG_ENC_KEY=<base64 32-byte key>

# Key map — several ids at once, for rotation without a flag day.
AUTH_CONFIG_ENC_KEY={"v1": "<base64 key>", "v2": "<base64 key>"}
AUTH_CONFIG_ENC_ACTIVE_KEY_ID=v2
```

Generate a key with `openssl rand -base64 32` (or
`python -c "import base64, os; print(base64.b64encode(os.urandom(32)).decode())"`). It must decode
to exactly 32 bytes; both standard and URL-safe base64 are accepted.

**When it is required.** Only for storing and reading *stored* secrets. An env-only deployment
never needs it. Without it:

- saving a client secret from the admin screen is refused (**503**) rather than stored in the clear;
- a row that already carries a sealed secret **fails loud** on the read path instead of silently
  falling back to the env secret — a wrong-OAuth-app sign-in is a worse outcome than a clear error.
  A provider with no stored secret still falls back to env normally.

A malformed key, or an active id with no matching key, fails **apiome-rest startup** rather than
surfacing at the first save.

**Rotating the KEK.** `enc_key_id` records which key sealed each row, and the id is bound into the
GCM additional-authenticated-data, so rows cannot be silently re-pointed at another key:

1. Switch to the map form and **add** the new key alongside the current one
   (`{"v1": "<old>", "v2": "<new>"}`). Keep `v1` — existing rows still need it.
2. Point `AUTH_CONFIG_ENC_ACTIVE_KEY_ID` at the new id (`v2`) and restart apiome-rest. New saves are
   sealed under `v2`; older rows stay readable under `v1`.
3. Re-seal the existing rows onto the active key (`reseal_provider_secret` in
   `apiome-rest/src/app/auth_provider_secret_crypto.py`; `needs_reseal` identifies the rows).
   Re-saving each provider's secret from the admin screen achieves the same thing by hand.
4. Only once no row references `v1` may it be dropped from the map. **Removing a KEK that still
   seals a row makes that secret unrecoverable** — the remedy is re-entering it from the provider's
   console.

Rotating the KEK does not touch the OAuth secrets themselves, so no provider console changes and no
user sessions are affected.

### Admin configuration screen (OLO-8.7)

The store is edited at **`/admin/dashboard/settings`** ("System Configuration" in the admin
sidebar), behind the signed super-admin session (OLO-8.1). The screen shows one card per
provider with an enablement control (**Enabled / Disabled / Use .env**, mapping to
`true`/`false`/`NULL`), the client id, a **write-only** secret field (only "set / not set" is
ever shown), and the provider extras above. Every field that has no DB value carries a
"using .env fallback" badge, and a **Validate** button reports whether the DB row is complete
enough to enable. Forcing a provider **Enabled** requires its client id *and* secret to be
stored in the DB (env values do not count toward that check); saves take effect at the next
login without a restart (OLO-8.5/8.6).

#### How the screen relates to `.env.example`

The screen and the env template describe the **same fields**, one per row of the
[matrix above](#environment-variable-matrix) — they are two ways to supply one contract, not two
contracts:

| | `.env` / `.env.example` | Admin → System Configuration |
|---|---|---|
| Precedence | fallback | **wins**, field by field |
| Applies | at restart | at the next login |
| Scope | that one host's process | every server sharing the database |
| Secret at rest | plaintext in the env/secret store | envelope-encrypted (`AUTH_CONFIG_ENC_KEY`) |
| Needs | nothing | `INTERNAL_SERVICE_TOKEN` on both sides, plus the KEK for secrets |
| Good for | local dev, bootstrap, single-host deploys | multi-server deploys, rotating creds without a redeploy |

Provider extras keep their **env-var names** as their keys inside the stored `config` JSONB
(`OKTA_ISSUER`, `GITLAB_BASE_URL`, `AZURE_AD_TENANT`, …), so a field is named identically in both
places and the template doubles as the field reference for the screen. A field with no stored value
shows a **"using .env fallback"** badge, which is the screen's live read of exactly this precedence.

#### Removing a provider

A card's **Remove** button deletes that provider's whole `auth_provider_config` row, returning it
to the env-only behaviour described above — the card disappears and the provider is offered again
in **Add Provider**. It is confirmed inline first, because unlike every other control on the card
it cannot be undone: **the encrypted client secret is destroyed with the row**, and re-configuring
the provider means re-entering it from the provider's console.

Removal is not the same as clearing fields individually:

- **Clear stored secret** (on the secret field) drops only the secret; the row, client id, extras,
  and any `enabled` override remain.
- **Remove** drops everything, including the `enabled` override — so a provider that was forced on
  from the DB reverts to env-derived enablement, which may turn its login button off.

Like a save, a removal takes effect at the next login without a restart. If the provider's
credentials are also present in `.env`, sign-in keeps working from those; if they are not, the
provider disappears from the login page.

## Test-only endpoint overrides (OLO-7.4)

The end-to-end journey suite (`e2e/journey/`, #4226) points every provider at a local
mock server via base-URL override env vars:

| Variable | Overrides | Production default |
| --- | --- | --- |
| `GITHUB_OAUTH_BASE_URL` | GitHub authorize/token endpoints | `https://github.com` |
| `GITHUB_API_BASE_URL` | GitHub `/user` + `/user/emails` API | `https://api.github.com` |
| `GITLAB_BASE_URL` | GitLab authorize/token/userinfo | `https://gitlab.com` |
| `AZURE_AD_AUTHORITY_BASE_URL` | Entra ID OIDC discovery authority | `https://login.microsoftonline.com` |
| `GOOGLE_ISSUER` | Google OIDC discovery issuer | `https://accounts.google.com` |

`OKTA_ISSUER`, `COGNITO_ISSUER`, `KEYCLOAK_ISSUER`, `OIDC_ISSUER`, and `AUTH0_ISSUER` are
**required** production config vars (not test-only overrides) — see the
[Okta](#okta--oidc-application-workforce-idp),
[Cognito](#amazon-cognito--user-pool--hosted-ui-olo-94),
[Keycloak](#keycloak--realm-oidc-client-olo-95),
[Generic OIDC](#generic-oidc--any-conformant-openid-provider-olo-96), and
[Auth0](#auth0--regular-web-application-olo-97),
[LINE](#line-login-olo-941--japan--taiwan--thailand-country-mvp),
[VK](#vk-id-olo-942--russia--cis-country-mvp), and
[WeChat](#wechat-open-platform-olo-943--china-country-mvp) sections. Pointing any of them
at a mock issuer for the e2e journey is fine in test; never point a real deployment's issuer at a
non-provider host.

**Never set the GitHub / GitLab / Azure authority / Google issuer overrides in a real deployment** —
they redirect the entire sign-in flow to the named host. Unset (the default) the real provider
endpoints are used; the boot-time validation matrix above is unaffected by them.

## Two-factor email OTP (OLO-9.50)

Email OTP is an alternate **login** second factor once a user has 2FA enabled (TOTP enroll). It is
**not** a separate per-user enrollment: Better Auth registers `otpOptions.sendOTP` at the server
level when both env vars are set.

| Variable | Required | Purpose |
|---|---|---|
| `SENDGRID_API_KEY` | To enable email OTP | SendGrid API key |
| `EMAIL_FROM` | To enable email OTP | Verified sender address |

Unset either variable → credential 2FA stays TOTP-only (`twoFactorMethods` will not include `otp`).
