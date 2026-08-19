'use client';

/**
 * Grade & surface-size trend (V2-MCP-30.4 / MCAT-16.4).
 *
 * "Is this server getting better or worse over time?" The version history is a list; it cannot show a
 * trajectory. This panel plots two trends across the endpoint's discovery snapshots (oldest→newest,
 * one x-slot per snapshot):
 *
 * - **Quality score** (0–100 / A–F) — an unscored snapshot is **gapped, not zeroed**, so a missing
 *   score never reads as a crash to zero; and
 * - **Surface size** — the capability count per snapshot.
 *
 * The snapshots that introduced a **breaking change** (MCAT-16.3's `severity_counts.breaking > 0`) are
 * overlaid as vertical markers aligned to the version that broke, and listed as clickable chips that
 * **deep-link to that version's diff** via `onSelectVersion`.
 *
 * All series-shaping, the marker indices, and the headline deltas come from the pure, unit-tested
 * {@link mcpGradeSurfaceTrend} projection over the same parsed series, so the charts, markers, and
 * summary can never disagree. The component owns its loading / error / empty states.
 */

import * as React from 'react';
import {
  Minus,
  MousePointerClick,
  TrendingDown,
  TrendingUp,
  LineChart,
  ShieldAlert,
} from 'lucide-react';
import { EmptyState } from '@/app/components/ui/EmptyState';
import { LoadingState } from '@/app/components/ui/LoadingState';
import { STATUS_TONE_SOFT_CLASS } from '@/app/components/ui/statusVocabulary';
import { GradeGlyph } from '@/app/components/ui/mcp/GradeGlyph';
import { TrendLine, chartSeriesStyle } from '@/app/components/ui/mcp/charts';
import {
  mcpGradeSurfaceTrend,
  mcpTrendScoreLabel,
  mcpTrendSurfaceLabel,
  type McpEvolutionPoint,
  type McpTrendColumn,
} from '@/app/components/ade/dashboard/mcp/mcpEvolutionUi';

interface Props {
  /** The endpoint's evolution series (oldest-first), or `null` while it has not loaded. */
  series: readonly McpEvolutionPoint[] | null;
  loading: boolean;
  error: string | null;
  /** Called with a snapshot's `version_id` when a breaking-change marker chip is activated. */
  onSelectVersion: (versionId: string) => void;
}

/** A signed delta rendered with a direction icon and up/down/flat tone. */
function DeltaBadge({ delta, unit }: { delta: number | null; unit: string }) {
  if (delta === null) return null;
  const Icon = delta > 0 ? TrendingUp : delta < 0 ? TrendingDown : Minus;
  // A chip on the tone's own soft ground, not coloured text: see `.mcp-tone-figure`.
  const tone =
    delta > 0
      ? STATUS_TONE_SOFT_CLASS.ok
      : delta < 0
        ? STATUS_TONE_SOFT_CLASS.danger
        : STATUS_TONE_SOFT_CLASS.neutral;
  const sign = delta > 0 ? '+' : '';
  return (
    <span className={`mcp-tone-figure text-xs ${tone}`}>
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {sign}
      {delta} {unit}
    </span>
  );
}

/** One titled trend chart with its own heading row. */
function TrendBlock({
  title,
  children,
  delta,
}: {
  title: string;
  children: React.ReactNode;
  delta?: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wider text-fg-muted">
          {title}
        </span>
        {delta}
      </div>
      {children}
    </div>
  );
}

/**
 * The grade/surface-size trend panel. See the module doc for the acceptance criteria it satisfies
 * (the score/count trends match the seeded scores, an unscored snapshot is gapped rather than zeroed,
 * and breaking-change markers align to the right versions).
 */
export function GradeSurfaceTrendPanel({ series, loading, error, onSelectVersion }: Props) {
  if (loading && !series) {
    return <LoadingState minHeightClassName="min-h-[200px]" message="Loading trend…" />;
  }
  if (error) {
    return (
      <EmptyState
        variant="compact"
        icon={<LineChart className="h-8 w-8 text-fg-on-accent" aria-hidden />}
        title="Trend unavailable"
        description={error}
      />
    );
  }
  if (!series) return null;
  if (series.length === 0) {
    return (
      <EmptyState
        variant="compact"
        icon={<LineChart className="h-8 w-8 text-fg-on-accent" aria-hidden />}
        title="No history yet"
        description="This endpoint has no recorded snapshots to chart. Run discovery to start building its evolution history."
      />
    );
  }

  const trend = mcpGradeSurfaceTrend(series);
  const markerStyle = chartSeriesStyle('red');
  const breakingColumns: McpTrendColumn[] = trend.breakingIndices.map((i) => trend.columns[i]);

  return (
    <div className="space-y-4" aria-busy={loading}>
      {/* Headline: latest grade + score, and the score/size deltas since the start of history. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="flex items-center gap-3">
          {trend.latestScored ? (
            <GradeGlyph
              grade={trend.latestScored.grade}
              score={trend.latestScored.score}
              variant="glyph"
              size="md"
            />
          ) : (
            <GradeGlyph variant="glyph" size="md" />
          )}
          <div className="flex flex-col">
            <span className="text-xs text-fg-muted">
              {trend.latestScored ? 'Latest grade' : 'Not yet scored'}
            </span>
            <span className="text-xs text-fg-muted">
              across{' '}
              <span className="font-semibold tabular-nums text-fg">
                {series.length}
              </span>{' '}
              {series.length === 1 ? 'snapshot' : 'snapshots'}
            </span>
          </div>
        </div>
        <div className="text-right">
          <div className="text-sm text-fg-muted">
            <span className="text-lg font-semibold tabular-nums text-fg">
              {trend.latestTotal ?? 0}
            </span>{' '}
            {trend.latestTotal === 1 ? 'capability' : 'capabilities'} now
          </div>
        </div>
      </div>

      {/* Quality-score trend with breaking-change markers overlaid. */}
      <TrendBlock title="Quality score" delta={<DeltaBadge delta={trend.scoreDelta} unit="pts" />}>
        {trend.hasAnyScore ? (
          <TrendLine
            data={trend.scores}
            tone="emerald"
            domainMax={100}
            markers={trend.breakingIndices}
            title="Quality score per snapshot (0–100), breaking-change releases marked"
            pointLabel={(i) => mcpTrendScoreLabel(trend.columns[i])}
          />
        ) : (
          <p className="rounded-md border border-dashed border-border bg-inset px-3 py-4 text-center text-xs text-fg-muted">
            No snapshot has been scored yet, so there is no quality trend to plot.
          </p>
        )}
      </TrendBlock>

      {/* Surface-size trend (capability count) — always present, even before any score exists. */}
      <TrendBlock
        title="Surface size"
        delta={<DeltaBadge delta={trend.totalDelta} unit="capabilities" />}
      >
        <TrendLine
          data={trend.totals}
          tone="violet"
          markers={trend.breakingIndices}
          title="Capability count per snapshot, breaking-change releases marked"
          pointLabel={(i) => mcpTrendSurfaceLabel(trend.columns[i])}
        />
      </TrendBlock>

      {/* Breaking-change markers: a legend + clickable chips that deep-link to each release's diff. */}
      {breakingColumns.length > 0 ? (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-xs font-medium text-fg-muted">
            <svg viewBox="0 0 10 10" className="h-2.5 w-2.5" aria-hidden>
              <rect x={0} y={0} width={10} height={10} rx={2} className={markerStyle.fillClass} />
            </svg>
            <ShieldAlert className="size-3.5 text-danger" aria-hidden />
            Breaking-change releases
          </div>
          <div className="flex flex-wrap gap-2">
            {breakingColumns.map((column) => (
              <button
                key={column.versionId}
                type="button"
                onClick={() => onSelectVersion(column.versionId)}
                className="inline-flex items-center gap-1.5 rounded-full bg-danger-soft px-2.5 py-1 text-xs text-danger-fg transition-colors hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger"
              >
                <span className="font-semibold">{column.axisLabel}</span>
                <span className="tabular-nums">
                  {column.breakingCount} breaking
                </span>
              </button>
            ))}
          </div>
          <p className="flex items-center gap-1.5 text-xs text-fg-muted">
            <MousePointerClick className="h-3.5 w-3.5 shrink-0 text-fg-muted" aria-hidden />
            Select a breaking-change release to open its diff in the version history.
          </p>
        </div>
      ) : (
        <p className="text-xs text-fg-muted">
          No breaking changes recorded across{' '}
          <span className="font-semibold tabular-nums text-fg">
            {series.length}
          </span>{' '}
          {series.length === 1 ? 'snapshot' : 'snapshots'}.
        </p>
      )}
    </div>
  );
}
