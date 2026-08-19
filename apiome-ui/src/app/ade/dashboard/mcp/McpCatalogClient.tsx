'use client';

/**
 * Bring in → MCP servers (HIVE-7.7, #5324).
 *
 * Authority: `docs/mockups/sources/mcp-servers.html`, whose **Notes → Keeps (1:1)** list is this
 * ticket's acceptance criteria; DESIGN.md §5.3 (page header), §8 (list page: header → toolbar →
 * content) and §3.1 (status vocabulary).
 *
 * ### What this screen is
 *
 * Every MCP server the workspace has cataloged, grouped by the host that serves it and led by the
 * A–F grade the linter gave its surface. Three things about it were true before this redesign and
 * are still true, because they are why it works:
 *
 *  * **Everything is filtered in the browser.** The browse payload is one read of the whole
 *    catalog; search, the ten facets, the sort and the grouping are all applied here. A catalog of
 *    MCP endpoints is tens of rows, not the ten thousand the spec catalog has to page through, so
 *    the round trip a server-side filter would cost buys nothing.
 *  * **Facet counts come from the *full* catalog**, not from the filtered slice, so every value
 *    stays selectable as filters compose — pick grade A, and grade B is still there with its
 *    count. The panel now prints that rule under the chips rather than leaving a reader to infer
 *    it from a count that did not move.
 *  * **The two strips are two different things.** A saved search stores a *view* and re-runs it
 *    against the catalog as it is now; a collection freezes a *list of endpoints* at the moment it
 *    is created. Both contracts are unchanged, and both panels now say which they are.
 *
 * ### What the redesign changed
 *
 * 1. **The screen drew its own header and its own `<main>`.** A `border-b border-gray-200
 *    bg-white` bar with an `h2`, an indigo `Server` glyph beside it and a two-button cluster, over
 *    a `dashboardMainClass` landmark the shell already draws. It is `Page` + `PageHeader` +
 *    `PageBody` — breadcrumb, one `h1`, one primary action, and the section tabs in the header's
 *    own tab slot.
 * 2. **The toolbar and the two strips were three full-bleed bands** stacked by the page
 *    (`border-b … bg-white dark:bg-gray-800` on each). They are three cards on the canvas, as the
 *    mockup draws them, so the page is a column of panels rather than a stack of bars.
 * 3. **The totals line was three greys and a count.** It is one sentence that names the *active*
 *    set and what it was filtered from — the ticket's first acceptance criterion — with the
 *    ordering's promise beside it, so a reader never has to guess what "first" means.
 * 4. **Loading was a spinner in a box.** DESIGN.md §8: skeletons shaped like the content. The
 *    grid draws three skeleton cards, which is what the mockup shows in its `tools.globex.io`
 *    group.
 * 5. **The no-tenant case fell through to the empty state**, telling a reader with no workspace
 *    to register an MCP server they could not register. It is `GatedState`.
 *
 * The Add-MCP-server flow itself is unchanged: `ImportDialog`'s `mcp` source already carries the
 * mockup's register → discover → done/failed overlay, re-skinned by HIVE-6.4 (#5315). This screen
 * opens it and reloads the catalog when it lands.
 */

import * as React from 'react';
import { Plus, RefreshCw } from 'lucide-react';

import { useAuthSession } from '@lib/auth/session-client';

import PageHeader from '@/app/components/shell/PageHeader';
import { Page, PageBody } from '@/app/components/shell/pageChrome';
import { Button } from '@/app/components/ui/Button';
import { Card } from '@/app/components/ui/Card';
import { EmptyState, GatedState } from '@/app/components/ui/EmptyState';
import { ErrorState } from '@/app/components/ui/ErrorState';
import ImportDialog from '@/app/components/ade/dashboard/ImportDialog';
import {
  mcpBrowseGroupsFromPayload,
  type McpBrowseHostGroup,
} from '@/app/components/ade/dashboard/mcp/mcpBrowseUi';
import {
  MCP_CATALOG_DEFAULT_DENSITY,
  MCP_CATALOG_DEFAULT_SORT,
  MCP_CATALOG_DESCRIPTION,
  MCP_CATALOG_EMPTY_DESC,
  MCP_CATALOG_EMPTY_FILTERS,
  MCP_CATALOG_EMPTY_TITLE,
  MCP_CATALOG_ERROR_FALLBACK,
  MCP_CATALOG_ERROR_TITLE,
  MCP_CATALOG_LOADING,
  MCP_CATALOG_NO_MATCH_DESC,
  MCP_CATALOG_NO_MATCH_TITLE,
  MCP_CATALOG_NO_TENANT,
  MCP_CATALOG_SORT_HINT,
  MCP_CATALOG_TITLE,
  mcpApplyCatalog,
  mcpBuildSeenSnapshot,
  mcpCatalogActiveFilterCount,
  mcpCatalogFacets,
  mcpCatalogTotals,
  mcpCatalogTotalsLine,
  mcpChangedEndpointIds,
  mcpReadDensity,
  mcpReadSeenSnapshot,
  mcpSortGroups,
  mcpWriteDensity,
  mcpWriteSeenSnapshot,
  type McpCatalogDensity,
  type McpCatalogFilters,
  type McpCatalogSortKey,
} from '@/app/components/ade/dashboard/mcp/mcpCatalogUi';
import { McpCatalogCard } from '@/app/components/ade/dashboard/mcp/McpCatalogCard';
import { McpCatalogToolbar } from '@/app/components/ade/dashboard/mcp/McpCatalogToolbar';
import { McpCollectionsPanel } from '@/app/components/ade/dashboard/mcp/McpCollectionsPanel';
import { McpHostSection } from '@/app/components/ade/dashboard/mcp/McpHostSection';
import { McpSavedSearchesPanel } from '@/app/components/ade/dashboard/mcp/McpSavedSearchesPanel';
import { McpSectionTabs } from '@/app/components/ade/dashboard/mcp/McpSectionTabs';
import { mcpVisibleEndpoints } from '@/app/components/ade/dashboard/mcp/mcpCollectionUi';
import { ShadowedNamesPanel } from '@/app/components/ui/mcp/ShadowedNamesPanel';

/** Where the breadcrumb's first crumb goes. */
const HOME_ROUTE = '/ade/dashboard';

/** How many skeleton cards the grid draws while the catalog is in flight. */
const SKELETON_CARDS = 3;

export default function McpCatalogClient() {
  const { data: session } = useAuthSession();
  const sessionUser = session?.user as
    | { user_id?: string; current_tenant_id?: string }
    | undefined;
  const currentTenantId = sessionUser?.current_tenant_id;
  const currentUserId = sessionUser?.user_id;

  const [groups, setGroups] = React.useState<McpBrowseHostGroup[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [importOpen, setImportOpen] = React.useState(false);

  // Catalog controls.
  const [search, setSearch] = React.useState('');
  const [sort, setSort] = React.useState<McpCatalogSortKey>(MCP_CATALOG_DEFAULT_SORT);
  const [density, setDensity] = React.useState<McpCatalogDensity>(MCP_CATALOG_DEFAULT_DENSITY);
  const [filters, setFilters] = React.useState<McpCatalogFilters>(MCP_CATALOG_EMPTY_FILTERS);
  const [changedIds, setChangedIds] = React.useState<Set<string>>(() => new Set());

  // The "last seen" snapshot read once at mount, before this visit overwrites it — so the
  // "changed since last view" markers reflect the *previous* visit even across in-session reloads.
  const seenAtMount = React.useRef<ReturnType<typeof mcpReadSeenSnapshot>>(null);
  const seenLoaded = React.useRef(false);

  // Restore the persisted density preference (and the seen snapshot) on first mount.
  React.useEffect(() => {
    setDensity(mcpReadDensity());
    seenAtMount.current = mcpReadSeenSnapshot();
    seenLoaded.current = true;
  }, []);

  const onDensityChange = React.useCallback((next: McpCatalogDensity) => {
    setDensity(next);
    mcpWriteDensity(next);
  }, []);

  const load = React.useCallback(async () => {
    if (!currentTenantId) {
      setGroups([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/mcp/browse', { credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof data.error === 'string' ? data.error : res.statusText || MCP_CATALOG_ERROR_FALLBACK,
        );
      }
      const parsed = mcpBrowseGroupsFromPayload(data);
      setGroups(parsed);

      // Mark endpoints that versioned since the user last viewed the catalog, then persist a fresh
      // snapshot so the next visit compares against what is on screen now.
      if (seenLoaded.current) {
        setChangedIds(mcpChangedEndpointIds(parsed, seenAtMount.current));
        mcpWriteSeenSnapshot(mcpBuildSeenSnapshot(parsed));
      }
    } catch (e) {
      console.error(e);
      setGroups([]);
      setError(e instanceof Error ? e.message : MCP_CATALOG_ERROR_FALLBACK);
    } finally {
      setLoading(false);
    }
  }, [currentTenantId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Facets reflect the full catalog, so every available value stays selectable as filters compose.
  const facets = React.useMemo(() => mcpCatalogFacets(groups), [groups]);

  // Filter → sort, in that order: filtering trims endpoints/groups, sorting orders what remains.
  const visibleGroups = React.useMemo(
    () => mcpSortGroups(mcpApplyCatalog(groups, filters, search), sort),
    [groups, filters, search, sort],
  );

  const visibleEndpoints = React.useMemo(
    () => mcpVisibleEndpoints(visibleGroups),
    [visibleGroups],
  );

  const totals = React.useMemo(() => mcpCatalogTotals(groups), [groups]);
  const activeFilters = mcpCatalogActiveFilterCount(filters);
  const totalsLine = mcpCatalogTotalsLine(visibleGroups, groups, activeFilters, search);
  const hasAnyEndpoints = totals.endpointCount > 0;

  const clearFilters = React.useCallback(() => {
    setFilters({ ...MCP_CATALOG_EMPTY_FILTERS });
    setSearch('');
  }, []);

  /**
   * What goes under the strips: the host groups, or whichever of the four states applies.
   *
   * Written as one expression rather than four early returns because the page's header, tabs and
   * toolbar are the same in every one of them — only the column below changes.
   */
  const content = (() => {
    if (loading) {
      return (
        <div className="mcp-grid" aria-busy data-testid="mcp-catalog-skeleton">
          {Array.from({ length: SKELETON_CARDS }, (_, index) => (
            <Card key={index} className="mcp-card mcp-card--skeleton" aria-hidden />
          ))}
          <p className="sr-only" role="status">
            {MCP_CATALOG_LOADING}
          </p>
        </div>
      );
    }
    if (error) {
      return (
        <ErrorState
          title={MCP_CATALOG_ERROR_TITLE}
          description={error}
          onRetry={() => void load()}
          data-testid="mcp-catalog-error"
        />
      );
    }
    if (!hasAnyEndpoints) {
      return (
        <EmptyState
          dashed
          surface={false}
          title={MCP_CATALOG_EMPTY_TITLE}
          description={MCP_CATALOG_EMPTY_DESC}
          action={
            <Button onClick={() => setImportOpen(true)} disabled={!currentTenantId}>
              <Plus aria-hidden />
              Add MCP server
            </Button>
          }
          data-testid="mcp-catalog-empty"
        />
      );
    }
    if (visibleGroups.length === 0) {
      return (
        <Card>
          <EmptyState
            variant="inline"
            title={MCP_CATALOG_NO_MATCH_TITLE}
            description={MCP_CATALOG_NO_MATCH_DESC}
            action={
              <Button variant="outline" size="sm" onClick={clearFilters}>
                Clear search and filters
              </Button>
            }
            data-testid="mcp-catalog-no-match"
          />
        </Card>
      );
    }
    return visibleGroups.map((group) => (
      <McpHostSection
        key={group.host}
        host={group.host}
        endpoints={group.endpoints}
        capabilityCount={group.capability_count}
      >
        <div className={density === 'grid' ? 'mcp-grid' : 'mcp-list'}>
          {group.endpoints.map((endpoint) => (
            <McpCatalogCard
              key={endpoint.id}
              endpoint={endpoint}
              href={`/ade/dashboard/mcp/${endpoint.id}`}
              density={density}
              changed={changedIds.has(endpoint.id)}
            />
          ))}
        </div>
      </McpHostSection>
    ));
  })();

  return (
    <Page>
      <PageHeader
        breadcrumb={[
          { label: 'Home', href: HOME_ROUTE },
          { label: 'Bring in' },
          { label: MCP_CATALOG_TITLE },
        ]}
        title={MCP_CATALOG_TITLE}
        description={MCP_CATALOG_DESCRIPTION}
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              onClick={() => void load()}
              title="Reload the catalog"
              data-testid="mcp-catalog-refresh"
            >
              <RefreshCw aria-hidden />
              Refresh
            </Button>
            <Button
              type="button"
              onClick={() => setImportOpen(true)}
              disabled={!currentTenantId}
              title="Add an MCP server to the catalog"
              data-testid="mcp-catalog-add"
            >
              <Plus aria-hidden />
              Add MCP server
            </Button>
          </>
        }
        tabs={
          <McpSectionTabs
            hasServers={hasAnyEndpoints}
            counts={{
              servers: totals.endpointCount,
              capabilities: totals.capabilityCount,
            }}
          />
        }
      />

      <PageBody>
        {!currentTenantId ? (
          <GatedState description={MCP_CATALOG_NO_TENANT} />
        ) : (
          <>
            {hasAnyEndpoints && !error ? (
              <>
                <McpCatalogToolbar
                  search={search}
                  onSearchChange={setSearch}
                  sort={sort}
                  onSortChange={setSort}
                  density={density}
                  onDensityChange={onDensityChange}
                  facets={facets}
                  filters={filters}
                  onFiltersChange={setFilters}
                />

                <div className="mcp-strips">
                  <McpSavedSearchesPanel
                    filters={filters}
                    query={search}
                    sort={sort}
                    onApply={({ filters: nextFilters, query: nextQuery, sort: nextSort }) => {
                      setFilters(nextFilters);
                      setSearch(nextQuery);
                      setSort(nextSort);
                    }}
                  />
                  <McpCollectionsPanel visibleEndpoints={visibleEndpoints} />
                </div>

                <div className="mcp-totals" data-testid="mcp-catalog-totals">
                  <p className="mcp-totals__counts">{totalsLine}</p>
                  <p className="mcp-totals__hint">{MCP_CATALOG_SORT_HINT[sort]}</p>
                </div>

                {/* Compact alert only when collisions exist (CLX-3.4, #4858) — silent when clean. */}
                <ShadowedNamesPanel />
              </>
            ) : null}

            {content}
          </>
        )}
      </PageBody>

      {currentTenantId && currentUserId ? (
        <ImportDialog
          open={importOpen}
          onClose={() => setImportOpen(false)}
          onSuccess={() => void load()}
          tenantId={currentTenantId}
          userId={currentUserId}
          initialSource={importOpen ? 'mcp' : null}
        />
      ) : null}
    </Page>
  );
}
