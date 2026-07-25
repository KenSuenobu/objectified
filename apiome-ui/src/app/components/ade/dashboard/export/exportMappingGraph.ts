/**
 * Export mapping view model — canonical → target, from the 4.1 manifest (IXH-4.2, #5110).
 *
 * The Review step's artifact explorer (IXH-4.1) answers *what is in the artifact*. This
 * module answers the other half: **which canonical entity became which target construct,
 * and which ones did not survive**. It turns the export preview manifest's entity rows
 * (`./exportPreviewManifest.ts`) into the same evidence-row shape the projection maps
 * already render, so the mapping graph is a third *view* of the shared primitives rather
 * than a third graph implementation (the IXH-4.2 acceptance criterion):
 *
 *  - the status vocabulary, sanitizer, aggregating view builder, deterministic layout,
 *    draw budget, and table flattening are **imported** from `./projectionGraph.ts` (the
 *    EFP-2.2 primitives IXH-3.3 shares) and re-exported here, so the sharing is a
 *    testable module identity;
 *  - the SVG marks come from `./projectionGraphSvg.tsx`;
 *  - selecting a node opens the existing `EvidenceDrawer` — which is why each row carries
 *    a real {@link ProjectionEdge}, assembled from the manifest entity's own fidelity
 *    facts rather than invented.
 *
 * On the status vocabulary: the ticket's `emitted` edge status is the shared vocabulary's
 * `retained` — an entity the artifact carries verbatim. `emitted` survives here as the
 * manifest's own boolean, which is the *artifact's* answer to "did it land"; where it
 * contradicts the status, {@link laneForMappingRow} believes the artifact
 * (`emitted: false` can never be drawn in the destination lane).
 *
 * Everything here is pure (no React, no fetch, no randomness) so it unit-tests directly.
 */

import type { ProjectionStatus } from './exportFidelityPreview';
import type { ProjectionEdge } from './projectionEvidence';
import type {
  ExportManifestEntity,
  ExportPreviewManifestPage,
} from './exportPreviewManifest';
import {
  buildProjectionView,
  laneForStatus,
  PROJECTION_LANES,
  sanitizeProjectionLabel,
  viewStatusCounts,
  type ProjectionEvidenceRow,
  type ProjectionLaneKey,
  type ProjectionView,
} from './projectionGraph';

// The shared primitives, re-exported so this module is the mapping graph's one entry
// point while the objects stay the projection map's own (asserted by the sharing test).
export {
  buildProjectionTableRows,
  entryAriaLabel,
  projectionGraphLayout,
  PROJECTION_LANES,
  sanitizeProjectionLabel,
  selectDrawnGraphEntries,
  statusPresentation,
  viewStatusCounts,
} from './projectionGraph';
export type {
  DrawnGraphSelection,
  ProjectionEvidenceRow,
  ProjectionTableRow,
  ProjectionView,
  ProjectionViewEntry,
} from './projectionGraph';

/** One manifest entity joined into the shared evidence-row shape. */
export interface ExportMappingRow extends ProjectionEvidenceRow {
  /** The manifest entity this row describes — the explorer's selection identity. */
  entity: ExportManifestEntity;
  /** The canonical entity kind (service / operation / channel / type / field). */
  entityKind: ExportManifestEntity['entity_kind'];
  /** True when the artifact actually carries the entity (the manifest's own answer). */
  emitted: boolean;
  /** False when the fidelity report was silent and the status is the retained default. */
  reported: boolean;
  /** True when the status was aggregated from child constructs (service rows). */
  aggregatedStatus: boolean;
}

/** The view-entry key for one manifest entity — stable across page walks and re-renders. */
export function mappingRowId(entityKey: string): string {
  return `entity:${entityKey}`;
}

/**
 * Where the entity landed in the artifact, as a single printable pointer: the JSON
 * Pointer when the manifest derived one, else the fidelity report's target mapping, else
 * the bundle `file:line` (or the bare file when no line resolved). Null when nothing
 * located it — never guessed.
 */
export function mappingTargetLocation(entity: ExportManifestEntity): string | null {
  const location = entity.location;
  if (location?.pointer) return sanitizeProjectionLabel(location.pointer);
  if (entity.target_mapping) return sanitizeProjectionLabel(entity.target_mapping);
  if (location) {
    return sanitizeProjectionLabel(
      location.line != null ? `${location.file}:${location.line}` : location.file,
    );
  }
  return null;
}

/**
 * The outcome edge one manifest entity implies, in the shared projection-edge shape.
 *
 * The evidence drawer reads its explanation/detail/reason off this edge, so every field
 * is the manifest's own fidelity fact: nothing is synthesized beyond the ids, and an
 * entity the artifact does not carry gets a null target (the shared "dropped" shape).
 *
 * @param entity The manifest entity.
 * @returns The projects edge for the entity's canonical → target outcome.
 */
export function mappingEdgeFor(entity: ExportManifestEntity): ProjectionEdge {
  return {
    id: mappingRowId(entity.key),
    relation: 'projects',
    source: `canonical:${entity.key}`,
    target: entity.emitted ? `target:${entity.key}` : null,
    status: entity.status,
    reason: entity.reason,
    severity: entity.severity,
    detail: entity.detail,
    target_mapping: entity.target_mapping,
  };
}

/**
 * Join the loaded manifest entities into flat evidence rows — one row per canonical
 * entity, in the manifest's stable tree order (the hook merges pages by `order`, so a
 * partial walk yields a prefix, never a reshuffle).
 *
 * @param entities The accumulated manifest entities.
 * @returns One {@link ExportMappingRow} per entity.
 */
export function buildExportMappingRows(entities: ExportManifestEntity[]): ExportMappingRow[] {
  return entities.map((entity) => ({
    id: mappingRowId(entity.key),
    construct: sanitizeProjectionLabel(entity.name || entity.key),
    constructKey: entity.key,
    canonicalKind: entity.entity_kind,
    status: entity.status,
    severity: entity.severity,
    reason: entity.reason,
    reasonSummary: sanitizeProjectionLabel(entity.detail),
    targetLabel: entity.location ? sanitizeProjectionLabel(entity.location.file) : null,
    targetLocation: mappingTargetLocation(entity),
    sourceLabel: entity.native_name ? sanitizeProjectionLabel(entity.native_name) : null,
    sourceLocation: entity.source_location
      ? sanitizeProjectionLabel(entity.source_location)
      : null,
    edge: mappingEdgeFor(entity),
    entity,
    entityKind: entity.entity_kind,
    emitted: entity.emitted,
    reported: entity.reported,
    aggregatedStatus: entity.aggregated,
  }));
}

/**
 * Which destination lane a mapping row draws in.
 *
 * The shared {@link laneForStatus} rule, with one export-side correction: the artifact is
 * the arbiter of what is *in* the artifact. An entity the bundle does not carry
 * (`emitted: false`) is never drawn in the "in the destination" lane, however its status
 * reads — a contradiction between the fidelity report and the emitted bytes is surfaced
 * as an omission, not painted over.
 *
 * @param row The mapping row.
 * @returns The destination lane key.
 */
export function laneForMappingRow(row: ExportMappingRow): ProjectionLaneKey {
  const lane = laneForStatus(row.status);
  if (lane === 'target' && !row.emitted) return 'omitted';
  return lane;
}

/**
 * Build the destination-laned view the mapping graph and its table both render from —
 * the shared {@link buildProjectionView} with the export lane assignment. Aggregation
 * keeps the shared guarantees: only clean info-severity rows collapse, so no dropped,
 * approximated, synthesized, warn, or critical entity is ever hidden.
 *
 * @param rows The rows from {@link buildExportMappingRows}.
 * @param aggregationThreshold Row count above which clean rows aggregate (tests pass a
 *   small value; default the shared `GRAPH_AGGREGATION_THRESHOLD`).
 */
export function buildExportMappingView(
  rows: ExportMappingRow[],
  aggregationThreshold?: number,
): ProjectionView<ProjectionLaneKey> {
  return buildProjectionView<ProjectionLaneKey>(rows, {
    aggregationThreshold,
    laneOf: (row) => laneForMappingRow(row as ExportMappingRow),
  });
}

// ---------------------------------------------------------------------------
// Reconciliation against the manifest's fidelity-report counts (IXH-4.2 AC 4)
// ---------------------------------------------------------------------------

/** One status's drawn-vs-reported comparison. */
export interface MappingStatusReconciliation {
  status: ProjectionStatus;
  /** Entities of this status represented in the view (aggregate members included). */
  graph: number;
  /** Entities of this status the manifest reports for the whole artifact. */
  manifest: number;
  /** `graph - manifest`; zero on a reconciled status. */
  delta: number;
}

/** The whole graph's reconciliation against the manifest's per-status counts. */
export interface MappingReconciliation {
  /** Per-status comparison, worst-first by absolute delta then status name. */
  statuses: MappingStatusReconciliation[];
  /** Evidence rows the view represents right now. */
  graphTotal: number;
  /** Entities in the whole manifest. */
  manifestTotal: number;
  /** Entities the artifact does not carry, per the manifest (dropped + unavailable). */
  manifestDropped: number;
  /** The same count over the view. */
  graphDropped: number;
  /** True while manifest pages remain unloaded — the counts are a prefix, not a mismatch. */
  partial: boolean;
  /** True when every status (and the total) matches — only assertable on a full walk. */
  reconciled: boolean;
}

/** Statuses whose entities the artifact does not carry (mirrors the server's `dropped_entities`). */
const ABSENT_STATUSES: readonly ProjectionStatus[] = ['dropped', 'unavailable'];

/**
 * Reconcile the graph's statuses against the manifest's own counts.
 *
 * The manifest's `status_counts` are the per-entity counts for the **whole** artifact,
 * produced by the same server pass that reconciles the manifest against the fidelity
 * report by hard invariant (IXH-4.1). Counting the view's entries therefore has to
 * reproduce them exactly once every page is loaded — which is what makes "graph statuses
 * reconcile with the fidelity report counts for the same job" checkable in the UI rather
 * than merely asserted server-side.
 *
 * While the cursor walk is incomplete the view holds a prefix: the comparison is reported
 * as {@link MappingReconciliation.partial} (never as a mismatch), and the surface states
 * the loaded-of-total counts instead.
 *
 * @param view The built view (its entries carry the represented row counts).
 * @param page The manifest page identity block carrying the full counts, or null.
 * @param complete True once every manifest page has been loaded.
 * @returns The per-status comparison plus the totals.
 */
export function reconcileMappingCounts(
  view: ProjectionView<ProjectionLaneKey>,
  page: ExportPreviewManifestPage | null,
  complete: boolean,
): MappingReconciliation {
  const graphCounts = viewStatusCounts(view.entries);
  const manifestCounts = page?.status_counts ?? {};
  const statusKeys = new Set<string>([
    ...Object.keys(graphCounts),
    ...Object.keys(manifestCounts).filter((status) => (manifestCounts[status] ?? 0) > 0),
  ]);

  const statuses: MappingStatusReconciliation[] = [...statusKeys]
    .map((status) => {
      const graph = graphCounts[status as ProjectionStatus] ?? 0;
      const manifest = manifestCounts[status] ?? 0;
      return { status: status as ProjectionStatus, graph, manifest, delta: graph - manifest };
    })
    .sort(
      (a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.status.localeCompare(b.status),
    );

  const graphTotal = view.rowCount;
  const manifestTotal = page?.total_entities ?? graphTotal;
  const graphDropped = ABSENT_STATUSES.reduce(
    (sum, status) => sum + (graphCounts[status] ?? 0),
    0,
  );
  const manifestDropped = page?.dropped_entities ?? graphDropped;
  const partial = !complete || graphTotal !== manifestTotal;

  return {
    statuses,
    graphTotal,
    manifestTotal,
    manifestDropped,
    graphDropped,
    partial,
    reconciled:
      !partial &&
      page != null &&
      statuses.every((entry) => entry.delta === 0) &&
      graphDropped === manifestDropped,
  };
}

/** The statuses whose graph count disagrees with the manifest (empty when reconciled). */
export function mappingCountMismatches(
  reconciliation: MappingReconciliation,
): MappingStatusReconciliation[] {
  return reconciliation.statuses.filter((entry) => entry.delta !== 0);
}

// ---------------------------------------------------------------------------
// Text-alternative helpers
// ---------------------------------------------------------------------------

/**
 * The destination lane's user-facing heading — the shared lane set's own label, so the
 * table's Outcome column and the graph's lane bands cannot drift apart.
 */
export function mappingLaneLabel(lane: ProjectionLaneKey): string {
  return PROJECTION_LANES.find((entry) => entry.key === lane)?.label ?? lane;
}
