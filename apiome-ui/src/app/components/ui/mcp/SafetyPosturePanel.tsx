'use client';

/**
 * Safety & annotation posture panel (V2-MCP-29.4 / MCAT-15.4).
 *
 * Surfaces the single most important safety signal for a server's tools — read-only vs destructive —
 * out of the per-item `annotations` where it is otherwise buried:
 *
 * - a headline **posture summary** ("3 destructive, 1 open-world, 8 read-only") plus the endpoint's
 *   **auth badge**;
 * - a prominent **destructive + no-auth** alert when destructive tools are reachable anonymously;
 * - an explicit **"unannotated — treat with caution"** state when no tool declares any hint;
 * - the per-tool **hint matrix** (tools × read-only / destructive / idempotent / open-world), each
 *   cell a tri-state so an explicit `false` reads differently from an omitted hint.
 *
 * All counting, cross-referencing, and tri-state resolution live in the pure, unit-tested
 * `mcpSafetyPostureUi` module; this component only renders the produced view models and maps each
 * hint's tone token to classes. It owns its loading / error / no-tools states so a slow or missing
 * surface never blanks the Insight tab.
 */

import * as React from 'react';
import { AlertTriangle, Check, ShieldAlert, ShieldCheck } from 'lucide-react';
import { EmptyState } from '@/app/components/ui/EmptyState';
import { LoadingState } from '@/app/components/ui/LoadingState';
import { McpBadge } from '@/app/components/ui/mcp/McpBadge';
import type { McpBadgeTone } from '@/app/components/ade/dashboard/mcp/mcpUiPrimitives';
import type { McpCapabilityItem } from '@/app/components/ade/dashboard/mcp/mcpBrowseUi';
import {
  SAFETY_HINT_COLUMNS,
  mcpSafetyHeadlineChips,
  mcpSafetyPosture,
  mcpToolSafetyRows,
  type McpSafetyCellState,
  type McpSafetyHintColumn,
  type McpToolSafetyRow,
} from '@/app/components/ade/dashboard/mcp/mcpSafetyPostureUi';

interface Props {
  /** The selected snapshot's capability items (all kinds), or `null` while the surface has not loaded. */
  items: readonly McpCapabilityItem[] | null;
  /** The endpoint's configured `auth_type`, or `null` when the credential status is unavailable. */
  authType: string | null;
  loading: boolean;
  error: string | null;
}

/** Solid fill classes for an *asserted* matrix cell, keyed by the hint's tone token. */
const CELL_ASSERTED_CLASS: Record<McpBadgeTone, string> = {
  green: 'bg-emerald-500 text-white dark:bg-emerald-500',
  red: 'bg-red-500 text-white dark:bg-red-500',
  blue: 'bg-blue-500 text-white dark:bg-blue-500',
  amber: 'bg-amber-500 text-white dark:bg-amber-500',
  indigo: 'bg-indigo-500 text-white dark:bg-indigo-500',
  violet: 'bg-violet-500 text-white dark:bg-violet-500',
  slate: 'bg-slate-500 text-white dark:bg-slate-500',
};

/** Human phrasing for a cell's tri-state, used in each cell's `aria-label` for screen readers. */
const CELL_STATE_LABEL: Record<McpSafetyCellState, string> = {
  asserted: 'asserted',
  denied: 'declared false',
  unset: 'not declared',
};

/** One matrix cell for a (tool, hint) pair — a filled tone chip, a muted "false", or an empty dot. */
function MatrixCell({
  state,
  column,
}: {
  state: McpSafetyCellState;
  column: McpSafetyHintColumn;
}) {
  const label = `${column.label}: ${CELL_STATE_LABEL[state]}`;
  if (state === 'asserted') {
    return (
      <span
        className={`inline-flex h-6 w-6 items-center justify-center rounded-md ${CELL_ASSERTED_CLASS[column.tone]}`}
        role="img"
        aria-label={label}
        title={label}
      >
        <Check className="h-3.5 w-3.5" aria-hidden />
      </span>
    );
  }
  if (state === 'denied') {
    return (
      <span
        className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-gray-200 text-xs font-medium text-gray-400 dark:border-gray-700 dark:text-gray-500"
        role="img"
        aria-label={label}
        title={label}
      >
        false
      </span>
    );
  }
  return (
    <span
      className="inline-flex h-6 w-6 items-center justify-center text-gray-300 dark:text-gray-600"
      role="img"
      aria-label={label}
      title={label}
    >
      <span className="h-1 w-1 rounded-full bg-current" aria-hidden />
    </span>
  );
}

/** The per-tool hint matrix as an accessible table (tools × the four behavioural hints). */
function HintMatrix({ rows }: { rows: readonly McpToolSafetyRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">
          Behavioural annotation hints per tool. Each cell is asserted, declared false, or not
          declared.
        </caption>
        <thead>
          <tr className="border-b border-gray-200 dark:border-gray-700">
            <th
              scope="col"
              className="py-2 pr-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400"
            >
              Tool
            </th>
            {SAFETY_HINT_COLUMNS.map((column) => (
              <th
                key={column.key}
                scope="col"
                className="px-2 py-2 text-center text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400"
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={`${row.index}-${row.name}`}
              className="border-b border-gray-100 last:border-0 dark:border-gray-800"
            >
              <th
                scope="row"
                className="max-w-[16rem] truncate py-2 pr-3 text-left font-mono text-xs font-medium text-gray-900 dark:text-white"
                title={row.displayName}
              >
                {row.displayName}
                {row.unannotated ? (
                  <span className="ml-2 font-sans text-2xs font-normal uppercase tracking-wider text-amber-600 dark:text-amber-400">
                    unannotated
                  </span>
                ) : null}
              </th>
              {SAFETY_HINT_COLUMNS.map((column) => (
                <td key={column.key} className="px-2 py-2 text-center">
                  <span className="inline-flex justify-center">
                    <MatrixCell state={row.cells[column.key]} column={column} />
                  </span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The safety & annotation posture panel. Handles its own loading / error / no-tools states so a slow
 * or missing surface never blanks the Insight tab; a fully-unannotated server and a destructive
 * no-auth server both render an explicit, prominent caution rather than a silent gap.
 */
export function SafetyPosturePanel({ items, authType, loading, error }: Props) {
  const posture = React.useMemo(() => mcpSafetyPosture(items ?? [], authType), [items, authType]);
  const headlineChips = React.useMemo(() => mcpSafetyHeadlineChips(posture), [posture]);
  const rows = React.useMemo(() => mcpToolSafetyRows(items ?? []), [items]);

  if (loading && !items) {
    return <LoadingState minHeightClassName="min-h-[160px]" message="Loading safety posture…" />;
  }
  if (error) {
    return (
      <EmptyState
        variant="compact"
        icon={<ShieldAlert className="h-8 w-8 text-white" aria-hidden />}
        title="Safety posture unavailable"
        description={error}
      />
    );
  }
  if (!items) return null;

  if (posture.totalTools === 0) {
    return (
      <EmptyState
        variant="compact"
        icon={<ShieldAlert className="h-8 w-8 text-white" aria-hidden />}
        title="No tools"
        description="This snapshot declares no tools, so there is no safety posture to summarize."
      />
    );
  }

  const { auth } = posture;
  const AuthIcon = auth.posture === 'authenticated' ? ShieldCheck : ShieldAlert;

  return (
    <div className="space-y-4">
      {/* Headline: annotated-tool count, per-hint posture chips, and the endpoint's auth badge. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-gray-500 dark:text-gray-400 tabular-nums">
            {posture.annotatedTools} of {posture.totalTools}{' '}
            {posture.totalTools === 1 ? 'tool' : 'tools'} annotated
          </span>
          {headlineChips.length > 0 ? (
            <span className="flex flex-wrap items-center gap-1.5">
              {headlineChips.map((chip) => (
                <McpBadge key={chip.key} tone={chip.tone}>
                  {chip.count} {chip.label.toLowerCase()}
                </McpBadge>
              ))}
            </span>
          ) : null}
        </div>
        <McpBadge tone={auth.tone} icon={<AuthIcon className="h-3 w-3" aria-hidden />}>
          {auth.label}
        </McpBadge>
      </div>

      {/* Destructive + no-auth: the combination that most warrants caution, surfaced explicitly. */}
      {posture.destructiveWithoutAuth.length > 0 ? (
        <div
          className="flex gap-3 rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-800 dark:bg-red-900/20"
          role="alert"
        >
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-400" aria-hidden />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-red-800 dark:text-red-200">
              {posture.destructiveWithoutAuth.length} destructive{' '}
              {posture.destructiveWithoutAuth.length === 1 ? 'tool' : 'tools'} reachable with no auth
            </p>
            <p className="mt-0.5 text-xs text-red-700 dark:text-red-300">
              This endpoint is anonymous (no auth), yet these tools declare{' '}
              <code className="font-mono">destructiveHint</code>. Anyone who can reach the server can
              invoke them:
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {posture.destructiveWithoutAuth.map((row) => (
                <code
                  key={`${row.index}-${row.name}`}
                  className="rounded bg-red-100 px-1.5 py-0.5 font-mono text-xs text-red-800 dark:bg-red-900/40 dark:text-red-200"
                >
                  {row.displayName}
                </code>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {/* Fully-unannotated surface: an explicit caution, since "no hints" is not "safe". */}
      {posture.fullyUnannotated ? (
        <div
          className="flex gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-900/20"
          role="note"
        >
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-amber-800 dark:text-amber-200">
              Unannotated — treat with caution
            </p>
            <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-300">
              None of this server&apos;s {posture.totalTools}{' '}
              {posture.totalTools === 1 ? 'tool declares' : 'tools declare'} a behavioural hint, so
              their read-only vs destructive nature is unknown. Absence of a hint is not a guarantee
              of safety.
            </p>
          </div>
        </div>
      ) : null}

      <HintMatrix rows={rows} />

      {/* Legend for the tri-state cells so the matrix reads without hovering. */}
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
        <li className="flex items-center gap-1.5">
          <span className="inline-flex h-4 w-4 items-center justify-center rounded bg-gray-400 text-white dark:bg-gray-500">
            <Check className="h-2.5 w-2.5" aria-hidden />
          </span>
          Asserted
        </li>
        <li className="flex items-center gap-1.5">
          <span className="inline-flex h-4 w-4 items-center justify-center rounded border border-gray-200 text-2xs font-medium text-gray-400 dark:border-gray-700 dark:text-gray-500">
            false
          </span>
          Declared false
        </li>
        <li className="flex items-center gap-1.5">
          <span className="inline-flex h-4 w-4 items-center justify-center text-gray-300 dark:text-gray-600">
            <span className="h-1 w-1 rounded-full bg-current" aria-hidden />
          </span>
          Not declared
        </li>
      </ul>
    </div>
  );
}

export default SafetyPosturePanel;
