'use client';

import * as React from 'react';
import { cn } from '../../../../../../lib/utils';
import { getNumericScoreTier } from '../../../../utils/numeric-score-tier';
import { ChartFrame } from './ChartFrame';
import { chartSeriesStyle, type ChartSeriesTone, CHART_SURFACE } from './chartTokens';
import { clamp, describeArc } from './chartGeometry';
import { SVG_TEXT_SIZE } from '../../svgTypography';

const SIZE = 120;
const CENTER = SIZE / 2;
const R = 46;
// A 270° open dial: sweeps from 7-o'clock (−135° from top) clockwise to 5-o'clock (+135°).
const START_ANGLE = -135;
const SWEEP = 270;

export interface GaugeProps {
  /** The current value. */
  value: number;
  /** Domain start (default 0). */
  min?: number;
  /** Domain end (default 100). */
  max?: number;
  /**
   * Arc color. When omitted, a `[0,100]` domain colors by the shared score band (poor→excellent);
   * any other domain falls back to `indigo`.
   */
  tone?: ChartSeriesTone;
  /** Text shown in the center; defaults to the rounded value. Pass `null` to hide. */
  centerLabel?: React.ReactNode;
  /** Accessible name; defaults to a generated summary. */
  title?: string;
  /** Extra classes for the wrapping figure (set size here). */
  className?: string;
}

/**
 * `<Gauge>` — a 270° dial for a single bounded value (a health/quality score, a percentile latency
 * against its budget). The value sweeps a colored arc over a muted track. With no explicit `tone` a
 * `0–100` gauge colors itself by the shared score bands (so it matches `GradeGlyph`'s gauge); other
 * domains use a token tone. A non-finite value renders the empty state. Responsive; SSR-safe.
 */
export function Gauge({
  value,
  min = 0,
  max = 100,
  tone,
  centerLabel,
  title,
  className,
}: GaugeProps) {
  const isEmpty = !Number.isFinite(value) || max <= min;
  const span = max - min || 1;
  const frac = (clamp(value, min, max) - min) / span;
  const valueAngleEnd = START_ANGLE + SWEEP * frac;

  // Color resolution: explicit tone → its stroke class; else 0–100 → score band; else indigo.
  const isScoreScale = min === 0 && max === 100;
  const strokeClass = tone
    ? chartSeriesStyle(tone).strokeClass
    : isScoreScale
      ? getNumericScoreTier(clamp(value, 0, 100)).gaugeStrokeClass
      : chartSeriesStyle('indigo').strokeClass;

  const rounded = Number.isFinite(value) ? Math.round(value) : 0;
  const summary = `${rounded} of ${min}–${max}`;
  const label = title ?? `Gauge — ${summary}`;
  const center = centerLabel === undefined ? rounded : centerLabel;

  return (
    <ChartFrame
      title={label}
      description={summary}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      isEmpty={isEmpty}
      className={cn('h-28 w-28', className)}
      tableFallback={
        <table>
          <caption>{label}</caption>
          <tbody>
            <tr>
              <th scope="row">Value</th>
              <td>{rounded}</td>
            </tr>
            <tr>
              <th scope="row">Range</th>
              <td>
                {min}–{max}
              </td>
            </tr>
          </tbody>
        </table>
      }
    >
      {/* track */}
      <path
        d={describeArc(CENTER, CENTER, R, START_ANGLE, START_ANGLE + SWEEP)}
        fill="none"
        strokeWidth={10}
        strokeLinecap="round"
        className={CHART_SURFACE.trackStrokeClass}
      />
      {/* value arc */}
      <path
        d={describeArc(CENTER, CENTER, R, START_ANGLE, valueAngleEnd)}
        fill="none"
        stroke="currentColor"
        strokeWidth={10}
        strokeLinecap="round"
        className={cn(strokeClass, 'transition-all duration-500')}
      />
      {center !== null ? (
        <text
          x={CENTER}
          y={CENTER}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={SVG_TEXT_SIZE.display}
          className={cn('font-bold', CHART_SURFACE.labelStrongClass)}
        >
          {center}
        </text>
      ) : null}
    </ChartFrame>
  );
}
