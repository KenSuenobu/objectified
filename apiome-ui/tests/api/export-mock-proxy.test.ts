/**
 * Contract tests for the export test-drive mock proxy routes (MFX-44.5, #4371).
 *
 * The Studio's mock panel reaches the REST spine through five thin proxies under
 * `src/app/api/export/mock/`. Rather than stand up the full NextAuth + fetch stack, this pins the
 * source-level contract the panel depends on: each route exists with the verbs it should have,
 * authenticates and tenant-scopes through the shared helper, targets the right REST upstream, and
 * returns the `{ success, ... }` envelope the hook reads.
 *
 * The try-it bridge gets more than a source read: its path resolver is the one place a
 * browser-supplied string becomes a URL the server calls, so it lives in its own dependency-free
 * module (`lib/export-mock-request-url.ts`) and is exercised directly against the traversal and
 * origin-injection shapes it has to neutralize.
 */

import * as fs from 'fs';
import * as path from 'path';

import { resolveMockRequestUrl } from '../../lib/export-mock-request-url';

const API_ROOT = path.resolve(__dirname, '..', '..', 'src', 'app', 'api', 'export', 'mock');

const routeFile = (...segments: string[]) => path.join(API_ROOT, ...segments, 'route.ts');
const read = (...segments: string[]) => fs.readFileSync(routeFile(...segments), 'utf8');

describe('capability proxy (GET /api/export/mock/capability)', () => {
  const src = read('capability');

  it('exists and exports only a GET handler', () => {
    expect(fs.existsSync(routeFile('capability'))).toBe(true);
    expect(src).toMatch(/export\s+async\s+function\s+GET/);
    expect(src).not.toMatch(/export\s+async\s+function\s+(POST|PUT|DELETE)/);
  });

  it('authenticates and tenant-scopes via the shared proxy helper', () => {
    expect(src).toContain('getAuthenticatedTenantContext');
    expect(src).toContain('proxyRestGet');
  });

  it('targets the REST /export/{tenantSlug}/mock/capability upstream', () => {
    expect(src).toMatch(/\/export\/\$\{encodeURIComponent\(ctx\.tenantSlug\)\}\/mock\/capability/);
  });

  it('returns the { success, ... } envelope the hook consumes', () => {
    expect(src).toMatch(/success:\s*true/);
    expect(src).toMatch(/success:\s*false/);
  });
});

describe('provision + list proxy (/api/export/mock)', () => {
  const src = read();

  it('exports POST (start) and GET (list) and nothing else', () => {
    expect(src).toMatch(/export\s+async\s+function\s+POST/);
    expect(src).toMatch(/export\s+async\s+function\s+GET/);
    expect(src).not.toMatch(/export\s+async\s+function\s+(PUT|DELETE|PATCH)/);
  });

  it('authenticates and tenant-scopes both verbs via the shared proxy helper', () => {
    expect(src).toContain('getAuthenticatedTenantContext');
    expect(src).toContain('proxyRestPost');
    expect(src).toContain('proxyRestGet');
  });

  it('targets the REST /export/{tenantSlug}/mock upstream', () => {
    expect(src).toMatch(/\/export\/\$\{encodeURIComponent\(ctx\.tenantSlug\)\}\/mock`/);
  });

  it('rejects a missing request body with a 400', () => {
    expect(src).toMatch(/Missing request body/);
    expect(src).toMatch(/status:\s*400/);
  });

  it('forwards the request body verbatim rather than assembling one', () => {
    // The mock is provisioned from a server-side re-emit, so this proxy has nothing to construct:
    // it passes the caller's coordinates through. A route that built a payload here would be the
    // place an emitted document could start riding along.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).toMatch(/proxyRestPost\(\s*ctx\.user,\s*`[^`]+`,\s*body,\s*\)/);
    expect(code).not.toMatch(/document/i);
  });
});

describe('instance proxy (/api/export/mock/{mockId})', () => {
  const src = read('[mockId]');

  it('exports GET (poll) and DELETE (stop)', () => {
    expect(src).toMatch(/export\s+async\s+function\s+GET/);
    expect(src).toMatch(/export\s+async\s+function\s+DELETE/);
  });

  it('encodes the mock id into the upstream path', () => {
    expect(src).toMatch(
      /\/export\/\$\{encodeURIComponent\(ctx\.tenantSlug\)\}\/mock\/\$\{encodeURIComponent\(mockId\)\}/,
    );
  });

  it('uses the shared delete helper rather than a hand-rolled fetch', () => {
    expect(src).toContain('proxyRestDelete');
  });
});

describe('request-log proxy (/api/export/mock/{mockId}/requests)', () => {
  const src = read('[mockId]', 'requests');

  it('exists and exports only a GET handler', () => {
    expect(src).toMatch(/export\s+async\s+function\s+GET/);
    expect(src).not.toMatch(/export\s+async\s+function\s+(POST|PUT|DELETE)/);
  });

  it('clamps the page size rather than forwarding whatever the query string says', () => {
    expect(src).toContain('MAX_LIMIT');
    expect(src).toMatch(/Math\.min\(/);
  });

  it('targets the REST request-log upstream', () => {
    expect(src).toMatch(/\/mock\/\$\{encodeURIComponent\(mockId\)\}\/requests\?limit=/);
  });
});

describe('try-it bridge (/api/export/mock/{mockId}/try)', () => {
  const src = read('[mockId]', 'try');

  it('exists and exports only a POST handler', () => {
    expect(src).toMatch(/export\s+async\s+function\s+POST/);
    expect(src).not.toMatch(/export\s+async\s+function\s+(GET|PUT|DELETE)/);
  });

  it('proves ownership through the authenticated export surface before forwarding', () => {
    // Without this the bridge would be an unauthenticated reach into any tenant's mock.
    expect(src).toContain('proxyRestGet');
    expect(src).toMatch(
      /\/export\/\$\{encodeURIComponent\(ctx\.tenantSlug\)\}\/mock\/\$\{encodeURIComponent\(mockId\)\}/,
    );
  });

  it('accepts only the methods the mock data plane routes', () => {
    expect(src).toContain('ALLOWED_METHODS');
    expect(src).toMatch(/Unsupported method/);
  });

  it('bounds the forwarded call and the echoed body', () => {
    expect(src).toContain('TRY_TIMEOUT_MS');
    expect(src).toContain('MAX_BODY_CHARS');
  });
});

describe('the try-it path resolver', () => {
  const BASE = 'https://rest.example.test/v1';

  it('places a plain operation path under the instance prefix', () => {
    const url = resolveMockRequestUrl(BASE, 'mock-1', '/widgets/42');
    expect(url.pathname).toBe('/v1/mock/mock-1/widgets/42');
    expect(url.origin).toBe('https://rest.example.test');
  });

  it('keeps the query string', () => {
    expect(resolveMockRequestUrl(BASE, 'mock-1', '/widgets?limit=2').search).toBe('?limit=2');
  });

  it('normalizes traversal instead of escaping the instance prefix', () => {
    const url = resolveMockRequestUrl(BASE, 'mock-1', '/../../v1/schema/secret');
    expect(url.pathname).toBe('/v1/mock/mock-1/v1/schema/secret');
    expect(url.pathname).not.toContain('..');
    expect(url.origin).toBe('https://rest.example.test');
  });

  it('cannot be pointed at another origin by a protocol-relative or absolute path', () => {
    expect(resolveMockRequestUrl(BASE, 'mock-1', '//evil.example.com/steal').origin).toBe(
      'https://rest.example.test',
    );
    expect(resolveMockRequestUrl(BASE, 'mock-1', 'https://evil.example.com/steal').origin).toBe(
      'https://rest.example.test',
    );
    expect(resolveMockRequestUrl(BASE, 'mock-1', 'https://evil.example.com/steal').pathname).toBe(
      '/v1/mock/mock-1/steal',
    );
  });

  it('encodes the mock id it was handed', () => {
    expect(resolveMockRequestUrl(BASE, 'a b', '/x').pathname).toContain('a%20b');
  });

  it('addresses the instance root for an empty path', () => {
    expect(resolveMockRequestUrl(BASE, 'mock-1', '').pathname).toBe('/v1/mock/mock-1');
    expect(resolveMockRequestUrl(BASE, 'mock-1', '/').pathname).toBe('/v1/mock/mock-1');
  });

  it('tolerates a base URL with a trailing slash', () => {
    expect(resolveMockRequestUrl(`${BASE}/`, 'mock-1', '/widgets').pathname).toBe(
      '/v1/mock/mock-1/widgets',
    );
  });
});
