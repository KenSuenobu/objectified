/**
 * The stylesheet half of the Export Studio redesign (HIVE-8.3, #5329).
 *
 * `export-studio-hive-redesign.test.tsx` renders the five steps and pins their markup; it
 * cannot pin anything that makes them *look* right, because jsdom compiles no stylesheet. So
 * this suite reads `globals.css` the way `published-css.test.ts` and `sunset-timeline-css.test.ts`
 * do, and pins what the twenty-three components lean on:
 *
 *   1. **The skin is tokens only.** What this replaced named colour outright in about four
 *      hundred places — a `stageRowClass` switch returning border/background pairs, a second
 *      `StageIcon` switch returning a matching ink, two hand-written status→palette tables in
 *      the manifest tree, three severity switches across the verify lenses, and five separate
 *      inventions of amber for "read this before you ship".
 *   2. **One word is one colour everywhere.** A projection status paints the graph node, the
 *      edge, the row badge and the legend swatch from a single token, and it is the token the
 *      shared vocabulary resolves that status to.
 *   3. **Nothing is frozen in pixels** but hairlines and mark strokes — the fourteen lengths
 *      the mockup pinned are `rem`, a token, a `ch` or a viewport length here.
 *   4. **The block sits after the unlayered base type rules** it has to outrank.
 *   5. **Quiet text is `--fg-muted`**, never `--fg-subtle`, at every size this block sets.
 *   6. **No `-fg` tone ink is painted as words on a plain surface** — the pairs are only
 *      calibrated against their own `-soft` ground — and every tinted ground this block does
 *      invent is measured against `--fg` in all nine appearances.
 *   7. **The heat scale reads without colour**, and its four washes still clear AA for `--fg`.
 */

import {
  compositeOver,
  contrastRatio,
  findUnfencedHex,
  parseDeclarations,
  readGlobalsCss,
  readThemeBlocks,
  readTokenLayer,
  resolveThemeToken,
  topLevelRules,
  type CssRule,
  type Rgb,
} from './helpers/design-tokens';
import { statusPresentation } from '../src/app/components/ade/dashboard/export/projectionGraph';
import { PROJECTION_STATUS_TONE } from '../src/app/components/ade/export-studio';

const css = readGlobalsCss();
const rules = topLevelRules(css);
const tokens = readTokenLayer(css);

/** The light default, then every `html[data-theme]` block — the nine appearances. */
const APPEARANCES = [
  ['light', undefined] as const,
  ...[...readThemeBlocks(css).entries()].map(([id, block]) => [id, block] as const),
];

/** WCAG AA for normal-size text. */
const WCAG_AA_NORMAL_TEXT_MIN = 4.5;

/** WCAG 1.4.11 for a non-text mark — a graph node's stroke, a progress fill, a rule. */
const WCAG_AA_NON_TEXT_MIN = 3;

/** Pure white, the last thing behind every surface. */
const PAPER: Rgb = { r: 255, g: 255, b: 255 };

/** The line the unlayered `p` base rule is declared on, found rather than assumed. */
const BASE_TYPE_RULE_LINE = (() => {
  const rule = rules.find((candidate) => candidate.prelude === 'p');
  if (!rule) throw new Error('globals.css no longer declares a bare `p` rule');
  return rule.line;
})();

/**
 * The rules this ticket added that a component names directly.
 *
 * Listed rather than pattern-matched, so a rule that is *renamed* fails here instead of
 * silently dropping out of the token-only walk below. The list is the block's public surface:
 * every class in it appears in a `className` somewhere under `ade/dashboard/export`.
 */
const STUDIO_PRELUDES = [
  // shared type + layout
  '.xstd-quiet',
  '.xstd-note',
  '.xstd-caps',
  '.xstd-link',
  '.xstd-mono',
  '.xstd-stack',
  '.xstd-stack--tight',
  '.xstd-rule',
  '.xstd-loading-row',
  '.xstd-empty',
  '.xstd-panel',
  '.xstd-panel:focus-visible',
  // header + stepper
  '.xstd-back',
  '.xstd-steps',
  '.xstd-step',
  '.xstd-step__num',
  ".xstd-step[data-state='done'] .xstd-step__num",
  ".xstd-step[data-state='current']",
  ".xstd-step[data-state='current'] .xstd-step__num",
  // the shared notice
  '.xstd-notice',
  ".xstd-notice[data-tone='warn']",
  ".xstd-notice[data-tone='danger']",
  ".xstd-notice[data-tone='ok']",
  ".xstd-notice[data-tone='accent']",
  '.xstd-notice__grow',
  // step 1 + 2
  '.xstd-source__name',
  '.xstd-source__pills',
  '.xstd-source__counts',
  '.xstd-count-chip',
  '.xstd-count-chip__value',
  '.xstd-original',
  '.xstd-original__main',
  '.xstd-original__title',
  '.xstd-original__why',
  '.xstd-family__title',
  '.xstd-family__count',
  // step 3
  '.xstd-field__label',
  '.xstd-field__name',
  '.xstd-field__desc',
  '.xstd-field__error',
  // step 4
  '.xstd-advisory',
  '.xstd-advisory__text',
  '.xstd-check',
  '.xstd-check > input',
  '.xstd-config',
  '.xstd-lens-badge',
  ".xstd-lens-badge[data-tone='ok']",
  ".xstd-lens-badge[data-tone='warn']",
  ".xstd-lens-badge[data-tone='danger']",
  '.xstd-lens-head',
  '.xstd-details',
  '.xstd-details__summary',
  '.xstd-details__body',
  '.xstd-finding',
  ".xstd-finding[data-tone='danger']",
  ".xstd-finding[data-tone='warn']",
  ".xstd-finding[data-tone='ok']",
  '.xstd-finding__button',
  '.xstd-finding__open',
  '.xstd-finding__message',
  '.xstd-finding__location',
  '.xstd-rule-chip',
  // step 5 — job, failures, gate
  '.xstd-progress',
  '.xstd-progress__fill',
  '.xstd-progress__value',
  '.xstd-stage',
  '.xstd-stage__icon',
  ".xstd-stage[data-status='done'] .xstd-stage__icon",
  ".xstd-stage[data-status='active'] .xstd-stage__icon",
  ".xstd-stage[data-status='failed'] .xstd-stage__icon",
  '.xstd-stage__title',
  '.xstd-stage__desc',
  '.xstd-event',
  ".xstd-event[data-level='warn']",
  ".xstd-event[data-level='error']",
  '.xstd-failure',
  '.xstd-failure__head',
  '.xstd-failure__title',
  '.xstd-failure__body',
  '.xstd-failure__detail',
  '.xstd-failure__list',
  '.xstd-failure__note',
  '.xstd-gate',
  ".xstd-gate[data-decision='block']",
  ".xstd-gate[data-decision='allow_with_warning']",
  '.xstd-gate__head',
  '.xstd-gate__title',
  '.xstd-gate__reason',
  ".xstd-gate__reason[data-severity='blocking']",
  ".xstd-gate__reason[data-severity='warning']",
  '.xstd-gate__dimension',
  '.xstd-gate__override',
  '.xstd-gate__attestation',
  // the manifest tree
  '.xstd-tree-card',
  '.xstd-tree-card__head',
  '.xstd-tree-card__title',
  '.xstd-tree-card__meta',
  '.xstd-tree__scroll',
  '.xstd-tree__row',
  ".xstd-tree__row[data-selected='true']",
  '.xstd-tree__twist',
  '.xstd-tree__group',
  '.xstd-tree__count',
  '.xstd-tree__line',
  '.xstd-tree__line--flat',
  '.xstd-entity',
  '.xstd-entity__name',
  '.xstd-entity__reason',
  '.xstd-entity__detail',
  // the bundle explorer and the viewer chrome
  '.xstd-bundle',
  '.xstd-bundle__viewer',
  '.xstd-bundle__placeholder',
  '.xstd-bundle__tree',
  '.xstd-bundle__tab-close',
  '.xstd-file-icon',
  '.xstd-folder-icon',
  '.xstd-file-size',
  '.xstd-viewer-sep',
  '.xstd-problems',
  '.xstd-problems__head',
  '.xstd-problems__row',
  ".xstd-problems__row[data-selected='true']",
  '.xstd-problems__icon',
  ".xstd-problems__icon[data-severity='error']",
  ".xstd-problems__icon[data-severity='warning']",
  ".xstd-problems__icon[data-severity='info']",
  '.xstd-problems__at',
  '.xstd-guard',
  '.xstd-guard__why',
  '.xstd-code-fallback',
  '.xstd-code-empty',
  // the mapping graph and the shared SVG marks
  '.xstd-map__frame',
  '.xstd-map__snapshot',
  '.xstd-map__table',
  '.xstd-map__row',
  '.xstd-map__row--aggregate',
  '.xstd-map__cell',
  '.xstd-map__cell--mono',
  '.xstd-map__none',
  '.xstd-node',
  '.xstd-node__label',
  '.xstd-node__label--muted',
  '.xstd-node__meta',
  '.xstd-edge',
  '.xstd-axis-label',
  // the loss heatmap
  '.xstd-heat',
  '.xstd-heat__kind',
  '.xstd-heat__cell',
  ".xstd-heat__cell[data-heat='1']",
  ".xstd-heat__cell[data-heat='2']",
  ".xstd-heat__cell[data-heat='3']",
  ".xstd-heat__cell[data-heat='4']",
  ".xstd-heat__cell[aria-pressed='true']",
  '.xstd-heat__count',
  '.xstd-heat__glyph',
  '.xstd-heat__level',
  '.xstd-heat__empty',
  '.xstd-chip',
  ".xstd-chip[aria-pressed='true']",
  '.xstd-rank',
  '.xstd-rank__row',
  '.xstd-rank__position',
  '.xstd-rank__construct',
  '.xstd-weighting',
  '.xstd-weighting__summary',
  // the round trip
  '.xstd-rt__prompt',
  '.xstd-rt__diff',
  '.xstd-rt__diff[data-unexplained]',
  '.xstd-rt__glyph',
  '.xstd-rt__unexplained-title',
  '.xstd-rt__provenance',
  // the evidence drawer
  '.xstd-evidence',
  '.xstd-evidence__title',
  '.xstd-evidence__close',
  '.xstd-evidence__code',
  '.xstd-evidence__body',
  '.xstd-evidence__remediation',
  '.xstd-evidence__action',
] as const;

/**
 * Look one of this ticket's rules up.
 *
 * @param prelude The rule's selector, exactly as {@link STUDIO_PRELUDES} lists it.
 * @returns The rule.
 */
function xstdRule(prelude: string): CssRule {
  const rule = rules.find((candidate) => candidate.prelude === prelude);
  if (!rule) throw new Error(`globals.css declares no rule \`${prelude}\``);
  return rule;
}

/**
 * Read one declaration out of one of this ticket's rules.
 *
 * @param prelude The rule's selector.
 * @param property The property to read.
 * @returns Its value, whitespace-collapsed.
 */
function declaration(prelude: string, property: string): string {
  const value = parseDeclarations(xstdRule(prelude).body).get(property);
  if (value === undefined) throw new Error(`\`${prelude}\` declares no \`${property}\``);
  return value;
}

/**
 * The opaque colour a token resolves to in one appearance, flattened onto its backdrop.
 *
 * @param name The token.
 * @param appearance The theme block, or `undefined` for the light default.
 * @param backdrop What is painted behind it.
 * @returns The resulting opaque channels.
 */
function paint(name: string, appearance: unknown, backdrop: Rgb): Rgb {
  return compositeOver(resolveThemeToken(name, tokens, appearance as never), backdrop);
}

/**
 * A `color-mix(in srgb, var(--x) N%, var(--y))` wash, resolved for one appearance.
 *
 * The block's tinted grounds are all written this way — a percentage of a saturated role over
 * the surface — so the measurement below has to reproduce the mix rather than read a token.
 *
 * @param token The saturated role token being mixed in.
 * @param percent How much of it, 0–100.
 * @param appearance The theme block, or `undefined` for the light default.
 * @returns The resulting opaque ground.
 */
function wash(token: string, percent: number, appearance: unknown): Rgb {
  const surface = paint('--bg-surface', appearance, PAPER);
  const tint = paint(token, appearance, surface);
  const f = percent / 100;
  return {
    r: Math.round(tint.r * f + surface.r * (1 - f)),
    g: Math.round(tint.g * f + surface.g * (1 - f)),
    b: Math.round(tint.b * f + surface.b * (1 - f)),
  };
}

/**
 * This ticket's block, from its banner to the end of the file.
 *
 * It is the last section in `globals.css`, so there is no following banner to stop at — and
 * there is deliberately no *second* banner inside it either, for the reason
 * `sunset-timeline-css.test.ts` records: a nested comment opener would silently cut this
 * slice short and turn every assertion below into a claim about half the block.
 */
const SECTION = (() => {
  const start = css.indexOf('EXPORT STUDIO  (HIVE-8.3, #5329)');
  if (start < 0) throw new Error('globals.css has no export-studio section');
  const bannerStart = css.lastIndexOf('/* =', start);
  const next = css.indexOf('/* =', start + 1);
  return css.slice(bannerStart < 0 ? start : bannerStart, next < 0 ? css.length : next);
})();

/** The same block with its comments removed. */
const SECTION_CODE = SECTION.replace(/\/\*[\s\S]*?\*\//g, '');

/* -------------------------------------------------------------------------
   1. The section exists, and names no colour
   ------------------------------------------------------------------------- */

describe('the export-studio section of globals.css', () => {
  it('declares every rule the components reference', () => {
    const missing = STUDIO_PRELUDES.filter(
      (prelude) => !rules.some((rule) => rule.prelude === prelude)
    );
    expect(missing).toEqual([]);
  });

  it('is the whole block — no nested banner truncates the slice', () => {
    expect(SECTION).toContain('.xstd-quiet');
    expect(SECTION).toContain('.xstd-evidence__action');
  });

  it('sits after the unlayered p and h1–h4 base rules it has to outrank', () => {
    for (const prelude of STUDIO_PRELUDES) {
      expect(xstdRule(prelude).line).toBeGreaterThan(BASE_TYPE_RULE_LINE);
    }
  });

  it('names no colour — every value is a token', () => {
    const start = css.indexOf(SECTION);
    const unfenced = findUnfencedHex(css).filter(
      (hit) => hit.index >= start && hit.index < start + SECTION.length
    );
    expect(unfenced).toEqual([]);
    expect(SECTION_CODE).not.toMatch(/:\s*(?:red|green|blue|orange|purple|gold|teal)\b/);
    expect(SECTION_CODE).not.toMatch(/\b(?:rgba?|hsla?)\(/);
  });

  it('draws no colour except through a role token', () => {
    const colourish = [
      ...SECTION_CODE.matchAll(
        /\b(?:color|background|fill|stroke|accent-color)\s*:\s*([^;]+);/g
      ),
    ].map((match) => match[1].trim());
    expect(colourish.length).toBeGreaterThan(60);
    for (const value of colourish) {
      expect({
        value,
        ok: /^(var\(--|color-mix\(|currentColor|transparent|inherit|none)/.test(value),
      }).toEqual({ value, ok: true });
    }
  });

  it('names the mockup and the ticket, so the next reader can find the authority', () => {
    expect(SECTION).toContain('docs/mockups/ship/export-studio.html');
    expect(SECTION).toContain('#5329');
  });
});

/* -------------------------------------------------------------------------
   2. One word, one colour — across the graph, the table and the badge
   ------------------------------------------------------------------------- */

describe('a projection status is one colour everywhere it appears', () => {
  it('paints the graph node and its edge from the same tone as the row badge', () => {
    // `statusPresentation().tone` is what a `Badge` takes and what the SVG marks put on
    // `data-tone`; one selector per tone below means the two cannot resolve differently.
    for (const [status, tone] of Object.entries(PROJECTION_STATUS_TONE)) {
      expect({ status, tone: statusPresentation(status as never).tone }).toEqual({
        status,
        tone,
      });
    }
  });

  it('gives every tone the marks can carry a stroke rule', () => {
    const painted = new Set(
      [...SECTION_CODE.matchAll(/\.xstd-node\[data-tone='([a-z]+)'\]/g)].map((m) => m[1])
    );
    for (const tone of new Set(Object.values(PROJECTION_STATUS_TONE))) {
      expect({ tone, painted: painted.has(tone) }).toEqual({ tone, painted: true });
    }
  });

  it('lets the reader’s own selection out-rank the status hue', () => {
    // A selected node must read as selected whatever its status, so the rule that paints it
    // has to be declared after every tone rule rather than merely be more specific.
    const selected = xstdRule(
      ".xstd-node[data-selected='true'], .xstd-edge[data-selected='true']"
    );
    const tonesLines = [...SECTION_CODE.matchAll(/\.xstd-node\[data-tone=/g)].length;
    expect(tonesLines).toBeGreaterThan(4);
    expect(parseDeclarations(selected.body).get('stroke')).toBe('var(--accent)');
    for (const tone of new Set(Object.values(PROJECTION_STATUS_TONE))) {
      const rule = rules.find((r) => r.prelude.startsWith(`.xstd-node[data-tone='${tone}']`));
      if (rule) expect(selected.line).toBeGreaterThan(rule.line);
    }
  });
});

/* -------------------------------------------------------------------------
   3. Nothing frozen in pixels
   ------------------------------------------------------------------------- */

describe('the fourteen lengths the mockup froze all follow the font scale', () => {
  it('states no px length except a hairline or a mark stroke', () => {
    const offenders: string[] = [];
    for (const match of SECTION_CODE.matchAll(/([\w-]+)\s*:\s*([^;{}]*\d(?:\.\d+)?px[^;{}]*);/g)) {
      const [, property, value] = match;
      // A hairline, a mark stroke, an outline offset and an underline offset are the four
      // things that are genuinely 1–3 device pixels rather than type: growing them with the
      // font scale makes a border thicker, not a page more readable.
      const allowed =
        /^(border|border-block-end|border-block-start|border-inline-end|border-inline-start|box-shadow|outline|outline-offset|text-underline-offset|stroke-width|inline-size|block-size)$/.test(
          property
        ) && /^-?[0-3](?:\.\d+)?px$|(^|\s)-?[0-3](?:\.\d+)?px(\s|\))/.test(value);
      if (!allowed) offenders.push(`${property}: ${value}`);
    }
    expect(offenders).toEqual([]);
  });

  it('sizes the gate’s dimension column and the round-trip glyph in ch, not px', () => {
    expect(declaration('.xstd-gate__dimension', 'inline-size')).toMatch(/ch$/);
    expect(declaration('.xstd-rt__glyph', 'inline-size')).toMatch(/ch$/);
  });

  it('caps the tall panes against the viewport as well as the scale', () => {
    // A pane that only grew with the font scale would push the page past the window at the
    // Largest scale; one that only tracked the viewport would ignore the preference.
    for (const [prelude, property] of [
      ['.xstd-tree__scroll', 'block-size'],
      ['.xstd-problems', 'max-block-size'],
      ['.xstd-map__frame', 'max-block-size'],
      ['.xstd-guard', 'min-block-size'],
    ] as const) {
      const value = declaration(prelude, property);
      expect({ prelude, value }).toEqual({
        prelude,
        value: expect.stringMatching(/^min\(\d+(?:\.\d+)?vh, \d+(?:\.\d+)?rem\)$/),
      });
    }
  });

  it('breaks the stepper to two columns at a rem width, not a px one', () => {
    expect(SECTION_CODE).toContain('@media (max-width: 56.25rem)');
    expect(SECTION_CODE).not.toMatch(/@media[^{]*\d+px/);
  });
});

/* -------------------------------------------------------------------------
   4. Quiet text, and the ink rule the tokens force
   ------------------------------------------------------------------------- */

describe('quiet text is the muted step, never the subtle one', () => {
  it('never inks a word with --fg-subtle at this block’s sizes', () => {
    // `--fg-subtle` measures ~3.1:1 on the card at 11–12px, a serious axe finding. It is
    // allowed on a *glyph*, which is a non-text mark, and nowhere else.
    const textInks = [...SECTION_CODE.matchAll(/([^{}]*)\{([^{}]*)\}/g)].filter(([, , body]) =>
      /(?:^|;|\s)color\s*:\s*var\(--fg-subtle\)/.test(body)
    );
    for (const [, prelude] of textInks) {
      expect({
        prelude: prelude.trim(),
        // Only selectors that resolve to a glyph or an empty-cell mark may take it —
        // `__open`, `__twist`, `.xstd-file-icon` and `.xstd-folder-icon` are all `<svg>`
        // elements, and `__count` / `__empty` / `__none` are the em-dash placeholders that
        // stand in for an absent value.
        ok: /svg|-icon|__twist|__icon|__open|__count|__empty|__none/.test(prelude),
      }).toEqual({ prelude: prelude.trim(), ok: true });
    }
  });

  it('gives the quiet steps the muted token', () => {
    expect(declaration('.xstd-quiet', 'color')).toBe('var(--fg-muted)');
    expect(declaration('.xstd-note', 'color')).toBe('var(--fg-muted)');
    expect(declaration('.xstd-stage__desc', 'color')).toBe('var(--fg-muted)');
    expect(declaration('.xstd-failure__body', 'color')).toBe('var(--fg-muted)');
  });

  it('never paints a -fg tone ink on a plain surface', () => {
    // The `-soft`/`-fg` pairs are calibrated against each other, not against the card:
    // `--ok-fg` measures 1.5:1 on Nord's surface. `--accent-fg` is the exception the whole
    // app makes — it is theme-aware and clears AA everywhere (HIVE-8.1's finding).
    const inks = [...SECTION_CODE.matchAll(/color:\s*var\(--([a-z]+)-fg\)/g)].map((m) => m[1]);
    for (const role of inks) {
      const usedOnItsOwnGround = SECTION_CODE.includes(`var(--${role}-soft)`);
      expect({ role, ok: role === 'accent' || usedOnItsOwnGround }).toEqual({ role, ok: true });
    }
  });

  it('never puts an ink other than its own -fg on a -soft ground', () => {
    for (const match of SECTION_CODE.matchAll(/\{([^{}]*var\(--([a-z]+)-soft\)[^{}]*)\}/g)) {
      const [, body, role] = match;
      const ink = parseDeclarations(body).get('color');
      // A `-soft` fill either states its own `-fg` ink, or states none and inherits — which is
      // only safe for `--accent-soft`, the one theme-aware tint (measured in the next test).
      expect({ role, ink: ink ?? null }).toEqual({
        role,
        ink: ink === undefined ? null : `var(--${role}-fg)`,
      });
      if (ink === undefined) expect(role).toBe('accent');
    }
  });

  it.each(APPEARANCES)(
    'keeps inherited --fg legible on --accent-soft, the one tint it may land on, in %s',
    (_id, block) => {
      // `--accent-soft` is theme-aware — it darkens with the appearance — which is why a row
      // may tint itself with it and keep the page's own foreground. The other `-soft` steps
      // are fixed light values (a Badge is a light pill on a dark surface), so `--fg` on one
      // of those measures 1.03:1 in Nord and the rules above forbid it.
      const surface = paint('--bg-surface', block, PAPER);
      const tint = compositeOver(resolveThemeToken('--accent-soft', tokens, block as never), surface);
      const ink = compositeOver(resolveThemeToken('--fg', tokens, block as never), tint);
      expect(contrastRatio(ink, tint)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
    }
  );
});

describe('the -soft / -fg pairs this block spends are legible in every appearance', () => {
  const PAIRS = ['--ok', '--warn', '--danger', '--accent'] as const;

  it.each(APPEARANCES)('clears AA on its own tint in the %s appearance', (_id, block) => {
    const surface = paint('--bg-surface', block, PAPER);
    for (const token of PAIRS) {
      const tint = compositeOver(resolveThemeToken(`${token}-soft`, tokens, block as never), surface);
      const ink = compositeOver(resolveThemeToken(`${token}-fg`, tokens, block as never), tint);
      expect({ token, ok: contrastRatio(ink, tint) >= WCAG_AA_NORMAL_TEXT_MIN }).toEqual({
        token,
        ok: true,
      });
    }
  });
});

/* -------------------------------------------------------------------------
   5. The tinted grounds this block invents, measured
   ------------------------------------------------------------------------- */

describe('every wash this block invents keeps --fg legible on it', () => {
  /**
   * The `color-mix` grounds, as (token, percent).
   *
   * `--ok` and `--accent` are absent on purpose: both are teals in Solarized and `--fg-muted`
   * is a desaturated one, so a wash of either at any usable strength puts the quiet step
   * between 4.20:1 and 4.49:1. The five surfaces that would have wanted one — the
   * original-source card, the "generated" and advisory notices, the run-verification prompt
   * and the evidence drawer — take a *contour* on the plain surface instead, which is also
   * what the mockup draws for the first of them.
   */
  const WASHES: readonly (readonly [string, string, number])[] = [
    ['.xstd-notice[data-tone=\'warn\']', '--warn', 12],
    ['.xstd-notice[data-tone=\'danger\']', '--danger', 10],
    ['.xstd-failure', '--danger', 8],
    ['.xstd-gate[data-decision=\'block\']', '--danger', 8],
    ['.xstd-gate[data-decision=\'allow_with_warning\']', '--warn', 10],
    ['.xstd-event[data-level=\'warn\']', '--warn', 12],
    ['.xstd-event[data-level=\'error\']', '--danger', 10],
    ['.xstd-guard', '--warn', 8],
  ];

  it('mixes exactly the percentages this suite measures', () => {
    for (const [prelude, token, percent] of WASHES) {
      expect({ prelude, mix: declaration(prelude, 'background') }).toEqual({
        prelude,
        mix: `color-mix(in srgb, var(${token}) ${percent}%, var(--bg-surface))`,
      });
    }
  });

  it('grounds an untoned notice on the surface, where the quiet step still clears AA', () => {
    // `--bg-subtle` and `--bg-inset` put `--fg-muted` at 4.34:1 and 4.35:1 in Solarized;
    // the surface leaves it at 4.86:1. Measured in the browser, pinned here.
    expect(declaration('.xstd-notice', 'background')).toBe('var(--bg-surface)');
  });

  it.each(APPEARANCES)('keeps --fg-muted legible on an untoned notice in %s', (_id, block) => {
    const ground = paint('--bg-surface', block, PAPER);
    const ink = compositeOver(resolveThemeToken('--fg-muted', tokens, block as never), ground);
    expect(contrastRatio(ink, ground)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
  });

  it('grounds every --ok and --accent surface on the surface itself, with a contour', () => {
    for (const [prelude, token] of [
      ['.xstd-original', '--ok'],
      [".xstd-notice[data-tone='ok']", '--ok'],
      [".xstd-notice[data-tone='accent']", '--accent'],
      ['.xstd-advisory', '--accent'],
      ['.xstd-evidence', '--accent'],
    ] as const) {
      expect({ prelude, background: declaration(prelude, 'background') }).toEqual({
        prelude,
        background: 'var(--bg-surface)',
      });
      expect(declaration(prelude, 'box-shadow')).toContain(`var(${token})`);
    }
  });

  it('grounds nothing at all in an --ok or --accent wash', () => {
    // The invariant behind the rule above, stated once so a future edit cannot re-introduce
    // one somewhere this suite does not name. A *border* may still blend those tokens with
    // `--border` — a hairline is a non-text mark and the 3:1 floor is the one it answers to.
    const grounds = [...SECTION_CODE.matchAll(/background\s*:\s*([^;]+);/g)].map((m) => m[1]);
    for (const ground of grounds) {
      expect({ ground, ok: !/color-mix\(in srgb, var\(--(?:ok|accent)\)/.test(ground) }).toEqual({
        ground,
        ok: true,
      });
    }
  });

  it.each(APPEARANCES)('keeps --fg above AA on every wash in the %s appearance', (_id, block) => {
    for (const [prelude, token, percent] of WASHES) {
      const ground = wash(token, percent, block);
      const ink = compositeOver(resolveThemeToken('--fg', tokens, block as never), ground);
      expect({
        prelude,
        ok: contrastRatio(ink, ground) >= WCAG_AA_NORMAL_TEXT_MIN,
      }).toEqual({ prelude, ok: true });
    }
  });

  it.each(APPEARANCES)('keeps --fg-muted above AA on every wash in %s', (_id, block) => {
    // A wash that only clears AA for `--fg` is a trap: half of these cards carry a quiet
    // second line, and `--fg-muted` is a full step closer to the ground. The browser suite
    // caught exactly this on the original-source card (4.41:1 in Solarized), which is why
    // the percentages below are what they are.
    for (const [prelude, token, percent] of WASHES) {
      const ground = wash(token, percent, block);
      const ink = compositeOver(resolveThemeToken('--fg-muted', tokens, block as never), ground);
      expect({
        prelude,
        ok: contrastRatio(ink, ground) >= WCAG_AA_NORMAL_TEXT_MIN,
      }).toEqual({ prelude, ok: true });
    }
  });
});

/* -------------------------------------------------------------------------
   6. The heat scale
   ------------------------------------------------------------------------- */

describe('the loss heatmap reads without colour, and its washes still clear AA', () => {
  /** The four levels, as the rules mix them. */
  const HEAT: readonly (readonly [number, string, number])[] = [
    [1, '--warn', 14],
    [2, '--warn', 28],
    [3, '--danger', 24],
    [4, '--danger', 40],
  ];

  it('mixes exactly the percentages this suite measures', () => {
    for (const [level, token, percent] of HEAT) {
      expect({ level, mix: declaration(`.xstd-heat__cell[data-heat='${level}']`, 'background') })
        .toEqual({
          level,
          mix: `color-mix(in srgb, var(${token}) ${percent}%, var(--bg-surface))`,
        });
    }
  });

  it('inks every cell with --fg, so no level relies on a lighter foreground', () => {
    // The mockup's level-4 cell sets a literal `#fff`, which measures 1.4:1 on the
    // Whiteboard theme's wash. One ink for all five levels is what makes the scale safe.
    expect(declaration('.xstd-heat__cell', 'color')).toBe('var(--fg)');
    for (const [level] of HEAT) {
      expect(
        parseDeclarations(xstdRule(`.xstd-heat__cell[data-heat='${level}']`).body).has('color')
      ).toBe(false);
    }
  });

  it.each(APPEARANCES)('keeps --fg above AA on every heat level in %s', (_id, block) => {
    for (const [level, token, percent] of HEAT) {
      const ground = wash(token, percent, block);
      const ink = compositeOver(resolveThemeToken('--fg', tokens, block as never), ground);
      expect({ level, ok: contrastRatio(ink, ground) >= WCAG_AA_NORMAL_TEXT_MIN }).toEqual({
        level,
        ok: true,
      });
    }
  });

  it('states the level in words and in a glyph run beside the count', () => {
    // Colour is the third channel here, never the first (DESIGN.md §6).
    expect(declaration('.xstd-heat__level', 'font-size')).toBe('var(--fs-2xs)');
    expect(declaration('.xstd-heat__glyph', 'font-family')).toBe('var(--font-mono)');
  });
});

/* -------------------------------------------------------------------------
   7. The marks that carry meaning clear the non-text floor
   ------------------------------------------------------------------------- */

describe('the non-text marks clear WCAG 1.4.11', () => {
  it.each(APPEARANCES)('keeps the progress fill visible on its track in %s', (_id, block) => {
    const surface = paint('--bg-surface', block, PAPER);
    const track = paint('--bg-inset', block, surface);
    const fill = paint('--accent', block, track);
    expect(contrastRatio(fill, track)).toBeGreaterThanOrEqual(WCAG_AA_NON_TEXT_MIN);
  });

  it.each(APPEARANCES)('keeps a done stage’s badge visible on the card in %s', (_id, block) => {
    const surface = paint('--bg-surface', block, PAPER);
    const badge = paint('--ok', block, surface);
    expect(contrastRatio(badge, surface)).toBeGreaterThanOrEqual(WCAG_AA_NON_TEXT_MIN);
  });

  it('draws the stage badge’s glyph on the tone’s own on-accent ink', () => {
    for (const status of ['done', 'failed'] as const) {
      expect(
        declaration(`.xstd-stage[data-status='${status}'] .xstd-stage__icon`, 'color')
      ).toBe('var(--fg-on-accent)');
    }
    // `active` is the one that takes the calibrated soft/fg pair — it is a resting state
    // rather than a completed one, so it must not read as loud as `done`.
    expect(declaration(".xstd-stage[data-status='active'] .xstd-stage__icon", 'color')).toBe(
      'var(--accent-fg)'
    );
  });
});

/* -------------------------------------------------------------------------
   8. Focus is visible wherever this block takes it
   ------------------------------------------------------------------------- */

describe('focus stays visible on everything this block styles', () => {
  it('rings the step panel, which takes programmatic focus on every step change', () => {
    expect(declaration('.xstd-panel:focus-visible', 'outline')).toContain('var(--accent)');
  });

  it('rings a tree row without letting the ring fall outside its scroller', () => {
    expect(declaration('.xstd-tree__row:focus-visible', 'outline')).toContain('var(--accent)');
    expect(declaration('.xstd-tree__row:focus-visible', 'outline-offset')).toBe('-2px');
  });

  it('never removes an outline without replacing it', () => {
    for (const match of SECTION_CODE.matchAll(/([^{}]*)\{([^{}]*outline:\s*none[^{}]*)\}/g)) {
      const prelude = match[1].trim();
      const replaced = rules.some(
        (rule) =>
          rule.prelude === `${prelude}-visible` ||
          rule.prelude === prelude.replace(/:focus$/, ':focus-visible')
      );
      expect({ prelude, replaced }).toEqual({ prelude, replaced: true });
    }
  });
});
