/**
 * Better Auth → apiome session shape (OLO-10.12, #5007).
 *
 * The whole app consumes a NextAuth-shaped session: `session.user.user_id` and
 * `session.user.current_tenant_id`, not Better Auth's native `session.user.id` (and no tenant at
 * all). To keep every session surface identical on either engine (the parallel-run invariant, see
 * `auth-engine.ts`), this module is the single place that maps a Better Auth session onto the app
 * contract:
 *
 * ```
 * { user: { user_id, email, name, image?, current_tenant_id? }, expires }
 * ```
 *
 * - `user_id` is Better Auth's `user.id`.
 * - `current_tenant_id` is **derived at read time** from the durable last-active-tenant cookie
 *   (OLO-6.1), re-validated against the user's live memberships — the exact logic the legacy NextAuth
 *   `jwt` callback ran at login (removed at the OLO-10.14 cutover), moved to read time because a Better
 *   Auth database session carries no custom claim. No schema change is needed.
 *
 * Consumed by the Better Auth `customSession` plugin (`auth.ts`), so `auth.api.getSession()` and the
 * browser `/api/auth/get-session` both return the contract shape from one source, and by the
 * engine-aware server reader (`server-session.ts`).
 */

import { resolveActiveTenantForLogin } from './post-login-routing';
import { readLastActiveTenantId } from './last-active-tenant';

/** The app-contract user carried on every session, on either auth engine. */
export interface AppSessionUser {
  /** apiome user id — Better Auth's `user.id`. */
  user_id: string;
  /** Primary email. */
  email: string;
  /** Display name, when set. */
  name?: string | null;
  /** Avatar URL, when set. */
  image?: string | null;
  /** The active tenant, validated against live memberships; absent for tenant-less users. */
  current_tenant_id?: string;
}

/** The app-contract session shape (matches the NextAuth `Session` the UI already consumes). */
export interface AppSession {
  user: AppSessionUser;
  /** ISO-8601 expiry, mirroring NextAuth's `session.expires`. */
  expires: string;
}

/**
 * The minimal Better Auth user fields this mapping reads. Better Auth's `User` carries more; only
 * these are needed to build {@link AppSessionUser}.
 */
export interface BetterAuthUserLike {
  id: string;
  email: string;
  name?: string | null;
  image?: string | null;
}

/**
 * Resolve the active tenant for a user at session-read time.
 *
 * Reads the durable last-active-tenant cookie candidate and re-validates it against live memberships
 * ({@link resolveActiveTenantForLogin}), so a stale or tampered cookie can never point session-scoped
 * queries at a tenant the user does not belong to. **Fail-safe:** any error (cookie/DB) yields
 * `undefined` so a session read never breaks — mirroring the NextAuth `jwt` callback's fail-closed
 * `delete token.current_tenant_id` path.
 *
 * @param userId The authenticated user's id.
 * @returns The validated active tenant id, or `undefined` when there is none / on error.
 */
export async function deriveCurrentTenantId(userId: string): Promise<string | undefined> {
  try {
    const candidate = await readLastActiveTenantId();
    const tenant = await resolveActiveTenantForLogin(userId, candidate);
    return tenant ?? undefined;
  } catch (error) {
    console.error('[better-auth-session] active-tenant derivation failed:', error);
    return undefined;
  }
}

/**
 * Build the app-contract user for a Better Auth user, deriving the validated active tenant.
 *
 * Used by the engine-aware server reader (`server-session.ts`), which needs the clean contract shape.
 *
 * @param user The Better Auth session user.
 * @returns The {@link AppSessionUser} the app expects, with `current_tenant_id` when one resolves.
 */
export async function toAppSessionUser(user: BetterAuthUserLike): Promise<AppSessionUser> {
  const current_tenant_id = await deriveCurrentTenantId(user.id);
  return {
    user_id: user.id,
    email: user.email,
    name: user.name ?? null,
    image: user.image ?? null,
    ...(current_tenant_id ? { current_tenant_id } : {}),
  };
}

/**
 * Augment a Better Auth session user **in place of shape** — keep every native field and add the app
 * contract's `user_id` (= `user.id`) and validated `current_tenant_id`.
 *
 * Used by the `customSession` plugin (`auth.ts`): it must **preserve** the native fields (`id`,
 * `emailVerified`, …) so the browser client keeps them and the server reader can still read `user.id`
 * off a transformed `auth.api.getSession()` result — unlike {@link toAppSessionUser}, which returns
 * only the trimmed contract.
 *
 * @param user The full Better Auth session user.
 * @returns The same user with `user_id` and (when one resolves) `current_tenant_id` added.
 */
export async function augmentBetterAuthUser<T extends BetterAuthUserLike>(
  user: T
): Promise<T & { user_id: string; current_tenant_id?: string }> {
  const current_tenant_id = await deriveCurrentTenantId(user.id);
  return {
    ...user,
    user_id: user.id,
    ...(current_tenant_id ? { current_tenant_id } : {}),
  };
}
