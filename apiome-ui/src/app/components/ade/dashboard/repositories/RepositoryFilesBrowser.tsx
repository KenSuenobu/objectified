'use client';

/**
 * The Files tab of the repository detail screen (HIVE-7.5, #5322).
 *
 * Authority: `docs/mockups/sources/repository-detail.html` §Files — the branch bar, the filter
 * toolbar, the selectable table with its select-all, and the pager.
 *
 * ### What it owns
 *
 * The read, the page, the selection, and which of the three panes is showing — the list, one
 * file's detail, or the Map & import overlay. It owns none of the rules: the preset list, how
 * a glob and a regex compose into one request, what the count line says, when a multi-row
 * selection needs a warning — all of that is `repositoryDetailModel`.
 *
 * ### Three things this fixes rather than restyles
 *
 * 1. **Map & import replaced the whole tab.** Opening it unmounted the browser, so the reader
 *    lost their filters, their page and their selection; cancelling put them back at the top
 *    of an unfiltered list. It is an overlay now — the mockup's own `dialog--full` — so
 *    closing it returns to exactly the row that opened it. That is also what makes "Import
 *    selected, re-select the rest afterward" a workable instruction rather than an apology.
 * 2. **The regex silently disabled the preset.** The endpoint applies a regex *or* a
 *    preset-and-glob; the toolbar disabled the glob field but left the preset live, so a
 *    reader could pick "OpenAPI" while a regex was set and watch nothing happen.
 *    {@link RepositoryFileFilters} disables both and says why.
 * 3. **Selection was cleared by every read.** The effect that cleared it keyed on the whole
 *    response object, so a silent re-read wiped a selection the reader had just made. It now
 *    keys on the identity of the result *set* — the branch, the filters and the offset —
 *    which is the thing that actually invalidates a selection.
 */

import { FileCode2, GitCommitHorizontal, Loader2, RefreshCw, Upload } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import { Card } from '@/app/components/ui/Card';
import { ErrorState } from '@/app/components/ui/ErrorState';
import { FormatPill } from '@/app/components/ui/catalog/FormatPill';
import { cn } from '@lib/utils';
import { RepositoryFileDetail } from '@/app/components/ade/dashboard/repositories/RepositoryFileDetail';
import { RepositoryFileImportMapping } from '@/app/components/ade/dashboard/repositories/RepositoryFileImportMapping';
import { repositoryFileQualityBadge } from '@/app/utils/repository-file-quality';
import type { RepositoryFileStagedImportTarget } from '@/app/components/ade/dashboard/repositories/repositoryFileStagedImport';
import {
  BRANCH_TIP_NOTE,
  COMPARE_BRANCHES_STUB_TOAST,
  DEEP_LINK_MISS_TOAST,
  DIFF_VS_DEFAULT_NEEDS_BRANCHES,
  DIFF_VS_DEFAULT_STUB_TOAST,
  EMPTY_REPOSITORY_FILE_FILTERS,
  FILES_EMPTY_COPY,
  FILE_FILTER_DEBOUNCE_MS,
  FILE_PAGE_SIZE,
  QUALITY_COLUMN_TOOLTIP,
  REFRESH_FROM_REMOTE_STUB_TOAST,
  RESCAN_BRANCH_STUB_TOAST,
  RepositoryBranchPicker,
  RepositoryFileFilters,
  branchFileCountLine,
  formatFileBytes,
  importSelectedNotice,
  repositoryFileConfidence,
  repositoryFilesQuery,
  repositoryFilesShowingLine,
  repositoryFilesSummaryLine,
  shortSha,
  type RepositoryFileDeepLink,
  type RepositoryFileFilterState,
} from '@/app/components/ade/repositories';
import { RepositoryFileRowMenu } from '@/app/components/ade/repositories/RepositoryFileRowMenu';

/** One indexed file, as `GET /api/repositories/{id}/files` returns it. */
export type RepositoryFileApiRow = {
  id: string;
  path: string;
  name: string;
  ext?: string | null;
  size_bytes?: number | null;
  blob_sha?: string | null;
  detected_kind?: string | null;
  display_kind: string;
  confidence: string;
  /** REPO-2.8: rough 0–100 score for a classified spec; null until scored / when unscorable. */
  quality_score?: number | null;
  quality_grade?: string | null;
  quality_status?: string | null;
  quality_reason?: string | null;
};

type FilesApiResponse = {
  success?: boolean;
  branch: string;
  branches: string[];
  indexed_total: number;
  match_count: number;
  importable_match_count: number;
  limit: number;
  offset: number;
  files: RepositoryFileApiRow[];
  error?: string;
};

/** The table's eight columns, in the mockup's order. */
const FILE_COLUMNS = [
  'Path',
  'Detected kind',
  'Quality',
  'Confidence',
  'Size',
  'Blob',
] as const;

/**
 * Hold a value until it has stopped changing for `delayMs`.
 *
 * @param value The value to debounce.
 * @param delayMs How long it has to stay still.
 * @returns The settled value.
 */
function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

export interface RepositoryFilesBrowserProps {
  repositoryId: string;
  defaultBranch: string;
  repositoryName: string;
  /** Display slug for Git-linked repos, e.g. `org/repo`. */
  repositoryFullName: string;
  githubWebBase: string | null;
  /**
   * The branch to read. Owned by the detail client so the header's branch control and this
   * tab's popover are one state; omitted, the tab falls back to `defaultBranch`.
   */
  branch?: string;
  /** Every indexed branch known so far. */
  branches?: readonly string[];
  /** Ask the owner to switch branches. */
  onBranchChange?: (branch: string) => void;
  /** Report the branches a read discovered, so the header's control can list them too. */
  onBranchesDiscovered?: (branches: string[]) => void;
  /** Open this indexed path on the given branch (e.g. from an import-history deep link). */
  filesDeepLink?: RepositoryFileDeepLink | null;
  onFilesDeepLinkConsumed?: () => void;
}

/**
 * Render the Files tab. See {@link RepositoryFilesBrowserProps}.
 *
 * @returns The branch bar, the filter toolbar and the file table — or, when one is open, the
 *   file-detail pane with the Map & import overlay over it.
 */
export function RepositoryFilesBrowser({
  repositoryId,
  defaultBranch,
  repositoryName,
  repositoryFullName,
  githubWebBase,
  branch: branchProp,
  branches: branchesProp,
  onBranchChange,
  onBranchesDiscovered,
  filesDeepLink,
  onFilesDeepLinkConsumed,
}: RepositoryFilesBrowserProps) {
  // The branch is the owner's when it supplies one, and this component's otherwise — so the
  // tab still works standalone (the gallery, the jsdom suite) without a parent to hold it.
  const [localBranch, setLocalBranch] = useState(defaultBranch);
  const branch = branchProp ?? localBranch;
  const [localBranches, setLocalBranches] = useState<string[]>([defaultBranch]);
  const branches = branchesProp?.length ? branchesProp : localBranches;

  const [filters, setFilters] = useState<RepositoryFileFilterState>({
    ...EMPTY_REPOSITORY_FILE_FILTERS,
  });
  const [pageOffset, setPageOffset] = useState(0);
  const debouncedGlob = useDebounced(filters.glob, FILE_FILTER_DEBOUNCE_MS);
  const debouncedRegex = useDebounced(filters.regex, FILE_FILTER_DEBOUNCE_MS);

  const [data, setData] = useState<FilesApiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailFile, setDetailFile] = useState<RepositoryFileApiRow | null>(null);
  const [importFile, setImportFile] = useState<RepositoryFileApiRow | null>(null);
  const [stagedImportTarget, setStagedImportTarget] =
    useState<RepositoryFileStagedImportTarget | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set<string>());
  const selectAllRef = useRef<HTMLInputElement | null>(null);

  /**
   * The identity of the current result *set*.
   *
   * Selection survives a re-read of the same set (a silent poll, an explicit Apply) and is
   * dropped when the set itself changes. Keying the reset on the response object instead —
   * what this replaces did — wiped a selection on every refetch, including ones the reader did
   * not ask for.
   */
  const resultSetKey = useMemo(
    () =>
      [
        branch,
        pageOffset,
        filters.preset,
        debouncedGlob.trim(),
        debouncedRegex.trim(),
        filters.hideNonImportable,
        filters.includeHidden,
        filters.skipVendor,
      ].join(' '),
    [
      branch,
      pageOffset,
      filters.preset,
      debouncedGlob,
      debouncedRegex,
      filters.hideNonImportable,
      filters.includeHidden,
      filters.skipVendor,
    ]
  );

  useEffect(() => {
    setSelectedIds(new Set<string>());
  }, [resultSetKey]);

  // Reflect partial selection as the indeterminate state on the header checkbox — a tri-state
  // a checkbox can only be given imperatively.
  useEffect(() => {
    const el = selectAllRef.current;
    if (!el) return;
    const rows = data?.files ?? [];
    const all = rows.length > 0 && rows.every((f) => selectedIds.has(f.id));
    const some = rows.some((f) => selectedIds.has(f.id));
    el.indeterminate = some && !all;
  }, [data, selectedIds]);

  const handleStagedImportTargetChange = useCallback(
    (target: RepositoryFileStagedImportTarget | null) => {
      setStagedImportTarget((prev) => {
        if (target) return target;
        if (!importFile) return prev;
        if (
          prev &&
          prev.fileId === importFile.id &&
          prev.repositoryId === repositoryId &&
          prev.branch === branch
        ) {
          return null;
        }
        return prev;
      });
    },
    [importFile, repositoryId, branch]
  );

  const lastDeepLinkKeyDoneRef = useRef<string | null>(null);
  const onDeepLinkConsumedRef = useRef(onFilesDeepLinkConsumed);
  onDeepLinkConsumedRef.current = onFilesDeepLinkConsumed;
  const onBranchesDiscoveredRef = useRef(onBranchesDiscovered);
  onBranchesDiscoveredRef.current = onBranchesDiscovered;

  const setBranch = useCallback(
    (next: string) => {
      setLocalBranch(next);
      onBranchChange?.(next);
      setPageOffset(0);
    },
    [onBranchChange]
  );

  useEffect(() => {
    setLocalBranch(defaultBranch);
    setLocalBranches((prev) => (prev.includes(defaultBranch) ? prev : [...prev, defaultBranch]));
    setPageOffset(0);
  }, [defaultBranch]);

  useEffect(() => {
    setStagedImportTarget(null);
  }, [branch, repositoryId]);

  const fetchFiles = useCallback(
    async (opts?: { deepLink?: RepositoryFileDeepLink }) => {
      setLoading(true);
      setError(null);
      const qs = repositoryFilesQuery(
        { ...filters, glob: debouncedGlob, regex: debouncedRegex },
        { branch, offset: pageOffset, limit: FILE_PAGE_SIZE },
        opts?.deepLink
      );

      try {
        const res = await fetch(
          `/api/repositories/${encodeURIComponent(repositoryId)}/files?${qs.toString()}`,
          { credentials: 'include' }
        );
        const json = (await res.json().catch(() => ({}))) as FilesApiResponse & { error?: string };
        if (!res.ok) {
          throw new Error(typeof json.error === 'string' ? json.error : res.statusText);
        }
        setData(json);
        const discovered = json.branches?.length
          ? json.branches
          : [opts?.deepLink?.branch ?? branch];
        setLocalBranches(discovered);
        onBranchesDiscoveredRef.current?.(discovered);
        if (opts?.deepLink?.path) {
          const wantPath = opts.deepLink.path;
          const hit = json.files?.find((f) => f.path === wantPath);
          if (hit) {
            setBranch(opts.deepLink.branch);
            setDetailFile(hit);
          } else {
            toast.error(DEEP_LINK_MISS_TOAST);
          }
          onDeepLinkConsumedRef.current?.();
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Could not load files';
        setError(msg);
        setData(null);
        toast.error(msg);
        if (opts?.deepLink) onDeepLinkConsumedRef.current?.();
      } finally {
        setLoading(false);
      }
    },
    [repositoryId, branch, pageOffset, filters, debouncedGlob, debouncedRegex, setBranch]
  );

  // A filter change is a new result set, so it starts at page one. `useLayoutEffect` so the
  // offset is already zero by the time the read below fires.
  useLayoutEffect(() => {
    setPageOffset(0);
  }, [
    filters.preset,
    debouncedGlob,
    debouncedRegex,
    filters.hideNonImportable,
    filters.includeHidden,
    filters.skipVendor,
  ]);

  useEffect(() => {
    if (!filesDeepLink) {
      lastDeepLinkKeyDoneRef.current = null;
      return;
    }
    const k = `${filesDeepLink.branch} ${filesDeepLink.path}`;
    if (lastDeepLinkKeyDoneRef.current === k) return;
    lastDeepLinkKeyDoneRef.current = k;
    setBranch(filesDeepLink.branch);
    void fetchFiles({ deepLink: filesDeepLink });
  }, [filesDeepLink, fetchFiles, setBranch]);

  useEffect(() => {
    if (filesDeepLink) return;
    void fetchFiles();
  }, [fetchFiles, filesDeepLink]);

  const detailStagedImport =
    detailFile &&
    stagedImportTarget &&
    stagedImportTarget.repositoryId === repositoryId &&
    stagedImportTarget.fileId === detailFile.id &&
    stagedImportTarget.branch === branch
      ? stagedImportTarget
      : null;

  /**
   * The Map & import overlay.
   *
   * Rendered beside whichever pane is showing rather than instead of it, so closing it puts
   * the reader back on the row — or the file — that opened it.
   */
  const importOverlay = importFile ? (
    <RepositoryFileImportMapping
      repositoryId={repositoryId}
      repositoryName={repositoryName}
      repositoryFullName={repositoryFullName}
      branch={branch}
      file={importFile}
      open
      onOpenChange={(open) => {
        if (!open) setImportFile(null);
      }}
      onStagedImportTargetChange={handleStagedImportTargetChange}
    />
  ) : null;

  if (detailFile) {
    return (
      <>
        <RepositoryFileDetail
          repositoryId={repositoryId}
          repositoryName={repositoryName}
          branch={branch}
          file={detailFile}
          githubWebBase={githubWebBase}
          onBack={() => setDetailFile(null)}
          onMapImport={() => setImportFile(detailFile)}
          stagedImportTarget={detailStagedImport}
          onContinueStagedImport={() => setImportFile(detailFile)}
        />
        {importOverlay}
      </>
    );
  }

  const pageFiles = data?.files ?? [];
  const allSelected = pageFiles.length > 0 && pageFiles.every((f) => selectedIds.has(f.id));
  const canPrev = Boolean(data && data.offset > 0);
  const canNext = Boolean(data && data.offset + data.files.length < data.match_count);

  const toggleSelectAll = () => {
    setSelectedIds(() => (allSelected ? new Set<string>() : new Set(pageFiles.map((f) => f.id))));
  };
  const toggleRow = (fileId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });
  };
  const importSelected = () => {
    const chosen = pageFiles.filter((f) => selectedIds.has(f.id));
    if (chosen.length === 0) return;
    const notice = importSelectedNotice(chosen.map((f) => f.path));
    if (notice) toast.message(notice);
    setImportFile(chosen[0]);
  };

  return (
    <div className="flex flex-col gap-4" data-testid="repository-files-tab">
      <Card className="repo-files-branchbar" data-testid="repository-branch-bar">
        <RepositoryBranchPicker
          branch={branch}
          defaultBranch={defaultBranch}
          branches={branches}
          onSelect={setBranch}
          onCompareBranches={() => toast.message(COMPARE_BRANCHES_STUB_TOAST)}
          onRefreshFromRemote={() => toast.message(REFRESH_FROM_REMOTE_STUB_TOAST)}
        />

        <span className="repo-files-branchbar__note">
          <GitCommitHorizontal aria-hidden />
          {BRANCH_TIP_NOTE}
        </span>

        <span className="repo-files-branchbar__note">
          <FileCode2 aria-hidden />
          <span className="mono truncate">
            {branchFileCountLine(data?.indexed_total, branch)}
          </span>
        </span>

        <div className="repo-files-branchbar__end">
          <label
            className="repo-files-check"
            title={branches.length < 2 ? DIFF_VS_DEFAULT_NEEDS_BRANCHES : undefined}
          >
            <input
              type="checkbox"
              disabled={branches.length < 2}
              onChange={() => toast.message(DIFF_VS_DEFAULT_STUB_TOAST)}
            />
            Diff vs <span className="mono">{defaultBranch}</span>
          </label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => toast.message(RESCAN_BRANCH_STUB_TOAST)}
          >
            <RefreshCw aria-hidden />
            Rescan branch
          </Button>
        </div>
      </Card>

      <Card>
        <RepositoryFileFilters
          value={filters}
          busy={loading}
          onChange={(patch) => setFilters((prev) => ({ ...prev, ...patch }))}
          onReset={() => {
            setFilters({ ...EMPTY_REPOSITORY_FILE_FILTERS });
            setPageOffset(0);
          }}
          onApply={() => void fetchFiles()}
        />
      </Card>

      {error ? (
        <ErrorState
          title="Could not list this branch’s files"
          description={error}
          onRetry={() => void fetchFiles()}
        />
      ) : (
        <div className="repo-det-table-wrap" data-testid="repository-files-table-wrap">
          <div className="repo-det-table__bar">
            <p className="text-sm font-medium text-fg" data-testid="repository-files-summary">
              {repositoryFilesSummaryLine({
                matchCount: data?.match_count ?? null,
                importableCount: data?.importable_match_count ?? null,
                selectedCount: selectedIds.size,
              })}
            </p>
            {loading ? (
              <Loader2 className="size-4 shrink-0 animate-spin text-fg-muted" aria-hidden />
            ) : null}
            <div className="repo-det-table__bar-end">
              <Button
                type="button"
                size="sm"
                disabled={selectedIds.size === 0}
                onClick={importSelected}
                data-testid="repository-import-selected"
              >
                <Upload aria-hidden />
                Import selected
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={selectedIds.size === 0}
                onClick={() => setSelectedIds(new Set<string>())}
              >
                Clear
              </Button>
            </div>
          </div>

          <div className="repo-det-table-scroll">
            <table
              className="repo-det-table repo-files-table table-density table-dense"
              data-loading={loading ? 'true' : undefined}
            >
              <thead>
                <tr>
                  <th scope="col" className="repo-files-table__check">
                    <input
                      ref={selectAllRef}
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleSelectAll}
                      disabled={pageFiles.length === 0}
                      aria-label="Select all files on this page"
                    />
                  </th>
                  {FILE_COLUMNS.map((column) => (
                    <th
                      key={column}
                      scope="col"
                      className={cn(
                        column === 'Path' && 'repo-files-table__path',
                        column === 'Size' && 'repo-det-num'
                      )}
                      title={column === 'Quality' ? QUALITY_COLUMN_TOOLTIP : undefined}
                    >
                      {column}
                    </th>
                  ))}
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {!loading && data && pageFiles.length === 0 ? (
                  <tr>
                    <td
                      colSpan={FILE_COLUMNS.length + 2}
                      className="repo-det-table__state"
                      data-testid="repository-files-empty"
                    >
                      {FILES_EMPTY_COPY}
                    </td>
                  </tr>
                ) : null}
                {pageFiles.map((f) => {
                  const confidence = repositoryFileConfidence(f.confidence);
                  const quality = repositoryFileQualityBadge(f);
                  const selected = selectedIds.has(f.id);
                  return (
                    <tr key={f.id} data-selected={selected ? 'true' : undefined}>
                      <td className="repo-files-table__check">
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => toggleRow(f.id)}
                          aria-label={`Select ${f.path}`}
                        />
                      </td>
                      <td className="repo-files-table__path">
                        <button
                          type="button"
                          className="repo-files-table__link mono"
                          onClick={() => setDetailFile(f)}
                        >
                          {f.path}
                        </button>
                      </td>
                      <td>
                        <FormatPill format={f.display_kind} />
                      </td>
                      <td>
                        <Badge
                          variant={quality.tone}
                          mono
                          title={quality.title}
                          data-testid="repository-file-quality"
                        >
                          {quality.label}
                        </Badge>
                      </td>
                      <td>
                        <Badge variant={confidence.tone} mono>
                          {confidence.label}
                        </Badge>
                      </td>
                      <td className="repo-det-num repo-det-quiet-cell">
                        {formatFileBytes(f.size_bytes)}
                      </td>
                      <td className="repo-det-quiet-cell mono">{shortSha(f.blob_sha)}</td>
                      <td>
                        <RepositoryFileRowMenu
                          path={f.path}
                          branch={branch}
                          githubWebBase={githubWebBase}
                          onView={() => setDetailFile(f)}
                          onImport={() => setImportFile(f)}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="repo-det-table__foot">
            <span>
              {repositoryFilesShowingLine({
                offset: data?.offset ?? 0,
                rows: pageFiles.length,
                matchCount: data?.match_count ?? 0,
              })}
            </span>
            <span className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!canPrev || loading}
                onClick={() => setPageOffset((o) => Math.max(0, o - FILE_PAGE_SIZE))}
              >
                Prev
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!canNext || loading}
                onClick={() => setPageOffset((o) => o + FILE_PAGE_SIZE)}
              >
                Next
              </Button>
            </span>
          </div>
        </div>
      )}

      {importOverlay}
    </div>
  );
}
