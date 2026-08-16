/**
 * Table view state in the address bar (HIVE-2.3, #5282).
 *
 * Authority: `docs/mockups/DESIGN.md` §8 "List page" — *"Filters live in the URL (as the
 * lint workspace already does)."*
 *
 * The lint workspace got there first: `src/app/utils/lint-workspace.ts` hand-writes a
 * `filtersToSearchParams` / `parseWorkspaceFilters` pair for its fourteen fields, and every
 * list screen that wanted a shareable view has since copied the shape with its own subtle
 * differences — a different empty value, a different truthy spelling, a different idea of
 * what counts as "filtered". This module is that pair generalised: you describe the fields
 * once and get the codec, so the *only* thing a page writes is its own vocabulary.
 *
 * ```ts
 * const projectFilters = defineTableFilters({
 *   q: textFilter(),
 *   status: listFilter(),
 *   owner: textFilter(),
 *   deleted: flagFilter(),
 * });
 *
 * const view = parseTableView(searchParams, projectFilters);
 * // → { filters: { q: 'pay', status: ['active'], owner: '', deleted: false },
 * //     sort: { column: 'name', direction: 'asc' }, page: 2 }
 *
 * tableViewToSearchParams(view, projectFilters).toString();
 * // → 'q=pay&status=active&sort=name&page=2'
 * ```
 *
 * Two properties hold this together, and `tests/hive-data-table-url-state.test.ts` pins
 * both:
 *
 *   1. **Round trip.** `parse(serialize(v))` is `v` for every value the schema can hold.
 *      A shared link that reproduces a *different* view is worse than no link at all.
 *   2. **Default-free URLs.** A field at its default is absent from the query string,
 *      so the unfiltered first page of a list is the bare path. Nothing else can keep an
 *      address bar readable once a page has a dozen facets.
 *
 * This module is deliberately free of React and of `next/navigation`, so it can be unit
 * tested against a plain `URLSearchParams` and reused by a server component that renders
 * the first page from `searchParams`. The hook that binds it to the router is
 * {@link useDataTableUrlState} in `useDataTableUrlState.ts`.
 */

import type { DataTableSortDirection, DataTableSortState } from './DataTable';

// ---------------------------------------------------------------------------------------
// Field kinds
// ---------------------------------------------------------------------------------------

/** A trimmed free-text facet — a search box, an id, a slug. Default `''`. */
export interface TableTextFilter {
  kind: 'text';
  /** Accepted values; anything else parses back to `''`. Omit to accept any text. */
  options?: readonly string[];
}

/** A multi-select facet, serialised as one comma-separated param. Default `[]`. */
export interface TableListFilter {
  kind: 'list';
  /** Accepted members; anything else is dropped. Omit to accept any member. */
  options?: readonly string[];
}

/** A switch — present in the URL only when on. Default `false`. */
export interface TableFlagFilter {
  kind: 'flag';
}

/** A numeric facet (a threshold, a window in days). Default `undefined`, i.e. absent. */
export interface TableNumberFilter {
  kind: 'number';
  /** Reject anything below this. */
  min?: number;
  /** Reject anything above this. */
  max?: number;
}

/** One facet of a list screen. */
export type TableFilterField =
  | TableTextFilter
  | TableListFilter
  | TableFlagFilter
  | TableNumberFilter;

/** The facets of one list screen, keyed by the query param each is written to. */
export type TableFilterSchema = Record<string, TableFilterField>;

/**
 * A free-text facet.
 *
 * @param options Accepted values; anything else parses back to `''`. Omit to accept any text.
 * @returns The field descriptor.
 */
export const textFilter = (options?: readonly string[]): TableTextFilter => ({ kind: 'text', options });

/**
 * A multi-select facet, written as one comma-separated param.
 *
 * @param options Accepted members; anything else is dropped. Omit to accept any member.
 * @returns The field descriptor.
 */
export const listFilter = (options?: readonly string[]): TableListFilter => ({ kind: 'list', options });

/**
 * A switch, present in the URL only when on.
 *
 * @returns The field descriptor.
 */
export const flagFilter = (): TableFlagFilter => ({ kind: 'flag' });

/**
 * A numeric facet.
 *
 * @param bounds Optional inclusive `min` / `max`; a value outside them parses back to absent.
 * @returns The field descriptor.
 */
export const numberFilter = (bounds?: { min?: number; max?: number }): TableNumberFilter => ({
  kind: 'number',
  ...bounds,
});

/** The value one field holds, by kind. */
type ValueOf<Field extends TableFilterField> = Field extends TableTextFilter
  ? string
  : Field extends TableListFilter
    ? string[]
    : Field extends TableFlagFilter
      ? boolean
      : number | undefined;

/** The filter state of a schema — `{ q: string; status: string[]; deleted: boolean }`. */
export type TableFilters<Schema extends TableFilterSchema> = {
  [Key in keyof Schema]: ValueOf<Schema[Key]>;
};

// ---------------------------------------------------------------------------------------
// The schema
// ---------------------------------------------------------------------------------------

/** The reserved param names a view spends on sort and paging, so a facet cannot claim them. */
export const RESERVED_TABLE_PARAMS = ['sort', 'dir', 'page'] as const;

/**
 * A list screen's filter vocabulary.
 *
 * Nothing more than the fields plus the all-defaults value, but naming it is what lets a
 * page pass one object where it would otherwise pass a schema *and* an empty state that
 * has to be kept in step with it by hand.
 */
export interface TableFilterDefinition<Schema extends TableFilterSchema> {
  /** The fields, keyed by query param. */
  fields: Schema;
  /** Every field at its default — the value an unfiltered screen starts from. */
  empty: TableFilters<Schema>;
}

/**
 * Describe a list screen's facets once.
 *
 * @param fields The facets, keyed by the query param each is written to.
 * @returns The schema plus its all-defaults value.
 * @throws If a facet claims one of {@link RESERVED_TABLE_PARAMS}, which sort and paging own.
 */
export function defineTableFilters<Schema extends TableFilterSchema>(
  fields: Schema
): TableFilterDefinition<Schema> {
  const clash = Object.keys(fields).find((key) =>
    (RESERVED_TABLE_PARAMS as readonly string[]).includes(key)
  );
  if (clash) {
    throw new Error(
      `Filter "${clash}" collides with a reserved table param (${RESERVED_TABLE_PARAMS.join(', ')}). ` +
        'Sort and paging own those names; rename the facet.'
    );
  }

  const empty = {} as TableFilters<Schema>;
  for (const key of Object.keys(fields) as Array<keyof Schema>) {
    empty[key] = defaultValue(fields[key]) as TableFilters<Schema>[keyof Schema];
  }
  return { fields, empty };
}

/**
 * The value a field holds when it is not in the URL.
 *
 * @param field The field descriptor.
 * @returns Its default.
 */
function defaultValue(field: TableFilterField): string | string[] | boolean | number | undefined {
  switch (field.kind) {
    case 'text':
      return '';
    case 'list':
      return [];
    case 'flag':
      return false;
    case 'number':
      return undefined;
  }
}

// ---------------------------------------------------------------------------------------
// Filters ⇄ query string
// ---------------------------------------------------------------------------------------

/**
 * A source of query params — `URLSearchParams`, or Next's `ReadonlyURLSearchParams`.
 *
 * Typed structurally rather than as `URLSearchParams` so `useSearchParams()` can be handed
 * straight in: Next's return value is read-only and so not assignable to the mutable class.
 */
export interface ReadonlyParams {
  get(name: string): string | null;
}

/**
 * Read a screen's filter state out of a query string.
 *
 * Unknown params are ignored and unparseable values fall back to the field's default, so a
 * hand-edited or stale link degrades to a *valid* view rather than to an error.
 *
 * @param params The query params.
 * @param definition The screen's filter schema.
 * @returns Every field, at its URL value or its default.
 */
export function parseTableFilters<Schema extends TableFilterSchema>(
  params: ReadonlyParams,
  definition: TableFilterDefinition<Schema>
): TableFilters<Schema> {
  const filters = {} as TableFilters<Schema>;

  for (const key of Object.keys(definition.fields) as Array<keyof Schema & string>) {
    const field = definition.fields[key];
    const raw = params.get(key);
    filters[key] = parseField(field, raw) as TableFilters<Schema>[typeof key];
  }

  return filters;
}

/**
 * One field's value, from its raw query param.
 *
 * @param field The field descriptor.
 * @param raw The param as it appears in the URL, or `null` when absent.
 * @returns The parsed value, or the field's default if `raw` cannot be read as one.
 */
function parseField(
  field: TableFilterField,
  raw: string | null
): string | string[] | boolean | number | undefined {
  if (raw === null) return defaultValue(field);

  switch (field.kind) {
    case 'text': {
      const value = raw.trim();
      if (!value) return '';
      return field.options && !field.options.includes(value) ? '' : value;
    }
    case 'list': {
      const members = raw
        .split(',')
        .map((member) => member.trim())
        .filter(Boolean);
      const allowed = field.options
        ? members.filter((member) => field.options?.includes(member))
        : members;
      // De-duplicated because `?status=active,active` and `?status=active` are the same
      // view, and a filter chip drawn twice is a bug the URL should not be able to cause.
      return Array.from(new Set(allowed));
    }
    case 'flag':
      return raw === 'true' || raw === '1';
    case 'number': {
      const value = Number(raw);
      if (!Number.isFinite(value)) return undefined;
      if (field.min !== undefined && value < field.min) return undefined;
      if (field.max !== undefined && value > field.max) return undefined;
      return value;
    }
  }
}

/**
 * Write a screen's filter state into query params.
 *
 * A field at its default is left out entirely — that is what keeps the unfiltered first
 * page of a list at the bare path.
 *
 * @param filters The filter state.
 * @param definition The screen's filter schema.
 * @returns Params carrying only the fields that are not at their default.
 */
export function tableFiltersToSearchParams<Schema extends TableFilterSchema>(
  filters: TableFilters<Schema>,
  definition: TableFilterDefinition<Schema>
): URLSearchParams {
  const params = new URLSearchParams();

  for (const key of Object.keys(definition.fields) as Array<keyof Schema & string>) {
    const field = definition.fields[key];
    const value = filters[key];

    switch (field.kind) {
      case 'text': {
        const trimmed = String(value ?? '').trim();
        if (trimmed) params.set(key, trimmed);
        break;
      }
      case 'list': {
        const members = Array.isArray(value) ? Array.from(new Set(value.filter(Boolean))) : [];
        if (members.length) params.set(key, members.join(','));
        break;
      }
      case 'flag':
        if (value === true) params.set(key, 'true');
        break;
      case 'number':
        if (typeof value === 'number' && Number.isFinite(value)) params.set(key, String(value));
        break;
    }
  }

  return params;
}

/**
 * How many facets are narrowing the list.
 *
 * The number on the "Clear filters" chip, and the test for whether an empty table means
 * *"nothing here yet"* (offer the primary action) or *"nothing matched"* (offer to clear).
 *
 * @param filters The filter state.
 * @param definition The screen's filter schema.
 * @returns The count of fields that are not at their default.
 */
export function activeTableFilterCount<Schema extends TableFilterSchema>(
  filters: TableFilters<Schema>,
  definition: TableFilterDefinition<Schema>
): number {
  // `Array.from(keys())` rather than `.size`, which Node only grew in 19 — this module is
  // also imported by the jsdom test environment and by the Node build.
  return Array.from(tableFiltersToSearchParams(filters, definition).keys()).length;
}

// ---------------------------------------------------------------------------------------
// The whole view: filters + sort + page
// ---------------------------------------------------------------------------------------

/** Everything about a list screen that belongs in the address bar. */
export interface TableView<Schema extends TableFilterSchema> {
  /** The screen's facets. */
  filters: TableFilters<Schema>;
  /** The sorted column and its direction, or `null` for the screen's own default order. */
  sort: DataTableSortState | null;
  /** The 1-based page number. */
  page: number;
}

/**
 * What a screen falls back to when the URL says nothing.
 *
 * Separate from the schema because two screens can share a filter vocabulary and still
 * disagree about which column they open on.
 */
export interface TableViewDefaults {
  /** The column sorted when `?sort=` is absent, and the direction it is sorted in. */
  sort?: DataTableSortState | null;
  /** Column ids `?sort=` may name. Anything else falls back to `sort`. */
  sortableColumns?: readonly string[];
}

/** `asc` unless the param says otherwise — the direction a first click on a header gives. */
function parseDirection(raw: string | null): DataTableSortDirection {
  return raw === 'desc' ? 'desc' : 'asc';
}

/**
 * Read a whole list view — filters, sort and page — out of a query string.
 *
 * @param params The query params.
 * @param definition The screen's filter schema.
 * @param defaults The screen's default sort, and the columns `?sort=` may name.
 * @returns The view the URL describes, with anything unreadable at its default.
 */
export function parseTableView<Schema extends TableFilterSchema>(
  params: ReadonlyParams,
  definition: TableFilterDefinition<Schema>,
  defaults: TableViewDefaults = {}
): TableView<Schema> {
  const column = params.get('sort');
  let named: DataTableSortState | null;
  if (column === null) {
    // Nothing said about order: the screen's own.
    named = defaults.sort ?? null;
  } else if (column === '') {
    // Said outright — `?sort=` is how the third click of the cycle survives a page reload
    // on a table that *has* a default order. Without it, "unsorted" would be unshareable.
    named = null;
  } else if (!defaults.sortableColumns || defaults.sortableColumns.includes(column)) {
    named = { column, direction: parseDirection(params.get('dir')) };
  } else {
    // A column this table does not have — a stale link, or one from a sibling screen.
    named = defaults.sort ?? null;
  }

  // A page below 1 is not a page; `?page=0` and `?page=-3` both mean the first one.
  const page = Math.max(1, Math.trunc(Number(params.get('page'))) || 1);

  return { filters: parseTableFilters(params, definition), sort: named, page };
}

/**
 * Write a whole list view back into query params.
 *
 * Sort is omitted while it matches `defaults.sort`, `dir` while it is `asc`, and `page`
 * while it is the first — the same default-free rule the filters follow, so the plain
 * unfiltered list is the bare path and every deviation from it is visible in the address.
 *
 * @param view The view to serialise.
 * @param definition The screen's filter schema.
 * @param defaults The screen's default sort, so the default is not spelled out.
 * @returns Params carrying only what differs from the defaults.
 */
export function tableViewToSearchParams<Schema extends TableFilterSchema>(
  view: TableView<Schema>,
  definition: TableFilterDefinition<Schema>,
  defaults: TableViewDefaults = {}
): URLSearchParams {
  const params = tableFiltersToSearchParams(view.filters, definition);
  const fallback = defaults.sort ?? null;
  const isDefaultSort =
    view.sort === null
      ? fallback === null
      : view.sort.column === fallback?.column && view.sort.direction === fallback.direction;

  if (view.sort === null) {
    // Only worth saying when the screen would otherwise sort by itself; see `parseTableView`.
    if (fallback !== null) params.set('sort', '');
  } else if (!isDefaultSort) {
    params.set('sort', view.sort.column);
    // `asc` is what `?sort=<column>` means on its own, so only the other way up needs a param.
    if (view.sort.direction === 'desc') params.set('dir', 'desc');
  }

  if (view.page > 1) params.set('page', String(view.page));
  return params;
}

/**
 * The path a view should be at.
 *
 * @param pathname The route, without a query string.
 * @param view The view to serialise.
 * @param definition The screen's filter schema.
 * @param defaults The screen's default sort.
 * @returns `pathname`, plus a query string only when the view differs from the defaults.
 */
export function tableViewToHref<Schema extends TableFilterSchema>(
  pathname: string,
  view: TableView<Schema>,
  definition: TableFilterDefinition<Schema>,
  defaults: TableViewDefaults = {}
): string {
  const query = tableViewToSearchParams(view, definition, defaults).toString();
  return query ? `${pathname}?${query}` : pathname;
}

/**
 * The sort state a click on a column header produces.
 *
 * First click sorts ascending, a second on the same column flips to descending, and a third
 * returns to the screen's own order — the three-state cycle DESIGN.md §8 draws, and the
 * reason `sort` is nullable rather than always naming a column.
 *
 * @param current The sort state before the click.
 * @param column The column that was clicked.
 * @returns The sort state after it.
 */
export function nextSortState(
  current: DataTableSortState | null,
  column: string
): DataTableSortState | null {
  if (current?.column !== column) return { column, direction: 'asc' };
  if (current.direction === 'asc') return { column, direction: 'desc' };
  return null;
}
