/**
 * The rules the Catalog **item detail** screen runs on (HIVE-7.2, #5319).
 *
 * Authority: `docs/mockups/sources/catalog-item.html` and its **Notes → Keeps (1:1)** list;
 * `docs/mockups/DESIGN.md` §5.3 (page header), §3.1 (status vocabulary) and §8 (states).
 *
 * The screen this serves is the largest in the epic: eight panes, two format inspectors, a
 * projection graph and a test bench. Before this ticket every decision it makes lived inside
 * the 1,431-line `CatalogItemDetailClient` — which of two quality numbers the orbs show, when
 * Convert and Export disappear, what the converted strip says, how the four provenance steps
 * are worded, which tabs carry a count. None of it could be asserted without mounting the
 * whole screen, and two of the rules were spelled twice with different answers.
 *
 * Everything here is pure and React-free. There is no colour and no class name in this file:
 * a tone is looked up from `ui/statusVocabulary` and `ui/metrics/metricTiers` by whichever
 * component paints it, a format's hue comes from the fixed identity block via
 * `ui/catalog/FormatPill`, and an icon is a `lucide-react` component the pane chooses from
 * the key this module returns.
 *
 * @see `./CatalogItemOverview.tsx`, `./CatalogItemProvenance.tsx`,
 *   `./CatalogConvertedStrip.tsx` — the panes these rules serve.
 * @see `../catalogModel.ts` — the list's rules; the lifecycle vocabulary is shared with it.
 * @see `@/app/utils/catalog-detail-insights` — the composition/coverage arithmetic, which
 *   predates this ticket and is unchanged.
 */

import {
  CATALOG_LIFECYCLE_LABEL,
  type CatalogLifecycle,
} from '../catalogModel';
import { catalogOrbScores, formatShortCatalogId } from '@/app/utils/catalog-card-presentation';
import { catalogQualityOpensServerLintReport } from '@/app/utils/catalog-lint-panel';
import { getNumericScoreTier } from '@/app/utils/numeric-score-tier';
import {
  convertActionLabel,
  convertedProjectHref,
  convertedProjectLabel,
  isConvertedLinkLive,
  type CatalogConversion,
} from '@/app/utils/catalog-conversion';
import type { ProjectQualitySnapshot } from '@/app/utils/project-quality-score-history';

// ---------------------------------------------------------------------------------------
// The item
// ---------------------------------------------------------------------------------------

/** Where the item was imported from, plus whether the raw source is retrievable. */
export interface CatalogSourceDescriptor {
  kind: 'file' | 'url' | 'paste' | 'discovery' | null;
  label: string | null;
  uri: string | null;
  hasContent: boolean;
  downloadable: boolean;
}

/** The normalized-content counts the import recorded (each `null` until captured). */
export interface CatalogNormalizedSummary {
  services: number | null;
  operations: number | null;
  types: number | null;
  channels: number | null;
}

/**
 * The subset of the `/api/catalog/{id}` payload these rules read.
 *
 * Deliberately structural rather than the screen's full `CatalogItemDetail`: a rule that only
 * needs the name and the delete stamp should be callable with those two, which is what makes
 * the suite readable.
 */
export interface CatalogDetailItem {
  id: string;
  name: string;
  slug?: string | null;
  description?: string | null;
  enabled: boolean;
  deleted_at: string | null;
  qualityScore?: number | null;
  qualityGrade?: string | null;
  sourceFormat?: string | null;
  conversion?: CatalogConversion | null;
}

// ---------------------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------------------

/** Where the Catalog list lives — the breadcrumb's and the not-found state's destination. */
export const CATALOG_LIST_HREF = '/ade/dashboard/catalog';

/**
 * The item's lifecycle, in the vocabulary the list uses.
 *
 * Deleted wins over disabled: a deleted item is not merely switched off, and the header's one
 * badge has to say the stronger of the two.
 *
 * @param item The item.
 * @returns `deleted`, `disabled` or `active`.
 */
export function catalogDetailLifecycle(item: Pick<CatalogDetailItem, 'enabled' | 'deleted_at'>): CatalogLifecycle {
  if (item.deleted_at) return 'deleted';
  return item.enabled ? 'active' : 'disabled';
}

/** The label for the header's status badge — the list's wording, so the two never drift. */
export function catalogDetailStatusLabel(item: Pick<CatalogDetailItem, 'enabled' | 'deleted_at'>): string {
  return CATALOG_LIFECYCLE_LABEL[catalogDetailLifecycle(item)];
}

/**
 * The trail above the title: Home › Bring in › Catalog › this item.
 *
 * "Bring in" is a group rather than a destination — it is the rail's section name, and the
 * mockup draws it without a link — so its step carries no `href`. The first crumb is "Home"
 * rather than the workspace's name for the reason every other detail screen in the epic gives:
 * the rail already names the workspace, and repeating it in the trail costs a crumb without
 * telling the reader anything new.
 *
 * @param item The item.
 * @returns The breadcrumb steps, outermost first.
 */
export function catalogDetailBreadcrumb(
  item: Pick<CatalogDetailItem, 'name'>,
): { label: string; href?: string }[] {
  return [
    { label: 'Home', href: '/ade/dashboard' },
    { label: 'Bring in' },
    { label: 'Catalog', href: CATALOG_LIST_HREF },
    { label: item.name },
  ];
}

/**
 * The mono identity line under the title: `cat_c3a5e1 · claims-837p`.
 *
 * @param item The item.
 * @returns The short id, and the slug after a middot when the item has one.
 */
export function catalogDetailIdLine(item: Pick<CatalogDetailItem, 'id' | 'slug'>): string {
  const short = formatShortCatalogId(item.id);
  return item.slug?.trim() ? `${short} · ${item.slug.trim()}` : short;
}

/** The description, or the fixed stand-in the mockup's Keeps list fixes. */
export function catalogDetailDescription(item: Pick<CatalogDetailItem, 'description'>): string {
  return item.description?.trim() || 'No description.';
}

// ---------------------------------------------------------------------------------------
// The header's verbs
// ---------------------------------------------------------------------------------------

/** Which of the header's three CTAs are offered, and what the first one is called. */
export interface CatalogDetailActions {
  /** Convert / Re-convert — hidden once the item is deleted. */
  convert: { shown: boolean; label: string };
  /** Export — hidden once the item is deleted; never mints a project. */
  export: { shown: boolean };
  /** "View code" — always offered; a deleted item's captured source is still readable. */
  viewCode: { shown: boolean };
}

/**
 * The header's verbs for one item.
 *
 * The one rule worth stating: **deleting an item hides the two verbs that would write.**
 * Convert mints a project and Export starts a generation run; neither is meaningful against a
 * tombstone, and the pre-Hive header hid them with two separate `!item.deleted_at` guards
 * written 20 lines apart. "View code" survives, because reading what was imported is exactly
 * what a reader wants from a deleted item.
 *
 * @param item The item.
 * @returns Which CTAs to draw, and the convert verb's label.
 */
export function catalogDetailActions(
  item: Pick<CatalogDetailItem, 'deleted_at' | 'sourceFormat' | 'conversion'>,
): CatalogDetailActions {
  const live = !item.deleted_at;
  return {
    convert: {
      shown: live,
      label: convertActionLabel(item.conversion ?? null, item.sourceFormat ?? null),
    },
    export: { shown: live },
    viewCode: { shown: true },
  };
}

/** True when the Related-artifacts panel may only be read (a deleted item's links are frozen). */
export function isCatalogDetailReadonly(item: Pick<CatalogDetailItem, 'deleted_at'>): boolean {
  return Boolean(item.deleted_at);
}

// ---------------------------------------------------------------------------------------
// The orbs
// ---------------------------------------------------------------------------------------

/** What the two header orbs show: a 0–100 quality number and an A–F lint letter, either absent. */
export interface CatalogDetailOrbs {
  /** The number the Quality orb prints, or `null` for the unscored ring. */
  quality: number | null;
  /** The letter the Lint orb prints, or `null` for the unscored ring. */
  grade: string | null;
  /** True when the Quality orb opens the *server* lint report rather than the local history. */
  qualityOpensLintReport: boolean;
}

/**
 * The two header orbs.
 *
 * The precedence is the list's (`catalogOrbScores`): the **server** score wins, the browser's
 * newest local snapshot stands in when the server has none, and an em dash when neither
 * exists. The third field answers the header's other question — *where the Quality orb goes*
 * — and delegates to `catalogQualityOpensServerLintReport`, so this screen cannot grow a
 * second opinion about it: a server-captured score always opens the itemized server report,
 * even when stale browser-local snapshots exist from an unrelated import flow.
 *
 * @param item The item.
 * @param history Its browser-local quality snapshots, oldest first.
 * @returns What each orb prints, and where the Quality orb goes.
 */
export function catalogDetailOrbs(
  item: Pick<CatalogDetailItem, 'qualityScore' | 'qualityGrade'>,
  history: readonly ProjectQualitySnapshot[],
): CatalogDetailOrbs {
  const snapshots = [...history];
  const { qualityValue, lintLetter } = catalogOrbScores(item, snapshots);
  return {
    quality: qualityValue,
    grade: lintLetter,
    qualityOpensLintReport: catalogQualityOpensServerLintReport(snapshots, item.qualityScore),
  };
}

/** The two sentences the Overview's Quality snapshot prints beside its ring. */
export interface CatalogQualityBand {
  /** "Good · 70–89" — the band the *grade* vocabulary puts this score in. */
  band: string;
  /** "Minor improvements needed." — what that band asks the reader to do. */
  detail: string;
}

/**
 * The two sentences under the Quality snapshot's ring.
 *
 * The words come from `getNumericScoreTier`, the product's **grade** vocabulary, which splits
 * at 90/70/50/40; the ring's colour comes from `ui/metrics/metricTiers`, the **attention**
 * vocabulary, which splits at 90/75/60. The two disagree at 72 on purpose — it is a B that is
 * nevertheless asking for attention — and `Ring` already renders both, so this only has to
 * pick the half that is words.
 *
 * @param score The 0–100 quality score.
 * @returns The band line and the advice line, or `null` when there is no score.
 */
export function catalogQualityBand(score: number | null | undefined): CatalogQualityBand | null {
  if (typeof score !== 'number' || !Number.isFinite(score)) return null;
  const tier = getNumericScoreTier(score);
  return { band: `${tier.shortLabel} · ${tier.rangeLabel}`, detail: `${tier.detailLabel}.` };
}

// ---------------------------------------------------------------------------------------
// The converted strip
// ---------------------------------------------------------------------------------------

/** The sentence — and the link — the converted strip above the panes draws. */
export interface CatalogConvertedStripView {
  /** "Converted to OpenAPI project" or its re-conversion wording. */
  title: string;
  /** The recorded version id, when one was kept. */
  versionId: string | null;
  /** The target project's name. */
  projectLabel: string;
  /** Its route — `null` when the project was deleted, which is what strikes the name through. */
  projectHref: string | null;
  /** "The converted project was deleted", as the tooltip on the struck-through name. */
  deletedHint: string | null;
  /** "2 conversions on record", when the item has more than the one. */
  countLine: string | null;
}

/** The tooltip a struck-through converted link carries, fixed by the mockup's Keeps list. */
export const CONVERTED_PROJECT_DELETED_HINT = 'The converted project was deleted';

/**
 * The converted strip for one item, or `null` when the item has never been converted.
 *
 * @param conversion The item's recorded conversion back-link.
 * @param conversionCount How many conversions the history holds; `0` when it has not loaded.
 * @returns The strip's parts, or `null` when there is no strip to draw.
 */
export function catalogConvertedStrip(
  conversion: CatalogConversion | null | undefined,
  conversionCount = 0,
): CatalogConvertedStripView | null {
  if (!conversion) return null;
  const live = isConvertedLinkLive(conversion);
  return {
    title: conversion.reconverted
      ? 'Re-converted to OpenAPI project'
      : 'Converted to OpenAPI project',
    versionId: conversion.versionId?.trim() || null,
    projectLabel: convertedProjectLabel(conversion),
    projectHref: live ? convertedProjectHref(conversion) : null,
    deletedHint: live ? null : CONVERTED_PROJECT_DELETED_HINT,
    countLine:
      conversionCount > 1
        ? `${conversionCount} conversions on record`
        : conversionCount === 1
          ? '1 conversion on record'
          : null,
  };
}

// ---------------------------------------------------------------------------------------
// The tabs
// ---------------------------------------------------------------------------------------

/** The eight panes, in the order the mockup's tab row draws them. */
export const CATALOG_DETAIL_TAB_IDS = [
  'overview',
  'format',
  'source',
  'provenance',
  'conversions',
  'lint',
  'test-bench',
  'versions',
] as const;

export type CatalogDetailTabId = (typeof CATALOG_DETAIL_TAB_IDS)[number];

/** Tab ids a `?tab=` deep link may name, so an unknown value is ignored rather than blanking the shell. */
const TAB_ID_SET: ReadonlySet<string> = new Set(CATALOG_DETAIL_TAB_IDS);

/** One tab: its id, its label, the lucide glyph key, and the count beside it when it has one. */
export interface CatalogDetailTabView {
  id: CatalogDetailTabId;
  label: string;
  /** The glyph key the tab strip resolves against its own icon table. */
  icon: string;
  /** The count chip, or `null` when the pane has nothing to count yet. */
  count: number | null;
}

/** Label + glyph per pane. The labels are the mockup's, which shortened three of the old ones. */
const TAB_META: Readonly<Record<CatalogDetailTabId, { label: string; icon: string }>> = {
  overview: { label: 'Overview', icon: 'overview' },
  format: { label: 'Format details', icon: 'format' },
  source: { label: 'Source & code', icon: 'source' },
  provenance: { label: 'Provenance', icon: 'provenance' },
  conversions: { label: 'Conversions', icon: 'conversions' },
  lint: { label: 'Lint & score', icon: 'lint' },
  'test-bench': { label: 'Test bench', icon: 'test-bench' },
  versions: { label: 'Versions', icon: 'versions' },
};

/** The counts a caller can hand the tab row; each is `null` until its pane has loaded. */
export interface CatalogDetailTabCounts {
  conversions?: number | null;
  lint?: number | null;
  versions?: number | null;
}

/**
 * The eight tabs, with the three counts the mockup shows.
 *
 * A count of `0` is still a count — "Conversions 0" is a fact the reader can act on, and the
 * mockup's empty-state copy says as much — but a count that has not *loaded* is `null` and
 * draws no chip at all. That distinction is the whole reason this is a function.
 *
 * @param counts What each counted pane has loaded so far.
 * @returns The tabs in display order.
 */
export function catalogDetailTabs(counts: CatalogDetailTabCounts = {}): CatalogDetailTabView[] {
  return CATALOG_DETAIL_TAB_IDS.map((id) => {
    const raw =
      id === 'conversions' ? counts.conversions
      : id === 'lint' ? counts.lint
      : id === 'versions' ? counts.versions
      : null;
    return {
      id,
      label: TAB_META[id].label,
      icon: TAB_META[id].icon,
      count: typeof raw === 'number' && Number.isFinite(raw) ? raw : null,
    };
  });
}

/**
 * Which pane a URL asks for.
 *
 * Three deep-link shapes reach this screen and the *source* one wins outright: a
 * `?sourcePath=`/`?line=` compatibility link (CLX-2.3) names a place in the raw source, so it
 * opens Source & code no matter what `?tab=` says. Otherwise a `?tab=` naming a known pane is
 * honoured, and anything else falls through to `null` — the caller keeps whatever pane the
 * reader is on rather than blanking the shell.
 *
 * @param tab The raw `?tab=` value.
 * @param sourceDeepLink The parsed `?sourcePath=`/`?line=` pair.
 * @returns The pane to open, or `null` for "leave it alone".
 */
export function catalogDetailTabFromQuery(
  tab: string | null | undefined,
  sourceDeepLink?: { sourcePath?: string | null; line?: number | null } | null,
): CatalogDetailTabId | null {
  if (tab === 'source' || sourceDeepLink?.sourcePath || sourceDeepLink?.line) return 'source';
  if (tab && TAB_ID_SET.has(tab)) return tab as CatalogDetailTabId;
  return null;
}

/** The shareable address of one native-analysis construct: `?tab=format&node=<id>`. */
export function catalogFormatNodeHref(itemId: string, nodeId: string): string {
  return `${CATALOG_LIST_HREF}/${encodeURIComponent(itemId)}?tab=format&node=${encodeURIComponent(nodeId)}`;
}

// ---------------------------------------------------------------------------------------
// The Overview pane
// ---------------------------------------------------------------------------------------

/** Intake kinds, as the import records them. */
export type CatalogSourceKindId = CatalogSourceDescriptor['kind'];

/** How a source-intake kind is spoken and drawn. */
export interface CatalogSourceKindView {
  /** "File upload", "Fetched from URL", … */
  label: string;
  /** The glyph key the pane resolves against its own icon table. */
  icon: string;
}

const SOURCE_KIND_VIEW: Readonly<Record<'file' | 'url' | 'paste' | 'discovery' | 'unknown', CatalogSourceKindView>> = {
  file: { label: 'File upload', icon: 'file' },
  url: { label: 'Fetched from URL', icon: 'url' },
  paste: { label: 'Pasted content', icon: 'paste' },
  discovery: { label: 'Discovered endpoint', icon: 'discovery' },
  unknown: { label: 'Unknown intake', icon: 'file' },
};

/**
 * How to speak and draw one intake kind.
 *
 * @param kind The recorded kind, or `null` when the import did not record one.
 * @returns Its label and glyph key.
 */
export function catalogSourceKindView(kind: CatalogSourceKindId): CatalogSourceKindView {
  return SOURCE_KIND_VIEW[kind ?? 'unknown'];
}

/** The chips the Source snapshot and the intake provenance step both draw. */
export interface CatalogSourceChip {
  /** What the chip says. */
  label: string;
  /** Its tone in the shared vocabulary — `ok`, `accent` or `neutral`. */
  tone: 'ok' | 'accent' | 'neutral';
  /** The full value, for a chip whose label is clipped (the URI). */
  title?: string;
  /** True for the chip that carries a URI and therefore clips. */
  uri?: boolean;
}

/**
 * The source snapshot's chips: what was captured, whether it can be downloaded, and where it
 * came from.
 *
 * One rule, and it is the one the two pre-Hive copies of this list disagreed about: an item
 * whose content was *not* captured says "Reference only" rather than silently dropping the
 * chip, because "we kept a pointer" and "we kept the bytes" are different promises.
 *
 * @param source The item's source descriptor.
 * @returns The chips, in display order.
 */
export function catalogSourceChips(source: CatalogSourceDescriptor | null | undefined): CatalogSourceChip[] {
  const chips: CatalogSourceChip[] = [];
  chips.push(
    source?.hasContent
      ? { label: 'Content captured', tone: 'ok' }
      : { label: 'Reference only', tone: 'neutral' },
  );
  if (source?.downloadable) chips.push({ label: 'Downloadable', tone: 'accent' });
  if (source?.uri) chips.push({ label: source.uri, tone: 'neutral', title: source.uri, uri: true });
  return chips;
}

/** The one-line name the Source snapshot prints, or the stand-in when nothing was recorded. */
export function catalogSourceHeadline(source: CatalogSourceDescriptor | null | undefined): string {
  return source?.label || source?.uri || 'No source reference captured';
}

/** Per-surface presentation for the API-surface tiles and the composition bar. */
export interface CatalogSurfaceTileView {
  key: 'services' | 'operations' | 'types' | 'channels';
  label: string;
  /** The glyph key the pane resolves against its own icon table. */
  icon: string;
  /** The metric tone the tile's glyph and its bar slice take. */
  tone: 'ok' | 'accent' | 'violet' | 'rose';
}

/**
 * The four API-surface tiles, in display order.
 *
 * The tones are the mockup's and they are *identities* rather than states — a service is
 * always the same colour as the services slice of the bar beside it — which is why they are
 * named here once instead of at the two places that paint them.
 */
export const CATALOG_SURFACE_TILES: readonly CatalogSurfaceTileView[] = [
  { key: 'services', label: 'Services', icon: 'services', tone: 'ok' },
  { key: 'operations', label: 'Operations', icon: 'operations', tone: 'accent' },
  { key: 'types', label: 'Types', icon: 'types', tone: 'violet' },
  { key: 'channels', label: 'Channels', icon: 'channels', tone: 'rose' },
];

/**
 * What one surface tile prints under its count.
 *
 * @param value The captured count, or `null`/`undefined` when the import did not record one.
 * @param percent Its whole-percent share of the captured total, or `null` when unknowable.
 * @returns "3% of surface", "None captured" or "Not captured".
 */
export function catalogSurfaceTileFoot(
  value: number | null | undefined,
  percent: number | null,
): string {
  if (typeof value !== 'number') return 'Not captured';
  if (percent === null) return 'None captured';
  return `${percent}% of surface`;
}

/**
 * The "29 normalized entities" line beside the API-surface heading.
 *
 * @param total The summed captured counts.
 * @returns The sentence, or `null` when nothing was captured.
 */
export function catalogSurfaceCountLine(total: number): string | null {
  if (total <= 0) return null;
  return `${total.toLocaleString()} normalized ${total === 1 ? 'entity' : 'entities'}`;
}

/** The "28 entities · 143 fields" line beside the observability heading. */
export function catalogModelCountLine(entityCount: number, fieldCount: number): string {
  const entities = `${entityCount.toLocaleString()} ${entityCount === 1 ? 'entity' : 'entities'}`;
  const fields = `${fieldCount.toLocaleString()} ${fieldCount === 1 ? 'field' : 'fields'}`;
  return `${entities} · ${fields}`;
}

// ---------------------------------------------------------------------------------------
// The Provenance pane
// ---------------------------------------------------------------------------------------

/** One step of the import journey the Provenance rail draws. */
export interface CatalogProvenanceStep {
  /** 1-based position, printed as "Step 1 · Source intake". */
  step: number;
  /** The step's name. */
  title: string;
  /** The sentence under it, verbatim from the mockup. */
  caption: string;
  /** The glyph key the pane resolves against its own icon table. */
  icon: string;
  /** The icon tile's tone. */
  tone: 'accent' | 'violet' | 'ok' | 'honey';
}

/**
 * The four provenance steps, in order.
 *
 * The titles and captions are fixed by the mockup's Keeps list ("verbatim step
 * titles/captions"), so they live here rather than inline in four JSX blocks where a typo in
 * one would go unnoticed. The intake step's glyph is the only variable one — it follows the
 * recorded intake kind — so the caller overrides it from {@link catalogSourceKindView}.
 */
export const CATALOG_PROVENANCE_STEPS: readonly CatalogProvenanceStep[] = [
  {
    step: 1,
    title: 'Source intake',
    caption: 'Where the imported document came from.',
    icon: 'file',
    tone: 'accent',
  },
  {
    step: 2,
    title: 'Format detection',
    caption: 'The format and protocol the importer recognized this source as.',
    icon: 'detection',
    tone: 'violet',
  },
  {
    step: 3,
    title: 'Normalization',
    caption: 'The toolchain that parsed the source into the canonical model.',
    icon: 'normalization',
    tone: 'ok',
  },
  {
    step: 4,
    title: 'Catalog record',
    caption: 'The import job that minted this item, and who ran it when.',
    icon: 'record',
    tone: 'honey',
  },
];

/** The candidate keys an import-job reference may travel under in the provenance bag. */
const IMPORT_JOB_KEYS = [
  'importJobId',
  'import_job_id',
  'jobId',
  'job_id',
  'importJob',
  'import_job',
];

/**
 * The import job's reference, whichever of six spellings the importer used.
 *
 * @param bag The item's `formatMetadata`.
 * @returns The reference, or `null` when none was recorded.
 */
export function catalogImportJobRef(bag: Record<string, unknown> | null | undefined): string | null {
  if (!bag) return null;
  for (const key of IMPORT_JOB_KEYS) {
    const value = bag[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

/**
 * The tool-version chips the Normalization step draws.
 *
 * @param toolVersions The item's recorded toolchain bag.
 * @returns `{ tool, version }` pairs with the empty values dropped, in recorded order.
 */
export function catalogToolVersions(
  toolVersions: Record<string, unknown> | null | undefined,
): { tool: string; version: string }[] {
  return Object.entries(toolVersions ?? {})
    .filter(([, value]) => value != null && String(value).trim() !== '')
    .map(([tool, value]) => ({ tool, version: String(value).trim() }));
}

/** The stand-in each provenance step prints when its fact was never recorded. */
export const PROVENANCE_ABSENT = {
  intake: 'Not recorded',
  detection: 'No detected format or protocol was recorded.',
  normalization: 'Tool versions were not recorded for this import.',
  record: 'Not recorded',
} as const;

/**
 * Format an ISO instant for the Catalog record step, tolerating null and invalid input.
 *
 * @param value The instant.
 * @returns Its locale rendering, the raw string when it will not parse, or an em dash.
 */
export function catalogDetailTimestamp(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}
