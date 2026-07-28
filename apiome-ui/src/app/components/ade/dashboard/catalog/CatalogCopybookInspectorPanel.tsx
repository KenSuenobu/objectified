'use client';

/**
 * `<CatalogCopybookInspectorPanel>` (CPDO-2.3, #4799) — the COBOL copybook layout inspector,
 * mounted inside the Format details tab.
 *
 * A copybook is a *positional* description, and the position is exactly what a normalized field
 * list cannot hold. `PIC S9(9)V99 COMP-3` says six bytes, packed, and the field after it starts six
 * bytes further into the record; `REDEFINES` says two items describe the *same* bytes; `OCCURS 1 TO
 * 10 DEPENDING ON` says the record has no single length at all. None of that survives normalization,
 * and none of it is legible as generic key/value pairs on a tree row.
 *
 * This panel renders it as the layout it is:
 *
 *  - the **record**, with its byte length — or its length *range*, when a variable table makes it
 *    one — and how many of its items could actually be sized;
 *  - a **storage map**: every group and elementary item in declaration order, indented by level,
 *    with its PICTURE, USAGE, byte span and derivation;
 *  - **REDEFINES overlays**, grouped by the storage they share rather than listed as siblings,
 *    which is the direction the question is actually asked in;
 *  - **tables** with their occurrence bounds and their ODO controller, and whether that controller
 *    is declared in this copybook at all;
 *  - the **assumptions** every computed byte count rests on, read from the record's own warning so
 *    the screen cannot drift from the arithmetic.
 *
 * **It guesses nothing.** An item with no computed length shows no length; an item after a variable
 * table shows no offset and says why; an item whose name matches no parsed entity offers no link to
 * one. Every rule lives in `catalog-copybook-analysis.ts`, so the panel is a renderer.
 */

import * as React from 'react';
import { AlertTriangle, Braces, Layers, Ruler, ScrollText, Table2 } from 'lucide-react';
import { cn } from '@lib/utils';
import {
  copybookAssumptions,
  copybookBasisLabel,
  copybookCanonicalTarget,
  copybookOverlays,
  copybookParentNames,
  copybookRecordSummary,
  copybookStorageMap,
  copybookTables,
  isCopybookAnalysis,
  type CopybookStorageRow,
} from '@/app/utils/catalog-copybook-analysis';
import type { AnalysisDocument } from '@/app/utils/catalog-payload-analysis';

export interface CatalogCopybookInspectorPanelProps {
  /** The loaded analysis record's document. */
  document: AnalysisDocument;
  /** The catalog item's raw `sourceFormat`, used only when the record names no analyzer. */
  sourceFormat?: string | null;
  /** Reveal one item in the structure tree (selects and focuses its row). */
  onRevealNode?: (nodeId: string) => void;
  /**
   * Follow an item to the canonical entity it normalized into, on the Overview tab. Offered only
   * for an item whose name actually matches a parsed entity.
   */
  onRevealEntity?: (entityName: string) => void;
  /** The parsed-entity names the Overview renders, so a link is only offered when it can be honoured. */
  entityNames?: readonly string[];
  className?: string;
}

/** Badge tone classes. Text always carries the meaning; colour only reinforces it. */
const TONE: Record<'positive' | 'caution' | 'neutral', string> = {
  positive:
    'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800/60 dark:bg-emerald-950/30 dark:text-emerald-300',
  caution:
    'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/30 dark:text-amber-300',
  neutral:
    'border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-700 dark:bg-gray-900/40 dark:text-gray-300',
};

const BADGE_BASE =
  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium';

const SECTION_HEADING =
  'text-[10px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400';

const CELL = 'px-2 py-1.5 text-left align-top';

/** Row indentation per copybook nesting level; a CSS variable keeps the depth out of the markup. */
const DEPTH_INDENT = 'pl-[calc(0.5rem+(var(--copybook-depth)-1)*0.875rem)]';

/** A labelled badge whose `label` is read by assistive tech and whose `value` is visible. */
function Badge({
  label,
  value,
  tone = 'neutral',
  testId,
}: {
  label: string;
  value: string;
  tone?: 'positive' | 'caution' | 'neutral';
  testId?: string;
}) {
  return (
    <span data-testid={testId} className={cn(BADGE_BASE, TONE[tone])}>
      <span className="sr-only">{label}: </span>
      {value}
    </span>
  );
}

/** A byte span, or the stated reason there isn't one. */
function ByteSpan({ row }: { row: CopybookStorageRow }) {
  const { storage } = row;
  if (storage.offset !== null) {
    return (
      <span className="font-mono tabular-nums text-gray-700 dark:text-gray-300">
        {storage.offset}
        {storage.endOffset !== null && storage.endOffset !== storage.offset
          ? `–${storage.endOffset}`
          : ''}
      </span>
    );
  }
  return (
    <span
      data-testid="copybook-offset-absent"
      data-variable={storage.offsetVariable}
      className="italic text-amber-700 dark:text-amber-300"
    >
      {storage.offsetVariable ? 'varies' : 'not computed'}
    </span>
  );
}

/**
 * Render the copybook layout inspector.
 *
 * @param props See {@link CatalogCopybookInspectorPanelProps}.
 * @returns The panel, or null when the record is not a copybook analysis or carries no level-01
 *   record — no record, no inspector.
 */
export function CatalogCopybookInspectorPanel({
  document,
  sourceFormat,
  onRevealNode,
  onRevealEntity,
  entityNames = [],
  className,
}: CatalogCopybookInspectorPanelProps) {
  const applies = isCopybookAnalysis(document, sourceFormat);
  const tree = React.useMemo(() => document.tree ?? [], [document.tree]);

  const record = React.useMemo(
    () => (applies ? copybookRecordSummary(tree) : null),
    [applies, tree],
  );
  const rows = React.useMemo(() => (applies ? copybookStorageMap(tree) : []), [applies, tree]);
  const overlays = React.useMemo(() => (applies ? copybookOverlays(tree) : []), [applies, tree]);
  const tables = React.useMemo(() => (applies ? copybookTables(tree) : []), [applies, tree]);
  const assumptions = React.useMemo(
    () => (applies ? copybookAssumptions(document) : []),
    [applies, document],
  );
  const parents = React.useMemo(() => (applies ? copybookParentNames(tree) : new Map()), [
    applies,
    tree,
  ]);
  const entities = React.useMemo(() => new Set(entityNames), [entityNames]);

  if (!applies || !record) return null;

  return (
    <section
      data-testid="catalog-copybook-inspector"
      aria-labelledby="catalog-copybook-inspector-heading"
      className={cn(
        'rounded-lg border border-gray-200 bg-white p-3 dark:border-gray-700 dark:bg-gray-800',
        className,
      )}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3
          id="catalog-copybook-inspector-heading"
          className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100"
        >
          <Layers className="h-4 w-4 text-indigo-500" aria-hidden />
          Record layout
          <span className="font-mono text-xs text-gray-500 dark:text-gray-400">{record.name}</span>
        </h3>
        <div className="flex flex-wrap items-center gap-1.5">
          {record.maxLength !== null ? (
            <Badge
              label="Record length"
              value={
                record.variable && record.minLength !== null && record.minLength !== record.maxLength
                  ? `${record.minLength}–${record.maxLength} bytes`
                  : `${record.maxLength} bytes`
              }
              tone={record.variable ? 'caution' : 'positive'}
              testId="copybook-record-length"
            />
          ) : (
            <Badge
              label="Record length"
              value="length not computed"
              tone="caution"
              testId="copybook-record-length"
            />
          )}
          <Badge
            label="Items sized"
            value={`${record.sizedItemCount} of ${record.itemCount} items sized`}
            tone={record.sizedItemCount === record.itemCount ? 'positive' : 'caution'}
            testId="copybook-sized-count"
          />
        </div>
      </div>

      <p
        data-testid="copybook-record-statement"
        className="mt-2 text-xs leading-snug text-gray-600 dark:text-gray-300"
      >
        {record.statement}
      </p>

      {/* The storage map — every item, in declaration order, with the bytes it occupies. */}
      <section aria-labelledby="catalog-copybook-map-heading" className="mt-3">
        <h4
          id="catalog-copybook-map-heading"
          className={cn(SECTION_HEADING, 'flex items-center gap-1.5')}
        >
          <Ruler className="h-3 w-3" aria-hidden />
          Storage map
        </h4>
        <div className="mt-1.5 overflow-x-auto">
          <table className="w-full min-w-[40rem] border-collapse text-[11px]">
            <caption className="sr-only">
              Every item in {record.name}, in declaration order, with the bytes it occupies
            </caption>
            <thead>
              <tr className="border-b border-gray-200 text-gray-500 dark:border-gray-700 dark:text-gray-400">
                <th scope="col" className={cn(CELL, SECTION_HEADING)}>
                  Item
                </th>
                <th scope="col" className={cn(CELL, SECTION_HEADING)}>
                  Picture
                </th>
                <th scope="col" className={cn(CELL, SECTION_HEADING)}>
                  Bytes
                </th>
                <th scope="col" className={cn(CELL, SECTION_HEADING)}>
                  Length
                </th>
                <th scope="col" className={cn(CELL, SECTION_HEADING)}>
                  Notes
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700/60">
              {rows.map((row) => {
                const target = copybookCanonicalTarget(
                  row,
                  parents.get(row.node.id) ?? null,
                  entities,
                );
                return (
                  <tr
                    key={row.node.id}
                    data-testid="copybook-storage-row"
                    data-node-id={row.node.id}
                    data-depth={row.depth}
                  >
                    <th
                      scope="row"
                      style={{ '--copybook-depth': row.depth } as React.CSSProperties}
                      className={cn(CELL, DEPTH_INDENT, 'font-normal')}
                    >
                      <span className="mr-1.5 font-mono text-[10px] text-gray-400 dark:text-gray-500">
                        {row.level ?? '—'}
                      </span>
                      {onRevealNode ? (
                        <button
                          type="button"
                          data-testid="copybook-item-reveal"
                          onClick={() => onRevealNode(row.node.id)}
                          className="rounded font-mono font-semibold text-indigo-700 underline decoration-dotted underline-offset-2 hover:decoration-solid focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-indigo-300"
                        >
                          {row.name}
                          <span className="sr-only"> — show this item in the structure tree</span>
                        </button>
                      ) : (
                        <span className="font-mono font-semibold text-gray-900 dark:text-white">
                          {row.name}
                        </span>
                      )}
                    </th>
                    <td className={cn(CELL, 'font-mono text-gray-700 dark:text-gray-300')}>
                      {row.picture ?? (
                        <span className="italic text-gray-400 dark:text-gray-500">group</span>
                      )}
                      {row.usage ? (
                        <span className="ml-1 text-[10px] text-gray-500 dark:text-gray-400">
                          {row.usage}
                        </span>
                      ) : null}
                    </td>
                    <td className={CELL}>
                      <ByteSpan row={row} />
                    </td>
                    <td className={cn(CELL, 'font-mono tabular-nums text-gray-700 dark:text-gray-300')}>
                      {row.storage.totalLength === null ? (
                        <span className="italic text-amber-700 dark:text-amber-300">unknown</span>
                      ) : row.storage.minTotalLength !== null &&
                        row.storage.minTotalLength !== row.storage.totalLength ? (
                        `${row.storage.minTotalLength}–${row.storage.totalLength}`
                      ) : (
                        row.storage.totalLength
                      )}
                    </td>
                    <td className={CELL}>
                      <div className="flex flex-wrap items-center gap-1">
                        {row.storage.basis ? (
                          <span
                            title={copybookBasisLabel(row.storage.basis)}
                            className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-600 dark:bg-gray-700/60 dark:text-gray-300"
                          >
                            {row.storage.basis}
                          </span>
                        ) : null}
                        {row.storage.signed ? (
                          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600 dark:bg-gray-700/60 dark:text-gray-300">
                            signed
                          </span>
                        ) : null}
                        {row.storage.decimals !== null ? (
                          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600 dark:bg-gray-700/60 dark:text-gray-300">
                            {row.storage.decimals} dp
                          </span>
                        ) : null}
                        {row.occursMax !== null ? (
                          <span
                            data-testid="copybook-occurs"
                            className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium text-sky-800 dark:bg-sky-900/40 dark:text-sky-300"
                          >
                            OCCURS {row.occursMin ?? row.occursMax}
                            {row.occursMin !== null && row.occursMin !== row.occursMax
                              ? `–${row.occursMax}`
                              : ''}
                          </span>
                        ) : null}
                        {row.storage.redefines ? (
                          <span
                            data-testid="copybook-redefines"
                            className="rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 dark:bg-violet-900/40 dark:text-violet-300"
                          >
                            redefines {row.storage.redefines}
                          </span>
                        ) : null}
                        {row.conditions.length > 0 ? (
                          <span
                            data-testid="copybook-conditions"
                            title={row.conditions
                              .map((entry) => `${entry.name}${entry.value ? ` = ${entry.value}` : ''}`)
                              .join(', ')}
                            className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600 dark:bg-gray-700/60 dark:text-gray-300"
                          >
                            {row.conditions.length} condition
                            {row.conditions.length === 1 ? '' : 's'}
                          </span>
                        ) : null}
                        {target && onRevealEntity ? (
                          <button
                            type="button"
                            data-testid="copybook-canonical-link"
                            data-entity={target.entity}
                            onClick={() => onRevealEntity(target.entity)}
                            className="rounded text-[10px] font-medium text-indigo-700 underline decoration-dotted underline-offset-2 hover:decoration-solid focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-indigo-300"
                          >
                            {target.field ? `field on ${target.entity}` : 'parsed entity'}
                            <span className="sr-only">
                              {' '}
                              — show {target.entity} in the parsed model
                            </span>
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* REDEFINES, grouped by the storage the items share. */}
      {overlays.length > 0 ? (
        <section aria-labelledby="catalog-copybook-overlays-heading" className="mt-3">
          <h4
            id="catalog-copybook-overlays-heading"
            className={cn(SECTION_HEADING, 'flex items-center gap-1.5')}
          >
            <Braces className="h-3 w-3" aria-hidden />
            Shared storage (REDEFINES)
          </h4>
          <ul data-testid="copybook-overlays" className="mt-1.5 space-y-2">
            {overlays.map((overlay) => (
              <li
                key={overlay.base.id}
                data-testid="copybook-overlay"
                className="rounded-lg border border-gray-200 p-2.5 dark:border-gray-700"
              >
                <p className="text-[11px] text-gray-700 dark:text-gray-300">
                  <span className="font-mono font-semibold">{overlay.baseName}</span>
                  {overlay.offset !== null && overlay.baseLength !== null ? (
                    <>
                      {' '}
                      occupies bytes{' '}
                      <span className="font-mono tabular-nums">
                        {overlay.offset}–{overlay.offset + overlay.baseLength - 1}
                      </span>
                      , and the same bytes are described again by:
                    </>
                  ) : (
                    <> is described again by:</>
                  )}
                </p>
                <ul className="mt-1 flex flex-wrap gap-1.5">
                  {overlay.overlays.map((entry) => (
                    <li key={entry.node.id}>
                      <Badge
                        label="Redefining item"
                        value={
                          entry.length === null
                            ? `${entry.name} (length unknown)`
                            : entry.oversized
                              ? `${entry.name} — needs ${entry.length} bytes`
                              : `${entry.name} — ${entry.length} bytes`
                        }
                        tone={entry.oversized ? 'caution' : 'neutral'}
                        testId={entry.oversized ? 'copybook-overlay-oversized' : 'copybook-overlay-item'}
                      />
                    </li>
                  ))}
                </ul>
                {overlay.overlays.some((entry) => entry.oversized) ? (
                  <p className="mt-1.5 flex items-start gap-1.5 text-[11px] text-amber-800 dark:text-amber-300">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                    <span>
                      A redefining item needs more storage than the item it redefines. Both lengths
                      are shown as computed; neither is adjusted to fit.
                    </span>
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Tables and their controllers. */}
      {tables.length > 0 ? (
        <section aria-labelledby="catalog-copybook-tables-heading" className="mt-3">
          <h4
            id="catalog-copybook-tables-heading"
            className={cn(SECTION_HEADING, 'flex items-center gap-1.5')}
          >
            <Table2 className="h-3 w-3" aria-hidden />
            Tables
          </h4>
          <ul data-testid="copybook-tables" className="mt-1.5 space-y-1.5">
            {tables.map((table) => (
              <li
                key={table.node.id}
                data-testid="copybook-table"
                data-variable={table.variable}
                className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[11px] text-gray-700 dark:text-gray-300"
              >
                <span className="font-mono font-semibold">{table.name}</span>
                <Badge
                  label="Occurrences"
                  value={
                    table.variable
                      ? `${table.occursMin}–${table.occursMax} occurrences`
                      : `${table.occursMax} occurrences, fixed`
                  }
                  tone={table.variable ? 'caution' : 'neutral'}
                />
                {table.dependingOn ? (
                  <>
                    <span className="text-gray-500 dark:text-gray-400">controlled by</span>
                    <span className="font-mono">{table.dependingOn}</span>
                    {table.controllerResolved ? null : (
                      <span
                        data-testid="copybook-controller-unresolved"
                        className="text-amber-800 dark:text-amber-300"
                      >
                        — not declared in this copybook; it may be declared in a surrounding one
                      </span>
                    )}
                  </>
                ) : table.variable ? (
                  <span className="text-gray-500 dark:text-gray-400">
                    with no DEPENDING ON controller recorded
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* The assumptions behind every byte count on this screen. */}
      <section aria-labelledby="catalog-copybook-assumptions-heading" className="mt-3">
        <h4
          id="catalog-copybook-assumptions-heading"
          className={cn(SECTION_HEADING, 'flex items-center gap-1.5')}
        >
          <ScrollText className="h-3 w-3" aria-hidden />
          What these byte counts assume
        </h4>
        {assumptions.length > 0 ? (
          <ul
            data-testid="copybook-assumptions"
            className="mt-1.5 list-disc space-y-1 rounded-lg border border-indigo-100 bg-indigo-50/60 py-2 pl-7 pr-3 text-[11px] leading-snug text-indigo-800 dark:border-indigo-900/50 dark:bg-indigo-950/30 dark:text-indigo-300"
          >
            {assumptions.map((assumption) => (
              <li key={assumption}>{assumption}</li>
            ))}
          </ul>
        ) : (
          <p
            data-testid="copybook-assumptions-absent"
            className="mt-1.5 text-[11px] text-gray-500 dark:text-gray-400"
          >
            This analysis did not record the assumptions behind its byte counts, so none are shown
            here. Treat the lengths above as computed rather than observed.
          </p>
        )}
      </section>
    </section>
  );
}

export default CatalogCopybookInspectorPanel;
