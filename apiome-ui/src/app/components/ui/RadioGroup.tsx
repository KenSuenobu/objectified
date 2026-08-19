'use client';

import * as React from 'react';
import { cn } from '../../../../lib/utils';

export interface RadioGroupProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange' | 'defaultValue'> {
  value?: string;
  onValueChange?: (value: string) => void;
  className?: string;
  children: React.ReactNode;
}

export interface RadioGroupItemProps extends React.InputHTMLAttributes<HTMLInputElement> {
  value: string;
  label?: React.ReactNode;
  /**
   * Classes for the `<input>` itself.
   *
   * For a choice row that draws its *own* selected mark — HIVE-7.4's repository picker paints
   * the chosen row and adds a tick — where a second, native dot beside it would say the same
   * thing twice. Pass `sr-only` there: the input keeps its place in the tab order and in the
   * accessibility tree, and `:has(input:focus-visible)` on the row is what puts the focus ring
   * back where the reader can see it.
   */
  inputClassName?: string;
}

/**
 * RadioGroup — the Hive one-of-many control (HIVE-2.1, #5280).
 *
 * Authority: `docs/mockups/assets/hive.css` §9 (`.radio`), `docs/mockups/DESIGN.md` §7.
 *
 * The dot is drawn by the browser and tinted with `accent-color`, which is the one way to
 * get a native radio to follow a theme swap without re-implementing its states. Sizing and
 * spacing are on the `<input>` itself rather than on `label > input`, so a choice row may
 * contain a nested field without that field picking up radio chrome.
 */
export const RadioGroup = React.forwardRef<HTMLDivElement, RadioGroupProps>(
  ({ className, value, onValueChange, children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        role="radiogroup"
        className={cn('flex flex-col gap-2', className)}
        {...props}
      >
        {React.Children.map(children, (child) => {
          if (React.isValidElement<RadioGroupItemProps>(child)) {
            return React.cloneElement(child, {
              checked: child.props.value === value,
              onChange: () => onValueChange?.(child.props.value),
            });
          }
          return child;
        })}
      </div>
    );
  }
);
RadioGroup.displayName = 'RadioGroup';

export const RadioGroupItem = React.forwardRef<HTMLInputElement, RadioGroupItemProps>(
  ({ className, value, label, inputClassName, ...props }, ref) => {
    return (
      <label
        className={cn(
          'inline-flex cursor-pointer items-center gap-2 text-sm text-fg',
          props.disabled && 'cursor-not-allowed opacity-50',
          className
        )}
      >
        <input
          ref={ref}
          type="radio"
          value={value}
          className={cn(
            'size-4 shrink-0 accent-accent',
            'focus-visible:outline-none disabled:cursor-not-allowed',
            inputClassName
          )}
          {...props}
        />
        {label && <span>{label}</span>}
      </label>
    );
  }
);
RadioGroupItem.displayName = 'RadioGroupItem';
