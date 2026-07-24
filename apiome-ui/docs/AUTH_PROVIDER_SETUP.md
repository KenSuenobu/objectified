# Sign-in Provider Setup & Secrets Guide (OLO-7.2)

How to register the OAuth applications Apiome signs users in with (GitHub, GitLab,
Microsoft Entra ID, Google Workspace), which environment variables each provider needs, and how
boot-time validation reacts when a provider is misconfigured.

The single source of truth for the provider list and each provider's env contract is the
provider registry: [`lib/auth/provider-registry.ts`](../lib/auth/provider-registry.ts)
(OLO-2.3). A provider is **enabled** only when *all* of its required env vars are set and
non-blank; unsetting them all **cleanly disables** it everywhere at once (login button,
linked-accounts panel, Better Auth sign-in route). No code changes are needed either way.

## Environment variable matrix

| Variable | Provider / scope | Required | Purpose |
|---|---|---|---|
| `NEXTAUTH_URL` | all | Yes | Public base URL of the app; every OAuth callback URL below derives from it (also the default Better Auth base URL; keeps its historical `NEXTAUTH_` name) |
| `NEXTAUTH_SECRET` | all | Yes | Shared signing secret for the Better Auth session and the downstream REST JWT (`openssl rand -base64 32`; keeps its historical name) |
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
an env var. Today every provider requires exactly a **client id** and a **client secret**, but
the model also supports fields that live in a provider's `config` extras — notably an OIDC
**issuer**/**domain** URL that issuer-based providers (Okta, Cognito, Keycloak, Auth0, generic
OIDC) need before their sign-in factory can be built. When such an entry ships, its issuer env
var joins the trio: setting the id and secret but leaving the issuer unset is *partial config*
and boot-time validation names the missing issuer var, exactly as it does for a missing secret.
In the admin settings screen the same field is required before the provider can be enabled from
the database (the issuer is stored in the `config` JSONB and overlaid onto its env var).

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
   - **Homepage URL:** your `NEXTAUTH_URL`, e.g. `https://app.apiome.app`
   - **Authorization callback URL:** `{NEXTAUTH_URL}/api/auth/oauth2/callback/github`
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
   - **Redirect URI:** `{NEXTAUTH_URL}/api/auth/oauth2/callback/gitlab`
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
   - **Redirect URI:** platform **Web**, value `{NEXTAUTH_URL}/api/auth/oauth2/callback/azure`
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
   - **Authorized redirect URI:** `{NEXTAUTH_URL}/api/auth/oauth2/callback/google`
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

**Never set these in a real deployment** — they redirect the entire sign-in flow to the
named host. Unset (the default) the real provider endpoints are used; the boot-time
validation matrix above is unaffected by them.
