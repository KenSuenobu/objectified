'use client';

/**
 * `<Ring>` — a 0–100 score as a dial (HIVE-2.6, #5285).
 *
 * Authority: `docs/mockups/assets/hive.css` `.ring` / `--sm` / `--lg`, and the four screens
 * that draw one — `home/overview.html` (project quality), `sources/catalog.html` and
 * `sources/catalog-item.html` (the Quality / Lint / Debt orbs), `build/versions.html` and
 * `sources/mcp-servers.html` (a version's or an endpoint's grade).
 *
 * Two things differ from the mockup, both deliberate:
 *
 * 1. **It is an SVG arc, not a `conic-gradient`.** hive.css punches the hole in the cone with
 *    a `::before` filled `var(--bg-surface)`, which is only invisible while the ring sits on a
 *    surface — on the canvas, in a table well or on a tinted card the hole shows as a white
 *    disc. A stroked arc has no hole to fill, so the ring is correct on every background.
 * 2. **The bands are the ticket's, not the mockups'.** The mockups disagree with each other
 *    (84 is `--accent` on one screen, 82 is `--ok` on another); {@link ringTier} settles it at
 *    ≥90 ok · 75–89 accent · 60–74 warn · <60 danger.
 *
 * The figure at the centre is the page's own ink rather than the band's, exactly as the mockup
 * leaves it: the arc is what carries the tier, and a two-digit number at 9 px has no contrast
 * budget to spend on a hue. Colour is therefore never the only signal — the score is printed
 * inside the thing the colour is describing.
 */

import * as React from 'react';
import { cn } from '@lib/utils';
import { letterGradeFromOverallPercent } from '@/app/utils/numeric-score-tier';
import {
  clampPercent,
  METRIC_TONE_MARK_CLASS,
  ringTier,
  type MetricTone,
} from './metricTiers';

/** The three sizes hive.css ships: 30 px, 44 px and 72 px. */
export type RingSize = 'sm' | 'default' | 'lg';

/**
 * The ring's own coordinate system.
 *
 * One `viewBox` serves all three sizes — CSS sets the box in `rem` and the browser scales the
 * drawing — so the arc keeps its proportion at every size, density and font scale.
 */
const VIEWBOX = 48;

/**
 * Width of the arc band, in user units.
 *
 * hive.css insets its `::before` by 4 px inside a 44 px ring, i.e. a band of 4/44 ≈ 9 % of the
 * diameter. 4.5 of 48 is the same 9 %, held constant across the three sizes rather than drifting
 * from 10 % (sm) to 8 % (lg) as the mockup's three hand-tuned insets do.
 */
const BAND = 4.5;

/** Radius of the arc's centre line — the band sits half in, half out of it. */
const RADIUS = (VIEWBOX - BAND) / 2;

/** Length of the full circle, i.e. the dash pattern a 100 % arc fills. */
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * Size of the centred figure, in user units, per ring size.
 *
 * These cannot come from `ui/svgTypography.ts`: those sizes are stated against the chart kit's
 * own `viewBox`, and a user unit there is not a user unit here. They are hive.css's three font
 * sizes carried into this coordinate system — 9/30, 12/44 and 15/72 of the diameter, times 48 —
 * so a ring renders the mockup's proportions at whatever `rem` box CSS gives it. The figure
 * shrinks *relative to the ring* as the ring grows, which is what keeps a large ring from
 * reading as a number with a hoop round it.
 */
const TEXT_UNITS: Readonly<Record<RingSize, number>> = {
  sm: 14,
  default: 13,
  lg: 10,
};

export interface RingProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'role'> {
  /**
   * The score, 0–100. `null`/`undefined`/non-finite renders the unscored ring — no arc, and
   * {@link placeholder} in the faint ink — so "not measured yet" never reads as "measured, and
   * zero". (A `grade` given without a score still prints its letter: the letter is information
   * even when the number behind it was not kept.)
   */
  score: number | null | undefined;
  /** What the ring is scoring — the accessible name (`"Quality score"`). Required. */
  label: string;
  /** 30 px, 44 px (default) or 72 px. */
  size?: RingSize;
  /**
   * What to draw at the centre. `score` prints the number; `grade` prints the A–F letter, which
   * is what `build/versions.html` and the catalog's Lint orb show. Either way the *other* one is
   * still spoken, because the ring is one statement about one number.
   */
  display?: 'score' | 'grade';
  /**
   * The captured letter grade, when the surface has one. Defaults to the letter the shared
   * `letterGradeFromOverallPercent` bands derive from `score`, so a ring and the `GradeChip` in
   * the row beside it can never disagree.
   */
  grade?: string | null;
  /** Pin the arc's colour instead of deriving it from {@link ringTier}. */
  tone?: MetricTone;
  /** What the unscored ring prints. Defaults to an em dash. */
  placeholder?: string;
}

/**
 * Render the ring. See {@link RingProps}.
 *
 * @returns A `role="meter"` carrying the score as `aria-valuenow` and a sentence as
 *   `aria-valuetext`, or — when there is no score — a `role="img"` that says so.
 */
export const Ring = React.forwardRef<HTMLSpanElement, RingProps>(function Ring(
  {
    score,
    label,
    size = 'default',
    display = 'score',
    grade,
    tone,
    placeholder = '—',
    className,
    ...props
  },
  ref,
) {
  const scored = typeof score === 'number' && Number.isFinite(score);
  const percent = scored ? clampPercent(score) : 0;
  const tier = ringTier(scored ? score : null);
  const resolved = tone ?? tier.tone;

  const letter = grade?.trim()
    ? grade.trim().charAt(0).toUpperCase()
    : scored
      ? letterGradeFromOverallPercent(percent)
      : null;

  // A captured grade is real information even when the number behind it was not kept — the
  // catalog's Lint orb is exactly that case — so the letter is drawn whether or not there is an
  // arc to draw around it. Only a ring with *nothing* to say falls back to the placeholder.
  const showGrade = display === 'grade' && letter !== null;
  const figure = showGrade ? letter : scored ? String(percent) : placeholder;
  const known = scored || showGrade;

  // Both halves of the statement, whichever half is drawn: a reader of the Lint orb needs the
  // score the letter came from, and a reader of the Quality orb needs the letter the report
  // will call it.
  const spoken = letter
    ? `${percent} out of 100 — grade ${letter}, ${tier.label.toLowerCase()}`
    : `${percent} out of 100 — ${tier.label.toLowerCase()}`;

  const unscoredName = showGrade
    ? `${label}: grade ${letter}`
    : `${label}: ${tier.label.toLowerCase()}`;

  return (
    <span
      ref={ref}
      role={scored ? 'meter' : 'img'}
      aria-label={scored ? label : unscoredName}
      aria-valuemin={scored ? 0 : undefined}
      aria-valuemax={scored ? 100 : undefined}
      aria-valuenow={scored ? percent : undefined}
      aria-valuetext={scored ? spoken : undefined}
      data-tone={resolved}
      data-size={size}
      data-scored={known ? 'true' : 'false'}
      className={cn('hive-ring', scored && METRIC_TONE_MARK_CLASS[resolved], className)}
      {...props}
    >
      <svg viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`} aria-hidden focusable="false">
        <circle
          className="hive-ring__track"
          cx={VIEWBOX / 2}
          cy={VIEWBOX / 2}
          r={RADIUS}
          strokeWidth={BAND}
        />
        {scored && percent > 0 ? (
          <circle
            className="hive-ring__arc"
            cx={VIEWBOX / 2}
            cy={VIEWBOX / 2}
            r={RADIUS}
            strokeWidth={BAND}
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE.toFixed(2)}
            strokeDashoffset={(CIRCUMFERENCE * (1 - percent / 100)).toFixed(2)}
            transform={`rotate(-90 ${VIEWBOX / 2} ${VIEWBOX / 2})`}
          />
        ) : null}
        <text
          className="hive-ring__figure"
          x={VIEWBOX / 2}
          y={VIEWBOX / 2}
          fontSize={TEXT_UNITS[size]}
          textAnchor="middle"
          dominantBaseline="central"
        >
          {figure}
        </text>
      </svg>
    </span>
  );
});
