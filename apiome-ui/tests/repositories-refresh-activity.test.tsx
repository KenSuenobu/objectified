/**
 * Dashboard "Refresh activity" panel tests (RAR-5.5, #3536; re-drawn by HIVE-7.3, #5320).
 *
 * Integration coverage for the tenant-wide refresh-health card:
 *  - state counts and the refreshed-(24h) tally render from the summary;
 *  - drill-in rows link to each affected repository's Specs tab;
 *  - the affected list is capped with a "+N more" note;
 *  - empty / all-healthy states render their own copy;
 *  - the fetching wrapper aggregates the API signals and surfaces errors.
 */

import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

import {
  AFFECTED_REPOS_SHOWN,
  RepositoryRefreshActivityPanel,
  RepositoryRefreshActivityPanelView,
  repositoryRefreshSpecsHref,
} from '../src/app/components/ade/repositories/RepositoryRefreshActivityPanel';
import { REFRESH_STATUS_TONE } from '../src/app/components/ade/repositories/repositoriesModel';
import { statusTone } from '../src/app/components/ui/statusVocabulary';
import {
  summarizeRefreshActivity,
  type RefreshActivitySignal,
  type RefreshActivitySummary,
} from '../src/app/components/ade/dashboard/repositories/repository-refresh-activity';

const NOW = Date.parse('2026-06-22T12:00:00Z');

function makeSignal(overrides: Partial<RefreshActivitySignal> = {}): RefreshActivitySignal {
  return {
    repository_id: 'repo-1',
    repository_full_name: 'acme/petstore',
    clone_url: 'https://github.com/acme/petstore.git',
    branch: 'main',
    path: 'specs/petstore.yaml',
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

function makeSummary(rows: RefreshActivitySignal[]): RefreshActivitySummary {
  return summarizeRefreshActivity(rows, NOW);
}

describe('repositoryRefreshSpecsHref', () => {
  test('deep-links to the repository Specs tab and escapes the id', () => {
    expect(repositoryRefreshSpecsHref('repo-1')).toBe(
      '/ade/dashboard/repositories/repo-1/preview?tab=specs',
    );
    expect(repositoryRefreshSpecsHref('a b')).toBe(
      '/ade/dashboard/repositories/a%20b/preview?tab=specs',
    );
  });
});

describe('RepositoryRefreshActivityPanelView', () => {
  test('renders counts by state and the refreshed-(24h) tally', () => {
    const summary = makeSummary([
      // stale
      makeSignal({
        path: 'a.yaml',
        remote_committed_at: '2026-06-21T00:00:00Z',
        remote_blob_sha: 'blob-b',
      }),
      // failed
      makeSignal({ path: 'b.yaml', last_refresh_failed: true }),
      // refreshing
      makeSignal({ path: 'c.yaml', is_refreshing: true }),
      // up-to-date, refreshed an hour ago
      makeSignal({ path: 'd.yaml', last_refreshed_at: '2026-06-22T11:00:00Z' }),
    ]);
    render(<RepositoryRefreshActivityPanelView summary={summary} />);

    expect(screen.getByTestId('refresh-activity-count-stale')).toHaveTextContent('Stale1');
    expect(screen.getByTestId('refresh-activity-count-failed')).toHaveTextContent('Failed1');
    expect(screen.getByTestId('refresh-activity-count-refreshing')).toHaveTextContent(
      'Refreshing1',
    );
    expect(screen.getByTestId('refresh-activity-count-diverged')).toHaveTextContent('Diverged0');
    expect(screen.getByTestId('refresh-activity-count-up-to-date')).toHaveTextContent(
      'Up to date1',
    );
    expect(screen.getByTestId('refresh-activity-card')).toHaveTextContent(
      '4 specs tracked · 1 refreshed (24h)',
    );
  });

  test('drill-in rows link to each affected repository Specs tab with its counts', () => {
    const summary = makeSummary([
      makeSignal({
        repository_id: 'repo-two',
        repository_full_name: 'acme/two',
        last_refresh_failed: true,
      }),
      makeSignal({ repository_id: 'repo-healthy', repository_full_name: 'acme/healthy' }),
    ]);
    render(<RepositoryRefreshActivityPanelView summary={summary} />);

    const links = screen.getAllByTestId('refresh-activity-repo-link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute(
      'href',
      '/ade/dashboard/repositories/repo-two/preview?tab=specs',
    );
    expect(within(links[0]).getByText('acme/two')).toBeInTheDocument();
    expect(links[0]).toHaveTextContent('1 failed');
  });

  test('caps the affected list and notes the remainder', () => {
    const rows = Array.from({ length: AFFECTED_REPOS_SHOWN + 2 }, (_, i) =>
      makeSignal({
        repository_id: `repo-${i}`,
        repository_full_name: `acme/repo-${i}`,
        last_refresh_failed: true,
      }),
    );
    render(<RepositoryRefreshActivityPanelView summary={makeSummary(rows)} />);

    expect(screen.getAllByTestId('refresh-activity-repo-link')).toHaveLength(
      AFFECTED_REPOS_SHOWN,
    );
    expect(
      screen.getByText('+2 more repositories need attention.'),
    ).toBeInTheDocument();
  });

  test('all-healthy summary renders the healthy note instead of drill-in rows', () => {
    const summary = makeSummary([makeSignal()]);
    render(<RepositoryRefreshActivityPanelView summary={summary} />);
    expect(screen.queryAllByTestId('refresh-activity-repo-link')).toHaveLength(0);
    expect(
      screen.getByText('All repositories healthy — nothing stale, diverged, or failed.'),
    ).toBeInTheDocument();
  });

  test('empty summary renders the no-specs copy', () => {
    render(<RepositoryRefreshActivityPanelView summary={makeSummary([])} />);
    expect(screen.getByTestId('refresh-activity-card')).toHaveTextContent(
      'No imported specs tracked yet',
    );
    expect(
      screen.getByText(
        'Import a spec from a repository and its auto-refresh health will appear here.',
      ),
    ).toBeInTheDocument();
  });

  // ---- HIVE-7.3 ---------------------------------------------------------------------------

  test('every chip takes its tone from the shared status vocabulary', () => {
    // The ticket's "health states map to the shared status vocabulary" criterion, at the one
    // place the five refresh states are drawn. Asserted against `statusTone` rather than
    // against a literal, so a chip cannot drift from the badge that shares its word.
    for (const [code, tone] of Object.entries(REFRESH_STATUS_TONE)) {
      expect(statusTone(code)).toBe(tone);
    }
  });

  test('a zero chip recedes without being faded out of legibility', () => {
    // It used to be `opacity-50 grayscale`, which took a legible amber ink to roughly 2:1.
    const summary = makeSummary([makeSignal()]);
    render(<RepositoryRefreshActivityPanelView summary={summary} />);
    const zero = screen.getByTestId('refresh-activity-count-stale');
    expect(zero.className).not.toMatch(/opacity|grayscale/);
    // `outline` is how the vocabulary spells "set aside": a hairline, muted ink, no fill.
    expect(zero.className).toContain('text-fg-muted');
    // …and a state that has something in it keeps its own tone and its dot.
    const filled = screen.getByTestId('refresh-activity-count-up-to-date');
    expect(filled.className).toContain('bg-ok-soft');
    expect(within(filled).getByTestId('badge-dot')).toBeInTheDocument();
  });
});

describe('RepositoryRefreshActivityPanel (fetching wrapper)', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('loads signals, aggregates, and renders the card', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        signals: [
          makeSignal({
            repository_id: 'repo-two',
            repository_full_name: 'acme/two',
            last_refresh_failed: true,
          }),
        ],
      }),
    }) as unknown as typeof fetch;

    render(<RepositoryRefreshActivityPanel />);
    await waitFor(() =>
      expect(screen.getByTestId('refresh-activity-card')).toBeInTheDocument(),
    );
    expect(global.fetch).toHaveBeenCalledWith('/api/repositories/refresh-activity', {
      credentials: 'include',
    });
    expect(screen.getByTestId('refresh-activity-count-failed')).toHaveTextContent('Failed1');
    expect(screen.getAllByTestId('refresh-activity-repo-link')).toHaveLength(1);
  });

  test('surfaces API errors', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      statusText: 'Server exploded',
      json: async () => ({ success: false, error: 'Server exploded' }),
    }) as unknown as typeof fetch;

    render(<RepositoryRefreshActivityPanel />);
    await waitFor(() =>
      expect(screen.getByTestId('refresh-activity-error')).toHaveTextContent(
        'Server exploded',
      ),
    );
  });
});
