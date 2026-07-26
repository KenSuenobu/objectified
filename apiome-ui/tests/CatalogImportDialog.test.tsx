/**
 * CatalogImportDialog — stepped import shell + source grid (MFI-26.1, #4094).
 *
 * These tests cover the two acceptance criteria for the foundation ticket:
 *  1. The source grid renders from a mocked `GET /api/import/sources` response and offers EXACTLY the
 *     three base intake methods (File / URL / Clipboard). Per the §0.3 routing policy (#4101), no
 *     built-in non-base tile (e.g. Git) and no registry-contributed / live-discovery tile (e.g. a
 *     GraphQL introspection tile) may appear — even though those sources are present in the response.
 *  2. The stepper advances Source → Detect & route → Options and steps back again.
 *
 * The registry endpoint is fetched by both `useImportSources` and `useCatalogImportAvailability`, and
 * detection posts to `/api/import/detect`; a single URL-routing fetch mock serves all three.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { jest } from '@jest/globals';

import { CatalogImportDialog } from '../src/app/components/ade/dashboard/catalog/CatalogImportDialog';
import type { ImportSourceDescriptor } from '../src/app/components/ade/dashboard/importSourceCatalog';

/**
 * A registry response that includes a live-discovery source (GraphQL) alongside the base intake
 * kinds, so the test proves the grid stays restricted to File / URL / Clipboard regardless.
 */
const SOURCES: ImportSourceDescriptor[] = [
  {
    key: 'graphql',
    label: 'GraphQL',
    description: 'Import a GraphQL schema from SDL or live endpoint introspection.',
    icon: 'waypoints',
    paradigm: 'graph',
    input_kinds: ['file', 'url', 'paste', 'discovery'],
    supports_live_discovery: true,
    formats: ['graphql'],
    available: true,
  },
];

/** A detection response routing a pasted GraphQL SDL into the catalog (adapter-backed). */
const DETECTION = {
  matched: true,
  detected: { format: 'graphql', confidence: 0.95, reason: 'SDL type definitions', importable: true },
};

function mockFetch(): jest.Mock {
  return jest.fn((input: unknown) => {
    const url = typeof input === 'string' ? input : String(input);
    if (url.includes('/api/import/sources')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, sources: SOURCES }) });
    }
    if (url.includes('/api/import/detect')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(DETECTION) });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  }) as unknown as jest.Mock;
}

describe('CatalogImportDialog — source grid (MFI-26.1)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders exactly the three base intake tiles from the sources response', async () => {
    const fetchMock = mockFetch();
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<CatalogImportDialog open onClose={jest.fn()} />);

    // The registry is fetched while the dialog is open (source cards + availability).
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/import/sources', expect.anything()),
    );

    // The three base intake methods render with the labels advertised by the registry cards.
    expect(screen.getByTestId('catalog-import-source-file')).toBeInTheDocument();
    expect(screen.getByTestId('catalog-import-source-url')).toBeInTheDocument();
    expect(screen.getByTestId('catalog-import-source-paste')).toBeInTheDocument();
    expect(screen.getByText('File Upload')).toBeInTheDocument();
    expect(screen.getByText('URL Import')).toBeInTheDocument();
    expect(screen.getByText('Clipboard Paste')).toBeInTheDocument();

    // A built-in non-base source (Git) is present in the merged cards but must NOT get a tile.
    expect(screen.queryByTestId('catalog-import-source-git')).not.toBeInTheDocument();

    // No live-discovery / registry tile leaks in from the response.
    expect(screen.queryByText(/introspection tile/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/reflection/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/schema registry/i)).not.toBeInTheDocument();
  });

  it('advances the stepper Source → Detect → Options and steps back', async () => {
    const fetchMock = mockFetch();
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<CatalogImportDialog open onClose={jest.fn()} />);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/import/sources', expect.anything()),
    );

    // Step 1 (Source): switch to the Clipboard method and paste content.
    fireEvent.click(screen.getByTestId('catalog-import-source-paste'));
    const textarea = screen.getByLabelText('Source content');
    fireEvent.change(textarea, { target: { value: 'type Query { hello: String }' } });
    fireEvent.click(screen.getByRole('button', { name: /detect pasted source/i }));

    // Step 2 (Detect & route): detection surfaces the format and its confidence.
    await waitFor(() => expect(screen.getByText(/Auto-detected:/i)).toBeInTheDocument());
    expect(screen.getByText(/95% confidence/i)).toBeInTheDocument();

    // Advance to step 3 (Options).
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    await waitFor(() => expect(screen.getByText(/kept verbatim/i)).toBeInTheDocument());

    // Step back to Detect & route.
    fireEvent.click(screen.getByRole('button', { name: /^back$/i }));
    await waitFor(() => expect(screen.getByText(/Auto-detected:/i)).toBeInTheDocument());
  });

  it('explains the empty Options step when the format has nothing to configure', async () => {
    const fetchMock = mockFetch();
    global.fetch = fetchMock as unknown as typeof fetch;

    render(<CatalogImportDialog open onClose={jest.fn()} />);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/import/sources', expect.anything()),
    );

    fireEvent.click(screen.getByTestId('catalog-import-source-paste'));
    fireEvent.change(screen.getByLabelText('Source content'), {
      target: { value: 'type Query { hello: String }' },
    });
    fireEvent.click(screen.getByRole('button', { name: /detect pasted source/i }));
    await waitFor(() => expect(screen.getByText(/Auto-detected:/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));

    // GraphQL is stored verbatim — there is nothing to configure, so the card says so instead of
    // leaving the panel blank.
    const card = await screen.findByTestId('catalog-import-no-options');
    expect(
      await screen.findByRole('heading', { name: 'No additional options' }),
    ).toBeInTheDocument();
    expect(card).toHaveTextContent('No additional options are available for this data type');
  });
});
