'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LogOut } from 'lucide-react';
import { useAuthSession } from '@lib/auth/session-client';
import { signOutEverywhere } from '@lib/auth/sign-out-client';
import { DEFAULT_LOGIN_LANDING } from '@lib/auth/cookie-options';
import { provisionFirstTenant } from '@lib/auth/first-tenant-actions';
import {
  completeOnboardingWizard,
  loadOnboardingWizardState,
  saveOnboardingWizardStep,
} from '@lib/auth/onboarding-wizard-state-actions';
import type { WizardFunnelEvent } from '@lib/auth/onboarding-wizard-state';
import { BrandMark } from '../../brand';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Stepper } from '../../ui/Stepper';
import { AuthShell } from '../AuthShell';
import {
  FIRST_TENANT_WIZARD_PROGRESS,
  isFirstTenantWizardStep,
  type FirstTenantWizardStep,
} from './wizard-steps';
import { WelcomeStep } from './WelcomeStep';
import { OrganizationStep, type OrganizationStepValues } from './OrganizationStep';
import { SummaryStep } from './SummaryStep';
import { DoneStep } from './DoneStep';

/** The name the progress row is announced by. */
const PROGRESS_LABEL = 'Setup progress';

/**
 * The footnote under the card. It answers the question a four-step form in place of
 * the whole product provokes: what happens if I close this now?
 */
const RESUME_NOTE =
  'Progress is saved server-side — come back later and the wizard resumes on this step with your values pre-filled.';

/**
 * First-tenant onboarding wizard (OLO-4.1, #4205; re-skinned by HIVE-4.4, #5298),
 * mounted by `FirstTenantOnboardingGuard` in place of any /ade route content whenever
 * the authenticated user has zero tenant memberships.
 *
 * Steps: welcome → organization (name/slug; polished by OLO-4.2) → summary
 * (Free license shown before confirm) → done. The wizard is deliberately not
 * dismissible — a tenant-less user has nothing else to see — so the only exits
 * are completing setup, being added to a tenant ("Check again"), or signing
 * out.
 *
 * On confirm the tenant is provisioned by the `provisionFirstTenant` server
 * action; completion activates the new tenant in the session (the same
 * `useAuthSession().update({ current_tenant_id })` contract the tenant switcher
 * uses) and lands the user in the new tenant's dashboard.
 *
 * Resumability + telemetry (OLO-4.5, #4209): the current step and any entered
 * organization name/slug are persisted server-side per step change, so a user
 * who abandons the wizard and logs back in reopens on the same step with values
 * pre-filled. Each forward step also records a funnel event (`reached`, and
 * `completed` at the end) for onboarding metrics. All persistence/telemetry is
 * best-effort and fire-and-forget — it never blocks or breaks navigation.
 *
 * ### What HIVE-4.4 changed
 *
 * Authority: `docs/mockups/auth/onboarding.html`. Nothing about the flow: the same four
 * steps, the same strings, the same resume and funnel behaviour. What changed is the
 * frame. The wizard used to float on a grey page of named greys; it now draws the shared
 * `AuthShell` — hex canvas, honey wash — with a top row naming who is signed in, and its
 * bespoke `<ol>` progress header is the shared `ui/Stepper`.
 *
 * The card is *not* `role="dialog"`, though the mockup marks it as one: there is nothing
 * behind it to be modal over. The guard renders this instead of the route, so the wizard
 * is the page — which is also why it cannot be deep-linked around.
 *
 * @returns The wizard, at whichever step the reader is on.
 */
export function FirstTenantOnboardingWizard() {
  const router = useRouter();
  const { data: session, update } = useAuthSession();

  const [step, setStep] = useState<FirstTenantWizardStep>('welcome');
  const [orgName, setOrgName] = useState('');
  const [slug, setSlug] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const [tenant, setTenant] = useState<{ id: string; name: string; slug: string } | null>(null);

  /** The signed-in address, when the session carries one — the top row's orientation. */
  const email = (session?.user as { email?: string | null } | undefined)?.email ?? null;

  // Guards the mount-time hydration so it only runs once (React 18 Strict Mode
  // mounts effects twice in development) and never re-fires as state changes.
  const hydratedRef = useRef(false);

  /**
   * Persist the resume position and, when `event` is given, record a funnel
   * event. Fire-and-forget: navigation must never wait on — or be broken by —
   * telemetry, so the promise is intentionally not awaited.
   *
   * @param nextStep The step now shown.
   * @param event Funnel event to record; omit for backward navigation so a step
   *   is not double-counted.
   * @param name Organization name to persist (defaults to current state; passed
   *   explicitly when advancing from the organization step, whose freshly
   *   validated values have not yet flushed into state).
   * @param slugValue Tenant slug to persist (same rationale as `name`).
   */
  const persistStep = useCallback(
    (nextStep: FirstTenantWizardStep, event?: WizardFunnelEvent, name = orgName, slugValue = slug) => {
      void saveOnboardingWizardStep(nextStep, name, slugValue, event).catch((error) => {
        console.error('[FirstTenantOnboardingWizard] failed to persist wizard step:', error);
      });
    },
    [orgName, slug]
  );

  // Resume: on mount, reopen on any previously saved step (values pre-filled).
  // With no saved state, seed the funnel's top (`welcome reached`) and create
  // the resume row so even an abandon on the welcome step is measured.
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;

    let active = true;
    void loadOnboardingWizardState()
      .then((saved) => {
        if (!active) return;
        if (!saved) {
          persistStep('welcome', 'reached');
          return;
        }
        if (saved.orgName) setOrgName(saved.orgName);
        if (saved.slug) setSlug(saved.slug);
        // Never resume onto `done`: it needs the just-provisioned tenant in
        // memory, and a completed wizard no longer shows. Cap resume at review.
        if (isFirstTenantWizardStep(saved.step) && saved.step !== 'done') {
          setStep(saved.step);
        }
      })
      .catch((error) => {
        console.error('[FirstTenantOnboardingWizard] failed to load wizard state:', error);
      });
    return () => {
      active = false;
    };
  }, [persistStep]);

  /** Moves forward to `nextStep`, persisting it and recording a funnel event. */
  const advanceTo = (
    nextStep: FirstTenantWizardStep,
    name = orgName,
    slugValue = slug
  ) => {
    setStep(nextStep);
    persistStep(nextStep, 'reached', name, slugValue);
  };

  /** Moves back to `previousStep`, persisting the position without a funnel event. */
  const goBackTo = (previousStep: FirstTenantWizardStep) => {
    setStep(previousStep);
    persistStep(previousStep);
  };

  /** Stores the organization step's validated values and moves to review. */
  const handleOrganizationContinue = (values: OrganizationStepValues) => {
    setOrgName(values.name);
    setSlug(values.slug);
    setSubmitError(null);
    advanceTo('summary', values.name, values.slug);
  };

  /** Runs provisioning; success reaches `done`, failure stays on the summary. */
  const handleConfirm = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await provisionFirstTenant(orgName, slug);
      if (result.success) {
        setTenant(result.tenant);
        setStep('done');
        // Record the completed funnel event and clear the resume state — the
        // wizard no longer shows once the tenant exists. Fire-and-forget.
        void completeOnboardingWizard().catch((error) => {
          console.error('[FirstTenantOnboardingWizard] failed to finalize wizard state:', error);
        });
      } else {
        setSubmitError(result.error);
      }
    } catch (error) {
      console.error('[FirstTenantOnboardingWizard] provisioning failed:', error);
      setSubmitError('Something went wrong while creating your organization. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  /** Activates the new tenant in the session, then lands in its dashboard. */
  const handleGoToDashboard = async () => {
    if (!tenant) return;
    setNavigating(true);
    try {
      await update({ current_tenant_id: tenant.id });
    } catch (error) {
      // Non-fatal: the JWT callback re-derives the active tenant on the next
      // request, so landing without the eager update still works.
      console.error('[FirstTenantOnboardingWizard] session update failed:', error);
    } finally {
      // Refresh re-runs the onboarding guard, which now sees a membership and
      // renders the dashboard route instead of the wizard.
      router.push(DEFAULT_LOGIN_LANDING);
      router.refresh();
    }
  };

  /** Signs out everywhere, back to the login page. */
  const handleSignOut = () => signOutEverywhere('/login');

  return (
    <AuthShell
      wide
      topbar={
        <>
          <BrandMark variant="lockup" size={28} priority />
          <div className="auth-topbar__who">
            {email && (
              <span data-testid="onboarding-signed-in-as">
                Signed in as <span className="font-medium text-fg">{email}</span>
              </span>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={handleSignOut}
              data-testid="onboarding-topbar-sign-out"
            >
              <LogOut aria-hidden="true" />
              Sign out
            </Button>
          </div>
        </>
      }
    >
      <section
        aria-labelledby="first-tenant-onboarding-title"
        data-testid="first-tenant-onboarding-wizard"
      >
        <Card className="wiz-card">
          <div className="wiz-card__progress">
            <Stepper
              aria-label={PROGRESS_LABEL}
              fill
              steps={FIRST_TENANT_WIZARD_PROGRESS}
              current={step}
              // The terminal step is past the last one shown, so every marker is done.
              complete={step === 'done'}
            />
          </div>
          {step === 'welcome' && (
            <WelcomeStep
              onGetStarted={() => advanceTo('organization')}
              onCheckAgain={() => router.refresh()}
              onSignOut={handleSignOut}
            />
          )}
          {step === 'organization' && (
            <OrganizationStep
              initialName={orgName}
              initialSlug={slug}
              onBack={() => goBackTo('welcome')}
              onContinue={handleOrganizationContinue}
            />
          )}
          {step === 'summary' && (
            <SummaryStep
              name={orgName}
              slug={slug}
              error={submitError}
              submitting={submitting}
              onBack={() => goBackTo('organization')}
              onConfirm={handleConfirm}
            />
          )}
          {step === 'done' && tenant && (
            <DoneStep
              tenantName={tenant.name}
              tenantSlug={tenant.slug}
              navigating={navigating}
              onGoToDashboard={handleGoToDashboard}
            />
          )}
        </Card>
      </section>

      <p className="auth-terms mt-4">{RESUME_NOTE}</p>
    </AuthShell>
  );
}

export default FirstTenantOnboardingWizard;
