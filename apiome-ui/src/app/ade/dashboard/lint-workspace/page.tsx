'use client';

/**
 * Catalog-wide lint posture & remediation workspace (CLX-4.1, #4859).
 *
 * The persistent triage surface over the tenant's lint evidence: a posture summary header,
 * a filterable findings queue with bulk actions (assign / acknowledge / fix / waiver
 * request-review, all server-authorized and audited, with Undo built from returned
 * beforeStates), a finding detail dialog linking revision / evidence / policy / history,
 * a remediation-vs-policy trends tab, a per-format quality-rank & grade-drift tab (IXH-2.7),
 * and per-user saved views. Filter state lives in the
 * URL (shareable); tenant scope comes from the session, project scope from ?projectId=.
 */

import { useAuthSession } from '@lib/auth/session-client';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import {
  Button,
  EmptyState,
  GatedState,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/app/components/ui';
import {
  dashboardContentStackClass,
  dashboardMainClass,
} from '@/app/components/ade/dashboard/dashboardScreenClasses';
import LintWorkspaceSummaryHeader from '@/app/components/ade/dashboard/lint/workspace/LintWorkspaceSummaryHeader';
import LintWorkspaceFilters from '@/app/components/ade/dashboard/lint/workspace/LintWorkspaceFilters';
import LintWorkspaceQueueTable from '@/app/components/ade/dashboard/lint/workspace/LintWorkspaceQueueTable';
import LintWorkspaceBulkActionBar from '@/app/components/ade/dashboard/lint/workspace/LintWorkspaceBulkActionBar';
import LintWorkspaceFindingDetailDialog from '@/app/components/ade/dashboard/lint/workspace/LintWorkspaceFindingDetailDialog';
import LintWorkspaceTrendsPanel from '@/app/components/ade/dashboard/lint/workspace/LintWorkspaceTrendsPanel';
import LintWorkspaceQualityRanksPanel from '@/app/components/ade/dashboard/lint/workspace/LintWorkspaceQualityRanksPanel';
import LintWorkspaceSavedViewsBar from '@/app/components/ade/dashboard/lint/workspace/LintWorkspaceSavedViewsBar';
import {
  EMPTY_WORKSPACE_FILTERS,
  buildBulkRequest,
  buildUndoBulkRequests,
  filtersToSavedViewBlob,
  filtersToSearchParams,
  lintWorkspaceBulkResponseFromPayload,
  lintWorkspaceFindingsFromPayload,
  lintWorkspaceSavedViewFromPayload,
  lintWorkspaceSummaryFromPayload,
  lintWorkspaceTrendsFromPayload,
  parseWorkspaceFilters,
  qualityRankSeriesFromPayload,
  savedViewToFilters,
  selectionKey,
  type BulkActionSet,
  type LintWorkspaceFinding,
  type LintWorkspaceFindingsPage,
  type LintWorkspaceSavedView,
  type LintWorkspaceSummary,
  type LintWorkspaceTrends,
  type QualityRankSeries,
  type WorkspaceFilters,
} from '@/app/utils/lint-workspace';

const PAGE_SIZE = 50;

/** Default window for the quality-rank series, in days (the server caps the range at 180). */
const DEFAULT_QUALITY_RANK_DAYS = 30;

function LintWorkspacePageInner() {
  const { data: session } = useAuthSession();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentTenantId = (session?.user as { current_tenant_id?: string } | undefined)
    ?.current_tenant_id;

  // Filter/sort/offset state is URL-derived so views are shareable and saveable.
  const filters = useMemo(() => parseWorkspaceFilters(searchParams), [searchParams]);
  const sort = searchParams.get('sort') || 'severity';
  const offset = Math.max(0, Number(searchParams.get('offset')) || 0);

  const [page, setPage] = useState<LintWorkspaceFindingsPage | null>(null);
  const [summary, setSummary] = useState<LintWorkspaceSummary | null>(null);
  const [trends, setTrends] = useState<LintWorkspaceTrends | null>(null);
  const [qualityRanks, setQualityRanks] = useState<QualityRankSeries | null>(null);
  const [qualityRankDays, setQualityRankDays] = useState(DEFAULT_QUALITY_RANK_DAYS);
  const [views, setViews] = useState<LintWorkspaceSavedView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<LintWorkspaceFinding | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const undoStack = useRef<Array<{ items: Array<Record<string, string>>; set: Record<string, string> }>>([]);

  const applyUrlState = useCallback(
    (next: WorkspaceFilters, nextSort: string, nextOffset: number) => {
      const params = filtersToSearchParams(next, {
        sort: nextSort !== 'severity' ? nextSort : undefined,
        offset: nextOffset > 0 ? nextOffset : undefined,
      });
      const text = params.toString();
      router.replace(text ? `${pathname}?${text}` : pathname, { scroll: false });
    },
    [router, pathname],
  );

  const loadQueue = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = filtersToSearchParams(filters, { sort, limit: PAGE_SIZE, offset });
      const res = await fetch(`/api/lint/workspace/findings?${params.toString()}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        throw new Error(typeof data.error === 'string' ? data.error : res.statusText);
      }
      setPage(lintWorkspaceFindingsFromPayload(data));
    } catch (e) {
      setPage(null);
      setError(e instanceof Error ? e.message : 'Could not load the findings queue.');
    } finally {
      setLoading(false);
    }
  }, [filters, sort, offset]);

  const loadSummary = useCallback(async () => {
    try {
      const query = filters.projectId
        ? `?projectId=${encodeURIComponent(filters.projectId)}`
        : '';
      const res = await fetch(`/api/lint/workspace/summary${query}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) setSummary(lintWorkspaceSummaryFromPayload(data));
    } catch {
      // The queue is the primary surface; a failed summary just hides the header tiles.
    }
  }, [filters.projectId]);

  const loadTrends = useCallback(async () => {
    try {
      const params = new URLSearchParams({ days: '30' });
      if (filters.projectId) params.set('projectId', filters.projectId);
      const res = await fetch(`/api/lint/workspace/trends?${params.toString()}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) setTrends(lintWorkspaceTrendsFromPayload(data));
    } catch {
      // Trends are supplementary; the tab shows its empty state on failure.
    }
  }, [filters.projectId]);

  const loadQualityRanks = useCallback(async () => {
    try {
      const params = new URLSearchParams({ days: String(qualityRankDays) });
      if (filters.projectId) params.set('projectId', filters.projectId);
      const res = await fetch(`/api/lint/workspace/quality-ranks?${params.toString()}`, {
        credentials: 'include',
        cache: 'no-store',
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) setQualityRanks(qualityRankSeriesFromPayload(data));
    } catch {
      // The grade series is supplementary; the tab shows its empty state on failure.
    }
  }, [filters.projectId, qualityRankDays]);

  const loadViews = useCallback(async () => {
    try {
      const res = await fetch('/api/lint/workspace/views', {
        credentials: 'include',
        cache: 'no-store',
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success && Array.isArray(data.views)) {
        setViews(
          (data.views as unknown[])
            .map(lintWorkspaceSavedViewFromPayload)
            .filter((v): v is LintWorkspaceSavedView => v !== null),
        );
      }
    } catch {
      // Saved views are a convenience; failures leave the bar empty.
    }
  }, []);

  useEffect(() => {
    if (!currentTenantId) return;
    void loadQueue();
  }, [currentTenantId, loadQueue]);

  useEffect(() => {
    if (!currentTenantId) return;
    void loadSummary();
    void loadTrends();
    void loadViews();
  }, [currentTenantId, loadSummary, loadTrends, loadViews]);

  // Its own effect: changing the quality-rank window must not re-fetch the queue, the summary,
  // the trends and the saved views alongside it.
  useEffect(() => {
    if (!currentTenantId) return;
    void loadQualityRanks();
  }, [currentTenantId, loadQualityRanks]);

  const refreshAll = useCallback(() => {
    void loadQueue();
    void loadSummary();
    void loadTrends();
    void loadQualityRanks();
  }, [loadQueue, loadSummary, loadTrends, loadQualityRanks]);

  const runBulk = useCallback(
    async (body: { items: Array<Record<string, string>>; set: Record<string, string> }) => {
      const res = await fetch('/api/lint/workspace/decisions/bulk', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        throw new Error(typeof data.error === 'string' ? data.error : res.statusText);
      }
      return lintWorkspaceBulkResponseFromPayload(data);
    },
    [],
  );

  const handleBulkApply = useCallback(
    async (set: BulkActionSet) => {
      if (!page) return;
      const selectedFindings = page.findings.filter((f) => selected.has(selectionKey(f)));
      const request = buildBulkRequest(selectedFindings, set);
      if (request.items.length === 0) return;
      setBulkBusy(true);
      try {
        const response = await runBulk(request);
        const undos = buildUndoBulkRequests(response);
        undoStack.current = undos;
        if (response.failedCount > 0) {
          const firstError = response.results.find((r) => !r.ok)?.error;
          toast.warning(
            `Applied ${response.appliedCount}, failed ${response.failedCount}${
              firstError ? ` — ${firstError}` : ''
            }`,
          );
        } else {
          toast.success(`Applied to ${response.appliedCount} finding${response.appliedCount === 1 ? '' : 's'}`, {
            action:
              undos.length > 0
                ? {
                    label: 'Undo',
                    onClick: () => {
                      void (async () => {
                        try {
                          for (const undo of undoStack.current) await runBulk(undo);
                          toast.success('Reverted');
                        } catch (e) {
                          toast.error(e instanceof Error ? e.message : 'Undo failed');
                        } finally {
                          refreshAll();
                        }
                      })();
                    },
                  }
                : undefined,
          });
        }
        setSelected(new Set());
        refreshAll();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Bulk action failed');
      } finally {
        setBulkBusy(false);
      }
    },
    [page, selected, runBulk, refreshAll],
  );

  const handleSaveView = useCallback(
    async (name: string, pin: boolean) => {
      try {
        const res = await fetch('/api/lint/workspace/views', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            filters: filtersToSavedViewBlob(filters),
            query: filters.q,
            sort,
            isPinned: pin,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
          throw new Error(typeof data.error === 'string' ? data.error : res.statusText);
        }
        toast.success(`Saved view “${name}”`);
        void loadViews();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Could not save the view');
      }
    },
    [filters, sort, loadViews],
  );

  const handleTogglePin = useCallback(
    async (view: LintWorkspaceSavedView) => {
      await fetch(`/api/lint/workspace/views/${encodeURIComponent(view.id)}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isPinned: !view.isPinned }),
      }).catch(() => null);
      void loadViews();
    },
    [loadViews],
  );

  const handleDeleteView = useCallback(
    async (view: LintWorkspaceSavedView) => {
      await fetch(`/api/lint/workspace/views/${encodeURIComponent(view.id)}`, {
        method: 'DELETE',
        credentials: 'include',
      }).catch(() => null);
      void loadViews();
    },
    [loadViews],
  );

  const handleDrillDown = useCallback(
    (target: 'security-errors' | 'new' | 'waiver-requests') => {
      const next: WorkspaceFilters = {
        ...EMPTY_WORKSPACE_FILTERS,
        projectId: filters.projectId,
      };
      if (target === 'security-errors') {
        next.severity = ['error'];
        next.axis = ['security'];
        next.state = ['open'];
      } else if (target === 'new') {
        next.newOnly = true;
      } else {
        next.state = ['waiver_requested'];
      }
      setSelected(new Set());
      applyUrlState(next, 'severity', 0);
    },
    [filters.projectId, applyUrlState],
  );

  if (!currentTenantId) {
    return (
      <main className={dashboardMainClass}>
        <GatedState description="Lint posture is measured across one workspace at a time." />
      </main>
    );
  }

  return (
    <>
      <header className="border-b border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
        <div className="px-6 py-4">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <h2 className="flex items-center gap-2 text-2xl font-bold text-gray-900 dark:text-white">
                <ShieldCheck className="h-6 w-6 text-indigo-600 dark:text-indigo-400" aria-hidden />
                Lint Posture
              </h2>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                Catalog-wide lint findings with ownership, waiver review, and remediation
                trends — across every project revision and MCP server in this tenant.
              </p>
            </div>
            <Button
              type="button"
              variant="secondary"
              className="h-auto min-h-10 shrink-0 whitespace-nowrap py-2"
              onClick={refreshAll}
              title="Reload the workspace"
            >
              <RefreshCw className="h-4 w-4 shrink-0" aria-hidden />
              Refresh
            </Button>
          </div>
        </div>
      </header>
      <main className={dashboardMainClass} data-testid="lint-workspace-page">
        <div className={dashboardContentStackClass}>
          {summary && (
            <LintWorkspaceSummaryHeader summary={summary} onDrillDown={handleDrillDown} />
          )}
          <LintWorkspaceSavedViewsBar
            views={views}
            onApply={(view) => {
              setSelected(new Set());
              applyUrlState(savedViewToFilters(view), view.sort, 0);
            }}
            onSaveCurrent={handleSaveView}
            onTogglePin={handleTogglePin}
            onDelete={handleDeleteView}
          />
          <Tabs defaultValue="queue">
            <TabsList>
              <TabsTrigger value="queue" data-testid="tab-queue">
                Queue
              </TabsTrigger>
              <TabsTrigger value="trends" data-testid="tab-trends">
                Trends
              </TabsTrigger>
              <TabsTrigger value="quality-ranks" data-testid="tab-quality-ranks">
                Quality ranks
              </TabsTrigger>
            </TabsList>
            <TabsContent value="queue" className="space-y-4">
              <LintWorkspaceFilters
                filters={filters}
                sort={sort}
                facets={page?.facets ?? {}}
                onChange={(next) => {
                  setSelected(new Set());
                  applyUrlState(next, sort, 0);
                }}
                onSortChange={(nextSort) => applyUrlState(filters, nextSort, 0)}
              />
              {error && (
                <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 dark:border-rose-800 dark:bg-rose-950/50 dark:text-rose-200">
                  {error}{' '}
                  <button type="button" className="font-medium underline" onClick={refreshAll}>
                    Retry
                  </button>
                </div>
              )}
              <LintWorkspaceQueueTable
                findings={page?.findings ?? []}
                total={page?.total ?? 0}
                limit={PAGE_SIZE}
                offset={offset}
                loading={loading}
                selected={selected}
                onSelectionChange={setSelected}
                onOpenDetail={setDetail}
                onPageChange={(nextOffset) => applyUrlState(filters, sort, nextOffset)}
              />
              <LintWorkspaceBulkActionBar
                selectedCount={selected.size}
                busy={bulkBusy}
                onApply={(set) => void handleBulkApply(set)}
                onClearSelection={() => setSelected(new Set())}
              />
            </TabsContent>
            <TabsContent value="trends">
              {trends ? (
                <LintWorkspaceTrendsPanel trends={trends} />
              ) : (
                <EmptyState
                  title="No trend data yet"
                  description="Trends appear once lint evidence accumulates across scans."
                />
              )}
            </TabsContent>
            <TabsContent value="quality-ranks">
              {qualityRanks ? (
                <LintWorkspaceQualityRanksPanel
                  series={qualityRanks}
                  days={qualityRankDays}
                  onDaysChange={setQualityRankDays}
                />
              ) : (
                <EmptyState
                  title="No quality-rank data yet"
                  description="Grades appear here once imports and exports are pre-flighted or committed."
                />
              )}
            </TabsContent>
          </Tabs>
        </div>
      </main>
      <LintWorkspaceFindingDetailDialog finding={detail} onClose={() => setDetail(null)} />
    </>
  );
}

/** useSearchParams requires a Suspense boundary in the App Router. */
export default function LintWorkspacePage() {
  return (
    <Suspense fallback={null}>
      <LintWorkspacePageInner />
    </Suspense>
  );
}
