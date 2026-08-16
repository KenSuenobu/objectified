'use client';

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../../../lib/utils';

/**
 * Spinner — the Hive busy indicator (HIVE-2.1, #5280).
 *
 * `docs/mockups/assets/hive.css` §14 (`.spinner`): a ring in the hairline colour with one
 * accent quadrant. Reserved for work whose result has no shape yet (a request in flight, a
 * button saving); anything with a known layout gets a {@link ./Skeleton} instead.
 */
const spinnerVariants = cva(
  'inline-block animate-spin rounded-full border-2',
  {
    variants: {
      size: {
        xs: 'size-3 border-[1.5px]',
        sm: 'size-4 border-2',
        md: 'size-6 border-2',
        lg: 'size-10 border-[3px]',
      },
      tone: {
        /** Accent quadrant on a hairline ring — the default. */
        default: 'border-border-strong border-t-accent',
        /** The whole ring muted, for a spinner inside already-quiet chrome. */
        muted: 'border-border border-t-fg-subtle',
        /** On a filled control or a dark overlay. */
        light: 'border-white/30 border-t-white',
      },
    },
    defaultVariants: {
      size: 'md',
      tone: 'default',
    },
  }
);

export interface SpinnerProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof spinnerVariants> {
  label?: string;
}

export const Spinner = React.forwardRef<HTMLSpanElement, SpinnerProps>(
  ({ className, size, tone, label = 'Loading', ...props }, ref) => {
    return (
      <span
        ref={ref}
        role="status"
        aria-label={label}
        className={cn(spinnerVariants({ size, tone }), className)}
        {...props}
      />
    );
  }
);
Spinner.displayName = 'Spinner';

