/**
 * The stylesheet half of the Add-repository redesign (HIVE-7.4, #5321).
 *
 * `add-repository-hive-redesign.test.tsx` renders the screen and pins its markup; it cannot pin
 * anything that makes it *look* right, because jsdom compiles no stylesheet. So this suite reads
 * `globals.css` the way `repositories-css.test.ts` and `catalog-css.test.ts` do, and pins what
 * the components lean on:
 *
 *   1. **The skin is tokens only.** What this replaces named colour outright in about 40 places
 *      — a `from-purple-500 to-pink-500` header medallion, `border-indigo-500 bg-indigo-50/40
 *      dark:bg-indigo-900/10` choice cards, `bg-indigo-50 text-indigo-950` repository rows,
 *      `text-emerald-600` / `text-rose-600` result lines and a `border-rose-200 bg-rose-50`
 *      banner. Every one froze the surface on one light palette and one dark one.
 *   2. **Nothing is frozen in pixels.** The mockup's page-local block fixes the choice card at
 *      14/16px, the account tile at 10/12px, the row at 7/10px and the lock at 12px; all are
 *      `rem` or a token here.
 *   3. **Every multi-column grid collapses**, so no row on this route can scroll the document
 *      sideways at any font scale.
 *   4. **Quiet text is `--fg-muted`**, not the mockup's `--fg-subtle`, which does not clear AA
 *      at these sizes — measured here in all nine appearances.
 *   5. **The URL verdict is a tinted strip, not coloured text.** `--ok-fg` and `--danger-fg` on
 *      the plain card measure 1.5–3.5:1 in the six themes that inherit the light semantic pairs,
 *      which is the exposure HIVE-7.3 recorded. Each `-fg` here is paired with its own `-soft`
 *      ground, and both pairs are measured.
 *   6. **A selected choice is never colour alone.** DESIGN.md §6: the accent tint is joined by
 *      an accent hairline that clears 3:1 as a non-text mark in every appearance.
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
 * Listed rather than pattern-matched so a rule that is *renamed* fails here instead of silently
 * dropping out of the token-only walk below.
 */
const ADD_REPOSITORY_PRELUDES = [
  '.repo-new-note',
  '.repo-new-link',
  '.repo-new-link:hover',
  '.repo-new-link:focus-visible',
  '.repo-new-progress',
  '.repo-new-card',
  '.repo-new-card__head',
  '.repo-new-card__title',
  '.repo-new-sources',
  '.repo-new-source',
  '.repo-new-source:hover',
  '.repo-new-source.is-selected',
  '.repo-new-source:has(input:focus-visible)',
  '.repo-new-source > input',
  '.repo-new-source > span',
  '.repo-new-source__tile',
  '.repo-new-source.is-selected .repo-new-source__tile',
  '.repo-new-source__tile > svg',
  '.repo-new-source__text',
  '.repo-new-source__title',
  '.repo-new-source__desc',
  '.repo-new-source.is-selected .repo-new-source__desc',
  '.repo-new-accounts',
  '.repo-new-account',
  '.repo-new-account:hover',
  '.repo-new-account.is-selected',
  '.repo-new-account:has(input:focus-visible)',
  '.repo-new-account > span',
  '.repo-new-account__mark',
  '.repo-new-account__mark > svg',
  '.repo-new-account__text',
  '.repo-new-account__provider',
  '.repo-new-account__handle',
  '.repo-new-account.is-selected .repo-new-account__handle',
  '.repo-new-account__chip',
  '.repo-new-search',
  '.repo-new-repos',
  '.repo-new-repo',
  '.repo-new-repo:hover',
  '.repo-new-repo.is-selected',
  '.repo-new-repo:has(input:focus-visible)',
  '.repo-new-repo > span',
  '.repo-new-repo__glyph',
  '.repo-new-repo__name',
  '.repo-new-repo__lock',
  '.repo-new-repo__desc',
  '.repo-new-repo.is-selected .repo-new-repo__desc',
  '.repo-new-repo__tick',
  '.repo-new-url',
  '.repo-new-url__input',
  '.repo-new-url__test',
  '.repo-new-url__result',
  '.repo-new-url__result[data-tone="ok"]',
  '.repo-new-url__result[data-tone="danger"]',
  '.repo-new-url__result-glyph',
  '.repo-new-error__message',
  '.repo-new-error__remedy',
  '.repo-new-proposal',
  '.repo-new-proposal__head',
  '.repo-new-proposal__title',
  '.repo-new-proposal__title > svg',
  '.repo-new-proposal__badge',
  '.repo-new-proposal__note',
  '.repo-new-proposal__grid',
  '.repo-new-proposal__item',
  '.repo-new-proposal__step',
  '.repo-new-proposal__body',
  '.repo-new-actions',
  '.repo-new-actions__end',
] as const;

/**
 * Look one of this ticket's rules up.
 *
 * @param prelude The rule's selector, exactly as {@link ADD_REPOSITORY_PRELUDES} lists it.
 * @returns The rule.
 */
function newRule(prelude: string): CssRule {
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
  const value = parseDeclarations(newRule(prelude).body).get(property);
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
 * reason `repositories-css.test.ts` and `api-keys-css.test.ts` both record: a nested `/* =`
 * would silently cut this slice short and turn every assertion below into a claim about half the
 * block.
 */
const SECTION = (() => {
  const start = css.indexOf('ADD REPOSITORY  (HIVE-7.4, #5321)');
  if (start < 0) throw new Error('globals.css has no add-repository section');
  const bannerStart = css.lastIndexOf('/* =', start);
  const next = css.indexOf('/* =', start + 1);
  return css.slice(bannerStart < 0 ? start : bannerStart, next < 0 ? css.length : next);
})();

/** The same block with its comments removed. */
const SECTION_CODE = SECTION.replace(/\/\*[\s\S]*?\*\//g, '');

/* -------------------------------------------------------------------------
   1. The section exists, and names no colour
   ------------------------------------------------------------------------- */

describe('the add-repository section of globals.css', () => {
  it('declares every rule the components reference', () => {
    const missing = ADD_REPOSITORY_PRELUDES.filter(
      (prelude) => !rules.some((rule) => rule.prelude === prelude)
    );
    expect(missing).toEqual([]);
  });

  it('is the whole block — no nested banner truncates the slice', () => {
    expect(SECTION).toContain('.repo-new-note');
    expect(SECTION).toContain('.repo-new-actions__end');
    expect(SECTION).toContain('@media (max-width: 40rem)');
  });

  it('sits after the unlayered p and h1–h4 base rules it has to outrank', () => {
    // `.repo-new-card__title` and `.repo-new-proposal__title` are `h2`s and
    // `.repo-new-note`, `.repo-new-proposal__note` and both error lines are `p`s; both base
    // rules are unlayered, so a rule declared before them would lose whatever its specificity.
    for (const prelude of ADD_REPOSITORY_PRELUDES) {
      expect(newRule(prelude).line).toBeGreaterThan(BASE_TYPE_RULE_LINE);
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
      expect({
        value,
        ok: /^(var\(--|currentColor|transparent|inherit|none|linear-gradient\()/.test(value),
      }).toEqual({ value, ok: true });
    }
  });

  it('names no provider hue of its own — HIVE-7.3’s table paints the account marks', () => {
    // `.repo-new-account__mark` carries `.repo-provider` + `data-provider`, so the tint comes
    // from the repositories block. A second table here is how two screens end up disagreeing.
    expect(SECTION_CODE).not.toMatch(/data-provider/);
  });
});

/* -------------------------------------------------------------------------
   2. Nothing is frozen in pixels
   ------------------------------------------------------------------------- */

describe('type-relative sizing', () => {
  it('states every length in rem, a token or a percentage — never in px', () => {
    // The one exception is the hairline: a 1px rule is a hairline by definition and does not
    // scale with text. The focus ring's 2px outline is the platform's own, not a length.
    const lengths = [...SECTION_CODE.matchAll(/(\d+(?:\.\d+)?)px/g)].map((match) =>
      Number(match[1])
    );
    expect(lengths.length).toBeGreaterThan(0);
    for (const px of lengths) {
      expect({ px, hairline: px <= 2 }).toEqual({ px, hairline: true });
    }
  });

  it('sizes the mockup’s frozen insets in rem or a token', () => {
    // 14/16px choice card → space tokens; 10/12px account tile → space tokens;
    // 7/10px row → space tokens with a `--control-h-sm` floor; 22rem list → unchanged.
    expect(declaration('.repo-new-source', 'padding')).toBe(
      'calc(var(--space-3) + 0.125rem) var(--space-4)'
    );
    expect(declaration('.repo-new-account', 'padding')).toBe(
      'var(--space-2) calc(var(--space-2) + 0.25rem)'
    );
    expect(declaration('.repo-new-repo', 'min-block-size')).toBe('var(--control-h-sm)');
    expect(declaration('.repo-new-repos', 'max-block-size')).toBe('22rem');
  });

  it('sizes every glyph from the type around it', () => {
    for (const [prelude, token] of [
      ['.repo-new-source__tile > svg', 'var(--fs-md)'],
      ['.repo-new-account__mark > svg', 'var(--fs-md)'],
      ['.repo-new-repo__glyph', 'var(--fs-sm)'],
      ['.repo-new-repo__lock', 'var(--fs-2xs)'],
      ['.repo-new-repo__tick', 'var(--fs-sm)'],
      ['.repo-new-url__result-glyph', 'var(--fs-sm)'],
      ['.repo-new-proposal__title > svg', 'var(--fs-md)'],
    ] as const) {
      expect({ prelude, size: declaration(prelude, 'inline-size') }).toEqual({
        prelude,
        size: token,
      });
    }
  });

  it('keeps the source card’s icon tile square at every density', () => {
    expect(declaration('.repo-new-source__tile', 'inline-size')).toBe(
      declaration('.repo-new-source__tile', 'block-size')
    );
    expect(declaration('.repo-new-source__tile', 'inline-size')).toBe('calc(var(--fs-md) * 2)');
  });
});

/* -------------------------------------------------------------------------
   3. Nothing can scroll the document sideways
   ------------------------------------------------------------------------- */

describe('layout that cannot scroll the document sideways', () => {
  it('auto-fits the account tiles at a rem minimum rather than the mockup’s three columns', () => {
    expect(declaration('.repo-new-accounts', 'grid-template-columns')).toBe(
      'repeat(auto-fit, minmax(13rem, 1fr))'
    );
    expect(declaration('.repo-new-proposal__grid', 'grid-template-columns')).toBe(
      'repeat(auto-fit, minmax(14rem, 1fr))'
    );
  });

  it('collapses every multi-column grid on a phone', () => {
    const media = css.slice(css.indexOf(SECTION) + SECTION.indexOf('@media (max-width: 40rem)'));
    for (const selector of [
      '.repo-new-sources',
      '.repo-new-accounts',
      '.repo-new-proposal__grid',
    ]) {
      const at = media.indexOf(`${selector} {`);
      expect({ selector, collapses: at >= 0 }).toEqual({ selector, collapses: true });
      expect(media.slice(at, at + 120)).toContain('minmax(0, 1fr)');
    }
  });

  it('gives every truncating child a floor of zero so its ancestor cannot be held open', () => {
    // `text-overflow: ellipsis` on a flex child only works when the chain above it can shrink.
    for (const prelude of [
      '.repo-new-source > span',
      '.repo-new-source__text',
      '.repo-new-account > span',
      '.repo-new-account__text',
      '.repo-new-repo > span',
      '.repo-new-proposal__item',
    ]) {
      expect({ prelude, min: declaration(prelude, 'min-inline-size') }).toEqual({
        prelude,
        min: '0',
      });
    }
  });

  it('lets the repository list scroll inside itself, never taking the page with it', () => {
    expect(declaration('.repo-new-repos', 'overflow-y')).toBe('auto');
    expect(declaration('.repo-new-repos', 'overscroll-behavior')).toBe('contain');
  });

  it('wraps both action clusters rather than squeezing them', () => {
    expect(declaration('.repo-new-actions', 'flex-wrap')).toBe('wrap');
    expect(declaration('.repo-new-progress', 'flex-wrap')).toBe('wrap');
    expect(declaration('.repo-new-url', 'flex-wrap')).toBe('wrap');
  });
});

/* -------------------------------------------------------------------------
   4. Contrast, in all nine appearances
   ------------------------------------------------------------------------- */

describe('quiet text clears AA in every theme', () => {
  it('uses --fg-muted, never the mockup’s --fg-subtle', () => {
    for (const prelude of [
      '.repo-new-note',
      '.repo-new-account__handle',
      '.repo-new-repo__desc',
      '.repo-new-proposal__note',
      '.repo-new-proposal__step',
      '.repo-new-proposal__body',
    ]) {
      expect({ prelude, ink: declaration(prelude, 'color') }).toEqual({
        prelude,
        ink: 'var(--fg-muted)',
      });
    }
  });

  it('measures --fg-muted on the card surface at 4.5:1 or better, nine times', () => {
    for (const [name, block] of APPEARANCES) {
      const surface = paint('--bg-surface', block, PAPER);
      const ink = paint('--fg-muted', block, surface);
      expect({ name, ok: contrastRatio(ink, surface) >= WCAG_AA_NORMAL_TEXT_MIN }).toEqual({
        name,
        ok: true,
      });
    }
  });

  it('raises the quiet line to --fg on a selected row, where the muted step fails', () => {
    // Measured: `--fg-muted` on `--accent-soft` is 3.86:1 in Solarized — axe reported all
    // three pickers at once. `--fg` is 6.51 worst-of-nine.
    for (const prelude of [
      '.repo-new-source.is-selected .repo-new-source__desc',
      '.repo-new-account.is-selected .repo-new-account__handle',
      '.repo-new-repo.is-selected .repo-new-repo__desc',
    ]) {
      expect({ prelude, ink: declaration(prelude, 'color') }).toEqual({ prelude, ink: 'var(--fg)' });
    }

    for (const [name, block] of APPEARANCES) {
      const surface = paint('--bg-surface', block, PAPER);
      const tint = paint('--accent-soft', block, surface);
      const ink = paint('--fg', block, tint);
      expect({ name, ok: contrastRatio(ink, tint) >= WCAG_AA_NORMAL_TEXT_MIN }).toEqual({
        name,
        ok: true,
      });
    }
  });

  it('hovers a row onto --bg-inset, not the mockup’s --bg-subtle', () => {
    // `--fg-muted` on `--bg-subtle` measures 4.35:1 in Solarized; the row's description is
    // drawn in exactly that pair while the pointer is on it.
    expect(declaration('.repo-new-repo:hover', 'background')).toBe('var(--bg-inset)');
    for (const [name, block] of APPEARANCES) {
      const surface = paint('--bg-surface', block, PAPER);
      const hovered = paint('--bg-inset', block, surface);
      const ink = paint('--fg-muted', block, hovered);
      expect({ name, ok: contrastRatio(ink, hovered) >= WCAG_AA_NORMAL_TEXT_MIN }).toEqual({
        name,
        ok: true,
      });
    }
  });
});

describe('the URL verdict is read against the ground it was calibrated on', () => {
  it('pairs each -fg ink with its own -soft fill', () => {
    expect(declaration('.repo-new-url__result[data-tone="ok"]', 'background')).toBe(
      'var(--ok-soft)'
    );
    expect(declaration('.repo-new-url__result[data-tone="ok"]', 'color')).toBe('var(--ok-fg)');
    expect(declaration('.repo-new-url__result[data-tone="danger"]', 'background')).toBe(
      'var(--danger-soft)'
    );
    expect(declaration('.repo-new-url__result[data-tone="danger"]', 'color')).toBe(
      'var(--danger-fg)'
    );
  });

  it('measures both pairs at 4.5:1 or better, nine times', () => {
    for (const [name, block] of APPEARANCES) {
      const surface = paint('--bg-surface', block, PAPER);
      for (const tone of ['ok', 'danger'] as const) {
        const fill = paint(`--${tone}-soft`, block, surface);
        const ink = paint(`--${tone}-fg`, block, fill);
        expect({
          name,
          tone,
          ok: contrastRatio(ink, fill) >= WCAG_AA_NORMAL_TEXT_MIN,
        }).toEqual({ name, tone, ok: true });
      }
    }
  });

  it('puts the untested line on --bg-inset, the one quiet ground that clears AA', () => {
    // `--fg-muted` on `--bg-subtle` measures 4.35:1 in Solarized; on `--bg-inset` it is 5.02.
    expect(declaration('.repo-new-url__result', 'background')).toBe('var(--bg-inset)');
    expect(declaration('.repo-new-url__result', 'color')).toBe('var(--fg-muted)');
    for (const [name, block] of APPEARANCES) {
      const surface = paint('--bg-surface', block, PAPER);
      const well = paint('--bg-inset', block, surface);
      const ink = paint('--fg-muted', block, well);
      expect({ name, ok: contrastRatio(ink, well) >= WCAG_AA_NORMAL_TEXT_MIN }).toEqual({
        name,
        ok: true,
      });
    }
  });
});

describe('a chosen row is never colour alone', () => {
  it('adds an accent hairline to the accent tint, on all three pickers', () => {
    expect(declaration('.repo-new-source.is-selected', 'box-shadow')).toContain('var(--accent)');
    expect(declaration('.repo-new-account.is-selected', 'box-shadow')).toContain('var(--accent)');
    expect(declaration('.repo-new-repo.is-selected', 'box-shadow')).toContain('var(--accent)');
  });

  it('measures that hairline as a 3:1 non-text mark, nine times', () => {
    for (const [name, block] of APPEARANCES) {
      const surface = paint('--bg-surface', block, PAPER);
      const mark = paint('--accent', block, surface);
      expect({ name, ok: contrastRatio(mark, surface) >= WCAG_AA_NON_TEXT_MIN }).toEqual({
        name,
        ok: true,
      });
    }
  });

  it('inks the tick at the -fg step, which is the one that clears AA as a mark on the tint', () => {
    expect(declaration('.repo-new-repo__tick', 'color')).toBe('var(--accent-fg)');
  });

  it('gives every choice row a focus ring of its own, since the native dot may be hidden', () => {
    for (const prelude of [
      '.repo-new-source:has(input:focus-visible)',
      '.repo-new-account:has(input:focus-visible)',
      '.repo-new-repo:has(input:focus-visible)',
    ]) {
      expect(declaration(prelude, 'outline')).toBe('2px solid var(--focus-ring)');
    }
  });
});

describe('links and the honey frame', () => {
  it('inks the manage link at --accent-fg, not the saturated --accent', () => {
    // `--accent` as text measures 4.07:1 worst-of-nine, which axe reports at this size.
    expect(declaration('.repo-new-link', 'color')).toBe('var(--accent-fg)');
    for (const [name, block] of APPEARANCES) {
      const surface = paint('--bg-surface', block, PAPER);
      const ink = paint('--accent-fg', block, surface);
      expect({ name, ok: contrastRatio(ink, surface) >= WCAG_AA_NORMAL_TEXT_MIN }).toEqual({
        name,
        ok: true,
      });
    }
  });

  it('frames the proposal in honey rather than tinting its text with it', () => {
    // DESIGN.md §2: honey is a brand moment, and §6: a frame is a mark, not a word.
    expect(declaration('.repo-new-proposal', 'box-shadow')).toBe(
      'inset 0 0 0 1.5px var(--honey)'
    );
    expect(declaration('.repo-new-proposal__title', 'color')).toBe('var(--fg)');
  });

  it('never lets the honey frame be the thing that carries the meaning', () => {
    // Measured worst-of-nine: `--honey` on `--bg-surface` is 1.85:1 in light and whiteboard
    // (4.05–11.33 in the other seven). It is a brand mark, not a 3:1 state indicator — the
    // same finding HIVE-6.5 recorded for `--violet` and `--honey` alike. That is allowed
    // *because* the card says "Proposed steps 2–4", carries the sentence "Redesign proposal —
    // not in the app today", and holds nothing that can be pressed; the frame adds nothing a
    // reader who cannot see it would lose. This test pins that the words are what the block
    // relies on, so a later edit cannot quietly demote them to decoration.
    const honeyUses = [...SECTION_CODE.matchAll(/var\(--honey[a-z-]*\)/g)].map((m) => m[0]);
    expect(honeyUses.length).toBeGreaterThan(0);
    // Honey never becomes an ink for a sentence: only the frame, the wash and the glyph.
    expect(declaration('.repo-new-proposal__title', 'color')).toBe('var(--fg)');
    expect(declaration('.repo-new-proposal__note', 'color')).toBe('var(--fg-muted)');
    expect(declaration('.repo-new-proposal__body', 'color')).toBe('var(--fg-muted)');
    // And the one honey ink there is sits beside its own words, at the `-fg` step.
    expect(declaration('.repo-new-proposal__title > svg', 'color')).toBe('var(--honey-fg)');
  });

  it('measures every mark that *does* carry state as a 3:1 non-text mark, nine times', () => {
    // The accent hairline on a chosen row is the one this block asks a reader to see.
    for (const [name, block] of APPEARANCES) {
      const surface = paint('--bg-surface', block, PAPER);
      const mark = paint('--accent', block, surface);
      expect({ name, ok: contrastRatio(mark, surface) >= WCAG_AA_NON_TEXT_MIN }).toEqual({
        name,
        ok: true,
      });
    }
  });
});
