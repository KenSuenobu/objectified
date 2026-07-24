'use server';

// Imported via the alias so the jest `auth/server-session` mock mapping applies
// (a relative `./server-session` would pull the real Better Auth / DB stack into tests).
import { getAuthSession } from '@lib/auth/server-session';
import {
  clearWizardStateViaRest,
  loadWizardStateViaRest,
  saveWizardStateViaRest,
  type OnboardingWizardState,
  type WizardFunnelEvent,
} from './onboarding-wizard-state';

/**
 * Resolve the authenticated identity for a wizard-state action, or null.
 *
 * The user id always comes from the server session, never from the client, so
 * one user can never read or write another's onboarding state.
 */
async function currentUser(): Promise<
  { user_id: string; email?: string | null; name?: string | null } | null
> {
  const session = await getAuthSession();
  const user = session?.user as
    | { user_id?: string; email?: string | null; name?: string | null }
    | undefined;
  if (!user?.user_id) {
    return null;
  }
  return { user_id: user.user_id, email: user.email, name: user.name };
}

/**
 * Load the caller's saved onboarding-wizard state so the wizard can reopen on
 * the step they abandoned, with entered values pre-filled (OLO-4.5, #4209).
 *
 * @returns The saved state, or null when there is nothing to resume. Never
 *   throws — a missing state or an unreachable service simply starts fresh.
 */
export async function loadOnboardingWizardState(): Promise<OnboardingWizardState | null> {
  const user = await currentUser();
  if (!user) {
    return null;
  }
  return loadWizardStateViaRest(user);
}

/**
 * Persist the caller's wizard resume position and, when `event` is given,
 * record a funnel event for the step (OLO-4.5, #4209).
 *
 * @param step Wizard step the user is now on.
 * @param orgName Organization name entered so far.
 * @param slug Tenant slug entered so far.
 * @param event Funnel event to record; omit for backward navigation so a step
 *   is not double-counted.
 */
export async function saveOnboardingWizardStep(
  step: string,
  orgName: string,
  slug: string,
  event?: WizardFunnelEvent
): Promise<void> {
  const user = await currentUser();
  if (!user) {
    return;
  }
  await saveWizardStateViaRest(user, step, orgName, slug, event);
}

/**
 * Record wizard completion (a `completed` funnel event on the terminal step)
 * and clear the resume state — the wizard no longer shows once the tenant is
 * provisioned (OLO-4.5, #4209).
 */
export async function completeOnboardingWizard(): Promise<void> {
  const user = await currentUser();
  if (!user) {
    return;
  }
  await saveWizardStateViaRest(user, 'done', '', '', 'completed');
  await clearWizardStateViaRest(user);
}
