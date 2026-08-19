/**
 * Capability directory — types and pure helpers (V2-MCP-35.4 / MCAT-21.4, #4663).
 *
 * The **Capability Directory** page lists every tool/resource/prompt across the tenant catalog with
 * owning-server links. This module holds wire types and adapters kept free of React for unit tests.
 */

import type { McpBadgeVariant } from './mcpBrowseUi';

export type McpCapabilityDirectoryKind = 'tool' | 'resource' | 'resource_template' | 'prompt';

export type McpCapabilityDirectorySort = 'server' | 'name' | 'type';

export type McpCapabilityDirectorySortDirection = 'asc' | 'desc';

export interface McpCapabilityDirectoryEntry {
  kind: McpCapabilityDirectoryKind;
  itemId: string;
  itemName: string;
  itemTitle: string | null;
  description: string | null;
  endpointId: string;
  endpointName: string;
  endpointSlug: string;
  host: string;
  endpointUrl: string;
  category: string | null;
  visibility: string;
  currentVersionId: string | null;
  score: number | null;
  grade: string | null;
}

export interface McpCapabilityDirectoryFilters {
  name: string;
  type: McpCapabilityDirectoryKind | '';
  endpointId: string;
  host: string;
  visibility: '' | 'private' | 'public';
}

export interface McpCapabilityDirectoryPage {
  items: McpCapabilityDirectoryEntry[];
  total: number;
  limit: number;
  offset: number;
}

export const MCP_CAPABILITY_DIRECTORY_DEFAULT_FILTERS: McpCapabilityDirectoryFilters = {
  name: '',
  type: '',
  endpointId: '',
  host: '',
  visibility: '',
};

export const MCP_CAPABILITY_DIRECTORY_PAGE_SIZE = 50;

export const MCP_CAPABILITY_DIRECTORY_KINDS: McpCapabilityDirectoryKind[] = [
  'tool',
  'resource',
  'resource_template',
  'prompt',
];

export const MCP_CAPABILITY_DIRECTORY_SORTS: Array<{
  key: McpCapabilityDirectorySort;
  label: string;
}> = [
  { key: 'server', label: 'Server' },
  { key: 'name', label: 'Name' },
  { key: 'type', label: 'Type' },
];

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asKind(value: unknown): McpCapabilityDirectoryKind | null {
  if (
    value === 'tool' ||
    value === 'resource' ||
    value === 'resource_template' ||
    value === 'prompt'
  ) {
    return value;
  }
  return null;
}

export function mcpCapabilityDirectoryEntryFromPayload(
  raw: unknown,
): McpCapabilityDirectoryEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const kind = asKind(r.kind);
  const itemId = asString(r.itemId) ?? asString(r.item_id);
  const itemName = asString(r.itemName) ?? asString(r.item_name);
  const endpointId = asString(r.endpointId) ?? asString(r.endpoint_id);
  const endpointName = asString(r.endpointName) ?? asString(r.endpoint_name);
  const endpointSlug = asString(r.endpointSlug) ?? asString(r.endpoint_slug);
  const host = asString(r.host);
  const endpointUrl = asString(r.endpointUrl) ?? asString(r.endpoint_url);
  if (!kind || !itemId || !itemName || !endpointId || !endpointName || !endpointSlug || !host || !endpointUrl) {
    return null;
  }
  return {
    kind,
    itemId,
    itemName,
    itemTitle: asString(r.itemTitle) ?? asString(r.item_title),
    description: asString(r.description),
    endpointId,
    endpointName,
    endpointSlug,
    host,
    endpointUrl,
    category: asString(r.category),
    visibility: asString(r.visibility) ?? 'private',
    currentVersionId: asString(r.currentVersionId) ?? asString(r.current_version_id),
    score: asNumber(r.score),
    grade: asString(r.grade),
  };
}

export function mcpCapabilityDirectoryFromPayload(payload: unknown): McpCapabilityDirectoryPage {
  const empty: McpCapabilityDirectoryPage = {
    items: [],
    total: 0,
    limit: MCP_CAPABILITY_DIRECTORY_PAGE_SIZE,
    offset: 0,
  };
  if (!payload || typeof payload !== 'object') return empty;
  const p = payload as Record<string, unknown>;
  const rawItems = Array.isArray(p.items) ? p.items : [];
  const items = rawItems
    .map((row) => mcpCapabilityDirectoryEntryFromPayload(row))
    .filter((row): row is McpCapabilityDirectoryEntry => row !== null);
  return {
    items,
    total: asNumber(p.total) ?? items.length,
    limit: asNumber(p.limit) ?? MCP_CAPABILITY_DIRECTORY_PAGE_SIZE,
    offset: asNumber(p.offset) ?? 0,
  };
}

export function mcpCapabilityDirectoryQueryParams(
  filters: McpCapabilityDirectoryFilters,
  sort: McpCapabilityDirectorySort,
  direction: McpCapabilityDirectorySortDirection,
  offset: number,
  limit = MCP_CAPABILITY_DIRECTORY_PAGE_SIZE,
): URLSearchParams {
  const params = new URLSearchParams();
  params.set('sort', sort);
  params.set('direction', direction);
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  const name = filters.name.trim();
  if (name) params.set('name', name);
  if (filters.type) params.set('type', filters.type);
  const endpointId = filters.endpointId.trim();
  if (endpointId) params.set('endpoint_id', endpointId);
  const host = filters.host.trim();
  if (host) params.set('host', host);
  if (filters.visibility) params.set('visibility', filters.visibility);
  return params;
}

export function mcpCapabilityDirectoryEndpointHref(endpointId: string): string {
  return `/ade/dashboard/mcp/${encodeURIComponent(endpointId)}`;
}

export function mcpCapabilityDirectoryKindBadge(kind: McpCapabilityDirectoryKind): {
  label: string;
  variant: McpBadgeVariant;
} {
  const labels: Record<McpCapabilityDirectoryKind, string> = {
    tool: 'Tool',
    resource: 'Resource',
    resource_template: 'Resource template',
    prompt: 'Prompt',
  };
  return {
    label: labels[kind],
    variant: kind === 'tool' ? 'default' : 'secondary',
  };
}

export function mcpCapabilityDirectoryDisplayName(entry: McpCapabilityDirectoryEntry): string {
  return entry.itemTitle?.trim() || entry.itemName;
}

// --- Screen copy (HIVE-7.9, #5326) -----------------------------------------------------------
// The strings `docs/mockups/sources/mcp-capabilities.html` fixes, kept here rather than in the
// component so the page and its suites read one definition of each.

/** The page's `h1`. */
export const MCP_CAPABILITY_DIRECTORY_TITLE = 'Capability directory';

/** The one line under it — DESIGN.md §5.3 asks for fourteen words or fewer. */
export const MCP_CAPABILITY_DIRECTORY_DESCRIPTION =
  'Every tool, resource, and prompt across your catalog — a “what can be done” index.';

/** Shown while a page of the directory is in flight. */
export const MCP_CAPABILITY_DIRECTORY_LOADING = 'Loading capabilities…';

/** The error state's heading. */
export const MCP_CAPABILITY_DIRECTORY_ERROR_TITLE = 'Could not load the capability directory';

/** Used when a failed read carries no message of its own. */
export const MCP_CAPABILITY_DIRECTORY_ERROR_FALLBACK = 'Could not load the capability directory.';

/** The empty state's heading — no rows matched, which filters can cause. */
export const MCP_CAPABILITY_DIRECTORY_EMPTY_TITLE = 'No capabilities found';

/** Its body copy. */
export const MCP_CAPABILITY_DIRECTORY_EMPTY_DESC =
  'Try clearing a filter or discover MCP servers so their tools, resources, and prompts appear here.';

/** Shown in place of the screen when the session has no workspace to read a catalog for. */
export const MCP_CAPABILITY_DIRECTORY_NO_TENANT =
  'Switch to a workspace to browse the capabilities its MCP servers expose.';

/** What one row of this table is, for the range sentence and the pager. */
export const MCP_CAPABILITY_DIRECTORY_NOUN = 'capability';

/** Its plural — English does not derive this one by suffixing `s`. */
export const MCP_CAPABILITY_DIRECTORY_NOUN_PLURAL = 'capabilities';

// --- Presets ---------------------------------------------------------------------------------

/**
 * One preset tile — a named view of the directory, applied in a single click.
 *
 * ### Why these four and not the mockup's four
 *
 * `sources/mcp-capabilities.html` proposes *Destructive tools*, *Read-only tools*, *Prompts* and
 * *Shadowed names*. Two of those cannot be honoured without changing the API, and inventing them
 * in the browser would break the ticket's third acceptance criterion outright:
 *
 * - **Destructive / read-only** read a tool's `annotations` (`destructiveHint`, `readOnlyHint`).
 *   `GET /v1/mcp/{slug}/capabilities` neither filters on them nor returns them —
 *   `list_mcp_capability_directory` selects `kind, item_id, item_name, item_title, description,
 *   ordinal` and the owning endpoint's columns, and nothing else. A client-side filter over a
 *   *paged* response would filter the fifty rows in hand rather than the catalog, so page 2 of
 *   "destructive tools" would be a different question from page 1.
 * - **Shadowed names** is a *set* of names (`GET …/data-quality/shadowing` returns one group per
 *   collision); the directory's `name` filter is a single case-insensitive substring, so there is
 *   no query that means "any of these". The signal itself is not lost — the catalog screen already
 *   draws `ShadowedNamesPanel` for it, which is the surface that can express a set.
 *
 * What is left is the set of one-click views the API can actually serve, which is what a preset
 * has to be: each of these is one request with one extra query parameter, sorted and paged by the
 * server exactly as the unfiltered directory is.
 */
export interface McpCapabilityDirectoryPreset {
  /** Stable id — the React key and the tile's `data-testid` suffix. */
  id: string;
  /** The tile's name. */
  label: string;
  /** One line under it saying what the view contains. */
  description: string;
  /** The filter patch it applies over {@link MCP_CAPABILITY_DIRECTORY_DEFAULT_FILTERS}. */
  filters: Partial<McpCapabilityDirectoryFilters>;
  /** The status-vocabulary tone its icon tile takes. */
  tone: 'accent' | 'ok' | 'violet' | 'warn';
}

/** The four preset tiles, in display order. */
export const MCP_CAPABILITY_DIRECTORY_PRESETS: readonly McpCapabilityDirectoryPreset[] = [
  {
    id: 'tools',
    label: 'Tools',
    description: 'Operations an assistant can call',
    filters: { type: 'tool' },
    tone: 'accent',
  },
  {
    id: 'resources',
    label: 'Resources',
    description: 'Context to read, not actions to run',
    filters: { type: 'resource' },
    tone: 'ok',
  },
  {
    id: 'prompts',
    label: 'Prompts',
    description: 'Reusable prompt templates',
    filters: { type: 'prompt' },
    tone: 'violet',
  },
  {
    id: 'public',
    label: 'Public surface',
    description: 'Exposed beyond this workspace',
    filters: { visibility: 'public' },
    tone: 'warn',
  },
];

/**
 * The filters a preset tile produces when it is clicked.
 *
 * A preset is a *view*, not a refinement: it replaces the whole filter set rather than merging
 * into whatever was there, so clicking "Prompts" while a host filter is active gives the prompts
 * of the whole catalog — which is what the tile's own caption promises. Clicking the active preset
 * again clears back to the unfiltered directory.
 *
 * @param preset The tile that was clicked.
 * @param current The filters in force.
 * @returns The filters to apply.
 */
export function mcpCapabilityDirectoryApplyPreset(
  preset: McpCapabilityDirectoryPreset,
  current: McpCapabilityDirectoryFilters,
): McpCapabilityDirectoryFilters {
  if (mcpCapabilityDirectoryPresetIsActive(preset, current)) {
    return { ...MCP_CAPABILITY_DIRECTORY_DEFAULT_FILTERS };
  }
  return { ...MCP_CAPABILITY_DIRECTORY_DEFAULT_FILTERS, ...preset.filters };
}

/**
 * Whether a preset is the view currently on screen.
 *
 * True only when the filters are *exactly* the preset's — its own keys match and every other
 * filter is at its default. A tile that stayed lit while a host filter narrowed it further would
 * be claiming to describe a set it no longer describes.
 *
 * @param preset The tile.
 * @param filters The filters in force.
 * @returns Whether the tile should read as selected.
 */
export function mcpCapabilityDirectoryPresetIsActive(
  preset: McpCapabilityDirectoryPreset,
  filters: McpCapabilityDirectoryFilters,
): boolean {
  const target: McpCapabilityDirectoryFilters = {
    ...MCP_CAPABILITY_DIRECTORY_DEFAULT_FILTERS,
    ...preset.filters,
  };
  return (Object.keys(target) as Array<keyof McpCapabilityDirectoryFilters>).every(
    (key) => filters[key].trim() === target[key].trim(),
  );
}

/**
 * The query that counts a preset's rows without fetching them.
 *
 * `limit=1` because only `total` is read — the count beside a tile is a `COUNT(*)` on the server,
 * and pulling fifty rows to print one number would be the expensive way to ask.
 *
 * @param preset The tile to count.
 * @returns The query string.
 */
export function mcpCapabilityDirectoryPresetCountParams(
  preset: McpCapabilityDirectoryPreset,
): URLSearchParams {
  return mcpCapabilityDirectoryQueryParams(
    { ...MCP_CAPABILITY_DIRECTORY_DEFAULT_FILTERS, ...preset.filters },
    'server',
    'asc',
    0,
    1,
  );
}

// --- Range, sort and foot lines --------------------------------------------------------------

/**
 * The `start–end of total` line above the table, or `No capabilities` when nothing matched.
 *
 * @param offset How many rows were skipped.
 * @param count How many rows this page holds.
 * @param total How many matched in all.
 * @returns The sentence.
 */
export function mcpCapabilityDirectoryRange(
  offset: number,
  count: number,
  total: number,
): string {
  if (total === 0) return `No ${MCP_CAPABILITY_DIRECTORY_NOUN_PLURAL}`;
  const start = offset + 1;
  const end = Math.min(offset + count, total);
  return `${start}–${end} of ${total}`;
}

/** The label a sort key reads as in the foot line. */
const SORT_LABEL: Readonly<Record<McpCapabilityDirectorySort, string>> = {
  server: 'server',
  name: 'capability',
  type: 'type',
};

/**
 * The sentence under the table: what matched, how big a page is, and how it is ordered.
 *
 * The mockup prints `8 capabilities match “search” · page size 50 · sorted by server ↑`. The
 * arrow is `aria-hidden` in the markup; this string carries the direction in words as well so the
 * sentence still says which way it points when the glyph is not announced.
 *
 * @param total How many rows matched.
 * @param filters The filters in force — the name term is quoted back when there is one.
 * @param sort The sorted column.
 * @param direction Which way it points.
 * @returns The sentence.
 */
export function mcpCapabilityDirectoryFootLine(
  total: number,
  filters: McpCapabilityDirectoryFilters,
  sort: McpCapabilityDirectorySort,
  direction: McpCapabilityDirectorySortDirection,
): string {
  const noun = total === 1 ? MCP_CAPABILITY_DIRECTORY_NOUN : MCP_CAPABILITY_DIRECTORY_NOUN_PLURAL;
  const name = filters.name.trim();
  const matching = name ? `${total} ${noun} match “${name}”` : `${total} ${noun}`;
  const order = `sorted by ${SORT_LABEL[sort]} ${direction === 'asc' ? 'ascending' : 'descending'}`;
  return `${matching} · page size ${MCP_CAPABILITY_DIRECTORY_PAGE_SIZE} · ${order}`;
}

/**
 * The next sort after a header click, in the two states this table has.
 *
 * `ui/DataTable` cycles asc → desc → **unsorted**, because a client-sorted list has a natural
 * order to fall back to. This one does not: `GET …/capabilities` always orders by one of
 * server / name / type, so "unsorted" would still be `server ascending` — it would simply be a
 * click that appeared to do nothing. The third state therefore resolves to the default column
 * rather than to no column, and the table's `aria-sort` never reads `none` on a loaded page.
 *
 * @param next What `nextSortState` produced, which may be `null`.
 * @returns The column and direction to request.
 */
export function mcpCapabilityDirectorySortFromTable(
  next: { column: string; direction: McpCapabilityDirectorySortDirection } | null,
): { sort: McpCapabilityDirectorySort; direction: McpCapabilityDirectorySortDirection } {
  if (!next) return { sort: 'server', direction: 'asc' };
  const sort = MCP_CAPABILITY_DIRECTORY_SORTS.find((option) => option.key === next.column);
  return { sort: sort ? sort.key : 'server', direction: next.direction };
}
