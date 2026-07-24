/**
 * Auth0 issuer config — engine-neutral core (OLO-9.7, #4990).
 *
 * Pure, framework-free pieces of Auth0 sign-in: the provider slug and the OIDC issuer base URL
 * that drives discovery (`<issuer>/.well-known/openid-configuration`). Kept free of better-auth
 * imports so the Better Auth generic-OIDC wiring (`better-auth-oauth-providers.ts`) and the
 * mirror tests can share one implementation with no framework coupling.
 *
 * Unlike Google (`google-workspace-domain.ts`), Auth0 has no domain gate — the tenant issuer URL
 * *is* the deployment-specific config (`https://<tenant>.auth0.com`), required via OLO-9.1.
 */

/**
 * The provider slug — the value stored in `external_auth_providers.provider` (the OLO-2.2
 * vocabulary) AND the Better Auth generic-OIDC `providerId`. Never rename: persisted identities and
 * the account-resolution gates match on it.
 */
export const AUTH0_PROVIDER_ID = 'auth0';

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
 * Base URL of the Auth0 OIDC issuer the discovery document is fetched from.
 *
 * Read from `AUTH0_ISSUER` (e.g. `https://acme.auth0.com`). Blank/whitespace counts as unset; a
 * trailing slash is stripped so discovery path joining is stable. Returns an empty string when
 * unset — callers that need the provider enabled already require the issuer via the registry
 * (OLO-9.1), so an empty discovery URL only surfaces when the env is incomplete.
 *
 * @param env Environment to read (injectable for tests; defaults to `process.env`).
 * @returns The issuer base URL without a trailing slash, or `''` when unset.
 */
export function auth0IssuerBaseUrl(
  env: Record<string, string | undefined> = process.env
): string {
  const raw = readEnvString(env, 'AUTH0_ISSUER');
  if (!raw) return '';
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}
