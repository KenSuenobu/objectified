/**
 * The stylesheet half of the account surfaces (HIVE-4.7, #5301).
 *
 * `profile-hive-redesign.test.tsx` renders the page and pins its markup; it cannot pin anything
 * that makes the page *look* right, because jsdom compiles no stylesheet — and this ticket is
 * largely the look. So this suite reads `globals.css` the way `dashboard-home-css.test.ts` does,
 * and pins what the components lean on:
 *
 *   1. **The skin is tokens only.** What Profile replaced named sixteen colours outright — an
 *      `indigo → violet → purple` hero band, an `indigo → violet` avatar under a
 *      `ring-white dark:ring-gray-800`, five card glyphs in five hues, `bg-gray-50/70
 *      dark:bg-gray-900/40` tiles and `border-gray-200 dark:border-gray-700` boxes. Every one of
 *      those froze on one palette. Nothing below may name a colour.
 *   2. **Long values cannot widen the page.** The body grid's main track is `minmax(0, 1fr)`,
 *      every column has a zero min-width of its own, and each tile clips its value to one line —
 *      the rules behind "long email addresses and tenant ids truncate without breaking layout".
 *   3. **Headings and quiet lines are sized and coloured by rules of their own.** The unlayered
 *      `h2` / `p` rules near line 2490 outrank every `@layer utilities` declaration, so a heading
 *      styled with Tailwind utilities alone would silently render at the wrong size, and a `<p>`
 *      would silently take the base muted ink.
 *   4. **Quiet text clears WCAG AA in all nine themes**, which is why the info tiles and the
 *      sign-in-methods well are `--bg-inset` rather than the mockup's `--bg-subtle`.
 *   5. **Nothing is frozen in pixels**, so the page follows both densities and all six font
 *      scales.
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

const css = readGlobalsCss();
const rules = topLevelRules(css);
const tokens = readTokenLayer(css);

/** Every `html[data-theme]` block, so a contrast claim can be made about all nine appearances. */
const themes = [...readThemeBlocks(css).entries()];

/** WCAG AA for normal-size text — the tile labels, hints and meta lines are 11–13 px. */
const WCAG_AA_NORMAL_TEXT_MIN = 4.5;

/** The stylesheet with its comments removed, for the assertions that match raw source. */
const STRIPPED = css.replace(/\/\*[\s\S]*?\*\//g, '');

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
const ACCOUNT_PRELUDES = [
  '.acct-grid',
  '.acct-grid__main, .acct-grid__aside',
  '.acct-card__header',
  '.acct-card__title',
  '.acct-card__title > svg',
  '.acct-card__note',
  '.acct-card__footer',
  '.acct-identity',
  '.acct-identity__band',
  '.acct-identity__row',
  '.acct-identity__avatar',
  '.acct-identity__body',
  '.acct-identity__name',
  '.acct-identity__meta',
  '.acct-identity__email',
  '.acct-identity__badges',
  '.acct-tiles',
  '.acct-tile',
  '.acct-tile--wide',
  '.acct-tile__label',
  '.acct-tile__value',
  '.acct-tile__value > :not(.acct-tile__text)',
  '.acct-tile__text',
  '.acct-tile__action',
  '.acct-tile__tenant',
  '.acct-tile__tenant-name',
  '.acct-tile__tenant-id',
  '.acct-section',
  '.acct-rule',
  '.acct-glyph',
  '.acct-glyph > svg',
  '.acct-glyph--sm',
  '.acct-glyph--accent',
  '.acct-glyph--ok',
  '.acct-glyph--warn',
  '.acct-glyph--danger',
  '.acct-row',
  '.acct-row__body',
  '.acct-row__title',
  '.acct-row__desc',
  '.acct-2fa',
  '.acct-caps',
  '.acct-methods',
  '.acct-methods__list',
  '.acct-methods__list li',
  '.acct-methods__list li > svg',
  '.acct-mfa',
  '.acct-mfa__box',
  '.acct-mfa__title',
  '.acct-mfa__title > svg',
  '.acct-mfa__desc',
  '.acct-prose',
  '.acct-empty-line',
  '.acct-signin',
  '.acct-signin__row',
  '.acct-signin__body',
  '.acct-signin__name',
  '.acct-signin__sub',
  '.acct-session',
  '.acct-session__value',
  '.acct-session__date',
  '.acct-session__meter',
  '.acct-session__meter > .hive-meter',
  '.acct-session__left',
  '.acct-session__device',
  '.acct-session__device > svg',
  '.acct-dialog__header',
  '.acct-dialog__header--stacked',
  '.acct-dialog__lead',
  '.acct-dialog__heading',
  '.acct-dialog__body',
  '.acct-field',
  '.acct-hint',
  '.acct-reqs',
  '.acct-reqs li[data-met="true"]',
  '.acct-strength',
  '.acct-strength > .hive-progress',
  '.acct-strength__label',
  '.acct-codes-panel',
  '.acct-codes',
  '.acct-codes__actions',
  '.acct-enroll',
  '.acct-enroll__fields',
  '.acct-qr',
  '.acct-uri',
  '.acct-uri > code',
  '.acct-code-input',
] as const;

/**
 * Look one of this ticket's rules up.
 *
 * @param prelude The rule's selector, exactly as {@link ACCOUNT_PRELUDES} lists it.
 * @returns The rule.
 */
function accountRule(prelude: string): CssRule {
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
  const value = parseDeclarations(accountRule(prelude).body).get(property);
  if (value === undefined) throw new Error(`\`${prelude}\` declares no \`${property}\``);
  return value;
}

/* -------------------------------------------------------------------------
   1. The section exists, and names no colour
   ------------------------------------------------------------------------- */

describe('the account section of globals.css', () => {
  it('declares every rule the components reference', () => {
    const missing = ACCOUNT_PRELUDES.filter(
      (prelude) => !rules.some((rule) => rule.prelude === prelude)
    );
    expect(missing).toEqual([]);
  });

  it('sits after the unlayered h2 and p base rules it has to outrank', () => {
    for (const prelude of ACCOUNT_PRELUDES) {
      expect(accountRule(prelude).line).toBeGreaterThan(BASE_TYPE_RULE_LINE);
    }
  });

  it('names no colour — every hue resolves through the token layer', () => {
    const values = ACCOUNT_PRELUDES.flatMap((prelude) => [
      ...parseDeclarations(accountRule(prelude).body).values(),
    ]);
    for (const value of values) {
      expect(value).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(value).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|oklch)\(/);
    }
  });

  it('leaves the hex fence of the stylesheet intact', () => {
    const offenders = findUnfencedHex(css).map((entry) => `${entry.line}: ${entry.text}`);
    expect(offenders).toEqual([]);
  });

  it('states no font size or control metric in px', () => {
    // `1px` is exempt and only `1px`: a hairline is one device pixel by definition and must not
    // grow with the font scale.
    for (const prelude of ACCOUNT_PRELUDES) {
      for (const [property, value] of parseDeclarations(accountRule(prelude).body)) {
        if (!['font-size', 'min-height', 'height', 'width', 'line-height'].includes(property)) {
          continue;
        }
        const offending = [...value.matchAll(/\b(\d+(?:\.\d+)?)px\b/g)].filter(
          (match) => match[1] !== '1'
        );
        expect({ prelude, property, offending: offending.map((match) => match[0]) }).toEqual({
          prelude,
          property,
          offending: [],
        });
      }
    }
  });

  it('states no spacing in px either, so the font-size preference reaches every gap', () => {
    for (const prelude of ACCOUNT_PRELUDES) {
      for (const [property, value] of parseDeclarations(accountRule(prelude).body)) {
        if (!/^(?:padding|margin|gap|row-gap|column-gap)/.test(property)) continue;
        const offending = [...value.matchAll(/\b\d+(?:\.\d+)?px\b/g)].map((match) => match[0]);
        expect({ prelude, property, offending }).toEqual({ prelude, property, offending: [] });
      }
    }
  });

  it('takes each well’s padding from the density-aware spacing scale', () => {
    // A padding frozen even in `rem` would ignore the Compact preference, which is the whole
    // point of `--space-*` and `--card-pad` being tokens rather than measurements.
    for (const prelude of [
      '.acct-tile',
      '.acct-mfa__box',
      '.acct-methods',
      '.acct-codes',
      '.acct-qr',
      '.acct-uri',
    ]) {
      expect(declaration(prelude, 'padding')).toMatch(/^var\(--(?:space-|card-pad)/);
    }
  });
});

/* -------------------------------------------------------------------------
   2. Nothing can widen the page
   ------------------------------------------------------------------------- */

describe('the body grid', () => {
  it('caps the main track at zero, so long content cannot widen the page', () => {
    // A grid item's automatic minimum size is its content: plain `1fr` would let an unbroken
    // email address or tenant uuid hold the track open past the viewport.
    expect(declaration('.acct-grid', 'grid-template-columns')).toBe('minmax(0, 1fr) 21.25rem');
  });

  it('gives both columns a zero min-width of their own', () => {
    expect(declaration('.acct-grid__main, .acct-grid__aside', 'min-width')).toBe('0');
  });

  it('does not stretch a short aside to the height of the column beside it', () => {
    expect(declaration('.acct-grid', 'align-items')).toBe('start');
  });

  it('collapses at the width the rest of the app reflows at', () => {
    expect(STRIPPED).toMatch(
      /@media \(max-width: 68\.75rem\) \{\s*\.acct-grid \{\s*grid-template-columns: minmax\(0, 1fr\);/
    );
  });

  it('stacks the info tiles rather than squeezing two into a narrow column', () => {
    expect(declaration('.acct-tiles', 'grid-template-columns')).toBe('repeat(2, minmax(0, 1fr))');
    expect(STRIPPED).toMatch(
      /@media \(max-width: 48rem\) \{\s*\.acct-tiles \{\s*grid-template-columns: minmax\(0, 1fr\);/
    );
  });

  it('keeps the full-width tile full width in both states', () => {
    expect(declaration('.acct-tile--wide', 'grid-column')).toBe('1 / -1');
  });

  it('stacks the QR beside its fields only while there is room for both', () => {
    expect(declaration('.acct-enroll', 'grid-template-columns')).toBe('auto minmax(0, 1fr)');
    expect(STRIPPED).toMatch(
      /@media \(max-width: 34rem\) \{\s*\.acct-enroll \{\s*grid-template-columns: minmax\(0, 1fr\);/
    );
  });
});

describe('long values', () => {
  it('clips each tile’s value to one line', () => {
    // The acceptance criterion: "long email addresses and tenant ids truncate without breaking
    // layout". Three declarations make an ellipsis, and all three have to be present.
    for (const prelude of ['.acct-tile__text', '.acct-tile__tenant-name', '.acct-tile__tenant-id']) {
      expect(declaration(prelude, 'overflow')).toBe('hidden');
      expect(declaration(prelude, 'text-overflow')).toBe('ellipsis');
      expect(declaration(prelude, 'white-space')).toBe('nowrap');
    }
  });

  it('gives every clipping box a zero min-width, without which the clip never happens', () => {
    for (const prelude of ['.acct-tile', '.acct-tile__value', '.acct-tile__text', '.acct-tile__tenant']) {
      expect(declaration(prelude, 'min-width')).toBe('0');
    }
  });

  it('lets the lines that wrap break mid-word rather than push the page wide', () => {
    for (const prelude of [
      '.acct-identity__name',
      '.acct-identity__email',
      '.acct-row__title',
      '.acct-mfa__desc',
      '.acct-signin__name',
      '.acct-signin__sub',
      '.acct-session__value',
      '.acct-uri > code',
      '.acct-methods__list li',
    ]) {
      expect(declaration(prelude, 'overflow-wrap')).toBe('anywhere');
    }
  });
});

/* -------------------------------------------------------------------------
   3. Type is sized and coloured by rules of its own
   ------------------------------------------------------------------------- */

describe('type', () => {
  it('sizes the hero’s heading, since the base h2 rule would otherwise win', () => {
    expect(declaration('.acct-identity__name', 'font-size')).toMatch(/^var\(--fs-/);
    expect(declaration('.acct-identity__name', 'font-weight')).toBe('600');
  });

  it('colours every quiet line, since the base p rule would otherwise win', () => {
    for (const prelude of [
      '.acct-card__note',
      '.acct-row__desc',
      '.acct-mfa__desc',
      '.acct-prose',
      '.acct-empty-line',
      '.acct-signin__sub',
      '.acct-session__date',
      '.acct-session__device',
      '.acct-session__left',
      '.acct-strength__label',
      '.acct-hint',
      '.acct-uri > code',
    ]) {
      expect(declaration(prelude, 'color')).toMatch(/^var\(--fg/);
    }
  });

  it('takes every type step from the scale rather than from a measurement', () => {
    for (const prelude of ACCOUNT_PRELUDES) {
      const size = parseDeclarations(accountRule(prelude).body).get('font-size');
      if (size) expect(size).toMatch(/^var\(--fs-/);
    }
  });

  it('sizes the glyph inside an icon tile from an icon token', () => {
    expect(declaration('.acct-glyph > svg', 'width')).toBe('var(--icon-dense)');
    expect(declaration('.acct-glyph > svg', 'height')).toBe('var(--icon-dense)');
  });

  it('sets the caps labels in the 11 px step the design language reserves for them', () => {
    for (const prelude of ['.acct-caps', '.acct-tile__label']) {
      expect(declaration(prelude, 'font-size')).toBe('var(--fs-2xs)');
      expect(declaration(prelude, 'letter-spacing')).toBe('var(--track-caps)');
      expect(declaration(prelude, 'text-transform')).toBe('uppercase');
    }
  });
});

/* -------------------------------------------------------------------------
   4. Tones and contrast
   ------------------------------------------------------------------------- */

describe('the icon tile', () => {
  it('has a shape and an ink before any modifier is applied', () => {
    // A tile whose role modifier is missing must still read as a tile rather than as nothing.
    expect(declaration('.acct-glyph', 'background')).toBe('var(--bg-inset)');
    expect(declaration('.acct-glyph', 'color')).toBe('var(--fg-muted)');
  });

  it('paints each role from its own soft/foreground pair', () => {
    for (const role of ['accent', 'ok', 'warn', 'danger']) {
      expect(declaration(`.acct-glyph--${role}`, 'background')).toBe(`var(--${role}-soft)`);
      expect(declaration(`.acct-glyph--${role}`, 'color')).toBe(`var(--${role}-fg)`);
    }
  });
});

describe('quiet text clears WCAG AA', () => {
  it('never reaches for --fg-subtle, which fails AA at these sizes', () => {
    const subtle = hexToRgb(resolveToken('--fg-subtle', tokens));
    expect(contrastRatio(subtle, hexToRgb(resolveToken('--bg-canvas', tokens)))).toBeLessThan(
      WCAG_AA_NORMAL_TEXT_MIN
    );

    for (const prelude of ACCOUNT_PRELUDES) {
      const color = parseDeclarations(accountRule(prelude).body).get('color');
      if (color) expect(color).not.toBe('var(--fg-subtle)');
    }
  });

  it('never lands muted ink on --bg-subtle, in any theme', () => {
    // Solarized measures `--fg-muted` on `--bg-subtle` at 4.35:1, just under AA. Both wells that
    // carry muted ink — the info tile and the sign-in-methods panel — are therefore `--bg-inset`,
    // whose worst theme is 5.02:1. The walk below proves the ratio; this proves nothing reached
    // for the other token.
    for (const prelude of ['.acct-tile', '.acct-methods']) {
      expect(declaration(prelude, 'background')).toBe('var(--bg-inset)');
    }
  });

  it('never inks a figure in a role’s -fg on a page surface', () => {
    // `--warn-fg`, `--ok-fg` and `--danger-fg` are calibrated against their own `-soft` tints,
    // and the High contrast theme leaves all three at their light-palette values — `--warn-fg`
    // measures 3.31:1 on that theme's black surface. So the two figures that could have taken a
    // derived tone's ink (the session meter's and the password meter's) take muted instead, and
    // the *bar* beside each carries the tone.
    for (const prelude of ['.acct-session__left', '.acct-strength__label']) {
      expect(declaration(prelude, 'color')).toBe('var(--fg-muted)');
    }
  });

  it('quiets a satisfied requirement without touching its contrast', () => {
    // `opacity` composites the ink into the tint beneath it; a rule through the text does not.
    const met = parseDeclarations(accountRule('.acct-reqs li[data-met="true"]').body);
    expect(met.get('text-decoration')).toBe('line-through');
    expect(met.has('opacity')).toBe(false);
  });

  it('holds every text-on-surface pair the page draws at 4.5:1 in all nine themes', () => {
    /** The ink and the fill it lands on, for every pairing the account surfaces render. */
    const pairs: readonly (readonly [string, string])[] = [
      ['--fg-muted', '--bg-canvas'],
      ['--fg-muted', '--bg-surface'],
      ['--fg-muted', '--bg-inset'],
      ['--fg', '--bg-surface'],
      ['--fg', '--bg-inset'],
    ];

    for (const [ink, backdrop] of pairs) {
      // The base palette first, then each of the nine themes' own swap.
      const base = contrastRatio(
        hexToRgb(resolveThemeToken(ink, tokens)),
        hexToRgb(resolveThemeToken(backdrop, tokens))
      );
      expect({ ink, backdrop, theme: 'light', ratio: base >= WCAG_AA_NORMAL_TEXT_MIN }).toEqual({
        ink,
        backdrop,
        theme: 'light',
        ratio: true,
      });

      for (const [id, block] of themes) {
        const ratio = contrastRatio(
          hexToRgb(resolveThemeToken(ink, tokens, block)),
          hexToRgb(resolveThemeToken(backdrop, tokens, block))
        );
        expect({ ink, backdrop, theme: id, ratio: ratio >= WCAG_AA_NORMAL_TEXT_MIN }).toEqual({
          ink,
          backdrop,
          theme: id,
          ratio: true,
        });
      }
    }
  });
});

/* -------------------------------------------------------------------------
   5. The hero
   ------------------------------------------------------------------------- */

describe('the identity hero', () => {
  it('draws its band from the three brand and surface tokens, not from a hue', () => {
    const band = declaration('.acct-identity__band', 'background');
    expect(band).toContain('var(--honey-soft)');
    expect(band).toContain('var(--accent-soft)');
    expect(band).toContain('var(--bg-surface)');
  });

  it('rings the avatar in the card it overlaps rather than in a grey that matches one theme', () => {
    expect(declaration('.acct-identity__avatar', 'box-shadow')).toBe('0 0 0 0.25rem var(--bg-surface)');
  });

  it('clips the band to the card’s own radius', () => {
    expect(declaration('.acct-identity', 'overflow')).toBe('hidden');
  });
});
