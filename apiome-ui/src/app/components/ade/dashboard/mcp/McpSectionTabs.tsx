'use client';

/**
 * McpSectionTabs — the sub-navigation strip that ties the MCP servers catalog together with its
 * three related views (Analytics, Capabilities, Compare). Unlike `CatalogDetailTabs`/`DetailTabs`,
 * each "tab" here is a distinct route rather than a pane of one page, so selection is driven by
 * `usePathname()` and activation is a real navigation via `next/link`.
 *
 * Tabs stay hidden until the catalog has at least one MCP server — an empty workspace should not
 * surface Analytics / Capabilities / Compare before there is anything to browse.
 *
 * ### What HIVE-7.7 (#5324) changed
 *
 * Authority: `docs/mockups/sources/mcp-servers.html`, whose tab row reads
 * **Servers · Analytics · Capabilities · Compare**.
 *
 * 1. **The four labels were sentences.** "Catalog", "Capability Directory", "Catalog Analytics"
 *    and "Server Comparison" are the names of four *documents*; the mockup names four *views* of
 *    one subject, which is what they are. At the Largest font scale the old four wrapped onto
 *    three lines before a single count could be shown beside them.
 * 2. **No tab carried a count.** The mockup prints `Servers 6` and `Capabilities 65`, so a
 *    reader learns the size of the catalog without opening it. A tab whose figure this screen
 *    does not know draws no chip rather than a zero — the rule `RepositoriesSubNav` set, because
 *    "none" and "not counted" are different facts.
 * 3. **The Preview marker was its own amber box** (`border-amber-200/90 bg-amber-50 …
 *    dark:bg-amber-950/60`). It is `Badge status="preview"`, which the shared vocabulary answers
 *    with `accent` — the tone DESIGN.md §3.1 gives maturity markers. The mockup draws it honey;
 *    honey is reserved for `new` in the same table, and one word cannot be two colours.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { BarChart3, GitCompareArrows, Layers, Server } from 'lucide-react';
import { useAuthSession } from '@lib/auth/session-client';
import { cn } from '@lib/utils';
import { Badge } from '@/app/components/ui/Badge';
import {
  TAB_COUNT_CLASS,
  TAB_GLYPH_CLASS,
  TAB_LIST_CLASS,
  tabTriggerClass,
} from '@/app/components/ui/tabStyles';
import { mcpBrowseGroupsFromPayload } from './mcpBrowseUi';

/** Which figure a tab prints beside its label, when the screen knows it. */
export type McpSectionTabId = 'servers' | 'analytics' | 'capabilities' | 'compare';

interface McpSectionTab {
  id: McpSectionTabId;
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** A maturity marker beside the label, resolved through the shared status vocabulary. */
  status?: string;
  /** Route match beyond exact equality, e.g. the catalog owns its endpoint detail subpaths. */
  matchPrefix?: string;
}

const MCP_SECTION_TABS: readonly McpSectionTab[] = [
  {
    id: 'servers',
    href: '/ade/dashboard/mcp',
    label: 'Servers',
    icon: Server,
    matchPrefix: '/ade/dashboard/mcp/',
  },
  { id: 'analytics', href: '/ade/dashboard/mcp/analytics', label: 'Analytics', icon: BarChart3, status: 'preview' },
  { id: 'capabilities', href: '/ade/dashboard/mcp/capabilities', label: 'Capabilities', icon: Layers },
  { id: 'compare', href: '/ade/dashboard/mcp/compare', label: 'Compare', icon: GitCompareArrows },
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
  counts,
}: {
  className?: string;
  /**
   * When the parent already knows whether the catalog has servers, pass it to skip the internal
   * browse probe (and to keep the tabs in sync with the parent's loaded catalog).
   */
  hasServers?: boolean;
  /**
   * Counts to print beside a tab's label, by tab id. Only the tabs whose figure the caller
   * actually knows are passed; a tab with no entry draws no chip.
   */
  counts?: Partial<Record<McpSectionTabId, number>>;
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
      className={cn(TAB_LIST_CLASS, className)}
      data-testid="mcp-section-tabs"
    >
      {MCP_SECTION_TABS.map((tab) => {
        const Icon = tab.icon;
        const active = isTabActive(tab, pathname);
        const count = counts?.[tab.id];
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            data-testid={`mcp-section-tab-${tab.id}`}
            className={tabTriggerClass({ active })}
          >
            <Icon className={TAB_GLYPH_CLASS} aria-hidden />
            {tab.label}
            {typeof count === 'number' ? (
              <span className={TAB_COUNT_CLASS}>{count.toLocaleString()}</span>
            ) : null}
            {tab.status ? (
              <Badge status={tab.status} title="Feature in preview">
                Preview
              </Badge>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
