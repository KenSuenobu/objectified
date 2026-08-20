'use client';

import * as Progress from '@radix-ui/react-progress';
import {
  AlertTriangle,
  Ban,
  Check,
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
import { eventLevelState, stageRowState } from '@/app/components/ade/export-studio';
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
        <div className="xstd-caps">
          <FileOutput aria-hidden />
          Generating {targetLabel}
        </div>
        <StateBadge state={state} />
      </div>

      {/* Overall progress bar — only meaningful while the job runs. */}
      {inFlight && (
        <div className="flex items-center gap-3" data-testid="generate-progress-bar">
          <Progress.Root
            aria-label={`Export generation progress for ${targetLabel}`}
            className="xstd-progress"
            value={percent}
          >
            <Progress.Indicator
              className="xstd-progress__fill"
              style={{ transform: `translateX(-${100 - (percent || 0)}%)` }}
            />
          </Progress.Root>
          <span className="xstd-progress__value">{percent}%</span>
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
              data-status={stageRowState(stageState)}
              className="xstd-stage"
            >
              <span className="xstd-stage__icon">
                <StageIcon status={stageState} />
              </span>
              <div className="min-w-0">
                <div className="xstd-stage__title">
                  {stage.label}
                  {/* The icon + tint say "done" / "failed" visually; the word says it to everyone. */}
                  <span className="sr-only"> — {stageState}</span>
                </div>
                <div className="xstd-stage__desc">{stage.description}</div>
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
            <Ban aria-hidden />
            Cancel
          </Button>
        </div>
      )}

      {state === 'canceled' && (
        <div className="xstd-notice" data-testid="generate-canceled">
          <span className="xstd-notice__grow">The export was canceled. You can start it again.</span>
          <Button data-testid="generate-canceled-retry" onClick={onRetry} disabled={submitting}>
            <RefreshCw aria-hidden />
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

/**
 * The per-stage glyph.
 *
 * It carries no colour of its own: the row's `data-status` paints both the badge behind it and
 * the frame around the row, which is what keeps the two from drifting the way the pre-Hive
 * `StageIcon` / `stageRowClass` pair could.
 */
function StageIcon({ status }: { status: ExportStageStatus }) {
  switch (status) {
    case 'done':
      return <Check aria-hidden />;
    case 'active':
      return <Loader2 className="motion-safe:animate-spin" aria-hidden />;
    case 'failed':
      return <XCircle aria-hidden />;
    case 'canceled':
      return <Ban aria-hidden />;
    case 'pending':
    default:
      return <CircleDashed aria-hidden />;
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
          className="xstd-event"
          data-level={eventLevelState(event.level)}
        >
          <AlertTriangle aria-hidden />
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
      className="xstd-failure"
      data-testid="generate-failure"
      data-failure-class={failure.class}
      data-recovery={failure.action}
    >
      <div className="xstd-failure__head">
        <Icon aria-hidden />
        <div className="space-y-1">
          <div className="xstd-failure__title">{failure.title}</div>
          <p className="xstd-failure__body" data-testid="generate-failure-remediation">
            {failure.description}
          </p>
          {status.error?.message && (
            <p className="xstd-failure__detail" data-testid="generate-failure-message">
              {status.error.message}
            </p>
          )}
        </div>
      </div>

      {/* Severe-conversion guard reasons (TRANSCODE_CONFIRMATION_REQUIRED). */}
      {reasons.length > 0 && (
        <ul className="xstd-failure__list space-y-0.5" data-testid="generate-guard-reasons">
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
        <p className="xstd-failure__note" data-testid="generate-validation-summary">
          {validation.findings.length}{' '}
          {validation.findings.length === 1 ? 'validation finding' : 'validation findings'} —
          review them in the Verify step.
        </p>
      )}

      <div className="flex flex-wrap justify-end gap-2">
        {/* Secondary retry only when the taxonomy says the same request may succeed (IXH-6.4). */}
        {failure.action !== 'retry' && failure.retriable && (
          <Button variant="outline" data-testid="generate-failure-retry" onClick={onRetry} disabled={submitting}>
            <RefreshCw aria-hidden />
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
