'use client';

import { ArrowRight, Building2, LogOut, RefreshCw } from 'lucide-react';
import { Alert } from '../../ui/Alert';
import { Button } from '../../ui/Button';

/** Callbacks for the welcome step's three actions. */
export interface WelcomeStepProps {
  /** Advance to the organization step. */
  onGetStarted: () => void;
  /** Re-check memberships (for users expecting an invitation). */
  onCheckAgain: () => void;
  /** Sign out back to the login page. */
  onSignOut: () => void;
}

/**
 * First wizard step (OLO-4.1, re-skinned by HIVE-4.4 #5298): explains why the user
 * is here — their account belongs to no tenant — and offers the only useful actions:
 * start setup, re-check memberships (invited users), or sign out. There is
 * deliberately no dismiss control; a tenant-less user has no other surface to use.
 *
 * Authority: `docs/mockups/auth/onboarding.html`, step 1. Every string is the one
 * the step already carried; what changed is that the honey hexagon replaces a
 * gradient tile of named indigo, the invitation line became the mockup's callout,
 * and the three actions moved into the card's action band — so the button row sits
 * in the same place on every step.
 *
 * @param props The three callbacks — see {@link WelcomeStepProps}.
 * @returns The step's body band and its action band.
 */
export function WelcomeStep({ onGetStarted, onCheckAgain, onSignOut }: WelcomeStepProps) {
  return (
    <>
      <div className="wiz-card__body" data-testid="onboarding-step-welcome">
        <span className="auth-icon auth-icon--honey" aria-hidden="true">
          <Building2 />
        </span>
        <h1 id="first-tenant-onboarding-title" className="auth-title mt-4">
          Let&apos;s set up your first tenant
        </h1>
        <p className="auth-sub mt-2">
          Your account isn&apos;t a member of any tenant yet. This short setup creates your
          organization so you can start building.
        </p>
        {/* `role="note"` rather than the default `alert`: nothing has gone wrong, this is
            the way out for someone who is here by mistake. `Alert` spreads `...props`
            after its own role, so the override lands. */}
        <Alert variant="info" role="note" icon={null} className="mt-4">
          Expecting an invitation? Once a tenant administrator adds you, check again to
          continue.
        </Alert>
      </div>
      <div className="wiz-card__foot">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={onCheckAgain}>
            <RefreshCw aria-hidden="true" />
            Check again
          </Button>
          <Button variant="ghost" onClick={onSignOut} data-testid="onboarding-sign-out">
            <LogOut aria-hidden="true" />
            Sign out
          </Button>
        </div>
        <Button variant="primary" onClick={onGetStarted}>
          Set up your organization
          <ArrowRight aria-hidden="true" />
        </Button>
      </div>
    </>
  );
}
