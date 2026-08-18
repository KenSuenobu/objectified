'use client';

/**
 * The frame every step of the import wizard sits in (HIVE-6.4, #5315).
 *
 * Authority: `docs/mockups/build/import-wizard.html` — a `dialog--full` whose head is an icon
 * tile beside the title, whose stepper is centred on its own hairline-separated row, whose body
 * is the only part that scrolls, and whose footer carries Back on one side and the dismiss verb
 * plus the one primary action on the other.
 *
 * Before this the wizard drew a bespoke step indicator in ~90 lines of conditional Tailwind and
 * spelled its footer nine times, once per source. Both are here now, once, driven by
 * {@link importFooterFor} — which is what makes "Back is disabled during import" a rule with a
 * test rather than a `disabled={!importComplete}` that only one of the nine branches remembered.
 */

import * as React from 'react';
import { Upload } from 'lucide-react';

import { Button } from '@/app/components/ui/Button';
import { DialogDescription, DialogHeader, DialogTitle } from '@/app/components/ui/Dialog';
import { Stepper } from '@/app/components/ui/Stepper';
import { cn } from '@lib/utils';

import {
  IMPORT_WIZARD_COPY,
  IMPORT_WIZARD_STEPS,
  stepperIdFor,
  type ImportFooter,
  type ImportWizardStep,
} from './importWizardModel';

export interface ImportWizardHeadProps {
  /** Extra controls for the head's trailing edge — the *Recent import jobs* trigger. */
  actions?: React.ReactNode;
}

/**
 * The wizard's head: the tile, the title, the description, and any trailing controls.
 *
 * @param props See {@link ImportWizardHeadProps}.
 * @returns The header row.
 */
export function ImportWizardHead({ actions }: ImportWizardHeadProps) {
  return (
    <DialogHeader className="imp-wizard__head">
      <span className="tnt-icon-tile" data-tone="accent" aria-hidden>
        <Upload />
      </span>
      <div className="imp-wizard__heading">
        <DialogTitle>{IMPORT_WIZARD_COPY.title}</DialogTitle>
        <DialogDescription>{IMPORT_WIZARD_COPY.description}</DialogDescription>
      </div>
      {actions ? <div className="imp-wizard__head-actions">{actions}</div> : null}
    </DialogHeader>
  );
}

export interface ImportWizardStepsProps {
  /** Where the wizard is. */
  step: ImportWizardStep;
}

/**
 * The five-stop progress row.
 *
 * `Done` is the terminal stop rather than a sixth position, so on that step every stop reads as
 * complete — `Stepper`'s `complete` flag, which exists for exactly this shape.
 *
 * @param props See {@link ImportWizardStepsProps}.
 * @returns The stepper on its own row.
 */
export function ImportWizardSteps({ step }: ImportWizardStepsProps) {
  return (
    <div className="imp-wizard__steps">
      <Stepper
        aria-label="Import progress"
        steps={IMPORT_WIZARD_STEPS}
        current={stepperIdFor(step)}
        complete={step === 'done'}
      />
    </div>
  );
}

export interface ImportWizardFooterProps {
  /** The four slots, from {@link importFooterFor}. */
  footer: ImportFooter;
  onBack: () => void;
  onCancel: () => void;
  onPrimary: () => void;
  /** Only ever called from the MCP failure footer. */
  onKeepAnyway?: () => void;
  /**
   * A step-specific extra button, placed before the primary — today only the URL intake's
   * *Test URL*, which has to sit beside *Next →* rather than replace it.
   */
  extra?: React.ReactNode;
}

/**
 * The footer: Back on the leading edge, everything else trailing.
 *
 * A disabled Back is still drawn. Removing it mid-flow would shift the whole row, and the
 * reader needs to see that going back is a thing this wizard does — just not while a job is
 * running.
 *
 * @param props See {@link ImportWizardFooterProps}.
 * @returns The footer row.
 */
export function ImportWizardFooter({
  footer,
  onBack,
  onCancel,
  onPrimary,
  onKeepAnyway,
  extra,
}: ImportWizardFooterProps) {
  return (
    <div className="imp-wizard__foot">
      <div className="imp-wizard__foot-lead">
        {footer.back ? (
          <Button variant="outline" onClick={onBack} disabled={footer.back.disabled}>
            {footer.back.label}
          </Button>
        ) : null}
      </div>
      <div className="imp-wizard__foot-trail">
        <Button variant="outline" onClick={onCancel} disabled={footer.cancel.disabled}>
          {footer.cancel.label}
        </Button>
        {extra}
        {footer.keepAnyway && onKeepAnyway ? (
          <Button variant="honey" onClick={onKeepAnyway} disabled={footer.keepAnyway.disabled}>
            {footer.keepAnyway.label}
          </Button>
        ) : null}
        {footer.primary ? (
          <Button variant="primary" onClick={onPrimary} disabled={footer.primary.disabled}>
            {footer.primary.label}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export interface ImportWizardBodyProps extends React.HTMLAttributes<HTMLDivElement> {
  children?: React.ReactNode;
}

/**
 * The scrolling middle of the wizard.
 *
 * The dialog is a column of fixed head, fixed stepper, this, and a fixed footer — so a long
 * Preview scrolls without taking the progress row or the actions off-screen.
 *
 * @param props Standard `div` attributes; `children` is the step's content.
 * @returns The body region.
 */
export function ImportWizardBody({ className, ...props }: ImportWizardBodyProps) {
  return <div className={cn('imp-wizard__body', className)} {...props} />;
}
