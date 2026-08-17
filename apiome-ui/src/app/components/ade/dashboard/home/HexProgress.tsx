'use client';

/**
 * `<HexProgress>` — steps done, drawn as a row of honeycomb cells (HIVE-4.6, #5300).
 *
 * Authority: `docs/mockups/assets/hive.css` `.hex-grid` and `docs/mockups/home/overview.html`,
 * where the first-run checklist carries one beside its dismiss button. `DESIGN.md` §2 lists the
 * hexagon as the brand's silhouette and the first-run checklist as one of the places honey is
 * allowed to appear, which is what this mark is for.
 *
 * It is **decorative**. The cells say the same thing as the "3 / 5 done" badge next to them, and
 * a mark that repeats adjacent text is noise to a screen reader — so the row is `aria-hidden` and
 * the badge is the accessible statement of progress. The cells still carry a `title` for a mouse
 * reader.
 *
 * Cells are `<span>`s rather than SVG polygons because the hexagon is a `clip-path` in the
 * stylesheet: at six cells the shape is one CSS declaration reused, and it inherits the honey
 * token rather than restating a fill per cell.
 */

import * as React from 'react';
import { cn } from '@lib/utils';

/** Props for {@link HexProgress}. */
export interface HexProgressProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** How many steps are done. Clamped into `0…total`. */
  done: number;
  /** How many steps there are. A `total` of zero draws nothing. */
  total: number;
}

/**
 * Draw the row.
 *
 * @param props See {@link HexProgressProps}; every other prop lands on the wrapper.
 * @returns One cell per step, the first `done` of them filled — or `null` for no steps.
 */
export function HexProgress({ done, total, className, ...rest }: HexProgressProps) {
  if (total <= 0) return null;
  const filled = Math.min(Math.max(0, Math.trunc(done)), total);

  return (
    <span
      aria-hidden
      title={`${filled} of ${total} steps`}
      className={cn('home-hex', className)}
      {...rest}
    >
      {Array.from({ length: total }, (_, index) => (
        <span key={index} className="home-hex__cell" data-on={index < filled ? 'true' : undefined} />
      ))}
    </span>
  );
}

export default HexProgress;
