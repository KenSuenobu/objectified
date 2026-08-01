/**
 * listTenantRefreshActivitySignals DAO tests (RAR-5.5, #3536).
 *
 * Verifies the SQL contract that backs the tenant-wide "Refresh activity"
 * dashboard widget:
 *  - the query is tenant-scoped only (no repository filter) and joins the live
 *    `tenant_repositories` row so soft-deleted repos are excluded;
 *  - the recency anchors, operational refresh-job flags, and repository
 *    identity columns the client aggregation needs are all selected;
 *  - the limit is clamped to 1–2000 (default 2000);
 *  - rows are returned verbatim from the pool.
 */

import { describe, test, expect, jest, beforeEach } from '@jest/globals';

// Mock the database connection pool (repository-import-metrics requires './db').
jest.mock('../lib/db/db', () => ({
  query: jest.fn(),
}));

import * as dbModule from '../lib/db/db';
import { listTenantRefreshActivitySignals } from '../lib/db/repository-import-metrics';

describe('listTenantRefreshActivitySignals (RAR-5.5, #3536)', () => {
  const mockQuery = dbModule.query as unknown as jest.Mock;

  beforeEach(() => {
    mockQuery.mockClear();
    mockQuery.mockResolvedValue({ rowCount: 0, rows: [] });
  });

  test('scopes by tenant only and defaults the limit to 2000', async () => {
    await listTenantRefreshActivitySignals({ tenantId: 'tenant-1' });
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('FROM apiome.repository_import_spec s');
    expect(sql).toContain('s.tenant_id = $1::uuid');
    // Tenant-wide: no per-repository predicate.
    expect(sql).not.toContain('s.repository_id = $2');
    // Soft-deleted repositories are excluded by the join.
    expect(sql).toContain('tr.deleted_at IS NULL');
    expect(params).toEqual(['tenant-1', 2000]);
  });

  test('selects the signals and repository identity the aggregation needs', async () => {
    await listTenantRefreshActivitySignals({ tenantId: 'tenant-1' });
    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    // Repository identity for the drill-in.
    expect(sql).toContain('s.repository_id');
    expect(sql).toContain('repository_full_name');
    expect(sql).toContain('clone_url');
    // Recency axis (RAR-2.1 anchors vs scanned remote).
    expect(sql).toContain('apiome.tenant_repository_files');
    expect(sql).toContain('last_imported_committed_at');
    expect(sql).toContain('remote_committed_at');
    // Operational axis (RAR-3.2 job queue) + recent-activity signal.
    expect(sql).toContain('apiome.tenant_repository_refresh_jobs');
    expect(sql).toContain('is_refreshing');
    expect(sql).toContain('last_refresh_failed');
    expect(sql).toContain('last_refreshed_at');
  });

  test('clamps the limit to the 1–2000 window', async () => {
    await listTenantRefreshActivitySignals({ tenantId: 'tenant-1', limit: 99999 });
    expect((mockQuery.mock.calls[0] as [string, unknown[]])[1]).toEqual(['tenant-1', 2000]);

    mockQuery.mockClear();
    await listTenantRefreshActivitySignals({ tenantId: 'tenant-1', limit: 0 });
    expect((mockQuery.mock.calls[0] as [string, unknown[]])[1]).toEqual(['tenant-1', 1]);

    mockQuery.mockClear();
    await listTenantRefreshActivitySignals({ tenantId: 'tenant-1', limit: 50 });
    expect((mockQuery.mock.calls[0] as [string, unknown[]])[1]).toEqual(['tenant-1', 50]);
  });

  test('returns the pool rows verbatim', async () => {
    const rows = [{ repository_id: 'repo-1', path: 'specs/petstore.yaml', branch: 'main' }];
    mockQuery.mockResolvedValue({ rowCount: rows.length, rows });
    const result = await listTenantRefreshActivitySignals({ tenantId: 'tenant-1' });
    expect(result).toBe(rows);
  });
});
