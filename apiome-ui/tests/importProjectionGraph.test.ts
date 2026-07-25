/**
 * Import projection view model (IXH-3.3, #5105).
 *
 * Covers the pure module behind the source→catalog projection map:
 *  1. **Shared primitives, not duplicates** — the module's presentation/layout/counters are
 *     the export projection map's own objects (the IXH-3.3 "shared component import" AC).
 *  2. Import-oriented evidence rows: `projects` edges read native → canonical (the import
 *     direction), document-scope drops keep their native side, and adapter-declared parser
 *     limits — ledger-only server-side — are synthesized so the surface cannot hide them.
 *  3. Family lanes: services / operations / channels / types / document / adapter.
 *  4. Aggregation via the shared builder: per-family, never hiding dropped evidence,
 *     represented counts preserved.
 *  5. Determinism across input permutations.
 *  6. Accessible names carry construct, status, source location, and reason.
 */

import { describe, expect, it } from '@jest/globals';

import * as importMod from '../src/app/components/ade/dashboard/catalog/importProjectionGraph';
import * as exportMod from '../src/app/components/ade/dashboard/export/projectionGraph';
import {
  buildImportEvidenceRows,
  buildImportProjectionView,
  coverageForOutcome,
  IMPORT_FAMILY_LANES,
  importEntryAriaLabel,
  importFamilyForRow,
  projectionGraphLayout,
  viewStatusCounts,
} from '../src/app/components/ade/dashboard/catalog/importProjectionGraph';
import type {
  ProjectionEdge,
  ProjectionNode,
} from '../src/app/components/ade/dashboard/export/projectionEvidence';
import type { ImportPreviewCoverageEntry } from '../src/app/utils/import-preview-manifest';

// ---------------------------------------------------------------------------
// Fixtures — mirror the REST builder's shapes (import_preview_manifest.py)
// ---------------------------------------------------------------------------

/** One entity's graph exactly as the server builds it: native+canonical, derives+projects. */
function entityGraph(
  key: string,
  name: string,
  kind: string,
  options: {
    status?: ProjectionEdge['status'];
    reason?: string | null;
    location?: string | null;
  } = {},
): { nodes: ProjectionNode[]; edges: ProjectionEdge[] } {
  const status = options.status ?? 'retained';
  const nodes: ProjectionNode[] = [
    {
      id: `native:${key}`,
      kind: 'native',
      label: name,
      construct_key: key,
      native: { native_id: `id-${key}`, native_name: name, source_location: options.location ?? null },
    },
    { id: `canonical:${key}`, kind: 'canonical', label: key, construct_key: key, canonical_kind: kind },
  ];
  const edges: ProjectionEdge[] = [
    {
      id: `derives:${key}`,
      relation: 'derives',
      source: `native:${key}`,
      target: `canonical:${key}`,
      status: 'retained',
      severity: 'info',
      detail: 'source construct normalized into the canonical model',
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
  ];
  return { nodes, edges };
}

/** A document-level drop as the server builds it: native node only, projects → null. */
function documentDrop(extraKey: string): { nodes: ProjectionNode[]; edges: ProjectionEdge[] } {
  const construct = `document#${extraKey}`;
  return {
    nodes: [
      {
        id: `native:${construct}`,
        kind: 'native',
        label: extraKey,
        construct_key: construct,
        native: { native_name: extraKey },
      },
    ],
    edges: [
      {
        id: `projects:${construct}#0`,
        relation: 'projects',
        source: `native:${construct}`,
        target: null,
        status: 'dropped',
        reason: 'destination_unsupported',
        severity: 'info',
        detail: `document-level construct ${extraKey} not modeled`,
      },
    ],
  };
}

function ledgerEntry(
  overrides: Partial<ImportPreviewCoverageEntry> & { source_construct: string },
): ImportPreviewCoverageEntry {
  return {
    coverage: 'mapped',
    status: 'retained',
    reason: null,
    detail: 'detail',
    entity_key: null,
    document_scoped: true,
    ...overrides,
  };
}

const PARSER_LIMIT = ledgerEntry({
  source_construct: 'graphql-directives',
  coverage: 'not-parsed-by-adapter',
  status: 'dropped',
  reason: 'source_parse_limit',
  detail: 'Custom directives are not read. Whether this document uses the construct is not evaluated — this is a declared adapter limit.',
  document_scoped: false,
  capability_reference: {
    format: 'graphql',
    mode: 'native',
    importable: true,
    related_issues: ['CLX-77'],
    notes: 'Directive parsing is tracked.',
  },
});

/** The default mixed fixture: one entity per family + a document drop + a parser limit. */
function mixedFixture() {
  const service = entityGraph('svc:pets', 'PetService', 'service', { location: '3:1' });
  const operation = entityGraph('op:listPets', 'listPets', 'operation', { location: '7:3' });
  const channel = entityGraph('ch:events', 'petEvents', 'channel');
  const type = entityGraph('type:Pet', 'Pet', 'type', {
    status: 'approximated',
    reason: 'destination_unsupported',
  });
  const doc = documentDrop('x-vendor');
  return {
    nodes: [...service.nodes, ...operation.nodes, ...channel.nodes, ...type.nodes, ...doc.nodes],
    edges: [...service.edges, ...operation.edges, ...channel.edges, ...type.edges, ...doc.edges],
    coverage: [
      ledgerEntry({ source_construct: 'type:Pet', entity_key: 'type:Pet', coverage: 'partially-mapped', status: 'approximated', reason: 'destination_unsupported', detail: 'x-internal rides in extras' }),
      PARSER_LIMIT,
    ],
  };
}

// ---------------------------------------------------------------------------
// 1. Shared primitives
// ---------------------------------------------------------------------------

describe('shared graph primitives (IXH-3.3 AC: shared, not duplicated)', () => {
  it('re-exports the export projection map’s own objects, not copies', () => {
    expect(importMod.statusPresentation).toBe(exportMod.statusPresentation);
    expect(importMod.sanitizeProjectionLabel).toBe(exportMod.sanitizeProjectionLabel);
    expect(importMod.viewStatusCounts).toBe(exportMod.viewStatusCounts);
    expect(importMod.projectionGraphLayout).toBe(exportMod.projectionGraphLayout);
  });

  it('builds its view through the shared builder (same aggregation guarantees)', () => {
    const { nodes, edges, coverage } = mixedFixture();
    const rows = buildImportEvidenceRows(nodes, edges, coverage);
    const view = buildImportProjectionView(rows);
    // The shared counter over the shared entry shape — identical semantics both sides.
    const counts = viewStatusCounts(view.entries);
    expect(counts.retained).toBe(3);
    expect(counts.approximated).toBe(1);
    expect(counts.dropped).toBe(2); // document drop + synthesized parser limit
  });
});

// ---------------------------------------------------------------------------
// 2. Import-oriented evidence rows
// ---------------------------------------------------------------------------

describe('buildImportEvidenceRows (native → canonical orientation)', () => {
  it('reads the projects edge in the import direction', () => {
    const { nodes, edges } = entityGraph('svc:pets', 'PetService', 'service', { location: '3:1' });
    const [row] = buildImportEvidenceRows(nodes, edges, []);
    expect(row.construct).toBe('svc:pets'); // the canonical node's label
    expect(row.canonicalKind).toBe('service');
    expect(row.sourceLabel).toBe('PetService'); // the native node's evidence
    expect(row.sourceLocation).toBe('3:1');
    expect(row.targetLabel).toBeNull(); // import has no destination side
    expect(row.targetLocation).toBeNull();
    expect(row.status).toBe('retained');
    expect(row.coverage).toBe('mapped');
    expect(row.adapterDeclared).toBe(false);
  });

  it('keeps a document-level drop with only its native side', () => {
    const { nodes, edges } = documentDrop('x-vendor');
    const [row] = buildImportEvidenceRows(nodes, edges, []);
    expect(row.construct).toBe('x-vendor');
    expect(row.canonicalKind).toBeNull();
    expect(row.status).toBe('dropped');
    expect(row.coverage).toBe('unsupported-by-canonical-model');
    expect(importFamilyForRow(row)).toBe('document');
  });

  it('synthesizes a row per adapter-declared parser limit, which has no graph nodes', () => {
    const rows = buildImportEvidenceRows([], [], [PARSER_LIMIT]);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.id).toBe('ledger:graphql-directives');
    expect(row.adapterDeclared).toBe(true);
    expect(row.status).toBe('dropped');
    expect(row.reason).toBe('source_parse_limit');
    expect(row.coverage).toBe('not-parsed-by-adapter');
    expect(row.ledger?.capability_reference?.related_issues).toEqual(['CLX-77']);
    expect(importFamilyForRow(row)).toBe('adapter');
  });

  it('joins the ledger entry by construct key for coverage and capability', () => {
    const { nodes, edges, coverage } = mixedFixture();
    const rows = buildImportEvidenceRows(nodes, edges, coverage);
    const pet = rows.find((row) => row.constructKey === 'type:Pet')!;
    expect(pet.coverage).toBe('partially-mapped'); // from the joined ledger row
    expect(pet.ledger?.detail).toBe('x-internal rides in extras');
  });

  it('derives coverage from the outcome when no ledger entry joins', () => {
    expect(coverageForOutcome('retained', null)).toBe('mapped');
    expect(coverageForOutcome('approximated', 'destination_unsupported')).toBe('partially-mapped');
    expect(coverageForOutcome('dropped', 'destination_unsupported')).toBe('unsupported-by-canonical-model');
    expect(coverageForOutcome('dropped', 'source_parse_limit')).toBe('not-parsed-by-adapter');
  });

  it('skips edges whose native node is missing rather than mis-attributing them', () => {
    const edges = entityGraph('svc:pets', 'PetService', 'service').edges;
    expect(buildImportEvidenceRows([], edges, [])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Family lanes
// ---------------------------------------------------------------------------

describe('family lanes', () => {
  it('assigns every entity kind, document facts, and adapter limits to their lanes', () => {
    const { nodes, edges, coverage } = mixedFixture();
    const rows = buildImportEvidenceRows(nodes, edges, coverage);
    const familyByKey = new Map(rows.map((row) => [row.constructKey, importFamilyForRow(row)]));
    expect(familyByKey.get('svc:pets')).toBe('services');
    expect(familyByKey.get('op:listPets')).toBe('operations');
    expect(familyByKey.get('ch:events')).toBe('channels');
    expect(familyByKey.get('type:Pet')).toBe('types');
    expect(familyByKey.get('document#x-vendor')).toBe('document');
    expect(familyByKey.get('graphql-directives')).toBe('adapter');
  });

  it('orders view entries by the family lane order and lays lanes out only when occupied', () => {
    const { nodes, edges, coverage } = mixedFixture();
    const view = buildImportProjectionView(buildImportEvidenceRows(nodes, edges, coverage));
    const laneOrder = view.entries.map((entry) => entry.lane);
    const laneRank = new Map(IMPORT_FAMILY_LANES.map((lane, i) => [lane.key, i]));
    const ranks = laneOrder.map((lane) => laneRank.get(lane)!);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));

    const layout = projectionGraphLayout(view.entries, IMPORT_FAMILY_LANES);
    expect(layout.lanes.map((lane) => lane.key)).toEqual([
      'services',
      'operations',
      'channels',
      'types',
      'document',
      'adapter',
    ]);
    expect(layout.lanes.every((lane) => lane.count > 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Aggregation through the shared builder
// ---------------------------------------------------------------------------

describe('aggregation (shared guarantees, family-scoped)', () => {
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

  it('aggregates clean rows per family with a lane-qualified key, never dropped evidence', () => {
    const { nodes, edges } = manyTypes(10);
    const doc = documentDrop('x-vendor');
    const rows = buildImportEvidenceRows(
      [...nodes, ...doc.nodes],
      [...edges, ...doc.edges],
      [PARSER_LIMIT],
    );
    const view = buildImportProjectionView(rows, 4);

    const aggregates = view.entries.filter((entry) => entry.kind === 'aggregate');
    expect(aggregates).toHaveLength(1);
    expect(aggregates[0].key).toBe('aggregate:types:retained');
    expect(aggregates[0].members).toHaveLength(10);

    // Both dropped rows (document fact + adapter limit) stay individual.
    const droppedKeys = view.entries
      .filter((entry) => entry.kind === 'row' && entry.status === 'dropped')
      .map((entry) => entry.key);
    expect(droppedKeys).toHaveLength(2);

    const counts = viewStatusCounts(view.entries);
    expect(counts.retained).toBe(10);
    expect(counts.dropped).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 5. Determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('yields identical entries for permuted node/edge/ledger input', () => {
    const { nodes, edges, coverage } = mixedFixture();
    const forward = buildImportProjectionView(buildImportEvidenceRows(nodes, edges, coverage));
    const reversed = buildImportProjectionView(
      buildImportEvidenceRows(
        [...nodes].reverse(),
        [...edges].reverse(),
        [...coverage].reverse(),
      ),
    );
    expect(reversed.entries.map((e) => e.key)).toEqual(forward.entries.map((e) => e.key));
  });
});

// ---------------------------------------------------------------------------
// 6. Accessible names
// ---------------------------------------------------------------------------

describe('importEntryAriaLabel', () => {
  it('carries construct, status text, source provenance, and the reason summary', () => {
    const { nodes, edges } = entityGraph('type:Pet', 'PetV2', 'type', {
      status: 'approximated',
      reason: 'destination_unsupported',
      location: '12:5',
    });
    const view = buildImportProjectionView(buildImportEvidenceRows(nodes, edges, []));
    const label = importEntryAriaLabel(view.entries[0]);
    expect(label).toContain('type:Pet');
    expect(label).toContain('approximated');
    expect(label).toContain('from source PetV2');
    expect(label).toContain('at source line 12:5');
    expect(label).toContain('approximated detail for type:Pet');
  });

  it('marks adapter-declared limits and describes aggregates with their size', () => {
    const rows = buildImportEvidenceRows([], [], [PARSER_LIMIT]);
    const view = buildImportProjectionView(rows);
    expect(importEntryAriaLabel(view.entries[0])).toContain('declared adapter limit');

    const many = buildImportProjectionView(
      buildImportEvidenceRows(
        ...(() => {
          const nodes: ProjectionNode[] = [];
          const edges: ProjectionEdge[] = [];
          for (let i = 0; i < 6; i += 1) {
            const g = entityGraph(`type:T${i}`, `T${i}`, 'type');
            nodes.push(...g.nodes);
            edges.push(...g.edges);
          }
          return [nodes, edges] as const;
        })(),
        [],
      ),
      2,
    );
    const aggregate = many.entries.find((entry) => entry.kind === 'aggregate')!;
    expect(importEntryAriaLabel(aggregate)).toBe(
      '6 constructs retained, aggregated. Select to list them.',
    );
  });
});
