/**
 * CatalogImportDialog — the detect step's Monaco source preview.
 *
 * The "Detect & route" step shows the bytes that were just detected in the shared read-only Monaco
 * viewer ({@link ../src/app/components/ade/dashboard/export/ReadOnlyCodeViewer}) instead of a plain
 * `<pre>`, so the source is syntax highlighted while the user confirms the routing. These tests pin
 * that contract: the editor renders with the whole source (no truncation), its language follows the
 * detected format, and a format override re-highlights it.
 *
 * Monaco itself is stubbed — the editor chunk never loads under jsdom — so the assertions run
 * against the viewer's container (`data-language`) and the stub's rendered value.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { jest } from '@jest/globals';

// The real editor cannot load in jsdom; render its value into a textarea instead.
jest.mock('@monaco-editor/react', () => ({
  __esModule: true,
  default: (props: { value?: string }) => (
    <textarea data-testid="mock-monaco" readOnly value={props.value ?? ''} />
  ),
}));

import { CatalogImportDialog } from '../src/app/components/ade/dashboard/catalog/CatalogImportDialog';
import type { ImportSourceDescriptor } from '../src/app/components/ade/dashboard/importSourceCatalog';

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

/** Route the registry + a supplied detection response through one fetch mock. */
function mockFetch(detection: unknown): jest.Mock {
  return jest.fn((input: unknown) => {
    const url = typeof input === 'string' ? input : String(input);
    if (url.includes('/api/import/sources')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, sources: SOURCES }) });
    }
    if (url.includes('/api/import/detect')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(detection) });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  }) as unknown as jest.Mock;
}

/** Drive Source → Detect by pasting content and detecting it. */
async function pasteAndDetect(text: string) {
  fireEvent.click(screen.getByTestId('catalog-import-source-paste'));
  fireEvent.change(screen.getByLabelText('Source content'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: /detect pasted source/i }));
  await waitFor(() => expect(screen.getByText(/Auto-detected:/i)).toBeInTheDocument());
}

describe('CatalogImportDialog — detect-step source preview', () => {
  afterEach(() => jest.restoreAllMocks());

  it('renders the detected source in Monaco with the format language', async () => {
    global.fetch = mockFetch({
      matched: true,
      detected: { format: 'graphql', confidence: 0.95, reason: 'SDL type definitions', importable: true },
    }) as unknown as typeof fetch;

    render(<CatalogImportDialog open onClose={jest.fn()} />);
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith('/api/import/sources', expect.anything()),
    );
    await pasteAndDetect('type Query { hello: String }');

    const editor = screen.getByTestId('catalog-import-preview-editor');
    expect(editor).toHaveAttribute('data-language', 'graphql');
    expect(await screen.findByTestId('mock-monaco')).toHaveValue('type Query { hello: String }');
  });

  it('shows the whole source, past the old 4000-character preview cap', async () => {
    const long = `# header\n${'a'.repeat(6000)}`;
    global.fetch = mockFetch({
      matched: true,
      detected: { format: 'graphql', confidence: 0.9, importable: true },
    }) as unknown as typeof fetch;

    render(<CatalogImportDialog open onClose={jest.fn()} />);
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith('/api/import/sources', expect.anything()),
    );
    await pasteAndDetect(long);

    expect(await screen.findByTestId('mock-monaco')).toHaveValue(long);
  });

  it('re-highlights the preview when the ambiguous format is overridden', async () => {
    global.fetch = mockFetch({
      matched: true,
      detected: { format: 'graphql', confidence: 0.55, importable: true },
      ambiguous: true,
      ambiguous_candidates: [
        { format: 'graphql', confidence: 0.55, importable: true },
        { format: 'protobuf', confidence: 0.52, importable: true },
      ],
    }) as unknown as typeof fetch;

    render(<CatalogImportDialog open onClose={jest.fn()} />);
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith('/api/import/sources', expect.anything()),
    );
    await pasteAndDetect('type Query { hello: String }');

    expect(screen.getByTestId('catalog-import-preview-editor')).toHaveAttribute(
      'data-language',
      'graphql',
    );

    fireEvent.change(screen.getByLabelText(/import as format/i), { target: { value: 'protobuf' } });

    expect(screen.getByTestId('catalog-import-preview-editor')).toHaveAttribute(
      'data-language',
      'protobuf',
    );
  });
});
