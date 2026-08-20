/**
 * Scoring a page against its mockup (HIVE-10.1, #5337).
 *
 * `e2e/visual/parity.spec.ts` runs this arithmetic in a browser against eighteen real pages;
 * what it cannot do is state what the arithmetic *is*, because every input it has is a real
 * measurement. So the rules live here, on hand-built signatures where each test changes one
 * thing:
 *
 *   * two identical pages score 1, and the weights sum to 1 so that is possible at all;
 *   * a dimension scoring zero costs at least its weight, which is why no weight is smaller
 *     than the 5 % the gate allows — a page cannot fail a whole dimension and still pass;
 *   * the ≥ 95 % gate is what #5337 asks for, and `passed` is exactly that comparison;
 *   * **a 20 px padding regression falls through the gate** — the same claim the browser
 *     self-test makes about a real page, made here about the arithmetic itself.
 */

import { LANDMARK_IDS, type LandmarkId } from '../e2e/visual/landmarks';
import type { LandmarkSignature, ParitySignature } from '../e2e/visual/signature';
import {
  DIMENSION_IDS,
  DIMENSION_WEIGHTS,
  GEOMETRY_LIMIT,
  GEOMETRY_TOLERANCE,
  PARITY_GATE,
  explainReport,
  scoreDistribution,
  scoreGeometry,
  scoreHistogram,
  scoreLandmarks,
  scoreParity,
  scoreTokens,
  spacingBucket,
  summariseReport,
} from '../e2e/visual/score';
import { OFF_SCALE } from '../e2e/visual/tokens';

/** The resolved ladder both sides of a happy comparison share. */
const TOKENS: Record<string, string> = {
  fg: 'rgb(27, 26, 23)',
  'fg-muted': 'rgb(98, 95, 89)',
  'bg-surface': 'rgb(255, 255, 255)',
  'fs-md': '14px',
  'fs-3xl': '24px',
  'space-6': '24px',
  'card-pad': '20px',
  'r-lg': '14px',
  'control-h': '36px',
};

/** A landmark that is present at a given place. */
function landmark(x: number, width: number, typeToken = 'fs-md'): LandmarkSignature {
  return { present: true, x, width, typeToken, fontWeight: 400 };
}

/** A landmark the page does not have. */
const ABSENT: LandmarkSignature = {
  present: false,
  x: 0,
  width: 0,
  typeToken: OFF_SCALE,
  fontWeight: 0,
};

/**
 * A signature of a page that is exactly the mockup.
 *
 * @param overrides The parts a test wants to move.
 * @returns The signature.
 */
function signature(overrides: Partial<ParitySignature> = {}): ParitySignature {
  const landmarks = {} as Record<LandmarkId, LandmarkSignature>;
  for (const id of LANDMARK_IDS) landmarks[id] = landmark(0.032, 0.5);
  landmarks.title = landmark(0.032, 0.5, 'fs-3xl');
  landmarks.header = landmark(0, 1);
  landmarks.body = landmark(0, 1);
  return {
    side: 'app',
    tokens: TOKENS,
    scope: { width: 1000, height: 800 },
    landmarks,
    type: { 'fs-md': 400, 'fs-3xl': 40 },
    ink: { fg: 300, 'fg-muted': 140 },
    gaps: [24, 24, 8, 8, 12],
    paddings: [20, 20, 14, 14, 10, 10],
    radii: { 'r-lg': 3 },
    controls: { 'control-h': 4 },
    tables: [6],
    ...overrides,
  };
}

/**
 * Score a pair of signatures.
 *
 * @param app The app's signature.
 * @param mockup The mockup's signature; defaults to a copy of the app's.
 * @returns The report.
 */
function score(app: ParitySignature, mockup: ParitySignature = signature()) {
  return scoreParity({
    id: 'example',
    mockup: 'ship/published.html',
    subject: 'hive-published/table.html',
    app,
    mockupSignature: mockup,
  });
}

describe('the dimension weights', () => {
  it('sum to one, so a perfect page scores exactly 100 %', () => {
    const total = DIMENSION_IDS.reduce((sum, id) => sum + DIMENSION_WEIGHTS[id], 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it('never give a dimension less weight than the gate allows to be lost', () => {
    // A dimension worth less than 5 % could score zero and the page still pass, which would
    // make it decoration rather than a check.
    const allowance = Math.round((1 - PARITY_GATE) * 100);
    for (const id of DIMENSION_IDS) {
      expect(Math.round(DIMENSION_WEIGHTS[id] * 100)).toBeGreaterThanOrEqual(allowance);
    }
  });
});

describe('the token ladder dimension', () => {
  it('scores one when both sides resolved every shared token the same way', () => {
    expect(scoreTokens(signature(), signature()).score).toBe(1);
  });

  it('names the token that drifted', () => {
    const drifted = signature({ tokens: { ...TOKENS, 'space-6': '25px' } });
    const result = scoreTokens(drifted, signature());
    expect(result.score).toBeLessThan(1);
    expect(result.detail.join(' ')).toContain('--space-6');
  });

  it('ignores a token only one side declares, which says nothing about parity', () => {
    const extra = signature({ tokens: { ...TOKENS, honey: 'rgb(1, 2, 3)' } });
    expect(scoreTokens(extra, signature()).score).toBe(1);
  });

  it('scores zero when there is no shared ladder at all', () => {
    expect(scoreTokens(signature({ tokens: {} }), signature({ tokens: {} })).score).toBe(0);
  });
});

describe('the page-chrome dimension', () => {
  it('scores one for the same chrome set in the same type', () => {
    expect(scoreLandmarks(signature(), signature()).score).toBe(1);
  });

  it('charges for a landmark the app is missing, and says which way round', () => {
    const missing = signature({ landmarks: { ...signature().landmarks, description: ABSENT } });
    const result = scoreLandmarks(missing, signature());
    expect(result.score).toBeLessThan(1);
    expect(result.detail).toContain('the mockup has a description, the app does not');
  });

  it('charges for a title set on the wrong step of the ladder', () => {
    const wrongType = signature({
      landmarks: { ...signature().landmarks, title: landmark(0.032, 0.5, 'fs-2xl') },
    });
    const result = scoreLandmarks(wrongType, signature());
    expect(result.score).toBeLessThan(1);
    expect(result.detail.join(' ')).toContain('title is set in --fs-2xl');
  });

  it('says nothing about the type of a container, which only inherits it', () => {
    const wrongContainerType = signature({
      landmarks: { ...signature().landmarks, body: landmark(0, 1, 'fs-xs') },
    });
    expect(scoreLandmarks(wrongContainerType, signature()).score).toBe(1);
  });
});

describe('the chrome-geometry dimension', () => {
  it('scores one when the frame lands in the same place', () => {
    expect(scoreGeometry(signature(), signature()).score).toBe(1);
  });

  it('forgives drift inside the tolerance', () => {
    const nudged = signature({
      landmarks: {
        ...signature().landmarks,
        title: landmark(0.032 + GEOMETRY_TOLERANCE * 0.9, 0.5, 'fs-3xl'),
      },
    });
    expect(scoreGeometry(nudged, signature()).score).toBe(1);
  });

  it('scores a landmark past the limit at zero, and says how far it moved', () => {
    const moved = signature({
      landmarks: {
        ...signature().landmarks,
        title: landmark(0.032 + GEOMETRY_LIMIT + 0.01, 0.5, 'fs-3xl'),
      },
    });
    const result = scoreGeometry(moved, signature());
    expect(result.score).toBeLessThan(1);
    expect(result.detail.join(' ')).toContain('title left edge differs by');
  });

  it('reads the action cluster by its right edge, where the gutter is', () => {
    // Two more buttons make the cluster wider, not misplaced; its right edge is the design.
    const wider = signature({
      landmarks: { ...signature().landmarks, actions: landmark(0.032 - 0.2, 0.7) },
    });
    expect(scoreGeometry(wider, signature()).score).toBe(1);
  });

  it('says so when the two pages share no landmark to compare', () => {
    const empty = { ...signature().landmarks } as Record<LandmarkId, LandmarkSignature>;
    for (const id of LANDMARK_IDS) empty[id] = ABSENT;
    const result = scoreGeometry(signature({ landmarks: empty }), signature());
    expect(result.score).toBe(0);
    expect(result.detail).toContain('no landmark is present on both sides');
  });
});

describe('comparing a token distribution', () => {
  it('scores one for the same vocabulary', () => {
    expect(scoreDistribution({ 'fs-md': 10 }, { 'fs-md': 4 }).score).toBe(1);
  });

  it('charges for hard-coded values, measured against the mockup\'s own rate', () => {
    // Half the app off the ladder against a mockup wholly on it.
    const strict = scoreDistribution({ 'fs-md': 5, [OFF_SCALE]: 5 }, { 'fs-md': 10 });
    // The same app against a mockup that hard-codes just as much: no charge.
    const fair = scoreDistribution(
      { 'fs-md': 5, [OFF_SCALE]: 5 },
      { 'fs-md': 5, [OFF_SCALE]: 5 }
    );
    expect(strict.score).toBeLessThan(fair.score);
    expect(fair.score).toBe(1);
    expect(strict.detail.join(' ')).toContain('off the token scale');
  });

  it('charges for a token the mockup never uses, and names it', () => {
    const result = scoreDistribution({ 'fs-md': 5, 'fs-5xl': 5 }, { 'fs-md': 10 });
    expect(result.score).toBeLessThan(1);
    expect(result.detail.join(' ')).toContain('fs-5xl');
  });

  it('judges vocabulary over the on-scale weight only, so nothing is charged twice', () => {
    // Every on-scale character is set in a step the mockup uses; the off-scale half has
    // already been charged by `onScale`.
    const result = scoreDistribution(
      { 'fs-md': 5, [OFF_SCALE]: 5 },
      { 'fs-md': 5, [OFF_SCALE]: 5 }
    );
    expect(result.score).toBe(1);
  });

  it('reports the most-used token when it differs, without scoring it', () => {
    const result = scoreDistribution({ 'fs-md': 1, 'fs-3xl': 9 }, { 'fs-md': 9, 'fs-3xl': 1 });
    expect(result.score).toBe(1);
    expect(result.detail.join(' ')).toContain('reported, not scored');
  });

  it('scores an empty pair one, and an empty app against a full mockup zero', () => {
    expect(scoreDistribution({}, {}).score).toBe(1);
    expect(scoreDistribution({}, { 'fs-md': 4 }).score).toBe(0);
  });
});

describe('comparing spacing', () => {
  it('buckets a measurement so rounding and a hand-authored pixel do not register', () => {
    expect(spacingBucket(7.95)).toBe(8);
    expect(spacingBucket(5)).toBe(6);
    expect(spacingBucket(4)).toBe(4);
  });

  it('scores one when every value the app uses appears in the mockup', () => {
    expect(scoreHistogram([24, 24, 8], [24, 8, 8, 8, 12]).score).toBe(1);
  });

  it('does not care that the two use them in different proportions', () => {
    const result = scoreHistogram([8, 8, 8, 8, 24], [24, 24, 24, 24, 8]);
    expect(result.score).toBe(1);
    expect(result.detail.join(' ')).toContain('reported, not scored');
  });

  it('charges for a value the mockup never uses, and names it', () => {
    const result = scoreHistogram([24, 24, 40, 40], [24, 8]);
    expect(result.score).toBe(0.5);
    expect(result.detail.join(' ')).toContain('40 px');
  });

  it('collapses when every value moves at once, which is what a padding regression is', () => {
    const clean = scoreHistogram([20, 20, 14, 10], [20, 14, 10, 12]);
    const regressed = scoreHistogram(
      [20, 20, 14, 10].map((value) => value + 20),
      [20, 14, 10, 12]
    );
    expect(clean.score).toBe(1);
    expect(regressed.score).toBeLessThan(0.25);
  });

  it('scores an empty pair one, and disagrees in either direction otherwise', () => {
    expect(scoreHistogram([], []).score).toBe(1);
    expect(scoreHistogram([], [8]).score).toBe(0);
    expect(scoreHistogram([8], []).score).toBe(0);
  });
});

describe('the whole verdict', () => {
  it('scores a page that is the mockup at 100 %, and passes it', () => {
    const report = score(signature());
    expect(report.score).toBe(1);
    expect(report.passed).toBe(true);
    expect(report.gate).toBe(PARITY_GATE);
    expect(report.dimensions.map((dimension) => dimension.id)).toEqual([...DIMENSION_IDS]);
  });

  it('fails a page that loses one whole dimension', () => {
    const report = score(signature({ tokens: {} }), signature({ tokens: {} }));
    expect(report.score).toBeLessThanOrEqual(1 - DIMENSION_WEIGHTS.tokens);
    expect(report.passed).toBe(false);
  });

  it('fails a deliberate 20 px padding regression', () => {
    const clean = score(signature());
    const regressed = score(
      signature({ paddings: signature().paddings.map((value) => value + 20) })
    );
    expect(clean.passed).toBe(true);
    expect(regressed.passed).toBe(false);
    expect(clean.score - regressed.score).toBeGreaterThanOrEqual(0.05);
  });

  it('passes at exactly the gate, not just above it', () => {
    const report = scoreParity({
      id: 'example',
      mockup: 'ship/published.html',
      subject: 'hive-published/table.html',
      app: signature(),
      mockupSignature: signature(),
      gate: 1,
    });
    expect(report.passed).toBe(true);
  });

  it('reports table shape without scoring it', () => {
    const report = score(signature({ tables: [4, 4, 4] }));
    expect(report.score).toBe(1);
    expect(report.notes.join(' ')).toContain('not scored');
  });

  it('explains itself in a line, and in full', () => {
    const report = score(signature({ landmarks: { ...signature().landmarks, tabs: ABSENT } }));
    expect(summariseReport(report)).toContain('PASS');
    expect(summariseReport(score(signature({ tokens: {} }), signature({ tokens: {} }))))
      .toContain('FAIL');

    const explanation = explainReport(report);
    expect(explanation).toContain('Page chrome');
    expect(explanation).toContain('the mockup has a tabs, the app does not');
    expect(explanation).toContain('gate 95.0 %');
  });
});
