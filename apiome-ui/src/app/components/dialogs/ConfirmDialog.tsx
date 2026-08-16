'use client';

import * as React from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/AlertDialog';
import { Alert } from '../ui/Alert';
import { FormField } from '../ui/FormField';
import { Input } from '../ui/Input';
import { Spinner } from '../ui/Spinner';
import { cn } from '../../../../lib/utils';
import { useReturnFocus } from './useReturnFocus';
import {
  DIALOG_TONE_BUTTON,
  DIALOG_TONE_ICON,
  DIALOG_TONE_INK,
  normalizeDialogTone,
  type DialogToneInput,
} from './dialogTone';

/**
 * ConfirmDialog — the Hive confirm (HIVE-2.7, #5286).
 *
 * Authority: `docs/mockups/DESIGN.md` §8 "Destructive" — *red primary, object named,
 * consequence sentence, optional type-to-confirm for tenants and projects*.
 *
 * The pre-Hive version was a hand-rolled `@radix-ui/react-dialog` in `bg-white`,
 * `text-red-600` and `bg-indigo-600`: nine themes could not reach it, and `role="dialog"`
 * let a screen reader treat "delete this tenant" as an ordinary panel. This is the HIVE-2.1
 * `AlertDialog` surface instead, which is `role="alertdialog"`, focus-trapped, and made of
 * tokens — plus the two things §8 asks of a destructive confirm that no confirm in the app
 * had: a **consequence sentence** and **type-to-confirm**.
 *
 * The dialog is fully controlled. Both buttons report upwards and nothing here closes
 * itself, which is what lets the caller hold it open — and marked `busy` — while the
 * request the confirm authorised is still in flight.
 */

/** The four severities, in either the Hive or the pre-Hive spelling. */
export type ConfirmDialogVariant = DialogToneInput;

export interface ConfirmDialogProps {
  open: boolean;
  /** The question, with the object **named**: `Delete role "Editor"?`. */
  title?: string;
  /** What is being confirmed. A string keeps its line breaks. */
  message: string | React.ReactNode;
  /**
   * One sentence saying what the click costs, shown under the message in full-strength ink.
   *
   * DESIGN.md §8 requires it of every destructive action. `destructiveConfirm()` composes it
   * for the common shapes.
   */
  consequence?: React.ReactNode;
  variant?: ConfirmDialogVariant;
  confirmLabel?: string;
  cancelLabel?: string;
  /**
   * The exact phrase the operator has to type before the primary action enables — usually
   * the object's own name.
   *
   * Reserved for the three irreversible cases (permanent project delete, tenant delete,
   * user delete): a guard on every confirm is a guard nobody reads. Compared after trimming
   * and **case-sensitively**, so "delete" does not pass for a tenant called "DELETE".
   */
  typeToConfirm?: string;
  /** Label above the type-to-confirm field. Defaults to a sentence naming the phrase. */
  typeToConfirmLabel?: string;
  /**
   * A request is in flight: both buttons are disabled, and `Esc`, the scrim and the cancel
   * button no longer dismiss — a half-finished delete must not lose its dialog.
   */
  busy?: boolean;
  /** A failure to show *inside* the dialog, instead of closing it and toasting. */
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * A confirm, with an optional type-to-confirm gate.
 *
 * @param props See {@link ConfirmDialogProps}.
 * @returns The dialog, or nothing when `open` is false.
 */
const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  title,
  message,
  consequence,
  variant,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  typeToConfirm,
  typeToConfirmLabel,
  busy = false,
  error = null,
  onConfirm,
  onCancel,
}) => {
  const tone = normalizeDialogTone(variant, 'warning');
  const ToneIcon = DIALOG_TONE_ICON[tone];
  const [typed, setTyped] = React.useState('');
  const gateRef = React.useRef<HTMLInputElement>(null);
  const returnFocus = useReturnFocus(open);

  // A reopened dialog must not inherit the phrase typed into the last one. The provider
  // unmounts this component between uses, so this only matters for a caller that keeps it
  // mounted — but "the gate was already satisfied" is not a failure mode worth leaving open.
  React.useEffect(() => {
    if (!open) setTyped('');
  }, [open]);

  const gated = Boolean(typeToConfirm);
  const unlocked = !gated || typed.trim() === typeToConfirm;
  const blocked = busy || !unlocked;

  /** Dismissal, from `Esc`, the scrim or the cancel button — refused while busy. */
  const handleOpenChange = (next: boolean) => {
    if (next || busy) return;
    onCancel();
  };

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent
        size="sm"
        // The gate is the thing to type into, so it takes focus over Radix's default of the
        // cancel button. Without a gate the default stands: on a destructive confirm, the
        // safe button is the one that should already be under the reader's hands.
        onOpenAutoFocus={(event) => {
          if (!gated) return;
          event.preventDefault();
          gateRef.current?.focus();
        }}
        onCloseAutoFocus={returnFocus}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2.5">
            <ToneIcon className={cn('size-5 shrink-0', DIALOG_TONE_INK[tone])} aria-hidden="true" />
            <span>{title || 'Confirm action'}</span>
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="flex flex-col gap-2">
              {typeof message === 'string' ? (
                <p className="whitespace-pre-wrap">{message}</p>
              ) : (
                message
              )}
              {consequence && <p className="font-medium text-fg">{consequence}</p>}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        {gated && (
          <FormField
            label={typeToConfirmLabel ?? `Type ${typeToConfirm} to confirm`}
            helperText="This cannot be undone."
          >
            <Input
              ref={gateRef}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              placeholder={typeToConfirm}
              aria-label={typeToConfirmLabel ?? `Type ${typeToConfirm} to confirm`}
            />
          </FormField>
        )}

        {error && <Alert variant="danger">{error}</Alert>}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{cancelLabel}</AlertDialogCancel>
          <AlertDialogAction
            variant={DIALOG_TONE_BUTTON[tone]}
            disabled={blocked}
            aria-busy={busy || undefined}
            // Radix's `Action` is a `Dialog.Close`: left alone it would close the dialog
            // itself, which is exactly what a `busy` confirm must not do. Preventing the
            // default suppresses that (Radix's `composeEventHandlers` checks for it) and
            // leaves the caller as the only thing that decides when this closes.
            onClick={(event) => {
              event.preventDefault();
              if (blocked) return;
              onConfirm();
            }}
          >
            {/* Decorative: the button keeps its own label, and `aria-busy` is what the
                state is announced through. A second live region would only talk over it. */}
            {busy && <Spinner size="sm" tone="light" role="presentation" aria-hidden="true" />}
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

export default ConfirmDialog;
