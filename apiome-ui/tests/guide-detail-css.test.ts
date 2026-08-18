/**
 * The stylesheet half of the style-guide detail redesign (HIVE-5.7, #5310).
 *
 * `guide-detail-hive-redesign.test.tsx` renders the page and pins its markup; it cannot pin
 * anything that makes it *look* right, because jsdom compiles no stylesheet. So this suite
 * reads `globals.css` the way `style-guides-css.test.ts` and `api-keys-css.test.ts` do, and
 * pins what the components lean on:
 *
 *   1. **The skin is tokens only.** What this replaced named colour outright in more than
 *      forty places across the three tabs — `border-slate-200`, `bg-indigo-600`,
 *      `bg-amber-50`, `text-rose-600`, `focus:ring-indigo-500`. Every one froze the surface
 *      on one palette.
 *   2. **Nothing is frozen in pixels.** The mockup's page-local block fixes the rule row's
 *      34/132 px columns, the editor pane's 32 rem *minimum*, its 420 px height and the save
 *      bar's 16 px offset; all are `rem`, a token or a `minmax(0, …)` track here.
 *   3. **Every multi-column grid collapses**, so neither the two-pane editor nor the policy
 *      form can scroll the document sideways at any font scale — the failure a
 *      `minmax(32rem, …)` editor track would have guaranteed at 1280 px.
 *   4. **Quiet text is `--fg-muted`**, not `--fg-subtle` or `--fg-faint`, neither of which
 *      clears AA at these sizes.
 *   5. **Nothing fades.** A switched-off rule is not drawn with `opacity`, which is how the
 *      mockup quiets one and how a row becomes unreadable in a low-contrast theme.
 */

import {
  compositeOver,
  contrastRatio,
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
const GUIDE_DETAIL_PRELUDES = [
  '.gd-panel',
  '.gd-catalog',
  '.gd-category-select',
  '.gd-chip-glyph',
  '.gd-rule-group__head',
  '.gd-rule-group + .gd-rule-group .gd-rule-group__head',
  '.gd-rule-group__name',
  '.gd-rule-group__count',
  '.gd-rule-row',
  '.gd-rule-row + .gd-rule-row',
  '.gd-rule-row:hover',
  '.gd-rule-row__text',
  '.gd-rule-row__line',
  '.gd-rule-id',
  '.gd-rule-row[data-off] .gd-rule-id',
  '.gd-rule-row__why',
  '.gd-severity-select',
  '.gd-save-bar',
  '.gd-save-bar__glyph',
  '.gd-save-bar__label',
  '.gd-editor-layout',
  '.gd-editor-card, .gd-preview-card',
  '.gd-editor-head',
  '.gd-editor-head__text',
  '.gd-editor-head__actions',
  '.gd-card-title',
  '.gd-card-title__glyph',
  '.gd-editor-banner',
  '.gd-editor',
  '.gd-editor-status',
  '.gd-editor-status__spacer',
  '.gd-preview-body',
  '.gd-preview-picker',
  '.gd-preview-run',
  '.gd-preview-hint',
  '.gd-findings',
  '.gd-findings__head',
  '.gd-findings__title',
  '.gd-findings__counts',
  '.gd-findings__list',
  '.gd-finding',
  '.gd-finding__button',
  '.gd-finding__button:hover',
  '.gd-finding__glyph',
  '.gd-finding__button[data-severity="error"] .gd-finding__glyph',
  '.gd-finding__button[data-severity="warning"] .gd-finding__glyph',
  '.gd-finding__button[data-severity="info"] .gd-finding__glyph',
  '.gd-finding__text',
  '.gd-finding__line',
  '.gd-finding__rule',
  '.gd-finding__path',
  '.gd-finding__message',
  '.gd-aborted',
  '.gd-policy',
  '.gd-card-header',
  '.gd-card-header__lead',
  '.gd-card-header__text',
  '.gd-policy-body',
  '.gd-policy-grid',
  '.gd-legend',
  '.gd-coverage',
  '.gd-coverage__item',
  '.gd-coverage__label',
  '.gd-policy-select',
  '.gd-switch-list',
  '.gd-switch-row',
  '.gd-switch-row + .gd-switch-row',
  '.gd-switch-row__text',
  '.gd-switch-row__title',
  '.gd-switch-row__desc',
  '.gd-version-list',
  '.gd-version-row',
  '.gd-version-row + .gd-version-row',
  '.gd-fingerprint',
  '.gd-version-row__when',
  '.gd-version-row__actor',
  '.gd-skeleton',
  '.gd-skeleton__row',
  '.gd-skeleton__editor',
  '.gd-skeleton__block',
] as const;

/**
 * Look one of this ticket's rules up.
 *
 * @param prelude The rule's selector, exactly as {@link GUIDE_DETAIL_PRELUDES} lists it.
 * @returns The rule.
 */
function detailRule(prelude: string): CssRule {
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
  const value = parseDeclarations(detailRule(prelude).body).get(property);
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
 * The guide-detail block, from its banner to the start of whatever section follows it.
 *
 * Bounded rather than run to the end of the file, for the reason `api-keys-css.test.ts`
 * records: `globals.css` grows one section per redesign ticket, and a slice that ended at
 * EOF would make every assertion below a claim about every *later* section too.
 */
const SECTION = (() => {
  const start = css.indexOf('STYLE GUIDE DETAIL  (HIVE-5.7, #5310)');
  if (start < 0) throw new Error('globals.css has no style-guide-detail section');
  const bannerStart = css.lastIndexOf('/* =', start);
  const next = css.indexOf('/* =', start);
  return css.slice(bannerStart < 0 ? start : bannerStart, next < 0 ? css.length : next);
})();

/** The same block with its comments removed. */
const SECTION_CODE = SECTION.replace(/\/\*[\s\S]*?\*\//g, '');

// -------------------------------------------------------------------------
// 1. The section exists, and names no colour
// -------------------------------------------------------------------------

describe('the style-guide-detail section of globals.css', () => {
  it('declares every rule the components reference', () => {
    const missing = GUIDE_DETAIL_PRELUDES.filter(
      (prelude) => !rules.some((rule) => rule.prelude === prelude)
    );
    expect(missing).toEqual([]);
  });

  it('sits after the unlayered p and h1–h4 base rules it has to outrank', () => {
    // `.gd-card-title` is an `h3` and `.gd-rule-row__why` is a `p`; both base rules are
    // unlayered, so a rule declared before them would lose whatever its specificity.
    for (const prelude of GUIDE_DETAIL_PRELUDES) {
      expect(detailRule(prelude).line).toBeGreaterThan(BASE_TYPE_RULE_LINE);
    }
  });

  it('names no colour — every hue resolves through the token layer', () => {
    for (const prelude of GUIDE_DETAIL_PRELUDES) {
      for (const [property, value] of parseDeclarations(detailRule(prelude).body)) {
        expect({ prelude, property, value }).toMatchObject({ prelude, property });
        expect(value).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        expect(value.replace(/color-mix\([^)]*\)/g, '')).not.toMatch(
          /\b(?:rgb|rgba|hsl|hsla|oklch)\(/
        );
      }
    }
  });

  it('does not reintroduce the palette classes the three tabs named', () => {
    for (const banned of ['slate-', 'indigo-', 'emerald-', 'rose-1', 'amber-', 'gray-', 'sky-']) {
      expect(SECTION_CODE).not.toContain(banned);
    }
  });

  it('states no font size or control height in px', () => {
    // §3.2: type and control metrics are tokens, so they follow the six font scales. The
    // only physical measurements the design language exempts are hairlines and Monaco's own
    // `fontSize`, and neither is spelled here.
    for (const prelude of GUIDE_DETAIL_PRELUDES) {
      for (const [property, value] of parseDeclarations(detailRule(prelude).body)) {
        if (!/^(font-size|block-size|min-block-size|inline-size|min-inline-size|max-inline-size)$/.test(property)) {
          continue;
        }
        expect({ prelude, property, value }).toMatchObject({ prelude, property });
        expect(value).not.toMatch(/\d+px/);
      }
    }
  });
});

// -------------------------------------------------------------------------
// 2. Nothing is frozen in pixels, and every grid collapses
// -------------------------------------------------------------------------

describe('the layout', () => {
  it('gives the two editor panes zero-minimum tracks, not the mockup’s 32rem floor', () => {
    // `minmax(32rem, 1.2fr)` is what the mockup writes, and it is what makes a two-pane
    // editor scroll the document sideways at 1280 px with the rail expanded.
    const columns = declaration('.gd-editor-layout', 'grid-template-columns');
    expect(columns).toBe('minmax(0, 1.2fr) minmax(0, 1fr)');
  });

  it('collapses every multi-column grid at a rem breakpoint', () => {
    // The mockup states its one breakpoint in px. A `rem` query resolves against the
    // reader's own browser font size — the *initial* root size, not the `data-font-scale`
    // percentage set on `html` — so it follows a preference a `px` query cannot see.
    for (const [selector, query] of [
      ['.gd-editor-layout', '@media (max-width: 68rem)'],
      ['.gd-preview-picker', '@media (max-width: 30rem)'],
      ['.gd-policy-grid', '@media (max-width: 46rem)'],
      ['.gd-rule-row', '@media (max-width: 44rem)'],
    ] as const) {
      const start = SECTION_CODE.indexOf(query);
      expect({ selector, declared: start >= 0 }).toEqual({ selector, declared: true });
      // The query's body runs to its own closing brace; the nested rule inside it is what
      // has to name the grid.
      const body = SECTION_CODE.slice(start, SECTION_CODE.indexOf('\n}', start));
      expect(body).toContain(selector);
      expect(body).toContain('minmax(0, 1fr)');
    }

    // Every `@media` this block adds is stated in `rem`, without exception.
    for (const media of SECTION_CODE.match(/@media[^{]+/g) ?? []) {
      expect(media).toMatch(/rem\)/);
    }
  });

  it('keeps the middle track of a rule row collapsible, so a rationale elides', () => {
    expect(declaration('.gd-rule-row', 'grid-template-columns')).toContain('minmax(0, 1fr)');
    expect(declaration('.gd-rule-row__text', 'min-width')).toBe('0');
    expect(declaration('.gd-rule-row__why', 'text-overflow')).toBe('ellipsis');
  });

  it('sizes the editor and its skeleton in rem, not at the mockup’s 420px', () => {
    expect(declaration('.gd-editor', 'min-block-size')).toMatch(/rem$/);
    expect(declaration('.gd-skeleton__editor', 'block-size')).toMatch(/rem$/);
  });

  it('sticks the save bar to its own panel rather than to the viewport', () => {
    // `sticky`, not `fixed`: the bar belongs to the tab it is in and has to disappear with
    // it. A fixed element would need to know which tab is showing.
    expect(declaration('.gd-save-bar', 'position')).toBe('sticky');
    expect(declaration('.gd-save-bar', 'inset-block-end')).toBe('var(--space-4)');
    expect(declaration('.gd-save-bar', 'max-inline-size')).toBe('100%');
  });
});

// -------------------------------------------------------------------------
// 3. Contrast, in all nine themes
// -------------------------------------------------------------------------

describe('the quiet text', () => {
  it('is --fg-muted everywhere it appears', () => {
    for (const prelude of [
      '.gd-rule-row__why',
      '.gd-editor-status',
      '.gd-preview-hint',
      '.gd-findings__title',
      '.gd-finding__path',
      '.gd-switch-row__desc',
      '.gd-fingerprint',
      '.gd-version-row__when',
      '.gd-version-row__actor',
    ]) {
      expect(declaration(prelude, 'color')).toBe('var(--fg-muted)');
    }
  });

  it.each(APPEARANCES)('clears AA on the card surface under %s', (_id, block) => {
    const surface = paint('--bg-surface', block, PAPER);
    expect(contrastRatio(paint('--fg-muted', block, surface), surface)).toBeGreaterThanOrEqual(
      WCAG_AA_NORMAL_TEXT_MIN
    );
  });

  it('keeps the category strip out of the pair that fails AA', () => {
    // The group heading sits on `--bg-subtle`, not on the card, and `--fg-muted` on
    // `--bg-subtle` measures 4.35:1 in Solarized — the pair HIVE-5.4 measured and 5.6
    // avoided. Both marks on the strip therefore take full-strength ink.
    expect(declaration('.gd-rule-group__head', 'background')).toBe('var(--bg-subtle)');
    expect(declaration('.gd-rule-group__name', 'color')).toBe('var(--fg)');
    expect(declaration('.gd-rule-group__count', 'color')).toBe('var(--fg)');
  });

  it.each(APPEARANCES)('clears AA on the category strip under %s', (_id, block) => {
    const surface = paint('--bg-subtle', block, paint('--bg-surface', block, PAPER));
    expect(contrastRatio(paint('--fg', block, surface), surface)).toBeGreaterThanOrEqual(
      WCAG_AA_NORMAL_TEXT_MIN
    );
  });

  it.each(APPEARANCES)('clears AA in the save bar under %s', (_id, block) => {
    const bar = paint('--warn-soft', block, paint('--bg-canvas', block, PAPER));
    expect(contrastRatio(paint('--warn-fg', block, bar), bar)).toBeGreaterThanOrEqual(
      WCAG_AA_NORMAL_TEXT_MIN
    );
  });
});

describe('the code well', () => {
  it.each(APPEARANCES)('clears AA for ordinary code ink under %s', (_id, block) => {
    // `--bg-inset` is what `.gd-editor` paints and what the Monaco theme takes for
    // `editor.background`; `--fg` is its `editor.foreground`.
    const well = paint('--bg-inset', block, paint('--bg-surface', block, PAPER));
    expect(contrastRatio(paint('--fg', block, well), well)).toBeGreaterThanOrEqual(
      WCAG_AA_NORMAL_TEXT_MIN
    );
  });
});

// -------------------------------------------------------------------------
// 4. Nothing fades
// -------------------------------------------------------------------------

describe('a switched-off rule', () => {
  it('is not drawn with opacity', () => {
    // The mockup quiets one with `opacity: .55` on its id and rationale, which is the one
    // way of marking a row that no contrast check can clear. The switch beside it, and
    // `--fg-muted` on the rationale, say the same thing legibly.
    expect(SECTION_CODE).not.toMatch(/opacity\s*:/);
  });

  it('is marked by the secondary ink, which is a designed pair', () => {
    // `--fg-muted` on the card surface is measured above in all nine themes; `opacity: .55`
    // — what the mockup uses — would clear AA in none of them.
    expect(declaration('.gd-rule-row[data-off] .gd-rule-id', 'color')).toBe('var(--fg-muted)');
  });
});
