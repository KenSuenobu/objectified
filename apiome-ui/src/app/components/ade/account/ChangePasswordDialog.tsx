'use client';

/**
 * Profile's Change password dialog (HIVE-4.7, #5301).
 *
 * Authority: `docs/mockups/account/profile.html` §"Change password". Its Keeps list fixes the
 * requirements banner, the three fields, Enter-on-the-last-field submitting, the three
 * validation strings and the busy label; its Adds list asks for the strength meter.
 *
 * The meter is measured against the server's own rules rather than against an entropy guess —
 * see {@link import('./passwordStrength') passwordStrength} for why. It is `aria-hidden`: the
 * requirements list above it already says, in words, everything the bar says in colour, and a
 * live meter announcing "Weak… Weak… Fair" on every keystroke is noise rather than help.
 */

import * as React from 'react';
import { KeyRound } from 'lucide-react';

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
import { Progress } from '@/app/components/ui/metrics/Progress';
import { PASSWORD_REQUIREMENTS, passwordStrength } from './passwordStrength';

/** Props for {@link ChangePasswordDialog}. */
export interface ChangePasswordDialogProps {
  /** Whether the dialog is showing. */
  open: boolean;
  /** Asked to open or close. A close while busy is refused here, not by the caller. */
  onOpenChange: (open: boolean) => void;
  /**
   * Change the password.
   *
   * @param current The current password.
   * @param next The new one.
   * @returns `null` when it changed, or the message to show when it did not.
   */
  onSubmit: (current: string, next: string) => Promise<string | null>;
}

/**
 * Draw the dialog.
 *
 * @param props See {@link ChangePasswordDialogProps}.
 * @returns The Change password dialog.
 */
export function ChangePasswordDialog({ open, onOpenChange, onSubmit }: ChangePasswordDialogProps) {
  const [current, setCurrent] = React.useState('');
  const [next, setNext] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  // Cleared on open, not on close: a dialog that empties its fields as it animates away shows
  // the reader an empty form on the way out.
  React.useEffect(() => {
    if (open) {
      setCurrent('');
      setNext('');
      setConfirm('');
      setError('');
      setBusy(false);
    }
  }, [open]);

  const strength = passwordStrength(next);

  const save = React.useCallback(async () => {
    if (!current) {
      setError('Please enter your current password');
      return;
    }
    if (!next) {
      setError('Please enter a new password');
      return;
    }
    if (next !== confirm) {
      setError('New passwords do not match');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const failure = await onSubmit(current, next);
      if (failure) setError(failure);
      else onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }, [current, next, confirm, onSubmit, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={(value) => !busy && onOpenChange(value)}>
      <DialogContent size="sm" data-testid="profile-password-dialog">
        <DialogHeader className="acct-dialog__header">
          <span className="acct-glyph acct-glyph--accent" aria-hidden>
            <KeyRound />
          </span>
          <div className="acct-dialog__heading">
            <DialogTitle>Change password</DialogTitle>
            <DialogDescription>Enter your current password and choose a new one.</DialogDescription>
          </div>
        </DialogHeader>

        <div className="acct-dialog__body">
          {error && <Alert variant="error">{error}</Alert>}

          {/* A `<span>`, not a `<p>` and not `AlertTitle`. Not a `<p>` because the unlayered
              `p { color: var(--text-muted) }` at the foot of `globals.css` outranks the
              banner's own `text-accent-fg` utility, so a paragraph here renders muted ink *on
              the accent tint* — 3.86:1 in Solarized, a serious axe finding. Not `AlertTitle`
              because it is an `h5` and the dialog's own title is an `h2`, which would make this
              a skipped heading level; the line is a label for the list under it, not a section
              of the document. A `<span>` simply inherits the banner's ink. */}
          <Alert variant="info">
            <span className="block font-semibold">Password requirements</span>
            <ul className="acct-reqs">
              {PASSWORD_REQUIREMENTS.map((requirement, index) => (
                <li key={requirement.id} data-met={strength ? strength.met[index] : undefined}>
                  {requirement.label}
                </li>
              ))}
            </ul>
          </Alert>

          <div className="acct-field">
            <Label htmlFor="profile-current-password">Current password</Label>
            <Input
              id="profile-current-password"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(event) => setCurrent(event.target.value)}
              disabled={busy}
              autoFocus
              data-testid="profile-current-password"
            />
          </div>

          <div className="acct-field">
            <Label htmlFor="profile-new-password">New password</Label>
            <Input
              id="profile-new-password"
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(event) => setNext(event.target.value)}
              disabled={busy}
              data-testid="profile-new-password"
            />
            {strength ? (
              // The word is drawn in muted ink, not in the tone's `-fg` — `--danger-fg` and
              // `--warn-fg` keep their light-palette values in the High contrast theme, where
              // they measure under 3.5:1 on that theme's black surface. The *bar* carries the
              // tone (its saturated hue *is* re-tinted per theme), and the word says the same
              // thing in text, which DESIGN.md §6 asks for anyway.
              <div className="acct-strength" aria-hidden data-testid="profile-password-strength">
                <Progress decorative value={strength.percent} tone={strength.tone} />
                <span className="acct-strength__label">{strength.label}</span>
              </div>
            ) : null}
          </div>

          <div className="acct-field">
            <Label htmlFor="profile-confirm-password">Confirm new password</Label>
            <Input
              id="profile-confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && !busy && void save()}
              disabled={busy}
              data-testid="profile-confirm-password"
            />
            <p className="acct-hint">Enter on this field submits.</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={save}
            disabled={busy}
            data-testid="profile-password-save"
          >
            {busy ? 'Updating…' : 'Change password'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default ChangePasswordDialog;
