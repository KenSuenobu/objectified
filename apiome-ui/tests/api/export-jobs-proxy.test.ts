/**
 * Contract test for the async export-job proxy routes (MFX-46.2, #4380).
 *
 * The Studio's Generate phase drives the async export pipeline through thin proxies:
 *  - `src/app/api/export/jobs/route.ts`             POST → REST `/export/{tenant}/jobs` (submit)
 *  - `src/app/api/export/jobs/[jobId]/route.ts`     GET  → `.../jobs/{id}` (poll), DELETE (cancel)
 *  - `src/app/api/export/jobs/[jobId]/download/route.ts` GET → `.../jobs/{id}/download` (artifact)
 *
 * Rather than stand up the full NextAuth + fetch stack, this asserts the source-level contract the
 * feature depends on: the routes exist, use the shared auth/tenant-scope helper, target the right
 * REST upstreams, and (for the download) pass the bytes through verbatim with their headers. If a
 * proxy is deleted or its upstream path drifts from the REST job contract, this goes red.
 */

import * as fs from 'fs';
import * as path from 'path';

const apiDir = path.resolve(__dirname, '..', '..', 'src', 'app', 'api', 'export', 'jobs');
const submitRoute = fs.readFileSync(path.join(apiDir, 'route.ts'), 'utf8');
const statusRoute = fs.readFileSync(path.join(apiDir, '[jobId]', 'route.ts'), 'utf8');
const downloadRoute = fs.readFileSync(path.join(apiDir, '[jobId]', 'download', 'route.ts'), 'utf8');

describe('export jobs list/submit proxy (GET+POST /api/export/jobs)', () => {
  it('exports GET (paginated list) and POST (submit) handlers', () => {
    expect(submitRoute).toMatch(/export\s+async\s+function\s+GET/);
    expect(submitRoute).toMatch(/export\s+async\s+function\s+POST/);
  });

  it('authenticates + tenant-scopes and targets the REST /export/{tenant}/jobs upstream', () => {
    expect(submitRoute).toContain('getAuthenticatedTenantContext');
    expect(submitRoute).toContain('proxyRestPost');
    expect(submitRoute).toContain('proxyRestGet');
    expect(submitRoute).toMatch(/\/export\/\$\{ctx\.tenantSlug\}\/jobs/);
  });

  it('forwards pagination and filter query params on GET', () => {
    expect(submitRoute).toContain('limit');
    expect(submitRoute).toContain('offset');
    expect(submitRoute).toContain('state');
    expect(submitRoute).toContain('created_after');
    expect(submitRoute).toContain('created_before');
    expect(submitRoute).toContain('forwardListQuery');
  });

  it('returns the { success, ... } envelope and rejects a missing body on POST', () => {
    expect(submitRoute).toMatch(/success:\s*true/);
    expect(submitRoute).toMatch(/Missing request body/);
    expect(submitRoute).toMatch(/status:\s*400/);
  });
});

describe('export job status proxy (GET/DELETE /api/export/jobs/[jobId])', () => {
  it('exports GET (poll) and DELETE (cancel) handlers', () => {
    expect(statusRoute).toMatch(/export\s+async\s+function\s+GET/);
    expect(statusRoute).toMatch(/export\s+async\s+function\s+DELETE/);
  });

  it('reads the jobId param and targets the per-job REST upstreams', () => {
    expect(statusRoute).toMatch(/params:\s*Promise<\{\s*jobId:\s*string\s*\}>/);
    expect(statusRoute).toContain('proxyRestGet');
    expect(statusRoute).toContain('proxyRestDelete');
    expect(statusRoute).toMatch(/\/jobs\/\$\{encodeURIComponent\(jobId\)\}/);
  });
});

describe('export job download proxy (GET /api/export/jobs/[jobId]/download)', () => {
  it('exports only a GET handler that streams the artifact bytes verbatim', () => {
    expect(downloadRoute).toMatch(/export\s+async\s+function\s+GET/);
    expect(downloadRoute).not.toMatch(/export\s+async\s+function\s+(POST|PUT|DELETE)/);
    // The body is passed through with its content-type/disposition (may be a document or a zip).
    expect(downloadRoute).toContain('Content-Disposition');
    expect(downloadRoute).toContain('response.body');
    expect(downloadRoute).toMatch(/\/jobs\/\$\{encodeURIComponent\(\s*[\s\S]*?\)\}\/download/);
  });
});
