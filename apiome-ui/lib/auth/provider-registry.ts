/**
 * OAuth provider registry & deploy config (OLO-2.3, #4195).
 *
 * The single surface describing which sign-in providers exist and which are enabled in this
 * deployment. A provider is *enabled* purely from config (every required key resolves to a
 * non-blank value) — no code changes are needed to add or remove a provider from a deployment.
 * This module reads that config through one injectable `env` map: `process.env` historically, and
 * since OLO-8.5 the **DB-over-env overlay** (`provider-config-resolver.resolveProviderEnv`) — stored
 * admin-screen config first, `.env` as the fallback. Everything below is written against the merged
 * map, so precedence lives in one place and never has to be repeated per consumer.
 *
 * Consumers:
 *   - the Better Auth generic-OAuth provider set registers exactly the enabled providers
 *     (`better-auth-oauth-providers.ts` → the `/api/auth/[...all]` route);
 *   - the login page renders one SSO button per enabled provider (OLO-3.1, `login/page.tsx`);
 *   - the linked-accounts panel offers exactly the enabled providers for linking (OLO-2.4);
 *   - the signup-intent and link routes refuse providers that are not enabled;
 *   - setup docs list each provider's env contract (OLO-7.2, `docs/AUTH_PROVIDER_SETUP.md`);
 *   - boot-time validation (`validateProviderEnv`, called from `src/instrumentation.ts`)
 *     fails startup — or warns, per `AUTH_PROVIDER_VALIDATION` — when a provider's config is
 *     only partially set (OLO-7.2), reading the merged DB-over-env overlay so a provider
 *     configured from the admin screen is not flagged as "missing env" (OLO-8.8).
 *
 * Adding a provider later (Atlassian #4991, Bitbucket #4992, …) means: one entry here, one
 * generic-OAuth config in `better-auth-oauth-providers.ts`, one brand icon in
 * `src/app/components/auth/provider-brand.tsx` — no archaeology across surfaces. Google Workspace
 * (OLO-9.2), Okta (OLO-9.3), Cognito (OLO-9.4), Keycloak (OLO-9.5), generic OIDC (OLO-9.6), and
 * Auth0 (OLO-9.7) followed exactly that path.
 *
 * This module is intentionally free of React and auth-engine imports so both server code
 * (routes, server components) and client components can import it.
 */

/**
 * Lifecycle of a registry entry:
 *   - `available`: implemented end-to-end; enabled whenever its env vars are configured.
 *   - `coming-soon`: advertised on the linked-accounts panel as a roadmap teaser, but never
 *     enabled regardless of env (no NextAuth factory exists for it yet).
 */
export type ProviderStatus = 'available' | 'coming-soon';

/**
 * Where a required field's value lives in the stored provider config (OLO-9.1) — the fact the
 * REST completeness check (OLO-8.4) needs to know which DB location proves a field present:
 *   - `client_id`: the `auth_provider_config.client_id` column;
 *   - `client_secret`: the sealed secret (the `enc_key_id`/ciphertext pair);
 *   - `config`: a key inside the `config` JSONB extras (e.g. an Okta/Auth0 `issuer` URL). The
 *     merge resolver (OLO-8.5) overlays such a key onto its env var of the same name.
 */
export type RequiredFieldKind = 'client_id' | 'client_secret' | 'config';

/**
 * One field a provider requires to be enabled (OLO-9.1). Historically every provider required
 * exactly `client_id` + `client_secret`; issuer-based providers (Okta, Cognito, Keycloak, Auth0,
 * generic OIDC — OLO-9.3–9.7) additionally require an `issuer`/`domain` URL, expressed here as a
 * `config`-kind field. Each field maps to an env var (boot validation + the OLO-8.5 overlay) and,
 * for `config`-kind fields, to the same-named key inside the `config` JSONB.
 */
export interface RequiredField {
  /**
   * Semantic field name — `client_id`, `client_secret`, `issuer`, … . Surfaced (for `config`
   * fields) in the admin completeness list, so it stays human-meaningful rather than an env-var.
   */
  field: string;
  /** Which stored location proves the field present — see {@link RequiredFieldKind}. */
  kind: RequiredFieldKind;
  /**
   * The env var this field maps to: read at boot ({@link providerEnvIssues}) and overlaid by the
   * OLO-8.5 merge resolver. For a `config`-kind field this is *also* its key inside the `config`
   * JSONB (extras are env-var-keyed), so `OKTA_ISSUER` set in env or stored under
   * `config.OKTA_ISSUER` both satisfy it.
   */
  envKey: string;
}

/**
 * A sign-in provider this codebase knows about (enabled or not).
 *
 * `requiredFields` is the single source of truth; `requiredEnvKeys` is derived from it at registry
 * construction (see {@link buildRegistry}) so the boot-validation/enablement consumers that read a
 * flat env-var list keep working unchanged while the richer per-field mapping stays available.
 */
export interface ProviderDescriptor {
  /**
   * The provider slug — NextAuth provider id AND the value stored in
   * `external_auth_providers.provider` (the OLO-2.2 vocabulary). Never rename an id:
   * persisted identities and the account-resolution gates match on it.
   */
  id: string;
  /** Human-readable name used on buttons and cards ("Continue with {label}"). */
  label: string;
  /** Implementation status — see {@link ProviderStatus}. */
  status: ProviderStatus;
  /**
   * Every field that must be present for the provider to be enabled, in display order.
   * Empty for `coming-soon` entries (nothing can enable them). See {@link RequiredField}.
   */
  requiredFields: readonly RequiredField[];
  /**
   * Env vars that must all be set and non-blank for the provider to be enabled — the env-var of
   * each {@link requiredFields} entry, in order. Derived; do not set directly (see
   * {@link buildRegistry}).
   */
  requiredEnvKeys: readonly string[];
}

/**
 * The client id + client secret every OAuth provider requires, as the standard pair of required
 * fields. Providers add issuer/domain fields on top of this (OLO-9.1); `coming-soon` entries pass
 * `[]` instead (nothing can enable them).
 *
 * @param clientIdEnvKey Env var holding the OAuth client id (e.g. `GITHUB_ID`).
 * @param clientSecretEnvKey Env var holding the OAuth client secret (e.g. `GITHUB_SECRET`).
 * @returns The two-field `[client_id, client_secret]` requirement list.
 */
export function clientCredentialFields(
  clientIdEnvKey: string,
  clientSecretEnvKey: string
): RequiredField[] {
  return [
    { field: 'client_id', kind: 'client_id', envKey: clientIdEnvKey },
    { field: 'client_secret', kind: 'client_secret', envKey: clientSecretEnvKey },
  ];
}

/**
 * Finish a registry entry by deriving its `requiredEnvKeys` from `requiredFields`, keeping the two
 * from ever drifting within an entry.
 *
 * @param entry The descriptor minus its derived `requiredEnvKeys`.
 * @returns The full {@link ProviderDescriptor}.
 */
function buildDescriptor(entry: Omit<ProviderDescriptor, 'requiredEnvKeys'>): ProviderDescriptor {
  return { ...entry, requiredEnvKeys: entry.requiredFields.map((f) => f.envKey) };
}

/**
 * Serializable projection of a descriptor plus its enabled state, safe to pass from a server
 * component to a client component (React component props must be serializable, so the brand
 * icon is resolved client-side from the id — see `provider-brand.tsx`).
 */
export interface ProviderSummary {
  id: string;
  label: string;
  status: ProviderStatus;
  /** True when this deployment's env enables the provider. */
  enabled: boolean;
}

/**
 * Every provider this codebase knows about, in display order.
 *
 * `azure` is Microsoft Entra ID (OLO-2.1) — its env contract is shared with
 * `entra-provider.ts`, which delegates its config check here so the two can never drift.
 */
const PROVIDER_REGISTRY_ENTRIES: readonly Omit<ProviderDescriptor, 'requiredEnvKeys'>[] = [
  {
    id: 'github',
    label: 'GitHub',
    status: 'available',
    requiredFields: clientCredentialFields('GITHUB_ID', 'GITHUB_SECRET'),
  },
  {
    id: 'gitlab',
    label: 'GitLab',
    status: 'available',
    requiredFields: clientCredentialFields('GITLAB_CLIENT_ID', 'GITLAB_CLIENT_SECRET'),
  },
  {
    id: 'azure',
    label: 'Microsoft',
    status: 'available',
    requiredFields: clientCredentialFields('AZURE_AD_CLIENT_ID', 'AZURE_AD_CLIENT_SECRET'),
  },
  {
    id: 'google',
    label: 'Google',
    status: 'available',
    requiredFields: clientCredentialFields('GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'),
  },
  {
    id: 'okta',
    label: 'Okta',
    status: 'available',
    // Issuer-based (OLO-9.3): client credentials plus the Okta org/authorization-server issuer URL
    // stored in config JSONB under OKTA_ISSUER (OLO-9.1).
    requiredFields: [
      ...clientCredentialFields('OKTA_CLIENT_ID', 'OKTA_CLIENT_SECRET'),
      { field: 'issuer', kind: 'config', envKey: 'OKTA_ISSUER' },
    ],
  },
  {
    id: 'aws',
    label: 'AWS',
    status: 'available',
    // Issuer-based Cognito (OLO-9.4): client credentials plus the user-pool issuer URL stored in
    // config JSONB under COGNITO_ISSUER (OLO-9.1). Form:
    // `https://cognito-idp.<region>.amazonaws.com/<userPoolId>`.
    requiredFields: [
      ...clientCredentialFields('COGNITO_CLIENT_ID', 'COGNITO_CLIENT_SECRET'),
      { field: 'issuer', kind: 'config', envKey: 'COGNITO_ISSUER' },
    ],
  },
  {
    id: 'keycloak',
    label: 'Keycloak',
    status: 'available',
    // Issuer-based (OLO-9.5): client credentials plus the realm issuer URL stored in config JSONB
    // under KEYCLOAK_ISSUER (OLO-9.1). Form: `https://kc.example.com/realms/<realm>`.
    requiredFields: [
      ...clientCredentialFields('KEYCLOAK_CLIENT_ID', 'KEYCLOAK_CLIENT_SECRET'),
      { field: 'issuer', kind: 'config', envKey: 'KEYCLOAK_ISSUER' },
    ],
  },
  {
    id: 'oidc',
    label: 'OIDC',
    status: 'available',
    // Catch-all OIDC (OLO-9.6): client credentials plus the IdP issuer URL stored in config JSONB
    // under OIDC_ISSUER (OLO-9.1). Optional OIDC_DISPLAY_NAME / OIDC_SCOPES are extras, not required.
    // v1: exactly one generic OIDC IdP per deployment.
    requiredFields: [
      ...clientCredentialFields('OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET'),
      { field: 'issuer', kind: 'config', envKey: 'OIDC_ISSUER' },
    ],
  },
  {
    id: 'auth0',
    label: 'Auth0',
    status: 'available',
    // Issuer-based (OLO-9.7): client credentials plus the Auth0 tenant issuer URL stored in
    // config JSONB under AUTH0_ISSUER (OLO-9.1). Form: `https://<tenant>.auth0.com`.
    requiredFields: [
      ...clientCredentialFields('AUTH0_CLIENT_ID', 'AUTH0_CLIENT_SECRET'),
      { field: 'issuer', kind: 'config', envKey: 'AUTH0_ISSUER' },
    ],
  },
  {
    id: 'line',
    label: 'LINE',
    status: 'available',
    // LINE Login (OLO-9.41, #5054): credentials only. Email requires an approved channel
    // permission; `email_verified` is honored when present, otherwise fail-closed link-first.
    // Multi-channel JP/TW/TH setups use distinct providerIds — see AUTH_PROVIDER_SETUP.md.
    requiredFields: clientCredentialFields('LINE_CLIENT_ID', 'LINE_CLIENT_SECRET'),
  },
  {
    id: 'vk',
    label: 'VK',
    status: 'available',
    // VK ID (OLO-9.42, #5055): credentials only. Email arrives with the grant but VK ID does not
    // assert a verified claim → fail-closed link-first (Better Auth `vk()` hard-codes
    // emailVerified: false). Country MVP for Russia / CIS — see AUTH_PROVIDER_SETUP.md.
    requiredFields: clientCredentialFields('VK_CLIENT_ID', 'VK_CLIENT_SECRET'),
  },
  {
    id: 'wechat',
    label: 'WeChat',
    status: 'available',
    // WeChat Open Platform Website App (OLO-9.43, #5056): credentials only. QR web login
    // (`snsapi_login`) exposes openid/unionid and **no email** → link-only. Country MVP for
    // China — see AUTH_PROVIDER_SETUP.md (unionid for multi-app deployments).
    requiredFields: clientCredentialFields('WECHAT_CLIENT_ID', 'WECHAT_CLIENT_SECRET'),
  },
];

export const PROVIDER_REGISTRY: readonly ProviderDescriptor[] =
  PROVIDER_REGISTRY_ENTRIES.map(buildDescriptor);

/**
 * Read a trimmed env string, or null when unset/blank.
 *
 * Blank ("" or whitespace) counts as unset so a commented-template value like
 * `GITHUB_ID=` does not accidentally enable a provider.
 *
 * @param env Environment map to read.
 * @param key Env var name.
 * @returns The trimmed value, or null when unset or blank.
 */
export function readEnvString(
  env: Record<string, string | undefined>,
  key: string
): string | null {
  const raw = env[key];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Look up a registry entry by provider id.
 *
 * @param id Provider slug (e.g. `github`).
 * @returns The descriptor, or undefined for ids the registry does not know.
 */
export function getProviderDescriptor(id: string): ProviderDescriptor | undefined {
  return PROVIDER_REGISTRY.find((provider) => provider.id === id);
}

/**
 * Whether this deployment enables a provider.
 *
 * True only when the provider exists in the registry, is `available`, and every required env
 * var is set and non-blank. Unknown ids and `coming-soon` entries are never enabled.
 *
 * @param id Provider slug.
 * @param env Environment to read (injectable for tests; defaults to `process.env`).
 * @returns True when the provider should appear on every sign-in/link surface.
 */
export function isProviderEnabled(
  id: string,
  env: Record<string, string | undefined> = process.env
): boolean {
  const descriptor = getProviderDescriptor(id);
  if (!descriptor || descriptor.status !== 'available') return false;
  return descriptor.requiredEnvKeys.every((key) => readEnvString(env, key) !== null);
}

/**
 * The enabled providers, in display order.
 *
 * @param env Environment to read (injectable for tests; defaults to `process.env`).
 * @returns Descriptors of every enabled provider.
 */
export function enabledProviders(
  env: Record<string, string | undefined> = process.env
): ProviderDescriptor[] {
  return PROVIDER_REGISTRY.filter((provider) => isProviderEnabled(provider.id, env));
}

/**
 * Ids of the enabled providers, in display order.
 *
 * @param env Environment to read (injectable for tests; defaults to `process.env`).
 * @returns Provider slugs (e.g. `['github', 'gitlab']`).
 */
export function enabledProviderIds(
  env: Record<string, string | undefined> = process.env
): string[] {
  return enabledProviders(env).map((provider) => provider.id);
}

/**
 * Serializable summaries of every registry entry with its enabled state — the shape server
 * components pass to client components (login page, linked-accounts panel).
 *
 * @param env Environment to read (injectable for tests; defaults to `process.env`).
 * @returns One summary per registry entry, in display order.
 */
export function providerSummaries(
  env: Record<string, string | undefined> = process.env
): ProviderSummary[] {
  return PROVIDER_REGISTRY.map((provider) => {
    // Generic OIDC (OLO-9.6): operator-set OIDC_DISPLAY_NAME overrides the login-button label.
    const displayOverride =
      provider.id === 'oidc' ? readEnvString(env, 'OIDC_DISPLAY_NAME') : null;
    return {
      id: provider.id,
      label: displayOverride ?? provider.label,
      status: provider.status,
      enabled: isProviderEnabled(provider.id, env),
    };
  });
}

/* ── Boot-time env validation (OLO-7.2, #4224) ──────────────────────────────────────────── */

/**
 * How boot-time validation reacts to a partially-configured provider:
 *   - `strict` (default): the server refuses to start — misconfiguration fails loud at boot,
 *     not silently at first login.
 *   - `warn`: the issue is logged and the provider stays cleanly disabled (a provider with
 *     any required env var missing is never enabled — see {@link isProviderEnabled}).
 */
export type ProviderValidationMode = 'strict' | 'warn';

/** Env var selecting the {@link ProviderValidationMode}. */
export const PROVIDER_VALIDATION_ENV_KEY = 'AUTH_PROVIDER_VALIDATION';

/** Setup guide referenced by every validation message. */
const SETUP_DOC = 'apiome-ui/docs/AUTH_PROVIDER_SETUP.md';

/** The admin screen that writes the DB provider config, named in DB-aware validation messages. */
const ADMIN_CONFIG_SCREEN = 'Admin → System Configuration (/admin/dashboard/settings)';

/**
 * Where the config being validated came from (OLO-8.8, #4974).
 *
 * Since OLO-8.5 provider config is **DB-first with env fallback**: the env map handed to validation
 * is a merged overlay, not raw `process.env`. Validation must know which it is, because the same
 * "some vars set, some not" picture means different things per origin. Mirrors
 * `provider-config-resolver.ProviderConfigSource`, which produces the value; kept as its own type so
 * this module stays free of server-only imports and remains client-importable.
 *
 *   - `env-only`: no DB source configured (`INTERNAL_SERVICE_TOKEN` unset). Env is the whole truth,
 *     so a partially-configured provider is operator error — validate exactly as before OLO-8.5.
 *   - `db`: the merged overlay includes the stored config. A provider satisfied from the database is
 *     complete and is **not** flagged; one still partial after the merge is genuinely partial, and
 *     its message names the admin screen as well as the env vars.
 *   - `unavailable`: a DB source is configured but could not be read. The merged env may be missing
 *     values that *are* stored, so a "partial" provider is unproven — never fail startup on it.
 */
export type ProviderConfigOrigin = 'env-only' | 'db' | 'unavailable';

/** A provider that is partially configured (some, but not all, required fields resolve). */
export interface ProviderEnvIssue {
  /** Provider slug (e.g. `github`). */
  providerId: string;
  /** Human-readable provider name (e.g. `GitHub`). */
  label: string;
  /** Required keys that resolved to a set, non-blank value (from either source). */
  presentKeys: string[];
  /** Required keys that resolved to nothing — unset or blank in every source consulted. */
  missingKeys: string[];
  /** Which config source the issue was computed against — see {@link ProviderConfigOrigin}. */
  origin: ProviderConfigOrigin;
  /** Actionable, operator-facing description of the problem and both ways to fix it. */
  message: string;
}

/**
 * Compose the operator-facing message for one partially-configured provider.
 *
 * The wording tracks the config origin, because the *same* set of missing keys means something
 * different per source (OLO-8.8): with no DB source the env vars are the only place a value can
 * live; with one, the admin screen is an equally valid — and higher-precedence — home for it; and
 * when the DB source is unreachable the finding itself may be a false alarm.
 *
 * @param provider The registry entry — supplies the name, slug, and full required-key list.
 * @param presentKeys Required keys that resolved to a value.
 * @param missingKeys Required keys that did not.
 * @param origin Where the config being validated came from.
 * @returns A single-sentence-per-clause message naming the problem and every way to resolve it.
 */
function partialConfigMessage(
  provider: ProviderDescriptor,
  presentKeys: string[],
  missingKeys: string[],
  origin: ProviderConfigOrigin
): string {
  const { id, label, requiredEnvKeys } = provider;
  const missingIs = missingKeys.length === 1 ? 'is' : 'are';
  const presentIs = presentKeys.length === 1 ? 'is' : 'are';
  const missingClause =
    origin === 'db'
      ? `${missingKeys.join(', ')} ${missingIs} unset or blank in both the stored provider ` +
        'config and env'
      : origin === 'unavailable'
        ? `${missingKeys.join(', ')} ${missingIs} unset or blank in env, and the stored provider ` +
          'config could not be read'
        : `${missingKeys.join(', ')} ${missingIs} unset or blank`;
  const resolution =
    origin === 'env-only'
      ? `Set all of ${requiredEnvKeys.join(', ')} to enable ${label} sign-in, ` +
        'or unset all of them to disable it.'
      : `Set all of ${requiredEnvKeys.join(', ')} — in ${ADMIN_CONFIG_SCREEN}, which takes ` +
        `precedence, or in env — to enable ${label} sign-in, or clear all of them to disable it.`;
  const caveat =
    origin === 'unavailable'
      ? ` This may be a false alarm: ${label} may already be fully configured in the database.`
      : '';
  return (
    `Sign-in provider '${label}' (${id}) is partially configured: ` +
    `${missingClause} while ${presentKeys.join(', ')} ${presentIs} set. ` +
    `${resolution}${caveat} Setup guide: ${SETUP_DOC}`
  );
}

/**
 * Find every partially-configured provider.
 *
 * A provider with all required vars set is enabled; one with none set is cleanly disabled —
 * both are valid deployments. Some-but-not-all is always operator error (a typo'd var name,
 * a secret that never landed), so each such provider yields one issue.
 *
 * A required field that lives in the `config` JSONB (e.g. an OIDC `issuer`) is validated at boot
 * through its env var exactly like a client id/secret: with the trio `id + secret + issuer`, a
 * deployment that sets the id and secret but leaves the issuer env var unset is partial config and
 * the missing issuer var is named (OLO-9.1 acceptance).
 *
 * Since OLO-8.5, `env` is normally the **merged** DB-over-env overlay rather than raw `process.env`
 * (`provider-config-resolver.resolveProviderEnv`), so a provider whose credentials live only in the
 * database reads as fully configured here and yields no issue — the OLO-8.8 acceptance criterion.
 * `origin` does not change *which* providers are flagged (the merged env already decides that); it
 * only makes each message name the right places a value can live.
 *
 * @param env Environment to read (injectable for tests; defaults to `process.env`).
 * @param registry Registry to validate (injectable for tests; defaults to {@link PROVIDER_REGISTRY}).
 * @param origin Where `env` came from (defaults to `env-only`, the pre-OLO-8.5 behaviour).
 * @returns One issue per partially-configured provider, in registry display order.
 */
export function providerEnvIssues(
  env: Record<string, string | undefined> = process.env,
  registry: readonly ProviderDescriptor[] = PROVIDER_REGISTRY,
  origin: ProviderConfigOrigin = 'env-only'
): ProviderEnvIssue[] {
  const issues: ProviderEnvIssue[] = [];
  for (const provider of registry) {
    const { id, label, status, requiredEnvKeys } = provider;
    if (status !== 'available' || requiredEnvKeys.length === 0) continue;
    const presentKeys = requiredEnvKeys.filter((key) => readEnvString(env, key) !== null);
    const missingKeys = requiredEnvKeys.filter((key) => readEnvString(env, key) === null);
    if (presentKeys.length === 0 || missingKeys.length === 0) continue;
    issues.push({
      providerId: id,
      label,
      presentKeys,
      missingKeys,
      origin,
      message: partialConfigMessage(provider, presentKeys, missingKeys, origin),
    });
  }
  return issues;
}

/**
 * Resolve the validation mode from `AUTH_PROVIDER_VALIDATION`.
 *
 * @param env Environment to read (injectable for tests; defaults to `process.env`).
 * @returns `strict` when unset (the default), otherwise the configured mode.
 * @throws Error when the var is set to anything other than `strict` or `warn`, so a typo'd
 *   mode cannot silently weaken (or accidentally re-enable) validation.
 */
export function providerValidationMode(
  env: Record<string, string | undefined> = process.env
): ProviderValidationMode {
  const raw = readEnvString(env, PROVIDER_VALIDATION_ENV_KEY);
  if (raw === null) return 'strict';
  const mode = raw.toLowerCase();
  if (mode === 'strict' || mode === 'warn') return mode;
  throw new Error(
    `${PROVIDER_VALIDATION_ENV_KEY}='${raw}' is not a valid validation mode; ` +
      `use 'strict' (fail startup on partial provider config, the default) or ` +
      `'warn' (log and leave the provider disabled). Setup guide: ${SETUP_DOC}`
  );
}

/**
 * Validate provider config at boot (OLO-7.2 acceptance: misconfiguration fails loud at startup,
 * not at first login). Called from `src/instrumentation.ts` when the Node.js server starts; also
 * safe to call from tests or scripts.
 *
 * In `strict` mode (default) any partially-configured provider aborts startup with one message per
 * issue. In `warn` mode the issues are logged via `console.warn` and the offending providers stay
 * cleanly disabled.
 *
 * **DB-sourced config (OLO-8.8).** `env` should be the merged DB-over-env overlay, so a provider
 * configured entirely from the admin screen is complete here and is never flagged as "missing env".
 * The one case the merge cannot settle is `origin === 'unavailable'`: a DB source is configured but
 * was unreadable, so the overlay silently degraded to env and a provider may look partial only
 * because its stored half is missing from this view. Failing startup on unproven evidence would turn
 * a transient REST outage into a boot outage, so `strict` is downgraded to a logged warning for that
 * origin (and says so). An invalid `AUTH_PROVIDER_VALIDATION` value still throws in every case.
 *
 * @param env Environment to read (injectable for tests; defaults to `process.env`).
 * @param registry Registry to validate (injectable for tests; defaults to {@link PROVIDER_REGISTRY}).
 * @param origin Where `env` came from (defaults to `env-only`, the pre-OLO-8.5 behaviour).
 * @returns The issues found (empty when the deployment's provider config is coherent).
 * @throws Error in `strict` mode when any provider is partially configured against a conclusive
 *   source (`env-only` or `db`), or for an invalid `AUTH_PROVIDER_VALIDATION` value in any mode.
 */
export function validateProviderEnv(
  env: Record<string, string | undefined> = process.env,
  registry: readonly ProviderDescriptor[] = PROVIDER_REGISTRY,
  origin: ProviderConfigOrigin = 'env-only'
): ProviderEnvIssue[] {
  const mode = providerValidationMode(env);
  const issues = providerEnvIssues(env, registry, origin);
  if (issues.length === 0) return issues;
  if (mode === 'strict') {
    // Only a conclusive source justifies refusing to start: with `unavailable` the evidence is a
    // view we know to be incomplete.
    if (origin !== 'unavailable') {
      throw new Error(
        `Refusing to start: ${issues.length} sign-in provider(s) partially configured.\n` +
          issues.map((issue) => `  - ${issue.message}`).join('\n') +
          `\nSet ${PROVIDER_VALIDATION_ENV_KEY}=warn to log instead and leave the provider(s) disabled.`
      );
    }
    // Say why the configured mode was not enforced, so the downgrade is never silent.
    console.warn(
      `[provider-registry] ${PROVIDER_VALIDATION_ENV_KEY}=strict not enforced: the stored provider ` +
        'config could not be read, so partial config cannot be told apart from config that lives ' +
        'in the database. Startup continues on env config; the provider(s) below are disabled ' +
        'until the resolved endpoint is reachable again.'
    );
  }
  for (const issue of issues) {
    console.warn(`[provider-registry] ${issue.message} (provider disabled)`);
  }
  return issues;
}

/**
 * Probe OIDC discovery when the generic OIDC provider is fully configured (OLO-9.6).
 *
 * Called from `instrumentation.ts` after {@link validateProviderEnv} so a reachable but
 * non-conformant (or unreachable) issuer fails loud at boot instead of leaving a broken login
 * page. Skipped when oidc is disabled or only partially configured (partial config is already
 * handled by {@link validateProviderEnv}). Honours the same `AUTH_PROVIDER_VALIDATION` mode.
 *
 * @param env Environment to read (injectable for tests; defaults to `process.env`).
 * @param probe Injectable discovery probe (defaults to `probeOidcDiscovery` from oidc-issuer).
 * @returns The failure message when discovery failed in warn mode, or null on success / skip.
 * @throws Error in strict mode when discovery fails.
 */
export async function validateOidcDiscoveryEnv(
  env: Record<string, string | undefined> = process.env,
  probe?: (
    issuer: string
  ) => Promise<{ ok: true } | { ok: false; message: string }>
): Promise<string | null> {
  if (!isProviderEnabled('oidc', env)) return null;
  const { oidcIssuerBaseUrl, probeOidcDiscovery } = await import('./oidc-issuer');
  const probeFn = probe ?? probeOidcDiscovery;
  const issuer = oidcIssuerBaseUrl(env);
  const result = await probeFn(issuer);
  if (result.ok) return null;
  const mode = providerValidationMode(env);
  if (mode === 'strict') {
    throw new Error(
      `Refusing to start: OIDC discovery failed.\n  - ${result.message}\n` +
        `Set ${PROVIDER_VALIDATION_ENV_KEY}=warn to log instead and leave the provider disabled.`
    );
  }
  console.warn(`[provider-registry] ${result.message} (provider may fail at login)`);
  return result.message;
}
