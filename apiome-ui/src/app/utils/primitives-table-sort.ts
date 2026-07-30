/**
 * Client-side sort for the primitives (types) list on the Primitives dashboard.
 *
 * The list was fixed at name-ascending (`sortByName`), so a reader could not ask "what is used
 * most?" or "which types have no namespace?" without scanning. Every column the table renders is
 * sortable from its header except Actions, which holds controls rather than data.
 *
 * Two conventions, both deliberate and both pinned by tests:
 *
 * * **Blanks last, in either direction.** A missing namespace or description is absent data, not a
 *   value that sorts before "a" — so those rows stay at the bottom whichever way the column is
 *   sorted, keeping the populated rows adjacent. (Same rule `versions-dashboard-sort.ts` applies to
 *   unparseable dates.)
 * * **The tiebreak is never reversed.** It falls back to name then id in ascending order always, so
 *   clicking a low-cardinality column (Type, Category) a second time does not scramble the rows that
 *   column cannot distinguish.
 *
 * The toggle is a pure function for the reason `catalog-dashboard-sort.ts` records: computing the
 * next direction inside a nested `setState` updater double-applies under StrictMode and the flip
 * cancels itself out.
 */

export type PrimitivesTableSortColumn =
  | 'name'
  | 'namespace'
  | 'category'
  | 'description'
  | 'usage'
  | 'type';

export type PrimitivesTableSortDirection = 'asc' | 'desc';

/** An active sort selection: which column, and which way. */
export interface PrimitivesTableSortState {
  column: PrimitivesTableSortColumn;
  direction: PrimitivesTableSortDirection;
}

/** The list's opening order, which is what it always had: by name, A→Z. */
export const DEFAULT_PRIMITIVES_TABLE_SORT: PrimitivesTableSortState = {
  column: 'name',
  direction: 'asc',
};

/** The fields the sorter reads off a primitive row. */
export interface PrimitiveSortRow {
  id: string;
  name: string;
  namespace?: string | null;
  category: string;
  description: string | null;
  usage_count: number;
  is_system: boolean;
}

/** Display label per sortable column, for the header and any sort chip. */
export const PRIMITIVES_TABLE_SORT_LABELS: Record<PrimitivesTableSortColumn, string> = {
  name: 'Name',
  namespace: 'Namespace',
  category: 'Category',
  description: 'Description',
  usage: 'Usage',
  type: 'Type',
};

/**
 * The sort state a click on `clicked` should produce: re-selecting the active column reverses the
 * direction, any other column starts ascending.
 */
export function nextPrimitivesTableSort(
  current: PrimitivesTableSortState,
  clicked: PrimitivesTableSortColumn,
): PrimitivesTableSortState {
  if (current.column === clicked) {
    return { column: clicked, direction: current.direction === 'asc' ? 'desc' : 'asc' };
  }
  return { column: clicked, direction: 'asc' };
}

function text(value: string | null | undefined): string {
  return (value ?? '').trim();
}

/** Case-insensitive, numeric-aware compare so `v2` precedes `v10`. */
function compareText(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Compare two rows on a column whose value may be blank, returning the direction-independent
 * "blanks last" answer when exactly one side is empty.
 */
function compareOptionalText(a: string, b: string): { settled: number } | { primary: number } {
  if (!a && !b) return { primary: 0 };
  if (!a) return { settled: 1 };
  if (!b) return { settled: -1 };
  return { primary: compareText(a, b) };
}

/** System types before tenant types when ascending. */
function typeRank(row: PrimitiveSortRow): number {
  return row.is_system ? 0 : 1;
}

/**
 * Applied after every primary comparison and deliberately not flipped by the direction — it only
 * breaks genuine ties.
 */
function compareTiebreak(a: PrimitiveSortRow, b: PrimitiveSortRow): number {
  const byName = compareText(text(a.name), text(b.name));
  if (byName !== 0) return byName;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function comparePrimitivesTableRows(
  a: PrimitiveSortRow,
  b: PrimitiveSortRow,
  column: PrimitivesTableSortColumn,
  direction: PrimitivesTableSortDirection,
): number {
  const dir: 1 | -1 = direction === 'asc' ? 1 : -1;
  let primary = 0;

  switch (column) {
    case 'name':
      primary = compareText(text(a.name), text(b.name));
      break;
    case 'namespace':
    case 'description': {
      const field = column === 'namespace' ? 'namespace' : 'description';
      const result = compareOptionalText(text(a[field]), text(b[field]));
      // A blank/populated split is answered outright: it must not flip with the direction.
      if ('settled' in result) return result.settled;
      primary = result.primary;
      break;
    }
    case 'category':
      primary = compareText(text(a.category), text(b.category));
      break;
    case 'usage':
      primary = a.usage_count - b.usage_count;
      break;
    case 'type':
      primary = typeRank(a) - typeRank(b);
      break;
    default:
      primary = 0;
  }

  if (primary !== 0) return primary < 0 ? -dir : dir;
  return compareTiebreak(a, b);
}

/** Sorts a copy of `rows`; never mutates the array it is given. */
export function sortPrimitivesTableRows<T extends PrimitiveSortRow>(
  rows: readonly T[],
  column: PrimitivesTableSortColumn,
  direction: PrimitivesTableSortDirection,
): T[] {
  return [...rows].sort((a, b) => comparePrimitivesTableRows(a, b, column, direction));
}
