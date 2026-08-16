'use client';

import * as React from 'react';
import { cn } from '../../../../../../lib/utils';
import { ChartFrame } from './ChartFrame';
import {
  chartCategoricalTone,
  chartSeriesStyle,
  type ChartSeriesTone,
  CHART_SURFACE,
} from './chartTokens';
import { describeAnnularArc, sumValues } from './chartGeometry';
import { SVG_TEXT_SIZE } from '../../svgTypography';

/** One donut segment. `tone` pins the color; otherwise a stable categorical tone is assigned. */
export interface DonutSegment {
  label: string;
  value: number;
  tone?: ChartSeriesTone;
}

const SIZE = 120;
const CENTER = SIZE / 2;
const OUTER_R = 54;
const INNER_R = 34;

export interface DonutProps {
  /** The segments; non-positive values are dropped. */
  segments: readonly DonutSegment[];
  /** Accessible name; defaults to a generated summary. */
  title?: string;
  /** Optional centered label (e.g. the total) drawn in the hole. */
  centerLabel?: React.ReactNode;
  /** Extra classes for the wrapping figure (set size here, e.g. `h-32 w-32`). */
  className?: string;
}

/**
 * `<Donut>` — a proportional ring for part-of-whole breakdowns (transport mix, auth-scheme share).
 * Segments are drawn clockwise from the top; each takes an explicit `tone` or a stable categorical
 * color. An all-zero / empty input renders the shared empty state rather than a degenerate ring.
 * Responsive via `viewBox`; SSR-safe.
 */
export function Donut({ segments, title, centerLabel, className }: DonutProps) {
  const usable = segments.filter((s) => Number.isFinite(s.value) && s.value > 0);
  const total = sumValues(usable.map((s) => s.value));
  const isEmpty = usable.length === 0 || total <= 0;

  const summary =
    usable
      .map((s) => `${s.label}: ${s.value} (${Math.round((s.value / (total || 1)) * 100)}%)`)
      .join(', ') || 'No data';
  const label = title ?? `Donut chart — ${summary}`;

  // Precompute each segment's arc angles walking clockwise from 12 o'clock. The running offset is
  // derived from a prefix sum (rather than a mutated closure variable) to stay render-pure.
  const arcs = usable.map((s, i) => {
    const before = usable.slice(0, i).reduce((acc, prev) => acc + prev.value, 0);
    const start = (before / total) * 360;
    const end = ((before + s.value) / total) * 360;
    const tone = s.tone ?? chartCategoricalTone(i);
    return { seg: s, d: describeAnnularArc(CENTER, CENTER, INNER_R, OUTER_R, start, end), tone };
  });

  return (
    <ChartFrame
      title={label}
      description={summary}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      isEmpty={isEmpty}
      className={cn('h-32 w-32', className)}
      tableFallback={
        <table>
          <caption>{label}</caption>
          <tbody>
            {usable.map((s, i) => (
              <tr key={i}>
                <th scope="row">{s.label}</th>
                <td>{s.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      }
    >
      {/* base track so a nearly-empty ring still reads as a ring */}
      <circle
        cx={CENTER}
        cy={CENTER}
        r={(OUTER_R + INNER_R) / 2}
        fill="none"
        strokeWidth={OUTER_R - INNER_R}
        className={CHART_SURFACE.trackStrokeClass}
      />
      {arcs.map(({ seg, d, tone }, i) => (
        <path key={i} d={d} className={chartSeriesStyle(tone).fillClass}>
          <title>{`${seg.label}: ${seg.value}`}</title>
        </path>
      ))}
      {centerLabel !== undefined ? (
        <text
          x={CENTER}
          y={CENTER}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={SVG_TEXT_SIZE.value}
          className={cn('font-semibold', CHART_SURFACE.labelStrongClass)}
        >
          {centerLabel}
        </text>
      ) : null}
    </ChartFrame>
  );
}
