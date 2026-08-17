/**
 * The stylesheet half of Help & docs (HIVE-4.9, #5303).
 *
 * `help-page.test.tsx` renders the page and pins its markup; it cannot pin anything that makes
 * the page *look* right, because jsdom compiles no stylesheet. So this suite reads `globals.css`
 * the way `linked-accounts-css.test.ts` does, and pins what the components lean on:
 *
 *   1. **The skin is tokens only.** The page is new rather than a redesign, so nothing here
 *      replaces a hard-coded colour — the rule it has to keep is that it never introduces one.
 *      A single named hue would freeze the page on one of the nine palettes.
 *   2. **Nothing can widen the page.** A tenant uuid, a guide summary and a shortcut label are
 *      all longer than their column, so every track has a zero minimum and every value that has
 *      no break opportunity of its own is allowed to break anywhere.
 *   3. **A card's hue is an identity, not a colour.** Every tone in the shared vocabulary that
 *      has a soft/fg pair is mapped, and the fallback is declared on the card itself so an
 *      unmapped tone still paints.
 *   4. **Nothing is frozen in pixels**, so the page follows both densities and all six font
 *      scales.
 *   5. **The section outranks the base type rules**, which it has to sit after to do.
 */

import {
  findUnfencedHex,
  parseDeclarations,
  readGlobalsCss,
  topLevelRules,
  type CssRule,
} from './helpers/design-tokens';
import { STATUS_TONES } from '@/app/components/ui/statusVocabulary';

const css = readGlobalsCss();
const rules = topLevelRules(css);

/** The stylesheet with its comments removed, for the assertions that match raw source. */
const STRIPPED = css.replace(/\/\*[\s\S]*?\*\//g, '');

/** The line the unlayered `h2` / `p` base rules are declared on, found rather than assumed. */
const BASE_TYPE_RULE_LINE = (() => {
  const rule = rules.find((candidate) => candidate.prelude === 'h2');
  if (!rule) throw new Error('globals.css no longer declares a bare `h2` rule');
  return rule.line;
})();

/** The tones a card can carry — every hue in the vocabulary that has a soft/fg pair. */
const TONED = STATUS_TONES.filter((tone) => tone !== 'outline' && tone !== 'ink');

/**
 * Every rule this ticket added, by prelude.
 *
 * Listed rather than pattern-matched so a rule that is *renamed* fails here instead of silently
 * dropping out of the token-only walk below.
 */
const HELP_PRELUDES = [
  ...TONED.map((tone) => `.help-card[data-tone="${tone}"]`),
  '.help-search',
  '.help-search__field',
  '.help-search__icon',
  '.help-search__input',
  '.help-search__status',
  '.help-results',
  '.help-result',
  '.help-result:hover',
  '.help-result__body',
  '.help-result__title',
  '.help-result:hover .help-result__title',
  '.help-result__out',
  '.help-result__sub',
  '.help-result__section',
  '.help-grid',
  '.help-card',
  '.help-card--soon',
  '.help-tile',
  '.help-card__title',
  '.help-card:hover .help-card__title',
  '.help-card--soon:hover .help-card__title',
  '.help-card__badge',
  '.help-card__out',
  '.help-card__desc',
  '.help-card__actions',
  '.help-card__link',
  '.help-support',
  '.help-support__row',
  '.help-support__label',
  '.help-support__value',
  '.help-glance',
  '.help-glance__header',
  '.help-glance__title',
  '.help-glance__grid',
  '.help-glance__row',
  '.help-glance__label',
  '.help-glance__keys',
] as const;

/**
 * Look one of this ticket's rules up.
 *
 * @param prelude The rule's selector, exactly as {@link HELP_PRELUDES} lists it.
 * @returns The rule.
 */
function helpRule(prelude: string): CssRule {
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
  const value = parseDeclarations(helpRule(prelude).body).get(property);
  if (value === undefined) throw new Error(`\`${prelude}\` declares no \`${property}\``);
  return value;
}

/**
 * Every top-level `@media (max-width: …)` block written at one width.
 *
 * @param width The width, exactly as the stylesheet spells it (`68.75rem`).
 * @returns The bodies of the matching blocks, in source order.
 */
function mediaBlocks(width: string): string[] {
  const pattern = new RegExp(`@media \\(max-width: ${width.replace('.', '\\.')}\\) \\{([\\s\\S]*?)\\n\\}`, 'g');
  return [...STRIPPED.matchAll(pattern)].map((match) => match[1]);
}

/* -------------------------------------------------------------------------
   1. The section exists, and names no colour
   ------------------------------------------------------------------------- */

describe('the help section of globals.css', () => {
  it('declares every rule the components reference', () => {
    const missing = HELP_PRELUDES.filter(
      (prelude) => !rules.some((rule) => rule.prelude === prelude)
    );
    expect(missing).toEqual([]);
  });

  it('declares each of them exactly once', () => {
    // A second rule with the same prelude is how one of a pair silently stops applying.
    const duplicated = HELP_PRELUDES.filter(
      (prelude) => rules.filter((rule) => rule.prelude === prelude).length > 1
    );
    expect(duplicated).toEqual([]);
  });

  it('sits after the unlayered h2 and p base rules it has to outrank', () => {
    for (const prelude of HELP_PRELUDES) {
      expect(helpRule(prelude).line).toBeGreaterThan(BASE_TYPE_RULE_LINE);
    }
  });

  it('names no colour — every hue resolves through the token layer', () => {
    for (const prelude of HELP_PRELUDES) {
      for (const [property, value] of parseDeclarations(helpRule(prelude).body)) {
        expect({ prelude, property, value }).toMatchObject({ prelude, property });
        expect(value).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        expect(value).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|oklch)\(/);
      }
    }
  });

  it('leaves the hex fence of the stylesheet intact', () => {
    expect(findUnfencedHex(css).map((entry) => `${entry.line}: ${entry.text}`)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------
   2. A card's hue is an identity
   ------------------------------------------------------------------------- */

describe('the card tones', () => {
  it('maps every tone in the shared vocabulary that has a soft/fg pair', () => {
    for (const tone of TONED) {
      const body = helpRule(`.help-card[data-tone="${tone}"]`).body;
      expect(parseDeclarations(body).get('--help-tone-soft')).toBe(`var(--${tone}-soft)`);
      expect(parseDeclarations(body).get('--help-tone-fg')).toBe(`var(--${tone}-fg)`);
    }
  });

  it('declares a fallback pair on the card, so an unmapped tone still paints', () => {
    // `outline` and `ink` carry no hue and have no soft partner: a card that named one — or
    // named nothing — would otherwise draw a tile with two unset custom properties.
    expect(declaration('.help-card', '--help-tone-soft')).toBe('var(--bg-subtle)');
    expect(declaration('.help-card', '--help-tone-fg')).toBe('var(--fg-muted)');
  });

  it('paints the tile from those two variables and nothing else', () => {
    expect(declaration('.help-tile', 'background')).toBe('var(--help-tone-soft)');
    expect(declaration('.help-tile', 'color')).toBe('var(--help-tone-fg)');
  });

  it('cuts the tile with the shared hexagon rather than a second clip path', () => {
    expect(declaration('.help-tile', 'clip-path')).toBe('var(--hex-clip)');
  });
});

/* -------------------------------------------------------------------------
   3. Nothing can widen the page
   ------------------------------------------------------------------------- */

describe('the page cannot scroll sideways', () => {
  it('caps every grid track at zero, not at its content', () => {
    // A grid item's automatic minimum size is its content: plain `1fr` would let an unbroken
    // word hold the track open past the viewport.
    expect(declaration('.help-grid', 'grid-template-columns')).toBe('repeat(3, minmax(0, 1fr))');
    expect(declaration('.help-glance__grid', 'grid-template-columns')).toBe(
      'repeat(4, minmax(0, 1fr))'
    );
  });

  it('gives every flex body a zero minimum, so a long value is clipped rather than pushed', () => {
    for (const prelude of [
      '.help-result__body',
      '.help-support__row',
      '.help-support__value',
      '.help-glance__row',
      '.help-glance__label',
    ]) {
      expect(declaration(prelude, 'min-width')).toBe('0');
    }
  });

  it('lets an identifier with no break opportunity break anywhere', () => {
    // A tenant uuid has none of its own, and the card is one column of a grid.
    expect(declaration('.help-support__value', 'overflow-wrap')).toBe('anywhere');
  });

  it('clips a long shortcut label instead of widening its row', () => {
    expect(declaration('.help-glance__label', 'overflow')).toBe('hidden');
    expect(declaration('.help-glance__label', 'text-overflow')).toBe('ellipsis');
  });

  it('reflows at the two widths the rest of the app already reflows at', () => {
    // One shape change shared with Home, the launcher and the account pages — not four of
    // this page's own.
    // Both widths are already in the stylesheet for other surfaces, so the block has to be
    // found by what it contains rather than by being the first at that width.
    const wide = mediaBlocks('68.75rem').find((block) => block.includes('.help-grid'));
    expect(wide).toContain('.help-result__section');
    expect(wide).toContain('display: none;');
    expect(wide).toContain('repeat(2, minmax(0, 1fr))');

    const narrow = mediaBlocks('48rem').find((block) => block.includes('.help-grid'));
    expect(narrow).toContain('.help-glance__grid');
    expect(narrow).toContain('minmax(0, 1fr)');
  });
});

/* -------------------------------------------------------------------------
   4. Nothing is frozen in pixels
   ------------------------------------------------------------------------- */

describe('the density and font-size preferences reach every part of the page', () => {
  it('states no font size or control metric in px', () => {
    // `1px` is exempt and only `1px`: a hairline is one device pixel by definition and must
    // not grow with the font scale.
    for (const prelude of HELP_PRELUDES) {
      for (const [property, value] of parseDeclarations(helpRule(prelude).body)) {
        if (!['font-size', 'min-height', 'height', 'width', 'line-height'].includes(property)) {
          continue;
        }
        const offending = [...value.matchAll(/\b(\d+(?:\.\d+)?)px\b/g)]
          .filter((match) => match[1] !== '1')
          .map((match) => match[0]);
        expect({ prelude, property, offending }).toEqual({ prelude, property, offending: [] });
      }
    }
  });

  it('states no spacing in px either, so the font-size preference reaches every gap', () => {
    for (const prelude of HELP_PRELUDES) {
      for (const [property, value] of parseDeclarations(helpRule(prelude).body)) {
        if (!/^(?:padding|margin|gap|row-gap|column-gap|inset)/.test(property)) continue;
        const offending = [...value.matchAll(/\b\d+(?:\.\d+)?px\b/g)].map((match) => match[0]);
        expect({ prelude, property, offending }).toEqual({ prelude, property, offending: [] });
      }
    }
  });

  it('takes every gap and pad from the density-aware scale', () => {
    expect(declaration('.help-card', 'padding')).toBe('var(--card-pad)');
    expect(declaration('.help-glance__grid', 'padding')).toBe('var(--card-pad)');
    for (const [prelude, property] of [
      ['.help-search', 'gap'],
      ['.help-results', 'gap'],
      ['.help-result', 'padding'],
      ['.help-grid', 'gap'],
      ['.help-card', 'gap'],
      ['.help-support', 'padding'],
      ['.help-glance__header', 'padding'],
      ['.help-glance__row', 'gap'],
    ] as const) {
      expect(declaration(prelude, property)).toMatch(/var\(--(?:space-|card-pad)/);
    }
  });

  it('sizes the search field from the control scale, not from a number', () => {
    expect(declaration('.help-search__input', 'height')).toBe('var(--control-h-lg)');
    // The glyph's inset and the field's leading pad are the same two tokens, so the icon stays
    // inside the field at every font scale rather than drifting over the placeholder.
    expect(declaration('.help-search__icon', 'inset-inline-start')).toBe('var(--space-3)');
    expect(declaration('.help-search__input', 'padding-inline-start')).toBe(
      'calc(var(--space-3) + var(--icon-dense) + var(--space-2))'
    );
  });

  it('takes every type size from the scale', () => {
    for (const [prelude, expected] of [
      ['.help-search__input', 'var(--fs-sm)'],
      ['.help-search__status', 'var(--fs-xs)'],
      ['.help-result__title', 'var(--fs-sm)'],
      ['.help-result__sub', 'var(--fs-xs)'],
      ['.help-result__section', 'var(--fs-2xs)'],
      ['.help-card__title', 'var(--fs-sm)'],
      ['.help-card__desc', 'var(--fs-xs)'],
      ['.help-support__label', 'var(--fs-2xs)'],
      ['.help-support__value', 'var(--fs-xs)'],
      ['.help-glance__title', 'var(--fs-sm)'],
      ['.help-glance__label', 'var(--fs-xs)'],
    ] as const) {
      expect(declaration(prelude, 'font-size')).toBe(expected);
    }
  });
});

/* -------------------------------------------------------------------------
   5. The quiet lines, and the two surfaces they sit on
   ------------------------------------------------------------------------- */

describe('quiet text', () => {
  it('is --fg-muted everywhere, never the --fg-subtle the mockup paints', () => {
    // `--fg-subtle` measures 3.1:1 against the canvas at these sizes — under the 4.5:1 WCAG AA
    // asks of normal text. HIVE-3.5, 4.1, 4.5, 4.7 and 4.8 made the same call.
    for (const prelude of HELP_PRELUDES) {
      const color = parseDeclarations(helpRule(prelude).body).get('color');
      expect({ prelude, color }).not.toMatchObject({ color: 'var(--fg-subtle)' });
    }
  });

  it('sets the support well on the inset surface the account tiles use', () => {
    // `--bg-inset` rather than `--bg-subtle`, which is what keeps muted ink on it clear of AA
    // in Solarized as well as in the light palette.
    expect(declaration('.help-support', 'background')).toBe('var(--bg-inset)');
  });

  it('fades an unshipped card without recolouring it', () => {
    // Opacity, not a grey: the tone and the ink stay whatever the theme made them.
    expect(declaration('.help-card--soon', 'opacity')).toBe('0.6');
    expect(parseDeclarations(helpRule('.help-card--soon').body).get('color')).toBeUndefined();
  });
});
