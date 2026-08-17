/**
 * The pure half of the Members redesign (HIVE-5.2, #5305).
 *
 * `src/app/components/ade/members/membersModel.ts` is where the screen's decisions live, and
 * this is where they are held to being decisions rather than opinions:
 *
 *   1. **The gates are one sentence.** Who may change a role, suspend, offboard or re-invite
 *      is computed once, including the own-row rule the screen this replaces did not have at
 *      all — an owner could offboard themselves out of their own workspace.
 *   2. **The seat rule is the licence's rule.** `inviteBlockedBySeats` refuses only when a
 *      licence was read *and* it is full; a failed licence read must never invent a limit.
 *   3. **The ordering is total.** Two renders over the same roster agree, and rows with no
 *      timestamp stay at the end whichever way a date column points.
 *   4. **Nothing is invented.** The permission tags come from the role's own grid and the
 *      activity rows from the ledger, so an empty role and an empty ledger both read as
 *      empty rather than as something plausible.
 */

import {
  describeAdminsRemaining,
  describeMemberBreakdown,
  describeMemberCount,
  describeOffboard,
  formatMemberDate,
  formatMemberRelative,
  inviteBlockedBySeats,
  isPendingInvite,
  isSelf,
  matchesMemberFacet,
  memberActivity,
  memberCapabilities,
  memberDisplayName,
  memberFacetCounts,
  memberPermissionPreview,
  memberRowActions,
  memberStatusLabel,
  nextMemberStatus,
  searchMembers,
  seatsAfterInvite,
  sortMembers,
  summariseMembers,
  validateInvite,
  ACTIVITY_PREVIEW_LIMIT,
  INVITE_EMPTY_EMAIL_MESSAGE,
  MEMBER_FACETS,
  NO_TIMESTAMP,
  OWN_ROW_REASON,
  PERMISSION_PREVIEW_LIMIT,
  type AccessAuditRecord,
  type MemberRecord,
  type RoleRecord,
} from '../src/app/components/ade/members/membersModel';

/** Everything a member row carries, so a fixture only has to state what it is about. */
const BASE: MemberRecord = {
  user_id: 'u-base',
  name: 'Base Person',
  email: 'base@acme.io',
  status: 'active',
  member_since: '2026-01-01T00:00:00Z',
  joined_at: '2026-01-01T00:00:00Z',
  last_active: '2026-08-01T00:00:00Z',
  two_factor_enabled: false,
  role_id: 'role-editor',
  role_name: 'Editor',
  role_slug: 'editor',
  is_admin: false,
};

/**
 * One member, with the given fields overridden.
 *
 * @param overrides What this fixture is about.
 * @returns A complete member record.
 */
function member(overrides: Partial<MemberRecord>): MemberRecord {
  return { ...BASE, ...overrides };
}

/** An owner, an editor, a suspended viewer and an outstanding invitation. */
const ROSTER: MemberRecord[] = [
  member({
    user_id: 'u-ada',
    name: 'Ada Lovelace',
    email: 'ada@acme.io',
    is_admin: true,
    role_id: 'role-owner',
    role_name: 'Owner',
    role_slug: 'owner',
    joined_at: '2025-01-12T00:00:00Z',
    last_active: '2026-08-17T11:58:00Z',
  }),
  member({
    user_id: 'u-grace',
    name: 'Grace Hopper',
    email: 'grace@acme.io',
    is_admin: true,
    joined_at: '2025-02-03T00:00:00Z',
    last_active: '2026-08-16T09:00:00Z',
  }),
  member({
    user_id: 'u-margaret',
    name: 'Margaret Hamilton',
    email: 'margaret@acme.io',
    status: 'suspended',
    joined_at: '2025-05-02T00:00:00Z',
    last_active: null,
  }),
  member({
    user_id: 'u-partner',
    name: '',
    email: 'dev-partner@globex.io',
    status: 'pending',
    joined_at: '2026-08-13T00:00:00Z',
    last_active: null,
  }),
];

const ROLES: RoleRecord[] = [
  {
    id: 'role-owner',
    slug: 'owner',
    name: 'Owner',
    is_builtin: true,
    permissions: [
      { resource: 'members', action: 'edit' },
      { resource: 'members', action: 'view' },
    ],
  },
  {
    id: 'role-editor',
    slug: 'editor',
    name: 'Editor',
    is_builtin: true,
    permissions: [
      { resource: 'versions', action: 'edit' },
      { resource: 'projects', action: 'view' },
    ],
  },
  { id: 'role-bare', slug: 'bare', name: 'Bare', is_builtin: false, permissions: [] },
];

/** The viewer holds everything — the shape `permissions/me` reports for an administrator. */
const ADMIN_CAPS = memberCapabilities({ is_admin: true, permissions: [] });

/* -------------------------------------------------------------------------
   1. Identity
   ------------------------------------------------------------------------- */

describe('naming a member', () => {
  it('falls back to the address when a pending invitation has no name yet', () => {
    expect(memberDisplayName(member({ name: '', email: 'nobody@acme.io' }))).toBe(
      'nobody@acme.io'
    );
    expect(memberDisplayName(member({ name: '   ' }))).toBe('base@acme.io');
    expect(memberDisplayName(member({ name: 'Ada' }))).toBe('Ada');
  });

  it('capitalises a lifecycle state without renaming it', () => {
    // The word is the shared vocabulary's own, so `Badge` resolves the same string to a tone
    // and the pill's colour cannot describe a different state from its text.
    expect(memberStatusLabel('active')).toBe('Active');
    expect(memberStatusLabel('pending')).toBe('Pending');
    expect(memberStatusLabel('suspended')).toBe('Suspended');
  });

  it('knows an invitation from a member', () => {
    expect(isPendingInvite(member({ status: 'pending' }))).toBe(true);
    expect(isPendingInvite(member({ status: 'active' }))).toBe(false);
    expect(isPendingInvite(member({ status: 'suspended' }))).toBe(false);
  });
});

/* -------------------------------------------------------------------------
   2. Gates
   ------------------------------------------------------------------------- */

describe('what the viewer may do', () => {
  it('gives an administrator every gate without naming a role', () => {
    expect(memberCapabilities({ is_admin: true, permissions: [] })).toEqual({
      canInvite: true,
      canEdit: true,
      canDelete: true,
    });
  });

  it('reads each gate off its own grant', () => {
    expect(memberCapabilities({ is_admin: false, permissions: ['members:edit'] })).toEqual({
      canInvite: false,
      canEdit: true,
      canDelete: false,
    });
  });

  it('closes every gate while permissions are unknown', () => {
    // The screen renders before `permissions/me` answers, and a control drawn live for that
    // moment is a control that 403s when pressed.
    for (const perms of [null, undefined]) {
      expect(memberCapabilities(perms)).toEqual({
        canInvite: false,
        canEdit: false,
        canDelete: false,
      });
    }
  });

  it('knows the viewer’s own row', () => {
    expect(isSelf(member({ user_id: 'u-1' }), 'u-1')).toBe(true);
    expect(isSelf(member({ user_id: 'u-1' }), 'u-2')).toBe(false);
    expect(isSelf(member({ user_id: 'u-1' }), null)).toBe(false);
  });
});

describe('what one row offers', () => {
  it('closes every write on the viewer’s own membership, and says why', () => {
    // The bug this closes: nothing stopped an owner offboarding themselves out of the
    // workspace they were administering.
    const own = memberRowActions(member({ user_id: 'u-me' }), {
      capabilities: ADMIN_CAPS,
      viewerId: 'u-me',
    });
    expect(own.canChangeRole).toBe(false);
    expect(own.canChangeStatus).toBe(false);
    expect(own.canOffboard).toBe(false);
    expect(own.disabledReason).toBe(OWN_ROW_REASON);
  });

  it('opens them on everybody else', () => {
    const other = memberRowActions(member({ user_id: 'u-them' }), {
      capabilities: ADMIN_CAPS,
      viewerId: 'u-me',
    });
    expect(other).toMatchObject({
      canChangeRole: true,
      canChangeStatus: true,
      canOffboard: true,
      disabledReason: null,
    });
  });

  it('offers Resend only for an outstanding invitation, and only with the invite grant', () => {
    const invite = member({ user_id: 'u-p', status: 'pending' });
    expect(
      memberRowActions(invite, { capabilities: ADMIN_CAPS, viewerId: 'u-me' }).canResendInvite
    ).toBe(true);
    expect(
      memberRowActions(member({ user_id: 'u-p' }), {
        capabilities: ADMIN_CAPS,
        viewerId: 'u-me',
      }).canResendInvite
    ).toBe(false);
    expect(
      memberRowActions(invite, {
        capabilities: memberCapabilities({ is_admin: false, permissions: ['members:edit'] }),
        viewerId: 'u-me',
      }).canResendInvite
    ).toBe(false);
  });

  it('respects a partial grant rather than treating edit as everything', () => {
    const editorOnly = memberCapabilities({ is_admin: false, permissions: ['members:edit'] });
    const actions = memberRowActions(member({ user_id: 'u-them' }), {
      capabilities: editorOnly,
      viewerId: 'u-me',
    });
    expect(actions.canChangeStatus).toBe(true);
    expect(actions.canOffboard).toBe(false);
  });
});

/* -------------------------------------------------------------------------
   3. The list
   ------------------------------------------------------------------------- */

describe('the toolbar’s facets', () => {
  it('counts every facet against the rows the search already narrowed', () => {
    expect(memberFacetCounts(ROSTER)).toEqual({
      all: 4,
      active: 2,
      pending: 1,
      suspended: 1,
      admins: 2,
    });
  });

  it('matches a lifecycle facet by status and the admin facet by the flag', () => {
    const suspended = ROSTER[2];
    expect(matchesMemberFacet(suspended, 'suspended')).toBe(true);
    expect(matchesMemberFacet(suspended, 'active')).toBe(false);
    expect(matchesMemberFacet(ROSTER[0], 'admins')).toBe(true);
    expect(matchesMemberFacet(suspended, 'admins')).toBe(false);
  });

  it('lets everything through the resting facet', () => {
    for (const entry of ROSTER) expect(matchesMemberFacet(entry, 'all')).toBe(true);
  });

  it('has a count for every facet the toolbar draws', () => {
    const counts = memberFacetCounts(ROSTER);
    for (const facet of MEMBER_FACETS) expect(counts[facet]).toEqual(expect.any(Number));
  });
});

describe('the search box', () => {
  it('matches name or email, case-folded, on a substring', () => {
    expect(searchMembers(ROSTER, 'GRACE').map((m) => m.user_id)).toEqual(['u-grace']);
    expect(searchMembers(ROSTER, 'globex').map((m) => m.user_id)).toEqual(['u-partner']);
  });

  it('treats a blank or whitespace query as no filter, and copies the array', () => {
    for (const query of ['', '   ']) {
      const result = searchMembers(ROSTER, query);
      expect(result).toEqual(ROSTER);
      expect(result).not.toBe(ROSTER);
    }
  });
});

describe('ordering the roster', () => {
  it('leaves the API’s order alone when nothing is sorted', () => {
    expect(sortMembers(ROSTER, null).map((m) => m.user_id)).toEqual(
      ROSTER.map((m) => m.user_id)
    );
  });

  it('orders by display name, so a nameless invitation sorts by its address', () => {
    expect(sortMembers(ROSTER, { column: 'user', direction: 'asc' }).map((m) => m.user_id)).toEqual(
      ['u-ada', 'u-partner', 'u-grace', 'u-margaret']
    );
  });

  it('orders the lifecycle active → pending → suspended, breaking ties by name', () => {
    expect(
      sortMembers(ROSTER, { column: 'status', direction: 'asc' }).map((m) => m.status)
    ).toEqual(['active', 'active', 'pending', 'suspended']);
  });

  it('keeps rows with no timestamp at the end whichever way a date column points', () => {
    // "Never signed in" is absent, not early: flipping the direction must not fill the top of
    // the table with the people about whom nothing is known.
    for (const direction of ['asc', 'desc'] as const) {
      const ordered = sortMembers(ROSTER, { column: 'lastActive', direction });
      expect(ordered.slice(2).map((m) => m.user_id).sort()).toEqual(['u-margaret', 'u-partner']);
    }
  });

  it('is total — two runs over the same roster agree', () => {
    const once = sortMembers(ROSTER, { column: 'status', direction: 'asc' });
    const twice = sortMembers([...ROSTER].reverse(), { column: 'status', direction: 'asc' });
    expect(twice.map((m) => m.user_id)).toEqual(once.map((m) => m.user_id));
  });

  it('leaves the input alone', () => {
    const before = ROSTER.map((m) => m.user_id);
    sortMembers(ROSTER, { column: 'joined', direction: 'desc' });
    expect(ROSTER.map((m) => m.user_id)).toEqual(before);
  });
});

describe('the counts the page prints', () => {
  it('summarises the whole roster, not the current filter', () => {
    expect(summariseMembers(ROSTER)).toEqual({
      total: 4,
      active: 2,
      pending: 1,
      suspended: 1,
      admins: 2,
    });
  });

  it('keeps the header’s "{n} members · {p} pending" and drops an empty pending clause', () => {
    expect(describeMemberCount(summariseMembers(ROSTER))).toBe('4 members · 1 pending');
    expect(describeMemberCount(summariseMembers([ROSTER[0]]))).toBe('1 member');
  });

  it('enumerates only the states that have anyone in them', () => {
    expect(describeMemberBreakdown(summariseMembers(ROSTER))).toBe(
      '4 people · 2 active · 1 pending · 1 suspended'
    );
    expect(describeMemberBreakdown(summariseMembers([ROSTER[0]]))).toBe('1 person · 1 active');
    expect(describeMemberBreakdown(summariseMembers([]))).toBe('No members');
  });
});

/* -------------------------------------------------------------------------
   4. Seats
   ------------------------------------------------------------------------- */

describe('the seat gate', () => {
  it('refuses only when a licence was read and it is full', () => {
    expect(inviteBlockedBySeats({ used: 5, max: 5 })).toBe(true);
    expect(inviteBlockedBySeats({ used: 4, max: 5 })).toBe(false);
  });

  it('never invents a limit when the licence could not be read', () => {
    // Seat usage is best-effort context. Refusing an invite because a background call failed
    // would be the screen enforcing a rule the licence never stated.
    expect(inviteBlockedBySeats(null)).toBe(false);
    expect(inviteBlockedBySeats(undefined)).toBe(false);
  });

  it('is never at capacity on an unlimited plan', () => {
    expect(inviteBlockedBySeats({ used: 400, max: -1 })).toBe(false);
  });

  it('forecasts one more seat, capped at the limit', () => {
    expect(seatsAfterInvite({ used: 3, max: 5 })).toEqual({ used: 4, max: 5 });
    // The dialog is a forecast of an *allowed* action; "6 of 5" is not a state the licence has.
    expect(seatsAfterInvite({ used: 5, max: 5 })).toEqual({ used: 5, max: 5 });
    expect(seatsAfterInvite({ used: 9, max: -1 })).toEqual({ used: 10, max: -1 });
  });
});

/* -------------------------------------------------------------------------
   5. The four decisions
   ------------------------------------------------------------------------- */

describe('validating an invite', () => {
  it('keeps the screen’s own message for an empty field', () => {
    expect(validateInvite('')).toBe(INVITE_EMPTY_EMAIL_MESSAGE);
    expect(validateInvite('   ')).toBe(INVITE_EMPTY_EMAIL_MESSAGE);
  });

  it('leaves every other rule to the API that enforces it', () => {
    // Deliberately not an address check: unknown account, already a member and seats
    // exhausted are the server's answers, and a dialog that guesses at them drifts from it.
    expect(validateInvite('not-an-address')).toBeNull();
    expect(validateInvite(' person@example.com ')).toBeNull();
  });
});

describe('the offboard consequence', () => {
  it('counts the administrators the tenant would have left', () => {
    expect(describeOffboard(ROSTER[1], ROSTER)).toEqual({
      isAdmin: true,
      adminsRemaining: 1,
      isInvite: false,
    });
  });

  it('does not decrement for someone who is not an administrator', () => {
    expect(describeOffboard(ROSTER[2], ROSTER)).toMatchObject({
      isAdmin: false,
      adminsRemaining: 2,
    });
  });

  it('marks an invitation, so the dialog can say "Cancel invite"', () => {
    expect(describeOffboard(ROSTER[3], ROSTER).isInvite).toBe(true);
  });

  it('phrases the warning for none, one and several', () => {
    expect(describeAdminsRemaining({ isAdmin: true, adminsRemaining: 0, isInvite: false })).toMatch(
      /no administrator/
    );
    expect(describeAdminsRemaining({ isAdmin: true, adminsRemaining: 1, isInvite: false })).toContain(
      '1 administrator'
    );
    expect(describeAdminsRemaining({ isAdmin: true, adminsRemaining: 3, isInvite: false })).toContain(
      '3 administrators'
    );
  });
});

describe('the lifecycle toggle', () => {
  it('points at the other end of the toggle', () => {
    expect(nextMemberStatus({ status: 'suspended' })).toBe('active');
    expect(nextMemberStatus({ status: 'active' })).toBe('suspended');
    // A pending invitation can be suspended too — the API accepts the transition, and the
    // toggle is "not suspended → suspended" rather than "active → suspended".
    expect(nextMemberStatus({ status: 'pending' })).toBe('suspended');
  });
});

/* -------------------------------------------------------------------------
   6. Permissions and activity — read, never invented
   ------------------------------------------------------------------------- */

describe('the permissions a member holds', () => {
  it('reads the assigned role’s own grid, sorted', () => {
    const preview = memberPermissionPreview(ROSTER[1], ROLES);
    expect(preview.shown).toEqual(['projects:view', 'versions:edit']);
    expect(preview.total).toBe(2);
    expect(preview.more).toBe(0);
  });

  it('elides past the preview limit rather than filling the sheet', () => {
    const wide: RoleRecord = {
      id: 'role-wide',
      slug: 'wide',
      name: 'Wide',
      is_builtin: false,
      permissions: Array.from({ length: PERMISSION_PREVIEW_LIMIT + 4 }, (_, index) => ({
        resource: `res${String(index).padStart(2, '0')}`,
        action: 'view',
      })),
    };
    const preview = memberPermissionPreview(member({ role_id: 'role-wide' }), [wide]);
    expect(preview.shown).toHaveLength(PERMISSION_PREVIEW_LIMIT);
    expect(preview.more).toBe(4);
    expect(preview.total).toBe(PERMISSION_PREVIEW_LIMIT + 4);
  });

  it('reports nothing for a role with an empty grid, and for no role at all', () => {
    expect(memberPermissionPreview(member({ role_id: 'role-bare' }), ROLES).total).toBe(0);
    expect(memberPermissionPreview(member({ role_id: null }), ROLES).total).toBe(0);
    expect(memberPermissionPreview(member({ role_id: 'role-gone' }), ROLES).total).toBe(0);
  });
});

describe('the activity a member appears in', () => {
  /**
   * One ledger row.
   *
   * @param overrides What the fixture is about.
   * @returns A complete audit record.
   */
  const event = (overrides: Partial<AccessAuditRecord>): AccessAuditRecord => ({
    id: 'evt',
    created_at: '2026-08-17T10:00:00Z',
    actor_id: null,
    actor_label: null,
    action: 'member.invited',
    target: null,
    source: 'web',
    ...overrides,
  });

  const subject = member({ user_id: 'u-9', email: 'Noah@Partner.com' });

  it('keeps rows they performed and rows performed on them', () => {
    const rows = [
      event({ id: 'a', actor_id: 'u-9', action: 'role.assigned' }),
      event({ id: 'b', target: 'u-9', action: 'member.suspended' }),
      // The invite route writes the address as the target, the lifecycle routes write the id.
      event({ id: 'c', target: 'noah@partner.com', action: 'member.invited' }),
      event({ id: 'd', actor_id: 'u-other', target: 'u-other' }),
    ];
    expect(memberActivity(rows, subject).map((row) => row.id)).toEqual(['a', 'b', 'c']);
  });

  it('caps the preview and keeps the ledger’s newest-first order', () => {
    const rows = Array.from({ length: ACTIVITY_PREVIEW_LIMIT + 3 }, (_, index) =>
      event({ id: `e${index}`, actor_id: 'u-9' })
    );
    const kept = memberActivity(rows, subject);
    expect(kept).toHaveLength(ACTIVITY_PREVIEW_LIMIT);
    expect(kept[0].id).toBe('e0');
  });

  it('reads as empty when the ledger mentions nobody, rather than as something plausible', () => {
    expect(memberActivity([], subject)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------
   7. Time
   ------------------------------------------------------------------------- */

describe('printing an instant', () => {
  const NOW = Date.parse('2026-08-17T12:00:00Z');

  it('prints a dash rather than a guess when there is no instant', () => {
    for (const value of [null, undefined, '', 'not-a-date']) {
      expect(formatMemberDate(value, 'UTC')).toBe(NO_TIMESTAMP);
      expect(formatMemberRelative(value, NOW, 'UTC')).toBe(NO_TIMESTAMP);
    }
  });

  it('prints an absolute date the way the mockup does', () => {
    expect(formatMemberDate('2025-01-12T09:00:00Z', 'UTC')).toBe('Jan 12, 2025');
  });

  it('steps the relative phrase through the mockup’s vocabulary', () => {
    expect(formatMemberRelative('2026-08-17T11:59:30Z', NOW, 'UTC')).toBe('Just now');
    expect(formatMemberRelative('2026-08-17T11:58:00Z', NOW, 'UTC')).toBe('2 minutes ago');
    expect(formatMemberRelative('2026-08-17T11:00:00Z', NOW, 'UTC')).toBe('1 hour ago');
    expect(formatMemberRelative('2026-08-17T09:00:00Z', NOW, 'UTC')).toBe('3 hours ago');
    expect(formatMemberRelative('2026-08-16T09:00:00Z', NOW, 'UTC')).toBe('Yesterday');
    expect(formatMemberRelative('2026-08-14T09:00:00Z', NOW, 'UTC')).toBe('3 days ago');
  });

  it('becomes the absolute date past a week, rather than arithmetic to undo', () => {
    expect(formatMemberRelative('2026-07-30T09:00:00Z', NOW, 'UTC')).toBe('Jul 30, 2026');
  });

  it('reads a future instant as "Just now" rather than counting backwards', () => {
    // Clock skew between the browser and the server is real; "in 3 seconds" would be a
    // distraction about the wrong thing.
    expect(formatMemberRelative('2026-08-17T12:00:30Z', NOW, 'UTC')).toBe('Just now');
  });
});
