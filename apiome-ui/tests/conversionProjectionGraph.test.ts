/**
 * Conversion projection view model (CPDO-3.1, #4801).
 *
 * Covers the pure module behind the conversion preview's projection graph:
 *  1. **Shared primitives, not duplicates** — the module's layout/counters/sanitizer are
 *     the export projection map's own objects (the "third view, not third implementation"
 *     rule the import map already follows).
 *  2. The status vocabulary bridge: `inferred` rides on `synthesized` for the shared
 *     machinery but presents as `Inferred` everywhere user-facing.
 *  3. Conversion evidence rows: every scope joins, native provenance and landing pointers
 *     resolve, hostile labels sanitize, and input permutations yield identical rows.
 *  4. Outcome lanes: in-document / omitted / unavailable.
 *  5. Aggregation via the shared builder: clean rows collapse, dropped/inferred never do.
 *  6. Count reconciliation against the manifest summary's own tallies.
 *  7. Mermaid text export: sanitized, entity-escaped, deterministic, markup-inert.
 */

import { describe, expect, it } from '@jest/globals';

import * as conversionMod from '../src/app/components/ade/dashboard/catalog/conversionProjectionGraph';
import * as exportMod from '../src/app/components/ade/dashboard/export/projectionGraph';
import {
  buildConversionProjectionRows,
  buildConversionProjectionView,
  CONVERSION_LANES,
  conversionEntryAriaLabel,
  conversionLaneForStatus,
  conversionProjectionMermaid,
  conversionStatusPresentation,
  conversionViewStatusCounts,
  mermaidLabel,
  reconcileConversionCounts,
  sharedStatusFor,
} from '../src/app/components/ade/dashboard/catalog/conversionProjectionGraph';
import type {
  ConversionManifestSummary,
  ConversionProjectionEdge,
  ConversionProjectionNode,
  ConversionProjectionStatus,
} from '../src/app/utils/conversion-projection';

// ---------------------------------------------------------------------------
// Fixtures — mirror the REST builder's shapes (conversion_projection.py)
// ---------------------------------------------------------------------------

function sourceNode(
  id: string,
  label: string,
  options: {
    constructKey?: string | null;
    nativeName?: string | null;
    location?: string | null;
    kind?: string | null;
  } = {},
): ConversionProjectionNode {
  return {
    id,
    kind: 'source',
    label,
    construct_key: options.constructKey ?? null,
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
    remediation: status === 'retained' ? null : 'Remediate by adjusting the source.',
    evidence: [],
    count: 1,
    ...overrides,
  };
}

/** Default fixture: one retained construct, one dropped loss, one inferred checklist row. */
function fixture(): { nodes: ConversionProjectionNode[]; edges: ConversionProjectionEdge[] } {
  return {
    nodes: [
      sourceNode('source:construct:operation:getPet', 'getPet', {
        constructKey: 'operation:getPet',
        nativeName: 'GET /pets/{id}',
        location: '12',
        kind: 'operation',
      }),
      targetNode('target:/paths/~1pets~1{id}/get', '/paths/~1pets~1{id}/get'),
      sourceNode('source:loss:0', 'graphql-subscription', { kind: 'loss' }),
      sourceNode('source:checklist:info', 'Info block', { kind: 'checklist' }),
      targetNode('target:/info', '/info'),
    ],
    edges: [
      edge(
        'construct:operation:operation:getPet',
        'construct',
        'source:construct:operation:getPet',
        'target:/paths/~1pets~1{id}/get',
        'retained',
      ),
      edge('loss:0000:graphql-subscription', 'loss', 'source:loss:0', null, 'dropped', {
        severity: 'warn',
        reason: 'destination_unsupported',
      }),
      edge('checklist:info', 'checklist', 'source:checklist:info', 'target:/info', 'inferred', {
        reason: 'source_incomplete',
        count: 3,
      }),
    ],
  };
}

// ---------------------------------------------------------------------------
// 1. Shared primitives are the export module's own objects
// ---------------------------------------------------------------------------

describe('conversionProjectionGraph — shared primitives', () => {
  it('re-exports the export projection map primitives, not copies', () => {
    expect(conversionMod.projectionGraphLayout).toBe(exportMod.projectionGraphLayout);
    expect(conversionMod.sanitizeProjectionLabel).toBe(exportMod.sanitizeProjectionLabel);
    expect(conversionMod.statusPresentation).toBe(exportMod.statusPresentation);
    expect(conversionMod.viewStatusCounts).toBe(exportMod.viewStatusCounts);
    expect(conversionMod.selectDrawnGraphEntries).toBe(exportMod.selectDrawnGraphEntries);
    expect(conversionMod.buildProjectionTableRows).toBe(exportMod.buildProjectionTableRows);
  });
});

// ---------------------------------------------------------------------------
// 2. Status vocabulary bridge
// ---------------------------------------------------------------------------

describe('conversionProjectionGraph — status bridge', () => {
  it('maps inferred onto synthesized and keeps every shared status as itself', () => {
    expect(sharedStatusFor('inferred')).toBe('synthesized');
    for (const status of ['retained', 'transformed', 'dropped', 'unavailable', 'not-applicable'] as const) {
      expect(sharedStatusFor(status)).toBe(status);
    }
  });

  it('presents inferred with its own label/symbol on the synthesized palette', () => {
    const inferred = conversionStatusPresentation('inferred');
    const synthesized = exportMod.statusPresentation('synthesized');
    expect(inferred.label).toBe('Inferred');
    expect(inferred.symbol).toBe('∴');
    expect(inferred.badgeClass).toBe(synthesized.badgeClass);
    expect(inferred.strokeClass).toBe(synthesized.strokeClass);
    expect(inferred.dashArray).toBe(synthesized.dashArray);
  });

  it('delegates shared statuses to the shared presentation', () => {
    expect(conversionStatusPresentation('retained')).toBe(exportMod.statusPresentation('retained'));
    expect(conversionStatusPresentation('dropped')).toBe(exportMod.statusPresentation('dropped'));
  });
});

// ---------------------------------------------------------------------------
// 3. Evidence rows
// ---------------------------------------------------------------------------

describe('buildConversionProjectionRows', () => {
  it('joins every scope into rows with provenance and landing pointers', () => {
    const { nodes, edges } = fixture();
    const rows = buildConversionProjectionRows(nodes, edges);
    expect(rows).toHaveLength(3);

    const construct = rows.find((row) => row.scope === 'construct');
    expect(construct?.construct).toBe('getPet');
    expect(construct?.conversionStatus).toBe('retained');
    expect(construct?.sourceLabel).toBe('GET /pets/{id}');
    expect(construct?.sourceLocation).toBe('12');
    expect(construct?.targetLocation).toBe('/paths/~1pets~1{id}/get');
    expect(construct?.remediation).toBeNull();

    const loss = rows.find((row) => row.scope === 'loss');
    expect(loss?.conversionStatus).toBe('dropped');
    expect(loss?.status).toBe('dropped');
    expect(loss?.targetLocation).toBeNull();
    expect(loss?.remediation).toBe('Remediate by adjusting the source.');

    const checklist = rows.find((row) => row.scope === 'checklist');
    expect(checklist?.conversionStatus).toBe('inferred');
    // The shared machinery sees the mapped status; the wire status stays user-facing.
    expect(checklist?.status).toBe('synthesized');
    expect(checklist?.edgeCount).toBe(3);
  });

  it('sanitizes hostile labels: control/bidi stripped, markup left inert text', () => {
    const nodes = [
      sourceNode('source:loss:0', '‮dropped‬ <script>alert(1)</script> !'),
    ];
    const edges = [edge('loss:0000:x', 'loss', 'source:loss:0', null, 'dropped')];
    const [row] = buildConversionProjectionRows(nodes, edges);
    expect(row.construct).not.toMatch(/[\u202e\u202c]/);
    // Markup characters survive as text (the row renders as React text nodes only).
    expect(row.construct).toContain('<script>');
  });

  it('is deterministic across input permutations', () => {
    const { nodes, edges } = fixture();
    const forward = buildConversionProjectionRows(nodes, edges);
    const reversed = buildConversionProjectionRows([...nodes].reverse(), [...edges].reverse());
    expect(reversed).toEqual(forward);
  });

  it('skips an edge whose source node is missing (page issues catch this upstream)', () => {
    const { edges } = fixture();
    expect(buildConversionProjectionRows([], edges)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4/5. Lanes + aggregation
// ---------------------------------------------------------------------------

describe('conversion lanes and aggregation', () => {
  it('lanes statuses by OpenAPI outcome', () => {
    expect(conversionLaneForStatus('retained')).toBe('target');
    expect(conversionLaneForStatus('transformed')).toBe('target');
    expect(conversionLaneForStatus('inferred')).toBe('target');
    expect(conversionLaneForStatus('dropped')).toBe('omitted');
    expect(conversionLaneForStatus('unavailable')).toBe('unavailable');
    expect(conversionLaneForStatus('not-applicable')).toBe('unavailable');
  });

  it('aggregates clean rows above the threshold but never dropped or inferred rows', () => {
    const nodes: ConversionProjectionNode[] = [];
    const edges: ConversionProjectionEdge[] = [];
    for (let i = 0; i < 6; i += 1) {
      nodes.push(sourceNode(`source:construct:type:T${i}`, `T${i}`));
      edges.push(
        edge(`construct:type:type:T${i}`, 'construct', `source:construct:type:T${i}`, null, 'retained', {
          reason: null,
        }),
      );
    }
    nodes.push(sourceNode('source:loss:0', 'lost'));
    edges.push(edge('loss:0000:lost', 'loss', 'source:loss:0', null, 'dropped'));
    nodes.push(sourceNode('source:checklist:info', 'Info'));
    edges.push(
      edge('checklist:info', 'checklist', 'source:checklist:info', null, 'inferred', {
        reason: 'source_incomplete',
      }),
    );

    const view = buildConversionProjectionView(buildConversionProjectionRows(nodes, edges), 3);
    const aggregates = view.entries.filter((entry) => entry.kind === 'aggregate');
    expect(aggregates).toHaveLength(1);
    expect(aggregates[0].status).toBe('retained');
    expect(aggregates[0].members).toHaveLength(6);
    // Dropped and inferred stay individual.
    const individualStatuses = view.entries
      .filter((entry) => entry.kind === 'row')
      .map((entry) => (entry.row as conversionMod.ConversionProjectionRow).conversionStatus);
    expect(individualStatuses).toContain('dropped');
    expect(individualStatuses).toContain('inferred');
  });

  it('counts represented rows per wire status, aggregate members included', () => {
    const { nodes, edges } = fixture();
    const view = buildConversionProjectionView(buildConversionProjectionRows(nodes, edges), 1);
    const counts = conversionViewStatusCounts(view.entries);
    expect(counts.retained).toBe(1);
    expect(counts.dropped).toBe(1);
    expect(counts.inferred).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 6. Aria labels + reconciliation
// ---------------------------------------------------------------------------

describe('conversionEntryAriaLabel', () => {
  it('speaks the wire status, scope, landing, and reason', () => {
    const { nodes, edges } = fixture();
    const view = buildConversionProjectionView(buildConversionProjectionRows(nodes, edges));
    const checklist = view.entries.find(
      (entry) => (entry.row as conversionMod.ConversionProjectionRow | undefined)?.scope === 'checklist',
    );
    const label = conversionEntryAriaLabel(checklist!);
    expect(label).toContain('Info block — inferred');
    expect(label).toContain('checklist evidence');
    expect(label).toContain('lands at /info');
    const loss = view.entries.find(
      (entry) => (entry.row as conversionMod.ConversionProjectionRow | undefined)?.scope === 'loss',
    );
    expect(conversionEntryAriaLabel(loss!)).toContain('not in the OpenAPI document');
    expect(conversionEntryAriaLabel(loss!)).toContain('severity warn');
  });
});

function summaryFor(
  rows: ReturnType<typeof buildConversionProjectionRows>,
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
  for (const row of rows) statusCounts[row.conversionStatus] += 1;
  return {
    schema_version: '1.0.0',
    manifest_hash: 'a'.repeat(64),
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
        node_count: 10,
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
    node_count: 5,
    edge_count: rows.length,
    total_constructs: rows.length,
    is_lossless: false,
    worst_severity: 'warn',
    truncated: false,
    dropped_edge_count: 0,
    ...overrides,
  };
}

describe('reconcileConversionCounts', () => {
  it('is empty when the loaded rows match the manifest tallies', () => {
    const { nodes, edges } = fixture();
    const rows = buildConversionProjectionRows(nodes, edges);
    expect(reconcileConversionCounts(summaryFor(rows), rows)).toEqual([]);
  });

  it('states every mismatch against the manifest', () => {
    const { nodes, edges } = fixture();
    const rows = buildConversionProjectionRows(nodes, edges);
    const summary = summaryFor(rows, {
      edge_count: rows.length + 2,
      status_counts: { ...summaryFor(rows).status_counts, dropped: 3 },
    });
    const mismatches = reconcileConversionCounts(summary, rows);
    expect(mismatches.some((m) => m.includes('5 edges'))).toBe(true);
    expect(mismatches.some((m) => m.includes("status 'dropped'"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. Mermaid export
// ---------------------------------------------------------------------------

describe('Mermaid text export', () => {
  it('escapes quote/markup characters into Mermaid entity codes', () => {
    expect(mermaidLabel('a"b<c>d`e&f')).toBe('a#quot;b#lt;c#gt;d#96;e#amp;f');
    expect(mermaidLabel('‮evil‬')).toBe('evil');
  });

  it('emits a deterministic flowchart grouped by outcome lane', () => {
    const { nodes, edges } = fixture();
    const view = buildConversionProjectionView(buildConversionProjectionRows(nodes, edges));
    const text = conversionProjectionMermaid(view.entries);
    expect(text.startsWith('flowchart LR\n')).toBe(true);
    for (const lane of CONVERSION_LANES) {
      if (view.entries.some((entry) => entry.lane === lane.key)) {
        expect(text).toContain(`subgraph lane_${lane.key}["${lane.label}"]`);
      }
    }
    // The retained construct lands on its pointer; the dropped loss gets a dotted arrow.
    expect(text).toContain('/paths/~1pets~1{id}/get');
    expect(text).toContain('-.->');
    expect(text).toContain('not in the OpenAPI document');
    // Same input, same text.
    expect(conversionProjectionMermaid(view.entries)).toBe(text);
  });

  it('cannot carry live markup out of imported labels', () => {
    const nodes = [sourceNode('source:loss:0', '"]; click <script>alert(1)</script>')];
    const edges = [edge('loss:0000:x', 'loss', 'source:loss:0', null, 'dropped')];
    const view = buildConversionProjectionView(buildConversionProjectionRows(nodes, edges));
    const text = conversionProjectionMermaid(view.entries);
    expect(text).not.toContain('<script>');
    expect(text).not.toContain('"];');
    expect(text).toContain('#lt;script#gt;');
  });

  it('renders an aggregate as one summary node', () => {
    const nodes: ConversionProjectionNode[] = [];
    const edges: ConversionProjectionEdge[] = [];
    for (let i = 0; i < 4; i += 1) {
      nodes.push(sourceNode(`source:construct:type:T${i}`, `T${i}`));
      edges.push(
        edge(`construct:type:type:T${i}`, 'construct', `source:construct:type:T${i}`, null, 'retained', {
          reason: null,
        }),
      );
    }
    const view = buildConversionProjectionView(buildConversionProjectionRows(nodes, edges), 2);
    const text = conversionProjectionMermaid(view.entries);
    expect(text).toContain('4 constructs retained (aggregated)');
  });
});
