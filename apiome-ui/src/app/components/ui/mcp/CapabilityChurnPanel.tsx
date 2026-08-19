'use client';

/**
 * Capability churn timeline (V2-MCP-30.1 / MCAT-16.1).
 *
 * The version history is a list; it cannot show *how much* a server churns or *when*. This panel plots
 * one stacked column per discovery snapshot (oldest→newest on the x-axis) split into the **added /
 * removed / modified** counts that snapshot introduced — the churn recorded in `mcp_version_changes`,
 * served by `insight/evolution`. A quiet release still gets its slot on the axis (an empty column), so
 * the timeline never hides a version. The busiest release is called out, and **clicking any column
 * deep-links to that version's entry in the compare/diff viewer** (MCAT-10.3) via `onSelectVersion`.
 *
 * All series-shaping and the per-column deep-link ids come from the pure, unit-tested
 * {@link mcpChurnTimeline} projection over the same parsed series, so the chart and its click targets
 * can never disagree. The component owns its loading / error / empty states so a slow or missing
 * history never blanks the Insight tab.
 */

import * as React from 'react';
import { GitCompareArrows, MousePointerClick, Zap } from 'lucide-react';
import { EmptyState } from '@/app/components/ui/EmptyState';
import { LoadingState } from '@/app/components/ui/LoadingState';
import { StackedTimeline, chartSeriesStyle } from '@/app/components/ui/mcp/charts';
import {
  mcpChurnColumnLabel,
  mcpChurnTimeline,
  mcpEvolutionPointDateLabel,
  type McpEvolutionPoint,
} from '@/app/components/ade/dashboard/mcp/mcpEvolutionUi';
import { mcpVersionSeqLabel } from '@/app/components/ade/dashboard/mcp/mcpVersionsUi';

interface Props {
  /** The endpoint's evolution series (oldest-first), or `null` while it has not loaded. */
  series: readonly McpEvolutionPoint[] | null;
  loading: boolean;
  error: string | null;
  /** Called with a snapshot's `version_id` when its column is activated, to open its diff. */
  onSelectVersion: (versionId: string) => void;
}

/** One legend row: a swatch drawn with the band's own chart colour, plus its label. */
function LegendSwatch({ toneKey, label }: { toneKey: string; label: string }) {
  // Draw the swatch as a tiny SVG rect using the exact `fill-*` token class the bars use, so the
  // legend and the chart can never drift to different colours.
  const style = chartSeriesStyle(
    toneKey === 'added' ? 'green' : toneKey === 'removed' ? 'red' : 'blue',
  );
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-fg-muted">
      <svg viewBox="0 0 10 10" className="h-2.5 w-2.5" aria-hidden>
        <rect x={0} y={0} width={10} height={10} rx={2} className={style.fillClass} />
      </svg>
      {label}
    </span>
  );
}

/**
 * The churn timeline panel. See the module doc for the acceptance criteria it satisfies (matches the
 * seeded change history, a zero-churn version still positions on the axis, and a click deep-links to
 * the diff).
 */
export function CapabilityChurnPanel({ series, loading, error, onSelectVersion }: Props) {
  if (loading && !series) {
    return <LoadingState minHeightClassName="min-h-[180px]" message="Loading churn timeline…" />;
  }
  if (error) {
    return (
      <EmptyState
        variant="compact"
        icon={<GitCompareArrows className="h-8 w-8 text-fg-on-accent" aria-hidden />}
        title="Churn timeline unavailable"
        description={error}
      />
    );
  }
  if (!series) return null;
  if (series.length === 0) {
    return (
      <EmptyState
        variant="compact"
        icon={<GitCompareArrows className="h-8 w-8 text-fg-on-accent" aria-hidden />}
        title="No history yet"
        description="This endpoint has no recorded snapshots to chart. Run discovery to start building its evolution history."
      />
    );
  }

  const timeline = mcpChurnTimeline(series);
  const busiest = timeline.busiestIndex >= 0 ? series[timeline.busiestIndex] : null;

  return (
    <div className="space-y-3" aria-busy={loading}>
      {/* Legend + total churn headline. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <LegendSwatch toneKey="added" label="Added" />
          <LegendSwatch toneKey="removed" label="Removed" />
          <LegendSwatch toneKey="modified" label="Modified" />
        </div>
        <span className="text-xs text-fg-muted">
          <span className="font-semibold tabular-nums text-fg">
            {timeline.totalChurn}
          </span>{' '}
          {timeline.totalChurn === 1 ? 'change' : 'changes'} across{' '}
          <span className="font-semibold tabular-nums text-fg">
            {series.length}
          </span>{' '}
          {series.length === 1 ? 'snapshot' : 'snapshots'}
        </span>
      </div>

      <StackedTimeline
        series={timeline.series}
        periods={timeline.periods}
        title="Capability churn per version — added, removed, and modified"
        activeIndex={timeline.currentIndex}
        onSelectPeriod={(index) => onSelectVersion(timeline.versionIds[index])}
        periodActionLabel={(_period, index) => mcpChurnColumnLabel(series[index])}
      />

      {/* Busiest-release callout — surfaces the high-churn snapshot the AC asks us to highlight. */}
      {busiest ? (
        <button
          type="button"
          onClick={() => onSelectVersion(busiest.version_id)}
          className="flex w-full items-center gap-2 rounded-md bg-warn-soft px-3 py-2 text-left text-xs text-warn-fg transition-colors hover:brightness-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warn"
        >
          <Zap className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            Busiest release:{' '}
            <span className="font-semibold">{mcpVersionSeqLabel(busiest.version_seq)}</span> ·{' '}
            {mcpEvolutionPointDateLabel(busiest)} —{' '}
            <span className="font-semibold tabular-nums">{busiest.change_counts.total}</span>{' '}
            {busiest.change_counts.total === 1 ? 'change' : 'changes'}
          </span>
        </button>
      ) : null}

      <p className="flex items-center gap-1.5 text-xs text-fg-muted">
        <MousePointerClick className="h-3.5 w-3.5 shrink-0 text-fg-muted" aria-hidden />
        Select a version to open its diff in the version history.
      </p>
    </div>
  );
}
