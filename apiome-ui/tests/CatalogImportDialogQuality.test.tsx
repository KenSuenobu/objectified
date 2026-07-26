/**
 * CatalogImportDialog — the quality step in the wizard rail (IXH-2.2, #5097).
 *
 * Wizard-level contracts, complementing the step's own component tests:
 *  1. the rail reads `source → detect → options → quality → import`;
 *  2. Continue from `options` lands on `quality` and writes **nothing** — the catalog import job
 *     starts only after the quality step's Import;
 *  3. Back from `quality` returns to `options` with wizard state intact (format, routing, source);
 *  4. a blocking policy keeps the import disabled, so no job is ever started;
 *  5. the JSON Schema → Types hand-off still bypasses the step, because it writes no catalog item.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { describe, expect, it, jest, beforeEach, afterEach } from '@jest/globals';

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

const GRAPHQL_DOC = 'type Query { hello: String }';

const DETECTION = {
  matched: true,
  detected: { format: 'graphql', confidence: 0.95, reason: 'SDL type marker', importable: true },
};

/** A passing pre-flight report; `overrides` swap in the policy or lint under test. */
function preflightReport(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    detection: { adapter_key: 'graphql', confidence: 0.95, matched: true, importable: true },
    lint: { score: 88, grade: 'B', report_fingerprint: 'fp-1', severity_counts: { error: 0, warning: 1, info: 0 }, findings: [] },
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
    ...overrides,
  };
}

interface RecordedCall {
  url: string;
  body?: unknown;
}

/** Serve the source registry, detection, pre-flight, and the import job, recording every call. */
function mockFetch(report: Record<string, unknown>): jest.Mock {
  const calls: RecordedCall[] = [];
  const fn = jest.fn((input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes('/api/import/sources')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, sources: SOURCES }) });
    }
    if (url.includes('/api/import/detect')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(DETECTION) });
    }
    if (url.includes('/api/import/preflight')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, ...report }) });
    }
    if (url === '/api/catalog/import') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, job_id: 'job-1' }) });
    }
    if (url.startsWith('/api/catalog/import/')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, state: 'completed' }) });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  }) as unknown as jest.Mock;
  (fn as unknown as { calls: RecordedCall[] }).calls = calls;
  return fn;
}

function recordedCalls(fetchMock: jest.Mock): RecordedCall[] {
  return (fetchMock as unknown as { calls: RecordedCall[] }).calls;
}

/** Drive Source → Detect by pasting GraphQL SDL. */
async function pasteAndDetect(text = GRAPHQL_DOC) {
  fireEvent.click(screen.getByTestId('catalog-import-source-paste'));
  fireEvent.change(screen.getByLabelText('Source content'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: /detect pasted source/i }));
  await waitFor(() => expect(screen.getByText(/Auto-detected:/i)).toBeInTheDocument());
}

describe('CatalogImportDialog — quality step (IXH-2.2)', () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => jest.restoreAllMocks());

  it('shows the five-step rail with Quality between Options and Import', async () => {
    global.fetch = mockFetch(preflightReport()) as unknown as typeof fetch;
    render(<CatalogImportDialog open onClose={jest.fn()} />);
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith('/api/import/sources', expect.anything()),
    );

    expect(screen.getByText('1. Source')).toBeInTheDocument();
    expect(screen.getByText('2. Detect & route')).toBeInTheDocument();
    expect(screen.getByText('3. Options')).toBeInTheDocument();
    expect(screen.getByText('4. Quality')).toBeInTheDocument();
    expect(screen.getByText('5. Import')).toBeInTheDocument();
  });

  it('renders the pre-flight report without committing, then imports on confirm', async () => {
    const fetchMock = mockFetch(preflightReport());
    global.fetch = fetchMock as unknown as typeof fetch;
    const onSuccess = jest.fn();
    render(<CatalogImportDialog open onClose={jest.fn()} onSuccess={onSuccess} />);
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith('/api/import/sources', expect.anything()),
    );
    await pasteAndDetect();

    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));

    await waitFor(() => expect(screen.getByTestId('catalog-import-quality-step')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('import-quality-grade')).toHaveTextContent('B'));

    // The pre-flight ran; no catalog write has happened yet.
    expect(recordedCalls(fetchMock).some((c) => c.url === '/api/import/preflight')).toBe(true);
    expect(recordedCalls(fetchMock).some((c) => c.url === '/api/catalog/import')).toBe(false);

    fireEvent.click(screen.getByTestId('import-quality-import'));
    await waitFor(() => expect(onSuccess).toHaveBeenCalled(), { timeout: 3000 });
    const start = recordedCalls(fetchMock).find((c) => c.url === '/api/catalog/import');
    expect((start?.body as { metadata: { source_kind: string } }).metadata.source_kind).toBe('graphql');
  });

  it('returns to options from quality with wizard state intact', async () => {
    const fetchMock = mockFetch(preflightReport());
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<CatalogImportDialog open onClose={jest.fn()} />);
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith('/api/import/sources', expect.anything()),
    );
    await pasteAndDetect();

    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    await waitFor(() => expect(screen.getByTestId('import-quality-grade')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /^back$/i }));
    await waitFor(() =>
      expect(screen.queryByTestId('catalog-import-quality-step')).not.toBeInTheDocument(),
    );
    // Back on options: the routing decision the detect step made is still in force…
    expect(screen.getByText(/Store in catalog/i)).toBeInTheDocument();
    // …and Back again reaches the detect step with the detected format intact.
    fireEvent.click(screen.getByRole('button', { name: /^back$/i }));
    expect(screen.getByText(/Auto-detected:/i)).toBeInTheDocument();
    expect(screen.getByText(/Routing decision → Catalog/i)).toBeInTheDocument();
    expect(recordedCalls(fetchMock).some((c) => c.url === '/api/catalog/import')).toBe(false);
  });

  it('starts no import job while policy blocks the candidate', async () => {
    const fetchMock = mockFetch(
      preflightReport({
        lint: { score: 41, grade: 'F', report_fingerprint: 'fp-b', severity_counts: { error: 4 }, findings: [] },
        policy: {
          verdict: 'block',
          blocking: true,
          source: 'tenant',
          reason: 'Score 41 is below the required minimum of 70.',
          threshold_score: 70,
          allow_override: false,
        },
      }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<CatalogImportDialog open onClose={jest.fn()} />);
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith('/api/import/sources', expect.anything()),
    );
    await pasteAndDetect();

    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    await waitFor(() => expect(screen.getByTestId('import-quality-import')).toBeDisabled());

    fireEvent.click(screen.getByTestId('import-quality-import'));
    expect(recordedCalls(fetchMock).some((c) => c.url === '/api/catalog/import')).toBe(false);
    expect(screen.queryByTestId('import-quality-override')).not.toBeInTheDocument();
  });

  it('lets the skip preference be unchecked from the options step (it auto-skips the quality step)', async () => {
    // With the preference on, a non-blocking pre-flight auto-commits the quality step the moment
    // the report arrives — the step's own checkbox flashes past too fast to uncheck. The options
    // step is where the preference must stay reachable (#regression: one-way switch).
    window.localStorage.setItem('apiome.import-quality.v1', JSON.stringify({ skipQualityStep: true }));
    const fetchMock = mockFetch(preflightReport());
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<CatalogImportDialog open onClose={jest.fn()} />);
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith('/api/import/sources', expect.anything()),
    );
    await pasteAndDetect();
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));

    // The options step exposes the preference, reflecting the persisted value.
    const checkbox = screen.getByTestId('catalog-import-options-skip-preference') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);
    expect(JSON.parse(window.localStorage.getItem('apiome.import-quality.v1') ?? '{}')).toEqual({
      skipQualityStep: false,
    });

    // With the preference off again, the quality step stops for review instead of auto-committing.
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    await waitFor(() => expect(screen.getByTestId('import-quality-grade')).toHaveTextContent('B'));
    expect(recordedCalls(fetchMock).some((c) => c.url === '/api/catalog/import')).toBe(false);
  });

  it('still auto-commits a clean import from the quality step when the preference stays on', async () => {
    window.localStorage.setItem('apiome.import-quality.v1', JSON.stringify({ skipQualityStep: true }));
    const fetchMock = mockFetch(preflightReport());
    global.fetch = fetchMock as unknown as typeof fetch;
    const onSuccess = jest.fn();
    render(<CatalogImportDialog open onClose={jest.fn()} onSuccess={onSuccess} />);
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith('/api/import/sources', expect.anything()),
    );
    await pasteAndDetect();
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalled(), { timeout: 3000 });
    expect(recordedCalls(fetchMock).some((c) => c.url === '/api/catalog/import')).toBe(true);
  });

  it('keeps the JSON Schema → Types hand-off out of the quality step', async () => {
    const fetchMock = jest.fn((input: unknown) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.includes('/api/import/sources')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, sources: SOURCES }) });
      }
      if (url.includes('/api/import/detect')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              matched: true,
              detected: {
                // The spaced label is the one that still asks Catalog-vs-Types (`json-schema-choice`);
                // registered `json-schema` families route straight to the catalog adapter.
                format: 'JSON Schema',
                confidence: 0.95,
                reason: '`$schema` marker',
                importable: true,
              },
            }),
        });
      }
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
    }) as unknown as jest.Mock;
    global.fetch = fetchMock as unknown as typeof fetch;
    const onJsonSchemaAsCurrent = jest.fn();
    render(
      <CatalogImportDialog
        open
        onClose={jest.fn()}
        onJsonSchemaAsCurrent={onJsonSchemaAsCurrent as unknown as () => void}
      />,
    );
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith('/api/import/sources', expect.anything()),
    );
    await pasteAndDetect('{"$schema": "https://json-schema.org/draft/2020-12/schema"}');

    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    // The two destination radios are Catalog (first) and Types/Projects (second).
    expect(screen.getByText(/Types\/Projects as current schema/i)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('radio')[1]);
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));

    expect(onJsonSchemaAsCurrent).toHaveBeenCalled();
    expect(screen.queryByTestId('catalog-import-quality-step')).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/import/preflight'))).toBe(false);
  });
});
