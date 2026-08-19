/**
 * Side-by-side server comparison — shared types & pure presentation helpers
 * (V2-MCP-32.2 / MCAT-18.2, #4646).
 *
 * Evaluators pick *between* servers, so the comparison screen aligns 2–3 endpoints column-by-column:
 * surface counts, grade, safety posture (15.4), documentation coverage (15.5), tool latency (17.2),
 * and the composite trust radar (17.4) — plus a **capability-overlap** view that separates the tools
 * every server shares from the ones unique to one, and a **protocol-version** cross-check that flags
 * when the servers negotiated different MCP protocol revisions.
 *
 * This module is the *pure, React-free* core the {@link ServerComparisonPanel} renders. The page
 * fetches each server's capability `items` (from its current version snapshot), its `insight/trust`
 * profile, and its `insight/reliability` roll-up, assembles one {@link McpCompareServer} per column,
 * and hands the array to {@link mcpCompareModel}. Everything the panel draws — the aligned metric
 * rows, the per-row *differs* highlight, the tool-overlap sets, and the protocol alignment — is a
 * projection of that pure model, so a value in the table can never disagree with the flag beside it.
 *
 * It deliberately reuses the single-server helpers (`mcpSafetyPosture`, `mcpDocCoverageMeters`,
 * `mcpSlowestTools`, the trust projections) rather than re-deriving them, so a metric reads the same
 * here as it does on the endpoint's own Insight tab. Colors/spacing never appear here — the consumer
 * maps domain values to classes.
 */

import type { McpCapabilityItem } from './mcpBrowseUi';
import type { McpTypeCounts } from './mcpInsightUi';
import { mcpSafetyPosture } from './mcpSafetyPostureUi';
import { mcpDocCoverageMeters, type McpDocCoverageMeter } from './mcpDocCoverageUi';
import {
  mcpSlowestTools,
  mcpFormatMs,
  mcpFormatErrorRate,
  type McpToolReliability,
} from './mcpReliabilityUi';
import { mcpTrustFormatValue, type McpTrustProfile } from './mcpTrustUi';

// --- Input bundle ----------------------------------------------------------------------------
// One column's worth of already-parsed, already-fetched inputs. The page assembles this from the
// browse record (name/transport/category/auth) plus three per-endpoint reads (version snapshot for
// items/protocol/grade, `insight/trust`, `insight/reliability`); keeping the shaping out of this
// module lets the whole comparison be unit-tested from plain fixtures.

/** Everything one server contributes to the comparison, pre-parsed by the page. */
export interface McpCompareServer {
  /** The endpoint's catalog id (stable column key + detail link target). */
  endpointId: string;
  /** The catalog endpoint name (shown as the column's subtitle). */
  endpointName: string;
  /** Best display name for the column header: server title/name, falling back to the endpoint name. */
  displayName: string;
  /** The endpoint transport (e.g. `streamable_http`), or `null` when unknown. */
  transport: string | null;
  /** The endpoint category, or `null` when uncategorized. */
  category: string | null;
  /** The negotiated MCP `protocol_version` (e.g. `2025-06-18`), or `null` for older/unknown servers. */
  protocolVersion: string | null;
  /** A–F grade of the compared snapshot, or `null` when unscored. */
  grade: string | null;
  /** 0–100 quality score of the compared snapshot, or `null` when unscored. */
  score: number | null;
  /** The endpoint's configured auth scheme the safety row cross-references, or `null`. */
  authType: string | null;
  /** The compared snapshot's capability items (all kinds) — the source for counts/coverage/overlap. */
  items: McpCapabilityItem[];
  /** The composite trust profile, or `null` when the endpoint has none. */
  trust: McpTrustProfile | null;
  /** The tool-invocation reliability roll-up, or `null` when the endpoint has no recorded calls. */
  reliability: McpToolReliability | null;
}

// --- Metric rows -----------------------------------------------------------------------------

/** One cell in an aligned metric row: its formatted text plus the comparable number behind it. */
export interface McpCompareCell {
  /** The text to render (already formatted — e.g. `840 ms`, `92%`, `B`, `—`). */
  display: string;
  /**
   * The comparable numeric value, or `null` when the cell is a gap / text-only (a grade letter, an
   * auth label). Rows compare on this when present, and fall back to {@link display} otherwise.
   */
  value: number | null;
}

/** One aligned metric across every column, with a flag for whether the columns disagree. */
export interface McpCompareRow {
  /** Stable row key (unique within its section). */
  key: string;
  /** Human row label. */
  label: string;
  /** One cell per server, in the same order as {@link McpCompareModel.servers}. */
  cells: McpCompareCell[];
  /** True when the cells are not all equal — the panel highlights these so differences pop. */
  differs: boolean;
  /**
   * Higher is better for this metric (score, coverage %, trust) → `true`; lower is better (latency,
   * error rate, destructive/unannotated counts) → `false`; not orderable (grade letter, auth) →
   * `null`. Lets the panel emphasize the leading column without re-encoding each metric's direction.
   */
  higherIsBetter: boolean | null;
}

/** A titled group of related metric rows (Surface / Quality / Safety / Coverage / Latency / Trust). */
export interface McpCompareSection {
  key: string;
  title: string;
  rows: McpCompareRow[];
}

// --- Tool overlap ----------------------------------------------------------------------------

/** One tool name and which of the compared servers expose it. */
export interface McpToolOverlapEntry {
  /** The tool's programmatic name. */
  name: string;
  /** The endpoint ids (in column order) that expose a tool of this name. */
  presentIn: string[];
  /** How many servers expose it (`presentIn.length`, cached for sorting/labels). */
  presentCount: number;
}

/** Tools unique to one server: the column it belongs to and its (sorted) unique tool names. */
export interface McpToolUniqueGroup {
  endpointId: string;
  displayName: string;
  tools: string[];
}

/** The capability-overlap view: the shared tools (a presence matrix) and each server's unique tools. */
export interface McpToolOverlap {
  /** Tools exposed by two or more servers, name-sorted — the shared presence matrix. */
  shared: McpToolOverlapEntry[];
  /** Tools exposed by exactly one server, grouped by that server (column order, names sorted). */
  uniqueByServer: McpToolUniqueGroup[];
  /** Count of distinct tool names across every compared server. */
  totalDistinct: number;
  /** Count of tools every compared server exposes (the full intersection). */
  sharedByAllCount: number;
}

// --- Protocol alignment ----------------------------------------------------------------------

/** The MCP protocol-version cross-check across the compared servers. */
export interface McpProtocolAlignment {
  /** Each server's negotiated protocol version (column order; `null` when unknown). */
  perServer: Array<{ endpointId: string; protocolVersion: string | null }>;
  /** The distinct *known* protocol versions among the servers (sorted). */
  distinct: string[];
  /** True when the servers agree — at most one distinct known version (unknowns are not a mismatch). */
  allMatch: boolean;
  /** True when at least one server's protocol version is unknown. */
  hasUnknown: boolean;
}

// --- Full model ------------------------------------------------------------------------------

/** The complete comparison the panel renders: columns, aligned sections, overlap, and protocol check. */
export interface McpCompareModel {
  /** The compared servers, echoed to fix the column order the cells align to. */
  servers: McpCompareServer[];
  /** The aligned metric sections. */
  sections: McpCompareSection[];
  /** The capability-overlap view. */
  overlap: McpToolOverlap;
  /** The protocol-version cross-check. */
  protocol: McpProtocolAlignment;
}

// --- Derivation helpers ----------------------------------------------------------------------

/** The capability `item_type` → {@link McpTypeCounts} field, one entry per countable kind. */
const KIND_TO_COUNT: ReadonlyArray<{ type: string; key: keyof Omit<McpTypeCounts, 'total'> }> = [
  { type: 'tool', key: 'tools' },
  { type: 'resource', key: 'resources' },
  { type: 'resource_template', key: 'resource_templates' },
  { type: 'prompt', key: 'prompts' },
];

/**
 * Tally a snapshot's capability items into per-kind counts. Derived from the same `items` the safety
 * and coverage rows use, so the surface row can never disagree with them; unknown item types are
 * ignored and `total` is the sum of the four known kinds.
 */
export function mcpCompareSurfaceCounts(items: readonly McpCapabilityItem[]): McpTypeCounts {
  const counts: McpTypeCounts = {
    tools: 0,
    resources: 0,
    resource_templates: 0,
    prompts: 0,
    total: 0,
  };
  for (const item of items) {
    const kind = KIND_TO_COUNT.find((k) => k.type === item.item_type);
    if (kind) counts[kind.key] += 1;
  }
  counts.total = counts.tools + counts.resources + counts.resource_templates + counts.prompts;
  return counts;
}

/** The distinct, non-empty tool names a server exposes, sorted for stable presentation. */
export function mcpCompareToolNames(items: readonly McpCapabilityItem[]): string[] {
  const names = new Set<string>();
  for (const item of items) {
    if (item.item_type !== 'tool') continue;
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (name.length > 0) names.add(name);
  }
  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

/** A text-only cell (grade letter, auth label) that rows compare by its display string. */
function textCell(display: string | null): McpCompareCell {
  return { display: display && display.length > 0 ? display : '—', value: null };
}

/** A numeric cell; a `null` value renders as `—` and never contributes a comparable number. */
function numberCell(value: number | null, format: (v: number) => string): McpCompareCell {
  return { display: value === null ? '—' : format(value), value };
}

/** True when the cells are not all identical — compared by numeric value when present, else text. */
function cellsDiffer(cells: readonly McpCompareCell[]): boolean {
  if (cells.length < 2) return false;
  const keys = cells.map((c) => (c.value !== null ? `n:${c.value}` : `t:${c.display}`));
  return new Set(keys).size > 1;
}

/** Assemble one row, deriving its {@link McpCompareRow.differs} flag from the cells. */
function makeRow(
  key: string,
  label: string,
  cells: McpCompareCell[],
  higherIsBetter: boolean | null,
): McpCompareRow {
  return { key, label, cells, differs: cellsDiffer(cells), higherIsBetter };
}

/** The trust axes to align, in canonical order — taken from the first server that has any. */
function trustAxisOrder(servers: readonly McpCompareServer[]): Array<{ key: string; label: string }> {
  for (const server of servers) {
    if (server.trust && server.trust.axes.length > 0) {
      return server.trust.axes.map((axis) => ({ key: axis.key, label: axis.label }));
    }
  }
  return [];
}

/** The endpoint-wide worst (slowest) p95 latency across a server's tools, or `null` when none. */
function worstP95(reliability: McpToolReliability | null): number | null {
  if (!reliability) return null;
  const slowest = mcpSlowestTools(reliability.tools, 1)[0];
  return slowest ? slowest.latency.p95_ms : null;
}

// --- Section builders ------------------------------------------------------------------------

/** The surface-count rows (tools / resources / resource templates / prompts / total). */
function surfaceSection(counts: readonly McpTypeCounts[]): McpCompareSection {
  const asInt = (v: number) => String(v);
  return {
    key: 'surface',
    title: 'Surface',
    rows: [
      makeRow('tools', 'Tools', counts.map((c) => numberCell(c.tools, asInt)), true),
      makeRow('resources', 'Resources', counts.map((c) => numberCell(c.resources, asInt)), true),
      makeRow(
        'resource_templates',
        'Resource templates',
        counts.map((c) => numberCell(c.resource_templates, asInt)),
        true,
      ),
      makeRow('prompts', 'Prompts', counts.map((c) => numberCell(c.prompts, asInt)), true),
      makeRow('total', 'Total capabilities', counts.map((c) => numberCell(c.total, asInt)), true),
    ],
  };
}

/** The quality rows (grade letter + numeric score). */
function qualitySection(servers: readonly McpCompareServer[]): McpCompareSection {
  return {
    key: 'quality',
    title: 'Quality',
    rows: [
      makeRow('grade', 'Grade', servers.map((s) => textCell(s.grade)), null),
      makeRow('score', 'Score', servers.map((s) => numberCell(s.score, (v) => String(v))), true),
    ],
  };
}

/** The safety-posture rows (destructive tools, unannotated tools, destructive-without-auth, auth). */
function safetySection(servers: readonly McpCompareServer[]): McpCompareSection {
  const postures = servers.map((s) => mcpSafetyPosture(s.items, s.authType));
  const asInt = (v: number) => String(v);
  return {
    key: 'safety',
    title: 'Safety posture',
    rows: [
      makeRow(
        'destructive',
        'Destructive tools',
        postures.map((p) => numberCell(p.counts.destructiveHint, asInt)),
        false,
      ),
      makeRow(
        'unannotated',
        'Unannotated tools',
        postures.map((p) => numberCell(p.unannotatedTools, asInt)),
        false,
      ),
      makeRow(
        'destructive_no_auth',
        'Destructive w/o auth',
        postures.map((p) => numberCell(p.destructiveWithoutAuth.length, asInt)),
        false,
      ),
      makeRow('auth', 'Auth', postures.map((p) => textCell(p.auth.label)), null),
    ],
  };
}

/** The documentation-coverage rows — one per {@link mcpDocCoverageMeters} meter, in its order. */
function coverageSection(servers: readonly McpCompareServer[]): McpCompareSection {
  const meters = servers.map((s) => mcpDocCoverageMeters(s.items));
  // Every server yields the same four meters in the same order; drive the rows off the first.
  const template: McpDocCoverageMeter[] = meters[0] ?? [];
  const pctCell = (meter: McpDocCoverageMeter | undefined): McpCompareCell => {
    if (!meter || !meter.applicable) return { display: 'N/A', value: null };
    return { display: `${meter.pct}%`, value: meter.pct };
  };
  return {
    key: 'coverage',
    title: 'Documentation coverage',
    rows: template.map((meter, index) =>
      makeRow(
        `coverage:${meter.key}`,
        meter.label,
        meters.map((m) => pctCell(m[index])),
        true,
      ),
    ),
  };
}

/** The tool-latency rows (slowest p95, endpoint error rate, calls in window). */
function latencySection(servers: readonly McpCompareServer[]): McpCompareSection {
  return {
    key: 'latency',
    title: 'Tool latency & reliability',
    rows: [
      makeRow(
        'p95',
        'Slowest tool (p95)',
        servers.map((s) => numberCell(worstP95(s.reliability), mcpFormatMs)),
        false,
      ),
      makeRow(
        'error_rate',
        'Error rate',
        servers.map((s) =>
          numberCell(
            s.reliability && s.reliability.call_count > 0 ? s.reliability.error_rate : null,
            mcpFormatErrorRate,
          ),
        ),
        false,
      ),
      makeRow(
        'calls',
        'Calls (window)',
        servers.map((s) => numberCell(s.reliability ? s.reliability.call_count : null, (v) => String(v))),
        null,
      ),
    ],
  };
}

/** The composite-trust rows (overall, then one row per aligned axis). */
function trustSection(servers: readonly McpCompareServer[]): McpCompareSection {
  const axes = trustAxisOrder(servers);
  const overallRow = makeRow(
    'trust:overall',
    'Overall trust',
    servers.map((s) => numberCell(s.trust ? s.trust.overall : null, (v) => mcpTrustFormatValue(v))),
    true,
  );
  const axisRows = axes.map((axis) =>
    makeRow(
      `trust:${axis.key}`,
      axis.label,
      servers.map((s) => {
        const found = s.trust?.axes.find((a) => a.key === axis.key);
        return numberCell(found ? found.value : null, (v) => mcpTrustFormatValue(v));
      }),
      true,
    ),
  );
  return { key: 'trust', title: 'Composite trust', rows: [overallRow, ...axisRows] };
}

// --- Tool overlap ----------------------------------------------------------------------------

/**
 * Compute the capability-overlap view across the compared servers. A tool name exposed by two or
 * more servers is *shared* (with the exact set of servers that expose it, so the panel can draw a
 * presence matrix); a tool exposed by exactly one server is *unique* to it. Both lists are
 * name-sorted and derived from the same per-server tool sets so they partition the distinct names
 * exactly — every distinct tool is either shared or unique, never both nor neither.
 */
export function mcpToolOverlap(servers: readonly McpCompareServer[]): McpToolOverlap {
  // name → the endpoint ids exposing it, in column order.
  const presence = new Map<string, string[]>();
  for (const server of servers) {
    for (const name of mcpCompareToolNames(server.items)) {
      const list = presence.get(name);
      if (list) list.push(server.endpointId);
      else presence.set(name, [server.endpointId]);
    }
  }

  const shared: McpToolOverlapEntry[] = [];
  const uniqueNames = new Map<string, string>(); // name → its sole endpointId
  let sharedByAllCount = 0;
  for (const [name, presentIn] of presence) {
    if (presentIn.length >= 2) {
      shared.push({ name, presentIn, presentCount: presentIn.length });
      if (presentIn.length === servers.length && servers.length > 0) sharedByAllCount += 1;
    } else {
      uniqueNames.set(name, presentIn[0]);
    }
  }
  shared.sort((a, b) => b.presentCount - a.presentCount || a.name.localeCompare(b.name));

  const uniqueByServer: McpToolUniqueGroup[] = servers.map((server) => ({
    endpointId: server.endpointId,
    displayName: server.displayName,
    tools: Array.from(uniqueNames.entries())
      .filter(([, id]) => id === server.endpointId)
      .map(([name]) => name)
      .sort((a, b) => a.localeCompare(b)),
  }));

  return { shared, uniqueByServer, totalDistinct: presence.size, sharedByAllCount };
}

// --- Protocol alignment ----------------------------------------------------------------------

/**
 * Cross-check the compared servers' negotiated protocol versions. The servers *agree* when they use
 * at most one distinct known version — an unknown version (older server, failed discovery) is not
 * counted as a mismatch, but is flagged separately so the panel can note it. This is the acceptance
 * criterion "differing protocol versions handled": when they differ, `allMatch` is false and the
 * panel surfaces the split.
 */
export function mcpCompareProtocolVersions(
  servers: readonly McpCompareServer[],
): McpProtocolAlignment {
  const perServer = servers.map((s) => ({
    endpointId: s.endpointId,
    protocolVersion: s.protocolVersion,
  }));
  const known = perServer
    .map((s) => s.protocolVersion)
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
  const distinct = Array.from(new Set(known)).sort((a, b) => a.localeCompare(b));
  return {
    perServer,
    distinct,
    allMatch: distinct.length <= 1,
    hasUnknown: known.length < perServer.length,
  };
}

// --- Model assembly --------------------------------------------------------------------------

/**
 * Build the complete {@link McpCompareModel} from the compared servers, in the given column order.
 * Assembles the six aligned metric sections (surface / quality / safety / coverage / latency /
 * trust), the tool-overlap view, and the protocol cross-check. Safe on any input length — the panel
 * enforces the 2–3 selection, and each section degrades gracefully for a server missing trust,
 * reliability, or items.
 */
export function mcpCompareModel(servers: McpCompareServer[]): McpCompareModel {
  const counts = servers.map((s) => mcpCompareSurfaceCounts(s.items));
  return {
    servers,
    sections: [
      surfaceSection(counts),
      qualitySection(servers),
      safetySection(servers),
      coverageSection(servers),
      latencySection(servers),
      trustSection(servers),
    ],
    overlap: mcpToolOverlap(servers),
    protocol: mcpCompareProtocolVersions(servers),
  };
}

// --- Screen copy and limits (HIVE-7.9, #5326) ------------------------------------------------
// The strings and the two bounds `docs/mockups/sources/mcp-compare.html` fixes, kept here rather
// than in the page so the picker, the panel and their suites read one definition of each.

/** How many servers may be compared at once — the roadmap's 2–3, and the picker's cap. */
export const MCP_COMPARE_MAX_SELECTION = 3;

/** How few make a comparison. Below this the panel renders its "pick two or three" state. */
export const MCP_COMPARE_MIN_SELECTION = 2;

/** The page's `h1`. */
export const MCP_COMPARE_TITLE = 'Server comparison';

/** The one line under it — DESIGN.md §5.3 asks for fourteen words or fewer. */
export const MCP_COMPARE_DESCRIPTION =
  'Pick 2–3 discovered servers and compare surface, quality, safety, docs, latency and trust.';

/** The picker card's heading. */
export const MCP_COMPARE_PICKER_TITLE = 'Choose servers to compare';

/**
 * The picker's footer note.
 *
 * It states both rules at once, because both surprise a reader who meets only one: two is the
 * floor, and an endpoint that has never been discovered has no surface to align so it is not in
 * the list at all.
 */
export const MCP_COMPARE_PICKER_HINT =
  'Select at least two servers. Only servers with a current version are listed.';

/** What a picker row's `title` says when the cap has been reached. */
export const MCP_COMPARE_AT_CAP_HINT = `Up to ${MCP_COMPARE_MAX_SELECTION} servers`;

/** The picker's own empty state — the catalog holds nothing that can be compared. */
export const MCP_COMPARE_PICKER_EMPTY_TITLE = 'No discovered MCP servers to compare yet';

/** Its body copy. */
export const MCP_COMPARE_PICKER_EMPTY_DESC =
  'Register and discover servers in the catalog first — a server with no current version has no surface to align.';

/** Shown while the catalog behind the picker is in flight. */
export const MCP_COMPARE_CATALOG_LOADING = 'Loading the MCP catalog…';

/** The catalog read's error heading. */
export const MCP_COMPARE_CATALOG_ERROR_TITLE = 'Could not load the MCP catalog';

/** Used when that read carries no message of its own. */
export const MCP_COMPARE_CATALOG_ERROR_FALLBACK = 'Could not load the MCP catalog.';

/** Shown while the three per-endpoint reads behind a comparison are in flight. */
export const MCP_COMPARE_RUNNING = 'Comparing servers…';

/** The comparison's error heading. */
export const MCP_COMPARE_ERROR_TITLE = 'Comparison unavailable';

/** Used when a failed comparison carries no message of its own. */
export const MCP_COMPARE_ERROR_FALLBACK = 'Could not compare the selected servers.';

/** The state before a comparison has been run with enough servers selected. */
export const MCP_COMPARE_PROMPT_TITLE = 'Select two or three servers to compare';

/** Its body copy. */
export const MCP_COMPARE_PROMPT_DESC =
  'Tick servers in the picker, then run Compare to see surface counts, grade, safety, documentation, latency and trust side by side.';

/** Shown in place of the screen when the session has no workspace to read a catalog for. */
export const MCP_COMPARE_NO_TENANT = 'Switch to a workspace to compare the MCP servers in it.';

/** The overlap card's heading. */
export const MCP_COMPARE_OVERLAP_TITLE = 'Capability overlap';

/** What the overlap card says when the servers have no tool name in common. */
export const MCP_COMPARE_NO_SHARED = 'No tools are shared between these servers.';

/** What a "Unique to …" card says when every one of its tools is shared. */
export const MCP_COMPARE_NO_UNIQUE = 'No unique tools.';

/**
 * The sentence under the metric table.
 *
 * It states the two conventions a reader would otherwise have to infer from the tint and the
 * dashes — which is the ticket's "highlights only genuinely differing rows" criterion said in
 * words, so the highlight is never the only way to learn what it means.
 */
export const MCP_COMPARE_TABLE_FOOT =
  'Rows whose cells differ are tinted · “—” marks a figure this server has not recorded';

/**
 * The protocol banner's headline when the servers negotiated different revisions.
 *
 * The versions themselves are appended by the panel, which has them.
 */
export const MCP_COMPARE_PROTOCOL_DIFFER_TITLE = 'Protocol versions differ.';

/** The quieter note when the versions agree but at least one server never reported one. */
export const MCP_COMPARE_PROTOCOL_UNKNOWN = 'At least one server’s MCP protocol version is unknown.';

/**
 * How the picker labels one row's second line.
 *
 * @param host The host serving the endpoint.
 * @param toolCount How many tools its current snapshot exposes.
 * @returns `"mcp.acme.dev · 12 tools"`.
 */
export function mcpCompareEndpointSubtitle(host: string, toolCount: number): string {
  return `${host} · ${toolCount} tool${toolCount === 1 ? '' : 's'}`;
}

/**
 * The one-sentence summary above the shared-tool matrix.
 *
 * @param overlap The overlap projection.
 * @returns `"31 distinct tools across these servers — 1 shared by all, 3 shared by two or more."`
 */
export function mcpCompareOverlapSummary(overlap: McpToolOverlap): string {
  const distinct = `${overlap.totalDistinct} distinct tool${overlap.totalDistinct === 1 ? '' : 's'}`;
  return `${distinct} across these servers — ${overlap.sharedByAllCount} shared by all, ${overlap.shared.length} shared by two or more.`;
}
