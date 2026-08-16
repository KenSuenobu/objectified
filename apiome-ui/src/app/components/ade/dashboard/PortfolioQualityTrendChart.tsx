'use client';

import { useId } from 'react';
import type { PortfolioQualityPoint } from '@/app/utils/project-quality-score-history';
import { SVG_TEXT_SIZE } from '../../ui/svgTypography';

interface PortfolioQualityTrendChartProps {
  series: PortfolioQualityPoint[];
  className?: string;
}

/**
 * Area chart for portfolio average quality over time (aligned with dashboard mockups).
 */
export function PortfolioQualityTrendChart({ series, className }: PortfolioQualityTrendChartProps) {
  const gradId = `pfq-${useId().replace(/\W/g, '')}`;
  const values = series.map((p) => p.avgOverall);
  if (values.length === 0) {
    return (
      <div className={`flex min-h-[9rem] items-center justify-center text-sm text-gray-500 dark:text-gray-400 ${className ?? ''}`}>
        Quality trends appear after you import specs into one or more projects.
      </div>
    );
  }

  const w = 600;
  const h = 140;
  const padL = 36;
  const padR = 12;
  const padT = 16;
  const padB = 28;
  const chartW = w - padL - padR;
  const chartH = h - padT - padB;
  const yMin = 55;
  const yMax = 100;

  const scaleY = (v: number) => {
    const t = (Math.min(yMax, Math.max(yMin, v)) - yMin) / (yMax - yMin);
    return padT + chartH * (1 - t);
  };

  const n = values.length;
  const pts = values.map((overall, i) => {
    const x = padL + (n === 1 ? chartW / 2 : (i / (n - 1)) * chartW);
    const y = scaleY(overall);
    return { x, y, overall };
  });

  const pathLine = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ');
  const pathArea = `${pathLine} L ${pts[pts.length - 1].x.toFixed(2)} ${padT + chartH} L ${pts[0].x.toFixed(2)} ${padT + chartH} Z`;

  const lastAvg = values[values.length - 1];

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={`h-36 w-full ${className ?? ''}`} aria-hidden>
      <defs>
        <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#6366f1" stopOpacity={0.45} />
          <stop offset="1" stopColor="#6366f1" stopOpacity={0} />
        </linearGradient>
      </defs>
      <g className="text-gray-200 dark:text-gray-600" stroke="currentColor" strokeDasharray="3 3" strokeWidth={0.5}>
        <line x1={padL} y1={scaleY(100)} x2={w - padR} y2={scaleY(100)} />
        <line x1={padL} y1={scaleY(85)} x2={w - padR} y2={scaleY(85)} />
        <line x1={padL} y1={scaleY(70)} x2={w - padR} y2={scaleY(70)} />
      </g>
      <g fontSize={SVG_TEXT_SIZE.tick} className="fill-gray-400 font-mono">
        <text x={2} y={scaleY(100) + 3}>
          100
        </text>
        <text x={6} y={scaleY(85) + 3}>
          85
        </text>
        <text x={6} y={scaleY(70) + 3}>
          70
        </text>
      </g>
      <path d={pathArea} fill={`url(#${gradId})`} />
      <path d={pathLine} fill="none" stroke="#6366f1" strokeWidth={2} />
      <g fill="#6366f1">
        {pts.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={3} />
        ))}
      </g>
      <g fontSize={SVG_TEXT_SIZE.tick} className="fill-gray-400 font-mono">
        <text x={padL} y={h - 6}>
          start
        </text>
        <text x={w / 2 - 24} y={h - 6}>
          mid
        </text>
        <text x={w - padR - 28} y={h - 6}>
          now
        </text>
      </g>
      <text
        x={w - padR - 52}
        y={padT + 4}
        fontSize={SVG_TEXT_SIZE.label}
        className="fill-emerald-600 font-semibold dark:fill-emerald-400"
      >
        avg {lastAvg}
      </text>
    </svg>
  );
}
