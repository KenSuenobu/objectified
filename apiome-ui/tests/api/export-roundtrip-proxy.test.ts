/**
 * Contract test for the export round-trip proxy route (IXH-4.4, #5112).
 *
 * The Export Studio's round-trip comparison reaches the REST spine through a thin proxy at
 * `src/app/api/export/roundtrip/route.ts`, cloned from the preview-manifest proxy. Rather
 * than stand up the full NextAuth + fetch stack, this asserts the source-level contract the
 * feature depends on: the route exists, is POST-only, authenticates + tenant-scopes via the
 * shared helper, targets the REST `/export/{tenantSlug}/roundtrip` upstream, and returns
 * the `{ success, ... }` envelope the `useExportRoundtrip` hook expects.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROUNDTRIP_ROUTE = path.resolve(
  __dirname,
  '..',
  '..',
  'src',
  'app',
  'api',
  'export',
  'roundtrip',
  'route.ts',
);

const src = fs.readFileSync(ROUNDTRIP_ROUTE, 'utf8');

describe('export round-trip proxy (POST /api/export/roundtrip)', () => {
  it('exists and exports only a POST handler (the run request carries a body)', () => {
    expect(fs.existsSync(ROUNDTRIP_ROUTE)).toBe(true);
    expect(src).toMatch(/export\s+async\s+function\s+POST/);
    expect(src).not.toMatch(/export\s+async\s+function\s+(GET|PUT|DELETE)/);
  });

  it('authenticates and tenant-scopes via the shared proxy helper', () => {
    expect(src).toContain('getAuthenticatedTenantContext');
    expect(src).toContain('proxyRestPost');
  });

  it('targets the REST /export/{tenantSlug}/roundtrip upstream (IXH-4.4)', () => {
    expect(src).toMatch(/\/export\/\$\{ctx\.tenantSlug\}\/roundtrip/);
  });

  it('returns the { success, ... } envelope the round-trip hook consumes', () => {
    expect(src).toMatch(/success:\s*true/);
    expect(src).toMatch(/success:\s*false/);
  });

  it('rejects a missing request body with a 400', () => {
    expect(src).toMatch(/Missing request body/);
    expect(src).toMatch(/status:\s*400/);
  });
});
