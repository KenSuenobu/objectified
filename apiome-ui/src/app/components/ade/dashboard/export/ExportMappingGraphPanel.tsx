'use client';

/**
 * ExportMappingGraphPanel — canonical → target mapping graph (IXH-4.2, #5110).
 *
 * The Review step's artifact explorer (IXH-4.1) shows what the artifact *contains*. This
 * panel answers the question the explorer cannot: **which canonical entity became which
 * target construct, and which ones did not survive** — the export mirror of the import
 * projection map (IXH-3.3) and the absorbed MFX-45.1 emitted-schema graph view (#4374).
 *
 * It renders the 4.1 preview manifest through the shared projection primitives
 * (`./exportMappingGraph.ts` → `./projectionGraph.ts`, marks from
 * `./projectionGraphSvg.tsx`) — no third graph implementation:
 *
 *  - a **legend** of the statuses present, as text label + symbol + count, from the
 *    manifest's whole-artifact counts (colour is never the only channel);
 *  - a **reconciliation strip** stating, for the same job, whether the graph's statuses
 *    reproduce the manifest's fidelity-report-derived counts — a prefix walk says so
 *    instead of claiming a mismatch;
 *  - a deterministic **SVG graph** laned by outcome (in the target / not in the target /
 *    unavailable), bounded by the shared draw budget, nodes being focusable
 *    `role="button"` groups with roving tabindex and a drawn focus ring;
 *  - the existing **`EvidenceDrawer`** on node selection — reason code and category,
 *    fidelity finding, target pointer, source provenance, documentation, remediation;
 *  - a synchronized, always-rendered **table** — the text alternative with identical
 *    content and identical accessible names, whose caption is the graph's accessible
 *    name (`aria-labelledby`), windowed above the shared table budget with truthful
 *    `aria-rowcount`/`aria-rowindex`.
 *
 * Selection is the Review step's own entity selection, so picking a node here also opens
 * the entity's bundle file at its declaration line and highlights its explorer row (the
 * IXH-4.1 two-way selection), and a code-side click highlights the node here.
 *
 * Motion is `motion-safe:` only; a manifest failure degrades to a quiet notice and never
 * gates the export.
 */

import { useCallback, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { AlertTriangle, Loader2, Network } from 'lucide-react';
import { cn } from '@lib/utils';
import { computeWindowedRange } from '@/app/utils/windowed-rows';
import {
  GRAPH_DRAW_BUDGET,
  PROJECTION_TABLE_VIRTUALIZE_ABOVE,
} from '@/app/utils/preview-budgets';
import { Button } from '../../../ui/Button';
import { EvidenceDrawer } from './EvidenceDrawer';
import { useCapabilityReasons } from './useCapabilityReasons';
import type { ProjectionStatus } from './exportFidelityPreview';
import type {
  ExportManifestEntity,
  ExportPreviewManifestPage,
} from './exportPreviewManifest';
import {
  buildExportMappingRows,
  buildExportMappingView,
  buildProjectionTableRows,
  entryAriaLabel,
  mappingCountMismatches,
  mappingLaneLabel,
  mappingRowId,
  projectionGraphLayout,
  reconcileMappingCounts,
  selectDrawnGraphEntries,
  statusPresentation,
  viewStatusCounts,
  type ExportMappingRow,
  type MappingReconciliation,
  type ProjectionTableRow,
  type ProjectionViewEntry,
} from './exportMappingGraph';
import type { ProjectionLaneKey } from './projectionGraph';
import {
  ProjectionColumnHeading,
  ProjectionEntryConnectors,
  ProjectionFocusRing,
  ProjectionNodeBox,
  ProjectionOutcomeBox,
} from './projectionGraphSvg';

/** Uniform evidence-table row height (px) the windowing assumes; matches the `h-9` row class. */
const TABLE_ROW_HEIGHT = 36;

/** Height (px) of the windowed table viewport; matches the `h-72` container class. */
const TABLE_HEIGHT = 288;

/** One view entry, in this panel's lane vocabulary. */
type MappingEntry = ProjectionViewEntry<ProjectionLaneKey>;

export interface ExportMappingGraphPanelProps {
  /** The manifest's identity block (hash, target, whole-artifact counts), or null. */
  page: ExportPreviewManifestPage | null;
  /** The accumulated manifest entities (merged cursor pages), in stable tree order. */
  entities: ExportManifestEntity[];
  /** Whether a manifest page walk is in flight. */
  loading: boolean;
  /** Transport error; the panel states it and the rest of the Review step is unaffected. */
  error: string | null;
  /** True once every entity page is loaded (the graph can then reconcile). */
  complete: boolean;
  /** Walk further cursor pages — the stated path to the complete mapping. */
  onLoadMore: () => void;
  /** Human label of the chosen target format (e.g. `gRPC / Protobuf`). */
  targetLabel: string;
  /** The selected entity's canonical key — shared with the explorer and the code viewer. */
  selectedEntityKey: string | null;
  /** Select an entity: the step records it and reveals a located entity in the code. */
  onSelectEntity: (entity: ExportManifestEntity) => void;
  /** Clear the shared entity selection — what closing the evidence drawer does. */
  onClearSelection: () => void;
  /** Navigate back to the target choice — the drawer's safe remediation for a format limit. */
  onChangeTarget?: () => void;
  /** Navigate back to the export options — the drawer's safe remediation for an exclusion. */
  onChangeOptions?: () => void;
  /** Aggregation threshold override; tests pass a small value. */
  aggregationThreshold?: number;
  /** SVG draw-budget override; tests pass a small value. */
  drawBudget?: number;
  /** Table windowing threshold override; tests pass a small value. */
  tableVirtualizeAbove?: number;
  /** Table viewport height override; tests pass a small value (jsdom reports 0 heights). */
  tableViewportHeight?: number;
  className?: string;
}

export function ExportMappingGraphPanel({
  page,
  entities,
  loading,
  error,
  complete,
  onLoadMore,
  targetLabel,
  selectedEntityKey,
  onSelectEntity,
  onClearSelection,
  onChangeTarget,
  onChangeOptions,
  aggregationThreshold,
  drawBudget = GRAPH_DRAW_BUDGET,
  tableVirtualizeAbove = PROJECTION_TABLE_VIRTUALIZE_ABOVE,
  tableViewportHeight = TABLE_HEIGHT,
  className,
}: ExportMappingGraphPanelProps) {
  /** An aggregate selected for the drawer; entity selection lives in the Review step. */
  const [selectedAggregateKey, setSelectedAggregateKey] = useState<string | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  /** The node whose SVG group currently holds DOM focus, for the drawn focus outline. */
  const [focusedNodeKey, setFocusedNodeKey] = useState<string | null>(null);
  const [expandedAggregates, setExpandedAggregates] = useState<Set<string>>(new Set());
  const [tableScrollTop, setTableScrollTop] = useState(0);
  /** Display-row index of the table row whose button holds focus, for focus pinning. */
  const [focusedTableIndex, setFocusedTableIndex] = useState<number | null>(null);
  const nodeRefs = useRef<Map<string, SVGGElement>>(new Map());
  const captionId = useId();

  const rows = useMemo(() => buildExportMappingRows(entities), [entities]);
  const view = useMemo(
    () => buildExportMappingView(rows, aggregationThreshold),
    [rows, aggregationThreshold],
  );
  // The SVG draws a worst-first bounded subset; the table below always carries everything.
  const drawnSelection = useMemo(
    () => selectDrawnGraphEntries(view.entries, drawBudget),
    [view.entries, drawBudget],
  );
  const layout = useMemo(() => projectionGraphLayout(drawnSelection.drawn), [drawnSelection.drawn]);
  const reconciliation = useMemo(
    () => reconcileMappingCounts(view, page, complete),
    [view, page, complete],
  );
  // Legend counts: the manifest's whole-artifact truth while pages are still loading,
  // falling back to the view's own counts when no manifest identity is available.
  const viewCounts = useMemo(() => viewStatusCounts(view.entries), [view.entries]);
  const legendCounts = page?.status_counts ?? viewCounts;

  /** The selected view entry: an entity selection from the step, or a local aggregate. */
  const selectedKey =
    selectedAggregateKey ?? (selectedEntityKey ? mappingRowId(selectedEntityKey) : null);
  const selectedEntry = useMemo(
    () => view.entries.find((entry) => entry.key === selectedKey) ?? null,
    [view.entries, selectedKey],
  );

  // The reviewed reason explanations + remediation the drawer prints (EFP-1.2/2.3) —
  // version-static reference data, fetched only once evidence is actually open (and then
  // shared, module-cached, with every other drawer on the page).
  const { reasons } = useCapabilityReasons(selectedEntry != null);

  /** Select one entry: an aggregate stays local, a row flows through the step's selection. */
  const selectEntry = useCallback(
    (entry: MappingEntry) => {
      if (entry.kind === 'aggregate') {
        setSelectedAggregateKey((current) => (current === entry.key ? null : entry.key));
        return;
      }
      setSelectedAggregateKey(null);
      const row = entry.row as ExportMappingRow | undefined;
      if (row) onSelectEntity(row.entity);
    },
    [onSelectEntity],
  );

  // The drawn entry holding the roving tabindex, clamped in case the drawn set shrank.
  const graphFocusIndex = Math.min(focusIndex, Math.max(0, drawnSelection.drawn.length - 1));

  /** Roving-tabindex keyboard handling over the drawn graph nodes, in view order. */
  const handleNodeKeyDown = useCallback(
    (event: KeyboardEvent<SVGGElement>, index: number) => {
      const drawn = drawnSelection.drawn;
      const { key } = event;
      if (key === 'Enter' || key === ' ') {
        event.preventDefault();
        selectEntry(drawn[index]);
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
    },
    [drawnSelection.drawn, selectEntry],
  );

  const toggleAggregate = useCallback((key: string) => {
    setExpandedAggregates((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

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
  // scrolled out of the window, or focus (and the Tab stop) would fall off the table.
  const pinnedTableIndex =
    tableVirtualized &&
    focusedTableIndex !== null &&
    focusedTableIndex < tableRows.length &&
    (focusedTableIndex < tableWindow.startIndex || focusedTableIndex >= tableWindow.endIndex)
      ? focusedTableIndex
      : null;

  if (error) {
    return (
      <section className={cn('projection-panel space-y-2', className)} data-testid="export-mapping-graph">
        <SectionHeading targetLabel={targetLabel} />
        <p
          className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
          data-testid="export-mapping-error"
        >
          <AlertTriangle className="mr-1.5 inline h-3.5 w-3.5 align-text-bottom" aria-hidden />
          The mapping could not be loaded — the artifact and its fidelity report are
          unaffected. {error}
        </p>
      </section>
    );
  }

  if (rows.length === 0) {
    return (
      <section className={cn('projection-panel space-y-2', className)} data-testid="export-mapping-graph">
        <SectionHeading targetLabel={targetLabel} />
        {loading ? (
          <p
            className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300"
            data-testid="export-mapping-loading"
          >
            <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-500" aria-hidden />
            Loading the source-to-target mapping…
          </p>
        ) : (
          <p
            className="rounded-lg border border-dashed border-gray-200 px-3 py-4 text-xs text-gray-400 dark:border-gray-700 dark:text-gray-500"
            data-testid="export-mapping-empty"
          >
            The manifest carried no canonical entities for this artifact.
          </p>
        )}
      </section>
    );
  }

  /** One spacer row standing in for `height` px of unmounted display rows. */
  const spacerRow = (key: string, height: number): ReactNode =>
    height > 0 ? (
      <tr key={key} aria-hidden style={{ height }} data-testid="export-mapping-table-spacer">
        <td colSpan={5} className="p-0" />
      </tr>
    ) : null;

  /** Render one display row (entry, aggregate toggle, or expanded member). */
  const renderTableRow = (row: ProjectionTableRow<ProjectionLaneKey>, index: number): ReactNode => {
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
          onSelect={() => selectEntry(row.entry)}
          ariaRowIndex={ariaRowIndex}
          onFocusRow={() => setFocusedTableIndex(index)}
        />
      );
    }
    return (
      <MappingTableRow
        key={row.key}
        entry={row.entry}
        selected={row.entry.key === selectedKey}
        onSelect={() => selectEntry(row.entry)}
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
    <section className={cn('projection-panel space-y-3', className)} data-testid="export-mapping-graph">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionHeading targetLabel={targetLabel} />
        {page && (
          <span
            data-testid="export-mapping-snapshot"
            title={`Manifest snapshot ${page.manifest_hash}`}
            className="rounded-full bg-gray-100 px-2 py-0.5 font-mono text-[10px] text-gray-600 dark:bg-gray-800 dark:text-gray-300"
          >
            snapshot {page.manifest_hash.slice(0, 12)}
          </span>
        )}
      </div>

      {/* Legend: every status present, as text + symbol + count. */}
      <div className="flex flex-wrap items-center gap-1.5" data-testid="export-mapping-legend">
        {(Object.entries(legendCounts) as [ProjectionStatus, number][])
          .filter(([, count]) => count > 0)
          .map(([status, count]) => {
            const p = statusPresentation(status);
            return (
              <span
                key={status}
                data-testid={`export-mapping-legend-${status}`}
                className={cn(
                  'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold',
                  p.badgeClass,
                )}
              >
                <span aria-hidden>{p.symbol}</span>
                {p.label}
                <span className="tabular-nums">{count}</span>
              </span>
            );
          })}
      </div>

      <ReconciliationStrip
        reconciliation={reconciliation}
        loading={loading}
        complete={complete}
        onLoadMore={onLoadMore}
      />

      {view.aggregated && (
        <p
          className="text-[11px] text-gray-500 dark:text-gray-400"
          data-testid="export-mapping-aggregated-note"
        >
          Clean rows are aggregated to keep the map readable; expand them in the table below.
          Dropped, approximated, synthesized, and non-info evidence is never aggregated.
        </p>
      )}

      {/* The draw budget is never silent: state drawn-of-total and the path to everything. */}
      {drawnSelection.truncated && (
        <p
          role="status"
          className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-800 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200"
          data-testid="export-mapping-draw-cap"
        >
          Drawing {drawnSelection.drawnRowCount.toLocaleString()} of{' '}
          {drawnSelection.totalRowCount.toLocaleString()} entities (worst first) to keep the map
          responsive — the table below lists every entity.
        </p>
      )}

      {/* The graph. Its accessible name is the table caption — the text alternative. */}
      <div className="max-h-80 overflow-auto rounded-lg border border-gray-100 dark:border-gray-800">
        <svg
          data-testid="export-mapping-svg"
          role="group"
          aria-labelledby={captionId}
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          className="block"
        >
          <ProjectionColumnHeading x={layout.columns.source} label="Source construct" />
          <ProjectionColumnHeading x={layout.columns.canonical} label="Canonical entity" />
          <ProjectionColumnHeading x={layout.columns.outcome} label={`In ${targetLabel}`} />

          {layout.lanes.map((lane) => (
            <g key={lane.key} aria-hidden>
              <text
                x={layout.columns.outcome}
                y={lane.headerY}
                className="fill-gray-500 text-[10px] font-semibold uppercase tracking-wide dark:fill-gray-400"
              >
                {lane.label} ({lane.count})
              </text>
            </g>
          ))}

          {layout.entries.map((placed) => (
            <ProjectionEntryConnectors key={placed.entry.key} placed={placed} />
          ))}

          {layout.entries.map((placed, index) => {
            const { entry } = placed;
            const isSelected = entry.key === selectedKey;
            const p = statusPresentation(entry.status);
            return (
              <g
                key={entry.key}
                data-testid={`export-mapping-node-${entry.key}`}
                data-status={entry.status}
                role="button"
                tabIndex={index === graphFocusIndex ? 0 : -1}
                aria-label={entryAriaLabel(entry)}
                aria-pressed={isSelected}
                ref={(el) => {
                  if (el) nodeRefs.current.set(entry.key, el);
                  else nodeRefs.current.delete(entry.key);
                }}
                onClick={() => selectEntry(entry)}
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
                  <ProjectionFocusRing placed={placed} testId="export-mapping-focus-ring" />
                )}
                {placed.sourceBox && (
                  <ProjectionNodeBox
                    box={placed.sourceBox}
                    label={entry.row?.sourceLabel ?? ''}
                    mono
                    muted
                  />
                )}
                <ProjectionNodeBox
                  box={placed.canonicalBox}
                  label={entry.label}
                  mono
                  selected={isSelected}
                />
                <ProjectionOutcomeBox
                  box={placed.outcomeBox}
                  presentation={p}
                  selected={isSelected}
                  location={entry.kind === 'row' ? (entry.row?.targetLocation ?? null) : null}
                />
              </g>
            );
          })}
        </svg>
      </div>

      {/* Selection → the existing export evidence drawer, announced politely. */}
      <div aria-live="polite">
        {selectedEntry && (
          <EvidenceDrawer
            entry={selectedEntry}
            summary={page ? { target: page.target as unknown as Record<string, unknown> } : null}
            reasons={reasons}
            onClose={() => {
              setSelectedAggregateKey(null);
              // A row's selection is the step's (it also drives the explorer and the code
              // viewer), so closing the drawer clears it there, not here.
              if (selectedEntry.kind === 'row') onClearSelection();
            }}
            onChangeTarget={onChangeTarget}
            onChangeOptions={onChangeOptions}
          />
        )}
      </div>

      {/* The text alternative: identical content, identical aria labels, windowed. */}
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
        data-testid="export-mapping-table-viewport"
      >
        <table
          className="w-full text-left text-xs"
          data-testid="export-mapping-table"
          aria-rowcount={tableRows.length + 1}
        >
          <caption id={captionId} className="sr-only">
            Source-to-target mapping for {targetLabel} — the accessible equivalent of the
            mapping graph. Every graph node has one row here with the same status, canonical
            entity, target location, outcome, and reason.
          </caption>
          <thead>
            <tr
              aria-rowindex={1}
              className="border-b border-gray-200 text-[10px] uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:text-gray-400"
            >
              <th scope="col" className="px-2 py-1.5">Status</th>
              <th scope="col" className="px-2 py-1.5">Canonical entity</th>
              <th scope="col" className="px-2 py-1.5">Target construct</th>
              <th scope="col" className="px-2 py-1.5">Outcome</th>
              <th scope="col" className="px-2 py-1.5">Reason</th>
            </tr>
          </thead>
          <tbody>{bodyRows}</tbody>
        </table>
      </div>
      {tableVirtualized && (
        <p className="text-[10px] text-gray-500 dark:text-gray-400" data-testid="export-mapping-table-windowed">
          The table is windowed — every one of its {tableRows.length.toLocaleString()} rows is
          reachable by scrolling.
        </p>
      )}
    </section>
  );
}

/** The section heading, shared by the populated, empty, and error states. */
function SectionHeading({ targetLabel }: { targetLabel: string }) {
  return (
    <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-gray-900 dark:text-gray-100">
      <Network className="h-3.5 w-3.5 text-indigo-500" aria-hidden />
      What became of each entity in {targetLabel}
    </h4>
  );
}

/**
 * The reconciliation strip (IXH-4.2 AC 4): whether the graph's per-status counts reproduce
 * the manifest's whole-artifact counts — which the server derived from, and reconciles
 * against, the fidelity report for this job. A partial walk states the loaded-of-total
 * counts and offers the rest; a genuine disagreement is stated as a warning, never hidden.
 */
function ReconciliationStrip({
  reconciliation,
  loading,
  complete,
  onLoadMore,
}: {
  reconciliation: MappingReconciliation;
  loading: boolean;
  complete: boolean;
  onLoadMore: () => void;
}) {
  const mismatches = mappingCountMismatches(reconciliation);

  if (reconciliation.partial) {
    return (
      <div
        className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-[11px] text-gray-600 dark:border-gray-700 dark:text-gray-300"
        data-testid="export-mapping-partial"
      >
        <span>
          Showing {reconciliation.graphTotal.toLocaleString()} of{' '}
          {reconciliation.manifestTotal.toLocaleString()} entities — the status counts above
          cover the whole artifact. Load the rest to reconcile them against the fidelity
          report.
        </span>
        {loading ? (
          <span className="inline-flex items-center gap-1 text-gray-500 dark:text-gray-400">
            <Loader2 className="h-3 w-3 animate-spin text-indigo-500" aria-hidden />
            Loading…
          </span>
        ) : (
          !complete && (
            <Button
              variant="outline"
              size="sm"
              data-testid="export-mapping-load-more"
              onClick={onLoadMore}
            >
              Load more entities
            </Button>
          )
        )}
      </div>
    );
  }

  if (mismatches.length > 0) {
    return (
      <p
        role="status"
        className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200"
        data-testid="export-mapping-mismatch"
      >
        <AlertTriangle className="mr-1.5 inline h-3.5 w-3.5 align-text-bottom" aria-hidden />
        This graph does not reconcile with the fidelity report for this job:{' '}
        {mismatches
          .map(
            (entry) =>
              `${entry.status} drawn ${entry.graph}, reported ${entry.manifest}`,
          )
          .join('; ')}
        . Re-run the export for one consistent view.
      </p>
    );
  }

  return (
    <p
      className="text-[11px] text-gray-500 dark:text-gray-400"
      data-testid="export-mapping-reconciled"
    >
      Reconciles with the fidelity report for this job:{' '}
      {reconciliation.manifestTotal.toLocaleString()} canonical entities,{' '}
      {reconciliation.manifestDropped.toLocaleString()} not carried by the artifact.
    </p>
  );
}

/** Status symbol + text, the colour-independent pairing used throughout the panel. */
function StatusText({ status }: { status: ProjectionStatus }) {
  const p = statusPresentation(status);
  return (
    <span
      data-status={status}
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold',
        p.badgeClass,
      )}
    >
      <span aria-hidden>{p.symbol}</span>
      {p.label}
    </span>
  );
}

/** One individual mapping row of the text-alternative table. */
function MappingTableRow({
  entry,
  selected,
  onSelect,
  ariaRowIndex,
  onFocusRow,
}: {
  entry: MappingEntry;
  selected: boolean;
  onSelect: () => void;
  ariaRowIndex: number;
  onFocusRow: () => void;
}) {
  const row = entry.row as ExportMappingRow;
  return (
    <tr
      aria-rowindex={ariaRowIndex}
      className={cn(
        'h-9 whitespace-nowrap border-b border-gray-100 last:border-0 dark:border-gray-800',
        selected && 'bg-indigo-50 dark:bg-indigo-950/30',
      )}
      data-testid={`export-mapping-table-row-${entry.key}`}
    >
      <td className="px-2 py-1.5">
        <StatusText status={entry.status} />
      </td>
      <td className="px-2 py-1.5">
        <button
          type="button"
          onClick={onSelect}
          onFocus={onFocusRow}
          aria-pressed={selected}
          aria-label={entryAriaLabel(entry)}
          data-testid={`export-mapping-row-select-${entry.key}`}
          className="max-w-56 truncate font-mono text-gray-800 underline-offset-2 hover:underline dark:text-gray-100"
        >
          {row.construct}
        </button>
      </td>
      <td className="max-w-56 truncate px-2 py-1.5 font-mono text-gray-600 dark:text-gray-300">
        {row.targetLocation ?? (
          <span className="font-sans text-gray-400 dark:text-gray-500">— not emitted</span>
        )}
      </td>
      <td className="px-2 py-1.5 text-gray-600 dark:text-gray-300">{mappingLaneLabel(entry.lane)}</td>
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

/** An aggregate's row: expand lists its members in place; selecting opens the drawer. */
function AggregateToggleRow({
  entry,
  expanded,
  onToggle,
  onSelect,
  ariaRowIndex,
  onFocusRow,
}: {
  entry: MappingEntry;
  expanded: boolean;
  onToggle: () => void;
  onSelect: () => void;
  ariaRowIndex: number;
  onFocusRow: () => void;
}) {
  const members = entry.members ?? [];
  return (
    <tr aria-rowindex={ariaRowIndex} className="h-9 whitespace-nowrap border-b border-gray-100 dark:border-gray-800">
      <td className="px-2 py-1.5">
        <StatusText status={entry.status} />
      </td>
      <td className="px-2 py-1.5" colSpan={3}>
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
          onFocus={onFocusRow}
          aria-label={entryAriaLabel(entry)}
          data-testid={`export-mapping-aggregate-toggle-${entry.lane}-${entry.status}`}
          className="text-gray-700 underline-offset-2 hover:underline dark:text-gray-200"
        >
          {members.length} entit{members.length === 1 ? 'y' : 'ies'}{' '}
          {statusPresentation(entry.status).label.toLowerCase()} ·{' '}
          {mappingLaneLabel(entry.lane)} (aggregated) — {expanded ? 'collapse' : 'expand'}
        </button>
      </td>
      <td className="px-2 py-1.5 text-gray-600 dark:text-gray-300">
        <button
          type="button"
          onClick={onSelect}
          onFocus={onFocusRow}
          data-testid={`export-mapping-aggregate-select-${entry.key}`}
          className="underline-offset-2 hover:underline"
        >
          Evidence
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
  entry: MappingEntry;
  member: NonNullable<MappingEntry['members']>[number];
  ariaRowIndex: number;
  onFocusRow: () => void;
}) {
  return (
    <tr
      aria-rowindex={ariaRowIndex}
      onFocus={onFocusRow}
      className="h-9 whitespace-nowrap border-b border-gray-50 bg-gray-50/50 dark:border-gray-800/50 dark:bg-gray-900/30"
      data-testid={`export-mapping-aggregate-member-${member.id}`}
    >
      <td className="px-2 py-1" />
      <td className="max-w-56 truncate px-2 py-1 font-mono text-gray-600 dark:text-gray-300">
        {member.construct}
      </td>
      <td className="max-w-56 truncate px-2 py-1 font-mono text-gray-600 dark:text-gray-300">
        {member.targetLocation ?? '—'}
      </td>
      <td className="px-2 py-1 text-gray-500 dark:text-gray-400">{mappingLaneLabel(entry.lane)}</td>
      <td className="px-2 py-1 text-gray-500 dark:text-gray-400">
        <span className="block max-w-md truncate">{member.reasonSummary}</span>
      </td>
    </tr>
  );
}

export default ExportMappingGraphPanel;
