/**
 * Pure logic for the catalog-wide lint posture & remediation workspace (CLX-4.1, #4859).
 *
 * Everything here is presentational-free and unit-testable: defensive payload parsers for the
 * three workspace endpoints, the URL <-> filter-state round-trip (also the saved-view `filters`
 * blob shape), bulk-request/undo builders, and the client mirror of the waiver state machine
 * (the server re-enforces every rule; the client copy only drives which actions render enabled).
 */

import { LINT_DECISION_STATES, type LintDecisionState } from './lint-decision-vocabulary';

// --- Vocabularies --------------------------------------------------------------------------------

export const WORKSPACE_SEVERITIES = ['error', 'warning', 'info'] as const;
export const WORKSPACE_SORTS = ['severity', 'newest', 'rule', 'subject'] as const;
export const WORKSPACE_AXES = [
  'quality',
  'protocol',
  'security',
  'supply_chain',
  'supportability',
  'compatibility',
] as const;
export const WORKSPACE_GRADES = ['A', 'B', 'C', 'D', 'F'] as const;
/**
 * The decision states the queue can be filtered by — the whole vocabulary, in its own order.
 *
 * An alias rather than a second list: the states, their order and their labels are one fact,
 * and `lint-decision-vocabulary.ts` is where it is stated (HIVE-5.8, #5311).
 */
export const WORKSPACE_STATES: readonly LintDecisionState[] = LINT_DECISION_STATES;

export type WorkspaceSort = (typeof WORKSPACE_SORTS)[number];

/** Days before expiry a waiver renders as "expiring soon" (mirrors the API summary). */
export const WAIVER_EXPIRING_SOON_DAYS = 14;

// --- Wire types ------------------------------------------------------------------------------------

export interface LintWorkspaceDecision {
  id: string;
  projectId?: string | null;
  state: string;
  ownerUserId?: string | null;
  rationale?: string | null;
  linkedTicket?: string | null;
  expiresAt?: string | null;
}

export interface LintWorkspaceFinding {
  sourceFingerprint: string | null;
  ruleId: string | null;
  message: string | null;
  severity: string | null;
  confidence: string | null;
  category: string | null;
  axisKey: string;
  location: Record<string, unknown>;
  remediation: Record<string, unknown> | null;
  scannerId: string;
  profile: string | null;
  subjectType: string;
  versionRecordId: string | null;
  mcpVersionId: string | null;
  projectId: string | null;
  projectName: string | null;
  subjectLabel: string | null;
  compositeGrade: string | null;
  requiredCoverageMet: boolean | null;
  evidenceRunId: string | null;
  evidenceCreatedAt: string | null;
  isNew: boolean;
  effectiveState: string;
  waived: boolean;
  decision: LintWorkspaceDecision | null;
  latestPolicyEvaluationId: string | null;
  policyPassed: boolean | null;
}

export interface LintWorkspaceFindingsPage {
  findings: LintWorkspaceFinding[];
  count: number;
  total: number;
  limit: number;
  offset: number;
  facets: Record<string, Record<string, number>>;
}

export interface LintWorkspaceAxisSummary {
  key: string;
  label: string;
  assessedCount: number;
  notAssessedCount: number;
  averageScore: number | null;
  gradeDistribution: Record<string, number>;
  severityCounts: Record<string, number>;
}

export interface LintWorkspaceCoverageSubject {
  subjectType: string;
  subjectId: string;
  projectId: string | null;
  subjectLabel: string | null;
  missingAxes: string[];
}

export interface LintWorkspaceSummary {
  subjects: Record<string, number>;
  gradeDistribution: Record<string, number>;
  axes: LintWorkspaceAxisSummary[];
  coverage: { missingCount: number; subjects: LintWorkspaceCoverageSubject[] };
  findings: Record<string, number>;
  waivers: Record<string, number>;
}

export interface LintWorkspaceTrendPoint {
  date: string;
  newFindings: number;
  remediatedFindings: number;
  waiversGranted: number;
  waiversExpired: number;
  markedFalsePositive: number;
  policyPackPublications: number;
}

export interface LintWorkspaceTrends {
  days: number;
  series: LintWorkspaceTrendPoint[];
}

/** One day of one format's grade series (IXH-2.7). Null averages are gaps, not zeroes. */
export interface QualityRankPoint {
  date: string;
  observations: number;
  averageScore: number | null;
  averageReadiness: number | null;
  gradeDistribution: Record<string, number>;
}

/** One (scope, format) group's grade rollup, attribution split and trend (IXH-2.7). */
export interface QualityRankFormat {
  scope: string;
  formatKey: string;
  adapterKeys: string[];
  styleGuideVersions: string[];
  observations: number;
  gradeDistribution: Record<string, number>;
  averageScore: number | null;
  averageReadiness: number | null;
  latestScore: number | null;
  latestGrade: string | null;
  scoreDelta: number | null;
  outcomes: Record<string, number>;
  blockedCount: number;
  bestRank: number | null;
  adapterFindingCount: number;
  specFindingCount: number;
  declaredParserLimits: number;
  attribution: { adapter: Record<string, number>; spec: Record<string, number> };
  points: QualityRankPoint[];
}

/** The quality-rank series response (IXH-2.7). */
export interface QualityRankSeries {
  days: number;
  windowStart: string;
  windowEnd: string;
  observationCount: number;
  truncated: boolean;
  formatLimit: number;
  stages: Record<string, number>;
  outcomes: Record<string, number>;
  formats: QualityRankFormat[];
}

export interface LintWorkspaceSavedView {
  id: string;
  name: string;
  filters: Record<string, unknown>;
  query: string;
  sort: string;
  isPinned: boolean;
}

export interface LintWorkspaceBulkResult {
  sourceFingerprint: string;
  projectId: string | null;
  decisionId: string | null;
  beforeState: string | null;
  afterState: string | null;
  ok: boolean;
  error: string | null;
}

export interface LintWorkspaceBulkResponse {
  results: LintWorkspaceBulkResult[];
  appliedCount: number;
  failedCount: number;
}

// --- Defensive payload parsers -----------------------------------------------------------------------

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const bool = (v: unknown): boolean => v === true;
const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function countMap(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(rec(v))) out[key] = num(value);
  return out;
}

function decisionFromPayload(v: unknown): LintWorkspaceDecision | null {
  const d = rec(v);
  if (!str(d.id)) return null;
  return {
    id: String(d.id),
    projectId: str(d.projectId),
    state: str(d.state) ?? 'open',
    ownerUserId: str(d.ownerUserId),
    rationale: str(d.rationale),
    linkedTicket: str(d.linkedTicket),
    expiresAt: str(d.expiresAt),
  };
}

/** Coerce one finding row from GET /api/lint/workspace/findings (tolerates malformed data). */
export function lintWorkspaceFindingFromPayload(v: unknown): LintWorkspaceFinding {
  const f = rec(v);
  return {
    sourceFingerprint: str(f.sourceFingerprint),
    ruleId: str(f.ruleId),
    message: str(f.message),
    severity: str(f.severity),
    confidence: str(f.confidence),
    category: str(f.category),
    axisKey: str(f.axisKey) ?? 'quality',
    location: rec(f.location),
    remediation: f.remediation ? rec(f.remediation) : null,
    scannerId: str(f.scannerId) ?? '',
    profile: str(f.profile),
    subjectType: str(f.subjectType) ?? '',
    versionRecordId: str(f.versionRecordId),
    mcpVersionId: str(f.mcpVersionId),
    projectId: str(f.projectId),
    projectName: str(f.projectName),
    subjectLabel: str(f.subjectLabel),
    compositeGrade: str(f.compositeGrade),
    requiredCoverageMet: typeof f.requiredCoverageMet === 'boolean' ? f.requiredCoverageMet : null,
    evidenceRunId: str(f.evidenceRunId),
    evidenceCreatedAt: str(f.evidenceCreatedAt),
    isNew: bool(f.isNew),
    effectiveState: str(f.effectiveState) ?? 'open',
    waived: bool(f.waived),
    decision: decisionFromPayload(f.decision),
    latestPolicyEvaluationId: str(f.latestPolicyEvaluationId),
    policyPassed: typeof f.policyPassed === 'boolean' ? f.policyPassed : null,
  };
}

/** Coerce the findings page payload. */
export function lintWorkspaceFindingsFromPayload(v: unknown): LintWorkspaceFindingsPage {
  const p = rec(v);
  const facets: Record<string, Record<string, number>> = {};
  for (const [group, counts] of Object.entries(rec(p.facets))) facets[group] = countMap(counts);
  return {
    findings: (Array.isArray(p.findings) ? p.findings : []).map(lintWorkspaceFindingFromPayload),
    count: num(p.count),
    total: num(p.total),
    limit: num(p.limit, 50),
    offset: num(p.offset),
    facets,
  };
}

/** Coerce the summary payload. */
export function lintWorkspaceSummaryFromPayload(v: unknown): LintWorkspaceSummary {
  const p = rec(v);
  const coverage = rec(p.coverage);
  return {
    subjects: countMap(p.subjects),
    gradeDistribution: countMap(p.gradeDistribution),
    axes: (Array.isArray(p.axes) ? p.axes : []).map((a) => {
      const axis = rec(a);
      return {
        key: str(axis.key) ?? '',
        label: str(axis.label) ?? '',
        assessedCount: num(axis.assessedCount),
        notAssessedCount: num(axis.notAssessedCount),
        averageScore: typeof axis.averageScore === 'number' ? axis.averageScore : null,
        gradeDistribution: countMap(axis.gradeDistribution),
        severityCounts: countMap(axis.severityCounts),
      };
    }),
    coverage: {
      missingCount: num(coverage.missing_count ?? coverage.missingCount),
      subjects: (Array.isArray(coverage.subjects) ? coverage.subjects : []).map((s) => {
        const subject = rec(s);
        return {
          subjectType: str(subject.subjectType) ?? '',
          subjectId: str(subject.subjectId) ?? '',
          projectId: str(subject.projectId),
          subjectLabel: str(subject.subjectLabel),
          missingAxes: (Array.isArray(subject.missingAxes) ? subject.missingAxes : []).map(String),
        };
      }),
    },
    findings: countMap(p.findings),
    waivers: countMap(p.waivers),
  };
}

/** Coerce the trends payload. */
export function lintWorkspaceTrendsFromPayload(v: unknown): LintWorkspaceTrends {
  const p = rec(v);
  return {
    days: num(p.days),
    series: (Array.isArray(p.series) ? p.series : []).map((entry) => {
      const point = rec(entry);
      return {
        date: str(point.date) ?? '',
        newFindings: num(point.newFindings),
        remediatedFindings: num(point.remediatedFindings),
        waiversGranted: num(point.waiversGranted),
        waiversExpired: num(point.waiversExpired),
        markedFalsePositive: num(point.markedFalsePositive),
        policyPackPublications: num(point.policyPackPublications),
      };
    }),
  };
}

/** Nullable 0-100 measurement: absent or non-numeric reads as a gap, never as zero. */
const gauge = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** Coerce the quality-rank series payload (IXH-2.7). */
export function qualityRankSeriesFromPayload(v: unknown): QualityRankSeries {
  const p = rec(v);
  return {
    days: num(p.days),
    windowStart: str(p.windowStart) ?? '',
    windowEnd: str(p.windowEnd) ?? '',
    observationCount: num(p.observationCount),
    truncated: bool(p.truncated),
    formatLimit: num(p.formatLimit),
    stages: countMap(p.stages),
    outcomes: countMap(p.outcomes),
    formats: (Array.isArray(p.formats) ? p.formats : []).map((entry) => {
      const f = rec(entry);
      const attribution = rec(f.attribution);
      return {
        scope: str(f.scope) ?? '',
        formatKey: str(f.formatKey) ?? 'unknown',
        adapterKeys: (Array.isArray(f.adapterKeys) ? f.adapterKeys : [])
          .map((k) => str(k))
          .filter((k): k is string => k !== null),
        styleGuideVersions: (Array.isArray(f.styleGuideVersions) ? f.styleGuideVersions : [])
          .map((k) => str(k))
          .filter((k): k is string => k !== null),
        observations: num(f.observations),
        gradeDistribution: countMap(f.gradeDistribution),
        averageScore: gauge(f.averageScore),
        averageReadiness: gauge(f.averageReadiness),
        latestScore: gauge(f.latestScore),
        latestGrade: str(f.latestGrade),
        scoreDelta: gauge(f.scoreDelta),
        outcomes: countMap(f.outcomes),
        blockedCount: num(f.blockedCount),
        bestRank: gauge(f.bestRank),
        adapterFindingCount: num(f.adapterFindingCount),
        specFindingCount: num(f.specFindingCount),
        declaredParserLimits: num(f.declaredParserLimits),
        attribution: {
          adapter: countMap(attribution.adapter),
          spec: countMap(attribution.spec),
        },
        points: (Array.isArray(f.points) ? f.points : []).map((raw) => {
          const point = rec(raw);
          return {
            date: str(point.date) ?? '',
            observations: num(point.observations),
            averageScore: gauge(point.averageScore),
            averageReadiness: gauge(point.averageReadiness),
            gradeDistribution: countMap(point.gradeDistribution),
          };
        }),
      };
    }),
  };
}

/**
 * Share of a format's findings the *adapter* is answerable for, 0-100.
 *
 * The number the panel leads with: a format grading low with a high adapter share is an adapter
 * gap, not a spec problem, and the two call for entirely different work. Returns null when the
 * format produced no findings at all — a share of nothing is not zero percent.
 */
export function adapterAttributionShare(entry: QualityRankFormat): number | null {
  const total = entry.adapterFindingCount + entry.specFindingCount;
  if (total <= 0) return null;
  return Math.round((entry.adapterFindingCount / total) * 100);
}

/** Coerce one saved view row. */
export function lintWorkspaceSavedViewFromPayload(v: unknown): LintWorkspaceSavedView | null {
  const view = rec(v);
  const id = str(view.id);
  const name = str(view.name);
  if (!id || !name) return null;
  return {
    id,
    name,
    filters: rec(view.filters),
    query: str(view.query) ?? '',
    sort: str(view.sort) ?? 'severity',
    isPinned: bool(view.isPinned),
  };
}

/** Coerce the bulk response payload. */
export function lintWorkspaceBulkResponseFromPayload(v: unknown): LintWorkspaceBulkResponse {
  const p = rec(v);
  return {
    results: (Array.isArray(p.results) ? p.results : []).map((entry) => {
      const r = rec(entry);
      return {
        sourceFingerprint: str(r.sourceFingerprint) ?? '',
        projectId: str(r.projectId),
        decisionId: str(r.decisionId),
        beforeState: str(r.beforeState),
        afterState: str(r.afterState),
        ok: bool(r.ok),
        error: str(r.error),
      };
    }),
    appliedCount: num(p.appliedCount),
    failedCount: num(p.failedCount),
  };
}

// --- Filter state <-> URL / saved-view blob -----------------------------------------------------------

/** Workspace filter state; multi-value facets are string arrays, serialized as csv params. */
export interface WorkspaceFilters {
  severity: string[];
  state: string[];
  axis: string[];
  grade: string[];
  coverage: '' | 'missing' | 'met';
  profile: string[];
  scanner: string[];
  subjectType: string;
  projectId: string;
  ownerUserId: string;
  ruleId: string;
  category: string;
  newOnly: boolean;
  q: string;
}

export const EMPTY_WORKSPACE_FILTERS: WorkspaceFilters = {
  severity: [],
  state: [],
  axis: [],
  grade: [],
  coverage: '',
  profile: [],
  scanner: [],
  subjectType: '',
  projectId: '',
  ownerUserId: '',
  ruleId: '',
  category: '',
  newOnly: false,
  q: '',
};

const CSV_KEYS = ['severity', 'state', 'axis', 'grade', 'profile', 'scanner'] as const;
const TEXT_KEYS = ['subjectType', 'projectId', 'ownerUserId', 'ruleId', 'category', 'q'] as const;

/** Serialize filter state into the query params the findings endpoint (and proxy) accept. */
export function filtersToSearchParams(
  filters: WorkspaceFilters,
  extra?: { sort?: string; limit?: number; offset?: number },
): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of CSV_KEYS) {
    const values = filters[key];
    if (values.length) params.set(key, values.join(','));
  }
  for (const key of TEXT_KEYS) {
    const value = filters[key].trim();
    if (value) params.set(key, value);
  }
  if (filters.coverage) params.set('coverage', filters.coverage);
  if (filters.newOnly) params.set('new', 'true');
  if (extra?.sort) params.set('sort', extra.sort);
  if (extra?.limit !== undefined) params.set('limit', String(extra.limit));
  if (extra?.offset !== undefined) params.set('offset', String(extra.offset));
  return params;
}

/** Parse filter state back out of query params (inverse of filtersToSearchParams). */
export function parseWorkspaceFilters(params: URLSearchParams): WorkspaceFilters {
  const csv = (key: string): string[] =>
    (params.get(key) || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  const coverageRaw = params.get('coverage') || '';
  return {
    severity: csv('severity'),
    state: csv('state'),
    axis: csv('axis'),
    grade: csv('grade'),
    coverage: coverageRaw === 'missing' || coverageRaw === 'met' ? coverageRaw : '',
    profile: csv('profile'),
    scanner: csv('scanner'),
    subjectType: params.get('subjectType') || '',
    projectId: params.get('projectId') || '',
    ownerUserId: params.get('ownerUserId') || '',
    ruleId: params.get('ruleId') || '',
    category: params.get('category') || '',
    newOnly: params.get('new') === 'true',
    q: params.get('q') || '',
  };
}

/** The saved-view `filters` blob for the current filter state (same vocabulary as the API). */
export function filtersToSavedViewBlob(filters: WorkspaceFilters): Record<string, unknown> {
  const blob: Record<string, unknown> = {};
  for (const key of CSV_KEYS) if (filters[key].length) blob[key] = filters[key];
  for (const key of TEXT_KEYS) {
    if (key === 'q') continue; // q is stored in the saved view's own `query` column
    const value = filters[key].trim();
    if (value) blob[key] = value;
  }
  if (filters.coverage) blob.coverage = filters.coverage;
  if (filters.newOnly) blob.new = true;
  return blob;
}

/** Rehydrate filter state from a saved view (blob + query column). */
export function savedViewToFilters(view: LintWorkspaceSavedView): WorkspaceFilters {
  const blob = view.filters;
  const list = (v: unknown): string[] =>
    Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? v.split(',') : [];
  const text = (v: unknown): string => (typeof v === 'string' ? v : '');
  const coverageRaw = text(blob.coverage);
  return {
    severity: list(blob.severity),
    state: list(blob.state),
    axis: list(blob.axis),
    grade: list(blob.grade),
    coverage: coverageRaw === 'missing' || coverageRaw === 'met' ? coverageRaw : '',
    profile: list(blob.profile),
    scanner: list(blob.scanner),
    subjectType: text(blob.subjectType ?? blob.subject_type),
    projectId: text(blob.projectId ?? blob.project_id),
    ownerUserId: text(blob.ownerUserId ?? blob.owner_user_id),
    ruleId: text(blob.ruleId ?? blob.rule_id),
    category: text(blob.category),
    newOnly: blob.new === true,
    q: view.query,
  };
}

/** Count how many filter dimensions are active (for the "clear filters" chip). */
export function activeFilterCount(filters: WorkspaceFilters): number {
  let count = 0;
  for (const key of CSV_KEYS) if (filters[key].length) count += 1;
  for (const key of TEXT_KEYS) if (filters[key].trim()) count += 1;
  if (filters.coverage) count += 1;
  if (filters.newOnly) count += 1;
  return count;
}

// --- Selection & bulk actions ---------------------------------------------------------------------------

/** Stable selection key for one finding row (fingerprint + project scope). */
export function selectionKey(finding: Pick<LintWorkspaceFinding, 'sourceFingerprint' | 'projectId'>): string {
  return `${finding.sourceFingerprint ?? ''}|${finding.projectId ?? ''}`;
}

export interface BulkActionSet {
  state?: LintDecisionState;
  ownerUserId?: string;
  rationale?: string;
  linkedTicket?: string;
  expiresAt?: string;
}

/** Build the POST /decisions/bulk body from the selected findings and an action. */
export function buildBulkRequest(
  selected: Array<Pick<LintWorkspaceFinding, 'sourceFingerprint' | 'projectId' | 'ruleId'>>,
  set: BulkActionSet,
): { items: Array<Record<string, string>>; set: Record<string, string> } {
  const items = selected
    .filter((f) => f.sourceFingerprint)
    .map((f) => {
      const item: Record<string, string> = { sourceFingerprint: f.sourceFingerprint as string };
      if (f.projectId) item.projectId = f.projectId;
      if (f.ruleId) item.ruleId = f.ruleId;
      return item;
    });
  const body: Record<string, string> = {};
  if (set.state) body.state = set.state;
  if (set.ownerUserId) body.ownerUserId = set.ownerUserId;
  if (set.rationale) body.rationale = set.rationale;
  if (set.linkedTicket) body.linkedTicket = set.linkedTicket;
  if (set.expiresAt) body.expiresAt = set.expiresAt;
  return { items, set: body };
}

/**
 * Build the inverse bulk requests from a bulk response (reversibility, AC-3).
 *
 * Applied items are grouped by their beforeState; each group becomes one request restoring
 * that state. Items that had no decision row before revert to `open` (there is no delete).
 */
export function buildUndoBulkRequests(
  response: LintWorkspaceBulkResponse,
): Array<{ items: Array<Record<string, string>>; set: Record<string, string> }> {
  const groups = new Map<string, Array<Record<string, string>>>();
  for (const result of response.results) {
    if (!result.ok || !result.sourceFingerprint) continue;
    const restoreState = result.beforeState ?? 'open';
    if (restoreState === result.afterState) continue;
    const item: Record<string, string> = { sourceFingerprint: result.sourceFingerprint };
    if (result.projectId) item.projectId = result.projectId;
    const bucket = groups.get(restoreState);
    if (bucket) bucket.push(item);
    else groups.set(restoreState, [item]);
  }
  return Array.from(groups.entries()).map(([state, items]) => ({ items, set: { state } }));
}

// --- Waiver state machine (client mirror; the server re-validates everything) ---------------------------

/**
 * The transitions to offer from a finding's effective state.
 *
 * @param state - Current effective decision state.
 * @param canApprove - Whether the caller holds lint_findings:publish (waiver review).
 * @returns Target states to render as available actions.
 */
export function allowedDecisionTransitions(
  state: string,
  canApprove: boolean,
): LintDecisionState[] {
  const base: LintDecisionState[] = ['acknowledged', 'fixed', 'false_positive', 'waiver_requested'];
  switch (state) {
    case 'waiver_requested':
      // Approve / reject are review decisions; withdrawal (acknowledged) is the requester's.
      return canApprove ? ['waived', 'open', 'acknowledged'] : ['acknowledged'];
    case 'waived':
      return canApprove ? ['open', 'fixed'] : [];
    case 'open':
      return canApprove ? [...base, 'waived'] : base;
    default: {
      const options = base.filter((s) => s !== state);
      return canApprove ? [...options, 'waived'] : options;
    }
  }
}

/** True when a waived decision expires within the "expiring soon" window. */
export function isWaiverExpiringSoon(
  expiresAt: string | null | undefined,
  now: Date = new Date(),
  days: number = WAIVER_EXPIRING_SOON_DAYS,
): boolean {
  if (!expiresAt) return false;
  const expiry = new Date(expiresAt);
  if (Number.isNaN(expiry.getTime())) return false;
  const cutoff = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  return expiry > now && expiry <= cutoff;
}
