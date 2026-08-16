/**
 * The status vocabulary (HIVE-2.4, #5283).
 *
 * The ticket's claim is that a status string now means one thing everywhere — that a reader who
 * learns "amber means someone should look at this" on the versions table has learnt it for the
 * MCP health pill and the catalog freshness pill too. That claim is only worth as much as the
 * *seams* between those surfaces, so this suite spends most of its assertions there:
 *
 *   1. every value/tone pair the design authority names in `DESIGN.md` §3.1 resolves — the table
 *      is parsed out of the document rather than retyped here, so the two cannot drift;
 *   2. the surfaces that used to carry their own palettes (`Badge`, MCP health & freshness,
 *      the MCP grade glyph, the catalog grade chip) now agree on the tone for the same string;
 *   3. the two families that must *not* follow the theme — format pills and HTTP verb chips —
 *      carry a fixed hue class and no theme-dependent utility;
 *   4. colour is never the only signal (DESIGN.md §6): every specimen also prints text;
 *   5. the existing MCP/catalog call sites still render from exactly the props they passed
 *      before, which is the ticket's "compile unchanged" criterion made observable.
 *
 * The stylesheet's half — that the fixed hues exist, clear AA and stay in `rem` — is
 * `tests/hive-status-vocabulary-styles.test.ts`.
 */

import React from 'react';
import { readFileSync } from 'node:fs';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

import {
  Badge,
  FreshnessPill,
  GRADE_BANDS,
  GRADE_BAND_UNSCORED,
  GRADE_LETTERS,
  GradeGlyph,
  HTTP_METHODS,
  HealthPill,
  MethodChip,
  RecencyPill,
  STATUS_TONES,
  STATUS_TONE_DOT_CLASS,
  STATUS_TONE_SOFT_CLASS,
  STATUS_TONE_SOLID_CLASS,
  STATUS_TONE_TEXT_CLASS,
  badgeToneForStatus,
  gradeBand,
  normalizeHttpMethod,
  statusTone,
  type StatusTone,
} from '../src/app/components/ui';
import { FormatPill } from '../src/app/components/ui/catalog/FormatPill';
import { GradeChip } from '../src/app/components/ui/catalog/GradeChip';
import {
  mcpFreshnessMeta,
  mcpGradeGlyphStyle,
  mcpHealthMeta,
} from '../src/app/components/ade/dashboard/mcp/mcpUiPrimitives';
import { DESIGN_DOC_PATH } from './helpers/design-tokens';

/** A Tailwind palette utility — the thing a re-tokened surface must no longer contain. */
const PALETTE_LITERAL =
  /\b(?:bg|text|border|ring|stroke|fill)-(?:slate|gray|zinc|neutral|stone|emerald|green|lime|amber|yellow|orange|red|rose|pink|violet|purple|indigo|blue|sky|cyan|teal)-\d{2,3}\b/;

/**
 * Parse the "Status vocabulary → color" table out of `docs/mockups/DESIGN.md` §3.1.
 *
 * The two rows that describe the *fixed* families (`.fmt--*`, `.method--*`) name class prefixes
 * rather than value/tone pairs, and are skipped — they are covered by the styles suite.
 *
 * @returns Every `value → tone` pair the design authority states.
 */
function designDocVocabulary(): { value: string; tone: string }[] {
  const doc = readFileSync(DESIGN_DOC_PATH, 'utf8');
  const start = doc.indexOf('**Status vocabulary → color**');
  if (start === -1) throw new Error('DESIGN.md §3.1 no longer states the status vocabulary');

  const pairs: { value: string; tone: string }[] = [];
  let sawTable = false;
  for (const line of doc.slice(start).split('\n')) {
    if (!line.trim().startsWith('|')) {
      if (sawTable) break;
      continue;
    }
    sawTable = true;
    const cells = line.split('|').map((cell) => cell.trim());
    const [, vocabulary, values] = cells;
    if (!values || /^-+$/.test(vocabulary) || vocabulary === 'Vocabulary') continue;
    // The fixed-hue rows name classes, not states.
    if (values.includes('.fmt--') || values.includes('.method--')) continue;

    for (const segment of values.split('·')) {
      const codes = [...segment.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
      const tone = segment.replace(/`[^`]*`/g, '').replace(/\//g, '').trim();
      if (!codes.length || !tone) continue;
      for (const value of codes) pairs.push({ value, tone });
    }
  }
  if (!pairs.length) throw new Error('Parsed no vocabulary pairs out of DESIGN.md §3.1');
  return pairs;
}

const DESIGN_DOC_VOCABULARY = designDocVocabulary();

describe('the mapping is the one the design authority states', () => {
  it('parses a table with every vocabulary group in it', () => {
    // A guard on the parser: if DESIGN.md's table shape changes, fail here rather than
    // silently asserting nothing below.
    expect(DESIGN_DOC_VOCABULARY.length).toBeGreaterThanOrEqual(24);
  });

  it.each(DESIGN_DOC_VOCABULARY.map(({ value, tone }) => [value, tone]))(
    '%s resolves to the %s tone',
    (value, tone) => {
      expect(statusTone(value)).toBe(tone);
    },
  );

  it('answers the same for any casing or surrounding space the API sends', () => {
    expect(statusTone('Published')).toBe('ok');
    expect(statusTone('  PUBLISHED ')).toBe('ok');
  });

  it('falls back to neutral rather than guessing at a state it has not been told about', () => {
    expect(statusTone('flibbertigibbet')).toBe('neutral');
    expect(statusTone('')).toBe('neutral');
    expect(statusTone(null)).toBe('neutral');
  });

  it('gives every tone all four of the shapes a surface can need', () => {
    for (const tone of STATUS_TONES) {
      for (const map of [
        STATUS_TONE_SOFT_CLASS,
        STATUS_TONE_SOLID_CLASS,
        STATUS_TONE_DOT_CLASS,
        STATUS_TONE_TEXT_CLASS,
      ]) {
        expect([tone, map[tone as StatusTone]]).toEqual([tone, expect.any(String)]);
        expect(map[tone as StatusTone]).not.toMatch(PALETTE_LITERAL);
      }
    }
  });
});

describe('one string, one tone — across the surfaces that used to disagree', () => {
  it.each([
    ['healthy', 'healthy'],
    ['degraded', 'degraded'],
    ['unreachable', 'unreachable'],
    ['unknown', 'unknown'],
  ] as const)('the MCP health pill paints %s as the vocabulary does', (value, status) => {
    expect(mcpHealthMeta(status).tone).toBe(statusTone(value));
  });

  it.each([
    ['stale', 'stale'],
    ['backoff', 'backoff'],
    ['quarantined', 'quarantined'],
  ] as const)('the freshness pill paints %s as the vocabulary does', (value, freshness) => {
    expect(mcpFreshnessMeta(freshness)!.tone).toBe(statusTone(value));
  });

  it('paints a failing endpoint the way the vocabulary paints a failure', () => {
    // `failing` is the catalog's spelling of the vocabulary's `failed`.
    expect(mcpFreshnessMeta('failing')!.tone).toBe(statusTone('failed'));
  });

  it.each([...GRADE_LETTERS])('grade %s is one band, not one per surface', (letter) => {
    expect(mcpGradeGlyphStyle(letter).chipClass).toBe(GRADE_BANDS[letter].solidClass);
    expect(gradeBand(letter).solidClass).toBe(GRADE_BANDS[letter].solidClass);
  });

  it('renders the catalog chip and the MCP glyph of one grade in the same fill', () => {
    render(
      <>
        <GradeChip grade="C" />
        <GradeGlyph grade="C" score={71} />
      </>,
    );
    const chipFill = GRADE_BANDS.C.solidClass.split(' ')[0];
    expect(screen.getByTestId('grade-chip').className).toContain(chipFill);
    expect(screen.getByRole('img', { name: /Grade C/ }).innerHTML).toContain(chipFill);
  });

  it('places an ungraded item in a well rather than inventing a sixth band', () => {
    expect(gradeBand(null)).toBe(GRADE_BAND_UNSCORED);
    expect(gradeBand('E')).toBe(GRADE_BAND_UNSCORED);
    expect(GRADE_BAND_UNSCORED.tone).toBe('outline');
  });
});

describe('Badge — the vocabulary at a call site', () => {
  it.each([
    ['published', 'ok'],
    ['pending', 'warn'],
    ['suspended', 'warn'],
    ['archived', 'outline'],
    ['private', 'violet'],
  ] as const)('renders %s in the %s tone', (status, tone) => {
    render(<Badge status={status}>{status}</Badge>);
    const badge = screen.getByText(status);
    for (const className of STATUS_TONE_SOFT_CLASS[tone].split(' ')) {
      expect(badge.className).toContain(className);
    }
  });

  it('writes the status to the DOM, so a page can style or query the state', () => {
    render(<Badge status="Deprecated">Deprecated</Badge>);
    expect(screen.getByText('Deprecated')).toHaveAttribute('data-status', 'Deprecated');
  });

  it('keeps badgeToneForStatus working for the call sites that already use it', () => {
    expect(badgeToneForStatus('failed')).toBe('danger');
    expect(badgeToneForStatus('nonsense')).toBe('neutral');
  });

  it('never leaves colour as the only signal — the label rides along', () => {
    render(
      <Badge status="degraded" dot>
        Degraded
      </Badge>,
    );
    expect(screen.getByTestId('badge-dot')).toBeInTheDocument();
    expect(screen.getByText('Degraded')).toBeInTheDocument();
  });
});

describe('MethodChip — a verb is an identity, not a state', () => {
  it.each([...HTTP_METHODS])('gives %s its own fixed hue class', (method) => {
    render(<MethodChip method={method} />);
    const chip = screen.getByTestId('method-chip');
    expect(chip.className).toContain(`method--${method}`);
    // A fixed hue must not be reachable through a theme-dependent utility.
    expect(chip.className).not.toMatch(PALETTE_LITERAL);
    expect(chip.className).not.toMatch(/dark:/);
  });

  it('prints the verb, so the hue is never carrying the meaning alone', () => {
    render(<MethodChip method="patch" />);
    expect(screen.getByTestId('method-chip')).toHaveTextContent('PATCH');
  });

  it('accepts whatever casing the spec used', () => {
    expect(normalizeHttpMethod('GET')).toBe('get');
    expect(normalizeHttpMethod(' Post ')).toBe('post');
    expect(normalizeHttpMethod('quiche')).toBeNull();
    expect(normalizeHttpMethod('')).toBeNull();
  });

  it('keeps a non-standard verb on the neutral chip rather than dropping it', () => {
    render(<MethodChip method="purge" />);
    const chip = screen.getByTestId('method-chip');
    expect(chip).toHaveTextContent('PURGE');
    expect(chip.className).toContain('method--unknown');
    expect(chip).toHaveAttribute('data-method', 'purge');
  });

  it('renders nothing when there is no method', () => {
    const { container, rerender } = render(<MethodChip method={null} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<MethodChip method="   " />);
    expect(screen.queryByTestId('method-chip')).not.toBeInTheDocument();
  });

  it('gives up its aligned left edge only when asked', () => {
    const { rerender } = render(<MethodChip method="get" />);
    expect(screen.getByTestId('method-chip').className).not.toContain('method--fit');
    rerender(<MethodChip method="get" block={false} />);
    expect(screen.getByTestId('method-chip').className).toContain('method--fit');
  });
});

describe('FormatPill — a format is an identity too', () => {
  it.each([
    ['openapi-3.1', 'OpenAPI'],
    ['asyncapi', 'AsyncAPI'],
    ['graphql', 'GraphQL'],
    ['x12', 'EDI X12'],
    ['copybook', 'COBOL Copybook'],
  ])('renders %s with its label and a fixed hue', (format, label) => {
    render(<FormatPill format={format} />);
    const pill = screen.getByTestId('format-pill');
    expect(pill).toHaveTextContent(label);
    expect(pill.className).toContain('fmt fmt--');
    expect(pill.className).not.toMatch(PALETTE_LITERAL);
    expect(pill.className).not.toMatch(/dark:/);
  });

  it('shows a format the same way on the two screens that name it', () => {
    // The catalog table's pill and the supported-formats gallery tile resolve the same class.
    const { rerender } = render(<FormatPill format="grpc" />);
    const first = screen.getByTestId('format-pill').className;
    rerender(<FormatPill format="gRPC" />);
    expect(screen.getByTestId('format-pill').className).toBe(first);
  });
});

describe('the folded MCP and catalog pills — same props, tokens underneath', () => {
  it('renders the health pill from its original props', () => {
    render(<HealthPill discoveryStatus="degraded" />);
    const pill = screen.getByText('Degraded');
    expect(pill).toHaveAttribute('data-status', 'degraded');
    expect(pill.className).toContain(STATUS_TONE_TEXT_CLASS.warn);
    expect(pill.className).not.toMatch(PALETTE_LITERAL);
  });

  it('keeps the dot-only health pill readable to a screen reader', () => {
    render(<HealthPill status="unreachable" dotOnly />);
    // Colour alone would say nothing here, so the label is still in the accessibility tree.
    expect(screen.getByText('Unreachable')).toHaveClass('sr-only');
  });

  it('renders the freshness pill from its original props, and nothing when fresh', () => {
    const { container, rerender } = render(<FreshnessPill freshness="fresh" />);
    expect(container).toBeEmptyDOMElement();
    rerender(<FreshnessPill freshness="quarantined" lastKnownGoodAt="2026-01-01T00:00:00Z" />);
    const pill = screen.getByText('Quarantined');
    expect(pill).toHaveAttribute('data-status', 'quarantined');
    expect(pill.className).toContain(STATUS_TONE_TEXT_CLASS.danger);
  });

  it('renders the recency pill from its original props, in supporting ink', () => {
    render(
      <RecencyPill
        timestamp="2026-01-15T09:30:00.000Z"
        nowMs={Date.parse('2026-01-15T12:00:00.000Z')}
      />,
    );
    // The label sits in its own span; the ink is on the pill that wraps it.
    const pill = screen.getByText(/Last discovered/).parentElement!;
    expect(pill).toHaveTextContent('Last discovered 2h ago');
    expect(pill.className).toContain('text-fg-muted');
    expect(pill.className).not.toMatch(PALETTE_LITERAL);
  });

  it('renders the grade glyph from its original props, with the grade said out loud', () => {
    render(<GradeGlyph grade="B" score={88} variant="gauge" size="lg" />);
    expect(screen.getByRole('img', { name: 'Grade B, score 88 of 100' })).toBeInTheDocument();
  });

  it('renders the grade chip from its original props', () => {
    render(<GradeChip grade="A-" />);
    const chip = screen.getByTestId('grade-chip');
    expect(chip).toHaveTextContent('A');
    expect(chip).toHaveAttribute('data-grade', 'A');
    expect(chip.className).not.toMatch(PALETTE_LITERAL);
  });
});
