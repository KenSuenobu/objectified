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
import { clamp, sumValues } from './chartGeometry';

/** A named series (a band in the stack) with a stable key and optional pinned tone. */
export interface StackSeries {
  key: string;
  label?: string;
  tone?: ChartSeriesTone;
}

/** One period (a column): its label plus a value per series key. */
export interface StackPeriod {
  label: string;
  values: Record<string, number>;
}

const H = 100;
const GAP = 4;

export interface StackedTimelineProps {
  /** The stacked series (bottom→top of each column), in draw order. */
  series: readonly StackSeries[];
  /** The periods (columns), left→right. */
  periods: readonly StackPeriod[];
  /** Fixed column-total maximum; when omitted the tallest column total defines the scale. */
  domainMax?: number;
  /** Accessible name; defaults to a generated summary. */
  title?: string;
  /** Extra classes for the wrapping figure (set height here). */
  className?: string;
  /**
   * When provided, every column becomes an interactive control: clicking (or pressing Enter/Space
   * while focused) calls this with the period's index. A full-height transparent hit target sits over
   * each column so even a zero-total (empty) column stays clickable. The frame switches to an
   * interactive role so the controls are reachable by assistive tech (see {@link ChartFrame}).
   */
  onSelectPeriod?: (index: number) => void;
  /**
   * The accessible label for a column's hit target (also its hover tooltip). Only consulted when
   * `onSelectPeriod` is set; defaults to the period's `label`. Give each column a descriptive label
   * (e.g. "v3 · Jul 4 — +2 −1 ~0") so the interactive control is self-describing.
   */
  periodActionLabel?: (period: StackPeriod, index: number) => string;
  /** Index of a column to mark active (a subtle persistent highlight, e.g. the current snapshot). */
  activeIndex?: number;
}

/**
 * `<StackedTimeline>` — a stacked bar chart over an ordered axis (per-version churn split by
 * added/changed/removed, tool invocations by outcome over time). Each column stacks its series
 * bottom→top; columns scale to the largest column total unless `domainMax` is pinned. Series take an
 * explicit `tone` or a stable categorical color. Empty input renders the shared empty state.
 * Responsive via `viewBox`; SSR-safe.
 */
export function StackedTimeline({
  series,
  periods,
  domainMax,
  title,
  className,
  onSelectPeriod,
  periodActionLabel,
  activeIndex,
}: StackedTimelineProps) {
  const isEmpty = periods.length === 0 || series.length === 0;
  const interactive = typeof onSelectPeriod === 'function';

  const columnTotal = (p: StackPeriod) => sumValues(series.map((s) => p.values[s.key] ?? 0));
  const max = domainMax && domainMax > 0 ? domainMax : Math.max(1, ...periods.map(columnTotal));

  const n = Math.max(1, periods.length);
  const bandW = (100 - GAP * (n + 1)) / n;

  const summary =
    periods
      .map((p) => `${p.label}: ${columnTotal(p)}`)
      .join(', ') || 'No data';
  const label = title ?? `Stacked timeline — ${summary}`;
  const hitLabel = (p: StackPeriod, i: number) =>
    periodActionLabel ? periodActionLabel(p, i) : p.label;

  return (
    <ChartFrame
      title={label}
      description={summary}
      viewBox={`0 0 100 ${H}`}
      preserveAspectRatio="none"
      isEmpty={isEmpty}
      interactive={interactive}
      className={cn('h-40 w-full', className)}
      tableFallback={
        <table>
          <caption>{label}</caption>
          <thead>
            <tr>
              <th scope="col">Period</th>
              {series.map((s) => (
                <th key={s.key} scope="col">
                  {s.label ?? s.key}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {periods.map((p, i) => (
              <tr key={i}>
                <th scope="row">{p.label}</th>
                {series.map((s) => (
                  <td key={s.key}>{p.values[s.key] ?? 0}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      }
    >
      {periods.map((p, pi) => {
        const x = GAP + pi * (bandW + GAP);
        // Walk series bottom→top, accumulating height so bands sit on top of one another.
        let acc = 0;
        return (
          <g key={pi}>
            {series.map((s, si) => {
              const raw = p.values[s.key] ?? 0;
              const h = H * (clamp(Number.isFinite(raw) ? raw : 0, 0, max) / max);
              const y = H - acc - h;
              acc += h;
              const style = chartSeriesStyle(s.tone ?? chartCategoricalTone(si));
              if (h <= 0) return null;
              return (
                <rect key={s.key} x={x} y={y} width={bandW} height={h} className={style.fillClass}>
                  <title>{`${p.label} — ${s.label ?? s.key}: ${raw}`}</title>
                </rect>
              );
            })}
          </g>
        );
      })}
      <line
        x1={0}
        y1={H}
        x2={100}
        y2={H}
        strokeWidth={0.5}
        vectorEffect="non-scaling-stroke"
        className={CHART_SURFACE.trackStrokeClass}
      />
      {/* Interactive layer: one full-height, transparent hit target per column, drawn last so it sits
          above the bars and captures the whole column (a zero-total column included). Enter/Space
          activates a focused target; hover/focus/active paint a subtle tint via token classes. */}
      {interactive
        ? periods.map((p, pi) => {
            const x = GAP + pi * (bandW + GAP);
            return (
              <rect
                key={`hit-${pi}`}
                x={x}
                y={0}
                width={bandW}
                height={H}
                role="button"
                tabIndex={0}
                aria-label={hitLabel(p, pi)}
                onClick={() => onSelectPeriod?.(pi)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
                    e.preventDefault();
                    onSelectPeriod?.(pi);
                  }
                }}
                className={cn(
                  'cursor-pointer outline-none transition-colors',
                  'hover:fill-fg/5 focus-visible:fill-fg/10',
                  pi === activeIndex ? 'fill-accent/10' : 'fill-transparent',
                )}
              >
                <title>{hitLabel(p, pi)}</title>
              </rect>
            );
          })
        : null}
    </ChartFrame>
  );
}
