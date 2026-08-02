/**
 * Async export job model + progress/failure presentation helpers (MFX-46.2, #4380).
 *
 * The synchronous `POST /api/export/document` emits the whole artifact in one blocking call; the
 * Studio's Generate phase instead runs the **async export job** pipeline (MFX-3.1, REST
 * `POST /v1/export/{tenant}/jobs` → poll → download): submit, poll the staged progress, and land
 * on a terminal state that is either a downloadable artifact or a structured failure. This module
 * mirrors that job contract field-for-field so a poll payload deserialises directly, and adds the
 * pure presentation logic the Generate phase needs:
 *
 * - the ordered pipeline **stages** and their per-stage status (MFX-3.1 states → a stepper);
 * - the **failure classification** (MFX-3.4 structured error → a user-facing failure class and
 *   the correct recovery action: retry, reconfigure, acknowledge-and-retry, or route back to the
 *   Verify lenses with the validator's detail loaded);
 * - small terminal-state predicates the tracker and the hook share.
 *
 * Everything here is pure (no React, no fetch) so it can be unit-tested directly — mirroring
 * `./exportVerify.ts` and `./exportArtifactPreview.ts`. The polling/lifecycle lives in
 * `./exportJobTracker.ts`; the stepper/failure rendering in `./GenerateProgress.tsx`.
 */

import type { EmittedValidationReport } from './exportVerify';
import type { ExportFidelityEnvelope } from './exportFidelityPreview';

/**
 * The export job lifecycle states (mirrors Python `ExportJobState`, MFX-3.1). An export never
 * holds an open transaction, so the vocabulary is the import job's minus the two-phase-commit
 * states: `queued` accepted, `running` in a pipeline stage, then one terminal state.
 */
export type ExportJobState = 'queued' | 'running' | 'completed' | 'failed' | 'canceled';

/** The pipeline stages, in run order (mirrors the engine's `_STAGES`, MFX-3.1). */
export type ExportJobStageKey =
  | 'loading-source'
  | 'analyzing-fidelity'
  | 'emitting'
  | 'validating'
  | 'packaging';

/** The export delivery gate's single verdict (mirrors Python `DeliveryDecision`, IXH-2.5). */
export type DeliveryDecision = 'allow' | 'allow_with_warning' | 'block';

/** Which of the gate's four inputs a reason came from (mirrors `DeliveryDimension`). */
export type DeliveryDimension = 'validation' | 'lint' | 'fidelity' | 'policy';

/** How much a delivery reason weighs on the decision (mirrors `DeliverySeverity`). */
export type DeliverySeverity = 'info' | 'warning' | 'blocking';

/**
 * One named contribution to the delivery decision (mirrors Python `DeliveryReason`). Branch on
 * {@link code} — a stable, additive-only string — never on the message.
 */
export interface DeliveryReason {
  /** Stable reason code, e.g. `DELIVERY_FIDELITY_BELOW_FLOOR`. */
  code: string;
  /** The input that produced the reason. */
  dimension: DeliveryDimension;
  /** Whether the reason blocked the delivery, warned about it, or is context only. */
  severity: DeliverySeverity;
  /** Ready-to-render sentence explaining this reason. */
  message: string;
  /** Structured backing (the missed floor and the actual value), when the server attaches any. */
  detail?: Record<string, unknown> | null;
}

/** The path a blocked delivery may be unblocked through (mirrors `DeliveryOverride`). */
export interface DeliveryOverride {
  /** False when nothing is blocked, policy forbids overrides, or the artifact is invalid. */
  available: boolean;
  /** Relative URL a waiver is `POST`ed to, when one may be recorded. */
  endpoint?: string | null;
  /** The gate scope a waiver must be recorded under (always `export` here). */
  scope?: string;
  /** The subject key the waiver must carry — the source revision id. */
  subject_key?: string | null;
  /** The export target the waiver must name. */
  format_key?: string | null;
  /** Effective role slugs permitted to record the waiver. */
  roles?: string[];
  /** One sentence telling the user what to do next — render verbatim. */
  instructions: string;
}

/** The signed evidence attached to a delivered artifact (mirrors `DeliveryAttestation`). */
export interface DeliveryAttestation {
  /** The in-toto predicate type of the wrapped statement. */
  predicate_type: string;
  /** False when the server has no signing secret configured (still well-formed, not verifiable). */
  signed: boolean;
  /** The key id a verifier uses to select the shared secret. */
  key_id?: string | null;
  /** Statement timestamp (ISO-8601, UTC). */
  generated_at: string;
  /** The DSSE envelope: `payloadType` / base64 `payload` / `signatures`. */
  envelope: Record<string, unknown>;
}

/**
 * The delivery gate decision for one export (mirrors Python `DeliveryGateReport`, IXH-2.5).
 *
 * One verdict over four dimensions — the emitted-artifact validation, the source's lint grade,
 * the projected fidelity floor, and the tenant's export quality policy — with the named reasons
 * that produced it. A completed job carries it on `result.delivery`; a blocked one carries it on
 * `error.context.delivery`, where {@link deliveryReportFromError} reads it.
 */
export interface DeliveryGateReport {
  /** The single delivery verdict. */
  decision: DeliveryDecision;
  /** True only for `block` — the one flag a delivery surface branches on. */
  blocks_delivery: boolean;
  /** True for `allow_with_warning`. */
  warns: boolean;
  /** Short banner heading for the gate. */
  headline: string;
  /** The full, ready-to-display sentence. */
  message: string;
  /** Every named contribution, blocking reasons first. */
  reasons: DeliveryReason[];
  /** The resolved target format key the decision applies to. */
  target: string;
  /** The source revision's lint grade, when it was graded. */
  source_grade?: string | null;
  /** The source revision's lint score, when it was graded. */
  source_score?: number | null;
  /** The projected preserved-construct percentage the fidelity floor was measured against. */
  preserved_percent?: number | null;
  /** The override path, or its absence. */
  override: DeliveryOverride;
  /** The signed attestation for the delivered artifact; null on a blocked delivery. */
  attestation?: DeliveryAttestation | null;
}

/** A structured job log line (mirrors Python `ExportJobEvent`). */
export interface ExportJobEvent {
  /** Per-job sequence id, e.g. `export-3`. */
  id: string;
  /** Event timestamp, epoch milliseconds. */
  ts: number;
  /** How much the line matters. */
  level: 'info' | 'warn' | 'error';
  /** Stable event code (e.g. `EMITTED`, `SOURCE_LOADED`). */
  code: string;
  /** Human-readable message. */
  message: string;
  /** Structured detail for the line, when the engine attaches any. */
  context?: Record<string, unknown> | null;
}

/** A coarse progress snapshot for the current stage (mirrors Python `ExportJobProgress`). */
export interface ExportJobProgress {
  /** The stage currently running. */
  phase: ExportJobStageKey;
  /** Total pipeline stages for this job. */
  total: number;
  /** Stages finished before {@link phase}. */
  completed: number;
  /** Human hint for the stage (e.g. the target key), when set. */
  current_item?: string | null;
}

/** One emitted file's manifest entry — metadata only (mirrors Python `ExportJobFile`). */
export interface ExportJobFile {
  /** Relative path within the output bundle. */
  path: string;
  /** The file's media type when it differs from the bundle default. */
  media_type?: string | null;
  /** Serialized size of the file's content in bytes. */
  size_bytes: number;
  /** Schema Registry subject when the target assigns one (e.g. Avro). */
  subject?: string | null;
}

/**
 * What a terminal `completed` export job produced (subset of Python `ExportJobResult`). Only the
 * fields the Generate phase renders or forwards are typed; the rest of the envelope deserialises
 * onto {@link ExportFidelityEnvelope} untouched.
 */
export interface ExportJobResult {
  /** The artifact (project) id the job exported. */
  artifact: string;
  /** The resolved revision record id. */
  version_record_id: string;
  /** The resolved revision's version label, e.g. `1.0.0`. */
  version_label?: string | null;
  /** The resolved target format key (e.g. `openapi-3.1`). */
  target: string;
  /** True when the job stopped after the fidelity report (no artifact). */
  dry_run: boolean;
  /** The projection snapshot hash this job computed (EFP-3.1). */
  snapshot_hash?: string;
  /** The per-target emit options the job was submitted with; null when defaults applied. */
  options?: Record<string, unknown> | null;
  /** The full fidelity envelope — the same shape a `/export/preview` returns. */
  fidelity?: ExportFidelityEnvelope | null;
  /** The emitted-output validation gate + report, set on a completed real export. */
  validation?: EmittedValidationReport | null;
  /** The delivery gate decision + attestation (IXH-2.5); null for a dry-run. */
  delivery?: DeliveryGateReport | null;
  /** Manifest of emitted files; empty for a dry-run. */
  files: ExportJobFile[];
  /** The bundle's primary media type; null for a dry-run. */
  media_type?: string | null;
  /** Relative REST URL the artifact bytes are served from; null for a dry-run. */
  download_path?: string | null;
  /** Epoch-ms deadline after which the retained artifact is dropped (MFX-4.3). */
  download_expires_at?: number | null;
}

/**
 * The structured terminal error for a `failed` export job (mirrors Python `ExportJobError`,
 * MFX-3.4 / IXH-6.4). A poller branches on {@link code} for recovery workflow and shows
 * server-owned {@link remediation} / {@link retriable} rather than parsing messages.
 */
export interface ExportJobError {
  /** Stable delivery-taxonomy error code (additive-only; same as the terminal error event). */
  code: string;
  /** Taxonomy category: input, format, capability, policy, resource, transport, or internal. */
  category?: string;
  /** Human-readable failure description. */
  message: string;
  /** Actionable, user-facing next step from the delivery taxonomy. */
  remediation?: string;
  /** Whether retrying the identical request may succeed without changing the input. */
  retriable?: boolean;
  /** Structured detail (e.g. guard reasons, or the validation report for a gate failure). */
  context?: Record<string, unknown> | null;
}

/** The poll payload for an export job (mirrors Python `ExportJobStatus`). */
export interface ExportJobStatus {
  /** The job id from the acceptance payload. */
  job_id: string;
  /** The current lifecycle state. */
  state: ExportJobState;
  /** Coarse completion percent (0–100). */
  percent: number;
  /** The structured event log, oldest first. */
  events: ExportJobEvent[];
  /** The current-stage progress snapshot; absent before the first stage publishes. */
  progress?: ExportJobProgress | null;
  /** The produced artifact, set only in the `completed` terminal state. */
  result?: ExportJobResult | null;
  /** The structured failure, set only in the `failed` terminal state. */
  error?: ExportJobError | null;
}

/** The 202 acceptance payload for a submitted job (mirrors Python `ExportJobAccepted`). */
export interface ExportJobAccepted {
  /** The new job's id. */
  job_id: string;
  /** Relative REST URL to poll until the job is terminal. */
  status_path: string;
}

/** The ordered pipeline stages, each with the copy the Generate stepper renders (MFX-46.2). */
export const EXPORT_JOB_STAGES: {
  key: ExportJobStageKey;
  label: string;
  description: string;
}[] = [
  {
    key: 'loading-source',
    label: 'Load source',
    description: 'Reconstruct the source API from its stored version.',
  },
  {
    key: 'analyzing-fidelity',
    label: 'Analyze fidelity',
    description: 'Measure what the conversion preserves, approximates, or drops.',
  },
  {
    key: 'emitting',
    label: 'Emit',
    description: 'Generate the target document through the emitter.',
  },
  {
    key: 'validating',
    label: 'Validate',
    description: 'Re-parse the emitted artifact to prove it is well-formed.',
  },
  {
    key: 'packaging',
    label: 'Package',
    description: 'Bundle the emitted files for delivery.',
  },
];

/** The terminal lifecycle states — a job in one of these never changes again. */
const TERMINAL_STATES: ReadonlySet<ExportJobState> = new Set(['completed', 'failed', 'canceled']);

/**
 * Whether a job state is terminal (nothing more to poll).
 *
 * @param state The job's lifecycle state.
 * @returns True for `completed` / `failed` / `canceled`.
 */
export function isTerminalExportState(state: ExportJobState): boolean {
  return TERMINAL_STATES.has(state);
}

/** The visual status of one pipeline stage in the Generate stepper. */
export type ExportStageStatus = 'pending' | 'active' | 'done' | 'failed' | 'canceled';

/**
 * Map an error code to the pipeline stage it fails at, so the stepper can mark the right row as
 * failed. A code with no fixed stage (a generic crash) returns null, and the caller falls back to
 * the job's last reported progress stage.
 *
 * @param code The terminal error code, or null/undefined.
 * @returns The stage the code fails at, or null when it is not stage-specific.
 */
export function failedStageForCode(code: string | null | undefined): ExportJobStageKey | null {
  switch (code) {
    case 'SOURCE_LOAD_FAILED':
      return 'loading-source';
    case 'UNSUPPORTED_TARGET':
    case 'TRANSCODE_CONFIRMATION_REQUIRED':
    case 'STALE_PREVIEW':
      return 'analyzing-fidelity';
    case 'EMIT_FAILED':
    case 'EMPTY_EMIT':
      return 'emitting';
    case 'EMITTED_ARTIFACT_INVALID':
    // The delivery gate (IXH-2.5) consumes the validation verdict, so it decides at the end of
    // the validating stage — before anything is packaged.
    case 'EXPORT_DELIVERY_BLOCKED':
      return 'validating';
    case 'PACKAGING_FAILED':
      return 'packaging';
    default:
      return null;
  }
}

/**
 * The stage a failed job stopped at: the error code's fixed stage when it has one, else the last
 * stage the job reported progress for (a generic crash mid-stage), else null.
 *
 * @param status The terminal (or in-flight) job status.
 * @returns The stage the failure is attributed to, or null when unknown.
 */
export function failedStageForStatus(status: ExportJobStatus): ExportJobStageKey | null {
  const byCode = failedStageForCode(status.error?.code);
  if (byCode) return byCode;
  return status.progress?.phase ?? null;
}

/**
 * The visual status of one stage for a given job poll payload (MFX-46.2 "each stage visible"):
 *
 * - `completed` job → every stage `done`.
 * - `failed` job → the stages before the failed stage are `done`, the failed stage is `failed`,
 *   and the rest are `pending`.
 * - `canceled` job → the stages up to where it stopped are `done`, the stop stage and the rest
 *   are `canceled`.
 * - `queued` / `running` → stages before the active one are `done`, the active one is `active`,
 *   and the rest are `pending`.
 *
 * @param stage The stage to classify.
 * @param status The job poll payload.
 * @returns The stage's visual status.
 */
export function stageStatusFor(
  stage: ExportJobStageKey,
  status: ExportJobStatus,
): ExportStageStatus {
  const index = EXPORT_JOB_STAGES.findIndex((s) => s.key === stage);
  if (index < 0) return 'pending';

  if (status.state === 'completed') return 'done';

  // Stages finished so far: the engine reports `completed` as the count of stages done before the
  // current phase. Before any progress publishes (queued), nothing is done yet.
  const completed = status.progress?.completed ?? 0;

  if (status.state === 'failed') {
    const failedStage = failedStageForStatus(status);
    const failedIndex = failedStage
      ? EXPORT_JOB_STAGES.findIndex((s) => s.key === failedStage)
      : completed;
    if (index < failedIndex) return 'done';
    if (index === failedIndex) return 'failed';
    return 'pending';
  }

  if (status.state === 'canceled') {
    return index < completed ? 'done' : 'canceled';
  }

  // queued / running
  const activeIndex = status.progress
    ? EXPORT_JOB_STAGES.findIndex((s) => s.key === status.progress?.phase)
    : -1;
  if (index < completed) return 'done';
  if (index === activeIndex) return 'active';
  return 'pending';
}

/** The user-facing failure class for a job error (MFX-46.2 "each failure class"). */
export type ExportFailureClass =
  | 'source'
  | 'target'
  | 'confirmation'
  | 'stale-preview'
  | 'emitter'
  | 'validation'
  | 'policy'
  | 'packaging'
  | 'delivery'
  | 'canceled'
  | 'unknown';

/**
 * The recovery the failure surface offers:
 *
 * - `retry` — re-submit the same config (transient / server-side failures);
 * - `reconfigure-target` — the target itself is unavailable; send the user back to pick another;
 * - `reconfigure-options` — the options produced nothing usable; send the user back to Options;
 * - `acknowledge-and-retry` — a severe conversion the guard blocked; acknowledge, then re-submit
 *   with confirmation;
 * - `fix-in-verify` — the emitted artifact failed the validation gate; route back to the Verify
 *   lenses with the validator's findings loaded so the user sees exactly what was rejected;
 * - `request-waiver` — the tenant's export quality policy blocked the delivery (IXH-2.5); show
 *   the named reasons and the override path so a permitted role can record a waiver.
 */
export type ExportRecoveryAction =
  | 'retry'
  | 'reconfigure-target'
  | 'reconfigure-options'
  | 'acknowledge-and-retry'
  | 'fix-in-verify'
  | 'request-waiver'
  | 'refresh-preview';

/** The presentation of a job failure: class, stage, copy, and the recovery action + label. */
export interface ExportFailureInfo {
  /** The failure class the surface is toned/titled by. */
  class: ExportFailureClass;
  /** The stage the failure is attributed to, or null when unknown. */
  stage: ExportJobStageKey | null;
  /** The failure surface heading. */
  title: string;
  /** Remediation / class explanation (prefers server taxonomy remediation when present). */
  description: string;
  /** The recovery action the primary button performs. */
  action: ExportRecoveryAction;
  /** The primary button's label. */
  actionLabel: string;
  /**
   * Whether a same-request retry is useful. Prefer the server `retriable` flag when present
   * (IXH-6.4); otherwise inferred from whether the primary recovery is `retry`.
   */
  retriable: boolean;
}

/**
 * Prefer server-owned remediation / retriability (IXH-6.4); keep local code→workflow mapping.
 */
function applyTaxonomyCopy(
  base: Omit<ExportFailureInfo, 'retriable'> & { retriable?: boolean },
  error: ExportJobError | null | undefined,
): ExportFailureInfo {
  const remediation = typeof error?.remediation === 'string' ? error.remediation.trim() : '';
  const serverRetriable =
    typeof error?.retriable === 'boolean' ? error.retriable : undefined;
  return {
    ...base,
    description: remediation || base.description,
    retriable:
      serverRetriable !== undefined ? serverRetriable : (base.retriable ?? base.action === 'retry'),
  };
}

/**
 * Classify a terminal job error into its failure class + recovery action (MFX-46.2, MFX-3.4).
 *
 * The mapping keys off the stable {@link ExportJobError.code} so a poller shows the right surface
 * and the right recovery without parsing the free-form message. Remediation copy and the
 * retriable flag prefer the server taxonomy fields when present (IXH-6.4). An unrecognised
 * code degrades to a generic retryable failure rather than a dead end.
 *
 * @param error The job's structured terminal error, or null.
 * @returns The failure presentation (class, stage, copy, recovery).
 */
export function classifyExportFailure(
  error: ExportJobError | null | undefined,
): ExportFailureInfo {
  const code = error?.code;
  switch (code) {
    case 'SOURCE_LOAD_FAILED':
      return applyTaxonomyCopy(
        {
          class: 'source',
          stage: 'loading-source',
          title: 'Could not load the source',
          description:
            'The source version could not be reconstructed for export. This is usually transient — retry the export.',
          action: 'retry',
          actionLabel: 'Retry export',
        },
        error,
      );
    case 'UNSUPPORTED_TARGET':
      return applyTaxonomyCopy(
        {
          class: 'target',
          stage: 'analyzing-fidelity',
          title: 'Target not available',
          description:
            'This target is no longer available for this source. Choose a different target format and try again.',
          action: 'reconfigure-target',
          actionLabel: 'Choose a different target',
        },
        error,
      );
    case 'TRANSCODE_CONFIRMATION_REQUIRED':
      return applyTaxonomyCopy(
        {
          class: 'confirmation',
          stage: 'analyzing-fidelity',
          title: 'Severe conversion needs confirmation',
          description:
            'The transcoding guard flagged this as a severe conversion. Acknowledge the loss to generate it anyway.',
          action: 'acknowledge-and-retry',
          actionLabel: 'Acknowledge & generate',
        },
        error,
      );
    case 'STALE_PREVIEW':
      return applyTaxonomyCopy(
        {
          class: 'stale-preview',
          stage: 'analyzing-fidelity',
          title: 'The preview snapshot is stale',
          description:
            'The source revision, options, emitter, or capability registry changed since you verified. Re-run verification and acknowledge the current snapshot before generating again.',
          action: 'refresh-preview',
          actionLabel: 'Refresh preview',
        },
        error,
      );
    case 'EMIT_FAILED':
      return applyTaxonomyCopy(
        {
          class: 'emitter',
          stage: 'emitting',
          title: 'The emitter failed',
          description:
            'The target emitter could not produce the document from this source. Retry, or adjust the options and re-verify.',
          action: 'retry',
          actionLabel: 'Retry export',
        },
        error,
      );
    case 'EMPTY_EMIT':
      return applyTaxonomyCopy(
        {
          class: 'emitter',
          stage: 'emitting',
          title: 'The target produced no document',
          description:
            'The emitter ran but produced nothing to export for this source. Adjust the target options and re-verify.',
          action: 'reconfigure-options',
          actionLabel: 'Adjust options',
        },
        error,
      );
    case 'EMITTED_ARTIFACT_INVALID':
      return applyTaxonomyCopy(
        {
          class: 'validation',
          stage: 'validating',
          title: 'The emitted artifact failed validation',
          description:
            'A validator re-parsed the generated artifact and rejected it. Review the validation findings in the Verify step.',
          action: 'fix-in-verify',
          actionLabel: 'Review in Verify',
        },
        error,
      );
    case 'EXPORT_DELIVERY_BLOCKED':
      return applyTaxonomyCopy(
        {
          class: 'policy',
          stage: 'validating',
          title: 'Delivery blocked by quality policy',
          description:
            "This tenant's export quality policy refused the delivery. Review the reasons below, then either raise the source's quality (or pick a higher-fidelity target), or ask a permitted role to record an export waiver.",
          action: 'request-waiver',
          actionLabel: 'How to unblock this',
          retriable: false,
        },
        error,
      );
    case 'PACKAGING_FAILED':
      return applyTaxonomyCopy(
        {
          class: 'packaging',
          stage: 'packaging',
          title: 'Packaging failed',
          description:
            'The emitted files could not be bundled for delivery. This is usually transient — retry the export.',
          action: 'retry',
          actionLabel: 'Retry export',
        },
        error,
      );
    case 'DELIVERY_FAILED':
      return applyTaxonomyCopy(
        {
          class: 'delivery',
          stage: 'packaging',
          title: 'Delivery failed',
          description:
            'The artifact was generated but could not be delivered. Retry — the export itself succeeded.',
          action: 'retry',
          actionLabel: 'Retry delivery',
        },
        error,
      );
    default:
      return applyTaxonomyCopy(
        {
          class: 'unknown',
          stage: null,
          title: 'The export failed',
          description:
            'The export did not complete. This is usually transient — retry, or adjust the configuration and re-verify.',
          action: 'retry',
          actionLabel: 'Retry export',
        },
        error,
      );
  }
}

/**
 * Extract the emitted-output validation report carried by a validation-gate failure
 * (`EMITTED_ARTIFACT_INVALID`), so the Verify lens can render the exact findings the real emit
 * hit (MFX-46.2 "validation-gate failures route back to the Verify lenses with results loaded").
 *
 * The engine attaches the report under `error.context.validation` as an
 * {@link EmittedValidationReport} dump; a shape without a `verdict` string is treated as absent
 * rather than trusted.
 *
 * @param error The job's structured terminal error, or null.
 * @returns The validation report, or null when the error carries none.
 */
export function validationReportFromError(
  error: ExportJobError | null | undefined,
): EmittedValidationReport | null {
  const raw = error?.context?.validation;
  if (!raw || typeof raw !== 'object') return null;
  const report = raw as Partial<EmittedValidationReport>;
  if (typeof report.verdict !== 'string') return null;
  return raw as EmittedValidationReport;
}

/**
 * Read the delivery gate decision back off a failed job's structured error (IXH-2.5).
 *
 * A blocked delivery carries its whole decision — reasons and override path — on
 * `error.context.delivery`, exactly as a completed job carries it on `result.delivery`, so one
 * panel renders both. Returns null for any other failure, or a context whose shape does not
 * match (a server older than IXH-2.5).
 *
 * @param error The job's structured terminal error, or null.
 * @returns The delivery gate decision, or null.
 */
export function deliveryReportFromError(
  error: ExportJobError | null | undefined,
): DeliveryGateReport | null {
  const raw = error?.context?.delivery;
  if (!raw || typeof raw !== 'object') return null;
  const report = raw as Partial<DeliveryGateReport>;
  if (typeof report.decision !== 'string' || !Array.isArray(report.reasons)) return null;
  return raw as DeliveryGateReport;
}

/**
 * The delivery gate decision worth showing for a job, from whichever terminal shape carries it.
 *
 * A completed job's decision is only worth surfacing when it warns — a clean allow has nothing
 * to say — while a failed job's decision is the reason it failed.
 *
 * @param status The job poll payload.
 * @returns The decision to render, or null when there is nothing to say.
 */
export function deliveryReportFor(status: ExportJobStatus): DeliveryGateReport | null {
  if (status.state === 'failed') return deliveryReportFromError(status.error);
  const delivery = status.result?.delivery;
  if (!delivery) return null;
  return delivery.decision === 'allow' ? null : delivery;
}

/**
 * A short, human status line for a job — used in the completion/failure toast and for a11y
 * (MFX-46.2 "toast on completion").
 *
 * @param status The job poll payload.
 * @param targetLabel The human target label (e.g. `OpenAPI 3.1`).
 * @returns One line describing the job's current state.
 */
export function exportJobStatusLine(status: ExportJobStatus, targetLabel: string): string {
  switch (status.state) {
    case 'completed':
      return `Export to ${targetLabel} is ready to download.`;
    case 'failed':
      return `Export to ${targetLabel} failed: ${status.error?.message ?? 'unknown error'}.`;
    case 'canceled':
      return `Export to ${targetLabel} was canceled.`;
    case 'running':
    case 'queued':
    default:
      return `Exporting to ${targetLabel}… ${status.percent}%`;
  }
}
