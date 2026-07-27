/**
 * Contract tests for the bulk-import proxy routes — MFI-29.5.
 *
 * `/api/catalog/import/bulk{,/plan,/status}` forward to the REST bulk endpoints. Two
 * properties matter, and both are the reason these are proxies rather than direct calls:
 *
 * 1. **Tenancy comes from the session**, never from the request body — a caller must not be
 *    able to plan or import a payload into someone else's tenant.
 * 2. **Each route forwards to its own REST path** — a submit that landed on `/plan` would
 *    silently import nothing, and a plan that landed on the submit path would import
 *    everything without asking.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROUTES = path.resolve(__dirname, '..', '..', 'src', 'app', 'api', 'catalog', 'import', 'bulk');

const files = {
  submit: path.join(ROUTES, 'route.ts'),
  plan: path.join(ROUTES, 'plan', 'route.ts'),
  status: path.join(ROUTES, 'status', 'route.ts'),
};

describe.each(Object.entries(files))('bulk import proxy route: %s', (_name, file) => {
  const src = fs.readFileSync(file, 'utf8');

  it('exists and exports only POST', () => {
    expect(fs.existsSync(file)).toBe(true);
    expect(src).toMatch(/export\s+async\s+function\s+POST/);
    expect(src).not.toMatch(/export\s+async\s+function\s+(GET|PUT|DELETE|PATCH)/);
  });

  it('requires an authenticated tenant context before forwarding', () => {
    expect(src).toMatch(/getAuthenticatedTenantContext/);
    expect(src).toMatch(/if \(!ctx\.ok\)/);
  });

  it('scopes the REST path to the session tenant', () => {
    expect(src).toContain('encodeURIComponent(ctx.tenantSlug)');
  });

  it('rejects a non-object body instead of forwarding it', () => {
    expect(src).toMatch(/Invalid request body/);
  });
});

describe('bulk import proxy routes target distinct REST endpoints', () => {
  it('forwards each route to its own bulk endpoint', () => {
    expect(fs.readFileSync(files.plan, 'utf8')).toContain('/import/bulk/plan');
    expect(fs.readFileSync(files.status, 'utf8')).toContain('/import/bulk/status');

    const submit = fs.readFileSync(files.submit, 'utf8');
    expect(submit).toContain('/import/bulk`');
    expect(submit).not.toContain('/import/bulk/plan');
    expect(submit).not.toContain('/import/bulk/status');
  });
});
