'use client';

import * as React from 'react';
import * as CheckboxPrimitive from '@radix-ui/react-checkbox';
import { Check, Minus } from 'lucide-react';
import { cn } from '../../../../lib/utils';

/**
 * Checkbox — the Hive tick box (HIVE-2.1, #5280).
 *
 * Authority: `docs/mockups/assets/hive.css` §9 (`.check > input`),
 * `docs/mockups/DESIGN.md` §7.
 *
 * A 16 px surface square with an inset hairline, filling with accent when ticked. Radix's
 * `indeterminate` state draws a dash rather than a tick, which is what a partially selected
 * table column needs.
 *
 * Styling lands on the box itself, never on `label > input`, so a checkbox may sit inside a
 * label alongside other controls without those inheriting its chrome.
 */
const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      'peer grid size-4 shrink-0 place-items-center rounded-xs bg-surface text-fg-on-accent',
      'shadow-[inset_0_0_0_1px_var(--border-strong)]',
      'transition-[background-color,box-shadow] duration-[var(--dur-fast)]',
      'focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
      'data-[state=checked]:bg-accent data-[state=checked]:shadow-none',
      'data-[state=indeterminate]:bg-accent data-[state=indeterminate]:shadow-none',
      className
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator className="grid place-items-center text-current">
      {props.checked === 'indeterminate' ? (
        <Minus className="size-3" aria-hidden="true" />
      ) : (
        <Check className="size-3" aria-hidden="true" />
      )}
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = CheckboxPrimitive.Root.displayName;

export { Checkbox };
