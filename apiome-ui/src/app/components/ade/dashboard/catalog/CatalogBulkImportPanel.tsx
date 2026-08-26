'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Layers, Loader2 } from 'lucide-react';
import { Alert } from '../../../ui/Alert';
import { Button } from '../../../ui/Button';
import { FormatPill } from '../../../ui/catalog/FormatPill';
import ImportExecutionPanel from '../ImportExecutionPanel';
import ImportCompletePanel from '../ImportCompletePanel';
import { restImportJobClient } from '../../import/importJobClient';
import {
  BULK_TERMINAL_STATES,
  bulkErrorText,
  bulkRowCounts,
  bulkRowDestination,
  bulkRunSummaryLine,
  bulkStalePlanDrift,
  mergeBulkRows,
  type BulkPlan,
  type BulkPlanDrift,
  type BulkResultRow,
  type BulkStartItem,
  type BulkStatusItem,
} from './bulkImportModel';

export type {
  BulkItemError,
  BulkItemOverride,
  BulkMatchedProject,
  BulkPlan,
  BulkPlanDrift,
  BulkPlanItem,
  BulkProposedVersion,
  BulkResultRow,
  BulkSkippedMember,
  BulkVersionPolicy,
} from './bulkImportModel';

/**
 * Bulk import of independent specs — the wizard's batch surface (MFI-29.5, #4392).
 *
 * When a payload holds several *unrelated* documents there is no single routing decision to
 * show and no single quality verdict to confirm — there are N of each. This panel is that
 * shape: it starts one ordinary import per planned spec and renders a row per item as the jobs
 * finish, so a batch where one document fails still reports the nineteen that landed.
 *
 * The panel owns no import logic. It calls the three bulk endpoints and displays what they
 * return; the per-item quality gate, routing, and persistence all happen server-side in the
 * same pipeline a single import runs.
 *
 * ### One execution surface (BLK-1.3, BLK-1.4)
 *
 * The catalog wizard and the repository Files tab's batch wizard both run their batch through
 * this panel, and it is the *same* panel that verifies one: `request.dry_run` makes the run a
 * verify pass, whose rows are the rows the apply will produce, because the server computes
 * both the same way. Each row states what its spec was started to do — a new version of which
 * project, at which label — and, once the job finished, what it actually did. A row's own job
 * is an ordinary import job, so opening it draws the shared `ImportExecutionPanel` /
 * `ImportCompletePanel` rather than a second progress surface.
 */

interface CatalogBulkImportPanelProps {
  /** The request body identifying the payload — an archive or a repository selection. */
  source: Record<string, unknown>;
  /** The plan the wizard already fetched and showed the user. */
  plan: BulkPlan;
  /**
   * What to send alongside the source (BLK-1.3): per-item `overrides`, the reviewed plan's
   * `plan_fingerprint`, and `dry_run` for the verify pass. Merged over `source`.
   */
  request?: Record<string, unknown>;
  /** Called once every item reached a terminal state and at least one was imported. */
  onSuccess?: () => void;
  /** Called once every item reached a terminal state, with the final rows, imported or not. */
  onFinished?: (rows: BulkResultRow[]) => void;
  /**
   * Called when the server refused the batch because the plan drifted since it was reviewed
   * (BLK-1.3). Nothing was imported; the caller decides whether to re-plan.
   */
  onStalePlan?: (drift: BulkPlanDrift[]) => void;
  /**
   * Called once the run stops for any reason — finished, refused, or errored — so a caller
   * holding a "running" flag can drop it even when there are no rows to report.
   */
  onSettled?: () => void;
}

/** Poll cadence and ceiling: the same 400ms × 150 budget the single-import flow uses. */
const POLL_INTERVAL_MS = 400;
const MAX_POLLS = 150;

/** Colour treatment for a row's state chip. */
function stateTone(state: string): string {
  if (state === 'completed') {
    return 'border-ok bg-ok-soft text-ok-fg';
  }
  if (state === 'failed' || state === 'canceled' || state === 'rolled-back' || state === 'not-found') {
    return 'border-danger bg-danger-soft text-danger-fg';
  }
  return 'border-border bg-subtle text-fg';
}

/** Whether a row's job is still moving — the state in which its detail is a live progress panel. */
function isLive(state: string): boolean {
  return !BULK_TERMINAL_STATES.has(state);
}

/**
 * One item's own job, drawn inside its row on request.
 *
 * A running job gets `ImportExecutionPanel`, a completed one `ImportCompletePanel` — the two
 * surfaces the single-file wizard already draws, so per-item progress in a batch is the same
 * object as progress for one import rather than a smaller copy of it. The rows are REST jobs,
 * so the panels read them through `restImportJobClient` rather than the in-process worker's
 * store, which has never heard of them.
 */
function BulkRowJob({ row }: { row: BulkResultRow }) {
  if (!row.jobId) return null;
  if (row.state === 'completed') {
    return <ImportCompletePanel jobId={row.jobId} client={restImportJobClient} />;
  }
  return (
    <ImportExecutionPanel
      jobId={row.jobId}
      isReviewing={!isLive(row.state)}
      client={restImportJobClient}
    />
  );
}

export function CatalogBulkImportPanel({
  source,
  plan,
  request,
  onSuccess,
  onFinished,
  onStalePlan,
  onSettled,
}: CatalogBulkImportPanelProps) {
  const [rows, setRows] = useState<BulkResultRow[]>([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drift, setDrift] = useState<BulkPlanDrift[] | null>(null);
  const [openRows, setOpenRows] = useState<Set<string>>(() => new Set());
  // The batch is started from a click, but React 18 double-invokes effects in development;
  // one guard keeps a re-render from starting the same batch twice.
  const startedRef = useRef(false);
  const dryRun = Boolean(request?.dry_run);

  // The callbacks are read through refs so a parent re-rendering with a new closure does not
  // restart the batch: `runBatch` depends only on what it sends.
  const callbacksRef = useRef({ onSuccess, onFinished, onStalePlan, onSettled });
  callbacksRef.current = { onSuccess, onFinished, onStalePlan, onSettled };
  const bodyJson = JSON.stringify({ ...source, ...(request ?? {}) });

  const runBatch = useCallback(async () => {
    setRunning(true);
    setError(null);
    setDrift(null);
    try {
      const startRes = await fetch('/api/catalog/import/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: bodyJson,
      });
      const startData = await startRes.json().catch(() => ({}));
      if (!startRes.ok || startData?.success === false) {
        const stale = bulkStalePlanDrift(startData);
        if (stale) {
          setDrift(stale);
          callbacksRef.current.onStalePlan?.(stale);
          return;
        }
        throw new Error(startData?.error || 'Failed to start the bulk import.');
      }
      const started: BulkStartItem[] = Array.isArray(startData?.items) ? startData.items : [];
      let merged = mergeBulkRows(started, []);
      setRows(merged);

      const refs = started
        .filter((item) => item.state === 'accepted' && item.job_id)
        .map((item) => ({ key: item.key, job_id: String(item.job_id) }));
      if (refs.length === 0) {
        setDone(true);
        callbacksRef.current.onFinished?.(merged);
        return;
      }

      for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        const pollRes = await fetch('/api/catalog/import/bulk/status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: refs }),
        });
        const pollData = await pollRes.json().catch(() => ({}));
        if (!pollRes.ok || pollData?.success === false) {
          throw new Error(pollData?.error || 'Failed to check the bulk import status.');
        }
        const statuses: BulkStatusItem[] = Array.isArray(pollData?.items) ? pollData.items : [];
        merged = mergeBulkRows(started, statuses);
        setRows(merged);
        if (pollData?.done || merged.every((row) => BULK_TERMINAL_STATES.has(row.state))) {
          setDone(true);
          if (merged.some((row) => row.state === 'completed')) callbacksRef.current.onSuccess?.();
          callbacksRef.current.onFinished?.(merged);
          return;
        }
      }
      throw new Error('The bulk import is taking longer than expected. Check the catalog shortly.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to run the bulk import.');
    } finally {
      setRunning(false);
      callbacksRef.current.onSettled?.();
    }
  }, [bodyJson]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void runBatch();
  }, [runBatch]);

  const counts = useMemo(() => bulkRowCounts(rows), [rows]);

  const toggleRow = (key: string) => {
    setOpenRows((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div
      className="mt-4 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto"
      data-testid="catalog-bulk-import-panel"
      data-dry-run={dryRun ? 'true' : undefined}
    >
      <div className="flex shrink-0 items-center gap-2 rounded-lg border border-border p-3">
        {done ? (
          <CheckCircle2 className="h-4 w-4 text-ok" aria-hidden />
        ) : (
          <Loader2 className="h-4 w-4 animate-spin text-accent" aria-hidden />
        )}
        <span className="text-sm font-medium text-fg" data-testid="catalog-bulk-import-summary">
          {done
            ? bulkRunSummaryLine(rows, dryRun)
            : `${dryRun ? 'Verifying' : 'Importing'} ${plan.items.length} independent spec${
                plan.items.length === 1 ? '' : 's'
              }…`}
        </span>
        {done && counts.pending > 0 ? (
          <span className="text-xs text-fg-muted">{counts.pending} still running</span>
        ) : null}
      </div>

      {error && (
        <Alert variant="error" className="shrink-0" data-testid="catalog-bulk-import-error">
          {error}
        </Alert>
      )}

      {drift && (
        <Alert variant="warning" className="shrink-0" data-testid="catalog-bulk-import-stale">
          <div className="flex flex-col gap-1">
            <span className="font-medium">
              The plan you reviewed no longer describes this batch — nothing was imported.
            </span>
            {drift.length > 0 ? (
              <ul className="space-y-0.5 text-xs">
                {drift.map((entry) => (
                  <li key={`${entry.key}:${entry.change}`}>
                    <span className="mono">{entry.key}</span> — {entry.detail}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </Alert>
      )}

      <ul className="shrink-0 space-y-2" data-testid="catalog-bulk-import-results">
        {rows.map((row) => {
          const destination = bulkRowDestination(row);
          const open = openRows.has(row.key);
          const detailId = `bulk-row-job-${row.key.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
          return (
            <li
              key={row.key}
              className="rounded-lg border border-border p-3"
              data-testid={`catalog-bulk-import-item-${row.key}`}
              data-state={row.state}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm font-medium text-fg">{row.name}</span>
                  <FormatPill format={row.format ?? null} />
                </div>
                <div className="flex items-center gap-2">
                  {row.target && (
                    <span className="rounded-full border border-border px-2 py-0.5 text-2xs text-fg-muted">
                      {row.target}
                    </span>
                  )}
                  {isLive(row.state) && row.jobId ? (
                    <span className="text-2xs text-fg-muted" data-testid="catalog-bulk-import-percent">
                      {row.percent}%
                    </span>
                  ) : null}
                  <span className={`rounded-full border px-2 py-0.5 text-2xs ${stateTone(row.state)}`}>
                    {row.state}
                  </span>
                  {row.jobId ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-expanded={open}
                      aria-controls={detailId}
                      onClick={() => toggleRow(row.key)}
                      data-testid={`catalog-bulk-import-toggle-${row.key}`}
                    >
                      {open ? <ChevronUp aria-hidden /> : <ChevronDown aria-hidden />}
                      {open ? 'Hide job' : row.state === 'completed' ? 'Summary' : 'Progress'}
                    </Button>
                  ) : null}
                </div>
              </div>
              <div className="mt-1 truncate text-xs text-fg-muted">{row.key}</div>
              {destination && (
                <div
                  className="mt-1 text-xs text-fg-muted"
                  data-testid={`catalog-bulk-import-destination-${row.key}`}
                >
                  {destination}
                  {row.overridden ? ' · overridden' : ''}
                </div>
              )}
              {row.error && (
                <div className="mt-1 flex items-start gap-1 text-xs text-danger">
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                  <span>{bulkErrorText(row.error)}</span>
                </div>
              )}
              {open && row.jobId ? (
                <div id={detailId} className="mt-3 border-t border-border pt-3">
                  <BulkRowJob row={row} />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {plan.skipped.length > 0 && (
        <details
          className="shrink-0 text-xs text-fg-muted"
          data-testid="catalog-bulk-import-skipped"
        >
          <summary className="cursor-pointer">
            {plan.skipped.length} file{plan.skipped.length === 1 ? '' : 's'} are part of no spec
          </summary>
          <ul className="mt-1 space-y-0.5">
            {plan.skipped.map((item) => (
              <li key={item.path}>
                {item.path} — {item.reason}
              </li>
            ))}
          </ul>
        </details>
      )}

      {error && !running && (
        <div className="shrink-0">
          <Button variant="outline" onClick={() => void runBatch()}>
            Try again
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * The detect-step banner offering bulk mode (MFI-29.5).
 *
 * A payload that holds one spec keeps the single-document wizard; only a payload the plan split
 * into several offers this, and it says exactly what would be created before the user commits.
 */
export function CatalogBulkImportBanner({
  plan,
  onStart,
}: {
  plan: BulkPlan;
  onStart: () => void;
}) {
  const targets = Object.entries(plan.summary.by_target)
    .map(([target, count]) => `${count} → ${target}`)
    .join(', ');
  return (
    <div
      className="shrink-0 rounded-lg border border-accent bg-accent-soft p-4"
      data-testid="catalog-bulk-import-banner"
    >
      <div className="flex items-start gap-2">
        <Layers className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-accent-fg">
            This source holds {plan.items.length} independent spec
            {plan.items.length === 1 ? '' : 's'}
          </div>
          <div className="mt-1 text-xs text-accent-fg">
            Import them all at once — each one is detected, routed, and imported separately
            {targets ? ` (${targets})` : ''}.
            {plan.truncated
              ? ` Only the first ${plan.items.length} of ${plan.total_items} can be imported in one batch.`
              : ''}
          </div>
          <ul className="mt-2 space-y-0.5 text-xs text-accent-fg">
            {plan.items.slice(0, 6).map((item) => (
              <li key={item.key} className="truncate">
                {item.suggested_name} — {item.format ?? 'unrecognised'} → {item.predicted_target}
              </li>
            ))}
            {plan.items.length > 6 && <li>… and {plan.items.length - 6} more</li>}
          </ul>
        </div>
        <Button size="sm" onClick={onStart} data-testid="catalog-bulk-import-start">
          Import all {plan.items.length}
        </Button>
      </div>
    </div>
  );
}

export default CatalogBulkImportPanel;
