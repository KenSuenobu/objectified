/**
 * The collector's contract, and the table that lets it read both sides (HIVE-10.1, #5337).
 *
 * `collectRaw` runs inside a browser, and jsdom lays nothing out, so this suite cannot check
 * what it *measures* — `e2e/visual/parity.spec.ts` does that against eighteen real pages. What
 * it can check is everything the Node half of the harness depends on and would only discover
 * at run time inside a browser:
 *
 *   * the **shape** it returns — every field present, every requested token accounted for,
 *     every landmark key answered even when the page has no such landmark;
 *   * that a scope selector matching nothing is an **error**, not a score of zero. A route map
 *     entry pointing at a fixture that never mounted is a harness bug, and a silent zero would
 *     read as a parity failure and send a reviewer to look at the wrong thing;
 *   * that the two landmark tables **agree on their keys**, which is the one thing that makes
 *     `.page-title` and `.page-header__title` the same landmark rather than two.
 */

import { collectRaw } from '../e2e/visual/collect';
import {
  APP_LANDMARKS,
  LANDMARK_IDS,
  MOCKUP_LANDMARKS,
  landmarkSelectors,
  scopeSelector,
} from '../e2e/visual/landmarks';
import { ALL_TOKENS, COLOUR_TOKENS } from '../e2e/visual/tokens';

/** The configuration the harness passes for the app side. */
const APP_CONFIG = {
  scopeSelector: scopeSelector('app'),
  landmarks: APP_LANDMARKS as unknown as Record<string, string>,
  tokens: [...ALL_TOKENS],
  colourTokens: [...COLOUR_TOKENS],
};

describe('the landmark tables', () => {
  it('answer for exactly the same landmarks on both sides', () => {
    expect(Object.keys(MOCKUP_LANDMARKS).sort()).toEqual([...LANDMARK_IDS].sort());
    expect(Object.keys(APP_LANDMARKS).sort()).toEqual([...LANDMARK_IDS].sort());
  });

  it('give every landmark a selector on both sides', () => {
    for (const id of LANDMARK_IDS) {
      expect(MOCKUP_LANDMARKS[id].length).toBeGreaterThan(0);
      expect(APP_LANDMARKS[id].length).toBeGreaterThan(0);
    }
  });

  it('hand out the table that belongs to the side being measured', () => {
    expect(landmarkSelectors('mockup')).toBe(MOCKUP_LANDMARKS);
    expect(landmarkSelectors('app')).toBe(APP_LANDMARKS);
  });

  it('scope both sides to the page region, whatever tag it is', () => {
    expect(scopeSelector('mockup')).toContain('.page');
    expect(scopeSelector('app')).toContain('.page');
  });

  it('uses selectors a browser will accept', () => {
    // A typo in one of these would only surface as "landmark absent" in a browser run, which
    // reads as a parity failure rather than as the harness bug it is.
    for (const id of LANDMARK_IDS) {
      expect(() => document.querySelectorAll(MOCKUP_LANDMARKS[id])).not.toThrow();
      expect(() => document.querySelectorAll(APP_LANDMARKS[id])).not.toThrow();
    }
    expect(() => document.querySelectorAll(scopeSelector('mockup'))).not.toThrow();
  });
});

describe('the collector', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('refuses to measure a page whose scope never mounted', () => {
    expect(() => collectRaw(APP_CONFIG)).toThrow(/no element matched scope selector/);
  });

  it('answers for every requested token, and for every landmark', () => {
    document.body.innerHTML = '<div class="page"><div class="page-body"></div></div>';
    const raw = collectRaw(APP_CONFIG);

    expect(Object.keys(raw.tokens).sort()).toEqual([...ALL_TOKENS].sort());
    expect(Object.keys(raw.landmarks).sort()).toEqual([...LANDMARK_IDS].sort());
    // jsdom lays nothing out, so nothing is "present" — which is exactly the answer the
    // signature builder expects for a landmark a page does not render.
    for (const id of LANDMARK_IDS) expect(raw.landmarks[id]).toBeNull();
  });

  it('returns every measurement as a list, empty rather than absent', () => {
    document.body.innerHTML = '<div class="page"></div>';
    const raw = collectRaw(APP_CONFIG);

    expect(raw.text).toEqual([]);
    expect(raw.surfaces).toEqual([]);
    expect(raw.paddings).toEqual([]);
    expect(raw.controls).toEqual([]);
    expect(raw.gaps).toEqual([]);
    expect(raw.tables).toEqual([]);
    expect(raw.scope).toEqual({ width: 0, height: 0 });
  });

  it('leaves nothing of its own behind in the page it measured', () => {
    document.body.innerHTML = '<div class="page"></div>';
    collectRaw(APP_CONFIG);
    expect(document.querySelectorAll('.page > *')).toHaveLength(0);
  });
});
