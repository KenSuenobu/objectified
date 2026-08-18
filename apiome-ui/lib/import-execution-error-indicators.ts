/**
 * Error indicator helpers for the import execution panel (#731, #732).
 *
 * Re-pointed by HIVE-6.4 (#5315): these used to return Tailwind palette class strings
 * (`bg-red-50 dark:bg-red-950/30`) — four colours the design system does not have names for,
 * chosen in TypeScript where no stylesheet and no theme could reach them. What a helper can
 * usefully decide is the event's *severity*, so that is all {@link importEventLevel} returns;
 * the log line and the checklist row carry it as `data-level` and `globals.css` §IMPORT WIZARD
 * paints it, once, in tokens that follow all nine themes.
 */

export type LogLevel = 'info' | 'warn' | 'error';

export interface ImportEventLike {
  id: string;
  ts: number;
  level: LogLevel;
  code: string;
  message: string;
  context?: unknown;
}

/**
 * The severity a row is drawn at.
 *
 * `skipped` is not a `LogLevel` — the server reports a skip as a warning, and it is the *code*
 * that makes it deliberate rather than concerning. Keeping it distinct here is what lets a
 * skipped property read as quiet grey while a real warning stays amber.
 */
export type ImportEventDisplayLevel = 'info' | 'warn' | 'error' | 'skipped';

/** Event codes that represent intentionally skipped items (#732). */
const SKIPPED_EVENT_CODES = new Set(['SKIP_PROPERTY', 'SKIP_CHILDREN']);

/** Whether this event represents an intentionally skipped item (grey indicator). */
export function isSkippedEvent(ev: ImportEventLike): boolean {
  return SKIPPED_EVENT_CODES.has(ev.code);
}

/**
 * The severity to draw an event at.
 *
 * @param evOrLevel The event, or a bare level for callers that have nothing else (a bare level
 *   can never be `skipped`, because only a code makes a skip deliberate).
 * @returns The `data-level` value.
 */
export function importEventLevel(
  evOrLevel: ImportEventLike | LogLevel
): ImportEventDisplayLevel {
  if (typeof evOrLevel === 'string') return evOrLevel;
  return isSkippedEvent(evOrLevel) ? 'skipped' : evOrLevel.level;
}

/** Filter events to error level only (for the Failures section). */
export function getErrorEvents(events: ImportEventLike[]): ImportEventLike[] {
  return events.filter((ev) => ev.level === 'error');
}

/** Format event context for display (string as-is, object as JSON). */
export function formatEventContext(context: unknown): string {
  if (context == null) return '';
  return typeof context === 'string' ? context : JSON.stringify(context, null, 2);
}

/** Whether the Failures section should be shown (has any error events). */
export function shouldShowFailuresSection(events: ImportEventLike[]): boolean {
  return getErrorEvents(events).length > 0;
}
