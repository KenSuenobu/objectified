'use client';

import * as React from 'react';
import { cn } from '../../../../lib/utils';

/**
 * Skeleton — the Hive loading placeholder, and its shaped presets (HIVE-2.1 #5280,
 * HIVE-2.5 #5284).
 *
 * Authority: `docs/mockups/assets/hive.css` §14 (`.skeleton`) and `docs/mockups/DESIGN.md`
 * §8: *"Loading = skeletons shaped like the final content (never spinners in tables)"*.
 *
 * ### Why shape matters
 *
 * A centred spinner is honest about one thing — something is happening — and dishonest
 * about everything else: it gives no clue how much is coming, and when the content lands it
 * displaces the whole layout, so the reader's eye has to start over. A skeleton that is the
 * shape of the answer reserves the space, and the arrival is a fill rather than a jump.
 *
 * That only works if the placeholder is actually the right shape, which is why the presets
 * below exist. `<Skeleton className="h-40" />` over a table is a spinner with extra steps.
 *
 * | Preset | Stands in for |
 * | --- | --- |
 * | {@link Skeleton} | one bar — a cell, a chip, a title |
 * | {@link SkeletonText} | a paragraph, with a short last line |
 * | {@link SkeletonCard} | a card: leading tile, title, two lines, a chip row |
 * | {@link SkeletonCardGrid} | a grid of them |
 * | {@link SkeletonTableRows} | `<tr>`s for a table that is not yet a `DataTable` |
 *
 * `DataTable` draws its own rows from each column's `skeletonWidth`, so a list on the Hive
 * table primitive needs none of these.
 *
 * ### Announcing it
 *
 * A placeholder is decoration: every preset is `aria-hidden`, and the *region* that holds it
 * carries the announcement. {@link LoadingState} is that region; a caller placing skeletons
 * by hand should wrap them in one, or put `role="status"` and a visually hidden sentence on
 * the container itself.
 */

export type SkeletonProps = React.HTMLAttributes<HTMLDivElement>;

/**
 * One placeholder bar: the inset fill with the shimmer of `hive.css` §14 sweeping across it.
 *
 * The shimmer, the fill and the radius come from the `.hive-skeleton` rule in `globals.css`
 * — a class rather than utilities because a pseudo-element cannot be expressed as one, and
 * because reduced motion then reaches it through the app-wide rule that zeroes every
 * animation.
 *
 * @param props Standard `div` props; give it a size with `className` or `style`.
 * @returns The bar, hidden from assistive technology.
 */
const Skeleton = React.forwardRef<HTMLDivElement, SkeletonProps>(
  ({ className, ...props }, ref) => (
    <div ref={ref} aria-hidden className={cn('hive-skeleton', className)} {...props} />
  )
);
Skeleton.displayName = 'Skeleton';

export interface SkeletonTextProps extends React.HTMLAttributes<HTMLDivElement> {
  /** How many lines to draw. */
  lines?: number;
  /** Width of the last line — a paragraph does not end flush. */
  lastLineWidth?: string;
}

/**
 * A paragraph's worth of bars.
 *
 * @param props See {@link SkeletonTextProps}.
 * @returns The lines, at body leading so the block is the height the text will be.
 */
const SkeletonText = React.forwardRef<HTMLDivElement, SkeletonTextProps>(
  ({ className, lines = 3, lastLineWidth = '60%', ...props }, ref) => (
    <div ref={ref} className={cn('flex flex-col gap-2', className)} {...props}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          key={index}
          className="h-3"
          style={index === lines - 1 ? { width: lastLineWidth } : undefined}
        />
      ))}
    </div>
  )
);
SkeletonText.displayName = 'SkeletonText';

export interface SkeletonCardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Draw the leading icon tile — off for a card whose content starts with its title. */
  media?: boolean;
  /** How many chips to draw under the title (the mockups' badge row). */
  chips?: number;
  /** How many body lines to draw. */
  lines?: number;
}

/**
 * A card-shaped placeholder — the skeleton card of `sources/mcp-servers.html`.
 *
 * @param props See {@link SkeletonCardProps}.
 * @returns One card on the surface, with the same padding a real card has.
 */
const SkeletonCard = React.forwardRef<HTMLDivElement, SkeletonCardProps>(
  ({ className, media = true, chips = 3, lines = 2, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'flex flex-col gap-3 rounded-lg bg-surface p-[var(--card-pad)] shadow-sm',
        className
      )}
      {...props}
    >
      <div className="flex items-start gap-3">
        {media ? <Skeleton className="size-7 shrink-0 rounded-sm" /> : null}
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <Skeleton className="h-3.5 w-3/5" />
          <Skeleton className="h-2.5 w-4/5" />
        </div>
      </div>
      {chips > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {Array.from({ length: chips }, (_, index) => (
            // Three widths, cycled: a row of identical chips reads as a progress bar.
            <Skeleton
              key={index}
              className="h-4.5 rounded-full"
              style={{ width: ['4rem', '5.5rem', '3.25rem'][index % 3] }}
            />
          ))}
        </div>
      ) : null}
      {lines > 0 ? <SkeletonText lines={lines} lastLineWidth="45%" /> : null}
    </div>
  )
);
SkeletonCard.displayName = 'SkeletonCard';

export interface SkeletonCardGridProps extends SkeletonCardProps {
  /** How many cards to draw. */
  count?: number;
  /** The grid the real cards use, so the placeholder occupies the same columns. */
  gridClassName?: string;
}

/**
 * A grid of {@link SkeletonCard}s, for a card list that is still loading.
 *
 * @param props See {@link SkeletonCardGridProps}; card props pass through to each card.
 * @returns The grid.
 */
const SkeletonCardGrid = React.forwardRef<HTMLDivElement, SkeletonCardGridProps>(
  (
    {
      className,
      count = 3,
      gridClassName = 'grid gap-4 sm:grid-cols-2 xl:grid-cols-3',
      ...card
    },
    ref
  ) => (
    <div ref={ref} className={cn(gridClassName, className)}>
      {Array.from({ length: count }, (_, index) => (
        <SkeletonCard key={index} {...card} />
      ))}
    </div>
  )
);
SkeletonCardGrid.displayName = 'SkeletonCardGrid';

export interface SkeletonTableRowsProps
  extends React.HTMLAttributes<HTMLTableSectionElement> {
  /** How many placeholder rows to draw. */
  rows?: number;
  /**
   * A bar width per column — `['40%', '6rem', '20%']`.
   *
   * The array's length is the column count, so a caller states the shape once and the rows
   * match the header above them. Uniform bars would be a spinner in table clothing.
   *
   * An empty string draws the cell with no bar at all, which is what a row-actions column
   * wants: nothing loads into it, so a placeholder there would promise content that never
   * arrives.
   */
  columns: ReadonlyArray<string>;
  /** Classes for each `<td>`, so the placeholder inherits the table's own cell padding. */
  cellClassName?: string;
}

/**
 * `<tbody>` rows of placeholders, for a table that has not moved onto `DataTable` yet.
 *
 * DESIGN.md §8 forbids a spinner inside a table body, and the reason is mechanical: a
 * `colSpan` row collapses the column widths, so every column jumps sideways when the data
 * lands. Placeholder cells keep the grid.
 *
 * ```tsx
 * {loading ? (
 *   <SkeletonTableRows columns={['40%', '6rem', '20%', '4rem']} cellClassName="px-4 py-3" />
 * ) : (
 *   <tbody>…</tbody>
 * )}
 * ```
 *
 * @param props See {@link SkeletonTableRowsProps}.
 * @returns A `<tbody>` of placeholder rows, hidden from assistive technology.
 */
const SkeletonTableRows = React.forwardRef<HTMLTableSectionElement, SkeletonTableRowsProps>(
  ({ className, rows = 5, columns, cellClassName, ...props }, ref) => (
    <tbody ref={ref} aria-hidden className={className} {...props}>
      {Array.from({ length: rows }, (_, row) => (
        <tr key={row}>
          {columns.map((width, column) => (
            <td key={column} className={cellClassName}>
              {width ? <Skeleton className="h-3 max-w-full" style={{ width }} /> : null}
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  )
);
SkeletonTableRows.displayName = 'SkeletonTableRows';

export { Skeleton, SkeletonCard, SkeletonCardGrid, SkeletonTableRows, SkeletonText };
