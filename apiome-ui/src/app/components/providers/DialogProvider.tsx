'use client';

import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import ConfirmDialog, { type ConfirmDialogProps } from '../dialogs/ConfirmDialog';
import AlertDialog, { type AlertDialogProps } from '../dialogs/AlertDialog';
import PromptDialog, { type PromptDialogProps } from '../dialogs/PromptDialog';

/**
 * The app's imperative dialogs (HIVE-2.7, #5286).
 *
 * `await confirm({…})` reads like the native browser confirm it replaced, which is the whole
 * point: the call site keeps its shape and the browser's unstyled, unthemed, untranslatable
 * box goes away. This ticket adds the third member the app was still missing — `prompt` —
 * and an optional `perform` hook on both, so the dialog can stay open and marked busy while
 * the request it authorised is in flight instead of vanishing and reappearing as a toast.
 *
 * The provider owns exactly one of each dialog at a time. A second `confirm()` while one is
 * open would strand the first promise, so the API is: ask, await, then ask again.
 */

/** What the caller passes to `confirm()`. The component's own wiring is not its business. */
export type ConfirmOptions = Omit<
  ConfirmDialogProps,
  'open' | 'onConfirm' | 'onCancel' | 'busy' | 'error'
> & {
  /**
   * The work the confirm authorises, run **while the dialog stays open and busy**.
   *
   * Resolving closes the dialog and `confirm()` resolves `true`. Throwing keeps it open and
   * shows the error inside it, so the reader can retry or cancel without losing the context
   * they just confirmed against. Omit it and `confirm()` behaves exactly as it always has:
   * it closes on the click and resolves `true`.
   */
  perform?: () => void | Promise<void>;
};

/** What the caller passes to `alert()`. */
export type AlertOptions = Omit<AlertDialogProps, 'open' | 'onClose'>;

/** What the caller passes to `prompt()`. */
export type PromptOptions = Omit<
  PromptDialogProps,
  'open' | 'onSubmit' | 'onCancel' | 'busy' | 'error'
> & {
  /**
   * The work the answer feeds, run **while the dialog stays open and busy**.
   *
   * Throwing keeps the dialog open with the message under the field — which is where a
   * server's "that name is taken" belongs, next to the name that is taken.
   *
   * @param value The trimmed value.
   */
  perform?: (value: string) => void | Promise<void>;
};

interface DialogContextType {
  /**
   * Ask a yes/no question.
   *
   * @param options Title, message, tone, labels, and optionally a type-to-confirm gate.
   * @returns `true` if confirmed (and, with `perform`, only after it succeeded).
   */
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  /**
   * Report something the reader only has to acknowledge.
   *
   * @param options Title, message and tone.
   * @returns Resolves when the reader dismisses it.
   */
  alert: (options: AlertOptions) => Promise<void>;
  /**
   * Ask for one value.
   *
   * @param options Title, field label, default value, hint and validation.
   * @returns The **trimmed** value, or `null` if the reader cancelled — the same contract as
   *   the native browser prompt it replaces, so call sites keep their `if (!name) return;`.
   */
  prompt: (options: PromptOptions) => Promise<string | null>;
}

const DialogContext = createContext<DialogContextType | undefined>(undefined);

interface DialogProviderProps {
  children: ReactNode;
}

/** One open dialog: its options, how to settle the caller's promise, and its live state. */
interface DialogState<TOptions, TResult> {
  options: TOptions;
  resolve: (value: TResult) => void;
  /** A `perform` is running: the dialog is locked open. */
  busy: boolean;
  /** What the last `perform` threw, shown inside the dialog. */
  error: string | null;
}

/** The message to show when a `perform` throws something that is not an `Error`. */
const UNKNOWN_FAILURE = 'Something went wrong. Please try again.';

/**
 * Read a thrown value as a sentence for the dialog.
 *
 * @param cause Whatever `perform` threw.
 * @returns Its message, or a generic one for a non-`Error`.
 */
function failureMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message) return cause.message;
  if (typeof cause === 'string' && cause) return cause;
  return UNKNOWN_FAILURE;
}

export const DialogProvider: React.FC<DialogProviderProps> = ({ children }) => {
  const [confirmState, setConfirmState] = useState<DialogState<ConfirmOptions, boolean> | null>(
    null
  );
  const [alertState, setAlertState] = useState<DialogState<AlertOptions, void> | null>(null);
  const [promptState, setPromptState] = useState<DialogState<PromptOptions, string | null> | null>(
    null
  );

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setConfirmState({ options, resolve, busy: false, error: null });
      }),
    []
  );

  const alert = useCallback(
    (options: AlertOptions) =>
      new Promise<void>((resolve) => {
        setAlertState({ options, resolve, busy: false, error: null });
      }),
    []
  );

  const prompt = useCallback(
    (options: PromptOptions) =>
      new Promise<string | null>((resolve) => {
        setPromptState({ options, resolve, busy: false, error: null });
      }),
    []
  );

  /**
   * The confirm's primary action.
   *
   * Without `perform` this closes and resolves `true`. With one, the dialog is marked busy
   * for the duration and only closes if the work succeeded.
   */
  const handleConfirm = async () => {
    if (!confirmState || confirmState.busy) return;
    const { options, resolve } = confirmState;
    if (!options.perform) {
      setConfirmState(null);
      resolve(true);
      return;
    }
    setConfirmState({ ...confirmState, busy: true, error: null });
    try {
      await options.perform();
      setConfirmState(null);
      resolve(true);
    } catch (cause) {
      setConfirmState((current) =>
        current ? { ...current, busy: false, error: failureMessage(cause) } : current
      );
    }
  };

  const handleCancel = () => {
    if (!confirmState || confirmState.busy) return;
    setConfirmState(null);
    confirmState.resolve(false);
  };

  const handleAlertClose = () => {
    if (!alertState) return;
    setAlertState(null);
    alertState.resolve();
  };

  /**
   * The prompt's submit.
   *
   * @param value The trimmed value the dialog validated.
   */
  const handlePromptSubmit = async (value: string) => {
    if (!promptState || promptState.busy) return;
    const { options, resolve } = promptState;
    if (!options.perform) {
      setPromptState(null);
      resolve(value);
      return;
    }
    setPromptState({ ...promptState, busy: true, error: null });
    try {
      await options.perform(value);
      setPromptState(null);
      resolve(value);
    } catch (cause) {
      setPromptState((current) =>
        current ? { ...current, busy: false, error: failureMessage(cause) } : current
      );
    }
  };

  const handlePromptCancel = () => {
    if (!promptState || promptState.busy) return;
    setPromptState(null);
    promptState.resolve(null);
  };

  return (
    <DialogContext.Provider value={{ confirm, alert, prompt }}>
      {children}
      {confirmState && (
        <ConfirmDialog
          {...confirmState.options}
          open
          busy={confirmState.busy}
          error={confirmState.error}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        />
      )}
      {alertState && (
        <AlertDialog {...alertState.options} open onClose={handleAlertClose} />
      )}
      {promptState && (
        <PromptDialog
          {...promptState.options}
          open
          busy={promptState.busy}
          error={promptState.error}
          onSubmit={handlePromptSubmit}
          onCancel={handlePromptCancel}
        />
      )}
    </DialogContext.Provider>
  );
};

export const useDialog = (): DialogContextType => {
  const context = useContext(DialogContext);
  if (!context) {
    throw new Error('useDialog must be used within a DialogProvider');
  }
  return context;
};
