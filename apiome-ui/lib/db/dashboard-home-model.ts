/**
 * The pure half of Home's data layer (HIVE-4.6, #5300).
 *
 * `dashboard-home.ts` beside this file is `'use server'`, so it may export nothing but async
 * functions — every shape, threshold and derivation the queries feed lives here instead, where
 * it can be unit-tested without a database. `tests/dashboard-home-model.test.ts` covers it.
 *
 * Three things Home adds to the overview are computed rather than stored, and each one is a
 * judgement this module makes exactly once:
 *
 * 1. **A revision's lifecycle** — the app spells it in three places at once (`published`,
 *    `metadata.lifecycle`, `metadata.sunsetAt`) and the badge needs one word. {@link
 *    revisionStatus} settles the precedence, in the vocabulary `ui/statusVocabulary` already
 *    knows, so Home's badge and the Versions list cannot disagree.
 * 2. **What needs attention** — three unrelated sources (a sunset schedule, a stored lint
 *    report, a key's expiry) become one ranked list. Urgency is *days*, not source, so a key
 *    expiring tomorrow outranks a sunset three weeks out.
 * 3. **The publishing pulse** — publish instants become twelve fixed weekly buckets. Bucketing
 *    here rather than in SQL keeps the query a plain `SELECT` of timestamps and makes the
 *    boundary arithmetic (which is where week bucketing goes wrong) testable against a fixed
 *    clock.
 */

/** Milliseconds in a day — the unit every threshold below is stated in. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** How many weeks of publishing history the pulse draws. Matches the mockup's twelve bars. */
export const PULSE_WEEKS = 12;

/** How far back the pulse query has to reach to fill {@link PULSE_WEEKS}. */
export const PULSE_WINDOW_DAYS = PULSE_WEEKS * 7;

/** How many projects "Pick up where you left off" shows. Three, as the mockup's grid does. */
export const CONTINUE_PROJECT_LIMIT = 3;

/** How many rows "Needs attention" shows before it stops. */
export const ATTENTION_LIMIT = 5;

/**
 * How near a sunset has to be before Home mentions it.
 *
 * A sunset ninety days out is a plan, not a problem; one inside a month is work the reader has
 * to schedule. Past sunsets are always included — a revision that should already be gone is
 * the most urgent thing on the list.
 */
export const SUNSET_ATTENTION_DAYS = 30;

/** How near an API key's expiry has to be before Home mentions it. */
export const KEY_EXPIRY_ATTENTION_DAYS = 14;

/* -------------------------------------------------------------------------
   Shapes
   ------------------------------------------------------------------------- */

/**
 * One project the reader can pick back up, with its newest revision's headline facts.
 *
 * Everything here is already shown somewhere else in the app — this is the Versions list's own
 * row, reduced to what fits on a card.
 */
export interface ContinueProject {
  /** The project's record id, used as the React key. */
  projectId: string;
  /** The project's name, as its heading. */
  projectName: string;
  /** The workspace it belongs to, so a reader in several can tell them apart. */
  tenantName: string;
  /** The newest revision's semantic id (`"v2.4.0"`), or `null` for a project with none yet. */
  versionLabel: string | null;
  /** Lifecycle word for the badge, from {@link revisionStatus}. */
  status: string;
  /** 0–100 from the stored lint report, or `null` when the revision was never scored. */
  qualityScore: number | null;
  /** The letter grade captured with the score, or `null`. */
  qualityGrade: string | null;
  /** Classes on the newest revision. */
  classCount: number;
  /** Properties on those classes. */
  propertyCount: number;
  /** ISO instant of the most recent publish or edit — whichever {@link touchedKind} names. */
  touchedAt: string;
  /** Whether {@link touchedAt} was a publish or an ordinary edit. The card words each. */
  touchedKind: 'edited' | 'published';
}

/** Which of the three sources an attention row came from. */
export type AttentionKind = 'sunset' | 'lint' | 'key';

/** One row of "Needs attention". */
export interface AttentionItem {
  /** Stable id, unique across the three sources. */
  id: string;
  /** Where it came from — the row's icon and the test's grouping key. */
  kind: AttentionKind;
  /** Tone for the leading dot: `danger` for a deadline already missed or a blocked gate. */
  tone: 'warn' | 'danger';
  /** What happened, in one line. */
  title: string;
  /** What it means for the reader, in one shorter line. */
  detail: string;
  /** An in-app route that exists today. */
  href: string;
  /**
   * Days until the deadline — negative when it has passed, and the sort key for the whole
   * list. A finding with no deadline (a lint gate) states one so it ranks among the rest.
   */
  urgency: number;
}

/** One bar of the publishing pulse. */
export interface PulseWeek {
  /** ISO date (`YYYY-MM-DD`) of the bucket's first day, in UTC. */
  weekStart: string;
  /** Versions published in that week. */
  count: number;
}

/* -------------------------------------------------------------------------
   Rows, as the queries return them
   ------------------------------------------------------------------------- */

/**
 * A revision's lifecycle inputs, as the `versions` row spells them.
 *
 * `pg` hands back `metadata` already parsed (the column is `jsonb`), so this takes the object
 * rather than a string.
 */
export interface RevisionStatusInput {
  /** `versions.published`. */
  published: boolean;
  /** `versions.metadata`, or anything at all — a non-object is treated as absent. */
  metadata: unknown;
}

/** The `sunsetAt` keys a revision may carry, newest spelling first (`revision_deprecation.py`). */
const SUNSET_KEYS = ['sunsetAt', 'sunsetDate', 'sunset_date'] as const;

/**
 * Read a revision's metadata as a plain object.
 *
 * @param metadata The `jsonb` column's value, which may be `null`, a scalar or an array.
 * @returns The object, or an empty one — so every reader below can index it unconditionally.
 */
function metadataObject(metadata: unknown): Record<string, unknown> {
  if (metadata == null || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  return metadata as Record<string, unknown>;
}

/**
 * The revision's scheduled sunset, if it has one.
 *
 * @param metadata The revision's `metadata` column.
 * @returns The first non-empty sunset string under any of the three keys REST writes, or `null`.
 */
export function sunsetInstantOf(metadata: unknown): string | null {
  const object = metadataObject(metadata);
  for (const key of SUNSET_KEYS) {
    const raw = object[key];
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
  }
  return null;
}

/**
 * The revision's lifecycle, in one word from the shared status vocabulary.
 *
 * Precedence, most specific first: a sunset already reached is `sunset`; an `archived` or
 * `deprecated` lifecycle tag (or the legacy `metadata.deprecated` flag REST infers it from) is
 * itself; a published revision is `published`; a `beta` tag is `beta`; anything else is `draft`.
 *
 * `sunset` outranks `deprecated` deliberately: REST requires a revision with a sunset to be
 * deprecated, so both are true of every retired revision, and the *later* of the two states is
 * the one worth printing.
 *
 * @param row The revision's `published` flag and `metadata`.
 * @param now The instant to compare a sunset against. Defaults to the current time.
 * @returns A vocabulary string `ui/statusVocabulary` resolves to a tone.
 */
export function revisionStatus(row: RevisionStatusInput, now: Date = new Date()): string {
  const metadata = metadataObject(row.metadata);
  const sunset = sunsetInstantOf(metadata);
  if (sunset) {
    const reached = Date.parse(sunset);
    if (Number.isFinite(reached) && reached <= now.getTime()) return 'sunset';
  }

  const lifecycle = typeof metadata.lifecycle === 'string' ? metadata.lifecycle.trim().toLowerCase() : '';
  if (lifecycle === 'archived') return 'archived';
  if (lifecycle === 'deprecated') return 'deprecated';
  if (metadata.deprecated === true || metadata.deprecated === 'true') return 'deprecated';
  if (sunset) return 'deprecated';

  if (row.published) return 'published';
  if (lifecycle === 'beta') return 'beta';
  return 'draft';
}

/* -------------------------------------------------------------------------
   Needs attention
   ------------------------------------------------------------------------- */

/**
 * Whole days from `now` until `instant` — days *elapsed*, in either direction.
 *
 * Truncated towards zero rather than floored, so the count is accurate on both sides of today:
 * a deadline 1.4 days out is "in 1 day", and one 7.6 days past is "7 days ago". Flooring is the
 * obvious choice and is wrong for the past half — it would report that same deadline as "8 days
 * ago", overstating by a day exactly where a reader is checking how late they are. Anything
 * inside ±1 day lands on `0`, which {@link deadlinePhrase} words as "today".
 *
 * @param instant An ISO timestamp or date.
 * @param now The instant to measure from.
 * @returns Whole days, negative once the deadline has passed, or `null` when `instant` is
 *   not a date this runtime can parse.
 */
export function daysUntil(instant: string, now: Date): number | null {
  const target = Date.parse(instant);
  if (!Number.isFinite(target)) return null;
  const days = Math.trunc((target - now.getTime()) / DAY_MS);
  // `Math.trunc` of anything in (-1, 0) is `-0`, which `Object.is` and therefore a test's
  // `toBe(0)` treat as a different value from `0`. Normalised so "later today" and "earlier
  // today" are the same number.
  return days === 0 ? 0 : days;
}

/**
 * How a deadline that many days out is said in English.
 *
 * @param days Whole days, as {@link daysUntil} returns them.
 * @returns `"in 12 days"`, `"tomorrow"`, `"today"` or `"3 days ago"`.
 */
export function deadlinePhrase(days: number): string {
  if (days < -1) return `${Math.abs(days)} days ago`;
  if (days === -1) return 'yesterday';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

/** A row of the sunset query: a revision with a scheduled sunset. */
export interface SunsetRow {
  versionRowId: string;
  versionLabel: string;
  projectName: string;
  sunsetAt: string;
  /** Whether consumers can still reach it — a published revision sunsetting is the urgent case. */
  published: boolean;
}

/** A row of the lint query: an unpublished revision whose stored report has blocking findings. */
export interface LintRow {
  versionRowId: string;
  versionLabel: string;
  projectName: string;
  errorCount: number;
}

/** A row of the key query: an enabled API key with an expiry. */
export interface KeyRow {
  keyId: string;
  keyName: string;
  tenantName: string;
  expiresAt: string;
}

/** Where each kind of attention row sends the reader. Routes that exist today, per the ticket. */
export const ATTENTION_HREF: Readonly<Record<AttentionKind, string>> = {
  sunset: '/ade/dashboard/versions/sunset-timeline',
  lint: '/ade/dashboard/lint-workspace',
  key: '/ade/dashboard/api-keys',
};

/**
 * Turn scheduled sunsets into attention rows.
 *
 * Only sunsets inside {@link SUNSET_ATTENTION_DAYS} — or already past — are worth a row; a
 * date next quarter is a plan the sunset timeline already shows.
 *
 * @param rows Revisions carrying a sunset, in any order.
 * @param now The instant deadlines are measured against.
 * @returns One item per near or missed sunset.
 */
export function sunsetAttention(rows: readonly SunsetRow[], now: Date): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const row of rows) {
    const days = daysUntil(row.sunsetAt, now);
    if (days == null || days > SUNSET_ATTENTION_DAYS) continue;
    items.push({
      id: `sunset:${row.versionRowId}`,
      kind: 'sunset',
      tone: days < 0 ? 'danger' : 'warn',
      title: `${row.projectName} ${row.versionLabel} sunsets ${deadlinePhrase(days)}`,
      detail: row.published
        ? 'Still published — move consumers to a successor'
        : 'Unpublished, so no consumer is affected',
      href: ATTENTION_HREF.sunset,
      urgency: days,
    });
  }
  return items;
}

/**
 * Turn stored lint reports into attention rows.
 *
 * A blocking finding has no date, so it is ranked as though its deadline were today: a publish
 * that is gated right now is exactly as urgent as something due today, and less urgent than a
 * sunset already missed.
 *
 * @param rows Revisions whose stored report counts at least one `error`.
 * @returns One item per revision.
 */
export function lintAttention(rows: readonly LintRow[]): AttentionItem[] {
  return rows.map((row) => ({
    id: `lint:${row.versionRowId}`,
    kind: 'lint' as const,
    tone: 'danger' as const,
    title: `${row.errorCount} blocking lint ${row.errorCount === 1 ? 'finding' : 'findings'} on ${row.projectName} ${row.versionLabel}`,
    detail: 'The publish gate will fail until these are cleared',
    href: ATTENTION_HREF.lint,
    urgency: 0,
  }));
}

/**
 * Turn expiring API keys into attention rows.
 *
 * @param rows Enabled keys with an expiry, in any order.
 * @param now The instant expiries are measured against.
 * @returns One item per key expiring inside {@link KEY_EXPIRY_ATTENTION_DAYS}, or already expired.
 */
export function keyAttention(rows: readonly KeyRow[], now: Date): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const row of rows) {
    const days = daysUntil(row.expiresAt, now);
    if (days == null || days > KEY_EXPIRY_ATTENTION_DAYS) continue;
    items.push({
      id: `key:${row.keyId}`,
      kind: 'key',
      tone: days < 0 ? 'danger' : 'warn',
      title: `API key ${row.keyName} ${days < 0 ? 'expired' : 'expires'} ${deadlinePhrase(days)}`,
      detail: days < 0 ? `${row.tenantName} — rotate it to restore access` : `${row.tenantName} — rotate it before it breaks CI`,
      href: ATTENTION_HREF.key,
      urgency: days,
    });
  }
  return items;
}

/**
 * Merge the three sources into the one list the panel draws.
 *
 * Sorted by urgency — days remaining, so a missed deadline sorts first — then by title, which
 * makes the order deterministic when several things fall due on the same day. That matters for
 * more than tidiness: the panel caps at {@link ATTENTION_LIMIT}, and an unstable sort would
 * change *which* rows get shown between two renders of the same data.
 *
 * @param groups Any number of item lists, from {@link sunsetAttention} and friends.
 * @param limit How many rows to keep. Defaults to {@link ATTENTION_LIMIT}.
 * @returns The ranked, capped list.
 */
export function rankAttention(
  groups: readonly (readonly AttentionItem[])[],
  limit: number = ATTENTION_LIMIT,
): AttentionItem[] {
  return groups
    .flat()
    .sort((a, b) => a.urgency - b.urgency || a.title.localeCompare(b.title))
    .slice(0, Math.max(0, limit));
}

/* -------------------------------------------------------------------------
   Publishing pulse
   ------------------------------------------------------------------------- */

/**
 * The UTC midnight that starts `instant`'s week, as `YYYY-MM-DD`.
 *
 * Weeks start on Monday, which is what makes the twelve bars line up with how a team talks
 * about a sprint. UTC throughout: the buckets are a shape, not a schedule, and resolving them
 * in the reader's zone would move a bar under a reader in Auckland relative to one in Denver
 * for the same publish.
 *
 * @param instant Any date.
 * @returns The ISO date of that week's Monday.
 */
export function weekStartOf(instant: Date): string {
  const utc = new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()));
  // getUTCDay() is 0 for Sunday, so Sunday belongs to the week that began six days earlier.
  const offset = (utc.getUTCDay() + 6) % 7;
  utc.setUTCDate(utc.getUTCDate() - offset);
  return utc.toISOString().slice(0, 10);
}

/**
 * Bucket publish instants into the last `weeks` weekly bars, oldest first.
 *
 * Every bucket is present even when nothing was published in it — a pulse with gaps closed up
 * would read as steady output. Instants outside the window, and ones that do not parse, are
 * dropped rather than clamped into an edge bucket they did not happen in.
 *
 * @param instants ISO timestamps of publishes, in any order.
 * @param now The instant the window ends at.
 * @param weeks How many buckets. Defaults to {@link PULSE_WEEKS}.
 * @returns Exactly `weeks` buckets, oldest first, the last containing `now`'s week.
 */
export function bucketPublishesByWeek(
  instants: readonly string[],
  now: Date,
  weeks: number = PULSE_WEEKS,
): PulseWeek[] {
  const buckets: PulseWeek[] = [];
  const index = new Map<string, PulseWeek>();

  const cursor = new Date(`${weekStartOf(now)}T00:00:00.000Z`);
  cursor.setUTCDate(cursor.getUTCDate() - (weeks - 1) * 7);
  for (let i = 0; i < weeks; i += 1) {
    const bucket: PulseWeek = { weekStart: cursor.toISOString().slice(0, 10), count: 0 };
    buckets.push(bucket);
    index.set(bucket.weekStart, bucket);
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }

  for (const instant of instants) {
    const parsed = Date.parse(instant);
    if (!Number.isFinite(parsed)) continue;
    const bucket = index.get(weekStartOf(new Date(parsed)));
    if (bucket) bucket.count += 1;
  }

  return buckets;
}

/* -------------------------------------------------------------------------
   The assembled payload
   ------------------------------------------------------------------------- */

/** Everything Home shows beyond the six stats, the activity list and the checklist. */
export interface DashboardHome {
  /**
   * The name of the workspace the session is in, for the breadcrumb's first step.
   *
   * Resolved here rather than by a second `loadTenantMembershipContext()` call on the client:
   * the queries below already join `apiome.tenants`, and Home needs one word from it, not the
   * switcher's whole membership list.
   */
  workspaceName: string | null;
  /** Up to {@link CONTINUE_PROJECT_LIMIT} projects, most recently touched first. */
  continueProjects: ContinueProject[];
  /** Up to {@link ATTENTION_LIMIT} ranked rows. Empty means the panel is not drawn at all. */
  attention: AttentionItem[];
  /** Exactly {@link PULSE_WEEKS} buckets, oldest first. */
  pulse: PulseWeek[];
}

/**
 * What Home shows when nothing could be resolved.
 *
 * A fresh object each call: the panels below are handed these arrays directly, and a shared
 * literal would let one caller's mutation reach the next.
 *
 * @returns An empty payload with a full-length, all-zero pulse.
 */
export function emptyDashboardHome(): DashboardHome {
  return {
    workspaceName: null,
    continueProjects: [],
    attention: [],
    pulse: [],
  };
}
