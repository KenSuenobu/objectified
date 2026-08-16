'use client';

/**
 * Cross-repository discovered-spec catalog (REPO-6.4, #2797).
 *
 * A tenant-wide answer to "where does this spec live": every discovered spec across every
 * repository, searchable by path, format, repository, project and status.
 *
 * Three things are deliberate here:
 *
 *  * **Nothing is filtered in the browser.** Search, filters, ordering and paging are all
 *    query parameters; the server returns one page. That is what keeps the page usable at
 *    10k+ files, where the per-repository browser's habit of holding a whole branch in memory
 *    would not survive.
 *  * **The view lives in the URL.** Filter state round-trips through the address bar, so a
 *    catalog view is a link an operator can paste into an incident channel.
 *  * **Rows link out, they do not re-implement.** Clicking a row deep-links into the REPO-6.2
 *    file detail on its owning repository via {@link repositorySpecReviewHref} rather than
 *    hosting a second copy of that drawer.
 */

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  FileSearch,
  Filter,
  GitBranch,
  Library,
  RefreshCw,
  Search,
} from 'lucide-react';
import { toast } from 'sonner';
import { useAuthSession } from '@lib/auth/session-client';
import { cn } from '@lib/utils';
import { Button } from '@/app/components/ui/Button';
import { Checkbox } from '@/app/components/ui/Checkbox';
import { EmptyState } from '@/app/components/ui/EmptyState';
import { ErrorState } from '@/app/components/ui/ErrorState';
import { Input } from '@/app/components/ui/Input';
import { LoadingState } from '@/app/components/ui/LoadingState';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/app/components/ui/Select';
import {
  dashboardContentStackClass,
  dashboardMainClass,
  dashboardPanelPaddedClass,
  dashboardTableWrapClass,
  dashboardTableTheadClass,
  dashboardTbodyClass,
  dashboardThClass,
  dashboardThRightClass,
  dashboardTrHoverClass,
} from '@/app/components/ade/dashboard/dashboardScreenClasses';
import { repositorySpecReviewHref } from '@/app/components/ade/dashboard/repositories/RepositorySpecsTab';
import { repositoryFormatPillClass } from '@/app/components/ade/dashboard/repositories/repositorySpecFormat';
import {
  DEFAULT_SPEC_CATALOG_FILTERS,
  SPEC_CATALOG_PAGE_SIZE,
  SPEC_CATALOG_SORT_OPTIONS,
  type SpecCatalogFacets,
  type SpecCatalogFilters,
  type SpecCatalogResponse,
  type SpecCatalogRow,
  specCatalogApiQuery,
  specCatalogFiltersFromSearchParams,
  specCatalogHasActiveFilters,
  specCatalogStatusBadge,
  specCatalogUrlQuery,
  splitSpecPath,
} from '@/app/components/ade/dashboard/repositories/repositorySpecCatalog';

/** Debounce for the search box, matching the per-repository Files browser. */
const SEARCH_DEBOUNCE_MS = 250;

/** Everything in a catalog view except the search term, which the search box owns. */
type CatalogOptions = Omit<SpecCatalogFilters, 'q'>;

/** What {@link useDebouncedText} hands back. */
type DebouncedText = {
  /** What the input shows — updates on every keystroke. */
  draft: string;
  /** What the request uses — settles `delayMs` after the last keystroke. */
  committed: string;
  /** Record a keystroke. */
  type: (next: string) => void;
  /** Adopt a value immediately, cancelling any pending settle. */
  commit: (next: string) => void;
};

/**
 * A text value with a debounced twin, so a keystroke does not become a request.
 *
 * `commit` exists for "Clear filters": without a way to cancel the pending settle, a search
 * term typed 100 ms before the click would land *after* it and silently re-filter the catalog
 * the operator just cleared.
 *
 * @param initial - Starting value for both the draft and the committed twin.
 * @param delayMs - Quiet period before a typed value is committed.
 * @returns The draft, the committed value, and the two setters.
 */
function useDebouncedText(initial: string, delayMs: number): DebouncedText {
  const [draft, setDraft] = useState(initial);
  const [committed, setCommitted] = useState(initial);
  const timer = useRef<number | null>(null);

  const cancel = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const type = useCallback(
    (next: string) => {
      setDraft(next);
      cancel();
      timer.current = window.setTimeout(() => setCommitted(next), delayMs);
    },
    [cancel, delayMs]
  );

  const commit = useCallback(
    (next: string) => {
      cancel();
      setDraft(next);
      setCommitted(next);
    },
    [cancel]
  );

  useEffect(() => cancel, [cancel]);

  return { draft, committed, type, commit };
}

/** Render a byte count, or an em dash when the scanner did not record one. */
function formatBytes(n: number | null | undefined): string {
  if (n == null || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Render an ISO timestamp as a short local date, or an em dash when absent. */
function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** One row of the catalog table. Kept separate so the table body stays readable. */
function SpecCatalogTableRow({ spec }: { spec: SpecCatalogRow }) {
  const badge = specCatalogStatusBadge(spec.status);
  const { dir, file } = splitSpecPath(spec.path);
  const href = repositorySpecReviewHref(spec.repository_id, spec.path, spec.branch);
  const unresolved = spec.external_ref_unresolved_count ?? 0;

  return (
    <tr className={dashboardTrHoverClass} data-testid="spec-catalog-row" data-status={spec.status}>
      <td className="max-w-[420px] px-6 py-3 align-middle">
        <Link
          href={href}
          className="group block focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          title={`Open ${spec.path} in ${spec.repository_full_name}`}
        >
          <span className="block truncate font-mono text-sm text-gray-900 group-hover:text-indigo-600 dark:text-gray-100 dark:group-hover:text-indigo-400">
            {dir ? <span className="text-gray-400 dark:text-gray-500">{dir}</span> : null}
            {file}
          </span>
          {unresolved > 0 ? (
            <span className="mt-0.5 inline-flex items-center gap-1 text-2xs text-amber-600 dark:text-amber-400">
              <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
              {unresolved} unresolved external $ref{unresolved === 1 ? '' : 's'}
            </span>
          ) : null}
        </Link>
      </td>
      <td className="px-6 py-3 align-middle">
        <Link
          href={`/ade/dashboard/repositories/${encodeURIComponent(spec.repository_id)}/preview`}
          className="block max-w-[220px] truncate text-sm text-gray-700 hover:text-indigo-600 dark:text-gray-300 dark:hover:text-indigo-400"
        >
          {spec.repository_full_name || '—'}
        </Link>
        <span className="mt-0.5 inline-flex items-center gap-1 text-2xs text-gray-400 dark:text-gray-500">
          <GitBranch className="h-3 w-3 shrink-0" aria-hidden />
          <span className="font-mono">{spec.branch}</span>
        </span>
      </td>
      <td className="px-6 py-3 align-middle">
        <span
          className={cn(
            'inline-block whitespace-nowrap rounded px-2 py-0.5 text-2xs font-medium',
            repositoryFormatPillClass(spec.format)
          )}
        >
          {spec.display_kind}
        </span>
      </td>
      <td className="px-6 py-3 align-middle">
        {spec.project_id ? (
          <Link
            href={`/ade/dashboard/projects/${encodeURIComponent(spec.project_id)}`}
            className="block max-w-[180px] truncate text-sm text-gray-700 hover:text-indigo-600 dark:text-gray-300 dark:hover:text-indigo-400"
          >
            {spec.project_name || spec.project_slug || spec.project_id}
          </Link>
        ) : (
          <span className="text-sm text-gray-400 dark:text-gray-500">Unmapped</span>
        )}
      </td>
      <td className="px-6 py-3 align-middle">
        <span
          className={cn(
            'inline-block whitespace-nowrap rounded px-2 py-0.5 text-2xs font-medium',
            badge.className
          )}
          title={badge.title}
          data-testid="spec-catalog-status"
        >
          {badge.label}
        </span>
      </td>
      <td className="whitespace-nowrap px-6 py-3 align-middle font-mono text-xs text-gray-500 dark:text-gray-400">
        {formatBytes(spec.size_bytes)}
      </td>
      <td className="whitespace-nowrap px-6 py-3 align-middle text-right text-xs text-gray-500 dark:text-gray-400">
        {formatDate(spec.last_imported_at ?? spec.discovered_at)}
      </td>
    </tr>
  );
}

/** A labelled facet dropdown; renders nothing when the catalog has no values to offer. */
function FacetSelect({
  label,
  value,
  allLabel,
  options,
  onChange,
  widthClassName,
}: {
  label: string;
  value: string;
  allLabel: string;
  options: { value: string; label: string; count: number }[];
  onChange: (next: string) => void;
  widthClassName: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={widthClassName} aria-label={label}>
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{allLabel}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label} ({o.count.toLocaleString()})
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function RepositorySpecCatalog() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session } = useAuthSession();
  const currentTenantId = (session?.user as { current_tenant_id?: string })?.current_tenant_id;

  // Seed once from the URL. Afterwards this component owns the state and pushes it back to the
  // address bar; re-reading `searchParams` on every render would fight the user's typing.
  const [seed] = useState<SpecCatalogFilters>(() =>
    specCatalogFiltersFromSearchParams(new URLSearchParams(searchParams.toString()))
  );

  // The search box is the *only* store of `q`, deliberately kept out of `options`: holding it
  // in both places is what lets the two disagree.
  const search = useDebouncedText(seed.q, SEARCH_DEBOUNCE_MS);
  const debouncedSearch = search.committed;
  const [options, setOptions] = useState<CatalogOptions>(() => {
    const { q: _q, ...rest } = seed;
    return rest;
  });

  // A new search belongs on page 1. Adjusting during render (rather than in an effect) means
  // the fetch below only ever sees the settled state, so a keystroke costs one request.
  const [lastSearch, setLastSearch] = useState(debouncedSearch);
  if (lastSearch !== debouncedSearch) {
    setLastSearch(debouncedSearch);
    setOptions((prev) => (prev.offset === 0 ? prev : { ...prev, offset: 0 }));
  }

  const filters = useMemo<SpecCatalogFilters>(
    () => ({ ...options, q: debouncedSearch }),
    [options, debouncedSearch]
  );

  const [data, setData] = useState<SpecCatalogResponse | null>(null);
  const [facets, setFacets] = useState<SpecCatalogFacets | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Facets describe the whole catalog, so they are fetched once and reused across every
  // filter change and page turn.
  const facetsRequested = useRef(false);

  /** Apply a filter change, resetting pagination — a filtered page 3 is rarely meaningful. */
  const updateFilters = useCallback((patch: Partial<CatalogOptions>) => {
    setOptions((prev) => ({ ...prev, ...patch, offset: patch.offset ?? 0 }));
  }, []);

  // Mirror the current view into the address bar so it can be bookmarked and shared.
  useEffect(() => {
    const query = specCatalogUrlQuery(filters);
    router.replace(`/ade/dashboard/repositories/catalog${query ? `?${query}` : ''}`, {
      scroll: false,
    });
  }, [filters, router]);

  // Requests are keyed so a slow early response cannot overwrite a faster later one. Typing in
  // the search box is exactly where that happens: the two-character query outlives the
  // five-character one often enough to matter.
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
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
      const res = await fetch(`/api/repositories/catalog?${query}`, { credentials: 'include' });
      const payload = (await res.json().catch(() => ({}))) as SpecCatalogResponse;
      if (!isCurrent()) return;
      if (!res.ok) {
        throw new Error(typeof payload.error === 'string' ? payload.error : res.statusText);
      }
      setData(payload);
      if (payload.facets) {
        setFacets(payload.facets);
        facetsRequested.current = true;
      }
    } catch (e) {
      if (!isCurrent()) return;
      const message = e instanceof Error ? e.message : 'Could not load the spec catalog.';
      setData(null);
      setError(message);
      toast.error(message);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [currentTenantId, filters]);

  useEffect(() => {
    void load();
  }, [load]);

  const specs = data?.specs ?? [];
  const matchCount = data?.match_count ?? 0;
  const showingFrom = specs.length > 0 ? (data?.offset ?? 0) + 1 : 0;
  const showingTo = (data?.offset ?? 0) + specs.length;
  const canPrev = (data?.offset ?? 0) > 0;
  const canNext = (data?.offset ?? 0) + specs.length < matchCount;
  const hasActiveFilters = useMemo(() => specCatalogHasActiveFilters(filters), [filters]);

  const clearFilters = () => {
    const { q: _q, ...defaults } = DEFAULT_SPEC_CATALOG_FILTERS;
    search.commit('');
    setOptions(defaults);
  };

  if (!currentTenantId) {
    return (
      <main className={dashboardMainClass}>
        <div
          className={cn(
            dashboardPanelPaddedClass,
            'border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-900/20'
          )}
        >
          <h2 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
            No tenant selected
          </h2>
          <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">
            The spec catalog spans the repositories of one tenant. Choose a tenant to continue.
          </p>
          <Link
            href="/ade/dashboard/tenants"
            className="mt-3 inline-block text-sm font-medium text-amber-900 underline dark:text-amber-200"
          >
            Go to tenants
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className={dashboardMainClass}>
      <div className={dashboardContentStackClass}>
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <Link
              href="/ade/dashboard/repositories"
              className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-indigo-600 dark:text-gray-400 dark:hover:text-indigo-400"
            >
              <ArrowLeft className="h-3.5 w-3.5 shrink-0" aria-hidden />
              Repositories
            </Link>
            <h1 className="mt-1 flex items-center gap-2 text-xl font-semibold text-gray-900 dark:text-gray-100">
              <Library className="h-5 w-5 shrink-0 text-indigo-500" aria-hidden />
              Discovered specs
            </h1>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              Every spec the scanner has found across all repositories in this tenant.
              {data ? (
                <>
                  {' '}
                  <span className="font-mono">{data.catalog_total.toLocaleString()}</span> indexed.
                </>
              ) : null}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void load()}
            disabled={loading}
          >
            <RefreshCw className={cn('mr-2 h-3.5 w-3.5', loading && 'animate-spin')} aria-hidden />
            Refresh
          </Button>
        </header>

        <section className={dashboardPanelPaddedClass} aria-label="Catalog filters">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative min-w-[240px] flex-1">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
                aria-hidden
              />
              <Input
                value={search.draft}
                onChange={(e) => search.type(e.target.value)}
                placeholder="Search path, format, repository or project…"
                aria-label="Search discovered specs"
                className="pl-9"
              />
            </div>

            <FacetSelect
              label="Format"
              allLabel="All formats"
              value={filters.format}
              options={facets?.formats ?? []}
              onChange={(format) => updateFilters({ format })}
              widthClassName="w-[170px]"
            />
            <FacetSelect
              label="Repository"
              allLabel="All repositories"
              value={filters.repositoryId}
              options={facets?.repositories ?? []}
              onChange={(repositoryId) => updateFilters({ repositoryId })}
              widthClassName="w-[220px]"
            />
            <FacetSelect
              label="Project"
              allLabel="All projects"
              value={filters.projectId}
              options={facets?.projects ?? []}
              onChange={(projectId) => updateFilters({ projectId })}
              widthClassName="w-[190px]"
            />
            <FacetSelect
              label="Status"
              allLabel="All statuses"
              value={filters.status}
              options={facets?.statuses ?? []}
              onChange={(status) => updateFilters({ status })}
              widthClassName="w-[180px]"
            />

            <Select value={filters.sort} onValueChange={(sort) => updateFilters({ sort })}>
              <SelectTrigger className="w-[190px]" aria-label="Sort by">
                <SelectValue placeholder="Sort" />
              </SelectTrigger>
              <SelectContent>
                {SPEC_CATALOG_SORT_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    Sort: {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-4 border-t border-gray-200 pt-3 dark:border-gray-700">
            <label className="inline-flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
              <Checkbox
                checked={filters.importableOnly}
                onCheckedChange={(checked) =>
                  updateFilters({ importableOnly: checked === true })
                }
                aria-label="Only importable spec types"
              />
              Only importable spec types
            </label>
            <label className="inline-flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
              <Checkbox
                checked={filters.allBranches}
                onCheckedChange={(checked) => updateFilters({ allBranches: checked === true })}
                aria-label="Include non-default branches"
              />
              Include non-default branches
            </label>
            {hasActiveFilters ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="ml-auto h-7 text-xs"
                onClick={clearFilters}
              >
                <Filter className="mr-1.5 h-3 w-3" aria-hidden />
                Clear filters
              </Button>
            ) : null}
          </div>
        </section>

        {error ? (
          <ErrorState
            title="Could not load the spec catalog"
            description={error}
            onRetry={() => void load()}
          />
        ) : loading && !data ? (
          <LoadingState message="Loading discovered specs…" />
        ) : specs.length === 0 ? (
          <EmptyState
            icon={<FileSearch className="h-6 w-6" aria-hidden />}
            title={hasActiveFilters ? 'No specs match these filters' : 'No specs discovered yet'}
            description={
              hasActiveFilters
                ? 'Widen the search, or clear the filters to see the whole catalog.'
                : 'Register a repository and run a scan; discovered specs land here automatically.'
            }
            action={
              hasActiveFilters ? (
                <Button type="button" variant="outline" size="sm" onClick={clearFilters}>
                  Clear filters
                </Button>
              ) : (
                <Link href="/ade/dashboard/repositories/new">
                  <Button type="button" size="sm">
                    Register a repository
                  </Button>
                </Link>
              )
            }
          />
        ) : (
          <div className={dashboardTableWrapClass} aria-busy={loading}>
            <table className="w-full">
              <thead className={dashboardTableTheadClass}>
                <tr>
                  <th className={dashboardThClass}>Spec</th>
                  <th className={dashboardThClass}>Repository</th>
                  <th className={dashboardThClass}>Format</th>
                  <th className={dashboardThClass}>Project</th>
                  <th className={dashboardThClass}>Status</th>
                  <th className={dashboardThClass}>Size</th>
                  <th className={dashboardThRightClass}>Last activity</th>
                </tr>
              </thead>
              <tbody className={dashboardTbodyClass}>
                {specs.map((spec) => (
                  <SpecCatalogTableRow key={`${spec.id}:${spec.branch}`} spec={spec} />
                ))}
              </tbody>
            </table>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-200 px-6 py-3 dark:border-gray-700">
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Showing {showingFrom.toLocaleString()}–{showingTo.toLocaleString()} of{' '}
                {matchCount.toLocaleString()}
              </p>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  disabled={!canPrev || loading}
                  onClick={() =>
                    setOptions((prev) => ({
                      ...prev,
                      offset: Math.max(0, prev.offset - SPEC_CATALOG_PAGE_SIZE),
                    }))
                  }
                >
                  Prev
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  disabled={!canNext || loading}
                  onClick={() =>
                    setOptions((prev) => ({
                      ...prev,
                      offset: prev.offset + SPEC_CATALOG_PAGE_SIZE,
                    }))
                  }
                >
                  Next
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
