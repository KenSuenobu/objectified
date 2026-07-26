/**
 * Contract test for the catalog import list/submit proxy (IXH-6.3 + MFI-23.7).
 */

import * as fs from 'fs';
import * as path from 'path';

const routePath = path.resolve(
  __dirname,
  '..',
  '..',
  'src',
  'app',
  'api',
  'catalog',
  'import',
  'route.ts',
);
const route = fs.readFileSync(routePath, 'utf8');

describe('catalog import list/submit proxy (GET+POST /api/catalog/import)', () => {
  it('exports GET (paginated list) and POST (submit) handlers', () => {
    expect(route).toMatch(/export\s+async\s+function\s+GET/);
    expect(route).toMatch(/export\s+async\s+function\s+POST/);
  });

  it('authenticates and targets the REST tenants/…/imports upstream', () => {
    expect(route).toContain('getAuthenticatedTenantContext');
    expect(route).toContain('proxyRestGet');
    expect(route).toContain('proxyRestPost');
    expect(route).toMatch(/\/tenants\/\$\{encodeURIComponent\(ctx\.tenantSlug\)\}\/imports/);
  });

  it('forwards pagination and filter query params on GET', () => {
    expect(route).toContain('forwardListQuery');
    expect(route).toContain('limit');
    expect(route).toContain('offset');
    expect(route).toContain('state');
  });
});
