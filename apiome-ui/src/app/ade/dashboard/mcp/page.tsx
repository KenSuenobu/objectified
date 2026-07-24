"use client";

import { useAuthSession } from '@lib/auth/session-client';
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, RefreshCw, Server } from "lucide-react";
import ImportDialog from "@/app/components/ade/dashboard/ImportDialog";
import { Badge } from "@/app/components/ui/Badge";
import { Button } from "@/app/components/ui/Button";
import { LoadingState } from "@/app/components/ui/LoadingState";
import { EmptyState } from "@/app/components/ui/EmptyState";
import { ErrorState } from "@/app/components/ui/ErrorState";
import {
  dashboardContentStackClass,
  dashboardMainClass,
  dashboardTableWrapClass,
} from "@/app/components/ade/dashboard/dashboardScreenClasses";
import {
  mcpBrowseGroupsFromPayload,
  type McpBrowseHostGroup,
} from "@/app/components/ade/dashboard/mcp/mcpBrowseUi";
import {
  MCP_CATALOG_DEFAULT_DENSITY,
  MCP_CATALOG_DEFAULT_SORT,
  MCP_CATALOG_EMPTY_FILTERS,
  mcpApplyCatalog,
  mcpBuildSeenSnapshot,
  mcpCatalogFacets,
  mcpChangedEndpointIds,
  mcpGroupHealthRollup,
  mcpReadDensity,
  mcpReadSeenSnapshot,
  mcpSortGroups,
  mcpWriteDensity,
  mcpWriteSeenSnapshot,
  type McpCatalogDensity,
  type McpCatalogFilters,
  type McpCatalogSortKey,
} from "@/app/components/ade/dashboard/mcp/mcpCatalogUi";
import { McpCatalogCard } from "@/app/components/ade/dashboard/mcp/McpCatalogCard";
import { McpSectionTabs } from "@/app/components/ade/dashboard/mcp/McpSectionTabs";
import { McpCatalogToolbar } from "@/app/components/ade/dashboard/mcp/McpCatalogToolbar";
import { McpSavedSearchesPanel } from "@/app/components/ade/dashboard/mcp/McpSavedSearchesPanel";
import { McpCollectionsPanel } from "@/app/components/ade/dashboard/mcp/McpCollectionsPanel";
import { ShadowedNamesPanel } from "@/app/components/ui/mcp/ShadowedNamesPanel";
import { mcpVisibleEndpointIds } from "@/app/components/ade/dashboard/mcp/mcpCollectionUi";

export default function McpBrowsePage() {
  const { data: session } = useAuthSession();
  const sessionUser = session?.user as
    | { user_id?: string; current_tenant_id?: string }
    | undefined;
  const currentTenantId = sessionUser?.current_tenant_id;
  const currentUserId = sessionUser?.user_id;

  const [groups, setGroups] = useState<McpBrowseHostGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  // Catalog controls.
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<McpCatalogSortKey>(MCP_CATALOG_DEFAULT_SORT);
  const [density, setDensity] = useState<McpCatalogDensity>(MCP_CATALOG_DEFAULT_DENSITY);
  const [filters, setFilters] = useState<McpCatalogFilters>(MCP_CATALOG_EMPTY_FILTERS);
  const [changedIds, setChangedIds] = useState<Set<string>>(() => new Set());

  // The "last seen" snapshot read once at mount, before this visit overwrites it — so the
  // "changed since last view" markers reflect the *previous* visit even across in-session reloads.
  const seenAtMount = useRef<ReturnType<typeof mcpReadSeenSnapshot>>(null);
  const seenLoaded = useRef(false);

  // Restore the persisted density preference (and the seen snapshot) on first mount.
  useEffect(() => {
    setDensity(mcpReadDensity());
    seenAtMount.current = mcpReadSeenSnapshot();
    seenLoaded.current = true;
  }, []);

  const onDensityChange = useCallback((next: McpCatalogDensity) => {
    setDensity(next);
    mcpWriteDensity(next);
  }, []);

  const load = useCallback(async () => {
    if (!currentTenantId) {
      setGroups([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/mcp/browse", { credentials: "include" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof data.error === "string" ? data.error : res.statusText,
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
      setError(e instanceof Error ? e.message : "Could not load the MCP catalog.");
    } finally {
      setLoading(false);
    }
  }, [currentTenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Facets reflect the full catalog, so every available value stays selectable as filters compose.
  const facets = useMemo(() => mcpCatalogFacets(groups), [groups]);

  // Filter → sort, in that order: filtering trims endpoints/groups, sorting orders what remains.
  const visibleGroups = useMemo(
    () => mcpSortGroups(mcpApplyCatalog(groups, filters, search), sort),
    [groups, filters, search, sort],
  );

  const visibleEndpointIds = useMemo(
    () => mcpVisibleEndpointIds(visibleGroups),
    [visibleGroups],
  );

  const totals = useMemo(() => {
    const endpointCount = groups.reduce((sum, g) => sum + g.endpoints.length, 0);
    const capabilityCount = groups.reduce((sum, g) => sum + g.capability_count, 0);
    return { hostCount: groups.length, endpointCount, capabilityCount };
  }, [groups]);

  const hasAnyEndpoints = totals.endpointCount > 0;

  return (
    <>
      <header className="border-b border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
        <div className="px-6 py-4">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <h2 className="flex items-center gap-2 text-2xl font-bold text-gray-900 dark:text-white">
                <Server
                  className="h-6 w-6 text-indigo-600 dark:text-indigo-400"
                  aria-hidden
                />
                MCP Catalog
              </h2>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                Browse the MCP servers cataloged in this workspace, grade-led and
                grouped by host. Pick one to inspect its tools, resources, and prompts.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <Button
                type="button"
                variant="secondary"
                className="h-auto min-h-10 shrink-0 whitespace-nowrap py-2"
                onClick={() => void load()}
                title="Reload the catalog"
              >
                <RefreshCw className="h-4 w-4 shrink-0" aria-hidden />
                Refresh
              </Button>
              <Button
                type="button"
                className="h-auto min-h-10 shrink-0 whitespace-nowrap py-2"
                onClick={() => setImportOpen(true)}
                disabled={!currentTenantId}
                title="Add an MCP server to the catalog"
              >
                <Plus className="h-4 w-4 shrink-0" aria-hidden />
                Add MCP server
              </Button>
            </div>
          </div>
          <McpSectionTabs className="mt-4" hasServers={hasAnyEndpoints} />
        </div>
      </header>

      <main className={dashboardMainClass} aria-busy={loading}>
        <div className={dashboardContentStackClass}>
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
              <div className="border-b border-gray-200 bg-white px-6 py-3 dark:border-gray-700 dark:bg-gray-800">
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
              </div>
              <div className="border-b border-gray-200 bg-white px-6 py-3 dark:border-gray-700 dark:bg-gray-800">
                <McpCollectionsPanel selectedEndpointIds={visibleEndpointIds} />
              </div>
              {/* Shadowed / duplicate tool names across the enabled host scope (CLX-3.4, #4858). */}
              <div className="border-b border-gray-200 bg-white px-6 py-3 dark:border-gray-700 dark:bg-gray-800">
                <ShadowedNamesPanel />
              </div>
            </>
          ) : null}

          {hasAnyEndpoints && !error ? (
            <div className="flex flex-wrap items-center gap-2 px-6 text-sm text-gray-500 dark:text-gray-400">
              <span>{totals.hostCount} hosts</span>
              <span aria-hidden>·</span>
              <span>{totals.endpointCount} endpoints</span>
              <span aria-hidden>·</span>
              <span>{totals.capabilityCount} capabilities</span>
            </div>
          ) : null}

          <div className="space-y-6 px-6 pb-8 pt-2">
            {loading ? (
              <div className={dashboardTableWrapClass}>
                <LoadingState
                  minHeightClassName="min-h-[220px]"
                  message="Loading the MCP catalog…"
                />
              </div>
            ) : error ? (
              <ErrorState
                title="Could not load the MCP catalog"
                description={error}
                onRetry={() => void load()}
              />
            ) : !hasAnyEndpoints ? (
              <EmptyState
                className="mt-6"
                icon={<Server className="h-10 w-10 text-white" aria-hidden />}
                title="No MCP endpoints yet"
                description="Register an MCP server in the catalog. Once it is discovered, its endpoints appear here grade-led and grouped by host, with capability counts and quality scores."
              />
            ) : visibleGroups.length === 0 ? (
              <EmptyState
                className="mt-6"
                variant="compact"
                icon={<Server className="h-10 w-10 text-white" aria-hidden />}
                title="No matches"
                description="No endpoints match your search and filters. Try clearing a filter or broadening the search."
              />
            ) : (
              visibleGroups.map((group) => {
                const rollup = mcpGroupHealthRollup(group.endpoints);
                return (
                  <section key={group.host}>
                    <div className="mb-3 flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
                        {group.host}
                      </h3>
                      <Badge variant="secondary">
                        {group.endpoint_count} endpoint
                        {group.endpoint_count === 1 ? "" : "s"}
                      </Badge>
                      <Badge variant="outline">
                        {group.capability_count} capabilities
                      </Badge>
                      {rollup.summary ? (
                        <span className="text-xs text-gray-500 dark:text-gray-400">
                          {rollup.summary}
                        </span>
                      ) : null}
                    </div>

                    {density === "grid" ? (
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                        {group.endpoints.map((ep) => (
                          <McpCatalogCard
                            key={ep.id}
                            endpoint={ep}
                            href={`/ade/dashboard/mcp/${ep.id}`}
                            density="grid"
                            changed={changedIds.has(ep.id)}
                          />
                        ))}
                      </div>
                    ) : (
                      <div
                        className={`${dashboardTableWrapClass} divide-y divide-gray-200 dark:divide-gray-700`}
                      >
                        {group.endpoints.map((ep) => (
                          <McpCatalogCard
                            key={ep.id}
                            endpoint={ep}
                            href={`/ade/dashboard/mcp/${ep.id}`}
                            density="list"
                            changed={changedIds.has(ep.id)}
                          />
                        ))}
                      </div>
                    )}
                  </section>
                );
              })
            )}
          </div>
        </div>
      </main>

      {currentTenantId && currentUserId ? (
        <ImportDialog
          open={importOpen}
          onClose={() => setImportOpen(false)}
          onSuccess={() => void load()}
          tenantId={currentTenantId}
          userId={currentUserId}
          initialSource={importOpen ? "mcp" : null}
        />
      ) : null}
    </>
  );
}
