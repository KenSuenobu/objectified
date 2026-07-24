# Sign-in Provider Setup & Secrets Guide (OLO-7.2)

How to register the OAuth applications Apiome signs users in with (GitHub, GitLab,
Microsoft Entra ID, Google Workspace, Okta, Amazon Cognito, Keycloak, generic OIDC), which
environment variables each provider needs, and how boot-time validation reacts when a provider is
misconfigured.

The single source of truth for the provider list and each provider's env contract is the
provider registry: [`lib/auth/provider-registry.ts`](../lib/auth/provider-registry.ts)
(OLO-2.3). A provider is **enabled** only when *all* of its required env vars are set and
non-blank; unsetting them all **cleanly disables** it everywhere at once (login button,
linked-accounts panel, Better Auth sign-in route). No code changes are needed either way.

## Environment variable matrix

| Variable | Provider / scope | Required | Purpose |
|---|---|---|---|
| `BETTER_AUTH_URL` | all | Yes | Public base URL of the app; every OAuth callback URL below derives from it |
| `BETTER_AUTH_SECRET` | all | Yes | Shared signing secret for the Better Auth session and the downstream REST JWT (`openssl rand -base64 32`) |
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
| `AUTH_PROVIDER_VALIDATION` | validation | No (default `strict`) | `strict` fails startup on partial provider config; `warn` logs and disables |

Rules that apply to every provider:

- Blank or whitespace-only values count as **unset** — a commented-template line like
  `GITHUB_ID=` does not enable a provider.
- **All vars set** → provider enabled. **No vars set** → provider cleanly disabled. Both are
  valid deployments.
- **Some-but-not-all set** → misconfiguration; see
  [Boot-time validation](#boot-time-validation) below.

### Required fields beyond client id/secret (OLO-9.1)

A registry entry declares its required fields structurally (`requiredFields`), each mapped to
an env var. Most providers require exactly a **client id** and a **client secret**. Issuer-based
providers (Okta, Cognito, Keycloak, generic OIDC today; Auth0 as it ships) additionally
require an OIDC **issuer** URL stored in the provider's `config` extras. Setting the id and secret
but leaving the issuer unset is *partial config* and boot-time validation names the missing issuer
var, exactly as it does for a missing secret. In the admin settings screen the same field is
required before the provider can be enabled from the database (the issuer is stored in the
`config` JSONB and overlaid onto its env var). For generic OIDC, a fully configured issuer is also
**probed** at boot and on admin Validate (`GET <issuer>/.well-known/openid-configuration`) so a bad
or unreachable IdP fails loud instead of leaving a broken login page.

## Boot-time validation

At server startup ([`src/instrumentation.ts`](../src/instrumentation.ts) →
`validateProviderEnv()`), every provider's env contract is checked. A *partially*
configured provider — e.g. `GITHUB_ID` set but `GITHUB_SECRET` missing, typically a typo'd
var name or a secret that never reached the deployment — is reported per
`AUTH_PROVIDER_VALIDATION`:

- **`strict`** (default): startup **fails** with one actionable message per issue, naming
  the missing and present vars and both ways to resolve (set them all, or unset them all).
  Misconfiguration fails loud at boot, not silently at first login.
- **`warn`**: each issue is logged via `console.warn` and the provider stays **cleanly
  disabled** (a provider missing any required var is never registered as a sign-in provider).

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

## GitHub — OAuth app

1. Go to **GitHub → Settings → Developer settings → OAuth Apps** (org-owned apps: the org's
   **Settings → Developer settings**) and click **New OAuth App**.
2. Fill in:
   - **Application name:** `Apiome` (or your deployment's name)
   - **Homepage URL:** your `BETTER_AUTH_URL`, e.g. `https://app.apiome.app`
   - **Authorization callback URL:** `{BETTER_AUTH_URL}/api/auth/oauth2/callback/github`
     (e.g. `http://localhost:3000/api/auth/oauth2/callback/github` for local dev)
3. Click **Register application**, then **Generate a new client secret**. Copy the secret
   immediately — GitHub shows it only once.
4. Set the env vars:

```bash
GITHUB_ID=<Client ID>
GITHUB_SECRET=<Client secret>
```

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

## Secrets handling

- Never commit client secrets — `.env` files are gitignored; the checked-in
  [`.env.example`](../.env.example) carries placeholders only.
- OAuth client secrets are server-side only: never expose them under a `NEXT_PUBLIC_`
  name.
- When rotating a secret, register the new secret in the provider console first, then
  update the env var and restart — sessions already issued stay valid.
- Docker deployments: see [`.env.docker`](../.env.docker) and
  [`DOCKER_README.md`](./DOCKER_README.md) for where these variables are injected.

## Database provider config store (OLO-8.2, env-fallback)

Env vars are the baseline. A deployment can additionally override provider config from the
admin UI (OLO-8.4) without editing env and restarting: the server-global table
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

`OKTA_ISSUER`, `COGNITO_ISSUER`, `KEYCLOAK_ISSUER`, and `OIDC_ISSUER` are **required** production
config vars (not test-only overrides) — see the [Okta](#okta--oidc-application-workforce-idp),
[Cognito](#amazon-cognito--user-pool--hosted-ui-olo-94),
[Keycloak](#keycloak--realm-oidc-client-olo-95), and
[Generic OIDC](#generic-oidc--any-conformant-openid-provider-olo-96) sections. Pointing any of them
at a mock issuer for the e2e journey is fine in test; never point a real deployment's issuer at a
non-provider host.

**Never set the GitHub / GitLab / Azure authority / Google issuer overrides in a real deployment** —
they redirect the entire sign-in flow to the named host. Unset (the default) the real provider
endpoints are used; the boot-time validation matrix above is unaffected by them.
