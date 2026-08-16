'use client';

import * as React from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Search,
  X,
} from 'lucide-react';

import { cn } from '../../../../lib/utils';
import { Button, type ButtonProps } from './Button';
import { Checkbox } from './Checkbox';
import { Input } from './Input';
import { Skeleton } from './Skeleton';
import { nextSortState } from './dataTableUrlState';

/**
 * DataTable — the Hive list surface (HIVE-2.3, #5282).
 *
 * Authority: `docs/mockups/assets/hive.css` §17 (`.table-wrap .table-toolbar .table
 * .table-foot .pager .bulk-bar`), `docs/mockups/DESIGN.md` §7 and §8 "List page", and the
 * Tables section of `docs/mockups/foundations/design-system.html`.
 *
 * Every list screen in the app used to build its own table out of the string constants in
 * `components/ade/dashboard/dashboardScreenClasses.ts`, and then re-implement sorting,
 * selection, bulk actions, paging and the empty state on top of them — forty pages, forty
 * subtly different answers to the same five questions. This is the one answer:
 *
 * ```tsx
 * <DataTable
 *   caption="Projects"
 *   columns={columns}
 *   rows={projects}
 *   getRowId={(project) => project.id}
 *   sort={view.sort}
 *   onSortChange={setSort}
 *   selectedIds={selected}
 *   onSelectionChange={setSelected}
 *   onRowActivate={(project) => router.push(`/ade/dashboard/projects/${project.id}`)}
 *   loading={loading}
 *   toolbar={<DataTableToolbar>…</DataTableToolbar>}
 *   bulkActions={<DataTableBulkAction>Archive</DataTableBulkAction>}
 *   footer={<DataTableFoot>…</DataTableFoot>}
 * />
 * ```
 *
 * ### What it owns
 *
 * The **card** (surface, radius, hairline), the **toolbar** strip above the table, the
 * **sticky caps header** with its sort affordance and `aria-sort`, the **rows** with their
 * hover tint, hover-revealed actions and selection, the **bulk bar** that rises when
 * something is selected, and the **foot** with the count and the pager. It also owns the
 * three states a list is in when it has no rows to draw — loading, empty and error — because
 * those are the ones pages most often forgot.
 *
 * ### What it does not own
 *
 * The *view state*. Sort, selection and paging are all controlled props: the table draws
 * what it is told and reports what was clicked. That is what lets DESIGN.md §8's *"filters
 * live in the URL"* be true — `useDataTableUrlState` keeps the state in the address bar, and
 * the table never has an opinion that could disagree with it.
 *
 * ### Sizing
 *
 * Nothing here is a frozen size. Row height is `--row-h`, cell padding is derived from it by
 * the `table-density` rules in `globals.css`, and the `dense` variant re-points `--row-h` at
 * `--control-h` (the `.table-dense` block, same file) rather than naming a second height —
 * so a dense table is exactly "as tall as a button" at both densities and all six font
 * scales.
 *
 * ### Accessibility
 *
 * A real `<table>` with `scope`d headers and a `<caption>`, not a grid of `div`s. Sorting is
 * a `<button>` inside the `<th>` and the state is on the `<th>` as `aria-sort`. Selection is
 * carried by real checkboxes — the thing assistive technology already knows how to report —
 * rather than by `aria-selected`, which a plain `table` role does not support. Row focus is
 * a roving `tabindex`, so a fifty-row table is one Tab stop and not fifty.
 */

// ---------------------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------------------

/** Which way a sorted column is pointing. */
export type DataTableSortDirection = 'asc' | 'desc';

/** The sorted column, and its direction. `null` anywhere means "the screen's own order". */
export interface DataTableSortState {
  /** The `id` of the sorted column. */
  column: string;
  /** Ascending (a first click) or descending (a second). */
  direction: DataTableSortDirection;
}

/** `aria-sort` for one header, from the table's sort state. */
function ariaSortFor(
  column: DataTableColumn<unknown>,
  sort: DataTableSortState | null | undefined
): 'ascending' | 'descending' | 'none' | undefined {
  if (!column.sortable) return undefined;
  if (sort?.column !== column.id) return 'none';
  return sort.direction === 'asc' ? 'ascending' : 'descending';
}

// ---------------------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------------------

/** One column of a list. */
export interface DataTableColumn<Row> {
  /** Stable id — the React key, the `?sort=` value, and how the table finds the column. */
  id: string;
  /** The caps label in the header. */
  header?: React.ReactNode;
  /**
   * The header as assistive technology should hear it.
   *
   * Required when `header` is a glyph or empty (the row-actions column), because a column
   * with no name leaves every cell under it unlabelled.
   */
  headerLabel?: string;
  /**
   * This column's cell for one row.
   *
   * @param row The row being drawn.
   * @param index Its 0-based position in `rows`.
   * @returns The cell contents.
   */
  cell: (row: Row, index: number) => React.ReactNode;
  /** Whether the header offers a sort affordance. */
  sortable?: boolean;
  /** Text alignment — `end` for numbers and for the row-actions column. */
  align?: 'start' | 'end';
  /**
   * Marks the trailing row-actions column: right-aligned, revealed on row hover or focus,
   * and the target of the `.` shortcut. Its `header` is normally omitted and its
   * `headerLabel` set to `"Actions"`.
   */
  actions?: boolean;
  /** Extra classes for this column's `<td>`. */
  className?: string;
  /** Extra classes for this column's `<th>`. */
  headerClassName?: string;
  /**
   * Width of the placeholder bar drawn in this column while `loading` — `'8rem'`, `'40%'`.
   *
   * DESIGN.md §8 asks for skeletons *shaped like the content*, which means the shape has to
   * be stated per column: one uniform grey bar in every cell is a spinner with extra steps.
   */
  skeletonWidth?: string;
}

// ---------------------------------------------------------------------------------------
// Shared class vocabulary
// ---------------------------------------------------------------------------------------

/**
 * The card a list lives in: surface, radius, hairline, and the density rules that reach the
 * cells (`table-density`, HIVE-1.6).
 *
 * `overflow-hidden` is what keeps the header strip and the first row inside the radius.
 */
const TABLE_CARD_CLASS =
  'table-density overflow-hidden rounded-lg bg-surface shadow-[var(--shadow-sm)]';

/** Horizontal cell rhythm — column padding, which is a layout choice, not a density one. */
const CELL_X_CLASS = 'px-3.5';

/**
 * The caps header strip.
 *
 * `sticky top-0` is inert until an ancestor scrolls, which is exactly the behaviour wanted:
 * the header only has somewhere to stick to once `maxBodyHeight` or `scrollX` turns the
 * wrapper into a scroll container. The background must be opaque or the rows would show
 * through it as they pass underneath.
 */
const TH_CLASS = [
  'sticky top-0 z-1 whitespace-nowrap border-b border-border bg-surface text-left align-middle',
  'text-2xs font-semibold tracking-[var(--track-caps)] uppercase text-fg-muted',
  CELL_X_CLASS,
].join(' ');

/** A body cell: the row metric as a floor, a hairline under it, vertically centred. */
const TD_CLASS = ['h-[var(--row-h)] border-b border-border align-middle', CELL_X_CLASS].join(' ');

/** The narrow leading column that holds a row's checkbox. */
const CHECK_CELL_CLASS = 'w-10 pr-0';

/** How many placeholder rows a loading table draws when the caller does not say. */
const DEFAULT_SKELETON_ROWS = 5;

/**
 * The minimum width a `scrollX` table is allowed to squeeze to before it scrolls.
 *
 * `hive.css` freezes this at 780 px; in `rem` it follows the font-size preference, which is
 * the point — the width a table stops being readable at is a function of its type size.
 */
const SCROLL_X_MIN_WIDTH = 'min-w-[48.75rem]';

// ---------------------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------------------

/** Anything the keyboard can land on inside a cell. */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
];

/**
 * The first focusable control of a row's actions cell.
 *
 * Built per-clause rather than as one `[data-row-actions] a,button,…` string: a comma in a
 * selector list ends the descendant scope, so the shorter spelling would have matched *any*
 * button in the row — the row's own checkbox included.
 */
const ROW_ACTION_SELECTOR = FOCUSABLE.map((clause) => `[data-row-actions] ${clause}`).join(',');

// ---------------------------------------------------------------------------------------
// DataTable
// ---------------------------------------------------------------------------------------

export interface DataTableProps<Row>
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onSelect'> {
  /** The columns, in order. */
  columns: ReadonlyArray<DataTableColumn<Row>>;
  /** The rows of the current page. The table never sorts, filters or pages them itself. */
  rows: ReadonlyArray<Row>;
  /**
   * A row's stable id — the React key, the selection member, and the row's `data-row-id`.
   *
   * @param row The row.
   * @returns Its id, unique within the page.
   */
  getRowId: (row: Row) => string;
  /**
   * A row as one line of text, for its checkbox's label and its `.`-actions announcement.
   *
   * Without it a page of checkboxes all read as "Select row", which is true and useless.
   *
   * @param row The row.
   * @returns A short human name for it.
   */
  getRowLabel?: (row: Row) => string;
  /** The table's accessible name. Rendered as a visually hidden `<caption>`. */
  caption?: string;
  /** Compact rows — `--row-h` becomes `--control-h`, the height of a button. */
  dense?: boolean;
  /**
   * Let a wide table scroll sideways *inside its own card*, never taking the page with it
   * (DESIGN.md §5: no horizontal document scroll at ≥1280 px).
   */
  scrollX?: boolean;
  /**
   * Cap the body's height so it scrolls under the sticky header — any CSS length,
   * e.g. `'26rem'` or `'60vh'`.
   */
  maxBodyHeight?: string;

  /** The sorted column, or `null` for the screen's own order. */
  sort?: DataTableSortState | null;
  /**
   * Called when a sortable header is activated, with the state after the click.
   *
   * The cycle is asc → desc → unsorted; `nextSortState` in `dataTableUrlState.ts` computes it.
   */
  onSortChange?: (next: DataTableSortState | null) => void;

  /** The selected row ids. Passing this (even empty) is what adds the checkbox column. */
  selectedIds?: ReadonlyArray<string>;
  /** Called with the ids after a checkbox, a select-all or the `X` shortcut. */
  onSelectionChange?: (next: string[]) => void;
  /**
   * Whether a row may be selected at all — a revoked key, a row the viewer cannot edit.
   *
   * @param row The row.
   * @returns `false` to draw its checkbox disabled and skip it in select-all.
   */
  isRowSelectable?: (row: Row) => boolean;
  /** The bulk bar's actions. The bar, its count and its Clear button are provided. */
  bulkActions?: React.ReactNode;

  /** Called when a row is clicked, or `↵` is pressed on it. Makes rows look clickable. */
  onRowActivate?: (row: Row) => void;
  /**
   * Extra classes for one row — the mockups' `is-expired` / `is-disabled` row tints.
   *
   * @param row The row.
   * @returns Classes to merge onto its `<tr>`.
   */
  rowClassName?: (row: Row) => string | undefined;

  /** Draw skeleton rows instead of `rows`. */
  loading?: boolean;
  /** How many skeleton rows (default 5). */
  skeletonRows?: number;
  /** Replaces the body when the load failed. Rendered in an `alert`, above a retry. */
  error?: React.ReactNode;
  /** Replaces the body when `rows` is empty and nothing is loading or broken. */
  empty?: React.ReactNode;

  /** The strip above the table — search, filter chips, view switch, sort. */
  toolbar?: React.ReactNode;
  /** The strip below it — count on the left, pager on the right. */
  footer?: React.ReactNode;
}

/**
 * The Hive list table.
 *
 * @param props See {@link DataTableProps}.
 * @returns The card, its toolbar, the table, its foot and the bulk bar.
 */
function DataTable<Row>({
  columns,
  rows,
  getRowId,
  getRowLabel,
  caption,
  dense,
  scrollX,
  maxBodyHeight,
  sort,
  onSortChange,
  selectedIds,
  onSelectionChange,
  isRowSelectable,
  bulkActions,
  onRowActivate,
  rowClassName,
  loading,
  skeletonRows = DEFAULT_SKELETON_ROWS,
  error,
  empty,
  toolbar,
  footer,
  className,
  ...props
}: DataTableProps<Row>) {
  const selectable = selectedIds !== undefined;
  const selected = React.useMemo(() => new Set(selectedIds ?? []), [selectedIds]);
  const columnCount = columns.length + (selectable ? 1 : 0);

  /** The rows a select-all may reach — everything the caller has not held back. */
  const selectableRows = React.useMemo(
    () => (isRowSelectable ? rows.filter(isRowSelectable) : rows),
    [rows, isRowSelectable]
  );

  const selectedOnPage = selectableRows.filter((row) => selected.has(getRowId(row))).length;
  const allSelected = selectableRows.length > 0 && selectedOnPage === selectableRows.length;
  const someSelected = selectedOnPage > 0 && !allSelected;

  /**
   * The row that owns the table's single Tab stop.
   *
   * A roving `tabindex`: a fifty-row table must not be fifty Tab stops. It follows focus,
   * and falls back to the first row whenever the remembered row leaves the page — after a
   * filter, a sort or a page change — so the keyboard always has somewhere to land.
   */
  const [activeRowId, setActiveRowId] = React.useState<string | null>(null);
  const rowIds = rows.map(getRowId);
  const tabStopId =
    activeRowId !== null && rowIds.includes(activeRowId) ? activeRowId : (rowIds[0] ?? null);

  const bodyRef = React.useRef<HTMLTableSectionElement | null>(null);

  /** Toggle one row's membership of the selection. */
  const toggleRow = React.useCallback(
    (id: string, next: boolean) => {
      if (!onSelectionChange) return;
      const ids = new Set(selected);
      if (next) ids.add(id);
      else ids.delete(id);
      onSelectionChange(Array.from(ids));
    },
    [onSelectionChange, selected]
  );

  /** Select or clear every selectable row on the page, leaving other pages' ids alone. */
  const toggleAll = React.useCallback(
    (next: boolean) => {
      if (!onSelectionChange) return;
      const ids = new Set(selected);
      for (const row of selectableRows) {
        const id = getRowId(row);
        if (next) ids.add(id);
        else ids.delete(id);
      }
      onSelectionChange(Array.from(ids));
    },
    [onSelectionChange, selected, selectableRows, getRowId]
  );

  /** Every drawn row element, in DOM order — what the arrow keys walk. */
  const rowElements = (): HTMLTableRowElement[] =>
    Array.from(bodyRef.current?.querySelectorAll<HTMLTableRowElement>('tr[data-row-id]') ?? []);

  /**
   * The DESIGN.md §8 row shortcuts.
   *
   * Only when the `<tr>` itself has focus: a control inside a cell — a menu button, an
   * inline `Select` — owns its own arrow keys, and a table that stole them would break it.
   */
  const handleRowKeyDown = (event: React.KeyboardEvent<HTMLTableRowElement>, row: Row) => {
    if (event.target !== event.currentTarget) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    const elements = rowElements();
    const index = elements.indexOf(event.currentTarget);

    /** Move focus to a row by index, if there is one there. */
    const focusRow = (next: number) => {
      const target = elements[next];
      if (!target) return;
      event.preventDefault();
      target.focus();
    };

    switch (event.key) {
      case 'ArrowDown':
        focusRow(index + 1);
        return;
      case 'ArrowUp':
        focusRow(index - 1);
        return;
      case 'Home':
        focusRow(0);
        return;
      case 'End':
        focusRow(elements.length - 1);
        return;
      case 'Enter':
        if (onRowActivate) {
          event.preventDefault();
          onRowActivate(row);
        }
        return;
      case '.': {
        // Reach the row's actions. They are revealed by `:focus-within`, so simply moving
        // the keyboard into the cell is the whole interaction.
        const actions = event.currentTarget.querySelector<HTMLElement>(ROW_ACTION_SELECTOR);
        if (actions) {
          event.preventDefault();
          actions.focus();
        }
        return;
      }
      default:
        break;
    }

    if (event.key === 'x' || event.key === 'X') {
      if (!selectable || (isRowSelectable && !isRowSelectable(row))) return;
      event.preventDefault();
      const id = getRowId(row);
      toggleRow(id, !selected.has(id));
    }
  };

  /** What the body shows: placeholders, a failure, nothing at all, or the rows. */
  const bodyState: 'loading' | 'error' | 'empty' | 'rows' = loading
    ? 'loading'
    : error
      ? 'error'
      : rows.length === 0
        ? 'empty'
        : 'rows';

  const scrolls = Boolean(scrollX) || maxBodyHeight !== undefined;

  return (
    <div className={cn('flex flex-col gap-3', className)} {...props}>
      <div className={cn(TABLE_CARD_CLASS, dense && 'table-dense')}>
        {toolbar}

        <div
          className={cn(scrollX && 'overflow-x-auto', maxBodyHeight !== undefined && 'overflow-y-auto')}
          style={maxBodyHeight !== undefined ? { maxHeight: maxBodyHeight } : undefined}
          // A scroll container that the keyboard can reach, so a wide table is not a
          // pointer-only surface (WCAG 2.1.1). Only when it actually scrolls — an inert
          // `tabindex` would be a Tab stop that does nothing.
          tabIndex={scrolls ? 0 : undefined}
          // Named or not at all: an unnamed `region` is not a landmark, only noise.
          role={scrolls && caption ? 'region' : undefined}
          aria-label={scrolls && caption ? caption : undefined}
        >
          <table
            className={cn(
              'w-full border-separate border-spacing-0 text-sm text-fg',
              scrollX && SCROLL_X_MIN_WIDTH
            )}
          >
            {caption ? <caption className="sr-only">{caption}</caption> : null}

            <thead>
              <tr>
                {selectable ? (
                  <th scope="col" className={cn(TH_CLASS, CHECK_CELL_CLASS)}>
                    <Checkbox
                      checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                      onCheckedChange={(next) => toggleAll(next === true)}
                      disabled={selectableRows.length === 0}
                      aria-label={allSelected ? 'Clear selection' : 'Select all rows'}
                    />
                  </th>
                ) : null}

                {columns.map((column) => (
                  <DataTableHeaderCell
                    key={column.id}
                    column={column as DataTableColumn<unknown>}
                    sort={sort}
                    onSortChange={onSortChange}
                  />
                ))}
              </tr>
            </thead>

            <tbody ref={bodyRef}>
              {bodyState === 'loading'
                ? Array.from({ length: skeletonRows }, (_, index) => (
                    <tr key={`skeleton-${index}`} aria-hidden>
                      {selectable ? <td className={cn(TD_CLASS, CHECK_CELL_CLASS)} /> : null}
                      {columns.map((column) => (
                        <td
                          key={column.id}
                          className={cn(TD_CLASS, column.align === 'end' && 'text-right')}
                        >
                          {column.actions ? null : (
                            <Skeleton
                              className="h-3 max-w-full"
                              style={{ width: column.skeletonWidth ?? '60%' }}
                            />
                          )}
                        </td>
                      ))}
                    </tr>
                  ))
                : null}

              {bodyState === 'error' ? (
                <tr>
                  <td colSpan={columnCount} className="border-b border-border p-card">
                    <div role="alert" className="text-sm text-danger-fg">
                      {error}
                    </div>
                  </td>
                </tr>
              ) : null}

              {bodyState === 'empty' ? (
                <tr>
                  <td colSpan={columnCount} className="border-b border-border p-card">
                    {empty ?? (
                      <p className="text-center text-sm text-fg-muted">Nothing to show yet.</p>
                    )}
                  </td>
                </tr>
              ) : null}

              {bodyState === 'rows'
                ? rows.map((row, index) => {
                    const id = getRowId(row);
                    const isSelected = selected.has(id);
                    const canSelect = !isRowSelectable || isRowSelectable(row);
                    const label = getRowLabel?.(row);

                    return (
                      <tr
                        key={id}
                        data-row-id={id}
                        data-selected={isSelected || undefined}
                        tabIndex={tabStopId === id ? 0 : -1}
                        onFocus={() => setActiveRowId(id)}
                        onKeyDown={(event) => handleRowKeyDown(event, row)}
                        onClick={onRowActivate ? () => onRowActivate(row) : undefined}
                        className={cn(
                          'group transition-colors duration-[var(--dur-fast)]',
                          // The last row's hairline is the card's own bottom edge.
                          '[&:last-child>td]:border-b-0',
                          'hover:bg-subtle data-[selected]:bg-accent-soft',
                          // The focus ring is the app-wide `*:focus-visible` rule in
                          // globals.css, which is unlayered and beats any utility here.
                          'focus-visible:outline-none',
                          onRowActivate && 'cursor-pointer',
                          rowClassName?.(row)
                        )}
                      >
                        {selectable ? (
                          <td
                            className={cn(TD_CLASS, CHECK_CELL_CLASS)}
                            // A click on the checkbox is a selection, not an activation.
                            onClick={(event) => event.stopPropagation()}
                          >
                            <Checkbox
                              checked={isSelected}
                              disabled={!canSelect}
                              onCheckedChange={(next) => toggleRow(id, next === true)}
                              aria-label={label ? `Select ${label}` : 'Select row'}
                            />
                          </td>
                        ) : null}

                        {columns.map((column) => (
                          <td
                            key={column.id}
                            className={cn(
                              TD_CLASS,
                              column.align === 'end' && 'text-right',
                              column.className
                            )}
                            onClick={
                              column.actions ? (event) => event.stopPropagation() : undefined
                            }
                          >
                            {column.actions ? (
                              <div
                                data-row-actions=""
                                className={cn(
                                  'flex items-center justify-end gap-0.5',
                                  // Revealed by hover or by the keyboard reaching inside —
                                  // `opacity` rather than `hidden`, so the buttons keep their
                                  // place in the tab order and their names in the a11y tree.
                                  'opacity-0 transition-opacity duration-[var(--dur-fast)]',
                                  'group-hover:opacity-100 group-focus-within:opacity-100',
                                  'group-data-[selected]:opacity-100'
                                )}
                              >
                                {column.cell(row, index)}
                              </div>
                            ) : (
                              column.cell(row, index)
                            )}
                          </td>
                        ))}
                      </tr>
                    );
                  })
                : null}
            </tbody>
          </table>
        </div>

        {footer}
      </div>

      {/* Always mounted while the table has a selection model, so a screen reader hears the
          count *change* rather than hearing a region appear. Empty selection, nothing said. */}
      {selectable ? (
        <p role="status" aria-live="polite" className="sr-only">
          {selected.size > 0 ? `${selected.size} selected` : ''}
        </p>
      ) : null}

      {selectable && selected.size > 0 ? (
        <DataTableBulkBar
          count={selected.size}
          onClear={() => onSelectionChange?.([])}
          actions={bulkActions}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Header cell
// ---------------------------------------------------------------------------------------

/**
 * One `<th>`: the caps label, and — when the column is sortable — the button that cycles it.
 *
 * The sort control is a real `<button>` inside the header rather than a click handler on the
 * `<th>`, because only the button gives it a role, a name, a Tab stop and a focus ring.
 * `aria-sort` stays on the `<th>`, which is where the ARIA spec puts it.
 *
 * @param props The column, the table's sort state, and the change handler.
 * @returns The header cell.
 */
function DataTableHeaderCell({
  column,
  sort,
  onSortChange,
}: {
  column: DataTableColumn<unknown>;
  sort?: DataTableSortState | null;
  onSortChange?: (next: DataTableSortState | null) => void;
}) {
  const isSorted = sort?.column === column.id;
  const SortIcon = !isSorted ? ArrowUpDown : sort?.direction === 'asc' ? ArrowUp : ArrowDown;

  const label = column.headerLabel ? (
    <span className="sr-only">{column.headerLabel}</span>
  ) : null;

  return (
    <th
      scope="col"
      aria-sort={ariaSortFor(column, sort)}
      className={cn(
        TH_CLASS,
        column.align === 'end' && 'text-right',
        isSorted && 'text-fg',
        column.headerClassName
      )}
    >
      {column.sortable && onSortChange ? (
        <button
          type="button"
          onClick={() => onSortChange(nextSortState(sort ?? null, column.id))}
          className={cn(
            'inline-flex w-full items-center gap-1 text-inherit uppercase',
            'transition-colors duration-[var(--dur-fast)] hover:text-fg',
            'focus-visible:outline-none',
            column.align === 'end' && 'justify-end'
          )}
        >
          {label}
          {column.header}
          <SortIcon
            className={cn('size-3 shrink-0', isSorted ? 'opacity-100' : 'opacity-50')}
            aria-hidden
          />
        </button>
      ) : (
        <>
          {label}
          {column.header}
        </>
      )}
    </th>
  );
}

// ---------------------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------------------

export type DataTableToolbarProps = React.HTMLAttributes<HTMLDivElement>;

/**
 * The strip above a table: search, filter chips, a view switch, a sort menu.
 *
 * It wraps rather than scrolls, so a narrow viewport or the Largest font scale gives it a
 * second line instead of hiding half the controls.
 */
const DataTableToolbar = React.forwardRef<HTMLDivElement, DataTableToolbarProps>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5',
        className
      )}
      {...props}
    />
  )
);
DataTableToolbar.displayName = 'DataTableToolbar';

/** The elastic gap that pushes what follows it to the toolbar's trailing edge. */
const DataTableToolbarSpacer = React.forwardRef<
  HTMLSpanElement,
  React.HTMLAttributes<HTMLSpanElement>
>(({ className, ...props }, ref) => (
  <span ref={ref} aria-hidden className={cn('flex-1', className)} {...props} />
));
DataTableToolbarSpacer.displayName = 'DataTableToolbarSpacer';

export interface DataTableSearchProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** The field's accessible name — required, since the magnifier is decorative. */
  'aria-label': string;
}

/**
 * The toolbar's filter box: a `search` input with the magnifier drawn inside it.
 *
 * `type="search"` so the browser offers its own clear affordance and announces the field
 * for what it is; the icon is `aria-hidden`, because "search" is already in the role.
 */
const DataTableSearch = React.forwardRef<HTMLInputElement, DataTableSearchProps>(
  ({ className, ...props }, ref) => (
    <div className="relative flex items-center">
      <Search
        className="pointer-events-none absolute left-2.5 size-[var(--icon-button)] text-fg-muted"
        aria-hidden
      />
      <Input
        ref={ref}
        type="search"
        className={cn('h-[var(--control-h-sm)] w-[16.25rem] max-w-full pl-8 text-sm', className)}
        {...props}
      />
    </div>
  )
);
DataTableSearch.displayName = 'DataTableSearch';

export interface DataTableFilterChipProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  /** Whether this facet is currently narrowing the list. */
  active?: boolean;
  /** How many rows the facet would leave, shown faintly after the label. */
  count?: number;
}

/**
 * A filter chip — one facet of the list, on or off.
 *
 * `aria-pressed` rather than a checkbox role: a chip is a toggle button that re-runs the
 * query, and that is the role that says so.
 */
const DataTableFilterChip = React.forwardRef<HTMLButtonElement, DataTableFilterChipProps>(
  ({ className, active = false, count, children, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      // Always stated, never merely absent: a chip is a toggle whether or not it is on, and
      // a group where only the active one announces its state is a group you cannot read.
      aria-pressed={active}
      className={cn(
        'inline-flex h-[var(--control-h-sm)] shrink-0 items-center gap-1.5 rounded-full px-2.5',
        'text-xs font-medium whitespace-nowrap',
        'transition-[background-color,box-shadow,color] duration-[var(--dur-fast)]',
        'focus-visible:outline-none',
        active
          ? 'bg-fg text-surface'
          : 'bg-surface text-fg-muted shadow-[inset_0_0_0_1px_var(--border-strong)] hover:bg-subtle hover:text-fg',
        className
      )}
      {...props}
    >
      {children}
      {count !== undefined ? (
        <span className={cn('tabular-nums', active ? 'opacity-70' : 'text-fg-faint')}>{count}</span>
      ) : null}
    </button>
  )
);
DataTableFilterChip.displayName = 'DataTableFilterChip';

// ---------------------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------------------

/** The leading line of a cell — the thing the row *is*. */
const DataTableCellPrimary = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('font-medium whitespace-nowrap text-fg', className)} {...props} />
));
DataTableCellPrimary.displayName = 'DataTableCellPrimary';

/**
 * The second line under it — a slug, an owner, a timestamp.
 *
 * `--fg-muted` rather than the mockup's `--fg-subtle`: at 12 px this is body text, and
 * `tests/hive-design-tokens.test.ts` only clears `--fg-subtle` for large text and non-text
 * marks.
 */
const DataTableCellSub = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('mt-px text-xs text-fg-muted', className)} {...props} />
  )
);
DataTableCellSub.displayName = 'DataTableCellSub';

// ---------------------------------------------------------------------------------------
// Foot & pager
// ---------------------------------------------------------------------------------------

/** The strip under the table: what is being shown on the left, how to move on the right. */
const DataTableFoot = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'flex flex-wrap items-center justify-between gap-3 border-t border-border px-3.5 py-2.5',
        'text-xs text-fg-muted',
        className
      )}
      {...props}
    />
  )
);
DataTableFoot.displayName = 'DataTableFoot';

/**
 * The `Showing 1–25 of 240` sentence, in the app's one phrasing.
 *
 * @param page The 1-based page number.
 * @param pageSize How many rows a page holds.
 * @param total How many rows matched in total.
 * @param noun What one row is, singular — `'project'`, `'key'`.
 * @returns The sentence, or `'No <noun>s'` when nothing matched.
 */
export function dataTableRangeLabel(
  page: number,
  pageSize: number,
  total: number,
  noun = 'row'
): string {
  if (total === 0) return `No ${noun}s`;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  return `Showing ${first}–${last} of ${total} ${total === 1 ? noun : `${noun}s`}`;
}

/**
 * The page numbers a pager shows: the ends, the neighbourhood of the current page, and
 * `null` wherever a run was left out.
 *
 * @param page The 1-based current page.
 * @param pageCount How many pages there are.
 * @param window How many pages to show either side of the current one.
 * @returns Page numbers in order, with `null` standing for an elision.
 */
export function dataTablePageWindow(
  page: number,
  pageCount: number,
  window = 1
): Array<number | null> {
  const wanted = new Set<number>([1, pageCount]);
  for (let offset = -window; offset <= window; offset += 1) wanted.add(page + offset);

  const shown = Array.from(wanted)
    .filter((candidate) => candidate >= 1 && candidate <= pageCount)
    .sort((a, b) => a - b);

  const out: Array<number | null> = [];
  let previous = 0;
  for (const candidate of shown) {
    if (previous && candidate - previous > 1) out.push(null);
    out.push(candidate);
    previous = candidate;
  }
  return out;
}

export interface DataTablePagerProps extends React.HTMLAttributes<HTMLElement> {
  /** The 1-based current page. */
  page: number;
  /** How many pages there are. A pager for one page renders nothing. */
  pageCount: number;
  /** Called with the 1-based page that was chosen. */
  onPageChange: (page: number) => void;
  /** The navigation landmark's name, when a screen has more than one pager. */
  label?: string;
}

/**
 * Previous / page numbers / Next.
 *
 * A `<nav>` so it is a landmark, with `aria-current="page"` on the page you are on — which
 * is how a screen reader answers "where am I?" without being told in the button's text.
 */
const DataTablePager = React.forwardRef<HTMLElement, DataTablePagerProps>(
  ({ className, page, pageCount, onPageChange, label = 'Pagination', ...props }, ref) => {
    if (pageCount <= 1) return null;

    return (
      <nav
        ref={ref}
        aria-label={label}
        className={cn('inline-flex items-center gap-0.5', className)}
        {...props}
      >
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          className="px-1.5"
        >
          <ChevronLeft className="size-[var(--icon-button)]" aria-hidden />
        </Button>

        {dataTablePageWindow(page, pageCount).map((candidate, index) =>
          candidate === null ? (
            <span key={`gap-${index}`} aria-hidden className="px-1 text-fg-faint">
              …
            </span>
          ) : (
            <Button
              key={candidate}
              type="button"
              variant={candidate === page ? 'soft' : 'ghost'}
              size="sm"
              aria-label={`Page ${candidate}`}
              aria-current={candidate === page ? 'page' : undefined}
              onClick={() => onPageChange(candidate)}
              className="min-w-7 px-1.5 tabular-nums"
            >
              {candidate}
            </Button>
          )
        )}

        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Next page"
          disabled={page >= pageCount}
          onClick={() => onPageChange(page + 1)}
          className="px-1.5"
        >
          <ChevronRight className="size-[var(--icon-button)]" aria-hidden />
        </Button>
      </nav>
    );
  }
);
DataTablePager.displayName = 'DataTablePager';

// ---------------------------------------------------------------------------------------
// Bulk bar
// ---------------------------------------------------------------------------------------

export interface DataTableBulkBarProps extends React.HTMLAttributes<HTMLDivElement> {
  /** How many rows are selected. */
  count: number;
  /** Called by the trailing Clear button. */
  onClear: () => void;
  /** The verbs this selection affords — `DataTableBulkAction`s. */
  actions?: React.ReactNode;
  /** What one selected row is, for the count sentence. */
  noun?: string;
}

/**
 * The bar that rises from the bottom of the page while rows are selected.
 *
 * `sticky bottom-4` rather than `fixed`: it belongs to *this* table, so it stays inside the
 * table's column and never floats over a neighbouring panel. `DataTable` mounts it only
 * while the selection is non-empty — DESIGN.md §8: "Selection reveals a sticky `.bulk-bar`."
 *
 * Inverted, because it is the one thing on screen that is temporarily more important than
 * the list behind it: the page's ink becomes its ground.
 */
const DataTableBulkBar = React.forwardRef<HTMLDivElement, DataTableBulkBarProps>(
  ({ className, count, onClear, actions, noun = 'row', ...props }, ref) => (
    <div
      ref={ref}
      role="group"
      aria-label="Bulk actions"
      className={cn(
        'sticky bottom-4 z-15 mx-auto flex w-max max-w-full flex-wrap items-center gap-2.5',
        'rounded-lg bg-fg py-2 pr-2 pl-3.5 text-sm text-surface shadow-[var(--shadow-lg)]',
        className
      )}
      {...props}
    >
      <span className="tabular-nums">
        {count} {count === 1 ? noun : `${noun}s`} selected
      </span>
      {actions}
      <DataTableBulkAction aria-label="Clear selection" onClick={onClear} className="px-1.5">
        <X className="size-[var(--icon-button)]" aria-hidden />
      </DataTableBulkAction>
    </div>
  )
);
DataTableBulkBar.displayName = 'DataTableBulkBar';

export type DataTableBulkActionProps = ButtonProps;

/**
 * One verb in the bulk bar.
 *
 * A `Button` whose chrome is re-cut for the inverted bar: a translucent wash of the bar's
 * *text* colour, so it reads the same on the six dark palettes as on the three light ones —
 * a fixed white overlay would vanish on the light ones.
 */
const DataTableBulkAction = React.forwardRef<HTMLButtonElement, DataTableBulkActionProps>(
  ({ className, ...props }, ref) => (
    <Button
      ref={ref}
      type="button"
      variant="ghost"
      size="sm"
      className={cn(
        'bg-surface/12 text-surface shadow-none hover:bg-surface/20 hover:text-surface',
        className
      )}
      {...props}
    />
  )
);
DataTableBulkAction.displayName = 'DataTableBulkAction';

export {
  DataTable,
  DataTableBulkAction,
  DataTableBulkBar,
  DataTableCellPrimary,
  DataTableCellSub,
  DataTableFilterChip,
  DataTableFoot,
  DataTablePager,
  DataTableSearch,
  DataTableToolbar,
  DataTableToolbarSpacer,
};
