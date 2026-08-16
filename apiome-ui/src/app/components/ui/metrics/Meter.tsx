'use client';

/**
 * `<Meter>` — a share of a quota (HIVE-2.6, #5285).
 *
 * Authority: `docs/mockups/assets/hive.css` `.meter` / `.meter-val`, and
 * `docs/mockups/workspace/tenants.html`, which draws the member-seat meter this component
 * replaces — `role="meter"`, warn tint at 80 %, the figure printed beside the bar.
 *
 * The difference from a bare {@link Progress} is that a meter knows what its number *means*:
 * it is a share of something finite, more of it is worse, and there is a line past which the
 * next seat, import or call will be refused. So the tone is **derived** ({@link meterTier}) —
 * quiet below 80 %, warn from there, danger at the cap — and the 80 % line is drawn on the
 * track rather than only being crossed.
 *
 * Semantics live on the wrapper: it is the `role="meter"` and it carries the real `value`/`max`
 * pair, not the derived percentage, so a reader hears "4 of 5" rather than "80". The bar inside
 * is `decorative`, because a meter and a progressbar announcing the same number is a bug.
 */

import * as React from 'react';
import { cn } from '@lib/utils';
import { Progress } from './Progress';
import {
  METER_WARN_PERCENT,
  METRIC_TONE_INK_CLASS,
  meterPercent,
  meterTier,
  type MetricTone,
} from './metricTiers';

export interface MeterProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'role'> {
  /**
   * What is being metered — the accessible name (`"Member seats"`, `"Monthly mock calls"`).
   * Required: `role="meter"` without a name is a serious axe finding.
   */
  label: string;
  /** How much of the quota is used. */
  value: number;
  /** The quota. Defaults to 100, i.e. `value` is already a percentage. */
  max?: number;
  /**
   * Pin the tone instead of deriving it from usage. For a meter whose number is a *score*
   * rather than a load — the mockup's per-category lint breakdown ("Documentation 60 %",
   * `progress--warn`) — where 80 % is good news and the usage bands would read backwards.
   */
  tone?: MetricTone;
  /** Show `label` as visible leading text as well as the accessible name. */
  showLabel?: boolean;
  /** Print the figure beside the bar (default true). Turn off when the caller prints it. */
  showValue?: boolean;
  /** Override the printed figure. Defaults to the whole-percent share, e.g. `"80%"`. */
  valueLabel?: string;
  /**
   * Override the sentence read to assistive tech. Defaults to `"4 of 5 (80%)"`, or just the
   * percentage when `max` is 100 and the two would say the same thing twice.
   */
  valueText?: string;
  /**
   * Where to draw the threshold tick, 0–100. Defaults to {@link METER_WARN_PERCENT}; pass
   * `null` for a meter with no line to cross.
   */
  warnAt?: number | null;
  /** The 3 px rail instead of the 6 px bar, for use inside a table cell. */
  thin?: boolean;
}

/**
 * Render the meter. See {@link MeterProps}.
 *
 * @returns A labelled `role="meter"` wrapping the track and, by default, the printed share.
 */
export const Meter = React.forwardRef<HTMLDivElement, MeterProps>(function Meter(
  {
    label,
    value,
    max = 100,
    tone,
    showLabel,
    showValue = true,
    valueLabel,
    valueText,
    warnAt = METER_WARN_PERCENT,
    thin,
    className,
    ...props
  },
  ref,
) {
  const percent = meterPercent(value, max);
  const resolved = tone ?? meterTier(percent);
  const printed = valueLabel ?? `${percent}%`;
  const spoken = valueText ?? (max === 100 ? `${percent}%` : `${value} of ${max} (${percent}%)`);

  return (
    <div
      ref={ref}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={spoken}
      data-tone={resolved}
      className={cn('hive-meter', className)}
      {...props}
    >
      {showLabel ? (
        <span aria-hidden className="hive-meter__label">
          {label}
        </span>
      ) : null}
      <Progress
        decorative
        value={percent}
        tone={resolved}
        thin={thin}
        tick={warnAt ?? undefined}
        className="hive-meter__track"
      />
      {showValue ? (
        <span aria-hidden className={cn('hive-meter__value', METRIC_TONE_INK_CLASS[resolved])}>
          {printed}
        </span>
      ) : null}
    </div>
  );
});
