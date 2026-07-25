/**
 * Import projection view model — source → catalog, family-laned (IXH-3.3, #5105).
 *
 * The quality step's preview panel renders the IXH-3.1 manifest's coverage ledger as a
 * **projection map**: what each source construct lost or kept on its way *into* the
 * canonical model, alongside a synchronized accessible table. The graph primitives are
 * **shared with the export projection map** (EFP-2.2, `../export/projectionGraph.ts`):
 * the sanitizer, the status presentation (text label + symbol + stroke pattern, colour
 * always supplemental), the aggregating view builder, and the deterministic layout are
 * imported — not duplicated — per the IXH-3.3 acceptance criterion, and re-exported here
 * so the sharing is a testable identity.
 *
 * What differs from export, and therefore lives here:
 *
 *  - **Edge orientation.** Import outcome (`projects`) edges run **native → canonical**
 *    (the canonical model *is* the import's destination), where export's run
 *    canonical → target. Export's `buildEvidenceRows` would mis-read the native node as
 *    the canonical construct, so {@link buildImportEvidenceRows} does the import join.
 *  - **Lanes are source construct families** (Services / Operations / Channels / Types /
 *    Document-level / Adapter limits), not destination outcomes — the generalized lane
 *    parameters of `buildProjectionView` / `projectionGraphLayout` carry this.
 *  - **Adapter parser limits are ledger-only** server-side (declared limits, no graph
 *    nodes — the graph states only document facts), so this module synthesizes one row
 *    per `not-parsed-by-adapter` ledger entry; hiding them would conflate "nothing was
 *    lost" with "losses were not drawn".
 *
 * Everything here is pure (no React, no fetch, no randomness) so it unit-tests directly.
 */

import type { ProjectionStatus } from '../export/exportFidelityPreview';
import type { ProjectionEdge, ProjectionNode } from '../export/projectionEvidence';
import {
  buildProjectionView,
  sanitizeProjectionLabel,
  statusPresentation,
  viewStatusCounts,
  type ProjectionEvidenceRow,
  type ProjectionLane,
  type ProjectionView,
  type ProjectionViewEntry,
} from '../export/projectionGraph';
import type {
  ImportPreviewCoverageEntry,
  PreviewCoverageClass,
} from '@/app/utils/import-preview-manifest';

// The shared primitives, re-exported so consumers (and the sharing-assertion test) reach
// them through this module while the objects stay the export module's own.
export { projectionGraphLayout, sanitizeProjectionLabel, statusPresentation, viewStatusCounts } from '../export/projectionGraph';
export type { ProjectionEvidenceRow, ProjectionView, ProjectionViewEntry } from '../export/projectionGraph';

/** The source construct families the import map lanes by. */
export type ImportFamilyKey =
  | 'services'
  | 'operations'
  | 'channels'
  | 'types'
  | 'document'
  | 'adapter';

/** The family lanes, in render order, with their user-facing headings. */
export const IMPORT_FAMILY_LANES: readonly ProjectionLane<ImportFamilyKey>[] = [
  { key: 'services', label: 'Services' },
  { key: 'operations', label: 'Operations' },
  { key: 'channels', label: 'Channels' },
  { key: 'types', label: 'Types' },
  { key: 'document', label: 'Document-level' },
  { key: 'adapter', label: 'Adapter limits' },
];

/** An evidence row plus the import-side facts the evidence card needs. */
export interface ImportEvidenceRow extends ProjectionEvidenceRow {
  /** The row's coverage class (from the joined ledger entry, else derived from the edge). */
  coverage: PreviewCoverageClass;
  /** The joined coverage-ledger entry, when one matches the row's construct. */
  ledger: ImportPreviewCoverageEntry | null;
  /** True for a row synthesized from an adapter-declared parser limit (ledger-only). */
  adapterDeclared: boolean;
}

/**
 * The coverage class an outcome implies — the inverse of the server's
 * `STATUS_FOR_COVERAGE` bijection (`import_preview_manifest.py`), used when a graph edge
 * has no joinable ledger entry.
 */
export function coverageForOutcome(
  status: ProjectionStatus,
  reason: string | null,
): PreviewCoverageClass {
  if (status === 'approximated') return 'partially-mapped';
  if (status === 'dropped') {
    return reason === 'source_parse_limit' ? 'not-parsed-by-adapter' : 'unsupported-by-canonical-model';
  }
  return 'mapped';
}

/** Which family lane a row belongs to. */
export function importFamilyForRow(row: ImportEvidenceRow): ImportFamilyKey {
  if (row.adapterDeclared) return 'adapter';
  switch (row.canonicalKind) {
    case 'service':
      return 'services';
    case 'operation':
      return 'operations';
    case 'channel':
      return 'channels';
    case 'type':
      return 'types';
    default:
      // No canonical side — a document-level fact (`document#…` constructs land here).
      return 'document';
  }
}

/**
 * Join the import manifest's graph and ledger into flat evidence rows.
 *
 * For each `projects` edge: the edge's **source** node is the native (source-document)
 * construct and its **target** node, when present, is the canonical entity — a dropped
 * document-level construct has `target: null` and keeps only its native side. The
 * matching ledger entry (by the construct key) contributes the coverage class and the
 * capability reference. One extra row is then synthesized per `not-parsed-by-adapter`
 * ledger entry, which the server deliberately keeps out of the graph (adapter-declared
 * limits are not document facts) but this surface must still state.
 *
 * Rows come back sorted by id, so any input permutation yields the same rows.
 *
 * @param nodes The manifest page's nodes (accumulated across loaded pages).
 * @param edges The manifest page's edges (accumulated across loaded pages).
 * @param coverage The manifest page's coverage-ledger rows (accumulated).
 * @returns One row per outcome edge plus one per adapter-declared limit.
 */
export function buildImportEvidenceRows(
  nodes: ProjectionNode[],
  edges: ProjectionEdge[],
  coverage: ImportPreviewCoverageEntry[],
): ImportEvidenceRow[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const ledgerByConstruct = new Map<string, ImportPreviewCoverageEntry>();
  for (const entry of coverage) {
    const key = entry.entity_key ?? entry.source_construct;
    if (key && !ledgerByConstruct.has(key)) ledgerByConstruct.set(key, entry);
  }

  const rows: ImportEvidenceRow[] = [];
  for (const edge of edges) {
    if (edge.relation !== 'projects') continue;
    const native = nodeById.get(edge.source);
    if (!native) continue;
    const canonical = edge.target != null ? (nodeById.get(edge.target) ?? null) : null;
    const constructKey = canonical?.construct_key ?? native.construct_key ?? null;
    const ledger = constructKey != null ? (ledgerByConstruct.get(constructKey) ?? null) : null;
    rows.push({
      id: edge.id,
      construct: sanitizeProjectionLabel(canonical?.label ?? native.label),
      constructKey,
      canonicalKind: canonical?.canonical_kind ?? null,
      status: edge.status,
      severity: edge.severity,
      reason: edge.reason ?? null,
      reasonSummary: sanitizeProjectionLabel(edge.explanation ?? edge.detail),
      targetLabel: null,
      targetLocation: null,
      sourceLabel: native.native?.native_name
        ? sanitizeProjectionLabel(native.native.native_name)
        : sanitizeProjectionLabel(native.label),
      sourceLocation: native.native?.source_location
        ? sanitizeProjectionLabel(native.native.source_location)
        : null,
      edge,
      coverage: ledger?.coverage ?? coverageForOutcome(edge.status, edge.reason ?? null),
      ledger,
      adapterDeclared: false,
    });
  }

  for (const entry of coverage) {
    if (entry.coverage !== 'not-parsed-by-adapter') continue;
    const construct = sanitizeProjectionLabel(entry.source_construct);
    const id = `ledger:${entry.source_construct}`;
    const detail = sanitizeProjectionLabel(entry.detail);
    // The synthesized outcome edge, so the row round-trips like a graph-backed one.
    const edge: ProjectionEdge = {
      id,
      relation: 'projects',
      source: id,
      target: null,
      status: 'dropped',
      reason: entry.reason ?? 'source_parse_limit',
      severity: 'info',
      detail: entry.detail,
    };
    rows.push({
      id,
      construct,
      constructKey: entry.source_construct,
      canonicalKind: null,
      status: 'dropped',
      severity: 'info',
      reason: entry.reason ?? 'source_parse_limit',
      reasonSummary: detail,
      targetLabel: null,
      targetLocation: null,
      sourceLabel: construct,
      sourceLocation: null,
      edge,
      coverage: entry.coverage,
      ledger: entry,
      adapterDeclared: true,
    });
  }

  rows.sort((a, b) => a.id.localeCompare(b.id));
  return rows;
}

/**
 * Build the family-laned view both the import SVG graph and its table render from —
 * the shared {@link buildProjectionView} with the import lane set. Aggregation keeps the
 * shared guarantees: dropped and non-info evidence never collapses, so a large manifest
 * stays bounded without hiding a single loss.
 *
 * @param rows The rows from {@link buildImportEvidenceRows}.
 * @param aggregationThreshold Row count above which clean rows aggregate (tests pass a
 *   small value; default the shared {@link GRAPH_AGGREGATION_THRESHOLD}).
 */
export function buildImportProjectionView(
  rows: ImportEvidenceRow[],
  aggregationThreshold?: number,
): ProjectionView<ImportFamilyKey> {
  return buildProjectionView<ImportFamilyKey>(rows, {
    aggregationThreshold,
    lanes: IMPORT_FAMILY_LANES,
    laneOf: (row) => importFamilyForRow(row as ImportEvidenceRow),
  });
}

/**
 * The screen-reader label for one import view entry — used verbatim by the SVG node's
 * `aria-label` and by the table row's select button, so the graph and its text
 * alternative *say* the same thing (the IXH-3.3 table-parity acceptance).
 */
export function importEntryAriaLabel(entry: ProjectionViewEntry<ImportFamilyKey>): string {
  const status = statusPresentation(entry.status);
  if (entry.kind === 'aggregate') {
    const count = entry.members?.length ?? 0;
    return `${count} construct${count === 1 ? '' : 's'} ${status.label.toLowerCase()}, aggregated. Select to list them.`;
  }
  const row = entry.row as ImportEvidenceRow;
  const parts = [`${row.construct} — ${status.label.toLowerCase()}`];
  if (row.sourceLabel && row.sourceLabel !== row.construct) {
    parts.push(`from source ${row.sourceLabel}`);
  }
  if (row.sourceLocation) parts.push(`at source line ${row.sourceLocation}`);
  if (row.adapterDeclared) parts.push('declared adapter limit');
  if (row.severity !== 'info') parts.push(`severity ${row.severity}`);
  parts.push(row.reasonSummary);
  return `${parts.join('; ')}.`;
}

/** Convenience: {@link viewStatusCounts} over an import view (identical semantics). */
export function importViewStatusCounts(
  view: ProjectionView<ImportFamilyKey>,
): Partial<Record<ProjectionStatus, number>> {
  return viewStatusCounts(view.entries);
}

// ---------------------------------------------------------------------------
// Draw budget + table flattening (IXH-3.6, #5108)
// ---------------------------------------------------------------------------

/** Worst-first severity rank, mirroring the shared view ordering (critical → warn → info). */
const SEVERITY_RANK: Record<'critical' | 'warn' | 'info', number> = {
  critical: 0,
  warn: 1,
  info: 2,
};

/**
 * How lossy a status is, for the draw-budget selection: statuses that mean "the source
 * lost something" rank before clean outcomes, so capping the drawn graph can only ever
 * remove clean evidence — a dropped construct is never what the cap hides.
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
 * ({@link GRAPH_DRAW_BUDGET} via `preview-budgets.ts`; tests pass a small value).
 *
 * Selection is **worst-first**: aggregates always draw (each is one box standing for many
 * clean rows — dropping one would hide the most information per node), then rows ordered
 * by severity (critical → warn → info), then by how lossy the status is
 * ({@link STATUS_DRAW_PRIORITY}), then by view position. The survivors keep the view's
 * original order so the lane layout is unchanged — the cap thins lanes from their cleanest
 * tail, it never reorders them.
 *
 * @param entries The ordered entries from {@link buildImportProjectionView}.
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
 * @param entries The ordered entries from {@link buildImportProjectionView}.
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
