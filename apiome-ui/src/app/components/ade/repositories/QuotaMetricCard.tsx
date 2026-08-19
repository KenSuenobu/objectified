'use client';

/**
 * One quota metric card (HIVE-7.6, #5323).
 *
 * Authority: `docs/mockups/sources/repository-telemetry.html` — the `metric-card` grid: a
 * name, the live bucket's figure, a sparkline, and the range's total and busiest day.
 *
 * ### Why deferral metrics look different
 *
 * `polls` and `polls_deferred` are the same shape of number and mean opposite things. A
 * deferral card therefore takes an amber frame, an amber sparkline *and* a glyph beside its
 * name — three signals, because the frame alone is colour-only and the sparkline alone is a
 * shape. `metric.deferral` comes from the server, so this component never has to know which
 * of the five counters is which.
 */

import * as React from 'react';
import { TriangleAlert } from 'lucide-react';

import { Card, CardContent } from '@/app/components/ui/Card';
import { Sparkline } from '@/app/components/ui/metrics';

import {
  type QuotaTelemetryMetric,
  formatQuotaMetricValue,
  quotaMetricSeries,
  quotaMetricTone,
  quotaWindowLabel,
} from './quotaTelemetryModel';

export interface QuotaMetricCardProps {
  /** The metric to render. */
  metric: QuotaTelemetryMetric;
}

/**
 * Render one metric. See {@link QuotaMetricCardProps}.
 *
 * @returns The card.
 */
export function QuotaMetricCard({ metric }: QuotaMetricCardProps) {
  const series = quotaMetricSeries(metric);

  return (
    <Card
      className="quota-metric"
      aria-label={metric.label}
      data-testid="quota-metric-card"
      data-metric={metric.metric}
      data-deferral={metric.deferral ? 'true' : 'false'}
    >
      <CardContent className="quota-metric__body">
        <div className="quota-metric__head">
          <h3 className="quota-metric__label">
            {metric.deferral ? <TriangleAlert className="quota-metric__flag" aria-hidden /> : null}
            {metric.label}
          </h3>
          <span className="quota-metric__window">{quotaWindowLabel(metric)}</span>
        </div>

        <p className="quota-metric__value mono">
          {formatQuotaMetricValue(metric, metric.currentWindow)}
        </p>

        <Sparkline
          className="quota-metric__spark"
          data={series}
          tone={quotaMetricTone(metric)}
          label={`${metric.label} — last ${metric.points.length} days`}
        />

        <dl className="quota-metric__foot">
          <div>
            <dt>Range total</dt>
            <dd className="mono">{formatQuotaMetricValue(metric, metric.total)}</dd>
          </div>
          <div>
            <dt>Busiest day</dt>
            <dd className="mono">{formatQuotaMetricValue(metric, metric.peak)}</dd>
          </div>
        </dl>

        <p className="quota-metric__desc">{metric.description}</p>
      </CardContent>
    </Card>
  );
}

export default QuotaMetricCard;
