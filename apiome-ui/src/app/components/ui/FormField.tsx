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
  /**
   * The `id` of the control this field labels.
   *
   * A `<label>` with neither `for` nor the control nested inside it names nothing — axe's
   * `label` rule reports the control as unnamed, and clicking the text does not focus it.
   * The field cannot work the id out for itself: its child may be the control, or a wrapper
   * holding the control and a button beside it (HIVE-6.1's URL fields are exactly that), and
   * pointing `for` at a `<div>` is worse than pointing it nowhere. So the caller states it.
   */
  htmlFor?: string;
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
 *
 * The message itself is an `alert` and, when the field names its control with `htmlFor`, is
 * pointed at by that control's `aria-describedby` (HIVE-7.6, #5323). Without both, a
 * validation failure is a sentence a sighted reader sees appear and nobody else is told about
 * — which is what the hand-rolled fields this primitive replaced had each wired up for
 * themselves, in four different ways.
 */
export const FormField = React.forwardRef<HTMLDivElement, FormFieldProps>(
  ({ label, helperText, error, required, htmlFor, className, children }, ref) => {
    const invalid = Boolean(error);

    // The message's id, so the control can point at it. Derived from the control's own id
    // rather than generated, so the two cannot drift apart across a re-render; a field that
    // does not name its control has nothing to hang the association on and simply omits it.
    const errorId = invalid && htmlFor ? `${htmlFor}-error` : undefined;

    // Mark the control rather than the wrapper: `aria-invalid` belongs on the thing the
    // user is typing into. Only elements are touched, and only when they have not already
    // said something about their own validity.
    const control = invalid
      ? React.Children.map(children, (child) => {
          if (
            !React.isValidElement<{
              'aria-invalid'?: React.AriaAttributes['aria-invalid'];
              'aria-describedby'?: string;
            }>(child)
          ) {
            return child;
          }
          const patch: {
            'aria-invalid'?: true;
            'aria-describedby'?: string;
          } = {};
          if (child.props['aria-invalid'] === undefined) patch['aria-invalid'] = true;
          if (errorId && child.props['aria-describedby'] === undefined) {
            patch['aria-describedby'] = errorId;
          }
          return Object.keys(patch).length > 0 ? React.cloneElement(child, patch) : child;
        })
      : children;

    return (
      <div ref={ref} data-invalid={invalid || undefined} className={cn('flex flex-col gap-1.5', className)}>
        {label && (
          <label htmlFor={htmlFor} className="text-sm font-medium tracking-[0.01em] text-fg">
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
          <p id={errorId} role="alert" className="flex items-center gap-1 text-xs text-danger-fg">
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
