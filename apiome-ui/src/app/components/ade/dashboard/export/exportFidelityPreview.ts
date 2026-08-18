/**
 * Fidelity preview envelope + warning-panel presentation helpers (MFX-6.2, #3856).
 *
 * The ExportDialog's fidelity warning panel renders from `POST /api/export/preview` — the
 * dry-run fidelity preview (MFX-2.5) that carries the full per-construct
 * `LossinessReport`, the user-facing advisory (MFX-2.4), and the coarse tier summary,
 * without emitting an artifact. This module mirrors those REST models field-for-field so
 * the response deserialises directly, and adds the pure presentation helpers the panel
 * needs: per-kind badge labels/classes, the worst-first report ordering, the preserved-%
 * ring geometry, and the "Export anyway" gate.
 *
 * Everything here is pure (no React, no fetch) so it can be unit-tested directly —
 * mirroring `./exportTargetCatalog.ts`.
 */

import type { StatusTone } from '@/app/components/ui/statusVocabulary';
import {
  FIDELITY_BUCKET_TONE,
  PROJECTION_OUTCOME_TONE,
} from '@/app/components/ade/version-dialogs/versionDialogsModel';
import type { ExportAdvisory } from '../../../../utils/export-advisory';
import { isKnownReasonCode } from './capabilityRegistry';
import type {
  ExportFidelityTier,
  ExportTargetDescriptor,
  TargetFidelitySummary,
} from './exportTargetCatalog';

/** The representational outcome of one construct (mirrors Python `LossinessKind`). */
export type LossinessKind = 'drop' | 'approx' | 'synth' | 'ok';

/** How much a loss matters (mirrors Python `LossinessSeverity`). */
export type LossinessSeverity = 'info' | 'warn' | 'critical';

/** One construct's fate when exported to the target (mirrors Python `LossItem`). */
export interface LossItem {
  /** Stable canonical construct key — the source path (e.g. `User.email`, `GET /pets/{id}`). */
  construct: string;
  /** Representational outcome: drop / approx / synth / ok. */
  kind: LossinessKind;
  /** How much the loss matters: info / warn / critical. */
  severity: LossinessSeverity;
  /** Human-readable explanation of what happened to the construct. */
  message: string;
  /** How the construct lands in the target when not dropped (e.g. `constraint → doc comment`). */
  target_mapping?: string | null;
}

/** The full per-construct lossiness report (mirrors Python `LossinessReport`). */
export interface LossinessReport {
  /** The loss items, in the server's deterministic canonical order. */
  items: LossItem[];
  /** Count of items per kind, zero-filled for every kind. */
  kind_counts: Record<string, number>;
  /** Count of items per severity, zero-filled for every severity. */
  severity_counts: Record<string, number>;
}

/** The full fidelity envelope for one (source, target) export (mirrors Python `ExportFidelity`). */
export interface ExportFidelityEnvelope {
  /** The resolved target emitter's descriptor. */
  target: ExportTargetDescriptor;
  /** The coarse tier / preserved-% summary, matching the `/api/export/targets` badge. */
  summary: TargetFidelitySummary;
  /** The full per-construct lossiness report (DROP/APPROX/SYNTH/OK + severity). */
  report: LossinessReport;
  /** The user-facing "may lose fidelity" advisory (MFX-2.4), rendered verbatim. */
  advisory: ExportAdvisory;
  /** The bounded projection-manifest summary (EFP-1.1); absent from older servers. */
  projection?: ProjectionManifestSummary | null;
}

/** A construct's projected fate in the target (mirrors Python `ProjectionStatus`). */
export type ProjectionStatus =
  | 'retained'
  | 'transformed'
  | 'approximated'
  | 'synthesized'
  | 'dropped'
  | 'unavailable'
  | 'not-applicable';

/**
 * The bounded projection summary embedded in the fidelity envelope (mirrors Python
 * `ProjectionManifestSummary`, EFP-1.1). The snapshot id (`manifest_hash`) plus the
 * aggregate status/reason counts — everything a surface needs to *reference* the
 * projection snapshot without carrying the node/edge graph.
 */
export interface ProjectionManifestSummary {
  /** The manifest's stable content hash — the snapshot id. */
  manifest_hash: string;
  /** The target + version provenance block (registry/emitter versions and docs ride here). */
  target: Record<string, unknown>;
  /** Count of projected constructs per ProjectionStatus, zero-filled. */
  status_counts: Record<string, number>;
  /** Count of non-preserved constructs per ProjectionReason, zero-filled. */
  reason_counts: Record<string, number>;
  /** Distinct canonical constructs the manifest projects. */
  total_constructs: number;
  /** Total projection nodes in the full manifest. */
  node_count: number;
  /** Total projection edges in the full manifest. */
  edge_count: number;
  /** Total outcome (projects) edges — the evidence rows. */
  evidence_count: number;
  /** True when every construct was retained. */
  is_lossless: boolean;
  /** Worst severity among non-retained constructs, or null when lossless. */
  worst_severity?: LossinessSeverity | null;
  /** True when the underlying graph was aggregated rather than complete. */
  truncated: boolean;
}

/** The `POST /api/export/preview` response (mirrors REST `ExportPreviewResponse`). */
export interface ExportPreviewResponse {
  /** The artifact (project) id the preview was computed for. */
  artifact: string;
  /** The version selector as requested (label, UUID, or null for latest). */
  version?: string | null;
  /** The resolved revision record id. */
  version_record_id: string;
  /** The resolved revision's version label, e.g. `"1.2.0"`. */
  version_label?: string | null;
  /** The full fidelity envelope (target + summary + report + advisory). */
  fidelity: ExportFidelityEnvelope;
}

/** Display rank per kind: loss reads before invention before clean (worst-first). */
const KIND_ORDER: Record<LossinessKind, number> = { drop: 0, approx: 1, synth: 2, ok: 3 };

/** Display rank per severity: worse severities read first. */
const SEVERITY_ORDER: Record<LossinessSeverity, number> = { critical: 0, warn: 1, info: 2 };

/** Human label for a loss kind, as printed on the report row badge (e.g. `DROP`). */
export function kindLabel(kind: LossinessKind): string {
  return kind.toUpperCase();
}

/**
 * The glyph that rides in front of a loss-kind chip's label (MFX-41.5).
 *
 * The kind palette (drop → red, approx → amber, synth → violet, ok → green) is the *third* channel
 * a chip uses, never the only one: the chip states its kind in words and leads with this glyph, so
 * the four kinds stay distinguishable in greyscale, at small sizes, and to a user who cannot
 * separate red from amber. The glyphs are plain text (`✕ ≈ ✚ ✓`) rather than icon components so
 * the same mapping serves chips, count pills, and any plain-text rendering of the report.
 *
 * @param kind The loss kind.
 * @returns A single-character glyph for that kind.
 */
export function kindGlyph(kind: LossinessKind): string {
  switch (kind) {
    case 'drop':
      return '✕';
    case 'approx':
      return '≈';
    case 'synth':
      return '✚';
    case 'ok':
    default:
      return '✓';
  }
}

/**
 * A screen-reader sentence for a loss kind — what the chip's three-letter label means (MFX-41.5).
 *
 * `DROP` alone is jargon that reads as an unexplained shout in a screen reader; the report row
 * names the kind with this phrase so the meaning does not depend on having read the legend.
 *
 * @param kind The loss kind.
 * @returns A short phrase describing what happened to the construct.
 */
export function kindDescription(kind: LossinessKind): string {
  switch (kind) {
    case 'drop':
      return 'dropped — not representable in the target';
    case 'approx':
      return 'approximated — represented imperfectly';
    case 'synth':
      return 'synthesized — invented to satisfy the target';
    case 'ok':
    default:
      return 'clean — carried over unchanged';
  }
}

/**
 * CSS utility classes for a report row's kind badge. The palette matches the count chips
 * (`fidelityChips`): drop → red, approx → amber, synth → violet, ok → green.
 */
export function kindTone(kind: LossinessKind): StatusTone {
  switch (kind) {
    case 'drop':
      return PROJECTION_OUTCOME_TONE.dropped;
    case 'approx':
      return PROJECTION_OUTCOME_TONE.approximated;
    case 'synth':
      return PROJECTION_OUTCOME_TONE.synthesized;
    case 'ok':
    default:
      return PROJECTION_OUTCOME_TONE.clean;
  }
}

/**
 * CSS utility classes for a loss-kind badge.
 *
 * @deprecated Superseded by {@link kindTone} in HIVE-6.3 (#5314), which names a token instead
 * of a palette pair. Still read by `RoundtripComparisonPanel`, which its own epic redesigns.
 */
export function kindBadgeClass(kind: LossinessKind): string {
  switch (kind) {
    case 'drop':
      return 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300';
    case 'approx':
      return 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300';
    case 'synth':
      return 'bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300';
    case 'ok':
    default:
      return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300';
  }
}

/**
 * Order report items for the warning panel: worst-first by kind (drop → approx → synth → ok),
 * then by severity (critical → warn → info), then by construct key for a stable read. The
 * server's canonical order is by construct key; the panel instead leads with what the user
 * must review. Returns a new array — the input is not mutated.
 *
 * @param items The report items in any order.
 * @returns The items sorted worst-first.
 */
export function sortReportItemsWorstFirst(items: LossItem[]): LossItem[] {
  return [...items].sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.construct.localeCompare(b.construct),
  );
}

/**
 * Whether the export needs the explicit "Export anyway" acknowledgement before the download
 * is allowed (MFX-6.2 acceptance: required when lossy, absent when clean). Gated on the tier
 * so it works from the cheap `/api/export/targets` summary alone — the gate never waits on
 * (or is defeated by a failure of) the detailed preview fetch.
 *
 * @param tier The target's fidelity tier for this source.
 * @returns True when the conversion is lossy (or types-only) and must be acknowledged.
 */
export function requiresExportAcknowledgement(tier: ExportFidelityTier): boolean {
  return tier !== 'lossless';
}

/**
 * The single source of the types-only (severe / MFX-3.3 near-empty) acknowledgement phrase.
 *
 * A severe conversion — one whose target is a types-only format, so only the source's schemas
 * export and every operation/channel is dropped — is gated in the Verify workbench (MFX-42.4) not
 * by the lossy "Export anyway" checkbox but by an explicit **typed** acknowledgement: the user must
 * type this exact phrase to confirm they understand the outcome. Keeping the phrase in one place
 * means the confirmation prompt, the input's match check, and any copy that quotes it can never
 * drift — and it mirrors the MFX-2.4 advisory's plain description of what a types-only export
 * produces. The match is case-insensitive and trims surrounding whitespace (see
 * {@link acknowledgementPhraseMatches}).
 */
export const EXPORT_TYPES_ONLY_ACK_PHRASE = 'export produces a types-only artifact';

/**
 * Which acknowledgement control the fidelity panel renders (MFX-42.4): a `typed` phrase input for a
 * severe (types-only) conversion, the `checkbox` for a lossy one, or `hidden` when none is needed
 * (clean, or an invalid export that cannot be overridden). Lives in this pure module so the panel
 * depends only on the fidelity primitives; the workbench maps a verdict to it via
 * `fidelityAcknowledgementMode`.
 */
export type AcknowledgementMode = 'typed' | 'checkbox' | 'hidden';

/**
 * Whether a user's typed input satisfies the types-only acknowledgement (MFX-42.4).
 *
 * Compares the input against {@link EXPORT_TYPES_ONLY_ACK_PHRASE} case-insensitively and ignoring
 * surrounding whitespace, so trivial casing/spacing differences do not block a user who clearly
 * typed the phrase. Interior wording must still match exactly — this is a deliberate friction gate,
 * not a fuzzy search.
 *
 * @param input The raw text the user typed into the confirmation field.
 * @returns True when the input matches the acknowledgement phrase.
 */
export function acknowledgementPhraseMatches(input: string): boolean {
  return input.trim().toLowerCase() === EXPORT_TYPES_ONLY_ACK_PHRASE;
}

/** The SVG geometry for the preserved-% ring, precomputed so the component stays declarative. */
export interface RingGeometry {
  /** The ring circle's circumference (the `stroke-dasharray`). */
  circumference: number;
  /** The dash offset hiding the unpreserved share (the `stroke-dashoffset`). */
  dashOffset: number;
}

/**
 * Compute the preserved-% ring's stroke geometry for an SVG circle of the given radius.
 * The visible arc covers `percent`% of the circumference; the remainder is offset away.
 * Out-of-range percentages are clamped to 0–100.
 *
 * @param percent The preserved percentage, 0–100.
 * @param radius The ring circle's radius in SVG user units.
 * @returns The dash geometry to apply to the circle.
 */
export function ringGeometry(percent: number, radius: number): RingGeometry {
  const clamped = Math.min(100, Math.max(0, percent));
  const circumference = 2 * Math.PI * radius;
  return { circumference, dashOffset: circumference * (1 - clamped / 100) };
}

/**
 * CSS utility classes for the ring's progress stroke, keyed by fidelity tier so the ring
 * reads with the same palette as the tier badge: lossless → green, lossy → amber,
 * types-only → red.
 */
export function ringTone(tier: ExportFidelityTier): StatusTone {
  return FIDELITY_BUCKET_TONE[tier] ?? FIDELITY_BUCKET_TONE['types-only'];
}

/**
 * The ring's stroke class.
 *
 * @deprecated Superseded by {@link ringTone} in HIVE-6.3 (#5314). The ring is drawn from
 * `.vdlg-ring[data-tone]` now, so it follows the theme.
 */
export function ringStrokeClass(tier: ExportFidelityTier): string {
  switch (tier) {
    case 'lossless':
      return 'stroke-emerald-500 dark:stroke-emerald-400';
    case 'lossy':
      return 'stroke-amber-500 dark:stroke-amber-400';
    case 'types-only':
    default:
      return 'stroke-rose-500 dark:stroke-rose-400';
  }
}

// ---------------------------------------------------------------------------
// Projection evidence parity (EFP-1.3)
// ---------------------------------------------------------------------------

/**
 * LossinessReport kind → the projection statuses it reconciles with. `transformed`
 * reconciles to `ok` (a documented transformation preserves meaning), exactly as the
 * server-side reconciliation does; `unavailable` / `not-applicable` have no report
 * counterpart and stay out of the comparison.
 */
const PARITY_KINDS_TO_STATUSES: Record<LossinessKind, readonly ProjectionStatus[]> = {
  ok: ['retained', 'transformed'],
  approx: ['approximated'],
  synth: ['synthesized'],
  drop: ['dropped'],
};

/** Coarse-summary count field → the report kind it must equal. */
const PARITY_SUMMARY_TO_KIND = {
  preserved: 'ok',
  approximated: 'approx',
  synthesized: 'synth',
  dropped: 'drop',
} as const;

/**
 * Return every internal disagreement in a fidelity envelope's projection evidence.
 *
 * The UI leg of the EFP-1.3 cross-surface parity contract: before the export UI trusts
 * an envelope (a preview, a verify, a job result relayed through the route proxies), the
 * `report.kind_counts`, the coarse `summary` counts, and the `projection` status/reason
 * counts must all tell one story, every reason code must be a member of the canonical
 * taxonomy (see `./capabilityRegistry`), and `is_lossless` must match the evidence rows.
 * Mirrors `envelope_parity_issues` in apiome-rest's projection corpus and
 * `projection_parity_issues` in apiome-cli, over the same serialized shape — the jest
 * corpus exercises all three against the same golden fixture bytes.
 *
 * Returns human-readable disagreement descriptions; empty when the envelope is
 * consistent. An older-server envelope with no `projection` block reports exactly one
 * issue naming the missing block, so callers can degrade gracefully.
 */
export function projectionParityIssues(envelope: ExportFidelityEnvelope): string[] {
  const { report, summary, projection } = envelope;
  if (!report || !summary) {
    return ['envelope is missing its report/summary blocks'];
  }
  if (!projection) {
    return ['envelope is missing its projection summary block (EFP-1.1)'];
  }

  const issues: string[] = [];
  if (!projection.manifest_hash) {
    issues.push('projection summary has no manifest_hash (snapshot id)');
  }

  const kindCounts = report.kind_counts ?? {};
  const statusCounts = projection.status_counts ?? {};
  const reasonCounts = projection.reason_counts ?? {};

  for (const [kind, statuses] of Object.entries(PARITY_KINDS_TO_STATUSES)) {
    const kindTotal = kindCounts[kind] ?? 0;
    const statusTotal = statuses.reduce((sum, status) => sum + (statusCounts[status] ?? 0), 0);
    if (kindTotal !== statusTotal) {
      issues.push(
        `report kind_counts['${kind}']=${kindTotal} disagrees with projection ` +
          `status_counts[${statuses.join(', ')}]=${statusTotal}`,
      );
    }
  }

  for (const [field, kind] of Object.entries(PARITY_SUMMARY_TO_KIND)) {
    const summaryValue = summary[field as keyof typeof PARITY_SUMMARY_TO_KIND] ?? 0;
    const kindValue = kindCounts[kind] ?? 0;
    if (summaryValue !== kindValue) {
      issues.push(`summary ${field}=${summaryValue} disagrees with report kind_counts['${kind}']=${kindValue}`);
    }
  }
  const reportTotal = Object.keys(PARITY_KINDS_TO_STATUSES).reduce(
    (sum, kind) => sum + (kindCounts[kind] ?? 0),
    0,
  );
  if ((summary.total ?? 0) !== reportTotal) {
    issues.push(`summary total=${summary.total} disagrees with report item total=${reportTotal}`);
  }

  for (const code of Object.keys(reasonCounts)) {
    if (!isKnownReasonCode(code)) {
      issues.push(`projection reason_counts carries unknown reason code '${code}'`);
    }
  }

  const retained = statusCounts['retained'] ?? 0;
  if (projection.is_lossless !== (projection.evidence_count === retained)) {
    issues.push(
      `projection is_lossless=${projection.is_lossless} disagrees with retained ${retained} of ` +
        `${projection.evidence_count} evidence rows`,
    );
  }

  return issues;
}
