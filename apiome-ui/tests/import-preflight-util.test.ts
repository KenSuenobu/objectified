/**
 * Import pre-flight client helpers (IXH-2.2, #5097; server-side waiver ledger IXH-2.3, #5098).
 *
 * Covers the rules the quality step delegates: the gate decision for every outcome (pass, warn,
 * block, block-without-override, unimportable candidate, transport failure, still-scoring), the
 * severity tally and its fallback, the threshold comparison, the finding→source-line resolution,
 * the waiver record and its grant against the tenant ledger, and the fetch's success/failure
 * contract.
 */

import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';

import {
  buildImportQualityWaiver,
  buildImportQualityWaiverRequest,
  cacheImportQualityWaiverLocally,
  decidePreflightGate,
  fetchImportPreflight,
  locateFindingLine,
  preflightSeverityTally,
  preflightThresholdComparison,
  readImportQualityWaivers,
  recordImportQualityWaiver,
  IMPORT_QUALITY_WAIVER_LIMIT,
  type PreflightReport,
} from '../src/app/utils/import-preflight';
import { clampRowIndex, computeWindowedRange } from '../src/app/utils/windowed-rows';
import {
  persistImportQualityPreferences,
  readImportQualityPreferences,
} from '../src/app/utils/import-quality-preferences';

/** A minimal but complete report; each test overrides only what it is about. */
function report(overrides: Partial<PreflightReport> = {}): PreflightReport {
  return {
    ok: true,
    detection: { adapter_key: 'graphql', confidence: 0.95, matched: true, importable: true },
    lint: {
      score: 82,
      grade: 'B',
      report_fingerprint: 'fp-1',
      severity_counts: { error: 0, warning: 2, info: 1 },
      findings: [],
    },
    style_guide: { guide_id: null, name: 'Apiome defaults', source: 'fallback', fingerprint: 'sg-1' },
    policy: {
      verdict: 'pass',
      blocking: false,
      source: 'default',
      reason: 'No import quality policy is configured.',
      threshold_score: null,
      allow_override: true,
    },
    cache: { hit: false, key: 'k', content_hash: 'sha-1' },
    ...overrides,
  };
}

describe('decidePreflightGate', () => {
  it('allows the import on a passing verdict', () => {
    const gate = decidePreflightGate(report(), null);
    expect(gate.tone).toBe('pass');
    expect(gate.canImport).toBe(true);
    expect(gate.canOverride).toBe(false);
    expect(gate.canRetry).toBe(false);
  });

  it('allows the import on a warning verdict, keeping the reason', () => {
    const gate = decidePreflightGate(
      report({
        policy: {
          verdict: 'warn',
          blocking: false,
          source: 'tenant',
          reason: 'Score 72 is below the recommended 80.',
          threshold_score: 80,
        },
      }),
      null,
    );
    expect(gate.tone).toBe('warn');
    expect(gate.canImport).toBe(true);
    expect(gate.reason).toContain('below the recommended 80');
  });

  it('blocks the import and offers the waiver path when policy permits an override', () => {
    const gate = decidePreflightGate(
      report({
        policy: {
          verdict: 'block',
          blocking: true,
          source: 'tenant',
          reason: 'Score 41 is below the required 70.',
          threshold_score: 70,
          allow_override: true,
        },
      }),
      null,
    );
    expect(gate.tone).toBe('block');
    expect(gate.canImport).toBe(false);
    expect(gate.canOverride).toBe(true);
    expect(gate.reason).toContain('required 70');
  });

  it('blocks with no waiver path when policy forbids an override', () => {
    const gate = decidePreflightGate(
      report({
        policy: {
          verdict: 'block',
          blocking: true,
          source: 'tenant',
          reason: 'Errors must be cleared before import.',
          threshold_score: 70,
          allow_override: false,
        },
      }),
      null,
    );
    expect(gate.canImport).toBe(false);
    expect(gate.canOverride).toBe(false);
  });

  it('treats a missing allow_override as permitted, never as forbidden', () => {
    const gate = decidePreflightGate(
      report({
        policy: {
          verdict: 'block',
          blocking: true,
          source: 'tenant',
          reason: 'Blocked.',
          threshold_score: 70,
        },
      }),
      null,
    );
    expect(gate.canOverride).toBe(true);
  });

  it('refuses every commit for an unimportable candidate, retrying only when retriable', () => {
    const retriable = decidePreflightGate(
      report({
        ok: false,
        lint: null,
        error: {
          code: 'RESOURCE_TIMEOUT',
          category: 'resource',
          message: 'Parsing timed out.',
          remediation: 'Try a smaller document.',
          retriable: true,
        },
      }),
      null,
    );
    expect(retriable.tone).toBe('error');
    expect(retriable.canImport).toBe(false);
    expect(retriable.canOverride).toBe(false);
    expect(retriable.canRetry).toBe(true);

    const terminal = decidePreflightGate(
      report({
        ok: false,
        lint: null,
        error: {
          code: 'FORMAT_UNRECOGNIZED',
          category: 'format',
          message: 'No importer recognized this document.',
          remediation: 'Pick the format explicitly.',
          retriable: false,
        },
      }),
      null,
    );
    expect(terminal.canRetry).toBe(false);
    expect(terminal.canImport).toBe(false);
  });

  it('degrades a transport failure to unscored — retry, or proceed without a score', () => {
    const gate = decidePreflightGate(null, 'The pre-flight service is unavailable.');
    expect(gate.tone).toBe('unscored');
    expect(gate.canImport).toBe(true);
    expect(gate.canRetry).toBe(true);
    expect(gate.canOverride).toBe(false);
    expect(gate.reason).toContain('No quality score was captured');
  });

  it('commits nothing while the pre-flight is still running', () => {
    const gate = decidePreflightGate(null, null);
    expect(gate.canImport).toBe(false);
    expect(gate.canRetry).toBe(false);
  });
});

describe('preflightSeverityTally', () => {
  it("uses the server's counts and always reports the three known severities", () => {
    const rows = preflightSeverityTally({ severity_counts: { error: 3, info: 1 } });
    expect(rows).toEqual([
      { severity: 'error', count: 3 },
      { severity: 'warning', count: 0 },
      { severity: 'info', count: 1 },
    ]);
  });

  it('falls back to counting findings when the server omits the roll-up', () => {
    const rows = preflightSeverityTally({
      findings: [
        { rank: 1, rule: 'a', severity: 'error', message: 'm', path: '', weight: 1, rule_penalty: 1 },
        { rank: 2, rule: 'b', severity: 'error', message: 'm', path: '', weight: 1, rule_penalty: 1 },
        { rank: 3, rule: 'c', severity: 'info', message: 'm', path: '', weight: 1, rule_penalty: 1 },
      ],
    });
    expect(rows.find((r) => r.severity === 'error')?.count).toBe(2);
    expect(rows.find((r) => r.severity === 'info')?.count).toBe(1);
  });

  it('keeps an unknown severity rather than dropping it', () => {
    const rows = preflightSeverityTally({ severity_counts: { error: 1, hint: 4 } });
    expect(rows.find((r) => r.severity === 'hint')?.count).toBe(4);
  });

  it('reports zeros when there is no lint verdict at all', () => {
    expect(preflightSeverityTally(null).every((r) => r.count === 0)).toBe(true);
  });
});

describe('preflightThresholdComparison', () => {
  it('compares the score against the policy threshold', () => {
    const comparison = preflightThresholdComparison(
      report({
        lint: { score: 64, grade: 'C' },
        policy: { verdict: 'block', blocking: true, source: 'tenant', reason: 'r', threshold_score: 70 },
      }),
    );
    expect(comparison).toEqual({ score: 64, threshold: 70, delta: -6, meets: false });
  });

  it('is null when either side is unknown', () => {
    expect(preflightThresholdComparison(report())).toBeNull();
    expect(preflightThresholdComparison(report({ lint: null }))).toBeNull();
    expect(preflightThresholdComparison(null)).toBeNull();
  });
});

describe('locateFindingLine', () => {
  const SOURCE = ['openapi: 3.1.0', 'paths:', '  /pets:', '    get:', '      summary: List'].join('\n');

  it('walks a JSON pointer to the deepest segment it can find', () => {
    expect(locateFindingLine('/paths/~1pets/get', SOURCE)).toBe(4);
  });

  it('handles dotted canonical paths', () => {
    expect(locateFindingLine('paths./pets', SOURCE)).toBe(3);
  });

  it('returns null when the path is empty, the source is empty, or nothing matches', () => {
    expect(locateFindingLine('', SOURCE)).toBeNull();
    expect(locateFindingLine('/paths', '')).toBeNull();
    expect(locateFindingLine('/components/schemas/Widget', 'type Query { hello: String }')).toBeNull();
  });

  it('never walks backwards — a later segment only matches at or after the previous one', () => {
    const source = 'get:\npaths:\n  /pets:\n    get:';
    expect(locateFindingLine('/paths/~1pets/get', source)).toBe(4);
  });
});

describe('computeWindowedRange', () => {
  it('mounts only the visible rows plus overscan', () => {
    const range = computeWindowedRange({
      rowCount: 1000,
      rowHeight: 50,
      viewportHeight: 500,
      scrollTop: 5000,
      overscan: 2,
    });
    expect(range.startIndex).toBe(98);
    expect(range.endIndex).toBe(112);
    expect(range.paddingTop).toBe(4900);
    expect(range.paddingBottom).toBe((1000 - 112) * 50);
  });

  it('mounts everything when the viewport cannot be measured (jsdom reports 0)', () => {
    const range = computeWindowedRange({
      rowCount: 120,
      rowHeight: 50,
      viewportHeight: 0,
      scrollTop: 0,
    });
    expect(range).toEqual({ startIndex: 0, endIndex: 120, paddingTop: 0, paddingBottom: 0 });
  });

  it('is empty for an empty list and clamps a negative scroll offset', () => {
    expect(computeWindowedRange({ rowCount: 0, rowHeight: 50, viewportHeight: 500, scrollTop: 0 }))
      .toEqual({ startIndex: 0, endIndex: 0, paddingTop: 0, paddingBottom: 0 });
    expect(
      computeWindowedRange({ rowCount: 10, rowHeight: 50, viewportHeight: 500, scrollTop: -200 })
        .startIndex,
    ).toBe(0);
  });

  it('clamps roving focus to the list bounds', () => {
    expect(clampRowIndex(-1, 5)).toBe(0);
    expect(clampRowIndex(9, 5)).toBe(4);
    expect(clampRowIndex(2, 5)).toBe(2);
    expect(clampRowIndex(0, 0)).toBeNull();
  });
});

describe('fetchImportPreflight', () => {
  afterEach(() => jest.restoreAllMocks());

  it('posts the candidate and returns the parsed report', async () => {
    const body = report();
    const fetchMock = jest.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, ...body }) }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchImportPreflight({ document_base64: 'eA==', source_kind: 'graphql' });
    expect(result.ok).toBe(true);
    expect(result.lint?.grade).toBe('B');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/import/preflight');
    expect(JSON.parse(String(init.body))).toMatchObject({ source_kind: 'graphql' });
  });

  it('returns an ok:false verdict normally — it is an answer, not a failure', async () => {
    const body = report({ ok: false, lint: null });
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, ...body }) }),
    ) as unknown as typeof fetch;
    await expect(fetchImportPreflight({ document_base64: 'eA==' })).resolves.toMatchObject({
      ok: false,
    });
  });

  it('throws the proxy error message on a transport failure', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: false, json: () => Promise.resolve({ success: false, error: 'No tenant selected' }) }),
    ) as unknown as typeof fetch;
    await expect(fetchImportPreflight({ document_base64: 'eA==' })).rejects.toThrow(
      'No tenant selected',
    );
  });

  it('throws when the body is not a report', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) }),
    ) as unknown as typeof fetch;
    await expect(fetchImportPreflight({ document_base64: 'eA==' })).rejects.toThrow(
      'The pre-flight report was incomplete.',
    );
  });
});

describe('import quality waivers and preferences', () => {
  beforeEach(() => window.localStorage.clear());

  it('captures the overridden verdict on the waiver record', () => {
    const waiver = buildImportQualityWaiver(
      report({
        lint: { score: 41, grade: 'F', report_fingerprint: 'fp-9' },
        policy: {
          verdict: 'block',
          blocking: true,
          source: 'tenant',
          reason: 'Score 41 is below the required 70.',
          threshold_score: 70,
        },
      }),
      'vendor.graphql',
      '  vendor spec we do not control  ',
      '2026-07-25T12:00:00.000Z',
    );
    expect(waiver).toMatchObject({
      recordedAt: '2026-07-25T12:00:00.000Z',
      label: 'vendor.graphql',
      contentHash: 'sha-1',
      reportFingerprint: 'fp-9',
      score: 41,
      grade: 'F',
      policyVerdict: 'block',
      thresholdScore: 70,
      justification: 'vendor spec we do not control',
    });
  });

  it('records an empty justification as absent rather than blank', () => {
    const waiver = buildImportQualityWaiver(report(), 'a.graphql', '   ', '2026-07-25T12:00:00.000Z');
    expect(waiver.justification).toBeNull();
  });

  it('persists waivers newest first and caps the local history', () => {
    for (let i = 0; i < IMPORT_QUALITY_WAIVER_LIMIT + 5; i++) {
      cacheImportQualityWaiverLocally(
        buildImportQualityWaiver(report(), `file-${i}`, null, '2026-07-25T12:00:00.000Z'),
      );
    }
    const stored = readImportQualityWaivers();
    expect(stored).toHaveLength(IMPORT_QUALITY_WAIVER_LIMIT);
    expect(stored[0].label).toBe(`file-${IMPORT_QUALITY_WAIVER_LIMIT + 4}`);
  });

  it('round-trips the skip preference and defaults to off', () => {
    expect(readImportQualityPreferences().skipQualityStep).toBe(false);
    persistImportQualityPreferences({ skipQualityStep: true });
    expect(readImportQualityPreferences().skipQualityStep).toBe(true);
  });

  it('falls back to defaults when stored preferences are corrupt', () => {
    window.localStorage.setItem('apiome.import-quality.v1', 'not json');
    expect(readImportQualityPreferences().skipQualityStep).toBe(false);
  });
});


describe('recording a waiver in the tenant ledger (IXH-2.3, #5098)', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const blockingReport = () =>
    report({
      lint: { score: 41, grade: 'F', report_fingerprint: 'fp-9' },
      policy: {
        verdict: 'block',
        blocking: true,
        source: 'tenant',
        reason: 'Grade F is below the required B.',
        threshold_score: null,
        min_grade: 'B',
        enforcement: 'block',
        override_roles: ['owner'],
        failures: [{ kind: 'grade', required: 'B', actual: 'F' }],
      },
    });

  it('projects the record onto the grant request the API expects', () => {
    const waiver = buildImportQualityWaiver(
      blockingReport(),
      'vendor.graphql',
      'vendor spec',
      '2026-07-25T12:00:00.000Z',
    );
    expect(buildImportQualityWaiverRequest(waiver, 'graphql')).toEqual({
      scope: 'import',
      subjectKey: 'sha-1',
      subjectLabel: 'vendor.graphql',
      formatKey: 'graphql',
      reportFingerprint: 'fp-9',
      score: 41,
      grade: 'F',
      reason: 'vendor spec',
    });
  });

  it('refuses to build a request without a content hash to match on', () => {
    const waiver = buildImportQualityWaiver(
      report({ cache: undefined }),
      'a.graphql',
      'why',
      '2026-07-25T12:00:00.000Z',
    );
    expect(buildImportQualityWaiverRequest(waiver, 'graphql')).toBeNull();
  });

  it('posts the waiver to the ledger and reports the server record', async () => {
    const fetchMock = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            data: { id: 'w-1', expiresAt: '2026-08-01T00:00:00Z' },
          }),
      }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const waiver = buildImportQualityWaiver(
      blockingReport(),
      'vendor.graphql',
      'vendor spec',
      '2026-07-25T12:00:00.000Z',
    );
    const outcome = await recordImportQualityWaiver(waiver, 'graphql');

    expect(outcome).toEqual({ recorded: true, id: 'w-1', expiresAt: '2026-08-01T00:00:00Z' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/quality-policy/waivers');
    expect(JSON.parse(String(init.body))).toMatchObject({ subjectKey: 'sha-1', reason: 'vendor spec' });
    // The local copy is kept as a fallback record either way.
    expect(readImportQualityWaivers()).toHaveLength(1);
  });

  it('reports the server refusal rather than pretending the waiver exists', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: false,
        json: () =>
          Promise.resolve({ success: false, error: 'Your role (editor) may not waive this policy' }),
      }),
    ) as unknown as typeof fetch;

    const outcome = await recordImportQualityWaiver(
      buildImportQualityWaiver(blockingReport(), 'v.graphql', 'why', '2026-07-25T12:00:00.000Z'),
      'graphql',
    );
    expect(outcome.recorded).toBe(false);
    expect(outcome.error).toContain('may not waive');
  });

  it('reports an unreachable ledger without throwing', async () => {
    global.fetch = jest.fn(() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    const outcome = await recordImportQualityWaiver(
      buildImportQualityWaiver(blockingReport(), 'v.graphql', 'why', '2026-07-25T12:00:00.000Z'),
      'graphql',
    );
    expect(outcome.recorded).toBe(false);
    expect(outcome.error).toBe('The waiver ledger could not be reached.');
  });
});
