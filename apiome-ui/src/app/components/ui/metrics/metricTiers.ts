/**
 * The Hive metrics vocabulary — how a number becomes a colour (HIVE-2.6, #5285).
 *
 * Authority: `docs/mockups/DESIGN.md` §7 (the `.stat` / `.ring` / `.sparkline` / `.meter` /
 * `.progress` row of the component table) and `docs/mockups/assets/hive.css` §§ for the same
 * five classes.
 *
 * Before this module a score ring was a per-screen decision. The Projects card drew an orb
 * with `border-emerald-500 / indigo-500 / amber-500 / rose-500`, the Catalog card copied the
 * same four literals into a second function, the seat meter picked `emerald / amber / red`,
 * and the two sparklines in the app each hard-coded `text-indigo-500 dark:text-indigo-400`.
 * Six palettes for one idea — "how is this number doing" — none of which followed a theme.
 *
 * The fix is the same one HIVE-2.4 applied to status strings: one table, keyed by the number
 * the surface already has. A caller hands over a score or a percentage and gets back a
 * **tone**; the tone names a token class. Adding a band is a line here, not a new component
 * and not a new colour.
 *
 * There is deliberately **no React** in this file, so the bands are unit-tested directly and
 * no metric component ever spells a colour.
 *
 * @see `./index.ts` — the components that render these bands.
 * @see `../statusVocabulary.ts` — the same idea for the app's enum *strings*.
 */

import {
  STATUS_TONE_TEXT_CLASS,
  type StatusTone,
} from '../statusVocabulary';

/**
 * The tones a metric mark can take.
 *
 * A strict subset of {@link StatusTone}: a chart paints with a saturated hue, and the five
 * status tones that have no hue of their own (`outline`, `ink`) or that are reserved for an
 * identity rather than a level (`rose`, `orange`) would read as a sixth band rather than as a
 * step in an ordered scale. Being a subset is what lets the ink table below be a projection of
 * the status vocabulary's, so a ring and the badge beside it use the same green.
 */
export type MetricTone = Extract<
  StatusTone,
  'neutral' | 'ok' | 'warn' | 'danger' | 'accent' | 'honey' | 'violet'
>;

/** Every metric tone, in the order the design-system gallery shows them. */
export const METRIC_TONES: readonly MetricTone[] = [
  'neutral',
  'ok',
  'warn',
  'danger',
  'accent',
  'honey',
  'violet',
] as const;

/**
 * A tone as the **saturated role hue**, expressed as a `text-*` class.
 *
 * Every mark in this kit — the ring's arc, the progress fill, the sparkline's line and its
 * soft area — paints from `currentColor`, so one table serves all five components and a mark
 * never needs a `fill-*` / `stroke-*` / `bg-*` variant of its own. `.hive-progress__fill`
 * literally declares `background: currentColor`.
 *
 * These are the saturated tokens rather than the `-fg` inks: a mark is read as a *shape*, and
 * the darker ink calibrated for body text would make a 3 px bar look muddy against its track.
 */
export const METRIC_TONE_MARK_CLASS: Readonly<Record<MetricTone, string>> = {
  neutral: 'text-neutral',
  ok: 'text-ok',
  warn: 'text-warn',
  danger: 'text-danger',
  accent: 'text-accent',
  honey: 'text-honey',
  violet: 'text-violet',
};

/**
 * A tone as **ink on a page surface** — the figure beside a meter, the delta chip's label.
 *
 * A projection of {@link STATUS_TONE_TEXT_CLASS} rather than a second table: the number under a
 * ring and the badge next to it are the same statement, so they are the same colour. These are
 * the `-fg` steps, which are the ones chosen to clear WCAG AA as text on every theme's canvas.
 */
export const METRIC_TONE_INK_CLASS: Readonly<Record<MetricTone, string>> = {
  neutral: STATUS_TONE_TEXT_CLASS.neutral,
  ok: STATUS_TONE_TEXT_CLASS.ok,
  warn: STATUS_TONE_TEXT_CLASS.warn,
  danger: STATUS_TONE_TEXT_CLASS.danger,
  accent: STATUS_TONE_TEXT_CLASS.accent,
  honey: STATUS_TONE_TEXT_CLASS.honey,
  violet: STATUS_TONE_TEXT_CLASS.violet,
};

// ============================================================================
// Ring tiers — a 0–100 score
// ============================================================================

/** One band of the 0–100 quality scale. */
export interface RingTier {
  /** Lowest score in the band, inclusive. */
  min: number;
  /** The tone the arc and the figure take. */
  tone: MetricTone;
  /** One word for the band, for `aria-valuetext` and legends. */
  label: string;
}

/**
 * The score bands, best first — **this is the ticket**.
 *
 * `≥90` ok · `75–89` accent · `60–74` warn · `<60` danger, exactly as #5285 specifies. The
 * mockups themselves disagree about the boundaries (`sources/catalog-item.html` paints 84 with
 * `--accent` while `sources/mcp-servers.html` paints 82 with `--ok`, and `home/overview.html`
 * paints 88 with `--ok`); the ticket is the authority that settles them.
 *
 * These bands are about **attention** — how much of it this number is asking for — and are
 * deliberately *not* the A–F letter bands of `utils/numeric-score-tier.ts`, which are the
 * product's grade vocabulary and split at 90/70/50/40. {@link Ring} renders both, because a
 * reader wants to know "is this fine?" and "what does the report call it?" at once, and the two
 * questions have different answers at 72 (warn, but still a B).
 */
export const RING_TIERS: readonly RingTier[] = [
  { min: 90, tone: 'ok', label: 'Excellent' },
  { min: 75, tone: 'accent', label: 'Good' },
  { min: 60, tone: 'warn', label: 'Fair' },
  { min: 0, tone: 'danger', label: 'Poor' },
] as const;

/**
 * The band for something that has not been scored yet — the faint track and no arc, so an
 * unscored ring reads as *absent* rather than as a fifth, worse band. `sources/catalog.html`
 * draws exactly this for the not-yet-computed Debt orb.
 */
export const RING_TIER_UNSCORED: RingTier = {
  min: 0,
  tone: 'neutral',
  label: 'Not scored',
};

/**
 * The band a 0–100 score falls in.
 *
 * @param score The raw score. Fractions are rounded to the nearest integer first, so 89.6
 *   reads as the 90 it will be printed as; values outside 0–100 are clamped.
 * @returns The matching {@link RingTier}, or {@link RING_TIER_UNSCORED} for a null, undefined
 *   or non-finite score.
 */
export function ringTier(score: number | null | undefined): RingTier {
  if (typeof score !== 'number' || !Number.isFinite(score)) return RING_TIER_UNSCORED;
  const clamped = clampPercent(score);
  return RING_TIERS.find((tier) => clamped >= tier.min) ?? RING_TIER_UNSCORED;
}

// ============================================================================
// Meter tiers — a share of a quota
// ============================================================================

/**
 * The share of a quota at which a meter starts asking for attention.
 *
 * 80 % is the number the tenant seat meter already used (`ade/dashboard/tenants/licenseSeats.ts`
 * `SEAT_WARNING_PERCENT`) and the number `workspace/tenants.html` draws its warn meter at.
 */
export const METER_WARN_PERCENT = 80;

/** The share at which a quota is spent and the next seat / import / call will be refused. */
export const METER_CAP_PERCENT = 100;

/**
 * The tone a **usage** meter takes at a given share of its quota.
 *
 * Rising usage is bad news, which is the opposite of a rising score — hence a second function
 * rather than a reuse of {@link ringTier}. Below the warn line the meter is deliberately quiet
 * (`accent`, not `ok`): a half-full quota is not an achievement, and painting it green spends
 * the one colour that should mean "this is finished" on a number nobody needs to read.
 *
 * @param percent The share used, 0–100. Values are clamped; a non-finite value reads as 0.
 * @returns `accent` below {@link METER_WARN_PERCENT}, `warn` from there to the cap, `danger` at
 *   or above {@link METER_CAP_PERCENT}.
 */
export function meterTier(percent: number): MetricTone {
  const clamped = clampPercent(percent);
  if (clamped >= METER_CAP_PERCENT) return 'danger';
  if (clamped >= METER_WARN_PERCENT) return 'warn';
  return 'accent';
}

/**
 * A `value`/`max` pair as a whole-percent share of its quota.
 *
 * @param value The amount used. Negative and non-finite values read as 0.
 * @param max The quota. A zero or negative `max` means there is no quota to be a share of —
 *   it reads as 100, so a meter drawn for one is visibly full rather than misleadingly empty.
 *   (Callers with an *unlimited* plan should not draw a meter at all; see
 *   `licenseSeats.seatsUnlimited`.)
 * @returns The share, 0–100, rounded to a whole number so the bar and the printed figure agree.
 */
export function meterPercent(value: number, max: number): number {
  if (!Number.isFinite(max) || max <= 0) return METER_CAP_PERCENT;
  const used = Number.isFinite(value) && value > 0 ? value : 0;
  return clampPercent(Math.round((used / max) * 100));
}

// ============================================================================
// Deltas — a number that moved
// ============================================================================

/** Which way a figure moved since the period it is being compared with. */
export type DeltaDirection = 'up' | 'down' | 'flat';

/**
 * Whether "up" is the good news.
 *
 * A delta chip that always paints a rise green is wrong on every screen that counts something
 * bad: `+12 errors` is not an improvement. The polarity is the caller's one-word statement of
 * which direction it wants, and it is what stops the chip from congratulating a regression.
 *
 * - `positive` — up is good (published versions, mock requests). The default, and the only
 *   case `hive.css`'s `.stat__delta--up/--down` covers.
 * - `negative` — up is bad (open findings, p95 latency, failed jobs).
 * - `neutral` — the direction carries no judgement (headcount, stored bytes).
 */
export type DeltaPolarity = 'positive' | 'negative' | 'neutral';

/**
 * Which way a delta points.
 *
 * @param value The change. Non-finite values read as no change.
 * @returns `up` above zero, `down` below it, `flat` at exactly zero.
 */
export function deltaDirection(value: number): DeltaDirection {
  if (!Number.isFinite(value) || value === 0) return 'flat';
  return value > 0 ? 'up' : 'down';
}

/**
 * The tone a delta chip takes.
 *
 * @param direction Which way it moved.
 * @param polarity Which way the caller wanted it to move.
 * @returns `ok` when the move was the wanted one, `danger` when it was not, and `neutral` for a
 *   flat delta or a metric with no preferred direction — never a hue that implies a verdict the
 *   caller did not ask for.
 */
export function deltaTone(direction: DeltaDirection, polarity: DeltaPolarity): MetricTone {
  if (direction === 'flat' || polarity === 'neutral') return 'neutral';
  const good = polarity === 'positive' ? 'up' : 'down';
  return direction === good ? 'ok' : 'danger';
}

/**
 * A delta as its printed label — a sign and the magnitude.
 *
 * Uses U+2212 MINUS SIGN rather than the hyphen-minus: `.stat__value` and every figure in this
 * kit is `tabular-nums`, and the hyphen is the one glyph in that set that is not the width of a
 * digit, so a column of `-4` / `+4` rows would not line up.
 *
 * @param value The change. Non-finite values print as `0`.
 * @param unit Optional suffix appended with no space (`'%'`, `'ms'`).
 * @returns e.g. `"+12"`, `"−4%"`, `"0"`.
 */
export function formatDelta(value: number, unit?: string): string {
  const suffix = unit ?? '';
  if (!Number.isFinite(value) || value === 0) return `0${suffix}`;
  const sign = value > 0 ? '+' : '−';
  return `${sign}${Math.abs(value)}${suffix}`;
}

// ============================================================================
// Shared
// ============================================================================

/**
 * A number as a whole percentage inside 0–100.
 *
 * Every component here needs the same guard, and needs it to fail *safe*: a NaN width would
 * render a bar of `NaN%` (which the browser drops, silently leaving a full-width fill) and a
 * NaN `aria-valuenow` is an axe violation. Exported so the components share one definition of
 * "out of range" rather than three.
 *
 * @param value The raw number.
 * @returns `value` rounded and clamped to 0–100; `0` when it is not a finite number.
 */
export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}
