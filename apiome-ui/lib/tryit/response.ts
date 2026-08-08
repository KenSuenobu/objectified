/**
 * Try It response presentation helpers — SIM-3.3 (#4449).
 *
 * Framework-free logic behind the `ResponseViewer` component: deciding how a response body
 * should be presented (inline image, binary download, or highlighted text), pretty-printing,
 * download filenames, human-readable sizes/durations, and the distinct wording for each way a
 * send can fail. Kept free of React/DOM imports so it is unit-testable under the browse Vitest
 * setup (which only runs `lib/**` tests).
 */

import { bytesToBase64, decodeBodyBytes, type BodyEncoding } from './body';
import type { TryItResult, TryItSendErrorKind } from './send';

// ------------------------------------------------------------------------------------------------
// Body classification
// ------------------------------------------------------------------------------------------------

/** How the viewer should present a response body. */
export interface BodyPresentation {
  /** The presentation mode: inline image, binary download card, text view, or empty state. */
  view: 'image' | 'binary' | 'text' | 'empty';
  /** The bare media type (lower-case, no parameters), or '' when the header is absent. */
  mime: string;
  /** Monaco language id for the text view ('plaintext' when nothing better applies). */
  monacoLanguage: string;
  /** Which pretty-printer applies to the text view, if any. */
  pretty: 'json' | 'xml' | null;
}

/** Media types (or suffixes) mapped to Monaco language ids and pretty-printers. */
const TEXT_LANGUAGES: { match: (mime: string) => boolean; language: string; pretty: 'json' | 'xml' | null }[] = [
  { match: (m) => m === 'application/json' || m === 'text/json' || m.endsWith('+json'), language: 'json', pretty: 'json' },
  { match: (m) => m === 'application/xml' || m === 'text/xml' || m.endsWith('+xml'), language: 'xml', pretty: 'xml' },
  { match: (m) => m === 'text/html', language: 'html', pretty: null },
  { match: (m) => m === 'text/css', language: 'css', pretty: null },
  { match: (m) => m === 'text/javascript' || m === 'application/javascript', language: 'javascript', pretty: null },
  { match: (m) => m === 'application/yaml' || m === 'text/yaml' || m === 'application/x-yaml', language: 'yaml', pretty: null },
];

/** Extract the bare lower-case media type from a Content-Type header value. */
export function bareMime(contentType: string | undefined): string {
  if (!contentType) return '';
  return contentType.split(';')[0].trim().toLowerCase();
}

/** Read one header case-insensitively from a response header map. */
export function headerLookup(
  headers: Record<string, string>,
  name: string
): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

/**
 * Decide how a response body should be presented.
 *
 * Images render inline whatever their transport encoding (SVG travels as text, PNG as base64).
 * Any other body that needed base64 transport is binary — offering it as a download beats
 * showing garbled text, whatever the declared Content-Type claims. Text bodies get a Monaco
 * language from the media type, falling back to a JSON sniff for APIs that omit or mislabel
 * the header.
 *
 * @param result - The completed Try It result.
 * @returns The presentation descriptor for the viewer.
 */
export function classifyBody(result: {
  headers: Record<string, string>;
  bodyText: string;
  bodyEncoding: BodyEncoding;
}): BodyPresentation {
  const mime = bareMime(headerLookup(result.headers, 'content-type'));
  if (result.bodyText === '') {
    return { view: 'empty', mime, monacoLanguage: 'plaintext', pretty: null };
  }
  if (mime.startsWith('image/')) {
    return { view: 'image', mime, monacoLanguage: 'plaintext', pretty: null };
  }
  if (result.bodyEncoding === 'base64') {
    return { view: 'binary', mime, monacoLanguage: 'plaintext', pretty: null };
  }
  for (const entry of TEXT_LANGUAGES) {
    if (entry.match(mime)) {
      return { view: 'text', mime, monacoLanguage: entry.language, pretty: entry.pretty };
    }
  }
  // No usable media type — sniff JSON so bare APIs still get highlighting and pretty-print.
  const first = result.bodyText.trimStart()[0];
  if ((first === '{' || first === '[') && prettyPrintJson(result.bodyText) !== null) {
    return { view: 'text', mime, monacoLanguage: 'json', pretty: 'json' };
  }
  return { view: 'text', mime, monacoLanguage: 'plaintext', pretty: null };
}

// ------------------------------------------------------------------------------------------------
// Pretty-printing
// ------------------------------------------------------------------------------------------------

/** Pretty-print JSON with 2-space indentation, or null when the text is not valid JSON. */
export function prettyPrintJson(text: string): string | null {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return null;
  }
}

/**
 * Pretty-print XML with 2-space indentation, or null when the text does not look like XML.
 * This is a lightweight token indenter (tags vs. text runs), not a validating parser — good
 * enough for display, and it never throws on malformed markup.
 */
export function prettyPrintXml(text: string): string | null {
  const compact = text.replace(/>\s+</g, '><').trim();
  if (!compact.startsWith('<')) return null;
  const tokens = compact.match(/<[^>]*>|[^<]+/g);
  if (!tokens) return null;
  const lines: string[] = [];
  let depth = 0;
  for (const token of tokens) {
    const isTag = token.startsWith('<');
    const isClosing = token.startsWith('</');
    const isSelfContained =
      isTag &&
      (token.endsWith('/>') ||
        token.startsWith('<?') ||
        token.startsWith('<!'));
    if (isClosing) depth = Math.max(0, depth - 1);
    lines.push('  '.repeat(depth) + token.trim());
    if (isTag && !isClosing && !isSelfContained) depth++;
  }
  return lines.join('\n');
}

/**
 * The pretty form of a text body, or null when no pretty-printer applies (or the body does not
 * parse — e.g. it was truncated by the relay cap).
 */
export function prettyPrintBody(text: string, pretty: BodyPresentation['pretty']): string | null {
  if (pretty === 'json') return prettyPrintJson(text);
  if (pretty === 'xml') return prettyPrintXml(text);
  return null;
}

// ------------------------------------------------------------------------------------------------
// Download support
// ------------------------------------------------------------------------------------------------

/** File extensions for common media types (checked after the +json/+xml suffix rules). */
const MIME_EXTENSIONS: Record<string, string> = {
  'application/json': 'json',
  'text/json': 'json',
  'application/xml': 'xml',
  'text/xml': 'xml',
  'text/html': 'html',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'text/css': 'css',
  'text/javascript': 'js',
  'application/javascript': 'js',
  'application/yaml': 'yaml',
  'text/yaml': 'yaml',
  'application/x-yaml': 'yaml',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/gzip': 'gz',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/x-icon': 'ico',
  'audio/mpeg': 'mp3',
  'video/mp4': 'mp4',
};

/** The download extension for a media type, falling back by encoding when the type is unknown. */
export function extensionForMime(mime: string, bodyEncoding: BodyEncoding): string {
  if (MIME_EXTENSIONS[mime]) return MIME_EXTENSIONS[mime];
  if (mime.endsWith('+json')) return 'json';
  if (mime.endsWith('+xml')) return 'xml';
  if (mime.startsWith('text/')) return 'txt';
  return bodyEncoding === 'text' ? 'txt' : 'bin';
}

/** Strip a `filename="…"` (or bare filename=) from a Content-Disposition header value. */
function filenameFromContentDisposition(value: string | undefined): string | null {
  if (!value) return null;
  const match = /filename\s*=\s*(?:"([^"]+)"|([^\s;]+))/i.exec(value);
  const raw = match?.[1] ?? match?.[2];
  if (!raw) return null;
  // Keep only a safe basename: no path separators or control characters.
  const base = raw.replace(/[/\\]/g, '').trim();
  return base.length > 0 ? base : null;
}

/**
 * A sensible download filename for a response body.
 *
 * The upstream's own `Content-Disposition` filename wins when present; otherwise the name is
 * derived from the operation path (`/pets/{petId}` → `pets-petId-response`) with an extension
 * matching the media type.
 *
 * @param result - The completed Try It result (headers drive the extension and disposition).
 * @param operationPath - The templated operation path the request was built from.
 * @returns A filename such as `pets-petId-response.json`.
 */
export function suggestDownloadFilename(
  result: { headers: Record<string, string>; bodyEncoding: BodyEncoding },
  operationPath: string
): string {
  const fromDisposition = filenameFromContentDisposition(
    headerLookup(result.headers, 'content-disposition')
  );
  if (fromDisposition) return fromDisposition;
  const mime = bareMime(headerLookup(result.headers, 'content-type'));
  const slug = operationPath
    .replace(/[{}]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const base = slug.length > 0 ? `${slug}-response` : 'response';
  return `${base}.${extensionForMime(mime, result.bodyEncoding)}`;
}

/**
 * A `data:` URL rendering the response body inline (used for images).
 *
 * @param result - The completed Try It result.
 * @param mime - The bare media type to stamp on the URL.
 * @returns The data URL carrying the exact body bytes.
 */
export function bodyDataUrl(
  result: { bodyText: string; bodyEncoding: BodyEncoding },
  mime: string
): string {
  const base64 =
    result.bodyEncoding === 'base64'
      ? result.bodyText
      : bytesToBase64(decodeBodyBytes(result.bodyText, 'text'));
  return `data:${mime || 'application/octet-stream'};base64,${base64}`;
}

// ------------------------------------------------------------------------------------------------
// Formatting
// ------------------------------------------------------------------------------------------------

/** Human-readable byte count: `532 B`, `1.4 KB`, `1.0 MB`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Human-readable duration: `245 ms`, `1.24 s`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** Response headers as copy-friendly `Name: value` lines. */
export function headersClipboardText(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n');
}

// ------------------------------------------------------------------------------------------------
// Failure wording
// ------------------------------------------------------------------------------------------------

/** Distinct, actionable wording for one way a send can fail. */
export interface FailureDescription {
  /** Short headline, e.g. "Network failure". */
  title: string;
  /** What to do about it. */
  hint: string;
}

/**
 * Wording for a send that failed before producing an upstream response
 * (a {@link TryItSendError} from `sendTryIt`). The thrown error's own message carries the
 * specifics; this adds the headline and the "what now" guidance per failure kind.
 */
export function describeSendFailure(kind: TryItSendErrorKind): FailureDescription {
  switch (kind) {
    case 'invalid-url':
      return {
        title: 'Invalid request URL',
        hint: 'Check the selected server URL and the path parameter values, then send again.',
      };
    case 'network':
      return {
        title: 'Network failure',
        hint: 'The request never reached its target. Check your connection and that the browse server is up, then try again.',
      };
    case 'proxy-unavailable':
      return {
        title: 'Try It relay unavailable',
        hint: 'Cross-origin requests are sent through the browse server relay, which this deployment does not expose. Ask the operator to enable it, or target a same-origin server.',
      };
    case 'refused':
      return {
        title: 'Blocked by the Try It relay',
        hint: 'The relay only forwards to this version’s mock server, the servers declared in its spec, or a custom host you have explicitly confirmed — and never to private or internal addresses.',
      };
    case 'bad-envelope':
      return {
        title: 'Relay error',
        hint: 'The relay returned an unexpected reply. Try again; if it keeps failing, check the browse server logs.',
      };
  }
}

/**
 * Wording for a relay-synthesized gateway failure (the request was allowed, but the target did
 * not answer), or null for genuine upstream responses. The result's own body carries the relay
 * notice with the specifics.
 *
 * @param result - The completed Try It result.
 * @returns Distinct timeout/unreachable wording, or null when this is a real upstream response.
 */
export function describeGatewayFailure(
  result: Pick<TryItResult, 'gateway' | 'status'>
): FailureDescription | null {
  if (!result.gateway) return null;
  if (result.status === 504) {
    return {
      title: 'Request timed out',
      hint: 'The target accepted the connection but did not finish responding within the relay’s 10-second budget. Try again, or check whether the target is overloaded.',
    };
  }
  return {
    title: 'Target unreachable',
    hint: 'The relay could not connect to the target host. Check that the server is running and its URL (host and port) is correct, then send again.',
  };
}
