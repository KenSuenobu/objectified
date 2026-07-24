/**
 * Shared contract for the admin auth-provider configuration screen (OLO-8.7, #4973).
 *
 * The settings page (`/admin/dashboard/settings`) reads and writes provider config through the
 * super-admin REST surface (OLO-8.4, proxied by `src/app/api/admin/auth-providers`). This module
 * holds the pieces both sides of that conversation share:
 *
 *   - TypeScript mirrors of the REST view/request models (`ProviderConfigView` et al. in
 *     `apiome-rest/src/app/auth_provider_config_routes.py`) so the client and its tests agree on
 *     the wire shape;
 *   - the per-provider **extra config fields** (Azure tenant/authority, GitHub/GitLab base URLs)
 *     the card renders from / writes to the `config` JSONB. Extras are **env-var-keyed** — the
 *     merge resolver (OLO-8.5, `provider-config-resolver.ts`) overlays each `config` entry onto
 *     the env key of the same name, so the keys here MUST be real env var names the auth stack
 *     reads (`better-auth-oauth-providers.ts`, `entra-provider.ts`);
 *   - `buildProviderUpdatePayload`, the pure builder that turns a card's edits into the minimal
 *     partial PUT body (the REST side interprets fields by presence, so only changed fields may
 *     be sent).
 *
 * Intentionally free of React and server-only imports so client components, routes, and tests can
 * all import it.
 */

/** Where a field's effective value comes from: the DB row, or the `.env` fallback (OLO-8.5). */
export type AdminFieldSource = 'db' | 'env-fallback';

/** Registry lifecycle of a provider, mirroring `ProviderStatus` in `provider-registry.ts`. */
export type AdminProviderStatus = 'available' | 'coming-soon';

/**
 * One provider's masked configuration — the shape the REST GET list and PUT both return.
 * Mirrors `ProviderConfigView` (OLO-8.4). Never carries a secret value: `secret_set` reports
 * only whether one is stored.
 */
export interface AdminProviderConfigView {
  /** Provider slug (e.g. `github`). */
  provider_id: string;
  /** Human-readable provider name. */
  label: string;
  /** Registry lifecycle: `available` or `coming-soon`. */
  status: AdminProviderStatus;
  /** Explicit enable toggle from the DB; `null` ⇒ enablement is env-derived (OLO-8.5). */
  enabled: boolean | null;
  /** `db` when the enable toggle is stored, else `env-fallback`. */
  enabled_source: AdminFieldSource;
  /** OAuth client id from the DB; `null` when it falls back to env. */
  client_id: string | null;
  /** `db` when a client id is stored, else `env-fallback`. */
  client_id_source: AdminFieldSource;
  /** Whether a client secret is stored (encrypted). The secret itself is never returned. */
  secret_set: boolean;
  /** `db` when a secret is stored, else `env-fallback`. */
  secret_source: AdminFieldSource;
  /** Non-secret provider extras (JSONB), keyed by env var name; `{}` when none are stored. */
  config: Record<string, unknown>;
  /** Fields that must be present for this provider to be enabled (empty for coming-soon). */
  required_fields: string[];
  /** Required fields not yet satisfied by the DB row; enabling is blocked while non-empty. */
  missing_for_enable: string[];
  /** True when the provider is `available` and all required fields are present in the DB. */
  can_enable: boolean;
  /** When the row was last changed (ISO timestamp); `null` when no row exists. */
  updated_at: string | null;
  /** Super-admin who last changed the row; `null` when no row exists. */
  updated_by: string | null;
}

/** Payload of `GET /api/admin/auth-providers` (mirrors the REST list response). */
export interface AdminProviderListResponse {
  providers: AdminProviderConfigView[];
}

/**
 * Body of `PUT /api/admin/auth-providers/{providerId}` — a partial update interpreted by
 * **presence** (mirrors `ProviderConfigUpdateRequest`, OLO-8.4): an omitted field is left as
 * stored; `null` (or blank, for strings) clears the field back to env-fallback.
 */
export interface AdminProviderUpdatePayload {
  /** Enable toggle; `null` clears the override (enablement becomes env-derived). */
  enabled?: boolean | null;
  /** OAuth client id; `null` clears it (falls back to env). */
  client_id?: string | null;
  /** Write-only OAuth client secret; `null` clears the stored secret. Never returned. */
  client_secret?: string | null;
  /** Full replacement for the non-secret extras JSONB. */
  config?: Record<string, unknown>;
}

/** One provider-specific extra field rendered on a card and stored in the `config` JSONB. */
export interface ProviderExtraField {
  /**
   * The env var name this extra overlays (OLO-8.5 merges `config` entries by env key), e.g.
   * `GITLAB_BASE_URL`. Also the field's key inside the `config` JSONB.
   */
  envKey: string;
  /** Human label shown on the card. */
  label: string;
  /** The value the auth stack uses when neither the DB nor env sets this field. */
  defaultValue: string;
  /** One-line, admin-facing description of what the field does. */
  help: string;
}

/**
 * Provider-specific extra config fields, per provider id.
 *
 * Each `envKey` matches an env var the auth stack actually reads:
 *   - GitHub / GitLab endpoint overrides: `better-auth-oauth-providers.ts` (`githubApiBaseUrl`,
 *     the `GITLAB_BASE_URL` override);
 *   - Azure tenant + authority: `entra-provider.ts` (`AZURE_AD_TENANT`,
 *     `AZURE_AD_AUTHORITY_BASE_URL`);
 *   - Google Workspace domain restriction: `google-workspace-domain.ts` (`GOOGLE_WORKSPACE_DOMAIN`).
 *
 * Providers without an entry (and coming-soon placeholders) simply render no extras.
 */
export const PROVIDER_EXTRA_FIELDS: Record<string, readonly ProviderExtraField[]> = {
  github: [
    {
      envKey: 'GITHUB_OAUTH_BASE_URL',
      label: 'OAuth base URL',
      defaultValue: 'https://github.com',
      help: 'Authorization endpoint base — change for GitHub Enterprise Server.',
    },
    {
      envKey: 'GITHUB_API_BASE_URL',
      label: 'API base URL',
      defaultValue: 'https://api.github.com',
      help: 'REST API base used to fetch the signed-in user profile.',
    },
  ],
  gitlab: [
    {
      envKey: 'GITLAB_BASE_URL',
      label: 'Base URL',
      defaultValue: 'https://gitlab.com',
      help: 'Instance base URL — change for self-hosted GitLab.',
    },
  ],
  azure: [
    {
      envKey: 'AZURE_AD_TENANT',
      label: 'Tenant',
      defaultValue: 'common',
      help: "Entra ID tenant id or domain; 'common' allows any tenant.",
    },
    {
      envKey: 'AZURE_AD_AUTHORITY_BASE_URL',
      label: 'Authority base URL',
      defaultValue: 'https://login.microsoftonline.com',
      help: 'Authority endpoint base — rarely changed outside sovereign clouds.',
    },
  ],
  google: [
    {
      envKey: 'GOOGLE_WORKSPACE_DOMAIN',
      label: 'Workspace domain',
      defaultValue: '(any Google account)',
      help: 'Restrict sign-in to one Workspace domain (e.g. example.com); blank allows any account.',
    },
  ],
};

/**
 * A card's local, uncommitted edits. Every property is optional: **absent means "the admin has
 * not touched this control"**, which is what lets `buildProviderUpdatePayload` produce a minimal
 * partial update.
 */
export interface ProviderCardEdits {
  /** Edited enable state: `true`/`false` force it, `null` selects "use .env" (clear override). */
  enabled?: boolean | null;
  /** Edited client id text (raw input value; blank clears to env-fallback). */
  clientId?: string;
  /** New client secret typed into the write-only field (blank ⇒ no change). */
  clientSecret?: string;
  /** True when the admin asked to clear the stored secret (wins over `clientSecret`). */
  clearSecret?: boolean;
  /** Edited extra fields, keyed by env key (raw input values; blank clears the key). */
  extras?: Record<string, string>;
}

/**
 * Build the minimal partial PUT body for a card's edits, or `null` when nothing changed.
 *
 * Only fields whose effective value differs from the stored view are included — the REST side
 * interprets fields by presence, so sending an unchanged field would still overwrite it (and,
 * for `enabled`, could trip the completeness gate unnecessarily).
 *
 * `config` is replace-whole-object on the wire, so any changed extra rebuilds the full object
 * from the stored one: edited keys are set (trimmed) or removed (blank), untouched keys —
 * including ones this UI doesn't render — are preserved verbatim.
 *
 * @param view The provider's currently-stored (server-confirmed) view.
 * @param edits The card's local edits (see {@link ProviderCardEdits}).
 * @returns The partial payload to PUT, or `null` when there is nothing to save.
 */
export function buildProviderUpdatePayload(
  view: AdminProviderConfigView,
  edits: ProviderCardEdits
): AdminProviderUpdatePayload | null {
  const payload: AdminProviderUpdatePayload = {};

  if (edits.enabled !== undefined && edits.enabled !== view.enabled) {
    payload.enabled = edits.enabled;
  }

  if (edits.clientId !== undefined) {
    const trimmed = edits.clientId.trim();
    const stored = view.client_id ?? '';
    if (trimmed !== stored) {
      payload.client_id = trimmed.length > 0 ? trimmed : null;
    }
  }

  if (edits.clearSecret) {
    // Clearing only matters when a secret is actually stored.
    if (view.secret_set) {
      payload.client_secret = null;
    }
  } else if (edits.clientSecret !== undefined && edits.clientSecret.trim().length > 0) {
    payload.client_secret = edits.clientSecret.trim();
  }

  if (edits.extras) {
    const rebuilt: Record<string, unknown> = { ...view.config };
    for (const [envKey, raw] of Object.entries(edits.extras)) {
      const trimmed = raw.trim();
      if (trimmed.length > 0) {
        rebuilt[envKey] = trimmed;
      } else {
        delete rebuilt[envKey];
      }
    }
    if (!shallowConfigEqual(rebuilt, view.config)) {
      payload.config = rebuilt;
    }
  }

  return Object.keys(payload).length > 0 ? payload : null;
}

/**
 * Shallow equality over two config objects (same keys, `===`-equal values).
 *
 * Sufficient here because extras are flat string values; nested values this UI never edits are
 * carried over by reference and so compare equal.
 *
 * @param a First config object.
 * @param b Second config object.
 * @returns True when the objects have identical keys and values.
 */
function shallowConfigEqual(
  a: Record<string, unknown>,
  b: Record<string, unknown>
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && a[key] === b[key]);
}

/**
 * Extract a human-readable message from a REST error body.
 *
 * FastAPI wraps `HTTPException` details as `{ detail: ... }` where `detail` is either a plain
 * string or the structured objects OLO-8.4 raises (`{ error, message, missing_fields? }`).
 * Pydantic request-validation errors instead carry `detail` as an array of issues.
 *
 * @param body The parsed error-response body (any JSON value).
 * @param fallback Message to use when no detail can be extracted.
 * @returns The best available human-readable error message.
 */
export function extractRestErrorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const detail = (body as { detail?: unknown }).detail;
    if (typeof detail === 'string' && detail.trim().length > 0) return detail;
    if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
      const message = (detail as { message?: unknown }).message;
      if (typeof message === 'string' && message.trim().length > 0) return message;
    }
    if (Array.isArray(detail) && detail.length > 0) {
      return 'The request was rejected as invalid. Reload the page and try again.';
    }
    const message = (body as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim().length > 0) return message;
    const error = (body as { error?: unknown }).error;
    if (typeof error === 'string' && error.trim().length > 0) return error;
  }
  return fallback;
}
