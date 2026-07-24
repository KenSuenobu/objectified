/**
 * Preserve the post-login destination across the TOTP second step (OLO-9.13 #5014).
 *
 * Better Auth's `onTwoFactorRedirect` does not receive `callbackURL`. Password sign-in stores the
 * intended destination here before `signIn.email`; the `/login/2fa` page reads it after verify.
 */

/** sessionStorage key for the callback URL awaiting TOTP verification. */
export const TWO_FACTOR_CALLBACK_STORAGE_KEY = 'apiome:2fa-callbackUrl';

/** Default landing when no callback was stored. */
export const TWO_FACTOR_DEFAULT_CALLBACK = '/ade';

/**
 * Remember where to send the user after a successful TOTP verify.
 *
 * @param callbackUrl Absolute or relative URL from the login form.
 */
export function storeTwoFactorCallbackUrl(callbackUrl: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(TWO_FACTOR_CALLBACK_STORAGE_KEY, callbackUrl);
  } catch {
    // Private mode / quota — query param on /login/2fa is the fallback.
  }
}

/**
 * Read the stored post-2FA callback URL without clearing it.
 *
 * @param fallback Used when nothing is stored.
 * @returns The destination URL for building the `/login/2fa` redirect.
 */
export function peekTwoFactorCallbackUrl(fallback: string = TWO_FACTOR_DEFAULT_CALLBACK): string {
  if (typeof window === 'undefined') return fallback;
  try {
    return window.sessionStorage.getItem(TWO_FACTOR_CALLBACK_STORAGE_KEY) ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Read and clear the stored post-2FA callback URL (call after successful verify).
 *
 * @param fallback Used when nothing is stored (e.g. deep-link to `/login/2fa`).
 * @returns The destination URL for navigation after verify.
 */
export function takeTwoFactorCallbackUrl(fallback: string = TWO_FACTOR_DEFAULT_CALLBACK): string {
  if (typeof window === 'undefined') return fallback;
  try {
    const stored = window.sessionStorage.getItem(TWO_FACTOR_CALLBACK_STORAGE_KEY);
    if (stored) {
      window.sessionStorage.removeItem(TWO_FACTOR_CALLBACK_STORAGE_KEY);
      return stored;
    }
  } catch {
    // ignore
  }
  return fallback;
}

/**
 * Build the `/login/2fa` path with an optional `callbackUrl` query param.
 *
 * @param callbackUrl Destination after verify; omitted when empty.
 * @returns Path + query for the second-factor page.
 */
export function twoFactorLoginPath(callbackUrl?: string): string {
  if (!callbackUrl) return '/login/2fa';
  return `/login/2fa?callbackUrl=${encodeURIComponent(callbackUrl)}`;
}
