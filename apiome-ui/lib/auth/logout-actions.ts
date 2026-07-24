'use server';

/**
 * Deterministic server-side logout companion to the Better Auth client `signOut`.
 *
 * The Better Auth client `signOut` (`authClient.signOut`, via `session-client.tsx`) owns clearing the
 * live session: it deletes the session row server-side and expires the Better Auth session cookie. This
 * action covers the two things that clear does not:
 *
 *   1. **The durable `apiome.last-active-tenant` cookie** (OLO-6.1) — the tenant hint is not part of the
 *      auth session, so `signOut` never removes it; leaving it would silently restore the old tenant on
 *      the next login. This is the primary reason the action still exists.
 *   2. **Any lingering legacy NextAuth session cookie** — a transitional cleanup for users whose
 *      pre-cutover (OLO-10.14) `__Secure-next-auth.session-token` is still in the browser (up to its
 *      30-day TTL). Better Auth ignores these cookies, but expiring them on logout keeps the browser
 *      tidy. Safe to drop once the cutover bake window has passed.
 *
 * Shared-cookie aware: a plain host-only expiry does not remove a cookie scoped to
 * `NEXTAUTH_COOKIE_DOMAIN`, so both a host-only and a domain-scoped expiry are emitted in production.
 */

import { cookies } from 'next/headers';
import { getSharedCookieDomain } from './cookie-options';
import { LAST_ACTIVE_TENANT_COOKIE } from './last-active-tenant';

/**
 * Legacy NextAuth session-token cookie names, across dev (unprefixed) and production
 * (`__Secure-`/`__Host-` prefixed) configs. Expired transitionally so a logout also clears a
 * pre-cutover session cookie still held by the browser (see the module doc); Better Auth's own cookie
 * is cleared by `authClient.signOut`.
 */
const SESSION_COOKIE_NAMES = [
  'next-auth.session-token',
  '__Secure-next-auth.session-token',
  '__Host-next-auth.session-token',
] as const;

/**
 * Clear the durable last-active-tenant cookie and any lingering legacy session cookie so a logout
 * deterministically ends the session (alongside `authClient.signOut`, which clears the live Better
 * Auth session).
 *
 * Safe to call redundantly: expiring an absent cookie is a no-op.
 */
export async function serverLogout(): Promise<void> {
  const store = await cookies();
  const domain = getSharedCookieDomain();

  // Durable tenant hint: host-scoped only, so a single host-only delete suffices.
  store.delete(LAST_ACTIVE_TENANT_COOKIE);

  for (const name of SESSION_COOKIE_NAMES) {
    // `__Secure-`/`__Host-` cookies only ever exist over https, so they must be
    // expired with Secure to match; the unprefixed dev cookie follows NODE_ENV.
    const secure = name.startsWith('__') || process.env.NODE_ENV === 'production';
    const base = {
      path: '/',
      httpOnly: true,
      sameSite: 'lax' as const,
      secure,
      maxAge: 0,
    };

    // Host-only expiry — removes the dev cookie and any host-scoped session.
    store.set(name, '', base);

    // Domain-scoped expiry for the shared cross-subdomain cookie. `__Host-`
    // cookies are host-locked and cannot carry a Domain, so they are excluded.
    if (domain && !name.startsWith('__Host-')) {
      store.set(name, '', { ...base, domain });
    }
  }
}
