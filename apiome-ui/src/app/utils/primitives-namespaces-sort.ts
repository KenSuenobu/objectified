/**
 * Client-side sort for the Primitives dashboard's "Type collections" panel.
 *
 * The panel is not a list of one thing: it renders registered `apiome.type_namespaces` rows
 * alongside two synthetic rows — namespaces types use but nobody registered, and the bucket for
 * types with no namespace at all. Sorting therefore cannot run over the collection array; it runs
 * over a flattened row model ({@link NamespaceCollectionSortRow}) the panel builds for all three
 * kinds, so a click on "Types" orders the unregistered rows against the registered ones instead of
 * leaving them pinned to the bottom.
 *
 * The toggle is a pure function for the reason `catalog-dashboard-sort.ts` records: computing the
 * next direction inside a nested `setState` updater double-applies under StrictMode and the flip
 * cancels itself out.
 */

export type NamespaceCollectionSortColumn = 'namespace' | 'scope' | 'types' | 'draft' | 'status';

export type NamespaceCollectionSortDirection = 'asc' | 'desc';

/** An active sort selection, or `null` for the panel's unsorted default order. */
export interface NamespaceCollectionSortState {
  column: NamespaceCollectionSortColumn | null;
  direction: NamespaceCollectionSortDirection;
}

/** Which of the panel's three row flavours a row is. */
export type NamespaceCollectionRowKind = 'registered' | 'detected' | 'unassigned';

/** The fields the sorter reads; the panel carries its render payload alongside them. */
export interface NamespaceCollectionSortRow {
  /** React key — also the final tiebreaker, so the rendered order is always deterministic. */
  key: string;
  kind: NamespaceCollectionRowKind;
  /** The text the Namespace cell shows, which is what sorting that column must follow. */
  sortName: string;
  /** `null` for the synthetic rows: they describe types, not collections, and have no scope. */
  scope: 'system' | 'tenant' | null;
  typeCount: number;
  draft: string;
  unresolvedCount: number;
}

/**
 * The sort state a click on `clicked` should produce: re-selecting the active column reverses the
 * direction, any other column starts ascending.
 */
export function nextNamespaceCollectionSort(
  current: NamespaceCollectionSortState,
  clicked: NamespaceCollectionSortColumn,
): NamespaceCollectionSortState {
  if (current.column === clicked) {
    return { column: clicked, direction: current.direction === 'asc' ? 'desc' : 'asc' };
  }
  return { column: clicked, direction: 'asc' };
}

/** Registered collections first, then unregistered namespaces, then the unassigned bucket. */
function kindRank(kind: NamespaceCollectionRowKind): number {
  if (kind === 'registered') return 0;
  return kind === 'detected' ? 1 : 2;
}

/** System before tenant, and the scopeless synthetic rows after both. */
function scopeRank(scope: 'system' | 'tenant' | null): number {
  if (scope === 'system') return 0;
  return scope === 'tenant' ? 1 : 2;
}

/**
 * Applied after every primary comparison and deliberately **not** flipped by the direction: it only
 * breaks genuine ties, so reversing a column never scrambles rows that column cannot distinguish.
 * That is what keeps a constant-valued column (today's hardcoded `draft`) from appearing to shuffle.
 */
function compareTiebreak(a: NamespaceCollectionSortRow, b: NamespaceCollectionSortRow): number {
  const kindDiff = kindRank(a.kind) - kindRank(b.kind);
  if (kindDiff !== 0) return kindDiff;
  const nameDiff = a.sortName.localeCompare(b.sortName, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
  if (nameDiff !== 0) return nameDiff;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** Namespaces are slash-delimited paths, so compare them numerically-aware and case-insensitively. */
function comparePaths(a: string, b: string): number {
  return a.trim().localeCompare(b.trim(), undefined, { numeric: true, sensitivity: 'base' });
}

export function compareNamespaceCollectionRows(
  a: NamespaceCollectionSortRow,
  b: NamespaceCollectionSortRow,
  column: NamespaceCollectionSortColumn,
  direction: NamespaceCollectionSortDirection,
): number {
  const dir: 1 | -1 = direction === 'asc' ? 1 : -1;

  let primary = 0;
  switch (column) {
    case 'namespace':
      primary = comparePaths(a.sortName, b.sortName);
      break;
    case 'scope':
      primary = scopeRank(a.scope) - scopeRank(b.scope);
      break;
    case 'types':
      primary = a.typeCount - b.typeCount;
      break;
    case 'draft':
      primary = comparePaths(a.draft, b.draft);
      break;
    case 'status':
      // The Status cell is "Resolved" at 0 and "N unresolved" above it, so the count *is* the
      // ordering the column shows: ascending puts the clean namespaces first.
      primary = a.unresolvedCount - b.unresolvedCount;
      break;
    default:
      primary = 0;
  }

  if (primary !== 0) return primary < 0 ? -dir : dir;
  return compareTiebreak(a, b);
}

/** Sorts a copy; `column: null` keeps the panel's incoming order untouched. */
export function sortNamespaceCollectionRows<T extends NamespaceCollectionSortRow>(
  rows: readonly T[],
  column: NamespaceCollectionSortColumn | null,
  direction: NamespaceCollectionSortDirection,
): T[] {
  if (!column) return [...rows];
  return [...rows].sort((a, b) => compareNamespaceCollectionRows(a, b, column, direction));
}
