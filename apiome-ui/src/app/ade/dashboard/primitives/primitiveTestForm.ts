/**
 * Pure model for the Primitives type-detail "Test this type" form (#3468 follow-on).
 *
 * The detail page lets a reader exercise a registry type without leaving the screen: the schema is
 * projected into a form — an object becomes a field per property, a scalar becomes a single input,
 * and either can be tested as an array — and the instance the form builds is validated on **every
 * keystroke**. There is deliberately no "Check" button: validation is a pure function of the form
 * state, so it runs as the state changes.
 *
 * Everything here is presentation-free (no React, no DOM) so the projection, coercion, instance
 * building and validation all unit-test directly, mirroring `./primitiveDetailModel.ts`.
 *
 * Two client-side realities shape the design:
 *
 *  - **Unresolvable `$ref`s.** A primitive may reference sibling types by relative URI (`./decimal`).
 *    Those targets are not fetched here, and Ajv throws outright on a reference it cannot resolve, so
 *    {@link sanitizeForValidation} strips them and reports what it stripped. The affected field is
 *    validated *loosely* rather than not at all, and the UI says so — silently pretending a
 *    `$ref` field is fully checked would be the worse failure.
 *  - **Draft 2020-12.** Registry types declare 2020-12, so validation compiles through Ajv's 2020
 *    entry point rather than its draft-07 default.
 */

import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { ErrorObject } from 'ajv';

/** How a schema node is rendered in the form. */
export type FieldKind =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'enum'
  | 'object'
  | 'array'
  | 'null'
  /** No usable `type` (or an unresolved `$ref`) — the reader edits raw JSON for this node. */
  | 'unknown';

/** Recursion guard: schemas can be cyclic through `$defs`, and the form is not a schema browser. */
export const MAX_FORM_DEPTH = 5;

/** One node of the projected form tree. */
export interface TestField {
  /** Property name within the parent object; `''` for the root and for array items. */
  key: string;
  /** Human label — the property name, or the type's own title at the root. */
  label: string;
  kind: FieldKind;
  /** Whether the parent's `required` array lists this property. */
  required: boolean;
  description?: string;
  /** `pattern` for string fields — the regex applied live as the reader types. */
  pattern?: string;
  format?: string;
  enumValues?: unknown[];
  /** Object properties, in declaration order (`kind === 'object'`). */
  children?: TestField[];
  /** The item schema projection (`kind === 'array'`). */
  item?: TestField;
  /** A `$ref` that could not be resolved client-side; the node is validated loosely. */
  unresolvedRef?: string;
  /** The originating sub-schema, kept for constraint hints (min/max, lengths). */
  schema: Record<string, unknown>;
}

/** The form state the UI owns; every entry is keyed by the node's JSON Pointer. */
export interface TestFormState {
  /** Raw input text for scalar leaves — kept as typed so partial numbers survive editing. */
  values: Record<string, string>;
  /** Item count per array pointer. */
  arrayLengths: Record<string, number>;
  /** Explicit include/exclude per property pointer; absent means "use the field default". */
  included: Record<string, boolean>;
}

/** One validation problem, anchored to the instance node it concerns. */
export interface TestFinding {
  /** JSON Pointer into the instance (`''` is the root). */
  pointer: string;
  message: string;
  keyword: string;
}

/** The outcome of one real-time validation pass. */
export interface TestValidationResult {
  status: 'valid' | 'invalid' | 'unavailable';
  findings: TestFinding[];
  /** Set when the schema itself could not be compiled — the form stays usable, unvalidated. */
  schemaError?: string;
}

/** Escape a property name for use in a JSON Pointer (RFC 6901). */
export function escapePointerToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** The pointer of a child property beneath `parent`. */
export function childPointer(parent: string, key: string): string {
  return `${parent}/${escapePointerToken(key)}`;
}

/** The pointer of array element `index` beneath `parent`. */
export function itemPointer(parent: string, index: number): string {
  return `${parent}/${index}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A `$ref` Ajv can resolve on its own: a local pointer into the same document. */
function isLocalRef(ref: string): boolean {
  return ref.startsWith('#');
}

/**
 * Derive the form kind for a sub-schema.
 *
 * `enum`/`const` win over `type` because a constrained choice is better rendered as a picker than
 * as a free-text box of the underlying type. A union `type` array takes its first non-`null` member,
 * which is the common "nullable string" shape.
 */
export function deriveFieldKind(schema: Record<string, unknown>): FieldKind {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return 'enum';
  if ('const' in schema) return 'enum';

  const rawType = schema.type;
  const type = Array.isArray(rawType)
    ? (rawType.find((entry) => entry !== 'null') ?? 'null')
    : rawType;

  switch (type) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'integer':
      return 'integer';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array':
      return 'array';
    case 'object':
      return 'object';
    default:
      break;
  }

  // No declared `type` — infer from the shape-defining keywords before giving up.
  if (asRecord(schema.properties)) return 'object';
  if (schema.items !== undefined) return 'array';
  return 'unknown';
}

/**
 * Project a JSON Schema document into the form tree.
 *
 * @param schema - The schema (or sub-schema) to project.
 * @param options - `key`/`label` for the node, whether the parent requires it, and the depth so far.
 * @returns The projected field; `kind` is `'unknown'` for nodes the form cannot type.
 */
export function buildTestField(
  schema: unknown,
  options: { key?: string; label?: string; required?: boolean; depth?: number } = {},
): TestField {
  const { key = '', required = false, depth = 0 } = options;
  const node = asRecord(schema) ?? {};
  const label = options.label ?? (key || (typeof node.title === 'string' ? node.title : 'value'));

  const ref = typeof node.$ref === 'string' ? node.$ref : undefined;
  const unresolvedRef = ref && !isLocalRef(ref) ? ref : undefined;

  const base: TestField = {
    key,
    label,
    kind: deriveFieldKind(node),
    required,
    schema: node,
    description: typeof node.description === 'string' ? node.description : undefined,
    format: typeof node.format === 'string' ? node.format : undefined,
    pattern: typeof node.pattern === 'string' ? node.pattern : undefined,
    unresolvedRef,
  };

  if (Array.isArray(node.enum) && node.enum.length > 0) {
    base.enumValues = node.enum;
  } else if ('const' in node) {
    base.enumValues = [node.const];
  }

  // A node that is *only* an unresolved `$ref` has no local shape to render.
  if (unresolvedRef && base.kind === 'unknown') {
    return base;
  }

  if (depth >= MAX_FORM_DEPTH) {
    // Past the depth guard the subtree is edited as raw JSON rather than expanded further.
    return { ...base, kind: base.kind === 'object' || base.kind === 'array' ? 'unknown' : base.kind };
  }

  if (base.kind === 'object') {
    const properties = asRecord(node.properties) ?? {};
    const requiredNames = new Set(
      Array.isArray(node.required) ? node.required.filter((entry): entry is string => typeof entry === 'string') : [],
    );
    base.children = Object.entries(properties).map(([childKey, childSchema]) =>
      buildTestField(childSchema, {
        key: childKey,
        required: requiredNames.has(childKey),
        depth: depth + 1,
      }),
    );
  }

  if (base.kind === 'array') {
    // The form edits a homogeneous list, so a tuple schema is projected from its first `prefixItems`
    // entry. Ajv still validates against the real schema, so positional violations are reported.
    const prefix = Array.isArray(node.prefixItems) ? node.prefixItems[0] : undefined;
    const items = node.items !== undefined ? node.items : (prefix ?? {});
    base.item = buildTestField(items, { key: '', label: 'item', depth: depth + 1 });
  }

  return base;
}

/**
 * Strip references Ajv cannot resolve in the browser so the rest of the document still compiles.
 *
 * The `$ref` keyword is removed and any sibling keywords are kept, which is what turns "cannot
 * validate this type at all" into "validate everything except the referenced constraints".
 *
 * @param schema - The schema document to sanitize.
 * @returns The sanitized copy and the list of removed reference URIs (deduped, in encounter order).
 */
export function sanitizeForValidation(schema: unknown): { schema: unknown; unresolvedRefs: string[] } {
  const unresolvedRefs: string[] = [];

  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    const node = asRecord(value);
    if (!node) return value;

    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) {
      if (key === '$ref' && typeof child === 'string' && !isLocalRef(child)) {
        if (!unresolvedRefs.includes(child)) unresolvedRefs.push(child);
        continue;
      }
      output[key] = walk(child);
    }
    return output;
  };

  return { schema: walk(schema), unresolvedRefs };
}

/** A compiled, reusable validator for one schema document. */
export interface TestValidator {
  validate: (instance: unknown) => TestValidationResult;
  /** References dropped by {@link sanitizeForValidation} — those nodes are checked loosely. */
  unresolvedRefs: string[];
  /** Set when compilation failed outright; `validate` then reports `unavailable`. */
  schemaError?: string;
}

/**
 * Compile a schema into a real-time validator.
 *
 * @param schema - The primitive's schema document.
 * @param wrapInArray - Compile `{type: 'array', items: schema}` instead, for array test mode.
 * @returns A validator that never throws; compilation failure degrades to `unavailable`.
 */
export function compileTestValidator(schema: unknown, wrapInArray = false): TestValidator {
  const { schema: safeSchema, unresolvedRefs } = sanitizeForValidation(schema);

  // `$id` is dropped so repeated compiles (single ⇄ array mode) never collide in Ajv's registry,
  // and the array wrapper cannot inherit the item's identity.
  const inner = asRecord(safeSchema) ? { ...(safeSchema as Record<string, unknown>) } : safeSchema;
  if (asRecord(inner)) {
    delete (inner as Record<string, unknown>).$id;
    delete (inner as Record<string, unknown>).$schema;
  }
  const target = wrapInArray ? { type: 'array', items: inner } : inner;

  try {
    const ajv = new Ajv2020({
      strictSchema: false,
      allErrors: true,
      validateSchema: false,
      addUsedSchema: false,
    } as object);
    (addFormats as unknown as (instance: unknown) => void)(ajv);
    const validateFn = ajv.compile(target as object);

    return {
      unresolvedRefs,
      validate: (instance: unknown): TestValidationResult => {
        const valid = validateFn(instance);
        if (valid) return { status: 'valid', findings: [] };
        return { status: 'invalid', findings: toFindings(validateFn.errors ?? []) };
      },
    };
  } catch (err) {
    const schemaError = err instanceof Error ? err.message : 'Schema could not be compiled';
    return {
      unresolvedRefs,
      schemaError,
      validate: () => ({ status: 'unavailable', findings: [], schemaError }),
    };
  }
}

/**
 * Anchor Ajv errors onto the instance nodes the form renders.
 *
 * A missing required property reports against the *parent* with the name in `params`; the form wants
 * it on the property's own row, so those are re-pointed to the child.
 */
function toFindings(errors: ErrorObject[]): TestFinding[] {
  return errors.map((err) => {
    const params = (err.params ?? {}) as { missingProperty?: string };
    const pointer =
      err.keyword === 'required' && params.missingProperty
        ? childPointer(err.instancePath ?? '', params.missingProperty)
        : (err.instancePath ?? '');
    return {
      pointer,
      keyword: err.keyword,
      message: err.message ?? 'is invalid',
    };
  });
}

/** Group findings by the pointer they belong to, preserving order within each node. */
export function findingsByPointer(findings: TestFinding[]): Map<string, TestFinding[]> {
  const grouped = new Map<string, TestFinding[]>();
  for (const finding of findings) {
    const bucket = grouped.get(finding.pointer);
    if (bucket) bucket.push(finding);
    else grouped.set(finding.pointer, [finding]);
  }
  return grouped;
}

/** The result of turning one raw input string into a JSON value. */
export interface CoercionResult {
  value: unknown;
  /** Set when the text cannot be read as the field's type — surfaced on the field itself. */
  error?: string;
}

/**
 * Convert a scalar field's raw input text into the JSON value it denotes.
 *
 * Numbers keep their raw text in state (so `-`, `1.`, `1e` survive mid-edit) and are only rejected
 * here, where the message can be shown against the field.
 *
 * @param field - The field the text was typed into.
 * @param raw - The input's current text.
 * @returns The coerced value, plus a message when the text is not readable as that type.
 */
export function coerceScalar(field: TestField, raw: string): CoercionResult {
  const text = raw ?? '';

  switch (field.kind) {
    case 'boolean':
      return { value: text === 'true' };
    case 'number':
    case 'integer': {
      if (text.trim() === '') return { value: undefined, error: 'Enter a number' };
      const parsed = Number(text);
      if (!Number.isFinite(parsed)) return { value: text, error: `"${text}" is not a number` };
      if (field.kind === 'integer' && !Number.isInteger(parsed)) {
        // Handed to Ajv as-is so the schema's own `type: integer` error is what the reader sees.
        return { value: parsed };
      }
      return { value: parsed };
    }
    case 'null':
      return { value: null };
    case 'enum': {
      const match = (field.enumValues ?? []).find((candidate) => String(candidate) === text);
      return { value: match !== undefined ? match : text };
    }
    case 'unknown': {
      if (text.trim() === '') return { value: undefined };
      try {
        return { value: JSON.parse(text) };
      } catch {
        return { value: text, error: 'Enter valid JSON' };
      }
    }
    default:
      return { value: text };
  }
}

/** Whether a property is included in the built instance, defaulting to "required fields only". */
export function isIncluded(state: TestFormState, pointer: string, field: TestField): boolean {
  const explicit = state.included[pointer];
  return explicit === undefined ? field.required : explicit;
}

/** How many items an array node currently holds (default 1, so the form is never empty). */
export function arrayLength(state: TestFormState, pointer: string): number {
  const length = state.arrayLengths[pointer];
  return length === undefined ? 1 : Math.max(0, length);
}

/**
 * Build the JSON instance the form currently describes.
 *
 * @param field - The projected field tree.
 * @param state - The current form state.
 * @param pointer - The pointer of this node (`''` at the root).
 * @returns The instance value for this node; `undefined` means "omit this property".
 */
export function buildInstance(field: TestField, state: TestFormState, pointer = ''): unknown {
  switch (field.kind) {
    case 'object': {
      const output: Record<string, unknown> = {};
      for (const child of field.children ?? []) {
        const childPtr = childPointer(pointer, child.key);
        if (!isIncluded(state, childPtr, child)) continue;
        output[child.key] = buildInstance(child, state, childPtr);
      }
      return output;
    }
    case 'array': {
      const count = arrayLength(state, pointer);
      const item = field.item;
      if (!item) return [];
      return Array.from({ length: count }, (_unused, index) =>
        buildInstance(item, state, itemPointer(pointer, index)),
      );
    }
    default:
      return coerceScalar(field, state.values[pointer] ?? '').value;
  }
}

/**
 * Test a string against a schema `pattern`, live.
 *
 * JSON Schema patterns are unanchored ECMA-262 regexes, so this is a plain `RegExp#test`.
 *
 * @param pattern - The `pattern` keyword's regex source.
 * @param value - The current input text.
 * @returns `true`/`false` for a match, or `null` when the pattern is not a valid regex here.
 */
export function patternMatches(pattern: string, value: string): boolean | null {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return null;
  }
}

/**
 * Seed form state from a generated example instance, so the form opens populated rather than blank.
 *
 * @param field - The projected field tree.
 * @param example - An example instance (see `buildExampleInstance`); anything unusable is skipped.
 * @returns Form state with raw text, array lengths and inclusions filled in where the example had values.
 */
export function seedStateFromInstance(field: TestField, example: unknown): TestFormState {
  const state: TestFormState = { values: {}, arrayLengths: {}, included: {} };

  const walk = (node: TestField, value: unknown, pointer: string): void => {
    if (value === undefined) return;

    if (node.kind === 'object') {
      const record = asRecord(value);
      if (!record) return;
      for (const child of node.children ?? []) {
        const childPtr = childPointer(pointer, child.key);
        if (child.key in record) {
          state.included[childPtr] = true;
          walk(child, record[child.key], childPtr);
        }
      }
      return;
    }

    if (node.kind === 'array') {
      if (!Array.isArray(value) || !node.item) return;
      // An empty example array is left unrecorded so the length falls back to one row — seeding 0
      // would open the form with nothing to type into.
      if (value.length > 0) state.arrayLengths[pointer] = value.length;
      value.forEach((entry, index) => walk(node.item as TestField, entry, itemPointer(pointer, index)));
      return;
    }

    state.values[pointer] = value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  };

  walk(field, example, '');
  return state;
}
