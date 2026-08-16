/**
 * The Hive metrics set (HIVE-2.6, #5285) — `Stat`, `StatGrid`, `Ring`, `Sparkline`, `Meter`,
 * `Progress`.
 *
 * Five marks and a tone table, drawn with inline SVG and CSS and **no new dependency**: the app
 * already carries `mermaid` and `@xyflow/react` for the two graphs that genuinely need a layout
 * engine, and a score ring is not one of them.
 *
 * Every component here follows the same three rules:
 *
 * - **The caller passes a number, the kit picks the colour.** Bands live in `./metricTiers.ts`,
 *   which is React-free and unit-tested directly. No surface spells a hue.
 * - **Every mark paints from `currentColor`.** One tone → one `text-*` class reaches the ring's
 *   arc, the bar's fill and the sparkline's line and area alike, so a tone is one line of CSS
 *   rather than four paint channels.
 * - **The value is text before it is a shape.** Each component exposes its number to assistive
 *   tech — `role="meter"` with `aria-valuetext` for the ring and the meter, `role="progressbar"`
 *   for the bar, `role="img"` with a summarised `aria-label` for the sparkline.
 *
 * Live gallery: `/design-system/hive` §Metrics.
 *
 * ## Import path
 *
 * This barrel is imported **by path** (`@/app/components/ui/metrics`) rather than re-exported
 * from `components/ui/index.ts`. The MCP analytics kit (`ui/mcp/charts`, V2-MCP-28.3) already
 * exports a component called `Sparkline` — a different thing, with a categorical palette built
 * for multi-series insight panels — and folding both into one namespace would make the name
 * ambiguous at exactly the moment a caller needs to know which one they are getting.
 */

export * from './metricTiers';
export * from './Stat';
export * from './Ring';
export * from './Sparkline';
export * from './Meter';
export * from './Progress';
