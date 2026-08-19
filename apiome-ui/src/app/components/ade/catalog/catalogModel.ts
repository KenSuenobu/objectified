/**
 * The rules the Catalog list runs on (HIVE-7.1, #5318).
 *
 * Authority: `docs/mockups/sources/catalog.html` and its **Notes → Keeps (1:1)** list;
 * `docs/mockups/DESIGN.md` §8 (list page, destructive confirms, keyboard) and §3.1 (status
 * vocabulary).
 *
 * The Catalog is the `publishable = false` slice of projects (MFI-23.1) — the imports whose
 * format does not map 1:1 onto OpenAPI. Before this ticket almost every decision the screen
 * makes lived inside a 1,651-line `page.tsx`: which chip counts what, which of two quality
 * numbers wins, what a facet offers, what the permanent-delete confirm asks. None of it could
 * be tested without rendering the whole screen, and the card and the table each carried their
 * own copy of the score derivation.
 *
 * Everything here is pure and React-free, so the two views import one answer instead of
 * writing two. There is no colour and no class name in this file: a tone is looked up from
 * `ui/statusVocabulary` and `ui/metrics/metricTiers` by the component that paints it, and a
 * format's hue comes from the fixed identity block via `ui/catalog/FormatPill`.
 *
 * @see `./CatalogCard.tsx` and `./CatalogTable.tsx` — the two views these rules serve.
 * @see `@/app/utils/catalog-dashboard-sort` — the comparators, which predate this ticket and
 *   are unchanged; this module only bridges them to `DataTable`'s sort state.
 * @see `@/app/utils/catalog-format-registry` — the format, protocol and source-material
 *   registry the facets are derived from.
 */

import type { DataTableSortState } from '@/app/components/ui/DataTable';
import {
  destructiveConfirm,
  type DestructiveConfirmOptions,
} from '@/app/components/dialogs/destructiveConfirm';
import { letterGradeFromOverallPercent } from '@/app/utils/numeric-score-tier';
import { catalogOrbScores } from '@/app/utils/catalog-card-presentation';
import type { CatalogConversion } from '@/app/utils/catalog-conversion';
import {
  catalogFormatFamilyId,
  catalogFormatFamilyLabel,
  catalogFormatSearchTokens,
  resolveCatalogProtocol,
  resolveCatalogSource,
  type CatalogSource,
  type CatalogSourceKind,
} from '@/app/utils/catalog-format-registry';
import {
  sortCatalogDashboardRows,
  type CatalogDashboardSortColumn,
  type CatalogDashboardSortDirection,
} from '@/app/utils/catalog-dashboard-sort';
import type { ProjectQualitySnapshot } from '@/app/utils/project-quality-score-history';

// ---------------------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------------------

/**
 * One catalog item, as `/api/catalog` returns it (REST `CatalogItemSchema`, MFI-23.2).
 *
 * A catalog item's `id` **is** a project id — the Catalog is a projection over the same
 * `projects` table — which is why the delete, undelete and permanent-delete writes are the
 * project server actions and the quality dialogs are the project ones.
 */
export interface CatalogItem {
  id: string;
  tenant_id: string;
  creator_id?: string | null;
  name: string;
  slug?: string | null;
  description?: string | null;
  enabled: boolean;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  creator_name?: string | null;
  creator_email?: string | null;
  metadata?: ({ summary?: string } & Record<string, unknown>) | null;
  qualityScore?: number | null;
  qualityGrade?: string | null;
  /** Live revision count (parity with the projects list cards). */
  versionsCount?: number;
  /** Always false for a catalog item (the non-publishable invariant, MFI-23.1). */
  publishable?: boolean;
  /** Imported source format + paradigm/protocol off the latest revision (MFI-7.1/7.2). */
  sourceFormat?: string | null;
  protocol?: string | null;
  /** Format-specific metadata off the latest revision; carries source provenance (MFI-7.x). */
  formatMetadata?: Record<string, unknown> | null;
  /** Cross-format identity group when filtering representations (MFI-6.4). */
  identityGroupId?: string | null;
  /** The convert-to-OpenAPI back-link (MFI-23.11): present once the item has been converted. */
  conversion?: CatalogConversion | null;
}

/** The quality history of every item on screen, keyed by item id. */
export type CatalogQualityHistoryMap = Readonly<
  Record<string, readonly ProjectQualitySnapshot[]>
>;

// ---------------------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------------------

/**
 * What state a catalog item is in, as one word.
 *
 * Three states, not two flags: `enabled` and `deleted_at` are independent in the database,
 * but a deleted item's enabled flag is *remembered* rather than *meaningful* — undelete
 * restores it — so a reader should only ever be shown the outer one.
 */
export type CatalogLifecycle = 'active' | 'disabled' | 'deleted';

/**
 * The state an item is in.
 *
 * @param item The row.
 * @returns `deleted` when it is soft-deleted, otherwise `active` or `disabled`.
 */
export function catalogLifecycle(item: CatalogItem): CatalogLifecycle {
  if (item.deleted_at) return 'deleted';
  return item.enabled ? 'active' : 'disabled';
}

/** The label for each lifecycle state — the shared vocabulary's spelling, sentence case. */
export const CATALOG_LIFECYCLE_LABEL: Readonly<Record<CatalogLifecycle, string>> = {
  active: 'Active',
  disabled: 'Disabled',
  deleted: 'Deleted',
};

/**
 * Whether a row or card opens its detail view.
 *
 * A deleted item has nothing to open — its revisions are hidden with it — so the whole hit
 * area goes inert rather than routing to a page that would say "not found".
 *
 * @param item The row.
 * @returns True when clicking it should route to the item detail.
 */
export function isCatalogItemOpenable(item: CatalogItem): boolean {
  return !item.deleted_at;
}

/** Where a catalog item's detail lives (MFI-23.9). */
export function catalogItemHref(item: CatalogItem): string {
  return `/ade/dashboard/catalog/${encodeURIComponent(item.id)}`;
}

/** Where a catalog item's revisions live (its id is a project id). */
export function catalogVersionsHref(item: CatalogItem): string {
  return `/ade/dashboard/versions?projectId=${encodeURIComponent(item.id)}`;
}

// ---------------------------------------------------------------------------------------
// The view chips
// ---------------------------------------------------------------------------------------

/** The four view chips of the mockup's toolbar. */
export type CatalogFacet = 'all' | 'active' | 'attention' | 'deleted';

/** Every facet, in the order the toolbar draws them. */
export const CATALOG_FACETS: readonly CatalogFacet[] = [
  'all',
  'active',
  'attention',
  'deleted',
] as const;

/** What each chip says. */
export const CATALOG_FACET_LABELS: Readonly<Record<CatalogFacet, string>> = {
  all: 'All',
  active: 'Active',
  attention: 'Needs attention',
  deleted: 'Deleted',
};

/**
 * Whether an item belongs to a facet.
 *
 * "Needs attention" is *disabled or deleted* — the two states that stop an item being usable —
 * which is why a deleted item is counted by two chips rather than one. That is deliberate and
 * matches the mockup's counts: the chips narrow the list, they do not partition it.
 *
 * @param item The row.
 * @param facet The chip.
 * @returns True when the chip should keep this row.
 */
export function matchesCatalogFacet(item: CatalogItem, facet: CatalogFacet): boolean {
  switch (facet) {
    case 'active':
      return item.enabled && !item.deleted_at;
    case 'attention':
      return !item.enabled || Boolean(item.deleted_at);
    case 'deleted':
      return Boolean(item.deleted_at);
    case 'all':
    default:
      return true;
  }
}

/**
 * How many rows each chip would leave.
 *
 * Counted over the rows every *other* control has already narrowed, so the chips describe
 * what pressing them would actually show rather than the unfiltered total — the ticket's
 * "facet counts reflect the active filter set".
 *
 * @param items The rows the search, the format facet and the three selects left.
 * @returns One count per facet.
 */
export function catalogFacetCounts(
  items: readonly CatalogItem[]
): Readonly<Record<CatalogFacet, number>> {
  return {
    all: items.length,
    active: items.filter((item) => matchesCatalogFacet(item, 'active')).length,
    attention: items.filter((item) => matchesCatalogFacet(item, 'attention')).length,
    deleted: items.filter((item) => matchesCatalogFacet(item, 'deleted')).length,
  };
}

// ---------------------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------------------

/**
 * The free-text filter behind the toolbar's search box.
 *
 * Matches the name, the slug, the description, the raw format and protocol tokens, and every
 * *alias* the format registry knows — so typing `grpc` finds an item stored as `protobuf`,
 * which is the one search a reader of this list is most likely to try.
 *
 * @param items The rows.
 * @param query What was typed. Blank returns a copy of the input.
 * @returns The rows that match, in their original order.
 */
export function searchCatalog<T extends CatalogItem>(items: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...items];
  return items.filter((item) => {
    const tokens = catalogFormatSearchTokens(item.sourceFormat ?? null);
    return (
      [item.name, item.slug ?? '', item.description ?? '', item.sourceFormat ?? '', item.protocol ?? '']
        .join(' ')
        .toLowerCase()
        .includes(needle) || tokens.some((token) => token.includes(needle))
    );
  });
}

// ---------------------------------------------------------------------------------------
// The quick filters
// ---------------------------------------------------------------------------------------

/** The sentinel every quick-filter select starts on — "do not narrow by this axis". */
export const CATALOG_FILTER_ANY = 'any';

/**
 * The three quick-filter selects beside the format facet, plus the format facet itself.
 *
 * `formats` is a *set* because a format facet is multi-select (an empty array means "every
 * format"); the other three are single-choice, and `CATALOG_FILTER_ANY` is their neutral.
 */
export interface CatalogFilterState {
  /** Selected format-family ids. Empty means every format. */
  formats: readonly string[];
  /** A protocol id from the registry, or {@link CATALOG_FILTER_ANY}. */
  protocol: string;
  /** A {@link CatalogSourceKind}, or {@link CATALOG_FILTER_ANY}. */
  source: string;
  /** An A–F letter, `unscored`, or {@link CATALOG_FILTER_ANY}. */
  grade: string;
}

/** The neutral state of every quick filter — what "Clear all filters" restores. */
export const EMPTY_CATALOG_FILTERS: CatalogFilterState = {
  formats: [],
  protocol: CATALOG_FILTER_ANY,
  source: CATALOG_FILTER_ANY,
  grade: CATALOG_FILTER_ANY,
};

/** One entry of a quick-filter select. */
export interface CatalogFilterOption {
  /** The `<option>` value — an id, or {@link CATALOG_FILTER_ANY}. */
  value: string;
  /** What the row says. */
  label: string;
}

/** The Protocol select, in the mockup's order: every paradigm the registry knows. */
export const CATALOG_PROTOCOL_OPTIONS: readonly CatalogFilterOption[] = [
  { value: CATALOG_FILTER_ANY, label: 'All protocols' },
  { value: 'rest', label: 'REST' },
  { value: 'rpc', label: 'RPC' },
  { value: 'event', label: 'Event' },
  { value: 'graph', label: 'Graph' },
  { value: 'dataschema', label: 'Data Schema' },
  { value: 'agent', label: 'Agent' },
] as const;

/** The Source select — the four input kinds an import can have come through. */
export const CATALOG_SOURCE_OPTIONS: readonly CatalogFilterOption[] = [
  { value: CATALOG_FILTER_ANY, label: 'All sources' },
  { value: 'file', label: 'Uploaded file' },
  { value: 'url', label: 'Source URL' },
  { value: 'paste', label: 'Pasted content' },
  { value: 'discovery', label: 'Live discovery' },
] as const;

/** The value the Grade select uses for "has no score at all". */
export const CATALOG_GRADE_UNSCORED = 'unscored';

/** The Grade select — the five letters plus the unscored bucket. */
export const CATALOG_GRADE_OPTIONS: readonly CatalogFilterOption[] = [
  { value: CATALOG_FILTER_ANY, label: 'Any grade' },
  { value: 'A', label: 'A' },
  { value: 'B', label: 'B' },
  { value: 'C', label: 'C' },
  { value: 'D', label: 'D' },
  { value: 'F', label: 'F' },
  { value: CATALOG_GRADE_UNSCORED, label: 'Unscored' },
] as const;

/** The item's source material, resolved from either metadata bag. */
export function catalogItemSource(item: CatalogItem): CatalogSource | undefined {
  return resolveCatalogSource(item.formatMetadata, item.metadata);
}

/** The item's source *kind*, for the Source select. */
export function catalogItemSourceKind(item: CatalogItem): CatalogSourceKind | undefined {
  return catalogItemSource(item)?.kind;
}

/** The item's protocol id, resolved through the registry so aliases match the select. */
export function catalogItemProtocolId(item: CatalogItem): string | undefined {
  return resolveCatalogProtocol(item.protocol)?.id;
}

/**
 * The letter the Grade select matches on.
 *
 * The same ladder the orbs draw: a captured grade wins, otherwise one is derived from the
 * score, otherwise there is none. Deriving here rather than reading `qualityGrade` alone is
 * what stops "Grade: B" hiding an item whose orb is showing a B.
 *
 * @param item The row.
 * @param history Its browser-local snapshots, oldest first.
 * @returns The A–F letter, or `null` when nothing has scored it.
 */
export function catalogItemGradeLetter(
  item: CatalogItem,
  history: readonly ProjectQualitySnapshot[] = []
): string | null {
  const { lintLetter } = catalogOrbScores(item, [...history]);
  return lintLetter ?? null;
}

/**
 * Whether a row survives the format facet and the three selects.
 *
 * Each axis is independent and each is skipped when it is on its neutral value, so the four
 * compose without any of them having to know about the others.
 *
 * @param item The row.
 * @param filters The current quick-filter state.
 * @param history The item's browser-local snapshots (the grade axis needs them).
 * @returns True when every active axis keeps the row.
 */
export function matchesCatalogFilters(
  item: CatalogItem,
  filters: CatalogFilterState,
  history: readonly ProjectQualitySnapshot[] = []
): boolean {
  if (filters.formats.length > 0) {
    const familyId = catalogFormatFamilyId(item.sourceFormat);
    if (!familyId || !filters.formats.includes(familyId)) return false;
  }
  if (filters.protocol !== CATALOG_FILTER_ANY && catalogItemProtocolId(item) !== filters.protocol) {
    return false;
  }
  if (filters.source !== CATALOG_FILTER_ANY && catalogItemSourceKind(item) !== filters.source) {
    return false;
  }
  if (filters.grade !== CATALOG_FILTER_ANY) {
    const letter = catalogItemGradeLetter(item, history);
    if (filters.grade === CATALOG_GRADE_UNSCORED) {
      if (letter !== null) return false;
    } else if (letter !== filters.grade) {
      return false;
    }
  }
  return true;
}

/** Whether anything is narrowing the list — what decides which empty state is shown. */
export function isCatalogNarrowed(
  query: string,
  facet: CatalogFacet,
  filters: CatalogFilterState
): boolean {
  return (
    query.trim().length > 0 ||
    facet !== 'all' ||
    filters.formats.length > 0 ||
    filters.protocol !== CATALOG_FILTER_ANY ||
    filters.source !== CATALOG_FILTER_ANY ||
    filters.grade !== CATALOG_FILTER_ANY
  );
}

// ---------------------------------------------------------------------------------------
// The format facet
// ---------------------------------------------------------------------------------------

/** One entry of the format facet's menu: a family, its label, and how many rows carry it. */
export interface CatalogFormatFacetOption {
  /** The format-family id (`protobuf` covers both gRPC and Protobuf). */
  id: string;
  /** Its display label. */
  label: string;
  /** How many of the rows this facet was built from carry it. */
  count: number;
}

/**
 * The format facet's menu.
 *
 * Two rules, and both are the ticket's acceptance criteria:
 *
 * 1. **It is derived from the rows, not from the registry.** Offering all 44 importable
 *    formats on a catalog holding three would make the facet a catalogue of the product
 *    rather than a filter over the list.
 * 2. **The counts come from the rows the *other* controls left.** So they answer "how many
 *    would I see if I ticked this", which is the only question a count beside a checkbox is
 *    ever asked.
 *
 * A family already ticked is always listed even when the current narrowing leaves it at
 * zero — otherwise the control that produced the empty list would vanish from the menu that
 * has to un-tick it.
 *
 * @param rows The rows every control except the format facet has left.
 * @param selected The currently ticked family ids.
 * @returns One option per family, alphabetical by label.
 */
export function catalogFormatFacetOptions(
  rows: readonly CatalogItem[],
  selected: readonly string[] = []
): CatalogFormatFacetOption[] {
  const counts = new Map<string, number>();
  for (const item of rows) {
    const familyId = catalogFormatFamilyId(item.sourceFormat);
    if (!familyId) continue;
    counts.set(familyId, (counts.get(familyId) ?? 0) + 1);
  }
  for (const id of selected) if (!counts.has(id)) counts.set(id, 0);
  return [...counts.entries()]
    .map(([id, count]) => ({ id, label: catalogFormatFamilyLabel(id), count }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

// ---------------------------------------------------------------------------------------
// Scores
// ---------------------------------------------------------------------------------------

/** What an item's three orbs and its two table cells have to draw. */
export interface CatalogScores {
  /** Revisions the server summary counted. */
  versionsCount: number;
  /** The overall quality score, 0–100, or `null` when nothing has scored it. */
  quality: number | null;
  /** The A–F letter the Lint orb prints, or `null` when there is no score behind it. */
  grade: string | null;
}

/**
 * The one derivation both views use.
 *
 * Unlike a project, a catalog item is *server*-imported far more often than it is imported in
 * this browser, so the ladder is the reverse of `projectScores`': the server-captured score
 * (MFI-23.2) is preferred and browser-local history is the fallback. That is
 * {@link catalogOrbScores}, which predates this ticket and which the detail screen shares —
 * this only adds the revision count so a card and a row cannot disagree about either figure.
 *
 * @param item The row.
 * @param history Its browser-local snapshots, oldest first.
 * @returns The figures both views print. See {@link CatalogScores}.
 */
export function catalogScores(
  item: CatalogItem,
  history: readonly ProjectQualitySnapshot[] = []
): CatalogScores {
  const { qualityValue, lintLetter } = catalogOrbScores(item, [...history]);
  return {
    versionsCount: typeof item.versionsCount === 'number' ? item.versionsCount : 0,
    quality: qualityValue,
    grade: lintLetter ?? null,
  };
}

/** `3 versions`, `1 version`, `0 versions`. */
export function catalogVersionsLabel(count: number): string {
  return `${count} ${count === 1 ? 'version' : 'versions'}`;
}

/**
 * The two-line blurb on a card.
 *
 * The OpenAPI-style summary first, then the description, then a statement that there is
 * neither. Never an empty paragraph: the card's body has a minimum height so a grid keeps its
 * rhythm, and an empty one would read as a rendering fault.
 */
export function catalogSummaryText(item: CatalogItem): string {
  return item.metadata?.summary?.trim() || item.description?.trim() || 'No description yet.';
}

/**
 * The short, stable id the card and the row print beside the slug.
 *
 * Six hex characters of the uuid, as `sources/catalog.html` prints them (`cat_4d1e9a`). It is
 * a *label*, never an identifier to look anything up by — the uuid is what the API takes.
 *
 * @param id The item's uuid.
 * @returns `cat_` plus the first six characters with the dashes removed.
 */
export function catalogShortId(id: string): string {
  return `cat_${id.replace(/-/g, '').slice(0, 6)}`;
}

/**
 * The line under the page title: `7 items · 5 formats · avg quality B · 82 · 2 converted`.
 *
 * Every figure describes the *live* catalog, matching the stats row above it, and the deleted
 * count only appears when the switch that reveals deleted rows is on — a count of rows the
 * reader cannot see is a count they cannot act on.
 *
 * @param items Every row currently loaded.
 * @param showDeleted Whether the Show-deleted switch is on.
 * @returns One sentence for `PageHeader`'s description.
 */
export function catalogSummaryLine(
  items: readonly CatalogItem[],
  showDeleted: boolean
): string {
  const live = items.filter((item) => !item.deleted_at);
  const parts: string[] = [`${live.length} ${live.length === 1 ? 'item' : 'items'}`];

  const families = new Set<string>();
  for (const item of live) {
    const familyId = catalogFormatFamilyId(item.sourceFormat);
    if (familyId) families.add(familyId);
  }
  if (families.size > 0) {
    parts.push(`${families.size} ${families.size === 1 ? 'format' : 'formats'}`);
  }

  const scored = live
    .map((item) => item.qualityScore)
    .filter((score): score is number => typeof score === 'number' && Number.isFinite(score));
  if (scored.length > 0) {
    const mean = Math.round(scored.reduce((sum, score) => sum + score, 0) / scored.length);
    parts.push(`avg quality ${letterGradeFromOverallPercent(mean)} · ${mean}`);
  }

  const converted = live.filter((item) => Boolean(item.conversion)).length;
  if (converted > 0) parts.push(`${converted} converted`);

  if (showDeleted) {
    const deleted = items.filter((item) => item.deleted_at).length;
    if (deleted > 0) parts.push(`${deleted} deleted`);
  }
  return parts.join(' · ');
}

/** The identity-group chip's label — `Identity group idg_7c21e9…`, the mockup's spelling. */
export function catalogIdentityGroupLabel(identityGroupId: string): string {
  return `Identity group ${identityGroupId.slice(0, 8)}…`;
}

// ---------------------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------------------

/** One entry of the toolbar's sort menu. */
export interface CatalogSortOption {
  /** The comparator this option runs. */
  id: CatalogDashboardSortColumn;
  /** What the menu row says. */
  label: string;
}

/**
 * The sort menu, in the order it lists.
 *
 * The mockup's six. Every table column is also sortable — Protocol, Source and Status have
 * comparators too — but they are reached by clicking their header rather than by a menu row,
 * because a menu that lists nine ways to order seven items is longer than the list.
 */
export const CATALOG_SORT_OPTIONS: readonly CatalogSortOption[] = [
  { id: 'name', label: 'Name' },
  { id: 'created', label: 'Created' },
  { id: 'updated', label: 'Updated' },
  { id: 'quality', label: 'Quality' },
  { id: 'grade', label: 'Grade' },
  { id: 'format', label: 'Format' },
] as const;

/**
 * Display label per sortable column — the menu's six plus the ones only the table headers
 * offer. Keeps the "Sorted by …" summary honest whichever control was used.
 */
export const CATALOG_SORT_COLUMN_LABELS: Readonly<Record<CatalogDashboardSortColumn, string>> = {
  name: 'Artifact',
  description: 'Description',
  quality: 'Quality',
  grade: 'Grade',
  format: 'Format',
  protocol: 'Protocol',
  source: 'Source',
  status: 'Status',
  creator: 'Creator',
  created: 'Created',
  updated: 'Updated',
};

/** The sort a fresh page starts on — the mockup's `Sorted by name ↑`. */
export const DEFAULT_CATALOG_SORT: DataTableSortState = { column: 'name', direction: 'asc' };

/** Whether a string names a sortable catalog column. */
export function isCatalogSortColumn(id: string): id is CatalogDashboardSortColumn {
  return id in CATALOG_SORT_COLUMN_LABELS;
}

/**
 * `DataTable`'s sort state as the comparator's pair.
 *
 * `DataTable` speaks `{column, direction}` over arbitrary column ids and allows `null` for
 * "unsorted"; the comparators speak a closed union. This is the only place the two meet, so a
 * column id that is not sortable — or a cleared sort — falls back to the default rather than
 * reaching a comparator that has no case for it.
 *
 * @param sort The table's state, or `null`.
 * @returns The column and direction to compare by.
 */
export function catalogSortKey(sort: DataTableSortState | null | undefined): {
  column: CatalogDashboardSortColumn;
  direction: CatalogDashboardSortDirection;
} {
  if (!sort || !isCatalogSortColumn(sort.column)) {
    return {
      column: DEFAULT_CATALOG_SORT.column as CatalogDashboardSortColumn,
      direction: DEFAULT_CATALOG_SORT.direction,
    };
  }
  return { column: sort.column, direction: sort.direction };
}

/**
 * Order the rows.
 *
 * @param items The rows the search, the chip and the quick filters left.
 * @param sort The table's sort state.
 * @returns A new, sorted array.
 */
export function sortCatalog<T extends CatalogItem>(
  items: readonly T[],
  sort: DataTableSortState | null | undefined
): T[] {
  const { column, direction } = catalogSortKey(sort);
  return sortCatalogDashboardRows(items, column, direction);
}

/** `name ↑` — the phrase the toolbar button and the table foot both end with. */
export function catalogSortLabel(sort: DataTableSortState | null | undefined): string {
  const { column, direction } = catalogSortKey(sort);
  return `${CATALOG_SORT_COLUMN_LABELS[column].toLowerCase()} ${direction === 'asc' ? '↑' : '↓'}`;
}

/** The table foot: `7 items · sorted by artifact ↑`. */
export function catalogFootLabel(
  count: number,
  sort: DataTableSortState | null | undefined
): string {
  return `${count} ${count === 1 ? 'item' : 'items'} · sorted by ${catalogSortLabel(sort)}`;
}

// ---------------------------------------------------------------------------------------
// Row actions
// ---------------------------------------------------------------------------------------

/** Which verbs a row's overflow menu offers. */
export interface CatalogRowActions {
  /** Open the item's detail view. */
  details: boolean;
  /** Open its revisions. */
  versions: boolean;
  /** Open the server lint report. */
  lint: boolean;
  /** Open the Export Studio scoped to it (MFX-41.2). */
  export: boolean;
  /** Open the conversion preview (MFI-22.4). */
  convert: boolean;
  /** Soft-delete it. */
  delete: boolean;
  /** Restore it. */
  undelete: boolean;
  /** Destroy it — always offered, on both kinds of row. */
  permanentDelete: boolean;
}

/**
 * The single gate on what a row may do.
 *
 * Stated once, here, rather than re-derived as `item.deleted_at ? … : …` in each of the two
 * views: a deleted item has no detail page, no revisions, no lint report, nothing to export
 * and nothing to convert — the only two things left are putting it back and finishing the
 * job. There is deliberately **no Publish and no Edit**: the catalog is the non-publishable
 * slice (MFI-23.1) and its items are minted by the import routing (MFI-23.7), not here.
 *
 * @param item The row.
 * @returns One flag per verb. See {@link CatalogRowActions}.
 */
export function catalogRowActions(item: CatalogItem): CatalogRowActions {
  const deleted = Boolean(item.deleted_at);
  return {
    details: !deleted,
    versions: !deleted,
    lint: !deleted,
    export: !deleted,
    convert: !deleted,
    delete: !deleted,
    undelete: deleted,
    permanentDelete: true,
  };
}

// ---------------------------------------------------------------------------------------
// Destructive confirms
// ---------------------------------------------------------------------------------------

/**
 * Soft delete — reversible, so no gate.
 *
 * DESIGN.md §8 reserves type-to-confirm for what cannot be undone; a soft delete says how to
 * get the item back instead, which is the more useful sentence.
 */
export function softDeleteCatalogItemConfirm(item: CatalogItem): DestructiveConfirmOptions {
  return destructiveConfirm({
    action: 'Delete',
    noun: 'catalog item',
    name: item.name,
    consequence:
      'The item is hidden from the catalog and its pickers. Turn on "Show deleted" to undelete it.',
  });
}

/**
 * Permanent delete — the one gate on this screen.
 *
 * What this replaces was **two** `window.confirm`s in a row, the second a restatement of the
 * first: a delay dressed as a check, which teaches a reader to click twice without reading.
 * It is one dialog now, gated on the item's **slug** — unique within the workspace and
 * printed on the very card the click came from, so the gate cannot be passed for the wrong
 * item by a reader who is looking at the right one. An item with no slug falls back to its
 * name rather than opening an ungated confirm.
 */
export function permanentDeleteCatalogItemConfirm(item: CatalogItem): DestructiveConfirmOptions {
  return destructiveConfirm({
    action: 'Permanently delete',
    noun: 'catalog item',
    name: item.name,
    consequence:
      'Every revision of this item, its stored source material and its lint history are destroyed. A conversion already made into an OpenAPI project is left alone.',
    typeToConfirm: true,
    confirmLabel: 'Delete everything',
    confirmPhrase: item.slug?.trim() || item.name,
  });
}

/** Undelete — not destructive, but it changes what other pickers show, so it is confirmed. */
export function undeleteCatalogItemConfirm(item: CatalogItem): {
  title: string;
  message: string;
  variant: 'info';
  confirmLabel: string;
  cancelLabel: string;
} {
  return {
    title: `Undelete catalog item "${item.name}"?`,
    message:
      'It returns to the catalog with the enabled or disabled state it had before deletion.',
    variant: 'info',
    confirmLabel: 'Undelete item',
    cancelLabel: 'Cancel',
  };
}

// ---------------------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------------------

/** What a bulk action may do to the current selection. */
export interface CatalogBulkPlan {
  /** Selected rows that are live and can be soft-deleted. */
  deletable: CatalogItem[];
  /** Selected rows that are deleted and can be restored. */
  restorable: CatalogItem[];
}

/**
 * Split a selection into the two things a bulk action can do to it.
 *
 * The bulk bar offers Delete and Undelete at once because a selection can hold both kinds of
 * row, and hiding the verb that applies to *some* of the selection would leave the reader
 * clearing and re-selecting. Each button states its own count, so neither can be pressed
 * without knowing how many rows it reaches.
 *
 * Convert is deliberately not a bulk verb: every conversion has its own fidelity preview to
 * read and its own low-tier acknowledgement, and a bulk button cannot ask for eight of them.
 *
 * @param items Every row currently on screen.
 * @param selectedIds The ids the table reports as selected.
 * @returns The rows each verb applies to. See {@link CatalogBulkPlan}.
 */
export function catalogBulkPlan(
  items: readonly CatalogItem[],
  selectedIds: readonly string[]
): CatalogBulkPlan {
  const chosen = new Set(selectedIds);
  const selected = items.filter((item) => chosen.has(item.id));
  return {
    deletable: selected.filter((item) => !item.deleted_at),
    restorable: selected.filter((item) => Boolean(item.deleted_at)),
  };
}

/**
 * What a bulk write says once it has finished.
 *
 * States the split rather than only the successes: "Deleted 3 of 5 catalog items" with the
 * first refusal named is the sentence a reader can act on, and a bare success count after a
 * partial failure reads as a complete success.
 *
 * @param verb Past tense, capitalised — `Deleted`, `Undeleted`.
 * @param applied How many writes succeeded.
 * @param total How many were attempted.
 * @param firstError The first failure's message, if any.
 * @returns The toast's text.
 */
export function catalogBulkResultMessage(
  verb: string,
  applied: number,
  total: number,
  firstError?: string | null
): string {
  const noun = total === 1 ? 'catalog item' : 'catalog items';
  if (applied === total) return `${verb} ${applied} ${noun}.`;
  const reason = firstError?.trim();
  return `${verb} ${applied} of ${total} ${noun} · ${total - applied} refused${
    reason ? ` — ${reason}` : ''
  }`;
}
