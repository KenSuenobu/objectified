/**
 * fidelityLossHeatmap — the ranked fidelity-loss model (IXH-4.3, #5111).
 *
 * Covers the ticket's acceptance criteria at the model level:
 *
 *  1. Findings rank by the documented weighting (`construct × severity × loss class`) and
 *     never by document order — including the ticket's own ordering rule, operation >
 *     parameter/field > description.
 *  2. Grouping by loss class and filtering by entity kind are properties of the built
 *     model, and the filter never touches the counts that reconcile.
 *  3. The view reconciles exactly with the manifest's fidelity-report counts — reported as
 *     a partial walk while pages remain, and as a mismatch only when one is real.
 *  4. Severity/heat carries a word and a glyph, not only a colour class.
 *  5. A finding converts to the shared `ProjectionViewEntry` the existing evidence drawer
 *     renders.
 */

import {
  buildFidelityHeatmap,
  cellAriaLabel,
  constructWeight,
  CONSTRUCT_WEIGHTS,
  DESCRIPTIVE_CONSTRUCT_WEIGHT,
  FIDELITY_ENTITY_KINDS,
  FIDELITY_LOSS_CLASSES,
  findingScore,
  heatmapCellKey,
  heatmapCountMismatches,
  heatmapIntensity,
  heatmapViewEntry,
  intensityPresentation,
  isDescriptiveConstruct,
  LOSS_CLASS_WEIGHTS,
  lossClassForStatus,
  lossClassSpec,
  MAX_FINDING_SCORE,
  rankFindings,
  reconcileHeatmapCounts,
  SEVERITY_WEIGHTS,
  weightingLines,
  type FidelityEntityKind,
} from '../src/app/components/ade/dashboard/export/fidelityLossHeatmap';
import { buildExportMappingRows } from '../src/app/components/ade/dashboard/export/exportMappingGraph';
import type {
  ExportManifestEntity,
  ExportPreviewManifestPage,
} from '../src/app/components/ade/dashboard/export/exportPreviewManifest';
import { PROJECTION_STATUSES } from '../src/app/components/ade/dashboard/export/projectionEvidence';

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

/** One entity per interesting (kind, status, severity) combination, in document order. */
const ENTITIES: ExportManifestEntity[] = [
  // Document order deliberately leads with the trivial losses.
  entity({
    key: 'User.description',
    name: 'description',
    entity_kind: 'field',
    parent_key: 'User',
    order: 0,
    status: 'dropped',
    severity: 'info',
    reason: 'destination_unsupported',
    detail: 'the destination carries no field documentation',
    emitted: false,
  }),
  entity({
    key: 'User.summary',
    name: 'summary',
    entity_kind: 'field',
    parent_key: 'User',
    order: 1,
    status: 'dropped',
    severity: 'info',
    reason: 'destination_unsupported',
    detail: 'the destination carries no field documentation',
    emitted: false,
  }),
  entity({
    key: 'GET /pets/{id}',
    name: 'getPet',
    entity_kind: 'operation',
    parent_key: 'Pets',
    order: 2,
    status: 'dropped',
    severity: 'critical',
    reason: 'destination_unsupported',
    detail: 'the destination cannot represent operations',
    emitted: false,
  }),
  entity({
    key: 'User.email',
    name: 'email',
    entity_kind: 'field',
    parent_key: 'User',
    order: 3,
    status: 'approximated',
    severity: 'warn',
    reason: 'destination_unsupported',
    detail: 'the email format constraint became a doc comment',
  }),
  entity({
    key: 'User',
    name: 'User',
    entity_kind: 'type',
    order: 4,
    status: 'retained',
    severity: 'info',
    detail: 'object carried to the destination',
  }),
  entity({
    key: 'Pets',
    name: 'Pets',
    entity_kind: 'service',
    order: 5,
    status: 'dropped',
    severity: 'critical',
    reason: 'destination_unsupported',
    aggregated: true,
    detail: 'aggregated from 1 operation(s)',
    emitted: false,
  }),
];

const ROWS = buildExportMappingRows(ENTITIES);

function page(overrides: Partial<ExportPreviewManifestPage> = {}): ExportPreviewManifestPage {
  return {
    manifest_hash: 'hash-5111511151115111',
    target: {
      key: 'protobuf',
      format: 'protobuf',
      label: 'Protobuf',
      emitter_version: '1.4.0',
      apiome_version: '2.1.0',
      registry_version: '2025.07.01',
    },
    status_counts: {
      retained: 1,
      transformed: 0,
      approximated: 1,
      synthesized: 0,
      dropped: 4,
      unavailable: 0,
      'not-applicable': 0,
    },
    reason_counts: { destination_unsupported: 5 },
    entities: ENTITIES,
    total_entities: 6,
    dropped_entities: 4,
    files: [],
    page_size: 1000,
    next_cursor: null,
    truncated: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. The documented weighting (AC 1)
// ---------------------------------------------------------------------------

describe('fidelityLossHeatmap — the documented weighting', () => {
  it('scores a finding as construct × severity × loss class', () => {
    const operation = ROWS.find((row) => row.entity.key === 'GET /pets/{id}')!;
    expect(findingScore(operation)).toBe(
      CONSTRUCT_WEIGHTS.operation * SEVERITY_WEIGHTS.critical * LOSS_CLASS_WEIGHTS.dropped,
    );
    expect(findingScore(operation)).toBe(MAX_FINDING_SCORE);
  });

  it('ranks operation over parameter-shaped field over description, as the ticket words it', () => {
    const operation = ROWS.find((row) => row.entity.key === 'GET /pets/{id}')!;
    const field = ROWS.find((row) => row.entity.key === 'User.email')!;
    const description = ROWS.find((row) => row.entity.key === 'User.description')!;
    expect(constructWeight(operation)).toBeGreaterThan(constructWeight(field));
    expect(constructWeight(field)).toBeGreaterThan(constructWeight(description));
    expect(constructWeight(description)).toBe(DESCRIPTIVE_CONSTRUCT_WEIGHT);
  });

  it('demotes documentation-only fields only, never a type that happens to be named one', () => {
    const [descriptionField] = buildExportMappingRows([
      entity({ key: 'User.description', name: 'description', entity_kind: 'field' }),
    ]);
    const [descriptionType] = buildExportMappingRows([
      entity({ key: 'Description', name: 'Description', entity_kind: 'type' }),
    ]);
    expect(isDescriptiveConstruct(descriptionField)).toBe(true);
    expect(isDescriptiveConstruct(descriptionType)).toBe(false);
    expect(constructWeight(descriptionType)).toBe(CONSTRUCT_WEIGHTS.type);
  });

  it('scores anything preserved at zero, however important the construct', () => {
    const [preservedOperation] = buildExportMappingRows([
      entity({ key: 'GET /ok', entity_kind: 'operation', status: 'retained', severity: 'info' }),
    ]);
    expect(findingScore(preservedOperation)).toBe(0);
  });

  it('ranks by score, not by document order, with a total (deterministic) order', () => {
    const ranked = rankFindings(ROWS);
    expect(ranked.map((finding) => finding.row.entity.key)).toEqual([
      'GET /pets/{id}', // critical drop on an operation — 200
      'Pets', // critical drop on a service — 160
      'User.email', // warn approximation on a field — 24
      'User.description', // info drop on a description — 5
      'User.summary', // …tie broken by construct label
      'User', // preserved — 0
    ]);
    expect(ranked.map((finding) => finding.rank)).toEqual([1, 2, 3, 4, 5, 6]);
    // The same input always ranks identically.
    expect(rankFindings([...ROWS].reverse()).map((f) => f.row.entity.key)).toEqual(
      ranked.map((f) => f.row.entity.key),
    );
  });

  it('publishes the very weights it multiplies, for the surface to print', () => {
    const lines = weightingLines();
    for (const kind of FIDELITY_ENTITY_KINDS) {
      expect(lines).toContainEqual({
        axis: 'Construct',
        label: expect.stringMatching(new RegExp(kind, 'i')),
        weight: CONSTRUCT_WEIGHTS[kind],
      });
    }
    expect(lines.filter((line) => line.axis === 'Severity')).toHaveLength(3);
    expect(lines.filter((line) => line.axis === 'Outcome')).toHaveLength(
      FIDELITY_LOSS_CLASSES.length,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Loss classes partition the shared status vocabulary
// ---------------------------------------------------------------------------

describe('fidelityLossHeatmap — loss classes', () => {
  it('assigns every canonical projection status to exactly one class', () => {
    const seen = new Map<string, string>();
    for (const spec of FIDELITY_LOSS_CLASSES) {
      for (const status of spec.statuses) {
        expect(seen.has(status)).toBe(false);
        seen.set(status, spec.key);
      }
    }
    for (const status of PROJECTION_STATUSES) {
      expect(seen.get(status)).toBe(lossClassForStatus(status));
    }
    expect(seen.size).toBe(PROJECTION_STATUSES.length);
  });

  it('folds retained and transformed together, exactly as the report’s ok kind does', () => {
    expect(lossClassForStatus('retained')).toBe('preserved');
    expect(lossClassForStatus('transformed')).toBe('preserved');
    expect(lossClassSpec('preserved').statuses).toEqual(['retained', 'transformed']);
  });
});

// ---------------------------------------------------------------------------
// 3. The matrix, the filter, and the grouping (AC 2)
// ---------------------------------------------------------------------------

describe('buildFidelityHeatmap', () => {
  it('buckets findings into entity kind × loss class cells, worst finding first', () => {
    const heatmap = buildFidelityHeatmap(ROWS);
    const droppedFields = heatmap.cellIndex.get(heatmapCellKey('field', 'dropped'))!;
    expect(droppedFields.count).toBe(2);
    expect(droppedFields.score).toBe(
      2 * DESCRIPTIVE_CONSTRUCT_WEIGHT * SEVERITY_WEIGHTS.info * LOSS_CLASS_WEIGHTS.dropped,
    );

    const droppedOperations = heatmap.cellIndex.get(heatmapCellKey('operation', 'dropped'))!;
    expect(droppedOperations.count).toBe(1);
    expect(droppedOperations.worst?.row.entity.key).toBe('GET /pets/{id}');
    // One critical operation outweighs a pile of dropped descriptions — the whole point.
    expect(droppedOperations.score).toBeGreaterThan(droppedFields.score);
    expect(heatmap.maxCellScore).toBe(MAX_FINDING_SCORE);
  });

  it('lists only the kinds and classes actually present, in display order', () => {
    const heatmap = buildFidelityHeatmap(ROWS);
    expect(heatmap.entityKinds).toEqual(['service', 'operation', 'type', 'field']);
    expect(heatmap.lossClasses).toEqual(['dropped', 'approximated', 'preserved']);
  });

  it('filters by entity kind without changing the counts that reconcile', () => {
    const all = buildFidelityHeatmap(ROWS);
    const fieldsOnly = buildFidelityHeatmap(ROWS, { entityKinds: ['field'] });

    expect(fieldsOnly.filtered).toBe(true);
    expect(fieldsOnly.includedCount).toBe(3);
    expect(fieldsOnly.findings.every((finding) => finding.row.entityKind === 'field')).toBe(true);
    expect(fieldsOnly.cells.every((cell) => cell.entityKind === 'field')).toBe(true);
    // …but the reconciliation basis is untouched.
    expect(fieldsOnly.totalCount).toBe(all.totalCount);
    expect(fieldsOnly.classCounts).toEqual(all.classCounts);
    expect(fieldsOnly.statusCounts).toEqual(all.statusCounts);
    // The filter chips stay stable, so a filter can always be undone.
    expect(fieldsOnly.entityKinds).toEqual(all.entityKinds);
  });

  it('treats an empty filter as no filter', () => {
    const heatmap = buildFidelityHeatmap(ROWS, { entityKinds: [] });
    expect(heatmap.filtered).toBe(false);
    expect(heatmap.includedCount).toBe(ROWS.length);
  });

  it('keeps a filtered finding’s rank the rank it has in the whole ranking', () => {
    const fieldsOnly = buildFidelityHeatmap(ROWS, { entityKinds: ['field'] });
    // `User.email` is 3rd overall; hiding services/operations must not promote it to 1st.
    expect(fieldsOnly.findings[0].row.entity.key).toBe('User.email');
    expect(fieldsOnly.findings[0].rank).toBe(3);
  });

  it('returns an empty, honest model for no rows at all', () => {
    const heatmap = buildFidelityHeatmap([]);
    expect(heatmap.cells).toHaveLength(0);
    expect(heatmap.totalCount).toBe(0);
    expect(heatmap.maxCellScore).toBe(0);
    expect(heatmap.filtered).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Reconciliation with the fidelity report totals (AC 3)
// ---------------------------------------------------------------------------

describe('reconcileHeatmapCounts', () => {
  it('reconciles the per-class counts against the manifest’s status counts', () => {
    const heatmap = buildFidelityHeatmap(ROWS);
    const reconciliation = reconcileHeatmapCounts(heatmap, page(), true);
    expect(reconciliation.partial).toBe(false);
    expect(reconciliation.reconciled).toBe(true);
    expect(heatmapCountMismatches(reconciliation)).toEqual([]);
    expect(reconciliation.heatmapTotal).toBe(6);
    expect(reconciliation.manifestTotal).toBe(6);
  });

  it('reconciles a filtered view too — the filter never narrows the basis', () => {
    const filtered = buildFidelityHeatmap(ROWS, { entityKinds: ['operation'] });
    expect(reconcileHeatmapCounts(filtered, page(), true).reconciled).toBe(true);
  });

  it('reports a prefix walk as partial, never as a mismatch', () => {
    const partialRows = buildExportMappingRows(ENTITIES.slice(0, 3));
    const heatmap = buildFidelityHeatmap(partialRows);
    const reconciliation = reconcileHeatmapCounts(heatmap, page(), false);
    expect(reconciliation.partial).toBe(true);
    expect(reconciliation.reconciled).toBe(false);
    expect(reconciliation.heatmapTotal).toBe(3);
    expect(reconciliation.manifestTotal).toBe(6);
  });

  it('states a genuine disagreement instead of hiding it', () => {
    const heatmap = buildFidelityHeatmap(ROWS);
    const reconciliation = reconcileHeatmapCounts(
      heatmap,
      page({ status_counts: { ...page().status_counts, dropped: 3, approximated: 2 } }),
      true,
    );
    expect(reconciliation.reconciled).toBe(false);
    expect(heatmapCountMismatches(reconciliation).map((entry) => entry.lossClass).sort()).toEqual([
      'approximated',
      'dropped',
    ]);
  });

  it('degrades to the loaded counts when no manifest identity block is available', () => {
    const heatmap = buildFidelityHeatmap(ROWS);
    const reconciliation = reconcileHeatmapCounts(heatmap, null, true);
    // Nothing to compare against: never claims reconciliation it cannot prove.
    expect(reconciliation.reconciled).toBe(false);
    expect(reconciliation.manifestTotal).toBe(heatmap.totalCount);
  });
});

// ---------------------------------------------------------------------------
// 5. Heat encoding — colour is never the only channel (AC 4)
// ---------------------------------------------------------------------------

describe('fidelityLossHeatmap — heat encoding', () => {
  it('maps a score onto 0–4 relative to the hottest cell, never rounding a loss to none', () => {
    expect(heatmapIntensity(0, 200)).toBe(0);
    expect(heatmapIntensity(1, 200)).toBe(1); // a tiny loss still reads as a loss
    expect(heatmapIntensity(100, 200)).toBe(2);
    expect(heatmapIntensity(200, 200)).toBe(4);
    // A matrix with no loss at all has no scale to be relative to.
    expect(heatmapIntensity(5, 0)).toBe(1);
  });

  it('states every level in words and in glyphs, and names no colour at all', () => {
    for (const level of [0, 1, 2, 3, 4] as const) {
      const presentation = intensityPresentation(level);
      expect(presentation.label).toMatch(/^(none|low|moderate|high|severe)$/);
      expect(presentation.glyph.length).toBeGreaterThan(0);
      // HIVE-8.3: the wash lives in `.xstd-heat__cell[data-heat]`, so the presentation
      // carries only the two channels that read without colour.
      expect(Object.keys(presentation).sort()).toEqual(['glyph', 'label']);
    }
    // The glyph count is itself the scale — a greyscale-readable channel.
    expect(intensityPresentation(4).glyph.length).toBeGreaterThan(
      intensityPresentation(1).glyph.length,
    );
  });

  it('names a cell with its count, class, heat, and worst finding', () => {
    const heatmap = buildFidelityHeatmap(ROWS);
    const cell = heatmap.cellIndex.get(heatmapCellKey('field', 'dropped'))!;
    const label = cellAriaLabel(cell, heatmapIntensity(cell.score, heatmap.maxCellScore));
    expect(label).toContain('2 fields dropped');
    expect(label).toMatch(/weighted score \d+/);
    expect(label).toContain('worst: description');
  });
});

// ---------------------------------------------------------------------------
// 6. Evidence hand-off (AC 5)
// ---------------------------------------------------------------------------

describe('heatmapViewEntry', () => {
  it('converts a finding into the shared row entry the evidence drawer renders', () => {
    const row = ROWS.find((candidate) => candidate.entity.key === 'GET /pets/{id}')!;
    const entry = heatmapViewEntry(row);
    expect(entry).toMatchObject({
      key: row.id,
      kind: 'row',
      status: 'dropped',
      severity: 'critical',
      // A construct the artifact does not carry is never laned into the destination.
      lane: 'omitted',
      row,
    });
    expect(entry.row?.edge.reason).toBe('destination_unsupported');
  });

  it('lanes a carried construct into the destination', () => {
    const row = ROWS.find((candidate) => candidate.entity.key === 'User.email')!;
    expect(heatmapViewEntry(row).lane).toBe('target');
  });
});

// ---------------------------------------------------------------------------
// 7. Weight-table integrity
// ---------------------------------------------------------------------------

describe('fidelityLossHeatmap — weight tables', () => {
  it('weighs every entity kind, and weighs an operation highest', () => {
    for (const kind of FIDELITY_ENTITY_KINDS) {
      expect(CONSTRUCT_WEIGHTS[kind as FidelityEntityKind]).toBeGreaterThan(0);
    }
    const highest = Math.max(...FIDELITY_ENTITY_KINDS.map((kind) => CONSTRUCT_WEIGHTS[kind]));
    expect(CONSTRUCT_WEIGHTS.operation).toBe(highest);
  });

  it('costs a drop more than an approximation, and a preserved outcome nothing', () => {
    expect(LOSS_CLASS_WEIGHTS.dropped).toBeGreaterThan(LOSS_CLASS_WEIGHTS.approximated);
    expect(LOSS_CLASS_WEIGHTS.approximated).toBeGreaterThan(LOSS_CLASS_WEIGHTS.synthesized);
    expect(LOSS_CLASS_WEIGHTS.preserved).toBe(0);
    expect(LOSS_CLASS_WEIGHTS['not-applicable']).toBe(0);
    expect(SEVERITY_WEIGHTS.critical).toBeGreaterThan(SEVERITY_WEIGHTS.warn);
    expect(SEVERITY_WEIGHTS.warn).toBeGreaterThan(SEVERITY_WEIGHTS.info);
  });
});
