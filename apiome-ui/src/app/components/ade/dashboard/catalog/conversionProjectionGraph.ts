/**
 * Conversion projection view model — source → OpenAPI, outcome-laned (CPDO-3.1, #4801).
 *
 * The conversion preview's **Projection graph** section renders the CPDO-1.3 manifest —
 * which source construct became which OpenAPI pointer, and why anything did not — as a
 * deterministic SVG map plus a synchronized accessible table. The graph primitives are
 * **shared with the export and import projection maps** (EFP-2.2 / IXH-3.3 / IXH-4.2,
 * `../export/projectionGraph.ts`): the sanitizer, the status presentation (text + symbol +
 * stroke pattern, colour always supplemental), the aggregating view builder, the
 * deterministic layout, the draw budget, and the table flattening are imported — not
 * duplicated — per the "third view, not third implementation" rule, and re-exported here so
 * the sharing is a testable identity.
 *
 * What differs from the other maps, and therefore lives here:
 *
 *  - **The status vocabulary.** The conversion manifest speaks `inferred` where the export
 *    manifest speaks `approximated`/`synthesized` (`projection_taxonomy.ConversionStatus`).
 *    Rows keep the wire status ({@link ConversionProjectionRow.conversionStatus}) for
 *    everything user-facing, and map it onto the shared machinery's nearest equivalent
 *    (`inferred` → `synthesized`: same lane, same never-aggregate rule, same draw priority)
 *    so the shared builders need no changes.
 *  - **Lanes are OpenAPI outcomes** — in the document / omitted / unavailable — because the
 *    section exists to distinguish "OpenAPI cannot say this" from "the input never said it"
 *    (the CPDO-3.1 problem statement). The scope (checklist / construct / loss / analysis)
 *    is carried per row instead of as a lane.
 *  - **Mermaid text export.** The graph itself is deterministic SVG (interaction never
 *    relies on Mermaid's client-side layout), but the section offers the manifest as
 *    validated Mermaid flowchart text for copy/export ({@link conversionProjectionMermaid}).
 *    Every label is sanitized and entity-escaped so imported payload text cannot carry
 *    markup or break out of its quoted node label.
 *
 * Everything here is pure (no React, no fetch, no randomness) so it unit-tests directly.
 */

import type { LossinessSeverity, ProjectionStatus } from '../export/exportFidelityPreview';
import type { ProjectionEdge } from '../export/projectionEvidence';
import {
  buildProjectionView,
  sanitizeProjectionLabel,
  statusPresentation,
  type ProjectionEvidenceRow,
  type ProjectionLane,
  type ProjectionView,
  type ProjectionViewEntry,
  type StatusPresentation,
} from '../export/projectionGraph';
import type {
  ConversionEdgeScope,
  ConversionManifestSummary,
  ConversionProjectionEdge,
  ConversionProjectionNode,
  ConversionProjectionStatus,
} from '@/app/utils/conversion-projection';
import { CONVERSION_PROJECTION_STATUSES } from '@/app/utils/conversion-projection';

// The shared primitives, re-exported so consumers (and the sharing-assertion test) reach
// them through this module while the objects stay the export module's own.
export {
  buildProjectionTableRows,
  projectionGraphLayout,
  sanitizeProjectionLabel,
  selectDrawnGraphEntries,
  statusPresentation,
  viewStatusCounts,
} from '../export/projectionGraph';
export type {
  DrawnGraphSelection,
  ProjectionEvidenceRow,
  ProjectionTableRow,
  ProjectionView,
  ProjectionViewEntry,
} from '../export/projectionGraph';

// ---------------------------------------------------------------------------
// Status vocabulary bridge
// ---------------------------------------------------------------------------

/**
 * The shared-machinery status a conversion status rides on. Identity for the five statuses
 * the vocabularies share; `inferred` rides on `synthesized` (the export manifest's "the
 * conversion invented this" status): same destination lane, same never-aggregate rule,
 * same worst-first draw priority.
 */
export function sharedStatusFor(status: ConversionProjectionStatus): ProjectionStatus {
  return status === 'inferred' ? 'synthesized' : status;
}

/** The `Inferred` presentation: the synthesized palette/pattern with conversion wording. */
const INFERRED_PRESENTATION: StatusPresentation = {
  ...statusPresentation('synthesized'),
  label: 'Inferred',
  symbol: '∴',
};

/**
 * The presentation (text/symbol/pattern/palette) for a conversion status. Delegates to the
 * shared {@link statusPresentation} for the shared statuses; `inferred` keeps the
 * synthesized palette and dash pattern (so the SVG connectors drawn from the mapped status
 * stay consistent) under its own label and symbol.
 */
export function conversionStatusPresentation(
  status: ConversionProjectionStatus,
): StatusPresentation {
  return status === 'inferred' ? INFERRED_PRESENTATION : statusPresentation(status);
}

// ---------------------------------------------------------------------------
// Lanes — OpenAPI outcomes
// ---------------------------------------------------------------------------

/** The outcome lane a conversion row lands in. */
export type ConversionLaneKey = 'target' | 'omitted' | 'unavailable';

/** The outcome lanes, in render order, with their user-facing headings. */
export const CONVERSION_LANES: readonly ProjectionLane<ConversionLaneKey>[] = [
  { key: 'target', label: 'In the OpenAPI document' },
  { key: 'omitted', label: 'Omitted from OpenAPI' },
  { key: 'unavailable', label: 'Unavailable or not applicable' },
];

/**
 * Which outcome lane a conversion status belongs to: everything that lands in the document
 * (retained / transformed / inferred) is `target`; `dropped` — OpenAPI genuinely cannot say
 * it — is `omitted`; `unavailable` (apiome could not place it, which is not proof of
 * absence) and `not-applicable` join the `unavailable` lane.
 */
export function conversionLaneForStatus(status: ConversionProjectionStatus): ConversionLaneKey {
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

/** The lane heading for a lane key. */
export function conversionLaneLabel(key: ConversionLaneKey): string {
  return CONVERSION_LANES.find((lane) => lane.key === key)?.label ?? key;
}

/** Short human label for an edge scope, used in the table and the evidence card. */
export const CONVERSION_SCOPE_LABEL: Record<ConversionEdgeScope, string> = {
  checklist: 'Checklist',
  construct: 'Construct',
  loss: 'Loss',
  analysis: 'Analysis',
};

// ---------------------------------------------------------------------------
// Evidence rows
// ---------------------------------------------------------------------------

/** An evidence row plus the conversion-side facts the evidence card needs. */
export interface ConversionProjectionRow extends ProjectionEvidenceRow {
  /** The wire status — what the legend, table, and aria labels present. */
  conversionStatus: ConversionProjectionStatus;
  /** Which of the manifest's four edge scopes the row came from. */
  scope: ConversionEdgeScope;
  /** The server's conversion-phrased remediation, null only for `retained`. */
  remediation: string | null;
  /** Instances this row stands for (checklist rows aggregate); >= 1. */
  edgeCount: number;
  /** The full conversion edge, for the evidence card. */
  conversionEdge: ConversionProjectionEdge;
}

/**
 * Join the conversion manifest's edges to their nodes into flat evidence rows.
 *
 * For each edge, regardless of scope: the edge's **source** node is the source construct
 * (its label is the row's construct; its `source` evidence contributes native provenance)
 * and its **target** node, when present, is the emitted-document location. Edges
 * referencing nodes missing from the bundle are skipped — `conversionEvidencePageIssues`
 * refuses such a page before this builder runs, so the skip is a final safety net.
 *
 * Rows come back sorted by edge id, so any input permutation yields the same rows.
 *
 * @param nodes The manifest page's nodes (accumulated across loaded pages).
 * @param edges The manifest page's edges (accumulated across loaded pages).
 * @returns One row per resolvable edge.
 */
export function buildConversionProjectionRows(
  nodes: ConversionProjectionNode[],
  edges: ConversionProjectionEdge[],
): ConversionProjectionRow[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  const rows: ConversionProjectionRow[] = [];
  for (const edge of edges) {
    const source = nodeById.get(edge.source);
    if (!source) continue;
    const target = edge.target != null ? (nodeById.get(edge.target) ?? null) : null;
    const status = sharedStatusFor(edge.status);
    const detail = sanitizeProjectionLabel(edge.detail);
    // The shared machinery's view of this edge — same identity, mapped status vocabulary.
    const sharedEdge: ProjectionEdge = {
      id: edge.id,
      relation: 'projects',
      source: edge.source,
      target: edge.target,
      status,
      reason: edge.reason,
      severity: edge.severity as LossinessSeverity,
      detail: edge.detail,
    };
    rows.push({
      id: edge.id,
      construct: sanitizeProjectionLabel(source.label),
      constructKey: source.construct_key ?? null,
      canonicalKind: source.source?.construct_kind ?? null,
      status,
      severity: edge.severity as LossinessSeverity,
      reason: edge.reason,
      reasonSummary: detail,
      targetLabel: target ? sanitizeProjectionLabel(target.label) : null,
      targetLocation: target?.target?.json_pointer ?? target?.target?.native_path ?? null,
      sourceLabel: source.source?.native_name
        ? sanitizeProjectionLabel(source.source.native_name)
        : null,
      sourceLocation: source.source?.source_location
        ? sanitizeProjectionLabel(source.source.source_location)
        : null,
      edge: sharedEdge,
      conversionStatus: edge.status,
      scope: edge.scope,
      remediation: edge.remediation,
      edgeCount: edge.count,
      conversionEdge: edge,
    });
  }

  rows.sort((a, b) => a.id.localeCompare(b.id));
  return rows;
}

/**
 * Build the outcome-laned view both the SVG graph and its table render from — the shared
 * {@link buildProjectionView} with the OpenAPI outcome lanes. Aggregation keeps the shared
 * guarantees: dropped, unavailable, inferred, and non-info evidence never collapses, so a
 * large manifest stays bounded without hiding a single loss.
 *
 * @param rows The rows from {@link buildConversionProjectionRows}.
 * @param aggregationThreshold Row count above which clean rows aggregate (tests pass a
 *   small value; default the shared `GRAPH_AGGREGATION_THRESHOLD`).
 */
export function buildConversionProjectionView(
  rows: ConversionProjectionRow[],
  aggregationThreshold?: number,
): ProjectionView<ConversionLaneKey> {
  return buildProjectionView<ConversionLaneKey>(rows, {
    aggregationThreshold,
    lanes: CONVERSION_LANES,
    laneOf: (row) => conversionLaneForStatus((row as ConversionProjectionRow).conversionStatus),
  });
}

/**
 * The screen-reader label for one conversion view entry — used verbatim by the SVG node's
 * `aria-label` and by the table row's select button, so the graph and its text alternative
 * *say* the same thing (the CPDO-3.1 table-parity acceptance). Speaks the wire status
 * (`inferred`, not the mapped `synthesized`).
 */
export function conversionEntryAriaLabel(entry: ProjectionViewEntry<ConversionLaneKey>): string {
  if (entry.kind === 'aggregate') {
    const count = entry.members?.length ?? 0;
    const first = entry.members?.[0] as ConversionProjectionRow | undefined;
    const label = first
      ? conversionStatusPresentation(first.conversionStatus).label
      : statusPresentation(entry.status).label;
    return `${count} construct${count === 1 ? '' : 's'} ${label.toLowerCase()}, aggregated. Select to list them.`;
  }
  const row = entry.row as ConversionProjectionRow;
  const presentation = conversionStatusPresentation(row.conversionStatus);
  const parts = [`${row.construct} — ${presentation.label.toLowerCase()}`];
  parts.push(`${CONVERSION_SCOPE_LABEL[row.scope].toLowerCase()} evidence`);
  if (row.sourceLabel && row.sourceLabel !== row.construct) {
    parts.push(`from source ${row.sourceLabel}`);
  }
  if (row.targetLocation) {
    parts.push(`lands at ${row.targetLocation}`);
  } else if (row.targetLabel) {
    parts.push(`lands in ${row.targetLabel}`);
  } else {
    parts.push('not in the OpenAPI document');
  }
  if (row.severity !== 'info') parts.push(`severity ${row.severity}`);
  parts.push(row.reasonSummary);
  return `${parts.join('; ')}.`;
}

// ---------------------------------------------------------------------------
// Counts + reconciliation
// ---------------------------------------------------------------------------

/**
 * Count represented evidence rows per **wire** status in a view (aggregate members
 * included). The legend, the table caption, and the reconciliation check all use this one
 * counter — which is what guarantees the graph and its fallback expose identical counts.
 */
export function conversionViewStatusCounts(
  entries: ProjectionViewEntry<ConversionLaneKey>[],
): Partial<Record<ConversionProjectionStatus, number>> {
  const counts: Partial<Record<ConversionProjectionStatus, number>> = {};
  const add = (row: ProjectionEvidenceRow) => {
    const status = (row as ConversionProjectionRow).conversionStatus;
    counts[status] = (counts[status] ?? 0) + 1;
  };
  for (const entry of entries) {
    if (entry.kind === 'aggregate') (entry.members ?? []).forEach(add);
    else if (entry.row) add(entry.row);
  }
  return counts;
}

/**
 * Reconcile the fully loaded rows against the manifest summary's own tallies.
 *
 * The CPDO-3.1 acceptance is that the graph and fallback show the **manifest's** counts —
 * so once every page is loaded, the rows' per-status tally must equal
 * `summary.status_counts` and their total must equal `summary.edge_count`. A mismatch
 * means the surface is not showing what the manifest says and must say so rather than
 * present wrong counts as truth.
 *
 * @param summary The snapshot summary the pages were loaded against.
 * @param rows Every loaded row (call only when the page walk completed).
 * @returns Human-readable mismatch statements; empty when everything reconciles.
 */
export function reconcileConversionCounts(
  summary: ConversionManifestSummary,
  rows: ConversionProjectionRow[],
): string[] {
  const mismatches: string[] = [];
  if (rows.length !== summary.edge_count) {
    mismatches.push(
      `loaded ${rows.length} evidence rows but the manifest declares ${summary.edge_count} edges`,
    );
  }
  const tally: Record<string, number> = {};
  for (const row of rows) tally[row.conversionStatus] = (tally[row.conversionStatus] ?? 0) + 1;
  for (const status of CONVERSION_PROJECTION_STATUSES) {
    const declared = summary.status_counts[status] ?? 0;
    const loaded = tally[status] ?? 0;
    if (declared !== loaded) {
      mismatches.push(`status '${status}': loaded ${loaded} rows, manifest declares ${declared}`);
    }
  }
  return mismatches;
}

// ---------------------------------------------------------------------------
// Mermaid text export
// ---------------------------------------------------------------------------

/**
 * Escape untrusted text for a quoted Mermaid node label. {@link sanitizeProjectionLabel}
 * already stripped control/bidi characters and capped the length; this replaces the
 * characters that could terminate the quoted string or read as markup with Mermaid's HTML
 * entity codes, so the emitted text stays one inert label wherever it is rendered.
 */
export function mermaidLabel(raw: string | null | undefined): string {
  return sanitizeProjectionLabel(raw)
    .replace(/&/g, '#amp;')
    .replace(/"/g, '#quot;')
    .replace(/</g, '#lt;')
    .replace(/>/g, '#gt;')
    .replace(/`/g, '#96;');
}

/**
 * Render the view as deterministic Mermaid flowchart text — the copy/export format the
 * CPDO-3.1 acceptance asks for. This text is **not** what the section draws (the SVG is
 * hand-laid-out); it is the portable form of the same evidence: one chain per entry,
 * grouped into the outcome lanes as subgraphs, with the wire status and reason on the
 * arrow. Dropped/unavailable outcomes use dotted arrows to an outcome node, mirroring the
 * issue's own sketch. Node ids are sequential (`c0`, `t0`, …), never derived from imported
 * text; every label passes {@link mermaidLabel}.
 *
 * @param entries The ordered view entries (aggregates render as one summary node).
 * @returns The complete `flowchart LR` text, newline-terminated lines.
 */
export function conversionProjectionMermaid(
  entries: ProjectionViewEntry<ConversionLaneKey>[],
): string {
  const lines: string[] = ['flowchart LR'];
  for (const lane of CONVERSION_LANES) {
    const laneEntries = entries.filter((entry) => entry.lane === lane.key);
    if (laneEntries.length === 0) continue;
    lines.push(`  subgraph lane_${lane.key}["${mermaidLabel(lane.label)}"]`);
    for (const entry of laneEntries) {
      const index = entries.indexOf(entry);
      if (entry.kind === 'aggregate') {
        const count = entry.members?.length ?? 0;
        const first = entry.members?.[0] as ConversionProjectionRow | undefined;
        const label = first
          ? conversionStatusPresentation(first.conversionStatus).label
          : statusPresentation(entry.status).label;
        lines.push(`    a${index}["${count} constructs ${mermaidLabel(label.toLowerCase())} (aggregated)"]`);
        continue;
      }
      const row = entry.row as ConversionProjectionRow;
      const presentation = conversionStatusPresentation(row.conversionStatus);
      const arrowLabel = mermaidLabel(
        row.reason ? `${presentation.label}: ${row.reason}` : presentation.label,
      );
      if (row.sourceLabel && row.sourceLabel !== row.construct) {
        lines.push(`    n${index}["${mermaidLabel(row.sourceLabel)}"] --> c${index}`);
      }
      const landed = row.targetLocation ?? row.targetLabel;
      if (landed) {
        lines.push(
          `    c${index}["${mermaidLabel(row.construct)}"] -->|"${arrowLabel}"| t${index}["${mermaidLabel(landed)}"]`,
        );
      } else {
        lines.push(
          `    c${index}["${mermaidLabel(row.construct)}"] -.->|"${arrowLabel}"| t${index}["not in the OpenAPI document"]`,
        );
      }
    }
    lines.push('  end');
  }
  return `${lines.join('\n')}\n`;
}
