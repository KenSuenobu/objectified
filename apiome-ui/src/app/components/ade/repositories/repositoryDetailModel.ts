/**
 * Every rule the repository detail screen applies (HIVE-7.5, #5322).
 *
 * Authority: `docs/mockups/sources/repository-detail.html` and its **Notes → Keeps (1:1)**
 * list, which is this ticket's acceptance criteria; DESIGN.md §5.3 (page header), §8 (detail
 * page: header → stat strip → tabs) and §3.1 (status vocabulary).
 *
 * The screen this replaces was a 1,094-line client plus four components of 500–1,600 lines
 * each, and every decision below was spelled inline in one of them — often twice, in two
 * spellings that had drifted. Which tab a query string names, what a KPI's figure and its
 * footnote are, how a glob and a regex compose into one request, what the toolbar's count
 * line says, which files a batch import may be narrowed to,
 * why Map & import is unavailable: all of it is here, React-free, so each rule is unit-tested
 * without rendering a screen.
 *
 * The same split `repositoriesModel.ts` (HIVE-7.3) and `addRepositoryModel.ts` (HIVE-7.4) use,
 * and for the same reason: a rule that lives in JSX is a rule that is only ever tested through
 * a DOM, and the ones on this screen — filter composition, deep-link consumption, verdict
 * copy — are the parts most likely to be wrong.
 *
 * ### One vocabulary for stubbed controls
 *
 * The ticket's fourth acceptance criterion is that "stubbed controls remain visually honest".
 * Every stub's sentence is a constant here — {@link RESCAN_STUB_TOAST} and the seven beside
 * it — so a control that does nothing says *why* in the same words wherever it appears, and a
 * test can assert that the words did not quietly become a promise.
 */

import {
  type DashboardRepository,
  type RepositoryProvider,
} from './repositoriesModel';

// ============================================================================
// Tabs and routing
// ============================================================================

/** The five sections the detail screen draws, in the order the tab strip lists them. */
export type RepositoryDetailTab = 'preview' | 'files' | 'specs' | 'imports' | 'settings';

/** Every tab, for the strip and for exhaustive tests. */
export const REPOSITORY_DETAIL_TABS: readonly RepositoryDetailTab[] = [
  'preview',
  'files',
  'specs',
  'imports',
  'settings',
] as const;

/** What each tab is called. */
export const REPOSITORY_DETAIL_TAB_LABEL: Readonly<Record<RepositoryDetailTab, string>> = {
  preview: 'Preview',
  files: 'Files',
  specs: 'Specs',
  imports: 'Imports',
  settings: 'Settings',
};

/** The tab a repository opens on when the URL names none. */
export const DEFAULT_REPOSITORY_DETAIL_TAB: RepositoryDetailTab = 'preview';

/**
 * Narrow a `?tab=` value to a tab.
 *
 * Anything unrecognised — a typo, a tab from a newer build, an absent parameter — yields
 * {@link DEFAULT_REPOSITORY_DETAIL_TAB} rather than an error, so a stale bookmark opens the
 * overview instead of an empty screen.
 *
 * @param value The raw query-string value.
 * @returns The named tab, or the default.
 */
export function parseRepositoryDetailTab(value: string | null | undefined): RepositoryDetailTab {
  const v = (value ?? '').trim().toLowerCase();
  return (REPOSITORY_DETAIL_TABS as readonly string[]).includes(v)
    ? (v as RepositoryDetailTab)
    : DEFAULT_REPOSITORY_DETAIL_TAB;
}

/**
 * The route for one tab of one repository.
 *
 * `/repositories/{id}` redirects to `/{id}/preview`, so the tab is a query parameter on the
 * `preview` route rather than a path segment — which is what lets a tab change be a
 * `router.replace` that does not remount the screen.
 *
 * @param repositoryId The repository.
 * @param tab Which section to open.
 * @returns The href.
 */
export function repositoryDetailTabHref(
  repositoryId: string,
  tab: RepositoryDetailTab
): string {
  const base = `/ade/dashboard/repositories/${encodeURIComponent(repositoryId)}/preview`;
  return tab === DEFAULT_REPOSITORY_DETAIL_TAB ? base : `${base}?tab=${tab}`;
}

/** A request to open one indexed file, carried in the query string. */
export interface RepositoryFileDeepLink {
  /** Repository-relative path of the file to open. */
  path: string;
  /** The branch its index entry lives on. */
  branch: string;
}

/**
 * Read a file deep link out of the query string.
 *
 * Both parts are required — a path without a branch names no index entry — and an explicit
 * `?tab=` for any tab other than Files wins, because a link that says "settings" was not
 * asking to open a file.
 *
 * @param params The page's search parameters.
 * @returns The link, or `null` when the query names none.
 */
export function readRepositoryFileDeepLink(params: URLSearchParams): RepositoryFileDeepLink | null {
  const path = params.get('path')?.trim();
  const branch = params.get('branch')?.trim();
  if (!path || !branch) return null;
  const tab = params.get('tab');
  if (tab != null && tab !== '' && tab !== 'files') return null;
  return { path, branch };
}

/**
 * The tab a URL opens, given both signals.
 *
 * A file deep link implies the Files tab whatever `?tab=` says, because the link's whole
 * purpose is to land on that file.
 *
 * @param params The page's search parameters.
 * @returns The tab to select.
 */
export function repositoryDetailTabFromParams(params: URLSearchParams): RepositoryDetailTab {
  if (readRepositoryFileDeepLink(params)) return 'files';
  return parseRepositoryDetailTab(params.get('tab'));
}

/**
 * Deep link into the Files tab, opening one indexed path on the branch it was imported from.
 *
 * Used by every table that prints a file path — Preview's recent imports, the Imports history,
 * the Specs tab's review link — so all three land in the same place.
 *
 * @param repositoryId The repository.
 * @param path Repository-relative path.
 * @param branch The branch the path was indexed on.
 * @returns The href.
 */
export function repositoryImportedFileHref(
  repositoryId: string,
  path: string,
  branch: string
): string {
  const qs = new URLSearchParams();
  qs.set('tab', 'files');
  qs.set('path', path);
  qs.set('branch', branch);
  return `/ade/dashboard/repositories/${encodeURIComponent(repositoryId)}/preview?${qs.toString()}`;
}

/** Where the repositories list lives — the breadcrumb's second crumb and the error card's way out. */
export const REPOSITORIES_LIST_HREF = '/ade/dashboard/repositories';

/** Where the breadcrumb's first crumb goes. */
export const DASHBOARD_HREF = '/ade/dashboard';

// ============================================================================
// Header
// ============================================================================

/**
 * The provider slug chip's text — `github.com/acme/payments-specs`, or the clone URL's host
 * and path for anything else.
 *
 * Falls back to the stored full name, and then to an em dash, so the chip is never blank for a
 * registration whose clone URL will not parse.
 *
 * @param repo The repository record.
 * @returns The slug to print.
 */
export function repositoryProviderSlug(repo: DashboardRepository): string {
  if (repo.provider === 'github' && repo.full_name && !repo.full_name.includes('://')) {
    return `github.com/${repo.full_name}`;
  }
  if (repo.clone_url) {
    try {
      const u = new URL(repo.clone_url);
      const path = u.pathname.replace(/\.git\/?$/i, '') || '/';
      return `${u.hostname}${path === '/' ? '' : path}`;
    } catch {
      /* Not a URL we can parse; fall through to the stored name. */
    }
  }
  return repo.full_name || '—';
}

/**
 * The repository's page on its provider's website, when there is one.
 *
 * Only GitHub clone URLs resolve today: the other three providers' web hosts are not derivable
 * from a clone URL with any confidence, and a wrong link is worse than none.
 *
 * @param repo The repository record.
 * @returns An absolute URL, or `null`.
 */
export function repositoryWebUrl(repo: DashboardRepository | null | undefined): string | null {
  if (!repo?.clone_url) return null;
  const u = repo.clone_url.replace(/\.git$/i, '');
  if (repo.provider === 'github' && u.includes('github.com')) return u;
  return null;
}

/** The line under the title when the provider metadata carried no description. */
export const REPOSITORY_NO_DESCRIPTION =
  'No description from the provider metadata on this registration.';

/**
 * The description to print, or the standing fallback.
 *
 * @param repo The repository record.
 * @returns The description sentence.
 */
export function repositoryDescriptionLine(repo: DashboardRepository): string {
  return repo.description?.trim() ? repo.description : REPOSITORY_NO_DESCRIPTION;
}

// ============================================================================
// The KPI row
// ============================================================================

/** One figure in the strip above the tabs. */
export interface RepositoryDetailKpi {
  /** Stable key, for `data-testid` and for React. */
  key: 'files' | 'importable' | 'branches' | 'imports' | 'scan';
  /** The caps label. */
  label: string;
  /** The figure, already localised. `—` when there is nothing to print. */
  value: string;
  /** The line under the figure. */
  footnote: string;
  /** The long-form explanation, on hover and as the cell's `title`. */
  tooltip: string;
  /** True while a scan is running and the figure is still moving. */
  pending: boolean;
  /** True when the figure is an em dash standing in for an unmeasured value. */
  unwired: boolean;
}

/** Everything the strip needs that does not live on the repository record. */
export interface RepositoryDetailKpiInputs {
  /** Rolling 30-day import totals, or `null` while they load or after a failed read. */
  stats30d: { totalImports: number; distinctProjects: number } | null;
  /** True while the import metrics request is in flight. */
  importsLoading: boolean;
  /** The estimated per-kind split, or `null` when `importable_count` is unset. */
  importableMix: { openapi: number; arazzo: number; jsonSchema: number } | null;
  /** Already-formatted "2h ago" / "Never scanned" phrase from `formatLastScan`. */
  lastScanLabel: string;
}

/** Why *Importable estimate* is a split of one total rather than five real tallies. */
export const IMPORTABLE_ESTIMATE_UNWIRED =
  '`importable_count` is null until detection runs and persists per-repo totals.';

/** Why *Branches* is only filled for GitHub. */
export const BRANCHES_GITHUB_ONLY_NOTE =
  'Branch totals are only filled for GitHub registrations today; other providers return no count.';

/** Where *Files indexed* comes from, and what it still cannot say. */
export const FILES_INDEXED_NOTE =
  'From `total_files` after tree indexing; directory counts need scan metadata (not stored yet).';

/**
 * The five figures above the tabs.
 *
 * Each one states where it comes from, and each one that cannot be measured yet says so rather
 * than printing a zero — the rule HIVE-7.3's strip already set, and the reason *Importable
 * estimate* carries the word "estimate" in its own label.
 *
 * @param repo The repository record.
 * @param inputs The figures that are read separately from the repository row.
 * @returns The five KPIs, in display order.
 */
export function repositoryDetailKpis(
  repo: DashboardRepository,
  inputs: RepositoryDetailKpiInputs
): RepositoryDetailKpi[] {
  const scanning = repo.status === 'scanning';
  const files = repo.total_files ?? 0;
  const importable = repo.importable_count;
  const branches = repo.branch_count;
  const { stats30d, importsLoading, importableMix, lastScanLabel } = inputs;
  const importsUnknown = importsLoading && stats30d == null;

  const importableShare =
    importable != null && files > 0
      ? `${((importable / files) * 100).toFixed(1)}% of files`
      : 'share needs an indexed tree';

  return [
    {
      key: 'files',
      label: 'Files indexed',
      value: files.toLocaleString(),
      footnote: `on ${repo.default_branch}`,
      tooltip: FILES_INDEXED_NOTE,
      pending: scanning,
      unwired: false,
    },
    {
      key: 'importable',
      label: 'Importable estimate',
      value: importable != null ? importable.toLocaleString() : '—',
      footnote: importable != null ? importableShare : 'not detected yet',
      tooltip:
        importable != null && importableMix
          ? `Estimated mix from this repo’s total: OpenAPI ${importableMix.openapi.toLocaleString()}, Arazzo ${importableMix.arazzo.toLocaleString()}, JSON Schema ${importableMix.jsonSchema.toLocaleString()}. Split is a placeholder until indexed paths return real per-kind tallies.`
          : IMPORTABLE_ESTIMATE_UNWIRED,
      pending: scanning,
      unwired: importable == null,
    },
    {
      key: 'branches',
      label: 'Branches',
      value: branches != null ? branches.toLocaleString() : '—',
      footnote: 'GitHub only',
      tooltip:
        repo.provider === 'github'
          ? '`branch_count` from GitHub at registration (paginated list-branches). Non-GitHub providers are not counted yet.'
          : BRANCHES_GITHUB_ONLY_NOTE,
      pending: scanning,
      unwired: branches == null,
    },
    {
      key: 'imports',
      label: 'Imports (30d)',
      value: importsUnknown ? '—' : (stats30d?.totalImports ?? 0).toLocaleString(),
      footnote: importsUnknown
        ? 'loading…'
        : stats30d != null && stats30d.totalImports > 0
          ? `${stats30d.distinctProjects.toLocaleString()} distinct project${stats30d.distinctProjects === 1 ? '' : 's'} in the last 30 days`
          : 'none in the last 30 days',
      tooltip: 'Catalog imports from this repo’s Files tab in the last 30 days.',
      pending: scanning,
      unwired: importsUnknown,
    },
    {
      key: 'scan',
      label: 'Last scan',
      value: lastScanLabel,
      footnote:
        repo.status === 'error'
          ? 'failed'
          : repo.last_scanned_at == null
            ? 'never run'
            : 'succeeded',
      tooltip:
        repo.last_scanned_at != null
          ? repo.status === 'error'
            ? 'Last job reported an error; details will map from scan job records.'
            : 'From `last_scanned_at` on this repository row (full diff summaries require scan job API).'
          : '`last_scanned_at` is unset until the first completed indexing job writes it.',
      pending: scanning,
      unwired: repo.last_scanned_at == null,
    },
  ];
}

// ============================================================================
// Preview
// ============================================================================

/** The sentence that opens the Preview tab. */
export const PREVIEW_INTRO =
  'Snapshot of this repository’s registration, scan posture, and import activity. More detail appears here as scan jobs and import history are exposed through the API.';

/** How many recent imports Preview lists before deferring to the Imports tab. */
export const PREVIEW_IMPORTS_SHOWN = 8;

/** What Preview says when the repository has never been scanned. */
export const NO_RECENT_SCANS = 'No recent scans';

/** What Preview's table says before the first import. */
export const NO_IMPORTS_YET =
  'No imports yet. Open the Files tab, select a spec, and complete a catalog import to record activity here.';

/** What the Imports tab says before the first import. */
export const NO_IMPORTS_RECORDED =
  'No imports recorded yet. Use the Files tab to open a specification and run an import.';

/**
 * The footer under Preview's imports table — how many of the whole history it is showing.
 *
 * @param shown Rows drawn.
 * @param total Rows the repository has.
 * @returns The footer phrase.
 */
export function previewImportsFootLabel(shown: number, total: number): string {
  if (total === 0) return 'No imports';
  if (shown >= total) return `${total.toLocaleString()} import${total === 1 ? '' : 's'}`;
  return `${shown.toLocaleString()} of ${total.toLocaleString()} imports`;
}

// ============================================================================
// Import history rows
// ============================================================================

/**
 * A blob SHA at the length a table column can hold — seven characters and an ellipsis, the
 * length git itself abbreviates to.
 *
 * @param sha The full SHA, or null.
 * @returns The short form, or an empty string when there is no SHA.
 */
export function shortBlobRef(sha: string | null | undefined): string {
  if (!sha?.trim()) return '';
  const s = sha.trim();
  return s.length > 10 ? `${s.slice(0, 7)}…` : s;
}

/**
 * Who ran an import — their name, else their email, else an em dash.
 *
 * @param row The import row's actor columns.
 * @returns The name to print.
 */
export function formatImportedByActor(row: {
  imported_by_name: string | null;
  imported_by_email: string | null;
}): string {
  const n = row.imported_by_name?.trim();
  if (n) return n;
  const e = row.imported_by_email?.trim();
  if (e) return e;
  return '—';
}

/**
 * "2h ago" for a past timestamp, falling back to the absolute date past a week.
 *
 * @param iso An ISO-8601 timestamp.
 * @param now Reference epoch milliseconds; a parameter so tests need no fake clock.
 * @returns The relative phrase.
 */
export function formatRelativeWhen(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const sec = Math.floor((now - t) / 1000);
  if (sec < 45) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 604800) return `${Math.floor(sec / 86400)}d ago`;
  return new Date(iso).toLocaleString();
}

// ============================================================================
// The Files tab: filters
// ============================================================================

/** One entry of the *Importable preset* menu, verbatim from the mockup. */
export interface RepositoryFilePreset {
  value: string;
  label: string;
}

/** The eleven presets, in the mockup's order. */
export const REPOSITORY_FILE_PRESETS: readonly RepositoryFilePreset[] = [
  { value: 'all', label: 'All importable types' },
  { value: 'openapi', label: 'OpenAPI (openapi.*, swagger.*)' },
  { value: 'arazzo', label: 'Arazzo' },
  { value: 'asyncapi', label: 'AsyncAPI' },
  { value: 'json_schema', label: 'JSON Schema (*.schema.json, schemas/**)' },
  { value: 'graphql', label: 'GraphQL SDL' },
  { value: 'protobuf', label: 'Protobuf (*.proto)' },
  { value: 'avro', label: 'Avro (*.avsc)' },
  { value: 'postman', label: 'Postman collection' },
  { value: 'sql_ddl', label: 'SQL DDL (*.sql, *.ddl)' },
  { value: 'custom', label: 'Custom — specify glob below' },
] as const;

/** The whole toolbar's state — the three text inputs and the three switches. */
export interface RepositoryFileFilterState {
  preset: string;
  glob: string;
  regex: string;
  hideNonImportable: boolean;
  includeHidden: boolean;
  skipVendor: boolean;
}

/** What Reset returns the toolbar to, and what it opens with. */
export const EMPTY_REPOSITORY_FILE_FILTERS: RepositoryFileFilterState = {
  preset: 'all',
  glob: '',
  regex: '',
  hideNonImportable: true,
  includeHidden: false,
  skipVendor: true,
};

/** How long a text filter waits before it re-reads. */
export const FILE_FILTER_DEBOUNCE_MS = 200;

/** How many rows one page of the file table holds. */
export const FILE_PAGE_SIZE = 50;

/**
 * True when the toolbar is narrowing the list at all.
 *
 * Used for the "clear filters" affordance on an empty result: an empty page with the default
 * filters means the tree is empty, and an empty page with a regex means the regex is wrong.
 * They are different problems and get different copy.
 *
 * @param filters The current toolbar state.
 * @returns Whether anything is narrowed.
 */
export function isRepositoryFileListNarrowed(filters: RepositoryFileFilterState): boolean {
  return (
    filters.preset !== EMPTY_REPOSITORY_FILE_FILTERS.preset ||
    filters.glob.trim() !== '' ||
    filters.regex.trim() !== '' ||
    filters.hideNonImportable !== EMPTY_REPOSITORY_FILE_FILTERS.hideNonImportable ||
    filters.includeHidden !== EMPTY_REPOSITORY_FILE_FILTERS.includeHidden ||
    filters.skipVendor !== EMPTY_REPOSITORY_FILE_FILTERS.skipVendor
  );
}

/**
 * Escape a path so it can be matched literally by the listing endpoint's POSIX regex.
 *
 * @param path The path to match.
 * @returns The escaped pattern body.
 */
export function escapeRegexPath(path: string): string {
  return path.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

/**
 * Build the query for one page of the file listing.
 *
 * The one rule worth stating: **regex wins over preset and glob.** They are three ways of
 * narrowing the same column and the endpoint applies one, so a filled regex box silently
 * disabling the other two would be a filter that lies. The toolbar disables the glob field
 * while a regex is present and this function makes the same choice, so the request can never
 * disagree with what the reader sees.
 *
 * A deep link is stricter still: it asks for one exact path with the importable filter off,
 * because the file that a link names has to open whether or not the current filters would
 * have shown it.
 *
 * @param filters The toolbar state, already debounced.
 * @param page Where in the result set to read from.
 * @param deepLink When present, the one path to open instead of the filtered list.
 * @returns The search parameters for `GET /api/repositories/{id}/files`.
 */
export function repositoryFilesQuery(
  filters: RepositoryFileFilterState,
  page: { branch: string; offset: number; limit?: number },
  deepLink?: RepositoryFileDeepLink | null
): URLSearchParams {
  const qs = new URLSearchParams();
  qs.set('branch', deepLink?.branch ?? page.branch);
  qs.set('limit', String(page.limit ?? FILE_PAGE_SIZE));
  qs.set('offset', String(deepLink ? 0 : page.offset));

  if (deepLink) {
    qs.set('regex', `^${escapeRegexPath(deepLink.path)}$`);
    qs.set('hide_non_importable', 'false');
  } else if (filters.regex.trim()) {
    qs.set('regex', filters.regex.trim());
    qs.set('hide_non_importable', filters.hideNonImportable ? 'true' : 'false');
  } else {
    if (filters.preset) qs.set('preset', filters.preset);
    if (filters.glob.trim()) qs.set('glob', filters.glob.trim());
    qs.set('hide_non_importable', filters.hideNonImportable ? 'true' : 'false');
  }

  qs.set('skip_vendor', filters.skipVendor ? 'true' : 'false');
  qs.set('include_hidden', filters.includeHidden ? 'true' : 'false');
  return qs;
}

// ============================================================================
// The Files tab: the table
// ============================================================================

/**
 * A byte count at the precision a table column can hold.
 *
 * @param n The size in bytes, or null.
 * @returns "64 KB", "1.2 MB", or an em dash.
 */
export function formatFileBytes(n: number | null | undefined): string {
  if (n == null || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * A blob SHA at git's own abbreviation length, for the table's Blob column.
 *
 * @param sha The full SHA, or null.
 * @returns Seven characters, or an em dash.
 */
export function shortSha(sha: string | null | undefined): string {
  if (!sha) return '—';
  const s = sha.trim();
  return s.length > 7 ? s.slice(0, 7) : s;
}

/** How a file's kind was decided, and how confident that makes the classification. */
export interface RepositoryFileConfidence {
  /** The chip's word. */
  label: string;
  /** Its tone in the shared status vocabulary. */
  tone: 'ok' | 'outline';
}

/**
 * Read the confidence column.
 *
 * A kind guessed from a filename is the weaker of the two answers, so it is the outline chip;
 * anything the indexer read out of the file's own content is `ok`. Two tones, because there
 * are two facts, and the mockup's own table draws exactly this pair.
 *
 * @param confidence The raw value from the listing endpoint.
 * @returns The chip's label and tone.
 */
export function repositoryFileConfidence(confidence: string): RepositoryFileConfidence {
  const c = (confidence ?? '').toLowerCase();
  if (c === 'filename' || c.includes('filename')) return { label: 'filename', tone: 'outline' };
  return { label: confidence || '—', tone: 'ok' };
}

/**
 * The table toolbar's count line — matches, importable, and the current selection.
 *
 * @param counts What the last read returned, and how many rows are ticked.
 * @returns The sentence, with an em dash for a figure that has not arrived.
 */
export function repositoryFilesSummaryLine(counts: {
  matchCount: number | null;
  importableCount: number | null;
  selectedCount: number;
}): string {
  const match = counts.matchCount != null ? counts.matchCount.toLocaleString() : '—';
  const importable = counts.importableCount != null ? counts.importableCount.toLocaleString() : '—';
  const base = `${match} files match · ${importable} importable`;
  return counts.selectedCount > 0
    ? `${base} · ${counts.selectedCount.toLocaleString()} selected`
    : base;
}

/**
 * The pager's position line.
 *
 * @param page Offset, rows on this page, and the total the filter matched.
 * @returns "Showing 1–50 of 1,204", or an em dash before the first read.
 */
export function repositoryFilesShowingLine(page: {
  offset: number;
  rows: number;
  matchCount: number;
}): string {
  if (page.matchCount <= 0 || page.rows <= 0) return '—';
  const from = page.offset + 1;
  const to = page.offset + page.rows;
  return `Showing ${from.toLocaleString()}–${to.toLocaleString()} of ${page.matchCount.toLocaleString()}`;
}

/** What the file table says when a scan has produced nothing for this branch. */
export const FILES_EMPTY_COPY =
  'No indexed files for this branch yet. Run a successful repository scan, or widen filters (turn off “Hide non-importable”, clear regex).';

/** What a deep link says when the path it names has left the index. */
export const DEEP_LINK_MISS_TOAST =
  'That file is not in the repository index for this branch anymore.';

/** The Quality column's header tooltip, kept verbatim. */
export const QUALITY_COLUMN_TOOLTIP =
  'Rough 0–100 quality score for classified specs. Informational only — it does not gate import or sync.';

// ============================================================================
// The branch bar
// ============================================================================

/** The standing note about what the index does and does not know about a branch tip. */
export const BRANCH_TIP_NOTE =
  'Tip commit / age from git is not stored yet; indexed tree uses blob SHAs in the table.';

/**
 * "1,204 files on main".
 *
 * @param indexedTotal Every file the branch's index holds, or null before the first read.
 * @param branch The branch name.
 * @returns The phrase.
 */
export function branchFileCountLine(indexedTotal: number | null | undefined, branch: string): string {
  const n = indexedTotal != null ? indexedTotal.toLocaleString() : '—';
  return `${n} files on ${branch}`;
}

/** Why "Diff vs default" is disabled with only one indexed branch. */
export const DIFF_VS_DEFAULT_NEEDS_BRANCHES =
  'Add another indexed branch to diff against default.';

/** Why the branch popover's Tags half is disabled. */
export const TAGS_UNAVAILABLE = 'Tag-scoped indexes are not available yet.';

// ============================================================================
// Stub vocabulary
// ============================================================================
// Every control on this screen that draws but does not act, and the sentence it says. One
// constant each, so the same stub cannot promise two different things on two tabs — the
// ticket's "stubbed controls remain visually honest" criterion.

/** Header → Rescan. */
export const RESCAN_STUB_TOAST = 'Rescan runs when scan jobs are wired to the API.';

/** Header → Rescan, while one is already running. */
export const RESCAN_IN_PROGRESS_TITLE = 'A scan is already in progress.';

/** Preview → View scan history. */
export const SCAN_HISTORY_STUB_TOAST =
  'Scan history needs a `tenant_repository_scan_jobs` (or similar) collection exposed over REST.';

/** Files → branch popover → Compare branches. */
export const COMPARE_BRANCHES_STUB_TOAST =
  'Branch compare uses git metadata not wired to the API yet.';

/** Files → branch popover → Refresh from remote. */
export const REFRESH_FROM_REMOTE_STUB_TOAST =
  'Refresh enqueues a new scan job when that endpoint exists.';

/** Files → branch bar → Rescan branch. */
export const RESCAN_BRANCH_STUB_TOAST =
  'Rescan branch will enqueue a file scan job when exposed on the API.';

/** Files → branch bar → Diff vs default. */
export const DIFF_VS_DEFAULT_STUB_TOAST = 'Diff vs default branch is not implemented yet.';

/** File detail → Diff vs latest import. */
export const FILE_DIFF_STUB_COPY =
  'Unified diff vs the last version imported from this path requires import history joined to blob SHAs. Not wired yet.';

/** Settings → Subpath glob. */
export const SUBPATH_GLOB_STUB_NOTE =
  'Not stored on `tenant_repositories` yet — coming with scan-settings.';

/** Settings → Webhook. */
export const WEBHOOK_STUB_NOTE =
  'Inactive — delivery logs will mirror webhook worker tables when added.';

/** Settings → Schedule. */
export const SCHEDULE_STUB_VALUE = 'Not configured';

/** Settings → Default importer mappings, which has nothing to list and nothing to add. */
export const IMPORTER_MAPPINGS_EMPTY = 'No mappings saved for this repository yet.';

/** Why *Add mapping* is disabled. */
export const IMPORTER_MAPPINGS_STUB_NOTE =
  'Maps glob → detected kind → default project hints for the import wizard. Needs persistence before a mapping can be saved.';

/** Map & import → the Diff placeholder tiles. */
export const MAP_IMPORT_DIFF_STUB_COPY =
  'Unified structural diff vs the last catalog version imported from this repository path needs `repository_import` rows joined to blob SHAs. Until that API exists, counts and line items are not shown.';

// ============================================================================
// Settings
// ============================================================================

/** What the auto-refresh switch governs. */
export const AUTO_REFRESH_DESCRIPTION =
  'When on, this repository is rescanned on its cadence and changed files are re-imported automatically. Turn it off to pause auto-refresh for this repo. Manual “Refresh now” is unaffected.';

/** The danger zone's one sentence. */
export const REMOVE_REPOSITORY_DESCRIPTION =
  'Removes this repository from the tenant list (soft-delete). You can register the same clone URL again later if needed.';

/**
 * The remove dialog's question.
 *
 * The verb and the consequence come from {@link removeRepositoryConfirm} in
 * `repositoriesModel`, which the list page's row menu already asks — one confirm for one
 * destructive act, wherever it is reached from. This is only the sentence the detail screen's
 * `AlertDialog` prints under its title.
 *
 * @param name The repository's name, or a fallback when it has not loaded.
 * @returns The confirm copy.
 */
export function removeRepositoryPrompt(name: string | null | undefined): string {
  const n = name?.trim() || 'this repository';
  return `Remove “${n}” from this workspace? You can add it again later from Repositories → Add repository.`;
}

/** What the screen says while the repository record loads. */
export const REPOSITORY_LOADING = 'Loading repository…';

/** The error card's heading when the record cannot be read. */
export const REPOSITORY_UNAVAILABLE = 'Repository unavailable';

/** The gate shown to a session with no workspace selected. */
export const REPOSITORY_NO_TENANT = 'Repositories are registered against one workspace.';

/**
 * How a provider is named in the Settings → Source card.
 *
 * @param provider The provider.
 * @param source How the registration was made (`linked_account` / `public_url`).
 * @returns The provider name and, in parentheses, how it was registered.
 */
export function repositorySourceLine(
  provider: RepositoryProvider,
  source: string | null | undefined
): string {
  const name =
    provider === 'public_url'
      ? 'Public URL'
      : provider.charAt(0).toUpperCase() + provider.slice(1);
  if (source === 'linked_account') return `${name} (linked account)`;
  if (source === 'public_url') return `${name} (public URL)`;
  return name;
}
