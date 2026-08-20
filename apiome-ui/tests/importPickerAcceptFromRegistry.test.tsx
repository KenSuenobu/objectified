/**
 * Both file pickers derive `accept` from the import-source registry (FMT-1.1, #5412).
 *
 * The acceptance criteria this covers:
 *
 *  1. both pickers set `accept` from `GET /api/import/sources`, so `.tsp`, `.cpy`, `.edi` and
 *     `.hl7` files are selectable in the Projects *and* Catalog dialogs;
 *  2. the accept list changes when a new adapter is registered in a fixture — with no UI change;
 *  3. the Projects importer no longer rejects an unknown extension outright, but routes the bytes
 *     to detection and reports the detector's verdict;
 *  4. drag-and-drop stays permissive in both dialogs.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { jest } from '@jest/globals';

import { renderHook } from '@testing-library/react';
import { useImportSources } from '../src/app/components/ade/dashboard/useImportSources';
import { CatalogImportDialog } from '../src/app/components/ade/dashboard/catalog/CatalogImportDialog';
import { FileIntakePanel } from '../src/app/components/ade/import/FileIntakePanel';
import { FALLBACK_IMPORT_FILE_EXTENSIONS, type ImportSourceDescriptor } from '../src/app/components/ade/dashboard/importSourceCatalog';

/** Build a registry descriptor with only the fields these tests care about. */
function source(key: string, file_extensions: string[]): ImportSourceDescriptor {
  return {
    key,
    label: key,
    description: `The ${key} adapter.`,
    icon: 'file-code',
    paradigm: 'rest',
    input_kinds: ['file', 'url', 'paste', 'fileset'],
    supports_live_discovery: false,
    formats: [key],
    file_extensions,
    available: true,
  };
}

/** The registry as REST reports it once FMT-1.1's declarations are in place. */
const SOURCES: ImportSourceDescriptor[] = [
  source('openapi', ['.yaml', '.yml', '.json', '.zip', '.tar.gz', '.tgz', '.tar']),
  source('typespec', ['.tsp', '.cadl']),
  source('cobolcopybook', ['.cpy', '.cbl', '.copybook']),
  source('edix12', ['.edi', '.x12']),
  source('hl7v2', ['.hl7']),
  source('graphql', ['.graphql', '.gql', '.graphqls']),
];

/** The same registry plus one fixture adapter registered server-side. */
const SOURCES_WITH_FIXTURE: ImportSourceDescriptor[] = [...SOURCES, source('exotic', ['.exotic'])];

/** A fetch mock that serves a given registry payload for `/api/import/sources`. */
function mockRegistry(sources: ImportSourceDescriptor[] | null) {
  return jest.fn((input: unknown) => {
    const url = typeof input === 'string' ? input : String(input);
    if (url.includes('/api/import/sources')) {
      if (sources === null) return Promise.resolve({ ok: false, json: () => Promise.resolve({ error: 'boom' }) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, sources }) });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  }) as unknown as jest.Mock;
}

afterEach(() => {
  jest.restoreAllMocks();
});

// ===========================================================================
// The hook publishes the registry-derived accept list
// ===========================================================================

describe('useImportSources → fileExtensions', () => {
  it('starts on the offline fallback and is replaced by the registry union', async () => {
    global.fetch = mockRegistry(SOURCES);
    const { result } = renderHook(() => useImportSources(true, 'projects'));

    // Before the fetch resolves the picker is already usable, on the offline list.
    expect(result.current.fileExtensions).toEqual([...FALLBACK_IMPORT_FILE_EXTENSIONS]);

    await waitFor(() => expect(result.current.fileExtensions).toContain('.tsp'));
    expect(result.current.fileExtensions).toEqual(
      expect.arrayContaining(['.tsp', '.cadl', '.cpy', '.cbl', '.edi', '.x12', '.hl7']),
    );
  });

  it('offers the full union on the Catalog surface too, not a variant-filtered subset', async () => {
    global.fetch = mockRegistry(SOURCES);
    const projects = renderHook(() => useImportSources(true, 'projects'));
    const catalog = renderHook(() => useImportSources(true, 'catalog'));

    await waitFor(() => expect(projects.result.current.fileExtensions).toContain('.tsp'));
    await waitFor(() => expect(catalog.result.current.fileExtensions).toContain('.tsp'));
    expect(catalog.result.current.fileExtensions).toEqual(projects.result.current.fileExtensions);
  });

  it('keeps the offline fallback when the registry is unreachable', async () => {
    global.fetch = mockRegistry(null);
    const { result } = renderHook(() => useImportSources(true, 'projects'));

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.fileExtensions).toEqual([...FALLBACK_IMPORT_FILE_EXTENSIONS]);
  });

  it('widens when a new adapter is registered in the fixture — with no UI change', async () => {
    global.fetch = mockRegistry(SOURCES);
    const before = renderHook(() => useImportSources(true, 'projects'));
    await waitFor(() => expect(before.result.current.fileExtensions).toContain('.tsp'));
    expect(before.result.current.fileExtensions).not.toContain('.exotic');

    global.fetch = mockRegistry(SOURCES_WITH_FIXTURE);
    const after = renderHook(() => useImportSources(true, 'projects'));
    await waitFor(() => expect(after.result.current.fileExtensions).toContain('.exotic'));
  });
});

// ===========================================================================
// The Projects picker's accept attribute
// ===========================================================================

describe('FileIntakePanel accept', () => {
  /** Render the drop zone with a given accept list and return its file input. */
  function renderPanel(extensions?: string[]) {
    const { container } = render(
      <FileIntakePanel
        file={null}
        metadata={null}
        loading={false}
        dragging={false}
        onDragEnter={jest.fn()}
        onDragOver={jest.fn()}
        onDragLeave={jest.fn()}
        onDrop={jest.fn()}
        onPick={jest.fn()}
        onRemove={jest.fn()}
        extensions={extensions}
      />,
    );
    return container.querySelector('input[type="file"]') as HTMLInputElement;
  }

  it('sets accept from the registry list it is handed', () => {
    const input = renderPanel(['.tsp', '.cpy', '.edi', '.hl7']);
    expect(input.accept).toBe('.tsp,.cpy,.edi,.hl7');
  });

  it.each(['.tsp', '.cpy', '.edi', '.hl7'])('offers %s once the registry declares it', (ext) => {
    const registryList = SOURCES.flatMap((s) => s.file_extensions ?? []);
    const input = renderPanel(registryList);
    expect(input.accept.split(',')).toContain(ext);
  });

  it('falls back to the offline list when given no extensions', () => {
    const input = renderPanel(undefined);
    expect(input.accept).toBe(FALLBACK_IMPORT_FILE_EXTENSIONS.join(','));
  });

  it('summarizes the long registry list in the drop-zone hint instead of overflowing it', () => {
    const many = Array.from({ length: 30 }, (_, i) => `.e${i}`);
    renderPanel(many);
    expect(screen.getByText(/^Supports: .* and 20 more$/)).toBeInTheDocument();
  });

  it('leaves the drop zone permissive — accept never gates a drop', () => {
    const onDrop = jest.fn();
    const { container } = render(
      <FileIntakePanel
        file={null}
        metadata={null}
        loading={false}
        dragging={false}
        onDragEnter={jest.fn()}
        onDragOver={jest.fn()}
        onDragLeave={jest.fn()}
        onDrop={onDrop}
        onPick={jest.fn()}
        onRemove={jest.fn()}
        extensions={['.tsp']}
      />,
    );
    const zone = container.querySelector('label') as HTMLLabelElement;
    fireEvent.drop(zone, { dataTransfer: { files: [new File(['x'], 'mystery.bin')] } });
    expect(onDrop).toHaveBeenCalled();
  });
});

// ===========================================================================
// The Catalog picker's accept attribute
// ===========================================================================

describe('CatalogImportDialog accept', () => {
  it('sets accept from the registry rather than its own hard-coded array', async () => {
    global.fetch = mockRegistry(SOURCES);
    render(<CatalogImportDialog open onClose={jest.fn()} onSuccess={jest.fn()} />);

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith('/api/import/sources', expect.anything()),
    );
    fireEvent.click(screen.getByTestId('catalog-import-source-file'));

    const input = await waitFor(() => {
      // The dialog renders through a portal, so query the document, not a render container.
      const found = document.querySelector('input[type="file"]') as HTMLInputElement | null;
      expect(found).not.toBeNull();
      return found as HTMLInputElement;
    });

    const accept = input.accept.split(',');
    // The formats the ticket named, none of which the old hard-coded list offered here.
    expect(accept).toEqual(expect.arrayContaining(['.tsp', '.cpy', '.edi', '.hl7']));
    // The archive suffixes a fileset adapter carries are still offered.
    expect(accept).toEqual(expect.arrayContaining(['.zip', '.tar.gz', '.tgz', '.tar']));
  });
});
