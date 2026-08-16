'use client';

import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/Dialog';
import { Button } from '../ui/Button';
import { FormField } from '../ui/FormField';
import { Input } from '../ui/Input';
import { Spinner } from '../ui/Spinner';
import { Textarea } from '../ui/Textarea';
import { useReturnFocus } from './useReturnFocus';

/**
 * PromptDialog — the Hive replacement for the browser's native prompt (HIVE-2.7, #5286).
 *
 * The native prompt is one unlabelled line with no hint, no validation and no way to say
 * *why* an answer was rejected; the browser draws it, so no theme, font scale or
 * translation reaches it, and Safari lets a page suppress it outright. DESIGN.md §7 calls
 * for a real form dialog instead: **label, validation, hint**.
 *
 * The contract is deliberately close to the thing it replaces — one value in, one value out
 * — so the call sites that asked the browser for a name keep their shape. Two things
 * differ, both on purpose:
 *
 *   * the value is **trimmed** before it is validated and returned, because every call site
 *     was already trimming it and one of them had forgotten;
 *   * `busy` keeps the dialog open while the caller's request runs, so a rejected name comes
 *     back *into the field* instead of vanishing with the dialog and reappearing as a toast.
 */

/**
 * A synchronous check on the trimmed value.
 *
 * @param value The trimmed input.
 * @returns A message to show under the field, or `null`/`undefined` when the value is good.
 */
export type PromptValidator = (value: string) => string | null | undefined;

export interface PromptDialogProps {
  open: boolean;
  /** The ask, as a verb phrase: `New role`, `Rename collection`. */
  title: string;
  /** Optional sentence under the title giving the field its context. */
  message?: React.ReactNode;
  /** The field's own name — the thing the native prompt could never show. */
  label: string;
  /** The value the field starts with. */
  defaultValue?: string;
  placeholder?: string;
  /** A sentence under the field saying what a good value looks like. */
  helperText?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Reject an empty answer with a message rather than resolving it. Default `true`. */
  required?: boolean;
  maxLength?: number;
  /** Render a `Textarea` instead of an `Input` — for descriptions and notes. */
  multiline?: boolean;
  /** An extra check on the trimmed value, run before the caller ever sees it. */
  validate?: PromptValidator;
  /** The caller's request is in flight: the form is locked and dismissal is refused. */
  busy?: boolean;
  /** A failure to show under the field, instead of closing the dialog and toasting. */
  error?: string | null;
  /** Called with the **trimmed** value once it passes `required` and `validate`. */
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

/**
 * A single-field form dialog.
 *
 * @param props See {@link PromptDialogProps}.
 * @returns The dialog, or nothing when `open` is false.
 */
const PromptDialog: React.FC<PromptDialogProps> = ({
  open,
  title,
  message,
  label,
  defaultValue = '',
  placeholder,
  helperText,
  confirmLabel = 'Save',
  cancelLabel = 'Cancel',
  required = true,
  maxLength,
  multiline = false,
  validate,
  busy = false,
  error = null,
  onSubmit,
  onCancel,
}) => {
  const [value, setValue] = React.useState(defaultValue);
  const [localError, setLocalError] = React.useState<string | null>(null);
  const returnFocus = useReturnFocus(open);

  // A reopened dialog starts from the caller's default again, and forgets the complaint the
  // last one ended on.
  React.useEffect(() => {
    if (!open) return;
    setValue(defaultValue);
    setLocalError(null);
  }, [open, defaultValue]);

  /**
   * Validate the trimmed value and hand it up, or keep the dialog and explain why not.
   *
   * @param event The form submission, from the button or from `Enter` in the field.
   */
  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const trimmed = value.trim();
    if (required && !trimmed) {
      setLocalError(`${label} is required.`);
      return;
    }
    const complaint = validate?.(trimmed);
    if (complaint) {
      setLocalError(complaint);
      return;
    }
    setLocalError(null);
    onSubmit(trimmed);
  };

  /** Dismissal, from `Esc`, the scrim or the corner close — refused while busy. */
  const handleOpenChange = (next: boolean) => {
    if (next || busy) return;
    onCancel();
  };

  // The caller's error (a rejected name from the server) and this dialog's own (an empty or
  // invalid value) go to the same place, so the reader never has to look in two.
  const shown = localError ?? error ?? null;

  const controlProps = {
    // `FormField` draws the label but does not associate it, so the control carries its own
    // accessible name — an unnamed field is exactly the axe violation this ticket is closing.
    'aria-label': label,
    value,
    placeholder,
    maxLength,
    disabled: busy,
    autoComplete: 'off' as const,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setValue(event.target.value);
      // A complaint about what was typed must not outlive the typing.
      if (localError) setLocalError(null);
    },
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        size="sm"
        // The corner dismiss goes while the request runs rather than staying as a control
        // that looks live and does nothing. It is absolutely positioned, so nothing moves.
        showCloseButton={!busy}
        // A prompt without a `message` has no description, and Radix wires — and then warns
        // about — a missing one. Passing the attribute back as `undefined` is Radix's own
        // escape hatch for "this dialog is described by its field, not by a paragraph".
        {...(message ? {} : { 'aria-describedby': undefined })}
        onCloseAutoFocus={returnFocus}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {message && <DialogDescription asChild><div>{message}</div></DialogDescription>}
          </DialogHeader>

          <FormField label={label} helperText={helperText} error={shown ?? undefined} required={required}>
            {/* `autoFocus`: a prompt exists to be typed into, and the reader arrived by
                asking for it — so the field, not the dialog, is where focus belongs. */}
            {multiline ? (
              <Textarea {...controlProps} autoFocus />
            ) : (
              <Input {...controlProps} autoFocus />
            )}
          </FormField>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
              {cancelLabel}
            </Button>
            <Button type="submit" variant="primary" disabled={busy} aria-busy={busy || undefined}>
              {busy && <Spinner size="sm" tone="light" role="presentation" aria-hidden="true" />}
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

export default PromptDialog;
