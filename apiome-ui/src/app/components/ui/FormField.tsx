'use client';

import * as React from 'react';
import { CircleAlert } from 'lucide-react';
import { cn } from '../../../../lib/utils';

export interface FormFieldProps {
  /** The field's name. Rendered above the control. */
  label?: string;
  /** A sentence under the control explaining what a good value looks like. */
  helperText?: string;
  /** What went wrong. Replaces the hint, tints the control's hairline and adds an icon. */
  error?: string;
  /** Show the required marker beside the label. */
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}

/**
 * FormField — label above, control, hint or error below (HIVE-2.1, #5280).
 *
 * Authority: `docs/mockups/assets/hive.css` §9 (`.field`, `.hint`, `.error`, `.is-invalid`),
 * `docs/mockups/DESIGN.md` §7.
 *
 * When `error` is set the field also marks its control `aria-invalid`, which is what turns
 * the hairline red (`.hive-control[aria-invalid]` in globals.css) *and* what a screen reader
 * announces — one flag, so the two can never disagree. A control that already sets the
 * attribute itself is left alone.
 */
export const FormField = React.forwardRef<HTMLDivElement, FormFieldProps>(
  ({ label, helperText, error, required, className, children }, ref) => {
    const invalid = Boolean(error);

    // Mark the control rather than the wrapper: `aria-invalid` belongs on the thing the
    // user is typing into. Only elements are touched, and only when they have not already
    // said something about their own validity.
    const control = invalid
      ? React.Children.map(children, (child) => {
          if (!React.isValidElement<{ 'aria-invalid'?: React.AriaAttributes['aria-invalid'] }>(child)) {
            return child;
          }
          if (child.props['aria-invalid'] !== undefined) return child;
          return React.cloneElement(child, { 'aria-invalid': true });
        })
      : children;

    return (
      <div ref={ref} data-invalid={invalid || undefined} className={cn('flex flex-col gap-1.5', className)}>
        {label && (
          <label className="text-sm font-medium tracking-[0.01em] text-fg">
            {label}
            {required && (
              <span className="ml-0.5 text-danger" aria-hidden="true">
                *
              </span>
            )}
          </label>
        )}
        {control}
        {error ? (
          <p className="flex items-center gap-1 text-xs text-danger-fg">
            <CircleAlert className="size-3 shrink-0" aria-hidden="true" />
            {error}
          </p>
        ) : (
          helperText && <p className="text-xs text-fg-subtle">{helperText}</p>
        )}
      </div>
    );
  }
);
FormField.displayName = 'FormField';
