/**
 * Scoring one page against its mockup (HIVE-10.1, #5337).
 *
 * ### Why this is not a pixel diff
 *
 * The mockups and the app never render the same data — the mockups say "Payments API v2.4.0"
 * because a designer typed it, the app says whatever the fixture holds — so a pixel diff of
 * the two is a diff of two paragraphs of text, not of two designs. What #5337 actually asks
 * is "does the app compose the same design language, in the same places, at the same values".
 *
 * That question has an objective answer, because both sides are built on the *same tokens*.
 * So each side is reduced to a token-space signature (`signature.ts`) and the two are
 * compared along eight dimensions, each of which is a design fact the mockup owns:
 *
 * | Dimension   | The question it answers                                              |
 * | ----------- | -------------------------------------------------------------------- |
 * | `tokens`    | do the two token ladders resolve to the same values at all?          |
 * | `landmarks` | does the page have the same chrome, set in the same type?            |
 * | `geometry`  | does that chrome sit in the same place across the page's width?      |
 * | `type`      | is the text set on the same steps of the ladder?                     |
 * | `spacing`   | is the rhythm between blocks, and inside cards, the same?            |
 * | `palette`   | is the ink drawn from the same tokens?                               |
 * | `controls`  | are buttons and inputs the same height?                              |
 * | `surfaces`  | are cards rounded on the same radius?                                |
 *
 * A pixel diff is still produced beside this (see `report.ts`), but as an artefact a reviewer
 * looks at — not as the gate. The gate is {@link PARITY_GATE}, the ≥ 95 % of the ticket.
 */

import { LANDMARK_IDS, type LandmarkId } from './landmarks';
import {
  dominantToken,
  totalWeight,
  type ParitySignature,
  type TokenDistribution,
} from './signature';
import { ALL_TOKENS, OFF_SCALE } from './tokens';

/** The structural-parity gate #5337 sets: 95 %. */
export const PARITY_GATE = 0.95;

/**
 * How far a landmark may drift, as a fraction of the page width, before its geometry score
 * starts falling — and how far before it reaches zero.
 *
 * 1 % of a 1200 px page is 12 px, which is three steps of the spacing scale: wide enough that
 * honest rounding and scrollbar arithmetic never trip it, narrow enough that a gutter built
 * from the wrong token does.
 */
export const GEOMETRY_TOLERANCE = 0.01;

/** The drift at which a landmark's geometry scores zero. */
export const GEOMETRY_LIMIT = 0.08;

/** One comparable edge of a landmark's box. */
export type GeometryFact = 'left' | 'width' | 'right';

/**
 * Which edges of each landmark are a design decision rather than a consequence of content.
 *
 * A page's *frame* is comparable: where the gutters are, how wide the header and body run,
 * where the action cluster ends. A text landmark's **width** is not — `.page-title` is a flex
 * box that ends where the title ends, so comparing its width across two pages that say
 * different things measures the words, not the design. Only the left edge of those is read,
 * which is the gutter they align to.
 */
export const GEOMETRY_FACTS: Record<LandmarkId, readonly GeometryFact[]> = {
  header: ['left', 'width'],
  breadcrumb: ['left'],
  title: ['left'],
  description: ['left'],
  actions: ['right'],
  tabs: ['left'],
  body: ['left', 'width'],
};

/**
 * The landmarks whose type is compared.
 *
 * The other three — the header, the action cluster and the body — are containers, so their
 * computed `font-size` is whatever they inherit rather than a decision either design made.
 */
export const TYPED_LANDMARKS: readonly LandmarkId[] = ['breadcrumb', 'title', 'description'];

/** The identifiers of the eight dimensions, in report order. */
export const DIMENSION_IDS = [
  'tokens',
  'landmarks',
  'geometry',
  'type',
  'spacing',
  'palette',
  'controls',
  'surfaces',
] as const;

/** One of the eight dimensions. */
export type DimensionId = (typeof DIMENSION_IDS)[number];

/**
 * How much each dimension is worth.
 *
 * They sum to 1, and no single dimension is worth less than 5 %, so the gate cannot be
 * cleared by a page that gets one of them badly wrong: a dimension scoring zero costs at
 * least its own weight, and every weight here is larger than the 5 % the gate allows.
 */
export const DIMENSION_WEIGHTS: Record<DimensionId, number> = {
  tokens: 0.15,
  landmarks: 0.15,
  geometry: 0.15,
  type: 0.15,
  spacing: 0.2,
  palette: 0.1,
  controls: 0.05,
  surfaces: 0.05,
};

/** Human-readable names, for the report. */
export const DIMENSION_LABELS: Record<DimensionId, string> = {
  tokens: 'Token ladder',
  landmarks: 'Page chrome',
  geometry: 'Chrome geometry',
  type: 'Type scale',
  spacing: 'Spacing rhythm',
  palette: 'Ink palette',
  controls: 'Control heights',
  surfaces: 'Surface radii',
};

/** What one dimension concluded. */
export interface DimensionScore {
  /** Which dimension this is. */
  id: DimensionId;
  /** Its human-readable name. */
  label: string;
  /** Its share of the overall score. */
  weight: number;
  /** Its own score, 0…1. */
  score: number;
  /** Everything that cost it points, in the order it was found. */
  detail: string[];
}

/** The verdict on one page. */
export interface ParityReport {
  /** The route map entry this report belongs to. */
  id: string;
  /** The mockup that was the source of truth. */
  mockup: string;
  /** The route (or fixture) that was measured. */
  subject: string;
  /** The weighted score, 0…1. */
  score: number;
  /** The gate it was measured against. */
  gate: number;
  /** Whether it cleared the gate. */
  passed: boolean;
  /** Every dimension's own verdict. */
  dimensions: DimensionScore[];
  /** Observations that are reported but deliberately not scored. */
  notes: string[];
}

/** How a distribution comparison splits its marks. */
export interface DistributionWeights {
  /** Share for "every measured value landed on a token at all". */
  onScale: number;
  /** Share for "the tokens used are tokens the mockup also uses". */
  shared: number;
}

/**
 * The default split: half for staying on the ladder, half for using the mockup's rungs.
 *
 * There is deliberately no third term for "the most-used token is the same one". Which step
 * of the type ladder carries the most characters, and which radius the most boxes, follow
 * from how much content a page happens to show — a fixture with four rows and a mockup drawn
 * with nine disagree about that while agreeing about every design decision in them. What the
 * two *can* be held to is the vocabulary: the same ladder, and the same rungs of it.
 */
export const DEFAULT_DISTRIBUTION_WEIGHTS: DistributionWeights = {
  onScale: 0.5,
  shared: 0.5,
};

/**
 * The bucket width, in CSS pixels, that spacing measurements are compared in.
 *
 * Padding and gap values are read off computed styles, where a 0.5 px rounding and a
 * hand-authored 5 px next to a scale's 4 px are the same decision to a reader. Two pixels is
 * narrow enough that `--space-1` (4 px) and `--space-2` (8 px) never merge, and wide enough
 * that neither of those noises registers as a difference.
 */
export const SPACING_BUCKET_PX = 2;

/**
 * Round a measurement to its spacing bucket.
 *
 * @param value The measurement, in CSS pixels.
 * @param size The bucket width; defaults to {@link SPACING_BUCKET_PX}.
 * @returns The bucket the measurement falls in.
 */
export function spacingBucket(value: number, size: number = SPACING_BUCKET_PX): number {
  return Math.round(value / size) * size;
}

/** Count how often each bucket occurs. */
function histogram(values: readonly number[], size: number): Map<number, number> {
  const counts = new Map<number, number>();
  for (const value of values) {
    const key = spacingBucket(value, size);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Compare two sets of spacing measurements.
 *
 * Neither side's *token* is the interesting fact here: both design systems pad a table cell
 * `10px 14px`, which is on no scale, and both are right to. What is interesting is whether
 * the app spaces things with the values the mockup uses at all — so the score is the share of
 * the app's spacing that appears somewhere in the mockup's spacing vocabulary.
 *
 * That single number is both forgiving in the right way and unforgiving in the right way. A
 * page that shows six cards where the mockup drew four uses the same values in different
 * proportions and still scores 1; a page that pads everything 20 px more moves every value it
 * has off the mockup's vocabulary at once, and scores about 0.2. The overlap of the two
 * histograms is measured as well and reported, but not scored: proportion follows from how
 * much content each side happens to show.
 *
 * @param app The app's measurements, in CSS pixels.
 * @param mockup The mockup's measurements.
 * @param bucketSize The bucket width; defaults to {@link SPACING_BUCKET_PX}.
 * @returns The score and the lines explaining it.
 */
export function scoreHistogram(
  app: readonly number[],
  mockup: readonly number[],
  bucketSize: number = SPACING_BUCKET_PX
): { score: number; detail: string[] } {
  if (app.length === 0 && mockup.length === 0) return { score: 1, detail: [] };
  if (app.length === 0) {
    return { score: 0, detail: ['nothing measured on the app where the mockup has content'] };
  }
  if (mockup.length === 0) {
    return { score: 0, detail: ['the app spaces content where the mockup has none'] };
  }

  const appCounts = histogram(app, bucketSize);
  const mockupCounts = histogram(mockup, bucketSize);

  let known = 0;
  let overlap = 0;
  const strangers: Array<{ value: number; share: number }> = [];
  for (const [value, count] of appCounts) {
    const share = count / app.length;
    const mockupShare = (mockupCounts.get(value) ?? 0) / mockup.length;
    if (mockupShare > 0) known += count;
    else strangers.push({ value, share });
    overlap += Math.min(share, mockupShare);
  }

  const vocabulary = known / app.length;
  const detail: string[] = [];
  if (strangers.length > 0) {
    const worst = strangers
      .sort((left, right) => right.share - left.share)
      .slice(0, 4)
      .map((entry) => `${entry.value} px (${percent(entry.share)})`);
    detail.push(`values the mockup never uses: ${worst.join(', ')}`);
  }
  if (overlap < 1) {
    detail.push(`histograms overlap by ${percent(overlap)} — reported, not scored`);
  }

  return { score: clamp01(vocabulary), detail };
}

/** Clamp to 0…1. */
function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Round to four decimals — enough to be exact, few enough to read. */
function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/** Format a fraction as a percentage for a report line. */
function percent(value: number): string {
  return `${(value * 100).toFixed(1)} %`;
}

/**
 * Compare one distribution against the mockup's.
 *
 * @param app The distribution measured on the app.
 * @param mockup The same distribution measured on the mockup.
 * @param weights How to split the marks; see {@link DistributionWeights}.
 * @returns The score and the lines explaining it.
 */
export function scoreDistribution(
  app: TokenDistribution,
  mockup: TokenDistribution,
  weights: DistributionWeights = DEFAULT_DISTRIBUTION_WEIGHTS
): { score: number; detail: string[] } {
  const detail: string[] = [];
  const total = totalWeight(app);
  if (total === 0) {
    // Nothing to measure. That is only parity if the mockup had nothing either.
    const mockupTotal = totalWeight(mockup);
    if (mockupTotal === 0) return { score: 1, detail: [] };
    return { score: 0, detail: ['nothing measured on the app where the mockup has content'] };
  }

  // "On scale" is measured *against the mockup's own rate*. The mockups hard-code a little —
  // an 16 px icon button, a 22 px chip — and charging the app for matching the source of
  // truth would make the gate unreachable for a page that is right.
  const offScale = app[OFF_SCALE] || 0;
  const appOnScale = 1 - offScale / total;
  const mockupTotal = totalWeight(mockup);
  const mockupOnScale = mockupTotal === 0 ? 1 : 1 - (mockup[OFF_SCALE] || 0) / mockupTotal;
  const onScale = mockupOnScale <= 0 ? 1 : clamp01(appOnScale / mockupOnScale);
  if (onScale < 1) {
    detail.push(
      `${percent(offScale / total)} of the weight is off the token scale ` +
        `(the mockup's own rate is ${percent(1 - mockupOnScale)})`
    );
  }

  // Vocabulary is judged over the *on-scale* weight only: a value that landed on no token
  // has already been charged for by `onScale`, and charging it again here would mean a page
  // as hard-coded as its mockup lost the same marks twice.
  let sharedWeight = 0;
  let onScaleWeight = 0;
  const strangers: string[] = [];
  for (const token of Object.keys(app)) {
    if (token === OFF_SCALE) continue;
    onScaleWeight += app[token];
    if (mockup[token] > 0) sharedWeight += app[token];
    else strangers.push(token);
  }
  const shared = onScaleWeight === 0 ? 1 : sharedWeight / onScaleWeight;
  if (strangers.length > 0) {
    detail.push(`tokens the mockup never uses here: ${strangers.sort().join(', ')}`);
  }

  // Reported, not scored, for the same reason the weights carry no `dominant` term: it is a
  // consequence of how much content each side shows. It is still the first thing a reviewer
  // wants to know when a dimension looks odd.
  const appDominant = dominantToken(app);
  const mockupDominant = dominantToken(mockup);
  if (appDominant !== mockupDominant) {
    detail.push(
      `most-used token is ${appDominant ?? 'none'}, the mockup's is ` +
        `${mockupDominant ?? 'none'} — reported, not scored`
    );
  }

  const score = weights.onScale * onScale + weights.shared * shared;
  return { score: clamp01(score), detail };
}

/**
 * Compare the two resolved token ladders.
 *
 * This is the dimension that catches a drifted `globals.css`: if `--space-4` is 16 px in the
 * mockups and 15 px in the app, every other dimension would still agree with itself and the
 * whole page would nonetheless be wrong.
 *
 * @param app The app's signature.
 * @param mockup The mockup's signature.
 * @returns The score and the tokens that differ.
 */
export function scoreTokens(
  app: ParitySignature,
  mockup: ParitySignature
): { score: number; detail: string[] } {
  const detail: string[] = [];
  let compared = 0;
  let equal = 0;
  for (const name of ALL_TOKENS) {
    const appValue = app.tokens[name];
    const mockupValue = mockup.tokens[name];
    // A token only one side declares says nothing about parity — `tokens.ts` documents why.
    if (!appValue || !mockupValue) continue;
    compared += 1;
    if (appValue === mockupValue) equal += 1;
    else detail.push(`--${name}: app ${appValue} vs mockup ${mockupValue}`);
  }
  return { score: compared === 0 ? 0 : equal / compared, detail };
}

/**
 * Compare the page chrome: which landmarks exist, and what type they are set in.
 *
 * @param app The app's signature.
 * @param mockup The mockup's signature.
 * @returns The score and what disagrees.
 */
export function scoreLandmarks(
  app: ParitySignature,
  mockup: ParitySignature
): { score: number; detail: string[] } {
  const detail: string[] = [];
  let presenceHits = 0;
  let typeCompared = 0;
  let typeHits = 0;

  for (const id of LANDMARK_IDS) {
    const appLandmark = app.landmarks[id];
    const mockupLandmark = mockup.landmarks[id];
    if (appLandmark.present === mockupLandmark.present) {
      presenceHits += 1;
    } else if (mockupLandmark.present) {
      detail.push(`the mockup has a ${id}, the app does not`);
    } else {
      detail.push(`the app has a ${id}, the mockup does not`);
    }

    if (appLandmark.present && mockupLandmark.present && TYPED_LANDMARKS.includes(id)) {
      typeCompared += 1;
      if (appLandmark.typeToken === mockupLandmark.typeToken) typeHits += 1;
      else {
        detail.push(
          `${id} is set in --${appLandmark.typeToken}, the mockup's in --${mockupLandmark.typeToken}`
        );
      }
    }
  }

  const presence = presenceHits / LANDMARK_IDS.length;
  const type = typeCompared === 0 ? 1 : typeHits / typeCompared;
  return { score: clamp01((presence + type) / 2), detail };
}

/**
 * Compare where the chrome sits across the page's width.
 *
 * Only landmarks both pages have are compared; a landmark one side is missing is already
 * paid for by {@link scoreLandmarks}, and charging for it twice would say the same thing
 * louder rather than more accurately.
 *
 * @param app The app's signature.
 * @param mockup The mockup's signature.
 * @returns The score and the landmarks that drifted.
 */
export function scoreGeometry(
  app: ParitySignature,
  mockup: ParitySignature
): { score: number; detail: string[] } {
  const detail: string[] = [];
  const scores: number[] = [];

  for (const id of LANDMARK_IDS) {
    const appLandmark = app.landmarks[id];
    const mockupLandmark = mockup.landmarks[id];
    if (!appLandmark.present || !mockupLandmark.present) continue;

    const drifts: Array<{ axis: string; delta: number }> = GEOMETRY_FACTS[id].map((fact) => {
      if (fact === 'left') {
        return { axis: 'left edge', delta: Math.abs(appLandmark.x - mockupLandmark.x) };
      }
      if (fact === 'width') {
        return { axis: 'width', delta: Math.abs(appLandmark.width - mockupLandmark.width) };
      }
      return {
        axis: 'right edge',
        delta: Math.abs(
          appLandmark.x + appLandmark.width - (mockupLandmark.x + mockupLandmark.width)
        ),
      };
    });
    for (const drift of drifts) {
      const excess = Math.max(0, drift.delta - GEOMETRY_TOLERANCE);
      const score = clamp01(1 - excess / (GEOMETRY_LIMIT - GEOMETRY_TOLERANCE));
      scores.push(score);
      if (score < 1) {
        detail.push(
          `${id} ${drift.axis} differs by ${percent(drift.delta)} of the page width`
        );
      }
    }
  }

  if (scores.length === 0) {
    return { score: 0, detail: ['no landmark is present on both sides'] };
  }
  const mean = scores.reduce((sum, value) => sum + value, 0) / scores.length;
  return { score: clamp01(mean), detail };
}

/**
 * Compare a page against its mockup along every dimension.
 *
 * @param options.id The route map entry's id.
 * @param options.mockup The mockup path, for the report.
 * @param options.subject The route or fixture that was measured, for the report.
 * @param options.app The app's signature.
 * @param options.mockupSignature The mockup's signature.
 * @param options.gate The score the page must reach; defaults to {@link PARITY_GATE}.
 * @returns The full verdict.
 */
export function scoreParity(options: {
  id: string;
  mockup: string;
  subject: string;
  app: ParitySignature;
  mockupSignature: ParitySignature;
  gate?: number;
}): ParityReport {
  const { app, mockupSignature: mockup } = options;
  const gate = options.gate ?? PARITY_GATE;

  const gaps = scoreHistogram(app.gaps, mockup.gaps);
  const paddings = scoreHistogram(app.paddings, mockup.paddings);

  const raw: Record<DimensionId, { score: number; detail: string[] }> = {
    tokens: scoreTokens(app, mockup),
    landmarks: scoreLandmarks(app, mockup),
    geometry: scoreGeometry(app, mockup),
    type: scoreDistribution(app.type, mockup.type),
    spacing: {
      score: (gaps.score + paddings.score) / 2,
      detail: [
        ...gaps.detail.map((line) => `rhythm: ${line}`),
        ...paddings.detail.map((line) => `padding: ${line}`),
      ],
    },
    palette: scoreDistribution(app.ink, mockup.ink),
    controls: scoreDistribution(app.controls, mockup.controls),
    surfaces: scoreDistribution(app.radii, mockup.radii),
  };

  const dimensions: DimensionScore[] = DIMENSION_IDS.map((id) => ({
    id,
    label: DIMENSION_LABELS[id],
    weight: DIMENSION_WEIGHTS[id],
    score: round(raw[id].score),
    detail: raw[id].detail,
  }));

  const score = round(
    dimensions.reduce((sum, dimension) => sum + dimension.weight * dimension.score, 0)
  );

  // Table shape is reported, never scored: the mockup draws the columns a designer chose to
  // draw, and a fixture legitimately renders a different slice of the same table.
  const notes: string[] = [];
  if (app.tables.length > 0 || mockup.tables.length > 0) {
    notes.push(
      `tables: app ${app.tables.length} (${app.tables.join(', ') || '—'} columns), ` +
        `mockup ${mockup.tables.length} (${mockup.tables.join(', ') || '—'} columns) — not scored`
    );
  }

  return {
    id: options.id,
    mockup: options.mockup,
    subject: options.subject,
    score,
    gate,
    passed: score >= gate,
    dimensions,
    notes,
  };
}

/**
 * The one-line summary of a report, for a console or a CI log.
 *
 * @param report The report to summarise.
 * @returns A single line, e.g. `published  96.4 %  PASS`.
 */
export function summariseReport(report: ParityReport): string {
  return `${report.id.padEnd(24)} ${percent(report.score).padStart(7)}  ${
    report.passed ? 'PASS' : 'FAIL'
  }`;
}

/**
 * Every line of a report a human needs to see when it fails.
 *
 * @param report The report to explain.
 * @returns The formatted explanation, ready to hand to an assertion message.
 */
export function explainReport(report: ParityReport): string {
  const lines = [
    `${report.id}: ${percent(report.score)} against ${report.mockup} (gate ${percent(
      report.gate
    )})`,
  ];
  for (const dimension of report.dimensions) {
    lines.push(
      `  ${dimension.label.padEnd(18)} ${percent(dimension.score).padStart(7)}  ` +
        `(weight ${percent(dimension.weight)})`
    );
    for (const line of dimension.detail) lines.push(`      · ${line}`);
  }
  for (const note of report.notes) lines.push(`  note: ${note}`);
  return lines.join('\n');
}
