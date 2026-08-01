/**
 * @jest-environment node
 *
 * `/api/repositories/catalog` proxy behaviour (REPO-6.4, #2797).
 *
 * Runs under the node environment rather than the project-wide jsdom default: `next/server`
 * needs the WHATWG `Request`/`Response` globals, which jsdom does not provide.
 *
 * The cross-repo spec catalog page reaches REST through this one handler, so it is the only
 * place the tenant is decided. These tests drive the real handler with the session, tenant
 * lookup and upstream `fetch` mocked, and assert what actually matters: the browser cannot
 * choose a tenant, unknown query parameters are dropped rather than forwarded, and every REST
 * failure mode becomes a shaped error the page can render.
 */

import { describe, test, expect, jest, beforeEach } from '@jest/globals';

// `@lib/*` is mapped before the project-wide `server-session` mock rule, so the session has to
// be stubbed explicitly here rather than relying on `tests/__mocks__/server-session.ts`.
jest.mock('@lib/auth/server-session', () => ({
  getAuthSession: jest.fn(),
}));

jest.mock('@lib/db/helper', () => ({
  getTenantById: jest.fn(),
}));

jest.mock('@lib/rest-auth', () => ({
  createRestAuthHeaders: jest.fn(() => ({
    'Content-Type': 'application/json',
    Authorization: 'Bearer test-token',
  })),
  REST_API_BASE_URL: 'http://rest.test/v1',
}));

import { NextRequest } from 'next/server';
import { getAuthSession } from '@lib/auth/server-session';
import { getTenantById } from '@lib/db/helper';
import { GET } from '@/app/api/repositories/catalog/route';

const mockSession = getAuthSession as unknown as jest.Mock;
const mockTenant = getTenantById as unknown as jest.Mock;

const USER = {
  user_id: '660e8400-e29b-41d4-a716-446655440001',
  email: 'op@example.com',
  name: 'Op',
  current_tenant_id: '550e8400-e29b-41d4-a716-446655440000',
};

const CATALOG_PAYLOAD = {
  success: true,
  catalog_total: 120,
  match_count: 2,
  limit: 50,
  offset: 0,
  sort: 'repository',
  specs: [{ id: 'file-1', path: 'services/orders/openapi.yaml' }],
  facets: null,
};

/** Build a request against the catalog route with the given query string. */
function request(query = ''): NextRequest {
  return new NextRequest(`http://localhost/api/repositories/catalog${query}`);
}

/** Stub the upstream REST call and return the mock so the URL can be asserted. */
function mockRest(status: number, body: unknown): jest.Mock {
  const fetchMock = jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }));
  (globalThis as { fetch?: unknown }).fetch = fetchMock;
  return fetchMock;
}

/** The URL the handler asked REST for. */
function upstreamUrl(fetchMock: jest.Mock): URL {
  return new URL((fetchMock.mock.calls[0] as unknown[])[0] as string);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSession.mockResolvedValue({ user: USER });
  mockTenant.mockResolvedValue({ slug: 'acme' });
});

describe('authentication and tenant gating', () => {
  test('an unauthenticated caller gets a 401 and no upstream call', async () => {
    mockSession.mockResolvedValue(null);
    const fetchMock = mockRest(200, CATALOG_PAYLOAD);

    const res = await GET(request());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ success: false, error: 'Unauthorized' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('a session with no tenant selected is a 400, not an empty catalog', async () => {
    mockSession.mockResolvedValue({ user: { ...USER, current_tenant_id: undefined } });
    const fetchMock = mockRest(200, CATALOG_PAYLOAD);

    const res = await GET(request());

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('No tenant selected');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('the tenant slug is resolved server-side from the session', async () => {
    const fetchMock = mockRest(200, CATALOG_PAYLOAD);

    await GET(request('?tenant_slug=someone-else'));

    expect(mockTenant).toHaveBeenCalledWith(USER.current_tenant_id);
    const url = upstreamUrl(fetchMock);
    expect(url.pathname).toBe('/v1/tenants/acme/repository-files');
    expect(url.searchParams.has('tenant_slug')).toBe(false);
  });

  test('an unresolvable tenant is a 400 rather than a request with an empty slug', async () => {
    mockTenant.mockResolvedValue(null);
    const fetchMock = mockRest(200, CATALOG_PAYLOAD);

    const res = await GET(request());

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Tenant not found');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('query parameter forwarding', () => {
  test('every catalog filter reaches REST', async () => {
    const fetchMock = mockRest(200, CATALOG_PAYLOAD);

    await GET(
      request(
        '?q=orders&format=openapi&repository_id=repo-1&project_id=proj-1&status=imported' +
          '&importable_only=false&all_branches=true&sort=recent&limit=25&offset=50' +
          '&include_facets=true'
      )
    );

    const params = upstreamUrl(fetchMock).searchParams;
    expect(params.get('q')).toBe('orders');
    expect(params.get('format')).toBe('openapi');
    expect(params.get('repository_id')).toBe('repo-1');
    expect(params.get('project_id')).toBe('proj-1');
    expect(params.get('status')).toBe('imported');
    expect(params.get('importable_only')).toBe('false');
    expect(params.get('all_branches')).toBe('true');
    expect(params.get('sort')).toBe('recent');
    expect(params.get('limit')).toBe('25');
    expect(params.get('offset')).toBe('50');
    expect(params.get('include_facets')).toBe('true');
  });

  test('a parameter outside the allowlist is dropped', async () => {
    const fetchMock = mockRest(200, CATALOG_PAYLOAD);

    await GET(request('?q=orders&tenant_id=evil&sql=drop'));

    const params = upstreamUrl(fetchMock).searchParams;
    expect(params.get('q')).toBe('orders');
    expect(params.has('tenant_id')).toBe(false);
    expect(params.has('sql')).toBe(false);
  });

  test('an empty parameter is omitted rather than sent as a blank filter', async () => {
    const fetchMock = mockRest(200, CATALOG_PAYLOAD);

    await GET(request('?q=&format='));

    expect(upstreamUrl(fetchMock).search).toBe('');
  });

  test('a search term is URL-encoded on the way upstream', async () => {
    const fetchMock = mockRest(200, CATALOG_PAYLOAD);

    await GET(request(`?q=${encodeURIComponent('orders & billing')}`));

    expect(upstreamUrl(fetchMock).searchParams.get('q')).toBe('orders & billing');
  });
});

describe('responses', () => {
  test('a successful catalog page is passed through untouched', async () => {
    mockRest(200, CATALOG_PAYLOAD);

    const res = await GET(request());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(CATALOG_PAYLOAD);
  });

  test("REST's refusal detail is surfaced with its own status", async () => {
    mockRest(400, { detail: "unknown format 'raml'" });

    const res = await GET(request('?format=raml'));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("unknown format 'raml'");
  });

  test('a 403 from REST is not flattened into a generic failure', async () => {
    mockRest(403, { detail: 'Permission denied: imports:view is required' });

    const res = await GET(request());

    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('imports:view');
  });

  test('a 200 whose body is not a catalog page is treated as an error', async () => {
    mockRest(200, { unexpected: true });

    const res = await GET(request());

    expect(res.status).toBe(502);
    expect((await res.json()).success).toBe(false);
  });

  test('an unparseable body does not throw', async () => {
    mockRest(500, '<html>gateway</html>');

    const res = await GET(request());

    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain('Spec catalog API error');
  });

  test('an unreachable REST spine reports 503 rather than crashing the page', async () => {
    (globalThis as { fetch?: unknown }).fetch = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    });

    const res = await GET(request());

    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain('apiome-rest not reachable');
  });
});
