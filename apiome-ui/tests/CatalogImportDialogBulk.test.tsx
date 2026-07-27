/**
 * CatalogImportDialog — bulk import of independent specs (MFI-29.5, #4392).
 *
 * A `specs.zip` holding several *unrelated* documents has no single routing decision and no
 * single quality verdict, so the wizard offers bulk mode instead: the detect step says how many
 * independent specs were found and what each would become, and the import step runs one ordinary
 * import per spec and reports them one row at a time.
 *
 * These tests drive that flow against a routing fetch mock, asserting:
 *
 *  1. the banner appears only when the payload really holds more than one spec,
 *  2. a multi-spec archive whose *whole-archive* detection failed still reaches bulk mode
 *     (an archive of independent specs has no single root — that is the point),
 *  3. the batch starts one job per spec and renders each item's outcome,
 *  4. a failed item is reported with its taxonomy reason while the others still import.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { jest } from '@jest/globals';

import { CatalogImportDialog } from '../src/app/components/ade/dashboard/catalog/CatalogImportDialog';
import type { ImportSourceDescriptor } from '../src/app/components/ade/dashboard/importSourceCatalog';

const SOURCES: ImportSourceDescriptor[] = [
  {
    key: 'asyncapi',
    label: 'AsyncAPI',
    description: 'Import an AsyncAPI document.',
    icon: 'radio',
    paradigm: 'event',
    input_kinds: ['file', 'url', 'paste', 'fileset'],
    supports_live_discovery: false,
    formats: ['asyncapi-2'],
    available: true,
  },
];

const PLAN = {
  success: true,
  items: [
    {
      key: 'events/orders.asyncapi.yaml',
      root_path: 'events/orders.asyncapi.yaml',
      members: ['events/orders.asyncapi.yaml'],
      total_bytes: 96,
      source_kind: 'asyncapi',
      format: 'asyncapi-2',
      confidence: 0.98,
      importable: true,
      predicted_target: 'catalog',
      input_kind: 'file',
      suggested_name: 'Orders Events',
      suggested_slug: 'orders-events',
      reason: 'independent document',
    },
    {
      key: 'openapi/orders.yaml',
      root_path: 'openapi/orders.yaml',
      members: ['openapi/orders.yaml'],
      total_bytes: 88,
      source_kind: 'openapi',
      format: 'openapi-3.0',
      confidence: 0.99,
      importable: true,
      predicted_target: 'project',
      input_kind: 'file',
      suggested_name: 'Orders API',
      suggested_slug: 'orders-api',
      reason: 'independent document',
    },
  ],
  skipped: [{ path: 'README.md', reason: 'no-recognisable-format' }],
  truncated: false,
  total_items: 2,
  max_items: 50,
  source_label: 'specs.zip',
  git_source: null,
  summary: {
    items: 2,
    importable: 2,
    unimportable: 0,
    skipped_files: 1,
    by_target: { catalog: 1, project: 1 },
    by_format: { 'asyncapi-2': 1, 'openapi-3.0': 1 },
  },
};

const START = {
  success: true,
  batch_id: 'batch-1',
  items: [
    {
      key: 'events/orders.asyncapi.yaml',
      root_path: 'events/orders.asyncapi.yaml',
      source_kind: 'asyncapi',
      format: 'asyncapi-2',
      predicted_target: 'catalog',
      name: 'Orders Events',
      slug: 'orders-events',
      state: 'accepted',
      job_id: 'job-1',
      status_path: '/v1/tenants/acme/imports/job-1',
      error: null,
    },
    {
      key: 'openapi/orders.yaml',
      root_path: 'openapi/orders.yaml',
      source_kind: 'openapi',
      format: 'openapi-3.0',
      predicted_target: 'project',
      name: 'Orders API',
      slug: 'orders-api',
      state: 'accepted',
      job_id: 'job-2',
      status_path: '/v1/tenants/acme/imports/job-2',
      error: null,
    },
  ],
  skipped: [{ path: 'README.md', reason: 'no-recognisable-format' }],
  summary: { requested: 2, accepted: 2, failed: 0 },
};

const STATUS = {
  success: true,
  items: [
    {
      key: 'events/orders.asyncapi.yaml',
      job_id: 'job-1',
      state: 'completed',
      percent: 100,
      target: 'catalog',
      project_slug: 'orders-events',
      project_id: 'p1',
      error: null,
    },
    {
      key: 'openapi/orders.yaml',
      job_id: 'job-2',
      state: 'completed',
      percent: 100,
      target: 'project',
      project_slug: 'orders-api',
      project_id: 'p2',
      error: null,
    },
  ],
  summary: { total: 2, completed: 2, failed: 0, running: 0, not_found: 0 },
  done: true,
};

interface RecordedCall {
  body: Record<string, unknown>;
}

/**
 * A routing fetch mock for the bulk flow. Plan, submit, and status requests are recorded so a
 * test can assert exactly what the wizard asked for.
 */
function mockFetch(
  recorded: { plans: RecordedCall[]; submits: RecordedCall[]; polls: RecordedCall[] },
  overrides: {
    detectOk?: boolean;
    plan?: Record<string, unknown>;
    start?: Record<string, unknown>;
    status?: Record<string, unknown>;
  } = {},
): jest.Mock {
  return jest.fn((input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    const method = (init?.method || 'GET').toUpperCase();

    if (url.includes('/api/import/sources')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, sources: SOURCES }),
      });
    }
    if (url.includes('/api/import/detect')) {
      if (overrides.detectOk === false) {
        return Promise.resolve({
          ok: false,
          json: () =>
            Promise.resolve({
              success: false,
              error: 'Archive root is ambiguous — choose a root document explicitly.',
            }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            matched: true,
            detected: {
              format: 'asyncapi-2',
              confidence: 0.9,
              reason: 'asyncapi marker',
              source_key: 'asyncapi',
              importable: true,
            },
            ambiguous: false,
            candidates: [],
            ambiguous_candidates: [],
            archive_root: 'events/orders.asyncapi.yaml',
          }),
      });
    }
    if (url.endsWith('/api/catalog/import/bulk/plan') && method === 'POST') {
      recorded.plans.push({ body: JSON.parse(String(init?.body ?? '{}')) });
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(overrides.plan ?? PLAN),
      });
    }
    if (url.endsWith('/api/catalog/import/bulk/status') && method === 'POST') {
      recorded.polls.push({ body: JSON.parse(String(init?.body ?? '{}')) });
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(overrides.status ?? STATUS),
      });
    }
    if (url.endsWith('/api/catalog/import/bulk') && method === 'POST') {
      recorded.submits.push({ body: JSON.parse(String(init?.body ?? '{}')) });
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(overrides.start ?? START),
      });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  }) as unknown as jest.Mock;
}

function recorder() {
  return { plans: [] as RecordedCall[], submits: [] as RecordedCall[], polls: [] as RecordedCall[] };
}

/** Open the dialog and wait for the source registry to load. */
async function openDialog(onSuccess = jest.fn()) {
  render(<CatalogImportDialog open onClose={jest.fn()} onSuccess={onSuccess} />);
  await waitFor(() =>
    expect(global.fetch).toHaveBeenCalledWith('/api/import/sources', expect.anything()),
  );
  return onSuccess;
}

/**
 * Drop a `.zip` on the file panel, which is the only upload that can hold several specs.
 *
 * jsdom's `File` has no `arrayBuffer()`, and the dialog reads archive bytes through it, so the
 * upload is a duck-typed file carrying the zip magic number.
 */
function dropArchive(name = 'specs.zip') {
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
  const file = {
    name,
    type: 'application/zip',
    arrayBuffer: () => Promise.resolve(bytes.buffer),
    text: () => Promise.resolve(''),
  } as unknown as File;
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
}

describe('CatalogImportDialog — bulk import (MFI-29.5)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('offers bulk mode when an archive holds several independent specs', async () => {
    const calls = recorder();
    global.fetch = mockFetch(calls) as unknown as typeof fetch;
    await openDialog();

    dropArchive();

    await waitFor(() =>
      expect(screen.getByTestId('catalog-bulk-import-banner')).toBeInTheDocument(),
    );
    expect(screen.getByText(/holds 2 independent specs/i)).toBeInTheDocument();
    expect(screen.getByText(/Orders API — openapi-3.0 → project/)).toBeInTheDocument();
    expect(calls.plans[0].body).toEqual({
      document_base64: expect.any(String),
      filename: 'specs.zip',
    });
  });

  it('reaches bulk mode even when whole-archive detection found no single root', async () => {
    const calls = recorder();
    global.fetch = mockFetch(calls, { detectOk: false }) as unknown as typeof fetch;
    await openDialog();

    dropArchive();

    await waitFor(() =>
      expect(screen.getByTestId('catalog-bulk-import-banner')).toBeInTheDocument(),
    );
    // The ambiguous-root message is not an error here: it is what bulk mode answers.
    expect(screen.queryByText(/Archive root is ambiguous/)).not.toBeInTheDocument();
  });

  it('keeps the single-document wizard when the payload holds one spec', async () => {
    const calls = recorder();
    global.fetch = mockFetch(calls, {
      plan: { ...PLAN, items: [PLAN.items[0]], total_items: 1 },
    }) as unknown as typeof fetch;
    await openDialog();

    dropArchive();

    await waitFor(() => expect(screen.getByText(/Routing decision/)).toBeInTheDocument());
    expect(screen.queryByTestId('catalog-bulk-import-banner')).not.toBeInTheDocument();
  });

  it('starts one job per spec and reports every item', async () => {
    const calls = recorder();
    global.fetch = mockFetch(calls) as unknown as typeof fetch;
    const onSuccess = await openDialog();

    dropArchive();
    await waitFor(() =>
      expect(screen.getByTestId('catalog-bulk-import-banner')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('catalog-bulk-import-start'));

    await waitFor(() =>
      expect(screen.getByTestId('catalog-bulk-import-panel')).toBeInTheDocument(),
    );
    await waitFor(() => expect(screen.getByText(/Bulk import finished/)).toBeInTheDocument());

    // The submit re-sends the same payload the plan described, so the server re-plans it.
    expect(calls.submits[0].body).toEqual(calls.plans[0].body);
    // Only the started items are polled.
    expect(calls.polls[0].body).toEqual({
      items: [
        { key: 'events/orders.asyncapi.yaml', job_id: 'job-1' },
        { key: 'openapi/orders.yaml', job_id: 'job-2' },
      ],
    });
    expect(screen.getByText('2 imported of 2.', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('Created orders-events')).toBeInTheDocument();
    expect(screen.getByText('Created orders-api')).toBeInTheDocument();
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
  });

  it('reports a refused item without losing the ones that imported', async () => {
    const start = {
      ...START,
      items: [
        START.items[0],
        {
          ...START.items[1],
          state: 'failed',
          job_id: null,
          status_path: null,
          error: {
            code: 'QUALITY_POLICY_BLOCKED',
            category: 'policy',
            message: 'Import scores D, below the tenant floor of B.',
            remediation: 'Fix the findings or request a waiver.',
            retriable: false,
          },
        },
      ],
      summary: { requested: 2, accepted: 1, failed: 1 },
    };
    const status = {
      ...STATUS,
      items: [STATUS.items[0]],
      summary: { total: 1, completed: 1, failed: 0, running: 0, not_found: 0 },
    };
    const calls = recorder();
    global.fetch = mockFetch(calls, { start, status }) as unknown as typeof fetch;
    await openDialog();

    dropArchive();
    await waitFor(() =>
      expect(screen.getByTestId('catalog-bulk-import-banner')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('catalog-bulk-import-start'));

    await waitFor(() => expect(screen.getByText(/Bulk import finished/)).toBeInTheDocument());
    expect(screen.getByText(/1 imported, 1 failed of 2/)).toBeInTheDocument();
    expect(screen.getByText(/below the tenant floor/)).toBeInTheDocument();
    expect(screen.getByText('Created orders-events')).toBeInTheDocument();
    // The blocked item never started a job, so it is not polled for.
    expect(calls.polls[0].body).toEqual({
      items: [{ key: 'events/orders.asyncapi.yaml', job_id: 'job-1' }],
    });
  });

  it('lists the files that are part of no spec', async () => {
    const calls = recorder();
    global.fetch = mockFetch(calls) as unknown as typeof fetch;
    await openDialog();

    dropArchive();
    await waitFor(() =>
      expect(screen.getByTestId('catalog-bulk-import-banner')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('catalog-bulk-import-start'));

    await waitFor(() =>
      expect(screen.getByTestId('catalog-bulk-import-skipped')).toBeInTheDocument(),
    );
    expect(screen.getByText(/README.md — no-recognisable-format/)).toBeInTheDocument();
  });
});
