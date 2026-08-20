/**
 * The rules behind the Sunset timeline (HIVE-8.2, #5328).
 *
 * `sunset-timeline-hive-redesign.test.tsx` mounts the screen and `sunset-timeline-css.test.ts`
 * pins the declarations; this holds the decisions, which are the half of this ticket that is
 * arithmetic over dates. A timeline is exactly the kind of drawing that quietly starts lying —
 * a marker one column to the left is still a plausible-looking chart — so every coordinate is
 * measured here against a frozen clock rather than eyeballed in a browser.
 *
 * What it pins, in the order the ticket's acceptance criteria list them:
 *
 *   1. **Timeline and table always agree.** Nothing is silently dropped: a row with no sunset
 *      date and a row outside the six-month window are *counted*, and the counts are in the
 *      sentence the card prints.
 *   2. **The status vocabulary matches the server**, through exactly one rename — REST's
 *      `announced` is this screen's `scheduled`, and that happens in one function that both
 *      the badge and the drawing read.
 *   3. **Each marker's label carries the UTC instant.**
 *   4. **The CSV is unchanged** — the same seven fields, the same quoting, the server's own
 *      status string, and the same file name.
 *
 * The clock is `2026-08-15T12:00:00Z` throughout, which is the instant the mockup is drawn
 * at: its four countdown chips read *past · 12 d · 46 d · 107 d*, and so do the ones computed
 * here.
 */

import {
  ALL_PROJECTS,
  CHIP_CHAR_WIDTH,
  CHIP_PAD_X,
  LANE_BASELINE,
  LANE_HEIGHT,
  PLOT_LEFT,
  PLOT_RIGHT,
  PLOT_TOP,
  SERVER_SCHEDULED_STATUS,
  SUNSET_CSV_FILENAME,
  SUNSET_CSV_HEADERS,
  SUNSET_STATUSES,
  SUNSET_WINDOW_MONTHS,
  VIEW_WIDTH,
  hasSunsetWarnings,
  parseSunsetInstant,
  sunsetChipLabel,
  sunsetCountdownLabel,
  sunsetCsv,
  sunsetDaysUntil,
  sunsetFootLabel,
  sunsetInstant,
  sunsetLifecycleLabel,
  sunsetMarkerDate,
  sunsetMarkerLabel,
  sunsetNote,
  sunsetProjectName,
  sunsetTimelineAriaLabel,
  sunsetTimelineLayout,
  sunsetTimelineStatus,
  sunsetTimelineSummary,
  sunsetWindow,
  sunsetX,
  type SunsetEntry,
} from '../src/app/components/ade/sunset/sunsetModel';
import { statusTone } from '../src/app/components/ui/statusVocabulary';

/** The instant the mockup is drawn at. */
const NOW = Date.parse('2026-08-15T12:00:00Z');

/** One row, with only the interesting fields spelled out. */
function entry(overrides: Partial<SunsetEntry> & Pick<SunsetEntry, 'revisionId'>): SunsetEntry {
  return {
    projectId: 'prj-orders',
    projectName: 'Orders Service',
    projectSlug: 'orders-service',
    versionLine: 'v1.4.x',
    sunsetDate: '2026-08-27T00:00:00Z',
    sunsetAt: '2026-08-27T00:00:00Z',
    timelineStatus: 'imminent',
    lifecyclePhase: 'deprecated',
    deprecationMessage: null,
    successorRevisionId: null,
    published: true,
    deprecationWarnings: [],
    ...overrides,
  };
}

/** The mockup's four rows. */
const ORDERS_PAST = entry({
  revisionId: 'rev-orders-12',
  versionLine: 'v1.2.x',
  sunsetDate: '2026-07-15T00:00:00Z',
  sunsetAt: '2026-07-15T00:00:00Z',
  timelineStatus: 'past',
  lifecyclePhase: 'sunset_reached',
  successorRevisionId: 'ver_2ab4d1e0',
  deprecationMessage: 'Removed GET /orders/legacy — requests now 410.',
});

const ORDERS_IMMINENT = entry({
  revisionId: 'rev-orders-14',
  successorRevisionId: 'ver_9cc01b77',
  deprecationWarnings: [
    {
      revisionId: 'rev-orders-14',
      message: '2 consumers still on this line — breaking removal of cart v1 endpoints.',
      migrationGuideUrl: 'https://guides.example.com/orders-v1',
    },
  ],
});

const PAYMENTS_SCHEDULED = entry({
  revisionId: 'rev-payments-22',
  projectId: 'prj-payments',
  projectName: 'Payments API',
  projectSlug: 'payments-api',
  versionLine: 'v2.2.x',
  sunsetDate: '2026-09-30T00:00:00Z',
  sunsetAt: '2026-09-30T00:00:00Z',
  timelineStatus: SERVER_SCHEDULED_STATUS,
  successorRevisionId: 'ver_4c8e1b09',
  deprecationMessage: 'Migrate to /payment-intents before sunset.',
});

const INVENTORY_SCHEDULED = entry({
  revisionId: 'rev-inventory-05',
  projectId: 'prj-inventory',
  projectName: 'Inventory Events',
  projectSlug: 'inventory-events',
  versionLine: 'v0.5.x',
  sunsetDate: '2026-11-30T00:00:00Z',
  sunsetAt: '2026-11-30T00:00:00Z',
  timelineStatus: SERVER_SCHEDULED_STATUS,
  deprecationMessage: 'No successor (end of life). Channel stock.v0 stops emitting.',
});

const MOCKUP_ROWS: SunsetEntry[] = [
  ORDERS_PAST,
  ORDERS_IMMINENT,
  PAYMENTS_SCHEDULED,
  INVENTORY_SCHEDULED,
];

/* -------------------------------------------------------------------------
   1. The status vocabulary, and its one rename
   ------------------------------------------------------------------------- */

describe('the status vocabulary', () => {
  it('keeps the server’s two urgent statuses exactly', () => {
    expect(sunsetTimelineStatus('past')).toBe('past');
    expect(sunsetTimelineStatus('imminent')).toBe('imminent');
  });

  it('renames the server’s third status to the one the legend and the table print', () => {
    // `revision_deprecation.sunset_timeline_fields` returns `announced`; the mockup, the
    // acceptance criteria and this screen all say `scheduled`.
    expect(SERVER_SCHEDULED_STATUS).toBe('announced');
    expect(sunsetTimelineStatus(SERVER_SCHEDULED_STATUS)).toBe('scheduled');
  });

  it('files anything it has not been told about under scheduled, never under an urgent one', () => {
    for (const unknown of ['', ' ', null, undefined, 'retired', 'ANNOUNCED']) {
      expect(sunsetTimelineStatus(unknown)).toBe('scheduled');
    }
  });

  it('is case- and space-insensitive, like the shared vocabulary it feeds', () => {
    expect(sunsetTimelineStatus(' Imminent ')).toBe('imminent');
    expect(sunsetTimelineStatus('PAST')).toBe('past');
  });

  it('resolves all three to a tone the shared vocabulary knows — none falls back to neutral by accident', () => {
    expect(SUNSET_STATUSES.map((status) => statusTone(status))).toEqual([
      'rose',
      'warn',
      'neutral',
    ]);
  });

  it('gives the server’s own spelling the same tone, so an unnormalised surface agrees', () => {
    expect(statusTone(SERVER_SCHEDULED_STATUS)).toBe(statusTone('scheduled'));
  });

  it('keeps the two lifecycle sentences the table has always printed', () => {
    expect(sunsetLifecycleLabel('sunset_reached')).toBe('Sunset reached (read-only / redirect)');
    expect(sunsetLifecycleLabel('deprecated')).toBe('Deprecated (migrate before sunset)');
    // Every other phase REST can return is the deprecated one.
    expect(sunsetLifecycleLabel('anything-else')).toBe('Deprecated (migrate before sunset)');
    expect(sunsetLifecycleLabel(null)).toBe('Deprecated (migrate before sunset)');
  });
});

/* -------------------------------------------------------------------------
   2. Reading a row
   ------------------------------------------------------------------------- */

describe('reading a row', () => {
  it('names a project by name, then slug, then id', () => {
    expect(sunsetProjectName(ORDERS_PAST)).toBe('Orders Service');
    expect(sunsetProjectName(entry({ revisionId: 'r', projectName: null }))).toBe('orders-service');
    expect(
      sunsetProjectName(entry({ revisionId: 'r', projectName: null, projectSlug: null }))
    ).toBe('prj-orders');
  });

  it('prefers the canonical instant over the calendar date, and reports absence honestly', () => {
    expect(sunsetInstant(ORDERS_IMMINENT)).toBe('2026-08-27T00:00:00Z');
    expect(
      sunsetInstant(entry({ revisionId: 'r', sunsetAt: null, sunsetDate: '2026-09-01' }))
    ).toBe('2026-09-01');
    expect(sunsetInstant(entry({ revisionId: 'r', sunsetAt: null, sunsetDate: null }))).toBeNull();
  });

  it('takes the note from the first structured warning, then the plain message', () => {
    expect(sunsetNote(ORDERS_IMMINENT)).toContain('2 consumers still on this line');
    expect(sunsetNote(PAYMENTS_SCHEDULED)).toBe('Migrate to /payment-intents before sunset.');
    expect(sunsetNote(entry({ revisionId: 'r' }))).toBeNull();
    // A warning with no message of its own does not shadow the deprecation message.
    expect(
      sunsetNote(
        entry({
          revisionId: 'r',
          deprecationMessage: 'the message',
          deprecationWarnings: [{ revisionId: 'r' }],
        })
      )
    ).toBe('the message');
  });

  it('raises the #507 banner only when a row actually carries a structured warning', () => {
    expect(hasSunsetWarnings(MOCKUP_ROWS)).toBe(true);
    expect(hasSunsetWarnings([ORDERS_PAST, PAYMENTS_SCHEDULED])).toBe(false);
    expect(hasSunsetWarnings([])).toBe(false);
  });

  it('counts entries in the table’s own words', () => {
    expect(sunsetFootLabel(0)).toBe('0 entries');
    expect(sunsetFootLabel(1)).toBe('1 entry');
    expect(sunsetFootLabel(4)).toBe('4 entries');
  });
});

/* -------------------------------------------------------------------------
   3. The clock
   ------------------------------------------------------------------------- */

describe('the clock', () => {
  it('reads a bare calendar date as midnight UTC, not as midnight local', () => {
    // A local reading would move a marker across a month boundary for a reader west of
    // Greenwich, and the whole screen states instants in UTC.
    expect(parseSunsetInstant('2026-09-30')).toBe(Date.parse('2026-09-30T00:00:00Z'));
    expect(parseSunsetInstant('2026-09-30T00:00:00Z')).toBe(Date.parse('2026-09-30T00:00:00Z'));
  });

  it('has no instant for an absent or unparseable value', () => {
    expect(parseSunsetInstant(null)).toBeNull();
    expect(parseSunsetInstant(undefined)).toBeNull();
    expect(parseSunsetInstant('   ')).toBeNull();
    expect(parseSunsetInstant('not a date')).toBeNull();
  });

  it('counts the mockup’s four countdowns exactly as the mockup prints them', () => {
    const days = (iso: string) => sunsetDaysUntil(Date.parse(iso), NOW);
    expect(days('2026-08-27T00:00:00Z')).toBe(12);
    expect(days('2026-09-30T00:00:00Z')).toBe(46);
    expect(days('2026-11-30T00:00:00Z')).toBe(107);
    expect(days('2026-07-15T00:00:00Z')).toBeLessThan(0);
  });

  it('rounds a partial day up, so a reader is never told they have less time than they do', () => {
    const thirtyHours = NOW + 30 * 60 * 60 * 1000;
    expect(sunsetDaysUntil(thirtyHours, NOW)).toBe(2);
  });

  it('says today on the day itself, and past once it has gone', () => {
    expect(sunsetCountdownLabel(0)).toBe('today');
    expect(sunsetCountdownLabel(-1)).toBe('past');
    expect(sunsetCountdownLabel(46)).toBe('46 d');
  });

  it('states a marker’s date in UTC', () => {
    expect(sunsetMarkerDate(Date.parse('2026-09-30T00:00:00Z'))).toBe('Sep 30');
    // 23:30 UTC on the 30th is the 1st in a +01:00 zone; the drawing must still say the 30th.
    expect(sunsetMarkerDate(Date.parse('2026-09-30T23:30:00Z'))).toBe('Sep 30');
  });
});

/* -------------------------------------------------------------------------
   4. The window
   ------------------------------------------------------------------------- */

describe('the six-month window', () => {
  const window = sunsetWindow(NOW);

  it('draws six month columns, one of them behind today', () => {
    expect(window.months).toHaveLength(SUNSET_WINDOW_MONTHS);
    expect(window.months.map((month) => month.fullLabel)).toEqual([
      'Jul 2026',
      'Aug 2026',
      'Sep 2026',
      'Oct 2026',
      'Nov 2026',
      'Dec 2026',
    ]);
  });

  it('carries the year on the first column only, as the mockup labels it', () => {
    expect(window.months.map((month) => month.label)).toEqual([
      'Jul 2026',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ]);
  });

  it('is aligned to UTC month boundaries, so every reader sees the same grid', () => {
    expect(window.start).toBe(Date.parse('2026-07-01T00:00:00Z'));
    expect(window.end).toBe(Date.parse('2027-01-01T00:00:00Z'));
  });

  it('crosses a year boundary without losing a month', () => {
    const december = sunsetWindow(Date.parse('2026-12-10T00:00:00Z'));
    expect(december.months.map((month) => month.fullLabel)).toEqual([
      'Nov 2026',
      'Dec 2026',
      'Jan 2027',
      'Feb 2027',
      'Mar 2027',
      'Apr 2027',
    ]);
  });

  it('places the first month at the plot’s left edge and the window’s end at its right', () => {
    expect(sunsetX(window.start, window)).toBe(PLOT_LEFT);
    expect(sunsetX(window.end, window)).toBe(PLOT_RIGHT);
  });

  it('places today where the mockup draws its rule', () => {
    // The mockup's today line is at x = 277 for 15 August.
    expect(Math.round(sunsetX(NOW, window))).toBe(277);
  });
});

/* -------------------------------------------------------------------------
   5. The layout
   ------------------------------------------------------------------------- */

describe('the layout', () => {
  const layout = sunsetTimelineLayout(MOCKUP_ROWS, NOW);

  it('draws one lane per project, alphabetically, however REST ordered the rows', () => {
    expect(layout.lanes.map((lane) => lane.name)).toEqual([
      'Inventory Events',
      'Orders Service',
      'Payments API',
    ]);
  });

  it('puts both of a project’s revisions on the one lane, earliest first', () => {
    const orders = layout.lanes.find((lane) => lane.name === 'Orders Service');
    expect(orders?.markers.map((marker) => marker.versionLine)).toEqual(['v1.2.x', 'v1.4.x']);
    expect(new Set(orders?.markers.map((marker) => marker.y)).size).toBe(1);
  });

  it('stacks the lanes on the geometry the module declares', () => {
    layout.lanes.forEach((lane, index) => {
      expect(lane.y).toBe(PLOT_TOP + index * LANE_HEIGHT + LANE_BASELINE);
      expect(lane.labelY).toBeLessThan(lane.y);
    });
  });

  it('grows the drawing with the number of lanes rather than clipping them', () => {
    const one = sunsetTimelineLayout([ORDERS_IMMINENT], NOW);
    expect(layout.width).toBe(VIEW_WIDTH);
    expect(one.width).toBe(VIEW_WIDTH);
    expect(layout.height).toBeGreaterThan(one.height);
    expect(layout.gridBottom).toBe(PLOT_TOP + 3 * LANE_HEIGHT + 12);
  });

  it('plots each marker at its own instant', () => {
    const window = layout.window;
    for (const lane of layout.lanes) {
      for (const marker of lane.markers) {
        expect(marker.x).toBeCloseTo(sunsetX(marker.instant, window), 6);
        expect(marker.x).toBeGreaterThanOrEqual(PLOT_LEFT);
        expect(marker.x).toBeLessThanOrEqual(PLOT_RIGHT);
      }
    }
  });

  it('normalises each marker’s status through the one rename', () => {
    const statuses = layout.lanes.flatMap((lane) =>
      lane.markers.map((marker) => [marker.versionLine, marker.status])
    );
    expect(Object.fromEntries(statuses)).toEqual({
      'v0.5.x': 'scheduled',
      'v1.2.x': 'past',
      'v1.4.x': 'imminent',
      'v2.2.x': 'scheduled',
    });
  });

  it('runs a connector from today only to sunsets that are still ahead', () => {
    const markers = layout.lanes.flatMap((lane) => lane.markers);
    const past = markers.find((marker) => marker.versionLine === 'v1.2.x');
    const ahead = markers.find((marker) => marker.versionLine === 'v1.4.x');
    expect(past?.connectorFromX).toBeNull();
    expect(ahead?.connectorFromX).toBeCloseTo(layout.today?.x ?? -1, 6);
  });

  it('prints the mockup’s own countdown chips', () => {
    const chips = layout.lanes.flatMap((lane) =>
      lane.markers.map((marker) => marker.chip.label)
    );
    expect(chips).toEqual(
      expect.arrayContaining(['v0.5.x · 107 d', 'v1.2.x · past', 'v1.4.x · 12 d', 'v2.2.x · 46 d'])
    );
  });

  it('keeps every chip inside the plot, flipping it to the marker’s left when it must', () => {
    for (const lane of layout.lanes) {
      for (const marker of lane.markers) {
        expect(marker.chip.x).toBeGreaterThanOrEqual(PLOT_LEFT);
        expect(marker.chip.x + marker.chip.width).toBeLessThanOrEqual(PLOT_RIGHT + 0.001);
      }
    }
  });

  it('flips a chip to the marker’s left when there is no room on its right', () => {
    // The last days of the window: placed to the right, the chip would leave the plot.
    const lateDecember = sunsetTimelineLayout(
      [
        entry({
          revisionId: 'rev-late',
          versionLine: 'v9.9.x',
          sunsetAt: '2026-12-30T00:00:00Z',
          sunsetDate: '2026-12-30T00:00:00Z',
          timelineStatus: SERVER_SCHEDULED_STATUS,
        }),
      ],
      NOW
    );
    const marker = lateDecember.lanes[0].markers[0];
    expect(marker.chip.x).toBeLessThan(marker.x);
    expect(marker.chip.x + marker.chip.width).toBeLessThanOrEqual(PLOT_RIGHT + 0.001);
  });

  it('sizes a chip from its own label, so a long version line does not overflow it', () => {
    const label = sunsetChipLabel('v1.4.x', 12);
    const width = label.length * CHIP_CHAR_WIDTH + CHIP_PAD_X * 2;
    const marker = layout.lanes
      .flatMap((lane) => lane.markers)
      .find((candidate) => candidate.versionLine === 'v1.4.x');
    expect(marker?.chip.width).toBeCloseTo(width, 6);
  });

  it('clips an over-long version line rather than letting a chip become a banner', () => {
    const label = sunsetChipLabel('v1.4.0-release-candidate-9', 12);
    expect(label).toBe('v1.4.0-releas… · 12 d');
  });

  it('gives every marker a label carrying the UTC instant and what it points at', () => {
    const marker = layout.lanes
      .flatMap((lane) => lane.markers)
      .find((candidate) => candidate.versionLine === 'v2.2.x');
    expect(marker?.label).toBe(
      'Payments API v2.2.x — sunset 30 Sep 2026 00:00 UTC (scheduled, in 46 days). Show this row in the table.'
    );
  });

  it('says a lone day in the singular, and a passed sunset as passed', () => {
    expect(
      sunsetMarkerLabel({
        projectName: 'Orders Service',
        versionLine: 'v1.4.x',
        instant: Date.parse('2026-08-16T00:00:00Z'),
        status: 'imminent',
        days: 1,
      })
    ).toContain('(imminent, in 1 day)');
    expect(
      sunsetMarkerLabel({
        projectName: 'Orders Service',
        versionLine: 'v1.2.x',
        instant: Date.parse('2026-07-15T00:00:00Z'),
        status: 'past',
        days: -31,
      })
    ).toContain('(past, already passed)');
  });
});

/* -------------------------------------------------------------------------
   6. The drawing can never say less than the table
   ------------------------------------------------------------------------- */

describe('the timeline and the table agree', () => {
  const UNDATED = entry({
    revisionId: 'rev-undated',
    projectId: 'prj-legacy',
    projectName: 'Legacy Feed',
    versionLine: 'v3.0.x',
    sunsetAt: null,
    sunsetDate: null,
    timelineStatus: SERVER_SCHEDULED_STATUS,
  });
  const LONG_AGO = entry({
    revisionId: 'rev-ancient',
    versionLine: 'v0.1.x',
    sunsetAt: '2024-01-01T00:00:00Z',
    sunsetDate: '2024-01-01T00:00:00Z',
    timelineStatus: 'past',
  });
  const FAR_OFF = entry({
    revisionId: 'rev-future',
    versionLine: 'v9.0.x',
    sunsetAt: '2028-06-01T00:00:00Z',
    sunsetDate: '2028-06-01T00:00:00Z',
    timelineStatus: SERVER_SCHEDULED_STATUS,
  });

  const rows = [...MOCKUP_ROWS, UNDATED, LONG_AGO, FAR_OFF];
  const layout = sunsetTimelineLayout(rows, NOW);

  it('counts what it could not plot instead of dropping it', () => {
    expect(layout.plotted).toBe(4);
    expect(layout.outsideBefore).toBe(1);
    expect(layout.outsideAfter).toBe(1);
    expect(layout.undated).toBe(1);
  });

  it('accounts for every single row the table is showing', () => {
    expect(layout.plotted + layout.outsideBefore + layout.outsideAfter + layout.undated).toBe(
      rows.length
    );
  });

  it('opens no lane for a project it could not plot anything for', () => {
    expect(layout.lanes.map((lane) => lane.name)).not.toContain('Legacy Feed');
  });

  it('never clamps an unplottable sunset onto an edge, which would claim a date it has not got', () => {
    const plotted = layout.lanes.flatMap((lane) => lane.markers).map((marker) => marker.revisionId);
    expect(plotted).not.toContain('rev-ancient');
    expect(plotted).not.toContain('rev-future');
    expect(plotted).not.toContain('rev-undated');
  });

  it('prints the counts, so the sentence is the reconciliation', () => {
    expect(sunsetTimelineSummary(layout, rows.length)).toBe(
      '4 of 7 entries on the timeline · 2 outside this six-month window · 1 with no sunset date · all of them in the table below.'
    );
  });

  it('says nothing about a window or a missing date when there is nothing to say', () => {
    const clean = sunsetTimelineLayout(MOCKUP_ROWS, NOW);
    expect(sunsetTimelineSummary(clean, MOCKUP_ROWS.length)).toBe(
      '4 of 4 entries on the timeline · all of them in the table below.'
    );
  });

  it('describes itself in one sentence naming the span it covers', () => {
    expect(sunsetTimelineAriaLabel(sunsetTimelineLayout(MOCKUP_ROWS, NOW))).toBe(
      'Sunset timeline: 4 sunsets across 3 projects, Jul 2026 to Dec 2026.'
    );
  });

  it('draws an empty grid rather than a collapsed one when nothing can be plotted', () => {
    const nothing = sunsetTimelineLayout([UNDATED], NOW);
    expect(nothing.lanes).toEqual([]);
    expect(nothing.plotted).toBe(0);
    expect(nothing.height).toBeGreaterThan(PLOT_TOP);
  });

  it('places today’s rule whenever the clock is in the window, which it is by construction', () => {
    expect(layout.today).not.toBeNull();
    expect(layout.today?.label).toBe('today');
  });
});

/* -------------------------------------------------------------------------
   7. The CSV, unchanged
   ------------------------------------------------------------------------- */

describe('the CSV export', () => {
  it('keeps the seven columns in the order the mockup’s table foot prints', () => {
    expect([...SUNSET_CSV_HEADERS]).toEqual([
      'project',
      'versionLine',
      'sunsetDate',
      'timelineStatus',
      'lifecyclePhase',
      'successorRevisionId',
      'deprecationMessage',
    ]);
    expect(SUNSET_CSV_FILENAME).toBe('sunset-timeline.csv');
  });

  it('writes the header and one line per row', () => {
    const lines = sunsetCsv(MOCKUP_ROWS).split('\n');
    expect(lines).toHaveLength(MOCKUP_ROWS.length + 1);
    expect(lines[0]).toBe(SUNSET_CSV_HEADERS.join(','));
  });

  it('exports the SERVER’s status string, not the renamed one', () => {
    // A spreadsheet built against `announced` must keep working: the rename is a UI word.
    const line = sunsetCsv([PAYMENTS_SCHEDULED]).split('\n')[1];
    expect(line).toContain('"announced"');
    expect(line).not.toContain('"scheduled"');
  });

  it('quotes every field, and writes an empty string where the API had nothing', () => {
    expect(sunsetCsv([INVENTORY_SCHEDULED]).split('\n')[1]).toBe(
      '"Inventory Events","v0.5.x","2026-11-30T00:00:00Z","announced","deprecated","","No successor (end of life). Channel stock.v0 stops emitting."'
    );
  });

  it('escapes a quote in a deprecation message rather than breaking the row', () => {
    const quoted = entry({
      revisionId: 'rev-quoted',
      deprecationMessage: 'Use the "v2" line instead.',
    });
    const lines = sunsetCsv([quoted]).split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('\\"v2\\"');
  });

  it('names the project the same way the table does', () => {
    const slugOnly = entry({ revisionId: 'r', projectName: null });
    expect(sunsetCsv([slugOnly]).split('\n')[1]).toContain('"orders-service"');
  });

  it('writes just the header for an empty schedule', () => {
    expect(sunsetCsv([])).toBe(SUNSET_CSV_HEADERS.join(','));
  });
});

/* -------------------------------------------------------------------------
   8. Odds and ends the screen leans on
   ------------------------------------------------------------------------- */

describe('the filter’s sentinel', () => {
  it('is not something a project id could ever be', () => {
    // The value goes straight into `?projectId=`, so a collision would silently filter.
    expect(ALL_PROJECTS).toBe('all');
    expect(MOCKUP_ROWS.map((row) => row.projectId)).not.toContain(ALL_PROJECTS);
  });
});
