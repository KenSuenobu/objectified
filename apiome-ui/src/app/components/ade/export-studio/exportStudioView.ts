/**
 * Export Studio presentation rules (HIVE-8.3, #5329).
 *
 * Authority: `docs/mockups/ship/export-studio.html` and DESIGN.md §3.1 (status vocabulary).
 *
 * ### What lives here and why
 *
 * The Studio's five steps are built from twenty-three components, and before this ticket the
 * *same word* chose its own colour in each of them. `dropped` was `bg-rose-100 text-rose-700`
 * in the manifest tree, `bg-rose-50 text-rose-800` in the round-trip list and `danger` in the
 * fidelity report; a job stage's frame and the icon inside it were decided by two unrelated
 * `switch` statements; five separate surfaces each invented their own amber for "read this
 * before you ship".
 *
 * Every one of those decisions is a *word* → *tone* mapping, and this module is the one place
 * they are written. A component reads a tone here and hands it to `Badge` or to a `data-*`
 * attribute the HIVE-8.3 block in `globals.css` paints; no component spells a colour. That is
 * what makes the Studio follow all nine themes, and it is why a status can no longer be
 * emerald in one panel and green in the next.
 *
 * There is deliberately **no React and no fetch** here, so every rule is unit-tested directly.
 *
 * @see `exportTargetFamilies.ts` — the other half of this ticket's pure rules.
 */

import type { StatusTone } from '@/app/components/ui/statusVocabulary';

/**
 * A construct's projected fate in the target → its tone.
 *
 * The seven statuses are REST's `ProjectionStatus` (`exportFidelityPreview.ts`). The tones are
 * the mockup's legend, read left to right: `✓ Retained` ok, `⇄ Transformed` accent,
 * `≈ Approximated` warn, `＋ Synthesized` violet, `× Dropped` rose, `⊘ Unavailable` neutral,
 * `— Not applicable` outline.
 *
 * `transformed` is *accent*, not ok: a documented transformation is a thing that happened to
 * the construct, and a reader scanning for "what changed" needs it to separate from the
 * untouched majority. `not-applicable` is `outline` — the vocabulary's "set aside" state —
 * because nothing was lost and nothing was done.
 */
export const PROJECTION_STATUS_TONE: Readonly<Record<string, StatusTone>> = {
  retained: 'ok',
  transformed: 'accent',
  approximated: 'warn',
  synthesized: 'violet',
  dropped: 'rose',
  unavailable: 'neutral',
  'not-applicable': 'outline',
};

/**
 * The tone for one projection status.
 *
 * @param status The status string, as REST spells it.
 * @returns The tone, or `outline` for a status this build does not know — an unknown status is
 *   *set aside*, never painted as if it were understood.
 */
export function projectionStatusTone(status: string | null | undefined): StatusTone {
  return PROJECTION_STATUS_TONE[status ?? ''] ?? 'outline';
}

/**
 * An artifact entity's kind → its tone.
 *
 * A kind is an *identity*, not a state, so these do not reuse the ok/warn/danger axis at all:
 * they are the vocabulary's four hueful non-state tones plus `outline` for `field`, which is
 * the most numerous kind by an order of magnitude and must not shout.
 */
export const ENTITY_KIND_TONE: Readonly<Record<string, StatusTone>> = {
  service: 'accent',
  operation: 'violet',
  channel: 'honey',
  type: 'orange',
  field: 'outline',
};

/**
 * The tone for one entity kind.
 *
 * @param kind The manifest entity's `entity_kind`.
 * @returns The tone, defaulting to `outline` for a kind this build does not know.
 */
export function entityKindTone(kind: string | null | undefined): StatusTone {
  return ENTITY_KIND_TONE[kind ?? ''] ?? 'outline';
}

/** The five states a pipeline stage can be in (mirrors `exportJob.ExportStageStatus`). */
export type StudioStageStatus = 'pending' | 'active' | 'done' | 'failed' | 'canceled';

/**
 * A stage row's `data-status`.
 *
 * The value is the status itself — the CSS keys off it directly, so the frame, the badge and
 * the glyph inside the badge are one rule rather than the three that used to disagree. This
 * function exists to make that contract explicit and testable: `canceled` and `pending` share
 * the resting appearance deliberately (a canceled run's unreached stages never started, and
 * saying so twice in colour adds nothing the `Ban` glyph does not).
 *
 * @param status The stage's status.
 * @returns The attribute value the stylesheet matches.
 */
export function stageRowState(status: StudioStageStatus): string {
  return status === 'canceled' ? 'pending' : status;
}

/**
 * A delivery-gate reason's severity → its tone.
 *
 * `info` is `neutral` rather than `accent`: an informational reason is the gate telling the
 * reader a dimension was checked and had nothing to say, and it sits in a list beside reasons
 * that *do*. Only the two that ask for attention carry a hue.
 */
export const DELIVERY_SEVERITY_TONE: Readonly<Record<string, StatusTone>> = {
  blocking: 'danger',
  warning: 'warn',
  info: 'neutral',
};

/**
 * The tone for one delivery-gate severity.
 *
 * @param severity The reason's severity.
 * @returns The tone, defaulting to `neutral`.
 */
export function deliverySeverityTone(severity: string | null | undefined): StatusTone {
  return DELIVERY_SEVERITY_TONE[severity ?? ''] ?? 'neutral';
}

/**
 * A validation lens's own verdict tone → the shared vocabulary.
 *
 * `exportVerify.validationLensTone` already reduces the four validation states to four words;
 * this is the last step, from those words to a tone. Kept separate because the lens's states
 * are a *domain* fact (whether the emitted artifact re-parsed) and the tone is a presentation
 * one — the same reason `lifecycleFromMetadata` and `STATUS_TONE` are separate in HIVE-8.1.
 */
export const VALIDATION_LENS_TONE: Readonly<Record<string, StatusTone>> = {
  ok: 'ok',
  invalid: 'danger',
  warn: 'warn',
  neutral: 'neutral',
};

/**
 * The tone for one validation-lens verdict.
 *
 * @param tone The lens tone from `validationLensTone`.
 * @returns The vocabulary tone, defaulting to `neutral`.
 */
export function validationToneName(tone: string | null | undefined): StatusTone {
  return VALIDATION_LENS_TONE[tone ?? ''] ?? 'neutral';
}

/**
 * A job event's level → its `data-level`.
 *
 * Only `warn` and `error` are ever drawn (the panel filters `info` out), so this is a total
 * function over what actually reaches the list.
 *
 * @param level The event's level.
 * @returns `error` for an error, `warn` for everything else.
 */
export function eventLevelState(level: string): 'warn' | 'error' {
  return level === 'error' ? 'error' : 'warn';
}

/**
 * The tone of a Verify lens's count badge.
 *
 * The rule the mockup states and the pre-Hive code buried in a closure over three palette
 * strings: **zero findings is ok**, a lens that blocks delivery is danger, and anything else
 * that has something to say is warn. Pulling it out here is what lets the badge be tested
 * without rendering the workbench.
 *
 * @param count How many findings the lens holds.
 * @param blocking Whether those findings block delivery — a validation failure, a lint error,
 *   or a severe (types-only / near-empty) conversion.
 * @returns The tone for the badge.
 */
export function lensBadgeTone(count: number, blocking: boolean): StatusTone {
  if (count === 0) return 'ok';
  return blocking ? 'danger' : 'warn';
}

/**
 * The tone of the round-trip comparison's difference rows.
 *
 * A difference the fidelity report *explains* is not a problem — it is the report being
 * right — so an expected row is drawn like any other list row and only its kind badge carries
 * a hue. An unexplained one is the panel's whole reason for existing.
 *
 * @param explained Whether the fidelity report accounts for this difference.
 * @returns The tone for the row.
 */
export function roundtripDiffTone(explained: boolean): StatusTone {
  return explained ? 'neutral' : 'danger';
}
