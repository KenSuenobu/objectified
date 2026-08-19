'use client';

/**
 * Tool schema "shape" & complexity cards panel (V2-MCP-29.3 / MCAT-15.3).
 *
 * Renders the per-tool complexity cards for a snapshot's tools — each driven by the 14.1 metrics
 * (parameter count, required-vs-optional split as a mini bar, max nesting depth, `enum` / `oneOf`
 * presence, and whether an `output_schema` is declared) — plus a distribution histogram across the
 * server's tools and a sortable / filterable "most vs least complex" view.
 *
 * All scoring, sorting, filtering, and binning live in the pure, unit-tested `mcpToolComplexityUi`
 * module; this component only renders the produced view models and owns the sort/filter UI state.
 * A tool with no parameters and a tool with a huge nested schema both render sanely (empty mini bar
 * / saturated depth), per the ticket's acceptance criteria.
 */

import * as React from 'react';
import { Boxes, Layers3, ListTree } from 'lucide-react';
import { EmptyState } from '@/app/components/ui/EmptyState';
import { LoadingState } from '@/app/components/ui/LoadingState';
import { McpBadge } from '@/app/components/ui/mcp/McpBadge';
import type { McpBadgeTone } from '@/app/components/ade/dashboard/mcp/mcpUiPrimitives';
import { BarSeries } from '@/app/components/ui/mcp/charts';
import type { McpToolComplexity } from '@/app/components/ade/dashboard/mcp/mcpInsightUi';
import {
  DEFAULT_TOOL_FILTER,
  DEFAULT_TOOL_SORT,
  TOOL_FILTER_OPTIONS,
  TOOL_SORT_OPTIONS,
  mcpComplexityHistogram,
  mcpFilterToolViews,
  mcpSortToolViews,
  mcpToolComplexityViews,
  type McpComplexityTierKey,
  type McpToolComplexityView,
  type McpToolFilterKey,
  type McpToolSortKey,
} from '@/app/components/ade/dashboard/mcp/mcpToolComplexityUi';

interface Props {
  /** The selected snapshot's per-tool complexity metrics, or `null` while the surface has not loaded. */
  tools: readonly McpToolComplexity[] | null;
  loading: boolean;
  error: string | null;
}

/** Map a complexity tier's categorical tone token to the {@link McpBadge} tone that paints its chip. */
const TIER_BADGE_TONE: Record<McpComplexityTierKey, McpBadgeTone> = {
  none: 'slate',
  low: 'green',
  moderate: 'blue',
  high: 'amber',
  'very-high': 'red',
};

/** A small labelled control wrapping a native `<select>`, styled to match the snapshot selector. */
function SelectControl({
  id,
  label,
  value,
  onChange,
  children,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <label
        htmlFor={id}
        className="text-xs font-medium uppercase tracking-wider text-fg-muted"
      >
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-[var(--control-h)] rounded-md border border-border-strong bg-surface px-2.5 text-sm text-fg transition-colors hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {children}
      </select>
    </div>
  );
}

/** The required-vs-optional parameter split as a two-segment mini bar, with the raw counts beneath. */
function ParameterSplitBar({ view }: { view: McpToolComplexityView }) {
  const total = view.metrics.property_count;
  if (total === 0) {
    return (
      <p className="text-xs text-fg-muted">No parameters — this tool takes no input.</p>
    );
  }
  const label = `${view.requiredCount} required, ${view.optionalCount} optional of ${total} ${
    total === 1 ? 'parameter' : 'parameters'
  }`;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wider text-fg-muted">
          Parameters
        </span>
        <span className="text-sm font-semibold tabular-nums text-fg">{total}</span>
      </div>
      <div
        className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-inset"
        role="img"
        aria-label={label}
      >
        {view.requiredCount > 0 ? (
          <div className="h-full bg-accent" style={{ width: `${view.requiredPct}%` }} />
        ) : null}
        {view.optionalCount > 0 ? (
          <div
            className="h-full bg-accent-soft"
            style={{ width: `${view.optionalPct}%` }}
          />
        ) : null}
      </div>
      <div className="mt-1 flex items-center gap-3 text-xs text-fg-muted tabular-nums">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-sm bg-accent" aria-hidden />
          {view.requiredCount} required
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block size-2 rounded-sm bg-accent-soft" aria-hidden />
          {view.optionalCount} optional
        </span>
      </div>
    </div>
  );
}

/** A single feature chip (nesting depth, enum, oneOf, output schema) shown beneath a tool's split bar. */
function FeatureChip({
  icon,
  children,
  muted = false,
}: {
  icon?: React.ReactNode;
  children: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <span
      className={
        muted
          ? 'inline-flex items-center gap-1 rounded-full bg-inset px-2 py-0.5 text-xs text-fg-faint'
          : 'inline-flex items-center gap-1 rounded-full bg-inset px-2 py-0.5 text-xs font-medium text-fg'
      }
    >
      {icon ? (
        <span className="inline-flex shrink-0 items-center" aria-hidden>
          {icon}
        </span>
      ) : null}
      {children}
    </span>
  );
}

/** One tool's complexity card: name + tier + score, the parameter split bar, and its schema features. */
function ToolCard({ view }: { view: McpToolComplexityView }) {
  const { metrics } = view;
  return (
    <div className="flex flex-col gap-3 rounded-lg bg-surface p-4 shadow-[inset_0_0_0_1px_var(--border)]">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h5 className="truncate font-mono text-sm font-semibold text-fg" title={view.displayName}>
            {view.displayName}
          </h5>
          <p className="mt-0.5 text-xs text-fg-muted tabular-nums">
            Complexity score {view.score}
          </p>
        </div>
        <McpBadge tone={TIER_BADGE_TONE[view.tier.key]}>{view.tier.label}</McpBadge>
      </div>

      <ParameterSplitBar view={view} />

      <div className="flex flex-wrap items-center gap-1.5">
        {metrics.max_nesting_depth > 1 ? (
          <FeatureChip icon={<ListTree className="h-3 w-3" />}>Depth {metrics.max_nesting_depth}</FeatureChip>
        ) : (
          <FeatureChip muted>Flat</FeatureChip>
        )}
        {metrics.uses_enum ? <FeatureChip>enum</FeatureChip> : null}
        {metrics.uses_one_of ? <FeatureChip>oneOf</FeatureChip> : null}
        {metrics.has_output_schema ? (
          <FeatureChip icon={<Boxes className="h-3 w-3" />}>Output schema</FeatureChip>
        ) : (
          <FeatureChip muted>No output schema</FeatureChip>
        )}
      </div>
    </div>
  );
}

/** The distribution histogram: how many of the server's tools fall in each complexity tier. */
function ComplexityHistogram({ views }: { views: readonly McpToolComplexityView[] }) {
  const bins = React.useMemo(() => mcpComplexityHistogram(views), [views]);
  const data = bins.map((bin) => ({ label: bin.label, value: bin.count, tone: bin.tone }));
  return (
    <div>
      <div className="mb-1 text-xs font-medium uppercase tracking-wider text-fg-muted">
        Complexity distribution
      </div>
      <BarSeries
        data={data}
        title={`Tool complexity distribution: ${bins.map((b) => `${b.label} ${b.count}`).join(', ')}`}
        className="h-28"
      />
      <ul className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1" aria-hidden>
        {bins.map((bin) => (
          <li
            key={bin.key}
            className="flex items-center gap-1.5 text-xs text-fg-muted tabular-nums"
          >
            <span className="font-medium text-fg">{bin.label}</span>
            {bin.count}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The tool schema-shape & complexity panel. Handles its own loading / error / empty states so a slow
 * or missing surface never blanks the Insight tab, and its no-tools and filtered-to-empty states read
 * clearly rather than as a broken grid.
 */
export function ToolComplexityPanel({ tools, loading, error }: Props) {
  const [sort, setSort] = React.useState<McpToolSortKey>(DEFAULT_TOOL_SORT);
  const [filter, setFilter] = React.useState<McpToolFilterKey>(DEFAULT_TOOL_FILTER);

  // Build the per-tool view models once per surface; sort/filter derive from them without re-scoring.
  const views = React.useMemo(() => mcpToolComplexityViews(tools ?? []), [tools]);
  const visible = React.useMemo(
    () => mcpSortToolViews(mcpFilterToolViews(views, filter), sort),
    [views, filter, sort],
  );

  if (loading && !tools) {
    return <LoadingState minHeightClassName="min-h-[160px]" message="Loading tool complexity…" />;
  }
  if (error) {
    return (
      <EmptyState
        variant="compact"
        icon={<Layers3 className="h-8 w-8 text-fg-on-accent" aria-hidden />}
        title="Tool complexity unavailable"
        description={error}
      />
    );
  }
  if (!tools) return null;

  if (views.length === 0) {
    return (
      <EmptyState
        variant="compact"
        icon={<Layers3 className="h-8 w-8 text-fg-on-accent" aria-hidden />}
        title="No tools"
        description="This snapshot declares no tools, so there are no schemas to profile."
      />
    );
  }

  return (
    <div className="space-y-4">
      <ComplexityHistogram views={views} />

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="text-xs text-fg-muted tabular-nums">
          {visible.length === views.length
            ? `${views.length} ${views.length === 1 ? 'tool' : 'tools'}`
            : `${visible.length} of ${views.length} tools`}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <SelectControl id="mcp-tool-filter" label="Filter" value={filter} onChange={(v) => setFilter(v as McpToolFilterKey)}>
            {TOOL_FILTER_OPTIONS.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </SelectControl>
          <SelectControl id="mcp-tool-sort" label="Sort" value={sort} onChange={(v) => setSort(v as McpToolSortKey)}>
            {TOOL_SORT_OPTIONS.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </SelectControl>
        </div>
      </div>

      {visible.length === 0 ? (
        <EmptyState
          variant="compact"
          icon={<Layers3 className="h-8 w-8 text-fg-on-accent" aria-hidden />}
          title="No tools match this filter"
          description="No tool on this snapshot matches the selected filter. Choose “All tools” to see them all."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((view) => (
            <ToolCard key={`${view.index}-${view.name}`} view={view} />
          ))}
        </div>
      )}
    </div>
  );
}

export default ToolComplexityPanel;
