/**
 * Destination-aware projection view model + deterministic graph layout (EFP-2.2, #4814).
 *
 * The quick-export Fidelity step and the Export Studio Verify fidelity lens render a
 * **projection map**: a deterministic SVG graph of where each source construct lands in the
 * chosen destination, alongside a synchronized, fully accessible table. Both surfaces render
 * from the **one** view model this module builds from the server's projection evidence
 * (EFP-2.1, `./projectionEvidence.ts`) — so the graph and the table cannot disagree about
 * counts, statuses, or evidence rows; they are two projections of the same array.
 *
 * Responsibilities, all pure (no React, no fetch, no randomness) so they unit-test directly —
 * mirroring `./exportFidelityPreview.ts` / `./projectionEvidence.ts`:
 *
 * - `sanitizeProjectionLabel` — defence-in-depth for untrusted source labels: strips control
 *   and bidi-override characters, collapses whitespace, and caps length before a label is
 *   placed into SVG text, an aria-label, or a table cell. Labels are only ever rendered as
 *   React **text** nodes (never `dangerouslySetInnerHTML`, never interpolated into Mermaid
 *   or raw SVG markup), so this guard is belt-and-braces, not the only line of defence.
 * - `buildEvidenceRows` — joins outcome (`projects`) edges to their canonical, native
 *   (via `derives` provenance edges), and target nodes into flat evidence rows.
 * - `buildProjectionView` — orders rows deterministically into the destination lanes
 *   (target / omitted / unavailable) and applies the documented large-manifest aggregation
 *   that NEVER hides dropped, unavailable, or critical evidence (EFP-2.2 acceptance).
 * - `projectionGraphLayout` — deterministic column/lane geometry for the SVG renderer; no
 *   client-side layout engine, so the same evidence always draws the same picture.
 * - `statusPresentation` — text label + symbol + stroke pattern + palette per status, so
 *   colour is always supplemental to a textual/symbolic/pattern channel.
 * - `selectDrawnGraphEntries` / `buildProjectionTableRows` — the draw budget and the
 *   table flattening every projection surface bounds itself with (IXH-3.6), generic over
 *   the lane set so the import map (IXH-3.3) and the export mapping graph (IXH-4.2)
 *   share them rather than re-deriving "which entries are safe to leave undrawn".
 *
 * Keep the status vocabulary in sync with `./projectionEvidence.ts` and
 * `apiome-rest/src/app/projection_taxonomy.py`.
 */

import type { LossinessSeverity, ProjectionStatus } from './exportFidelityPreview';
import type {
  ProjectionEdge,
  ProjectionNode,
} from './projectionEvidence';

// ---------------------------------------------------------------------------
// Label sanitisation
// ---------------------------------------------------------------------------

/** Longest label rendered anywhere in the projection map (SVG text, aria, table cells). */
export const MAX_PROJECTION_LABEL_LENGTH = 80;

/** Placeholder rendered for a node/construct the server sent without a usable label. */
export const UNNAMED_LABEL = '(unnamed)';

/**
 * Unicode bidi-control and directional-override code points. Stripped so an imported label
 * cannot reorder the text around it (e.g. disguise `dropped` as `retained` in an aria string).
 */
const BIDI_CONTROL = new Set([
  0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068,
  0x2069,
]);

/**
 * Strip C0/C1 control characters and Unicode bidi overrides from untrusted text, collapse
 * all whitespace runs to single spaces, and trim. The shared core of every evidence-text
 * sanitizer (labels here, drawer prose in `./lossExplanation.ts`); callers apply their own
 * length cap and empty-result fallback. Markup characters are deliberately **kept** — the
 * text is only ever rendered as React text nodes, where `<script>` is inert; rewriting it
 * would misreport the user's own names.
 *
 * @param raw The text as received from the server.
 * @returns The cleaned, whitespace-collapsed text (possibly empty).
 */
export function stripControlAndBidi(raw: string): string {
  let cleaned = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) as number;
    // Whitespace controls (tab/newline/…) survive to the collapse below as separators.
    if (/\s/.test(ch)) {
      cleaned += ' ';
      continue;
    }
    const isControl = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    if (isControl || BIDI_CONTROL.has(code)) continue;
    cleaned += ch;
  }
  return cleaned.replace(/\s+/g, ' ').trim();
}

/**
 * Sanitize an untrusted source label for display.
 *
 * {@link stripControlAndBidi}, then truncation to {@link MAX_PROJECTION_LABEL_LENGTH} with
 * an ellipsis.
 *
 * @param raw The label as received from the server (may be null/empty).
 * @returns A display-safe label, or {@link UNNAMED_LABEL} when nothing survives.
 */
export function sanitizeProjectionLabel(raw: string | null | undefined): string {
  if (raw == null) return UNNAMED_LABEL;
  const collapsed = stripControlAndBidi(raw);
  if (collapsed.length === 0) return UNNAMED_LABEL;
  if (collapsed.length <= MAX_PROJECTION_LABEL_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_PROJECTION_LABEL_LENGTH - 1)}…`;
}

// ---------------------------------------------------------------------------
// Status presentation — colour is always supplemental
// ---------------------------------------------------------------------------

/** One status's full presentation: text, symbol, and pattern channels + palette. */
export interface StatusPresentation {
  /** Human text label (e.g. `Dropped`) — the primary channel. */
  label: string;
  /** Compact color-independent symbol printed beside the label (e.g. `×`). */
  symbol: string;
  /** Tailwind classes for the status chip/badge. */
  badgeClass: string;
  /** Tailwind stroke class for the graph edge/outcome border. */
  strokeClass: string;
  /**
   * SVG `stroke-dasharray` for the outcome edge, or null for a solid line. A distinct dash
   * pattern per non-retained status keeps outcomes distinguishable without colour.
   */
  dashArray: string | null;
}

const STATUS_PRESENTATION: Record<ProjectionStatus, StatusPresentation> = {
  retained: {
    label: 'Retained',
    symbol: '✓',
    badgeClass: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
    strokeClass: 'stroke-emerald-500 dark:stroke-emerald-400',
    dashArray: null,
  },
  transformed: {
    label: 'Transformed',
    symbol: '⇄',
    badgeClass: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300',
    strokeClass: 'stroke-sky-500 dark:stroke-sky-400',
    dashArray: null,
  },
  approximated: {
    label: 'Approximated',
    symbol: '≈',
    badgeClass: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
    strokeClass: 'stroke-amber-500 dark:stroke-amber-400',
    dashArray: '6 3',
  },
  synthesized: {
    label: 'Synthesized',
    symbol: '＋',
    badgeClass: 'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300',
    strokeClass: 'stroke-violet-500 dark:stroke-violet-400',
    dashArray: '2 3',
  },
  dropped: {
    label: 'Dropped',
    symbol: '×',
    badgeClass: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300',
    strokeClass: 'stroke-rose-500 dark:stroke-rose-400',
    dashArray: '8 4',
  },
  unavailable: {
    label: 'Unavailable',
    symbol: '⊘',
    badgeClass: 'bg-slate-200 text-slate-800 dark:bg-slate-700/60 dark:text-slate-200',
    strokeClass: 'stroke-slate-400 dark:stroke-slate-500',
    dashArray: '2 6',
  },
  'not-applicable': {
    label: 'Not applicable',
    symbol: '—',
    badgeClass: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
    strokeClass: 'stroke-gray-400 dark:stroke-gray-500',
    dashArray: '1 4',
  },
};

/** The presentation (text/symbol/pattern/palette) for one projection status. */
export function statusPresentation(status: ProjectionStatus): StatusPresentation {
  return STATUS_PRESENTATION[status];
}

/** Worst-first severity rank (critical → warn → info), for deterministic ordering. */
const SEVERITY_RANK: Record<LossinessSeverity, number> = { critical: 0, warn: 1, info: 2 };

// ---------------------------------------------------------------------------
// Evidence rows — the flat join both the graph and the table render from
// ---------------------------------------------------------------------------

/** One outcome (projects) edge joined to its canonical/native/target nodes. */
export interface ProjectionEvidenceRow {
  /** The outcome edge's id — the stable row identity. */
  id: string;
  /** Sanitized display label of the canonical construct. */
  construct: string;
  /** The canonical construct key when the node carries one (unsanitised; used for sorting). */
  constructKey: string | null;
  /** Coarse canonical construct class (operation / channel / type / field), when present. */
  canonicalKind: string | null;
  /** The projection outcome. */
  status: ProjectionStatus;
  /** How much the outcome matters. */
  severity: LossinessSeverity;
  /** Cause category code for a non-preserved outcome, else null. */
  reason: string | null;
  /** One-line reason summary: the registry explanation when present, else the edge detail. */
  reasonSummary: string;
  /** Sanitized label of the destination node, when the construct landed. */
  targetLabel: string | null;
  /** Where the construct landed (JSON Pointer, else target-native path), when it landed. */
  targetLocation: string | null;
  /** Sanitized source-native name, when captured (may be the `[redacted]` placeholder). */
  sourceLabel: string | null;
  /** Sanitized source location, when captured (may be the `[redacted]` placeholder). */
  sourceLocation: string | null;
  /** The full outcome edge, for the selection-to-evidence detail card. */
  edge: ProjectionEdge;
}

/**
 * Join outcome edges to their nodes into flat evidence rows.
 *
 * For each `projects` edge: the edge's source node is the canonical construct and the
 * edge's target node (when present) is the destination construct. Source-native
 * provenance resolves two ways: a `derives` edge pointing at the canonical node (full
 * manifests), or — the evidence-page shape, which bundles the native node but pages only
 * outcome edges — a `native` node sharing the canonical node's `construct_key`. Edges
 * referencing nodes missing from the bundle are skipped — `evidencePageIssues` (EFP-2.1)
 * rejects such a page before this builder runs, so the skip is a final safety net.
 *
 * @param nodes Every node bundled with the loaded evidence pages.
 * @param edges Every edge from the loaded evidence pages (outcome edges; `derives` edges
 *   are honoured too when a caller has the full manifest).
 * @returns One row per resolvable outcome edge, in the server's order.
 */
export function buildEvidenceRows(
  nodes: ProjectionNode[],
  edges: ProjectionEdge[],
): ProjectionEvidenceRow[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  /** canonical node id → the first native node derived into it (canonical provenance order). */
  const nativeByCanonical = new Map<string, ProjectionNode>();
  for (const edge of edges) {
    if (edge.relation !== 'derives' || edge.target == null) continue;
    const native = nodeById.get(edge.source);
    if (native && !nativeByCanonical.has(edge.target)) {
      nativeByCanonical.set(edge.target, native);
    }
  }
  /** construct key → its native node, the evidence-page provenance channel. */
  const nativeByConstructKey = new Map<string, ProjectionNode>();
  for (const node of nodes) {
    if (node.kind === 'native' && node.construct_key != null && !nativeByConstructKey.has(node.construct_key)) {
      nativeByConstructKey.set(node.construct_key, node);
    }
  }

  const rows: ProjectionEvidenceRow[] = [];
  for (const edge of edges) {
    if (edge.relation !== 'projects') continue;
    const canonical = nodeById.get(edge.source);
    if (!canonical) continue;
    const target = edge.target != null ? (nodeById.get(edge.target) ?? null) : null;
    const native =
      nativeByCanonical.get(canonical.id) ??
      (canonical.construct_key != null
        ? (nativeByConstructKey.get(canonical.construct_key) ?? null)
        : null);
    rows.push({
      id: edge.id,
      construct: sanitizeProjectionLabel(canonical.label),
      constructKey: canonical.construct_key ?? null,
      canonicalKind: canonical.canonical_kind ?? null,
      status: edge.status,
      severity: edge.severity,
      reason: edge.reason ?? null,
      reasonSummary: sanitizeProjectionLabel(edge.explanation ?? edge.detail),
      targetLabel: target ? sanitizeProjectionLabel(target.label) : null,
      targetLocation:
        target?.target?.json_pointer ??
        target?.target?.native_path ??
        edge.target_mapping ??
        null,
      sourceLabel: native?.native?.native_name
        ? sanitizeProjectionLabel(native.native.native_name)
        : native
          ? sanitizeProjectionLabel(native.label)
          : null,
      sourceLocation: native?.native?.source_location
        ? sanitizeProjectionLabel(native.native.source_location)
        : null,
      edge,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Lanes + deterministic ordering + aggregation
// ---------------------------------------------------------------------------

/** The destination-side lane a row lands in (the export surfaces' default lane set). */
export type ProjectionLaneKey = 'target' | 'omitted' | 'unavailable';

/**
 * One lane of the graph/table: a stable key plus its user-facing heading. The lane set is
 * a parameter of the view/layout builders (IXH-3.3 shares them with the import projection
 * map, which lanes by source construct family instead of destination outcome); the export
 * surfaces pass nothing and get {@link PROJECTION_LANES}.
 */
export interface ProjectionLane<LaneKey extends string = ProjectionLaneKey> {
  key: LaneKey;
  label: string;
}

/** The destination lanes, in render order, with their user-facing headings. */
export const PROJECTION_LANES: readonly ProjectionLane[] = [
  { key: 'target', label: 'In the destination' },
  { key: 'omitted', label: 'Omitted from the destination' },
  { key: 'unavailable', label: 'Unavailable' },
];

/**
 * Which destination lane a status belongs to: everything that lands in the artifact
 * (retained / transformed / approximated / synthesized) is `target`; `dropped` is
 * `omitted`; `unavailable` and `not-applicable` (nothing existed to land) are `unavailable`.
 */
export function laneForStatus(status: ProjectionStatus): ProjectionLaneKey {
  switch (status) {
    case 'dropped':
      return 'omitted';
    case 'unavailable':
    case 'not-applicable':
      return 'unavailable';
    default:
      return 'target';
  }
}

/**
 * Evidence-row count above which the view aggregates (the documented large-manifest
 * threshold — EFP-3.2 initial-render budget). Chosen so a typical mid-size API renders
 * fully and a thousand-construct manifesto stays readable; the panel states the rule
 * whenever it aggregates. Soft CI budget for {@link buildProjectionView} over a large
 * fixture: {@link BUILD_PROJECTION_VIEW_SOFT_BUDGET_MS}.
 */
export const GRAPH_AGGREGATION_THRESHOLD = 48;

/** Soft wall-clock budget (ms) for `buildProjectionView` over a large fixture (EFP-3.2 CI). */
export const BUILD_PROJECTION_VIEW_SOFT_BUDGET_MS = 1000;

/**
 * Statuses eligible for aggregation. Dropped and unavailable evidence is NEVER aggregated
 * (EFP-2.2 acceptance: aggregation must not hide dropped or critical evidence — and an
 * unavailable outcome is exactly the truth-telling this surface exists for), and
 * approximated/synthesized rows stay individual because relating losses to one another is
 * the point of the map. Only clean outcomes collapse.
 */
const AGGREGATABLE_STATUSES: ReadonlySet<ProjectionStatus> = new Set([
  'retained',
  'transformed',
  'not-applicable',
]);

/** One entry of the shared view: an individual evidence row or a deterministic aggregate. */
export interface ProjectionViewEntry<LaneKey extends string = ProjectionLaneKey> {
  /** Stable entry key: the row id; `aggregate:<status>` for a default-lane aggregate, or
   *  `aggregate:<lane>:<status>` when a custom lane set is in play. */
  key: string;
  kind: 'row' | 'aggregate';
  status: ProjectionStatus;
  /** Worst member severity for an aggregate; the row's own severity otherwise. */
  severity: LossinessSeverity;
  /** The lane the entry renders in. */
  lane: LaneKey;
  /** Display label: the construct label, or `N constructs` for an aggregate. */
  label: string;
  /** The underlying row (kind `row` only). */
  row?: ProjectionEvidenceRow;
  /** Every member row, deterministically ordered (kind `aggregate` only). */
  members?: ProjectionEvidenceRow[];
}

/** The shared view model both the SVG graph and the accessible table render from. */
export interface ProjectionView<LaneKey extends string = ProjectionLaneKey> {
  /** The entries, in final render order (lane order, then worst-first within a lane). */
  entries: ProjectionViewEntry<LaneKey>[];
  /** True when at least one aggregate entry was formed. */
  aggregated: boolean;
  /** Total individual evidence rows represented (aggregate members included). */
  rowCount: number;
}

/** Options for {@link buildProjectionView}; the lane set/assignment defaults to export's. */
export interface BuildProjectionViewOptions<LaneKey extends string = ProjectionLaneKey> {
  /** Row count above which aggregation applies (default {@link GRAPH_AGGREGATION_THRESHOLD}). */
  aggregationThreshold?: number;
  /** The lane set, in render order (default {@link PROJECTION_LANES}). */
  lanes?: readonly ProjectionLane<LaneKey>[];
  /** Which lane a row belongs to (default {@link laneForStatus} on the row's status). */
  laneOf?: (row: ProjectionEvidenceRow) => LaneKey;
}

/** Deterministic row order: severity (worst first), then construct label, then row id. */
function compareRows(a: ProjectionEvidenceRow, b: ProjectionEvidenceRow): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    a.construct.localeCompare(b.construct) ||
    a.id.localeCompare(b.id)
  );
}

/**
 * Build the shared view model: deterministic lane grouping + documented aggregation.
 *
 * Rows are grouped into the destination lanes and ordered worst-first within each lane.
 * When the row count exceeds `aggregationThreshold`, rows whose status is aggregatable
 * ({@link AGGREGATABLE_STATUSES}) **and** whose severity is `info` collapse into one
 * aggregate entry per status, keeping their members (deterministically ordered) for
 * detail-on-demand. Everything else — every dropped, unavailable, approximated,
 * synthesized, warn, or critical row — always stays an individual entry.
 *
 * The same input always yields the same output (no randomness, total ordering), so the
 * graph is reproducible across sessions and screenshots.
 *
 * @param rows The evidence rows from {@link buildEvidenceRows} (or another builder that
 *   produces the same row shape, e.g. the import projection map's).
 * @param options Threshold and, for non-export surfaces, the lane set/assignment
 *   ({@link BuildProjectionViewOptions}); tests pass a small threshold.
 * @returns The ordered entries plus aggregation metadata.
 */
export function buildProjectionView<LaneKey extends string = ProjectionLaneKey>(
  rows: ProjectionEvidenceRow[],
  options?: BuildProjectionViewOptions<LaneKey>,
): ProjectionView<LaneKey> {
  const threshold = options?.aggregationThreshold ?? GRAPH_AGGREGATION_THRESHOLD;
  // With the default lane set, a status maps to exactly one lane, so the historical
  // `aggregate:<status>` keys stay stable; custom lanes qualify the key by lane instead.
  const customLanes = options?.lanes != null || options?.laneOf != null;
  const lanes = (options?.lanes ?? PROJECTION_LANES) as readonly ProjectionLane<LaneKey>[];
  const laneOf =
    options?.laneOf ?? ((row: ProjectionEvidenceRow) => laneForStatus(row.status) as LaneKey);
  const shouldAggregate = rows.length > threshold;

  const individual: ProjectionEvidenceRow[] = [];
  /** `<lane> <status>` → member rows; per-lane buckets so an aggregate stays in its lane. */
  const aggregates = new Map<string, { lane: LaneKey; status: ProjectionStatus; members: ProjectionEvidenceRow[] }>();
  for (const row of rows) {
    if (shouldAggregate && AGGREGATABLE_STATUSES.has(row.status) && row.severity === 'info') {
      const lane = laneOf(row);
      const bucketKey = `${lane} ${row.status}`;
      const bucket = aggregates.get(bucketKey) ?? { lane, status: row.status, members: [] };
      bucket.members.push(row);
      aggregates.set(bucketKey, bucket);
    } else {
      individual.push(row);
    }
  }

  const entries: ProjectionViewEntry<LaneKey>[] = individual.map((row) => ({
    key: row.id,
    kind: 'row',
    status: row.status,
    severity: row.severity,
    lane: laneOf(row),
    label: row.construct,
    row,
  }));
  for (const { lane, status, members } of aggregates.values()) {
    members.sort(compareRows);
    entries.push({
      key: customLanes ? `aggregate:${lane}:${status}` : `aggregate:${status}`,
      kind: 'aggregate',
      status,
      severity: 'info',
      lane,
      label: `${members.length} construct${members.length === 1 ? '' : 's'}`,
      members,
    });
  }

  const laneRank = new Map(lanes.map((lane, index) => [lane.key, index]));
  entries.sort((a, b) => {
    const byLane = (laneRank.get(a.lane) ?? 0) - (laneRank.get(b.lane) ?? 0);
    if (byLane !== 0) return byLane;
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;
    // Aggregates read after the individual rows of their lane; then stable label/key order.
    const byKind = (a.kind === 'aggregate' ? 1 : 0) - (b.kind === 'aggregate' ? 1 : 0);
    if (byKind !== 0) return byKind;
    return a.label.localeCompare(b.label) || a.key.localeCompare(b.key);
  });

  return { entries, aggregated: aggregates.size > 0, rowCount: rows.length };
}

/**
 * Count represented evidence rows per status in a view (aggregate members included).
 * The graph header, the table caption, and the tests all use this one counter — which is
 * what guarantees the two surfaces expose identical counts.
 */
export function viewStatusCounts(
  entries: ProjectionViewEntry<string>[],
): Partial<Record<ProjectionStatus, number>> {
  const counts: Partial<Record<ProjectionStatus, number>> = {};
  for (const entry of entries) {
    const size = entry.kind === 'aggregate' ? (entry.members?.length ?? 0) : 1;
    counts[entry.status] = (counts[entry.status] ?? 0) + size;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Accessible naming
// ---------------------------------------------------------------------------

/**
 * The screen-reader label for one view entry — used verbatim by the graph node's
 * `aria-label` and assembled from the same fields the table row prints, so the two
 * surfaces *say* the same thing too (EFP-2.2 acceptance: source construct, result status,
 * target location when present, reason summary).
 */
export function entryAriaLabel(entry: ProjectionViewEntry<string>): string {
  const status = statusPresentation(entry.status);
  if (entry.kind === 'aggregate') {
    const count = entry.members?.length ?? 0;
    return `${count} construct${count === 1 ? '' : 's'} ${status.label.toLowerCase()}, aggregated. Select to list them.`;
  }
  const row = entry.row as ProjectionEvidenceRow;
  const parts = [`${row.construct} — ${status.label.toLowerCase()}`];
  if (row.sourceLabel && row.sourceLabel !== row.construct) {
    parts.push(`from source ${row.sourceLabel}`);
  }
  if (row.targetLocation) {
    parts.push(`lands at ${row.targetLocation}`);
  } else if (row.targetLabel) {
    parts.push(`lands in ${row.targetLabel}`);
  } else {
    parts.push('no destination location');
  }
  if (row.severity !== 'info') parts.push(`severity ${row.severity}`);
  parts.push(row.reasonSummary);
  return `${parts.join('; ')}.`;
}

// ---------------------------------------------------------------------------
// Deterministic SVG layout
// ---------------------------------------------------------------------------

/** Fixed geometry constants (SVG user units). Exported for the renderer and its tests. */
export const GRAPH_GEOMETRY = {
  /** Width of each of the three columns (source, canonical, destination). */
  columnWidth: 200,
  /** Horizontal gap between columns (the edge-drawing corridor). */
  columnGap: 64,
  /** Vertical rhythm per entry band. */
  rowHeight: 40,
  /** Height of one node box. */
  nodeHeight: 30,
  /** Height reserved for each lane's heading. */
  laneHeaderHeight: 24,
  /** Vertical gap between lanes. */
  laneGap: 12,
  /** Outer padding. */
  padding: 12,
} as const;

/** One node box's placed rectangle. */
export interface PlacedBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One entry's placed band: its boxes plus the connector geometry between them. */
export interface PlacedEntry<LaneKey extends string = ProjectionLaneKey> {
  entry: ProjectionViewEntry<LaneKey>;
  /** The source/native column box; null when the row has no captured native provenance. */
  sourceBox: PlacedBox | null;
  /** The canonical column box (always present). */
  canonicalBox: PlacedBox;
  /** The destination column box (always present — omitted/unavailable lanes still show the outcome). */
  outcomeBox: PlacedBox;
}

/** One lane's placed band. */
export interface PlacedLane<LaneKey extends string = ProjectionLaneKey> {
  key: LaneKey;
  label: string;
  /** Lane heading baseline y. */
  headerY: number;
  /** Vertical extent of the lane's entries. */
  top: number;
  bottom: number;
  /** Number of entries in the lane. */
  count: number;
}

/** The full deterministic layout the SVG renderer draws verbatim. */
export interface ProjectionGraphLayout<LaneKey extends string = ProjectionLaneKey> {
  width: number;
  height: number;
  /** x of each column's left edge. */
  columns: { source: number; canonical: number; outcome: number };
  entries: PlacedEntry<LaneKey>[];
  lanes: PlacedLane<LaneKey>[];
}

/**
 * Compute the deterministic three-column layout for a view.
 *
 * Columns: source/native → canonical → outcome; the outcome column is banded into the
 * given lanes (default: the destination lanes, {@link PROJECTION_LANES}), each with a
 * heading. Entries keep the view order. Pure geometry over the entry list — same entries,
 * same picture, every time.
 *
 * @param entries The ordered entries from {@link buildProjectionView}.
 * @param lanes The lane set the entries were built against (default {@link PROJECTION_LANES}).
 * @returns Placed boxes, lane bands, and the overall canvas size.
 */
export function projectionGraphLayout<LaneKey extends string = ProjectionLaneKey>(
  entries: ProjectionViewEntry<LaneKey>[],
  lanes: readonly ProjectionLane<LaneKey>[] = PROJECTION_LANES as readonly ProjectionLane<LaneKey>[],
): ProjectionGraphLayout<LaneKey> {
  const g = GRAPH_GEOMETRY;
  const columns = {
    source: g.padding,
    canonical: g.padding + g.columnWidth + g.columnGap,
    outcome: g.padding + 2 * (g.columnWidth + g.columnGap),
  };
  const width = columns.outcome + g.columnWidth + g.padding;

  const placed: PlacedEntry<LaneKey>[] = [];
  const placedLanes: PlacedLane<LaneKey>[] = [];
  let y = g.padding;
  for (const lane of lanes) {
    const laneEntries = entries.filter((entry) => entry.lane === lane.key);
    if (laneEntries.length === 0) continue;
    const headerY = y + g.laneHeaderHeight - 8;
    y += g.laneHeaderHeight;
    const top = y;
    for (const entry of laneEntries) {
      const boxY = y + (g.rowHeight - g.nodeHeight) / 2;
      const hasSource = entry.kind === 'row' && Boolean(entry.row?.sourceLabel);
      placed.push({
        entry,
        sourceBox: hasSource
          ? { x: columns.source, y: boxY, width: g.columnWidth, height: g.nodeHeight }
          : null,
        canonicalBox: { x: columns.canonical, y: boxY, width: g.columnWidth, height: g.nodeHeight },
        outcomeBox: { x: columns.outcome, y: boxY, width: g.columnWidth, height: g.nodeHeight },
      });
      y += g.rowHeight;
    }
    placedLanes.push({ key: lane.key, label: lane.label, headerY, top, bottom: y, count: laneEntries.length });
    y += g.laneGap;
  }
  const height = Math.max(y - g.laneGap + g.padding, g.padding * 2 + g.rowHeight);

  return { width, height, columns, entries: placed, lanes: placedLanes };
}

// ---------------------------------------------------------------------------
// Draw budget + table flattening (IXH-3.6, #5108; shared with IXH-4.2)
// ---------------------------------------------------------------------------

/**
 * How lossy a status is, for the draw-budget selection: statuses that mean "something was
 * lost" rank before clean outcomes, so capping the drawn graph can only ever remove clean
 * evidence — a dropped construct is never what the cap hides.
 */
const STATUS_DRAW_PRIORITY: Record<ProjectionStatus, number> = {
  dropped: 0,
  unavailable: 1,
  approximated: 2,
  synthesized: 3,
  transformed: 4,
  'not-applicable': 5,
  retained: 6,
};

/** The draw-budget selection: which entries the SVG draws, and what that leaves out. */
export interface DrawnGraphSelection<LaneKey extends string> {
  /** The entries to draw, in the view's original order (lane grouping preserved). */
  drawn: ProjectionViewEntry<LaneKey>[];
  /** True when the budget removed at least one entry. */
  truncated: boolean;
  /** Evidence rows represented by the drawn entries (aggregate members included). */
  drawnRowCount: number;
  /** Evidence rows represented by the full view. */
  totalRowCount: number;
}

/** Evidence rows an entry represents: 1 for a row, member count for an aggregate. */
function entryRowCount(entry: ProjectionViewEntry<string>): number {
  return entry.kind === 'aggregate' ? (entry.members?.length ?? 0) : 1;
}

/**
 * Select the view entries the SVG graph draws, bounded by the draw budget
 * (`GRAPH_DRAW_BUDGET` via `preview-budgets.ts`; tests pass a small value).
 *
 * Selection is **worst-first**: aggregates always draw (each is one box standing for many
 * clean rows — dropping one would hide the most information per node), then rows ordered
 * by severity (critical → warn → info), then by how lossy the status is
 * ({@link STATUS_DRAW_PRIORITY}), then by view position. The survivors keep the view's
 * original order so the lane layout is unchanged — the cap thins lanes from their cleanest
 * tail, it never reorders them.
 *
 * @param entries The ordered entries from {@link buildProjectionView}.
 * @param budget Maximum entries to draw (non-positive draws only the always-kept aggregates).
 * @returns The drawn subset plus the represented-row counts for the truncation statement.
 */
export function selectDrawnGraphEntries<LaneKey extends string>(
  entries: ProjectionViewEntry<LaneKey>[],
  budget: number,
): DrawnGraphSelection<LaneKey> {
  const totalRowCount = entries.reduce((sum, entry) => sum + entryRowCount(entry), 0);
  if (entries.length <= budget) {
    return { drawn: entries, truncated: false, drawnRowCount: totalRowCount, totalRowCount };
  }

  const ranked = entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      // Aggregates first (always kept), then worst-first, then stable view order.
      const byKind =
        (a.entry.kind === 'aggregate' ? 0 : 1) - (b.entry.kind === 'aggregate' ? 0 : 1);
      if (byKind !== 0) return byKind;
      const bySeverity = SEVERITY_RANK[a.entry.severity] - SEVERITY_RANK[b.entry.severity];
      if (bySeverity !== 0) return bySeverity;
      const byStatus = STATUS_DRAW_PRIORITY[a.entry.status] - STATUS_DRAW_PRIORITY[b.entry.status];
      if (byStatus !== 0) return byStatus;
      return a.index - b.index;
    });

  const aggregateCount = entries.filter((entry) => entry.kind === 'aggregate').length;
  const keep = Math.max(Math.max(0, budget), aggregateCount);
  const keptIndexes = new Set(ranked.slice(0, keep).map(({ index }) => index));
  const drawn = entries.filter((_, index) => keptIndexes.has(index));
  const drawnRowCount = drawn.reduce((sum, entry) => sum + entryRowCount(entry), 0);
  return { drawn, truncated: drawn.length < entries.length, drawnRowCount, totalRowCount };
}

/** One display row of the evidence table: a view entry, or one expanded aggregate member. */
export interface ProjectionTableRow<LaneKey extends string> {
  kind: 'entry' | 'member';
  /** The view entry (for a member row, the aggregate it belongs to). */
  entry: ProjectionViewEntry<LaneKey>;
  /** The member evidence row (kind `member` only). */
  member?: ProjectionEvidenceRow;
  /** Stable React key. */
  key: string;
  /** 1-based position within the table body → `aria-rowindex` (after the +1 header offset). */
  bodyRowIndex: number;
}

/**
 * Flatten the view entries plus the expanded aggregates into the display rows the
 * (windowed) evidence table renders — pure, so the windowing arithmetic and the
 * `aria-rowcount`/`aria-rowindex` bookkeeping unit-test without the DOM.
 *
 * @param entries The ordered entries from {@link buildProjectionView}.
 * @param expandedAggregates Keys of aggregate entries whose members render in place.
 * @returns One row per entry, with each expanded aggregate's members following it.
 */
export function buildProjectionTableRows<LaneKey extends string>(
  entries: ProjectionViewEntry<LaneKey>[],
  expandedAggregates: ReadonlySet<string>,
): ProjectionTableRow<LaneKey>[] {
  const rows: ProjectionTableRow<LaneKey>[] = [];
  for (const entry of entries) {
    rows.push({ kind: 'entry', entry, key: entry.key, bodyRowIndex: rows.length + 1 });
    if (entry.kind === 'aggregate' && expandedAggregates.has(entry.key)) {
      for (const member of entry.members ?? []) {
        rows.push({
          kind: 'member',
          entry,
          member,
          key: `${entry.key}:${member.id}`,
          bodyRowIndex: rows.length + 1,
        });
      }
    }
  }
  return rows;
}
