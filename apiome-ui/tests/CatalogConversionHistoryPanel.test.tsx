/**
 * CatalogConversionHistoryPanel — the catalog item's conversion evidence history (CPDO-3.3, #4803).
 *
 * Covers the acceptance criteria on the surface:
 *  1. **Lazy + one-shot** — no fetch until the tab activates; toggling never refetches.
 *  2. **The list** — newest-first rows with grade chips, re-convert / source-changed badges,
 *     and the snapshot chip stating replayability; the newest row auto-selects.
 *  3. **Historic vs fresh** — the neutral captured-at note always names the selected snapshot;
 *     the amber note appears exactly when the row's source digest differs from the current one,
 *     pointing at the Convert preview.
 *  4. **Exact approved evidence** — selecting a row replays its *stored* snapshot through the
 *     shared projection panel via the evidence endpoint (never the projection rebuild).
 *  5. **Safe degrade** — a pre-snapshot row renders the explicit unavailable block and fires no
 *     evidence request at all; history fetch failures render a retryable error; an empty
 *     history states itself.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { CatalogConversionHistoryPanel } from '../src/app/components/ade/dashboard/catalog/CatalogConversionHistoryPanel';

const HASH_FRESH = 'a'.repeat(64);
const HASH_STALE = 'b'.repeat(64);
const CURRENT_SOURCE = 'sha256:' + '11'.repeat(32);

function historyRow(overrides: Record<string, unknown> = {}) {
  return {
    provenanceId: 'prov-2',
    createdAt: '2026-07-10T00:00:00Z',
    createdBy: 'user-1',
    reconverted: false,
    conversionMode: 'lossy',
    sourceProjectId: 'item-1',
    sourceProjectName: 'Ping API',
    sourceFormat: 'graphql',
    sourceVersionId: 'rev-2',
    targetProjectId: 'proj-9',
    targetProjectName: 'Ping API (OpenAPI)',
    targetProjectSlug: 'ping-api-openapi',
    targetProjectDeleted: false,
    targetVersionLabel: '1.0.1',
    targetVersionRecordId: 'ver-10',
    fidelityScore: 74,
    fidelityGrade: 'C',
    fidelityTier: 'medium',
    toolVersions: { 'apiome-rest': '1.79.0' },
    defaults: {},
    schemaVersion: '1.0.0',
    manifestHash: HASH_FRESH,
    sourceHash: CURRENT_SOURCE,
    snapshotAvailable: true,
    ...overrides,
  };
}

/** Three-row history: fresh (auto-selected), stale re-convert, pre-migration. */
const HISTORY = {
  success: true,
  itemId: 'item-1',
  currentSourceHash: CURRENT_SOURCE,
  conversions: [
    historyRow(),
    historyRow({
      provenanceId: 'prov-1',
      createdAt: '2026-06-01T00:00:00Z',
      reconverted: true,
      targetVersionLabel: '1.0.0',
      targetVersionRecordId: 'ver-9',
      manifestHash: HASH_STALE,
      sourceHash: 'sha256:' + '22'.repeat(32),
    }),
    historyRow({
      provenanceId: 'prov-0',
      createdAt: '2026-05-01T00:00:00Z',
      targetVersionLabel: null,
      manifestHash: null,
      sourceHash: null,
      snapshotAvailable: false,
    }),
  ],
};

function evidencePayload(hash: string) {
  return {
    success: true,
    provenanceId: 'prov-x',
    itemId: 'item-1',
    manifestHash: hash,
    sourceHash: CURRENT_SOURCE,
    snapshot: { status: 'available', reason: null },
    summary: {
      schema_version: '1.0.0',
      manifest_hash: hash,
      source: {
        project_id: null,
        version_record_id: null,
        source_format: 'graphql',
        source_protocol: null,
        source_version_label: null,
        paradigm: 'graphql',
        analysis: {
          available: false,
          status: 'unavailable',
          status_reason: null,
          analyzer_key: null,
          analyzer_version: null,
          node_count: 0,
          truncated: false,
          unsupported_constructs: [],
        },
      },
      target_format: 'openapi-3.1',
      conversion_mode: 'lossy',
      tool_versions: { 'apiome-rest': '1.79.0' },
      defaults: {},
      status_counts: { retained: 1 },
      reason_counts: {},
      scope_counts: {},
      node_count: 2,
      edge_count: 1,
      total_constructs: 1,
      is_lossless: true,
      worst_severity: null,
      truncated: false,
      dropped_edge_count: 0,
    },
    page: {
      manifest_hash: hash,
      edges: [
        {
          id: 'construct:op:ping',
          scope: 'construct',
          source: 'source:op:ping',
          target: 'target:/paths/ping',
          status: 'retained',
          reason: null,
          severity: 'info',
          detail: 'retained detail',
          remediation: null,
          evidence: [],
          count: 1,
        },
      ],
      nodes: [
        {
          id: 'source:op:ping',
          kind: 'source',
          label: 'ping',
          construct_key: null,
          source: { native_id: null, native_name: 'ping', source_location: null, construct_kind: 'operation' },
          target: null,
        },
        {
          id: 'target:/paths/ping',
          kind: 'target',
          label: '/paths/ping',
          construct_key: null,
          source: null,
          target: { json_pointer: '/paths/ping', native_path: null },
        },
      ],
      next_cursor: null,
      total: 1,
    },
  };
}

/** Serve history + evidence by URL; records every request for order/count assertions. */
function installFetch(history: unknown = HISTORY) {
  const calls: string[] = [];
  const fn = jest.fn(async (url: unknown) => {
    const href = String(url);
    calls.push(href);
    if (href === '/api/catalog/item-1/conversions') {
      return { ok: true, status: 200, json: async () => history };
    }
    const match = href.match(/\/conversions\/([^/]+)\/evidence/);
    if (match) {
      const hash = match[1] === 'prov-2' ? HASH_FRESH : HASH_STALE;
      return { ok: true, status: 200, json: async () => evidencePayload(hash) };
    }
    throw new Error(`unexpected fetch ${href}`);
  });
  global.fetch = fn as unknown as typeof fetch;
  return { fn, calls };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('CatalogConversionHistoryPanel', () => {
  it('does not fetch until active, then loads once and never refetches on toggle', async () => {
    const { fn } = installFetch();
    const { rerender } = render(<CatalogConversionHistoryPanel itemId="item-1" active={false} />);
    expect(fn).not.toHaveBeenCalled();

    rerender(<CatalogConversionHistoryPanel itemId="item-1" active />);
    await waitFor(() => expect(screen.getByTestId('conversion-history-list')).toBeInTheDocument());
    const historyCalls = () =>
      fn.mock.calls.filter((call) => String(call[0]) === '/api/catalog/item-1/conversions').length;
    expect(historyCalls()).toBe(1);

    rerender(<CatalogConversionHistoryPanel itemId="item-1" active={false} />);
    rerender(<CatalogConversionHistoryPanel itemId="item-1" active />);
    expect(historyCalls()).toBe(1);
  });

  it('renders rows newest-first with badges and auto-selects the newest', async () => {
    installFetch();
    render(<CatalogConversionHistoryPanel itemId="item-1" active />);
    await waitFor(() => expect(screen.getByTestId('conversion-history-list')).toBeInTheDocument());

    const rows = screen.getAllByTestId('conversion-history-row');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveAttribute('data-provenance-id', 'prov-2');
    expect(rows[0]).toHaveAttribute('aria-pressed', 'true');

    // Badges: re-converted on the middle row only; source-changed on the stale row only.
    expect(screen.getAllByTestId('conversion-history-reconverted')).toHaveLength(1);
    expect(screen.getAllByTestId('conversion-history-source-changed')).toHaveLength(1);
    // Snapshot chips: two replayable hashes + one "No stored snapshot".
    const chips = screen.getAllByTestId('conversion-history-snapshot-chip');
    expect(chips[0]).toHaveTextContent(`snapshot ${HASH_FRESH.slice(0, 12)}`);
    expect(chips[2]).toHaveTextContent('No stored snapshot');
    // Grade chip carries grade + score.
    expect(screen.getAllByTestId('conversion-history-grade')[0]).toHaveTextContent('C · 74');
  });

  it('replays the stored snapshot of the selected row through the shared panel', async () => {
    const { calls } = installFetch();
    render(<CatalogConversionHistoryPanel itemId="item-1" active />);

    await waitFor(() =>
      expect(screen.getByTestId('conversion-projection-table')).toBeInTheDocument(),
    );
    // The evidence came from the stored-snapshot endpoint of the auto-selected newest row…
    expect(calls.some((href) => href.includes('/conversions/prov-2/evidence'))).toBe(true);
    // …never from the live projection rebuild.
    expect(calls.some((href) => href.includes('/projection'))).toBe(false);

    // The historic note names the snapshot; the auto-selected row's source is current → no amber.
    expect(screen.getByTestId('conversion-history-historic-note')).toHaveTextContent(
      `snapshot ${HASH_FRESH.slice(0, 12)}`,
    );
    expect(screen.queryByTestId('conversion-history-stale-note')).not.toBeInTheDocument();
  });

  it('marks a stale selection and points at the Convert preview for fresh evidence', async () => {
    installFetch();
    const onOpenConvertPreview = jest.fn();
    render(
      <CatalogConversionHistoryPanel
        itemId="item-1"
        active
        onOpenConvertPreview={onOpenConvertPreview}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('conversion-history-list')).toBeInTheDocument());

    fireEvent.click(screen.getAllByTestId('conversion-history-row')[1]);
    const note = await screen.findByTestId('conversion-history-stale-note');
    expect(note).toHaveTextContent('The source has changed since this conversion was approved.');
    fireEvent.click(screen.getByRole('button', { name: 'Open the Convert preview' }));
    expect(onOpenConvertPreview).toHaveBeenCalled();
  });

  it('degrades a pre-snapshot row to the explicit block without any evidence request', async () => {
    const { calls } = installFetch();
    render(<CatalogConversionHistoryPanel itemId="item-1" active />);
    await waitFor(() => expect(screen.getByTestId('conversion-history-list')).toBeInTheDocument());

    fireEvent.click(screen.getAllByTestId('conversion-history-row')[2]);
    expect(screen.getByTestId('conversion-history-snapshot-unavailable')).toHaveTextContent(
      'predates stored evidence snapshots',
    );
    expect(calls.some((href) => href.includes('/conversions/prov-0/evidence'))).toBe(false);
  });

  it('states an empty history', async () => {
    installFetch({ success: true, itemId: 'item-1', currentSourceHash: null, conversions: [] });
    render(<CatalogConversionHistoryPanel itemId="item-1" active />);
    await waitFor(() =>
      expect(screen.getByTestId('conversion-history-empty')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('conversion-history-empty')).toHaveTextContent(
      'No conversions have been recorded',
    );
  });

  it('renders a retryable error when the history fetch fails', async () => {
    let failures = 0;
    const fn = jest.fn(async (url: unknown) => {
      if (String(url) === '/api/catalog/item-1/conversions' && failures === 0) {
        failures += 1;
        return { ok: false, status: 500, json: async () => ({ success: false, error: 'History store down' }) };
      }
      return { ok: true, status: 200, json: async () => HISTORY };
    });
    global.fetch = fn as unknown as typeof fetch;

    render(<CatalogConversionHistoryPanel itemId="item-1" active />);
    const error = await screen.findByTestId('conversion-history-error');
    expect(error).toHaveTextContent('History store down');

    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    await waitFor(() => expect(screen.getByTestId('conversion-history-list')).toBeInTheDocument());
  });
});
