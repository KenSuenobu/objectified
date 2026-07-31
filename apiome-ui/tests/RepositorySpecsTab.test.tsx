/**
 * Repository Specs tab — per-file refresh status UI (RAR-5.1, #3532).
 *
 * Integration coverage for the presentational table and its formatting seams:
 *  - each spec row renders status, last-refreshed, and next-due;
 *  - diverged files are visually distinct and link to the review action;
 *  - the fetching wrapper surfaces error and empty states.
 */

import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

import {
  REPO_REFRESH_KEY,
  RepositorySpecsTab,
  RepositorySpecsTable,
  formatNextDue,
  formatRefreshedAgo,
  repositorySpecReviewHref,
  type RepositoryRefreshSpec,
} from '../src/app/components/ade/dashboard/repositories/RepositorySpecsTab';

const NOW = Date.parse('2026-06-22T12:00:00Z');

function makeSpec(overrides: Partial<RepositoryRefreshSpec> = {}): RepositoryRefreshSpec {
  return {
    id: 'spec-1',
    path: 'specs/petstore.yaml',
    branch: 'main',
    project_id: 'proj-1',
    project_name: 'Petstore',
    project_slug: 'petstore',
    last_imported_committed_at: '2026-06-20T00:00:00Z',
    last_imported_blob_sha: 'blob-old',
    remote_committed_at: '2026-06-20T00:00:00Z',
    remote_blob_sha: 'blob-old',
    is_refreshing: false,
    last_refresh_failed: false,
    last_refreshed_at: '2026-06-22T11:00:00Z',
    spec_updated_at: '2026-06-20T00:00:00Z',
    refresh_interval_seconds: 300,
    repo_last_refreshed_at: '2026-06-22T12:00:00Z',
    auto_refresh_enabled: true,
    ...overrides,
  };
}

describe('formatRefreshedAgo', () => {
  test('absent timestamp → em dash', () => {
    expect(formatRefreshedAgo(null, NOW)).toBe('—');
    expect(formatRefreshedAgo('not-a-date', NOW)).toBe('—');
  });

  test('relative buckets', () => {
    expect(formatRefreshedAgo('2026-06-22T11:00:00Z', NOW)).toBe('1h ago');
    expect(formatRefreshedAgo('2026-06-22T11:58:00Z', NOW)).toBe('2m ago');
  });
});

describe('formatNextDue', () => {
  test('paused / due / future', () => {
    expect(formatNextDue(null, NOW)).toBe('Paused');
    expect(formatNextDue('due', NOW)).toBe('Due now');
    expect(formatNextDue(new Date(NOW - 1000), NOW)).toBe('Due now');
    expect(formatNextDue(new Date(NOW + 4 * 60_000), NOW)).toBe('in 4m');
    expect(formatNextDue(new Date(NOW + 2 * 3_600_000), NOW)).toBe('in 2h');
  });
});

describe('repositorySpecReviewHref', () => {
  test('deep-links into the Files tab on the recorded branch', () => {
    const href = repositorySpecReviewHref('repo-1', 'specs/a b.yaml', 'main');
    expect(href).toContain('/ade/dashboard/repositories/repo-1/preview?');
    expect(href).toContain('tab=files');
    expect(href).toContain('path=specs%2Fa+b.yaml');
    expect(href).toContain('branch=main');
  });
});

describe('RepositorySpecsTable', () => {
  test('up-to-date row shows status, last-refreshed, and next-due', () => {
    render(<RepositorySpecsTable repositoryId="repo-1" specs={[makeSpec()]} now={NOW} />);
    const row = screen.getByTestId('repository-spec-row');
    expect(row).toHaveAttribute('data-status', 'up-to-date');
    expect(within(row).getByText('Up to date')).toBeInTheDocument();
    expect(within(row).getByText('1h ago')).toBeInTheDocument();
    // repo last swept 12:00 + 5m interval → next due 12:05, i.e. 5m from now.
    expect(within(row).getByText('in 5m')).toBeInTheDocument();
  });

  test('a newer remote commit with changed content renders as stale', () => {
    const spec = makeSpec({
      remote_committed_at: '2026-06-22T10:00:00Z',
      remote_blob_sha: 'blob-new',
    });
    render(<RepositorySpecsTable repositoryId="repo-1" specs={[spec]} now={NOW} />);
    expect(screen.getByTestId('repository-spec-row')).toHaveAttribute('data-status', 'stale');
    expect(screen.getByText('Stale')).toBeInTheDocument();
  });

  test('an in-flight refresh renders as refreshing', () => {
    render(
      <RepositorySpecsTable repositoryId="repo-1" specs={[makeSpec({ is_refreshing: true })]} now={NOW} />,
    );
    expect(screen.getByTestId('repository-spec-row')).toHaveAttribute('data-status', 'refreshing');
  });

  test('disabled auto-refresh shows Paused next-due', () => {
    render(
      <RepositorySpecsTable
        repositoryId="repo-1"
        specs={[makeSpec({ auto_refresh_enabled: false })]}
        now={NOW}
      />,
    );
    expect(screen.getByText('Paused')).toBeInTheDocument();
  });

  test('empty state when no specs', () => {
    render(<RepositorySpecsTable repositoryId="repo-1" specs={[]} now={NOW} />);
    expect(screen.getByText(/No imported specs yet/i)).toBeInTheDocument();
  });

  // RAR-1.6 (#3517): specs seeded by the historical backfill are labeled so the
  // user knows the stored options are defaults, not their original request.
  test('a backfilled spec shows the "imported before spec capture" badge', () => {
    render(
      <RepositorySpecsTable repositoryId="repo-1" specs={[makeSpec({ backfilled: true })]} now={NOW} />,
    );
    const badge = screen.getByTestId('repository-spec-backfilled');
    expect(badge).toHaveTextContent('Imported before spec capture');
  });

  test('a captured (non-backfilled) spec shows no backfill badge', () => {
    render(<RepositorySpecsTable repositoryId="repo-1" specs={[makeSpec()]} now={NOW} />);
    expect(screen.queryByTestId('repository-spec-backfilled')).not.toBeInTheDocument();
  });

  test('per-repo and per-file Refresh actions fire their callbacks (RAR-5.2)', () => {
    const onRefreshRepo = jest.fn();
    const onRefreshFile = jest.fn();
    const spec = makeSpec();
    render(
      <RepositorySpecsTable
        repositoryId="repo-1"
        specs={[spec]}
        now={NOW}
        onRefreshRepo={onRefreshRepo}
        onRefreshFile={onRefreshFile}
      />,
    );

    fireEvent.click(screen.getByTestId('repository-refresh-all'));
    expect(onRefreshRepo).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('repository-refresh-file'));
    expect(onRefreshFile).toHaveBeenCalledWith(spec);
  });

  test('a busy refresh disables every refresh button (no double-fire)', () => {
    render(
      <RepositorySpecsTable
        repositoryId="repo-1"
        specs={[makeSpec()]}
        now={NOW}
        busyKey={REPO_REFRESH_KEY}
        onRefreshRepo={jest.fn()}
        onRefreshFile={jest.fn()}
      />,
    );
    expect(screen.getByTestId('repository-refresh-all')).toBeDisabled();
    expect(screen.getByTestId('repository-refresh-file')).toBeDisabled();
  });

  test('the per-repo button is hidden when there are no specs', () => {
    render(
      <RepositorySpecsTable
        repositoryId="repo-1"
        specs={[]}
        now={NOW}
        onRefreshRepo={jest.fn()}
        onRefreshFile={jest.fn()}
      />,
    );
    expect(screen.queryByTestId('repository-refresh-all')).not.toBeInTheDocument();
  });

  test('renders the refresh notice when supplied', () => {
    render(
      <RepositorySpecsTable
        repositoryId="repo-1"
        specs={[makeSpec()]}
        now={NOW}
        notice={{ kind: 'success', text: 'Already up to date — nothing to refresh.' }}
        onRefreshRepo={jest.fn()}
        onRefreshFile={jest.fn()}
      />,
    );
    expect(screen.getByTestId('repository-refresh-notice')).toHaveTextContent(
      /Already up to date/i,
    );
  });
});

describe('RepositorySpecsTab (fetching wrapper)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('renders rows from the refresh-specs endpoint', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, specs: [makeSpec()] }),
    }) as unknown as typeof fetch;

    render(<RepositorySpecsTab repositoryId="repo-1" />);
    await waitFor(() => expect(screen.getByText('Up to date')).toBeInTheDocument());
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/repositories/repo-1/refresh-specs?limit=200'),
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  test('surfaces an error state on failure', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      statusText: 'Server error',
      json: async () => ({ success: false, error: 'boom' }),
    }) as unknown as typeof fetch;

    render(<RepositorySpecsTab repositoryId="repo-1" />);
    await waitFor(() => expect(screen.getByText('boom')).toBeInTheDocument());
  });

  test('Refresh now POSTs to the refresh endpoint and reports the result (RAR-5.2)', async () => {
    const fetchMock = jest
      .fn()
      // initial load
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, specs: [makeSpec()] }) })
      // POST /refresh
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, enqueued: 2, skipped: 0 }) })
      // reload after refresh
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, specs: [makeSpec()] }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<RepositorySpecsTab repositoryId="repo-1" />);
    await waitFor(() => expect(screen.getByTestId('repository-refresh-all')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('repository-refresh-all'));

    await waitFor(() =>
      expect(screen.getByTestId('repository-refresh-notice')).toHaveTextContent(
        /Refresh queued for 2 files/i,
      ),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/repositories/repo-1/refresh',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('an up-to-date single-file refresh reports the no-op (freshness gate)', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, specs: [makeSpec()] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, enqueued: 0, skipped: 1 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, specs: [makeSpec()] }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<RepositorySpecsTab repositoryId="repo-1" />);
    await waitFor(() => expect(screen.getByTestId('repository-refresh-file')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('repository-refresh-file'));

    await waitFor(() =>
      expect(screen.getByTestId('repository-refresh-notice')).toHaveTextContent(
        /Already up to date/i,
      ),
    );
    const body = JSON.parse((fetchMock.mock.calls[1][1] as { body: string }).body);
    expect(body).toEqual({ path: 'specs/petstore.yaml', branch: 'main' });
  });
});
