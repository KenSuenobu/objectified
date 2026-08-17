'use client';

/**
 * Profile's Edit name dialog (HIVE-4.7, #5301).
 *
 * Authority: `docs/mockups/account/profile.html` §"Edit name". Its Keeps list fixes the
 * validation string (`"Name cannot be empty"`), the Enter-submits behaviour, the busy label
 * and the rule that the dialog cannot be dismissed while the save is in flight.
 *
 * The dialog owns the field, the error and the busy flag; the *save* is the caller's, handed
 * in as {@link EditNameDialogProps.onSubmit}. That seam is what lets the page keep the server
 * action and the session refresh together while this file stays a form.
 */

import * as React from 'react';
import { Pencil } from 'lucide-react';

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
import { Input } from '@/app/components/ui/Input';
import { Label } from '@/app/components/ui/Label';

/** Props for {@link EditNameDialog}. */
export interface EditNameDialogProps {
  /** Whether the dialog is showing. */
  open: boolean;
  /** Asked to open or close. A close while busy is refused here, not by the caller. */
  onOpenChange: (open: boolean) => void;
  /** The name to start from — the session's, when the dialog opens. */
  initialName: string;
  /**
   * Persist the new name.
   *
   * @param name The trimmed name.
   * @returns `null` when it saved, or the message to show when it did not.
   */
  onSubmit: (name: string) => Promise<string | null>;
}

/**
 * Draw the dialog.
 *
 * @param props See {@link EditNameDialogProps}.
 * @returns The Edit name dialog.
 */
export function EditNameDialog({ open, onOpenChange, initialName, onSubmit }: EditNameDialogProps) {
  const [name, setName] = React.useState(initialName);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  // Re-seed on open rather than on every `initialName` change: a session refresh that lands
  // while the reader is typing must not overwrite what they have typed.
  React.useEffect(() => {
    if (open) {
      setName(initialName);
      setError('');
      setBusy(false);
    }
  }, [open, initialName]);

  const save = React.useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Name cannot be empty');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const failure = await onSubmit(trimmed);
      if (failure) setError(failure);
      else onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }, [name, onSubmit, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent size="sm" data-testid="profile-edit-name-dialog">
        <DialogHeader className="acct-dialog__header">
          <span className="acct-glyph acct-glyph--accent" aria-hidden>
            <Pencil />
          </span>
          <div className="acct-dialog__heading">
            <DialogTitle>Edit name</DialogTitle>
            <DialogDescription>Update your display name.</DialogDescription>
          </div>
        </DialogHeader>

        <div className="acct-dialog__body">
          {error && <Alert variant="error">{error}</Alert>}
          <div className="acct-field">
            <Label htmlFor="profile-name">Full name</Label>
            <Input
              id="profile-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && !busy && void save()}
              disabled={busy}
              placeholder="Your name"
              autoFocus
              data-testid="profile-name-input"
            />
            <p className="acct-hint">Shown to teammates and in activity. Enter submits.</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={busy} data-testid="profile-name-save">
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default EditNameDialog;
