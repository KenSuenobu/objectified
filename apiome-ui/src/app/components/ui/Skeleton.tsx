'use client';

import * as React from 'react';
import { cn } from '../../../../lib/utils';

/**
 * Skeleton — the Hive loading placeholder (HIVE-2.1, #5280).
 *
 * `docs/mockups/assets/hive.css` §14 (`.skeleton`): the inset surface, pulsing. It is shaped
 * like the content it stands in for — DESIGN.md §8 asks for skeletons rather than spinners
 * wherever the final layout is already known. HIVE-2.5 adds the shaped presets.
 */
const Skeleton = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      'animate-pulse rounded-sm bg-inset',
      className
    )}
    {...props}
  />
));
Skeleton.displayName = 'Skeleton';

export { Skeleton };

