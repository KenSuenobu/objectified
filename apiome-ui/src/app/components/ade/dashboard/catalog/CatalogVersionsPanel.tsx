'use client';

/**
 * CatalogVersionsPanel (MFI-25.7 #4092, MFI-28.1 #4117) — the inline version **timeline + diff** in
 * the catalog detail Versions tab.
 *
 * Revisions are listed newest-first, each with a checkbox, so the reader can **tick any two** and see
 * their diff rendered **in-place** — no route change, no lost catalog context (MFI-28.1). The diff uses
 * the shared Monaco diff viewer with a side-by-side/unified layout toggle (persisted in localStorage),
 * a minimum viewport height, and an expand-all/collapse-all control that folds or reveals the unchanged
 * regions between the two specs. The off-page "Open version history" link is retained as the escape
 * hatch to the full versions dashboard.
 *
 * Data comes from the same `GET /api/versions?projectId={id}` endpoint the versions dashboard uses
 * (catalog items are versioned on the shared versions table). The compare read reuses the dashboard's
 * `buildOpenApiSpecJsonForVersion` machinery via {@link loadCatalogRevisionSpec} — no new endpoints.
 * The version-list fetch is **lazy** (only once the Versions tab is first active) and **one-shot**
 * (re-activating never refetches), mirroring {@link CatalogLintPanel}. All selection maths live in
 * `catalog-versions-timeline` so this component stays a thin view.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  AlignJustify,
  ChevronsDownUp,
  ChevronsUpDown,
  Columns2,
  GitBranch,
  Loader2,
  Lock,
  RefreshCw,
} from 'lucide-react';
import { cn } from '@lib/utils';
import { dashboardPanelClass } from '@/app/components/ade/dashboard/dashboardScreenClasses';
import { formatVersionWithPrefix, getVersionRevisionNote } from '@/app/utils/version-display';
import {
  JsonDiffViewer,
  type DiffMode,
} from '@/app/components/ui/code';
import {
  canDiffRevisions,
  MAX_DIFF_SELECTION,
  orderRevisionPairOldToNew,
  sortRevisionsNewestFirst,
  toggleRevisionSelection,
  type CatalogVersionRevision,
} from '@/app/utils/catalog-versions-timeline';
import { loadCatalogRevisionSpec } from '@/app/utils/catalog-revision-diff';

interface CatalogVersionsPanelProps {
  /** The catalog item id (a project id) whose revisions to list. */
  itemId: string;
  /** The catalog item's name — feeds the diffed specs' `info.title` so both sides match. */
  itemName?: string | null;
  /** The catalog item's metadata — feeds the diffed specs' `info` block so both sides match. */
  itemMetadata?: Record<string, unknown> | null;
  /** Whether the Versions tab is active; revisions are fetched the first time this is true. */
  active: boolean;
}

/** The fetch lifecycle of the version list (`idle`/`loading` render the spinner). */
type VersionsStatus = 'idle' | 'loading' | 'loaded' | 'error';

/** localStorage key remembering the preferred diff layout (side-by-side vs unified). */
const DIFF_MODE_STORAGE_KEY = 'catalog-versions-diff-mode';

/** The compare read of the selected pair (both revisions' spec JSON), plus its lifecycle. */
interface CompareState {
  status: 'idle' | 'loading' | 'loaded' | 'error';
  /** The older revision's spec JSON (left / "before"). */
  original: string;
  /** The newer revision's spec JSON (right / "after"). */
  modified: string;
  error: string | null;
}

const IDLE_COMPARE: CompareState = { status: 'idle', original: '', modified: '', error: null };

/** Format an ISO timestamp for display; falls back to the raw value / em dash. */
function formatTimestamp(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

/**
 * Fetch a project's revisions from the shared versions endpoint. Throws on a non-OK response or an
 * `{ success: false }` envelope so the caller can surface a retryable error.
 */
async function fetchCatalogVersions(
  itemId: string,
  options?: { signal?: AbortSignal },
): Promise<CatalogVersionRevision[]> {
  const response = await fetch(`/api/versions?projectId=${encodeURIComponent(itemId)}`, {
    method: 'GET',
    signal: options?.signal,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || data.success === false) {
    const message =
      (data && (data.error || data.detail)) || `Failed to load versions (HTTP ${response.status})`;
    throw new Error(typeof message === 'string' ? message : 'Failed to load versions');
  }
  return Array.isArray(data.versions) ? (data.versions as CatalogVersionRevision[]) : [];
}

/** The side-by-side / unified layout switch for the inline diff. */
function DiffModeToggle({
  mode,
  onChange,
}: {
  mode: DiffMode;
  onChange: (mode: DiffMode) => void;
}) {
  const options: Array<{ value: DiffMode; label: string; icon: typeof Columns2 }> = [
    { value: 'split', label: 'Side-by-side', icon: Columns2 },
    { value: 'unified', label: 'Unified', icon: AlignJustify },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Diff layout"
      data-testid="catalog-versions-diff-mode"
      className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5 dark:border-gray-700 dark:bg-gray-800"
    >
      {options.map((opt) => {
        const selected = mode === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            data-testid={`catalog-versions-diff-mode-${opt.value}`}
            onClick={() => onChange(opt.value)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
              selected
                ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/60 dark:text-indigo-300'
                : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200',
            )}
          >
            <opt.icon className="h-3.5 w-3.5" aria-hidden />
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Render a catalog item's revisions as an inline, newest-first timeline with two-checkbox diff
 * selection, and — once two are ticked — the pair's diff rendered in-place. Fetches lazily on first
 * activation of the Versions tab and exposes a retry on failure.
 */
export function CatalogVersionsPanel({
  itemId,
  itemName,
  itemMetadata,
  active,
}: CatalogVersionsPanelProps) {
  const router = useRouter();
  const [status, setStatus] = useState<VersionsStatus>('idle');
  const [revisions, setRevisions] = useState<CatalogVersionRevision[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // The two revision ids ticked for diffing (capped at two by `toggleRevisionSelection`).
  const [selected, setSelected] = useState<string[]>([]);
  // Guards the one-shot lazy fetch so re-activating the tab never re-fetches.
  const fetchStartedRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  // The inline diff of the ticked pair.
  const [compare, setCompare] = useState<CompareState>(IDLE_COMPARE);
  /** Diff layout (side-by-side vs unified), remembered across visits. */
  const [diffMode, setDiffMode] = useState<DiffMode>('split');
  /** Expand-all reveals every unchanged region; collapse-all (default) folds them to the changes. */
  const [expandAll, setExpandAll] = useState(false);
  // Monotonic token so a superseded compare (older pair) never clobbers a newer one's result.
  const compareTokenRef = useRef(0);

  // Hydrate the persisted diff layout on mount (client-only; SSR default stays `split`).
  useEffect(() => {
    try {
      if (window.localStorage.getItem(DIFF_MODE_STORAGE_KEY) === 'unified') setDiffMode('unified');
    } catch {
      /* storage unavailable (private mode / quota) — keep the default. */
    }
  }, []);

  const changeDiffMode = useCallback((mode: DiffMode) => {
    setDiffMode(mode);
    try {
      window.localStorage.setItem(DIFF_MODE_STORAGE_KEY, mode);
    } catch {
      /* storage unavailable — the toggle still works for this visit. */
    }
  }, []);

  const toggleExpandAll = useCallback(() => setExpandAll((prev) => !prev), []);

  // Lazy + one-shot fetch of the version list. The guard sits at the top, before any setState, so the
  // effect stays a single `void` call (mirrors CatalogLintPanel). `retry` re-opens it via the ref.
  const loadVersions = useCallback(async () => {
    if (!active || fetchStartedRef.current) return;
    fetchStartedRef.current = true;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus('loading');
    setErrorMessage(null);
    let loaded: CatalogVersionRevision[] | null = null;
    let failureMessage: string | null = null;
    try {
      loaded = await fetchCatalogVersions(itemId, { signal: controller.signal });
    } catch (e) {
      failureMessage = e instanceof Error ? e.message : 'Failed to load versions.';
    } finally {
      if (controller.signal.aborted) {
        /* superseded by a newer fetch/unmount — leave state to the newer run. */
      } else if (failureMessage != null) {
        setErrorMessage(failureMessage);
        setStatus('error');
      } else {
        setRevisions(sortRevisionsNewestFirst(loaded ?? []));
        setStatus('loaded');
      }
    }
  }, [active, itemId]);

  useEffect(() => {
    void loadVersions();
  }, [loadVersions]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Retry from the error affordance — an event handler, so re-opening the one-shot is fine.
  const retry = useCallback(() => {
    fetchStartedRef.current = false;
    void loadVersions();
  }, [loadVersions]);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => toggleRevisionSelection(prev, id));
  }, []);

  // The ticked pair, ordered old → new (null until exactly two distinct revisions are ticked).
  const pair = useMemo(
    () => orderRevisionPairOldToNew(selected, revisions),
    [selected, revisions],
  );

  // Run the compare read whenever the ordered pair changes; clear it when the pair is incomplete.
  useEffect(() => {
    const token = (compareTokenRef.current += 1);
    if (!pair) {
      setCompare(IDLE_COMPARE);
      return;
    }
    setCompare((prev) => ({ ...prev, status: 'loading', error: null }));
    void (async () => {
      try {
        const [original, modified] = await Promise.all([
          loadCatalogRevisionSpec(pair.base, itemId, itemName ?? null, itemMetadata),
          loadCatalogRevisionSpec(pair.head, itemId, itemName ?? null, itemMetadata),
        ]);
        if (compareTokenRef.current !== token) return; // superseded — drop this result.
        setCompare({ status: 'loaded', original, modified, error: null });
      } catch (e) {
        if (compareTokenRef.current !== token) return;
        setCompare({
          status: 'error',
          original: '',
          modified: '',
          error: e instanceof Error ? e.message : 'Failed to build the diff.',
        });
      }
    })();
  }, [pair, itemId, itemName, itemMetadata]);

  const openHistory = useCallback(() => {
    router.push(`/ade/dashboard/versions?projectId=${encodeURIComponent(itemId)}`);
  }, [router, itemId]);

  const hasPair = canDiffRevisions(selected) && pair != null;

  return (
    <section className={`${dashboardPanelClass} p-6`} data-testid="catalog-detail-versions">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            Versions
          </h2>
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Tick any two revisions to compare them inline. Catalog items share the versions table with
            Projects.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="catalog-detail-versions-link"
            onClick={openHistory}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            <GitBranch className="h-4 w-4 text-indigo-500" /> Open version history
          </button>
        </div>
      </div>

      {status === 'idle' || status === 'loading' ? (
        <p
          data-testid="catalog-versions-loading"
          className="mt-6 text-sm text-gray-500 dark:text-gray-400"
        >
          Loading versions…
        </p>
      ) : status === 'error' ? (
        <div
          data-testid="catalog-versions-error"
          className="mt-6 flex flex-col items-start gap-3 rounded-xl border border-rose-200 bg-rose-50/60 p-4 text-sm dark:border-rose-900 dark:bg-rose-950/30"
        >
          <span className="flex items-center gap-2 text-rose-700 dark:text-rose-300">
            <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
            {errorMessage || 'Failed to load versions.'}
          </span>
          <button
            type="button"
            data-testid="catalog-versions-retry"
            onClick={retry}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            <RefreshCw className="h-4 w-4" /> Retry
          </button>
        </div>
      ) : revisions.length === 0 ? (
        <p
          data-testid="catalog-versions-empty"
          className="mt-6 text-sm text-gray-600 dark:text-gray-300"
        >
          No revisions yet — this catalog item has a single, unversioned import.
        </p>
      ) : (
        <>
          <p
            data-testid="catalog-versions-selection-hint"
            className="mt-4 text-xs text-gray-500 dark:text-gray-400"
          >
            {selected.length} of {MAX_DIFF_SELECTION} selected
            {hasPair ? ' — showing the diff below (old → new).' : '. Select two to compare.'}
          </p>
          <ol className="mt-3 space-y-2" data-testid="catalog-versions-timeline">
            {revisions.map((rev) => {
              const isChecked = selected.includes(rev.id);
              // Once two are ticked, block adding a third by disabling the unticked rows.
              const isDisabled = !isChecked && selected.length >= MAX_DIFF_SELECTION;
              const note = getVersionRevisionNote(rev);
              return (
                <li
                  key={rev.id}
                  data-testid="catalog-versions-row"
                  data-revision-id={rev.id}
                  className={cn(
                    'flex items-start gap-3 rounded-lg border p-3 transition-colors',
                    isChecked
                      ? 'border-indigo-300 bg-indigo-50/60 dark:border-indigo-700 dark:bg-indigo-950/30'
                      : 'border-gray-100 bg-gray-50/60 dark:border-gray-700/60 dark:bg-gray-900/30',
                  )}
                >
                  <label
                    className={cn(
                      'mt-0.5 flex shrink-0 items-center',
                      isDisabled ? 'cursor-not-allowed' : 'cursor-pointer',
                    )}
                  >
                    <input
                      type="checkbox"
                      data-testid="catalog-versions-checkbox"
                      className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 disabled:cursor-not-allowed dark:border-gray-600 dark:bg-gray-700"
                      checked={isChecked}
                      disabled={isDisabled}
                      onChange={() => toggle(rev.id)}
                      aria-label={`Select ${formatVersionWithPrefix(rev.version_id)} to diff`}
                    />
                  </label>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm font-semibold text-gray-800 dark:text-gray-100">
                        {formatVersionWithPrefix(rev.version_id)}
                      </span>
                      {rev.published ? (
                        <span className="inline-flex items-center gap-1 rounded bg-emerald-100 px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                          <Lock className="h-3 w-3" aria-hidden /> Published
                        </span>
                      ) : null}
                      {rev.lifecycle && rev.lifecycle !== 'stable' ? (
                        <span className="inline-flex items-center rounded bg-gray-200 px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                          {rev.lifecycle}
                        </span>
                      ) : null}
                    </div>
                    {note ? (
                      <p className="mt-0.5 text-sm text-gray-700 dark:text-gray-200">{note}</p>
                    ) : null}
                    <p className="mt-0.5 text-2xs text-gray-400 dark:text-gray-500">
                      {formatTimestamp(rev.created_at)}
                      {rev.creator_name || rev.creator_email
                        ? ` · ${rev.creator_name || rev.creator_email}`
                        : ''}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>

          {hasPair ? (
            <div className="mt-5" data-testid="catalog-versions-diff">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h3 className="flex items-center gap-2 font-mono text-sm font-semibold text-gray-800 dark:text-gray-100">
                  {compare.status === 'loading' ? (
                    <Loader2 className="h-4 w-4 animate-spin text-indigo-500" aria-hidden />
                  ) : null}
                  {formatVersionWithPrefix(pair!.base.version_id)}
                  {' → '}
                  {formatVersionWithPrefix(pair!.head.version_id)}
                </h3>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    data-testid="catalog-versions-expand-all"
                    onClick={toggleExpandAll}
                    disabled={compare.status !== 'loaded'}
                    aria-pressed={expandAll}
                    title={
                      expandAll ? 'Collapse the unchanged regions' : 'Expand every unchanged region'
                    }
                    className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 dark:hover:text-gray-100"
                  >
                    {expandAll ? (
                      <ChevronsDownUp className="h-3.5 w-3.5" aria-hidden />
                    ) : (
                      <ChevronsUpDown className="h-3.5 w-3.5" aria-hidden />
                    )}
                    {expandAll ? 'Collapse all' : 'Expand all'}
                  </button>
                  <DiffModeToggle mode={diffMode} onChange={changeDiffMode} />
                </div>
              </div>

              {compare.status === 'error' ? (
                <div
                  data-testid="catalog-versions-diff-error"
                  className="flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50/60 p-4 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-300"
                >
                  <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
                  {compare.error || 'Failed to build the diff.'}
                </div>
              ) : compare.status === 'loaded' ? (
                <JsonDiffViewer
                  original={compare.original}
                  modified={compare.modified}
                  mode={diffMode}
                  minLines={14}
                  maxLines={40}
                  hideUnchangedRegions={!expandAll}
                />
              ) : (
                <p
                  data-testid="catalog-versions-diff-loading"
                  className="rounded-xl border border-gray-200 bg-gray-50/60 p-4 text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-900/30 dark:text-gray-400"
                >
                  Building the diff…
                </p>
              )}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
