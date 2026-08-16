'use client';

/**
 * BenchFindingsList (IXH-5.3, #5115).
 *
 * The findings half of a validation result: a status line (valid / invalid / not validated —
 * never guessed), the path-anchored findings as clickable rows (click reveals the value in the
 * payload editor), and the diagnostics that limited the check, kept visually distinct from
 * failures of the payload itself.
 *
 * Bounded per IXH-3.6: above {@link TEST_BENCH_FINDINGS_VIRTUALIZE_ABOVE} rows the list is
 * windowed (`computeWindowedRange`, spacer rows keep the scrollbar honest, a "windowed" note
 * makes the behavior discoverable), and a server-side `truncated` report states
 * "showing X of Y findings" — truncation is never silent.
 */

import { useState } from 'react';
import { AlertTriangle, CheckCircle2, HelpCircle, XCircle } from 'lucide-react';
import { TEST_BENCH_FINDINGS_VIRTUALIZE_ABOVE } from '@/app/utils/preview-budgets';
import { computeWindowedRange } from '@/app/utils/windowed-rows';
import type { BenchFinding, BenchValidationPayload } from '@/app/utils/schema-test-bench';

/** Uniform row height for the windowed list (px). */
const FINDING_ROW_HEIGHT = 56;
/** Viewport height when the list windows (px). */
const FINDINGS_VIEWPORT_HEIGHT = 336;

export interface BenchFindingsListProps {
  /** The validation payload to render, or `null` before the first run. */
  result: BenchValidationPayload | null;
  /** Called when a finding row is activated (click/Enter) — reveals it in the editor. */
  onSelectFinding: (finding: BenchFinding) => void;
}

/** The status line: valid / invalid / not-validated, with the honest `valid: null` case. */
function StatusLine({ result }: { result: BenchValidationPayload }) {
  if (result.ok === false) {
    const message =
      typeof result.error === 'object' && result.error?.message
        ? result.error.message
        : 'This payload could not be checked.';
    return (
      <p
        data-testid="test-bench-status"
        className="flex items-center gap-1.5 text-sm font-medium text-amber-700 dark:text-amber-300"
      >
        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden /> {message}
      </p>
    );
  }
  if (result.valid === true) {
    return (
      <p
        data-testid="test-bench-status"
        className="flex items-center gap-1.5 text-sm font-medium text-emerald-700 dark:text-emerald-300"
      >
        <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden /> Payload is valid against the schema.
      </p>
    );
  }
  if (result.valid === false) {
    return (
      <p
        data-testid="test-bench-status"
        className="flex items-center gap-1.5 text-sm font-medium text-rose-700 dark:text-rose-300"
      >
        <XCircle className="h-4 w-4 shrink-0" aria-hidden />
        Payload is invalid — {result.total_findings ?? result.findings?.length ?? 0} finding
        {(result.total_findings ?? result.findings?.length ?? 0) === 1 ? '' : 's'}.
      </p>
    );
  }
  return (
    <p
      data-testid="test-bench-status"
      className="flex items-center gap-1.5 text-sm font-medium text-gray-600 dark:text-gray-400"
    >
      <HelpCircle className="h-4 w-4 shrink-0" aria-hidden />
      No validator ran over this payload — validity was not checked.
    </p>
  );
}

/** One finding row (button so keyboard activation reveals the editor range). */
function FindingRow({
  finding,
  index,
  total,
  onSelect,
  onFocusRow,
  style,
}: {
  finding: BenchFinding;
  index: number;
  total: number;
  onSelect: (finding: BenchFinding) => void;
  onFocusRow: () => void;
  style?: React.CSSProperties;
}) {
  return (
    <li aria-setsize={total} aria-posinset={index + 1} style={style} className="list-none">
      <button
        type="button"
        data-testid={`test-bench-finding-${index}`}
        onClick={() => onSelect(finding)}
        onFocus={onFocusRow}
        style={{ height: FINDING_ROW_HEIGHT }}
        className="flex w-full flex-col items-start justify-center gap-0.5 overflow-hidden rounded-md px-2 py-1 text-left hover:bg-rose-50/60 focus:outline-none focus:ring-2 focus:ring-indigo-500 dark:hover:bg-rose-950/30"
        title="Reveal in payload editor"
      >
        <span className="flex w-full min-w-0 items-center gap-2">
          <code className="shrink-0 rounded bg-rose-100 px-1 py-0.5 font-mono text-2xs font-semibold text-rose-800 dark:bg-rose-900/50 dark:text-rose-300">
            {finding.keyword}
          </code>
          <code className="truncate font-mono text-xs text-gray-600 dark:text-gray-400">
            {finding.pointer || '(document root)'}
          </code>
        </span>
        <span className="w-full truncate text-xs text-gray-700 dark:text-gray-300">
          {finding.message}
        </span>
      </button>
    </li>
  );
}

/**
 * Render a validation result. Renders nothing before the first run so the bench opens quiet.
 */
export function BenchFindingsList({ result, onSelectFinding }: BenchFindingsListProps) {
  const [scrollTop, setScrollTop] = useState(0);
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);

  if (!result) return null;

  const findings = result.findings ?? [];
  const total = result.total_findings ?? findings.length;
  const windowed = findings.length > TEST_BENCH_FINDINGS_VIRTUALIZE_ABOVE;
  const rowWindow = windowed
    ? computeWindowedRange({
        rowCount: findings.length,
        rowHeight: FINDING_ROW_HEIGHT,
        viewportHeight: FINDINGS_VIEWPORT_HEIGHT,
        scrollTop,
      })
    : { startIndex: 0, endIndex: findings.length, paddingTop: 0, paddingBottom: 0 };
  const pinnedIndex =
    windowed &&
    focusedIndex !== null &&
    focusedIndex < findings.length &&
    (focusedIndex < rowWindow.startIndex || focusedIndex >= rowWindow.endIndex)
      ? focusedIndex
      : null;

  const renderRow = (finding: BenchFinding, index: number, pinned: boolean) => (
    <FindingRow
      key={`${index}:${finding.pointer}:${finding.keyword}`}
      finding={finding}
      index={index}
      total={findings.length}
      onSelect={onSelectFinding}
      onFocusRow={() => setFocusedIndex(index)}
      style={
        pinned
          ? { position: 'absolute', top: index * FINDING_ROW_HEIGHT, left: 0, right: 0 }
          : undefined
      }
    />
  );

  const diagnostics = result.diagnostics ?? [];

  return (
    <section data-testid="test-bench-findings" className="space-y-3" aria-label="Validation result">
      <StatusLine result={result} />

      {result.truncated ? (
        <p
          data-testid="test-bench-findings-truncated"
          className="text-xs text-amber-700 dark:text-amber-300"
        >
          Showing {findings.length} of {total} findings — the report was truncated. Copy as curl
          and raise <code className="font-mono">max_findings</code> for the complete report.
        </p>
      ) : null}

      {findings.length > 0 ? (
        <div
          className={windowed ? 'overflow-y-auto' : undefined}
          style={windowed ? { height: FINDINGS_VIEWPORT_HEIGHT } : undefined}
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          role={windowed ? 'region' : undefined}
          tabIndex={windowed ? 0 : undefined}
          aria-label={windowed ? `Findings (${findings.length}, windowed)` : undefined}
        >
          {windowed ? (
            <p className="mb-1 text-2xs uppercase tracking-wider text-gray-400 dark:text-gray-500">
              windowed — every finding stays reachable by scrolling
            </p>
          ) : null}
          <ul className="relative divide-y divide-gray-100 dark:divide-gray-800">
            {rowWindow.paddingTop > 0 && <li aria-hidden style={{ height: rowWindow.paddingTop }} />}
            {findings
              .slice(rowWindow.startIndex, rowWindow.endIndex)
              .map((finding, offset) => renderRow(finding, rowWindow.startIndex + offset, false))}
            {rowWindow.paddingBottom > 0 && (
              <li aria-hidden style={{ height: rowWindow.paddingBottom }} />
            )}
            {pinnedIndex !== null ? renderRow(findings[pinnedIndex], pinnedIndex, true) : null}
          </ul>
        </div>
      ) : null}

      {diagnostics.length > 0 ? (
        <div data-testid="test-bench-diagnostics" className="space-y-1">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            Diagnostics (limits on the check, not payload failures)
          </h3>
          <ul className="space-y-1">
            {diagnostics.map((diagnostic, index) => (
              <li
                key={`${diagnostic.code}:${index}`}
                className="flex items-start gap-1.5 text-xs text-gray-600 dark:text-gray-400"
              >
                <AlertTriangle
                  className="mt-0.5 h-3 w-3 shrink-0 text-amber-500"
                  aria-hidden
                />
                <span>
                  <code className="font-mono text-2xs text-gray-500 dark:text-gray-500">
                    {diagnostic.code}
                  </code>{' '}
                  {diagnostic.message}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
