'use client';

/**
 * Catalog analytics dashboard (V2-MCP-32.1 / MCAT-18.1).
 *
 * The tenant-wide counterpart to the per-endpoint Insight tab: a single screen that rolls the whole
 * MCP catalog into headline tallies and composition breakdowns. From the `insight/catalog` payload it
 * renders:
 *
 * - a **headline stat row** — endpoints, published, discovered, scored, and the average quality score;
 * - three **{@link Donut} mixes** — endpoints by category, by transport, and by A–F grade (the grade
 *   ring toned by band, greens → reds);
 * - three **{@link BarSeries} distributions** — `protocol_version` adoption, the tool-count histogram,
 *   and the discovery-health rollup; and
 * - two **leaderboards** — the most-churned endpoints (change-frequency leaders) and the most widely
 *   exposed capabilities (a real aggregate standing in for the roadmap's "most-searched", which has no
 *   backing search-query log — the panel says so).
 *
 * All projections come from the pure, unit-tested {@link mcpCatalogInsightFromPayload} and its
 * presentation helpers, so the tiles, legends, and percentages can never disagree. The component owns
 * its loading / error / **empty-catalog** states, and every colour resolves from a Tailwind token via
 * the chart kit — no colour literal appears here.
 */

import * as React from 'react';
import Link from 'next/link';
import {
  Activity,
  BarChart3,
  GitCommitHorizontal,
  Layers,
  Network,
  PieChart,
  Server,
  ServerOff,
  Sparkles,
} from 'lucide-react';
import { EmptyState } from '@/app/components/ui/EmptyState';
import { LoadingState } from '@/app/components/ui/LoadingState';
import {
  BarSeries,
  Donut,
  chartSeriesStyle,
  type ChartSeriesTone,
} from '@/app/components/ui/mcp/charts';
import {
  mcpCatalogBars,
  mcpCatalogDonutSegments,
  mcpCatalogGradeTone,
  mcpCatalogIsEmpty,
  mcpCatalogPercent,
  type McpCatalogBucket,
  type McpCatalogInsight,
} from '@/app/components/ade/dashboard/mcp/mcpCatalogInsightUi';

interface Props {
  /** The parsed catalog roll-up, or `null` while it has not loaded. */
  data: McpCatalogInsight | null;
  loading: boolean;
  error: string | null;
}

/** The shared tile shell — a titled, token-bordered card every breakdown sits in. */
function Tile({
  title,
  icon,
  children,
  className,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800 ${className ?? ''}`}
    >
      <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-gray-800 dark:text-gray-100">
        <span className="text-gray-400 dark:text-gray-500" aria-hidden>
          {icon}
        </span>
        {title}
      </h3>
      {children}
    </section>
  );
}

/** One headline number in the stat row. */
function StatTile({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-800">
      <div className="text-2xl font-semibold tabular-nums text-gray-900 dark:text-white">{value}</div>
      <div className="mt-0.5 text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
        {label}
      </div>
    </div>
  );
}

/**
 * A donut breakdown with its own legend. The legend swatches take the same explicit tones the donut
 * segments do (via {@link mcpCatalogDonutSegments}), so the ring and the list always read as one
 * palette. An empty breakdown falls back to the donut's built-in empty state.
 */
function DonutTile({
  title,
  icon,
  buckets,
  toneFor,
  total,
}: {
  title: string;
  icon: React.ReactNode;
  buckets: McpCatalogBucket[];
  toneFor?: (bucket: McpCatalogBucket, index: number) => ChartSeriesTone;
  total: number;
}) {
  const segments = mcpCatalogDonutSegments(buckets, toneFor);
  return (
    <Tile title={title} icon={icon}>
      <div className="flex items-center gap-4">
        <Donut segments={segments} className="h-28 w-28 shrink-0" />
        <ul className="min-w-0 flex-1 space-y-1.5">
          {segments.length === 0 ? (
            <li className="text-xs text-gray-500 dark:text-gray-400">No data yet.</li>
          ) : (
            segments.map((seg) => (
              <li key={seg.label} className="flex items-center gap-2 text-xs">
                <span
                  className={`h-2.5 w-2.5 shrink-0 rounded-sm ${chartSeriesStyle(seg.tone).fillClass}`}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate text-gray-700 dark:text-gray-200">
                  {seg.label}
                </span>
                <span className="tabular-nums text-gray-500 dark:text-gray-400">
                  {seg.value}
                  <span className="ml-1 text-gray-400 dark:text-gray-500">
                    ({mcpCatalogPercent(seg.value, total)}%)
                  </span>
                </span>
              </li>
            ))
          )}
        </ul>
      </div>
    </Tile>
  );
}

/** A single-series bar distribution (protocol adoption, tool-count histogram, discovery health). */
function BarTile({
  title,
  icon,
  buckets,
  tone,
}: {
  title: string;
  icon: React.ReactNode;
  buckets: McpCatalogBucket[];
  tone: ChartSeriesTone;
}) {
  return (
    <Tile title={title} icon={icon}>
      <BarSeries data={mcpCatalogBars(buckets, tone)} tone={tone} className="h-28 w-full" />
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {buckets.map((bucket) => (
          <li key={bucket.label} className="text-xs text-gray-500 dark:text-gray-400">
            <span className="text-gray-700 dark:text-gray-200">{bucket.label}</span>{' '}
            <span className="tabular-nums">{bucket.count}</span>
          </li>
        ))}
      </ul>
    </Tile>
  );
}

/**
 * The catalog analytics dashboard. Owns its loading / error / empty-catalog states; every populated
 * tile renders straight from the pure projections, so the numbers are a single source of truth.
 */
export function CatalogAnalyticsDashboard({ data, loading, error }: Props) {
  if (loading && !data) {
    return <LoadingState minHeightClassName="min-h-[320px]" message="Loading catalog analytics…" />;
  }
  if (error) {
    return (
      <EmptyState
        variant="compact"
        icon={<ServerOff className="h-8 w-8 text-white" aria-hidden />}
        title="Catalog analytics unavailable"
        description={error}
      />
    );
  }
  if (!data) return null;

  // An empty catalog: nothing to aggregate. A first-run state, not an error.
  if (mcpCatalogIsEmpty(data)) {
    return (
      <EmptyState
        variant="compact"
        icon={<Server className="h-8 w-8 text-white" aria-hidden />}
        title="No servers in the catalog yet"
        description="Register and discover MCP servers to populate catalog-wide analytics — category and transport mix, grade and tool-count distributions, protocol adoption, and change leaders all appear here once the catalog has endpoints."
      />
    );
  }

  const {
    endpointCount,
    publishedCount,
    discoveredCount,
    scoredCount,
    averageScore,
    categoryDistribution,
    transportDistribution,
    gradeDistribution,
    protocolVersionDistribution,
    toolCountDistribution,
    discoveryHealth,
    changeLeaders,
    topCapabilities,
  } = data;

  return (
    <div className="space-y-5" aria-busy={loading}>
      {/* Headline tallies. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <StatTile label="Endpoints" value={endpointCount} />
        <StatTile label="Published" value={publishedCount} />
        <StatTile label="Discovered" value={discoveredCount} />
        <StatTile label="Scored" value={scoredCount} />
        <StatTile
          label="Avg score"
          value={averageScore !== null ? averageScore.toFixed(1) : '—'}
        />
      </div>

      {/* Composition mixes. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <DonutTile
          title="Category mix"
          icon={<PieChart className="h-4 w-4" />}
          buckets={categoryDistribution}
          total={endpointCount}
        />
        <DonutTile
          title="Transport mix"
          icon={<Network className="h-4 w-4" />}
          buckets={transportDistribution}
          total={endpointCount}
        />
        <DonutTile
          title="Grade distribution"
          icon={<BarChart3 className="h-4 w-4" />}
          buckets={gradeDistribution}
          toneFor={(bucket) => mcpCatalogGradeTone(bucket.label)}
          total={scoredCount}
        />
      </div>

      {/* Distributions. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <BarTile
          title="Protocol version adoption"
          icon={<Layers className="h-4 w-4" />}
          buckets={protocolVersionDistribution}
          tone="violet"
        />
        <BarTile
          title="Tool-count distribution"
          icon={<BarChart3 className="h-4 w-4" />}
          buckets={toolCountDistribution}
          tone="indigo"
        />
        <BarTile
          title="Discovery health"
          icon={<Activity className="h-4 w-4" />}
          buckets={discoveryHealth}
          tone="emerald"
        />
      </div>

      {/* Leaderboards. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Tile title="Change-frequency leaders" icon={<GitCommitHorizontal className="h-4 w-4" />}>
          {changeLeaders.length === 0 ? (
            <p className="text-xs text-gray-500 dark:text-gray-400">
              No surface changes recorded yet.
            </p>
          ) : (
            <ol className="space-y-1.5">
              {changeLeaders.map((leader, index) => (
                <li key={leader.endpointId} className="flex items-center gap-2 text-sm">
                  <span className="w-4 shrink-0 text-right tabular-nums text-xs text-gray-400 dark:text-gray-500">
                    {index + 1}
                  </span>
                  <Link
                    href={`/ade/dashboard/mcp/${leader.endpointId}`}
                    className="min-w-0 flex-1 truncate font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                  >
                    {leader.name}
                  </Link>
                  <span className="tabular-nums text-xs text-gray-500 dark:text-gray-400">
                    {leader.changeCount} change{leader.changeCount === 1 ? '' : 's'}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Tile>

        <Tile title="Top capabilities" icon={<Sparkles className="h-4 w-4" />}>
          {/* A real "most widely exposed" aggregate — there is no search-query log to rank by. */}
          <p className="mb-2 text-2xs text-gray-400 dark:text-gray-500">
            Ranked by how many endpoints expose each capability.
          </p>
          {topCapabilities.length === 0 ? (
            <p className="text-xs text-gray-500 dark:text-gray-400">No capabilities discovered yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {topCapabilities.map((cap) => (
                <li key={`${cap.itemType}:${cap.itemName}`} className="flex items-center gap-2 text-sm">
                  <span className="rounded bg-gray-100 px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wider text-gray-500 dark:bg-gray-700 dark:text-gray-300">
                    {cap.itemType || 'item'}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium text-gray-800 dark:text-gray-100">
                    {cap.itemName}
                  </span>
                  <span className="tabular-nums text-xs text-gray-500 dark:text-gray-400">
                    {cap.endpointCount} endpoint{cap.endpointCount === 1 ? '' : 's'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Tile>
      </div>
    </div>
  );
}
