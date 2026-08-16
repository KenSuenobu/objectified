'use client';

import * as React from 'react';
import { cn } from '../../../../lib/utils';

/** Geometry and colour shared by `Input`, `Textarea` and the `Select` trigger. */
export const CONTROL_FIELD_CLASS = [
  // `hive-control` carries the inset hairline and its hover/focus/invalid states. It has to
  // be CSS rather than a utility because the app-wide `*:focus-visible` ring is unlayered
  // and would otherwise win — see the "HIVE CONTROL CHROME" block in globals.css.
  'hive-control',
  'flex w-full min-w-0 rounded-md bg-surface px-3 text-sm text-fg',
  'placeholder:text-fg-faint',
  'transition-[box-shadow,background-color] duration-[var(--dur-fast)]',
  'focus-visible:outline-none',
  'disabled:cursor-not-allowed disabled:bg-subtle disabled:text-fg-subtle',
].join(' ');

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

/**
 * Input — the Hive text field (HIVE-2.1, #5280).
 *
 * Authority: `docs/mockups/assets/hive.css` §9 (`.input`), `docs/mockups/DESIGN.md` §7.
 *
 * A `--control-h` box on the surface colour with a hairline drawn *inside* it, so the field
 * keeps its full height and follows the density preference. Invalidity is read from
 * `aria-invalid`, which is also what assistive technology reads — the red hairline and the
 * announcement can therefore never disagree.
 */
const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(CONTROL_FIELD_CLASS, 'h-[var(--control-h)]', className)}
        ref={ref}
        {...props}
      />
    );
  }
);
Input.displayName = 'Input';

export { Input };
