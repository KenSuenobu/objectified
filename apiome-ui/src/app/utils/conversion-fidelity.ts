/**
 * Types and presentation helpers for the catalog → OpenAPI conversion preview (MFI-22.4, #4005).
 *
 * The authoritative fidelity report is computed server-side by apiome-rest's fidelity analyzer
 * (`app/fidelity.py`, MFI-22.3): it reads the emitter's per-value provenance (MFI-22.1) and the
 * paradigm projection's losses (MFI-22.2) and answers, *before* a conversion is committed, what the
 * converted OpenAPI spec will contain, what the conversion had to invent, and what it lost. The
 * conversion REST API (`POST /catalog/{artifactVersionId}/convert`, MFI-22.6) exposes it: a
 * `dryRun` returns the report (and the would-be OpenAPI document) with no side effects; a commit
 * runs the convert-to-project job (MFI-22.5).
 *
 * This module never recomputes the report — the score/grade/tier are the server's verdict. It only
 * carries the report's shape (mirroring the Python `FidelityReport` field-for-field, so the report
 * deserialises directly) and maps its coverage/tier signals to CSS utility classes and warning
 * copy for the preview dialog. All fetches use the native `fetch` + `AbortController` convention the
 * rest of the catalog screens use (see {@link fetchCatalogLintReport}); no client-side scoring.
 */

import { gradeChipClass } from './version-lint-report';
// Type-only: the projection summary the dry-run response embeds (CPDO-1.3). Type imports
// are erased at build time, so the value-level dependency stays one-way
// (conversion-projection.ts imports `cleanDefaults` from this module).
import type { ConversionManifestSummary } from './conversion-projection';

export { gradeChipClass };

/**
 * How completely one OpenAPI construct survived the conversion (mirrors `fidelity.Coverage`):
 * `present` carried faithfully from the source, `inferred` derived by the conversion, `partial`
 * a mix, `missing` a construct the source could have carried but this conversion has none of, and
 * `n/a` a construct with no counterpart for this source.
 */
export type Coverage = 'present' | 'inferred' | 'partial' | 'missing' | 'n/a';

/** Coarse three-band fidelity signal (mirrors `fidelity.FidelityTier`); drives warning strength. */
export type FidelityTier = 'high' | 'medium' | 'low';

/** How a source construct survived paradigm projection (mirrors `emitter.LossKind`). */
export type LossKind = 'inferred' | 'n/a';

/** One completeness-checklist row: how one OpenAPI construct fared (mirrors `fidelity.ChecklistItem`). */
export interface ChecklistItem {
  /** Stable slug for the construct, e.g. `responses`. */
  key: string;
  /** Human-readable construct name. */
  title: string;
  coverage: Coverage;
  /** How load-bearing the construct is; scales the score penalty. */
  weight: number;
  /** How many instances of the construct were considered. */
  count: number;
  /** Up to a few illustrative coordinates (JSON Pointers / source keys), sorted. */
  examples: string[];
  /** Human-readable explanation of the coverage tag. */
  reason: string;
}

/** One projection loss the conversion incurred (mirrors `emitter.Loss`). */
export interface Loss {
  kind: LossKind;
  /** Short slug for the lost/inferred construct kind, e.g. `graphql-subscription`. */
  subject: string;
  /** Human-readable explanation of the loss. */
  detail: string;
  /** Source coordinate or emitted JSON Pointer the loss concerns, when one applies. */
  pointer?: string | null;
}

/** The full fidelity report for one canonical-model → OpenAPI conversion (mirrors `fidelity.FidelityReport`). */
export interface FidelityReport {
  /** Weighted 0-100 fidelity score (100 = lossless). */
  score: number;
  /** A-F letter grade from the house bands (MFI-4.2). */
  grade: string;
  tier: FidelityTier;
  /** The completeness checklist, one row per construct, fixed order. */
  items: ChecklistItem[];
  /** Projection losses carried through from the emit result, sorted. */
  losses: Loss[];
  /** Count of checklist rows per coverage tag. */
  coverage_counts: Record<string, number>;
  /** Total penalty subtracted from 100 to reach `score` (transparency). */
  penalty: number;
}

/**
 * User-supplied defaults that close cheap gaps a source did not carry (info title/version, servers).
 * They flow into the commit so the converted spec starts less incomplete than a raw projection.
 */
export interface ConversionDefaults {
  title?: string;
  version?: string;
  /** Server base URLs; empty entries are dropped before sending. */
  servers?: string[];
}

/** The dry-run response: the fidelity report plus the would-be OpenAPI document for the raw preview. */
export interface ConversionDryRunResult {
  report: FidelityReport;
  /** The OpenAPI document the conversion would emit, for the collapsible raw preview. */
  openapi?: unknown;
  /** The source format that was converted (e.g. `graphql`), echoed for display. */
  sourceFormat?: string | null;
  /** The conversion target (only `openapi` today; the verb is target-generic, MFI-22.6). */
  target?: string;
  /**
   * The bounded projection-manifest summary for this conversion (CPDO-1.3): snapshot hash and
   * per-status/reason/scope tallies. The graph itself is paged separately (CPDO-3.1).
   */
  projection?: ConversionManifestSummary | null;
}

/** The commit response: the id of the project/version the conversion created (MFI-22.5). */
export interface ConversionCommitResult {
  projectId?: string;
  versionId?: string;
  report?: FidelityReport;
}

/** Coverage tags that land in the "What the source provides" column (constructs that reach the spec). */
export const PROVIDED_COVERAGES: readonly Coverage[] = ['present', 'inferred'];

/** Coverage tags that land in the "What OpenAPI favors but is missing" column. */
export const MISSING_COVERAGES: readonly Coverage[] = ['missing', 'partial', 'n/a'];

/** Split a checklist into the two preview columns: what the spec will contain vs. what it lacks. */
export function partitionChecklist(items: ChecklistItem[]): {
  provided: ChecklistItem[];
  missing: ChecklistItem[];
} {
  const provided: ChecklistItem[] = [];
  const missing: ChecklistItem[] = [];
  for (const item of items) {
    if (PROVIDED_COVERAGES.includes(item.coverage)) provided.push(item);
    else missing.push(item);
  }
  return { provided, missing };
}

/**
 * The status tone a coverage tag reads in (HIVE-7.1, #5318).
 *
 * How much of a construct survived the projection is a *state*, so it resolves through the
 * shared vocabulary — `ui/statusVocabulary.ts` — rather than through the five hand-written
 * `bg-emerald-100 text-emerald-800 dark:…` triples this replaces. `Badge status={…}` is what
 * paints it, so a "partial" here is the same amber as a "partial" anywhere else in the app.
 */
const COVERAGE_TONE: Record<Coverage, string> = {
  present: 'ok',
  inferred: 'accent',
  partial: 'warn',
  missing: 'danger',
  'n/a': 'neutral',
};

/**
 * The tone for a coverage tag.
 *
 * @param coverage The tag off the fidelity report.
 * @returns A `ui/statusVocabulary` tone; `neutral` for a tag this build does not know, so an
 *   unrecognised tag reads as "no opinion" rather than borrowing another tag's colour.
 */
export function coverageTone(coverage: string): string {
  return COVERAGE_TONE[coverage as Coverage] ?? 'neutral';
}

/** Short human label for a coverage tag, used in badges and column headers. */
export function coverageLabel(coverage: Coverage): string {
  switch (coverage) {
    case 'present':
      return 'from source';
    case 'inferred':
      return 'inferred';
    case 'partial':
      return 'partial';
    case 'missing':
      return 'missing';
    case 'n/a':
      return 'no OpenAPI form';
    default:
      return coverage;
  }
}

/** The mandatory warning sentence the preview must surface for every conversion (MFI-22.4). */
export const CONVERSION_WARNING_SENTENCE =
  'The fidelity of the original API may not be complete enough to create a fully defined ' +
  'OpenAPI Specification — review the gaps below before converting.';

/** How the warning banner presents for a given tier: its strength, copy, and whether it gates Convert. */
export interface TierWarning {
  /** Coarse severity that selects the banner's CSS palette. */
  severity: 'critical' | 'warning' | 'info';
  /** Whether Convert is disabled until the user explicitly acknowledges (low tier only). */
  requiresAck: boolean;
  /** Banner heading, scaled by tier. */
  heading: string;
  /** Banner body — always carries the mandatory warning sentence. */
  body: string;
  /** The acknowledgement checkbox label, shown only when `requiresAck`. */
  ackLabel: string;
}

/**
 * Describe the warning banner for a fidelity tier. The banner is shown for *every* conversion (the
 * catalog only holds non-OpenAPI sources), but its strength scales: a `low` tier warns critically
 * and is acknowledgement-gated (Convert stays disabled until the user acknowledges), while `medium`
 * and `high` warn/reassure without gating.
 */
export function tierWarning(tier: FidelityTier): TierWarning {
  switch (tier) {
    case 'low':
      return {
        severity: 'critical',
        requiresAck: true,
        heading: 'Low fidelity — this conversion will be substantially incomplete',
        body: CONVERSION_WARNING_SENTENCE,
        ackLabel:
          'I understand the converted spec will be incomplete and want to convert anyway.',
      };
    case 'medium':
      return {
        severity: 'warning',
        requiresAck: false,
        heading: 'Partial fidelity — some constructs had to be inferred',
        body: CONVERSION_WARNING_SENTENCE,
        ackLabel: 'I understand and want to convert.',
      };
    case 'high':
    default:
      return {
        severity: 'info',
        requiresAck: false,
        heading: 'High fidelity — a near-lossless conversion',
        body:
          'This source maps cleanly onto OpenAPI. ' + CONVERSION_WARNING_SENTENCE,
        ackLabel: 'I understand and want to convert.',
      };
  }
}

/**
 * The `Alert` variant the tier's warning banner takes (HIVE-7.1, #5318).
 *
 * The three severities map onto three of the banner tones the design language already has, so
 * the banner is an `Alert` rather than a bordered box with its own three-colour palette.
 *
 * @param severity The tier's severity, from {@link tierWarning}.
 * @returns An `Alert` variant name.
 */
export function tierBannerVariant(severity: TierWarning['severity']): 'danger' | 'warn' | 'ok' {
  switch (severity) {
    case 'critical':
      return 'danger';
    case 'warning':
      return 'warn';
    case 'info':
    default:
      return 'ok';
  }
}

/**
 * The status tone of the tier pill in the dialog header.
 *
 * @param tier The fidelity tier.
 * @returns A `ui/statusVocabulary` tone for `Badge status={…}`.
 */
export function tierTone(tier: FidelityTier): 'ok' | 'warn' | 'danger' {
  switch (tier) {
    case 'high':
      return 'ok';
    case 'medium':
      return 'warn';
    case 'low':
    default:
      return 'danger';
  }
}

/** Drop blank entries and trim a servers list before it flows into a request. */
export function normalizeServers(servers: string[] | undefined): string[] {
  if (!servers) return [];
  return servers.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Trim defaults and strip empty fields, so a commit only carries values the user actually supplied. */
export function cleanDefaults(defaults: ConversionDefaults): ConversionDefaults {
  const cleaned: ConversionDefaults = {};
  const title = defaults.title?.trim();
  const version = defaults.version?.trim();
  const servers = normalizeServers(defaults.servers);
  if (title) cleaned.title = title;
  if (version) cleaned.version = version;
  if (servers.length > 0) cleaned.servers = servers;
  return cleaned;
}

/** Parse a proxy JSON body, throwing the server's message when the request failed. */
async function readConversionResponse<T>(response: Response, fallback: string): Promise<T> {
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || (data as { success?: boolean }).success === false) {
    const message =
      (data && ((data as { error?: string }).error || (data as { detail?: string }).detail)) ||
      `${fallback} (HTTP ${response.status})`;
    throw new Error(typeof message === 'string' ? message : fallback);
  }
  return data as T;
}

/**
 * Dry-run a catalog item's conversion to OpenAPI (MFI-22.6): return the fidelity report and the
 * would-be OpenAPI document with **no side effects**. A catalog item's id is a project id; the REST
 * endpoint resolves its latest revision server-side. Optional {@link ConversionDefaults} let the
 * preview reflect gaps the user has offered to fill.
 * @throws Error with the server message when the request fails.
 */
export async function fetchConversionDryRun(
  itemId: string,
  options?: { defaults?: ConversionDefaults; signal?: AbortSignal }
): Promise<ConversionDryRunResult> {
  const response = await fetch(`/api/catalog/${encodeURIComponent(itemId)}/convert?dryRun=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      target: 'openapi',
      dryRun: true,
      defaults: options?.defaults ? cleanDefaults(options.defaults) : undefined,
    }),
    signal: options?.signal,
  });
  return readConversionResponse<ConversionDryRunResult>(response, 'Failed to preview conversion');
}

/**
 * Commit a catalog item's conversion to OpenAPI (MFI-22.5/22.6): create the project/version and
 * return its ids. User-supplied {@link ConversionDefaults} flow into the committed spec.
 * @throws Error with the server message when the request fails.
 */
export async function commitConversion(
  itemId: string,
  options?: { defaults?: ConversionDefaults; signal?: AbortSignal }
): Promise<ConversionCommitResult> {
  const response = await fetch(`/api/catalog/${encodeURIComponent(itemId)}/convert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      target: 'openapi',
      dryRun: false,
      defaults: options?.defaults ? cleanDefaults(options.defaults) : undefined,
    }),
    signal: options?.signal,
  });
  return readConversionResponse<ConversionCommitResult>(response, 'Failed to convert');
}
