/**
 * Try It form-model helpers — SIM-3.1 (#4447).
 *
 * Framework-free logic behind the Try It panel on public operation listings: extracting an
 * operation's parameters and request-body variants from a parsed OpenAPI document, building the
 * server-picker options (mock URL from SIM-2.3, spec `servers[]`, custom URL), validating
 * parameter values client-side before send, and composing the final request URL/headers.
 *
 * Kept free of React/DOM so it is unit-testable under the browse Vitest setup (which only runs
 * `lib/**` tests). The React panel (`src/app/components/tryit/TryItPanel.tsx`) is a thin view
 * over these helpers.
 */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parameter locations the panel renders. `cookie` parameters are intentionally skipped: the
 * browser controls cookies and the SIM-3.2 proxy strips them for credential hygiene. */
export type ParamLocation = 'path' | 'query' | 'header';

/** One named OpenAPI example entry on a parameter or media type. */
export interface OpenApiExampleEntry {
  summary?: string;
  value: unknown;
}

/** The subset of a JSON Schema the parameter form renders controls from. */
export interface ParamSchema {
  /** Primitive type (`string`, `integer`, `number`, `boolean`, ...); undefined when unspecified. */
  type?: string;
  /** Optional format hint (`int64`, `date-time`, ...). */
  format?: string;
  /** Enumerated allowed values — rendered as a select. */
  enum?: (string | number | boolean)[];
  /** Declared default value, prefilled into the control. */
  default?: unknown;
  /** Single schema-level example, used for prefill after `default`. */
  example?: unknown;
  /** Named schema-level examples map. */
  examples?: Record<string, OpenApiExampleEntry>;
}

/** One path/query/header parameter of an operation, ready for form rendering. */
export interface ParamSpec {
  name: string;
  location: ParamLocation;
  required: boolean;
  description?: string;
  schema: ParamSchema;
}

/** One request-body content-type variant offered by an operation. */
export interface BodyVariant {
  /** The media type, e.g. `application/json`. */
  contentType: string;
  /** The (top-level-resolved) body schema, or null when the spec declares none. */
  schema: Record<string, unknown> | null;
  /** Single media-level example when the spec declares `example`. */
  example?: unknown;
  /** Named media-level examples when the spec declares `examples`. */
  examples?: Record<string, OpenApiExampleEntry>;
}

/** Everything the Try It panel needs to render and send one operation. */
export interface OperationModel {
  /** Upper-case HTTP method, e.g. `GET`. */
  method: string;
  /** The templated operation path, e.g. `/pets/{petId}`. */
  path: string;
  summary?: string;
  description?: string;
  /** Path, query, and header parameters (path-item level merged with operation level). */
  params: ParamSpec[];
  /** Request-body variants by content type; empty when the operation takes no body. */
  bodyVariants: BodyVariant[];
  /** True when the spec marks the request body as required. */
  bodyRequired: boolean;
}

/** A server-picker entry: the version's mock, a spec `servers[]` entry, or the custom-URL slot. */
export interface ServerOption {
  kind: 'mock' | 'spec';
  /** Absolute base URL with no trailing slash. */
  url: string;
  /** Human label shown in the picker. */
  label: string;
  /** Optional description from the spec's server entry. */
  description?: string;
}

const MAX_REF_DEPTH = 32;

/**
 * Resolve a local (`#/...`) JSON reference against the document root.
 *
 * Follows chained `$ref`s up to {@link MAX_REF_DEPTH} hops (cycle guard). External references and
 * unresolvable pointers return null.
 *
 * @param root - The parsed spec document the pointers are relative to.
 * @param node - The node to resolve; returned as-is when it is not a `$ref` object.
 * @returns The resolved object, or null when the reference cannot be resolved.
 */
export function resolveRef(root: unknown, node: unknown): Record<string, unknown> | null {
  let current = node;
  for (let depth = 0; depth < MAX_REF_DEPTH; depth++) {
    if (!isObject(current)) return null;
    const ref = current.$ref;
    if (typeof ref !== 'string') return current;
    if (!ref.startsWith('#/')) return null;
    let target: unknown = root;
    for (const rawSegment of ref.slice(2).split('/')) {
      const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
      if (!isObject(target)) return null;
      target = target[segment];
    }
    current = target;
  }
  return null;
}

/** Parse an OpenAPI `examples` map into normalized entries. */
function parseExamplesMap(node: unknown): Record<string, OpenApiExampleEntry> | undefined {
  if (!isObject(node)) return undefined;
  const out: Record<string, OpenApiExampleEntry> = {};
  for (const [name, entry] of Object.entries(node)) {
    if (entry != null && typeof entry === 'object' && !Array.isArray(entry) && 'value' in entry) {
      const wrapped = entry as { summary?: unknown; value: unknown };
      out[name] = {
        summary: typeof wrapped.summary === 'string' ? wrapped.summary : undefined,
        value: wrapped.value,
      };
    } else {
      out[name] = { value: entry };
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Narrow an arbitrary schema node to the subset the form renders ({@link ParamSchema}). */
function toParamSchema(root: unknown, schemaNode: unknown): ParamSchema {
  const schema = resolveRef(root, schemaNode);
  if (!schema) return {};
  const out: ParamSchema = {};
  if (typeof schema.type === 'string') out.type = schema.type;
  if (typeof schema.format === 'string') out.format = schema.format;
  if (Array.isArray(schema.enum)) {
    const values = schema.enum.filter(
      (v): v is string | number | boolean =>
        typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
    );
    if (values.length > 0) out.enum = values;
  }
  if ('default' in schema) out.default = schema.default;
  if ('example' in schema) out.example = schema.example;
  const schemaExamples = parseExamplesMap(schema.examples);
  if (schemaExamples) out.examples = schemaExamples;
  return out;
}

/** Parse one OpenAPI parameter object (possibly a `$ref`) into a {@link ParamSpec}. */
function toParamSpec(root: unknown, paramNode: unknown): ParamSpec | null {
  const param = resolveRef(root, paramNode);
  if (!param) return null;
  const name = typeof param.name === 'string' ? param.name : null;
  const location = typeof param.in === 'string' ? param.in : null;
  if (!name || (location !== 'path' && location !== 'query' && location !== 'header')) {
    return null;
  }
  const schema = toParamSchema(root, param.schema);
  if ('example' in param) schema.example = param.example;
  const paramExamples = parseExamplesMap(param.examples);
  if (paramExamples) schema.examples = paramExamples;
  return {
    name,
    location,
    // Path parameters are always required per the OpenAPI spec, whatever the document says.
    required: location === 'path' ? true : param.required === true,
    description: typeof param.description === 'string' ? param.description : undefined,
    schema,
  };
}

/**
 * Extract the form model for one operation from a parsed OpenAPI document.
 *
 * Path-item-level parameters are merged with operation-level parameters; the operation level
 * overrides on a `(name, location)` collision, as the OpenAPI spec prescribes. Cookie parameters
 * are skipped (see {@link ParamLocation}).
 *
 * @param spec - The parsed OpenAPI document.
 * @param method - HTTP method of the operation (any case).
 * @param path - The templated path key, e.g. `/pets/{petId}`.
 * @returns The operation model, or null when the operation is not present in the document.
 */
export function extractOperationModel(
  spec: unknown,
  method: string,
  path: string
): OperationModel | null {
  if (!isObject(spec) || !isObject(spec.paths)) return null;
  const pathItem = resolveRef(spec, spec.paths[path]);
  if (!pathItem) return null;
  const op = resolveRef(spec, pathItem[method.toLowerCase()]);
  if (!op) return null;

  // Merge parameters: path-item level first, operation level overrides by (name, location).
  const merged = new Map<string, ParamSpec>();
  for (const source of [pathItem.parameters, op.parameters]) {
    if (!Array.isArray(source)) continue;
    for (const node of source) {
      const param = toParamSpec(spec, node);
      if (param) merged.set(`${param.location}:${param.name}`, param);
    }
  }
  const order: Record<ParamLocation, number> = { path: 0, query: 1, header: 2 };
  const params = Array.from(merged.values()).sort(
    (a, b) => order[a.location] - order[b.location]
  );

  // Request body content-type variants.
  const bodyVariants: BodyVariant[] = [];
  let bodyRequired = false;
  const requestBody = resolveRef(spec, op.requestBody);
  if (requestBody && isObject(requestBody.content)) {
    bodyRequired = requestBody.required === true;
    for (const [contentType, mediaNode] of Object.entries(requestBody.content)) {
      const media = resolveRef(spec, mediaNode);
      const schema = media ? resolveRef(spec, media.schema) : null;
      const variant: BodyVariant = { contentType, schema };
      if (media) {
        if ('example' in media) variant.example = media.example;
        const mediaExamples = parseExamplesMap(media.examples);
        if (mediaExamples) variant.examples = mediaExamples;
      }
      bodyVariants.push(variant);
    }
  }

  return {
    method: method.toUpperCase(),
    path,
    summary: typeof op.summary === 'string' ? op.summary : undefined,
    description: typeof op.description === 'string' ? op.description : undefined,
    params,
    bodyVariants,
    bodyRequired,
  };
}

/** Substitute `{variable}` placeholders in a server URL with their declared defaults. */
function substituteServerVariables(url: string, variablesNode: unknown, root: unknown): string {
  const variables = resolveRef(root, variablesNode);
  if (!variables) return url;
  return url.replace(/\{([^{}]+)\}/g, (match, name: string) => {
    const variable = resolveRef(root, variables[name]);
    if (!variable) return match;
    if (typeof variable.default === 'string') return variable.default;
    if (Array.isArray(variable.enum) && typeof variable.enum[0] === 'string') {
      return variable.enum[0];
    }
    return match;
  });
}

/**
 * Build the server-picker options for an operation: the version's mock URL first (when its mock
 * is enabled — SIM-2.3), then the spec's own `servers[]` entries with variable defaults
 * substituted. The custom-URL slot is a UI affordance, not an option here.
 *
 * @param spec - The parsed OpenAPI document.
 * @param mockBaseUrl - The version's public mock base URL, or null/undefined when disabled.
 * @returns Picker options in display order; may be empty when neither source provides a URL.
 */
export function buildServerOptions(
  spec: unknown,
  mockBaseUrl?: string | null
): ServerOption[] {
  const options: ServerOption[] = [];
  if (mockBaseUrl) {
    options.push({ kind: 'mock', url: mockBaseUrl.replace(/\/+$/, ''), label: `mock: ${mockBaseUrl}` });
  }
  if (isObject(spec) && Array.isArray(spec.servers)) {
    for (const node of spec.servers) {
      if (!isObject(node) || typeof node.url !== 'string' || node.url.length === 0) continue;
      const url = substituteServerVariables(node.url, node.variables, spec).replace(/\/+$/, '');
      if (!url) continue;
      options.push({
        kind: 'spec',
        url,
        label: url,
        description: typeof node.description === 'string' ? node.description : undefined,
      });
    }
  }
  return options;
}

/** Stable form key for a parameter (avoids collisions between same-named params in
 * different locations). */
export function paramKey(param: Pick<ParamSpec, 'name' | 'location'>): string {
  return `${param.location}:${param.name}`;
}

/**
 * Validate one raw form value against its parameter spec.
 *
 * @param param - The parameter being validated.
 * @param raw - The raw string value from the form control (empty string when untouched).
 * @returns A human-readable error, or null when the value is acceptable.
 */
export function validateParamValue(param: ParamSpec, raw: string): string | null {
  const value = raw.trim();
  if (value === '') {
    return param.required ? 'Required' : null;
  }
  const { type, enum: allowed } = param.schema;
  if (allowed && !allowed.some((v) => String(v) === value)) {
    return `Must be one of: ${allowed.join(', ')}`;
  }
  if (type === 'integer' && !/^-?\d+$/.test(value)) {
    return 'Must be an integer';
  }
  if (type === 'number' && !Number.isFinite(Number(value))) {
    return 'Must be a number';
  }
  if (type === 'boolean' && value !== 'true' && value !== 'false') {
    return 'Must be true or false';
  }
  return null;
}

/**
 * Validate all parameter values before send.
 *
 * @param params - The operation's parameters.
 * @param values - Raw form values keyed by {@link paramKey}; missing keys count as empty.
 * @returns Errors keyed by {@link paramKey}; empty object when everything validates.
 */
export function validateParams(
  params: ParamSpec[],
  values: Record<string, string>
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const param of params) {
    const error = validateParamValue(param, values[paramKey(param)] ?? '');
    if (error) errors[paramKey(param)] = error;
  }
  return errors;
}

/**
 * Compose the final request URL: substitute path parameters (URL-encoded) into the templated
 * path and append non-empty query parameters.
 *
 * @param serverUrl - The picked server base URL (trailing slashes ignored).
 * @param path - The templated operation path, e.g. `/pets/{petId}`.
 * @param params - The operation's parameters (only path/query entries are used).
 * @param values - Raw form values keyed by {@link paramKey}.
 * @returns The absolute request URL.
 */
export function buildRequestUrl(
  serverUrl: string,
  path: string,
  params: ParamSpec[],
  values: Record<string, string>
): string {
  let filledPath = path;
  const query = new URLSearchParams();
  for (const param of params) {
    const value = (values[paramKey(param)] ?? '').trim();
    if (param.location === 'path') {
      filledPath = filledPath
        .split(`{${param.name}}`)
        .join(encodeURIComponent(value));
    } else if (param.location === 'query' && value !== '') {
      query.append(param.name, value);
    }
  }
  const base = serverUrl.replace(/\/+$/, '');
  const queryString = query.toString();
  const suffix = queryString ? `?${queryString}` : '';
  return `${base}${filledPath.startsWith('/') ? filledPath : `/${filledPath}`}${suffix}`;
}

/** One user-added header row in the panel. */
export interface ExtraHeader {
  name: string;
  value: string;
}

/**
 * Compose the request header map: spec-declared header parameters with non-empty values, then
 * user-added headers, then `Content-Type` when a body is being sent.
 *
 * @param params - The operation's parameters (only header entries are used).
 * @param values - Raw form values keyed by {@link paramKey}.
 * @param extraHeaders - User-added header rows; rows with a blank name are skipped.
 * @param contentType - The selected body content type, or null when no body is sent.
 * @returns Header name → value map.
 */
export function buildRequestHeaders(
  params: ParamSpec[],
  values: Record<string, string>,
  extraHeaders: ExtraHeader[],
  contentType: string | null
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const param of params) {
    if (param.location !== 'header') continue;
    const value = (values[paramKey(param)] ?? '').trim();
    if (value !== '') headers[param.name] = value;
  }
  for (const { name, value } of extraHeaders) {
    const trimmed = name.trim();
    if (trimmed !== '') headers[trimmed] = value;
  }
  if (contentType) headers['Content-Type'] = contentType;
  return headers;
}

/** True when a media type carries JSON (e.g. `application/json`, `application/hal+json`). */
export function isJsonContentType(contentType: string): boolean {
  const bare = contentType.split(';')[0].trim().toLowerCase();
  return bare.endsWith('/json') || bare.endsWith('+json');
}

/**
 * Build a self-contained JSON Schema document for Monaco's JSON validation from an operation's
 * body schema. Local `#/components/...` references keep resolving because the spec's
 * `components` section is attached to the schema document root.
 *
 * @param spec - The parsed OpenAPI document (source of `components`).
 * @param schema - The operation's request-body schema (possibly containing `$ref`s).
 * @returns A schema document for Monaco, or null when there is no schema to validate against.
 */
export function buildMonacoBodySchema(
  spec: unknown,
  schema: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (!schema) return null;
  const components =
    isObject(spec) && isObject(spec.components) ? { components: spec.components } : {};
  // A bare `$ref` at the root is wrapped in `allOf` so attaching `components` next to it is
  // valid in every JSON Schema draft.
  if (typeof schema.$ref === 'string') {
    return { allOf: [{ $ref: schema.$ref }], ...components };
  }
  return { ...schema, ...components };
}
