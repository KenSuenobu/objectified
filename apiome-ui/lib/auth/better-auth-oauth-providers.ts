/**
 * Better Auth OAuth provider construction (OLO-10.7, #5002).
 *
 * Re-expresses the four live sign-in providers — github, gitlab, azure, google — on Better Auth's
 * **generic OAuth2/OIDC** plugin, the Better Auth analogue of the NextAuth factory map in
 * `nextauth-oauth-providers.ts`. Every provider is driven from the shared provider registry
 * (`provider-registry.ts`) exactly as the NextAuth path is, so the registry stays the single source
 * of the enabled set and the mirror tests (`provider-registry-mirror.test.ts`,
 * `test_auth_provider_registry.py`) keep holding with no registry change.
 *
 * All four use `genericOAuth` (not Better Auth's built-in `socialProviders`) for one decisive
 * reason: the built-in social providers hard-code their authorization/token endpoints, so they
 * cannot honour the OLO-7.4 endpoint/issuer overrides the mocked-provider e2e journey depends on.
 * The generic plugin exposes `authorizationUrl`/`tokenUrl`/`userInfoUrl`/`discoveryUrl`, so every
 * endpoint stays overridable via the same env vars the NextAuth path reads (`GITHUB_OAUTH_BASE_URL`,
 * `GITHUB_API_BASE_URL`, `GITLAB_BASE_URL`, `GOOGLE_ISSUER`, `AZURE_AD_AUTHORITY_BASE_URL`,
 * `AZURE_AD_TENANT`). The generic callback path (`/oauth2/callback/:id`) is exactly the prefix the
 * OLO-10.6 resolution adapter already recognises.
 *
 * What each provider re-attaches (identical policy to the NextAuth engine, proven by tests):
 *  - **Verified-email parity (OLO-2.5):** GitHub `/user/emails` verified flags, GitLab `confirmed_at`,
 *    Google's native `email_verified` — normalized onto the profile as `email_verified` before the
 *    resolution engine sees it (`verified-email.ts` pure helpers, reused verbatim).
 *  - **Google Workspace `hd` gate (OLO-9.2):** `assertGoogleHostedDomain` throws before resolution,
 *    so an out-of-domain account never lands an identity (`google-workspace-domain.ts`).
 *  - **nOAuth hardening (OLO-1.4):** azure id-token claims (`oid`/`upn`/`xms_edov`/…) pass through
 *    untouched so the engine's `resolveEntraEmailVerified` still rejects a forged token.
 *  - **The account-resolution decision (OLO-1.x):** every callback runs through
 *    `resolveBetterAuthOAuthSignIn` (OLO-10.6). Admit → Better Auth establishes the session; any
 *    non-admit outcome (login error, onboarding, link) is steered to the engine's exact redirect
 *    path via the request-scoped {@link oauthRedirectOverrideStore} (see below).
 *
 * **Lifecycle placement (the piece OLO-10.6 deferred to this ticket).** Better Auth's generic
 * callback fetches the profile through `getUserInfo(tokens)` *before* it creates or links any user
 * (`plugins/generic-oauth/routes.mjs`); a custom `getUserInfo` therefore fully owns the decision. On
 * a non-admit it returns `null`, which makes Better Auth redirect to its OAuth error URL — and the
 * handler wrapper in `auth.ts` rewrites that redirect's `Location` to the engine's byte-identical
 * `/login?error=<code>` / `/signup/oauth?…` / linked-accounts path (OLO-1.5 contract). The override
 * travels on an {@link AsyncLocalStorage} scoped to the single callback request, so it is race-free.
 *
 * Scope note (OLO-10.7): this module wires the providers, the normalization, the `hd` gate, and the
 * resolution invocation, proven by `tests/better-auth-oauth-providers.test.ts`. Per-request
 * DB-over-env provider resolution is now implemented (OLO-10.8): `auth.ts` feeds the resolver's merged
 * env into {@link buildGenericOAuthConfigs} and rebuilds the instance when {@link providerConfigSignature}
 * changes. Account/identity-table parity (10.9) and the live mock-provider e2e journey (10.13) are
 * sequenced after this ticket.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

import type { GenericOAuthConfig } from 'better-auth/plugins/generic-oauth';
import type { OAuth2Tokens, OAuth2UserInfo } from 'better-auth/oauth2';

import {
  AUTH_ERROR_CODES,
  canonicalizeEmail,
  resolveEntraEmailVerified,
  resolveOAuthEmailVerified,
  loginErrorRedirect,
  type OAuthSignInResult,
  type ResolutionStore,
} from './account-resolution';
import {
  resolveBetterAuthOAuthSignIn,
  type BetterAuthOAuthContext,
} from './better-auth-account-resolution';
import { resolutionStore } from './resolution-store';
import { enabledProviders, readEnvString } from './provider-registry';
import {
  GITHUB_OAUTH_SCOPE,
  GITLAB_OAUTH_SCOPE,
  githubApiBaseUrl,
  gitlabBaseUrl,
  resolveGithubVerifiedEmail,
  resolveGitlabEmailVerified,
  type GithubEmailEntry,
} from './verified-email';
import {
  assertGoogleHostedDomain,
  googleIssuerBaseUrl,
  googleWorkspaceDomain,
  type GoogleProfile,
} from './google-workspace-domain';
import { entraAuthorityBaseUrl, entraIdProfile, type EntraIdProfile } from './entra-provider';

/* ── Request-scoped redirect override ──────────────────────────────────────────────────────── */

/**
 * Per-request carrier that lets a provider's `getUserInfo` steer the callback's final redirect to
 * the account-resolution engine's exact path. `auth.ts` runs `auth.handler` inside this async
 * context (`runWithOauthRedirectOverride`); `getUserInfo` writes the path on a non-admit
 * (`setOauthRedirectOverride`); the handler wrapper then rewrites the redirect `Location`
 * (`applyOauthRedirectOverride`). Scoped to the single callback request, so concurrent sign-ins
 * never see each other's override.
 */
export const oauthRedirectOverrideStore = new AsyncLocalStorage<{ redirect: string | null }>();

/**
 * Run `fn` inside a fresh redirect-override scope. `auth.ts`'s `betterAuthHandler` wraps every
 * Better Auth request in this so `getUserInfo` (deep inside the generic-OAuth callback) can publish
 * a redirect back out to the handler boundary.
 *
 * @param fn The work to run (typically `auth.handler(request)`).
 * @returns Whatever `fn` resolves to.
 */
export function runWithOauthRedirectOverride<T>(fn: () => Promise<T>): Promise<T> {
  return oauthRedirectOverrideStore.run({ redirect: null }, fn);
}

/**
 * Record the exact path the callback should redirect to instead of completing the sign-in. No-ops
 * when called outside a redirect-override scope (e.g. a unit test driving `getUserInfo` directly),
 * so the resolution outcome is still returned to the caller.
 *
 * @param path The engine's redirect path (`/login?error=…`, `/signup/oauth?…`, linked-accounts).
 */
export function setOauthRedirectOverride(path: string): void {
  const scope = oauthRedirectOverrideStore.getStore();
  if (scope) scope.redirect = path;
}

/**
 * The redirect path a provider's `getUserInfo` published for the current request, or null when the
 * sign-in was admitted (or no scope is active).
 *
 * @returns The override path, or null.
 */
export function getOauthRedirectOverride(): string | null {
  return oauthRedirectOverrideStore.getStore()?.redirect ?? null;
}

/**
 * Rewrite a Better Auth redirect `Response`'s `Location` to the engine's override path when one was
 * published for this request. Leaves non-redirect responses and un-overridden redirects untouched,
 * so an admitted sign-in flows to Better Auth's own callback URL exactly as normal.
 *
 * @param response The response Better Auth's handler produced.
 * @returns The response, with `Location` swapped to the engine's path when an override is set.
 */
export function applyOauthRedirectOverride(response: Response): Response {
  const override = getOauthRedirectOverride();
  if (!override) return response;
  if (response.status < 300 || response.status >= 400) return response;
  const headers = new Headers(response.headers);
  headers.set('Location', override);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/* ── Token / profile helpers ───────────────────────────────────────────────────────────────── */

/** Minimal fetch shape, injectable so tests never touch the network. */
export type FetchLike = (
  url: string,
  init: { headers: Record<string, string> }
) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

/** Remove a single trailing slash so `${base}/path` never doubles the separator. */
function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * Base URL of GitHub's OAuth **web** endpoints (`/login/oauth/authorize`, `…/access_token`).
 * Overridable via `GITHUB_OAUTH_BASE_URL` for the mocked-provider e2e journey (OLO-7.4); defaults
 * to the real host. (This was the sole GitHub base-URL helper once NextAuth and its provider factory
 * were removed at the OLO-10.14 cutover.)
 *
 * @param env Environment to read (injectable for tests; defaults to `process.env`).
 * @returns The base URL without a trailing slash.
 */
export function githubOauthWebBaseUrl(
  env: Record<string, string | undefined> = process.env
): string {
  return stripTrailingSlash(readEnvString(env, 'GITHUB_OAUTH_BASE_URL') ?? 'https://github.com');
}

/**
 * Fetch a JSON resource with the OAuth bearer token, failing **soft**: any transport error, non-2xx
 * response, or malformed body yields null (the caller then resolves to unverified rather than
 * crashing the whole sign-in round trip — the same fail-closed posture as `verified-email.ts`).
 *
 * @param url Absolute URL to fetch.
 * @param accessToken The OAuth access token from the code exchange.
 * @param fetchImpl Fetch implementation (injectable for tests; defaults to global fetch).
 * @returns The parsed JSON body, or null when it could not be retrieved.
 */
async function fetchJsonWithToken(
  url: string,
  accessToken: string,
  fetchImpl: FetchLike
): Promise<unknown> {
  try {
    const res = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'User-Agent': 'apiome',
      },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Decode the claim set from a JWT (an OIDC id token) without verifying its signature: split off the
 * payload segment, base64url-decode it, and JSON-parse. Signature verification is Better Auth's job
 * during the code exchange; this only reads the already-validated claims. Fail-soft to null on any
 * malformed input.
 *
 * @param idToken The compact-serialization JWT, or null/undefined.
 * @returns The decoded claim object, or null when the token is absent or unparseable.
 */
export function decodeJwtClaims(idToken: string | null | undefined): Record<string, unknown> | null {
  if (typeof idToken !== 'string') return null;
  const segments = idToken.split('.');
  if (segments.length < 2) return null;
  try {
    const json = Buffer.from(segments[1], 'base64url').toString('utf8');
    const claims = JSON.parse(json);
    return claims && typeof claims === 'object' ? (claims as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/* ── Per-provider profile normalization ────────────────────────────────────────────────────── */

/**
 * The facts a provider's `getUserInfo` gathers before the resolution engine runs: the stable
 * provider-side account id, the raw profile (with `email_verified` normalized onto it where the
 * provider does not carry it natively), and the display fields Better Auth stores on the user.
 */
export interface NormalizedOAuthProfile {
  /** Stable provider-side id → `account.providerAccountId` (github/gitlab `id`, `sub`, azure `oid`). */
  accountId: string;
  /** Raw provider profile / id-token claims, with `email_verified` stamped for github/gitlab. */
  profile: Record<string, unknown>;
  /** The resolved sign-in email (github may adopt the primary address from `/user/emails`). */
  email: string | null;
  /** Display name for the Better Auth user record. */
  name: string | null;
  /** Avatar URL for the Better Auth user record (null for azure — no Graph photo fetch). */
  image: string | null;
}

/**
 * Normalize a GitHub sign-in: fetch `/user`, consult `/user/emails`, and stamp the resolved
 * address + `email_verified` onto the profile (OLO-2.5 parity). Both endpoints honour the
 * `GITHUB_API_BASE_URL` override (OLO-7.4).
 */
async function normalizeGithub(
  tokens: OAuth2Tokens,
  env: Record<string, string | undefined>,
  fetchImpl: FetchLike
): Promise<NormalizedOAuthProfile> {
  const accessToken = tokens.accessToken ?? '';
  const apiBase = githubApiBaseUrl(env);
  const profileBody = await fetchJsonWithToken(`${apiBase}/user`, accessToken, fetchImpl);
  const profile: Record<string, unknown> =
    profileBody && typeof profileBody === 'object' ? { ...(profileBody as object) } : {};
  const emailsBody = await fetchJsonWithToken(`${apiBase}/user/emails`, accessToken, fetchImpl);
  const entries = Array.isArray(emailsBody) ? (emailsBody as GithubEmailEntry[]) : null;

  const resolution = resolveGithubVerifiedEmail(
    typeof profile.email === 'string' ? profile.email : null,
    entries
  );
  profile.email = resolution.email;
  profile.email_verified = resolution.emailVerified;

  return {
    accountId: profile.id != null ? String(profile.id) : '',
    profile,
    email: resolution.email,
    name:
      (typeof profile.name === 'string' && profile.name) ||
      (typeof profile.login === 'string' && profile.login) ||
      null,
    image: typeof profile.avatar_url === 'string' ? profile.avatar_url : null,
  };
}

/**
 * Normalize a GitLab sign-in: fetch `/api/v4/user` and stamp `email_verified` from the
 * `confirmed_at` evidence (OLO-2.5 parity). The endpoint honours the `GITLAB_BASE_URL` override.
 */
async function normalizeGitlab(
  tokens: OAuth2Tokens,
  env: Record<string, string | undefined>,
  fetchImpl: FetchLike
): Promise<NormalizedOAuthProfile> {
  const accessToken = tokens.accessToken ?? '';
  const body = await fetchJsonWithToken(`${gitlabBaseUrl(env)}/api/v4/user`, accessToken, fetchImpl);
  const profile: Record<string, unknown> =
    body && typeof body === 'object' ? { ...(body as object) } : {};
  profile.email_verified = resolveGitlabEmailVerified(profile);

  const accountId = profile.id != null ? String(profile.id) : profile.sub != null ? String(profile.sub) : '';
  return {
    accountId,
    profile,
    email: typeof profile.email === 'string' ? profile.email : null,
    name:
      (typeof profile.name === 'string' && profile.name) ||
      (typeof profile.username === 'string' && profile.username) ||
      null,
    image: typeof profile.avatar_url === 'string' ? profile.avatar_url : null,
  };
}

/**
 * Normalize a Google sign-in: decode the id-token claims (native `email_verified` + `hd`) and
 * enforce the Workspace-domain gate before anything else, so an out-of-domain account is rejected
 * (OLO-9.2). Discovery is pointed at `googleIssuerBaseUrl`, so the e2e journey can substitute a mock
 * issuer (OLO-7.4).
 *
 * @throws Error (via {@link assertGoogleHostedDomain}) when the domain gate rejects the account.
 */
function normalizeGoogle(
  tokens: OAuth2Tokens,
  env: Record<string, string | undefined>
): NormalizedOAuthProfile {
  const claims = (decodeJwtClaims(tokens.idToken) ?? {}) as GoogleProfile;
  assertGoogleHostedDomain(claims, googleWorkspaceDomain(env));
  return {
    accountId: typeof claims.sub === 'string' ? claims.sub : '',
    profile: claims,
    email: typeof claims.email === 'string' ? claims.email : null,
    name: typeof claims.name === 'string' ? claims.name : null,
    image: typeof claims.picture === 'string' ? claims.picture : null,
  };
}

/**
 * Normalize an azure (Microsoft Entra ID) sign-in: decode the id-token claims and pass them through
 * untouched — the engine's `resolveEntraEmailVerified` reads `oid`/`upn`/`xms_edov`/`email_verified`
 * for the nOAuth hardening (OLO-1.4). `oid` (falling back to `sub`) is the stable provider id.
 */
function normalizeAzure(tokens: OAuth2Tokens): NormalizedOAuthProfile {
  const claims = (decodeJwtClaims(tokens.idToken) ?? {}) as EntraIdProfile;
  const mapped = entraIdProfile(claims);
  return {
    accountId: mapped.id ? String(mapped.id) : '',
    profile: claims as Record<string, unknown>,
    email: mapped.email,
    name: mapped.name,
    image: null,
  };
}

/* ── getUserInfo runner: normalize → resolve → admit or override ────────────────────────────── */

/**
 * Dependencies a provider's `getUserInfo` runner needs, all injectable so the whole flow is testable
 * without a database, network, or request context.
 */
export interface OAuthRunnerDeps {
  /** Persistence for the resolution engine; defaults to the shared production store. */
  store?: ResolutionStore;
  /** Fetch implementation for the GitHub/GitLab userinfo calls; defaults to global fetch. */
  fetchImpl?: FetchLike;
  /**
   * Resolve the "link another provider" session user id from apiome's one-shot link-intent cookie,
   * or null for a normal sign-in. Defaults to {@link resolveLinkIntentUserId}.
   */
  resolveLinkToUserId?: (provider: string) => Promise<string | null>;
  /** Environment to read (injectable for tests; defaults to `process.env`). */
  env?: Record<string, string | undefined>;
}

/** The four providers this module builds, mapped to their normalizer. */
const NORMALIZERS: Record<
  string,
  (tokens: OAuth2Tokens, env: Record<string, string | undefined>, fetchImpl: FetchLike) => Promise<NormalizedOAuthProfile> | NormalizedOAuthProfile
> = {
  github: normalizeGithub,
  gitlab: normalizeGitlab,
  google: (tokens, env) => normalizeGoogle(tokens, env),
  azure: (tokens) => normalizeAzure(tokens),
};

/**
 * Read apiome's one-shot `oauth_link_intent` cookie to decide whether this callback is an explicit
 * "link another provider" action for `provider`. Delegates to the shared link-intent reader
 * (`oauth-link-intent.checkLinkingIntent`) via a lazy import so this module's static graph stays free
 * of `next/headers`. Fail-soft: any error yields null (a normal sign-in).
 *
 * @param provider The provider slug reported by the callback.
 * @returns The session user id to link to, or null.
 */
export async function resolveLinkIntentUserId(provider: string): Promise<string | null> {
  try {
    const { checkLinkingIntent } = await import('./oauth-link-intent');
    const intent = await checkLinkingIntent();
    return intent && intent.provider === provider && intent.userId ? intent.userId : null;
  } catch {
    return null;
  }
}

/**
 * Build the `getUserInfo(tokens)` hook for a provider: normalize the profile, run the shared
 * account-resolution engine, and either admit the sign-in (return the Better Auth user info) or
 * publish the engine's redirect path and return null (Better Auth then redirects, and the handler
 * wrapper rewrites the `Location`).
 *
 * The returned `emailVerified` is computed with the **same** readers the engine uses
 * (`resolveEntraEmailVerified` for azure, `resolveOAuthEmailVerified` otherwise), so Better Auth's
 * own account handling sees the identical verified signal the engine decided over.
 *
 * @param provider The provider slug (github | gitlab | azure | google).
 * @param deps Injectable dependencies (store, fetch, link-intent resolver, env).
 * @returns A `getUserInfo` function returning the Better Auth user info on admit, or null otherwise.
 */
export function makeOAuthGetUserInfo(
  provider: string,
  deps: OAuthRunnerDeps = {}
): (tokens: OAuth2Tokens) => Promise<OAuth2UserInfo | null> {
  const store = deps.store ?? resolutionStore;
  const fetchImpl = deps.fetchImpl ?? (fetch as unknown as FetchLike);
  const resolveLink = deps.resolveLinkToUserId ?? resolveLinkIntentUserId;
  const envForRun = deps.env ?? process.env;
  const normalize = NORMALIZERS[provider];

  return async (tokens: OAuth2Tokens): Promise<OAuth2UserInfo | null> => {
    if (!normalize) {
      // A provider without a normalizer can never sign in — refuse on the stable code rather than
      // letting Better Auth fall through to its own handling.
      setOauthRedirectOverride(loginErrorRedirect(AUTH_ERROR_CODES.PROVIDER_NOT_CONFIGURED));
      return null;
    }

    let normalized: NormalizedOAuthProfile;
    try {
      normalized = await normalize(tokens, envForRun, fetchImpl);
    } catch (error) {
      // A normalizer only throws for a hard rejection — today the Google Workspace-domain gate
      // (OLO-9.2). Refuse the sign-in with the generic on-contract code so it neither leaks whether
      // the domain matched nor drifts from the error contract.
      console.error(`[betterAuthOAuthProviders] ${provider} profile normalization rejected:`, error);
      setOauthRedirectOverride(loginErrorRedirect(AUTH_ERROR_CODES.SIGN_IN_FAILED));
      return null;
    }

    const linkToUserId = await resolveLink(provider);

    const ctx: BetterAuthOAuthContext = {
      accountId: normalized.accountId || null,
      profile: normalized.profile,
      tokens: {
        accessToken: tokens.accessToken ?? null,
        refreshToken: tokens.refreshToken ?? null,
        accessTokenExpiresAt: tokens.accessTokenExpiresAt ?? null,
      },
    };

    const result: OAuthSignInResult = await resolveBetterAuthOAuthSignIn(
      provider,
      ctx,
      linkToUserId,
      store
    );

    if (result === true) {
      // Admitted: hand Better Auth the resolved user info so it establishes the session. The
      // verified flag is computed exactly as the engine computed it, so Better Auth's own account
      // handling never sees a different signal than the engine decided over.
      const account = { email_verified: normalized.profile.email_verified };
      const emailVerified =
        provider === 'azure'
          ? resolveEntraEmailVerified(normalized.profile, account, canonicalizeEmail(normalized.email))
          : resolveOAuthEmailVerified(normalized.profile, account);
      return {
        id: normalized.accountId,
        email: normalized.email,
        emailVerified,
        name: normalized.name ?? undefined,
        image: normalized.image ?? undefined,
      };
    }

    // Any non-admit outcome is either a redirect path (login error, onboarding, or linked-accounts)
    // or a contained `false` (a store/provider fault the engine swallowed rather than admitting).
    // Map the bare `false` to the generic on-contract failure code so a fault never leaks and never
    // falls through to a sign-in. Publish the path and return null so Better Auth aborts before
    // creating any user.
    setOauthRedirectOverride(
      typeof result === 'string' ? result : loginErrorRedirect(AUTH_ERROR_CODES.SIGN_IN_FAILED)
    );
    return null;
  };
}

/* ── Config builder ────────────────────────────────────────────────────────────────────────── */

/**
 * Build one {@link GenericOAuthConfig} for a provider id, or null when the id is not one of the four
 * this module implements. Wires the client credentials (from the resolved env), the endpoint/issuer
 * overrides (OLO-7.4), the scopes and PKCE posture that match the NextAuth providers, and the
 * `getUserInfo` hook that carries verified-email normalization + the `hd` gate + the resolution
 * decision.
 *
 * @param providerId The registry provider slug.
 * @param env Environment to read (injectable for tests; defaults to `process.env`).
 * @param deps Injectable runner dependencies forwarded to {@link makeOAuthGetUserInfo}.
 * @returns The generic-OAuth config, or null for an unknown/unsupported id.
 */
export function buildGenericOAuthConfig(
  providerId: string,
  env: Record<string, string | undefined> = process.env,
  deps: OAuthRunnerDeps = {}
): GenericOAuthConfig | null {
  const runnerDeps: OAuthRunnerDeps = { ...deps, env };
  const getUserInfo = makeOAuthGetUserInfo(providerId, runnerDeps);

  switch (providerId) {
    case 'github': {
      const web = githubOauthWebBaseUrl(env);
      return {
        providerId: 'github',
        clientId: readEnvString(env, 'GITHUB_ID') ?? '',
        clientSecret: readEnvString(env, 'GITHUB_SECRET') ?? '',
        authorizationUrl: `${web}/login/oauth/authorize`,
        tokenUrl: `${web}/login/oauth/access_token`,
        userInfoUrl: `${githubApiBaseUrl(env)}/user`,
        scopes: GITHUB_OAUTH_SCOPE.split(/\s+/).filter(Boolean),
        // GitHub OAuth Apps do not support PKCE; this confidential client authenticates the code
        // exchange with GITHUB_SECRET (state is enforced by Better Auth). Mirrors the NextAuth
        // `checks: ['state']` posture.
        pkce: false,
        getUserInfo,
      };
    }
    case 'gitlab': {
      const base = gitlabBaseUrl(env);
      return {
        providerId: 'gitlab',
        clientId: readEnvString(env, 'GITLAB_CLIENT_ID') ?? '',
        clientSecret: readEnvString(env, 'GITLAB_CLIENT_SECRET') ?? '',
        authorizationUrl: `${base}/oauth/authorize`,
        tokenUrl: `${base}/oauth/token`,
        userInfoUrl: `${base}/api/v4/user`,
        scopes: GITLAB_OAUTH_SCOPE.split(/\s+/).filter(Boolean),
        pkce: true,
        getUserInfo,
      };
    }
    case 'google': {
      return {
        providerId: 'google',
        clientId: readEnvString(env, 'GOOGLE_CLIENT_ID') ?? '',
        clientSecret: readEnvString(env, 'GOOGLE_CLIENT_SECRET') ?? '',
        // Discovery honours the GOOGLE_ISSUER override so the e2e journey can point sign-in at a mock
        // issuer; the authorization/token endpoints come from the discovery document.
        discoveryUrl: `${googleIssuerBaseUrl(env)}/.well-known/openid-configuration`,
        scopes: ['openid', 'email', 'profile'],
        pkce: true,
        getUserInfo,
      };
    }
    case 'azure': {
      const tenant = readEnvString(env, 'AZURE_AD_TENANT') ?? 'common';
      return {
        providerId: 'azure',
        clientId: readEnvString(env, 'AZURE_AD_CLIENT_ID') ?? '',
        clientSecret: readEnvString(env, 'AZURE_AD_CLIENT_SECRET') ?? '',
        // Tenant-scoped OIDC discovery against the Entra authority (overridable via
        // AZURE_AD_AUTHORITY_BASE_URL); `offline_access` makes Microsoft issue a refresh token.
        discoveryUrl: `${entraAuthorityBaseUrl(env)}/${tenant}/v2.0/.well-known/openid-configuration`,
        scopes: ['openid', 'profile', 'email', 'offline_access'],
        pkce: true,
        getUserInfo,
      };
    }
    default:
      return null;
  }
}

/**
 * Build the generic-OAuth config list for this deployment: one entry per **enabled** registry
 * provider, in registry display order. This is the Better Auth analogue of
 * `configuredOAuthProviders` — the registry (`enabledProviders`) is the single source of the enabled
 * set, so unsetting a provider's env vars removes its sign-in route entirely.
 *
 * @param env Environment to read (injectable for tests; defaults to `process.env`).
 * @param deps Injectable runner dependencies forwarded to each provider's `getUserInfo`.
 * @returns The `config` array for the `genericOAuth` plugin (empty when no provider is configured).
 */
export function buildGenericOAuthConfigs(
  env: Record<string, string | undefined> = process.env,
  deps: OAuthRunnerDeps = {}
): GenericOAuthConfig[] {
  const configs: GenericOAuthConfig[] = [];
  for (const descriptor of enabledProviders(env)) {
    const config = buildGenericOAuthConfig(descriptor.id, env, deps);
    if (!config) {
      console.error(
        `[betterAuthOAuthProviders] Provider '${descriptor.id}' is enabled by env but has no ` +
          `Better Auth generic-OAuth config; skipping.`
      );
      continue;
    }
    configs.push(config);
  }
  return configs;
}

/**
 * A stable fingerprint of a generic-OAuth config list, used to decide whether a per-request Better
 * Auth instance can be reused or must be rebuilt (OLO-10.8). Two config lists that would drive the
 * OAuth handshake identically produce the same signature; any change an admin makes from the settings
 * screen — enabling/disabling a provider, or changing a client id, secret, endpoint, or scope —
 * produces a different one, so the next sign-in rebuilds against the new config.
 *
 * The digest covers every field Better Auth's `genericOAuth` uses for the authorize/token/user-info
 * exchange but deliberately excludes the `getUserInfo` closure (a function, not serializable, and
 * identical in behaviour across builds). The client secret is folded in via a SHA-256 digest so a
 * rotated secret still forces a rebuild without the plaintext ever living in the cache key.
 *
 * @param configs The generic-OAuth config list from {@link buildGenericOAuthConfigs}.
 * @returns A hex digest that is equal iff the two config lists are handshake-equivalent.
 */
export function providerConfigSignature(configs: GenericOAuthConfig[]): string {
  const material = configs.map((config) => ({
    providerId: config.providerId,
    clientId: config.clientId,
    // Never place the plaintext secret in the signature; a per-secret digest is enough to detect a
    // rotation. An unset secret hashes to a fixed marker so "no secret" differs from any real one.
    clientSecretDigest:
      typeof config.clientSecret === 'string' && config.clientSecret.length > 0
        ? createHash('sha256').update(config.clientSecret).digest('hex')
        : null,
    authorizationUrl: config.authorizationUrl ?? null,
    tokenUrl: config.tokenUrl ?? null,
    userInfoUrl: config.userInfoUrl ?? null,
    discoveryUrl: config.discoveryUrl ?? null,
    scopes: config.scopes ?? null,
    pkce: config.pkce ?? null,
  }));
  return createHash('sha256').update(JSON.stringify(material)).digest('hex');
}
