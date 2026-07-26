/**
 * Client-side sort for the tenant Catalog dashboard (MFI-23.3, #4012).
 *
 * The Catalog screen is cloned from the Projects dashboard, so this mirrors
 * `projects-dashboard-sort.ts` — but a catalog item carries its quality score/grade and its
 * imported source format directly (the REST `CatalogItemSchema` projection, MFI-23.2), so the
 * sorter reads them off the row instead of taking an external quality map. It also adds the
 * catalog-only `grade` and `format` sort columns the issue calls for.
 *
 * Every column the table view renders is sortable from its header, so `protocol` and `source` live
 * here too — `source` resolving the same display label the Source badge shows, via the shared
 * {@link resolveCatalogSource}, so the order always matches the column the user clicked.
 */

import { resolveCatalogSource } from './catalog-format-registry';

export type CatalogDashboardSortColumn =
  | 'name'
  | 'description'
  | 'quality'
  | 'grade'
  | 'format'
  | 'protocol'
  | 'source'
  | 'status'
  | 'creator'
  | 'created'
  | 'updated';

export type CatalogDashboardSortDirection = 'asc' | 'desc';

/** An active sort selection: which column, and which way. */
export interface CatalogDashboardSortState {
  column: CatalogDashboardSortColumn;
  direction: CatalogDashboardSortDirection;
}

/**
 * The sort state a click on `clicked` should produce: re-selecting the active column **reverses**
 * the direction, and selecting a different column starts it ascending.
 *
 * Pure and total, so the toggle is unit-testable without standing up the dashboard — and so the
 * screen's click handler stays a plain "compute next, set both", never a `setState` call nested
 * inside another `setState` updater. That nesting is what previously pinned the direction: React
 * invokes updaters twice under StrictMode (and the React Compiler may re-run them), so the flip
 * was queued twice and cancelled itself out.
 *
 * @param current The active column + direction.
 * @param clicked The column whose header (or sort chip) was clicked.
 * @returns The next sort state.
 */
export function nextCatalogDashboardSort(
  current: CatalogDashboardSortState,
  clicked: CatalogDashboardSortColumn,
): CatalogDashboardSortState {
  if (current.column === clicked) {
    return { column: clicked, direction: current.direction === 'asc' ? 'desc' : 'asc' };
  }
  return { column: clicked, direction: 'asc' };
}

/** Minimal catalog-item row shape used by the sorter. */
export type CatalogSortRow = {
  id: string;
  name: string;
  description?: string | null;
  enabled: boolean;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  creator_name?: string | null;
  creator_email?: string | null;
  metadata?: (Record<string, unknown> & { summary?: string }) | null;
  /** Loose provenance bag the source badge is resolved from (preferred over `metadata`). */
  formatMetadata?: Record<string, unknown> | null;
  slug?: string | null;
  /** Captured lint score/grade of the catalog item's latest revision (camelCase from REST). */
  qualityScore?: number | null;
  qualityGrade?: string | null;
  /** Imported-file format + paradigm/protocol read off the latest revision (MFI-7.1/7.2). */
  sourceFormat?: string | null;
  protocol?: string | null;
};

function statusTier(row: CatalogSortRow): number {
  if (row.deleted_at) return 2;
  if (!row.enabled) return 1;
  return 0;
}

function compareStringsCaseInsensitive(a: string, b: string, dir: 1 | -1): number {
  const ac = a.trim().toLowerCase();
  const bc = b.trim().toLowerCase();
  if (ac === bc) return 0;
  return ac < bc ? -dir : dir;
}

/**
 * Compare two catalog rows for a single column/direction.
 *
 * Missing values (null score, blank grade/format) always sort to the end regardless of direction,
 * matching the Projects sorter's "unknowns last" behaviour.
 */
export function compareCatalogDashboardRows(
  a: CatalogSortRow,
  b: CatalogSortRow,
  column: CatalogDashboardSortColumn,
  direction: CatalogDashboardSortDirection
): number {
  const dir: 1 | -1 = direction === 'asc' ? 1 : -1;

  switch (column) {
    case 'name': {
      const c = compareStringsCaseInsensitive(a.name, b.name, dir);
      if (c !== 0) return c;
      return compareStringsCaseInsensitive(a.slug ?? '', b.slug ?? '', dir);
    }
    case 'description': {
      const at = `${a.description ?? ''} ${a.metadata?.summary ?? ''}`.trim();
      const bt = `${b.description ?? ''} ${b.metadata?.summary ?? ''}`.trim();
      return compareStringsCaseInsensitive(at, bt, dir);
    }
    case 'quality': {
      const av = a.qualityScore;
      const bv = b.qualityScore;
      const aNull = av == null || Number.isNaN(av);
      const bNull = bv == null || Number.isNaN(bv);
      if (aNull && bNull) return 0;
      if (aNull) return 1;
      if (bNull) return -1;
      if (av === bv) return 0;
      return (av as number) < (bv as number) ? -dir : dir;
    }
    case 'grade': {
      const ag = (a.qualityGrade ?? '').trim();
      const bg = (b.qualityGrade ?? '').trim();
      const aNull = ag === '';
      const bNull = bg === '';
      if (aNull && bNull) return 0;
      if (aNull) return 1;
      if (bNull) return -1;
      // Letter grades sort alphabetically (A best) — ascending puts the best grade first.
      return compareStringsCaseInsensitive(ag, bg, dir);
    }
    case 'format': {
      const af = (a.sourceFormat ?? '').trim();
      const bf = (b.sourceFormat ?? '').trim();
      const aNull = af === '';
      const bNull = bf === '';
      if (aNull && bNull) {
        // Both formats unknown — fall back to protocol so rows still order deterministically.
        return compareStringsCaseInsensitive(a.protocol ?? '', b.protocol ?? '', dir);
      }
      if (aNull) return 1;
      if (bNull) return -1;
      const c = compareStringsCaseInsensitive(af, bf, dir);
      if (c !== 0) return c;
      return compareStringsCaseInsensitive(a.protocol ?? '', b.protocol ?? '', dir);
    }
    case 'protocol': {
      const ap = (a.protocol ?? '').trim();
      const bp = (b.protocol ?? '').trim();
      if (ap === '' && bp === '') return 0;
      if (ap === '') return 1;
      if (bp === '') return -1;
      const c = compareStringsCaseInsensitive(ap, bp, dir);
      if (c !== 0) return c;
      return compareStringsCaseInsensitive(a.name, b.name, dir);
    }
    case 'source': {
      // Sorts on the badge's *displayed* label (file name / compacted URL / "Live discovery"), so
      // the order matches the Source column the user is looking at rather than the raw bag keys.
      const as = (resolveCatalogSource(a.formatMetadata, a.metadata)?.label ?? '').trim();
      const bs = (resolveCatalogSource(b.formatMetadata, b.metadata)?.label ?? '').trim();
      if (as === '' && bs === '') return 0;
      if (as === '') return 1;
      if (bs === '') return -1;
      const c = compareStringsCaseInsensitive(as, bs, dir);
      if (c !== 0) return c;
      return compareStringsCaseInsensitive(a.name, b.name, dir);
    }
    case 'status': {
      const ta = statusTier(a);
      const tb = statusTier(b);
      if (ta !== tb) return ta < tb ? -dir : dir;
      return compareStringsCaseInsensitive(a.name, b.name, dir);
    }
    case 'creator': {
      const c = compareStringsCaseInsensitive(a.creator_name ?? '', b.creator_name ?? '', dir);
      if (c !== 0) return c;
      return compareStringsCaseInsensitive(a.creator_email ?? '', b.creator_email ?? '', dir);
    }
    case 'created': {
      const ta = Date.parse(a.created_at);
      const tb = Date.parse(b.created_at);
      const aOk = Number.isFinite(ta);
      const bOk = Number.isFinite(tb);
      if (!aOk && !bOk) return 0;
      if (!aOk) return 1;
      if (!bOk) return -1;
      if (ta === tb) return 0;
      return ta < tb ? -dir : dir;
    }
    case 'updated': {
      const ta = Date.parse(a.updated_at);
      const tb = Date.parse(b.updated_at);
      const aOk = Number.isFinite(ta);
      const bOk = Number.isFinite(tb);
      if (!aOk && !bOk) return 0;
      if (!aOk) return 1;
      if (!bOk) return -1;
      if (ta === tb) return 0;
      return ta < tb ? -dir : dir;
    }
    default:
      return 0;
  }
}

/**
 * Stable, non-mutating sort of catalog rows.
 *
 * @param items    Catalog items to sort (not mutated).
 * @param column   Active sort column, or null to leave order untouched.
 * @param direction Sort direction.
 * @returns A new, sorted array.
 */
export function sortCatalogDashboardRows<T extends CatalogSortRow>(
  items: readonly T[],
  column: CatalogDashboardSortColumn | null,
  direction: CatalogDashboardSortDirection
): T[] {
  if (!column) return [...items];
  return [...items].sort((a, b) => compareCatalogDashboardRows(a, b, column, direction));
}
