/**
 * Draw-budget selection + table flattening (IXH-3.6, #5108) — the pure machinery that
 * bounds the projection map (`importProjectionGraph.ts`).
 *
 * Pins the two guarantees the component leans on:
 *  1. `selectDrawnGraphEntries` — the cap only ever removes the cleanest evidence: dropped
 *     and non-info rows (and aggregates, each one box for many rows) always survive, the
 *     survivors keep the view's order, and the represented-row counts are truthful.
 *  2. `buildProjectionTableRows` — the flat display-row list the windowed table renders
 *     keeps every entry, interleaves expanded aggregate members in place, and numbers
 *     `bodyRowIndex` contiguously (the `aria-rowindex` source of truth).
 */

import { describe, expect, it } from '@jest/globals';

import {
  buildImportProjectionView,
  buildProjectionTableRows,
  selectDrawnGraphEntries,
  type ImportEvidenceRow,
} from '../src/app/components/ade/dashboard/catalog/importProjectionGraph';
import type { ProjectionStatus } from '../src/app/components/ade/dashboard/export/exportFidelityPreview';
import type { LossinessSeverity } from '../src/app/components/ade/dashboard/export/exportFidelityPreview';

/** One synthetic evidence row; ids sort by their zero-padded index so orders are stable. */
function row(
  index: number,
  status: ProjectionStatus,
  severity: LossinessSeverity = 'info',
  kind: string | null = 'type',
): ImportEvidenceRow {
  const id = `row:${String(index).padStart(5, '0')}`;
  return {
    id,
    construct: `construct-${String(index).padStart(5, '0')}`,
    constructKey: id,
    canonicalKind: kind,
    status,
    severity,
    reason: status === 'retained' ? null : 'destination_unsupported',
    reasonSummary: `${status} summary ${index}`,
    targetLabel: null,
    targetLocation: null,
    sourceLabel: `native-${index}`,
    sourceLocation: null,
    edge: {
      id,
      relation: 'projects',
      source: `native:${id}`,
      target: `canonical:${id}`,
      status,
      reason: null,
      severity,
      detail: `${status} detail ${index}`,
    },
    coverage: status === 'approximated' ? 'partially-mapped' : 'mapped',
    ledger: null,
    adapterDeclared: false,
  };
}

describe('selectDrawnGraphEntries — worst-first draw budget', () => {
  it('draws everything untruncated when the view fits the budget', () => {
    const view = buildImportProjectionView([row(1, 'retained'), row(2, 'dropped')], 100);
    const selection = selectDrawnGraphEntries(view.entries, 10);
    expect(selection.truncated).toBe(false);
    expect(selection.drawn).toEqual(view.entries);
    expect(selection.drawnRowCount).toBe(2);
    expect(selection.totalRowCount).toBe(2);
  });

  it('keeps every dropped and non-info entry when the cap removes clean rows', () => {
    // 30 clean + 10 dropped + 5 warn-approximated, aggregation off (high threshold) so all
    // 45 are individual entries; a budget of 20 must cut only the clean ones.
    const rows = [
      ...Array.from({ length: 30 }, (_, i) => row(i, 'retained')),
      ...Array.from({ length: 10 }, (_, i) => row(100 + i, 'dropped')),
      ...Array.from({ length: 5 }, (_, i) => row(200 + i, 'approximated', 'warn')),
    ];
    const view = buildImportProjectionView(rows, 1000);
    expect(view.entries).toHaveLength(45);

    const selection = selectDrawnGraphEntries(view.entries, 20);
    expect(selection.truncated).toBe(true);
    expect(selection.drawn).toHaveLength(20);
    const drawnStatuses = selection.drawn.map((entry) => entry.status);
    expect(drawnStatuses.filter((status) => status === 'dropped')).toHaveLength(10);
    expect(drawnStatuses.filter((status) => status === 'approximated')).toHaveLength(5);
    expect(selection.drawnRowCount).toBe(20);
    expect(selection.totalRowCount).toBe(45);
  });

  it('preserves the view order among the survivors (lane layout unchanged)', () => {
    const rows = [
      ...Array.from({ length: 20 }, (_, i) => row(i, 'retained')),
      ...Array.from({ length: 10 }, (_, i) => row(100 + i, 'dropped')),
    ];
    const view = buildImportProjectionView(rows, 1000);
    const selection = selectDrawnGraphEntries(view.entries, 15);
    const positions = selection.drawn.map((entry) => view.entries.indexOf(entry));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('always keeps aggregates — one box standing for many rows is never the cut', () => {
    // Aggregation on (threshold 5): the 40 clean rows collapse into one aggregate; the 10
    // dropped rows stay individual. Even a budget of 3 keeps the aggregate.
    const rows = [
      ...Array.from({ length: 40 }, (_, i) => row(i, 'retained')),
      ...Array.from({ length: 10 }, (_, i) => row(100 + i, 'dropped')),
    ];
    const view = buildImportProjectionView(rows, 5);
    const selection = selectDrawnGraphEntries(view.entries, 3);
    expect(selection.drawn.some((entry) => entry.kind === 'aggregate')).toBe(true);
    // Aggregate members count toward the represented rows.
    expect(selection.totalRowCount).toBe(50);
    expect(selection.drawnRowCount).toBeGreaterThanOrEqual(40 + 2);
  });

  it('ranks severity above status: a critical approximation outranks an info drop', () => {
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => row(i, 'dropped', 'info')),
      row(100, 'approximated', 'critical'),
    ];
    const view = buildImportProjectionView(rows, 1000);
    const selection = selectDrawnGraphEntries(view.entries, 1);
    expect(selection.drawn.map((entry) => entry.severity)).toContain('critical');
  });
});

describe('buildProjectionTableRows — display-row flattening', () => {
  it('yields one row per entry with contiguous bodyRowIndex when nothing is expanded', () => {
    const view = buildImportProjectionView(
      Array.from({ length: 4 }, (_, i) => row(i, i % 2 === 0 ? 'retained' : 'dropped')),
      1000,
    );
    const tableRows = buildProjectionTableRows(view.entries, new Set());
    expect(tableRows).toHaveLength(view.entries.length);
    expect(tableRows.map((r) => r.bodyRowIndex)).toEqual([1, 2, 3, 4]);
    expect(tableRows.every((r) => r.kind === 'entry')).toBe(true);
  });

  it('interleaves an expanded aggregate’s members directly after its toggle row', () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => row(i, 'retained')),
      row(100, 'dropped'),
    ];
    const view = buildImportProjectionView(rows, 3);
    const aggregate = view.entries.find((entry) => entry.kind === 'aggregate');
    expect(aggregate).toBeDefined();

    const collapsed = buildProjectionTableRows(view.entries, new Set());
    expect(collapsed).toHaveLength(view.entries.length);

    const expanded = buildProjectionTableRows(view.entries, new Set([aggregate!.key]));
    expect(expanded).toHaveLength(view.entries.length + (aggregate!.members?.length ?? 0));
    const toggleIndex = expanded.findIndex((r) => r.kind === 'entry' && r.entry === aggregate);
    for (let i = 0; i < (aggregate!.members?.length ?? 0); i++) {
      const memberRow = expanded[toggleIndex + 1 + i];
      expect(memberRow.kind).toBe('member');
      expect(memberRow.member).toBe(aggregate!.members![i]);
    }
    // Row indexes stay contiguous through the interleave — the aria-rowindex contract.
    expect(expanded.map((r) => r.bodyRowIndex)).toEqual(
      Array.from({ length: expanded.length }, (_, i) => i + 1),
    );
    // Keys stay unique (React keys + pinning identity).
    expect(new Set(expanded.map((r) => r.key)).size).toBe(expanded.length);
  });
});
