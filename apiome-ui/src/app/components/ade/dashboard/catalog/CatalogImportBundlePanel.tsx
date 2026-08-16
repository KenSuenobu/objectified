'use client';

/**
 * CatalogImportBundlePanel (IXH-3.5, #5107) — the quality step's bundle file explorer.
 *
 * A bundle import — an uploaded `.zip`/`.tar.gz`, or a git selection packed as one (MFI-29.1/29.2/
 * 29.3) — is dozens of files, and until this panel the wizard showed exactly one grade and one
 * entity tree for all of them. Which file failed, which was never read, which import could not be
 * resolved, and whether the detected entry point was even the right one were all unanswerable. That
 * is the failure mode that makes multi-file gRPC imports frustrating.
 *
 * The panel renders the IXH-3.5 inventory (`POST /api/import/bundle-inventory`, a server-side dry
 * run that writes nothing) as:
 *
 *  - an **entry-point picker** — the ranked candidates auto-detection itself considered, with the
 *    current selection marked. Choosing another one re-runs the whole pre-flight (the wizard owns
 *    `archiveRoot`, so the pre-flight, the preview manifest, and this inventory all re-derive);
 *  - a **role legend** with whole-bundle counts, so "3 unreferenced files" is visible without
 *    scrolling anything;
 *  - a **windowed ARIA tree** of the bundle's directories and files, filterable and
 *    keyboard-navigable, each file carrying its role badge, verdict, and size;
 *  - a **detail strip** for the selected file — why it was ignored, the parse diagnostic naming it,
 *    its resolved and unresolved imports, what imports *it*, and the canonical entities it appears
 *    to contribute (labelled with the server's attribution method, never implied to be parser
 *    provenance);
 *  - an **unresolved imports** section listing every reference that could not be resolved *with the
 *    search paths that were tried*, which is the difference between "it failed" and "here is what to
 *    add to the archive";
 *  - a **truncation banner** whenever pages remain server-side, with a "Load all files" path to the
 *    complete data.
 *
 * Windowing reuses `computeWindowedRange` exactly as the entity explorer does (rows above
 * {@link BUNDLE_TREE_VIRTUALIZE_ABOVE} mount only around the viewport, and the focused row is
 * *pinned* at its true offset so focus is never dropped), and the tree stays a real `role="tree"`
 * with `aria-level` / `aria-setsize` / `aria-posinset` and roving tabindex.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { AlertTriangle, ChevronRight, FileWarning, Filter, Loader2, RefreshCw, X } from 'lucide-react';
import { cn } from '@lib/utils';
import { Button } from '../../../ui/Button';
import { clampRowIndex, computeWindowedRange } from '@/app/utils/windowed-rows';
import {
  BUNDLE_TREE_VIRTUALIZE_ABOVE,
  BUNDLE_UNRESOLVED_LIST_LIMIT,
  LOAD_ALL_PAGE_CAP,
} from '@/app/utils/preview-budgets';
import { findTypeaheadIndex } from '@/app/utils/import-preview-manifest';
import type { PreflightRequest } from '@/app/utils/import-preflight';
import {
  BUNDLE_PAGE_SIZE,
  BUNDLE_RESOLUTION_LABEL,
  BUNDLE_ROLES,
  BUNDLE_ROLE_HINT,
  BUNDLE_ROLE_LABEL,
  BUNDLE_ROLE_TONE,
  BUNDLE_VERDICT_LABEL,
  bundleAncestorKeys,
  bundleFilesByPath,
  bundleIgnoredReasonLabel,
  buildBundleTreeRows,
  defaultBundleExpandedKeys,
  fetchImportBundleInventory,
  formatBundleBytes,
  mergeBundlePages,
  type BundleFileRole,
  type BundleImportEdge,
  type BundleTreeRow,
  type ImportBundleInventory,
  type ImportBundleInventoryResponse,
} from '@/app/utils/import-bundle-inventory';

/** Uniform tree-row height (px) the windowing arithmetic assumes; matches the `h-8` row class. */
const TREE_ROW_HEIGHT = 32;

/** Height (px) of the tree viewport; matches the `h-[340px]` container class. */
export const BUNDLE_TREE_HEIGHT = 340;

/** How long (ms) the tree's type-ahead buffer keeps accumulating characters. */
const TYPEAHEAD_RESET_MS = 500;

export interface CatalogImportBundlePanelProps {
  /** The candidate payload — the quality step's own pre-flight request, reused verbatim so the
   *  inventory run hits the server's cached pre-flight for the same bytes. */
  request: PreflightRequest;
  /**
   * Re-select the bundle's entry point. The wizard owns `archiveRoot`, so changing it re-runs the
   * pre-flight, the preview manifest, and this inventory against the chosen root. Omitted when the
   * host cannot re-run (the picker is then read-only rather than a dead control).
   */
  onEntryPointChange?: (path: string) => void;
  /** Tree viewport height override; tests pass a small value to exercise real windowing (jsdom
   *  reports element heights as 0, so the height cannot be measured). */
  viewportHeight?: number;
}

/** One role badge, shared by the tree rows, the legend, and the detail strip. */
function RoleBadge({ role, count }: { role: BundleFileRole; count?: number }) {
  return (
    <span
      data-testid="bundle-role"
      data-role={role}
      title={BUNDLE_ROLE_HINT[role]}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-2xs font-semibold',
        BUNDLE_ROLE_TONE[role],
      )}
    >
      {typeof count === 'number' ? <span className="tabular-nums">{count}</span> : null}
      {BUNDLE_ROLE_LABEL[role]}
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

/** One import/include reference, with the search paths spelled out when it did not resolve. */
function ImportRow({ edge }: { edge: BundleImportEdge }) {
  const unresolved = edge.resolution === 'unresolved';
  return (
    <li
      data-testid="bundle-import-edge"
      data-resolution={edge.resolution}
      className="flex flex-col gap-0.5 py-1"
    >
      <span className="flex flex-wrap items-baseline gap-2">
        <span className="font-mono text-2xs text-gray-800 dark:text-gray-100">{edge.target}</span>
        <span
          className={cn(
            'rounded px-1.5 py-0.5 text-2xs font-semibold',
            unresolved
              ? 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300'
              : edge.resolution === 'provided'
                ? 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300'
                : 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
          )}
        >
          {BUNDLE_RESOLUTION_LABEL[edge.resolution]}
        </span>
        <span className="font-mono text-2xs tabular-nums text-gray-400 dark:text-gray-500">
          {edge.directive} · line {edge.line}
        </span>
        {edge.to_path ? (
          <span className="font-mono text-2xs text-gray-500 dark:text-gray-400">
            → {edge.to_path}
          </span>
        ) : null}
        {edge.provider ? (
          <span className="text-2xs text-gray-500 dark:text-gray-400">via {edge.provider}</span>
        ) : null}
      </span>
      {unresolved && edge.search_paths.length > 0 ? (
        <span
          data-testid="bundle-search-paths"
          className="font-mono text-2xs leading-relaxed text-gray-500 dark:text-gray-400"
        >
          Looked for: {edge.search_paths.join(' · ')}
        </span>
      ) : null}
    </li>
  );
}

export function CatalogImportBundlePanel({
  request,
  onEntryPointChange,
  viewportHeight = BUNDLE_TREE_HEIGHT,
}: CatalogImportBundlePanelProps) {
  // One inventory run's outcome, tagged with the run it belongs to (the quality step's pattern):
  // "still loading" is derived, so a stale inventory can never render as the current candidate's.
  const [outcome, setOutcome] = useState<{
    runId: object | null;
    response: ImportBundleInventoryResponse | null;
    inventory: ImportBundleInventory | null;
    error: string | null;
  }>({ runId: null, response: null, inventory: null, error: null });
  const [attempt, setAttempt] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set<string>());
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

  /** The current inventory run — a fresh identity per candidate and per retry. */
  const runId = useMemo(() => ({ request, attempt }), [request, attempt]);
  const loading = outcome.runId !== runId;
  const response = loading ? null : outcome.response;
  const inventory = loading ? null : outcome.inventory;
  const transportError = loading ? null : outcome.error;

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    let live = true;
    fetchImportBundleInventory({ ...request, page_size: BUNDLE_PAGE_SIZE }, controller.signal)
      .then((result) => {
        if (!live) return;
        setOutcome({
          runId,
          response: result,
          inventory: result.inventory ?? null,
          error: null,
        });
        setSelectedKey(null);
        setExpandedKeys(defaultBundleExpandedKeys(result.inventory?.files ?? []));
        setScrollTop(0);
      })
      .catch((e: unknown) => {
        if (!live || controller.signal.aborted) return;
        setOutcome({
          runId,
          response: null,
          inventory: null,
          error:
            e instanceof Error ? e.message : 'Could not inventory the files in this bundle.',
        });
      });
    return () => {
      live = false;
      controller.abort();
    };
  }, [request, runId]);

  const rows = useMemo(
    () => (inventory ? buildBundleTreeRows(inventory.files, expandedKeys, filter) : []),
    [inventory, expandedKeys, filter],
  );
  const fileRowCount = useMemo(() => rows.filter((row) => row.kind === 'file').length, [rows]);
  const filesByPath = useMemo(
    () => bundleFilesByPath(inventory?.files ?? []),
    [inventory],
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
    (index: number, nextRows: BundleTreeRow[]) => {
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

  /** Row activation (click / Enter / Space): select, and toggle a directory. */
  const activateRow = useCallback(
    (index: number) => {
      const row = rows[index];
      if (!row) return;
      setSelectedKey(row.key);
      if (row.hasChildren) toggleExpanded(row.key);
    },
    [rows, toggleExpanded],
  );

  /** Reveal a file named elsewhere in the panel (the unresolved list's back-link). */
  const revealFile = useCallback(
    (path: string) => {
      if (!inventory) return;
      const nextExpanded = new Set(expandedKeys);
      for (const key of bundleAncestorKeys(path)) nextExpanded.add(key);
      setFilter('');
      setExpandedKeys(nextExpanded);
      const nextRows = buildBundleTreeRows(inventory.files, nextExpanded, '');
      const index = nextRows.findIndex((row) => row.key === path);
      if (index >= 0) focusRow(index, nextRows);
      else setSelectedKey(path);
    },
    [expandedKeys, focusRow, inventory],
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
   * Walk `next_cursor` pages into the accumulated inventory — the truncation banner's "path to the
   * full data". Bounded per click by {@link LOAD_ALL_PAGE_CAP}; the banner (and this button) stay
   * up when a cursor remains after the cap.
   */
  const loadRemainingPages = useCallback(async () => {
    const startRunId = runId;
    const signal = abortRef.current?.signal;
    let current = inventory;
    let cursor = current?.next_cursor ?? null;
    if (!current || !cursor) return;
    setLoadingMore(true);
    try {
      for (let page = 0; page < LOAD_ALL_PAGE_CAP && cursor; page++) {
        const result = await fetchImportBundleInventory(
          { ...request, page_size: BUNDLE_PAGE_SIZE, cursor },
          signal,
        );
        if (!result.inventory) break;
        current = mergeBundlePages(current, result.inventory);
        cursor = current.next_cursor ?? null;
        const merged = current;
        setOutcome((prev) => (prev.runId === startRunId ? { ...prev, inventory: merged } : prev));
      }
    } catch {
      // An aborted or failed page walk leaves the pages already merged; the banner still shows
      // what is loaded versus the total, so nothing is silently misrepresented.
    } finally {
      setLoadingMore(false);
    }
  }, [inventory, request, runId]);

  const virtualized = rows.length > BUNDLE_TREE_VIRTUALIZE_ABOVE;
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
  // the window, or focus (and the only Tab stop) would fall off the tree.
  const pinnedIndex =
    virtualized &&
    rows.length > 0 &&
    (focusIndex < rowWindow.startIndex || focusIndex >= rowWindow.endIndex)
      ? focusIndex
      : null;

  const selectedFile = selectedKey ? filesByPath.get(selectedKey) ?? null : null;
  const hasMorePages = Boolean(inventory?.next_cursor);
  const filtering = filter.trim() !== '';
  const unresolvedShown = inventory?.unresolved.slice(0, BUNDLE_UNRESOLVED_LIST_LIMIT) ?? [];

  const renderRow = (row: BundleTreeRow, index: number, pinned: boolean) => {
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
          data-testid={row.kind === 'directory' ? 'bundle-directory' : 'bundle-file'}
          data-path={row.key}
          style={{ '--tree-depth': row.depth } as React.CSSProperties}
          className={cn(
            'flex h-8 w-full items-center gap-2 rounded-md pr-2 text-left text-xs motion-safe:transition',
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
                'h-3.5 w-3.5 shrink-0 text-gray-400 motion-safe:transition-transform',
                row.expanded && 'rotate-90',
              )}
              aria-hidden
            />
          ) : (
            <span className="h-3.5 w-3.5 shrink-0" aria-hidden />
          )}
          {row.kind === 'directory' ? (
            <>
              <span className="truncate font-semibold text-gray-600 dark:text-gray-300">
                {row.label}/
              </span>
              <span className="rounded-full bg-gray-100 px-2 py-0.5 font-mono text-2xs font-semibold tabular-nums text-gray-500 dark:bg-gray-700/60 dark:text-gray-300">
                {(row.count ?? 0).toLocaleString()}
              </span>
            </>
          ) : (
            <>
              <span className="truncate font-mono">{row.label}</span>
              <span className="ml-auto flex shrink-0 items-center gap-1.5">
                {row.file!.verdict === 'failed' ? (
                  <span
                    data-testid="bundle-verdict-failed"
                    className="rounded bg-rose-100 px-1.5 py-0.5 text-2xs font-semibold text-rose-700 dark:bg-rose-900/40 dark:text-rose-300"
                  >
                    {BUNDLE_VERDICT_LABEL.failed}
                  </span>
                ) : null}
                {row.file!.entity_count > 0 ? (
                  <span className="font-mono text-2xs tabular-nums text-gray-400 dark:text-gray-500">
                    {row.file!.entity_count} entities
                  </span>
                ) : null}
                <span className="font-mono text-2xs tabular-nums text-gray-400 dark:text-gray-500">
                  {formatBundleBytes(row.file!.bytes)}
                </span>
                <RoleBadge role={row.file!.role} />
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
      data-testid="bundle-panel"
    >
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-900 dark:text-gray-100">
          Files in this bundle
        </h3>
        {virtualized && (
          <span className="text-2xs font-normal text-gray-500 dark:text-gray-400">windowed</span>
        )}
      </div>

      {loading ? (
        <div
          className="flex flex-col items-center justify-center gap-2 py-8 text-center"
          data-testid="bundle-loading"
        >
          <Loader2 className="h-6 w-6 motion-safe:animate-spin text-indigo-500" aria-hidden />
          <span className="text-xs text-gray-600 dark:text-gray-300">
            Reading the bundle — nothing has been written yet.
          </span>
        </div>
      ) : transportError ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-300 p-3 text-sm text-amber-800 dark:border-amber-700 dark:text-amber-200"
          data-testid="bundle-error"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">{transportError}</span>
          <Button variant="outline" onClick={() => setAttempt((n) => n + 1)} data-testid="bundle-retry">
            <RefreshCw className="h-4 w-4" aria-hidden />
            Retry
          </Button>
        </div>
      ) : response && !response.ok ? (
        <div
          className="rounded-lg border border-rose-300 p-3 text-sm text-rose-800 dark:border-rose-700 dark:text-rose-200"
          data-testid="bundle-unusable"
        >
          <p className="font-medium">
            {response.error?.message ?? 'This archive could not be unpacked.'}
          </p>
          {response.error?.remediation ? (
            <p className="mt-1 text-xs">{response.error.remediation}</p>
          ) : null}
        </div>
      ) : !inventory ? (
        <div
          className="rounded-lg border border-gray-200 p-3 text-sm text-gray-600 dark:border-gray-700 dark:text-gray-300"
          data-testid="bundle-single-document"
        >
          This import is a single document, not a bundle — there are no bundle files to explore.
        </div>
      ) : (
        <div className="space-y-3">
          <div
            className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-gray-100 bg-gray-50/60 px-3 py-2 dark:border-gray-700/60 dark:bg-gray-900/40"
            data-testid="bundle-summary"
          >
            <SummaryFact label="Files" value={inventory.total_files.toLocaleString()} />
            <SummaryFact label="References" value={inventory.total_edges.toLocaleString()} />
            <SummaryFact
              label="Unresolved"
              value={inventory.total_unresolved.toLocaleString()}
            />
            <SummaryFact label="Entities" value={inventory.total_entities.toLocaleString()} />
          </div>

          <div
            className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-100 bg-gray-50/60 px-3 py-2 dark:border-gray-700/60 dark:bg-gray-900/40"
            data-testid="bundle-entry-point"
          >
            <label
              htmlFor="bundle-entry-point-select"
              className="text-xs font-medium text-gray-700 dark:text-gray-200"
            >
              Entry point
            </label>
            <select
              id="bundle-entry-point-select"
              data-testid="bundle-entry-point-select"
              value={inventory.entry_point ?? ''}
              disabled={!onEntryPointChange}
              onChange={(event) => onEntryPointChange?.(event.target.value)}
              className="min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-2 py-1.5 font-mono text-xs text-gray-700 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400 disabled:opacity-60 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200"
            >
              {inventory.entry_point === null || inventory.entry_point === undefined ? (
                <option value="">Choose the root document…</option>
              ) : null}
              {inventory.entry_point_candidates.map((candidate) => (
                <option key={candidate.path} value={candidate.path}>
                  {candidate.path}
                  {candidate.format ? ` — ${candidate.format}` : ''}
                </option>
              ))}
            </select>
            <span className="text-2xs text-gray-500 dark:text-gray-400">
              {inventory.entry_point_pinned ? 'chosen by you' : 'auto-detected'}
            </span>
          </div>

          {inventory.entry_point_error ? (
            <p
              role="status"
              data-testid="bundle-entry-point-error"
              className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200"
            >
              {inventory.entry_point_error} Choose the root document above to re-run the pre-flight.
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-1.5" data-testid="bundle-legend">
            {BUNDLE_ROLES.map((role) => (
              <RoleBadge key={role} role={role} count={inventory.role_counts?.[role] ?? 0} />
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
                data-testid="bundle-filter"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter files…"
                aria-label="Filter bundle files by path, role, or verdict"
                className="w-full rounded-lg border border-gray-200 bg-white py-1.5 pl-8 pr-8 text-xs text-gray-700 placeholder:text-gray-400 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200"
              />
              {filtering ? (
                <button
                  type="button"
                  data-testid="bundle-filter-clear"
                  onClick={() => setFilter('')}
                  aria-label="Clear file filter"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-gray-400 motion-safe:transition-colors hover:text-gray-700 dark:hover:text-gray-200"
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              ) : null}
            </div>
            {filtering ? (
              <span
                data-testid="bundle-filter-count"
                className="shrink-0 font-mono text-2xs tabular-nums text-gray-400 dark:text-gray-500"
              >
                {fileRowCount} of {inventory.files.length}
              </span>
            ) : null}
          </div>

          {hasMorePages ? (
            <div
              role="status"
              data-testid="bundle-truncation"
              className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200"
            >
              <span className="min-w-0 flex-1">
                Showing {inventory.files.length.toLocaleString()} of{' '}
                {inventory.total_files.toLocaleString()} files — this inventory is truncated.
              </span>
              <Button
                variant="outline"
                onClick={() => void loadRemainingPages()}
                disabled={loadingMore}
                data-testid="bundle-load-all"
              >
                {loadingMore ? 'Loading more files…' : 'Load all files'}
              </Button>
            </div>
          ) : null}

          {rows.length > 0 ? (
            <div
              ref={listRef}
              onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
              onKeyDown={handleTreeKeyDown}
              className="h-[340px] overflow-y-auto rounded-lg border border-gray-200 dark:border-gray-700"
              style={viewportHeight !== BUNDLE_TREE_HEIGHT ? { height: viewportHeight } : undefined}
            >
              <ul role="tree" aria-label="Files in this bundle" className="relative">
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
              data-testid="bundle-no-matches"
              className="rounded-lg border border-dashed border-gray-200 px-3 py-6 text-center text-xs text-gray-400 dark:border-gray-700 dark:text-gray-500"
            >
              {filtering
                ? `No files match “${filter.trim()}”.`
                : 'The inventory reported no files for this bundle.'}
            </p>
          )}

          {selectedFile ? (
            <div
              className="space-y-2 rounded-lg border border-gray-200 p-3 dark:border-gray-700"
              data-testid="bundle-file-detail"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-gray-900 dark:text-gray-100">
                  {selectedFile.path}
                </span>
                <RoleBadge role={selectedFile.role} />
                <span className="text-2xs text-gray-500 dark:text-gray-400">
                  {BUNDLE_VERDICT_LABEL[selectedFile.verdict]}
                  {selectedFile.lines > 0 ? ` · ${selectedFile.lines.toLocaleString()} lines` : ''}
                </span>
              </div>
              <p className="text-2xs text-gray-500 dark:text-gray-400">
                {BUNDLE_ROLE_HINT[selectedFile.role]}
              </p>
              {selectedFile.role === 'ignored' ? (
                <p
                  data-testid="bundle-ignored-reason"
                  className="text-2xs text-amber-700 dark:text-amber-300"
                >
                  Ignored: {bundleIgnoredReasonLabel(selectedFile.ignored_reason)}
                </p>
              ) : null}
              {selectedFile.error ? (
                <p
                  data-testid="bundle-file-error"
                  className="flex items-start gap-2 rounded border border-rose-200 bg-rose-50 px-2 py-1.5 font-mono text-2xs text-rose-800 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-200"
                >
                  <FileWarning className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1">{selectedFile.error}</span>
                </p>
              ) : null}
              {selectedFile.imports.length > 0 ? (
                <div>
                  <h4 className="text-2xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-300">
                    Imports ({selectedFile.imports.length})
                  </h4>
                  <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                    {selectedFile.imports.map((edge) => (
                      <ImportRow key={`${edge.directive}:${edge.target}:${edge.line}`} edge={edge} />
                    ))}
                  </ul>
                </div>
              ) : null}
              {selectedFile.imported_by.length > 0 ? (
                <p
                  data-testid="bundle-imported-by"
                  className="text-2xs text-gray-500 dark:text-gray-400"
                >
                  Imported by:{' '}
                  <span className="font-mono">{selectedFile.imported_by.join(', ')}</span>
                </p>
              ) : null}
              <p
                data-testid="bundle-file-entities"
                className="text-2xs text-gray-500 dark:text-gray-400"
              >
                {selectedFile.entity_count > 0
                  ? `Contributes ${selectedFile.entity_count.toLocaleString()} canonical ${
                      selectedFile.entity_count === 1 ? 'entity' : 'entities'
                    }: ${selectedFile.entity_keys.join(', ')}`
                  : 'No canonical entity was attributed to this file.'}
              </p>
              <p className="text-2xs italic text-gray-400 dark:text-gray-500">
                Contribution is matched by {inventory.attribution} — the file declares a symbol with
                the entity’s name. It is evidence, not a record kept by the parser.
              </p>
            </div>
          ) : null}

          {unresolvedShown.length > 0 ? (
            <div
              className="space-y-1 rounded-lg border border-rose-200 p-3 dark:border-rose-800"
              data-testid="bundle-unresolved"
            >
              <h4 className="text-2xs font-semibold uppercase tracking-wide text-rose-700 dark:text-rose-300">
                Unresolved imports
                {inventory.total_unresolved > unresolvedShown.length
                  ? ` — showing ${unresolvedShown.length} of ${inventory.total_unresolved}`
                  : ` (${inventory.total_unresolved})`}
              </h4>
              <ul className="divide-y divide-rose-100 dark:divide-rose-900/50">
                {unresolvedShown.map((edge) => (
                  <li key={`${edge.from_path}:${edge.target}:${edge.line}`} className="py-1">
                    <button
                      type="button"
                      data-testid="bundle-unresolved-source"
                      onClick={() => revealFile(edge.from_path)}
                      className="font-mono text-2xs text-indigo-600 underline decoration-dotted underline-offset-2 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-300"
                    >
                      {edge.from_path}:{edge.line}
                    </button>
                    <span className="ml-2 font-mono text-2xs text-gray-800 dark:text-gray-100">
                      {edge.target}
                    </span>
                    <span
                      data-testid="bundle-unresolved-search-paths"
                      className="block font-mono text-2xs text-gray-500 dark:text-gray-400"
                    >
                      Looked for: {edge.search_paths.join(' · ')}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

export default CatalogImportBundlePanel;
