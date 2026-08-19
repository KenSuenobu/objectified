import McpServerCompareClient from './McpServerCompareClient';

/**
 * Bring in → MCP servers → Compare (HIVE-7.9, #5326).
 *
 * Thin server component: every piece of state lives in the client component, matching the other
 * dashboard screens (see `mcp/page.tsx`).
 */
export default function McpServerComparePage() {
  return <McpServerCompareClient />;
}
