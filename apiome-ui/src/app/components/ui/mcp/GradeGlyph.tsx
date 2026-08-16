'use client';

import * as React from 'react';
import { cn } from '../../../../../lib/utils';
import {
  getNumericScoreTier,
  letterGradeFromOverallPercent,
} from '../../../utils/numeric-score-tier';
import { mcpGradeGlyphStyle } from '../../ade/dashboard/mcp/mcpUiPrimitives';

/** Rendered form of the grade glyph. */
type GradeGlyphVariant = 'glyph' | 'gauge';

/** Glyph size — `sm`/`md` are card/header chips; `lg` is the headline gauge. */
type GradeGlyphSize = 'sm' | 'md' | 'lg';

export interface GradeGlyphProps extends React.HTMLAttributes<HTMLDivElement> {
  /** A–F letter grade. When omitted but `score` is given, it is derived from the score. */
  grade?: string | null;
  /** 0–100 quality score. Shown beside/under the letter unless `showScore` is false. */
  score?: number | null;
  /** `glyph` (a solid square chip, the lead signal) or `gauge` (a 0–100 ring). */
  variant?: GradeGlyphVariant;
  size?: GradeGlyphSize;
  /** Whether to show the numeric score next to the letter (glyph) / under it (gauge). */
  showScore?: boolean;
}

/** Square-chip dimensions + type scale per size. */
const GLYPH_SIZES: Record<GradeGlyphSize, { box: string; letter: string; score: string }> = {
  sm: { box: 'h-7 w-7 rounded-md', letter: 'text-sm', score: 'text-xs' },
  md: { box: 'h-9 w-9 rounded-lg', letter: 'text-base', score: 'text-sm' },
  lg: { box: 'h-11 w-11 rounded-lg', letter: 'text-lg', score: 'text-base' },
};

/** Gauge (ring) diameter per size. */
const GAUGE_SIZES: Record<GradeGlyphSize, { box: string; letter: string; score: string }> = {
  sm: { box: 'h-16 w-16', letter: 'text-xl', score: 'text-2xs' },
  md: { box: 'h-24 w-24', letter: 'text-3xl', score: 'text-xs' },
  lg: { box: 'h-32 w-32', letter: 'text-4xl', score: 'text-xs' },
};

/** Resolve the effective letter: explicit grade wins, else derive from the score, else none. */
function resolveLetter(grade?: string | null, score?: number | null): string | null {
  if (typeof grade === 'string' && grade.trim()) return grade.trim().toUpperCase();
  if (typeof score === 'number' && Number.isFinite(score)) return letterGradeFromOverallPercent(score);
  return null;
}

/**
 * `<GradeGlyph>` — the A–F + 0–100 grade signal that leads every MCP card, header, and the lint
 * gauge. Two forms share one color language (driven by {@link mcpGradeGlyphStyle} and the shared
 * numeric score bands):
 *
 * - `variant="glyph"` (default): a solid colored square with the letter, optionally `· 82`.
 * - `variant="gauge"`: a ring swept to the score with the letter centered and the score beneath.
 *
 * All colors come from the token mappings — no literals here or in consumers. An absent score/grade
 * renders a neutral "unscored" glyph.
 */
export const GradeGlyph = React.forwardRef<HTMLDivElement, GradeGlyphProps>(
  (
    {
      grade,
      score,
      variant = 'glyph',
      size = 'md',
      showScore = true,
      className,
      ...props
    },
    ref,
  ) => {
    const letter = resolveLetter(grade, score);
    const style = mcpGradeGlyphStyle(letter);
    const hasScore = typeof score === 'number' && Number.isFinite(score);
    const roundedScore = hasScore ? Math.round(score as number) : null;
    const display = letter ?? '—';
    const ariaLabel =
      letter === null && roundedScore === null
        ? 'Unscored'
        : `Grade ${display}${roundedScore !== null ? `, score ${roundedScore} of 100` : ''}`;

    if (variant === 'gauge') {
      const dims = GAUGE_SIZES[size];
      const radius = 52;
      const circumference = 2 * Math.PI * radius;
      const tier = roundedScore !== null ? getNumericScoreTier(roundedScore) : null;
      const ringClass = tier ? tier.gaugeStrokeClass : style.ringClass;
      const dash = Math.max(0, Math.min(100, roundedScore ?? 0)) / 100;
      return (
        <div
          ref={ref}
          role="img"
          aria-label={ariaLabel}
          className={cn('relative shrink-0', dims.box, className)}
          {...props}
        >
          <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90" aria-hidden>
            <circle
              cx="60"
              cy="60"
              r={radius}
              fill="none"
              strokeWidth="10"
              className="stroke-gray-200 dark:stroke-gray-700"
            />
            <circle
              cx="60"
              cy="60"
              r={radius}
              fill="none"
              strokeWidth="10"
              strokeLinecap="round"
              className={cn(ringClass, 'transition-all duration-500')}
              stroke="currentColor"
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - dash)}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className={cn('font-bold leading-none', dims.letter, style.textClass)}>
              {display}
            </span>
            {showScore && roundedScore !== null ? (
              <span
                className={cn(
                  'mt-1 font-medium tabular-nums text-gray-500 dark:text-gray-400',
                  dims.score,
                )}
              >
                {roundedScore} / 100
              </span>
            ) : null}
          </div>
        </div>
      );
    }

    const dims = GLYPH_SIZES[size];
    return (
      <span
        ref={ref as React.Ref<HTMLSpanElement>}
        role="img"
        aria-label={ariaLabel}
        className={cn('inline-flex items-center gap-2', className)}
        {...props}
      >
        <span
          className={cn(
            'inline-grid place-items-center font-bold leading-none',
            dims.box,
            dims.letter,
            style.chipClass,
          )}
        >
          {display}
        </span>
        {showScore && roundedScore !== null ? (
          <span className={cn('font-semibold tabular-nums', dims.score, style.textClass)}>
            {roundedScore}
          </span>
        ) : null}
      </span>
    );
  },
);
GradeGlyph.displayName = 'GradeGlyph';
