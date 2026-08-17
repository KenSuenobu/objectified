'use client';

import * as React from 'react';
import { CircleAlert } from 'lucide-react';
import { Input } from '@/app/components/ui/Input';
import { cn } from '../../../../lib/utils';

/**
 * AuthField — a labelled text field with a leading glyph (HIVE-4.1, #5295).
 *
 * Authority: `docs/mockups/assets/hive.css` §9 (`.field`, `.input-wrap`, `.error`) and the
 * auth mockups, every one of which puts a mail / lock / user icon inside the box.
 *
 * Why not `FormField`: that primitive renders its own `<label>` with no `htmlFor`, so the
 * control is not reachable by accessible name — and the front door's whole a11y contract
 * (OLO-3.5) is that `getByLabelText('Email Address')` resolves. Here the association is
 * explicit and the label may also carry something on its trailing edge, which is where the
 * "Forgot your password?" link lives in the mockup.
 *
 * Invalidity is passed to the control as `aria-invalid`, the one flag that both reddens the
 * hairline (`.hive-control[aria-invalid]`) and is announced — so the ring and the
 * announcement can never disagree. Same rule as `FormField`.
 */
export interface AuthFieldProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'id'> {
  /** The control's `id`; the label points at it and callers query the page by it. */
  id: string;
  /** The field's visible name. */
  label: React.ReactNode;
  /** The glyph shown inside the control's box — a `lucide-react` icon. */
  icon: React.ReactNode;
  /** Optional trailing content on the label row (the "Forgot your password?" link). */
  aside?: React.ReactNode;
  /** What went wrong with this field. Reddens the control and prints under it. */
  error?: string;
  /**
   * Redden the control without printing a message — for the second half of a pair that
   * failed together, where one sentence under the pair says it once.
   */
  invalid?: boolean;
  /** Extra classes on the field wrapper. */
  className?: string;
}

/**
 * A labelled auth text field.
 *
 * @param props Label, glyph, optional trailing label content, error/invalid state, plus
 *   every native `<input>` attribute — see {@link AuthFieldProps}.
 * @returns The field: label row, the control with its glyph, and the error line if any.
 */
export function AuthField({ id, label, icon, aside, error, invalid, className, ...input }: AuthFieldProps) {
  const errorId = error ? `${id}-error` : undefined;
  const isInvalid = Boolean(error) || Boolean(invalid);

  return (
    <div className={cn('flex flex-col gap-1.5', className)} data-invalid={isInvalid || undefined}>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-sm font-medium tracking-[0.01em] text-fg">
          {label}
        </label>
        {aside}
      </div>
      <div className="input-wrap">
        {icon}
        <Input id={id} aria-invalid={isInvalid || undefined} aria-describedby={errorId} {...input} />
      </div>
      {/* A `div`, not a `p`: the unlayered `p { color: … }` rule at the foot of
          `globals.css` outranks every `@layer utilities` colour, so a paragraph here
          would print the error in body ink. */}
      {error && (
        <div id={errorId} className="flex items-center gap-1 text-xs text-danger-fg">
          <CircleAlert className="size-3 shrink-0" aria-hidden="true" />
          {error}
        </div>
      )}
    </div>
  );
}

export default AuthField;
