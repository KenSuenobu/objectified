/**
 * MCP catalog grade-led card grid — pure presentation helpers (V2-MCP-24.8 / MCAT-10.8, #3939).
 *
 * The catalog landing renders the private browse payload (9.1) as a grade-led card grid grouped by
 * site/host, with a sort control (default `Grade ▾`), composable filters (host, grade, transport,
 * visibility, auth, category — plus the 35.1 facet dimensions: safety posture, complexity band,
 * protocol version, discovery health), a grid ↔ dense-list density toggle, and a "changed since
 * last view" marker. This module holds the *pure*, React-free logic those controls drive — faceting, filtering,
 * sorting, the per-host health rollup, and the small localStorage helpers for the persisted density
 * preference and the per-endpoint "last seen" snapshot — so they can be unit-tested directly and the
 * page component stays declarative.
 */

import {
  mcpEndpointMatchesQuery,
  type McpBrowseEndpoint,
  type McpBrowseHostGroup,
} from './mcpBrowseUi';
import {
  mcpHealthFromDiscoveryStatus,
  mcpNormalizeGrade,
  type McpHealthStatus,
} from './mcpUiPrimitives';

// --- Density --------------------------------------------------------------------------------

/** Catalog layout density: roomy cards, or a compact one-row-per-endpoint list. */
export type McpCatalogDensity = 'grid' | 'list';

/** The default density when the user has no saved preference. */
export const MCP_CATALOG_DEFAULT_DENSITY: McpCatalogDensity = 'grid';

// --- Sorting --------------------------------------------------------------------------------

/** The orderings the catalog sort control offers. */
export type McpCatalogSortKey = 'grade' | 'name' | 'recency' | 'capabilities' | 'health';

/** One entry in the sort `<select>`: its stable key and the human label shown in the control. */
export interface McpCatalogSortOption {
  key: McpCatalogSortKey;
  label: string;
}

/** The sort options in display order; `grade` (best first) is the catalog default. */
export const MCP_CATALOG_SORTS: readonly McpCatalogSortOption[] = [
  { key: 'grade', label: 'Grade' },
  { key: 'name', label: 'Name' },
  { key: 'recency', label: 'Last discovered' },
  { key: 'capabilities', label: 'Capabilities' },
  { key: 'health', label: 'Health' },
] as const;

/** The catalog's default sort key. */
export const MCP_CATALOG_DEFAULT_SORT: McpCatalogSortKey = 'grade';

/** Coerce an arbitrary value to a known sort key, falling back to the default. */
export function mcpNormalizeSortKey(value: string | null | undefined): McpCatalogSortKey {
  return MCP_CATALOG_SORTS.some((s) => s.key === value)
    ? (value as McpCatalogSortKey)
    : MCP_CATALOG_DEFAULT_SORT;
}

// Grade rank: A is best (rank 0) … F worst; unscored sorts last. Health rank: healthy best.
const GRADE_RANK: Record<string, number> = { A: 0, B: 1, C: 2, D: 3, F: 4 };
const GRADE_UNSCORED_RANK = 99;
const HEALTH_RANK: Record<McpHealthStatus, number> = {
  healthy: 0,
  degraded: 1,
  unreachable: 2,
  unknown: 3,
};

/** Rank an endpoint's grade for sorting (A→0 … F→4, unscored last). */
function endpointGradeRank(ep: McpBrowseEndpoint): number {
  const letter = mcpNormalizeGrade(ep.grade);
  return letter ? GRADE_RANK[letter] : GRADE_UNSCORED_RANK;
}

/** Parse an endpoint's `last_discovered_at` to epoch ms, or 0 when absent/invalid. */
function endpointDiscoveredMs(ep: McpBrowseEndpoint): number {
  if (!ep.last_discovered_at) return 0;
  const ms = Date.parse(ep.last_discovered_at);
  return Number.isNaN(ms) ? 0 : ms;
}

/** Stable name comparison used as the final tiebreaker across every sort. */
function byName(a: McpBrowseEndpoint, b: McpBrowseEndpoint): number {
  return a.name.localeCompare(b.name);
}

/**
 * Compare two endpoints for the given sort key. Each ordering puts the strongest item first
 * (best grade, most recent, most capabilities, healthiest), with name ascending as the tiebreaker;
 * `name` sorts alphabetically. The comparator is pure and total so `Array.prototype.sort` is stable.
 */
export function mcpCompareEndpoints(
  a: McpBrowseEndpoint,
  b: McpBrowseEndpoint,
  sortKey: McpCatalogSortKey,
): number {
  switch (sortKey) {
    case 'name':
      return byName(a, b);
    case 'recency': {
      const diff = endpointDiscoveredMs(b) - endpointDiscoveredMs(a);
      return diff !== 0 ? diff : byName(a, b);
    }
    case 'capabilities': {
      const diff = b.capability_count - a.capability_count;
      return diff !== 0 ? diff : byName(a, b);
    }
    case 'health': {
      const diff =
        HEALTH_RANK[mcpHealthFromDiscoveryStatus(a.last_discovery_status)] -
        HEALTH_RANK[mcpHealthFromDiscoveryStatus(b.last_discovery_status)];
      return diff !== 0 ? diff : byName(a, b);
    }
    case 'grade':
    default: {
      const diff = endpointGradeRank(a) - endpointGradeRank(b);
      if (diff !== 0) return diff;
      // Same letter grade: higher numeric score first, then name.
      const scoreDiff = (b.score ?? -1) - (a.score ?? -1);
      return scoreDiff !== 0 ? scoreDiff : byName(a, b);
    }
  }
}

/** Sort a copy of an endpoint list by the given key (does not mutate the input). */
export function mcpSortEndpoints(
  endpoints: McpBrowseEndpoint[],
  sortKey: McpCatalogSortKey,
): McpBrowseEndpoint[] {
  return [...endpoints].sort((a, b) => mcpCompareEndpoints(a, b, sortKey));
}

/** The best (lowest) grade rank among a group's endpoints — used to order whole host groups. */
function groupBestGradeRank(group: McpBrowseHostGroup): number {
  return group.endpoints.reduce(
    (best, ep) => Math.min(best, endpointGradeRank(ep)),
    GRADE_UNSCORED_RANK,
  );
}

/** The most recent discovery instant among a group's endpoints (epoch ms; 0 when none). */
function groupLatestDiscoveredMs(group: McpBrowseHostGroup): number {
  return group.endpoints.reduce((latest, ep) => Math.max(latest, endpointDiscoveredMs(ep)), 0);
}

/**
 * Sort whole host groups for the chosen ordering and sort each group's endpoints in place-of-copy.
 * Groups are ranked by the same dimension as their endpoints (best grade / most recent / most
 * capabilities / healthiest), except `name`, which orders groups by host alphabetically. The
 * returned groups are fresh objects with sorted endpoint arrays; inputs are not mutated.
 */
export function mcpSortGroups(
  groups: McpBrowseHostGroup[],
  sortKey: McpCatalogSortKey,
): McpBrowseHostGroup[] {
  const withSortedEndpoints = groups.map((g) => ({
    ...g,
    endpoints: mcpSortEndpoints(g.endpoints, sortKey),
  }));
  const compareGroups = (a: McpBrowseHostGroup, b: McpBrowseHostGroup): number => {
    switch (sortKey) {
      case 'name':
        return a.host.localeCompare(b.host);
      case 'recency': {
        const diff = groupLatestDiscoveredMs(b) - groupLatestDiscoveredMs(a);
        return diff !== 0 ? diff : a.host.localeCompare(b.host);
      }
      case 'capabilities': {
        const diff = b.capability_count - a.capability_count;
        return diff !== 0 ? diff : a.host.localeCompare(b.host);
      }
      case 'health': {
        const diff =
          mcpGroupHealthRollup(a.endpoints).failing - mcpGroupHealthRollup(b.endpoints).failing;
        return diff !== 0 ? diff : a.host.localeCompare(b.host);
      }
      case 'grade':
      default: {
        const diff = groupBestGradeRank(a) - groupBestGradeRank(b);
        return diff !== 0 ? diff : a.host.localeCompare(b.host);
      }
    }
  };
  return withSortedEndpoints.sort(compareGroups);
}

// --- Filtering & facets ---------------------------------------------------------------------

/** The composable catalog filter state. Empty arrays/blank string mean "no constraint". */
export interface McpCatalogFilters {
  hosts: string[];
  grades: string[];
  transports: string[];
  visibilities: string[];
  auths: string[];
  categories: string[];
  /** Safety postures (35.1): `has_destructive` and/or `read_only_only`. */
  safeties: string[];
  /** Complexity bands (35.1): `simple` / `moderate` / `complex` / `unknown`. */
  complexities: string[];
  /** Reported protocol versions (35.1); `unknown` selects endpoints with none reported. */
  protocols: string[];
  /** Derived discovery-health labels (35.1). */
  healths: string[];
}

/** An empty filter state (everything passes). */
export const MCP_CATALOG_EMPTY_FILTERS: McpCatalogFilters = {
  hosts: [],
  grades: [],
  transports: [],
  visibilities: [],
  auths: [],
  categories: [],
  safeties: [],
  complexities: [],
  protocols: [],
  healths: [],
};

/** The facet value an endpoint with no reported protocol version files/filters under (35.1). */
export const MCP_CATALOG_UNKNOWN_PROTOCOL = 'unknown';

/** Human labels for the machine-named facet values the 35.1 facets introduce. */
export const MCP_CATALOG_FACET_VALUE_LABELS: Readonly<Record<string, string>> = {
  has_destructive: 'Has destructive',
  read_only_only: 'Read-only only',
};

/** The facet dimensions the catalog exposes, in the order their controls render. */
export type McpCatalogFacetKey = keyof McpCatalogFilters;

/**
 * The ten facet dimensions in the order `sources/mcp-servers.html` lists them.
 *
 * The order is part of the design, not an accident of how the tallies are built: the first
 * three answer "which server is this" (host, grade, transport), the next four "what will it do
 * to me" (safety, complexity, protocol, health) and the last three "who may see it" (visibility,
 * auth, category). Listed once here so the panel, the saved-search summary and the tests all
 * read the same sequence.
 */
export const MCP_CATALOG_FACET_ORDER: readonly McpCatalogFacetKey[] = [
  'hosts',
  'grades',
  'transports',
  'safeties',
  'complexities',
  'protocols',
  'healths',
  'visibilities',
  'auths',
  'categories',
] as const;

/** The human name of each facet, as its panel label and in a saved view's summary line. */
export const MCP_CATALOG_FACET_LABELS: Readonly<Record<McpCatalogFacetKey, string>> = {
  hosts: 'Host',
  grades: 'Grade',
  transports: 'Transport',
  safeties: 'Safety',
  complexities: 'Complexity',
  protocols: 'Protocol',
  healths: 'Health',
  visibilities: 'Visibility',
  auths: 'Auth',
  categories: 'Category',
};

/** One selectable value within a facet, with how many endpoints carry it. */
export interface McpCatalogFacetValue {
  value: string;
  count: number;
  /** Optional human label for a machine-named value (chips render `label ?? value`). */
  label?: string;
}

/** A facet dimension: its key, a human label, and the values present in the data. */
export interface McpCatalogFacet {
  key: McpCatalogFacetKey;
  label: string;
  values: McpCatalogFacetValue[];
}

/** True when every supplied filter constraint passes for an endpoint (constraints AND together). */
export function mcpCatalogEndpointMatchesFilters(
  endpoint: McpBrowseEndpoint,
  filters: McpCatalogFilters,
): boolean {
  if (filters.hosts.length && !filters.hosts.includes(endpoint.host)) return false;
  if (filters.grades.length) {
    const letter = mcpNormalizeGrade(endpoint.grade);
    if (!letter || !filters.grades.includes(letter)) return false;
  }
  if (filters.transports.length && !filters.transports.includes(endpoint.transport)) return false;
  if (filters.visibilities.length && !filters.visibilities.includes(endpoint.visibility)) {
    return false;
  }
  if (filters.auths.length && (!endpoint.auth_scheme || !filters.auths.includes(endpoint.auth_scheme))) {
    return false;
  }
  if (filters.categories.length && (!endpoint.category || !filters.categories.includes(endpoint.category))) {
    return false;
  }
  if (filters.safeties.length) {
    // Within-facet OR: the endpoint passes when it carries any selected posture flag.
    const matchesSafety =
      (filters.safeties.includes('has_destructive') && endpoint.has_destructive) ||
      (filters.safeties.includes('read_only_only') && endpoint.read_only_only);
    if (!matchesSafety) return false;
  }
  if (filters.complexities.length && !filters.complexities.includes(endpoint.complexity_band)) {
    return false;
  }
  if (
    filters.protocols.length &&
    !filters.protocols.includes(endpoint.protocol_version ?? MCP_CATALOG_UNKNOWN_PROTOCOL)
  ) {
    return false;
  }
  if (filters.healths.length && !filters.healths.includes(endpoint.health)) {
    return false;
  }
  return true;
}

/** True when no filter constraint is set (every endpoint passes). */
export function mcpCatalogFiltersAreEmpty(filters: McpCatalogFilters): boolean {
  return Object.values(filters).every((values) => values.length === 0);
}

/** Count of active filter constraints across every facet (for the "Filters (N)" affordance). */
export function mcpCatalogActiveFilterCount(filters: McpCatalogFilters): number {
  return Object.values(filters).reduce((sum, values) => sum + values.length, 0);
}

/** Tally one value into a facet's running count map. */
function tally(map: Map<string, number>, value: string | null | undefined): void {
  const key = (value ?? '').trim();
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** Turn a count map into sorted facet values (descending count, then value ascending). */
function facetValues(map: Map<string, number>): McpCatalogFacetValue[] {
  return [...map.entries()]
    .map(([value, count]) => ({
      value,
      count,
      label: MCP_CATALOG_FACET_VALUE_LABELS[value],
    }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

/**
 * Compute the available facets from the full (unfiltered) endpoint set, so the filter controls
 * always offer every value the catalog contains regardless of the current selection. A facet with
 * no values present (e.g. auth, when the payload omits it) is dropped, so the UI never renders an
 * empty control. Grades are normalized to A–F letters; the `(local)` host and other dimensions use
 * their raw catalog values.
 */
export function mcpCatalogFacets(groups: McpBrowseHostGroup[]): McpCatalogFacet[] {
  const hosts = new Map<string, number>();
  const grades = new Map<string, number>();
  const transports = new Map<string, number>();
  const visibilities = new Map<string, number>();
  const auths = new Map<string, number>();
  const categories = new Map<string, number>();
  const safeties = new Map<string, number>();
  const complexities = new Map<string, number>();
  const protocols = new Map<string, number>();
  const healths = new Map<string, number>();

  for (const group of groups) {
    for (const ep of group.endpoints) {
      tally(hosts, ep.host);
      tally(grades, mcpNormalizeGrade(ep.grade));
      tally(transports, ep.transport);
      tally(visibilities, ep.visibility);
      tally(auths, ep.auth_scheme);
      tally(categories, ep.category);
      // Safety postures are independent flags: an endpoint tallies into each it carries (0-2).
      if (ep.has_destructive) tally(safeties, 'has_destructive');
      if (ep.read_only_only) tally(safeties, 'read_only_only');
      tally(complexities, ep.complexity_band);
      tally(protocols, ep.protocol_version ?? MCP_CATALOG_UNKNOWN_PROTOCOL);
      tally(healths, ep.health);
    }
  }

  const byKey: Record<McpCatalogFacetKey, Map<string, number>> = {
    hosts,
    grades,
    transports,
    safeties,
    complexities,
    protocols,
    healths,
    visibilities,
    auths,
    categories,
  };
  return MCP_CATALOG_FACET_ORDER.map((key) => ({
    key,
    label: MCP_CATALOG_FACET_LABELS[key],
    values: facetValues(byKey[key]),
  })).filter((f) => f.values.length > 0);
}

/**
 * Apply the search box and the composable filters to the host groups, dropping non-matching
 * endpoints and any group left empty, and recomputing each surviving group's counts from its
 * remaining endpoints. Search reuses {@link mcpEndpointMatchesQuery} (name / slug / host / URL /
 * category); a blank query and empty filters return the groups untouched.
 */
export function mcpApplyCatalog(
  groups: McpBrowseHostGroup[],
  filters: McpCatalogFilters,
  query: string,
): McpBrowseHostGroup[] {
  const hasQuery = query.trim().length > 0;
  const hasFilters = !mcpCatalogFiltersAreEmpty(filters);
  if (!hasQuery && !hasFilters) return groups;

  const result: McpBrowseHostGroup[] = [];
  for (const group of groups) {
    const endpoints = group.endpoints.filter(
      (ep) =>
        mcpCatalogEndpointMatchesFilters(ep, filters) &&
        (!hasQuery || mcpEndpointMatchesQuery(ep, query)),
    );
    if (endpoints.length === 0) continue;
    result.push({
      host: group.host,
      endpoint_count: endpoints.length,
      capability_count: endpoints.reduce((sum, e) => sum + e.capability_count, 0),
      endpoints,
    });
  }
  return result;
}

// --- What the screen says about itself (HIVE-7.7, #5324) ------------------------------------
// The catalog's own prose: the totals line, the sort hint, and the one-line summary a saved view
// and the save dialog both print. All of it is derived here rather than assembled in JSX, so the
// sentence a reader sees on the page is the sentence a test can assert without a DOM.

/** The three figures the totals line prints for one slice of the catalog. */
export interface McpCatalogTotals {
  hostCount: number;
  endpointCount: number;
  capabilityCount: number;
}

/** Count hosts, endpoints and capabilities across a set of groups. */
export function mcpCatalogTotals(groups: McpBrowseHostGroup[]): McpCatalogTotals {
  return {
    hostCount: groups.length,
    endpointCount: groups.reduce((sum, g) => sum + g.endpoints.length, 0),
    capabilityCount: groups.reduce((sum, g) => sum + g.capability_count, 0),
  };
}

/**
 * `1 host` / `3 hosts` — a count and the noun it agrees with.
 *
 * @param count How many.
 * @param one The singular noun.
 * @param many The plural, when it is not just the singular plus `s`.
 * @returns The counted phrase.
 */
function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The totals line under the toolbar.
 *
 * The mockup prints the *whole* catalog's figures and appends "filtered by 2 facet values". This
 * ticket's first acceptance criterion asks instead that the counts reflect the **active set**, so
 * the leading figures are the visible slice's and the full catalog is named after them — a reader
 * who has narrowed the list sees what is in front of them first, and still learns what it was
 * narrowed from. With nothing filtered the two are the same and only one is printed.
 *
 * @param visible The groups currently on screen (after search and facets).
 * @param all Every group the catalog loaded.
 * @param activeFilterCount How many facet *values* are selected, from {@link mcpCatalogActiveFilterCount}.
 * @param query The search box's text, so a search alone is named too.
 * @returns One sentence, e.g. `2 hosts · 3 endpoints · 21 capabilities · filtered from 6 endpoints by 2 facet values`.
 */
export function mcpCatalogTotalsLine(
  visible: McpBrowseHostGroup[],
  all: McpBrowseHostGroup[],
  activeFilterCount: number,
  query: string,
): string {
  const shown = mcpCatalogTotals(visible);
  const total = mcpCatalogTotals(all);
  const head = [
    plural(shown.hostCount, 'host'),
    plural(shown.endpointCount, 'endpoint'),
    plural(shown.capabilityCount, 'capability', 'capabilities'),
  ].join(' · ');

  const narrowed: string[] = [];
  if (activeFilterCount > 0) narrowed.push(`${plural(activeFilterCount, 'facet value')}`);
  if (query.trim()) narrowed.push(`a search for “${query.trim()}”`);
  if (narrowed.length === 0) return head;
  return `${head} · filtered from ${plural(total.endpointCount, 'endpoint')} by ${narrowed.join(' and ')}`;
}

/** What each ordering promises, printed beside the totals line so the order is never a guess. */
export const MCP_CATALOG_SORT_HINT: Readonly<Record<McpCatalogSortKey, string>> = {
  grade: 'Sorted by grade · A→F, unscored last',
  name: 'Sorted by name · A→Z',
  recency: 'Sorted by last discovered · newest first',
  capabilities: 'Sorted by capabilities · most first',
  health: 'Sorted by health · healthy first',
};

/**
 * Spell one facet's selection the way its chips do, e.g. `Safety Has destructive`.
 *
 * @param key Which facet.
 * @param values The selected raw values.
 * @returns The phrase, or null when nothing in the facet is selected.
 */
function facetPhrase(key: McpCatalogFacetKey, values: string[]): string | null {
  if (values.length === 0) return null;
  const spelled = values.map((value) => MCP_CATALOG_FACET_VALUE_LABELS[value] ?? value);
  return `${MCP_CATALOG_FACET_LABELS[key]} ${spelled.join(', ')}`;
}

/** The filter half of a saved view's summary, or `null` when no facet is constrained. */
export function mcpCatalogFilterSummary(filters: McpCatalogFilters): string | null {
  const parts = MCP_CATALOG_FACET_ORDER.map((key) => facetPhrase(key, filters[key])).filter(
    (part): part is string => part !== null,
  );
  return parts.length ? parts.join(', ') : null;
}

/**
 * The one line that describes a catalog view — what a saved search row shows under its name, and
 * what the save dialog shows before the view is saved.
 *
 * Every part is omitted when it is empty, so a view that only sorts reads `Sort Grade` rather than
 * `Query "" · Filters: none · Sort Grade`. The sort is always named because every view has one.
 *
 * @param query The search text.
 * @param filters The facet selection.
 * @param sort The ordering.
 * @returns The summary line.
 */
export function mcpCatalogViewSummary(
  query: string,
  filters: McpCatalogFilters,
  sort: McpCatalogSortKey,
): string {
  const parts: string[] = [];
  if (query.trim()) parts.push(`Query “${query.trim()}”`);
  const filterSummary = mcpCatalogFilterSummary(filters);
  if (filterSummary) parts.push(`Filters: ${filterSummary}`);
  parts.push(`Sort ${MCP_CATALOG_SORTS.find((s) => s.key === sort)?.label ?? sort}`);
  return parts.join(' · ');
}

// --- The screen's fixed copy ----------------------------------------------------------------
// Every string the catalog's states print, in one place: the page, the two panels and the tests
// all name the same constant, so a wording change cannot land in only one of the three.

/** The page's own title and one-line description (DESIGN.md §5.3: a noun, then ≤14 words). */
export const MCP_CATALOG_TITLE = 'MCP servers';
export const MCP_CATALOG_DESCRIPTION =
  'Every MCP server in this workspace, grade-led and grouped by host.';

/** The rule the facet panel states about itself — the mockup prints it under the chips. */
export const MCP_CATALOG_FACET_NOTE =
  'Facets AND together; values within a facet OR. Counts reflect the full catalog.';

/** While the browse payload is in flight. */
export const MCP_CATALOG_LOADING = 'Loading the MCP catalog…';

/** When it fails. */
export const MCP_CATALOG_ERROR_TITLE = 'Could not load the MCP catalog';
export const MCP_CATALOG_ERROR_FALLBACK = 'The catalog service did not respond.';

/** When the workspace has never registered a server. */
export const MCP_CATALOG_EMPTY_TITLE = 'No MCP endpoints yet';
export const MCP_CATALOG_EMPTY_DESC =
  'Register an MCP server. Once discovered, its endpoints appear here grouped by host.';

/** When search and facets exclude everything the catalog holds. */
export const MCP_CATALOG_NO_MATCH_TITLE = 'No matches';
export const MCP_CATALOG_NO_MATCH_DESC =
  'No endpoints match your search and filters. Try clearing a filter or broadening the search.';

/** When there is no workspace to scope the catalog to. */
export const MCP_CATALOG_NO_TENANT = 'The MCP catalog is scoped to one workspace.';

// --- Health rollup --------------------------------------------------------------------------

/** A per-host health tally and its short summary string (e.g. `11 healthy · 1 failing`). */
export interface McpCatalogHealthRollup {
  healthy: number;
  degraded: number;
  /** Unreachable endpoints — the "failing" count surfaced in the group header. */
  failing: number;
  unknown: number;
  total: number;
  /** Pre-formatted summary, omitting zero buckets (e.g. `11 healthy · 1 failing`). */
  summary: string;
}

/**
 * Roll a group's endpoint discovery statuses up into a health tally and a short summary string.
 * The summary lists only the non-zero buckets in severity order (healthy → degraded → failing →
 * unknown); an all-unknown group reads `N unknown`. Mirrors the mockup's `11 healthy · 1 failing`.
 */
export function mcpGroupHealthRollup(endpoints: McpBrowseEndpoint[]): McpCatalogHealthRollup {
  let healthy = 0;
  let degraded = 0;
  let failing = 0;
  let unknown = 0;
  for (const ep of endpoints) {
    const status = mcpHealthFromDiscoveryStatus(ep.last_discovery_status);
    if (status === 'healthy') healthy += 1;
    else if (status === 'degraded') degraded += 1;
    else if (status === 'unreachable') failing += 1;
    else unknown += 1;
  }
  const parts: string[] = [];
  if (healthy) parts.push(`${healthy} healthy`);
  if (degraded) parts.push(`${degraded} degraded`);
  if (failing) parts.push(`${failing} failing`);
  if (unknown) parts.push(`${unknown} unknown`);
  return {
    healthy,
    degraded,
    failing,
    unknown,
    total: endpoints.length,
    summary: parts.join(' · '),
  };
}

// --- "Changed since last view" --------------------------------------------------------------
// A per-endpoint snapshot of what the user last saw (its current version id + discovery instant),
// persisted in localStorage. On the next visit, an endpoint whose surface has *versioned since*
// (its current_version_id changed, or it was rediscovered later) is marked "changed". Brand-new
// endpoints — absent from the snapshot — are deliberately NOT marked, matching the acceptance
// criterion ("appears only on endpoints versioned since the last visit").

/** The "last seen" mark recorded per endpoint: its current version id and last-discovered instant. */
export interface McpCatalogSeenMark {
  versionId: string | null;
  discoveredAt: string | null;
}

/** The persisted snapshot: endpoint id → the mark recorded when the catalog was last viewed. */
export type McpCatalogSeenSnapshot = Record<string, McpCatalogSeenMark>;

/** Flatten every endpoint across host groups into a single list (handy for snapshot/seen work). */
export function mcpCatalogAllEndpoints(groups: McpBrowseHostGroup[]): McpBrowseEndpoint[] {
  return groups.flatMap((g) => g.endpoints);
}

/** Build a fresh snapshot mark for one endpoint from its current surface. */
function markFor(ep: McpBrowseEndpoint): McpCatalogSeenMark {
  return { versionId: ep.current_version_id, discoveredAt: ep.last_discovered_at };
}

/** Build the full seen snapshot for the current catalog (every endpoint → its mark). */
export function mcpBuildSeenSnapshot(groups: McpBrowseHostGroup[]): McpCatalogSeenSnapshot {
  const snapshot: McpCatalogSeenSnapshot = {};
  for (const ep of mcpCatalogAllEndpoints(groups)) {
    if (ep.id) snapshot[ep.id] = markFor(ep);
  }
  return snapshot;
}

/**
 * Decide whether an endpoint has *changed since the user last viewed it*, given the previously
 * stored snapshot. Returns `false` when the endpoint is absent from the snapshot (it is new, not
 * changed). An endpoint is "changed" when its current version id differs from the seen mark, or
 * when its `last_discovered_at` is strictly later than the seen instant (a rediscovery).
 */
export function mcpEndpointChangedSinceSeen(
  endpoint: McpBrowseEndpoint,
  snapshot: McpCatalogSeenSnapshot | null | undefined,
): boolean {
  if (!snapshot) return false;
  const seen = snapshot[endpoint.id];
  if (!seen) return false;
  if ((endpoint.current_version_id ?? null) !== (seen.versionId ?? null)) return true;
  const now = endpoint.last_discovered_at ? Date.parse(endpoint.last_discovered_at) : NaN;
  const then = seen.discoveredAt ? Date.parse(seen.discoveredAt) : NaN;
  if (!Number.isNaN(now) && !Number.isNaN(then) && now > then) return true;
  return false;
}

/** The set of endpoint ids that changed since the seen snapshot (empty when none/no snapshot). */
export function mcpChangedEndpointIds(
  groups: McpBrowseHostGroup[],
  snapshot: McpCatalogSeenSnapshot | null | undefined,
): Set<string> {
  const ids = new Set<string>();
  if (!snapshot) return ids;
  for (const ep of mcpCatalogAllEndpoints(groups)) {
    if (mcpEndpointChangedSinceSeen(ep, snapshot)) ids.add(ep.id);
  }
  return ids;
}

// --- localStorage persistence (10.10) -------------------------------------------------------
// Density and the seen snapshot persist under stable namespaced keys. All access is wrapped so a
// disabled/quota-exceeded storage (private mode, SSR) degrades to the in-memory default rather than
// throwing.

/** localStorage key for the persisted density preference. */
export const MCP_CATALOG_DENSITY_KEY = 'mcp.catalog.density';
/** localStorage key for the persisted per-endpoint "last seen" snapshot. */
export const MCP_CATALOG_SEEN_KEY = 'mcp.catalog.seen';

/** Coerce an arbitrary value to a valid density, defaulting to {@link MCP_CATALOG_DEFAULT_DENSITY}. */
export function mcpNormalizeDensity(value: string | null | undefined): McpCatalogDensity {
  return value === 'grid' || value === 'list' ? value : MCP_CATALOG_DEFAULT_DENSITY;
}

/** Read the persisted density, defaulting when storage is unavailable or holds an unknown value. */
export function mcpReadDensity(storage: Storage | undefined = safeStorage()): McpCatalogDensity {
  if (!storage) return MCP_CATALOG_DEFAULT_DENSITY;
  try {
    return mcpNormalizeDensity(storage.getItem(MCP_CATALOG_DENSITY_KEY));
  } catch {
    return MCP_CATALOG_DEFAULT_DENSITY;
  }
}

/** Persist the density preference (no-op when storage is unavailable). */
export function mcpWriteDensity(
  density: McpCatalogDensity,
  storage: Storage | undefined = safeStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(MCP_CATALOG_DENSITY_KEY, density);
  } catch {
    /* ignore quota / private mode */
  }
}

/** Read the persisted seen snapshot, or `null` when absent/unparseable/unavailable. */
export function mcpReadSeenSnapshot(
  storage: Storage | undefined = safeStorage(),
): McpCatalogSeenSnapshot | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(MCP_CATALOG_SEEN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as McpCatalogSeenSnapshot)
      : null;
  } catch {
    return null;
  }
}

/** Persist the seen snapshot for the current catalog (no-op when storage is unavailable). */
export function mcpWriteSeenSnapshot(
  snapshot: McpCatalogSeenSnapshot,
  storage: Storage | undefined = safeStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(MCP_CATALOG_SEEN_KEY, JSON.stringify(snapshot));
  } catch {
    /* ignore quota / private mode */
  }
}

/** The browser localStorage when available, else `undefined` (SSR / disabled storage). */
function safeStorage(): Storage | undefined {
  try {
    return typeof window !== 'undefined' ? window.localStorage : undefined;
  } catch {
    return undefined;
  }
}
