/**
 * Preserve the post-login destination and available 2FA methods across the second step
 * (OLO-9.13 #5014 + OLO-9.50 #5070).
 *
 * Better Auth's `onTwoFactorRedirect` does not receive `callbackURL`. Password sign-in stores the
 * intended destination here before `signIn.email`; the `/login/2fa` page reads it after verify.
 * `twoFactorMethods` (e.g. `["totp","otp"]`) is passed into `onTwoFactorRedirect` and stored the
 * same way so the second-step UI can offer Authenticator and/or email OTP.
 */

/** sessionStorage key for the callback URL awaiting 2FA verification. */
export const TWO_FACTOR_CALLBACK_STORAGE_KEY = 'apiome:2fa-callbackUrl';

/** sessionStorage key for `twoFactorMethods` from the sign-in challenge. */
export const TWO_FACTOR_METHODS_STORAGE_KEY = 'apiome:2fa-methods';

/** Default landing when no callback was stored. */
export const TWO_FACTOR_DEFAULT_CALLBACK = '/ade';

/** Default methods when none were stored (deep-link / older clients) — TOTP-only. */
export const TWO_FACTOR_DEFAULT_METHODS: TwoFactorMethod[] = ['totp'];

/** Better Auth second-factor method ids we surface in the UI. */
export type TwoFactorMethod = 'totp' | 'otp';

/**
 * Remember where to send the user after a successful 2FA verify.
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
 * Normalize a raw methods list from Better Auth into the UI vocabulary.
 *
 * @param methods Raw values from `twoFactorRedirect` / `onTwoFactorRedirect`.
 * @returns Deduped list containing only `totp` / `otp`; empty input → default TOTP-only.
 */
export function normalizeTwoFactorMethods(
  methods: unknown
): TwoFactorMethod[] {
  if (!Array.isArray(methods) || methods.length === 0) {
    return [...TWO_FACTOR_DEFAULT_METHODS];
  }
  const out: TwoFactorMethod[] = [];
  for (const m of methods) {
    if ((m === 'totp' || m === 'otp') && !out.includes(m)) out.push(m);
  }
  return out.length > 0 ? out : [...TWO_FACTOR_DEFAULT_METHODS];
}

/**
 * Persist the methods offered for this 2FA challenge.
 *
 * @param methods From Better Auth `onTwoFactorRedirect({ twoFactorMethods })`.
 */
export function storeTwoFactorMethods(methods: unknown): void {
  if (typeof window === 'undefined') return;
  try {
    const normalized = normalizeTwoFactorMethods(methods);
    window.sessionStorage.setItem(TWO_FACTOR_METHODS_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // ignore
  }
}

/**
 * Read stored methods without clearing (for rendering the 2FA form).
 *
 * @param fallback Used when nothing is stored.
 */
export function peekTwoFactorMethods(
  fallback: TwoFactorMethod[] = TWO_FACTOR_DEFAULT_METHODS
): TwoFactorMethod[] {
  if (typeof window === 'undefined') return [...fallback];
  try {
    const raw = window.sessionStorage.getItem(TWO_FACTOR_METHODS_STORAGE_KEY);
    if (!raw) return [...fallback];
    return normalizeTwoFactorMethods(JSON.parse(raw));
  } catch {
    return [...fallback];
  }
}

/**
 * Read and clear stored methods (optional cleanup after successful verify).
 *
 * @param fallback Used when nothing is stored.
 */
export function takeTwoFactorMethods(
  fallback: TwoFactorMethod[] = TWO_FACTOR_DEFAULT_METHODS
): TwoFactorMethod[] {
  if (typeof window === 'undefined') return [...fallback];
  try {
    const raw = window.sessionStorage.getItem(TWO_FACTOR_METHODS_STORAGE_KEY);
    if (raw) {
      window.sessionStorage.removeItem(TWO_FACTOR_METHODS_STORAGE_KEY);
      return normalizeTwoFactorMethods(JSON.parse(raw));
    }
  } catch {
    // ignore
  }
  return [...fallback];
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
