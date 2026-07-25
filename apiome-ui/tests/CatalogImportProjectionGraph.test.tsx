/**
 * CatalogImportProjectionGraph — the import projection map (IXH-3.3, #5105).
 *
 * Covers the acceptance criteria on the component:
 *  1. **Status legibility** — every present status renders text + symbol (+ count); colour
 *     is never the only channel.
 *  2. **Evidence on selection** — reason code, source location (linked into the raw
 *     viewer), capability reference, and remediation.
 *  3. **Text alternative** — the table conveys the same content (same counts, same aria
 *     labels) and its caption is the graph's accessible name (`aria-labelledby`).
 *  4. **Bounded rendering** — large clean families aggregate with an explicit in-table
 *     expansion path; dropped evidence never aggregates.
 *  5. Keyboard: roving tabindex over graph nodes; hostile labels render sanitized.
 */

import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { describe, expect, it, jest } from '@jest/globals';

import { CatalogImportProjectionGraph } from '../src/app/components/ade/dashboard/catalog/CatalogImportProjectionGraph';
import type {
  ProjectionEdge,
  ProjectionNode,
} from '../src/app/components/ade/dashboard/export/projectionEvidence';
import type {
  ImportCapabilityReference,
  ImportPreviewCoverageEntry,
} from '../src/app/utils/import-preview-manifest';

const CAPABILITY: ImportCapabilityReference = {
  format: 'graphql',
  mode: 'native',
  importable: true,
  related_issues: ['CLX-77'],
  notes: 'Directive parsing is tracked.',
};

function entityGraph(
  key: string,
  name: string,
  kind: string,
  options: { status?: ProjectionEdge['status']; reason?: string | null; location?: string | null } = {},
): { nodes: ProjectionNode[]; edges: ProjectionEdge[] } {
  const status = options.status ?? 'retained';
  return {
    nodes: [
      {
        id: `native:${key}`,
        kind: 'native',
        label: name,
        construct_key: key,
        native: { native_id: `id-${key}`, native_name: name, source_location: options.location ?? null },
      },
      { id: `canonical:${key}`, kind: 'canonical', label: key, construct_key: key, canonical_kind: kind },
    ],
    edges: [
      {
        id: `derives:${key}`,
        relation: 'derives',
        source: `native:${key}`,
        target: `canonical:${key}`,
        status: 'retained',
        severity: 'info',
        detail: 'normalized',
      },
      {
        id: `projects:${key}#0`,
        relation: 'projects',
        source: `native:${key}`,
        target: `canonical:${key}`,
        status,
        reason: options.reason ?? (status === 'retained' ? null : 'destination_unsupported'),
        severity: 'info',
        detail: `${status} detail for ${key}`,
      },
    ],
  };
}

const PARSER_LIMIT: ImportPreviewCoverageEntry = {
  source_construct: 'graphql-directives',
  coverage: 'not-parsed-by-adapter',
  status: 'dropped',
  reason: 'source_parse_limit',
  detail: 'Custom directives are not read.',
  entity_key: null,
  document_scoped: false,
  capability_reference: CAPABILITY,
};

/** Default fixture: a located service (retained), a partially-mapped type, a parser limit. */
function fixture() {
  const service = entityGraph('svc:pets', 'PetService', 'service', { location: '3:1' });
  const type = entityGraph('type:Pet', 'PetV2', 'type', {
    status: 'approximated',
    reason: 'destination_unsupported',
  });
  return {
    nodes: [...service.nodes, ...type.nodes],
    edges: [...service.edges, ...type.edges],
    coverage: [
      {
        source_construct: 'type:Pet',
        coverage: 'partially-mapped',
        status: 'approximated',
        reason: 'destination_unsupported',
        detail: 'x-internal rides in extras',
        entity_key: 'type:Pet',
        document_scoped: true,
      } satisfies ImportPreviewCoverageEntry,
      PARSER_LIMIT,
    ],
  };
}

function renderGraph(
  props: Partial<React.ComponentProps<typeof CatalogImportProjectionGraph>> = {},
): jest.Mock {
  const onSelectSourceLine = jest.fn();
  const data = fixture();
  render(
    <CatalogImportProjectionGraph
      nodes={data.nodes}
      edges={data.edges}
      coverage={data.coverage}
      capability={CAPABILITY}
      rawSourceAvailable
      rawLineCount={600}
      onSelectSourceLine={onSelectSourceLine as unknown as (line: number) => void}
      {...props}
    />,
  );
  return onSelectSourceLine;
}

const graphNodes = () =>
  screen.getAllByTestId(/^import-projection-node-/) as unknown as HTMLElement[];

describe('CatalogImportProjectionGraph — status legibility', () => {
  it('legends every present status as text + symbol + count, never colour alone', () => {
    renderGraph();
    const legend = screen.getByTestId('import-projection-legend');
    expect(legend).toHaveTextContent('Retained');
    expect(legend).toHaveTextContent('✓');
    expect(legend).toHaveTextContent('Approximated');
    expect(legend).toHaveTextContent('≈');
    expect(legend).toHaveTextContent('Dropped');
    expect(legend).toHaveTextContent('×');
  });

  it('stamps each graph node with its status for the pattern/high-contrast CSS hooks', () => {
    renderGraph();
    const statuses = graphNodes().map((node) => node.getAttribute('data-status'));
    expect(statuses).toEqual(expect.arrayContaining(['retained', 'approximated', 'dropped']));
  });
});

describe('CatalogImportProjectionGraph — graph/table parity and accessible naming', () => {
  it('names the graph by the table caption (aria-labelledby)', () => {
    renderGraph();
    const svg = screen.getByTestId('import-projection-svg');
    const labelledBy = svg.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    const caption = document.getElementById(labelledBy as string);
    expect(caption?.tagName.toLowerCase()).toBe('caption');
    expect(caption).toHaveTextContent('accessible equivalent');
    expect(screen.getByTestId('import-projection-table')).toContainElement(caption as HTMLElement);
  });

  it('gives every graph node a table counterpart with the identical accessible name', () => {
    renderGraph();
    const nodes = graphNodes();
    const table = screen.getByTestId('import-projection-table');
    for (const node of nodes) {
      const aria = node.getAttribute('aria-label') as string;
      expect(within(table).getByRole('button', { name: aria })).toBeInTheDocument();
    }
    // Same cardinality: one table row per graph node.
    expect(table.querySelectorAll('tbody tr')).toHaveLength(nodes.length);
  });
});

describe('CatalogImportProjectionGraph — selection opens evidence', () => {
  it('shows reason code, detail, coverage badge, and remediation for a lossy node', () => {
    renderGraph();
    fireEvent.click(screen.getByTestId('import-projection-node-projects:type:Pet#0'));
    const evidence = screen.getByTestId('import-projection-evidence');
    expect(within(evidence).getByTestId('import-projection-reason')).toHaveTextContent(
      'destination_unsupported',
    );
    expect(evidence).toHaveTextContent('approximated detail for type:Pet');
    expect(evidence).toHaveTextContent('Partially mapped');
    expect(screen.getByTestId('import-projection-remediation')).toHaveTextContent('extras bag');
  });

  it('links the source location into the raw viewer', () => {
    const onSelectSourceLine = renderGraph();
    fireEvent.click(screen.getByTestId('import-projection-node-projects:svc:pets#0'));
    const link = screen.getByTestId('import-projection-source-link');
    expect(link).toHaveTextContent('3:1');
    fireEvent.click(link);
    expect(onSelectSourceLine).toHaveBeenCalledWith(3);
  });

  it('offers no source link when the raw source cannot show the location', () => {
    renderGraph({ rawSourceAvailable: false });
    fireEvent.click(screen.getByTestId('import-projection-node-projects:svc:pets#0'));
    expect(screen.queryByTestId('import-projection-source-link')).not.toBeInTheDocument();
    // The location is still stated as text.
    expect(screen.getByTestId('import-projection-evidence')).toHaveTextContent('Source line 3:1');
  });

  it('shows the capability reference for an adapter-declared limit', () => {
    renderGraph();
    fireEvent.click(screen.getByTestId('import-projection-node-ledger:graphql-directives'));
    const capability = screen.getByTestId('import-projection-capability');
    expect(capability).toHaveTextContent('graphql');
    expect(capability).toHaveTextContent('native');
    expect(capability).toHaveTextContent('importable');
    expect(capability).toHaveTextContent('CLX-77');
    expect(capability).toHaveTextContent('Directive parsing is tracked.');
    expect(screen.getByTestId('import-projection-remediation')).toHaveTextContent(
      'declared adapter limit',
    );
  });

  it('selects from the table too — the text alternative is interactive-equal', () => {
    renderGraph();
    const table = screen.getByTestId('import-projection-table');
    const svcNode = screen.getByTestId('import-projection-node-projects:svc:pets#0');
    fireEvent.click(
      within(table).getByRole('button', { name: svcNode.getAttribute('aria-label') as string }),
    );
    expect(screen.getByTestId('import-projection-evidence')).toHaveTextContent('svc:pets');
    expect(svcNode).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('CatalogImportProjectionGraph — keyboard', () => {
  it('roves a single tabindex over the graph nodes and selects with Enter', () => {
    renderGraph();
    const nodes = graphNodes();
    const tabStops = () => graphNodes().filter((node) => node.getAttribute('tabindex') === '0');
    expect(tabStops()).toHaveLength(1);

    fireEvent.keyDown(nodes[0], { key: 'ArrowDown' });
    expect(tabStops()).toHaveLength(1);
    expect(tabStops()[0]).toBe(graphNodes()[1]);

    fireEvent.keyDown(graphNodes()[1], { key: 'Enter' });
    expect(screen.getByTestId('import-projection-evidence')).toBeInTheDocument();

    fireEvent.keyDown(graphNodes()[1], { key: 'Home' });
    expect(tabStops()[0]).toBe(graphNodes()[0]);
  });
});

describe('CatalogImportProjectionGraph — bounded rendering', () => {
  function manyTypes(n: number) {
    const nodes: ProjectionNode[] = [];
    const edges: ProjectionEdge[] = [];
    for (let i = 0; i < n; i += 1) {
      const g = entityGraph(`type:T${String(i).padStart(3, '0')}`, `T${i}`, 'type');
      nodes.push(...g.nodes);
      edges.push(...g.edges);
    }
    return { nodes, edges };
  }

  it('aggregates a large clean family, expandable in the table, dropped rows untouched', () => {
    const { nodes, edges } = manyTypes(12);
    render(
      <CatalogImportProjectionGraph
        nodes={nodes}
        edges={edges}
        coverage={[PARSER_LIMIT]}
        capability={CAPABILITY}
        rawSourceAvailable
        rawLineCount={100}
        onSelectSourceLine={jest.fn() as unknown as (line: number) => void}
        aggregationThreshold={4}
      />,
    );
    expect(screen.getByTestId('import-projection-aggregated-note')).toBeInTheDocument();

    // One aggregate node stands in for the twelve clean types; the dropped limit stays.
    expect(graphNodes()).toHaveLength(2);
    const toggle = screen.getByTestId('import-projection-aggregate-toggle-types-retained');
    expect(toggle).toHaveTextContent('12 constructs retained in Types (aggregated)');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByTestId(/^import-projection-aggregate-member-/)).toHaveLength(12);
    expect(
      screen.getByTestId('import-projection-aggregate-member-projects:type:T000#0'),
    ).toHaveTextContent('type:T000');
  });
});

describe('CatalogImportProjectionGraph — hostile input and empty state', () => {
  it('renders hostile labels sanitized (no bidi/control characters survive)', () => {
    const hostile = entityGraph('type:Evil', 'Evil‮<script>alert(1)</script>', 'type');
    render(
      <CatalogImportProjectionGraph
        nodes={hostile.nodes}
        edges={hostile.edges}
        coverage={[]}
        capability={CAPABILITY}
        rawSourceAvailable
        rawLineCount={100}
        onSelectSourceLine={jest.fn() as unknown as (line: number) => void}
      />,
    );
    const table = screen.getByTestId('import-projection-table');
    expect(table.textContent).not.toContain('‮');
    // The markup survives only as inert text — React text nodes, nothing executed.
    expect(table.textContent).toContain('<script>alert(1)</script>');
    expect(document.querySelector('script')).toBeNull();
  });

  it('states plainly when the manifest carried no projection evidence', () => {
    render(
      <CatalogImportProjectionGraph
        nodes={[]}
        edges={[]}
        coverage={[]}
        capability={CAPABILITY}
        rawSourceAvailable
        rawLineCount={0}
        onSelectSourceLine={jest.fn() as unknown as (line: number) => void}
      />,
    );
    expect(screen.getByTestId('import-projection-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('import-projection-svg')).not.toBeInTheDocument();
  });
});
