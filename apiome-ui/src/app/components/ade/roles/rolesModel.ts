/**
 * The Roles surface's derivations — HIVE-5.3 (#5306).
 *
 * Authority: `docs/mockups/workspace/roles.html`, whose **Notes → Keeps (1:1)** list is this
 * ticket's acceptance criteria.
 *
 * Everything here is pure and unit-tested, for the reason HIVE-5.2's `membersModel` gives:
 * the questions this screen asks are answered in more than one place. "Is the draft dirty"
 * is asked by the save bar, by the role list's honey dot, by the switch guard and by the
 * unload guard; "may this role be renamed" is asked by the name field, by the editor's lock
 * note and by the save call. Each of those is one sentence here rather than one per surface,
 * so the four cannot drift into four different answers.
 *
 * The permission vocabulary lives here too. It is the third of the four copies
 * `RBAC resource addition` names — apiome-db's `seed_builtin_roles`, apiome-rest's
 * `permissions.py`, this list, and the test that counts it — and it is duplicated because
 * the API does not publish the vocabulary. Adding a resource means editing all four.
 */

import type { MemberRecord } from '../members/membersModel';
import type { MyPermissions, RolePermissionCell, RoleRecord } from '../access/accessApi';

// ---------------------------------------------------------------------------------------
// The permission vocabulary
// ---------------------------------------------------------------------------------------

/** One row of the matrix: a resource the REST guard protects. */
export interface PermissionResource {
  /** The key the guard checks, e.g. `api_keys`. Printed under the label, in mono. */
  key: string;
  /** What the reader sees, in sentence case. */
  label: string;
}

/** One column of the matrix: an action the guard checks a resource against. */
export interface PermissionAction {
  /** The key the guard checks, e.g. `publish`. */
  key: string;
  /** The column heading. */
  label: string;
}

/**
 * The resources the matrix grants against — **must match the REST guard exactly**
 * (`apiome-rest/src/app/permissions.py`, both `class Resource` and the `RESOURCES`
 * frozenset). A key that is not in the guard stores fine and never matches anything.
 */
export const RESOURCES: readonly PermissionResource[] = [
  { key: 'projects', label: 'Projects' },
  { key: 'versions', label: 'Versions' },
  { key: 'classes', label: 'Classes' },
  { key: 'properties', label: 'Properties' },
  { key: 'paths', label: 'Paths' },
  { key: 'types', label: 'Primitives / Types' },
  { key: 'imports', label: 'Imports' },
  { key: 'members', label: 'Members' },
  { key: 'api_keys', label: 'API keys' },
  { key: 'billing', label: 'Billing' },
  { key: 'lint_findings', label: 'Lint findings' },
  { key: 'verification_targets', label: 'Verification targets' },
  { key: 'verification_evidence', label: 'Verification evidence' },
];

/** The five actions, in the order the guard and the mockup both read them. */
export const ACTIONS: readonly PermissionAction[] = [
  { key: 'view', label: 'View' },
  { key: 'create', label: 'Create' },
  { key: 'edit', label: 'Edit' },
  { key: 'delete', label: 'Delete' },
  { key: 'publish', label: 'Publish' },
];

/** How many cells a complete matrix has — 13 resources × 5 actions. */
export const TOTAL_CELLS = RESOURCES.length * ACTIONS.length;

/**
 * The `resource:action` string a cell is keyed and granted by.
 *
 * The same spelling the REST guard uses in its own checks, so a grid can be read out loud
 * against the server's vocabulary without translation.
 *
 * @param resource The resource key.
 * @param action The action key.
 * @returns `resource:action`.
 */
export function cellKey(resource: string, action: string): string {
  return `${resource}:${action}`;
}

/** A draft matrix: the set of {@link cellKey} strings currently granted. */
export type PermissionGrid = ReadonlySet<string>;

// ---------------------------------------------------------------------------------------
// Grid ⇄ role
// ---------------------------------------------------------------------------------------

/**
 * The grid a role currently grants.
 *
 * @param role The role, or `null` for "nothing selected".
 * @returns A new set of `resource:action` keys; empty when the role grants nothing.
 */
export function roleGrid(role: RoleRecord | null | undefined): Set<string> {
  return new Set((role?.permissions ?? []).map((cell) => cellKey(cell.resource, cell.action)));
}

/**
 * The cells to send back, in the vocabulary's own order.
 *
 * Ordered rather than iterated off the set so two saves of the same grid produce the same
 * request body, which is what makes the audit ledger's `granted`/`revoked` diff readable.
 * Keys the vocabulary does not know are dropped: the server would reject the whole request
 * for one of them, and a stale key can only come from a resource this build no longer has.
 *
 * @param grid The draft grid.
 * @returns The cells, resource-major then action-major.
 */
export function gridToPermissions(grid: PermissionGrid): RolePermissionCell[] {
  const cells: RolePermissionCell[] = [];
  for (const resource of RESOURCES) {
    for (const action of ACTIONS) {
      if (grid.has(cellKey(resource.key, action.key))) {
        cells.push({ resource: resource.key, action: action.key });
      }
    }
  }
  return cells;
}

/** The editable state of one role, before it is saved. */
export interface RoleDraft {
  /** The name as typed. */
  name: string;
  /** The description as typed; never `null`, so the textarea stays controlled. */
  description: string;
  /** The granted cells. */
  grid: PermissionGrid;
}

/**
 * The draft a freshly selected role starts from.
 *
 * @param role The role, or `null`.
 * @returns Its name, description and grid, ready to edit.
 */
export function draftFromRole(role: RoleRecord | null | undefined): RoleDraft {
  return {
    name: role?.name ?? '',
    description: role?.description ?? '',
    grid: roleGrid(role),
  };
}

// ---------------------------------------------------------------------------------------
// Dirt
// ---------------------------------------------------------------------------------------

/** What a draft has changed about its role. */
export interface RoleDiff {
  /** Cells turned on, as `resource:action`, sorted. */
  granted: string[];
  /** Cells turned off, sorted. */
  revoked: string[];
  /** Whether the name was edited. */
  renamed: boolean;
  /** Whether the description was edited. */
  redescribed: boolean;
  /** Everything above, counted — what the save bar and the switch guard say. */
  count: number;
}

/** A draft that changed nothing, so callers can compare against a constant. */
const CLEAN: RoleDiff = { granted: [], revoked: [], renamed: false, redescribed: false, count: 0 };

/**
 * What a draft would change about its role.
 *
 * Counted as cells plus the two text fields, because that is what "3 unsaved changes" has to
 * mean for the number to be checkable by the reader: they can point at three things.
 *
 * @param role The saved role, or `null`.
 * @param draft The edited state.
 * @returns The diff; {@link RoleDiff.count} of `0` means clean.
 */
export function diffRole(role: RoleRecord | null | undefined, draft: RoleDraft): RoleDiff {
  if (!role) return CLEAN;
  const saved = roleGrid(role);
  const granted = [...draft.grid].filter((key) => !saved.has(key)).sort();
  const revoked = [...saved].filter((key) => !draft.grid.has(key)).sort();
  const renamed = draft.name.trim() !== role.name;
  const redescribed = draft.description.trim() !== (role.description ?? '').trim();
  return {
    granted,
    revoked,
    renamed,
    redescribed,
    count: granted.length + revoked.length + (renamed ? 1 : 0) + (redescribed ? 1 : 0),
  };
}

/**
 * The save bar's sentence.
 *
 * @param count How many changes are pending.
 * @returns e.g. `"3 unsaved changes"`.
 */
export function describeDirty(count: number): string {
  return `${count} unsaved ${count === 1 ? 'change' : 'changes'}`;
}

/**
 * The matrix header's count.
 *
 * @param grid The draft grid.
 * @returns e.g. `"23 of 65 cells on"`.
 */
export function describeCellsOn(grid: PermissionGrid): string {
  return `${grid.size} of ${TOTAL_CELLS} cells on`;
}

// ---------------------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------------------

/** What the viewer may do on this screen at all. */
export interface RoleCapabilities {
  /** Edit a role's description or matrix, and save it. */
  canMutate: boolean;
  /** Create a role, and duplicate one. */
  canCreate: boolean;
  /** Delete a custom role. */
  canDelete: boolean;
}

/** The gates of a viewer with no grants, so `null` permissions cannot read as permission. */
const NO_CAPABILITIES: RoleCapabilities = { canMutate: false, canCreate: false, canDelete: false };

/**
 * What the viewer may do, from their own effective permissions.
 *
 * Roles are administered through the `members` resource — that is the guard apiome-rest
 * checks (`enforce_permission(..., Resource.MEMBERS, ...)` on every route in this file), so
 * the screen must gate on the same thing rather than on a `roles:*` grant that does not
 * exist. `canMutate` accepts any of the three because the update route asks only for
 * `members:edit`, and a viewer holding `create` or `delete` alone can already reshape the
 * role set; refusing them the editor would hide what they can do, not prevent it.
 *
 * @param perms The `permissions/me` payload, or `null` while it is loading or failed.
 * @returns The three gates.
 */
export function roleCapabilities(perms: MyPermissions | null | undefined): RoleCapabilities {
  if (!perms) return NO_CAPABILITIES;
  const has = (permission: string) => perms.is_admin || perms.permissions.includes(permission);
  const canCreate = has('members:create');
  const canDelete = has('members:delete');
  return {
    canMutate: has('members:edit') || canCreate || canDelete,
    canCreate,
    canDelete,
  };
}

/** Why the whole editor is inert, when it is. */
export const READ_ONLY_REASON =
  'You need members:edit, members:create or members:delete to change roles. You can still browse the matrix.';

/** Why a built-in role's name cannot be edited. */
export const BUILTIN_NAME_REASON =
  'Built-in roles keep their name — seat licensing and identity-provider group mapping refer to it.';

/** Why a built-in role has no Delete. */
export const BUILTIN_DELETE_REASON =
  'Built-in roles cannot be deleted. Duplicate one to start a custom role you can change freely.';

/** What may be done to the selected role. */
export interface RoleEditability {
  /** The name field is live. */
  canRename: boolean;
  /** The description and the matrix are live. */
  canEditMatrix: boolean;
  /** Delete is offered. */
  canDelete: boolean;
  /** Duplicate is offered. */
  canDuplicate: boolean;
  /**
   * Why part of this role is locked, or `null` when nothing is.
   *
   * One sentence rather than a flag per lock: the editor prints it once, under the header,
   * and a reader who cannot rename a built-in role does not need to be told twice.
   */
  lockReason: string | null;
}

/** Nothing selected: everything closed, nothing to explain. */
const NOTHING_EDITABLE: RoleEditability = {
  canRename: false,
  canEditMatrix: false,
  canDelete: false,
  canDuplicate: false,
  lockReason: null,
};

/**
 * What may be done to one role by one viewer.
 *
 * The built-in rule is the server's rule, not a stricter one invented here: apiome-rest
 * refuses to rename a built-in role (`update_role` keeps `existing["name"]`) and refuses to
 * delete one (400), but it does let an administrator tune a built-in **grid** — which is a
 * real capability the redesign must not quietly remove. So a built-in role locks its name
 * and its Delete, states why, and leaves the description and matrix as editable as the
 * viewer's own grants allow.
 *
 * @param role The selected role, or `null`.
 * @param capabilities The viewer's gates, from {@link roleCapabilities}.
 * @returns Which affordances are live, and the reason any are not.
 */
export function roleEditability(
  role: RoleRecord | null | undefined,
  capabilities: RoleCapabilities
): RoleEditability {
  if (!role) return NOTHING_EDITABLE;
  if (!capabilities.canMutate) {
    return {
      canRename: false,
      canEditMatrix: false,
      canDelete: false,
      canDuplicate: false,
      lockReason: READ_ONLY_REASON,
    };
  }
  if (role.is_builtin) {
    return {
      canRename: false,
      canEditMatrix: true,
      canDelete: false,
      canDuplicate: capabilities.canCreate,
      lockReason: BUILTIN_NAME_REASON,
    };
  }
  return {
    canRename: true,
    canEditMatrix: true,
    canDelete: capabilities.canDelete,
    canDuplicate: capabilities.canCreate,
    lockReason: null,
  };
}

// ---------------------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------------------

/** The roles list, split the way the mockup groups it. */
export interface RoleGroups {
  /** Seeded roles — Owner, Admin, Editor, Viewer. */
  builtin: RoleRecord[];
  /** Roles this workspace wrote. */
  custom: RoleRecord[];
}

/**
 * Split the roles into the list's two groups, keeping the API's order within each.
 *
 * The API already orders built-in first and by seniority within that, so this preserves
 * rather than re-sorts — re-sorting here would put Admin above Owner alphabetically.
 *
 * @param roles Every role.
 * @returns The two groups.
 */
export function partitionRoles(roles: readonly RoleRecord[]): RoleGroups {
  return {
    builtin: roles.filter((role) => role.is_builtin),
    custom: roles.filter((role) => !role.is_builtin),
  };
}

/**
 * Narrow the list by the filter box.
 *
 * Matches the name, the slug and the description, because a reader looking for "the one that
 * can publish" is as likely to have written that in the description as in the name.
 *
 * @param roles Every role.
 * @param query What was typed; blank returns everything.
 * @returns The matching roles, in their original order.
 */
export function filterRoles(roles: readonly RoleRecord[], query: string): RoleRecord[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...roles];
  return roles.filter((role) =>
    [role.name, role.slug, role.description ?? ''].some((field) =>
      field.toLowerCase().includes(needle)
    )
  );
}

/**
 * The quiet line under a role's name in the editor header.
 *
 * @param role The role.
 * @returns e.g. `"release-manager · 2 members"`.
 */
export function describeRoleMeta(role: RoleRecord): string {
  const count = role.member_count ?? 0;
  return `${role.slug} · ${count} ${count === 1 ? 'member' : 'members'}`;
}

// ---------------------------------------------------------------------------------------
// Editing the grid
// ---------------------------------------------------------------------------------------

/**
 * A resource row's tri-state, which is what `aria-pressed` on its row toggle reports.
 *
 * `'mixed'` is the state the mockup's `.perm` stylesheet defines and its markup never
 * reaches, because a single cell cannot be partly granted. A *row* can, and this is where
 * a 13 × 5 grid is actually filled in — "everything on Projects" is one press rather than
 * five.
 *
 * @param grid The draft grid.
 * @param resource The resource key.
 * @returns `true` when every action is granted, `false` when none is, `'mixed'` between.
 */
export function resourceState(grid: PermissionGrid, resource: string): boolean | 'mixed' {
  const on = ACTIONS.filter((action) => grid.has(cellKey(resource, action.key))).length;
  if (on === 0) return false;
  return on === ACTIONS.length ? true : 'mixed';
}

/**
 * Turn one cell on or off.
 *
 * @param grid The draft grid.
 * @param resource The resource key.
 * @param action The action key.
 * @returns A new grid.
 */
export function toggleCell(grid: PermissionGrid, resource: string, action: string): Set<string> {
  const next = new Set(grid);
  const key = cellKey(resource, action);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/**
 * Grant or revoke a whole resource row.
 *
 * A partly-granted row fills rather than empties: the reader pressed a control that reads
 * "some" and the useful next state is "all". Emptying is then one more press.
 *
 * @param grid The draft grid.
 * @param resource The resource key.
 * @returns A new grid.
 */
export function toggleResource(grid: PermissionGrid, resource: string): Set<string> {
  const next = new Set(grid);
  const fill = resourceState(grid, resource) !== true;
  for (const action of ACTIONS) {
    const key = cellKey(resource, action.key);
    if (fill) next.add(key);
    else next.delete(key);
  }
  return next;
}

/**
 * Grant one action on every resource — the mockup's "Grant view on all".
 *
 * @param grid The draft grid.
 * @param action The action key.
 * @returns A new grid.
 */
export function grantActionEverywhere(grid: PermissionGrid, action: string): Set<string> {
  const next = new Set(grid);
  for (const resource of RESOURCES) next.add(cellKey(resource.key, action));
  return next;
}

// ---------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------

/**
 * The name a duplicate starts with.
 *
 * @param role The role being copied.
 * @returns e.g. `"Release manager (copy)"`.
 */
export function duplicateRoleName(role: RoleRecord): string {
  return `${role.name} (copy)`;
}

/**
 * Why a typed role name cannot be used, or `null` when it can.
 *
 * The duplicate check is done here as well as by the server, which answers a 409, because
 * the reader can see the clashing name in the list beside the dialog — telling them after a
 * round trip is telling them something they could have been told as they typed.
 *
 * @param name The typed name.
 * @param roles Every existing role.
 * @param exceptId A role whose own name does not count as a clash (the one being renamed).
 * @returns The problem, or `null`.
 */
export function validateRoleName(
  name: string,
  roles: readonly RoleRecord[],
  exceptId?: string
): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'A role needs a name.';
  const clash = roles.some(
    (role) => role.id !== exceptId && role.name.trim().toLowerCase() === trimmed.toLowerCase()
  );
  return clash ? `A role named "${trimmed}" already exists.` : null;
}

/** How many members a delete dialog names before it counts the rest. */
export const IMPACT_NAME_LIMIT = 4;

/** Who a role's deletion would affect. */
export interface RoleMemberImpact {
  /** How many members hold the role. */
  count: number;
  /** Up to {@link IMPACT_NAME_LIMIT} of them, by display name. */
  names: string[];
  /** How many more hold it beyond those named. */
  more: number;
}

/**
 * Who holds the role, so a delete confirm can say whose access it changes.
 *
 * Read off the roster the page already fetched rather than from `member_count` alone: a
 * count is a number, and "Linus Torvalds and Margaret Hamilton lose these permissions" is
 * the sentence that makes the decision. Falls back to the count when the roster could not
 * be read, so the dialog still states the impact.
 *
 * @param role The role about to be deleted.
 * @param members The tenant's roster; empty when it was not read.
 * @returns The count and up to four names.
 */
export function roleMemberImpact(
  role: RoleRecord,
  members: readonly MemberRecord[]
): RoleMemberImpact {
  const holders = members.filter((member) => member.role_id === role.id);
  const count = holders.length > 0 ? holders.length : (role.member_count ?? 0);
  const names = holders
    .slice(0, IMPACT_NAME_LIMIT)
    .map((member) => member.name?.trim() || member.email);
  return { count, names, more: Math.max(0, count - names.length) };
}

/**
 * What deleting the role does to the people who hold it.
 *
 * States what apiome-rest actually does — the role row is deleted and its assignments
 * cascade, so a holder keeps their account and their membership and loses exactly the
 * permissions this grid granted. It deliberately does **not** repeat the mockup's "fall back
 * to the default role", which no code performs.
 *
 * @param impact From {@link roleMemberImpact}.
 * @returns The consequence sentence.
 */
export function describeRoleMemberImpact(impact: RoleMemberImpact): string {
  if (impact.count === 0) return 'No member currently holds it.';
  const who =
    impact.names.length === 0
      ? `${impact.count} ${impact.count === 1 ? 'member' : 'members'}`
      : [...impact.names, ...(impact.more > 0 ? [`${impact.more} more`] : [])].join(', ');
  const consequence =
    impact.count === 1
      ? 'keeps their account but loses every permission this role granted.'
      : 'keep their accounts but lose every permission this role granted.';
  return `${who} ${consequence}`;
}
