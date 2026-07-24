/**
 * Invited-user path: pending-membership activation (OLO-4.4, #4208).
 *
 * A user invited to an existing tenant arrives at their first login with a
 * `pending` membership (V121). The post-login routing already counts that
 * membership (so they skip the first-tenant wizard and land in the inviting
 * tenant); this module completes the arrival by transitioning the pending
 * membership to `active` through the REST endpoint
 * `POST /v1/onboarding/membership-activation`.
 *
 * Misuse safeguards:
 * - Runs server-side only; the JWT is minted from `BETTER_AUTH_SECRET` and no
 *   REST topology or credentials reach the browser.
 * - The endpoint only activates the *caller's own* membership, and only when
 *   it is `pending` — a suspended membership is never reactivated by a login.
 * - {@link activatePendingMembershipForLogin} never throws: a failed or
 *   unreachable activation must not break sign-in (the user still lands in
 *   the tenant; the membership simply stays pending until the next login).
 */

import { createRestAuthHeaders, REST_API_BASE_URL } from '../rest-auth';

/** Identity used to mint the REST JWT for the activation call. */
export interface ActivationUser {
  user_id: string;
  email?: string | null;
  name?: string | null;
}

/** Structured error codes emitted by the REST endpoint. */
export type MembershipActivationErrorCode = 'membership-not-found' | 'membership-suspended';

/** Outcome of {@link activateMembershipViaRest}. */
export type MembershipActivationResult =
  | {
      success: true;
      /** `activated` on a pending → active transition, else `already-active`. */
      status: 'activated' | 'already-active';
    }
  | {
      success: false;
      /** Human-readable error safe to log. */
      error: string;
      /** Structured error code when the endpoint returned one. */
      code?: MembershipActivationErrorCode;
    };

/**
 * Activate the caller's pending membership in `tenantId` via the REST
 * endpoint.
 *
 * @param user Authenticated identity (from the session) — never from client
 *   input.
 * @param tenantId Tenant whose pending membership should be activated.
 * @returns The activation outcome. Never throws.
 */
export async function activateMembershipViaRest(
  user: ActivationUser,
  tenantId: string
): Promise<MembershipActivationResult> {
  let response: Response;
  try {
    response = await fetch(`${REST_API_BASE_URL}/onboarding/membership-activation`, {
      method: 'POST',
      headers: createRestAuthHeaders(user),
      body: JSON.stringify({ tenant_id: tenantId }),
      cache: 'no-store',
    });
  } catch (error) {
    console.error('[activateMembershipViaRest] activation request failed:', error);
    return { success: false, error: 'Could not reach the activation service.' };
  }

  const body = await response.json().catch(() => null);

  if (response.ok) {
    const status = body?.status === 'activated' ? 'activated' : 'already-active';
    return { success: true, status };
  }

  const detail = body?.detail;
  const code = typeof detail === 'object' && detail !== null ? detail.code : undefined;
  if (code === 'membership-not-found' || code === 'membership-suspended') {
    return { success: false, error: String(detail.message ?? code), code };
  }

  const message =
    typeof detail === 'string'
      ? detail
      : typeof detail?.message === 'string'
        ? detail.message
        : `Activation failed with status ${response.status}`;
  return { success: false, error: message };
}

/**
 * First-arrival hook for the NextAuth sign-in flow: when the tenant the user
 * is about to land in holds a `pending` membership, activate it.
 *
 * Looks up the membership status first so the REST call is only made for
 * invited users on their first arrival — regular sign-ins (active members)
 * cost one indexed read and no network hop.
 *
 * @param user Authenticated identity from the sign-in payload.
 * @param tenantId The resolved active tenant for this login; `null`/`undefined`
 *   (tenant-less user) is a no-op.
 * @returns Resolves when done; never throws and never blocks the login on
 *   activation failure.
 */
export async function activatePendingMembershipForLogin(
  user: ActivationUser,
  tenantId: string | null | undefined
): Promise<void> {
  if (!tenantId || !user?.user_id) {
    return;
  }

  try {
    // Lazy import keeps this module importable without a db module in scope
    // (mirrors post-login-routing's handling of its db helper).
    const { getTenantMembershipsForUser } = await import('./post-login-routing');
    const memberships = await getTenantMembershipsForUser(user.user_id);
    const membership = memberships.find((m) => m.id === tenantId);
    if (membership?.status !== 'pending') {
      return;
    }

    const result = await activateMembershipViaRest(user, tenantId);
    if (!result.success) {
      console.error(
        `[activatePendingMembershipForLogin] activation failed for tenant ${tenantId}:`,
        result.error
      );
    }
  } catch (error) {
    console.error('[activatePendingMembershipForLogin] unexpected failure:', error);
  }
}
