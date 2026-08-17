'use client';

/**
 * Dashboard first-run checklist (#3614; redrawn for Hive by HIVE-4.6, #5300).
 *
 * Authority: `docs/mockups/home/overview.html` §"Getting started", whose Notes fix the contract:
 * "same 5 steps & completion derivation; dismiss persists
 * `ade.dashboard.firstRunChecklist.dismissed`; hex progress replaces the 'n/m done' badge".
 *
 * All three are kept. What changed is the shape and the skin:
 *
 * - The panel is the **honey card** — `DESIGN.md` §2 lists the first-run checklist among the four
 *   places honey is allowed to appear, and this is the one brand moment on an otherwise calm
 *   page. It replaces a grey `bg-gray-50 dark:bg-gray-900` header bar that named two greys per
 *   appearance and followed no theme.
 * - The steps are a **five-column grid of step cards**, not five stacked rows. All five fit on
 *   one line at the page's width, so the reader sees the whole path at once rather than
 *   scrolling a list to find out how long it is.
 * - Exactly one step is marked **Next** — the first incomplete one — and only that step carries a
 *   button. §1.2 gives a screen one obvious next step; five identical "go here" links is five.
 *   The steps after it are not links either, and that is honest rather than a loss: a reader
 *   cannot view a spec in Browse before publishing it, so a link there would be a promise the
 *   path itself has not reached.
 * - Once every step is done, the *card* carries the one remaining action — "Open Browse", which
 *   is what its own copy has always offered — so the finished state is not a dead panel waiting
 *   to be dismissed.
 * - Completed steps keep the strike-through they had, and the whole card is quieted rather than
 *   greyed with a literal colour.
 *
 * The Designer-dependent steps are still omitted when no Designer URL is configured, which is
 * the pre-existing behaviour {@link buildSteps} has always had: those two steps cannot be *done*
 * from this deployment, so offering them would be a checklist with an unreachable step.
 */

import { useState } from 'react';
import Link from 'next/link';
import { ArrowRight, CircleCheck, Circle, ExternalLink, Rocket, X } from 'lucide-react';

import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { cn } from '../../../../../lib/utils';
import { BROWSE_APP_URL } from '../../../../../lib/app-urls';
import { getDesignerHomeHref } from '../../../../../lib/external-links';
import { HexProgress } from './home/HexProgress';
import {
  type ChecklistSignal,
  type StepId,
  deriveCompletion,
  isDismissed,
  setDismissed,
} from './firstRunChecklist';

/** One step of the path to a published, browsable spec. */
interface StepDef {
  id: StepId;
  label: string;
  hint: string;
  href: string;
  /**
   * The button's own words, when this is the Next step.
   *
   * Deliberately not the step's `label`: a button repeating the heading directly above it says
   * the same thing twice to a screen reader working through the card, and names the *state*
   * ("Publish it") where a button should name the *destination* ("Go to versions").
   */
  cta: string;
  /** True when the step leaves the app, so the button is an `<a>` with an external glyph. */
  external?: boolean;
}

/** The three steps every deployment can complete. */
const CORE_STEPS: StepDef[] = [
  { id: 'version', label: 'Cut a version', hint: 'Snapshot your schema as a version.', href: '/ade/dashboard/versions', cta: 'Go to versions' },
  { id: 'publish', label: 'Publish it', hint: 'Publish the version so it becomes browsable.', href: '/ade/dashboard/versions', cta: 'Go to versions' },
  { id: 'browse', label: 'View it in Browse', hint: 'See your published spec render publicly.', href: BROWSE_APP_URL, cta: 'Open Browse', external: true },
];

/**
 * The steps this deployment can offer.
 *
 * @returns The two Designer steps followed by {@link CORE_STEPS} when a Designer URL is
 *   configured; the core three alone when it is not.
 */
function buildSteps(): StepDef[] {
  const designerHref = getDesignerHomeHref();
  const designerSteps: StepDef[] = designerHref
    ? [
        { id: 'project', label: 'Create your first project', hint: 'Open the Designer to start a project.', href: designerHref, cta: 'Open the Designer' },
        { id: 'class', label: 'Add a class from a starter template', hint: 'Browse the built-in templates to add a class.', href: designerHref, cta: 'Browse templates' },
      ]
    : [];
  return [...designerSteps, ...CORE_STEPS];
}

/** Props for {@link FirstRunChecklist}. */
interface FirstRunChecklistProps {
  /** The dashboard counts completion is derived from. */
  stats: ChecklistSignal;
}

/**
 * Draw the checklist.
 *
 * @param props See {@link FirstRunChecklistProps}.
 * @returns The honey card, or `null` once the reader has dismissed it.
 */
export function FirstRunChecklist({ stats }: FirstRunChecklistProps) {
  // Lazily read the dismissal flag. Safe because this component is only mounted client-side after
  // the dashboard finishes loading (the parent gates on !isLoading), so it is never server-rendered
  // and there is no hydration mismatch; isDismissed() also returns false when storage is absent.
  const [dismissed, setDismissedState] = useState<boolean>(() => isDismissed());

  if (dismissed) return null;

  const steps = buildSteps();
  const done = deriveCompletion(stats);
  const completed = steps.filter((step) => done[step.id]).length;
  const finished = completed === steps.length;
  // The one step that gets a button. `findIndex` rather than "the first not done" computed twice,
  // so the card and the grid cannot disagree about which step is next.
  const nextIndex = steps.findIndex((step) => !done[step.id]);

  const handleDismiss = () => {
    setDismissed();
    setDismissedState(true);
  };

  return (
    <Card variant="honey" className="home-checklist" role="group" aria-labelledby="home-checklist-title">
      <div className="home-checklist__head">
        <div className="home-checklist__lede">
          <span className="home-checklist__mark" aria-hidden>
            <Rocket />
          </span>
          <div className="home-checklist__text">
            <div className="home-checklist__titlerow">
              <h2 id="home-checklist-title">
                {finished ? "You're all set" : 'Get to your first published spec'}
              </h2>
              <Badge variant={finished ? 'ok' : 'honey'}>
                {completed} / {steps.length} done
              </Badge>
            </div>
            <p className="home-checklist__desc">
              {finished
                ? 'You have published a browsable spec — explore Browse, or dismiss this.'
                : 'Reach a published, browsable spec in a few steps. Dismiss anytime.'}
            </p>
          </div>
        </div>
        <div className="home-checklist__aside">
          {finished ? (
            <Button variant="honey" size="sm" asChild>
              <a href={BROWSE_APP_URL} target="_blank" rel="noopener noreferrer">
                Open Browse
                <ExternalLink aria-hidden />
              </a>
            </Button>
          ) : null}
          <HexProgress done={completed} total={steps.length} />
          <Button
            variant="ghost"
            size="icon"
            onClick={handleDismiss}
            aria-label="Dismiss getting-started checklist"
          >
            <X aria-hidden />
          </Button>
        </div>
      </div>

      <ol className="home-steps" data-steps={steps.length}>
        {steps.map((step, index) => {
          const isDone = done[step.id];
          const isNext = index === nextIndex;
          const StepIcon = isDone ? CircleCheck : Circle;
          const GoIcon = step.external ? ExternalLink : ArrowRight;

          return (
            <li
              key={step.id}
              className={cn('home-step', isDone && 'home-step--done', isNext && 'home-step--next')}
              data-step={step.id}
            >
              <p className="home-step__title">
                <StepIcon className="home-step__mark" aria-hidden />
                <span className="home-step__label">{step.label}</span>
                {isNext ? (
                  <Badge variant="honey" className="home-step__badge">
                    Next
                  </Badge>
                ) : null}
              </p>
              <p className="home-step__hint">{step.hint}</p>
              {isNext ? (
                <Button variant="honey" size="sm" asChild className="home-step__go">
                  {step.external ? (
                    <a href={step.href} target="_blank" rel="noopener noreferrer">
                      {step.cta}
                      <GoIcon aria-hidden />
                    </a>
                  ) : (
                    <Link href={step.href}>
                      {step.cta}
                      <GoIcon aria-hidden />
                    </Link>
                  )}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

export default FirstRunChecklist;
