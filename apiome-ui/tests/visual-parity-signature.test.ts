/**
 * Turning a browser measurement into a token-space signature (HIVE-10.1, #5337).
 *
 * The browser half of the harness only reads pixels; every judgement about what those pixels
 * *mean* is made here, by pure functions, which is what makes the whole thing testable at all.
 * Two of those judgements are load-bearing and neither is obvious:
 *
 *   * **what counts as "on the ladder"** — a measurement within a tolerance of a token's
 *     value is that token, and the *order* of the candidate list decides ties, which is how a
 *     20 px padding reads as `--card-pad` rather than as the `--space-5` that shares its value;
 *   * **what a pill's radius is** — the mockups write `--r-full: 999px` and Tailwind's
 *     `rounded-full` resolves to tens of millions. Both mean "rounder than the box", so
 *     anything at or above `--r-full` has to read as `--r-full` or every app pill reports as
 *     a hard-coded radius.
 */

import type { RawSignature } from '../e2e/visual/collect';
import {
  SNAP_TOLERANCE_PX,
  buildSignature,
  dominantToken,
  snapColour,
  snapLength,
  totalWeight,
} from '../e2e/visual/signature';
import { OFF_SCALE, TYPE_TOKENS } from '../e2e/visual/tokens';

/** A minimal resolved ladder, in the browser's own serialisation. */
const TOKENS: Record<string, string> = {
  'fs-xs': '12px',
  'fs-sm': '13px',
  'fs-md': '14px',
  'fs-3xl': '24px',
  'space-3': '12px',
  'space-5': '20px',
  'card-pad': '20px',
  'r-md': '10px',
  'r-lg': '14px',
  'r-full': '999px',
  'control-h': '36px',
  'control-h-sm': '30px',
  fg: 'rgb(27, 26, 23)',
  'fg-muted': 'rgb(98, 95, 89)',
  'bg-surface': 'rgb(255, 255, 255)',
  // A token the page never declared. The collector reports these as empty strings.
  honey: '',
};

/**
 * A raw measurement with everything empty, for a test to fill in only what it cares about.
 *
 * @param overrides The parts this test is about.
 * @returns A complete raw measurement.
 */
function rawSignature(overrides: Partial<RawSignature> = {}): RawSignature {
  return {
    tokens: TOKENS,
    scope: { width: 1000, height: 800 },
    landmarks: {
      header: null,
      breadcrumb: null,
      title: null,
      description: null,
      actions: null,
      tabs: null,
      body: null,
    },
    text: [],
    surfaces: [],
    paddings: [],
    controls: [],
    gaps: [],
    tables: [],
    ...overrides,
  };
}

describe('snapping a length onto the token ladder', () => {
  it('matches a token exactly', () => {
    expect(snapLength(24, TOKENS, TYPE_TOKENS)).toBe('fs-3xl');
  });

  it('matches within the tolerance, and not beyond it', () => {
    expect(snapLength(14 + SNAP_TOLERANCE_PX, TOKENS, TYPE_TOKENS)).toBe('fs-md');
    expect(snapLength(14 + SNAP_TOLERANCE_PX + 0.1, TOKENS, TYPE_TOKENS)).toBe(OFF_SCALE);
  });

  it('reports a hard-coded value as off the scale', () => {
    expect(snapLength(17, TOKENS, TYPE_TOKENS)).toBe(OFF_SCALE);
  });

  it('lets the candidate order break a tie between two tokens of equal value', () => {
    expect(snapLength(20, TOKENS, ['card-pad', 'space-5'])).toBe('card-pad');
    expect(snapLength(20, TOKENS, ['space-5', 'card-pad'])).toBe('space-5');
  });

  it('skips a token the page never declared', () => {
    expect(snapLength(20, TOKENS, ['honey', 'card-pad'])).toBe('card-pad');
  });

  it('honours a caller-supplied tolerance', () => {
    expect(snapLength(15, TOKENS, TYPE_TOKENS, 1)).toBe('fs-md');
  });
});

describe('snapping a colour onto the palette', () => {
  it('matches the browser serialisation exactly', () => {
    expect(snapColour('rgb(98, 95, 89)', TOKENS)).toBe('fg-muted');
  });

  it('reports a colour no token carries as off the scale', () => {
    expect(snapColour('rgb(1, 2, 3)', TOKENS)).toBe(OFF_SCALE);
  });

  it('never matches a token the page did not declare', () => {
    expect(snapColour('', TOKENS, ['honey'])).toBe(OFF_SCALE);
  });
});

describe('reading a distribution', () => {
  it('sums every bucket', () => {
    expect(totalWeight({ 'fs-md': 3, 'fs-sm': 2, [OFF_SCALE]: 1 })).toBe(6);
  });

  it('finds the heaviest bucket, ignoring what is off the scale', () => {
    expect(dominantToken({ 'fs-md': 3, [OFF_SCALE]: 99 })).toBe('fs-md');
  });

  it('breaks a tie on name, so key order never decides it', () => {
    expect(dominantToken({ 'fs-sm': 2, 'fs-md': 2 })).toBe('fs-md');
    expect(dominantToken({ 'fs-md': 2, 'fs-sm': 2 })).toBe('fs-md');
  });

  it('has no answer for a distribution with nothing on the scale', () => {
    expect(dominantToken({ [OFF_SCALE]: 4 })).toBeNull();
    expect(dominantToken({})).toBeNull();
  });
});

describe('building the signature', () => {
  it('expresses landmark boxes as a fraction of the page width', () => {
    const signature = buildSignature(
      rawSignature({
        landmarks: {
          ...rawSignature().landmarks,
          title: {
            box: { x: 32, y: 40, width: 500, height: 30 },
            fontSizePx: 24,
            fontWeight: 600,
          },
        },
      }),
      'app'
    );
    expect(signature.landmarks.title.present).toBe(true);
    expect(signature.landmarks.title.x).toBeCloseTo(0.032, 5);
    expect(signature.landmarks.title.width).toBeCloseTo(0.5, 5);
    expect(signature.landmarks.title.typeToken).toBe('fs-3xl');
    expect(signature.landmarks.title.fontWeight).toBe(600);
  });

  it('reports a landmark the page does not have as absent', () => {
    const signature = buildSignature(rawSignature(), 'mockup');
    expect(signature.landmarks.header.present).toBe(false);
    expect(signature.landmarks.header.typeToken).toBe(OFF_SCALE);
  });

  it('weights the type ladder by how much text is set in each step', () => {
    const signature = buildSignature(
      rawSignature({
        text: [
          { fontSizePx: 14, fontWeight: 400, colour: 'rgb(27, 26, 23)', chars: 100 },
          { fontSizePx: 12, fontWeight: 400, colour: 'rgb(98, 95, 89)', chars: 20 },
          { fontSizePx: 17, fontWeight: 400, colour: 'rgb(1, 2, 3)', chars: 5 },
        ],
      }),
      'app'
    );
    expect(signature.type).toEqual({ 'fs-md': 100, 'fs-xs': 20, [OFF_SCALE]: 5 });
    expect(signature.ink).toEqual({ fg: 100, 'fg-muted': 20, [OFF_SCALE]: 5 });
    expect(dominantToken(signature.type)).toBe('fs-md');
  });

  it('reads any radius at or above --r-full as --r-full, however it was spelled', () => {
    const signature = buildSignature(
      rawSignature({
        surfaces: [
          { radiusPx: 14, borderPx: 1 },
          { radiusPx: 999, borderPx: 0 },
          { radiusPx: 33554400, borderPx: 0 },
        ],
      }),
      'app'
    );
    expect(signature.radii).toEqual({ 'r-lg': 1, 'r-full': 2 });
  });

  it('keeps spacing as raw measurements, because that is what is comparable', () => {
    const signature = buildSignature(
      rawSignature({ gaps: [24, 5, 8], paddings: [10, 14, 14] }),
      'mockup'
    );
    expect(signature.gaps).toEqual([24, 5, 8]);
    expect(signature.paddings).toEqual([10, 14, 14]);
  });

  it('snaps control heights onto the control ladder', () => {
    const signature = buildSignature(rawSignature({ controls: [36, 30, 30, 22] }), 'app');
    expect(signature.controls).toEqual({ 'control-h': 1, 'control-h-sm': 2, [OFF_SCALE]: 1 });
  });

  it('carries the side, the ladder, the scope and the tables through untouched', () => {
    const signature = buildSignature(rawSignature({ tables: [6, 4] }), 'mockup');
    expect(signature.side).toBe('mockup');
    expect(signature.tokens).toBe(TOKENS);
    expect(signature.scope).toEqual({ width: 1000, height: 800 });
    expect(signature.tables).toEqual([6, 4]);
  });

  it('survives a page measured at zero width without dividing by it', () => {
    const signature = buildSignature(
      rawSignature({
        scope: { width: 0, height: 0 },
        landmarks: {
          ...rawSignature().landmarks,
          body: { box: { x: 0, y: 0, width: 0, height: 0 }, fontSizePx: 14, fontWeight: 400 },
        },
      }),
      'app'
    );
    expect(Number.isFinite(signature.landmarks.body.x)).toBe(true);
    expect(Number.isFinite(signature.landmarks.body.width)).toBe(true);
  });
});
