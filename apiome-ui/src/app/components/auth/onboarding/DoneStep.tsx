'use client';

import { ArrowRight, CircleCheck } from 'lucide-react';
import { Avatar } from '../../ui/Avatar';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { EmptyStateArt } from '../../ui/EmptyState';
import { Spinner } from '../../ui/Spinner';

/** Inputs and callbacks of the completion step. */
export interface DoneStepProps {
  /** Name of the tenant that was just created. */
  tenantName: string;
  /** Slug of the tenant that was just created — the avatar's stable tone seed. */
  tenantSlug?: string;
  /** True while the session update + dashboard navigation is in flight. */
  navigating: boolean;
  /** Activate the new tenant and land in its dashboard. */
  onGoToDashboard: () => void;
}

/**
 * Terminal wizard step (OLO-4.1, re-skinned by HIVE-4.4 #5298): the tenant exists;
 * the only remaining action activates it in the session and lands the user in the
 * new tenant's dashboard (the wizard's completion acceptance criterion).
 *
 * Authority: `docs/mockups/auth/onboarding.html`, step 4.
 *
 * The art is the shared honeycomb of `ui/EmptyState` rather than a second drawing of
 * one — the same ornament the app uses everywhere it has nothing yet, here marking the
 * moment that stops being true. Under it the reader sees the thing they just made,
 * drawn the way it will look in the rail from now on: its avatar, its name, and the
 * two facts about it.
 *
 * @param props The new tenant, the navigating flag and the callback — see
 *   {@link DoneStepProps}.
 * @returns The step's body band and its action band.
 */
export function DoneStep({ tenantName, tenantSlug, navigating, onGoToDashboard }: DoneStepProps) {
  return (
    <>
      <div
        className="wiz-card__body flex flex-col items-center gap-2 text-center"
        data-testid="onboarding-step-done"
      >
        <EmptyStateArt icon={<CircleCheck />} />
        <h1 id="first-tenant-onboarding-title" className="auth-title">
          {tenantName} is ready
        </h1>
        <p className="auth-sub max-w-[46ch]">
          Your organization was created on the Free plan and you&apos;re its administrator.
        </p>
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          <Avatar size="sm" shape="hex" tone="brand" name={tenantName} seed={tenantSlug} />
          <span className="text-sm font-medium text-fg">{tenantName}</span>
          <Badge variant="outline">Owner</Badge>
          <Badge variant="honey">Free</Badge>
        </div>
      </div>

      <div className="wiz-card__foot wiz-card__foot--center">
        <Button size="lg" variant="primary" disabled={navigating} onClick={onGoToDashboard}>
          {navigating && <Spinner size="sm" tone="light" aria-hidden="true" />}
          Go to your dashboard
          {!navigating && <ArrowRight aria-hidden="true" />}
        </Button>
      </div>
    </>
  );
}
