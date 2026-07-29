/**
 * Pure model + helpers for the Primitives import wizard (#3469).
 *
 * These functions carry no React/DOM state so they can be unit-tested in isolation and
 * reused by both the wizard component and its tests. They mirror the REST import pipeline
 * contract (`POST /v1/primitives/{tenant}/import/review` and `.../import`, see
 * apiome-rest/src/app/primitives_routes.py): a source document is parsed into a
 * `name -> schema` map of definitions, reviewed for New / Identical / Conflict / Invalid
 * classification, and committed with per-conflict resolutions (keep / overwrite / rename).
 */

import yaml from 'yaml';
import Ajv2020 from 'ajv/dist/2020';
import type { ErrorObject } from 'ajv';
// The `$id` → namespace rule is registry identity, not detail-page presentation: it mirrors the API's
// `derive_base_uri` / `derive_schema_id` pair, so the import wizard reads it from the same helper the
// type-detail screen does rather than re-deriving the parse.
import { namespaceFromSchemaId } from './primitiveDetailModel';

/** Source-kind cards offered by the wizard — mirrors the REST `source_kind` values. */
export type SourceKind = 'json-schema' | 'type-def-bundle' | 'openapi';

/** Intake method tabs offered by the wizard's source step. */
export type SourceMethod = 'file' | 'url' | 'paste';

/** Per-type classification returned by the review endpoint. */
export type ReviewStatus = 'new' | 'identical' | 'conflict' | 'invalid';

/** Conflict-resolution action the commit path accepts for a conflicting type (#3464). */
export type ResolutionAction = 'keep' | 'overwrite' | 'rename';

/** One field-level validation error from the draft 2020-12 report. */
export interface ValidationError {
  field?: string;
  message?: string;
  [key: string]: unknown;
}

/** One reviewed type as returned by `POST .../import/review`. */
export interface ReviewType {
  name: string;
  status: ReviewStatus;
  valid: boolean;
  validation_errors: ValidationError[];
  error?: { error?: string; details?: unknown } | null;
  schema_id?: string | null;
  existing_id?: string | null;
  ref_count: number;
  unresolved_refs: Array<Record<string, unknown>>;
  allowed_resolutions: ResolutionAction[];
}

/** Summary counts returned by the review endpoint. */
export interface ReviewSummary {
  new: number;
  identical: number;
  conflict: number;
  invalid: number;
  total: number;
}

/** Full review report returned by `POST .../import/review`. */
export interface ReviewResponse {
  status: string;
  source_kind: string;
  source_label?: string | null;
  target_namespace?: string | null;
  warnings: string[];
  summary: ReviewSummary;
  types: ReviewType[];
  dedupe: boolean;
}

/** A user's resolution choice for one conflicting type. */
export interface Resolution {
  action: ResolutionAction;
  new_name?: string;
}

/** Per-type resolution map keyed by definition name. */
export type ResolutionMap = Record<string, Resolution>;

/** Import options surfaced in the wizard's source step. */
export interface ImportOptions {
  sourceKind: SourceKind;
  targetNamespace: string;
  mapCoreFormats: boolean;
  dedupe: boolean;
}

/** Outcome of a committed import, normalized from the REST `/import` report. */
export interface ImportResultSummary {
  imported: string[];
  overwritten: string[];
  renamed: Array<{ name: string; new_name?: string } | string>;
  identical: string[];
  skipped: Array<{ name: string; reason?: string } | string>;
  errors: Array<{ name: string; error?: string } | string>;
  warnings: string[];
  importId: string | null;
}

/**
 * Parse a raw source document as JSON, falling back to YAML.
 *
 * @param content Raw file / URL / paste text.
 * @returns The parsed object, or `null` when neither parser yields an object.
 */
export function parseSchemaContent(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    try {
      const parsed = yaml.parse(content);
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
}

/**
 * Whether a parsed document is a standalone primitive schema rather than a container.
 *
 * A document carrying `$defs`, `definitions`, or (for bundles) `types` is a container;
 * otherwise a `type` / `anyOf` / `oneOf` / `allOf` / `enum` / `const` keyword marks a
 * single standalone type definition (e.g. an ISO primitive).
 *
 * @param schema The parsed document.
 * @returns True when the document is a single standalone type.
 */
export function isStandalonePrimitiveSchema(schema: Record<string, unknown>): boolean {
  if (schema.$defs || schema.definitions || schema.types) {
    return false;
  }
  return (
    'type' in schema ||
    'anyOf' in schema ||
    'oneOf' in schema ||
    'allOf' in schema ||
    'enum' in schema ||
    'const' in schema
  );
}

/**
 * Derive a primitive name for a standalone schema.
 *
 * Priority: `$id` (last path segment) > `title` (slugified) > filename (without
 * extension) > a stable default.
 *
 * @param schema The standalone schema.
 * @param filename Optional source filename used as a fallback.
 * @returns A snake_case identifier for the primitive.
 */
export function extractPrimitiveNameFromSchema(
  schema: Record<string, unknown>,
  filename?: string
): string {
  if (typeof schema.$id === 'string' && schema.$id) {
    const lastSegment = schema.$id.split('/').pop();
    if (lastSegment) {
      return lastSegment.replace(/-/g, '_');
    }
  }

  if (typeof schema.title === 'string' && schema.title) {
    return schema.title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  if (filename) {
    return filename
      .replace(/\.(json|yaml|yml)$/i, '')
      .replace(/-/g, '_')
      .replace(/\s+/g, '_');
  }

  return 'imported_primitive';
}

/**
 * Determine a display category (JSON Schema type) for a definition.
 *
 * @param schema The definition schema.
 * @returns The resolved type label, defaulting to `object`.
 */
export function determineCategoryFromSchema(schema: Record<string, unknown>): string {
  if (schema.type) {
    if (typeof schema.type === 'string') {
      return schema.type;
    }
    if (Array.isArray(schema.type) && schema.type.length > 0) {
      return String(schema.type[0]);
    }
  }

  if (schema.anyOf || schema.oneOf) {
    const options = (schema.anyOf || schema.oneOf) as Record<string, unknown>[];
    if (options.length > 0 && 'const' in options[0]) {
      const firstConst = options[0].const;
      return typeof firstConst === 'string' ? 'string' : typeof firstConst;
    }
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return typeof schema.enum[0];
  }

  if ('const' in schema) {
    return typeof schema.const;
  }

  return 'object';
}

/**
 * Container keywords read for each source kind, in precedence order. A type-def bundle
 * reads `types` first (its native container) before the JSON Schema equivalents; mirrors
 * apiome-rest's `BUNDLE_CONTAINERS` and `_resolve_import_definitions`.
 */
const CONTAINER_KEYS: Record<SourceKind, string[]> = {
  'json-schema': ['$defs', 'definitions'],
  openapi: ['$defs', 'definitions'],
  'type-def-bundle': ['types', '$defs', 'definitions'],
};

/**
 * Extract the `name -> schema` definitions from a parsed source document for local preview.
 *
 * A standalone schema (no container) is wrapped under a derived name so the wizard can
 * preview it the same way it previews container members. The authoritative classification
 * still comes from the server review; this is only for the source-step preview.
 *
 * @param doc The parsed source document.
 * @param sourceKind The selected source kind (selects which containers are read).
 * @param filename Optional filename used when naming a standalone schema.
 * @returns A `name -> schema` map (possibly empty when no definitions are found).
 */
export function extractDefinitions(
  doc: Record<string, unknown>,
  sourceKind: SourceKind,
  filename?: string
): Record<string, Record<string, unknown>> {
  // A standalone (non-container) schema is only meaningful for JSON Schema / OpenAPI;
  // a bundle is expected to be a container.
  if (sourceKind !== 'type-def-bundle' && isStandalonePrimitiveSchema(doc)) {
    const name = extractPrimitiveNameFromSchema(doc, filename);
    return { [name]: doc };
  }

  const defs: Record<string, Record<string, unknown>> = {};
  for (const key of CONTAINER_KEYS[sourceKind]) {
    const container = doc[key];
    if (container && typeof container === 'object') {
      for (const [name, schema] of Object.entries(container as Record<string, unknown>)) {
        if (schema && typeof schema === 'object') {
          defs[name] = schema as Record<string, unknown>;
        }
      }
    }
  }
  return defs;
}

/** One detected definition, with the client-side verdict shown beside its name. */
export interface DetectedType {
  /** The definition's key in the source container — the name it will be imported under. */
  name: string;
  /** Whether it is a well-formed draft 2020-12 schema. */
  valid: boolean;
  /** The first metaschema error, when invalid — enough to say *why* without opening the review. */
  error?: string;
}

/**
 * Classify each detected definition as a valid or invalid draft 2020-12 schema.
 *
 * This is the same question the review endpoint's `valid` flag answers (``primitives_routes.py``:
 * a malformed draft 2020-12 fragment is `valid: false` with field-level `validation_errors`), asked
 * locally so the source step can show it before the round-trip. It is a *metaschema* check only —
 * `$ref`s are not resolved and scope is not considered, both of which remain the server's call, so a
 * type marked valid here can still come back from review as a conflict or a scope violation.
 *
 * @param definitions The `name -> schema` map from {@link extractDefinitions}.
 * @returns One entry per definition, in the container's declaration order.
 */
export function describeDetectedTypes(
  definitions: Record<string, Record<string, unknown>>
): DetectedType[] {
  const ajv = new Ajv2020({ strictSchema: false, allErrors: true });

  return Object.entries(definitions).map(([name, schema]) => {
    // `validateSchema` throws on a non-object, and reports rather than throws for a bad schema.
    if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
      return { name, valid: false, error: 'Not a JSON Schema object' };
    }
    try {
      if (ajv.validateSchema(schema) === true) {
        return { name, valid: true };
      }
      return { name, valid: false, error: firstSchemaError(ajv.errors) };
    } catch (err) {
      return { name, valid: false, error: err instanceof Error ? err.message : 'Invalid schema' };
    }
  });
}

/** Render the first metaschema error as `"<path> <message>"`, e.g. `/type must be equal to …`. */
function firstSchemaError(errors: ErrorObject[] | null | undefined): string {
  const first = (errors ?? [])[0];
  if (!first) return 'Not a valid draft 2020-12 schema';
  return [first.instancePath, first.message].filter(Boolean).join(' ').trim() || 'Not a valid draft 2020-12 schema';
}

/** The outcome of pulling a target namespace out of the document being imported. */
export interface TargetNamespaceExtraction {
  /** The namespace to fill the field with, or `null` when the document declares none. */
  namespace: string | null;
  /** Every distinct namespace the document's `$id`s point at, most frequent first. */
  candidates: string[];
  /** A short sentence for the UI explaining what was (or was not) found. */
  detail: string;
}

/**
 * Derive the target namespace from the `$id`s declared in the source document.
 *
 * The registry encodes a type's namespace in its `$id` (`…/types/<namespace>/<name>`), so a document
 * that was exported from a registry already states where its types belong — this reads that back so
 * the reader does not have to retype it.
 *
 * Both the document root and every extracted definition are considered, and the most frequently
 * declared namespace wins. A bundle whose types span several namespaces cannot be expressed in one
 * field, so the runners-up are still reported in {@link TargetNamespaceExtraction.candidates} and
 * named in `detail` — the choice is stated rather than silently made.
 *
 * @param doc The parsed source document.
 * @param sourceKind The selected source kind, which decides the definition containers.
 * @param sourceLabel Filename / URL used when naming a standalone schema.
 * @returns The chosen namespace, the full candidate list, and a sentence describing the outcome.
 */
export function extractTargetNamespace(
  doc: Record<string, unknown> | null,
  sourceKind: SourceKind,
  sourceLabel?: string
): TargetNamespaceExtraction {
  if (!doc) {
    return { namespace: null, candidates: [], detail: 'Load a document first.' };
  }

  // The root id first, so a document that names itself is weighted ahead of its members on a tie.
  const ids: string[] = [];
  if (typeof doc.$id === 'string') {
    ids.push(doc.$id);
  }
  for (const schema of Object.values(extractDefinitions(doc, sourceKind, sourceLabel))) {
    if (typeof schema.$id === 'string') {
      ids.push(schema.$id);
    }
  }

  const counts = new Map<string, number>();
  for (const id of ids) {
    const namespace = namespaceFromSchemaId(id);
    if (namespace) {
      counts.set(namespace, (counts.get(namespace) ?? 0) + 1);
    }
  }

  if (counts.size === 0) {
    return {
      namespace: null,
      candidates: [],
      detail: ids.length
        ? 'The $id values in this document carry no namespace above the type name.'
        : 'This document declares no $id to read a namespace from.',
    };
  }

  // Most frequent wins; ties keep encounter order, which puts the root id ahead of its members.
  const candidates = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([namespace]) => namespace);
  const [chosen, ...rest] = candidates;

  return {
    namespace: chosen,
    candidates,
    detail: rest.length
      ? `Using ${chosen}; this document also declares ${rest.join(', ')}.`
      : `Extracted ${chosen} from the document's $id.`,
  };
}

/**
 * Build the request body shared by the review and commit endpoints.
 *
 * For a standalone JSON Schema / OpenAPI document the single schema is wrapped under a
 * `$defs` container so the server resolves it uniformly; a bundle document is sent as-is.
 *
 * @param doc The parsed source document.
 * @param options The selected source kind, namespace, and import options.
 * @param sourceLabel Human label / filename / URL recorded as provenance.
 * @param selection When provided, the selected definition names and conflict resolutions
 *   to commit; omit for a review of all detected definitions.
 * @returns A request body for `/api/primitives/import` or `/api/primitives/import/review`.
 */
export function buildImportRequestBody(
  doc: Record<string, unknown>,
  options: ImportOptions,
  sourceLabel: string | null,
  selection?: { selectedNames: string[]; resolutions: ResolutionMap }
): Record<string, unknown> {
  let schema: Record<string, unknown> = doc;
  if (options.sourceKind !== 'type-def-bundle' && isStandalonePrimitiveSchema(doc)) {
    const name = extractPrimitiveNameFromSchema(doc, sourceLabel ?? undefined);
    schema = { $defs: { [name]: doc } };
  }

  const body: Record<string, unknown> = {
    schema,
    source_kind: options.sourceKind,
    source_label: sourceLabel,
    map_core_formats: options.mapCoreFormats,
    dedupe: options.dedupe,
  };

  if (options.targetNamespace.trim()) {
    body.target_namespace = options.targetNamespace.trim();
  }

  if (selection) {
    body.import_all = false;
    body.selected_definitions = selection.selectedNames;
    const resolutions = filterResolutions(selection.resolutions, selection.selectedNames);
    if (Object.keys(resolutions).length > 0) {
      body.resolutions = resolutions;
    }
  } else {
    // Review every detected definition so the user sees the full classification.
    body.import_all = true;
  }

  return body;
}

/**
 * Keep only resolutions for names that are still selected, dropping empty rename targets.
 *
 * @param resolutions The full per-type resolution map.
 * @param selectedNames Names the user chose to import.
 * @returns A pruned resolution map safe to send to the commit endpoint.
 */
export function filterResolutions(
  resolutions: ResolutionMap,
  selectedNames: string[]
): ResolutionMap {
  const selected = new Set(selectedNames);
  const out: ResolutionMap = {};
  for (const [name, resolution] of Object.entries(resolutions)) {
    if (!selected.has(name)) continue;
    if (resolution.action === 'rename') {
      out[name] = { action: 'rename', new_name: resolution.new_name?.trim() || '' };
    } else {
      out[name] = { action: resolution.action };
    }
  }
  return out;
}

/**
 * Seed a default resolution for every conflicting type (`keep` — surface, do not drop).
 *
 * @param types The reviewed types.
 * @returns A resolution map with one `keep` entry per conflict.
 */
export function defaultResolutions(types: ReviewType[]): ResolutionMap {
  const out: ResolutionMap = {};
  for (const type of types) {
    if (type.status === 'conflict') {
      out[type.name] = { action: 'keep' };
    }
  }
  return out;
}

/**
 * The set of type names selected by default when the review opens: every valid type that
 * is not an already-deduped identical (identical adds nothing) — i.e. New and Conflict.
 *
 * @param types The reviewed types.
 * @returns The names to pre-select for import.
 */
export function defaultSelectedNames(types: ReviewType[]): string[] {
  return types
    .filter((type) => type.status === 'new' || type.status === 'conflict')
    .map((type) => type.name);
}

/**
 * Validate the user's selection + resolutions before committing.
 *
 * @param selectedNames Names chosen for import.
 * @param types The reviewed types (for status lookup).
 * @param resolutions The current resolution map.
 * @returns An error string when the selection cannot be committed, else `null`.
 */
export function validateSelection(
  selectedNames: string[],
  types: ReviewType[],
  resolutions: ResolutionMap
): string | null {
  if (selectedNames.length === 0) {
    return 'Select at least one type to import';
  }

  const selected = new Set(selectedNames);
  const byName = new Map(types.map((type) => [type.name, type]));

  for (const name of selectedNames) {
    const type = byName.get(name);
    if (type && type.status === 'invalid') {
      return `"${name}" is not a valid draft 2020-12 schema and cannot be imported`;
    }
  }

  for (const [name, resolution] of Object.entries(resolutions)) {
    if (!selected.has(name)) continue;
    if (resolution.action === 'rename' && !resolution.new_name?.trim()) {
      return `Enter a new name for the renamed type "${name}"`;
    }
  }

  return null;
}

/** Coerce an unknown REST list field into a string/object array. */
function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * Normalize the REST `/import` response into an {@link ImportResultSummary}.
 *
 * @param data The parsed JSON body from `/api/primitives/import`.
 * @returns A normalized result with stable array fields.
 */
export function summarizeImportResult(data: Record<string, unknown>): ImportResultSummary {
  return {
    imported: asArray<string>(data.imported),
    overwritten: asArray<string>(data.overwritten),
    renamed: asArray(data.renamed),
    identical: asArray<string>(data.identical),
    skipped: asArray(data.skipped),
    errors: asArray(data.errors),
    warnings: asArray<string>(data.warnings),
    importId: typeof data.import_id === 'string' ? data.import_id : null,
  };
}

/**
 * One-line human summary of an import result for a toast message.
 *
 * @param result The normalized import result.
 * @returns A short status line (e.g. "Imported 3, overwritten 1, 2 error(s)").
 */
export function describeImportResult(result: ImportResultSummary): string {
  const parts: string[] = [`Imported ${result.imported.length}`];
  if (result.overwritten.length > 0) parts.push(`overwritten ${result.overwritten.length}`);
  if (result.renamed.length > 0) parts.push(`renamed ${result.renamed.length}`);
  if (result.identical.length > 0) parts.push(`identical ${result.identical.length}`);
  if (result.skipped.length > 0) parts.push(`skipped ${result.skipped.length}`);
  if (result.errors.length > 0) parts.push(`${result.errors.length} error(s)`);
  return parts.join(', ');
}

/** Human label for a source kind. */
export function sourceKindLabel(kind: SourceKind): string {
  switch (kind) {
    case 'json-schema':
      return 'JSON Schema';
    case 'type-def-bundle':
      return 'Type-def bundle';
    case 'openapi':
      return 'OpenAPI';
    default:
      return kind;
  }
}
