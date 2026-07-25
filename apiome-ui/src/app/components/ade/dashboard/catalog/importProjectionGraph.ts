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
// Draw budget + table flattening (IXH-3.6, #5108) — shared, not owned here
// ---------------------------------------------------------------------------

// The draw-budget selection and the table flattening live with the other shared graph
// primitives (`../export/projectionGraph.ts`) so the export mapping graph (IXH-4.2)
// bounds itself the same way; re-exported here so this module stays the import map's
// one entry point.
export {
  buildProjectionTableRows,
  selectDrawnGraphEntries,
} from '../export/projectionGraph';
export type { DrawnGraphSelection, ProjectionTableRow } from '../export/projectionGraph';
