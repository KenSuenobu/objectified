'use client';

/**
 * The Source step's card grid (HIVE-6.4, #5315).
 *
 * Authority: `docs/mockups/build/import-wizard.html` §Step 1 — a plain grid of surface cards,
 * each a glyph beside a title and one line of description, the chosen one ringed in `--accent`
 * and an unavailable one dimmed with a "Coming soon" title.
 *
 * What it replaces is the wizard's loudest surface: an indigo→purple gradient panel with a 2 px
 * indigo border, holding cards that grew their own hover gradient. DESIGN.md §1 spends colour on
 * meaning; a source picker means nothing in particular, so it is now the calmest thing in the
 * dialog and the *selected* card is the only one wearing accent.
 *
 * The grid stays data-driven (MFI-1.3): cards come from `useImportSources`, so a registry
 * adapter appears here with no edit.
 */

import * as React from 'react';

import { cardVariants } from '@/app/components/ui/Card';
import { cn } from '@lib/utils';

import type { ImportSourceCard } from '../dashboard/importSourceCatalog';
import { IMPORT_WIZARD_COPY } from './importWizardModel';

export interface ImportSourceCardsProps {
  /** The cards to draw, in order. */
  cards: ReadonlyArray<ImportSourceCard>;
  /** The `selectedSource` id, or `null` when nothing is chosen. */
  selected: string | null;
  /** Called with the card's panel id when a usable card is pressed. */
  onSelect: (panel: string) => void;
}

/**
 * The grid.
 *
 * A card with no intake panel is drawn as a disabled button rather than dropped: the server
 * advertises the adapter, and a source that silently is not there reads as a bug.
 *
 * The card *is* the button — `cardVariants` is applied to the `<button>` rather than wrapping
 * one, because a button inside a clickable div is two things a pointer can land on and only one
 * a keyboard can.
 *
 * @param props See {@link ImportSourceCardsProps}.
 * @returns The source grid.
 */
export function ImportSourceCards({ cards, selected, onSelect }: ImportSourceCardsProps) {
  return (
    <section aria-labelledby="imp-source-heading" className="flex flex-col gap-3">
      <h2 id="imp-source-heading" className="imp-heading">
        {IMPORT_WIZARD_COPY.sourceHeading}
      </h2>
      <div className="imp-cards">
        {cards.map((card) => {
          const Icon = card.icon;
          const disabled = card.panel === null;
          const active = !disabled && selected === card.panel;
          return (
            <button
              key={card.key}
              type="button"
              disabled={disabled}
              aria-pressed={disabled ? undefined : active}
              title={disabled ? IMPORT_WIZARD_COPY.comingSoon : undefined}
              onClick={() => card.panel && onSelect(card.panel)}
              className={cn(
                cardVariants({ variant: 'flat', hover: !disabled, selected: active }),
                'imp-card'
              )}
            >
              <span className="tnt-icon-tile" data-tone={active ? 'accent' : undefined} aria-hidden>
                <Icon />
              </span>
              <span className="imp-card__text">
                <span className="imp-card__title">{card.label}</span>
                <span className="imp-card__desc">
                  {disabled ? IMPORT_WIZARD_COPY.comingSoon : card.description}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

export default ImportSourceCards;
