'use client';

/**
 * `<CatalogX12InspectorPanel>` (CPDO-2.2, #4798) — the EDI X12 interchange and transaction-set
 * inspector, mounted inside the Format details tab.
 *
 * CPDO-2.1's tree is format-blind by design: it renders any analyzer's nodes as rows and any
 * analyzer's attributes as key/value pairs. For an interchange that floor leaves the reader doing
 * the work — scrolling a tree to find out how many functional groups there were, opening a node to
 * read a control number, comparing an `elementCount` against an `elementPositionCount` to notice
 * that a position was written and left empty.
 *
 * This panel reads all of it off the record at once:
 *
 *  - the **interchange envelope** — sender, receiver, control number, date/time, and the usage
 *    indicator spelled out, because "T" and "P" is the difference between a test file and a
 *    customer's real claims;
 *  - the **declared delimiters**, each with its code point, so a look-alike character is not
 *    mistaken for another and an interchange that declares no repetition separator says so;
 *  - **every functional group and every transaction set**, with the set ids, versions and
 *    convention references they declare, and the segments that repeat inside each one;
 *  - **declared versus observed control totals** (IEA01/GE01/SE01), so an interchange that
 *    disagrees with itself can be seen to;
 *  - an explicit statement of **what the conversion was derived from** — the canonical model reads
 *    one transaction set, and on every other screen that is invisible;
 *  - an explicit statement that everything here is **observed, not validated**.
 *
 * Purely presentational: every rule lives in `catalog-x12-analysis.ts`, so the panel renders a
 * derived shape and nothing here decides anything. It invents nothing either — a fact the record
 * does not carry renders as a stated absence rather than as a blank or a zero.
 */

import * as React from 'react';
import { AlertTriangle, FileWarning, Layers, Repeat, Scissors, ShieldQuestion } from 'lucide-react';
import { cn } from '@lib/utils';
import {
  isX12Analysis,
  x12ConformanceStatement,
  x12ConversionScope,
  x12Envelope,
  x12Groups,
  type X12ControlTotal,
  type X12GroupSummary,
  type X12Separator,
} from '@/app/utils/catalog-x12-analysis';
import type { AnalysisDocument } from '@/app/utils/catalog-payload-analysis';

export interface CatalogX12InspectorPanelProps {
  /** The loaded analysis record's document. */
  document: AnalysisDocument;
  /** The catalog item's raw `sourceFormat`, used only when the record names no analyzer. */
  sourceFormat?: string | null;
  /** Reveal one transaction set in the structure tree (selects and focuses its row). */
  onRevealNode?: (nodeId: string) => void;
  className?: string;
}

/** Badge tone classes. Text always carries the meaning; colour only reinforces it. */
const TONE: Record<'positive' | 'caution' | 'neutral', string> = {
  positive:
    'border-ok bg-ok-soft text-ok-fg',
  caution:
    'border-warn bg-warn-soft text-warn-fg',
  neutral:
    'border-border bg-subtle text-fg',
};

const BADGE_BASE =
  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-medium';

const SECTION_HEADING =
  'text-2xs font-medium uppercase tracking-wider text-fg-muted';

const CELL = 'px-2 py-1.5 text-left align-top';

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

/**
 * One envelope fact.
 *
 * A fact the record does not carry renders the stated absence rather than an empty cell, so a
 * reader never has to wonder whether the interchange omitted it or the screen did.
 */
function Fact({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="min-w-0">
      <dt className={SECTION_HEADING}>{label}</dt>
      <dd
        className={cn(
          'mt-0.5 break-words font-mono text-2xs',
          value === null
            ? 'italic text-fg-muted'
            : 'text-fg',
        )}
      >
        {value ?? 'not recorded'}
      </dd>
    </div>
  );
}

/**
 * One declared-versus-observed control total.
 *
 * A missing declaration is rendered as missing rather than as agreement: an interchange truncated
 * before its trailer has nothing to agree with, and showing a tick there would be an invention.
 */
function ControlTotal({ total }: { total: X12ControlTotal }) {
  return (
    <div
      data-testid="x12-control-total"
      data-mismatched={total.mismatched}
      className="cid-inset min-w-0 px-2.5 py-2"
    >
      <dt className={SECTION_HEADING}>{total.label}</dt>
      <dd className="mt-1 flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-sm font-semibold tabular-nums text-fg">
          {total.observed.toLocaleString()}
        </span>
        <span className="text-2xs text-fg-muted">observed</span>
        {total.declared === null ? (
          <span className="text-2xs italic text-fg-muted">
            · {total.declaredBy} declared nothing readable
          </span>
        ) : (
          <Badge
            label={`${total.declaredBy} declared`}
            value={
              total.mismatched
                ? `${total.declaredBy} declared ${total.declared.toLocaleString()}`
                : `matches ${total.declaredBy}`
            }
            tone={total.mismatched ? 'caution' : 'positive'}
          />
        )}
      </dd>
    </div>
  );
}

/** One declared delimiter, with the code point so an invisible character is still identifiable. */
function Separator({ separator }: { separator: X12Separator }) {
  return (
    <div className="min-w-0">
      <dt className={SECTION_HEADING}>{separator.label}</dt>
      <dd className="mt-0.5 flex flex-wrap items-baseline gap-1.5">
        {separator.character === null ? (
          <span
            data-testid="x12-separator-absent"
            className="text-2xs italic leading-snug text-fg-muted"
          >
            {separator.absence}
          </span>
        ) : (
          <>
            <code className="rounded bg-subtle px-1.5 py-0.5 font-mono text-xs text-fg">
              {separator.character}
            </code>
            <span className="font-mono text-2xs text-fg-muted">
              {separator.codePoint}
            </span>
          </>
        )}
      </dd>
    </div>
  );
}

/** One functional group and the transaction sets under it. */
function Group({
  group,
  index,
  onRevealNode,
}: {
  group: X12GroupSummary;
  index: number;
  onRevealNode?: (nodeId: string) => void;
}) {
  return (
    <li
      data-testid="x12-functional-group"
      data-group-id={group.node.id}
      className="rounded-lg border border-border p-3"
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h4 className="text-xs font-semibold text-fg">
          <span className="text-fg-muted">Functional group {index + 1} · </span>
          <span className="font-mono">{group.functionalId ?? 'unnamed'}</span>
        </h4>
        {group.version ? (
          <Badge label="Group version" value={`version ${group.version}`} />
        ) : null}
        {group.controlNumber ? (
          <Badge label="Group control number" value={`GS06 ${group.controlNumber}`} />
        ) : null}
        {group.responsibleAgencyCode ? (
          <Badge label="Responsible agency code" value={`agency ${group.responsibleAgencyCode}`} />
        ) : null}
      </div>

      <dl className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Fact label="Sender" value={group.sender} />
        <Fact label="Receiver" value={group.receiver} />
        <Fact label="Date" value={group.date} />
        <Fact label="Time" value={group.time} />
      </dl>

      <dl className="mt-2">
        <ControlTotal total={group.transactionTotal} />
      </dl>

      {group.transactions.length === 0 ? (
        <p
          data-testid="x12-group-no-transactions"
          className="mt-2 text-2xs text-fg-muted"
        >
          No transaction set is recorded under this group. The analyzer&apos;s node budget bounds
          leaves before envelopes, so this means the record has none — not that the source had none.
        </p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[34rem] border-collapse text-2xs">
            <caption className="sr-only">
              Transaction sets in functional group {group.functionalId ?? index + 1}
            </caption>
            <thead>
              <tr className="border-b border-border text-fg-muted">
                <th scope="col" className={cn(CELL, SECTION_HEADING)}>
                  Set
                </th>
                <th scope="col" className={cn(CELL, SECTION_HEADING)}>
                  Control number
                </th>
                <th scope="col" className={cn(CELL, SECTION_HEADING)}>
                  Convention (ST03)
                </th>
                <th scope="col" className={cn(CELL, SECTION_HEADING)}>
                  Segments
                </th>
                <th scope="col" className={cn(CELL, SECTION_HEADING)}>
                  Repeated segments
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {group.transactions.map((transaction) => (
                <tr
                  key={transaction.node.id}
                  data-testid="x12-transaction-set"
                  data-node-id={transaction.node.id}
                  data-converted={transaction.converted}
                >
                  <th scope="row" className={cn(CELL, 'font-mono font-semibold text-fg')}>
                    {onRevealNode ? (
                      <button
                        type="button"
                        data-testid="x12-transaction-reveal"
                        onClick={() => onRevealNode(transaction.node.id)}
                        className="rounded text-accent-fg underline decoration-dotted underline-offset-2 hover:decoration-solid focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                      >
                        {transaction.setId ?? 'unnamed'}
                        <span className="sr-only"> — show this transaction set in the structure tree</span>
                      </button>
                    ) : (
                      (transaction.setId ?? 'unnamed')
                    )}
                    {transaction.converted ? (
                      <span className="ml-1.5 inline-block align-middle">
                        <Badge
                          label="Conversion source"
                          value="converted"
                          tone="positive"
                          testId="x12-converted-set"
                        />
                      </span>
                    ) : null}
                  </th>
                  <td className={cn(CELL, 'font-mono text-fg')}>
                    {transaction.controlNumber ?? '—'}
                  </td>
                  <td className={cn(CELL, 'font-mono text-fg')}>
                    {transaction.implementationConvention ?? (
                      <span className="italic text-fg-muted">none declared</span>
                    )}
                  </td>
                  <td className={CELL}>
                    <span className="font-mono tabular-nums text-fg">
                      {transaction.segmentTotal.observed.toLocaleString()}
                    </span>
                    {transaction.segmentTotal.declared === null ? null : transaction.segmentTotal
                        .mismatched ? (
                      <span className="ml-1.5 inline-block align-middle">
                        <Badge
                          label="SE01 declared"
                          value={`SE01 says ${transaction.segmentTotal.declared.toLocaleString()}`}
                          tone="caution"
                          testId="x12-segment-total-mismatch"
                        />
                      </span>
                    ) : (
                      <span className="ml-1 text-2xs text-fg-muted">
                        matches SE01
                      </span>
                    )}
                  </td>
                  <td className={CELL}>
                    {transaction.repeatedSegments.length === 0 ? (
                      <span className="italic text-fg-muted">none</span>
                    ) : (
                      <ul className="flex flex-wrap gap-1">
                        {transaction.repeatedSegments.map((repeat) => (
                          <li
                            key={repeat.segmentId}
                            data-testid="x12-repeated-segment"
                            className="inline-flex items-center gap-1 rounded bg-subtle px-1.5 py-0.5 font-mono text-2xs text-fg"
                          >
                            {repeat.segmentId}
                            <span className="tabular-nums font-semibold">×{repeat.count}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </li>
  );
}

/**
 * Render the X12 inspector.
 *
 * @param props See {@link CatalogX12InspectorPanelProps}.
 * @returns The panel, or null when the record is not an X12 analysis or carries no interchange —
 *   no record, no inspector.
 */
export function CatalogX12InspectorPanel({
  document,
  sourceFormat,
  onRevealNode,
  className,
}: CatalogX12InspectorPanelProps) {
  const applies = isX12Analysis(document, sourceFormat);
  const envelope = React.useMemo(
    () => (applies ? x12Envelope(document.tree ?? []) : null),
    [applies, document.tree],
  );
  const groups = React.useMemo(
    () => (applies ? x12Groups(document.tree ?? []) : []),
    [applies, document.tree],
  );
  const scope = React.useMemo(() => x12ConversionScope(groups), [groups]);

  if (!applies || !envelope) return null;

  return (
    <section
      data-testid="catalog-x12-inspector"
      aria-labelledby="catalog-x12-inspector-heading"
      className={cn(
        'rounded-lg border border-border bg-surface p-3',
        className,
      )}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3
          id="catalog-x12-inspector-heading"
          className="flex items-center gap-2 text-sm font-semibold text-fg"
        >
          <Layers className="h-4 w-4 text-accent" aria-hidden />
          Interchange
          {envelope.controlNumber ? (
            <span className="font-mono text-xs text-fg-muted">
              {envelope.controlNumber}
            </span>
          ) : null}
        </h3>
        <div className="flex flex-wrap items-center gap-1.5">
          {envelope.version ? (
            <Badge label="Interchange control version" value={`ISA12 ${envelope.version}`} />
          ) : null}
          {envelope.usageLabel ? (
            <Badge
              label="Usage indicator"
              value={
                envelope.usageIndicator
                  ? `${envelope.usageLabel} (${envelope.usageIndicator})`
                  : envelope.usageLabel
              }
              tone={envelope.isProduction ? 'positive' : 'caution'}
              testId="x12-usage-indicator"
            />
          ) : null}
        </div>
      </div>

      {/* Envelope identity. Structure only — every observed element value stays in the tree, where
          the value-visibility policy governs it. */}
      <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Fact label="Sender (ISA06)" value={envelope.senderId} />
        <Fact label="Receiver (ISA08)" value={envelope.receiverId} />
        <Fact label="Date (ISA09)" value={envelope.date} />
        <Fact label="Time (ISA10)" value={envelope.time} />
        <Fact label="Acknowledgment requested (ISA14)" value={envelope.acknowledgmentRequested} />
      </dl>

      {/* Declared delimiters. */}
      <section aria-labelledby="catalog-x12-separators-heading" className="mt-3">
        <h4 id="catalog-x12-separators-heading" className={cn(SECTION_HEADING, 'flex items-center gap-1.5')}>
          <Scissors className="h-3 w-3" aria-hidden />
          Declared delimiters
        </h4>
        <dl
          data-testid="x12-separators"
          className="cid-inset mt-1.5 grid grid-cols-2 gap-3 p-2.5 sm:grid-cols-4"
        >
          {envelope.separators.map((separator) => (
            <Separator key={separator.label} separator={separator} />
          ))}
        </dl>
      </section>

      {/* Control totals at the interchange level. */}
      <dl className="mt-3">
        <ControlTotal total={envelope.groupTotal} />
      </dl>

      {/* Every group and every transaction set — the ones the canonical model dropped included. */}
      <section aria-labelledby="catalog-x12-groups-heading" className="mt-3">
        <h4 id="catalog-x12-groups-heading" className={cn(SECTION_HEADING, 'flex items-center gap-1.5')}>
          <Repeat className="h-3 w-3" aria-hidden />
          Functional groups and transaction sets
        </h4>
        {groups.length === 0 ? (
          <p
            data-testid="x12-no-groups"
            className="mt-1.5 text-2xs text-fg-muted"
          >
            This record carries no functional group. A bounded analysis keeps envelopes before
            leaves, so an interchange with groups would still show them here.
          </p>
        ) : (
          <ul data-testid="x12-groups" className="mt-1.5 space-y-2">
            {groups.map((group, index) => (
              <Group
                key={group.node.id}
                group={group}
                index={index}
                onRevealNode={onRevealNode}
              />
            ))}
          </ul>
        )}
      </section>

      {/* What the conversion was derived from — the statement no other screen makes. */}
      <div
        data-testid="x12-conversion-scope"
        data-subset={scope.isSubset}
        className={cn(
          'mt-3 flex items-start gap-1.5 rounded-lg border px-3 py-2 text-xs',
          scope.isSubset
            ? 'border-warn bg-warn-soft text-warn-fg'
            : 'border-border bg-subtle text-fg',
        )}
      >
        {scope.isSubset ? (
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        ) : (
          <FileWarning className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        )}
        <span>{scope.statement}</span>
      </div>

      {/* Observed, not validated. Rendered on every X12 record without exception. */}
      <div
        data-testid="x12-conformance-statement"
        className="mt-2 flex items-start gap-1.5 rounded-lg border border-accent bg-accent-soft px-3 py-2 text-xs text-accent-fg"
      >
        <ShieldQuestion className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>{x12ConformanceStatement()}</span>
      </div>
    </section>
  );
}

export default CatalogX12InspectorPanel;
