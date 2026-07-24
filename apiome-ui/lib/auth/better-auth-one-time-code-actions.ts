'use server';

/**
 * Server action bridging the browser's one-time-code sign-in onto the Better Auth engine
 * (OLO-10.13, #5008).
 *
 * The OAuth-signup wizard finishes by calling `signIn('credentials', { payload: { oneTimeCode } })`
 * (`src/app/signup/oauth/OauthSignupClient.tsx`). On the Better Auth engine the client compat layer
 * (`better-auth-client-compat.ts`) routes that through here. This action:
 *
 *   1. redeems the code via the Better Auth endpoint {@link oneTimeCodePlugin} (`auth.api.verifyOneTimeCode`),
 *      which consumes the single-use code, creates a Better Auth session, and sets the session cookie —
 *      forwarded to the response by the `nextCookies()` plugin (why it must stay last in `auth.ts`);
 *   2. writes the app-owned durable last-active-tenant cookie to the pending tenant the code carried,
 *      so the session's `current_tenant_id` — derived at read time from that cookie
 *      (`better-auth-session-shape.ts`) — matches what the legacy NextAuth `jwt` callback set from
 *      `pending_tenant_id` before the OLO-10.14 cutover.
 *
 * `auth` is imported lazily so the Better Auth module graph is only loaded on the code paths that need
 * it, matching the route handler's lazy import.
 */

import { cookies, headers } from 'next/headers';
import {
  LAST_ACTIVE_TENANT_COOKIE,
  LAST_ACTIVE_TENANT_MAX_AGE_SECONDS,
  isWellFormedTenantId,
} from './last-active-tenant';
import type { VerifyOneTimeCodeResult } from './better-auth-one-time-code';

/**
 * Complete a one-time-code sign-in on the Better Auth engine.
 *
 * @param oneTimeCode The single-use code issued by the OAuth-signup completion.
 * @returns `{ ok: true }` when the session was established; `{ ok: false }` when the code was
 *   missing, invalid, or expired (the caller redirects to the login error contract).
 */
export async function completeOneTimeCodeSignIn(
  oneTimeCode: string
): Promise<{ ok: boolean }> {
  const code = oneTimeCode?.trim();
  if (!code) {
    return { ok: false };
  }
  try {
    // Lazy so the Better Auth engine's deps stay unloaded on the NextAuth engine.
    const { auth } = await import('./auth');
    const result = (await auth.api.verifyOneTimeCode({
      body: { oneTimeCode: code },
      headers: await headers(),
    })) as VerifyOneTimeCodeResult;

    // Seed the durable active tenant so the derived session tenant matches the NextAuth path. The id
    // is re-shape-checked here (defence in depth) even though the endpoint returns a trusted value.
    if (result?.tenantId && isWellFormedTenantId(result.tenantId)) {
      const store = await cookies();
      store.set(LAST_ACTIVE_TENANT_COOKIE, result.tenantId, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: LAST_ACTIVE_TENANT_MAX_AGE_SECONDS,
      });
    }
    return { ok: true };
  } catch (error) {
    // A bad/expired code throws an APIError; surface a clean failure so the caller shows the login
    // error banner rather than leaking the reason.
    console.warn(
      '[auth] one-time-code sign-in failed on the Better Auth engine:',
      error instanceof Error ? error.name : 'unknown'
    );
    return { ok: false };
  }
}
