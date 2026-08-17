'use client';

/**
 * Home's publishing pulse (HIVE-4.6, #5300).
 *
 * Authority: `docs/mockups/home/overview.html` §"Workspace pulse" (`.bars`, twelve bars, a
 * month axis under them).
 *
 * Twelve weeks of `versions.published_at`, scaled against the window's own busiest week — the
 * question a pulse answers is "is this week busier than the last twelve?", which a fixed
 * ceiling would flatten for a small team and clip for a large one.
 *
 * The bars are decorative twice over, which is why the panel is careful about its text:
 *
 * - The chart itself is one `role="img"` with a summary label, not twelve focusable bars. A
 *   sparkline of counts has no per-bar interaction, and twelve tab stops that do nothing is a
 *   keyboard trap made of decoration.
 * - Each bar still carries a `title`, so a mouse reader gets the week and its count on hover
 *   without the panel needing a tooltip layer.
 * - The heading line states the total in words. A reader who cannot see the bars at all still
 *   learns what they say.
 */

import * as React from 'react';

import { Card } from '@/app/components/ui/Card';
import { Skeleton } from '@/app/components/ui/Skeleton';
import type { PulseWeek } from '@lib/db/dashboard-home-model';
import { PANEL, PULSE_SPAN_LABEL, pulseBars, pulseMonthTicks, pulseTotal } from './homeModel';

/** Props for {@link PublishingPulse}. */
export interface PublishingPulseProps {
  /** The weekly buckets, oldest first. An empty list hides the panel. */
  weeks: readonly PulseWeek[];
  /** True until the first load resolves. */
  loading: boolean;
}

/**
 * Draw the panel.
 *
 * @param props See {@link PublishingPulseProps}.
 * @returns The card, its skeleton, or `null` when no window could be resolved.
 */
export function PublishingPulse({ weeks, loading }: PublishingPulseProps) {
  if (loading) {
    return (
      <Card className="home-pulse" aria-hidden>
        <div className="home-pulse__head">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-20" />
        </div>
        <Skeleton className="h-[4.5rem] w-full rounded-sm" />
      </Card>
    );
  }

  // No buckets at all means the query failed, not that nothing was published — an all-zero
  // pulse is a real answer and is drawn, an absent one is not.
  if (weeks.length === 0) return null;

  const bars = pulseBars(weeks);
  const total = pulseTotal(weeks);
  const ticks = pulseMonthTicks(weeks);
  const summary = `${total} version${total === 1 ? '' : 's'} published in the ${PULSE_SPAN_LABEL}`;

  return (
    <Card className="home-pulse" role="group" aria-labelledby="home-pulse-title">
      <div className="home-pulse__head">
        <h2 id="home-pulse-title">{PANEL.pulse.title}</h2>
        <span className="home-pulse__span">{PULSE_SPAN_LABEL}</span>
      </div>
      <div className="home-bars" role="img" aria-label={summary}>
        {bars.map((bar) => (
          <span
            key={bar.weekStart}
            className="home-bars__bar"
            style={{ height: `${bar.percent}%` }}
            data-count={bar.count}
            title={bar.label}
          />
        ))}
      </div>
      <div className="home-pulse__axis" aria-hidden>
        {ticks.map((tick) => (
          <span key={tick}>{tick}</span>
        ))}
      </div>
      <p className="home-pulse__total">{summary}</p>
    </Card>
  );
}

export default PublishingPulse;
