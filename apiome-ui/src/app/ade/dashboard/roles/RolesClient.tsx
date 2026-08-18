'use client';

import * as React from 'react';
import { Plus, Users } from 'lucide-react';

import type { ShortcutBinding } from '@lib/shortcuts';
import { useShortcuts } from '@/app/hooks/useShortcuts';
import { useUnsavedChangesPrompt } from '@/app/hooks/useUnsavedChangesPrompt';

import { Alert } from '@/app/components/ui/Alert';
import { Button } from '@/app/components/ui/Button';
import PageHeader from '@/app/components/shell/PageHeader';
import { Page, PageBody } from '@/app/components/shell/pageChrome';
import {
  fetchMyPermissions,
  fetchRoles,
  type MyPermissions,
  type RoleRecord,
} from '@/app/components/ade/access/accessApi';
import { fetchMembers } from '@/app/components/ade/members/membersApi';
import type { MemberRecord } from '@/app/components/ade/members/membersModel';
import {
  DeleteRoleDialog,
  DuplicateRoleDialog,
  NewRoleDialog,
  RoleEditor,
  RolesList,
  UnsavedChangesDialog,
  createRole,
  deleteRole,
  diffRole,
  draftFromRole,
  duplicateRole,
  grantActionEverywhere,
  gridToPermissions,
  roleCapabilities,
  roleEditability,
  roleGrid,
  toggleCell,
  toggleResource,
  updateRole,
  type RoleDraft,
} from '@/app/components/ade/roles';

/**
 * Roles — `/ade/dashboard/roles` (HIVE-5.3, #5306).
 *
 * Authority: `docs/mockups/workspace/roles.html`, whose **Notes → Keeps (1:1)** list is this
 * ticket's acceptance criteria; DESIGN.md §5.3 (page header), §7 (dialogs), §8 (the table).
 *
 * ### What this page owns
 *
 * The data, the draft, and which overlay is open. How any of it is drawn belongs to
 * {@link RolesList} and {@link RoleEditor}; what any of it *means* belongs to
 * `rolesModel`, which is pure. What is left here is one load, four writes, and the one thing
 * that is genuinely a page-level decision: whether the reader is allowed to leave the draft.
 *
 * ### The three things this rewrite closes
 *
 * 1. **Switching roles silently destroyed the draft.** The editor's state was synchronised
 *    from the selected role by an effect, so choosing another role in the list threw away
 *    every unticked box with no dialog and no undo. Every move away from a dirty draft now
 *    goes through {@link requestIntent}, which asks first — and offers to save, because
 *    saving is what the reader almost always meant.
 * 2. **New and Duplicate were `window.prompt`-shaped.** They asked through the shared dialog
 *    hook, so they were not literally native, but a prompt's body is one text field: the
 *    mockup's "Copy permissions from" had nowhere to go, and starting a role from an
 *    existing grid meant creating it empty and ticking 65 boxes.
 * 3. **Nothing said what could not be changed, or why.** A built-in role's name field looked
 *    editable and was not; a viewer without `members:*` saw live-looking toggles that did
 *    nothing. Both now state their reason, once, from `roleEditability`.
 *
 * ### Errors are the page's, results are the caller's
 *
 * Every write returns `string | null` to the dialog that asked for it, so a failure is shown
 * *in* the dialog beside the control that caused it, rather than in a banner behind an
 * overlay the reader cannot see past — the shape HIVE-5.2 settled on. The page-level banner
 * is for the load, and for the save that is pressed from the sticky bar rather than a dialog.
 */

/** The breadcrumb's first step. */
const HOME_ROUTE = '/ade/dashboard';

/** Where the members roster lives — the header's secondary. */
const MEMBERS_ROUTE = '/ade/dashboard/members';

/** Which overlay, if any, is open over the page. */
type RoleOverlay = 'none' | 'new' | 'duplicate' | 'delete' | 'unsaved';

/**
 * Something the reader asked for that would abandon the draft.
 *
 * Modelled as an intent rather than handled at each call site, because there are three of
 * them and they must all ask the same question. Choosing another role is the obvious one;
 * creating and duplicating are the two that are easy to miss, because both end by selecting
 * the role they made.
 */
type PendingIntent =
  | { kind: 'select'; role: RoleRecord }
  | { kind: 'new' }
  | { kind: 'duplicate' };

/**
 * The page's own `N`.
 *
 * HIVE-3.7's registry is explicit that a page owning a better `N` registers over the shell's
 * generic one while it is mounted, and that the chip is only printed when the chord is
 * actually bound — so this is registered only when creating is possible.
 */
const NEW_ROLE_SHORTCUT_ID = 'roles-new';

/**
 * The roles page.
 *
 * @returns The page header, the two panes, and the four dialogs.
 */
export default function RolesClient() {
  const [roles, setRoles] = React.useState<RoleRecord[]>([]);
  const [members, setMembers] = React.useState<MemberRecord[]>([]);
  const [perms, setPerms] = React.useState<MyPermissions | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const [overlay, setOverlay] = React.useState<RoleOverlay>('none');
  /** What the reader asked for that the guard is holding back. */
  const [pending, setPending] = React.useState<PendingIntent | null>(null);

  /** The edited state of the selected role. */
  const [draft, setDraft] = React.useState<RoleDraft>(() => draftFromRole(null));

  const selectedRole = React.useMemo(
    () => roles.find((role) => role.id === selectedId) ?? null,
    [roles, selectedId]
  );

  const capabilities = React.useMemo(() => roleCapabilities(perms), [perms]);
  const editability = React.useMemo(
    () => roleEditability(selectedRole, capabilities),
    [capabilities, selectedRole]
  );
  const diff = React.useMemo(() => diffRole(selectedRole, draft), [draft, selectedRole]);
  const dirty = diff.count > 0;

  useUnsavedChangesPrompt(dirty);

  // ---- load -------------------------------------------------------------------------

  /**
   * The selection, readable from inside an async load without depending on it.
   *
   * `loadData` has to know which role was chosen *before* it ran, and it must not be
   * re-created every time that changes — a `useCallback` that depends on the selection would
   * give the mount effect a new identity on every switch and re-read the whole page.
   */
  const selectedIdRef = React.useRef<string | null>(null);
  selectedIdRef.current = selectedId;

  /**
   * Choose a role, and start a fresh draft from it.
   *
   * The two always move together — a selection whose draft still belongs to the previous
   * role is the bug this rewrite exists to close — so they are set in one place rather than
   * synchronised by an effect afterwards. An effect would also be a render late, which is
   * long enough for the matrix to paint the wrong grid.
   *
   * @param role The role to edit, or `null` for none.
   */
  const selectRole = React.useCallback((role: RoleRecord | null) => {
    setSelectedId(role?.id ?? null);
    setDraft(draftFromRole(role));
  }, []);

  /**
   * Read the roles, the viewer's grants and the roster.
   *
   * The roster is best-effort: it exists only so the delete confirm can name the people a
   * role's removal affects, and a screen that refused to load because that read failed
   * would be refusing over a sentence. `member_count` still states the impact without it.
   *
   * The selection survives a reload when the role it names still exists — and so does the
   * draft, which is what makes "save, then reload" leave the reader looking at their own
   * work rather than at a reset form. When the role is gone, as it is after a delete, the
   * pane falls to the first role with a draft to match.
   *
   * @returns The roles that were read, so a caller can select one of them by id.
   */
  const loadData = React.useCallback(async (): Promise<RoleRecord[]> => {
    setLoading(true);
    setError('');
    try {
      const [rolesData, permsData, membersData] = await Promise.all([
        fetchRoles(),
        fetchMyPermissions(),
        fetchMembers().catch(() => [] as MemberRecord[]),
      ]);
      setRoles(rolesData);
      setPerms(permsData);
      setMembers(membersData);
      const previous = selectedIdRef.current;
      if (!previous || !rolesData.some((role) => role.id === previous)) {
        selectRole(rolesData[0] ?? null);
      }
      return rolesData;
    } catch (e) {
      setRoles([]);
      setError(e instanceof Error ? e.message : 'Failed to load roles');
      return [];
    } finally {
      setLoading(false);
    }
  }, [selectRole]);

  React.useEffect(() => {
    void loadData();
  }, [loadData]);

  // ---- the guard --------------------------------------------------------------------

  /**
   * Perform an intent, now that nothing is in its way.
   *
   * @param intent What the reader asked for.
   */
  const runIntent = React.useCallback((intent: PendingIntent) => {
    if (intent.kind === 'select') {
      selectRole(intent.role);
      return;
    }
    setOverlay(intent.kind === 'new' ? 'new' : 'duplicate');
  }, [selectRole]);

  /**
   * Ask for something that would abandon the draft.
   *
   * The one door every such move goes through. A clean draft passes straight out; a dirty
   * one opens the guard, which will either discard, save, or send the reader back.
   *
   * @param intent What the reader asked for.
   */
  const requestIntent = React.useCallback(
    (intent: PendingIntent) => {
      if (!dirty) {
        runIntent(intent);
        return;
      }
      setPending(intent);
      setOverlay('unsaved');
    },
    [dirty, runIntent]
  );

  const newRoleShortcuts = React.useMemo<readonly ShortcutBinding[]>(
    () =>
      capabilities.canCreate
        ? [
            {
              id: NEW_ROLE_SHORTCUT_ID,
              scope: 'list',
              description: 'New role',
              chord: { key: 'n' },
              run: () => requestIntent({ kind: 'new' }),
            },
          ]
        : [],
    [capabilities.canCreate, requestIntent]
  );
  useShortcuts(newRoleShortcuts);

  // ---- draft edits ------------------------------------------------------------------

  const setName = React.useCallback(
    (name: string) => setDraft((previous) => ({ ...previous, name })),
    []
  );
  const setDescription = React.useCallback(
    (description: string) => setDraft((previous) => ({ ...previous, description })),
    []
  );
  const handleToggleCell = React.useCallback(
    (resource: string, action: string) =>
      setDraft((previous) => ({ ...previous, grid: toggleCell(previous.grid, resource, action) })),
    []
  );
  const handleToggleResource = React.useCallback(
    (resource: string) =>
      setDraft((previous) => ({ ...previous, grid: toggleResource(previous.grid, resource) })),
    []
  );
  const handleGrantEverywhere = React.useCallback(
    (action: string) =>
      setDraft((previous) => ({ ...previous, grid: grantActionEverywhere(previous.grid, action) })),
    []
  );
  const handleClearAll = React.useCallback(
    () => setDraft((previous) => ({ ...previous, grid: new Set<string>() })),
    []
  );
  const handleDiscard = React.useCallback(
    () => setDraft(draftFromRole(selectedRole)),
    [selectedRole]
  );

  // ---- writes -----------------------------------------------------------------------

  /**
   * Run one write, then reload.
   *
   * Every mutation on this page has the same shape — go busy, call, reload on success, hand
   * the failure back as a sentence — and stating it once is what keeps the four of them from
   * drifting into four different error behaviours.
   *
   * @param fallback What to say if the failure carried no message.
   * @param write The call; may return the id of a role to select afterwards.
   * @returns `null` on success, or the sentence to show.
   */
  const runWrite = React.useCallback(
    async (fallback: string, write: () => Promise<string | null | void>): Promise<string | null> => {
      setBusy(true);
      try {
        const nextSelection = await write();
        const fresh = await loadData();
        if (typeof nextSelection === 'string') {
          selectRole(fresh.find((role) => role.id === nextSelection) ?? null);
        }
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : fallback;
      } finally {
        setBusy(false);
      }
    },
    [loadData, selectRole]
  );

  /**
   * Save the draft over the selected role.
   *
   * Sent whole rather than as a patch, which is what the endpoint takes: `PUT /roles/{id}`
   * replaces the grid. The name is sent as typed, and ignored by the server for a built-in
   * role — the field that would have changed it is not rendered for one.
   *
   * @returns `null` on success, or the sentence to show.
   */
  const handleSave = React.useCallback(async (): Promise<string | null> => {
    if (!selectedRole) return null;
    const role = selectedRole;
    return runWrite('Failed to save changes', async () => {
      await updateRole(role.id, {
        name: draft.name.trim() || role.name,
        description: draft.description,
        permissions: gridToPermissions(draft.grid),
      });
    });
  }, [draft, runWrite, selectedRole]);

  /** Save from the sticky bar or the header, where there is no dialog to report into. */
  const handleSaveFromPage = React.useCallback(async () => {
    setError('');
    const failure = await handleSave();
    if (failure) setError(failure);
  }, [handleSave]);

  const handleCreate = React.useCallback(
    async (input: { name: string; copyFromId: string }): Promise<string | null> => {
      const source = roles.find((role) => role.id === input.copyFromId) ?? null;
      return runWrite('Failed to create the role', async () => {
        const created = await createRole({
          name: input.name,
          description: '',
          permissions: gridToPermissions(roleGrid(source)),
        });
        return created?.id ?? null;
      });
    },
    [roles, runWrite]
  );

  const handleDuplicate = React.useCallback(
    async (name: string): Promise<string | null> => {
      if (!selectedRole) return null;
      const source = selectedRole;
      return runWrite('Failed to duplicate the role', async () => {
        const clone = await duplicateRole(source.id, name);
        return clone?.id ?? null;
      });
    },
    [runWrite, selectedRole]
  );

  const handleDelete = React.useCallback(
    // No selection to fix up afterwards: the reload's own "keep the selection if it is still
    // there" rule finds the deleted id gone and falls to the first role, which is the state
    // the pane should be in.
    (roleId: string): Promise<string | null> =>
      runWrite('Failed to delete the role', () => deleteRole(roleId)),
    [runWrite]
  );

  /**
   * Save the draft and then do what the reader originally asked for.
   *
   * @returns `null` on success, or the sentence for the guard to show.
   */
  const handleSaveAndContinue = React.useCallback(async (): Promise<string | null> => {
    const failure = await handleSave();
    if (failure) return failure;
    if (pending) runIntent(pending);
    setPending(null);
    return null;
  }, [handleSave, pending, runIntent]);

  /** Throw the draft away and do what the reader asked for. */
  const handleDiscardAndContinue = React.useCallback(() => {
    setOverlay('none');
    if (pending) runIntent(pending);
    setPending(null);
  }, [pending, runIntent]);

  const closeOverlay = React.useCallback(() => {
    setOverlay('none');
    setPending(null);
  }, []);

  /**
   * Dismiss the guard, if it is still the thing on screen.
   *
   * "Save and continue" hands over to the intent the guard was holding *before* the dialog
   * reports its own success — so by the time the dialog asks to close, the overlay may
   * already be the new-role dialog it opened. Closing unconditionally here would shut that
   * one instead, one frame after opening it.
   */
  const dismissGuard = React.useCallback(() => {
    setOverlay((current) => (current === 'unsaved' ? 'none' : current));
    setPending(null);
  }, []);

  const pendingDestination = pending?.kind === 'select' ? pending.role : null;

  return (
    <Page>
      <PageHeader
        breadcrumb={[
          { label: 'Home', href: HOME_ROUTE },
          { label: 'Workspace' },
          { label: 'Roles' },
        ]}
        title="Roles"
        description="Who can view, create, edit, delete and publish — per resource, per role."
        actions={
          <>
            <Button variant="outline" asChild>
              <a href={MEMBERS_ROUTE}>
                <Users aria-hidden />
                Members
              </a>
            </Button>
            {capabilities.canCreate && (
              <Button
                kbd="N"
                data-testid="roles-new"
                onClick={() => requestIntent({ kind: 'new' })}
              >
                <Plus aria-hidden />
                New role
              </Button>
            )}
          </>
        }
      />

      <PageBody>
        {error && (
          <Alert
            variant="error"
            data-testid="roles-error"
            onClose={() => setError('')}
            actions={
              <Button variant="outline" size="sm" onClick={() => void loadData()}>
                Retry
              </Button>
            }
          >
            {error}
          </Alert>
        )}

        <div className="rol-panes">
          <RolesList
            roles={roles}
            selectedId={selectedId}
            onSelect={(role) => requestIntent({ kind: 'select', role })}
            canCreate={capabilities.canCreate}
            onCreate={() => requestIntent({ kind: 'new' })}
            dirtyRoleId={dirty ? selectedId : null}
            loading={loading}
          />

          <RoleEditor
            role={selectedRole}
            draft={draft}
            editability={editability}
            dirtyCount={diff.count}
            busy={busy}
            loading={loading}
            noRoles={roles.length === 0}
            canCreate={capabilities.canCreate}
            onNameChange={setName}
            onDescriptionChange={setDescription}
            onToggleCell={handleToggleCell}
            onToggleResource={handleToggleResource}
            onGrantActionEverywhere={handleGrantEverywhere}
            onClearAll={handleClearAll}
            onSave={() => void handleSaveFromPage()}
            onDiscard={handleDiscard}
            onDuplicate={() => requestIntent({ kind: 'duplicate' })}
            onDelete={() => setOverlay('delete')}
            onCreate={() => requestIntent({ kind: 'new' })}
          />
        </div>
      </PageBody>

      <NewRoleDialog
        open={overlay === 'new'}
        onOpenChange={(open) => !open && closeOverlay()}
        roles={roles}
        onSubmit={handleCreate}
      />

      <DuplicateRoleDialog
        open={overlay === 'duplicate'}
        onOpenChange={(open) => !open && closeOverlay()}
        role={selectedRole}
        roles={roles}
        onSubmit={handleDuplicate}
      />

      <DeleteRoleDialog
        open={overlay === 'delete'}
        onOpenChange={(open) => !open && closeOverlay()}
        role={selectedRole}
        members={members}
        onConfirm={handleDelete}
      />

      <UnsavedChangesDialog
        open={overlay === 'unsaved'}
        onOpenChange={(open) => !open && dismissGuard()}
        role={selectedRole}
        destination={pendingDestination}
        count={diff.count}
        onDiscard={handleDiscardAndContinue}
        onSave={handleSaveAndContinue}
      />
    </Page>
  );
}
