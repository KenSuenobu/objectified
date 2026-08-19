/**
 * Presentation of the per-spec quality score the repository scanner stores (REPO-2.8, #2769).
 *
 * The REST Files listing returns four related fields per row — `quality_score`,
 * `quality_grade`, `quality_status` and `quality_reason`. This module turns that quartet into
 * the single badge the Files tab renders, so the "what does an unscored row look like?"
 * decision lives in one tested place instead of inline in the table.
 *
 * The score bands and their colour classes come from the shared 0–100 tier scale
 * ({@link getNumericScoreTier}), the same one Studio's quality gauges use, so a repository
 * file and an imported revision read identically at a glance.
 */

import { getNumericScoreTier, type NumericScoreTierStyle } from '@/app/utils/numeric-score-tier';
import type { StatusTone } from '@/app/components/ui/statusVocabulary';

/**
 * Score band → a tone in the shared status vocabulary (HIVE-7.5, #5322).
 *
 * `docs/mockups/sources/repository-detail.html` draws the Quality column as `badge--ok` at 86
 * and 78, `badge--warn` at 61 and `badge--danger` at 39 — three tones over four bands, so
 * *excellent* and *good* share `ok`. A file at 78 is not a problem, and colouring it amber
 * files it in a queue it does not belong to.
 */
const QUALITY_BAND_TONE: Readonly<Record<NumericScoreTierStyle['band'], StatusTone>> = {
  excellent: 'ok',
  good: 'ok',
  fair: 'warn',
  poor: 'danger',
};

/** The quality fields a Files-listing row carries. */
export interface RepositoryFileQualityFields {
  quality_score?: number | null;
  quality_grade?: string | null;
  quality_status?: string | null;
  quality_reason?: string | null;
}

/** What the Files tab renders in the Quality column for one row. */
export interface RepositoryFileQualityBadge {
  /** Short cell text: the score, or an em dash when there is nothing to show. */
  label: string;
  /** Hover text explaining the score or why there is none. */
  title: string;
  /**
   * Tailwind classes for the badge, from the shared score-tier scale when scored.
   *
   * @deprecated Since HIVE-7.5 (#5322): the Files tab renders `ui/Badge` with {@link tone}
   *   instead, so the score follows the reader's theme. Kept for the surfaces still on the
   *   palette pill until their own redesign tickets land.
   */
  className: string;
  /**
   * The badge's tone in the shared status vocabulary, or `outline` when the row is unscored —
   * an unscored file is *set aside*, not a failure, and the outline chip is the tone the
   * vocabulary spends on exactly that.
   */
  tone: StatusTone;
  /** The score tier, when the row is scored — lets callers reuse bars/gauges. */
  tier: NumericScoreTierStyle | null;
}

/** Class pair used whenever a row has no score to show, so every non-scored state matches. */
const NEUTRAL_CLASS = 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400';

/**
 * Human explanations for the machine reasons REST records on a skipped/errored row.
 * Anything not listed falls back to the raw reason, so a new server-side reason still renders.
 */
const REASON_LABELS: Record<string, string> = {
  unclassified: 'Not a classified spec — quality scoring only runs on recognised spec files.',
  'no-adapter': 'No importer for this format yet, so it cannot be scored.',
  'adapter-unavailable': 'The importer for this format is unavailable in this deployment.',
  'empty-document': 'The file is empty.',
  'too-large': 'The file is too large to score.',
  'fetch-failed': 'The file could not be downloaded from the provider.',
  'provider-unsupported': 'Quality scoring supports GitHub repositories in this release.',
  'no-token': 'A linked account is required to read files in this private repository.',
  'parse-failed': 'The file could not be parsed as its detected format.',
  'normalize-failed': 'The file parsed but could not be mapped to the canonical model.',
  'lint-failed': 'Scoring failed unexpectedly for this file.',
  unscored: 'The importer for this format does not produce a score.',
};

/**
 * Build the Quality-column badge for one Files-listing row.
 *
 * @param file - The row's quality fields (extra properties are ignored).
 * @returns The label, hover text, classes, and tier to render.
 */
export function repositoryFileQualityBadge(
  file: RepositoryFileQualityFields
): RepositoryFileQualityBadge {
  const score = file.quality_score;
  if (typeof score === 'number' && Number.isFinite(score)) {
    const tier = getNumericScoreTier(score);
    const grade = file.quality_grade ? ` (${file.quality_grade})` : '';
    return {
      label: String(Math.round(score)),
      title: `Quality ${Math.round(score)}/100${grade} — ${tier.shortLabel}: ${tier.detailLabel}. Informational only; it does not gate import or sync.`,
      className: `bg-gray-100 dark:bg-gray-700 ${tier.textClass}`,
      tone: QUALITY_BAND_TONE[tier.band],
      tier,
    };
  }

  const reason = (file.quality_reason || '').trim();
  if (reason) {
    return {
      label: '—',
      title: REASON_LABELS[reason] || `Not scored: ${reason}`,
      className: NEUTRAL_CLASS,
      tone: 'outline',
      tier: null,
    };
  }

  return {
    label: '—',
    title: 'Not scored yet. Classified specs are scored in the background after a scan.',
    className: NEUTRAL_CLASS,
    tone: 'outline',
    tier: null,
  };
}
