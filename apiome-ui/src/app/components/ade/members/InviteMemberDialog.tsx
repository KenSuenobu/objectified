'use client';

import * as React from 'react';
import { Send, UserPlus } from 'lucide-react';

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
import { Meter } from '@/app/components/ui/metrics';
import { Spinner } from '@/app/components/ui/Spinner';
import type { TenantLicenseSeats } from '@/app/ade/dashboard/tenants/licenseApi';
import { formatSeatUsage, seatsUnlimited } from '@/app/ade/dashboard/tenants/licenseSeats';

import {
  seatsAfterInvite,
  validateInvite,
  SEATS_EXHAUSTED_TITLE,
  type RoleRecord,
} from './membersModel';

/**
 * Invite member — HIVE-5.2 (#5305).
 *
 * Authority: `docs/mockups/workspace/members.html` `#invite-dialog`, and the Keeps list that
 * fixes its fields ("email + Role select (`Default role` + every role) + submit"), its
 * validation message and the `title` it carries at capacity.
 *
 * ### Why this is a dialog now
 *
 * The screen this replaces kept the invite as a **card wedged between the seat meter and the
 * table**, permanently occupying a third of the first screenful whether or not anyone was
 * inviting. Worse, it was the surface that decided whether inviting was possible at all: the
 * form was rendered only when `canInvite`, so a viewer without the grant saw a page whose
 * layout was different rather than a page with one fewer action. Here the decision lives on
 * the page header's primary button and the dialog is what opens behind it — the mockup's
 * arrangement, and the one where the page looks the same to everyone.
 *
 * ### The seat forecast
 *
 * The card at the bottom is the one thing the mockup adds and the old form had no equivalent
 * for: what the licence will read *after* this invitation. It is the same
 * `formatSeatUsage` sentence and the same `Meter` the page's seat card draws, so pressing
 * Send has a visible consequence rather than an invisible one.
 */

/** The form's id, so the footer's submit can be associated with it across the dialog. */
const FORM_ID = 'members-invite-form';

/** Props for {@link InviteMemberDialog}. */
export interface InviteMemberDialogProps {
  open: boolean;
  /** Called with `false` on cancel, dismiss or a successful invite. */
  onOpenChange: (open: boolean) => void;
  /** The tenant's roles, for the role select. */
  roles: readonly RoleRecord[];
  /** Seat usage from the licence, or `null` when it could not be read. */
  seats: TenantLicenseSeats | null;
  /** True when the licence has no seat left, so the submit is refused before it is tried. */
  atCapacity: boolean;
  /**
   * Send the invitation.
   *
   * @param input The typed address and the chosen role (empty for the tenant's default).
   * @returns The error to show inline, or `null` when the invite succeeded.
   */
  onSubmit: (input: { email: string; roleId: string }) => Promise<string | null>;
}

/**
 * The invite dialog.
 *
 * @param props See {@link InviteMemberDialogProps}.
 * @returns The dialog.
 */
export default function InviteMemberDialog({
  open,
  onOpenChange,
  roles,
  seats,
  atCapacity,
  onSubmit,
}: InviteMemberDialogProps) {
  const [email, setEmail] = React.useState('');
  const [roleId, setRoleId] = React.useState('');
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  // Reset on open rather than on close: a dialog that clears while it is animating away shows
  // the reader their own text disappearing. Same reasoning as `TenantMemberDialogs`.
  React.useEffect(() => {
    if (!open) return;
    setEmail('');
    setRoleId('');
    setError('');
    setBusy(false);
  }, [open]);

  const submit = React.useCallback(async () => {
    const problem = validateInvite(email);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError('');
    const failure = await onSubmit({ email: email.trim(), roleId });
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    onOpenChange(false);
  }, [email, onOpenChange, onSubmit, roleId]);

  const forecast = seats && !seatsUnlimited(seats) ? seatsAfterInvite(seats) : null;

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent size="sm" data-testid="members-invite-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="tnt-icon-tile" data-tone="accent">
              <UserPlus aria-hidden />
            </span>
            Invite member
          </DialogTitle>
          <DialogDescription>
            They receive access as soon as they accept, and appear as Pending until they do.
          </DialogDescription>
        </DialogHeader>

        <form
          id={FORM_ID}
          data-testid="members-invite-form"
          className="space-y-4 py-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy && !atCapacity) void submit();
          }}
        >
          {error && <Alert variant="error">{error}</Alert>}

          <div className="space-y-2">
            <Label htmlFor="inviteEmail">Email address</Label>
            <Input
              id="inviteEmail"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="person@example.com"
              disabled={busy || atCapacity}
              autoFocus
            />
            <p className="text-xs text-fg-muted">
              They must already have an Apiome account — invitations are not emailed.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="inviteRole">Role</Label>
            <select
              id="inviteRole"
              className="hive-control mbr-role-select h-[var(--control-h)] w-full text-sm"
              value={roleId}
              disabled={busy || atCapacity}
              onChange={(event) => setRoleId(event.target.value)}
            >
              <option value="">Default role</option>
              {roles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.name}
                </option>
              ))}
            </select>
            <p className="text-xs text-fg-muted">You can change it inline afterwards.</p>
          </div>

          {forecast && (
            <div className="rounded-md bg-subtle px-3 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-fg">Seats after this invite</span>
                <span className="text-sm font-semibold tabular-nums text-fg">
                  {forecast.used} of {forecast.max}
                </span>
              </div>
              <div className="mt-2">
                <Meter
                  label="Member seats after this invite"
                  value={forecast.used}
                  max={forecast.max}
                  valueText={formatSeatUsage(forecast)}
                  showValue={false}
                />
              </div>
            </div>
          )}

          {atCapacity && <Alert variant="warn">{SEATS_EXHAUSTED_TITLE}</Alert>}
        </form>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          {/* Owned by the form through `form=`, though it sits outside it: the dialog's
              footer is a sibling region, and a form whose only submit control is elsewhere
              does not answer ↵ in the email field at all. Association fixes that without a
              second, hidden button nobody can see. */}
          <Button
            type="submit"
            form={FORM_ID}
            disabled={busy || atCapacity}
            aria-disabled={busy || atCapacity}
            title={atCapacity ? SEATS_EXHAUSTED_TITLE : undefined}
          >
            {busy ? <Spinner size="sm" aria-hidden /> : <Send aria-hidden />}
            {busy ? 'Sending…' : 'Send invite'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
