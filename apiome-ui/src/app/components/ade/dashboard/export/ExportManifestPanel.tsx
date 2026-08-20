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
import { Badge } from '../../../ui/Badge';
import { Button } from '../../../ui/Button';
import { entityKindTone, projectionStatusTone } from '@/app/components/ade/export-studio';
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

/**
 * One fidelity-status badge, shared by tree rows, the header legend, and the detail strip.
 *
 * The tone is the shared one from `exportStudioView`, so a `dropped` entity is the same rose
 * here, in the mapping graph's table and in the round-trip's difference list — three surfaces
 * that each used to pick their own.
 */
function StatusBadge({ status, count }: { status: string; count?: number }) {
  return (
    <Badge
      data-testid="export-manifest-status"
      data-status={status}
      variant={projectionStatusTone(status)}
      className="shrink-0 gap-1"
    >
      {typeof count === 'number' ? <span className="tabular-nums">{count}</span> : null}
      {status}
    </Badge>
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
            'xstd-tree__row h-8 motion-safe:transition',
            'pl-[calc(0.5rem+(var(--tree-depth)-1)*1.125rem)]',
          )}
          data-selected={selected}
        >
          {row.hasChildren ? (
            <ChevronRight
              className={cn(
                'xstd-tree__twist motion-safe:transition-transform',
                row.expanded && 'rotate-90',
              )}
              aria-hidden
            />
          ) : (
            <span className="h-3.5 w-3.5 shrink-0" aria-hidden />
          )}
          {row.kind === 'section' ? (
            <>
              <span className="xstd-tree__group">{row.label}</span>
              {row.count !== null ? (
                <span className="xstd-tree__count">{row.count.toLocaleString()}</span>
              ) : null}
            </>
          ) : (
            <>
              <Badge
                variant={entityKindTone(row.entity!.entity_kind)}
                          className="shrink-0 uppercase"
              >
                {row.entity!.entity_kind}
              </Badge>
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
                      className="xstd-tree__line"
                    >
                      {locationLabel}
                    </span>
                  ) : (
                    <span
                      data-testid="export-manifest-location"
                      className="xstd-tree__line--flat"
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
      className={cn('xstd-tree-card', className)}
      data-testid="export-manifest-panel"
    >
      <div className="xstd-tree-card__head mb-2 flex-wrap">
        <ListTree aria-hidden />
        <h3 className="xstd-tree-card__title">Artifact entities</h3>
        {virtualized && <span className="xstd-note">windowed</span>}
        {page ? (
          <span data-testid="export-manifest-summary" className="xstd-tree-card__meta">
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
          <Loader2 className="h-6 w-6 motion-safe:animate-spin text-accent" aria-hidden />
          <p className="xstd-quiet">Describing the artifact…</p>
        </div>
      ) : error ? (
        <p
          data-testid="export-manifest-error"
          role="status"
          className="xstd-notice"
          data-tone="danger"
        >
          <span className="xstd-notice__grow">{error}</span>
        </p>
      ) : entities.length === 0 ? (
        <p className="xstd-empty">The manifest lists no entities for this artifact.</p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <div className="flex items-center gap-2">
            <div className="input-wrap min-w-0 flex-1">
              <Search aria-hidden />
              <input
                type="text"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter entities (name, kind, status)…"
                aria-label="Filter manifest entities"
                data-testid="export-manifest-filter"
                className="input input--sm"
              />
              {filtering ? (
                <button
                  type="button"
                  onClick={() => setFilter('')}
                  aria-label="Clear entity filter"
                  className="xstd-evidence__close"
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              ) : null}
            </div>
            {filtering ? (
              <span
                data-testid="export-manifest-filter-count"
                className="xstd-tree__line--flat shrink-0"
              >
                {entityRowCount} of {entities.length}
              </span>
            ) : null}
          </div>

          {hasMorePages ? (
            <div
              role="status"
              data-testid="export-manifest-truncation"
              className="xstd-notice"
              data-tone="warn"
            >
              <span className="xstd-notice__grow">
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
              className="xstd-tree__scroll"
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
              className="xstd-empty"
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
              className="xstd-entity"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="xstd-entity__name">{selectedEntity.key}</span>
                <StatusBadge status={selectedEntity.status} />
                {selectedEntity.reason ? (
                  <span
                    data-testid="export-manifest-reason"
                    className="xstd-entity__reason"
                  >
                    {selectedEntity.reason}
                  </span>
                ) : null}
                {!selectedEntity.emitted ? (
                  <Badge variant="rose" className="uppercase">
                    not in artifact
                  </Badge>
                ) : null}
              </div>
              <p className="xstd-entity__detail">{selectedEntity.detail}</p>
              {selectedEntity.target_mapping ? (
                <p className="xstd-note mt-0.5">Mapped as: {selectedEntity.target_mapping}</p>
              ) : null}
              {selectedEntity.location ? (
                <p className="xstd-tree__line--flat mt-0.5">
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
