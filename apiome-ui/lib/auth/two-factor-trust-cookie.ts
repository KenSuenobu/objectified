/**
 * Shared constants for Better Auth trust-device cookie names (OLO-9.15 #5015).
 *
 * Kept outside the `'use server'` actions module so Next.js only sees async action exports there.
 */

/** Unprefixed Better Auth trust-device cookie name (`createAuthCookie('trust_device')`). */
export const TRUST_DEVICE_COOKIE_BASE = 'better-auth.trust_device';

/** Cookie names that may hold the trust-device cookie (dev vs production `__Secure-` prefix). */
export const TRUST_DEVICE_COOKIE_NAMES = [
  TRUST_DEVICE_COOKIE_BASE,
  `__Secure-${TRUST_DEVICE_COOKIE_BASE}`,
] as const;
