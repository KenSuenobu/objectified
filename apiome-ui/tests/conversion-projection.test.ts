/**
 * Conversion projection wire contract (CPDO-3.1, #4801).
 *
 * Covers `src/app/utils/conversion-projection.ts`:
 *  1. Page integrity — an edge referencing an unbundled node, an unknown status/scope, or a
 *     non-retained edge without a reason refuses the page.
 *  2. The fetch helper — request body shape (target, cleaned defaults, cursor, limit),
 *     success envelope, and the three failure paths (HTTP error, `success:false`,
 *     unparseable body).
 */

import { afterEach, describe, expect, it, jest } from '@jest/globals';

import {
  CONVERSION_PROJECTION_PAGE_LIMIT,
  conversionEvidencePageIssues,
  fetchConversionProjection,
  type ConversionEvidencePage,
  type ConversionProjectionEdge,
  type ConversionProjectionNode,
} from '../src/app/utils/conversion-projection';

function node(id: string): ConversionProjectionNode {
  return { id, kind: 'source', label: id, construct_key: null, source: null, target: null };
}

function edge(overrides: Partial<ConversionProjectionEdge> = {}): ConversionProjectionEdge {
  return {
    id: 'checklist:info',
    scope: 'checklist',
    source: 'source:checklist:info',
    target: null,
    status: 'dropped',
    reason: 'destination_unsupported',
    severity: 'info',
    detail: 'detail',
    remediation: 'fix it',
    evidence: [],
    count: 1,
    ...overrides,
  };
}

function page(overrides: Partial<ConversionEvidencePage> = {}): ConversionEvidencePage {
  return {
    manifest_hash: 'a'.repeat(64),
    edges: [edge()],
    nodes: [node('source:checklist:info')],
    next_cursor: null,
    total: 1,
    ...overrides,
  };
}

describe('conversionEvidencePageIssues', () => {
  it('accepts a coherent page', () => {
    expect(conversionEvidencePageIssues(page())).toEqual([]);
  });

  it('refuses an edge whose source or target node is not bundled', () => {
    const missingSource = conversionEvidencePageIssues(page({ nodes: [] }));
    expect(missingSource.some((issue) => issue.includes('source node'))).toBe(true);
    const missingTarget = conversionEvidencePageIssues(
      page({ edges: [edge({ target: 'target:/info' })] }),
    );
    expect(missingTarget.some((issue) => issue.includes('target node'))).toBe(true);
  });

  it('refuses unknown statuses and scopes', () => {
    const badStatus = conversionEvidencePageIssues(
      page({ edges: [edge({ status: 'exploded' as ConversionProjectionEdge['status'] })] }),
    );
    expect(badStatus.some((issue) => issue.includes('unknown status'))).toBe(true);
    const badScope = conversionEvidencePageIssues(
      page({ edges: [edge({ scope: 'mystery' as ConversionProjectionEdge['scope'] })] }),
    );
    expect(badScope.some((issue) => issue.includes('unknown scope'))).toBe(true);
  });

  it('refuses a non-retained edge without a reason code', () => {
    const issues = conversionEvidencePageIssues(page({ edges: [edge({ reason: null })] }));
    expect(issues.some((issue) => issue.includes('no reason code'))).toBe(true);
  });

  it('accepts a retained edge without a reason', () => {
    const issues = conversionEvidencePageIssues(
      page({ edges: [edge({ status: 'retained', reason: null, remediation: null })] }),
    );
    expect(issues).toEqual([]);
  });
});

describe('fetchConversionProjection', () => {
  const okBody = {
    success: true,
    itemId: 'item-1',
    versionRecordId: 'v1',
    target: 'openapi',
    summary: { manifest_hash: 'a'.repeat(64) },
    page: page(),
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function mockFetch(response: { ok: boolean; status?: number; body: unknown }) {
    const fn = jest.fn(async () => ({
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 500),
      json: async () => response.body,
    })) as unknown as typeof fetch;
    global.fetch = fn;
    return fn as unknown as jest.Mock;
  }

  it('POSTs the proxy with target, cleaned defaults, cursor, and limit', async () => {
    const fetchMock = mockFetch({ ok: true, body: okBody });
    await fetchConversionProjection('item 1', {
      defaults: { title: '  Padded  ', version: '', servers: [' https://a ', ''] },
      cursor: 'MQ==',
      limit: 25,
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/catalog/item%201/projection');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      target: 'openapi',
      defaults: { title: 'Padded', servers: ['https://a'] },
      cursor: 'MQ==',
      limit: 25,
    });
  });

  it('defaults the page limit and omits empty defaults', async () => {
    const fetchMock = mockFetch({ ok: true, body: okBody });
    await fetchConversionProjection('item-1', { defaults: { title: '  ' } });
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(body.defaults).toBeUndefined();
    expect(body.limit).toBe(CONVERSION_PROJECTION_PAGE_LIMIT);
    expect(body.cursor).toBeUndefined();
  });

  it('returns the deserialized envelope on success', async () => {
    mockFetch({ ok: true, body: okBody });
    const result = await fetchConversionProjection('item-1');
    expect(result.itemId).toBe('item-1');
    expect(result.page.total).toBe(1);
  });

  it('throws the server message on HTTP failure and success:false', async () => {
    mockFetch({ ok: false, status: 404, body: { success: false, error: 'Catalog item not found' } });
    await expect(fetchConversionProjection('missing')).rejects.toThrow('Catalog item not found');

    mockFetch({ ok: true, body: { success: false, detail: 'nope' } });
    await expect(fetchConversionProjection('item-1')).rejects.toThrow('nope');
  });

  it('throws a fallback message when the body is unparseable', async () => {
    const fn = jest.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error('bad json');
      },
    })) as unknown as typeof fetch;
    global.fetch = fn;
    await expect(fetchConversionProjection('item-1')).rejects.toThrow(
      'Failed to load the projection graph (HTTP 502)',
    );
  });
});
