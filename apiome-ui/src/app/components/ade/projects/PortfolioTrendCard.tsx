'use client';

/**
 * Portfolio quality trend (HIVE-6.1, #5312).
 *
 * Authority: `docs/mockups/build/projects.html` §"Portfolio quality trend" — a `.card` with a
 * `.chart-area`, gridlines at **70 / 85 / 100**, an `avg NN` badge in the header and
 * `start · mid · now` under the plot.
 *
 * ### Why the chart is hand-drawn and still part of the 2.6 kit
 *
 * `<Sparkline>` is the kit's trend mark and this is *not* one: a sparkline deliberately has no
 * axes, because it is small enough to sit in a sentence and its shape is the whole message.
 * This chart has to answer "is the portfolio above or below 85?", which needs the three
 * gridlines the mockup draws, so it draws them.
 *
 * What it does take from the kit is everything that decides a colour or a shape:
 * {@link ringTier} picks the tone from the latest average and
 * {@link METRIC_TONE_MARK_CLASS} turns that into the one `text-*` class the line, the area and
 * the end dot all paint from — so this chart is the same green as the ring on the card below
 * it. The chart this replaces hard-coded `#6366f1` in four places and
 * `fill-emerald-600 dark:fill-emerald-400` in a fifth, none of which followed a theme.
 *
 * The one exemption from the token rule is `fontSize` on the two `<text>` runs, which is
 * `SVG_TEXT_SIZE` — a label inside a `viewBox` is measured in user units, and DESIGN.md §3.2's
 * "keep `px` only where it is genuinely physical … canvas geometry" is exactly that case.
 */

import * as React from 'react';
import { TrendingUp } from 'lucide-react';

import { Badge } from '@/app/components/ui/Badge';
import { Card, CardBody, CardHeader, CardTitle } from '@/app/components/ui/Card';
import { EmptyState } from '@/app/components/ui/EmptyState';
import { METRIC_TONE_MARK_CLASS, ringTier } from '@/app/components/ui/metrics';
import { SVG_TEXT_SIZE } from '@/app/components/ui/svgTypography';
import type { PortfolioQualityPoint } from '@/app/utils/project-quality-score-history';
import { cn } from '@lib/utils';

/** The plotting box, in user units. */
const WIDTH = 800;
const HEIGHT = 140;

/** Room for the three gridline labels on the left, and for the top and bottom strokes. */
const PAD_LEFT = 30;
const PAD_RIGHT = 8;
const PAD_TOP = 12;
const PAD_BOTTOM = 12;

/**
 * The y-axis, 55–100.
 *
 * Not 0–100: a portfolio average is a mean of means and in practice never leaves the top
 * half, so a full axis would flatten every real movement into the top fifth of the box. 55 is
 * five points below the lowest band boundary the chart labels, which keeps a portfolio in
 * trouble inside the plot rather than clipped to its floor.
 */
const Y_MIN = 55;
const Y_MAX = 100;

/** The three scores the mockup rules: the A boundary, the middle of B, and the ceiling. */
const GRIDLINES = [100, 85, 70] as const;

/**
 * Where a score sits, vertically.
 *
 * @param score A 0–100 score; values outside the axis are clamped onto it.
 * @returns The y coordinate in user units.
 */
function scaleY(score: number): number {
  const clamped = Math.min(Y_MAX, Math.max(Y_MIN, score));
  const plotHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;
  return PAD_TOP + plotHeight * (1 - (clamped - Y_MIN) / (Y_MAX - Y_MIN));
}

/**
 * Where the nth of `count` points sits, horizontally.
 *
 * @param index The point's position, 0-based.
 * @param count How many points there are.
 * @returns The x coordinate in user units — the middle of the plot for a lone point, so a
 *   single import does not draw itself against the left edge.
 */
function scaleX(index: number, count: number): number {
  const plotWidth = WIDTH - PAD_LEFT - PAD_RIGHT;
  if (count <= 1) return PAD_LEFT + plotWidth / 2;
  return PAD_LEFT + (index / (count - 1)) * plotWidth;
}

export interface PortfolioTrendCardProps {
  /** The running portfolio average after each import, oldest first. */
  series: readonly PortfolioQualityPoint[];
  /** Extra classes for the card. */
  className?: string;
}

/**
 * Render the portfolio trend card. See {@link PortfolioTrendCardProps}.
 *
 * @returns The card — its chart, or the empty state that says why there is none.
 */
export default function PortfolioTrendCard({ series, className }: PortfolioTrendCardProps) {
  const points = React.useMemo(
    () =>
      series.map((point, index) => ({
        x: scaleX(index, series.length),
        y: scaleY(point.avgOverall),
        score: point.avgOverall,
      })),
    [series]
  );

  const latest = series.length > 0 ? series[series.length - 1].avgOverall : null;
  const tone = ringTier(latest).tone;

  const line = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(' ');
  const floor = HEIGHT - PAD_BOTTOM;
  const area =
    points.length > 1
      ? `${line} L ${points[points.length - 1].x.toFixed(2)} ${floor} L ${points[0].x.toFixed(2)} ${floor} Z`
      : '';

  return (
    <Card className={cn('prj-portfolio', className)} data-testid="projects-portfolio-trend">
      <CardHeader className="prj-portfolio__header">
        <CardTitle className="prj-portfolio__title">
          <TrendingUp aria-hidden />
          Portfolio quality trend
          <span className="prj-portfolio__note">
            Average quality across projects after each import (this browser)
          </span>
        </CardTitle>
        {latest != null ? (
          <Badge status="active" data-testid="projects-portfolio-avg">{`avg ${latest}`}</Badge>
        ) : null}
      </CardHeader>
      <CardBody>
        {series.length === 0 ? (
          <EmptyState
            variant="compact"
            surface={false}
            tone="neutral"
            icon={<TrendingUp />}
            title="No quality history in this browser yet"
            description="Import a specification into a project and its score is recorded here."
          />
        ) : (
          <>
            <div className={cn('prj-portfolio__chart', METRIC_TONE_MARK_CLASS[tone])}>
              <svg
                viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
                preserveAspectRatio="none"
                role="img"
                aria-label={`Portfolio quality trend — ${series.length} ${
                  series.length === 1 ? 'point' : 'points'
                }, latest average ${latest}`}
                focusable="false"
              >
                <g className="prj-portfolio__grid">
                  {GRIDLINES.map((score) => (
                    <line
                      key={score}
                      x1={PAD_LEFT}
                      y1={scaleY(score)}
                      x2={WIDTH - PAD_RIGHT}
                      y2={scaleY(score)}
                    />
                  ))}
                </g>
                <g className="prj-portfolio__ticks" fontSize={SVG_TEXT_SIZE.tick}>
                  {GRIDLINES.map((score) => (
                    <text key={score} x={0} y={scaleY(score) + 3}>
                      {score}
                    </text>
                  ))}
                </g>
                {area ? <path className="prj-portfolio__area" d={area} /> : null}
                {points.length > 1 ? (
                  <path className="prj-portfolio__line" d={line} />
                ) : null}
                {points.length > 0 ? (
                  <circle
                    className="prj-portfolio__dot"
                    cx={points[points.length - 1].x}
                    cy={points[points.length - 1].y}
                    r={4}
                  />
                ) : null}
              </svg>
            </div>
            <div className="prj-portfolio__axis">
              <span>start</span>
              <span>mid</span>
              <span>now</span>
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}
