'use client';

/**
 * One host's group of MCP endpoints (HIVE-7.7, #5324).
 *
 * Authority: `docs/mockups/sources/mcp-servers.html` — the `.host-head` row and the grid or
 * dense list under it. The **Notes → Keeps (1:1)** list fixes what the head carries: the host
 * name, "n endpoint(s)", "n capabilities" and the health rollup.
 *
 * ### Why the head is a heading and the group is a section
 *
 * The catalog is a list of lists, and before this the host was a bare `h3` in a `div` with two
 * badges beside it. Reading it as "three hosts, and here is what is under each" needed the
 * pointer. A `<section>` labelled by its own heading puts the same structure in the accessibility
 * tree, so a screen-reader user can move host to host instead of card to card — which is the one
 * navigation this screen is actually for.
 *
 * ### The glyph
 *
 * A remote host takes the server glyph on an accent `.tnt-icon-tile`; a local `(local)` host
 * takes the terminal glyph on the tile's own neutral default, as the mockup draws it — the
 * difference between "somewhere on the network" and "a command on this machine" is the first
 * thing a reader wants from the row. Both are decorative: the host name says which is which.
 */

import * as React from 'react';
import { Server, Terminal } from 'lucide-react';
import { Badge } from '../../../ui/Badge';
import { mcpGroupHealthRollup } from './mcpCatalogUi';
import type { McpBrowseEndpoint } from './mcpBrowseUi';

/** The host string the browse payload uses for stdio servers, which have no network host. */
export const MCP_LOCAL_HOST = '(local)';

export interface McpHostSectionProps {
  /** The host this group belongs to. */
  host: string;
  /** Its endpoints, already filtered and sorted by the page. */
  endpoints: McpBrowseEndpoint[];
  /** Capabilities across the group, as the payload counts them. */
  capabilityCount: number;
  /** The cards or rows themselves. */
  children: React.ReactNode;
}

/**
 * Render one host group.
 *
 * @param props See {@link McpHostSectionProps}.
 * @returns A labelled section: the host head, then the endpoints.
 */
export function McpHostSection({
  host,
  endpoints,
  capabilityCount,
  children,
}: McpHostSectionProps): React.ReactElement {
  const headingId = `mcp-host-${host.replace(/[^a-zA-Z0-9]+/g, '-')}`;
  const rollup = mcpGroupHealthRollup(endpoints);
  const isLocal = host === MCP_LOCAL_HOST;
  const Glyph = isLocal ? Terminal : Server;

  return (
    <section aria-labelledby={headingId} data-testid={`mcp-host-${host}`}>
      <div className="mcp-host">
        <span
          className="tnt-icon-tile mcp-host__tile"
          data-tone={isLocal ? undefined : 'accent'}
          aria-hidden
        >
          <Glyph />
        </span>
        <h3 id={headingId} className="mcp-host__name">
          {host}
        </h3>
        <Badge variant="neutral">
          {endpoints.length} endpoint{endpoints.length === 1 ? '' : 's'}
        </Badge>
        <Badge variant="outline">{capabilityCount} capabilities</Badge>
        {rollup.summary ? <span className="mcp-host__health">{rollup.summary}</span> : null}
      </div>
      {children}
    </section>
  );
}
