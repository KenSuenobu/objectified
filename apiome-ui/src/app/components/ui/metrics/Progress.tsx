'use client';

/**
 * `<Progress>` — the determinate bar (HIVE-2.6, #5285).
 *
 * Authority: `docs/mockups/assets/hive.css` `.progress` / `--thin` / `--striped` and
 * `docs/mockups/DESIGN.md` §8 ("long-running steps show `.progress--striped` + a live log").
 *
 * A track and a fill, and nothing else: it is the one mark in this kit with no opinion about
 * what the number *means*. Import jobs, export stages and wizard steps hand it a share and a
 * tone; {@link Meter} wraps it when the share is a share *of a quota* and the tone should be
 * derived rather than chosen.
 *
 * The geometry is one inline custom property (`--progress-value`) rather than an inline
 * `width`, so the transition, the radius and the stripe animation all stay in `globals.css`
 * where a theme and the reduce-motion preference can reach them.
 */

import * as React from 'react';
import { cn } from '@lib/utils';
import { clampPercent, METRIC_TONE_MARK_CLASS, type MetricTone } from './metricTiers';

export interface ProgressProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'role'> {
  /** How far along, 0–100. Out-of-range and non-finite values are clamped to the track. */
  value: number;
  /**
   * The bar's colour. Defaults to `accent` — the mockup's unqualified `.progress`, and the
   * right register for "this is happening", which is not yet good news.
   */
  tone?: MetricTone;
  /** The 3 px rail (`.progress--thin`) instead of the 6 px bar, for use inside a table cell. */
  thin?: boolean;
  /** Sweep the fill with the moving 45° hatch that DESIGN.md §8 gives a long-running step. */
  striped?: boolean;
  /**
   * Accessible name. Required unless {@link decorative} is set — a bare `progressbar` with no
   * name is a serious axe finding, and a bar with no name is unreadable anyway.
   */
  label?: string;
  /**
   * Render no ARIA at all, because an ancestor already owns the semantics.
   *
   * {@link Meter} is `role="meter"` and carries the value itself; without this the reader would
   * meet a meter and a progressbar stacked on the same number and announce it twice.
   */
  decorative?: boolean;
  /**
   * Draw a hairline tick across the track at this share, 0–100 exclusive — the threshold the
   * bar is heading for. {@link Meter} sets it to the warn line; omit it for a plain bar.
   */
  tick?: number;
}

/**
 * Render the bar. See {@link ProgressProps}.
 *
 * @returns A labelled `role="progressbar"`, or an inert `<div>` when `decorative` is set.
 */
export const Progress = React.forwardRef<HTMLDivElement, ProgressProps>(function Progress(
  { value, tone = 'accent', thin, striped, label, decorative, tick, className, style, ...props },
  ref,
) {
  const percent = clampPercent(value);
  const hasTick = typeof tick === 'number' && Number.isFinite(tick) && tick > 0 && tick < 100;

  return (
    <div
      ref={ref}
      role={decorative ? undefined : 'progressbar'}
      aria-label={decorative ? undefined : label}
      aria-valuemin={decorative ? undefined : 0}
      aria-valuemax={decorative ? undefined : 100}
      aria-valuenow={decorative ? undefined : percent}
      aria-valuetext={decorative ? undefined : `${percent}%`}
      data-tone={tone}
      className={cn(
        'hive-progress',
        thin && 'hive-progress--thin',
        striped && 'hive-progress--striped',
        METRIC_TONE_MARK_CLASS[tone],
        className,
      )}
      style={{ ...style, '--progress-value': `${percent}%` } as React.CSSProperties}
      {...props}
    >
      <span className="hive-progress__fill" />
      {hasTick ? (
        <span
          aria-hidden
          className="hive-progress__tick"
          style={{ '--progress-tick': `${clampPercent(tick)}%` } as React.CSSProperties}
        />
      ) : null}
    </div>
  );
});
