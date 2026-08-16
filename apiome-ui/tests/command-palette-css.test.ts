/**
 * The stylesheet half of the command palette (HIVE-3.6, #5292).
 *
 * `tests/command-palette.test.tsx` drives the palette and pins what it does. It cannot pin
 * any of the things that make the palette *readable*, because jsdom compiles no stylesheet:
 * the 640 px surface, the active row's fill, the gated row's ink, and the fact that none of
 * those is a hard-coded colour or a frozen pixel size.
 *
 * So this suite reads `globals.css` the way `app-shell-css.test.ts` and
 * `page-chrome-css.test.ts` do, and pins four things:
 *
 *   1. The surface is the `DESIGN.md` §5.4 size, stated in `rem` so the font-size
 *      preference reaches it, and it rises from a fixed line rather than being centred.
 *   2. The active row — the visible half of "arrow keys move a visible active row" — is
 *      selected by cmdk's `[data-selected]` attribute, which no component renders.
 *   3. A gated row is styled from `[data-disabled]`, keeping its reason legible.
 *   4. Every ink in the palette is a token, and every quiet ink is one that clears WCAG AA
 *      on the surface it is painted on, in every theme.
 */

import {
  contrastRatio,
  hexToRgb,
  parseDeclarations,
  readGlobalsCss,
  readThemeBlocks,
  readTokenLayer,
  resolveThemeToken,
  topLevelRules,
  type CssRule,
} from './helpers/design-tokens';

const css = readGlobalsCss();
const rules = topLevelRules(css);
const tokens = readTokenLayer(css);

/** WCAG AA for normal-size text — the bar `DESIGN.md` §9 sets for anything meant to be read. */
const WCAG_AA_NORMAL_TEXT_MIN = 4.5;

/** The 640 px of `DESIGN.md` §5.4, as a `rem` measure at the default root. */
const PALETTE_WIDTH_REM = '40rem';

/**
 * The one top-level rule with this prelude.
 *
 * @param prelude Exact prelude, whitespace-collapsed.
 * @returns The rule.
 * @throws When the stylesheet has none, or more than one.
 */
function ruleFor(prelude: string): CssRule {
  const matches = rules.filter((rule) => rule.prelude === prelude);
  if (matches.length !== 1) {
    throw new Error(`globals.css has ${matches.length} \`${prelude}\` rules; expected exactly 1`);
  }
  return matches[0];
}

/**
 * The declarations of a top-level rule.
 *
 * @param prelude Exact prelude.
 * @returns Property to value.
 */
function declarationsOf(prelude: string): Map<string, string> {
  return parseDeclarations(ruleFor(prelude).body);
}

/** Every `.palette*` rule the stylesheet carries, at the top level. */
const paletteRules = rules.filter((rule) => rule.prelude.includes('.palette'));

describe('the surface', () => {
  const palette = declarationsOf('.palette');

  it('is the DESIGN.md §5.4 width, in rem so the font-size preference reaches it', () => {
    expect(palette.get('max-width')).toBe(PALETTE_WIDTH_REM);
    // And never wider than the viewport it sits in — the clamp is what keeps it on a phone.
    expect(palette.get('width')).toContain('100vw');
  });

  it('rises from a fixed line rather than being centred vertically', () => {
    // A vertically centred palette moves under the reader's eye on every keystroke, because
    // its height changes as results are filtered. `hive.css` §15 pins it at 12vh.
    expect(palette.get('position')).toBe('fixed');
    expect(palette.get('top')).toBe('12vh');
    expect(palette.get('transform')).toBe('translateX(-50%)');
  });

  it('is a themed surface with the overlay shadow, not a painted panel', () => {
    expect(palette.get('background')).toBe('var(--bg-surface)');
    expect(palette.get('box-shadow')).toBe('var(--shadow-lg)');
    expect(palette.get('border-radius')).toBe('var(--r-xl)');
  });

  it('animates in on the design language’s own curve, which reduced motion already flattens', () => {
    expect(palette.get('animation')).toContain('var(--dur-slow)');
    expect(palette.get('animation')).toContain('var(--ease-out)');
    expect(css).toContain('@keyframes palette-rise');
  });
});

describe('the rows', () => {
  it('marks the active row from cmdk’s own attribute, which no component renders', () => {
    // This is the visible half of "arrow keys move a visible active row": React only moves
    // `data-selected`, and it is this rule that turns that into something a reader can see.
    const active = ruleFor(
      ".palette__item:hover, .palette__item[data-selected='true']"
    );
    expect(parseDeclarations(active.body).get('background')).toBe('var(--bg-subtle)');
  });

  it('grows a row rather than clipping it, so a long label survives the large font scales', () => {
    const item = declarationsOf('.palette__item');
    expect(item.get('min-height')).toBeDefined();
    expect(item.get('height')).toBeUndefined();
  });

  it('styles a gated row from `data-disabled`, keeping its reason readable', () => {
    const disabled = declarationsOf(".palette__item[data-disabled='true']");
    expect(disabled.get('cursor')).toBe('not-allowed');
    // Muted, not hidden and not `--fg-subtle`: the reason *is* the disabled row's message.
    expect(disabled.get('color')).toBe('var(--fg-muted)');
    expect(disabled.get('display')).toBeUndefined();
  });
});

describe('the stylesheet’s own rules', () => {
  it('paints nothing with a literal colour', () => {
    for (const rule of paletteRules) {
      for (const [property, value] of parseDeclarations(rule.body)) {
        if (!/color|background|border|shadow|fill/.test(property)) continue;
        expect(`${rule.prelude} { ${property}: ${value} }`).not.toMatch(/#[0-9a-f]{3,8}\b/i);
        expect(`${rule.prelude} { ${property}: ${value} }`).not.toMatch(/\brgba?\(/i);
      }
    }
  });

  it('freezes no type size', () => {
    for (const rule of paletteRules) {
      const size = parseDeclarations(rule.body).get('font-size');
      if (size) expect(size).toMatch(/^var\(--fs-/);
    }
  });

  it('has a rule for every class the component draws with', () => {
    const preludes = paletteRules.map((rule) => rule.prelude).join(' ');
    for (const className of [
      '.palette__input',
      '.palette__list',
      '.palette__group',
      '.palette__item',
      '.palette__item-icon',
      '.palette__item-label',
      '.palette__item-meta',
      '.palette__item-keys',
      '.palette__empty',
      '.palette__foot',
    ]) {
      expect(preludes).toContain(className);
    }
  });
});

describe('quiet text a reader has to read', () => {
  /** The `light` default plus every theme block that restates the token. */
  const themeBlocks = readThemeBlocks(css);
  const themes: readonly (string | undefined)[] = [undefined, ...themeBlocks.keys()];

  it('reads the light default and every theme block, so a new theme cannot slip past', () => {
    expect(themes.length).toBeGreaterThanOrEqual(8);
  });

  it('clears WCAG AA for the meta line and the legend against the palette surface', () => {
    // The mockup paints both `--fg-subtle`, which measures 2.8–4.0:1 — and one of them is a
    // gated row's *reason*, the copy in the palette a reader most needs. Same finding, and
    // the same answer, as HIVE-3.3's rail and HIVE-3.5's breadcrumb.
    for (const theme of themes) {
      const block = theme ? themeBlocks.get(theme) : undefined;
      const ratio = contrastRatio(
        hexToRgb(resolveThemeToken('--color-fg-muted', tokens, block)),
        hexToRgb(resolveThemeToken('--color-surface', tokens, block))
      );
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
    }
  });

  it('uses no `--fg-subtle` anywhere in the palette’s own rules', () => {
    for (const rule of paletteRules) {
      expect(rule.body).not.toContain('--fg-subtle');
    }
  });
});
