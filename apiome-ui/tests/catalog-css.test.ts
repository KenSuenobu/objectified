/**
 * The stylesheet half of the Catalog redesign (HIVE-7.1, #5318).
 *
 * `catalog-hive-redesign.test.tsx` renders the screen and pins its markup; it cannot pin
 * anything that makes it *look* right, because jsdom compiles no stylesheet. So this suite
 * reads `globals.css` the way `projects-css.test.ts` and `primitives-css.test.ts` do, and pins
 * what the components lean on:
 *
 *   1. **The skin is tokens only.** What this replaces named colour outright in more than 260
 *      places on the list screen alone — `from-indigo-500 to-purple-500` avatars,
 *      `border-amber-200/60` cards, `bg-emerald-50 text-emerald-700` converted badges, a
 *      `bg-gray-100 text-gray-700 dark:bg-gray-700/60` source badge, and four hand-written
 *      routing palettes inside the import wizard. Every one froze the surface on one palette.
 *   2. **Nothing is frozen in pixels.** The mockup's page-local block fixes the filter field
 *      at 230px, the three selects at 116–136px, the orb gap at 14px, the chip padding at
 *      8/10px and the format tile at 28px; all are `rem` or a token here.
 *   3. **Every multi-column grid collapses**, so neither the card grid nor the four-column
 *      format gallery can scroll the document sideways at any font scale.
 *   4. **Quiet text is `--fg-muted`**, not the mockup's `--fg-subtle`, which does not clear AA
 *      at these sizes — measured here in all nine appearances.
 *   5. **A format's hue is the one thing that is *not* a token.** `.fmt--*` is the fixed
 *      identity block (HIVE-2.4): the gallery's tiles and the header's preview pills carry it
 *      deliberately, because it is the colour the table below then uses.
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

/** WCAG 1.4.11 for a non-text mark — an icon, a bar, a hairline. */
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
 * Every top-level rule this ticket added, by prelude.
 *
 * Listed rather than pattern-matched so a rule that is *renamed* fails here instead of
 * silently dropping out of the token-only walk below.
 */
const CATALOG_PRELUDES = [
  '.cat-quiet',
  '.cat-stamp',
  '.cat-menu__item--danger[data-highlighted], .cat-menu__item--danger:hover',
  '.cat-menu__item--danger[data-highlighted] > svg, .cat-menu__item--danger:hover > svg',
  '.cat-sort-mark',
  '.cat-deleted-switch',
  '.cat-deleted-switch label',
  '.cat-chip-glyph',
  '.cat-filter',
  '.cat-filter[data-active]',
  '.cat-facet__trigger[data-active]',
  '.cat-facet__count',
  '.cat-facet__menu',
  '.cat-facet__head',
  '.cat-facet__title',
  '.cat-facet__clear',
  '.cat-facet__clear:hover',
  '.cat-facet__clear > svg',
  '.cat-facet__option',
  '.cat-facet__box',
  '.cat-facet__option[data-state="checked"] .cat-facet__box',
  '.cat-facet__box > span > svg, .cat-facet__box svg',
  '.cat-facet__label',
  '.cat-facet__n',
  '.cat-cards-panel',
  '.cat-cards-panel__empty',
  '.cat-grid',
  '.cat-grid--grouped',
  '.cat-group__head',
  '.cat-group__count',
  '.cat-group__head::after',
  '.cat-card',
  '.cat-card:hover',
  '.cat-card[data-lifecycle="disabled"], .cat-card[data-lifecycle="deleted"]',
  '.cat-card--skeleton',
  '.cat-card__body',
  '.cat-card__head',
  '.cat-card__identity',
  '.cat-card__name',
  '.cat-card__link',
  '.cat-card__link::after',
  '.cat-card__link:hover',
  '.cat-card__link:focus-visible::after',
  '.cat-card__id',
  '.cat-card__summary',
  '.cat-card__formats',
  '.cat-card__meter',
  '.cat-card__scores',
  '.cat-card__versions',
  '.cat-card__promotion',
  '.cat-card__above',
  '.cat-card__actions',
  '.cat-card:hover .cat-card__actions, .cat-card:focus-within .cat-card__actions',
  '.cat-card__footer',
  '.cat-card[data-lifecycle="deleted"] .cat-card__footer',
  '.cat-card__creator',
  '.cat-card__creator-name',
  '.cat-card__stamp',
  '.cat-orb',
  '.cat-orb__label',
  '.cat-orb--action',
  '.cat-orb--action:hover',
  '.cat-orb--action:hover .cat-orb__label',
  '.cat-converted',
  '.cat-converted__link',
  '.cat-converted__link:hover',
  '.cat-converted__gone',
  '.cat-identity',
  '.cat-identity__text',
  '.cat-identity__link',
  '.cat-identity__link:hover',
  '.cat-status',
  '.cat-score',
  '.cat-score:hover',
  '.cat-score__value',
  '.cat-row--deleted',
  '.cat-restore',
  '.cat-stat__badges',
  '.cat-stat__grade',
  '.cat-stat__grade > small',
  '.cat-stat__formats',
  '.cat-note__link',
  '.cat-formats',
  '.cat-formats__head',
  '.cat-formats__head:hover',
  '.cat-formats__tile',
  '.cat-formats__tile > svg',
  '.cat-formats__heading',
  '.cat-formats__title',
  '.cat-formats__counts',
  '.cat-formats__preview',
  '.cat-formats__more',
  '.cat-formats__chevron',
  '.cat-formats__head[aria-expanded="true"] .cat-formats__chevron',
  '.cat-formats__panel',
  '.cat-formats__legend',
  '.cat-formats__grid',
  '.cat-formats__none',
  '.cat-fmt-chip',
  'a.cat-fmt-chip:hover',
  '.cat-fmt-chip--dim',
  '.cat-fmt-chip--dim .cat-fmt-chip__tile',
  '.cat-fmt-chip--unavailable',
  '.cat-fmt-chip--unavailable .cat-fmt-chip__name, .cat-fmt-chip--unavailable .fmt-trait--origin',
  '.cat-fmt-chip--unavailable .fmt-trait--origin',
  '.cat-fmt-chip__tile',
  '.cat-fmt-chip__tile > svg',
  '.cat-fmt-chip__text',
  '.cat-fmt-chip__traits',
  '.cat-fmt-chip__name',
  '.cat-fmt-chip__desc',
  '.cat-fmt-chip__note',
  '.cat-imp-source',
  '.cat-imp-source__main',
  '.cat-imp-guide',
  '.cat-imp-guide__list',
  '.cat-imp-guide__list > dt',
  '.cat-imp-guide__list > dd',
  '.cat-imp-form',
  '.cat-imp-form > *',
  '.cat-imp-form__pair',
  '.cat-imp-note',
  '.cat-imp-detect',
  '.cat-imp-file',
  '.cat-imp-file__name',
  '.cat-imp-file__name > svg',
  '.cat-imp-file__end',
  '.cat-imp-card',
  '.cat-imp-card__title',
  '.cat-imp-card__title > svg',
  '.cat-imp-skipped',
  '.cat-imp-skipped > summary',
  '.cat-imp-skipped ul',
  '.cat-imp-routing',
  '.cat-imp-routing[data-tone="accent"]',
  '.cat-imp-routing[data-tone="ok"]',
  '.cat-imp-routing[data-tone="warn"]',
  '.cat-imp-routing > svg',
  '.cat-imp-routing__title',
  '.cat-imp-routing__body, .cat-imp-routing__note',
  '.cat-imp-routing__note',
  '.cat-imp-preview',
  '.cat-imp-preview__empty',
  '.cat-imp-options',
  '.cat-imp-choice',
  '.cat-imp-choice__option',
  '.cat-imp-choice__option:hover',
  '.cat-imp-choice__option:has(input:checked)',
  '.cat-imp-choice__title',
  '.cat-imp-choice__desc',
  '.cat-imp-terminal',
  '.cat-imp-terminal p',
  '.cat-imp-skip',
  '.cnv-grade',] as const;

/**
 * Look one of this ticket's rules up.
 *
 * @param prelude The rule's selector, exactly as {@link CATALOG_PRELUDES} lists it.
 * @returns The rule.
 */
function catalogRule(prelude: string): CssRule {
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
  const value = parseDeclarations(catalogRule(prelude).body).get(property);
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
 * The catalog block, from its banner to the start of whatever section follows it.
 *
 * Bounded rather than run to the end of the file, for the reason `api-keys-css.test.ts`
 * records: `globals.css` grows one section per redesign ticket, and a slice that ended at EOF
 * would make every assertion below a claim about every *later* section too.
 */
const SECTION = (() => {
  const start = css.indexOf('CATALOG  (HIVE-7.1, #5318)');
  if (start < 0) throw new Error('globals.css has no catalog section');
  const bannerStart = css.lastIndexOf('/* =', start);
  const next = css.indexOf('/* =', start);
  return css.slice(bannerStart < 0 ? start : bannerStart, next < 0 ? css.length : next);
})();

/** The same block with its comments removed. */
const SECTION_CODE = SECTION.replace(/\/\*[\s\S]*?\*\//g, '');

/* -------------------------------------------------------------------------
   1. The section exists, and names no colour
   ------------------------------------------------------------------------- */

describe('the catalog section of globals.css', () => {
  it('declares every rule the components reference', () => {
    const missing = CATALOG_PRELUDES.filter(
      (prelude) => !rules.some((rule) => rule.prelude === prelude)
    );
    expect(missing).toEqual([]);
  });

  it('sits after the unlayered p and h1–h4 base rules it has to outrank', () => {
    // `.cat-card__name` is an `h3`, `.cat-group__head` an `h2`, and `.cat-card__summary`,
    // `.cat-imp-note` and `.cat-formats__none` are `p`s; both base rules are unlayered, so a
    // rule declared before them would lose whatever its specificity.
    for (const prelude of CATALOG_PRELUDES) {
      expect(catalogRule(prelude).line).toBeGreaterThan(BASE_TYPE_RULE_LINE);
    }
  });

  it('names no colour — every hue resolves through the token layer', () => {
    for (const prelude of CATALOG_PRELUDES) {
      for (const [property, value] of parseDeclarations(catalogRule(prelude).body)) {
        expect({ prelude, property, value }).toMatchObject({ prelude, property });
        expect(value).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        expect(value.replace(/color-mix\([^)]*\)/g, '')).not.toMatch(
          /\b(?:rgb|rgba|hsl|hsla|oklch)\(/
        );
      }
    }
  });

  it('does not reintroduce the palette classes the list named', () => {
    for (const banned of [
      'indigo-',
      'purple-',
      'emerald-',
      'amber-',
      'gray-',
      'slate-',
      'rose-1',
      'blue-1',
    ]) {
      expect(SECTION_CODE).not.toContain(banned);
    }
  });

  it('leaves the hex fence of the stylesheet intact', () => {
    expect(findUnfencedHex(css).map((entry) => `${entry.line}: ${entry.text}`)).toEqual([]);
  });

  it('fades a control that is revealed on hover, and never a word of text', () => {
    // The card this replaces put `opacity: .9` on a whole deleted card — which fades the
    // amber warning along with everything else. The frame and the tinted footer carry that
    // now. The two `opacity` rules left are the row-actions reveal `DataTable` also uses, and
    // the tile of a format chip whose adapter cannot run — a mark, not a word: the chip's
    // "Unavailable in this runtime" line stays at full contrast beside it.
    const faded = rules.filter(
      (rule) =>
        CATALOG_PRELUDES.includes(rule.prelude as (typeof CATALOG_PRELUDES)[number]) &&
        parseDeclarations(rule.body).has('opacity')
    );
    expect(faded.map((rule) => rule.prelude)).toEqual([
      '.cat-card__actions',
      '.cat-card:hover .cat-card__actions, .cat-card:focus-within .cat-card__actions',
      '.cat-fmt-chip--dim .cat-fmt-chip__tile',
    ]);
    expect(
      declaration(
        '.cat-card:hover .cat-card__actions, .cat-card:focus-within .cat-card__actions',
        'opacity'
      )
    ).toBe('1');
  });
});

/* -------------------------------------------------------------------------
   2. Nothing is frozen in pixels
   ------------------------------------------------------------------------- */

describe('density and font-scale independence', () => {
  it('states no font size or control metric in px', () => {
    // `1px` is exempt everywhere — a hairline is one device pixel by definition — and `2px`
    // only in a ring, a border, a stroke or an underline offset. All are gaps between two
    // strokes rather than font metrics or control heights: they must *not* grow with the
    // font scale.
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
    for (const prelude of CATALOG_PRELUDES) {
      for (const [property, value] of parseDeclarations(catalogRule(prelude).body)) {
        const allowed = RULE_PROPERTIES.has(property) ? ['1px', '1.5px', '2px'] : ['1px'];
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

  it('states every font size as a scale token', () => {
    for (const prelude of CATALOG_PRELUDES) {
      const size = parseDeclarations(catalogRule(prelude).body).get('font-size');
      if (size === undefined) continue;
      expect({ prelude, size }).toMatchObject({
        prelude,
        size: expect.stringMatching(/var\(--fs-/),
      });
    }
  });

  it('spends spacing tokens rather than literal gaps, so Compact is genuinely compact', () => {
    for (const [prelude, property] of [
      ['.cat-grid', 'gap'],
      ['.cat-grid', 'padding'],
      ['.cat-card__body', 'padding'],
      ['.cat-card__body', 'gap'],
      ['.cat-card__head', 'gap'],
      ['.cat-card__footer', 'padding'],
      ['.cat-orb', 'gap'],
      ['.cat-group__head', 'gap'],
      ['.cat-formats__grid', 'gap'],
      ['.cat-fmt-chip', 'padding'],
      ['.cat-imp-source', 'gap'],
      ['.cat-imp-routing', 'padding'],
      ['.cat-imp-choice__option', 'padding'],
    ] as const) {
      expect(declaration(prelude, property)).toMatch(/var\(--space-/);
    }
  });

  it('sizes every glyph from a shared metric rather than from a literal', () => {
    for (const prelude of [
      '.cat-formats__chevron',
      '.cat-fmt-chip__tile > svg',
      '.cat-formats__tile > svg',
      '.cat-imp-file__name > svg',
      '.cat-imp-card__title > svg',
      '.cat-imp-routing > svg',
    ]) {
      expect(declaration(prelude, 'inline-size')).toBe('var(--icon-dense)');
      expect(declaration(prelude, 'block-size')).toBe('var(--icon-dense)');
    }
    // One glyph rides the type instead: it sits inside a 12px chip whose size is a font-scale
    // token, and an icon metric there would drift away from the letters beside it.
    expect(declaration('.cat-chip-glyph', 'inline-size')).toBe('var(--fs-xs)');
  });

  it('clamps the card’s two-line summary in type units, not in pixels', () => {
    // Two lines of `--fs-sm` at `--lh-normal` is the same rhythm at every font scale — and it
    // is what keeps a grid of cards aligned whether or not an item has a description.
    expect(declaration('.cat-card__summary', '-webkit-line-clamp')).toBe('2');
    expect(declaration('.cat-card__summary', 'min-block-size')).toBe(
      'calc(var(--fs-sm) * var(--lh-normal) * 2)'
    );
  });

  it('states every breakpoint in rem, so each one follows the font scale', () => {
    const media = SECTION.match(/@media \([^)]*\)/g) ?? [];
    expect(media.length).toBeGreaterThanOrEqual(5);
    for (const query of media) {
      // `(hover: none)` is a capability query, not a width — it has no unit to get wrong.
      if (query.includes('hover')) continue;
      expect(query).toMatch(/rem\)/);
      expect(query).not.toMatch(/\d+px/);
    }
  });

  it('sizes the toolbar’s three quick filters in rem, not the mockup’s 116–136px', () => {
    expect(declaration('.cat-filter', 'inline-size')).toBe('9.5rem');
    expect(declaration('.cat-filter', 'block-size')).toBe('var(--control-h-sm)');
  });
});

/* -------------------------------------------------------------------------
   3. Nothing scrolls the document sideways
   ------------------------------------------------------------------------- */

describe('horizontal containment', () => {
  it('collapses the card grid and the format gallery to one column', () => {
    // `auto-fit` over a `rem` minimum: three card columns at the default scale, two and then
    // one as the type grows — which is what stops the Largest scale pushing a scrollbar onto
    // the document. Below the phone breakpoint the grid is pinned to a single track.
    expect(declaration('.cat-grid', 'grid-template-columns')).toBe(
      'repeat(auto-fit, minmax(18rem, 1fr))'
    );
    // CATP-1.1 widened the format track from 15rem so a chip's two trait pills fit beside its
    // name; `min(…, 100%)` keeps the wider minimum from overflowing a phone panel at the
    // Largest scale, where 19rem is wider than the panel it sits in.
    expect(declaration('.cat-formats__grid', 'grid-template-columns')).toBe(
      'repeat(auto-fill, minmax(min(19rem, 100%), 1fr))'
    );

    const collapsed = rules.filter(
      (rule) => rule.prelude.startsWith('@media') && rule.body.includes('.cat-grid {')
    );
    expect(collapsed.length).toBeGreaterThan(0);
    expect(collapsed[0].body).toContain('grid-template-columns: minmax(0, 1fr)');
  });

  it('opens the wizard’s two-column source step only above a rem breakpoint', () => {
    const wide = rules.find(
      (rule) =>
        rule.prelude === '@media (min-width: 64rem)' && rule.body.includes('.cat-imp-source {')
    );
    expect(wide).toBeDefined();
    expect(wide!.body).toContain('grid-template-columns: minmax(0, 1.4fr) minmax(0, 0.9fr)');
  });

  it('gives every elidable cell a floor to shrink to', () => {
    for (const prelude of [
      '.cat-card',
      '.cat-card__head',
      '.cat-card__identity',
      '.cat-card__name',
      '.cat-identity',
      '.cat-identity__text',
      '.cat-converted',
      '.cat-facet__label',
      '.cat-formats__heading',
      '.cat-fmt-chip',
      '.cat-fmt-chip__text',
      '.cat-imp-source__main',
      '.cat-imp-file__name',
    ]) {
      expect(declaration(prelude, 'min-inline-size')).toBe('0');
    }
  });

  it('wraps every strip that could otherwise widen its parent', () => {
    for (const prelude of [
      '.cat-card__meter',
      '.cat-card__scores',
      '.cat-card__footer',
      '.cat-status',
      '.cat-stat__badges',
      '.cat-formats__head',
      '.cat-formats__legend',
      '.cat-imp-file',
    ]) {
      expect(declaration(prelude, 'flex-wrap')).toBe('wrap');
    }
  });

  it('hides the collapsed header’s pill preview below the width it fits at', () => {
    expect(declaration('.cat-formats__preview', 'display')).toBe('none');
    const wide = rules.find(
      (rule) =>
        rule.prelude === '@media (min-width: 60rem)' &&
        rule.body.includes('.cat-formats__preview {')
    );
    expect(wide).toBeDefined();
    expect(wide!.body).toContain('display: flex');
  });
});

/* -------------------------------------------------------------------------
   4. Quiet text still clears AA, in all nine appearances
   ------------------------------------------------------------------------- */

describe('contrast', () => {
  /** Every quiet line in the block, with the ground it is drawn on. */
  const QUIET = [
    ['.cat-quiet', '--bg-surface'],
    ['.cat-stamp', '--bg-surface'],
    ['.cat-sort-mark', '--bg-surface'],
    ['.cat-deleted-switch', '--bg-surface'],
    ['.cat-facet__title', '--bg-surface'],
    ['.cat-facet__clear', '--bg-surface'],
    ['.cat-facet__n', '--bg-surface'],
    ['.cat-group__head', '--bg-surface'],
    ['.cat-card__id', '--bg-surface'],
    ['.cat-card__summary', '--bg-surface'],
    ['.cat-card__versions', '--bg-surface'],
    ['.cat-card__footer', '--bg-surface'],
    ['.cat-orb__label', '--bg-surface'],
    ['.cat-converted__gone', '--bg-surface'],
    ['.cat-formats__counts', '--bg-surface'],
    ['.cat-formats__none', '--bg-surface'],
    ['.cat-fmt-chip__desc', '--bg-surface'],
    ['.cat-imp-note', '--bg-surface'],
    ['.cat-imp-guide__list > dd', '--bg-surface'],
    ['.cat-imp-preview__empty', '--bg-surface'],
    ['.cat-imp-choice__desc', '--bg-surface'],
    ['.cat-imp-skip', '--bg-surface'],
    ['.cat-stat__grade > small', '--bg-surface'],
  ] as const;

  it('draws every quiet line in --fg-muted rather than --fg-subtle or --fg-faint', () => {
    for (const [prelude] of QUIET) {
      expect({ prelude, color: declaration(prelude, 'color') }).toEqual({
        prelude,
        color: 'var(--fg-muted)',
      });
    }
  });

  it.each(APPEARANCES)('clears AA for quiet text in the %s appearance', (_id, block) => {
    const ink = paint('--fg-muted', block, PAPER);
    for (const [prelude, ground] of QUIET) {
      const backdrop = paint(ground, block, PAPER);
      const ratio = contrastRatio(ink, backdrop);
      expect({ prelude, ratio: ratio >= WCAG_AA_NORMAL_TEXT_MIN }).toEqual({
        prelude,
        ratio: true,
      });
    }
  });

  it.each(APPEARANCES)(
    'clears AA for the deleted card’s amber footer in the %s appearance',
    (_id, block) => {
      // The pair those inks were chosen for: `--warn-fg` on `--warn-soft`, not `--warn` on
      // the surface — which HIVE-5.8 measured at 3.06:1 in High contrast.
      expect(declaration('.cat-card[data-lifecycle="deleted"] .cat-card__footer', 'color')).toBe(
        'var(--warn-fg)'
      );
      expect(
        declaration('.cat-card[data-lifecycle="deleted"] .cat-card__footer', 'background')
      ).toBe('var(--warn-soft)');
      const ratio = contrastRatio(
        paint('--warn-fg', block, PAPER),
        paint('--warn-soft', block, paint('--bg-surface', block, PAPER))
      );
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
    }
  );

  it.each(APPEARANCES)(
    'clears AA for an unavailable format’s reason line in the %s appearance',
    (_id, block) => {
      // The frame is what dims on a chip whose adapter cannot run — the sentence that says so
      // keeps its full contrast, because it is the sentence most worth reading.
      expect(declaration('.cat-fmt-chip__note', 'color')).toBe('var(--warn-fg)');
      // Measured: that ink on the plain surface is 3.4:1–4.4:1 in five of the nine themes, so
      // the chip takes the amber ground the pair was calibrated against.
      expect(declaration('.cat-fmt-chip--unavailable', 'background')).toBe('var(--warn-soft)');
      const ratio = contrastRatio(
        paint('--warn-fg', block, PAPER),
        paint('--warn-soft', block, paint('--bg-surface', block, PAPER))
      );
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
    }
  );

  it.each(APPEARANCES)(
    'clears AA for every routing tone the wizard can draw in the %s appearance',
    (_id, block) => {
      // The four destinations are a *state*, so each takes a calibrated `-soft`/`-fg` pair
      // rather than one of the four hand-written palettes this replaced. The body text is the
      // same ink as the title — no `opacity: .9`, which is exactly the move that puts a
      // calibrated pair under AA.
      expect(declaration('.cat-imp-routing', 'background')).toBe('var(--cat-route-soft)');
      expect(declaration('.cat-imp-routing', 'color')).toBe('var(--cat-route-fg)');
      expect(
        parseDeclarations(catalogRule('.cat-imp-routing__body, .cat-imp-routing__note').body).has(
          'opacity'
        )
      ).toBe(false);
      for (const tone of ['neutral', 'accent', 'ok', 'warn']) {
        const ratio = contrastRatio(
          paint(`--${tone}-fg`, block, PAPER),
          paint(`--${tone}-soft`, block, paint('--bg-surface', block, PAPER))
        );
        expect({ tone, ok: ratio >= WCAG_AA_NORMAL_TEXT_MIN }).toEqual({ tone, ok: true });
      }
    }
  );

  it.each(APPEARANCES)(
    'inks the destructive menu row only where it has a ground for it, in the %s appearance',
    (_id, block) => {
      // The mockup inks `.menu__item.is-danger` red at rest. No red in the token layer can do
      // that and stay readable — HIVE-6.1 measured `--danger-fg` at 1.47:1 on the surface in
      // Nord — so the row takes the designed soft/ink pair when it is highlighted and is
      // plain text otherwise. The words are what say what it does.
      const highlighted =
        '.cat-menu__item--danger[data-highlighted], .cat-menu__item--danger:hover';
      expect(declaration(highlighted, 'background')).toBe('var(--danger-soft)');
      expect(declaration(highlighted, 'color')).toBe('var(--danger-fg)');
      const ratio = contrastRatio(
        paint('--danger-fg', block, PAPER),
        paint('--danger-soft', block, paint('--bg-surface', block, PAPER))
      );
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
    }
  );

  it.each(APPEARANCES)(
    'clears the 3:1 mark floor for the Undelete glyph in the %s appearance',
    (_id, block) => {
      // An icon-only button: WCAG 1.4.11 asks 3:1 of a mark, not the 4.5:1 a word needs, and
      // the button's accessible name is what carries the meaning.
      expect(declaration('.cat-restore', 'color')).toBe('var(--ok)');
      const ratio = contrastRatio(paint('--ok', block, PAPER), paint('--bg-surface', block, PAPER));
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NON_TEXT_MIN);
    }
  );

  it.each(APPEARANCES)(
    'clears AA for the facet’s count on its inked pill in the %s appearance',
    (_id, block) => {
      // Not the solid accent pair: `--fg-on-accent` on `--accent` is calibrated for the
      // ≥14pt-bold large-text floor a button's label sits at, and this figure is 11px, where
      // it lands between 3.5:1 and 4.4:1 across the nine themes.
      expect(declaration('.cat-facet__count', 'background')).toBe('var(--fg)');
      expect(declaration('.cat-facet__count', 'color')).toBe('var(--bg-surface)');
      const ratio = contrastRatio(
        paint('--bg-surface', block, PAPER),
        paint('--fg', block, paint('--bg-surface', block, PAPER))
      );
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
    }
  );
});

/* -------------------------------------------------------------------------
   5. The stretched link, and the one place a hue is named on purpose
   ------------------------------------------------------------------------- */

describe('the card’s stretched link', () => {
  it('covers the whole card, so one link is the whole hit area', () => {
    expect(declaration('.cat-card__link::after', 'content')).toBe('""');
    expect(declaration('.cat-card__link::after', 'position')).toBe('absolute');
    expect(declaration('.cat-card__link::after', 'inset')).toBe('0');
    expect(declaration('.cat-card', 'position')).toBe('relative');
  });

  it('lifts every control above it rather than under it', () => {
    expect(declaration('.cat-card__above', 'position')).toBe('relative');
    expect(declaration('.cat-card__above', 'z-index')).toBe('1');
    expect(declaration('.cat-card__actions', 'z-index')).toBe('1');
  });

  it('draws the focus ring on the card, which is what the link activates', () => {
    expect(declaration('.cat-card__link:focus-visible::after', 'box-shadow')).toBe(
      'var(--shadow-focus)'
    );
  });

  it('keeps the row menu reachable where there is no hover to reveal it', () => {
    const touch = rules.find(
      (rule) => rule.prelude === '@media (hover: none)' && rule.body.includes('.cat-card__actions')
    );
    expect(touch).toBeDefined();
    expect(touch!.body).toContain('opacity: 1');
  });
});

describe('the one hue that is deliberately not a token', () => {
  it('leaves a format’s colour to the fixed identity block', () => {
    // `.fmt--*` (HIVE-2.4) is what the gallery's tiles and the collapsed header's preview
    // pills carry, and it is the point of showing the gallery at all: it teaches the colour
    // the table below then uses. So this section declares no fill for either — only geometry.
    expect(parseDeclarations(catalogRule('.cat-fmt-chip__tile').body).has('background')).toBe(
      false
    );
    // The `+39` pill is *not* a format, so it takes the neutral surface rather than borrowing
    // one format's identity.
    expect(declaration('.cat-formats__more', 'background')).toBe('var(--bg-inset)');
    expect(declaration('.cat-formats__more', 'color')).toBe('var(--fg-muted)');
  });

  it('leaves the grade chip’s fill to the shared band table', () => {
    // `.cnv-grade` is geometry only; `gradeBand(...).solidClass` paints it, so the letter in
    // the conversion preview is the same colour as the Lint orb on the card behind it.
    const grade = parseDeclarations(catalogRule('.cnv-grade').body);
    expect(grade.has('background')).toBe(false);
    expect(grade.has('color')).toBe(false);
  });
});

describe('the format chip’s trait pills (CATP-1.1)', () => {
  /** The one `@container` rule that re-lays the chip’s text column. */
  const narrow = () => {
    const rule = rules.find(
      (candidate) =>
        candidate.prelude.startsWith('@container cat-fmt-chip') &&
        candidate.body.includes('.cat-fmt-chip__text {')
    );
    if (!rule) throw new Error('globals.css no longer narrows the format chip’s text column');
    return rule;
  };

  it('queries the chip itself, which is the only thing that knows if the pills fit', () => {
    // A `@container` rule with no container above it never matches at all — the quiet way a
    // "responsive" rule turns out to be dead. The container is declared on the chip, and the
    // queried element is inside it.
    expect(declaration('.cat-fmt-chip', 'container')).toBe('cat-fmt-chip / inline-size');
    expect(narrow().prelude).toContain('cat-fmt-chip');
  });

  it('measures the threshold in type, not in pixels, so it follows the font scale', () => {
    // `em` in a container query resolves against the container, which the `data-font-scale`
    // percentage on `html` has already scaled — unlike a `@media` width, which never moves.
    expect(narrow().prelude).toMatch(/\(max-width: [\d.]+em\)$/);
    expect(narrow().prelude).not.toMatch(/px\)/);
  });

  it('puts the pills top-right of the name, and bottom-right when they do not fit', () => {
    const wide = parseDeclarations(catalogRule('.cat-fmt-chip__text').body);
    expect(wide.get('grid-template-areas')).toBe('"name traits" "desc desc"');
    expect(catalogRule('.cat-fmt-chip__traits').body).toContain('grid-area: traits');
    expect(declaration('.cat-fmt-chip__traits', 'align-self')).toBe('start');
    expect(declaration('.cat-fmt-chip__traits', 'justify-self')).toBe('end');
    // Narrow: the same markup, the last row instead of the first column — still hard right,
    // because `justify-self: end` is not restated and therefore not lost.
    expect(narrow().body.replace(/\s+/g, ' ')).toContain('"name" "desc" "traits"');
  });

  it.each(APPEARANCES)(
    'inks the amber chip’s name and outlined pill for that ground in the %s appearance',
    (_id, block) => {
      // `--fg` on a `-soft` fill is the pairing the token layer forbids: only the light and dark
      // palettes recalibrate a `-soft` against it, and axe measured the name at 1.08:1 on the
      // amber in five of the nine appearances before this rule existed.
      expect(
        declaration(
          '.cat-fmt-chip--unavailable .cat-fmt-chip__name, .cat-fmt-chip--unavailable .fmt-trait--origin',
          'color'
        )
      ).toBe('var(--warn-fg)');
      const ink = paint('--warn-fg', block, PAPER);
      const ground = paint('--warn-soft', block, paint('--bg-surface', block, PAPER));
      expect(contrastRatio(ink, ground)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
    }
  );

  it('leaves the identity hue to the format, and takes the neutral pair instead', () => {
    // The chip's tile already carries the format's fixed hue. Two more saturated pills beside
    // it would compete with the only colour on the chip that means anything.
    const pill = parseDeclarations(catalogRule('.fmt-trait').body);
    expect(pill.get('background')).toBe('var(--bg-inset)');
    expect(pill.get('color')).toBe('var(--fg-muted)');
    const origin = parseDeclarations(catalogRule('.fmt-trait--origin').body);
    expect(origin.get('background')).toBe('transparent');
    expect(origin.get('box-shadow')).toBe('inset 0 0 0 1px var(--border)');
  });
});
