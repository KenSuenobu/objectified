'use client';

/**
 * Catalog analytics dashboard (V2-MCP-32.1 / MCAT-18.1; redesigned HIVE-7.9, #5326).
 *
 * Authority: `docs/mockups/sources/mcp-analytics.html`, whose **Notes → Keeps (1:1)** list is this
 * screen's acceptance criteria.
 *
 * The tenant-wide counterpart to the per-endpoint Insight tab: one screen that rolls the whole MCP
 * catalog into headline tallies and composition breakdowns. From the `insight/catalog` payload it
 * renders:
 *
 * - a **headline stat strip** — endpoints, published, discovered, scored and the average quality
 *   score, each with the figure it is measured against underneath it;
 * - three **{@link Donut} mixes** — endpoints by category, by transport, and by A–F grade (the
 *   grade ring toned by band, greens → reds);
 * - three **{@link BarSeries} distributions** — `protocol_version` adoption, the tool-count
 *   histogram, and the discovery-health rollup, each over the labelled axis the mockup draws; and
 * - two **leaderboards** — the most-churned endpoints (change-frequency leaders) and the most
 *   widely exposed capabilities (a real aggregate standing in for the roadmap's "most-searched",
 *   which has no backing search-query log — the panel says so).
 *
 * All projections come from the pure, unit-tested {@link mcpCatalogInsightFromPayload} and its
 * presentation helpers, so the tiles, legends and percentages can never disagree. The component
 * owns its loading / error / **empty-catalog** states.
 *
 * ### What the redesign changed
 *
 * 1. **The stat row was five bordered boxes** (`rounded-xl border border-gray-200 bg-white
 *    dark:border-gray-700 dark:bg-gray-800`) carrying a figure and a caps label, and nothing else.
 *    It is `StatGrid` / `Stat` from the HIVE-2.6 metrics set: the hairline strip reads as one
 *    object, and each figure now carries the mockup's footnote — the public/private split under
 *    *Published*, the never-discovered and unscored gaps under *Discovered* and *Scored*. Those
 *    figures were already in the payload and already parsed; only the rendering was missing.
 * 2. **Every tile was a hand-rolled panel** with the same border/background pair repeated eight
 *    times and an `h3` in `text-gray-800 dark:text-gray-100`. They are `Card` + `CardTitle`, so
 *    the panel follows the reader's theme rather than one light palette and one dark one.
 * 3. **The bar tiles printed their buckets only as a wrapped list.** The mockup draws the axis
 *    under the bars *and* the list beneath that, because a six-bucket histogram is unreadable
 *    without labels under the columns. Both are here, and the axis is `aria-hidden` — the chart's
 *    own `sr-only` table already states every bucket, so a screen reader is not read three copies.
 * 4. **The leaderboards had no empty footer.** The mockup gives each a footer that names what it
 *    would say if it were empty and, for capabilities, links on to the directory; the footer is
 *    where the "ranked by reach, not by searches" sentence now lives.
 * 5. **Nothing here spells a colour any more.** The legend swatch took `chartSeriesStyle().
 *    fillClass` (a `fill-*` utility on a `<span>`, which paints nothing — the swatch was invisible
 *    for four releases); it takes the tone's `bg-*` role class now, resolved through the same
 *    {@link CHART_TONE_ROLE} table the donut segment beside it paints from.
 */

import * as React from 'react';
import Link from 'next/link';
import {
  Activity,
  Award,
  BarChart3,
  Flame,
  Gauge,
  Globe,
  Layers,
  Network,
  PieChart,
  Radar,
  Server,
  ServerOff,
} from 'lucide-react';
import { Badge } from '@/app/components/ui/Badge';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/app/components/ui/Card';
import { EmptyState } from '@/app/components/ui/EmptyState';
import { ErrorState } from '@/app/components/ui/ErrorState';
import { LoadingState } from '@/app/components/ui/LoadingState';
import { Stat, StatGrid } from '@/app/components/ui/metrics';
import {
  BarSeries,
  CHART_TONE_ROLE,
  Donut,
  type ChartSeriesTone,
} from '@/app/components/ui/mcp/charts';
import {
  MCP_ANALYTICS_EMPTY_DESC,
  MCP_ANALYTICS_EMPTY_TITLE,
  MCP_ANALYTICS_ERROR_TITLE,
  MCP_ANALYTICS_LOADING,
  MCP_ANALYTICS_NO_CAPABILITIES,
  MCP_ANALYTICS_NO_CHANGES,
  MCP_ANALYTICS_NO_DATA,
  MCP_ANALYTICS_TOP_CAPABILITIES_NOTE,
  mcpCatalogBars,
  mcpCatalogDiscoveredFootnote,
  mcpCatalogDonutSegments,
  mcpCatalogGradeTone,
  mcpCatalogIsEmpty,
  mcpCatalogPercent,
  mcpCatalogPlural,
  mcpCatalogPublishedFootnote,
  mcpCatalogScoredFootnote,
  type McpCatalogBucket,
  type McpCatalogInsight,
} from '@/app/components/ade/dashboard/mcp/mcpCatalogInsightUi';

interface Props {
  /** The parsed catalog roll-up, or `null` while it has not loaded. */
  data: McpCatalogInsight | null;
  loading: boolean;
  error: string | null;
  /** Re-run the read. Wired to the error state's Retry, which the mockup draws. */
  onRetry?: () => void;
}

/** Where the capability leaderboard's footer link goes. */
const CAPABILITY_DIRECTORY_ROUTE = '/ade/dashboard/mcp/capabilities';

/**
 * The `bg-*` class a chart tone paints a legend swatch with.
 *
 * The chart kit's own {@link chartSeriesStyle} answers in `fill-*` / `stroke-*` / `text-*`, which
 * are SVG paint channels — a `<span>` carrying `fill-accent` renders as an unpainted box, which is
 * exactly what the legend used to draw. Reading {@link CHART_TONE_ROLE} directly gives the same
 * role token in the channel an HTML element actually uses, so the ring and the list beside it stay
 * one palette by construction rather than by two tables agreeing.
 *
 * @param tone The segment's tone, as {@link mcpCatalogDonutSegments} assigned it.
 * @returns The background class for the 10 px swatch.
 */
function swatchClass(tone: ChartSeriesTone | undefined): string {
  return `bg-${CHART_TONE_ROLE[tone ?? 'neutral']}`;
}

/**
 * A donut breakdown with its own legend.
 *
 * The legend prints `label · value (pct%)` — the mockup's line — so the reader never has to read
 * the ring to get a number. That is also what keeps the tile legible in the two appearances where
 * a saturated role token does not clear 3:1 as a mark: the words carry the meaning, the colour
 * only groups.
 *
 * @param props.title The tile's heading.
 * @param props.icon Its leading glyph.
 * @param props.unit What the percentages are a share of, printed beside the heading.
 * @param props.buckets The breakdown, already ordered by the server.
 * @param props.toneFor Per-bucket tone override, for the grade ring where the tone means something.
 * @param props.total The denominator the percentages are taken against.
 * @returns The card.
 */
function DonutTile({
  title,
  icon,
  unit,
  buckets,
  toneFor,
  total,
  testId,
}: {
  title: string;
  icon: React.ReactNode;
  unit: string;
  buckets: McpCatalogBucket[];
  toneFor?: (bucket: McpCatalogBucket, index: number) => ChartSeriesTone;
  total: number;
  testId: string;
}) {
  const segments = mcpCatalogDonutSegments(buckets, toneFor);
  return (
    <Card className="p-[var(--card-pad)]" data-testid={testId}>
      <CardTitle className="mcpa-tile__title">
        {icon}
        {title}
        <span className="mcpa-tile__unit">{unit}</span>
      </CardTitle>
      <div className="mcpa-donut">
        <Donut segments={segments} title={title} centerLabel={total} className="mcpa-donut__ring" />
        <ul className="mcpa-legend">
          {segments.length === 0 ? (
            <li className="mcpa-legend__empty">{MCP_ANALYTICS_NO_DATA}</li>
          ) : (
            segments.map((segment) => (
              <li key={segment.label} className="mcpa-legend__row">
                <span className={`mcpa-legend__swatch ${swatchClass(segment.tone)}`} aria-hidden />
                <span className="mcpa-legend__label">{segment.label}</span>
                <span className="mcpa-legend__value">
                  {segment.value}
                  <span className="mcpa-legend__pct">
                    ({mcpCatalogPercent(segment.value, total)}%)
                  </span>
                </span>
              </li>
            ))
          )}
        </ul>
      </div>
    </Card>
  );
}

/**
 * A single-series bar distribution (protocol adoption, tool-count histogram, discovery health).
 *
 * Three rows: the bars, the axis under them, and the wrapped label/count list the mockup prints
 * beneath. The axis is `aria-hidden` because {@link BarSeries} already exposes the whole series as
 * an `sr-only` table, and the list under it repeats the same pairs in words for a sighted reader.
 *
 * @param props.title The tile's heading.
 * @param props.icon Its leading glyph.
 * @param props.buckets The histogram, in display order.
 * @param props.tone The one tone every bar takes — these are single-series distributions.
 * @returns The card.
 */
function BarTile({
  title,
  icon,
  buckets,
  tone,
  testId,
}: {
  title: string;
  icon: React.ReactNode;
  buckets: McpCatalogBucket[];
  tone: ChartSeriesTone;
  testId: string;
}) {
  return (
    <Card className="p-[var(--card-pad)]" data-testid={testId}>
      <CardTitle className="mcpa-tile__title">
        {icon}
        {title}
      </CardTitle>
      <BarSeries
        data={mcpCatalogBars(buckets, tone)}
        tone={tone}
        title={title}
        className="mcpa-bars"
      />
      <div className="mcpa-axis" aria-hidden>
        {buckets.map((bucket) => (
          <span key={bucket.label}>{bucket.label}</span>
        ))}
      </div>
      <ul className="mcpa-counts">
        {buckets.map((bucket) => (
          <li key={bucket.label}>
            {bucket.label} · <span className="mcpa-counts__value">{bucket.count}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * The catalog analytics dashboard.
 *
 * Owns its loading / error / empty-catalog states; every populated tile renders straight from the
 * pure projections, so the numbers are a single source of truth.
 *
 * @param props See {@link Props}.
 * @returns The dashboard, or the one state that stands in for it.
 */
export function CatalogAnalyticsDashboard({ data, loading, error, onRetry }: Props) {
  if (loading && !data) {
    return <LoadingState minHeightClassName="min-h-[320px]" message={MCP_ANALYTICS_LOADING} />;
  }
  if (error) {
    return (
      <ErrorState
        variant="compact"
        icon={<ServerOff aria-hidden />}
        title={MCP_ANALYTICS_ERROR_TITLE}
        description={error}
        onRetry={onRetry}
        data-testid="mcp-analytics-error"
      />
    );
  }
  if (!data) return null;

  // An empty catalog: nothing to aggregate. A first-run state, not an error.
  if (mcpCatalogIsEmpty(data)) {
    return (
      <EmptyState
        icon={<Server aria-hidden />}
        title={MCP_ANALYTICS_EMPTY_TITLE}
        description={MCP_ANALYTICS_EMPTY_DESC}
        data-testid="mcp-analytics-empty"
      />
    );
  }

  const {
    endpointCount,
    publishedCount,
    discoveredCount,
    scoredCount,
    averageScore,
    typeCounts,
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
    <div className="mcpa" aria-busy={loading} data-testid="mcp-analytics">
      {/* Headline tallies. */}
      <StatGrid columns={5} data-testid="mcp-analytics-stats">
        <Stat
          icon={<Server aria-hidden />}
          label="Endpoints"
          value={endpointCount}
          footnote={mcpCatalogPlural(typeCounts.total, 'capability', 'capabilities')}
        />
        <Stat
          icon={<Globe aria-hidden />}
          label="Published"
          value={publishedCount}
          unit={`of ${endpointCount}`}
          footnote={mcpCatalogPublishedFootnote(data)}
        />
        <Stat
          icon={<Radar aria-hidden />}
          label="Discovered"
          value={discoveredCount}
          footnote={mcpCatalogDiscoveredFootnote(data)}
        />
        <Stat
          icon={<Award aria-hidden />}
          label="Scored"
          value={scoredCount}
          footnote={mcpCatalogScoredFootnote(data)}
        />
        <Stat
          icon={<Gauge aria-hidden />}
          label="Avg score"
          value={averageScore !== null ? averageScore.toFixed(1) : '—'}
          footnote="across scored endpoints"
        />
      </StatGrid>

      {/* Composition mixes. */}
      <div className="mcpa-row">
        <DonutTile
          title="Category mix"
          icon={<PieChart aria-hidden />}
          unit="% of endpoints"
          buckets={categoryDistribution}
          total={endpointCount}
          testId="mcp-analytics-category-mix"
        />
        <DonutTile
          title="Transport mix"
          icon={<Network aria-hidden />}
          unit="% of endpoints"
          buckets={transportDistribution}
          total={endpointCount}
          testId="mcp-analytics-transport-mix"
        />
        <DonutTile
          title="Grade distribution"
          icon={<BarChart3 aria-hidden />}
          unit="% of scored"
          buckets={gradeDistribution}
          toneFor={(bucket) => mcpCatalogGradeTone(bucket.label)}
          total={scoredCount}
          testId="mcp-analytics-grade-mix"
        />
      </div>

      {/* Distributions. */}
      <div className="mcpa-row">
        <BarTile
          title="Protocol version adoption"
          icon={<Layers aria-hidden />}
          buckets={protocolVersionDistribution}
          tone="violet"
          testId="mcp-analytics-protocol"
        />
        <BarTile
          title="Tool-count distribution"
          icon={<BarChart3 aria-hidden />}
          buckets={toolCountDistribution}
          tone="indigo"
          testId="mcp-analytics-tool-counts"
        />
        <BarTile
          title="Discovery health"
          icon={<Activity aria-hidden />}
          buckets={discoveryHealth}
          tone="emerald"
          testId="mcp-analytics-health"
        />
      </div>

      {/* Leaderboards. */}
      <div className="mcpa-row mcpa-row--pair">
        <Card data-testid="mcp-analytics-change-leaders">
          <CardHeader className="mcpa-card__head">
            <CardTitle className="mcpa-tile__title">
              <Flame aria-hidden />
              Change-frequency leaders
            </CardTitle>
            <span className="mcpa-tile__unit">surface changes recorded</span>
          </CardHeader>
          <CardContent>
            {changeLeaders.length === 0 ? (
              <p className="mcpa-note">{MCP_ANALYTICS_NO_CHANGES}</p>
            ) : (
              <ol className="mcpa-ranks">
                {changeLeaders.map((leader, index) => (
                  <li key={leader.endpointId} className="mcpa-rank">
                    <span className="mcpa-rank__pos" aria-hidden>
                      {index + 1}
                    </span>
                    <Link
                      href={`/ade/dashboard/mcp/${leader.endpointId}`}
                      className="mcpa-rank__name"
                    >
                      {leader.name}
                    </Link>
                    <span className="mcpa-rank__value">
                      {mcpCatalogPlural(leader.changeCount, 'change')}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>

        <Card data-testid="mcp-analytics-top-capabilities">
          <CardHeader className="mcpa-card__head">
            <CardTitle className="mcpa-tile__title">
              <Layers aria-hidden />
              Top capabilities
            </CardTitle>
            <span className="mcpa-tile__unit">{MCP_ANALYTICS_TOP_CAPABILITIES_NOTE}</span>
          </CardHeader>
          <CardContent>
            {topCapabilities.length === 0 ? (
              <p className="mcpa-note">{MCP_ANALYTICS_NO_CAPABILITIES}</p>
            ) : (
              <ol className="mcpa-ranks">
                {topCapabilities.map((capability) => (
                  <li
                    key={`${capability.itemType}:${capability.itemName}`}
                    className="mcpa-rank"
                  >
                    <Badge variant="neutral" square mono>
                      {(capability.itemType || 'item').toUpperCase()}
                    </Badge>
                    <span className="mcpa-rank__name mono">{capability.itemName}</span>
                    <span className="mcpa-rank__value">
                      {mcpCatalogPlural(capability.endpointCount, 'endpoint')}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
          <CardFooter>
            <span>Every tool, resource and prompt in the catalog.</span>
            <Link href={CAPABILITY_DIRECTORY_ROUTE} className="mcpa-link">
              Capability directory
            </Link>
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
