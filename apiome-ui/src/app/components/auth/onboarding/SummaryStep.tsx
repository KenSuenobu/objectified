'use client';

import { ArrowLeft, BadgeCheck, Check } from 'lucide-react';
import { FREE_LICENSE_SUMMARY } from '@lib/auth/free-license';
import { Alert } from '../../ui/Alert';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Spinner } from '../../ui/Spinner';

/** The chip beside the plan name — the one thing readers most want confirmed here. */
const NO_PAYMENT_DETAILS = 'No payment details';

/** Inputs and callbacks of the review step. */
export interface SummaryStepProps {
  /** Organization name about to be created. */
  name: string;
  /** Slug about to be created. */
  slug: string;
  /** Provisioning error to display, if the last confirm attempt failed. */
  error: string | null;
  /** True while the create call is in flight (disables both actions). */
  submitting: boolean;
  /** Return to the organization step. */
  onBack: () => void;
  /** Create the tenant. */
  onConfirm: () => void;
}

/**
 * Third wizard step (OLO-4.1, re-skinned by HIVE-4.4 #5298): review before confirm.
 *
 * Authority: `docs/mockups/auth/onboarding.html`, step 3.
 *
 * Shows the entered organization details and the Free license the tenant will start
 * on ({@link FREE_LICENSE_SUMMARY}) — the acceptance criterion is that the user sees
 * the plan before anything is created. The quotas are drawn as the mockup's three
 * cells rather than a list of rows, which is what lets the numbers be read at a
 * glance; they are still the same three entitlements, from the same constant.
 *
 * @param props The values, the error and submitting state, and the two callbacks —
 *   see {@link SummaryStepProps}.
 * @returns The step's body band and its action band.
 */
export function SummaryStep({ name, slug, error, submitting, onBack, onConfirm }: SummaryStepProps) {
  return (
    <>
      <div className="wiz-card__body" data-testid="onboarding-step-summary">
        <h1 id="first-tenant-onboarding-title" className="auth-title">
          Review and create
        </h1>
        <p className="auth-sub mt-1">
          Here&apos;s what will be created. You can change details later in tenant settings.
        </p>

        <dl className="wiz-kv mt-4">
          <div>
            <dt>Organization</dt>
            <dd className="font-medium">{name}</dd>
          </div>
          <div>
            <dt>URL slug</dt>
            <dd className="mono">{slug}</dd>
          </div>
        </dl>

        {/* `role="region"` is what a `<section aria-label>` produced before the card
            primitive was adopted here — and `aria-label` on a role-less `div` is an axe
            `aria-prohibited-attr` violation, so the role has to be stated. */}
        <Card
          variant="flat"
          role="region"
          aria-label={`${FREE_LICENSE_SUMMARY.planName} plan summary`}
          className="mt-4 p-[var(--card-pad)]"
          data-testid="free-license-summary"
        >
          <div className="flex flex-wrap items-center gap-2">
            <BadgeCheck aria-hidden="true" className="size-4 shrink-0 text-ok-fg" />
            {/* `.wiz-plan-title`, not `text-sm`: an unlayered `h2 { font-size }` in
                `globals.css` outranks every layered utility. */}
            <h2 className="wiz-plan-title">{FREE_LICENSE_SUMMARY.planName} plan</h2>
            <Badge variant="ok" className="ml-auto">
              {NO_PAYMENT_DETAILS}
            </Badge>
          </div>
          {/* A `div`, not a `p`: the unlayered `p { color: … }` at the foot of `globals.css`
              outranks every `@layer utilities` colour. */}
          <div className="mt-1 text-xs text-fg-muted">{FREE_LICENSE_SUMMARY.description}</div>

          <dl className="wiz-limits mt-3">
            {FREE_LICENSE_SUMMARY.limits.map((limit) => (
              <div key={limit.label}>
                <dt>{limit.label}</dt>
                <dd>{limit.value}</dd>
              </div>
            ))}
          </dl>

          <ul className="mt-3 flex flex-col gap-1">
            {FREE_LICENSE_SUMMARY.includes.map((item) => (
              <li key={item} className="flex items-start gap-2 text-xs text-fg-muted">
                <Check aria-hidden="true" className="mt-px size-3.5 shrink-0 text-ok-fg" />
                {item}
              </li>
            ))}
          </ul>
        </Card>

        {error && (
          <Alert variant="danger" role="alert" className="mt-4" data-testid="onboarding-error">
            {error}
          </Alert>
        )}
      </div>

      <div className="wiz-card__foot">
        <Button type="button" variant="outline" disabled={submitting} onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
          Back
        </Button>
        <Button type="button" variant="primary" disabled={submitting} onClick={onConfirm}>
          {submitting && <Spinner size="sm" tone="light" aria-hidden="true" />}
          {submitting ? 'Creating…' : 'Create organization'}
        </Button>
      </div>
    </>
  );
}
