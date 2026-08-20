'use client';

/**
 * FidelityLossHeatmapPanel — fidelity loss ranked by entity and severity (IXH-4.3, #5111).
 *
 * The fidelity warning panel's ring and chips give an aggregate; the mapping graph
 * (IXH-4.2) gives the whole map. Neither answers the question a user of a large spec
 * actually has: **what is the worst thing this export loses?** This panel answers it, over
 * the same IXH-4.1 preview manifest the graph and the explorer read:
 *
 *  - a **matrix** of entity kind × loss class, each cell showing its finding count and a
 *    heat level stated three ways — the level in words, a repeated block glyph, and (last)
 *    colour — so severity is never encoded by colour alone;
 *  - a **ranked list** ordered by the documented weighting in `./fidelityLossHeatmap.ts`
 *    (`construct × severity × loss class`), never by document order, printed with each
 *    finding's own score and a disclosure spelling the weighting out;
 *  - **grouping by loss class** and an **entity-kind filter**, neither of which touches the
 *    counts that reconcile — a filtered view states what it is hiding;
 *  - a **reconciliation strip** stating whether the view's per-class counts reproduce the
 *    manifest's whole-artifact counts for this job (the counts the server derives from,
 *    and reconciles against, the fidelity report), reported as a partial walk while pages
 *    remain rather than as a disagreement;
 *  - the **existing `EvidenceDrawer`** on selection — selecting a cell selects its worst
 *    finding, which is the Review step's own entity selection, so the explorer and the
 *    code viewer follow exactly as they do from the mapping graph.
 *
 * A manifest failure degrades to a quiet notice and never gates the export.
 */

import { useCallback, useMemo, useState } from 'react';
import { AlertTriangle, Flame, Loader2 } from 'lucide-react';
import { cn } from '@lib/utils';
import { Badge } from '../../../ui/Badge';
import { Button } from '../../../ui/Button';
import { EvidenceDrawer } from './EvidenceDrawer';
import { useCapabilityReasons } from './useCapabilityReasons';
import { advisorySeverityTone } from '../../../../utils/export-advisory';
import type {
  ExportManifestEntity,
  ExportPreviewManifestPage,
} from './exportPreviewManifest';
import {
  buildExportMappingRows,
  statusPresentation,
  type ExportMappingRow,
} from './exportMappingGraph';
import {
  buildFidelityHeatmap,
  cellAriaLabel,
  FIDELITY_LOSS_CLASSES,
  entityKindLabel,
  entityKindPluralLabel,
  heatmapCellKey,
  heatmapCountMismatches,
  heatmapIntensity,
  heatmapViewEntry,
  intensityPresentation,
  lossClassSpec,
  reconcileHeatmapCounts,
  weightingLines,
  type FidelityEntityKind,
  type FidelityHeatmapCell,
  type FidelityLossClass,
  type HeatmapReconciliation,
  type RankedFinding,
} from './fidelityLossHeatmap';

/** Ranked findings shown before the "show more" step — never a silent cap. */
const RANKED_PAGE_SIZE = 12;

/** How the ranked list is organised (IXH-4.3 AC 2: grouping by loss class is supported). */
type RankedGrouping = 'loss-class' | 'rank';

export interface FidelityLossHeatmapPanelProps {
  /** The manifest's identity block (hash, target, whole-artifact counts), or null. */
  page: ExportPreviewManifestPage | null;
  /** The accumulated manifest entities (merged cursor pages), in stable tree order. */
  entities: ExportManifestEntity[];
  /** Whether a manifest page walk is in flight. */
  loading: boolean;
  /** Transport error; the panel states it and the rest of the Review step is unaffected. */
  error: string | null;
  /** True once every entity page is loaded (the view can then reconcile). */
  complete: boolean;
  /** Walk further cursor pages — the stated path to the complete ranking. */
  onLoadMore: () => void;
  /** Human label of the chosen target format (e.g. `gRPC / Protobuf`). */
  targetLabel: string;
  /** The selected entity's canonical key — shared with the explorer and the code viewer. */
  selectedEntityKey: string | null;
  /** Select an entity: the step records it and reveals a located entity in the code. */
  onSelectEntity: (entity: ExportManifestEntity) => void;
  /** Clear the shared entity selection — what closing the evidence drawer does. */
  onClearSelection: () => void;
  /**
   * Whether this panel owns the evidence drawer for the shared selection. The Review step
   * renders this panel alongside the mapping graph (IXH-4.2) over the same manifest and the
   * same selection; the evidence belongs beside the surface the user selected from, so the
   * step hands ownership to that one. Defaults to true.
   */
  showEvidence?: boolean;
  /** Navigate back to the target choice — the drawer's safe remediation for a format limit. */
  onChangeTarget?: () => void;
  /** Navigate back to the export options — the drawer's safe remediation for an exclusion. */
  onChangeOptions?: () => void;
  /** Ranked-list page size override; tests pass a small value. */
  rankedPageSize?: number;
  className?: string;
}

export function FidelityLossHeatmapPanel({
  page,
  entities,
  loading,
  error,
  complete,
  onLoadMore,
  targetLabel,
  selectedEntityKey,
  onSelectEntity,
  onClearSelection,
  showEvidence = true,
  onChangeTarget,
  onChangeOptions,
  rankedPageSize = RANKED_PAGE_SIZE,
  className,
}: FidelityLossHeatmapPanelProps) {
  /** The entity kinds the user is interested in; empty means every kind. */
  const [kindFilter, setKindFilter] = useState<ReadonlySet<FidelityEntityKind>>(new Set());
  const [grouping, setGrouping] = useState<RankedGrouping>('loss-class');
  /** A matrix cell the ranked list is scoped to, or null for the whole ranking. */
  const [scopedCellKey, setScopedCellKey] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(rankedPageSize);

  const rows = useMemo(() => buildExportMappingRows(entities), [entities]);
  const heatmap = useMemo(
    () => buildFidelityHeatmap(rows, { entityKinds: [...kindFilter] }),
    [rows, kindFilter],
  );
  const reconciliation = useMemo(
    () => reconcileHeatmapCounts(heatmap, page, complete),
    [heatmap, page, complete],
  );

  const scopedCell = scopedCellKey ? (heatmap.cellIndex.get(scopedCellKey) ?? null) : null;
  /** The findings the ranked list prints: the filtered ranking, scoped to a cell if one is. */
  const rankedFindings = scopedCell ? scopedCell.findings : heatmap.findings;
  const lossyFindings = useMemo(
    () => rankedFindings.filter((finding) => finding.score > 0),
    [rankedFindings],
  );
  const shownFindings = lossyFindings.slice(0, visibleCount);

  /** The selected row, resolved from the step's shared entity selection. */
  const selectedRow = useMemo(
    () => rows.find((row) => row.entity.key === selectedEntityKey) ?? null,
    [rows, selectedEntityKey],
  );
  const selectedEntry = useMemo(
    () => (showEvidence && selectedRow ? heatmapViewEntry(selectedRow) : null),
    [showEvidence, selectedRow],
  );
  // The reviewed reason explanations the drawer prints — fetched only once evidence is
  // open, and module-cached with every other drawer on the page.
  const { reasons } = useCapabilityReasons(selectedEntry != null);

  /** Toggle one entity kind in the filter; a hidden cell can never stay the scoped one. */
  const toggleKind = useCallback((kind: FidelityEntityKind) => {
    setKindFilter((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
    setScopedCellKey((current) => (current?.startsWith(`${kind}:`) ? null : current));
    setVisibleCount(rankedPageSize);
  }, [rankedPageSize]);

  /**
   * Select one cell: scope the ranked list to it and select its worst finding, which opens
   * the existing evidence drawer through the Review step's shared selection. Selecting the
   * scoped cell again releases the scope; the evidence stays open until it is closed.
   */
  const selectCell = useCallback(
    (cell: FidelityHeatmapCell) => {
      setVisibleCount(rankedPageSize);
      if (scopedCellKey === cell.key) {
        setScopedCellKey(null);
        return;
      }
      setScopedCellKey(cell.key);
      if (cell.worst) onSelectEntity(cell.worst.row.entity);
    },
    [onSelectEntity, rankedPageSize, scopedCellKey],
  );

  if (error) {
    return (
      <section className={cn('space-y-2', className)} data-testid="fidelity-heatmap">
        <SectionHeading targetLabel={targetLabel} />
        <p
          className="xstd-notice" data-tone="warn"
          data-testid="fidelity-heatmap-error"
        >
          <AlertTriangle className="mr-1.5 inline h-3.5 w-3.5 align-text-bottom" aria-hidden />
          The ranked loss view could not be loaded — the artifact and its fidelity report are
          unaffected. {error}
        </p>
      </section>
    );
  }

  if (rows.length === 0) {
    return (
      <section className={cn('space-y-2', className)} data-testid="fidelity-heatmap">
        <SectionHeading targetLabel={targetLabel} />
        {loading ? (
          <p
            className="xstd-loading-row"
            data-testid="fidelity-heatmap-loading"
          >
            <Loader2 className="motion-safe:animate-spin" aria-hidden />
            Ranking the fidelity findings…
          </p>
        ) : (
          <p
            className="xstd-empty"
            data-testid="fidelity-heatmap-empty"
          >
            The manifest carried no canonical entities for this artifact.
          </p>
        )}
      </section>
    );
  }

  return (
    <section className={cn('space-y-3', className)} data-testid="fidelity-heatmap">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionHeading targetLabel={targetLabel} />
        {page && (
          <span
            data-testid="fidelity-heatmap-snapshot"
            title={`Manifest snapshot ${page.manifest_hash}`}
            className="xstd-map__snapshot"
          >
            snapshot {page.manifest_hash.slice(0, 12)}
          </span>
        )}
      </div>

      <ReconciliationStrip
        reconciliation={reconciliation}
        loading={loading}
        complete={complete}
        onLoadMore={onLoadMore}
      />

      <HeatmapControls
        kinds={heatmap.entityKinds}
        kindFilter={kindFilter}
        onToggleKind={toggleKind}
        grouping={grouping}
        onGroupingChange={(next) => {
          setGrouping(next);
          setVisibleCount(rankedPageSize);
        }}
      />

      {heatmap.filtered && (
        <p className="xstd-note" data-testid="fidelity-heatmap-filtered">
          Showing {heatmap.includedCount.toLocaleString()} of{' '}
          {heatmap.totalCount.toLocaleString()} findings — the filter narrows this view only;
          the counts above still cover every entity.
        </p>
      )}

      <HeatmapMatrix
        heatmap={heatmap}
        targetLabel={targetLabel}
        scopedCellKey={scopedCellKey}
        onSelectCell={selectCell}
      />

      {/* Selection → the existing export evidence drawer, announced politely. */}
      <div aria-live="polite">
        {selectedEntry && (
          <EvidenceDrawer
            entry={selectedEntry}
            summary={page ? { target: page.target as unknown as Record<string, unknown> } : null}
            reasons={reasons}
            onClose={onClearSelection}
            onChangeTarget={onChangeTarget}
            onChangeOptions={onChangeOptions}
          />
        )}
      </div>

      <RankedFindings
        findings={shownFindings}
        totalLossy={lossyFindings.length}
        grouping={grouping}
        scopedCell={scopedCell}
        onClearScope={() => setScopedCellKey(null)}
        selectedEntityKey={selectedEntityKey}
        onSelectEntity={onSelectEntity}
        onShowMore={() => setVisibleCount((count) => count + rankedPageSize)}
      />

      <WeightingDisclosure />
    </section>
  );
}

/** The section heading, shared by the populated, empty, and error states. */
function SectionHeading({ targetLabel }: { targetLabel: string }) {
  return (
    <h4 className="xstd-caps">
      <Flame aria-hidden />
      What {targetLabel} loses, worst first
    </h4>
  );
}

/**
 * The reconciliation strip (IXH-4.3 AC 3): whether the ranked view's per-loss-class counts
 * reproduce the manifest's whole-artifact counts — which the server derives from, and
 * reconciles against, the fidelity report for this job. A partial walk states the
 * loaded-of-total counts and offers the rest; a genuine disagreement is stated, never hidden.
 */
function ReconciliationStrip({
  reconciliation,
  loading,
  complete,
  onLoadMore,
}: {
  reconciliation: HeatmapReconciliation;
  loading: boolean;
  complete: boolean;
  onLoadMore: () => void;
}) {
  const mismatches = heatmapCountMismatches(reconciliation);

  if (reconciliation.partial) {
    return (
      <div
        className="xstd-notice"
        data-testid="fidelity-heatmap-partial"
      >
        <span>
          Ranking {reconciliation.heatmapTotal.toLocaleString()} of{' '}
          {reconciliation.manifestTotal.toLocaleString()} entities — load the rest to rank
          them all and reconcile against the fidelity report.
        </span>
        {loading ? (
          <span className="xstd-quiet inline-flex items-center gap-1">
            <Loader2 className="h-3 w-3 motion-safe:animate-spin text-accent" aria-hidden />
            Loading…
          </span>
        ) : (
          !complete && (
            <Button
              variant="outline"
              size="sm"
              data-testid="fidelity-heatmap-load-more"
              onClick={onLoadMore}
            >
              Load more entities
            </Button>
          )
        )}
      </div>
    );
  }

  if (mismatches.length > 0) {
    return (
      <p
        role="status"
        className="xstd-notice" data-tone="warn"
        data-testid="fidelity-heatmap-mismatch"
      >
        <AlertTriangle className="mr-1.5 inline h-3.5 w-3.5 align-text-bottom" aria-hidden />
        This ranking does not reconcile with the fidelity report for this job:{' '}
        {mismatches
          .map((entry) => `${entry.lossClass} ranked ${entry.heatmap}, reported ${entry.manifest}`)
          .join('; ')}
        . Re-run the export for one consistent view.
      </p>
    );
  }

  return (
    <p
      className="xstd-note"
      data-testid="fidelity-heatmap-reconciled"
    >
      Reconciles with the fidelity report for this job:{' '}
      {reconciliation.classes
        .map((entry) => `${entry.manifest.toLocaleString()} ${lossClassSpec(entry.lossClass).label.toLowerCase()}`)
        .join(' · ')}{' '}
      over {reconciliation.manifestTotal.toLocaleString()} canonical entities.
    </p>
  );
}

/** The entity-kind filter and the ranked-list grouping — the two controls AC 2 asks for. */
function HeatmapControls({
  kinds,
  kindFilter,
  onToggleKind,
  grouping,
  onGroupingChange,
}: {
  kinds: FidelityEntityKind[];
  kindFilter: ReadonlySet<FidelityEntityKind>;
  onToggleKind: (kind: FidelityEntityKind) => void;
  grouping: RankedGrouping;
  onGroupingChange: (grouping: RankedGrouping) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <fieldset className="flex flex-wrap items-center gap-1.5" data-testid="fidelity-heatmap-kind-filter">
        <legend className="sr-only">Filter the ranking by entity kind</legend>
        <span className="xstd-caps">
          Entity kind
        </span>
        {kinds.map((kind) => {
          const active = kindFilter.has(kind);
          return (
            <button
              key={kind}
              type="button"
              aria-pressed={active}
              data-testid={`fidelity-heatmap-kind-${kind}`}
              onClick={() => onToggleKind(kind)}
              className="xstd-chip"
            >
              {entityKindPluralLabel(kind)}
            </button>
          );
        })}
        {kindFilter.size === 0 && (
          <span className="xstd-note">all kinds</span>
        )}
      </fieldset>

      <fieldset className="flex flex-wrap items-center gap-1.5" data-testid="fidelity-heatmap-grouping">
        <legend className="sr-only">Group the ranked findings</legend>
        <span className="xstd-caps">
          Group by
        </span>
        {(
          [
            { key: 'loss-class' as const, label: 'Loss class' },
            { key: 'rank' as const, label: 'Rank only' },
          ]
        ).map((option) => (
          <button
            key={option.key}
            type="button"
            aria-pressed={grouping === option.key}
            data-testid={`fidelity-heatmap-group-${option.key}`}
            onClick={() => onGroupingChange(option.key)}
            className="xstd-chip"
          >
            {option.label}
          </button>
        ))}
      </fieldset>
    </div>
  );
}

/**
 * The matrix: entity kind (rows) × loss class (columns). Every populated cell is a button
 * carrying its count, its heat level in words and glyphs, and the weighted score — colour
 * is the last channel, never the only one (IXH-4.3 AC 4). The footer prints the per-class
 * totals, which are the fidelity report's totals for the same job.
 */
function HeatmapMatrix({
  heatmap,
  targetLabel,
  scopedCellKey,
  onSelectCell,
}: {
  heatmap: ReturnType<typeof buildFidelityHeatmap>;
  targetLabel: string;
  scopedCellKey: string | null;
  onSelectCell: (cell: FidelityHeatmapCell) => void;
}) {
  const kinds = heatmap.entityKinds.filter((kind) =>
    heatmap.cells.some((cell) => cell.entityKind === kind),
  );
  const classes = heatmap.lossClasses.filter((lossClass) =>
    heatmap.cells.some((cell) => cell.lossClass === lossClass),
  );

  if (kinds.length === 0 || classes.length === 0) {
    return (
      <p
        className="xstd-empty"
        data-testid="fidelity-heatmap-matrix-empty"
      >
        No entities match this filter.
      </p>
    );
  }

  return (
    <div className="xstd-heat">
      <table className="w-full text-left text-xs" data-testid="fidelity-heatmap-matrix">
        <caption className="sr-only">
          Fidelity loss for {targetLabel} by entity kind and loss class. Each cell states how
          many entities it holds, the concentration of loss in words and in blocks, and its
          weighted score; selecting a cell opens the evidence for its worst finding.
        </caption>
        <thead>
          <tr className="text-2xs">
            <th scope="col" className="px-2 py-1.5">
              Entity kind
            </th>
            {classes.map((lossClass) => {
              const spec = lossClassSpec(lossClass);
              const status = statusPresentation(spec.statuses[0]);
              return (
                <th key={lossClass} scope="col" className="px-2 py-1.5" data-testid={`fidelity-heatmap-column-${lossClass}`}>
                  <span aria-hidden>{status.symbol} </span>
                  {spec.label}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {kinds.map((kind) => (
            <tr key={kind}>
              <th
                scope="row"
                className="xstd-heat__kind px-2 py-1.5"
              >
                {entityKindPluralLabel(kind)}
              </th>
              {classes.map((lossClass) => {
                const cell = heatmap.cellIndex.get(heatmapCellKey(kind, lossClass)) ?? null;
                return (
                  <td key={lossClass} className="px-1 py-1">
                    {cell ? (
                      <HeatmapCellButton
                        cell={cell}
                        maxScore={heatmap.maxCellScore}
                        scoped={scopedCellKey === cell.key}
                        onSelect={() => onSelectCell(cell)}
                      />
                    ) : (
                      <span
                        className="xstd-heat__empty"
                        data-testid={`fidelity-heatmap-empty-cell-${heatmapCellKey(kind, lossClass)}`}
                      >
                        <span aria-hidden>—</span>
                        <span className="sr-only">
                          no {entityKindPluralLabel(kind).toLowerCase()}{' '}
                          {lossClassSpec(lossClass).label.toLowerCase()}
                        </span>
                      </span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="text-2xs">
            <th scope="row" className="px-2 py-1.5 font-semibold uppercase tracking-wide">
              Report totals
              {/* Always every entity, filter or no filter — these are the numbers the
                  fidelity report totals, and the strip above states whether they agree. */}
              <span className="sr-only"> — every entity, regardless of the entity-kind filter</span>
            </th>
            {classes.map((lossClass) => (
              <td
                key={lossClass}
                className="px-2 py-1.5 tabular-nums"
                data-testid={`fidelity-heatmap-total-${lossClass}`}
              >
                {heatmap.classCounts[lossClass].toLocaleString()}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/** One populated matrix cell: count + heat glyphs + heat word + score, as a button. */
function HeatmapCellButton({
  cell,
  maxScore,
  scoped,
  onSelect,
}: {
  cell: FidelityHeatmapCell;
  maxScore: number;
  scoped: boolean;
  onSelect: () => void;
}) {
  const level = heatmapIntensity(cell.score, maxScore);
  const heat = intensityPresentation(level);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={scoped}
      aria-label={cellAriaLabel(cell, level)}
      data-testid={`fidelity-heatmap-cell-${cell.key}`}
      data-heat={level}
      className="xstd-heat__cell"
    >
      <span className="flex items-baseline gap-1.5">
        <span className="xstd-heat__count">{cell.count}</span>
        <span aria-hidden className="xstd-heat__glyph">
          {heat.glyph}
        </span>
      </span>
      <span aria-hidden className="xstd-heat__level">
        {heat.label} · score {cell.score}
      </span>
    </button>
  );
}

/**
 * The ranked findings — the ordered answer to "what should I look at first". Grouped by
 * loss class (the default) or printed as one ranking; either way every item carries its
 * unfiltered rank and its own score, so the ordering is inspectable rather than asserted.
 */
function RankedFindings({
  findings,
  totalLossy,
  grouping,
  scopedCell,
  onClearScope,
  selectedEntityKey,
  onSelectEntity,
  onShowMore,
}: {
  findings: RankedFinding[];
  totalLossy: number;
  grouping: RankedGrouping;
  scopedCell: FidelityHeatmapCell | null;
  onClearScope: () => void;
  selectedEntityKey: string | null;
  onSelectEntity: (entity: ExportManifestEntity) => void;
  onShowMore: () => void;
}) {
  const groups = useMemo(() => {
    if (grouping === 'rank') {
      return [{ key: 'rank' as FidelityLossClass | 'rank', label: null as string | null, findings }];
    }
    const byClass = new Map<FidelityLossClass, RankedFinding[]>();
    for (const finding of findings) {
      const bucket = byClass.get(finding.lossClass) ?? [];
      bucket.push(finding);
      byClass.set(finding.lossClass, bucket);
    }
    // Groups read in the loss classes' own display order (worst class first), so the
    // grouped view is deterministic rather than dependent on which finding scored highest.
    return FIDELITY_LOSS_CLASSES.filter((spec) => (byClass.get(spec.key)?.length ?? 0) > 0).map(
      (spec) => ({
        key: spec.key as FidelityLossClass | 'rank',
        label: spec.label as string | null,
        findings: byClass.get(spec.key) as RankedFinding[],
      }),
    );
  }, [findings, grouping]);

  return (
    <div className="space-y-2" data-testid="fidelity-heatmap-ranked">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h5 className="xstd-caps">
          {scopedCell
            ? `${entityKindPluralLabel(scopedCell.entityKind)} ${lossClassSpec(scopedCell.lossClass).label.toLowerCase()}`
            : 'Every loss, worst first'}
        </h5>
        {scopedCell && (
          <button
            type="button"
            onClick={onClearScope}
            data-testid="fidelity-heatmap-clear-scope"
            className="xstd-link text-2xs"
          >
            Show every loss
          </button>
        )}
      </div>

      {totalLossy === 0 ? (
        <p
          className="xstd-notice" data-tone="ok"
          data-testid="fidelity-heatmap-no-loss"
        >
          Nothing was lost in this selection — every entity here is preserved.
        </p>
      ) : (
        <>
          {groups.map((group) => (
            <div key={group.key} data-testid={`fidelity-heatmap-group-body-${group.key}`}>
              {group.label && (
                <div className="xstd-caps mt-1">
                  {group.label} ({group.findings.length})
                </div>
              )}
              <ol className="xstd-rank mt-1">
                {group.findings.map((finding) => (
                  <RankedFindingRow
                    key={finding.row.id}
                    finding={finding}
                    selected={finding.row.entity.key === selectedEntityKey}
                    onSelect={() => onSelectEntity(finding.row.entity)}
                  />
                ))}
              </ol>
            </div>
          ))}
          {findings.length < totalLossy && (
            <div className="flex flex-wrap items-center gap-2">
              <p className="xstd-note" data-testid="fidelity-heatmap-more-note">
                Showing the {findings.length.toLocaleString()} worst of{' '}
                {totalLossy.toLocaleString()} losses.
              </p>
              <Button variant="outline" size="sm" data-testid="fidelity-heatmap-show-more" onClick={onShowMore}>
                Show more
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** One ranked finding: rank, score, outcome, construct, kind, and the reason summary. */
function RankedFindingRow({
  finding,
  selected,
  onSelect,
}: {
  finding: RankedFinding;
  selected: boolean;
  onSelect: () => void;
}) {
  const row: ExportMappingRow = finding.row;
  const status = statusPresentation(row.status);
  return (
    <li
      className="xstd-rank__row"
      data-selected={selected || undefined}
      data-testid={`fidelity-heatmap-finding-${row.id}`}
    >
      <span
        className="xstd-rank__position"
        data-testid={`fidelity-heatmap-rank-${row.id}`}
      >
        #{finding.rank}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <Badge variant={status.tone}>
            <span aria-hidden>{status.symbol} </span>
            {status.label}
          </Badge>
          {row.severity !== 'info' && (
            <Badge variant={advisorySeverityTone(row.severity)} className="uppercase">
              {row.severity}
            </Badge>
          )}
          <button
            type="button"
            onClick={onSelect}
            aria-pressed={selected}
            data-testid={`fidelity-heatmap-select-${row.id}`}
            className="xstd-rank__construct"
          >
            {row.construct}
          </button>
          <span className="xstd-note">
            {entityKindLabel(row.entityKind).toLowerCase()} · weight {finding.constructWeight} ·
            score {finding.score}
          </span>
        </span>
        <span className="xstd-note mt-0.5 block truncate">
          {row.reason ? <span className="font-mono">{row.reason}</span> : null}
          {row.reason ? ' — ' : ''}
          {row.reasonSummary}
        </span>
      </span>
    </li>
  );
}

/**
 * The documented weighting (IXH-4.3 AC 1), printed from the very tables
 * {@link findingScore} multiplies — so what the panel claims and what it computes are one
 * source. Collapsed by default: it explains the order, it is not the order.
 */
/** A weighting line's label as a test-stable slug (`Not applicable` → `not-applicable`). */
function weightSlug(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function WeightingDisclosure() {
  const lines = weightingLines();
  const axes = ['Construct', 'Severity', 'Outcome'];
  return (
    <details className="xstd-weighting" data-testid="fidelity-heatmap-weighting">
      <summary className="xstd-weighting__summary">
        How this ranking works
      </summary>
      <p className="xstd-note mt-1.5">
        Every finding scores <strong>construct × severity × outcome</strong>. A dropped
        operation therefore outranks a hundred dropped descriptions, and anything preserved
        scores zero. A cell&apos;s heat is the sum of its findings&apos; scores, relative to
        the hottest cell in the same view.
      </p>
      <dl className="mt-1.5 grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-3">
        {axes.map((axis) => (
          <div key={axis}>
            <dt className="xstd-caps">
              {axis}
            </dt>
            {lines
              .filter((line) => line.axis === axis)
              .map((line) => (
                <dd
                  key={`${axis}-${line.label}`}
                  className="xstd-note"
                  data-testid={`fidelity-heatmap-weight-${weightSlug(line.label)}`}
                >
                  {line.label} × {line.weight}
                </dd>
              ))}
          </div>
        ))}
      </dl>
    </details>
  );
}

export default FidelityLossHeatmapPanel;
