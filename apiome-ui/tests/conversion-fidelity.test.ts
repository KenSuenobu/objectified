/**
 * Tests for the catalog → OpenAPI conversion fidelity helpers (MFI-22.4, #4005).
 *
 * These cover the pure presentation/partition helpers and the dry-run / commit fetch wrappers
 * (mocked `fetch`). The score/grade/tier are never recomputed here — they are the server's verdict;
 * these helpers only route the report into the two preview columns and scale the warning.
 */
import {
  cleanDefaults,
  commitConversion,
  coverageTone,
  coverageLabel,
  fetchConversionDryRun,
  normalizeServers,
  partitionChecklist,
  tierWarning,
  CONVERSION_WARNING_SENTENCE,
  type ChecklistItem,
} from '../src/app/utils/conversion-fidelity';

function item(key: string, coverage: ChecklistItem['coverage']): ChecklistItem {
  return { key, title: key, coverage, weight: 1, count: 1, examples: [], reason: 'because' };
}

describe('partitionChecklist', () => {
  it('routes present/inferred to provided and missing/partial/n-a to missing', () => {
    const items = [
      item('a', 'present'),
      item('b', 'inferred'),
      item('c', 'missing'),
      item('d', 'partial'),
      item('e', 'n/a'),
    ];
    const { provided, missing } = partitionChecklist(items);
    expect(provided.map((i) => i.key)).toEqual(['a', 'b']);
    expect(missing.map((i) => i.key)).toEqual(['c', 'd', 'e']);
  });

  it('handles an empty checklist', () => {
    expect(partitionChecklist([])).toEqual({ provided: [], missing: [] });
  });
});

describe('tierWarning', () => {
  it('gates only the low tier behind an acknowledgement', () => {
    expect(tierWarning('low').requiresAck).toBe(true);
    expect(tierWarning('medium').requiresAck).toBe(false);
    expect(tierWarning('high').requiresAck).toBe(false);
  });

  it('scales severity by tier', () => {
    expect(tierWarning('low').severity).toBe('critical');
    expect(tierWarning('medium').severity).toBe('warning');
    expect(tierWarning('high').severity).toBe('info');
  });

  it('always carries the mandatory warning sentence', () => {
    for (const tier of ['low', 'medium', 'high'] as const) {
      expect(tierWarning(tier).body).toContain(CONVERSION_WARNING_SENTENCE);
    }
  });
});

describe('coverage presentation', () => {
  // HIVE-7.1 (#5318): a coverage tag resolves to a *tone* from the shared status vocabulary,
  // not to a hand-written class triple, so the badge follows all nine themes.
  it('maps every coverage tag to a status tone', () => {
    expect(coverageTone('present')).toBe('ok');
    expect(coverageTone('inferred')).toBe('accent');
    expect(coverageTone('partial')).toBe('warn');
    expect(coverageTone('missing')).toBe('danger');
    expect(coverageTone('n/a')).toBe('neutral');
  });

  it('falls back to neutral for an unknown tag, rather than borrowing another tag colour', () => {
    expect(coverageTone('bogus')).toBe('neutral');
  });

  it('labels n/a as having no OpenAPI form', () => {
    expect(coverageLabel('n/a')).toBe('no OpenAPI form');
    expect(coverageLabel('present')).toBe('from source');
  });
});

describe('normalizeServers / cleanDefaults', () => {
  it('trims and drops blank server entries', () => {
    expect(normalizeServers(['  https://a  ', '', '   ', 'https://b'])).toEqual([
      'https://a',
      'https://b',
    ]);
    expect(normalizeServers(undefined)).toEqual([]);
  });

  it('strips empty default fields so a commit only carries supplied values', () => {
    expect(cleanDefaults({ title: '  ', version: '1.0.0', servers: ['', ' '] })).toEqual({
      version: '1.0.0',
    });
    expect(cleanDefaults({ title: 'Acme', servers: ['https://a'] })).toEqual({
      title: 'Acme',
      servers: ['https://a'],
    });
  });
});

describe('fetchConversionDryRun', () => {
  afterEach(() => jest.restoreAllMocks());

  it('POSTs to the convert proxy with dryRun=true and returns the report', async () => {
    const result = { report: { score: 90, grade: 'A', tier: 'high', items: [], losses: [], coverage_counts: {}, penalty: 10 } };
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: true, json: () => Promise.resolve({ success: true, ...result }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    const r = await fetchConversionDryRun('cat-1');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/catalog/cat-1/convert?dryRun=true',
      expect.objectContaining({ method: 'POST' })
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body).toMatchObject({ target: 'openapi', dryRun: true });
    expect(r.report.grade).toBe('A');
  });

  it('throws the server message on failure', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ success: false, detail: 'No revision to convert' }),
    }) as unknown as typeof fetch;
    await expect(fetchConversionDryRun('cat-1')).rejects.toThrow('No revision to convert');
  });
});

describe('commitConversion', () => {
  afterEach(() => jest.restoreAllMocks());

  it('POSTs dryRun=false and flows cleaned defaults into the body', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue({ ok: true, json: () => Promise.resolve({ success: true, projectId: 'p1' }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    const r = await commitConversion('cat-1', {
      defaults: { title: 'Acme', version: '', servers: ['https://a', ''] },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/catalog/cat-1/convert',
      expect.objectContaining({ method: 'POST' })
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body).toMatchObject({ dryRun: false, defaults: { title: 'Acme', servers: ['https://a'] } });
    expect(body.defaults.version).toBeUndefined();
    expect(r.projectId).toBe('p1');
  });
});
