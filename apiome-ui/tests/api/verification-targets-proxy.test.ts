/**
 * Contract tests for the verification-target registry proxy (ECA-1.2, #4730).
 *
 * The registry screen reaches the REST spine through one catch-all proxy under
 * `src/app/api/verification-targets`. Rather than stand up the full NextAuth + fetch stack, these
 * tests assert the source-level contract the feature depends on: the route exists, resolves the
 * tenant slug server-side (so the browser cannot pick a tenant), builds the correct upstream URL
 * shape including the `audit` sibling rewrite, encodes path segments, exports exactly the verbs the
 * REST surface offers, and preserves the stable refusal `code` instead of flattening it into prose.
 *
 * If the proxy is deleted or its upstream path drifts from the REST
 * `/v1/tenants/{slug}/verification-targets` contract, this goes red.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROUTE = path.resolve(
  __dirname,
  '..',
  '..',
  'src',
  'app',
  'api',
  'verification-targets',
  '[[...path]]',
  'route.ts',
);

const src = fs.existsSync(ROUTE) ? fs.readFileSync(ROUTE, 'utf8') : '';

describe('verification-target proxy route file', () => {
  it('exists as an optional catch-all so the collection and its members share one proxy', () => {
    expect(fs.existsSync(ROUTE)).toBe(true);
  });

  it('exports exactly the verbs the REST registry offers', () => {
    expect(src).toMatch(/export\s+async\s+function\s+GET/);
    expect(src).toMatch(/export\s+async\s+function\s+POST/);
    expect(src).toMatch(/export\s+async\s+function\s+PATCH/);
    expect(src).toMatch(/export\s+async\s+function\s+DELETE/);
    // PUT is not part of the surface — an update is a partial patch.
    expect(src).not.toMatch(/export\s+async\s+function\s+PUT/);
  });
});

describe('session and tenant gating', () => {
  it('requires a session and a selected tenant', () => {
    expect(src).toContain('getAuthSession');
    expect(src).toMatch(/Unauthorized/);
    expect(src).toMatch(/No tenant selected/);
  });

  it('resolves the tenant slug server-side from the session, never from the request', () => {
    expect(src).toContain('getTenantById');
    expect(src).toContain('current_tenant_id');
  });

  it('mints a short-lived signed JWT for the REST call', () => {
    expect(src).toContain('getJwtSigningSecret');
    expect(src).toMatch(/algorithm:\s*'HS256'/);
    expect(src).toMatch(/expiresIn:\s*'1h'/);
  });
});

describe('upstream URL shape', () => {
  it('targets the tenant-scoped verification-targets collection', () => {
    expect(src).toMatch(
      /\$\{REST_API_BASE_URL\}\/tenants\/\$\{tenantSlug\}\/verification-targets\$\{suffix\}/,
    );
  });

  it('rewrites the audit sub-path onto the REST sibling resource', () => {
    // REST keeps the ledger on `verification-targets-audit` so `audit` can never be mistaken for
    // a target named "audit"; the proxy is where that rewrite lives.
    expect(src).toMatch(
      /\$\{REST_API_BASE_URL\}\/tenants\/\$\{tenantSlug\}\/verification-targets-audit/,
    );
    expect(src).toContain("segments[0] === 'audit'");
  });

  it('encodes every path segment so a slug cannot inject a path', () => {
    expect(src).toContain('segments.map(encodeURIComponent)');
  });

  it('forwards the query string (audit filters and include_deleted)', () => {
    expect(src).toContain('request.nextUrl.search');
  });

  it('never caches a registry read', () => {
    expect(src).toMatch(/cache:\s*'no-store'/);
  });
});

describe('response translation', () => {
  it('passes a 204 retire through with no body', () => {
    expect(src).toContain('response.status === 204');
  });

  it('preserves the stable refusal code alongside the human-readable message', () => {
    expect(src).toContain("typeof detail.code === 'string'");
    expect(src).toMatch(/success:\s*false,\s*error:\s*errorMessage/);
  });

  it('returns the { success, data } envelope on success', () => {
    expect(src).toMatch(/success:\s*true,\s*data/);
  });

  it('shapes a transport failure as a 500 rather than throwing', () => {
    expect(src).toMatch(/status:\s*500/);
  });
});
