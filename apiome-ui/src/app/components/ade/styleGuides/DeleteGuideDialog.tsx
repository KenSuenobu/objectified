'use client';

import * as React from 'react';
import { Trash2 } from 'lucide-react';

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

import {
  describeStyleGuideDeletion,
  styleGuideDeletionImpact,
  type StyleGuide,
} from './styleGuidesModel';

/**
 * Delete a style guide — HIVE-5.6 (#5309).
 *
 * Authority: `docs/mockups/govern/style-guides.html` `#delete-guide`; DESIGN.md §7.
 *
 * ### What this replaces
 *
 * The decision was a `useDialog().confirm` whose whole content was one generic sentence:
 * *"Its project assignments are removed and those projects fall back to the tenant
 * default."* True, and useless — it says the same thing about a guide that governs nothing
 * and about the tenant default that three projects are pinned to. It also had nowhere to
 * report a refusal: the old handler pushed the error into a page-level banner behind the
 * dialog that had just closed.
 *
 * This dialog names what the deletion actually costs — computed by
 * {@link styleGuideDeletionImpact} from the guide's own assignments and from the built-in
 * guide the server really promotes — and reports a refused write inline, beside the button
 * that caused it.
 */

/** Props for {@link DeleteGuideDialog}. */
export interface DeleteGuideDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** Close it. */
  onOpenChange: (open: boolean) => void;
  /** The guide about to be deleted; `null` while closed. */
  guide: StyleGuide | null;
  /** Every guide, so the fallback can be named rather than assumed. */
  guides: readonly StyleGuide[];
  /**
   * Delete it.
   *
   * @param guide The guide.
   * @returns The error to show inline, or `null` on success.
   */
  onConfirm: (guide: StyleGuide) => Promise<string | null>;
}

/**
 * The delete confirm.
 *
 * @param props See {@link DeleteGuideDialogProps}.
 * @returns The dialog.
 */
export default function DeleteGuideDialog({
  open,
  onOpenChange,
  guide,
  guides,
  onConfirm,
}: DeleteGuideDialogProps) {
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setError('');
    setBusy(false);
  }, [open]);

  const impact = guide ? styleGuideDeletionImpact(guide, guides) : null;
  const consequence = guide && impact ? describeStyleGuideDeletion(impact, guide.name) : null;

  const run = React.useCallback(async () => {
    if (!guide) return;
    setBusy(true);
    setError('');
    const failure = await onConfirm(guide);
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    onOpenChange(false);
  }, [guide, onConfirm, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent size="sm" data-testid="style-guide-delete-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="tnt-icon-tile" data-tone="danger">
              <Trash2 aria-hidden />
            </span>
            Delete style guide
          </DialogTitle>
          <DialogDescription>
            Delete “{guide?.name}”? Its project assignments are removed and those projects fall
            back to the tenant default. This cannot be undone.
          </DialogDescription>
        </DialogHeader>

        <div className="sg-confirm-body">
          {error && (
            <Alert variant="error" data-testid="style-guide-delete-error">
              {error}
            </Alert>
          )}
          {consequence && (
            /* `Alert` draws the warning glyph itself, so none is added here. */
            <Alert variant="warning" data-testid="style-guide-delete-impact">
              {consequence}
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            data-testid="style-guide-delete-submit"
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
