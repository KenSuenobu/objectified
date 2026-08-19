'use client';

/**
 * Bring in → Discovered specs (HIVE-7.6, #5323).
 *
 * Authority: `docs/mockups/sources/repository-catalog.html`, whose **Notes → Keeps (1:1)**
 * list is this ticket's acceptance criteria for this screen; DESIGN.md §5.3 (page header),
 * §8 (list page: header → filters → table → foot) and §3.1 (status vocabulary).
 *
 * ### What this screen is
 *
 * A tenant-wide answer to "where does this spec live": every discovered spec across every
 * repository, searchable by path, format, repository, project and status.
 *
 * Three things were true before this redesign and are still true, because they are the reason
 * the screen works at all:
 *
 *  * **Nothing is filtered in the browser.** Search, filters, ordering and paging are all
 *    query parameters; the server returns one page. That is what keeps the page usable at
 *    10k+ files, where the per-repository browser's habit of holding a whole branch in memory
 *    would not survive.
 *  * **The view lives in the URL.** Filter state round-trips through the address bar, so a
 *    catalog view is a link an operator can paste into an incident channel. That is the
 *    ticket's first acceptance criterion, and {@link specCatalogUrlQuery} is where it is
 *    decided rather than here.
 *  * **Rows link out, they do not re-implement.** A row deep-links into the file detail on its
 *    owning repository rather than hosting a second copy of that drawer.
 *
 * ### What the redesign changed
 *
 * 1. **The header carried a back link and a lone Refresh.** It is the shared page header with
 *    the Repositories sub-nav under it now, so the four sibling screens are reachable from
 *    each other rather than only from the list.
 * 2. **The table was hand-built** out of `dashboardScreenClasses` string constants, with its
 *    own thead, its own hover tint, its own foot and its own three-way loading/empty/error
 *    branch above it. It is `ui/DataTable`, which owns all four — so the skeleton is shaped
 *    like the content and the empty state sits *inside* the card rather than replacing it.
 * 3. **The status pills were four pairs of palette classes.** They are the shared vocabulary,
 *    and the four states are now entries in it.
 * 4. **The meaning of a status was only in a `title`.** It is the *Status vocabulary* card,
 *    on the page, for readers who are not hovering with a pointer.
 * 5. **A `<main>` per screen.** The shell owns the landmark; this is a `Page`.
 */

import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertTriangle, GitBranch, Library, Plus, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

import { useAuthSession } from '@lib/auth/session-client';

import PageHeader from '@/app/components/shell/PageHeader';
import { Page, PageBody } from '@/app/components/shell/pageChrome';
import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import {
  DataTable,
  DataTableCellSub,
  DataTableFoot,
  type DataTableColumn,
} from '@/app/components/ui/DataTable';
import { EmptyState, GatedState } from '@/app/components/ui/EmptyState';
import { ErrorState } from '@/app/components/ui/ErrorState';
import { FormatPill } from '@/app/components/ui/catalog/FormatPill';
import { repositorySpecReviewHref } from '@/app/components/ade/dashboard/repositories/RepositorySpecsTab';
import {
  ADD_REPOSITORY_HREF,
  DEFAULT_SPEC_CATALOG_FILTERS,
  SPEC_CATALOG_ERROR_FALLBACK,
  SPEC_CATALOG_ERROR_TITLE,
  SPEC_CATALOG_EMPTY_DESC,
  SPEC_CATALOG_EMPTY_TITLE,
  SPEC_CATALOG_FILTERED_DESC,
  SPEC_CATALOG_FILTERED_TITLE,
  SPEC_CATALOG_LOADING,
  SPEC_CATALOG_NO_TENANT,
  SPEC_CATALOG_PAGE_SIZE,
  RepositoriesSubNav,
  SpecCatalogFilterPanel,
  SpecStatusVocabulary,
  formatSpecDate,
  formatSpecSize,
  specCatalogApiQuery,
  specCatalogFiltersFromSearchParams,
  specCatalogOptionsOf,
  specCatalogHasActiveFilters,
  specCatalogRangeLabel,
  specCatalogStatusBadge,
  specCatalogSummaryLine,
  specCatalogUrlQuery,
  splitSpecPath,
  unresolvedRefsNote,
  type SpecCatalogFacets,
  type SpecCatalogFilters as SpecCatalogFilterState,
  type SpecCatalogResponse,
  type SpecCatalogRow,
} from '@/app/components/ade/repositories';

/** Debounce for the search box, matching the per-repository Files browser. */
const SEARCH_DEBOUNCE_MS = 250;

/** Where the breadcrumb's first crumb goes. */
const HOME_ROUTE = '/ade/dashboard';

/** This screen's own route, which the address-bar mirror writes back to. */
const CATALOG_ROUTE = '/ade/dashboard/repositories/catalog';

/** Everything in a catalog view except the search term, which the search box owns. */
type CatalogOptions = Omit<SpecCatalogFilterState, 'q'>;

/** What {@link useDebouncedText} hands back. */
interface DebouncedText {
  /** What the input shows — updates on every keystroke. */
  draft: string;
  /** What the request uses — settles `delayMs` after the last keystroke. */
  committed: string;
  /** Record a keystroke. */
  type: (next: string) => void;
  /** Adopt a value immediately, cancelling any pending settle. */
  commit: (next: string) => void;
}

/**
 * A text value with a debounced twin, so a keystroke does not become a request.
 *
 * `commit` exists for "Clear filters": without a way to cancel the pending settle, a search
 * term typed 100 ms before the click would land *after* it and silently re-filter the catalog
 * the operator just cleared.
 *
 * @param initial The starting value for both the draft and the committed twin.
 * @param delayMs The quiet period before a typed value is committed.
 * @returns The draft, the committed value, and the two setters.
 */
function useDebouncedText(initial: string, delayMs: number): DebouncedText {
  const [draft, setDraft] = React.useState(initial);
  const [committed, setCommitted] = React.useState(initial);
  const timer = React.useRef<number | null>(null);

  const cancel = React.useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const type = React.useCallback(
    (next: string) => {
      setDraft(next);
      cancel();
      timer.current = window.setTimeout(() => setCommitted(next), delayMs);
    },
    [cancel, delayMs]
  );

  const commit = React.useCallback(
    (next: string) => {
      cancel();
      setDraft(next);
      setCommitted(next);
    },
    [cancel]
  );

  React.useEffect(() => cancel, [cancel]);

  return { draft, committed, type, commit };
}

/**
 * The Spec column: a dimmed directory, the file name, and the unresolved-`$ref` warning.
 *
 * @param spec The row.
 * @returns The cell.
 */
function SpecCell({ spec }: { spec: SpecCatalogRow }) {
  const { dir, file } = splitSpecPath(spec.path);
  const unresolved = unresolvedRefsNote(spec.external_ref_unresolved_count);

  return (
    <div className="spec-cell">
      <Link
        href={repositorySpecReviewHref(spec.repository_id, spec.path, spec.branch)}
        className="spec-path mono"
        title={`Open ${spec.path} in ${spec.repository_full_name}`}
      >
        {dir ? <span className="spec-path__dir">{dir}</span> : null}
        <span className="spec-path__file">{file}</span>
      </Link>
      {unresolved ? (
        <Badge variant="warn" className="spec-refs" data-testid="spec-catalog-unresolved">
          <AlertTriangle aria-hidden />
          {unresolved}
        </Badge>
      ) : null}
    </div>
  );
}

/**
 * The discovered-specs screen.
 *
 * @returns The page.
 */
export function DiscoveredSpecsClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session } = useAuthSession();
  const currentTenantId = (session?.user as { current_tenant_id?: string } | undefined)
    ?.current_tenant_id;

  // Seed once from the URL. Afterwards this component owns the state and pushes it back to the
  // address bar; re-reading `searchParams` on every render would fight the user's typing.
  const [seed] = React.useState<SpecCatalogFilterState>(() =>
    specCatalogFiltersFromSearchParams(new URLSearchParams(searchParams.toString()))
  );

  // The search box is the *only* store of `q`, deliberately kept out of `options`: holding it
  // in both places is what lets the two disagree.
  const search = useDebouncedText(seed.q, SEARCH_DEBOUNCE_MS);
  const debouncedSearch = search.committed;
  const [options, setOptions] = React.useState<CatalogOptions>(() =>
    specCatalogOptionsOf(seed)
  );

  // A new search belongs on page 1. Adjusting during render (rather than in an effect) means
  // the fetch below only ever sees the settled state, so a keystroke costs one request.
  const [lastSearch, setLastSearch] = React.useState(debouncedSearch);
  if (lastSearch !== debouncedSearch) {
    setLastSearch(debouncedSearch);
    setOptions((prev) => (prev.offset === 0 ? prev : { ...prev, offset: 0 }));
  }

  const filters = React.useMemo<SpecCatalogFilterState>(
    () => ({ ...options, q: debouncedSearch }),
    [options, debouncedSearch]
  );

  const [data, setData] = React.useState<SpecCatalogResponse | null>(null);
  const [facets, setFacets] = React.useState<SpecCatalogFacets | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  // Facets describe the whole catalog, so they are fetched once and reused across every
  // filter change and page turn.
  const facetsRequested = React.useRef(false);

  /** Apply a filter change, resetting pagination — a filtered page 3 is rarely meaningful. */
  const updateFilters = React.useCallback((patch: Partial<CatalogOptions>) => {
    setOptions((prev) => ({ ...prev, ...patch, offset: patch.offset ?? 0 }));
  }, []);

  // Mirror the current view into the address bar so it can be bookmarked and shared.
  React.useEffect(() => {
    const query = specCatalogUrlQuery(filters);
    router.replace(`${CATALOG_ROUTE}${query ? `?${query}` : ''}`, { scroll: false });
  }, [filters, router]);

  // Requests are keyed so a slow early response cannot overwrite a faster later one. Typing in
  // the search box is exactly where that happens: the two-character query outlives the
  // five-character one often enough to matter.
  const requestSeq = React.useRef(0);

  const load = React.useCallback(async () => {
    if (!currentTenantId) {
      setData(null);
      setLoading(false);
      return;
    }
    const seq = ++requestSeq.current;
    const isCurrent = () => requestSeq.current === seq;
    const wantFacets = !facetsRequested.current;
    setLoading(true);
    setError(null);
    try {
      const query = specCatalogApiQuery(filters, { includeFacets: wantFacets });
      const response = await fetch(`/api/repositories/catalog?${query}`, {
        credentials: 'include',
      });
      const payload = (await response.json().catch(() => ({}))) as SpecCatalogResponse;
      if (!isCurrent()) return;
      if (!response.ok) {
        throw new Error(
          typeof payload.error === 'string' ? payload.error : response.statusText
        );
      }
      setData(payload);
      if (payload.facets) {
        setFacets(payload.facets);
        facetsRequested.current = true;
      }
    } catch (caught) {
      if (!isCurrent()) return;
      const message = caught instanceof Error ? caught.message : SPEC_CATALOG_ERROR_FALLBACK;
      setData(null);
      setError(message);
      toast.error(message);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [currentTenantId, filters]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const specs = data?.specs ?? [];
  const offset = data?.offset ?? 0;
  const matchCount = data?.match_count ?? 0;
  const canPrev = offset > 0;
  const canNext = offset + specs.length < matchCount;
  const narrowed = React.useMemo(() => specCatalogHasActiveFilters(filters), [filters]);

  const clearFilters = React.useCallback(() => {
    search.commit('');
    setOptions(specCatalogOptionsOf(DEFAULT_SPEC_CATALOG_FILTERS));
  }, [search]);

  const columns = React.useMemo<DataTableColumn<SpecCatalogRow>[]>(
    () => [
      {
        id: 'spec',
        header: 'Spec',
        skeletonWidth: '70%',
        cell: (spec) => <SpecCell spec={spec} />,
      },
      {
        id: 'repository',
        header: 'Repository',
        skeletonWidth: '60%',
        cell: (spec) => (
          <>
            <Link
              href={`/ade/dashboard/repositories/${encodeURIComponent(spec.repository_id)}/preview`}
              className="spec-link"
            >
              {spec.repository_full_name || '—'}
            </Link>
            <DataTableCellSub className="spec-branch">
              <GitBranch aria-hidden />
              <span className="mono">{spec.branch}</span>
            </DataTableCellSub>
          </>
        ),
      },
      {
        id: 'format',
        header: 'Format',
        skeletonWidth: '4rem',
        cell: (spec) => <FormatPill format={spec.format} />,
      },
      {
        id: 'project',
        header: 'Project',
        skeletonWidth: '50%',
        cell: (spec) =>
          spec.project_id ? (
            <Link
              href={`/ade/dashboard/projects/${encodeURIComponent(spec.project_id)}`}
              className="spec-link"
            >
              {spec.project_name || spec.project_slug || spec.project_id}
            </Link>
          ) : (
            <span className="spec-unmapped">Unmapped</span>
          ),
      },
      {
        id: 'status',
        header: 'Status',
        skeletonWidth: '5rem',
        cell: (spec) => {
          const badge = specCatalogStatusBadge(spec.status);
          return (
            <Badge status={badge.status} title={badge.title} data-testid="spec-catalog-status">
              {badge.label}
            </Badge>
          );
        },
      },
      {
        id: 'size',
        header: 'Size',
        align: 'end',
        skeletonWidth: '3rem',
        className: 'spec-num',
        cell: (spec) => formatSpecSize(spec.size_bytes),
      },
      {
        id: 'activity',
        header: 'Last activity',
        skeletonWidth: '5rem',
        className: 'spec-num',
        cell: (spec) => formatSpecDate(spec.last_imported_at ?? spec.discovered_at),
      },
    ],
    []
  );

  const empty = narrowed ? (
    <EmptyState
      variant="compact"
      surface={false}
      tone="neutral"
      title={SPEC_CATALOG_FILTERED_TITLE}
      description={SPEC_CATALOG_FILTERED_DESC}
      action={
        <Button variant="outline" onClick={clearFilters} data-testid="spec-catalog-empty-clear">
          Clear filters
        </Button>
      }
    />
  ) : (
    <EmptyState
      variant="compact"
      surface={false}
      icon={<Library />}
      title={SPEC_CATALOG_EMPTY_TITLE}
      description={SPEC_CATALOG_EMPTY_DESC}
      action={
        <Button asChild data-testid="spec-catalog-empty-add">
          <Link href={ADD_REPOSITORY_HREF}>
            <Plus aria-hidden />
            Register a repository
          </Link>
        </Button>
      }
    />
  );

  return (
    <Page>
      <PageHeader
        breadcrumb={[
          { label: 'Home', href: HOME_ROUTE },
          { label: 'Bring in' },
          { label: 'Repositories', href: '/ade/dashboard/repositories' },
          { label: 'Discovered specs' },
        ]}
        title="Discovered specs"
        description={specCatalogSummaryLine(data?.catalog_total)}
        actions={
          <Button
            variant="outline"
            onClick={() => void load()}
            disabled={loading || !currentTenantId}
            data-testid="spec-catalog-refresh"
          >
            <RefreshCw className={loading ? 'animate-spin' : undefined} aria-hidden />
            Refresh
          </Button>
        }
        tabs={
          <RepositoriesSubNav
            active="catalog"
            counts={data ? { catalog: data.catalog_total } : undefined}
          />
        }
      />

      <PageBody>
        {!currentTenantId ? (
          <GatedState description={SPEC_CATALOG_NO_TENANT} />
        ) : (
          <>
            <SpecCatalogFilterPanel
              filters={filters}
              searchDraft={search.draft}
              facets={facets}
              active={narrowed}
              onSearch={search.type}
              onChange={updateFilters}
              onClear={clearFilters}
            />

            {/*
              A failed read replaces the table rather than becoming a row inside it. `DataTable`
              does offer an error slot, but its heading is the app-wide "Couldn't load this
              list" — and the mockup's **States** list fixes this screen's heading as "Could not
              load the spec catalog", which is the sentence that tells an operator *which*
              read failed on a page that makes several. The filter panel stays above it, so a
              retry can be a narrower request rather than the same one again.
            */}
            {error ? (
              <ErrorState
                title={SPEC_CATALOG_ERROR_TITLE}
                description={error}
                onRetry={() => void load()}
                data-testid="spec-catalog-error"
              />
            ) : (
            <DataTable
              caption="Discovered specs"
              columns={columns}
              rows={specs}
              getRowId={(spec) => `${spec.id}:${spec.branch}`}
              getRowLabel={(spec) => `${spec.repository_full_name} ${spec.path}`}
              scrollX
              loading={loading && !data}
              loadingLabel={SPEC_CATALOG_LOADING}
              empty={empty}
              data-testid="spec-catalog-table"
              footer={
                <DataTableFoot>
                  <span data-testid="spec-catalog-range">
                    {specCatalogRangeLabel(offset, specs.length, matchCount)}
                  </span>
                  <span className="spec-pager">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!canPrev || loading}
                      onClick={() =>
                        setOptions((prev) => ({
                          ...prev,
                          offset: Math.max(0, prev.offset - SPEC_CATALOG_PAGE_SIZE),
                        }))
                      }
                      data-testid="spec-catalog-prev"
                    >
                      Prev
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!canNext || loading}
                      onClick={() =>
                        setOptions((prev) => ({
                          ...prev,
                          offset: prev.offset + SPEC_CATALOG_PAGE_SIZE,
                        }))
                      }
                      data-testid="spec-catalog-next"
                    >
                      Next
                    </Button>
                  </span>
                </DataTableFoot>
              }
            />
            )}

            <SpecStatusVocabulary />
          </>
        )}
      </PageBody>
    </Page>
  );
}

export default DiscoveredSpecsClient;
