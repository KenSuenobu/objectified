'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  Check,
  ChevronDown,
  Copy,
  Download,
  ExternalLink,
  Eye,
  FileCode2,
  GitBranch,
  GitCommitHorizontal,
  Loader2,
  MoreVertical,
  RefreshCw,
  Search,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/app/components/ui/Button';
import { Input } from '@/app/components/ui/Input';
import { cn } from '@lib/utils';
import { RepositoryFileDetail } from '@/app/components/ade/dashboard/repositories/RepositoryFileDetail';
import { RepositoryFileImportMapping } from '@/app/components/ade/dashboard/repositories/RepositoryFileImportMapping';
import { repositoryFileQualityBadge } from '@/app/utils/repository-file-quality';
import type { RepositoryFileStagedImportTarget } from '@/app/components/ade/dashboard/repositories/repositoryFileStagedImport';

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

const PRESET_OPTIONS: { value: string; label: string }[] = [
  { value: 'all', label: 'All importable types' },
  { value: 'openapi', label: 'OpenAPI (openapi.*, swagger.*)' },
  { value: 'arazzo', label: 'Arazzo' },
  { value: 'asyncapi', label: 'AsyncAPI' },
  { value: 'json_schema', label: 'JSON Schema (*.schema.json, schemas/**)' },
  { value: 'graphql', label: 'GraphQL SDL' },
  { value: 'protobuf', label: 'Protobuf (*.proto)' },
  { value: 'avro', label: 'Avro (*.avsc)' },
  { value: 'postman', label: 'Postman collection' },
  { value: 'sql_ddl', label: 'SQL DDL (*.sql, *.ddl)' },
  { value: 'custom', label: 'Custom — specify glob below' },
];

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

function formatBytes(n: number | null | undefined): string {
  if (n == null || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function shortSha(sha: string | null | undefined): string {
  if (!sha) return '—';
  const s = sha.trim();
  return s.length > 7 ? s.slice(0, 7) : s;
}

/** Escape path for POSIX-regex file listing (`path ~* pattern`). */
function escapeRegexPath(path: string): string {
  return path.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

function kindPillClass(displayKind: string): string {
  const k = displayKind.toLowerCase();
  if (k.includes('openapi')) {
    return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300';
  }
  if (k.includes('arazzo')) {
    return 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300';
  }
  if (k.includes('asyncapi')) {
    return 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300';
  }
  if (k.includes('json schema')) {
    return 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300';
  }
  if (k.includes('graphql')) {
    return 'bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300';
  }
  if (k.includes('protobuf') || k.includes('postman') || k.includes('sql')) {
    return 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200';
  }
  return 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300';
}

function confidenceBadge(conf: string): { label: string; className: string } {
  const c = conf.toLowerCase();
  if (c === 'filename' || c.includes('filename')) {
    return {
      label: 'filename',
      className:
        'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
    };
  }
  return { label: conf || '—', className: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' };
}

/** Per-row overflow actions menu, matching the dashboard's RepositoryRowMenu pattern. */
function FileRowActions({
  file,
  branch,
  githubWebBase,
  onView,
  onImport,
}: {
  file: RepositoryFileApiRow;
  branch: string;
  githubWebBase: string | null;
  onView: () => void;
  onImport: () => void;
}) {
  const blobUrl = githubWebBase
    ? `${githubWebBase.replace(/\/+$/, '')}/blob/${branch}/${file.path
        .split('/')
        .map((seg) => encodeURIComponent(seg))
        .join('/')}`
    : null;

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(file.path);
      toast.success('Path copied to clipboard.');
    } catch {
      toast.error('Could not copy path.');
    }
  };

  const itemClass =
    'flex cursor-pointer items-center gap-2 px-3 py-2 text-sm outline-none hover:bg-gray-50 data-[highlighted]:bg-gray-50 dark:hover:bg-gray-700/50 dark:data-[highlighted]:bg-gray-700/50';

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="rounded-lg p-1.5 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-100"
          aria-label={`Actions for ${file.path}`}
          onClick={(e) => e.stopPropagation()}
        >
          <MoreVertical className="h-4 w-4" aria-hidden />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="z-50 min-w-[11rem] rounded-lg border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-800"
          sideOffset={4}
          align="end"
        >
          <DropdownMenu.Item className={itemClass} onSelect={() => onView()}>
            <Eye className="h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400" aria-hidden />
            View details
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className={cn(
              itemClass,
              'text-indigo-600 hover:bg-indigo-50 data-[highlighted]:bg-indigo-50 dark:text-indigo-300 dark:hover:bg-indigo-900/20 dark:data-[highlighted]:bg-indigo-900/20'
            )}
            onSelect={() => onImport()}
          >
            <Download className="h-4 w-4 shrink-0" aria-hidden />
            Import…
          </DropdownMenu.Item>
          {blobUrl ? (
            <DropdownMenu.Item asChild className={itemClass}>
              <a href={blobUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400" aria-hidden />
                Open on provider
              </a>
            </DropdownMenu.Item>
          ) : null}
          <DropdownMenu.Item className={itemClass} onSelect={() => void copyPath()}>
            <Copy className="h-4 w-4 shrink-0 text-gray-500 dark:text-gray-400" aria-hidden />
            Copy path
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function RepositoryFilesBrowser({
  repositoryId,
  defaultBranch,
  repositoryName,
  repositoryFullName,
  githubWebBase,
  filesDeepLink,
  onFilesDeepLinkConsumed,
}: {
  repositoryId: string;
  defaultBranch: string;
  repositoryName: string;
  /** Display slug for Git-linked repos, e.g. `org/repo` */
  repositoryFullName: string;
  githubWebBase: string | null;
  /** Open this indexed path on the given branch (e.g. from import history deep link). */
  filesDeepLink?: { path: string; branch: string } | null;
  onFilesDeepLinkConsumed?: () => void;
}) {
  const [branch, setBranch] = useState(defaultBranch);
  const [branchSearch, setBranchSearch] = useState('');
  const [branches, setBranches] = useState<string[]>([defaultBranch]);

  const [draftPreset, setDraftPreset] = useState('all');
  const [draftGlob, setDraftGlob] = useState('');
  const [draftRegex, setDraftRegex] = useState('');
  const [draftHideNonImportable, setDraftHideNonImportable] = useState(true);
  const [draftSkipVendor, setDraftSkipVendor] = useState(true);
  const [draftIncludeHidden, setDraftIncludeHidden] = useState(false);

  const [pageOffset, setPageOffset] = useState(0);
  const debouncedGlob = useDebounced(draftGlob, 200);
  const debouncedRegex = useDebounced(draftRegex, 200);

  const [data, setData] = useState<FilesApiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailFile, setDetailFile] = useState<RepositoryFileApiRow | null>(null);
  const [importFile, setImportFile] = useState<RepositoryFileApiRow | null>(null);
  const [stagedImportTarget, setStagedImportTarget] = useState<RepositoryFileStagedImportTarget | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set<string>());
  const selectAllRef = useRef<HTMLInputElement | null>(null);

  // Selection is scoped to the current results page; clear it whenever the
  // result set changes (new branch, filters, or pagination).
  useEffect(() => {
    setSelectedIds(new Set<string>());
  }, [data]);

  // Reflect partial selection as the indeterminate state on the header checkbox.
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

  useEffect(() => {
    setBranch(defaultBranch);
    setBranches((prev) => (prev.includes(defaultBranch) ? prev : [...prev, defaultBranch]));
    setPageOffset(0);
  }, [defaultBranch]);

  useEffect(() => {
    setStagedImportTarget(null);
  }, [branch, repositoryId]);

  const pageSize = 50;

  type FetchFilesOpts = { deepLink?: { path: string; branch: string } };

  const fetchFiles = useCallback(
    async (opts?: FetchFilesOpts) => {
      setLoading(true);
      setError(null);
      const qs = new URLSearchParams();
      const branchForReq = opts?.deepLink?.branch ?? branch;
      qs.set('branch', branchForReq);
      qs.set('limit', String(pageSize));
      qs.set('offset', String(opts?.deepLink ? 0 : pageOffset));

      if (opts?.deepLink?.path) {
        qs.set('regex', `^${escapeRegexPath(opts.deepLink.path)}$`);
        qs.set('hide_non_importable', 'false');
        qs.set('skip_vendor', draftSkipVendor ? 'true' : 'false');
        qs.set('include_hidden', draftIncludeHidden ? 'true' : 'false');
      } else {
        if (debouncedRegex.trim()) {
          qs.set('regex', debouncedRegex.trim());
        } else {
          if (draftPreset) qs.set('preset', draftPreset);
          if (debouncedGlob.trim()) qs.set('glob', debouncedGlob.trim());
        }
        qs.set('hide_non_importable', draftHideNonImportable ? 'true' : 'false');
        qs.set('skip_vendor', draftSkipVendor ? 'true' : 'false');
        qs.set('include_hidden', draftIncludeHidden ? 'true' : 'false');
      }

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
        setBranches(json.branches?.length ? json.branches : [branchForReq]);
        if (opts?.deepLink?.path) {
          const wantPath = opts.deepLink.path;
          const hit = json.files?.find((f) => f.path === wantPath);
          if (hit) {
            setBranch(opts.deepLink.branch);
            setDetailFile(hit);
          } else {
            toast.error('That file is not in the repository index for this branch anymore.');
          }
          onDeepLinkConsumedRef.current?.();
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Could not load files';
        setError(msg);
        setData(null);
        toast.error(msg);
        if (opts?.deepLink) {
          onDeepLinkConsumedRef.current?.();
        }
      } finally {
        setLoading(false);
      }
    },
    [
      repositoryId,
      branch,
      pageOffset,
      draftPreset,
      debouncedGlob,
      debouncedRegex,
      draftHideNonImportable,
      draftSkipVendor,
      draftIncludeHidden,
    ]
  );

  useLayoutEffect(() => {
    setPageOffset(0);
  }, [
    draftPreset,
    debouncedGlob,
    debouncedRegex,
    draftHideNonImportable,
    draftSkipVendor,
    draftIncludeHidden,
  ]);

  useEffect(() => {
    if (!filesDeepLink) {
      lastDeepLinkKeyDoneRef.current = null;
      return;
    }
    const k = `${filesDeepLink.branch}\0${filesDeepLink.path}`;
    if (lastDeepLinkKeyDoneRef.current === k) return;
    lastDeepLinkKeyDoneRef.current = k;
    setBranch(filesDeepLink.branch);
    void fetchFiles({ deepLink: filesDeepLink });
  }, [filesDeepLink, fetchFiles]);

  useEffect(() => {
    if (filesDeepLink) return;
    void fetchFiles();
  }, [fetchFiles, filesDeepLink]);

  const filteredBranches = useMemo(() => {
    const q = branchSearch.trim().toLowerCase();
    if (!q) return branches;
    return branches.filter((b) => b.toLowerCase().includes(q));
  }, [branches, branchSearch]);

  const pathBreadcrumb = '/';

  if (importFile) {
    return (
      <RepositoryFileImportMapping
        repositoryId={repositoryId}
        repositoryName={repositoryName}
        repositoryFullName={repositoryFullName}
        branch={branch}
        file={importFile}
        onBack={() => setImportFile(null)}
        onStagedImportTargetChange={handleStagedImportTargetChange}
      />
    );
  }

  const detailStagedImport =
    detailFile &&
    stagedImportTarget &&
    stagedImportTarget.repositoryId === repositoryId &&
    stagedImportTarget.fileId === detailFile.id &&
    stagedImportTarget.branch === branch
      ? stagedImportTarget
      : null;

  if (detailFile) {
    return (
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
    );
  }

  const resetFilters = () => {
    setDraftPreset('all');
    setDraftGlob('');
    setDraftRegex('');
    setDraftHideNonImportable(true);
    setDraftSkipVendor(true);
    setDraftIncludeHidden(false);
    setPageOffset(0);
  };

  const showingFrom = data ? data.offset + 1 : 0;
  const showingTo = data ? data.offset + data.files.length : 0;
  const canPrev = Boolean(data && data.offset > 0);
  const canNext = Boolean(
    data && data.offset + data.files.length < data.match_count
  );

  const pageFiles = data?.files ?? [];
  const allSelected = pageFiles.length > 0 && pageFiles.every((f) => selectedIds.has(f.id));
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
  const clearSelection = () => setSelectedIds(new Set<string>());
  const importSelected = () => {
    const chosen = pageFiles.filter((f) => selectedIds.has(f.id));
    if (chosen.length === 0) return;
    if (chosen.length > 1) {
      toast.message(
        `The import wizard maps one spec at a time — opening ${chosen[0].path}. Re-select the rest afterward.`
      );
    }
    setImportFile(chosen[0]);
  };

  return (
    <div className="space-y-4">
      {/* Branch bar — matches repository.html Files tab */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800">
        <div className="relative">
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-md border border-gray-200 px-3 py-2 text-sm hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700/50"
              >
                <GitBranch className="h-3.5 w-3.5 shrink-0 text-indigo-500" aria-hidden />
                <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  Branch
                </span>
                <span className="max-w-[200px] truncate font-mono font-medium">{branch}</span>
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-gray-400" aria-hidden />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                className="z-50 w-[min(100vw-2rem,420px)] rounded-lg border border-gray-200 bg-white shadow-xl dark:border-gray-700 dark:bg-gray-800"
                sideOffset={6}
                align="start"
              >
                <div className="border-b border-gray-200 p-2 dark:border-gray-700">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
                    <Input
                      value={branchSearch}
                      onChange={(e) => setBranchSearch(e.target.value)}
                      placeholder="Switch branch or tag…"
                      className="h-8 border-gray-200 pl-8 text-xs dark:border-gray-700"
                    />
                  </div>
                  <div className="mt-2 inline-flex overflow-hidden rounded border border-gray-200 text-[11px] dark:border-gray-700">
                    <span className="bg-indigo-50 px-2 py-1 text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-300">
                      Branches <span className="ml-1 font-mono">{branches.length}</span>
                    </span>
                    <button
                      type="button"
                      className="px-2 py-1 text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-700"
                      disabled
                      title="Tag-scoped indexes are not available yet."
                    >
                      Tags
                    </button>
                  </div>
                </div>
                <div className="max-h-72 overflow-y-auto py-1 text-sm">
                  {filteredBranches.length === 0 ? (
                    <p className="px-3 py-2 text-xs text-gray-500">No branches match.</p>
                  ) : (
                    filteredBranches.map((b) => (
                      <DropdownMenu.Item
                        key={b}
                        className="flex cursor-pointer items-center gap-2 px-3 py-2 outline-none hover:bg-gray-50 data-[highlighted]:bg-gray-50 dark:hover:bg-gray-700/50 dark:data-[highlighted]:bg-gray-700/50"
                        onSelect={() => {
                          setBranch(b);
                          setPageOffset(0);
                        }}
                      >
                        <Check
                          className={cn(
                            'h-3.5 w-3.5 shrink-0 text-indigo-500',
                            b === branch ? 'opacity-100' : 'opacity-0'
                          )}
                          aria-hidden
                        />
                        <span className="flex-1 truncate font-mono">{b}</span>
                        {b === defaultBranch ? (
                          <span className="shrink-0 rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-300">
                            default
                          </span>
                        ) : null}
                      </DropdownMenu.Item>
                    ))
                  )}
                </div>
                <div className="flex items-center justify-between border-t border-gray-200 p-2 text-[11px] dark:border-gray-700">
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 text-indigo-500 hover:text-indigo-600 dark:text-indigo-400"
                    onClick={() => toast.message('Branch compare uses git metadata not wired to the API yet.')}
                  >
                    Compare branches
                  </button>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 text-gray-500 hover:text-indigo-500 dark:text-gray-400"
                    onClick={() => toast.message('Refresh enqueues a new scan job when that endpoint exists.')}
                  >
                    <RefreshCw className="h-3 w-3" aria-hidden />
                    Refresh from remote
                  </button>
                </div>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>

        <span className="hidden h-6 border-l border-gray-200 sm:inline-block dark:border-gray-700" />

        <span className="inline-flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
          <GitCommitHorizontal className="h-3.5 w-3.5 shrink-0" aria-hidden />
          Tip commit / age from git is not stored yet; indexed tree uses blob SHAs in the table.
        </span>

        <span className="inline-flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
          <FileCode2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="font-mono">{data?.indexed_total?.toLocaleString() ?? '—'}</span> files on{' '}
          <span className="font-mono">{branch}</span>
        </span>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-gray-500 dark:text-gray-400">
            <input
              type="checkbox"
              className="rounded border-gray-300 dark:border-gray-600"
              disabled={branches.length < 2}
              title={branches.length < 2 ? 'Add another indexed branch to diff against default.' : undefined}
              onChange={() => toast.message('Diff vs default branch is not implemented yet.')}
            />
            Diff vs <span className="font-mono">{defaultBranch}</span>
          </label>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-1 text-xs"
            onClick={() => toast.message('Rescan branch will enqueue a file scan job when exposed on the API.')}
          >
            <RefreshCw className="h-3 w-3" aria-hidden />
            Rescan branch
          </Button>
        </div>
      </div>

      {/* Filter toolbar */}
      <div className="space-y-3 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
        <div className="grid grid-cols-12 gap-3">
          <div className="col-span-12 md:col-span-4">
            <label className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              Importable preset
            </label>
            <select
              value={draftPreset}
              onChange={(e) => setDraftPreset(e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900/50 dark:text-gray-100"
            >
              {PRESET_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="col-span-12 md:col-span-5">
            <label className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              Glob filter (comma-separated)
            </label>
            <Input
              value={draftGlob}
              onChange={(e) => setDraftGlob(e.target.value)}
              placeholder="**/openapi*.yaml, **/arazzo/*.yml"
              className="mt-1 font-mono text-sm"
              disabled={!!draftRegex.trim()}
            />
          </div>
          <div className="col-span-12 md:col-span-3">
            <label className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              Regex (optional)
            </label>
            <Input
              value={draftRegex}
              onChange={(e) => setDraftRegex(e.target.value)}
              placeholder="e.g. v\\d+\\.yaml$"
              className="mt-1 font-mono text-sm"
            />
          </div>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
            <label className="inline-flex cursor-pointer items-center gap-1.5">
              <input
                type="checkbox"
                className="rounded border-gray-300 dark:border-gray-600"
                checked={draftHideNonImportable}
                onChange={(e) => setDraftHideNonImportable(e.target.checked)}
              />
              Hide non-importable
            </label>
            <span className="mx-0.5">·</span>
            <label className="inline-flex cursor-pointer items-center gap-1.5">
              <input
                type="checkbox"
                className="rounded border-gray-300 dark:border-gray-600"
                checked={draftIncludeHidden}
                onChange={(e) => setDraftIncludeHidden(e.target.checked)}
              />
              Recurse hidden dirs
            </label>
            <span className="mx-0.5">·</span>
            <label className="inline-flex cursor-pointer items-center gap-1.5">
              <input
                type="checkbox"
                className="rounded border-gray-300 dark:border-gray-600"
                checked={draftSkipVendor}
                onChange={(e) => setDraftSkipVendor(e.target.checked)}
              />
              Skip vendored / node_modules
            </label>
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={resetFilters}>
              Reset
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-8 text-xs"
              disabled={loading}
              onClick={() => void fetchFiles()}
            >
              Apply filter
            </Button>
          </div>
        </div>
      </div>

      {/* File table */}
      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            <span className="font-semibold text-gray-700 dark:text-gray-200">
              {data?.match_count.toLocaleString() ?? '—'}
            </span>{' '}
            files match ·{' '}
            <span className="font-semibold text-indigo-500 dark:text-indigo-400">
              {data?.importable_match_count?.toLocaleString() ?? '—'} importable
            </span>
            {selectedIds.size > 0 ? (
              <>
                {' · '}
                <span className="font-semibold text-gray-700 dark:text-gray-200">
                  {selectedIds.size.toLocaleString()} selected
                </span>
              </>
            ) : null}
            {loading ? (
              <Loader2 className="ml-2 inline h-3.5 w-3.5 animate-spin text-gray-400" aria-hidden />
            ) : null}
          </p>
          {selectedIds.size > 0 ? (
            <div className="flex items-center gap-2">
              <Button type="button" size="sm" className="h-8 gap-1 text-xs" onClick={importSelected}>
                <Download className="h-3 w-3" aria-hidden />
                Import selected
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                onClick={clearSelection}
              >
                Clear
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
              <span>Path:</span>
              <span className="rounded bg-gray-100 px-2 py-0.5 font-mono dark:bg-gray-700">{pathBreadcrumb}</span>
            </div>
          )}
        </div>

        {error ? (
          <p className="px-4 py-8 text-center text-sm text-rose-600 dark:text-rose-400">{error}</p>
        ) : (
          <table className={cn('w-full table-fixed text-sm', loading && 'opacity-60')}>
            <thead className="border-b border-gray-200 bg-gray-50 text-[11px] uppercase tracking-wider text-gray-500 dark:border-gray-700 dark:bg-gray-900/30 dark:text-gray-400">
              <tr>
                <th className="w-10 px-4 py-2 text-left align-middle">
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    className="rounded border-gray-300 dark:border-gray-600"
                    checked={allSelected}
                    onChange={toggleSelectAll}
                    disabled={pageFiles.length === 0}
                    aria-label="Select all files on this page"
                  />
                </th>
                <th className="min-w-[20rem] w-[44%] py-2 text-left align-middle font-semibold lg:min-w-[26rem] xl:min-w-[34rem]">
                  Path
                </th>
                <th className="w-[11%] whitespace-nowrap py-2 text-left align-middle font-semibold">Detected kind</th>
                <th
                  className="w-[7%] whitespace-nowrap py-2 text-left align-middle font-semibold"
                  title="Rough 0–100 quality score for classified specs. Informational only — it does not gate import or sync."
                >
                  Quality
                </th>
                <th className="w-[9%] whitespace-nowrap py-2 text-left align-middle font-semibold">Confidence</th>
                <th className="w-[7%] whitespace-nowrap py-2 text-left align-middle font-semibold">Size</th>
                <th className="w-[8%] whitespace-nowrap py-2 text-left align-middle font-semibold">Blob</th>
                <th className="w-[8%] whitespace-nowrap py-2 pr-4 text-right align-middle font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {!loading && data && data.files.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-sm leading-relaxed text-gray-500 dark:text-gray-400">
                    No indexed files for this branch yet. Run a successful repository scan, or widen filters (turn off
                    &quot;Hide non-importable&quot;, clear regex).
                  </td>
                </tr>
              ) : null}
              {data?.files.map((f) => {
                const cb = confidenceBadge(f.confidence);
                const quality = repositoryFileQualityBadge(f);
                return (
                  <tr
                    key={f.id}
                    className={cn(
                      'hover:bg-gray-50/80 dark:hover:bg-gray-900/20',
                      selectedIds.has(f.id) && 'bg-indigo-50/60 dark:bg-indigo-900/10'
                    )}
                  >
                    <td className="w-10 px-4 py-2 align-middle">
                      <input
                        type="checkbox"
                        className="rounded border-gray-300 dark:border-gray-600"
                        checked={selectedIds.has(f.id)}
                        onChange={() => toggleRow(f.id)}
                        aria-label={`Select ${f.path}`}
                      />
                    </td>
                    <td className="min-w-0 py-2 pr-4 align-middle">
                      <button
                        type="button"
                        className="block w-full whitespace-normal break-all text-left font-mono text-xs leading-snug text-indigo-600 hover:underline dark:text-indigo-400"
                        onClick={() => setDetailFile(f)}
                      >
                        {f.path}
                      </button>
                    </td>
                    <td className="align-middle">
                      <span
                        className={cn(
                          'inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold',
                          kindPillClass(f.display_kind)
                        )}
                      >
                        {f.display_kind}
                      </span>
                    </td>
                    <td className="align-middle">
                      <span
                        className={cn(
                          'inline-block min-w-[2.25rem] whitespace-nowrap rounded px-2 py-0.5 text-center font-mono text-[11px] font-semibold',
                          quality.className
                        )}
                        title={quality.title}
                        data-testid="repository-file-quality"
                      >
                        {quality.label}
                      </span>
                    </td>
                    <td className="align-middle">
                      <span className={cn('font-mono text-[11px] px-2 py-0.5 rounded', cb.className)}>
                        {cb.label}
                      </span>
                    </td>
                    <td className="whitespace-nowrap align-middle font-mono text-xs text-gray-500 dark:text-gray-400">
                      {formatBytes(f.size_bytes)}
                    </td>
                    <td className="whitespace-nowrap align-middle font-mono text-xs text-gray-500 dark:text-gray-400">
                      {shortSha(f.blob_sha)}
                    </td>
                    <td className="align-middle pr-4 text-right">
                      <div className="flex items-center justify-end">
                        <FileRowActions
                          file={f}
                          branch={branch}
                          githubWebBase={githubWebBase}
                          onView={() => setDetailFile(f)}
                          onImport={() => setImportFile(f)}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-200 px-4 py-3 dark:border-gray-700">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {data && data.match_count > 0
              ? `Showing ${showingFrom.toLocaleString()}–${showingTo.toLocaleString()} of ${data.match_count.toLocaleString()}`
              : '—'}
          </p>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              disabled={!canPrev || loading}
              onClick={() => setPageOffset((o) => Math.max(0, o - pageSize))}
            >
              Prev
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              disabled={!canNext || loading}
              onClick={() => setPageOffset((o) => o + pageSize)}
            >
              Next
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
