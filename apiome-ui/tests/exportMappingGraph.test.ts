/**
 * exportMappingGraph — the canonical → target mapping view model (IXH-4.2, #5110).
 *
 * Pins the ticket's model-level contract:
 *
 *  1. The graph primitives are the export projection map's own objects, imported and
 *     re-exported — not duplicated (the "no third graph implementation" AC, asserted the
 *     same way IXH-3.3 asserts its sharing: by module identity).
 *  2. Manifest entities join into the shared evidence-row shape with the manifest's own
 *     fidelity facts — status, reason, detail, target pointer, source provenance.
 *  3. Lanes answer "did it survive", and the artifact — not the report — is the arbiter.
 *  4. Aggregation is the shared builder's, so no dropped/approximated/non-info entity can
 *     ever be collapsed away.
 *  5. Statuses reconcile against the manifest's whole-artifact counts (which the server
 *     reconciles against the fidelity report), with a partial walk reported as partial
 *     rather than as a mismatch.
 *  6. Untrusted names/locations are sanitized before they reach a label.
 */

import * as mappingMod from '../src/app/components/ade/dashboard/export/exportMappingGraph';
import * as graphMod from '../src/app/components/ade/dashboard/export/projectionGraph';
import {
  buildExportMappingRows,
  buildExportMappingView,
  laneForMappingRow,
  mappingCountMismatches,
  mappingEdgeFor,
  mappingLaneLabel,
  mappingRowId,
  mappingTargetLocation,
  reconcileMappingCounts,
  viewStatusCounts,
  type ExportMappingRow,
} from '../src/app/components/ade/dashboard/export/exportMappingGraph';
import type {
  ExportManifestEntity,
  ExportPreviewManifestPage,
} from '../src/app/components/ade/dashboard/export/exportPreviewManifest';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function entity(overrides: Partial<ExportManifestEntity> = {}): ExportManifestEntity {
  return {
    key: 'Entity',
    name: 'Entity',
    entity_kind: 'type',
    parent_key: null,
    order: 0,
    description: null,
    deprecated: false,
    status: 'retained',
    reason: null,
    severity: 'info',
    detail: 'carried faithfully',
    target_mapping: null,
    emitted: true,
    location: null,
    aggregated: false,
    reported: true,
    native_name: null,
    native_id: null,
    source_location: null,
    ...overrides,
  };
}

/** A four-entity artifact: one clean, one approximated, one dropped, one unavailable. */
const ENTITIES: ExportManifestEntity[] = [
  entity({
    key: 'Users',
    name: 'Users',
    entity_kind: 'service',
    order: 0,
    aggregated: true,
    location: { file: 'openapi.json', line: 4, pointer: null },
    native_name: 'UserService',
    source_location: 'schema.graphql:3',
  }),
  entity({
    key: 'GET /users/{id}',
    name: 'getUser',
    entity_kind: 'operation',
    parent_key: 'Users',
    order: 1,
    status: 'approximated',
    severity: 'warn',
    reason: 'destination_unsupported',
    detail: 'the response union was flattened',
    location: { file: 'openapi.json', line: 9, pointer: '/paths/~1users~1{id}/get' },
  }),
  entity({
    key: 'user/signedup',
    name: 'user/signedup',
    entity_kind: 'channel',
    order: 2,
    status: 'dropped',
    severity: 'critical',
    reason: 'destination_unsupported',
    detail: 'the destination has no event channels',
    emitted: false,
  }),
  entity({
    key: 'User.avatar',
    name: 'avatar',
    entity_kind: 'field',
    parent_key: 'User',
    order: 3,
    status: 'unavailable',
    reason: 'source_parse_limit',
    detail: 'the source parser did not capture this field',
    emitted: false,
  }),
];

function manifestPage(overrides: Partial<ExportPreviewManifestPage> = {}): ExportPreviewManifestPage {
  return {
    manifest_hash: 'hash-4444444444444444',
    target: {
      key: 'openapi',
      format: 'openapi',
      label: 'OpenAPI 3.1',
      emitter_version: '1.4.0',
      apiome_version: '2.1.0',
      registry_version: '2025.07.01',
    },
    status_counts: {
      retained: 1,
      transformed: 0,
      approximated: 1,
      synthesized: 0,
      dropped: 1,
      unavailable: 1,
      'not-applicable': 0,
    },
    reason_counts: { destination_unsupported: 2, source_parse_limit: 1 },
    entities: ENTITIES,
    total_entities: 4,
    dropped_entities: 2,
    files: [{ path: 'openapi.json', media_type: 'application/json', line_count: 80, entity_count: 2 }],
    page_size: 1000,
    next_cursor: null,
    truncated: false,
    ...overrides,
  };
}

/** N clean, info-severity entities — the aggregation and budget fodder. */
function cleanEntities(count: number): ExportManifestEntity[] {
  return Array.from({ length: count }, (_, index) =>
    entity({
      key: `Type${index}`,
      name: `Type${index}`,
      order: 100 + index,
      location: { file: 'openapi.json', line: 100 + index, pointer: `/components/schemas/Type${index}` },
    }),
  );
}

// ---------------------------------------------------------------------------
// 1. Shared primitives, not duplicated (IXH-4.2 AC 1)
// ---------------------------------------------------------------------------

describe('shared graph primitives (IXH-4.2 AC: no third graph implementation)', () => {
  it('re-exports the export projection map’s own objects', () => {
    expect(mappingMod.statusPresentation).toBe(graphMod.statusPresentation);
    expect(mappingMod.sanitizeProjectionLabel).toBe(graphMod.sanitizeProjectionLabel);
    expect(mappingMod.viewStatusCounts).toBe(graphMod.viewStatusCounts);
    expect(mappingMod.projectionGraphLayout).toBe(graphMod.projectionGraphLayout);
    expect(mappingMod.entryAriaLabel).toBe(graphMod.entryAriaLabel);
    expect(mappingMod.selectDrawnGraphEntries).toBe(graphMod.selectDrawnGraphEntries);
    expect(mappingMod.buildProjectionTableRows).toBe(graphMod.buildProjectionTableRows);
    expect(mappingMod.PROJECTION_LANES).toBe(graphMod.PROJECTION_LANES);
  });

  it('uses the shared status vocabulary — “emitted” is the shared “retained”', () => {
    const [clean] = buildExportMappingRows([ENTITIES[0]]);
    expect(clean.status).toBe('retained');
    expect(clean.emitted).toBe(true);
    expect(graphMod.statusPresentation(clean.status).label).toBe('Retained');
  });

  it('lanes and their labels come from the shared lane set', () => {
    expect(mappingLaneLabel('target')).toBe(graphMod.PROJECTION_LANES[0].label);
    expect(mappingLaneLabel('omitted')).toBe(graphMod.PROJECTION_LANES[1].label);
    expect(mappingLaneLabel('unavailable')).toBe(graphMod.PROJECTION_LANES[2].label);
  });
});

// ---------------------------------------------------------------------------
// 2. The join (IXH-4.2 AC 2 — the drawer's evidence comes from here)
// ---------------------------------------------------------------------------

describe('buildExportMappingRows', () => {
  const rows = buildExportMappingRows(ENTITIES);

  it('produces one row per manifest entity, in manifest order', () => {
    expect(rows.map((row) => row.constructKey)).toEqual([
      'Users',
      'GET /users/{id}',
      'user/signedup',
      'User.avatar',
    ]);
    expect(rows.map((row) => row.id)).toEqual(ENTITIES.map((e) => mappingRowId(e.key)));
  });

  it('carries the manifest’s fidelity facts onto the row and its edge', () => {
    const dropped = rows[2];
    expect(dropped.status).toBe('dropped');
    expect(dropped.severity).toBe('critical');
    expect(dropped.reason).toBe('destination_unsupported');
    expect(dropped.reasonSummary).toBe('the destination has no event channels');
    expect(dropped.emitted).toBe(false);
    expect(dropped.edge.relation).toBe('projects');
    expect(dropped.edge.target).toBeNull(); // nothing to point at in the artifact
    expect(dropped.edge.detail).toBe('the destination has no event channels');
  });

  it('keeps the entity itself for the Review step’s shared selection', () => {
    expect(rows[1].entity).toBe(ENTITIES[1]);
    expect(rows[1].entityKind).toBe('operation');
    expect(rows[0].aggregatedStatus).toBe(true); // the service row aggregates its operations
    expect(rows[0].reported).toBe(true);
  });

  it('surfaces the source provenance when the manifest captured it', () => {
    expect(rows[0].sourceLabel).toBe('UserService');
    expect(rows[0].sourceLocation).toBe('schema.graphql:3');
    expect(rows[1].sourceLabel).toBeNull();
  });

  it('names the entity by its key when the manifest has no display name', () => {
    const [row] = buildExportMappingRows([entity({ key: 'Anon', name: '' })]);
    expect(row.construct).toBe('Anon');
  });
});

describe('mappingTargetLocation — the target pointer, never guessed', () => {
  it('prefers the JSON Pointer the manifest derived', () => {
    expect(
      mappingTargetLocation(
        entity({
          target_mapping: 'components.schemas.User',
          location: { file: 'openapi.json', line: 38, pointer: '/components/schemas/User' },
        }),
      ),
    ).toBe('/components/schemas/User');
  });

  it('falls back to the fidelity report’s target mapping', () => {
    expect(
      mappingTargetLocation(entity({ target_mapping: 'message User', location: null })),
    ).toBe('message User');
  });

  it('falls back to file:line, then to the bare file', () => {
    expect(
      mappingTargetLocation(entity({ location: { file: 'user.proto', line: 12, pointer: null } })),
    ).toBe('user.proto:12');
    expect(
      mappingTargetLocation(entity({ location: { file: 'user.proto', line: null, pointer: null } })),
    ).toBe('user.proto');
  });

  it('is null when nothing located the entity', () => {
    expect(mappingTargetLocation(entity({ emitted: false }))).toBeNull();
  });
});

describe('mappingEdgeFor', () => {
  it('points at a target node only for an entity the artifact carries', () => {
    expect(mappingEdgeFor(entity({ key: 'User', emitted: true })).target).toBe('target:User');
    expect(mappingEdgeFor(entity({ key: 'User', emitted: false })).target).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. Lanes — the artifact is the arbiter (IXH-4.2)
// ---------------------------------------------------------------------------

describe('laneForMappingRow', () => {
  const [clean, approximated, dropped, unavailable] = buildExportMappingRows(ENTITIES);

  it('lanes a carried entity into the destination and a loss out of it', () => {
    expect(laneForMappingRow(clean)).toBe('target');
    expect(laneForMappingRow(approximated)).toBe('target');
    expect(laneForMappingRow(dropped)).toBe('omitted');
    expect(laneForMappingRow(unavailable)).toBe('unavailable');
  });

  it('believes the artifact when the status and the bytes disagree', () => {
    // A "retained" entity the bundle does not carry is an omission, not a survivor.
    const [row] = buildExportMappingRows([entity({ key: 'Ghost', status: 'retained', emitted: false })]);
    expect(laneForMappingRow(row)).toBe('omitted');
  });
});

// ---------------------------------------------------------------------------
// 4. The view: shared aggregation guarantees
// ---------------------------------------------------------------------------

describe('buildExportMappingView', () => {
  it('groups entries by lane in the shared lane order', () => {
    const view = buildExportMappingView(buildExportMappingRows(ENTITIES));
    expect(view.entries.map((entry) => entry.lane)).toEqual([
      'target',
      'target',
      'omitted',
      'unavailable',
    ]);
    expect(view.aggregated).toBe(false);
    expect(view.rowCount).toBe(4);
  });

  it('orders worst-first within a lane', () => {
    const view = buildExportMappingView(buildExportMappingRows(ENTITIES));
    const targetLane = view.entries.filter((entry) => entry.lane === 'target');
    expect(targetLane.map((entry) => entry.status)).toEqual(['approximated', 'retained']);
  });

  it('aggregates only clean info rows above the threshold', () => {
    const rows = buildExportMappingRows([...ENTITIES, ...cleanEntities(10)]);
    const view = buildExportMappingView(rows, 4);
    const aggregates = view.entries.filter((entry) => entry.kind === 'aggregate');
    expect(aggregates).toHaveLength(1);
    expect(aggregates[0].status).toBe('retained');
    expect(aggregates[0].members).toHaveLength(11); // the clean service + 10 clean types

    // Every loss survives as its own entry — the shared guarantee.
    const individual = view.entries.filter((entry) => entry.kind === 'row');
    expect(individual.map((entry) => entry.status).sort()).toEqual([
      'approximated',
      'dropped',
      'unavailable',
    ]);
    expect(view.rowCount).toBe(14);
  });

  it('counts aggregate members, so the counts never shrink when the map collapses', () => {
    const rows = buildExportMappingRows([...ENTITIES, ...cleanEntities(10)]);
    const collapsed = viewStatusCounts(buildExportMappingView(rows, 4).entries);
    const expanded = viewStatusCounts(buildExportMappingView(rows, 1000).entries);
    expect(collapsed).toEqual(expanded);
    expect(collapsed.retained).toBe(11);
  });

  it('is deterministic under input permutation', () => {
    const rows = buildExportMappingRows(ENTITIES);
    const shuffled = buildExportMappingRows([ENTITIES[3], ENTITIES[1], ENTITIES[0], ENTITIES[2]]);
    expect(buildExportMappingView(shuffled).entries.map((e) => e.key)).toEqual(
      buildExportMappingView(rows).entries.map((e) => e.key),
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Reconciliation (IXH-4.2 AC 4)
// ---------------------------------------------------------------------------

describe('reconcileMappingCounts', () => {
  const view = buildExportMappingView(buildExportMappingRows(ENTITIES));

  it('reconciles a full walk against the manifest’s report-derived counts', () => {
    const result = reconcileMappingCounts(view, manifestPage(), true);
    expect(result.partial).toBe(false);
    expect(result.reconciled).toBe(true);
    expect(mappingCountMismatches(result)).toEqual([]);
    expect(result.graphTotal).toBe(4);
    expect(result.manifestTotal).toBe(4);
    expect(result.graphDropped).toBe(2);
    expect(result.manifestDropped).toBe(2);
  });

  it('reconciles just as well when the map has aggregated', () => {
    const rows = buildExportMappingRows([...ENTITIES, ...cleanEntities(10)]);
    const page = manifestPage({
      status_counts: {
        retained: 11,
        transformed: 0,
        approximated: 1,
        synthesized: 0,
        dropped: 1,
        unavailable: 1,
        'not-applicable': 0,
      },
      total_entities: 14,
    });
    const result = reconcileMappingCounts(buildExportMappingView(rows, 4), page, true);
    expect(result.reconciled).toBe(true);
  });

  it('reports an unfinished walk as partial, not as a mismatch', () => {
    const partialView = buildExportMappingView(buildExportMappingRows(ENTITIES.slice(0, 2)));
    const result = reconcileMappingCounts(partialView, manifestPage(), false);
    expect(result.partial).toBe(true);
    expect(result.reconciled).toBe(false);
    expect(result.graphTotal).toBe(2);
    expect(result.manifestTotal).toBe(4);
  });

  it('treats a complete-but-short walk as partial too', () => {
    const shortView = buildExportMappingView(buildExportMappingRows(ENTITIES.slice(0, 3)));
    expect(reconcileMappingCounts(shortView, manifestPage(), true).partial).toBe(true);
  });

  it('names every status whose drawn count disagrees with the report', () => {
    const page = manifestPage({
      status_counts: {
        retained: 2,
        transformed: 0,
        approximated: 1,
        synthesized: 0,
        dropped: 0,
        unavailable: 1,
        'not-applicable': 0,
      },
      dropped_entities: 1,
    });
    const result = reconcileMappingCounts(view, page, true);
    expect(result.partial).toBe(false);
    expect(result.reconciled).toBe(false);
    expect(mappingCountMismatches(result).map((entry) => entry.status).sort()).toEqual([
      'dropped',
      'retained',
    ]);
    const droppedEntry = mappingCountMismatches(result).find((e) => e.status === 'dropped');
    expect(droppedEntry).toMatchObject({ graph: 1, manifest: 0, delta: 1 });
  });

  it('degrades to the view’s own counts when no manifest identity is loaded', () => {
    const result = reconcileMappingCounts(view, null, true);
    expect(result.manifestTotal).toBe(4);
    expect(result.reconciled).toBe(false); // nothing to reconcile against
    expect(result.partial).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. Sanitisation (defence in depth — labels reach SVG text and aria strings)
// ---------------------------------------------------------------------------

describe('label sanitisation', () => {
  it('strips control and bidi-override characters from names and locations', () => {
    const [row] = buildExportMappingRows([
      entity({
        key: 'User',
        name: 'Us‮er',
        native_name: 'na‏me',
        source_location: 'schema .graphql:1',
        detail: 'dropped‭ because',
        location: { file: 'open‮api.json', line: 3, pointer: '/components' },
      }),
    ]);
    const values: (string | null)[] = [
      row.construct,
      row.sourceLabel,
      row.sourceLocation,
      row.reasonSummary,
      row.targetLabel,
      row.targetLocation,
    ];
    for (const value of values) {
      expect(value).not.toBeNull();
      expect(value).not.toMatch(/[ -‪-‮‎‏]/);
    }
    expect(row.construct).toBe('User');
  });

  it('leaves the untouched key as the row identity for selection', () => {
    const [row] = buildExportMappingRows([entity({ key: 'GET /users/{id}' })]);
    expect(row.constructKey).toBe('GET /users/{id}');
    expect(row.id).toBe('entity:GET /users/{id}');
  });
});

// ---------------------------------------------------------------------------
// 7. Row shape stays assignable to the shared evidence row
// ---------------------------------------------------------------------------

describe('shared row shape', () => {
  it('is a ProjectionEvidenceRow the shared builders accept', () => {
    const rows: ExportMappingRow[] = buildExportMappingRows(ENTITIES);
    const view = buildExportMappingView(rows);
    const drawn = graphMod.selectDrawnGraphEntries(view.entries, 2);
    expect(drawn.truncated).toBe(true);
    // Worst-first: the cap keeps the losses and drops the clean tail.
    expect(drawn.drawn.map((entry) => entry.status)).toEqual(['approximated', 'dropped']);

    const tableRows = graphMod.buildProjectionTableRows(view.entries, new Set());
    expect(tableRows).toHaveLength(view.entries.length);
    expect(tableRows[0].bodyRowIndex).toBe(1);
  });
});
