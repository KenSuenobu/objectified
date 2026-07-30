import {
  DEFAULT_PRIMITIVES_TABLE_SORT,
  comparePrimitivesTableRows,
  nextPrimitivesTableSort,
  sortPrimitivesTableRows,
  type PrimitiveSortRow,
} from '@/app/utils/primitives-table-sort';

const row = (over: Partial<PrimitiveSortRow> = {}): PrimitiveSortRow => ({
  id: over.id ?? 'p-1',
  name: over.name ?? 'money',
  namespace: over.namespace === undefined ? 'tenant/acme/v1/types' : over.namespace,
  category: over.category ?? 'string',
  description: over.description === undefined ? 'A monetary amount.' : over.description,
  usage_count: over.usage_count ?? 0,
  is_system: over.is_system ?? false,
});

describe('nextPrimitivesTableSort', () => {
  it('opens on name ascending', () => {
    expect(DEFAULT_PRIMITIVES_TABLE_SORT).toEqual({ column: 'name', direction: 'asc' });
  });

  it('starts a newly clicked column ascending', () => {
    expect(nextPrimitivesTableSort({ column: 'name', direction: 'desc' }, 'usage')).toEqual({
      column: 'usage',
      direction: 'asc',
    });
  });

  it('reverses the direction when the active column is clicked again', () => {
    const desc = nextPrimitivesTableSort({ column: 'name', direction: 'asc' }, 'name');
    expect(desc).toEqual({ column: 'name', direction: 'desc' });
    expect(nextPrimitivesTableSort(desc, 'name')).toEqual({ column: 'name', direction: 'asc' });
  });
});

describe('comparePrimitivesTableRows', () => {
  it('sorts names case-insensitively and numerically-aware', () => {
    const v2 = row({ id: 'a', name: 'money-v2' });
    const v10 = row({ id: 'b', name: 'Money-v10' });
    expect(comparePrimitivesTableRows(v2, v10, 'name', 'asc')).toBeLessThan(0);
    expect(comparePrimitivesTableRows(v2, v10, 'name', 'desc')).toBeGreaterThan(0);
  });

  it('sorts usage numerically, not as text', () => {
    const nine = row({ id: 'a', usage_count: 9 });
    const forty = row({ id: 'b', usage_count: 40 });
    expect(comparePrimitivesTableRows(nine, forty, 'usage', 'asc')).toBeLessThan(0);
    expect(comparePrimitivesTableRows(nine, forty, 'usage', 'desc')).toBeGreaterThan(0);
  });

  it('sorts system types before tenant types ascending', () => {
    const system = row({ id: 'a', is_system: true });
    const tenant = row({ id: 'b', is_system: false });
    expect(comparePrimitivesTableRows(system, tenant, 'type', 'asc')).toBeLessThan(0);
    expect(comparePrimitivesTableRows(system, tenant, 'type', 'desc')).toBeGreaterThan(0);
  });

  it('sorts categories alphabetically', () => {
    const numeric = row({ id: 'a', category: 'numeric' });
    const string = row({ id: 'b', category: 'string' });
    expect(comparePrimitivesTableRows(numeric, string, 'category', 'asc')).toBeLessThan(0);
  });

  it.each(['namespace', 'description'] as const)(
    'keeps a blank %s last in both directions',
    (column) => {
      const filled = row({ id: 'a', [column]: 'zzz-last-alphabetically' });
      const blank = row({ id: 'b', [column]: null });

      // Ascending: blank after filled. Descending: still after — absent data is not a value.
      expect(comparePrimitivesTableRows(filled, blank, column, 'asc')).toBeLessThan(0);
      expect(comparePrimitivesTableRows(filled, blank, column, 'desc')).toBeLessThan(0);
      expect(comparePrimitivesTableRows(blank, filled, column, 'desc')).toBeGreaterThan(0);
    }
  );

  it('treats whitespace-only text as blank', () => {
    const filled = row({ id: 'a', namespace: 'std/v0/types' });
    const blank = row({ id: 'b', namespace: '   ' });
    expect(comparePrimitivesTableRows(filled, blank, 'namespace', 'asc')).toBeLessThan(0);
    expect(comparePrimitivesTableRows(filled, blank, 'namespace', 'desc')).toBeLessThan(0);
  });

  it('orders two blanks by the tiebreak rather than reporting them equal', () => {
    const a = row({ id: 'a', name: 'alpha', namespace: null });
    const b = row({ id: 'b', name: 'beta', namespace: null });
    expect(comparePrimitivesTableRows(a, b, 'namespace', 'asc')).toBeLessThan(0);
  });

  it('breaks ties by name then id, in the same direction either way', () => {
    // Type is low-cardinality: a second click must not scramble rows it cannot distinguish.
    const alpha = row({ id: 'z', name: 'alpha', is_system: true });
    const beta = row({ id: 'a', name: 'beta', is_system: true });
    expect(comparePrimitivesTableRows(alpha, beta, 'type', 'asc')).toBeLessThan(0);
    expect(comparePrimitivesTableRows(alpha, beta, 'type', 'desc')).toBeLessThan(0);

    const sameName1 = row({ id: 'id-1', name: 'dup', is_system: true });
    const sameName2 = row({ id: 'id-2', name: 'dup', is_system: true });
    expect(comparePrimitivesTableRows(sameName1, sameName2, 'type', 'desc')).toBeLessThan(0);
  });
});

describe('sortPrimitivesTableRows', () => {
  const rows = [
    row({ id: 'c', name: 'charge', usage_count: 12, namespace: null, is_system: false }),
    row({ id: 'a', name: 'address', usage_count: 40, namespace: 'std/v0/types', is_system: true }),
    row({ id: 'b', name: 'balance', usage_count: 3, namespace: 'tenant/acme/v1', is_system: false }),
  ];

  it('does not mutate the array it was given', () => {
    sortPrimitivesTableRows(rows, 'usage', 'desc');
    expect(rows.map((r) => r.id)).toEqual(['c', 'a', 'b']);
  });

  it('orders by name ascending by default', () => {
    expect(sortPrimitivesTableRows(rows, 'name', 'asc').map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('orders by usage descending — the "what is used most" question', () => {
    expect(sortPrimitivesTableRows(rows, 'usage', 'desc').map((r) => r.id)).toEqual(['a', 'c', 'b']);
  });

  it('surfaces the namespace-less types at the bottom whichever way namespace sorts', () => {
    expect(sortPrimitivesTableRows(rows, 'namespace', 'asc').map((r) => r.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(sortPrimitivesTableRows(rows, 'namespace', 'desc').map((r) => r.id)).toEqual([
      'b',
      'a',
      'c',
    ]);
  });
});
