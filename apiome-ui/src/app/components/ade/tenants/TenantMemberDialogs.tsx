'use client';

import * as React from 'react';
import { Shield, ShieldAlert, TriangleAlert, UserMinus, UserPlus } from 'lucide-react';

import { Alert } from '@/app/components/ui/Alert';
import { Avatar } from '@/app/components/ui/Avatar';
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
import { Input } from '@/app/components/ui/Input';
import { Label } from '@/app/components/ui/Label';
import { Spinner } from '@/app/components/ui/Spinner';

import type { TenantMember } from './tenantsModel';

/**
 * The three membership dialogs of the manage drawer — HIVE-5.1 (#5304).
 *
 * Authority: `docs/mockups/workspace/tenants.html` — the `#add-member`, `#edit-roles`,
 * `#remove-member` and `#remove-member-admin` overlays, and the Keeps list that fixes their
 * copy.
 *
 * They live in one file because they are one conversation about one person, they share the
 * `Administrator` control and its helper sentence, and each is small enough that a file of
 * its own would be mostly import block. Each is a controlled dialog: the drawer owns
 * whether it is open and who it is about, which is what keeps two open drawers from sharing
 * a dialog the way the old screen's single `showAddMemberModal` did.
 *
 * The one behaviour worth naming is *Remove*. The screen this replaces asked through
 * `window.confirm`-shaped `useDialog().confirm`, which meant the admin warning arrived as a
 * `⚠️ WARNING:` line inside a paragraph of plain text. DESIGN.md §5.4 asks for a real
 * `alertdialog` with a red primary that names the object, and the mockup draws the admin
 * case as a distinct variant with a danger banner — so that is what {@link RemoveMemberDialog}
 * is, rather than a string with an emoji in it.
 */

/** The sentence under the Administrator checkbox, in all three dialogs that show it. */
const ADMIN_HELP_COPY = 'Administrators can manage tenant members and settings.';

/** Props for {@link AddMemberDialog}. */
export interface AddMemberDialogProps {
  open: boolean;
  /** Called with `false` on cancel, dismiss or a successful add. */
  onOpenChange: (open: boolean) => void;
  /** The tenant being added to, for the dialog's sub-line. */
  tenantName: string;
  /**
   * Add the person.
   *
   * @param input The typed email and whether they should administer the tenant.
   * @returns The error to show inline, or `null` when the add succeeded.
   */
  onSubmit: (input: { email: string; isAdmin: boolean }) => Promise<string | null>;
}

/**
 * Add member — email plus an optional administrator role.
 *
 * Validation is deliberately thin: an empty field is refused here with the message the
 * screen already used, and everything else (unknown address, already a member, seats
 * exhausted) is the API's answer, shown verbatim. A dialog that guesses at those rules
 * drifts from the server that enforces them.
 *
 * @param props See {@link AddMemberDialogProps}.
 * @returns The dialog.
 */
export function AddMemberDialog({
  open,
  onOpenChange,
  tenantName,
  onSubmit,
}: AddMemberDialogProps) {
  const [email, setEmail] = React.useState('');
  const [isAdmin, setIsAdmin] = React.useState(false);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  // Reset on open rather than on close: a dialog that clears while it is animating away
  // shows the reader their own text disappearing.
  React.useEffect(() => {
    if (!open) return;
    setEmail('');
    setIsAdmin(false);
    setError('');
    setBusy(false);
  }, [open]);

  const submit = React.useCallback(async () => {
    if (!email.trim()) {
      setError('Please enter an email address');
      return;
    }
    setBusy(true);
    setError('');
    const failure = await onSubmit({ email: email.trim(), isAdmin });
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    onOpenChange(false);
  }, [email, isAdmin, onOpenChange, onSubmit]);

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="tnt-icon-tile" data-tone="accent">
              <UserPlus aria-hidden />
            </span>
            Add member
          </DialogTitle>
          <DialogDescription>Add a new member to {tenantName}.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {error && <Alert variant="error">{error}</Alert>}

          <div className="space-y-2">
            <Label htmlFor="tnt-add-member-email">Email address</Label>
            <Input
              id="tnt-add-member-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !busy) void submit();
              }}
              placeholder="user@example.com"
              disabled={busy}
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center gap-3">
              <Checkbox
                id="tnt-add-member-admin"
                checked={isAdmin}
                onCheckedChange={(checked) => setIsAdmin(checked === true)}
                disabled={busy}
              />
              <Label htmlFor="tnt-add-member-admin" className="flex cursor-pointer items-center gap-1.5">
                <Shield className="size-[var(--icon-button)] text-violet" aria-hidden />
                Administrator
              </Label>
            </div>
            <p className="ml-8 text-xs text-fg-muted">{ADMIN_HELP_COPY}</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            {busy && <Spinner size="sm" aria-hidden />}
            {busy ? 'Adding…' : 'Add member'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Props for {@link EditMemberRolesDialog}. */
export interface EditMemberRolesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The person whose roles are being edited; `null` while the dialog is closed. */
  member: TenantMember | null;
  /**
   * Save the roles.
   *
   * @param input The member and their administrator flag after the edit.
   * @returns The error to show inline, or `null` on success.
   */
  onSubmit: (input: { member: TenantMember; isAdmin: boolean }) => Promise<string | null>;
}

/**
 * Edit member roles — the identity card, and the one role that is editable.
 *
 * Only the administrator flag is offered because it is the only role the tenant tables
 * model: `tenant_users` membership is what the Remove action governs, not a checkbox.
 *
 * @param props See {@link EditMemberRolesDialogProps}.
 * @returns The dialog.
 */
export function EditMemberRolesDialog({
  open,
  onOpenChange,
  member,
  onSubmit,
}: EditMemberRolesDialogProps) {
  const [isAdmin, setIsAdmin] = React.useState(false);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open || !member) return;
    setIsAdmin(member.isAdmin);
    setError('');
    setBusy(false);
  }, [open, member]);

  const submit = React.useCallback(async () => {
    if (!member) return;
    setBusy(true);
    setError('');
    const failure = await onSubmit({ member, isAdmin });
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    onOpenChange(false);
  }, [isAdmin, member, onOpenChange, onSubmit]);

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Edit member roles</DialogTitle>
          <DialogDescription>
            Update roles for {member?.name ?? 'this member'}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {error && <Alert variant="error">{error}</Alert>}

          {member && (
            <div className="flex items-center gap-3 rounded-md bg-subtle px-3 py-2.5">
              <Avatar name={member.name} size="sm" />
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-fg">{member.name}</div>
                <div className="truncate font-mono text-xs text-fg-muted">{member.email}</div>
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <div className="flex items-center gap-3">
              <Checkbox
                id="tnt-edit-member-admin"
                checked={isAdmin}
                onCheckedChange={(checked) => setIsAdmin(checked === true)}
                disabled={busy}
              />
              <Label
                htmlFor="tnt-edit-member-admin"
                className="flex cursor-pointer items-center gap-1.5"
              >
                <Shield className="size-[var(--icon-button)] text-violet" aria-hidden />
                Administrator
              </Label>
            </div>
            <p className="ml-8 text-xs text-fg-muted">{ADMIN_HELP_COPY}</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            {busy && <Spinner size="sm" aria-hidden />}
            {busy ? 'Saving…' : 'Save changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Props for {@link RemoveMemberDialog}. */
export interface RemoveMemberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The person being removed; `null` while the dialog is closed. */
  member: TenantMember | null;
  /** The tenant they would lose access to. */
  tenantName: string;
  /**
   * Remove them.
   *
   * @param member The person to remove.
   * @returns The error to show inline, or `null` on success.
   */
  onConfirm: (member: TenantMember) => Promise<string | null>;
}

/**
 * Remove member — a destructive confirm that names the person, in two variants.
 *
 * The admin variant is not a different dialog but the same one carrying a danger banner,
 * because the decision is the same decision with one more consequence. DESIGN.md §8 asks a
 * destructive confirm for the object's name and a consequence sentence; both variants give
 * both, and the title carries the name so the announcement a screen reader makes on open is
 * already specific.
 *
 * @param props See {@link RemoveMemberDialogProps}.
 * @returns The dialog.
 */
export function RemoveMemberDialog({
  open,
  onOpenChange,
  member,
  tenantName,
  onConfirm,
}: RemoveMemberDialogProps) {
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setError('');
    setBusy(false);
  }, [open]);

  const confirm = React.useCallback(async () => {
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

  const isAdmin = Boolean(member?.isAdmin);

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent size="sm" role="alertdialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="tnt-icon-tile" data-tone="danger">
              {isAdmin ? <TriangleAlert aria-hidden /> : <UserMinus aria-hidden />}
            </span>
            Remove {member?.name ?? 'member'}?
          </DialogTitle>
          <DialogDescription>
            They will lose access to {tenantName} immediately. Their projects and versions stay
            in the workspace.
          </DialogDescription>
        </DialogHeader>

        {(isAdmin || error) && (
          <div className="space-y-3 py-4">
            {error && <Alert variant="error">{error}</Alert>}
            {isAdmin && (
              <Alert variant="error">
                <span className="flex items-start gap-2">
                  <ShieldAlert className="mt-0.5 size-[var(--icon-dense)] shrink-0" aria-hidden />
                  <span>
                    <strong className="block">This user is also an administrator</strong>
                    They will lose all administrative privileges in {tenantName}.
                  </span>
                </span>
              </Alert>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void confirm()} disabled={busy}>
            {busy && <Spinner size="sm" aria-hidden />}
            {busy ? 'Removing…' : 'Remove'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
