/**
 * Pure logic tests for the saved-suite client utilities (IXH-5.7, #5119):
 * reference building, verdict display helpers, the badge count, the export/import envelope
 * pair, and unique payload naming.
 */

import {
  countRegressedSuites,
  nextPayloadName,
  parseSuiteEnvelope,
  serializeSuiteEnvelope,
  suiteRefForSurface,
  verdictDiffLabel,
  verdictTone,
  type SuiteExportEnvelope,
} from '../src/app/utils/schema-test-suites';

describe('suiteRefForSurface', () => {
  it('builds the stable, version-independent reference', () => {
    expect(suiteRefForSurface('catalog', 'legacy-soap')).toBe('catalog/legacy-soap');
    expect(suiteRefForSurface('project', 'petstore')).toBe('project/petstore');
  });
});

describe('verdict display helpers', () => {
  it('shows the diff only when a baseline verdict exists and differs', () => {
    expect(verdictDiffLabel({ status: 'failed', previous_status: 'passed' })).toBe(
      'passed → failed'
    );
    expect(verdictDiffLabel({ status: 'passed', previous_status: 'passed' })).toBe('passed');
    expect(verdictDiffLabel({ status: 'error', previous_status: null })).toBe('error');
  });

  it('assigns distinct tones per verdict', () => {
    const tones = new Set([verdictTone('passed'), verdictTone('failed'), verdictTone('error')]);
    expect(tones.size).toBe(3);
  });

  it('reads its tones from the shared vocabulary rather than naming a colour', () => {
    // HIVE-6.3 (#5314): the helper used to return Tailwind palette pairs. A tone name is what
    // `Badge` takes, and it is what keeps this chip the same green as every other "it worked".
    expect(verdictTone('passed')).toBe('ok');
    expect(verdictTone('completed')).toBe('ok');
    expect(verdictTone('failed')).toBe('rose');
    expect(verdictTone('error')).toBe('danger');
  });
});

describe('countRegressedSuites', () => {
  it('counts only suites whose newest run flags a regression', () => {
    expect(
      countRegressedSuites([
        { latest_run: { regression: true } as never },
        { latest_run: { regression: false } as never },
        { latest_run: null },
        {},
      ])
    ).toBe(1);
  });
});

describe('the envelope round trip', () => {
  const envelope: SuiteExportEnvelope = {
    manifest: {
      manifest_version: 1,
      directories: {},
      entries: [{ path: 'json-schema/test-bench/p.json', features: ['instance-payload'] }],
    },
    files: [{ path: 'json-schema/test-bench/p.json', content: '{"a": 1}' }],
  };

  it('serializes to exactly the shape parse accepts back', () => {
    const parsed = parseSuiteEnvelope(serializeSuiteEnvelope(envelope));
    expect('envelope' in parsed && parsed.envelope).toEqual(envelope);
  });

  it('names what is wrong with a broken document', () => {
    expect(parseSuiteEnvelope('not json')).toEqual({ error: 'The file is not valid JSON.' });
    expect(parseSuiteEnvelope('42')).toEqual({
      error: 'The file must hold a JSON object with `manifest` and `files`.',
    });
    const noEntries = parseSuiteEnvelope(JSON.stringify({ manifest: {}, files: [] }));
    expect('error' in noEntries && noEntries.error).toMatch(/entries/);
    const badFiles = parseSuiteEnvelope(
      JSON.stringify({ manifest: { entries: [] }, files: [{ path: 1 }] })
    );
    expect('error' in badFiles && badFiles.error).toMatch(/path, content/);
  });
});

describe('nextPayloadName', () => {
  it('numbers past the taken names', () => {
    expect(nextPayloadName([])).toBe('payload 1');
    expect(nextPayloadName([{ name: 'payload 1' }, { name: 'other' }])).toBe('payload 3');
    expect(nextPayloadName([{ name: 'payload 2' }])).toBe('payload 3');
  });
});
