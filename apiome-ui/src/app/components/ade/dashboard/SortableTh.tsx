'use client';

import type { ReactNode } from 'react';
import { ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-react';

/**
 * A dashboard table header cell that sorts its column.
 *
 * Extracted when the third table needed one (the Versions timeline, Type collections, and the
 * primitives list all render the same control). The idle state keeps a dimmed both-ways arrow so a
 * column reads as *sortable* rather than sorted, and `aria-sort` on the `th` carries the state to
 * assistive tech.
 *
 * Generic over the caller's column union, so a typo in `column` is a compile error rather than a
 * header that silently never matches.
 */
export default function SortableTh<C extends string>({
  column,
  activeColumn,
  direction,
  onSort,
  className,
  align = 'left',
  testId,
  ariaLabel,
  children,
}: {
  column: C;
  /** The column currently sorted, or `null` when the table is in its unsorted order. */
  activeColumn: C | null;
  direction: 'asc' | 'desc';
  onSort: (column: C) => void;
  className: string;
  /** `right` mirrors the label/arrow order so the control hugs a right-aligned column. */
  align?: 'left' | 'right';
  testId?: string;
  ariaLabel?: string;
  children: ReactNode;
}) {
  const active = activeColumn === column;
  return (
    <th
      scope="col"
      className={className}
      aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        data-testid={testId}
        aria-label={ariaLabel}
        className={`inline-flex max-w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-xs font-medium uppercase tracking-wider text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white ${
          align === 'right' ? 'flex-row-reverse' : ''
        }`}
      >
        <span className="truncate">{children}</span>
        {active ? (
          direction === 'asc' ? (
            <ArrowUp className="h-3.5 w-3.5 shrink-0 text-indigo-600 dark:text-indigo-400" aria-hidden />
          ) : (
            <ArrowDown className="h-3.5 w-3.5 shrink-0 text-indigo-600 dark:text-indigo-400" aria-hidden />
          )
        ) : (
          <ArrowUpDown className="h-3.5 w-3.5 shrink-0 opacity-40" aria-hidden />
        )}
      </button>
    </th>
  );
}
