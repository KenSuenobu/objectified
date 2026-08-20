/**
 * Export-target card catalog (MFX-6.1, #3855).
 *
 * The ExportDialog target grid is data-driven: `GET /api/export/targets` returns every
 * registered emitter (descriptor + capability profile + per-emit options schema, MFX-1.1/1.4)
 * together with a cheap per-source fidelity badge (tier + preserved-%, MFX-2.5). This module
 * maps that response into renderable target cards, resolves each card's Lucide icon, derives
 * the tier badge styling, and flattens a target's Pydantic-generated options JSON Schema into
 * a simple form model the dialog can render.
 *
 * Everything here is pure (no React, no fetch) so it can be unit-tested directly — mirroring
 * `../importSourceCatalog.ts`, whose icon resolver it reuses.
 */

import type { LucideIcon } from 'lucide-react';
import type { StatusTone } from '@/app/components/ui/statusVocabulary';
import {
  FIDELITY_BUCKET_TONE,
  PROJECTION_OUTCOME_TONE,
} from '@/app/components/ade/version-dialogs/versionDialogsModel';
import { resolveLucideIcon } from '../importSourceCatalog';
import { kindGlyph } from './exportFidelityPreview';

/** One-word fidelity badge for a (source, target) pairing (mirrors Python `ExportFidelityTier`). */
export type ExportFidelityTier = 'lossless' | 'lossy' | 'types-only';

/** An emitter's self-description (mirrors REST `EmitterDescriptor`, MFX-1.1). */
export interface ExportTargetDescriptor {
  /** Stable registry key, e.g. `"openapi"`. */
  key: string;
  /** Output format key this emitter produces, e.g. `"openapi-3.1"`. */
  format: string;
  /** Human label for the target card. */
  label: string;
  /** One-line description of what it exports. */
  description: string;
  /** Lucide icon name in kebab-case, e.g. `"file-json"`. */
  icon: string;
  /** The canonical paradigm this emitter primarily targets, e.g. `"rest"`. */
  paradigm: string;
  /** Whether the emitter produces a multi-file bundle (vs one artifact). */
  multi_file: boolean;
  /** Whether emit hard-requires an external toolchain binary. */
  needs_toolchain: boolean;
  /** Whether this emitter can run in the current runtime. Absent (older REST) is treated as `true`. */
  available?: boolean;
  /** Human-readable reason the target is unavailable, when `available` is `false`. */
  unavailable_reason?: string | null;
}

/** The cheap per-target fidelity summary for one source (mirrors Python `TargetFidelity`, MFX-2.5). */
export interface TargetFidelitySummary {
  /** One-word fidelity badge: lossless / lossy / types-only. */
  tier: ExportFidelityTier;
  /** Estimated share of constructs carried faithfully to the target, 0–100. */
  preserved_percent: number;
  /** Total source constructs the prediction considered. */
  total: number;
  /** Constructs carried faithfully. */
  preserved: number;
  /** Constructs dropped entirely. */
  dropped: number;
  /** Constructs represented imperfectly. */
  approximated: number;
  /** Constructs invented to satisfy the target. */
  synthesized: number;
}

/** One target entry from `GET /api/export/targets` (mirrors REST `ExportTargetFidelity`). */
export interface ExportTargetEntry {
  descriptor: ExportTargetDescriptor;
  /** Static capability flags (operations / events / unions / …); not rendered on the card yet. */
  capability_profile: Record<string, boolean>;
  /** JSON Schema for this target's per-emit options (MFX-1.4). */
  options_schema: Record<string, unknown>;
  /** Validated default option values for this target (MFX-1.4). */
  default_options: Record<string, unknown>;
  /** Per-source fidelity badge for exporting the requested source to this target. */
  fidelity: TargetFidelitySummary;
}

/** The full `GET /api/export/targets` response (mirrors REST `ExportTargetsResponse`). */
export interface ExportTargetsResponse {
  /** The artifact (project) id the fidelity was computed for. */
  artifact: string;
  /** The version selector as requested (label, UUID, or null for latest). */
  version?: string | null;
  /** The resolved revision record id. */
  version_record_id: string;
  /** The resolved revision's version label, e.g. `"1.2.0"`. */
  version_label?: string | null;
  /** Every registered target with its per-source fidelity, sorted by target key. */
  targets: ExportTargetEntry[];
}

/** A renderable target card: the entry plus its resolved icon component. */
export interface ExportTargetCard {
  /** Stable key (the descriptor's registry key). */
  key: string;
  /** The full REST entry backing this card. */
  entry: ExportTargetEntry;
  /** Resolved Lucide icon component for the card. */
  icon: LucideIcon;
  /** Whether the target can actually emit in this runtime. */
  available: boolean;
}

/**
 * Map the targets response into renderable cards, resolving each descriptor's icon.
 * Entries missing a descriptor key are skipped; server order (sorted by key) is preserved.
 *
 * @param response The `GET /api/export/targets` response (may be undefined while loading).
 * @returns One card per valid target entry.
 */
export function exportTargetCards(
  response: ExportTargetsResponse | null | undefined,
): ExportTargetCard[] {
  const cards: ExportTargetCard[] = [];
  for (const entry of response?.targets ?? []) {
    const key = entry?.descriptor?.key;
    if (typeof key !== 'string' || key.length === 0) continue;
    cards.push({
      key,
      entry,
      icon: resolveLucideIcon(entry.descriptor.icon),
      available: entry.descriptor.available !== false,
    });
  }
  return cards;
}

/**
 * Collapse a format string (a source import format like `protobuf`, or a target descriptor's
 * `key`/`format` like `proto` / `proto-3`) to a canonical family token, so a source and a target
 * that mean the same format compare equal. Lowercases, drops version suffixes and punctuation,
 * and folds well-known synonyms (`grpc`/`proto3` → `protobuf`, `oas`/`swagger` → `openapi`, …).
 *
 * @param value A source format or a target key/format string.
 * @returns The canonical family token, or null when the value is empty.
 */
export function canonicalFormatFamily(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  // Strip version numbers (`proto-3`, `openapi-3.1`, `avro-1.12`) and any punctuation.
  const base = value.toLowerCase().replace(/[^a-z]/g, '');
  if (!base) return null;
  const synonyms: Record<string, string> = {
    proto: 'protobuf',
    proto3: 'protobuf',
    protobuf: 'protobuf',
    grpc: 'protobuf',
    oas: 'openapi',
    openapi: 'openapi',
    swagger: 'openapi',
    graphql: 'graphql',
    gql: 'graphql',
    asyncapi: 'asyncapi',
    avro: 'avro',
    typespec: 'typespec',
    tsp: 'typespec',
    jsonschema: 'jsonschema',
  };
  return synonyms[base] ?? base;
}

/**
 * Whether a target emits the same format the source was imported as — a redundant round-trip
 * (e.g. a GraphQL source re-exported to GraphQL). Matched by canonical family against the
 * target's registry key and its output format, so `proto` / `proto-3` both match a `protobuf`
 * source.
 *
 * @param descriptor The target's descriptor.
 * @param sourceFormat The source's original import format (e.g. `graphql`).
 */
export function targetMatchesSourceFormat(
  descriptor: ExportTargetDescriptor,
  sourceFormat: string | null | undefined,
): boolean {
  const source = canonicalFormatFamily(sourceFormat);
  if (!source) return false;
  return (
    canonicalFormatFamily(descriptor.key) === source ||
    canonicalFormatFamily(descriptor.format) === source
  );
}

/**
 * Drop the target that merely re-emits the source's own format (MFX-41.1): exporting a GraphQL
 * source to GraphQL is a lossy round-trip when the original bytes are already on hand. The
 * "Original source" option replaces it. With no known `sourceFormat` (e.g. a version source),
 * every card is kept.
 *
 * @param cards The renderable target cards from {@link exportTargetCards}.
 * @param sourceFormat The source's original import format, when known.
 * @returns The cards with any same-format target removed.
 */
export function filterSameFormatTargets(
  cards: ExportTargetCard[],
  sourceFormat: string | null | undefined,
): ExportTargetCard[] {
  if (!canonicalFormatFamily(sourceFormat)) return cards;
  return cards.filter((card) => !targetMatchesSourceFormat(card.entry.descriptor, sourceFormat));
}

/** Human label for a fidelity tier, as printed on the card badge. */
export function tierLabel(tier: ExportFidelityTier): string {
  return tier;
}

/**
 * The tone of a fidelity tier badge (HIVE-6.3, #5314).
 *
 * `FIDELITY_BUCKET_TONE` is the same table the version panel's target chips, the fidelity
 * warning ring and the projection graph's node borders read, so one tier is one colour across
 * the whole export hand-off — and, being a tone name rather than a class pair, it follows all
 * nine themes.
 *
 * @param tier The tier the registry reported for this target.
 * @returns The tone name to hand `Badge`.
 */
export function tierTone(tier: ExportFidelityTier): StatusTone {
  return FIDELITY_BUCKET_TONE[tier] ?? FIDELITY_BUCKET_TONE['types-only'];
}

/** The version view's fidelity pre-summary rows (MFX-6.5): best-fidelity vs lossy targets. */
export interface FidelityPreSummary {
  /** Targets that carry this source cleanly (`lossless`). */
  best: ExportTargetCard[];
  /** Targets that degrade this source — `lossy` first, then `types-only` (worst last). */
  lossy: ExportTargetCard[];
}

/**
 * Split the target cards into the version view's fidelity pre-summary (MFX-6.5, #3859):
 * a "best-fidelity targets" row (lossless) and a "lossy targets" row (lossy, then types-only,
 * mirroring the mockup's amber-before-red ordering). Server order is preserved within a tier.
 *
 * @param cards The renderable target cards from {@link exportTargetCards}.
 * @returns The two pre-summary rows.
 */
export function fidelityPreSummary(cards: ExportTargetCard[]): FidelityPreSummary {
  const byTier = (tier: ExportFidelityTier) =>
    cards.filter((card) => card.entry.fidelity.tier === tier);
  return {
    best: byTier('lossless'),
    lossy: [...byTier('lossy'), ...byTier('types-only')],
  };
}

/** One count chip of the fidelity panel, in display order (worst first). */
export interface FidelityChip {
  /** Stable key for the chip. */
  key: 'dropped' | 'approximated' | 'synthesized' | 'preserved';
  /** Human label, e.g. `dropped`. */
  label: string;
  /** How many constructs fell into this bucket. */
  count: number;
  /**
   * The chip's tone, from the shared status vocabulary — what `Badge` takes (HIVE-6.3, #5314).
   *
   * The same table `projectionNodeStrokeVar` reads, so the count chip and the graph node it
   * summarises are the same colour.
   */
  tone: StatusTone;
  /**
   * The bucket's glyph (`✕ ≈ ✚ ✓`, from {@link kindGlyph}), rendered before the count so the chip
   * distinguishes itself by shape as well as colour (MFX-41.5 — no colour-only status).
   */
  glyph: string;
}

/**
 * Break a target's fidelity summary into the panel's count chips — `N dropped · N approximated ·
 * N synthesized · N clean` — dropping empty loss buckets. The `clean` chip always renders so a
 * lossless target still shows something positive.
 */
export function fidelityChips(fidelity: TargetFidelitySummary): FidelityChip[] {
  const lossChips: FidelityChip[] = [
    {
      key: 'dropped',
      label: 'dropped',
      count: fidelity.dropped,
      tone: PROJECTION_OUTCOME_TONE.dropped,
      glyph: kindGlyph('drop'),
    },
    {
      key: 'approximated',
      label: 'approximated',
      count: fidelity.approximated,
      tone: PROJECTION_OUTCOME_TONE.approximated,
      glyph: kindGlyph('approx'),
    },
    {
      key: 'synthesized',
      label: 'synthesized',
      count: fidelity.synthesized,
      tone: PROJECTION_OUTCOME_TONE.synthesized,
      glyph: kindGlyph('synth'),
    },
  ];
  const chips = lossChips.filter((chip) => chip.count > 0);
  chips.push({
    key: 'preserved',
    label: 'clean',
    count: fidelity.preserved,
    tone: PROJECTION_OUTCOME_TONE.clean,
    glyph: kindGlyph('ok'),
  });
  return chips;
}

// ===========================================================================
// Per-target options (MFX-1.4 schemas → a renderable form model)
// ===========================================================================

/** The kinds of option fields the dialog renders. Non-primitive fields are skipped. */
export type OptionFieldKind = 'boolean' | 'enum' | 'string';

/** One renderable per-target option field, flattened from the target's options JSON Schema. */
export interface OptionField {
  /** The option's property name in the emit request's `options` object. */
  key: string;
  /** Human label (the schema `title`, or the key humanized). */
  label: string;
  /** The schema `description`, when present. */
  description: string | null;
  /** How the field renders: a toggle, a segmented enum choice, or a text input. */
  kind: OptionFieldKind;
  /** The allowed values, for `enum` fields. */
  enumValues: string[];
  /** The target's validated default for this option (from `default_options`). */
  defaultValue: unknown;
  /** Whether the schema marks this option as required (listed in the schema's `required` array). */
  required: boolean;
}

/** A JSON-Schema node, loosely typed — Pydantic emits `$ref`/`allOf`/`anyOf` wrappers freely. */
type SchemaNode = Record<string, unknown>;

/** Resolve a local `#/$defs/...` reference against the root schema, or return null. */
function resolveRef(root: SchemaNode, ref: unknown): SchemaNode | null {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  let node: unknown = root;
  for (const part of ref.slice(2).split('/')) {
    if (typeof node !== 'object' || node === null) return null;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'object' && node !== null ? (node as SchemaNode) : null;
}

/**
 * Unwrap the Pydantic wrappers around a property schema:
 *  - `$ref` / single-entry `allOf: [{$ref}]` (enum classes) resolve through `$defs`;
 *  - `anyOf: [X, {type: "null"}]` (Optional fields) unwraps to `X`.
 */
function unwrapSchema(root: SchemaNode, node: SchemaNode): SchemaNode {
  let current = node;
  for (let depth = 0; depth < 4; depth++) {
    if (current.$ref) {
      const resolved = resolveRef(root, current.$ref);
      if (!resolved) return current;
      current = { ...resolved, ...current, $ref: undefined };
      continue;
    }
    const allOf = current.allOf;
    if (Array.isArray(allOf) && allOf.length === 1 && typeof allOf[0] === 'object') {
      current = { ...(allOf[0] as SchemaNode), ...current, allOf: undefined };
      continue;
    }
    const anyOf = current.anyOf;
    if (Array.isArray(anyOf)) {
      const nonNull = anyOf.filter(
        (option) => !(typeof option === 'object' && option !== null && (option as SchemaNode).type === 'null'),
      );
      if (nonNull.length === 1 && typeof nonNull[0] === 'object') {
        current = { ...(nonNull[0] as SchemaNode), ...current, anyOf: undefined };
        continue;
      }
      return current;
    }
    return current;
  }
  return current;
}

/** Humanize a snake_case option key into a label, e.g. `emit_services` → `Emit services`. */
function humanizeKey(key: string): string {
  const words = key.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Flatten a target's options JSON Schema (MFX-1.4) into the primitive fields the dialog can
 * render. Booleans become toggles, string enums become segmented choices, and plain strings
 * become text inputs; objects/arrays/dicts (e.g. persisted field-number maps) are advanced
 * options with no generic form control, so they are skipped and the emit request simply leaves
 * them at their server-side defaults.
 *
 * @param schema The target's `options_schema` (a Pydantic-generated JSON Schema).
 * @param defaults The target's validated `default_options` values.
 * @returns The renderable option fields, in schema property order.
 */
export function optionFieldsFromSchema(
  schema: Record<string, unknown> | null | undefined,
  defaults: Record<string, unknown> | null | undefined,
): OptionField[] {
  const root = (schema ?? {}) as SchemaNode;
  const properties = root.properties;
  if (typeof properties !== 'object' || properties === null) return [];

  const requiredKeys = new Set(
    Array.isArray(root.required)
      ? root.required.filter((value): value is string => typeof value === 'string')
      : [],
  );

  const fields: OptionField[] = [];
  for (const [key, rawNode] of Object.entries(properties as Record<string, unknown>)) {
    if (typeof rawNode !== 'object' || rawNode === null) continue;
    const node = unwrapSchema(root, rawNode as SchemaNode);
    const label = typeof node.title === 'string' && node.title.length > 0 ? node.title : humanizeKey(key);
    const description = typeof node.description === 'string' ? node.description : null;
    const defaultValue = defaults?.[key] ?? node.default ?? null;
    const required = requiredKeys.has(key);

    const enumValues = Array.isArray(node.enum)
      ? node.enum.filter((value): value is string => typeof value === 'string')
      : [];
    if (enumValues.length > 0) {
      fields.push({ key, label, description, kind: 'enum', enumValues, defaultValue, required });
      continue;
    }
    if (node.type === 'boolean') {
      fields.push({ key, label, description, kind: 'boolean', enumValues: [], defaultValue, required });
      continue;
    }
    if (node.type === 'string') {
      fields.push({ key, label, description, kind: 'string', enumValues: [], defaultValue, required });
    }
    // Other types (object/array/integer/…) have no generic control — skipped by design.
  }
  return fields;
}

/** The outcome of validating the export options form against the emitter's schema. */
export interface OptionValidationResult {
  /** Whether every rendered field holds a value the schema accepts. */
  valid: boolean;
  /** Per-field human-readable error message, keyed by option key; empty when valid. */
  errors: Record<string, string>;
}

/**
 * Validate the current option values against the target's flattened schema fields (MFX-1.4).
 *
 * Only the primitive fields the form actually renders are checked — the same fields
 * `optionFieldsFromSchema` returns — so the result matches what the user can see and fix:
 *  - a `required` field must hold a non-empty value;
 *  - an optional field left empty (null / undefined / `''`) is fine — the server applies its
 *    validated default;
 *  - an `enum` value must be one of the schema's allowed values;
 *  - a `boolean` value must be a boolean and a `string` value must be a string.
 *
 * The controls constrain most inputs already, so this mainly guards required options and
 * defends against stale values carried across a target change.
 *
 * @param fields The rendered option fields from {@link optionFieldsFromSchema}.
 * @param values The form's current values keyed by option key.
 * @returns Whether the form is valid, plus any per-field error messages.
 */
export function validateExportOptions(
  fields: OptionField[],
  values: Record<string, unknown>,
): OptionValidationResult {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const value = values[field.key];
    const isEmpty = value === null || value === undefined || value === '';
    if (isEmpty) {
      if (field.required) errors[field.key] = `${field.label} is required.`;
      continue;
    }
    if (field.kind === 'enum' && !field.enumValues.includes(value as string)) {
      errors[field.key] = `${field.label} must be one of: ${field.enumValues.join(', ')}.`;
    } else if (field.kind === 'boolean' && typeof value !== 'boolean') {
      errors[field.key] = `${field.label} must be true or false.`;
    } else if (field.kind === 'string' && typeof value !== 'string') {
      errors[field.key] = `${field.label} must be text.`;
    }
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * Compute the options payload to send with the emit request: only values that differ from the
 * target's defaults are included, so the server applies its own validated defaults for the rest
 * (and an untouched form sends no `options` at all).
 *
 * @param values The dialog's current option values keyed by option key.
 * @param defaults The target's validated `default_options`.
 * @returns The changed values, or `null` when nothing was changed.
 */
export function changedOptions(
  values: Record<string, unknown>,
  defaults: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  const changed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    const defaultValue = defaults?.[key] ?? null;
    if (value !== defaultValue) changed[key] = value;
  }
  return Object.keys(changed).length > 0 ? changed : null;
}
