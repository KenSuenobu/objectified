'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { LayoutGrid, List, Plus, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

import { useAuthSession } from '@lib/auth/session-client';
import type { ShortcutBinding } from '@lib/shortcuts';

import PageHeader from '@/app/components/shell/PageHeader';
import { Page, PageBody } from '@/app/components/shell/pageChrome';
import { useShortcuts } from '@/app/hooks/useShortcuts';
import { Button } from '@/app/components/ui/Button';
import { Card } from '@/app/components/ui/Card';
import {
  DataTableSearch,
  DataTableToolbar,
  DataTableToolbarSpacer,
} from '@/app/components/ui/DataTable';
import { EmptyState, GatedState } from '@/app/components/ui/EmptyState';
import { Segmented, SegmentedItem } from '@/app/components/ui/Segmented';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/app/components/ui/Select';
import {
  REPOSITORY_STATUS_POLL_MS,
  dashboardRepositoriesFromListPayload,
  repositoryStatusNeedsPolling,
} from '@/app/components/ade/dashboard/repositories/repositoryStoreUi';
import {
  ADD_REPOSITORY_HREF,
  DEFAULT_REPOSITORY_SORT,
  EMPTY_REPOSITORY_FILTERS,
  REPOSITORIES_LOAD_ERROR,
  REPOSITORY_FILTER_ANY,
  REPOSITORY_PROVIDER_OPTIONS,
  REPOSITORY_SORT_OPTIONS,
  REPOSITORY_VISIBILITY_OPTIONS,
  RESCAN_ALL_TOAST,
  RESCAN_TOAST,
  RepositoriesSubNav,
  RepositoryCard,
  RepositoryKpiStrip,
  RepositoryRefreshActivityPanel,
  RepositoryTable,
  isRepositoryListNarrowed,
  isRepositorySortKey,
  matchesRepositoryFilters,
  repositoriesSummaryLine,
  repositoryDetailHref,
  searchRepositories,
  sortRepositories,
  type DashboardRepository,
  type RepositoryFilterState,
  type RepositoryFilterOption,
  type RepositorySortKey,
} from '@/app/components/ade/repositories';

/** Which view was last chosen. The key the screen this replaces used, kept 1:1. */
const VIEW_STORAGE = 'apiome-dashboard-repositories-view';

/** Where the breadcrumb's first crumb goes. */
const HOME_ROUTE = '/ade/dashboard';

/** The two ways the list can be drawn. */
type RepositoriesView = 'grid' | 'list';

/**
 * Bring in → Repositories (HIVE-7.3, #5320).
 *
 * Authority: `docs/mockups/sources/repositories.html`, whose **Notes → Keeps (1:1)** list is
 * this ticket's acceptance criteria; DESIGN.md §5.3 (page header), §8 (list page: header →
 * stat strip → toolbar → table) and §3.1 (status vocabulary).
 *
 * ### What this screen is
 *
 * Every Git repository registered to the workspace, and the state of the scanner that indexes
 * them. It is a *bring-in* surface: nothing here is authored, everything arrives from a
 * provider, and the one write the screen performs is removing a registration.
 *
 * ### What it owns, and what it no longer does
 *
 * It owns the list, the poll, the one write, which view is drawing and which overlay is open.
 * It owns none of the rules: which rows a filter leaves, what the KPI figures are, what the
 * status pill is called, what the remove confirm says — all of that is `repositoriesModel`,
 * where it is tested without rendering a screen. The 598-line `page.tsx` this replaces had
 * every one of them inline.
 *
 * ### Five things this fixes rather than restyles
 *
 * 1. **The header carried five buttons.** Four of them were navigation to sibling screens; at
 *    the Largest font scale they pushed "Add repository" onto a second line. They are the
 *    sub-nav tab row now, and the header has one primary action.
 * 2. **A failed read looked like an empty workspace.** The screen logged to the console and
 *    rendered "No repositories yet". The read's failure is now the table's error state, with a
 *    retry.
 * 3. **The card and the table offered different verbs.** One {@link RepositoryRowMenu} now.
 * 4. **The card was a stretched link over `pointer-events: none` content.** It is an
 *    `<article>` with one real link, which is what removes the `nested-interactive` finding.
 * 5. **Rescan was only reachable in bulk.** "Rescan all" was in the header and there was no
 *    per-repository rescan at all, although the mockup's row menu has always drawn one. Both
 *    are stubs until scan jobs are wired, and both now say so in the same words.
 *
 * ### The poll
 *
 * A repository that is `pending` or `scanning` is still changing, so the list re-reads every
 * two seconds while at least one is — silently, so the table does not flash its skeleton at a
 * reader every two seconds. Unchanged from what it replaces, including the constant.
 */
export default function RepositoriesClient() {
  const router = useRouter();
  const { data: session } = useAuthSession();
  const currentTenantId = (session?.user as { current_tenant_id?: string } | undefined)
    ?.current_tenant_id;

  // ---- the list ---------------------------------------------------------------------------

  const [repositories, setRepositories] = React.useState<DashboardRepository[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const [query, setQuery] = React.useState('');
  const [filters, setFilters] = React.useState<RepositoryFilterState>(EMPTY_REPOSITORY_FILTERS);
  const [sort, setSort] = React.useState<RepositorySortKey>(DEFAULT_REPOSITORY_SORT);
  const [view, setView] = React.useState<RepositoriesView>(() => {
    if (typeof window === 'undefined') return 'grid';
    try {
      return window.localStorage.getItem(VIEW_STORAGE) === 'list' ? 'list' : 'grid';
    } catch {
      return 'grid';
    }
  });

  const searchRef = React.useRef<HTMLInputElement | null>(null);

  const persistView = React.useCallback((next: RepositoriesView) => {
    setView(next);
    try {
      window.localStorage.setItem(VIEW_STORAGE, next);
    } catch {
      /* A browser that refuses storage still gets the view it just asked for. */
    }
  }, []);

  /**
   * Read the list.
   *
   * @param options `silent` for a poll — it must not raise the skeleton or clear the rows,
   *   because the reader is looking at them.
   */
  const loadRepositories = React.useCallback(
    async (options?: { silent?: boolean }) => {
      const silent = options?.silent === true;
      if (!currentTenantId) {
        setRepositories([]);
        setLoading(false);
        return;
      }
      if (!silent) setLoading(true);
      try {
        const response = await fetch('/api/repositories', { credentials: 'include' });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(typeof data.error === 'string' ? data.error : response.statusText);
        }
        setRepositories(dashboardRepositoriesFromListPayload(data));
        setLoadError(null);
      } catch (caught) {
        // A read that failed and a workspace with no repositories used to look identical here.
        if (!silent) {
          setRepositories([]);
          setLoadError(caught instanceof Error ? caught.message : REPOSITORIES_LOAD_ERROR);
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [currentTenantId]
  );

  React.useEffect(() => {
    void loadRepositories();
  }, [loadRepositories]);

  const polling = React.useMemo(
    () => repositories.some((repository) => repositoryStatusNeedsPolling(repository.status)),
    [repositories]
  );

  React.useEffect(() => {
    if (!currentTenantId || !polling) return;
    const timer = window.setInterval(() => {
      void loadRepositories({ silent: true });
    }, REPOSITORY_STATUS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [currentTenantId, polling, loadRepositories]);

  // ---- narrowing ---------------------------------------------------------------------------

  const visible = React.useMemo(
    () =>
      sortRepositories(
        searchRepositories(repositories, query).filter((repository) =>
          matchesRepositoryFilters(repository, filters)
        ),
        sort
      ),
    [filters, query, repositories, sort]
  );

  const narrowed = isRepositoryListNarrowed(query, filters);

  const clearFilters = React.useCallback(() => {
    setQuery('');
    setFilters(EMPTY_REPOSITORY_FILTERS);
  }, []);

  // ---- verbs -------------------------------------------------------------------------------

  const openDetail = React.useCallback(
    (repository: DashboardRepository) => router.push(repositoryDetailHref(repository.id)),
    [router]
  );

  /**
   * Rescan one repository.
   *
   * A stub, and honest about it: there is no scan-job endpoint to call. Kept as a verb rather
   * than removed because the row menu is where a reader looks for it, and a menu that silently
   * lacks the action reads as "this repository cannot be rescanned".
   */
  const rescan = React.useCallback(() => toast.message(RESCAN_TOAST), []);

  /** The same stub for the whole workspace, with the copy the header button already used. */
  const rescanAll = React.useCallback(() => toast.message(RESCAN_ALL_TOAST), []);

  /**
   * Remove a registration.
   *
   * The confirm has already been answered by {@link RepositoryRowMenu}; this is only the write
   * and the reload. `DELETE /api/repositories/{id}` returns an error envelope rather than
   * throwing, so a refusal is reported as its own sentence.
   */
  const removeRepository = React.useCallback(
    async (repository: DashboardRepository) => {
      setBusy(true);
      try {
        const response = await fetch(`/api/repositories/${encodeURIComponent(repository.id)}`, {
          method: 'DELETE',
          credentials: 'include',
        });
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok) {
          throw new Error(typeof data.error === 'string' ? data.error : response.statusText);
        }
        toast.success('Repository removed.');
        await loadRepositories();
      } catch (caught) {
        toast.error(caught instanceof Error ? caught.message : 'Could not remove repository.');
      } finally {
        setBusy(false);
      }
    },
    [loadRepositories]
  );

  const handlers = React.useMemo(
    () => ({
      onOpenDetail: openDetail,
      onRescan: rescan,
      onRemove: (repository: DashboardRepository) => void removeRepository(repository),
    }),
    [openDetail, removeRepository, rescan]
  );

  /*
   * `/` and `N` — DESIGN.md §8's list-page keys. Registered only while a workspace is chosen,
   * because both act on a list that does not exist without one.
   */
  const shortcuts = React.useMemo<readonly ShortcutBinding[]>(
    () =>
      currentTenantId
        ? [
            {
              id: 'repositories-filter',
              scope: 'list',
              description: 'Filter repositories',
              chord: { key: '/' },
              run: () => searchRef.current?.focus(),
            },
            {
              id: 'repositories-add',
              scope: 'list',
              description: 'Add repository',
              chord: { key: 'n' },
              run: () => router.push(ADD_REPOSITORY_HREF),
            },
          ]
        : [],
    [currentTenantId, router]
  );
  useShortcuts(shortcuts);

  // ---- the toolbar, shared by both views ----------------------------------------------------

  const toolbar = (
    <DataTableToolbar data-testid="repositories-toolbar">
      <DataTableSearch
        ref={searchRef}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search repositories…  ( / )"
        aria-label="Search repositories"
        data-testid="repositories-search"
      />
      <RepositoryQuickFilter
        label="Provider"
        testId="repositories-filter-provider"
        value={filters.provider}
        options={REPOSITORY_PROVIDER_OPTIONS}
        onChange={(provider) => setFilters((current) => ({ ...current, provider }))}
      />
      <RepositoryQuickFilter
        label="Visibility"
        testId="repositories-filter-visibility"
        value={filters.visibility}
        options={REPOSITORY_VISIBILITY_OPTIONS}
        onChange={(visibility) => setFilters((current) => ({ ...current, visibility }))}
      />

      <DataTableToolbarSpacer />

      <Select value={sort} onValueChange={(next) => isRepositorySortKey(next) && setSort(next)}>
        <SelectTrigger className="repo-filter" aria-label="Sort" data-testid="repositories-sort">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {REPOSITORY_SORT_OPTIONS.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Segmented
        value={view}
        onValueChange={(next) => persistView(next as RepositoriesView)}
        size="sm"
        aria-label="List view"
      >
        <SegmentedItem value="grid" data-testid="repositories-view-grid">
          <LayoutGrid aria-hidden />
          Grid
        </SegmentedItem>
        <SegmentedItem value="list" data-testid="repositories-view-list">
          <List aria-hidden />
          List
        </SegmentedItem>
      </Segmented>
    </DataTableToolbar>
  );

  const emptyState = narrowed ? (
    <EmptyState
      variant="compact"
      surface={false}
      tone="neutral"
      title="No matches"
      description="Try adjusting search or filters."
      action={
        <Button variant="outline" onClick={clearFilters} data-testid="repositories-clear-filters">
          Clear all filters
        </Button>
      }
    />
  ) : (
    <EmptyState
      variant="compact"
      surface={false}
      title="No repositories yet"
      description="Register a Git repository through a linked account or a public clone URL. After the API is enabled, scans and file indexing appear here."
      action={
        <Button asChild data-testid="repositories-empty-add">
          <Link href={ADD_REPOSITORY_HREF}>
            <Plus aria-hidden />
            Add repository
          </Link>
        </Button>
      }
    />
  );

  // ---- the page -----------------------------------------------------------------------------

  return (
    <Page>
      <PageHeader
        breadcrumb={[
          { label: 'Home', href: HOME_ROUTE },
          { label: 'Bring in' },
          { label: 'Repositories' },
        ]}
        title="Repositories"
        description={repositoriesSummaryLine(repositories)}
        actions={
          <>
            <Button
              variant="outline"
              onClick={rescanAll}
              disabled={!currentTenantId}
              title="Runs when scan jobs are wired to the API"
              data-testid="repositories-rescan-all"
            >
              <RefreshCw aria-hidden />
              Rescan all
            </Button>
            <Button asChild kbd="N" data-testid="repositories-add">
              <Link href={ADD_REPOSITORY_HREF}>
                <Plus aria-hidden />
                Add repository
              </Link>
            </Button>
          </>
        }
        tabs={
          <RepositoriesSubNav
            active="list"
            counts={loading || loadError ? undefined : { list: repositories.length }}
          />
        }
      />

      <PageBody>
        {!currentTenantId ? (
          <GatedState description="Repositories are registered against one workspace." />
        ) : (
          <>
            {/* A strip of zeros above an empty state says the same thing twice. */}
            {repositories.length > 0 ? <RepositoryKpiStrip repositories={repositories} /> : null}

            {/* RAR-5.5: tenant-wide auto-refresh health, with a drill-in per repository. */}
            <RepositoryRefreshActivityPanel />

            {view === 'list' ? (
              <RepositoryTable
                repositories={visible}
                total={repositories.length}
                loading={loading}
                error={loadError}
                onRetry={() => void loadRepositories()}
                busy={busy}
                toolbar={toolbar}
                empty={emptyState}
                {...handlers}
              />
            ) : (
              <Card className="repo-cards-panel" data-testid="repositories-cards">
                {toolbar}
                {loading ? (
                  <div className="repo-grid" aria-busy>
                    {[0, 1, 2].map((index) => (
                      <div key={index} className="repo-card repo-card--skeleton" aria-hidden />
                    ))}
                    <p className="sr-only" role="status">
                      Loading repositories…
                    </p>
                  </div>
                ) : loadError ? (
                  <div className="repo-cards-panel__empty">
                    <EmptyState
                      variant="compact"
                      surface={false}
                      tone="danger"
                      title={REPOSITORIES_LOAD_ERROR}
                      description={loadError}
                      action={
                        <Button variant="outline" onClick={() => void loadRepositories()}>
                          Try again
                        </Button>
                      }
                    />
                  </div>
                ) : visible.length === 0 ? (
                  <div className="repo-cards-panel__empty">{emptyState}</div>
                ) : (
                  <div className="repo-grid">
                    {visible.map((repository) => (
                      <RepositoryCard
                        key={repository.id}
                        repository={repository}
                        busy={busy}
                        {...handlers}
                      />
                    ))}
                    {/* The mockup's dashed "Add repository" tile — the one place on this
                        screen where the grid itself offers the next step. */}
                    <Link
                      href={ADD_REPOSITORY_HREF}
                      className="repo-add-tile"
                      data-testid="repositories-add-tile"
                    >
                      <span className="repo-add-tile__art" aria-hidden>
                        <Plus />
                      </span>
                      <span className="repo-add-tile__title">Add repository</span>
                      <span className="repo-add-tile__desc">
                        Linked GitHub account, or any public Git URL.
                      </span>
                    </Link>
                  </div>
                )}
              </Card>
            )}
          </>
        )}
      </PageBody>
    </Page>
  );
}

/** Props for {@link RepositoryQuickFilter}. */
interface RepositoryQuickFilterProps {
  /** The axis this select narrows — `Provider`, `Visibility`. */
  label: string;
  /** Its `data-testid`. */
  testId: string;
  /** The current value, or {@link REPOSITORY_FILTER_ANY}. */
  value: string;
  /** Every option, the neutral one first. */
  options: readonly RepositoryFilterOption[];
  /** Report the next value. */
  onChange: (next: string) => void;
}

/**
 * One of the toolbar's single-choice quick filters.
 *
 * Both are the same control over different vocabularies, so they are one component: what
 * differs is the option list, which is a constant in `repositoriesModel` and therefore
 * something a test can enumerate without opening a menu. The trigger is marked `data-active`
 * when the filter is narrowing, which the stylesheet tints — a select that is changing what the
 * reader sees should not look identical to one that is not.
 *
 * @param props See {@link RepositoryQuickFilterProps}.
 * @returns The select.
 */
function RepositoryQuickFilter({
  label,
  testId,
  value,
  options,
  onChange,
}: RepositoryQuickFilterProps) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        className="repo-filter"
        aria-label={label}
        data-testid={testId}
        data-active={value !== REPOSITORY_FILTER_ANY ? '' : undefined}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
