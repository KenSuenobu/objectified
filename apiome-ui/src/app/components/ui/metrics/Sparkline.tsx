'use client';

/**
 * `<Sparkline>` — a trend, small enough to sit in a sentence (HIVE-2.6, #5285).
 *
 * Authority: `docs/mockups/assets/hive.css` `.sparkline` / `--ok` / `--warn` / `--danger`, and
 * the two screens that draw one — `ship/published.html` (30 days of mock requests, in a table
 * cell) and `govern/lint-posture.html` (new findings vs remediated).
 *
 * Line plus a soft fill of the same colour, no axes, no ticks, no gridlines: the shape is the
 * whole message and the numbers are read from the label. Both existing sparklines in the app
 * hard-coded `text-indigo-500 dark:text-indigo-400`; here the tone is a token, so the trend
 * follows the theme like everything else.
 *
 * **Fixed aspect.** The proportion is set once in `globals.css` (`aspect-ratio`, 5:1) rather
 * than per call site, so every trend in the product is the same shape and a reader learns to
 * compare them by eye. Callers set the width; the height follows. A caller that genuinely needs
 * another proportion sets both, which is what `aspect-ratio` yields to.
 *
 * The geometry comes from the chart kit's pure helpers rather than a second copy of the same
 * arithmetic — see the import note below.
 */

import * as React from 'react';
import { cn } from '@lib/utils';
// `chartGeometry` is React-free, DOM-free coordinate maths with its own unit tests
// (`tests/mcp-charts-geometry.test.ts`). It lives under `ui/mcp/charts/` because that kit was
// written first, not because it is MCP-specific — re-deriving `sparklinePoints` here would be a
// second definition of the same six lines, and the ticket's point is that there is one kit.
import { pointsToPath, sparklinePoints } from '../mcp/charts/chartGeometry';
import { METRIC_TONE_MARK_CLASS, type MetricTone } from './metricTiers';

/** The plotting box. 5:1, matching the `aspect-ratio` `.hive-sparkline` is drawn at. */
const W = 120;
const H = 24;

/**
 * Inset of the plot from the box, in user units.
 *
 * The line is stroked *on* its path, so a point at the exact top or bottom edge would have half
 * its stroke clipped away. Two units is a little over one stroke width at every size this is
 * drawn at.
 */
const PAD = 2;

export interface SparklineProps
  extends Omit<React.SVGAttributes<SVGSVGElement>, 'children' | 'role'> {
  /** The series, oldest first. Non-finite entries plot as 0. */
  data: readonly number[];
  /**
   * What the series is — the accessible name (`"Mock requests, last 30 days"`). Required: a
   * shape with no name tells a screen-reader user nothing at all.
   */
  label: string;
  /** The line's colour. Defaults to `accent`, the mockup's unqualified `.sparkline`. */
  tone?: MetricTone;
  /** Fill the area under the line (default true). */
  area?: boolean;
  /**
   * Pin the top of the y-axis. By default the series scales to its own maximum, which shows
   * *shape*; pin it (e.g. to 100 for a score) when the reader needs to compare heights between
   * two sparklines.
   */
  domainMax?: number;
}

/**
 * Render the sparkline. See {@link SparklineProps}.
 *
 * @returns A `role="img"` SVG whose `aria-label` states the count, the latest value and the
 *   range — the numbers the shape is standing in for.
 */
export const Sparkline = React.forwardRef<SVGSVGElement, SparklineProps>(function Sparkline(
  { data, label, tone = 'accent', area = true, domainMax, className, ...props },
  ref,
) {
  const points = sparklinePoints(data, W, H, PAD, domainMax);
  const line = pointsToPath(points);
  const areaPath =
    area && points.length > 1
      ? `${line} L ${points[points.length - 1].x.toFixed(2)} ${H} L ${points[0].x.toFixed(2)} ${H} Z`
      : '';

  const summary = describeSeries(data);

  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`${label} — ${summary}`}
      focusable="false"
      data-tone={tone}
      className={cn('hive-sparkline', METRIC_TONE_MARK_CLASS[tone], className)}
      {...props}
    >
      <title>{`${label} — ${summary}`}</title>
      {areaPath ? <path className="hive-sparkline__area" d={areaPath} /> : null}
      {points.length > 1 ? <path className="hive-sparkline__line" d={line} /> : null}
      {points.length === 1 ? (
        <circle className="hive-sparkline__point" cx={points[0].x} cy={points[0].y} r={1.75} />
      ) : null}
    </svg>
  );
});

/**
 * The series as the sentence its shape stands in for.
 *
 * @param data The series.
 * @returns `"no data"` for an empty series, otherwise the count, the latest value and the range —
 *   which is what a sighted reader takes from the shape, in the order they take it.
 */
function describeSeries(data: readonly number[]): string {
  const finite = data.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return 'no data';
  const latest = finite[finite.length - 1];
  const high = Math.max(...finite);
  const low = Math.min(...finite);
  const points = `${finite.length} point${finite.length === 1 ? '' : 's'}`;
  if (high === low) return `${points}, steady at ${latest}`;
  return `${points}, latest ${latest}, high ${high}, low ${low}`;
}
