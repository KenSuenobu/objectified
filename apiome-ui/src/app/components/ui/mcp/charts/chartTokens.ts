/**
 * Token-driven SVG chart kit — palette & series-tone mapping (V2-MCP-28.3 / MCAT-14.3;
 * retoned onto the Hive vocabulary in HIVE-7.9, #5326).
 *
 * The chart kit follows the same design principle as {@link GradeGlyph} and the rest of the MCP UI
 * primitives: **consumers pass domain values, primitives pick the color**. This module holds the
 * *pure*, React-free mapping from a semantic "series tone" (or a stable series index) to the
 * utility classes each SVG mark paints with. Because chart marks are SVG, colors are expressed as
 * `fill-*` / `stroke-*` / `text-*` utilities — never a hex or `rgb()` literal in a consumer.
 *
 * Keeping this logic here (and free of JSX) lets it be unit-tested directly and keeps the chart
 * components free of color/branching literals — mirroring `mcpUiPrimitives.ts`.
 *
 * ### Since HIVE-7.9 (#5326) the tones are the design language's
 *
 * They used to be eleven pairs of raw palette classes — `fill-indigo-500 dark:fill-indigo-400`
 * and ten more like it, with `stroke-gray-200 dark:stroke-gray-700` gridlines behind them.
 * Tailwind's own ramps are *not* re-pointed per theme in `globals.css` (only the `--color-*`
 * role tokens are), so a donut drawn from them was frozen on one light palette and one dark one:
 * on the seven appearances that are neither — Nord, Solarized, Darcula, Blueprint, Whiteboard,
 * High contrast, and the system default resolving to either — every chart on the MCP surface was
 * painted from a palette the card around it had never heard of.
 *
 * Each tone now names its place in `ui/statusVocabulary` — `emerald` *is* `ok`, `red` *is*
 * `danger`, `pink` *is* `rose` — and paints from that role's saturated token, which every theme
 * recalibrates. This is the move HIVE-7.7 (#5324) made for `McpBadge`'s seven tones and HIVE-2.4
 * made for the grade glyph, for the same reason and with the same rule: the tone *names* are
 * unchanged, because ~30 call sites and six suites spell them; only what they resolve to moved.
 *
 * `mcp-analytics.html` is what fixed the mapping — its category donut is drawn
 * `var(--accent) · var(--ok) · var(--violet) · var(--warn) · var(--rose)`, which is exactly
 * {@link CHART_CATEGORICAL_ORDER}'s first five.
 *
 * Marks paint the **saturated** role token rather than its `-fg` ink, for the reason
 * `metrics/metricTiers.ts` gives: a mark is read as a *shape*, and the darker ink calibrated for
 * body text makes a 3 px line look muddy against its track. A saturated token is a 3:1 non-text
 * mark, not AA text — so every chart in this kit states its data in an `sr-only` table and every
 * consumer legend prints the label in words beside the swatch. Colour is never the only signal.
 */

/**
 * The semantic categorical tones a chart series can take. This mirrors the {@link McpBadgeTone}
 * language so a chart and the badges beside it read as one palette. `neutral` is the muted
 * role used for baselines, gridlines, and "other" buckets.
 */
export type ChartSeriesTone =
  | 'indigo'
  | 'emerald'
  | 'amber'
  | 'red'
  | 'blue'
  | 'violet'
  | 'green'
  | 'orange'
  | 'cyan'
  | 'pink'
  | 'neutral';

/** The classes one series paints its marks with, split by SVG paint channel. */
export interface ChartSeriesStyle {
  /** The tone this style resolves. */
  tone: ChartSeriesTone;
  /** `fill-*` class for filled marks (bars, donut/heatmap cells, radar/area fills). */
  fillClass: string;
  /** `stroke-*` class for stroked marks (sparkline/line paths, radar outline). */
  strokeClass: string;
  /** `text-*` class so a mark can use `fill="currentColor"` / `stroke="currentColor"` and inherit. */
  textClass: string;
}

/**
 * The role each tone name resolves to in `ui/statusVocabulary`.
 *
 * Five of the eleven names collapse onto three roles, deliberately:
 *
 * - `indigo`, `blue` and `cyan` are all **accent**. DESIGN.md §0 retires indigo in favour of one
 *   azure, and the three "informational, not a state" hues the old ramp spent were never telling
 *   two values apart inside one chart — `mcpSafetyPostureUi` uses `blue` for *idempotent* beside
 *   `green` for *read-only*, and `mcpEvolutionUi` uses it for *modified* beside *added*; in both
 *   the axis label carries the difference. `McpBadge` made the same call for its own `indigo` /
 *   `blue` pair.
 * - `emerald` and `green` are both **ok**, which is what both always meant.
 *
 * That leaves seven distinct hues, which is what {@link CHART_CATEGORICAL_ORDER} hands out.
 */
export const CHART_TONE_ROLE: Readonly<Record<ChartSeriesTone, string>> = {
  indigo: 'accent',
  blue: 'accent',
  cyan: 'accent',
  emerald: 'ok',
  green: 'ok',
  amber: 'warn',
  red: 'danger',
  violet: 'violet',
  orange: 'orange',
  pink: 'rose',
  neutral: 'neutral',
};

/** The tone → class table, derived from {@link CHART_TONE_ROLE} so the three channels cannot drift. */
const CHART_SERIES_STYLES: Readonly<Record<ChartSeriesTone, ChartSeriesStyle>> = Object.freeze(
  Object.fromEntries(
    (Object.keys(CHART_TONE_ROLE) as ChartSeriesTone[]).map((tone) => {
      const role = CHART_TONE_ROLE[tone];
      return [
        tone,
        {
          tone,
          fillClass: `fill-${role}`,
          strokeClass: `stroke-${role}`,
          textClass: `text-${role}`,
        },
      ];
    }),
  ) as Record<ChartSeriesTone, ChartSeriesStyle>,
);

/**
 * The order tones are handed out to a categorical series (donut segments, stacked bands, multi-line
 * charts) when the consumer does not pin a tone.
 *
 * The seven names that resolve to *distinct* roles, so no two adjacent slices of a donut can come
 * out the same colour — the failure the pre-Hive ten-name order would now have, since three of its
 * entries collapse onto accent and two onto ok. The first five are `mcp-analytics.html`'s own
 * category-donut order. `neutral` is intentionally excluded: it is reserved for baselines and
 * "other" buckets, not auto-assignment.
 */
export const CHART_CATEGORICAL_ORDER: readonly ChartSeriesTone[] = [
  'indigo',
  'emerald',
  'violet',
  'amber',
  'pink',
  'orange',
  'red',
];

/** Resolve the {@link ChartSeriesStyle} for a tone (defaults to `neutral` for an unknown value). */
export function chartSeriesStyle(tone: ChartSeriesTone | null | undefined): ChartSeriesStyle {
  return (tone && CHART_SERIES_STYLES[tone]) || CHART_SERIES_STYLES.neutral;
}

/**
 * Resolve the tone for the `index`-th series in a categorical chart, cycling through
 * {@link CHART_CATEGORICAL_ORDER} so any number of series get a stable, repeatable color. A negative
 * index collapses to the first tone.
 */
export function chartCategoricalTone(index: number): ChartSeriesTone {
  const n = CHART_CATEGORICAL_ORDER.length;
  const safe = Number.isFinite(index) ? Math.trunc(index) : 0;
  return CHART_CATEGORICAL_ORDER[((safe % n) + n) % n];
}

/** Convenience: the resolved style for the `index`-th categorical series. */
export function chartCategoricalStyle(index: number): ChartSeriesStyle {
  return chartSeriesStyle(chartCategoricalTone(index));
}

/**
 * Shared surface classes used by every chart for non-data furniture, so the palette lives in one
 * place: the muted track/gridline color and the axis/label text color. These are `stroke`/`fill`
 * utilities applied to SVG elements.
 *
 * All four are role tokens rather than grey ramps, for the reason above — and the two label steps
 * are `--fg-muted` / `--fg` rather than the mockups' `--fg-subtle`, which measures about 3.1:1
 * against the canvas at chart-label sizes. That is the deviation every Hive page block since
 * HIVE-3.5 has made for quiet text.
 */
export const CHART_SURFACE = {
  /** Gridlines, unfilled tracks (donut/gauge base ring, bar track, radar web). */
  trackStrokeClass: 'stroke-border-strong',
  /** Filled track background (e.g. heatmap empty cell, radar web fill). */
  trackFillClass: 'fill-inset',
  /** Axis / tick / value label text. */
  labelClass: 'fill-fg-muted',
  /** Stronger label text for emphasized values. */
  labelStrongClass: 'fill-fg',
} as const;
