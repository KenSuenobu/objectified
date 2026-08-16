/**
 * Render tests for the catalog Grade chip (MFI-24.4, #4084): GradeChip + normalizeGradeLetter.
 *
 * Pins the acceptance criteria — the `gc-A…F` letter chip shows the band letter and its colour
 * tracks the band (A emerald → F red) — plus the degradation contracts: a present-but-unknown grade
 * keeps its raw letter on a neutral tile, and an absent grade renders a slate placeholder.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import {
  GradeChip,
  GRADE_CHIP_TONE_CLASS,
  normalizeGradeLetter,
} from '../src/app/components/ui/catalog/GradeChip';
import { mcpGradeGlyphStyle } from '../src/app/components/ade/dashboard/mcp/mcpUiPrimitives';

describe('normalizeGradeLetter', () => {
  it('maps recognised band tokens to their letter (uppercased first char)', () => {
    expect(normalizeGradeLetter('A')).toBe('A');
    expect(normalizeGradeLetter('a')).toBe('A');
    expect(normalizeGradeLetter('A-')).toBe('A');
    expect(normalizeGradeLetter(' b ')).toBe('B');
    expect(normalizeGradeLetter('F')).toBe('F');
  });

  it('returns null for absent or non-band grades', () => {
    expect(normalizeGradeLetter(null)).toBeNull();
    expect(normalizeGradeLetter(undefined)).toBeNull();
    expect(normalizeGradeLetter('   ')).toBeNull();
    // E is not one of the A/B/C/D/F bands.
    expect(normalizeGradeLetter('E')).toBeNull();
  });
});

describe('GradeChip', () => {
  it.each(['A', 'B', 'C', 'D', 'F'] as const)('renders %s with its band colour', (letter) => {
    render(<GradeChip grade={letter} />);
    const chip = screen.getByTestId('grade-chip');
    expect(chip).toHaveTextContent(letter);
    expect(chip.className).toContain(GRADE_CHIP_TONE_CLASS[letter]);
    expect(chip).toHaveAttribute('title', `Grade ${letter}`);
  });

  it('keeps a present-but-unknown grade on the neutral unscored tile without dropping it', () => {
    render(<GradeChip grade="E" />);
    const chip = screen.getByTestId('grade-chip');
    expect(chip).toHaveTextContent('E');
    // HIVE-2.4 (#5283): the unscored tile is a token well, so it follows the theme.
    expect(chip.className).toContain('bg-inset');
    expect(chip).toHaveAttribute('data-grade', 'unscored');
  });

  it('renders a neutral placeholder when the grade is absent', () => {
    render(<GradeChip grade={null} />);
    const chip = screen.getByTestId('grade-chip');
    expect(chip).toHaveTextContent('–');
    expect(chip.className).toContain('bg-inset');
    expect(chip).toHaveAttribute('title', 'No grade captured yet');
  });

  it('shares its bands with the MCP grade glyph, so one B is one green', () => {
    // The chip and the glyph read the same `GRADE_BANDS`; this is the seam that used to drift.
    for (const letter of ['A', 'B', 'C', 'D', 'F'] as const) {
      expect(GRADE_CHIP_TONE_CLASS[letter]).toBe(mcpGradeGlyphStyle(letter).chipClass);
    }
  });
});
