/**
 * Format details tab wiring on the catalog item detail shell (CPDO-2.1, #4797).
 *
 * The pane's own behaviour is covered by `catalog-format-detail-panel.test.tsx`; this suite pins the
 * three things only the shell can guarantee:
 *
 *  1. **The tab is lazy.** Opening the detail screen fetches the item and nothing else — the
 *     permission-gated analysis record is requested the first time the tab is *selected*.
 *  2. **The deep link works end to end.** `?tab=format&node=<id>` opens the pane with that construct
 *     expanded and selected, which is what makes a construct citable from outside the app.
 *  3. **Evidence navigation crosses the tabs.** Following a construct's source location switches to
 *     Source & Code and tells the reader, in the viewer's own note, which construct and line it is
 *     showing — while the existing `?line=` compatibility deep link keeps its own wording.
 *
 * The Overview pane is asserted untouched, because "existing Overview behavior remains unchanged" is
 * an acceptance criterion of the ticket and a new tab is exactly the kind of change that could break
 * it silently.
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockPush = jest.fn();
let searchParams = new URLSearchParams();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => searchParams,
}));

jest.mock('@lib/auth/session-client', () => ({
  useAuthSession: () => ({ data: { user: { current_tenant_id: 'tenant-1' } } }),
}));

// Monaco is irrelevant here — the Source tab's *note* is what states which line it was sent to.
jest.mock('@monaco-editor/react', () => ({
  __esModule: true,
  default: (props: { value?: string }) => <textarea readOnly value={props.value ?? ''} />,
}));

import { CatalogItemDetailClient } from '../src/app/ade/dashboard/catalog/[id]/CatalogItemDetailClient';
import { resetFormatCapabilitiesCache } from '@/app/components/ade/dashboard/catalog/useFormatCapabilities';

const ITEM_ID = '11111111-2222-3333-4444-555555555555';

/** A copybook item whose raw source was captured, so a line-addressed jump is offered. */
const ITEM = {
  id: ITEM_ID,
  name: 'Acme claim copybook',
  slug: 'acme-claim-copybook',
  description: 'Imported from a COBOL copybook.',
  enabled: true,
  deleted_at: null,
  created_at: '2026-06-01T00:00:00.000Z',
  updated_at: '2026-06-20T12:00:00.000Z',
  qualityScore: 71,
  qualityGrade: 'C',
  publishable: false,
  sourceFormat: 'cobolcopybook',
  protocol: null,
  formatMetadata: { sourceLabel: 'claim.cpy', inputKind: 'file' },
  toolVersions: { cobolcopybook: '1.0.0' },
  summary: { services: 0, operations: 0, types: 4, channels: 0 },
  source: { kind: 'file', label: 'claim.cpy', uri: null, hasContent: true, downloadable: true },
  analysis: {
    available: true,
    status: 'available',
    statusReason: null,
    schemaVersion: '1.1.0',
    sourceFormat: 'cobolcopybook',
    analyzerKey: 'cobolcopybook',
    analyzerVersion: '1.0.0',
    nodeCount: 2,
    maxDepth: 2,
    truncated: false,
    warningCount: 0,
    kindCounts: { record: 1, field: 1 },
    capabilities: { supported: [], unsupported: [], limits: {} },
    valueVisibility: 'none',
    analysisId: 'an-1',
    versionRecordId: 'ver-1',
    analyzedAt: '2026-07-01T00:00:00.000Z',
  },
};

const RECORD = {
  analysisId: 'an-1',
  analysisSequence: 1,
  analysis: {
    schemaVersion: '1.1.0',
    status: 'available',
    statusReason: null,
    sourceFormat: 'cobolcopybook',
    sourceHash: `sha256:${'b'.repeat(64)}`,
    analyzer: { key: 'cobolcopybook', version: '1.0.0', toolVersions: {} },
    capabilities: { supported: [], unsupported: [], limits: {} },
    tree: [
      {
        id: 'rec-claim',
        kind: 'record',
        name: 'CLAIM-RECORD',
        attributes: { level: 1 },
        location: { file: 'claim.cpy', line: 1, path: 'CLAIM-RECORD' },
        children: [
          {
            id: 'fld-amount',
            kind: 'field',
            name: 'CLAIM-AMOUNT',
            attributes: { level: 5, picture: 'S9(7)V99' },
            location: { file: 'claim.cpy', line: 12, path: 'CLAIM-RECORD/CLAIM-AMOUNT' },
          },
        ],
      },
    ],
    metrics: {
      nodeCount: 2,
      maxDepth: 2,
      truncated: false,
      droppedNodeCount: 0,
      kindCounts: { record: 1, field: 1 },
      warningCount: 0,
    },
    warnings: [],
    redaction: {
      valueVisibility: 'none',
      redactedNodeCount: 0,
      policySource: 'format',
      valuePreviewLimit: 120,
    },
  },
};

const originalFetch = global.fetch;
let fetchMock: jest.Mock;

/** Route every GET the detail shell can make, so an unexpected one is loud rather than silent. */
function mockTransport() {
  fetchMock = jest.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/analysis')) {
      return { ok: true, status: 200, json: async () => ({ success: true, record: RECORD }) };
    }
    if (url.includes('/format-capabilities')) {
      // No registry entry for this format — the pane must render fine without one.
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          version: '1',
          review_date: '2026-07-28',
          analysis_schema_version: '1.1.0',
          absence_categories: [],
          absences: [],
          reason_absence_categories: {},
          formats: [],
        }),
      };
    }
    if (url.includes('/source')) {
      return {
        ok: true,
        status: 200,
        text: async () => Array.from({ length: 30 }, (_, i) => `LINE ${i + 1}`).join('\n'),
      };
    }
    if (url.includes('/lint')) {
      return { ok: true, status: 200, json: async () => ({ success: true, report: null }) };
    }
    return { ok: true, status: 200, json: async () => ({ success: true, item: ITEM }) };
  });
  global.fetch = fetchMock as unknown as typeof fetch;
}

/** Requests made to the permission-gated analysis endpoint. */
function analysisCalls(): unknown[] {
  return fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/analysis'));
}

beforeEach(() => {
  searchParams = new URLSearchParams();
  resetFormatCapabilitiesCache();
  mockTransport();
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

describe('the Format details tab', () => {
  it('sits beside Overview and fetches no analysis until it is selected', async () => {
    render(<CatalogItemDetailClient itemId={ITEM_ID} />);

    const tab = await screen.findByTestId('catalog-detail-tab-format');
    expect(tab).toHaveTextContent('Format details');
    expect(tab).toHaveAttribute('aria-selected', 'false');
    // Tab order: Overview, then Format details, then Source & Code.
    const labels = screen.getAllByRole('tab').map((element) => element.textContent);
    expect(labels.slice(0, 3)).toEqual(['Overview', 'Format details', 'Source & Code']);

    // The item was read; the permission-gated record was not.
    expect(analysisCalls()).toHaveLength(0);

    // Overview is untouched: its API-surface tiles are still the default pane's content.
    expect(screen.getByTestId('catalog-detail-pane-overview')).toBeVisible();
    expect(screen.getAllByTestId('catalog-detail-surface-tile')).toHaveLength(4);
    expect(screen.getByTestId('catalog-detail-pane-format')).not.toBeVisible();
  });

  it('loads the native analysis on first selection and renders its structure', async () => {
    render(<CatalogItemDetailClient itemId={ITEM_ID} />);

    fireEvent.click(await screen.findByTestId('catalog-detail-tab-format'));

    await waitFor(() => expect(screen.getByRole('tree')).toBeInTheDocument());
    expect(analysisCalls()).toHaveLength(1);
    expect(screen.getByTestId('catalog-detail-pane-format')).toBeVisible();
    expect(screen.getByTestId('catalog-format-detail-status')).toHaveTextContent('Available');
    // The record name appears in the structure tree and again in CPDO-2.3's layout inspector,
    // which the pane mounts above it for a copybook.
    expect(
      screen.getAllByRole('treeitem').some((row) => row.textContent?.includes('CLAIM-RECORD')),
    ).toBe(true);
    expect(screen.getByTestId('catalog-copybook-inspector')).toBeInTheDocument();
    // The Overview pane stays mounted (hidden), so nothing about it was disturbed.
    expect(screen.getByTestId('catalog-detail-pane-overview')).not.toBeVisible();
  });

  it('opens the tab with the deep-linked construct expanded and selected', async () => {
    searchParams = new URLSearchParams('tab=format&node=fld-amount');
    render(<CatalogItemDetailClient itemId={ITEM_ID} />);

    await waitFor(() => expect(screen.getByTestId('catalog-detail-tab-format')).toHaveAttribute('aria-selected', 'true'));
    await waitFor(() =>
      expect(
        screen
          .getAllByRole('treeitem')
          .find((element) => element.getAttribute('data-node-id') === 'fld-amount'),
      ).toHaveAttribute('aria-selected', 'true'),
    );
    expect(screen.getByTestId('catalog-format-detail-selected')).toHaveTextContent('CLAIM-AMOUNT');
  });

  it('follows a construct’s source location into the Source & Code tab', async () => {
    render(<CatalogItemDetailClient itemId={ITEM_ID} />);
    fireEvent.click(await screen.findByTestId('catalog-detail-tab-format'));
    await waitFor(() => expect(screen.getByRole('tree')).toBeInTheDocument());

    const field = screen
      .getAllByRole('treeitem')
      .find((element) => element.getAttribute('data-node-id') === 'fld-amount')!;
    fireEvent.click(field);
    fireEvent.click(await screen.findByTestId('catalog-format-detail-view-source'));

    // The shell switched panes and the viewer states which construct and line it was sent to.
    await waitFor(() =>
      expect(screen.getByTestId('catalog-detail-tab-source')).toHaveAttribute('aria-selected', 'true'),
    );
    const note = screen.getByTestId('catalog-detail-source-highlight');
    expect(note).toHaveTextContent('Format details construct');
    expect(note).toHaveTextContent('claim.cpy');
    expect(note).toHaveTextContent('highlighting line 12');
  });

  it('keeps the compatibility deep link’s own wording when it is the one that asked', async () => {
    searchParams = new URLSearchParams('tab=source&sourcePath=claim.cpy&line=7');
    render(<CatalogItemDetailClient itemId={ITEM_ID} />);

    const note = await screen.findByTestId('catalog-detail-source-highlight');
    expect(note).toHaveTextContent('Compatibility deep link');
    expect(note).toHaveTextContent('highlighting line 7');
    // …and it never triggers the analysis fetch, because the Format tab was never selected.
    expect(analysisCalls()).toHaveLength(0);
  });

  it('ignores a ?tab= value that names no pane', async () => {
    searchParams = new URLSearchParams('tab=not-a-pane');
    render(<CatalogItemDetailClient itemId={ITEM_ID} />);

    await waitFor(() =>
      expect(screen.getByTestId('catalog-detail-tab-overview')).toHaveAttribute('aria-selected', 'true'),
    );
  });
});
