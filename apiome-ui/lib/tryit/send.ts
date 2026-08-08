/**
 * Try It send pipeline — SIM-3.1 (#4447).
 *
 * Dispatches a composed Try It request either directly from the browser (only when the target is
 * same-origin with the page, where CORS cannot interfere) or through the SIM-3.2 CORS-safe relay
 * (`POST /api/try-it`, #4448). The relay contract is defined here so the route handler and this
 * client stay in lockstep:
 *
 * Request envelope (JSON):
 *   `{ url, method, headers, body, target: { kind, customHostConfirmed? }, context }`
 *   - `target.kind` — 'mock' | 'spec' | 'custom'; drives the relay's host allow-policy.
 *   - `target.customHostConfirmed` — the user's explicit confirmation for custom hosts.
 *   - `context` — `{ tenantSlug, projectSlug, versionSlug }` so the relay can look up the
 *     version's mock URL and spec `servers[]` server-side when enforcing the allow-policy.
 *
 * Response envelope (JSON, HTTP 200 from the relay even for upstream errors):
 *   `{ status, statusText, headers, body, bodyEncoding, durationMs, sizeBytes, truncated,
 *   gateway? }`
 *   `bodyEncoding` is `'base64'` when the body bytes are not valid UTF-8 text (see `body.ts`);
 *   `gateway` marks statuses the relay synthesized itself (target unreachable / timed out).
 *   Relay refusals (allow-policy / SSRF guard) come back as HTTP 403 with a `detail` message.
 *
 * Framework-free (fetch is injectable) so it is unit-testable under the browse Vitest setup.
 *
 * **Promoted here from `apiome-browse/lib/tryit/` by DWX-4.2 (private-suite#2691)**, together with
 * the relay it talks to (`relay.ts`), so a request composed in the studio and one composed in
 * Browse are the same request rather than two dialects of one envelope. Exactly two things vary by
 * application, and both are options carrying Browse's value as their default: the relay's **path**
 * ({@link SendOptions.relayPath} — `/api/try-it` here, `/api/workspace/try-it` in the designer's
 * BFF) and how a version is **named** ({@link TryItRequest}'s context type parameter). The
 * envelope, the refusal contract and the unwrapping are shared and deliberately not parameterized.
 */

import { encodeBodyBytes, type BodyEncoding } from './body';
import type { RelaySlugContext } from './relay';

/** Which server-picker source produced the target URL (drives the relay's allow-policy). */
export type TargetKind = 'mock' | 'spec' | 'custom';

/** Where a composed request is relayed when it is not same-origin with the page. */
export const DEFAULT_RELAY_PATH = '/api/try-it';

/**
 * A fully composed request ready to dispatch.
 *
 * @typeParam TContext - How the hosting application names the version this request belongs to;
 *   Browse's public slug triple unless a caller says otherwise. The relay reads it only to build
 *   the allow-policy server-side, which is why the browser names a version and never a policy.
 */
export interface TryItRequest<TContext = RelaySlugContext> {
  /** Upper-case HTTP method. */
  method: string;
  /** Absolute target URL (server base + filled path + query string). */
  url: string;
  /** Request headers (already includes Content-Type when a body is present). */
  headers: Record<string, string>;
  /** Raw request body text, or null for body-less requests. */
  body: string | null;
  /** Where the target URL came from, plus custom-host confirmation. */
  target: { kind: TargetKind; customHostConfirmed?: boolean };
  /** The version, so the relay can enforce its allow-policy server-side. */
  context: TContext;
}

/** Normalized outcome of a dispatched request, whichever path it took. */
export interface TryItResult {
  /** Upstream HTTP status code. */
  status: number;
  statusText: string;
  /** Upstream response headers (name → value). */
  headers: Record<string, string>;
  /** Upstream response body: plain text, or base64 when `bodyEncoding` is `'base64'`. */
  bodyText: string;
  /** How `bodyText` is encoded; base64 carries bodies that are not valid UTF-8 (SIM-3.3). */
  bodyEncoding: BodyEncoding;
  /** Wall-clock request duration in milliseconds. */
  durationMs: number;
  /** Response body size in bytes. */
  sizeBytes: number;
  /** True when the relay truncated the body at its cap (SIM-3.2). */
  truncated: boolean;
  /** True when the status was synthesized by the relay (target unreachable / timed out). */
  gateway: boolean;
  /** Which pipeline dispatched the request. */
  via: 'direct' | 'proxy';
}

/** Why a send failed before producing an upstream response. */
export type TryItSendErrorKind =
  | 'invalid-url'
  | 'network'
  | 'proxy-unavailable'
  | 'refused'
  | 'bad-envelope';

/** Error raised by {@link sendTryIt}; `kind` lets the panel phrase the failure precisely. */
export class TryItSendError extends Error {
  constructor(
    public readonly kind: TryItSendErrorKind,
    message: string
  ) {
    super(message);
    this.name = 'TryItSendError';
  }
}

/** Options for {@link sendTryIt}; all are injectable for testing. */
export interface SendOptions {
  /** The page origin (`window.location.origin`); direct fetch is used only for this origin. */
  pageOrigin: string;
  /** Fetch implementation; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Millisecond clock for duration measurement; defaults to `Date.now`. */
  now?: () => number;
  /**
   * Where the hosting application mounts its relay; defaults to {@link DEFAULT_RELAY_PATH}.
   *
   * The one thing about the relay that is an application's own: Browse serves it at `/api/try-it`
   * and the designer at `/api/workspace/try-it`, behind its studio session. The envelope on the
   * wire is identical either way.
   */
  relayPath?: string;
}

/**
 * Decide whether a target URL is same-origin with the page (and may therefore be fetched
 * directly, without the relay).
 *
 * @param url - The absolute target URL.
 * @param pageOrigin - The page origin, e.g. `https://browse.example.com`.
 * @returns True when the URL parses and shares the page origin.
 */
export function isSameOrigin(url: string, pageOrigin: string): boolean {
  try {
    return new URL(url).origin === pageOrigin;
  } catch {
    return false;
  }
}

/** Convert a fetch Headers object into a plain name → value map. */
function headersToMap(headers: Headers): Record<string, string> {
  const map: Record<string, string> = {};
  headers.forEach((value, name) => {
    map[name] = value;
  });
  return map;
}

/** Byte length of a UTF-8 string without relying on Buffer (browser-safe). */
function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Dispatch a composed Try It request.
 *
 * Same-origin targets are fetched directly; everything else is relayed through the application's
 * relay route (SIM-3.2; {@link SendOptions.relayPath}). Note the mock host is cross-origin from
 * both applications and has no CORS middleware, so mock calls go through the relay too.
 *
 * @typeParam TContext - How this application names the version; see {@link TryItRequest}.
 * @param request - The composed request.
 * @param options - Page origin and relay path, plus injectable fetch/clock.
 * @returns The normalized upstream response.
 * @throws TryItSendError when the URL is invalid, the network fails, the relay is absent
 *   (`proxy-unavailable` — SIM-3.2 not deployed), the relay refuses the target (`refused`), or
 *   the relay reply is malformed (`bad-envelope`).
 */
export async function sendTryIt<TContext>(
  request: TryItRequest<TContext>,
  options: SendOptions
): Promise<TryItResult> {
  const {
    pageOrigin,
    fetchImpl = fetch,
    now = Date.now,
    relayPath = DEFAULT_RELAY_PATH,
  } = options;
  try {
    new URL(request.url);
  } catch {
    throw new TryItSendError('invalid-url', `Not a valid absolute URL: ${request.url}`);
  }

  if (isSameOrigin(request.url, pageOrigin)) {
    return sendDirect(request, fetchImpl, now);
  }
  return sendViaProxy(request, fetchImpl, now, relayPath);
}

/** Direct browser fetch — only reachable for same-origin targets. */
async function sendDirect(
  request: TryItRequest<unknown>,
  fetchImpl: typeof fetch,
  now: () => number
): Promise<TryItResult> {
  const started = now();
  let response: Response;
  try {
    response = await fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body ?? undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new TryItSendError('network', `Request failed: ${message}`);
  }
  // Read raw bytes (not text) so non-UTF-8 bodies survive for the SIM-3.3 response viewer.
  const bytes = new Uint8Array(await response.arrayBuffer());
  const { body: bodyText, bodyEncoding } = encodeBodyBytes(bytes);
  return {
    status: response.status,
    statusText: response.statusText,
    headers: headersToMap(response.headers),
    bodyText,
    bodyEncoding,
    durationMs: Math.max(0, now() - started),
    sizeBytes: bytes.length,
    truncated: false,
    gateway: false,
    via: 'direct',
  };
}

/** Relay through the application's `POST` relay route (SIM-3.2) and unwrap its envelope. */
async function sendViaProxy(
  request: TryItRequest<unknown>,
  fetchImpl: typeof fetch,
  now: () => number,
  relayPath: string
): Promise<TryItResult> {
  const started = now();
  let response: Response;
  try {
    response = await fetchImpl(relayPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: request.url,
        method: request.method,
        headers: request.headers,
        body: request.body,
        target: request.target,
        context: request.context,
      }),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new TryItSendError('network', `Could not reach the Try It relay: ${message}`);
  }

  if (response.status === 404 || response.status === 405) {
    throw new TryItSendError(
      'proxy-unavailable',
      `The Try It relay (${relayPath}) is not available in this deployment yet.`
    );
  }
  if (response.status === 403) {
    let detail = 'The Try It relay refused this target.';
    try {
      const problem: unknown = await response.json();
      if (
        typeof problem === 'object' &&
        problem !== null &&
        typeof (problem as Record<string, unknown>).detail === 'string'
      ) {
        detail = (problem as Record<string, string>).detail;
      }
    } catch {
      // Keep the generic refusal message.
    }
    throw new TryItSendError('refused', detail);
  }
  if (!response.ok) {
    throw new TryItSendError(
      'bad-envelope',
      `The Try It relay failed (${response.status} ${response.statusText}).`
    );
  }

  let envelope: unknown;
  try {
    envelope = await response.json();
  } catch {
    throw new TryItSendError('bad-envelope', 'The Try It relay returned a malformed reply.');
  }
  if (
    typeof envelope !== 'object' ||
    envelope === null ||
    typeof (envelope as Record<string, unknown>).status !== 'number'
  ) {
    throw new TryItSendError('bad-envelope', 'The Try It relay returned a malformed reply.');
  }
  const e = envelope as Record<string, unknown>;
  const bodyText = typeof e.body === 'string' ? e.body : '';
  return {
    status: e.status as number,
    statusText: typeof e.statusText === 'string' ? e.statusText : '',
    headers:
      typeof e.headers === 'object' && e.headers !== null && !Array.isArray(e.headers)
        ? (e.headers as Record<string, string>)
        : {},
    bodyText,
    bodyEncoding: e.bodyEncoding === 'base64' ? 'base64' : 'text',
    durationMs:
      typeof e.durationMs === 'number' ? e.durationMs : Math.max(0, now() - started),
    sizeBytes: typeof e.sizeBytes === 'number' ? e.sizeBytes : utf8Bytes(bodyText),
    truncated: e.truncated === true,
    gateway: e.gateway === true,
    via: 'proxy',
  };
}
