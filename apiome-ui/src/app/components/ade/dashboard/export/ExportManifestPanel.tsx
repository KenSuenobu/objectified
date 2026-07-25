'use client';

/**
 * ExportManifestPanel — the structural artifact explorer's entity tree (IXH-4.1, #5109).
 *
 * A windowed `role="tree"` over the export preview manifest: Services → operations,
 * Channels, and Types → fields, every row carrying its fidelity-status badge (drop
 * reasons stated, never hidden) and — when the manifest located the entity — its
 * `file:line` landing place in the bundle. Selecting a located entity asks the Review
 * step to reveal it in the code viewer (`onSelectEntity`); a code-side line click flows
 * back in through `selectedKey`, which reveals + focuses the entity's row (two-way
 * selection).
 *
 * Windowing, ARIA tree semantics (level/setsize/posinset, roving tabindex, arrow keys,
 * Home/End, type-ahead), focus pinning, filtering, and the declared-truncation banner
 * all mirror the import explorer (`CatalogImportPreviewPanel`, IXH-3.2/3.6) — one
 * behavior contract for both directions. Budgets come from the central registry
 * (`preview-budgets.ts`).
 */

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronRight, ListTree, Loader2, Search, X } from 'lucide-react';
import { cn } from '@lib/utils';
import { Button } from '../../../ui/Button';
import { computeWindowedRange, clampRowIndex } from '@/app/utils/windowed-rows';
import { EXPORT_MANIFEST_TREE_VIRTUALIZE_ABOVE } from '@/app/utils/preview-budgets';
import {
  buildExportManifestRows,
  countEntitiesByKind,
  defaultExportExpandedKeys,
  EXPORT_MANIFEST_SECTION_KEYS,
  findExportTypeaheadIndex,
  normalizedLocationFile,
  type ExportManifestEntity,
  type ExportManifestTreeRow,
  type ExportPreviewManifestPage,
} from './exportPreviewManifest';

// Re-exported so tests and callers reach the budget through the panel (registry pattern).
export { EXPORT_MANIFEST_TREE_VIRTUALIZE_ABOVE } from '@/app/utils/preview-budgets';

/** Uniform tree-row height (px) the windowing arithmetic assumes; matches the `h-8` row. */
const TREE_ROW_HEIGHT = 32;

/** Height (px) of the tree viewport; matches the `h-[380px]` container class. */
export const MANIFEST_TREE_HEIGHT = 380;

/** How long (ms) the tree's type-ahead buffer keeps accumulating characters. */
const TYPEAHEAD_RESET_MS = 500;

/** Status badge tone per shared projection status (drop = rose, loss = amber, ok = emerald). */
const STATUS_TONE: Record<string, string> = {
  retained: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300',
  transformed: 'bg-sky-100 text-sky-700 dark:bg-sky-950/50 dark:text-sky-300',
  approximated: 'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300',
  synthesized: 'bg-violet-100 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300',
  dropped: 'bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300',
  unavailable: 'bg-slate-100 text-slate-600 dark:bg-slate-700/60 dark:text-slate-300',
  'not-applicable': 'bg-gray-100 text-gray-500 dark:bg-gray-700/60 dark:text-gray-300',
};

/** Kind chip tone per entity kind. */
const KIND_TONE: Record<ExportManifestEntity['entity_kind'], string> = {
  service: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950/50 dark:text-indigo-300',
  operation: 'bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300',
  channel: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-950/50 dark:text-cyan-300',
  type: 'bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-950/50 dark:text-fuchsia-300',
  field: 'bg-gray-100 text-gray-600 dark:bg-gray-700/60 dark:text-gray-300',
};

/** One fidelity-status badge, shared by tree rows, the header legend, and the detail strip. */
function StatusBadge({ status, count }: { status: string; count?: number }) {
  return (
    <span
      data-testid="export-manifest-status"
      data-status={status}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold',
        STATUS_TONE[status] ?? STATUS_TONE['not-applicable'],
      )}
    >
      {typeof count === 'number' ? <span className="tabular-nums">{count}</span> : null}
      {status}
    </span>
  );
}

export interface ExportManifestPanelProps {
  /** The manifest's identity block (hash, target, full counts, files), or null while absent. */
  page: ExportPreviewManifestPage | null;
  /** The accumulated entity rows (merged cursor pages), in stable tree order. */
  entities: ExportManifestEntity[];
  /** Whether a manifest page walk is in flight. */
  loading: boolean;
  /** Transport error; the panel states it and the Review step keeps its plain file view. */
  error: string | null;
  /** True once every entity page is loaded (hides the truncation banner). */
  complete: boolean;
  /** Walk further cursor pages (the truncation banner's path to the full data). */
  onLoadMore: () => void;
  /** The selected entity's canonical key — shared with the code viewer's selection. */
  selectedKey: string | null;
  /** Row activation: the step records the selection and reveals a located entity in code. */
  onSelectEntity: (entity: ExportManifestEntity) => void;
  /** Tree viewport height override; tests pass a small value to exercise real windowing. */
  viewportHeight?: number;
  className?: string;
}

/**
 * The entity rail of the structural artifact explorer. Pure presentation over the
 * manifest the `useExportPreviewManifest` hook loads; selection state is owned by the
 * Review step so the tree and the code viewer stay in lock-step.
 */
export function ExportManifestPanel({
  page,
  entities,
  loading,
  error,
  complete,
  onLoadMore,
  selectedKey,
  onSelectEntity,
  viewportHeight = MANIFEST_TREE_HEIGHT,
  className,
}: ExportManifestPanelProps) {
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => defaultExportExpandedKeys());
  const [filter, setFilter] = useState('');
  const [scrollTop, setScrollTop] = useState(0);
  // Arms the post-render focus effect; a counter (not a boolean) so consecutive moves each fire.
  const [focusArm, setFocusArm] = useState(0);
  const focusArmHandled = useRef(0);
  const lastFocusIndex = useRef(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const rowRefs = useRef<Map<number, HTMLButtonElement>>(new Map());
  const typeahead = useRef<{ buffer: string; timer: ReturnType<typeof setTimeout> | null }>({
    buffer: '',
    timer: null,
  });
  /** Selection keys this panel itself reported, so the external-reveal effect skips them. */
  const internalSelectRef = useRef<string | null>(null);

  const entityCounts = useMemo(() => countEntitiesByKind(entities), [entities]);
  const rows = useMemo(
    () => buildExportManifestRows(entities, entityCounts, expandedKeys, filter),
    [entities, entityCounts, expandedKeys, filter],
  );
  const entityRowCount = useMemo(() => rows.filter((row) => row.kind === 'entity').length, [rows]);
  const entityByKey = useMemo(
    () => new Map(entities.map((entity) => [entity.key, entity])),
    [entities],
  );

  // The row holding the roving tabindex. Keyboard focus is panel-internal (`focusedKey`)
  // and decoupled from the externally-owned selection, so arrowing over a section row —
  // which reports no entity — still moves stepwise; the selection follows only entity
  // rows. An external selection change re-anchors focus (see the reveal effect below).
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const selectedIndex = useMemo(
    () => rows.findIndex((row) => row.key === selectedKey),
    [rows, selectedKey],
  );
  const focusedRowIndex = useMemo(
    () => rows.findIndex((row) => row.key === focusedKey),
    [rows, focusedKey],
  );
  const focusIndex =
    focusedRowIndex >= 0
      ? focusedRowIndex
      : selectedIndex >= 0
        ? selectedIndex
        : clampRowIndex(lastFocusIndex.current, rows.length) ?? 0;
  useEffect(() => {
    if (focusIndex >= 0) lastFocusIndex.current = focusIndex;
  }, [focusIndex]);

  // Imperative focus after a keyboard move's row set / scroll state has rendered.
  useEffect(() => {
    if (focusArm === focusArmHandled.current) return;
    focusArmHandled.current = focusArm;
    rowRefs.current.get(focusIndex)?.focus();
  }, [focusArm, focusIndex]);

  /** Move focus (and the scroll window) to a row of `nextRows`. */
  const focusRow = useCallback(
    (index: number, nextRows: ExportManifestTreeRow[], focus = true) => {
      const row = nextRows[index];
      if (!row) return;
      const maxScroll = Math.max(0, nextRows.length * TREE_ROW_HEIGHT - viewportHeight);
      const target = Math.max(0, Math.min(index * TREE_ROW_HEIGHT, maxScroll));
      if (listRef.current) listRef.current.scrollTop = target;
      setScrollTop(target);
      setFocusedKey(row.key);
      if (focus) setFocusArm((n) => n + 1);
    },
    [viewportHeight],
  );

  const toggleExpanded = useCallback((key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  /** Row activation (click / Enter / Space): report the entity, toggle a parent. */
  const activateRow = useCallback(
    (index: number) => {
      const row = rows[index];
      if (!row) return;
      setFocusedKey(row.key);
      if (row.hasChildren) toggleExpanded(row.key);
      if (row.entity) {
        internalSelectRef.current = row.entity.key;
        onSelectEntity(row.entity);
      }
    },
    [onSelectEntity, rows, toggleExpanded],
  );

  /**
   * An external selection (a code-viewer line click): expand the entity's ancestors and
   * scroll its row into the window — without stealing focus from the editor. Selections
   * this panel itself reported are skipped (the row is already visible).
   */
  useEffect(() => {
    if (!selectedKey) return;
    if (internalSelectRef.current === selectedKey) {
      internalSelectRef.current = null;
      return;
    }
    const entity = entityByKey.get(selectedKey);
    if (!entity) return;
    const nextExpanded = new Set(expandedKeys);
    for (const section of Object.values(EXPORT_MANIFEST_SECTION_KEYS)) nextExpanded.add(section);
    if (entity.parent_key) nextExpanded.add(entity.parent_key);
    setExpandedKeys(nextExpanded);
    setFocusedKey(selectedKey);
    const nextRows = buildExportManifestRows(entities, entityCounts, nextExpanded, filter);
    const index = nextRows.findIndex((row) => row.key === selectedKey);
    if (index >= 0) focusRow(index, nextRows, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reveal runs per selection change only
  }, [selectedKey]);

  const handleTreeKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (rows.length === 0) return;
      const current = focusIndex;
      const row = rows[current];

      const select = (index: number) => {
        const next = rows[index];
        if (next?.entity) {
          internalSelectRef.current = next.entity.key;
          onSelectEntity(next.entity);
        }
        focusRow(index, rows);
      };

      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activateRow(current);
        return;
      }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const next =
          event.key === 'ArrowDown'
            ? current + 1
            : event.key === 'ArrowUp'
              ? current - 1
              : event.key === 'Home'
                ? 0
                : rows.length - 1;
        const clamped = clampRowIndex(next, rows.length);
        if (clamped !== null) select(clamped);
        return;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        if (!row) return;
        if (row.hasChildren && !row.expanded) {
          toggleExpanded(row.key);
        } else if (row.expanded) {
          const clamped = clampRowIndex(current + 1, rows.length);
          if (clamped !== null) select(clamped);
        }
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        if (!row) return;
        if (row.expanded) {
          toggleExpanded(row.key);
          return;
        }
        for (let i = current - 1; i >= 0; i -= 1) {
          if (rows[i].depth === row.depth - 1) {
            select(i);
            return;
          }
        }
        return;
      }
      // Type-ahead: printable characters accumulate briefly and jump to the next match.
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        const state = typeahead.current;
        if (state.timer) clearTimeout(state.timer);
        state.buffer += event.key;
        state.timer = setTimeout(() => {
          state.buffer = '';
          state.timer = null;
        }, TYPEAHEAD_RESET_MS);
        const match = findExportTypeaheadIndex(rows, current, state.buffer);
        if (match !== null) select(match);
      }
    },
    [activateRow, focusIndex, focusRow, onSelectEntity, rows, toggleExpanded],
  );

  const virtualized = rows.length > EXPORT_MANIFEST_TREE_VIRTUALIZE_ABOVE;
  const rowWindow = useMemo(
    () =>
      virtualized
        ? computeWindowedRange({
            rowCount: rows.length,
            rowHeight: TREE_ROW_HEIGHT,
            viewportHeight,
            scrollTop,
          })
        : { startIndex: 0, endIndex: rows.length, paddingTop: 0, paddingBottom: 0 },
    [rows.length, scrollTop, viewportHeight, virtualized],
  );
  // Focus pinning: the roving-tabindex row must stay mounted even when scrolled out.
  const pinnedIndex =
    virtualized &&
    rows.length > 0 &&
    (focusIndex < rowWindow.startIndex || focusIndex >= rowWindow.endIndex)
      ? focusIndex
      : null;

  const selectedEntity = selectedKey ? entityByKey.get(selectedKey) ?? null : null;
  const hasMorePages = !complete && entities.length > 0;
  const filtering = filter.trim() !== '';
  const droppedCount = page?.dropped_entities ?? 0;

  const renderRow = (row: ExportManifestTreeRow, index: number, pinned: boolean) => {
    const selected = row.key === selectedKey;
    const location = row.entity?.location ?? null;
    const locationLabel =
      location != null
        ? `${normalizedLocationFile(row.entity!) ?? location.file}${
            location.line != null ? `:${location.line}` : ''
          }`
        : null;
    return (
      <li
        key={row.key}
        role="presentation"
        style={
          pinned
            ? { position: 'absolute', top: index * TREE_ROW_HEIGHT, left: 0, right: 0 }
            : undefined
        }
      >
        <button
          type="button"
          role="treeitem"
          aria-level={row.depth}
          aria-setsize={row.setSize}
          aria-posinset={row.posInSet}
          aria-expanded={row.hasChildren ? row.expanded : undefined}
          aria-selected={selected}
          tabIndex={index === focusIndex ? 0 : -1}
          onClick={() => activateRow(index)}
          ref={(node) => {
            if (node) rowRefs.current.set(index, node);
            else rowRefs.current.delete(index);
          }}
          data-testid={
            row.kind === 'section' ? 'export-manifest-section' : 'export-manifest-entity'
          }
          data-entity-key={row.entity?.key}
          style={{ '--tree-depth': row.depth } as React.CSSProperties}
          className={cn(
            'flex h-8 w-full items-center gap-2 rounded-md pr-2 text-left text-xs motion-safe:transition',
            'pl-[calc(0.5rem+(var(--tree-depth)-1)*1.125rem)]',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500',
            selected
              ? 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-100'
              : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800',
          )}
        >
          {row.hasChildren ? (
            <ChevronRight
              className={cn(
                'h-3.5 w-3.5 shrink-0 text-gray-400 motion-safe:transition-transform',
                row.expanded && 'rotate-90',
              )}
              aria-hidden
            />
          ) : (
            <span className="h-3.5 w-3.5 shrink-0" aria-hidden />
          )}
          {row.kind === 'section' ? (
            <>
              <span className="font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-300">
                {row.label}
              </span>
              {row.count !== null ? (
                <span className="rounded-full bg-gray-100 px-2 py-0.5 font-mono text-[10px] font-semibold tabular-nums text-gray-500 dark:bg-gray-700/60 dark:text-gray-300">
                  {row.count.toLocaleString()}
                </span>
              ) : null}
            </>
          ) : (
            <>
              <span
                className={cn(
                  'inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider',
                  KIND_TONE[row.entity!.entity_kind],
                )}
              >
                {row.entity!.entity_kind}
              </span>
              <span
                className={cn(
                  'truncate font-mono',
                  row.entity!.deprecated && 'line-through opacity-70',
                  !row.entity!.emitted && 'opacity-70',
                )}
              >
                {row.label}
              </span>
              <span className="ml-auto flex shrink-0 items-center gap-1.5">
                <StatusBadge status={row.entity!.status} />
                {locationLabel ? (
                  location?.line != null ? (
                    /* Not a nested interactive control (invalid inside the treeitem
                       button): a styled span whose click is a pointer shortcut for what
                       Enter on the row already does — activation reveals the location. */
                    <span
                      data-testid="export-manifest-location"
                      className="font-mono text-[10px] tabular-nums text-emerald-600 underline decoration-dotted underline-offset-2 hover:text-emerald-800 dark:text-emerald-400 dark:hover:text-emerald-300"
                    >
                      {locationLabel}
                    </span>
                  ) : (
                    <span
                      data-testid="export-manifest-location"
                      className="font-mono text-[10px] tabular-nums text-gray-400 dark:text-gray-500"
                    >
                      {locationLabel}
                    </span>
                  )
                ) : null}
              </span>
            </>
          )}
        </button>
      </li>
    );
  };

  return (
    <section
      className={cn('flex min-h-0 flex-col rounded-xl border border-gray-200 p-3 dark:border-gray-700', className)}
      data-testid="export-manifest-panel"
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <ListTree className="h-4 w-4 text-emerald-600" aria-hidden />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-900 dark:text-gray-100">
          Artifact entities
        </h3>
        {virtualized && (
          <span className="text-[10px] font-normal text-gray-500 dark:text-gray-400">windowed</span>
        )}
        {page ? (
          <span
            data-testid="export-manifest-summary"
            className="ml-auto flex items-center gap-1.5 text-[10px] text-gray-500 dark:text-gray-400"
          >
            <span className="tabular-nums">{page.total_entities.toLocaleString()} entities</span>
            {droppedCount > 0 ? <StatusBadge status="dropped" count={droppedCount} /> : null}
          </span>
        ) : null}
      </div>

      {loading && entities.length === 0 ? (
        <div
          className="flex flex-col items-center justify-center gap-2 py-8 text-center"
          data-testid="export-manifest-loading"
        >
          <Loader2 className="h-6 w-6 motion-safe:animate-spin text-emerald-500" aria-hidden />
          <p className="text-xs text-gray-500 dark:text-gray-400">Describing the artifact…</p>
        </div>
      ) : error ? (
        <p
          data-testid="export-manifest-error"
          role="status"
          className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-300"
        >
          {error}
        </p>
      ) : entities.length === 0 ? (
        <p className="rounded-lg border border-dashed border-gray-200 px-3 py-6 text-center text-xs text-gray-400 dark:border-gray-700 dark:text-gray-500">
          The manifest lists no entities for this artifact.
        </p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search
                className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400"
                aria-hidden
              />
              <input
                type="text"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter entities (name, kind, status)…"
                aria-label="Filter manifest entities"
                data-testid="export-manifest-filter"
                className="w-full rounded-md border border-gray-200 bg-white py-1.5 pl-7 pr-7 text-xs text-gray-900 placeholder:text-gray-400 focus:border-indigo-400 focus:outline-none dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
              />
              {filtering ? (
                <button
                  type="button"
                  onClick={() => setFilter('')}
                  aria-label="Clear entity filter"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-gray-400 motion-safe:transition-colors hover:text-gray-700 dark:hover:text-gray-200"
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              ) : null}
            </div>
            {filtering ? (
              <span
                data-testid="export-manifest-filter-count"
                className="shrink-0 font-mono text-[10px] tabular-nums text-gray-400 dark:text-gray-500"
              >
                {entityRowCount} of {entities.length}
              </span>
            ) : null}
          </div>

          {hasMorePages ? (
            <div
              role="status"
              data-testid="export-manifest-truncation"
              className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200"
            >
              <span className="min-w-0 flex-1">
                Showing {entities.length.toLocaleString()} of{' '}
                {(page?.total_entities ?? entities.length).toLocaleString()} entities — this
                manifest is truncated.
              </span>
              <Button
                variant="outline"
                onClick={onLoadMore}
                disabled={loading}
                data-testid="export-manifest-load-all"
              >
                {loading ? 'Loading more entities…' : 'Load more entities'}
              </Button>
            </div>
          ) : null}

          {rows.length > 0 ? (
            <div
              ref={listRef}
              onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
              onKeyDown={handleTreeKeyDown}
              className="h-[380px] overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700"
              style={viewportHeight !== MANIFEST_TREE_HEIGHT ? { height: viewportHeight } : undefined}
            >
              <ul role="tree" aria-label="Entities in the emitted artifact" className="relative">
                {rowWindow.paddingTop > 0 && (
                  <li aria-hidden role="presentation" style={{ height: rowWindow.paddingTop }} />
                )}
                {rows
                  .slice(rowWindow.startIndex, rowWindow.endIndex)
                  .map((row, offset) => renderRow(row, rowWindow.startIndex + offset, false))}
                {rowWindow.paddingBottom > 0 && (
                  <li aria-hidden role="presentation" style={{ height: rowWindow.paddingBottom }} />
                )}
                {pinnedIndex !== null && rows[pinnedIndex]
                  ? renderRow(rows[pinnedIndex], pinnedIndex, true)
                  : null}
              </ul>
            </div>
          ) : (
            <p
              data-testid="export-manifest-no-matches"
              className="rounded-lg border border-dashed border-gray-200 px-3 py-6 text-center text-xs text-gray-400 dark:border-gray-700 dark:text-gray-500"
            >
              {filtering
                ? `No entities match “${filter.trim()}”.`
                : 'The manifest lists no entities for this artifact.'}
            </p>
          )}

          {/* The selected entity's fidelity facts — where the drop reason is spelled out. */}
          {selectedEntity ? (
            <div
              data-testid="export-manifest-detail"
              aria-live="polite"
              className="rounded-lg border border-gray-200 px-3 py-2 text-xs dark:border-gray-700"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate font-mono font-semibold text-gray-900 dark:text-gray-100">
                  {selectedEntity.key}
                </span>
                <StatusBadge status={selectedEntity.status} />
                {selectedEntity.reason ? (
                  <span
                    data-testid="export-manifest-reason"
                    className="rounded bg-rose-50 px-1.5 py-0.5 font-mono text-[10px] text-rose-700 dark:bg-rose-950/40 dark:text-rose-300"
                  >
                    {selectedEntity.reason}
                  </span>
                ) : null}
                {!selectedEntity.emitted ? (
                  <span className="text-[10px] font-semibold uppercase text-rose-600 dark:text-rose-400">
                    not in artifact
                  </span>
                ) : null}
              </div>
              <p className="mt-1 text-gray-600 dark:text-gray-300">{selectedEntity.detail}</p>
              {selectedEntity.target_mapping ? (
                <p className="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">
                  Mapped as: {selectedEntity.target_mapping}
                </p>
              ) : null}
              {selectedEntity.location ? (
                <p className="mt-0.5 font-mono text-[11px] tabular-nums text-gray-500 dark:text-gray-400">
                  {normalizedLocationFile(selectedEntity)}
                  {selectedEntity.location.line != null ? `:${selectedEntity.location.line}` : ''}
                  {selectedEntity.location.pointer ? ` · ${selectedEntity.location.pointer}` : ''}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

export default ExportManifestPanel;
