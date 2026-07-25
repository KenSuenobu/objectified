/**
 * Contract test for the export preview-manifest proxy route (IXH-4.1, #5109).
 *
 * The Export Studio's structural artifact explorer reaches the REST spine through a thin
 * proxy at `src/app/api/export/preview-manifest/route.ts`, cloned from the export preview
 * proxy. Rather than stand up the full NextAuth + fetch stack, this asserts the
 * source-level contract the feature depends on: the route exists, is POST-only,
 * authenticates + tenant-scopes via the shared helper, targets the REST
 * `/export/{tenantSlug}/preview-manifest` upstream, and returns the `{ success, ... }`
 * envelope the `useExportPreviewManifest` hook expects.
 */

import * as fs from 'fs';
import * as path from 'path';

const MANIFEST_ROUTE = path.resolve(
  __dirname,
  '..',
  '..',
  'src',
  'app',
  'api',
  'export',
  'preview-manifest',
  'route.ts',
);

const src = fs.readFileSync(MANIFEST_ROUTE, 'utf8');

describe('export preview-manifest proxy (POST /api/export/preview-manifest)', () => {
  it('exists and exports only a POST handler (the manifest request carries a body)', () => {
    expect(fs.existsSync(MANIFEST_ROUTE)).toBe(true);
    expect(src).toMatch(/export\s+async\s+function\s+POST/);
    expect(src).not.toMatch(/export\s+async\s+function\s+(GET|PUT|DELETE)/);
  });

  it('authenticates and tenant-scopes via the shared proxy helper', () => {
    expect(src).toContain('getAuthenticatedTenantContext');
    expect(src).toContain('proxyRestPost');
  });

  it('targets the REST /export/{tenantSlug}/preview-manifest upstream (IXH-4.1)', () => {
    expect(src).toMatch(/\/export\/\$\{ctx\.tenantSlug\}\/preview-manifest/);
  });

  it('returns the { success, ... } envelope the manifest hook consumes', () => {
    expect(src).toMatch(/success:\s*true/);
    expect(src).toMatch(/success:\s*false/);
  });

  it('rejects a missing request body with a 400', () => {
    expect(src).toMatch(/Missing request body/);
    expect(src).toMatch(/status:\s*400/);
  });
});
