/**
 * exportFidelityPreview — pure helpers behind the fidelity warning panel (MFX-6.2, #3856).
 *
 * Covers: the DROP/APPROX/SYNTH/OK badge labels and palettes, the worst-first report
 * ordering, the "Export anyway" acknowledgement gate, and the preserved-% ring geometry.
 */

import {
  acknowledgementPhraseMatches,
  EXPORT_TYPES_ONLY_ACK_PHRASE,
  kindDescription,
  kindGlyph,
  kindLabel,
  requiresExportAcknowledgement,
  ringGeometry,
  sortReportItemsWorstFirst,
  type LossItem,
} from '../src/app/components/ade/dashboard/export/exportFidelityPreview';

describe('kindLabel', () => {
  it('prints the uppercase badge for every kind', () => {
    expect(kindLabel('drop')).toBe('DROP');
    expect(kindLabel('approx')).toBe('APPROX');
    expect(kindLabel('synth')).toBe('SYNTH');
    expect(kindLabel('ok')).toBe('OK');
  });
});

describe('kindGlyph / kindDescription (MFX-41.5)', () => {
  it('gives every kind its own glyph, so a chip is never colour-only', () => {
    expect(kindGlyph('drop')).toBe('✕');
    expect(kindGlyph('approx')).toBe('≈');
    expect(kindGlyph('synth')).toBe('✚');
    expect(kindGlyph('ok')).toBe('✓');
    expect(new Set((['drop', 'approx', 'synth', 'ok'] as const).map(kindGlyph)).size).toBe(4);
  });

  it('expands the three-letter jargon for screen readers', () => {
    expect(kindDescription('drop')).toMatch(/dropped/);
    expect(kindDescription('approx')).toMatch(/approximated/);
    expect(kindDescription('synth')).toMatch(/synthesized/);
    expect(kindDescription('ok')).toMatch(/clean/);
  });
});

describe('sortReportItemsWorstFirst', () => {
  const item = (overrides: Partial<LossItem>): LossItem => ({
    construct: 'User.email',
    kind: 'ok',
    severity: 'info',
    message: 'Carried faithfully.',
    target_mapping: null,
    ...overrides,
  });

  it('orders by kind first: drop → approx → synth → ok', () => {
    const items = [
      item({ construct: 'a', kind: 'ok' }),
      item({ construct: 'b', kind: 'synth' }),
      item({ construct: 'c', kind: 'drop' }),
      item({ construct: 'd', kind: 'approx' }),
    ];
    expect(sortReportItemsWorstFirst(items).map((i) => i.kind)).toEqual([
      'drop',
      'approx',
      'synth',
      'ok',
    ]);
  });

  it('orders by severity within a kind: critical → warn → info', () => {
    const items = [
      item({ construct: 'a', kind: 'drop', severity: 'info' }),
      item({ construct: 'b', kind: 'drop', severity: 'critical' }),
      item({ construct: 'c', kind: 'drop', severity: 'warn' }),
    ];
    expect(sortReportItemsWorstFirst(items).map((i) => i.severity)).toEqual([
      'critical',
      'warn',
      'info',
    ]);
  });

  it('breaks remaining ties by construct key for a stable read', () => {
    const items = [
      item({ construct: 'zebra', kind: 'drop', severity: 'warn' }),
      item({ construct: 'alpha', kind: 'drop', severity: 'warn' }),
    ];
    expect(sortReportItemsWorstFirst(items).map((i) => i.construct)).toEqual(['alpha', 'zebra']);
  });

  it('returns a new array and leaves the input untouched', () => {
    const items = [item({ kind: 'ok' }), item({ kind: 'drop' })];
    const sorted = sortReportItemsWorstFirst(items);
    expect(sorted).not.toBe(items);
    expect(items.map((i) => i.kind)).toEqual(['ok', 'drop']);
  });
});

describe('requiresExportAcknowledgement', () => {
  it('never asks for a lossless conversion', () => {
    expect(requiresExportAcknowledgement('lossless')).toBe(false);
  });

  it('requires the acknowledgement for lossy and types-only conversions', () => {
    expect(requiresExportAcknowledgement('lossy')).toBe(true);
    expect(requiresExportAcknowledgement('types-only')).toBe(true);
  });
});

describe('ringGeometry', () => {
  const RADIUS = 40;
  const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

  it('shows the full ring at 100% preserved', () => {
    const ring = ringGeometry(100, RADIUS);
    expect(ring.circumference).toBeCloseTo(CIRCUMFERENCE);
    expect(ring.dashOffset).toBeCloseTo(0);
  });

  it('hides the ring entirely at 0% preserved', () => {
    expect(ringGeometry(0, RADIUS).dashOffset).toBeCloseTo(CIRCUMFERENCE);
  });

  it('covers half the circumference at 50%', () => {
    expect(ringGeometry(50, RADIUS).dashOffset).toBeCloseTo(CIRCUMFERENCE / 2);
  });

  it('clamps out-of-range percentages to 0–100', () => {
    expect(ringGeometry(-10, RADIUS).dashOffset).toBeCloseTo(CIRCUMFERENCE);
    expect(ringGeometry(150, RADIUS).dashOffset).toBeCloseTo(0);
  });
});

describe('acknowledgementPhraseMatches (MFX-42.4)', () => {
  it('matches the canonical types-only phrase exactly', () => {
    expect(acknowledgementPhraseMatches(EXPORT_TYPES_ONLY_ACK_PHRASE)).toBe(true);
  });

  it('ignores surrounding whitespace and casing', () => {
    expect(acknowledgementPhraseMatches('  Export Produces A Types-Only Artifact ')).toBe(true);
    expect(acknowledgementPhraseMatches('EXPORT PRODUCES A TYPES-ONLY ARTIFACT')).toBe(true);
  });

  it('rejects partial, altered, or empty input', () => {
    expect(acknowledgementPhraseMatches('')).toBe(false);
    expect(acknowledgementPhraseMatches('export produces')).toBe(false);
    expect(acknowledgementPhraseMatches('export produces a types only artifact')).toBe(false);
    expect(acknowledgementPhraseMatches('produce a types-only artifact')).toBe(false);
  });
});
