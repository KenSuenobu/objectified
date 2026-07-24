import { getSharedCookieDomain, trustedAppOrigins } from './cookie-options';

/**
 * Better Auth session strategy & cookie parity (OLO-10.3, migration design §1).
 *
 * Database sessions with a 30-day lifetime, 24h refresh, short signed cookie cache, and
 * cross-subdomain cookie scoping via {@link getSharedCookieDomain}. Signing uses
 * `BETTER_AUTH_SECRET` (see {@link resolveBetterAuthSecret}); the public origin is
 * `BETTER_AUTH_URL` (see {@link resolveBetterAuthBaseUrl}).
 *
 * See `docs/BETTER_AUTH_MIGRATION.md` §1.
 */

/**
 * Session lifetime in seconds — **30 days**.
 */
export const SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 30;

/**
 * Session refresh cadence in seconds — **24 hours**.
 *
 * An active session's expiry is slid forward at most once per day, so a continuously-used session
 * never lapses while an idle one still expires after {@link SESSION_EXPIRES_IN_SECONDS}.
 */
export const SESSION_UPDATE_AGE_SECONDS = 60 * 60 * 24;

/**
 * Cookie-cache TTL in seconds — **60 seconds**.
 *
 * Caches a signed snapshot of the session in the cookie so most requests skip the session-table
 * lookup while keeping the window in which a revoked session is still honoured to at most a minute.
 */
export const SESSION_COOKIE_CACHE_MAX_AGE_SECONDS = 60;

/**
 * Resolve the Better Auth (and REST JWT) signing secret.
 *
 * Reads `BETTER_AUTH_SECRET` only. Blank/whitespace counts as unset. For **non-destructive**
 * rotation Better Auth also reads the versioned `BETTER_AUTH_SECRETS` env var natively
 * (`2:<new>,1:<old>`); because sessions are DB rows, rotating the secret only invalidates the
 * signed cookie cache and never logs a user out. See `docs/BETTER_AUTH_MIGRATION.md` §1.
 *
 * @returns The active signing secret, or `undefined` when unset (Better Auth then raises its own
 *   missing-secret error at construction).
 */
export function resolveBetterAuthSecret(): string | undefined {
  const secret = process.env.BETTER_AUTH_SECRET?.trim();
  return secret || undefined;
}

/**
 * Resolve Better Auth's public `baseURL` (the origin OAuth callback URLs are built from).
 *
 * Reads `BETTER_AUTH_URL` only. Blank/whitespace counts as unset.
 *
 * @returns The public origin, or `undefined` when unset.
 */
export function resolveBetterAuthBaseUrl(): string | undefined {
  const url = process.env.BETTER_AUTH_URL?.trim();
  return url || undefined;
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
 * Reuses {@link getSharedCookieDomain} (`BETTER_AUTH_COOKIE_DOMAIN` in production, otherwise
 * inferred from app URLs). On localhost/dev (or when no parent domain can be resolved) returns
 * `undefined`, leaving Better Auth on host-only cookies.
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
 * Auth's default.
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
 * Includes the configured app/studio origins ({@link trustedAppOrigins}) and a wildcard for every
 * subdomain under the shared cookie domain (e.g. `https://*.apiome.dev`). On dev/localhost (no
 * shared domain) only the explicit app origins are trusted.
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
