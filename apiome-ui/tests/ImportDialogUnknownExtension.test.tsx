/**
 * The Projects importer accepts an unknown extension (FMT-1.1, #5412).
 *
 * `ImportDialog` used to hard-reject any file outside a ten-entry list with "Unsupported file
 * type", so a `.tsp`, `.cpy`, `.edi` or `.hl7` could not be imported even though its adapter is
 * registered and works. These tests drive the real dialog and assert the replacement behaviour:
 *
 *  - the picker's `accept` comes from `GET /api/import/sources`;
 *  - an unrecognized extension is *selected*, not refused, and carries an advisory notice;
 *  - drag-and-drop is equally permissive;
 *  - a document the local analyzer cannot place is routed to `POST /api/import/detect` and the
 *    detector's verdict is what the user is shown.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { jest } from '@jest/globals';

import ImportDialog from '../src/app/components/ade/dashboard/ImportDialog';
import type { ImportSourceDescriptor } from '../src/app/components/ade/dashboard/importSourceCatalog';

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

const SOURCES: ImportSourceDescriptor[] = [
  source('openapi', ['.yaml', '.yml', '.json', '.zip']),
  source('typespec', ['.tsp', '.cadl']),
  source('cobolcopybook', ['.cpy', '.cbl']),
  source('edix12', ['.edi', '.x12']),
  source('hl7v2', ['.hl7']),
];

/** The detector's verdict on a TypeSpec document. */
const TYPESPEC_DETECTION = {
  matched: true,
  ambiguous: false,
  detected: {
    format: 'typespec',
    confidence: 0.98,
    reason: 'typespec import marker',
    source_key: 'typespec',
    importable: true,
  },
};

/** A fetch mock serving the registry and the detector; other calls fail closed. */
function mockFetch(detection: unknown = TYPESPEC_DETECTION) {
  return jest.fn((input: unknown) => {
    const url = typeof input === 'string' ? input : String(input);
    if (url.includes('/api/import/sources')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, sources: SOURCES }) });
    }
    if (url.includes('/api/import/detect')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, ...(detection as object) }) });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  }) as unknown as jest.Mock;
}

/**
 * A `File` whose `text()` resolves in jsdom.
 *
 * jsdom's File does not implement `text()`, and the dialog reads the picked file with it.
 */
function fileOf(name: string, content: string): File {
  const file = new File([content], name);
  Object.defineProperty(file, 'text', { value: () => Promise.resolve(content) });
  return file;
}

/** Open the dialog on the File intake panel and hand back its file input. */
async function openFilePanel(): Promise<HTMLInputElement> {
  render(<ImportDialog open onClose={jest.fn()} tenantId="t1" userId="u1" variant="projects" />);
  await waitFor(() =>
    expect(global.fetch).toHaveBeenCalledWith('/api/import/sources', expect.anything()),
  );
  fireEvent.click(screen.getByRole('button', { name: /file upload/i }));
  // The dialog renders through a portal, so query the document rather than the render container.
  return await waitFor(() => {
    const input = document.querySelector('input[type="file"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    return input as HTMLInputElement;
  });
}

/** Put a file through the picker, as a user browsing to it would. */
function pick(input: HTMLInputElement, file: File) {
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  fireEvent.change(input);
}

beforeEach(() => {
  global.fetch = mockFetch() as unknown as typeof fetch;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('ImportDialog file intake', () => {
  it('derives the picker accept list from the registry, not a hard-coded array', async () => {
    const input = await openFilePanel();
    const accept = input.accept.split(',');
    expect(accept).toEqual(expect.arrayContaining(['.tsp', '.cadl', '.cpy', '.cbl', '.edi', '.hl7']));
  });

  it.each(['api.tsp', 'CUSTOMER.cpy', 'claims.edi', 'adt.hl7'])(
    'selects %s instead of rejecting it',
    async (name) => {
      const input = await openFilePanel();
      pick(input, fileOf(name, 'model Foo {}'));

      await waitFor(() => expect(screen.getByText(name)).toBeInTheDocument());
      expect(screen.queryByText(/Unsupported file type/i)).not.toBeInTheDocument();
    },
  );

  it('keeps a file whose extension no adapter claims, with an advisory notice', async () => {
    const input = await openFilePanel();
    pick(input, fileOf('mystery.bin', 'binary-ish'));

    await waitFor(() => expect(screen.getByTestId('import-advisory-notice')).toBeInTheDocument());
    expect(screen.getByTestId('import-advisory-notice')).toHaveTextContent(/mystery\.bin/);
    // Advisory, not a rejection: the file is still selected and there is no error alert.
    expect(screen.getByText('mystery.bin')).toBeInTheDocument();
    expect(screen.queryByText(/Unsupported file type/i)).not.toBeInTheDocument();
  });

  it('raises no advisory for an extension the registry does declare', async () => {
    const input = await openFilePanel();
    pick(input, fileOf('api.tsp', 'model Foo {}'));

    await waitFor(() => expect(screen.getByText('api.tsp')).toBeInTheDocument());
    expect(screen.queryByTestId('import-advisory-notice')).not.toBeInTheDocument();
  });

  it('accepts a dropped file of an unknown type so drag-and-drop stays permissive', async () => {
    const input = await openFilePanel();
    const zone = input.closest('label') as HTMLLabelElement;

    fireEvent.drop(zone, { dataTransfer: { files: [fileOf('trade.x12', 'ISA*00*')] } });

    await waitFor(() => expect(screen.getByText('trade.x12')).toBeInTheDocument());
    expect(screen.queryByText(/Unsupported file type/i)).not.toBeInTheDocument();
  });
});

describe('ImportDialog analysis of a format it cannot read', () => {
  it('routes the bytes to detection and reports the detector verdict', async () => {
    const input = await openFilePanel();
    pick(input, fileOf('api.tsp', 'import "@typespec/http";\nmodel Foo {}\n'));
    await waitFor(() => expect(screen.getByText('api.tsp')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /analyze/i }));

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith('/api/import/detect', expect.objectContaining({ method: 'POST' })),
    );
    await waitFor(() =>
      expect(screen.getByTestId('import-advisory-notice')).toHaveTextContent(/typespec/i),
    );
    expect(screen.getByTestId('import-advisory-notice')).toHaveTextContent(/Catalog importer/i);
  });

  it('leaves the analyzer own message standing when the detector recognizes nothing', async () => {
    global.fetch = mockFetch({ matched: false }) as unknown as typeof fetch;
    const input = await openFilePanel();
    pick(input, fileOf('mystery.bin', ' not a document'));
    await waitFor(() => expect(screen.getByText('mystery.bin')).toBeInTheDocument());

    // The pick-time advisory is replaced by the detector's (absent) verdict, not layered on top.
    fireEvent.click(screen.getByRole('button', { name: /analyze/i }));
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith('/api/import/detect', expect.objectContaining({ method: 'POST' })),
    );
    await waitFor(() => expect(screen.queryByTestId('import-advisory-notice')).not.toBeInTheDocument());
  });
});
