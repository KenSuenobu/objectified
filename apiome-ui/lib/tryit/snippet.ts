/**
 * Try It code-snippet generation — SIM-3.5 (#4451), promoted by DWX-4.7 (private-suite#2696).
 *
 * Pure functions over the composed Try It request model. Produces runnable curl, JavaScript
 * fetch, and Python httpx samples that mirror what the Send button would dispatch, with credential
 * values replaced by placeholders (see `secrets.ts` and SIM-3.6 auth helpers).
 *
 * **Why it lives here.** It moved from `apiome-browse/lib/tryit/snippet.ts` to sit beside the relay
 * DWX-4.2 promoted, so the designer's Try-It console and its inspector Quick actions render from
 * the same renderer as Browse. The alternative was a second `curl` renderer in the studio, and on
 * the day the two disagreed one of them would be handing a reader a command that does not
 * reproduce the request they are looking at. Browse imports it through a re-export, so its
 * `lib/tryit/__tests__/snippet.test.ts` still covers this module, unchanged.
 *
 * **Two entry points, deliberately.** {@link buildSnippetRequest} composes a request from Browse's
 * panel state; {@link generateSnippet} renders a request that is *already* composed. The studio
 * uses only the second — it composes its own request (cookie parameters, mock-scenario headers)
 * and hands over the finished URL, headers and body — which is why the composer takes Browse's
 * `ParamSpec` shape while the renderer takes nothing but a {@link SnippetRequest}.
 */

import {
  buildRequestHeaders,
  buildRequestUrl,
  type ExtraHeader,
  type ParamSpec,
} from './operation';
import {
  applySecretPlaceholders,
  inferSecretPlaceholders,
  type SecretPlaceholderMap,
} from './secrets';

/** Supported snippet output formats. */
export type SnippetTarget = 'curl' | 'fetch' | 'httpx';

/** A composed Try It request ready for snippet generation (same shape as the send pipeline). */
export interface SnippetRequest {
  /** Upper-case HTTP method. */
  method: string;
  /** Absolute target URL (server base + filled path + query string). */
  url: string;
  /** Request headers (includes Content-Type when a body is present). */
  headers: Record<string, string>;
  /** Raw request body text, or null for body-less requests. */
  body: string | null;
}

/**
 * Compose a snippet request from Try It panel state — mirrors the Send button pipeline.
 *
 * @param input - Server URL, operation model fragments, and form values.
 */
export function buildSnippetRequest(input: {
  method: string;
  serverUrl: string;
  path: string;
  params: ParamSpec[];
  values: Record<string, string>;
  extraHeaders: ExtraHeader[];
  body: string | null;
  contentType: string | null;
}): SnippetRequest {
  const body =
    input.body != null && input.body.trim() !== '' ? input.body : null;
  return {
    method: input.method,
    url: buildRequestUrl(input.serverUrl, input.path, input.params, input.values),
    headers: buildRequestHeaders(
      input.params,
      input.values,
      input.extraHeaders,
      body != null ? input.contentType : null
    ),
    body,
  };
}

/**
 * Generate a code snippet for the given target language/tooling.
 *
 * @param target - `curl`, JavaScript `fetch`, or Python `httpx`.
 * @param request - The composed request (actual values; secrets are redacted internally).
 * @param explicitPlaceholders - Optional SIM-3.6 auth-helper placeholders merged over inferred ones.
 */
export function generateSnippet(
  target: SnippetTarget,
  request: SnippetRequest,
  explicitPlaceholders?: SecretPlaceholderMap
): string {
  const placeholders = {
    ...inferSecretPlaceholders(request.url, request.headers),
    ...explicitPlaceholders,
  };
  const sanitized = applySecretPlaceholders(request, placeholders);
  switch (target) {
    case 'curl':
      return generateCurl(sanitized);
    case 'fetch':
      return generateFetch(sanitized);
    case 'httpx':
      return generateHttpx(sanitized);
  }
}

/** POSIX shell single-quoted string with embedded single quotes escaped. */
export function shellQuote(value: string): string {
  if (value === '') return "''";
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** JavaScript single-quoted string literal. */
export function jsSingleQuote(value: string): string {
  return `'${value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')}'`;
}

/** Python double-quoted string literal. */
export function pythonDoubleQuote(value: string): string {
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')}"`;
}

function generateCurl(request: SnippetRequest): string {
  const parts = ['curl'];
  const method = request.method.toUpperCase();
  if (method !== 'GET') {
    parts.push('-X', method);
  }
  parts.push(shellQuote(request.url));
  for (const [name, value] of Object.entries(request.headers)) {
    parts.push('-H', shellQuote(`${name}: ${value}`));
  }
  if (request.body != null) {
    parts.push('--data-raw', shellQuote(request.body));
  }
  return parts.join(' ');
}

function generateFetch(request: SnippetRequest): string {
  const method = request.method.toUpperCase();
  const lines = [`const response = await fetch(${jsSingleQuote(request.url)}, {`];
  if (method !== 'GET') {
    lines.push(`  method: ${jsSingleQuote(method)},`);
  }
  const headerEntries = Object.entries(request.headers);
  if (headerEntries.length > 0) {
    lines.push('  headers: {');
    for (const [name, value] of headerEntries) {
      lines.push(`    ${jsSingleQuote(name)}: ${jsSingleQuote(value)},`);
    }
    lines.push('  },');
  }
  if (request.body != null) {
    lines.push(`  body: ${jsSingleQuote(request.body)},`);
  }
  lines.push('});');
  lines.push('');
  lines.push('const data = await response.json();');
  return lines.join('\n');
}

function generateHttpx(request: SnippetRequest): string {
  const method = request.method.toUpperCase();
  const lines = ['import httpx', '', 'response = httpx.request('];
  lines.push(`    ${pythonDoubleQuote(method)},`);
  lines.push(`    ${pythonDoubleQuote(request.url)},`);

  const headerEntries = Object.entries(request.headers);
  if (headerEntries.length > 0) {
    lines.push('    headers={');
    for (const [name, value] of headerEntries) {
      lines.push(`        ${pythonDoubleQuote(name)}: ${pythonDoubleQuote(value)},`);
    }
    lines.push('    },');
  }

  if (request.body != null) {
    if (isJsonBody(request.headers, request.body)) {
      lines.push(`    json=${formatPythonLiteral(JSON.parse(request.body), 1)},`);
    } else {
      lines.push(`    content=${pythonDoubleQuote(request.body)},`);
    }
  }

  lines.push(')');
  lines.push('response.raise_for_status()');
  return lines.join('\n');
}

function isJsonBody(headers: Record<string, string>, body: string): boolean {
  const contentType = headers['Content-Type'] ?? headers['content-type'];
  if (!contentType?.toLowerCase().includes('json')) return false;
  try {
    JSON.parse(body);
    return true;
  } catch {
    return false;
  }
}

/** Render a JSON-compatible value as a Python literal (dict/list/str/number/bool/null). */
export function formatPythonLiteral(value: unknown, indentLevel: number): string {
  const indent = '    '.repeat(indentLevel);
  const childIndent = '    '.repeat(indentLevel + 1);
  if (value === null) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'None';
  if (typeof value === 'string') return pythonDoubleQuote(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((entry) => `${childIndent}${formatPythonLiteral(entry, indentLevel + 1)},`);
    return `[\n${items.join('\n')}\n${indent}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    const lines = entries.map(
      ([key, entry]) =>
        `${childIndent}${pythonDoubleQuote(key)}: ${formatPythonLiteral(entry, indentLevel + 1)},`
    );
    return `{\n${lines.join('\n')}\n${indent}}`;
  }
  return pythonDoubleQuote(String(value));
}
