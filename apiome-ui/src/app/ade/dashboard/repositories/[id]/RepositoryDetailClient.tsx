'use client';

import { useAuthSession } from '@lib/auth/session-client';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Eye, Files, History, RefreshCw, Settings2 } from 'lucide-react';
import { toast } from 'sonner';

import PageHeader from '@/app/components/shell/PageHeader';
import { Page, PageBody } from '@/app/components/shell/pageChrome';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/app/components/ui/AlertDialog';
import { Avatar } from '@/app/components/ui/Avatar';
import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import { Card, CardHeader } from '@/app/components/ui/Card';
import { GatedState } from '@/app/components/ui/EmptyState';
import { ErrorState } from '@/app/components/ui/ErrorState';
import { LoadingState } from '@/app/components/ui/LoadingState';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/app/components/ui/Select';
import { TAB_COUNT_CLASS, TAB_LIST_CLASS, tabTriggerClass } from '@/app/components/ui/tabStyles';
import {
  REPOSITORY_STATUS_POLL_MS,
  dashboardRepositoryFromApi,
  estimatedImportableMixForRepo,
  formatLastScan,
  repositoryStatusNeedsPolling,
  type DashboardRepository,
} from '@/app/components/ade/dashboard/repositories/repositoryStoreUi';
import { RepositoryConflictPolicy } from '@/app/components/ade/dashboard/repositories/RepositoryConflictPolicy';
import { RepositoryHealthBadge } from '@/app/components/ade/dashboard/repositories/RepositoryHealthBadge';
import { RepositoryFilesBrowser } from '@/app/components/ade/dashboard/repositories/RepositoryFilesBrowser';
import { RepositorySpecsTab } from '@/app/components/ade/dashboard/repositories/RepositorySpecsTab';
import {
  DASHBOARD_HREF,
  REPOSITORIES_LIST_HREF,
  REPOSITORY_DETAIL_TABS,
  REPOSITORY_DETAIL_TAB_LABEL,
  REPOSITORY_LOADING,
  REPOSITORY_NO_TENANT,
  REPOSITORY_STATUS_LABEL,
  REPOSITORY_UNAVAILABLE,
  RESCAN_IN_PROGRESS_TITLE,
  RESCAN_STUB_TOAST,
  RepositoryDetailKpiStrip,
  RepositoryImportsTable,
  RepositoryPreviewTab,
  RepositorySettingsTab,
  SCAN_HISTORY_STUB_TOAST,
  removeRepositoryPrompt,
  repositoryDescriptionLine,
  repositoryDetailTabFromParams,
  repositoryDetailTabHref,
  repositoryProviderSlug,
  repositoryWebUrl,
  readRepositoryFileDeepLink,
  type RepositoryDetailTab,
  type RepositoryImportRow,
} from '@/app/components/ade/repositories';

/** The glyph each tab leads with, matching the mockup's tab row. */
const TAB_ICON: Readonly<Record<RepositoryDetailTab, typeof Eye>> = {
  preview: Eye,
  files: Files,
  specs: RefreshCw,
  imports: History,
  settings: Settings2,
};

/**
 * Bring in → Repositories → one repository (HIVE-7.5, #5322).
 *
 * Authority: `docs/mockups/sources/repository-detail.html`, whose **Notes → Keeps (1:1)** list
 * is this ticket's acceptance criteria; DESIGN.md §5.3 (page header), §8 (detail page: header →
 * stat strip → tabs) and §3.1 (status vocabulary).
 *
 * ### What this screen is
 *
 * One registered repository, the tree the scanner indexed from it, and everything the workspace
 * has brought *in* from that tree. Five sections: what it is (Preview), what is in it (Files),
 * what has been imported and whether those imports are current (Specs), what was imported and
 * by whom (Imports), and how it behaves (Settings).
 *
 * ### What it owns, and what it no longer does
 *
 * It owns the repository read, the status poll, the two writes (auto-refresh, remove), which
 * tab is showing and which branch the Files tab is on. It owns none of the rules: which tab a
 * URL names, what the KPI figures and their footnotes are, what a stub says, what the remove
 * confirm reads — all of that is `repositoryDetailModel`, where it is tested without rendering
 * a screen. The 1,094-line client this replaces had every one of them inline, and drew the
 * imports table twice in two different spellings.
 *
 * ### Four things this fixes rather than restyles
 *
 * 1. **Two branch controls could disagree.** The header carried a `Select` with exactly one
 *    option and no handler; the Files tab carried a popover that actually switched branches.
 *    Both are the same state now, so the header always names the branch the table is showing —
 *    and the header's control does something, which is what "visually honest" asks of it.
 * 2. **A failed read looked like a missing repository.** The screen rendered a hand-rolled
 *    rose panel with the raw message and no way to retry. It is an `ErrorState` with a retry
 *    and a way back to the list.
 * 3. **The tab strip lost its selection on reload.** `?tab=` was read into state but never
 *    written back, so a reader who opened Settings and refreshed landed on Preview. Selecting
 *    a tab now replaces the URL, which is also what makes a tab linkable.
 * 4. **The KPI figures were `text-indigo-600` when known and `text-gray-400` when not.** A
 *    figure's *colour* was the only signal that it was a placeholder, which DESIGN.md §6
 *    forbids. Each stat now carries `data-unwired` and a footnote that says so in words.
 *
 * ### The poll
 *
 * A repository that is `pending` or `scanning` is still changing, so the record re-reads every
 * two seconds while it is — silently, so the header does not flash a skeleton at a reader every
 * two seconds. Unchanged from what it replaces, including the constant.
 */
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
  const [tab, setTab] = useState<RepositoryDetailTab>('preview');
  const [removing, setRemoving] = useState(false);
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
  const [savingAutoRefresh, setSavingAutoRefresh] = useState(false);
  const [repoImports, setRepoImports] = useState<RepositoryImportRow[]>([]);
  const [importsLoading, setImportsLoading] = useState(false);
  const [importsError, setImportsError] = useState<string | null>(null);
  const [stats30d, setStats30d] = useState<
    { totalImports: number; distinctProjects: number } | null
  >(null);

  // The branch the Files tab is reading, lifted here so the header's control and the tab's own
  // popover are one state rather than two that can disagree. `branches` is what the last files
  // read discovered; before that read there is only the registration's default.
  const [branch, setBranch] = useState('');
  const [branches, setBranches] = useState<string[]>([]);

  const filesDeepLink = useMemo(
    () => readRepositoryFileDeepLink(new URLSearchParams(searchParams.toString())),
    [searchParams]
  );

  useEffect(() => {
    setTab(repositoryDetailTabFromParams(new URLSearchParams(searchParams.toString())));
  }, [searchParams]);

  /** Select a tab, and record it in the URL so a reload and a shared link both land on it. */
  const selectTab = useCallback(
    (next: RepositoryDetailTab) => {
      setTab(next);
      if (!id) return;
      router.replace(repositoryDetailTabHref(id, next), { scroll: false });
    },
    [id, router]
  );

  const consumeFilesDeepLink = useCallback(() => {
    if (!id) return;
    router.replace(repositoryDetailTabHref(id, 'files'), { scroll: false });
  }, [id, router]);

  const load = useCallback(
    async (opts?: { silent?: boolean }) => {
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
        const res = await fetch(`/api/repositories/${encodeURIComponent(id)}`, {
          credentials: 'include',
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(typeof data.error === 'string' ? data.error : res.statusText);
        }
        const raw =
          data && typeof data === 'object' ? (data as { repository?: unknown }).repository : null;
        const parsed = dashboardRepositoryFromApi(raw);
        if (!parsed) throw new Error('Invalid response from server');
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
    },
    [currentTenantId, id]
  );

  useEffect(() => {
    void load();
  }, [load]);

  // The branch state follows the registration's default until the reader picks another.
  useEffect(() => {
    const fallback = repo?.default_branch;
    if (!fallback) return;
    setBranch((prev) => prev || fallback);
    setBranches((prev) => (prev.length > 0 ? prev : [fallback]));
  }, [repo?.default_branch]);

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
        imports?: RepositoryImportRow[];
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
      router.replace(REPOSITORIES_LIST_HREF);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not remove repository.');
    } finally {
      setRemoving(false);
    }
  };

  /**
   * Toggle this repository's auto-refresh opt-out (RAR-3.3). Optimistically flips the local
   * switch, PATCHes the repo, and reconciles to the server's returned value — rolling back on
   * error so the UI never lies about persisted state.
   *
   * @param next The state the reader asked for.
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
        data && typeof data === 'object' ? (data as { repository?: unknown }).repository : null
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

  const importableMix = useMemo(() => {
    if (!repo || typeof repo.importable_count !== 'number') return null;
    return estimatedImportableMixForRepo(repo.importable_count, repo.id);
  }, [repo]);

  const webUrl = useMemo(() => repositoryWebUrl(repo), [repo]);

  if (!currentTenantId) {
    return (
      <Page>
        <PageBody>
          <GatedState className="mx-auto max-w-3xl" description={REPOSITORY_NO_TENANT} />
        </PageBody>
      </Page>
    );
  }

  if (loading) {
    return (
      <Page>
        <PageBody>
          <LoadingState className="min-h-[40vh]" message={REPOSITORY_LOADING} />
        </PageBody>
      </Page>
    );
  }

  if (error || !repo) {
    return (
      <Page>
        <PageBody>
          <ErrorState
            className="mx-auto max-w-3xl"
            title={REPOSITORY_UNAVAILABLE}
            description={error ?? 'This repository is not registered to the current workspace.'}
            onRetry={() => void load()}
            action={
              <Link href={REPOSITORIES_LIST_HREF} className="repo-det-link">
                Back to list
              </Link>
            }
          />
        </PageBody>
      </Page>
    );
  }

  const filesTotal = repo.total_files ?? 0;
  const lastScanLabel =
    repo.last_scanned_at != null
      ? formatLastScan(repo.last_scanned_at, repo.status === 'error')
      : 'Never';
  const scanning = repo.status === 'scanning';
  const activeBranch = branch || repo.default_branch;
  const branchOptions = branches.length > 0 ? branches : [repo.default_branch];

  const tabs = (
    <div role="tablist" aria-label="Repository sections" className={TAB_LIST_CLASS}>
      {REPOSITORY_DETAIL_TABS.map((name) => {
        const Icon = TAB_ICON[name];
        return (
          <button
            key={name}
            type="button"
            role="tab"
            id={`repository-tab-${name}`}
            aria-selected={tab === name}
            aria-controls={`repository-panel-${name}`}
            data-testid={`repository-tab-${name}`}
            className={tabTriggerClass({ active: tab === name })}
            onClick={() => selectTab(name)}
          >
            <Icon className="repo-tab__glyph" aria-hidden />
            {REPOSITORY_DETAIL_TAB_LABEL[name]}
            {name === 'files' ? (
              <span className={TAB_COUNT_CLASS}>{filesTotal.toLocaleString()}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );

  return (
    <Page>
      <PageHeader
        breadcrumb={[
          { label: 'Home', href: DASHBOARD_HREF },
          { label: 'Repositories', href: REPOSITORIES_LIST_HREF },
          { label: repo.name },
        ]}
        leading={
          <Avatar size="xl" shape="hex" name={repo.name} seed={repo.id} className="mt-6" />
        }
        title={repo.name}
        truncateTitle
        badge={
          <>
            {/* REPO-6.5: health leads the header pills — "is it fine?" before "what is it
                doing?" — and its tooltip names the most recent problem. */}
            <RepositoryHealthBadge health={repo.health} />
            <Badge status={repo.status}>{REPOSITORY_STATUS_LABEL[repo.status]}</Badge>
          </>
        }
        description={repositoryDescriptionLine(repo)}
        meta={
          <div className="repo-det-chips">
            <Badge
              variant="outline"
              mono
              data-provider={repo.provider}
              className="repo-provider"
              data-testid="repository-provider-slug"
            >
              {repositoryProviderSlug(repo)}
            </Badge>
            <Badge variant="outline" mono data-testid="repository-default-branch-chip">
              {repo.default_branch}
            </Badge>
          </div>
        }
        actions={
          <>
            <Select
              value={activeBranch}
              onValueChange={(next) => {
                setBranch(next);
                selectTab('files');
              }}
            >
              <SelectTrigger
                aria-label="Branch"
                className="w-[10rem]"
                data-testid="repository-header-branch"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {branchOptions.map((b) => (
                  <SelectItem key={b} value={b}>
                    {b}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              disabled={scanning}
              title={scanning ? RESCAN_IN_PROGRESS_TITLE : undefined}
              onClick={() => toast.message(RESCAN_STUB_TOAST)}
              data-testid="repository-rescan"
            >
              <RefreshCw aria-hidden />
              Rescan
            </Button>
          </>
        }
        tabs={tabs}
      />

      <PageBody>
        <RepositoryDetailKpiStrip
          repository={repo}
          stats30d={stats30d}
          importsLoading={importsLoading}
          importableMix={importableMix}
          lastScanLabel={lastScanLabel}
        />

        <div
          role="tabpanel"
          id={`repository-panel-${tab}`}
          aria-labelledby={`repository-tab-${tab}`}
          tabIndex={-1}
          className="focus-visible:outline-none"
        >
          {tab === 'preview' ? (
            <RepositoryPreviewTab
              repositoryId={id}
              scans={repo.recent_scans ?? []}
              mix={importableMix}
              importableTotal={repo.importable_count ?? null}
              imports={repoImports}
              importsLoading={importsLoading}
              importsError={importsError}
              formatScanTime={formatLastScan}
              onViewScanHistory={() => toast.message(SCAN_HISTORY_STUB_TOAST)}
              onSeeAllImports={() => selectTab('imports')}
            />
          ) : null}

          {tab === 'files' ? (
            <RepositoryFilesBrowser
              repositoryId={id}
              defaultBranch={repo.default_branch}
              repositoryName={repo.name}
              repositoryFullName={repo.full_name}
              githubWebBase={webUrl}
              branch={activeBranch}
              branches={branchOptions}
              onBranchChange={setBranch}
              onBranchesDiscovered={setBranches}
              filesDeepLink={filesDeepLink}
              onFilesDeepLinkConsumed={consumeFilesDeepLink}
            />
          ) : null}

          {tab === 'specs' ? <RepositorySpecsTab repositoryId={id} /> : null}

          {tab === 'imports' ? (
            <Card className="overflow-hidden" data-testid="repository-imports-tab">
              <CardHeader>
                <h2 className="repo-det-card__title">
                  <History aria-hidden />
                  Import history
                </h2>
                <p className="repo-det-note">
                  Successful catalog imports from this repository’s files.
                </p>
              </CardHeader>
              <RepositoryImportsTable
                repositoryId={id}
                rows={repoImports}
                loading={importsLoading}
                error={importsError}
                emptyCopy="history"
              />
              <div className="repo-det-table__foot">
                <span>
                  {repoImports.length.toLocaleString()} import
                  {repoImports.length === 1 ? '' : 's'}
                </span>
              </div>
            </Card>
          ) : null}

          {tab === 'settings' ? (
            <RepositorySettingsTab
              repository={repo}
              webUrl={webUrl}
              savingAutoRefresh={savingAutoRefresh}
              onToggleAutoRefresh={(next) => void performToggleAutoRefresh(next)}
              onRemove={() => setRemoveDialogOpen(true)}
              removing={removing}
              conflictPolicy={
                /* RAR-4.5 (#3531): what a refresh does when it meets a hand-edited version. */
                <RepositoryConflictPolicy
                  repositoryId={repo.id}
                  defaultBranch={repo.default_branch}
                />
              }
            />
          ) : null}
        </div>
      </PageBody>

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
            <AlertDialogDescription>{removeRepositoryPrompt(repo.name)}</AlertDialogDescription>
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
    </Page>
  );
}
