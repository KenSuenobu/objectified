'use client';

import * as React from 'react';
import { Copy, PencilLine, Save, ShieldPlus, Trash2, TriangleAlert } from 'lucide-react';

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

import type { MemberRecord } from '../members/membersModel';
import type { RoleRecord } from '../access/accessApi';
import {
  TOTAL_CELLS,
  describeDirty,
  describeRoleMemberImpact,
  duplicateRoleName,
  roleMemberImpact,
  validateRoleName,
} from './rolesModel';

/**
 * The four Roles dialogs — HIVE-5.3 (#5306).
 *
 * Authority: `docs/mockups/workspace/roles.html`, the `#new-role-dialog`, `#dup-role-dialog`,
 * `#delete-role-dialog` and `#unsaved-dialog` overlays.
 *
 * ### What these replace
 *
 * New and Duplicate were `useDialog().prompt` — a real dialog, but one whose entire body is a
 * single text field. That was enough for Duplicate and not enough for New, which the mockup
 * gives a second control ("Copy permissions from"): a prompt cannot carry a select, so the
 * only way to start a role from an existing grid was to create it empty, find it, and tick
 * 65 boxes. Delete was `destructiveConfirm`, whose body is a sentence, so the people who
 * hold the role could be counted but not named.
 *
 * The fourth has no predecessor at all. Switching roles with edits in flight silently reset
 * the draft — the reader's work vanished with no dialog, no warning and no undo.
 *
 * ### Why they are all here
 *
 * They are one conversation about one role, they share the busy/error shape below, and each
 * is small enough that a file of its own would be mostly imports — the reasoning
 * {@link ../members/MemberLifecycleDialogs} settled on.
 */

/** What a dialog's primary does: perform the write, or report why it failed. */
type SubmitHandler<T> = (value: T) => Promise<string | null>;

/**
 * The busy/error state every dialog here keeps, plus the run that maintains it.
 *
 * @param options.open Whether the dialog is open, so the state resets when it opens.
 * @param options.onOpenChange Called with `false` once the write succeeds.
 * @returns The inline error, whether a write is running, a setter for a local validation
 *   message, and the runner.
 */
function useDialogAction(options: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { open, onOpenChange } = options;
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  // Reset on open rather than on close: a dialog that clears while it is animating away
  // shows the reader their own text disappearing.
  React.useEffect(() => {
    if (!open) return;
    setError('');
    setBusy(false);
  }, [open]);

  const run = React.useCallback(
    async <T,>(value: T, submit: SubmitHandler<T>) => {
      setBusy(true);
      setError('');
      const failure = await submit(value);
      setBusy(false);
      if (failure) {
        setError(failure);
        return;
      }
      onOpenChange(false);
    },
    [onOpenChange]
  );

  return { error, setError, busy, run };
}

// ---------------------------------------------------------------------------------------
// New role
// ---------------------------------------------------------------------------------------

/** The `value` of the "Copy permissions from" option that starts with nothing. */
const EMPTY_MATRIX = '';

/** The form's id, so the footer's submit answers ↵ in the name field. */
const NEW_ROLE_FORM = 'roles-new-form';

/** Props for {@link NewRoleDialog}. */
export interface NewRoleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Every existing role — the copy-from options, and the duplicate-name check. */
  roles: readonly RoleRecord[];
  /**
   * Create the role.
   *
   * @param input The name, and the role to copy the grid from (empty for none).
   * @returns The error to show inline, or `null` on success.
   */
  onSubmit: SubmitHandler<{ name: string; copyFromId: string }>;
}

/**
 * New role — name, and where its matrix starts from.
 *
 * @param props See {@link NewRoleDialogProps}.
 * @returns The dialog.
 */
export function NewRoleDialog({ open, onOpenChange, roles, onSubmit }: NewRoleDialogProps) {
  const { error, setError, busy, run } = useDialogAction({ open, onOpenChange });
  const [name, setName] = React.useState('');
  const [copyFromId, setCopyFromId] = React.useState(EMPTY_MATRIX);

  React.useEffect(() => {
    if (!open) return;
    setName('');
    setCopyFromId(EMPTY_MATRIX);
  }, [open]);

  const submit = React.useCallback(() => {
    const problem = validateRoleName(name, roles);
    if (problem) {
      setError(problem);
      return;
    }
    void run({ name: name.trim(), copyFromId }, onSubmit);
  }, [copyFromId, name, onSubmit, roles, run, setError]);

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent size="sm" data-testid="roles-new-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="tnt-icon-tile" data-tone="accent">
              <ShieldPlus aria-hidden />
            </span>
            New role
          </DialogTitle>
          <DialogDescription>
            Starts with an empty matrix unless you copy from an existing role.
          </DialogDescription>
        </DialogHeader>

        <form
          id={NEW_ROLE_FORM}
          className="space-y-4 py-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy) submit();
          }}
        >
          {error && <Alert variant="error">{error}</Alert>}

          <div className="space-y-2">
            <Label htmlFor="newRoleName">Name</Label>
            <Input
              id="newRoleName"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Release manager"
              disabled={busy}
              autoFocus
            />
            <p className="text-xs text-fg-muted">
              Shown in member role selects and the access ledger.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="newRoleCopyFrom">Copy permissions from</Label>
            <select
              id="newRoleCopyFrom"
              className="hive-control h-[var(--control-h)] w-full text-sm"
              value={copyFromId}
              disabled={busy}
              onChange={(event) => setCopyFromId(event.target.value)}
            >
              <option value={EMPTY_MATRIX}>Empty matrix (no permissions)</option>
              {roles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.name}
                </option>
              ))}
            </select>
          </div>
        </form>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form={NEW_ROLE_FORM} disabled={busy}>
            {busy && <Spinner size="sm" aria-hidden />}
            {busy ? 'Creating…' : 'Create role'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------
// Duplicate role
// ---------------------------------------------------------------------------------------

/** The form's id, so the footer's submit answers ↵ in the name field. */
const DUPLICATE_ROLE_FORM = 'roles-duplicate-form';

/** Props for {@link DuplicateRoleDialog}. */
export interface DuplicateRoleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The role being copied; `null` while the dialog is closed. */
  role: RoleRecord | null;
  /** Every existing role, for the duplicate-name check. */
  roles: readonly RoleRecord[];
  /**
   * Copy the role.
   *
   * @param name The copy's name.
   * @returns The error to show inline, or `null` on success.
   */
  onSubmit: SubmitHandler<string>;
}

/**
 * Duplicate a role under a new name.
 *
 * @param props See {@link DuplicateRoleDialogProps}.
 * @returns The dialog.
 */
export function DuplicateRoleDialog({
  open,
  onOpenChange,
  role,
  roles,
  onSubmit,
}: DuplicateRoleDialogProps) {
  const { error, setError, busy, run } = useDialogAction({ open, onOpenChange });
  const [name, setName] = React.useState('');

  React.useEffect(() => {
    if (!open || !role) return;
    setName(duplicateRoleName(role));
  }, [open, role]);

  const submit = React.useCallback(() => {
    const problem = validateRoleName(name, roles);
    if (problem) {
      setError(problem);
      return;
    }
    void run(name.trim(), onSubmit);
  }, [name, onSubmit, roles, run, setError]);

  const granted = role?.permissions?.length ?? 0;

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent size="sm" data-testid="roles-duplicate-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="tnt-icon-tile">
              <Copy aria-hidden />
            </span>
            Duplicate “{role?.name ?? 'this role'}”
          </DialogTitle>
          <DialogDescription>
            Copies the description and all {TOTAL_CELLS} matrix cells — {granted} of them
            granted — into a new custom role with no members.
          </DialogDescription>
        </DialogHeader>

        <form
          id={DUPLICATE_ROLE_FORM}
          className="space-y-4 py-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy) submit();
          }}
        >
          {error && <Alert variant="error">{error}</Alert>}
          <div className="space-y-2">
            <Label htmlFor="duplicateRoleName">Name for the duplicated role</Label>
            <Input
              id="duplicateRoleName"
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={busy}
              autoFocus
            />
          </div>
        </form>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form={DUPLICATE_ROLE_FORM} disabled={busy}>
            {busy && <Spinner size="sm" aria-hidden />}
            {busy ? 'Duplicating…' : 'Duplicate'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------
// Delete role
// ---------------------------------------------------------------------------------------

/** Props for {@link DeleteRoleDialog}. */
export interface DeleteRoleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The role being deleted; `null` while the dialog is closed. */
  role: RoleRecord | null;
  /** The tenant's roster, so the confirm can name who holds the role. */
  members: readonly MemberRecord[];
  /**
   * Delete it.
   *
   * @param roleId The role.
   * @returns The error to show inline, or `null` on success.
   */
  onConfirm: SubmitHandler<string>;
}

/**
 * Delete a custom role, naming it and the people it affects.
 *
 * The consequence is the server's actual behaviour: `DELETE /roles/{id}` removes the role and
 * its assignments cascade, so a holder keeps their account and their membership and loses
 * the permissions this grid granted. The mockup says they "fall back to the tenant default
 * role"; no code does that, so this does not claim it.
 *
 * @param props See {@link DeleteRoleDialogProps}.
 * @returns The dialog.
 */
export function DeleteRoleDialog({
  open,
  onOpenChange,
  role,
  members,
  onConfirm,
}: DeleteRoleDialogProps) {
  const { error, busy, run } = useDialogAction({ open, onOpenChange });
  const impact = role ? roleMemberImpact(role, members) : null;

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent size="sm" role="alertdialog" data-testid="roles-delete-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="tnt-icon-tile" data-tone="danger">
              <TriangleAlert aria-hidden />
            </span>
            Delete the role “{role?.name ?? 'this role'}”?
          </DialogTitle>
          <DialogDescription>
            This cannot be undone. The permission grid is removed from the workspace.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-4">
          {error && <Alert variant="error">{error}</Alert>}
          {impact && (
            <p className="tnt-lock-note" data-testid="roles-delete-impact">
              {describeRoleMemberImpact(impact)}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={busy || !role}
            onClick={() => role && void run(role.id, onConfirm)}
          >
            {busy ? <Spinner size="sm" aria-hidden /> : <Trash2 aria-hidden />}
            {busy ? 'Deleting…' : 'Delete role'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------------------
// Unsaved changes
// ---------------------------------------------------------------------------------------

/** Props for {@link UnsavedChangesDialog}. */
export interface UnsavedChangesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The role being edited. */
  role: RoleRecord | null;
  /** Where the reader was going — another role, or `null` for a dialog that replaces it. */
  destination: RoleRecord | null;
  /** How many changes the draft holds. */
  count: number;
  /** Abandon the draft and go. */
  onDiscard: () => void;
  /**
   * Save the draft, then go.
   *
   * @returns The error to show inline, or `null` on success.
   */
  onSave: () => Promise<string | null>;
}

/**
 * The guard that stands between an edited draft and the reader's next click.
 *
 * Three ways out rather than two, because "discard or don't" makes the reader choose between
 * losing work and staying put. Saving is what they almost always meant, so it is the primary
 * and it is offered *here*, where the decision is.
 *
 * @param props See {@link UnsavedChangesDialogProps}.
 * @returns The dialog.
 */
export function UnsavedChangesDialog({
  open,
  onOpenChange,
  role,
  destination,
  count,
  onDiscard,
  onSave,
}: UnsavedChangesDialogProps) {
  const { error, busy, run } = useDialogAction({ open, onOpenChange });

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent size="sm" role="alertdialog" data-testid="roles-unsaved-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="tnt-icon-tile" data-tone="warn">
              <PencilLine aria-hidden />
            </span>
            Discard unsaved changes?
          </DialogTitle>
          <DialogDescription>
            You have {describeDirty(count)} on <strong>{role?.name ?? 'this role'}</strong>.{' '}
            {destination
              ? `Switching to ${destination.name} resets the draft.`
              : 'Leaving this role resets the draft.'}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="py-4">
            <Alert variant="error">{error}</Alert>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Keep editing
          </Button>
          <Button variant="danger-soft" onClick={onDiscard} disabled={busy}>
            Discard
          </Button>
          <Button onClick={() => void run(undefined, onSave)} disabled={busy}>
            {busy ? <Spinner size="sm" aria-hidden /> : <Save aria-hidden />}
            {busy ? 'Saving…' : destination ? 'Save and switch' : 'Save and continue'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
