/**
 * Microsoft Entra ID (azure) provider helpers (OLO-2.1, #4193).
 *
 * The engine-neutral core of Entra ID sign-in — the provider slug, the OIDC authority base URL, the
 * id-token claim mapping, and the config-detection check. The live sign-in provider is built on Better
 * Auth's generic-OIDC plugin from these helpers (`better-auth-oauth-providers.ts`, OLO-10.7); before
 * the OLO-10.14 cutover the NextAuth `entraIdProvider`/`entraIdProviderIfConfigured` factories lived
 * here too and were removed with the rest of the NextAuth scaffolding.
 *
 * Three design decisions the helpers encode:
 *
 *   1. **Provider id must be `azure`.** The account-resolution engine gates Entra sign-ins behind
 *      the nOAuth hardening rules on `provider === 'azure'` (OLO-1.4), the auto-link trust list
 *      names `azure` (OLO-1.3), and `apiome.external_auth_providers` stores the identity under
 *      that value (OLO-1.2/2.2). Microsoft's built-in id is `azure-ad`, which would silently miss
 *      all of those gates.
 *   2. **`oid` → provider_user_id.** The `oid` claim is the user's immutable directory object id;
 *      `sub` is scoped per app registration, so rotating the registration would orphan every linked
 *      identity.
 *   3. **No Microsoft Graph photo fetch.** Identity resolution never needs the avatar, so the claim
 *      mapping returns a null image rather than downloading a base64 data-URI on every sign-in.
 *
 * Env contract: `AZURE_AD_CLIENT_ID`, `AZURE_AD_CLIENT_SECRET`, and optional `AZURE_AD_TENANT`
 * (an Entra tenant id/domain, defaulting to `common` for multi-tenant sign-in). The provider is
 * only registered when the deployment configures it (see `isEntraIdConfigured`), so an unconfigured
 * deployment never exposes a sign-in route that would redirect to Microsoft with an undefined client
 * id.
 *
 * Trust boundary: these helpers only map the OIDC response onto an app user. Whether the token's
 * email claim may be believed is decided later by `resolveEntraEmailVerified`
 * (OLO-1.4, `account-resolution.ts`) inside the shared sign-in hook — never here.
 */
import { isProviderEnabled, readEnvString } from './provider-registry';

/**
 * The provider slug — the value stored in `external_auth_providers.provider` and matched by the
 * resolution engine's Entra-specific email gating. Never rename: `azure-ad` or similar would
 * bypass the nOAuth hardening (OLO-1.4) and orphan persisted identities.
 */
export const ENTRA_ID_PROVIDER_ID = 'azure';

/** The real Entra ID authority host (production default for {@link entraAuthorityBaseUrl}). */
const DEFAULT_AUTHORITY_BASE_URL = 'https://login.microsoftonline.com';

/**
 * Base URL of the Entra ID authority the OIDC discovery document is fetched from.
 * Overridable via `AZURE_AD_AUTHORITY_BASE_URL` for the mocked-provider e2e journey
 * (OLO-7.4); defaults to the real Microsoft host.
 *
 * @param env Environment to read (injectable for tests; defaults to `process.env`).
 * @returns The authority base URL without a trailing slash.
 */
export function entraAuthorityBaseUrl(
  env: Record<string, string | undefined> = process.env
): string {
  const raw = readEnvString(env, 'AZURE_AD_AUTHORITY_BASE_URL') ?? DEFAULT_AUTHORITY_BASE_URL;
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

/** The Entra ID id-token claims this module reads (all others pass through untouched). */
export interface EntraIdProfile extends Record<string, unknown> {
  /** Immutable directory object id — the stable provider_user_id (never use `sub`). */
  oid?: string;
  /** Per-app-registration subject; fallback only, for tokens missing `oid`. */
  sub?: string;
  name?: string;
  email?: string;
  preferred_username?: string;
}

/**
 * Whether this deployment configured Entra ID sign-in.
 *
 * Delegates to the provider registry (OLO-2.3) — the single source of the `azure` env
 * contract (`AZURE_AD_CLIENT_ID` + `AZURE_AD_CLIENT_SECRET`, both set and non-blank).
 *
 * @param env Environment to read (injectable for tests; defaults to `process.env`).
 * @returns True when both `AZURE_AD_CLIENT_ID` and `AZURE_AD_CLIENT_SECRET` are set and non-blank.
 */
export function isEntraIdConfigured(
  env: Record<string, string | undefined> = process.env
): boolean {
  return isProviderEnabled(ENTRA_ID_PROVIDER_ID, env);
}

/**
 * Map the raw Entra ID id-token claims onto the app user shape (consumed by the Better Auth
 * generic-OIDC provider's `getUserInfo`, OLO-10.7).
 *
 * `id` becomes the account's provider-side id, which the resolution engine persists as
 * `provider_user_id` — so it must be the immutable `oid` (falling back to `sub` only when a
 * token carries no `oid`, e.g. some personal-account variants). The raw claims themselves still
 * reach the sign-in hook as `profile`, where the nOAuth email rules read them (OLO-1.4).
 *
 * @param profile Raw claims from the Entra ID id token.
 * @returns The app user: stable id, display name, email (untrusted until 1.4 proves it),
 *   and a null image (no Graph photo fetch — see the module doc).
 */
export function entraIdProfile(profile: EntraIdProfile) {
  return {
    id: (profile.oid ?? profile.sub ?? '') as string,
    name: profile.name ?? profile.preferred_username ?? null,
    email: profile.email ?? null,
    image: null,
  };
}
