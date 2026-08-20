/**
 * The rules the Sunset timeline runs on (HIVE-8.2, #5328).
 *
 * Authority: `docs/mockups/ship/sunset-timeline.html`, whose **Notes → Keeps (1:1)** list is
 * this ticket's acceptance criteria, and `docs/mockups/DESIGN.md` §3.1 (status vocabulary),
 * §5.3 (page header) and §8 (list page).
 *
 * ### What this ticket is, and is not
 *
 * The table and its CSV export are the *source of truth* and are kept exactly: the same seven
 * columns, the same seven CSV fields in the same order, the same file name. What the ticket
 * adds is a horizontal SVG timeline above them. So the one rule every function here serves is
 * that **the drawing can never say something the table does not** — which is why the layout
 * below reports what it could *not* plot ({@link SunsetTimelineLayout.undated},
 * `outsideBefore`, `outsideAfter`) rather than quietly dropping those entries, and why the
 * card's footer sentence names the counts.
 *
 * ### The status vocabulary, and the one place it is normalised
 *
 * REST answers with three strings — `announced`, `imminent`, `past` (see
 * `apiome-rest/src/app/revision_deprecation.py::sunset_timeline_fields`) — and the mockup, the
 * legend and the acceptance criteria all name the third one **`scheduled`**. That is a
 * rename, not a second vocabulary: {@link sunsetTimelineStatus} is the *only* place it
 * happens, and both the timeline and the table's badge read through it, so the two can never
 * disagree about a row. An unrecognised string also lands on `scheduled`, which is the honest
 * answer for "the server has told us about a sunset and has not called it urgent".
 *
 * ### Why a model file
 *
 * The 333-line screen this replaces decided everything inline: it spelled four Tailwind
 * palette strings for the badge in a `switch`, built the CSV in a `useCallback` beside the
 * `Blob`, and had no geometry at all to test because there was no drawing. The timeline's
 * geometry is exactly the kind of thing that must not live in JSX — it is arithmetic over
 * dates, and arithmetic over dates is where a chart quietly starts lying. Everything here is
 * a pure function over plain data and a clock, so every coordinate is unit tested without
 * rendering an SVG.
 *
 * There is deliberately no colour and no class name in this file: a tone is looked up from
 * `ui/statusVocabulary` by the component that paints it.
 *
 * @see `./SunsetTimelineChart.tsx` — the drawing these coordinates feed.
 * @see `./SunsetTable.tsx` — the table, unchanged in substance.
 * @see `../versions/versionsModel.ts` — `formatSunsetUtc`, shared with the deprecation banner.
 */

import { formatSunsetUtc } from '../versions/versionsModel';

// ---------------------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------------------

/** One structured deprecation warning, as `warnings_for_revision` emits it (#507). */
export interface SunsetDeprecationWarning {
  revisionId?: string;
  message?: string;
  migrationGuideUrl?: string;
  sunsetDate?: string | null;
}

/**
 * One row of `GET /v1/versions/{tenant}/sunset-timeline` (#508).
 *
 * Field names are the REST serialisation aliases, so this is the payload shape exactly.
 */
export interface SunsetEntry {
  revisionId: string;
  projectId: string;
  projectName?: string | null;
  projectSlug?: string | null;
  versionLine: string;
  sunsetDate?: string | null;
  /** Canonical UTC instant (#748); the same value as `sunsetDate` when present. */
  sunsetAt?: string | null;
  timelineStatus: string;
  lifecyclePhase: string;
  deprecationMessage?: string | null;
  successorRevisionId?: string | null;
  published: boolean;
  deprecationWarnings: SunsetDeprecationWarning[];
}

/** One project, as `/api/projects` returns it — the filter's options. */
export interface SunsetProject {
  id: string;
  name: string;
  slug: string;
}

// ---------------------------------------------------------------------------------------
// Routes and copy
// ---------------------------------------------------------------------------------------

/** The breadcrumb's first crumb. */
export const HOME_HREF = '/ade/dashboard';

/** Where the banner and the card's footer send a reader who wants to *change* a schedule. */
export const VERSIONS_HREF = '/ade/dashboard/versions';

// There is deliberately no `PROJECTS_HREF`. The screen this replaces opened with a
// "← Back to Projects" link above its title; under the Hive shell that job belongs to the
// breadcrumb (`DESIGN.md` §5.3), which the mockup draws as *Acme Corp › Ship › Sunset
// timeline* — so a second back affordance would be a second answer to one question.

/** The filter's "no project chosen" value. Not a project id, so it can never collide. */
export const ALL_PROJECTS = 'all';

/**
 * The `#507` banner, shown only when at least one row carries a structured warning.
 *
 * Three parts rather than one sentence because the middle one is a link, and a sentence
 * assembled at the call site with `String.replace` is a sentence that silently loses its
 * second half the day somebody edits a word.
 */
export const SUNSET_WARNINGS_BANNER = {
  lead: 'Rows include the same structured warnings as compatibility checks (#507). Open a revision in',
  linkLabel: 'Versions',
  tail: 'to see banners in context.',
} as const;

/** What the table says while the first read is in flight. */
export const SUNSET_LOADING_LABEL = 'Loading schedule…';

/** What the table says when the read failed. */
export const SUNSET_LOAD_ERROR = 'Could not load the sunset schedule';

/** The empty state, kept word for word from the screen this replaces. */
export const SUNSET_EMPTY = {
  title: 'No deprecation or sunset entries',
  description:
    'Mark revisions as deprecated or set a sunset date on revision metadata to see them here.',
  actionLabel: 'Go to Versions',
} as const;

/** The state a reader in no workspace gets. */
export const SUNSET_NO_TENANT = {
  title: 'No tenant selected',
  description: 'Deprecation and sunset dates belong to one workspace.',
} as const;

/** What a signed-out reader is told. */
export const SUNSET_SIGNED_OUT = 'Sign in to view the sunset timeline.';

// ---------------------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------------------

/**
 * The three statuses this screen speaks, in legend order.
 *
 * Also the tone lookup keys: `ui/statusVocabulary` carries all three (`past` → rose,
 * `imminent` → warn, `scheduled` → neutral), so nothing here names a colour.
 */
export const SUNSET_STATUSES = ['past', 'imminent', 'scheduled'] as const;

/** One of {@link SUNSET_STATUSES}. */
export type SunsetStatus = (typeof SUNSET_STATUSES)[number];

/** The server's own third spelling, which this screen renames. */
export const SERVER_SCHEDULED_STATUS = 'announced';

/**
 * The status a row is drawn as, from whatever the server called it.
 *
 * The single normalisation point described in this module's header: `announced` — and any
 * string the vocabulary has not been told about — becomes `scheduled`.
 *
 * @param raw The server's `timelineStatus`.
 * @returns One of {@link SUNSET_STATUSES}.
 */
export function sunsetTimelineStatus(raw: string | null | undefined): SunsetStatus {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === 'past') return 'past';
  if (value === 'imminent') return 'imminent';
  return 'scheduled';
}

/** How the legend names each status — the mockup's wording. */
export const SUNSET_STATUS_LEGEND: Readonly<Record<SunsetStatus, string>> = {
  past: 'past',
  imminent: 'imminent (≤ 30 days)',
  scheduled: 'scheduled',
};

/** The two lifecycle phases REST reports, spelled as the table prints them. */
export const SUNSET_LIFECYCLE_LABEL: Readonly<Record<string, string>> = {
  sunset_reached: 'Sunset reached (read-only / redirect)',
  deprecated: 'Deprecated (migrate before sunset)',
};

/**
 * The Lifecycle cell.
 *
 * @param phase The server's `lifecyclePhase`.
 * @returns The sentence, defaulting to the deprecated one — which is what REST returns for
 *   every phase but `sunset_reached`.
 */
export function sunsetLifecycleLabel(phase: string | null | undefined): string {
  return SUNSET_LIFECYCLE_LABEL[phase ?? ''] ?? SUNSET_LIFECYCLE_LABEL.deprecated;
}

// ---------------------------------------------------------------------------------------
// Row-level reads
// ---------------------------------------------------------------------------------------

/**
 * What a row's project is called, with the two fallbacks the screen has always used.
 *
 * @param entry The row.
 * @returns The project name, its slug, or — when REST joined neither — its id.
 */
export function sunsetProjectName(entry: SunsetEntry): string {
  return entry.projectName ?? entry.projectSlug ?? entry.projectId;
}

/**
 * The raw sunset instant as the Sunset column prints it.
 *
 * Deliberately the stored string rather than a formatted one: the column is the reader's
 * check against the API, and the mockup prints `2026-07-15T00:00:00Z` in it. The *spoken*
 * form lives in {@link sunsetMarkerLabel}, which is the same instant said in words.
 *
 * @param entry The row.
 * @returns The instant, or `null` when the revision is deprecated with no sunset date.
 */
export function sunsetInstant(entry: SunsetEntry): string | null {
  return entry.sunsetAt ?? entry.sunsetDate ?? null;
}

/**
 * The row's note — the first structured warning, else the plain deprecation message.
 *
 * @param entry The row.
 * @returns The note, or `null` when the revision carries neither.
 */
export function sunsetNote(entry: SunsetEntry): string | null {
  const warning = entry.deprecationWarnings?.[0]?.message;
  if (typeof warning === 'string' && warning.trim()) return warning;
  const message = entry.deprecationMessage;
  return typeof message === 'string' && message.trim() ? message : null;
}

/**
 * Whether any row carries a structured warning — the gate on the `#507` banner.
 *
 * @param entries The rows.
 * @returns `true` when at least one row has one.
 */
export function hasSunsetWarnings(entries: readonly SunsetEntry[]): boolean {
  return entries.some((entry) => (entry.deprecationWarnings?.length ?? 0) > 0);
}

// ---------------------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------------------

/** Milliseconds in a day — the unit every countdown below is stated in. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Parse a stored sunset value into an instant.
 *
 * REST stores either a full ISO instant (`2026-09-30T00:00:00Z`, #748) or a bare calendar
 * date (`2026-09-30`). A bare date is read as **midnight UTC**, not as midnight local: the
 * whole screen states instants in UTC, and reading it locally would move a marker across a
 * month boundary for a reader west of Greenwich.
 *
 * @param value The stored `sunsetAt` / `sunsetDate`.
 * @returns The instant in epoch milliseconds, or `null` when there is none or it will not parse.
 */
export function parseSunsetInstant(value: string | null | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T00:00:00Z` : trimmed;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Whole days from now until a sunset.
 *
 * Rounded *up*, so a sunset 30 hours away reads "2 d" rather than "1 d" — a countdown that
 * rounds down tells a reader they have less time than they do only on the last day, and more
 * than they do on every other one.
 *
 * @param instant The sunset, in epoch milliseconds.
 * @param now The clock, in epoch milliseconds.
 * @returns Days remaining; negative once the instant has passed, `0` on the day itself.
 */
export function sunsetDaysUntil(instant: number, now: number): number {
  return Math.ceil((instant - now) / DAY_MS);
}

/**
 * The countdown a marker's chip carries — `46 d`, `today`, `past`.
 *
 * @param days The result of {@link sunsetDaysUntil}.
 * @returns The chip's trailing phrase.
 */
export function sunsetCountdownLabel(days: number): string {
  if (days < 0) return 'past';
  if (days === 0) return 'today';
  return `${days} d`;
}

// ---------------------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------------------

/** How many month columns the grid draws. The mockup's Jul → Dec. */
export const SUNSET_WINDOW_MONTHS = 6;

/**
 * How many of those months are behind the current one.
 *
 * One, which is what the mockup draws: today sits in **August** and the grid starts at
 * **July**. A window that began at today would push every recently-passed sunset off the
 * left edge — and "past" is one of the three statuses this screen exists to show.
 */
export const SUNSET_WINDOW_MONTHS_BEHIND = 1;

/** One month column of the grid. */
export interface SunsetMonth {
  /** First instant of the month, epoch milliseconds — where its gridline is drawn. */
  startsAt: number;
  /** `Jul 2026` for the first column, `Aug` for the rest. The mockup's labelling. */
  label: string;
  /** The full `Jul 2026`, for the drawing's accessible description. */
  fullLabel: string;
}

/** The span the grid covers, and the columns inside it. */
export interface SunsetWindow {
  /** First instant in the window, epoch milliseconds. */
  start: number;
  /** First instant *after* the window, epoch milliseconds. */
  end: number;
  /** The six month columns, earliest first. */
  months: SunsetMonth[];
}

/**
 * The month column labels — short everywhere but the first, which carries the year.
 *
 * @param date The month's first instant.
 * @param withYear Whether to append the year.
 * @returns `Jul 2026` or `Aug`.
 */
function monthLabel(date: Date, withYear: boolean): string {
  const month = date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  return withYear ? `${month} ${date.getUTCFullYear()}` : month;
}

/**
 * The six-month window around a clock.
 *
 * Aligned to UTC month boundaries, so the grid is the same for every reader and the columns
 * are the months the sunset dates are actually stated in.
 *
 * @param now The clock, in epoch milliseconds.
 * @returns The window and its columns.
 */
export function sunsetWindow(now: number): SunsetWindow {
  const today = new Date(now);
  const firstMonth = Date.UTC(
    today.getUTCFullYear(),
    today.getUTCMonth() - SUNSET_WINDOW_MONTHS_BEHIND,
    1
  );
  const start = new Date(firstMonth);
  const months: SunsetMonth[] = [];
  for (let index = 0; index < SUNSET_WINDOW_MONTHS; index += 1) {
    const at = new Date(
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + index, 1)
    );
    months.push({
      startsAt: at.getTime(),
      label: monthLabel(at, index === 0),
      fullLabel: monthLabel(at, true),
    });
  }
  const end = Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + SUNSET_WINDOW_MONTHS, 1);
  return { start: firstMonth, end, months };
}

// ---------------------------------------------------------------------------------------
// The geometry
// ---------------------------------------------------------------------------------------
//
// Every constant below is in **SVG user units**, not pixels: the drawing lives under a
// `viewBox` and is scaled by the browser, so what has to stay fixed is the *proportion*
// between a marker and the lane around it. DESIGN.md §3.2's "keep px only where it is
// genuinely physical … canvas geometry" is this case, and `ui/svgTypography` is the same
// exemption for the text.

/** The drawing's width in user units. The mockup's `viewBox`. */
export const VIEW_WIDTH = 1000;

/** Where the first month's gridline sits — the gutter the lane names are written in. */
export const PLOT_LEFT = 40;

/** Where the last month ends. */
export const PLOT_RIGHT = VIEW_WIDTH;

/** Top of the gridlines; the month labels sit above it. */
export const PLOT_TOP = 26;

/** The baseline of the month labels. */
export const MONTH_LABEL_Y = 16;

/** One lane's height. */
export const LANE_HEIGHT = 64;

/** A lane's marker line, measured from the top of the lane. */
export const LANE_BASELINE = 50;

/** The project name, relative to the lane's baseline. */
export const LANE_LABEL_DY = -18;

/** The date under a marker, relative to the lane's baseline. */
export const MARKER_DATE_DY = 24;

/** Half a diamond's diagonal. */
export const MARKER_RADIUS = 8;

/** Room under the last lane for its date labels. */
export const PLOT_BOTTOM_PAD = 12;

/** The today chip's height, and the room the drawing keeps for it under the grid. */
export const TODAY_CHIP_HEIGHT = 18;

/** The gap between the gridlines' foot and the today chip. */
export const TODAY_CHIP_GAP = 4;

/** The countdown chip's height. */
export const CHIP_HEIGHT = 22;

/** Padding either side of a countdown chip's text. */
export const CHIP_PAD_X = 8;

/**
 * The advance width of one character of the chip's label, in user units.
 *
 * The chips are drawn in the mono stack at {@link import('../../ui/svgTypography').SVG_TEXT_SIZE}`.body`,
 * whose advance is a constant fraction of the size — that is what *mono* means — so a chip's
 * width is arithmetic rather than a measurement. It has to be: SVG has no intrinsic sizing,
 * and a `<rect>` cannot ask the `<text>` inside it how wide it turned out. The label is
 * bounded by {@link sunsetChipLabel}, so the estimate never has to hold for an arbitrary
 * string.
 */
export const CHIP_CHAR_WIDTH = 6.9;

/** The gap between a marker and its chip. */
export const CHIP_GAP = 10;

/** Longest version label a chip prints before it is clipped. */
export const CHIP_VERSION_MAX = 14;

/**
 * The chip's text — `v2.2.x · 46 d`.
 *
 * @param versionLine The row's version line.
 * @param days Days until the sunset.
 * @returns The label, with an over-long version line clipped so the chip stays a chip.
 */
export function sunsetChipLabel(versionLine: string, days: number): string {
  const line = versionLine.length > CHIP_VERSION_MAX
    ? `${versionLine.slice(0, CHIP_VERSION_MAX - 1)}…`
    : versionLine;
  return `${line} · ${sunsetCountdownLabel(days)}`;
}

/**
 * The date a marker is annotated with — `Sep 30`, in UTC.
 *
 * @param instant The sunset, in epoch milliseconds.
 * @returns The short date.
 */
export function sunsetMarkerDate(instant: number): string {
  const date = new Date(instant);
  const month = date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  return `${month} ${date.getUTCDate()}`;
}

/** One plotted sunset. */
export interface SunsetMarker {
  /** The revision this marker is, which is also the table row it points at. */
  revisionId: string;
  /** The row's version line. */
  versionLine: string;
  /** The project it belongs to, as the lane label spells it. */
  projectName: string;
  /** The normalised status — the tone, and the third of the legend it belongs to. */
  status: SunsetStatus;
  /** The sunset, in epoch milliseconds. */
  instant: number;
  /** Days until it; negative once passed. */
  days: number;
  /** The marker's centre. */
  x: number;
  y: number;
  /** Where the connector from *today* starts, or `null` for a sunset already passed. */
  connectorFromX: number | null;
  /** The countdown chip. */
  chip: { x: number; y: number; width: number; label: string };
  /** The short date under the marker, and where it is centred. */
  date: { x: number; y: number; label: string };
  /** What a screen reader is told, and what the native tooltip says. */
  label: string;
}

/** One project's row in the drawing. */
export interface SunsetLane {
  /** The project id, or its display name when REST joined no id. */
  key: string;
  /** The lane label. */
  name: string;
  /** The lane's marker baseline. */
  y: number;
  /** Where the label is written. */
  labelY: number;
  /** The sunsets on it, earliest first. */
  markers: SunsetMarker[];
}

/** Everything the drawing needs, and everything it could not draw. */
export interface SunsetTimelineLayout {
  /** The `viewBox` width. */
  width: number;
  /** The `viewBox` height, which follows from the number of lanes. */
  height: number;
  /** The window the grid covers. */
  window: SunsetWindow;
  /** The month gridlines, with the x each is drawn at. */
  months: Array<SunsetMonth & { x: number }>;
  /** The gridlines' foot. */
  gridBottom: number;
  /** Today's rule, or `null` when the clock is somehow outside its own window. */
  today: { x: number; label: string } | null;
  /** One lane per project that has at least one plotted sunset. */
  lanes: SunsetLane[];
  /** How many sunsets were drawn. */
  plotted: number;
  /** Rows whose sunset is before the window. */
  outsideBefore: number;
  /** Rows whose sunset is after it. */
  outsideAfter: number;
  /** Rows that are deprecated with no sunset date at all — nothing to place. */
  undated: number;
}

/**
 * Where an instant sits along the grid.
 *
 * @param instant The instant, in epoch milliseconds.
 * @param window The window it is being placed in.
 * @returns The x coordinate in user units.
 */
export function sunsetX(instant: number, window: SunsetWindow): number {
  const span = window.end - window.start;
  const fraction = span > 0 ? (instant - window.start) / span : 0;
  return PLOT_LEFT + fraction * (PLOT_RIGHT - PLOT_LEFT);
}

/**
 * What a marker is called, in words.
 *
 * The accessible name of the marker's control *and* its native tooltip, so a reader who
 * hovers and a reader who tabs are told the same thing. Says the instant in the deprecation
 * banner's own phrasing (`30 Sep 2026 00:00 UTC`) rather than as the raw ISO string the table
 * cell prints: it is the same instant, said in the form a screen reader can read aloud.
 *
 * @param marker Everything but the label.
 * @returns The sentence.
 */
export function sunsetMarkerLabel(
  marker: Pick<SunsetMarker, 'projectName' | 'versionLine' | 'instant' | 'status' | 'days'>
): string {
  const when = formatSunsetUtc(new Date(marker.instant).toISOString());
  const countdown =
    marker.days < 0
      ? 'already passed'
      : marker.days === 0
        ? 'today'
        : `in ${marker.days} ${marker.days === 1 ? 'day' : 'days'}`;
  return `${marker.projectName} ${marker.versionLine} — sunset ${when} (${marker.status}, ${countdown}). Show this row in the table.`;
}

/**
 * Place a countdown chip beside its marker.
 *
 * Prefers the right of the marker and falls back to its left when that would leave the plot,
 * which is what the mockup does for its November sunset. Either way the chip is clamped
 * inside the plot, so a sunset at the very end of the window still reads.
 *
 * @param markerX The marker's centre.
 * @param label The chip's text.
 * @returns The chip's left edge and width.
 */
function placeChip(markerX: number, label: string): { x: number; width: number } {
  const width = label.length * CHIP_CHAR_WIDTH + CHIP_PAD_X * 2;
  const right = markerX + CHIP_GAP;
  const x = right + width <= PLOT_RIGHT ? right : markerX - CHIP_GAP - width;
  return { x: Math.min(Math.max(x, PLOT_LEFT), PLOT_RIGHT - width), width };
}

/**
 * The whole drawing, from the rows the table is showing.
 *
 * The rows handed in are *already filtered* — the timeline follows the project filter because
 * it is given the same array the table is. Rows with no sunset date, and rows whose sunset
 * falls outside the six-month window, are counted rather than drawn: a marker clamped to an
 * edge would claim a date the row does not have.
 *
 * @param entries The rows the table is showing.
 * @param now The clock, in epoch milliseconds.
 * @returns The layout. `lanes` is empty when nothing could be plotted, which is the
 *   component's cue to say so rather than draw an empty grid.
 */
export function sunsetTimelineLayout(
  entries: readonly SunsetEntry[],
  now: number
): SunsetTimelineLayout {
  const window = sunsetWindow(now);
  const months = window.months.map((month) => ({ ...month, x: sunsetX(month.startsAt, window) }));

  let outsideBefore = 0;
  let outsideAfter = 0;
  let undated = 0;

  /** Lanes keyed by project, built in the order the rows first mention each project. */
  const byProject = new Map<string, { name: string; rows: SunsetEntry[] }>();

  for (const entry of entries) {
    const instant = parseSunsetInstant(sunsetInstant(entry));
    if (instant === null) {
      undated += 1;
      continue;
    }
    if (instant < window.start) {
      outsideBefore += 1;
      continue;
    }
    if (instant >= window.end) {
      outsideAfter += 1;
      continue;
    }
    const key = entry.projectId || sunsetProjectName(entry);
    const lane = byProject.get(key);
    if (lane) lane.rows.push(entry);
    else byProject.set(key, { name: sunsetProjectName(entry), rows: [entry] });
  }

  const todayX = now >= window.start && now < window.end ? sunsetX(now, window) : null;

  const lanes: SunsetLane[] = [...byProject.entries()]
    // By project name, so the lanes read alphabetically however REST ordered the rows.
    .sort((left, right) => left[1].name.localeCompare(right[1].name))
    .map(([key, lane], index) => {
      const y = PLOT_TOP + index * LANE_HEIGHT + LANE_BASELINE;
      const markers = lane.rows
        .map((entry) => {
          // Non-null: an entry only reached a lane by parsing above.
          const instant = parseSunsetInstant(sunsetInstant(entry)) as number;
          const status = sunsetTimelineStatus(entry.timelineStatus);
          const days = sunsetDaysUntil(instant, now);
          const x = sunsetX(instant, window);
          const label = sunsetChipLabel(entry.versionLine, days);
          const chip = placeChip(x, label);
          return {
            revisionId: entry.revisionId,
            versionLine: entry.versionLine,
            projectName: lane.name,
            status,
            instant,
            days,
            x,
            y,
            // A sunset already behind us has nothing to count down to, so it gets no
            // connector — the mockup draws one only from today forwards.
            connectorFromX: todayX !== null && x > todayX ? todayX : null,
            chip: { x: chip.x, y: y - CHIP_HEIGHT / 2, width: chip.width, label },
            date: {
              x,
              y: y + MARKER_DATE_DY,
              label: sunsetMarkerDate(instant),
            },
            label: '',
          } satisfies SunsetMarker;
        })
        .sort((left, right) => left.instant - right.instant)
        .map((marker) => ({ ...marker, label: sunsetMarkerLabel(marker) }));
      return { key, name: lane.name, y, labelY: y + LANE_LABEL_DY, markers };
    });

  const gridBottom =
    PLOT_TOP + Math.max(lanes.length, 1) * LANE_HEIGHT + PLOT_BOTTOM_PAD;
  const plotted = lanes.reduce((total, lane) => total + lane.markers.length, 0);

  return {
    width: VIEW_WIDTH,
    height: gridBottom + TODAY_CHIP_GAP + TODAY_CHIP_HEIGHT + TODAY_CHIP_GAP,
    window,
    months,
    gridBottom,
    today: todayX === null ? null : { x: todayX, label: 'today' },
    lanes,
    plotted,
    outsideBefore,
    outsideAfter,
    undated,
  };
}

// ---------------------------------------------------------------------------------------
// What the drawing says about itself
// ---------------------------------------------------------------------------------------

/**
 * The drawing's accessible description — its `aria-label`.
 *
 * @param layout The layout.
 * @returns One sentence naming what is drawn and over what span.
 */
export function sunsetTimelineAriaLabel(layout: SunsetTimelineLayout): string {
  const first = layout.months[0]?.fullLabel ?? '';
  const last = layout.months[layout.months.length - 1]?.fullLabel ?? '';
  const lanes = `${layout.lanes.length} ${layout.lanes.length === 1 ? 'project' : 'projects'}`;
  const entries = `${layout.plotted} ${layout.plotted === 1 ? 'sunset' : 'sunsets'}`;
  return `Sunset timeline: ${entries} across ${lanes}, ${first} to ${last}.`;
}

/**
 * The card's footer sentence — what is drawn, and what is deliberately not.
 *
 * This is the acceptance criterion "timeline and table always agree" as a sentence: every row
 * the table is showing is either a marker here or is counted in this line.
 *
 * @param layout The layout.
 * @param total How many rows the table is showing.
 * @returns The sentence.
 */
export function sunsetTimelineSummary(
  layout: SunsetTimelineLayout,
  total: number
): string {
  const parts = [`${layout.plotted} of ${total} ${total === 1 ? 'entry' : 'entries'} on the timeline`];
  const outside = layout.outsideBefore + layout.outsideAfter;
  if (outside > 0) parts.push(`${outside} outside this six-month window`);
  if (layout.undated > 0) {
    parts.push(`${layout.undated} with no sunset date`);
  }
  parts.push('all of them in the table below');
  return `${parts.join(' · ')}.`;
}

/** The page header's one-line description, kept from the screen this replaces. */
export const SUNSET_DESCRIPTION =
  'End-of-life schedule for deprecated revisions. Dates come from the server (versions.metadata, #507); imminent means sunset within 30 days.';

/**
 * The table's foot — how many rows, and what the export writes.
 *
 * @param count How many rows are showing.
 * @returns The sentence.
 */
export function sunsetFootLabel(count: number): string {
  return `${count} ${count === 1 ? 'entry' : 'entries'}`;
}

// ---------------------------------------------------------------------------------------
// The CSV
// ---------------------------------------------------------------------------------------

/**
 * The export's columns, in order. **Unchanged** — the acceptance criterion is "CSV export
 * unchanged", and this is the list the mockup's table foot prints back to the reader.
 */
export const SUNSET_CSV_HEADERS = [
  'project',
  'versionLine',
  'sunsetDate',
  'timelineStatus',
  'lifecyclePhase',
  'successorRevisionId',
  'deprecationMessage',
] as const;

/** The downloaded file's name, unchanged. */
export const SUNSET_CSV_FILENAME = 'sunset-timeline.csv';

/**
 * The CSV, byte for byte what the screen this replaces produced.
 *
 * Fields are quoted with `JSON.stringify`, which is what the original did: it is not a
 * general CSV quoter — it escapes with backslashes rather than doubling quotes — but it *is*
 * the format consumers of this export already parse, and the ticket's acceptance criterion is
 * that the export does not change. `timelineStatus` is therefore the **server's** string, not
 * the renamed one: a spreadsheet built against `announced` must keep working.
 *
 * @param entries The rows the table is showing.
 * @returns The file's contents, without a trailing newline.
 */
export function sunsetCsv(entries: readonly SunsetEntry[]): string {
  return [
    SUNSET_CSV_HEADERS.join(','),
    ...entries.map((entry) =>
      [
        JSON.stringify(sunsetProjectName(entry)),
        JSON.stringify(entry.versionLine),
        JSON.stringify(entry.sunsetDate ?? ''),
        JSON.stringify(entry.timelineStatus),
        JSON.stringify(entry.lifecyclePhase),
        JSON.stringify(entry.successorRevisionId ?? ''),
        JSON.stringify(entry.deprecationMessage ?? ''),
      ].join(',')
    ),
  ].join('\n');
}
