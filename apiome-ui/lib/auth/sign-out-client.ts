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

import { authClient } from './auth-client';
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

/**
 * End **every** session on the account — this browser and all the others — then sign out here
 * (HIVE-4.7, #5301).
 *
 * The difference from {@link signOutEverywhere} is what "everywhere" means. That one clears
 * this browser's cookies across the suite's shared domain; the session rows belonging to the
 * reader's phone, their laptop at home and any browser they signed in on last month all
 * survive it. This one deletes those rows first, through Better Auth's `POST
 * /api/auth/revoke-sessions`, which is what Profile's session card offers — the control a
 * reader reaches for after losing a device.
 *
 * The revoke is best-effort in exactly one direction: if it fails, the local sign-out still
 * happens, because a reader who asked to be signed out and was left signed in is the worse
 * of the two failures. The caller is told, so it can say so.
 *
 * @param callbackUrl Where to land after sign-out.
 * @returns `true` when every session was revoked; `false` when only the local sign-out ran.
 */
export async function revokeAllSessionsAndSignOut(callbackUrl: string): Promise<boolean> {
  let revoked = false;
  try {
    const result = await authClient.revokeSessions();
    revoked = !result?.error;
  } catch (error) {
    console.error('[auth] revoking every session failed; signing out locally anyway:', error);
  }
  await signOutEverywhere(callbackUrl);
  return revoked;
}
