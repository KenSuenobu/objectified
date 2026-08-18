/**
 * The access-audit derivations (HIVE-5.5, #5308).
 *
 * `audit-hive-redesign.test.tsx` renders the screen and `audit-css.test.ts` reads the
 * stylesheet; this holds the claims underneath both, because they are claims and not
 * appearances:
 *
 *   1. **"Existing five filters behave identically."** The ticket's first acceptance
 *      criterion, and the one this ticket could most easily break — the six categories are
 *      partitioned in the browser now, so the prefixes have to be *the server's*, tested
 *      against a transcription of `_AUDIT_FILTERS`.
 *   2. **The chain claim is checked or it is not made.** Five distinguishable answers, one of
 *      which is "the previous entry was not read", because a browser holding a filtered page
 *      of a per-tenant chain genuinely cannot verify a link.
 *   3. **The drawer's sentence is derived, never invented.** Every phrase comes from an action
 *      real code writes; an unknown action falls back to naming itself.
 *   4. **Nothing renders an object into JSX.** The screen this replaces drew `target || detail`
 *      with `detail` a JSONB object, which throws — `auditDetailEntries` is what flattens it.
 */

import {
  AUDIT_CHAIN_MESSAGES,
  AUDIT_FILTERS,
  AUDIT_FILTER_LABELS,
  AUDIT_FILTER_PREFIXES,
  AUDIT_PAGE_SIZE,
  AUDIT_RANGES,
  AUDIT_RANGE_LABELS,
  auditActorLabel,
  auditBadgeTone,
  auditChainPosition,
  auditChange,
  auditDetailEntries,
  auditEventJson,
  auditFamily,
  auditFilterCounts,
  auditPage,
  auditPageCount,
  auditRangeStart,
  auditSourcePhrase,
  describeAuditEvent,
  describeAuditRead,
  formatAuditExactTimestamp,
  formatAuditRelative,
  formatAuditTimestamp,
  matchesAuditFilter,
  NO_VALUE,
  searchAuditEvents,
  sortAuditEvents,
  type AuditEvent,
} from '../src/app/components/ade/audit/auditModel';

// ---------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------

/**
 * Build one ledger row.
 *
 * @param over What this row differs by.
 * @returns The row.
 */
function event(over: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: 'evt-1',
    actor_id: 'usr-ada',
    actor_label: 'ada@acme.io',
    action: 'role.assigned',
    target: 'linus@acme.io',
    source: 'web',
    detail: { role: 'Release manager' },
    prev_hash: null,
    entry_hash: 'h1',
    created_at: '2026-08-15T09:41:07Z',
    ...over,
  };
}

/**
 * A hash-linked ledger, newest first — `c` follows `b` follows `a`.
 *
 * The order matters: `auditChainPosition` reads the *next* element as the entry written
 * before, which is only true of a newest-first response.
 */
const CHAINED: AuditEvent[] = [
  event({ id: 'c', entry_hash: 'hash-c', prev_hash: 'hash-b', created_at: '2026-08-15T12:00:00Z' }),
  event({ id: 'b', entry_hash: 'hash-b', prev_hash: 'hash-a', created_at: '2026-08-14T12:00:00Z' }),
  event({ id: 'a', entry_hash: 'hash-a', prev_hash: null, created_at: '2026-08-13T12:00:00Z' }),
];

// ---------------------------------------------------------------------------------------
// 1. The categories
// ---------------------------------------------------------------------------------------

describe('the six categories', () => {
  it('carries the prefixes the server filters by, so a chip leaves the same rows', () => {
    // A transcription of `_AUDIT_FILTERS` in apiome-rest/src/app/access_routes.py. When that
    // map changes, this is the test that says so.
    expect(AUDIT_FILTER_PREFIXES).toEqual({
      all: null,
      role: 'role.',
      permission: 'permission.',
      member: 'member.',
      admin: 'admin.',
      styleGuide: 'style_guide.',
    });
  });

  it('exposes the styleGuide category the server has always understood', () => {
    expect(AUDIT_FILTERS).toContain('styleGuide');
    expect(AUDIT_FILTER_LABELS.styleGuide).toBe('Style guides');
    expect(matchesAuditFilter(event({ action: 'style_guide.rules_updated' }), 'styleGuide')).toBe(
      true
    );
  });

  it('keeps the original five ordered as the screen it replaces had them', () => {
    expect(AUDIT_FILTERS.slice(0, 5)).toEqual(['all', 'role', 'permission', 'member', 'admin']);
  });

  it('matches on the prefix and not on the family, so member.invite_resent is a member event', () => {
    expect(matchesAuditFilter(event({ action: 'member.invite_resent' }), 'member')).toBe(true);
    expect(matchesAuditFilter(event({ action: 'member.invite_resent' }), 'role')).toBe(false);
  });

  it('keeps everything under All events', () => {
    for (const action of ['role.created', 'sso.login', 'governance.quality_policy.update']) {
      expect(matchesAuditFilter(event({ action }), 'all')).toBe(true);
    }
  });

  it('counts each category over the rows the chips sit above', () => {
    const counts = auditFilterCounts([
      event({ id: '1', action: 'role.created' }),
      event({ id: '2', action: 'role.deleted' }),
      event({ id: '3', action: 'permission.denied' }),
      event({ id: '4', action: 'sso.login' }),
    ]);
    expect(counts.all).toBe(4);
    expect(counts.role).toBe(2);
    expect(counts.permission).toBe(1);
    expect(counts.member).toBe(0);
    // An `sso.*` event is in no category but `all` — the mockup colours it and no chip claims it.
    expect(counts.styleGuide).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------
// 2. Families and tones
// ---------------------------------------------------------------------------------------

describe('event families', () => {
  it('reads the family off the first segment', () => {
    expect(auditFamily('role.assigned')).toBe('role');
    expect(auditFamily('permission.denied')).toBe('permission');
    expect(auditFamily('member.offboarded')).toBe('member');
    expect(auditFamily('admin.override')).toBe('admin');
    expect(auditFamily('sso.login')).toBe('sso');
    expect(auditFamily('style_guide.assigned')).toBe('style_guide');
  });

  it('puts a governance action in `other`, because no chip claims it', () => {
    expect(auditFamily('governance.quality_policy.update')).toBe('other');
    expect(auditFamily('')).toBe('other');
  });

  it('gives each family the tone the mockup colours it, by name rather than by hue', () => {
    expect(auditBadgeTone('role.created')).toBe('orange');
    expect(auditBadgeTone('permission.changed')).toBe('rose');
    expect(auditBadgeTone('member.invited')).toBe('accent');
    expect(auditBadgeTone('admin.override')).toBe('violet');
    expect(auditBadgeTone('sso.login')).toBe('ok');
    expect(auditBadgeTone('style_guide.updated')).toBe('honey');
    expect(auditBadgeTone('version.breaking_publish_guardrail')).toBe('neutral');
  });
});

describe('sources', () => {
  it('has a phrase for every value the writers really store', () => {
    for (const source of ['web', 'api', 'api_key', 'admin', 'sso', 'scim', 'system']) {
      expect(auditSourcePhrase(source)).not.toBe('');
    }
  });

  it('says nothing about an origin it does not recognise', () => {
    expect(auditSourcePhrase('carrier-pigeon')).toBe('');
    expect(auditSourcePhrase(null)).toBe('');
  });
});

// ---------------------------------------------------------------------------------------
// 3. Date ranges
// ---------------------------------------------------------------------------------------

describe('date ranges', () => {
  const NOW = new Date('2026-08-15T12:00:00Z');

  it('offers a label for every range', () => {
    for (const range of AUDIT_RANGES) {
      expect(AUDIT_RANGE_LABELS[range]).toBeTruthy();
    }
  });

  it('counts back the number of days it names', () => {
    expect(auditRangeStart('24h', NOW)?.toISOString()).toBe('2026-08-14T12:00:00.000Z');
    expect(auditRangeStart('7d', NOW)?.toISOString()).toBe('2026-08-08T12:00:00.000Z');
    expect(auditRangeStart('30d', NOW)?.toISOString()).toBe('2026-07-16T12:00:00.000Z');
    expect(auditRangeStart('90d', NOW)?.toISOString()).toBe('2026-05-17T12:00:00.000Z');
  });

  it('answers `all` with the absence of a bound, not with a very old date', () => {
    // The request omits `since` entirely; a sentinel date would silently exclude an entry
    // older than it, which on an append-only ledger is the one thing a range must not do.
    expect(auditRangeStart('all', NOW)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------
// 4. Search, sort, paging
// ---------------------------------------------------------------------------------------

describe('search', () => {
  const LEDGER = [
    event({ id: '1', actor_label: 'ada@acme.io', action: 'role.created', target: 'Release manager' }),
    event({
      id: '2',
      actor_label: 'grace@acme.io',
      action: 'member.invited',
      target: 'bob@acme.io',
      detail: { role: 'Viewer' },
    }),
    event({
      id: '3',
      actor_label: 'key_9f31c2',
      action: 'permission.denied',
      target: 'POST /v1/versions',
      detail: { resource: 'versions', action: 'create' },
    }),
  ];

  it('keeps everything for a blank query', () => {
    expect(searchAuditEvents(LEDGER, '   ')).toHaveLength(3);
  });

  it('matches the actor, the action and the target', () => {
    expect(searchAuditEvents(LEDGER, 'grace').map((row) => row.id)).toEqual(['2']);
    expect(searchAuditEvents(LEDGER, 'denied').map((row) => row.id)).toEqual(['3']);
    expect(searchAuditEvents(LEDGER, 'release').map((row) => row.id)).toEqual(['1']);
  });

  it('reaches into the structured detail, where the substance of an event lives', () => {
    expect(searchAuditEvents(LEDGER, 'versions').map((row) => row.id)).toEqual(['3']);
  });

  it('is case-insensitive and does not mutate its input', () => {
    const before = [...LEDGER];
    expect(searchAuditEvents(LEDGER, 'GRACE')).toHaveLength(1);
    expect(LEDGER).toEqual(before);
  });
});

describe('sorting', () => {
  const LEDGER = [
    event({ id: '1', created_at: '2026-08-15T09:00:00Z', actor_label: 'zoe@acme.io' }),
    event({ id: '2', created_at: '2026-08-13T09:00:00Z', actor_label: 'ada@acme.io' }),
    event({ id: '3', created_at: '2026-08-14T09:00:00Z', actor_label: 'mia@acme.io' }),
  ];

  it('leaves the ledger in its own order when nothing is sorted', () => {
    expect(sortAuditEvents(LEDGER, null).map((row) => row.id)).toEqual(['1', '2', '3']);
  });

  it('sorts by when, in both directions', () => {
    expect(sortAuditEvents(LEDGER, { column: 'when', direction: 'asc' }).map((r) => r.id)).toEqual([
      '2',
      '3',
      '1',
    ]);
    expect(sortAuditEvents(LEDGER, { column: 'when', direction: 'desc' }).map((r) => r.id)).toEqual([
      '1',
      '3',
      '2',
    ]);
  });

  it('sorts by actor', () => {
    expect(sortAuditEvents(LEDGER, { column: 'actor', direction: 'asc' }).map((r) => r.id)).toEqual([
      '2',
      '3',
      '1',
    ]);
  });

  it('ignores a column it does not sort by, rather than reordering at random', () => {
    expect(
      sortAuditEvents(LEDGER, { column: 'nonsense', direction: 'asc' }).map((r) => r.id)
    ).toEqual(['1', '2', '3']);
  });

  it('never mutates the array it was given', () => {
    const before = LEDGER.map((row) => row.id);
    sortAuditEvents(LEDGER, { column: 'when', direction: 'asc' });
    expect(LEDGER.map((row) => row.id)).toEqual(before);
  });
});

describe('paging', () => {
  const MANY = Array.from({ length: 60 }, (_, index) => event({ id: `e${index}` }));

  it('says one page for an empty list, so the foot never reads “page 1 of 0”', () => {
    expect(auditPageCount(0)).toBe(1);
  });

  it('divides by the page size', () => {
    expect(auditPageCount(60)).toBe(Math.ceil(60 / AUDIT_PAGE_SIZE));
  });

  it('returns the rows of the page asked for', () => {
    expect(auditPage(MANY, 1)[0].id).toBe('e0');
    expect(auditPage(MANY, 2)[0].id).toBe(`e${AUDIT_PAGE_SIZE}`);
    expect(auditPage(MANY, 1)).toHaveLength(AUDIT_PAGE_SIZE);
  });

  it('clamps a page that a narrowing has just removed', () => {
    // The reader was on page 3 and typed a search that leaves eight rows: the answer is the
    // last page there is, not an empty table.
    const few = MANY.slice(0, 8);
    expect(auditPage(few, 3).map((row) => row.id)).toEqual(few.map((row) => row.id));
    expect(auditPage(MANY, 0)[0].id).toBe('e0');
  });
});

// ---------------------------------------------------------------------------------------
// 5. The hash chain
// ---------------------------------------------------------------------------------------

describe('the hash chain', () => {
  it('confirms a link when the previous entry’s hash is the one this entry claims', () => {
    const position = auditChainPosition(CHAINED, CHAINED[0]);
    expect(position.status).toBe('linked');
    expect(position.previousHash).toBe('hash-b');
    expect(position.entryHash).toBe('hash-c');
  });

  it('reports a break when it is not', () => {
    const tampered = [
      event({ id: 'c', entry_hash: 'hash-c', prev_hash: 'something-else' }),
      event({ id: 'b', entry_hash: 'hash-b', prev_hash: 'hash-a' }),
    ];
    expect(auditChainPosition(tampered, tampered[0]).status).toBe('broken');
  });

  it('names the first entry of the chain rather than calling it unlinked', () => {
    expect(auditChainPosition(CHAINED, CHAINED[2]).status).toBe('chain-start');
  });

  it('says the link was not checked when the previous entry is outside the view', () => {
    // The oldest row of the response: the entry before it exists but was not read, so nothing
    // here can say anything about the link — and saying so is the point.
    const page = [CHAINED[0], CHAINED[1]];
    expect(auditChainPosition(page, page[1]).status).toBe('not-loaded');
  });

  it('says the same for a row that is not in the ledger it was given', () => {
    expect(auditChainPosition([], CHAINED[0]).status).toBe('not-loaded');
  });

  it('reports an entry with no hashes as unavailable rather than as a break', () => {
    const bare = event({ prev_hash: null, entry_hash: null });
    expect(auditChainPosition([bare], bare).status).toBe('unavailable');
  });

  it('has a sentence for every answer it can give', () => {
    for (const status of [
      'linked',
      'broken',
      'chain-start',
      'not-loaded',
      'unavailable',
    ] as const) {
      expect(AUDIT_CHAIN_MESSAGES[status]).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------------------
// 6. Detail
// ---------------------------------------------------------------------------------------

describe('recorded detail', () => {
  it('flattens a writer’s object into key/value lines', () => {
    expect(auditDetailEntries({ role_id: 'role-7', role: 'Release manager' })).toEqual([
      { key: 'role_id', value: 'role-7' },
      { key: 'role', value: 'Release manager' },
    ]);
  });

  it('joins a list, and says `none` for an empty one', () => {
    // `permission.changed` writes `granted` and `revoked` as arrays; an empty one means
    // "nothing was revoked", which is information rather than an absence.
    expect(auditDetailEntries({ granted: ['a:b', 'c:d'], revoked: [] })).toEqual([
      { key: 'granted', value: 'a:b, c:d' },
      { key: 'revoked', value: 'none' },
    ]);
  });

  it('has nothing to say about an absent detail', () => {
    expect(auditDetailEntries(null)).toEqual([]);
    expect(auditDetailEntries(undefined)).toEqual([]);
    expect(auditDetailEntries('')).toEqual([]);
  });

  it('keeps a scalar detail rather than dropping it', () => {
    expect(auditDetailEntries('legacy string')).toEqual([
      { key: 'detail', value: 'legacy string' },
    ]);
  });

  it('finds the before → after pair a matrix edit records', () => {
    expect(auditChange({ granted: ['versions:publish'], revoked: ['versions:create'] })).toEqual({
      label: 'Permissions',
      before: 'versions:create',
      after: 'versions:publish',
    });
  });

  it('finds a from/to pair, and reports no change when there is none', () => {
    expect(auditChange({ from_role: 'Editor', to_role: 'Release manager' })).toEqual({
      label: 'Value',
      before: 'Editor',
      after: 'Release manager',
    });
    expect(auditChange({ role_id: 'role-7' })).toBeNull();
    expect(auditChange(null)).toBeNull();
  });

  it('serialises the whole entry, untruncated — the ticket’s second criterion', () => {
    const long = event({ detail: { permissions: Array.from({ length: 60 }, (_, i) => `r${i}:a`) } });
    const json = auditEventJson(long);
    expect(JSON.parse(json)).toEqual(long);
    expect(json).toContain('r59:a');
    expect(json).toContain('entry_hash');
    expect(json).not.toContain('…');
  });
});

// ---------------------------------------------------------------------------------------
// 7. The sentence
// ---------------------------------------------------------------------------------------

describe('the plain-English summary', () => {
  it('names the actor, what they did, to what, and where it came from', () => {
    expect(describeAuditEvent(event())).toBe(
      'ada@acme.io assigned a role to linus@acme.io from the web console.'
    );
  });

  it('has a phrase for every action the product writes', () => {
    const written = [
      'role.created',
      'role.deleted',
      'role.assigned',
      'permission.changed',
      'permission.denied',
      'member.invited',
      'member.invite_resent',
      'member.suspended',
      'member.reinstated',
      'member.offboarded',
      'admin.override',
      'style_guide.created',
      'style_guide.updated',
      'style_guide.deleted',
      'style_guide.rules_updated',
      'style_guide.custom_rules_updated',
      'style_guide.policy_updated',
      'style_guide.assigned',
      'style_guide.unassigned',
    ];
    for (const action of written) {
      // The fallback names the action; a real phrase does not.
      expect(describeAuditEvent(event({ action }))).not.toContain(`recorded ${action}`);
    }
  });

  it('names an action it does not know rather than inventing a sentence for it', () => {
    expect(describeAuditEvent(event({ action: 'quantum.entangled', target: 'a thing' }))).toBe(
      'ada@acme.io recorded quantum.entangled on a thing from the web console.'
    );
  });

  it('drops the target and the origin when the entry carries neither', () => {
    expect(
      describeAuditEvent(event({ action: 'admin.override', target: '', source: null }))
    ).toBe('ada@acme.io recorded a platform override.');
  });

  it('calls an actor-less entry `system`, which is what it is', () => {
    expect(auditActorLabel(event({ actor_label: null, actor_id: null }))).toBe('system');
    expect(auditActorLabel(event({ actor_label: null }))).toBe('usr-ada');
  });
});

// ---------------------------------------------------------------------------------------
// 8. Formatting
// ---------------------------------------------------------------------------------------

describe('timestamps', () => {
  it('draws the When column as the mockup spells it', () => {
    // Local time, so the shape is asserted rather than the hour — the suite runs in whatever
    // zone the machine is in.
    expect(formatAuditTimestamp('2026-08-15T09:41:07Z')).toMatch(
      /^[A-Z][a-z]{2} \d{1,2}, 2026, \d{2}:\d{2} [AP]M$/
    );
  });

  it('draws the drawer’s stamp to the second, in UTC, so it correlates with a server log', () => {
    expect(formatAuditExactTimestamp('2026-08-15T09:41:07Z')).toBe(
      'Aug 15, 2026, 09:41:07 AM UTC'
    );
  });

  it('says so rather than drawing “Invalid Date” or nothing', () => {
    expect(formatAuditTimestamp(null)).toBe(NO_VALUE);
    expect(formatAuditTimestamp('not a date')).toBe('not a date');
    expect(formatAuditExactTimestamp(undefined)).toBe(NO_VALUE);
  });

  it('measures “ago” in the coarse words a ledger wants', () => {
    const now = new Date('2026-08-15T12:00:00Z');
    expect(formatAuditRelative('2026-08-15T11:59:40Z', now)).toBe('just now');
    expect(formatAuditRelative('2026-08-15T11:00:00Z', now)).toBe('1 hour ago');
    expect(formatAuditRelative('2026-08-15T10:00:00Z', now)).toBe('2 hours ago');
    expect(formatAuditRelative('2026-08-12T12:00:00Z', now)).toBe('3 days ago');
    expect(formatAuditRelative('2026-06-15T12:00:00Z', now)).toBe('2 months ago');
    expect(formatAuditRelative('2024-08-15T12:00:00Z', now)).toBe('2 years ago');
    expect(formatAuditRelative(null, now)).toBe(NO_VALUE);
  });
});

// ---------------------------------------------------------------------------------------
// 9. The capped read
// ---------------------------------------------------------------------------------------

describe('the read note', () => {
  it('says nothing when the read was not capped', () => {
    expect(describeAuditRead(120, 1000, '30d')).toBe('');
  });

  it('says the ledger was truncated, and how to reach further back', () => {
    const note = describeAuditRead(1000, 1000, '30d');
    expect(note).toContain('most recent 1000 entries');
    expect(note).toContain('last 30 days');
    expect(note).toContain('Narrow the date range');
  });

  it('names the whole ledger when no range is in force', () => {
    expect(describeAuditRead(1000, 1000, 'all')).toContain('of the ledger');
  });
});
