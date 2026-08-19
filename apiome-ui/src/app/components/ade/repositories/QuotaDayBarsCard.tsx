'use client';

/**
 * The daily polling distribution (HIVE-7.6, #5323).
 *
 * Authority: `docs/mockups/sources/repository-telemetry.html` — the *Polls by day* card, which
 * the mockup's **Notes → Adds** list introduces.
 *
 * ### Why a second view of a series the sparklines already draw
 *
 * A sparkline answers "is this rising?". It cannot answer "which days are heavy?", because it
 * has no baseline and no per-day separation — and that is the question that decides whether a
 * quota needs raising or a schedule needs moving. Fourteen bars over a baseline answer it at a
 * glance, and the weekend dip a workspace has every week is the shape that tells an operator
 * the series is behaving normally.
 *
 * ### Why the bars are also a sentence
 *
 * The whole card is `aria-hidden` to nobody: the axis under it prints the window's first day,
 * its last, and the total across it. A reader who cannot see fourteen rectangles still gets
 * the number they stand for, which is the same rule `home-pulse` follows.
 */

import * as React from 'react';
import { BarChart3 } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/app/components/ui/Card';
import { METRIC_TONE_MARK_CLASS } from '@/app/components/ui/metrics';
import { cn } from '@lib/utils';

import {
  QUOTA_BARS_DAYS,
  type QuotaTelemetryMetric,
  formatQuotaMetricValue,
  quotaDayBars,
  quotaDayBarsAxis,
} from './quotaTelemetryModel';

export interface QuotaDayBarsCardProps {
  /** The metric to distribute — `polls` on this screen. */
  metric: QuotaTelemetryMetric;
  /** How many trailing days to draw (default {@link QUOTA_BARS_DAYS}). */
  days?: number;
}

/**
 * Render the distribution. See {@link QuotaDayBarsCardProps}.
 *
 * @returns The card, or null when the metric carries no points to distribute — an axis with
 *   no bars under it would report a measurement that was never taken.
 */
export function QuotaDayBarsCard({ metric, days = QUOTA_BARS_DAYS }: QuotaDayBarsCardProps) {
  const bars = quotaDayBars(metric, days);
  if (bars.length === 0) return null;
  const axis = quotaDayBarsAxis(bars);

  return (
    <Card className="quota-bars-card" data-testid="quota-day-bars">
      <CardHeader className="quota-bars-card__head">
        <CardTitle className="quota-bars-card__title">
          <BarChart3 aria-hidden />
          {metric.label} by day
        </CardTitle>
        <span className="quota-bars-card__window">last {bars.length} days</span>
      </CardHeader>

      <CardContent>
        {/*
          The bars are decoration: every figure they stand for is printed in the axis below and
          in the `title` of each bar, so a screen reader is told the numbers rather than
          fourteen unlabelled shapes.
        */}
        <div className="quota-bars" aria-hidden>
          {bars.map((bar) => (
            <span
              key={bar.date}
              className={cn('quota-bars__bar', METRIC_TONE_MARK_CLASS[bar.tone])}
              style={{ height: `${Math.max(bar.percent, bar.value > 0 ? 4 : 2)}%` }}
              data-tone={bar.tone}
              data-count={bar.value}
              title={`${bar.date}: ${formatQuotaMetricValue(metric, bar.value)}`}
            />
          ))}
        </div>

        <p className="quota-bars__axis">
          <span>{axis.from}</span>
          <span className="quota-bars__total mono">{axis.total}</span>
          <span>{axis.to}</span>
        </p>
      </CardContent>
    </Card>
  );
}

export default QuotaDayBarsCard;
