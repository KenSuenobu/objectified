'use client';

import * as React from 'react';
import { Keyboard } from 'lucide-react';

import { Button } from '@/app/components/ui/Button';
import { Card } from '@/app/components/ui/Card';
import { Kbd } from '@/app/components/ui/Kbd';
import { ICON_SIZE, ICON_STROKE_WIDTH } from '@/app/components/ui/iconSizes';
import { formatShortcutKeys, spellShortcut } from '@lib/shortcuts';
import { useActiveShortcuts } from '@/app/hooks/useShortcuts';

import { glanceShortcuts } from './helpModel';

/**
 * *Shortcuts at a glance* (HIVE-4.9, #5303).
 *
 * Authority: `docs/mockups/foundations/help.html` — a card of eight two-column rows with a
 * *Full sheet* button in its header.
 *
 * The mockup writes its eight rows out by hand. This does not: the rows come from the live
 * registry through {@link glanceShortcuts}, so the strip cannot promise a chord that is not
 * bound on this screen — the rule HIVE-3.7 (#5293) set for the sheet, and the reason the
 * strip and the sheet can never disagree.
 *
 * ### Announcing a chord
 *
 * `Kbd` is decorative by design (HIVE-2.2): the chips are `aria-hidden` so the *Show keyboard
 * hints* preference can hide them in CSS without hiding anything a screen reader needs. Each
 * row therefore carries the chord in words in an `sr-only` span *outside* the chip group,
 * where that preference does not reach it — the same shape `ShortcutSheet` uses.
 */

/** Props for {@link ShortcutsGlance}. */
export interface ShortcutsGlanceProps {
  /** Open the full sheet — the header's one action. */
  onOpenSheet: () => void;
}

/** The card's heading, which the region is labelled by. */
export const SHORTCUTS_GLANCE_TITLE = 'Shortcuts at a glance';

/**
 * The glance strip.
 *
 * @param props See {@link ShortcutsGlanceProps}.
 * @returns The card, or `null` when nothing is bound — an empty strip says less than no
 *   strip, and the sheet is still one press of `?` away.
 */
export default function ShortcutsGlance({ onOpenSheet }: ShortcutsGlanceProps) {
  const headingId = React.useId();
  const shortcuts = glanceShortcuts(useActiveShortcuts());

  if (shortcuts.length === 0) return null;

  return (
    <Card
      role="region"
      aria-labelledby={headingId}
      className="help-glance"
      data-testid="help-shortcuts-glance"
    >
      <div className="help-glance__header">
        <h2 id={headingId} className="help-glance__title">
          <Keyboard size={ICON_SIZE.dense} strokeWidth={ICON_STROKE_WIDTH} aria-hidden />
          {SHORTCUTS_GLANCE_TITLE}
        </h2>
        <Button variant="ghost" size="sm" onClick={onOpenSheet} data-testid="help-open-sheet">
          Full sheet
        </Button>
      </div>

      <dl className="help-glance__grid">
        {shortcuts.map((shortcut) => (
          <div key={shortcut.id} className="help-glance__row" data-shortcut={shortcut.id}>
            <dt className="help-glance__label">{shortcut.description}</dt>
            <dd className="help-glance__keys">
              <Kbd keys={formatShortcutKeys(shortcut)} />
              <span className="sr-only">{spellShortcut(shortcut)}</span>
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
