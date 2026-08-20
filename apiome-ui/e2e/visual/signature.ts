/**
 * Turning a raw browser measurement into a token-space signature (HIVE-10.1, #5337).
 *
 * Everything here is pure: numbers in, numbers out, no DOM. That is the point — the browser
 * side of the harness only reads pixels, and every judgement about what those pixels *mean*
 * lives in functions `tests/visual-parity-signature.test.ts` can call directly.
 *
 * The translation is always the same: a measured length or colour is matched against the
 * resolved token ladder, and reported as the token it landed on — or as {@link OFF_SCALE}
 * when it landed on nothing, which is the shape a hard-coded value takes once it reaches
 * this file.
 */

import type { RawSignature } from './collect';
import type { LandmarkId, Side } from './landmarks';
import { LANDMARK_IDS } from './landmarks';
import {
  CONTROL_TOKENS,
  COLOUR_TOKENS,
  OFF_SCALE,
  RADIUS_TOKENS,
  TYPE_TOKENS,
} from './tokens';

/** How much a measurement may differ from a token's value and still be called that token. */
export const SNAP_TOLERANCE_PX = 0.6;

/** Token name → how much of the page is set in it (characters, or a count of boxes). */
export type TokenDistribution = Record<string, number>;

/** One landmark, described in units that survive a change of page width. */
export interface LandmarkSignature {
  /** Whether the page has this landmark at all. */
  present: boolean;
  /** Left offset as a fraction of the page's width, so gutters compare across widths. */
  x: number;
  /** Width as a fraction of the page's width. */
  width: number;
  /** The type token the landmark is set in, or {@link OFF_SCALE}. */
  typeToken: string;
  /** Its computed font weight. */
  fontWeight: number;
}

/** One page, described entirely in design tokens. */
export interface ParitySignature {
  /** Which side of the comparison this is. */
  side: Side;
  /** The resolved token ladder this page was laid out against. */
  tokens: Record<string, string>;
  /** The page region's own box. */
  scope: { width: number; height: number };
  /** Every page-chrome landmark, present or not. */
  landmarks: Record<LandmarkId, LandmarkSignature>;
  /** Type ladder usage, weighted by how much text is set in each step. */
  type: TokenDistribution;
  /** Ink usage, weighted the same way. */
  ink: TokenDistribution;
  /**
   * Every gap the page declares, in CSS pixels.
   *
   * Kept as raw measurements rather than snapped to tokens: both design systems space some
   * things off the scale — a 10 px table cell, a 5 px chip gutter — and both are right to,
   * so the comparable fact is the *values themselves*, not which token they missed. See
   * `scoreHistogram` in `score.ts`.
   */
  gaps: number[];
  /** Every padding the page declares, in CSS pixels, one entry per edge. */
  paddings: number[];
  /** Surface corner radii, counted per surface. */
  radii: TokenDistribution;
  /** Control heights, counted per control. */
  controls: TokenDistribution;
  /** The column count of every table on the page. */
  tables: number[];
}

/** A landmark that a page does not have. */
const ABSENT: LandmarkSignature = {
  present: false,
  x: 0,
  width: 0,
  typeToken: OFF_SCALE,
  fontWeight: 0,
};

/**
 * Match a measured length against a token ladder.
 *
 * @param value The measured length, in CSS pixels.
 * @param tokens The resolved token ladder (token name → e.g. `"16px"`).
 * @param names Candidate token names, in the order they should win ties.
 * @param tolerance How far the measurement may sit from the token's value.
 * @returns The winning token name, or {@link OFF_SCALE} when nothing is close enough.
 */
export function snapLength(
  value: number,
  tokens: Record<string, string>,
  names: readonly string[],
  tolerance: number = SNAP_TOLERANCE_PX
): string {
  for (const name of names) {
    const declared = tokens[name];
    if (!declared) continue;
    const parsed = parseFloat(declared);
    if (Number.isNaN(parsed)) continue;
    if (Math.abs(parsed - value) <= tolerance) return name;
  }
  return OFF_SCALE;
}

/**
 * Match a measured colour against the colour tokens.
 *
 * Comparison is exact on the browser's own serialisation, which is what makes it meaningful:
 * both sides resolve `--fg` through the same engine, so equal ink really is the same token,
 * and a near-miss really is a hard-coded colour.
 *
 * @param value The computed colour, e.g. `"rgb(15, 23, 42)"`.
 * @param tokens The resolved token ladder.
 * @param names Candidate token names, in the order they should win ties.
 * @returns The winning token name, or {@link OFF_SCALE}.
 */
export function snapColour(
  value: string,
  tokens: Record<string, string>,
  names: readonly string[] = COLOUR_TOKENS
): string {
  for (const name of names) {
    if (tokens[name] && tokens[name] === value) return name;
  }
  return OFF_SCALE;
}

/**
 * Add weight to a token's bucket.
 *
 * @param into The distribution being built.
 * @param token The bucket.
 * @param weight How much to add.
 */
function add(into: TokenDistribution, token: string, weight: number): void {
  into[token] = (into[token] || 0) + weight;
}

/**
 * The total weight of a distribution.
 *
 * @param distribution The distribution to sum.
 * @returns The sum of every bucket.
 */
export function totalWeight(distribution: TokenDistribution): number {
  return Object.keys(distribution).reduce((sum, key) => sum + distribution[key], 0);
}

/**
 * The heaviest bucket of a distribution, ignoring {@link OFF_SCALE}.
 *
 * Ties break on token name so the answer never depends on key insertion order, which differs
 * between two pages that use the same tokens in a different sequence.
 *
 * @param distribution The distribution to inspect.
 * @returns The dominant token name, or `null` when the distribution carries no on-scale mass.
 */
export function dominantToken(distribution: TokenDistribution): string | null {
  let best: string | null = null;
  let bestWeight = 0;
  for (const key of Object.keys(distribution).sort()) {
    if (key === OFF_SCALE) continue;
    if (distribution[key] > bestWeight) {
      best = key;
      bestWeight = distribution[key];
    }
  }
  return best;
}

/**
 * Translate a raw measurement into a token-space signature.
 *
 * @param raw What the collector measured in the browser.
 * @param side Which side of the comparison this measurement is.
 * @returns The signature the scorer compares.
 */
export function buildSignature(raw: RawSignature, side: Side): ParitySignature {
  const width = raw.scope.width || 1;

  const landmarks = {} as Record<LandmarkId, LandmarkSignature>;
  for (const id of LANDMARK_IDS) {
    const measured = raw.landmarks[id];
    landmarks[id] = measured
      ? {
          present: true,
          x: measured.box.x / width,
          width: measured.box.width / width,
          typeToken: snapLength(measured.fontSizePx, raw.tokens, TYPE_TOKENS),
          fontWeight: measured.fontWeight,
        }
      : { ...ABSENT };
  }

  const type: TokenDistribution = {};
  const ink: TokenDistribution = {};
  for (const entry of raw.text) {
    add(type, snapLength(entry.fontSizePx, raw.tokens, TYPE_TOKENS), entry.chars);
    add(ink, snapColour(entry.colour, raw.tokens), entry.chars);
  }

  // A pill's radius is authored as "bigger than the box" and each side spells that number
  // differently — `--r-full` is 999 px, Tailwind's `rounded-full` resolves to tens of
  // millions. Both mean the same thing, so anything at or above `--r-full` reads as `--r-full`.
  const fullRadius = parseFloat(raw.tokens['r-full'] || '') || Infinity;

  const radii: TokenDistribution = {};
  for (const surface of raw.surfaces) {
    add(
      radii,
      snapLength(Math.min(surface.radiusPx, fullRadius), raw.tokens, RADIUS_TOKENS),
      1
    );
  }

  const controls: TokenDistribution = {};
  for (const height of raw.controls) {
    add(controls, snapLength(height, raw.tokens, CONTROL_TOKENS), 1);
  }

  return {
    side,
    tokens: raw.tokens,
    scope: raw.scope,
    landmarks,
    type,
    ink,
    gaps: raw.gaps,
    paddings: raw.paddings,
    radii,
    controls,
    tables: raw.tables,
  };
}
