import McpCapabilityDirectoryClient from './McpCapabilityDirectoryClient';

/**
 * Bring in → MCP servers → Capabilities (HIVE-7.9, #5326).
 *
 * Thin server component: every piece of state lives in the client component, matching the other
 * dashboard screens (see `mcp/page.tsx`).
 */
export default function McpCapabilityDirectoryPage() {
  return <McpCapabilityDirectoryClient />;
}
