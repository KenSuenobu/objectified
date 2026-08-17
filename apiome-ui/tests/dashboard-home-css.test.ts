/**
 * The stylesheet half of Home (HIVE-4.6, #5300).
 *
 * `tests/dashboard-home.test.tsx` renders the page and pins its markup; it cannot pin anything
 * that makes the page *look* right, because jsdom compiles no stylesheet — and this ticket is
 * largely the look. So this suite reads `globals.css` the way `launcher-css.test.ts` does, and
 * pins what the components lean on:
 *
 *   1. **The skin is tokens only.** What Home replaced named colours outright — twelve icon hues
 *      (`text-blue-600 dark:text-blue-400` and five more pairs), four activity tints
 *      (`bg-purple-100 dark:bg-purple-900/30`…), a `bg-gray-50 dark:bg-gray-900` header bar and a
 *      `from-indigo-100 to-purple-100` empty-state gradient. Every one of those froze on one
 *      palette. Nothing below may name a colour.
 *   2. **A tone is a tone.** `data-tone` resolves to three custom properties, so an activity kind
 *      or an attention row follows all nine themes, and a tone this app does not know lands on the
 *      neutral default rather than on nothing.
 *   3. **No horizontal document scroll at ≥1280 px.** The body grid's main track is
 *      `minmax(0, 1fr)` and every text cell can break — the two rules that stop a long project
 *      name or version id from holding a track open past the viewport.
 *   4. **The right half is never empty.** The two-column grid collapses at one breakpoint, and
 *      the aside's own panels are full-width in that state.
 *   5. **Headings are classes, not utilities.** The unlayered `h2` / `p` rules near line 2490
 *      outrank every `@layer utilities` declaration, so each heading and quiet line Home draws has
 *      to be sized by a rule of its own — and those rules have to sit *after* the base ones.
 *   6. **Quiet text clears WCAG AA.** `--fg-muted`, not the mockup's `--fg-subtle`, which measures
 *      3.1:1 on the canvas at these sizes — the same deviation HIVE-3.5, HIVE-4.1 and HIVE-4.5
 *      made and documented.
 */

import {
  contrastRatio,
  findUnfencedHex,
  hexToRgb,
  parseDeclarations,
  readGlobalsCss,
  readThemeBlocks,
  readTokenLayer,
  resolveThemeToken,
  resolveToken,
  topLevelRules,
  type CssRule,
} from './helpers/design-tokens';
import { STATUS_TONES } from '../src/app/components/ui/statusVocabulary';

const css = readGlobalsCss();
const rules = topLevelRules(css);
const tokens = readTokenLayer(css);

/** Every `html[data-theme]` block, so a contrast claim can be made about all nine appearances. */
const themes = [...readThemeBlocks(css).entries()];

/** WCAG AA for normal-size text — the row subtitles, the meta lines and the axis are 11–12 px. */
const WCAG_AA_NORMAL_TEXT_MIN = 4.5;

/** The line the unlayered `h2` / `p` base rules are declared on, found rather than hard-coded. */
const BASE_TYPE_RULE_LINE = (() => {
  const rule = rules.find((candidate) => candidate.prelude === 'h2');
  if (!rule) throw new Error('globals.css no longer declares a bare `h2` rule');
  return rule.line;
})();

/**
 * Every rule this ticket added, by prelude.
 *
 * Listed rather than pattern-matched so a rule that is *renamed* fails here instead of silently
 * dropping out of the "section is token-only" walk below.
 */
const HOME_PRELUDES = [
  '.home-tone',
  '.home-grid',
  '.home-grid__main, .home-grid__aside',
  '.home-section',
  '.home-section__title',
  '.home-section__title h2',
  '.home-section__link',
  '.home-section__link:hover',
  '.home-section__link > svg',
  '.home-continue',
  '.home-continue__card',
  '.home-continue__top',
  '.home-continue__tenant',
  '.home-continue__name',
  '.home-continue__meta',
  '.home-continue__foot',
  '.home-continue__quality',
  '.home-continue__quality-label, .home-continue__touched',
  '.home-panel',
  '.home-panel__header',
  '.home-panel__title',
  '.home-panel__title h2',
  '.home-panel__title > svg',
  '.home-panel__note',
  '.home-panel__count',
  '.home-panel__footer',
  '.home-rows',
  '.home-row',
  '.home-rows > :not(:first-child) > .home-row, .home-rows > .home-row:not(:first-child)',
  '.home-row--link',
  '.home-row--link:hover',
  '.home-row__body',
  '.home-row__title',
  '.home-row__sub',
  '.home-row__badge',
  '.home-row__kind, .home-row__go',
  '.home-row__kind',
  '.home-tile',
  '.home-tile > svg',
  '.home-dot',
  '.home-menu',
  '.home-menu__item',
  '.home-menu__item:hover',
  '.home-menu__item > svg',
  '.home-menu__label',
  '.home-pulse',
  '.home-pulse__head',
  '.home-pulse__head h2',
  '.home-pulse__span',
  '.home-bars',
  '.home-bars__bar',
  '.home-bars__bar:not([data-count="0"])',
  '.home-bars__bar[data-count="0"]',
  '.home-pulse__axis',
  '.home-pulse__total',
  '.home-checklist',
  '.home-checklist__head',
  '.home-checklist__lede',
  '.home-checklist__mark',
  '.home-checklist__mark > svg',
  '.home-checklist__text',
  '.home-checklist__titlerow',
  '.home-checklist__titlerow h2',
  '.home-checklist__desc',
  '.home-checklist__aside',
  '.home-hex',
  '.home-hex__cell',
  '.home-hex__cell[data-on="true"]',
  '.home-steps',
  '.home-step',
  '.home-step--done',
  '.home-step--done .home-step__label',
  '.home-step--next',
  '.home-step__title',
  '.home-step__mark',
  '.home-step--done .home-step__mark',
  '.home-step--next .home-step__mark',
  '.home-step__label',
  '.home-step__badge',
  '.home-step__hint',
  '.home-step__go',
] as const;

/** The tones `.home-tone[data-tone]` has to answer. */
const HOME_TONES = ['accent', 'honey', 'ok', 'warn', 'danger', 'violet', 'orange', 'rose'] as const;

/**
 * Look one of this ticket's rules up.
 *
 * @param prelude The rule's selector, exactly as {@link HOME_PRELUDES} lists it.
 * @returns The rule.
 */
function homeRule(prelude: string): CssRule {
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
  const value = parseDeclarations(homeRule(prelude).body).get(property);
  if (value === undefined) throw new Error(`\`${prelude}\` declares no \`${property}\``);
  return value;
}

/* -------------------------------------------------------------------------
   1. The section exists, and names no colour
   ------------------------------------------------------------------------- */

describe('the Home section of globals.css', () => {
  it('declares every rule the components reference', () => {
    const missing = HOME_PRELUDES.filter(
      (prelude) => !rules.some((rule) => rule.prelude === prelude),
    );
    expect(missing).toEqual([]);
  });

  it('sits after the unlayered h2 and p base rules it has to outrank', () => {
    for (const prelude of HOME_PRELUDES) {
      expect(homeRule(prelude).line).toBeGreaterThan(BASE_TYPE_RULE_LINE);
    }
  });

  it('names no colour — every hue resolves through the token layer', () => {
    const values = HOME_PRELUDES.flatMap((prelude) => [
      ...parseDeclarations(homeRule(prelude).body).values(),
    ]);
    for (const value of values) {
      expect(value).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(value).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|oklch)\(/);
    }
  });

  it('leaves the hex fence of the stylesheet intact', () => {
    // The whole file, not just this section: a new literal anywhere is this suite's business
    // because HIVE-1.1 made the fence the rule for the stylesheet as a whole.
    const offenders = findUnfencedHex(css).map((entry) => `${entry.line}: ${entry.text}`);
    expect(offenders).toEqual([]);
  });

  it('states no font size or control height in px', () => {
    // `1px` is exempt and only `1px`: a hairline is one device pixel by definition and must not
    // grow with the font scale, which is why `--border` widths and `min-height: 1px` on a bar
    // that has collapsed to nothing are spelled that way throughout the stylesheet.
    for (const prelude of HOME_PRELUDES) {
      for (const [property, value] of parseDeclarations(homeRule(prelude).body)) {
        if (!['font-size', 'min-height', 'height', 'width', 'line-height'].includes(property)) continue;
        const offending = [...value.matchAll(/\b(\d+(?:\.\d+)?)px\b/g)].filter(
          (match) => match[1] !== '1',
        );
        expect({ prelude, property, offending: offending.map((match) => match[0]) }).toEqual({
          prelude,
          property,
          offending: [],
        });
      }
    }
  });
});

/* -------------------------------------------------------------------------
   2. Tones
   ------------------------------------------------------------------------- */

describe('.home-tone', () => {
  it('defaults to neutral, so an unknown tone still has a hue', () => {
    const base = parseDeclarations(homeRule('.home-tone').body);
    expect(base.get('--home-tone')).toBe('var(--neutral)');
    expect(base.get('--home-tone-soft')).toBe('var(--neutral-soft)');
    expect(base.get('--home-tone-fg')).toBe('var(--neutral-fg)');
  });

  it('resolves each tone to the three properties the section paints from', () => {
    for (const tone of HOME_TONES) {
      const rule = homeRule(`.home-tone[data-tone="${tone}"]`);
      const declarations = parseDeclarations(rule.body);
      expect(declarations.get('--home-tone')).toBe(`var(--${tone})`);
      expect(declarations.get('--home-tone-soft')).toBe(`var(--${tone}-soft)`);
      expect(declarations.get('--home-tone-fg')).toBe(`var(--${tone}-fg)`);
    }
  });

  it('only names tones the shared status vocabulary knows', () => {
    for (const tone of HOME_TONES) {
      expect(STATUS_TONES).toContain(tone);
    }
  });

  it('paints the tile and the dot from those properties rather than from a hue', () => {
    expect(declaration('.home-tile', 'background')).toBe('var(--home-tone-soft)');
    expect(declaration('.home-tile', 'color')).toBe('var(--home-tone-fg)');
    expect(declaration('.home-dot', 'background')).toBe('var(--home-tone)');
  });

  it('draws the tile and the checklist mark as the brand hexagon', () => {
    expect(declaration('.home-tile', 'clip-path')).toBe('var(--hex-clip)');
    expect(declaration('.home-checklist__mark', 'clip-path')).toBe('var(--hex-clip)');
    expect(declaration('.home-hex__cell', 'clip-path')).toBe('var(--hex-clip)');
  });
});

/* -------------------------------------------------------------------------
   3 & 4. The grid: no sideways scroll, and no empty half
   ------------------------------------------------------------------------- */

describe('the body grid', () => {
  it('caps the main track at zero, so long content cannot widen the page', () => {
    // A grid item's automatic minimum size is its content: plain `1fr` would let an unbroken
    // project name hold the track open past the viewport and scroll the document sideways.
    expect(declaration('.home-grid', 'grid-template-columns')).toBe('minmax(0, 1fr) 21.25rem');
  });

  it('gives both columns a zero min-width of their own', () => {
    expect(declaration('.home-grid__main, .home-grid__aside', 'min-width')).toBe('0');
  });

  it('lets every text cell break rather than push the page wide', () => {
    for (const prelude of [
      '.home-continue__name',
      '.home-continue__meta',
      '.home-row__title',
      '.home-row__sub',
      '.home-step__label',
    ]) {
      expect(declaration(prelude, 'overflow-wrap')).toBe('anywhere');
    }
  });

  it('does not stretch a short aside to the height of the column beside it', () => {
    expect(declaration('.home-grid', 'align-items')).toBe('start');
  });

  it('collapses to one column at exactly one breakpoint, the one the rest of the page uses', () => {
    const collapse = /@media \(max-width: 68\.75rem\) \{\s*\.home-grid \{\s*grid-template-columns: minmax\(0, 1fr\);/;
    expect(collapse.test(css.replace(/\/\*[\s\S]*?\*\//g, ''))).toBe(true);
  });

  it('reflows the continue cards at the same two widths and no others', () => {
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(stripped).toMatch(/@media \(max-width: 68\.75rem\) \{\s*\.home-continue \{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
    expect(stripped).toMatch(/@media \(max-width: 40rem\) \{\s*\.home-continue \{\s*grid-template-columns: minmax\(0, 1fr\);/);
  });

  it('gives the continue grid a fixed three-column track rather than auto-fit', () => {
    // `auto-fit` would stretch a lone card across the whole column, which reads as a banner
    // rather than as one of three.
    expect(declaration('.home-continue', 'grid-template-columns')).toBe('repeat(3, minmax(0, 1fr))');
  });
});

/* -------------------------------------------------------------------------
   5. Headings and rows are sized by rules of their own
   ------------------------------------------------------------------------- */

describe('type and density', () => {
  it('sizes each heading Home draws, since the base h2 rule would otherwise win', () => {
    for (const prelude of [
      '.home-section__title h2',
      '.home-panel__title h2',
      '.home-pulse__head h2',
      '.home-checklist__titlerow h2',
    ]) {
      expect(declaration(prelude, 'font-size')).toMatch(/^var\(--fs-/);
      expect(declaration(prelude, 'font-weight')).toBe('600');
    }
  });

  it('colours each quiet line Home draws, since the base p rule would otherwise win', () => {
    for (const prelude of ['.home-row__sub', '.home-checklist__desc', '.home-step__hint', '.home-pulse__total']) {
      expect(declaration(prelude, 'color')).toMatch(/^var\(--fg/);
    }
  });

  it('takes its row height from the density metric, not from a pixel', () => {
    expect(declaration('.home-row', 'min-height')).toBe('var(--row-h)');
    expect(declaration('.home-menu__item', 'min-height')).toBe('var(--control-h)');
  });

  it('takes its padding from the density-aware card metric', () => {
    for (const prelude of ['.home-continue__card', '.home-pulse', '.home-checklist']) {
      expect(declaration(prelude, 'padding')).toBe('var(--card-pad)');
    }
    expect(declaration('.home-row', 'padding')).toContain('var(--card-pad)');
  });

  it('sizes every glyph from an icon token', () => {
    for (const prelude of ['.home-panel__title > svg', '.home-menu__item > svg', '.home-step__mark', '.home-row__kind, .home-row__go']) {
      expect(declaration(prelude, 'width')).toBe('var(--icon-dense)');
      expect(declaration(prelude, 'height')).toBe('var(--icon-dense)');
    }
  });

  it('draws the row hairline once per row rather than as a separator element', () => {
    const value = declaration(
      '.home-rows > :not(:first-child) > .home-row, .home-rows > .home-row:not(:first-child)',
      'border-block-start',
    );
    expect(value).toBe('1px solid var(--border)');
  });
});

/* -------------------------------------------------------------------------
   6. Contrast
   ------------------------------------------------------------------------- */

describe('quiet text clears WCAG AA', () => {
  /** The canvas and the surface, the two backdrops Home's quiet text lands on. */
  const backdrops = ['--bg-canvas', '--bg-surface'] as const;

  it('uses --fg-muted for every quiet line, and it clears 4.5:1 on both surfaces', () => {
    const muted = hexToRgb(resolveToken('--fg-muted', tokens));
    for (const backdrop of backdrops) {
      expect(contrastRatio(muted, hexToRgb(resolveToken(backdrop, tokens)))).toBeGreaterThanOrEqual(
        WCAG_AA_NORMAL_TEXT_MIN,
      );
    }
  });

  it('never reaches for --fg-subtle, which fails AA at these sizes', () => {
    // The mockup's `.t-subtle` is `--fg-subtle`; it measures ~3.1:1 on the canvas, which is a
    // serious axe finding for an 11–12 px line. HIVE-3.5, 4.1 and 4.5 made the same swap.
    const subtle = hexToRgb(resolveToken('--fg-subtle', tokens));
    expect(contrastRatio(subtle, hexToRgb(resolveToken('--bg-canvas', tokens)))).toBeLessThan(
      WCAG_AA_NORMAL_TEXT_MIN,
    );

    for (const prelude of HOME_PRELUDES) {
      const color = parseDeclarations(homeRule(prelude).body).get('color');
      if (color) expect(color).not.toBe('var(--fg-subtle)');
    }
  });

  it('never lands muted ink on --bg-subtle, in any theme', () => {
    // Solarized measures `--fg-muted` on `--bg-subtle` at 4.35:1, just under AA. Home therefore
    // uses `--bg-inset` for both its row hover and its completed step, whose worst theme is
    // 5.0:1. The walk below proves the claim; this proves nothing reached for the other token.
    for (const prelude of ['.home-step--done', '.home-row--link:hover', '.home-menu__item:hover']) {
      expect(declaration(prelude, 'background')).not.toBe('var(--bg-subtle)');
    }
  });

  it('holds every text-on-surface pair Home draws at 4.5:1 in all nine themes', () => {
    /** The ink and the fill it lands on, for every pairing Home actually renders. */
    const pairs: readonly (readonly [string, string])[] = [
      ['--fg-muted', '--bg-canvas'],
      ['--fg-muted', '--bg-surface'],
      ['--fg-muted', '--bg-inset'],
      ['--fg', '--bg-inset'],
      ['--accent-fg', '--bg-canvas'],
      ['--accent-fg', '--bg-surface'],
    ];

    const failures: string[] = [];
    for (const [theme, block] of [['light', undefined] as const, ...themes] as const) {
      for (const [ink, fill] of pairs) {
        const ratio = contrastRatio(
          hexToRgb(resolveThemeToken(ink, tokens, block)),
          hexToRgb(resolveThemeToken(fill, tokens, block)),
        );
        if (ratio < WCAG_AA_NORMAL_TEXT_MIN) {
          failures.push(`${theme}: ${ink} on ${fill} = ${ratio.toFixed(2)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('uses --accent-fg for its one link, not the accent fill', () => {
    // `--accent` as 13 px text on the canvas is 3.8:1 in the light theme.
    expect(declaration('.home-section__link', 'color')).toBe('var(--accent-fg)');
  });

  it('keeps the honey ornament ink readable on the honey it sits on', () => {
    // `.home-checklist__mark` is `--honey-ink` on `--honey`; DESIGN.md §2 allows honey here, and
    // §9 still wants the glyph legible on it.
    expect(declaration('.home-checklist__mark', 'background')).toBe('var(--honey)');
    expect(declaration('.home-checklist__mark', 'color')).toBe('var(--honey-ink)');
    const ratio = contrastRatio(
      hexToRgb(resolveToken('--honey-ink', tokens)),
      hexToRgb(resolveToken('--honey', tokens)),
    );
    expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
  });
});

/* -------------------------------------------------------------------------
   The pulse
   ------------------------------------------------------------------------- */

describe('the publishing pulse', () => {
  it('grows its bars upward from a baseline', () => {
    expect(declaration('.home-bars', 'align-items')).toBe('flex-end');
    expect(declaration('.home-bars', 'border-block-end')).toBe('1px solid var(--border)');
  });

  it('keeps an empty week visibly empty and a busy week tinted', () => {
    expect(declaration('.home-bars__bar[data-count="0"]', 'background')).toBe('var(--bg-inset)');
    expect(declaration('.home-bars__bar:not([data-count="0"])', 'background')).toContain('var(--accent)');
  });

  it('lets a bar shrink to nothing but never to negative width', () => {
    expect(declaration('.home-bars__bar', 'flex')).toBe('1 1 0');
    expect(declaration('.home-bars__bar', 'min-width')).toBe('0');
  });
});

/* -------------------------------------------------------------------------
   The checklist
   ------------------------------------------------------------------------- */

describe('the first-run checklist', () => {
  it('fits its steps to however many there are, rather than to five', () => {
    // Three steps when no Designer URL is configured; a fixed five-column track would leave two
    // empty cells in that deployment.
    expect(declaration('.home-steps', 'grid-template-columns')).toBe('repeat(auto-fit, minmax(11rem, 1fr))');
  });

  it('quiets a done step by recolouring its surface, never with opacity', () => {
    // `opacity` is the obvious way to quiet a card and the wrong one: it composites the hint's
    // `--fg-muted` towards the backdrop, and at 0.75 the 12 px line measures 3.6:1 — a serious
    // axe finding that `e2e/hive-home.spec.ts` caught in the light theme.
    expect(parseDeclarations(homeRule('.home-step--done').body).has('opacity')).toBe(false);
    expect(declaration('.home-step--done', 'background')).toBe('var(--bg-inset)');
    expect(declaration('.home-step--done .home-step__label', 'text-decoration')).toBe('line-through');
  });

  it('rings the next step in honey rather than filling it', () => {
    // The card is already a honey wash; a second fill would lose the step in it.
    expect(declaration('.home-step--next', 'box-shadow')).toContain('var(--honey)');
  });

  it('marks a done step with the ok role and the next one with honey ink', () => {
    expect(declaration('.home-step--done .home-step__mark', 'color')).toBe('var(--ok)');
    expect(declaration('.home-step--next .home-step__mark', 'color')).toBe('var(--honey-fg)');
  });

  it('fills only the completed hex cells', () => {
    expect(declaration('.home-hex__cell[data-on="true"]', 'background')).toBe('var(--honey)');
    expect(declaration('.home-hex__cell', 'background')).toContain('color-mix');
  });
});
