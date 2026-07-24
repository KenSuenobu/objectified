import { getSharedCookieDomain, trustedAppOrigins } from './cookie-options';

/**
 * Better Auth session strategy & cookie parity (OLO-10.3, migration design §1).
 *
 * The 10.1 decision record chose Better Auth's native **database sessions** over the legacy stateless
 * JWT-only model. This module realises the concrete session parameters that decision left to 10.3 so
 * that the cutover to Better Auth did **not** change what a signed-in user experiences:
 *
 * - the session lifetime and refresh cadence match NextAuth v4's JWT defaults, so no user is logged
 *   out early at cutover;
 * - the session cookie is scoped to the same parent domain as today (`NEXTAUTH_COOKIE_DOMAIN` / the
 *   inferred registrable domain) so a login stays shared across the app's subdomains (e.g. the studio);
 * - a short-lived signed cookie cache keeps most requests off the session-table read, approximating
 *   today's zero-DB-read stateless cookie;
 * - the signing secret reuses `NEXTAUTH_SECRET` but can be overridden/rotated without a code change.
 *
 * The builders are pure functions of the environment so they can be unit-tested in isolation and are
 * consumed once by `lib/auth/auth.ts` when the Better Auth instance is constructed. See
 * `docs/BETTER_AUTH_MIGRATION.md` §1.
 */

/**
 * Session lifetime in seconds — **30 days**.
 *
 * Matches NextAuth v4's implicit JWT `maxAge` default (`60 * 60 * 24 * 30`) so existing sessions keep
 * the same absolute expiry at cutover and nobody is signed out early (design §1).
 */
export const SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 30;

/**
 * Session refresh cadence in seconds — **24 hours**.
 *
 * Mirrors NextAuth v4's `updateAge` default: an active session's expiry is slid forward at most once
 * per day, so a continuously-used session never lapses while an idle one still expires after
 * {@link SESSION_EXPIRES_IN_SECONDS}.
 */
export const SESSION_UPDATE_AGE_SECONDS = 60 * 60 * 24;

/**
 * Cookie-cache TTL in seconds — **60 seconds**.
 *
 * Better Auth can cache a signed snapshot of the session in the cookie so most requests are served
 * without the session-table lookup. A short TTL preserves the near-zero session-read cost of today's
 * stateless model while keeping the window in which a revoked session is still honoured to at most a
 * minute (design §1).
 */
export const SESSION_COOKIE_CACHE_MAX_AGE_SECONDS = 60;

/**
 * Resolve the Better Auth signing secret, with a rotation-friendly precedence.
 *
 * `BETTER_AUTH_SECRET` takes over from `NEXTAUTH_SECRET` when set, so the app can migrate onto a
 * dedicated secret without editing code. For **non-destructive** rotation Better Auth also reads the
 * versioned `BETTER_AUTH_SECRETS` env var natively (`2:<new>,1:<old>`); because sessions are rows in
 * the database rather than the cookie itself, rotating the secret only invalidates the signed cookie
 * cache (a one-time extra DB read per session) and never logs a user out. See
 * `docs/BETTER_AUTH_MIGRATION.md` §1 for the documented rotation path.
 *
 * @returns The active signing secret, or `undefined` when neither env var is set (Better Auth then
 *   raises its own missing-secret error at construction, matching the legacy engine's behaviour).
 */
export function resolveBetterAuthSecret(): string | undefined {
  return process.env.BETTER_AUTH_SECRET?.trim() || process.env.NEXTAUTH_SECRET;
}

/**
 * Build the Better Auth `session` options block.
 *
 * @returns The session lifetime, refresh cadence and cookie-cache configuration to pass to
 *   `betterAuth({ session })`.
 */
export function buildBetterAuthSessionOptions() {
  return {
    expiresIn: SESSION_EXPIRES_IN_SECONDS,
    updateAge: SESSION_UPDATE_AGE_SECONDS,
    cookieCache: {
      enabled: true,
      maxAge: SESSION_COOKIE_CACHE_MAX_AGE_SECONDS,
    },
  };
}

/**
 * Build Better Auth's cross-subdomain cookie configuration for the current environment.
 *
 * Reuses {@link getSharedCookieDomain} — the same parent-domain resolution NextAuth uses today
 * (`NEXTAUTH_COOKIE_DOMAIN` in production, otherwise inferred from the app URLs) — so the Better Auth
 * session cookie is written on exactly the domain the legacy cookie is. On localhost/dev (or when no
 * parent domain can be resolved) the function returns `undefined`, leaving Better Auth on host-only
 * cookies just as today.
 *
 * @returns `{ enabled: true, domain }` scoped to the shared parent domain, or `undefined` for
 *   host-only (dev / no shared domain).
 */
export function buildBetterAuthCrossSubDomainCookies():
  | { enabled: true; domain: string }
  | undefined {
  const domain = getSharedCookieDomain();
  if (!domain) return undefined;
  return { enabled: true, domain };
}

/**
 * Build the Better Auth `advanced` options block.
 *
 * Only cross-subdomain cookie scoping is set here; every other cookie attribute (`httpOnly`,
 * `sameSite=lax`, `secure` in production, and the `__Secure-`/`__Host-` prefixes) is already Better
 * Auth's default and matched the legacy NextAuth cookie overrides, so it is left untouched.
 *
 * @returns The `advanced` config, carrying `crossSubDomainCookies` only when a shared parent domain
 *   applies; an empty object otherwise.
 */
export function buildBetterAuthAdvancedOptions() {
  const crossSubDomainCookies = buildBetterAuthCrossSubDomainCookies();
  return crossSubDomainCookies ? { crossSubDomainCookies } : {};
}

/**
 * Build the Better Auth `trustedOrigins` list.
 *
 * Better Auth validates `callbackURL`/`redirectTo` and cross-site origins against this list. To keep
 * the cross-subdomain login behaviour of today's `isAllowedCallbackUrl`, it includes:
 *
 * - the configured app/studio origins ({@link trustedAppOrigins}), and
 * - a wildcard for every subdomain under the shared cookie domain (e.g. `https://*.apiome.dev`) so a
 *   login can still return to a sibling subdomain covered by the shared session cookie.
 *
 * On dev/localhost (no shared domain) only the explicit app origins are trusted.
 *
 * @returns The de-duplicated list of trusted origins for `betterAuth({ trustedOrigins })`.
 */
export function buildBetterAuthTrustedOrigins(): string[] {
  const origins = new Set<string>(trustedAppOrigins());
  const domain = getSharedCookieDomain();
  if (domain) {
    // `domain` already begins with a dot (e.g. `.apiome.dev`), yielding `https://*.apiome.dev`.
    origins.add(`https://*${domain}`);
  }
  return [...origins];
}
