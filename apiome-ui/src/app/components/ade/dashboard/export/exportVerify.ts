/**
 * One-call Verify result envelope + verdict/lens presentation helpers (MFX-42.1, #4354).
 *
 * The Studio's Verify step runs a single dry-run that returns all three verification lenses at
 * once — fidelity (MFX-2.5/6.2), emitted-output validation (MFX-5.1/5.3), and emitted-artifact
 * lint (MFX-5.2) — through the one-call verify endpoint (MFX-42.5, `POST /api/export/verify`),
 * **without** producing or persisting an artifact. This module mirrors that response field-for-
 * field so it deserialises directly, and adds the pure presentation logic the workbench needs:
 * the go/no-go verdict band (`clean` / `lossy` / `invalid`, per MFX-5.3 gating + MFX-3.3
 * severity), the banner copy/tone per verdict, the per-lens badge counts, and the Generate gate.
 *
 * Everything here is pure (no React, no fetch) so it can be unit-tested directly — mirroring
 * `./exportFidelityPreview.ts` and `./exportTargetCatalog.ts`. The lens *rendering* deepens in
 * MFX-42.2 (validation), 42.3 (lint) and 42.4 (fidelity); this module owns the orchestration
 * verdict those lenses hang under.
 */

import {
  requiresExportAcknowledgement,
  type AcknowledgementMode,
  type ExportFidelityEnvelope,
} from './exportFidelityPreview';
import type { LintSeverity } from '../../../../utils/version-lint-report';

/**
 * The emitted-output validation band (mirrors Python `ValidationVerdict`, MFX-5.3):
 * `valid` re-parsed cleanly · `invalid` a validator ran and rejected (blocks delivery) ·
 * `skipped` a required toolchain was unavailable (warns, does not block) · `not_applicable`
 * no importer matches the format (nothing to validate).
 */
export type EmittedValidationVerdict = 'valid' | 'invalid' | 'skipped' | 'not_applicable';

/** One structured emitted-artifact validation failure (mirrors Python `ValidationFinding`). */
export interface EmittedValidationFinding {
  /** Human-readable failure description. */
  message: string;
  /** JSON-pointer path into the emitted document, when the validator provides one. */
  path?: string | null;
  /** File within a multi-file bundle the failure is in, when applicable. */
  file?: string | null;
  /** 1-based line number when the validator reports a location. */
  line?: number | null;
  /** 1-based column number when the validator reports a location. */
  column?: number | null;
  /** Validator-specific rule keyword (e.g. a JSON Schema `keyword`), when available. */
  keyword?: string | null;
}

/**
 * The emitted-output validation gate + report (mirrors Python `EmittedValidationReport`,
 * MFX-5.3). The single gate the export surfaces read is {@link blocks_delivery} (true only for
 * an `invalid` verdict); {@link warns} is true only for a `skipped` (toolchain-unavailable) one.
 */
export interface EmittedValidationReport {
  /** The validation band: valid / invalid / skipped / not_applicable. */
  verdict: EmittedValidationVerdict;
  /** The resolved target format key that was validated (e.g. `openapi-3.1`). */
  target: string;
  /** True only for an `invalid` verdict — a validator ran and rejected the artifact. */
  blocks_delivery: boolean;
  /** True only for a `skipped` verdict — validation could not run (toolchain unavailable). */
  warns: boolean;
  /** Whether the emitted artifact re-parsed cleanly when validation ran. */
  valid: boolean;
  /** The validator identity that ran (or would have run) for this target, when known. */
  tool?: string | null;
  /** Structured parser/toolchain failures for UI rendering; non-empty only when `invalid`. */
  findings: EmittedValidationFinding[];
  /** Why validation did not run (skipped / not_applicable); null when validation ran. */
  detail?: string | null;
  /** Short banner heading for the validation gate (e.g. `Invalid — export blocked`). */
  headline: string;
  /** The user-facing gate message. */
  message: string;
}

/** One emitted-artifact lint finding (mirrors the import-side `LintFindingOut` shape, MFX-5.2). */
export interface EmittedLintFinding {
  /** How much the finding matters: error / warning / info. */
  severity: LintSeverity;
  /** The lint rule id that fired (e.g. `oas3-schema` or a target pack rule). */
  rule: string;
  /** Human-readable description of the finding. */
  message: string;
  /** The rule's category grouping, when the pack provides one. */
  category?: string | null;
  /** File within a multi-file bundle the finding is in, when applicable. */
  file?: string | null;
  /** JSON-pointer path into the emitted document, when the linter provides one. */
  path?: string | null;
  /** 1-based line number when the linter reports a location. */
  line?: number | null;
  /** 1-based column number when the linter reports a location. */
  column?: number | null;
}

/**
 * The emitted-artifact lint report for one export (MFX-5.2), advisory (it never blocks the
 * gate). When {@link applicable} is false the target has no lint pack — the lens shows an
 * explicit empty state rather than a misleading clean score.
 */
export interface EmittedArtifactLintReport {
  /** Whether a lint pack is registered for this target's format. */
  applicable: boolean;
  /** The lint pack that ran (e.g. `spectral:oas`), when applicable. */
  pack?: string | null;
  /** The 0–100 quality score, when the pack computes one. */
  score?: number | null;
  /** The A–F letter grade, when the pack computes one. */
  grade?: string | null;
  /** The itemized findings, in the server's order. */
  findings: EmittedLintFinding[];
}

/**
 * The overall Verify verdict band shown in the workbench banner (MFX-42.1 / MFX-42.4):
 * `clean` green go · `lossy` acknowledge-to-continue (checkbox) · `severe` typed
 * acknowledge-to-continue (a types-only / near-empty reduction, MFX-3.3) · `invalid` export
 * blocked.
 *
 * `severe` is a UI-only refinement of the band the server reports: the endpoint's own `verdict`
 * only distinguishes `clean` / `lossy` / `invalid` (a types-only conversion is a `lossy` band
 * there), so the workbench promotes a `lossy`-tier result to `severe` when the transcoding guard
 * (MFX-3.3) classifies it near-empty/severe — see {@link deriveVerifyVerdict}.
 */
export type ExportVerifyVerdict = 'clean' | 'lossy' | 'severe' | 'invalid';

/**
 * The transcoding guard's coarse conversion band (mirrors Python `TranscodeVerdict`, MFX-3.3):
 * `clean` lossless · `lossy` some loss but the operational surface survives · `near-empty` a
 * types-only target keeps only the schemas and drops every operation/channel · `severe` the
 * target structurally cannot represent the source's essence (a nonsensical paradigm shift) or the
 * export drops a critical construct. The last two are the ones the Verify gate treats as `severe`.
 */
export type TranscodeVerdict = 'clean' | 'lossy' | 'near-empty' | 'severe';

/**
 * The pre-flight transcoding guard for one (source, target) conversion (mirrors Python
 * `TranscodeGuard`, MFX-3.3). The Verify workbench reads its {@link verdict} to tell a types-only /
 * near-empty reduction (which needs the explicit typed acknowledgement) apart from an ordinary
 * lossy conversion (the checkbox), and renders its verbatim {@link message} as the guard's *why*.
 */
export interface ExportTranscodeGuard {
  /** The conversion band: clean / lossy / near-empty / severe. */
  verdict: TranscodeVerdict;
  /** Whether the emit must be explicitly confirmed before it runs (true only for `severe`). */
  requires_confirmation: boolean;
  /** Human label for the target format woven into the copy (e.g. `Apache Avro`). */
  target_format: string;
  /** Estimated share of constructs carried faithfully, 0–100. */
  preserved_percent: number;
  /** Source operations the target structurally cannot represent (0 when it can carry operations). */
  dropped_operations: number;
  /** Source event channels the target structurally cannot represent (0 when it can carry events). */
  dropped_events: number;
  /** Short banner heading for the guard. */
  headline: string;
  /** The full, ready-to-display guard sentence; consumers render it verbatim. */
  message: string;
  /** The structured *why*: one line per contributing factor. */
  reasons?: string[];
}

/**
 * The `POST /api/export/verify` response (mirrors REST `ExportVerifyResponse`, MFX-42.5).
 *
 * Carries all three lenses computed in one dry-run plus an optional server-side {@link verdict}.
 * The shape is a superset of `ExportPreviewResponse` (same source coordinates + `fidelity`
 * envelope), so the fidelity lens reuses the existing warning panel unchanged.
 */
export interface ExportVerifyResponse {
  /** The artifact (project / catalog-item) id the verification was computed for. */
  artifact: string;
  /** The version selector as requested (label, UUID, or null for latest). */
  version?: string | null;
  /** The resolved revision record id. */
  version_record_id: string;
  /** The resolved revision's version label, e.g. `"1.2.0"`. */
  version_label?: string | null;
  /** The full fidelity envelope (target + summary + per-construct report + advisory). */
  fidelity: ExportFidelityEnvelope;
  /**
   * The pre-flight transcoding guard (MFX-3.3): the conversion band + why. Present on every real
   * verify response; optional here so fixtures/older payloads without it still type-check — a
   * missing guard falls back to the fidelity tier for the severe/lossy split (see
   * {@link isSevereConversion}).
   */
  guard?: ExportTranscodeGuard | null;
  /** The emitted-output validation gate + report (MFX-5.3). */
  validation: EmittedValidationReport;
  /** The emitted-artifact lint report (MFX-5.2); null when the endpoint ran no lint pass. */
  lint: EmittedArtifactLintReport | null;
  /**
   * The server-computed overall verdict, when the endpoint supplies one. The workbench prefers
   * this; when absent it derives the same band from the lenses via {@link deriveVerifyVerdict}.
   */
  verdict?: ExportVerifyVerdict | null;
}

/**
 * Whether a verify result is a *severe* conversion (MFX-42.4) — a types-only / near-empty
 * reduction that exports only the source's schemas, dropping its whole operational surface, or a
 * structurally nonsensical paradigm shift / critical-construct drop. A severe conversion is gated
 * by the explicit **typed** acknowledgement rather than the lossy "Export anyway" checkbox.
 *
 * The transcoding guard (MFX-3.3) is the authority when present — its `near-empty` and `severe`
 * bands are exactly this case. When no guard rode along (older payloads / fixtures) the fidelity
 * tier stands in: a `types-only` tier is the near-empty reduction.
 *
 * @param result The verify result to inspect.
 * @returns True when the conversion is severe (types-only / near-empty / structurally severe).
 */
export function isSevereConversion(result: ExportVerifyResponse): boolean {
  const guard = result.guard;
  if (guard) return guard.verdict === 'severe' || guard.verdict === 'near-empty';
  return result.fidelity.summary.tier === 'types-only';
}

/**
 * The overall go/no-go verdict for a verify result (MFX-42.1 / MFX-42.4), per the MFX-5.3 gate +
 * the MFX-3.3 transcoding guard:
 *
 * - **invalid** — a validator ran and rejected the artifact ({@link EmittedValidationReport.blocks_delivery},
 *   or the server said so); the export is blocked and no acknowledgement can override it.
 * - **severe** — a types-only / near-empty (or structurally severe) conversion ({@link isSevereConversion});
 *   the user may continue only after the explicit **typed** acknowledgement (MFX-42.4).
 * - **lossy** — any other non-lossless conversion; the user may continue after the "Export anyway"
 *   checkbox (MFX-6.2).
 * - **clean** — a lossless conversion that validated (or was not-applicable/skipped); the green
 *   path. A `skipped` validation (toolchain unavailable) warns but does not demote a clean band.
 *
 * `invalid` and `severe` are evaluated first because they refine what the server's own
 * {@link ExportVerifyResponse.verdict} reports: the endpoint has no `severe` band (it reports a
 * types-only conversion as `lossy`), so the client promotes a severe conversion here and otherwise
 * honours the server verdict, keeping the Generate gate stricter-or-equal to the server's.
 *
 * @param result The verify result to classify.
 * @returns The overall verdict band.
 */
export function deriveVerifyVerdict(result: ExportVerifyResponse): ExportVerifyVerdict {
  if (result.verdict === 'invalid' || result.validation.blocks_delivery) return 'invalid';
  if (isSevereConversion(result)) return 'severe';
  if (result.verdict) return result.verdict;
  if (requiresExportAcknowledgement(result.fidelity.summary.tier)) return 'lossy';
  return 'clean';
}

/** The verdict banner's presentation: its short label, longer description, and colour tone. */
export interface VerifyVerdictBanner {
  /** The banner heading (e.g. `Invalid — export blocked`). */
  label: string;
  /** The one-line explanation under the heading. */
  description: string;
  /** The colour tone driving the banner classes and icon. */
  tone: 'clean' | 'lossy' | 'severe' | 'invalid';
}

/**
 * The banner copy + tone for a verdict (MFX-42.1 / MFX-42.4). The labels are the roadmap's exact
 * strings so the Verify and Review steps read identically:
 * `Clean` / `Lossy — acknowledge to continue` / `Severe — acknowledge to continue` /
 * `Invalid — export blocked`.
 *
 * @param verdict The overall verdict band.
 * @returns The banner label, description, and tone.
 */
export function verifyVerdictBanner(verdict: ExportVerifyVerdict): VerifyVerdictBanner {
  switch (verdict) {
    case 'invalid':
      return {
        label: 'Invalid — export blocked',
        description:
          'A validator re-parsed the emitted artifact and rejected it. Fix the source or choose a different target — this export cannot be generated.',
        tone: 'invalid',
      };
    case 'severe':
      return {
        label: 'Severe — acknowledge to continue',
        description:
          'The target is a types-only format: this export produces a types-only artifact — only the schemas survive and every operation and channel is dropped. Review the fidelity lens, then type the acknowledgement to continue.',
        tone: 'severe',
      };
    case 'lossy':
      return {
        label: 'Lossy — acknowledge to continue',
        description:
          'The artifact is valid but the conversion drops or approximates some constructs. Review the fidelity lens, then acknowledge the loss to continue.',
        tone: 'lossy',
      };
    case 'clean':
    default:
      return {
        label: 'Clean',
        description:
          'The conversion is lossless and the emitted artifact validated cleanly. You can generate this export.',
        tone: 'clean',
      };
  }
}

/**
 * The `Alert` variant for the verdict banner, keyed by tone.
 *
 * HIVE-8.3 (#5329) replaced the four Tailwind palette quintuples this returned with the
 * shared alert variants, so the banner follows all nine themes. `severe` and `invalid` share
 * `error` deliberately: both are *stop* verdicts, and the words above them — "Severe
 * conversion" against "The emitted artifact is invalid" — are what separate the two. Painting
 * one a redder red than the other asked colour to carry a distinction it cannot.
 */
export function verifyVerdictAlertVariant(
  tone: VerifyVerdictBanner['tone'],
): 'error' | 'warning' | 'success' {
  switch (tone) {
    case 'invalid':
    case 'severe':
      return 'error';
    case 'lossy':
      return 'warning';
    case 'clean':
    default:
      return 'success';
  }
}

/** The three Verify lenses, in their tab / accordion order. */
export type VerifyLensKey = 'fidelity' | 'validation' | 'lint';

/**
 * The count shown on a lens's tab badge (MFX-42.1): the number of items that lens surfaces —
 * fidelity: constructs that are not carried faithfully (drop + approx + synth); validation:
 * structured errors; lint: findings. Zero renders a neutral/clean badge.
 *
 * @param lens The lens whose badge count is wanted.
 * @param result The verify result, or null before a run.
 * @returns The badge count (0 when there is nothing to flag or no result yet).
 */
export function lensBadgeCount(lens: VerifyLensKey, result: ExportVerifyResponse | null): number {
  if (!result) return 0;
  switch (lens) {
    case 'fidelity': {
      const counts = result.fidelity.report.kind_counts;
      return (counts.drop ?? 0) + (counts.approx ?? 0) + (counts.synth ?? 0);
    }
    case 'validation':
      return result.validation.findings.length;
    case 'lint':
      return result.lint?.findings.length ?? 0;
    default:
      return 0;
  }
}

/**
 * The visual state the validation lens renders in (MFX-42.2). It tracks the report's verdict
 * one-for-one but renames `skipped` to `unavailable` to name the case the lens must surface as a
 * *warning* — an external toolchain (e.g. `buf build`) was not installed on the server, so the
 * artifact was **not** validated — never as silent success:
 *
 * - **valid** — a validator ran and the emitted artifact re-parsed cleanly (the positive verdict).
 * - **invalid** — a validator ran and rejected the artifact (blocks delivery); findings render.
 * - **unavailable** — the required toolchain was missing; validation could not run (warns).
 * - **not_applicable** — no validator matches the target format; there is nothing to validate.
 *
 * @param validation The emitted-output validation report.
 * @returns The lens presentation state.
 */
export function validationLensState(validation: EmittedValidationReport): ValidationLensState {
  switch (validation.verdict) {
    case 'invalid':
      return 'invalid';
    case 'skipped':
      return 'unavailable';
    case 'not_applicable':
      return 'not_applicable';
    case 'valid':
    default:
      return 'valid';
  }
}

/** The four states the validation lens can present (MFX-42.2). */
export type ValidationLensState = 'valid' | 'invalid' | 'unavailable' | 'not_applicable';

/** The colour tone driving the validation lens's headline icon and classes. */
export type ValidationLensTone = 'ok' | 'invalid' | 'warn' | 'neutral';

/**
 * The colour tone for a validation lens state (MFX-42.2): a clean pass is `ok` (green), a
 * rejection is `invalid` (red), a missing toolchain is `warn` (amber — distinct from success),
 * and a not-applicable format is `neutral`.
 *
 * @param state The validation lens state.
 * @returns The tone token.
 */
export function validationLensTone(state: ValidationLensState): ValidationLensTone {
  switch (state) {
    case 'invalid':
      return 'invalid';
    case 'unavailable':
      return 'warn';
    case 'not_applicable':
      return 'neutral';
    case 'valid':
    default:
      return 'ok';
  }
}

/**
 * The validator identity to display, trimmed, or null when the report names no tool (MFX-42.2).
 * Drives the "Validated with `buf build`" / "`xmlschema` is not installed on the server" lines so
 * the user knows which toolchain produced (or would have produced) the verdict.
 *
 * @param validation The emitted-output validation report.
 * @returns The tool identity, or null when none is known.
 */
export function validatorToolLabel(validation: EmittedValidationReport): string | null {
  const tool = validation.tool?.trim();
  return tool ? tool : null;
}

/** Per-severity counts for a lint report's findings, zero-filled for every severity. */
export function lintSeverityCounts(
  findings: EmittedLintFinding[],
): Record<LintSeverity, number> {
  const counts: Record<LintSeverity, number> = { error: 0, warning: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

/**
 * The visual state the emitted-artifact lint lens renders in (MFX-42.3):
 *
 * - **not_applicable** — no lint pack is registered for the target's format (`applicable === false`
 *   or no report at all); the lens shows an explicit empty state, never a misleading clean score.
 * - **clean** — a lint pack ran and reported no findings; the lens shows a positive confirmation.
 * - **findings** — a lint pack ran and reported one or more findings; the grouped list renders.
 *
 * The lint lens is advisory — it never gates the export (the workbench verdict owns Generate) — so
 * every state is informational.
 *
 * @param lint The emitted-artifact lint report, or null when the endpoint ran no lint pass.
 * @returns The lens presentation state.
 */
export function emittedLintLensState(lint: EmittedArtifactLintReport | null): EmittedLintLensState {
  if (!lint || !lint.applicable) return 'not_applicable';
  return lint.findings.length > 0 ? 'findings' : 'clean';
}

/** The three states the emitted-artifact lint lens can present (MFX-42.3). */
export type EmittedLintLensState = 'not_applicable' | 'clean' | 'findings';

/** A group of lint findings sharing one severity, in the grouped findings list (MFX-42.3). */
export interface EmittedLintSeverityGroup {
  /** The severity all findings in the group share. */
  severity: LintSeverity;
  /** The findings of that severity, in the server's order. */
  findings: EmittedLintFinding[];
}

/** Lint severity order, most severe first — mirrors the catalog panel's MUST/SHOULD/advisory tiers. */
const LINT_SEVERITY_ORDER: readonly LintSeverity[] = ['error', 'warning', 'info'];

/**
 * Group lint findings by severity in error → warning → info order (MFX-42.3), preserving the
 * server's order within each severity and dropping empty groups. This mirrors the catalog lint
 * panel's requirement-tier grouping (MUST/SHOULD/advisory) so the emitted-artifact lens and the
 * source's catalog lint read the same.
 *
 * @param findings The lint findings to group.
 * @returns One group per non-empty severity, most severe first.
 */
export function groupLintFindingsBySeverity(
  findings: EmittedLintFinding[],
): EmittedLintSeverityGroup[] {
  return LINT_SEVERITY_ORDER.map((severity) => ({
    severity,
    findings: findings.filter((finding) => finding.severity === severity),
  })).filter((group) => group.findings.length > 0);
}

/** A lint report's 0–100 score plus its display letter grade (MFX-42.3). */
export interface EmittedLintScore {
  /** The 0–100 quality score the pack computed. */
  score: number;
  /** The display letter grade — the pack's grade trimmed, or `–` when it supplies none. */
  grade: string;
}

/**
 * The score/grade to display for a lint report, or null when the pack computes none (MFX-42.3).
 *
 * Only a numeric {@link EmittedArtifactLintReport.score} counts as present — a report without one
 * renders its findings without a (misleading) score chip. The letter grade falls back to a dash so
 * the chip always has a stable shape, matching the catalog lint gauge's `–` placeholder.
 *
 * @param lint The emitted-artifact lint report, or null.
 * @returns The score + display grade, or null when there is no numeric score.
 */
export function emittedLintScore(lint: EmittedArtifactLintReport | null): EmittedLintScore | null {
  if (!lint || typeof lint.score !== 'number') return null;
  return { score: lint.score, grade: (lint.grade ?? '').trim() || '–' };
}

/** The number of distinct lint rules that fired across a report's findings (MFX-42.3). */
export function lintRulesTriggered(findings: EmittedLintFinding[]): number {
  return new Set(findings.map((finding) => finding.rule)).size;
}

/**
 * Whether the Verify gate permits generating the export (MFX-42.1 / MFX-42.4 acceptance):
 *
 * - **invalid** — never; the export is blocked regardless of acknowledgement.
 * - **severe** — only once the types-only outcome has been acknowledged (the typed acknowledgement).
 * - **lossy** — only once the loss has been acknowledged (the "Export anyway" checkbox).
 * - **clean** — always.
 *
 * Severe and lossy share the single `acknowledged` flag — only one verdict is ever in play at a
 * time, and the fidelity panel renders the matching control (typed input vs checkbox) that drives
 * it (see {@link fidelityAcknowledgementMode}).
 *
 * @param verdict The overall verdict, or null before a verification has run.
 * @param acknowledged Whether the user has acknowledged a lossy/severe conversion.
 * @returns True when Generate should be enabled.
 */
export function verifyGatePasses(
  verdict: ExportVerifyVerdict | null,
  acknowledged: boolean,
): boolean {
  if (!verdict) return false;
  if (verdict === 'invalid') return false;
  if (verdict === 'lossy' || verdict === 'severe') return acknowledged;
  return true;
}

/**
 * Which acknowledgement control the fidelity lens must show for a verdict (MFX-42.4):
 *
 * - **typed** — a `severe` conversion needs the explicit typed acknowledgement (the user types the
 *   {@link EXPORT_TYPES_ONLY_ACK_PHRASE} phrase to confirm the types-only outcome);
 * - **checkbox** — a `lossy` conversion needs the "Export anyway" checkbox (MFX-6.2);
 * - **hidden** — `clean` needs none, and `invalid` cannot be overridden, so no control is shown.
 *
 * @param verdict The overall verdict, or null before a verification has run.
 * @returns The acknowledgement control to render.
 */
export function fidelityAcknowledgementMode(
  verdict: ExportVerifyVerdict | null,
): AcknowledgementMode {
  if (verdict === 'severe') return 'typed';
  if (verdict === 'lossy') return 'checkbox';
  return 'hidden';
}

export type { AcknowledgementMode } from './exportFidelityPreview';
