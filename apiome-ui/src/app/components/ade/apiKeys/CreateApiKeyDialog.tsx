'use client';

import * as React from 'react';
import { KeyRound } from 'lucide-react';

import { Alert } from '@/app/components/ui/Alert';
import { Badge } from '@/app/components/ui/Badge';
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
import { Spinner } from '@/app/components/ui/Spinner';
import { Textarea } from '@/app/components/ui/Textarea';

import {
  validateApiKeyDraft,
  API_KEY_SCOPE_PRESET_OPTIONS,
  EMPTY_API_KEY_DRAFT,
  type ApiKeyDraft,
} from './apiKeysModel';

/**
 * Create an API key — HIVE-5.4 (#5307).
 *
 * Authority: `docs/mockups/workspace/api-keys.html` `#create-key-dialog`; DESIGN.md §7
 * (fields and dialogs).
 *
 * The four fields are the ones the screen this replaces had, with the same copy, the same
 * placeholders and the same validation message — the mockup's notes list all of that under
 * **Keeps (1:1)**. What is new is how the scopes are asked.
 *
 * ### Why the presets are cards and not a radio list
 *
 * A scope is the single most consequential choice on this screen: `*` is every REST
 * operation this tenant can perform, and it is the default. The control it replaces was four
 * one-line radio labels with the scope strings folded into the label text
 * (`"CI: classified diff (diff:read)"`), which put the thing that decides what the key may
 * do inside a parenthesis. Each option is now a card whose lead line carries the **scope
 * strings as badges** — the same strings the row will show and the same ones the server
 * stores — with the sentence about what it allows underneath.
 *
 * The radios are real `<input type="radio">` in a real `radiogroup`, so arrow keys move
 * between them and the whole card is the label's hit area.
 */

/** Props for {@link CreateApiKeyDialog}. */
export interface CreateApiKeyDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** Close it. */
  onOpenChange: (open: boolean) => void;
  /**
   * Create the key.
   *
   * @param draft The form's state.
   * @returns The error to show inline, or `null` on success — the dialog closes itself only
   *   when the write actually worked.
   */
  onSubmit: (draft: ApiKeyDraft) => Promise<string | null>;
}

/** The radio group's `name`, shared by the four inputs so they are one choice. */
const SCOPE_RADIO_NAME = 'api-key-scope-preset';

/**
 * Prefix for the dialog's field ids.
 *
 * Fixed rather than `useId`-generated: exactly one create dialog is mounted at a time — it is
 * the page's own overlay — and a stable id is what lets the label/control association be
 * asserted, and read, without chasing a generated suffix.
 */
const FIELD_ID = 'api-key';

/**
 * The create dialog.
 *
 * @param props See {@link CreateApiKeyDialogProps}.
 * @returns The dialog.
 */
export default function CreateApiKeyDialog({
  open,
  onOpenChange,
  onSubmit,
}: CreateApiKeyDialogProps) {
  const [draft, setDraft] = React.useState<ApiKeyDraft>(EMPTY_API_KEY_DRAFT);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  // Opening is what resets the form, not closing: a write that failed leaves the dialog open
  // with what the reader typed still in it, and clearing on close would also clear it when
  // the close is the successful one — where there is nothing left to keep anyway.
  React.useEffect(() => {
    if (!open) return;
    setDraft(EMPTY_API_KEY_DRAFT);
    setError('');
    setBusy(false);
  }, [open]);

  /**
   * Change one field of the draft.
   *
   * @param patch The fields to replace.
   */
  const update = React.useCallback((patch: Partial<ApiKeyDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
  }, []);

  const submit = React.useCallback(async () => {
    const invalid = validateApiKeyDraft(draft);
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError('');
    const failure = await onSubmit(draft);
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    onOpenChange(false);
  }, [draft, onOpenChange, onSubmit]);

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent data-testid="api-key-create-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="tnt-icon-tile" data-tone="honey">
              <KeyRound aria-hidden />
            </span>
            Create API key
          </DialogTitle>
          <DialogDescription>Create a new API key for REST API access.</DialogDescription>
        </DialogHeader>

        <form
          className="akey-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {error && (
            <Alert variant="error" data-testid="api-key-create-error">
              {error}
            </Alert>
          )}

          <div className="akey-field">
            <Label htmlFor={`${FIELD_ID}-name`}>
              Name <span aria-hidden="true">*</span>
            </Label>
            <Input
              id={`${FIELD_ID}-name`}
              value={draft.name}
              placeholder="My API Key"
              required
              autoFocus
              disabled={busy}
              onChange={(event) => update({ name: event.target.value })}
            />
            <p className="akey-field__hint">A descriptive name for this API key</p>
          </div>

          <div className="akey-field">
            <Label htmlFor={`${FIELD_ID}-description`}>Description</Label>
            <Textarea
              id={`${FIELD_ID}-description`}
              value={draft.description}
              placeholder="What is this key used for?"
              rows={3}
              disabled={busy}
              onChange={(event) => update({ description: event.target.value })}
            />
          </div>

          <div className="akey-field">
            {/*
              A `<span>` labelling a `role="radiogroup"`, not a `<fieldset>`/`<legend>` around
              one: the two would nest a group inside a group and a screen reader announces
              both. The radiogroup is the more precise of the two, so it is the one kept.
            */}
            <span className="akey-scope-legend" id={`${FIELD_ID}-scopes`}>
              Scopes
            </span>
            <div
              className="akey-scope-list"
              role="radiogroup"
              aria-labelledby={`${FIELD_ID}-scopes`}
            >
              {API_KEY_SCOPE_PRESET_OPTIONS.map((option) => {
                const checked = draft.preset === option.value;
                return (
                  <label
                    key={option.value}
                    className="akey-scope-card"
                    data-checked={checked || undefined}
                    data-testid={`api-key-scope-${option.value}`}
                  >
                    <input
                      type="radio"
                      className="akey-scope-radio"
                      name={SCOPE_RADIO_NAME}
                      value={option.value}
                      checked={checked}
                      disabled={busy}
                      onChange={() => update({ preset: option.value })}
                    />
                    <span className="akey-scope-body">
                      <span className="akey-scope-title">
                        {option.label}
                        {option.scopes.map((scope) => (
                          <Badge
                            key={scope}
                            className="akey-scope-badge"
                            mono
                            variant={scope === '*' ? 'neutral' : 'accent'}
                          >
                            {scope}
                          </Badge>
                        ))}
                      </span>
                      <span className="akey-scope-hint">{option.hint}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>

          <div className="akey-field akey-expiry-field">
            <Label htmlFor={`${FIELD_ID}-expiry`}>Expires in (days)</Label>
            <Input
              id={`${FIELD_ID}-expiry`}
              type="number"
              min={1}
              step={1}
              value={draft.expiresInDays}
              placeholder="Leave empty for no expiration"
              disabled={busy}
              onChange={(event) => update({ expiresInDays: event.target.value })}
            />
            <p className="akey-field__hint">Leave empty for no expiration.</p>
          </div>
        </form>

        <DialogFooter>
          <span className="akey-dialog-note">
            MCP presets live under MCP servers → Capabilities.
          </span>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void submit()}>
            {busy ? <Spinner size="sm" aria-hidden /> : <KeyRound aria-hidden />}
            {busy ? 'Creating…' : 'Create API key'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
