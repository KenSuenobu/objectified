'use client';

/**
 * The Add / Update Personal Access Token dialog (HIVE-4.8, #5302).
 *
 * Authority: `docs/mockups/account/linked-accounts.html` §"Add PAT" and §"Update PAT". Its
 * Keeps list fixes the title pair, the `{Provider} · {handle}` subtitle, the field's placeholder
 * ("Paste your token"), the helper sentence, the validation string ("Personal Access Token is
 * required"), the provider-specific scopes banner, and the button pair
 * (Cancel / Add token | Update token).
 *
 * One dialog for both verbs rather than two, because they differ only in a word: the *reason*
 * they differ — whether a token is already stored — is a property of the account the dialog was
 * opened from, so it is read from {@link PatDialogProps.hasToken} rather than duplicated in
 * markup.
 *
 * The dialog owns the field, the validation and the busy flag; the *save* is the caller's, handed
 * in as {@link PatDialogProps.onSubmit}. That is the same seam `EditNameDialog` uses, and it is
 * what keeps the server action and the reload together on the page while this file stays a form.
 */

import * as React from 'react';

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
import { getProviderBrand } from '@/app/components/auth/provider-brand';
import { patScopesFor } from './linkedAccountsModel';

/** What the dialog says when the reader tries to save an empty field. */
export const PAT_REQUIRED_MESSAGE = 'Personal Access Token is required';

/** Props for {@link PatDialog}. */
export interface PatDialogProps {
  /** Whether the dialog is showing. */
  open: boolean;
  /** Asked to open or close. A close while busy is refused here, not by the caller. */
  onOpenChange: (open: boolean) => void;
  /** The registry id of the provider the token belongs to. */
  providerId: string;
  /** That provider's display name. */
  providerLabel: string;
  /** The handle or address at the provider, for the subtitle. */
  handle: string;
  /** Whether a token is already stored — the difference between "Add" and "Update". */
  hasToken: boolean;
  /**
   * Persist the token.
   *
   * @param token The token as typed, untrimmed — a secret's own whitespace is the provider's
   *   business, not this dialog's.
   * @returns `null` when it saved, or the message to show inside the dialog.
   */
  onSubmit: (token: string) => Promise<string | null>;
}

/**
 * Draw the dialog.
 *
 * @param props See {@link PatDialogProps}.
 * @returns The Add / Update Personal Access Token dialog.
 */
export function PatDialog({
  open,
  onOpenChange,
  providerId,
  providerLabel,
  handle,
  hasToken,
  onSubmit,
}: PatDialogProps) {
  const [token, setToken] = React.useState('');
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const fieldId = React.useId();
  const errorId = `${fieldId}-error`;
  const { Icon } = getProviderBrand(providerId);
  const scopes = patScopesFor(providerId);
  const verb = hasToken ? 'Update' : 'Add';

  // Cleared on open rather than on close, so a dialog that failed keeps what was typed until
  // the reader comes back to it — and so a secret is never left in state between visits.
  React.useEffect(() => {
    if (open) {
      setToken('');
      setError('');
      setBusy(false);
    }
  }, [open]);

  const save = React.useCallback(async () => {
    if (!token.trim()) {
      setError(PAT_REQUIRED_MESSAGE);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const failure = await onSubmit(token);
      if (failure) setError(failure);
      else onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }, [token, onSubmit, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent size="sm" data-testid="pat-dialog">
        <DialogHeader className="acct-dialog__header">
          <span className="acct-glyph" aria-hidden>
            <Icon />
          </span>
          <div className="acct-dialog__heading">
            <DialogTitle>{verb} Personal Access Token</DialogTitle>
            {/* The handle is the reader's address at the provider and can be 60 characters with
                no space in it; the dialog is 440 px. Without the break the subtitle would widen
                the dialog past the viewport — `e2e/hive-linked-accounts.spec.ts` measures it. */}
            <DialogDescription className="lnk-dialog__subject">
              {providerLabel}
              {handle ? ` · ${handle}` : ''}
            </DialogDescription>
          </div>
        </DialogHeader>

        <div className="acct-dialog__body">
          <div className="acct-field">
            <Label htmlFor={fieldId}>Token</Label>
            <Input
              id={fieldId}
              type="password"
              className="mono"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && !busy && void save()}
              disabled={busy}
              placeholder="Paste your token"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
              autoFocus
              data-testid="pat-token-input"
            />
            {/* An `Alert` is `role="alert"`, so the validation string is announced the moment
                it appears without the field needing a live region of its own. */}
            {error ? (
              <Alert variant="danger" id={errorId} data-testid="pat-error">
                {error}
              </Alert>
            ) : null}
            <p className="acct-hint">
              Used to authenticate with {providerLabel}&apos;s API. Stored encrypted; only the
              last 6 characters are shown afterwards.
            </p>
          </div>

          {scopes ? (
            <Alert variant="info" data-testid="pat-scopes">
              {/* A `<span>`, not a `<p>` and not `AlertTitle`, for the two reasons
                  `ChangePasswordDialog` states: the unlayered `p { color: var(--text-muted) }`
                  at the foot of `globals.css` outranks the banner's ink utility, so a paragraph
                  here renders muted-on-accent (3.86:1 in Solarized, a serious axe finding); and
                  `AlertTitle` is an `h5` under an `h2` dialog title, which is a skipped heading
                  level for what is a label rather than a section. */}
              <span className="block font-semibold">Required scopes</span>
              <span className="lnk-scopes mono">{scopes}</span>
            </Alert>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={busy} data-testid="pat-save">
            {busy ? 'Saving…' : `${verb} token`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default PatDialog;
