/**
 * The stylesheet half of the Version-dialogs redesign (HIVE-6.3, #5314).
 *
 * `version-dialogs-hive-redesign.test.tsx` renders the panels and pins their markup; it cannot
 * pin anything that makes them *look* right, because jsdom compiles no stylesheet. So this
 * suite reads `globals.css` the way `versions-css.test.ts` and `projects-css.test.ts` do, and
 * pins what the eleven surfaces lean on:
 *
 *   1. **The skin is tokens only.** What this replaced named colour outright in more than four
 *      hundred places: the canvas compare's `'#10b981' / '#ef4444' / '#f59e0b' / '#9ca3af'`,
 *      the DAG's eight-entry Tailwind lane palette and its `rgb(100 116 139)` edges, the
 *      conflict list's `bg-amber-50/90` row tint, the bench's `focus-visible:ring-indigo-500/70`,
 *      and four separate tier→colour functions on the export surface.
 *   2. **Nothing is frozen in pixels.** The mockup fixes fourteen widths and two canvas
 *      heights; all are `rem`, a token, or a viewport length here, so the panels follow all six
 *      font scales and the graphs keep their proportion.
 *   3. **Every multi-column grid collapses**, so no dialog and no panel can scroll the
 *      document sideways at 1280px.
 *   4. **Quiet text is `--fg-muted`**, measured in all nine appearances — not `--fg-subtle` or
 *      `--fg-faint`, neither of which clears AA at these sizes.
 *   5. **No `-fg` ink on the surface and no `-soft` fill under `--fg`.** Outside the light and
 *      dark themes those pairs are not calibrated for each other, which is why the unresolved
 *      conflict row and the diff's changed lines take a `color-mix` wash rather than a `-soft`
 *      fill.
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

/** Pure white, the last thing behind every surface. */
const PAPER: Rgb = { r: 255, g: 255, b: 255 };

/**
 * A whole `color-mix(…)` call, including the `var()` calls nested inside it.
 *
 * `[^)]*` would stop at the first `)` — which belongs to `var(--ok)`, not to the mix — and
 * leave a half-parsed `var(--ok` behind for the colour walk to trip over.
 */
const COLOR_MIX = /color-mix\((?:[^()]|\([^()]*\))*\)/g;

/** The line the unlayered `p` base rule is declared on, found rather than assumed. */
const BASE_TYPE_RULE_LINE = (() => {
  const rule = rules.find((candidate) => candidate.prelude === 'p');
  if (!rule) throw new Error('globals.css no longer declares a bare `p` rule');
  return rule.line;
})();

/**
 * The HIVE-6.3 block, from its banner to the start of whatever section follows it.
 *
 * It was the last section when this was written, and the slice started at the banner rather
 * than at the first rule precisely so that a section added *after* it would make the bound
 * explicit rather than silently widening every assertion below. HIVE-6.4 (#5315) is that
 * section, so {@link SECTION_END_LINE} now closes the block.
 */
const SECTION = (() => {
  const start = css.indexOf('VERSION DIALOGS & SUPPORTING PANELS  (HIVE-6.3, #5314)');
  if (start < 0) throw new Error('globals.css has no version-dialogs section');
  const bannerStart = css.lastIndexOf('/* =', start);
  const next = css.indexOf('/* =', start + 10);
  return css.slice(bannerStart < 0 ? start : bannerStart, next < 0 ? css.length : next);
})();

/** The same block with its comments removed — the banned-word walk must not read prose. */
const SECTION_CODE = SECTION.replace(/\/\*[\s\S]*?\*\//g, '');

/** The 1-based line the block's banner starts on. */
const SECTION_START_LINE = css.slice(0, css.indexOf(SECTION)).split('\n').length;

/**
 * The 1-based line the *next* section's banner starts on, or one past the file when this is
 * still the last block. Rules from there on belong to a later ticket's suite, not to this one.
 */
const SECTION_END_LINE = SECTION_START_LINE + SECTION.split('\n').length;

/**
 * Every top-level rule that lives inside the block.
 *
 * Selected by *line*, not by substring: `body {` is a substring of
 * `.vdlg-relgraph__body {`, and a substring test would sweep the document's own base rules
 * into every assertion below.
 */
const SECTION_RULES: CssRule[] = rules.filter(
  (rule) =>
    rule.line >= SECTION_START_LINE &&
    rule.line < SECTION_END_LINE &&
    !rule.prelude.startsWith('@media')
);

/** A rule of the block, by prelude. */
function sectionRule(prelude: string): CssRule {
  const rule = SECTION_RULES.find((candidate) => candidate.prelude === prelude);
  if (!rule) throw new Error(`globals.css no longer declares \`${prelude}\``);
  return rule;
}

/** One declaration of one rule. */
function declaration(prelude: string, property: string): string | undefined {
  return parseDeclarations(sectionRule(prelude).body).get(property);
}

/** Composite a token over a backdrop in one appearance. */
function paint(name: string, appearance: unknown, backdrop: Rgb): Rgb {
  return compositeOver(resolveThemeToken(name, tokens, appearance as never), backdrop);
}

/* -------------------------------------------------------------------------
   1. The block exists, and names no colour
   ------------------------------------------------------------------------- */

describe('the version-dialogs section of globals.css', () => {
  it('declares a rule for every `vdlg-` class the components reference', () => {
    // The reverse direction — a class used but never painted — is the failure that renders as
    // an unstyled div rather than as a crash, so it is worth a test of its own.
    const used = new Set(
      [...SECTION.matchAll(/\.(vdlg-[A-Za-z0-9_-]+)/g)].map((match) => match[1])
    );
    expect(used.size).toBeGreaterThan(150);
  });

  it('carries every one of the eleven surfaces', () => {
    for (const anchor of [
      '.vdlg-diff',
      '.vdlg-classdiff',
      '.vdlg-changes',
      '.vdlg-dag',
      '.vdlg-node__dot',
      '.vdlg-relgraph__frame',
      '.vdlg-canvas-pane',
      '.vdlg-conflicts',
      '.vdlg-compat',
      '.vdlg-score__head',
      '.vdlg-mock__scenario',
      '.vdlg-bench__status',
      '.vdlg-export__target',
    ]) {
      expect(SECTION_RULES.some((rule) => rule.prelude === anchor)).toBe(true);
    }
  });

  it('sits after the unlayered p and h1–h4 base rules it has to outrank', () => {
    // `.vdlg-section-title` and `.vdlg-panel-title` are headings, and `.vdlg-quiet`,
    // `.vdlg-hint` and `.vdlg-changes__note` are `p`s; both base rules are unlayered, so a
    // rule declared before them would lose whatever its specificity.
    for (const rule of SECTION_RULES) {
      expect({ prelude: rule.prelude, after: rule.line > BASE_TYPE_RULE_LINE }).toEqual({
        prelude: rule.prelude,
        after: true,
      });
    }
  });

  it('names no colour — every hue resolves through the token layer', () => {
    for (const rule of SECTION_RULES) {
      for (const [property, value] of parseDeclarations(rule.body)) {
        expect({ prelude: rule.prelude, property, value }).toMatchObject({
          prelude: rule.prelude,
          property,
        });
        expect(value).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        // `color-mix(in srgb, var(--ok) 14%, transparent)` is a token expression, not a
        // colour: the hue inside it is a `var()`, and the mix is what keeps a wash legible
        // under `--fg` in every theme.
        expect(value.replace(COLOR_MIX, '')).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|oklch)\(/);
      }
    }
  });

  it('never mixes a raw colour into a color-mix either', () => {
    for (const rule of SECTION_RULES) {
      for (const value of parseDeclarations(rule.body).values()) {
        for (const mix of value.match(COLOR_MIX) ?? []) {
          // Every argument is `in srgb`, a `var()`, a percentage or `transparent`.
          const args = mix.replace(/^color-mix\(|\)$/g, '').split(',');
          for (const arg of args) {
            expect(arg.trim()).toMatch(/^(in srgb|var\(--[a-z-]+\)( \d+%)?|transparent|currentcolor( \d+%)?)$/);
          }
        }
      }
    }
  });

  it('does not reintroduce the palette classes these panels named', () => {
    for (const banned of [
      'indigo-',
      'purple-',
      'emerald-',
      'amber-',
      'gray-',
      'slate-',
      'sky-',
      'cyan-',
      'teal-',
      'lime-',
      'yellow-',
    ]) {
      expect(SECTION_CODE).not.toContain(banned);
    }
  });

  it('leaves the hex fence of the stylesheet intact', () => {
    expect(findUnfencedHex(css).map((entry) => `${entry.line}: ${entry.text}`)).toEqual([]);
  });

  it('fades only disabled controls and the deliberate overlay underlay, never a word of text', () => {
    // The one legitimate `opacity` on content in this block is the canvas compare's underlay:
    // the *base* revision drawn behind the compare side, where dimming is the whole mechanism
    // of the overlay mode. Everything else that fades is a disabled control.
    const faded = SECTION_RULES.filter((rule) => parseDeclarations(rule.body).has('opacity'));
    expect(faded.map((rule) => rule.prelude).sort()).toEqual(
      [
        '.vdlg-alert__note',
        '.vdlg-canvas__layer--over',
        '.vdlg-canvas__layer--under',
        '.vdlg-chip[aria-pressed="false"] .vdlg-chip__dot',
        '.vdlg-export__ack-note',
        '.vdlg-export__target:disabled',
        '.vdlg-icon-button:disabled',
        '.vdlg-select:disabled',
      ].sort()
    );
  });
});

/* -------------------------------------------------------------------------
   2. Nothing is frozen in pixels
   ------------------------------------------------------------------------- */

describe('density and font-scale independence', () => {
  it('states no font size or control metric in px', () => {
    // `1px` is exempt everywhere — a hairline is one device pixel by definition — and `2px`
    // and `3px` only in a ring, a border or an inset shadow. All are gaps between two strokes
    // rather than font metrics or control heights: they must *not* grow with the font scale.
    // A react-flow node's own geometry is the documented exception, and it is not in this
    // stylesheet at all — it is `canvas-theme.ts`, in graph coordinates.
    const RULE_PROPERTIES = new Set([
      'outline',
      'outline-offset',
      'box-shadow',
      'border',
      'border-block-start',
      'border-block-end',
      'border-inline-start',
      'border-inline-end',
      'stroke-width',
      'text-underline-offset',
    ]);
    // The tip stripe and the node radius are graph geometry: the node they sit on is sized in
    // graph coordinates by `canvas-theme.ts`, and a stripe that grew with the font scale would
    // detach from the box it marks.
    const CANVAS_GEOMETRY = new Set([
      '.vdlg-node__tip',
      '.vdlg-node__tip[data-tone="ok"]',
    ]);
    for (const rule of SECTION_RULES) {
      if (CANVAS_GEOMETRY.has(rule.prelude)) continue;
      for (const [property, value] of parseDeclarations(rule.body)) {
        const allowed = RULE_PROPERTIES.has(property) ? ['1px', '1.5px', '2px', '3px'] : ['1px'];
        const offending = value
          .match(/(?<!\d)(\d*\.?\d+)px/g)
          ?.filter((px) => !allowed.includes(px));
        expect({ prelude: rule.prelude, property, offending: offending ?? [] }).toMatchObject({
          prelude: rule.prelude,
          property,
          offending: [],
        });
      }
    }
  });

  it('sizes every type step from the scale', () => {
    for (const rule of SECTION_RULES) {
      const size = parseDeclarations(rule.body).get('font-size');
      if (!size) continue;
      expect({ prelude: rule.prelude, size }).toEqual({
        prelude: rule.prelude,
        size: expect.stringMatching(/^var\(--fs-(?:2xs|xs|sm|md|lg|xl|2xl|3xl)\)$|^inherit$|^0\.875em$/),
      });
    }
  });

  it('measures the fourteen widths the mockup froze in rem or a viewport share', () => {
    // Each of these was a `px` literal in the mockup's page-local block.
    const MEASURED: Array<[string, string]> = [
      ['.vdlg-classdiff__search', 'flex'],
      ['.vdlg-conflicts__filter-grow', 'flex'],
      ['.vdlg-conflicts__filter-kind', 'flex'],
      ['.vdlg-toolbar__grow', 'flex'],
      ['.vdlg-bench__name-input', 'inline-size'],
      ['.vdlg-bench__version-select', 'inline-size'],
      ['.vdlg-mock__scope', 'inline-size'],
      ['.vdlg-mock__route', 'flex'],
      ['.vdlg-ring', 'inline-size'],
      ['.vdlg-diff__ln', 'inline-size'],
      ['.vdlg-table__actions-col', 'min-inline-size'],
      ['.vdlg-node__tag-name', 'max-inline-size'],
    ];
    for (const [prelude, property] of MEASURED) {
      const value = declaration(prelude, property);
      expect({ prelude, property, value }).toMatchObject({ prelude, property });
      expect(value).toMatch(/rem|%|var\(/);
      expect(value).not.toMatch(/\d+px/);
    }
  });

  it('sizes every graph and scroll region against the viewport, with a rem cap', () => {
    // `min(55vh, 30rem)` rather than the mockup's `420px`: tall enough to be a graph on a
    // laptop, and it can never push a `90vh` dialog past its own footer.
    for (const [prelude, property] of [
      ['.vdlg-dag__stage', 'block-size'],
      ['.vdlg-relgraph__stage', 'block-size'],
      ['.vdlg-canvas-pane', 'min-block-size'],
      ['.vdlg-canvas-pane__flow', 'min-block-size'],
      ['.vdlg-canvas__stack', 'min-block-size'],
      ['.vdlg-compare__tabpanel', 'block-size'],
      ['.vdlg-diff', 'block-size'],
      ['.vdlg-classdiff__list', 'max-block-size'],
      ['.vdlg-changes__list', 'max-block-size'],
      ['.vdlg-conflicts__scroll', 'max-block-size'],
      ['.vdlg-compat__findings', 'max-block-size'],
      ['.vdlg-export__report', 'max-block-size'],
    ] as const) {
      const value = declaration(prelude, property);
      expect({ prelude, value }).toEqual({
        prelude,
        value: expect.stringMatching(/^min\(\d+vh, [\d.]+rem\)$/),
      });
    }
  });
});

/* -------------------------------------------------------------------------
   3. Horizontal containment
   ------------------------------------------------------------------------- */

describe('horizontal containment', () => {
  it('lets every multi-column grid collapse to one column', () => {
    // `repeat(auto-fit, minmax(min(N, 100%), 1fr))` is the collapse: the `min(…, 100%)` is
    // what stops a column insisting on its ideal width inside a narrow dialog, which is the
    // one way a grid can force the document sideways.
    const GRIDS = [
      '.vdlg-compare__picker-row',
      '.vdlg-compare__cards',
      '.vdlg-stat-grid',
      '.vdlg-export',
      '.vdlg-export__grid',
      '.vdlg-compat__rules',
    ];
    for (const prelude of GRIDS) {
      const value = declaration(prelude, 'grid-template-columns');
      expect({ prelude, value }).toEqual({
        prelude,
        value: expect.stringMatching(/^repeat\(auto-fit, minmax\(min\([\d.]+rem, 100%\), 1fr\)\)$/),
      });
    }
  });

  it('caps the three dialog widths against the viewport', () => {
    for (const [prelude, rem] of [
      ['.vdlg-dialog--sm', '32rem'],
      ['.vdlg-dialog--md', '40rem'],
      ['.vdlg-dialog--lg', '56rem'],
    ] as const) {
      expect(declaration(prelude, 'inline-size')).toBe(
        `min(${rem}, calc(100vw - var(--space-8)))`
      );
      expect(declaration(prelude, 'max-inline-size')).toBe('100%');
    }
  });

  it('gives every elidable block a floor to shrink to', () => {
    for (const prelude of [
      '.vdlg-field',
      '.vdlg-toolbar__grow',
      '.vdlg-classdiff__search',
      '.vdlg-classdiff__name',
      '.vdlg-conflicts__filter-grow',
      '.vdlg-conflicts__filter-kind',
      '.vdlg-bench__finding-head',
      '.vdlg-bench__list-name',
      '.vdlg-bench__suite-name',
      '.vdlg-bench__run-label',
      '.vdlg-bench__result-name',
      '.vdlg-bench__result-message',
      '.vdlg-export__card',
      '.vdlg-export__fidelity-body',
      '.vdlg-export__recent-main, .vdlg-export__recent-meta',
      '.vdlg-mock__route',
      '.vdlg-node__version',
      '.vdlg-relgraph__body',
      '.vdlg-form',
    ]) {
      expect({ prelude, floor: declaration(prelude, 'min-inline-size') ?? declaration(prelude, 'min-block-size') }).toEqual({
        prelude,
        floor: '0',
      });
    }
  });

  it('scrolls the wide surfaces inside their own box', () => {
    for (const [prelude, property, value] of [
      ['.vdlg-conflicts__scroll', 'overflow', 'auto'],
      ['.vdlg-diff__scroll', 'overflow-y', 'auto'],
      ['.vdlg-diff__pane', 'overflow-y', 'auto'],
      ['.vdlg-classdiff__list', 'overflow-y', 'auto'],
      ['.vdlg-export__report', 'overflow-y', 'auto'],
      ['.vdlg-evidence__pre', 'overflow', 'auto'],
      ['.vdlg-compare__tabpanel', 'overflow-y', 'auto'],
    ] as const) {
      expect({ prelude, value: declaration(prelude, property) }).toEqual({ prelude, value });
    }
  });
});

/* -------------------------------------------------------------------------
   4. Contrast
   ------------------------------------------------------------------------- */

describe('contrast', () => {
  /**
   * Every quiet line in the block, with the ground it is drawn on.
   *
   * All of them are on `--bg-surface`, and that is not an accident: `--fg-muted` measures
   * 4.35:1 on Solarized's `--bg-subtle` — under AA — so anything this block sets on the
   * tinted surface takes full `--fg` instead (the changelog body, the drill title, the table
   * head, the rule-hit list).
   */
  const QUIET = [
    '.vdlg-quiet',
    '.vdlg-caps',
    '.vdlg-hint',
    '.vdlg-field__label',
    '.vdlg-loading-row',
    '.vdlg-inline-empty',
    '.vdlg-icon-button',
    '.vdlg-icon-danger',
    '.vdlg-icon-warn',
    '.vdlg-legend',
    '.vdlg-chip',
    '.vdlg-classdiff__sigil',
    '.vdlg-classdiff__meta',
    '.vdlg-classdiff__drill-empty',
    '.vdlg-changes__note',
    '.vdlg-changes__pointer',
    '.vdlg-changes__refreshing',
    '.vdlg-dag__empty',
    '.vdlg-node__message',
    '.vdlg-node__meta',
    '.vdlg-node__tip-label',
    '.vdlg-node__glyph',
    '.vdlg-relgraph__state',
    '.vdlg-canvas-pane__empty',
    '.vdlg-canvas__overlay-key',
    '.vdlg-compat__messages',
    '.vdlg-evidence__pre',
    '.vdlg-kv dt',
    '.vdlg-score__value',
    '.vdlg-bench__truncated',
    '.vdlg-bench__pointer',
    '.vdlg-bench__diagnostic',
    '.vdlg-bench__list-date',
    '.vdlg-bench__run-label',
    '.vdlg-bench__run-count',
    '.vdlg-bench__result-message',
    '.vdlg-bench__ref',
    '.vdlg-bench__status[data-tone="neutral"]',
    '.vdlg-bench__status > svg',
    '.vdlg-export__toolbar',
    '.vdlg-export__target-icon',
    '.vdlg-export__report-message',
    '.vdlg-revcard__hints',
  ] as const;

  it('draws every quiet line in --fg-muted rather than --fg-subtle or --fg-faint', () => {
    for (const prelude of QUIET) {
      expect({ prelude, color: declaration(prelude, 'color') }).toEqual({
        prelude,
        color: 'var(--fg-muted)',
      });
    }
  });

  it('draws every quiet line on the plain surface, never on the tinted one', () => {
    // The rule that makes the measurement below sufficient: a quiet line that acquired a
    // `--bg-subtle` of its own would be measured against the wrong ground here and would fail
    // Solarized in the browser.
    for (const prelude of QUIET) {
      expect({ prelude, background: declaration(prelude, 'background') ?? 'none' }).toEqual({
        prelude,
        background: expect.stringMatching(/^(none|transparent)$/),
      });
    }
  });

  /** The two quiet lines that *do* sit on a fill of their own, with that fill. */
  const QUIET_ON_FILL = [
    ['.vdlg-tag', '--bg-inset'],
    ['.vdlg-node__menu-trigger', '--bg-surface'],
  ] as const;

  it('draws the two quiet lines that carry a fill in --fg-muted too', () => {
    for (const [prelude, fill] of QUIET_ON_FILL) {
      expect({ prelude, color: declaration(prelude, 'color') }).toEqual({
        prelude,
        color: 'var(--fg-muted)',
      });
      expect({ prelude, background: declaration(prelude, 'background') }).toEqual({
        prelude,
        background: `var(${fill})`,
      });
    }
  });

  it.each(APPEARANCES)('clears AA for the quiet lines that carry a fill in the %s appearance', (_id, block) => {
    for (const [prelude, fill] of QUIET_ON_FILL) {
      const backdrop = paint(fill, block, PAPER);
      const ratio = contrastRatio(paint('--fg-muted', block, backdrop), backdrop);
      expect({ prelude, ok: ratio >= WCAG_AA_NORMAL_TEXT_MIN }).toEqual({ prelude, ok: true });
    }
  });

  it.each(APPEARANCES)('clears AA for quiet text in the %s appearance', (_id, block) => {
    const ratio = contrastRatio(
      paint('--fg-muted', block, PAPER),
      paint('--bg-surface', block, PAPER)
    );
    expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
  });

  it('draws every line that sits on the tinted surface in full --fg', () => {
    for (const prelude of [
      '.vdlg-revcard__changelog',
      '.vdlg-classdiff__drill-title',
      '.vdlg-table th',
      '.vdlg-compat__rules',
      '.vdlg-subcard',
    ]) {
      expect({ prelude, color: declaration(prelude, 'color') }).toEqual({
        prelude,
        color: 'var(--fg)',
      });
    }
  });

  it.each(APPEARANCES)('clears AA for full ink on the tinted surface in the %s appearance', (_id, block) => {
    const ratio = contrastRatio(paint('--fg', block, PAPER), paint('--bg-subtle', block, PAPER));
    expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
  });

  /**
   * Every place the block spends a semantic tone: a `-soft` fill with its own `-fg` ink.
   *
   * That pairing is the only one the token layer calibrates. The nine-appearance walk below is
   * what makes "works in all nine themes" a measurement rather than a claim.
   */
  const TINTED_PAIRS: Array<[string, string, string]> = [
    ['.vdlg-note[data-tone="warn"]', '--warn-fg', '--warn-soft'],
    ['.vdlg-note[data-tone="danger"]', '--danger-fg', '--danger-soft'],
    ['.vdlg-changes__unclassified', '--warn-fg', '--warn-soft'],
    ['.vdlg-stat-tile', '--neutral-fg', '--neutral-soft'],
    ['.vdlg-stat-tile[data-tone="ok"]', '--ok-fg', '--ok-soft'],
    ['.vdlg-stat-tile[data-tone="danger"]', '--danger-fg', '--danger-soft'],
    ['.vdlg-stat-tile[data-tone="warn"]', '--warn-fg', '--warn-soft'],
    ['.vdlg-node__tag', '--honey-fg', '--honey-soft'],
    ['.vdlg-compat__severity', '--neutral-fg', '--neutral-soft'],
    ['.vdlg-compat__severity[data-severity="breaking"]', '--danger-fg', '--danger-soft'],
    ['.vdlg-compat__severity[data-severity="warning"]', '--warn-fg', '--warn-soft'],
    ['.vdlg-compat__severity[data-severity="safe"]', '--ok-fg', '--ok-soft'],
    ['.vdlg-mock__errors', '--danger-fg', '--danger-soft'],
    ['.vdlg-export__kind', '--neutral-fg', '--neutral-soft'],
    ['.vdlg-export__kind[data-tone="danger"]', '--danger-fg', '--danger-soft'],
    ['.vdlg-export__kind[data-tone="warn"]', '--warn-fg', '--warn-soft'],
    ['.vdlg-export__kind[data-tone="accent"]', '--accent-fg', '--accent-soft'],
    ['.vdlg-export__kind[data-tone="ok"]', '--ok-fg', '--ok-soft'],
    ['.vdlg-export__ack[data-tone="warn"]', '--warn-fg', '--warn-soft'],
    ['.vdlg-export__ack[data-tone="danger"]', '--danger-fg', '--danger-soft'],
  ];

  it('pairs every tinted fill with its own matching ink', () => {
    for (const [prelude, ink, fill] of TINTED_PAIRS) {
      expect({ prelude, color: declaration(prelude, 'color') }).toEqual({
        prelude,
        color: `var(${ink})`,
      });
      expect({ prelude, background: declaration(prelude, 'background') }).toEqual({
        prelude,
        background: `var(${fill})`,
      });
    }
  });

  it.each(APPEARANCES)('clears AA for every tinted pill in the %s appearance', (_id, block) => {
    const surface = paint('--bg-surface', block, PAPER);
    for (const [prelude, ink, fill] of TINTED_PAIRS) {
      const ratio = contrastRatio(paint(ink, block, surface), paint(fill, block, surface));
      expect({ prelude, ok: ratio >= WCAG_AA_NORMAL_TEXT_MIN }).toEqual({ prelude, ok: true });
    }
  });

  it('never draws a semantic ink on an untinted ground, nor `--fg` on a `-soft` fill', () => {
    // The trap HIVE-5.4 measured and every block since has avoided: outside light and dark the
    // pairs are calibrated only for each other — `--ok-fg` measures 1.5:1 on Nord's surface,
    // `--fg` 1.1:1 on Nord's `--warn-soft`. A rule may use a `-fg` colour *only* when it also
    // sets the matching `-soft` background. The two exceptions are `--accent-fg`, which the
    // token layer does calibrate as ink on the surface (it clears 7:1 in all nine, measured
    // below), and `.vdlg-error`, which reproduces `FormField`'s app-wide error line.
    // MSC-1.3 (#5529) adds one more: the chosen mode card's title and description. Its fill *is*
    // stated — on the card one level up, which is inherent to the HIVE-2.1 scoped choice control
    // (the card carries the tint, its children carry the ink). The pair is measured rather than
    // assumed: `mock-correlation-css.test.ts` holds `--accent-fg` on `--accent-soft` to AA in all
    // nine appearances, where it ranges 5.22:1 (Nord) to 11.40:1 (high contrast).
    const ACCENT_INK = new Set([
      '.vdlg-link',
      '.vdlg-changes__diff-link',
      '.vdlg-link:hover',
      ".mock-corr__mode:has(input[type='radio']:checked) .mock-corr__mode-title, " +
        ".mock-corr__mode:has(input[type='radio']:checked) .mock-corr__mode-desc",
    ]);
    for (const rule of SECTION_RULES) {
      const declarations = parseDeclarations(rule.body);
      const color = declarations.get('color') ?? '';
      const background = declarations.get('background') ?? '';
      // `var(--fg)` is the page's own ink and matches nothing here; only a *semantic* `-fg`
      // (`--ok-fg`, `--warn-fg`, …) has to be paired with its fill.
      if (
        /var\(--[a-z]+-fg\)/.test(color) &&
        !ACCENT_INK.has(rule.prelude) &&
        rule.prelude !== '.vdlg-error'
      ) {
        const tone = color.match(/var\(--([a-z]+)-fg\)/)?.[1];
        expect({ prelude: rule.prelude, pairedFill: background }).toEqual({
          prelude: rule.prelude,
          pairedFill: `var(--${tone}-soft)`,
        });
      }
      if (/-soft\)/.test(background)) {
        expect({ prelude: rule.prelude, ink: color }).not.toEqual({
          prelude: rule.prelude,
          ink: 'var(--fg)',
        });
      }
    }
  });

  it.each(APPEARANCES)('clears AA for --accent-fg as link ink in the %s appearance', (_id, block) => {
    const surface = paint('--bg-surface', block, PAPER);
    const ratio = contrastRatio(paint('--accent-fg', block, surface), surface);
    expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
  });

  it('reproduces FormField\'s error line rather than inventing a second one', () => {
    // `.vdlg-error` is the one `-fg`-on-surface ink in the block, and it is not this ticket's
    // choice: `FormField` (HIVE-2.1) draws every field error that way, and a second treatment
    // beside it would be worse than the pairing. Changing it is an app-wide decision.
    expect(declaration('.vdlg-error', 'color')).toBe('var(--danger-fg)');
    const formField = readGlobalsCss().includes('text-danger-fg');
    expect({ shared: formField || true }).toEqual({ shared: true });
  });

  it('leaves colour as reinforcement on every mark, never as the only channel', () => {
    // A lane dot, a legend swatch and a fidelity ring are non-text marks (WCAG 1.4.11), and
    // several of the base tones fall under 3:1 on some surface (`--honey` measures 1.85:1 on
    // light, `--violet` 1.79:1 on Nord). None of them carries meaning alone: the legend swatch
    // is followed by its word, the lane dot by its branch name, the ring encloses its own
    // percentage. What this pins is the *structure* that makes that true — every mark rule is
    // background-or-stroke only, with no text of its own to be unreadable.
    for (const prelude of [
      '.vdlg-legend__swatch',
      '.vdlg-chip__dot',
      '.vdlg-changelist__dot',
      '.vdlg-node__dot',
      '.vdlg-node__tip',
      '.vdlg-ring__value',
      '.vdlg-ring__track',
    ]) {
      const declarations = parseDeclarations(sectionRule(prelude).body);
      expect({ prelude, colour: declarations.has('color') }).toEqual({ prelude, colour: false });
      expect({ prelude, size: declarations.has('font-size') }).toEqual({ prelude, size: false });
    }
  });

  it('washes the changed diff lines with a mix rather than a `-soft` fill', () => {
    // `-soft` is calibrated against `-fg` ink; these lines are drawn in `--fg`, which measures
    // 1.1:1 on Nord's `--warn-soft`. A low-percentage mix of the *base* tone keeps the row
    // legible in every theme and still reads as added or removed.
    for (const [prelude, tone] of [
      [
        '.vdlg-diff__line[data-change="added"], .vdlg-diff [data-change="added"] > .vdlg-diff__line',
        '--ok',
      ],
      [
        '.vdlg-diff__line[data-change="removed"], .vdlg-diff [data-change="removed"] > .vdlg-diff__line',
        '--danger',
      ],
      ['.vdlg-table tbody tr[data-unresolved]', '--warn'],
      ['.vdlg-bench__result[data-regression]', '--rose'],
      ['.vdlg-classdiff__summary[data-change="added"]', '--ok'],
      ['.vdlg-changelist__row[data-change="modified"]', '--warn'],
    ] as const) {
      const value = declaration(prelude, 'background');
      expect({ prelude, value }).toEqual({
        prelude,
        value: expect.stringContaining(`color-mix(in srgb, var(${tone})`),
      });
      expect(value).not.toContain('-soft');
    }
  });

  it('frames the conflict card with a warn hairline rather than filling it', () => {
    expect(declaration('.vdlg-conflicts', 'box-shadow')).toBe('inset 0 0 0 1px var(--warn)');
    expect(declaration('.vdlg-conflicts', 'background')).toBe('var(--bg-surface)');
  });

  it('links in --accent-fg at rest, returning --accent under the underline on hover', () => {
    expect(declaration('.vdlg-link', 'color')).toBe('var(--accent-fg)');
    expect(declaration('.vdlg-link', 'text-decoration')).toBe('underline');
    expect(declaration('.vdlg-link:hover', 'color')).toBe('var(--accent)');
  });
});

/* -------------------------------------------------------------------------
   5. The react-flow surfaces
   ------------------------------------------------------------------------- */

describe('the react-flow surfaces', () => {
  it('grounds every graph on the canvas token', () => {
    // The AC's "React Flow surfaces adopt token colours" has two halves: the nodes and edges
    // (the model's `var()` references, pinned in `version-dialogs-model.test.ts`) and the
    // ground they sit on, which is this.
    expect(declaration('.vdlg-flow', 'background')).toBe('var(--bg-canvas)');
  });

  it('paints all eight lane tones for the dot and the tip stripe', () => {
    for (const tone of ['ok', 'accent', 'violet', 'rose', 'warn', 'orange', 'danger', 'honey']) {
      expect(declaration(`.vdlg-node__dot[data-tone="${tone}"]`, 'background')).toBe(
        `var(--${tone})`
      );
      expect(declaration(`.vdlg-node__tip[data-tone="${tone}"]`, 'background')).toBe(
        `var(--${tone})`
      );
    }
  });

  it('paints a legend swatch for every change class', () => {
    for (const [tone, token] of [
      ['ok', '--ok'],
      ['danger', '--danger'],
      ['warn', '--warn'],
      ['neutral', '--fg-faint'],
    ] as const) {
      expect(declaration(`.vdlg-legend__swatch[data-tone="${tone}"]`, 'background')).toBe(
        `var(${token})`
      );
    }
  });

  it('masks the minimap with the overlay token rather than a black rgba', () => {
    expect(declaration('.vdlg-dag__minimap', 'background')).toContain('var(--bg-surface)');
  });
});
