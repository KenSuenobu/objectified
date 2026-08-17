/**
 * Step model of the first-tenant onboarding wizard (OLO-4.1, #4205).
 *
 * Pure data + navigation helpers, kept separate from the components so the
 * ordering contract is unit-testable and later tickets (OLO-4.2 tenant-step
 * polish, OLO-4.4 invited-user path) can extend it without touching the shell.
 */

/** Identifier of each wizard step, in visit order. */
export type FirstTenantWizardStep = 'welcome' | 'organization' | 'summary' | 'done';

/** All steps in visit order. `done` is terminal and not shown in progress. */
export const FIRST_TENANT_WIZARD_STEPS: readonly FirstTenantWizardStep[] = [
  'welcome',
  'organization',
  'summary',
  'done',
];

/**
 * Steps shown in the progress header, with their display labels.
 *
 * Spelled `id` rather than `step` so the rows are `ui/Stepper`'s own `StepperStep`
 * shape (HIVE-4.4) — the progress row is a shared primitive now, and this is the
 * list it is handed unchanged.
 */
export const FIRST_TENANT_WIZARD_PROGRESS: ReadonlyArray<{
  id: FirstTenantWizardStep;
  label: string;
}> = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'organization', label: 'Organization' },
  { id: 'summary', label: 'Review' },
];

/**
 * Type guard for a persisted/untrusted step string (OLO-4.5, #4209).
 *
 * Used when hydrating resume state from the server so an unrecognized step
 * (e.g. from an older build) is ignored and the wizard starts fresh instead of
 * landing on an invalid step.
 *
 * @param value An arbitrary value that may be a wizard step.
 * @returns True when `value` is one of the known wizard steps.
 */
export function isFirstTenantWizardStep(value: unknown): value is FirstTenantWizardStep {
  return (
    typeof value === 'string' &&
    (FIRST_TENANT_WIZARD_STEPS as readonly string[]).includes(value)
  );
}

/**
 * The step after `step`, or `step` itself when already at the end.
 *
 * @param step The current wizard step.
 * @returns The next step in visit order.
 */
export function nextWizardStep(step: FirstTenantWizardStep): FirstTenantWizardStep {
  const index = FIRST_TENANT_WIZARD_STEPS.indexOf(step);
  return FIRST_TENANT_WIZARD_STEPS[Math.min(index + 1, FIRST_TENANT_WIZARD_STEPS.length - 1)];
}

/**
 * The step before `step`, or `step` itself when already at the start.
 *
 * @param step The current wizard step.
 * @returns The previous step in visit order.
 */
export function previousWizardStep(step: FirstTenantWizardStep): FirstTenantWizardStep {
  const index = FIRST_TENANT_WIZARD_STEPS.indexOf(step);
  return FIRST_TENANT_WIZARD_STEPS[Math.max(index - 1, 0)];
}
