/**
 * Discovered specs — the rules behind `/ade/dashboard/repositories/catalog` (HIVE-7.6, #5323).
 *
 * Authority: `docs/mockups/sources/repository-catalog.html` and its **Notes → Keeps (1:1)**
 * list; DESIGN.md §3.1 (status vocabulary) and §8 (list page).
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
 *
 * ### What HIVE-7.6 changed
 *
 * `specCatalogStatusBadge` used to carry four pairs of Tailwind palette classes
 * (`bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 …`). It now returns the *status
 * string* and lets `ui/Badge` resolve the tone through `ui/statusVocabulary`, which is the
 * ticket's "status strings use the shared vocabulary" criterion: the four catalog states are
 * entries in that one table, so a spec that is `imported` is the same green as a version that
 * is `published`.
 *
 * The copy the screen draws also moved here from the component. Every empty, filtered, error,
 * loading and no-workspace sentence in the mockup's **States** list is a constant below, so
 * the rendered test and the browser fixture assert against the same string the screen prints.
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

/**
 * Everything in a view except the search term.
 *
 * The screen holds `q` in the search box (which owns its own debounce) and the rest in one
 * state object; holding the term in both places is what lets the two disagree. Written out
 * field by field rather than as a rest destructure so that adding a filter to
 * {@link SpecCatalogFilters} without adding it here is a compile error rather than a field
 * that silently stops surviving a "Clear filters".
 *
 * @param filters - A whole view.
 * @returns The view minus its search term.
 */
export function specCatalogOptionsOf(
  filters: SpecCatalogFilters
): Omit<SpecCatalogFilters, 'q'> {
  return {
    format: filters.format,
    repositoryId: filters.repositoryId,
    projectId: filters.projectId,
    status: filters.status,
    sort: filters.sort,
    allBranches: filters.allBranches,
    importableOnly: filters.importableOnly,
    offset: filters.offset,
  };
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
  /** The word the pill prints. */
  label: string;
  /**
   * The shared-vocabulary string `ui/Badge` resolves the tone from.
   *
   * Not a class list. All four states are entries in `ui/statusVocabulary`'s one table, so
   * `imported` is the same green as a published version and `needs_attention` the same amber
   * as a degraded endpoint — which is the point of having a vocabulary at all.
   */
  status: string;
  /** What the operator can do about the row, as the pill's `title`. */
  title: string;
};

/**
 * Status key → badge. Mirrors `SPEC_STATUS_LABELS` in the REST catalog module; the `title`
 * spells out what the operator can do about the row, since the label alone ("Mapped") does
 * not say whether anything is wrong.
 *
 * The order is the mockup's own — worst first — and the status-vocabulary reference card
 * renders it in exactly this sequence.
 */
const STATUS_BADGES: Record<string, SpecCatalogStatusBadge> = {
  needs_attention: {
    label: 'Needs attention',
    status: 'needs_attention',
    title:
      'Quality scoring failed, or the last scan left external $refs unresolved. Open the spec to see why.',
  },
  imported: {
    label: 'Imported',
    status: 'imported',
    title: 'At least one import of this file has produced a version.',
  },
  mapped: {
    label: 'Mapped',
    status: 'mapped',
    title: 'Bound to a project, but no import has run yet.',
  },
  discovered: {
    label: 'Discovered',
    status: 'discovered',
    title: 'Indexed by the scanner and not yet mapped to a project.',
  },
};

/**
 * The four states, worst first — the reference card the mockup's **Adds** list introduces.
 *
 * Derived from {@link STATUS_BADGES} rather than restated, so the card and the rows can never
 * disagree about what a state is called or what it means.
 */
export const SPEC_CATALOG_STATUS_VOCABULARY: readonly SpecCatalogStatusBadge[] =
  Object.values(STATUS_BADGES);

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
      // Not in the vocabulary, so `statusTone` resolves it to `neutral` — the honest answer
      // for a state this build has not been told about, and never a wrong colour.
      status: status || 'unknown',
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

// ---------------------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------------------
//
// Every sentence the screen prints, in one place. The mockup's **States** list is the
// contract, and a constant is what lets the rendered suite, the browser fixture and the
// screen assert against the same string rather than three copies of it.

/** The live region while the first page is in flight. */
export const SPEC_CATALOG_LOADING = 'Loading discovered specs…';

/** The heading a failed read gets. The message beside it is whatever the server said. */
export const SPEC_CATALOG_ERROR_TITLE = 'Could not load the spec catalog';

/** The fallback message when a failed read carried no explanation of its own. */
export const SPEC_CATALOG_ERROR_FALLBACK = 'Could not load the spec catalog.';

/** Nothing has been discovered anywhere in the workspace. */
export const SPEC_CATALOG_EMPTY_TITLE = 'No specs discovered yet';

/** …and what to do about it. */
export const SPEC_CATALOG_EMPTY_DESC =
  'Register a repository and run a scan; discovered specs land here automatically.';

/** The filters left nothing — a different fact from an empty catalog, so a different card. */
export const SPEC_CATALOG_FILTERED_TITLE = 'No specs match these filters';

/** …and what to do about that. */
export const SPEC_CATALOG_FILTERED_DESC =
  'Widen the search, or clear the filters to see the whole catalog.';

/** The workspace gate: the catalog spans the repositories of exactly one tenant. */
export const SPEC_CATALOG_NO_TENANT =
  'The spec catalog spans the repositories of one tenant, so pick one to see what has been discovered.';

/**
 * The note under the filter row.
 *
 * It states two things the screen does that a reader would otherwise have to discover: the
 * view is in the address bar, and a slow earlier response is dropped rather than allowed to
 * overwrite a faster later one.
 */
export const SPEC_CATALOG_URL_NOTE =
  'Filters are mirrored to the address bar, so this view is a link you can share.';

/** The section heading of the status-vocabulary reference card. */
export const SPEC_CATALOG_VOCABULARY_TITLE = 'Status vocabulary';

/**
 * The page description: what the catalog is, and how much of it there is.
 *
 * @param catalogTotal - How many specs are indexed across the workspace, or null before the
 *   first response has arrived.
 * @returns The sentence under the page title. The count is left off entirely until it is
 *   known — "0 indexed" while a read is in flight is a claim, not a placeholder.
 */
export function specCatalogSummaryLine(catalogTotal: number | null | undefined): string {
  const base = 'Every spec the scanner has found across all repositories in this tenant.';
  if (catalogTotal == null || !Number.isFinite(catalogTotal)) return base;
  return `${base} ${catalogTotal.toLocaleString()} indexed.`;
}

/**
 * The table foot's range sentence.
 *
 * Written here rather than taken from `dataTableRangeLabel` because this table is paged by
 * the *server*: it holds an offset and a match count, not a page number, and converting one
 * into the other only to have the helper convert it back is a round trip that can disagree
 * with itself on the last page.
 *
 * @param offset - Rows skipped by the current request.
 * @param shown - How many rows this page actually returned.
 * @param matchCount - How many rows matched in total.
 * @returns `Showing 1–50 of 128`, or `No specs` when nothing matched.
 */
export function specCatalogRangeLabel(
  offset: number,
  shown: number,
  matchCount: number
): string {
  if (shown <= 0 || matchCount <= 0) return 'No specs';
  const first = Math.max(0, offset) + 1;
  const last = Math.max(0, offset) + shown;
  return `Showing ${first.toLocaleString()}–${last.toLocaleString()} of ${matchCount.toLocaleString()}`;
}

/**
 * The unresolved-`$ref` warning a row carries, or null when it carries none.
 *
 * @param count - `external_ref_unresolved_count` off the row.
 * @returns The sentence, pluralised, or null.
 */
export function unresolvedRefsNote(count: number | null | undefined): string | null {
  const n = typeof count === 'number' && Number.isFinite(count) ? Math.trunc(count) : 0;
  if (n <= 0) return null;
  return `${n} unresolved external $ref${n === 1 ? '' : 's'}`;
}

/**
 * Render a byte count for the Size column, or an em dash when the scanner recorded none.
 *
 * @param bytes - The row's `size_bytes`.
 * @returns A short string such as `4 KB`, `210 KB`, `1.4 MB`; `—` when there is no figure.
 */
export function formatSpecSize(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    const mb = bytes / (1024 * 1024);
    return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Render a row's last-activity timestamp as a short local date.
 *
 * @param iso - An ISO 8601 timestamp, or null.
 * @returns The date, or `—` when there is none or it cannot be parsed.
 */
export function formatSpecDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
