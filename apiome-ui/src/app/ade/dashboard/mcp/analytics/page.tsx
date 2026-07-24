'use client';

/**
 * Catalog Analytics dashboard page (V2-MCP-32.1 / MCAT-18.1, #4645).
 *
 * The tenant-wide analytics screen over the whole MCP catalog: it fetches the `insight/catalog`
 * roll-up once, parses it with the pure {@link mcpCatalogInsightFromPayload}, and hands it to the
 * {@link CatalogAnalyticsDashboard} which owns the tile rendering and the loading / error /
 * empty-catalog states. Scope is the session's current tenant (enforced server-side by the proxy),
 * so this only ever reflects the caller's own catalog.
 */

import { useAuthSession } from '@lib/auth/session-client';
import { useCallback, useEffect, useState } from 'react';
import { BarChart3, RefreshCw } from 'lucide-react';
import { Button } from '@/app/components/ui/Button';
import {
  dashboardContentStackClass,
  dashboardMainClass,
} from '@/app/components/ade/dashboard/dashboardScreenClasses';
import { McpSectionTabs } from '@/app/components/ade/dashboard/mcp/McpSectionTabs';
import { CatalogAnalyticsDashboard } from '@/app/components/ui/mcp/CatalogAnalyticsDashboard';
import {
  mcpCatalogInsightFromPayload,
  mcpCatalogIsEmpty,
  type McpCatalogInsight,
} from '@/app/components/ade/dashboard/mcp/mcpCatalogInsightUi';

export default function McpCatalogAnalyticsPage() {
  const { data: session } = useAuthSession();
  const sessionUser = session?.user as { current_tenant_id?: string } | undefined;
  const currentTenantId = sessionUser?.current_tenant_id;

  const [insight, setInsight] = useState<McpCatalogInsight | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
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
      setError(e instanceof Error ? e.message : 'Could not load catalog analytics.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <header className="border-b border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
        <div className="px-6 py-4">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <h2 className="flex items-center gap-2 text-2xl font-bold text-gray-900 dark:text-white">
                <BarChart3 className="h-6 w-6 text-indigo-600 dark:text-indigo-400" aria-hidden />
                Catalog Analytics
              </h2>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                A catalog-wide view of this workspace&apos;s MCP servers — how they break down by
                category, transport, protocol version, grade, and tool count, plus discovery health,
                the most-changed servers, and the most widely exposed capabilities.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <Button
                type="button"
                variant="secondary"
                className="h-auto min-h-10 shrink-0 whitespace-nowrap py-2"
                onClick={() => void load()}
                disabled={!currentTenantId}
                title="Reload catalog analytics"
              >
                <RefreshCw className="h-4 w-4 shrink-0" aria-hidden />
                Refresh
              </Button>
            </div>
          </div>
          <McpSectionTabs
            className="mt-4"
            hasServers={insight != null && !mcpCatalogIsEmpty(insight)}
          />
        </div>
      </header>

      <main className={dashboardMainClass} aria-busy={loading}>
        <div className={dashboardContentStackClass}>
          <div className="px-6 pb-8 pt-4">
            <CatalogAnalyticsDashboard data={insight} loading={loading} error={error} />
          </div>
        </div>
      </main>
    </>
  );
}
