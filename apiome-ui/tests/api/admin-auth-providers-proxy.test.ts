/**
 * Admin auth-provider config proxy (OLO-8.7, #4973).
 *
 * Behavioral tests for the server-side forwarders (`lib/auth/admin-provider-config-proxy.ts`) —
 * upstream URL/headers, verbatim status/body passthrough, transport-failure shaping, and the
 * OLO-8.5 cache invalidation on successful writes — plus source-level contract checks on the
 * Next.js route files (session gate, handlers exported), following the catalog-proxy pattern.
 */
import * as fs from 'fs';
import * as path from 'path';

jest.mock('../../lib/auth/provider-config-resolver', () => ({
  invalidateProviderConfigCache: jest.fn(),
}));

import {
  proxyDeleteAuthProvider,
  proxyListAuthProviders,
  proxyUpdateAuthProvider,
} from '../../lib/auth/admin-provider-config-proxy';
import { invalidateProviderConfigCache } from '../../lib/auth/provider-config-resolver';

const TOKEN = 'payload.signature';

/** Build a minimal fetch-response stand-in for the pieces the proxy reads. */
function fakeResponse(status: number, body: unknown, jsonFails = false) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: jsonFails
      ? () => Promise.reject(new Error('not json'))
      : () => Promise.resolve(body),
  } as unknown as Response;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('proxyListAuthProviders', () => {
  it('targets the REST admin surface with the session header and passes the body through', async () => {
    const upstream = { providers: [{ provider_id: 'github', secret_set: false }] };
    const fetchImpl = jest.fn().mockResolvedValue(fakeResponse(200, upstream));

    const result = await proxyListAuthProviders(TOKEN, fetchImpl as unknown as typeof fetch);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://localhost:8000/v1/admin/auth-providers');
    expect(init.method).toBe('GET');
    expect(init.cache).toBe('no-store');
    expect(init.headers['X-Admin-Session']).toBe(TOKEN);
    expect(result).toEqual({ status: 200, body: upstream });
  });

  it('relays upstream auth failures verbatim (401/403 stay distinguishable)', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(fakeResponse(403, { detail: 'Invalid or expired super-admin session.' }));

    const result = await proxyListAuthProviders(TOKEN, fetchImpl as unknown as typeof fetch);
    expect(result.status).toBe(403);
    expect(result.body).toEqual({ detail: 'Invalid or expired super-admin session.' });
  });

  it('shapes a network failure into a structured 502 instead of throwing', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await proxyListAuthProviders(TOKEN, fetchImpl as unknown as typeof fetch);
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ error: 'rest_unreachable' });
  });

  it('shapes a non-JSON upstream reply into a structured 502', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(fakeResponse(500, null, true));

    const result = await proxyListAuthProviders(TOKEN, fetchImpl as unknown as typeof fetch);
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ error: 'invalid_upstream_response' });
  });
});

describe('proxyUpdateAuthProvider', () => {
  it('PUTs the payload to the provider path and invalidates the resolver cache on success', async () => {
    const view = { provider_id: 'github', client_id: 'new-id', secret_set: true };
    const fetchImpl = jest.fn().mockResolvedValue(fakeResponse(200, view));

    const result = await proxyUpdateAuthProvider(
      TOKEN,
      'github',
      { client_id: 'new-id' },
      fetchImpl as unknown as typeof fetch
    );

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://localhost:8000/v1/admin/auth-providers/github');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ client_id: 'new-id' });
    expect(init.headers['X-Admin-Session']).toBe(TOKEN);
    expect(result).toEqual({ status: 200, body: view });
    expect(invalidateProviderConfigCache).toHaveBeenCalledTimes(1);
  });

  it('serializes an explicit null (clear-to-env) instead of dropping it', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(fakeResponse(200, {}));

    await proxyUpdateAuthProvider(
      TOKEN,
      'gitlab',
      { enabled: null, client_secret: null },
      fetchImpl as unknown as typeof fetch
    );

    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      enabled: null,
      client_secret: null,
    });
  });

  it('does NOT invalidate the cache when the write is rejected (e.g. structured 422)', async () => {
    const detail = {
      error: 'provider_incomplete',
      provider_id: 'github',
      missing_fields: ['client_secret'],
      message: 'Cannot enable github: missing client_secret.',
    };
    const fetchImpl = jest.fn().mockResolvedValue(fakeResponse(422, { detail }));

    const result = await proxyUpdateAuthProvider(
      TOKEN,
      'github',
      { enabled: true },
      fetchImpl as unknown as typeof fetch
    );

    expect(result.status).toBe(422);
    expect(result.body).toEqual({ detail });
    expect(invalidateProviderConfigCache).not.toHaveBeenCalled();
  });

  it('URL-encodes the provider id so a hostile slug cannot change the upstream path', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(fakeResponse(404, { detail: 'unknown' }));

    await proxyUpdateAuthProvider(
      TOKEN,
      '../internal/auth-providers/resolved',
      {},
      fetchImpl as unknown as typeof fetch
    );

    const [url] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      'http://localhost:8000/v1/admin/auth-providers/..%2Finternal%2Fauth-providers%2Fresolved'
    );
    expect(invalidateProviderConfigCache).not.toHaveBeenCalled();
  });

  it('does not invalidate the cache on transport failure', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('timeout'));

    const result = await proxyUpdateAuthProvider(
      TOKEN,
      'github',
      { enabled: false },
      fetchImpl as unknown as typeof fetch
    );

    expect(result.status).toBe(502);
    expect(invalidateProviderConfigCache).not.toHaveBeenCalled();
  });
});

describe('proxyDeleteAuthProvider', () => {
  it('DELETEs the provider path with no body and invalidates the resolver cache on success', async () => {
    const postDeleteView = { provider_id: 'github', client_id: null, secret_set: false };
    const fetchImpl = jest.fn().mockResolvedValue(fakeResponse(200, postDeleteView));

    const result = await proxyDeleteAuthProvider(
      TOKEN,
      'github',
      fetchImpl as unknown as typeof fetch
    );

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://localhost:8000/v1/admin/auth-providers/github');
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
    expect(init.headers['X-Admin-Session']).toBe(TOKEN);
    expect(result).toEqual({ status: 200, body: postDeleteView });
    // Sign-in must stop using the deleted config on the very next login, not after the TTL.
    expect(invalidateProviderConfigCache).toHaveBeenCalledTimes(1);
  });

  it('does NOT invalidate the cache when the removal is rejected (e.g. unknown provider 404)', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(fakeResponse(404, { detail: "Unknown auth provider: 'nope'." }));

    const result = await proxyDeleteAuthProvider(
      TOKEN,
      'nope',
      fetchImpl as unknown as typeof fetch
    );

    expect(result.status).toBe(404);
    expect(invalidateProviderConfigCache).not.toHaveBeenCalled();
  });

  it('relays an upstream auth failure verbatim and leaves the cache alone', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(fakeResponse(403, { detail: 'Invalid or expired super-admin session.' }));

    const result = await proxyDeleteAuthProvider(
      TOKEN,
      'github',
      fetchImpl as unknown as typeof fetch
    );

    expect(result.status).toBe(403);
    expect(result.body).toEqual({ detail: 'Invalid or expired super-admin session.' });
    expect(invalidateProviderConfigCache).not.toHaveBeenCalled();
  });

  it('URL-encodes the provider id so a hostile slug cannot change the upstream path', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(fakeResponse(404, { detail: 'unknown' }));

    await proxyDeleteAuthProvider(
      TOKEN,
      '../internal/auth-providers/resolved',
      fetchImpl as unknown as typeof fetch
    );

    expect(fetchImpl.mock.calls[0][0]).toBe(
      'http://localhost:8000/v1/admin/auth-providers/..%2Finternal%2Fauth-providers%2Fresolved'
    );
    expect(invalidateProviderConfigCache).not.toHaveBeenCalled();
  });

  it('shapes a transport failure into a structured 502 without invalidating the cache', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await proxyDeleteAuthProvider(
      TOKEN,
      'github',
      fetchImpl as unknown as typeof fetch
    );

    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ error: 'rest_unreachable' });
    expect(invalidateProviderConfigCache).not.toHaveBeenCalled();
  });
});

describe('proxy route files (source contract)', () => {
  const API_ROOT = path.resolve(
    __dirname,
    '..',
    '..',
    'src',
    'app',
    'api',
    'admin',
    'auth-providers'
  );
  const LIST_ROUTE = path.join(API_ROOT, 'route.ts');
  const UPDATE_ROUTE = path.join(API_ROOT, '[providerId]', 'route.ts');

  it('has a list route and a provider-update route', () => {
    expect(fs.existsSync(LIST_ROUTE)).toBe(true);
    expect(fs.existsSync(UPDATE_ROUTE)).toBe(true);
  });

  it('list route exports GET only and gates on the verified admin session', () => {
    const src = fs.readFileSync(LIST_ROUTE, 'utf8');
    expect(src).toMatch(/export\s+async\s+function\s+GET/);
    expect(src).not.toMatch(/export\s+async\s+function\s+(POST|PUT|DELETE)/);
    expect(src).toContain("cookieStore.get('admin_session')");
    expect(src).toContain('verifyAdminSessionToken');
    expect(src).toContain('401');
    expect(src).toContain('403');
    expect(src).toContain('proxyListAuthProviders');
  });

  it('update route exports PUT and DELETE only, gates on the session, and rejects non-object bodies', () => {
    const src = fs.readFileSync(UPDATE_ROUTE, 'utf8');
    expect(src).toMatch(/export\s+async\s+function\s+PUT/);
    expect(src).toMatch(/export\s+async\s+function\s+DELETE/);
    expect(src).not.toMatch(/export\s+async\s+function\s+(GET|POST)/);
    expect(src).toContain("cookieStore.get('admin_session')");
    expect(src).toContain('verifyAdminSessionToken');
    expect(src).toContain('proxyUpdateAuthProvider');
    expect(src).toContain('proxyDeleteAuthProvider');
    expect(src).toContain("error: 'invalid_body'");
  });

  it('the DELETE handler is gated on the session exactly like PUT (401 then 403)', () => {
    const src = fs.readFileSync(UPDATE_ROUTE, 'utf8');
    // The removal handler must carry its own gate — not inherit one — so isolate its body and
    // assert the checks are inside it.
    const deleteBody = src.slice(src.search(/export\s+async\s+function\s+DELETE/));
    expect(deleteBody).toContain("cookieStore.get('admin_session')");
    expect(deleteBody).toContain('verifyAdminSessionToken');
    expect(deleteBody).toContain('401');
    expect(deleteBody).toContain('403');
    expect(deleteBody).toContain('proxyDeleteAuthProvider');
  });
});
