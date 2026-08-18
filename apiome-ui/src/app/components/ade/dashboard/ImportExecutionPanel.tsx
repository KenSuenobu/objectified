'use client';

/**
 * The Import step (HIVE-6.4, #5315).
 *
 * Authority: `docs/mockups/build/import-wizard.html` §Step 4 — a state badge, a striped
 * progress bar with its primary line and ETA, the per-state actions, a live checklist, the
 * import log, and the technical summary behind a disclosure.
 *
 * The redesign changed the skin and nothing else: the poll, the commit/rollback/retry calls,
 * the completion callback and the eight job states are as they were. What moved out is the
 * *reading* of a state — which badge, which tone, whether the job is still moving and what the
 * one sentence under the bar says — into `importJobPresentation`, so all eight can be asserted
 * without a running job.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../../components/ui/Button';
import { Badge } from '../../../components/ui/Badge';
import { Card, cardVariants } from '../../../components/ui/Card';
import { Alert } from '../../../components/ui/Alert';
import { Progress } from '../../../components/ui/metrics/Progress';
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Info,
  Loader2,
  XCircle,
  RotateCw,
  MinusCircle,
} from 'lucide-react';
import { cancelImport, getImportStatus, commitImport, rollbackImport, retryImport } from '../../../../../lib/db/import-actions';
import {
  getErrorEvents,
  formatEventContext,
  importEventLevel,
  isSkippedEvent,
} from '../../../../../lib/import-execution-error-indicators';
import {
  buildImportLiveChecklist,
  formatProgressPrimaryLine,
  estimateSecondsRemaining,
} from '../../../../../lib/import-execution-live-rows';
import { importJobPresentation, type ImportJobState } from '../import/importWizardModel';

interface ImportExecutionPanelProps {
  jobId: string;
  /** Schema names selected on the Preview step — drives the live checklist (#296). */
  selectedSchemas?: string[];
  onComplete?: (succeeded: boolean) => void;
  /** When user retries a failed/canceled import, called with the new job ID so the dialog can switch to it. */
  onRetry?: (newJobId: string) => void;
  isReviewing?: boolean; // True when viewing from 'done' step via Back button
}

type LogLevel = 'info' | 'warn' | 'error';

interface ImportEvent {
  id: string;
  ts: number;
  level: LogLevel;
  code: string;
  message: string;
  context?: unknown;
}

interface ProgressInfo {
  phase:
    | 'initializing'
    | 'creating-project'
    | 'creating-version'
    | 'creating-properties'
    | 'creating-classes'
    | 'linking-properties'
    | 'verifying'
    | 'finalizing';
  total: number;
  completed: number;
  currentItem?: string;
}

type JobState = ImportJobState;

const IMPORT_LOG_PREVIEW_COUNT = 8;

function formatEtaLine(seconds: number | null): string | null {
  if (seconds == null) return null;
  if (seconds < 60) {
    return seconds === 1
      ? 'Estimated time remaining: about 1 second'
      : `Estimated time remaining: about ${seconds} seconds`;
  }
  const m = Math.max(1, Math.round(seconds / 60));
  return m === 1 ? 'Estimated time remaining: about 1 minute' : `Estimated time remaining: about ${m} minutes`;
}

/** What a checklist row's state looks like: its glyph and the words beside the schema name. */
const CHECKLIST_NOTE: Readonly<Record<string, string>> = {
  success: 'Imported successfully',
  warning: 'Imported with warnings',
  error: 'Failed',
  importing: 'Importing…',
  pending: 'Pending',
};

export default function ImportExecutionPanel({
  jobId,
  selectedSchemas = [],
  onComplete,
  onRetry,
  isReviewing,
}: ImportExecutionPanelProps) {
  const [state, setState] = useState<JobState>('queued');
  const [percent, setPercent] = useState(0);
  const [progress, setProgress] = useState<ProgressInfo | undefined>(undefined);
  const [events, setEvents] = useState<ImportEvent[]>([]);
  const [summary, setSummary] = useState<Record<string, unknown> | null>(null);
  const [isCommitting, setIsCommitting] = useState(false);
  const [isRollingBack, setIsRollingBack] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [transactionPending, setTransactionPending] = useState(false);
  const [logExpanded, setLogExpanded] = useState(false);
  const importStartedAtMs = useRef<number | null>(null);
  const completionNotifiedRef = useRef(false);

  const liveRows = useMemo(
    () => buildImportLiveChecklist(selectedSchemas, events, progress, state),
    [selectedSchemas, events, progress, state]
  );

  const presentation = importJobPresentation(state);
  const primaryLine = formatProgressPrimaryLine(progress, state);
  const etaSeconds = estimateSecondsRemaining(
    percent,
    importStartedAtMs.current != null ? Date.now() - importStartedAtMs.current : 0
  );
  const etaLine =
    presentation.active && percent > 0 && percent < 100 ? formatEtaLine(etaSeconds) : null;

  useEffect(() => {
    completionNotifiedRef.current = false;
    importStartedAtMs.current = null;
  }, [jobId]);

  useEffect(() => {
    let mounted = true;
    let timer: ReturnType<typeof setInterval> | undefined;

    const poll = async () => {
      try {
        const status = await getImportStatus(jobId);
        if (!mounted) return;
        if (importStartedAtMs.current === null && ((status.percent ?? 0) > 0 || (status.events?.length ?? 0) > 0)) {
          importStartedAtMs.current = Date.now();
        }
        setState(status.state as JobState);
        setPercent(status.percent || 0);
        setProgress(status.progress as ProgressInfo | undefined);
        setEvents(status.events || []);
        setSummary(status.summary || null);
        setTransactionPending((status as { transactionPending?: boolean }).transactionPending || false);

        if (importJobPresentation(status.state).terminal) {
          if (timer) clearInterval(timer);
          if (!completionNotifiedRef.current && onComplete) {
            completionNotifiedRef.current = true;
            onComplete(status.state === 'completed');
          }
        }
      } catch {
        // Ignore transient errors
      }
    };

    if (isReviewing) {
      poll();
    } else {
      poll();
      timer = setInterval(poll, 1000);
    }

    return () => {
      mounted = false;
      if (timer) clearInterval(timer);
    };
  }, [jobId, onComplete, isReviewing]);

  const onCancel = async () => {
    await cancelImport(jobId);
  };

  const onAccept = async () => {
    setIsCommitting(true);
    try {
      const result = await commitImport(jobId);
      if (result.success) {
        setState('completed');
        if (onComplete) {
          onComplete(true);
        }
      } else {
        const status = await getImportStatus(jobId);
        setState(status.state as JobState);
        setEvents(status.events || []);
      }
    } catch (e) {
      console.error('Failed to commit:', e);
    } finally {
      setIsCommitting(false);
    }
  };

  const onReject = async () => {
    setIsRollingBack(true);
    try {
      await rollbackImport(jobId);
      setState('rolled-back');
      if (onComplete) {
        onComplete(false);
      }
    } catch (e) {
      console.error('Failed to rollback:', e);
    } finally {
      setIsRollingBack(false);
    }
  };

  const onRetryClick = async () => {
    if (!onRetry) return;
    setIsRetrying(true);
    try {
      const result = await retryImport(jobId);
      if (result.success && result.jobId) {
        onRetry(result.jobId);
      }
    } catch (e) {
      console.error('Failed to retry:', e);
    } finally {
      setIsRetrying(false);
    }
  };

  const levelIcon = (lvl: LogLevel) => {
    if (lvl === 'error') return <XCircle className="size-[var(--icon-dense)] shrink-0 text-danger" aria-hidden />;
    if (lvl === 'warn') return <AlertTriangle className="size-[var(--icon-dense)] shrink-0 text-warn" aria-hidden />;
    return <Info className="size-[var(--icon-dense)] shrink-0 text-accent" aria-hidden />;
  };

  const checklistIcon = (status: (typeof liveRows)[0]['status']) => {
    switch (status) {
      case 'success':
        return <CheckCircle2 className="size-[var(--icon-dense)] shrink-0 text-ok" aria-hidden />;
      case 'warning':
        return <AlertTriangle className="size-[var(--icon-dense)] shrink-0 text-warn" aria-hidden />;
      case 'error':
        return <XCircle className="size-[var(--icon-dense)] shrink-0 text-danger" aria-hidden />;
      case 'importing':
        return <Loader2 className="size-[var(--icon-dense)] shrink-0 animate-spin text-accent" aria-hidden />;
      default:
        return <Circle className="size-[var(--icon-dense)] shrink-0 text-fg-faint" aria-hidden />;
    }
  };

  const errorEvents = getErrorEvents(events);
  const logShown = logExpanded ? events : events.slice(-IMPORT_LOG_PREVIEW_COUNT);
  const logOverflow = events.length > IMPORT_LOG_PREVIEW_COUNT;

  return (
    <div className="flex flex-col gap-4">
      {errorEvents.length > 0 && (
        <Card variant="flat" className="p-[var(--card-pad)]" role="alert" aria-label="Import failures">
          <div className="mb-3 flex items-center gap-2">
            <XCircle className="size-[var(--icon-dense)] shrink-0 text-danger" aria-hidden />
            <h3 className="text-base font-semibold text-fg">Failures ({errorEvents.length})</h3>
          </div>
          <ul className="flex max-h-72 flex-col gap-2 overflow-y-auto">
            {errorEvents.map((ev) => (
              <li key={ev.id} className="imp-row" data-level="error">
                <XCircle className="mt-0.5 size-[var(--icon-dense)] shrink-0 text-danger" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-2xs font-medium text-fg-muted">{ev.code}</div>
                  <div className="mt-0.5 text-sm text-fg">{ev.message}</div>
                  {ev.context != null && (
                    <pre className="imp-log__context">{formatEventContext(ev.context)}</pre>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="p-[var(--card-pad)]">
        <div className="mb-4 flex items-start justify-between gap-3">
          <h3 className="text-base font-semibold text-fg">Import progress</h3>
          <Badge status={presentation.status}>{presentation.label}</Badge>
        </div>

        <div className="mb-3 flex items-center gap-4">
          <Progress
            className="flex-1"
            value={percent}
            tone={presentation.progressTone}
            striped={presentation.active}
            label="Import progress"
          />
          <span className="shrink-0 text-2xl font-semibold tabular-nums text-fg">{percent}%</span>
        </div>

        <p className="text-sm text-fg">{primaryLine}</p>
        <p className="mt-1 text-xs text-fg-muted">{presentation.note}</p>
        {etaLine && <p className="mt-1 text-xs text-fg-muted">{etaLine}</p>}
        {progress && progress.total > 0 && (
          <p className="mt-1 text-xs text-fg-muted">
            Step {progress.completed} of {progress.total}
          </p>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          {state === 'pending-approval' ? (
            <>
              <Button variant="success" onClick={onAccept} disabled={isCommitting || isRollingBack}>
                <CheckCircle2 aria-hidden />
                {isCommitting ? 'Committing...' : 'Accept & commit'}
              </Button>
              <Button variant="danger-soft" onClick={onReject} disabled={isCommitting || isRollingBack}>
                <XCircle aria-hidden />
                {isRollingBack ? 'Rolling back...' : 'Reject & rollback'}
              </Button>
            </>
          ) : state === 'failed' || state === 'canceled' ? (
            <>
              {onRetry && (
                <Button variant="primary" onClick={onRetryClick} disabled={isRetrying}>
                  <RotateCw className={isRetrying ? 'animate-spin' : undefined} aria-hidden />
                  {isRetrying ? 'Starting retry...' : 'Retry import'}
                </Button>
              )}
              <Button variant="outline" onClick={onCancel} disabled={isRetrying}>
                Cancel import
              </Button>
            </>
          ) : presentation.active ? (
            <Button variant="outline" onClick={onCancel}>
              <MinusCircle aria-hidden />
              Cancel import
            </Button>
          ) : null}
        </div>

        {state === 'completed' && summary?.['dryRun'] === true && (
          <Alert variant="info" className="mt-4">
            <span className="font-semibold">Dry run complete. No changes were saved.</span> Review the
            summary below. Uncheck &quot;Dry run (preview only)&quot; and run again to import for real.
          </Alert>
        )}

        {state === 'completed' && summary?.['incrementalMode'] === true && summary?.['dryRun'] !== true && (
          <Alert variant="ok" className="mt-4">
            <span className="font-semibold">Incremental import complete.</span> Successful classes
            were saved; failed classes were skipped. You can open the project in Canvas or close this
            dialog.
          </Alert>
        )}

        {transactionPending && state === 'pending-approval' && (
          <Alert variant="warn" className="mt-4">
            <span className="font-semibold">
              Transaction pending — changes will only be saved if you accept.
            </span>{' '}
            Closing this dialog or rejecting will roll back all changes.
          </Alert>
        )}
      </Card>

      <Card className="p-[var(--card-pad)]">
        <h3 className="mb-3 text-base font-semibold text-fg">Live progress</h3>
        {liveRows.length > 0 ? (
          <ul className="flex max-h-80 flex-col gap-2 overflow-y-auto pr-1" aria-label="Per-schema import status">
            {liveRows.map((row) => (
              <li key={row.id} className="flex items-start gap-2 text-sm">
                {checklistIcon(row.status)}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="font-medium text-fg">{row.label}</span>
                    <span className="text-fg-muted">{CHECKLIST_NOTE[row.status]}</span>
                  </div>
                  {row.detail && <p className="imp-row__note">{row.detail}</p>}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="flex max-h-80 flex-col gap-2 overflow-y-auto">
            {events.length === 0 ? (
              <p className="text-sm text-fg-muted">Waiting for import events…</p>
            ) : (
              events
                .slice()
                .reverse()
                .slice(0, 20)
                .map((ev) => (
                  <div key={ev.id} className="imp-row" data-level={importEventLevel(ev)}>
                    {isSkippedEvent(ev) ? (
                      <MinusCircle
                        className="size-[var(--icon-dense)] shrink-0 text-fg-muted"
                        aria-label="Intentionally skipped"
                      />
                    ) : (
                      levelIcon(ev.level)
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-2xs text-fg-muted">
                        {new Date(ev.ts).toLocaleTimeString()} • {ev.code}
                      </div>
                      <div className={`text-sm ${ev.level === 'error' ? 'font-medium text-fg' : 'text-fg'}`}>
                        {ev.message}
                      </div>
                    </div>
                  </div>
                ))
            )}
          </div>
        )}
      </Card>

      <Card className="p-[var(--card-pad)]">
        <h3 className="mb-3 text-base font-semibold text-fg">Import log</h3>
        <div className="imp-log">
          {logShown.map((ev) => (
            <div key={ev.id} className="imp-log__line" data-level={importEventLevel(ev)}>
              <span className="imp-log__level">
                {isSkippedEvent(ev) ? '[SKIPPED]' : `[${ev.level.toUpperCase()}]`}
              </span>
              <span className="imp-log__time">{new Date(ev.ts).toLocaleTimeString()}</span>
              <span>{ev.message}</span>
              {ev.level === 'error' && ev.context != null && (
                <pre className="imp-log__context">{formatEventContext(ev.context)}</pre>
              )}
            </div>
          ))}
        </div>
        {logOverflow && (
          <Button variant="link" size="sm" className="mt-2" onClick={() => setLogExpanded((e) => !e)}>
            {logExpanded ? 'Show less' : 'Show more…'}
          </Button>
        )}
      </Card>

      {summary && (
        <details className={cardVariants({ className: 'p-[var(--card-pad)]' })}>
            <summary className="flex cursor-pointer list-none items-center gap-2 text-base font-semibold text-fg">
              <CheckCircle2 className="size-[var(--icon-dense)] shrink-0 text-ok" aria-hidden />
              Import summary
              <span className="text-sm font-normal text-fg-muted">(technical details)</span>
            </summary>
            <pre className="imp-log mt-3">{JSON.stringify(summary, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}
