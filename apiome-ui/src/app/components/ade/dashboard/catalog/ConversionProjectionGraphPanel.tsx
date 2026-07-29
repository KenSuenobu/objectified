'use client';

/**
 * ConversionProjectionGraphPanel (CPDO-3.1, #4801) — which construct became which, and why not.
 *
 * The conversion preview's fidelity columns say *how much* a conversion loses; this section
 * renders the CPDO-1.3 projection manifest — the source → OpenAPI relationship itself — as:
 *
 *  - a **legend** of the wire statuses present (text label + symbol + count — colour is never
 *    the only channel, per the shared `statusPresentation` vocabulary, with the conversion
 *    vocabulary's own `Inferred` presentation);
 *  - a deterministic **SVG graph** (hand-computed layout, no Mermaid — the EFP-2.2 precedent
 *    whose primitives this shares): source/native → construct → OpenAPI outcome, laned by
 *    outcome (in the document / omitted / unavailable); nodes are focusable `role="button"`
 *    groups with roving tabindex, pan by the scrollable viewport, zoom in/out, and Escape to
 *    reset the view;
 *  - an **evidence drawer** for the selected node or fallback row (CPDO-3.2,
 *    `./ConversionEvidenceDrawer.tsx`): wire status, scope, reason category + code, the
 *    linked fidelity finding, source path/range, canonical object, OpenAPI JSON Pointers,
 *    tool-version provenance, the server's remediation, and the safe-default approval that
 *    recomputes the report and this graph together;
 *  - a synchronized, always-rendered **table** — the accessibility source of truth with
 *    identical content and identical aria labels, whose caption is the graph's accessible
 *    name; aggregate rows expand in place, windowed above the shared budget;
 *  - **Mermaid text export**: copy or download the manifest as sanitized `flowchart LR` text
 *    (`conversionProjectionMermaid`) — the portable form of the same evidence. The drawn
 *    graph never executes or lays out that text.
 *
 * Counts are reconciled, not assumed: once the page walk completes, the loaded rows are
 * checked against the manifest summary's own tallies (`reconcileConversionCounts`) and any
 * mismatch is stated. A dry-run envelope summary can be passed in; a differing snapshot hash
 * is stated too (the source or defaults changed between the two requests).
 *
 * Bounds: the SVG draws at most `GRAPH_DRAW_BUDGET` entries worst-first (the cap can only
 * remove clean evidence, and states drawn-of-total); the table windows above
 * `PROJECTION_TABLE_VIRTUALIZE_ABOVE` with truthful `aria-rowcount`/`aria-rowindex` and
 * focus pinning. Motion: all transitions are `motion-safe:` so reduced motion is honoured.
 */

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  Loader2,
  Network,
  RotateCcw,
  ShieldAlert,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { cn } from '@lib/utils';
import {
  ProjectionColumnHeading,
  ProjectionEntryConnectors,
  ProjectionFocusRing,
  ProjectionNodeBox,
  ProjectionOutcomeBox,
} from '../export/projectionGraphSvg';
import {
  buildConversionProjectionRows,
  buildConversionProjectionView,
  buildProjectionTableRows,
  CONVERSION_LANES,
  CONVERSION_SCOPE_LABEL,
  conversionEntryAriaLabel,
  conversionLaneLabel,
  conversionProjectionMermaid,
  conversionStatusPresentation,
  conversionViewStatusCounts,
  projectionGraphLayout,
  reconcileConversionCounts,
  selectDrawnGraphEntries,
  type ConversionLaneKey,
  type ConversionProjectionRow,
  type ProjectionTableRow,
} from './conversionProjectionGraph';
import { ConversionEvidenceDrawer, StatusText } from './ConversionEvidenceDrawer';
import { useConversionProjection } from './useConversionProjection';
import type { ConversionManifestSummary } from '@/app/utils/conversion-projection';
import { CONVERSION_PROJECTION_STATUSES } from '@/app/utils/conversion-projection';
import type { ConversionDefaults, FidelityReport } from '@/app/utils/conversion-fidelity';
import {
  GRAPH_DRAW_BUDGET,
  PROJECTION_TABLE_VIRTUALIZE_ABOVE,
} from '@/app/utils/preview-budgets';
import { computeWindowedRange } from '@/app/utils/windowed-rows';

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;
const ZOOM_STEP = 0.25;

/** Uniform evidence-table row height (px) the windowing assumes; matches the `h-9` row class. */
const TABLE_ROW_HEIGHT = 36;

/** Height (px) of the windowed table viewport; matches the `h-72` container class. */
const TABLE_HEIGHT = 288;

export interface ConversionProjectionGraphPanelProps {
  /** The catalog item id (a project id) whose conversion is being previewed. */
  itemId: string;
  /** Only fetch while true (the preview's projection section is expanded). */
  enabled: boolean;
  /** The dry-run response's embedded `projection` summary, for snapshot cross-checking. */
  envelopeSummary?: ConversionManifestSummary | null;
  /** Aggregation threshold override; tests pass a small value. */
  aggregationThreshold?: number;
  /** SVG draw-budget override; tests pass a small value. */
  drawBudget?: number;
  /** Table windowing threshold override; tests pass a small value. */
  tableVirtualizeAbove?: number;
  /** Table viewport height override; tests pass a small value to exercise real windowing. */
  tableViewportHeight?: number;
  /** Page-size override; tests pass a small value to exercise the cursor walk. */
  pageLimit?: number;
  /** The dialog's fidelity report, so the evidence drawer can cite its finding (CPDO-3.2). */
  report?: FidelityReport | null;
  /** The approved gap-filling defaults the previewed snapshot was computed with. */
  defaults?: ConversionDefaults;
  /**
   * Approve a safe-default change from the evidence drawer. The owner must recompute the
   * fidelity report and this graph together (it does so by re-running the dry-run and
   * passing the new defaults back down via {@link ConversionProjectionGraphPanelProps.defaults}).
   */
  onApplyDefaults?: (defaults: ConversionDefaults) => void;
  /** True while the owner is recomputing the report; the drawer's form waits. */
  recomputing?: boolean;
}

export function ConversionProjectionGraphPanel({
  itemId,
  enabled,
  envelopeSummary,
  aggregationThreshold,
  drawBudget = GRAPH_DRAW_BUDGET,
  tableVirtualizeAbove = PROJECTION_TABLE_VIRTUALIZE_ABOVE,
  tableViewportHeight = TABLE_HEIGHT,
  pageLimit,
  report,
  defaults,
  onApplyDefaults,
  recomputing,
}: ConversionProjectionGraphPanelProps) {
  const { summary, nodes, edges, loading, error, integrityIssues, complete, loadMore, retry } =
    useConversionProjection(enabled, itemId, pageLimit, defaults);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  /** The node whose SVG group currently holds DOM focus, for the drawn focus outline. */
  const [focusedNodeKey, setFocusedNodeKey] = useState<string | null>(null);
  const [expandedAggregates, setExpandedAggregates] = useState<Set<string>>(new Set());
  const [tableScrollTop, setTableScrollTop] = useState(0);
  /** Display-row index of the table row whose button holds focus, for focus pinning. */
  const [focusedTableIndex, setFocusedTableIndex] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1);
  const [copied, setCopied] = useState(false);
  const nodeRefs = useRef<Map<string, SVGGElement>>(new Map());
  const graphViewportRef = useRef<HTMLDivElement | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const captionId = useId();

  useEffect(() => () => {
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
  }, []);

  const rows = useMemo(() => buildConversionProjectionRows(nodes, edges), [nodes, edges]);
  const view = useMemo(
    () => buildConversionProjectionView(rows, aggregationThreshold),
    [rows, aggregationThreshold],
  );
  // The SVG draws a worst-first bounded subset; the table below always carries everything.
  const drawnSelection = useMemo(
    () => selectDrawnGraphEntries(view.entries, drawBudget),
    [view.entries, drawBudget],
  );
  const layout = useMemo(
    () => projectionGraphLayout(drawnSelection.drawn, CONVERSION_LANES),
    [drawnSelection.drawn],
  );
  // Legend counts stay over the FULL view — the cap bounds drawing, never the statement.
  const counts = useMemo(() => conversionViewStatusCounts(view.entries), [view.entries]);
  const mermaidText = useMemo(() => conversionProjectionMermaid(view.entries), [view.entries]);
  // Counts are only claimed against the manifest once the walk is complete.
  const reconciliation = useMemo(
    () => (complete && summary ? reconcileConversionCounts(summary, rows) : []),
    [complete, summary, rows],
  );
  const snapshotMismatch =
    envelopeSummary != null &&
    summary != null &&
    envelopeSummary.manifest_hash !== summary.manifest_hash;

  const selectedEntry = useMemo(
    () => view.entries.find((entry) => entry.key === selectedKey) ?? null,
    [view.entries, selectedKey],
  );

  // The drawn entry holding the roving tabindex, clamped in case the drawn set shrank.
  const graphFocusIndex = Math.min(focusIndex, Math.max(0, drawnSelection.drawn.length - 1));

  /** Escape resets the view: selection cleared, zoom back to 1, viewport scrolled home. */
  const resetView = () => {
    setSelectedKey(null);
    setZoom(1);
    graphViewportRef.current?.scrollTo?.(0, 0);
  };

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

  const copyMermaid = async () => {
    try {
      await navigator.clipboard.writeText(mermaidText);
      setCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard denied — the download affordance remains.
    }
  };

  const downloadMermaid = () => {
    const blob = new Blob([mermaidText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'conversion-projection.mmd';
    anchor.click();
    URL.revokeObjectURL(url);
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
  // scrolled out of the window, or focus (and the Tab stop) would fall off the table.
  const pinnedTableIndex =
    tableVirtualized &&
    focusedTableIndex !== null &&
    focusedTableIndex < tableRows.length &&
    (focusedTableIndex < tableWindow.startIndex || focusedTableIndex >= tableWindow.endIndex)
      ? focusedTableIndex
      : null;

  /** One spacer row standing in for `height` px of unmounted display rows. */
  const spacerRow = (key: string, height: number): ReactNode =>
    height > 0 ? (
      <tr key={key} aria-hidden style={{ height }} data-testid="conversion-projection-table-spacer">
        <td colSpan={5} className="p-0" />
      </tr>
    ) : null;

  /** Render one display row (entry, aggregate toggle, or expanded member). */
  const renderTableRow = (
    row: ProjectionTableRow<ConversionLaneKey>,
    index: number,
  ): ReactNode => {
    const ariaRowIndex = row.bodyRowIndex + 1; // +1 for the header row.
    if (row.kind === 'member') {
      const member = row.member as ConversionProjectionRow;
      return (
        <tr
          key={row.key}
          aria-rowindex={ariaRowIndex}
          onFocus={() => setFocusedTableIndex(index)}
          className="h-9 whitespace-nowrap border-b border-gray-50 bg-gray-50/50 dark:border-gray-800/50 dark:bg-gray-900/30"
          data-testid={`conversion-projection-aggregate-member-${member.id}`}
        >
          <td className="px-2 py-1" />
          <td className="max-w-56 truncate px-2 py-1 font-mono text-gray-600 dark:text-gray-300">
            {member.construct}
          </td>
          <td className="max-w-56 truncate px-2 py-1 font-mono text-gray-500 dark:text-gray-400">
            {member.targetLocation ?? '—'}
          </td>
          <td className="px-2 py-1 text-gray-500 dark:text-gray-400">
            {CONVERSION_SCOPE_LABEL[member.scope]}
          </td>
          <td className="px-2 py-1 text-gray-500 dark:text-gray-400">
            <span className="block max-w-md truncate">{member.reasonSummary}</span>
          </td>
        </tr>
      );
    }
    if (row.entry.kind === 'aggregate') {
      const entry = row.entry;
      const members = entry.members ?? [];
      const first = members[0] as ConversionProjectionRow | undefined;
      const presentation = first
        ? conversionStatusPresentation(first.conversionStatus)
        : conversionStatusPresentation('retained');
      const expanded = expandedAggregates.has(entry.key);
      return (
        <tr
          key={row.key}
          aria-rowindex={ariaRowIndex}
          className="h-9 whitespace-nowrap border-b border-gray-100 dark:border-gray-800"
        >
          <td className="px-2 py-1.5">
            <StatusText presentation={presentation} />
          </td>
          <td className="px-2 py-1.5" colSpan={4}>
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => toggleAggregate(entry.key)}
              onFocus={() => setFocusedTableIndex(index)}
              aria-label={conversionEntryAriaLabel(entry)}
              data-testid={`conversion-projection-aggregate-toggle-${entry.lane}-${entry.status}`}
              className="text-gray-700 underline-offset-2 hover:underline dark:text-gray-200"
            >
              {members.length} construct{members.length === 1 ? '' : 's'}{' '}
              {presentation.label.toLowerCase()} in {conversionLaneLabel(entry.lane)} (aggregated)
              — {expanded ? 'collapse' : 'expand'}
            </button>
          </td>
        </tr>
      );
    }
    const entry = row.entry;
    const entryRow = entry.row as ConversionProjectionRow;
    const presentation = conversionStatusPresentation(entryRow.conversionStatus);
    const selected = entry.key === selectedKey;
    return (
      <tr
        key={row.key}
        aria-rowindex={ariaRowIndex}
        className={cn(
          'h-9 whitespace-nowrap border-b border-gray-100 last:border-0 dark:border-gray-800',
          selected && 'bg-indigo-50 dark:bg-indigo-950/30',
        )}
        data-testid={`conversion-projection-table-row-${entry.key}`}
      >
        <td className="px-2 py-1.5">
          <StatusText presentation={presentation} />
        </td>
        <td className="px-2 py-1.5">
          <button
            type="button"
            onClick={() => setSelectedKey(entry.key)}
            onFocus={() => setFocusedTableIndex(index)}
            aria-pressed={selected}
            aria-label={conversionEntryAriaLabel(entry)}
            className="max-w-56 truncate font-mono text-gray-800 underline-offset-2 hover:underline dark:text-gray-100"
          >
            {entryRow.construct}
          </button>
        </td>
        <td className="max-w-56 truncate px-2 py-1.5 font-mono text-gray-600 dark:text-gray-300">
          {entryRow.targetLocation ?? '—'}
        </td>
        <td className="px-2 py-1.5 text-gray-600 dark:text-gray-300">
          {CONVERSION_SCOPE_LABEL[entryRow.scope]}
        </td>
        <td className="px-2 py-1.5 text-gray-600 dark:text-gray-300">
          <span className="block max-w-md truncate">
            {entryRow.reason ? <span className="font-mono">{entryRow.reason}</span> : null}
            {entryRow.reason ? ' — ' : ''}
            {entryRow.reasonSummary}
          </span>
        </td>
      </tr>
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
    <section
      data-testid="conversion-projection-panel"
      aria-label="Projection graph"
      className="projection-panel space-y-3 rounded-xl border border-gray-200 p-4 dark:border-gray-700"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          resetView();
        }
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-900 dark:text-gray-100">
          <Network className="h-4 w-4 text-indigo-500" aria-hidden />
          Projection graph
        </div>
        {summary && (
          <span
            data-testid="conversion-projection-snapshot"
            title={`Projection snapshot ${summary.manifest_hash}`}
            className="rounded-full bg-gray-100 px-2 py-0.5 font-mono text-[10px] text-gray-600 dark:bg-gray-800 dark:text-gray-300"
          >
            snapshot {summary.manifest_hash.slice(0, 12)}
          </span>
        )}
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Which source construct becomes which OpenAPI construct, and why anything does not, from
        the server&apos;s projection manifest. The table below is the accessible source of truth
        — both show the same evidence.
      </p>

      {loading && rows.length === 0 && (
        <div
          data-testid="conversion-projection-loading"
          className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300"
        >
          <Loader2 className="h-4 w-4 motion-safe:animate-spin text-indigo-500" aria-hidden />
          Loading the projection graph…
        </div>
      )}

      {error && (
        <div
          data-testid="conversion-projection-error"
          className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
        >
          <AlertTriangle className="mr-1.5 inline h-4 w-4 align-text-bottom" aria-hidden />
          The projection graph could not be loaded — the fidelity report above still reflects
          this conversion. {error}{' '}
          <button
            type="button"
            onClick={retry}
            data-testid="conversion-projection-retry"
            className="font-medium underline underline-offset-2"
          >
            Retry
          </button>
        </div>
      )}

      {integrityIssues.length > 0 && (
        <div
          data-testid="conversion-projection-integrity-error"
          className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
        >
          <ShieldAlert className="mr-1.5 inline h-4 w-4 align-text-bottom" aria-hidden />
          The projection evidence failed its integrity check and was not rendered (
          {integrityIssues.length} issue{integrityIssues.length === 1 ? '' : 's'}). Re-run the
          preview, or report this if it persists.
        </div>
      )}

      {integrityIssues.length === 0 && summary && (
        <>
          {snapshotMismatch && (
            <div
              data-testid="conversion-projection-mismatch"
              className="rounded-lg border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
            >
              This graph describes snapshot{' '}
              <code className="font-mono">{summary.manifest_hash.slice(0, 12)}</code>, but the
              fidelity report above was computed for{' '}
              <code className="font-mono">{envelopeSummary?.manifest_hash.slice(0, 12)}</code> —
              the source changed in between. Re-open the preview for one consistent view.
            </div>
          )}

          {reconciliation.length > 0 && (
            <div
              data-testid="conversion-projection-reconciliation"
              className="rounded-lg border border-rose-300 bg-rose-50 p-2.5 text-xs text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
            >
              The loaded evidence does not reconcile with the manifest&apos;s own counts:{' '}
              {reconciliation.join('; ')}.
            </div>
          )}

          {summary.truncated && (
            <p
              data-testid="conversion-projection-server-truncation"
              className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-800 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200"
              role="status"
            >
              The server bounded this manifest: {summary.dropped_edge_count.toLocaleString()}{' '}
              construct/analysis edges beyond its limits were left out (worst outcomes were
              admitted first). Checklist and loss evidence is never bounded.
            </p>
          )}

          {/* Legend: every wire status present, as text + symbol + count — full-view counts. */}
          <div
            className="flex flex-wrap items-center gap-1.5"
            data-testid="conversion-projection-legend"
          >
            {CONVERSION_PROJECTION_STATUSES.map((status) => {
              const count = counts[status];
              if (!count) return null;
              const p = conversionStatusPresentation(status);
              return (
                <span
                  key={status}
                  data-testid={`conversion-projection-legend-${status}`}
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

          {!complete && !error && (
            <p
              role="status"
              data-testid="conversion-projection-partial"
              className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-800 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200"
            >
              Loaded {rows.length.toLocaleString()} of {summary.edge_count.toLocaleString()}{' '}
              evidence rows — this view is incomplete.{' '}
              <button
                type="button"
                onClick={loadMore}
                disabled={loading}
                data-testid="conversion-projection-load-more"
                className="font-medium underline underline-offset-2 disabled:opacity-50"
              >
                {loading ? 'Loading…' : 'Load more'}
              </button>
            </p>
          )}

          {complete && rows.length === 0 && (
            <p
              className="rounded-lg border border-dashed border-gray-200 px-3 py-4 text-xs text-gray-400 dark:border-gray-700 dark:text-gray-500"
              data-testid="conversion-projection-empty"
            >
              The manifest carried no projection evidence for this conversion.
            </p>
          )}

          {view.entries.length > 0 && (
            <>
              {view.aggregated && (
                <p
                  className="text-[11px] text-gray-500 dark:text-gray-400"
                  data-testid="conversion-projection-aggregated-note"
                >
                  Clean rows are aggregated to keep the graph readable; expand them in the table
                  below. Dropped, unavailable, and inferred evidence is never aggregated.
                </p>
              )}

              {/* The draw budget is never silent: state drawn-of-total and the path to all. */}
              {drawnSelection.truncated && (
                <p
                  role="status"
                  className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-800 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200"
                  data-testid="conversion-projection-draw-cap"
                >
                  Drawing {drawnSelection.drawnRowCount.toLocaleString()} of{' '}
                  {drawnSelection.totalRowCount.toLocaleString()} constructs (worst first) to
                  keep the graph responsive — the table below lists every construct.
                </p>
              )}

              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-medium text-gray-700 dark:text-gray-300">Graph</span>
                <div className="flex items-center gap-1">
                  <div className="flex items-center gap-1" role="group" aria-label="Graph zoom">
                    <button
                      type="button"
                      data-testid="conversion-projection-zoom-out"
                      aria-label="Zoom out"
                      disabled={zoom <= MIN_ZOOM}
                      onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z - ZOOM_STEP))}
                      className="rounded-md border border-gray-200 p-1 text-gray-600 hover:bg-gray-50 disabled:opacity-40 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                    >
                      <ZoomOut className="h-3.5 w-3.5" aria-hidden />
                    </button>
                    <button
                      type="button"
                      data-testid="conversion-projection-zoom-in"
                      aria-label="Zoom in"
                      disabled={zoom >= MAX_ZOOM}
                      onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z + ZOOM_STEP))}
                      className="rounded-md border border-gray-200 p-1 text-gray-600 hover:bg-gray-50 disabled:opacity-40 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                    >
                      <ZoomIn className="h-3.5 w-3.5" aria-hidden />
                    </button>
                    <button
                      type="button"
                      data-testid="conversion-projection-reset-view"
                      aria-label="Reset view"
                      onClick={resetView}
                      className="rounded-md border border-gray-200 p-1 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                    >
                      <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </div>
                  <button
                    type="button"
                    data-testid="conversion-projection-copy-mermaid"
                    onClick={copyMermaid}
                    className="flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-[11px] font-medium text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                  >
                    {copied ? (
                      <Check className="h-3.5 w-3.5" aria-hidden />
                    ) : (
                      <Copy className="h-3.5 w-3.5" aria-hidden />
                    )}
                    {copied ? 'Copied' : 'Copy Mermaid'}
                  </button>
                  <button
                    type="button"
                    data-testid="conversion-projection-download-mermaid"
                    aria-label="Download Mermaid text"
                    onClick={downloadMermaid}
                    className="rounded-md border border-gray-200 p-1 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                  >
                    <Download className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </div>
              </div>

              {/* The graph. Pan by scrolling the (focusable) viewport; zoom scales the canvas.
                  Its accessible name is the table caption — the text alternative. */}
              <div
                ref={graphViewportRef}
                tabIndex={0}
                role="region"
                aria-label="Projection graph viewport. Scroll to pan; Tab into the graph, then arrow keys move between constructs; Enter selects; Escape resets the view."
                className="max-h-80 overflow-auto rounded-lg border border-gray-100 dark:border-gray-800"
                data-testid="conversion-projection-viewport"
              >
                <svg
                  data-testid="conversion-projection-svg"
                  role="group"
                  aria-labelledby={captionId}
                  width={layout.width * zoom}
                  height={layout.height * zoom}
                  viewBox={`0 0 ${layout.width} ${layout.height}`}
                  className="block"
                >
                  <ProjectionColumnHeading x={layout.columns.source} label="Source / native" />
                  <ProjectionColumnHeading x={layout.columns.canonical} label="Construct" />
                  <ProjectionColumnHeading x={layout.columns.outcome} label="OpenAPI outcome" />

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
                    <ProjectionEntryConnectors key={placed.entry.key} placed={placed} />
                  ))}

                  {layout.entries.map((placed, index) => {
                    const { entry } = placed;
                    const isSelected = entry.key === selectedKey;
                    const entryRow = entry.row as ConversionProjectionRow | undefined;
                    const presentation = entryRow
                      ? conversionStatusPresentation(entryRow.conversionStatus)
                      : conversionStatusPresentation(
                          entry.status === 'synthesized'
                            ? 'inferred'
                            : (entry.status as ConversionProjectionRow['conversionStatus']),
                        );
                    return (
                      <g
                        key={entry.key}
                        data-testid={`conversion-projection-node-${entry.key}`}
                        data-status={entryRow?.conversionStatus ?? entry.status}
                        role="button"
                        tabIndex={index === graphFocusIndex ? 0 : -1}
                        aria-label={conversionEntryAriaLabel(entry)}
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
                        onBlur={() =>
                          setFocusedNodeKey((prev) => (prev === entry.key ? null : prev))
                        }
                        onKeyDown={(event) => handleNodeKeyDown(event, index)}
                        className="cursor-pointer outline-none"
                      >
                        {/* Visible keyboard-focus outline (WCAG 2.4.7). */}
                        {focusedNodeKey === entry.key && (
                          <ProjectionFocusRing
                            placed={placed}
                            testId="conversion-projection-focus-ring"
                          />
                        )}
                        {placed.sourceBox && (
                          <ProjectionNodeBox
                            box={placed.sourceBox}
                            label={entryRow?.sourceLabel ?? ''}
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
                          presentation={presentation}
                          selected={isSelected}
                          location={entryRow?.targetLocation ?? null}
                        />
                      </g>
                    );
                  })}
                </svg>
              </div>

              {/* Selection → the evidence drawer (CPDO-3.2), announced politely. */}
              <div aria-live="polite">
                {selectedEntry && (
                  <ConversionEvidenceDrawer
                    entry={selectedEntry}
                    summary={summary}
                    report={report}
                    currentDefaults={defaults}
                    recomputing={recomputing}
                    onClose={() => setSelectedKey(null)}
                    onApplyDefaults={onApplyDefaults}
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
                data-testid="conversion-projection-table-viewport"
              >
                <table
                  className="w-full text-left text-xs"
                  data-testid="conversion-projection-table"
                  aria-rowcount={tableRows.length + 1}
                >
                  <caption id={captionId} className="sr-only">
                    Conversion projection evidence — the accessible equivalent of the projection
                    graph. Every graph node has one row here with the same status, construct,
                    landing location, scope, and reason.
                  </caption>
                  <thead>
                    <tr
                      aria-rowindex={1}
                      className="border-b border-gray-200 text-[10px] uppercase tracking-wide text-gray-500 dark:border-gray-700 dark:text-gray-400"
                    >
                      <th scope="col" className="px-2 py-1.5">Status</th>
                      <th scope="col" className="px-2 py-1.5">Construct</th>
                      <th scope="col" className="px-2 py-1.5">Lands at</th>
                      <th scope="col" className="px-2 py-1.5">Scope</th>
                      <th scope="col" className="px-2 py-1.5">Reason</th>
                    </tr>
                  </thead>
                  <tbody>{bodyRows}</tbody>
                </table>
              </div>
              {tableVirtualized && (
                <p
                  className="text-[10px] text-gray-500 dark:text-gray-400"
                  data-testid="conversion-projection-table-windowed"
                >
                  The table is windowed — every one of its {tableRows.length.toLocaleString()}{' '}
                  rows is reachable by scrolling.
                </p>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

export default ConversionProjectionGraphPanel;
