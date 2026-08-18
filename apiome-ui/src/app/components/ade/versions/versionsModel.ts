/**
 * The rules the Versions screen runs on (HIVE-6.2, #5313).
 *
 * Authority: `docs/mockups/build/versions.html` and its **Notes → Keeps (1:1)** list;
 * `docs/mockups/DESIGN.md` §8 (list page, destructive confirms) and §3.1 (status vocabulary).
 *
 * `/ade/dashboard/versions` is the largest screen in the app, and the ticket's brief is to
 * re-skin it *without re-architecting it*: the 6.3k-line `page.tsx` keeps every piece of
 * state and every write it has today. What moves out is the part that never needed to be in
 * a component in the first place — which chip counts what, how a `DataTable` sort maps onto
 * the timeline's own comparator, what the foot sentence reads, what a version's mock label
 * says, what the delete confirm asks, and — the ticket's one behavioural rule — how a
 * `FEATURE_GITLIKE`-gated affordance is treated in a build where the flag is off.
 *
 * Everything here is pure and React-free. There is no colour and no class name in this
 * file: a tone is looked up from `ui/statusVocabulary` by the component that paints it.
 *
 * @see `./VersionsTable.tsx`, `./VersionRowMenu.tsx`, `./VersionsBanners.tsx` — the
 *   components these rules serve.
 * @see `@/app/utils/versions-dashboard-sort` — the comparators, which predate this ticket and
 *   are unchanged; this module only bridges them to `DataTable`'s sort state.
 */

import type { DataTableSortState } from '@/app/components/ui/DataTable';
import {
  destructiveConfirm,
  type DestructiveConfirmOptions,
} from '@/app/components/dialogs/destructiveConfirm';
import type { ConfirmDialogProps } from '@/app/components/dialogs/ConfirmDialog';
import { FEATURE_GITLIKE } from '@lib/feature-flags';
import { countsSummary, type VersionChangelogSummary } from '@lib/version-changelog';
import { formatVersionWithPrefix } from '@/app/utils/version-display';
import {
  sortVersionsDashboardRows,
  type VersionsDashboardSortColumn,
  type VersionsDashboardSortDirection,
} from '@/app/utils/versions-dashboard-sort';

// ---------------------------------------------------------------------------------------
// The rows
// ---------------------------------------------------------------------------------------

/**
 * One project, as the versions screen reads it from `/api/projects?include_catalog=true`.
 *
 * `publishable` is `false` for catalog items (OpenAPI-worthy non-OpenAPI imports), which are
 * never publish candidates (MFI-23.8, #4017). Older payloads may omit it; an absent flag is
 * treated as publishable.
 */
export interface Project {
  id: string;
  name: string;
  slug: string;
  publishable?: boolean;
}

/** One revision, as `/api/versions?projectId=…` returns it. */
export interface Version {
  id: string;
  project_id: string;
  creator_id: string;
  version_id: string;
  shortMessage: string | null;
  changelog: string | null;
  enabled: boolean;
  published: boolean;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  creator_name: string;
  creator_email: string;
  parent_version_id?: string | null;
  merge_parent_version_id?: string | null;
  forkedFromRevisionId?: string | null;
  upstreamProjectId?: string | null;
  forkSourceVersionLabel?: string | null;
  forkSourceProjectName?: string | null;
  upstreamProjectName?: string | null;
  revisionLocked?: boolean;
  /** Governance lifecycle (#739): stable | beta | deprecated | archived */
  lifecycle?: string;
  /** Revision JSON (#507, #748): deprecation, sunsetAt, successorRevisionId, … */
  metadata?: Record<string, unknown>;
  /** Optional commit author string (REST: author / commit_author, #2579) */
  author?: string | null;
  /** Optional full commit message body (REST: message / commit_message, #2579) */
  message?: string | null;
  /** Hosted mock toggle state (#4422, SIM-2.1) */
  mockEnabled?: boolean;
  /** Private draft mock flag (#4446, SIM-2.5) */
  mockPrivate?: boolean;
  /** Stable mock base URL, set by REST when the mock is enabled (#4422) */
  mockBaseUrl?: string | null;
  /** Quality score stored on the version record (#5259); null when the revision is unscored. */
  qualityScore?: number | null;
  /** A-F grade stored on the version record (#5259); null when the revision is unscored. */
  qualityGrade?: string | null;
}

/** One named branch, as `/api/projects/{id}/version-branches` returns it. */
export interface VersionBranchRow {
  id: string;
  name: string;
  tip_version_id: string;
  tip_version_string?: string;
  created_at?: string;
  created_by?: string | null;
  protected?: boolean;
  /** Project default branch (cannot be deleted). */
  is_default?: boolean;
}

/** One version tag, as `/api/projects/{id}/version-tags` returns it. */
export interface VersionTagRow {
  id: string;
  name: string;
  version_id: string;
  target_version_string?: string;
  message?: string | null;
  channel?: string | null;
  immutable?: boolean;
  protected?: boolean;
  created_by?: string | null;
}

/**
 * Whether a named branch may never be deleted — the project default, or one called `main`.
 *
 * @param branch The branch.
 * @returns `true` when the Remove action must be withheld.
 */
export function isVersionBranchNonDeletable(
  branch: Pick<VersionBranchRow, 'name' | 'is_default'>
): boolean {
  if (branch.is_default) return true;
  return branch.name.trim().toLowerCase() === 'main';
}

// ---------------------------------------------------------------------------------------
// Lifecycle, status, and the words for them
// ---------------------------------------------------------------------------------------

/** The governance lifecycle values (#739), in the order the filter offers them. */
export const VERSION_LIFECYCLES = ['stable', 'beta', 'deprecated', 'archived'] as const;

export type VersionLifecycle = (typeof VERSION_LIFECYCLES)[number];

/** The lifecycle labels, capitalised for a badge or a select. */
export const VERSION_LIFECYCLE_LABEL: Readonly<Record<VersionLifecycle, string>> = {
  stable: 'Stable',
  beta: 'Beta',
  deprecated: 'Deprecated',
  archived: 'Archived',
};

/**
 * A revision's lifecycle, normalised.
 *
 * An absent or unknown value is `stable`, which is what the screen this replaces did and
 * what the REST API assumes for a revision that predates the field.
 *
 * @param version The revision.
 * @returns One of the four lifecycles.
 */
export function versionLifecycle(version: Pick<Version, 'lifecycle'>): VersionLifecycle {
  const value = (version.lifecycle ?? 'stable').trim().toLowerCase();
  return (VERSION_LIFECYCLES as readonly string[]).includes(value)
    ? (value as VersionLifecycle)
    : 'stable';
}

/** The publication state a revision is in — the second badge in the Status column. */
export type VersionStatus = 'published' | 'draft';

/**
 * Whether a revision is published or still a draft.
 *
 * @param version The revision.
 * @returns `published` or `draft`. Both are words in `ui/statusVocabulary`.
 */
export function versionStatus(version: Pick<Version, 'published'>): VersionStatus {
  return version.published ? 'published' : 'draft';
}

/** The status labels, as the Status column and the quick chips print them. */
export const VERSION_STATUS_LABEL: Readonly<Record<VersionStatus, string>> = {
  published: 'Published',
  draft: 'Draft',
};

/**
 * The version label with its single leading `v` — `v2.4.0`, never `vv2.4.0`.
 *
 * @param version The revision.
 * @returns The prefixed label.
 */
export function versionLabel(version: Pick<Version, 'version_id'>): string {
  return formatVersionWithPrefix(version.version_id);
}

/**
 * The first eight characters of a revision id — the mono identifier line under the version.
 *
 * The same slice the Test bench uses to name a revision, so the two agree.
 *
 * @param id The revision UUID.
 * @returns Its short form.
 */
export function shortRevisionId(id: string): string {
  return id.slice(0, 8);
}

/**
 * The words the mock cell prints beside its switch (#4443, #4446).
 *
 * @param published Whether the revision is published.
 * @param enabled Whether the mock is on.
 * @param isPrivate Whether an enabled mock is key-gated (an unpublished draft's mock).
 * @returns The label.
 */
export function versionMockLabel(published: boolean, enabled: boolean, isPrivate: boolean): string {
  if (enabled) return isPrivate ? 'Private mock on' : 'Mock on';
  return published ? 'Mock off' : 'Draft mock off';
}

// ---------------------------------------------------------------------------------------
// Stamps
// ---------------------------------------------------------------------------------------

/**
 * The absolute stamp the Created column prints — `MM/DD/YY hh:mm AM`.
 *
 * The format the screen this replaces used, kept because a timeline is scanned for *when*.
 *
 * @param iso The timestamp.
 * @returns The formatted stamp, or `—` if it will not parse.
 */
export function formatVersionStamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const datePart = date.toLocaleDateString('en-US', {
    month: '2-digit',
    day: '2-digit',
    year: '2-digit',
  });
  const timePart = date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
  return `${datePart} ${timePart}`;
}

/**
 * The date half of {@link formatVersionStamp} — the green `Published 08/03/26` line.
 *
 * @param iso The timestamp.
 * @returns `MM/DD/YY`, or `—` if it will not parse.
 */
export function formatVersionDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' });
}

/**
 * A sunset instant as the deprecation banner prints it — `30 Sep 2026 00:00 UTC`.
 *
 * Stated in UTC because that is how the API stores it and how the sunset timeline shows it;
 * a local rendering would make the banner and the timeline disagree about the same instant.
 *
 * @param iso The stored `sunsetAt`.
 * @returns The formatted instant, or the raw string when it will not parse.
 */
export function formatSunsetUtc(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const day = date.getUTCDate().toString().padStart(2, '0');
  const month = date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const year = date.getUTCFullYear();
  const hours = date.getUTCHours().toString().padStart(2, '0');
  const minutes = date.getUTCMinutes().toString().padStart(2, '0');
  return `${day} ${month} ${year} ${hours}:${minutes} UTC`;
}

// ---------------------------------------------------------------------------------------
// The quick chips
// ---------------------------------------------------------------------------------------

/** The toolbar's quick chips — one view of the timeline each. */
export type VersionFacet = 'all' | 'drafts' | 'published';

/** The chips, in toolbar order. */
export const VERSION_FACETS: readonly VersionFacet[] = ['all', 'drafts', 'published'] as const;

/** The chip labels. */
export const VERSION_FACET_LABELS: Readonly<Record<VersionFacet, string>> = {
  all: 'All',
  drafts: 'Drafts',
  published: 'Published',
};

/**
 * Whether a revision belongs to a chip's view.
 *
 * @param version The revision.
 * @param facet The chip.
 * @returns `true` when the chip would show the row.
 */
export function matchesVersionFacet(version: Pick<Version, 'published'>, facet: VersionFacet): boolean {
  if (facet === 'all') return true;
  return facet === 'published' ? version.published : !version.published;
}

/**
 * How many rows each chip would leave, over the rows the timeline filters already narrowed.
 *
 * @param rows The narrowed rows.
 * @returns A count per chip.
 */
export function versionFacetCounts(
  rows: readonly Pick<Version, 'published'>[]
): Readonly<Record<VersionFacet, number>> {
  const counts = { all: 0, drafts: 0, published: 0 };
  for (const row of rows) {
    counts.all += 1;
    if (row.published) counts.published += 1;
    else counts.drafts += 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------------------
// Sort bridging
// ---------------------------------------------------------------------------------------

/** One entry of the toolbar's sort menu. */
export interface VersionSortOption {
  id: VersionsDashboardSortColumn;
  label: string;
}

/** The sortable columns, in the table's column order. */
export const VERSION_SORT_OPTIONS: readonly VersionSortOption[] = [
  { id: 'version', label: 'Version' },
  { id: 'revision', label: 'Revision / changelog' },
  { id: 'status', label: 'Status' },
  { id: 'creator', label: 'Created by' },
  { id: 'created', label: 'Created' },
];

/** The screen's own order: newest first, which is also the order the API returns rows in. */
export const DEFAULT_VERSIONS_SORT: DataTableSortState = { column: 'created', direction: 'desc' };

/**
 * Whether a `DataTable` column id is one the timeline's comparator knows.
 *
 * @param id The column id.
 * @returns `true` for the five sortable columns.
 */
export function isVersionSortColumn(id: string): id is VersionsDashboardSortColumn {
  return VERSION_SORT_OPTIONS.some((option) => option.id === id);
}

/**
 * The next sort after a header or menu click.
 *
 * `DataTable` cycles a header asc → desc → *unsorted*, and reports the unsorted step as
 * `null`. The screen this replaces had no unsorted state — a header toggled between the two
 * directions — and "behaves identically" is an acceptance criterion, so `null` is read as
 * "flip the current direction" rather than as "clear the sort". A click on a column that is
 * not sortable is ignored.
 *
 * @param current The sort in force.
 * @param next What `DataTable` reported.
 * @returns The sort to apply.
 */
export function nextVersionsSort(
  current: DataTableSortState,
  next: DataTableSortState | null
): DataTableSortState {
  if (next === null) {
    return {
      column: current.column,
      direction: current.direction === 'asc' ? 'desc' : 'asc',
    };
  }
  if (!isVersionSortColumn(next.column)) return current;
  return next;
}

/**
 * The sort a menu click asks for: a new column starts ascending, the same column flips.
 *
 * @param current The sort in force.
 * @param column The column clicked.
 * @returns The sort to apply.
 */
export function versionsSortFromMenu(
  current: DataTableSortState,
  column: VersionsDashboardSortColumn
): DataTableSortState {
  if (current.column === column) {
    return { column, direction: current.direction === 'asc' ? 'desc' : 'asc' };
  }
  return { column, direction: 'asc' };
}

/**
 * Sort revisions by a `DataTable` sort state, through the timeline's own comparator.
 *
 * @param rows The rows.
 * @param sort The sort.
 * @returns A new, sorted array.
 */
export function sortVersions<T extends Version>(rows: readonly T[], sort: DataTableSortState): T[] {
  const column = isVersionSortColumn(sort.column) ? sort.column : DEFAULT_VERSIONS_SORT.column;
  return sortVersionsDashboardRows(
    rows,
    column as VersionsDashboardSortColumn,
    sort.direction as VersionsDashboardSortDirection
  );
}

/**
 * The sort as the toolbar and the foot say it — `created ↓`.
 *
 * @param sort The sort.
 * @returns The phrase.
 */
export function versionsSortLabel(sort: DataTableSortState): string {
  const option = VERSION_SORT_OPTIONS.find((entry) => entry.id === sort.column);
  const name = option ? option.label.toLowerCase() : sort.column;
  return `${name} ${sort.direction === 'asc' ? '↑' : '↓'}`;
}

/**
 * The foot's left-hand sentence — `6 revisions · sorted by created ↓ · lifecycle filter: all`.
 *
 * @param count How many rows are drawn.
 * @param sort The sort in force.
 * @param lifecycleFilter The server-side lifecycle filter, `''` for all.
 * @returns The sentence.
 */
export function versionsFootLabel(
  count: number,
  sort: DataTableSortState,
  lifecycleFilter: string
): string {
  const noun = count === 1 ? 'revision' : 'revisions';
  const lifecycle = lifecycleFilter
    ? VERSION_LIFECYCLE_LABEL[versionLifecycle({ lifecycle: lifecycleFilter })].toLowerCase()
    : 'all';
  return `${count} ${noun} · sorted by ${versionsSortLabel(sort)} · lifecycle filter: ${lifecycle}`;
}

// ---------------------------------------------------------------------------------------
// Head and last published
// ---------------------------------------------------------------------------------------

/**
 * The newest published revision — by `published_at`, falling back to `created_at`.
 *
 * @param versions The loaded revisions.
 * @returns The revision, or `null` when nothing is published.
 */
export function lastPublishedVersion<T extends Version>(versions: readonly T[]): T | null {
  let best: T | null = null;
  let bestTime = Number.NEGATIVE_INFINITY;
  for (const version of versions) {
    if (!version.published) continue;
    const time = new Date(version.published_at ?? version.created_at).getTime();
    if (Number.isNaN(time)) continue;
    if (time > bestTime) {
      best = version;
      bestTime = time;
    }
  }
  return best;
}

/** What the foot's right-hand side and the facts card say about the line's two ends. */
export interface VersionsHeadLine {
  /** The head's label, `v2.4.0`, or `null` with no revisions. */
  head: string | null;
  /** The newest published label, `v2.3.1`, or `null` when nothing is published. */
  lastPublished: string | null;
}

/**
 * The head and the last published revision, as labels.
 *
 * @param versions The loaded revisions.
 * @param headRevisionId The head's id, from `projectHeadRevisionId`.
 * @returns Both labels.
 */
export function versionsHeadLine(
  versions: readonly Version[],
  headRevisionId: string | null
): VersionsHeadLine {
  const head = versions.find((version) => version.id === headRevisionId) ?? null;
  const published = lastPublishedVersion(versions);
  return {
    head: head ? versionLabel(head) : null,
    lastPublished: published ? versionLabel(published) : null,
  };
}

/** The badge beside the page title: the head revision and its publication state. */
export interface HeadRevisionBadge {
  /** `v2.4.0 draft` / `v2.3.1 published`. */
  label: string;
  /** The vocabulary word that paints it. */
  status: VersionStatus;
  /** The `title` — what the badge is about. */
  title: string;
}

/**
 * The head-revision badge, or `null` with no head.
 *
 * @param versions The loaded revisions.
 * @param headRevisionId The head's id.
 * @returns The badge.
 */
export function headRevisionBadge(
  versions: readonly Version[],
  headRevisionId: string | null
): HeadRevisionBadge | null {
  const head = versions.find((version) => version.id === headRevisionId);
  if (!head) return null;
  const status = versionStatus(head);
  const label = versionLabel(head);
  return {
    label: `${label} ${status}`,
    status,
    title: `Head revision ${label} is ${status === 'draft' ? 'a draft' : 'published'}`,
  };
}

/** The stored quality of a revision, as a badge. */
export interface StoredQualityBadge {
  /** `B · 88`. */
  label: string;
  /** The grade letter, for `gradeBand`. */
  grade: string;
  /** The score. */
  score: number;
}

/**
 * The stored quality badge of a revision (#5259) — from the record, never from a lint call.
 *
 * @param version The revision, or `undefined`.
 * @returns The badge, or `null` when the revision is unscored.
 */
export function storedQualityBadge(
  version: Pick<Version, 'qualityScore' | 'qualityGrade'> | null | undefined
): StoredQualityBadge | null {
  if (!version || version.qualityScore == null || !version.qualityGrade) return null;
  return {
    label: `${version.qualityGrade} · ${version.qualityScore}`,
    grade: version.qualityGrade,
    score: version.qualityScore,
  };
}

// ---------------------------------------------------------------------------------------
// The banners
// ---------------------------------------------------------------------------------------

/**
 * The deprecation banner — the newest deprecated revision that carries a sunset or a message.
 */
export interface DeprecationBanner {
  /** The revision. */
  versionId: string;
  /** `v2.2.0`. */
  versionLabel: string;
  /** `30 Sep 2026 00:00 UTC`, or `null` with no sunset. */
  sunsetLabel: string | null;
  /** The successor's label, or `null`. */
  successorLabel: string | null;
  /** The deprecation message, or `null`. */
  message: string | null;
}

/**
 * Read a revision's stored deprecation metadata under every spelling the API has used.
 *
 * @param version The revision.
 * @returns The sunset ISO, the successor revision id and the message, each `null` when absent.
 */
export function revisionDeprecationMeta(version: Pick<Version, 'metadata'>): {
  sunsetAt: string | null;
  successorRevisionId: string | null;
  message: string | null;
} {
  const meta = version.metadata ?? {};
  const pick = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = meta[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
  };
  return {
    sunsetAt: pick('sunsetAt', 'sunsetDate', 'sunset_date'),
    successorRevisionId: pick('successorRevisionId', 'successor_revision_id'),
    message: pick('deprecationMessage', 'message'),
  };
}

/**
 * The deprecation banner, or `null` when no revision is deprecated with anything to say.
 *
 * The newest deprecated revision wins: a line with two deprecated revisions has one banner,
 * and the sunset timeline is where the rest are listed.
 *
 * @param versions The loaded revisions.
 * @returns The banner.
 */
export function deprecationBanner(versions: readonly Version[]): DeprecationBanner | null {
  const deprecated = versions
    .filter((version) => versionLifecycle(version) === 'deprecated')
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  for (const version of deprecated) {
    const meta = revisionDeprecationMeta(version);
    if (!meta.sunsetAt && !meta.message) continue;
    const successor = meta.successorRevisionId
      ? (versions.find((candidate) => candidate.id === meta.successorRevisionId) ?? null)
      : null;
    return {
      versionId: version.id,
      versionLabel: versionLabel(version),
      sunsetLabel: meta.sunsetAt ? formatSunsetUtc(meta.sunsetAt) : null,
      successorLabel: successor ? versionLabel(successor) : null,
      message: meta.message,
    };
  }
  return null;
}

/** The what's-new banner: the head revision's note. */
export interface WhatsNewBanner {
  versionId: string;
  /** `v2.4.0`. */
  versionLabel: string;
  status: VersionStatus;
  /** The revision note, or the changelog's first line when there is no note. */
  summary: string;
}

/**
 * The first line of a changelog with any leading list marker removed.
 *
 * @param changelog The stored markdown.
 * @returns The line, or `''`.
 */
export function changelogFirstLine(changelog: string | null | undefined): string {
  if (!changelog) return '';
  const line = changelog
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return line ? line.replace(/^[-*+]\s+/, '') : '';
}

/**
 * The what's-new banner, or `null` when the head has nothing to say.
 *
 * @param versions The loaded revisions.
 * @param headRevisionId The head's id.
 * @returns The banner.
 */
export function whatsNewBanner(
  versions: readonly Version[],
  headRevisionId: string | null
): WhatsNewBanner | null {
  const head = versions.find((version) => version.id === headRevisionId);
  if (!head) return null;
  const summary = head.shortMessage?.trim() || changelogFirstLine(head.changelog);
  if (!summary) return null;
  return {
    versionId: head.id,
    versionLabel: versionLabel(head),
    status: versionStatus(head),
    summary,
  };
}

/** The compatibility banner: the newest published revision's stored classification. */
export interface CompatibilityBanner {
  /** Which way it went. */
  tone: 'ok' | 'warn' | 'danger' | 'neutral';
  /** `Compatible.` / `Breaking changes.` / `Initial publication.` / `Classification pending.` */
  title: string;
  /** The sentence under it. */
  body: string;
  /** The published revision the classification is for. */
  publishedRevisionId: string;
}

/**
 * The compatibility banner from a `/api/projects/{id}/changelogs` summary, or `null`.
 *
 * The summary of the newest published revision is what the caller passes; a summary that
 * has not been classified yet still yields a banner, so the reader learns the check is
 * pending rather than seeing nothing.
 *
 * @param summary The newest published revision's summary, or `null` with none.
 * @returns The banner.
 */
export function compatibilityBanner(
  summary: VersionChangelogSummary | null | undefined
): CompatibilityBanner | null {
  if (!summary) return null;
  const to = formatVersionWithPrefix(summary.versionLabel) || 'the newest published revision';
  const from = formatVersionWithPrefix(summary.baselineVersionLabel);
  const pair = from ? `${from} → ${to}` : to;
  if (summary.status === 'initial') {
    return {
      tone: 'neutral',
      title: 'Initial publication.',
      body: `${to} is the first published revision on this line — there is no baseline to compare against.`,
      publishedRevisionId: summary.publishedRevisionId,
    };
  }
  if (summary.status === 'failed') {
    return {
      tone: 'warn',
      title: 'Classification failed.',
      body: `The stored change classification for ${pair} could not be produced. Open the Changes tab to retry.`,
      publishedRevisionId: summary.publishedRevisionId,
    };
  }
  if (summary.status !== 'ready') {
    return {
      tone: 'neutral',
      title: 'Classification pending.',
      body: `${pair} has not been classified yet — classification runs right after publish.`,
      publishedRevisionId: summary.publishedRevisionId,
    };
  }
  const counts = countsSummary(summary.counts);
  const breaking = summary.counts?.breaking ?? 0;
  if (breaking > 0) {
    return {
      tone: 'danger',
      title: 'Breaking changes.',
      body: `${pair} has ${counts ?? `${breaking} breaking change${breaking === 1 ? '' : 's'}`}.`,
      publishedRevisionId: summary.publishedRevisionId,
    };
  }
  return {
    tone: 'ok',
    title: 'Compatible.',
    body: counts
      ? `${pair} has ${counts} and no breaking changes.`
      : `${pair} has no recorded changes.`,
    publishedRevisionId: summary.publishedRevisionId,
  };
}

/**
 * The summary of the newest published revision, out of a `/api/projects/{id}/changelogs` list.
 *
 * @param summaries The list.
 * @param versions The loaded revisions, to break the tie by publish time.
 * @returns The summary, or `null`.
 */
export function newestPublishedSummary(
  summaries: readonly VersionChangelogSummary[] | null | undefined,
  versions: readonly Version[]
): VersionChangelogSummary | null {
  if (!summaries || summaries.length === 0) return null;
  const published = lastPublishedVersion(versions);
  const match = published
    ? summaries.find((summary) => summary.publishedRevisionId === published.id)
    : undefined;
  if (match) return match;
  return [...summaries].sort(
    (a, b) => new Date(b.publishedAt ?? 0).getTime() - new Date(a.publishedAt ?? 0).getTime()
  )[0];
}

// ---------------------------------------------------------------------------------------
// The confirms
// ---------------------------------------------------------------------------------------

/**
 * The delete confirm — red primary, version named, consequence stated.
 *
 * @param version The revision.
 * @returns Options for `useDialog().confirm`.
 */
export function deleteVersionConfirm(version: Pick<Version, 'version_id'>): DestructiveConfirmOptions {
  return destructiveConfirm({
    action: 'Delete',
    noun: 'version',
    name: versionLabel(version),
    consequence: 'This action cannot be undone.',
    confirmLabel: 'Delete',
  });
}

/**
 * The unpublish confirm — destructive to consumers, so red as well.
 *
 * @param version The revision.
 * @returns Options for `useDialog().confirm`.
 */
export function unpublishVersionConfirm(
  version: Pick<Version, 'version_id'>
): DestructiveConfirmOptions {
  return destructiveConfirm({
    action: 'Unpublish',
    name: versionLabel(version),
    consequence:
      'Best practice is to keep it published. Consumers of the published URL will get 404 until it is republished.',
    confirmLabel: 'Unpublish',
  });
}

/**
 * The freeze-schema confirm — not destructive, so an accent primary that names the version.
 *
 * @param version The revision.
 * @returns Options for `useDialog().confirm`.
 */
export function freezeSchemaConfirm(
  version: Pick<Version, 'version_id'>
): Pick<ConfirmDialogProps, 'title' | 'message' | 'variant' | 'confirmLabel' | 'cancelLabel'> {
  return {
    title: `Freeze schema for ${versionLabel(version)}?`,
    message:
      'This will capture the current class schemas for this version into the database so the version can be used in the Database section. Only versions with no schema captured yet can be frozen. Continue?',
    variant: 'info',
    confirmLabel: 'Freeze schema',
    cancelLabel: 'Cancel',
  };
}

// ---------------------------------------------------------------------------------------
// FEATURE_GITLIKE
// ---------------------------------------------------------------------------------------

/**
 * How a `FEATURE_GITLIKE`-gated affordance is treated in this build.
 *
 * The screen this replaces gated every git-like control on the flag alone, so in a build
 * with the flag off the row menu simply had fewer items — including **Delete** — and nothing
 * on screen said so. The ticket's rule is to make the gap legible during the migration
 * without changing what production does:
 *
 * | Build          | Flag | Rendered | Marked | Enabled |
 * | -------------- | ---- | -------- | ------ | ------- |
 * | production     | off  | no       | —      | —       |
 * | production     | on   | yes      | no     | yes     |
 * | non-production | off  | yes      | yes    | no      |
 * | non-production | on   | yes      | yes    | yes     |
 *
 * The first two rows are the acceptance criterion *"`FEATURE_GITLIKE` behaviour is unchanged
 * in production builds"*, verbatim. The last two are the *"render with a visible flag marker
 * in non-production builds rather than vanishing"* rule: an affordance the flag hides is
 * still drawn, carries the honey `gitlike` flag, and is inert — it can be seen but not used,
 * so no code path the flag guards is reachable in any build.
 */
export interface GitlikeAffordance {
  /** Whether the flag is on — the only thing that decides what production draws. */
  flagOn: boolean;
  /** Draw the affordance at all. */
  visible: boolean;
  /** Draw the honey `gitlike` flag beside it. */
  marked: boolean;
  /** Let it be used. */
  enabled: boolean;
}

/** The `title` on a marked, inert affordance — what the mockup's flag chips say. */
export const GITLIKE_FLAG_TITLE = 'Compiled but hidden today (FEATURE_GITLIKE=false)';

/** The `title` on a marked, working affordance. */
export const GITLIKE_FLAG_ON_TITLE = 'Part of the git-like feature set (FEATURE_GITLIKE)';

/** The flag chip's word. */
export const GITLIKE_FLAG_LABEL = 'gitlike';

/**
 * Decide how a git-like affordance is treated.
 *
 * @param flagOn Whether `FEATURE_GITLIKE` is on. Defaults to the build constant.
 * @param production Whether this is a production build. Defaults to `NODE_ENV`.
 * @returns The four decisions — see {@link GitlikeAffordance}.
 */
export function gitlikeAffordance(
  flagOn: boolean = FEATURE_GITLIKE,
  production: boolean = process.env.NODE_ENV === 'production'
): GitlikeAffordance {
  return {
    flagOn,
    visible: flagOn || !production,
    marked: !production,
    enabled: flagOn,
  };
}

// ---------------------------------------------------------------------------------------
// The row menu
// ---------------------------------------------------------------------------------------

/** Every action the row menu can offer, by id. */
export type VersionRowMenuAction =
  | 'view'
  | 'export'
  | 'compareWithCurrent'
  | 'relationshipGraph'
  | 'branchFrom'
  | 'rollbackBranch'
  | 'forkToProject'
  | 'tagFrom'
  | 'scheduleSunset'
  | 'edit'
  | 'publish'
  | 'unpublish'
  | 'freezeSchema'
  | 'toggleLock'
  | 'delete';

/** One entry of the row menu, decided but not yet drawn. */
export interface VersionRowMenuItem {
  id: VersionRowMenuAction;
  /** The label. */
  label: string;
  /** Whether the item is one the flag gates — drawn with the honey flag when marked. */
  gitlike: boolean;
  /** Whether it can be used. */
  disabled: boolean;
  /** The `title` — why it is disabled, or what it does. */
  title?: string;
  /** A destructive item: inked red when highlighted. */
  danger?: boolean;
  /** Draw a separator above it. */
  separatorBefore?: boolean;
}

/** What the row menu needs to know beyond the revision itself. */
export interface VersionRowMenuContext {
  /** The head revision's id, or `null` with no revisions. */
  headRevisionId: string | null;
  /** Whether the viewer is a tenant admin (resolved, not just the session flag). */
  effectiveIsAdmin: boolean;
  /** The viewer's user id. */
  currentUserId: string | undefined;
  /** Whether the project has any named branch — rollback needs one. */
  hasBranches: boolean;
  /** Whether this revision's class schemas are already frozen. */
  schemaFrozen: boolean;
  /** Whether the owning project is publishable (not a catalog item). */
  publishable: boolean;
  /** Whether a freeze is in flight for this revision. */
  freezing: boolean;
  /** How git-like affordances are treated in this build. */
  gitlike: GitlikeAffordance;
}

/**
 * The row menu for one revision, in the mockup's order.
 *
 * Every visibility and disabled rule the screen this replaces applied is applied here, item
 * by item, so the menu behaves identically — plus the {@link gitlikeAffordance} rule for
 * the git-like items, which is the one thing that changes: a flag-hidden item is listed as
 * `disabled` with the flag's title in a non-production build instead of being dropped.
 *
 * @param version The revision.
 * @param context See {@link VersionRowMenuContext}.
 * @returns The items to draw, top to bottom.
 */
export function versionRowMenuItems(
  version: Version,
  context: VersionRowMenuContext
): VersionRowMenuItem[] {
  const {
    headRevisionId,
    effectiveIsAdmin,
    currentUserId,
    hasBranches,
    schemaFrozen,
    publishable,
    freezing,
    gitlike,
  } = context;
  const lifecycle = versionLifecycle(version);
  const isOwnerOrAdmin = version.creator_id === currentUserId || effectiveIsAdmin;
  const items: VersionRowMenuItem[] = [];

  /**
   * Add a git-like item, applying the build rule: dropped when invisible, inert with the
   * flag's title when the flag is off.
   */
  const gitlikeItem = (item: Omit<VersionRowMenuItem, 'gitlike'>) => {
    if (!gitlike.visible) return;
    items.push({
      ...item,
      gitlike: true,
      disabled: item.disabled || !gitlike.enabled,
      title: gitlike.enabled ? item.title : GITLIKE_FLAG_TITLE,
    });
  };

  items.push({ id: 'view', label: 'View spec', gitlike: false, disabled: false });
  items.push({
    id: 'export',
    label: 'Export to another format…',
    gitlike: false,
    disabled: false,
    title: 'Convert this version to another API format (fidelity shown per target)',
  });

  const isHead = headRevisionId !== null && version.id === headRevisionId;
  gitlikeItem({
    id: 'compareWithCurrent',
    label: 'Compare with current',
    disabled: !headRevisionId || isHead,
    title: !headRevisionId
      ? 'No head revision'
      : isHead
        ? 'This revision is already the current head'
        : 'OpenAPI diff: this revision → latest (current) head',
    separatorBefore: true,
  });
  gitlikeItem({ id: 'relationshipGraph', label: 'Relationship graph', disabled: false });
  gitlikeItem({ id: 'branchFrom', label: 'Branch from here', disabled: false });
  if (hasBranches) {
    gitlikeItem({
      id: 'rollbackBranch',
      label: 'Rollback branch to this revision…',
      disabled: false,
    });
  }
  gitlikeItem({ id: 'forkToProject', label: 'Fork to another project…', disabled: false });
  gitlikeItem({ id: 'tagFrom', label: 'Tag this revision', disabled: false });

  const sunsetLocked =
    (version.published && !effectiveIsAdmin) || (lifecycle === 'archived' && !effectiveIsAdmin);
  items.push({
    id: 'scheduleSunset',
    label: 'Schedule sunset (EOL)…',
    gitlike: false,
    disabled: sunsetLocked,
    title:
      version.published && !effectiveIsAdmin
        ? 'Only a tenant admin can set sunset on a published revision'
        : lifecycle === 'archived' && !effectiveIsAdmin
          ? 'Archived revisions are read-only'
          : 'Deprecation, sunset instant, and successor revision',
    separatorBefore: true,
  });
  items.push({
    id: 'edit',
    label: 'Edit',
    gitlike: false,
    disabled: version.published && !effectiveIsAdmin,
    title:
      version.published && !effectiveIsAdmin
        ? 'Only a tenant admin can edit a published revision'
        : undefined,
  });
  if (!version.published) {
    // Catalog items (non-publishable projects, MFI-23.1) are never publish candidates
    // (MFI-23.8, #4017): withhold the Publish affordance entirely.
    if (publishable) {
      items.push({ id: 'publish', label: 'Publish', gitlike: false, disabled: false });
    }
  } else {
    items.push({ id: 'unpublish', label: 'Unpublish', gitlike: false, disabled: false });
  }
  if (!schemaFrozen && isOwnerOrAdmin) {
    gitlikeItem({
      id: 'freezeSchema',
      label: freezing ? 'Freezing...' : 'Freeze schema',
      disabled: freezing,
      title:
        'Capture class schemas for this version so it can be used in the Database section (only when no schema is frozen yet)',
    });
  }
  if (effectiveIsAdmin) {
    gitlikeItem({
      id: 'toggleLock',
      label: version.revisionLocked
        ? 'Unlock revision (allow delete)'
        : 'Lock revision (delete policy)',
      disabled: false,
    });
  }
  gitlikeItem({
    id: 'delete',
    label: 'Delete',
    disabled: Boolean(version.revisionLocked) && !effectiveIsAdmin,
    title:
      version.revisionLocked && !effectiveIsAdmin
        ? 'Revision is locked; only a tenant admin can delete'
        : undefined,
    danger: true,
    separatorBefore: true,
  });

  return items;
}

/** The hover-revealed quick actions beside the row's menu, in order. */
export interface VersionRowQuickAction {
  id: 'publish' | 'unpublish' | 'edit' | 'scheduleSunset';
  label: string;
}

/**
 * Which quick actions a row shows before its overflow menu.
 *
 * The mockup's *Adds* row: publish or unpublish first (whichever applies and the viewer may
 * do), then edit when the viewer may edit — or the sunset action for a deprecated revision,
 * which is the edit that row is for. Every one of these is also in the menu, so nothing is
 * *only* reachable by hovering.
 *
 * @param version The revision.
 * @param context The same context the menu reads.
 * @returns The quick actions, at most two.
 */
export function versionRowQuickActions(
  version: Version,
  context: Pick<VersionRowMenuContext, 'effectiveIsAdmin' | 'currentUserId' | 'publishable'>
): VersionRowQuickAction[] {
  const { effectiveIsAdmin, currentUserId, publishable } = context;
  const lifecycle = versionLifecycle(version);
  const canModify = version.creator_id === currentUserId || effectiveIsAdmin;
  const actions: VersionRowQuickAction[] = [];
  if (!version.published && publishable && canModify) {
    actions.push({ id: 'publish', label: 'Publish' });
  } else if (version.published && canModify) {
    actions.push({ id: 'unpublish', label: 'Unpublish' });
  }
  const canEdit = !(version.published && !effectiveIsAdmin) && !(lifecycle === 'archived' && !effectiveIsAdmin);
  if (lifecycle === 'deprecated' && canEdit) {
    actions.push({ id: 'scheduleSunset', label: 'Schedule sunset (EOL)' });
  } else if (canEdit) {
    actions.push({ id: 'edit', label: 'Edit' });
  }
  return actions;
}
