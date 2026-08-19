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
import { STATUS_TONE_SOFT_CLASS } from '@/app/components/ui/statusVocabulary';
import { STATUS_TONE_SOLID_CLASS } from '@/app/components/ui/statusVocabulary';
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
  green: STATUS_TONE_SOLID_CLASS.ok,
  red: STATUS_TONE_SOLID_CLASS.danger,
  blue: STATUS_TONE_SOLID_CLASS.accent,
  amber: STATUS_TONE_SOLID_CLASS.warn,
  indigo: STATUS_TONE_SOLID_CLASS.accent,
  violet: STATUS_TONE_SOLID_CLASS.violet,
  slate: STATUS_TONE_SOLID_CLASS.neutral,
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
        className="inline-flex size-6 items-center justify-center rounded-md text-xs font-medium text-fg-faint shadow-[inset_0_0_0_1px_var(--border)]"
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
      className="inline-flex h-6 w-6 items-center justify-center text-fg-faint"
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
          <tr className="border-b border-border">
            <th
              scope="col"
              className="py-2 pr-3 text-left text-xs font-medium uppercase tracking-wider text-fg-muted"
            >
              Tool
            </th>
            {SAFETY_HINT_COLUMNS.map((column) => (
              <th
                key={column.key}
                scope="col"
                className="px-2 py-2 text-center text-xs font-medium uppercase tracking-wider text-fg-muted"
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
              className="border-b border-border last:border-0"
            >
              <th
                scope="row"
                className="max-w-[16rem] truncate py-2 pr-3 text-left font-mono text-xs font-medium text-fg"
                title={row.displayName}
              >
                {row.displayName}
                {row.unannotated ? (
                  <span className={`mcp-tone-figure ml-2 font-sans text-2xs font-normal uppercase tracking-wider ${STATUS_TONE_SOFT_CLASS.warn}`}>
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
        icon={<ShieldAlert className="h-8 w-8 text-fg-on-accent" aria-hidden />}
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
        icon={<ShieldAlert className="h-8 w-8 text-fg-on-accent" aria-hidden />}
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
          <span className="text-xs text-fg-muted tabular-nums">
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
          className="flex gap-3 rounded-lg bg-danger-soft p-3"
          role="alert"
        >
          <AlertTriangle className="mt-0.5 size-5 shrink-0" aria-hidden />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-danger-fg">
              {posture.destructiveWithoutAuth.length} destructive{' '}
              {posture.destructiveWithoutAuth.length === 1 ? 'tool' : 'tools'} reachable with no auth
            </p>
            <p className="mt-0.5 text-xs text-danger-fg">
              This endpoint is anonymous (no auth), yet these tools declare{' '}
              <code className="font-mono">destructiveHint</code>. Anyone who can reach the server can
              invoke them:
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {posture.destructiveWithoutAuth.map((row) => (
                <code
                  key={`${row.index}-${row.name}`}
                  className="mono rounded-sm bg-danger-soft px-1.5 py-0.5 text-xs text-danger-fg"
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
          className="flex gap-3 rounded-lg bg-warn-soft p-3"
          role="note"
        >
          <ShieldAlert className="mt-0.5 size-5 shrink-0" aria-hidden />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-warn-fg">
              Unannotated — treat with caution
            </p>
            <p className="mt-0.5 text-xs text-warn-fg">
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
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-muted">
        <li className="flex items-center gap-1.5">
          <span className="inline-flex size-4 items-center justify-center rounded-sm bg-neutral text-fg-on-accent">
            <Check className="h-2.5 w-2.5" aria-hidden />
          </span>
          Asserted
        </li>
        <li className="flex items-center gap-1.5">
          <span className="inline-flex size-4 items-center justify-center rounded-sm text-2xs font-medium text-fg-faint shadow-[inset_0_0_0_1px_var(--border)]">
            false
          </span>
          Declared false
        </li>
        <li className="flex items-center gap-1.5">
          <span className="inline-flex h-4 w-4 items-center justify-center text-fg-faint">
            <span className="h-1 w-1 rounded-full bg-current" aria-hidden />
          </span>
          Not declared
        </li>
      </ul>
    </div>
  );
}

export default SafetyPosturePanel;
