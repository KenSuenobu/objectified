/**
 * Repository detail → Files tab: *Import selected* opens the wizard the selection needs
 * (BLK-1.5, BLK-1.4).
 *
 * The Map & import wizard maps one specification at a time, so a multi-row selection used to
 * open it on the first file and tell the reader to re-select the rest afterward. One ticked
 * row still opens it; N rows open the batch wizard covering all N, from the same button.
 */

import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
// paths that were ticked, and that closing it hands control back.
const bulkProps: Array<{ paths: readonly string[]; repoUrl: string | null; branch: string }> = [];
let closeBulk: ((open: boolean) => void) | null = null;
jest.mock('@/app/components/ade/dashboard/repositories/RepositoryBulkImportPanel', () => ({
  RepositoryBulkImportPanel: (props: {
    paths: readonly string[];
    repoUrl: string | null;
    branch: string;
    onOpenChange: (open: boolean) => void;
  }) => {
    bulkProps.push({ paths: props.paths, repoUrl: props.repoUrl, branch: props.branch });
    closeBulk = props.onOpenChange;
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
  closeBulk = null;
  mockFiles();
});

describe('Files tab — importing a selection', () => {
  it('opens the single-file wizard while exactly one row is ticked', async () => {
    renderBrowser();
    await waitFor(() => expect(screen.getByText('openapi/orders.yaml')).toBeInTheDocument());

    tick('openapi/orders.yaml');

    const button = screen.getByTestId('repository-import-selected');
    expect(button).toBeEnabled();
    expect(button).toHaveTextContent('Import selected');
    expect(button).not.toHaveAttribute('data-batch');
    fireEvent.click(button);

    await waitFor(() => expect(screen.getByTestId('single-file-wizard')).toBeInTheDocument());
    expect(screen.queryByTestId('bulk-overlay')).not.toBeInTheDocument();
  });

  it('says how many the batch will cover once more than one row is ticked', async () => {
    renderBrowser();
    await waitFor(() => expect(screen.getByText('openapi/orders.yaml')).toBeInTheDocument());

    tick('openapi/orders.yaml');
    tick('events/shipping.asyncapi.yaml');

    const button = screen.getByTestId('repository-import-selected');
    expect(button).toBeEnabled();
    expect(button).toHaveTextContent('Import selected (2)');
    expect(button).toHaveAttribute('data-batch', 'true');
  });

  it('opens the batch with the ticked paths, the branch and the repository URL', async () => {
    renderBrowser();
    await waitFor(() => expect(screen.getByText('openapi/orders.yaml')).toBeInTheDocument());

    tick('openapi/orders.yaml');
    tick('events/shipping.asyncapi.yaml');
    fireEvent.click(screen.getByTestId('repository-import-selected'));

    await waitFor(() => expect(screen.getByTestId('bulk-overlay')).toBeInTheDocument());
    expect(bulkProps.at(-1)).toEqual({
      paths: ['openapi/orders.yaml', 'events/shipping.asyncapi.yaml'],
      repoUrl: 'https://github.com/acme/widgets',
      branch: 'main',
    });
    // Ticking many rows must not also open the one-file wizard.
    expect(screen.queryByTestId('single-file-wizard')).not.toBeInTheDocument();
  });

  it('closing the batch returns to the Files tab with the selection intact', async () => {
    // The HIVE-7.5 overlay guarantee: the wizard is drawn beside the list, not instead of it.
    renderBrowser();
    await waitFor(() => expect(screen.getByText('openapi/orders.yaml')).toBeInTheDocument());

    tick('openapi/orders.yaml');
    tick('events/shipping.asyncapi.yaml');
    fireEvent.click(screen.getByTestId('repository-import-selected'));
    await waitFor(() => expect(screen.getByTestId('bulk-overlay')).toBeInTheDocument());

    act(() => closeBulk?.(false));

    await waitFor(() => expect(screen.queryByTestId('bulk-overlay')).not.toBeInTheDocument());
    expect(screen.getByTestId('repository-files-summary')).toHaveTextContent('2 selected');
    expect(screen.getByTestId('repository-import-selected')).toHaveTextContent('Import selected (2)');
    // And the list was not re-read — the reader is where they were.
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1);
  });

  it('offers nothing to import while no row is ticked', async () => {
    renderBrowser();
    await waitFor(() => expect(screen.getByText('openapi/orders.yaml')).toBeInTheDocument());

    expect(screen.getByTestId('repository-import-selected')).toBeDisabled();
  });
});
