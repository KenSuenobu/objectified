/**
 * CatalogImportDialog — JSON Schema catalog import (MFI-26.7, #4102).
 *
 * JSON Schema is adapter-backed and routes directly to the catalog store-raw flow,
 * like GraphQL. The dialog shows the standard "Store in catalog" note and persists
 * the document via `/api/catalog/import` with `source_kind: 'json-schema'` — from the
 * quality step's confirmation, since IXH-2.2 moved the commit behind the pre-flight gate.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { jest } from '@jest/globals';

import { CatalogImportDialog } from '../src/app/components/ade/dashboard/catalog/CatalogImportDialog';
import type { ImportSourceDescriptor } from '../src/app/components/ade/dashboard/importSourceCatalog';

const SOURCES: ImportSourceDescriptor[] = [
  {
    key: 'json-schema',
    label: 'JSON Schema',
    description: 'Import a JSON Schema (2020-12 and variants) into the catalog as a schemas-only source.',
    icon: 'braces',
    paradigm: 'data_schema',
    input_kinds: ['file', 'url', 'paste'],
    supports_live_discovery: false,
    formats: ['json-schema'],
    available: true,
  },
];

const JSON_SCHEMA_DOC = JSON.stringify({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'User',
  type: 'object',
  properties: { id: { type: 'string' } },
});

/** A clean, non-blocking pre-flight verdict, so the quality step allows the commit (IXH-2.2). */
const PREFLIGHT = {
  ok: true,
  detection: { adapter_key: 'json-schema', confidence: 0.95, matched: true, importable: true },
  lint: { score: 95, grade: 'A', report_fingerprint: 'fp', severity_counts: { error: 0, warning: 0, info: 0 }, findings: [] },
  style_guide: { guide_id: null, name: 'Apiome defaults', source: 'fallback', fingerprint: 'sg' },
  policy: {
    verdict: 'pass',
    blocking: false,
    source: 'default',
    reason: 'No import quality policy is configured.',
    threshold_score: null,
    allow_override: true,
  },
  cache: { hit: false, key: 'k', content_hash: 'sha' },
};

function mockFetch(detection: unknown, opts: { jobState?: string } = {}): jest.Mock {
  const calls: Array<{ url: string; body?: unknown }> = [];
  const fn = jest.fn((input: unknown, init?: { body?: string }) => {
    const url = typeof input === 'string' ? input : String(input);
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    if (url.includes('/api/import/sources')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, sources: SOURCES }) });
    }
    if (url.includes('/api/import/detect')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(detection) });
    }
    if (url.includes('/api/import/preflight')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, ...PREFLIGHT }) });
    }
    if (url.match(/\/api\/catalog\/import\/.+/)) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, state: opts.jobState ?? 'completed' }),
      });
    }
    if (url.includes('/api/catalog/import')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, job_id: 'job-1' }) });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  }) as unknown as jest.Mock;
  (fn as unknown as { calls: typeof calls }).calls = calls;
  return fn;
}

async function pasteAndDetect(text: string) {
  fireEvent.click(screen.getByTestId('catalog-import-source-paste'));
  fireEvent.change(screen.getByLabelText('Source content'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: /detect pasted source/i }));
  await waitFor(() => expect(screen.getByText(/Auto-detected:/i)).toBeInTheDocument());
}

function recordedCalls(fetchMock: jest.Mock): Array<{ url: string; body?: unknown }> {
  return (fetchMock as unknown as { calls: Array<{ url: string; body?: unknown }> }).calls;
}

describe('CatalogImportDialog — JSON Schema catalog import (MFI-26.7)', () => {
  afterEach(() => jest.restoreAllMocks());

  const jsonSchemaDetection = {
    matched: true,
    detected: {
      format: 'json-schema-2020-12',
      confidence: 0.95,
      reason: '`$schema` JSON Schema 2020-12 marker',
      importable: true,
    },
  };

  it('routes JSON Schema directly to the catalog', async () => {
    global.fetch = mockFetch(jsonSchemaDetection) as unknown as typeof fetch;
    render(<CatalogImportDialog open onClose={jest.fn()} onJsonSchemaAsCurrent={jest.fn()} />);
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith('/api/import/sources', expect.anything()),
    );
    await pasteAndDetect(JSON_SCHEMA_DOC);

    expect(screen.getByText(/Routing decision → Catalog/i)).toBeInTheDocument();
    expect(screen.queryByText(/Choose destination/i)).not.toBeInTheDocument();
  });

  it('stores a non-publishable catalog item via the json-schema adapter', async () => {
    const fetchMock = mockFetch(jsonSchemaDetection, { jobState: 'completed' });
    global.fetch = fetchMock as unknown as typeof fetch;
    const onSuccess = jest.fn();
    render(
      <CatalogImportDialog open onClose={jest.fn()} onSuccess={onSuccess} onJsonSchemaAsCurrent={jest.fn()} />,
    );
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith('/api/import/sources', expect.anything()),
    );
    await pasteAndDetect(JSON_SCHEMA_DOC);

    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    expect(screen.getAllByText(/Store in catalog/i).length).toBeGreaterThan(0);

    // The commit is the quality step's confirmation now, not the options step's button (IXH-2.2).
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    await waitFor(() => expect(screen.getByTestId('import-quality-grade')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('import-quality-import'));

    await waitFor(() => expect(onSuccess).toHaveBeenCalled(), { timeout: 3000 });

    const startCall = recordedCalls(fetchMock).find(
      (c) => c.url === '/api/catalog/import' && (c.body as { metadata?: unknown })?.metadata,
    );
    expect(startCall).toBeDefined();
    expect((startCall?.body as { metadata: { source_kind: string } }).metadata.source_kind).toBe(
      'json-schema',
    );
  });

  it('does not prompt for OpenAPI (Projects) or GraphQL (catalog)', async () => {
    global.fetch = mockFetch({
      matched: true,
      detected: { format: 'openapi-3.1', confidence: 0.99, reason: '`openapi` marker', importable: true },
    }) as unknown as typeof fetch;
    const { unmount } = render(<CatalogImportDialog open onClose={jest.fn()} />);
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith('/api/import/sources', expect.anything()),
    );
    await pasteAndDetect('openapi: 3.1.0');
    expect(screen.getByText(/Routing decision → Projects/i)).toBeInTheDocument();
    expect(screen.queryByText(/Choose destination/i)).not.toBeInTheDocument();
    unmount();

    global.fetch = mockFetch({
      matched: true,
      detected: { format: 'graphql', confidence: 0.95, reason: 'SDL', importable: true },
    }) as unknown as typeof fetch;
    render(<CatalogImportDialog open onClose={jest.fn()} />);
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith('/api/import/sources', expect.anything()),
    );
    await pasteAndDetect('type Query { hello: String }');
    expect(screen.getByText(/Routing decision → Catalog/i)).toBeInTheDocument();
    expect(screen.queryByText(/Choose destination/i)).not.toBeInTheDocument();
  });
});
