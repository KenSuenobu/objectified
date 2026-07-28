/**
 * Contract tests for the verification-policy proxy (ECA-3.1, #4734).
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
  'verification-policy',
  '[[...path]]',
  'route.ts',
);

const src = fs.existsSync(ROUTE) ? fs.readFileSync(ROUTE, 'utf8') : '';

describe('verification-policy proxy route file', () => {
  it('exists as an optional catch-all', () => {
    expect(fs.existsSync(ROUTE)).toBe(true);
  });

  it('exports GET, PUT, and POST', () => {
    expect(src).toMatch(/export\s+async\s+function\s+GET/);
    expect(src).toMatch(/export\s+async\s+function\s+PUT/);
    expect(src).toMatch(/export\s+async\s+function\s+POST/);
  });
});

describe('session and tenant gating', () => {
  it('requires a session and a selected tenant', () => {
    expect(src).toContain('getAuthSession');
    expect(src).toMatch(/Unauthorized/);
    expect(src).toMatch(/No tenant selected/);
  });

  it('resolves the tenant slug server-side', () => {
    expect(src).toContain('getTenantById');
    expect(src).toContain('current_tenant_id');
  });

  it('mints a short-lived signed JWT', () => {
    expect(src).toContain('getJwtSigningSecret');
    expect(src).toMatch(/algorithm:\s*'HS256'/);
  });
});

describe('upstream URL shape', () => {
  it('targets governance/verification-policy', () => {
    expect(src).toContain('verification-policy');
    expect(src).toMatch(
      /\$\{REST_API_BASE_URL\}\/tenants\/\$\{encodeURIComponent\(ctx\.tenantSlug\)\}\/governance\/\$\{restPath\(segments\)\}/,
    );
  });

  it('encodes path segments', () => {
    expect(src).toContain('encodeURIComponent');
  });

  it('forwards the query string', () => {
    expect(src).toContain('request.nextUrl.search');
  });
});
