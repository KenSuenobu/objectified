/**
 * Home's copy and derivations, with no React in them (HIVE-4.6, #5300).
 *
 * Authority: `docs/mockups/home/overview.html` and its Notes panel, `docs/mockups/DESIGN.md`
 * §8 (a page is header → stat strip → content) and §10 (titles are nouns, numbers are tabular,
 * times are relative).
 *
 * The page component below this file decides *layout*; this module decides *wording and
 * numbers*, which is the half worth testing without a DOM. Two things in particular live here
 * because they were previously inlined in the page and could not be exercised at all:
 *
 * - {@link formatTimeAgo}, which the activity list has always used — moved out of
 *   `page.tsx` unchanged in behaviour, so the ten rows still read the way they did.
 * - {@link STAT_DEFINITIONS}, the six stats. The ticket's first acceptance criterion is that
 *   these are "preserved exactly, including loading skeletons", so each subtitle is a function
 *   of the same `getDashboardStats` columns as before and `tests/dashboard-home-model.test.ts`
 *   pins every string against the pre-redesign page.
 */

import {
  Activity,
  BellRing,
  Box,
  Braces,
  Building2,
  FolderKanban,
  GitBranch,
  Globe,
  KeyRound,
  Library,
  Network,
  Upload,
  UserPlus,
  Zap,
  type LucideIcon,
} from 'lucide-react';

import { OPEN_ACTIONS, openActionHref } from '@/app/components/shell/openActions';
import type { AttentionKind, PulseWeek } from '@lib/db/dashboard-home-model';

/* -------------------------------------------------------------------------
   The six stats
   ------------------------------------------------------------------------- */

/**
 * The `getDashboardStats` columns the stat strip reads.
 *
 * Named locally rather than imported from `lib/db/helper` because that module is `'use
 * server'`: importing a type from it would be free, but importing the *module* to get at one
 * would pull the whole database layer into the client bundle.
 */
export interface DashboardStats {
  total_tenants: number;
  admin_tenants: number;
  total_projects: number;
  created_projects: number;
  total_versions: number;
  created_versions: number;
  published_versions: number;
  total_classes: number;
  total_properties: number;
  total_class_properties: number;
  last_activity: string | null;
}

/** The zero payload the page holds until the first load resolves. */
export const EMPTY_STATS: DashboardStats = {
  total_tenants: 0,
  admin_tenants: 0,
  total_projects: 0,
  created_projects: 0,
  total_versions: 0,
  created_versions: 0,
  published_versions: 0,
  total_classes: 0,
  total_properties: 0,
  total_class_properties: 0,
  last_activity: null,
};

/** One of the six stats, resolved against a stats payload. */
export interface ResolvedStat {
  /** React key and test handle. */
  id: string;
  /** The stat's label, sentence case. */
  label: string;
  /** The glyph beside the label. */
  icon: LucideIcon;
  /** The figure. */
  value: number;
  /** A quiet unit beside the figure (`"of 14"`), or `undefined` for a bare count. */
  unit?: string;
  /** The footnote under the figure — the same subtitle the pre-redesign cards showed. */
  subtitle: string;
}

/** How one stat is derived from the payload. */
interface StatDefinition {
  id: string;
  label: string;
  icon: LucideIcon;
  value: (stats: DashboardStats) => number;
  unit?: (stats: DashboardStats) => string | undefined;
  subtitle: (stats: DashboardStats) => string;
}

/**
 * Versions that exist but are not published.
 *
 * Clamped at zero because the two counts come from separate sub-selects: they are consistent in
 * practice, but a negative "−1 drafts" is not a number this page should ever be able to print.
 *
 * @param stats The dashboard statistics payload.
 * @returns The number of unpublished versions.
 */
export function unpublishedVersionCount(stats: DashboardStats): number {
  return Math.max(0, stats.total_versions - stats.published_versions);
}

/**
 * The six stats, in the mockup's order, each with the subtitle the page has always shown.
 *
 * The icons are the mockup's (`building-2`, `folder-kanban`, `git-branch`, `globe`, `box`,
 * `braces`) — the pre-redesign strip drew a `Folder` for both Tenants and Projects, which made
 * two different things look like the same thing.
 */
const STAT_DEFINITIONS: readonly StatDefinition[] = [
  {
    id: 'tenants',
    label: 'Tenants',
    icon: Building2,
    value: (stats) => stats.total_tenants,
    subtitle: (stats) => `${stats.admin_tenants} admin`,
  },
  {
    id: 'projects',
    label: 'Projects',
    icon: FolderKanban,
    value: (stats) => stats.total_projects,
    subtitle: (stats) => `${stats.created_projects} created`,
  },
  {
    id: 'versions',
    label: 'Versions',
    icon: GitBranch,
    value: (stats) => stats.total_versions,
    subtitle: (stats) => `${stats.created_versions} created`,
  },
  {
    id: 'published',
    label: 'Published',
    icon: Globe,
    value: (stats) => stats.published_versions,
    // The mockup's "5 of 14": the figure only means something against the total.
    unit: (stats) => (stats.total_versions > 0 ? `of ${stats.total_versions}` : undefined),
    subtitle: (stats) => {
      const drafts = unpublishedVersionCount(stats);
      return `${drafts} draft${drafts === 1 ? '' : 's'}`;
    },
  },
  {
    id: 'classes',
    label: 'Classes',
    icon: Box,
    value: (stats) => stats.total_classes,
    subtitle: () => 'schema definitions',
  },
  {
    id: 'properties',
    label: 'Properties',
    icon: Braces,
    value: (stats) => stats.total_properties,
    subtitle: (stats) => `${stats.total_class_properties} in classes`,
  },
];

/** How many stats the strip draws — also the number of skeleton cells while loading. */
export const STAT_COUNT = STAT_DEFINITIONS.length;

/**
 * Resolve the six stats against a payload.
 *
 * @param stats The dashboard statistics.
 * @returns The six stats, in display order.
 */
export function resolveStats(stats: DashboardStats): ResolvedStat[] {
  return STAT_DEFINITIONS.map((definition) => ({
    id: definition.id,
    label: definition.label,
    icon: definition.icon,
    value: definition.value(stats),
    unit: definition.unit?.(stats),
    subtitle: definition.subtitle(stats),
  }));
}

/* -------------------------------------------------------------------------
   Recent activity
   ------------------------------------------------------------------------- */

/** One row of `getRecentActivity`. */
export interface RecentActivityRow {
  type: 'project' | 'version' | 'class' | 'property';
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  tenant_name: string;
  tenant_slug: string;
}

/** How many activity rows the page asks for. Ten, as before. */
export const ACTIVITY_LIMIT = 10;

/** The four things a row can be about, each with its glyph, its verb and its tone. */
const ACTIVITY_KINDS = {
  project: { icon: FolderKanban, label: 'Created project', tone: 'violet' },
  version: { icon: GitBranch, label: 'Created version', tone: 'ok' },
  class: { icon: Box, label: 'Created class', tone: 'accent' },
  property: { icon: Braces, label: 'Created property', tone: 'warn' },
} as const;

/** What an activity row is drawn as. */
export interface ActivityPresentation {
  icon: LucideIcon;
  /** The row's title, e.g. `"Created version"`. */
  label: string;
  /** Tone for the leading icon tile, in the `statusVocabulary` vocabulary. */
  tone: string;
  /** The `.badge--outline` word at the end of the row. */
  badge: string;
}

/**
 * How to draw one activity row.
 *
 * An unrecognised type still renders — the row's own name and time are worth showing even when
 * a newer activity kind reaches an older client — as a neutral "Activity".
 *
 * @param type The row's `type` column.
 * @returns The glyph, verb, tone and badge word for that kind.
 */
export function activityPresentation(type: string): ActivityPresentation {
  const kind = ACTIVITY_KINDS[type as keyof typeof ACTIVITY_KINDS];
  if (!kind) return { icon: Activity, label: 'Activity', tone: 'neutral', badge: 'activity' };
  return { icon: kind.icon, label: kind.label, tone: kind.tone, badge: type };
}

/** Thresholds of {@link formatTimeAgo}, in the unit each step counts. */
const MINUTE_SECONDS = 60;
const HOUR_MINUTES = 60;
const DAY_HOURS = 24;
const MONTH_DAYS = 30;
const YEAR_MONTHS = 12;

/**
 * A timestamp as time elapsed, in the wording the activity list has always used.
 *
 * Carried over from `ade/dashboard/page.tsx` with its behaviour unchanged, including the
 * approximation of a month as 30 days — the list is a glance, and the exact instant belongs in
 * the row's `title` attribute, which the component adds.
 *
 * ### Why this is not `formatRelativeTimestamp`
 *
 * `utils/catalog-detail-insights.ts` already has a function that says almost exactly this, and
 * the two are *not* interchangeable: it treats a year as 365 days where this treats it as twelve
 * 30-day months, so between 360 and 364 days one says "12 months ago" and the other "1 year
 * ago". This ticket's first acceptance criterion is that the activity list is preserved exactly,
 * which settles which of the two Home keeps. Merging them means picking one wording for both
 * surfaces and extracting it out of a catalog-specific module — a worthwhile change, and a
 * different ticket from a redesign of this page.
 *
 * @param instant An ISO timestamp.
 * @param now The instant to measure from. Defaults to the current time.
 * @returns `"just now"`, `"5 minutes ago"`, `"2 hours ago"`, `"3 days ago"`, and so on.
 */
export function formatTimeAgo(instant: string, now: Date = new Date()): string {
  const date = new Date(instant);
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (seconds < MINUTE_SECONDS) return 'just now';
  const minutes = Math.floor(seconds / MINUTE_SECONDS);
  if (minutes < HOUR_MINUTES) return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
  const hours = Math.floor(minutes / HOUR_MINUTES);
  if (hours < DAY_HOURS) return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
  const days = Math.floor(hours / DAY_HOURS);
  if (days < MONTH_DAYS) return `${days} day${days !== 1 ? 's' : ''} ago`;
  const months = Math.floor(days / MONTH_DAYS);
  if (months < YEAR_MONTHS) return `${months} month${months !== 1 ? 's' : ''} ago`;
  const years = Math.floor(months / YEAR_MONTHS);
  return `${years} year${years !== 1 ? 's' : ''} ago`;
}

/* -------------------------------------------------------------------------
   The header
   ------------------------------------------------------------------------- */

/**
 * The one line under the greeting: what is moving across the workspace.
 *
 * Built from counts the strip is about to show rather than from a second query, so the sentence
 * and the stats can never disagree. Singularised properly, because "1 projects" in the first
 * line a reader sees is the kind of detail that makes the rest look careless.
 *
 * @param stats The dashboard statistics.
 * @returns A sentence, or a first-run invitation when there is nothing to describe yet.
 */
export function workspaceSummarySentence(stats: DashboardStats): string {
  if (stats.total_projects === 0 && stats.total_versions === 0) {
    return 'Nothing here yet — create a project or import a spec to get started.';
  }
  const parts = [
    `${stats.total_projects} project${stats.total_projects === 1 ? '' : 's'}`,
    `${stats.total_versions} version${stats.total_versions === 1 ? '' : 's'}`,
    `${stats.published_versions} published`,
  ];
  return `Here's what's moving across your workspace. ${parts.join(', ')}.`;
}

/* -------------------------------------------------------------------------
   Quick actions
   ------------------------------------------------------------------------- */

/** One row of the Quick actions panel. */
export interface QuickAction {
  id: string;
  label: string;
  icon: LucideIcon;
  /** An in-app route that exists today. */
  href: string;
  /** A decorative shortcut chip, for the two actions HIVE-3.7 binds a chord to. */
  kbd?: string;
  /** True when the action is meaningless without a selected workspace. */
  requiresTenant: boolean;
}

/**
 * The five quick actions, in the mockup's order.
 *
 * The first three are the palette's own deep links — `openActionHref` is the shared seam, so
 * "Import a spec" here opens the *same* dialog, with the same validation, as ⌘K → "Import a
 * spec…" and the Projects toolbar. Nothing on this panel is a new route or a second copy of a
 * form; that is what the ticket means by "routes that already exist".
 */
export const QUICK_ACTIONS: readonly QuickAction[] = [
  {
    id: 'import-spec',
    label: 'Import a spec',
    icon: Upload,
    href: openActionHref('/ade/dashboard/projects', OPEN_ACTIONS.importSpec),
    kbd: 'I',
    requiresTenant: true,
  },
  {
    id: 'browse-catalog',
    label: 'Browse the catalog',
    icon: Library,
    href: '/ade/dashboard/catalog',
    requiresTenant: false,
  },
  {
    id: 'new-api-key',
    label: 'Create an API key',
    icon: KeyRound,
    href: openActionHref('/ade/dashboard/api-keys', OPEN_ACTIONS.newApiKey),
    requiresTenant: true,
  },
  {
    id: 'invite-teammate',
    label: 'Invite a teammate',
    icon: UserPlus,
    href: '/ade/dashboard/members',
    requiresTenant: true,
  },
  {
    id: 'register-mcp',
    label: 'Register an MCP server',
    icon: Network,
    href: '/ade/dashboard/mcp',
    requiresTenant: true,
  },
];

/**
 * The quick actions worth offering to this reader.
 *
 * A reader with no workspace cannot import a spec into one, and an action that navigates to a
 * page which will only tell them so is worse than an action that is not there.
 *
 * @param hasTenant Whether the session has a current workspace.
 * @returns The actions to draw.
 */
export function quickActionsFor(hasTenant: boolean): QuickAction[] {
  return QUICK_ACTIONS.filter((action) => hasTenant || !action.requiresTenant);
}

/* -------------------------------------------------------------------------
   Needs attention
   ------------------------------------------------------------------------- */

/** The glyph for each attention source. */
export const ATTENTION_ICON: Readonly<Record<AttentionKind, LucideIcon>> = {
  sunset: Globe,
  lint: BellRing,
  key: KeyRound,
};

/* -------------------------------------------------------------------------
   Pick up where you left off
   ------------------------------------------------------------------------- */

/**
 * Display words for the lifecycle strings `revisionStatus` emits.
 *
 * The vocabulary is lower-case because that is what `statusVocabulary` matches on; a badge
 * shows it title-cased. Kept as a table rather than a `capitalize` call so a two-word state
 * ("In review", if one is added) has somewhere to be spelled.
 */
const STATUS_WORD: Readonly<Record<string, string>> = {
  draft: 'Draft',
  beta: 'Beta',
  published: 'Published',
  deprecated: 'Deprecated',
  sunset: 'Sunset',
  archived: 'Archived',
};

/**
 * The badge's word for a lifecycle string.
 *
 * @param status A vocabulary string.
 * @returns Its display word, or the status itself when it is one this table does not know —
 *   an unknown state should read as itself rather than vanish.
 */
export function statusWord(status: string): string {
  return STATUS_WORD[status.trim().toLowerCase()] ?? status;
}

/**
 * The card's bottom-right line: when the revision was last touched, and how.
 *
 * @param touchedKind Whether the instant was a publish or an edit.
 * @param touchedAt The instant, ISO.
 * @param now The instant to measure from. Defaults to the current time.
 * @returns `"Edited 2 hours ago"` or `"Published 3 days ago"`.
 */
export function touchedPhrase(
  touchedKind: 'edited' | 'published',
  touchedAt: string,
  now: Date = new Date(),
): string {
  const verb = touchedKind === 'published' ? 'Published' : 'Edited';
  return `${verb} ${formatTimeAgo(touchedAt, now)}`;
}

/**
 * The card's monospaced meta line: the revision and what is in it.
 *
 * @param versionLabel The revision's semantic id, or `null` when the project has none.
 * @param classCount Classes on that revision.
 * @param propertyCount Properties on those classes.
 * @returns A `·`-separated line.
 */
export function revisionMetaLine(
  versionLabel: string | null,
  classCount: number,
  propertyCount: number,
): string {
  const parts = [
    `${classCount} class${classCount === 1 ? '' : 'es'}`,
    `${propertyCount} propert${propertyCount === 1 ? 'y' : 'ies'}`,
  ];
  return [versionLabel ?? 'No versions yet', ...parts].join(' · ');
}

/* -------------------------------------------------------------------------
   Publishing pulse
   ------------------------------------------------------------------------- */

/**
 * How short the shortest bar may be, as a percentage of the tallest.
 *
 * A week with one publish and a week with none must not look the same, so a non-zero count is
 * never drawn shorter than this. An *empty* week is drawn at zero — the panel's own baseline
 * hairline is what shows it is there.
 */
export const PULSE_MIN_BAR_PERCENT = 8;

/** One drawn bar of the pulse. */
export interface PulseBar extends PulseWeek {
  /** Height as a percentage of the panel, 0–100. */
  percent: number;
  /** What a reader hears or reads on hover. */
  label: string;
}

/**
 * Scale the weekly counts into bar heights.
 *
 * Relative to the window's own maximum rather than to a fixed ceiling: the pulse answers "is
 * this week busier than the last twelve?", which a fixed scale would flatten for a small team
 * and clip for a large one.
 *
 * @param weeks The buckets, oldest first.
 * @returns One bar per bucket, with a height and an accessible label.
 */
export function pulseBars(weeks: readonly PulseWeek[]): PulseBar[] {
  const peak = weeks.reduce((max, week) => Math.max(max, week.count), 0);
  return weeks.map((week) => ({
    ...week,
    percent:
      week.count === 0 || peak === 0
        ? 0
        : Math.max(PULSE_MIN_BAR_PERCENT, Math.round((week.count / peak) * 100)),
    label: `Week of ${formatWeekStart(week.weekStart)}: ${week.count} published`,
  }));
}

/**
 * Total publishes across the drawn window.
 *
 * @param weeks The buckets.
 * @returns The sum of their counts.
 */
export function pulseTotal(weeks: readonly PulseWeek[]): number {
  return weeks.reduce((total, week) => total + week.count, 0);
}

/** Month names for the pulse's axis, indexed by `getUTCMonth()`. */
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A bucket's start as `"12 May"`.
 *
 * Formatted from the UTC parts rather than with `toLocaleDateString` on purpose: the buckets are
 * UTC weeks, and a locale formatter would render the same bucket as a different day either side
 * of a date line.
 *
 * @param weekStart An ISO date, `YYYY-MM-DD`.
 * @returns The day and abbreviated month, or the input when it is not a date.
 */
export function formatWeekStart(weekStart: string): string {
  const parsed = Date.parse(`${weekStart}T00:00:00.000Z`);
  if (!Number.isFinite(parsed)) return weekStart;
  const date = new Date(parsed);
  return `${date.getUTCDate()} ${MONTH_NAMES[date.getUTCMonth()]}`;
}

/**
 * The month labels under the bars.
 *
 * One label per month the window touches, in order, so twelve weekly bars get three or four
 * ticks rather than twelve dates nobody can read.
 *
 * @param weeks The buckets, oldest first.
 * @returns The abbreviated month names, deduplicated in order.
 */
export function pulseMonthTicks(weeks: readonly PulseWeek[]): string[] {
  const ticks: string[] = [];
  for (const week of weeks) {
    const parsed = Date.parse(`${week.weekStart}T00:00:00.000Z`);
    if (!Number.isFinite(parsed)) continue;
    const name = MONTH_NAMES[new Date(parsed).getUTCMonth()];
    if (ticks[ticks.length - 1] !== name) ticks.push(name);
  }
  return ticks;
}

/** The panel's own subtitle, so the copy and {@link pulseBars} cannot disagree on the span. */
export const PULSE_SPAN_LABEL = 'last 12 weeks';

/* -------------------------------------------------------------------------
   Panel headings
   ------------------------------------------------------------------------- */

/** The heading and glyph of each added panel, in one place so the tests can name them. */
export const PANEL = {
  continue: { title: 'Pick up where you left off' },
  activity: { title: 'Recent activity', icon: Activity, subtitle: 'Your latest actions' },
  quickActions: { title: 'Quick actions', icon: Zap },
  attention: { title: 'Needs attention', icon: BellRing },
  pulse: { title: 'Publishing pulse' },
} as const;
