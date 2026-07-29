import {
  compareNamespaceCollectionRows,
  nextNamespaceCollectionSort,
  sortNamespaceCollectionRows,
  type NamespaceCollectionSortRow,
} from '@/app/utils/primitives-namespaces-sort';

const row = (over: Partial<NamespaceCollectionSortRow>): NamespaceCollectionSortRow => ({
  key: over.key ?? 'ns-1',
  kind: over.kind ?? 'registered',
  sortName: over.sortName ?? 'std/v0/types',
  scope: over.scope ?? 'tenant',
  typeCount: over.typeCount ?? 0,
  draft: over.draft ?? '2020-12',
  unresolvedCount: over.unresolvedCount ?? 0,
});

describe('nextNamespaceCollectionSort', () => {
  it('starts a newly clicked column ascending', () => {
    expect(nextNamespaceCollectionSort({ column: null, direction: 'asc' }, 'types')).toEqual({
      column: 'types',
      direction: 'asc',
    });
    expect(nextNamespaceCollectionSort({ column: 'namespace', direction: 'desc' }, 'types')).toEqual({
      column: 'types',
      direction: 'asc',
    });
  });

  it('reverses the direction when the active column is clicked again', () => {
    const asc = nextNamespaceCollectionSort({ column: null, direction: 'asc' }, 'namespace');
    const desc = nextNamespaceCollectionSort(asc, 'namespace');
    expect(desc).toEqual({ column: 'namespace', direction: 'desc' });
    expect(nextNamespaceCollectionSort(desc, 'namespace')).toEqual({
      column: 'namespace',
      direction: 'asc',
    });
  });
});

describe('compareNamespaceCollectionRows', () => {
  it('orders namespaces case-insensitively and numerically-aware', () => {
    const v2 = row({ key: 'a', sortName: 'tenant/v2/types' });
    const v10 = row({ key: 'b', sortName: 'tenant/v10/types' });
    expect(compareNamespaceCollectionRows(v2, v10, 'namespace', 'asc')).toBeLessThan(0);
    expect(compareNamespaceCollectionRows(v2, v10, 'namespace', 'desc')).toBeGreaterThan(0);

    const upper = row({ key: 'c', sortName: 'Alpha/types' });
    const lower = row({ key: 'd', sortName: 'beta/types' });
    expect(compareNamespaceCollectionRows(upper, lower, 'namespace', 'asc')).toBeLessThan(0);
  });

  it('orders scope system, then tenant, then the scopeless synthetic rows', () => {
    const system = row({ key: 'a', scope: 'system' });
    const tenant = row({ key: 'b', scope: 'tenant' });
    const none = row({ key: 'c', scope: null, kind: 'detected' });
    expect(compareNamespaceCollectionRows(system, tenant, 'scope', 'asc')).toBeLessThan(0);
    expect(compareNamespaceCollectionRows(tenant, none, 'scope', 'asc')).toBeLessThan(0);
    expect(compareNamespaceCollectionRows(system, none, 'scope', 'desc')).toBeGreaterThan(0);
  });

  it('orders the type count numerically, not as text', () => {
    const nine = row({ key: 'a', typeCount: 9 });
    const forty = row({ key: 'b', typeCount: 40 });
    expect(compareNamespaceCollectionRows(nine, forty, 'types', 'asc')).toBeLessThan(0);
    expect(compareNamespaceCollectionRows(nine, forty, 'types', 'desc')).toBeGreaterThan(0);
  });

  it('orders status by unresolved count, resolved first ascending', () => {
    const resolved = row({ key: 'a', unresolvedCount: 0 });
    const broken = row({ key: 'b', unresolvedCount: 3 });
    expect(compareNamespaceCollectionRows(resolved, broken, 'status', 'asc')).toBeLessThan(0);
    expect(compareNamespaceCollectionRows(resolved, broken, 'status', 'desc')).toBeGreaterThan(0);
  });

  it('breaks ties by row kind then name, in the same direction either way', () => {
    // Every draft is the same value today, so the column cannot distinguish these rows; the tie
    // must not flip with the direction or the table would appear to shuffle on a second click.
    const registered = row({ key: 'a', kind: 'registered', sortName: 'zeta' });
    const detected = row({ key: 'b', kind: 'detected', sortName: 'alpha' });
    expect(compareNamespaceCollectionRows(registered, detected, 'draft', 'asc')).toBeLessThan(0);
    expect(compareNamespaceCollectionRows(registered, detected, 'draft', 'desc')).toBeLessThan(0);
  });
});

describe('sortNamespaceCollectionRows', () => {
  const rows = [
    row({ key: 'a', sortName: 'std/v0/types', typeCount: 9, scope: 'system' }),
    row({ key: 'b', sortName: 'tenant/v1/types', typeCount: 2 }),
    row({ key: 'c', sortName: 'imported/v1/types', typeCount: 40, kind: 'detected', scope: null }),
  ];

  it('leaves the incoming order alone when no column is selected', () => {
    expect(sortNamespaceCollectionRows(rows, null, 'asc').map((r) => r.key)).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate the array it was given', () => {
    sortNamespaceCollectionRows(rows, 'types', 'desc');
    expect(rows.map((r) => r.key)).toEqual(['a', 'b', 'c']);
  });

  it('interleaves synthetic rows with registered ones instead of pinning them last', () => {
    expect(sortNamespaceCollectionRows(rows, 'types', 'desc').map((r) => r.key)).toEqual([
      'c',
      'a',
      'b',
    ]);
    expect(sortNamespaceCollectionRows(rows, 'namespace', 'asc').map((r) => r.key)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });
});
