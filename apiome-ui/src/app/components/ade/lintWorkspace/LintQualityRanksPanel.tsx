'use client';

import * as React from 'react';
import { ArrowDownRight, ArrowRight, ArrowUpRight, Medal } from 'lucide-react';

import { Alert } from '@/app/components/ui/Alert';
import { Badge } from '@/app/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/app/components/ui/Card';
import { EmptyState } from '@/app/components/ui/EmptyState';
import { Segmented, SegmentedItem } from '@/app/components/ui/Segmented';
import { FormatPill } from '@/app/components/ui/catalog/FormatPill';
import { Sparkline } from '@/app/components/ui/metrics';
import type { QualityRankFormat, QualityRankSeries } from '@/app/utils/lint-workspace';
import { cn } from '@lib/utils';

import {
  NO_VALUE,
  QUALITY_RANK_WINDOWS,
  attributionSpec,
  gradeBars,
  driftSpec,
  rankStats,
  rankWindowSummary,
  scopeLabel,
} from './lintWorkspaceModel';

/**
 * The Quality ranks tab — HIVE-5.8 (#5311), the surface IXH-2.7 built.
 *
 * Authority: `docs/mockups/govern/lint-posture.html`, the Quality ranks panel: the window
 * switch, the truncation notice, the per-(scope, format) cards and their four regions.
 *
 * ### What each card answers, and why it is split this way
 *
 * * **per format** — "our AsyncAPI imports grade a letter worse than our OpenAPI ones" is
 *   visible instead of being averaged away;
 * * **adapter versus specification** — every card states how many of its findings apiome's
 *   own intake is answerable for, beside the constructs the adapter *declares* it cannot
 *   read yet, so an adapter gap is never mistaken for a bad specification;
 * * **export readiness in the same series** — an export group additionally trends its
 *   readiness composite and reports the best rank the target reached.
 *
 * ### Gaps stay gaps
 *
 * A day nobody imported a format has no average, and the score trend breaks across it rather
 * than dropping to zero. That property is why {@link Sparkline} learned to take a `null` in
 * this ticket, instead of this panel keeping the pre-Hive `TrendLine` and its Tailwind-ramp
 * palette.
 */

/** Props for {@link LintQualityRanksPanel}. */
export interface LintQualityRanksPanelProps {
  /** The rank series, or `null` when the read failed or has not returned. */
  series: QualityRankSeries | null;
  /** The selected window, in days. */
  days: number;
  /** Choose a window. */
  onDaysChange: (days: number) => void;
}

/** The glyph each drift direction leads with. */
const DRIFT_ICON = {
  up: ArrowUpRight,
  down: ArrowDownRight,
  flat: ArrowRight,
  none: ArrowRight,
} as const;

/**
 * One (scope, format) group.
 *
 * @param props.entry The group.
 * @param props.days The window, for the chart labels.
 * @returns The card.
 */
function RankCard({ entry, days }: { entry: QualityRankFormat; days: number }) {
  const isExport = entry.scope === 'export';
  const drift = driftSpec(entry.scoreDelta);
  const DriftIcon = DRIFT_ICON[drift.direction];
  const bars = gradeBars(entry.gradeDistribution);
  const attribution = attributionSpec(entry);
  const scores = entry.points.map((point) => point.averageScore);
  const readiness = entry.points.map((point) => point.averageReadiness);

  return (
    <Card
      className="lw-rank"
      data-testid={`quality-rank-${entry.scope}-${entry.formatKey}`}
      data-scope={entry.scope}
    >
      <CardHeader className="lw-card-head">
        <span className="lw-inline">
          <Badge variant={isExport ? 'violet' : 'accent'}>{scopeLabel(entry.scope)}</Badge>
          <FormatPill format={entry.formatKey} />
        </span>
        {entry.latestGrade ? (
          <Badge size="lg" variant="outline" data-testid="rank-latest-grade">
            Latest {entry.latestGrade}
          </Badge>
        ) : null}
      </CardHeader>

      <CardBody className="lw-card-body">
        <div className="lw-rank__meta">
          <span className="lw-quiet">
            {entry.observations} grade{entry.observations === 1 ? '' : 's'} ·{' '}
            {entry.adapterKeys.length > 0 ? entry.adapterKeys.join(', ') : 'adapter unknown'}
          </span>
          <Badge variant={drift.tone} data-testid="rank-drift">
            <DriftIcon aria-hidden />
            {drift.label}
          </Badge>
        </div>

        <div className="lw-rank__stats">
          {rankStats(entry).map((stat) => (
            <div key={stat.slot} className="lw-mini-stat" data-testid={`stat-${stat.slot}`}>
              <span className="lw-mini-stat__label">{stat.label}</span>
              <span className="lw-mini-stat__value">{stat.value ?? NO_VALUE}</span>
            </div>
          ))}
        </div>

        <div className="lw-rank__charts">
          <div data-testid={`grade-distribution-${entry.formatKey}`}>
            <span className="lw-mini-stat__label">Grade distribution</span>
            <div
              className="lw-bars"
              role="img"
              aria-label={bars
                .map((bar) => `${bar.label === NO_VALUE ? 'ungraded' : bar.label}: ${bar.count}`)
                .join(', ')}
            >
              {bars.map((bar) => (
                <span key={bar.key} className="lw-bars__col" title={`${bar.label}: ${bar.count}`}>
                  <span
                    className={cn('lw-bars__fill', bar.band.solidClass)}
                    style={{ blockSize: `${bar.percent}%` }}
                  />
                </span>
              ))}
            </div>
            <div className="lw-bars__axis" aria-hidden>
              {bars.map((bar) => (
                <span key={bar.key}>{bar.label}</span>
              ))}
            </div>
          </div>

          <div data-testid={`score-trend-${entry.formatKey}`}>
            <span className="lw-mini-stat__label">
              {isExport ? 'Score & readiness trend' : 'Score trend'}
            </span>
            <Sparkline
              data={scores}
              tone="ok"
              domainMax={100}
              className="lw-rank__spark"
              label={`Average score per day for ${entry.formatKey} over the last ${days} days`}
            />
            {isExport ? (
              <Sparkline
                data={readiness}
                tone="accent"
                domainMax={100}
                area={false}
                className="lw-rank__spark"
                label={`Average export readiness per day for ${entry.formatKey}`}
              />
            ) : null}
          </div>
        </div>

        <div data-testid={`attribution-${entry.scope}-${entry.formatKey}`}>
          <div className="lw-rank__attribution-head">
            <span className="lw-mini-stat__label">Finding attribution</span>
            <span className="lw-quiet">{attribution.summary}</span>
          </div>
          <div className="lw-split" role="presentation">
            <span
              className="lw-split__adapter"
              style={{ inlineSize: `${attribution.adapterPercent ?? 0}%` }}
            />
            <span
              className="lw-split__spec"
              style={{ inlineSize: `${attribution.specPercent ?? 0}%` }}
            />
          </div>
          <p className="lw-quiet">{attribution.detail}</p>
        </div>

        {entry.styleGuideVersions.length > 1 && (
          <Alert variant="warn" data-testid="rank-guide-drift-note">
            <span>
              {entry.styleGuideVersions.length} style-guide versions produced these grades. A
              change of scoring rules moves grades on its own — compare drift within one
              version before reading it as a quality change.
            </span>
          </Alert>
        )}
      </CardBody>
    </Card>
  );
}

/**
 * The Quality ranks tab body.
 *
 * @param props See {@link LintQualityRanksPanelProps}.
 * @returns The header, the cards and the states.
 */
export default function LintQualityRanksPanel({
  series,
  days,
  onDaysChange,
}: LintQualityRanksPanelProps) {
  const windowSwitch = (
    <Segmented
      size="sm"
      value={String(days)}
      aria-label="Grade window"
      data-testid="quality-rank-window"
      onValueChange={(next) => onDaysChange(Number(next))}
    >
      {QUALITY_RANK_WINDOWS.map((window) => (
        <SegmentedItem key={window} value={String(window)}>
          {window}d
        </SegmentedItem>
      ))}
    </Segmented>
  );

  if (!series) {
    return (
      <EmptyState
        icon={<Medal aria-hidden />}
        title="No quality-rank data yet"
        description="Grades appear here once imports and exports are pre-flighted or committed."
        data-testid="lint-workspace-quality-ranks-empty"
      />
    );
  }

  return (
    <div className="lw-ranks" data-testid="lint-workspace-quality-ranks">
      <div className="lw-ranks__head">
        <div>
          <h2 className="lw-ranks__title">Quality ranks &amp; grade drift</h2>
          <p className="lw-quiet" data-testid="quality-rank-window-summary">
            {rankWindowSummary(series)}
          </p>
        </div>
        {windowSwitch}
      </div>

      {series.truncated && (
        <Alert variant="info" data-testid="quality-rank-truncated">
          <span>
            More formats were graded than this view shows — the busiest {series.formatLimit}{' '}
            are listed. Narrow the window or the project scope to see the rest.
          </span>
        </Alert>
      )}

      {series.formats.length === 0 ? (
        <EmptyState
          variant="compact"
          icon={<Medal aria-hidden />}
          title="No grades were recorded in this window."
          description="Import a specification or run an export pre-flight and its grade appears here."
          data-testid="quality-rank-window-empty"
        />
      ) : (
        <div className="lw-ranks__grid">
          {series.formats.map((entry) => (
            <RankCard key={`${entry.scope}:${entry.formatKey}`} entry={entry} days={days} />
          ))}
        </div>
      )}
    </div>
  );
}
