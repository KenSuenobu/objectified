/**
 * Better Auth account-resolution adapter (OLO-10.6, #5001).
 *
 * The OLO-1.x/2.x resolution engine is the security spine of sign-in: nOAuth hardening (OLO-1.4),
 * verified-email parity (OLO-2.5), the `AUTO_LINK_TRUSTED_PROVIDERS` gate, identity uniqueness, and
 * the structured error contract (OLO-1.5). The migration keeps that engine **byte-for-byte** and
 * re-homes only *where it is invoked from* — the NextAuth `signIn` callback becomes a Better Auth
 * sign-in/callback hook. This module is the Better Auth side of that re-homing; the pure policy
 * (`account-resolution.ts`) and its production store (`resolution-store.ts`, shared with the
 * NextAuth path) are unchanged.
 *
 * What re-homing requires:
 *
 *  - **Payload shape.** The engine reads a `{ user, account, profile }` payload
 *    ({@link mapBetterAuthOAuthPayload} builds it from Better Auth's OAuth callback context — the
 *    fetched provider `profile`/id-token claims plus the OAuth `tokens`). The provider's own
 *    `email_verified` normalization (GitHub `/user/emails`, GitLab `confirmed_at`, Google's native
 *    claim — OLO-2.5) is attached in the provider config's userinfo/`mapProfile` hook (10.7 #5002)
 *    exactly as `verified-email.ts` does today, so the profile already carries `email_verified`
 *    before this adapter runs.
 *  - **nOAuth gate.** `azure` claims land in the same `profile`; the engine calls the **same**
 *    `resolveEntraEmailVerified` (provider-gated on the `azure` slug) before any auto-link/create,
 *    so a forged nOAuth token is still rejected with the structured `unverified-email` code.
 *  - **Error transport.** Rejections ride the identical `/login?error=<code>` transport
 *    (`loginErrorRedirect`); the codes are a public contract and never change across engines.
 *
 * Provider wiring (`socialProviders`/generic-OIDC) lands in **10.7 (#5002)**, which this ticket
 * gates. Until then no OAuth callback path is served, so the hook mounted in `auth.ts` is inert; the
 * engine behaviour it will run is proven here by `tests/better-auth-account-resolution.test.ts`.
 */

import { createAuthMiddleware } from 'better-auth/api';

import {
  AUTH_ERROR_CODES,
  LINKABLE_PROVIDERS,
  loginErrorRedirect,
  resolveOAuthSignIn,
  type OAuthSignInResult,
  type ResolutionStore,
} from './account-resolution';
import { resolutionStore } from './resolution-store';

/**
 * OAuth providers this adapter dispatches through the resolution engine — the shared provider
 * vocabulary (`LINKABLE_PROVIDERS`: github | gitlab | azure | google). `credentials` is not here: it
 * is a sign-in method handled by the Better Auth `emailAndPassword` path (OLO-10.5), not a resolvable
 * OAuth identity. A callback for any slug outside this set is refused with the stable
 * `provider-not-configured` code — the same dispatch contract the removed NextAuth `signInForProvider`
 * enforced before the OLO-10.14 cutover.
 */
export const SUPPORTED_OAUTH_PROVIDERS: ReadonlySet<string> = LINKABLE_PROVIDERS;

/** Better Auth's social-callback path prefix (`/callback/:providerId`). */
export const SOCIAL_CALLBACK_PREFIX = '/callback/';

/** Better Auth's generic-OAuth callback path prefix (`/oauth2/callback/:providerId`). */
export const OAUTH2_CALLBACK_PREFIX = '/oauth2/callback/';

/**
 * The OAuth token set Better Auth hands the callback after the code exchange. Declared structurally
 * (rather than importing Better Auth's internal type) so the adapter stays decoupled from Better
 * Auth's internals — we only read the two tokens and the access-token expiry.
 */
export interface BetterAuthOAuthTokens {
  accessToken?: string | null;
  refreshToken?: string | null;
  /** Access-token expiry as Better Auth reports it: a `Date`, or epoch **seconds** as a number. */
  accessTokenExpiresAt?: Date | number | null;
}

/**
 * The slice of a Better Auth OAuth callback we map onto the engine payload. `profile` is the fetched
 * provider profile / id-token claims (already `email_verified`-normalized by the provider hook, 10.7);
 * `accountId` is the stable provider-side id (Better Auth `account.accountId`), with `sub`/`id` on the
 * profile as fallbacks.
 */
export interface BetterAuthOAuthContext {
  accountId?: string | null;
  profile?: Record<string, any> | null;
  tokens?: BetterAuthOAuthTokens | null;
}

/**
 * Convert Better Auth's access-token expiry into the epoch **seconds** the engine's
 * `extractIdentityDetails` expects (`account.expires_at`, read as `new Date(value * 1000)`).
 *
 * @param value A `Date`, epoch-seconds number, or null/undefined.
 * @returns Epoch seconds, or null when no usable expiry was supplied.
 */
function toExpiresAtSeconds(value: Date | number | null | undefined): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return null;
}

/**
 * Map a Better Auth OAuth callback context onto the `{ user, account, profile }` payload the pure
 * resolution engine reads. The mapping is deliberately faithful to the NextAuth `signIn` payload the
 * engine already handles, so the exact same policy runs on either engine:
 *
 *  - `account.providerAccountId` — the stable id the engine keys the identity on (accountId → `sub`
 *    → `id`).
 *  - `account.email_verified` — the raw provider claim, kept as a fallback the engine's verified-email
 *    readers (`resolveOAuthEmailVerified`, `resolveEntraEmailVerified`) consult alongside `profile`.
 *  - `profile` — passed through untouched, so the nOAuth claims (`upn`/`xms_edov`/…) and the
 *    normalized `email_verified` reach the engine exactly as the provider produced them.
 *
 * @param provider OAuth provider slug (github | gitlab | azure | google).
 * @param ctx The Better Auth OAuth callback context.
 * @returns The engine payload; safe to pass straight to {@link resolveOAuthSignIn}.
 */
export function mapBetterAuthOAuthPayload(
  provider: string,
  ctx: BetterAuthOAuthContext
): { user: Record<string, unknown>; account: Record<string, unknown>; profile: Record<string, unknown> } {
  const profile = ctx.profile ?? {};
  const tokens = ctx.tokens ?? {};

  return {
    user: {
      email: typeof profile.email === 'string' ? profile.email : null,
      name: typeof profile.name === 'string' ? profile.name : null,
    },
    account: {
      provider,
      providerAccountId: ctx.accountId ?? profile.sub ?? profile.id ?? null,
      access_token: typeof tokens.accessToken === 'string' ? tokens.accessToken : null,
      refresh_token: typeof tokens.refreshToken === 'string' ? tokens.refreshToken : null,
      expires_at: toExpiresAtSeconds(tokens.accessTokenExpiresAt),
      email_verified: profile.email_verified,
    },
    profile,
  };
}

/**
 * Resolve a Better Auth OAuth sign-in end to end through the shared account-resolution engine.
 *
 * Carries the resolution contract the removed NextAuth entry points (`signInForProvider` +
 * `oauthProviderSignIn`) enforced before the OLO-10.14 cutover: an
 * unsupported slug is refused with the stable `provider-not-configured` code; otherwise the context
 * is mapped and run through `resolveOAuthSignIn`, which applies the whole policy (known identity →
 * sign in; verified-email match → auto-link; verified new email → onboarding; unverified/forged →
 * `unverified-email`). A thrown error is contained and reported as a non-admit `false`, so a store or
 * provider fault can never fall through to an admitted sign-in.
 *
 * @param provider OAuth provider slug reported by the callback.
 * @param ctx The Better Auth OAuth callback context (profile + tokens + stable account id).
 * @param linkToUserId Session user id when this round-trip is an explicit "link another provider"
 *   action for this provider; null for a normal sign-in.
 * @param store Persistence operations; defaults to the shared production {@link resolutionStore}.
 * @returns `true` to admit the sign-in, or a redirect path (login error, onboarding wizard, or the
 *   linked-accounts page for link flows).
 */
export async function resolveBetterAuthOAuthSignIn(
  provider: string,
  ctx: BetterAuthOAuthContext,
  linkToUserId: string | null = null,
  store: ResolutionStore = resolutionStore
): Promise<OAuthSignInResult> {
  if (!SUPPORTED_OAUTH_PROVIDERS.has(provider)) {
    return loginErrorRedirect(AUTH_ERROR_CODES.PROVIDER_NOT_CONFIGURED);
  }

  const payload = mapBetterAuthOAuthPayload(provider, ctx);

  try {
    return await resolveOAuthSignIn(provider, payload, linkToUserId, store);
  } catch (error) {
    console.error(`[betterAuthOAuthSignIn] ${provider} resolution failed:`, error);
    return false;
  }
}

/**
 * Extract the OAuth provider slug from a Better Auth callback path, or null when the path is not an
 * OAuth callback (every credential/session/verification request — the hook then no-ops).
 *
 * @param path The Better Auth request path (`ctx.path`), e.g. `/callback/github`.
 * @returns The provider slug (`github`), or null for a non-callback path.
 */
export function oauthProviderFromCallbackPath(path: unknown): string | null {
  if (typeof path !== 'string') return null;
  for (const prefix of [SOCIAL_CALLBACK_PREFIX, OAUTH2_CALLBACK_PREFIX]) {
    if (path.startsWith(prefix)) {
      const slug = path.slice(prefix.length).split(/[/?#]/, 1)[0];
      return slug.length > 0 ? slug : null;
    }
  }
  return null;
}

/** The subset of the Better Auth OAuth callback context this hook reads (structural, internals-free). */
export interface OAuthCallbackMiddlewareContext {
  path?: string;
  /** Set by the provider hook (10.7) once the profile + tokens are available. */
  oauth?: (BetterAuthOAuthContext & { linkToUserId?: string | null }) | null;
  /** Redirect helper Better Auth exposes on the middleware context. */
  redirect?: (url: string) => unknown;
}

/**
 * `hooks` handler that re-homes the resolution engine on the Better Auth OAuth callback (OLO-10.6).
 *
 * The handler is path-gated: it no-ops for every request that is not an OAuth callback (so the
 * credential/session/verification traffic the app serves today is untouched). On an OAuth callback it
 * runs {@link resolveBetterAuthOAuthSignIn}; a non-admit result (a `/login?error=<code>` rejection, an
 * onboarding redirect, or a link-flow redirect) is issued through the context's `redirect` helper so
 * the structured outcome reaches the browser exactly as the NextAuth path's redirect does.
 *
 * The provider hook (10.7) supplies `ctx.oauth` (profile + tokens + link intent) once providers are
 * wired and finalizes the exact lifecycle placement; until then `ctx.oauth` is absent and the handler
 * no-ops. Kept as a bare handler so `auth.ts` can compose it with the credential rate-limit hooks.
 *
 * @param rawCtx The Better Auth middleware context.
 * @param store Persistence operations; defaults to the shared production {@link resolutionStore}.
 */
export async function oauthResolutionHandler(
  rawCtx: unknown,
  store: ResolutionStore = resolutionStore
): Promise<void> {
  const ctx = rawCtx as OAuthCallbackMiddlewareContext;
  const provider = oauthProviderFromCallbackPath(ctx.path);
  if (!provider || !ctx.oauth) {
    return;
  }

  const result = await resolveBetterAuthOAuthSignIn(
    provider,
    ctx.oauth,
    ctx.oauth.linkToUserId ?? null,
    store
  );

  // `true` admits the sign-in — let Better Auth continue. Any string is a redirect (login error,
  // onboarding, or linked-accounts) that must short-circuit the callback.
  if (typeof result === 'string' && typeof ctx.redirect === 'function') {
    throw ctx.redirect(result);
  }
}

/** `hooks` middleware wrapping {@link oauthResolutionHandler} for mounting on the Better Auth instance. */
export const oauthResolutionHook = createAuthMiddleware((ctx) => oauthResolutionHandler(ctx));
