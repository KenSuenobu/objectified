/**
 * The stylesheet half of the Repositories redesign (HIVE-7.3, #5320).
 *
 * `repositories-hive-redesign.test.tsx` renders the screen and pins its markup; it cannot pin
 * anything that makes it *look* right, because jsdom compiles no stylesheet. So this suite
 * reads `globals.css` the way `catalog-css.test.ts` and `catalog-item-detail-css.test.ts` do,
 * and pins what the components lean on:
 *
 *   1. **The skin is tokens only.** What this replaces named colour outright in about 180
 *      places across the list screen and its four helper components —
 *      `from-indigo-500 to-purple-500` avatars, `bg-emerald-100 text-emerald-700
 *      dark:bg-emerald-900/40` status pills, `border-amber-300/60 bg-amber-50/50
 *      text-amber-950` refresh chips and `bg-rose-500/80 dark:bg-rose-400/80` scan bars. Every
 *      one froze the surface on one light palette and one dark one.
 *   2. **Nothing is frozen in pixels.** The mockup's page-local block fixes the scan strip at
 *      22px with 6px bars, the four filter fields at 150–250px, the meter at 90–120px, the
 *      description reserve at 40px and the add tile at 200px; all are `rem` or a token here.
 *   3. **Every multi-column grid collapses**, so the card grid cannot scroll the document
 *      sideways at any font scale.
 *   4. **Quiet text is `--fg-muted`**, not the mockup's `--fg-subtle`, which does not clear AA
 *      at these sizes — measured here in all nine appearances.
 *   5. **No word is painted with a tone ink on the plain surface.** `--danger-fg` measures
 *      1.47:1 there in Nord, so "Scan failed" and both refresh sentences sit on the `-soft`
 *      ground their ink was calibrated against.
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
const REPOSITORY_PRELUDES = [
  '.repo-quiet',
  '.repo-menu__item--danger[data-highlighted], .repo-menu__item--danger:hover',
  '.repo-menu__item--danger[data-highlighted] > svg, .repo-menu__item--danger:hover > svg',
  '.repo-menu__sep',
  '.repo-row-menu',
  '.repo-tab__glyph',
  '.repo-kpi__unwired',
  '.repo-kpi__note',
  '.repo-kpi__dot',
  '.repo-filter',
  '.repo-filter[data-active]',
  '.repo-provider__glyph',
  '.repo-provider[data-provider="gitlab"] .repo-provider__glyph',
  '.repo-provider[data-provider="bitbucket"] .repo-provider__glyph',
  '.repo-provider[data-provider="public_url"] .repo-provider__glyph',
  '.repo-health--compact',
  '.repo-scanbars',
  '.repo-scanbars > span',
  '.repo-scanbars > span[data-failed]',
  '.repo-index-meter',
  '.repo-index-meter > .hive-meter',
  '.repo-index-meter__value',
  '.repo-index-pending',
  '.repo-index-pending__track',
  '.repo-index-mark',
  '.repo-index-mark--empty',
  '.repo-cards-panel',
  '.repo-cards-panel__empty',
  '.repo-grid',
  '.repo-card',
  '.repo-card:hover',
  '.repo-card[data-status="error"]',
  '.repo-card--skeleton',
  '.repo-card__body',
  '.repo-card__head',
  '.repo-card__identity',
  '.repo-card__name',
  '.repo-card__link',
  '.repo-card__link::after',
  '.repo-card__link:hover',
  '.repo-card__link:focus-visible::after',
  '.repo-card__full-name',
  '.repo-card__marks',
  '.repo-card__above',
  '.repo-card__summary',
  '.repo-card__summary[data-empty]',
  '.repo-card__meta',
  '.repo-card__fact',
  '.repo-card__fact > svg',
  '.repo-card__footer',
  '.repo-card__scan',
  '.repo-card__scan[data-failed]',
  '.repo-add-tile',
  '.repo-add-tile:hover',
  '.repo-add-tile:focus-visible',
  '.repo-add-tile__art',
  '.repo-add-tile__title',
  '.repo-add-tile__desc',
  '.repo-row__identity',
  '.repo-row__names',
  '.repo-row__branch, .repo-row__num',
  '.repo-row__scan',
  '.repo-row__scan[data-failed]',
  '.repo-refresh',
  '.repo-refresh__head',
  '.repo-refresh__title',
  '.repo-refresh__title > svg',
  '.repo-refresh__count',
  '.repo-refresh__chips',
  '.repo-refresh__chip',
  '.repo-refresh__n',
  '.repo-refresh__list',
  '.repo-refresh__list > li + li',
  '.repo-refresh__row',
  '.repo-refresh__row:hover',
  '.repo-refresh__row-glyph, .repo-refresh__row-chevron',
  '.repo-refresh__row-name',
  '.repo-refresh__row-detail',
  '.repo-refresh__healthy',
  '.repo-refresh__empty',
  '.repo-refresh__more',
  '.repo-refresh--waiting',
  '.repo-refresh--failed',
] as const;

/**
 * Look one of this ticket's rules up.
 *
 * @param prelude The rule's selector, exactly as {@link REPOSITORY_PRELUDES} lists it.
 * @returns The rule.
 */
function repoRule(prelude: string): CssRule {
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
  const value = parseDeclarations(repoRule(prelude).body).get(property);
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
 * reason `api-keys-css.test.ts` and `catalog-item-detail-css.test.ts` both record: a nested
 * `/* =` would silently cut this slice short and turn every assertion below into a claim about
 * half the block.
 */
const SECTION = (() => {
  const start = css.indexOf('REPOSITORIES  (HIVE-7.3, #5320)');
  if (start < 0) throw new Error('globals.css has no repositories section');
  const bannerStart = css.lastIndexOf('/* =', start);
  const next = css.indexOf('/* =', start + 1);
  return css.slice(bannerStart < 0 ? start : bannerStart, next < 0 ? css.length : next);
})();

/** The same block with its comments removed. */
const SECTION_CODE = SECTION.replace(/\/\*[\s\S]*?\*\//g, '');

/* -------------------------------------------------------------------------
   1. The section exists, and names no colour
   ------------------------------------------------------------------------- */

describe('the repositories section of globals.css', () => {
  it('declares every rule the components reference', () => {
    const missing = REPOSITORY_PRELUDES.filter(
      (prelude) => !rules.some((rule) => rule.prelude === prelude)
    );
    expect(missing).toEqual([]);
  });

  it('is the whole block — no nested banner truncates the slice', () => {
    expect(SECTION).toContain('.repo-quiet');
    expect(SECTION).toContain('.repo-refresh--failed');
    expect(SECTION).toContain('@media (max-width: 40rem)');
  });

  it('sits after the unlayered p and h1–h4 base rules it has to outrank', () => {
    // `.repo-refresh__title` is an `h2`, `.repo-card__summary`, `.repo-refresh__healthy`,
    // `.repo-refresh__empty` and `.repo-refresh__more` are `p`s; both base rules are
    // unlayered, so a rule declared before them would lose whatever its specificity.
    for (const prelude of REPOSITORY_PRELUDES) {
      expect(repoRule(prelude).line).toBeGreaterThan(BASE_TYPE_RULE_LINE);
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
    const colourish = [...SECTION_CODE.matchAll(/\b(?:color|background)\s*:\s*([^;]+);/g)].map(
      (match) => match[1].trim()
    );
    expect(colourish.length).toBeGreaterThan(10);
    for (const value of colourish) {
      expect({ value, ok: /^(var\(--|currentColor|transparent|inherit|none)/.test(value) }).toEqual(
        { value, ok: true }
      );
    }
  });
});

/* -------------------------------------------------------------------------
   2. Nothing is frozen in pixels
   ------------------------------------------------------------------------- */

describe('type-relative sizing', () => {
  it('states every length in rem, a token or a percentage — never in px', () => {
    // The one exception is the hairline: a 1px rule is a hairline by definition and does not
    // scale with text.
    const lengths = [...SECTION_CODE.matchAll(/(\d+(?:\.\d+)?)px/g)].map((match) =>
      Number(match[1])
    );
    expect(lengths.length).toBeGreaterThan(0);
    for (const px of lengths) {
      expect({ px, hairline: px <= 1 }).toEqual({ px, hairline: true });
    }
  });

  it('sizes the mockup’s six frozen lengths in rem or a token', () => {
    // 22px scan strip → 1.375rem; 6px bar → 0.375rem; 2px gap → 0.125rem;
    // 150–250px filter fields → one 10.5rem; 90–120px meter → 6.5rem; 200px add tile → 12rem.
    expect(declaration('.repo-scanbars', 'block-size')).toBe('1.375rem');
    expect(declaration('.repo-scanbars > span', 'inline-size')).toBe('0.375rem');
    expect(declaration('.repo-scanbars', 'gap')).toBe('0.125rem');
    expect(declaration('.repo-filter', 'inline-size')).toBe('10.5rem');
    expect(declaration('.repo-filter', 'block-size')).toBe('var(--control-h-sm)');
    expect(declaration('.repo-index-meter', 'inline-size')).toBe('6.5rem');
    expect(declaration('.repo-add-tile', 'min-block-size')).toBe('12rem');
  });

  it('reserves the card’s description from the type scale, not from a pixel count', () => {
    // The mockup's `min-height: 40px` keeps a grid of cards on one rhythm; stated in px it
    // stops reserving two lines the moment the reader raises the font scale.
    expect(declaration('.repo-card__summary', 'min-block-size')).toBe(
      'calc(var(--fs-sm) * var(--lh-normal) * 2)'
    );
    expect(declaration('.repo-card__summary', '-webkit-line-clamp')).toBe('2');
  });

  it('sizes every glyph from the type around it', () => {
    for (const [prelude, token] of [
      ['.repo-tab__glyph', 'var(--fs-md)'],
      ['.repo-card__fact > svg', 'var(--fs-xs)'],
      ['.repo-refresh__title > svg', 'var(--fs-xs)'],
      ['.repo-refresh__row-glyph, .repo-refresh__row-chevron', 'var(--fs-md)'],
    ] as const) {
      expect({ prelude, size: declaration(prelude, 'inline-size') }).toEqual({
        prelude,
        size: token,
      });
    }
  });
});

/* -------------------------------------------------------------------------
   3. Every grid collapses
   ------------------------------------------------------------------------- */

describe('layout that cannot scroll the document sideways', () => {
  it('lets the card grid auto-fit at a rem minimum instead of a fixed three columns', () => {
    expect(declaration('.repo-grid', 'grid-template-columns')).toBe(
      'repeat(auto-fit, minmax(19rem, 1fr))'
    );
  });

  it('collapses the card grid to one column on a phone', () => {
    const media = rules.find(
      (rule) => rule.prelude === '@media (max-width: 30rem)' && rule.body.includes('.repo-grid')
    );
    expect(media?.body).toContain('minmax(0, 1fr)');
  });

  it('collapses the refresh panel’s row on a narrow viewport', () => {
    const media = rules.find(
      (rule) =>
        rule.prelude === '@media (max-width: 40rem)' && rule.body.includes('.repo-refresh__row')
    );
    expect(media?.body).toContain('grid-template-columns: auto minmax(0, 1fr) auto');
  });

  it('states every breakpoint in rem, so the fold moves with the reader’s type', () => {
    const media = SECTION.match(/@media \([^)]*\)/g) ?? [];
    expect(media.length).toBeGreaterThan(0);
    for (const query of media) {
      expect({ query, rem: /\d+(?:\.\d+)?rem\)/.test(query) }).toEqual({ query, rem: true });
    }
  });

  it('keeps a long repository name from holding a card open', () => {
    // `text-overflow: ellipsis` on a flex child only works if every ancestor allows it to
    // shrink below its content, so the whole chain carries `min-inline-size: 0`.
    for (const prelude of ['.repo-card', '.repo-card__head', '.repo-card__name']) {
      expect(declaration(prelude, 'min-inline-size')).toBe('0');
    }
    expect(declaration('.repo-card__identity', 'min-inline-size')).toBe('0');
    expect(declaration('.repo-card__name', 'text-overflow')).toBe('ellipsis');
    expect(declaration('.repo-card__full-name', 'text-overflow')).toBe('ellipsis');
    expect(declaration('.repo-refresh__row-name', 'text-overflow')).toBe('ellipsis');
  });
});

/* -------------------------------------------------------------------------
   4. The stretched link
   ------------------------------------------------------------------------- */

describe('the card is one link, not a button full of buttons', () => {
  it('stretches the name’s link over the whole card', () => {
    expect(declaration('.repo-card', 'position')).toBe('relative');
    expect(declaration('.repo-card__link::after', 'position')).toBe('absolute');
    expect(declaration('.repo-card__link::after', 'inset')).toBe('0');
  });

  it('puts the focus ring on the card rather than on the words', () => {
    expect(declaration('.repo-card__link:focus-visible::after', 'box-shadow')).toBe(
      'var(--shadow-focus)'
    );
  });

  it('lifts the controls that must stay clickable above it', () => {
    expect(declaration('.repo-card__above', 'position')).toBe('relative');
    expect(Number(declaration('.repo-card__above', 'z-index'))).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------
   5. Contrast
   ------------------------------------------------------------------------- */

describe('contrast', () => {
  /** Every rule on this screen whose whole job is to be quiet. */
  const QUIET = [
    '.repo-quiet',
    '.repo-kpi__unwired',
    '.repo-card__full-name',
    '.repo-card__summary',
    '.repo-card__meta',
    '.repo-card__scan',
    '.repo-row__branch, .repo-row__num',
    '.repo-row__scan',
    '.repo-refresh__count',
    '.repo-refresh__row-detail',
    '.repo-refresh__empty',
    '.repo-refresh__more',
    '.repo-index-meter__value',
    '.repo-index-mark--empty',
    '.repo-add-tile__desc',
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
    expect({ ok: contrastRatio(ink, backdrop) >= WCAG_AA_NORMAL_TEXT_MIN }).toEqual({ ok: true });
  });

  it('never paints a word with a tone ink that has no ground under it', () => {
    // The finding HIVE-7.2 measured and this screen inherits: `--danger-fg` is 1.47:1 on the
    // plain surface in Nord and `--warn-fg` 1.59:1. So every rule below that inks a tone also
    // declares the `-soft` ground the pair was calibrated against — except `--accent-fg`,
    // which clears AA on the surface in all nine appearances (measured below).
    const toneInkRules = rules.filter(
      (rule) =>
        rule.prelude.startsWith('.repo-') &&
        /\bcolor\s*:\s*var\(--(ok|warn|danger|violet|rose|neutral)-fg\)/.test(rule.body)
    );
    expect(toneInkRules.length).toBeGreaterThan(0);
    for (const rule of toneInkRules) {
      expect({
        prelude: rule.prelude,
        grounded: /\bbackground\s*:\s*var\(--(ok|warn|danger|violet|rose|neutral)-soft\)/.test(
          rule.body
        ),
      }).toEqual({ prelude: rule.prelude, grounded: true });
    }
  });

  it.each(APPEARANCES)(
    'clears AA for each grounded tone pair in the %s appearance',
    (id, block) => {
      const surface = paint('--bg-surface', block, PAPER);
      for (const tone of ['danger', 'ok'] as const) {
        const ratio = contrastRatio(
          paint(`--${tone}-fg`, block, PAPER),
          paint(`--${tone}-soft`, block, surface)
        );
        expect({ id, tone, ok: ratio >= WCAG_AA_NORMAL_TEXT_MIN }).toEqual({ id, tone, ok: true });
      }
    }
  );

  it.each(APPEARANCES)(
    'clears AA for the two accent inks drawn on the surface in the %s appearance',
    (id, block) => {
      // `.repo-card__link:hover`, `.repo-refresh__row:hover` and `.repo-filter[data-active]`.
      expect(declaration('.repo-card__link:hover', 'color')).toBe('var(--accent-fg)');
      expect(declaration('.repo-refresh__row:hover', 'color')).toBe('var(--accent-fg)');
      const ratio = contrastRatio(
        paint('--accent-fg', block, PAPER),
        paint('--bg-surface', block, PAPER)
      );
      expect({ id, ok: ratio >= WCAG_AA_NORMAL_TEXT_MIN }).toEqual({ id, ok: true });
    }
  );

  it.each(APPEARANCES)(
    'clears the 3:1 mark floor for the succeeded scan bar in the %s appearance',
    (id, block) => {
      // `--ok` is one of the two solids that clear WCAG 1.4.11 on the surface everywhere. The
      // *failed* bar is `--danger`, which does not — which is why it is also drawn a third the
      // height, and why the strip carries a sentence naming the failures as its accessible
      // name. Shape and text, not colour alone (DESIGN.md §6).
      expect(declaration('.repo-scanbars > span', 'background')).toBe('var(--ok)');
      expect(declaration('.repo-scanbars > span[data-failed]', 'background')).toBe(
        'var(--danger)'
      );
      const ratio = contrastRatio(
        paint('--ok', block, PAPER),
        paint('--bg-surface', block, PAPER)
      );
      expect({ id, ok: ratio >= WCAG_AA_NON_TEXT_MIN }).toEqual({ id, ok: true });
    }
  );

  it('tints a provider glyph but never lets the tint be the whole message', () => {
    // Three of the four glyphs take a role token so the chips are distinguishable at 11px;
    // GitHub keeps `currentColor`. Each chip draws its provider's name beside the glyph —
    // asserted in `repositories-hive-redesign.test.tsx`, which can see the rendered text.
    expect(declaration('.repo-provider[data-provider="gitlab"] .repo-provider__glyph', 'color')).toBe(
      'var(--orange)'
    );
    expect(
      declaration('.repo-provider[data-provider="bitbucket"] .repo-provider__glyph', 'color')
    ).toBe('var(--accent)');
    expect(
      declaration('.repo-provider[data-provider="public_url"] .repo-provider__glyph', 'color')
    ).toBe('var(--violet)');
  });

  it('marks a broken card on its frame rather than by fading its text', () => {
    // Fading a card fades its text with it, and a broken card's text is the text most likely
    // to be read.
    expect(declaration('.repo-card[data-status="error"]', 'box-shadow')).toContain(
      'var(--danger)'
    );
    expect(SECTION_CODE).not.toMatch(/opacity\s*:\s*0?\.\d/);
    expect(SECTION_CODE).not.toMatch(/filter\s*:\s*grayscale/);
  });
});
