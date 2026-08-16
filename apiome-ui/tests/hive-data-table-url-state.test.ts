/**
 * Table view state in the address bar (HIVE-2.3, #5282).
 *
 * `src/app/components/ui/dataTableUrlState.ts` is the generalisation of the lint workspace's
 * hand-written filter codec, and the acceptance criterion it exists to satisfy is one line
 * long: *"Sort/filter/page state round-trips through the URL."*
 *
 * That criterion is only worth anything if it holds for the values that actually break a
 * naive codec — the empty list, the flag that is off, the explicit "unsorted" on a table
 * that has a default order, the `?page=0` somebody hand-typed. So the suite is built around
 * two invariants rather than around a list of examples:
 *
 *   1. **`parse(serialize(v)) === v`** for every value the schema can hold.
 *   2. **A default is never spelled out** — the unfiltered first page is the bare path,
 *      which is the only thing that keeps a faceted list's address readable.
 *
 * The component half is `tests/hive-data-table.test.tsx`.
 */

import {
  activeTableFilterCount,
  defineTableFilters,
  flagFilter,
  listFilter,
  nextSortState,
  numberFilter,
  parseTableFilters,
  parseTableView,
  tableFiltersToSearchParams,
  tableViewToHref,
  tableViewToSearchParams,
  textFilter,
  type TableView,
} from '../src/app/components/ui/dataTableUrlState';

/** The statuses the fixture screen faceted on — a closed vocabulary, as a real screen has. */
const STATUSES = ['active', 'draft', 'archived'] as const;

/**
 * A list screen with one of every field kind, so nothing is proved by a single shape.
 */
const filters = defineTableFilters({
  q: textFilter(),
  status: listFilter(STATUSES),
  owner: textFilter(),
  deleted: flagFilter(),
  minScore: numberFilter({ min: 0, max: 100 }),
});

/** The screen's default order — the case where "unsorted" is a thing you can choose. */
const defaults = {
  sort: { column: 'name', direction: 'asc' as const },
  sortableColumns: ['name', 'updated', 'versions'],
};

/** Every view the invariants below are checked against. */
const VIEWS: Array<[string, TableView<typeof filters.fields>]> = [
  ['the bare list', { filters: filters.empty, sort: defaults.sort, page: 1 }],
  [
    'one of each facet',
    {
      filters: {
        q: 'payments',
        status: ['active', 'draft'],
        owner: 'user_ada',
        deleted: true,
        minScore: 80,
      },
      sort: { column: 'updated', direction: 'desc' },
      page: 4,
    },
  ],
  [
    'the default column, the other way up',
    { filters: filters.empty, sort: { column: 'name', direction: 'desc' }, page: 1 },
  ],
  ['explicitly unsorted', { filters: filters.empty, sort: null, page: 1 }],
  [
    'a facet that happens to be zero',
    { filters: { ...filters.empty, minScore: 0 }, sort: defaults.sort, page: 2 },
  ],
];

describe('round trip', () => {
  it.each(VIEWS)('%s survives serialise → parse', (_name, view) => {
    const params = tableViewToSearchParams(view, filters, defaults);
    const back = parseTableView(new URLSearchParams(params.toString()), filters, defaults);
    expect(back).toEqual(view);
  });

  it('survives a second lap, so the codec has no drift', () => {
    for (const [, view] of VIEWS) {
      const once = new URLSearchParams(
        tableViewToSearchParams(view, filters, defaults).toString()
      );
      const parsed = parseTableView(once, filters, defaults);
      const twice = tableViewToSearchParams(parsed, filters, defaults);
      expect(twice.toString()).toBe(once.toString());
    }
  });
});

describe('defaults are never spelled out', () => {
  it('the unfiltered first page is the bare path', () => {
    const view = { filters: filters.empty, sort: defaults.sort, page: 1 };
    expect(tableViewToSearchParams(view, filters, defaults).toString()).toBe('');
    expect(tableViewToHref('/ade/dashboard/projects', view, filters, defaults)).toBe(
      '/ade/dashboard/projects'
    );
  });

  it('an empty list, an off flag and an absent number write nothing', () => {
    expect(tableFiltersToSearchParams(filters.empty, filters).toString()).toBe('');
  });

  it('page 1 and an ascending sort are implied, descending is not', () => {
    const ascending = tableViewToSearchParams(
      { filters: filters.empty, sort: { column: 'updated', direction: 'asc' }, page: 1 },
      filters,
      defaults
    );
    expect(ascending.toString()).toBe('sort=updated');

    const descending = tableViewToSearchParams(
      { filters: filters.empty, sort: { column: 'updated', direction: 'desc' }, page: 3 },
      filters,
      defaults
    );
    expect(descending.get('sort')).toBe('updated');
    expect(descending.get('dir')).toBe('desc');
    expect(descending.get('page')).toBe('3');
  });

  it('says "unsorted" outright, because a table with a default order cannot imply it', () => {
    const params = tableViewToSearchParams(
      { filters: filters.empty, sort: null, page: 1 },
      filters,
      defaults
    );
    expect(params.toString()).toBe('sort=');
    expect(parseTableView(params, filters, defaults).sort).toBeNull();
  });

  it('stays silent about "unsorted" when the screen has no default order either', () => {
    const params = tableViewToSearchParams({ filters: filters.empty, sort: null, page: 1 }, filters);
    expect(params.toString()).toBe('');
    expect(parseTableView(params, filters).sort).toBeNull();
  });
});

describe('a hand-edited or stale URL degrades to a valid view', () => {
  /** Parse a query string against the fixture screen. */
  const view = (query: string) => parseTableView(new URLSearchParams(query), filters, defaults);

  it('drops facet values outside the vocabulary', () => {
    expect(view('status=active,banana,draft').filters.status).toEqual(['active', 'draft']);
  });

  it('de-duplicates a repeated facet member', () => {
    expect(view('status=active,active').filters.status).toEqual(['active']);
  });

  it('ignores params the screen does not know', () => {
    expect(view('nonsense=1').filters).toEqual(filters.empty);
  });

  it('rejects a number outside its bounds, and one that is not a number', () => {
    expect(view('minScore=140').filters.minScore).toBeUndefined();
    expect(view('minScore=-1').filters.minScore).toBeUndefined();
    expect(view('minScore=abc').filters.minScore).toBeUndefined();
    expect(view('minScore=100').filters.minScore).toBe(100);
  });

  it('falls back to the default order when ?sort= names a column this table lacks', () => {
    expect(view('sort=whatever').sort).toEqual(defaults.sort);
  });

  it('treats a page below 1 as the first page', () => {
    expect(view('page=0').page).toBe(1);
    expect(view('page=-4').page).toBe(1);
    expect(view('page=nope').page).toBe(1);
    expect(view('page=7').page).toBe(7);
  });

  it('reads both spellings of an on flag, and trims text', () => {
    expect(view('deleted=true').filters.deleted).toBe(true);
    expect(view('deleted=1').filters.deleted).toBe(true);
    expect(view('deleted=false').filters.deleted).toBe(false);
    expect(view('q=%20%20payments%20%20').filters.q).toBe('payments');
  });
});

describe('the schema', () => {
  it('gives every field its default', () => {
    expect(filters.empty).toEqual({
      q: '',
      status: [],
      owner: '',
      deleted: false,
      minScore: undefined,
    });
  });

  it('refuses a facet that would shadow sort or paging', () => {
    expect(() => defineTableFilters({ sort: textFilter() })).toThrow(/reserved/i);
    expect(() => defineTableFilters({ page: numberFilter() })).toThrow(/reserved/i);
    expect(() => defineTableFilters({ dir: textFilter() })).toThrow(/reserved/i);
  });

  it('counts the facets that are narrowing the list', () => {
    expect(activeTableFilterCount(filters.empty, filters)).toBe(0);
    expect(
      activeTableFilterCount(
        { ...filters.empty, q: 'pay', status: ['active'], deleted: true },
        filters
      )
    ).toBe(3);
    // A number at zero is a filter; only *absence* is not.
    expect(activeTableFilterCount({ ...filters.empty, minScore: 0 }, filters)).toBe(1);
  });

  it('reads a Next-style read-only params object, not just URLSearchParams', () => {
    const readonlyParams = { get: (name: string) => (name === 'q' ? 'pay' : null) };
    expect(parseTableFilters(readonlyParams, filters).q).toBe('pay');
  });
});

describe('the sort cycle', () => {
  it('goes ascending → descending → the screen’s own order', () => {
    const first = nextSortState(null, 'name');
    expect(first).toEqual({ column: 'name', direction: 'asc' });

    const second = nextSortState(first, 'name');
    expect(second).toEqual({ column: 'name', direction: 'desc' });

    expect(nextSortState(second, 'name')).toBeNull();
  });

  it('starts a different column ascending, wherever the last one had got to', () => {
    expect(nextSortState({ column: 'name', direction: 'desc' }, 'updated')).toEqual({
      column: 'updated',
      direction: 'asc',
    });
  });
});
