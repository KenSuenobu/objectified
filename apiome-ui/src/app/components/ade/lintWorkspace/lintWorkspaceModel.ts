/**
 * The derivations behind the lint posture workspace (HIVE-5.8, #5311).
 *
 * Authority: `docs/mockups/govern/lint-posture.html`, whose **Notes → Keeps (1:1)** list is
 * this ticket's acceptance criteria, and `docs/mockups/DESIGN.md` §3.1 (the status
 * vocabulary), §5.4 (drawer) and §8 (list pattern).
 *
 * Everything here is React-free and unit-tested directly, for the same reason `auditModel`
 * and `styleGuidesModel` are: this is the densest screen in the product — four drill-down
 * tiles, six axis chips, four facet groups, seven table columns, nine bulk verbs, a toast
 * with two shapes and three quality-rank card layouts — and almost every one of those is a
 * *rule* rather than a piece of markup. A rule that lives in JSX can only be tested by
 * rendering the whole page.
 *
 * The wire types, the payload parsers, the URL codec and the bulk-request builders stay in
 * `utils/lint-workspace.ts`, which the workspace shares with its API proxies. What is here
 * is everything that turns those facts into words and tones on a screen.
 */

import {
  LINT_DECISION_STATES,
  LINT_DECISION_STATE_LABEL,
  lintDecisionStateLabel,
} from '@/app/utils/lint-decision-vocabulary';
import {
  GRADE_LETTERS,
  gradeBand,
  statusTone,
  type GradeBand,
  type StatusTone,
} from '@/app/components/ui/statusVocabulary';
import {
  WORKSPACE_AXES,
  WORKSPACE_GRADES,
  WORKSPACE_SEVERITIES,
  WORKSPACE_SORTS,
  activeFilterCount,
  adapterAttributionShare,
  filtersToSearchParams,
  isWaiverExpiringSoon,
  savedViewToFilters,
  type LintWorkspaceBulkResponse,
  type LintWorkspaceFinding,
  type LintWorkspaceSavedView,
  type LintWorkspaceSummary,
  type LintWorkspaceTrends,
  type QualityRankFormat,
  type WorkspaceFilters,
  type WorkspaceSort,
} from '@/app/utils/lint-workspace';

// =========================================================================================
// Vocabularies
// =========================================================================================

/** The em dash the whole app uses where a number does not exist. */
export const NO_VALUE = '—';

/** How many findings one page of the queue holds. The server's own default. */
export const LINT_QUEUE_PAGE_SIZE = 50;

/** Default window for the quality-rank series, in days (the server caps the range at 180). */
export const DEFAULT_QUALITY_RANK_DAYS = 30;

/** The windows the quality-ranks tab offers, in days. Bounded by the server's 180 maximum. */
export const QUALITY_RANK_WINDOWS = [7, 30, 90, 180] as const;

/** One of {@link QUALITY_RANK_WINDOWS}. */
export type QualityRankWindow = (typeof QUALITY_RANK_WINDOWS)[number];

/**
 * The six scoring axes, in the order the summary strip and the facet group list them.
 *
 * The server sends a `label` with each axis of the *summary*; the facet strip has only the
 * key, so the labels live here too and the two agree.
 */
export const AXIS_LABELS: Readonly<Record<string, string>> = {
  quality: 'Quality',
  protocol: 'Protocol',
  security: 'Security',
  supply_chain: 'Supply chain',
  supportability: 'Supportability',
  compatibility: 'Compatibility',
};

/**
 * A scoring axis as a reader sees it.
 *
 * @param key The axis key, as the evidence rows carry it (`supply_chain`).
 * @returns Its label, or the key with underscores opened out when the axis is one this
 *   build has not been taught — an honest rendering rather than a raw enum.
 */
export function axisLabel(key: string): string {
  return AXIS_LABELS[key] ?? key.replace(/_/g, ' ');
}

/** The three lint severities as a reader sees them. */
export const SEVERITY_LABELS: Readonly<Record<string, string>> = {
  error: 'Error',
  warning: 'Warning',
  info: 'Info',
};

/**
 * A finding severity as a reader sees it.
 *
 * @param severity The raw severity, which may be absent on a malformed evidence row.
 * @returns The sentence-case label, or {@link NO_VALUE} when there is no severity at all.
 */
export function severityLabel(severity: string | null | undefined): string {
  if (!severity) return NO_VALUE;
  return SEVERITY_LABELS[severity] ?? severity;
}

/** The four sort orders the queue offers, labelled. */
export const SORT_LABELS: Readonly<Record<WorkspaceSort, string>> = {
  severity: 'Severity',
  newest: 'Newest',
  rule: 'Rule',
  subject: 'Subject',
};

/** The two subject scopes the queue can be narrowed to, plus "all". */
export const SUBJECT_TYPE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: 'All subjects' },
  { value: 'catalog_revision', label: 'Catalog revisions' },
  { value: 'mcp_endpoint_version', label: 'MCP servers' },
];

/** The three coverage choices. */
export const COVERAGE_OPTIONS: ReadonlyArray<{
  value: WorkspaceFilters['coverage'];
  label: string;
}> = [
  { value: '', label: 'Any' },
  { value: 'missing', label: 'Missing required' },
  { value: 'met', label: 'Met' },
];

// =========================================================================================
// The facet strip
// =========================================================================================

/** Which filter dimension a facet group toggles. */
export type FacetGroupKey = 'severity' | 'state' | 'axis' | 'grade';

/** One chip in a facet group. */
export interface FacetChipSpec {
  /** The filter value this chip carries — `'error'`, `'waiver_requested'`, `'A'`. */
  value: string;
  /** What the reader sees. */
  label: string;
  /** How many findings the facet holds in the current read, or `undefined` when unknown. */
  count?: number;
  /** Whether the chip is currently narrowing the queue. */
  active: boolean;
  /** The status tone for the chip's leading dot; `null` for a group that draws none. */
  tone: StatusTone | null;
}

/** One group of the facet strip. */
export interface FacetGroupSpec {
  /** Which filter dimension the group toggles. */
  key: FacetGroupKey;
  /** The caps label above it. */
  label: string;
  /** Its chips, in vocabulary order. */
  chips: FacetChipSpec[];
}

/** Which facet-count bucket in the findings response answers each group. */
const FACET_COUNT_KEY: Readonly<Record<FacetGroupKey, string>> = {
  severity: 'severity',
  state: 'effectiveState',
  axis: 'axis',
  grade: 'grade',
};

/**
 * The four facet groups, with the counts from the current read and the on/off state.
 *
 * Every value of every closed vocabulary is listed whether or not the read found one, which
 * is the difference between "there are no waived findings" and "waived is not a thing" — the
 * chip carries a `0` rather than disappearing, so the strip does not reflow as a reader
 * narrows it.
 *
 * @param filters The current filter state.
 * @param facets The facet counts from the findings response, keyed as the API sends them.
 * @returns The four groups, in the order the mockup draws them.
 */
export function facetGroups(
  filters: WorkspaceFilters,
  facets: Record<string, Record<string, number>>
): FacetGroupSpec[] {
  const chip = (
    group: FacetGroupKey,
    value: string,
    label: string,
    tone: StatusTone | null
  ): FacetChipSpec => ({
    value,
    label,
    count: facets[FACET_COUNT_KEY[group]]?.[value],
    active: filters[group === 'state' ? 'state' : group].includes(value),
    tone,
  });

  return [
    {
      key: 'severity',
      label: 'Severity',
      chips: WORKSPACE_SEVERITIES.map((value) =>
        chip('severity', value, severityLabel(value), statusTone(value))
      ),
    },
    {
      key: 'state',
      label: 'State',
      chips: LINT_DECISION_STATES.map((value) =>
        chip('state', value, LINT_DECISION_STATE_LABEL[value], statusTone(value))
      ),
    },
    {
      key: 'axis',
      label: 'Axis',
      // No dot: an axis is a *place* a finding was raised, not a state, and a second tone
      // axis in the same strip would read as a second severity.
      chips: WORKSPACE_AXES.map((value) => chip('axis', value, axisLabel(value), null)),
    },
    {
      key: 'grade',
      label: 'Grade',
      chips: WORKSPACE_GRADES.map((value) => chip('grade', value, value, null)),
    },
  ];
}

/**
 * Toggle one value of a multi-select filter.
 *
 * @param values The dimension's current values.
 * @param value The value the chip carries.
 * @returns The values with `value` added when it was absent and removed when it was present.
 */
export function toggleFacet(values: readonly string[], value: string): string[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
}

/**
 * The filter state with one facet chip flipped.
 *
 * A named function rather than a computed-key spread at the call site: the four group keys
 * are also four *fields* of {@link WorkspaceFilters}, and a computed key loses that — the
 * result would type-check against a misspelling.
 *
 * @param filters The current filter state.
 * @param group Which group the chip belongs to.
 * @param value The chip's value.
 * @returns The new filter state.
 */
export function withFacetToggled(
  filters: WorkspaceFilters,
  group: FacetGroupKey,
  value: string
): WorkspaceFilters {
  switch (group) {
    case 'severity':
      return { ...filters, severity: toggleFacet(filters.severity, value) };
    case 'state':
      return { ...filters, state: toggleFacet(filters.state, value) };
    case 'axis':
      return { ...filters, axis: toggleFacet(filters.axis, value) };
    case 'grade':
      return { ...filters, grade: toggleFacet(filters.grade, value) };
  }
}

// =========================================================================================
// The posture summary
// =========================================================================================

/** Which canned filter a summary tile jumps the queue to. */
export type PostureDrillTarget = 'security-errors' | 'coverage' | 'new' | 'waiver-requests';

/** The glyph a tile leads with, named rather than imported so this module stays React-free. */
export type PostureTileIcon = 'shield-alert' | 'layers' | 'sparkles' | 'file-check';

/** One of the four drill-down tiles at the top of the workspace. */
export interface PostureTileSpec {
  /** Which filter the tile jumps to; also its `data-testid` suffix. */
  target: PostureDrillTarget;
  /** The tile's glyph. */
  icon: PostureTileIcon;
  /** The label above the figure. */
  label: string;
  /** The figure. */
  value: number;
  /** The quiet unit beside it — `'of 12 subjects'`, `'active'`. */
  unit?: string;
  /** The quiet line under it. */
  footnote: string;
  /** A second footnote pushed to the trailing edge — the "Needs attention" callout. */
  footnoteEnd?: string;
  /** The tone the figure and the trailing footnote take; `null` for the page's own ink. */
  tone: StatusTone | null;
  /** What the tile's tooltip says the click will do. */
  drillHint: string;
}

/**
 * The distinct axes the tenant has subjects missing required coverage on.
 *
 * @param summary The posture summary.
 * @returns The axis labels, in the vocabulary's order, without repeats.
 */
export function missingCoverageAxes(summary: LintWorkspaceSummary): string[] {
  const seen = new Set<string>();
  for (const subject of summary.coverage.subjects) {
    for (const axis of subject.missingAxes) seen.add(axis);
  }
  return WORKSPACE_AXES.filter((axis) => seen.has(axis))
    .map(axisLabel)
    // An axis the server named but this build's vocabulary does not know still has to appear,
    // or the sentence under the figure would contradict the figure itself.
    .concat(
      [...seen]
        .filter((axis) => !(WORKSPACE_AXES as readonly string[]).includes(axis))
        .map(axisLabel)
    );
}

/**
 * The four summary tiles.
 *
 * One measured departure from the mockup: its "New findings" tile carries a `+3` delta since
 * the previous scan. The summary endpoint reports a count, not a change, so no delta is drawn
 * — a trend arrow computed from a number the server never sent would be an invention, and
 * the Trends tab beside it answers the same question from real daily series.
 *
 * @param summary The posture summary.
 * @returns The tiles, in the order the strip draws them.
 */
export function postureTiles(summary: LintWorkspaceSummary): PostureTileSpec[] {
  const securityErrors = summary.findings.unwaived_security_errors ?? 0;
  const missing = summary.coverage.missingCount;
  const subjectTotal = Object.values(summary.subjects).reduce((sum, n) => sum + n, 0);
  const missingAxes = missingCoverageAxes(summary);
  const requested = summary.waivers.requested ?? 0;
  const expiring = summary.waivers.expiring_soon ?? 0;

  return [
    {
      target: 'security-errors',
      icon: 'shield-alert',
      label: 'Unwaived security errors',
      value: securityErrors,
      footnote: 'Open · security axis',
      footnoteEnd: securityErrors > 0 ? 'Needs attention' : undefined,
      tone: securityErrors > 0 ? 'danger' : 'ok',
      drillHint: 'Drill down: severity=error · axis=security · state=open',
    },
    {
      target: 'coverage',
      icon: 'layers',
      label: 'Missing required coverage',
      value: missing,
      unit: subjectTotal > 0 ? `of ${subjectTotal} subjects` : undefined,
      footnote:
        missingAxes.length > 0
          ? `${missingAxes.join(' · ')} not assessed`
          : 'Every required axis is assessed',
      tone: missing > 0 ? 'warn' : 'ok',
      drillHint: 'Drill down: coverage=missing',
    },
    {
      target: 'new',
      icon: 'sparkles',
      label: 'New findings',
      value: summary.findings.new_count ?? 0,
      footnote: 'since the last scan',
      tone: null,
      drillHint: 'Drill down: new only',
    },
    {
      target: 'waiver-requests',
      icon: 'file-check',
      label: 'Waivers',
      value: summary.waivers.active ?? 0,
      unit: 'active',
      footnote: `${requested} requested · ${expiring} expiring soon`,
      tone: null,
      drillHint: 'Drill down: state=waiver_requested',
    },
  ];
}

/**
 * The filter state one summary tile jumps to.
 *
 * A tile replaces the whole filter bundle rather than adding to it: "show me the unwaived
 * security errors" is a question about the workspace, and answering it *within* whatever
 * three chips happened to be on would answer a different one. The project scope survives,
 * because that is the page's scope rather than one of its filters.
 *
 * @param target Which tile was pressed.
 * @param empty The empty filter state to build on (`EMPTY_WORKSPACE_FILTERS`).
 * @param projectId The project scope to preserve.
 * @returns The filter state to put in the URL.
 */
export function drillDownFilters(
  target: PostureDrillTarget,
  empty: WorkspaceFilters,
  projectId: string
): WorkspaceFilters {
  const next: WorkspaceFilters = { ...empty, projectId };
  switch (target) {
    case 'security-errors':
      return { ...next, severity: ['error'], axis: ['security'], state: ['open'] };
    case 'coverage':
      return { ...next, coverage: 'missing' };
    case 'new':
      return { ...next, newOnly: true };
    case 'waiver-requests':
      return { ...next, state: ['waiver_requested'] };
  }
}

/** One chip of the grade distribution strip. */
export interface GradeChipSpec {
  /** The letter, or `'ungraded'`. */
  key: string;
  /** What the reader sees — the letter, or `'Ungraded'`. */
  label: string;
  /** How many subjects hold it. */
  count: number;
  /** How the letter is painted. */
  band: GradeBand;
}

/**
 * The grade distribution as chips.
 *
 * Every band is listed including the empty ones, and `Ungraded` last: a distribution with no
 * `F` is a fact about the catalog worth seeing, and a strip that only shows the letters that
 * occur cannot be compared with the same strip a week later.
 *
 * @param summary The posture summary.
 * @returns A chip per band, A–F then Ungraded.
 */
export function gradeChips(summary: LintWorkspaceSummary): GradeChipSpec[] {
  const chips: GradeChipSpec[] = GRADE_LETTERS.map((letter) => ({
    key: letter,
    label: letter,
    count: summary.gradeDistribution[letter] ?? 0,
    band: gradeBand(letter),
  }));
  chips.push({
    key: 'ungraded',
    label: 'Ungraded',
    count: summary.gradeDistribution.ungraded ?? 0,
    band: gradeBand(null),
  });
  return chips;
}

/** One chip of the axis strip. */
export interface AxisChipSpec {
  /** The axis key. */
  key: string;
  /** `"Security · 72"`, or `"Supply chain · —"` when nothing was assessed. */
  label: string;
  /** Whether any subject was assessed on this axis. */
  assessed: boolean;
  /** The assessed/not-assessed sentence, as the chip's tooltip. */
  title: string;
}

/**
 * The per-axis average scores as chips.
 *
 * A `—` rather than a `0` for an axis nothing was assessed on: the two are the difference
 * between "we do not know" and "we scored zero", and the tooltip says which.
 *
 * @param summary The posture summary.
 * @returns One chip per axis the summary reports, in the server's order.
 */
export function axisChips(summary: LintWorkspaceSummary): AxisChipSpec[] {
  return summary.axes.map((axis) => {
    const label = axis.label || axisLabel(axis.key);
    return {
      key: axis.key,
      label: `${label} · ${axis.averageScore ?? NO_VALUE}`,
      assessed: axis.assessedCount > 0,
      title:
        axis.assessedCount > 0
          ? `${label}: ${axis.assessedCount} assessed, ${axis.notAssessedCount} not assessed`
          : `${label}: not assessed anywhere`,
    };
  });
}

// =========================================================================================
// Saved views
// =========================================================================================

/**
 * Whether a saved view describes exactly what is on screen.
 *
 * Compared as the URL codec serialises them rather than field by field, so the answer cannot
 * disagree with the address bar — which is the thing the view actually saved. Multi-value
 * facets are order-insensitive because `severity=error,warning` and `severity=warning,error`
 * are the same query.
 *
 * @param view The saved view.
 * @param filters The filter state on screen.
 * @param sort The sort on screen.
 * @returns True when applying the view would change nothing.
 */
export function savedViewMatches(
  view: LintWorkspaceSavedView,
  filters: WorkspaceFilters,
  sort: string
): boolean {
  if ((view.sort || 'severity') !== (sort || 'severity')) return false;
  return canonicalFilterKey(savedViewToFilters(view)) === canonicalFilterKey(filters);
}

/**
 * A filter bundle as one comparable string.
 *
 * @param filters The filter state.
 * @returns Its query parameters, each multi-value facet sorted, joined in key order.
 */
export function canonicalFilterKey(filters: WorkspaceFilters): string {
  const params = filtersToSearchParams(filters);
  return [...params.entries()]
    .map(([key, value]) => `${key}=${value.split(',').sort().join(',')}`)
    .sort()
    .join('&');
}

/**
 * The address the current view is shareable at, for the mono line under the toolbar.
 *
 * @param pathname The route.
 * @param filters The filter state.
 * @param sort The sort.
 * @param offset The paging offset.
 * @returns The path, and the query string that reproduces this exact screen.
 */
export function shareableUrl(
  pathname: string,
  filters: WorkspaceFilters,
  sort: string,
  offset: number
): { path: string; query: string } {
  const params = filtersToSearchParams(filters, {
    sort: sort || 'severity',
    offset,
  });
  const query = params.toString();
  return { path: pathname, query: query ? `?${query}` : '' };
}

// =========================================================================================
// The findings queue
// =========================================================================================

/**
 * The evidence location as one line.
 *
 * @param finding The finding.
 * @returns `"path: …, line: 412"` — every key the scanner recorded, in its own order — or
 *   {@link NO_VALUE} when it recorded none.
 */
export function findingLocationLine(finding: LintWorkspaceFinding): string {
  const parts = Object.entries(finding.location).map(([key, value]) => `${key}: ${String(value)}`);
  return parts.length > 0 ? parts.join(', ') : NO_VALUE;
}

/**
 * The document path a finding points at, for the queue row's third line.
 *
 * @param finding The finding.
 * @returns The `path` the scanner recorded, or `null` when it recorded none.
 */
export function findingPath(finding: LintWorkspaceFinding): string | null {
  return typeof finding.location.path === 'string' ? finding.location.path : null;
}

/**
 * The remediation hint a scanner attached, if any.
 *
 * @param finding The finding.
 * @returns The `fix` or the `summary` the scanner recorded, or `null`.
 */
export function findingRemediation(finding: LintWorkspaceFinding): string | null {
  const remediation = finding.remediation;
  if (!remediation) return null;
  if (typeof remediation.fix === 'string' && remediation.fix) return remediation.fix;
  if (typeof remediation.summary === 'string' && remediation.summary) return remediation.summary;
  return null;
}

/**
 * Where the subject of a finding lives.
 *
 * @param finding The finding.
 * @returns The route showing the revision or the MCP server the finding was raised on, or
 *   `null` when the evidence names neither.
 */
export function findingSubjectHref(finding: LintWorkspaceFinding): string | null {
  if (finding.versionRecordId) {
    const project = finding.projectId ? encodeURIComponent(finding.projectId) : '';
    return `/ade/dashboard/versions${project ? `?projectId=${project}` : ''}`;
  }
  if (finding.mcpVersionId) return '/ade/dashboard/mcp';
  return null;
}

/**
 * The subject as one line — what the finding was raised *on*.
 *
 * @param finding The finding.
 * @returns The project name, or the subject label when there is no project, or
 *   {@link NO_VALUE}.
 */
export function findingSubjectName(finding: LintWorkspaceFinding): string {
  return finding.projectName ?? finding.subjectLabel ?? NO_VALUE;
}

/**
 * The policy verdict, said in words rather than as a boolean.
 *
 * @param finding The finding.
 * @returns The verdict, the status string that paints it, and the evaluation id when the
 *   server recorded one.
 */
export function findingPolicyVerdict(finding: LintWorkspaceFinding): {
  label: string;
  status: string;
  evaluationId: string | null;
} {
  if (finding.policyPassed === null) {
    return { label: 'Not evaluated', status: 'unknown', evaluationId: finding.latestPolicyEvaluationId };
  }
  return {
    label: finding.policyPassed ? 'Passed' : 'Failed',
    status: finding.policyPassed ? 'passed' : 'failed',
    evaluationId: finding.latestPolicyEvaluationId,
  };
}

/**
 * Whether this finding's waiver is close enough to expiry to say so.
 *
 * @param finding The finding.
 * @param now The instant to measure from — the page's, so every row agrees.
 * @returns True for a granted waiver expiring inside the "expiring soon" window.
 */
export function findingWaiverExpiringSoon(
  finding: LintWorkspaceFinding,
  now: Date = new Date()
): boolean {
  return finding.waived && isWaiverExpiringSoon(finding.decision?.expiresAt, now);
}

/**
 * The count sentence under the queue.
 *
 * Stated as an offset window rather than as a page number, because the workspace's paging is
 * an offset in the URL and the sentence has to agree with the address bar.
 *
 * @param offset The current offset.
 * @param limit The page size.
 * @param total How many findings matched.
 * @returns `"1–50 of 213 findings · page size 50"`, or `"No findings"` when nothing matched.
 */
export function queueRangeLabel(offset: number, limit: number, total: number): string {
  if (total <= 0) return 'No findings';
  const first = Math.min(offset + 1, total);
  const last = Math.min(offset + limit, total);
  return `${first}–${last} of ${total} finding${total === 1 ? '' : 's'} · page size ${limit}`;
}

/**
 * The 1-based page an offset lands on.
 *
 * @param offset The offset.
 * @param limit The page size.
 * @returns The page number, never below 1.
 */
export function queuePageNumber(offset: number, limit: number): number {
  if (limit <= 0) return 1;
  return Math.max(1, Math.floor(offset / limit) + 1);
}

/**
 * How many pages a total covers.
 *
 * @param total How many findings matched.
 * @param limit The page size.
 * @returns The page count, never below 1 — a list with nothing in it is still one page.
 */
export function queuePageCount(total: number, limit: number): number {
  if (limit <= 0) return 1;
  return Math.max(1, Math.ceil(total / limit));
}

/**
 * The offset a 1-based page starts at.
 *
 * @param page The page number.
 * @param limit The page size.
 * @returns The offset, never negative.
 */
export function queueOffsetForPage(page: number, limit: number): number {
  return Math.max(0, (Math.max(1, page) - 1) * limit);
}

/**
 * How many filter dimensions are narrowing the queue, for the "Clear filters (n)" button.
 *
 * The project scope is not one of them: it is the page's scope, it survives every clear, and
 * counting it would offer to remove something the button does not remove.
 *
 * @param filters The filter state.
 * @returns The count, excluding the project scope.
 */
export function clearableFilterCount(filters: WorkspaceFilters): number {
  return activeFilterCount(filters) - (filters.projectId.trim() ? 1 : 0);
}

// =========================================================================================
// Bulk decisions
// =========================================================================================

/** The verbs the bulk bar offers, in the order the mockup lists them. */
export type BulkVerb =
  | 'acknowledged'
  | 'fixed'
  | 'false_positive'
  | 'waiver_requested'
  | 'waived'
  | 'open';

/** One verb of the bulk bar. */
export interface BulkVerbSpec {
  /** The state the verb moves the selection to. */
  state: BulkVerb;
  /** The button's text. */
  label: string;
  /** The button's `title`, where one is needed — the permission or the consequence. */
  title?: string;
  /** True when the verb opens the waiver dialog rather than writing straight away. */
  opensWaiverDialog?: boolean;
  /** The dialog mode it opens in. */
  waiverMode?: WaiverDialogMode;
}

/** Which shape the waiver dialog takes. */
export type WaiverDialogMode = 'request' | 'approve';

/**
 * The bulk verbs.
 *
 * Every one is offered to everyone. The server is the authority on who may approve a waiver,
 * and it answers per item — so hiding the verb from someone whose role the client has not
 * read would be a guess, while offering it and reporting the refusal in the toast is the
 * truth. The two that need a permission say so in their `title`.
 */
export const BULK_VERBS: readonly BulkVerbSpec[] = [
  { state: 'acknowledged', label: 'Acknowledge' },
  { state: 'fixed', label: 'Mark fixed' },
  { state: 'false_positive', label: 'False positive' },
  {
    state: 'waiver_requested',
    label: 'Request waiver',
    opensWaiverDialog: true,
    waiverMode: 'request',
  },
  {
    state: 'waived',
    label: 'Approve waiver',
    title: 'Requires waiver approval permission (lint_findings:publish)',
    opensWaiverDialog: true,
    waiverMode: 'approve',
  },
  {
    state: 'open',
    label: 'Reopen / reject',
    title: 'Reopen — also rejects requested waivers (requires approval permission)',
  },
] as const;

/** What a completed bulk write should say, and whether it may be undone. */
export interface BulkToast {
  /** `success` for a clean write, `warning` when the server refused some of it. */
  tone: 'success' | 'warning';
  /** The toast's heading. */
  title: string;
  /** The line under it — what was applied, or which item failed and why. */
  description: string;
  /** Whether to offer Undo. */
  undoable: boolean;
}

/**
 * What to say after a bulk decision.
 *
 * Two shapes, because the server applies each item independently and can refuse some of them:
 * a clean write offers Undo, and a partial one leads with the split and names the first
 * error, because "3 of 5 were applied" without saying *why* leaves the reader with nothing
 * to do next. A partial write is still reversible — `undoable` reports whether anything
 * actually changed, which is what the undo requests are built from.
 *
 * @param response The bulk response.
 * @param verbLabel What the reader pressed — `'Acknowledge'`, `'Assign'`.
 * @param undoCount How many inverse requests were built from the response.
 * @returns The toast's tone and copy.
 */
export function bulkToast(
  response: LintWorkspaceBulkResponse,
  verbLabel: string,
  undoCount: number
): BulkToast {
  const applied = response.appliedCount;
  const noun = `finding${applied === 1 ? '' : 's'}`;
  if (response.failedCount > 0) {
    const firstError = response.results.find((result) => !result.ok)?.error;
    return {
      tone: 'warning',
      title: `Applied to ${applied} of ${applied + response.failedCount} findings`,
      description: firstError
        ? `${response.failedCount} refused — ${firstError}`
        : `${response.failedCount} refused.`,
      undoable: undoCount > 0,
    };
  }
  return {
    tone: 'success',
    title: `Applied to ${applied} ${noun}`,
    description: `${verbLabel} · replays the previous states if you undo.`,
    undoable: undoCount > 0,
  };
}

/**
 * The waiver dialog's copy for the mode it is open in.
 *
 * @param mode Which shape the dialog is in.
 * @param count How many findings are selected.
 * @returns Its title, its sub-line, its primary button and whether an expiry is required.
 */
export function waiverDialogCopy(
  mode: WaiverDialogMode,
  count: number
): { title: string; description: string; submitLabel: string; expiryRequired: boolean } {
  const findings = `${count} finding${count === 1 ? '' : 's'}`;
  if (mode === 'approve') {
    return {
      title: `Approve waiver for ${findings}`,
      description:
        'Accepted risk with a deadline. The expiry is required, and needs the lint_findings:publish permission.',
      submitLabel: 'Approve waiver',
      expiryRequired: true,
    };
  }
  return {
    title: `Request waiver for ${findings}`,
    description:
      'Accepted risk with a deadline. Approvers see the rationale and can set the expiry when they approve.',
    submitLabel: 'Request waiver',
    expiryRequired: false,
  };
}

// =========================================================================================
// The finding drawer's remediation history
// =========================================================================================

/** One entry of a decision's append-only audit trail. */
export interface DecisionEvent {
  /** The event's id. */
  id: string;
  /** The state before, or `null` for the row that recorded the finding. */
  beforeState: string | null;
  /** The state after. */
  afterState: string;
  /** Why, when the actor gave a reason. */
  rationale: string | null;
  /** Who, when the server resolved a name. */
  actorLabel: string | null;
  /** When. */
  createdAt: string | null;
}

/**
 * Coerce the decision-events payload.
 *
 * @param value The `events` array from `GET /api/lint/decisions/{id}/events`.
 * @returns The events, malformed rows degraded rather than dropped — an event with no
 *   `afterState` still records that *something* happened.
 */
export function decisionEventsFromPayload(value: unknown): DecisionEvent[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const event = (entry ?? {}) as Record<string, unknown>;
    return {
      id: String(event.id ?? ''),
      beforeState: typeof event.beforeState === 'string' ? event.beforeState : null,
      afterState: typeof event.afterState === 'string' ? event.afterState : 'open',
      rationale: typeof event.rationale === 'string' ? event.rationale : null,
      actorLabel: typeof event.actorLabel === 'string' ? event.actorLabel : null,
      createdAt: typeof event.createdAt === 'string' ? event.createdAt : null,
    };
  });
}

/**
 * One history entry as its two lines.
 *
 * @param event The event.
 * @returns The transition (`"Open → Waiver requested"`, or the recorded-from-evidence line),
 *   the rationale in quotes when there is one, and the by/when line.
 */
export function decisionEventLines(event: DecisionEvent): {
  transition: string;
  rationale: string | null;
  meta: string;
} {
  const after = lintDecisionStateLabel(event.afterState);
  const before = event.beforeState ? lintDecisionStateLabel(event.beforeState) : null;
  const meta = [event.actorLabel ? `by ${event.actorLabel}` : null, event.createdAt]
    .filter(Boolean)
    .join(' · ');
  return {
    transition: before ? `${before} → ${after}` : 'Recorded from evidence',
    rationale: event.rationale ? `“${event.rationale}”` : null,
    meta,
  };
}

/** The tone a history entry's marker takes — the state it moved *to*. */
export function decisionEventTone(event: DecisionEvent): StatusTone {
  return statusTone(event.afterState);
}

// =========================================================================================
// Trends
// =========================================================================================

/** Which half of the Trends tab a series belongs to. */
export type TrendGroup = 'remediation' | 'policy';

/** One daily series of the Trends tab. */
export interface TrendSeriesSpec {
  /** The field of a trend point this series reads. */
  key: Exclude<keyof LintWorkspaceTrends['series'][number], 'date'>;
  /** Which card it is drawn on. */
  group: TrendGroup;
  /** What the reader sees. */
  label: string;
  /** The tone its line takes. */
  tone: 'danger' | 'ok' | 'warn' | 'accent' | 'violet';
}

/**
 * The six daily series, split the way the ticket requires.
 *
 * Remediation and policy are never summed into one line: that separation is what lets a team
 * prove a posture improvement came from fixing things rather than from loosening the rules.
 */
export const TREND_SERIES: readonly TrendSeriesSpec[] = [
  { key: 'newFindings', group: 'remediation', label: 'New findings', tone: 'danger' },
  {
    key: 'remediatedFindings',
    group: 'remediation',
    label: 'Remediated (genuine fixes)',
    tone: 'ok',
  },
  { key: 'waiversGranted', group: 'policy', label: 'Waivers granted', tone: 'warn' },
  { key: 'waiversExpired', group: 'policy', label: 'Waivers expired', tone: 'accent' },
  { key: 'markedFalsePositive', group: 'policy', label: 'Marked false positive', tone: 'violet' },
  {
    key: 'policyPackPublications',
    group: 'policy',
    label: 'Policy pack publications',
    tone: 'accent',
  },
] as const;

/**
 * One series' daily values and its total.
 *
 * @param trends The trends payload.
 * @param spec Which series.
 * @returns The values oldest-first, the total over the window, and the window in days.
 */
export function trendSeriesData(
  trends: LintWorkspaceTrends,
  spec: TrendSeriesSpec
): { values: number[]; total: number; days: number } {
  const values = trends.series.map((point) => point[spec.key]);
  return {
    values,
    total: values.reduce((sum, value) => sum + value, 0),
    days: trends.days,
  };
}

// =========================================================================================
// Quality ranks
// =========================================================================================

/** The grade buckets a rank card's histogram draws, in order. */
export const RANK_GRADE_BUCKETS = ['A', 'B', 'C', 'D', 'F', 'ungraded'] as const;

/** One bar of a rank card's grade histogram. */
export interface GradeBarSpec {
  /** The bucket. */
  key: string;
  /** Its axis label — the letter, or an em dash for the ungraded bucket. */
  label: string;
  /** How many grades landed in it. */
  count: number;
  /** Its height as a percentage of the tallest bar, 0–100. */
  percent: number;
  /** How the bucket is painted. */
  band: GradeBand;
}

/**
 * A rank card's grade histogram.
 *
 * Heights are relative to the *tallest* bucket rather than to the total, because the shape a
 * reader takes from six bars is "which grade dominates", and a distribution scaled to the
 * total flattens into nothing as soon as one bucket holds most of it. An all-empty
 * distribution draws six zero-height bars rather than dividing by nothing.
 *
 * @param distribution The card's `gradeDistribution`.
 * @returns One bar per bucket, A–F then ungraded.
 */
export function gradeBars(distribution: Record<string, number>): GradeBarSpec[] {
  const counts = RANK_GRADE_BUCKETS.map((key) => distribution[key] ?? 0);
  const tallest = Math.max(...counts, 0);
  return RANK_GRADE_BUCKETS.map((key, index) => ({
    key,
    label: key === 'ungraded' ? NO_VALUE : key,
    count: counts[index],
    percent: tallest > 0 ? Math.round((counts[index] / tallest) * 100) : 0,
    band: key === 'ungraded' ? gradeBand(null) : gradeBand(key),
  }));
}

/** A scope discriminator as a reader sees it. */
export function scopeLabel(scope: string): string {
  if (scope === 'import') return 'Import';
  if (scope === 'export') return 'Export';
  return scope || 'Unknown';
}

/** Which way a rank card's score moved over the window, and how to say it. */
export interface DriftSpec {
  /** `up`, `down` or `flat`; `none` when there were too few scored runs to compare. */
  direction: 'up' | 'down' | 'flat' | 'none';
  /** What the badge says. */
  label: string;
  /** The tone it takes. */
  tone: StatusTone;
}

/**
 * A rank card's grade drift.
 *
 * `null` is not zero: a format scored once cannot have drifted, and reporting that as "no
 * change" would claim a stability that was never measured.
 *
 * @param delta The window's score delta, or `null`.
 * @returns The direction, the sentence and the tone.
 */
export function driftSpec(delta: number | null): DriftSpec {
  if (delta === null) {
    return {
      direction: 'none',
      label: 'No drift (one scored run or fewer)',
      tone: 'outline',
    };
  }
  if (delta > 0) return { direction: 'up', label: `+${delta} pts over the window`, tone: 'ok' };
  if (delta < 0) return { direction: 'down', label: `${delta} pts over the window`, tone: 'danger' };
  return { direction: 'flat', label: 'No change over the window', tone: 'neutral' };
}

/** The adapter-versus-specification split of a rank card's findings. */
export interface AttributionSpec {
  /** The adapter's share, 0–100, or `null` when the format produced no findings. */
  adapterPercent: number | null;
  /** The specification's share, 0–100, or `null`. */
  specPercent: number | null;
  /** The trailing summary — `"38% adapter · 62% specification"`. */
  summary: string;
  /** The sentence under the bar, which names the counts and the declared parser limits. */
  detail: string;
}

/**
 * The adapter-versus-specification attribution of one rank card.
 *
 * The number the card leads with: a format grading low with a high adapter share is a gap in
 * apiome's own intake rather than a bad specification, and the two call for entirely
 * different work.
 *
 * @param entry The rank card's data.
 * @returns The two shares and the two sentences.
 */
export function attributionSpec(entry: QualityRankFormat): AttributionSpec {
  const share = adapterAttributionShare(entry);
  const limits = entry.declaredParserLimits;
  const detail =
    `${entry.adapterFindingCount} adapter-attributable · ` +
    `${entry.specFindingCount} specification-attributable` +
    (limits > 0
      ? ` · ${limits} construct${limits === 1 ? '' : 's'} this adapter declares it cannot read yet`
      : '');
  if (share === null) {
    return { adapterPercent: null, specPercent: null, summary: 'No findings recorded', detail };
  }
  return {
    adapterPercent: share,
    specPercent: 100 - share,
    summary: `${share}% adapter · ${100 - share}% specification`,
    detail,
  };
}

/** The three headline figures a rank card shows, which differ by scope. */
export interface RankStatSpec {
  /** The `data-testid` suffix, stable across scopes so a test can name the slot. */
  slot: 'primary' | 'secondary' | 'tertiary';
  /** The figure's label. */
  label: string;
  /** The figure, or `null` for one that was never measured. */
  value: number | null;
}

/**
 * A rank card's three figures.
 *
 * An export additionally trends its readiness composite and reports the best rank it reached;
 * an import reports how many runs were blocked and how many warned, because those are the
 * outcomes an import has.
 *
 * @param entry The rank card's data.
 * @returns The three figures, in the order the card draws them.
 */
export function rankStats(entry: QualityRankFormat): RankStatSpec[] {
  const isExport = entry.scope === 'export';
  return [
    { slot: 'primary', label: 'Average score', value: entry.averageScore },
    isExport
      ? { slot: 'secondary', label: 'Average readiness', value: entry.averageReadiness }
      : { slot: 'secondary', label: 'Blocked', value: entry.blockedCount },
    isExport
      ? { slot: 'tertiary', label: 'Best rank', value: entry.bestRank }
      : { slot: 'tertiary', label: 'Warned', value: entry.outcomes.warn ?? 0 },
  ];
}

/**
 * The sentence over the quality-ranks tab.
 *
 * @param series The rank series.
 * @returns How many grades were recorded, between which dates, and the pre-flight/committed
 *   split.
 */
export function rankWindowSummary(series: {
  observationCount: number;
  windowStart: string;
  windowEnd: string;
  stages: Record<string, number>;
}): string {
  const grades = `${series.observationCount} grade${series.observationCount === 1 ? '' : 's'}`;
  return (
    `${grades} recorded between ${series.windowStart} and ${series.windowEnd} · ` +
    `${series.stages.preflight ?? 0} pre-flight · ${series.stages.committed ?? 0} committed`
  );
}

/** The four sort orders, as options for the queue's sort control. */
export const SORT_OPTIONS: ReadonlyArray<{ value: WorkspaceSort; label: string }> =
  WORKSPACE_SORTS.map((value) => ({ value, label: SORT_LABELS[value] }));
