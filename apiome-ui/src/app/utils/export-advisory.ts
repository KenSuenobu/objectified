/**
 * The user-facing fidelity advisory for a cross-format export (MFX-2.4, #3841).
 *
 * When a canonical API is exported to a target format, some constructs may be dropped,
 * approximated, or synthesized. apiome-rest's fidelity engine (`app/fidelity_engine.py`,
 * MFX-2.2) computes a structured lossiness report, and `app/fidelity_advisory.py` (MFX-2.4)
 * distills it into a single **user-facing advisory** — the plain-language *"exporting to
 * {format} may lose some fidelity"* message, its severity, and the counts that make it honest.
 *
 * **The wording lives server-side, once.** This module never re-templates the advisory copy:
 * the `message` and `headline` are computed in Python and carried verbatim in the export /
 * dry-run response (MFX-2.5), so the export dialog (MFX-6.2), the public browse export
 * (MFX-7.2), and the CLI (MFX-8.2) all render identical wording by construction. The
 * {@link ExportAdvisory} interface here mirrors the Python `ExportAdvisory` field-for-field so
 * the response deserialises directly; the helpers only map its `severity`/`requiresAck` signals
 * to CSS utility classes and a coarse presentation for the banner — they add no copy.
 *
 * Consumers gate their banner on {@link ExportAdvisory.show}: a lossless, high-fidelity export
 * stays quiet.
 */

import type { StatusTone } from '@/app/components/ui/statusVocabulary';

/**
 * How much a fidelity loss matters, independent of its kind (mirrors Python
 * `lossiness.LossinessSeverity`). `info` is cosmetic, `warn` a meaningful degradation,
 * `critical` a semantic loss that warrants a dismiss-to-proceed acknowledgement.
 */
export type AdvisorySeverity = 'info' | 'warn' | 'critical';

/**
 * The single user-facing advisory for one export (mirrors Python `fidelity_advisory.ExportAdvisory`
 * field-for-field, so the REST response deserialises directly). Consumers render `message` /
 * `headline` verbatim — never re-template them — and gate their banner on {@link ExportAdvisory.show}.
 */
export interface ExportAdvisory {
  /** Whether to surface the advisory at all. `false` for a lossless export (or one below threshold). */
  show: boolean;
  /** Worst severity among the lossy constructs; `null` for a lossless export. */
  severity: AdvisorySeverity | null;
  /** Whether the export warrants an explicit dismiss-to-proceed acknowledgement (critical loss only). */
  requires_ack: boolean;
  /** Human label for the target format woven into the copy (e.g. `Protobuf`, `OpenAPI 3.1`). */
  target_format: string;
  /** Number of constructs dropped entirely. */
  dropped: number;
  /** Number of constructs represented imperfectly. */
  approximated: number;
  /** Number of constructs invented to satisfy the target. */
  synthesized: number;
  /** Total constructs changed (`dropped + approximated + synthesized`) — the count woven into the message. */
  affected: number;
  /** Short banner heading (or the lossless reassurance heading when `show` is `false`). */
  headline: string;
  /** The full, ready-to-display advisory sentence. Rendered verbatim across UI, browse, and CLI. */
  message: string;
}

/** How the advisory banner presents: its CSS palette strength and whether it gates the download. */
export interface AdvisoryPresentation {
  /** Coarse strength that selects the banner's CSS palette. */
  strength: 'critical' | 'warning' | 'info';
  /** Whether the download stays disabled until the user acknowledges (critical loss only). */
  requiresAck: boolean;
}

/**
 * Map an advisory to how its banner should present. The strength follows the advisory's
 * `severity` (`critical` → critical palette + acknowledgement gate, `warn` → warning, `info` →
 * info); a suppressed advisory (`show === false`) presents as `info` and gates nothing, though
 * consumers normally hide the banner entirely in that case.
 */
export function advisoryPresentation(advisory: ExportAdvisory): AdvisoryPresentation {
  const strength: AdvisoryPresentation['strength'] =
    advisory.severity === 'critical'
      ? 'critical'
      : advisory.severity === 'warn'
        ? 'warning'
        : 'info';
  return { strength, requiresAck: advisory.requires_ack };
}

/** CSS utility classes for the advisory banner container, keyed by presentation strength. */
export function advisoryStrengthTone(strength: AdvisoryPresentation['strength']): StatusTone {
  switch (strength) {
    case 'critical':
      return 'danger';
    case 'warning':
      return 'warn';
    case 'info':
    default:
      return 'accent';
  }
}

/**
 * The tone of the severity pill in an advisory header (HIVE-6.3, #5314).
 *
 * @param severity The advisory severity, or `null` for the neutral case.
 * @returns The tone name to hand `Badge`.
 */
export function advisorySeverityTone(severity: AdvisorySeverity | null): StatusTone {
  switch (severity) {
    case 'critical':
      return 'danger';
    case 'warn':
      return 'warn';
    case 'info':
    default:
      return 'accent';
  }
}

/**
 * The advisory banner's classes.
 *
 * @deprecated Superseded by {@link advisoryStrengthTone} in HIVE-6.3 (#5314); the banner is an
 * `Alert` now. Kept for the catalog and studio surfaces their own epics redesign.
 */
export function advisoryBannerClass(strength: AdvisoryPresentation['strength']): string {
  switch (strength) {
    case 'critical':
      return 'border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200';
    case 'warning':
      return 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200';
    case 'info':
    default:
      return 'border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-200';
  }
}

/** CSS utility classes for the severity pill in the advisory header, keyed by severity. */
export function advisorySeverityPillClass(severity: AdvisorySeverity | null): string {
  switch (severity) {
    case 'critical':
      return 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300';
    case 'warn':
      return 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300';
    case 'info':
    default:
      return 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300';
  }
}

/** One row of the "what changed" count chips, in display order: dropped, approximated, synthesized. */
export interface AdvisoryChip {
  /** Stable key for the chip. */
  key: 'dropped' | 'approximated' | 'synthesized';
  /** Human label, e.g. `dropped`. */
  label: string;
  /** How many constructs fell into this bucket. */
  count: number;
}

/**
 * Break an advisory's counts into the banner's chip row, dropping empty buckets so a chip
 * only appears when it has a non-zero count. Order is fixed (dropped → approximated →
 * synthesized) so the chips read worst-first and are stable across renders.
 */
export function advisoryChips(advisory: ExportAdvisory): AdvisoryChip[] {
  const all: AdvisoryChip[] = [
    { key: 'dropped', label: 'dropped', count: advisory.dropped },
    { key: 'approximated', label: 'approximated', count: advisory.approximated },
    { key: 'synthesized', label: 'synthesized', count: advisory.synthesized },
  ];
  return all.filter((chip) => chip.count > 0);
}
