'use client';

/**
 * Quality-rank telemetry & grade drift panel (IXH-2.7, #5102).
 *
 * Renders the per-format grade series the workspace's quality-rank endpoint returns, split the
 * way the ticket asks for:
 *
 * * **per format** — one card per (scope, format) group, so "our gRPC imports grade a letter
 *   worse than our OpenAPI ones" is visible instead of being averaged away;
 * * **adapter versus spec attribution** — every card states how many of its findings apiome's
 *   own intake is answerable for, next to the constructs the adapter *declares* it cannot read
 *   yet, so an adapter gap is never mistaken for a bad specification;
 * * **export readiness ranks in the same series** — an export group additionally trends its
 *   readiness composite and reports the best rank the target reached.
 *
 * Averages are gapped, never zeroed: a day with no import of a format plots as a break in the
 * line, because "nobody imported this" and "everything scored zero" are different facts.
 */

import React from 'react';
import { AlertTriangle, ArrowDownRight, ArrowRight, ArrowUpRight } from 'lucide-react';
import { BarSeries, TrendLine } from '@/app/components/ui/mcp/charts';
import { gradeChipClass } from '@/app/utils/version-lint-report';
import {
  adapterAttributionShare,
  type QualityRankFormat,
  type QualityRankSeries,
} from '@/app/utils/lint-workspace';
import { dashboardPanelPaddedClass } from '../../dashboardScreenClasses';
import { cn } from '@lib/utils';

/** Window sizes the panel offers, in days. Bounded by the server's 180-day maximum. */
export const QUALITY_RANK_WINDOWS = [7, 30, 90, 180] as const;

/** Letter grades plus the explicit "not gradable" bucket, in distribution order. */
const GRADE_BUCKETS = ['A', 'B', 'C', 'D', 'F', 'ungraded'] as const;

/** Chart tone per grade bucket — better grades cooler, worse grades warmer. */
const GRADE_TONES = {
  A: 'emerald',
  B: 'green',
  C: 'amber',
  D: 'orange',
  F: 'red',
  ungraded: 'neutral',
} as const;

const sectionHeadingClass =
  'text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400';
const cardTitleClass = 'text-sm font-semibold text-gray-900 dark:text-gray-100';
const metaTextClass = 'text-xs text-gray-500 dark:text-gray-400';
const statLabelClass = 'text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400';
const statValueClass = 'text-lg font-semibold text-gray-900 dark:text-gray-100';
const chipClass = 'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium';
const scopeChipClass =
  'inline-flex items-center rounded-md bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300';
const windowButtonClass =
  'rounded-md border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800';
const windowButtonActiveClass =
  'border-indigo-500 bg-indigo-50 text-indigo-700 dark:border-indigo-400 dark:bg-indigo-950/60 dark:text-indigo-300';
const attributionTrackClass =
  'flex h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700';
const adapterBarClass = 'bg-violet-500 dark:bg-violet-400';
const specBarClass = 'bg-sky-500 dark:bg-sky-400';
const noticeClass =
  'flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200';

/** Human label for a scope discriminator. */
function scopeLabel(scope: string): string {
  if (scope === 'import') return 'Import';
  if (scope === 'export') return 'Export';
  return scope || 'Unknown';
}

/** The drift indicator: direction, tone and reading for a window's score delta. */
function DriftBadge({ delta }: { delta: number | null }) {
  if (delta === null) {
    return <span className={metaTextClass}>No drift (one scored run or fewer)</span>;
  }
  const Icon = delta > 0 ? ArrowUpRight : delta < 0 ? ArrowDownRight : ArrowRight;
  const tone =
    delta > 0
      ? 'text-emerald-600 dark:text-emerald-400'
      : delta < 0
        ? 'text-rose-600 dark:text-rose-400'
        : 'text-gray-500 dark:text-gray-400';
  return (
    <span className={cn('inline-flex items-center gap-1 text-sm font-medium', tone)}>
      <Icon className="h-4 w-4 shrink-0" aria-hidden />
      {delta > 0 ? `+${delta}` : delta} pts over the window
    </span>
  );
}

/** The adapter-versus-spec attribution split for one format group. */
function AttributionSplit({ entry }: { entry: QualityRankFormat }) {
  const share = adapterAttributionShare(entry);
  const total = entry.adapterFindingCount + entry.specFindingCount;
  return (
    <div data-testid={`attribution-${entry.scope}-${entry.formatKey}`} className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className={statLabelClass}>Finding attribution</span>
        <span className={metaTextClass}>
          {share === null
            ? 'No findings recorded'
            : `${share}% adapter · ${100 - share}% specification`}
        </span>
      </div>
      <div className={attributionTrackClass} role="presentation">
        <div
          className={adapterBarClass}
          style={{ width: `${total > 0 ? ((entry.adapterFindingCount / total) * 100).toFixed(2) : 0}%` }}
        />
        <div
          className={specBarClass}
          style={{ width: `${total > 0 ? ((entry.specFindingCount / total) * 100).toFixed(2) : 0}%` }}
        />
      </div>
      <p className={metaTextClass}>
        {entry.adapterFindingCount} adapter-attributable ·{' '}
        {entry.specFindingCount} specification-attributable
        {entry.declaredParserLimits > 0
          ? ` · ${entry.declaredParserLimits} construct${
              entry.declaredParserLimits === 1 ? '' : 's'
            } this adapter declares it cannot read yet`
          : ''}
      </p>
    </div>
  );
}

/** One labelled headline number; a null value renders an em dash, never a misleading zero. */
function Stat({
  testId,
  label,
  value,
}: {
  testId: string;
  label: string;
  value: number | null;
}) {
  return (
    <div data-testid={testId}>
      <span className={statLabelClass}>{label}</span>
      <p className={statValueClass}>{value ?? '—'}</p>
    </div>
  );
}

/** One (scope, format) group: distribution, drift, attribution and — for exports — readiness. */
function FormatCard({ entry, days }: { entry: QualityRankFormat; days: number }) {
  const bars = GRADE_BUCKETS.map((bucket) => ({
    label: bucket,
    value: entry.gradeDistribution[bucket] ?? 0,
    tone: GRADE_TONES[bucket],
  }));
  const scores = entry.points.map((point) => point.averageScore);
  const readiness = entry.points.map((point) => point.averageReadiness);
  const isExport = entry.scope === 'export';

  return (
    <section
      className={cn(dashboardPanelPaddedClass, 'space-y-4')}
      data-testid={`quality-rank-${entry.scope}-${entry.formatKey}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={scopeChipClass}>{scopeLabel(entry.scope)}</span>
            <h3 className={cardTitleClass}>{entry.formatKey}</h3>
            {entry.latestGrade && (
              <span className={cn(chipClass, gradeChipClass(entry.latestGrade))}>
                Latest {entry.latestGrade}
              </span>
            )}
          </div>
          <p className={cn(metaTextClass, 'mt-1')}>
            {entry.observations} grade{entry.observations === 1 ? '' : 's'} ·{' '}
            {entry.adapterKeys.length > 0 ? entry.adapterKeys.join(', ') : 'adapter unknown'}
          </p>
        </div>
        <DriftBadge delta={entry.scoreDelta} />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat testId="stat-average-score" label="Average score" value={entry.averageScore} />
        <Stat
          testId="stat-secondary"
          label={isExport ? 'Average readiness' : 'Blocked'}
          value={isExport ? entry.averageReadiness : entry.blockedCount}
        />
        <Stat
          testId="stat-tertiary"
          label={isExport ? 'Best rank' : 'Warned'}
          value={isExport ? entry.bestRank : (entry.outcomes.warn ?? 0)}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div data-testid={`grade-distribution-${entry.formatKey}`}>
          <span className={statLabelClass}>Grade distribution</span>
          <BarSeries
            data={bars}
            className="h-20 w-full"
            title={`Grade distribution for ${entry.formatKey} over the last ${days} days`}
          />
        </div>
        <div data-testid={`score-trend-${entry.formatKey}`}>
          <span className={statLabelClass}>
            {isExport ? 'Score & readiness trend' : 'Score trend'}
          </span>
          <TrendLine
            data={scores}
            tone="indigo"
            domainMax={100}
            className="h-20 w-full"
            title={`Average score per day for ${entry.formatKey} over the last ${days} days`}
            pointLabel={(index, value) =>
              `${entry.points[index]?.date}: ${value === null ? 'no grades' : value}`
            }
          />
          {isExport && (
            <TrendLine
              data={readiness}
              tone="cyan"
              domainMax={100}
              className="h-16 w-full"
              title={`Average export readiness per day for ${entry.formatKey}`}
              pointLabel={(index, value) =>
                `${entry.points[index]?.date}: ${value === null ? 'no ranking' : value}`
              }
            />
          )}
        </div>
      </div>

      <AttributionSplit entry={entry} />

      {entry.styleGuideVersions.length > 1 && (
        <p className={noticeClass}>
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            {entry.styleGuideVersions.length} style-guide versions produced these grades. A change
            of scoring rules moves grades on its own — compare drift within one version before
            reading it as a quality change.
          </span>
        </p>
      )}
    </section>
  );
}

export interface LintWorkspaceQualityRanksPanelProps {
  /** The series to render. */
  series: QualityRankSeries;
  /** The currently selected window, in days. */
  days: number;
  /** Called with the newly selected window size. */
  onDaysChange: (days: number) => void;
}

/** The Quality ranks tab body. */
export default function LintWorkspaceQualityRanksPanel({
  series,
  days,
  onDaysChange,
}: LintWorkspaceQualityRanksPanelProps) {
  return (
    <div data-testid="lint-workspace-quality-ranks" className="space-y-4">
      <section className={cn(dashboardPanelPaddedClass, 'space-y-3')}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className={sectionHeadingClass}>Quality ranks & grade drift</h2>
            <p className={cn(metaTextClass, 'mt-1')}>
              {series.observationCount} grade{series.observationCount === 1 ? '' : 's'} recorded
              between {series.windowStart} and {series.windowEnd} ·{' '}
              {series.stages.preflight ?? 0} pre-flight · {series.stages.committed ?? 0} committed
            </p>
          </div>
          <div className="flex items-center gap-1" role="group" aria-label="Trend window">
            {QUALITY_RANK_WINDOWS.map((window) => (
              <button
                key={window}
                type="button"
                aria-pressed={window === days}
                className={cn(windowButtonClass, window === days && windowButtonActiveClass)}
                onClick={() => onDaysChange(window)}
              >
                {window}d
              </button>
            ))}
          </div>
        </div>
        {series.truncated && (
          <p className={noticeClass}>
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>
              More formats were graded than this view shows — the busiest {series.formatLimit} are
              listed. Narrow the window or the project scope to see the rest.
            </span>
          </p>
        )}
      </section>

      {series.formats.length === 0 ? (
        <section className={cn(dashboardPanelPaddedClass, 'text-sm text-gray-600 dark:text-gray-400')}>
          No grades were recorded in this window. Import a specification or run an export
          pre-flight and its grade appears here.
        </section>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {series.formats.map((entry) => (
            <FormatCard key={`${entry.scope}:${entry.formatKey}`} entry={entry} days={days} />
          ))}
        </div>
      )}
    </div>
  );
}
