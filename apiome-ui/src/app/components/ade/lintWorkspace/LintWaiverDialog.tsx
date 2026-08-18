'use client';

import * as React from 'react';
import { FileSignature } from 'lucide-react';

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
import { FormField } from '@/app/components/ui/FormField';
import { Input } from '@/app/components/ui/Input';
import { Textarea } from '@/app/components/ui/Textarea';
import type { BulkActionSet } from '@/app/utils/lint-workspace';

import { waiverDialogCopy, type WaiverDialogMode } from './lintWorkspaceModel';

/**
 * The waiver dialog — HIVE-5.8 (#5311).
 *
 * Authority: `docs/mockups/govern/lint-posture.html`, the `#waiver-dialog` overlay and the
 * callout in it that describes the approve variant.
 *
 * One component, two shapes. Requesting a waiver and approving one ask for the same three
 * things — why, against what ticket, until when — and differ only in the title, in whether
 * the expiry is required, and in the permission the server will check. The mockup states
 * that explicitly ("Approving instead? The title becomes…"), and a second component would
 * have been the same form twice.
 *
 * Lifted out of the bulk bar, where it used to live. The bar is a toolbar; a dialog mounted
 * inside a toolbar is a dialog that unmounts when the selection is cleared, which is exactly
 * what happens the moment a write succeeds.
 */

/** Props for {@link LintWaiverDialog}. */
export interface LintWaiverDialogProps {
  /** Which shape the dialog is in, or `null` when it is closed. */
  mode: WaiverDialogMode | null;
  /** How many findings the decision will be applied to. */
  count: number;
  /** True while the write is in flight. */
  busy?: boolean;
  /** Close the dialog without writing. */
  onClose: () => void;
  /** Apply the decision the form describes. */
  onSubmit: (set: BulkActionSet) => void;
}

/**
 * The request/approve waiver form.
 *
 * @param props See {@link LintWaiverDialogProps}.
 * @returns The dialog, or nothing when it is closed.
 */
export default function LintWaiverDialog({
  mode,
  count,
  busy = false,
  onClose,
  onSubmit,
}: LintWaiverDialogProps) {
  const [rationale, setRationale] = React.useState('');
  const [linkedTicket, setLinkedTicket] = React.useState('');
  const [expiresAt, setExpiresAt] = React.useState('');

  // Reset on open rather than on close: a refused write leaves the reader's rationale on
  // screen to correct, and reopening starts clean.
  React.useEffect(() => {
    if (mode) {
      setRationale('');
      setLinkedTicket('');
      setExpiresAt('');
    }
  }, [mode]);

  if (!mode) return null;

  const copy = waiverDialogCopy(mode, count);
  const trimmedRationale = rationale.trim();
  const missingExpiry = copy.expiryRequired && !expiresAt;
  const canSubmit = Boolean(trimmedRationale) && !missingExpiry && !busy;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    const set: BulkActionSet = {
      state: mode === 'approve' ? 'waived' : 'waiver_requested',
      rationale: trimmedRationale,
    };
    if (linkedTicket.trim()) set.linkedTicket = linkedTicket.trim();
    // A date input yields a local calendar day; the API stores an instant, so the day is
    // resolved here rather than being sent as a string the server has to guess the zone of.
    if (expiresAt) set.expiresAt = new Date(expiresAt).toISOString();
    onSubmit(set);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent data-testid="waiver-dialog" data-mode={mode}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="tnt-icon-tile" data-tone="warn">
              <FileSignature aria-hidden />
            </span>
            {copy.title}
          </DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>

        <form className="lw-form" noValidate onSubmit={submit}>
          <FormField
            label="Rationale"
            required
            helperText="Shown in the audit trail and in the finding’s remediation history."
          >
            <Textarea
              autoFocus
              value={rationale}
              data-testid="waiver-rationale"
              placeholder="Why is this finding acceptable?"
              onChange={(event) => setRationale(event.target.value)}
            />
          </FormField>

          <div className="lw-form__row">
            <FormField label="Linked ticket (optional)">
              <Input
                value={linkedTicket}
                data-testid="waiver-ticket"
                placeholder="https://tracker/TICKET-123"
                onChange={(event) => setLinkedTicket(event.target.value)}
              />
            </FormField>
            <FormField
              label={copy.expiryRequired ? 'Expires' : 'Expires (proposed, optional)'}
              required={copy.expiryRequired}
              helperText={
                copy.expiryRequired
                  ? 'An approved waiver always has an end date.'
                  : 'Approvers can change this when they approve.'
              }
            >
              <Input
                type="date"
                value={expiresAt}
                data-testid="waiver-expires"
                onChange={(event) => setExpiresAt(event.target.value)}
              />
            </FormField>
          </div>

          {mode === 'approve' && (
            <Alert variant="info" data-testid="waiver-permission-note">
              <span>
                Approving needs the <span className="mono">lint_findings:publish</span>{' '}
                permission. Findings the server refuses are reported individually — nothing
                else in the selection is rolled back.
              </span>
            </Alert>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" data-testid="waiver-submit" disabled={!canSubmit}>
              {copy.submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
