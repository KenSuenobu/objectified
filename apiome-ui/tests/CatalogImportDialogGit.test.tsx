/**
 * CatalogImportDialog — git repository intake (MFI-29.3, #4390).
 *
 * The Git tile takes a repository URL, a ref, and a path/glob; the server resolves that selection
 * at an immutable commit and returns the files packed as the same archive payload a `.zip` upload
 * produces. From the detect step on, the wizard treats it exactly like an archive — with the
 * commit provenance shown and carried into the commit.
 *
 * These tests drive the full flow (Source → Detect & route → Options → Quality → Import) against a
 * routing fetch mock, asserting:
 *
 *  1. the selection request the Git panel sends,
 *  2. the provenance and member summary rendered on the detect step,
 *  3. the import start carrying `options.input_kind: 'fileset'`, `options.archive_root`, and
 *     `options.git_source` (the provenance echoed back verbatim),
 *  4. that a failed selection surfaces the server's taxonomy message instead of starting a job.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { jest } from '@jest/globals';

import { CatalogImportDialog } from '../src/app/components/ade/dashboard/catalog/CatalogImportDialog';
import type { ImportSourceDescriptor } from '../src/app/components/ade/dashboard/importSourceCatalog';

const REPO_URL = 'https://github.com/acme/specs';
const COMMIT = '9f1c0de5b4a37821cc0d4f3a6a5b0e2d1c8a7b60';

const SOURCES: ImportSourceDescriptor[] = [
  {
    key: 'grpc',
    label: 'gRPC / Protobuf',
    description: 'Import a gRPC / Protocol Buffers API from a .proto file.',
    icon: 'share-2',
    paradigm: 'rpc',
    input_kinds: ['file', 'url', 'paste', 'fileset'],
    supports_live_discovery: true,
    formats: ['protobuf'],
    available: true,
  },
];

const GIT_SOURCE = {
  provider: 'github',
  repo_url: REPO_URL,
  owner: 'acme',
  repo: 'specs',
  ref: 'main',
  commit_sha: COMMIT,
  path: 'protos/**',
  browse_url: `${REPO_URL}/tree/${COMMIT}/protos`,
};

const GIT_FILESET = {
  success: true,
  git_source: GIT_SOURCE,
  filename: `specs-main-${COMMIT.slice(0, 7)}.zip`,
  document_base64: 'UEsDBBQAAAAA',
  archive_root: 'user/user_service.proto',
  members: ['common/types.proto', 'user/user_service.proto'],
  skipped: [{ path: 'docs/logo.png', reason: 'binary-file' }],
  total_bytes: 512,
  source_kind: 'grpc',
  detection: {
    matched: true,
    detected: {
      format: 'protobuf',
      confidence: 0.95,
      reason: 'proto3 syntax marker',
      source_key: 'grpc',
      importable: true,
    },
    ambiguous: false,
    candidates: [],
    ambiguous_candidates: [],
  },
};

/** A clean, non-blocking pre-flight verdict, so the quality step allows the commit. */
const PREFLIGHT = {
  ok: true,
  detection: { adapter_key: 'grpc', confidence: 0.95, matched: true, importable: true },
  lint: {
    score: 88,
    grade: 'B',
    report_fingerprint: 'fp',
    severity_counts: { error: 0, warning: 0, info: 0 },
    findings: [],
  },
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

interface RecordedCall {
  body: Record<string, unknown>;
}

/**
 * A routing fetch mock for the whole git flow. Selection requests land in `selections` and import
 * starts in `starts`, so a test can assert exactly what the dialog asked for.
 */
function mockFetch(
  selections: RecordedCall[],
  starts: RecordedCall[],
  gitResponse: { ok: boolean; body: Record<string, unknown> } = { ok: true, body: GIT_FILESET },
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
    if (url.includes('/api/import/preflight')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, ...PREFLIGHT }),
      });
    }
    if (url.endsWith('/api/catalog/import/git') && method === 'POST') {
      selections.push({ body: JSON.parse(String(init?.body ?? '{}')) });
      return Promise.resolve({
        ok: gitResponse.ok,
        json: () => Promise.resolve(gitResponse.body),
      });
    }
    if (url.includes('/api/catalog/import/')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, state: 'completed', events: [] }),
      });
    }
    if (url.endsWith('/api/catalog/import') && method === 'POST') {
      starts.push({ body: JSON.parse(String(init?.body ?? '{}')) });
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, job_id: 'job-29-3' }),
      });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  }) as unknown as jest.Mock;
}

/** Open the dialog and wait for the source registry to load. */
async function openDialog(onSuccess: jest.Mock) {
  render(<CatalogImportDialog open onClose={jest.fn()} onSuccess={onSuccess} />);
  await waitFor(() =>
    expect(global.fetch).toHaveBeenCalledWith('/api/import/sources', expect.anything()),
  );
}

/** Fill the Git panel with a repository selection and fetch it. */
function fetchSelection({ ref = 'main', path = 'protos/**' } = {}) {
  fireEvent.click(screen.getByTestId('catalog-import-source-git'));
  fireEvent.change(screen.getByLabelText('Repository URL'), { target: { value: REPO_URL } });
  fireEvent.change(screen.getByLabelText('Branch, tag, or commit'), { target: { value: ref } });
  fireEvent.change(screen.getByLabelText('Path or glob'), { target: { value: path } });
  fireEvent.click(screen.getByRole('button', { name: /fetch and detect/i }));
}

/** Cross the quality step (IXH-2.2) and confirm the import. */
async function confirmThroughQualityStep() {
  fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
  await waitFor(() => expect(screen.getByTestId('import-quality-grade')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId('import-quality-import'));
}

describe('CatalogImportDialog — git repository intake (MFI-29.3)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('offers a Git tile alongside the base intake methods', async () => {
    global.fetch = mockFetch([], []) as unknown as typeof fetch;
    await openDialog(jest.fn());

    expect(screen.getByTestId('catalog-import-source-git')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('catalog-import-source-git'));
    expect(screen.getByTestId('catalog-import-git-panel')).toBeInTheDocument();
  });

  it('imports a repository path with commit provenance', async () => {
    const selections: RecordedCall[] = [];
    const starts: RecordedCall[] = [];
    global.fetch = mockFetch(selections, starts) as unknown as typeof fetch;
    const onSuccess = jest.fn();
    await openDialog(onSuccess);

    fetchSelection();

    // Step 2 (Detect & route): the selection's provenance and member summary are shown.
    await waitFor(() => expect(screen.getByText(/Auto-detected:/i)).toBeInTheDocument());
    const provenance = screen.getByTestId('catalog-import-git-provenance');
    expect(provenance).toHaveTextContent(REPO_URL);
    expect(provenance).toHaveTextContent(COMMIT.slice(0, 7));
    expect(provenance).toHaveTextContent('2 files selected');
    expect(provenance).toHaveTextContent('1 skipped');

    expect(selections).toHaveLength(1);
    expect(selections[0].body).toEqual({ repo_url: REPO_URL, ref: 'main', path: 'protos/**' });

    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    await waitFor(() => expect(screen.getByText(/kept verbatim/i)).toBeInTheDocument());
    await confirmThroughQualityStep();

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1), { timeout: 3000 });

    expect(starts).toHaveLength(1);
    const metadata = starts[0].body.metadata as Record<string, unknown>;
    expect(metadata.source_kind).toBe('grpc');
    // A repository selection commits as a fileset — 'git' is a wizard source, not a REST kind.
    expect(metadata.options).toEqual({
      input_kind: 'fileset',
      archive_root: 'user/user_service.proto',
      git_source: GIT_SOURCE,
    });
    // The packed bytes are sent verbatim, and the item is named after the repository.
    expect(starts[0].body.document_base64).toBe(GIT_FILESET.document_base64);
    expect((metadata.project as Record<string, unknown>).name).toBe('specs');
  });

  it('omits an empty ref so the default branch is used', async () => {
    const selections: RecordedCall[] = [];
    global.fetch = mockFetch(selections, []) as unknown as typeof fetch;
    await openDialog(jest.fn());

    fetchSelection({ ref: '', path: 'protos/' });

    await waitFor(() => expect(selections).toHaveLength(1));
    expect(selections[0].body).toEqual({ repo_url: REPO_URL, path: 'protos/' });
  });

  it('requires a repository URL before fetching', async () => {
    const selections: RecordedCall[] = [];
    global.fetch = mockFetch(selections, []) as unknown as typeof fetch;
    await openDialog(jest.fn());

    fireEvent.click(screen.getByTestId('catalog-import-source-git'));
    fireEvent.click(screen.getByRole('button', { name: /fetch and detect/i }));

    expect(await screen.findByText('Enter a repository URL to import.')).toBeInTheDocument();
    expect(selections).toHaveLength(0);
  });

  it('surfaces the server message when the selection cannot be read', async () => {
    const selections: RecordedCall[] = [];
    const starts: RecordedCall[] = [];
    global.fetch = mockFetch(selections, starts, {
      ok: false,
      body: {
        success: false,
        error:
          "No importable files matching 'schemas/**' were found. Widen the pattern (for example 'protos/**').",
      },
    }) as unknown as typeof fetch;
    await openDialog(jest.fn());

    fetchSelection({ path: 'schemas/**' });

    expect(await screen.findByText(/No importable files matching/i)).toBeInTheDocument();
    // The wizard stays on the source step; nothing is imported.
    expect(screen.getByTestId('catalog-import-git-panel')).toBeInTheDocument();
    expect(starts).toHaveLength(0);
  });
});
