'use client';

import * as React from 'react';
import { Check, Copy, ShieldCheck } from 'lucide-react';

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
import { useClipboardCopy } from '@/app/hooks/useClipboardCopy';

/**
 * The reveal-once secret — HIVE-5.4 (#5307).
 *
 * Authority: `docs/mockups/workspace/api-keys.html` `#key-created-dialog`; the ticket's
 * first acceptance criterion, *"the secret is shown exactly once, with copy, and cannot be
 * re-revealed"*.
 *
 * This is the most safety-critical moment in the product: the plaintext key exists in the
 * browser for the life of this dialog and nowhere else — the database holds a bcrypt hash
 * and the twelve-character prefix, so there is no second look, from this screen or from
 * support. Three things follow, and all three are deliberate:
 *
 * 1. **The dialog cannot be dismissed by accident.** Escape and a click on the scrim are
 *    both refused, and there is no close cross; the only way out is the footer's *I've saved
 *    my key*, which is a keyboard-reachable button, so this is an acknowledgement and not a
 *    keyboard trap (WCAG 2.1.2). Every other dialog in the app closes on Escape, because
 *    every other dialog can be reopened.
 * 2. **The secret is the caller's to hold and the caller's to forget.** This component keeps
 *    no copy of it: it renders `secret` and reports the acknowledgement, and the page drops
 *    the value the moment the dialog closes. A component that cached it in state would keep
 *    a second copy alive for as long as it stayed mounted.
 * 3. **"Copied!" is only ever said about a clipboard write that resolved.** `useClipboardCopy`
 *    reports the failure instead, with the sentence that tells the reader to select the text
 *    by hand — a false acknowledgement here sends somebody away from the only screen that
 *    will ever show them this string.
 */

/** Props for {@link ApiKeySecretDialog}. */
export interface ApiKeySecretDialogProps {
  /** Whether the dialog is open. Open it with the secret; close it and the secret is gone. */
  open: boolean;
  /**
   * Acknowledge and close.
   *
   * Only ever called with `false`, and only from the footer's button. The caller must clear
   * its copy of the secret in response.
   */
  onOpenChange: (open: boolean) => void;
  /** The plaintext key, exactly as the server generated it. */
  secret: string;
  /** The one-line summary of what was created — name, scope, expiry. */
  summary: string;
  /** The prefix the list will show from now on, so the reader can connect the two. */
  prefix: string;
}

/**
 * The secret dialog.
 *
 * @param props See {@link ApiKeySecretDialogProps}.
 * @returns The dialog.
 */
export default function ApiKeySecretDialog({
  open,
  onOpenChange,
  secret,
  summary,
  prefix,
}: ApiKeySecretDialogProps) {
  const { copied, error, copy } = useClipboardCopy();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="api-key-secret-dialog"
        showCloseButton={false}
        // The two ordinary ways out of a dialog, both refused — see the note above.
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="tnt-icon-tile" data-tone="ok">
              <ShieldCheck aria-hidden />
            </span>
            API key created
          </DialogTitle>
          <DialogDescription data-testid="api-key-secret-summary">{summary}</DialogDescription>
        </DialogHeader>

        <div className="akey-secret-body">
          <Alert variant="warn" data-testid="api-key-secret-warning">
            <span>
              <strong>Important:</strong> This is the only time you&apos;ll see this API key.
              Please copy it now and store it securely.
            </span>
          </Alert>

          <div className="akey-secret-label">Your API key</div>
          <div className="akey-secret">
            {/*
              Selectable, wrapping and monospace: the copy button is the fast path, and this
              is the one that still works when the clipboard API is unavailable — which is
              exactly the case the warning above makes unrecoverable.
            */}
            <code className="akey-secret__value mono" data-testid="api-key-secret-value">
              {secret}
            </code>
            <Button
              variant="outline"
              size="sm"
              className="akey-secret__copy"
              data-testid="api-key-secret-copy"
              onClick={() => void copy(secret)}
            >
              {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
              {copied ? 'Copied!' : 'Copy'}
            </Button>
          </div>

          {error && (
            <Alert variant="error" data-testid="api-key-secret-copy-error">
              {error}
            </Alert>
          )}

          <p className="akey-secret-note">
            Send it as <code className="mono">Authorization: Bearer &lt;key&gt;</code>. The prefix{' '}
            <code className="mono">{prefix}</code> is what the list shows from now on.
          </p>
        </div>

        <DialogFooter>
          <Button data-testid="api-key-secret-ack" onClick={() => onOpenChange(false)}>
            <Check aria-hidden />
            I&apos;ve saved my key
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
