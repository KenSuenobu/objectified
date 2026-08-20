/**
 * Fidelity loss heatmap model — ranked by entity and severity (IXH-4.3, #5111).
 *
 * `FidelityWarningPanel` and its preserved-% ring give an **aggregate**. On a large spec
 * that aggregate hides the thing that matters: one critical operation losing its request
 * schema reads exactly like a hundred dropped descriptions. This module turns the same
 * fidelity findings the mapping graph (IXH-4.2) renders — the export preview manifest's
 * canonical entities (IXH-4.1), whose statuses the server derives from, and reconciles
 * against, the fidelity report by hard invariant — into a **weighted, ranked** view:
 *
 *  - every finding gets a documented score, `construct × severity × loss class`, so the
 *    order is importance, never document order ({@link findingScore});
 *  - findings group into a small matrix of **entity kind × loss class**
 *    ({@link buildFidelityHeatmap}), which is what makes both the loss-class grouping and
 *    the entity-kind filter the ticket asks for a property of one model rather than two
 *    display modes;
 *  - the cell counts fold back onto the manifest's whole-artifact status counts exactly
 *    ({@link reconcileHeatmapCounts}), mirroring `reconcileMappingCounts` in
 *    `./exportMappingGraph.ts` so the two surfaces cannot disagree about the same job;
 *  - a selected finding becomes a shared `ProjectionViewEntry` ({@link heatmapViewEntry}),
 *    so the existing `EvidenceDrawer` explains it — no second evidence surface.
 *
 * On the weighting vocabulary: the ticket words the construct axis as
 * *operation > parameter > description*. The canonical model has no `parameter` kind — a
 * request/query parameter is a **field** of the operation's request type — and no
 * `description` kind either, because documentation-only constructs are fields too. Both
 * are therefore expressed on the `field` kind: a field weighs {@link CONSTRUCT_WEIGHTS}`.field`,
 * unless it is a documentation-only construct ({@link isDescriptiveConstruct}), which
 * weighs {@link DESCRIPTIVE_CONSTRUCT_WEIGHT}. That preserves the ticket's ordering exactly
 * — operation > field/parameter > description — without inventing kinds the manifest does
 * not carry.
 *
 * Everything here is pure (no React, no fetch, no clock, no randomness) so it unit-tests
 * directly and the same inputs always rank the same way.
 */

import type { ProjectionStatus } from './exportFidelityPreview';
import type { ExportManifestEntity, ExportPreviewManifestPage } from './exportPreviewManifest';
import type { ExportMappingRow } from './exportMappingGraph';
import { laneForMappingRow } from './exportMappingGraph';
import type { LossinessSeverity } from './exportFidelityPreview';
import type { ProjectionLaneKey, ProjectionViewEntry } from './projectionGraph';

// ---------------------------------------------------------------------------
// Loss classes — the grouping axis
// ---------------------------------------------------------------------------

/**
 * The class of loss a finding belongs to — the heatmap's grouping axis (IXH-4.3 AC 2).
 *
 * A partition of the shared CPDO-1.3 projection statuses: every status belongs to exactly
 * one class, which is what lets the cell counts reconcile with the manifest's status
 * counts by construction ({@link reconcileHeatmapCounts}). `preserved` folds `retained`
 * and `transformed` together — the same pairing the fidelity report's `ok` kind uses
 * (`PARITY_KINDS_TO_STATUSES` in `./exportFidelityPreview.ts`) — and every other status
 * keeps its own class rather than being quietly merged into a neighbour.
 */
export type FidelityLossClass =
  | 'dropped'
  | 'unavailable'
  | 'approximated'
  | 'synthesized'
  | 'preserved'
  | 'not-applicable';

/** One loss class's identity: its key, heading, and the statuses it folds. */
export interface FidelityLossClassSpec {
  key: FidelityLossClass;
  /** Column heading / group heading (e.g. `Dropped`). */
  label: string;
  /** One-line description of what the class means, for the legend and the aria labels. */
  description: string;
  /** The projection statuses that fold into this class. */
  statuses: readonly ProjectionStatus[];
}

/**
 * The loss classes in display order — worst first, so the leftmost column of the matrix is
 * the one a user must look at.
 */
export const FIDELITY_LOSS_CLASSES: readonly FidelityLossClassSpec[] = [
  {
    key: 'dropped',
    label: 'Dropped',
    description: 'not representable in the target — the entity is absent from the artifact',
    statuses: ['dropped'],
  },
  {
    key: 'unavailable',
    label: 'Unavailable',
    description: 'the source or the emitter could not supply the entity',
    statuses: ['unavailable'],
  },
  {
    key: 'approximated',
    label: 'Approximated',
    description: 'carried imperfectly — meaning is weakened, not absent',
    statuses: ['approximated'],
  },
  {
    key: 'synthesized',
    label: 'Synthesized',
    description: 'invented to satisfy the target — not present in the source',
    statuses: ['synthesized'],
  },
  {
    key: 'preserved',
    label: 'Preserved',
    description: 'carried faithfully (retained or documented transformation)',
    statuses: ['retained', 'transformed'],
  },
  {
    key: 'not-applicable',
    label: 'Not applicable',
    description: 'the construct does not apply to this target — nothing was lost',
    statuses: ['not-applicable'],
  },
];

/** status → loss class, built once from {@link FIDELITY_LOSS_CLASSES} (a total partition). */
const STATUS_TO_CLASS: Record<ProjectionStatus, FidelityLossClass> = FIDELITY_LOSS_CLASSES.reduce(
  (acc, spec) => {
    for (const status of spec.statuses) acc[status] = spec.key;
    return acc;
  },
  {} as Record<ProjectionStatus, FidelityLossClass>,
);

/**
 * The loss class one projection status belongs to.
 *
 * @param status The construct's projection status.
 * @returns Its loss class; `preserved` for an unrecognised status, which is the only
 *   non-alarming default and can never be reached from the typed vocabulary.
 */
export function lossClassForStatus(status: ProjectionStatus): FidelityLossClass {
  return STATUS_TO_CLASS[status] ?? 'preserved';
}

/** The loss class's spec (label/description/statuses). */
export function lossClassSpec(lossClass: FidelityLossClass): FidelityLossClassSpec {
  return (
    FIDELITY_LOSS_CLASSES.find((spec) => spec.key === lossClass) ?? FIDELITY_LOSS_CLASSES[4]
  );
}

// ---------------------------------------------------------------------------
// The documented weighting (IXH-4.3 AC 1)
// ---------------------------------------------------------------------------

/** The canonical entity kinds the manifest carries — the heatmap's filter axis. */
export type FidelityEntityKind = ExportManifestEntity['entity_kind'];

/** The entity kinds in display order: the biggest surfaces first. */
export const FIDELITY_ENTITY_KINDS: readonly FidelityEntityKind[] = [
  'service',
  'operation',
  'channel',
  'type',
  'field',
];

/**
 * How much the **construct itself** matters, by canonical entity kind.
 *
 * An operation or a channel is a whole callable/event surface, so losing one is the worst
 * thing on this axis. A service sits just below: the manifest aggregates a service's
 * status from its own operations, so scoring it *at* an operation would double-count the
 * operation that caused it. A type is a named schema many constructs reference; a field is
 * one member of a type — which is also where a request/query **parameter** lives.
 */
export const CONSTRUCT_WEIGHTS: Record<FidelityEntityKind, number> = {
  operation: 10,
  channel: 10,
  service: 8,
  type: 6,
  field: 4,
};

/**
 * The weight of a documentation-only construct — the ticket's *description* rung.
 *
 * A dropped description is a real loss and is never hidden, but it must never outrank a
 * dropped request schema, so it weighs the least of anything the model can name.
 */
export const DESCRIPTIVE_CONSTRUCT_WEIGHT = 1;

/**
 * Field names that carry documentation rather than data — the constructs whose loss the
 * ticket calls "trivial descriptions". Matched on the field's own name (the last segment
 * of its canonical key), case-insensitively, and only on `field` entities, so a *type*
 * genuinely called `Description` is never demoted.
 */
export const DESCRIPTIVE_CONSTRUCT_NAMES: ReadonlySet<string> = new Set([
  'description',
  'summary',
  'title',
  'example',
  'examples',
  'comment',
  'comments',
  'doc',
  'docs',
  'documentation',
  'externaldocs',
  'note',
  'notes',
]);

/** How much the loss **matters**, from the fidelity report's own severity. */
export const SEVERITY_WEIGHTS: Record<LossinessSeverity, number> = {
  critical: 4,
  warn: 2,
  info: 1,
};

/**
 * How much the **outcome** costs, by loss class. A preserved or not-applicable outcome
 * costs nothing — it scores zero, so it can never rank above an actual loss however
 * important the construct is.
 */
export const LOSS_CLASS_WEIGHTS: Record<FidelityLossClass, number> = {
  dropped: 5,
  unavailable: 4,
  approximated: 3,
  synthesized: 2,
  preserved: 0,
  'not-applicable': 0,
};

/** The highest score any single finding can reach — `10 × 4 × 5` (the matrix's ceiling). */
export const MAX_FINDING_SCORE =
  CONSTRUCT_WEIGHTS.operation * SEVERITY_WEIGHTS.critical * LOSS_CLASS_WEIGHTS.dropped;

/** The last segment of a canonical key — the construct's own name (`User.email` → `email`). */
function constructLeafName(row: ExportMappingRow): string {
  const key = row.entity.name || row.entity.key || '';
  const segments = key.split(/[./#\/]/).filter(Boolean);
  return (segments[segments.length - 1] ?? key).toLowerCase();
}

/**
 * Whether a finding concerns a documentation-only construct (the *description* rung).
 *
 * Only fields qualify: documentation lives on a field in the canonical model, and demoting
 * a type or an operation because of its name would understate a real loss.
 *
 * @param row The finding's mapping row.
 * @returns True when the row is a documentation-only field.
 */
export function isDescriptiveConstruct(row: ExportMappingRow): boolean {
  if (row.entityKind !== 'field') return false;
  return DESCRIPTIVE_CONSTRUCT_NAMES.has(constructLeafName(row));
}

/**
 * The construct-importance factor for one finding: the entity kind's weight, or the
 * documentation-only weight when the construct is a description-shaped field.
 *
 * @param row The finding's mapping row.
 * @returns The construct weight (1–10).
 */
export function constructWeight(row: ExportMappingRow): number {
  if (isDescriptiveConstruct(row)) return DESCRIPTIVE_CONSTRUCT_WEIGHT;
  return CONSTRUCT_WEIGHTS[row.entityKind] ?? DESCRIPTIVE_CONSTRUCT_WEIGHT;
}

/**
 * The finding's rank score — the documented weighting the whole view orders by
 * (IXH-4.3 AC 1: ranked by a documented weighting, never by document order).
 *
 * `constructWeight × severityWeight × lossClassWeight`. A product, not a sum, so the axes
 * compose the way a reader reasons about them: a critical drop on an operation (10 × 4 × 5
 * = 200) dominates an informational approximation on a description (1 × 1 × 3 = 3) by two
 * orders of magnitude, and a preserved construct scores exactly zero whatever it is.
 *
 * @param row The finding's mapping row.
 * @returns The score, `0` for anything that was not lost.
 */
export function findingScore(row: ExportMappingRow): number {
  const lossClass = lossClassForStatus(row.status);
  return constructWeight(row) * SEVERITY_WEIGHTS[row.severity] * LOSS_CLASS_WEIGHTS[lossClass];
}

/** One line of the weighting the surface prints so the ranking is legible, not magic. */
export interface WeightingLine {
  /** The axis this line belongs to (`Construct`, `Severity`, `Outcome`). */
  axis: string;
  /** What is being weighted (e.g. `Operation`, `Critical`, `Dropped`). */
  label: string;
  /** Its factor. */
  weight: number;
}

/**
 * The whole weighting, as printable lines — the source the "How this is ranked"
 * disclosure renders, so the documented weighting and the computed one are the same
 * tables and cannot drift.
 *
 * @returns Every factor of {@link findingScore}, grouped by axis in display order.
 */
export function weightingLines(): WeightingLine[] {
  const construct: WeightingLine[] = [
    ...FIDELITY_ENTITY_KINDS.map((kind) => ({
      axis: 'Construct',
      label: entityKindLabel(kind),
      weight: CONSTRUCT_WEIGHTS[kind],
    })),
    {
      axis: 'Construct',
      label: 'Documentation-only field (description, summary, example…)',
      weight: DESCRIPTIVE_CONSTRUCT_WEIGHT,
    },
  ];
  const severity: WeightingLine[] = (['critical', 'warn', 'info'] as LossinessSeverity[]).map(
    (severity) => ({
      axis: 'Severity',
      label: severity,
      weight: SEVERITY_WEIGHTS[severity],
    }),
  );
  const outcome: WeightingLine[] = FIDELITY_LOSS_CLASSES.map((spec) => ({
    axis: 'Outcome',
    label: spec.label,
    weight: LOSS_CLASS_WEIGHTS[spec.key],
  }));
  return [...construct, ...severity, ...outcome];
}

/** Singular human label for one entity kind (`operation` → `Operation`). */
export function entityKindLabel(kind: FidelityEntityKind): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

/** Plural human label for one entity kind — the matrix's row heading. */
export function entityKindPluralLabel(kind: FidelityEntityKind): string {
  return `${entityKindLabel(kind)}s`;
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/** Worst-first severity rank, for deterministic tie-breaking. */
const SEVERITY_RANK: Record<LossinessSeverity, number> = { critical: 0, warn: 1, info: 2 };

/** One finding with its score — the ranked view's element. */
export interface RankedFinding {
  /** The mapping row (which carries the manifest entity and the evidence edge). */
  row: ExportMappingRow;
  /** The finding's {@link findingScore}. */
  score: number;
  /** Its loss class. */
  lossClass: FidelityLossClass;
  /** The construct-importance factor that went into the score. */
  constructWeight: number;
  /** 1-based rank in the full ranking (stable regardless of any filter). */
  rank: number;
}

/**
 * Rank findings worst-first by the documented weighting.
 *
 * Order: score descending, then severity (critical first), then the construct label, then
 * the row id — a total order, so the same manifest always ranks identically and a
 * screenshot of the panel is reproducible. Returns a new array; the input is not mutated.
 *
 * @param rows The mapping rows for the loaded manifest entities.
 * @returns Every row as a {@link RankedFinding}, worst first, `rank` filled in.
 */
export function rankFindings(rows: readonly ExportMappingRow[]): RankedFinding[] {
  return [...rows]
    .map((row) => ({
      row,
      score: findingScore(row),
      lossClass: lossClassForStatus(row.status),
      constructWeight: constructWeight(row),
      rank: 0,
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        SEVERITY_RANK[a.row.severity] - SEVERITY_RANK[b.row.severity] ||
        a.row.construct.localeCompare(b.row.construct) ||
        a.row.id.localeCompare(b.row.id),
    )
    .map((finding, index) => ({ ...finding, rank: index + 1 }));
}

// ---------------------------------------------------------------------------
// The heatmap
// ---------------------------------------------------------------------------

/** One cell of the matrix: the findings of one entity kind in one loss class. */
export interface FidelityHeatmapCell {
  /** Stable cell key, `<entityKind>:<lossClass>`. */
  key: string;
  entityKind: FidelityEntityKind;
  lossClass: FidelityLossClass;
  /** Findings in the cell, worst-first. */
  findings: RankedFinding[];
  /** How many findings the cell holds. */
  count: number;
  /** The summed score of the cell — what the heat encodes. */
  score: number;
  /** The cell's worst finding, or null when the cell is empty. */
  worst: RankedFinding | null;
}

/** The built heatmap: the matrix, the ranking, and the counts that must reconcile. */
export interface FidelityHeatmap {
  /** Every non-empty cell, in row-major display order (kind order × class order). */
  cells: FidelityHeatmapCell[];
  /** Cell lookup by `<entityKind>:<lossClass>`; a missing key means an empty cell. */
  cellIndex: ReadonlyMap<string, FidelityHeatmapCell>;
  /** The entity kinds present in the **unfiltered** manifest, in display order. */
  entityKinds: FidelityEntityKind[];
  /** The loss classes present in the **unfiltered** manifest, in display order. */
  lossClasses: FidelityLossClass[];
  /** The findings the filter admits, worst-first (their `rank` is the unfiltered rank). */
  findings: RankedFinding[];
  /** Findings the filter admits. */
  includedCount: number;
  /** Findings in the whole loaded manifest, filter or no filter. */
  totalCount: number;
  /** Per-loss-class counts over **all** loaded rows — the reconciliation basis. */
  classCounts: Record<FidelityLossClass, number>;
  /** Per-status counts over **all** loaded rows — compared to the manifest's own. */
  statusCounts: Partial<Record<ProjectionStatus, number>>;
  /** The largest cell score in the built matrix — the heat scale's top (0 when no loss). */
  maxCellScore: number;
  /** True when a filter is excluding at least one finding. */
  filtered: boolean;
}

/** Options for {@link buildFidelityHeatmap}. */
export interface BuildFidelityHeatmapOptions {
  /**
   * Entity kinds to include (IXH-4.3 AC 2). Omitted or empty → every kind; the filter
   * narrows the matrix and the ranking only — the counts that reconcile are always taken
   * over every loaded row, so filtering can never make the view disagree with the report.
   */
  entityKinds?: readonly FidelityEntityKind[];
}

/** Zero-filled per-class counts. */
function emptyClassCounts(): Record<FidelityLossClass, number> {
  return FIDELITY_LOSS_CLASSES.reduce(
    (acc, spec) => {
      acc[spec.key] = 0;
      return acc;
    },
    {} as Record<FidelityLossClass, number>,
  );
}

/**
 * Build the heatmap over the loaded manifest rows.
 *
 * The matrix is entity kind × loss class; each cell carries its findings worst-first and
 * the **summed** score of the findings in it, so a cell holding one critical dropped
 * operation outranks a cell holding a hundred dropped descriptions — which is the whole
 * point of the ticket. The class/status counts are computed over every row regardless of
 * the filter, because they are what {@link reconcileHeatmapCounts} checks against the
 * manifest.
 *
 * @param rows The mapping rows for the loaded manifest entities (from
 *   `buildExportMappingRows` — the IXH-4.2 join, reused rather than repeated).
 * @param options Entity-kind filter ({@link BuildFidelityHeatmapOptions}).
 * @returns The matrix, the filtered ranking, and the reconciliation counts.
 */
export function buildFidelityHeatmap(
  rows: readonly ExportMappingRow[],
  options?: BuildFidelityHeatmapOptions,
): FidelityHeatmap {
  const ranked = rankFindings(rows);
  const allowedKinds =
    options?.entityKinds && options.entityKinds.length > 0
      ? new Set<FidelityEntityKind>(options.entityKinds)
      : null;

  const classCounts = emptyClassCounts();
  const statusCounts: Partial<Record<ProjectionStatus, number>> = {};
  const kindsPresent = new Set<FidelityEntityKind>();
  const classesPresent = new Set<FidelityLossClass>();
  for (const finding of ranked) {
    classCounts[finding.lossClass] += 1;
    statusCounts[finding.row.status] = (statusCounts[finding.row.status] ?? 0) + 1;
    kindsPresent.add(finding.row.entityKind);
    classesPresent.add(finding.lossClass);
  }

  const findings = allowedKinds
    ? ranked.filter((finding) => allowedKinds.has(finding.row.entityKind))
    : ranked;

  const buckets = new Map<string, RankedFinding[]>();
  for (const finding of findings) {
    const key = heatmapCellKey(finding.row.entityKind, finding.lossClass);
    const bucket = buckets.get(key) ?? [];
    bucket.push(finding);
    buckets.set(key, bucket);
  }

  const cells: FidelityHeatmapCell[] = [];
  for (const kind of FIDELITY_ENTITY_KINDS) {
    for (const spec of FIDELITY_LOSS_CLASSES) {
      const key = heatmapCellKey(kind, spec.key);
      const bucket = buckets.get(key);
      if (!bucket || bucket.length === 0) continue;
      cells.push({
        key,
        entityKind: kind,
        lossClass: spec.key,
        findings: bucket,
        count: bucket.length,
        score: bucket.reduce((sum, finding) => sum + finding.score, 0),
        worst: bucket[0],
      });
    }
  }

  return {
    cells,
    cellIndex: new Map(cells.map((cell) => [cell.key, cell])),
    entityKinds: FIDELITY_ENTITY_KINDS.filter((kind) => kindsPresent.has(kind)),
    lossClasses: FIDELITY_LOSS_CLASSES.map((spec) => spec.key).filter((key) =>
      classesPresent.has(key),
    ),
    findings,
    includedCount: findings.length,
    totalCount: ranked.length,
    classCounts,
    statusCounts,
    maxCellScore: cells.reduce((max, cell) => Math.max(max, cell.score), 0),
    filtered: findings.length !== ranked.length,
  };
}

/** The stable cell key for one (entity kind, loss class) pairing. */
export function heatmapCellKey(kind: FidelityEntityKind, lossClass: FidelityLossClass): string {
  return `${kind}:${lossClass}`;
}

// ---------------------------------------------------------------------------
// Heat encoding — colour is never the only channel (IXH-4.3 AC 4)
// ---------------------------------------------------------------------------

/** The number of non-zero heat levels; level 0 means "no loss here". */
export const HEATMAP_INTENSITY_LEVELS = 4;

/** A cell's heat level: 0 (nothing lost) through {@link HEATMAP_INTENSITY_LEVELS}. */
export type HeatmapIntensity = 0 | 1 | 2 | 3 | 4;

/**
 * The heat level for one cell score, relative to the hottest cell in the same matrix.
 *
 * A relative scale, because an absolute one would paint a perfectly ordinary export in
 * alarm colours; the level is stated in words and glyphs beside the count, so the scale
 * being relative is never the only thing a reader has to go on. Any non-zero score is at
 * least level 1 — a loss is never rendered as "no loss" because a bigger one exists.
 *
 * @param score The cell's summed score.
 * @param maxScore The largest cell score in the matrix.
 * @returns The heat level, 0–4.
 */
export function heatmapIntensity(score: number, maxScore: number): HeatmapIntensity {
  if (score <= 0) return 0;
  if (maxScore <= 0) return 1;
  const level = Math.ceil((score / maxScore) * HEATMAP_INTENSITY_LEVELS);
  return Math.min(HEATMAP_INTENSITY_LEVELS, Math.max(1, level)) as HeatmapIntensity;
}

/** A heat level's three presentation channels: words, shape, and (last) colour. */
export interface HeatmapIntensityPresentation {
  /** The level in words (e.g. `severe`) — the primary channel. */
  label: string;
  /** A repeated block glyph, one per level — the shape channel, readable in greyscale. */
  glyph: string;
}

/*
 * The colour channel is deliberately absent: HIVE-8.3 (#5329) moved it to
 * `.xstd-heat__cell[data-heat]` in `globals.css`, so a cell's wash follows the reader's theme
 * instead of freezing one light palette and one dark one. The two channels that survive here
 * are the ones that work without colour at all — the word and the glyph run — which is what
 * DESIGN.md §6 asks of any heat scale.
 */
const INTENSITY_PRESENTATION: Record<HeatmapIntensity, HeatmapIntensityPresentation> = {
  0: { label: 'none', glyph: '·' },
  1: { label: 'low', glyph: '▪' },
  2: { label: 'moderate', glyph: '▪▪' },
  3: { label: 'high', glyph: '▪▪▪' },
  4: { label: 'severe', glyph: '▪▪▪▪' },
};

/** The words/shape/colour presentation for one heat level. */
export function intensityPresentation(level: HeatmapIntensity): HeatmapIntensityPresentation {
  return INTENSITY_PRESENTATION[level];
}

/**
 * The accessible name for one matrix cell — the same facts the cell prints, as a sentence.
 *
 * @param cell The cell.
 * @param level Its heat level.
 * @returns A screen-reader sentence naming count, kind, class, heat, and worst finding.
 */
export function cellAriaLabel(cell: FidelityHeatmapCell, level: HeatmapIntensity): string {
  const spec = lossClassSpec(cell.lossClass);
  const kind = cell.count === 1 ? entityKindLabel(cell.entityKind).toLowerCase() : entityKindPluralLabel(cell.entityKind).toLowerCase();
  const parts = [
    `${cell.count} ${kind} ${spec.label.toLowerCase()}`,
    `${intensityPresentation(level).label} concentration of loss, weighted score ${cell.score}`,
  ];
  if (cell.worst) {
    parts.push(`worst: ${cell.worst.row.construct}`);
  }
  return `${parts.join(' — ')}. Select to open its evidence.`;
}

/**
 * The shared view entry for one finding, so the **existing** `EvidenceDrawer` explains it
 * (IXH-4.3 AC 5) instead of this surface growing its own evidence rendering.
 *
 * @param row The finding's mapping row.
 * @returns The row as a `ProjectionViewEntry` in the export lane vocabulary.
 */
export function heatmapViewEntry(row: ExportMappingRow): ProjectionViewEntry<ProjectionLaneKey> {
  return {
    key: row.id,
    kind: 'row',
    status: row.status,
    severity: row.severity,
    lane: laneForMappingRow(row),
    label: row.construct,
    row,
  };
}

// ---------------------------------------------------------------------------
// Reconciliation against the fidelity report totals (IXH-4.3 AC 3)
// ---------------------------------------------------------------------------

/** One loss class's heatmap-vs-manifest comparison. */
export interface HeatmapClassReconciliation {
  lossClass: FidelityLossClass;
  /** Findings this heatmap counts in the class (over every loaded row). */
  heatmap: number;
  /** Entities the manifest reports in the class for the whole artifact. */
  manifest: number;
  /** `heatmap - manifest`; zero on a reconciled class. */
  delta: number;
}

/** The whole heatmap's reconciliation against the manifest's fidelity-report counts. */
export interface HeatmapReconciliation {
  /** Per-class comparison, worst-first by absolute delta then class order. */
  classes: HeatmapClassReconciliation[];
  /** Findings the heatmap holds (every loaded row). */
  heatmapTotal: number;
  /** Entities in the whole manifest. */
  manifestTotal: number;
  /** True while manifest pages remain unloaded — a prefix, never a mismatch. */
  partial: boolean;
  /** True when every class and the total match — only assertable on a complete walk. */
  reconciled: boolean;
}

/**
 * Reconcile the heatmap's per-class counts against the manifest's own status counts.
 *
 * The manifest's `status_counts` are the whole-artifact counts the server derives from —
 * and reconciles against, by hard invariant — the fidelity report for the same job
 * (IXH-4.1). Folding them through {@link lossClassForStatus} and comparing to the cell
 * counts is therefore the UI-side proof that the ranked view describes *exactly* the
 * findings the fidelity report totals describe, with nothing dropped by the ranking, the
 * bucketing, or the display cap. This mirrors `reconcileMappingCounts` in
 * `./exportMappingGraph.ts` — same job, same source of truth, same partial-walk honesty —
 * one class-level folding away, so the mapping graph and the heatmap can never tell a user
 * two different stories.
 *
 * While the cursor walk is incomplete the heatmap holds a prefix of the entities: the
 * result is reported as {@link HeatmapReconciliation.partial}, never as a mismatch.
 *
 * @param heatmap The built heatmap (its `classCounts` cover every loaded row).
 * @param page The manifest page identity block carrying the full counts, or null.
 * @param complete True once every manifest page has been loaded.
 * @returns The per-class comparison plus the totals.
 */
export function reconcileHeatmapCounts(
  heatmap: FidelityHeatmap,
  page: ExportPreviewManifestPage | null,
  complete: boolean,
): HeatmapReconciliation {
  const manifestClassCounts = emptyClassCounts();
  for (const [status, count] of Object.entries(page?.status_counts ?? {})) {
    manifestClassCounts[lossClassForStatus(status as ProjectionStatus)] += count ?? 0;
  }

  const classes: HeatmapClassReconciliation[] = FIDELITY_LOSS_CLASSES.map((spec) => ({
    lossClass: spec.key,
    heatmap: heatmap.classCounts[spec.key],
    manifest: manifestClassCounts[spec.key],
    delta: heatmap.classCounts[spec.key] - manifestClassCounts[spec.key],
  }))
    .filter((entry) => entry.heatmap > 0 || entry.manifest > 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.lossClass.localeCompare(b.lossClass));

  const heatmapTotal = heatmap.totalCount;
  const manifestTotal = page?.total_entities ?? heatmapTotal;
  const partial = !complete || heatmapTotal !== manifestTotal;

  return {
    classes,
    heatmapTotal,
    manifestTotal,
    partial,
    reconciled: !partial && page != null && classes.every((entry) => entry.delta === 0),
  };
}

/** The classes whose heatmap count disagrees with the manifest (empty when reconciled). */
export function heatmapCountMismatches(
  reconciliation: HeatmapReconciliation,
): HeatmapClassReconciliation[] {
  return reconciliation.classes.filter((entry) => entry.delta !== 0);
}
