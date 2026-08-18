/**
 * Fixtures for the lint posture workspace suites (HIVE-5.8, #5311).
 *
 * Four suites render this screen — the model, the components, the page and the stylesheet —
 * and each needs the same shapes. They live here rather than being copied into each file so
 * that a change to `LintWorkspaceFinding` breaks one fixture instead of four, and so that a
 * test naming a *value* (a grade, a state, a count) is naming a deliberate one.
 */

import type {
  LintWorkspaceBulkResponse,
  LintWorkspaceFinding,
  LintWorkspaceFindingsPage,
  LintWorkspaceSavedView,
  LintWorkspaceSummary,
  LintWorkspaceTrends,
  QualityRankFormat,
  QualityRankSeries,
} from '../../src/app/utils/lint-workspace';

/**
 * One enriched finding row.
 *
 * @param overrides Fields to change.
 * @returns The finding.
 */
export function finding(overrides: Partial<LintWorkspaceFinding> = {}): LintWorkspaceFinding {
  return {
    sourceFingerprint: 'f1',
    ruleId: 'no-http-basic',
    message: 'HTTP Basic auth scheme detected.',
    severity: 'error',
    confidence: 'high',
    category: 'security',
    axisKey: 'security',
    location: { path: 'components.securitySchemes.basicAuth', line: 412 },
    remediation: { fix: 'Replace the basic scheme with an OAuth2 client-credentials flow.' },
    scannerId: 'apiome-security',
    profile: 'Acme REST · security pack',
    subjectType: 'catalog_revision',
    versionRecordId: 'ver_2f0a91',
    mcpVersionId: null,
    projectId: 'p1',
    projectName: 'Payments API',
    subjectLabel: 'v2.4.0',
    compositeGrade: 'B',
    requiredCoverageMet: true,
    evidenceRunId: 'run_7c1e92',
    evidenceCreatedAt: '2026-08-15T08:52:00Z',
    isNew: true,
    effectiveState: 'open',
    waived: false,
    decision: null,
    latestPolicyEvaluationId: 'ev_44b0c1',
    policyPassed: false,
    ...overrides,
  };
}

/** Two rows: a new open error, and an acknowledged warning with a decision on it. */
export const FINDINGS: LintWorkspaceFinding[] = [
  finding(),
  finding({
    sourceFingerprint: 'f2',
    ruleId: 'response-4xx-defined',
    message: 'POST /payouts documents no 4xx response.',
    severity: 'warning',
    axisKey: 'quality',
    scannerId: 'spectral',
    isNew: false,
    effectiveState: 'acknowledged',
    decision: {
      id: 'dec-2',
      projectId: 'p1',
      state: 'acknowledged',
      ownerUserId: 'user-9',
      rationale: null,
      linkedTicket: 'https://tracker/SEC-1182',
      expiresAt: null,
    },
  }),
];

/**
 * One page of the findings queue.
 *
 * @param overrides Fields to change.
 * @returns The page.
 */
export function findingsPage(
  overrides: Partial<LintWorkspaceFindingsPage> = {}
): LintWorkspaceFindingsPage {
  return {
    findings: FINDINGS,
    count: FINDINGS.length,
    total: 213,
    limit: 50,
    offset: 0,
    facets: {
      severity: { error: 21, warning: 142, info: 50 },
      effectiveState: { open: 168, acknowledged: 18, waiver_requested: 3 },
      axis: { quality: 120, security: 31 },
      grade: { A: 40, B: 96 },
      scannerId: { spectral: 180, 'apiome-security': 33 },
    },
    ...overrides,
  };
}

/**
 * The posture summary.
 *
 * @param overrides Fields to change.
 * @returns The summary.
 */
export function summary(overrides: Partial<LintWorkspaceSummary> = {}): LintWorkspaceSummary {
  return {
    subjects: { catalog_revisions: 10, mcp_endpoint_versions: 2 },
    gradeDistribution: { A: 3, B: 5, C: 2, D: 1, F: 0, ungraded: 1 },
    axes: [
      {
        key: 'quality',
        label: 'Quality',
        assessedCount: 12,
        notAssessedCount: 0,
        averageScore: 84,
        gradeDistribution: { A: 3 },
        severityCounts: { error: 3, warning: 5, info: 1 },
      },
      {
        key: 'supply_chain',
        label: 'Supply chain',
        assessedCount: 0,
        notAssessedCount: 12,
        averageScore: null,
        gradeDistribution: {},
        severityCounts: {},
      },
    ],
    coverage: {
      missingCount: 3,
      subjects: [
        {
          subjectType: 'catalog_revision',
          subjectId: 'v1',
          projectId: 'p1',
          subjectLabel: 'v2.4.0',
          missingAxes: ['security'],
        },
      ],
    },
    findings: {
      open: 168,
      new_count: 7,
      unwaived_errors: 12,
      unwaived_security_errors: 2,
    },
    waivers: { active: 4, requested: 3, expiring_soon: 1 },
    ...overrides,
  };
}

/**
 * A daily trends payload.
 *
 * @param days How many days to generate.
 * @returns The payload.
 */
export function trends(days = 3): LintWorkspaceTrends {
  return {
    days: 30,
    series: Array.from({ length: days }, (_, index) => ({
      date: `2026-08-${String(index + 1).padStart(2, '0')}`,
      newFindings: index + 1,
      remediatedFindings: index,
      waiversGranted: index % 2,
      waiversExpired: 0,
      markedFalsePositive: index,
      policyPackPublications: 1,
    })),
  };
}

/**
 * One (scope, format) rank card.
 *
 * @param overrides Fields to change.
 * @returns The card's data.
 */
export function rankFormat(overrides: Partial<QualityRankFormat> = {}): QualityRankFormat {
  return {
    scope: 'import',
    formatKey: 'openapi-3.1',
    adapterKeys: ['openapi-adapter'],
    styleGuideVersions: ['guide-a'],
    observations: 28,
    gradeDistribution: { A: 11, B: 20, C: 8, D: 3, F: 1, ungraded: 2 },
    averageScore: 84,
    averageReadiness: null,
    latestScore: 86,
    latestGrade: 'B',
    scoreDelta: 6,
    outcomes: { warn: 4 },
    blockedCount: 1,
    bestRank: null,
    adapterFindingCount: 41,
    specFindingCount: 67,
    declaredParserLimits: 2,
    attribution: { adapter: { openapi: 41 }, spec: { document: 67 } },
    points: [
      { date: '2026-08-01', observations: 3, averageScore: 80, averageReadiness: null, gradeDistribution: {} },
      { date: '2026-08-02', observations: 0, averageScore: null, averageReadiness: null, gradeDistribution: {} },
      { date: '2026-08-03', observations: 4, averageScore: 86, averageReadiness: null, gradeDistribution: {} },
    ],
    ...overrides,
  };
}

/**
 * The quality-rank series.
 *
 * @param overrides Fields to change.
 * @returns The series.
 */
export function rankSeries(overrides: Partial<QualityRankSeries> = {}): QualityRankSeries {
  return {
    days: 30,
    windowStart: 'Jul 16',
    windowEnd: 'Aug 15',
    observationCount: 73,
    truncated: false,
    formatLimit: 6,
    stages: { preflight: 42, committed: 31 },
    outcomes: { warn: 4 },
    formats: [rankFormat()],
    ...overrides,
  };
}

/**
 * A saved view.
 *
 * @param overrides Fields to change.
 * @returns The view.
 */
export function savedView(
  overrides: Partial<LintWorkspaceSavedView> = {}
): LintWorkspaceSavedView {
  return {
    id: 'view-1',
    name: 'New security errors',
    filters: { severity: ['error'], axis: ['security'], state: ['open'] },
    query: '',
    sort: 'severity',
    isPinned: true,
    ...overrides,
  };
}

/**
 * A bulk-decision response.
 *
 * @param overrides Fields to change.
 * @returns The response.
 */
export function bulkResponse(
  overrides: Partial<LintWorkspaceBulkResponse> = {}
): LintWorkspaceBulkResponse {
  return {
    results: [
      {
        sourceFingerprint: 'f1',
        projectId: 'p1',
        decisionId: 'dec-1',
        beforeState: 'open',
        afterState: 'acknowledged',
        ok: true,
        error: null,
      },
    ],
    appliedCount: 1,
    failedCount: 0,
    ...overrides,
  };
}
