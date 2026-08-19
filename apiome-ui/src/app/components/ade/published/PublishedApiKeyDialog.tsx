'use client';

/**
 * The *API key required* dialog (HIVE-8.1, #5327).
 *
 * Authority: `docs/mockups/ship/published.html` §API key dialog — a violet key tile, the
 * sentence naming the `api_key` query parameter and the API Keys page, a password field, the
 * *Remember this key* checkbox (on by default), the *Clear saved key from this browser*
 * escape hatch, and an *Open with key* primary that stays inert until something is typed.
 *
 * ### Why the key is asked for at all
 *
 * A private published revision is served only to a request carrying a tenant API key, and the
 * viewers this screen opens are ordinary browser tabs — so the key has to travel in the URL.
 * Remembering it is the reader's choice and never leaves the device: it is written to
 * `localStorage` under `apiome.previewApiKey.v1:<tenantId>` by `preview-api-key-storage`, and
 * a remembered key skips this dialog entirely next time.
 *
 * ### What this component owns
 *
 * The field, the checkbox and the two buttons — not the key. The value lives on the screen,
 * which is where the round-trip that uses it lives, so nothing here has to be reset when a
 * different row opens the dialog.
 */

import * as React from 'react';
import { Eraser, KeyRound } from 'lucide-react';

import { Button } from '@/app/components/ui/Button';
import { Checkbox } from '@/app/components/ui/Checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/app/components/ui/Dialog';
import { FormField } from '@/app/components/ui/FormField';
import { Input } from '@/app/components/ui/Input';
import { Label } from '@/app/components/ui/Label';

import { API_KEYS_HREF } from './publishedModel';

export interface PublishedApiKeyDialogProps {
  /** Whether the dialog is on screen. */
  open: boolean;
  /** Close without opening anything. */
  onClose: () => void;
  /** The typed key. */
  value: string;
  /** Report each keystroke. */
  onValueChange: (next: string) => void;
  /** Whether the key should be remembered on this device. */
  remember: boolean;
  /** Report the checkbox. */
  onRememberChange: (next: boolean) => void;
  /** Whether a key is already saved for this workspace — gates the clear button. */
  hasSavedKey: boolean;
  /** Forget the saved key. */
  onClearSavedKey: () => void;
  /** Open the pending viewer with the typed key. */
  onSubmit: () => void;
}

/** The field's id — also what `FormField` derives its error id from. */
const FIELD_ID = 'published-api-key-input';

/** The checkbox's id, so its label is a real `<label for>`. */
const REMEMBER_ID = 'published-api-key-remember';

/**
 * Render the dialog. See {@link PublishedApiKeyDialogProps}.
 *
 * @returns The dialog, or nothing while it is closed.
 */
export function PublishedApiKeyDialog({
  open,
  onClose,
  value,
  onValueChange,
  remember,
  onRememberChange,
  hasSavedKey,
  onClearSavedKey,
  onSubmit,
}: PublishedApiKeyDialogProps) {
  const ready = Boolean(value.trim());

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="pub-key-dialog" data-testid="published-api-key-dialog">
        <DialogHeader className="pub-dialog__head">
          <span className="tnt-icon-tile" data-tone="violet" aria-hidden>
            <KeyRound />
          </span>
          <div className="pub-dialog__heading">
            <DialogTitle>API key required</DialogTitle>
            <DialogDescription>
              This version is private. Enter your tenant API key so the opened URL includes
              authentication (query <span className="mono">api_key</span>). Create or manage keys
              on the <a href={API_KEYS_HREF}>API Keys</a> page. If you choose &quot;Remember this
              key&quot; below, private OpenAPI, Swagger UI, Arazzo, and JSON Schema links skip
              this prompt next time on this device.
            </DialogDescription>
          </div>
        </DialogHeader>

        <div className="pub-key-dialog__body">
          <FormField label="API key" htmlFor={FIELD_ID}>
            <Input
              id={FIELD_ID}
              className="mono"
              type="password"
              autoComplete="off"
              value={value}
              onChange={(event) => onValueChange(event.target.value)}
              onKeyDown={(event) => {
                // Enter submits, which is the shape the screen this replaces had and the one a
                // reader pasting a key expects. Guarded on `ready` so an empty Enter is inert
                // rather than opening an unauthenticated tab.
                if (event.key === 'Enter' && ready) {
                  event.preventDefault();
                  onSubmit();
                }
              }}
              placeholder="sk_..."
              data-testid="published-api-key-input"
            />
          </FormField>

          <div className="pub-key-dialog__remember">
            <Checkbox
              id={REMEMBER_ID}
              checked={remember}
              onCheckedChange={(next) => onRememberChange(next === true)}
              data-testid="published-api-key-remember"
            />
            <Label htmlFor={REMEMBER_ID} className="pub-key-dialog__remember-label">
              Remember this key on this browser for the current tenant (local storage only).
            </Label>
          </div>

          {hasSavedKey ? (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="pub-key-dialog__clear"
              onClick={onClearSavedKey}
              data-testid="published-api-key-clear"
            >
              <Eraser aria-hidden />
              Clear saved key from this browser
            </Button>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} data-testid="published-api-key-cancel">
            Cancel
          </Button>
          <Button
            onClick={onSubmit}
            disabled={!ready}
            title={ready ? undefined : 'Enter a key first'}
            data-testid="published-api-key-open"
          >
            Open with key
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default PublishedApiKeyDialog;
