'use client';

/**
 * MCP discovery live-status panel (V2-MCP-24.1 / MCAT-10.1).
 *
 * Rendered inside the Import dialog after the "MCP Server" source creates an endpoint and kicks off
 * a discovery run. It polls the job until it reaches a terminal state, surfaces the live status as a
 * three-stage tracker (connect → discover → grade), and reports completion (success + produced
 * version id, or the failure) back to the dialog. On success it also fetches the freshly scored
 * version's lint report and shows the A–F grade with its MUST/SHOULD tallies, so the quality verdict
 * lands right in the import flow.
 *
 * Re-skinned by HIVE-6.4 (#5315): the tracker is `globals.css` §IMPORT WIZARD's `.imp-stage`,
 * whose state travels as `data-state` rather than as one of four hard-coded fills, and the hero
 * glyph takes the `.tnt-icon-tile` tones the rest of the wizard uses.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, CheckCircle2, Loader2, Network, XCircle } from 'lucide-react';
import { Card } from '../../ui/Card';
import { GradeGlyph } from '../../ui/mcp/GradeGlyph';
import { FindingSeverity } from '../../ui/mcp/FindingSeverity';
import {
  mcpLintReportFromPayload,
  mcpLintTierCounts,
  type McpLintReport,
} from './mcp/mcpLintUi';
import {
  discoveryFailureMessage,
  discoveryStatusLabel,
  discoverySummary,
  isJobSuccess,
  isTerminalJobState,
  versionIdFromJob,
  type McpDiscoveryJob,
} from './mcp/mcpImportFlow';

export interface McpDiscoveryPanelProps {
  endpointId: string;
  jobId: string;
  /** Endpoint display name, for the header. */
  endpointName: string;
  /** Fired once when the job reaches a terminal state. */
  onComplete: (succeeded: boolean, versionId: string | null) => void;
  /** Poll interval in ms (injectable for tests). */
  pollIntervalMs?: number;
}

/** The three stages the tracker renders, mapped from the job state. */
type StageStatus = 'pending' | 'active' | 'done' | 'failed';

/** Resolve each stage's status from the job state (and whether the run failed). */
function stageStatuses(state: string | undefined | null, failed: boolean): StageStatus[] {
  if (failed) {
    // Mark the stage the run died in as failed; earlier stages read as done.
    if (state === 'failed') return ['done', 'failed', 'pending'];
    return ['failed', 'pending', 'pending'];
  }
  switch (state) {
    case 'queued':
      return ['active', 'pending', 'pending'];
    case 'running':
      return ['done', 'active', 'pending'];
    case 'completed':
      return ['done', 'done', 'done'];
    default:
      return ['active', 'pending', 'pending'];
  }
}

const STAGE_LABELS = ['Connect', 'Discover capabilities', 'Lint & grade'] as const;

/**
 * One node in the three-stage tracker.
 *
 * The badge is decoration — the word beside it and the visually-hidden state note are what a
 * screen reader hears — so it is `aria-hidden` and the status travels as `data-state` for the
 * stylesheet to paint.
 *
 * @param props The stage's label and where the run has got to.
 * @returns The stage row.
 */
function StageNode({ label, status }: { label: string; status: StageStatus }) {
  return (
    <li className="imp-stage" data-state={status}>
      <span className="imp-stage__num" aria-hidden>
        {status === 'done' ? (
          <Check className="size-3" />
        ) : status === 'active' ? (
          <Loader2 className="size-3 animate-spin" />
        ) : status === 'failed' ? (
          <XCircle className="size-3" />
        ) : (
          <span className="size-1.5 rounded-full bg-current" />
        )}
      </span>
      {label}
      <span className="sr-only">
        {status === 'done'
          ? 'Completed'
          : status === 'active'
            ? 'In progress'
            : status === 'failed'
              ? 'Failed'
              : 'Not started'}
      </span>
    </li>
  );
}

export default function McpDiscoveryPanel({
  endpointId,
  jobId,
  endpointName,
  onComplete,
  pollIntervalMs = 1500,
}: McpDiscoveryPanelProps) {
  const [job, setJob] = useState<McpDiscoveryJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The produced version's lint report, fetched best-effort after a successful run. */
  const [lint, setLint] = useState<McpLintReport | null>(null);
  const completedRef = useRef(false);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const finish = useCallback((finalJob: McpDiscoveryJob | null, succeeded: boolean) => {
    if (completedRef.current) return;
    completedRef.current = true;
    onCompleteRef.current(succeeded, versionIdFromJob(finalJob));
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const res = await fetch(
          `/api/mcp/endpoints/${encodeURIComponent(endpointId)}/discover/${encodeURIComponent(jobId)}`,
          { credentials: 'include', cache: 'no-store' },
        );
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          throw new Error(typeof data.error === 'string' ? data.error : res.statusText);
        }
        const nextJob = (data.job ?? null) as McpDiscoveryJob | null;
        setJob(nextJob);
        if (nextJob && isTerminalJobState(nextJob.state)) {
          const succeeded = isJobSuccess(nextJob);
          if (!succeeded) {
            setError(discoveryFailureMessage(nextJob));
          }
          finish(nextJob, succeeded);
          return;
        }
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Discovery failed.');
        finish(null, false);
        return;
      }
      timer = setTimeout(() => void poll(), pollIntervalMs);
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [endpointId, jobId, pollIntervalMs, finish]);

  // Once the run has committed a version, pull its lint report (best-effort: a failure just means
  // the grade card is omitted — the report is always available later on the Lint & Score tab).
  const versionId = isJobSuccess(job) ? versionIdFromJob(job) : null;
  useEffect(() => {
    if (!versionId) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/mcp/endpoints/${encodeURIComponent(endpointId)}/versions/${encodeURIComponent(versionId)}/lint`,
          { credentials: 'include', cache: 'no-store' },
        );
        const data = await res.json().catch(() => ({}));
        if (cancelled || !res.ok) return;
        setLint(mcpLintReportFromPayload(data));
      } catch {
        // Ignore — the grade simply is not shown in the success state.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [endpointId, versionId]);

  const state = job?.state;
  const succeeded = isJobSuccess(job);
  const terminal = isTerminalJobState(state) || !!error;
  const summary = succeeded ? discoverySummary(job) : null;
  const stages = stageStatuses(state, !!error || (terminal && !succeeded));
  const lintCounts = lint ? mcpLintTierCounts(lint.findings) : null;

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 py-10 text-center">
      <span
        className="tnt-icon-tile imp-drop__glyph"
        data-tone={terminal ? (succeeded ? 'ok' : 'danger') : 'accent'}
        aria-hidden
      >
        {!terminal ? <Loader2 className="animate-spin" /> : succeeded ? <CheckCircle2 /> : <XCircle />}
      </span>

      <div>
        <h3 className="flex items-center justify-center gap-2 text-lg font-semibold text-fg">
          <Network className="size-[var(--icon-dense)] text-accent" aria-hidden />
          {endpointName}
        </h3>
        <p
          className={`mt-1 text-sm ${terminal && !succeeded ? 'text-danger' : 'text-fg-muted'}`}
          aria-live="polite"
        >
          {error ? error : discoveryStatusLabel(state)}
        </p>
        {summary && (
          <p className="mt-1 text-xs text-fg-muted" aria-live="polite">
            {summary}
          </p>
        )}
      </div>

      <ol className="imp-stages justify-center" aria-label="Import stages">
        {STAGE_LABELS.map((label, index) => (
          <StageNode key={label} label={label} status={stages[index]} />
        ))}
      </ol>

      {/* The freshly scored version's grade, so the quality verdict lands right in the import. */}
      {succeeded && lint ? (
        <Card variant="flat" className="flex flex-wrap items-center justify-center gap-4 px-5 py-4">
          <GradeGlyph variant="gauge" size="sm" grade={lint.grade} score={lint.score} showScore={false} />
          <div className="text-left">
            <div className="text-sm font-semibold text-fg">
              Quality grade: {lint.grade} · {lint.score}/100
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <FindingSeverity tier="must" count={lintCounts?.must ?? 0} />
              <FindingSeverity tier="should" count={lintCounts?.should ?? 0} />
              <FindingSeverity tier="advisory" count={lintCounts?.advisory ?? 0} />
            </div>
            <p className="mt-1.5 text-xs text-fg-muted">
              The full report is on the endpoint&apos;s Lint &amp; Score tab.
            </p>
          </div>
        </Card>
      ) : null}

      {!terminal && (
        <p className="text-xs text-fg-muted">
          This can take a few moments while we connect and list capabilities.
        </p>
      )}
    </div>
  );
}
