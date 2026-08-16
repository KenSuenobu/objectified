'use client';

/**
 * The address bar as a list screen's state store (HIVE-2.3, #5282).
 *
 * `dataTableUrlState.ts` is the codec — pure, router-free, and unit tested against a plain
 * `URLSearchParams`. This is the twenty lines that bind it to Next's router, which is all a
 * page should have to write to get DESIGN.md §8's *"filters live in the URL"*.
 *
 * ```tsx
 * const projectFilters = defineTableFilters({ q: textFilter(), status: listFilter(STATUSES) });
 *
 * function ProjectsClient() {
 *   const { view, setFilters, setSort, setPage } = useDataTableUrlState(projectFilters, {
 *     sort: { column: 'name', direction: 'asc' },
 *     sortableColumns: ['name', 'versions', 'updated'],
 *   });
 *   // `view.filters`, `view.sort`, `view.page` — read from the URL, written back to it.
 * }
 * ```
 *
 * Three decisions the hook makes for every caller, so no screen has to make them again:
 *
 *   • **`replace`, not `push`.** Narrowing a filter is not a navigation. Pushing would turn
 *     one considered query into a dozen Back presses to escape.
 *   • **`scroll: false`.** The row you were reading should still be under the cursor after
 *     a sort flip; scrolling to the top of a re-sorted table loses your place twice over.
 *   • **Any filter change resets to page 1.** Page 4 of a narrower result set is usually
 *     empty, and an empty table is read as "no matches" rather than as "wrong page".
 *
 * Because the state *is* the URL, Back and Forward step through a session's views for free,
 * and the address bar is always a shareable link to exactly what is on screen.
 *
 * The route must render this inside a `<Suspense>` boundary: `useSearchParams()` opts a
 * component into client-side rendering, and the App Router requires the boundary to say so.
 */

import * as React from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import {
  parseTableView,
  tableViewToHref,
  type TableFilterDefinition,
  type TableFilterSchema,
  type TableFilters,
  type TableView,
  type TableViewDefaults,
} from './dataTableUrlState';
import type { DataTableSortState } from './DataTable';

/** What a list screen gets back: the current view, and the four ways to change it. */
export interface DataTableUrlState<Schema extends TableFilterSchema> {
  /** Filters, sort and page, as the URL currently describes them. */
  view: TableView<Schema>;
  /** Replace the filter state, returning to page 1. Accepts a partial patch. */
  setFilters: (next: Partial<TableFilters<Schema>>) => void;
  /** Set the sorted column and direction, or `null` for the screen's own order. */
  setSort: (next: DataTableSortState | null) => void;
  /** Go to a 1-based page. */
  setPage: (next: number) => void;
  /** Drop every filter, returning to page 1 and keeping the sort. */
  clearFilters: () => void;
}

/**
 * Keep a list screen's filters, sort and page in the address bar.
 *
 * @param definition The screen's filter vocabulary, from `defineTableFilters`.
 * @param defaults The column the screen sorts by when the URL says nothing, and the column
 *   ids `?sort=` is allowed to name.
 * @returns The current view and the setters that write it back to the URL.
 */
export function useDataTableUrlState<Schema extends TableFilterSchema>(
  definition: TableFilterDefinition<Schema>,
  defaults: TableViewDefaults = {}
): DataTableUrlState<Schema> {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // `defaults` is almost always an object literal at the call site, so a new identity on
  // every render. Reading it through a ref keeps the callbacks below stable — otherwise
  // every effect that depends on one of them would re-run on each render of the page.
  const defaultsRef = React.useRef(defaults);
  defaultsRef.current = defaults;

  const view = React.useMemo(
    () => parseTableView(searchParams, definition, defaults),
    // `defaults` is intentionally read through the ref rather than listed: the parse must
    // re-run when the URL or the vocabulary changes, not when a literal is re-created.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [searchParams, definition]
  );

  const go = React.useCallback(
    (next: TableView<Schema>) => {
      router.replace(tableViewToHref(pathname, next, definition, defaultsRef.current), {
        scroll: false,
      });
    },
    [router, pathname, definition]
  );

  const setFilters = React.useCallback(
    (next: Partial<TableFilters<Schema>>) => {
      go({ ...view, filters: { ...view.filters, ...next }, page: 1 });
    },
    [go, view]
  );

  const setSort = React.useCallback(
    (next: DataTableSortState | null) => {
      // Paging is preserved: re-ordering does not change *which* rows matched, only the
      // order they arrive in, and losing your page on a sort flip is a surprise.
      go({ ...view, sort: next });
    },
    [go, view]
  );

  const setPage = React.useCallback(
    (next: number) => {
      go({ ...view, page: Math.max(1, Math.trunc(next) || 1) });
    },
    [go, view]
  );

  const clearFilters = React.useCallback(() => {
    go({ ...view, filters: definition.empty, page: 1 });
  }, [go, view, definition]);

  return { view, setFilters, setSort, setPage, clearFilters };
}
