/**
 * The access-audit transport — HIVE-5.5 (#5308).
 *
 * Two calls, both against the shared `/api/access/*` proxy that HIVE-5.3 settled on: one read
 * of the ledger, and the URL the CSV export downloads from. The envelope unwrapping lives in
 * {@link ../access/accessApi}, so the stable machine `code` a refused read carries is not
 * dropped by a second copy of it here.
 */

import { accessApi } from '../access/accessApi';
import { auditRangeStart, type AuditEvent, type AuditRange } from './auditModel';

/**
 * How many entries one read asks for.
 *
 * The server's ceiling, and the same number `/audit/export` uses — so what the table holds
 * and what the CSV contains are the same rows, which is what makes "the export round-trips
 * the filter set" true rather than approximately true.
 */
export const AUDIT_READ_LIMIT = 1000;

/** What narrows a read of the ledger. */
export interface AuditQuery {
  /** The date range the reader chose. */
  range: AuditRange;
  /** The moment the range is measured back from. */
  now: Date;
}

/**
 * The query string both the read and the export are built from.
 *
 * @param query The narrowing.
 * @param extra Parameters only one of the two takes — the export's `filter`.
 * @returns `URLSearchParams`, with `since` present only for a bounded range.
 */
function auditParams(query: AuditQuery, extra: Record<string, string> = {}): URLSearchParams {
  const params = new URLSearchParams(extra);
  const since = auditRangeStart(query.range, query.now);
  if (since) params.set('since', since.toISOString());
  return params;
}

/**
 * Read the tenant's access ledger.
 *
 * Always asks for `filter=all`: the six categories are partitioned in the browser so every
 * chip can carry a count, which a narrowed response cannot support. See the note at the top
 * of {@link ./auditModel}.
 *
 * @param query The date range and the moment to measure it from.
 * @returns The entries, newest first.
 * @throws Error carrying the server's message when the read is refused.
 */
export async function fetchAuditEvents(query: AuditQuery): Promise<AuditEvent[]> {
  const params = auditParams(query, { filter: 'all', limit: String(AUDIT_READ_LIMIT) });
  return (await accessApi<AuditEvent[]>(`audit?${params.toString()}`)) ?? [];
}

/**
 * Where the CSV export downloads from.
 *
 * Carries the category and the date range so the file holds the rows the reader was looking
 * at. The free-text search is deliberately *not* sent: the endpoint has no such parameter,
 * and an export that silently ignored it would be a file that disagrees with the screen.
 * `AuditClient` says so beside the button whenever a search is active.
 *
 * @param filter The chosen category, as the server spells it (`all`, `role`, … `styleGuide`).
 * @param query The date range and the moment to measure it from.
 * @returns The href to navigate to.
 */
export function auditExportHref(filter: string, query: AuditQuery): string {
  const params = auditParams(query, { filter });
  return `/api/access/audit/export?${params.toString()}`;
}
