/**
 * Schema Test Bench — pure helpers and API types (IXH-5.3, #5115).
 *
 * The bench (components/ade/dashboard/test-bench/) validates payloads against a schema picked
 * from a catalog item or project version. Everything here is dependency-free and pure so the
 * bench's behavior — reference building, pointer→editor-range anchoring, curl/fixture export —
 * is testable without a DOM, Monaco, or the network:
 *
 *  - the TypeScript mirrors of the REST payloads (IXH-5.1 validate, 5.2 synthesize, 5.3 targets);
 *  - {@link buildSchemaRef} / {@link describeTarget} — the path-shaped reference grammar;
 *  - {@link jsonPointerRanges} / {@link findingsToMarkers} — anchoring RFC 6901 pointers onto
 *    the payload text as Monaco marker ranges;
 *  - {@link buildCurlCommand} — a ready-to-run `curl` against the REST validate endpoint;
 *  - {@link buildCorpusFixture} — a validated payload as an IXH-1.1 corpus manifest entry.
 */

import type { CorpusEntry } from '@lib/corpus/corpus';

// ===========================================================================
// REST payload mirrors
// ===========================================================================

/** One named type a revision offers (REST `SchemaTargetType`). */
export interface SchemaTargetType {
  key: string;
  name: string;
  kind: string;
}

/** One operation request/response body target (REST `SchemaOperationBodyTarget`). */
export interface SchemaOperationBodyTarget {
  operation_key: string;
  operation_name: string;
  http_method?: string | null;
  http_path?: string | null;
  role: string;
  status_code?: string | null;
  type_key: string;
  type_name: string;
  list_wrapped?: boolean;
}

/** A condition that limited a listing/validation, never a failure of the payload. */
export interface BenchDiagnostic {
  code: string;
  message: string;
  pointer?: string | null;
}

/** The `/api/schemas/targets` payload the picker renders. */
export interface SchemaTargetsPayload {
  success: boolean;
  tenant_slug?: string;
  schema_ref?: string;
  types?: SchemaTargetType[];
  operation_bodies?: SchemaOperationBodyTarget[];
  xml_document?: boolean;
  diagnostics?: BenchDiagnostic[];
  error?: string;
  detail?: unknown;
}

/** One way the payload failed the schema (REST `InstanceFinding`). */
export interface BenchFinding {
  pointer: string;
  keyword: string;
  schema_pointer?: string;
  expected?: unknown;
  actual?: unknown;
  message: string;
  line?: number | null;
  column?: number | null;
  truncated?: boolean;
}

/** The `/api/schemas/validate` payload (REST `SchemaInstanceValidationResponse`). */
export interface BenchValidationPayload {
  success: boolean;
  ok?: boolean;
  valid?: boolean | null;
  validated?: boolean;
  validator?: string | null;
  schema_ref?: string;
  findings?: BenchFinding[];
  total_findings?: number;
  truncated?: boolean;
  diagnostics?: BenchDiagnostic[];
  error?: { code?: string; message?: string; remediation?: string } | string | null;
  detail?: unknown;
}

/** One generated payload (REST `SynthesizedInstance`, trimmed to what the bench shows). */
export interface BenchSynthesizedInstance {
  id: string;
  kind: 'minimal' | 'full' | 'branch' | 'mutant' | string;
  title: string;
  description: string;
  instance?: unknown;
  synthetic: boolean;
  expected_valid: boolean;
  valid?: boolean | null;
}

/** The `/api/schemas/synthesize` payload (REST `SchemaSynthesisResponse`, trimmed). */
export interface BenchSynthesisPayload {
  success: boolean;
  ok?: boolean;
  synthetic?: boolean;
  notice?: string;
  seed?: number;
  instances?: BenchSynthesizedInstance[];
  rejected_mutants?: number;
  diagnostics?: BenchDiagnostic[];
  error?: { code?: string; message?: string; remediation?: string } | string | null;
  detail?: unknown;
}

// ===========================================================================
// Reference building
// ===========================================================================

/** Which detail surface the bench is mounted on. */
export type BenchSurface = 'catalog' | 'project';

/** A schema the user picked in the bench, with everything needed to address and label it. */
export interface BenchSchemaSelection {
  /** The full path-shaped reference (`project/petstore/1.0.0/acme.Pet`). */
  ref: string;
  /** Human label for the selection (`POST /orders — request body (Order)`). */
  label: string;
  /** Where the selection came from, for grouping/badging. */
  source: 'operation' | 'type' | 'registry' | 'document';
  /** How payloads for this selection are read; JSON unless the schema is an XML grammar. */
  mediaType?: 'application/json' | 'application/xml';
}

/**
 * Build the path-shaped schema reference the REST endpoints address (IXH-5.1 grammar).
 *
 * @param surface - `catalog` or `project`.
 * @param artifact - Artifact slug or id.
 * @param version - Version label, revision id, or `latest`.
 * @param typeKey - Optional canonical type key/name; omit for the whole revision.
 * @returns The reference, e.g. `catalog/legacy-soap/latest/Order`.
 */
export function buildSchemaRef(
  surface: BenchSurface,
  artifact: string,
  version: string,
  typeKey?: string
): string {
  const base = `${surface}/${artifact}/${version}`;
  return typeKey ? `${base}/${typeKey}` : base;
}

/** Build a `registry/{path}` reference for a type-registry primitive. */
export function buildRegistryRef(namespace: string, name: string): string {
  const path = [namespace, name]
    .map((part) => part.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  return `registry/${path}`;
}

/**
 * The registry root every primitive `$id` lives under — the TypeScript twin of the REST
 * `app.schema_validation.REGISTRY_BASE_URL`. A `registry/{path}` reference is exactly the
 * `$id` with this prefix stripped.
 */
export const REGISTRY_BASE_URL = 'https://api.apiome.dev/types/';

/** The primitive-row fields a registry reference derives from. */
export interface RegistryPrimitiveLike {
  schema_id?: string | null;
  namespace?: string | null;
  name: string;
}

/**
 * Build the `registry/…` reference for a type-registry primitive row.
 *
 * The `$id` (`schema_id`) is authoritative — the reference is the `$id` relative to the
 * registry root, exactly how a relative `$ref` inside the registry addresses it. Rows without
 * one (or under a foreign root) fall back to `namespace/name`; a row with neither coordinate
 * yields `null` rather than a guessed reference.
 */
export function registryRefFromPrimitive(row: RegistryPrimitiveLike): string | null {
  if (row.schema_id && row.schema_id.startsWith(REGISTRY_BASE_URL)) {
    const path = row.schema_id.slice(REGISTRY_BASE_URL.length).replace(/^\/+|\/+$/g, '');
    if (path) return `registry/${path}`;
  }
  if (row.namespace && row.name) {
    return buildRegistryRef(row.namespace, row.name);
  }
  return null;
}

/** Human label for an operation-body target (`POST /orders — request body (Order)`). */
export function describeOperationBody(body: SchemaOperationBodyTarget): string {
  const operation =
    body.http_method && body.http_path
      ? `${body.http_method} ${body.http_path}`
      : body.operation_name || body.operation_key;
  const role =
    body.role === 'request'
      ? 'request body'
      : `response body${body.status_code ? ` ${body.status_code}` : ''}`;
  const type = body.list_wrapped ? `[${body.type_name}]` : body.type_name;
  return `${operation} — ${role} (${type})`;
}

// ===========================================================================
// JSON Pointer → editor ranges
// ===========================================================================

/** A 1-based editor range in Monaco's convention (`endColumn` exclusive). */
export interface EditorRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

/** Unescape one RFC 6901 pointer segment (`~1` → `/`, `~0` → `~`). */
export function unescapePointerSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** Escape one RFC 6901 pointer segment (`/` → `~1`, `~` → `~0`). */
export function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Internal: map a text offset to 1-based line/column against precomputed line starts. */
function offsetToPosition(lineStarts: number[], offset: number): { line: number; column: number } {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (lineStarts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return { line: low + 1, column: offset - lineStarts[low] + 1 };
}

/**
 * Map every RFC 6901 JSON Pointer in a JSON document to the text range of its value.
 *
 * A tiny recursive-descent scan of the payload text (the same text the editor holds), tracking
 * offsets: `""` maps to the root value; `/items/0/name` maps to that value's exact tokens.
 * Invalid JSON yields an empty map — the caller will already be showing a parse error.
 *
 * @param text - The JSON document exactly as the editor holds it.
 * @returns Map from pointer to its value's editor range.
 */
export function jsonPointerRanges(text: string): Map<string, EditorRange> {
  const ranges = new Map<string, EditorRange>();
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') lineStarts.push(i + 1);
  }

  let index = 0;

  const isWs = (ch: string) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
  const skipWs = () => {
    while (index < text.length && isWs(text[index])) index += 1;
  };

  const fail = (): never => {
    throw new SyntaxError(`Unexpected token in JSON at offset ${index}`);
  };

  const record = (pointer: string, start: number, end: number) => {
    const from = offsetToPosition(lineStarts, start);
    const to = offsetToPosition(lineStarts, end);
    ranges.set(pointer, {
      startLine: from.line,
      startColumn: from.column,
      endLine: to.line,
      endColumn: to.column,
    });
  };

  const parseString = (): string => {
    // index sits on the opening quote.
    if (text[index] !== '"') fail();
    index += 1;
    let value = '';
    while (index < text.length) {
      const ch = text[index];
      if (ch === '"') {
        index += 1;
        return value;
      }
      if (ch === '\\') {
        const esc = text[index + 1];
        if (esc === undefined) fail();
        if (esc === 'u') {
          const hex = text.slice(index + 2, index + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail();
          value += String.fromCharCode(parseInt(hex, 16));
          index += 6;
        } else {
          const simple: Record<string, string> = {
            '"': '"',
            '\\': '\\',
            '/': '/',
            b: '\b',
            f: '\f',
            n: '\n',
            r: '\r',
            t: '\t',
          };
          if (!(esc in simple)) fail();
          value += simple[esc];
          index += 2;
        }
      } else {
        value += ch;
        index += 1;
      }
    }
    return fail();
  };

  const parseValue = (pointer: string): void => {
    skipWs();
    const start = index;
    const ch = text[index];
    if (ch === undefined) fail();

    if (ch === '{') {
      index += 1;
      skipWs();
      if (text[index] === '}') {
        index += 1;
      } else {
        for (;;) {
          skipWs();
          const key = parseString();
          skipWs();
          if (text[index] !== ':') fail();
          index += 1;
          parseValue(`${pointer}/${escapePointerSegment(key)}`);
          skipWs();
          if (text[index] === ',') {
            index += 1;
            continue;
          }
          if (text[index] === '}') {
            index += 1;
            break;
          }
          fail();
        }
      }
    } else if (ch === '[') {
      index += 1;
      skipWs();
      if (text[index] === ']') {
        index += 1;
      } else {
        let item = 0;
        for (;;) {
          parseValue(`${pointer}/${item}`);
          item += 1;
          skipWs();
          if (text[index] === ',') {
            index += 1;
            continue;
          }
          if (text[index] === ']') {
            index += 1;
            break;
          }
          fail();
        }
      }
    } else if (ch === '"') {
      parseString();
    } else if (ch === '-' || (ch >= '0' && ch <= '9')) {
      const match = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(index));
      if (!match) fail();
      else index += match[0].length;
    } else if (text.startsWith('true', index)) {
      index += 4;
    } else if (text.startsWith('false', index)) {
      index += 5;
    } else if (text.startsWith('null', index)) {
      index += 4;
    } else {
      fail();
    }

    record(pointer, start, index);
  };

  try {
    parseValue('');
    skipWs();
    if (index !== text.length) fail();
  } catch {
    return new Map();
  }
  return ranges;
}

/** Monaco `MarkerSeverity.Error`, kept numeric so shared helpers never import `monaco-editor`. */
export const MARKER_SEVERITY_ERROR = 8;

/** The marker owner key the bench uses with `monaco.editor.setModelMarkers`. */
export const BENCH_MARKER_OWNER = 'schema-test-bench';

/** One inline editor marker (structurally `monaco.editor.IMarkerData`). */
export interface BenchMarker extends EditorRange {
  severity: number;
  message: string;
}

/**
 * Anchor validation findings onto the payload text as Monaco markers.
 *
 * A finding whose pointer resolves in the payload gets its value's exact range; XML findings
 * carry an explicit line/column instead; anything else anchors to the document start rather
 * than being dropped — every finding stays visible in the editor.
 *
 * @param findings - The findings from `/api/schemas/validate`.
 * @param text - The payload text the editor holds.
 * @returns One marker per finding, in the findings' (already deterministic) order.
 */
export function findingsToMarkers(findings: BenchFinding[], text: string): BenchMarker[] {
  const ranges = jsonPointerRanges(text);
  const fallback: EditorRange = { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 };
  return findings.map((finding) => {
    let range = ranges.get(finding.pointer);
    if (!range && typeof finding.line === 'number' && finding.line > 0) {
      const column = typeof finding.column === 'number' && finding.column > 0 ? finding.column : 1;
      range = { startLine: finding.line, startColumn: column, endLine: finding.line, endColumn: column + 1 };
    }
    const anchored = range ?? fallback;
    return {
      ...anchored,
      severity: MARKER_SEVERITY_ERROR,
      message: `${finding.keyword}: ${finding.message}`,
    };
  });
}

// ===========================================================================
// Copy as curl
// ===========================================================================

/** Escape a string for a single-quoted POSIX shell argument. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build a ready-to-run `curl` for validating the current payload against the REST endpoint.
 *
 * Authentication is left to an `$APIOME_API_KEY` environment variable so the copied command
 * never embeds a credential.
 *
 * @param options.restBaseUrl - REST base (`http://localhost:8000/v1`), no trailing slash needed.
 * @param options.tenantSlug - The tenant slug (from the targets payload).
 * @param options.ref - The full schema reference the payload validates against.
 * @param options.payloadText - The payload exactly as the editor holds it.
 * @returns The multi-line curl command.
 */
export function buildCurlCommand(options: {
  restBaseUrl: string;
  tenantSlug: string;
  ref: string;
  payloadText: string;
}): string {
  const base = options.restBaseUrl.replace(/\/+$/, '');
  const encodedRef = options.ref
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const url = `${base}/tenants/${encodeURIComponent(options.tenantSlug)}/schemas/${encodedRef}/validate`;
  const body = JSON.stringify({ instance_text: options.payloadText, media_type: 'application/json' });
  return [
    `curl -X POST ${shellQuote(url)}`,
    `  -H 'Content-Type: application/json'`,
    `  -H "X-API-Key: $APIOME_API_KEY"`,
    `  --data ${shellQuote(body)}`,
  ].join(' \\\n');
}

// ===========================================================================
// Copy as corpus fixture (IXH-1.1 manifest format)
// ===========================================================================

/** A corpus fixture: the 1.1 manifest entry plus the payload file it describes. */
export interface CorpusFixture {
  /** The manifest entry, in the exact `examples/corpus.manifest.json` field shape. */
  entry: CorpusEntry;
  /** The payload text to write at `entry.path`. */
  payload: string;
}

/** Turn a free-form label into a safe kebab-case file stem. */
export function fixtureFileStem(label: string): string {
  const stem = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return stem || 'payload';
}

/**
 * Package a **validated** payload as an IXH-1.1 corpus fixture.
 *
 * The entry is `validity_class: "valid"` by construction — the bench only offers the action
 * once validation passed — and its provenance names the schema reference it passed against,
 * plus whether the payload was synthesized (IXH-5.2) or hand-authored, so the synthetic label
 * survives the export.
 *
 * @param options.ref - The schema reference the payload validated against.
 * @param options.payloadText - The validated payload text.
 * @param options.name - Human name for the fixture (drives the file stem).
 * @param options.synthetic - Whether the payload came from the IXH-5.2 generator.
 * @returns The fixture: manifest entry + payload text.
 */
export function buildCorpusFixture(options: {
  ref: string;
  payloadText: string;
  name: string;
  synthetic: boolean;
}): CorpusFixture {
  const stem = fixtureFileStem(options.name);
  const entry: CorpusEntry = {
    path: `json-schema/test-bench/${stem}.json`,
    format: 'json-schema',
    adapter_key: null,
    validity_class: 'valid',
    expected_detection: { format: 'json', min_confidence: 0.5 },
    features: ['instance-payload', 'test-bench'],
    expected_outcome: 'imports',
    source: options.synthetic ? 'synthesized' : 'hand-authored',
    license: 'Apache-2.0',
    provenance:
      `Exported from the Schema Test Bench after validating against \`${options.ref}\`` +
      `${options.synthetic ? ' (synthesized by IXH-5.2 payload synthesis)' : ''}.`,
    notes:
      'Instance payload (not a spec document): validates against the schema reference named ' +
      'in `provenance` via POST /v1/tenants/{tenant}/schemas/{ref}/validate.',
  };
  return { entry, payload: options.payloadText };
}

// ===========================================================================
// Payload bounds (IXH-3.6 discipline)
// ===========================================================================

/**
 * Measure a payload against the Test Bench byte budget.
 *
 * @param text - The payload text.
 * @param maxBytes - The budget (`TEST_BENCH_PAYLOAD_MAX_BYTES` from `preview-budgets`).
 * @returns The UTF-8 size, whether it fits, and a user-facing refusal message when it does not.
 */
export function checkPayloadBudget(
  text: string,
  maxBytes: number
): { bytes: number; withinBudget: boolean; message: string | null } {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes <= maxBytes) {
    return { bytes, withinBudget: true, message: null };
  }
  const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return {
    bytes,
    withinBudget: false,
    message:
      `This payload is ${mb(bytes)}, above the Test Bench bound of ${mb(maxBytes)}. ` +
      'Validate it via the REST API or CLI instead (copy as curl works at any size).',
  };
}
