'use client';

/**
 * "Proposed steps 2–4" (HIVE-7.4, #5321).
 *
 * Authority: `docs/mockups/sources/repository-new.html`, the card the mockup's **Notes → Adds**
 * list introduces: *"Steps 2–4 fleshed out as a marked proposal card (Repository browse · Scan
 * settings · Confirm); the live form still commits from step 1."*
 *
 * ### The ticket's third acceptance criterion, and why it needs four marks
 *
 * "Unimplemented steps are unmistakably marked as proposed." A single honey chip is not
 * unmistakable — a reader who scrolls past it sees three headed columns that look exactly like
 * the three working cards above. So the card states it four times, in four channels:
 *
 * * the **heading** says *Proposed steps 2–4*, not *Steps 2–4*;
 * * the **chip** beside it is a full sentence — {@link PROPOSAL_BADGE};
 * * a **line under the heading** says the form above is the whole flow today;
 * * and nothing inside is **interactive at all** — no field, no button, no link, so there is
 *   nothing to press and find inert. That is also why the columns are a `<dl>`: they are
 *   descriptions of steps, not steps.
 *
 * The honey frame is the fourth. DESIGN.md §2 spends honey on brand moments rather than on
 * states, and a design proposal inside the product is exactly that — it is not a warning, and
 * amber would file it with the things that are wrong.
 *
 * Marked `aria-describedby` from the progress row's chip, so a screen-reader user who meets
 * "Steps 2–4 proposed" up there is pointed at the explanation down here.
 */

import * as React from 'react';
import { Lightbulb } from 'lucide-react';

import { Badge } from '@/app/components/ui/Badge';
import { Card } from '@/app/components/ui/Card';

import { PROPOSAL_BADGE, PROPOSAL_NOTE, PROPOSAL_TITLE, PROPOSED_STEPS } from './addRepositoryModel';

export interface ProposedStepsCardProps {
  /** The card's DOM id, so the progress row's chip can point at it. */
  id?: string;
}

/**
 * Render the proposal. See {@link ProposedStepsCardProps}.
 *
 * @returns A non-interactive card describing the three steps that do not exist.
 */
export function ProposedStepsCard({ id }: ProposedStepsCardProps) {
  return (
    <Card
      id={id}
      variant="flat"
      className="repo-new-proposal"
      data-testid="repo-proposed-steps"
      aria-labelledby="repo-proposal-title"
    >
      <div className="repo-new-proposal__head">
        <h2 className="repo-new-proposal__title" id="repo-proposal-title">
          <Lightbulb aria-hidden />
          {PROPOSAL_TITLE}
        </h2>
        <Badge variant="honey" size="lg" className="repo-new-proposal__badge">
          {PROPOSAL_BADGE}
        </Badge>
      </div>

      <p className="repo-new-proposal__note">{PROPOSAL_NOTE}</p>

      <dl className="repo-new-proposal__grid">
        {PROPOSED_STEPS.map((step) => (
          <div key={step.id} className="repo-new-proposal__item">
            <dt className="repo-new-proposal__step">{step.title}</dt>
            <dd className="repo-new-proposal__body">{step.body}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

export default ProposedStepsCard;
