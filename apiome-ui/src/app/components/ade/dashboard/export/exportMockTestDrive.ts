/**
 * Export test-drive mock model — MFX-44.5 (#4371).
 *
 * "Test the format" at its strongest: point a live mock of the emitted API at the user and let
 * them send it real requests before they ship the artifact. The Mock Server engine (#3615) does
 * the serving; this module holds the **pure** half of the Studio's binding to it —
 *
 *  - the wire types of the four REST surfaces the panel talks to (capability, instance, request
 *    log, try-it), so the panel and the hook agree on one shape;
 *  - {@link mockSupportsTarget} — the capability-driven "does this target get a Test-drive panel
 *    at all" decision, answered from the server's `supportedTargets` and never from a format
 *    switch statement here (a new mockable emitter must need zero UI changes);
 *  - {@link mockAvailabilityNotice} — what a server *without* mock infrastructure renders: the
 *    ticket's "absent infra degrades to hidden/disabled" acceptance, resolved into one of three
 *    honest outcomes rather than a silent gap;
 *  - the countdown ({@link formatCountdown}, {@link countdownTone}) that makes "instances expire"
 *    visible while the mock is still alive, not only once it has gone;
 *  - the try-it path builder ({@link pathParameters}, {@link buildRequestPath}) that turns a
 *    templated operation (`/widgets/{widgetId}`) into a concrete request path;
 *  - the request-log presentation helpers, which state each outcome in **words** before colour.
 *
 * Everything here is pure (no React, no fetch) so it can be unit-tested directly — mirroring
 * `./exportRoundtrip.ts` beside it.
 */

import type { StatusTone } from '@/app/components/ui/statusVocabulary';

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/** `GET /api/export/mock/capability` — can this server mock, and within what bounds. */
export interface ExportMockCapability {
  /** Whether a mock can be provisioned on this server right now. */
  available: boolean;
  /** Why mocking is unavailable, or null when it is available. */
  reason: string | null;
  /** Target emitter keys whose emitted document the mock engine can serve. */
  supportedTargets: string[];
  /** TTL applied when a start names none, in minutes. */
  defaultTtlMinutes: number;
  /** Ceiling a requested TTL is clamped to, in minutes. */
  maxTtlMinutes: number;
  /** Concurrent live test-drive mocks one workspace may hold. */
  maxPerTenant: number;
  /** Per-instance request budget the mock's data plane enforces. */
  rateLimitPerMinute: number;
}

/** One operation the mock will answer — what the try-it control offers. */
export interface ExportMockOperation {
  /** Upper-case HTTP method. */
  method: string;
  /** Templated path relative to the mock base URL (e.g. `/widgets/{widgetId}`). */
  path: string;
  /** The document's `operationId`, when it declares one. */
  operationId?: string | null;
}

/** A live (or just-expired) test-drive mock instance. */
export interface ExportMockInstance {
  id: string;
  /** Stable base URL of the mock's data plane; append an operation path to it. */
  baseUrl: string;
  /** `active` while it serves, `expired` once past its TTL. */
  status: string;
  /** The resolved target format key the mock was emitted from (e.g. `openapi-3.1`). */
  target: string;
  /** The emitter *key* it was started for (`openapi`) — what the Studio holds and matches on. */
  targetKey: string;
  /** Human label of that target (e.g. `OpenAPI 3.1`). */
  targetLabel: string;
  /** The artifact (project) id the mock was provisioned from. */
  artifact: string;
  /** The revision's version label, when it has one. */
  version?: string | null;
  /** How many operations the frozen document exposes. */
  operationCount: number;
  /** The operations themselves, ordered by path then method. */
  operations: ExportMockOperation[];
  /** Selectable scenario names; one may be sent per request. */
  scenarios: string[];
  /** The scenario in force when a request names none. */
  activeScenario: string;
  /** Per-instance request budget the data plane enforces. */
  rateLimitPerMinute: number;
  /** Lifetime data-plane requests served (best-effort). */
  requestCount: number;
  createdAt?: string | null;
  expiresAt?: string | null;
  /** Seconds until auto-teardown, computed server-side; 0 once expired. */
  expiresInSeconds: number;
  lastActivityAt?: string | null;
}

/** One request the mock served, as the log panel renders it. */
export interface ExportMockRequestEntry {
  at: string;
  method: string;
  path: string;
  status: number;
  /** Whether an operation in the frozen document matched. */
  matched: boolean;
  /** The scenario in force for this request. */
  scenario: string;
  /** The matched operation key (`GET /widgets/{widgetId}`), or null when unmatched. */
  operationId?: string | null;
  /** Whether the body agreed with the response schema; null when no operation matched. */
  schemaValid?: boolean | null;
  durationMs: number;
}

/** `GET /api/export/mock/{id}/requests` — the retained log for one instance. */
export interface ExportMockRequestLog {
  mockId: string;
  /** Retained requests, newest first. */
  entries: ExportMockRequestEntry[];
  /** How many requests the log currently holds. */
  retained: number;
  /** How many the ring buffer retains before discarding the oldest. */
  capacity: number;
  /** True when the instance has served more requests than the log still holds. */
  truncated: boolean;
}

/** `POST /api/export/mock/{id}/try` — the outcome of one try-it request. */
export interface ExportMockTryResult {
  /** What was sent (echoed so a result can outlive the form that produced it). */
  request: { method: string; path: string; url: string };
  /** The status the mock answered with. */
  status: number;
  /** Round-trip time measured at the proxy, in milliseconds. */
  durationMs: number;
  /** The mock's own evidence headers (`x-mock-scenario`, `x-mock-schema-valid`, …). */
  headers: Record<string, string>;
  /** The response body as text. */
  body: string;
  /** True when the body was clipped for display. */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Capability
// ---------------------------------------------------------------------------

/**
 * Does this target get a Test-drive mock panel at all?
 *
 * Answered purely from the server's `supportedTargets`, which the emitter registry derives — so
 * a newly registered OpenAPI-family emitter becomes mockable with no change here, and a target
 * the engine cannot serve never renders a control that would only fail.
 *
 * @param capability The server's capability report, or null while it is still loading.
 * @param targetKey The chosen target's emitter key (e.g. `openapi`).
 * @returns True when this server would accept a mock of that target.
 */
export function mockSupportsTarget(
  capability: ExportMockCapability | null,
  targetKey: string | null | undefined,
): boolean {
  if (!capability || !targetKey) return false;
  return capability.supportedTargets.includes(targetKey);
}

/** How the Studio should treat the mock tool for the current target. */
export type MockAvailability =
  /** Render the panel: this server can mock, and this target is mockable. */
  | { kind: 'available' }
  /** Render nothing: the target is not one the mock engine can serve. */
  | { kind: 'hidden' }
  /** Render the panel disabled, carrying the server's own reason. */
  | { kind: 'disabled'; reason: string }
  /** Nothing decided yet — the capability call is still in flight. */
  | { kind: 'pending' };

/** The sentence shown when the server reports no reason of its own. */
const GENERIC_UNAVAILABLE = 'Mock infrastructure is not available on this server.';

/**
 * Resolve the ticket's "absent infra degrades to hidden/disabled" rule into one outcome.
 *
 * The two halves are deliberately different: a **target** the engine cannot serve is *hidden*
 * (there is nothing to say — a proto bundle is simply not a mockable thing), while a **server**
 * without mock infrastructure is *disabled with the reason*, because the user might otherwise
 * assume the feature does not exist rather than that this deployment lacks it.
 *
 * @param capability The server's capability report, or null while it is loading.
 * @param targetKey The chosen target's emitter key.
 * @param loading Whether the capability call is still in flight.
 * @returns What to render for the mock tool.
 */
export function mockAvailabilityNotice(
  capability: ExportMockCapability | null,
  targetKey: string | null | undefined,
  loading: boolean,
): MockAvailability {
  if (loading && !capability) return { kind: 'pending' };
  // A capability that never arrived is treated as "no infrastructure", not as available — the
  // panel must never offer a Start button it has no reason to believe will work.
  if (!capability) return { kind: 'disabled', reason: GENERIC_UNAVAILABLE };
  if (!capability.available) {
    return { kind: 'disabled', reason: capability.reason || GENERIC_UNAVAILABLE };
  }
  if (!mockSupportsTarget(capability, targetKey)) return { kind: 'hidden' };
  return { kind: 'available' };
}

// ---------------------------------------------------------------------------
// The countdown
// ---------------------------------------------------------------------------

/** Below this many seconds remaining, the countdown reads as urgent. */
export const COUNTDOWN_DANGER_SECONDS = 60;

/** Below this many seconds remaining, the countdown reads as a warning. */
export const COUNTDOWN_WARN_SECONDS = 300;

/**
 * Render a remaining-seconds count as a clock the panel can show ticking.
 *
 * @param seconds Whole seconds remaining (negatives and non-finite values read as expired).
 * @returns `1:02:03` past an hour, `29:41` under one, and `Expired` at zero.
 */
export function formatCountdown(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'Expired';
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

/**
 * The tone the countdown carries as the mock approaches its auto-teardown.
 *
 * Colour is the second signal only: the panel always prints the clock (and `Expired`) as words
 * beside it, so the state survives a monochrome or colour-blind reading.
 *
 * @param seconds Whole seconds remaining.
 * @returns `danger` under a minute, `warn` under five, `ok` above that.
 */
export function countdownTone(seconds: number): StatusTone {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'danger';
  if (seconds <= COUNTDOWN_DANGER_SECONDS) return 'danger';
  if (seconds <= COUNTDOWN_WARN_SECONDS) return 'warn';
  return 'ok';
}

/**
 * Is this instance still serving?
 *
 * @param instance The instance, or null when none is running.
 * @returns True only for a non-expired instance with time left on the clock.
 */
export function mockIsLive(instance: ExportMockInstance | null): boolean {
  return Boolean(instance && instance.status !== 'expired' && instance.expiresInSeconds > 0);
}

// ---------------------------------------------------------------------------
// The try-it request
// ---------------------------------------------------------------------------

/** Matches one `{name}` placeholder in an OpenAPI path template. */
const PATH_PARAM_PATTERN = /\{([^{}/]+)\}/g;

/**
 * The path parameters a templated operation path declares, in the order they appear.
 *
 * @param pathTemplate A templated path (e.g. `/tenants/{tenantId}/widgets/{widgetId}`).
 * @returns The placeholder names (`['tenantId', 'widgetId']`); empty for a static path.
 */
export function pathParameters(pathTemplate: string): string[] {
  const names: string[] = [];
  for (const match of (pathTemplate || '').matchAll(PATH_PARAM_PATTERN)) {
    if (match[1] && !names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

/**
 * Substitute path-parameter values into a templated operation path.
 *
 * A parameter the user left blank keeps a usable stand-in (`1`) rather than sending a literal
 * `{widgetId}`, so a one-click try-it works on a path with parameters without a form-filling
 * detour. Values are percent-encoded, so a value containing `/` cannot invent a path segment.
 *
 * @param pathTemplate The templated path.
 * @param values Parameter values by placeholder name.
 * @returns A concrete request path, always beginning with `/`.
 */
export function buildRequestPath(
  pathTemplate: string,
  values: Record<string, string> = {},
): string {
  const filled = (pathTemplate || '/').replace(PATH_PARAM_PATTERN, (_whole, name: string) => {
    const raw = (values[name] ?? '').trim();
    return encodeURIComponent(raw || '1');
  });
  return filled.startsWith('/') ? filled : `/${filled}`;
}

/**
 * A stable identity for one operation — the try-it list's React key and selection value.
 *
 * @param operation The operation.
 * @returns `METHOD path`, the same key shape the mock's request log reports.
 */
export function operationKey(operation: ExportMockOperation): string {
  return `${operation.method} ${operation.path}`;
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/**
 * The tone for one served request's status code.
 *
 * @param status The HTTP status the mock answered with.
 * @returns `ok` for 2xx, `warn` for 3xx/4xx, `danger` for 5xx and anything unrecognised.
 */
export function statusTone(status: number): StatusTone {
  if (status >= 200 && status < 300) return 'ok';
  if (status >= 300 && status < 500) return 'warn';
  return 'danger';
}

/**
 * What one log row says about the response, in words.
 *
 * The schema verdict is the point of the panel — a mock that answers 200 with a body its own
 * document does not describe has failed the test drive — so it is stated, not implied by a hue.
 *
 * @param entry The log entry.
 * @returns A short sentence fragment: the match + schema outcome.
 */
export function requestOutcomeLabel(entry: ExportMockRequestEntry): string {
  if (!entry.matched) return 'No operation matched';
  if (entry.schemaValid === false) return 'Body did not match the schema';
  if (entry.schemaValid === true) return 'Schema-shaped response';
  return 'Matched';
}

/**
 * The tone for one log row's outcome, paired with {@link requestOutcomeLabel}.
 *
 * @param entry The log entry.
 * @returns `ok` for a schema-shaped match, `warn` for an unmatched request, `danger` for a body
 *   that drifted from the schema it claims to satisfy.
 */
export function requestOutcomeTone(entry: ExportMockRequestEntry): StatusTone {
  if (!entry.matched) return 'warn';
  if (entry.schemaValid === false) return 'danger';
  return 'ok';
}

/**
 * Render a log entry's timestamp as a clock time for the panel's leading column.
 *
 * @param iso The ISO-8601 timestamp.
 * @returns A locale time (`14:22:07`), or the raw value when it cannot be parsed.
 */
export function formatLogTime(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * Summarize a running mock in one line for screen readers and the panel's subtitle.
 *
 * @param instance The instance.
 * @returns A sentence naming the target, the operation count and the time remaining.
 */
export function describeMockInstance(instance: ExportMockInstance): string {
  const operations = `${instance.operationCount} operation${instance.operationCount === 1 ? '' : 's'}`;
  if (!mockIsLive(instance)) {
    return `${instance.targetLabel} mock (${operations}) — expired.`;
  }
  return `${instance.targetLabel} mock (${operations}) — expires in ${formatCountdown(
    instance.expiresInSeconds,
  )}.`;
}
