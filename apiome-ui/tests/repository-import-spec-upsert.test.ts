/**
 * repository_import_spec upsert tests (RAR-1.2, #3513)
 *
 * Unit tests for upsertRepositoryImportSpec: the SQL contract that persists the
 * exact import options + source descriptor for a repository file so a future
 * auto-refresh can replay them. Covers:
 *  - persisted options_json == submitted options (lossless round-trip)
 *  - idempotent on (repository_id, branch, path) via the named unique constraint
 *  - tenant-guarded insert; returns true/false from rowCount
 *  - empty repository id short-circuits without a query
 */

import { describe, test, expect, jest, beforeEach } from '@jest/globals';

// Mock the database connection pool (repository-import-metrics requires './db').
jest.mock('../lib/db/db', () => ({
  query: jest.fn(),
}));

const SUBMITTED_OPTIONS = {
  selectedSchemas: ['Pet', 'Order', 'User'],
  dryRun: false,
  incrementalMode: true,
  applyNamingConvention: true,
  classNamingConvention: 'PascalCase',
  propertyNamingConvention: 'snake_case',
  autoLayout: true,
  createRelationships: true,
  classNameMap: { pet: 'Pet' },
  classPrefix: 'Api',
  classSuffix: 'Dto',
  typeMapping: { uuid: { type: 'string', format: 'uuid' } },
  defaultValues: { string: '' },
  requiredOverrides: { Pet: { name: true } },
  descriptionOverrides: { Pet: { name: 'The pet name' } },
  generateExamples: true,
  skipDuplicateVersions: true,
};

function getMockQuery(): jest.Mock {
  const db = require('../lib/db/db');
  return db.query as jest.Mock;
}

const BASE_PARAMS = {
  tenantId: 'tenant-1',
  repositorySource: { repositoryId: 'repo-1', branch: 'main', path: 'specs/petstore.yaml' },
  projectId: 'proj-1',
  sourceKind: 'openapi',
  options: SUBMITTED_OPTIONS as Record<string, unknown>,
  createdByUserId: 'user-1',
};

describe('upsertRepositoryImportSpec (RAR-1.2, #3513)', () => {
  let mockQuery: jest.Mock;

  beforeEach(() => {
    mockQuery = getMockQuery();
    mockQuery.mockClear();
    mockQuery.mockResolvedValue({ rowCount: 1, rows: [{ id: 'spec-1' }] });
  });

  test('persists the submitted options losslessly in options_json', async () => {
    const { upsertRepositoryImportSpec } = require('../lib/db/repository-import-metrics');

    await upsertRepositoryImportSpec(BASE_PARAMS);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [, params] = mockQuery.mock.calls[0];
    // options_json is the 9th positional parameter ($9).
    const persisted = JSON.parse(params[8] as string);
    expect(persisted).toEqual(SUBMITTED_OPTIONS);
  });

  test('binds tenant, repository, branch, path, project, source kind, and creator', async () => {
    const { upsertRepositoryImportSpec } = require('../lib/db/repository-import-metrics');

    await upsertRepositoryImportSpec(BASE_PARAMS);

    const [, params] = mockQuery.mock.calls[0];
    expect(params[0]).toBe('tenant-1'); // tenant_id
    expect(params[1]).toBe('repo-1'); // repository_id
    expect(params[2]).toBe('main'); // branch
    expect(params[3]).toBe('specs/petstore.yaml'); // path
    expect(params[4]).toBe('proj-1'); // project_id
    expect(params[5]).toBe('openapi'); // source_kind
    expect(params[9]).toBe(1); // spec_schema_version default
    expect(params[10]).toBe('user-1'); // created_by
  });

  test('upserts idempotently on the named unique constraint (re-import updates, not duplicate)', async () => {
    const { upsertRepositoryImportSpec } = require('../lib/db/repository-import-metrics');

    await upsertRepositoryImportSpec(BASE_PARAMS);

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain('INSERT INTO apiome.repository_import_spec');
    expect(sql).toContain('ON CONFLICT ON CONSTRAINT uq_repository_import_spec_repo_branch_path');
    expect(sql).toContain('DO UPDATE SET');
    expect(sql).toContain('options_json = EXCLUDED.options_json');
    expect(sql).toContain('updated_at = CURRENT_TIMESTAMP');
  });

  test('guards the insert so only repositories owned by the tenant get a row', async () => {
    const { upsertRepositoryImportSpec } = require('../lib/db/repository-import-metrics');

    await upsertRepositoryImportSpec(BASE_PARAMS);

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain('FROM apiome.tenant_repositories tr');
    expect(sql).toContain('tr.tenant_id = $1::uuid');
    expect(sql).toContain('tr.deleted_at IS NULL');
  });

  test('returns true when a row is written', async () => {
    const { upsertRepositoryImportSpec } = require('../lib/db/repository-import-metrics');
    mockQuery.mockResolvedValue({ rowCount: 1, rows: [{ id: 'spec-1' }] });

    await expect(upsertRepositoryImportSpec(BASE_PARAMS)).resolves.toBe(true);
  });

  test('returns false when the repository does not belong to the tenant (no row)', async () => {
    const { upsertRepositoryImportSpec } = require('../lib/db/repository-import-metrics');
    mockQuery.mockResolvedValue({ rowCount: 0, rows: [] });

    await expect(upsertRepositoryImportSpec(BASE_PARAMS)).resolves.toBe(false);
  });

  test('short-circuits (no query) when repository id is empty', async () => {
    const { upsertRepositoryImportSpec } = require('../lib/db/repository-import-metrics');

    const result = await upsertRepositoryImportSpec({
      ...BASE_PARAMS,
      repositorySource: { repositoryId: '   ', branch: 'main', path: 'x.yaml' },
    });

    expect(result).toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('passes format override and content type through when provided', async () => {
    const { upsertRepositoryImportSpec } = require('../lib/db/repository-import-metrics');

    await upsertRepositoryImportSpec({
      ...BASE_PARAMS,
      formatOverride: 'yaml',
      contentType: 'application/yaml',
    });

    const [, params] = mockQuery.mock.calls[0];
    expect(params[6]).toBe('yaml'); // format_override
    expect(params[7]).toBe('application/yaml'); // content_type
  });

  test('defaults format override and content type to null when omitted', async () => {
    const { upsertRepositoryImportSpec } = require('../lib/db/repository-import-metrics');

    await upsertRepositoryImportSpec(BASE_PARAMS);

    const [, params] = mockQuery.mock.calls[0];
    expect(params[6]).toBeNull(); // format_override
    expect(params[7]).toBeNull(); // content_type
  });

  // RAR-1.6 (#3517): a genuine capture must clear the historical-backfill flag,
  // so a lineage whose spec was seeded by the migration becomes user-authored
  // (backfilled=false) the first time it is really re-imported.
  test('writes backfilled=false on insert and clears the flag on re-import', async () => {
    const { upsertRepositoryImportSpec } = require('../lib/db/repository-import-metrics');

    await upsertRepositoryImportSpec(BASE_PARAMS);

    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toContain('backfilled');
    // Fresh captures insert the flag as FALSE...
    expect(sql).toMatch(/trf\.blob_sha,\s*FALSE/);
    // ...and a conflicting (pre-existing, possibly backfilled) row is cleared.
    expect(sql).toContain('backfilled = FALSE');
  });

  // RAR-2.1 (#3518): the spec records freshness anchors copied from the matching
  // indexed tenant_repository_files row via a LEFT JOIN on (repository, branch, path),
  // so a future auto-refresh can gate "newer-than" re-imports.
  test('captures the freshness signal at import via the file-row JOIN', async () => {
    const { upsertRepositoryImportSpec } = require('../lib/db/repository-import-metrics');

    await upsertRepositoryImportSpec(BASE_PARAMS);

    const [sql] = mockQuery.mock.calls[0];
    // Anchors are written from the matching scan row, not bound as parameters.
    expect(sql).toContain('LEFT JOIN apiome.tenant_repository_files trf');
    expect(sql).toContain('trf.commit_sha, trf.committed_at, trf.blob_sha');
    expect(sql).toContain('last_imported_commit_sha');
    expect(sql).toContain('last_imported_committed_at');
    expect(sql).toContain('last_imported_blob_sha');
    expect(sql).toContain('last_imported_commit_sha = EXCLUDED.last_imported_commit_sha');
    // The JOIN reuses the branch ($3) and path ($4) bind parameters.
    const [, params] = mockQuery.mock.calls[0];
    expect(params[2]).toBe('main'); // branch reused by JOIN
    expect(params[3]).toBe('specs/petstore.yaml'); // path reused by JOIN
  });
});
