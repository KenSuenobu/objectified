/**
 * SendGrid delivery for Better Auth two-factor email OTP (OLO-9.50 #5070).
 *
 * Better Auth treats OTP as server-level: when `otpOptions.sendOTP` is registered, every
 * `twoFactorEnabled` user receives `"otp"` in `twoFactorMethods` at credential sign-in.
 * We only register that callback when SendGrid is fully configured (see
 * {@link isTwoFactorEmailOtpConfigured}).
 */

import sgMail from '@sendgrid/mail';

/** Env var holding the SendGrid API key. */
export const SENDGRID_API_KEY_ENV = 'SENDGRID_API_KEY';

/** Env var holding the verified sender address (or "Name <addr@domain>"). */
export const EMAIL_FROM_ENV = 'EMAIL_FROM';

/**
 * True when both SendGrid credentials needed to deliver 2FA email OTPs are set and non-blank.
 *
 * @param env Environment map; defaults to `process.env` (injectable for tests).
 */
export function isTwoFactorEmailOtpConfigured(
  env: NodeJS.Dict<string> = process.env
): boolean {
  const key = env[SENDGRID_API_KEY_ENV]?.trim();
  const from = env[EMAIL_FROM_ENV]?.trim();
  return Boolean(key && from);
}

/**
 * Minimal user shape Better Auth passes into `otpOptions.sendOTP`.
 */
export interface TwoFactorEmailOtpUser {
  email: string;
  name?: string | null;
}

/**
 * Deliver a 2FA one-time code to the user's email via SendGrid.
 *
 * Never logs the OTP. On failure, logs a generic error and rethrows so Better Auth's
 * background catch records the send failure.
 *
 * @param params.user Recipient (must include `email`).
 * @param params.otp Plain 6-digit code from Better Auth (not logged).
 * @param env Environment map; defaults to `process.env`.
 */
export async function sendTwoFactorEmailOtp(
  params: { user: TwoFactorEmailOtpUser; otp: string },
  env: NodeJS.Dict<string> = process.env
): Promise<void> {
  const apiKey = env[SENDGRID_API_KEY_ENV]?.trim();
  const from = env[EMAIL_FROM_ENV]?.trim();
  if (!apiKey || !from) {
    const err = new Error('SendGrid 2FA email OTP is not configured');
    console.error('[2fa-email-otp] missing SENDGRID_API_KEY or EMAIL_FROM');
    throw err;
  }

  const to = params.user.email?.trim();
  if (!to) {
    const err = new Error('Cannot send 2FA OTP: user has no email');
    console.error('[2fa-email-otp] user email missing');
    throw err;
  }

  sgMail.setApiKey(apiKey);

  const subject = 'Your apiome sign-in code';
  const text =
    `Your apiome sign-in code is ${params.otp}.\n\n` +
    'It expires in about 3 minutes. If you did not try to sign in, you can ignore this email.';
  const html =
    `<p>Your apiome sign-in code is <strong>${params.otp}</strong>.</p>` +
    `<p>It expires in about 3 minutes. If you did not try to sign in, you can ignore this email.</p>`;

  try {
    await sgMail.send({ to, from, subject, text, html });
  } catch (error) {
    console.error(
      '[2fa-email-otp] SendGrid send failed',
      error instanceof Error ? error.name : 'unknown'
    );
    throw error;
  }
}
