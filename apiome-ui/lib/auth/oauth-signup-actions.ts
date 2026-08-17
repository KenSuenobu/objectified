'use server';

import crypto from 'crypto';
import { createUser, deleteUser, clearUserPassword } from '../db/admin-helper';
import { linkExternalAccount, isTenantSlugTaken } from '../db/helper';
import { resolveOAuthEmailVerified } from './account-resolution';
import {
  getOauthSignupPendingById,
  deleteOauthSignupPendingById,
  insertAuthOneTimeCode,
} from '../db/oauth-signup';
import { provisionFirstTenantViaRest } from './first-tenant-provisioning';
import type { SlugAvailabilityResult } from './slug-availability';
import { generateTenantSlug, validateTenantSlug } from './tenant-slug';

export type CompleteOAuthSignupResult =
  | { success: true; oneTimeCode: string }
  | { success: false; error: string };

/**
 * Check whether an organization slug is free, for the live chip on the OAuth
 * sign-up card (HIVE-4.3, #5297).
 *
 * The onboarding wizard's probe (`checkTenantSlugAvailability`) cannot serve
 * this screen: it identifies the caller from their session, and the reader here
 * has no account yet — every answer would be `unknown`. So this action proves
 * the caller instead with the pending-signup id they already hold, then asks the
 * database the same question `createTenant` asks before inserting.
 *
 * Misuse safeguards — tenant slugs are otherwise not enumerable by strangers:
 * - **The pending id gates it.** No live sign-up session, no verdict: an expired
 *   or unknown id answers `unknown`, which is also what a caller with no id at
 *   all sees. The id is single-use and hour-lived (`oauth_signup_pending`).
 * - The slug is shape-validated before it reaches the query, and the query is
 *   parameterized, so arbitrary strings never reach SQL.
 * - The answer is one bit — free or not — and never names the tenant holding it.
 * - Failures degrade to `unknown` rather than throwing: the chip is advisory and
 *   {@link completeOAuthSignup} re-checks uniqueness when the form is submitted.
 *
 * @param pendingId The `oauth_signup_pending` id from the sign-up link's token.
 * @param slugInput Candidate slug (whitespace/case are normalized here).
 * @returns The availability verdict; never throws.
 */
export async function checkOauthSignupSlugAvailability(
  pendingId: string,
  slugInput: string
): Promise<SlugAvailabilityResult> {
  const slug = (slugInput ?? '').trim().toLowerCase();
  const slugError = validateTenantSlug(slug);
  if (slugError) {
    return { status: 'invalid', error: slugError };
  }

  try {
    const pending = await getOauthSignupPendingById(pendingId);
    if (!pending) return { status: 'unknown' };
    return { status: (await isTenantSlugTaken(slug)) ? 'taken' : 'available' };
  } catch (error) {
    console.error('[checkOauthSignupSlugAvailability] availability probe failed:', error);
    return { status: 'unknown' };
  }
}

/**
 * Completes OAuth self-signup: creates the user, links the provider, then
 * provisions the tenant (with Owner role, free-tier entitlements, and sample
 * project) through the atomic REST endpoint `POST /v1/onboarding/first-tenant`
 * (OLO-4.3, #4207) — the same single provisioning path the onboarding wizard
 * uses. Returns a one-time login code on success.
 */
export async function completeOAuthSignup(
  pendingId: string,
  displayName: string,
  tenantDisplayName: string,
  tenantSlugInput: string
): Promise<CompleteOAuthSignupResult> {
  const name = displayName?.trim();
  const orgName = tenantDisplayName?.trim();
  const slugRaw = tenantSlugInput?.trim() ? tenantSlugInput.trim().toLowerCase() : generateTenantSlug(orgName || '');

  if (!name) return { success: false, error: 'Name is required' };
  if (!orgName) return { success: false, error: 'Organization name is required' };
  const slugErr = validateTenantSlug(slugRaw);
  if (slugErr) return { success: false, error: slugErr };

  const pending = await getOauthSignupPendingById(pendingId);
  if (!pending) {
    return { success: false, error: 'Signup session expired or invalid. Please start again from the login page.' };
  }

  const email = pending.email?.trim().toLowerCase();
  if (!email) {
    return { success: false, error: 'No email is available from the OAuth provider.' };
  }

  const account = pending.account_json || {};
  const profile = pending.profile_json || {};

  // A throwaway password satisfies the NOT NULL column during creation; it is cleared immediately
  // below so the OAuth-only account is genuinely password-less — its linked identity is its only
  // sign-in method, which is what the OLO-2.4 last-sign-in-method unlink guard relies on.
  const randomPassword = `${crypto.randomBytes(32).toString('hex')}!Aa1`;

  const userRes = await createUser(name, email, randomPassword, true, true);
  const userParsed = JSON.parse(userRes);
  if (!userParsed.success || !userParsed.user?.id) {
    return { success: false, error: userParsed.error || 'Could not create user' };
  }

  const userId: string = userParsed.user.id;

  // Mark the freshly-created OAuth account as password-less (no usable credentials login).
  await clearUserPassword(userId);

  const accessToken = typeof account.access_token === 'string' ? account.access_token : null;
  const refreshToken = typeof account.refresh_token === 'string' ? account.refresh_token : null;
  const exp = account.expires_at;
  const tokenExpiresAt =
    typeof exp === 'number' ? new Date(exp * 1000) : exp instanceof Date ? exp : null;

  const providerUsername =
    (typeof profile.login === 'string' && profile.login) ||
    (typeof profile.username === 'string' && profile.username) ||
    null;

  const profileData = {
    name: typeof profile.name === 'string' ? profile.name : name,
    avatar_url:
      (typeof profile.avatar_url === 'string' && profile.avatar_url) ||
      (typeof (profile as { image_url?: string }).image_url === 'string' &&
        (profile as { image_url?: string }).image_url) ||
      (typeof profile.image === 'string' && profile.image) ||
      (typeof profile.picture === 'string' && profile.picture) ||
      null,
    profile_url:
      (typeof profile.html_url === 'string' && profile.html_url) ||
      (typeof profile.web_url === 'string' && profile.web_url) ||
      (typeof profile.url === 'string' && profile.url) ||
      null,
  };

  // Honour the provider's verified-email claim from the stored profile/account JSON (OIDC providers
  // set `email_verified`); default to unverified when no signal is present. See OLO-1.2 / 2.5.
  const emailVerified = resolveOAuthEmailVerified(profile, account);

  const linkRes = await linkExternalAccount(
    userId,
    pending.provider,
    pending.provider_account_id,
    email,
    providerUsername,
    accessToken,
    refreshToken,
    tokenExpiresAt,
    profileData,
    emailVerified
  );
  const linkParsed = JSON.parse(linkRes);
  if (!linkParsed.success) {
    await deleteUser(userId);
    return { success: false, error: linkParsed.error || 'Could not link OAuth account' };
  }

  // Atomic tenant provisioning (tenant + membership + Owner role + free-tier
  // entitlements + best-effort sample project). All-or-nothing on the REST
  // side, so the only compensation ever needed here is removing the
  // just-created user.
  const provisionRes = await provisionFirstTenantViaRest(
    { user_id: userId, email, name },
    orgName,
    slugRaw
  );
  if (!provisionRes.success) {
    await deleteUser(userId);
    return { success: false, error: provisionRes.error };
  }

  const tenantId: string = provisionRes.tenant.id;

  await deleteOauthSignupPendingById(pendingId);

  const oneTimeCode = await insertAuthOneTimeCode(userId, tenantId);
  return { success: true, oneTimeCode };
}
