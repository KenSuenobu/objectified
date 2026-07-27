/**
 * Contract tests for the git-intake proxy route and the shared REST error renderer — MFI-29.3.
 *
 * `/api/catalog/import/git` forwards a repository selection to REST
 * `POST /v1/tenants/{tenant}/import/git/fileset`. Two properties matter:
 *
 * 1. **Tenancy comes from the session**, never from the request body — a caller must not be able
 *    to read a repository into someone else's tenant.
 * 2. **Failures keep their message.** A selection that cannot be read comes back as a structured
 *    taxonomy error (`{code, message, remediation, …}`); the wizard shows that sentence, so
 *    `restErrorMessage` must render it instead of collapsing it to "Request failed".
 */

import * as fs from 'fs';
import * as path from 'path';

import { restErrorMessage } from '../../lib/rest-error-message';

const ROUTE = path.resolve(
  __dirname,
  '..',
  '..',
  'src',
  'app',
  'api',
  'catalog',
  'import',
  'git',
  'route.ts',
);

const src = fs.readFileSync(ROUTE, 'utf8');

describe('git import proxy route', () => {
  it('exists and exports only POST', () => {
    expect(fs.existsSync(ROUTE)).toBe(true);
    expect(src).toMatch(/export\s+async\s+function\s+POST/);
    expect(src).not.toMatch(/export\s+async\s+function\s+(GET|PUT|DELETE|PATCH)/);
  });

  it('forwards to the REST git fileset endpoint under the session tenant', () => {
    expect(src).toContain('/import/git/fileset');
    expect(src).toContain('encodeURIComponent(ctx.tenantSlug)');
  });

  it('requires an authenticated tenant context before forwarding', () => {
    expect(src).toMatch(/getAuthenticatedTenantContext/);
    expect(src).toMatch(/if \(!ctx\.ok\)/);
  });

  it('rejects a non-object body instead of forwarding it', () => {
    expect(src).toMatch(/Invalid request body/);
  });
});

describe('restErrorMessage', () => {
  it('passes a plain string detail through', () => {
    expect(restErrorMessage({ detail: 'Repository not found for this tenant.' })).toBe(
      'Repository not found for this tenant.',
    );
  });

  it('renders a structured taxonomy detail as message + remediation', () => {
    const message = restErrorMessage({
      detail: {
        code: 'SOURCE_SELECTION_EMPTY',
        category: 'input',
        message: "No importable files matching 'schemas/**' were found.",
        remediation: "Widen the pattern (for example 'protos/**').",
        retriable: false,
      },
    });
    expect(message).toBe(
      "No importable files matching 'schemas/**' were found. Widen the pattern (for example 'protos/**').",
    );
  });

  it('joins FastAPI validation details', () => {
    expect(
      restErrorMessage({ detail: [{ msg: 'field required' }, { msg: 'not a valid url' }] }),
    ).toBe('field required; not a valid url');
  });

  it('falls back for an unusable body', () => {
    expect(restErrorMessage({})).toBe('Request failed');
    expect(restErrorMessage(null)).toBe('Request failed');
    expect(restErrorMessage({ detail: { code: 'X' } })).toBe('Request failed');
  });
});
