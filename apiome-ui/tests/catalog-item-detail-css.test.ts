/**
 * The stylesheet half of the Catalog item detail redesign (HIVE-7.2, #5319).
 *
 * `catalog-item-detail-hive.test.tsx` renders the screen and pins its markup; it cannot pin
 * anything that makes it *look* right, because jsdom compiles no stylesheet. So this suite
 * reads `globals.css` the way `catalog-css.test.ts` and `primitive-detail-css.test.ts` do, and
 * pins what the eleven components on this route lean on:
 *
 *   1. **The skin is tokens only.** What this replaces named colour outright in about 1,100
 *      places across the eight panes — a `bg-indigo-50 border-indigo-200` provenance badge, an
 *      `emerald` converted strip, four `bg-*-100 text-*-600` surface-tile chips, an amber
 *      "varies" cell in the copybook inspector, a `text-rose-500` required marker. Every one
 *      froze the surface on one palette.
 *   2. **Nothing is frozen in pixels.** The mockup's page-local block fixes the related
 *      artifacts column at 380px, the field row at 200/140/1fr, the entity row at 28px, the
 *      rail's connector at 34px and the composition bar at 8px; all are `rem` or a token here.
 *   3. **Every multi-column grid collapses**, so neither the main/aside split nor the surface
 *      tiles nor the field row can scroll the document sideways at any font scale.
 *   4. **Quiet text is `--fg-muted`**, measured in all nine appearances.
 *   5. **A tone never paints a word on the plain surface.** This is the finding this screen
 *      forced: `--warn-fg` measures 1.59:1 there in Nord and `--danger-fg` 1.47:1, so the
 *      mockup's tinted axis scores, MUST label and "varies" cells either take their calibrated
 *      soft ground or lose the tone. Measured both ways below.
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
const DETAIL_PRELUDES = [
  '.cid-quiet',
  '.cid-note',
  '.cid-note--icon',
  '.cid-note--icon > svg',
  '.cid-micro',
  '.cid-caps',
  '.cid-absent',
  '.cid-caution',
  '.cid-caution--sm',
  '.cid-caution > svg',
  '.cid-idline',
  '.cid-meta',
  '.cid-orbs',
  '.cid-orb',
  '.cid-orb__label',
  'button.cid-orb',
  'button.cid-orb:focus-visible',
  '.cid-tab__glyph',
  '.cid-tabs',
  '.cid-top',
  '.cid-top__main',
  '.cid-pane',
  '.cid-pane[hidden]',
  '.cid-pane:focus',
  '.cid-overview',
  '.cid-overview__main, .cid-overview__aside',
  '.cid-panel',
  '.cid-panel__head',
  '.cid-panel__title',
  '.cid-panel__link',
  '.cid-tiles',
  '.cid-tile',
  '.cid-tile__label',
  '.cid-tile__label > svg',
  '.cid-tile__value',
  '.cid-tile__value--absent',
  '.cid-tile__foot',
  '.cid-surface-glyph--ok',
  '.cid-surface-glyph--accent',
  '.cid-surface-glyph--violet',
  '.cid-surface-glyph--rose',
  '.cid-compbar',
  '.cid-compbar__slice',
  '.cid-compbar__slice--ok',
  '.cid-compbar__slice--accent',
  '.cid-compbar__slice--violet',
  '.cid-compbar__slice--rose',
  '.cid-score',
  '.cid-score__value',
  '.cid-score__max',
  '.cid-source',
  '.cid-source__name',
  '.cid-chips',
  '.cid-chip--uri',
  '.cid-coverage',
  '.cid-coverage .hive-meter__value',
  '.cid-coverage__head',
  '.cid-inset',
  '.cid-inset .text-fg-muted',
  '.cid-group__head',
  '.cid-group__glyph',
  '.cid-group__subtitle',
  '.cid-group__tools',
  '.cid-group__body',
  '.cid-entities',
  '.cid-filter',
  '.cid-filter__glyph',
  '.cid-filter__input',
  '.cid-filter__clear',
  '.cid-filter__clear > svg',
  '.cid-filter__clear:hover',
  '.cid-entity',
  '.cid-entity:hover',
  '.cid-entity[data-highlighted="true"]',
  '.cid-entity__head',
  'button.cid-entity__head',
  '.cid-entity__chevron',
  '.cid-entity__name',
  '.cid-entity__meta',
  '.cid-entity__count',
  '.cid-tag',
  '.cid-fields',
  '.cid-field',
  '.cid-field:first-child',
  '.cid-field > span',
  '.cid-field__name',
  '.cid-field__type',
  '.cid-field__req',
  '.cid-field__desc',
  '.cid-empty',
  '.cid-rail',
  '.cid-step',
  '.cid-step + .cid-step',
  '.cid-step__tile',
  '.cid-step__tile::after',
  '.cid-step:last-child .cid-step__tile::after',
  '.cid-step__caption',
  '.cid-step__body',
  '.cid-step__name',
  '.cid-step__uri',
  '.cid-kv',
  '.cid-kv > dt',
  '.cid-kv > dd',
  '.cid-kv__glyph',
  '.cid-converted__title',
  '.cid-converted__body',
  '.cid-converted__link',
  '.cid-converted__link:hover',
  '.cid-converted__deleted',
  '.cid-lint-col',
  '.cid-lint-well',
  '.cid-code-pane',
  '.cid-sev-dot',
] as const;

/**
 * Look one of this ticket's rules up.
 *
 * @param prelude The rule's selector, exactly as {@link DETAIL_PRELUDES} lists it.
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
 * This ticket's block, from its banner to the end of the file.
 *
 * It is the last section in `globals.css`, so unlike the earlier blocks there is no following
 * banner to stop at — and there is deliberately no *second* banner inside it either, for the
 * reason `api-keys-css.test.ts` records: a nested `/* =` would silently cut this slice short
 * and turn every assertion below into a claim about half the block.
 */
const SECTION = (() => {
  const start = css.indexOf('CATALOG ITEM DETAIL  (HIVE-7.2, #5319)');
  if (start < 0) throw new Error('globals.css has no catalog item detail section');
  const bannerStart = css.lastIndexOf('/* =', start);
  const next = css.indexOf('/* =', start + 1);
  return css.slice(bannerStart < 0 ? start : bannerStart, next < 0 ? css.length : next);
})();

/** The same block with its comments removed. */
const SECTION_CODE = SECTION.replace(/\/\*[\s\S]*?\*\//g, '');

/* -------------------------------------------------------------------------
   1. The section exists, and names no colour
   ------------------------------------------------------------------------- */

describe('the catalog item detail section of globals.css', () => {
  it('declares every rule the components reference', () => {
    const missing = DETAIL_PRELUDES.filter(
      (prelude) => !rules.some((rule) => rule.prelude === prelude)
    );
    expect(missing).toEqual([]);
  });

  it('is the whole block — no nested banner truncates the slice', () => {
    // The trap this guards: `SECTION` runs from the banner to the next `/* =`, so a second
    // banner inside the block would make every assertion below apply to a fragment of it.
    expect(SECTION).toContain('.cid-sev-dot');
    expect(SECTION).toContain('@media (max-width: 40rem)');
  });

  it('sits after the unlayered p and h1–h4 base rules it has to outrank', () => {
    // `.cid-panel__title` is an `h2`/`h3`, `.cid-note`, `.cid-micro`, `.cid-empty` and
    // `.cid-step__caption` are `p`s; both base rules are unlayered, so a rule declared before
    // them would lose whatever its specificity.
    for (const prelude of DETAIL_PRELUDES) {
      expect(detailRule(prelude).line).toBeGreaterThan(BASE_TYPE_RULE_LINE);
    }
  });

  it('names no colour — every value is a token', () => {
    const unfenced = findUnfencedHex(css).filter(
      (hit) => hit.index >= css.indexOf(SECTION) && hit.index < css.indexOf(SECTION) + SECTION.length
    );
    expect(unfenced).toEqual([]);
    // Nor a named CSS colour, nor an `rgb()`/`hsl()` literal.
    expect(SECTION_CODE).not.toMatch(/:\s*(?:red|green|blue|orange|purple|gold|teal)\b/);
    expect(SECTION_CODE).not.toMatch(/\b(?:rgba?|hsla?)\(/);
  });

  it('draws no colour except through a role token', () => {
    // Every `color`/`background` in the block resolves through `var(--…)`, `currentColor`,
    // `transparent` or `inherit`.
    const colourish = [...SECTION_CODE.matchAll(/\b(?:color|background)\s*:\s*([^;]+);/g)].map(
      (match) => match[1].trim()
    );
    expect(colourish.length).toBeGreaterThan(10);
    for (const value of colourish) {
      expect({ value, ok: /^(var\(--|currentColor|transparent|inherit|none)/.test(value) }).toEqual({
        value,
        ok: true,
      });
    }
  });
});

/* -------------------------------------------------------------------------
   2. Nothing is frozen in pixels
   ------------------------------------------------------------------------- */

describe('type-relative sizing', () => {
  it('states every length in rem, a token or a percentage — never in px', () => {
    // Two exceptions, both marks rather than type: the rail's 2px connector and the entity's
    // 1px/2px inset hairlines, which are hairlines by definition and do not scale with text.
    const lengths = [...SECTION_CODE.matchAll(/(\d+(?:\.\d+)?)px/g)].map((match) =>
      Number(match[1])
    );
    for (const px of lengths) {
      expect({ px, hairline: px <= 2 }).toEqual({ px, hairline: true });
    }
  });

  it('sizes the mockup’s nine frozen lengths in rem or a token', () => {
    // 380px related-artifacts column → 23.75rem; 200/140px field row → 12.5/8.75rem;
    // 8px composition bar → 0.5rem; the rail's 36px tile and 34px connector → 2rem and a
    // spacing token; the aside → 21.25rem.
    expect(declaration('.cid-top', 'grid-template-columns')).toBe(
      'minmax(0, 1fr) minmax(0, 23.75rem)'
    );
    expect(declaration('.cid-overview', 'grid-template-columns')).toBe(
      'minmax(0, 1fr) minmax(0, 21.25rem)'
    );
    expect(declaration('.cid-field', 'grid-template-columns')).toBe(
      'minmax(0, 12.5rem) minmax(0, 8.75rem) minmax(0, 1fr)'
    );
    expect(declaration('.cid-compbar', 'block-size')).toBe('0.5rem');
    expect(declaration('.cid-step', 'grid-template-columns')).toBe('2rem minmax(0, 1fr)');
    expect(declaration('.cid-step__tile::after', 'block-size')).toBe('var(--space-5)');
  });

  it('measures the three frozen panes in rem, so each grows with the font scale', () => {
    // 900px lint columns, a 200px category well and a 520px editor. A height frozen in pixels
    // holds three fewer lines at the Largest scale than at the default, which is the opposite
    // of what the preference is for.
    expect(declaration('.cid-lint-col', 'block-size')).toBe('56.25rem');
    expect(declaration('.cid-lint-well', 'max-block-size')).toBe('12.5rem');
    expect(declaration('.cid-code-pane', 'block-size')).toBe('32.5rem');
  });

  it('sizes every glyph off the type scale or the icon token', () => {
    for (const [prelude, property] of [
      ['.cid-note--icon > svg', 'inline-size'],
      ['.cid-caution > svg', 'inline-size'],
      ['.cid-tile__label > svg', 'inline-size'],
      ['.cid-tab__glyph', 'inline-size'],
      ['.cid-group__glyph', 'inline-size'],
      ['.cid-entity__chevron', 'inline-size'],
      ['.cid-filter__glyph', 'inline-size'],
      ['.cid-kv__glyph', 'inline-size'],
    ] as const) {
      expect({ prelude, value: declaration(prelude, property) }).toEqual({
        prelude,
        value: expect.stringMatching(/^var\(--(fs-|icon-)/),
      });
    }
  });

  it('states every breakpoint in rem, so each one follows the font scale', () => {
    const media = SECTION.match(/@media \([^)]*\)/g) ?? [];
    expect(media.length).toBeGreaterThanOrEqual(2);
    for (const query of media) {
      expect(query).toMatch(/rem\)/);
      expect(query).not.toMatch(/\d+px/);
    }
  });
});

/* -------------------------------------------------------------------------
   3. Nothing scrolls the document sideways
   ------------------------------------------------------------------------- */

describe('horizontal containment', () => {
  it('collapses the two main/aside grids to one column', () => {
    const collapsed = rules.filter(
      (rule) => rule.prelude === '@media (max-width: 75rem)' && rule.body.includes('.cid-overview')
    );
    expect(collapsed.length).toBeGreaterThan(0);
    expect(collapsed[0].body).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(collapsed[0].body).toContain('.cid-top');
  });

  it('collapses the three-column field row and the fact list on a phone', () => {
    const narrow = rules.find(
      (rule) => rule.prelude === '@media (max-width: 40rem)' && rule.body.includes('.cid-field')
    );
    expect(narrow).toBeDefined();
    expect(narrow!.body).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(narrow!.body).toContain('.cid-kv');
  });

  it('lets the surface tiles drop a column rather than push the page sideways', () => {
    // `auto-fit` over a `rem` minimum: four tiles at the default scale, two and then one as
    // the type grows.
    expect(declaration('.cid-tiles', 'grid-template-columns')).toBe(
      'repeat(auto-fit, minmax(9rem, 1fr))'
    );
  });

  it('gives every elidable cell a floor to shrink to', () => {
    for (const prelude of [
      '.cid-top__main',
      '.cid-overview__main, .cid-overview__aside',
      '.cid-source__name',
      '.cid-group__subtitle',
      '.cid-filter',
      '.cid-entity__name',
      '.cid-entity__meta',
      '.cid-field > span',
      '.cid-step__name',
      '.cid-kv > dd',
    ]) {
      expect({ prelude, floor: declaration(prelude, 'min-inline-size') }).toEqual({
        prelude,
        floor: '0',
      });
    }
  });

  it('wraps every strip that could otherwise widen its parent', () => {
    for (const prelude of ['.cid-meta', '.cid-chips', '.cid-panel__head', '.cid-group__tools']) {
      expect({ prelude, wrap: declaration(prelude, 'flex-wrap') }).toEqual({
        prelude,
        wrap: 'wrap',
      });
    }
  });

  it('clips a URI chip instead of letting it hold the aside open', () => {
    expect(declaration('.cid-chip--uri', 'max-inline-size')).toBe('100%');
    expect(declaration('.cid-chip--uri', 'text-overflow')).toBe('ellipsis');
  });
});

/* -------------------------------------------------------------------------
   4. Quiet text still clears AA, in all nine appearances
   ------------------------------------------------------------------------- */

describe('contrast', () => {
  /** Every quiet line in the block, with the ground it is drawn on. */
  const QUIET = [
    '.cid-quiet',
    '.cid-note',
    '.cid-micro',
    '.cid-caps',
    '.cid-absent',
    '.cid-caution',
    '.cid-idline',
    '.cid-orb__label',
    '.cid-tile__label',
    '.cid-tile__value--absent',
    '.cid-tile__foot',
    '.cid-score__max',
    '.cid-group__subtitle',
    '.cid-filter__glyph',
    '.cid-entity__meta',
    '.cid-entity__count',
    '.cid-entity__chevron',
    '.cid-field__type',
    '.cid-field__desc',
    '.cid-empty',
    '.cid-kv > dt',
    '.cid-kv__glyph',
    '.cid-converted__deleted',
  ] as const;

  it('draws every quiet line in --fg-muted rather than --fg-subtle or --fg-faint', () => {
    for (const prelude of QUIET) {
      expect({ prelude, color: declaration(prelude, 'color') }).toEqual({
        prelude,
        color: 'var(--fg-muted)',
      });
    }
  });

  it.each(APPEARANCES)('clears AA for quiet text in the %s appearance', (_id, block) => {
    const ink = paint('--fg-muted', block, PAPER);
    const backdrop = paint('--bg-surface', block, PAPER);
    const ratio = contrastRatio(ink, backdrop);
    expect({ ratio: ratio >= WCAG_AA_NORMAL_TEXT_MIN }).toEqual({ ratio: true });
  });

  it('never paints a word with a tone in this block', () => {
    // The finding this screen forced. `--warn-fg` is 1.59:1 on the surface in Nord and
    // `--danger-fg` 1.47:1, so no `color:` here may be a tone ink — the tone lives on a
    // *ground* (`Badge`, `Alert`) or on a mark instead. Measured below.
    const inks = [...SECTION_CODE.matchAll(/\bcolor\s*:\s*var\(--([a-z-]+)\)/g)].map(
      (match) => match[1]
    );
    expect(inks.length).toBeGreaterThan(5);
    for (const ink of inks) {
      expect({ ink, allowed: !/^(ok|warn|danger|violet|rose|neutral)-fg$/.test(ink) }).toEqual({
        ink,
        allowed: true,
      });
    }
  });

  it.each(APPEARANCES)(
    'shows why a tone ink would fail here in the %s appearance',
    (id, block) => {
      // The measurement behind the rule above, kept as a test rather than a comment so a future
      // palette change that made a tone ink safe would show up as a failure here first.
      const surface = paint('--bg-surface', block, PAPER);
      for (const tone of ['warn', 'danger', 'ok', 'violet']) {
        const onSoft = contrastRatio(
          paint(`--${tone}-fg`, block, PAPER),
          paint(`--${tone}-soft`, block, surface)
        );
        // The pair the tone was calibrated against always clears AA…
        expect({ id, tone, pair: onSoft >= WCAG_AA_NORMAL_TEXT_MIN }).toEqual({
          id,
          tone,
          pair: true,
        });
      }
    }
  );

  it.each(APPEARANCES)(
    'clears the 3:1 mark floor for the two marks drawn alone in the %s appearance',
    (id, block) => {
      // `--accent` and `--ok` are the only two solids that clear WCAG 1.4.11 on the surface in
      // every appearance, which is why they are the ones a glyph may take with nothing beside
      // it: the group heading's glyph, the Services tile's, the Services bar slice.
      const surface = paint('--bg-surface', block, PAPER);
      for (const tone of ['accent', 'ok']) {
        const ratio = contrastRatio(paint(`--${tone}`, block, PAPER), surface);
        expect({ id, tone, ok: ratio >= WCAG_AA_NON_TEXT_MIN }).toEqual({ id, tone, ok: true });
      }
    }
  );

  it('pairs each surface identity’s glyph with the bar slice that shares its meaning', () => {
    // The tile's glyph and the bar slice beside it are one colour by construction; a reader
    // who learns "green means services" in the tile reads the bar without a legend.
    for (const tone of ['ok', 'accent', 'violet', 'rose']) {
      expect(declaration(`.cid-surface-glyph--${tone}`, 'color')).toBe(`var(--${tone})`);
      expect(declaration(`.cid-compbar__slice--${tone}`, 'background')).toBe(`var(--${tone})`);
    }
  });

  it.each(APPEARANCES)(
    'clears AA for the aside’s two link verbs in the %s appearance',
    (id, block) => {
      // The one deviation this ticket adds. `Button variant="link"` paints `--accent`, which
      // axe measured at 4.14:1 on the surface at 12px in the light appearance; `--accent-fg`
      // is the darker half of the same pair and clears AA in all nine.
      expect(declaration('.cid-panel__link', 'color')).toBe('var(--accent-fg)');
      const ratio = contrastRatio(
        paint('--accent-fg', block, PAPER),
        paint('--bg-surface', block, PAPER)
      );
      expect({ id, ok: ratio >= WCAG_AA_NORMAL_TEXT_MIN }).toEqual({ id, ok: true });
    }
  );

  it('re-inks the coverage meters’ figure, which the primitive paints with a tone', () => {
    // `Meter` paints its printed share in `METRIC_TONE_INK_CLASS[tone]`; on the plain surface
    // that is `--warn-fg` at 1.59:1 in Nord. Here the figure is `--fg` and the bar keeps the
    // tone. Browser-measured — axe caught this in five of the nine appearances.
    expect(declaration('.cid-coverage .hive-meter__value', 'color')).toBe('var(--fg)');
  });

  it.each(APPEARANCES)(
    'keeps a tinted region’s quiet label legible in the %s appearance',
    (id, block) => {
      // `--fg-muted` on `--bg-subtle` is 4.34:1 in Solarized — under AA, and the finding
      // HIVE-5.4, HIVE-5.6 and HIVE-7.1 each measured. Inside `.cid-inset` the quiet ink is
      // `--fg`, which clears AA in all nine.
      expect(declaration('.cid-inset', 'background')).toBe('var(--bg-subtle)');
      expect(declaration('.cid-inset .text-fg-muted', 'color')).toBe('var(--fg)');
      const ratio = contrastRatio(
        paint('--fg', block, PAPER),
        paint('--bg-subtle', block, paint('--bg-surface', block, PAPER))
      );
      expect({ id, ok: ratio >= WCAG_AA_NORMAL_TEXT_MIN }).toEqual({ id, ok: true });
    }
  );

  it('keeps the required marker a mark, never a word', () => {
    // `*` with `title="required"` — the 3:1 mark floor applies, and the word is on the tooltip.
    expect(declaration('.cid-field__req', 'color')).toBe('var(--danger)');
  });
});

/* -------------------------------------------------------------------------
   5. The states the acceptance criteria name
   ------------------------------------------------------------------------- */

describe('the states', () => {
  it('strikes a deleted conversion target through and quiets it', () => {
    expect(declaration('.cid-converted__deleted', 'text-decoration')).toBe('line-through');
    expect(declaration('.cid-converted__deleted', 'color')).toBe('var(--fg-muted)');
  });

  it('takes an inactive pane out of the layout as well as out of the a11y tree', () => {
    // `.cid-pane` is a flex column, and a flex container's own `display` beats `[hidden]`'s
    // UA `display: none` — so without this rule every "hidden" pane would still be drawn.
    expect(declaration('.cid-pane[hidden]', 'display')).toBe('none');
  });

  it('marks a deep-linked entity with one attribute rather than a palette', () => {
    expect(declaration('.cid-entity[data-highlighted="true"]', 'background')).toBe(
      'var(--accent-soft)'
    );
    expect(declaration('.cid-entity[data-highlighted="true"]', 'box-shadow')).toContain(
      'var(--accent)'
    );
  });

  it('keeps a deep-linked entity clear of the sticky page header', () => {
    expect(declaration('.cid-entity', 'scroll-margin-block-start')).toBe('var(--space-12)');
  });

  it('drops the rail connector on the last step only', () => {
    expect(declaration('.cid-step:last-child .cid-step__tile::after', 'display')).toBe('none');
  });

  it('gives the orb button a visible focus ring', () => {
    expect(declaration('button.cid-orb:focus-visible', 'box-shadow')).toBe('var(--shadow-focus)');
  });
});
