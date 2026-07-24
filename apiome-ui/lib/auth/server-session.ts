/**
 * Server-side session reader (OLO-10.12 #5007; Better-Auth-only since the OLO-10.14 cutover #5009).
 *
 * The whole server — ~106 API route handlers plus the server components/actions that guard protected
 * routes — reads the current session through this one helper. It reads the Better Auth database session
 * (`auth.api.getSession`) and maps it onto the app contract (`session.user.user_id` /
 * `current_tenant_id`) via `toAppSessionUser` (`user_id` = `user.id`, `current_tenant_id` derived from
 * the validated last-active cookie). The mapping is applied here rather than relying on the server
 * `customSession` plugin so a direct `auth.api.getSession()` call is shaped identically to the browser's
 * `/get-session`.
 *
 * Before the cutover this dispatched by `AUTH_ENGINE` (NextAuth `getServerSession` vs Better Auth); the
 * NextAuth branch and the flag were removed with the rest of the parallel-run scaffolding in OLO-10.14.
 *
 * This is a plain server module (no `'use server'`): every caller is server-side (route handlers,
 * server components, other server modules), so exporting a normal async function — rather than a
 * server action — keeps API routes off server-action semantics while its existing callers are
 * unchanged.
 */

import type { AppSession } from './better-auth-session-shape';

/**
 * The session shape returned to callers — the app contract. Every consumer reads
 * `session.user.user_id` / `current_tenant_id` (and occasionally `email`/`name`).
 */
export type AuthSession = AppSession;

/**
 * Returns the current server session in the app-contract shape, or `null` when called outside an
 * authenticated request context (e.g. in unit tests with no mock, or when there is no active session).
 *
 * @returns The current session, or `null` when unauthenticated.
 */
export async function getAuthSession(): Promise<AuthSession | null> {
  const { headers } = await import('next/headers');
  const { auth } = await import('./auth');
  const { toAppSessionUser } = await import('./better-auth-session-shape');

  const result = await auth.api.getSession({ headers: await headers() });
  if (!result?.user) {
    return null;
  }
  return {
    user: await toAppSessionUser(result.user),
    expires: new Date(result.session.expiresAt).toISOString(),
  };
}
