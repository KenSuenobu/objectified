/**
 * Repository detail → Files tab: the per-spec Quality column (REPO-2.8, #2769).
 *
 * Integration coverage for the acceptance criterion "score is visible in the Repository detail
 * Files tab": the browser renders one Quality cell per row, showing the score for a scored
 * spec and an explained em dash for every file that has none — including the `unknown_spec`
 * rows the scorer deliberately skips.
 */

import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

import {
  RepositoryFilesBrowser,
  type RepositoryFileApiRow,
} from '../src/app/components/ade/dashboard/repositories/RepositoryFilesBrowser';

jest.mock('sonner', () => ({ toast: { error: jest.fn(), success: jest.fn() } }));

// The two drawer children are irrelevant here and pull in the React Flow stylesheet, which
// Jest cannot parse. Stubbing them keeps this test on the table it is actually about.
jest.mock('@/app/components/ade/dashboard/repositories/RepositoryFileDetail', () => ({
  RepositoryFileDetail: () => null,
}));
jest.mock('@/app/components/ade/dashboard/repositories/RepositoryFileImportMapping', () => ({
  RepositoryFileImportMapping: () => null,
}));

function makeFile(overrides: Partial<RepositoryFileApiRow> = {}): RepositoryFileApiRow {
  return {
    id: 'file-1',
    path: 'api/openapi.yaml',
    name: 'openapi.yaml',
    ext: 'yaml',
    size_bytes: 2048,
    blob_sha: 'abc1234def',
    detected_kind: 'openapi-candidate',
    display_kind: 'OpenAPI',
    confidence: 'filename',
    ...overrides,
  };
}

function mockFilesResponse(files: RepositoryFileApiRow[]) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    statusText: 'OK',
    json: async () => ({
      success: true,
      branch: 'main',
      branches: ['main'],
      indexed_total: files.length,
      match_count: files.length,
      importable_match_count: files.length,
      limit: 50,
      offset: 0,
      files,
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

/** The Quality cell badges, in row order. */
async function qualityCells(): Promise<HTMLElement[]> {
  return waitFor(async () => {
    const cells = await screen.findAllByTestId('repository-file-quality');
    expect(cells.length).toBeGreaterThan(0);
    return cells;
  });
}

describe('Files tab quality column', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  it('renders a Quality column header', async () => {
    mockFilesResponse([makeFile({ quality_score: 91, quality_grade: 'A', quality_status: 'scored' })]);
    renderBrowser();

    expect(await screen.findByRole('columnheader', { name: 'Quality' })).toBeInTheDocument();
  });

  it('shows the score for a scored spec', async () => {
    mockFilesResponse([makeFile({ quality_score: 91, quality_grade: 'A', quality_status: 'scored' })]);
    renderBrowser();

    const [cell] = await qualityCells();
    expect(cell).toHaveTextContent('91');
    expect(cell).toHaveAttribute('title', expect.stringContaining('91/100'));
  });

  it('shows an explained em dash for a file the scorer skipped as unknown', async () => {
    mockFilesResponse([
      makeFile({
        id: 'file-2',
        path: 'package.json',
        display_kind: 'JSON (unclassified)',
        detected_kind: 'json-candidate',
        quality_status: 'skipped',
        quality_reason: 'unclassified',
      }),
    ]);
    renderBrowser();

    const [cell] = await qualityCells();
    expect(cell).toHaveTextContent('—');
    expect(cell.getAttribute('title')).toMatch(/classified spec/i);
  });

  it('shows a pending em dash for a row that has not been scored yet', async () => {
    mockFilesResponse([makeFile({ id: 'file-3' })]);
    renderBrowser();

    const [cell] = await qualityCells();
    expect(cell).toHaveTextContent('—');
    expect(cell.getAttribute('title')).toMatch(/not scored yet/i);
  });

  it('renders one Quality cell per row, in row order', async () => {
    mockFilesResponse([
      makeFile({ id: 'a', path: 'a/openapi.yaml', quality_score: 95, quality_status: 'scored' }),
      makeFile({ id: 'b', path: 'b/openapi.yaml', quality_score: 42, quality_status: 'scored' }),
      makeFile({ id: 'c', path: 'c/schema.graphql', quality_status: 'error', quality_reason: 'parse-failed' }),
    ]);
    renderBrowser();

    const cells = await qualityCells();
    expect(cells.map((c) => c.textContent)).toEqual(['95', '42', '—']);
  });

  it('keeps every other file column intact alongside the new one', async () => {
    mockFilesResponse([makeFile({ quality_score: 91, quality_status: 'scored' })]);
    renderBrowser();

    const row = (await screen.findByText('api/openapi.yaml')).closest('tr') as HTMLElement;
    expect(within(row).getByText('OpenAPI')).toBeInTheDocument();
    expect(within(row).getByText('filename')).toBeInTheDocument();
    expect(within(row).getByText('2.0 KB')).toBeInTheDocument();
    expect(within(row).getByText('abc1234')).toBeInTheDocument();
  });
});
