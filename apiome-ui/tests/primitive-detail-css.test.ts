/**
 * The stylesheet half of the primitive-detail redesign (HIVE-6.6, #5317).
 *
 * `primitive-detail-hive.test.tsx` renders the screen and pins its markup; it cannot pin anything
 * that makes it *look* right, because jsdom compiles no stylesheet. So this suite reads
 * `globals.css` the way `primitives-css.test.ts` and `style-guide-detail-css.test.ts` do, and pins
 * what the page leans on:
 *
 *   1. **The skin is tokens only.** What this replaced named colour outright: a `bg-gray-900`
 *      schema well and example block that stayed black in Whiteboard, six
 *      `bg-*-100 text-*-700 dark:bg-*-900/40` pills, a `text-indigo-600` header glyph repeated
 *      eight times, three hand-built verdict skins, ten `border-gray-200 … dark:border-gray-600`
 *      hairlines and a `bg-indigo-600` mode switch.
 *   2. **Nothing is frozen in pixels.** The mockup fixes the `req-pill` at 16/10px, the chain dot
 *      at 10px, the prop row's rhythm at 10px, the `nested` box at 10/12px, the banner at 6/10px,
 *      the schema pane at 360px and four inputs at 280px. All are a token, a `rem` or a `ch`
 *      here, so the page follows both densities and all six font scales.
 *   3. **The aside folds under the main column**, so nothing here can scroll the document
 *      sideways at 1280 px, and a long `$id` — a URL with no spaces in it — cannot hold a track
 *      open.
 *   4. **A tone never paints a word.** Measured across the nine appearances on `--bg-surface`:
 *      `--fg` clears AA at 8.73:1 worst and `--fg-muted` at 4.86:1, while `--warn` reaches only
 *      2.82:1 (Solarized) and `--danger` 2.46:1 (Nord). So every sentence is `--fg` or
 *      `--fg-muted`, and a tone only ever lands on a glyph, a dot or a rail that sits beside
 *      words saying the same thing.
 *   5. **`.pd-head` states `flex-direction`.** It is applied to a `CardHeader`, which is a
 *      `flex-col`. An unlayered rule outranks `@layer utilities` — but only for what it declares,
 *      so omitting the direction would leave the head a silent column.
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

/** WCAG 1.4.11 for a graphic that carries meaning. */
const WCAG_NON_TEXT_MIN = 3;

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
 * Listed rather than pattern-matched so a rule that is *renamed* fails here instead of silently
 * dropping out of the token-only walk below.
 */
const DETAIL_PRELUDES = [
  '.pd-grid',
  '.pd-col',
  '.pd-badges',
  '.pd-title-glyph',
  '.pd-head',
  '.pd-head__actions',
  '.pd-toggle',
  '.pd-toggle > svg',
  '.pd-viewer',
  '.pd-test',
  '.pd-test__bar',
  '.pd-note',
  '.pd-props',
  '.pd-prop',
  '.pd-prop + .pd-prop',
  '.pd-prop__check',
  '.pd-prop__body',
  '.pd-prop__head',
  '.pd-prop__name',
  '.pd-type-hint',
  '.pd-prop__editor',
  '.pd-stack',
  '.pd-list',
  '.pd-input',
  '.pd-nested',
  '.pd-nested__head',
  '.pd-nested__title',
  '.pd-extra-key',
  '.pd-findings',
  '.pd-findings__title',
  '.pd-findings__title > svg',
  '.pd-findings__list',
  '.pd-finding',
  '.pd-finding__pointer',
  '.pd-field-findings',
  '.pd-pattern',
  '.pd-pattern > svg',
  ".pd-pattern[data-matches='true'] > svg",
  ".pd-pattern[data-matches='false'] > svg",
  ".pd-pattern[data-matches='invalid-pattern'] > svg",
  '.pd-pattern__regex',
  '.pd-kv',
  '.pd-kv > div',
  '.pd-kv dt',
  '.pd-kv dd',
  '.pd-usage',
  '.pd-chain',
  '.pd-chain__step',
  '.pd-chain__step--ref',
  ".pd-chain__step--ref[data-status='unresolved']",
  '.pd-chain__dot',
  '.pd-chain__glyph',
  ".pd-chain__step--ref[data-status='unresolved'] .pd-chain__glyph",
  '.pd-chain__body',
  '.pd-chain__label',
  '.pd-chain__meta',
] as const;

/** The rules that paint a *mark* rather than a word — the only ones allowed a tone. */
const MARK_PRELUDES: ReadonlySet<string> = new Set([
  '.pd-toggle > svg',
  '.pd-findings__title > svg',
  '.pd-pattern > svg',
  ".pd-pattern[data-matches='true'] > svg",
  ".pd-pattern[data-matches='false'] > svg",
  ".pd-pattern[data-matches='invalid-pattern'] > svg",
  '.pd-chain__dot',
  '.pd-chain__glyph',
  ".pd-chain__step--ref[data-status='unresolved'] .pd-chain__glyph",
  ".pd-chain__step--ref[data-status='unresolved']",
]);

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
 * The primitive-detail block, from its banner to the start of whatever section follows it.
 *
 * Bounded rather than run to the end of the file, for the reason `api-keys-css.test.ts` records:
 * `globals.css` grows one section per redesign ticket, and a slice that ended at EOF would make
 * every assertion below a claim about every *later* section too.
 */
const SECTION = (() => {
  const start = css.indexOf('PRIMITIVE DETAIL  (HIVE-6.6, #5317)');
  if (start < 0) throw new Error('globals.css has no primitive-detail section');
  const bannerStart = css.lastIndexOf('/* =', start);
  const next = css.indexOf('/* =', start);
  return css.slice(bannerStart < 0 ? start : bannerStart, next < 0 ? css.length : next);
})();

/** The same block with its comments removed. */
const SECTION_CODE = SECTION.replace(/\/\*[\s\S]*?\*\//g, '');

/* -------------------------------------------------------------------------
   1. The section exists, and names no colour
   ------------------------------------------------------------------------- */

describe('the primitive-detail section of globals.css', () => {
  it('declares every rule the components reference', () => {
    const missing = DETAIL_PRELUDES.filter(
      (prelude) => !rules.some((rule) => rule.prelude === prelude)
    );
    expect(missing).toEqual([]);
  });

  it('sits after the unlayered p and h1–h4 base rules it has to outrank', () => {
    // Half the quiet lines are `p`s and every card title is an `h2`; both base rules are
    // unlayered, so a rule declared before them would lose whatever its specificity.
    for (const prelude of DETAIL_PRELUDES) {
      expect(detailRule(prelude).line).toBeGreaterThan(BASE_TYPE_RULE_LINE);
    }
  });

  it('names no colour — every hue resolves through the token layer', () => {
    for (const prelude of DETAIL_PRELUDES) {
      for (const [property, value] of parseDeclarations(detailRule(prelude).body)) {
        expect({ prelude, property, value }).toMatchObject({ prelude, property });
        expect(value).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        expect(value.replace(/color-mix\([^)]*\)/g, '')).not.toMatch(
          /\b(?:rgb|rgba|hsl|hsla|oklch)\(/
        );
      }
    }
  });

  it('does not reintroduce the palette classes the two components named', () => {
    for (const banned of ['indigo-', 'emerald-', 'red-', 'amber-', 'gray-', 'slate-', 'teal-']) {
      expect(SECTION_CODE).not.toContain(banned);
    }
  });

  it('leaves the hex fence of the stylesheet intact', () => {
    expect(findUnfencedHex(css).map((entry) => `${entry.line}: ${entry.text}`)).toEqual([]);
  });

  it('never fades anything — the block declares no opacity at all', () => {
    // The screen this replaces had none either; recording it keeps a disabled row from arriving
    // as `opacity: .55`, which fades the explanation along with the thing being explained.
    const faded = DETAIL_PRELUDES.filter((prelude) =>
      parseDeclarations(detailRule(prelude).body).has('opacity')
    );
    expect(faded).toEqual([]);
  });
});

/* -------------------------------------------------------------------------
   2. Nothing is frozen in pixels
   ------------------------------------------------------------------------- */

describe('density and font-scale independence', () => {
  it('states no font size or control metric in px', () => {
    // `1px` is exempt everywhere — a hairline is one device pixel by definition — and `2px` only
    // in a border or a shadow, which are strokes rather than font metrics or control heights:
    // they must *not* grow with the font scale.
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
    for (const prelude of DETAIL_PRELUDES) {
      for (const [property, value] of parseDeclarations(detailRule(prelude).body)) {
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

  it('sizes every glyph from the shared icon metrics, or from the type it sits in', () => {
    // A card head's chevron and flask belong to the icon vocabulary.
    for (const prelude of ['.pd-toggle > svg']) {
      expect(declaration(prelude, 'inline-size')).toBe('var(--icon-dense)');
      expect(declaration(prelude, 'block-size')).toBe('var(--icon-dense)');
    }
    // The three that ride a line of text rather than a heading take the button metric.
    for (const prelude of ['.pd-findings__title > svg', '.pd-pattern > svg', '.pd-chain__glyph']) {
      expect(declaration(prelude, 'inline-size')).toBe('var(--icon-button)');
      expect(declaration(prelude, 'block-size')).toBe('var(--icon-button)');
    }
    // The title glyph is `em`: it belongs to the `h1` and has to stay in proportion to it.
    expect(declaration('.pd-title-glyph', 'inline-size')).toMatch(/em$/);
  });

  it('spends spacing tokens rather than literal gaps, so Compact is genuinely compact', () => {
    for (const [prelude, property] of [
      ['.pd-grid', 'gap'],
      ['.pd-col', 'gap'],
      ['.pd-badges', 'gap'],
      ['.pd-test', 'gap'],
      ['.pd-stack', 'gap'],
      ['.pd-list', 'gap'],
      ['.pd-kv', 'gap'],
      ['.pd-nested', 'padding'],
      ['.pd-findings', 'padding'],
      ['.pd-note', 'padding'],
      ['.pd-prop__editor', 'padding-inline-start'],
    ] as const) {
      expect(declaration(prelude, property)).toMatch(/var\(--space-1\)|var\(--space-\d\)/);
    }
  });

  it('measures the two input widths in `ch`, so they follow the type rather than freeze', () => {
    // The mockup fixes four boxes at `max-width: 280px`. A measure is a number of characters.
    expect(declaration('.pd-input', 'max-inline-size')).toMatch(/ch$/);
    expect(declaration('.pd-extra-key', 'inline-size')).toMatch(/ch$/);
  });

  it('sizes every type step from the scale', () => {
    for (const [prelude, expected] of [
      ['.pd-prop__name', 'var(--fs-sm)'],
      ['.pd-type-hint', 'var(--fs-2xs)'],
      ['.pd-nested__title', 'var(--fs-xs)'],
      ['.pd-findings__title', 'var(--fs-sm)'],
      ['.pd-finding', 'var(--fs-xs)'],
      ['.pd-pattern', 'var(--fs-xs)'],
      ['.pd-note', 'var(--fs-xs)'],
      ['.pd-kv dt', 'var(--fs-xs)'],
      ['.pd-kv dd', 'var(--fs-xs)'],
      ['.pd-chain__label', 'var(--fs-sm)'],
      ['.pd-chain__meta', 'var(--fs-2xs)'],
    ] as const) {
      expect(declaration(prelude, 'font-size')).toBe(expected);
    }
  });
});

/* -------------------------------------------------------------------------
   3. The page cannot scroll the document sideways
   ------------------------------------------------------------------------- */

describe('the two columns', () => {
  it('is one column by default and two above a rem fold point', () => {
    expect(declaration('.pd-grid', 'grid-template-columns')).toBe('minmax(0, 1fr)');

    // The `@media` rule is nested, so it is not a top-level rule: read it out of the section.
    const query = SECTION.match(/@media \(min-width: ([\d.]+)rem\) \{\s*\.pd-grid \{([^}]*)\}/);
    expect(query).not.toBeNull();
    expect(query?.[2]).toContain('minmax(0, 2fr) minmax(0, 1fr)');
  });

  it('lets both tracks shrink, so a long $id cannot hold one open', () => {
    // `minmax(0, …)` rather than the automatic minimum, which is the *content* width: a URL with
    // no spaces in it would otherwise hold the main column at its intrinsic width.
    const query = SECTION.match(/@media \(min-width: [\d.]+rem\) \{\s*\.pd-grid \{([^}]*)\}/);
    expect(query?.[1]).not.toMatch(/(?<!minmax\(0, )\b\d+fr/);
  });

  it('lifts the automatic minimum on every column and body that holds an identifier', () => {
    for (const prelude of [
      '.pd-col',
      '.pd-prop__body',
      '.pd-type-hint',
      '.pd-stack',
      '.pd-list',
      '.pd-kv > div',
      '.pd-kv dd',
      '.pd-chain__body',
      '.pd-pattern__regex',
    ]) {
      expect(declaration(prelude, 'min-inline-size')).toBe('0');
    }
  });

  it('lets an unbreakable identifier break rather than take the page with it', () => {
    for (const prelude of [
      '.pd-prop__name',
      '.pd-type-hint',
      '.pd-kv dd',
      '.pd-finding__pointer',
      '.pd-pattern__regex',
      '.pd-chain__label',
      '.pd-chain__meta',
    ]) {
      expect(declaration(prelude, 'overflow-wrap')).toBe('anywhere');
    }
  });

  it('wraps every row of controls instead of squeezing it', () => {
    for (const prelude of [
      '.pd-badges',
      '.pd-head',
      '.pd-head__actions',
      '.pd-test__bar',
      '.pd-prop__head',
      '.pd-nested__head',
      '.pd-finding',
      '.pd-pattern',
    ]) {
      expect(declaration(prelude, 'flex-wrap')).toBe('wrap');
    }
  });
});

/* -------------------------------------------------------------------------
   4. The unlayered-vs-utilities trap
   ------------------------------------------------------------------------- */

describe('the classes that land on a component', () => {
  it('states flex-direction on the card head, which is applied to a flex-col', () => {
    // An unlayered rule outranks `@layer utilities`, but only for what it *declares*: omit the
    // direction and `CardHeader`'s own `flex-col` still applies, silently.
    expect(declaration('.pd-head', 'display')).toBe('flex');
    expect(declaration('.pd-head', 'flex-direction')).toBe('row');
  });

  it('drops the stat strip’s elevation where it sits inside a card', () => {
    expect(declaration('.pd-usage', 'box-shadow')).toBe('none');
  });

  it('frames the schema pane without filling it — Monaco paints its own ground', () => {
    const pane = parseDeclarations(detailRule('.pd-viewer').body);
    expect(pane.get('box-shadow')).toContain('var(--border)');
    expect(pane.has('background')).toBe(false);
    expect(pane.has('background-color')).toBe(false);
  });
});

/* -------------------------------------------------------------------------
   5. A tone never paints a word
   ------------------------------------------------------------------------- */

describe('what the block is allowed to paint in a tone', () => {
  /** The only inks a word may take here. */
  const WORD_INKS = new Set(['var(--fg)', 'var(--fg-muted)', 'inherit', 'currentColor']);

  it('inks every sentence in --fg or --fg-muted, never in a tone', () => {
    for (const prelude of DETAIL_PRELUDES) {
      if (MARK_PRELUDES.has(prelude)) continue;
      const ink = parseDeclarations(detailRule(prelude).body).get('color');
      if (ink === undefined) continue;
      expect({ prelude, ink }).toEqual({ prelude, ink: expect.any(String) });
      expect(WORD_INKS.has(ink)).toBe(true);
    }
  });

  it('fills nothing in a tone except the one dot that is a mark', () => {
    for (const prelude of DETAIL_PRELUDES) {
      const fill =
        parseDeclarations(detailRule(prelude).body).get('background') ??
        parseDeclarations(detailRule(prelude).body).get('background-color');
      if (fill === undefined) continue;
      const allowed = prelude === '.pd-chain__dot' ? /var\(--ok\)/ : /var\(--bg-[a-z]+\)/;
      expect({ prelude, fill }).toMatchObject({ prelude });
      expect(fill).toMatch(allowed);
    }
  });

  it('keeps every word above AA on the card surface, in all nine appearances', () => {
    for (const [id, block] of APPEARANCES) {
      const surface = paint('--bg-surface', block);
      for (const token of ['--fg', '--fg-muted']) {
        const ratio = contrastRatio(paint(token, block), surface);
        expect({ id, token, clears: ratio >= WCAG_AA_NORMAL_TEXT_MIN }).toEqual({
          id,
          token,
          clears: true,
        });
      }
    }
  });

  it('keeps the quiet wells above AA too — the example instance and the caveat', () => {
    // `.prm-code` is `--bg-inset` with `--fg` code, borrowed from HIVE-6.5 rather than restated;
    // `.pd-note` is the same ground with `--fg-muted` on it.
    for (const [id, block] of APPEARANCES) {
      const inset = paint('--bg-inset', block, ['--bg-surface']);
      for (const ink of ['--fg', '--fg-muted']) {
        const ratio = contrastRatio(paint(ink, block, ['--bg-surface']), inset);
        expect({ id, ink, clears: ratio >= WCAG_AA_NORMAL_TEXT_MIN }).toEqual({
          id,
          ink,
          clears: true,
        });
      }
    }
  });

  it('re-grounds the loose-validation caveat, whose Alert variant is under AA in Solarized', () => {
    // `Alert variant="neutral"` is `--bg-subtle`, on which `--fg-muted` measures 4.34:1 there —
    // a serious axe finding the browser suite caught. `--bg-inset` clears it in all nine.
    expect(declaration('.pd-note', 'background')).toBe('var(--bg-inset)');
    for (const [id, block] of APPEARANCES) {
      const subtle = paint('--bg-subtle', block, ['--bg-surface']);
      const inset = paint('--bg-inset', block, ['--bg-surface']);
      const muted = paint('--fg-muted', block, ['--bg-surface']);
      // The one that fails is the reason the other is used; both are recorded so a token change
      // that reverses them fails here.
      expect({ id, clears: contrastRatio(muted, inset) >= WCAG_AA_NORMAL_TEXT_MIN }).toEqual({
        id,
        clears: true,
      });
      if (id === 'solarized') {
        expect(contrastRatio(muted, subtle)).toBeLessThan(WCAG_AA_NORMAL_TEXT_MIN);
      }
    }
  });

  it('keeps the one tone mark that stands alone above the graphic floor', () => {
    // The chain's head dot is `--ok`; every other toned mark sits beside a sentence in `--fg`
    // that states the same thing, which is what carries `--warn` (2.82:1 in Solarized) and
    // `--danger` (2.46:1 in Nord) past the 1.4.11 bar they do not clear on their own.
    expect(declaration('.pd-chain__dot', 'background')).toBe('var(--ok)');
    for (const [id, block] of APPEARANCES) {
      const ratio = contrastRatio(paint('--ok', block), paint('--bg-surface', block));
      expect({ id, clears: ratio >= WCAG_NON_TEXT_MIN }).toEqual({ id, clears: true });
    }
  });
});
