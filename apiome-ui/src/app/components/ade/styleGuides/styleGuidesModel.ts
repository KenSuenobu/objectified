/**
 * The style-guides derivations — HIVE-5.6 (#5309).
 *
 * Authority: `docs/mockups/govern/style-guides.html`, whose **Notes → Keeps (1:1)** list is
 * this ticket's acceptance criteria, and `apiome-rest/src/app/style_guide_routes.py`, which is
 * where the read-only built-in guide and the delete-time fallback really come from.
 *
 * Everything here is pure: it takes guides and returns guides, counts, sentences or
 * permissions, and touches neither React nor `fetch`. That is what lets
 * `tests/style-guides-model.test.ts` pin the parts of this screen that are *claims* — which
 * guide may be edited, what a deletion actually costs, which chips a row carries — without
 * rendering anything.
 */

import type { StyleGuide } from '@/app/ade/dashboard/style-guides/api';
import type { StatusTone } from '@/app/components/ui/statusVocabulary';

export type { StyleGuide };

// ---------------------------------------------------------------------------------------
// The built-in guide
// ---------------------------------------------------------------------------------------

/**
 * Whether this is the shipped, read-only guide.
 *
 * `source` is the server's own word for it, and `style_guide_routes.py` refuses to rename,
 * re-rule or delete a `builtin` guide with a 409 — so this predicate is what the UI uses to
 * avoid offering an action the API will refuse.
 *
 * @param guide The guide.
 * @returns True for the built-in guide.
 */
export function isBuiltinGuide(guide: StyleGuide): boolean {
  return guide.source === 'builtin';
}

/**
 * The tenant's built-in guide, if the list holds one.
 *
 * @param guides Every guide.
 * @returns The built-in guide, or `null`.
 */
export function findBuiltinGuide(guides: readonly StyleGuide[]): StyleGuide | null {
  return guides.find(isBuiltinGuide) ?? null;
}

// ---------------------------------------------------------------------------------------
// What a viewer may do
// ---------------------------------------------------------------------------------------

/** What the current viewer may do to one guide. */
export interface StyleGuideRowActions {
  /** Open the assign dialog — tenant default and project pins. */
  canAssign: boolean;
  /** Copy the guide's rules into a new, editable guide. */
  canDuplicate: boolean;
  /** Rename it or change its description. */
  canEdit: boolean;
  /** Delete it. */
  canDelete: boolean;
  /** Why editing and deleting are absent, when they are. */
  readOnlyReason: string | null;
}

/**
 * The verbs a row affords.
 *
 * Two independent gates, stated once so five call sites cannot disagree:
 *
 * 1. **Administration.** Every mutation on this screen is tenant-admin only — the REST layer
 *    enforces it, and a non-admin who is offered the control only learns that when the write
 *    is refused. The page says so in a banner rather than leaving the absence unexplained.
 * 2. **The built-in guide is read-only.** It may be assigned and duplicated — which is the
 *    whole of its "duplicate path" — and never renamed or deleted.
 *
 * @param guide The guide.
 * @param canMutate Whether the viewer administers this tenant.
 * @returns The four verbs, and why two of them may be missing.
 */
export function styleGuideRowActions(
  guide: StyleGuide,
  canMutate: boolean
): StyleGuideRowActions {
  const builtin = isBuiltinGuide(guide);
  return {
    canAssign: canMutate,
    canDuplicate: canMutate,
    canEdit: canMutate && !builtin,
    canDelete: canMutate && !builtin,
    readOnlyReason: builtin
      ? 'The built-in guide is read-only — duplicate it to customize.'
      : null,
  };
}

// ---------------------------------------------------------------------------------------
// Facets
// ---------------------------------------------------------------------------------------

/** The toolbar's chips, in the order the mockup shows them. */
export const STYLE_GUIDE_FACETS = ['all', 'custom', 'assigned', 'unassigned'] as const;

/** One of {@link STYLE_GUIDE_FACETS}. */
export type StyleGuideFacet = (typeof STYLE_GUIDE_FACETS)[number];

/** Each chip's label. */
export const STYLE_GUIDE_FACET_LABELS: Readonly<Record<StyleGuideFacet, string>> = {
  all: 'All',
  custom: 'Custom',
  assigned: 'Assigned',
  unassigned: 'Unassigned',
};

/**
 * Whether a guide governs anything.
 *
 * "Assigned" means it is the tenant default *or* pinned to at least one project — the two
 * ways `resolve_style_guide` (GOV-1.4) can pick it — so an assigned guide is exactly one that
 * some lint run could resolve to.
 *
 * @param guide The guide.
 * @returns True when the guide is reachable by a lint run.
 */
export function isAssignedGuide(guide: StyleGuide): boolean {
  return guide.isDefault || guide.projectAssignments.length > 0;
}

/**
 * Whether a guide belongs to a facet.
 *
 * @param guide The guide.
 * @param facet The chip.
 * @returns True when the chip would keep it.
 */
export function matchesStyleGuideFacet(guide: StyleGuide, facet: StyleGuideFacet): boolean {
  switch (facet) {
    case 'custom':
      return !isBuiltinGuide(guide);
    case 'assigned':
      return isAssignedGuide(guide);
    case 'unassigned':
      return !isAssignedGuide(guide);
    default:
      return true;
  }
}

/**
 * How many guides each chip would leave.
 *
 * @param guides The guides the chips sit above — already narrowed by the search box, so a
 *   count never promises rows the reader would not then see.
 * @returns A count per facet.
 */
export function styleGuideFacetCounts(
  guides: readonly StyleGuide[]
): Readonly<Record<StyleGuideFacet, number>> {
  const counts = {} as Record<StyleGuideFacet, number>;
  for (const facet of STYLE_GUIDE_FACETS) {
    counts[facet] = guides.filter((guide) => matchesStyleGuideFacet(guide, facet)).length;
  }
  return counts;
}

// ---------------------------------------------------------------------------------------
// Search & sort
// ---------------------------------------------------------------------------------------

/**
 * Narrow guides to those matching a free-text query.
 *
 * Matches the name, the description and the names of the projects the guide is pinned to —
 * "which guide governs Payments API?" is the question this list most often has to answer.
 *
 * @param guides The guides.
 * @param query What was typed. Blank keeps everything.
 * @returns The matching guides, in their original order.
 */
export function searchStyleGuides(
  guides: readonly StyleGuide[],
  query: string
): StyleGuide[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...guides];
  return guides.filter((guide) =>
    [guide.name, guide.description ?? '', ...guide.projectAssignments.map((a) => a.projectName)]
      .join(' ')
      .toLowerCase()
      .includes(needle)
  );
}

/** The sortable columns, by their `DataTable` column id. */
export type StyleGuideSortColumn = 'name' | 'rules' | 'assignments' | 'updated';

/** How one guide answers a sort on each column. */
const SORT_VALUES: Readonly<Record<StyleGuideSortColumn, (guide: StyleGuide) => string | number>> =
  {
    name: (guide) => guide.name.toLowerCase(),
    rules: (guide) => guide.enabledRuleCount,
    assignments: (guide) => (guide.isDefault ? 1000 : 0) + guide.projectAssignments.length,
    updated: (guide) => guide.updatedAt ?? '',
  };

/**
 * Order guides for the table.
 *
 * @param guides The guides.
 * @param sort The sorted column and direction, or `null` for the list's own order — which is
 *   the order the API returned, built-in first.
 * @returns A new array; the input is never mutated.
 */
export function sortStyleGuides(
  guides: readonly StyleGuide[],
  sort: { column: string; direction: 'asc' | 'desc' } | null | undefined
): StyleGuide[] {
  const rows = [...guides];
  if (!sort) return rows;
  const value = SORT_VALUES[sort.column as StyleGuideSortColumn];
  if (!value) return rows;
  const sign = sort.direction === 'asc' ? 1 : -1;
  return rows.sort((a, b) => {
    const left = value(a);
    const right = value(b);
    const compared =
      typeof left === 'number' && typeof right === 'number'
        ? left - right
        : String(left).localeCompare(String(right), undefined, { numeric: true });
    // A stable tiebreak on the id, so two guides with the same name or count keep one order
    // rather than swapping places on every re-render.
    return compared !== 0 ? compared * sign : a.id.localeCompare(b.id);
  });
}

// ---------------------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------------------

/**
 * The tone of a guide's icon tile.
 *
 * Not decoration: the tile repeats what the row's badges already say, so a reader scanning
 * the first column can tell the shipped guide from the tenant default from an ordinary custom
 * guide without reading the badges. `honey` is the brand tone the built-in guide takes on
 * every governance surface.
 *
 * @param guide The guide.
 * @returns A tone from the shared status vocabulary.
 */
export function styleGuideTone(guide: StyleGuide): StatusTone {
  if (isBuiltinGuide(guide)) return 'honey';
  if (guide.isDefault) return 'ok';
  if (guide.projectAssignments.length > 0) return 'violet';
  return 'neutral';
}

/**
 * The Rules-on cell: how many of the catalog's rules this guide switches on.
 *
 * @param guide The guide.
 * @returns `"34 / 41"`.
 */
export function guideRuleCountLabel(guide: StyleGuide): string {
  return `${guide.enabledRuleCount} / ${guide.ruleCount}`;
}

/**
 * One guide as the "Copy rules from" picker lists it.
 *
 * @param guide The guide.
 * @returns `"Acme REST (34 rules on)"`.
 */
export function guideSourceOptionLabel(guide: StyleGuide): string {
  return `${guide.name} (${guide.enabledRuleCount} rules on)`;
}

/**
 * The name a duplicate opens with.
 *
 * @param name The source guide's name.
 * @returns `"Acme REST (copy)"`.
 */
export function duplicateGuideName(name: string): string {
  return `${name} (copy)`;
}

/** What a cell shows where a value is missing, in one place so it reads the same everywhere. */
export const NO_VALUE = '—';

/**
 * A timestamp as the Updated column shows it.
 *
 * @param iso An ISO 8601 instant, or nothing.
 * @returns `"Aug 14, 2026"`, or {@link NO_VALUE} when absent or unparsable — never a silent
 *   `Invalid Date`.
 */
export function formatGuideDate(iso: string | null | undefined): string {
  if (!iso) return NO_VALUE;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return NO_VALUE;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * A timestamp as the policy version and waiver lists show it — date and time.
 *
 * @param iso An ISO 8601 instant, or nothing.
 * @returns The formatted instant, {@link NO_VALUE}, or the raw value when it is not a date.
 */
export function formatPolicyInstant(iso: string | null | undefined): string {
  if (!iso) return NO_VALUE;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/**
 * The foot's count.
 *
 * @param count How many guides matched.
 * @returns `"1 guide"` / `"4 guides"`.
 */
export function describeGuideCount(count: number): string {
  return `${count} ${count === 1 ? 'guide' : 'guides'}`;
}

// ---------------------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------------------

/** What deleting one guide would cost. */
export interface StyleGuideDeletionImpact {
  /** Whether the guide is the tenant default. */
  wasDefault: boolean;
  /** The projects pinned to it, which lose their pin. */
  projectNames: string[];
  /**
   * The guide those projects fall back to, when it can be named.
   *
   * `delete_style_guide` promotes the built-in guide back to default in the same transaction
   * when the deleted guide was the default, so this is a fact about the server rather than a
   * guess — but it is only named when the list actually holds a built-in guide.
   */
  fallbackGuideName: string | null;
  /** True when the deletion changes nothing beyond removing the guide. */
  harmless: boolean;
}

/**
 * What would follow from deleting a guide.
 *
 * @param guide The guide about to be deleted.
 * @param guides Every guide, so the fallback can be named rather than assumed.
 * @returns The impact.
 */
export function styleGuideDeletionImpact(
  guide: StyleGuide,
  guides: readonly StyleGuide[]
): StyleGuideDeletionImpact {
  const projectNames = guide.projectAssignments.map((a) => a.projectName);
  const builtin = findBuiltinGuide(guides);
  return {
    wasDefault: guide.isDefault,
    projectNames,
    fallbackGuideName: builtin && builtin.id !== guide.id ? builtin.name : null,
    harmless: !guide.isDefault && projectNames.length === 0,
  };
}

/**
 * The deletion's consequence, in one sentence, or `null` when it has none worth stating.
 *
 * Named rather than generic: "some projects" is exactly the information a reader needs and
 * the mockup's confirm withholds. The sentence only ever mentions what the impact actually
 * found, so it cannot promise a fallback guide that does not exist.
 *
 * @param impact From {@link styleGuideDeletionImpact}.
 * @param guideName The guide's name.
 * @returns The sentence, or `null` when nothing is affected.
 */
export function describeStyleGuideDeletion(
  impact: StyleGuideDeletionImpact,
  guideName: string
): string | null {
  if (impact.harmless) return null;
  const parts: string[] = [];
  if (impact.wasDefault) parts.push('is the tenant default');
  if (impact.projectNames.length === 1) {
    parts.push(`is pinned to ${impact.projectNames[0]}`);
  } else if (impact.projectNames.length > 1) {
    parts.push(`is pinned to ${impact.projectNames.length} projects`);
  }
  const fallback = impact.fallbackGuideName
    ? ` After deletion those specs are scored by ${impact.fallbackGuideName}.`
    : ' After deletion those specs fall back to the tenant default.';
  return `${guideName} ${parts.join(' and ')}.${fallback}`;
}
