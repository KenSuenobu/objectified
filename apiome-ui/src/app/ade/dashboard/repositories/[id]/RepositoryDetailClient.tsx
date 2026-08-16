'use client';

import { useAuthSession } from '@lib/auth/session-client';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  GitBranch,
  Github,
  Globe,
  Loader2,
  RefreshCw,
  Plus,
} from 'lucide-react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/app/components/ui/AlertDialog';
import { Button, buttonVariants } from '@/app/components/ui/Button';
import { Input } from '@/app/components/ui/Input';
import { LoadingState } from '@/app/components/ui/LoadingState';
import { Switch } from '@/app/components/ui/Switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/app/components/ui/Select';
import { toast } from 'sonner';
import { cn } from '@lib/utils';
import { tabTriggerClass } from '@/app/components/ui/tabStyles';
import {
  type DashboardRepository,
  type RepositoryStatus,
  RepositoryKpiCard,
  REPOSITORY_STATUS_POLL_MS,
  dashboardRepositoryFromApi,
  estimatedImportableMixForRepo,
  formatLastScan,
  repoInitials,
  repositoryStatusNeedsPolling,
} from '@/app/components/ade/dashboard/repositories/repositoryStoreUi';
import { RepositoryConflictPolicy } from '@/app/components/ade/dashboard/repositories/RepositoryConflictPolicy';
import { RepositoryHealthBadge } from '@/app/components/ade/dashboard/repositories/RepositoryHealthBadge';
import { RepositoryFilesBrowser } from '@/app/components/ade/dashboard/repositories/RepositoryFilesBrowser';
import { RepositorySpecsTab } from '@/app/components/ade/dashboard/repositories/RepositorySpecsTab';

type RepoTab = 'preview' | 'files' | 'specs' | 'imports' | 'settings';

type RepositoryImportMetricApiRow = {
  id: string;
  path: string;
  branch: string;
  blob_sha: string | null;
  created_at: string;
  project_id: string;
  project_name: string;
  project_slug: string;
  catalog_version_label: string;
  version_uuid: string;
  imported_by: string | null;
  imported_by_name: string | null;
  imported_by_email: string | null;
};

function shortBlobRef(sha: string | null | undefined): string {
  if (!sha?.trim()) return '';
  const s = sha.trim();
  return s.length > 10 ? `${s.slice(0, 7)}…` : s;
}

function formatImportedByActor(row: {
  imported_by_name: string | null;
  imported_by_email: string | null;
}): string {
  const n = row.imported_by_name?.trim();
  if (n) return n;
  const e = row.imported_by_email?.trim();
  if (e) return e;
  return '—';
}

function formatRelativeWhen(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const sec = Math.floor((Date.now() - t) / 1000);
  if (sec < 45) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 604800) return `${Math.floor(sec / 86400)}d ago`;
  return new Date(iso).toLocaleString();
}

/** Deep-link into Files tab and open the indexed path on the recorded branch. */
function repositoryImportedFileHref(repositoryId: string, path: string, branch: string): string {
  const qs = new URLSearchParams();
  qs.set('tab', 'files');
  qs.set('path', path);
  qs.set('branch', branch);
  return `/ade/dashboard/repositories/${encodeURIComponent(repositoryId)}/preview?${qs.toString()}`;
}

function providerSlug(repo: DashboardRepository): string {
  if (repo.provider === 'github' && repo.full_name && !repo.full_name.includes('://')) {
    return `github.com/${repo.full_name}`;
  }
  if (repo.clone_url) {
    try {
      const u = new URL(repo.clone_url);
      const path = u.pathname.replace(/\.git\/?$/i, '') || '/';
      return `${u.hostname}${path === '/' ? '' : path}`;
    } catch {
      /* ignore */
    }
  }
  return repo.full_name || '—';
}

function statusPill(status: RepositoryStatus) {
  switch (status) {
    case 'ready':
      return (
        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-2xs font-semibold text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
          Active
        </span>
      );
    case 'scanning':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2 py-0.5 text-2xs font-semibold text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">
          <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden />
          Scanning
        </span>
      );
    case 'pending':
      return (
        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-2xs font-semibold text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
          Pending
        </span>
      );
    case 'error':
      return (
        <span className="rounded-full bg-rose-100 px-2 py-0.5 text-2xs font-semibold text-rose-700 dark:bg-rose-900/40 dark:text-rose-300">
          Error
        </span>
      );
    case 'archived':
      return (
        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-2xs font-semibold text-gray-600 dark:bg-gray-700 dark:text-gray-300">
          Archived
        </span>
      );
    default:
      return null;
  }
}

function TabBtn({
  active,
  onClick,
  children,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  badge?: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={tabTriggerClass({ active })}
    >
      {children}
      {badge !== undefined ? (
        <span
          className={cn(
            'rounded-full px-1.5 py-0.5 text-2xs',
            active
              ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300'
              : 'bg-gray-200 dark:bg-gray-700'
          )}
        >
          {badge}
        </span>
      ) : null}
    </button>
  );
}

export function RepositoryDetailClient() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const id = typeof params?.id === 'string' ? params.id : '';
  const { data: session } = useAuthSession();
  const currentTenantId = (session?.user as { current_tenant_id?: string })?.current_tenant_id;

  const [repo, setRepo] = useState<DashboardRepository | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<RepoTab>('preview');
  const [removing, setRemoving] = useState(false);
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
  const [savingAutoRefresh, setSavingAutoRefresh] = useState(false);
  const [repoImports, setRepoImports] = useState<RepositoryImportMetricApiRow[]>([]);
  const [importsLoading, setImportsLoading] = useState(false);
  const [importsError, setImportsError] = useState<string | null>(null);
  const [stats30d, setStats30d] = useState<{ totalImports: number; distinctProjects: number } | null>(null);

  const filesDeepLink = useMemo(() => {
    const path = searchParams.get('path')?.trim();
    const branch = searchParams.get('branch')?.trim();
    if (!path || !branch) return null;
    const t = searchParams.get('tab');
    if (t != null && t !== '' && t !== 'files') return null;
    return { path, branch };
  }, [searchParams]);

  useEffect(() => {
    const path = searchParams.get('path')?.trim();
    const branch = searchParams.get('branch')?.trim();
    if (path && branch) {
      setTab('files');
      return;
    }
    const t = searchParams.get('tab');
    if (t === 'files' || t === 'specs' || t === 'imports' || t === 'settings' || t === 'preview') {
      setTab(t as RepoTab);
    }
  }, [searchParams]);

  const consumeFilesDeepLink = useCallback(() => {
    if (!id) return;
    router.replace(`/ade/dashboard/repositories/${encodeURIComponent(id)}/preview?tab=files`, { scroll: false });
  }, [id, router]);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent === true;
    if (!currentTenantId || !id) {
      setRepo(null);
      if (!silent) setLoading(false);
      return;
    }
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const res = await fetch(`/api/repositories/${encodeURIComponent(id)}`, { credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(typeof data.error === 'string' ? data.error : res.statusText);
      }
      const raw = data && typeof data === 'object' ? (data as { repository?: unknown }).repository : null;
      const parsed = dashboardRepositoryFromApi(raw);
      if (!parsed) {
        throw new Error('Invalid response from server');
      }
      setRepo(parsed);
      if (!silent) setError(null);
    } catch (e) {
      console.error(e);
      if (!silent) {
        setRepo(null);
        const msg = e instanceof Error ? e.message : 'Could not load repository';
        setError(msg);
        toast.error(msg);
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, [currentTenantId, id]);

  useEffect(() => {
    void load();
  }, [load]);

  const fetchImports = useCallback(async () => {
    if (!currentTenantId || !id) return;
    setImportsLoading(true);
    setImportsError(null);
    try {
      const res = await fetch(`/api/repositories/${encodeURIComponent(id)}/imports?limit=100`, {
        credentials: 'include',
      });
      const data = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        imports?: RepositoryImportMetricApiRow[];
        stats30d?: { totalImports: number; distinctProjects: number };
        error?: string;
      };
      if (!res.ok || data.success !== true) {
        throw new Error(typeof data.error === 'string' ? data.error : res.statusText);
      }
      setRepoImports(Array.isArray(data.imports) ? data.imports : []);
      setStats30d(data.stats30d ?? { totalImports: 0, distinctProjects: 0 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not load import history';
      setImportsError(msg);
      setRepoImports([]);
      setStats30d(null);
    } finally {
      setImportsLoading(false);
    }
  }, [currentTenantId, id]);

  useEffect(() => {
    if (!repo || !id) return;
    if (tab !== 'preview' && tab !== 'imports') return;
    void fetchImports();
  }, [repo, id, tab, fetchImports]);

  useEffect(() => {
    if (!repo || !id) return;
    const onFocus = () => {
      if (tab === 'preview' || tab === 'imports') void fetchImports();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [repo, id, tab, fetchImports]);

  const awaitingReady = repositoryStatusNeedsPolling(repo?.status);

  useEffect(() => {
    if (!currentTenantId || !id || !awaitingReady) return;
    const timer = window.setInterval(() => {
      void load({ silent: true });
    }, REPOSITORY_STATUS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [currentTenantId, id, awaitingReady, load]);

  const performRemoveRepository = async () => {
    if (!id) return;
    setRemoving(true);
    try {
      const res = await fetch(`/api/repositories/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(typeof data.error === 'string' ? data.error : res.statusText);
      }
      setRemoveDialogOpen(false);
      toast.success('Repository removed.');
      router.replace('/ade/dashboard/repositories');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not remove repository.');
    } finally {
      setRemoving(false);
    }
  };

  /**
   * Toggle this repository's auto-refresh opt-out (RAR-3.3). Optimistically flips
   * the local switch, PATCHes the repo, and reconciles to the server's returned
   * value — rolling back on error so the UI never lies about persisted state.
   */
  const performToggleAutoRefresh = async (next: boolean) => {
    if (!id || !repo || savingAutoRefresh) return;
    const previous = repo.auto_refresh_enabled ?? true;
    setSavingAutoRefresh(true);
    setRepo({ ...repo, auto_refresh_enabled: next });
    try {
      const res = await fetch(`/api/repositories/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auto_refresh_enabled: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(typeof data.error === 'string' ? data.error : res.statusText);
      }
      const parsed = dashboardRepositoryFromApi(
        data && typeof data === 'object' ? (data as { repository?: unknown }).repository : null,
      );
      if (parsed) setRepo(parsed);
      toast.success(next ? 'Auto-refresh enabled.' : 'Auto-refresh disabled.');
    } catch (e) {
      setRepo({ ...repo, auto_refresh_enabled: previous });
      toast.error(e instanceof Error ? e.message : 'Could not update auto-refresh.');
    } finally {
      setSavingAutoRefresh(false);
    }
  };

  const filesTotal = repo?.total_files ?? 0;
  const importable = repo?.importable_count ?? null;

  const importableMix = useMemo(() => {
    if (!repo || typeof repo.importable_count !== 'number') return null;
    return estimatedImportableMixForRepo(repo.importable_count, repo.id);
  }, [repo]);

  const recentScanRows = useMemo(() => repo?.recent_scans ?? [], [repo]);

  const webUrl = useMemo(() => {
    if (!repo?.clone_url) return null;
    const u = repo.clone_url.replace(/\.git$/i, '');
    if (repo.provider === 'github' && u.includes('github.com')) {
      return u;
    }
    return null;
  }, [repo]);

  const lastScanValue =
    repo?.last_scanned_at != null
      ? formatLastScan(repo.last_scanned_at, repo.status === 'error')
      : 'Never';

  const lastScanSubtitle =
    repo?.last_scanned_at != null
      ? repo.status === 'error'
        ? 'Last job reported an error; details will map from scan job records.'
        : 'From `last_scanned_at` on this repository row (full diff summaries require scan job API).'
      : '`last_scanned_at` is unset until the first completed indexing job writes it.';

  if (!currentTenantId) {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-gray-50 dark:bg-gray-900">
        <div className="flex-1 overflow-y-auto p-6">
          <div className="mx-auto max-w-3xl rounded-2xl border border-amber-200 bg-gradient-to-r from-amber-50 to-yellow-50 p-8 dark:border-amber-700/50 dark:from-amber-900/20 dark:to-yellow-900/20">
            <h2 className="mb-2 text-xl font-bold text-amber-900 dark:text-amber-100">No tenant selected</h2>
            <p className="mb-4 text-amber-800 dark:text-amber-200">Select a tenant to view repositories.</p>
            <Link href="/ade/dashboard/tenants" className={cn(buttonVariants())}>
              Go to Tenants
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-gray-50 dark:bg-gray-900">
      <div
        className={cn(
          'shrink-0 border-b border-gray-200 bg-white px-6 pb-0 pt-6 dark:border-gray-700 dark:bg-gray-800',
          (loading || error || !repo) && 'pb-6'
        )}
      >
        <div className="mb-4 flex flex-wrap items-start gap-3">
          <Link
            href="/ade/dashboard/repositories"
            className={cn(
              buttonVariants({ variant: 'ghost', size: 'sm' }),
              'shrink-0 gap-1 text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100'
            )}
          >
            ← Repositories
          </Link>
        </div>

        {loading ? (
          <LoadingState message="Loading repository…" />
        ) : error || !repo ? (
          <div className="rounded-xl border border-rose-200 bg-rose-50/80 p-6 dark:border-rose-800/50 dark:bg-rose-950/30">
            <h2 className="text-lg font-semibold text-rose-900 dark:text-rose-100">Repository unavailable</h2>
            <p className="mt-1 text-sm text-rose-800 dark:text-rose-200">{error ?? 'Not found'}</p>
            <Link href="/ade/dashboard/repositories" className={cn(buttonVariants({ size: 'sm' }), 'mt-4')}>
              Back to list
            </Link>
          </div>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-start gap-4">
              <span className="inline-flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500 to-teal-500 font-mono text-lg font-bold text-white">
                {repoInitials(repo.name)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="truncate text-2xl font-bold">{repo.name}</h1>
                  {/* REPO-6.5: health leads the header pills — "is it fine?" before "what
                      is it doing?" — and its tooltip names the most recent problem. */}
                  <RepositoryHealthBadge health={repo.health} />
                  {statusPill(repo.status)}
                  <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 font-mono text-2xs text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                    {repo.provider === 'github' ? (
                      <Github className="h-3 w-3 shrink-0" aria-hidden />
                    ) : (
                      <Globe className="h-3 w-3 shrink-0 text-indigo-500" aria-hidden />
                    )}
                    {providerSlug(repo)}
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 font-mono text-2xs text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-300">
                    <GitBranch className="h-3 w-3 shrink-0" aria-hidden />
                    {repo.default_branch}
                  </span>
                </div>
                <p className="mt-1.5 max-w-3xl text-sm text-gray-500 dark:text-gray-400">
                  {repo.description?.trim()
                    ? repo.description
                    : 'No description from the provider metadata on this registration.'}
                </p>
              </div>
              <div className="flex flex-shrink-0 flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  disabled={repo.status === 'scanning'}
                  title={repo.status === 'scanning' ? 'A scan is already in progress.' : undefined}
                  onClick={() => toast.message('Rescan runs when scan jobs are wired to the API.')}
                >
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                  Rescan
                </Button>
                <Select defaultValue={repo.default_branch}>
                  <SelectTrigger className="h-9 w-[140px] gap-1 border-gray-200 dark:border-gray-700">
                    <GitBranch className="h-3.5 w-3.5 shrink-0 text-gray-500" aria-hidden />
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={repo.default_branch}>{repo.default_branch}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 border-t border-gray-100 py-4 md:grid-cols-3 xl:grid-cols-5 dark:border-gray-700">
              <RepositoryKpiCard
                label="Files indexed"
                value={filesTotal.toLocaleString()}
                subtitle="From `total_files` after tree indexing; directory counts need scan metadata (not stored yet)."
                valuePending={repo.status === 'scanning'}
              />
              <RepositoryKpiCard
                label="IMPORTABLE ESTIMATE"
                value={importable != null ? importable.toLocaleString() : '—'}
                subtitle={
                  importable != null && importableMix
                    ? `Estimated mix from this repo’s total: OpenAPI ${importableMix.openapi.toLocaleString()}, Arazzo ${importableMix.arazzo.toLocaleString()}, JSON Schema ${importableMix.jsonSchema.toLocaleString()}. Split is a placeholder until indexed paths return real per-kind tallies.`
                    : '`importable_count` is null until detection runs and persists per-repo totals.'
                }
                valueClassName={
                  importable != null ? 'text-indigo-600 dark:text-indigo-400' : 'text-gray-400 dark:text-gray-500'
                }
                valuePending={repo.status === 'scanning'}
              />
              <RepositoryKpiCard
                label="Branches"
                value={repo.branch_count != null ? repo.branch_count.toLocaleString() : '—'}
                subtitle={
                  repo.provider === 'github'
                    ? '`branch_count` from GitHub at registration (paginated list-branches). Non-GitHub providers are not counted yet.'
                    : 'Branch totals are only filled for GitHub registrations today; other providers return no count.'
                }
                valueClassName={
                  repo.branch_count != null ? 'text-indigo-600 dark:text-indigo-400' : 'text-gray-400 dark:text-gray-500'
                }
                valuePending={repo.status === 'scanning'}
              />
              <RepositoryKpiCard
                label="Imports (30d)"
                value={
                  importsLoading && stats30d == null ? '—' : (stats30d?.totalImports ?? 0).toLocaleString()
                }
                subtitle={
                  importsLoading && stats30d == null
                    ? 'Loading import metrics…'
                    : stats30d != null && stats30d.totalImports > 0
                      ? `${stats30d.distinctProjects.toLocaleString()} distinct project(s) in the last 30 days.`
                      : 'Catalog imports from this repo’s Files tab in the last 30 days.'
                }
                valuePending={repo.status === 'scanning'}
              />
              <RepositoryKpiCard
                label="Last scan"
                value={lastScanValue}
                subtitle={lastScanSubtitle}
                valueClassName={
                  repo.last_scanned_at == null || repo.status === 'error'
                    ? 'text-gray-400 dark:text-gray-500'
                    : undefined
                }
                valuePending={repo.status === 'scanning'}
              />
            </div>

            {/* The header card's own bottom rule is this strip's tab underline, so the list carries
                only the separator above it (cf. TAB_LIST_CLASS, which supplies its own rule). */}
            <div
              role="tablist"
              aria-label="Repository sections"
              className="-mx-6 flex flex-wrap items-center gap-1 border-t border-gray-200 px-6 dark:border-gray-700"
            >
              <TabBtn active={tab === 'preview'} onClick={() => setTab('preview')}>
                Preview
              </TabBtn>
              <TabBtn active={tab === 'files'} onClick={() => setTab('files')} badge={filesTotal.toLocaleString()}>
                Files
              </TabBtn>
              <TabBtn active={tab === 'specs'} onClick={() => setTab('specs')}>
                Specs
              </TabBtn>
              <TabBtn active={tab === 'imports'} onClick={() => setTab('imports')}>
                Imports
              </TabBtn>
              <TabBtn active={tab === 'settings'} onClick={() => setTab('settings')}>
                Settings
              </TabBtn>
            </div>
          </>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-gray-50 dark:bg-gray-900">
      {!loading && repo && tab === 'preview' && (
        <div className="space-y-6 px-6 py-6">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Snapshot of this repository&apos;s registration, scan posture, and import activity. More detail appears here
            as scan jobs and import history are exposed through the API.
          </p>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3 lg:items-stretch">
            <div className="flex min-h-48 flex-col rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800 lg:col-span-2 lg:h-full lg:min-h-0">
              <div className="mb-3 flex shrink-0 items-center justify-between">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Recent scans</h3>
                <button
                  type="button"
                  className="text-2xs text-indigo-500 hover:text-indigo-600 dark:text-indigo-400 dark:hover:text-indigo-300"
                  onClick={() => toast.message('Scan history needs a `tenant_repository_scan_jobs` (or similar) collection exposed over REST.')}
                >
                  View scan history →
                </button>
              </div>
              {recentScanRows.length === 0 ? (
                <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-2 py-6">
                  <p className="m-0 text-center text-sm leading-normal text-gray-900 dark:text-gray-100">
                    No recent scans
                  </p>
                </div>
              ) : (
                <div className="min-h-0 flex-1 space-y-2">
                  {recentScanRows.map((row) => (
                    <div
                      key={`${row.branch}:${row.finished_at}`}
                      className="flex items-center justify-between border-b border-gray-100 pb-2 text-sm dark:border-gray-700"
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            'h-2 w-2 shrink-0 rounded-full',
                            row.failed ? 'bg-rose-500' : 'bg-emerald-500'
                          )}
                        />
                        <span>{row.branch}</span>
                        <span className="font-mono text-xs text-gray-500 dark:text-gray-400">—</span>
                      </div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        {formatLastScan(row.finished_at, row.failed)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex flex-col rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800 lg:h-full">
              <h3 className="mb-3 text-sm font-semibold text-gray-900 dark:text-gray-100">Importable mix</h3>
              <ul className="space-y-2 text-sm text-gray-700 dark:text-gray-200">
                <li className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-emerald-500" />
                    OpenAPI
                  </span>
                  <span className="font-mono text-xs font-semibold text-gray-700 dark:text-gray-200">
                    {importableMix != null ? importableMix.openapi.toLocaleString() : '—'}
                  </span>
                </li>
                <li className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-indigo-500" />
                    Arazzo
                  </span>
                  <span className="font-mono text-xs font-semibold text-gray-700 dark:text-gray-200">
                    {importableMix != null ? importableMix.arazzo.toLocaleString() : '—'}
                  </span>
                </li>
                <li className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-purple-500" />
                    JSON Schema
                  </span>
                  <span className="font-mono text-xs font-semibold text-gray-700 dark:text-gray-200">
                    {importableMix != null ? importableMix.jsonSchema.toLocaleString() : '—'}
                  </span>
                </li>
                <li className="flex items-center justify-between border-t border-gray-100 pt-2 dark:border-gray-700">
                  <span className="inline-flex items-center gap-2 font-medium text-gray-900 dark:text-gray-100">
                    <span className="h-2 w-2 rounded-full bg-indigo-500" />
                    Total importable (row)
                  </span>
                  <span className="font-mono text-xs font-semibold text-indigo-600 dark:text-indigo-400">
                    {importable != null ? importable.toLocaleString() : '—'}
                  </span>
                </li>
              </ul>
            </div>
          </div>

          <div className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Recent imports from this repo</h3>
              <button
                type="button"
                className="text-2xs text-indigo-500 hover:text-indigo-600 dark:text-indigo-400 dark:hover:text-indigo-300"
                onClick={() => setTab('imports')}
              >
                See all →
              </button>
            </div>
            <table className="w-full text-sm">
              <thead className="border-b border-gray-200 text-2xs uppercase tracking-wider text-gray-500 dark:border-gray-700 dark:text-gray-400">
                <tr>
                  <th className="py-2 align-middle text-left font-semibold">File</th>
                  <th className="py-2 align-middle text-left font-semibold">Project</th>
                  <th className="py-2 align-middle text-left font-semibold">Version</th>
                  <th className="py-2 align-middle text-left font-semibold">Imported by</th>
                  <th className="py-2 align-middle text-left font-semibold">When</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {importsError ? (
                  <tr>
                    <td colSpan={5} className="py-8 align-middle text-center text-sm text-rose-600 dark:text-rose-400">
                      {importsError}
                    </td>
                  </tr>
                ) : importsLoading && repoImports.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-10 align-middle text-center text-sm text-gray-500 dark:text-gray-400">
                      Loading imports…
                    </td>
                  </tr>
                ) : repoImports.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-10 align-middle text-center text-sm leading-relaxed text-gray-500 dark:text-gray-400">
                      No imports yet. Open the Files tab, select a spec, and complete a catalog import to record activity
                      here.
                    </td>
                  </tr>
                ) : (
                  repoImports.slice(0, 8).map((row) => {
                    const blob = shortBlobRef(row.blob_sha);
                    return (
                      <tr key={row.id}>
                        <td className="max-w-[200px] py-2 align-middle">
                          <Link
                            href={repositoryImportedFileHref(id, row.path, row.branch)}
                            className="break-all font-mono text-xs text-indigo-600 hover:underline dark:text-indigo-400"
                          >
                            {row.path}
                          </Link>
                          {blob ? (
                            <span className="mt-0.5 block text-2xs text-gray-500 dark:text-gray-400">
                              blob {blob} · {row.branch}
                            </span>
                          ) : (
                            <span className="mt-0.5 block text-2xs text-gray-500 dark:text-gray-400">
                              {row.branch}
                            </span>
                          )}
                        </td>
                        <td className="py-2 align-middle">
                          <Link
                            href={`/ade/dashboard/versions?projectId=${encodeURIComponent(row.project_id)}`}
                            className="text-indigo-600 hover:underline dark:text-indigo-400"
                          >
                            {row.project_name}
                          </Link>
                        </td>
                        <td className="py-2 align-middle font-mono text-xs text-gray-800 dark:text-gray-200">
                          {row.catalog_version_label}
                        </td>
                        <td className="py-2 align-middle text-gray-700 dark:text-gray-300">
                          {formatImportedByActor(row)}
                        </td>
                        <td className="whitespace-nowrap py-2 align-middle text-gray-600 dark:text-gray-400">
                          {formatRelativeWhen(row.created_at)}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!loading && repo && tab === 'files' && (
        <div className="px-6 py-6">
          <RepositoryFilesBrowser
            repositoryId={id}
            defaultBranch={repo.default_branch}
            repositoryName={repo.name}
            repositoryFullName={repo.full_name}
            githubWebBase={webUrl}
            filesDeepLink={filesDeepLink}
            onFilesDeepLinkConsumed={consumeFilesDeepLink}
          />
        </div>
      )}

      {!loading && repo && tab === 'specs' && (
        <div className="space-y-4 px-6 py-6">
          <RepositorySpecsTab repositoryId={id} />
        </div>
      )}

      {!loading && repo && tab === 'imports' && (
        <div className="space-y-4 px-6 py-6">
          <div className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 px-4 py-3 dark:border-gray-700">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Import history</h3>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Successful catalog imports from this repository&apos;s files.
              </p>
            </div>
            <table className="w-full text-sm">
              <thead className="border-b border-gray-200 bg-gray-50 text-2xs uppercase tracking-wider text-gray-500 dark:border-gray-700 dark:bg-gray-900/30 dark:text-gray-400">
                <tr>
                  <th className="px-4 py-2 align-middle text-left font-semibold">When</th>
                  <th className="px-4 py-2 align-middle text-left font-semibold">File · blob</th>
                  <th className="px-4 py-2 align-middle text-left font-semibold">Project · version</th>
                  <th className="px-4 py-2 align-middle text-left font-semibold">Outcome</th>
                  <th className="px-4 py-2 align-middle text-left font-semibold">By</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {importsError ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-12 align-middle text-center text-sm text-rose-600 dark:text-rose-400">
                      {importsError}
                    </td>
                  </tr>
                ) : importsLoading && repoImports.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-12 align-middle text-center text-sm text-gray-500 dark:text-gray-400">
                      Loading imports…
                    </td>
                  </tr>
                ) : repoImports.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-12 align-middle text-center text-sm leading-relaxed text-gray-500 dark:text-gray-400">
                      No imports recorded yet. Use the Files tab to open a specification and run an import.
                    </td>
                  </tr>
                ) : (
                  repoImports.map((row) => {
                    const blob = shortBlobRef(row.blob_sha);
                    return (
                      <tr key={row.id} className="hover:bg-gray-50/80 dark:hover:bg-gray-900/40">
                        <td className="whitespace-nowrap px-4 py-2 align-middle text-gray-600 dark:text-gray-400">
                          {formatRelativeWhen(row.created_at)}
                        </td>
                        <td className="max-w-[240px] px-4 py-2 align-middle">
                          <Link
                            href={repositoryImportedFileHref(id, row.path, row.branch)}
                            className="break-all font-mono text-xs text-indigo-600 hover:underline dark:text-indigo-400"
                          >
                            {row.path}
                          </Link>
                          <div className="mt-0.5 text-2xs text-gray-500 dark:text-gray-400">
                            {blob ? `blob ${blob} · ${row.branch}` : row.branch}
                          </div>
                        </td>
                        <td className="px-4 py-2 align-middle">
                          <Link
                            href={`/ade/dashboard/versions?projectId=${encodeURIComponent(row.project_id)}`}
                            className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                          >
                            {row.project_name}
                          </Link>
                          <div className="mt-0.5 font-mono text-xs text-gray-600 dark:text-gray-400">
                            v{row.catalog_version_label}
                          </div>
                        </td>
                        <td className="px-4 py-2 align-middle text-gray-700 dark:text-gray-300">Completed</td>
                        <td className="px-4 py-2 align-middle text-gray-700 dark:text-gray-300">{formatImportedByActor(row)}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!loading && repo && tab === 'settings' && (
        <div className="max-w-3xl space-y-4 px-6 py-6">
          <div className="space-y-4 rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
            <h3 className="border-b border-gray-100 pb-2 text-sm font-semibold dark:border-gray-700 dark:text-gray-100">Source</h3>
            <div className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
              <div>
                <label className="text-2xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  Provider
                </label>
                <p className="mt-1 inline-flex items-center gap-2 text-gray-900 dark:text-gray-100">
                  {repo.provider === 'github' ? <Github className="h-4 w-4" aria-hidden /> : <Globe className="h-4 w-4 text-indigo-500" />}
                  <span className="capitalize">{repo.provider.replace('_', ' ')}</span>
                  {repo.source === 'linked_account' ? (
                    <span className="text-xs text-gray-500 dark:text-gray-400">(linked account)</span>
                  ) : repo.source === 'public_url' ? (
                    <span className="text-xs text-gray-500 dark:text-gray-400">(public URL)</span>
                  ) : null}
                </p>
              </div>
              <div>
                <label className="text-2xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Clone URL</label>
                <p className="mt-1 break-all font-mono text-xs text-gray-900 dark:text-gray-100">{repo.clone_url ?? '—'}</p>
                {webUrl ? (
                  <a
                    href={webUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 inline-block text-xs text-indigo-500 hover:text-indigo-600 dark:text-indigo-400"
                  >
                    Open in browser →
                  </a>
                ) : null}
              </div>
              <div>
                <label className="text-2xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  Default branch
                </label>
                <Input readOnly value={repo.default_branch} className="mt-1 font-mono text-sm" />
              </div>
              <div>
                <label className="text-2xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                  Subpath glob (optional)
                </label>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  Not stored on <span className="font-mono">tenant_repositories</span> yet; future column or child table to
                  limit scan roots.
                </p>
                <Input disabled placeholder="e.g. specs/**" className="mt-2 font-mono text-sm" />
              </div>
            </div>
          </div>

          <div className="space-y-4 rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
            <h3 className="border-b border-gray-100 pb-2 text-sm font-semibold dark:border-gray-700 dark:text-gray-100">Scan cadence</h3>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="space-y-1">
                <label
                  htmlFor="auto-refresh-toggle"
                  className="text-2xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400"
                >
                  Auto-refresh
                </label>
                <p className="max-w-md text-xs text-gray-500 dark:text-gray-400">
                  When on, this repository is rescanned on its cadence and changed files are re-imported automatically.
                  Turn it off to pause auto-refresh for this repo. Manual “Refresh now” is unaffected.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Switch
                  id="auto-refresh-toggle"
                  checked={repo.auto_refresh_enabled ?? true}
                  disabled={savingAutoRefresh}
                  onCheckedChange={(next) => void performToggleAutoRefresh(next)}
                  aria-label="Toggle auto-refresh for this repository"
                />
                <span className="text-xs font-medium text-gray-600 dark:text-gray-300">
                  {(repo.auto_refresh_enabled ?? true) ? 'Enabled' : 'Disabled'}
                </span>
              </div>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Scheduling + webhook secrets are product decisions: poll interval vs GitHub/GitLab push hooks. Persist on a
              repo settings extension once requirements settle.
            </p>
            <fieldset disabled className="grid grid-cols-1 gap-4 text-sm opacity-70 sm:grid-cols-2">
              <div>
                <label className="text-2xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Schedule</label>
                <select className="mt-1 w-full rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-900/50 dark:text-gray-100">
                  <option>Not configured</option>
                </select>
              </div>
              <div>
                <label className="text-2xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">Webhook</label>
                <p className="mt-2 inline-flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                  <span className="h-2 w-2 rounded-full bg-gray-300 dark:bg-gray-600" />
                  Inactive — delivery logs will mirror webhook worker tables when added.
                </p>
              </div>
            </fieldset>
          </div>

          {/* RAR-4.5 (#3531): what a refresh does when it meets a hand-edited version. */}
          <RepositoryConflictPolicy repositoryId={repo.id} defaultBranch={repo.default_branch} />

          <div className="space-y-4 rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
            <h3 className="border-b border-gray-100 pb-2 text-sm font-semibold dark:border-gray-700 dark:text-gray-100">
              Default importer mappings
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Maps glob → detected kind → default project/version hints for the import wizard. Requires persistence (likely
              JSON on repo settings or normalized mapping rows).
            </p>
            <table className="w-full text-sm">
              <thead className="border-b border-gray-200 text-2xs uppercase tracking-wider text-gray-500 dark:border-gray-700 dark:text-gray-400">
                <tr>
                  <th className="py-2 text-left font-semibold">Path glob</th>
                  <th className="text-left font-semibold">Detected kind</th>
                  <th className="text-left font-semibold">Default project</th>
                  <th className="text-right font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td colSpan={4} className="py-10 text-center text-sm text-gray-500 dark:text-gray-400">
                    No mappings saved for this repository yet.
                  </td>
                </tr>
              </tbody>
            </table>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5 text-xs"
              disabled
            >
              <Plus className="h-3 w-3" aria-hidden />
              Add mapping
            </Button>
          </div>

          <div className="space-y-3 rounded-xl border border-rose-200 bg-rose-50 p-5 dark:border-rose-800 dark:bg-rose-900/20">
            <h3 className="text-sm font-semibold text-rose-800 dark:text-rose-200">Danger zone</h3>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-rose-700 dark:text-rose-300">
                Removes this repository from the tenant list (soft-delete). You can register the same clone URL again
                later if needed.
              </p>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                className="shrink-0 text-xs"
                disabled={removing}
                onClick={() => setRemoveDialogOpen(true)}
              >
                Remove repository
              </Button>
            </div>
          </div>
        </div>
      )}
      </div>

      <AlertDialog
        open={removeDialogOpen}
        onOpenChange={(open) => {
          if (removing && !open) return;
          setRemoveDialogOpen(open);
        }}
      >
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove repository?</AlertDialogTitle>
            <AlertDialogDescription>
              {`Remove "${repo?.name ?? 'this repository'}" from this workspace? You can add it again later from Repositories → Add repository.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>Cancel</AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              disabled={removing}
              onClick={() => void performRemoveRepository()}
            >
              {removing ? 'Removing…' : 'Remove repository'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
