'use client';

import * as Progress from '@radix-ui/react-progress';
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  CircleDashed,
  Loader2,
  RefreshCw,
  ScrollText,
  ShieldAlert,
  SlidersHorizontal,
  FileOutput,
  XCircle,
} from 'lucide-react';
import { Button } from '../../../ui/Button';
import { Badge } from '../../../ui/Badge';
import { DeliveryGatePanel } from './DeliveryGatePanel';
import {
  classifyExportFailure,
  deliveryReportFor,
  EXPORT_JOB_STAGES,
  stageStatusFor,
  validationReportFromError,
  type ExportJobEvent,
  type ExportJobStatus,
  type ExportRecoveryAction,
  type ExportStageStatus,
} from './exportJob';
import type { EmittedValidationReport } from './exportVerify';

export interface GenerateProgressProps {
  /** The current job poll payload. */
  status: ExportJobStatus;
  /** The human target label (e.g. `OpenAPI 3.1`), for headings and copy. */
  targetLabel: string;
  /** Whether a submit (start/retry) request is currently in flight (disables the actions). */
  submitting: boolean;
  /** Re-submit the same config (the `retry` recovery). */
  onRetry: () => void;
  /** Request cancellation of the running job. */
  onCancel: () => void;
  /** Send the user back to the Target step (the `reconfigure-target` recovery). */
  onReconfigureTarget: () => void;
  /** Send the user back to the Options step (the `reconfigure-options` recovery). */
  onReconfigureOptions: () => void;
  /** Acknowledge a severe conversion and re-submit with confirmation (`acknowledge-and-retry`). */
  onAcknowledgeAndRetry: () => void;
  /** Route back to the Verify lenses with the validator's findings loaded (`fix-in-verify`). */
  onFixInVerify: (validation: EmittedValidationReport | null) => void;
  /** Route back to Verify to re-run preview/acknowledgement after STALE_PREVIEW (EFP-3.1). */
  onRefreshPreview: () => void;
  /**
   * Open the tenant's quality-waiver flow for a policy-blocked delivery (`request-waiver`,
   * IXH-2.5). Optional: recording a waiver is a governance action, so when no host wires it the
   * panel's override instructions stand on their own and no primary button is offered.
   */
  onRequestWaiver?: () => void;
}

/**
 * GenerateProgress — the Studio Generate phase's staged progress + failure recovery (MFX-46.2).
 *
 * Replaces the single "Generating…" spinner with the async export job's real stages (MFX-3.1):
 * load source → analyze fidelity → emit → validate → package, each row lit by
 * {@link stageStatusFor} (done / active / pending / failed / canceled). A `failed` job renders its
 * **structured** error (MFX-3.4) through {@link classifyExportFailure}: the failure class heading,
 * the job's message, class-specific detail (guard reasons, validation findings), and the one
 * correct recovery action — retry, reconfigure the target/options, acknowledge a severe
 * conversion, or route back to the Verify lenses with the validation results loaded.
 *
 * A `completed` job is rendered by the parent (the artifact preview); this component owns the
 * queued / running / failed / canceled states.
 */
export function GenerateProgress({
  status,
  targetLabel,
  submitting,
  onRetry,
  onCancel,
  onReconfigureTarget,
  onReconfigureOptions,
  onAcknowledgeAndRetry,
  onFixInVerify,
  onRefreshPreview,
  onRequestWaiver,
}: GenerateProgressProps) {
  const { state, percent } = status;
  const inFlight = state === 'queued' || state === 'running';
  const failure = state === 'failed' ? classifyExportFailure(status.error) : null;

  return (
    <div className="space-y-4" data-testid="generate-progress" data-state={state}>
      {/* The job runs while focus sits on the Generate button, so its headline state is announced
          politely rather than only redrawn (MFX-41.5). */}
      <div role="status" className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-900 dark:text-gray-100">
          <FileOutput className="h-4 w-4 text-indigo-500" aria-hidden />
          Generating {targetLabel}
        </div>
        <StateBadge state={state} />
      </div>

      {/* Overall progress bar — only meaningful while the job runs. */}
      {inFlight && (
        <div className="flex items-center gap-3" data-testid="generate-progress-bar">
          <Progress.Root
            aria-label={`Export generation progress for ${targetLabel}`}
            className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700"
            value={percent}
          >
            <Progress.Indicator
              className="h-full bg-gradient-to-r from-indigo-500 to-purple-600 transition-transform duration-300 ease-out"
              style={{ transform: `translateX(-${100 - (percent || 0)}%)` }}
            />
          </Progress.Root>
          <span className="shrink-0 text-sm font-semibold tabular-nums text-gray-900 dark:text-white">
            {percent}%
          </span>
        </div>
      )}

      {/* The pipeline stages — each visible with its status (MFX-46.2 "each stage visible"). */}
      <ol className="space-y-2" data-testid="generate-stages">
        {EXPORT_JOB_STAGES.map((stage) => {
          const stageState = stageStatusFor(stage.key, status);
          return (
            <li
              key={stage.key}
              data-testid={`generate-stage-${stage.key}`}
              data-status={stageState}
              className={`flex items-start gap-3 rounded-lg border p-3 ${stageRowClass(stageState)}`}
            >
              <StageIcon status={stageState} />
              <div className="min-w-0">
                <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  {stage.label}
                  {/* The icon + tint say "done" / "failed" visually; the word says it to everyone. */}
                  <span className="sr-only"> — {stageState}</span>
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400">{stage.description}</div>
              </div>
            </li>
          );
        })}
      </ol>

      {/* Structured warnings surfaced while running (e.g. a skipped validation toolchain). */}
      <EventList events={status.events} />

      {/* Cancel is available only while the job is in flight. */}
      {inFlight && (
        <div className="flex justify-end">
          <Button
            variant="outline"
            data-testid="generate-cancel"
            onClick={onCancel}
            disabled={submitting}
          >
            <Ban className="h-4 w-4" aria-hidden />
            Cancel
          </Button>
        </div>
      )}

      {state === 'canceled' && (
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-gray-800/40"
          data-testid="generate-canceled"
        >
          <p className="text-sm text-gray-700 dark:text-gray-200">
            The export was canceled. You can start it again.
          </p>
          <Button data-testid="generate-canceled-retry" onClick={onRetry} disabled={submitting}>
            <RefreshCw className="h-4 w-4" aria-hidden />
            Generate again
          </Button>
        </div>
      )}

      {failure && (
        <FailureSurface
          status={status}
          failure={failure}
          submitting={submitting}
          onRetry={onRetry}
          onReconfigureTarget={onReconfigureTarget}
          onReconfigureOptions={onReconfigureOptions}
          onAcknowledgeAndRetry={onAcknowledgeAndRetry}
          onFixInVerify={onFixInVerify}
          onRefreshPreview={onRefreshPreview}
          onRequestWaiver={onRequestWaiver}
        />
      )}
    </div>
  );
}

/** The lifecycle state badge in the header. */
function StateBadge({ state }: { state: ExportJobStatus['state'] }) {
  const variant =
    state === 'completed'
      ? 'success'
      : state === 'failed'
        ? 'error'
        : state === 'canceled'
          ? 'secondary'
          : 'default';
  return (
    <Badge variant={variant} data-testid="generate-state-badge">
      {state.toUpperCase()}
    </Badge>
  );
}

/** The per-stage status icon. */
function StageIcon({ status }: { status: ExportStageStatus }) {
  switch (status) {
    case 'done':
      return <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-500" aria-hidden />;
    case 'active':
      return <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-indigo-500" aria-hidden />;
    case 'failed':
      return <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-rose-500" aria-hidden />;
    case 'canceled':
      return <Ban className="mt-0.5 h-5 w-5 shrink-0 text-gray-400" aria-hidden />;
    case 'pending':
    default:
      return <CircleDashed className="mt-0.5 h-5 w-5 shrink-0 text-gray-300 dark:text-gray-600" aria-hidden />;
  }
}

/** The border/background tint for a stage row, keyed by its status. */
function stageRowClass(status: ExportStageStatus): string {
  switch (status) {
    case 'active':
      return 'border-indigo-200 bg-indigo-50 dark:border-indigo-900 dark:bg-indigo-950/30';
    case 'failed':
      return 'border-rose-200 bg-rose-50 dark:border-rose-900 dark:bg-rose-950/30';
    case 'done':
      return 'border-emerald-100 bg-emerald-50/40 dark:border-emerald-950 dark:bg-emerald-950/20';
    case 'canceled':
    case 'pending':
    default:
      return 'border-gray-200 dark:border-gray-700';
  }
}

/** The warn/error events surfaced from the job's structured log (info lines are omitted). */
function EventList({ events }: { events: ExportJobEvent[] }) {
  const notable = events.filter((e) => e.level === 'warn' || e.level === 'error');
  if (notable.length === 0) return null;
  return (
    <ul className="space-y-1.5" data-testid="generate-events">
      {notable.map((event) => (
        <li
          key={event.id}
          data-testid={`generate-event-${event.level}`}
          className={`flex items-start gap-2 rounded-md px-3 py-2 text-xs ${
            event.level === 'error'
              ? 'bg-rose-50 text-rose-800 dark:bg-rose-950/30 dark:text-rose-200'
              : 'bg-amber-50 text-amber-800 dark:bg-amber-950/30 dark:text-amber-200'
          }`}
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>{event.message}</span>
        </li>
      ))}
    </ul>
  );
}

interface FailureSurfaceProps {
  status: ExportJobStatus;
  failure: ReturnType<typeof classifyExportFailure>;
  submitting: boolean;
  onRetry: () => void;
  onReconfigureTarget: () => void;
  onReconfigureOptions: () => void;
  onAcknowledgeAndRetry: () => void;
  onFixInVerify: (validation: EmittedValidationReport | null) => void;
  onRefreshPreview: () => void;
  onRequestWaiver?: () => void;
}

/** The structured failure surface: class heading, message, class detail, and the recovery action. */
function FailureSurface({
  status,
  failure,
  submitting,
  onRetry,
  onReconfigureTarget,
  onReconfigureOptions,
  onAcknowledgeAndRetry,
  onFixInVerify,
  onRefreshPreview,
  onRequestWaiver,
}: FailureSurfaceProps) {
  const validation = validationReportFromError(status.error);
  const delivery = deliveryReportFor(status);
  const reasons = guardReasonsFrom(status.error?.context);

  const runRecovery = (action: ExportRecoveryAction) => {
    switch (action) {
      case 'reconfigure-target':
        onReconfigureTarget();
        break;
      case 'reconfigure-options':
        onReconfigureOptions();
        break;
      case 'acknowledge-and-retry':
        onAcknowledgeAndRetry();
        break;
      case 'fix-in-verify':
        onFixInVerify(validation);
        break;
      case 'refresh-preview':
        onRefreshPreview();
        break;
      case 'request-waiver':
        onRequestWaiver?.();
        break;
      case 'retry':
      default:
        onRetry();
        break;
    }
  };

  const Icon = failure.class === 'validation' ? ShieldAlert : AlertTriangle;
  // A policy block has no in-app recovery unless the host wires the waiver flow: the delivery
  // panel already states the override path, so offering a dead button would be worse than none.
  const showPrimaryAction = failure.action !== 'request-waiver' || Boolean(onRequestWaiver);

  return (
    <div
      className="space-y-3 rounded-lg border border-rose-300 bg-rose-50 p-4 dark:border-rose-800 dark:bg-rose-950/30"
      data-testid="generate-failure"
      data-failure-class={failure.class}
      data-recovery={failure.action}
    >
      <div className="flex items-start gap-3">
        <Icon className="mt-0.5 h-5 w-5 shrink-0 text-rose-600 dark:text-rose-300" aria-hidden />
        <div className="space-y-1">
          <div className="text-sm font-semibold text-rose-900 dark:text-rose-100">
            {failure.title}
          </div>
          <p
            className="text-xs text-rose-800/90 dark:text-rose-200/90"
            data-testid="generate-failure-remediation"
          >
            {failure.description}
          </p>
          {status.error?.message && (
            <p
              className="mt-1 rounded bg-rose-100/60 px-2 py-1 font-mono text-xs text-rose-900 dark:bg-rose-900/30 dark:text-rose-100"
              data-testid="generate-failure-message"
            >
              {status.error.message}
            </p>
          )}
        </div>
      </div>

      {/* Severe-conversion guard reasons (TRANSCODE_CONFIRMATION_REQUIRED). */}
      {reasons.length > 0 && (
        <ul className="ml-8 list-disc space-y-0.5 text-xs text-rose-800 dark:text-rose-200" data-testid="generate-guard-reasons">
          {reasons.map((reason, idx) => (
            <li key={idx}>{reason}</li>
          ))}
        </ul>
      )}

      {/* The delivery gate's named reasons + override path (IXH-2.5), whenever the server
          attached a decision — a policy block, or a validation block the gate also judged. */}
      {delivery && <DeliveryGatePanel delivery={delivery} />}

      {/* Validation-gate summary — the full findings render in the Verify lens after routing. */}
      {failure.class === 'validation' && validation && (
        <p className="ml-8 text-xs text-rose-800 dark:text-rose-200" data-testid="generate-validation-summary">
          {validation.findings.length}{' '}
          {validation.findings.length === 1 ? 'validation finding' : 'validation findings'} —
          review them in the Verify step.
        </p>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        {/* Secondary retry only when the taxonomy says the same request may succeed (IXH-6.4). */}
        {failure.action !== 'retry' && failure.retriable && (
          <Button variant="outline" data-testid="generate-failure-retry" onClick={onRetry} disabled={submitting}>
            <RefreshCw className="h-4 w-4" aria-hidden />
            Retry export
          </Button>
        )}
        {showPrimaryAction && (
          <Button
            data-testid="generate-failure-action"
            onClick={() => runRecovery(failure.action)}
            disabled={submitting || (failure.action === 'retry' && !failure.retriable)}
          >
            {recoveryIcon(failure.action)}
            {failure.actionLabel}
          </Button>
        )}
      </div>
    </div>
  );
}

/** The primary recovery button's icon, keyed by the action. */
function recoveryIcon(action: ExportRecoveryAction) {
  switch (action) {
    case 'reconfigure-target':
      return <FileOutput className="h-4 w-4" aria-hidden />;
    case 'reconfigure-options':
      return <SlidersHorizontal className="h-4 w-4" aria-hidden />;
    case 'fix-in-verify':
      return <ShieldAlert className="h-4 w-4" aria-hidden />;
    case 'request-waiver':
      return <ScrollText className="h-4 w-4" aria-hidden />;
    case 'refresh-preview':
    case 'acknowledge-and-retry':
    case 'retry':
    default:
      return <RefreshCw className="h-4 w-4" aria-hidden />;
  }
}

/** Pull the transcoding guard's human reasons from a failure context, when present. */
function guardReasonsFrom(context: Record<string, unknown> | null | undefined): string[] {
  const reasons = context?.reasons;
  if (!Array.isArray(reasons)) return [];
  return reasons.filter((r): r is string => typeof r === 'string');
}

export default GenerateProgress;
