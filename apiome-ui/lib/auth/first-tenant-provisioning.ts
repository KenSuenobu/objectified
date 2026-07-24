/**
 * Shared client for the atomic first-tenant provisioning endpoint
 * `POST /v1/onboarding/first-tenant` (OLO-4.3, #4207).
 *
 * This is the codebase's single tenant-provisioning path: both the onboarding
 * wizard (`first-tenant-actions.ts`) and OAuth self-signup
 * (`oauth-signup-actions.ts`) flow through here. The REST endpoint performs
 * everything in one transaction — tenant, active membership, Owner role,
 * legacy administrator entry, free-tier entitlements — and best-effort seeds
 * the sample project, so callers no longer need compensation logic for
 * partially created tenants.
 *
 * Misuse safeguards:
 * - Runs server-side only; the JWT is minted from `BETTER_AUTH_SECRET` and no
 *   REST topology or credentials reach the browser.
 * - Name/slug are validated here before the request, and the endpoint
 *   re-validates and enforces slug uniqueness plus the caller's
 *   `max_tenants` entitlement inside the transaction.
 */

import { createRestAuthHeaders, REST_API_BASE_URL } from '../rest-auth';
import { generateTenantSlug, validateTenantSlug } from './tenant-slug';

/** Identity used to mint the REST JWT for the provisioning call. */
export interface ProvisioningUser {
  user_id: string;
  email?: string | null;
  name?: string | null;
}

/** Stable machine-readable conflict codes emitted by the REST endpoint. */
export type ProvisioningConflictCode = 'tenant-cap-reached' | 'tenant-slug-taken';

/** Outcome of {@link provisionFirstTenantViaRest}. */
export type FirstTenantProvisioningResult =
  | {
      success: true;
      /** The newly created tenant, ready to be activated in the session. */
      tenant: { id: string; name: string; slug: string };
    }
  | {
      success: false;
      /** Human-readable error safe to surface to the user. */
      error: string;
      /** Structured conflict code when the endpoint returned one. */
      code?: ProvisioningConflictCode;
    };

/**
 * Provision a tenant for `user` through the atomic REST endpoint.
 *
 * @param user Authenticated identity (from the session, or the just-created
 *   user during OAuth signup) — never from client input.
 * @param orgNameInput Organization display name.
 * @param slugInput Optional slug; when blank one is derived from the name.
 * @returns The created tenant, or a human-readable error with an optional
 *   structured conflict code. Never throws.
 */
export async function provisionFirstTenantViaRest(
  user: ProvisioningUser,
  orgNameInput: string,
  slugInput: string
): Promise<FirstTenantProvisioningResult> {
  const name = orgNameInput?.trim();
  if (!name) {
    return { success: false, error: 'Organization name is required' };
  }

  const slug = slugInput?.trim() ? slugInput.trim().toLowerCase() : generateTenantSlug(name);
  const slugError = validateTenantSlug(slug);
  if (slugError) {
    return { success: false, error: slugError };
  }

  let response: Response;
  try {
    response = await fetch(`${REST_API_BASE_URL}/onboarding/first-tenant`, {
      method: 'POST',
      headers: createRestAuthHeaders(user),
      body: JSON.stringify({ name, slug, provision_sample_project: true }),
      cache: 'no-store',
    });
  } catch (error) {
    console.error('[provisionFirstTenantViaRest] provisioning request failed:', error);
    return {
      success: false,
      error: 'Could not reach the provisioning service. Please try again.',
    };
  }

  const body = await response.json().catch(() => null);

  if (response.status === 201) {
    const tenant = body?.tenant;
    if (tenant?.id && tenant?.slug) {
      return {
        success: true,
        tenant: {
          id: String(tenant.id),
          name: String(tenant.name ?? name),
          slug: String(tenant.slug),
        },
      };
    }
    return { success: false, error: 'Provisioning returned an unexpected response.' };
  }

  const detail = body?.detail;
  const code = typeof detail === 'object' && detail !== null ? detail.code : undefined;
  if (code === 'tenant-slug-taken') {
    return { success: false, error: 'A tenant with this slug already exists', code };
  }
  if (code === 'tenant-cap-reached') {
    return {
      success: false,
      error: 'Your account has reached its tenant limit.',
      code,
    };
  }

  const message =
    typeof detail === 'string'
      ? detail
      : typeof detail?.message === 'string'
        ? detail.message
        : null;
  return { success: false, error: message || 'Could not create organization' };
}
