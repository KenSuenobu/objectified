"use client";

/**
 * Bring in → MCP servers → Compare (V2-MCP-32.2 / MCAT-18.2, #4646; redesigned HIVE-7.9, #5326).
 *
 * Authority: `docs/mockups/sources/mcp-compare.html`, whose **Notes → Keeps (1:1)** list is this
 * ticket's acceptance criteria; DESIGN.md §5.3 (page header) and §5 (no horizontal document
 * scroll).
 *
 * ### What this screen is
 *
 * An evaluator picks 2–3 discovered MCP servers and reads them column-by-column. This page owns
 * only the orchestration: it loads `/api/mcp/browse` for the picker and, when a comparison is run,
 * fetches each selected endpoint's current-version surface (`items`, protocol, grade), its
 * composite `insight/trust` and its `insight/reliability` roll-up, parses each through the existing
 * pure parsers and assembles one {@link McpCompareServer} per column.
 * {@link ServerComparisonPanel} owns all rendering from that bundle, so this file holds no
 * presentation logic beyond the picker.
 *
 * Each of the three per-endpoint reads **degrades independently** — a missing trust profile or an
 * unrecorded reliability roll-up becomes `null` and shows as `—` in its rows rather than sinking
 * the whole comparison. Only a rejected request (a network failure) reaches the error state.
 *
 * ### What the redesign changed
 *
 * 1. **The screen drew its own header and its own `<main>`.** A `border-b border-gray-200 bg-white
 *    dark:bg-gray-800` bar with an `h2` and an indigo glyph, over the `dashboardMainClass`
 *    landmark the shell already draws. It is `Page` + `PageHeader` + `PageBody`, with the section
 *    tabs in the header's own tab slot.
 * 2. **Compare lived only at the bottom of the picker.** The mockup mirrors it as the page's one
 *    primary action, which is what a reader reaches for after ticking three rows near the top of a
 *    long list. Both buttons run the same callback and share the same disabled rule, so they
 *    cannot disagree about whether a comparison is runnable.
 * 3. **The picker was a full-width band above the results**, so a wide comparison table pushed it
 *    off screen entirely. It is a sticky aside beside the results at ≥ 64rem and stacks above
 *    them below that — one column at narrow widths, which is what keeps the document from
 *    scrolling sideways.
 * 4. **The picker rows were `<label>`s wrapping a raw `<input type="checkbox">`** with
 *    `accent-indigo-600` and a `border-indigo-300 bg-indigo-50 dark:bg-indigo-900/20` selected
 *    tint. They are `ui/Checkbox` inside `.mcpx-pick`, whose selected state is an `--accent`
 *    hairline over the surface rather than a fill — `--fg-muted` on `--accent-soft` measures
 *    3.86:1 in Solarized, and each row carries a muted second line.
 * 5. **A row at the cap was `opacity-50` with a disabled input and no explanation.** It keeps the
 *    disabled input and gains the mockup's `title` — "Up to 3 servers" — so the reason is
 *    readable rather than inferable.
 * 6. **The picker's empty case was one grey sentence.** It is an `EmptyState`, and the catalog
 *    read's failure is an `ErrorState` with a retry rather than a dead end.
 * 7. **The no-tenant case fell through to an empty picker.** It is `GatedState`.
 */

import * as React from "react";
import { GitCompareArrows, RefreshCw } from "lucide-react";

import { useAuthSession } from "@lib/auth/session-client";

import PageHeader from "@/app/components/shell/PageHeader";
import { Page, PageBody } from "@/app/components/shell/pageChrome";
import { Button } from "@/app/components/ui/Button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/app/components/ui/Card";
import { Checkbox } from "@/app/components/ui/Checkbox";
import { EmptyState, GatedState } from "@/app/components/ui/EmptyState";
import { ErrorState } from "@/app/components/ui/ErrorState";
import { LoadingState } from "@/app/components/ui/LoadingState";
import { McpSectionTabs } from "@/app/components/ade/dashboard/mcp/McpSectionTabs";
import {
  mcpBrowseGroupsFromPayload,
  mcpVersionDetailFromPayload,
  type McpBrowseEndpoint,
} from "@/app/components/ade/dashboard/mcp/mcpBrowseUi";
import { mcpTrustProfileFromPayload } from "@/app/components/ade/dashboard/mcp/mcpTrustUi";
import { mcpToolReliabilityFromPayload } from "@/app/components/ade/dashboard/mcp/mcpReliabilityUi";
import { ServerComparisonPanel } from "@/app/components/ui/mcp/ServerComparisonPanel";
import {
  MCP_COMPARE_AT_CAP_HINT,
  MCP_COMPARE_CATALOG_ERROR_FALLBACK,
  MCP_COMPARE_CATALOG_ERROR_TITLE,
  MCP_COMPARE_CATALOG_LOADING,
  MCP_COMPARE_DESCRIPTION,
  MCP_COMPARE_ERROR_FALLBACK,
  MCP_COMPARE_MAX_SELECTION,
  MCP_COMPARE_MIN_SELECTION,
  MCP_COMPARE_NO_TENANT,
  MCP_COMPARE_PICKER_EMPTY_DESC,
  MCP_COMPARE_PICKER_EMPTY_TITLE,
  MCP_COMPARE_PICKER_HINT,
  MCP_COMPARE_PICKER_TITLE,
  MCP_COMPARE_TITLE,
  mcpCompareEndpointSubtitle,
  type McpCompareServer,
} from "@/app/components/ade/dashboard/mcp/mcpServerCompareUi";

/** Where the breadcrumb's first crumb goes. */
const HOME_ROUTE = "/ade/dashboard";

/** The catalog the trail passes through. */
const CATALOG_ROUTE = "/ade/dashboard/mcp";

/**
 * Fetch and assemble one column's {@link McpCompareServer} from a catalog endpoint.
 *
 * Pulls the endpoint's current-version surface (for capability items, protocol, grade), its trust
 * profile and its reliability roll-up in parallel; each read degrades to its empty parse
 * (`null` / `[]`) so one missing signal never sinks the whole comparison. Identity, transport,
 * category and auth come from the browse record the picker already holds.
 *
 * @param endpoint The picked catalog endpoint.
 * @returns One comparison column.
 */
async function loadCompareServer(
  endpoint: McpBrowseEndpoint,
): Promise<McpCompareServer> {
  const versionId = endpoint.current_version_id;

  const [versionRes, trustRes, reliabilityRes] = await Promise.all([
    versionId
      ? fetch(`/api/mcp/endpoints/${endpoint.id}/versions/${versionId}`, {
          credentials: "include",
          cache: "no-store",
        })
      : Promise.resolve(null),
    fetch(`/api/mcp/endpoints/${endpoint.id}/insight/trust`, {
      credentials: "include",
      cache: "no-store",
    }),
    fetch(`/api/mcp/endpoints/${endpoint.id}/insight/reliability`, {
      credentials: "include",
      cache: "no-store",
    }),
  ]);

  const versionData =
    versionRes && versionRes.ok
      ? await versionRes.json().catch(() => ({}))
      : null;
  const trustData = trustRes.ok ? await trustRes.json().catch(() => ({})) : {};
  const reliabilityData = reliabilityRes.ok
    ? await reliabilityRes.json().catch(() => ({}))
    : {};

  const version = versionData ? mcpVersionDetailFromPayload(versionData) : null;
  const trust = mcpTrustProfileFromPayload(trustData);
  const reliability = mcpToolReliabilityFromPayload(reliabilityData);

  const displayName =
    version?.server_title?.trim() ||
    version?.server_name?.trim() ||
    endpoint.name ||
    "MCP server";

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

export default function McpServerCompareClient() {
  const { data: session } = useAuthSession();
  const sessionUser = session?.user as
    { current_tenant_id?: string } | undefined;
  const currentTenantId = sessionUser?.current_tenant_id;

  const [endpoints, setEndpoints] = React.useState<McpBrowseEndpoint[]>([]);
  const [hasAnyServers, setHasAnyServers] = React.useState(false);
  const [catalogLoading, setCatalogLoading] = React.useState(true);
  const [catalogError, setCatalogError] = React.useState<string | null>(null);

  const [selected, setSelected] = React.useState<string[]>([]);
  const [servers, setServers] = React.useState<McpCompareServer[] | null>(null);
  const [comparing, setComparing] = React.useState(false);
  const [compareError, setCompareError] = React.useState<string | null>(null);

  // Load the catalog for the picker. Only discovered endpoints (with a current version) can be
  // compared — a never-discovered endpoint has no surface to align.
  const loadCatalog = React.useCallback(async () => {
    if (!currentTenantId) {
      setEndpoints([]);
      setHasAnyServers(false);
      setCatalogLoading(false);
      return;
    }
    setCatalogLoading(true);
    setCatalogError(null);
    try {
      const res = await fetch("/api/mcp/browse", { credentials: "include" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          typeof data.error === "string" ? data.error : res.statusText,
        );
      }
      const groups = mcpBrowseGroupsFromPayload(data);
      setHasAnyServers(groups.some((group) => group.endpoints.length > 0));
      setEndpoints(
        groups
          .flatMap((group) => group.endpoints)
          .filter((endpoint) => !!endpoint.current_version_id)
          .sort((a, b) => a.name.localeCompare(b.name)),
      );
    } catch (e) {
      setEndpoints([]);
      setHasAnyServers(false);
      setCatalogError(
        e instanceof Error ? e.message : MCP_COMPARE_CATALOG_ERROR_FALLBACK,
      );
    } finally {
      setCatalogLoading(false);
    }
  }, [currentTenantId]);

  React.useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const endpointById = React.useMemo(
    () => new Map(endpoints.map((endpoint) => [endpoint.id, endpoint])),
    [endpoints],
  );

  const toggle = React.useCallback((id: string) => {
    setSelected((previous) => {
      if (previous.includes(id))
        return previous.filter((candidate) => candidate !== id);
      if (previous.length >= MCP_COMPARE_MAX_SELECTION) return previous; // cap the selection.
      return [...previous, id];
    });
  }, []);

  const runComparison = React.useCallback(async () => {
    const chosen = selected
      .map((id) => endpointById.get(id))
      .filter((endpoint): endpoint is McpBrowseEndpoint => !!endpoint);
    if (chosen.length < MCP_COMPARE_MIN_SELECTION) return;
    setComparing(true);
    setCompareError(null);
    try {
      setServers(await Promise.all(chosen.map(loadCompareServer)));
    } catch (e) {
      setServers(null);
      setCompareError(
        e instanceof Error ? e.message : MCP_COMPARE_ERROR_FALLBACK,
      );
    } finally {
      setComparing(false);
    }
  }, [selected, endpointById]);

  const canCompare = selected.length >= MCP_COMPARE_MIN_SELECTION && !comparing;

  return (
    <Page>
      <PageHeader
        breadcrumb={[
          { label: "Home", href: HOME_ROUTE },
          { label: "Bring in" },
          { label: "MCP servers", href: CATALOG_ROUTE },
          { label: "Compare" },
        ]}
        title={MCP_COMPARE_TITLE}
        description={MCP_COMPARE_DESCRIPTION}
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              onClick={() => void loadCatalog()}
              disabled={!currentTenantId}
              title="Reload the catalog"
              data-testid="mcp-compare-refresh"
            >
              <RefreshCw aria-hidden />
              Refresh
            </Button>
            <Button
              type="button"
              onClick={() => void runComparison()}
              disabled={!canCompare}
              title="Compare the selected servers"
              data-testid="mcp-compare-run-header"
            >
              <GitCompareArrows aria-hidden />
              Compare
              {selected.length >= MCP_COMPARE_MIN_SELECTION
                ? ` (${selected.length})`
                : ""}
            </Button>
          </>
        }
        tabs={<McpSectionTabs hasServers={hasAnyServers} />}
      />

      <PageBody>
        {!currentTenantId ? (
          <GatedState description={MCP_COMPARE_NO_TENANT} />
        ) : catalogLoading ? (
          <LoadingState
            minHeightClassName="min-h-[160px]"
            message={MCP_COMPARE_CATALOG_LOADING}
          />
        ) : catalogError ? (
          <ErrorState
            title={MCP_COMPARE_CATALOG_ERROR_TITLE}
            description={catalogError}
            onRetry={() => void loadCatalog()}
          />
        ) : (
          <div className="mcpx-layout">
            <aside
              className="mcpx-picker"
              aria-label={MCP_COMPARE_PICKER_TITLE}
            >
              <Card data-testid="mcp-compare-picker">
                <CardHeader className="mcpx-card__head">
                  <CardTitle className="mcpx-card__title">
                    {MCP_COMPARE_PICKER_TITLE}
                  </CardTitle>
                  <span
                    className="mcpx-card__note"
                    data-testid="mcp-compare-selection-count"
                  >
                    {selected.length} of {MCP_COMPARE_MAX_SELECTION} selected
                  </span>
                </CardHeader>
                <CardContent className="mcpx-picker__body">
                  {endpoints.length === 0 ? (
                    <EmptyState
                      variant="compact"
                      tone="neutral"
                      icon={<GitCompareArrows aria-hidden />}
                      title={MCP_COMPARE_PICKER_EMPTY_TITLE}
                      description={MCP_COMPARE_PICKER_EMPTY_DESC}
                      surface={false}
                    />
                  ) : (
                    <ul className="mcpx-picks">
                      {endpoints.map((endpoint) => {
                        const isSelected = selected.includes(endpoint.id);
                        const atCap =
                          !isSelected &&
                          selected.length >= MCP_COMPARE_MAX_SELECTION;
                        const inputId = `mcp-compare-pick-${endpoint.id}`;
                        return (
                          <li key={endpoint.id}>
                            <label
                              htmlFor={inputId}
                              className="mcpx-pick"
                              data-selected={isSelected || undefined}
                              data-at-cap={atCap || undefined}
                              title={
                                atCap ? MCP_COMPARE_AT_CAP_HINT : undefined
                              }
                            >
                              <Checkbox
                                id={inputId}
                                checked={isSelected}
                                disabled={atCap}
                                onCheckedChange={() => toggle(endpoint.id)}
                              />
                              <span className="mcpx-pick__body">
                                <span className="mcpx-pick__name">
                                  {endpoint.name}
                                </span>
                                <span className="mcpx-pick__sub">
                                  {mcpCompareEndpointSubtitle(
                                    endpoint.host,
                                    endpoint.tool_count,
                                  )}
                                </span>
                              </span>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </CardContent>
                <CardFooter className="mcpx-picker__foot">
                  <span>{MCP_COMPARE_PICKER_HINT}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelected([])}
                    disabled={selected.length === 0 || comparing}
                    data-testid="mcp-compare-clear"
                  >
                    Clear
                  </Button>
                </CardFooter>
              </Card>
            </aside>

            <div className="mcpx-results">
              <ServerComparisonPanel
                servers={servers}
                loading={comparing}
                error={compareError}
                onRetry={() => void runComparison()}
              />
            </div>
          </div>
        )}
      </PageBody>
    </Page>
  );
}
