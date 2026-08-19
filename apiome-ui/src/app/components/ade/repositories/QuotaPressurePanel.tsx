'use client';

/**
 * The polling-quota panel (HIVE-7.6, #5323).
 *
 * Authority: `docs/mockups/sources/repository-telemetry.html` — the *Polling quota* card: a
 * pressure badge beside the heading, one sentence, four figures, and a `role="meter"` bar
 * printing the share of the hour's budget that is already spent.
 *
 * ### Why the badge carries a word
 *
 * The panel used to say what the pressure was with its border colour alone: grey, green,
 * amber, red. DESIGN.md §6 does not allow colour to be the only signal, and the level is also
 * the single most useful thing on the screen — so it is a badge with the level written in it,
 * and the frame merely agrees.
 *
 * ### Why the meter is `ui/metrics`
 *
 * `quotaPressure` classifies against 80 % and 100 %, which are exactly `Meter`'s own bands.
 * Deriving the tone twice is how two marks describing one number end up disagreeing, so the
 * meter is handed the percentage and picks the same tone this panel's badge does.
 *
 * ### Why the share is printed here rather than by the meter
 *
 * `Meter` inks its own figure with the tone's `-fg`, and at `--fs-xs` on the plain card that
 * pair measures 1.58:1 in Nord and fails in four other themes — the primitive-level exposure
 * HIVE-7.2 recorded and HIVE-7.3 worked around the same way. So the meter draws the bar, which
 * still carries the tone, and the sentence beside it is `--fg-muted`, which clears AA on the
 * card in all nine appearances. It also puts the sentence where the mockup draws it: on its own
 * line under the bar rather than inline at its end.
 */

import * as React from 'react';
import { Gauge } from 'lucide-react';

import { Badge } from '@/app/components/ui/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/app/components/ui/Card';
import { Meter } from '@/app/components/ui/metrics';

import {
  QUOTA_PANEL_TITLE,
  QUOTA_PRESSURE_LABEL,
  QUOTA_PRESSURE_STATUS,
  type RepositoryPollingQuota,
  quotaPressure,
  quotaPressureCopy,
  quotaUsagePercent,
} from './quotaTelemetryModel';

/**
 * One labelled figure.
 *
 * @param label What the figure counts.
 * @param value The figure, already formatted.
 * @returns The `dt`/`dd` pair.
 */
function QuotaFigure({ label, value }: { label: string; value: string }) {
  return (
    <div className="quota-figure">
      <dt className="quota-figure__label">{label}</dt>
      <dd className="quota-figure__value mono">{value}</dd>
    </div>
  );
}

export interface QuotaPressurePanelProps {
  /** The workspace's quota projection. */
  quota: RepositoryPollingQuota;
}

/**
 * Render the panel. See {@link QuotaPressurePanelProps}.
 *
 * @returns The polling-quota card.
 */
export function QuotaPressurePanel({ quota }: QuotaPressurePanelProps) {
  const pressure = quotaPressure(quota);
  const percent = quotaUsagePercent(quota);

  return (
    <Card
      className="quota-panel"
      aria-label={QUOTA_PANEL_TITLE}
      data-testid="quota-summary"
      data-pressure={pressure}
    >
      <CardHeader className="quota-panel__head">
        <CardTitle className="quota-panel__title">
          <Gauge aria-hidden />
          {QUOTA_PANEL_TITLE}
        </CardTitle>
        <Badge
          status={QUOTA_PRESSURE_STATUS[pressure]}
          data-testid="quota-pressure-badge"
          data-pressure={pressure}
        >
          {QUOTA_PRESSURE_LABEL[pressure]}
        </Badge>
      </CardHeader>

      <CardContent>
        <p className="quota-panel__copy">{quotaPressureCopy(quota)}</p>

        <dl className="quota-figures">
          <QuotaFigure label="Used this hour" value={quota.usedThisWindow.toLocaleString()} />
          <QuotaFigure
            label="Ceiling"
            value={
              quota.effectivePollsPerHour === null
                ? 'Unlimited'
                : quota.effectivePollsPerHour.toLocaleString()
            }
          />
          <QuotaFigure
            label="Remaining"
            value={
              quota.remainingThisWindow === null ? '—' : quota.remainingThisWindow.toLocaleString()
            }
          />
          <QuotaFigure label="Window" value={`${Math.round(quota.windowSeconds / 60)} min`} />
        </dl>

        {percent === null ? null : (
          <div className="quota-panel__meter">
            <Meter
              label="Polling budget used this hour"
              value={percent}
              showValue={false}
              valueText={`${percent}% of this hour’s budget`}
            />
            {/*
              A visual restatement of the meter's own `aria-valuetext`, so it is hidden from
              assistive technology — a meter and a paragraph announcing the same number is a
              bug, which is the rule `Meter` already follows with the bar inside it.
            */}
            <p className="quota-panel__share" aria-hidden>
              {percent}% of this hour’s budget
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default QuotaPressurePanel;
