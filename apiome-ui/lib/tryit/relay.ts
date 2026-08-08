/**
 * Try It CORS-safe relay — SIM-3.2 (#4448).
 *
 * Framework-free logic behind the `POST /api/try-it` route handler: the browser cannot call
 * arbitrary API hosts (CORS), so the Try It panel relays composed requests through the browse
 * server. An unguarded relay is an SSRF hole, so every dispatch is wrapped in strict guardrails:
 *
 * - **Target allow-policy** — only the version's mock origin, the origins declared by the spec's
 *   `servers[]` (from `apiome.version_server`), and user-confirmed custom hosts are relayed;
 *   everything else is refused (HTTP 403 with a `detail` message, per the contract in
 *   `send.ts`).
 * - **SSRF defense** — DNS is resolved first and the request is refused when any *resolved*
 *   address is RFC1918, link-local (169.254.0.0/16, which covers the cloud-metadata endpoint
 *   169.254.169.254), loopback, CGNAT, or another non-public range. The route handler
 *   additionally re-resolves inside the socket connect (see `route.ts`), so a DNS-rebinding
 *   flip between check and connect is also caught. Redirects are followed manually and every
 *   hop is re-checked. The operator-configured mock origin is the one exemption: it is
 *   deployment infrastructure (often `localhost` in dev) and is only reachable when the target
 *   matches that exact origin.
 * - **Caps** — response bodies are truncated at {@link MAX_RESPONSE_BYTES} (flagged via the
 *   envelope's `truncated`), and the whole exchange (all redirect hops + body) is aborted at
 *   {@link RELAY_TIMEOUT_MS}.
 * - **Credential hygiene** — cookies are stripped in both directions, `Authorization`/API-key
 *   headers are dropped when a redirect changes origin, and nothing here logs or persists
 *   request contents.
 *
 * The response envelope (`{ status, statusText, headers, body, bodyEncoding, durationMs,
 * sizeBytes, truncated, gateway? }`) matches what `sendViaProxy` in `send.ts` unwraps; upstream
 * network failures are reported *inside* the envelope as synthesized 502/504 gateway statuses
 * (flagged with `gateway: true` so the SIM-3.3 viewer can phrase them as failures, not upstream
 * responses) with a plain-text notice body, because the relay itself replies HTTP 200 for any
 * upstream outcome. Bodies that are not valid UTF-8 text travel base64-encoded
 * (`bodyEncoding: 'base64'`, see `body.ts`) so binary payloads survive the JSON envelope
 * byte-exact.
 *
 * Kept free of Next.js/undici/node imports so it is unit-testable under the browse Vitest setup
 * (which only runs `lib/**` tests); the route handler injects the real network dependencies.
 *
 * **Promoted here from `apiome-browse/lib/tryit/` by DWX-4.2 (private-suite#2691)** so the
 * designer's Try-It console enforces *this* policy rather than a second copy of it that could
 * drift — two SSRF policies for one product being the worst available outcome. Browse re-exports
 * the module from its old path and behaves exactly as before; the designer reaches it as
 * `@lib/tryit/relay`.
 *
 * The promotion added exactly one seam, and it is deliberately narrow: an application names the
 * version a request belongs to in **its own vocabulary** — Browse by the public slug triple, the
 * studio by record ids — so {@link parseRelayEnvelope} accepts a {@link RelayContextParser} and
 * defaults to Browse's {@link parseRelaySlugContext}. Nothing else about a relayed exchange varies
 * by application. In particular the allow-policy does not: it is still built server-side *from*
 * that context and handed in as a {@link RelayPolicy}, so a policy forged in the request body has
 * nowhere to arrive.
 */

import { encodeBodyBytes, type BodyEncoding } from './body';
import type { TargetKind } from './send';

/** Maximum relayed response-body size in bytes (1 MiB); larger bodies are truncated. */
export const MAX_RESPONSE_BYTES = 1024 * 1024;

/** Maximum accepted outgoing request-body size in bytes (1 MiB). */
export const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

/** Total wall-clock budget for one relayed exchange (all redirect hops + body read). */
export const RELAY_TIMEOUT_MS = 10_000;

/** Maximum redirect hops followed before the final 3xx is relayed as-is. */
export const MAX_REDIRECTS = 5;

/** Error `code` the route handler's connect-time DNS guard uses to signal an SSRF block. */
export const SSRF_BLOCKED_CODE = 'ESSRFBLOCKED';

/** The refusal message for targets that resolve to a non-public address. */
const SSRF_REFUSAL_DETAIL =
  'The target resolves to a private, link-local, loopback, or metadata address and was refused (SSRF guard).';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ------------------------------------------------------------------------------------------------
// Relay request envelope (what `sendViaProxy` POSTs) and its validation
// ------------------------------------------------------------------------------------------------

/**
 * How Browse names the version a relayed request belongs to — the default relay context.
 *
 * Public slugs, because that is how a browsed version is addressed: the route handler looks the
 * version's mock URL and spec `servers[]` up from these three and never from anything the browser
 * asserts about the policy itself.
 */
export interface RelaySlugContext {
  tenantSlug: string;
  projectSlug: string;
  versionSlug: string;
}

/**
 * A validated relay request, mirroring `TryItRequest` from `send.ts`.
 *
 * @typeParam TContext - How the hosting application names the version this request belongs to;
 *   {@link RelaySlugContext} (Browse's public slugs) unless a caller says otherwise.
 */
export interface RelayRequest<TContext = RelaySlugContext> {
  /** Absolute http(s) target URL. */
  url: string;
  /** Upper-case HTTP method token. */
  method: string;
  /** Request headers (name → value), not yet sanitized. */
  headers: Record<string, string>;
  /** Raw request body text, or null for body-less requests. */
  body: string | null;
  /** Where the target URL came from, plus custom-host confirmation. */
  target: { kind: TargetKind; customHostConfirmed?: boolean };
  /** The version, used to look up the mock URL and spec servers server-side. */
  context: TContext;
}

/**
 * Outcome of {@link parseRelayEnvelope}.
 *
 * @typeParam TContext - The validated context type; see {@link RelayRequest}.
 */
export type ParsedEnvelope<TContext = RelaySlugContext> =
  | { ok: true; request: RelayRequest<TContext> }
  | { ok: false; detail: string };

/**
 * Validates the `context` member of a relay envelope into an application's own identifiers.
 *
 * The only part of the envelope that varies between the applications sharing this relay, and it
 * varies in *naming* only: whatever comes back is used to build the allow-policy server-side, so a
 * parser that accepted a policy here would defeat the guard it feeds.
 *
 * @typeParam TContext - The validated context type.
 */
export type RelayContextParser<TContext> = (
  raw: unknown
) => { ok: true; context: TContext } | { ok: false; detail: string };

/** Methods the relay refuses outright (tunneling / diagnostics verbs). */
const FORBIDDEN_METHODS = new Set(['CONNECT', 'TRACE', 'TRACK']);

/** RFC 7230 header-name token. */
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const MAX_URL_LENGTH = 8192;
const MAX_HEADER_COUNT = 64;
const MAX_HEADER_VALUE_LENGTH = 8192;
/** Longest accepted context identifier — a slug, or a record id, is far shorter than this. */
export const MAX_SLUG_LENGTH = 200;

/** Byte length of a UTF-8 string without relying on Buffer. */
function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Whether a context member is a usable identifier: a non-empty, bounded string.
 *
 * Exported so an application supplying its own {@link RelayContextParser} bounds its identifiers
 * the same way rather than inventing a second limit.
 *
 * @param value - The raw context member.
 * @returns True when the value is a non-empty string of at most {@link MAX_SLUG_LENGTH} chars.
 */
export function isRelaySlug(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_SLUG_LENGTH;
}

/**
 * Validate Browse's context: the public tenant/project/version slug triple.
 *
 * The default parser of {@link parseRelayEnvelope}, and the shape `sendViaProxy` posts.
 *
 * @param raw - The envelope's unvalidated `context` member.
 * @returns The validated slugs, or a refusal detail.
 */
export const parseRelaySlugContext: RelayContextParser<RelaySlugContext> = (raw) => {
  if (
    !isObject(raw) ||
    !isRelaySlug(raw.tenantSlug) ||
    !isRelaySlug(raw.projectSlug) ||
    !isRelaySlug(raw.versionSlug)
  ) {
    return { ok: false, detail: 'The relay request needs context tenant/project/version slugs.' };
  }
  return {
    ok: true,
    context: {
      tenantSlug: raw.tenantSlug,
      projectSlug: raw.projectSlug,
      versionSlug: raw.versionSlug,
    },
  };
};

/**
 * Validate the raw JSON body posted to a relay route into a {@link RelayRequest}.
 *
 * Everything is narrowed defensively — the poster is a browser, so nothing about the shape is
 * trusted. Rejections carry a human-readable `detail` for the 400 response.
 *
 * @param raw - The parsed (but unvalidated) JSON request body.
 * @param parseContext - Validates the `context` member into the hosting application's own
 *   identifiers; defaults to {@link parseRelaySlugContext}, which is what Browse posts.
 * @returns The validated request, or a refusal detail.
 */
export function parseRelayEnvelope(raw: unknown): ParsedEnvelope<RelaySlugContext>;
export function parseRelayEnvelope<TContext>(
  raw: unknown,
  parseContext: RelayContextParser<TContext>
): ParsedEnvelope<TContext>;
export function parseRelayEnvelope(
  raw: unknown,
  parseContext: RelayContextParser<unknown> = parseRelaySlugContext
): ParsedEnvelope<unknown> {
  if (!isObject(raw)) {
    return { ok: false, detail: 'The relay request must be a JSON object.' };
  }

  const { url, method, headers, body, target, context } = raw;

  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_URL_LENGTH) {
    return { ok: false, detail: 'The relay request needs an absolute target URL.' };
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { ok: false, detail: `Not a valid absolute URL: ${url}` };
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return { ok: false, detail: 'Only http and https targets are supported.' };
  }

  if (typeof method !== 'string' || !/^[A-Za-z]{1,20}$/.test(method)) {
    return { ok: false, detail: 'The relay request needs a valid HTTP method.' };
  }
  const upperMethod = method.toUpperCase();
  if (FORBIDDEN_METHODS.has(upperMethod)) {
    return { ok: false, detail: `The ${upperMethod} method is not relayed.` };
  }

  if (!isObject(headers)) {
    return { ok: false, detail: 'The relay request headers must be a name → value object.' };
  }
  const headerEntries = Object.entries(headers);
  if (headerEntries.length > MAX_HEADER_COUNT) {
    return { ok: false, detail: `At most ${MAX_HEADER_COUNT} request headers are relayed.` };
  }
  const cleanHeaders: Record<string, string> = {};
  for (const [name, value] of headerEntries) {
    if (!HEADER_NAME_RE.test(name)) {
      return { ok: false, detail: `Invalid header name: ${JSON.stringify(name)}` };
    }
    if (
      typeof value !== 'string' ||
      value.length > MAX_HEADER_VALUE_LENGTH ||
      /[\r\n\0]/.test(value)
    ) {
      return { ok: false, detail: `Invalid value for header ${name}.` };
    }
    cleanHeaders[name] = value;
  }

  if (body !== null && body !== undefined && typeof body !== 'string') {
    return { ok: false, detail: 'The relay request body must be a string or null.' };
  }
  const cleanBody = typeof body === 'string' ? body : null;
  if (cleanBody !== null && utf8Bytes(cleanBody) > MAX_REQUEST_BODY_BYTES) {
    return {
      ok: false,
      detail: `The request body exceeds the relay cap of ${MAX_REQUEST_BODY_BYTES} bytes.`,
    };
  }

  if (!isObject(target) || !['mock', 'spec', 'custom'].includes(target.kind as string)) {
    return { ok: false, detail: 'The relay request needs a target kind (mock, spec, or custom).' };
  }
  if (
    target.customHostConfirmed !== undefined &&
    typeof target.customHostConfirmed !== 'boolean'
  ) {
    return { ok: false, detail: 'target.customHostConfirmed must be a boolean when present.' };
  }

  const parsedContext = parseContext(context);
  if (!parsedContext.ok) {
    return { ok: false, detail: parsedContext.detail };
  }

  return {
    ok: true,
    request: {
      url,
      method: upperMethod,
      headers: cleanHeaders,
      body: cleanBody,
      target: {
        kind: target.kind as TargetKind,
        ...(target.customHostConfirmed !== undefined
          ? { customHostConfirmed: target.customHostConfirmed }
          : {}),
      },
      context: parsedContext.context,
    },
  };
}

// ------------------------------------------------------------------------------------------------
// SSRF IP guard
// ------------------------------------------------------------------------------------------------

/** Parse a strict dotted-quad IPv4 address into its 32-bit value, or null. */
function parseIpv4(text: string): number | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!match) return null;
  let value = 0;
  for (let i = 1; i <= 4; i++) {
    const octet = Number(match[i]);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/** Parse the hextet chunks of an IPv6 address (with an optional trailing dotted-quad). */
function ipv6GroupsOf(chunks: string[]): number[] | null {
  const groups: number[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk.includes('.')) {
      // Embedded IPv4 notation is only valid as the final chunk (e.g. ::ffff:10.0.0.1).
      if (i !== chunks.length - 1) return null;
      const v4 = parseIpv4(chunk);
      if (v4 === null) return null;
      groups.push(Math.floor(v4 / 0x10000), v4 % 0x10000);
    } else {
      if (!/^[0-9a-fA-F]{1,4}$/.test(chunk)) return null;
      groups.push(parseInt(chunk, 16));
    }
  }
  return groups;
}

/** Parse an IPv6 address into its eight 16-bit groups, or null. Zone indexes are ignored. */
function parseIpv6(text: string): number[] | null {
  let ip = text;
  const zone = ip.indexOf('%');
  if (zone !== -1) ip = ip.slice(0, zone);
  if (!ip.includes(':')) return null;

  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = ipv6GroupsOf(halves[0] === '' ? [] : halves[0].split(':'));
  if (head === null) return null;

  if (halves.length === 1) {
    return head.length === 8 ? head : null;
  }
  const tail = ipv6GroupsOf(halves[1] === '' ? [] : halves[1].split(':'));
  if (tail === null) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

/** Non-public IPv4 ranges the relay refuses, as [network, prefixLength]. */
const BLOCKED_IPV4_RANGES: [number, number][] = [
  [0x00000000, 8], // 0.0.0.0/8 "this network"
  [0x0a000000, 8], // 10.0.0.0/8 RFC1918
  [0x64400000, 10], // 100.64.0.0/10 CGNAT (includes Alibaba metadata 100.100.100.200)
  [0x7f000000, 8], // 127.0.0.0/8 loopback
  [0xa9fe0000, 16], // 169.254.0.0/16 link-local (includes cloud metadata 169.254.169.254)
  [0xac100000, 12], // 172.16.0.0/12 RFC1918
  [0xc0000000, 24], // 192.0.0.0/24 IETF protocol assignments
  [0xc0000200, 24], // 192.0.2.0/24 documentation
  [0xc0a80000, 16], // 192.168.0.0/16 RFC1918
  [0xc6120000, 15], // 198.18.0.0/15 benchmarking
  [0xc6336400, 24], // 198.51.100.0/24 documentation
  [0xcb007100, 24], // 203.0.113.0/24 documentation
  [0xe0000000, 3], // 224.0.0.0/3 multicast + reserved + broadcast
];

function isBlockedIpv4(value: number): boolean {
  return BLOCKED_IPV4_RANGES.some(([network, prefix]) => {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return ((value & mask) >>> 0) === network;
  });
}

function isBlockedIpv6(groups: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  const embeddedV4 = g6 * 0x10000 + g7;

  // :: (unspecified) and ::1 (loopback).
  if (groups.slice(0, 7).every((g) => g === 0)) {
    if (g7 === 0 || g7 === 1) return true;
  }
  // ::ffff:a.b.c.d IPv4-mapped — judge by the embedded IPv4 address.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isBlockedIpv4(embeddedV4);
  }
  // 64:ff9b::/96 NAT64 — judge by the embedded IPv4 address.
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isBlockedIpv4(embeddedV4);
  }
  // 2002::/16 6to4 — the IPv4 address is embedded in groups 1-2.
  if (g0 === 0x2002) {
    return isBlockedIpv4(g1 * 0x10000 + g2);
  }
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/**
 * Decide whether an IP address is off-limits for the relay.
 *
 * Blocked: RFC1918, loopback, link-local (169.254.0.0/16 — covers cloud metadata endpoints),
 * CGNAT, "this network", documentation/benchmarking, multicast/reserved, their IPv6
 * equivalents, and IPv6 forms that embed a blocked IPv4 address (mapped, NAT64, 6to4).
 * Unparseable input is blocked (fail closed).
 *
 * @param ip - A textual IPv4/IPv6 address (IPv6 may be bracketed, as in URL hostnames).
 * @returns True when the relay must not connect to this address.
 */
export function isBlockedIp(ip: string): boolean {
  const bare = ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip;
  const v4 = parseIpv4(bare);
  if (v4 !== null) return isBlockedIpv4(v4);
  const v6 = parseIpv6(bare);
  if (v6 !== null) return isBlockedIpv6(v6);
  return true;
}

// ------------------------------------------------------------------------------------------------
// Target allow-policy
// ------------------------------------------------------------------------------------------------

/** The server-side allow-policy inputs, derived from the browsed version. */
export interface RelayPolicy {
  /** The version's mock origin (from `APIOME_MOCK_PUBLIC_BASE_URL`), or null when its mock is
   * disabled. This operator-configured origin is exempt from the IP guard. */
  mockOrigin: string | null;
  /** Origins declared by the version's spec `servers[]` (variable defaults substituted). */
  specOrigins: string[];
}

/** One `apiome.version_server` row, as returned by `getPublicVersionServers`. */
export interface VersionServerRow {
  /** The declared server URL, possibly containing `{variable}` templates. */
  url: string;
  /** OpenAPI server variables (`{ name: { default, enum, description } }`), or null. */
  variables?: unknown;
}

/**
 * Substitute `{variable}` placeholders in a declared server URL with their defaults.
 *
 * Mirrors the client-side substitution in `operation.ts`, but reads the plain
 * `version_server.variables` JSON shape instead of a spec document.
 *
 * @param url - The declared server URL.
 * @param variables - The row's `variables` JSON (`{ name: { default, enum } }`), or null.
 * @returns The URL with resolvable placeholders substituted; unresolvable ones are left as-is.
 */
export function serverUrlWithDefaults(url: string, variables: unknown): string {
  if (!isObject(variables)) return url;
  return url.replace(/\{([^{}]+)\}/g, (match, name: string) => {
    const variable = variables[name];
    if (!isObject(variable)) return match;
    if (typeof variable.default === 'string') return variable.default;
    if (Array.isArray(variable.enum) && typeof variable.enum[0] === 'string') {
      return variable.enum[0];
    }
    return match;
  });
}

/**
 * Derive the allow-listed origins from a version's declared `servers[]` rows.
 *
 * Rows whose URL is relative, non-http(s), or still contains an unresolved `{variable}` after
 * default substitution are skipped — an origin that cannot be pinned down exactly is not
 * allow-listed.
 *
 * @param rows - The version's `apiome.version_server` rows.
 * @returns Unique `URL.origin` strings, in declaration order.
 */
export function deriveAllowedSpecOrigins(rows: VersionServerRow[]): string[] {
  const origins = new Set<string>();
  for (const row of rows) {
    if (!isObject(row) || typeof row.url !== 'string' || row.url.length === 0) continue;
    const substituted = serverUrlWithDefaults(row.url, row.variables);
    if (substituted.includes('{')) continue;
    let parsed: URL;
    try {
      parsed = new URL(substituted);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
    origins.add(parsed.origin);
  }
  return [...origins];
}

/** Outcome of {@link checkTargetAllowed}. */
export type TargetVerdict = { allowed: true } | { allowed: false; detail: string };

/**
 * Apply the host allow-policy to the composed request's target.
 *
 * - `mock` targets must match the version's mock origin exactly (and the mock must be enabled).
 * - `spec` targets must match one of the origins declared by the spec's `servers[]`.
 * - `custom` targets require the user's explicit confirmation flag.
 *
 * The SSRF IP guard runs separately (per hop, in {@link executeRelay}); this check only decides
 * whether the *named* target is one the relay is willing to contact at all.
 *
 * @param urlStr - The absolute target URL (already validated as http/https).
 * @param target - The request's target descriptor.
 * @param policy - The version's allow-policy inputs.
 * @returns Allowed, or a refusal detail for the 403 response.
 */
export function checkTargetAllowed(
  urlStr: string,
  target: RelayRequest['target'],
  policy: RelayPolicy
): TargetVerdict {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    return { allowed: false, detail: `Not a valid absolute URL: ${urlStr}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { allowed: false, detail: 'Only http and https targets are supported.' };
  }

  switch (target.kind) {
    case 'mock':
      if (!policy.mockOrigin) {
        return { allowed: false, detail: 'Mock is not enabled for this version.' };
      }
      if (url.origin !== policy.mockOrigin) {
        return { allowed: false, detail: "The target does not match this version's mock server." };
      }
      return { allowed: true };
    case 'spec':
      if (!policy.specOrigins.includes(url.origin)) {
        return {
          allowed: false,
          detail: "The target host is not declared by this specification's servers list.",
        };
      }
      return { allowed: true };
    case 'custom':
      if (target.customHostConfirmed !== true) {
        return {
          allowed: false,
          detail: 'Custom hosts must be explicitly confirmed before the relay will contact them.',
        };
      }
      return { allowed: true };
  }
}

// ------------------------------------------------------------------------------------------------
// Header hygiene
// ------------------------------------------------------------------------------------------------

/** Request headers never forwarded: cookies (credential hygiene), transport/hop-by-hop headers
 * the relay manages itself, and encodings the relay cannot decode for the viewer. */
const DROPPED_REQUEST_HEADERS = new Set([
  'cookie',
  'cookie2',
  'host',
  'content-length',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'expect',
  'te',
  'trailer',
  'proxy-authorization',
  'proxy-connection',
  'accept-encoding',
]);

/** Credential-bearing headers dropped when a redirect leaves the current origin. */
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'x-auth-token',
]);

/** Response headers never relayed back: cookies (credential hygiene). */
const DROPPED_RESPONSE_HEADERS = new Set(['set-cookie', 'set-cookie2']);

/**
 * Sanitize the composed request headers before forwarding.
 *
 * Cookies and hop-by-hop/transport headers are dropped, and `Accept-Encoding` is pinned to
 * `identity` so the relayed body is plain text the viewer can display.
 *
 * @param headers - The validated request headers.
 * @returns A new sanitized header map.
 */
export function sanitizeRequestHeaders(headers: Record<string, string>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (DROPPED_REQUEST_HEADERS.has(name.toLowerCase())) continue;
    clean[name] = value;
  }
  clean['accept-encoding'] = 'identity';
  return clean;
}

/**
 * Drop credential-bearing headers (used when a redirect changes origin).
 *
 * @param headers - The current sanitized header map.
 * @returns A new header map without {@link SENSITIVE_HEADERS}.
 */
export function stripSensitiveHeaders(headers: Record<string, string>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADERS.has(name.toLowerCase())) continue;
    clean[name] = value;
  }
  return clean;
}

/**
 * Flatten and sanitize upstream response headers for the envelope.
 *
 * `Set-Cookie` never crosses back to the browser; multi-valued headers are joined with `, `.
 *
 * @param headers - The upstream response headers (undici shape).
 * @returns A plain name → value map for the envelope.
 */
export function sanitizeResponseHeaders(
  headers: Record<string, string | string[] | undefined>
): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
    clean[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return clean;
}

// ------------------------------------------------------------------------------------------------
// Relay execution
// ------------------------------------------------------------------------------------------------

/** The response envelope `sendViaProxy` unwraps (see the contract in `send.ts`). */
export interface RelayResult {
  /** Upstream HTTP status (or a synthesized 502/504 for gateway failures). */
  status: number;
  statusText: string;
  /** Sanitized upstream response headers. */
  headers: Record<string, string>;
  /** Upstream response body (possibly truncated), or a gateway notice. */
  body: string;
  /** How `body` is encoded: plain text, or base64 for bytes that are not valid UTF-8. */
  bodyEncoding: BodyEncoding;
  /** Wall-clock duration of the whole exchange in milliseconds. */
  durationMs: number;
  /** Byte size of the returned body. */
  sizeBytes: number;
  /** True when the body was cut off by the size cap or the time budget. */
  truncated: boolean;
  /** True when the status was synthesized by the relay (target unreachable / timed out). */
  gateway?: true;
}

/** Outcome of {@link executeRelay}: an envelope to relay, or a 403 refusal. */
export type RelayOutcome =
  | { kind: 'response'; envelope: RelayResult }
  | { kind: 'refused'; detail: string };

/** An in-flight upstream response, as the injected HTTP client returns it. */
export interface RelayHttpResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  /** The body stream; `destroy` is called when the body is discarded (redirect hops). */
  body: AsyncIterable<Uint8Array> & { destroy?: (err?: Error) => void };
}

/** The injected HTTP client (undici in production, a stub in tests). `ipGuard` tells the client
 * whether the SSRF-guarded connection path must be used for this hop. */
export type RelayHttpRequest = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string | null;
    signal: AbortSignal;
    ipGuard: boolean;
  }
) => Promise<RelayHttpResponse>;

/** Injectable dependencies and caps for {@link executeRelay}. */
export interface RelayDeps {
  /** Performs one HTTP exchange without following redirects. */
  httpRequest: RelayHttpRequest;
  /** Resolves a hostname to all of its addresses (DNS lookup). */
  resolve: (hostname: string) => Promise<string[]>;
  /** Millisecond clock; defaults to `Date.now`. */
  now?: () => number;
  /** Total time budget; defaults to {@link RELAY_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Response-body cap; defaults to {@link MAX_RESPONSE_BYTES}. */
  maxBodyBytes?: number;
  /** Redirect-hop cap; defaults to {@link MAX_REDIRECTS}. */
  maxRedirects?: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Reason phrases for the envelope's `statusText` (undici exposes no upstream phrase). */
const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  410: 'Gone',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

/** The reason phrase for a status code, or `''` when unknown. */
export function statusTextFor(status: number): string {
  return STATUS_TEXT[status] ?? '';
}

/** Read one (possibly multi-valued) header case-insensitively. */
function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    if (Array.isArray(value)) return value[0];
    return value;
  }
  return undefined;
}

/** True when the error (or its cause chain) carries {@link SSRF_BLOCKED_CODE}. */
function isSsrfBlockedError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 8 && isObject(current); depth++) {
    if (current.code === SSRF_BLOCKED_CODE) return true;
    current = current.cause;
  }
  return false;
}

/** Build a synthesized gateway envelope (upstream unreachable / timed out). */
function gatewayEnvelope(status: 502 | 504, notice: string, durationMs: number): RelayResult {
  return {
    status,
    statusText: statusTextFor(status),
    headers: {},
    body: notice,
    bodyEncoding: 'text',
    durationMs,
    sizeBytes: utf8Bytes(notice),
    truncated: false,
    gateway: true,
  };
}

/** Strip URL brackets from an IPv6 hostname (`[::1]` → `::1`). */
function bareHostname(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

/** True when the hostname is an IP literal (no DNS resolution needed). */
function isIpLiteral(hostname: string): boolean {
  return parseIpv4(hostname) !== null || parseIpv6(hostname) !== null;
}

type HostGuardVerdict =
  | { ok: true }
  | { ok: false; refused?: string; gateway?: string };

/**
 * Pre-flight SSRF check for one hop: resolve the hostname and refuse when *any* resolved
 * address (or the literal address itself) is blocked. Checking every resolved address defeats
 * DNS answers that mix a public and a private record.
 */
async function guardTargetHost(
  hostname: string,
  resolve: (hostname: string) => Promise<string[]>
): Promise<HostGuardVerdict> {
  const bare = bareHostname(hostname);
  if (isIpLiteral(bare)) {
    return isBlockedIp(bare) ? { ok: false, refused: SSRF_REFUSAL_DETAIL } : { ok: true };
  }
  let addresses: string[];
  try {
    addresses = await resolve(bare);
  } catch {
    return { ok: false, gateway: `Could not resolve host ${bare}.` };
  }
  if (addresses.length === 0) {
    return { ok: false, gateway: `Could not resolve host ${bare}.` };
  }
  if (addresses.some((address) => isBlockedIp(address))) {
    return { ok: false, refused: SSRF_REFUSAL_DETAIL };
  }
  return { ok: true };
}

/** Read a body stream up to `cap` bytes; an abort mid-read counts as truncation. */
async function readBodyCapped(
  body: RelayHttpResponse['body'],
  cap: number
): Promise<{ bytes: Uint8Array; sizeBytes: number; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for await (const chunk of body) {
      if (total + chunk.length > cap) {
        chunks.push(chunk.slice(0, cap - total));
        total = cap;
        truncated = true;
        body.destroy?.();
        break;
      }
      chunks.push(chunk);
      total += chunk.length;
    }
  } catch {
    // The 10s budget aborted the stream mid-body — keep what arrived, flag it truncated.
    truncated = true;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes: merged, sizeBytes: total, truncated };
}

/**
 * Execute one relayed exchange end to end: allow-policy, per-hop SSRF guard, manual redirect
 * following, the 10s/1MB caps, and envelope assembly.
 *
 * Redirects are followed manually (up to `maxRedirects`, then the 3xx is relayed as-is) so the
 * IP guard re-runs on every hop; 303 — and 301/302 on non-GET — rewrite to GET and drop the
 * body, and credential headers are stripped when a hop changes origin. The operator-configured
 * mock origin is the only hop exempt from the IP guard (it is deployment infrastructure, often
 * loopback in dev).
 *
 * Upstream connection failures and timeouts come back as synthesized 502/504 envelopes rather
 * than refusals, because the target was legitimate — it just did not answer.
 *
 * The request's `context` is not read here at all: it named the version, the caller has already
 * spent it on building `policy`, and this function's job is the exchange. That is what lets one
 * relay serve two applications that address a version differently.
 *
 * @param request - The validated relay request, in whatever context vocabulary the caller parsed.
 * @param policy - The version's allow-policy inputs, derived server-side by the caller.
 * @param deps - Injected network dependencies and caps.
 * @returns The envelope to relay, or a refusal for the 403 response.
 */
export async function executeRelay(
  request: RelayRequest<unknown>,
  policy: RelayPolicy,
  deps: RelayDeps
): Promise<RelayOutcome> {
  const {
    httpRequest,
    resolve,
    now = Date.now,
    timeoutMs = RELAY_TIMEOUT_MS,
    maxBodyBytes = MAX_RESPONSE_BYTES,
    maxRedirects = MAX_REDIRECTS,
  } = deps;

  const verdict = checkTargetAllowed(request.url, request.target, policy);
  if (!verdict.allowed) return { kind: 'refused', detail: verdict.detail };

  const started = now();
  const elapsed = () => Math.max(0, now() - started);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let url = new URL(request.url);
    let method = request.method;
    let headers = sanitizeRequestHeaders(request.headers);
    let body = request.body;

    for (let hop = 0; hop <= maxRedirects; hop++) {
      const exempt = policy.mockOrigin !== null && url.origin === policy.mockOrigin;
      if (!exempt) {
        const guard = await guardTargetHost(url.hostname, resolve);
        if (!guard.ok) {
          if (guard.refused) return { kind: 'refused', detail: guard.refused };
          return {
            kind: 'response',
            envelope: gatewayEnvelope(502, `Relay notice: ${guard.gateway}`, elapsed()),
          };
        }
      }

      let response: RelayHttpResponse;
      try {
        response = await httpRequest(url.toString(), {
          method,
          headers,
          body,
          signal: controller.signal,
          ipGuard: !exempt,
        });
      } catch (err) {
        if (isSsrfBlockedError(err)) {
          return { kind: 'refused', detail: SSRF_REFUSAL_DETAIL };
        }
        if (controller.signal.aborted) {
          return {
            kind: 'response',
            envelope: gatewayEnvelope(
              504,
              `Relay notice: the target did not respond within ${timeoutMs / 1000}s, so the request was aborted.`,
              elapsed()
            ),
          };
        }
        const message = err instanceof Error ? err.message : String(err);
        return {
          kind: 'response',
          envelope: gatewayEnvelope(
            502,
            `Relay notice: could not reach ${url.origin} (${message}).`,
            elapsed()
          ),
        };
      }

      // Follow redirects manually so every hop re-enters the SSRF guard above.
      if (REDIRECT_STATUSES.has(response.statusCode) && hop < maxRedirects) {
        const location = headerValue(response.headers, 'location');
        const next = ((): URL | null => {
          if (location === undefined) return null;
          try {
            return new URL(location, url);
          } catch {
            return null;
          }
        })();
        if (next) {
          response.body.destroy?.();
          if (next.protocol !== 'http:' && next.protocol !== 'https:') {
            return { kind: 'refused', detail: 'The target redirected to an unsupported scheme.' };
          }
          if (
            response.statusCode === 303 ||
            ((response.statusCode === 301 || response.statusCode === 302) &&
              method !== 'GET' &&
              method !== 'HEAD')
          ) {
            method = 'GET';
            body = null;
            headers = Object.fromEntries(
              Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'content-type')
            );
          }
          if (next.origin !== url.origin) {
            headers = stripSensitiveHeaders(headers);
          }
          url = next;
          continue;
        }
      }

      const { bytes, sizeBytes, truncated } = await readBodyCapped(response.body, maxBodyBytes);
      const { body: encodedBody, bodyEncoding } = encodeBodyBytes(bytes, {
        trimIncompleteTrailing: truncated,
      });
      return {
        kind: 'response',
        envelope: {
          status: response.statusCode,
          statusText: statusTextFor(response.statusCode),
          headers: sanitizeResponseHeaders(response.headers),
          body: encodedBody,
          bodyEncoding,
          durationMs: elapsed(),
          sizeBytes,
          truncated,
        },
      };
    }
    throw new Error('unreachable: the redirect loop always relays the final hop');
  } finally {
    clearTimeout(timer);
  }
}
