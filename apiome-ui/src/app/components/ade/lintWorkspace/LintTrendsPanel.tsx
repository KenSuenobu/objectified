'use client';

import * as React from 'react';
import { Scale, Wrench } from 'lucide-react';

import { Badge } from '@/app/components/ui/Badge';
import { Card, CardBody, CardHeader, CardTitle } from '@/app/components/ui/Card';
import { EmptyState } from '@/app/components/ui/EmptyState';
import { Sparkline } from '@/app/components/ui/metrics';
import { STATUS_TONE_TEXT_CLASS } from '@/app/components/ui/statusVocabulary';
import type { LintWorkspaceTrends } from '@/app/utils/lint-workspace';
import { cn } from '@lib/utils';

import { TREND_SERIES, trendSeriesData, type TrendSeriesSpec } from './lintWorkspaceModel';

/**
 * The Trends tab — HIVE-5.8 (#5311).
 *
 * Authority: `docs/mockups/govern/lint-posture.html`, the two cards of the Trends panel and
 * both of their explanatory notes.
 *
 * ### The split is the point
 *
 * Remediation and policy activity are never summed into one line. A tenant whose findings
 * count halved because five waivers were granted has not improved its posture, and a single
 * "open findings" trend cannot tell the two apart. The left card counts what was *found* and
 * what was genuinely *fixed*; the right card counts every way a finding can leave the queue
 * without being fixed. Both notes are the mockup's, kept word for word, because the reason
 * for the split has to be on the screen that shows it.
 *
 * ### What changed
 *
 * The six charts were `ui/mcp/charts/TrendLine`, whose palette is the pre-Hive Tailwind ramp
 * (`stroke-indigo-500 dark:stroke-indigo-400`) — one hue in light mode, one in dark, and the
 * same two in all nine themes. They are the Hive {@link Sparkline} now, whose tone is a
 * token, so a trend follows the theme like everything else on the page.
 */

/** Props for {@link LintTrendsPanel}. */
export interface LintTrendsPanelProps {
  /** The daily series, or `null` when the read failed or has not returned. */
  trends: LintWorkspaceTrends | null;
}

/**
 * One series: its name, its total over the window, and its shape.
 *
 * @param props.spec Which series.
 * @param props.trends The payload.
 * @returns The row.
 */
function Series({ spec, trends }: { spec: TrendSeriesSpec; trends: LintWorkspaceTrends }) {
  const { values, total, days } = trendSeriesData(trends, spec);
  return (
    <div className="lw-series" data-testid={`trend-${spec.key}`}>
      <div className="lw-series__head">
        <span className="lw-series__label">{spec.label}</span>
        <span className="lw-series__total">
          <strong className={STATUS_TONE_TEXT_CLASS[spec.tone]}>{total}</strong> in {days}d
        </span>
      </div>
      <Sparkline
        data={values}
        tone={spec.tone}
        className="lw-series__chart"
        label={`${spec.label} per day over the last ${days} days`}
      />
    </div>
  );
}

/**
 * The Trends tab body.
 *
 * @param props See {@link LintTrendsPanelProps}.
 * @returns The two cards, or the tab-level empty state.
 */
export default function LintTrendsPanel({ trends }: LintTrendsPanelProps) {
  if (!trends || trends.series.length === 0) {
    return (
      <EmptyState
        icon={<Wrench aria-hidden />}
        title="No trend data yet"
        description="Trends appear once lint evidence accumulates across scans."
        data-testid="lint-workspace-trends-empty"
      />
    );
  }

  const remediation = TREND_SERIES.filter((spec) => spec.group === 'remediation');
  const policy = TREND_SERIES.filter((spec) => spec.group === 'policy');

  return (
    <div className="lw-trends" data-testid="lint-workspace-trends">
      <Card>
        <CardHeader className="lw-card-head">
          <CardTitle className="lw-card-title">
            <Wrench aria-hidden />
            Remediation
            <span className="lw-card-title__window">last {trends.days} days</span>
          </CardTitle>
          <Badge variant="outline">daily</Badge>
        </CardHeader>
        <CardBody className="lw-card-body">
          {remediation.map((spec) => (
            <Series key={spec.key} spec={spec} trends={trends} />
          ))}
          <p className="lw-note">
            “Remediated” counts findings that disappeared from evidence without being waived
            or marked false positive — genuine fixes only.
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader className="lw-card-head">
          <CardTitle className="lw-card-title">
            <Scale aria-hidden />
            Policy &amp; waivers
            <span className="lw-card-title__window">last {trends.days} days</span>
          </CardTitle>
          <Badge variant="outline">daily</Badge>
        </CardHeader>
        <CardBody className={cn('lw-card-body')}>
          {policy.map((spec) => (
            <Series key={spec.key} spec={spec} trends={trends} />
          ))}
          <p className="lw-note">
            Policy and waiver activity is kept separate from remediation so posture changes
            are attributable to fixes, not rule changes.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
