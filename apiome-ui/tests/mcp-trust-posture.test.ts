/**
 * Unit tests for MCP trust-posture helpers (CLX-3.2, #4856).
 *
 * The central assertions are the two honesty guarantees: a finding is always labelled a signal
 * (never proven, and never a bare severity), and skipped rules / uncovered OWASP risks are
 * preserved so coverage gaps stay visible.
 */

import {
  exploitabilityLabel,
  groupFindingsByOwasp,
  hasProvenFindings,
  originChipClass,
  parsePostureReport,
  severityChipClass,
} from '@/app/utils/mcp-trust-posture';
import { STATUS_TONE_SOFT_CLASS } from '@/app/components/ui/statusVocabulary';

const REPORT = {
  success: true,
  endpointId: 'ep',
  versionId: 'v',
  profile: 'mcp-trust-posture',
  owaspRevision: '2025',
  score: 40,
  grade: 'F',
  findings: [
    {
      id: 'f1',
      path: 'tools.read_file',
      rule: 'metadata.hidden-instruction',
      severity: 'error',
      message: 'hidden instruction',
      origin: 'metadata',
      origin_label: 'Advertised metadata',
      owasp_ids: ['MCP01', 'MCP02'],
      exploitability: 'static_signal',
      exploitability_label: 'Signal — not proven exploitable',
      confidence: 'high',
    },
    {
      id: 'f2',
      path: 'Dockerfile:2',
      rule: 'source.remote-script-execution',
      severity: 'error',
      message: 'curl | sh',
      origin: 'source',
      origin_label: 'Linked source',
      owasp_ids: ['MCP04'],
      exploitability: 'static_signal',
      exploitability_label: 'Signal — not proven exploitable',
      confidence: 'medium',
    },
  ],
  severity_counts: { error: 2, warning: 0, info: 0 },
  origin_counts: { metadata: 1, source: 1 },
  owasp_counts: { MCP01: 1, MCP02: 1, MCP04: 1 },
  owasp_coverage: { covered: ['MCP01', 'MCP02', 'MCP04'], uncovered: ['MCP05', 'MCP10'] },
  report_fingerprint: 'fp',
  evaluated_rules: ['metadata.hidden-instruction', 'source.remote-script-execution'],
  skipped_rules: ['dependency.known-vulnerability'],
  skip_reasons: { 'dependency.known-vulnerability': 'Vulnerability lookup did not run.' },
  proven_count: 0,
  gate: { passed: false, fail_on: 'error', min_score: null, require_full_coverage: false, reasons: ['2 error'] },
};

describe('parsePostureReport', () => {
  it('normalizes snake_case wire fields and preserves honesty fields', () => {
    const report = parsePostureReport(REPORT)!;
    expect(report).not.toBeNull();
    expect(report.score).toBe(40);
    expect(report.provenCount).toBe(0);
    expect(report.skippedRules).toEqual(['dependency.known-vulnerability']);
    expect(report.skipReasons['dependency.known-vulnerability']).toContain('did not run');
    expect(report.owaspCoverage.uncovered).toEqual(['MCP05', 'MCP10']);
    const first = report.findings[0];
    expect(first.owaspIds).toEqual(['MCP01', 'MCP02']);
    expect(first.exploitability).toBe('static_signal');
    expect(first.confidence).toBe('high');
  });

  it('returns null for a failed / malformed payload', () => {
    expect(parsePostureReport({ success: false })).toBeNull();
    expect(parsePostureReport(null)).toBeNull();
  });

  it('never leaves a finding without an exploitability label', () => {
    const report = parsePostureReport({
      ...REPORT,
      findings: [{ id: 'x', path: 'p', rule: 'r', severity: 'info', message: 'm', exploitability: 'static_signal' }],
    })!;
    // Even when the server omits the label, the client fills in the honest one.
    expect(report.findings[0].exploitabilityLabel).toBe('Signal — not proven exploitable');
  });
});

describe('exploitabilityLabel', () => {
  it('labels a static signal explicitly as not proven', () => {
    expect(exploitabilityLabel('static_signal')).toBe('Signal — not proven exploitable');
    expect(exploitabilityLabel('static_signal')).not.toBe('error');
  });

  it('only says proven for the proven state', () => {
    expect(exploitabilityLabel('proven')).toContain('Proven');
  });
});

describe('groupFindingsByOwasp', () => {
  it('places a finding under each of its risks, sorted by risk id', () => {
    const report = parsePostureReport(REPORT)!;
    const groups = groupFindingsByOwasp(report.findings);
    const ids = groups.map((g) => g.riskId);
    expect(ids).toEqual(['MCP01', 'MCP02', 'MCP04']);
    // The metadata finding maps to two risks, so it appears under both.
    expect(groups.find((g) => g.riskId === 'MCP01')!.findings).toHaveLength(1);
  });
});

describe('hasProvenFindings', () => {
  it('is false today (no probe exists)', () => {
    expect(hasProvenFindings(parsePostureReport(REPORT)!)).toBe(false);
  });
});

describe('chip class helpers', () => {
  /**
   * Since HIVE-7.8 (#5325) the chips resolve through `ui/statusVocabulary` instead of naming a
   * palette pair, so a posture `error` is the same red as a lint MUST and as a failed discovery
   * job. `mcp-dark-theme-tokens.test.ts` holds the stronger no-palette-literal property over all
   * nine themes; what this pins is that the helpers are the vocabulary's classes and nothing else.
   */
  it('returns the shared soft pair for every severity', () => {
    expect(severityChipClass('error')).toBe(STATUS_TONE_SOFT_CLASS.danger);
    expect(severityChipClass('warning')).toBe(STATUS_TONE_SOFT_CLASS.warn);
    expect(severityChipClass('info')).toBe(STATUS_TONE_SOFT_CLASS.accent);
  });

  it('gives each evidence lane its own tone', () => {
    expect(originChipClass('source')).toBe(STATUS_TONE_SOFT_CLASS.violet);
    expect(originChipClass('dependency')).toBe(STATUS_TONE_SOFT_CLASS.ok);
    expect(originChipClass('protocol')).toBe(STATUS_TONE_SOFT_CLASS.accent);
    expect(originChipClass('metadata')).toBe(STATUS_TONE_SOFT_CLASS.neutral);
  });

  it('treats an unrecognized lane as metadata rather than inventing a tone', () => {
    expect(originChipClass('something-new')).toBe(STATUS_TONE_SOFT_CLASS.neutral);
  });
});
