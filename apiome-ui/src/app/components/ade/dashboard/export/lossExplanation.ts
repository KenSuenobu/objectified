/**
 * Loss-explanation presentation helpers for the evidence drawer (EFP-2.3, #4815).
 *
 * The export evidence drawer (`./EvidenceDrawer.tsx`) explains, for one selected projection
 * outcome, *why* the construct landed the way it did and *what the user can safely do about
 * it*. A `DROP` badge alone cannot tell a user whether to change destination, adjust an
 * export option, correct source data, wait for emitter support, or accept an unavoidable
 * specification limitation — so this module maps every canonical projection reason code
 * (EFP-1.2, `./capabilityRegistry.ts`) onto one of the user-facing **cause categories** the
 * acceptance criteria require the UI to distinguish:
 *
 * - `format-limit` — the destination format cannot represent this (the one category a
 *   destination-documentation link genuinely belongs to);
 * - `emitter-gap` — apiome does not yet emit this (or its toolchain is unavailable); the
 *   format itself may support it, so a destination limitation is never claimed;
 * - `source-incomplete` — the source definition (or apiome's parse of it) did not include
 *   what the emitter would need;
 * - `option-excluded` — an export option excluded it; changing the option brings it back;
 * - `redacted` — the information is withheld by security policy;
 * - `not-applicable` — nothing existed to project; purely informational.
 *
 * It also provides the *safe remediation* vocabulary (navigation-only actions — nothing is
 * changed until the user acts on the destination/options step, which re-previews and
 * invalidates the old acknowledgement), the accessible, version-disclosing naming for
 * external documentation links, and the manifest-provenance extraction (emitter/registry
 * versions) the drawer prints so evidence is always attributable to the versions that
 * produced it.
 *
 * Everything here is pure (no React, no fetch) so it unit-tests directly — mirroring
 * `./projectionGraph.ts` / `./capabilityRegistry.ts`.
 */

import type { StatusTone } from '@/app/components/ui/statusVocabulary';
import type { DocumentationEvidence, ProjectionReasonCode } from './capabilityRegistry';
import { isKnownReasonCode, isSafeDocumentationUrl } from './capabilityRegistry';
import { stripControlAndBidi } from './projectionGraph';

// ---------------------------------------------------------------------------
// Cause categories — the five distinctions the UI must make (EFP-2.3 acceptance)
// ---------------------------------------------------------------------------

/** The user-facing cause category a projection reason code belongs to. */
export type ReasonCategoryKey =
  | 'format-limit'
  | 'emitter-gap'
  | 'source-incomplete'
  | 'option-excluded'
  | 'redacted'
  | 'not-applicable';

/**
 * Reason code → cause category. Grouping is presentation-only — the drawer always prints
 * the exact reason code and the registry's reviewed explanation alongside the category —
 * but the grouping itself must stay truthful: `target_tool_unavailable` is an apiome-side
 * gap (the toolchain, not the format), so it reads as an emitter gap, never a format limit.
 */
const CATEGORY_BY_REASON: Record<ProjectionReasonCode, ReasonCategoryKey> = {
  destination_unsupported: 'format-limit',
  emitter_unsupported: 'emitter-gap',
  target_tool_unavailable: 'emitter-gap',
  source_incomplete: 'source-incomplete',
  source_parse_limit: 'source-incomplete',
  option_excluded: 'option-excluded',
  security_redacted: 'redacted',
  not_applicable: 'not-applicable',
};

/** One cause category's presentation: label, distinguishing line, and chip classes. */
export interface ReasonCategoryPresentation {
  /** The category key. */
  key: ReasonCategoryKey;
  /** Short human label for the category chip (e.g. `Format limit`). */
  label: string;
  /**
   * The one-line distinction the acceptance criteria require — what this category *means*,
   * phrased so it can never be confused with the other categories.
   */
  distinction: string;
  /**
   * The chip's tone from the shared vocabulary. Colour is supplemental to the text label.
   *
   * HIVE-8.3 (#5329): a *cause* is an identity, not a severity, so these do not reuse the
   * ok/warn/danger axis — a "Format limit" is not worse than an "Emitter gap", it is a
   * different answer to "why". The five hueful non-state tones separate them, and
   * `not-applicable` takes `outline`, the vocabulary's "set aside" state.
   */
  tone: StatusTone;
  /**
   * Tailwind classes for the category chip.
   *
   * @deprecated Superseded by {@link ReasonCategoryPresentation.tone} in HIVE-8.3 (#5329).
   * Still read by the catalog conversion surfaces, which their own epic redesigns.
   */
  badgeClass: string;
}

const CATEGORY_PRESENTATION: Record<ReasonCategoryKey, ReasonCategoryPresentation> = {
  'format-limit': {
    key: 'format-limit',
    label: 'Format limit',
    distinction: 'The destination format cannot represent this construct.',
    tone: 'accent',
    badgeClass: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300',
  },
  'emitter-gap': {
    key: 'emitter-gap',
    label: 'Emitter gap',
    distinction:
      'apiome does not yet emit this construct to this destination — the format itself may support it.',
    tone: 'violet',
    badgeClass: 'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300',
  },
  'source-incomplete': {
    key: 'source-incomplete',
    label: 'Source incomplete',
    distinction:
      'The source definition (or what apiome could capture of it) did not include what this export needs.',
    tone: 'warn',
    badgeClass: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  },
  'option-excluded': {
    key: 'option-excluded',
    label: 'Excluded by option',
    distinction: 'An export option excluded this construct — changing the option restores it.',
    tone: 'honey',
    badgeClass: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300',
  },
  redacted: {
    key: 'redacted',
    label: 'Redacted',
    distinction: 'This information is withheld by security policy.',
    tone: 'orange',
    badgeClass: 'bg-slate-200 text-slate-800 dark:bg-slate-700/60 dark:text-slate-200',
  },
  'not-applicable': {
    key: 'not-applicable',
    label: 'Not applicable',
    distinction: 'Nothing in this source applies here — no action is needed.',
    tone: 'outline',
    badgeClass: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  },
};

/**
 * The cause category for a reason code, or null when the code is absent or outside the
 * canonical taxonomy — an unknown code renders no category rather than a guessed one.
 *
 * @param reason The edge's reason code, as received from the server.
 * @returns The category key, or null when no truthful category exists.
 */
export function categoryForReason(reason: string | null | undefined): ReasonCategoryKey | null {
  if (reason == null || !isKnownReasonCode(reason)) return null;
  return CATEGORY_BY_REASON[reason];
}

/** The presentation (label / distinction / chip classes) for one cause category. */
export function reasonCategoryPresentation(key: ReasonCategoryKey): ReasonCategoryPresentation {
  return CATEGORY_PRESENTATION[key];
}

// ---------------------------------------------------------------------------
// Safe remediation actions
// ---------------------------------------------------------------------------

/** What a remediation action does when activated. Navigation-only — never a direct mutation. */
export type RemediationActionKind = 'change-target' | 'change-options';

/** One safe remediation action the drawer can offer for a reason. */
export interface RemediationAction {
  kind: RemediationActionKind;
  /** The action button's label. */
  label: string;
  /** Why this action helps, printed beside the button. */
  description: string;
}

const CHANGE_TARGET_ACTION: RemediationAction = {
  kind: 'change-target',
  label: 'Choose a different target',
  description: 'Pick a destination format that can represent this construct.',
};

const CHANGE_OPTIONS_ACTION: RemediationAction = {
  kind: 'change-options',
  label: 'Change export options',
  description: 'Adjust the option that excluded it, then preview again.',
};

/**
 * The safe remediation actions for a reason code. Actions only *navigate* (back to the
 * target grid or the options form); the actual change re-runs the preview, invalidates the
 * old acknowledgement, and refreshes the graph and report together — so remediation can
 * never leave stale state behind (EFP-2.3 acceptance).
 *
 * Only categories where an in-export change genuinely helps get an action: a format limit
 * can be avoided by a different destination; an option exclusion by a different option.
 * Source gaps, emitter gaps, and redaction are fixed *outside* this export (edit the
 * source, track emitter support, adjust policy), so they get guidance text, never a button
 * that implies this dialog can fix them.
 *
 * @param reason The edge's reason code.
 * @returns The applicable actions, possibly empty; empty for unknown codes.
 */
export function remediationActionsForReason(reason: string | null | undefined): RemediationAction[] {
  switch (categoryForReason(reason)) {
    case 'format-limit':
      return [CHANGE_TARGET_ACTION];
    case 'option-excluded':
      return [CHANGE_OPTIONS_ACTION];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Documentation links — safe, version-disclosing, accessibly named
// ---------------------------------------------------------------------------

/** A documentation link ready to render: safe href + accessible, version-disclosing name. */
export interface DocumentationLink {
  /** The full, allowlist-checked href (URL + anchor). */
  href: string;
  /** The visible link text: specification name + version (version-disclosing). */
  text: string;
  /**
   * The complete accessible name: the visible text plus the destination host and the
   * new-tab disclosure, so a screen-reader user hears where the link goes before following.
   */
  ariaLabel: string;
}

/**
 * Build the renderable link for documentation evidence, or null when no safe link exists.
 *
 * The URL must pass the host allowlist ({@link isSafeDocumentationUrl}) — evidence whose
 * link fails it yields null, and the caller renders the truthful documentation-unavailable
 * note instead. The link name always discloses the specification and its version (EFP-2.3
 * acceptance: "disclose the destination/version") and the accessible name additionally
 * discloses the host and that it opens in a new tab.
 *
 * @param evidence The reason-scoped documentation evidence from the manifest edge.
 * @returns The link parts, or null when the evidence carries no safe URL.
 */
export function documentationLink(
  evidence: DocumentationEvidence | null | undefined,
): DocumentationLink | null {
  if (!evidence || evidence.url == null || !isSafeDocumentationUrl(evidence.url)) return null;
  const href = `${evidence.url}${evidence.anchor ?? ''}`;
  const specification = evidence.specification?.trim() || 'Destination documentation';
  const version = evidence.version?.trim() || null;
  const text = version ? `${specification} (${version})` : specification;
  const host = new URL(evidence.url).hostname;
  return {
    href,
    text,
    ariaLabel: `${text} — external documentation on ${host}, opens in a new tab`,
  };
}

// ---------------------------------------------------------------------------
// Manifest provenance — the versions the evidence was produced against
// ---------------------------------------------------------------------------

/** The version provenance extracted from a manifest summary's `target` block. */
export interface ManifestProvenance {
  /** The emitter implementation version, when the block carries one. */
  emitterVersion: string | null;
  /** The capability-registry contract version, when the block carries one. */
  registryVersion: string | null;
  /** The apiome-rest package version that built the manifest, when carried. */
  apiomeVersion: string | null;
}

/** Read one optional string field out of an untyped record. */
function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Extract the emitter/registry/apiome version provenance from a manifest summary's
 * loosely-typed `target` block. The block mirrors the REST `ManifestTarget` model, but the
 * summary type keeps it as `Record<string, unknown>` — so each field is guarded and a
 * missing or malformed one reads as null rather than rendering garbage.
 *
 * @param target The `ProjectionManifestSummary.target` block, when the summary is loaded.
 * @returns The provenance fields, null where absent.
 */
export function manifestProvenance(
  target: Record<string, unknown> | null | undefined,
): ManifestProvenance {
  if (!target) return { emitterVersion: null, registryVersion: null, apiomeVersion: null };
  return {
    emitterVersion: stringField(target, 'emitter_version'),
    registryVersion: stringField(target, 'registry_version'),
    apiomeVersion: stringField(target, 'apiome_version'),
  };
}

// ---------------------------------------------------------------------------
// Prose sanitisation — longer-form evidence text
// ---------------------------------------------------------------------------

/** Longest evidence prose rendered in the drawer (outcome text, explanations, notes). */
export const MAX_EVIDENCE_PROSE_LENGTH = 400;

/**
 * Sanitize longer-form evidence prose (outcome detail, explanations, documentation notes)
 * for display. The same defence-in-depth core as `sanitizeProjectionLabel`
 * ({@link stripControlAndBidi}) but with a prose-length cap
 * ({@link MAX_EVIDENCE_PROSE_LENGTH}) instead of the label cap, so a full sentence of
 * server-reviewed explanation survives while an adversarial megabyte cannot. Prose is only
 * ever rendered as React text nodes, so this guard is belt-and-braces.
 *
 * @param raw The prose as received from the server (may be null/empty).
 * @returns Display-safe prose, or null when nothing survives.
 */
export function sanitizeEvidenceProse(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const collapsed = stripControlAndBidi(raw);
  if (collapsed.length === 0) return null;
  if (collapsed.length <= MAX_EVIDENCE_PROSE_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_EVIDENCE_PROSE_LENGTH - 1)}…`;
}
