/**
 * ConversionProjectionGraphPanel — the conversion preview's projection graph (CPDO-3.1, #4801).
 *
 * Covers the acceptance criteria on the component:
 *  1. **Count parity** — the legend, graph, and table render from one view; the loaded
 *     evidence reconciles against the manifest summary's own tallies, and a mismatch is
 *     stated rather than hidden.
 *  2. **Selection + keyboard** — graph nodes and table rows select the same evidence card;
 *     roving tabindex with arrow keys; Enter selects; Escape resets the view (zoom included).
 *  3. **Zoom / reset** — plain buttons scale the deterministic SVG canvas.
 *  4. **Mermaid text export** — copy places the sanitized flowchart text on the clipboard.
 *  5. **Bounds** — the draw budget states drawn-of-total; aggregates expand in the table;
 *     the table windows above its budget with spacers.
 *  6. **Paging** — the cursor walk accumulates pages, pauses after a window with a stated
 *     loaded-of-total, and Load more continues to completion.
 *  7. **Refusals** — transport errors offer retry; an incoherent page refuses the view;
 *     a dry-run envelope with a different snapshot hash is stated.
 *  8. **Sanitization** — hostile imported labels render as inert, cleaned text.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { ConversionProjectionGraphPanel } from '../src/app/components/ade/dashboard/catalog/ConversionProjectionGraphPanel';
import type {
  ConversionManifestSummary,
  ConversionProjectionEdge,
  ConversionProjectionNode,
  ConversionProjectionStatus,
} from '../src/app/utils/conversion-projection';

// ---------------------------------------------------------------------------
// Server-shaped fixtures
// ---------------------------------------------------------------------------

function sourceNode(
  id: string,
  label: string,
  options: { nativeName?: string | null; location?: string | null; kind?: string | null } = {},
): ConversionProjectionNode {
  return {
    id,
    kind: 'source',
    label,
    construct_key: null,
    source: {
      native_id: null,
      native_name: options.nativeName ?? null,
      source_location: options.location ?? null,
      construct_kind: options.kind ?? null,
    },
    target: null,
  };
}

function targetNode(id: string, pointer: string): ConversionProjectionNode {
  return {
    id,
    kind: 'target',
    label: pointer,
    construct_key: null,
    source: null,
    target: { json_pointer: pointer, native_path: null },
  };
}

function edge(
  id: string,
  scope: ConversionProjectionEdge['scope'],
  source: string,
  target: string | null,
  status: ConversionProjectionStatus,
  overrides: Partial<ConversionProjectionEdge> = {},
): ConversionProjectionEdge {
  return {
    id,
    scope,
    source,
    target,
    status,
    reason: status === 'retained' ? null : 'destination_unsupported',
    severity: 'info',
    detail: `${status} detail for ${id}`,
    remediation: status === 'retained' ? null : 'Adjust the source to close this gap.',
    evidence: [],
    count: 1,
    ...overrides,
  };
}

const HASH = 'a'.repeat(64);

function summaryFor(
  edges: ConversionProjectionEdge[],
  overrides: Partial<ConversionManifestSummary> = {},
): ConversionManifestSummary {
  const statusCounts: Record<string, number> = {
    retained: 0,
    transformed: 0,
    inferred: 0,
    dropped: 0,
    unavailable: 0,
    'not-applicable': 0,
  };
  for (const e of edges) statusCounts[e.status] += 1;
  return {
    schema_version: '1.0.0',
    manifest_hash: HASH,
    source: {
      project_id: 'p1',
      version_record_id: 'v1',
      source_format: 'graphql',
      source_protocol: null,
      source_version_label: null,
      paradigm: 'graphql',
      analysis: {
        available: true,
        status: 'available',
        status_reason: null,
        analyzer_key: 'graphql',
        analyzer_version: '1',
        node_count: 4,
        truncated: false,
        unsupported_constructs: [],
      },
    },
    target_format: 'openapi-3.1',
    conversion_mode: 'lossy',
    tool_versions: {},
    defaults: {},
    status_counts: statusCounts,
    reason_counts: {},
    scope_counts: {},
    node_count: 8,
    edge_count: edges.length,
    total_constructs: edges.length,
    is_lossless: false,
    worst_severity: 'warn',
    truncated: false,
    dropped_edge_count: 0,
    ...overrides,
  };
}

/** Split (nodes, edges) into cursor pages the way the server does, bundling referenced nodes. */
function paginate(
  nodes: ConversionProjectionNode[],
  edges: ConversionProjectionEdge[],
  perPage: number,
  summary: ConversionManifestSummary,
) {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const pages: Record<string, unknown> = {};
  for (let start = 0, index = 0; start < Math.max(edges.length, 1); start += perPage, index += 1) {
    const pageEdges = edges.slice(start, start + perPage);
    const wanted = new Map<string, ConversionProjectionNode>();
    for (const e of pageEdges) {
      for (const id of [e.source, e.target]) {
        const n = id ? nodeById.get(id) : undefined;
        if (n && !wanted.has(n.id)) wanted.set(n.id, n);
      }
    }
    const cursorKey = index === 0 ? 'start' : `cursor-${index}`;
    const nextCursor = start + perPage < edges.length ? `cursor-${index + 1}` : null;
    pages[cursorKey] = {
      success: true,
      itemId: 'item-1',
      versionRecordId: 'v1',
      target: 'openapi',
      summary,
      page: {
        manifest_hash: summary.manifest_hash,
        edges: pageEdges,
        nodes: [...wanted.values()],
        next_cursor: nextCursor,
        total: edges.length,
      },
    };
  }
  return pages;
}

/** Install a fetch mock that serves the given cursor pages. */
function installFetch(pages: Record<string, unknown>) {
  const fn = jest.fn(async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse((init?.body as string) ?? '{}');
    const key = body.cursor == null ? 'start' : body.cursor;
    const payload = pages[key];
    if (!payload) throw new Error(`no fixture page for cursor ${key}`);
    return { ok: true, status: 200, json: async () => payload };
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

/** Default fixture: retained construct, dropped loss (warn), inferred checklist row. */
function defaultFixture() {
  const nodes = [
    sourceNode('source:construct:operation:getPet', 'getPet', {
      nativeName: 'GET /pets/{id}',
      location: '12',
      kind: 'operation',
    }),
    targetNode('target:/paths/~1pets~1{id}/get', '/paths/~1pets~1{id}/get'),
    sourceNode('source:loss:0', 'graphql-subscription', { kind: 'loss' }),
    sourceNode('source:checklist:info', 'Info block', { kind: 'checklist' }),
    targetNode('target:/info', '/info'),
  ];
  const edges = [
    edge(
      'construct:operation:operation:getPet',
      'construct',
      'source:construct:operation:getPet',
      'target:/paths/~1pets~1{id}/get',
      'retained',
    ),
    edge('loss:0000:graphql-subscription', 'loss', 'source:loss:0', null, 'dropped', {
      severity: 'warn',
      evidence: [{ kind: 'source-construct', ref: 'subscription:onPet', location: null }],
    }),
    edge('checklist:info', 'checklist', 'source:checklist:info', 'target:/info', 'inferred', {
      reason: 'source_incomplete',
      count: 3,
    }),
  ];
  return { nodes, edges, summary: summaryFor(edges) };
}

function renderPanel(
  pages: Record<string, unknown>,
  props: Partial<React.ComponentProps<typeof ConversionProjectionGraphPanel>> = {},
) {
  const fetchMock = installFetch(pages);
  render(
    <ConversionProjectionGraphPanel itemId="item-1" enabled envelopeSummary={null} {...props} />,
  );
  return fetchMock;
}

async function waitForLoaded() {
  await waitFor(() =>
    expect(screen.getByTestId('conversion-projection-table')).toBeInTheDocument(),
  );
}

const graphNodes = () =>
  screen.getAllByTestId(/^conversion-projection-node-/) as unknown as HTMLElement[];

beforeEach(() => {
  Object.defineProperty(global.navigator, 'clipboard', {
    value: { writeText: jest.fn(async () => undefined) },
    configurable: true,
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. Count parity + reconciliation
// ---------------------------------------------------------------------------

describe('ConversionProjectionGraphPanel — counts', () => {
  it('renders legend, graph, and table from one reconciled view', async () => {
    const { nodes, edges, summary } = defaultFixture();
    renderPanel(paginate(nodes, edges, 10, summary));
    await waitForLoaded();

    // Legend speaks the wire statuses, symbol + text + count.
    const legend = screen.getByTestId('conversion-projection-legend');
    expect(within(legend).getByTestId('conversion-projection-legend-retained')).toHaveTextContent('Retained1');
    expect(within(legend).getByTestId('conversion-projection-legend-dropped')).toHaveTextContent('Dropped1');
    expect(within(legend).getByTestId('conversion-projection-legend-inferred')).toHaveTextContent('Inferred1');
    expect(within(legend).getByTestId('conversion-projection-legend-inferred')).toHaveTextContent('∴');

    // One graph node per view entry; one table row per entry.
    expect(graphNodes()).toHaveLength(3);
    expect(screen.getAllByTestId(/^conversion-projection-table-row-/)).toHaveLength(3);

    // Counts reconcile → no mismatch banner; snapshot chip shows the manifest hash.
    expect(screen.queryByTestId('conversion-projection-reconciliation')).not.toBeInTheDocument();
    expect(screen.getByTestId('conversion-projection-snapshot')).toHaveTextContent(HASH.slice(0, 12));
  });

  it('states a reconciliation mismatch instead of presenting wrong counts as truth', async () => {
    const { nodes, edges, summary } = defaultFixture();
    const lying = { ...summary, edge_count: 9, status_counts: { ...summary.status_counts, dropped: 4 } };
    renderPanel(paginate(nodes, edges, 10, lying));
    await waitForLoaded();
    const banner = screen.getByTestId('conversion-projection-reconciliation');
    expect(banner).toHaveTextContent('does not reconcile');
    expect(banner).toHaveTextContent("status 'dropped'");
  });

  it('states a snapshot mismatch against the dry-run envelope summary', async () => {
    const { nodes, edges, summary } = defaultFixture();
    renderPanel(paginate(nodes, edges, 10, summary), {
      envelopeSummary: { ...summary, manifest_hash: 'b'.repeat(64) },
    });
    await waitForLoaded();
    expect(screen.getByTestId('conversion-projection-mismatch')).toHaveTextContent(
      'the source changed in between',
    );
  });

  it('states the server-side manifest bounds when the summary is truncated', async () => {
    const { nodes, edges, summary } = defaultFixture();
    renderPanel(paginate(nodes, edges, 10, { ...summary, truncated: true, dropped_edge_count: 7 }));
    await waitForLoaded();
    expect(screen.getByTestId('conversion-projection-server-truncation')).toHaveTextContent('7');
  });
});

// ---------------------------------------------------------------------------
// 2/3. Selection, keyboard, zoom
// ---------------------------------------------------------------------------

describe('ConversionProjectionGraphPanel — selection and keyboard', () => {
  it('selects the same evidence card from a graph node and its table row', async () => {
    const { nodes, edges, summary } = defaultFixture();
    renderPanel(paginate(nodes, edges, 10, summary));
    await waitForLoaded();

    fireEvent.click(screen.getByTestId('conversion-projection-node-loss:0000:graphql-subscription'));
    const card = screen.getByTestId('conversion-projection-evidence');
    expect(card).toHaveTextContent('graphql-subscription');
    expect(card).toHaveTextContent('destination_unsupported');
    expect(card).toHaveTextContent('Adjust the source to close this gap.');
    expect(card).toHaveTextContent('Loss evidence');
    expect(within(card).getByTestId('conversion-projection-evidence-refs')).toHaveTextContent(
      'subscription:onPet',
    );

    // The synchronized table marks the same selection.
    const row = screen.getByTestId(
      'conversion-projection-table-row-loss:0000:graphql-subscription',
    );
    expect(within(row).getByRole('button', { pressed: true })).toBeInTheDocument();

    // Selecting from the table also drives the card.
    const otherRow = screen.getByTestId(
      'conversion-projection-table-row-checklist:info',
    );
    fireEvent.click(within(otherRow).getByRole('button'));
    expect(screen.getByTestId('conversion-projection-evidence')).toHaveTextContent('Info block');
    expect(screen.getByTestId('conversion-projection-evidence')).toHaveTextContent(
      'stands for 3 instances',
    );
  });

  it('moves with arrow keys on a roving tabindex and selects with Enter', async () => {
    const { nodes, edges, summary } = defaultFixture();
    renderPanel(paginate(nodes, edges, 10, summary));
    await waitForLoaded();

    const nodesDrawn = graphNodes();
    // Exactly one node is the Tab stop.
    expect(nodesDrawn.filter((n) => n.getAttribute('tabindex') === '0')).toHaveLength(1);

    nodesDrawn[0].focus();
    fireEvent.keyDown(nodesDrawn[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(nodesDrawn[1]);
    fireEvent.keyDown(nodesDrawn[1], { key: 'Enter' });
    expect(screen.getByTestId('conversion-projection-evidence')).toBeInTheDocument();
    // A focused node draws the SVG focus ring.
    expect(screen.getByTestId('conversion-projection-focus-ring')).toBeInTheDocument();
  });

  it('zooms the canvas and resets with Escape', async () => {
    const { nodes, edges, summary } = defaultFixture();
    renderPanel(paginate(nodes, edges, 10, summary));
    await waitForLoaded();

    const svg = screen.getByTestId('conversion-projection-svg');
    const baseWidth = Number(svg.getAttribute('width'));
    fireEvent.click(screen.getByTestId('conversion-projection-zoom-in'));
    expect(Number(svg.getAttribute('width'))).toBeCloseTo(baseWidth * 1.25);

    fireEvent.keyDown(screen.getByTestId('conversion-projection-panel'), { key: 'Escape' });
    expect(Number(svg.getAttribute('width'))).toBeCloseTo(baseWidth);

    fireEvent.click(screen.getByTestId('conversion-projection-zoom-in'));
    fireEvent.click(screen.getByTestId('conversion-projection-reset-view'));
    expect(Number(svg.getAttribute('width'))).toBeCloseTo(baseWidth);
  });
});

// ---------------------------------------------------------------------------
// 4. Mermaid export
// ---------------------------------------------------------------------------

describe('ConversionProjectionGraphPanel — Mermaid export', () => {
  it('copies the sanitized flowchart text', async () => {
    const { nodes, edges, summary } = defaultFixture();
    renderPanel(paginate(nodes, edges, 10, summary));
    await waitForLoaded();

    fireEvent.click(screen.getByTestId('conversion-projection-copy-mermaid'));
    await waitFor(() =>
      expect(screen.getByTestId('conversion-projection-copy-mermaid')).toHaveTextContent('Copied'),
    );
    const writeText = navigator.clipboard.writeText as jest.Mock;
    const text = writeText.mock.calls[0][0] as string;
    expect(text.startsWith('flowchart LR\n')).toBe(true);
    expect(text).toContain('getPet');
    expect(text).toContain('subgraph lane_omitted');
  });
});

// ---------------------------------------------------------------------------
// 5. Bounds — draw budget, aggregation, table windowing
// ---------------------------------------------------------------------------

describe('ConversionProjectionGraphPanel — bounds', () => {
  function manyRetained(count: number) {
    const nodes: ConversionProjectionNode[] = [];
    const edges: ConversionProjectionEdge[] = [];
    for (let i = 0; i < count; i += 1) {
      nodes.push(sourceNode(`source:construct:type:T${i}`, `T${i}`, { kind: 'type' }));
      edges.push(
        edge(`construct:type:type:T${i}`, 'construct', `source:construct:type:T${i}`, null, 'retained'),
      );
    }
    return { nodes, edges };
  }

  it('states drawn-of-total when the draw budget truncates the graph', async () => {
    const { nodes, edges } = manyRetained(4);
    renderPanel(paginate(nodes, edges, 10, summaryFor(edges)), {
      drawBudget: 2,
      aggregationThreshold: 100,
    });
    await waitForLoaded();
    expect(screen.getByTestId('conversion-projection-draw-cap')).toHaveTextContent(
      'Drawing 2 of 4 constructs',
    );
    expect(graphNodes()).toHaveLength(2);
    // The table still lists everything.
    expect(screen.getAllByTestId(/^conversion-projection-table-row-/)).toHaveLength(4);
  });

  it('aggregates clean rows and expands them in place in the table', async () => {
    const { nodes, edges } = manyRetained(4);
    renderPanel(paginate(nodes, edges, 10, summaryFor(edges)), { aggregationThreshold: 2 });
    await waitForLoaded();

    expect(screen.getByTestId('conversion-projection-aggregated-note')).toBeInTheDocument();
    const toggle = screen.getByTestId('conversion-projection-aggregate-toggle-target-retained');
    expect(toggle).toHaveTextContent('4 constructs retained');
    fireEvent.click(toggle);
    expect(screen.getAllByTestId(/^conversion-projection-aggregate-member-/)).toHaveLength(4);
    // Legend still counts every represented row.
    expect(screen.getByTestId('conversion-projection-legend-retained')).toHaveTextContent('4');
  });

  it('windows the table above its budget without losing aria-rowcount', async () => {
    // 12 rows > the 2-visible + 2×4-overscan window for a 72px viewport of 36px rows.
    const { nodes, edges } = manyRetained(12);
    renderPanel(paginate(nodes, edges, 20, summaryFor(edges)), {
      aggregationThreshold: 100,
      tableVirtualizeAbove: 3,
      tableViewportHeight: 72,
    });
    await waitForLoaded();
    expect(screen.getByTestId('conversion-projection-table')).toHaveAttribute('aria-rowcount', '13');
    expect(screen.getByTestId('conversion-projection-table-windowed')).toBeInTheDocument();
    expect(screen.getAllByTestId('conversion-projection-table-spacer').length).toBeGreaterThan(0);
    // Fewer than all rows are mounted.
    expect(
      screen.getAllByTestId(/^conversion-projection-table-row-/).length,
    ).toBeLessThan(12);
  });
});

// ---------------------------------------------------------------------------
// 6. Paging
// ---------------------------------------------------------------------------

describe('ConversionProjectionGraphPanel — paging', () => {
  it('walks every cursor page in one window and reconciles', async () => {
    const { nodes, edges, summary } = defaultFixture();
    const fetchMock = renderPanel(paginate(nodes, edges, 1, summary));
    await waitForLoaded();
    await waitFor(() =>
      expect(screen.getAllByTestId(/^conversion-projection-table-row-/)).toHaveLength(3),
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(screen.queryByTestId('conversion-projection-partial')).not.toBeInTheDocument();
    expect(screen.queryByTestId('conversion-projection-reconciliation')).not.toBeInTheDocument();
  });

  it('pauses after a window, states loaded-of-total, and Load more completes the walk', async () => {
    const count = 7; // 7 pages of 1 edge > the 5-page window.
    const nodes: ConversionProjectionNode[] = [];
    const edges: ConversionProjectionEdge[] = [];
    for (let i = 0; i < count; i += 1) {
      nodes.push(sourceNode(`source:construct:type:T${i}`, `T${i}`, { kind: 'type' }));
      edges.push(
        edge(`construct:type:type:T${i}`, 'construct', `source:construct:type:T${i}`, null, 'retained'),
      );
    }
    renderPanel(paginate(nodes, edges, 1, summaryFor(edges)), { aggregationThreshold: 100 });

    const partial = await screen.findByTestId('conversion-projection-partial');
    expect(partial).toHaveTextContent('Loaded 5 of 7');

    fireEvent.click(screen.getByTestId('conversion-projection-load-more'));
    await waitFor(() =>
      expect(screen.queryByTestId('conversion-projection-partial')).not.toBeInTheDocument(),
    );
    expect(screen.getAllByTestId(/^conversion-projection-table-row-/)).toHaveLength(7);
  });
});

// ---------------------------------------------------------------------------
// 7. Refusals
// ---------------------------------------------------------------------------

describe('ConversionProjectionGraphPanel — refusals', () => {
  it('offers retry on a transport error and recovers', async () => {
    const { nodes, edges, summary } = defaultFixture();
    const pages = paginate(nodes, edges, 10, summary);
    let failFirst = true;
    const fn = jest.fn(async (_url: unknown, init?: { body?: unknown }) => {
      if (failFirst) {
        failFirst = false;
        return {
          ok: false,
          status: 500,
          json: async () => ({ success: false, error: 'kaboom' }),
        };
      }
      const body = JSON.parse((init?.body as string) ?? '{}');
      const key = body.cursor == null ? 'start' : body.cursor;
      return { ok: true, status: 200, json: async () => pages[key] };
    });
    global.fetch = fn as unknown as typeof fetch;

    render(<ConversionProjectionGraphPanel itemId="item-1" enabled />);
    const error = await screen.findByTestId('conversion-projection-error');
    expect(error).toHaveTextContent('kaboom');

    fireEvent.click(screen.getByTestId('conversion-projection-retry'));
    await waitForLoaded();
  });

  it('refuses an incoherent page instead of partially rendering it', async () => {
    const { nodes, edges, summary } = defaultFixture();
    const pages = paginate(nodes, edges, 10, summary) as Record<
      string,
      { page: { nodes: ConversionProjectionNode[] } }
    >;
    pages.start.page.nodes = []; // every edge now references unbundled nodes
    renderPanel(pages as Record<string, unknown>);
    const refusal = await screen.findByTestId('conversion-projection-integrity-error');
    expect(refusal).toHaveTextContent('integrity check');
    expect(screen.queryByTestId('conversion-projection-table')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 8. Sanitization
// ---------------------------------------------------------------------------

describe('ConversionProjectionGraphPanel — sanitization', () => {
  it('renders hostile imported labels as cleaned inert text', async () => {
    const hostile = '‮dropped‬ <script>alert(1)</script>';
    const nodes = [sourceNode('source:loss:0', hostile, { kind: 'loss' })];
    const edges = [edge('loss:0000:x', 'loss', 'source:loss:0', null, 'dropped')];
    renderPanel(paginate(nodes, edges, 10, summaryFor(edges)));
    await waitForLoaded();

    // No live script element anywhere; the label text is control/bidi-free.
    expect(document.querySelector('script')).toBeNull();
    const node = screen.getByTestId('conversion-projection-node-loss:0000:x');
    const aria = node.getAttribute('aria-label') ?? '';
    expect(aria).not.toMatch(/[‮‬]/);
    expect(aria).toContain('<script>');
  });
});
