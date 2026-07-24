/**
 * Server-side client for the onboarding-wizard resume-state + funnel endpoints
 * `GET/PUT/DELETE /v1/onboarding/wizard-state` (OLO-4.5, #4209).
 *
 * The first-tenant onboarding wizard persists its resume position here so a
 * user who abandons mid-wizard reopens on the same step after logging back in,
 * and each forward step records a funnel event for onboarding metrics. This
 * mirrors `first-tenant-provisioning.ts`: it runs server-side only, mints the
 * REST JWT from `BETTER_AUTH_SECRET`, and never throws — persistence and telemetry
 * are best-effort and must never break the wizard the user is actively using.
 */

import { createRestAuthHeaders, REST_API_BASE_URL } from '../rest-auth';
import type { ProvisioningUser } from './first-tenant-provisioning';

/** Funnel event recorded alongside a step change. */
export type WizardFunnelEvent = 'reached' | 'completed' | 'abandoned';

/** Persisted resume state returned by the wizard-state endpoint. */
export interface OnboardingWizardState {
  /** Wizard step to reopen on. */
  step: string;
  /** Organization name entered so far, if any. */
  orgName: string | null;
  /** Tenant slug entered so far, if any. */
  slug: string | null;
}

/**
 * Load the caller's saved wizard state, or null when there is nothing to
 * resume (no row, expired, or the service is unreachable).
 *
 * @param user Authenticated identity from the session — never client input.
 * @returns The saved state, or null. Never throws.
 */
export async function loadWizardStateViaRest(
  user: ProvisioningUser
): Promise<OnboardingWizardState | null> {
  let response: Response;
  try {
    response = await fetch(`${REST_API_BASE_URL}/onboarding/wizard-state`, {
      method: 'GET',
      headers: createRestAuthHeaders(user),
      cache: 'no-store',
    });
  } catch (error) {
    console.error('[loadWizardStateViaRest] request failed:', error);
    return null;
  }

  // 204 => no saved state (the common "start fresh" case).
  if (response.status === 204 || !response.ok) {
    return null;
  }

  const body = await response.json().catch(() => null);
  if (!body || typeof body.step !== 'string') {
    return null;
  }
  return {
    step: body.step,
    orgName: typeof body.org_name === 'string' ? body.org_name : null,
    slug: typeof body.slug === 'string' ? body.slug : null,
  };
}

/**
 * Persist the caller's wizard resume position and, when `event` is given,
 * record a funnel event for the step.
 *
 * @param user Authenticated identity from the session — never client input.
 * @param step Wizard step the user is now on.
 * @param orgName Organization name entered so far, or empty.
 * @param slug Tenant slug entered so far, or empty.
 * @param event Funnel event to record; omit to persist without a funnel event
 *   (e.g. backward navigation, so a step is not double-counted).
 * @returns True when the save succeeded. Never throws.
 */
export async function saveWizardStateViaRest(
  user: ProvisioningUser,
  step: string,
  orgName: string,
  slug: string,
  event?: WizardFunnelEvent
): Promise<boolean> {
  try {
    const response = await fetch(`${REST_API_BASE_URL}/onboarding/wizard-state`, {
      method: 'PUT',
      headers: createRestAuthHeaders(user),
      body: JSON.stringify({
        step,
        org_name: orgName || null,
        slug: slug || null,
        event: event ?? null,
      }),
      cache: 'no-store',
    });
    return response.ok;
  } catch (error) {
    console.error('[saveWizardStateViaRest] request failed:', error);
    return false;
  }
}

/**
 * Clear the caller's saved wizard state (called once the wizard completes).
 *
 * @param user Authenticated identity from the session — never client input.
 * @returns True when the clear succeeded. Never throws.
 */
export async function clearWizardStateViaRest(user: ProvisioningUser): Promise<boolean> {
  try {
    const response = await fetch(`${REST_API_BASE_URL}/onboarding/wizard-state`, {
      method: 'DELETE',
      headers: createRestAuthHeaders(user),
      cache: 'no-store',
    });
    return response.ok;
  } catch (error) {
    console.error('[clearWizardStateViaRest] request failed:', error);
    return false;
  }
}
