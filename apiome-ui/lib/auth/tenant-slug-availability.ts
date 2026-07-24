'use server';

// Imported via the alias so the jest `auth/server-session` mock mapping
// applies (a relative `./server-session` would pull the real Better Auth / DB stack into tests).
import { getAuthSession } from '@lib/auth/server-session';
import { createRestAuthHeaders, REST_API_BASE_URL } from '../rest-auth';
import { validateTenantSlug } from './tenant-slug';

/**
 * Outcome of a tenant-slug availability probe:
 * - `available` — no tenant uses this slug.
 * - `taken`     — a tenant with this slug exists.
 * - `invalid`   — the slug fails shape validation; `error` carries the message.
 * - `unknown`   — the check could not be completed (REST unreachable, session
 *                 expired, unexpected status). Callers should fail open: tenant
 *                 provisioning re-enforces uniqueness on submit.
 */
export interface TenantSlugAvailabilityResult {
  status: 'available' | 'taken' | 'invalid' | 'unknown';
  /** Validation message when `status` is `invalid`. */
  error?: string;
}

/**
 * Check whether a tenant slug is free, for live feedback in the onboarding
 * wizard's organization step (OLO-4.2, #4206).
 *
 * Reuses the existing `HEAD /v1/tenants/{slug}` access probe (#3199) with the
 * caller's session identity: 404 means no such tenant (available), while 200
 * (caller has access) and 403 (exists, no access) both mean the slug is taken.
 *
 * Misuse safeguards:
 * - The slug is shape-validated first, so arbitrary strings never reach the
 *   REST URL (and are additionally URI-encoded).
 * - The probe runs server-side with a session-derived JWT; no credentials or
 *   REST topology are exposed to the browser.
 * - Failures degrade to `unknown` instead of throwing — the wizard treats the
 *   result as advisory and `createTenant` still enforces uniqueness.
 *
 * @param slugInput Candidate slug (whitespace/case are normalized here).
 * @returns The availability status; never throws.
 */
export async function checkTenantSlugAvailability(
  slugInput: string
): Promise<TenantSlugAvailabilityResult> {
  const slug = (slugInput ?? '').trim().toLowerCase();
  const slugError = validateTenantSlug(slug);
  if (slugError) {
    return { status: 'invalid', error: slugError };
  }

  const session = await getAuthSession();
  const user = session?.user as
    | { user_id?: string; email?: string | null; name?: string | null }
    | undefined;
  if (!user?.user_id) {
    return { status: 'unknown' };
  }

  try {
    const response = await fetch(
      `${REST_API_BASE_URL}/tenants/${encodeURIComponent(slug)}`,
      {
        method: 'HEAD',
        headers: createRestAuthHeaders(user),
        cache: 'no-store',
      }
    );
    if (response.status === 404) {
      return { status: 'available' };
    }
    if (response.status === 200 || response.status === 403) {
      return { status: 'taken' };
    }
    return { status: 'unknown' };
  } catch (error) {
    console.error('[checkTenantSlugAvailability] availability probe failed:', error);
    return { status: 'unknown' };
  }
}
