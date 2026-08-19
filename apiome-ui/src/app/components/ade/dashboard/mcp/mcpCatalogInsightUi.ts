/**
 * Catalog analytics — shared types & pure presentation helpers (V2-MCP-32.1 / MCAT-18.1, #4645).
 *
 * The **Catalog Analytics** dashboard (`/ade/dashboard/mcp/analytics`) rolls the tenant's whole MCP
 * catalog into one screen: how many endpoints exist / are published / discovered / scored, the
 * average quality score, and the composition breakdowns — endpoints by category, transport,
 * `protocol_version`, grade, tool-count band, and discovery health — plus the most-churned endpoints
 * and the most widely exposed capabilities. Every number is a real server aggregate
 * (apiome-rest `insight/catalog`); this module is the *pure, React-free* client layer over that
 * payload: the typed wire shape, a defensive parser, and the projections the
 * {@link CatalogAnalyticsDashboard} renders (donut segments, bar data, percentages, tones).
 *
 * Keeping it free of React/JSX lets it be unit-tested directly and keeps the panel free of
 * payload-shaping branches — mirroring {@link mcpTrustProfileFromPayload}. The one substitution worth
 * calling out: `topCapabilities` is a real "most widely exposed capability" aggregate standing in for
 * the roadmap's "most-searched capabilities" — there is no search-query log to rank by, so the panel
 * ranks by how many endpoints expose each capability instead.
 */

import {
  chartCategoricalTone,
  type BarDatum,
  type ChartSeriesTone,
  type DonutSegment,
} from '@/app/components/ui/mcp/charts';

// --- Wire types ------------------------------------------------------------------------------
// One-to-one with the apiome-rest `McpInsightCatalogResponse` and its nested `*Out` models.

/** One labelled slice of a composition breakdown — a bucket label and its endpoint count. */
export interface McpCatalogBucket {
  label: string;
  count: number;
}

/** One change-frequency leader — an endpoint and how many surface changes it has recorded. */
export interface McpCatalogLeader {
  endpointId: string;
  name: string;
  changeCount: number;
}

/** One widely-exposed capability — its kind, name, and how many endpoints expose it. */
export interface McpCatalogCapability {
  itemType: string;
  itemName: string;
  endpointCount: number;
}

/** Per-kind capability totals summed across every endpoint's current surface. */
export interface McpCatalogTypeCounts {
  tools: number;
  resources: number;
  resourceTemplates: number;
  prompts: number;
  total: number;
}

/** The full tenant-catalog roll-up the dashboard renders. */
export interface McpCatalogInsight {
  endpointCount: number;
  publishedCount: number;
  publicCount: number;
  privateCount: number;
  discoveredCount: number;
  scoredCount: number;
  /** Average quality score over scored current versions, or `null` when nothing is scored. */
  averageScore: number | null;
  typeCounts: McpCatalogTypeCounts;
  /** A–F grade histogram, sorted by grade ascending. */
  gradeDistribution: McpCatalogBucket[];
  categoryDistribution: McpCatalogBucket[];
  transportDistribution: McpCatalogBucket[];
  protocolVersionDistribution: McpCatalogBucket[];
  /** Fixed-bucket histogram of per-endpoint tool counts ("0", "1–5", … "50+"), in display order. */
  toolCountDistribution: McpCatalogBucket[];
  discoveryHealth: McpCatalogBucket[];
  changeLeaders: McpCatalogLeader[];
  topCapabilities: McpCatalogCapability[];
}

// --- Defensive coercion ----------------------------------------------------------------------

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
}

function asScore(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Parse a `{label, count}[]` breakdown defensively; malformed entries are dropped, order kept. */
function bucketsFromPayload(raw: unknown): McpCatalogBucket[] {
  if (!Array.isArray(raw)) return [];
  const out: McpCatalogBucket[] = [];
  for (const entry of raw) {
    const r = (entry ?? {}) as Record<string, unknown>;
    const label = asString(r.label);
    if (!label) continue;
    out.push({ label, count: asInt(r.count) });
  }
  return out;
}

/**
 * Parse an `insight/catalog` response into a {@link McpCatalogInsight}, or `null` when the payload is
 * absent/malformed (the dashboard then shows its error state, never a crash). Every breakdown
 * defaults to an empty list, so an empty catalog (`endpointCount === 0`) parses cleanly into the
 * dashboard's empty state rather than throwing.
 */
export function mcpCatalogInsightFromPayload(data: unknown): McpCatalogInsight | null {
  if (!data || typeof data !== 'object') return null;
  const p = data as Record<string, unknown>;
  // A response is only structurally valid if it carries the scalar tallies; `success: false` bodies
  // (an error envelope) have no counts and are treated as malformed.
  if (typeof p.endpoint_count !== 'number') return null;

  const tc = (p.type_counts ?? {}) as Record<string, unknown>;
  const gradeMap = (p.grade_distribution ?? {}) as Record<string, unknown>;
  const gradeDistribution = Object.keys(gradeMap)
    .sort((a, b) => a.localeCompare(b))
    .map((grade) => ({ label: grade, count: asInt(gradeMap[grade]) }));

  return {
    endpointCount: asInt(p.endpoint_count),
    publishedCount: asInt(p.published_count),
    publicCount: asInt(p.public_count),
    privateCount: asInt(p.private_count),
    discoveredCount: asInt(p.discovered_count),
    scoredCount: asInt(p.scored_count),
    averageScore: asScore(p.average_score),
    typeCounts: {
      tools: asInt(tc.tools),
      resources: asInt(tc.resources),
      resourceTemplates: asInt(tc.resource_templates),
      prompts: asInt(tc.prompts),
      total: asInt(tc.total),
    },
    gradeDistribution,
    categoryDistribution: bucketsFromPayload(p.category_distribution),
    transportDistribution: bucketsFromPayload(p.transport_distribution),
    protocolVersionDistribution: bucketsFromPayload(p.protocol_version_distribution),
    toolCountDistribution: bucketsFromPayload(p.tool_count_distribution),
    discoveryHealth: bucketsFromPayload(p.discovery_health),
    changeLeaders: (Array.isArray(p.change_leaders) ? p.change_leaders : [])
      .map((raw) => {
        const r = (raw ?? {}) as Record<string, unknown>;
        const endpointId = asString(r.endpoint_id);
        if (!endpointId) return null;
        return {
          endpointId,
          name: asString(r.name) ?? endpointId,
          changeCount: asInt(r.change_count),
        };
      })
      .filter((leader): leader is McpCatalogLeader => leader !== null),
    topCapabilities: (Array.isArray(p.top_capabilities) ? p.top_capabilities : [])
      .map((raw) => {
        const r = (raw ?? {}) as Record<string, unknown>;
        const itemName = asString(r.item_name);
        if (!itemName) return null;
        return {
          itemType: asString(r.item_type) ?? '',
          itemName,
          endpointCount: asInt(r.endpoint_count),
        };
      })
      .filter((cap): cap is McpCatalogCapability => cap !== null),
  };
}

// --- Presentation projections ----------------------------------------------------------------

/** True when the catalog holds no endpoints — the dashboard renders its empty state, not tiles. */
export function mcpCatalogIsEmpty(insight: McpCatalogInsight): boolean {
  return insight.endpointCount <= 0;
}

/** A count as a whole-number percentage of `total` (`0` when `total` is zero — never NaN). */
export function mcpCatalogPercent(count: number, total: number): number {
  if (!total || total <= 0) return 0;
  return Math.round((count / total) * 100);
}

/** The chart-series tone an A–F grade paints with: A/B green, C amber, D-and-below red. */
export function mcpCatalogGradeTone(grade: string): ChartSeriesTone {
  const g = grade.trim().toUpperCase().charAt(0);
  if (g === 'A' || g === 'B') return 'emerald';
  if (g === 'C') return 'amber';
  return 'red';
}

/**
 * Project a composition breakdown onto {@link Donut} segments. Each slice takes the next categorical
 * tone (stable, repeatable order) unless a per-bucket `toneFor` override is supplied (used for the
 * grade donut, where the tone carries meaning). Buckets are assumed already ordered by the server.
 */
export function mcpCatalogDonutSegments(
  buckets: readonly McpCatalogBucket[],
  toneFor?: (bucket: McpCatalogBucket, index: number) => ChartSeriesTone,
): DonutSegment[] {
  return buckets.map((bucket, index) => ({
    label: bucket.label,
    value: bucket.count,
    tone: toneFor ? toneFor(bucket, index) : chartCategoricalTone(index),
  }));
}

/**
 * Project a composition breakdown onto {@link BarSeries} data. An optional `tone` paints every bar
 * uniformly (e.g. the tool-count histogram, a single-series distribution); omit it to leave the bars
 * on the series default.
 */
export function mcpCatalogBars(
  buckets: readonly McpCatalogBucket[],
  tone?: ChartSeriesTone,
): BarDatum[] {
  return buckets.map((bucket) => ({ label: bucket.label, value: bucket.count, tone }));
}

// --- Screen copy (HIVE-7.9, #5326) -----------------------------------------------------------
// The strings `docs/mockups/sources/mcp-analytics.html` fixes, kept here rather than in the
// component so the page, the dashboard and the suites all read one definition of each.

/** The page's `h1`. */
export const MCP_ANALYTICS_TITLE = 'Catalog analytics';

/** The one line under it — DESIGN.md §5.3 asks for fourteen words or fewer. */
export const MCP_ANALYTICS_DESCRIPTION =
  'How the workspace’s MCP servers break down — category, transport, protocol, grade, health, churn and reach.';

/** Shown while the roll-up is in flight. */
export const MCP_ANALYTICS_LOADING = 'Loading catalog analytics…';

/** The error state's heading; the message itself is whatever the read failed with. */
export const MCP_ANALYTICS_ERROR_TITLE = 'Catalog analytics unavailable';

/** Used when a failed read carries no message of its own. */
export const MCP_ANALYTICS_ERROR_FALLBACK = 'Could not load catalog analytics.';

/** The first-run state: the catalog itself is empty, which is not an error. */
export const MCP_ANALYTICS_EMPTY_TITLE = 'No servers in the catalog yet';

/** Its body copy. */
export const MCP_ANALYTICS_EMPTY_DESC =
  'Register and discover MCP servers to populate catalog-wide analytics — category, transport, grade and health mixes appear once the first snapshot lands.';

/** Shown in place of the screen when the session has no workspace to read a catalog for. */
export const MCP_ANALYTICS_NO_TENANT =
  'Switch to a workspace to see how its MCP catalog breaks down.';

/** A donut whose breakdown came back empty prints this in place of its legend. */
export const MCP_ANALYTICS_NO_DATA = 'No data yet.';

/** The change-frequency leaderboard's empty copy. */
export const MCP_ANALYTICS_NO_CHANGES = 'No surface changes recorded yet.';

/** The capability leaderboard's empty copy. */
export const MCP_ANALYTICS_NO_CAPABILITIES = 'No capabilities discovered yet.';

/**
 * What the capability leaderboard is actually ranked by.
 *
 * The roadmap asked for "most-searched capabilities" and there is no search-query log to rank by,
 * so this ranks by reach instead. The panel prints the sentence rather than leaving a reader to
 * assume the other meaning.
 */
export const MCP_ANALYTICS_TOP_CAPABILITIES_NOTE =
  'Ranked by how many endpoints expose each capability.';

// --- Derived tallies -------------------------------------------------------------------------

/** How many endpoints have never been discovered — the gap the "Discovered" stat sits against. */
export function mcpCatalogUndiscoveredCount(insight: McpCatalogInsight): number {
  return Math.max(0, insight.endpointCount - insight.discoveredCount);
}

/** How many endpoints carry no score — the gap the "Scored" stat sits against. */
export function mcpCatalogUnscoredCount(insight: McpCatalogInsight): number {
  return Math.max(0, insight.endpointCount - insight.scoredCount);
}

/** `"1 endpoint"` / `"4 endpoints"` — the singular every footnote and leaderboard row needs. */
export function mcpCatalogPlural(count: number, noun: string, plural = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : plural}`;
}

/**
 * The footnote under the **Discovered** stat, or `null` when every endpoint has been discovered.
 *
 * A footnote that reads "0 never discovered" is noise; the absence of the line is the same
 * statement made quietly.
 */
export function mcpCatalogDiscoveredFootnote(insight: McpCatalogInsight): string | null {
  const gap = mcpCatalogUndiscoveredCount(insight);
  return gap === 0 ? null : `${gap} never discovered`;
}

/** The footnote under the **Scored** stat, or `null` when every endpoint carries a score. */
export function mcpCatalogScoredFootnote(insight: McpCatalogInsight): string | null {
  const gap = mcpCatalogUnscoredCount(insight);
  return gap === 0 ? null : `${gap} unscored`;
}

/**
 * The footnote under the **Published** stat: the public/private split.
 *
 * `publicCount` and `privateCount` have been in the payload since MCAT-18.1 and were parsed but
 * never rendered — the mockup's "Adds" list calls that out, and this is the line it asks for.
 */
export function mcpCatalogPublishedFootnote(insight: McpCatalogInsight): string {
  return `${insight.publicCount} public · ${insight.privateCount} private`;
}

// --- CSV export ------------------------------------------------------------------------------

/** One row of the exported dashboard: which block it came from, what it counts, and the figure. */
interface McpCatalogCsvRow {
  section: string;
  label: string;
  value: string;
}

/**
 * One CSV field, quoted per RFC 4180.
 *
 * Everything is quoted rather than only the fields that need it: a capability name is arbitrary
 * user text, and the alternative is a rule about *when* to quote that a reader of this file has to
 * re-derive. A literal `"` doubles.
 *
 * @param value The raw field text.
 * @returns The quoted field.
 */
function csvField(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * The whole dashboard as a CSV document — the mockup's **Export CSV** action.
 *
 * Long rather than wide: one row per figure, tagged with the block it came from, so the six
 * breakdowns and the two leaderboards (which have different shapes and different row counts) land
 * in one sheet a reader can pivot. The header row is `Section,Label,Value`.
 *
 * Pure and React-free so the exported numbers can be asserted directly against the same
 * {@link McpCatalogInsight} the tiles render, which is what stops the sheet and the screen
 * disagreeing.
 *
 * @param insight The parsed catalog roll-up.
 * @returns The CSV text, CRLF-terminated per RFC 4180.
 */
export function mcpCatalogInsightCsv(insight: McpCatalogInsight): string {
  const rows: McpCatalogCsvRow[] = [
    { section: 'Totals', label: 'Endpoints', value: String(insight.endpointCount) },
    { section: 'Totals', label: 'Published', value: String(insight.publishedCount) },
    { section: 'Totals', label: 'Public', value: String(insight.publicCount) },
    { section: 'Totals', label: 'Private', value: String(insight.privateCount) },
    { section: 'Totals', label: 'Discovered', value: String(insight.discoveredCount) },
    { section: 'Totals', label: 'Scored', value: String(insight.scoredCount) },
    {
      section: 'Totals',
      label: 'Average score',
      value: insight.averageScore !== null ? insight.averageScore.toFixed(1) : '',
    },
    { section: 'Capabilities', label: 'Tools', value: String(insight.typeCounts.tools) },
    { section: 'Capabilities', label: 'Resources', value: String(insight.typeCounts.resources) },
    {
      section: 'Capabilities',
      label: 'Resource templates',
      value: String(insight.typeCounts.resourceTemplates),
    },
    { section: 'Capabilities', label: 'Prompts', value: String(insight.typeCounts.prompts) },
    { section: 'Capabilities', label: 'Total', value: String(insight.typeCounts.total) },
  ];

  const breakdowns: ReadonlyArray<readonly [string, readonly McpCatalogBucket[]]> = [
    ['Category mix', insight.categoryDistribution],
    ['Transport mix', insight.transportDistribution],
    ['Grade distribution', insight.gradeDistribution],
    ['Protocol version adoption', insight.protocolVersionDistribution],
    ['Tool-count distribution', insight.toolCountDistribution],
    ['Discovery health', insight.discoveryHealth],
  ];
  for (const [section, buckets] of breakdowns) {
    for (const bucket of buckets) {
      rows.push({ section, label: bucket.label, value: String(bucket.count) });
    }
  }

  for (const leader of insight.changeLeaders) {
    rows.push({
      section: 'Change-frequency leaders',
      label: leader.name,
      value: String(leader.changeCount),
    });
  }
  for (const capability of insight.topCapabilities) {
    rows.push({
      section: 'Top capabilities',
      label: `${capability.itemType || 'item'} ${capability.itemName}`.trim(),
      value: String(capability.endpointCount),
    });
  }

  const lines = [
    ['Section', 'Label', 'Value'].map(csvField).join(','),
    ...rows.map((row) => [row.section, row.label, row.value].map(csvField).join(',')),
  ];
  return `${lines.join('\r\n')}\r\n`;
}

/** The filename the CSV download is offered under. */
export const MCP_ANALYTICS_CSV_FILENAME = 'mcp-catalog-analytics.csv';
