/**
 * CatalogImportDialog — URL + clipboard/paste intake (MFI-26.2, #4095).
 *
 * These tests exercise the two non-file intake paths end to end — Source → Detect & route →
 * Options → Quality → Import (the quality gate is IXH-2.2) — with the import job engine mocked:
 *
 *  1. URL Import: fetch a remote document, detect it, store it in the catalog, and poll the job to
 *     completion. Asserts the start request carries `source_kind: 'graphql'` (the adapter) AND
 *     `options.input_kind: 'url'` (the intake method the source-material badge reflects).
 *  2. Clipboard Paste: the same flow from pasted SDL, asserting `options.input_kind: 'paste'`.
 *  3. Errors are surfaced when the import fails to start.
 *
 * The registry (`/api/import/sources`), detection (`/api/import/detect`), the pre-flight
 * (`POST /api/import/preflight`), the raw URL fetch, the import start (`POST /api/catalog/import`)
 * and the job poll (`GET /api/catalog/import/{id}`) are all served by a single routing fetch mock
 * that records the start request bodies for assertion.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { jest } from '@jest/globals';

import { CatalogImportDialog } from '../src/app/components/ade/dashboard/catalog/CatalogImportDialog';
import type { ImportSourceDescriptor } from '../src/app/components/ade/dashboard/importSourceCatalog';

const SDL = 'type Query { hello: String }';
const REMOTE_URL = 'https://api.example.com/schema.graphql';

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

const DETECTION = {
  matched: true,
  detected: { format: 'graphql', confidence: 0.95, reason: 'SDL type definitions', importable: true },
};

/** A clean, non-blocking pre-flight verdict, so the quality step allows the commit. */
const PREFLIGHT = {
  ok: true,
  detection: { adapter_key: 'graphql', confidence: 0.95, matched: true, importable: true },
  lint: { score: 91, grade: 'A', report_fingerprint: 'fp', severity_counts: { error: 0, warning: 0, info: 0 }, findings: [] },
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

interface StartCall {
  body: Record<string, unknown>;
}

/**
 * A routing fetch mock covering every request the intake flow makes. Recorded import-start request
 * bodies are pushed onto `starts` so a test can assert the `source_kind` / `input_kind` it sent.
 */
function mockFetch(starts: StartCall[]): jest.Mock {
  return jest.fn((input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    const method = (init?.method || 'GET').toUpperCase();

    if (url.includes('/api/import/sources')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, sources: SOURCES }) });
    }
    if (url.includes('/api/import/detect')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(DETECTION) });
    }
    if (url.includes('/api/import/preflight')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, ...PREFLIGHT }) });
    }
    // The job poll (`/api/catalog/import/{id}`) — matched before the bare start path.
    if (url.includes('/api/catalog/import/')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, state: 'completed', events: [] }),
      });
    }
    // The import start (`POST /api/catalog/import`).
    if (url.endsWith('/api/catalog/import') && method === 'POST') {
      starts.push({ body: JSON.parse(String(init?.body ?? '{}')) });
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, job_id: 'job-26-2' }),
      });
    }
    // The remote document fetch for URL import.
    if (url === REMOTE_URL) {
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(SDL) });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  }) as unknown as jest.Mock;
}

/** The `metadata` bag of the most recent recorded import-start request. */
function startMetadata(starts: StartCall[]): Record<string, unknown> {
  expect(starts).toHaveLength(1);
  return (starts[0].body.metadata ?? {}) as Record<string, unknown>;
}

/**
 * Cross the quality step (IXH-2.2): Continue from Options, wait for the pre-flight verdict, then
 * confirm the import. The commit now originates here, not from the Options step.
 */
async function confirmThroughQualityStep() {
  fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
  await waitFor(() => expect(screen.getByTestId('import-quality-grade')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('import-quality-import'));
}

describe('CatalogImportDialog — URL + paste intake (MFI-26.2)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('imports a fetched URL to the catalog with input_kind "url"', async () => {
    const starts: StartCall[] = [];
    global.fetch = mockFetch(starts) as unknown as typeof fetch;
    const onSuccess = jest.fn();

    render(<CatalogImportDialog open onClose={jest.fn()} onSuccess={onSuccess} />);
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith('/api/import/sources', expect.anything()),
    );

    // Step 1 (Source): choose URL Import, enter a document URL, fetch + detect.
    fireEvent.click(screen.getByTestId('catalog-import-source-url'));
    fireEvent.change(screen.getByLabelText('Document URL'), { target: { value: REMOTE_URL } });
    fireEvent.click(screen.getByRole('button', { name: /fetch and detect/i }));

    // Step 2 (Detect & route): GraphQL is detected and routes to the catalog.
    await waitFor(() => expect(screen.getByText(/Auto-detected:/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));

    // Step 3 (Options) → Step 4 (Quality): confirm the verdict; the job then polls to completion.
    await waitFor(() => expect(screen.getByText(/kept verbatim/i)).toBeInTheDocument());
    await confirmThroughQualityStep();

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(screen.getByText(/Stored in the catalog/i)).toBeInTheDocument();

    const metadata = startMetadata(starts);
    expect(metadata.source_kind).toBe('graphql');
    expect(metadata.options).toEqual({ input_kind: 'url' });
    expect(starts[0].body.filename).toBe(REMOTE_URL);
  });

  it('imports pasted content to the catalog with input_kind "paste"', async () => {
    const starts: StartCall[] = [];
    global.fetch = mockFetch(starts) as unknown as typeof fetch;
    const onSuccess = jest.fn();

    render(<CatalogImportDialog open onClose={jest.fn()} onSuccess={onSuccess} />);
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith('/api/import/sources', expect.anything()),
    );

    // Step 1 (Source): choose Clipboard Paste and paste SDL content.
    fireEvent.click(screen.getByTestId('catalog-import-source-paste'));
    fireEvent.change(screen.getByLabelText('Source content'), { target: { value: SDL } });
    fireEvent.click(screen.getByRole('button', { name: /detect pasted source/i }));

    await waitFor(() => expect(screen.getByText(/Auto-detected:/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));

    await waitFor(() => expect(screen.getByText(/kept verbatim/i)).toBeInTheDocument());
    await confirmThroughQualityStep();

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1), { timeout: 3000 });

    const metadata = startMetadata(starts);
    expect(metadata.source_kind).toBe('graphql');
    expect(metadata.options).toEqual({ input_kind: 'paste' });
  });

  it('surfaces an error when the import fails to start', async () => {
    const starts: StartCall[] = [];
    // Override the start route to fail; everything else behaves normally.
    global.fetch = jest.fn((input: unknown, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input);
      const method = (init?.method || 'GET').toUpperCase();
      if (url.includes('/api/import/sources')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, sources: SOURCES }) });
      }
      if (url.includes('/api/import/detect')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(DETECTION) });
      }
      if (url.includes('/api/import/preflight')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, ...PREFLIGHT }) });
      }
      if (url.endsWith('/api/catalog/import') && method === 'POST') {
        return Promise.resolve({
          ok: false,
          json: () => Promise.resolve({ success: false, error: 'Adapter unavailable.' }),
        });
      }
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
    }) as unknown as typeof fetch;

    render(<CatalogImportDialog open onClose={jest.fn()} onSuccess={jest.fn()} />);
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith('/api/import/sources', expect.anything()),
    );

    fireEvent.click(screen.getByTestId('catalog-import-source-paste'));
    fireEvent.change(screen.getByLabelText('Source content'), { target: { value: SDL } });
    fireEvent.click(screen.getByRole('button', { name: /detect pasted source/i }));
    await waitFor(() => expect(screen.getByText(/Auto-detected:/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    await waitFor(() => expect(screen.getByText(/kept verbatim/i)).toBeInTheDocument());
    await confirmThroughQualityStep();

    await waitFor(() => expect(screen.getByText('Adapter unavailable.')).toBeInTheDocument());
    expect(starts).toHaveLength(0);
  });

  it('surfaces taxonomy remediation when the import job fails (IXH-6.4)', async () => {
    const starts: StartCall[] = [];
    global.fetch = jest.fn((input: unknown, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input);
      const method = (init?.method || 'GET').toUpperCase();
      if (url.includes('/api/import/sources')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, sources: SOURCES }) });
      }
      if (url.includes('/api/import/detect')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(DETECTION) });
      }
      if (url.includes('/api/import/preflight')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, ...PREFLIGHT }) });
      }
      if (url.includes('/api/catalog/import/') && method === 'GET') {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              success: true,
              state: 'failed',
              events: [{ level: 'error', message: 'legacy event text' }],
              error: {
                code: 'INPUT_MALFORMED',
                category: 'input',
                message: 'Document is not valid GraphQL SDL.',
                remediation: 'Fix the syntax fault and re-import.',
                retriable: false,
              },
            }),
        });
      }
      if (url.endsWith('/api/catalog/import') && method === 'POST') {
        starts.push({ body: JSON.parse(String(init?.body || '{}')) as Record<string, unknown> });
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ success: true, job_id: 'job-fail-6-4' }),
        });
      }
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
    }) as unknown as typeof fetch;

    render(<CatalogImportDialog open onClose={jest.fn()} onSuccess={jest.fn()} />);
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith('/api/import/sources', expect.anything()),
    );

    fireEvent.click(screen.getByTestId('catalog-import-source-paste'));
    fireEvent.change(screen.getByLabelText('Source content'), { target: { value: SDL } });
    fireEvent.click(screen.getByRole('button', { name: /detect pasted source/i }));
    await waitFor(() => expect(screen.getByText(/Auto-detected:/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    await waitFor(() => expect(screen.getByText(/kept verbatim/i)).toBeInTheDocument());
    await confirmThroughQualityStep();

    await waitFor(
      () =>
        expect(
          screen.getByText(/Document is not valid GraphQL SDL\.\s*Fix the syntax fault and re-import\.\s*\(code INPUT_MALFORMED\)/),
        ).toBeInTheDocument(),
      { timeout: 3000 },
    );
    expect(screen.queryByText('legacy event text')).not.toBeInTheDocument();
  });
});
