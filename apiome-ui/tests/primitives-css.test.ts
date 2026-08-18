/**
 * The stylesheet half of the primitives & types redesign (HIVE-6.5, #5316).
 *
 * `primitives-hive-redesign.test.tsx` renders the screen and pins its markup; it cannot pin
 * anything that makes it *look* right, because jsdom compiles no stylesheet. So this suite
 * reads `globals.css` the way `projects-css.test.ts` and `import-wizard-css.test.ts` do, and
 * pins what the screen's four panes lean on:
 *
 *   1. **The skin is tokens only.** What this replaced named colour outright in a little over
 *      two hundred places: two scope pills written three times over
 *      (`bg-teal-100 text-teal-700 dark:bg-teal-900/40 …`), two status pills written twice,
 *      five `bg-indigo-100` icon tiles, a `bg-gray-900` code sample that stayed black in
 *      Whiteboard, three `bg-emerald-50` / `bg-amber-50` / `bg-red-50` resolver tiles, ten
 *      `text-indigo-600` checkboxes and seven `border-gray-300 dark:border-gray-600` selects.
 *   2. **Nothing is frozen in pixels.** The mockup's page-local block fixes the `micro` badge
 *      at 9.5px, the lock and star glyphs at 12px, the `step-pill` at 24px and four panel
 *      widths in px; all are `rem` or a token here, so the screen follows all six font scales.
 *   3. **Every multi-column grid collapses**, so no pane can scroll the document sideways at
 *      1280 px — the registry's table-plus-rail, the two explainer cards, the governance pair,
 *      the four-up constraint row and the source-kind cards.
 *   4. **Quiet text is `--fg-muted`, and every well that holds it is `--bg-inset`.** Measured
 *      in all nine appearances: `--fg-muted` clears AA on the surface (4.86:1 at worst) and on
 *      `--bg-inset` (5.02:1), and does *not* on `--bg-subtle` (4.35:1 in Solarized) — which is
 *      why the `$ref` example, the reference graph, the read-only base and the base-URI chip
 *      are inset wells and why a group row carries weight rather than a tint.
 *   5. **No `-fg` ink on the surface and no `--fg` on a `-soft` fill.** Outside light and dark
 *      those pairs are not calibrated for each other, which is why every tinted surface here
 *      is a `color-mix` wash and every inked word is a `Badge` in its own pair.
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

/** WCAG AA for large text — 18.66 px bold and up, which the stat figure is. */
const WCAG_AA_LARGE_TEXT_MIN = 3;

/** Pure white, the last thing behind every surface. */
const PAPER: Rgb = { r: 255, g: 255, b: 255 };

/** The line the unlayered `p` base rule is declared on, found rather than assumed. */
const BASE_TYPE_RULE_LINE = (() => {
  const rule = rules.find((candidate) => candidate.prelude === 'p');
  if (!rule) throw new Error('globals.css no longer declares a bare `p` rule');
  return rule.line;
})();

/**
 * Every top-level rule this ticket added, by prelude.
 *
 * Listed rather than pattern-matched so a rule that is *renamed* fails here instead of
 * silently dropping out of the token-only walk below.
 */
const PRIMITIVE_PRELUDES = [
  ".prm-quiet",
  ".prm-num",
  ".prm-faint",
  ".prm-hint",
  ".prm-error",
  ".prm-caution",
  ".prm-caution > svg",
  ".prm-req",
  ".prm-spin",
  ".prm-registry-grid",
  ".prm-panels",
  ".prm-kpi--alert",
  ".prm-kpi--alert:hover",
  ".prm-kpi-skeleton",
  ".prm-kpi-skeleton__label",
  ".prm-kpi-skeleton__value",
  ".prm-kpi-skeleton__foot",
  ".prm-panel-head",
  ".prm-panel-head > svg",
  ".prm-panel-head__text",
  ".prm-panel-head__title",
  ".prm-panel-head__title > svg",
  ".prm-panel-head__sub",
  ".prm-rail",
  ".prm-rail__card",
  ".prm-rail__card--flush",
  ".prm-rail__head",
  ".prm-rail__head > svg",
  ".prm-rail__desc",
  ".prm-rail__link",
  ".prm-rail__activity-head",
  ".prm-rail__title",
  ".prm-rail__title > svg",
  ".prm-rail__aside",
  ".prm-rail__state",
  ".prm-code",
  ".prm-code__comment",
  ".prm-code--tall",
  ".prm-code--clip",
  ".prm-activity",
  ".prm-activity__row",
  ".prm-activity__row:first-child",
  ".prm-activity__dot",
  ".prm-activity__text",
  ".prm-activity__title",
  ".prm-activity__sub",
  ".prm-ns-identity",
  ".prm-ns-identity__text",
  ".prm-ns-identity__line",
  ".prm-ns-glyph",
  ".prm-ns-glyph--warn",
  ".prm-ns-path",
  ".prm-ns-chevron",
  ".prm-ns-row--group .prm-ns-path",
  ".prm-ns-row--nested > td:first-child",
  ".prm-micro",
  ".prm-micro--warn",
  ".prm-types__toolbar",
  ".prm-types__category",
  ".prm-types__switch",
  ".prm-types__switch label",
  ".prm-type-name",
  ".prm-type-glyph",
  ".prm-type-link",
  ".prm-type-link:hover",
  ".prm-cat",
  ".prm-desc",
  ".prm-explainers",
  ".prm-explainer",
  ".prm-explainer[data-tone='ok']",
  ".prm-explainer[data-tone='violet']",
  ".prm-explainer__title",
  ".prm-explainer[data-tone='ok'] .prm-explainer__title > svg",
  ".prm-explainer[data-tone='violet'] .prm-explainer__title > svg",
  ".prm-explainer__title > svg",
  ".prm-explainer__body",
  ".prm-explainer__uri",
  ".prm-default",
  ".prm-default > svg",
  ".prm-lock",
  ".prm-lock > svg",
  ".prm-governance",
  ".prm-gov-card",
  ".prm-gov-card__title",
  ".prm-gov-card__title > svg",
  ".prm-gov-card__desc",
  ".prm-gov-card__note",
  ".prm-precedence",
  ".prm-precedence__step",
  ".prm-precedence__text",
  ".prm-precedence__title",
  ".prm-precedence__body",
  ".prm-step-pill",
  ".prm-step-pill[data-rank='1']",
  ".prm-promote",
  ".prm-promote > svg",
  ".prm-promote__actions",
  ".prm-tag",
  ".prm-tag--core",
  ".prm-resolver-controls",
  ".prm-resolver-controls__field",
  ".prm-resolver-go",
  ".prm-resolver-summary",
  ".prm-readonly",
  ".prm-readonly > svg",
  ".prm-readonly__value",
  ".prm-graph",
  ".prm-graph__body",
  ".prm-refline",
  ".prm-refline > svg",
  ".prm-refline[data-cross-scope='true'] > svg",
  ".prm-refline__source",
  ".prm-ref-source",
  ".prm-ref-target",
  ".prm-ref-link",
  ".prm-ref-link:hover",
  ".prm-settings",
  ".prm-settings-card",
  ".prm-settings-card__head",
  ".prm-settings-card__body",
  ".prm-stack",
  ".prm-settings-card__desc",
  ".prm-settings-card__error",
  ".prm-settings-actions",
  ".prm-switch-row",
  ".prm-switch-row:first-child",
  ".prm-switch-row__text",
  ".prm-switch-row__title",
  ".prm-switch-row__desc",
  ".prm-field",
  ".prm-field__legend",
  ".prm-grid-2",
  ".prm-grid-4",
  ".prm-bound",
  ".prm-bound > input",
  ".prm-check",
  ".prm-check label",
  ".prm-check--field",
  ".prm-checks",
  ".prm-formats",
  ".prm-formats > legend",
  ".prm-select",
  ".prm-select:disabled",
  ".prm-select--inline",
  ".prm-dialog__head",
  ".prm-dialog__heading",
  ".prm-dialog__body",
  ".prm-dialog--tall",
  ".prm-dialog__tabs",
  ".prm-dialog__body--scroll",
  ".prm-dialog__grid",
  ".prm-form-section",
  ".prm-form-section:first-child",
  ".prm-form-section__title",
  ".prm-chips",
  ".prm-chips__input",
  ".prm-chip",
  ".prm-chip__remove",
  ".prm-chip__remove:hover",
  ".prm-chip__remove > svg",
  ".prm-editor",
  ".prm-editor__bar",
  ".prm-source-cards",
  ".prm-source-card",
  ".prm-source-card:hover",
  ".prm-source-card[aria-pressed='true']",
  ".prm-source-card__head",
  ".prm-source-card__head > svg",
  ".prm-source-card[aria-pressed='true'] .prm-source-card__head > svg",
  ".prm-source-card__desc",
  ".prm-drop",
  ".prm-drop:hover, .prm-drop[data-dragging]",
  ".prm-drop:focus-within",
  ".prm-drop__label",
  ".prm-drop__glyph",
  ".prm-drop__title",
  ".prm-drop__hint",
  ".prm-file",
  ".prm-file__identity",
  ".prm-file__glyph",
  ".prm-file__text",
  ".prm-file__name",
  ".prm-detected",
  ".prm-detected__head",
  ".prm-detected__title",
  ".prm-detected__title > svg",
  ".prm-detected__counts",
  ".prm-detected__list",
  ".prm-detected__row",
  ".prm-detected__row:first-child",
  ".prm-detected__mark",
  ".prm-detected__mark--ok",
  ".prm-detected__mark--bad",
  ".prm-detected__text",
  ".prm-detected__more",
  ".prm-refs",
  ".prm-refs__head",
  ".prm-refs__title",
  ".prm-refs__list",
  ".prm-refs__row",
  ".prm-refs__target",
  ".prm-refs__unresolved",
  ".prm-refs__unresolved ul",
  ".prm-review__summary",
  ".prm-review__list",
  ".prm-review-row",
  ".prm-review-row[data-status='conflict']",
  ".prm-review-row[data-status='invalid']",
  ".prm-review-row__head",
  ".prm-review-row__name",
  ".prm-review-row__error",
  ".prm-review-row__errors",
  ".prm-review-row__resolve",
  ".prm-review-row__rename",
  ".prm-result",
  ".prm-result__row",
  ".prm-result__items"
] as const;

/**
 * Look one of this ticket's rules up.
 *
 * @param prelude The rule's selector, exactly as {@link PRIMITIVE_PRELUDES} lists it.
 * @returns The rule.
 */
function primitiveRule(prelude: string): CssRule {
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
  const value = parseDeclarations(primitiveRule(prelude).body).get(property);
  if (value === undefined) throw new Error(`\`${prelude}\` declares no \`${property}\``);
  return value;
}

/**
 * The opaque colour a token resolves to in one appearance, over a stack of grounds.
 *
 * @param name The token to paint.
 * @param appearance The theme block, or `undefined` for the light default.
 * @param stack What is painted behind it, front to back.
 * @returns The resulting opaque channels.
 */
function paint(name: string, appearance: unknown, stack: readonly string[] = []): Rgb {
  let backdrop = PAPER;
  for (const layer of [...stack].reverse()) {
    backdrop = compositeOver(resolveThemeToken(layer, tokens, appearance as never), backdrop);
  }
  return compositeOver(resolveThemeToken(name, tokens, appearance as never), backdrop);
}

/**
 * The primitives block, from its banner to the start of whatever section follows it.
 *
 * Bounded rather than run to the end of the file, for the reason `api-keys-css.test.ts`
 * records: `globals.css` grows one section per redesign ticket, and a slice that ended at EOF
 * would make every assertion below a claim about every *later* section too.
 */
const SECTION = (() => {
  const start = css.indexOf('PRIMITIVES & TYPES  (HIVE-6.5, #5316)');
  if (start < 0) throw new Error('globals.css has no primitives section');
  const bannerStart = css.lastIndexOf('/* =', start);
  const next = css.indexOf('/* =', start);
  return css.slice(bannerStart < 0 ? start : bannerStart, next < 0 ? css.length : next);
})();

/** The same block with its comments removed. */
const SECTION_CODE = SECTION.replace(/\/\*[\s\S]*?\*\//g, '');

/* -------------------------------------------------------------------------
   1. The section exists, and names no colour
   ------------------------------------------------------------------------- */

describe('the primitives section of globals.css', () => {
  it('declares every rule the components reference', () => {
    const missing = PRIMITIVE_PRELUDES.filter(
      (prelude) => !rules.some((rule) => rule.prelude === prelude)
    );
    expect(missing).toEqual([]);
  });

  it('sits after the unlayered p and h1–h4 base rules it has to outrank', () => {
    // `.prm-panel-head__title`, `.prm-gov-card__title`, `.prm-explainer__title` and
    // `.prm-form-section__title` are `h3`s and half the quiet lines are `p`s; both base rules
    // are unlayered, so a rule declared before them would lose whatever its specificity.
    for (const prelude of PRIMITIVE_PRELUDES) {
      expect(primitiveRule(prelude).line).toBeGreaterThan(BASE_TYPE_RULE_LINE);
    }
  });

  it('names no colour — every hue resolves through the token layer', () => {
    for (const prelude of PRIMITIVE_PRELUDES) {
      for (const [property, value] of parseDeclarations(primitiveRule(prelude).body)) {
        expect({ prelude, property, value }).toMatchObject({ prelude, property });
        expect(value).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        expect(value.replace(/color-mix\([^)]*\)/g, '')).not.toMatch(
          /\b(?:rgb|rgba|hsl|hsla|oklch)\(/
        );
      }
    }
  });

  it('does not reintroduce the palette classes the nine files named', () => {
    for (const banned of [
      'indigo-',
      'teal-',
      'emerald-',
      'amber-',
      'sky-',
      'purple-',
      'gray-',
      'slate-',
    ]) {
      expect(SECTION_CODE).not.toContain(banned);
    }
  });

  it('leaves the hex fence of the stylesheet intact', () => {
    expect(findUnfencedHex(css).map((entry) => `${entry.line}: ${entry.text}`)).toEqual([]);
  });

  it('never fades anything — the block declares no opacity at all', () => {
    // The screens this replaces dimmed a disabled action to `opacity-50` and a read-only cell
    // with it; fading text fades the explanation with it. Where something is unavailable here
    // it says so in words, and where it is quiet it is `--fg-muted`.
    const faded = PRIMITIVE_PRELUDES.filter((prelude) =>
      parseDeclarations(primitiveRule(prelude).body).has('opacity')
    );
    expect(faded).toEqual([]);
  });
});

/* -------------------------------------------------------------------------
   2. Nothing is frozen in pixels
   ------------------------------------------------------------------------- */

describe('density and font-scale independence', () => {
  it('states no font size or control metric in px', () => {
    // `1px` is exempt everywhere — a hairline is one device pixel by definition — and only in
    // a border, a ring or a shadow, which are gaps between two strokes rather than font
    // metrics or control heights: they must *not* grow with the font scale.
    const RULE_PROPERTIES = new Set([
      'outline',
      'outline-offset',
      'box-shadow',
      'border',
      'border-block-start',
      'border-block-end',
      'border-inline-start',
      'stroke-width',
      'text-underline-offset',
    ]);
    for (const prelude of PRIMITIVE_PRELUDES) {
      for (const [property, value] of parseDeclarations(primitiveRule(prelude).body)) {
        const allowed = RULE_PROPERTIES.has(property) ? ['1px', '2px'] : ['1px'];
        const offending = value
          .match(/(?<!\d)(\d*\.?\d+)px/g)
          ?.filter((px) => !allowed.includes(px));
        expect({ prelude, property, offending: offending ?? [] }).toMatchObject({
          prelude,
          property,
          offending: [],
        });
      }
    }
  });

  it('sizes every panel glyph from the shared icon metrics', () => {
    for (const prelude of [
      '.prm-panel-head > svg',
      '.prm-panel-head__title > svg',
      '.prm-rail__head > svg',
      '.prm-rail__title > svg',
      '.prm-ns-glyph',
      '.prm-type-glyph',
      '.prm-explainer__title > svg',
      '.prm-gov-card__title > svg',
      '.prm-source-card__head > svg',
    ]) {
      expect(declaration(prelude, 'inline-size')).toBe('var(--icon-dense)');
      expect(declaration(prelude, 'block-size')).toBe('var(--icon-dense)');
    }
    // The three glyphs that ride a control rather than a heading take the button metric.
    for (const prelude of ['.prm-caution > svg', '.prm-readonly > svg', '.prm-detected__mark']) {
      expect(declaration(prelude, 'inline-size')).toBe('var(--icon-button)');
    }
  });

  it('spends spacing tokens rather than literal gaps, so Compact is genuinely compact', () => {
    for (const [prelude, property] of [
      ['.prm-registry-grid', 'gap'],
      ['.prm-panels', 'gap'],
      ['.prm-rail', 'gap'],
      ['.prm-rail__card', 'padding'],
      ['.prm-activity__row', 'padding'],
      ['.prm-code', 'padding'],
      ['.prm-explainers', 'gap'],
      ['.prm-governance', 'gap'],
      ['.prm-precedence', 'gap'],
      ['.prm-settings', 'gap'],
      ['.prm-switch-row', 'padding-block'],
      ['.prm-grid-2', 'gap'],
      ['.prm-grid-4', 'gap'],
      ['.prm-source-cards', 'gap'],
      ['.prm-detected__row', 'padding'],
      ['.prm-review-row', 'padding'],
    ] as const) {
      expect(declaration(prelude, property)).toMatch(/var\(--(space|card-pad)/);
    }
  });

  it('takes every control height from the density metrics', () => {
    expect(declaration('.prm-select', 'block-size')).toBe('var(--control-h)');
    expect(declaration('.prm-select--inline', 'block-size')).toBe('var(--control-h-sm)');
    expect(declaration('.prm-readonly', 'block-size')).toBe('var(--control-h)');
    expect(declaration('.prm-chip', 'block-size')).toBe('var(--control-h-sm)');
    expect(declaration('.prm-ns-chevron', 'inline-size')).toBe('var(--control-h-sm)');
    expect(declaration('.prm-check--field', 'block-size')).toBe('var(--control-h)');
    expect(declaration('.prm-types__category', 'block-size')).toBe('var(--control-h-sm)');
  });

  it('takes every type size from the scale, never from a literal', () => {
    for (const prelude of PRIMITIVE_PRELUDES) {
      const size = parseDeclarations(primitiveRule(prelude).body).get('font-size');
      if (size === undefined) continue;
      expect({ prelude, size }).toMatchObject({ prelude });
      expect(size).toMatch(/^var\(--fs-/);
    }
  });

  it('sizes the group indent from the tokens that draw the row it indents under', () => {
    // One cell gutter plus one glyph plus its gap — so a member lines up under its parent's
    // name at every font scale, rather than under a 26px the mockup measured once.
    expect(declaration('.prm-ns-row--nested > td:first-child', 'padding-inline-start')).toBe(
      'calc(var(--space-3) + var(--icon-dense) + var(--space-2))'
    );
  });
});

/* -------------------------------------------------------------------------
   3. Every grid collapses
   ------------------------------------------------------------------------- */

describe('no horizontal document scroll', () => {
  it('opens every multi-column grid at one column', () => {
    for (const prelude of [
      '.prm-registry-grid',
      '.prm-explainers',
      '.prm-governance',
      '.prm-grid-2',
      '.prm-grid-4',
      '.prm-dialog__grid',
    ]) {
      expect(declaration(prelude, 'grid-template-columns')).toBe('minmax(0, 1fr)');
    }
  });

  it('caps every column at minmax(0, …) so a long path cannot hold one open', () => {
    for (const value of SECTION_CODE.match(/grid-template-columns:[^;]+;/g) ?? []) {
      if (value.includes('auto-fit')) continue;
      expect(value).toContain('minmax(0,');
    }
  });

  it('fits the source cards without a per-count media query', () => {
    expect(declaration('.prm-source-cards', 'grid-template-columns')).toBe(
      'repeat(auto-fit, minmax(13rem, 1fr))'
    );
  });

  it('lets long identifiers break rather than widen their column', () => {
    for (const prelude of [
      '.prm-ns-path',
      '.prm-explainer__uri',
      '.prm-tag',
      '.prm-file__name',
      '.prm-detected__text',
      '.prm-refs__row',
      '.prm-review-row__name',
      '.prm-result__items',
    ]) {
      expect(declaration(prelude, 'overflow-wrap')).toBe('anywhere');
    }
  });

  it('scrolls the wide wells inside themselves', () => {
    for (const prelude of ['.prm-code', '.prm-graph__body']) {
      expect(declaration(prelude, 'overflow-x')).toBe('auto');
    }
  });
});

/* -------------------------------------------------------------------------
   4. Contrast, in all nine appearances
   ------------------------------------------------------------------------- */

describe('contrast in every appearance', () => {
  it('clears AA for quiet text on a card', () => {
    for (const [id, block] of APPEARANCES) {
      const ground = paint('--bg-surface', block);
      const ink = paint('--fg-muted', block, ['--bg-surface']);
      expect({ id, clears: contrastRatio(ink, ground) >= WCAG_AA_NORMAL_TEXT_MIN }).toEqual({
        id,
        clears: true,
      });
    }
  });

  it('clears AA for quiet text in every inset well the screen draws', () => {
    // `.prm-code__comment`, `.prm-graph__body`, `.prm-readonly`, `.prm-explainer__uri`,
    // `.prm-micro` and `.prm-step-pill` all put `--fg-muted` on `--bg-inset`.
    for (const [id, block] of APPEARANCES) {
      const ground = paint('--bg-inset', block, ['--bg-surface']);
      const ink = paint('--fg-muted', block, ['--bg-inset', '--bg-surface']);
      expect({ id, clears: contrastRatio(ink, ground) >= WCAG_AA_NORMAL_TEXT_MIN }).toEqual({
        id,
        clears: true,
      });
    }
  });

  it('is why those wells are not --bg-subtle', () => {
    // The measurement deviation 7 rests on: the same ink on the *other* quiet ground fails, in
    // Solarized, by a tenth of a point. Stated as a test so the day the token moves, the
    // deviation is revisited rather than silently kept.
    const solarized = APPEARANCES.find(([id]) => id === 'solarized');
    expect(solarized).toBeDefined();
    const block = solarized![1];
    const ground = paint('--bg-subtle', block, ['--bg-surface']);
    const ink = paint('--fg-muted', block, ['--bg-subtle', '--bg-surface']);
    expect(contrastRatio(ink, ground)).toBeLessThan(WCAG_AA_NORMAL_TEXT_MIN);
  });

  it('clears AA for code and identifiers in the inset wells', () => {
    for (const [id, block] of APPEARANCES) {
      const ground = paint('--bg-inset', block, ['--bg-surface']);
      const ink = paint('--fg', block, ['--bg-inset', '--bg-surface']);
      expect({ id, clears: contrastRatio(ink, ground) >= WCAG_AA_NORMAL_TEXT_MIN }).toEqual({
        id,
        clears: true,
      });
    }
  });

  it('clears AA for the unregistered badge, the one inked word in the block', () => {
    // `.prm-micro--warn` is the only place the block puts a `-fg` ink anywhere, and it does it
    // on that tone's own `-soft` fill — the pairing the token layer actually calibrates.
    for (const [id, block] of APPEARANCES) {
      const ground = paint('--warn-soft', block, ['--bg-surface']);
      const ink = paint('--warn-fg', block, ['--warn-soft', '--bg-surface']);
      expect({ id, clears: contrastRatio(ink, ground) >= WCAG_AA_NORMAL_TEXT_MIN }).toEqual({
        id,
        clears: true,
      });
    }
  });

  it('inverts the leading step pill against the ink it fills with', () => {
    for (const [id, block] of APPEARANCES) {
      const ground = paint('--fg', block, ['--bg-surface']);
      const ink = paint('--bg-surface', block, ['--fg', '--bg-surface']);
      expect({ id, clears: contrastRatio(ink, ground) >= WCAG_AA_NORMAL_TEXT_MIN }).toEqual({
        id,
        clears: true,
      });
    }
  });

  it('records where the KPI figure’s own ink clears large-text AA, and where it does not', () => {
    // The strip's `Unresolved $ref` figure is `--warn-fg` at `--fs-4xl`/700 on the card, which
    // is large text. It clears 3:1 in the four appearances whose warn ink is calibrated
    // against a light ground, and does not in the five that inherit the light `-fg` under a
    // dark surface — which is exactly why the tile is *marked* with a `--warn` hairline as
    // well, and why its label and foot stay `--fg-muted` on the card rather than moving onto
    // the `--warn-soft` wash the mockup paints.
    const clearing = APPEARANCES.filter(([, block]) => {
      const ground = paint('--bg-surface', block);
      const ink = paint('--warn-fg', block, ['--bg-surface']);
      return contrastRatio(ink, ground) >= WCAG_AA_LARGE_TEXT_MIN;
    }).map(([id]) => id);
    expect(clearing).toEqual(['light', 'dark', 'high-contrast', 'whiteboard']);
  });

  it('keeps every tinted ground a wash rather than a soft fill', () => {
    const washes = SECTION_CODE.match(/color-mix\(in srgb, var\(--[a-z-]+\) (\d+)%/g) ?? [];
    expect(washes.length).toBeGreaterThan(0);
    for (const wash of washes) {
      const percent = Number(wash.match(/(\d+)%/)![1]);
      expect({ wash, ok: percent <= 14 }).toEqual({ wash, ok: true });
    }
  });
});
