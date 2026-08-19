import McpCatalogAnalyticsClient from './McpCatalogAnalyticsClient';

/**
 * Bring in → MCP servers → Analytics (HIVE-7.9, #5326).
 *
 * Thin server component: every piece of state lives in the client component, matching the other
 * dashboard screens (see `mcp/page.tsx`).
 */
export default function McpCatalogAnalyticsPage() {
  return <McpCatalogAnalyticsClient />;
}
