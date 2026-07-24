'use client';

/**
 * Side-by-side server comparison page (V2-MCP-32.2 / MCAT-18.2, #4646).
 *
 * The evaluator picks 2–3 discovered MCP servers from the catalog and compares them column-by-column.
 * This page owns only the orchestration: it loads the browse catalog for the picker, and — when the
 * user runs a comparison — fetches each selected endpoint's current-version surface (`items`,
 * protocol, grade), its composite `insight/trust`, and its `insight/reliability` roll-up, parses each
 * through the existing pure parsers, and assembles one {@link McpCompareServer} per column. The
 * {@link ServerComparisonPanel} owns all rendering (the aligned metrics, the tool overlap, the
 * protocol cross-check) from the pure {@link McpCompareServer} bundle, so this page holds no
 * presentation logic. Scope is the session's current tenant (enforced server-side by the proxy).
 */

import { useAuthSession } from '@lib/auth/session-client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { GitCompareArrows, RefreshCw } from 'lucide-react';
import { Button } from '@/app/components/ui/Button';
import { LoadingState } from '@/app/components/ui/LoadingState';
import { ErrorState } from '@/app/components/ui/ErrorState';
import {
  dashboardContentStackClass,
  dashboardMainClass,
} from '@/app/components/ade/dashboard/dashboardScreenClasses';
import { McpSectionTabs } from '@/app/components/ade/dashboard/mcp/McpSectionTabs';
import {
  mcpBrowseGroupsFromPayload,
  mcpVersionDetailFromPayload,
  type McpBrowseEndpoint,
} from '@/app/components/ade/dashboard/mcp/mcpBrowseUi';
import { mcpTrustProfileFromPayload } from '@/app/components/ade/dashboard/mcp/mcpTrustUi';
import { mcpToolReliabilityFromPayload } from '@/app/components/ade/dashboard/mcp/mcpReliabilityUi';
import { ServerComparisonPanel } from '@/app/components/ui/mcp/ServerComparisonPanel';
import type { McpCompareServer } from '@/app/components/ade/dashboard/mcp/mcpServerCompareUi';

/** How many servers may be compared at once (the roadmap's 2–3). */
const MAX_SELECTION = 3;
const MIN_SELECTION = 2;

/**
 * Fetch and assemble one column's {@link McpCompareServer} from a catalog endpoint. Pulls the
 * endpoint's current-version surface (for capability items, protocol, grade), its trust profile, and
 * its reliability roll-up in parallel; each read degrades to its empty parse (`null` / `[]`) so one
 * missing signal never sinks the whole comparison. Identity/transport/category/auth come from the
 * browse record the picker already holds.
 */
async function loadCompareServer(endpoint: McpBrowseEndpoint): Promise<McpCompareServer> {
  const versionId = endpoint.current_version_id;

  const [versionRes, trustRes, reliabilityRes] = await Promise.all([
    versionId
      ? fetch(`/api/mcp/endpoints/${endpoint.id}/versions/${versionId}`, {
          credentials: 'include',
          cache: 'no-store',
        })
      : Promise.resolve(null),
    fetch(`/api/mcp/endpoints/${endpoint.id}/insight/trust`, {
      credentials: 'include',
      cache: 'no-store',
    }),
    fetch(`/api/mcp/endpoints/${endpoint.id}/insight/reliability`, {
      credentials: 'include',
      cache: 'no-store',
    }),
  ]);

  const versionData = versionRes && versionRes.ok ? await versionRes.json().catch(() => ({})) : null;
  const trustData = trustRes.ok ? await trustRes.json().catch(() => ({})) : {};
  const reliabilityData = reliabilityRes.ok ? await reliabilityRes.json().catch(() => ({})) : {};

  const version = versionData ? mcpVersionDetailFromPayload(versionData) : null;
  const trust = mcpTrustProfileFromPayload(trustData);
  const reliability = mcpToolReliabilityFromPayload(reliabilityData);

  const displayName =
    version?.server_title?.trim() ||
    version?.server_name?.trim() ||
    endpoint.name ||
    'MCP server';

  return {
    endpointId: endpoint.id,
    endpointName: endpoint.name,
    displayName,
    transport: endpoint.transport || null,
    category: endpoint.category,
    protocolVersion: version?.protocol_version ?? null,
    grade: version?.grade ?? endpoint.grade,
    score: version?.score ?? endpoint.score,
    authType: endpoint.auth_scheme,
    items: version?.items ?? [],
    trust,
    reliability,
  };
}

export default function McpServerComparePage() {
  const { data: session } = useAuthSession();
  const sessionUser = session?.user as { current_tenant_id?: string } | undefined;
  const currentTenantId = sessionUser?.current_tenant_id;

  const [endpoints, setEndpoints] = useState<McpBrowseEndpoint[]>([]);
  const [hasAnyServers, setHasAnyServers] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  const [selected, setSelected] = useState<string[]>([]);
  const [servers, setServers] = useState<McpCompareServer[] | null>(null);
  const [comparing, setComparing] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);

  // Load the catalog for the picker. Only discovered endpoints (with a current version) can be
  // compared — a never-discovered endpoint has no surface to align.
  const loadCatalog = useCallback(async () => {
    if (!currentTenantId) {
      setEndpoints([]);
      setHasAnyServers(false);
      setCatalogLoading(false);
      return;
    }
    setCatalogLoading(true);
    setCatalogError(null);
    try {
      const res = await fetch('/api/mcp/browse', { credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(typeof data.error === 'string' ? data.error : res.statusText);
      }
      const groups = mcpBrowseGroupsFromPayload(data);
      setHasAnyServers(groups.some((g) => g.endpoints.length > 0));
      const flat = groups
        .flatMap((g) => g.endpoints)
        .filter((e) => !!e.current_version_id)
        .sort((a, b) => a.name.localeCompare(b.name));
      setEndpoints(flat);
    } catch (e) {
      setEndpoints([]);
      setHasAnyServers(false);
      setCatalogError(e instanceof Error ? e.message : 'Could not load the MCP catalog.');
    } finally {
      setCatalogLoading(false);
    }
  }, [currentTenantId]);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const endpointById = useMemo(
    () => new Map(endpoints.map((e) => [e.id, e])),
    [endpoints],
  );

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= MAX_SELECTION) return prev; // cap the selection at three.
      return [...prev, id];
    });
  }, []);

  const runComparison = useCallback(async () => {
    const chosen = selected
      .map((id) => endpointById.get(id))
      .filter((e): e is McpBrowseEndpoint => !!e);
    if (chosen.length < MIN_SELECTION) return;
    setComparing(true);
    setCompareError(null);
    try {
      const built = await Promise.all(chosen.map(loadCompareServer));
      setServers(built);
    } catch (e) {
      setServers(null);
      setCompareError(e instanceof Error ? e.message : 'Could not compare the selected servers.');
    } finally {
      setComparing(false);
    }
  }, [selected, endpointById]);

  const canCompare = selected.length >= MIN_SELECTION && !comparing;

  return (
    <>
      <header className="border-b border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
        <div className="px-6 py-4">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <h2 className="flex items-center gap-2 text-2xl font-bold text-gray-900 dark:text-white">
                <GitCompareArrows className="h-6 w-6 text-indigo-600 dark:text-indigo-400" aria-hidden />
                Server Comparison
              </h2>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                Pick 2–3 discovered MCP servers and compare them side by side — surface counts, grade,
                safety posture, documentation coverage, tool latency, and composite trust — with the
                tools they share and the tools unique to each.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <Button
                type="button"
                variant="secondary"
                className="h-auto min-h-10 shrink-0 whitespace-nowrap py-2"
                onClick={() => void loadCatalog()}
                disabled={!currentTenantId}
                title="Reload the catalog"
              >
                <RefreshCw className="h-4 w-4 shrink-0" aria-hidden />
                Refresh
              </Button>
            </div>
          </div>
          <McpSectionTabs className="mt-4" hasServers={hasAnyServers} />
        </div>
      </header>

      <main className={dashboardMainClass} aria-busy={catalogLoading || comparing}>
        <div className={dashboardContentStackClass}>
          <div className="space-y-5 px-6 pb-8 pt-4">
            {/* Picker. */}
            {catalogLoading ? (
              <LoadingState minHeightClassName="min-h-[160px]" message="Loading the MCP catalog…" />
            ) : catalogError ? (
              <ErrorState
                title="Could not load the MCP catalog"
                description={catalogError}
                onRetry={() => void loadCatalog()}
              />
            ) : (
              <section className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">
                    Choose servers to compare
                  </h3>
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    {selected.length} of {MAX_SELECTION} selected
                  </span>
                </div>
                {endpoints.length === 0 ? (
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    No discovered MCP servers to compare yet. Register and discover servers in the
                    catalog first.
                  </p>
                ) : (
                  <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
                    {endpoints.map((endpoint) => {
                      const isSelected = selected.includes(endpoint.id);
                      const atCap = !isSelected && selected.length >= MAX_SELECTION;
                      return (
                        <label
                          key={endpoint.id}
                          className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm transition-colors ${
                            isSelected
                              ? 'border-indigo-300 bg-indigo-50 dark:border-indigo-700 dark:bg-indigo-900/20'
                              : 'border-gray-100 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800/60'
                          } ${atCap ? 'cursor-not-allowed opacity-50' : ''}`}
                        >
                          <input
                            type="checkbox"
                            className="h-4 w-4 shrink-0 accent-indigo-600"
                            checked={isSelected}
                            disabled={atCap}
                            onChange={() => toggle(endpoint.id)}
                          />
                          <span className="min-w-0 flex-1 truncate font-medium text-gray-800 dark:text-gray-100">
                            {endpoint.name}
                          </span>
                          <span className="shrink-0 text-xs text-gray-400 dark:text-gray-500">
                            {endpoint.host}
                          </span>
                          <span className="shrink-0 tabular-nums text-xs text-gray-500 dark:text-gray-400">
                            {endpoint.tool_count} tool{endpoint.tool_count === 1 ? '' : 's'}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
                <div className="mt-4 flex items-center gap-3">
                  <Button type="button" onClick={() => void runComparison()} disabled={!canCompare}>
                    <GitCompareArrows className="h-4 w-4 shrink-0" aria-hidden />
                    Compare {selected.length >= MIN_SELECTION ? `(${selected.length})` : ''}
                  </Button>
                  {selected.length > 0 ? (
                    <Button type="button" variant="ghost" onClick={() => setSelected([])} disabled={comparing}>
                      Clear
                    </Button>
                  ) : null}
                  {selected.length < MIN_SELECTION ? (
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      Select at least two servers.
                    </span>
                  ) : null}
                </div>
              </section>
            )}

            {/* Comparison. */}
            <ServerComparisonPanel servers={servers} loading={comparing} error={compareError} />
          </div>
        </div>
      </main>
    </>
  );
}
