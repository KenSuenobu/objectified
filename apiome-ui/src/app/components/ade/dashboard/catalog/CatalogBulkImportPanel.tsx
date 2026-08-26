'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Layers, Loader2 } from 'lucide-react';
import { Alert } from '../../../ui/Alert';
import { Button } from '../../../ui/Button';
import { FormatPill } from '../../../ui/catalog/FormatPill';

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
 */

/** A file in the payload that belongs to no importable item. */
export interface BulkSkippedMember {
  path: string;
  reason: string;
}

/** The existing project a planned item resolves to (BLK-1.2). */
export interface BulkMatchedProject {
  project_id: string;
  name: string;
  slug: string;
}

/** The version label a planned item would create, and how it was derived (BLK-1.2). */
export interface BulkProposedVersion {
  version_id: string;
  derived_from: 'default' | 'version-bump' | 'next-available';
  previous_version_id?: string | null;
}

/**
 * One independent spec found in the payload (a row of the plan).
 *
 * The reconciliation fields are optional so the panel still renders against a deployment that
 * predates BLK-1.2 — a plan without them reads as "everything is new", which is exactly what
 * such a server means.
 */
export interface BulkPlanItem {
  key: string;
  root_path: string;
  members: string[];
  total_bytes: number;
  source_kind?: string | null;
  format?: string | null;
  confidence?: number | null;
  importable: boolean;
  predicted_target: 'project' | 'catalog';
  input_kind: 'file' | 'fileset';
  suggested_name: string;
  suggested_slug: string;
  reason: string;
  /** BLK-1.2: what applying this plan now would do with the item. */
  resolution?: 'append-version' | 'create-project' | 'unresolved';
  matched_project?: BulkMatchedProject | null;
  match_basis?: 'repository-provenance' | 'slug' | 'spec-identity' | null;
  match_detail?: string | null;
  match_confidence?: number | null;
  proposed_version?: BulkProposedVersion | null;
}

/** The partition of one payload, as returned by `/api/catalog/import/bulk/plan`. */
export interface BulkPlan {
  items: BulkPlanItem[];
  skipped: BulkSkippedMember[];
  truncated: boolean;
  total_items: number;
  max_items: number;
  source_label: string;
  /** BLK-1.2: the reconciliation policy the plan was resolved under, and which tier set it. */
  version_policy?: 'append-when-matched' | 'always-create' | 'always-ask';
  version_policy_source?: 'repository' | 'tenant' | 'default';
  summary: {
    items: number;
    importable: number;
    unimportable: number;
    skipped_files: number;
    by_target: Record<string, number>;
    by_format: Record<string, number>;
    by_resolution?: Record<string, number>;
    matched?: number;
  };
}

/** A taxonomy-coded failure, either from starting an item or from its job. */
interface BulkItemError {
  code?: string;
  category?: string;
  message?: string;
  remediation?: string;
  retriable?: boolean;
}

interface BulkStartItem {
  key: string;
  root_path: string;
  source_kind?: string | null;
  format?: string | null;
  predicted_target: 'project' | 'catalog';
  name: string;
  slug: string;
  state: 'accepted' | 'failed';
  job_id?: string | null;
  error?: BulkItemError | null;
}

interface BulkStatusItem {
  key: string;
  job_id: string;
  state: string;
  percent: number;
  target?: string | null;
  project_slug?: string | null;
  project_id?: string | null;
  error?: BulkItemError | null;
}

/** One row of the rendered result list: a planned spec plus what became of it. */
interface BulkResultRow {
  key: string;
  name: string;
  format?: string | null;
  target?: string | null;
  state: string;
  projectSlug?: string | null;
  error?: BulkItemError | null;
}

interface CatalogBulkImportPanelProps {
  /** The request body identifying the payload — an archive or a repository selection. */
  source: Record<string, unknown>;
  /** The plan the wizard already fetched and showed the user. */
  plan: BulkPlan;
  /** Called once every item reached a terminal state and at least one was imported. */
  onSuccess?: () => void;
}

/** Terminal job states — the batch stops polling when every item is one of these. */
const TERMINAL_STATES = new Set(['completed', 'failed', 'canceled', 'rolled-back', 'not-found']);

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

/** Render a taxonomy error as the sentence the user can act on. */
function errorText(error: BulkItemError | null | undefined): string {
  if (!error) return '';
  const parts = [error.message, error.remediation].filter(
    (part): part is string => typeof part === 'string' && part.trim().length > 0,
  );
  if (error.code) parts.push(`(code ${error.code})`);
  return parts.join(' ');
}

/** Join the start rows with their job states, so an item that never started still has a row. */
function mergeRows(started: BulkStartItem[], statuses: BulkStatusItem[]): BulkResultRow[] {
  const byKey = new Map(statuses.map((row) => [row.key, row]));
  return started.map((item) => {
    if (item.state === 'failed') {
      return {
        key: item.key,
        name: item.name,
        format: item.format,
        target: item.predicted_target,
        state: 'failed',
        projectSlug: null,
        error: item.error ?? null,
      };
    }
    const job = byKey.get(item.key);
    return {
      key: item.key,
      name: item.name,
      format: item.format,
      target: job?.target ?? item.predicted_target,
      state: job?.state ?? 'queued',
      projectSlug: job?.project_slug ?? null,
      error: job?.error ?? null,
    };
  });
}

export function CatalogBulkImportPanel({ source, plan, onSuccess }: CatalogBulkImportPanelProps) {
  const [rows, setRows] = useState<BulkResultRow[]>([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The batch is started from a click, but React 18 double-invokes effects in development;
  // one guard keeps a re-render from starting the same batch twice.
  const startedRef = useRef(false);

  const runBatch = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const startRes = await fetch('/api/catalog/import/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...source }),
      });
      const startData = await startRes.json().catch(() => ({}));
      if (!startRes.ok || startData?.success === false) {
        throw new Error(startData?.error || 'Failed to start the bulk import.');
      }
      const started: BulkStartItem[] = Array.isArray(startData?.items) ? startData.items : [];
      setRows(mergeRows(started, []));

      const refs = started
        .filter((item) => item.state === 'accepted' && item.job_id)
        .map((item) => ({ key: item.key, job_id: String(item.job_id) }));
      if (refs.length === 0) {
        setDone(true);
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
        const merged = mergeRows(started, statuses);
        setRows(merged);
        if (pollData?.done || merged.every((row) => TERMINAL_STATES.has(row.state))) {
          setDone(true);
          if (merged.some((row) => row.state === 'completed')) onSuccess?.();
          return;
        }
      }
      throw new Error('The bulk import is taking longer than expected. Check the catalog shortly.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to run the bulk import.');
    } finally {
      setRunning(false);
    }
  }, [onSuccess, source]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void runBatch();
  }, [runBatch]);

  const counts = useMemo(() => {
    const completed = rows.filter((row) => row.state === 'completed').length;
    const failed = rows.filter(
      (row) => row.state === 'failed' || row.state === 'canceled' || row.state === 'rolled-back',
    ).length;
    return { completed, failed, pending: rows.length - completed - failed };
  }, [rows]);

  return (
    <div
      className="mt-4 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto"
      data-testid="catalog-bulk-import-panel"
    >
      <div className="flex shrink-0 items-center gap-2 rounded-lg border border-border p-3">
        {done ? (
          <CheckCircle2 className="h-4 w-4 text-ok" aria-hidden />
        ) : (
          <Loader2 className="h-4 w-4 animate-spin text-accent" aria-hidden />
        )}
        <span className="text-sm font-medium text-fg">
          {done
            ? `Bulk import finished: ${counts.completed} imported${
                counts.failed > 0 ? `, ${counts.failed} failed` : ''
              } of ${rows.length}.`
            : `Importing ${plan.items.length} independent spec${plan.items.length === 1 ? '' : 's'}…`}
        </span>
      </div>

      {error && (
        <Alert variant="error" className="shrink-0" data-testid="catalog-bulk-import-error">
          {error}
        </Alert>
      )}

      <ul className="shrink-0 space-y-2" data-testid="catalog-bulk-import-results">
        {rows.map((row) => (
          <li
            key={row.key}
            className="rounded-lg border border-border p-3"
            data-testid={`catalog-bulk-import-item-${row.key}`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-medium text-fg">
                  {row.name}
                </span>
                <FormatPill format={row.format ?? null} />
              </div>
              <div className="flex items-center gap-2">
                {row.target && (
                  <span className="rounded-full border border-border px-2 py-0.5 text-2xs text-fg-muted">
                    {row.target}
                  </span>
                )}
                <span className={`rounded-full border px-2 py-0.5 text-2xs ${stateTone(row.state)}`}>
                  {row.state}
                </span>
              </div>
            </div>
            <div className="mt-1 truncate text-xs text-fg-muted">{row.key}</div>
            {row.projectSlug && (
              <div className="mt-1 text-xs text-fg-muted">
                Created {row.projectSlug}
              </div>
            )}
            {row.error && (
              <div className="mt-1 flex items-start gap-1 text-xs text-danger">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                <span>{errorText(row.error)}</span>
              </div>
            )}
          </li>
        ))}
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
