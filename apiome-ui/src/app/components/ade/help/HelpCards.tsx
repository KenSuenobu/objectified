'use client';

import * as React from 'react';
import { ArrowUpRight } from 'lucide-react';

import { badgeVariants } from '@/app/components/ui/Badge';
import { cardVariants } from '@/app/components/ui/Card';
import { ICON_SIZE, ICON_STROKE_WIDTH } from '@/app/components/ui/iconSizes';
import { cn } from '@lib/utils';

import HelpSupportCard from './HelpSupportCard';
import { HELP_CARDS, type HelpCard } from './helpModel';

/**
 * The six help cards (HIVE-4.9, #5303).
 *
 * Authority: `docs/mockups/foundations/help.html` — a three-column grid of
 * `.card--hover .card--link .card--pad`, each with a tinted hexagon, a title and one line.
 *
 * ### A card is the element it behaves like
 *
 * The rule HIVE-4.5 (#5299) set for the launcher's tiles, applied again: a destination is an
 * `<a>`, something that happens in this tab is a `<button>`, and an unshipped card is a
 * `<button disabled>` — natively non-interactive, keyboard-skipped, and legal to label.
 * Drawing any of them as a `<div>` with a click handler would leave the card unreachable by
 * keyboard and unannounced by role, which is exactly what the axe budget forbids.
 *
 * The one card that is neither is *Contact support*: it carries two affordances of its own,
 * so it is a plain card ({@link HelpSupportCard}) rather than a link that would have to nest
 * them.
 */

/** Props for {@link HelpCards}. */
export interface HelpCardsProps {
  /** Run the *Get started* card: reopen the Home checklist. */
  onGetStarted: () => void;
  /** `current_tenant_id` from the session, for the support card. */
  tenantId?: string | null;
  /** The build badge, for the support card. */
  buildLabel: string;
}

/**
 * The card skin every kind shares.
 *
 * @param interactive Whether the whole card can be chosen, which is what earns the hover
 *   lift and the link reset. A disabled card gets neither.
 * @returns The class list: the shared surface, then this page's own layout.
 */
function cardClass(interactive: boolean): string {
  return cn(cardVariants({ hover: interactive, link: interactive }), 'help-card');
}

/**
 * A card's glyph, title and line — the part that does not depend on which element wraps it.
 *
 * Every child is a `<span>`, because two of the three wrappers are `<button>`s and their
 * content model is phrasing content.
 *
 * @param props.card The card to draw.
 * @returns The card's contents.
 */
function CardBody({ card }: { card: HelpCard }) {
  const Icon = card.icon;

  return (
    <>
      <span className="help-tile" aria-hidden>
        <Icon size={ICON_SIZE.rail} strokeWidth={ICON_STROKE_WIDTH} />
      </span>
      <span className="help-card__title">
        {card.title}
        {card.badge && (
          <span className={cn(badgeVariants({ variant: 'outline' }), 'help-card__badge')}>
            {card.badge}
          </span>
        )}
        {card.kind === 'external' && (
          <ArrowUpRight
            size={ICON_SIZE.dense}
            strokeWidth={ICON_STROKE_WIDTH}
            aria-hidden
            className="help-card__out"
          />
        )}
      </span>
      <span className="help-card__desc">{card.description}</span>
    </>
  );
}

/**
 * One card.
 *
 * @param props.card The card to draw.
 * @param props.onGetStarted What the `action` card runs.
 * @returns The card as the element its behaviour calls for.
 */
function HelpGridCard({ card, onGetStarted }: { card: HelpCard; onGetStarted: () => void }) {
  const shared = { 'data-tone': card.tone, 'data-testid': `help-card-${card.id}` };

  if (card.kind === 'soon') {
    return (
      <button
        type="button"
        disabled
        aria-label={`${card.title} (coming soon)`}
        className={cn(cardClass(false), 'help-card--soon')}
        {...shared}
      >
        <CardBody card={card} />
      </button>
    );
  }

  if (card.kind === 'action') {
    return (
      <button
        type="button"
        onClick={onGetStarted}
        className={cn(cardClass(true), 'help-card--action')}
        {...shared}
      >
        <CardBody card={card} />
      </button>
    );
  }

  return (
    <a
      href={card.href}
      target="_blank"
      rel="noopener noreferrer"
      className={cardClass(true)}
      {...shared}
    >
      <CardBody card={card} />
    </a>
  );
}

/**
 * The card grid.
 *
 * @param props See {@link HelpCardsProps}.
 * @returns Six cards in a responsive grid.
 */
export default function HelpCards({ onGetStarted, tenantId, buildLabel }: HelpCardsProps) {
  return (
    <div className="help-grid" data-testid="help-cards">
      {HELP_CARDS.map((card) =>
        card.kind === 'support' ? (
          <HelpSupportCard
            key={card.id}
            card={card}
            tenantId={tenantId}
            buildLabel={buildLabel}
          />
        ) : (
          <HelpGridCard key={card.id} card={card} onGetStarted={onGetStarted} />
        )
      )}
    </div>
  );
}
