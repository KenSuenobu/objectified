'use client';

/**
 * `<GradeChip>` (MFI-24.4, #4084; folded onto the shared bands in HIVE-2.4, #5283) — the compact
 * letter chip for a captured quality grade.
 *
 * Renders a single band letter (A best → F worst) on a solid, band-coloured tile. The bands come
 * from `ui/statusVocabulary.ts`, which the MCP `GradeGlyph` reads as well — before that, the two
 * surfaces each carried their own A–F palette and the same B was two different greens. An
 * unrecognised-but-present grade keeps its raw first letter on the neutral "unscored" tile (so
 * nothing is silently dropped); an absent grade shows a `–` placeholder on the same tile.
 *
 * Kept in `ui/catalog/*` alongside the format/protocol pills so it can be shared with the catalog
 * table (this ticket) and the grade surfaces of neighbouring tickets (e.g. MFI-25.5).
 */

import * as React from 'react';
import { cn } from '../../../../../lib/utils';
import {
  GRADE_BANDS,
  gradeBand,
  normalizeGradeLetter,
  type GradeLetter,
} from '../statusVocabulary';

/** The A–F quality bands the chip colours. */
export type GradeChipLetter = GradeLetter;

export { normalizeGradeLetter };

/**
 * Per-band solid tile class (fill + a foreground that stays legible on it).
 *
 * Kept under its original name because the catalog surfaces and the MFI-24.4 suite reach for it;
 * it is now a projection of the shared {@link GRADE_BANDS} rather than a second palette.
 */
export const GRADE_CHIP_TONE_CLASS: Readonly<Record<GradeChipLetter, string>> = {
  A: GRADE_BANDS.A.solidClass,
  B: GRADE_BANDS.B.solidClass,
  C: GRADE_BANDS.C.solidClass,
  D: GRADE_BANDS.D.solidClass,
  F: GRADE_BANDS.F.solidClass,
};

const CHIP_BASE = 'inline-grid h-6 w-6 place-items-center rounded-md text-xs font-bold leading-none';

export interface GradeChipProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** The raw grade token off the catalog item (a letter, or a fuller grade like `A-`). */
  grade: string | null | undefined;
}

/**
 * Render the grade chip. A recognised band letter gets its solid band colour; a present-but-unknown
 * grade keeps its raw first letter on the neutral unscored tile; an absent grade renders a `–`.
 */
export const GradeChip = React.forwardRef<HTMLSpanElement, GradeChipProps>(
  ({ grade, className, ...props }, ref) => {
    const band = gradeBand(grade);
    const hasGrade = Boolean(grade && grade.trim());
    const display = hasGrade ? grade!.trim().charAt(0).toUpperCase() : '–';

    return (
      <span
        ref={ref}
        data-grade={band.letter ?? 'unscored'}
        className={cn(CHIP_BASE, band.solidClass, className)}
        title={hasGrade ? `Grade ${display}` : 'No grade captured yet'}
        data-testid="grade-chip"
        {...props}
      >
        {display}
      </span>
    );
  },
);
GradeChip.displayName = 'GradeChip';
