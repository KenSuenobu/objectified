'use client';

/**
 * `<Stat>` / `<StatGrid>` — the headline figure and the strip it sits in (HIVE-2.6, #5285).
 *
 * Authority: `docs/mockups/assets/hive.css` `.stat`, `.stat__label/__value/__delta/__foot` and
 * `.stat-grid` / `--3`…`--7`, plus `docs/mockups/DESIGN.md` §8 ("List page = page header →
 * optional stat strip → table") and §3.2 (`4xl 30` is the stat step; figures are tabular).
 *
 * A stat is four optional things around one required one: a label with a leading glyph, the
 * figure itself with an optional unit, a delta chip saying which way it moved, and a footnote.
 * The grid is the hairline trick from hive.css — a 1 px gap over a `--border` background, with
 * each cell painting its own surface — so a strip of stats reads as one object with rules
 * between it rather than as N cards that happen to be adjacent.
 *
 * The delta is the only part with an opinion, and {@link DeltaPolarity} is where the caller
 * states it: a rising number is good news for published versions and bad news for open
 * findings, and a chip that always paints a rise green would congratulate a regression.
 */

import * as React from 'react';
import { ArrowDown, ArrowUp, Minus } from 'lucide-react';
import { cn } from '@lib/utils';
import {
  deltaDirection,
  deltaTone,
  formatDelta,
  METRIC_TONE_INK_CLASS,
  type DeltaPolarity,
} from './metricTiers';

/** The glyph for each direction. Decorative — the sign is already in the chip's text. */
const DELTA_ICON = {
  up: ArrowUp,
  down: ArrowDown,
  flat: Minus,
} as const;

export interface StatProps extends React.HTMLAttributes<HTMLDivElement> {
  /** What the figure counts. Sentence case, per DESIGN.md §10. */
  label: string;
  /** A leading glyph for the label. Sized and coloured by the stylesheet, not by the caller. */
  icon?: React.ReactNode;
  /** The figure. A pre-formatted string when the caller has its own number formatting. */
  value: React.ReactNode;
  /** A unit set small and quiet beside the figure (`"total"`, `"ms"`, `"/ 100"`). */
  unit?: string;
  /** The change since the compared period. Omit for a figure that is not being compared. */
  delta?: number;
  /** Suffix for the delta, appended with no space (`"%"`). */
  deltaUnit?: string;
  /** Which direction is the good one. Defaults to `positive` — up is good. */
  deltaPolarity?: DeltaPolarity;
  /** Replace the delta's text entirely, when `+12` is not how this metric states a change. */
  deltaLabel?: string;
  /** The quiet line under the figure — what it is measured against, or when it was taken. */
  footnote?: React.ReactNode;
  /** A second footnote pushed to the opposite end, as `.stat__foot`'s space-between implies. */
  footnoteEnd?: React.ReactNode;
}

/**
 * Render one stat. See {@link StatProps}.
 *
 * @returns The label / figure / delta / footnote block, as flowing text so a screen reader
 *   reads it in the order it is drawn.
 */
export const Stat = React.forwardRef<HTMLDivElement, StatProps>(function Stat(
  {
    label,
    icon,
    value,
    unit,
    delta,
    deltaUnit,
    deltaPolarity = 'positive',
    deltaLabel,
    footnote,
    footnoteEnd,
    className,
    ...props
  },
  ref,
) {
  const hasDelta = typeof delta === 'number' && Number.isFinite(delta);
  const direction = hasDelta ? deltaDirection(delta) : 'flat';
  const tone = deltaTone(direction, deltaPolarity);
  const DeltaIcon = DELTA_ICON[direction];

  return (
    <div ref={ref} className={cn('hive-stat', className)} {...props}>
      <span className="hive-stat__label">
        {icon}
        {label}
      </span>
      <span className="hive-stat__value">
        {value}
        {unit ? <small>{unit}</small> : null}
      </span>
      {hasDelta ? (
        <span
          data-direction={direction}
          data-tone={tone}
          className={cn('hive-stat__delta', METRIC_TONE_INK_CLASS[tone])}
        >
          <DeltaIcon aria-hidden />
          {deltaLabel ?? formatDelta(delta, deltaUnit)}
        </span>
      ) : null}
      {footnote || footnoteEnd ? (
        <span className="hive-stat__foot">
          {footnote ? <span>{footnote}</span> : null}
          {footnoteEnd ? <span>{footnoteEnd}</span> : null}
        </span>
      ) : null}
    </div>
  );
});

/** The column counts `.stat-grid--N` ships. Anything else falls back to the auto-fit track. */
export type StatGridColumns = 3 | 4 | 5 | 6 | 7;

export interface StatGridProps extends React.HTMLAttributes<HTMLDivElement> {
  /**
   * Fix the strip at this many columns. Omit to let it auto-fit at a minimum cell width, which
   * is what an unknown number of stats wants. Four and above collapse to three (seven to four)
   * below 1100 px, as hive.css does, so a stat never gets narrower than its own figure.
   */
  columns?: StatGridColumns;
}

/**
 * Render the stat strip. See {@link StatGridProps}.
 *
 * @returns A grid whose 1 px gaps show the `--border` behind it as hairlines.
 */
export const StatGrid = React.forwardRef<HTMLDivElement, StatGridProps>(function StatGrid(
  { columns, className, children, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      data-columns={columns}
      className={cn('hive-stat-grid', className)}
      {...props}
    >
      {children}
    </div>
  );
});
