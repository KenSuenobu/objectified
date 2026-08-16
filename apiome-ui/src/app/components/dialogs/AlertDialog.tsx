'use client';

import * as React from 'react';
import {
  AlertDialog as AlertDialogRoot,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/AlertDialog';
import { cn } from '../../../../lib/utils';
import { useReturnFocus } from './useReturnFocus';
import {
  DIALOG_TONE_ICON,
  DIALOG_TONE_INK,
  DIALOG_TONE_TITLE,
  normalizeDialogTone,
  type DialogToneInput,
} from './dialogTone';

/**
 * AlertDialog — the Hive message box (HIVE-2.7, #5286).
 *
 * The one-button half of the imperative pair: something happened and the reader only has to
 * acknowledge it. Same surface and same tone vocabulary as {@link ./ConfirmDialog}, so a
 * failed delete is reported in the red its confirm was drawn in.
 *
 * Rebuilt on the HIVE-2.1 `components/ui/AlertDialog` primitives: `role="alertdialog"`,
 * focus-trapped, and made of theme tokens rather than the `bg-white` / `bg-indigo-600`
 * literals it used to hard-code.
 */

/** The four severities, in either the Hive or the pre-Hive spelling. */
export type AlertDialogVariant = DialogToneInput;

export interface AlertDialogProps {
  open: boolean;
  /** Defaults to the tone's own noun — "Error", "Warning", "Information", "Success". */
  title?: string;
  /** What happened. A string keeps its line breaks. */
  message: string | React.ReactNode;
  variant?: AlertDialogVariant;
  confirmLabel?: string;
  onClose: () => void;
}

/**
 * A message box with a single dismissing action.
 *
 * @param props See {@link AlertDialogProps}.
 * @returns The dialog, or nothing when `open` is false.
 */
const AlertDialog: React.FC<AlertDialogProps> = ({
  open,
  title,
  message,
  variant,
  confirmLabel = 'OK',
  onClose,
}) => {
  const tone = normalizeDialogTone(variant, 'info');
  const ToneIcon = DIALOG_TONE_ICON[tone];
  const actionRef = React.useRef<HTMLButtonElement>(null);
  const returnFocus = useReturnFocus(open);

  return (
    <AlertDialogRoot open={open} onOpenChange={(next) => !next && onClose()}>
      <AlertDialogContent
        size="sm"
        // Radix parks opening focus on the cancel button, and a message box has none — so
        // without this the reader would be dropped on the content wrapper. The one action
        // is the safe one here, so it is also the right landing place.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          actionRef.current?.focus();
        }}
        onCloseAutoFocus={returnFocus}
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2.5">
            <ToneIcon className={cn('size-5 shrink-0', DIALOG_TONE_INK[tone])} aria-hidden="true" />
            <span>{title || DIALOG_TONE_TITLE[tone]}</span>
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>
              {typeof message === 'string' ? (
                <p className="whitespace-pre-wrap">{message}</p>
              ) : (
                message
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {/* Radix's `Action` is a close button, so pressing it drives `onOpenChange(false)`
              and `onClose` runs from there — one path, whether the reader clicked, pressed
              `Esc` or clicked the scrim. */}
          <AlertDialogAction ref={actionRef} variant="primary">
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialogRoot>
  );
};

export default AlertDialog;
