'use client';

import * as React from 'react';
import { PowerOff, TriangleAlert, Trash2 } from 'lucide-react';

import { Alert } from '@/app/components/ui/Alert';
import { Button } from '@/app/components/ui/Button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/app/components/ui/Dialog';
import { Spinner } from '@/app/components/ui/Spinner';

import { displayApiKeyPrefix, type ApiKeyRecord } from './apiKeysModel';

/**
 * The two API-key confirms — HIVE-5.4 (#5307).
 *
 * Authority: `docs/mockups/workspace/api-keys.html`, the `#disable-dialog` and
 * `#delete-key-dialog` overlays. Both carry the copy the screen this replaces used, which
 * the mockup's notes list under **Keeps (1:1)**.
 *
 * ### What these replace
 *
 * Both decisions were `useDialog().confirm` — a real dialog, but one whose entire content is
 * a sentence. That was enough while the sentence was all there was to say. It is not enough
 * here, because the thing being confirmed is identified by a twelve-character prefix that
 * the sentence cannot show in monospace, and because a failed write had nowhere to report:
 * the old handlers logged to the console and left the row unchanged, so a delete that the
 * server refused looked exactly like a delete that had not been pressed.
 *
 * Both dialogs therefore name the key **and** its prefix, and both show the failure inline,
 * beside the button that caused it.
 *
 * Turning a key back **on** is still immediate and unconfirmed, as it was: enabling is the
 * reversible direction, and the switch is its own undo.
 */

/** What a confirm does when pressed: perform the write, or answer with why it failed. */
type ApiKeyConfirmHandler = (key: ApiKeyRecord) => Promise<string | null>;

/** Props shared by both confirms. */
interface ApiKeyConfirmProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** Close it. */
  onOpenChange: (open: boolean) => void;
  /** The key the dialog is about; `null` while it is closed. */
  apiKey: ApiKeyRecord | null;
  /**
   * Perform the action.
   *
   * @param key The key.
   * @returns The error to show inline, or `null` on success.
   */
  onConfirm: ApiKeyConfirmHandler;
}

/**
 * The busy/error state both confirms keep, and the run that maintains it.
 *
 * The same hook `MemberLifecycleDialogs` uses, restated here rather than imported across
 * surfaces: the members module owns members. What the two share is a shape, not a
 * dependency, and a `useConfirmAction` lifted into a common place would have to be generic
 * over the record type to serve either.
 *
 * @param options.open Whether the dialog is open, so the state resets as it opens.
 * @param options.apiKey The key the dialog is about.
 * @param options.onConfirm The write.
 * @param options.onOpenChange Called with `false` once the write succeeds.
 * @returns The inline error, whether a write is running, and the runner.
 */
function useApiKeyConfirm({ open, apiKey, onConfirm, onOpenChange }: ApiKeyConfirmProps) {
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setError('');
    setBusy(false);
  }, [open]);

  const run = React.useCallback(async () => {
    if (!apiKey) return;
    setBusy(true);
    setError('');
    const failure = await onConfirm(apiKey);
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    onOpenChange(false);
  }, [apiKey, onConfirm, onOpenChange]);

  return { error, busy, run };
}

/**
 * The key's name and prefix, as both dialogs name it.
 *
 * @param props.apiKey The key.
 * @returns The identity line.
 */
function ApiKeyIdentityLine({ apiKey }: { apiKey: ApiKeyRecord }) {
  return (
    <span className="akey-confirm-identity">
      <span className="akey-confirm-identity__name">{apiKey.name}</span>
      <code className="mono akey-confirm-identity__prefix">
        {displayApiKeyPrefix(apiKey.key_prefix)}
      </code>
    </span>
  );
}

/** Props for {@link DisableApiKeyDialog}. */
export type DisableApiKeyDialogProps = ApiKeyConfirmProps;

/**
 * Disable a key — the confirm the switch opens on its way *off*.
 *
 * @param props See {@link DisableApiKeyDialogProps}.
 * @returns The dialog.
 */
export function DisableApiKeyDialog({
  open,
  onOpenChange,
  apiKey,
  onConfirm,
}: DisableApiKeyDialogProps) {
  const { error, busy, run } = useApiKeyConfirm({ open, onOpenChange, apiKey, onConfirm });
  const name = apiKey?.name ?? 'this API key';

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent size="sm" role="alertdialog" data-testid="api-key-disable-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="tnt-icon-tile" data-tone="warn">
              <PowerOff aria-hidden />
            </span>
            Disable API key
          </DialogTitle>
          <DialogDescription>
            Are you sure you want to disable “{name}”? This will immediately block all requests
            using this key.
          </DialogDescription>
        </DialogHeader>

        <div className="akey-confirm-body">
          {apiKey && <ApiKeyIdentityLine apiKey={apiKey} />}
          {error && <Alert variant="error">{error}</Alert>}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy} data-testid="api-key-disable-confirm" onClick={() => void run()}>
            {busy && <Spinner size="sm" aria-hidden />}
            {busy ? 'Disabling…' : 'Disable'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Props for {@link DeleteApiKeyDialog}. */
export type DeleteApiKeyDialogProps = ApiKeyConfirmProps;

/**
 * Delete a key.
 *
 * The banner is the one thing this adds to the sentence the confirm used to be: deleting is
 * the only irreversible action on the screen, and what makes it irreversible is not that the
 * row disappears but that every caller still holding the secret stops working at once.
 *
 * @param props See {@link DeleteApiKeyDialogProps}.
 * @returns The dialog.
 */
export function DeleteApiKeyDialog({
  open,
  onOpenChange,
  apiKey,
  onConfirm,
}: DeleteApiKeyDialogProps) {
  const { error, busy, run } = useApiKeyConfirm({ open, onOpenChange, apiKey, onConfirm });
  const name = apiKey?.name ?? 'this API key';

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent size="sm" role="alertdialog" data-testid="api-key-delete-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="tnt-icon-tile" data-tone="danger">
              <TriangleAlert aria-hidden />
            </span>
            Delete API key
          </DialogTitle>
          <DialogDescription>
            Are you sure you want to delete the API key “{name}”? This action cannot be undone.
          </DialogDescription>
        </DialogHeader>

        <div className="akey-confirm-body">
          {apiKey && <ApiKeyIdentityLine apiKey={apiKey} />}
          <Alert variant="danger" data-testid="api-key-delete-warning">
            Every caller still using this key starts getting 401s as soon as it is deleted.
            Rotate first if something in production depends on it.
          </Alert>
          {error && <Alert variant="error">{error}</Alert>}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            data-testid="api-key-delete-confirm"
            onClick={() => void run()}
          >
            {busy ? <Spinner size="sm" aria-hidden /> : <Trash2 aria-hidden />}
            {busy ? 'Deleting…' : 'Delete'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
