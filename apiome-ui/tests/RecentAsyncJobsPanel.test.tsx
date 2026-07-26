/**
 * RecentAsyncJobsPanel — paginated job list consumer (IXH-6.3, #5122).
 */

import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { RecentAsyncJobsPanel } from '../src/app/components/ade/dashboard/asyncJobs/RecentAsyncJobsPanel';

describe('RecentAsyncJobsPanel', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('fetches a bounded page from /api/export/jobs and renders rows', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        jobs: [
          { job_id: 'j1', state: 'completed', percent: 100, target: 'openapi', artifact: 'p1' },
        ],
        total: 1,
        limit: 10,
        offset: 0,
      }),
    }) as unknown as typeof fetch;

    render(<RecentAsyncJobsPanel kind="export" limit={10} />);

    await waitFor(() => {
      expect(screen.getByTestId('export-recent-jobs')).toBeInTheDocument();
      expect(screen.getByText('j1')).toBeInTheDocument();
      expect(screen.getByText('completed')).toBeInTheDocument();
    });

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/export/jobs?limit=10&offset=0',
      expect.objectContaining({ cache: 'no-store' }),
    );
    expect(screen.getByTestId('export-recent-jobs-pagination-summary')).toHaveTextContent(
      '1–1 of 1',
    );
  });

  it('pages via Next using offset/limit', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          jobs: [{ job_id: 'j1', state: 'completed', percent: 100 }],
          total: 12,
          limit: 10,
          offset: 0,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          jobs: [{ job_id: 'j11', state: 'failed', percent: 40 }],
          total: 12,
          limit: 10,
          offset: 10,
        }),
      });
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<RecentAsyncJobsPanel kind="import" limit={10} />);

    await waitFor(() => expect(screen.getByText('j1')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('import-recent-jobs-next-page'));
    await waitFor(() => expect(screen.getByText('j11')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/catalog/import?limit=10&offset=10',
      expect.anything(),
    );
  });
});
