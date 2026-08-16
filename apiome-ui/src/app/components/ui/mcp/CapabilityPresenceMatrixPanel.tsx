'use client';

/**
 * Capability lifespan / presence matrix panel (V2-MCP-30.2 / MCAT-16.2).
 *
 * The version history is a list; it cannot answer "is this tool stable, or was it added last week and
 * might vanish?". This panel renders the **presence matrix** — rows = every distinct capability ever
 * seen, columns = discovery snapshots oldest→newest — shading each cell **added / present / modified /
 * absent**: a "gantt of the surface" that makes volatile vs long-lived capabilities legible at a
 * glance. Each row carries a lifespan badge (stable / new / volatile / removed) and the headline
 * summarizes how many capabilities are current, new, removed, or volatile.
 *
 * All presence reconstruction and the added-vs-modified classification live in the pure, unit-tested
 * {@link mcpPresenceMatrix} projection over the same per-version snapshots the browse/insight views
 * load, so the chart and its lifespan badges can never disagree. The matrix scrolls (sticky header +
 * first column) so it scales to many capabilities and many versions. **Clicking a version column
 * header deep-links to that snapshot's diff** (MCAT-10.3) via `onSelectVersion`, mirroring the churn
 * timeline. The component owns its loading / error / empty states so a slow or missing history never
 * blanks the Insight tab.
 */

import * as React from 'react';
import { GitCompareArrows, MousePointerClick, Plus, Pencil } from 'lucide-react';
import { EmptyState } from '@/app/components/ui/EmptyState';
import { LoadingState } from '@/app/components/ui/LoadingState';
import { McpBadge } from '@/app/components/ui/mcp/McpBadge';
import type { McpBadgeTone } from '@/app/components/ade/dashboard/mcp/mcpUiPrimitives';
import type { McpVersionDetail } from '@/app/components/ade/dashboard/mcp/mcpBrowseUi';
import {
  mcpMatrixCellLabel,
  mcpMatrixColumnDateLabel,
  mcpMatrixColumnLabel,
  mcpMatrixKindLabel,
  mcpMatrixLifespanLabel,
  mcpPresenceMatrix,
  type McpMatrixCellState,
  type McpMatrixColumn,
  type McpMatrixLifespan,
  type McpMatrixRow,
} from '@/app/components/ade/dashboard/mcp/mcpPresenceMatrixUi';

interface Props {
  /** The endpoint's per-version snapshots (any order), or `null` while they have not loaded. */
  versions: readonly McpVersionDetail[] | null;
  loading: boolean;
  error: string | null;
  /** Called with a snapshot's `version_id` when its column header is activated, to open its diff. */
  onSelectVersion: (versionId: string) => void;
}

/** Lifespan → badge tone: stable is calm green, new indigo, volatile amber, removed muted slate. */
const LIFESPAN_TONE: Record<McpMatrixLifespan, McpBadgeTone> = {
  stable: 'green',
  new: 'indigo',
  volatile: 'amber',
  removed: 'slate',
};

/**
 * One presence cell. `added` and `modified` are strong, filled tones (a life's start / a change);
 * `present` is a calm filled continuation so a run of presences reads as one gantt bar; `absent`
 * is an empty dot. Every cell carries an accessible label so the matrix reads without hovering.
 */
function MatrixCell({
  state,
  label,
}: {
  state: McpMatrixCellState;
  label: string;
}) {
  if (state === 'added') {
    return (
      <span
        className="inline-flex h-5 w-5 items-center justify-center rounded bg-emerald-500 text-white dark:bg-emerald-500"
        role="img"
        aria-label={label}
        title={label}
      >
        <Plus className="h-3 w-3" aria-hidden />
      </span>
    );
  }
  if (state === 'modified') {
    return (
      <span
        className="inline-flex h-5 w-5 items-center justify-center rounded bg-blue-500 text-white dark:bg-blue-500"
        role="img"
        aria-label={label}
        title={label}
      >
        <Pencil className="h-3 w-3" aria-hidden />
      </span>
    );
  }
  if (state === 'present') {
    return (
      <span
        className="inline-flex h-5 w-5 items-center justify-center rounded bg-emerald-100 dark:bg-emerald-900/40"
        role="img"
        aria-label={label}
        title={label}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500/70 dark:bg-emerald-400/70" aria-hidden />
      </span>
    );
  }
  return (
    <span
      className="inline-flex h-5 w-5 items-center justify-center text-gray-300 dark:text-gray-600"
      role="img"
      aria-label={label}
      title={label}
    >
      <span className="h-1 w-1 rounded-full bg-current" aria-hidden />
    </span>
  );
}

/** A single version-column header — a button that deep-links to that snapshot's diff. */
function ColumnHeader({
  column,
  isCurrent,
  onSelect,
}: {
  column: McpMatrixColumn;
  isCurrent: boolean;
  onSelect: () => void;
}) {
  const date = mcpMatrixColumnDateLabel(column);
  const intent = `${mcpMatrixColumnLabel(column)} · ${date}${
    isCurrent ? ' (current)' : ''
  } — open this snapshot's diff`;
  return (
    <th scope="col" className="px-1 py-2 text-center align-bottom">
      <button
        type="button"
        onClick={onSelect}
        aria-label={intent}
        title={intent}
        className={`inline-flex min-w-[2.25rem] flex-col items-center rounded px-1.5 py-1 text-xs font-medium tabular-nums transition-colors hover:bg-indigo-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:hover:bg-indigo-900/30 ${
          isCurrent
            ? 'text-indigo-600 dark:text-indigo-300'
            : 'text-gray-600 dark:text-gray-300'
        }`}
      >
        {mcpMatrixColumnLabel(column)}
        {isCurrent ? (
          <span className="mt-0.5 text-2xs font-normal uppercase tracking-wider text-indigo-500 dark:text-indigo-400">
            current
          </span>
        ) : null}
      </button>
    </th>
  );
}

/** One legend entry pairing a rendered cell with its meaning. */
function LegendItem({ state, label }: { state: McpMatrixCellState; label: string }) {
  return (
    <li className="flex items-center gap-1.5">
      <MatrixCell state={state} label={label} />
      {label}
    </li>
  );
}

/** One headline metric chip (e.g. "12 current"). */
function SummaryChip({ tone, count, label }: { tone: McpBadgeTone; count: number; label: string }) {
  return (
    <McpBadge tone={tone}>
      {count} {label}
    </McpBadge>
  );
}

/**
 * The presence-matrix panel. See the module doc for the acceptance criteria it satisfies (presence is
 * reconstructed exactly from the per-version snapshots, renamed-vs-removed is handled per the diff
 * record via name-keyed rows, and the matrix scrolls for many items).
 */
export function CapabilityPresenceMatrixPanel({ versions, loading, error, onSelectVersion }: Props) {
  const matrix = React.useMemo(() => mcpPresenceMatrix(versions ?? []), [versions]);

  if (loading && !versions) {
    return <LoadingState minHeightClassName="min-h-[180px]" message="Loading presence matrix…" />;
  }
  if (error) {
    return (
      <EmptyState
        variant="compact"
        icon={<GitCompareArrows className="h-8 w-8 text-white" aria-hidden />}
        title="Presence matrix unavailable"
        description={error}
      />
    );
  }
  if (!versions) return null;
  if (matrix.columns.length === 0 || matrix.rows.length === 0) {
    return (
      <EmptyState
        variant="compact"
        icon={<GitCompareArrows className="h-8 w-8 text-white" aria-hidden />}
        title="No capabilities to chart"
        description="This endpoint has no discovered capabilities across its snapshots yet. Run discovery to start building its lifespan history."
      />
    );
  }

  return (
    <div className="space-y-3" aria-busy={loading}>
      {/* Headline: how many capabilities are current, new, removed, or volatile. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <span className="text-xs text-gray-500 dark:text-gray-400">
          <span className="font-semibold tabular-nums text-gray-900 dark:text-white">
            {matrix.totalCapabilities}
          </span>{' '}
          distinct {matrix.totalCapabilities === 1 ? 'capability' : 'capabilities'} across{' '}
          <span className="font-semibold tabular-nums text-gray-900 dark:text-white">
            {matrix.columns.length}
          </span>{' '}
          {matrix.columns.length === 1 ? 'snapshot' : 'snapshots'}
        </span>
        <span className="flex flex-wrap items-center gap-1.5">
          <SummaryChip tone="green" count={matrix.currentCount} label="current" />
          {matrix.newCount > 0 ? (
            <SummaryChip tone="indigo" count={matrix.newCount} label="new" />
          ) : null}
          {matrix.volatileCount > 0 ? (
            <SummaryChip tone="amber" count={matrix.volatileCount} label="volatile" />
          ) : null}
          {matrix.removedCount > 0 ? (
            <SummaryChip tone="slate" count={matrix.removedCount} label="removed" />
          ) : null}
        </span>
      </div>

      {/* The matrix itself: sticky header row + sticky capability column so it scrolls both ways for
          many capabilities and many versions without losing its labels. */}
      <div className="max-h-[28rem] overflow-auto rounded-lg border border-gray-200 dark:border-gray-700">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">
            Capability presence across discovery snapshots. Each row is a capability; each column a
            snapshot oldest to newest. A cell is added, present, modified, or absent.
          </caption>
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800/60">
              <th
                scope="col"
                className="sticky left-0 z-10 bg-gray-50 px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:bg-gray-800/60 dark:text-gray-400"
              >
                Capability
              </th>
              {matrix.columns.map((column, index) => (
                <ColumnHeader
                  key={column.version_id}
                  column={column}
                  isCurrent={index === matrix.currentIndex}
                  onSelect={() => onSelectVersion(column.version_id)}
                />
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.rows.map((row) => (
              <MatrixRow key={row.key} row={row} columns={matrix.columns} />
            ))}
          </tbody>
        </table>
      </div>

      {/* Legend for the four cell states so the matrix reads without hovering. */}
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
        <LegendItem state="added" label="Added" />
        <LegendItem state="present" label="Present" />
        <LegendItem state="modified" label="Modified" />
        <LegendItem state="absent" label="Absent" />
      </ul>

      <p className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
        <MousePointerClick className="h-3.5 w-3.5 shrink-0 text-indigo-400" aria-hidden />
        Select a version column to open its diff in the version history.
      </p>
    </div>
  );
}

/** One capability row: a sticky identity cell (kind · name + lifespan badge) and its presence cells. */
function MatrixRow({ row, columns }: { row: McpMatrixRow; columns: readonly McpMatrixColumn[] }) {
  return (
    <tr className="border-b border-gray-100 last:border-0 dark:border-gray-800">
      <th
        scope="row"
        className="sticky left-0 z-10 max-w-[18rem] bg-white px-3 py-1.5 text-left dark:bg-gray-900"
      >
        <span className="flex items-center gap-2">
          <span className="min-w-0">
            <span className="block truncate font-mono text-xs font-medium text-gray-900 dark:text-white" title={row.name}>
              {row.name}
            </span>
            <span className="block text-2xs uppercase tracking-wider text-gray-400 dark:text-gray-500">
              {mcpMatrixKindLabel(row.item_type)}
            </span>
          </span>
          <McpBadge tone={LIFESPAN_TONE[row.lifespan]}>{mcpMatrixLifespanLabel(row.lifespan)}</McpBadge>
        </span>
      </th>
      {columns.map((column, index) => {
        const state = row.cells[index];
        return (
          <td key={column.version_id} className="px-1 py-1.5 text-center">
            <span className="inline-flex justify-center">
              <MatrixCell state={state} label={mcpMatrixCellLabel(row, column, state)} />
            </span>
          </td>
        );
      })}
    </tr>
  );
}

export default CapabilityPresenceMatrixPanel;
