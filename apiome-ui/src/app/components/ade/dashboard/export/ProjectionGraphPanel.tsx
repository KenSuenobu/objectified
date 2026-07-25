'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Loader2,
  Network,
  RotateCcw,
  ShieldAlert,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { sanitizeDocumentationEvidence } from './capabilityRegistry';
import { EvidenceDrawer } from './EvidenceDrawer';
import {
  categoryForReason,
  documentationLink,
  reasonCategoryPresentation,
} from './lossExplanation';
import type { ProjectionManifestSummary } from './exportFidelityPreview';
import { PROJECTION_STATUSES } from './projectionEvidence';
import {
  buildEvidenceRows,
  buildProjectionView,
  entryAriaLabel,
  projectionGraphLayout,
  statusPresentation,
  type ProjectionEvidenceRow,
  type ProjectionGraphLayout,
  type ProjectionViewEntry,
} from './projectionGraph';
import {
  ProjectionColumnHeading,
  ProjectionEntryConnectors,
  ProjectionNodeBox,
  ProjectionOutcomeBox,
} from './projectionGraphSvg';
import { useCapabilityReasons } from './useCapabilityReasons';
import { useProjectionEvidence } from './useProjectionEvidence';
import { trackProjectionMetric } from './projectionMetrics';

/** Zoom bounds/step for the graph view (pure scale; layout stays deterministic). */
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;
const ZOOM_STEP = 0.25;

export interface ProjectionGraphPanelProps {
  /** The artifact (project) id being exported. */
  artifact: string;
  /** The revision (UUID or label); the latest revision when null. */
  version?: string | null;
  /** The chosen target emitter key (e.g. `proto`); the panel is idle while null. */
  target: string | null;
  /** Human label of the chosen target format (e.g. `gRPC / Protobuf`). */
  targetLabel: string;
  /**
   * The changed (non-default) option overrides the surface's preview/verify request used,
   * or null. Must match that request so the evidence describes the same snapshot.
   */
  options?: Record<string, unknown> | null;
  /**
   * The projection summary embedded in the surface's fidelity envelope, when it has one.
   * Used to cross-check snapshot identity: evidence for a different snapshot than the
   * summary the user is reading gets an explicit staleness warning.
   */
  envelopeProjection?: ProjectionManifestSummary | null;
  /** Only fetch/render while truthy (the surface's fidelity view is showing). */
  enabled?: boolean;
  /**
   * Navigate back to the surface's target choice — the evidence drawer's safe remediation
   * for a destination format limit (EFP-2.3). The navigation changes nothing by itself; an
   * actual target change re-previews, invalidates the acknowledgement, and refreshes the
   * graph and report together. Omitted → the drawer offers no target action.
   */
  onChangeTarget?: () => void;
  /**
   * Navigate back to the surface's export options — the drawer's safe remediation for an
   * option exclusion (EFP-2.3). Same contract as {@link onChangeTarget}.
   */
  onChangeOptions?: () => void;
}

/**
 * ProjectionGraphPanel — the destination-aware projection map (EFP-2.2, #4814).
 *
 * Renders, from the server manifest only (the EFP-2.1 evidence pages — nothing is inferred
 * client-side), where each source construct lands in the chosen destination: a deterministic
 * three-column SVG graph (source/native → canonical → destination, with the destination
 * banded into "in the destination" / "omitted" / "unavailable" lanes) and a synchronized
 * table. Both render from one shared view model (`buildProjectionView`), so their counts,
 * statuses, and evidence rows are identical by construction; the table is the accessibility
 * source of truth and every graph interaction has a table equivalent.
 *
 * Selection (pointer or keyboard) opens the evidence detail card: construct, status,
 * severity, reason category and summary, destination location, source-native provenance,
 * and the reason-scoped documentation link (host-allowlisted, EFP-1.2). Keyboard: graph
 * nodes form a roving-tabindex list (arrows/Home/End move, Enter/Space select); Escape
 * resets selection and zoom. Zoom in/out/reset are plain buttons. Status is conveyed by
 * text label + symbol + stroke pattern; colour is supplemental. Transitions are
 * `motion-safe:` only, honouring reduced-motion preferences.
 *
 * Large manifests aggregate deterministically (documented in `projectionGraph.ts`):
 * only clean info-severity outcomes collapse — dropped, unavailable, approximated,
 * synthesized, warn, and critical evidence always stays individually visible — and the
 * full status counts always come from the manifest summary, so partial evidence loading
 * (the "Load more" walk) never under-reports.
 *
 * The panel is purely explanatory: a fetch failure degrades to a quiet notice and never
 * affects the export/acknowledgement gates.
 */
export function ProjectionGraphPanel({
  artifact,
  version = null,
  target,
  targetLabel,
  options = null,
  envelopeProjection = null,
  enabled = true,
  onChangeTarget,
  onChangeOptions,
}: ProjectionGraphPanelProps) {
  const { summary, nodes, edges, redacted, loading, error, integrityIssues, complete, loadMore } =
    useProjectionEvidence(Boolean(enabled) && Boolean(target), artifact, version, target, options);
  // The reviewed reason explanations + remediation guidance the evidence drawer prints
  // (EFP-2.3). Static reference data, fetched once per page load and shared.
  const { reasons } = useCapabilityReasons(Boolean(enabled) && Boolean(target));

  const rows = useMemo(() => buildEvidenceRows(nodes, edges), [nodes, edges]);
  const view = useMemo(() => buildProjectionView(rows), [rows]);
  const layout = useMemo(() => projectionGraphLayout(view.entries), [view]);

  /** The selected entry key, shared by the graph and the table (the synchronization). */
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  /** Roving-tabindex position among the graph nodes. */
  const [focusIndex, setFocusIndex] = useState(0);
  const nodeRefs = useRef(new Map<string, SVGGElement>());

  const selected = useMemo(
    () => view.entries.find((entry) => entry.key === selectedKey) ?? null,
    [view, selectedKey],
  );

  // Fire once per aggregated view (EFP-3.2 privacy-safe telemetry — counts only).
  const aggregationReported = useRef(false);
  const optionsKey = useMemo(() => JSON.stringify(options ?? null), [options]);
  useEffect(() => {
    aggregationReported.current = false;
  }, [artifact, version, target, optionsKey]);
  useEffect(() => {
    if (!view.aggregated || aggregationReported.current) return;
    aggregationReported.current = true;
    void trackProjectionMetric({ kind: 'aggregation_used', page_total: view.rowCount });
  }, [view.aggregated, view.rowCount]);

  const selectEntry = useCallback((key: string | null) => {
    setSelectedKey((current) => (current === key ? null : key));
  }, []);

  /** Escape resets the view: selection cleared, zoom back to 1 (EFP-2.2 "reset the view"). */
  const resetView = useCallback(() => {
    setSelectedKey(null);
    setZoom(1);
    setFocusIndex(0);
  }, []);

  const moveFocus = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(view.entries.length - 1, index));
      setFocusIndex(clamped);
      const key = view.entries[clamped]?.key;
      if (key) nodeRefs.current.get(key)?.focus?.();
    },
    [view],
  );

  /** Keyboard navigation over the graph nodes (roving tabindex). */
  const handleNodeKeyDown = useCallback(
    (event: KeyboardEvent, entry: ProjectionViewEntry, index: number) => {
      switch (event.key) {
        case 'Enter':
        case ' ':
        case 'Spacebar':
          event.preventDefault();
          selectEntry(entry.key);
          break;
        case 'ArrowDown':
        case 'ArrowRight':
          event.preventDefault();
          moveFocus(index + 1);
          break;
        case 'ArrowUp':
        case 'ArrowLeft':
          event.preventDefault();
          moveFocus(index - 1);
          break;
        case 'Home':
          event.preventDefault();
          moveFocus(0);
          break;
        case 'End':
          event.preventDefault();
          moveFocus(view.entries.length - 1);
          break;
        default:
          break;
      }
    },
    [selectEntry, moveFocus, view],
  );

  if (!target || !enabled) return null;

  const snapshotHash = summary?.manifest_hash ?? null;
  const snapshotMismatch = Boolean(
    envelopeProjection && snapshotHash && envelopeProjection.manifest_hash !== snapshotHash,
  );
  const loadedRowCount = view.rowCount;
  const totalEvidence = summary?.evidence_count ?? loadedRowCount;

  return (
    <section
      data-testid="projection-panel"
      aria-label={`Projection map for ${targetLabel}`}
      className="projection-panel rounded-xl border border-gray-200 p-4 dark:border-gray-700"
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
          Projection map
        </div>
        {snapshotHash && (
          <span
            data-testid="projection-snapshot"
            title={`Projection snapshot ${snapshotHash}`}
            className="rounded-full bg-gray-100 px-2 py-0.5 font-mono text-[10px] text-gray-600 dark:bg-gray-800 dark:text-gray-300"
          >
            snapshot {snapshotHash.slice(0, 12)}
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        Where this source&apos;s constructs land in {targetLabel}, from the server&apos;s
        projection manifest. The table below is the accessible equivalent of the graph —
        both show the same evidence.
      </p>

      {loading && view.entries.length === 0 && (
        <div
          data-testid="projection-loading"
          className="mt-4 flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300"
        >
          <Loader2 className="h-4 w-4 animate-spin text-indigo-500" aria-hidden />
          Loading the projection evidence…
        </div>
      )}

      {error && (
        <div
          data-testid="projection-error"
          className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
        >
          <AlertTriangle className="mr-1.5 inline h-4 w-4 align-text-bottom" aria-hidden />
          The projection evidence could not be loaded — the fidelity summary above still
          reflects this conversion. {error}
        </div>
      )}

      {integrityIssues.length > 0 && (
        <div
          data-testid="projection-integrity-error"
          className="mt-4 rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
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
              data-testid="projection-mismatch"
              className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
            >
              This evidence describes snapshot{' '}
              <code className="font-mono">{snapshotHash?.slice(0, 12)}</code>, but the fidelity
              summary above was computed for{' '}
              <code className="font-mono">{envelopeProjection?.manifest_hash.slice(0, 12)}</code>{' '}
              — the source changed in between. Re-run the preview for one consistent view.
            </div>
          )}
          {redacted && (
            <p data-testid="projection-redacted" className="mt-3 text-xs text-gray-500 dark:text-gray-400">
              Source-native evidence values were redacted for this view.
            </p>
          )}

          <StatusChips summary={summary} />

          {view.entries.length > 0 && (
            <>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-medium text-gray-700 dark:text-gray-300">
                  Graph
                  {view.aggregated && (
                    <span data-testid="projection-aggregated-note" className="ml-2 font-normal text-gray-500 dark:text-gray-400">
                      · clean outcomes aggregated; every dropped, unavailable, or critical
                      construct is shown individually
                    </span>
                  )}
                </span>
                <div className="flex items-center gap-1" role="group" aria-label="Graph zoom">
                  <button
                    type="button"
                    data-testid="projection-zoom-out"
                    aria-label="Zoom out"
                    disabled={zoom <= MIN_ZOOM}
                    onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z - ZOOM_STEP))}
                    className="rounded-md border border-gray-200 p-1 text-gray-600 hover:bg-gray-50 disabled:opacity-40 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                  >
                    <ZoomOut className="h-3.5 w-3.5" aria-hidden />
                  </button>
                  <button
                    type="button"
                    data-testid="projection-zoom-in"
                    aria-label="Zoom in"
                    disabled={zoom >= MAX_ZOOM}
                    onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z + ZOOM_STEP))}
                    className="rounded-md border border-gray-200 p-1 text-gray-600 hover:bg-gray-50 disabled:opacity-40 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                  >
                    <ZoomIn className="h-3.5 w-3.5" aria-hidden />
                  </button>
                  <button
                    type="button"
                    data-testid="projection-reset-view"
                    aria-label="Reset view"
                    onClick={resetView}
                    className="rounded-md border border-gray-200 p-1 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                  >
                    <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </div>
              </div>

              <ProjectionGraphSvg
                layout={layout}
                zoom={zoom}
                selectedKey={selectedKey}
                focusIndex={focusIndex}
                nodeRefs={nodeRefs}
                onSelect={selectEntry}
                onNodeKeyDown={handleNodeKeyDown}
                onFocusIndex={setFocusIndex}
              />
            </>
          )}

          <ProjectionTable
            entries={view.entries}
            selectedKey={selectedKey}
            onSelect={selectEntry}
          />

          {!complete && !loading && (
            <div className="mt-3 flex items-center justify-between gap-2">
              <span className="text-xs text-gray-500 dark:text-gray-400">
                Showing the first {loadedRowCount} of {totalEvidence} evidence rows — the
                status counts above cover the whole manifest.
              </span>
              <button
                type="button"
                data-testid="projection-load-more"
                onClick={loadMore}
                className="rounded-md border border-indigo-200 px-2.5 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-50 dark:border-indigo-800 dark:text-indigo-300 dark:hover:bg-indigo-950/40"
              >
                Load more evidence
              </button>
            </div>
          )}
          {loading && view.entries.length > 0 && (
            <div className="mt-3 flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-500" aria-hidden />
              Loading more evidence…
            </div>
          )}

          <div aria-live="polite">
            {selected && (
              <EvidenceDrawer
                entry={selected}
                summary={summary}
                reasons={reasons}
                onClose={() => setSelectedKey(null)}
                onChangeTarget={onChangeTarget}
                onChangeOptions={onChangeOptions}
              />
            )}
          </div>
        </>
      )}
    </section>
  );
}

/**
 * The full-manifest status chips: count + symbol + text label per status, from the
 * snapshot summary — the whole manifest's truth even while evidence pages are still
 * loading. Colour is supplemental to the symbol/text.
 */
function StatusChips({ summary }: { summary: ProjectionManifestSummary }) {
  const chips = PROJECTION_STATUSES.filter(
    (status) => (summary.status_counts[status] ?? 0) > 0,
  );
  if (chips.length === 0) return null;
  return (
    <div data-testid="projection-chips" className="mt-3 flex flex-wrap items-center gap-2">
      {chips.map((status) => {
        const p = statusPresentation(status);
        return (
          <span
            key={status}
            data-testid={`projection-chip-${status}`}
            className={`rounded-full px-2 py-0.5 text-xs font-semibold ${p.badgeClass}`}
          >
            <span aria-hidden>{p.symbol} </span>
            {summary.status_counts[status]} {p.label.toLowerCase()}
          </span>
        );
      })}
    </div>
  );
}

interface ProjectionGraphSvgProps {
  layout: ProjectionGraphLayout;
  zoom: number;
  selectedKey: string | null;
  focusIndex: number;
  nodeRefs: { current: Map<string, SVGGElement> };
  onSelect: (key: string) => void;
  onNodeKeyDown: (event: KeyboardEvent, entry: ProjectionViewEntry, index: number) => void;
  onFocusIndex: (index: number) => void;
}

/**
 * The deterministic SVG renderer. Draws the precomputed layout verbatim — no client-side
 * layout engine, no Mermaid, no HTML inside the SVG; every label is a React text node in
 * an `<svg:text>` element, so untrusted source labels cannot inject markup. Nodes are
 * focusable `role="button"` groups forming a roving-tabindex list.
 */
function ProjectionGraphSvg({
  layout,
  zoom,
  selectedKey,
  focusIndex,
  nodeRefs,
  onSelect,
  onNodeKeyDown,
  onFocusIndex,
}: ProjectionGraphSvgProps) {
  return (
    <div
      data-testid="projection-graph-scroll"
      className="mt-2 max-h-80 overflow-auto rounded-lg border border-gray-100 dark:border-gray-800"
    >
      <svg
        data-testid="projection-graph"
        role="group"
        aria-label="Projection graph. Arrow keys move between constructs; Enter selects; Escape resets the view."
        width={layout.width * zoom}
        height={layout.height * zoom}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        className="block"
      >
        {/* Column headings. */}
        <ProjectionColumnHeading x={layout.columns.source} label="Source" />
        <ProjectionColumnHeading x={layout.columns.canonical} label="Canonical" />
        <ProjectionColumnHeading x={layout.columns.outcome} label="Destination" />

        {/* Lane headings + separators. */}
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

        {/* Connectors under the node boxes. */}
        {layout.entries.map((placed) => (
          <ProjectionEntryConnectors key={placed.entry.key} placed={placed} />
        ))}

        {/* Node bands (focusable, selectable). */}
        {layout.entries.map((placed, index) => {
          const { entry } = placed;
          const isSelected = entry.key === selectedKey;
          const p = statusPresentation(entry.status);
          return (
            <g
              key={entry.key}
              data-testid={`projection-node-${entry.key}`}
              data-status={entry.status}
              role="button"
              tabIndex={index === focusIndex ? 0 : -1}
              aria-label={entryAriaLabel(entry)}
              aria-pressed={isSelected}
              ref={(el) => {
                if (el) nodeRefs.current.set(entry.key, el);
                else nodeRefs.current.delete(entry.key);
              }}
              onClick={() => onSelect(entry.key)}
              onFocus={() => onFocusIndex(index)}
              onKeyDown={(event) => onNodeKeyDown(event, entry, index)}
              className="cursor-pointer outline-none"
            >
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
                location={outcomeLocation(entry)}
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/**
 * Where an entry's outcome box prints its landing location: the destination pointer, else
 * the destination node's label. Aggregates (many constructs in one box) print none.
 */
function outcomeLocation(entry: ProjectionViewEntry): string | null {
  if (entry.kind !== 'row') return null;
  return entry.row?.targetLocation ?? entry.row?.targetLabel ?? null;
}

interface ProjectionTableProps {
  entries: ProjectionViewEntry[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
}

/**
 * The synchronized table — the accessibility source of truth. Renders exactly the entries
 * the graph renders (same array), one row per entry; selecting a row selects the same
 * entry in the graph. Aggregate entries expand in place to list their member constructs.
 */
function ProjectionTable({ entries, selectedKey, onSelect }: ProjectionTableProps) {
  const [expandedAggregates, setExpandedAggregates] = useState<Set<string>>(new Set());

  if (entries.length === 0) return null;

  const toggleAggregate = (key: string) => {
    setExpandedAggregates((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="mt-3 max-h-72 overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700">
      <table data-testid="projection-table" className="w-full border-collapse text-left text-xs">
        <caption className="sr-only">
          Projection evidence — the accessible equivalent of the projection graph. Every graph
          node has one row here with the same status and evidence.
        </caption>
        <thead className="sticky top-0 bg-gray-50 dark:bg-gray-800">
          <tr className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
            <th scope="col" className="px-3 py-2 font-semibold">Status</th>
            <th scope="col" className="px-3 py-2 font-semibold">Source construct</th>
            <th scope="col" className="px-3 py-2 font-semibold">Destination</th>
            <th scope="col" className="px-3 py-2 font-semibold">Reason</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
          {entries.map((entry) => {
            const p = statusPresentation(entry.status);
            const isSelected = entry.key === selectedKey;
            const rowClass = isSelected
              ? 'bg-indigo-50 dark:bg-indigo-950/40'
              : 'motion-safe:transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/60';
            if (entry.kind === 'aggregate') {
              const expanded = expandedAggregates.has(entry.key);
              return (
                <tr key={entry.key} data-testid={`projection-row-${entry.key}`} className={rowClass}>
                  <td className="px-3 py-2 align-top">
                    <StatusCell presentation={p} />
                  </td>
                  <td className="px-3 py-2 align-top" colSpan={3}>
                    <button
                      type="button"
                      data-testid={`projection-aggregate-toggle-${entry.status}`}
                      aria-expanded={expanded}
                      onClick={() => toggleAggregate(entry.key)}
                      className="flex items-center gap-1 font-medium text-gray-900 dark:text-gray-100"
                    >
                      {expanded ? (
                        <ChevronUp className="h-3.5 w-3.5" aria-hidden />
                      ) : (
                        <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                      )}
                      {entry.label} {p.label.toLowerCase()} (aggregated)
                    </button>
                    {expanded && (
                      <ul className="mt-1.5 max-h-32 space-y-0.5 overflow-y-auto">
                        {entry.members?.map((member) => (
                          <li key={member.id} className="font-mono text-[11px] text-gray-600 dark:text-gray-300">
                            {member.construct}
                            {member.targetLocation ? (
                              <span className="text-gray-400 dark:text-gray-500"> → {member.targetLocation}</span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              );
            }
            const row = entry.row as ProjectionEvidenceRow;
            return (
              <tr key={entry.key} data-testid={`projection-row-${entry.key}`} className={rowClass}>
                <td className="px-3 py-2 align-top">
                  <StatusCell presentation={p} />
                </td>
                <td className="px-3 py-2 align-top">
                  <button
                    type="button"
                    data-testid={`projection-row-select-${entry.key}`}
                    aria-pressed={isSelected}
                    aria-label={entryAriaLabel(entry)}
                    onClick={() => onSelect(entry.key)}
                    className="break-all text-left font-mono text-[11px] font-medium text-gray-900 underline-offset-2 hover:underline dark:text-gray-100"
                  >
                    {row.construct}
                  </button>
                  {row.sourceLocation && (
                    <div className="mt-0.5 text-[10px] text-gray-500 dark:text-gray-400">
                      from {row.sourceLocation}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 align-top">
                  {row.targetLocation ? (
                    <code className="break-all font-mono text-[11px] text-gray-700 dark:text-gray-300">
                      {row.targetLocation}
                    </code>
                  ) : row.targetLabel ? (
                    <span className="text-gray-700 dark:text-gray-300">{row.targetLabel}</span>
                  ) : (
                    <span className="text-gray-400 dark:text-gray-500">
                      — not in the destination
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 align-top text-gray-600 dark:text-gray-300">
                  <ReasonCell row={row} entryKey={entry.key} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** A status cell: symbol + text label chip (colour supplemental). */
function StatusCell({ presentation }: { presentation: ReturnType<typeof statusPresentation> }) {
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-semibold ${presentation.badgeClass}`}
    >
      <span aria-hidden>{presentation.symbol}</span>
      {presentation.label}
    </span>
  );
}

/**
 * A table row's Reason cell (EFP-2.3): the concise cause-category chip, the one-line reason
 * summary, and — for a genuine destination limit that has one — the official documentation
 * link (host-allowlisted, version-disclosing, accessibly named). The table is the graph's
 * accessibility source of truth, so every non-preserved row carries its category here, not
 * only in the drawer.
 */
function ReasonCell({ row, entryKey }: { row: ProjectionEvidenceRow; entryKey: string }) {
  const category = categoryForReason(row.reason);
  const categoryView = category ? reasonCategoryPresentation(category) : null;
  const docLink = row.edge.documentation
    ? documentationLink(sanitizeDocumentationEvidence(row.edge.documentation))
    : null;
  return (
    <div className="space-y-0.5">
      {categoryView && (
        <span
          data-testid={`projection-row-category-${entryKey}`}
          className={`inline-block rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${categoryView.badgeClass}`}
        >
          {categoryView.label}
        </span>
      )}
      <div>{row.reasonSummary}</div>
      {docLink && (
        <a
          data-testid={`projection-row-doc-${entryKey}`}
          href={docLink.href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={docLink.ariaLabel}
          className="inline-flex items-center gap-1 font-medium text-indigo-600 hover:underline dark:text-indigo-300"
        >
          {docLink.text}
          <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
      )}
    </div>
  );
}

export default ProjectionGraphPanel;
