/**
 * Contract test for the catalog payload-analysis proxy route (CPDO-2.1, #4797).
 *
 * The Format details tab reaches the REST spine through a thin proxy at
 * `src/app/api/catalog/[itemId]/analysis/route.ts`. `next/server` cannot be imported under this
 * suite's jsdom environment (it needs a global `Request`), so — exactly as the sibling catalog and
 * export proxy suites do — this asserts the source-level contract the feature depends on.
 *
 * The load-bearing assertion is the **status passthrough**. The upstream endpoint is gated on
 * `imports:view`, and the pane renders a 403 as a permission boundary rather than as "there is no
 * analysis". A proxy that flattened the upstream status into a 200 with an empty body, or into a
 * generic 500, would silently turn a refusal back into the untrue absence CPDO-2.4 spent a whole
 * ticket removing from the catalog.
 */

import * as fs from 'fs';
import * as path from 'path';

const ANALYSIS_ROUTE = path.resolve(
  __dirname,
  '..',
  '..',
  'src',
  'app',
  'api',
  'catalog',
  '[itemId]',
  'analysis',
  'route.ts',
);

const src = fs.readFileSync(ANALYSIS_ROUTE, 'utf8');

describe('catalog analysis proxy (GET /api/catalog/[itemId]/analysis)', () => {
  it('exists and exports only a GET handler — an analysis is immutable and never written here', () => {
    expect(fs.existsSync(ANALYSIS_ROUTE)).toBe(true);
    expect(src).toMatch(/export\s+async\s+function\s+GET/);
    expect(src).not.toMatch(/export\s+async\s+function\s+(POST|PUT|PATCH|DELETE)/);
  });

  it('authenticates and tenant-scopes via the shared proxy helper', () => {
    expect(src).toContain('getAuthenticatedTenantContext');
    expect(src).toContain('proxyRestGet');
  });

  it('targets the REST /catalog/{tenantSlug}/{itemId}/analysis upstream', () => {
    expect(src).toMatch(/\/catalog\/\$\{ctx\.tenantSlug\}\/\$\{encodeURIComponent\(itemId\)\}\/analysis/);
  });

  it('passes the upstream status through, so a 403 stays a refusal rather than an absence', () => {
    // The error branch returns the upstream `status` verbatim — never a hard-coded 404/500.
    expect(src).toMatch(/return NextResponse\.json\(\s*\{ success: false, error \},\s*\{ status \}\s*\)/);
    expect(src).toMatch(/imports:view/);
  });

  it('forwards the read-time valueVisibility restriction when the caller sets one', () => {
    expect(src).toContain("searchParams.get('valueVisibility')");
    expect(src).toMatch(/valueVisibility=\$\{encodeURIComponent\(visibility\)\}/);
  });

  it('returns the { success, record } envelope the analysis fetch consumes', () => {
    expect(src).toMatch(/success:\s*true,\s*record:/);
    expect(src).toMatch(/success:\s*false/);
  });
});
