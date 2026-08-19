'use client';

/**
 * Bring in → MCP servers → Analytics (V2-MCP-32.1 / MCAT-18.1, #4645; redesigned HIVE-7.9, #5326).
 *
 * Authority: `docs/mockups/sources/mcp-analytics.html`, whose **Notes → Keeps (1:1)** list is this
 * ticket's acceptance criteria; DESIGN.md §5.3 (page header) and §8 (list page: header → content).
 *
 * ### What this screen is
 *
 * One read of `insight/catalog` — a tenant-wide roll-up of every MCP server the workspace has
 * cataloged — parsed by the pure {@link mcpCatalogInsightFromPayload} and handed whole to
 * {@link CatalogAnalyticsDashboard}, which owns the tiles and the three states they can be in.
 * Scope is the session's current tenant, enforced server-side by the proxy, so this only ever
 * reflects the caller's own catalog.
 *
 * ### What the redesign changed
 *
 * 1. **The screen drew its own header and its own `<main>`.** A `border-b border-gray-200 bg-white
 *    dark:bg-gray-800` bar with an `h2`, an indigo `BarChart3` glyph beside it and a lone Refresh
 *    button, over a `dashboardMainClass` landmark the shell already draws. It is `Page` +
 *    `PageHeader` + `PageBody` — breadcrumb, one `h1`, the Preview marker as a badge beside the
 *    title rather than inside it, and the section tabs in the header's own tab slot.
 * 2. **Refresh was the only action.** The mockup adds **Export CSV** as the screen's one primary,
 *    which is the convenience a dashboard whose whole content is figures actually wants. It is
 *    built from the same parsed roll-up the tiles render ({@link mcpCatalogInsightCsv}), so the
 *    sheet and the screen cannot disagree, and it is disabled until there is something to export.
 * 3. **The error state could not be retried.** It printed the message and stopped; the mockup
 *    draws a Retry beside it, which is now wired straight back to the same read.
 * 4. **The no-tenant case fell through to the empty catalog state**, telling a reader with no
 *    workspace to register MCP servers they had nowhere to register. It is `GatedState`.
 * 5. **The tabs were told the catalog was non-empty only after the read.** They still are — but
 *    the endpoint and capability counts the mockup prints beside *Servers* and *Capabilities* come
 *    from this same roll-up, so the strip no longer has to probe `/api/mcp/browse` a second time
 *    to decide whether to render at all.
 */

import * as React from 'react';
import { Download, RefreshCw } from 'lucide-react';

import { useAuthSession } from '@lib/auth/session-client';

import PageHeader from '@/app/components/shell/PageHeader';
import { Page, PageBody } from '@/app/components/shell/pageChrome';
import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import { GatedState } from '@/app/components/ui/EmptyState';
import { McpSectionTabs } from '@/app/components/ade/dashboard/mcp/McpSectionTabs';
import { CatalogAnalyticsDashboard } from '@/app/components/ui/mcp/CatalogAnalyticsDashboard';
import {
  MCP_ANALYTICS_CSV_FILENAME,
  MCP_ANALYTICS_DESCRIPTION,
  MCP_ANALYTICS_ERROR_FALLBACK,
  MCP_ANALYTICS_NO_TENANT,
  MCP_ANALYTICS_TITLE,
  mcpCatalogInsightCsv,
  mcpCatalogInsightFromPayload,
  mcpCatalogIsEmpty,
  type McpCatalogInsight,
} from '@/app/components/ade/dashboard/mcp/mcpCatalogInsightUi';

/** Where the breadcrumb's first crumb goes. */
const HOME_ROUTE = '/ade/dashboard';

/** The catalog the trail passes through. */
const CATALOG_ROUTE = '/ade/dashboard/mcp';

/**
 * Hand the reader a file without leaving the page.
 *
 * A blob URL and a synthetic click, revoked immediately afterwards: the CSV is assembled from
 * state this component already holds, so there is nothing for a server round trip to add, and an
 * un-revoked object URL pins its blob for the lifetime of the document.
 *
 * @param filename What the file is offered as.
 * @param text The document body.
 */
function downloadTextFile(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export default function McpCatalogAnalyticsClient() {
  const { data: session } = useAuthSession();
  const sessionUser = session?.user as { current_tenant_id?: string } | undefined;
  const currentTenantId = sessionUser?.current_tenant_id;

  const [insight, setInsight] = React.useState<McpCatalogInsight | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/mcp/insight/catalog', {
        credentials: 'include',
        cache: 'no-store',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(typeof data.error === 'string' ? data.error : res.statusText);
      }
      setInsight(mcpCatalogInsightFromPayload(data));
    } catch (e) {
      setInsight(null);
      setError(e instanceof Error ? e.message : MCP_ANALYTICS_ERROR_FALLBACK);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const hasServers = insight !== null && !mcpCatalogIsEmpty(insight);

  const exportCsv = React.useCallback(() => {
    if (!insight) return;
    downloadTextFile(MCP_ANALYTICS_CSV_FILENAME, mcpCatalogInsightCsv(insight));
  }, [insight]);

  return (
    <Page>
      <PageHeader
        breadcrumb={[
          { label: 'Home', href: HOME_ROUTE },
          { label: 'Bring in' },
          { label: 'MCP servers', href: CATALOG_ROUTE },
          { label: 'Analytics' },
        ]}
        title={MCP_ANALYTICS_TITLE}
        badge={
          <Badge status="preview" size="lg" title="Feature in preview">
            Preview
          </Badge>
        }
        description={MCP_ANALYTICS_DESCRIPTION}
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              onClick={() => void load()}
              disabled={!currentTenantId}
              title="Reload catalog analytics"
              data-testid="mcp-analytics-refresh"
            >
              <RefreshCw aria-hidden />
              Refresh
            </Button>
            <Button
              type="button"
              onClick={exportCsv}
              disabled={!hasServers}
              title="Download this dashboard as CSV"
              data-testid="mcp-analytics-export"
            >
              <Download aria-hidden />
              Export CSV
            </Button>
          </>
        }
        tabs={
          <McpSectionTabs
            hasServers={hasServers}
            counts={
              insight
                ? {
                    servers: insight.endpointCount,
                    capabilities: insight.typeCounts.total,
                  }
                : undefined
            }
          />
        }
      />

      <PageBody>
        {!currentTenantId ? (
          <GatedState description={MCP_ANALYTICS_NO_TENANT} />
        ) : (
          <CatalogAnalyticsDashboard
            data={insight}
            loading={loading}
            error={error}
            onRetry={() => void load()}
          />
        )}
      </PageBody>
    </Page>
  );
}
