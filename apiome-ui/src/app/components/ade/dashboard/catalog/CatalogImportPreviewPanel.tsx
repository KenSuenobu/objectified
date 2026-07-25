'use client';

/**
 * CatalogImportPreviewPanel (IXH-3.2, #5104) — the quality step's structural entity explorer.
 *
 * Before this panel, the import wizard's quality step showed the lint verdict but nothing of what
 * the import would actually *create* — a user importing a 400-operation spec clicked Import on
 * faith. The panel renders the IXH-3.1 preview manifest (`POST /api/import/preview-manifest`, a
 * server-side dry run that writes nothing) as:
 *
 *  - a **summary header** — source format, paradigm, routing target, entity counts, lint grade,
 *    and the adapter that parsed the candidate;
 *  - a **windowed ARIA tree** of the canonical entities (Services → operations, Channels, Types),
 *    filterable, keyboard-navigable, with a coverage badge on every node and a source-location
 *    link into the step's raw viewer where the parser reported one;
 *  - a **provenance strip** for the selected entity — native name/id, unmodeled facets, and the
 *    coverage ledger's explanation;
 *  - a **truncation banner** whenever pages remain server-side, with a "Load all entities" path to
 *    the full data;
 *  - the **projection map** (IXH-3.3, `CatalogImportProjectionGraph`) — what the source lost or
 *    kept becoming canonical, rendered from the same manifest's graph and coverage ledger;
 *  - the **re-import delta** (IXH-3.4, `CatalogImportReimportDelta`) — when the commit would land
 *    in an existing catalog item, what it would change there, with an explicit no-op verdict and
 *    drill-down into this panel's entity tree.
 *
 * The panel is mounted by `CatalogImportQualityStep`, which the wizard mounts only when the quality
 * step is reached — so the manifest request fires lazily, on first arrival at the step.
 *
 * Windowing reuses `computeWindowedRange` (rows above {@link TREE_VIRTUALIZE_ABOVE} mount only
 * around the viewport) and the tree stays a real `role="tree"`: rows are a flat projection of the
 * expanded nodes (built in `import-preview-manifest.ts`) carrying `aria-level` / `aria-setsize` /
 * `aria-posinset`, with roving tabindex. A focused row that scrolls out of the mounted window is
 * *pinned* — rendered absolutely at its true offset — so focus is never dropped by windowing.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { AlertTriangle, ChevronRight, Filter, Loader2, RefreshCw, X } from 'lucide-react';
import { cn } from '@lib/utils';
import { Button } from '../../../ui/Button';
import { gradeChipClass } from '@/app/utils/version-lint-report';
import { parsedTagToneClass } from './CatalogParsedModel';
import { CatalogImportProjectionGraph } from './CatalogImportProjectionGraph';
import { CatalogImportReimportDelta } from './CatalogImportReimportDelta';
import { clampRowIndex, computeWindowedRange } from '@/app/utils/windowed-rows';
import type { PreflightRequest } from '@/app/utils/import-preflight';
import {
  buildPreviewTreeRows,
  coverageDetailByEntityKey,
  defaultExpandedKeys,
  entityKindTag,
  fetchImportPreviewManifest,
  findTypeaheadIndex,
  mergeManifestPages,
  parseSourceLocation,
  PREVIEW_COVERAGE_CLASSES,
  PREVIEW_COVERAGE_LABEL,
  PREVIEW_COVERAGE_TONE,
  PREVIEW_PAGE_SIZE,
  PREVIEW_SECTION_KEYS,
  type ImportPreviewManifest,
  type ImportPreviewManifestResponse,
  type PreviewTreeRow,
} from '@/app/utils/import-preview-manifest';

/** Tree rows beyond this count are windowed rather than all mounted. */
export const TREE_VIRTUALIZE_ABOVE = 50;

/** Uniform tree-row height (px) the windowing arithmetic assumes; matches the `h-8` row class. */
const TREE_ROW_HEIGHT = 32;

/** Height (px) of the tree viewport; matches the `h-[380px]` container class. */
export const TREE_HEIGHT = 380;

/** Pages one "Load all entities" click will walk before pausing (20k entities at max page size). */
export const LOAD_ALL_PAGE_CAP = 20;

/** How long (ms) the tree's type-ahead buffer keeps accumulating characters. */
const TYPEAHEAD_RESET_MS = 500;

export interface CatalogImportPreviewPanelProps {
  /** The candidate payload — the quality step's own pre-flight request, reused verbatim so the
   *  manifest run hits the server's cached pre-flight for the same bytes. */
  request: PreflightRequest;
  /** Whether the step has raw source text to link into (false for archives). */
  rawSourceAvailable: boolean;
  /** Line count of the raw source, so links past the end are not offered. */
  rawLineCount: number;
  /** Jump the step's raw viewer to a 1-based source line. */
  onSelectSourceLine: (line: number) => void;
  /** The catalog project slug the commit would use (the wizard's own derivation). When set,
   *  the manifest request carries it and the response may include the IXH-3.4 re-import
   *  delta against the existing item under that slug. */
  projectSlug?: string | null;
  /** Abandon the import from the re-import delta's no-op banner. */
  onSkipCommit?: () => void;
  /** Tree viewport height override; tests pass a small value to exercise real windowing (jsdom
   *  reports element heights as 0, so the height cannot be measured). */
  viewportHeight?: number;
}

/** One coverage badge, shared by the tree rows and the header legend. */
function CoverageBadge({ coverage, count }: { coverage: string; count?: number }) {
  const known = (PREVIEW_COVERAGE_CLASSES as readonly string[]).includes(coverage);
  const label = known
    ? PREVIEW_COVERAGE_LABEL[coverage as (typeof PREVIEW_COVERAGE_CLASSES)[number]]
    : coverage;
  const tone = known
    ? PREVIEW_COVERAGE_TONE[coverage as (typeof PREVIEW_COVERAGE_CLASSES)[number]]
    : 'bg-slate-100 text-slate-600 dark:bg-slate-700/60 dark:text-slate-300';
  return (
    <span
      data-testid="import-preview-coverage"
      data-coverage={coverage}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold',
        tone,
      )}
    >
      {typeof count === 'number' ? <span className="tabular-nums">{count}</span> : null}
      {label}
    </span>
  );
}

/** A `label: value` pair in the summary header. */
function SummaryFact({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-baseline gap-1 text-xs">
      <span className="text-gray-500 dark:text-gray-400">{label}</span>
      <span className="font-medium text-gray-900 dark:text-gray-100">{value}</span>
    </span>
  );
}

export function CatalogImportPreviewPanel({
  request,
  rawSourceAvailable,
  rawLineCount,
  onSelectSourceLine,
  projectSlug = null,
  onSkipCommit,
  viewportHeight = TREE_HEIGHT,
}: CatalogImportPreviewPanelProps) {
  // One manifest run's outcome, tagged with the run it belongs to (the quality step's pattern):
  // "still loading" is derived, so a stale manifest can never render as the current candidate's.
  // `manifest` accumulates pages within the run; `response` keeps the first page's envelope.
  const [outcome, setOutcome] = useState<{
    runId: object | null;
    response: ImportPreviewManifestResponse | null;
    manifest: ImportPreviewManifest | null;
    error: string | null;
  }>({ runId: null, response: null, manifest: null, error: null });
  const [attempt, setAttempt] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => defaultExpandedKeys());
  const [filter, setFilter] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
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
  const abortRef = useRef<AbortController | null>(null);

  /** The current manifest run — a fresh identity per candidate and per retry. */
  const runId = useMemo(() => ({ request, attempt }), [request, attempt]);
  const loading = outcome.runId !== runId;
  const response = loading ? null : outcome.response;
  const manifest = loading ? null : outcome.manifest;
  const transportError = loading ? null : outcome.error;

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    let live = true;
    fetchImportPreviewManifest(
      {
        ...request,
        page_size: PREVIEW_PAGE_SIZE,
        ...(projectSlug ? { project_slug: projectSlug } : {}),
      },
      controller.signal,
    )
      .then((result) => {
        if (!live) return;
        setOutcome({ runId, response: result, manifest: result.manifest, error: null });
        setSelectedKey(null);
        setExpandedKeys(defaultExpandedKeys());
        setScrollTop(0);
      })
      .catch((e: unknown) => {
        if (!live || controller.signal.aborted) return;
        setOutcome({
          runId,
          response: null,
          manifest: null,
          error:
            e instanceof Error ? e.message : 'Could not build the import preview for this source.',
        });
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [request, runId, projectSlug]);

  const rows = useMemo(
    () =>
      manifest
        ? buildPreviewTreeRows(manifest.entities, manifest.counts, expandedKeys, filter)
        : [],
    [manifest, expandedKeys, filter],
  );
  const entityRowCount = useMemo(() => rows.filter((row) => row.kind === 'entity').length, [rows]);
  const ledgerByEntity = useMemo(
    () => coverageDetailByEntityKey(manifest?.coverage ?? []),
    [manifest],
  );

  // The row holding the roving tabindex: the selected row when it is still in the row set,
  // otherwise the nearest index the last focus sat at (restoration across filter/collapse changes).
  const selectedIndex = useMemo(
    () => rows.findIndex((row) => row.key === selectedKey),
    [rows, selectedKey],
  );
  const focusIndex =
    selectedIndex >= 0 ? selectedIndex : clampRowIndex(lastFocusIndex.current, rows.length) ?? 0;
  useEffect(() => {
    if (selectedIndex >= 0) lastFocusIndex.current = selectedIndex;
  }, [selectedIndex]);

  // Imperative focus after the row set / scroll state from a keyboard move has rendered, so the
  // target is mounted (windowed in, or pinned) before `.focus()` runs. Guarded by the arm counter
  // so recomputes of `focusIndex` alone (e.g. typing in the filter) never steal focus.
  useEffect(() => {
    if (focusArm === focusArmHandled.current) return;
    focusArmHandled.current = focusArm;
    rowRefs.current.get(focusIndex)?.focus();
  }, [focusArm, focusIndex]);

  /** Move selection (and the roving tabindex) to a row, keeping it inside the scroll window. */
  const focusRow = useCallback(
    (index: number, nextRows: PreviewTreeRow[]) => {
      const row = nextRows[index];
      if (!row) return;
      const maxScroll = Math.max(0, nextRows.length * TREE_ROW_HEIGHT - viewportHeight);
      const target = Math.max(0, Math.min(index * TREE_ROW_HEIGHT, maxScroll));
      if (listRef.current) listRef.current.scrollTop = target;
      setScrollTop(target);
      setSelectedKey(row.key);
      setFocusArm((n) => n + 1);
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

  /** The line a row can link to, or null (no location, no raw source, or past the source's end). */
  const linkableLine = useCallback(
    (row: PreviewTreeRow): number | null => {
      const location = parseSourceLocation(row.entity?.source_location);
      if (!location || !rawSourceAvailable || location.line > rawLineCount) return null;
      return location.line;
    },
    [rawLineCount, rawSourceAvailable],
  );

  /** Row activation (click / Enter / Space): select, toggle a parent, follow a source link. */
  const activateRow = useCallback(
    (index: number) => {
      const row = rows[index];
      if (!row) return;
      setSelectedKey(row.key);
      if (row.hasChildren) toggleExpanded(row.key);
      const line = linkableLine(row);
      if (line !== null) onSelectSourceLine(line);
    },
    [linkableLine, onSelectSourceLine, rows, toggleExpanded],
  );

  /**
   * Reveal an entity named by the re-import delta (IXH-3.4 drill-down): clear the filter,
   * expand the entity's ancestors, and select + scroll its tree row. An entity on a page
   * not yet loaded (truncated manifest) still records the selection so the row highlights
   * once its page arrives.
   */
  const revealEntity = useCallback(
    (key: string) => {
      if (!manifest) return;
      const entity = manifest.entities.find((candidate) => candidate.key === key);
      const nextExpanded = new Set(expandedKeys);
      for (const section of Object.values(PREVIEW_SECTION_KEYS)) nextExpanded.add(section);
      if (entity?.entity_kind === 'operation' && entity.parent_key) {
        nextExpanded.add(entity.parent_key);
      }
      setFilter('');
      setExpandedKeys(nextExpanded);
      const nextRows = buildPreviewTreeRows(manifest.entities, manifest.counts, nextExpanded, '');
      const index = nextRows.findIndex((row) => row.key === key);
      if (index >= 0) focusRow(index, nextRows);
      else setSelectedKey(key);
    },
    [expandedKeys, focusRow, manifest],
  );

  const handleTreeKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (rows.length === 0) return;
      const current = focusIndex;
      const row = rows[current];

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
        if (clamped !== null) focusRow(clamped, rows);
        return;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        if (!row) return;
        if (row.hasChildren && !row.expanded) {
          setSelectedKey(row.key);
          toggleExpanded(row.key);
        } else if (row.expanded) {
          // The first child is the next row of the flat projection.
          const clamped = clampRowIndex(current + 1, rows.length);
          if (clamped !== null) focusRow(clamped, rows);
        }
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        if (!row) return;
        if (row.expanded) {
          setSelectedKey(row.key);
          toggleExpanded(row.key);
          return;
        }
        for (let i = current - 1; i >= 0; i--) {
          if (rows[i].depth === row.depth - 1) {
            focusRow(i, rows);
            return;
          }
        }
        return;
      }
      // Type-ahead: printable characters accumulate briefly and jump to the next matching label.
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        const state = typeahead.current;
        if (state.timer) clearTimeout(state.timer);
        state.buffer += event.key;
        state.timer = setTimeout(() => {
          state.buffer = '';
          state.timer = null;
        }, TYPEAHEAD_RESET_MS);
        const match = findTypeaheadIndex(rows, current, state.buffer);
        if (match !== null) focusRow(match, rows);
      }
    },
    [activateRow, focusIndex, focusRow, rows, toggleExpanded],
  );

  /**
   * Walk `next_cursor` pages into the accumulated manifest — the truncation banner's "path to the
   * full data". Bounded per click by {@link LOAD_ALL_PAGE_CAP}; the banner (and this button) stay
   * up when a cursor remains after the cap.
   */
  const loadRemainingPages = useCallback(async () => {
    const startRunId = runId;
    const signal = abortRef.current?.signal;
    let current = manifest;
    let cursor = current?.next_cursor ?? null;
    if (!current || !cursor) return;
    setLoadingMore(true);
    try {
      for (let page = 0; page < LOAD_ALL_PAGE_CAP && cursor; page++) {
        const result = await fetchImportPreviewManifest(
          { ...request, page_size: PREVIEW_PAGE_SIZE, cursor },
          signal,
        );
        if (!result.manifest) break;
        current = mergeManifestPages(current, result.manifest);
        cursor = current.next_cursor ?? null;
        const merged = current;
        setOutcome((prev) => (prev.runId === startRunId ? { ...prev, manifest: merged } : prev));
      }
    } catch {
      // An aborted or failed page walk leaves the pages already merged; the banner still shows
      // what is loaded versus the total, so nothing is silently misrepresented.
    } finally {
      setLoadingMore(false);
    }
  }, [manifest, request, runId]);

  const virtualized = rows.length > TREE_VIRTUALIZE_ABOVE;
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
  // Focus pinning: the row holding the roving tabindex must stay mounted even when scrolled out of
  // the window, or focus (and the only Tab stop) would fall off the tree. It renders absolutely at
  // its true offset so the spacer arithmetic is untouched.
  const pinnedIndex =
    virtualized && rows.length > 0 && (focusIndex < rowWindow.startIndex || focusIndex >= rowWindow.endIndex)
      ? focusIndex
      : null;

  const preflight = response?.preflight ?? null;
  const routingTarget =
    preflight?.routing && typeof preflight.routing['target'] === 'string'
      ? (preflight.routing['target'] as string)
      : null;
  const format = preflight?.format ?? preflight?.detection?.detected_format ?? null;
  const paradigm = preflight?.paradigm ?? manifest?.adapter?.paradigm ?? null;
  const grade = preflight?.lint?.grade ?? null;
  const counts = manifest?.counts ?? preflight?.counts ?? {};
  const selectedRow = selectedIndex >= 0 ? rows[selectedIndex] : null;
  const selectedEntity = selectedRow?.entity ?? null;
  const selectedLedger = selectedEntity ? ledgerByEntity.get(selectedEntity.key) ?? null : null;
  const hasMorePages = Boolean(manifest?.next_cursor);
  const filtering = filter.trim() !== '';

  const renderRow = (row: PreviewTreeRow, index: number, pinned: boolean) => {
    const location = parseSourceLocation(row.entity?.source_location);
    const line = linkableLine(row);
    const selected = row.key === selectedKey;
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
          data-testid={row.kind === 'section' ? 'import-preview-section' : 'import-preview-entity'}
          style={{ '--tree-depth': row.depth } as React.CSSProperties}
          className={cn(
            'flex h-8 w-full items-center gap-2 rounded-md pr-2 text-left text-xs transition',
            'pl-[calc(0.5rem+(var(--tree-depth)-1)*1.125rem)]',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500',
            selected
              ? 'bg-indigo-100 text-indigo-900 dark:bg-indigo-950/60 dark:text-indigo-100'
              : 'text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800',
          )}
        >
          {row.hasChildren ? (
            <ChevronRight
              className={cn(
                'h-3.5 w-3.5 shrink-0 text-gray-400 transition-transform',
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
                  parsedTagToneClass(entityKindTag(row.entity!.entity_kind)),
                )}
              >
                {row.entity!.entity_kind}
              </span>
              <span
                className={cn(
                  'truncate font-mono',
                  row.entity!.deprecated && 'line-through opacity-70',
                )}
              >
                {row.label}
              </span>
              {row.entity!.deprecated ? (
                <span className="shrink-0 rounded bg-slate-100 px-1 py-0.5 text-[9px] font-semibold uppercase text-slate-500 dark:bg-slate-700/60 dark:text-slate-300">
                  deprecated
                </span>
              ) : null}
              <span className="ml-auto flex shrink-0 items-center gap-1.5">
                <CoverageBadge coverage={row.entity!.coverage} />
                {location ? (
                  line !== null ? (
                    <span
                      data-testid="import-preview-source-link"
                      role="link"
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedKey(row.key);
                        onSelectSourceLine(line);
                      }}
                      className="font-mono text-[10px] tabular-nums text-indigo-600 underline decoration-dotted underline-offset-2 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-300"
                    >
                      {row.entity!.source_location}
                    </span>
                  ) : (
                    <span className="font-mono text-[10px] tabular-nums text-gray-400 dark:text-gray-500">
                      {row.entity!.source_location}
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
      className="rounded-xl border border-gray-200 p-4 dark:border-gray-700"
      data-testid="import-preview-panel"
    >
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-900 dark:text-gray-100">
          What this import would add
        </h3>
        {virtualized && (
          <span className="text-[10px] font-normal text-gray-500 dark:text-gray-400">windowed</span>
        )}
      </div>

      {loading ? (
        <div
          className="flex flex-col items-center justify-center gap-2 py-8 text-center"
          data-testid="import-preview-loading"
        >
          <Loader2 className="h-6 w-6 animate-spin text-indigo-500" aria-hidden />
          <span className="text-xs text-gray-600 dark:text-gray-300">
            Building the entity preview — nothing has been written yet.
          </span>
        </div>
      ) : transportError ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-300 p-3 text-sm text-amber-800 dark:border-amber-700 dark:text-amber-200"
          data-testid="import-preview-error"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">{transportError}</span>
          <Button
            variant="outline"
            onClick={() => setAttempt((n) => n + 1)}
            data-testid="import-preview-retry"
          >
            <RefreshCw className="h-4 w-4" aria-hidden />
            Retry preview
          </Button>
        </div>
      ) : !response?.ok || !manifest ? (
        <div
          className="rounded-lg border border-gray-200 p-3 text-sm text-gray-600 dark:border-gray-700 dark:text-gray-300"
          data-testid="import-preview-unavailable"
        >
          This source cannot be previewed
          {preflight?.error?.message ? ` — ${preflight.error.message}` : '.'}
        </div>
      ) : (
        <div className="space-y-3">
          <div
            className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-gray-100 bg-gray-50/60 px-3 py-2 dark:border-gray-700/60 dark:bg-gray-900/40"
            data-testid="import-preview-summary"
          >
            <SummaryFact label="Format" value={format ?? '—'} />
            <SummaryFact label="Paradigm" value={paradigm ?? '—'} />
            <SummaryFact label="Routes to" value={routingTarget ?? '—'} />
            <span className="flex flex-wrap items-center gap-1.5" data-testid="import-preview-counts">
              {(
                [
                  ['services', counts.services],
                  ['operations', counts.operations],
                  ['channels', counts.channels],
                  ['types', counts.types],
                ] as const
              ).map(([kind, count]) => (
                <span
                  key={kind}
                  className="inline-flex items-center gap-1 rounded-md bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-600 dark:bg-gray-700/60 dark:text-gray-300"
                >
                  <span className="font-mono tabular-nums">{(count ?? 0).toLocaleString()}</span>
                  {kind}
                </span>
              ))}
            </span>
            {grade ? (
              <span
                className={cn(
                  'inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-semibold',
                  gradeChipClass(grade),
                )}
              >
                Grade {grade}
              </span>
            ) : null}
            <span className="text-[10px] text-gray-400 dark:text-gray-500">
              via {manifest.adapter.adapter_label}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-1.5" data-testid="import-preview-legend">
            {PREVIEW_COVERAGE_CLASSES.map((coverage) => (
              <CoverageBadge
                key={coverage}
                coverage={coverage}
                count={manifest.coverage_counts?.[coverage] ?? 0}
              />
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1 sm:max-w-xs">
              <Filter
                className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400"
                aria-hidden
              />
              <input
                type="text"
                data-testid="import-preview-filter"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter entities…"
                aria-label="Filter preview entities by name, kind, or source name"
                className="w-full rounded-lg border border-gray-200 bg-white py-1.5 pl-8 pr-8 text-xs text-gray-700 placeholder:text-gray-400 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200"
              />
              {filtering ? (
                <button
                  type="button"
                  data-testid="import-preview-filter-clear"
                  onClick={() => setFilter('')}
                  aria-label="Clear entity filter"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-gray-400 transition-colors hover:text-gray-700 dark:hover:text-gray-200"
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              ) : null}
            </div>
            {filtering ? (
              <span
                data-testid="import-preview-filter-count"
                className="shrink-0 font-mono text-[10px] tabular-nums text-gray-400 dark:text-gray-500"
              >
                {entityRowCount} of {manifest.entities.length}
              </span>
            ) : null}
          </div>

          {hasMorePages ? (
            <div
              role="status"
              data-testid="import-preview-truncation"
              className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200"
            >
              <span className="min-w-0 flex-1">
                Showing {manifest.entities.length.toLocaleString()} of{' '}
                {manifest.total_entities.toLocaleString()} entities — this preview is truncated.
              </span>
              <Button
                variant="outline"
                onClick={() => void loadRemainingPages()}
                disabled={loadingMore}
                data-testid="import-preview-load-all"
              >
                {loadingMore
                  ? 'Loading more entities…'
                  : manifest.entities.length > PREVIEW_PAGE_SIZE
                    ? 'Load more entities'
                    : 'Load all entities'}
              </Button>
            </div>
          ) : null}

          {/* IXH-3.4: what a re-import would change on the existing item; renders nothing
              for a first-time import (`reimport` null). */}
          <CatalogImportReimportDelta
            delta={response?.reimport ?? null}
            onSkipCommit={onSkipCommit}
            onRevealEntity={revealEntity}
          />

          {rows.length > 0 ? (
            <div
              ref={listRef}
              onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
              onKeyDown={handleTreeKeyDown}
              className="h-[380px] overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700"
              style={viewportHeight !== TREE_HEIGHT ? { height: viewportHeight } : undefined}
            >
              <ul role="tree" aria-label="Entities this import would add" className="relative">
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
              data-testid="import-preview-no-matches"
              className="rounded-lg border border-dashed border-gray-200 px-3 py-6 text-center text-xs text-gray-400 dark:border-gray-700 dark:text-gray-500"
            >
              {filtering
                ? `No entities match “${filter.trim()}”.`
                : 'The manifest reported no entities for this candidate.'}
            </p>
          )}

          {selectedEntity ? (
            <div
              className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-500 dark:text-gray-400"
              data-testid="import-preview-provenance"
            >
              {selectedEntity.native_name && selectedEntity.native_name !== selectedEntity.name ? (
                <span>
                  Source name: <span className="font-mono">{selectedEntity.native_name}</span>
                </span>
              ) : null}
              {selectedEntity.native_id ? (
                <span>
                  Source id: <span className="font-mono">{selectedEntity.native_id}</span>
                </span>
              ) : null}
              {selectedEntity.unmodeled_extras.length > 0 ? (
                <span>
                  Not carried over: {selectedEntity.unmodeled_extras.join(', ')}
                </span>
              ) : null}
              {selectedLedger ? <span>{selectedLedger.detail}</span> : null}
              {!selectedEntity.native_id &&
              (!selectedEntity.native_name || selectedEntity.native_name === selectedEntity.name) &&
              selectedEntity.unmodeled_extras.length === 0 &&
              !selectedLedger ? (
                <span>Maps one-to-one from the source document.</span>
              ) : null}
            </div>
          ) : null}

          {/* IXH-3.3: what the source lost or kept becoming canonical, from the same manifest. */}
          <CatalogImportProjectionGraph
            nodes={manifest.nodes}
            edges={manifest.edges}
            coverage={manifest.coverage}
            capability={manifest.adapter.capability}
            rawSourceAvailable={rawSourceAvailable}
            rawLineCount={rawLineCount}
            onSelectSourceLine={onSelectSourceLine}
          />
        </div>
      )}
    </section>
  );
}

export default CatalogImportPreviewPanel;
