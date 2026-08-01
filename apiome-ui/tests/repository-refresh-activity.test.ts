/**
 * Tenant-wide refresh-activity aggregation tests (RAR-5.5, #3536).
 *
 * Verifies the pure summarizer that backs the dashboard "Refresh activity"
 * widget:
 *  - state tallies agree with the RAR-2.3 state machine (precedence:
 *    refreshing > diverged > failed > stale > up-to-date);
 *  - the "refreshed (24h)" window is inclusive at the boundary and ignores
 *    unparseable/future timestamps;
 *  - the per-repository drill-in list keeps only affected repos, ordered by
 *    attention count then name;
 *  - repository display names fall back from full name to clone URL segment.
 */

import {
  REFRESHED_RECENTLY_WINDOW_MS,
  refreshedRecently,
  repositoryDisplayName,
  summarizeRefreshActivity,
  type RefreshActivitySignal,
} from '../src/app/components/ade/dashboard/repositories/repository-refresh-activity';

const NOW = Date.parse('2026-06-22T12:00:00Z');

function makeSignal(overrides: Partial<RefreshActivitySignal> = {}): RefreshActivitySignal {
  return {
    repository_id: 'repo-1',
    repository_full_name: 'acme/petstore',
    clone_url: 'https://github.com/acme/petstore.git',
    branch: 'main',
    path: 'specs/petstore.yaml',
    // Same commit + same blob → up-to-date by default.
    last_imported_committed_at: '2026-06-20T00:00:00Z',
    last_imported_blob_sha: 'blob-a',
    remote_committed_at: '2026-06-20T00:00:00Z',
    remote_blob_sha: 'blob-a',
    is_refreshing: false,
    last_refresh_failed: false,
    last_refreshed_at: null,
    ...overrides,
  };
}

describe('repositoryDisplayName', () => {
  test('prefers the provider full name', () => {
    expect(repositoryDisplayName('acme/petstore', 'https://x/y.git')).toBe('acme/petstore');
  });

  test('falls back to the clone URL last segment without .git', () => {
    expect(repositoryDisplayName(null, 'https://github.com/acme/petstore.git')).toBe('petstore');
    expect(repositoryDisplayName('  ', 'https://github.com/acme/orders/')).toBe('orders');
  });

  test('neutral fallback when both are absent', () => {
    expect(repositoryDisplayName(null, null)).toBe('Repository');
    expect(repositoryDisplayName('', '   ')).toBe('Repository');
  });
});

describe('refreshedRecently', () => {
  test('inside and exactly at the 24h boundary counts', () => {
    expect(refreshedRecently('2026-06-22T11:00:00Z', NOW)).toBe(true);
    const boundary = new Date(NOW - REFRESHED_RECENTLY_WINDOW_MS).toISOString();
    expect(refreshedRecently(boundary, NOW)).toBe(true);
  });

  test('older than 24h, absent, unparseable, or future does not count', () => {
    expect(refreshedRecently('2026-06-21T11:59:59Z', NOW)).toBe(false);
    expect(refreshedRecently(null, NOW)).toBe(false);
    expect(refreshedRecently('not-a-date', NOW)).toBe(false);
    expect(refreshedRecently('2026-06-23T12:00:00Z', NOW)).toBe(false);
  });
});

describe('summarizeRefreshActivity (RAR-5.5, #3536)', () => {
  test('empty input → zero counts and no affected repositories', () => {
    const summary = summarizeRefreshActivity([], NOW);
    expect(summary.total).toBe(0);
    expect(summary.counts).toEqual({
      'up-to-date': 0,
      stale: 0,
      refreshing: 0,
      failed: 0,
      diverged: 0,
    });
    expect(summary.refreshedRecently).toBe(0);
    expect(summary.affectedRepositories).toEqual([]);
  });

  test('tallies each state via the RAR-2.3 state machine', () => {
    const rows: RefreshActivitySignal[] = [
      // up-to-date (anchors match)
      makeSignal({ path: 'a.yaml' }),
      // stale: remote strictly newer with changed content
      makeSignal({
        path: 'b.yaml',
        remote_committed_at: '2026-06-21T00:00:00Z',
        remote_blob_sha: 'blob-b',
      }),
      // failed: last finished refresh job errored
      makeSignal({ path: 'c.yaml', last_refresh_failed: true }),
      // refreshing outranks failed and stale
      makeSignal({
        path: 'd.yaml',
        is_refreshing: true,
        last_refresh_failed: true,
        remote_committed_at: '2026-06-21T00:00:00Z',
        remote_blob_sha: 'blob-b',
      }),
      // diverged (forward-compatible optional signal) outranks failed
      makeSignal({ path: 'e.yaml', diverged: true, last_refresh_failed: true }),
    ];
    const summary = summarizeRefreshActivity(rows, NOW);
    expect(summary.total).toBe(5);
    expect(summary.counts).toEqual({
      'up-to-date': 1,
      stale: 1,
      failed: 1,
      refreshing: 1,
      diverged: 1,
    });
  });

  test('counts refreshes inside the 24h window', () => {
    const rows = [
      makeSignal({ path: 'a.yaml', last_refreshed_at: '2026-06-22T11:00:00Z' }),
      makeSignal({ path: 'b.yaml', last_refreshed_at: '2026-06-20T00:00:00Z' }),
      makeSignal({ path: 'c.yaml', last_refreshed_at: null }),
    ];
    expect(summarizeRefreshActivity(rows, NOW).refreshedRecently).toBe(1);
  });

  test('drill-in keeps only affected repos, ordered by attention then name', () => {
    const rows: RefreshActivitySignal[] = [
      // repo-healthy: everything up to date → excluded from the drill-in list.
      makeSignal({ repository_id: 'repo-healthy', repository_full_name: 'acme/healthy' }),
      // repo-one: 1 stale.
      makeSignal({
        repository_id: 'repo-one',
        repository_full_name: 'acme/one',
        remote_committed_at: '2026-06-21T00:00:00Z',
        remote_blob_sha: 'blob-b',
      }),
      // repo-two: 1 failed + 1 stale = attention 2 → listed first.
      makeSignal({
        repository_id: 'repo-two',
        repository_full_name: 'acme/two',
        path: 'x.yaml',
        last_refresh_failed: true,
      }),
      makeSignal({
        repository_id: 'repo-two',
        repository_full_name: 'acme/two',
        path: 'y.yaml',
        remote_committed_at: '2026-06-21T00:00:00Z',
        remote_blob_sha: 'blob-b',
      }),
    ];
    const summary = summarizeRefreshActivity(rows, NOW);
    expect(summary.affectedRepositories.map((r) => r.repositoryId)).toEqual([
      'repo-two',
      'repo-one',
    ]);
    const [top] = summary.affectedRepositories;
    expect(top.repositoryName).toBe('acme/two');
    expect(top.total).toBe(2);
    expect(top.attention).toBe(2);
    expect(top.counts.failed).toBe(1);
    expect(top.counts.stale).toBe(1);
  });

  test('ties in attention order break alphabetically by name', () => {
    const rows: RefreshActivitySignal[] = [
      makeSignal({
        repository_id: 'repo-b',
        repository_full_name: 'acme/bravo',
        last_refresh_failed: true,
      }),
      makeSignal({
        repository_id: 'repo-a',
        repository_full_name: 'acme/alpha',
        last_refresh_failed: true,
      }),
    ];
    const summary = summarizeRefreshActivity(rows, NOW);
    expect(summary.affectedRepositories.map((r) => r.repositoryName)).toEqual([
      'acme/alpha',
      'acme/bravo',
    ]);
  });
});
