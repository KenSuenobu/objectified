'use client';

/**
 * Better Auth browser transport for the engine-aware session compat layer (OLO-10.12, #5007;
 * 2FA login branch OLO-9.13 #5014).
 *
 * The browser transport behind `session-client.tsx`: it drives `authClient.*` for `signIn` /
 * `signOut` / session-update. The session **read** is a React hook (`authClient.useSession`) consumed
 * directly in `session-client.tsx`; this module carries the pure session mapper plus the imperative
 * mutations. (Before the OLO-10.14 cutover this was the Better Auth half of an engine-dispatched pair
 * whose NextAuth counterpart, `next-auth-client-compat.ts`, was removed with the flag.)
 */

import { authClient } from './auth-client';
import type { AppSession } from './better-auth-session-shape';
import { browserNavigate } from './browser-navigate';
import {
  storeTwoFactorCallbackUrl,
  twoFactorLoginPath,
} from './two-factor-callback';

/** The `{ user, session }` payload `authClient.useSession()` exposes as `data` (or `null`). */
interface BetterAuthSessionData {
  user?: {
    id?: string;
    user_id?: string;
    email?: string;
    name?: string | null;
    image?: string | null;
    current_tenant_id?: string;
    twoFactorEnabled?: boolean | null;
  } | null;
  session?: { expiresAt?: string | Date } | null;
}

/**
 * Map a Better Auth session payload onto the app contract.
 *
 * The server `customSession` plugin already injects `user_id`/`current_tenant_id` onto the user, so
 * this is mostly a re-key; `user.id` is the fallback for `user_id`. `twoFactorEnabled` /
 * `twoFactorElevated` come from the twoFactor plugin user flag (OLO-9.13).
 *
 * @param data The `data` from `authClient.useSession()`.
 * @returns The app-shaped session, or `null` when signed out.
 */
export function mapBetterAuthSession(data: BetterAuthSessionData | null | undefined): AppSession | null {
  const user = data?.user;
  if (!user) {
    return null;
  }
  const userId = user.user_id ?? user.id;
  if (!userId) {
    return null;
  }
  const twoFactorEnabled = Boolean(user.twoFactorEnabled);
  return {
    user: {
      user_id: userId,
      email: user.email ?? '',
      name: user.name ?? null,
      image: user.image ?? null,
      twoFactorEnabled,
      ...(user.current_tenant_id ? { current_tenant_id: user.current_tenant_id } : {}),
    },
    expires: data?.session?.expiresAt
      ? new Date(data.session.expiresAt).toISOString()
      : '',
    twoFactorElevated: twoFactorEnabled,
  };
}

/**
 * Sign in via Better Auth and navigate on completion, matching the `signIn(provider, …)` contract.
 *
 * - OAuth provider → `authClient.signIn.oauth2` (generic-OAuth plugin) initiates the redirect flow.
 * - credentials with a password → `authClient.signIn.email`; on `twoFactorRedirect` stop and let the
 *   `twoFactorClient` hook send the user to `/login/2fa` (OLO-9.13); otherwise navigate to
 *   `callbackUrl` on success or `/login?error=CredentialsSignin` on failure.
 * - credentials with only a `oneTimeCode` → redeemed through the `completeOneTimeCodeSignIn` server
 *   action (OLO-10.13), which drives the Better Auth `/one-time-code/verify` endpoint to establish the
 *   session and seed the active tenant. On success navigate to `callbackUrl`; on failure land on the
 *   login error contract, matching the password path.
 *
 * @param provider `'credentials'` or an OAuth provider id.
 * @param options `callbackUrl` and, for credentials, the `payload` JSON blob.
 */
export async function signInBetterAuth(
  provider: string,
  options: { callbackUrl?: string; payload?: string } = {}
): Promise<void> {
  const callbackUrl = options.callbackUrl ?? window.location.href;

  if (provider !== 'credentials') {
    const res = await authClient.signIn.oauth2({ providerId: provider, callbackURL: callbackUrl });
    const url = (res?.data as { url?: string } | undefined)?.url;
    if (url) {
      browserNavigate(url);
    }
    return;
  }

  const parsed = JSON.parse(options.payload ?? '{}') as {
    email?: string;
    password?: string;
    oneTimeCode?: string;
  };

  if (!parsed.password) {
    // One-time-code sign-in (OAuth-signup completion / invite): redeem the single-use code through the
    // server action, which drives the Better Auth `/one-time-code/verify` endpoint (OLO-10.13). A
    // missing/invalid code lands on the same login error contract as a bad password.
    const oneTimeCode = parsed.oneTimeCode?.trim();
    if (!oneTimeCode) {
      browserNavigate(`/login?error=CredentialsSignin&callbackUrl=${encodeURIComponent(callbackUrl)}`);
      return;
    }
    const { completeOneTimeCodeSignIn } = await import('./better-auth-one-time-code-actions');
    const result = await completeOneTimeCodeSignIn(oneTimeCode);
    if (!result.ok) {
      browserNavigate(`/login?error=CredentialsSignin&callbackUrl=${encodeURIComponent(callbackUrl)}`);
      return;
    }
    browserNavigate(callbackUrl);
    return;
  }

  // Stash callback before sign-in so onTwoFactorRedirect can build /login/2fa?callbackUrl=…
  storeTwoFactorCallbackUrl(callbackUrl);

  const res = await authClient.signIn.email({
    email: parsed.email ?? '',
    password: parsed.password,
    callbackURL: callbackUrl,
  });
  if (res?.error) {
    browserNavigate(`/login?error=CredentialsSignin&callbackUrl=${encodeURIComponent(callbackUrl)}`);
    return;
  }
  // Pending second factor: do not navigate to callbackUrl (no full session yet). The twoFactorClient
  // onTwoFactorRedirect hook navigates to /login/2fa; if it did not run (e.g. tests), fall through here.
  if ((res?.data as { twoFactorRedirect?: boolean } | null | undefined)?.twoFactorRedirect) {
    browserNavigate(twoFactorLoginPath(callbackUrl));
    return;
  }
  browserNavigate(callbackUrl);
}

/**
 * Sign out via Better Auth and navigate to `callbackUrl`.
 *
 * @param callbackUrl Where to land after sign-out.
 */
export async function signOutBetterAuth(callbackUrl: string): Promise<void> {
  await authClient.signOut();
  browserNavigate(callbackUrl);
}

/**
 * Update the signed-in user's display name via Better Auth. The client refetches the session store
 * automatically after a successful `updateUser`.
 *
 * @param name The new display name.
 */
export async function updateUserNameBetterAuth(name: string): Promise<void> {
  await authClient.updateUser({ name });
}
