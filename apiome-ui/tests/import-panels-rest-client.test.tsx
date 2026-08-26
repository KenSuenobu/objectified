/**
 * The shared import panels reading a REST job (BLK-1.4, #5526).
 *
 * A bulk batch's rows are REST jobs, and the panels a row opens — `ImportCompletePanel` for a
 * finished item, `ImportExecutionPanel` for a live one — used to ask the in-process worker's
 * store about them and render "Import Failed · Job not found". Given `restImportJobClient`
 * they read the catalog import proxy instead, and draw only the verbs that store offers.
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

import ImportCompletePanel from '@/app/components/ade/dashboard/ImportCompletePanel';
import ImportExecutionPanel from '@/app/components/ade/dashboard/ImportExecutionPanel';
import { restImportJobClient } from '@/app/components/ade/import/importJobClient';

const localGetImportStatus = jest.fn();
jest.mock('@lib/db/import-actions', () => ({
  getImportStatus: (...args: unknown[]) => localGetImportStatus(...args),
  cancelImport: jest.fn(),
  commitImport: jest.fn(),
  rollbackImport: jest.fn(),
  rollbackCompletedImport: jest.fn(),
  retryImport: jest.fn(),
}));
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock('@/app/components/ade/dashboard/SchemaVersionScoringPanel', () => ({
  SchemaVersionScoringPanel: () => <div data-testid="scoring-panel" />,
}));

function restResponse(payload: Record<string, unknown>) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    statusText: 'OK',
    json: async () => ({ success: true, ...payload }),
  }) as unknown as typeof fetch;
}

const COMPLETED = {
  job_id: 'job-1',
  state: 'completed',
  percent: 100,
  events: [{ id: 'e1', ts: 1, level: 'info', code: 'DONE', message: 'Imported.' }],
  summary: {
    source: 'grpc',
    format: 'protobuf',
    counts: { services: 2, operations: 9, types: 14, channels: 0 },
    dry_run: false,
    persisted: true,
  },
  result: { project_id: 'p-1', project_slug: 'orders', version_id: '1.1.0', version_record_id: 'v-1' },
};

beforeEach(() => {
  jest.clearAllMocks();
  localGetImportStatus.mockResolvedValue({
    jobId: 'job-1',
    state: 'failed',
    percent: 0,
    events: [{ id: 'x', ts: 0, level: 'error', code: 'NOT_FOUND', message: 'Job not found' }],
  });
});

describe('ImportCompletePanel with the REST client', () => {
  it('reads the job from the catalog import proxy, not the worker store', async () => {
    restResponse(COMPLETED);

    render(<ImportCompletePanel jobId="job-1" client={restImportJobClient} />);

    await screen.findByText('Import Complete!');
    expect(global.fetch).toHaveBeenCalledWith('/api/catalog/import/job-1', { credentials: 'include' });
    expect(localGetImportStatus).not.toHaveBeenCalled();
    expect(screen.queryByText(/Job not found/)).not.toBeInTheDocument();
  });

  it('shows the adapter job’s types and operations as the summary’s classes and paths', async () => {
    restResponse(COMPLETED);

    const { container } = render(<ImportCompletePanel jobId="job-1" client={restImportJobClient} />);

    await screen.findByText('Import Complete!');
    expect(container).toHaveTextContent('14');
    expect(container).toHaveTextContent('9');
  });

  it('does not offer to undo an import the store cannot roll back', async () => {
    restResponse(COMPLETED);

    render(<ImportCompletePanel jobId="job-1" client={restImportJobClient} />);

    await screen.findByText('Import Complete!');
    expect(screen.queryByRole('button', { name: /Undo import/ })).not.toBeInTheDocument();
  });

  it('states a failed job’s typed error', async () => {
    restResponse({
      job_id: 'job-2',
      state: 'failed',
      percent: 40,
      events: [],
      error: { code: 'QUALITY_POLICY_BLOCKED', message: 'Import scores D, below the tenant floor of B.' },
    });

    const { container } = render(<ImportCompletePanel jobId="job-2" client={restImportJobClient} />);

    await screen.findByText('Import Failed');
    expect(container).toHaveTextContent('below the tenant floor');
  });
});

describe('ImportExecutionPanel with the REST client', () => {
  it('draws the live job with a cancel and nothing the store cannot do', async () => {
    restResponse({
      job_id: 'job-3',
      state: 'running',
      percent: 40,
      events: [],
      progress: { phase: 'creating-classes', total: 10, completed: 4 },
    });

    render(<ImportExecutionPanel jobId="job-3" client={restImportJobClient} isReviewing />);

    await waitFor(() => expect(screen.getByText('40%')).toBeInTheDocument());
    expect(localGetImportStatus).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Cancel import/ })).toBeInTheDocument();
  });

  it('offers no commit step for a job awaiting approval, and no retry for a failed one', async () => {
    restResponse({ job_id: 'job-4', state: 'pending-approval', percent: 100, events: [] });
    const { unmount } = render(
      <ImportExecutionPanel jobId="job-4" client={restImportJobClient} isReviewing />,
    );
    await waitFor(() => expect(screen.getByText('100%')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Accept & commit/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Reject & rollback/ })).not.toBeInTheDocument();
    unmount();

    restResponse({ job_id: 'job-5', state: 'failed', percent: 20, events: [] });
    render(
      <ImportExecutionPanel
        jobId="job-5"
        client={restImportJobClient}
        isReviewing
        onRetry={() => undefined}
      />,
    );
    await waitFor(() => expect(screen.getByText('20%')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Retry import/ })).not.toBeInTheDocument();
    // Cancelling a failed job is still offered, because the store offers it.
    expect(screen.getByRole('button', { name: /Cancel import/ })).toBeInTheDocument();
  });

  it('cancels through the proxy', async () => {
    restResponse({ job_id: 'job-6', state: 'running', percent: 10, events: [] });

    render(<ImportExecutionPanel jobId="job-6" client={restImportJobClient} isReviewing />);
    await waitFor(() => expect(screen.getByText('10%')).toBeInTheDocument());
    screen.getByRole('button', { name: /Cancel import/ }).click();

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith('/api/catalog/import/job-6', {
        method: 'DELETE',
        credentials: 'include',
      }),
    );
  });
});

describe('the panels without a client', () => {
  it('still read the worker store, exactly as before', async () => {
    render(<ImportCompletePanel jobId="job-1" />);

    await screen.findByText('Import Failed');
    expect(localGetImportStatus).toHaveBeenCalledWith('job-1');
  });
});
