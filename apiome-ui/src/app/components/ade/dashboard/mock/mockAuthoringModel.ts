/**
 * Wire shapes and pure helpers shared by the mock authoring surfaces (#5529, MSC-1.3).
 *
 * Three editors read the same two endpoints — the correlation editor, the scenario editor's token
 * picker, and the live preview panel both of them embed — so the types, the token vocabulary and
 * the trace copy live here rather than in whichever component happened to need them first.
 *
 * Everything in this module is pure: no React, no `fetch`. That is what lets the rules be tested
 * directly instead of through a rendered dialog.
 */

/** One request parameter offered as an insertable template token (`GET .../mock/operations`). */
export interface MockOperationParameter {
  name: string;
  /** Where it travels: `path`, `query` or `header`. */
  location: 'path' | 'query' | 'header';
  required: boolean;
  /** Declared JSON type, when the schema states one. */
  type?: string | null;
  /** The ready-to-insert expression, e.g. `{{request.path.petId}}`. */
  token: string;
}

/** One JSON Pointer an explicit binding can target. */
export interface MockResponsePointer {
  pointer: string;
  type?: string | null;
  /** True when the pointer passes through an array — the runtime binds every member. */
  repeated: boolean;
}

/** One binding an inference pass would make, as the read-only preview lists it. */
export interface MockOperationBinding {
  pointer: string;
  /** The request value it takes, written as the equivalent template expression. */
  source: string;
  /** Which pass makes it. */
  pass: 'path-params' | 'inferred';
  repeated: boolean;
}

/** One operation from the version's authoring catalogue. */
export interface MockAuthoringOperation {
  /** Canonical `"METHOD /path/{template}"` identifier — the key the bindings map uses. */
  key: string;
  method: string;
  path: string;
  summary: string;
  parameters: MockOperationParameter[];
  /** Top-level request-body property names, for `{{request.body#/...}}` tokens. */
  requestFields: string[];
  responsePointers: MockResponsePointer[];
  successStatus: number;
  bindings: MockOperationBinding[];
}

/** The catalogue as the proxy route returns it. */
export interface MockAuthoringCatalogue {
  operations: MockAuthoringOperation[];
  /** Fixture names readable as `{{fixture.<name>}}` on this version. */
  fixtures: string[];
}

/** The decision trace from one dry-run preview (#5528, MSC-1.2). */
export interface MockPreviewTrace {
  layer: string;
  detail: string;
  scenario?: string | null;
  ruleIndex?: number | null;
  seed?: number | null;
  seedSource?: string;
  correlationMode?: string | null;
  correlationApplied?: string[];
  correlationPointers?: string[];
  schemaValid?: boolean | null;
  bodySource?: string | null;
  exampleName?: string | null;
}

/** What the mock would serve for one synthetic request, and why. */
export interface MockPreviewResult {
  operation?: string | null;
  pathParams?: Record<string, string>;
  status: number;
  headers: Record<string, string>;
  mediaType: string;
  body?: unknown;
  bodyEncoding: string;
  trace: MockPreviewTrace;
  chaos?: { suppressed: boolean; delayMs: number; jitterMs: number; errorRate: number };
  draft?: boolean;
}

/** The synthetic request the preview panel sends. */
export interface MockPreviewRequestDraft {
  method: string;
  path: string;
  headersText: string;
  queryText: string;
  bodyText: string;
}

/** One insertable token, grouped for the picker. */
export interface MockToken {
  /** The expression inserted at the cursor. */
  token: string;
  /** Short label shown on the chip. */
  label: string;
  /** One line explaining what it reads. */
  hint: string;
}

/** A named group of tokens (one per template root that has anything to offer). */
export interface MockTokenGroup {
  title: string;
  tokens: MockToken[];
}

/** Methods that carry a request body, so `{{request.body#/…}}` tokens are worth offering. */
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Escape one property name for use as a JSON Pointer segment (RFC 6901). */
export function escapePointerSegment(name: string): string {
  return name.replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * Build the token groups an author can insert into an expression.
 *
 * Only what this version actually has is offered: the selected operation's own parameters, its
 * request-body fields (on methods that carry one), and the fixture names the version's packs
 * define. Guessing at a parameter that does not exist is the failure mode the picker replaces.
 *
 * @param operation - The operation being edited; `null` offers fixtures and seeded values only.
 * @param fixtures - Fixture names available on the version.
 * @returns Non-empty groups, in the order the picker renders them.
 */
export function buildTokenGroups(
  operation: MockAuthoringOperation | null,
  fixtures: readonly string[]
): MockTokenGroup[] {
  const groups: MockTokenGroup[] = [];
  const locations: Array<{ location: MockOperationParameter['location']; title: string }> = [
    { location: 'path', title: 'Path parameters' },
    { location: 'query', title: 'Query parameters' },
    { location: 'header', title: 'Headers' },
  ];

  for (const { location, title } of locations) {
    const tokens = (operation?.parameters ?? [])
      .filter((parameter) => parameter.location === location)
      .map((parameter) => ({
        token: parameter.token,
        label: parameter.name,
        hint: parameter.required
          ? `Required ${location} parameter${parameter.type ? ` (${parameter.type})` : ''}`
          : `Optional ${location} parameter${parameter.type ? ` (${parameter.type})` : ''}`,
      }));
    if (tokens.length > 0) groups.push({ title, tokens });
  }

  if (operation && BODY_METHODS.has(operation.method) && operation.requestFields.length > 0) {
    groups.push({
      title: 'Request body',
      tokens: operation.requestFields.map((field) => ({
        token: `{{request.body#/${escapePointerSegment(field)}}}`,
        label: field,
        hint: 'Field sent in the request body',
      })),
    });
  }

  if (fixtures.length > 0) {
    groups.push({
      title: 'Fixtures',
      tokens: fixtures.map((name) => ({
        token: `{{fixture.${name}}}`,
        label: name,
        hint: 'Fixture data defined on this version',
      })),
    });
  }

  groups.push({
    title: 'Request facts & seeded values',
    tokens: [
      { token: '{{request.method}}', label: 'method', hint: 'The upper-case HTTP method' },
      { token: '{{request.body}}', label: 'body', hint: 'The whole parsed request body' },
      { token: '{{random.uuid()}}', label: 'uuid', hint: 'A seeded UUID-shaped identifier' },
      { token: '{{random.int(1, 100)}}', label: 'int', hint: 'A seeded integer in a range' },
    ],
  });

  return groups;
}

/**
 * Insert a token into a value at the caret, replacing any selection.
 *
 * @param value - The current field value.
 * @param token - The expression to insert.
 * @param selectionStart - Caret start, or `null` to append.
 * @param selectionEnd - Caret end, or `null` to append.
 * @returns The new value and where the caret should land after it.
 */
export function insertToken(
  value: string,
  token: string,
  selectionStart: number | null,
  selectionEnd: number | null
): { value: string; caret: number } {
  const start = selectionStart ?? value.length;
  const end = selectionEnd ?? start;
  const next = `${value.slice(0, start)}${token}${value.slice(end)}`;
  return { value: next, caret: start + token.length };
}

/**
 * Derive a sendable sample request from one operation.
 *
 * Path parameters are filled with a readable placeholder rather than left templated, because an
 * unsubstituted `{petId}` does not route and the preview would answer "no operation matched" — the
 * least informative thing it can say. Required query parameters are prefilled for the same reason.
 *
 * @param operation - The operation to build a request for; `null` yields a bare `GET /`.
 * @returns The editable request draft the preview panel starts from.
 */
export function sampleRequestForOperation(
  operation: MockAuthoringOperation | null
): MockPreviewRequestDraft {
  if (!operation) {
    return { method: 'GET', path: '/', headersText: '', queryText: '', bodyText: '' };
  }

  let path = operation.path;
  for (const parameter of operation.parameters) {
    if (parameter.location !== 'path') continue;
    const placeholder = parameter.type === 'integer' || parameter.type === 'number' ? '42' : 'sample';
    path = path.replace(`{${parameter.name}}`, placeholder);
  }

  const query: Record<string, string> = {};
  const headers: Record<string, string> = {};
  for (const parameter of operation.parameters) {
    if (!parameter.required) continue;
    if (parameter.location === 'query') query[parameter.name] = 'sample';
    if (parameter.location === 'header') headers[parameter.name] = 'sample';
  }

  const body =
    BODY_METHODS.has(operation.method) && operation.requestFields.length > 0
      ? Object.fromEntries(operation.requestFields.map((field) => [field, 'sample']))
      : null;

  return {
    method: operation.method,
    path,
    headersText: Object.keys(headers).length > 0 ? JSON.stringify(headers, null, 2) : '',
    queryText: Object.keys(query).length > 0 ? JSON.stringify(query, null, 2) : '',
    bodyText: body ? JSON.stringify(body, null, 2) : '',
  };
}

/** One parsed synthetic request, or the reasons it could not be parsed. */
export interface ParsedPreviewRequest {
  request?: Record<string, unknown>;
  errors: string[];
}

/**
 * Parse one JSON text field into an object of string values.
 *
 * @param text - The raw field text; blank yields `{}`.
 * @param label - The field name used in error messages.
 * @param errors - Accumulator for parse failures.
 * @returns The parsed map, or `{}` after reporting.
 */
function parseStringMap(text: string, label: string, errors: string[]): Record<string, string> {
  if (!text.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [key, String(value)])
    );
  } catch {
    errors.push(`${label} must be a JSON object of string values.`);
    return {};
  }
}

/**
 * Turn the preview panel's fields into the synthetic request the endpoint accepts.
 *
 * @param draft - The editable request.
 * @returns The request payload, or the client-side errors that blocked it.
 */
export function previewRequestFromDraft(draft: MockPreviewRequestDraft): ParsedPreviewRequest {
  const errors: string[] = [];
  const method = draft.method.trim().toUpperCase() || 'GET';
  const path = draft.path.trim() || '/';
  if (!path.startsWith('/')) {
    errors.push('Path must start with "/" and be relative to the version root, e.g. /pets/42.');
  }

  const headers = parseStringMap(draft.headersText, 'Headers', errors);
  const query = parseStringMap(draft.queryText, 'Query', errors);

  let body: unknown;
  if (draft.bodyText.trim()) {
    try {
      body = JSON.parse(draft.bodyText);
    } catch {
      errors.push('Body must be valid JSON (leave it blank for no body).');
    }
  }

  if (errors.length > 0) return { errors };
  return {
    request: { method, path, headers, query, ...(body !== undefined ? { body } : {}) },
    errors: [],
  };
}

/** Plain-language names for the trace layers the preview reports. */
const TRACE_LAYER_LABELS: Record<string, string> = {
  scenario: 'Scenario',
  stateful: 'Session state',
  correlation: 'Correlation',
  example: 'Spec example',
  synthesis: 'Schema synthesis',
  empty: 'Empty body',
  'forced-status': 'Forced status',
  'request-invalid': 'Request rejected',
  'chaos-error': 'Injected error',
  'no-operation': 'No operation matched',
  'method-not-allowed': 'Method not allowed',
  'unknown-scenario': 'Unknown scenario',
  'not-acceptable': 'Media type not acceptable',
  'template-limit': 'Template limit reached',
  lifecycle: 'Lifecycle',
  unresolved: 'Unrecorded',
};

/**
 * Name one trace layer for a reader.
 *
 * @param layer - The raw layer from the trace.
 * @returns The plain-language label, falling back to the raw value for a layer added later.
 */
export function traceLayerLabel(layer: string): string {
  return TRACE_LAYER_LABELS[layer] ?? layer;
}

/** Layers that mean the preview did not produce a normal response body. */
const PROBLEM_LAYERS = new Set([
  'no-operation',
  'method-not-allowed',
  'unknown-scenario',
  'not-acceptable',
  'request-invalid',
  'template-limit',
  'unresolved',
]);

/**
 * Whether a trace layer should be shown as a problem rather than a result.
 *
 * @param layer - The raw layer from the trace.
 * @returns True when the render did not answer the author's question.
 */
export function traceLayerIsProblem(layer: string): boolean {
  return PROBLEM_LAYERS.has(layer);
}

/**
 * Format a preview body for display.
 *
 * @param body - The rendered body.
 * @param encoding - How the endpoint carried it (`json`, `text`, `base64`, `empty`).
 * @returns The text to show in the response pane.
 */
export function formatPreviewBody(body: unknown, encoding: string): string {
  if (encoding === 'empty' || body === null || body === undefined) return '';
  if (encoding === 'json') return JSON.stringify(body, null, 2);
  return String(body);
}
