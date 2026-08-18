/**
 * The style-guide detail derivations — HIVE-5.7 (#5310).
 *
 * Authority: `docs/mockups/govern/style-guide-detail.html`, whose **Notes → Keeps (1:1)**
 * list is this ticket's acceptance criteria.
 *
 * Everything here is pure: it takes rules and drafts and returns rules, counts, groups and
 * sentences, and touches neither React nor `fetch`. That is what lets
 * `tests/guide-detail-model.test.ts` pin the parts of this screen that are *claims* — which
 * rules a filter leaves, which of them count as modified, what the save bar says — without
 * rendering an editor.
 *
 * The one derivation that is not here is the mapping from a dry run to editor markers: it
 * lives beside the YAML pointer arithmetic it depends on, in
 * `src/app/ade/dashboard/style-guides/customRuleYamlMarkers.ts`.
 */

import type { GuideRule, RuleSeverity } from '@/app/ade/dashboard/style-guides/api';

export type { GuideRule, RuleSeverity };

// ---------------------------------------------------------------------------------------
// The editable half of a rule
// ---------------------------------------------------------------------------------------

/**
 * What the catalog lets a reader change about one rule.
 *
 * The registry facts — the rationale, the category, the *default* severity — are not here,
 * because a guide cannot change them. This is the pair the PUT sends back.
 */
export interface RuleState {
  /** Whether the guide applies this rule at all. */
  enabled: boolean;
  /** How badly a violation scores, when it is applied. */
  severity: RuleSeverity;
}

/** A rule id → its editable state. Both the draft and the saved baseline take this shape. */
export type RuleStateMap = Readonly<Record<string, RuleState>>;

/** The severities a rule can be given, in the order the mockup's select lists them. */
export const SEVERITY_OPTIONS: ReadonlyArray<{ value: RuleSeverity; label: string }> = [
  { value: 'error', label: 'Error' },
  { value: 'warning', label: 'Warning' },
  { value: 'info', label: 'Info' },
];

/**
 * The editable state of every rule in a payload.
 *
 * @param rules The catalog as the server merged it — registry facts plus guide state.
 * @returns The map the save bar diffs and the PUT is built from.
 */
export function toRuleStateMap(rules: readonly GuideRule[]): Record<string, RuleState> {
  const map: Record<string, RuleState> = {};
  for (const rule of rules) {
    map[rule.ruleId] = { enabled: rule.enabled, severity: rule.severity };
  }
  return map;
}

/**
 * Whether one rule's draft differs from what is saved.
 *
 * A rule the baseline has never heard of counts as modified: that is a rule the catalog
 * gained since the page loaded, and treating it as unchanged would let a save write a
 * value the reader never saw.
 *
 * @param ruleId The rule.
 * @param draft What the reader has now.
 * @param baseline What was last saved.
 * @returns True when the two disagree.
 */
export function isRuleModified(
  ruleId: string,
  draft: RuleStateMap,
  baseline: RuleStateMap
): boolean {
  const next = draft[ruleId];
  if (!next) return false;
  const saved = baseline[ruleId];
  if (!saved) return true;
  return next.enabled !== saved.enabled || next.severity !== saved.severity;
}

/**
 * Every rule id whose draft differs from the baseline.
 *
 * @param draft What the reader has now.
 * @param baseline What was last saved.
 * @returns The ids, in the draft's own key order.
 */
export function modifiedRuleIds(draft: RuleStateMap, baseline: RuleStateMap): string[] {
  return Object.keys(draft).filter((ruleId) => isRuleModified(ruleId, draft, baseline));
}

/**
 * How many rules the draft has switched on.
 *
 * The header's "{n} of {total} rules enabled" pill is *live* — it counts the draft, not the
 * server's `enabledCount` — because a reader toggling rules is asking exactly this question
 * and should not have to save to see the answer.
 *
 * @param draft The draft state.
 * @returns The count.
 */
export function enabledRuleCount(draft: RuleStateMap): number {
  return Object.values(draft).filter((state) => state.enabled).length;
}

// ---------------------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------------------

/** The value the category select carries for "no category filter". */
export const ALL_CATEGORIES = 'all';

/** What the toolbar is narrowing the catalog by. */
export interface RuleFilter {
  /** Free text, matched against rule id, rationale and category. */
  search: string;
  /** One category, or {@link ALL_CATEGORIES}. */
  category: string;
  /** Show only rules whose draft differs from the baseline. */
  modifiedOnly: boolean;
}

/** No filter at all — the state the catalog opens in. */
export const EMPTY_RULE_FILTER: RuleFilter = {
  search: '',
  category: ALL_CATEGORIES,
  modifiedOnly: false,
};

/**
 * Every category the catalog holds, sorted.
 *
 * @param rules The catalog.
 * @returns The category names, each once.
 */
export function ruleCategories(rules: readonly GuideRule[]): string[] {
  return Array.from(new Set(rules.map((rule) => rule.category))).sort((a, b) =>
    a.localeCompare(b)
  );
}

/**
 * The rules a filter leaves.
 *
 * The three clauses are independent and all must hold, which is what makes the toolbar
 * predictable: narrowing by category never widens the search, and the "Modified only" chip
 * narrows whatever the other two left rather than replacing them.
 *
 * @param rules The catalog.
 * @param filter What the toolbar is asking for.
 * @param draft The draft state, for the modified clause.
 * @param baseline The saved state, for the modified clause.
 * @returns The matching rules, in the catalog's own order.
 */
export function filterRules(
  rules: readonly GuideRule[],
  filter: RuleFilter,
  draft: RuleStateMap,
  baseline: RuleStateMap
): GuideRule[] {
  const term = filter.search.trim().toLowerCase();
  return rules.filter((rule) => {
    if (filter.category !== ALL_CATEGORIES && rule.category !== filter.category) return false;
    if (filter.modifiedOnly && !isRuleModified(rule.ruleId, draft, baseline)) return false;
    if (!term) return true;
    return (
      rule.ruleId.toLowerCase().includes(term) ||
      rule.rationale.toLowerCase().includes(term) ||
      rule.category.toLowerCase().includes(term)
    );
  });
}

// ---------------------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------------------

/** One category's section of the catalog. */
export interface RuleGroup {
  /** The category name, as the registry spells it. */
  category: string;
  /** Its rules, in the order the catalog gave them. */
  rules: GuideRule[];
  /** How many of them the draft has switched on — the "{on} of {total} on" count. */
  enabled: number;
}

/**
 * Group rules by category, for the mockup's `.rule-group` sections.
 *
 * Categories come out sorted so the sections do not reorder as a search narrows them —
 * a list whose headings move while you type is a list you cannot scan.
 *
 * @param rules The rules to group, already filtered.
 * @param draft The draft state, for each section's enabled count.
 * @returns One group per category present, sorted by name.
 */
export function groupRulesByCategory(
  rules: readonly GuideRule[],
  draft: RuleStateMap
): RuleGroup[] {
  const groups = new Map<string, GuideRule[]>();
  for (const rule of rules) {
    const list = groups.get(rule.category) ?? [];
    list.push(rule);
    groups.set(rule.category, list);
  }
  return Array.from(groups.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, list]) => ({
      category,
      rules: list,
      enabled: list.filter((rule) => draft[rule.ruleId]?.enabled).length,
    }));
}

// ---------------------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------------------

/**
 * What the catalog's save bar says.
 *
 * @param count How many rules differ from the baseline.
 * @returns The sentence, pluralised.
 */
export function unsavedRulesSentence(count: number): string {
  return `${count} unsaved rule change${count === 1 ? '' : 's'}`;
}

/**
 * What the discard dialog says is at stake.
 *
 * One sentence covering both drafts, because the dialog is raised by leaving the *page* and
 * a reader with edits on two tabs is about to lose both. The catalog's count is exact; the
 * custom-rules draft is one document, so it is named rather than counted.
 *
 * @param ruleChanges How many catalog rules differ from the baseline.
 * @param customRulesDirty Whether the custom-rules YAML differs from the baseline.
 * @returns The sentence, or `null` when nothing is unsaved.
 */
export function discardWarningSentence(
  ruleChanges: number,
  customRulesDirty: boolean
): string | null {
  const parts: string[] = [];
  if (ruleChanges > 0) {
    parts.push(`${ruleChanges} rule change${ruleChanges === 1 ? '' : 's'}`);
  }
  if (customRulesDirty) parts.push('edits to the custom rules');
  if (parts.length === 0) return null;
  return `You have unsaved ${parts.join(' and ')}. Leaving this page discards them.`;
}

/**
 * The footer's "Showing 16 of 41 rules · 5 categories" line.
 *
 * @param shown How many rules the filter left.
 * @param total How many the catalog holds.
 * @param categories How many categories the shown rules span.
 * @returns The sentence.
 */
export function catalogFootSentence(
  shown: number,
  total: number,
  categories: number
): string {
  return (
    `Showing ${shown} of ${total} rule${total === 1 ? '' : 's'} · ` +
    `${categories} categor${categories === 1 ? 'y' : 'ies'}`
  );
}

// ---------------------------------------------------------------------------------------
// Who may edit
// ---------------------------------------------------------------------------------------

/** Why a viewer cannot change this guide, when they cannot. */
export type GuideReadOnlyReason = 'builtin' | 'member' | null;

/**
 * Whether this guide is read-only for this viewer, and why.
 *
 * The two reasons are different facts and the copy differs, so this returns which one
 * rather than a boolean. `style_guide_routes.py` refuses both writes with a 409 and a 403
 * respectively, so the UI is describing the server's rule rather than inventing one.
 *
 * @param source The guide's `source` — `builtin` is the shipped, read-only guide.
 * @param isAdmin Whether the viewer administers the tenant.
 * @returns The reason, or `null` when the viewer may edit.
 */
export function guideReadOnlyReason(
  source: 'builtin' | 'custom' | undefined,
  isAdmin: boolean
): GuideReadOnlyReason {
  if (source === 'builtin') return 'builtin';
  if (!isAdmin) return 'member';
  return null;
}
