'use client';

import * as React from 'react';
import * as LabelPrimitive from '@radix-ui/react-label';
import { cn } from '../../../../lib/utils';

/**
 * Label — the Hive field label (HIVE-2.1, #5280).
 *
 * `docs/mockups/assets/hive.css` §9 (`.field > label`): body ink at the `sm` step, medium
 * weight, sitting directly above its control. It is deliberately *not* muted — a label
 * names the field, and muting it makes a form read as disabled.
 */
const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn(
      'text-sm font-medium leading-none tracking-[0.01em] text-fg',
      'peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
      className
    )}
    {...props}
  />
));
Label.displayName = LabelPrimitive.Root.displayName;

export { Label };
