'use client';

import * as React from 'react';
import { cn } from '../../../../lib/utils';

export interface SwitchProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'onChange' | 'type'
> {
  checked?: boolean;
  /** Tri-state mixed (partial group). Surfaces as `aria-checked="mixed"`. */
  indeterminate?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

/**
 * Switch — the Hive toggle (HIVE-2.1, #5280).
 *
 * Authority: `docs/mockups/assets/hive.css` §9 (`.switch`), `docs/mockups/DESIGN.md` §7.
 *
 * A 34 × 20 track carrying a 16 px thumb, inset track when off and accent when on. **Mixed**
 * — a group where some members are on — parks the thumb in the middle over the soft accent,
 * so "some" never looks like "all".
 *
 * The visible parts are styled directly rather than through descendant selectors, so a
 * switch row may nest arbitrary content (a hint, a field) without inheriting its chrome.
 */
const Switch = React.forwardRef<HTMLInputElement, SwitchProps>(
  ({ className, checked, indeterminate = false, onCheckedChange, disabled, ...props }, ref) => {
    const inputRef = React.useRef<HTMLInputElement | null>(null);

    React.useImperativeHandle(ref, () => inputRef.current as HTMLInputElement);

    React.useEffect(() => {
      if (inputRef.current) {
        inputRef.current.indeterminate = indeterminate;
      }
    }, [indeterminate]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      onCheckedChange?.(e.target.checked);
    };

    return (
      <label
        className={cn(
          'relative inline-flex shrink-0 cursor-pointer items-center',
          disabled && 'cursor-not-allowed opacity-50'
        )}
      >
        <input
          type="checkbox"
          role="switch"
          ref={inputRef}
          checked={checked}
          onChange={handleChange}
          disabled={disabled}
          aria-checked={indeterminate ? 'mixed' : Boolean(checked)}
          className="peer sr-only"
          {...props}
        />
        <span
          className={cn(
            'h-5 w-[2.125rem] rounded-full bg-inset shadow-[inset_0_0_0_1px_var(--border)]',
            'transition-[background-color,box-shadow] duration-[var(--dur-base)]',
            'peer-checked:bg-accent peer-checked:shadow-none',
            indeterminate && 'bg-accent-soft shadow-none',
            className
          )}
        />
        <span
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute left-0.5 size-4 rounded-full bg-white',
            'shadow-[0_1px_2px_rgba(0,0,0,.25)]',
            'transition-transform duration-[var(--dur-base)] ease-out',
            checked && !indeterminate && 'translate-x-3.5',
            indeterminate && 'translate-x-[0.4375rem]'
          )}
        />
      </label>
    );
  }
);
Switch.displayName = 'Switch';

export { Switch };
