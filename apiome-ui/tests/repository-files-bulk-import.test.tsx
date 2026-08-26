/**
 * Repository detail → Files tab: ticking more than one row offers the batch (BLK-1.5).
 *
 * The Map & import wizard maps one specification at a time, so a multi-row selection used to
 * open it on the first file and tell the reader to re-select the rest afterward. Ticking N rows
 * now offers *Import Bulk Items* instead, which plans the ticked paths as one batch.
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

import {
  RepositoryFilesBrowser,
  type RepositoryFileApiRow,
} from '../src/app/components/ade/dashboard/repositories/RepositoryFilesBrowser';

jest.mock('sonner', () => ({
  toast: { error: jest.fn(), success: jest.fn(), message: jest.fn() },
}));

jest.mock('@/app/components/ade/dashboard/repositories/RepositoryFileDetail', () => ({
  RepositoryFileDetail: () => null,
}));
jest.mock('@/app/components/ade/dashboard/repositories/RepositoryFileImportMapping', () => ({
  RepositoryFileImportMapping: () => <div data-testid="single-file-wizard" />,
}));

// The batch overlay is exercised on its own; here it only has to prove it was opened with the
// paths that were ticked.
const bulkProps: Array<{ paths: readonly string[]; repoUrl: string | null; branch: string }> = [];
jest.mock('@/app/components/ade/dashboard/repositories/RepositoryBulkImportPanel', () => ({
  RepositoryBulkImportPanel: (props: {
    paths: readonly string[];
    repoUrl: string | null;
    branch: string;
  }) => {
    bulkProps.push({ paths: props.paths, repoUrl: props.repoUrl, branch: props.branch });
    return <div data-testid="bulk-overlay" />;
  },
}));

const FILES: RepositoryFileApiRow[] = [
  {
    id: 'file-1',
    path: 'openapi/orders.yaml',
    name: 'orders.yaml',
    ext: 'yaml',
    size_bytes: 512,
    blob_sha: 'aaa1111',
    detected_kind: 'openapi-candidate',
    display_kind: 'OpenAPI',
    confidence: 'content',
  },
  {
    id: 'file-2',
    path: 'events/shipping.asyncapi.yaml',
    name: 'shipping.asyncapi.yaml',
    ext: 'yaml',
    size_bytes: 256,
    blob_sha: 'bbb2222',
    detected_kind: 'asyncapi-candidate',
    display_kind: 'AsyncAPI',
    confidence: 'content',
  },
];

function mockFiles(): void {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    statusText: 'OK',
    json: async () => ({
      success: true,
      branch: 'main',
      branches: ['main'],
      indexed_total: FILES.length,
      match_count: FILES.length,
      importable_match_count: FILES.length,
      limit: 50,
      offset: 0,
      files: FILES,
    }),
  }) as unknown as typeof fetch;
}

function renderBrowser() {
  return render(
    <RepositoryFilesBrowser
      repositoryId="11111111-1111-1111-1111-111111111111"
      defaultBranch="main"
      repositoryName="widgets"
      repositoryFullName="acme/widgets"
      githubWebBase="https://github.com/acme/widgets"
    />
  );
}

/** Tick a file's row checkbox. */
function tick(path: string): void {
  const box = screen.getByRole('checkbox', { name: new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') });
  fireEvent.click(box);
}

beforeEach(() => {
  jest.clearAllMocks();
  bulkProps.length = 0;
  mockFiles();
});

describe('Files tab — importing a selection', () => {
  it('offers the single-file wizard while exactly one row is ticked', async () => {
    renderBrowser();
    await waitFor(() => expect(screen.getByText('openapi/orders.yaml')).toBeInTheDocument());

    tick('openapi/orders.yaml');

    expect(screen.getByTestId('repository-import-selected')).toBeEnabled();
    expect(screen.queryByTestId('repository-import-bulk')).not.toBeInTheDocument();
  });

  it('offers Import Bulk Items once more than one row is ticked', async () => {
    renderBrowser();
    await waitFor(() => expect(screen.getByText('openapi/orders.yaml')).toBeInTheDocument());

    tick('openapi/orders.yaml');
    tick('events/shipping.asyncapi.yaml');

    const bulk = screen.getByTestId('repository-import-bulk');
    expect(bulk).toBeEnabled();
    expect(bulk).toHaveTextContent('Import Bulk Items (2)');
    // The one-at-a-time wizard is not the offer for a multi-row selection.
    expect(screen.queryByTestId('repository-import-selected')).not.toBeInTheDocument();
  });

  it('opens the batch with the ticked paths, the branch and the repository URL', async () => {
    renderBrowser();
    await waitFor(() => expect(screen.getByText('openapi/orders.yaml')).toBeInTheDocument());

    tick('openapi/orders.yaml');
    tick('events/shipping.asyncapi.yaml');
    fireEvent.click(screen.getByTestId('repository-import-bulk'));

    await waitFor(() => expect(screen.getByTestId('bulk-overlay')).toBeInTheDocument());
    expect(bulkProps.at(-1)).toEqual({
      paths: ['openapi/orders.yaml', 'events/shipping.asyncapi.yaml'],
      repoUrl: 'https://github.com/acme/widgets',
      branch: 'main',
    });
    // Ticking many rows must not also open the one-file wizard.
    expect(screen.queryByTestId('single-file-wizard')).not.toBeInTheDocument();
  });

  it('offers nothing to import while no row is ticked', async () => {
    renderBrowser();
    await waitFor(() => expect(screen.getByText('openapi/orders.yaml')).toBeInTheDocument());

    expect(screen.getByTestId('repository-import-selected')).toBeDisabled();
    expect(screen.queryByTestId('repository-import-bulk')).not.toBeInTheDocument();
  });
});
