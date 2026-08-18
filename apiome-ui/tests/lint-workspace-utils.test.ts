/**
 * Unit tests for the pure lint-workspace utilities (CLX-4.1, #4859; IXH-2.7, #5102):
 * URL <-> filter round-trips, saved-view blob shape, bulk/undo request builders, the
 * client-side transition matrix, waiver expiry, and defensive payload coercion — including
 * the quality-rank series, whose coercion moved here from the panel's own suite when
 * HIVE-5.8 (#5311) rebuilt the panel.
 */

import {
  EMPTY_WORKSPACE_FILTERS,
  adapterAttributionShare,
  activeFilterCount,
  allowedDecisionTransitions,
  buildBulkRequest,
  buildUndoBulkRequests,
  filtersToSavedViewBlob,
  filtersToSearchParams,
  isWaiverExpiringSoon,
  lintWorkspaceBulkResponseFromPayload,
  lintWorkspaceFindingsFromPayload,
  lintWorkspaceSummaryFromPayload,
  lintWorkspaceTrendsFromPayload,
  parseWorkspaceFilters,
  qualityRankSeriesFromPayload,
  savedViewToFilters,
  selectionKey,
  type QualityRankFormat,
  type WorkspaceFilters,
} from '../src/app/utils/lint-workspace';

const FULL_FILTERS: WorkspaceFilters = {
  ...EMPTY_WORKSPACE_FILTERS,
  severity: ['error', 'warning'],
  state: ['open', 'waiver_requested'],
  axis: ['security'],
  grade: ['A', 'F'],
  coverage: 'missing',
  scanner: ['apiome.native-lint'],
  subjectType: 'catalog_revision',
  projectId: 'p1',
  ownerUserId: 'u9',
  ruleId: 'sec-1',
  newOnly: true,
  q: 'payment',
};

describe('filter URL round-trip', () => {
  it('serializes and parses back losslessly', () => {
    const params = filtersToSearchParams(FULL_FILTERS, { sort: 'newest', limit: 50, offset: 100 });
    expect(params.get('severity')).toBe('error,warning');
    expect(params.get('coverage')).toBe('missing');
    expect(params.get('new')).toBe('true');
    expect(params.get('sort')).toBe('newest');
    expect(params.get('limit')).toBe('50');
    expect(parseWorkspaceFilters(params)).toEqual(FULL_FILTERS);
  });

  it('omits empty dimensions and rejects bad coverage values on parse', () => {
    const params = filtersToSearchParams(EMPTY_WORKSPACE_FILTERS);
    expect(params.toString()).toBe('');
    const parsed = parseWorkspaceFilters(new URLSearchParams('coverage=sometimes'));
    expect(parsed.coverage).toBe('');
  });

  it('counts active dimensions', () => {
    expect(activeFilterCount(EMPTY_WORKSPACE_FILTERS)).toBe(0);
    // severity, state, axis, grade, scanner, coverage, subjectType, projectId,
    // ownerUserId, ruleId, newOnly, q — 12 active dimensions in the fixture.
    expect(activeFilterCount(FULL_FILTERS)).toBe(12);
  });
});

describe('saved-view blob round-trip', () => {
  it('stores filters (q separately) and rehydrates', () => {
    const blob = filtersToSavedViewBlob(FULL_FILTERS);
    expect(blob).not.toHaveProperty('q');
    expect(blob.severity).toEqual(['error', 'warning']);
    expect(blob.new).toBe(true);
    const restored = savedViewToFilters({
      id: 'v1',
      name: 'View',
      filters: blob,
      query: 'payment',
      sort: 'severity',
      isPinned: false,
    });
    expect(restored).toEqual(FULL_FILTERS);
  });

  it('tolerates snake_case and csv blobs from older saves', () => {
    const restored = savedViewToFilters({
      id: 'v1',
      name: 'View',
      filters: { severity: 'error,info', project_id: 'p2' },
      query: '',
      sort: 'severity',
      isPinned: false,
    });
    expect(restored.severity).toEqual(['error', 'info']);
    expect(restored.projectId).toBe('p2');
  });
});

describe('bulk request builders', () => {
  it('builds items from selected findings and drops fingerprint-less rows', () => {
    const request = buildBulkRequest(
      [
        { sourceFingerprint: 'f1', projectId: 'p1', ruleId: 'r1' },
        { sourceFingerprint: null, projectId: null, ruleId: null },
      ],
      { state: 'acknowledged', ownerUserId: 'u9' },
    );
    expect(request.items).toEqual([{ sourceFingerprint: 'f1', projectId: 'p1', ruleId: 'r1' }]);
    expect(request.set).toEqual({ state: 'acknowledged', ownerUserId: 'u9' });
  });

  it('builds inverse requests grouped by beforeState (reversibility)', () => {
    const undo = buildUndoBulkRequests({
      appliedCount: 3,
      failedCount: 1,
      results: [
        { sourceFingerprint: 'f1', projectId: null, decisionId: 'd1', beforeState: 'open', afterState: 'acknowledged', ok: true, error: null },
        { sourceFingerprint: 'f2', projectId: 'p1', decisionId: 'd2', beforeState: null, afterState: 'acknowledged', ok: true, error: null },
        { sourceFingerprint: 'f3', projectId: null, decisionId: 'd3', beforeState: 'acknowledged', afterState: 'acknowledged', ok: true, error: null },
        { sourceFingerprint: 'f4', projectId: null, decisionId: null, beforeState: 'open', afterState: null, ok: false, error: 'boom' },
      ],
    });
    // f3 (no state change) and f4 (failed) are skipped; f1 and f2 both restore to open.
    expect(undo).toEqual([
      {
        items: [{ sourceFingerprint: 'f1' }, { sourceFingerprint: 'f2', projectId: 'p1' }],
        set: { state: 'open' },
      },
    ]);
  });
});

describe('client transition matrix', () => {
  it('lets editors triage and request but not approve', () => {
    expect(allowedDecisionTransitions('open', false)).toEqual([
      'acknowledged',
      'fixed',
      'false_positive',
      'waiver_requested',
    ]);
    expect(allowedDecisionTransitions('waived', false)).toEqual([]);
    expect(allowedDecisionTransitions('waiver_requested', false)).toEqual(['acknowledged']);
  });

  it('lets approvers waive, revoke, and resolve requests', () => {
    expect(allowedDecisionTransitions('open', true)).toContain('waived');
    expect(allowedDecisionTransitions('waived', true)).toEqual(['open', 'fixed']);
    expect(allowedDecisionTransitions('waiver_requested', true)).toEqual([
      'waived',
      'open',
      'acknowledged',
    ]);
  });
});

describe('isWaiverExpiringSoon', () => {
  const now = new Date('2026-07-14T12:00:00Z');
  it('flags expiries inside the window and ignores the rest', () => {
    expect(isWaiverExpiringSoon('2026-07-20T00:00:00Z', now)).toBe(true);
    expect(isWaiverExpiringSoon('2026-09-01T00:00:00Z', now)).toBe(false);
    expect(isWaiverExpiringSoon('2026-07-01T00:00:00Z', now)).toBe(false); // already expired
    expect(isWaiverExpiringSoon(null, now)).toBe(false);
    expect(isWaiverExpiringSoon('not-a-date', now)).toBe(false);
  });
});

describe('defensive payload parsers', () => {
  it('coerces a malformed findings payload without throwing', () => {
    const page = lintWorkspaceFindingsFromPayload({
      findings: [{ ruleId: 42, isNew: 'yes', location: 'not-an-object' }, null, 'junk'],
      total: '9',
      facets: { severity: { error: '3' }, junk: null },
    });
    expect(page.findings).toHaveLength(3);
    expect(page.findings[0].ruleId).toBeNull();
    expect(page.findings[0].isNew).toBe(false);
    expect(page.findings[0].location).toEqual({});
    expect(page.findings[0].effectiveState).toBe('open');
    expect(page.total).toBe(0);
    expect(page.facets.severity).toEqual({ error: 0 });
  });

  it('coerces summary and trends payloads', () => {
    const summary = lintWorkspaceSummaryFromPayload({
      findings: { unwaived_errors: 2 },
      coverage: { missing_count: 1, subjects: [{ subjectType: 'catalog_revision', subjectId: 'v1', missingAxes: ['quality'] }] },
      axes: [{ key: 'quality', label: 'Quality', assessedCount: 3 }],
    });
    expect(summary.findings.unwaived_errors).toBe(2);
    expect(summary.coverage.missingCount).toBe(1);
    expect(summary.coverage.subjects[0].missingAxes).toEqual(['quality']);
    expect(summary.axes[0].averageScore).toBeNull();

    const trends = lintWorkspaceTrendsFromPayload({
      days: 7,
      series: [{ date: '2026-07-14', newFindings: 2, remediatedFindings: 1 }],
    });
    expect(trends.series[0].newFindings).toBe(2);
    expect(trends.series[0].policyPackPublications).toBe(0);
  });

  it('coerces the bulk response', () => {
    const response = lintWorkspaceBulkResponseFromPayload({
      results: [{ sourceFingerprint: 'f1', ok: true, beforeState: 'open', afterState: 'fixed' }],
      appliedCount: 1,
      failedCount: 0,
    });
    expect(response.results[0].beforeState).toBe('open');
    expect(response.appliedCount).toBe(1);
  });
});

describe('selectionKey', () => {
  it('is stable across fingerprint + project scope', () => {
    expect(selectionKey({ sourceFingerprint: 'f1', projectId: 'p1' })).toBe('f1|p1');
    expect(selectionKey({ sourceFingerprint: 'f1', projectId: null })).toBe('f1|');
  });
});

// --- Quality-rank telemetry (IXH-2.7, #5102) ---------------------------------------------------

/**
 * One (scope, format) rank group.
 *
 * @param overrides Fields to change.
 * @returns The group.
 */
function formatEntry(overrides: Partial<QualityRankFormat> = {}): QualityRankFormat {
  return {
    scope: 'import',
    formatKey: 'openapi-3.1',
    adapterKeys: ['openapi'],
    styleGuideVersions: ['guide-a'],
    observations: 6,
    gradeDistribution: { A: 1, B: 3, C: 1, D: 0, F: 1, ungraded: 0 },
    averageScore: 78,
    averageReadiness: null,
    latestScore: 74,
    latestGrade: 'C',
    scoreDelta: -6,
    outcomes: { pass: 4, warn: 1, block: 1 },
    blockedCount: 1,
    bestRank: null,
    adapterFindingCount: 3,
    specFindingCount: 9,
    declaredParserLimits: 2,
    attribution: { adapter: { 'unsupported-construct': 3 }, spec: { naming: 9 } },
    points: [
      {
        date: '2026-08-01',
        observations: 3,
        averageScore: 82,
        averageReadiness: null,
        gradeDistribution: { A: 1, B: 2 },
      },
      {
        date: '2026-08-02',
        observations: 3,
        averageScore: 74,
        averageReadiness: null,
        gradeDistribution: { C: 1, F: 1, B: 1 },
      },
    ],
    ...overrides,
  };
}

// --- Payload coercion -------------------------------------------------------------------------

describe('qualityRankSeriesFromPayload', () => {
  it('coerces the enveloped response into the series shape', () => {
    const parsed = qualityRankSeriesFromPayload({
      success: true,
      days: 7,
      windowStart: '2026-07-27',
      windowEnd: '2026-08-02',
      observationCount: 2,
      truncated: true,
      formatLimit: 24,
      stages: { preflight: 2, committed: 0 },
      outcomes: { pass: 2 },
      formats: [
        {
          scope: 'export',
          formatKey: 'grpc',
          adapterKeys: ['grpc'],
          styleGuideVersions: ['g1', 'g2'],
          observations: 2,
          gradeDistribution: { B: 2 },
          averageScore: 80,
          averageReadiness: 91,
          latestScore: 80,
          latestGrade: 'B',
          scoreDelta: 0,
          outcomes: { pass: 2 },
          blockedCount: 0,
          bestRank: 1,
          adapterFindingCount: 0,
          specFindingCount: 4,
          declaredParserLimits: 2,
          attribution: { adapter: {}, spec: { naming: 4 } },
          points: [
            { date: '2026-08-02', observations: 2, averageScore: 80, averageReadiness: 91 },
          ],
        },
      ],
    });

    expect(parsed.days).toBe(7);
    expect(parsed.truncated).toBe(true);
    expect(parsed.formats).toHaveLength(1);
    expect(parsed.formats[0].bestRank).toBe(1);
    expect(parsed.formats[0].styleGuideVersions).toEqual(['g1', 'g2']);
    expect(parsed.formats[0].attribution.spec).toEqual({ naming: 4 });
    expect(parsed.formats[0].points[0].gradeDistribution).toEqual({});
  });

  it('keeps a missing average as a gap rather than turning it into zero', () => {
    const parsed = qualityRankSeriesFromPayload({
      formats: [
        {
          formatKey: 'thrift',
          averageScore: null,
          points: [{ date: '2026-08-02', observations: 0, averageScore: null }],
        },
      ],
    });
    expect(parsed.formats[0].averageScore).toBeNull();
    expect(parsed.formats[0].points[0].averageScore).toBeNull();
    expect(parsed.formats[0].points[0].observations).toBe(0);
  });

  it('degrades a malformed payload instead of throwing', () => {
    const parsed = qualityRankSeriesFromPayload({ formats: 'nope', stages: 7 });
    expect(parsed.formats).toEqual([]);
    expect(parsed.stages).toEqual({});
    expect(parsed.observationCount).toBe(0);
  });
});

// --- Attribution share ------------------------------------------------------------------------

describe('adapterAttributionShare', () => {
  it('reports the adapter percentage of the finding split', () => {
    expect(adapterAttributionShare(formatEntry())).toBe(25);
  });

  it('is null when nothing was found, because a share of nothing is not zero percent', () => {
    expect(
      adapterAttributionShare(
        formatEntry({ adapterFindingCount: 0, specFindingCount: 0 }),
      ),
    ).toBeNull();
  });
});
