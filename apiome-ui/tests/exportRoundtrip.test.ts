/**
 * exportRoundtrip — pure model for the round-trip comparison panel (IXH-4.4, #5112).
 *
 * Pins the ticket's acceptance criteria that live in pure logic:
 *
 *  - verdict presentation states the meaning in words + glyph, never colour alone;
 *  - the summary line reports the grouping (explained / unexplained / over-claims);
 *  - the one-click issue report carries the reproduction coordinates — target, adapter,
 *    artifact/revision ids, options, fingerprints, versions — while stripping
 *    credential-shaped option keys and never including source content;
 *  - an over-long issue body is clipped so the prefilled GitHub URL keeps working.
 */

import {
  buildRoundtripIssueReport,
  changeKindBadgeClass,
  changeKindLabel,
  diffEntryLabel,
  ISSUE_BODY_MAX_LENGTH,
  ROUNDTRIP_ISSUE_BASE,
  roundtripStatusPresentation,
  summarizeRoundtrip,
  type ExportRoundtripResponse,
  type RoundtripDiffEntry,
} from '../src/app/components/ade/dashboard/export/exportRoundtrip';
import type { LossItem } from '../src/app/components/ade/dashboard/export/exportFidelityPreview';

function entry(overrides: Partial<RoundtripDiffEntry> = {}): RoundtripDiffEntry {
  return { entity: 'type', key: 'User', change: 'removed', ...overrides };
}

function finding(overrides: Partial<LossItem> = {}): LossItem {
  return {
    construct: 'User',
    kind: 'drop',
    severity: 'warn',
    message: 'target cannot carry User',
    target_mapping: null,
    ...overrides,
  };
}

function response(overrides: Partial<ExportRoundtripResponse> = {}): ExportRoundtripResponse {
  return {
    artifact: 'proj-1',
    version: '1.0.0',
    version_record_id: 'rev-1',
    version_label: '1.0.0',
    target: 'openapi-3.1',
    emit_key: 'openapi',
    adapter_key: 'openapi',
    status: 'pass',
    reason: null,
    diff_count: 0,
    matched_count: 0,
    matched: [],
    unexplained: [],
    overclaims: [],
    loss_drop: 0,
    loss_approx: 0,
    loss_synth: 0,
    loss_ok: 4,
    source_fingerprint: 'aaaa1111bbbb2222',
    reimported_fingerprint: 'aaaa1111bbbb2222',
    emitter_version: '1.0',
    apiome_version: '1.107.0',
    registry_version: '1',
    ...overrides,
  };
}

describe('roundtripStatusPresentation', () => {
  it('presents an identical round trip as verified, in words and a glyph', () => {
    const p = roundtripStatusPresentation(response());
    expect(p.label).toBe('Round trip verified');
    expect(p.sentence).toMatch(/identical canonical model/);
    expect(p.glyph).toBe('✓');
  });

  it('presents an explained-differences pass distinctly from an identical one', () => {
    const p = roundtripStatusPresentation(
      response({ diff_count: 2, matched_count: 2, matched: [{ entry: entry(), finding: finding() }] }),
    );
    expect(p.label).toBe('Round trip verified');
    expect(p.sentence).toMatch(/explained by the fidelity report/);
  });

  it('presents an unsupported comparison as skipped, with the server reason verbatim', () => {
    const p = roundtripStatusPresentation(
      response({
        status: 'unsupported',
        adapter_key: null,
        reason: "No import adapter can re-import emit format 'sample-noop' (emit key 'sample').",
      }),
    );
    expect(p.label).toBe('Comparison skipped');
    expect(p.sentence).toContain('No import adapter can re-import');
  });

  it('presents a failing comparison as a fidelity bug, never by colour alone', () => {
    const p = roundtripStatusPresentation(
      response({ status: 'fail', diff_count: 1, unexplained: [entry()] }),
    );
    expect(p.label).toMatch(/incomplete/i);
    expect(p.sentence).toMatch(/fidelity bug/);
    expect(p.glyph).toBe('✗');
  });
});

describe('diff entry presentation', () => {
  it('labels every change kind in words', () => {
    expect(changeKindLabel('added')).toBe('Added');
    expect(changeKindLabel('removed')).toBe('Removed');
    expect(changeKindLabel('changed')).toBe('Changed');
  });

  it('gives each change kind a distinct badge class', () => {
    const classes = new Set(
      (['added', 'removed', 'changed'] as const).map((kind) => changeKindBadgeClass(kind)),
    );
    expect(classes.size).toBe(3);
  });

  it('names the artifact root instead of printing an empty key', () => {
    expect(diffEntryLabel(entry({ entity: 'root', key: '' }))).toBe('artifact root');
    expect(diffEntryLabel(entry())).toBe('type User');
  });
});

describe('summarizeRoundtrip', () => {
  it('states identity when nothing differed', () => {
    expect(summarizeRoundtrip(response())).toMatch(/identical to the source/);
  });

  it('reports the grouping counts', () => {
    const summary = summarizeRoundtrip(
      response({
        status: 'fail',
        diff_count: 4,
        matched_count: 2,
        matched: [
          { entry: entry(), finding: finding() },
          { entry: entry({ key: 'Org' }), finding: finding({ construct: 'Org' }) },
        ],
        unexplained: [entry({ key: 'Contact' })],
        overclaims: [finding({ kind: 'ok', construct: 'Status' })],
      }),
    );
    expect(summary).toContain('4 differences');
    expect(summary).toContain('2 explained by the fidelity report');
    expect(summary).toContain('1 unexplained');
    expect(summary).toContain('1 over-claim');
  });

  it('states the skip for an unsupported comparison', () => {
    expect(summarizeRoundtrip(response({ status: 'unsupported' }))).toBe('Comparison skipped.');
  });
});

describe('buildRoundtripIssueReport', () => {
  const failing = response({
    status: 'fail',
    diff_count: 2,
    matched_count: 0,
    unexplained: [entry(), entry({ entity: 'operation', key: 'GET /users/{id}', change: 'changed' })],
    overclaims: [finding({ kind: 'ok', construct: 'Status' })],
    reason: "unexplained: removed type 'User'",
    reimported_fingerprint: 'cccc3333dddd4444',
  });

  it('carries the reproduction coordinates without any source content', () => {
    const report = buildRoundtripIssueReport({ response: failing, targetLabel: 'OpenAPI 3.1' });
    expect(report.title).toContain('2 differences unexplained');
    expect(report.body).toContain('`openapi-3.1`');
    expect(report.body).toContain('Artifact id: `proj-1`');
    expect(report.body).toContain('Revision: `rev-1` (version 1.0.0)');
    expect(report.body).toContain('Source fingerprint: `aaaa1111bbbb2222`');
    expect(report.body).toContain('Re-imported fingerprint: `cccc3333dddd4444`');
    expect(report.body).toContain('apiome-rest `1.107.0`');
    expect(report.body).toContain('Removed type User');
    expect(report.body).toContain('Changed operation GET /users/{id}');
    expect(report.body).toContain('`Status` was reported preserved');
    expect(report.body).toContain('No source content is included');
    expect(report.url.startsWith(`${ROUNDTRIP_ISSUE_BASE}?title=`)).toBe(true);
    expect(report.url).toContain(encodeURIComponent('Round-trip fidelity gap'));
  });

  it('includes non-default options but strips and names credential-shaped keys', () => {
    const report = buildRoundtripIssueReport({
      response: failing,
      targetLabel: 'OpenAPI 3.1',
      options: { package: 'com.example', api_token: 'hunter2' },
    });
    expect(report.body).toContain('"package":"com.example"');
    expect(report.body).not.toContain('hunter2');
    expect(report.redactedOptionKeys).toEqual(['api_token']);
    expect(report.body).toContain('withheld credential-shaped keys: api_token');
    expect(report.url).not.toContain(encodeURIComponent('hunter2'));
  });

  it('states target defaults when no options were overridden', () => {
    const report = buildRoundtripIssueReport({ response: failing, targetLabel: 'OpenAPI 3.1' });
    expect(report.body).toContain('Options: target defaults');
  });

  it('titles an over-claims-only failure by its over-claims', () => {
    const report = buildRoundtripIssueReport({
      response: response({
        status: 'fail',
        unexplained: [],
        overclaims: [finding({ kind: 'ok', construct: 'Status' })],
      }),
      targetLabel: 'OpenAPI 3.1',
    });
    expect(report.title).toContain('1 over-claim');
  });

  it('clips an over-long body so the prefilled URL keeps working', () => {
    const many = Array.from({ length: 400 }, (_, i) =>
      entry({ key: `Very.Long.Construct.Path.Number.${i}` }),
    );
    const report = buildRoundtripIssueReport({
      response: failing && response({ status: 'fail', diff_count: many.length, unexplained: many }),
      targetLabel: 'OpenAPI 3.1',
    });
    expect(report.body.length).toBeLessThanOrEqual(ISSUE_BODY_MAX_LENGTH + 200);
    expect(report.body).toContain('clipped');
  });
});
