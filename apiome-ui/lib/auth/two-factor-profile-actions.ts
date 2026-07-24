'use server';

/**
 * Profile self-service helpers for 2FA management (OLO-9.15 #5015).
 *
 * Better Auth exposes `viewBackupCodes` as a server-only API (no client method) and stores
 * trusted-device skip as a signed `trust_device` cookie — not a listable multi-device table.
 * These actions bridge that into the Profile Security UI: remaining backup-code count,
 * whether *this browser* is trusted, and revoke-this-device (expire cookie + drop verification).
 *
 * Next.js requires every export from a `'use server'` file to be an async server action.
 */

import { cookies, headers } from 'next/headers';
import { constantTimeEqual, makeSignature } from 'better-auth/crypto';
import { getSharedCookieDomain } from './cookie-options';
import { resolveBetterAuthSecret } from './better-auth-session';
import {
  TRUST_DEVICE_COOKIE_NAMES,
} from './two-factor-trust-cookie';

/**
 * Read the Better Auth trust-device cookie value from the request cookie jar, if present.
 *
 * @param store Next.js cookie store.
 * @returns Raw cookie value, or `null` when neither name is set.
 */
function readTrustDeviceCookieValue(store: {
  get: (name: string) => { value: string } | undefined;
}): string | null {
  for (const name of TRUST_DEVICE_COOKIE_NAMES) {
    const value = store.get(name)?.value;
    if (value) return value;
  }
  return null;
}

/**
 * Verify a Better Auth signed cookie and return the unsigned payload (`token!trustIdentifier`).
 *
 * Mirrors `better-call`'s `getSignedCookie` signature check so we can extract the trust identifier
 * without an endpoint context.
 *
 * @param raw Cookie value from the jar (URI-decoded).
 * @param secret Better Auth signing secret.
 * @returns Unsigned payload, or `null` when missing/invalid.
 */
async function unsignTrustDeviceCookie(
  raw: string,
  secret: string
): Promise<string | null> {
  const signatureStartPos = raw.lastIndexOf('.');
  if (signatureStartPos < 1) return null;
  const signedValue = raw.substring(0, signatureStartPos);
  const signature = raw.substring(signatureStartPos + 1);
  if (signature.length !== 44 || !signature.endsWith('=')) return null;
  const expected = await makeSignature(signedValue, secret);
  return constantTimeEqual(signature, expected) ? signedValue : null;
}

/**
 * Expire both trust-device cookie name variants (host-only and shared-domain when configured).
 *
 * @param store Next.js mutable cookie store.
 */
function expireTrustDeviceCookies(store: {
  set: (name: string, value: string, options: Record<string, unknown>) => void;
}): void {
  const domain = getSharedCookieDomain();
  for (const name of TRUST_DEVICE_COOKIE_NAMES) {
    const secure = name.startsWith('__') || process.env.NODE_ENV === 'production';
    const base = {
      path: '/',
      httpOnly: true,
      sameSite: 'lax' as const,
      secure,
      maxAge: 0,
    };
    store.set(name, '', base);
    if (domain) {
      store.set(name, '', { ...base, domain });
    }
  }
}

/**
 * Return how many unused backup codes remain for the signed-in user.
 *
 * Calls Better Auth's server-only `viewBackupCodes` with the session user id. Used codes are
 * removed from the stored set, so `backupCodes.length` is the remaining count.
 *
 * @returns `{ remaining }` — `null` when unauthenticated, 2FA is off, or the lookup fails.
 */
export async function getBackupCodeStatus(): Promise<{ remaining: number | null }> {
  const { getAuthSession } = await import('./server-session');
  const session = await getAuthSession();
  if (!session?.user?.user_id || !session.user.twoFactorEnabled) {
    return { remaining: null };
  }

  try {
    const { auth } = await import('./auth');
    const result = (await auth.api.viewBackupCodes({
      body: { userId: session.user.user_id },
      headers: await headers(),
    })) as { backupCodes?: string[] } | null;

    if (!Array.isArray(result?.backupCodes)) {
      return { remaining: null };
    }
    return { remaining: result.backupCodes.length };
  } catch (error) {
    console.warn(
      '[auth] viewBackupCodes failed:',
      error instanceof Error ? error.name : 'unknown'
    );
    return { remaining: null };
  }
}

/**
 * Whether the current browser holds a Better Auth trust-device cookie.
 *
 * Presence is enough for the profile UI; full HMAC validation happens on the next credential
 * sign-in (and on revoke).
 *
 * @returns `{ trusted: true }` when a trust-device cookie is present.
 */
export async function getTrustedDeviceStatus(): Promise<{ trusted: boolean }> {
  const store = await cookies();
  return { trusted: Boolean(readTrustDeviceCookieValue(store)) };
}

/**
 * Forget this browser as a trusted device: delete the verification row (when the signed cookie
 * can be parsed) and expire the trust-device cookie variants.
 *
 * Does not affect other browsers — Better Auth has no multi-device trust list.
 *
 * @returns `{ ok: true }` when the session is valid and cookies were cleared (even if no cookie
 *   was present); `{ ok: false }` when unauthenticated.
 */
export async function revokeThisTrustedDevice(): Promise<{ ok: boolean }> {
  const { getAuthSession } = await import('./server-session');
  const session = await getAuthSession();
  if (!session?.user?.user_id) {
    return { ok: false };
  }

  const store = await cookies();
  const raw = readTrustDeviceCookieValue(store);
  const secret = resolveBetterAuthSecret();

  if (raw && secret) {
    try {
      const unsigned = await unsignTrustDeviceCookie(raw, secret);
      const trustId = unsigned?.split('!')[1];
      if (trustId) {
        const { auth } = await import('./auth');
        const ctx = await auth.$context;
        await ctx.internalAdapter.deleteVerificationByIdentifier(trustId);
      }
    } catch (error) {
      // Cookie expiry still proceeds — orphaned verification rows expire on their own TTL.
      console.warn(
        '[auth] trust-device verification cleanup failed:',
        error instanceof Error ? error.name : 'unknown'
      );
    }
  }

  expireTrustDeviceCookies(store);
  return { ok: true };
}
