'use client';

import * as React from 'react';
import { Power, RotateCcw, ShieldAlert, TriangleAlert, UserMinus } from 'lucide-react';

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
  describeAdminsRemaining,
  describeOffboard,
  isPendingInvite,
  memberDisplayName,
  type MemberRecord,
} from './membersModel';

/**
 * The two lifecycle confirms — HIVE-5.2 (#5305).
 *
 * Authority: `docs/mockups/workspace/members.html`, the `#suspend-dialog`, `#offboard-dialog`
 * and `#offboard-admin-dialog` overlays.
 *
 * ### What these replace
 *
 * The offboard confirm was a `useDialog().confirm` built by `destructiveConfirm` — a real
 * dialog, but one whose whole content is a sentence, so the elevated administrator case could
 * only ever be more prose. The mockup draws it as a distinct variant carrying a danger
 * banner, which is what {@link OffboardMemberDialog} is.
 *
 * Suspending had **no** confirm at all: the power button in the row suspended immediately,
 * and a mis-click locked a colleague out of the workspace with no way to notice before it
 * happened. {@link SuspendMemberDialog} is the mockup's "light confirm", and it says the two
 * things that make it safe to press — that the seat is kept, and that reinstating is one
 * click from the row.
 *
 * Both live in one file because they are one conversation about one person, they share the
 * busy/error shape, and each is small enough that a file of its own would be mostly imports.
 */

/** What a confirm does when it is pressed: perform the write, or report why it failed. */
type ConfirmHandler = (member: MemberRecord) => Promise<string | null>;

/**
 * The busy/error state every confirm in this file keeps, plus the run that maintains it.
 *
 * A hook rather than duplicated state: the two dialogs differ in what they say and in the
 * colour of their primary, not in how they behave while the write is in flight.
 *
 * @param options.open Whether the dialog is open, so the state resets when it opens.
 * @param options.member The person the dialog is about.
 * @param options.onConfirm The write.
 * @param options.onOpenChange Called with `false` once the write succeeds.
 * @returns The inline error, whether a write is running, and the runner.
 */
function useConfirmAction(options: {
  open: boolean;
  member: MemberRecord | null;
  onConfirm: ConfirmHandler;
  onOpenChange: (open: boolean) => void;
}) {
  const { open, member, onConfirm, onOpenChange } = options;
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setError('');
    setBusy(false);
  }, [open]);

  const run = React.useCallback(async () => {
    if (!member) return;
    setBusy(true);
    setError('');
    const failure = await onConfirm(member);
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    onOpenChange(false);
  }, [member, onConfirm, onOpenChange]);

  return { error, busy, run };
}

/** Props shared by both confirms. */
interface LifecycleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The person the dialog is about; `null` while it is closed. */
  member: MemberRecord | null;
  /**
   * Perform the action.
   *
   * @param member The person.
   * @returns The error to show inline, or `null` on success.
   */
  onConfirm: ConfirmHandler;
}

/** Props for {@link SuspendMemberDialog}. */
export type SuspendMemberDialogProps = LifecycleDialogProps & {
  /** The workspace they would lose access to, named in the consequence sentence. */
  tenantName: string;
};

/**
 * Suspend, or reinstate — the light confirm the mockup adds.
 *
 * One dialog for both directions: they are the same decision pointing opposite ways, and a
 * second component would only differ in three strings. Reinstating can be refused by the
 * licence (a suspended member holds no seat, so coming back consumes one), which is why it
 * takes the same inline-error treatment as everything else here rather than assuming success.
 *
 * @param props See {@link SuspendMemberDialogProps}.
 * @returns The dialog.
 */
export function SuspendMemberDialog({
  open,
  onOpenChange,
  member,
  tenantName,
  onConfirm,
}: SuspendMemberDialogProps) {
  const { error, busy, run } = useConfirmAction({ open, member, onConfirm, onOpenChange });
  const reinstating = member?.status === 'suspended';
  const name = member ? memberDisplayName(member) : 'this member';

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent size="sm" role="alertdialog" data-testid="member-suspend-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="tnt-icon-tile" data-tone={reinstating ? 'ok' : 'warn'}>
              {reinstating ? <RotateCcw aria-hidden /> : <Power aria-hidden />}
            </span>
            {reinstating ? `Reinstate ${name}?` : `Suspend ${name}?`}
          </DialogTitle>
          <DialogDescription>
            {reinstating
              ? `They can sign in to ${tenantName} again, and take back a licensed seat.`
              : `They keep their seat but cannot sign in to ${tenantName} until reinstated. Reinstate is one click from the row.`}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="py-4">
            <Alert variant="error">{error}</Alert>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void run()} disabled={busy}>
            {busy && <Spinner size="sm" aria-hidden />}
            {busy
              ? reinstating
                ? 'Reinstating…'
                : 'Suspending…'
              : reinstating
                ? 'Reinstate'
                : 'Suspend'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Props for {@link OffboardMemberDialog}. */
export type OffboardMemberDialogProps = LifecycleDialogProps & {
  /** The workspace they would lose access to. */
  tenantName: string;
  /** Every member of the tenant, so the administrator warning can count what is left. */
  members: readonly MemberRecord[];
};

/**
 * Offboard a member, or cancel an outstanding invitation.
 *
 * The administrator variant is not a different dialog but the same one carrying a danger
 * banner, because the decision is the same decision with one more consequence — the shape
 * {@link ../tenants/TenantMemberDialogs.RemoveMemberDialog} settled on. What is new here is
 * that the banner **counts**: "Removing them leaves 1 administrator" is computed from the
 * roster rather than asserted, so a warning about the last administrator is a warning the
 * screen can actually make.
 *
 * The mockup also offers a "Revoke their API keys and MCP keys as well" checkbox. It is
 * deliberately absent: `DELETE /v1/access/{slug}/members/{id}` removes the membership, the
 * role assignment and the tenant-admin row, and there is no parameter — and no second
 * endpoint — that would revoke their keys. A checkbox that changes nothing is worse than no
 * checkbox, so the consequence sentence says what actually happens instead.
 *
 * @param props See {@link OffboardMemberDialogProps}.
 * @returns The dialog.
 */
export function OffboardMemberDialog({
  open,
  onOpenChange,
  member,
  tenantName,
  members,
  onConfirm,
}: OffboardMemberDialogProps) {
  const { error, busy, run } = useConfirmAction({ open, member, onConfirm, onOpenChange });
  const consequence = member ? describeOffboard(member, members) : null;
  const invite = Boolean(member && isPendingInvite(member));
  const name = member ? memberDisplayName(member) : 'this member';
  const elevated = Boolean(consequence?.isAdmin);

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent size="sm" role="alertdialog" data-testid="member-offboard-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="tnt-icon-tile" data-tone="danger">
              {elevated ? <TriangleAlert aria-hidden /> : <UserMinus aria-hidden />}
            </span>
            {invite ? `Cancel the invitation for ${name}?` : `Offboard ${name}?`}
          </DialogTitle>
          <DialogDescription>
            {invite
              ? `They will not be able to join ${tenantName} with this invitation, and the seat it holds is returned to the licence.`
              : `They lose all access to ${tenantName} immediately and their seat is returned to the licence. Their projects, versions and audit entries stay in the workspace.`}
          </DialogDescription>
        </DialogHeader>

        {(elevated || error) && (
          <div className="space-y-3 py-4">
            {error && <Alert variant="error">{error}</Alert>}
            {elevated && consequence && (
              <Alert variant="danger" data-testid="member-offboard-admin-warning">
                <span className="flex items-start gap-2">
                  <ShieldAlert className="mt-0.5 size-[var(--icon-dense)] shrink-0" aria-hidden />
                  <span>
                    <strong className="block">{name} is an administrator</strong>
                    {describeAdminsRemaining(consequence)}
                  </span>
                </span>
              </Alert>
            )}
          </div>
        )}

        <DialogFooter>
          {/* "Keep invitation" rather than "Cancel" on the invite variant: a dialog whose
              dismiss button and whose destructive button both read "Cancel" asks the reader
              to guess which cancel is which. */}
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {invite ? 'Keep invitation' : 'Cancel'}
          </Button>
          <Button variant="danger" onClick={() => void run()} disabled={busy}>
            {busy && <Spinner size="sm" aria-hidden />}
            {busy
              ? invite
                ? 'Cancelling…'
                : 'Offboarding…'
              : invite
                ? 'Cancel invite'
                : 'Offboard'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
