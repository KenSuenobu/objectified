/**
 * Import preview step at scale (IXH-3.6, #5108).
 *
 * The IXH-1.5 scale corpus (real multi-thousand-entity documents) is the acceptance
 * material for "interaction stays responsive"; until it lands (#5091), this suite pins
 * the same guarantees against synthetic corpora of that size, deterministically:
 *
 *  1. **Bounded DOM** — with thousands of rows, every preview surface mounts only a
 *     bounded window (tree, findings, projection table, delta lists) or a bounded
 *     worst-first subset (projection SVG), and states so visibly.
 *  2. **Focus survives windowing** — the focused row is pinned when scrolled out, and
 *     End/Home jumps land focus on a mounted row.
 *  3. **Soft time budgets** — the pure view builders stay under a generous CI budget over
 *     scale-sized input (the EFP-3.2 `BUILD_PROJECTION_VIEW_SOFT_BUDGET_MS` precedent),
 *     so a quadratic regression fails loudly rather than shipping as jank.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { describe, expect, it, jest, afterEach } from '@jest/globals';

import { CatalogImportPreviewPanel } from '../src/app/components/ade/dashboard/catalog/CatalogImportPreviewPanel';
import { CatalogImportProjectionGraph } from '../src/app/components/ade/dashboard/catalog/CatalogImportProjectionGraph';
import { CatalogImportReimportDelta } from '../src/app/components/ade/dashboard/catalog/CatalogImportReimportDelta';
import {
  buildImportEvidenceRows,
  buildImportProjectionView,
  projectionGraphLayout,
  selectDrawnGraphEntries,
  IMPORT_FAMILY_LANES,
} from '../src/app/components/ade/dashboard/catalog/importProjectionGraph';
import { BUILD_PROJECTION_VIEW_SOFT_BUDGET_MS } from '../src/app/components/ade/dashboard/export/projectionGraph';
import { GRAPH_DRAW_BUDGET } from '../src/app/utils/preview-budgets';
import {
  buildPreviewTreeRows,
  defaultExpandedKeys,
  groupReimportEntries,
  type ImportPreviewEntity,
  type ImportPreviewManifest,
  type ImportReimportDelta,
} from '../src/app/utils/import-preview-manifest';
import type { PreflightReport } from '../src/app/utils/import-preflight';
import type {
  ProjectionEdge,
  ProjectionNode,
} from '../src/app/components/ade/dashboard/export/projectionEvidence';

/** Scale sizes — the IXH-1.5 order of magnitude, kept jsdom-friendly. */
const SCALE_ENTITIES = 6000;
const SCALE_GRAPH_ROWS = 2000;
const SCALE_DELTA_ENTRIES = 3000;

function entity(overrides: Partial<ImportPreviewEntity> & { key: string }): ImportPreviewEntity {
  return {
    name: overrides.key,
    entity_kind: 'type',
    parent_key: null,
    order: 0,
    deprecated: false,
    coverage: 'mapped',
    unmodeled_extras: [],
    ...overrides,
  };
}

function scaleEntities(count: number): ImportPreviewEntity[] {
  return Array.from({ length: count }, (_, i) =>
    entity({ key: `type:T${String(i).padStart(5, '0')}`, name: `Type${i}`, order: i }),
  );
}

function buildManifest(entities: ImportPreviewEntity[]): ImportPreviewManifest {
  return {
    manifest_hash: 'mh-scale',
    adapter: {
      adapter_key: 'graphql',
      adapter_label: 'GraphQL SDL',
      paradigm: 'graphql',
      formats: ['graphql'],
      capability: { format: 'graphql', mode: 'native', importable: true, related_issues: [] },
      parser_limits: [],
    },
    counts: { services: 0, operations: 0, channels: 0, types: entities.length },
    coverage_counts: {},
    status_counts: {},
    reason_counts: {},
    entities,
    total_entities: entities.length,
    nodes: [],
    edges: [],
    coverage: [],
    total_coverage_entries: 0,
    page_size: 1000,
    next_cursor: null,
    truncated: false,
  };
}

const PREFLIGHT: PreflightReport = {
  ok: true,
  detection: { adapter_key: 'graphql', matched: true, importable: true },
  format: 'graphql',
  paradigm: 'graphql',
  routing: { target: 'catalog' },
  counts: { services: 0, operations: 0, channels: 0, types: SCALE_ENTITIES },
  lint: { score: 90, grade: 'A' },
  policy: { verdict: 'pass', blocking: false, source: 'default', reason: 'Advisory.' },
};

/** Serve the scale manifest from the mocked endpoint. */
function mockManifest(entities: ImportPreviewEntity[]): void {
  global.fetch = jest.fn(() =>
    Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          success: true,
          ok: true,
          preflight: PREFLIGHT,
          reimport: null,
          manifest: buildManifest(entities),
        }),
    }),
  ) as unknown as typeof fetch;
}

/** N dropped constructs — dropped never aggregates, the worst case for graph size. */
function droppedGraph(count: number): { nodes: ProjectionNode[]; edges: ProjectionEdge[] } {
  const nodes: ProjectionNode[] = [];
  const edges: ProjectionEdge[] = [];
  for (let i = 0; i < count; i++) {
    const key = `type:T${String(i).padStart(5, '0')}`;
    nodes.push(
      {
        id: `native:${key}`,
        kind: 'native',
        label: `Native${i}`,
        construct_key: key,
        native: { native_id: key, native_name: `Native${i}`, source_location: `${i + 1}:1` },
      },
      { id: `canonical:${key}`, kind: 'canonical', label: key, construct_key: key, canonical_kind: 'type' },
    );
    edges.push({
      id: `projects:${key}`,
      relation: 'projects',
      source: `native:${key}`,
      target: `canonical:${key}`,
      status: 'dropped',
      reason: 'destination_unsupported',
      severity: 'info',
      detail: `dropped detail ${i}`,
    });
  }
  return { nodes, edges };
}

function buildDelta(count: number): ImportReimportDelta {
  return {
    target_item_id: 'item-1',
    target_item_name: 'Pets API',
    target_item_slug: 'pets-api',
    current_version_record_id: 'v-1',
    noop: false,
    candidate_fingerprint: 'cand',
    current_fingerprint: 'cur',
    entries: Array.from({ length: count }, (_, i) => ({
      entity: 'operation',
      key: `op:changed-${String(i).padStart(5, '0')}`,
      change: 'changed' as const,
      severity: 'dangerous' as const,
      rationale: `changed ${i}`,
    })),
    counts: { added: 0, removed: 0, changed: count },
    counts_by_entity: {},
    classifier: 'structural-baseline',
    classifier_format_pack: false,
    overall_severity: 'dangerous',
    severity_counts: { safe: 0, dangerous: count, breaking: 0 },
  };
}

afterEach(() => jest.restoreAllMocks());

describe('entity tree at scale', () => {
  it(`mounts a bounded window of a ${SCALE_ENTITIES}-entity manifest`, async () => {
    mockManifest(scaleEntities(SCALE_ENTITIES));
    render(
      <CatalogImportPreviewPanel
        request={{ document_base64: 'abc', import_target: 'catalog' }}
        rawSourceAvailable={false}
        rawLineCount={0}
        onSelectSourceLine={jest.fn() as unknown as (line: number) => void}
        viewportHeight={320}
      />,
    );
    await waitFor(() =>
      expect(screen.queryByTestId('import-preview-loading')).not.toBeInTheDocument(),
    );
    // 6001 rows exist (section + entities); only the window (~10 visible + overscan) mounts.
    const mounted = screen.getAllByRole('treeitem').length;
    expect(mounted).toBeLessThanOrEqual(40);
    expect(screen.getByText('windowed')).toBeInTheDocument();
  });

  it('keeps keyboard End reachable: the last row mounts, focuses, and is selected', async () => {
    mockManifest(scaleEntities(SCALE_ENTITIES));
    render(
      <CatalogImportPreviewPanel
        request={{ document_base64: 'abc', import_target: 'catalog' }}
        rawSourceAvailable={false}
        rawLineCount={0}
        onSelectSourceLine={jest.fn() as unknown as (line: number) => void}
        viewportHeight={320}
      />,
    );
    await waitFor(() =>
      expect(screen.queryByTestId('import-preview-loading')).not.toBeInTheDocument(),
    );
    const tree = screen.getByRole('tree', { name: /entities this import would add/i });
    fireEvent.keyDown(tree.parentElement as HTMLElement, { key: 'End' });
    await waitFor(() => {
      const last = screen.getByRole('treeitem', { name: new RegExp(`Type${SCALE_ENTITIES - 1}\\b`) });
      expect(last).toHaveAttribute('aria-selected', 'true');
    });
  });
});

describe('projection map at scale', () => {
  function renderScaledGraph() {
    const graph = droppedGraph(SCALE_GRAPH_ROWS);
    render(
      <CatalogImportProjectionGraph
        nodes={graph.nodes}
        edges={graph.edges}
        coverage={[]}
        capability={{ format: 'graphql', mode: 'native', importable: true, related_issues: [] }}
        rawSourceAvailable={false}
        rawLineCount={0}
        onSelectSourceLine={jest.fn() as unknown as (line: number) => void}
        tableViewportHeight={180}
      />,
    );
  }

  it(`draws at most the budget (${GRAPH_DRAW_BUDGET}) of ${SCALE_GRAPH_ROWS} dropped constructs and states the cap`, () => {
    renderScaledGraph();
    const drawn = document.querySelectorAll('[data-testid^="import-projection-node-"]').length;
    expect(drawn).toBe(GRAPH_DRAW_BUDGET);
    expect(screen.getByTestId('import-projection-draw-cap')).toHaveTextContent(
      new RegExp(`${GRAPH_DRAW_BUDGET}.* of .*${SCALE_GRAPH_ROWS.toLocaleString()}`),
    );
    expect(screen.getByTestId('import-projection-draw-cap')).toHaveTextContent(/table below/i);
  });

  it('windows the evidence table with a truthful aria-rowcount', () => {
    renderScaledGraph();
    const table = screen.getByTestId('import-projection-table');
    expect(table).toHaveAttribute('aria-rowcount', String(SCALE_GRAPH_ROWS + 1));
    // Only the window mounts (~5 visible + overscan + spacers), not 2000 rows.
    const bodyRows = table.querySelectorAll('tbody tr').length;
    expect(bodyRows).toBeLessThanOrEqual(30);
    expect(screen.getByTestId('import-projection-table-windowed')).toHaveTextContent(
      /reachable by scrolling/i,
    );
  });

  it('pins the focused table row when it scrolls out of the window', () => {
    renderScaledGraph();
    const viewport = screen.getByTestId('import-projection-table-viewport');
    const firstRowButton = screen
      .getByTestId('import-projection-table-row-projects:type:T00000')
      .querySelector('button') as HTMLButtonElement;
    fireEvent.focus(firstRowButton);
    // Scroll far past the first row's window; the focused row must stay mounted.
    fireEvent.scroll(viewport, { target: { scrollTop: 1000 * 36 } });
    expect(
      screen.getByTestId('import-projection-table-row-projects:type:T00000'),
    ).toBeInTheDocument();
    // And its aria-rowindex still tells the truth about its position.
    expect(screen.getByTestId('import-projection-table-row-projects:type:T00000')).toHaveAttribute(
      'aria-rowindex',
      '2',
    );
  });
});

describe('re-import delta at scale', () => {
  it(`mounts a bounded window of a ${SCALE_DELTA_ENTRIES}-entry family and pins focus`, () => {
    render(
      <CatalogImportReimportDelta
        delta={buildDelta(SCALE_DELTA_ENTRIES)}
        onRevealEntity={jest.fn() as unknown as (key: string) => void}
        listViewportHeight={140}
      />,
    );
    expect(screen.getByTestId('import-reimport-windowed')).toBeInTheDocument();
    const mounted = screen.getAllByTestId('import-reimport-entry').length;
    expect(mounted).toBeLessThanOrEqual(30);
    // The header chips still state the full count — windowing never misstates totals.
    expect(screen.getByTestId('import-reimport-counts')).toHaveTextContent(
      String(SCALE_DELTA_ENTRIES),
    );

    // Focus the first row's reveal button, scroll far away: the row stays mounted (pinned).
    const firstReveal = screen.getAllByTestId('import-reimport-reveal')[0];
    fireEvent.focus(firstReveal);
    const viewport = screen.getByTestId('import-reimport-entries-operation');
    fireEvent.scroll(viewport, { target: { scrollTop: 2000 * 28 } });
    expect(screen.getByText('op:changed-00000')).toBeInTheDocument();
  });
});

describe('pure builders — soft time budgets (EFP-3.2 precedent)', () => {
  it(`flattens ${SCALE_ENTITIES * 2} entities into tree rows within the soft budget`, () => {
    const entities = scaleEntities(SCALE_ENTITIES * 2);
    const started = performance.now();
    const rows = buildPreviewTreeRows(
      entities,
      { services: 0, operations: 0, channels: 0, types: entities.length },
      defaultExpandedKeys(),
      '',
    );
    const elapsed = performance.now() - started;
    expect(rows.length).toBe(entities.length + 1);
    expect(elapsed).toBeLessThan(BUILD_PROJECTION_VIEW_SOFT_BUDGET_MS);
  });

  it(`builds evidence, view, selection, and layout for ${SCALE_GRAPH_ROWS} rows within the soft budget`, () => {
    const graph = droppedGraph(SCALE_GRAPH_ROWS);
    const started = performance.now();
    const rows = buildImportEvidenceRows(graph.nodes, graph.edges, []);
    const view = buildImportProjectionView(rows);
    const selection = selectDrawnGraphEntries(view.entries, GRAPH_DRAW_BUDGET);
    projectionGraphLayout(selection.drawn, IMPORT_FAMILY_LANES);
    const elapsed = performance.now() - started;
    expect(rows).toHaveLength(SCALE_GRAPH_ROWS);
    expect(selection.drawn).toHaveLength(GRAPH_DRAW_BUDGET);
    expect(elapsed).toBeLessThan(BUILD_PROJECTION_VIEW_SOFT_BUDGET_MS);
  });

  it(`groups ${SCALE_DELTA_ENTRIES * 2} delta entries within the soft budget`, () => {
    const delta = buildDelta(SCALE_DELTA_ENTRIES * 2);
    const started = performance.now();
    const groups = groupReimportEntries(delta);
    const elapsed = performance.now() - started;
    expect(groups[0].entries).toHaveLength(SCALE_DELTA_ENTRIES * 2);
    expect(elapsed).toBeLessThan(BUILD_PROJECTION_VIEW_SOFT_BUDGET_MS);
  });
});
