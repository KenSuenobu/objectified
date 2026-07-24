'use client';

/**
 * Single logout entry point for every "Sign out" control.
 *
 * Runs the deterministic server-side cookie clear (serverLogout) *before*
 * handing off to the client `signOut`, so the durable last-active-tenant cookie
 * (and any lingering legacy session cookie) is cleared too. The client `signOut`
 * (`session-client.tsx`) then clears the Better Auth session and performs the
 * redirect.
 */

import { signOut } from './session-client';
import { serverLogout } from './logout-actions';

/**
 * Sign the user out everywhere and redirect to `callbackUrl`.
 *
 * @param callbackUrl Where to land after sign-out (e.g. `/login`, or the main
 *   app's `/login` when signing out from the studio shell).
 */
export async function signOutEverywhere(callbackUrl: string): Promise<void> {
  // Best-effort: a server-clear failure must not block the client sign-out and
  // redirect, which still expires the session the normal way.
  try {
    await serverLogout();
  } catch (error) {
    console.error('[auth] server-side logout cookie clear failed:', error);
  }
  await signOut(callbackUrl);
}
