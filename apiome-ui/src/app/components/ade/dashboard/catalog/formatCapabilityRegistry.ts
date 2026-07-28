/**
 * Source-format capability & parsing-limit registry contract (CPDO-2.4, #4796).
 *
 * `GET /api/import/format-capabilities` returns the versioned registry: one entry per registered
 * import source — the native hierarchy its analyzer models, the quality of the source locations it
 * can point at, the value visibility it can ever carry, the grammar it knowingly does not read,
 * how much survives the projection onto the canonical model, and whether the format converts —
 * each stamped with the analyzer key/version and tool versions backing the claim. This module
 * mirrors those Python models field-for-field so the response deserialises directly, and adds the
 * pure logic the catalog UI needs to render only *trustworthy* explanations:
 *
 * - `isKnownAbsenceCategory` / `isKnownAnalysisReason` — reject any code outside the canonical
 *   vocabulary, so a screen never renders a category it has no reviewed wording for;
 * - `explainAnalysisAbsence` — resolve a stored analysis status + reason code onto its reviewed
 *   explanation, mirroring Python `explain_analysis_absence`;
 * - `explainConstruct` — resolve "the tree has no node for this" onto *modelled and absent*,
 *   *knowingly unmodelled*, or *no statement*, mirroring Python `explain_construct`;
 * - `renderAbsence` — substitute the single `{construct}` slot;
 * - `validateFormatCapabilitySnapshot` — a whole-snapshot contract check the UI/tests run so an
 *   untrustworthy registry is refused whole rather than rendered.
 *
 * **The invariant this file exists to hold.** `sourceMissing` is true for exactly one absence
 * category (`source_missing`), reachable only from the `no_source_captured` analysis reason.
 * A parse limit, a capability boundary, an analyzer failure, a redaction and an unmodelled
 * construct all leave it false — so a screen that gates its "the source was not captured" wording
 * on this flag cannot report unparsed data as source-missing. `validateFormatCapabilitySnapshot`
 * enforces it on the wire too: a snapshot that flags any other category is rejected.
 *
 * Everything here is pure (no React, no fetch) so it can be unit-tested directly — mirroring
 * `../export/capabilityRegistry.ts`. The vocabulary below is asserted against the committed
 * snapshot at `scripts/format_capabilities/vocabulary.json` by
 * `apiome-ui/tests/format-capability-registry.test.ts`, whose Python counterpart
 * (`apiome-rest/tests/test_format_capability_registry.py`) asserts the same for
 * `apiome-rest/src/app/format_capability_registry.py`. Either side drifting turns a suite red.
 */

/** Where an entry's claims come from (mirrors Python `CapabilityProvenance`). */
export type CapabilityProvenance = 'reviewed' | 'derived' | 'unknown_format';

/** Whether a format can be imported and analysed here (mirrors Python `FormatAvailability`). */
export type FormatAvailability =
  | 'available'
  | 'tool_unavailable'
  | 'preview_only'
  | 'unregistered';

/** How much of the format's own structure the analysis tree keeps (mirrors `NativeHierarchy`). */
export type NativeHierarchy = 'native' | 'generic' | 'none';

/** The best source pointer a node can carry (mirrors Python `SourceLocationQuality`). */
export type SourceLocationQuality = 'byte_offsets' | 'line_numbers' | 'path_only' | 'none';

/** How much survives onto the canonical model (mirrors Python `ProjectionCoverage`). */
export type ProjectionCoverage = 'full' | 'partial' | 'none' | 'unknown';

/** Whether the format participates in the conversion graph (mirrors `ConversionSupport`). */
export type ConversionSupport = 'supported' | 'tool_unavailable' | 'unsupported';

/** Why a detail is not there (mirrors Python `AbsenceCategory`). */
export type AbsenceCategory =
  | 'source_missing'
  | 'not_analyzed'
  | 'format_unsupported'
  | 'parse_limit'
  | 'analyzer_failed'
  | 'value_redacted'
  | 'absent_in_source'
  | 'undeclared';

/** What the registry can say about one construct (mirrors Python `ConstructAvailability`). */
export type ConstructAvailability = 'modelled' | 'unmodelled' | 'undeclared';

/** A stored payload-analysis reason code (mirrors Python `ANALYSIS_REASONS`, CPDO-1.1). */
export type AnalysisReasonCode =
  | 'not_analyzed'
  | 'no_source_captured'
  | 'unsupported_format'
  | 'bounds_exceeded'
  | 'analyzer_failed';

/** The canonical absence categories, in vocabulary order (mirrors Python `AbsenceCategory`). */
export const ABSENCE_CATEGORIES: readonly AbsenceCategory[] = [
  'source_missing',
  'not_analyzed',
  'format_unsupported',
  'parse_limit',
  'analyzer_failed',
  'value_redacted',
  'absent_in_source',
  'undeclared',
];

/** The canonical analysis reason codes, in vocabulary order (mirrors `ANALYSIS_REASONS`). */
export const ANALYSIS_REASON_CODES: readonly AnalysisReasonCode[] = [
  'not_analyzed',
  'no_source_captured',
  'unsupported_format',
  'bounds_exceeded',
  'analyzer_failed',
];

/**
 * Analysis reason code → absence category (mirrors Python `REASON_ABSENCE_CATEGORIES`).
 *
 * The only route to `source_missing` is `no_source_captured`. A bounds/grammar limit maps to
 * `parse_limit`, which says the opposite: the data is in the source and apiome has no description
 * of it.
 */
export const REASON_ABSENCE_CATEGORIES: Readonly<Record<AnalysisReasonCode, AbsenceCategory>> = {
  not_analyzed: 'not_analyzed',
  no_source_captured: 'source_missing',
  unsupported_format: 'format_unsupported',
  bounds_exceeded: 'parse_limit',
  analyzer_failed: 'analyzer_failed',
};

const ABSENCE_CATEGORY_SET: ReadonlySet<string> = new Set(ABSENCE_CATEGORIES);
const ANALYSIS_REASON_SET: ReadonlySet<string> = new Set(ANALYSIS_REASON_CODES);

/** The one absence category that means the customer's source material is genuinely not there. */
export const SOURCE_MISSING_CATEGORY: AbsenceCategory = 'source_missing';

/** Which analyzer backs an entry's claims (mirrors Python `AnalyzerEvidence`). */
export interface AnalyzerEvidence {
  /** Analyzer key (the adapter key, or `generic` for the format-blind walk). */
  key: string;
  /** The analyzer implementation version this entry describes. */
  version: string;
  /** Underlying parser/library versions it leans on. */
  tool_versions: Record<string, string>;
}

/** The best source pointer this format's nodes can carry (mirrors `SourceLocationSupport`). */
export interface SourceLocationSupport {
  quality: SourceLocationQuality;
  note: string;
}

/** The value material this format's analysis can ever carry (mirrors `ValueVisibilitySupport`). */
export interface ValueVisibilitySupport {
  /** The level applied when no explicit policy is chosen. */
  default: string;
  /** The ceiling the analyzer imposes — `none` when it observes no values at all. */
  maximum: string;
  note: string;
}

/** How much of the native analysis survives normalization (mirrors `CanonicalProjectionSupport`). */
export interface CanonicalProjectionSupport {
  coverage: ProjectionCoverage;
  /** Reviewed construct keys the canonical model has no representation for. */
  dropped_constructs: string[];
  note: string;
}

/** Whether the format converts, and by which route (mirrors `ConversionSupportEntry`). */
export interface ConversionSupportEntry {
  support: ConversionSupport;
  /** Declared keys that resolve to a registered normalizer. */
  canonical_formats: string[];
  /** True when the adapter builds the canonical model itself — a route, not a gap. */
  normalizes_in_adapter: boolean;
  /** Every format key the adapter declares (normalizer keys plus detection aliases). */
  declared_formats: string[];
  note: string;
}

/** The versioned capability entry for one source format (mirrors Python `FormatCapability`). */
export interface FormatCapability {
  format: string;
  label: string;
  paradigm: string | null;
  provenance: CapabilityProvenance;
  availability: FormatAvailability;
  unavailable_reason: string | null;
  native_hierarchy: NativeHierarchy;
  native_hierarchy_note: string;
  analyzer: AnalyzerEvidence;
  source_location: SourceLocationSupport;
  value_visibility: ValueVisibilitySupport;
  /** Construct keys the analyzer models — their absence from a tree means the source lacked them. */
  supported_constructs: string[];
  /** Construct keys it knowingly does not model — their absence means nothing about the source. */
  unsupported_constructs: string[];
  /** The numeric parsing limits in force (node/depth budgets, value preview length). */
  limits: Record<string, number>;
  canonical_projection: CanonicalProjectionSupport;
  conversion: ConversionSupportEntry;
  notes: string[];
  registry_version: string;
  review_date: string;
}

/** The reviewed wording for one absence category (mirrors Python `AbsenceExplanation`). */
export interface AbsenceExplanation {
  category: AbsenceCategory;
  category_label: string;
  /** Reviewed one-line explanation carrying a single `{construct}` slot. */
  summary_template: string;
  remediation: string;
  /** True only when the source material itself was never captured. */
  source_missing: boolean;
}

/** The full registry view exposed to the UI (mirrors Python `FormatCapabilitySnapshot`). */
export interface FormatCapabilitySnapshot {
  version: string;
  review_date: string;
  /** The payload-analysis contract version this registry's reason mapping pairs with. */
  analysis_schema_version: string;
  absence_categories: string[];
  absences: AbsenceExplanation[];
  reason_absence_categories: Record<string, string>;
  formats: FormatCapability[];
}

/** A resolved construct-level explanation (mirrors Python `ConstructExplanation`). */
export interface ConstructExplanation {
  format: string;
  construct_key: string;
  availability: ConstructAvailability;
  category: AbsenceCategory;
  summary: string;
  remediation: string;
  /** Always false — a construct's absence never means the source is missing. */
  source_missing: boolean;
}

/** Return true when `code` is a member of the canonical absence vocabulary. */
export function isKnownAbsenceCategory(code: string): code is AbsenceCategory {
  return ABSENCE_CATEGORY_SET.has(code);
}

/** Return true when `code` is a member of the canonical analysis-reason vocabulary. */
export function isKnownAnalysisReason(code: string): code is AnalysisReasonCode {
  return ANALYSIS_REASON_SET.has(code);
}

/**
 * Render a reviewed explanation, substituting its single `{construct}` slot.
 *
 * Mirrors Python `render_absence`: only the slot is substituted, and only with a backticked
 * construct key. Without a construct the neutral phrase keeps the sentence readable.
 */
export function renderAbsence(explanation: AbsenceExplanation, construct?: string | null): string {
  const named = construct ? `\`${construct}\`` : 'this detail';
  return explanation.summary_template.split('{construct}').join(named);
}

/** Look up the reviewed explanation for `category` in a snapshot, or null when absent. */
export function absenceExplanation(
  snapshot: FormatCapabilitySnapshot,
  category: AbsenceCategory,
): AbsenceExplanation | null {
  return snapshot.absences.find((entry) => entry.category === category) ?? null;
}

/**
 * Resolve a stored analysis status + reason code onto its reviewed explanation.
 *
 * Mirrors Python `explain_analysis_absence`, including its two conservative fallbacks: a
 * non-available status with no reason, and a reason code this contract has never seen, both
 * resolve to `not_analyzed` rather than to anything that would claim more than is known. An
 * `available` analysis with no reason has no absence to explain and yields `null`.
 *
 * @param snapshot The loaded registry snapshot (the source of the reviewed wording).
 * @param status The stored analysis status (`available` / `partial` / `unavailable` / `failed`).
 * @param reason The stored reason code, or null.
 */
export function explainAnalysisAbsence(
  snapshot: FormatCapabilitySnapshot,
  status: string,
  reason: string | null | undefined,
): AbsenceExplanation | null {
  if (status === 'available' && !reason) {
    return null;
  }
  const category =
    reason && isKnownAnalysisReason(reason) ? REASON_ABSENCE_CATEGORIES[reason] : 'not_analyzed';
  return absenceExplanation(snapshot, category);
}

/**
 * Resolve what one construct's absence from `capability`'s analysis means.
 *
 * Mirrors Python `explain_construct`. Three outcomes, and none of them is source-missing:
 * the analyzer **models** it (so this source does not contain it), the analyzer **declares it
 * unmodelled** (so the source may well contain it and apiome has no description), or neither list
 * names it (so the registry has nothing to say).
 *
 * @param snapshot The loaded registry snapshot.
 * @param capability The format's capability entry.
 * @param construct The analyzer's dotted construct key.
 */
export function explainConstruct(
  snapshot: FormatCapabilitySnapshot,
  capability: FormatCapability,
  construct: string,
): ConstructExplanation {
  const key = construct.trim();
  let availability: ConstructAvailability = 'undeclared';
  let category: AbsenceCategory = 'undeclared';
  if (key && capability.supported_constructs.includes(key)) {
    availability = 'modelled';
    category = 'absent_in_source';
  } else if (key && capability.unsupported_constructs.includes(key)) {
    availability = 'unmodelled';
    category = 'parse_limit';
  }
  const explanation = absenceExplanation(snapshot, category);
  return {
    format: capability.format,
    construct_key: key,
    availability,
    category,
    summary: explanation ? renderAbsence(explanation, key || null) : '',
    remediation: explanation?.remediation ?? '',
    source_missing: false,
  };
}

/** Look up one format's entry in a snapshot, or null when it carries none. */
export function capabilityForFormat(
  snapshot: FormatCapabilitySnapshot,
  format: string | null | undefined,
): FormatCapability | null {
  if (!format) return null;
  const key = format.trim().toLowerCase();
  return snapshot.formats.find((entry) => entry.format === key) ?? null;
}

/** A single problem found while validating a {@link FormatCapabilitySnapshot}. */
export interface RegistryContractIssue {
  /** Where the issue was found (e.g. `"absences[3].category"`). */
  path: string;
  /** Human description of the contract violation. */
  message: string;
}

/**
 * Validate a whole registry snapshot against the UI contract.
 *
 * Rejects a snapshot whose vocabulary the UI cannot render honestly: an unknown absence category
 * (declared or on an explanation), an unknown analysis reason code in the reason map, a reason
 * mapped to a category outside the vocabulary — and, the load-bearing one, **any explanation other
 * than `source_missing` that claims `source_missing`**, or a `source_missing` explanation that
 * does not. That last pair is what makes "the UI never reports unparsed data as source-missing" a
 * property of the wire contract rather than of each component that renders it.
 *
 * @returns Every issue found; an empty array when the snapshot is trustworthy.
 */
export function validateFormatCapabilitySnapshot(
  snapshot: FormatCapabilitySnapshot,
): RegistryContractIssue[] {
  const issues: RegistryContractIssue[] = [];

  snapshot.absence_categories.forEach((code, index) => {
    if (!isKnownAbsenceCategory(code)) {
      issues.push({
        path: `absence_categories[${index}]`,
        message: `unknown absence category ${JSON.stringify(code)}`,
      });
    }
  });

  snapshot.absences.forEach((explanation, index) => {
    if (!isKnownAbsenceCategory(explanation.category)) {
      issues.push({
        path: `absences[${index}].category`,
        message: `unknown absence category ${JSON.stringify(explanation.category)}`,
      });
      return;
    }
    const shouldFlag = explanation.category === SOURCE_MISSING_CATEGORY;
    if (explanation.source_missing !== shouldFlag) {
      issues.push({
        path: `absences[${index}].source_missing`,
        message: shouldFlag
          ? `category ${explanation.category} must be the source-missing category`
          : `category ${explanation.category} must not claim the source is missing`,
      });
    }
  });

  Object.entries(snapshot.reason_absence_categories).forEach(([reason, category]) => {
    if (!isKnownAnalysisReason(reason)) {
      issues.push({
        path: `reason_absence_categories.${reason}`,
        message: `unknown analysis reason ${JSON.stringify(reason)}`,
      });
    }
    if (!isKnownAbsenceCategory(category)) {
      issues.push({
        path: `reason_absence_categories.${reason}`,
        message: `unknown absence category ${JSON.stringify(category)}`,
      });
    }
  });

  return issues;
}
