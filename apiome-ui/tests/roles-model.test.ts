/**
 * The Roles redesign's decisions (HIVE-5.3, #5306).
 *
 * `roles-hive-redesign.test.tsx` renders the screen; this pins the sentences it renders, one
 * layer down, where they can be exercised at every value rather than at the two or three a
 * fixture happens to have. The four that matter most are the ones the ticket's acceptance
 * criteria turn on:
 *
 *   1. **The permission vocabulary is the guard's.** 13 resources × 5 actions = 65 cells,
 *      spelled `resource:action` exactly as `apiome-rest/src/app/permissions.py` checks them.
 *   2. **Built-in roles cannot be renamed or deleted, and the reason is stated** — and the
 *      lock is exactly the server's, so an administrator can still tune a built-in *grid*.
 *   3. **A dirty draft is dirty for a countable reason**, because the save bar shows the
 *      count and the guard repeats it.
 *   4. **Delete states the member impact**, in the words of what the server actually does.
 */

import {
  ACTIONS,
  BUILTIN_NAME_REASON,
  IMPACT_NAME_LIMIT,
  READ_ONLY_REASON,
  RESOURCES,
  TOTAL_CELLS,
  cellKey,
  describeCellsOn,
  describeDirty,
  describeRoleMemberImpact,
  describeRoleMeta,
  diffRole,
  draftFromRole,
  duplicateRoleName,
  filterRoles,
  grantActionEverywhere,
  gridToPermissions,
  partitionRoles,
  resourceState,
  roleCapabilities,
  roleEditability,
  roleGrid,
  roleMemberImpact,
  toggleCell,
  toggleResource,
  validateRoleName,
} from '../src/app/components/ade/roles/rolesModel';
import type { MemberRecord } from '../src/app/components/ade/members/membersModel';
import type { RoleRecord } from '../src/app/components/ade/access/accessApi';

// ---------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------

/**
 * Build a role.
 *
 * @param overrides What differs from a plain custom role granting nothing.
 * @returns The role.
 */
function role(overrides: Partial<RoleRecord> = {}): RoleRecord {
  return {
    id: 'role-rm',
    slug: 'release-manager',
    name: 'Release manager',
    description: 'Cuts and publishes versions.',
    is_builtin: false,
    member_count: 2,
    permissions: [
      { resource: 'versions', action: 'view' },
      { resource: 'versions', action: 'publish' },
    ],
    ...overrides,
  };
}

/**
 * Build a member.
 *
 * @param overrides What differs from an active member of the release-manager role.
 * @returns The member.
 */
function member(overrides: Partial<MemberRecord> = {}): MemberRecord {
  return {
    user_id: 'u-linus',
    name: 'Linus Torvalds',
    email: 'linus@acme.io',
    status: 'active',
    member_since: '2026-01-01T12:00:00Z',
    role_id: 'role-rm',
    role_name: 'Release manager',
    role_slug: 'release-manager',
    is_admin: false,
    ...overrides,
  } as MemberRecord;
}

const ADMIN = { is_admin: true, permissions: [] as string[] };
const VIEWER = { is_admin: false, permissions: ['members:view'] };

// ---------------------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------------------

describe('the permission vocabulary', () => {
  it('is the thirteen resources and five actions the REST guard checks', () => {
    expect(RESOURCES.map((resource) => resource.key)).toEqual([
      'projects',
      'versions',
      'classes',
      'properties',
      'paths',
      'types',
      'imports',
      'members',
      'api_keys',
      'billing',
      'lint_findings',
      'verification_targets',
      'verification_evidence',
    ]);
    expect(ACTIONS.map((action) => action.key)).toEqual([
      'view',
      'create',
      'edit',
      'delete',
      'publish',
    ]);
    expect(TOTAL_CELLS).toBe(65);
  });

  it('spells a cell the way the guard does', () => {
    expect(cellKey('verification_evidence', 'publish')).toBe('verification_evidence:publish');
  });

  it('gives every resource a label and every action a heading', () => {
    for (const resource of RESOURCES) expect(resource.label).not.toHaveLength(0);
    for (const action of ACTIONS) expect(action.label).not.toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------
// Grid ⇄ role
// ---------------------------------------------------------------------------------------

describe('reading and writing a grid', () => {
  it('reads a role into a set of cell keys', () => {
    expect([...roleGrid(role())].sort()).toEqual(['versions:publish', 'versions:view']);
  });

  it('treats a role with no permissions field as granting nothing', () => {
    expect(roleGrid({ ...role(), permissions: undefined }).size).toBe(0);
    expect(roleGrid(null).size).toBe(0);
  });

  it('writes the cells back in the vocabulary order, not the set order', () => {
    const grid = new Set(['versions:publish', 'projects:view', 'versions:view']);
    expect(gridToPermissions(grid)).toEqual([
      { resource: 'projects', action: 'view' },
      { resource: 'versions', action: 'view' },
      { resource: 'versions', action: 'publish' },
    ]);
  });

  it('drops a key the vocabulary does not know rather than letting the server refuse it', () => {
    // A stale key can only come from a resource this build no longer has; sending it would
    // make the server reject the *whole* grid.
    expect(gridToPermissions(new Set(['ghosts:view', 'projects:view']))).toEqual([
      { resource: 'projects', action: 'view' },
    ]);
  });

  it('starts a draft from the role, with the description never null', () => {
    expect(draftFromRole(role({ description: null }))).toEqual({
      name: 'Release manager',
      description: '',
      grid: new Set(['versions:view', 'versions:publish']),
    });
  });
});

// ---------------------------------------------------------------------------------------
// Dirt
// ---------------------------------------------------------------------------------------

describe('what makes a draft dirty', () => {
  it('is clean when nothing was touched', () => {
    expect(diffRole(role(), draftFromRole(role())).count).toBe(0);
  });

  it('counts a granted cell, a revoked cell, the name and the description', () => {
    const diff = diffRole(role(), {
      name: 'Release captain',
      description: 'Different.',
      grid: new Set(['versions:view', 'projects:view']),
    });
    expect(diff.granted).toEqual(['projects:view']);
    expect(diff.revoked).toEqual(['versions:publish']);
    expect(diff.renamed).toBe(true);
    expect(diff.redescribed).toBe(true);
    expect(diff.count).toBe(4);
  });

  it('does not call trailing whitespace a change', () => {
    const diff = diffRole(role(), {
      name: '  Release manager  ',
      description: '  Cuts and publishes versions.  ',
      grid: roleGrid(role()),
    });
    expect(diff.count).toBe(0);
  });

  it('is clean when there is no role to compare against', () => {
    expect(diffRole(null, { name: 'x', description: 'y', grid: new Set(['projects:view']) }).count).toBe(
      0
    );
  });

  it('says how many changes there are, singular and plural', () => {
    expect(describeDirty(1)).toBe('1 unsaved change');
    expect(describeDirty(3)).toBe('3 unsaved changes');
  });

  it('counts the cells that are on against the whole matrix', () => {
    expect(describeCellsOn(new Set(['projects:view']))).toBe('1 of 65 cells on');
  });
});

// ---------------------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------------------

describe('what the viewer may do', () => {
  it('gives an administrator everything', () => {
    expect(roleCapabilities(ADMIN)).toEqual({ canMutate: true, canCreate: true, canDelete: true });
  });

  it('gives a viewer with only members:view nothing', () => {
    expect(roleCapabilities(VIEWER)).toEqual({
      canMutate: false,
      canCreate: false,
      canDelete: false,
    });
  });

  it('treats create or delete alone as enough to edit, because the server does', () => {
    expect(roleCapabilities({ is_admin: false, permissions: ['members:create'] })).toEqual({
      canMutate: true,
      canCreate: true,
      canDelete: false,
    });
    expect(roleCapabilities({ is_admin: false, permissions: ['members:delete'] })).toEqual({
      canMutate: true,
      canCreate: false,
      canDelete: true,
    });
  });

  it('reads missing permissions as no permission, not as permission', () => {
    expect(roleCapabilities(null).canMutate).toBe(false);
    expect(roleCapabilities(undefined).canCreate).toBe(false);
  });
});

describe('what may be done to a role', () => {
  const admin = roleCapabilities(ADMIN);

  it('lets an administrator rename, delete and duplicate a custom role', () => {
    expect(roleEditability(role(), admin)).toEqual({
      canRename: true,
      canEditMatrix: true,
      canDelete: true,
      canDuplicate: true,
      lockReason: null,
    });
  });

  it('locks a built-in role’s name and Delete, and says why', () => {
    const editability = roleEditability(role({ is_builtin: true, slug: 'admin' }), admin);
    expect(editability.canRename).toBe(false);
    expect(editability.canDelete).toBe(false);
    expect(editability.lockReason).toBe(BUILTIN_NAME_REASON);
  });

  it('still lets an administrator tune a built-in grid, which the server allows', () => {
    // The server keeps `existing["name"]` on a built-in update but replaces its permissions,
    // so locking the matrix here would remove a capability that exists rather than reflect
    // one that does not.
    expect(roleEditability(role({ is_builtin: true }), admin).canEditMatrix).toBe(true);
  });

  it('closes everything for a viewer, and says what grant would open it', () => {
    const editability = roleEditability(role(), roleCapabilities(VIEWER));
    expect(editability).toEqual({
      canRename: false,
      canEditMatrix: false,
      canDelete: false,
      canDuplicate: false,
      lockReason: READ_ONLY_REASON,
    });
    expect(READ_ONLY_REASON).toContain('members:edit');
  });

  it('withholds Delete from someone who may edit but not delete', () => {
    const editability = roleEditability(
      role(),
      roleCapabilities({ is_admin: false, permissions: ['members:edit'] })
    );
    expect(editability.canEditMatrix).toBe(true);
    expect(editability.canDelete).toBe(false);
    expect(editability.canDuplicate).toBe(false);
  });

  it('offers nothing when no role is selected', () => {
    expect(roleEditability(null, admin).lockReason).toBeNull();
    expect(roleEditability(null, admin).canEditMatrix).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------------------

describe('the list', () => {
  const roles = [
    role({ id: 'r-owner', slug: 'owner', name: 'Owner', is_builtin: true }),
    role({ id: 'r-admin', slug: 'admin', name: 'Admin', is_builtin: true }),
    role({ id: 'r-rm', slug: 'release-manager', name: 'Release manager' }),
  ];

  it('splits built-in from custom without re-sorting either', () => {
    const { builtin, custom } = partitionRoles(roles);
    expect(builtin.map((entry) => entry.name)).toEqual(['Owner', 'Admin']);
    expect(custom.map((entry) => entry.name)).toEqual(['Release manager']);
  });

  it('filters on the name, the slug and the description', () => {
    expect(filterRoles(roles, 'release').map((entry) => entry.id)).toEqual(['r-rm']);
    expect(filterRoles(roles, 'RELEASE-MANAGER').map((entry) => entry.id)).toEqual(['r-rm']);
    expect(filterRoles(roles, 'publishes').map((entry) => entry.id)).toEqual([
      'r-owner',
      'r-admin',
      'r-rm',
    ]);
    expect(filterRoles(roles, '   ')).toHaveLength(3);
    expect(filterRoles(roles, 'nothing')).toHaveLength(0);
  });

  it('describes a role by its slug and its member count', () => {
    expect(describeRoleMeta(role())).toBe('release-manager · 2 members');
    expect(describeRoleMeta(role({ member_count: 1 }))).toBe('release-manager · 1 member');
    expect(describeRoleMeta(role({ member_count: undefined }))).toBe('release-manager · 0 members');
  });
});

// ---------------------------------------------------------------------------------------
// Editing the grid
// ---------------------------------------------------------------------------------------

describe('editing the grid', () => {
  it('reports a row as off, mixed or on', () => {
    expect(resourceState(new Set(), 'projects')).toBe(false);
    expect(resourceState(new Set(['projects:view']), 'projects')).toBe('mixed');
    expect(
      resourceState(
        new Set(ACTIONS.map((action) => cellKey('projects', action.key))),
        'projects'
      )
    ).toBe(true);
  });

  it('turns one cell on and off without touching its neighbours', () => {
    const first = toggleCell(new Set(['versions:view']), 'projects', 'edit');
    expect([...first].sort()).toEqual(['projects:edit', 'versions:view']);
    expect([...toggleCell(first, 'projects', 'edit')]).toEqual(['versions:view']);
  });

  it('fills a partly granted row rather than emptying it', () => {
    const partly = toggleResource(new Set(['projects:view']), 'projects');
    expect(partly.size).toBe(ACTIONS.length);
    // A second press, now that it is full, clears it.
    expect(toggleResource(partly, 'projects').size).toBe(0);
  });

  it('leaves other resources alone when a row is filled', () => {
    const grid = toggleResource(new Set(['versions:view']), 'projects');
    expect(grid.has('versions:view')).toBe(true);
    expect(grid.size).toBe(ACTIONS.length + 1);
  });

  it('grants one action on every resource', () => {
    const grid = grantActionEverywhere(new Set(), 'view');
    expect(grid.size).toBe(RESOURCES.length);
    expect(grid.has('billing:view')).toBe(true);
    expect(grid.has('billing:edit')).toBe(false);
  });

  it('never mutates the grid it was given', () => {
    const original = new Set(['projects:view']);
    toggleCell(original, 'projects', 'edit');
    toggleResource(original, 'projects');
    grantActionEverywhere(original, 'view');
    expect([...original]).toEqual(['projects:view']);
  });
});

// ---------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------

describe('naming a new role', () => {
  const roles = [role(), role({ id: 'r-a', slug: 'auditor', name: 'Auditor' })];

  it('suggests a copy name', () => {
    expect(duplicateRoleName(role())).toBe('Release manager (copy)');
  });

  it('refuses a blank name', () => {
    expect(validateRoleName('   ', roles)).toBe('A role needs a name.');
  });

  it('refuses a name another role already has, whatever its casing', () => {
    expect(validateRoleName('auditor', roles)).toBe('A role named "auditor" already exists.');
  });

  it('does not call a role’s own name a clash when it is being renamed', () => {
    expect(validateRoleName('Auditor', roles, 'r-a')).toBeNull();
  });

  it('accepts a free name', () => {
    expect(validateRoleName('Release captain', roles)).toBeNull();
  });
});

describe('who a delete affects', () => {
  const holders = [
    member(),
    member({ user_id: 'u-margaret', name: 'Margaret Hamilton', email: 'margaret@acme.io' }),
    member({ user_id: 'u-other', role_id: 'role-other', name: 'Ada Lovelace' }),
  ];

  it('names the members who hold the role, and only them', () => {
    const impact = roleMemberImpact(role(), holders);
    expect(impact.count).toBe(2);
    expect(impact.names).toEqual(['Linus Torvalds', 'Margaret Hamilton']);
    expect(impact.more).toBe(0);
  });

  it('falls back to the address when a member has no display name', () => {
    expect(roleMemberImpact(role(), [member({ name: '' })]).names).toEqual(['linus@acme.io']);
  });

  it('names four and counts the rest', () => {
    const many = Array.from({ length: 7 }, (_, index) =>
      member({ user_id: `u-${index}`, name: `Person ${index}` })
    );
    const impact = roleMemberImpact(role(), many);
    expect(impact.names).toHaveLength(IMPACT_NAME_LIMIT);
    expect(impact.more).toBe(3);
  });

  it('falls back to the server’s count when the roster could not be read', () => {
    const impact = roleMemberImpact(role({ member_count: 5 }), []);
    expect(impact).toEqual({ count: 5, names: [], more: 5 });
  });

  it('states what actually happens, not the mockup’s default-role fiction', () => {
    const sentence = describeRoleMemberImpact(roleMemberImpact(role(), holders));
    expect(sentence).toBe(
      'Linus Torvalds, Margaret Hamilton keep their accounts but lose every permission this role granted.'
    );
    expect(sentence).not.toContain('default role');
  });

  it('says so when nobody holds it', () => {
    expect(describeRoleMemberImpact(roleMemberImpact(role({ member_count: 0 }), []))).toBe(
      'No member currently holds it.'
    );
  });

  it('uses the singular for one holder', () => {
    expect(describeRoleMemberImpact({ count: 1, names: ['Linus Torvalds'], more: 0 })).toBe(
      'Linus Torvalds keeps their account but loses every permission this role granted.'
    );
  });

  it('counts without naming when only the count is known', () => {
    expect(describeRoleMemberImpact({ count: 3, names: [], more: 3 })).toBe(
      '3 members keep their accounts but lose every permission this role granted.'
    );
  });
});
