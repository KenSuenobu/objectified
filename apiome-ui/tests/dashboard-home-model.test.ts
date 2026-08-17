/**
 * Home's two model layers (HIVE-4.6, #5300).
 *
 * `lib/db/dashboard-home-model.ts` is the database side's pure half: lifecycle precedence,
 * deadline arithmetic, attention ranking and week bucketing.
 * `src/app/components/ade/dashboard/home/homeModel.ts` is the page's: the six stats, the activity
 * vocabulary, the header sentence, the quick actions and the pulse's scaling.
 *
 * Everything here is deterministic against a fixed clock, which is the point of splitting these
 * two modules out of the page and the `'use server'` file — the parts most likely to be wrong
 * are the parts about *time*, and none of them need a database or a DOM to be exercised.
 */

import {
  ATTENTION_HREF,
  ATTENTION_LIMIT,
  KEY_EXPIRY_ATTENTION_DAYS,
  PULSE_WEEKS,
  PULSE_WINDOW_DAYS,
  SUNSET_ATTENTION_DAYS,
  bucketPublishesByWeek,
  daysUntil,
  deadlinePhrase,
  emptyDashboardHome,
  keyAttention,
  lintAttention,
  rankAttention,
  revisionStatus,
  sunsetAttention,
  sunsetInstantOf,
  weekStartOf,
  type AttentionItem,
  type KeyRow,
  type LintRow,
  type SunsetRow,
} from '@lib/db/dashboard-home-model';

import {
  ACTIVITY_LIMIT,
  EMPTY_STATS,
  PULSE_MIN_BAR_PERCENT,
  QUICK_ACTIONS,
  STAT_COUNT,
  activityPresentation,
  formatTimeAgo,
  formatWeekStart,
  pulseBars,
  pulseMonthTicks,
  pulseTotal,
  quickActionsFor,
  resolveStats,
  revisionMetaLine,
  statusWord,
  touchedPhrase,
  unpublishedVersionCount,
  workspaceSummarySentence,
  type DashboardStats,
} from '@/app/components/ade/dashboard/home/homeModel';

/** A Wednesday, so week bucketing has a non-zero offset to get wrong. */
const NOW = new Date('2026-08-12T15:30:00.000Z');

/** Build a stats payload from the columns a test cares about. */
function stats(overrides: Partial<DashboardStats> = {}): DashboardStats {
  return { ...EMPTY_STATS, ...overrides };
}

/* -------------------------------------------------------------------------
   Lifecycle
   ------------------------------------------------------------------------- */

describe('revisionStatus', () => {
  it('calls an unpublished revision a draft', () => {
    expect(revisionStatus({ published: false, metadata: {} }, NOW)).toBe('draft');
  });

  it('calls a published revision published', () => {
    expect(revisionStatus({ published: true, metadata: {} }, NOW)).toBe('published');
  });

  it('reads the beta lifecycle tag on an unpublished revision', () => {
    expect(revisionStatus({ published: false, metadata: { lifecycle: 'beta' } }, NOW)).toBe('beta');
  });

  it('prefers an explicit lifecycle tag over the published flag', () => {
    expect(revisionStatus({ published: true, metadata: { lifecycle: 'deprecated' } }, NOW)).toBe(
      'deprecated',
    );
    expect(revisionStatus({ published: true, metadata: { lifecycle: 'archived' } }, NOW)).toBe(
      'archived',
    );
  });

  it('infers deprecation from the legacy flag REST still writes', () => {
    expect(revisionStatus({ published: true, metadata: { deprecated: true } }, NOW)).toBe('deprecated');
  });

  it('infers deprecation from a future sunset, even with no tag', () => {
    expect(
      revisionStatus({ published: true, metadata: { sunsetAt: '2026-12-01T00:00:00Z' } }, NOW),
    ).toBe('deprecated');
  });

  it('promotes a reached sunset over the deprecation it implies', () => {
    // REST requires a sunset revision to be deprecated too, so both are true — the later of the
    // two states is the one worth printing.
    expect(
      revisionStatus(
        { published: true, metadata: { lifecycle: 'deprecated', sunsetAt: '2026-01-01T00:00:00Z' } },
        NOW,
      ),
    ).toBe('sunset');
  });

  it('ignores a sunset it cannot parse rather than guessing', () => {
    expect(revisionStatus({ published: true, metadata: { sunsetAt: 'soon' } }, NOW)).toBe('deprecated');
  });

  it('survives metadata that is not an object', () => {
    for (const metadata of [null, undefined, 'draft', 42, ['deprecated']]) {
      expect(revisionStatus({ published: false, metadata }, NOW)).toBe('draft');
    }
  });
});

describe('sunsetInstantOf', () => {
  it('reads each key REST writes, newest spelling first', () => {
    expect(sunsetInstantOf({ sunsetAt: '2026-12-01' })).toBe('2026-12-01');
    expect(sunsetInstantOf({ sunsetDate: '2026-12-02' })).toBe('2026-12-02');
    expect(sunsetInstantOf({ sunset_date: '2026-12-03' })).toBe('2026-12-03');
    expect(sunsetInstantOf({ sunsetAt: '2026-12-01', sunsetDate: '2026-12-09' })).toBe('2026-12-01');
  });

  it('treats a blank or absent value as no sunset', () => {
    expect(sunsetInstantOf({ sunsetAt: '   ' })).toBeNull();
    expect(sunsetInstantOf({})).toBeNull();
    expect(sunsetInstantOf(null)).toBeNull();
  });
});

/* -------------------------------------------------------------------------
   Deadlines
   ------------------------------------------------------------------------- */

describe('daysUntil', () => {
  it('counts whole days ahead', () => {
    expect(daysUntil('2026-08-22T15:30:00.000Z', NOW)).toBe(10);
  });

  it('does not count a partial day as a whole one, in either direction', () => {
    expect(daysUntil('2026-08-13T09:00:00.000Z', NOW)).toBe(0);
    expect(daysUntil('2026-08-12T02:00:00.000Z', NOW)).toBe(0);
  });

  it('goes negative once the deadline has passed', () => {
    expect(daysUntil('2026-08-09T15:30:00.000Z', NOW)).toBe(-3);
  });

  it('truncates towards zero, so a past deadline is not overstated by a day', () => {
    // 7.65 days ago. Flooring would report -8, i.e. "8 days ago".
    expect(daysUntil('2026-08-05T00:00:00.000Z', NOW)).toBe(-7);
  });

  it('returns null for a value it cannot parse', () => {
    expect(daysUntil('whenever', NOW)).toBeNull();
  });
});

describe('deadlinePhrase', () => {
  it('words each side of today', () => {
    expect(deadlinePhrase(12)).toBe('in 12 days');
    expect(deadlinePhrase(1)).toBe('tomorrow');
    expect(deadlinePhrase(0)).toBe('today');
    expect(deadlinePhrase(-1)).toBe('yesterday');
    expect(deadlinePhrase(-3)).toBe('3 days ago');
  });
});

/* -------------------------------------------------------------------------
   Needs attention
   ------------------------------------------------------------------------- */

/** A sunset row, with only the fields a test varies spelled out. */
function sunsetRow(overrides: Partial<SunsetRow> = {}): SunsetRow {
  return {
    versionRowId: 'v-1',
    versionLabel: 'v1.4.0',
    projectName: 'Orders Service',
    sunsetAt: '2026-08-24T00:00:00.000Z',
    published: true,
    ...overrides,
  };
}

describe('sunsetAttention', () => {
  it('names the project, the revision and the deadline', () => {
    const [item] = sunsetAttention([sunsetRow()], NOW);
    expect(item.title).toBe('Orders Service v1.4.0 sunsets in 11 days');
    expect(item.detail).toContain('Still published');
    expect(item.href).toBe(ATTENTION_HREF.sunset);
    expect(item.tone).toBe('warn');
    expect(item.urgency).toBe(11);
  });

  it('turns danger once the sunset has passed', () => {
    const [item] = sunsetAttention([sunsetRow({ sunsetAt: '2026-08-05T00:00:00.000Z' })], NOW);
    expect(item.tone).toBe('danger');
    expect(item.title).toContain('7 days ago');
    expect(item.urgency).toBeLessThan(0);
  });

  it('says so when nothing is consuming the revision', () => {
    const [item] = sunsetAttention([sunsetRow({ published: false })], NOW);
    expect(item.detail).toContain('no consumer is affected');
  });

  it('ignores a sunset beyond the attention window', () => {
    const far = new Date(NOW.getTime() + (SUNSET_ATTENTION_DAYS + 5) * 86_400_000).toISOString();
    expect(sunsetAttention([sunsetRow({ sunsetAt: far })], NOW)).toHaveLength(0);
  });

  it('includes a sunset exactly at the edge of the window', () => {
    const edge = new Date(NOW.getTime() + SUNSET_ATTENTION_DAYS * 86_400_000).toISOString();
    expect(sunsetAttention([sunsetRow({ sunsetAt: edge })], NOW)).toHaveLength(1);
  });

  it('drops a row whose sunset does not parse instead of showing "NaN days"', () => {
    expect(sunsetAttention([sunsetRow({ sunsetAt: 'someday' })], NOW)).toHaveLength(0);
  });
});

describe('lintAttention', () => {
  const row: LintRow = {
    versionRowId: 'v-9',
    versionLabel: 'v2.4.0',
    projectName: 'Payments API',
    errorCount: 4,
  };

  it('says how many findings block which revision', () => {
    const [item] = lintAttention([row]);
    expect(item.title).toBe('4 blocking lint findings on Payments API v2.4.0');
    expect(item.detail).toContain('publish gate');
    expect(item.href).toBe(ATTENTION_HREF.lint);
    expect(item.tone).toBe('danger');
  });

  it('singularises one finding', () => {
    const [item] = lintAttention([{ ...row, errorCount: 1 }]);
    expect(item.title).toBe('1 blocking lint finding on Payments API v2.4.0');
  });

  it('ranks a gated publish as due today, since it has no date of its own', () => {
    expect(lintAttention([row])[0].urgency).toBe(0);
  });
});

describe('keyAttention', () => {
  const row: KeyRow = {
    keyId: 'k-1',
    keyName: 'ci-deploy',
    tenantName: 'Acme Corp',
    expiresAt: '2026-08-15T00:00:00.000Z',
  };

  it('names the key and when it goes', () => {
    const [item] = keyAttention([row], NOW);
    expect(item.title).toBe('API key ci-deploy expires in 2 days');
    expect(item.detail).toContain('Acme Corp');
    expect(item.href).toBe(ATTENTION_HREF.key);
    expect(item.tone).toBe('warn');
  });

  it('switches to the past tense and to danger once it has expired', () => {
    const [item] = keyAttention([{ ...row, expiresAt: '2026-08-01T00:00:00.000Z' }], NOW);
    expect(item.title).toContain('expired');
    expect(item.detail).toContain('restore access');
    expect(item.tone).toBe('danger');
  });

  it('ignores an expiry beyond the attention window', () => {
    const far = new Date(NOW.getTime() + (KEY_EXPIRY_ATTENTION_DAYS + 3) * 86_400_000).toISOString();
    expect(keyAttention([{ ...row, expiresAt: far }], NOW)).toHaveLength(0);
  });
});

describe('rankAttention', () => {
  /** A bare item, for ordering assertions. */
  const item = (urgency: number, title: string): AttentionItem => ({
    id: title,
    kind: 'sunset',
    tone: 'warn',
    title,
    detail: '',
    href: '/x',
    urgency,
  });

  it('puts the most urgent first, regardless of which source it came from', () => {
    const ranked = rankAttention([
      [item(11, 'sunset in 11 days')],
      [item(0, 'lint gate')],
      [item(-2, 'key expired')],
    ]);
    expect(ranked.map((entry) => entry.title)).toEqual([
      'key expired',
      'lint gate',
      'sunset in 11 days',
    ]);
  });

  it('breaks ties by title, so the capped list does not change between renders', () => {
    const ranked = rankAttention([[item(3, 'beta'), item(3, 'alpha')]]);
    expect(ranked.map((entry) => entry.title)).toEqual(['alpha', 'beta']);
  });

  it('caps the list', () => {
    const many = Array.from({ length: ATTENTION_LIMIT + 4 }, (_, index) =>
      item(index, `item ${index}`),
    );
    expect(rankAttention([many])).toHaveLength(ATTENTION_LIMIT);
  });

  it('returns nothing for no sources', () => {
    expect(rankAttention([])).toEqual([]);
    expect(rankAttention([[], [], []])).toEqual([]);
  });
});

/* -------------------------------------------------------------------------
   Publishing pulse
   ------------------------------------------------------------------------- */

describe('weekStartOf', () => {
  it('resolves a mid-week day back to its Monday', () => {
    expect(weekStartOf(new Date('2026-08-12T15:30:00.000Z'))).toBe('2026-08-10');
  });

  it('leaves a Monday where it is', () => {
    expect(weekStartOf(new Date('2026-08-10T00:00:00.000Z'))).toBe('2026-08-10');
  });

  it('puts Sunday in the week that began six days earlier, not the one starting tomorrow', () => {
    expect(weekStartOf(new Date('2026-08-16T23:59:59.000Z'))).toBe('2026-08-10');
  });
});

describe('bucketPublishesByWeek', () => {
  it('returns a full window of buckets, oldest first, ending in this week', () => {
    const weeks = bucketPublishesByWeek([], NOW);
    expect(weeks).toHaveLength(PULSE_WEEKS);
    expect(weeks[weeks.length - 1].weekStart).toBe('2026-08-10');
    expect(weeks[0].weekStart).toBe('2026-05-25');
    expect(weeks.every((week) => week.count === 0)).toBe(true);
  });

  it('keeps empty weeks rather than closing the gaps up', () => {
    const weeks = bucketPublishesByWeek(['2026-08-11T09:00:00.000Z'], NOW);
    expect(weeks).toHaveLength(PULSE_WEEKS);
    expect(weeks[weeks.length - 1].count).toBe(1);
    expect(weeks.slice(0, -1).every((week) => week.count === 0)).toBe(true);
  });

  it('counts several publishes in one week together', () => {
    const weeks = bucketPublishesByWeek(
      ['2026-08-10T00:00:00.000Z', '2026-08-12T00:00:00.000Z', '2026-08-16T00:00:00.000Z'],
      NOW,
    );
    expect(weeks[weeks.length - 1].count).toBe(3);
  });

  it('drops an instant outside the window rather than clamping it into an edge bucket', () => {
    const before = new Date(NOW.getTime() - (PULSE_WINDOW_DAYS + 14) * 86_400_000).toISOString();
    const weeks = bucketPublishesByWeek([before], NOW);
    expect(weeks.reduce((total, week) => total + week.count, 0)).toBe(0);
  });

  it('ignores an unparseable instant', () => {
    const weeks = bucketPublishesByWeek(['not a date'], NOW);
    expect(weeks.reduce((total, week) => total + week.count, 0)).toBe(0);
  });
});

describe('pulseBars', () => {
  it('scales against the window own peak', () => {
    const bars = pulseBars([
      { weekStart: '2026-08-03', count: 5 },
      { weekStart: '2026-08-10', count: 10 },
    ]);
    expect(bars[1].percent).toBe(100);
    expect(bars[0].percent).toBe(50);
  });

  it('never draws a non-zero week shorter than the visible floor', () => {
    const bars = pulseBars([
      { weekStart: '2026-08-03', count: 1 },
      { weekStart: '2026-08-10', count: 200 },
    ]);
    expect(bars[0].percent).toBe(PULSE_MIN_BAR_PERCENT);
  });

  it('draws an empty week at zero, so it is visibly empty', () => {
    const bars = pulseBars([
      { weekStart: '2026-08-03', count: 0 },
      { weekStart: '2026-08-10', count: 4 },
    ]);
    expect(bars[0].percent).toBe(0);
  });

  it('draws an all-empty window flat rather than dividing by zero', () => {
    const bars = pulseBars([
      { weekStart: '2026-08-03', count: 0 },
      { weekStart: '2026-08-10', count: 0 },
    ]);
    expect(bars.every((bar) => bar.percent === 0)).toBe(true);
  });

  it('labels each bar with its week and count', () => {
    const [bar] = pulseBars([{ weekStart: '2026-08-10', count: 3 }]);
    expect(bar.label).toBe('Week of 10 Aug: 3 published');
  });
});

describe('pulseTotal, pulseMonthTicks and formatWeekStart', () => {
  it('sums the window', () => {
    expect(
      pulseTotal([
        { weekStart: '2026-08-03', count: 2 },
        { weekStart: '2026-08-10', count: 5 },
      ]),
    ).toBe(7);
  });

  it('gives one tick per month the window touches, in order', () => {
    expect(
      pulseMonthTicks([
        { weekStart: '2026-07-27', count: 0 },
        { weekStart: '2026-08-03', count: 0 },
        { weekStart: '2026-08-10', count: 0 },
        { weekStart: '2026-09-07', count: 0 },
      ]),
    ).toEqual(['Jul', 'Aug', 'Sep']);
  });

  it('formats a bucket start from its UTC parts', () => {
    expect(formatWeekStart('2026-08-10')).toBe('10 Aug');
    expect(formatWeekStart('nope')).toBe('nope');
  });
});

/* -------------------------------------------------------------------------
   The six stats — the ticket's first acceptance criterion
   ------------------------------------------------------------------------- */

describe('resolveStats', () => {
  const payload = stats({
    total_tenants: 3,
    admin_tenants: 2,
    total_projects: 3,
    created_projects: 3,
    total_versions: 14,
    created_versions: 9,
    published_versions: 5,
    total_classes: 128,
    total_properties: 1042,
    total_class_properties: 962,
  });

  it('is six stats, in the mockup order', () => {
    expect(resolveStats(payload).map((stat) => stat.label)).toEqual([
      'Tenants',
      'Projects',
      'Versions',
      'Published',
      'Classes',
      'Properties',
    ]);
    expect(STAT_COUNT).toBe(6);
  });

  it('keeps every subtitle the pre-redesign strip showed', () => {
    const subtitles = Object.fromEntries(
      resolveStats(payload).map((stat) => [stat.label, stat.subtitle]),
    );
    expect(subtitles).toEqual({
      Tenants: '2 admin',
      Projects: '3 created',
      Versions: '9 created',
      Published: '9 drafts',
      Classes: 'schema definitions',
      Properties: '962 in classes',
    });
  });

  it('singularises a single draft', () => {
    const single = resolveStats(stats({ total_versions: 2, published_versions: 1 }));
    expect(single.find((stat) => stat.label === 'Published')?.subtitle).toBe('1 draft');
  });

  it('states the published figure against the total, and omits the unit when there is none', () => {
    expect(resolveStats(payload).find((stat) => stat.label === 'Published')?.unit).toBe('of 14');
    expect(resolveStats(stats()).find((stat) => stat.label === 'Published')?.unit).toBeUndefined();
  });

  it('never reports a negative draft count', () => {
    expect(unpublishedVersionCount(stats({ total_versions: 1, published_versions: 4 }))).toBe(0);
  });
});

/* -------------------------------------------------------------------------
   The header sentence
   ------------------------------------------------------------------------- */

describe('workspaceSummarySentence', () => {
  it('describes what is moving', () => {
    expect(
      workspaceSummarySentence(stats({ total_projects: 3, total_versions: 14, published_versions: 2 })),
    ).toBe("Here's what's moving across your workspace. 3 projects, 14 versions, 2 published.");
  });

  it('singularises', () => {
    expect(
      workspaceSummarySentence(stats({ total_projects: 1, total_versions: 1, published_versions: 0 })),
    ).toContain('1 project, 1 version, 0 published');
  });

  it('invites a first-run reader instead of reciting zeroes', () => {
    expect(workspaceSummarySentence(stats())).toContain('Nothing here yet');
  });
});

/* -------------------------------------------------------------------------
   Activity vocabulary
   ------------------------------------------------------------------------- */

describe('activityPresentation', () => {
  it('gives each of the four kinds its own verb, tone and badge', () => {
    expect(activityPresentation('project')).toMatchObject({ label: 'Created project', tone: 'violet', badge: 'project' });
    expect(activityPresentation('version')).toMatchObject({ label: 'Created version', tone: 'ok', badge: 'version' });
    expect(activityPresentation('class')).toMatchObject({ label: 'Created class', tone: 'accent', badge: 'class' });
    expect(activityPresentation('property')).toMatchObject({ label: 'Created property', tone: 'warn', badge: 'property' });
  });

  it('still renders a kind it does not know', () => {
    expect(activityPresentation('wormhole')).toMatchObject({ label: 'Activity', tone: 'neutral' });
  });

  it('asks for ten rows, as the mockup fixes', () => {
    expect(ACTIVITY_LIMIT).toBe(10);
  });
});

describe('formatTimeAgo', () => {
  it('words each step of the scale exactly as the pre-redesign list did', () => {
    const at = (ms: number) => formatTimeAgo(new Date(NOW.getTime() - ms).toISOString(), NOW);
    expect(at(5_000)).toBe('just now');
    expect(at(60_000)).toBe('1 minute ago');
    expect(at(5 * 60_000)).toBe('5 minutes ago');
    expect(at(60 * 60_000)).toBe('1 hour ago');
    expect(at(3 * 60 * 60_000)).toBe('3 hours ago');
    expect(at(24 * 60 * 60_000)).toBe('1 day ago');
    expect(at(3 * 24 * 60 * 60_000)).toBe('3 days ago');
    expect(at(45 * 24 * 60 * 60_000)).toBe('1 month ago');
    expect(at(400 * 24 * 60 * 60_000)).toBe('1 year ago');
  });
});

/* -------------------------------------------------------------------------
   Cards, quick actions and status words
   ------------------------------------------------------------------------- */

describe('the continue card copy', () => {
  it('words a publish and an edit differently', () => {
    const instant = new Date(NOW.getTime() - 2 * 60 * 60_000).toISOString();
    expect(touchedPhrase('edited', instant, NOW)).toBe('Edited 2 hours ago');
    expect(touchedPhrase('published', instant, NOW)).toBe('Published 2 hours ago');
  });

  it('states the revision and what is in it', () => {
    expect(revisionMetaLine('v2.4.0', 18, 42)).toBe('v2.4.0 · 18 classes · 42 properties');
  });

  it('singularises both counts', () => {
    expect(revisionMetaLine('v1.0.0', 1, 1)).toBe('v1.0.0 · 1 class · 1 property');
  });

  it('says so when a project has no revision yet', () => {
    expect(revisionMetaLine(null, 0, 0)).toContain('No versions yet');
  });
});

describe('statusWord', () => {
  it('title-cases every lifecycle string the model emits', () => {
    expect(statusWord('draft')).toBe('Draft');
    expect(statusWord('published')).toBe('Published');
    expect(statusWord('deprecated')).toBe('Deprecated');
    expect(statusWord('sunset')).toBe('Sunset');
    expect(statusWord('archived')).toBe('Archived');
    expect(statusWord('beta')).toBe('Beta');
  });

  it('shows an unknown state as itself rather than dropping it', () => {
    expect(statusWord('quarantined')).toBe('quarantined');
  });
});

describe('quickActionsFor', () => {
  it('offers every action to a reader in a workspace', () => {
    expect(quickActionsFor(true)).toHaveLength(QUICK_ACTIONS.length);
  });

  it('withholds the workspace-scoped actions from a reader with none', () => {
    const actions = quickActionsFor(false);
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((action) => !action.requiresTenant)).toBe(true);
  });

  it('uses the shared open-action seam rather than routes of its own', () => {
    const byId = Object.fromEntries(QUICK_ACTIONS.map((action) => [action.id, action.href]));
    expect(byId['import-spec']).toBe('/ade/dashboard/projects?open=import-spec');
    expect(byId['new-api-key']).toBe('/ade/dashboard/api-keys?open=new-api-key');
  });

  it('points every action at an /ade/dashboard route', () => {
    for (const action of QUICK_ACTIONS) {
      expect(action.href.startsWith('/ade/dashboard/')).toBe(true);
    }
  });
});

describe('emptyDashboardHome', () => {
  it('is empty, and a fresh object each call so one caller cannot mutate the next', () => {
    const first = emptyDashboardHome();
    const second = emptyDashboardHome();
    expect(first).toEqual({ workspaceName: null, continueProjects: [], attention: [], pulse: [] });
    expect(first.continueProjects).not.toBe(second.continueProjects);
  });
});
