/**
 * Tenants list + manage-drawer logic — HIVE-5.1 (#5304).
 *
 * The module under test exists so that per-tenant derivations take the tenant as an
 * argument instead of reading ambient state — the shape of the bug this ticket closes. The
 * isolation cases below are therefore the point of the file, not an afterthought: two
 * tenants filtered at once, and neither seeing the other's filter.
 */

import {
  buildTenantRows,
  describeTenantEdit,
  filterTenantMembers,
  isTenantAdmin,
  matchesTenantFacet,
  mergeTenantMembers,
  searchTenantRows,
  sortTenantMembers,
  sortTenantRows,
  suggestTenantSlug,
  summariseTenantMembers,
  summariseTenantRows,
  tenantFacetCounts,
  tenantMembersFor,
  tenantRoleLabel,
  tenantSectionLockNote,
  tenantSectionNeedsCurrent,
  tenantStatus,
  tenantStatusLabel,
  validateTenantEdit,
  TENANT_MANAGE_SECTIONS,
  TENANT_SLUG_PATTERN,
  type TenantAdminRecord,
  type TenantRecord,
  type TenantUserRecord,
} from '../src/app/components/ade/tenants/tenantsModel';

/** A tenant record with the fields the list actually reads. */
function tenant(overrides: Partial<TenantRecord> & { id: string; name: string }): TenantRecord {
  return {
    description: '',
    slug: overrides.name.toLowerCase().replace(/\s+/g, '-'),
    enabled: true,
    deleted_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function userRow(
  tenantId: string,
  userId: string,
  name: string,
  email = `${userId}@example.com`,
): TenantUserRecord {
  return { id: `tu-${tenantId}-${userId}`, tenant_id: tenantId, user_id: userId, name, email };
}

function adminRow(
  tenantId: string,
  userId: string,
  name: string,
  email = `${userId}@example.com`,
): TenantAdminRecord {
  return { id: `ta-${tenantId}-${userId}`, tenant_id: tenantId, user_id: userId, name, email };
}

const ACME = tenant({ id: 't-acme', name: 'Acme Corp', slug: 'acme-corp', description: 'Payments' });
const GLOBEX = tenant({ id: 't-globex', name: 'Globex Labs', slug: 'globex-labs' });
const INITECH = tenant({ id: 't-initech', name: 'Initech', slug: 'initech' });
const LEGACY = tenant({
  id: 't-legacy',
  name: 'Legacy Holdings',
  slug: 'legacy-holdings',
  enabled: false,
});

describe('mergeTenantMembers', () => {
  it('gives a person holding both roles one row carrying both record ids', () => {
    const merged = mergeTenantMembers(
      [userRow('t-acme', 'u-ada', 'Ada Lovelace')],
      [adminRow('t-acme', 'u-ada', 'Ada Lovelace')],
      't-acme',
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      userId: 'u-ada',
      isAdmin: true,
      isMember: true,
      adminRecordId: 'ta-t-acme-u-ada',
      userRecordId: 'tu-t-acme-u-ada',
    });
  });

  it('keeps an administrator who has no membership row', () => {
    const merged = mergeTenantMembers([], [adminRow('t-acme', 'u-grace', 'Grace Hopper')], 't-acme');

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ isAdmin: true, isMember: false });
    // No membership row means no id to pass to `removeTenantUser`.
    expect(merged[0].userRecordId).toBeUndefined();
  });

  it('ignores administrators of other tenants', () => {
    const merged = mergeTenantMembers(
      [userRow('t-acme', 'u-linus', 'Linus Torvalds')],
      [adminRow('t-globex', 'u-linus', 'Linus Torvalds')],
      't-acme',
    );

    // Administering Globex must not make someone an administrator of Acme.
    expect(merged[0].isAdmin).toBe(false);
  });

  it('does not mutate the rows it was handed', () => {
    const users = [userRow('t-acme', 'u-ada', 'Ada Lovelace')];
    const admins = [adminRow('t-acme', 'u-ada', 'Ada Lovelace')];
    const snapshot = JSON.stringify({ users, admins });

    mergeTenantMembers(users, admins, 't-acme');

    expect(JSON.stringify({ users, admins })).toBe(snapshot);
  });
});

describe('filterTenantMembers', () => {
  const members = mergeTenantMembers(
    [
      userRow('t-acme', 'u-ada', 'Ada Lovelace', 'ada@example.com'),
      userRow('t-acme', 'u-grace', 'Grace Hopper', 'grace@navy.mil'),
    ],
    [],
    't-acme',
  );

  it('matches on name, case-insensitively', () => {
    expect(filterTenantMembers(members, 'ADA').map((m) => m.userId)).toEqual(['u-ada']);
  });

  it('matches on email', () => {
    expect(filterTenantMembers(members, 'navy').map((m) => m.userId)).toEqual(['u-grace']);
  });

  it('treats a blank or whitespace filter as no filter', () => {
    expect(filterTenantMembers(members, '')).toHaveLength(2);
    expect(filterTenantMembers(members, '   ')).toHaveLength(2);
  });

  it('returns a new array rather than filtering in place', () => {
    expect(filterTenantMembers(members, '')).not.toBe(members);
  });
});

describe('sortTenantMembers', () => {
  it('puts administrators first, then orders by name', () => {
    const members = mergeTenantMembers(
      [
        userRow('t-acme', 'u-zoe', 'Zoe Zebra'),
        userRow('t-acme', 'u-linus', 'Linus Torvalds'),
        userRow('t-acme', 'u-grace', 'Grace Hopper'),
      ],
      [adminRow('t-acme', 'u-zoe', 'Zoe Zebra')],
      't-acme',
    );

    expect(sortTenantMembers(members).map((m) => m.name)).toEqual([
      'Zoe Zebra',
      'Grace Hopper',
      'Linus Torvalds',
    ]);
  });

  it('leaves the input untouched', () => {
    const members = mergeTenantMembers(
      [userRow('t-acme', 'u-b', 'Bea'), userRow('t-acme', 'u-a', 'Al')],
      [],
      't-acme',
    );
    const order = members.map((m) => m.userId);

    sortTenantMembers(members);

    expect(members.map((m) => m.userId)).toEqual(order);
  });
});

describe('tenantMembersFor — the isolation this ticket exists for', () => {
  const users = [
    userRow('t-acme', 'u-ada', 'Ada Lovelace'),
    userRow('t-globex', 'u-linus', 'Linus Torvalds'),
  ];
  const admins = [adminRow('t-acme', 'u-ada', 'Ada Lovelace')];

  it('answers for the tenant it was asked about, not for whoever asked last', () => {
    const acme = tenantMembersFor({
      users: users.filter((u) => u.tenant_id === 't-acme'),
      admins,
      tenantId: 't-acme',
      filter: 'ada',
    });
    const globex = tenantMembersFor({
      users: users.filter((u) => u.tenant_id === 't-globex'),
      admins,
      tenantId: 't-globex',
      filter: '',
    });

    // The old screen shared one `memberFilter` across every tenant panel, so filtering Acme
    // by "ada" emptied Globex too. Nothing here can do that: the filter is an argument.
    expect(acme.map((m) => m.name)).toEqual(['Ada Lovelace']);
    expect(globex.map((m) => m.name)).toEqual(['Linus Torvalds']);
  });

  it('gives the same answer however many times it is called, in any order', () => {
    const args = {
      users: users.filter((u) => u.tenant_id === 't-acme'),
      admins,
      tenantId: 't-acme',
      filter: 'lovelace',
    };

    expect(tenantMembersFor(args)).toEqual(tenantMembersFor(args));
  });
});

describe('summariseTenantMembers', () => {
  it('counts everyone and the administrators among them', () => {
    const members = mergeTenantMembers(
      [userRow('t-acme', 'u-a', 'Al'), userRow('t-acme', 'u-b', 'Bea')],
      [adminRow('t-acme', 'u-a', 'Al')],
      't-acme',
    );

    expect(summariseTenantMembers(members)).toEqual({ total: 2, admins: 1 });
  });

  it('counts an empty tenant as zero and zero', () => {
    expect(summariseTenantMembers([])).toEqual({ total: 0, admins: 0 });
  });
});

describe('isTenantAdmin', () => {
  const admins = [adminRow('t-acme', 'u-ada', 'Ada Lovelace')];

  it('is true only for the matching tenant and user pair', () => {
    expect(isTenantAdmin(admins, 't-acme', 'u-ada')).toBe(true);
    expect(isTenantAdmin(admins, 't-globex', 'u-ada')).toBe(false);
    expect(isTenantAdmin(admins, 't-acme', 'u-linus')).toBe(false);
  });

  it('is false before the session resolves', () => {
    expect(isTenantAdmin(admins, 't-acme', undefined)).toBe(false);
    expect(isTenantAdmin(admins, 't-acme', null)).toBe(false);
  });
});

describe('buildTenantRows', () => {
  const rows = buildTenantRows([ACME, GLOBEX, INITECH], {
    admins: [adminRow('t-acme', 'u-ada', 'Ada'), adminRow('t-globex', 'u-ada', 'Ada')],
    userId: 'u-ada',
    currentTenantId: 't-acme',
  });

  it('marks which tenants the viewer administers', () => {
    expect(rows.map((r) => [r.id, r.isAdmin])).toEqual([
      ['t-acme', true],
      ['t-globex', true],
      ['t-initech', false],
    ]);
  });

  it('marks exactly one row current', () => {
    expect(rows.filter((r) => r.isCurrent).map((r) => r.id)).toEqual(['t-acme']);
  });

  it('marks nothing current when the session has no tenant', () => {
    const none = buildTenantRows([ACME], { admins: [], userId: 'u-ada', currentTenantId: null });
    expect(none[0].isCurrent).toBe(false);
  });

  it('preserves the order the API returned', () => {
    expect(rows.map((r) => r.id)).toEqual(['t-acme', 't-globex', 't-initech']);
  });
});

describe('the list toolbar', () => {
  const rows = buildTenantRows([ACME, GLOBEX, INITECH, LEGACY], {
    admins: [adminRow('t-acme', 'u-ada', 'Ada'), adminRow('t-legacy', 'u-ada', 'Ada')],
    userId: 'u-ada',
    currentTenantId: 't-acme',
  });

  it('searches name and slug, case-insensitively', () => {
    expect(searchTenantRows(rows, 'globex').map((r) => r.id)).toEqual(['t-globex']);
    expect(searchTenantRows(rows, 'ACME-CORP').map((r) => r.id)).toEqual(['t-acme']);
  });

  it('treats a blank query as no search', () => {
    expect(searchTenantRows(rows, '  ')).toHaveLength(4);
  });

  it('facets by administered and by enabled', () => {
    expect(rows.filter((r) => matchesTenantFacet(r, 'all'))).toHaveLength(4);
    expect(rows.filter((r) => matchesTenantFacet(r, 'administered')).map((r) => r.id)).toEqual([
      't-acme',
      't-legacy',
    ]);
    expect(rows.filter((r) => matchesTenantFacet(r, 'enabled')).map((r) => r.id)).toEqual([
      't-acme',
      't-globex',
      't-initech',
    ]);
  });

  it('counts each facet against the rows the search already left', () => {
    const searched = searchTenantRows(rows, 'l'); // Globex Labs, Legacy Holdings
    expect(searched.map((r) => r.id)).toEqual(['t-globex', 't-legacy']);
    // Legacy is administered but disabled; Globex is enabled but not administered.
    expect(tenantFacetCounts(searched)).toEqual({ all: 2, administered: 1, enabled: 1 });
  });

  it('sorts by name in both directions', () => {
    expect(sortTenantRows(rows, { column: 'name', direction: 'asc' }).map((r) => r.name)).toEqual([
      'Acme Corp',
      'Globex Labs',
      'Initech',
      'Legacy Holdings',
    ]);
    expect(sortTenantRows(rows, { column: 'name', direction: 'desc' })[0].name).toBe(
      'Legacy Holdings',
    );
  });

  it('sorts enabled before disabled, and breaks ties by name so the order is total', () => {
    const sorted = sortTenantRows(rows, { column: 'status', direction: 'asc' });
    expect(sorted.map((r) => r.enabled)).toEqual([true, true, true, false]);
    expect(sorted.slice(0, 3).map((r) => r.name)).toEqual(['Acme Corp', 'Globex Labs', 'Initech']);
  });

  it('keeps the API order when nothing is sorted', () => {
    expect(sortTenantRows(rows, null).map((r) => r.id)).toEqual(rows.map((r) => r.id));
  });

  it('counts the list for the foot', () => {
    expect(summariseTenantRows(rows)).toEqual({ total: 4, administered: 2, enabled: 3 });
  });
});

describe('row presentation', () => {
  it('names the viewer’s role', () => {
    expect(tenantRoleLabel({ isAdmin: true })).toBe('Admin');
    expect(tenantRoleLabel({ isAdmin: false })).toBe('Member');
  });

  it('maps enabled onto the shared status vocabulary, not onto a colour', () => {
    expect(tenantStatus({ enabled: true })).toBe('active');
    expect(tenantStatus({ enabled: false })).toBe('disabled');
    expect(tenantStatusLabel({ enabled: true })).toBe('Enabled');
    expect(tenantStatusLabel({ enabled: false })).toBe('Disabled');
  });
});

describe('validateTenantEdit', () => {
  const valid = { name: 'Acme Corp', slug: 'acme-corp', description: '' };

  it('accepts a well-formed draft', () => {
    expect(validateTenantEdit(valid)).toBeNull();
  });

  it('refuses a blank name, in the words the screen has always used', () => {
    expect(validateTenantEdit({ ...valid, name: '   ' })).toBe('Tenant name is required');
  });

  it('refuses a blank slug', () => {
    expect(validateTenantEdit({ ...valid, slug: '' })).toBe('Tenant slug is required');
  });

  it('refuses a slug with anything but lowercase letters, numbers and dashes', () => {
    const message = 'Slug must contain only lowercase letters, numbers, and dashes';
    expect(validateTenantEdit({ ...valid, slug: 'Acme Corp' })).toBe(message);
    expect(validateTenantEdit({ ...valid, slug: 'acme_corp' })).toBe(message);
    expect(validateTenantEdit({ ...valid, slug: 'ACME' })).toBe(message);
  });

  it('validates the trimmed slug, so surrounding space is not an error', () => {
    expect(validateTenantEdit({ ...valid, slug: '  acme-corp  ' })).toBeNull();
  });

  it('agrees with the pattern it publishes', () => {
    expect(TENANT_SLUG_PATTERN.test('acme-corp-2')).toBe(true);
    expect(TENANT_SLUG_PATTERN.test('acme corp')).toBe(false);
  });
});

describe('describeTenantEdit', () => {
  it('asks for a confirm only when the slug moved', () => {
    expect(
      describeTenantEdit({ name: 'Acme Europe', slug: 'acme-corp', description: '' }, ACME)
        .needsSlugConfirm,
    ).toBe(false);
    expect(
      describeTenantEdit({ name: 'Acme Corp', slug: 'acme', description: '' }, ACME)
        .needsSlugConfirm,
    ).toBe(true);
  });

  it('enumerates both fields, before and after, for the confirm to print', () => {
    const changes = describeTenantEdit(
      { name: ' Acme Europe ', slug: ' acme ', description: '' },
      ACME,
    );

    expect(changes).toMatchObject({
      nameChanged: true,
      slugChanged: true,
      name: { before: 'Acme Corp', after: 'Acme Europe' },
      slug: { before: 'acme-corp', after: 'acme' },
    });
  });

  it('does not call untouched fields changed', () => {
    const changes = describeTenantEdit(
      { name: 'Acme Corp', slug: 'acme', description: 'anything' },
      ACME,
    );
    expect(changes.nameChanged).toBe(false);
    expect(changes.slugChanged).toBe(true);
  });
});

describe('suggestTenantSlug', () => {
  it('lowercases and joins words with single dashes', () => {
    expect(suggestTenantSlug('Acme Corp')).toBe('acme-corp');
  });

  it('collapses punctuation rather than leaving dash runs or edges', () => {
    expect(suggestTenantSlug('Acme, Inc.')).toBe('acme-inc');
    expect(suggestTenantSlug('  Acme  ')).toBe('acme');
  });

  it('answers empty for a name with nothing usable in it', () => {
    expect(suggestTenantSlug('***')).toBe('');
  });

  it('always answers something the validator accepts, or nothing at all', () => {
    for (const name of ['Acme Corp', 'Übergrößen GmbH', '42 Ltd', 'a']) {
      const slug = suggestTenantSlug(name);
      if (slug) expect(TENANT_SLUG_PATTERN.test(slug)).toBe(true);
    }
  });
});

describe('the drawer’s sections', () => {
  it('lists the five sections in the mockup’s order', () => {
    expect(TENANT_MANAGE_SECTIONS).toEqual(['members', 'license', 'mcp', 'keys', 'history']);
  });

  it('needs the current tenant for everything but members', () => {
    expect(tenantSectionNeedsCurrent('members')).toBe(false);
    for (const section of ['license', 'mcp', 'keys', 'history'] as const) {
      expect(tenantSectionNeedsCurrent(section)).toBe(true);
    }
  });

  it('names the tenant in the lock note, so the instruction is actionable', () => {
    expect(tenantSectionLockNote('license', 'Globex Labs')).toBe(
      'Select Globex Labs as your current tenant to view its license details.',
    );
    expect(tenantSectionLockNote('mcp', 'Globex Labs')).toContain('view or edit MCP settings');
  });

  it('falls back to "this tenant" rather than printing a blank name', () => {
    expect(tenantSectionLockNote('license', '   ')).toContain('this tenant');
  });

  it('has no lock note for members, which are readable for any administered tenant', () => {
    expect(tenantSectionLockNote('members', 'Globex Labs')).toBeNull();
  });
});
