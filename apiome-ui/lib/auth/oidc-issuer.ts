/**
 * Generic OIDC issuer config — engine-neutral core (OLO-9.6, #4989).
 *
 * Pure, framework-free pieces of the catch-all OIDC connector: the provider slug, the issuer
 * base URL that drives discovery (`<issuer>/.well-known/openid-configuration`), optional display
 * name / scopes, and a discovery probe used at boot and admin Validate. Kept free of better-auth
 * imports so the Better Auth generic-OIDC wiring (`better-auth-oauth-providers.ts`) and the
 * mirror tests can share one implementation with no framework coupling.
 *
 * v1 supports exactly one generic OIDC IdP per deployment (PingFederate, Authentik, ZITADEL,
 * FusionAuth, Duende, OneLogin, JumpCloud, …). A first-class catalog entry (e.g. Auth0) is
 * preferred when one exists.
 */

/** Default OIDC scopes when `OIDC_SCOPES` is unset. */
export const OIDC_DEFAULT_SCOPES: readonly string[] = ['openid', 'profile', 'email'];

/** Bound on the discovery probe so a hung IdP never stalls boot or admin Validate. */
const DISCOVERY_PROBE_TIMEOUT_MS = 3_000;

/**
 * The provider slug — the value stored in `external_auth_providers.provider` (the OLO-2.2
 * vocabulary) AND the Better Auth generic-OIDC `providerId`. Never rename: persisted identities and
 * the account-resolution gates match on it.
 */
export const OIDC_PROVIDER_ID = 'oidc';

/**
 * Read a trimmed env string, or null when unset/blank.
 *
 * @param env Environment map to read.
 * @param key Env var name.
 * @returns The trimmed value, or null when unset or blank.
 */
function readEnvString(env: Record<string, string | undefined>, key: string): string | null {
  const raw = env[key];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Base URL of the generic OIDC issuer the discovery document is fetched from.
 *
 * Read from `OIDC_ISSUER` (e.g. `https://auth.example.com` or a realm/tenant path). Blank /
 * whitespace counts as unset; a trailing slash is stripped so discovery path joining is stable.
 * Returns an empty string when unset — callers that need the provider enabled already require the
 * issuer via the registry (OLO-9.1), so an empty discovery URL only surfaces when the env is
 * incomplete.
 *
 * @param env Environment to read (injectable for tests; defaults to `process.env`).
 * @returns The issuer base URL without a trailing slash, or `''` when unset.
 */
export function oidcIssuerBaseUrl(
  env: Record<string, string | undefined> = process.env
): string {
  const raw = readEnvString(env, 'OIDC_ISSUER');
  if (!raw) return '';
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

/**
 * Operator-facing display name for the login button and admin card (`OIDC_DISPLAY_NAME`).
 *
 * @param env Environment to read (injectable for tests; defaults to `process.env`).
 * @returns The trimmed display name, or null when unset (callers fall back to the registry label
 *   `"OIDC"`).
 */
export function oidcDisplayName(
  env: Record<string, string | undefined> = process.env
): string | null {
  return readEnvString(env, 'OIDC_DISPLAY_NAME');
}

/**
 * OIDC scopes requested during authorize (`OIDC_SCOPES`), whitespace-separated.
 *
 * Defaults to {@link OIDC_DEFAULT_SCOPES} when unset or blank.
 *
 * @param env Environment to read (injectable for tests; defaults to `process.env`).
 * @returns Scope list (never empty — falls back to the default trio).
 */
export function oidcScopes(env: Record<string, string | undefined> = process.env): string[] {
  const raw = readEnvString(env, 'OIDC_SCOPES');
  if (!raw) return [...OIDC_DEFAULT_SCOPES];
  const scopes = raw.split(/\s+/).filter(Boolean);
  return scopes.length > 0 ? scopes : [...OIDC_DEFAULT_SCOPES];
}

/** Outcome of probing an IdP's OIDC discovery document. */
export type OidcDiscoveryProbeResult =
  | { ok: true }
  | { ok: false; message: string };

/** Minimal fetch shape for the discovery probe (injectable so tests never touch the network). */
export type OidcDiscoveryFetch = (
  url: string,
  init: { signal?: AbortSignal; headers?: Record<string, string> }
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/**
 * Probe `<issuer>/.well-known/openid-configuration` and require a usable discovery document.
 *
 * Used at boot (`validateOidcDiscoveryEnv`) and on admin Validate so a bad/unreachable issuer
 * fails loud with a clear message instead of leaving a broken login button. Only `http`/`https`
 * schemes are accepted; the well-known path is fixed (no open redirects from the probe itself).
 *
 * @param issuer The OIDC issuer base URL (trailing slash optional).
 * @param fetchImpl Fetch implementation (injectable for tests; defaults to global fetch).
 * @returns `{ ok: true }` when discovery looks conformant, else `{ ok: false, message }`.
 */
export async function probeOidcDiscovery(
  issuer: string,
  fetchImpl: OidcDiscoveryFetch = fetch as unknown as OidcDiscoveryFetch
): Promise<OidcDiscoveryProbeResult> {
  const trimmed = typeof issuer === 'string' ? issuer.trim() : '';
  if (!trimmed) {
    return {
      ok: false,
      message:
        "Sign-in provider 'OIDC' (oidc) discovery failed: issuer is unset or blank. " +
        'Set OIDC_ISSUER to the IdP issuer URL (e.g. https://auth.example.com). ' +
        'Setup guide: apiome-ui/docs/AUTH_PROVIDER_SETUP.md',
    };
  }
  const base = trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    return {
      ok: false,
      message:
        `Sign-in provider 'OIDC' (oidc) discovery failed: OIDC_ISSUER='${trimmed}' is not a valid URL. ` +
        'Setup guide: apiome-ui/docs/AUTH_PROVIDER_SETUP.md',
    };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      message:
        `Sign-in provider 'OIDC' (oidc) discovery failed: OIDC_ISSUER must use http or https ` +
        `(got '${parsed.protocol}'). Setup guide: apiome-ui/docs/AUTH_PROVIDER_SETUP.md`,
    };
  }

  const discoveryUrl = `${base}/.well-known/openid-configuration`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCOVERY_PROBE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(discoveryUrl, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'apiome' },
    });
    if (!res.ok) {
      return {
        ok: false,
        message:
          `Sign-in provider 'OIDC' (oidc) discovery failed: GET ${discoveryUrl} returned HTTP ${res.status}. ` +
          'Check OIDC_ISSUER points at a reachable OpenID Provider. ' +
          'Setup guide: apiome-ui/docs/AUTH_PROVIDER_SETUP.md',
      };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return {
        ok: false,
        message:
          `Sign-in provider 'OIDC' (oidc) discovery failed: ${discoveryUrl} did not return JSON. ` +
          'Setup guide: apiome-ui/docs/AUTH_PROVIDER_SETUP.md',
      };
    }
    if (!body || typeof body !== 'object') {
      return {
        ok: false,
        message:
          `Sign-in provider 'OIDC' (oidc) discovery failed: ${discoveryUrl} body is not an object. ` +
          'Setup guide: apiome-ui/docs/AUTH_PROVIDER_SETUP.md',
      };
    }
    const doc = body as Record<string, unknown>;
    const authorize = doc.authorization_endpoint;
    const token = doc.token_endpoint;
    if (typeof authorize !== 'string' || !authorize.trim()) {
      return {
        ok: false,
        message:
          `Sign-in provider 'OIDC' (oidc) discovery failed: ${discoveryUrl} is missing authorization_endpoint. ` +
          'Setup guide: apiome-ui/docs/AUTH_PROVIDER_SETUP.md',
      };
    }
    if (typeof token !== 'string' || !token.trim()) {
      return {
        ok: false,
        message:
          `Sign-in provider 'OIDC' (oidc) discovery failed: ${discoveryUrl} is missing token_endpoint. ` +
          'Setup guide: apiome-ui/docs/AUTH_PROVIDER_SETUP.md',
      };
    }
    return { ok: true };
  } catch (error) {
    const reason =
      error && typeof error === 'object' && 'name' in error && (error as { name?: string }).name === 'AbortError'
        ? `timed out after ${DISCOVERY_PROBE_TIMEOUT_MS}ms`
        : error instanceof Error
          ? error.message
          : String(error);
    return {
      ok: false,
      message:
        `Sign-in provider 'OIDC' (oidc) discovery failed: could not reach ${discoveryUrl} (${reason}). ` +
        'Setup guide: apiome-ui/docs/AUTH_PROVIDER_SETUP.md',
    };
  } finally {
    clearTimeout(timer);
  }
}
