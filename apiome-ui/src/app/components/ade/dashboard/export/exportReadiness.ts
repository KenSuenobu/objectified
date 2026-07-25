/**
 * Export pre-flight readiness model (IXH-2.4, #5099).
 *
 * `POST /api/export/preflight` ranks every export target for one source revision *before* a job
 * exists: the source's lint grade under the tenant's style guide, the projected fidelity envelope,
 * the capability verdict, the tenant export-policy verdict, and a composite readiness score with a
 * one-line rationale. This module mirrors that REST contract in TypeScript and turns it into what
 * the target grid renders — an ordering, a badge, and a reason.
 *
 * Everything here is pure (no React, no fetch) so it can be unit-tested directly, mirroring
 * `./exportTargetCatalog.ts`, whose card type it orders.
 */

import type { ExportTargetCard, TargetFidelitySummary } from './exportTargetCatalog';

/** How the target grid is ordered. */
export type ExportTargetOrder = 'readiness' | 'registry';

/** The readiness band a target falls into (mirrors the REST `band` literal). */
export type ExportReadinessBand = 'ready' | 'caution' | 'blocked' | 'unavailable';

/** How well a target's declared capabilities cover the source (mirrors REST `capability`). */
export interface ExportPreflightCapability {
  /** `full` / `partial` / `schema_only` / `unavailable`. */
  verdict: 'full' | 'partial' | 'schema_only' | 'unavailable';
  /** Capability axes the source uses. */
  required: string[];
  /** Of those, the axes the target carries. */
  supported: string[];
  /** Of those, the axes the target cannot carry. */
  missing: string[];
  /** Axes the target requires that the source does not provide. */
  synthesized: string[];
  /** One-sentence explanation of the verdict. */
  reason: string;
}

/** The tenant quality-policy verdict for one target (mirrors REST `ImportPreflightPolicy`). */
export interface ExportPreflightPolicy {
  verdict: 'pass' | 'warn' | 'block';
  blocking: boolean;
  source: string;
  reason: string;
  scope: 'import' | 'export';
  threshold_score?: number | null;
  min_grade?: string | null;
  allow_override?: boolean;
  enforcement?: 'advisory' | 'block';
  override_roles?: string[];
  waiver_id?: string | null;
}

/** One ranked target from the pre-flight report (mirrors REST `ExportPreflightTarget`). */
export interface ExportPreflightTarget {
  /** 1-based position in the readiness ranking. */
  rank: number;
  /** The target's registry key, matching `ExportTargetCard.key`. */
  key: string;
  /** The target's output format key. */
  format: string;
  /** Composite 0–100 readiness score. */
  readiness: number;
  /** The band the score and the blocking inputs put this target in. */
  band: ExportReadinessBand;
  /** Whether the tenant's export policy blocks this target. */
  blocked: boolean;
  /** Whether a client should let the user choose this target. */
  selectable: boolean;
  /** One line explaining the rank in the user's terms. */
  rationale: string;
  /** The projected fidelity envelope, identical to the target card's badge. */
  fidelity: TargetFidelitySummary;
  capability: ExportPreflightCapability;
  policy: ExportPreflightPolicy;
}

/** The source's lint verdict (mirrors the REST pre-flight `lint` block). */
export interface ExportPreflightLint {
  score?: number | null;
  grade?: string | null;
  report_fingerprint?: string | null;
  severity_counts?: Record<string, number>;
  findings?: Array<Record<string, unknown>>;
}

/** The full `POST /api/export/preflight` response (mirrors REST `ExportPreflightReport`). */
export interface ExportPreflightReport {
  artifact: string;
  version?: string | null;
  version_record_id: string;
  version_label?: string | null;
  paradigm?: string | null;
  format?: string | null;
  lint: ExportPreflightLint;
  style_guide?: { guide_id?: string | null; name: string; source: string; fingerprint: string } | null;
  capability_demand: string[];
  targets: ExportPreflightTarget[];
  /** Stable hash over the ranked triples; identical for two pre-flights of the same revision. */
  ranking_fingerprint: string;
}

/** Band ordering, worst last — the primary sort key, mirroring the server's own. */
const BAND_ORDER: ExportReadinessBand[] = ['ready', 'caution', 'blocked', 'unavailable'];

/**
 * Index a pre-flight report's targets by their registry key.
 *
 * @param report The pre-flight report (may be null while loading).
 * @returns A key → ranked-target map; empty when there is no report.
 */
export function readinessByTarget(
  report: ExportPreflightReport | null | undefined,
): Record<string, ExportPreflightTarget> {
  const byKey: Record<string, ExportPreflightTarget> = {};
  for (const target of report?.targets ?? []) {
    if (typeof target?.key === 'string' && target.key.length > 0) byKey[target.key] = target;
  }
  return byKey;
}

/**
 * Order target cards for the grid.
 *
 * `registry` keeps the server's key order — the ordering the grid has always used, kept available
 * so a user who knows what they want is not re-sorted underneath them. `readiness` sorts by the
 * pre-flight ranking: band first (ready → caution → blocked → unavailable), then the composite
 * score descending, then the key, so the order is total and stable. Cards the pre-flight did not
 * rank (a target added between the two calls, or a report that failed to load) keep their relative
 * order at the end rather than being dropped.
 *
 * @param cards The renderable target cards.
 * @param readiness The key → ranked-target map from {@link readinessByTarget}.
 * @param order Which ordering to apply.
 * @returns A new, ordered array; the input is not mutated.
 */
export function orderTargetCards(
  cards: ExportTargetCard[],
  readiness: Record<string, ExportPreflightTarget>,
  order: ExportTargetOrder,
): ExportTargetCard[] {
  if (order !== 'readiness') return cards;
  return [...cards]
    .map((card, index) => ({ card, index, target: readiness[card.key] }))
    .sort((a, b) => {
      if (!a.target && !b.target) return a.index - b.index;
      if (!a.target) return 1;
      if (!b.target) return -1;
      const band = BAND_ORDER.indexOf(a.target.band) - BAND_ORDER.indexOf(b.target.band);
      if (band !== 0) return band;
      if (a.target.readiness !== b.target.readiness) return b.target.readiness - a.target.readiness;
      return a.card.key.localeCompare(b.card.key);
    })
    .map((entry) => entry.card);
}

/** Human label for a readiness band, as printed on the card badge. */
export function bandLabel(band: ExportReadinessBand): string {
  switch (band) {
    case 'ready':
      return 'ready';
    case 'caution':
      return 'check first';
    case 'blocked':
      return 'blocked';
    case 'unavailable':
    default:
      return 'unavailable';
  }
}

/**
 * CSS utility classes for a card's readiness badge. Follows the fidelity palette so the two
 * badges read as one system: green = go, amber = look first, red = refused, grey = cannot run.
 */
export function bandBadgeClass(band: ExportReadinessBand): string {
  switch (band) {
    case 'ready':
      return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300';
    case 'caution':
      return 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300';
    case 'blocked':
      return 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300';
    case 'unavailable':
    default:
      return 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400';
  }
}

/**
 * Whether a card may be selected: the emitter must be runnable *and* the tenant's export policy
 * must not block it. With no pre-flight ranking for the card, only runtime availability applies —
 * the grid must not refuse a target just because the pre-flight has not loaded yet.
 *
 * @param card The renderable card.
 * @param target Its ranked pre-flight entry, when the report covered it.
 */
export function isCardSelectable(
  card: ExportTargetCard,
  target: ExportPreflightTarget | undefined,
): boolean {
  if (!card.available) return false;
  return target ? target.selectable : true;
}

/**
 * The tooltip/title text for a card: the blocking reason when there is one, else the pre-flight
 * rationale, else the descriptor's own description (the pre-IXH-2.4 behaviour).
 *
 * @param card The renderable card.
 * @param target Its ranked pre-flight entry, when the report covered it.
 */
export function cardTitle(
  card: ExportTargetCard,
  target: ExportPreflightTarget | undefined,
): string {
  if (!card.available) {
    return card.entry.descriptor.unavailable_reason || 'Unavailable in this runtime';
  }
  if (target?.rationale) return target.rationale;
  return card.entry.descriptor.description;
}

/**
 * A one-line summary of the source's own quality, shown above the grid so the user sees why every
 * target scores the way it does. Null when the pre-flight produced no grade.
 *
 * @param report The pre-flight report.
 */
export function sourceQualitySummary(
  report: ExportPreflightReport | null | undefined,
): string | null {
  const grade = report?.lint?.grade;
  const score = report?.lint?.score;
  if (!grade || typeof score !== 'number') return null;
  return `Source quality ${grade} (${score}/100) under ${report?.style_guide?.name ?? 'the default style guide'}.`;
}
