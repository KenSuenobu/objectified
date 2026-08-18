'use client';

import * as React from 'react';
import { BookPlus, Copy, Info, Pencil, Sparkles } from 'lucide-react';

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
import { Spinner } from '@/app/components/ui/Spinner';
import { Textarea } from '@/app/components/ui/Textarea';

import {
  duplicateGuideName,
  guideSourceOptionLabel,
  type StyleGuide,
} from './styleGuidesModel';

/**
 * The style-guide form dialogs — HIVE-5.6 (#5309).
 *
 * Authority: `docs/mockups/govern/style-guides.html` `#create-guide`,
 * `#create-guide-recommended`, `#dup-guide` and `#edit-guide`; DESIGN.md §7.
 *
 * Three of the mockup's four overlays are **one component**. New guide, Start from
 * Recommended and Duplicate differ only in which guide the "Copy rules from" picker opens on
 * and what the title says — the fields, the copy, the validation and the POST are identical,
 * and three files would be three places for them to drift. {@link GuideFormDialog} takes the
 * source guide and derives the rest.
 *
 * Editing is a genuinely different write (a PATCH of name and description on a guide that
 * exists), so {@link EditGuideDialog} is its own component — and it says outright that rules
 * are edited on the guide's own page, which is the question the dialog otherwise invites.
 */

// ---------------------------------------------------------------------------------------
// New / Start from Recommended / Duplicate
// ---------------------------------------------------------------------------------------

/** What the create dialog is being opened for. */
export type GuideFormMode = 'new' | 'duplicate' | 'recommended';

/** The form's state — exactly what a create POST carries. */
export interface GuideDraft {
  /** The new guide's name. Required. */
  name: string;
  /** Its description, or `''`. */
  description: string;
  /** The guide whose rules are copied, or `''` for an empty guide. */
  sourceGuideId: string;
}

/** Props for {@link GuideFormDialog}. */
export interface GuideFormDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** Close it. */
  onOpenChange: (open: boolean) => void;
  /** Why it was opened — decides the title, the glyph and the prefilled name. */
  mode: GuideFormMode;
  /** The guide whose rules the new guide copies; `null` starts empty. */
  sourceGuide: StyleGuide | null;
  /** Every guide, for the "Copy rules from" picker. */
  guides: readonly StyleGuide[];
  /**
   * Create the guide.
   *
   * @param draft The form's state.
   * @returns The error to show inline, or `null` on success — the dialog closes itself only
   *   when the write actually worked.
   */
  onSubmit: (draft: GuideDraft) => Promise<string | null>;
}

/** Prefix for the create dialog's field ids — one create dialog is mounted at a time. */
const CREATE_FIELD_ID = 'style-guide-create';

/** Prefix for the edit dialog's field ids. */
const EDIT_FIELD_ID = 'style-guide-edit';

/** The title, description and glyph each mode opens with. */
const MODE_CHROME: Readonly<
  Record<GuideFormMode, { title: string; description: string; tone: string }>
> = {
  new: {
    title: 'New style guide',
    description: 'Create a custom style guide, empty or copying an existing guide’s rules.',
    tone: 'honey',
  },
  recommended: {
    title: 'New style guide',
    description: 'Create a custom style guide, empty or copying an existing guide’s rules.',
    tone: 'honey',
  },
  duplicate: {
    title: 'Duplicate style guide',
    description: '',
    tone: 'accent',
  },
};

/**
 * The create dialog, in its three moods.
 *
 * @param props See {@link GuideFormDialogProps}.
 * @returns The dialog.
 */
export function GuideFormDialog({
  open,
  onOpenChange,
  mode,
  sourceGuide,
  guides,
  onSubmit,
}: GuideFormDialogProps) {
  const [draft, setDraft] = React.useState<GuideDraft>({
    name: '',
    description: '',
    sourceGuideId: '',
  });
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  // Opening is what seeds the form, not closing: a write that failed leaves the dialog open
  // with what the reader typed still in it. `sourceGuide` is in the deps because the same
  // dialog is reopened for a different guide from every row's Duplicate.
  React.useEffect(() => {
    if (!open) return;
    setDraft({
      name: sourceGuide ? duplicateGuideName(sourceGuide.name) : '',
      description: sourceGuide?.description ?? '',
      sourceGuideId: sourceGuide?.id ?? '',
    });
    setError('');
    setBusy(false);
  }, [open, sourceGuide]);

  const chrome = MODE_CHROME[mode];
  const description =
    mode === 'duplicate' && sourceGuide
      ? `Creates an editable copy of “${sourceGuide.name}” with the same rules.`
      : chrome.description;

  const submit = React.useCallback(async () => {
    if (!draft.name.trim()) {
      setError('Give the guide a name.');
      return;
    }
    setBusy(true);
    setError('');
    const failure = await onSubmit({ ...draft, name: draft.name.trim() });
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    onOpenChange(false);
  }, [draft, onOpenChange, onSubmit]);

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent data-testid="style-guide-create-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="tnt-icon-tile" data-tone={chrome.tone}>
              {mode === 'duplicate' ? (
                <Copy aria-hidden />
              ) : mode === 'recommended' ? (
                <Sparkles aria-hidden />
              ) : (
                <BookPlus aria-hidden />
              )}
            </span>
            {chrome.title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <form
          className="sg-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {error && (
            <Alert variant="error" data-testid="style-guide-create-error">
              {error}
            </Alert>
          )}

          <div className="sg-field">
            <Label htmlFor={`${CREATE_FIELD_ID}-name`}>
              Name <span aria-hidden="true">*</span>
            </Label>
            <Input
              id={`${CREATE_FIELD_ID}-name`}
              value={draft.name}
              placeholder="e.g. Payments API Guide"
              required
              autoFocus
              disabled={busy}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </div>

          <div className="sg-field">
            <Label htmlFor={`${CREATE_FIELD_ID}-description`}>
              Description <span className="sg-field__optional">(optional)</span>
            </Label>
            <Textarea
              id={`${CREATE_FIELD_ID}-description`}
              value={draft.description}
              placeholder="What this guide enforces…"
              rows={2}
              disabled={busy}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
          </div>

          <div className="sg-field">
            <Label htmlFor={`${CREATE_FIELD_ID}-source`}>Copy rules from</Label>
            <select
              id={`${CREATE_FIELD_ID}-source`}
              className="hive-control sg-select"
              value={draft.sourceGuideId}
              disabled={busy}
              onChange={(event) => setDraft({ ...draft, sourceGuideId: event.target.value })}
            >
              <option value="">Empty guide (no rules)</option>
              {guides.map((guide) => (
                <option key={guide.id} value={guide.id}>
                  {guideSourceOptionLabel(guide)}
                </option>
              ))}
            </select>
            <p className="sg-field__hint">
              Copies the enabled set and severities; you can tailor them afterwards.
            </p>
          </div>
        </form>

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={busy}
            data-testid="style-guide-create-submit"
            onClick={() => void submit()}
          >
            {busy ? <Spinner size="sm" aria-hidden /> : null}
            {busy ? 'Creating…' : 'Create guide'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------------------

/** Props for {@link EditGuideDialog}. */
export interface EditGuideDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** Close it. */
  onOpenChange: (open: boolean) => void;
  /** The guide being renamed; `null` while closed. */
  guide: StyleGuide | null;
  /** Where the guide's own page lives, for the note about rules. */
  guideHref: string;
  /**
   * Save the change.
   *
   * @param name The new name.
   * @param description The new description.
   * @returns The error to show inline, or `null` on success.
   */
  onSubmit: (name: string, description: string) => Promise<string | null>;
}

/**
 * Rename a guide, or change its description.
 *
 * @param props See {@link EditGuideDialogProps}.
 * @returns The dialog.
 */
export function EditGuideDialog({
  open,
  onOpenChange,
  guide,
  guideHref,
  onSubmit,
}: EditGuideDialogProps) {
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setName(guide?.name ?? '');
    setDescription(guide?.description ?? '');
    setError('');
    setBusy(false);
  }, [open, guide]);

  const submit = React.useCallback(async () => {
    if (!name.trim()) {
      setError('Give the guide a name.');
      return;
    }
    setBusy(true);
    setError('');
    const failure = await onSubmit(name.trim(), description.trim());
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    onOpenChange(false);
  }, [description, name, onOpenChange, onSubmit]);

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent data-testid="style-guide-edit-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="tnt-icon-tile">
              <Pencil aria-hidden />
            </span>
            Edit style guide
          </DialogTitle>
          <DialogDescription>Rename the guide or update its description.</DialogDescription>
        </DialogHeader>

        <form
          className="sg-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {error && (
            <Alert variant="error" data-testid="style-guide-edit-error">
              {error}
            </Alert>
          )}

          <div className="sg-field">
            <Label htmlFor={`${EDIT_FIELD_ID}-name`}>
              Name <span aria-hidden="true">*</span>
            </Label>
            <Input
              id={`${EDIT_FIELD_ID}-name`}
              value={name}
              required
              autoFocus
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <div className="sg-field">
            <Label htmlFor={`${EDIT_FIELD_ID}-description`}>Description</Label>
            <Textarea
              id={`${EDIT_FIELD_ID}-description`}
              value={description}
              rows={2}
              disabled={busy}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>

          {/* The question this dialog invites, answered before it is asked. */}
          <p className="sg-dialog-note">
            <Info aria-hidden />
            <span>
              Rules and policy are edited on the guide page —{' '}
              <a className="sg-inline-link" href={guideHref}>
                open {guide?.name}
              </a>
              .
            </span>
          </p>
        </form>

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={busy}
            data-testid="style-guide-edit-submit"
            onClick={() => void submit()}
          >
            {busy ? <Spinner size="sm" aria-hidden /> : null}
            {busy ? 'Saving…' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
