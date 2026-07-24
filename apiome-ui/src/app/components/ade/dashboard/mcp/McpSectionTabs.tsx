'use client';

/**
 * McpSectionTabs — the sub-navigation strip that ties the MCP Servers catalog together with its
 * three related views (Capability Directory, Catalog Analytics, Server Comparison). Unlike
 * `CatalogDetailTabs`/`DetailTabs`, each "tab" here is a distinct route rather than a pane of one
 * page, so selection is driven by `usePathname()` and activation is a real navigation via `next/link`.
 *
 * Tabs stay hidden until the catalog has at least one MCP server — an empty workspace should not
 * surface Capability Directory / Analytics / Comparison before there is anything to browse.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { BarChart3, GitCompareArrows, Layers, Server } from 'lucide-react';
import { useAuthSession } from '@lib/auth/session-client';
import { cn } from '@lib/utils';
import { mcpBrowseGroupsFromPayload } from './mcpBrowseUi';

interface McpSectionTab {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  pill?: string;
  /** Route match beyond exact equality, e.g. the catalog owns its endpoint detail subpaths. */
  matchPrefix?: string;
}

const MCP_SECTION_TABS: readonly McpSectionTab[] = [
  { href: '/ade/dashboard/mcp', label: 'Catalog', icon: Server, matchPrefix: '/ade/dashboard/mcp/' },
  { href: '/ade/dashboard/mcp/capabilities', label: 'Capability Directory', icon: Layers },
  { href: '/ade/dashboard/mcp/analytics', label: 'Catalog Analytics', icon: BarChart3, pill: 'Preview' },
  { href: '/ade/dashboard/mcp/compare', label: 'Server Comparison', icon: GitCompareArrows },
];

/** The other three tabs' paths, so the catalog tab's prefix match can exclude their subpaths. */
const OTHER_TAB_PATHS = new Set(
  MCP_SECTION_TABS.filter((tab) => tab.href !== '/ade/dashboard/mcp').map((tab) => tab.href),
);

function isTabActive(tab: McpSectionTab, pathname: string): boolean {
  if (pathname === tab.href) return true;
  if (tab.href === '/ade/dashboard/mcp' && tab.matchPrefix) {
    return pathname.startsWith(tab.matchPrefix) && !OTHER_TAB_PATHS.has(pathname);
  }
  return false;
}

function catalogHasServers(payload: unknown): boolean {
  return mcpBrowseGroupsFromPayload(payload).some((group) => group.endpoints.length > 0);
}

export function McpSectionTabs({
  className,
  hasServers: hasServersProp,
}: {
  className?: string;
  /**
   * When the parent already knows whether the catalog has servers, pass it to skip the internal
   * browse probe (and to keep the tabs in sync with the parent's loaded catalog).
   */
  hasServers?: boolean;
}) {
  const pathname = usePathname();
  const { data: session } = useAuthSession();
  const currentTenantId = (session?.user as { current_tenant_id?: string } | undefined)
    ?.current_tenant_id;

  const [probedHasServers, setProbedHasServers] = useState(false);
  const shouldProbe = hasServersProp === undefined;

  useEffect(() => {
    if (!shouldProbe || !currentTenantId) return;

    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/mcp/browse', { credentials: 'include' });
        if (!res.ok) {
          if (!cancelled) setProbedHasServers(false);
          return;
        }
        const data = await res.json().catch(() => ({}));
        if (!cancelled) setProbedHasServers(catalogHasServers(data));
      } catch {
        if (!cancelled) setProbedHasServers(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [shouldProbe, currentTenantId]);

  const hasServers =
    hasServersProp !== undefined
      ? hasServersProp
      : Boolean(currentTenantId) && probedHasServers;
  if (!hasServers) return null;

  return (
    <nav
      aria-label="MCP Servers sections"
      className={cn('flex flex-wrap gap-1 border-b border-gray-200 dark:border-gray-700', className)}
    >
      {MCP_SECTION_TABS.map((tab) => {
        const Icon = tab.icon;
        const active = isTabActive(tab, pathname);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex items-center gap-1.5 rounded-t-md border-b-2 -mb-px px-3.5 py-2.5 text-sm font-medium transition-colors',
              active
                ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400'
                : 'border-transparent text-gray-600 hover:border-gray-300 hover:text-gray-900 dark:text-gray-400 dark:hover:border-gray-600 dark:hover:text-gray-200',
            )}
          >
            <Icon className="h-4 w-4 shrink-0" aria-hidden />
            {tab.label}
            {tab.pill ? (
              <span
                className="inline-flex shrink-0 items-center rounded-md border border-amber-200/90 bg-amber-50 px-1.5 py-0.5 text-[0.625rem] font-semibold uppercase tracking-wide text-amber-900 dark:border-amber-700/80 dark:bg-amber-950/60 dark:text-amber-100"
                title="Feature in preview"
              >
                {tab.pill}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
