'use client';

import * as React from 'react';
import {
  Copy,
  Info,
  Lock,
  MousePointerClick,
  PencilLine,
  Save,
  Shield,
  Trash2,
} from 'lucide-react';

import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import { Card, CardContent, CardHeader } from '@/app/components/ui/Card';
import { DataTableBulkAction } from '@/app/components/ui/DataTable';
import { EmptyState } from '@/app/components/ui/EmptyState';
import { Label } from '@/app/components/ui/Label';
import { Skeleton } from '@/app/components/ui/Skeleton';
import { Spinner } from '@/app/components/ui/Spinner';
import { Textarea } from '@/app/components/ui/Textarea';

import PermissionMatrix from './PermissionMatrix';
import { RoleIcon } from './RoleIcon';
import {
  describeDirty,
  describeRoleMeta,
  type RoleDraft,
  type RoleEditability,
} from './rolesModel';
import type { RoleRecord } from '../access/accessApi';

/**
 * The role editor — HIVE-5.3 (#5306).
 *
 * Authority: `docs/mockups/workspace/roles.html`, the `#editor` section and its four
 * alternative states (read-only, built-in, nothing selected, empty tenant).
 *
 * ### What it owns and what it does not
 *
 * The header, the description, the lock note and the save bar. The grid itself is
 * {@link PermissionMatrix}; every decision about *whether* a control is live is
 * {@link ../roles/rolesModel.roleEditability}, computed once by the page and passed in.
 * Nothing here re-derives a gate, which is what keeps the name field, the matrix and the
 * Save button from disagreeing about the same role.
 *
 * ### The save bar
 *
 * Sticky at the foot of the pane, present only while the draft is dirty, with the count of
 * what is pending. The mockup calls it a `.bulk-bar`, which is exactly right: it is the same
 * inverted strip `DataTable` reveals over a selection, saying the same kind of thing — here
 * is something you have started, here is how to finish or abandon it. It is not that
 * component because that component's content is a selection count and a Clear button.
 */

/** Props for {@link RoleEditor}. */
export interface RoleEditorProps {
  /** The role being edited, or `null` when nothing is selected. */
  role: RoleRecord | null;
  /** The edited state. */
  draft: RoleDraft;
  /** What may be done to this role by this viewer. */
  editability: RoleEditability;
  /** How many changes the draft holds; `0` hides the save bar and the Unsaved badge. */
  dirtyCount: number;
  /** A write is in flight, so every control goes inert. */
  busy: boolean;
  /** Draw placeholders instead of the editor. */
  loading?: boolean;
  /** Called as the name is typed. */
  onNameChange: (name: string) => void;
  /** Called as the description is typed. */
  onDescriptionChange: (description: string) => void;
  /** Called when a matrix cell is pressed. */
  onToggleCell: (resource: string, action: string) => void;
  /** Called when a resource row's toggle is pressed. */
  onToggleResource: (resource: string) => void;
  /** Called by "Grant view on all". */
  onGrantActionEverywhere: (action: string) => void;
  /** Called by "Clear all". */
  onClearAll: () => void;
  /** Save the draft. */
  onSave: () => void;
  /** Throw the draft away. */
  onDiscard: () => void;
  /** Open the duplicate dialog. */
  onDuplicate: () => void;
  /** Open the delete confirm. */
  onDelete: () => void;
  /** Open the new-role dialog, from the empty states' action. */
  onCreate: () => void;
  /** Whether creating is offered at all, so the empty states can drop their action. */
  canCreate: boolean;
  /** True when the tenant has no roles at all, which is a different empty state. */
  noRoles: boolean;
}

/**
 * The editor pane.
 *
 * @param props See {@link RoleEditorProps}.
 * @returns The card, or whichever of the four alternative states applies.
 */
export default function RoleEditor({
  role,
  draft,
  editability,
  dirtyCount,
  busy,
  loading = false,
  onNameChange,
  onDescriptionChange,
  onToggleCell,
  onToggleResource,
  onGrantActionEverywhere,
  onClearAll,
  onSave,
  onDiscard,
  onDuplicate,
  onDelete,
  onCreate,
  canCreate,
  noRoles,
}: RoleEditorProps) {
  if (loading) {
    return (
      <div className="flex flex-col gap-4" data-testid="roles-editor-loading">
        <Skeleton className="h-24 w-full rounded-lg" />
        <Skeleton className="h-96 w-full rounded-lg" />
      </div>
    );
  }

  if (!role) {
    const action = canCreate ? (
      <Button onClick={onCreate}>
        <PencilLine aria-hidden />
        New role
      </Button>
    ) : undefined;
    return noRoles ? (
      <EmptyState
        data-testid="roles-empty"
        icon={<Shield aria-hidden />}
        title="No roles defined yet."
        description="Built-in roles are seeded when the first member joins. Create a custom role to hand out narrower access."
        action={action}
      />
    ) : (
      <EmptyState
        data-testid="roles-none-selected"
        icon={<MousePointerClick aria-hidden />}
        title="Select a role to edit its permissions."
        description="Pick a role on the left, or create a new one to start from an empty matrix."
        action={action}
      />
    );
  }

  const dirty = dirtyCount > 0;

  return (
    <section className="flex min-w-0 flex-col gap-4" aria-label={`Role: ${role.name}`}>
      <Card>
        <CardHeader className="flex-row items-start gap-4">
          <span className="tnt-icon-tile" data-tone="accent" aria-hidden>
            <RoleIcon role={role} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              {editability.canRename ? (
                <input
                  className="rol-name-edit"
                  aria-label="Role name"
                  value={draft.name}
                  disabled={busy}
                  onChange={(event) => onNameChange(event.target.value)}
                />
              ) : (
                // A built-in role's name is immutable server-side, so it is text. An input
                // that silently refuses every keystroke is worse than a heading that never
                // invited one.
                <h2 className="rol-name-static">{role.name}</h2>
              )}
              <Badge variant={role.is_builtin ? 'neutral' : 'accent'}>
                {role.is_builtin ? 'Built-in' : 'Custom'}
              </Badge>
              {dirty && (
                <Badge variant="honey" data-testid="roles-dirty-badge">
                  <PencilLine className="size-3" aria-hidden />
                  Unsaved
                </Badge>
              )}
            </div>
            <p className="mono mt-0.5 text-xs text-fg-muted">{describeRoleMeta(role)}</p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {editability.canDuplicate && (
              <Button variant="outline" onClick={onDuplicate} disabled={busy}>
                <Copy aria-hidden />
                Duplicate
              </Button>
            )}
            {editability.canDelete && (
              <Button variant="danger-soft" onClick={onDelete} disabled={busy}>
                <Trash2 aria-hidden />
                Delete
              </Button>
            )}
            {editability.canEditMatrix && (
              <Button data-testid="roles-save" onClick={onSave} disabled={busy || !dirty}>
                {busy ? <Spinner size="sm" aria-hidden /> : <Save aria-hidden />}
                Save changes
              </Button>
            )}
          </div>
        </CardHeader>

        <CardContent className="flex flex-col gap-4">
          {editability.lockReason && (
            <p className="tnt-lock-note" data-testid="roles-lock-note">
              <Lock className="mt-0.5 size-[var(--icon-dense)] shrink-0" aria-hidden />
              <span>{editability.lockReason}</span>
            </p>
          )}

          <div className="space-y-2">
            <Label htmlFor="roleDescription">Description</Label>
            <Textarea
              id="roleDescription"
              rows={2}
              value={draft.description}
              placeholder="Describe what this role can do…"
              disabled={busy || !editability.canEditMatrix}
              onChange={(event) => onDescriptionChange(event.target.value)}
            />
          </div>

          <PermissionMatrix
            grid={draft.grid}
            editable={editability.canEditMatrix && !busy}
            onToggleCell={onToggleCell}
            onToggleResource={onToggleResource}
            onGrantActionEverywhere={onGrantActionEverywhere}
            onClearAll={onClearAll}
          />

          <p className="flex items-start gap-2 text-xs text-fg-muted">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>
              Cells map to a central permission guard (e.g. <code className="mono">version:publish</code>
              ) checked on every REST route, replacing scattered{' '}
              <code className="mono">is_user_tenant_admin</code> checks.
            </span>
          </p>
        </CardContent>
      </Card>

      {dirty && (
        <div className="rol-save-bar" role="status" data-testid="roles-save-bar">
          <span className="rol-save-bar__count">
            <PencilLine aria-hidden />
            {describeDirty(dirtyCount)}
          </span>
          {/* `DataTableBulkAction` rather than a plain `Button`: this strip is inverted, and
              that component is the app's answer for a control on it — a translucent wash of
              the bar's own text colour, which reads on the six dark palettes as well as the
              three light ones. The primary takes the surface as its ground, the mockup's
              own treatment for the one button that must not recede. */}
          <DataTableBulkAction onClick={onDiscard} disabled={busy}>
            Discard
          </DataTableBulkAction>
          <DataTableBulkAction
            className="bg-surface text-fg hover:bg-surface hover:text-fg"
            data-testid="roles-save-bar-save"
            onClick={onSave}
            disabled={busy}
          >
            {busy ? <Spinner size="sm" aria-hidden /> : <Save aria-hidden />}
            Save changes
          </DataTableBulkAction>
        </div>
      )}
    </section>
  );
}
