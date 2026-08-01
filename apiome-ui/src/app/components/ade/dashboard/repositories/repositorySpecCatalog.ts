/**
 * Types and pure helpers for the cross-repository discovered-spec catalog (REPO-6.4, #2797).
 *
 * The catalog is a thin client over `/api/repositories/catalog`: every filter, the ordering
 * and the pagination are evaluated server-side, so the only logic worth having here is the
 * translation between the three representations of a catalog view —
 *
 *   * the browser URL, so a filtered catalog is bookmarkable and shareable,
 *   * the API query string,
 *   * and the in-memory filter state the component holds.
 *
 * Keeping those conversions here (rather than inline in the component) is what makes them
 * testable without rendering, and is why the component itself has no string-building in it.
 */

/** One catalog row as returned by `GET /api/repositories/catalog`. */
export type SpecCatalogRow = {
  id: string;
  repository_id: string;
  repository_full_name: string;
  repository_provider: string;
  branch: string;
  path: string;
  name: string;
  ext?: string | null;
  size_bytes?: number | null;
  blob_sha?: string | null;
  detected_kind?: string | null;
  /** Normalized format family key, e.g. `openapi`. */
  format: string;
  /** Human label for `format`, e.g. `OpenAPI`. */
  display_kind: string;
  /** `needs_attention` | `imported` | `mapped` | `discovered`. */
  status: string;
  project_id?: string | null;
  project_name?: string | null;
  project_slug?: string | null;
  version_id?: string | null;
  last_imported_at?: string | null;
  discovered_at?: string | null;
  quality_score?: number | null;
  quality_grade?: string | null;
  quality_status?: string | null;
  external_ref_unresolved_count?: number | null;
};

/** One selectable value in a filter dropdown, with its catalog-wide count. */
export type SpecCatalogFacetOption = {
  value: string;
  label: string;
  count: number;
};

/** Filter dropdown options, computed over the whole catalog rather than the filtered page. */
export type SpecCatalogFacets = {
  formats: SpecCatalogFacetOption[];
  statuses: SpecCatalogFacetOption[];
  repositories: SpecCatalogFacetOption[];
  projects: SpecCatalogFacetOption[];
};

/** The catalog API response. */
export type SpecCatalogResponse = {
  success?: boolean;
  catalog_total: number;
  match_count: number;
  limit: number;
  offset: number;
  sort: string;
  specs: SpecCatalogRow[];
  facets?: SpecCatalogFacets | null;
  error?: string;
};

/** Everything that defines "which catalog view am I looking at". */
export type SpecCatalogFilters = {
  /** Free-text search across path, format, repository and project. */
  q: string;
  /** Format family key, or `all`. */
  format: string;
  /** Repository id, or `all`. */
  repositoryId: string;
  /** Project id, or `all`. */
  projectId: string;
  /** Catalog status key, or `all`. */
  status: string;
  /** Ordering key. */
  sort: string;
  /** List non-default branches too. */
  allBranches: boolean;
  /** Hide indexed files that are not spec candidates. */
  importableOnly: boolean;
  /** Rows skipped — the pagination cursor. */
  offset: number;
};

/**
 * Rows per page. 50 matches the per-repository Files browser, so the two tables page at the
 * same rhythm; the server caps any request at 500 regardless.
 */
export const SPEC_CATALOG_PAGE_SIZE = 50;

/** Sort options offered in the toolbar; the values are what REST accepts. */
export const SPEC_CATALOG_SORT_OPTIONS: { value: string; label: string }[] = [
  { value: 'repository', label: 'Repository' },
  { value: 'path', label: 'Path' },
  { value: 'format', label: 'Format' },
  { value: 'status', label: 'Status' },
  { value: 'recent', label: 'Recent activity' },
];

/** The unfiltered catalog view. Anything equal to this is omitted from the browser URL. */
export const DEFAULT_SPEC_CATALOG_FILTERS: SpecCatalogFilters = {
  q: '',
  format: 'all',
  repositoryId: 'all',
  projectId: 'all',
  status: 'all',
  sort: 'repository',
  allBranches: false,
  importableOnly: true,
  offset: 0,
};

/** Read `true`/`1` as true; everything else (including absent) as the supplied default. */
function readBool(raw: string | null, fallback: boolean): boolean {
  if (raw == null || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

/**
 * Rebuild the filter state from a browser URL.
 *
 * @param params - The page's search params.
 * @returns Filters, with anything absent or unparseable falling back to
 *   {@link DEFAULT_SPEC_CATALOG_FILTERS}. A hand-edited or stale URL therefore renders the
 *   closest valid catalog rather than an error.
 */
export function specCatalogFiltersFromSearchParams(
  params: URLSearchParams
): SpecCatalogFilters {
  const rawOffset = Number.parseInt(params.get('offset') ?? '', 10);
  const sort = params.get('sort') ?? '';
  return {
    q: params.get('q') ?? DEFAULT_SPEC_CATALOG_FILTERS.q,
    format: params.get('format') || DEFAULT_SPEC_CATALOG_FILTERS.format,
    repositoryId: params.get('repository_id') || DEFAULT_SPEC_CATALOG_FILTERS.repositoryId,
    projectId: params.get('project_id') || DEFAULT_SPEC_CATALOG_FILTERS.projectId,
    status: params.get('status') || DEFAULT_SPEC_CATALOG_FILTERS.status,
    sort: SPEC_CATALOG_SORT_OPTIONS.some((o) => o.value === sort)
      ? sort
      : DEFAULT_SPEC_CATALOG_FILTERS.sort,
    allBranches: readBool(params.get('all_branches'), DEFAULT_SPEC_CATALOG_FILTERS.allBranches),
    importableOnly: readBool(
      params.get('importable_only'),
      DEFAULT_SPEC_CATALOG_FILTERS.importableOnly
    ),
    offset:
      Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : DEFAULT_SPEC_CATALOG_FILTERS.offset,
  };
}

/**
 * Build the API query string for a catalog view.
 *
 * @param filters - The current filter state.
 * @param options.includeFacets - Ask the server to also compute filter dropdown options. The
 *   page requests this on its first load only; facets are catalog-wide, so paging and
 *   re-filtering never invalidate them and re-requesting them would cost four extra scans.
 * @returns The query string, without a leading `?`. `all` selections are dropped rather than
 *   sent, keeping the request (and the server's predicate list) minimal.
 */
export function specCatalogApiQuery(
  filters: SpecCatalogFilters,
  options?: { includeFacets?: boolean }
): string {
  const qs = new URLSearchParams();
  if (filters.q.trim()) qs.set('q', filters.q.trim());
  if (filters.format !== 'all') qs.set('format', filters.format);
  if (filters.repositoryId !== 'all') qs.set('repository_id', filters.repositoryId);
  if (filters.projectId !== 'all') qs.set('project_id', filters.projectId);
  if (filters.status !== 'all') qs.set('status', filters.status);
  qs.set('sort', filters.sort);
  if (filters.allBranches) qs.set('all_branches', 'true');
  if (!filters.importableOnly) qs.set('importable_only', 'false');
  qs.set('limit', String(SPEC_CATALOG_PAGE_SIZE));
  qs.set('offset', String(Math.max(0, filters.offset)));
  if (options?.includeFacets) qs.set('include_facets', 'true');
  return qs.toString();
}

/**
 * Build the browser URL query for a catalog view.
 *
 * @param filters - The current filter state.
 * @returns The query string without a leading `?`, carrying only what differs from the
 *   default view — so the unfiltered catalog has a clean URL and a shared link is readable.
 */
export function specCatalogUrlQuery(filters: SpecCatalogFilters): string {
  const qs = new URLSearchParams();
  if (filters.q.trim()) qs.set('q', filters.q.trim());
  if (filters.format !== DEFAULT_SPEC_CATALOG_FILTERS.format) qs.set('format', filters.format);
  if (filters.repositoryId !== DEFAULT_SPEC_CATALOG_FILTERS.repositoryId) {
    qs.set('repository_id', filters.repositoryId);
  }
  if (filters.projectId !== DEFAULT_SPEC_CATALOG_FILTERS.projectId) {
    qs.set('project_id', filters.projectId);
  }
  if (filters.status !== DEFAULT_SPEC_CATALOG_FILTERS.status) qs.set('status', filters.status);
  if (filters.sort !== DEFAULT_SPEC_CATALOG_FILTERS.sort) qs.set('sort', filters.sort);
  if (filters.allBranches) qs.set('all_branches', 'true');
  if (!filters.importableOnly) qs.set('importable_only', 'false');
  if (filters.offset > 0) qs.set('offset', String(filters.offset));
  return qs.toString();
}

/** Whether a view differs from the default one — drives the "Clear filters" affordance. */
export function specCatalogHasActiveFilters(filters: SpecCatalogFilters): boolean {
  return (
    filters.q.trim() !== '' ||
    filters.format !== DEFAULT_SPEC_CATALOG_FILTERS.format ||
    filters.repositoryId !== DEFAULT_SPEC_CATALOG_FILTERS.repositoryId ||
    filters.projectId !== DEFAULT_SPEC_CATALOG_FILTERS.projectId ||
    filters.status !== DEFAULT_SPEC_CATALOG_FILTERS.status ||
    filters.allBranches !== DEFAULT_SPEC_CATALOG_FILTERS.allBranches ||
    filters.importableOnly !== DEFAULT_SPEC_CATALOG_FILTERS.importableOnly
  );
}

/** How one catalog status is rendered. */
export type SpecCatalogStatusBadge = {
  label: string;
  className: string;
  title: string;
};

/**
 * Status key → badge. Mirrors `SPEC_STATUS_LABELS` in the REST catalog module; the `title`
 * spells out what the operator can do about the row, since the label alone ("Mapped") does
 * not say whether anything is wrong.
 */
const STATUS_BADGES: Record<string, SpecCatalogStatusBadge> = {
  needs_attention: {
    label: 'Needs attention',
    className: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
    title:
      'Quality scoring failed, or the last scan left external $refs unresolved. Open the spec to see why.',
  },
  imported: {
    label: 'Imported',
    className: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
    title: 'At least one import of this file has produced a version.',
  },
  mapped: {
    label: 'Mapped',
    className: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
    title: 'Bound to a project, but no import has run yet.',
  },
  discovered: {
    label: 'Discovered',
    className: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
    title: 'Indexed by the scanner and not yet mapped to a project.',
  },
};

/**
 * Resolve a status key to its badge.
 *
 * @param status - The row's `status`.
 * @returns The badge; an unknown status degrades to a neutral pill carrying the raw key, so a
 *   status added server-side is still legible before the UI ships support for it.
 */
export function specCatalogStatusBadge(status: string): SpecCatalogStatusBadge {
  return (
    STATUS_BADGES[status] ?? {
      label: status || '—',
      className: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
      title: 'Unrecognised status.',
    }
  );
}

/**
 * Split a repository path into its directory and file name for two-line rendering.
 *
 * @param path - The repository-relative path, e.g. `services/orders/openapi.yaml`.
 * @returns `{ dir, file }`; `dir` is empty for a path at the repository root.
 */
export function splitSpecPath(path: string): { dir: string; file: string } {
  const idx = path.lastIndexOf('/');
  if (idx < 0) return { dir: '', file: path };
  return { dir: path.slice(0, idx + 1), file: path.slice(idx + 1) };
}
