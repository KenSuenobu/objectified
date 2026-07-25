'use client';

/**
 * CatalogImportProjectionGraph (IXH-3.3, #5105) — what the source lost on its way in.
 *
 * The IXH-3.2 entity tree shows what an import will create; this section shows what the
 * source **lost or kept** becoming canonical: the IXH-3.1 manifest's projection graph and
 * coverage ledger rendered as a status-encoded map grouped by source construct family
 * (Services / Operations / Channels / Types / Document-level / Adapter limits), with:
 *
 *  - a **legend** of the statuses present (text label + symbol + count — colour is never
 *    the only channel, per the shared `statusPresentation` vocabulary);
 *  - a deterministic **SVG graph** (hand-computed layout, no Mermaid — the EFP-2.2
 *    precedent this component shares its primitives with): source construct → canonical
 *    entity → outcome, laned by family; nodes are focusable `role="button"` groups with
 *    roving tabindex and a drawn focus outline;
 *  - an **evidence card** for the selected node: coverage class, status, reason code,
 *    detail, source location (linked into the quality step's raw viewer), native
 *    provenance, capability reference, and remediation;
 *  - a synchronized, always-rendered **table** — the text alternative with identical
 *    content, whose caption is the graph's accessible name (`aria-labelledby`); aggregate
 *    rows expand in place, the explicit expansion path that keeps large manifests bounded
 *    without ever hiding dropped evidence.
 *
 * The view model, lanes, and layout come from `importProjectionGraph.ts`, which reuses
 * the export projection-map primitives (`../export/projectionGraph.ts`) — shared, not
 * duplicated, per the IXH-3.3 acceptance criterion.
 *
 * Bounds (IXH-3.6, #5108 — budgets live in `preview-budgets.ts`):
 *
 *  - the SVG draws at most {@link GRAPH_DRAW_BUDGET} entries, selected **worst-first**
 *    (`selectDrawnGraphEntries`) so the cap can only remove clean evidence; when it
 *    applies, a visible note states drawn-of-total and points at the table, which always
 *    lists every construct;
 *  - the table windows its display rows above {@link PROJECTION_TABLE_VIRTUALIZE_ABOVE},
 *    keeping `aria-rowcount`/`aria-rowindex` correct and pinning the row that holds
 *    keyboard focus so windowing never drops it.
 *
 * Motion: all transitions are `motion-safe:` so `prefers-reduced-motion` is honoured.
 */

import { useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@lib/utils';
import type { ProjectionEdge, ProjectionNode } from '../export/projectionEvidence';
import type { PlacedEntry, StatusPresentation } from '../export/projectionGraph';
import {
  buildImportEvidenceRows,
  buildImportProjectionView,
  buildProjectionTableRows,
  IMPORT_FAMILY_LANES,
  importEntryAriaLabel,
  projectionGraphLayout,
  selectDrawnGraphEntries,
  statusPresentation,
  viewStatusCounts,
  type ImportEvidenceRow,
  type ImportFamilyKey,
  type ProjectionTableRow,
  type ProjectionViewEntry,
} from './importProjectionGraph';
import {
  GRAPH_DRAW_BUDGET,
  PROJECTION_TABLE_VIRTUALIZE_ABOVE,
} from '@/app/utils/preview-budgets';
import { computeWindowedRange } from '@/app/utils/windowed-rows';
import {
  parseSourceLocation,
  PREVIEW_COVERAGE_LABEL,
  PREVIEW_COVERAGE_TONE,
  type ImportCapabilityReference,
  type ImportPreviewCoverageEntry,
  type PreviewCoverageClass,
} from '@/app/utils/import-preview-manifest';

/** Uniform evidence-table row height (px) the windowing assumes; matches the `h-9` row class. */
const TABLE_ROW_HEIGHT = 36;

/** Height (px) of the windowed table viewport; matches the `h-72` container class. */
const TABLE_HEIGHT = 288;

export interface CatalogImportProjectionGraphProps {
  /** The manifest's graph nodes (accumulated across loaded pages). */
  nodes: ProjectionNode[];
  /** The manifest's graph edges (accumulated across loaded pages). */
  edges: ProjectionEdge[];
  /** The manifest's coverage-ledger rows (accumulated across loaded pages). */
  coverage: ImportPreviewCoverageEntry[];
  /** The adapter's capability reference — the fallback for adapter-declared limit rows. */
  capability: ImportCapabilityReference;
  /** Whether the step has raw source text to link into (false for archives). */
  rawSourceAvailable: boolean;
  /** Line count of the raw source, so links past the end are not offered. */
  rawLineCount: number;
  /** Jump the quality step's raw viewer to a 1-based source line. */
  onSelectSourceLine: (line: number) => void;
  /** Aggregation threshold override; tests pass a small value. */
  aggregationThreshold?: number;
  /** SVG draw-budget override; tests pass a small value. */
  drawBudget?: number;
  /** Table windowing threshold override; tests pass a small value. */
  tableVirtualizeAbove?: number;
  /** Table viewport height override; tests pass a small value to exercise real windowing
   *  (jsdom reports element heights as 0, so the height cannot be measured). */
  tableViewportHeight?: number;
}

/** Human remediation guidance per coverage class (the evidence card's last line). */
const REMEDIATION: Record<PreviewCoverageClass, string> = {
  mapped: 'Fully represented by canonical fields — nothing to remediate.',
  'partially-mapped':
    'The unmodeled attributes are preserved in the entity’s extras bag and survive round-trip, but are not first-class canonical fields.',
  'unsupported-by-canonical-model':
    'No canonical field models this construct; it is preserved only in the extras bag. If it must be first-class, that is a canonical-model gap, not an adapter bug.',
  'not-parsed-by-adapter':
    'A declared adapter limit — the adapter never reads this construct. See the capability reference for the tracked gap.',
};

/** The family lane heading for a lane key. */
function familyLabel(key: ImportFamilyKey): string {
  return IMPORT_FAMILY_LANES.find((lane) => lane.key === key)?.label ?? key;
}

/** Status symbol + text, the colour-independent pairing used everywhere in this section. */
function StatusText({ presentation }: { presentation: StatusPresentation }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold', presentation.badgeClass)}>
      <span aria-hidden>{presentation.symbol}</span>
      {presentation.label}
    </span>
  );
}

export function CatalogImportProjectionGraph({
  nodes,
  edges,
  coverage,
  capability,
  rawSourceAvailable,
  rawLineCount,
  onSelectSourceLine,
  aggregationThreshold,
  drawBudget = GRAPH_DRAW_BUDGET,
  tableVirtualizeAbove = PROJECTION_TABLE_VIRTUALIZE_ABOVE,
  tableViewportHeight = TABLE_HEIGHT,
}: CatalogImportProjectionGraphProps) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  /** The node whose SVG group currently holds DOM focus, for the drawn focus outline. */
  const [focusedNodeKey, setFocusedNodeKey] = useState<string | null>(null);
  const [expandedAggregates, setExpandedAggregates] = useState<Set<string>>(new Set());
  const [tableScrollTop, setTableScrollTop] = useState(0);
  /** Display-row index of the table row whose button holds focus, for focus pinning. */
  const [focusedTableIndex, setFocusedTableIndex] = useState<number | null>(null);
  const nodeRefs = useRef<Map<string, SVGGElement>>(new Map());
  const captionId = useId();

  const rows = useMemo(
    () => buildImportEvidenceRows(nodes, edges, coverage),
    [nodes, edges, coverage],
  );
  const view = useMemo(
    () => buildImportProjectionView(rows, aggregationThreshold),
    [rows, aggregationThreshold],
  );
  // The SVG draws a worst-first bounded subset; the table below always carries everything.
  const drawnSelection = useMemo(
    () => selectDrawnGraphEntries(view.entries, drawBudget),
    [view.entries, drawBudget],
  );
  const layout = useMemo(
    () => projectionGraphLayout(drawnSelection.drawn, IMPORT_FAMILY_LANES),
    [drawnSelection.drawn],
  );
  // Legend counts stay over the FULL view — the cap bounds drawing, never the statement.
  const counts = useMemo(() => viewStatusCounts(view.entries), [view.entries]);

  const selectedEntry = useMemo(
    () => view.entries.find((entry) => entry.key === selectedKey) ?? null,
    [view.entries, selectedKey],
  );

  // The drawn entry holding the roving tabindex, clamped in case the drawn set shrank.
  const graphFocusIndex = Math.min(focusIndex, Math.max(0, drawnSelection.drawn.length - 1));

  /** Roving-tabindex keyboard handling over the drawn graph nodes, in view order. */
  const handleNodeKeyDown = (event: KeyboardEvent<SVGGElement>, index: number) => {
    const { key } = event;
    const drawn = drawnSelection.drawn;
    if (key === 'Enter' || key === ' ') {
      event.preventDefault();
      setSelectedKey(drawn[index].key);
      return;
    }
    const delta =
      key === 'ArrowDown' || key === 'ArrowRight'
        ? 1
        : key === 'ArrowUp' || key === 'ArrowLeft'
          ? -1
          : null;
    let next: number | null = null;
    if (delta !== null) next = index + delta;
    else if (key === 'Home') next = 0;
    else if (key === 'End') next = drawn.length - 1;
    if (next === null) return;
    event.preventDefault();
    const clamped = Math.max(0, Math.min(next, drawn.length - 1));
    setFocusIndex(clamped);
    nodeRefs.current.get(drawn[clamped].key)?.focus();
  };

  const toggleAggregate = (key: string) => {
    setExpandedAggregates((prev) => {
      const nextSet = new Set(prev);
      if (nextSet.has(key)) nextSet.delete(key);
      else nextSet.add(key);
      return nextSet;
    });
  };

  // The table's flat display rows (entries + expanded members), windowed above the budget.
  const tableRows = useMemo(
    () => buildProjectionTableRows(view.entries, expandedAggregates),
    [view.entries, expandedAggregates],
  );
  const tableVirtualized = tableRows.length > tableVirtualizeAbove;
  const tableWindow = useMemo(
    () =>
      tableVirtualized
        ? computeWindowedRange({
            rowCount: tableRows.length,
            rowHeight: TABLE_ROW_HEIGHT,
            viewportHeight: tableViewportHeight,
            scrollTop: tableScrollTop,
          })
        : { startIndex: 0, endIndex: tableRows.length, paddingTop: 0, paddingBottom: 0 },
    [tableRows.length, tableScrollTop, tableViewportHeight, tableVirtualized],
  );
  // Focus pinning: the display row whose button holds focus must stay mounted even when
  // scrolled out of the window, or focus (and the Tab stop) would fall off the table. It
  // renders in DOM order between split spacers, so `aria-rowindex` order stays truthful.
  const pinnedTableIndex =
    tableVirtualized &&
    focusedTableIndex !== null &&
    focusedTableIndex < tableRows.length &&
    (focusedTableIndex < tableWindow.startIndex || focusedTableIndex >= tableWindow.endIndex)
      ? focusedTableIndex
      : null;

  if (rows.length === 0) {
    return (
      <section className="projection-panel" data-testid="import-projection-graph">
        <SectionHeading />
        <p
          className="rounded-lg border border-dashed border-gray-200 px-3 py-4 text-xs text-gray-400 dark:border-gray-700 dark:text-gray-500"
          data-testid="import-projection-empty"
        >
          The manifest carried no projection evidence for this candidate.
        </p>
      </section>
    );
  }

  /** One spacer row standing in for `height` px of unmounted display rows. */
  const spacerRow = (key: string, height: number): ReactNode =>
    height > 0 ? (
      <tr key={key} aria-hidden style={{ height }} data-testid="import-projection-table-spacer">
        <td colSpan={5} className="p-0" />
      </tr>
    ) : null;

  /** Render one display row (entry, aggregate toggle, or expanded member). */
  const renderTableRow = (row: ProjectionTableRow<ImportFamilyKey>, index: number): ReactNode => {
    const ariaRowIndex = row.bodyRowIndex + 1; // +1 for the header row.
    if (row.kind === 'member') {
      return (
        <MemberRow
          key={row.key}
          entry={row.entry}
          member={row.member!}
          ariaRowIndex={ariaRowIndex}
          onFocusRow={() => setFocusedTableIndex(index)}
        />
      );
    }
    if (row.entry.kind === 'aggregate') {
      return (
        <AggregateToggleRow
          key={row.key}
          entry={row.entry}
          expanded={expandedAggregates.has(row.entry.key)}
          onToggle={() => toggleAggregate(row.entry.key)}
          ariaRowIndex={ariaRowIndex}
          onFocusRow={() => setFocusedTableIndex(index)}
        />
      );
    }
    return (
      <EvidenceTableRow
        key={row.key}
        entry={row.entry}
        selected={row.entry.key === selectedKey}
        onSelect={() => setSelectedKey(row.entry.key)}
        ariaRowIndex={ariaRowIndex}
        onFocusRow={() => setFocusedTableIndex(index)}
      />
    );
  };

  // Split the spacers around a pinned row so it renders at its true offset in DOM order.
  const bodyRows: ReactNode[] = [];
  if (pinnedTableIndex !== null && pinnedTableIndex < tableWindow.startIndex) {
    bodyRows.push(spacerRow('spacer-top-a', pinnedTableIndex * TABLE_ROW_HEIGHT));
    bodyRows.push(renderTableRow(tableRows[pinnedTableIndex], pinnedTableIndex));
    bodyRows.push(
      spacerRow('spacer-top-b', (tableWindow.startIndex - pinnedTableIndex - 1) * TABLE_ROW_HEIGHT),
    );
  } else {
    bodyRows.push(spacerRow('spacer-top', tableWindow.paddingTop));
  }
  tableRows
    .slice(tableWindow.startIndex, tableWindow.endIndex)
    .forEach((row, offset) => bodyRows.push(renderTableRow(row, tableWindow.startIndex + offset)));
  if (pinnedTableIndex !== null && pinnedTableIndex >= tableWindow.endIndex) {
    bodyRows.push(
      spacerRow('spacer-bottom-a', (pinnedTableIndex - tableWindow.endIndex) * TABLE_ROW_HEIGHT),
    );
    bodyRows.push(renderTableRow(tableRows[pinnedTableIndex], pinnedTableIndex));
    bodyRows.push(
      spacerRow('spacer-bottom-b', (tableRows.length - pinnedTableIndex - 1) * TABLE_ROW_HEIGHT),
    );
  } else {
    bodyRows.push(spacerRow('spacer-bottom', tableWindow.paddingBottom));
  }

  return (
    <section className="projection-panel space-y-3" data-testid="import-projection-graph">
      <SectionHeading />

      {/* Legend: every status present, as text + symbol + count — always full-view counts. */}
      <div className="flex flex-wrap items-center gap-1.5" data-testid="import-projection-legend">
        {(Object.entries(counts) as [Parameters<typeof statusPresentation>[0], number][]).map(
          ([status, count]) => {
            const p = statusPresentation(status);
            return (
              <span
                key={status}
                className={cn('inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold', p.badgeClass)}
              >
                <span aria-hidden>{p.symbol}</span>
                {p.label}
                <span className="tabular-nums">{count}</span>
              </span>
            );
          },
        )}
      </div>

      {view.aggregated && (
        <p
          className="text-[11px] text-gray-500 dark:text-gray-400"
          data-testid="import-projection-aggregated-note"
        >
          Clean rows are aggregated to keep the map readable; expand them in the table below.
          Dropped and partial evidence is never aggregated.
        </p>
      )}

      {/* The draw budget is never silent: state drawn-of-total and the path to everything. */}
      {drawnSelection.truncated && (
        <p
          role="status"
          className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-800 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200"
          data-testid="import-projection-draw-cap"
        >
          Drawing {drawnSelection.drawnRowCount.toLocaleString()} of{' '}
          {drawnSelection.totalRowCount.toLocaleString()} constructs (worst first) to keep the map
          responsive — the table below lists every construct.
        </p>
      )}

      {/* The graph. Its accessible name is the table caption — the text alternative. */}
      <div className="max-h-80 overflow-auto rounded-lg border border-gray-100 dark:border-gray-800">
        <svg
          data-testid="import-projection-svg"
          role="group"
          aria-labelledby={captionId}
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          className="block"
        >
          <ColumnHeading x={layout.columns.source} label="Source construct" />
          <ColumnHeading x={layout.columns.canonical} label="Canonical entity" />
          <ColumnHeading x={layout.columns.outcome} label="Outcome" />

          {layout.lanes.map((lane) => (
            <g key={lane.key} aria-hidden>
              <text
                x={layout.columns.source}
                y={lane.headerY}
                className="fill-gray-500 text-[10px] font-semibold uppercase tracking-wide dark:fill-gray-400"
              >
                {lane.label} ({lane.count})
              </text>
            </g>
          ))}

          {layout.entries.map((placed) => (
            <EntryConnectors key={placed.entry.key} placed={placed} />
          ))}

          {layout.entries.map((placed, index) => {
            const { entry } = placed;
            const isSelected = entry.key === selectedKey;
            const p = statusPresentation(entry.status);
            return (
              <g
                key={entry.key}
                data-testid={`import-projection-node-${entry.key}`}
                data-status={entry.status}
                role="button"
                tabIndex={index === graphFocusIndex ? 0 : -1}
                aria-label={importEntryAriaLabel(entry)}
                aria-pressed={isSelected}
                ref={(el) => {
                  if (el) nodeRefs.current.set(entry.key, el);
                  else nodeRefs.current.delete(entry.key);
                }}
                onClick={() => setSelectedKey(entry.key)}
                onFocus={() => {
                  setFocusIndex(index);
                  setFocusedNodeKey(entry.key);
                }}
                onBlur={() => setFocusedNodeKey((prev) => (prev === entry.key ? null : prev))}
                onKeyDown={(event) => handleNodeKeyDown(event, index)}
                className="cursor-pointer outline-none"
              >
                {/* Visible keyboard-focus outline (WCAG 2.4.7) — outline-none removes the UA's. */}
                {focusedNodeKey === entry.key && (
                  <rect
                    data-testid="import-projection-focus-ring"
                    x={(placed.sourceBox ?? placed.canonicalBox).x - 3}
                    y={placed.canonicalBox.y - 3}
                    width={
                      placed.outcomeBox.x +
                      placed.outcomeBox.width -
                      (placed.sourceBox ?? placed.canonicalBox).x +
                      6
                    }
                    height={placed.canonicalBox.height + 6}
                    rx={8}
                    fill="none"
                    strokeWidth={2}
                    className="stroke-indigo-500 dark:stroke-indigo-400"
                  />
                )}
                {placed.sourceBox && (
                  <NodeBox box={placed.sourceBox} label={entry.row?.sourceLabel ?? ''} mono muted />
                )}
                <NodeBox box={placed.canonicalBox} label={entry.label} mono selected={isSelected} />
                <OutcomeBox box={placed.outcomeBox} presentation={p} selected={isSelected} />
              </g>
            );
          })}
        </svg>
      </div>

      {/* Selection → evidence, announced politely like the export drawer. */}
      <div aria-live="polite">
        {selectedEntry && (
          <EvidenceCard
            entry={selectedEntry}
            capability={capability}
            rawSourceAvailable={rawSourceAvailable}
            rawLineCount={rawLineCount}
            onSelectSourceLine={onSelectSourceLine}
          />
        )}
      </div>

      {/* The text alternative: identical content, identical aria labels, expandable
          aggregates, windowed above the budget with truthful aria-rowcount/rowindex. */}
      <div
        className={cn(
          'overflow-auto rounded-lg border border-gray-100 dark:border-gray-800',
          tableVirtualized ? 'h-72' : 'max-h-72',
        )}
        style={
          tableVirtualized && tableViewportHeight !== TABLE_HEIGHT
            ? { height: tableViewportHeight }
            : undefined
        }
        onScroll={(event) => setTableScrollTop(event.currentTarget.scrollTop)}
        tabIndex={tableVirtualized ? 0 : undefined}
        role={tableVirtualized ? 'region' : undefined}
        aria-labelledby={tableVirtualized ? captionId : undefined}
        data-testid="import-projection-table-viewport"
      >
        <table
          className="w-full text-left text-xs"
          data-testid="import-projection-table"
          aria-rowcount={tableRows.length + 1}
        >
          <caption id={captionId} className="sr-only">
            Import projection evidence — the accessible equivalent of the import projection
            graph. Every graph node has one row here with the same status, construct, family,
            and reason.
          </caption>
          <thead>
            <tr
              aria-rowindex={1}
              className="border-b border-gray-200 text-[10px] uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:text-gray-400"
            >
              <th scope="col" className="px-2 py-1.5">Status</th>
              <th scope="col" className="px-2 py-1.5">Source construct</th>
              <th scope="col" className="px-2 py-1.5">Canonical entity</th>
              <th scope="col" className="px-2 py-1.5">Family</th>
              <th scope="col" className="px-2 py-1.5">Reason</th>
            </tr>
          </thead>
          <tbody>{bodyRows}</tbody>
        </table>
      </div>
      {tableVirtualized && (
        <p className="text-[10px] text-gray-500 dark:text-gray-400" data-testid="import-projection-table-windowed">
          The table is windowed — every one of its {tableRows.length.toLocaleString()} rows is
          reachable by scrolling.
        </p>
      )}
    </section>
  );
}

/** The section heading shared by the populated and empty states. */
function SectionHeading() {
  return (
    <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-900 dark:text-gray-100">
      What the source lost coming in
    </h4>
  );
}

/** A column heading text element. */
function ColumnHeading({ x, label }: { x: number; label: string }) {
  return (
    <text
      x={x}
      y={10}
      aria-hidden
      className="fill-gray-400 text-[10px] font-semibold uppercase tracking-wide dark:fill-gray-500"
    >
      {label}
    </text>
  );
}

/** The source→canonical and canonical→outcome connector lines (status-patterned). */
function EntryConnectors({ placed }: { placed: PlacedEntry<ImportFamilyKey> }) {
  const p = statusPresentation(placed.entry.status);
  const midY = placed.canonicalBox.y + placed.canonicalBox.height / 2;
  return (
    <g aria-hidden>
      {placed.sourceBox && (
        <line
          x1={placed.sourceBox.x + placed.sourceBox.width}
          y1={midY}
          x2={placed.canonicalBox.x}
          y2={midY}
          strokeWidth={1.5}
          className="stroke-gray-300 dark:stroke-gray-600"
        />
      )}
      <line
        x1={placed.canonicalBox.x + placed.canonicalBox.width}
        y1={midY}
        x2={placed.outcomeBox.x}
        y2={midY}
        strokeWidth={2}
        strokeDasharray={p.dashArray ?? undefined}
        className={p.strokeClass}
      />
    </g>
  );
}

/** Truncate a label to what fits one node box (the full text lives in the aria-label/table). */
function fitLabel(label: string, max = 26): string {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

/** One plain node box (source or canonical column). */
function NodeBox({
  box,
  label,
  mono = false,
  muted = false,
  selected = false,
}: {
  box: { x: number; y: number; width: number; height: number };
  label: string;
  mono?: boolean;
  muted?: boolean;
  selected?: boolean;
}) {
  return (
    <g>
      <rect
        x={box.x}
        y={box.y}
        width={box.width}
        height={box.height}
        rx={6}
        strokeWidth={selected ? 2 : 1}
        className={`${
          selected
            ? 'stroke-indigo-500 dark:stroke-indigo-400'
            : 'stroke-gray-300 dark:stroke-gray-600'
        } fill-white dark:fill-gray-900 motion-safe:transition-colors`}
      />
      <text
        x={box.x + 8}
        y={box.y + box.height / 2 + 3.5}
        className={`${mono ? 'font-mono' : ''} text-[11px] ${
          muted ? 'fill-gray-500 dark:fill-gray-400' : 'fill-gray-900 dark:fill-gray-100'
        }`}
      >
        {fitLabel(label)}
      </text>
    </g>
  );
}

/** The outcome-column box: status symbol + label, dash-patterned like its connector. */
function OutcomeBox({
  box,
  presentation,
  selected,
}: {
  box: { x: number; y: number; width: number; height: number };
  presentation: StatusPresentation;
  selected: boolean;
}) {
  return (
    <g>
      <rect
        x={box.x}
        y={box.y}
        width={box.width}
        height={box.height}
        rx={6}
        strokeWidth={selected ? 2.5 : 1.5}
        strokeDasharray={presentation.dashArray ?? undefined}
        className={`${
          selected ? 'stroke-indigo-500 dark:stroke-indigo-400' : presentation.strokeClass
        } fill-white dark:fill-gray-900 motion-safe:transition-colors`}
      />
      <text
        x={box.x + 8}
        y={box.y + box.height / 2 + 3.5}
        className="fill-gray-900 text-[10px] font-semibold dark:fill-gray-100"
      >
        {fitLabel(`${presentation.symbol} ${presentation.label}`)}
      </text>
    </g>
  );
}

/** The selected node's evidence: coverage, status, reason, location, capability, remediation. */
function EvidenceCard({
  entry,
  capability,
  rawSourceAvailable,
  rawLineCount,
  onSelectSourceLine,
}: {
  entry: ProjectionViewEntry<ImportFamilyKey>;
  capability: ImportCapabilityReference;
  rawSourceAvailable: boolean;
  rawLineCount: number;
  onSelectSourceLine: (line: number) => void;
}) {
  const presentation = statusPresentation(entry.status);
  if (entry.kind === 'aggregate') {
    return (
      <div
        className="rounded-lg border border-gray-200 p-3 text-xs text-gray-600 dark:border-gray-700 dark:text-gray-300"
        data-testid="import-projection-evidence"
      >
        <StatusText presentation={presentation} /> {entry.members?.length ?? 0} constructs,
        aggregated to keep the map readable. Expand the aggregate row in the table below to list
        every member.
      </div>
    );
  }

  const row = entry.row as ImportEvidenceRow;
  const location = parseSourceLocation(row.sourceLocation);
  const linkable =
    location !== null && rawSourceAvailable && location.line <= rawLineCount;
  const capabilityRef = row.ledger?.capability_reference ?? (row.adapterDeclared ? capability : null);

  return (
    <div
      className="space-y-2 rounded-lg border border-gray-200 p-3 text-xs text-gray-700 dark:border-gray-700 dark:text-gray-200"
      data-testid="import-projection-evidence"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono font-semibold">{row.construct}</span>
        <StatusText presentation={presentation} />
        <span
          className={cn(
            'inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold',
            PREVIEW_COVERAGE_TONE[row.coverage],
          )}
        >
          {PREVIEW_COVERAGE_LABEL[row.coverage]}
        </span>
        {row.reason && (
          <span
            className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[10px] text-gray-600 dark:bg-gray-800 dark:text-gray-300"
            data-testid="import-projection-reason"
          >
            {row.reason}
          </span>
        )}
      </div>

      <p>{row.reasonSummary}</p>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-500 dark:text-gray-400">
        {row.sourceLabel && row.sourceLabel !== row.construct && (
          <span>
            Source name: <span className="font-mono">{row.sourceLabel}</span>
          </span>
        )}
        {row.sourceLocation &&
          (linkable ? (
            <button
              type="button"
              data-testid="import-projection-source-link"
              onClick={() => onSelectSourceLine(location.line)}
              className="font-mono text-indigo-600 underline decoration-dotted underline-offset-2 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-300"
            >
              Source line {row.sourceLocation}
            </button>
          ) : (
            <span className="font-mono">Source line {row.sourceLocation}</span>
          ))}
      </div>

      {capabilityRef && (
        <div
          className="rounded-md bg-gray-50 p-2 text-[11px] text-gray-600 dark:bg-gray-900/50 dark:text-gray-300"
          data-testid="import-projection-capability"
        >
          Capability: <span className="font-mono">{capabilityRef.format}</span> ·{' '}
          {capabilityRef.mode} · {capabilityRef.importable ? 'importable' : 'not importable'}
          {capabilityRef.related_issues.length > 0 && (
            <> · tracked in {capabilityRef.related_issues.join(', ')}</>
          )}
          {capabilityRef.notes ? <> — {capabilityRef.notes}</> : null}
        </div>
      )}

      <p className="text-[11px] text-gray-500 dark:text-gray-400" data-testid="import-projection-remediation">
        {REMEDIATION[row.coverage]}
      </p>
    </div>
  );
}

/** One individual evidence row of the text-alternative table. */
function EvidenceTableRow({
  entry,
  selected,
  onSelect,
  ariaRowIndex,
  onFocusRow,
}: {
  entry: ProjectionViewEntry<ImportFamilyKey>;
  selected: boolean;
  onSelect: () => void;
  ariaRowIndex: number;
  onFocusRow: () => void;
}) {
  const row = entry.row as ImportEvidenceRow;
  const presentation = statusPresentation(entry.status);
  return (
    <tr
      aria-rowindex={ariaRowIndex}
      className={cn(
        'h-9 whitespace-nowrap border-b border-gray-100 last:border-0 dark:border-gray-800',
        selected && 'bg-indigo-50 dark:bg-indigo-950/30',
      )}
      data-testid={`import-projection-table-row-${entry.key}`}
    >
      <td className="px-2 py-1.5">
        <StatusText presentation={presentation} />
      </td>
      <td className="px-2 py-1.5">
        <button
          type="button"
          onClick={onSelect}
          onFocus={onFocusRow}
          aria-pressed={selected}
          aria-label={importEntryAriaLabel(entry)}
          className="max-w-56 truncate font-mono text-gray-800 underline-offset-2 hover:underline dark:text-gray-100"
        >
          {row.sourceLabel ?? row.construct}
        </button>
      </td>
      <td className="max-w-56 truncate px-2 py-1.5 font-mono text-gray-600 dark:text-gray-300">
        {row.canonicalKind ? row.construct : '—'}
      </td>
      <td className="px-2 py-1.5 text-gray-600 dark:text-gray-300">
        {familyLabel(entry.lane)}
      </td>
      <td className="px-2 py-1.5 text-gray-600 dark:text-gray-300">
        <span className="block max-w-md truncate">
          {row.reason ? <span className="font-mono">{row.reason}</span> : null}
          {row.reason ? ' — ' : ''}
          {row.reasonSummary}
        </span>
      </td>
    </tr>
  );
}

/** An aggregate's toggle row; its members render as their own display rows when expanded. */
function AggregateToggleRow({
  entry,
  expanded,
  onToggle,
  ariaRowIndex,
  onFocusRow,
}: {
  entry: ProjectionViewEntry<ImportFamilyKey>;
  expanded: boolean;
  onToggle: () => void;
  ariaRowIndex: number;
  onFocusRow: () => void;
}) {
  const presentation = statusPresentation(entry.status);
  const members = entry.members ?? [];
  return (
    <tr aria-rowindex={ariaRowIndex} className="h-9 whitespace-nowrap border-b border-gray-100 dark:border-gray-800">
      <td className="px-2 py-1.5">
        <StatusText presentation={presentation} />
      </td>
      <td className="px-2 py-1.5" colSpan={4}>
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
          onFocus={onFocusRow}
          aria-label={importEntryAriaLabel(entry)}
          data-testid={`import-projection-aggregate-toggle-${entry.lane}-${entry.status}`}
          className="text-gray-700 underline-offset-2 hover:underline dark:text-gray-200"
        >
          {members.length} construct{members.length === 1 ? '' : 's'}{' '}
          {presentation.label.toLowerCase()} in {familyLabel(entry.lane)} (aggregated) —{' '}
          {expanded ? 'collapse' : 'expand'}
        </button>
      </td>
    </tr>
  );
}

/** One expanded aggregate member's display row. */
function MemberRow({
  entry,
  member,
  ariaRowIndex,
  onFocusRow,
}: {
  entry: ProjectionViewEntry<ImportFamilyKey>;
  member: NonNullable<ProjectionViewEntry<ImportFamilyKey>['members']>[number];
  ariaRowIndex: number;
  onFocusRow: () => void;
}) {
  return (
    <tr
      aria-rowindex={ariaRowIndex}
      onFocus={onFocusRow}
      className="h-9 whitespace-nowrap border-b border-gray-50 bg-gray-50/50 dark:border-gray-800/50 dark:bg-gray-900/30"
      data-testid={`import-projection-aggregate-member-${member.id}`}
    >
      <td className="px-2 py-1" />
      <td className="max-w-56 truncate px-2 py-1 font-mono text-gray-600 dark:text-gray-300">
        {member.sourceLabel ?? member.construct}
      </td>
      <td className="max-w-56 truncate px-2 py-1 font-mono text-gray-600 dark:text-gray-300">
        {member.construct}
      </td>
      <td className="px-2 py-1 text-gray-500 dark:text-gray-400">
        {familyLabel(entry.lane)}
      </td>
      <td className="px-2 py-1 text-gray-500 dark:text-gray-400">
        <span className="block max-w-md truncate">{member.reasonSummary}</span>
      </td>
    </tr>
  );
}

export default CatalogImportProjectionGraph;
