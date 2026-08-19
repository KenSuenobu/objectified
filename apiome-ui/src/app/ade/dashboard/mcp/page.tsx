import McpCatalogClient from './McpCatalogClient';

/**
 * Bring in → MCP servers (HIVE-7.7, #5324).
 *
 * Thin server component: every piece of state lives in the client component, matching the other
 * dashboard screens (see `repositories/page.tsx`).
 */
export default function McpBrowsePage() {
  return <McpCatalogClient />;
}
