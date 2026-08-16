/**
 * The stylesheet half of the page chrome (HIVE-3.5, #5291).
 *
 * `tests/page-header.test.tsx` renders the header and pins its markup. It cannot pin any
 * of the things that make the header *work*, because jsdom compiles no stylesheet: the
 * sticky position, the translucent fill, the content cap, and the two declarations that
 * between them stop a long title from scrolling the document sideways.
 *
 * So this suite reads `globals.css` the way `app-shell-css.test.ts` does, and pins the
 * contract the components rely on:
 *
 *   1. The two content caps are tokens, and `--page-width` is the *single* place a page's
 *      width is decided — the header's inner and the body both read it, so they cannot
 *      drift apart.
 *   2. `.page` is the scroll container a sticky header can stick to, and clips rather than
 *      hides on the cross axis.
 *   3. `.page-header` is sticky, translucent over the canvas, and has an opaque fallback
 *      for a browser with no `backdrop-filter` — "legible over scrolled content" is the
 *      acceptance criterion, and a wash with nothing blurred behind it is not legible.
 *   4. The row wraps and its first child carries `min-width: 0`. That pair *is* the
 *      "long title + 4 actions produce no horizontal scroll" criterion; `e2e/hive-page-
 *      header.spec.ts` measures the result, this pins the mechanism.
 *   5. The title and description declare their own type, because the unlayered `h1` and
 *      `p` rules at the foot of the stylesheet outrank any `@layer utilities` class.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  contrastRatio,
  hexToRgb,
  parseDeclarations,
  readGlobalsCss,
  readThemeBlocks,
  readTokenLayer,
  resolveToken,
  resolveThemeToken,
  topLevelRules,
  type CssRule,
} from './helpers/design-tokens';

const css = readGlobalsCss();
const rules = topLevelRules(css);
const tokens = readTokenLayer(css);

/** WCAG AA for normal-size text — the crumb line is 12 px, so this is the bar it must clear. */
const WCAG_AA_NORMAL_TEXT_MIN = 4.5;

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

describe('page chrome — the content cap', () => {
  it('states both caps as tokens, at the widths DESIGN.md §5.3 gives', () => {
    expect(resolveToken('--page-max', tokens)).toBe('1440px');
    expect(resolveToken('--page-narrow', tokens)).toBe('920px');
  });

  it('decides the width in one place, which both parts of the page read', () => {
    // The default lives on `html`, so a `PageHeader` rendered outside a `Page` still has a
    // cap rather than inheriting nothing.
    const html = rules.filter(
      (rule) => rule.prelude === 'html' && rule.body.includes('--page-width')
    );
    expect(html).toHaveLength(1);
    expect(parseDeclarations(html[0].body).get('--page-width')).toBe('var(--page-max)');

    // Both read the same property. If either named a token directly, a narrow page would
    // put a 1440 px title over a 920 px column.
    expect(declarationsOf('.page-header__inner').get('max-width')).toBe('var(--page-width)');
    expect(declarationsOf('.page-body').get('max-width')).toBe('var(--page-width)');
  });

  it('narrows the body only — the header keeps the page’s width', () => {
    const narrow = declarationsOf('.page--narrow .page-body');
    expect(narrow.get('--page-width')).toBe('var(--page-narrow)');

    // `.page--narrow` must not re-declare the property for the whole page: the header's
    // cap is deliberately left alone (`sources/repository-new.html`).
    expect(rules.some((rule) => rule.prelude === '.page--narrow')).toBe(false);
  });
});

describe('page chrome — the scroll container', () => {
  const page = declarationsOf('.page');

  it('is the element that scrolls, so a sticky header has something to stick to', () => {
    expect(page.get('overflow-y')).toBe('auto');
    // `min-height: 0` is what lets it shrink inside the shell's `<main>` flex column;
    // without it the page grows to its content and the document scrolls instead.
    expect(page.get('min-height')).toBe('0');
    expect(page.get('flex-direction')).toBe('column');
  });

  it('clips rather than hides on the cross axis', () => {
    // `hidden` would make this a scroll container on *both* axes. `clip` still removes the
    // stray sub-pixel and backdrop overflow, without changing what scrolls.
    expect(page.get('overflow-x')).toBe('clip');
  });
});

describe('page chrome — the sticky header', () => {
  const header = declarationsOf('.page-header');

  it('sticks to the top of the page with a hairline under it', () => {
    expect(header.get('position')).toBe('sticky');
    expect(header.get('top')).toBe('0');
    expect(header.get('border-bottom')).toBe('1px solid var(--border)');
    expect(Number(header.get('z-index'))).toBeGreaterThan(0);
  });

  it('is a translucent wash of the canvas token, so every theme reaches it', () => {
    const background = header.get('background') ?? '';
    expect(background).toContain('color-mix');
    expect(background).toContain('var(--bg-canvas)');
  });

  it('blurs what passes behind it, with the -webkit- twin Safari still needs', () => {
    expect(header.get('backdrop-filter')).toContain('blur');
    expect(header.get('-webkit-backdrop-filter')).toBe(header.get('backdrop-filter'));
  });

  it('falls back to an opaque canvas where backdrop-filter is unsupported', () => {
    const fallback = rules.find(
      (rule) => rule.prelude.startsWith('@supports') && rule.body.includes('.page-header')
    );
    expect(fallback).toBeDefined();
    expect(fallback!.prelude).toContain('not');

    const nested = topLevelRules(fallback!.body).find((rule) => rule.prelude === '.page-header');
    expect(nested).toBeDefined();
    expect(parseDeclarations(nested!.body).get('background')).toBe('var(--bg-canvas)');
  });
});

describe('page chrome — why a long title cannot scroll the document', () => {
  it('wraps the row, so the action cluster drops to its own line', () => {
    expect(declarationsOf('.page-header__row').get('flex-wrap')).toBe('wrap');
  });

  it('gives the title block `min-width: 0`, overriding the automatic minimum size', () => {
    // A flex item's automatic minimum size is its content. Without this, a long unbroken
    // title holds the row open at its intrinsic width and the document scrolls sideways —
    // which is the bug every hand-rolled header had.
    const titleBlock = declarationsOf('.page-header__row > :first-child');
    expect(titleBlock.get('min-width')).toBe('0');
    expect(titleBlock.get('flex')).toContain('1 1');
  });
});

describe('page chrome — type that survives the unlayered prose rules', () => {
  it('gives the title its own font size, weight and tracking', () => {
    const title = declarationsOf('.page-header__title');
    expect(title.get('font-size')).toBe('var(--fs-3xl)');
    expect(title.get('font-weight')).toBe('600');
    expect(title.get('letter-spacing')).toBe('var(--track-tight)');
    expect(title.get('min-width')).toBe('0');
  });

  it('gives the description its own size and ink', () => {
    const description = declarationsOf('.page-header__desc');
    expect(description.get('font-size')).toBe('var(--fs-sm)');
    expect(description.get('color')).toBe('var(--fg-muted)');
  });

  it('keeps all four rules unlayered, which is what makes them win', () => {
    // Tailwind emits utilities into `@layer utilities`, and an unlayered rule beats a
    // layered one whatever the specificity. These four have to be unlayered for the same
    // reason the prose `h1` rule they are competing with is.
    for (const prelude of [
      '.page-header__title',
      '.page-header__desc',
      '.page-header',
      '.page-body',
    ]) {
      expect(rules.some((rule) => rule.prelude === prelude)).toBe(true);
    }
  });

  it('sizes the breadcrumb separator in `rem`, so the font scale reaches it', () => {
    const separator = declarationsOf('.page-header__crumbs svg');
    expect(separator.get('width')).toMatch(/rem$/);
    expect(separator.get('width')).toBe(separator.get('height'));
  });
});

describe('page chrome — quiet text a reader has to read', () => {
  /** The `light` default plus every theme block that restates the two tokens. */
  const themes: readonly (string | undefined)[] = [undefined, ...readThemeBlocks(css).keys()];

  /**
   * A token as it computes under one theme.
   *
   * @param name Custom-property name.
   * @param theme Theme id, or `undefined` for the `:root` default.
   * @returns The literal.
   */
  function under(name: string, theme: string | undefined) {
    return resolveThemeToken(name, tokens, theme ? readThemeBlocks(css).get(theme) : undefined);
  }

  it('reads the light default and every theme block, so a new theme cannot slip past', () => {
    expect(themes.length).toBeGreaterThanOrEqual(8);
  });

  it('clears WCAG AA for the breadcrumb ink against the page canvas, in every theme', () => {
    // The breadcrumb is `--fg-muted` rather than the `--fg-subtle` `hive.css` §7 paints it:
    // at 12 px, `--fg-subtle` measures ~3.1:1 on the light canvas, and a trail is meant to
    // be read. HIVE-3.3 made the same call for the rail's quiet text.
    for (const theme of themes) {
      const ratio = contrastRatio(
        hexToRgb(under('--color-fg-muted', theme)),
        hexToRgb(under('--color-canvas', theme))
      );
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
    }
  });

  it('keeps `--fg-subtle` out of the header’s own text', () => {
    // A guard on the component rather than on the stylesheet: the ink is a Tailwind class,
    // so the stylesheet cannot see the regression this rules out.
    const source = readFileSync(
      join(__dirname, '..', 'src', 'app', 'components', 'shell', 'PageHeader.tsx'),
      'utf8'
    );
    const classNames = [...source.matchAll(/className="([^"]*)"/g)].map((match) => match[1]);
    expect(classNames.some((value) => value.includes('text-fg-subtle'))).toBe(false);
  });
});
