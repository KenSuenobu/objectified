/**
 * The stylesheet half of the Published versions redesign (HIVE-8.1, #5327).
 *
 * `published-hive-redesign.test.tsx` renders the screen and pins its markup; it cannot pin
 * anything that makes it *look* right, because jsdom compiles no stylesheet. So this suite
 * reads `globals.css` the way `repositories-css.test.ts` and `catalog-css.test.ts` do, and
 * pins what the components lean on:
 *
 *   1. **The skin is tokens only.** What this replaces named colour outright — a
 *      `text-indigo-600 dark:text-indigo-400` version label, a `bg-blue-100
 *      dark:bg-blue-900/30` lock chip, a `bg-gray-50 dark:bg-gray-900 border-gray-200` URL
 *      box, a `from-amber-500 to-yellow-500` no-tenant card and eleven `text-gray-500
 *      dark:text-gray-400` quiet lines. Every one froze the surface on one light palette and
 *      one dark one.
 *   2. **Nothing is frozen in pixels.** The mockup's page-local block fixes the URL chip at
 *      260px, the mock cell at 150px, the mock URL at 185px, the first column at 210px and the
 *      description clip at 220px; all are `rem` or a token here.
 *   3. **The block sits after the unlayered base type rules** it has to outrank.
 *   4. **Quiet text is `--fg-muted`**, not `--fg-subtle`, which does not clear AA at these
 *      sizes — measured here in all nine appearances.
 *   5. **No word is painted with a tone ink on the plain surface.** `--danger-fg` measures
 *      1.47:1 there in Nord (HIVE-7.2's finding), which is why the visibility failure is an
 *      `Alert` on its own `-soft` ground rather than a red sentence under the table. The only
 *      tone inks this block does spend are `--accent-fg` on two labels and `--ok` on the
 *      copied *glyph* — both measured below, in all nine appearances.
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
const PUBLISHED_PRELUDES = [
  '.pub-col-version',
  '.pub-col-visibility',
  '.pub-col-access',
  '.pub-col-mock',
  '.pub-col-published',
  '.pub-col-actions',
  '.pub-table td',
  '.pub-table td[data-row-actions], .pub-table [data-row-actions]',
  '.pub-version',
  '.pub-version__chips',
  '.pub-version__label',
  '.pub-version__lifecycle',
  '.pub-version__lifecycle:hover',
  '.pub-version__desc',
  '.pub-visibility',
  '.pub-visibility__button',
  '.pub-visibility__button:hover:not(:disabled)',
  '.pub-visibility__button:disabled',
  '.pub-url',
  '.pub-url:hover',
  '.pub-url__code',
  '.pub-url__glyph',
  '.pub-url:hover .pub-url__glyph, .pub-url:focus-visible .pub-url__glyph, tr:hover .pub-url__glyph, tr:focus-within .pub-url__glyph',
  '.pub-url[data-copied] .pub-url__glyph',
  '.pub-stamp',
  '.pub-stamp__author',
  '.pub-menu',
  '.pub-menu--flyout',
  '.pub-menu__item[data-disabled]',
  '.pub-menu__item[data-state="open"]',
  '.pub-menu__chevron',
  '.pub-menu__sep',
  '.pub-menu__item--visibility > svg',
  '.pub-foot__filtered',
  '.pub-foot__hint',
  '.pub-dialog__head',
  '.pub-dialog__heading',
  '.pub-key-dialog__body',
  '.pub-key-dialog__remember',
  '.pub-key-dialog__remember-label',
  '.pub-key-dialog__clear',
] as const;

/**
 * Look one of this ticket's rules up.
 *
 * @param prelude The rule's selector, exactly as {@link PUBLISHED_PRELUDES} lists it.
 * @returns The rule.
 */
function pubRule(prelude: string): CssRule {
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
  const value = parseDeclarations(pubRule(prelude).body).get(property);
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
 * It is the last section in `globals.css`, so there is no following banner to stop at — and
 * there is deliberately no *second* banner inside it either, for the reason
 * `api-keys-css.test.ts` and `repositories-css.test.ts` both record: a nested `/* =` would
 * silently cut this slice short and turn every assertion below into a claim about half the
 * block.
 */
const SECTION = (() => {
  const start = css.indexOf('PUBLISHED VERSIONS  (HIVE-8.1, #5327)');
  if (start < 0) throw new Error('globals.css has no published-versions section');
  const bannerStart = css.lastIndexOf('/* =', start);
  const next = css.indexOf('/* =', start + 1);
  return css.slice(bannerStart < 0 ? start : bannerStart, next < 0 ? css.length : next);
})();

/** The same block with its comments removed. */
const SECTION_CODE = SECTION.replace(/\/\*[\s\S]*?\*\//g, '');

/* -------------------------------------------------------------------------
   1. The section exists, and names no colour
   ------------------------------------------------------------------------- */

describe('the published section of globals.css', () => {
  it('declares every rule the components reference', () => {
    const missing = PUBLISHED_PRELUDES.filter(
      (prelude) => !rules.some((rule) => rule.prelude === prelude)
    );
    expect(missing).toEqual([]);
  });

  it('is the whole block — no nested banner truncates the slice', () => {
    expect(SECTION).toContain('.pub-col-version');
    expect(SECTION).toContain('.pub-key-dialog__clear');
  });

  it('sits after the unlayered p and h1–h4 base rules it has to outrank', () => {
    // `.pub-foot__hint` and `.pub-key-dialog__remember-label` land on text the unlayered base
    // rules also colour, so a rule declared before them would lose whatever its specificity.
    for (const prelude of PUBLISHED_PRELUDES) {
      expect(pubRule(prelude).line).toBeGreaterThan(BASE_TYPE_RULE_LINE);
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
    expect(colourish.length).toBeGreaterThan(8);
    for (const value of colourish) {
      expect({ value, ok: /^(var\(--|currentColor|transparent|inherit|none)/.test(value) }).toEqual(
        { value, ok: true }
      );
    }
  });

  it('names the mockup and the ticket, so the next reader can find the authority', () => {
    expect(SECTION).toContain('docs/mockups/ship/published.html');
    expect(SECTION).toContain('#5327');
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

  it('sizes the mockup’s six frozen lengths in rem', () => {
    // 210px first column → 13.125rem min; 220px description clip → 13.75rem;
    // 260px URL chip → 16.25rem; 150px mock cell → 11.5rem column; 208px menu → 13rem;
    // 190px fly-out → 11.875rem.
    expect(declaration('.pub-col-version', 'min-inline-size')).toBe('13.125rem');
    expect(declaration('.pub-version__desc', 'max-inline-size')).toBe('13.75rem');
    expect(declaration('.pub-url', 'max-inline-size')).toBe('min(100%, 16.25rem)');
    expect(declaration('.pub-col-mock', 'inline-size')).toBe('11.5rem');
    expect(declaration('.pub-menu', 'min-inline-size')).toBe('13rem');
    expect(declaration('.pub-menu--flyout', 'min-inline-size')).toBe('11.875rem');
  });

  it('sizes the cell padding and the menu gaps from the space scale', () => {
    expect(declaration('.pub-table td', 'padding-block')).toBe(
      'calc(var(--space-2) + 0.125rem)'
    );
    expect(declaration('.pub-version__chips', 'gap')).toBe('var(--space-1)');
    expect(declaration('.pub-key-dialog__body', 'gap')).toBe('var(--space-3)');
  });

  it('sizes every glyph from the type around it', () => {
    expect(declaration('.pub-menu__chevron', 'inline-size')).toBe('var(--icon-dense)');
    expect(declaration('.pub-url__glyph', 'inline-size')).toBe('0.75rem');
  });

  it('takes the type steps from the scale rather than naming a size', () => {
    for (const [prelude, token] of [
      ['.pub-version__label', 'var(--fs-sm)'],
      ['.pub-url__code', 'var(--fs-2xs)'],
      ['.pub-stamp', 'var(--fs-sm)'],
      ['.pub-stamp__author', 'var(--fs-xs)'],
      ['.pub-key-dialog__remember-label', 'var(--fs-sm)'],
    ] as const) {
      expect({ prelude, size: declaration(prelude, 'font-size') }).toEqual({ prelude, size: token });
    }
  });
});

/* -------------------------------------------------------------------------
   3. Layout that cannot scroll the document sideways
   ------------------------------------------------------------------------- */

describe('layout that cannot scroll the document sideways', () => {
  it('caps the row menu against the viewport, not at a fixed width', () => {
    expect(declaration('.pub-menu', 'max-inline-size')).toBe('min(20rem, calc(100vw - 1rem))');
  });

  it('lets the version cell shrink — the chain ellipsis needs every ancestor at zero', () => {
    expect(declaration('.pub-version', 'min-inline-size')).toBe('0');
    expect(declaration('.pub-dialog__heading', 'min-inline-size')).toBe('0');
    // The flex child inside the capped URL chip needs it too, or its automatic minimum size
    // (its content) holds the chip open and the ellipsis never fires.
    expect(declaration('.pub-url__code', 'min-inline-size')).toBe('0');
  });

  it('clips the access URL rather than letting it hold the column open', () => {
    // `min()` of the two: never wider than its column, and never wider than the mockup's chip
    // — one long access URL must not widen the table's own scroll width either.
    expect(declaration('.pub-url', 'max-inline-size')).toBe('min(100%, 16.25rem)');
    expect(declaration('.pub-url__code', 'text-overflow')).toBe('ellipsis');
    expect(declaration('.pub-url__code', 'overflow')).toBe('hidden');
    expect(declaration('.pub-url__code', 'white-space')).toBe('nowrap');
  });

  it('clips the revision note the same way', () => {
    expect(declaration('.pub-version__desc', 'text-overflow')).toBe('ellipsis');
    expect(declaration('.pub-version__desc', 'white-space')).toBe('nowrap');
  });
});

/* -------------------------------------------------------------------------
   4. Quiet text is the muted step
   ------------------------------------------------------------------------- */

describe('quiet text clears AA in every appearance', () => {
  const QUIET = [
    ['.pub-stamp', 'color'],
    ['.pub-stamp__author', 'color'],
    ['.pub-url', 'color'],
    ['.pub-foot__hint', 'color'],
    ['.pub-key-dialog__remember-label', 'color'],
    // The mockup inks the clear-saved-key link `--warn-fg`; measured, that ink is 1.59:1 on
    // the dialog's plain surface in Nord. The words are the muted step and the eraser glyph
    // carries the caution — see the block's own note.
    ['.pub-key-dialog__clear', 'color'],
  ] as const;

  it('never reaches for --fg-subtle, which does not clear AA at these sizes', () => {
    for (const [prelude, property] of QUIET) {
      expect({ prelude, ink: declaration(prelude, property) }).toEqual({
        prelude,
        ink: 'var(--fg-muted)',
      });
    }
  });

  it.each(APPEARANCES)('clears 4.5:1 on the surface in the %s appearance', (_id, block) => {
    const surface = paint('--bg-surface', block, PAPER);
    const muted = compositeOver(
      resolveThemeToken('--fg-muted', tokens, block as never),
      surface
    );
    expect(contrastRatio(muted, surface)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
  });
});

/* -------------------------------------------------------------------------
   5. The three tone inks this block does spend, measured
   ------------------------------------------------------------------------- */

describe('the tone inks', () => {
  it('inks the version label and the filtered marker with --accent-fg, not --accent', () => {
    expect(declaration('.pub-version__label', 'color')).toBe('var(--accent-fg)');
    expect(declaration('.pub-foot__filtered', 'color')).toBe('var(--accent-fg)');
  });

  it.each(APPEARANCES)(
    'keeps the accent version label legible on the surface in the %s appearance',
    (_id, block) => {
      const surface = paint('--bg-surface', block, PAPER);
      const ink = compositeOver(resolveThemeToken('--accent-fg', tokens, block as never), surface);
      // A 600-weight `--fs-sm` label is normal-size text, so it is held to the text floor.
      expect(contrastRatio(ink, surface)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
    }
  );

  it.each(APPEARANCES)(
    'records why --accent itself could not carry those words in the %s appearance',
    (_id, block) => {
      // The measurement the block's note states: the mark-strength step is under the text
      // floor in three of the nine appearances, which is why neither label uses it.
      const surface = paint('--bg-surface', block, PAPER);
      const accent = compositeOver(resolveThemeToken('--accent', tokens, block as never), surface);
      expect(contrastRatio(accent, surface)).toBeGreaterThanOrEqual(WCAG_AA_NON_TEXT_MIN);
    }
  );

  it('paints the copied state on a glyph, never on a word', () => {
    expect(declaration('.pub-url[data-copied] .pub-url__glyph', 'color')).toBe('var(--ok)');
    // The rule sets no `color` on the button itself, so no sentence is inked with a tone.
    expect(parseDeclarations(pubRule('.pub-url[data-copied] .pub-url__glyph').body).size).toBe(2);
  });

  it.each(APPEARANCES)(
    'keeps the copied tick and the visibility glyph visible in the %s appearance',
    (_id, block) => {
      const surface = paint('--bg-surface', block, PAPER);
      for (const token of ['--ok', '--accent']) {
        const mark = compositeOver(resolveThemeToken(token, tokens, block as never), surface);
        expect(contrastRatio(mark, surface)).toBeGreaterThanOrEqual(WCAG_AA_NON_TEXT_MIN);
      }
    }
  );

  it('never paints a -fg tone ink as words on the plain surface', () => {
    // The `-fg` steps are calibrated against their own `-soft` grounds, so on the surface
    // they are unmeasured — `--warn-fg` is 1.59:1 in Nord. This block spends none of them as
    // text; `--accent-fg` is the one exception, and it is measured above in all nine.
    const TONE_INK = /^--(?:neutral|ok|warn|danger|accent|honey|violet|orange|rose)-fg$/;
    const inks = [...SECTION_CODE.matchAll(/\bcolor\s*:\s*var\((--[a-z-]+)\)/g)].map(
      (match) => match[1]
    );
    expect(inks.length).toBeGreaterThan(4);
    for (const ink of inks) {
      expect({ ink, allowed: !TONE_INK.test(ink) || ink === '--accent-fg' }).toEqual({
        ink,
        allowed: true,
      });
    }
  });
});

/* -------------------------------------------------------------------------
   6. The two rules the primitives cannot make for themselves
   ------------------------------------------------------------------------- */

describe('what this block overrides on purpose', () => {
  it('top-aligns the multi-line cells the table would otherwise centre', () => {
    expect(declaration('.pub-table td', 'vertical-align')).toBe('top');
  });

  it('keeps the row-actions cell on the row’s own baseline', () => {
    expect(
      declaration('.pub-table td[data-row-actions], .pub-table [data-row-actions]', 'padding-block-start')
    ).toBe('0');
  });

  it('gives the visibility badge a pointer and an honest in-flight cursor', () => {
    expect(declaration('.pub-visibility__button', 'cursor')).toBe('pointer');
    expect(declaration('.pub-visibility__button:disabled', 'cursor')).toBe('progress');
  });

  it('strips the link chrome off the lifecycle pill so the badge is the visible thing', () => {
    expect(declaration('.pub-version__lifecycle', 'text-decoration')).toBe('none');
    expect(declaration('.pub-version__lifecycle', 'color')).toBe('inherit');
  });

  it('declares the menu separator .tnt-menu never did', () => {
    expect(declaration('.pub-menu__sep', 'background')).toBe('var(--border)');
    expect(declaration('.pub-menu__sep', 'block-size')).toBe('1px');
  });
});
