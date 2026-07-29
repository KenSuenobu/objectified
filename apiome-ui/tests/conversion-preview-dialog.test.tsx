/**
 * Tests for the catalog → OpenAPI conversion preview dialog (MFI-22.4, #4005).
 *
 * The dialog dry-runs the conversion lazily on open and presents three tabs — Summary
 * (fidelity report columns + defaults), Projection graph (CPDO-3.1/3.2), and Conversion
 * (the raw OpenAPI document) — under a tier-scaled warning banner. It gates Convert behind
 * an acknowledgement on low-tier sources, flows user-supplied defaults into the commit, and
 * makes no changes on cancel.
 */
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

jest.mock('@monaco-editor/react', () => ({
  __esModule: true,
  default: ({ value, language }: { value?: string; language?: string }) => (
    <div data-testid="conversion-raw-content" data-language={language}>
      {value}
    </div>
  ),
}));

import { ConversionPreviewDialog } from '../src/app/components/ade/dashboard/catalog/ConversionPreviewDialog';

/** A low-tier dry-run result: pub/sub source, gaps + losses, gated behind acknowledgement. */
const LOW_TIER = {
  success: true,
  report: {
    score: 41,
    grade: 'F',
    tier: 'low',
    penalty: 59,
    coverage_counts: { present: 1, inferred: 1, missing: 1, 'n/a': 1 },
    items: [
      { key: 'schemas', title: 'Component schemas', coverage: 'present', weight: 5, count: 3, examples: ['#/components/schemas/Order'], reason: 'schemas carried from the source' },
      { key: 'operationId', title: 'Operation ids', coverage: 'inferred', weight: 2, count: 2, examples: [], reason: 'operationIds synthesized from channel names' },
      { key: 'servers', title: 'Servers', coverage: 'missing', weight: 3, count: 0, examples: [], reason: 'source declares no servers' },
      { key: 'responses', title: 'Responses', coverage: 'n/a', weight: 4, count: 0, examples: [], reason: 'a pub/sub source has no responses' },
    ],
    losses: [
      { kind: 'n/a', subject: 'pubsub-action', detail: 'publish/subscribe actions have no OpenAPI representation', pointer: null },
    ],
  },
  openapi: { openapi: '3.1.0', info: { title: 'x' } },
  sourceFormat: 'asyncapi',
};

/** A high-tier dry-run result: near-lossless, no acknowledgement required. */
const HIGH_TIER = {
  success: true,
  report: {
    score: 100,
    grade: 'A',
    tier: 'high',
    penalty: 0,
    coverage_counts: { present: 2 },
    items: [
      { key: 'paths', title: 'Paths', coverage: 'present', weight: 5, count: 4, examples: [], reason: 'paths carried from the source' },
    ],
    losses: [],
  },
  sourceFormat: 'odata',
};

function okFetch(payload: unknown) {
  return jest.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(payload) });
}

describe('ConversionPreviewDialog', () => {
  afterEach(() => jest.restoreAllMocks());

  it('does not fetch while closed', () => {
    global.fetch = jest.fn() as unknown as typeof fetch;
    render(<ConversionPreviewDialog itemId={null} itemName="Acme" open={false} onOpenChange={() => {}} />);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('dry-runs on open and renders both columns from the report', async () => {
    global.fetch = okFetch(LOW_TIER) as unknown as typeof fetch;
    render(<ConversionPreviewDialog itemId="cat-1" itemName="Orders" sourceFormat="asyncapi" open onOpenChange={() => {}} />);

    await waitFor(() => expect(screen.getByTestId('conversion-provided-column')).toBeInTheDocument());
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/catalog/cat-1/convert?dryRun=true',
      expect.objectContaining({ method: 'POST' })
    );

    // Provided column has present + inferred; missing column has missing + n/a + the loss.
    const provided = screen.getByTestId('conversion-provided-column');
    expect(provided).toHaveTextContent('Component schemas');
    expect(provided).toHaveTextContent('Operation ids');
    const missing = screen.getByTestId('conversion-missing-column');
    expect(missing).toHaveTextContent('Servers');
    expect(missing).toHaveTextContent('Responses');
    expect(missing).toHaveTextContent('pubsub-action');

    // Header shows grade + tier.
    expect(screen.getByText('F')).toBeInTheDocument();
    expect(screen.getByTestId('conversion-tier-pill')).toHaveTextContent('low fidelity');
  });

  it('shows the mandatory warning banner and gates Convert on low tier', async () => {
    global.fetch = okFetch(LOW_TIER) as unknown as typeof fetch;
    render(<ConversionPreviewDialog itemId="cat-1" itemName="Orders" open onOpenChange={() => {}} />);

    await waitFor(() => expect(screen.getByTestId('conversion-warning-banner')).toBeInTheDocument());
    expect(screen.getByTestId('conversion-warning-banner')).toHaveAttribute('data-severity', 'critical');
    expect(screen.getByTestId('conversion-warning-banner')).toHaveTextContent(
      'may not be complete enough'
    );

    // Convert disabled until the acknowledgement is checked.
    const convert = screen.getByTestId('conversion-convert-btn');
    expect(convert).toBeDisabled();
    fireEvent.click(screen.getByTestId('conversion-ack'));
    expect(convert).toBeEnabled();
  });

  it('does not gate Convert on high tier (warning shown, no acknowledgement)', async () => {
    global.fetch = okFetch(HIGH_TIER) as unknown as typeof fetch;
    render(<ConversionPreviewDialog itemId="cat-1" itemName="Catalog" open onOpenChange={() => {}} />);

    await waitFor(() => expect(screen.getByTestId('conversion-convert-btn')).toBeInTheDocument());
    expect(screen.getByTestId('conversion-warning-banner')).toHaveAttribute('data-severity', 'info');
    expect(screen.queryByTestId('conversion-ack')).not.toBeInTheDocument();
    expect(screen.getByTestId('conversion-convert-btn')).toBeEnabled();
  });

  it('flows user-entered defaults into the commit and refreshes on success', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(HIGH_TIER) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ success: true, projectId: 'p1' }) });
    global.fetch = fetchMock as unknown as typeof fetch;
    const onConverted = jest.fn();
    const onOpenChange = jest.fn();
    render(
      <ConversionPreviewDialog
        itemId="cat-1"
        itemName="Catalog"
        open
        onOpenChange={onOpenChange}
        onConverted={onConverted}
      />
    );

    await waitFor(() => expect(screen.getByTestId('conversion-default-title')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('conversion-default-title'), { target: { value: 'My API' } });
    fireEvent.change(screen.getByTestId('conversion-default-servers'), {
      target: { value: 'https://api.example.com, ' },
    });
    fireEvent.click(screen.getByTestId('conversion-convert-btn'));

    await waitFor(() => expect(onConverted).toHaveBeenCalled());
    // Second fetch is the commit (dryRun=false) carrying the cleaned defaults.
    const commitCall = fetchMock.mock.calls[1];
    expect(commitCall[0]).toBe('/api/catalog/cat-1/convert');
    const body = JSON.parse((commitCall[1] as { body: string }).body);
    expect(body).toMatchObject({
      dryRun: false,
      defaults: { title: 'My API', servers: ['https://api.example.com'] },
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('cancel makes no changes (no commit request, no onConverted)', async () => {
    const fetchMock = okFetch(HIGH_TIER);
    global.fetch = fetchMock as unknown as typeof fetch;
    const onConverted = jest.fn();
    const onOpenChange = jest.fn();
    render(
      <ConversionPreviewDialog itemId="cat-1" itemName="Catalog" open onOpenChange={onOpenChange} onConverted={onConverted} />
    );

    await waitFor(() => expect(screen.getByText('Cancel')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Cancel'));

    expect(onConverted).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    // Only the initial dry-run fired — no commit.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shows an error with a retry that re-runs the dry-run', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, json: () => Promise.resolve({ success: false, error: 'boom' }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(HIGH_TIER) });
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<ConversionPreviewDialog itemId="cat-1" itemName="Catalog" open onOpenChange={() => {}} />);

    await waitFor(() => expect(screen.getByTestId('conversion-preview-error')).toBeInTheDocument());
    expect(screen.getByText('boom')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Retry'));
    await waitFor(() => expect(screen.getByTestId('conversion-convert-btn')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shows the raw OpenAPI document on the Conversion tab', async () => {
    global.fetch = okFetch(LOW_TIER) as unknown as typeof fetch;
    render(<ConversionPreviewDialog itemId="cat-1" itemName="Orders" open onOpenChange={() => {}} />);

    await waitFor(() => expect(screen.getByTestId('conversion-tab-conversion')).toBeInTheDocument());
    // The summary tab is active by default; the document renders only on its own tab.
    expect(screen.getByTestId('conversion-provided-column')).toBeInTheDocument();
    expect(screen.queryByTestId('conversion-raw-preview')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('conversion-tab-conversion'));
    expect(screen.getByTestId('conversion-raw-preview')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('conversion-raw-content')).toHaveTextContent('3.1.0'),
    );
    expect(screen.getByTestId('conversion-raw-content')).toHaveAttribute('data-language', 'json');
  });

  it('lazily loads the projection graph on its tab (CPDO-3.1)', async () => {
    // One retained construct edge, server-shaped (CPDO-1.3).
    const projectionPage = {
      success: true,
      itemId: 'cat-1',
      versionRecordId: 'v1',
      target: 'openapi',
      summary: {
        schema_version: '1.0.0',
        manifest_hash: 'a'.repeat(64),
        source: {
          project_id: 'p1',
          version_record_id: 'v1',
          source_format: 'asyncapi',
          source_protocol: null,
          source_version_label: null,
          paradigm: 'pubsub',
          analysis: {
            available: false,
            status: 'unavailable',
            status_reason: 'not_analyzed',
            analyzer_key: null,
            analyzer_version: null,
            node_count: 0,
            truncated: false,
            unsupported_constructs: [],
          },
        },
        target_format: 'openapi-3.1',
        conversion_mode: 'lossy',
        tool_versions: {},
        defaults: {},
        status_counts: { retained: 1, transformed: 0, inferred: 0, dropped: 0, unavailable: 0, 'not-applicable': 0 },
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
        manifest_hash: 'a'.repeat(64),
        edges: [
          {
            id: 'construct:operation:op:send',
            scope: 'construct',
            source: 'source:construct:op:send',
            target: 'target:/paths/~1send/post',
            status: 'retained',
            reason: null,
            severity: 'info',
            detail: 'carried onto the document',
            remediation: null,
            evidence: [],
            count: 1,
          },
        ],
        nodes: [
          {
            id: 'source:construct:op:send',
            kind: 'source',
            label: 'send',
            construct_key: 'op:send',
            source: { native_id: null, native_name: null, source_location: null, construct_kind: 'operation' },
            target: null,
          },
          {
            id: 'target:/paths/~1send/post',
            kind: 'target',
            label: '/paths/~1send/post',
            construct_key: null,
            source: null,
            target: { json_pointer: '/paths/~1send/post', native_path: null },
          },
        ],
        next_cursor: null,
        total: 1,
      },
    };
    const fetchMock = jest.fn((url: unknown) =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(
            String(url).includes('/projection') ? projectionPage : LOW_TIER,
          ),
      }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<ConversionPreviewDialog itemId="cat-1" itemName="Orders" open onOpenChange={() => {}} />);

    await waitFor(() => expect(screen.getByTestId('conversion-tab-projection')).toBeInTheDocument());
    // The summary tab is active by default: only the dry-run has been fetched.
    expect(screen.queryByTestId('conversion-projection-panel')).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes('/projection'))).toBe(true);

    await userEvent.click(screen.getByTestId('conversion-tab-projection'));
    await waitFor(() =>
      expect(screen.getByTestId('conversion-projection-table')).toBeInTheDocument(),
    );
    expect(
      fetchMock.mock.calls.some(([url]) => String(url) === '/api/catalog/cat-1/projection'),
    ).toBe(true);
    expect(screen.getByTestId('conversion-projection-node-construct:operation:op:send')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// CPDO-3.2 — evidence drawer remediation: approved defaults recompute atomically
// ---------------------------------------------------------------------------

describe('ConversionPreviewDialog — approved defaults recompute (CPDO-3.2)', () => {
  /** A low-tier report whose one gap (missing API version) a safe default can close. */
  const VERSION_GAP_TIER = {
    ...LOW_TIER,
    report: {
      ...LOW_TIER.report,
      items: [
        {
          key: 'info.version',
          title: 'API version',
          coverage: 'missing',
          weight: 3,
          count: 1,
          examples: ['/info/version'],
          reason: 'source declares no API version; a placeholder was emitted',
        },
      ],
      losses: [],
    },
  };

  /** The recomputed report once the version default is applied: medium tier, no ack gate. */
  const RECOMPUTED_TIER = {
    ...VERSION_GAP_TIER,
    report: { ...VERSION_GAP_TIER.report, score: 82, grade: 'B', tier: 'medium', penalty: 18 },
  };

  /** One default-fixable checklist edge, server-shaped, hash varying with the defaults. */
  function projectionPayload(hash: string, defaults: Record<string, unknown>) {
    return {
      success: true,
      itemId: 'cat-1',
      versionRecordId: 'v1',
      target: 'openapi',
      summary: {
        schema_version: '1.0.0',
        manifest_hash: hash,
        source: {
          project_id: 'p1',
          version_record_id: 'v1',
          source_format: 'graphql',
          source_protocol: null,
          source_version_label: null,
          paradigm: 'graphql',
          analysis: {
            available: false,
            status: 'unavailable',
            status_reason: 'not_analyzed',
            analyzer_key: null,
            analyzer_version: null,
            node_count: 0,
            truncated: false,
            unsupported_constructs: [],
          },
        },
        target_format: 'openapi-3.1',
        conversion_mode: 'lossy',
        tool_versions: { converter: '2.0' },
        defaults,
        status_counts: { retained: 0, transformed: 0, inferred: 0, dropped: 0, unavailable: 1, 'not-applicable': 0 },
        reason_counts: {},
        scope_counts: {},
        node_count: 1,
        edge_count: 1,
        total_constructs: 1,
        is_lossless: false,
        worst_severity: 'warn',
        truncated: false,
        dropped_edge_count: 0,
      },
      page: {
        manifest_hash: hash,
        edges: [
          {
            id: 'checklist:info.version',
            scope: 'checklist',
            source: 'source:checklist:info.version',
            target: null,
            status: 'unavailable',
            reason: 'source_incomplete',
            severity: 'warn',
            detail: 'the source never declared an API version',
            remediation: 'Supply a version default before converting.',
            evidence: [],
            count: 1,
          },
        ],
        nodes: [
          {
            id: 'source:checklist:info.version',
            kind: 'source',
            label: 'API version',
            construct_key: 'info.version',
            source: { native_id: null, native_name: 'API version', source_location: null, construct_kind: 'checklist' },
            target: null,
          },
        ],
        next_cursor: null,
        total: 1,
      },
    };
  }

  /** Route the mock by URL and body: dry-runs by call order, projections by their defaults. */
  function installRecomputeFetch() {
    let dryRuns = 0;
    const fn = jest.fn((url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? '{}') as { defaults?: Record<string, unknown> };
      const payload = String(url).includes('/projection')
        ? body.defaults?.version != null
          ? projectionPayload('b'.repeat(64), body.defaults)
          : projectionPayload('a'.repeat(64), {})
        : (dryRuns += 1) === 1
          ? VERSION_GAP_TIER
          : RECOMPUTED_TIER;
      return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
    });
    global.fetch = fn as unknown as typeof fetch;
    return fn;
  }

  it('applying a safe default from the drawer recomputes report + graph together and re-asks acknowledgement', async () => {
    const fetchMock = installRecomputeFetch();
    render(<ConversionPreviewDialog itemId="cat-1" itemName="Orders" open onOpenChange={() => {}} />);

    // Low tier: acknowledge, so the reset is observable.
    await waitFor(() => expect(screen.getByTestId('conversion-ack')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('conversion-ack'));
    expect(screen.getByTestId('conversion-convert-btn')).toBeEnabled();

    // Open the projection tab and the evidence drawer from its graph node.
    await userEvent.click(screen.getByTestId('conversion-tab-projection'));
    await waitFor(() =>
      expect(screen.getByTestId('conversion-projection-node-checklist:info.version')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('conversion-projection-node-checklist:info.version'));

    // Approve the safe default.
    fireEvent.change(screen.getByTestId('conversion-projection-safe-default-input'), {
      target: { value: '2.0.0' },
    });
    fireEvent.click(screen.getByTestId('conversion-projection-safe-default-apply'));

    // The report recomputes with the approved defaults…
    await waitFor(() => expect(screen.getByTestId('conversion-tier-pill')).toHaveTextContent('medium'));
    const dryRunCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/convert'));
    expect(dryRunCalls).toHaveLength(2);
    expect(JSON.parse((dryRunCalls[1][1] as { body: string }).body).defaults).toEqual({
      version: '2.0.0',
    });

    // …and the graph re-walks with the SAME defaults (one snapshot, no mismatch banner).
    await waitFor(() => {
      const projectionCalls = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('/projection'),
      );
      const last = projectionCalls[projectionCalls.length - 1];
      expect(JSON.parse((last[1] as { body: string }).body).defaults).toEqual({ version: '2.0.0' });
    });
    await waitFor(() =>
      expect(screen.getByTestId('conversion-projection-snapshot')).toHaveTextContent('bbbbbbbbbbbb'),
    );
    expect(screen.queryByTestId('conversion-projection-mismatch')).not.toBeInTheDocument();

    // Acknowledgement severity was recomputed: medium tier no longer gates Convert.
    expect(screen.queryByTestId('conversion-ack')).not.toBeInTheDocument();
    expect(screen.getByTestId('conversion-warning-banner')).toHaveAttribute('data-severity', 'warning');
    // The summary tab's inline defaults form now reflects the applied default.
    await userEvent.click(screen.getByTestId('conversion-tab-summary'));
    expect(screen.getByTestId('conversion-default-version')).toHaveValue('2.0.0');
  });

  it('keeps the loaded projection graph mounted across tab switches without refetching', async () => {
    const fetchMock = installRecomputeFetch();
    render(<ConversionPreviewDialog itemId="cat-1" itemName="Orders" open onOpenChange={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('conversion-tab-projection')).toBeInTheDocument());

    await userEvent.click(screen.getByTestId('conversion-tab-projection'));
    await waitFor(() =>
      expect(screen.getByTestId('conversion-projection-table')).toBeInTheDocument(),
    );
    const loadedCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/projection'))
      .length;

    // Switching away hides the graph but keeps it mounted with its loaded walk…
    await userEvent.click(screen.getByTestId('conversion-tab-summary'));
    expect(screen.getByTestId('conversion-provided-column')).toBeInTheDocument();
    expect(screen.getByTestId('conversion-projection-panel')).toBeInTheDocument();

    // …so coming back neither refetches nor rebuilds.
    await userEvent.click(screen.getByTestId('conversion-tab-projection'));
    expect(screen.getByTestId('conversion-projection-table')).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes('/projection')).length,
    ).toBe(loadedCalls);
  });

  it('the inline defaults form offers Apply & recompute and resets a given acknowledgement', async () => {
    let dryRuns = 0;
    const fetchMock = jest.fn(() => {
      dryRuns += 1;
      return Promise.resolve({ ok: true, json: () => Promise.resolve(VERSION_GAP_TIER) });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<ConversionPreviewDialog itemId="cat-1" itemName="Orders" open onOpenChange={() => {}} />);

    await waitFor(() => expect(screen.getByTestId('conversion-ack')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('conversion-ack'));

    // No recompute affordance until the defaults differ from the previewed snapshot.
    expect(screen.queryByTestId('conversion-defaults-recompute')).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId('conversion-default-version'), { target: { value: '2.0.0' } });
    fireEvent.click(screen.getByTestId('conversion-defaults-recompute'));

    await waitFor(() => expect(dryRuns).toBe(2));
    // Still low tier — but the acknowledgement was reset and gates Convert again.
    await waitFor(() => expect(screen.getByTestId('conversion-ack')).not.toBeChecked());
    expect(screen.getByTestId('conversion-convert-btn')).toBeDisabled();
    // In-sync defaults hide the affordance again.
    expect(screen.queryByTestId('conversion-defaults-recompute')).not.toBeInTheDocument();
  });

  it('a failed recompute keeps the previous report and defaults, and says so', async () => {
    let dryRuns = 0;
    const fetchMock = jest.fn(() => {
      dryRuns += 1;
      return dryRuns === 1
        ? Promise.resolve({ ok: true, json: () => Promise.resolve(VERSION_GAP_TIER) })
        : Promise.resolve({
            ok: false,
            status: 500,
            json: () => Promise.resolve({ success: false, error: 'recompute exploded' }),
          });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<ConversionPreviewDialog itemId="cat-1" itemName="Orders" open onOpenChange={() => {}} />);

    await waitFor(() => expect(screen.getByTestId('conversion-tier-pill')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('conversion-default-version'), { target: { value: '2.0.0' } });
    fireEvent.click(screen.getByTestId('conversion-defaults-recompute'));

    const error = await screen.findByTestId('conversion-recompute-error');
    expect(error).toHaveTextContent('recompute exploded');
    expect(error).toHaveTextContent('still shows the previous defaults');
    // The previous report is untouched and the affordance remains for another try.
    expect(screen.getByTestId('conversion-tier-pill')).toHaveTextContent('low');
    expect(screen.getByTestId('conversion-defaults-recompute')).toBeInTheDocument();
  });
});
