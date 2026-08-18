'use client';

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { ListChecks, Medal, RefreshCw, TrendingUp } from 'lucide-react';
import { toast } from 'sonner';

import { useAuthSession } from '@lib/auth/session-client';
import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import { GatedState } from '@/app/components/ui/EmptyState';
import {
  TAB_COUNT_CLASS,
  TAB_LIST_CLASS,
  tabTriggerClass,
} from '@/app/components/ui/tabStyles';
import PageHeader from '@/app/components/shell/PageHeader';
import { Page, PageBody } from '@/app/components/shell/pageChrome';
import {
  DEFAULT_QUALITY_RANK_DAYS,
  LINT_QUEUE_PAGE_SIZE,
  LintFindingDrawer,
  LintPostureSummary,
  LintQualityRanksPanel,
  LintQueueTable,
  LintSavedViewsBar,
  LintTrendsPanel,
  LintWaiverDialog,
  bulkToast,
  drillDownFilters,
  type PostureDrillTarget,
  type WaiverDialogMode,
} from '@/app/components/ade/lintWorkspace';
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
  type LintWorkspaceBulkResponse,
  type LintWorkspaceFinding,
  type LintWorkspaceFindingsPage,
  type LintWorkspaceSavedView,
  type LintWorkspaceSummary,
  type LintWorkspaceTrends,
  type QualityRankSeries,
  type WorkspaceFilters,
  type WorkspaceSort,
} from '@/app/utils/lint-workspace';

/**
 * Lint posture — `/ade/dashboard/lint-workspace` (CLX-4.1, #4859; redesigned HIVE-5.8, #5311).
 *
 * Authority: `docs/mockups/govern/lint-posture.html`, whose **Notes → Keeps (1:1)** list is
 * this ticket's acceptance criteria; DESIGN.md §5.3 (page header), §5.4 (drawer), §8 (list).
 *
 * The persistent triage surface over a tenant's lint evidence: a posture summary, saved
 * views, a filterable findings queue with server-authorised bulk decisions and toast-based
 * Undo, a finding drawer, a remediation-versus-policy trends tab and a per-format
 * quality-rank tab.
 *
 * ### What this page owns
 *
 * The four reads, the four writes, which tab is showing and which overlay is open. Every
 * narrowing lives in the **URL** — filters, sort and offset — which is what makes a view
 * shareable and what a saved view is built out of; the page never holds a second copy of it.
 * How the queue is drawn is `LintQueueTable`, what a finding says in full is
 * `LintFindingDrawer`, and the rules behind all of it are `lintWorkspaceModel`.
 *
 * ### Undo travels with the toast, not in a ref
 *
 * The screen this replaces kept the inverse requests in a `useRef` that every subsequent
 * bulk action overwrote. Press Acknowledge, press Mark fixed, then press Undo on the first
 * toast — which is still on screen — and the *second* action was reverted. The undo requests
 * are now closed over by the toast that offers them, so a toast can only ever undo its own
 * write. Partial failures are undoable too, for the same reason: the server applied part of
 * the batch, and that part is exactly what `buildUndoBulkRequests` describes.
 *
 * ### The reads are independent
 *
 * The queue is the page's substance; the summary, the trends, the ranks and the saved views
 * are context. A failed queue read is an error state inside the table with a retry beside
 * it; a failed context read degrades silently to that panel's own empty state, because a
 * banner about the trends endpoint on top of a working queue helps nobody triage anything.
 */

/** Where the breadcrumb's first step goes. */
const HOME_ROUTE = '/ade/dashboard';

/** The three tabs, in the order the header draws them. */
const TABS = [
  { id: 'queue', label: 'Queue', icon: ListChecks },
  { id: 'trends', label: 'Trends', icon: TrendingUp },
  { id: 'ranks', label: 'Quality ranks', icon: Medal },
] as const;

/** Which tab is showing. */
type TabId = (typeof TABS)[number]['id'];

/** What the waiver dialog is currently deciding about. */
interface WaiverTarget {
  /** Which shape the dialog is in. */
  mode: WaiverDialogMode;
  /** The findings the decision applies to. */
  findings: LintWorkspaceFinding[];
  /** What the toast should call the verb. */
  verbLabel: string;
}

/**
 * Turn a caught failure into the sentence to show.
 *
 * @param error Whatever was caught.
 * @param fallback What to say when the failure carried no message.
 * @returns The sentence.
 */
function describeFailure(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Read a workspace endpoint that answers `{ success, … }`.
 *
 * @param url The endpoint.
 * @returns The parsed body.
 * @throws When the response was not OK or reported `success: false`.
 */
async function readWorkspace(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { credentials: 'include', cache: 'no-store' });
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || data.success !== true) {
    throw new Error(typeof data.error === 'string' ? data.error : response.statusText);
  }
  return data;
}

/** The workspace, once a tenant is in scope. */
function LintWorkspacePageInner() {
  const { data: session } = useAuthSession();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentTenantId = (session?.user as { current_tenant_id?: string } | undefined)
    ?.current_tenant_id;

  // Filter/sort/offset state is URL-derived so views are shareable and saveable.
  const filters = React.useMemo(() => parseWorkspaceFilters(searchParams), [searchParams]);
  const sort = (searchParams.get('sort') || 'severity') as WorkspaceSort;
  const offset = Math.max(0, Number(searchParams.get('offset')) || 0);

  const [tab, setTab] = React.useState<TabId>('queue');
  const [page, setPage] = React.useState<LintWorkspaceFindingsPage | null>(null);
  const [summary, setSummary] = React.useState<LintWorkspaceSummary | null>(null);
  const [trends, setTrends] = React.useState<LintWorkspaceTrends | null>(null);
  const [qualityRanks, setQualityRanks] = React.useState<QualityRankSeries | null>(null);
  const [qualityRankDays, setQualityRankDays] = React.useState(DEFAULT_QUALITY_RANK_DAYS);
  const [views, setViews] = React.useState<LintWorkspaceSavedView[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [summaryLoading, setSummaryLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [detail, setDetail] = React.useState<LintWorkspaceFinding | null>(null);
  const [waiver, setWaiver] = React.useState<WaiverTarget | null>(null);
  const [saveViewOpen, setSaveViewOpen] = React.useState(false);
  const [bulkBusy, setBulkBusy] = React.useState(false);

  const applyUrlState = React.useCallback(
    (next: WorkspaceFilters, nextSort: string, nextOffset: number) => {
      const params = filtersToSearchParams(next, {
        sort: nextSort !== 'severity' ? nextSort : undefined,
        offset: nextOffset > 0 ? nextOffset : undefined,
      });
      const text = params.toString();
      router.replace(text ? `${pathname}?${text}` : pathname, { scroll: false });
    },
    [router, pathname]
  );

  const loadQueue = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = filtersToSearchParams(filters, {
        sort,
        limit: LINT_QUEUE_PAGE_SIZE,
        offset,
      });
      setPage(
        lintWorkspaceFindingsFromPayload(
          await readWorkspace(`/api/lint/workspace/findings?${params.toString()}`)
        )
      );
    } catch (caught) {
      setPage(null);
      setError(describeFailure(caught, 'Could not load the findings queue.'));
    } finally {
      setLoading(false);
    }
  }, [filters, sort, offset]);

  const loadSummary = React.useCallback(async () => {
    setSummaryLoading(true);
    try {
      const query = filters.projectId
        ? `?projectId=${encodeURIComponent(filters.projectId)}`
        : '';
      setSummary(
        lintWorkspaceSummaryFromPayload(await readWorkspace(`/api/lint/workspace/summary${query}`))
      );
    } catch {
      // The queue is the primary surface; a failed summary just hides the header tiles.
      setSummary(null);
    } finally {
      setSummaryLoading(false);
    }
  }, [filters.projectId]);

  const loadTrends = React.useCallback(async () => {
    try {
      const params = new URLSearchParams({ days: '30' });
      if (filters.projectId) params.set('projectId', filters.projectId);
      setTrends(
        lintWorkspaceTrendsFromPayload(
          await readWorkspace(`/api/lint/workspace/trends?${params.toString()}`)
        )
      );
    } catch {
      // Trends are supplementary; the tab shows its empty state on failure.
      setTrends(null);
    }
  }, [filters.projectId]);

  const loadQualityRanks = React.useCallback(async () => {
    try {
      const params = new URLSearchParams({ days: String(qualityRankDays) });
      if (filters.projectId) params.set('projectId', filters.projectId);
      setQualityRanks(
        qualityRankSeriesFromPayload(
          await readWorkspace(`/api/lint/workspace/quality-ranks?${params.toString()}`)
        )
      );
    } catch {
      // The grade series is supplementary; the tab shows its empty state on failure.
      setQualityRanks(null);
    }
  }, [filters.projectId, qualityRankDays]);

  const loadViews = React.useCallback(async () => {
    try {
      const data = await readWorkspace('/api/lint/workspace/views');
      setViews(
        (Array.isArray(data.views) ? data.views : [])
          .map(lintWorkspaceSavedViewFromPayload)
          .filter((view): view is LintWorkspaceSavedView => view !== null)
      );
    } catch {
      // Saved views are a convenience; failures leave the bar empty.
    }
  }, []);

  React.useEffect(() => {
    if (!currentTenantId) return;
    void loadQueue();
  }, [currentTenantId, loadQueue]);

  React.useEffect(() => {
    if (!currentTenantId) return;
    void loadSummary();
    void loadTrends();
    void loadViews();
  }, [currentTenantId, loadSummary, loadTrends, loadViews]);

  // Its own effect: changing the quality-rank window must not re-fetch the queue, the
  // summary, the trends and the saved views alongside it.
  React.useEffect(() => {
    if (!currentTenantId) return;
    void loadQualityRanks();
  }, [currentTenantId, loadQualityRanks]);

  const refreshAll = React.useCallback(() => {
    void loadQueue();
    void loadSummary();
    void loadTrends();
    void loadQualityRanks();
  }, [loadQueue, loadSummary, loadTrends, loadQualityRanks]);

  const runBulk = React.useCallback(
    async (body: {
      items: Array<Record<string, string>>;
      set: Record<string, string>;
    }): Promise<LintWorkspaceBulkResponse> => {
      const response = await fetch('/api/lint/workspace/decisions/bulk', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok || data.success !== true) {
        throw new Error(typeof data.error === 'string' ? data.error : response.statusText);
      }
      return lintWorkspaceBulkResponseFromPayload(data);
    },
    []
  );

  /**
   * Apply one decision to a set of findings, and offer to put it back.
   *
   * @param findings What the decision applies to.
   * @param set The decision.
   * @param verbLabel What the toast calls it.
   */
  const applyDecision = React.useCallback(
    async (findings: readonly LintWorkspaceFinding[], set: BulkActionSet, verbLabel: string) => {
      const request = buildBulkRequest([...findings], set);
      if (request.items.length === 0) return;
      setBulkBusy(true);
      try {
        const response = await runBulk(request);
        const undos = buildUndoBulkRequests(response);
        const copy = bulkToast(response, verbLabel, undos.length);
        const action = copy.undoable
          ? {
              label: 'Undo',
              onClick: () => {
                void (async () => {
                  try {
                    for (const undo of undos) await runBulk(undo);
                    toast.success('Reverted');
                  } catch (caught) {
                    toast.error(describeFailure(caught, 'Undo failed'));
                  } finally {
                    refreshAll();
                  }
                })();
              },
            }
          : undefined;
        const show = copy.tone === 'warning' ? toast.warning : toast.success;
        show(copy.title, { description: copy.description, action });
        setSelected(new Set());
        refreshAll();
      } catch (caught) {
        toast.error(describeFailure(caught, 'Bulk action failed'));
      } finally {
        setBulkBusy(false);
      }
    },
    [runBulk, refreshAll]
  );

  const selectedFindings = React.useMemo(
    () => (page?.findings ?? []).filter((finding) => selected.has(selectionKey(finding))),
    [page, selected]
  );

  const handleSaveView = React.useCallback(
    async (name: string, pin: boolean) => {
      try {
        const response = await fetch('/api/lint/workspace/views', {
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
        const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (!response.ok || data.success !== true) {
          throw new Error(typeof data.error === 'string' ? data.error : response.statusText);
        }
        toast.success(`Saved view “${name}”`);
        void loadViews();
      } catch (caught) {
        toast.error(describeFailure(caught, 'Could not save the view'));
      }
    },
    [filters, sort, loadViews]
  );

  const handleTogglePin = React.useCallback(
    async (view: LintWorkspaceSavedView) => {
      await fetch(`/api/lint/workspace/views/${encodeURIComponent(view.id)}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isPinned: !view.isPinned }),
      }).catch(() => null);
      void loadViews();
    },
    [loadViews]
  );

  const handleDeleteView = React.useCallback(
    async (view: LintWorkspaceSavedView) => {
      await fetch(`/api/lint/workspace/views/${encodeURIComponent(view.id)}`, {
        method: 'DELETE',
        credentials: 'include',
      }).catch(() => null);
      void loadViews();
    },
    [loadViews]
  );

  const handleDrillDown = React.useCallback(
    (target: PostureDrillTarget) => {
      setSelected(new Set());
      setTab('queue');
      applyUrlState(drillDownFilters(target, EMPTY_WORKSPACE_FILTERS, filters.projectId), 'severity', 0);
    },
    [applyUrlState, filters.projectId]
  );

  if (!currentTenantId) {
    return (
      <Page>
        <PageHeader
          breadcrumb={[{ label: 'Home', href: HOME_ROUTE }, { label: 'Govern' }, { label: 'Lint posture' }]}
          title="Lint posture"
          badge={<Badge status="preview">Preview</Badge>}
          description="Catalog-wide lint findings with ownership, waiver review and remediation trends."
        />
        <PageBody>
          <GatedState description="Select a tenant to review its catalog-wide lint posture." />
        </PageBody>
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        breadcrumb={[{ label: 'Home', href: HOME_ROUTE }, { label: 'Govern' }, { label: 'Lint posture' }]}
        title="Lint posture"
        badge={<Badge status="preview">Preview</Badge>}
        description="Catalog-wide lint findings with ownership, waiver review and remediation trends."
        actions={
          <>
            <Button
              variant="ghost"
              title="Reload the workspace"
              aria-label="Reload the workspace"
              data-testid="lint-workspace-refresh"
              disabled={loading}
              onClick={refreshAll}
            >
              <RefreshCw aria-hidden />
            </Button>
            <Button data-testid="lint-workspace-save-view" onClick={() => setSaveViewOpen(true)}>
              Save view
            </Button>
          </>
        }
        tabs={
          /* A hand-built strip on the shared tab classes rather than `ui/Tabs`: Radix's
             `Tabs.Root` is one element that would have to wrap the header *and* the body,
             and `.page` is a flex column whose two children are exactly those two. */
          <div role="tablist" aria-label="Lint workspace sections" className={TAB_LIST_CLASS}>
            {TABS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                id={`lint-workspace-tab-${entry.id}`}
                aria-selected={tab === entry.id}
                aria-controls={`lint-workspace-panel-${entry.id}`}
                data-testid={`tab-${entry.id}`}
                className={tabTriggerClass({ active: tab === entry.id })}
                onClick={() => setTab(entry.id)}
              >
                <entry.icon aria-hidden className="lw-tab-glyph" />
                {entry.label}
                {entry.id === 'queue' && page ? (
                  <span className={TAB_COUNT_CLASS}>{page.total}</span>
                ) : null}
              </button>
            ))}
          </div>
        }
      />

      <PageBody>
        <LintPostureSummary
          summary={summary}
          loading={summaryLoading}
          onDrillDown={handleDrillDown}
        />

        <LintSavedViewsBar
          views={views}
          filters={filters}
          sort={sort}
          saveOpen={saveViewOpen}
          onSaveOpenChange={setSaveViewOpen}
          onApply={(view) => {
            setSelected(new Set());
            setTab('queue');
            applyUrlState(savedViewToFilters(view), view.sort, 0);
          }}
          onSaveCurrent={(name, pin) => void handleSaveView(name, pin)}
          onTogglePin={(view) => void handleTogglePin(view)}
          onDelete={(view) => void handleDeleteView(view)}
        />

        {tab === 'queue' && (
          <div
            role="tabpanel"
            id="lint-workspace-panel-queue"
            aria-labelledby="lint-workspace-tab-queue"
          >
            <LintQueueTable
              findings={page?.findings ?? []}
              total={page?.total ?? 0}
              offset={offset}
              facets={page?.facets ?? {}}
              filters={filters}
              sort={sort}
              pathname={pathname}
              loading={loading}
              error={error}
              onRetry={refreshAll}
              onFiltersChange={(next) => {
                setSelected(new Set());
                applyUrlState(next, sort, 0);
              }}
              onSortChange={(next) => applyUrlState(filters, next, 0)}
              onOffsetChange={(next) => applyUrlState(filters, sort, next)}
              selected={selected}
              onSelectionChange={setSelected}
              onOpenFinding={setDetail}
              onBulkApply={(set, verbLabel) => void applyDecision(selectedFindings, set, verbLabel)}
              onOpenWaiverDialog={(mode) =>
                setWaiver({
                  mode,
                  findings: selectedFindings,
                  verbLabel: mode === 'approve' ? 'Approve waiver' : 'Request waiver',
                })
              }
              bulkBusy={bulkBusy}
            />
          </div>
        )}

        {tab === 'trends' && (
          <div
            role="tabpanel"
            id="lint-workspace-panel-trends"
            aria-labelledby="lint-workspace-tab-trends"
          >
            <LintTrendsPanel trends={trends} />
          </div>
        )}

        {tab === 'ranks' && (
          <div
            role="tabpanel"
            id="lint-workspace-panel-ranks"
            aria-labelledby="lint-workspace-tab-ranks"
          >
            <LintQualityRanksPanel
              series={qualityRanks}
              days={qualityRankDays}
              onDaysChange={setQualityRankDays}
            />
          </div>
        )}
      </PageBody>

      <LintFindingDrawer
        finding={detail}
        busy={bulkBusy}
        onClose={() => setDetail(null)}
        onDecision={(finding, set, verbLabel) => void applyDecision([finding], set, verbLabel)}
        onRequestWaiver={(finding) =>
          setWaiver({ mode: 'request', findings: [finding], verbLabel: 'Request waiver' })
        }
      />

      <LintWaiverDialog
        mode={waiver?.mode ?? null}
        count={waiver?.findings.length ?? 0}
        busy={bulkBusy}
        onClose={() => setWaiver(null)}
        onSubmit={(set) => {
          if (!waiver) return;
          void applyDecision(waiver.findings, set, waiver.verbLabel);
          setWaiver(null);
        }}
      />
    </Page>
  );
}

/** `useSearchParams` requires a Suspense boundary in the App Router. */
export default function LintWorkspacePage() {
  return (
    <React.Suspense fallback={null}>
      <LintWorkspacePageInner />
    </React.Suspense>
  );
}
