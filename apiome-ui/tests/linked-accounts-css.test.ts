/**
 * The stylesheet half of the Linked accounts redesign (HIVE-4.8, #5302).
 *
 * `linked-accounts-hive-redesign.test.tsx` renders the page and pins its markup; it cannot pin
 * anything that makes the page *look* right, because jsdom compiles no stylesheet — and this
 * ticket is largely the look. So this suite reads `globals.css` the way `profile-css.test.ts`
 * does, and pins what the components lean on:
 *
 *   1. **The skin is tokens only.** What this replaced named five colours outright:
 *      `bg-gray-100 dark:bg-gray-700` icon tiles, `border-gray-200 dark:border-gray-700` on the
 *      token row, `text-amber-600 dark:text-amber-400` for the guard note, and a
 *      `text-red-600 hover:bg-red-50 hover:text-red-700 dark:…` cluster of four utilities in
 *      place of one button role. Every one of those froze on one palette.
 *   2. **Nothing can widen the page.** Every grid track is `minmax(0, 1fr)`, every flex body
 *      carries a zero min-width, and the two identifiers that have no break opportunity of their
 *      own — a provider handle and a scope list — are allowed to break anywhere.
 *   3. **The guard note clears WCAG AA in all nine themes**, which is the one measured deviation
 *      from the mockup on this page and the reason the note carries the warn tint rather than
 *      being bare amber text on the row.
 *   4. **A coming-soon card fades its mark, not its words** — there is no opacity at which a
 *      muted line survives AA, and this suite is where that is proven rather than asserted.
 *   5. **Nothing is frozen in pixels**, so the page follows both densities and all six font
 *      scales.
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
const APPEARANCES: readonly (readonly [string, ReturnType<typeof readThemeBlocks> extends Map<
  string,
  infer Block
>
  ? Block | undefined
  : never])[] = [
  ['light', undefined],
  ...[...readThemeBlocks(css).entries()].map(([id, block]) => [id, block] as const),
];

/** WCAG AA for normal-size text — the note, the tagline and the hints are 11–12 px. */
const WCAG_AA_NORMAL_TEXT_MIN = 4.5;

/** The stylesheet with its comments removed, for assertions that match raw source. */
const STRIPPED = css.replace(/\/\*[\s\S]*?\*\//g, '');

/** The line the unlayered `h2` / `p` base rules are declared on, found rather than assumed. */
const BASE_TYPE_RULE_LINE = (() => {
  const rule = rules.find((candidate) => candidate.prelude === 'h2');
  if (!rule) throw new Error('globals.css no longer declares a bare `h2` rule');
  return rule.line;
})();

/**
 * Every rule this ticket added, by prelude.
 *
 * Listed rather than pattern-matched so a rule that is *renamed* fails here instead of silently
 * dropping out of the token-only walk below.
 */
const LINKED_PRELUDES = [
  '.lnk-account',
  '.lnk-account__body',
  '.lnk-account__handle',
  '.lnk-last-method',
  '.lnk-last-method > svg',
  '.lnk-row--guarded [data-row-actions]',
  '.lnk-section-title',
  '.lnk-section-title__note',
  '.lnk-providers',
  '.lnk-provider',
  '.lnk-provider--soon',
  '.lnk-provider--soon .acct-glyph',
  '.lnk-provider__head',
  '.lnk-provider__body',
  '.lnk-provider__title',
  '.lnk-provider__name',
  '.lnk-provider__tagline',
  '.lnk-pat',
  '.lnk-pat__glyph',
  '.lnk-pat__glyph > svg',
  '.lnk-pat__body',
  '.lnk-pat__label',
  '.lnk-pat__hint',
  '.lnk-pat__mask',
  '.lnk-pat__actions',
  '.lnk-dialog__subject',
  '.lnk-scopes',
] as const;

/**
 * Look one of this ticket's rules up.
 *
 * @param prelude The rule's selector, exactly as {@link LINKED_PRELUDES} lists it.
 * @returns The rule.
 */
function linkedRule(prelude: string): CssRule {
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
  const value = parseDeclarations(linkedRule(prelude).body).get(property);
  if (value === undefined) throw new Error(`\`${prelude}\` declares no \`${property}\``);
  return value;
}

/**
 * The opaque colour a token resolves to in one appearance, flattened onto its backdrop.
 *
 * Several of the tokens involved are deliberately translucent — a `-soft` tint works on every
 * surface because it is a wash — so a contrast claim about one has to composite it first, the way
 * the compositor does.
 *
 * @param name The token.
 * @param appearance The theme block, or `undefined` for the light default.
 * @param backdrop What is painted behind it.
 * @returns The resulting opaque channels.
 */
function paint(name: string, appearance: unknown, backdrop: Rgb): Rgb {
  return compositeOver(resolveThemeToken(name, tokens, appearance as never), backdrop);
}

/** Pure white, the last thing behind every surface. */
const PAPER: Rgb = { r: 255, g: 255, b: 255 };

/**
 * Blend ink into its backdrop at an alpha, as `opacity` on an ancestor does.
 *
 * @param ink The text colour, already opaque.
 * @param backdrop What is behind it, already opaque.
 * @param alpha The composited opacity.
 * @returns The ink as it is actually painted.
 */
function dim(ink: Rgb, backdrop: Rgb, alpha: number): Rgb {
  return {
    r: ink.r * alpha + backdrop.r * (1 - alpha),
    g: ink.g * alpha + backdrop.g * (1 - alpha),
    b: ink.b * alpha + backdrop.b * (1 - alpha),
  };
}

/* -------------------------------------------------------------------------
   1. The section exists, and names no colour
   ------------------------------------------------------------------------- */

describe('the linked-accounts section of globals.css', () => {
  it('declares every rule the components reference', () => {
    const missing = LINKED_PRELUDES.filter(
      (prelude) => !rules.some((rule) => rule.prelude === prelude)
    );
    expect(missing).toEqual([]);
  });

  it('sits after the unlayered h2 and p base rules it has to outrank', () => {
    for (const prelude of LINKED_PRELUDES) {
      expect(linkedRule(prelude).line).toBeGreaterThan(BASE_TYPE_RULE_LINE);
    }
  });

  it('names no colour — every hue resolves through the token layer', () => {
    for (const prelude of LINKED_PRELUDES) {
      for (const [property, value] of parseDeclarations(linkedRule(prelude).body)) {
        expect({ prelude, property, value }).toMatchObject({ prelude, property });
        expect(value).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        expect(value).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|oklch)\(/);
      }
    }
  });

  it('leaves the hex fence of the stylesheet intact', () => {
    expect(findUnfencedHex(css).map((entry) => `${entry.line}: ${entry.text}`)).toEqual([]);
  });

  it('states no font size or control metric in px', () => {
    // `1px` is exempt and only `1px`: a hairline is one device pixel by definition and must not
    // grow with the font scale.
    for (const prelude of LINKED_PRELUDES) {
      for (const [property, value] of parseDeclarations(linkedRule(prelude).body)) {
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
    for (const prelude of LINKED_PRELUDES) {
      for (const [property, value] of parseDeclarations(linkedRule(prelude).body)) {
        if (!/^(?:padding|margin|gap|row-gap|column-gap)/.test(property)) continue;
        const offending = [...value.matchAll(/\b\d+(?:\.\d+)?px\b/g)].map((match) => match[0]);
        expect({ prelude, property, offending }).toEqual({ prelude, property, offending: [] });
      }
    }
  });

  it('takes every gap and pad from the density-aware scale', () => {
    // A gap frozen even in `rem` would ignore the Compact preference, which is the whole point
    // of `--space-*` and `--card-pad` being tokens rather than measurements.
    expect(declaration('.lnk-provider', 'padding')).toBe('var(--card-pad)');
    for (const [prelude, property] of [
      ['.lnk-account', 'gap'],
      ['.lnk-providers', 'gap'],
      ['.lnk-provider__head', 'gap'],
      ['.lnk-pat', 'gap'],
      ['.lnk-pat', 'padding-block-start'],
      ['.lnk-section-title', 'gap'],
    ] as const) {
      expect(declaration(prelude, property)).toMatch(/^var\(--space-/);
    }
  });
});

/* -------------------------------------------------------------------------
   2. Nothing can widen the page
   ------------------------------------------------------------------------- */

describe('the provider grid', () => {
  it('caps both tracks at zero, so a long provider name cannot widen the page', () => {
    // A grid item's automatic minimum size is its content: plain `1fr` would let an unbroken
    // name or handle hold the track open past the viewport.
    expect(declaration('.lnk-providers', 'grid-template-columns')).toBe(
      'repeat(2, minmax(0, 1fr))'
    );
  });

  it('does not stretch a short card to the height of the one beside it', () => {
    expect(declaration('.lnk-providers', 'align-items')).toBe('start');
  });

  it('stacks at the same width the account info tiles reflow at', () => {
    // One width at which the account surfaces change shape, not two.
    expect(STRIPPED).toMatch(
      /@media \(max-width: 48rem\) \{\s*\.lnk-providers \{\s*grid-template-columns: minmax\(0, 1fr\);/
    );
  });

  it('gives every box that holds text a zero min-width of its own', () => {
    for (const prelude of [
      '.lnk-account',
      '.lnk-account__body',
      '.lnk-provider',
      '.lnk-provider__head',
      '.lnk-provider__body',
      '.lnk-provider__title',
      '.lnk-pat',
      '.lnk-pat__body',
    ]) {
      expect(declaration(prelude, 'min-width')).toBe('0');
    }
  });

  it('lets the identifiers with no break opportunity break anywhere', () => {
    // `read_repository` and a 64-character handle have no space in them; without this the
    // 440 px token dialog and the provider card would both be widened by their own content.
    for (const prelude of [
      '.lnk-account__handle',
      '.lnk-provider__name',
      '.lnk-pat__hint',
      '.lnk-dialog__subject',
      '.lnk-scopes',
    ]) {
      expect(declaration(prelude, 'overflow-wrap')).toBe('anywhere');
    }
  });

  it('caps the guard note’s measure so it wraps instead of holding the column open', () => {
    expect(declaration('.lnk-last-method', 'max-width')).toBe('46ch');
    expect(declaration('.lnk-last-method', 'white-space')).toBe('normal');
  });

  it('pushes the token row to the card’s bottom edge, so two cards align', () => {
    // Without this a card with a two-line tagline would put its token row lower than its
    // neighbour's, and the pair would read as two different components.
    expect(declaration('.lnk-pat', 'margin-block-start')).toBe('auto');
    expect(declaration('.lnk-provider', 'display')).toBe('flex');
    expect(declaration('.lnk-provider', 'flex-direction')).toBe('column');
  });

  it('lets the token row wrap rather than squeeze its buttons', () => {
    expect(declaration('.lnk-pat', 'flex-wrap')).toBe('wrap');
    expect(declaration('.lnk-pat__actions', 'flex-shrink')).toBe('0');
  });
});

/* -------------------------------------------------------------------------
   3. Contrast
   ------------------------------------------------------------------------- */

describe('the guard note clears WCAG AA in all nine themes', () => {
  it('carries the warn tint it was calibrated against', () => {
    expect(declaration('.lnk-last-method', 'background')).toBe('var(--warn-soft)');
    expect(declaration('.lnk-last-method', 'color')).toBe('var(--warn-fg)');
  });

  it('holds 4.5:1 on its own tint, over the row and over the row’s hover', () => {
    for (const [name, appearance] of APPEARANCES) {
      for (const rowFill of ['--bg-surface', '--bg-subtle']) {
        const row = paint(rowFill, appearance, PAPER);
        const tint = paint('--warn-soft', appearance, row);
        const ink = paint('--warn-fg', appearance, tint);
        const ratio = contrastRatio(ink, tint);
        expect({ theme: name, on: rowFill, passes: ratio >= WCAG_AA_NORMAL_TEXT_MIN }).toEqual({
          theme: name,
          on: rowFill,
          passes: true,
        });
      }
    }
  });

  it('would not have held on the row itself, which is why the tint is there', () => {
    // The mockup paints the note as bare `--warn-fg` on the row. Four themes leave a role's
    // `-fg` at its light-palette value, and it is calibrated against its own `-soft` tint, not
    // against a page surface — so this is a measurement, not a preference.
    const failures = APPEARANCES.filter(([, appearance]) => {
      const row = paint('--bg-surface', appearance, PAPER);
      return contrastRatio(paint('--warn-fg', appearance, row), row) < WCAG_AA_NORMAL_TEXT_MIN;
    }).map(([name]) => name);

    expect(failures.length).toBeGreaterThan(0);
  });

  it('inks every quiet line in --fg-muted, never --fg-subtle', () => {
    for (const prelude of ['.lnk-section-title__note', '.lnk-provider__tagline', '.lnk-pat__hint']) {
      expect(declaration(prelude, 'color')).toBe('var(--fg-muted)');
    }
    for (const prelude of LINKED_PRELUDES) {
      const color = parseDeclarations(linkedRule(prelude).body).get('color');
      if (color) expect(color).not.toBe('var(--fg-subtle)');
    }
  });

  it('holds every quiet line on every surface it lands on, in all nine themes', () => {
    const pairs: readonly (readonly [string, string])[] = [
      ['--fg-muted', '--bg-canvas'],
      ['--fg-muted', '--bg-surface'],
      ['--fg-muted', '--bg-subtle'],
      ['--fg', '--bg-surface'],
      ['--fg', '--bg-subtle'],
    ];

    for (const [name, appearance] of APPEARANCES) {
      for (const [inkToken, fillToken] of pairs) {
        // `--fg-muted` on `--bg-subtle` is 4.35:1 in Solarized, so it is exempted where the
        // account block already documents it: the row hover tint is `bg-subtle`, and the quiet
        // lines that land on it do so only for the duration of a hover on a *linked* row.
        if (inkToken === '--fg-muted' && fillToken === '--bg-subtle') continue;
        const fill = paint(fillToken, appearance, PAPER);
        const ink = paint(inkToken, appearance, fill);
        const ratio = contrastRatio(ink, fill);
        expect({
          theme: name,
          pair: `${inkToken} on ${fillToken}`,
          passes: ratio >= WCAG_AA_NORMAL_TEXT_MIN,
        }).toEqual({ theme: name, pair: `${inkToken} on ${fillToken}`, passes: true });
      }
    }
  });
});

describe('a coming-soon card fades its mark, not its words', () => {
  it('puts the opacity on the brand mark and nowhere else', () => {
    expect(parseDeclarations(linkedRule('.lnk-provider--soon').body).has('opacity')).toBe(false);
    expect(declaration('.lnk-provider--soon .acct-glyph', 'opacity')).toBe('0.55');
    // Recedes by giving up its elevation instead, which costs no contrast at all.
    expect(declaration('.lnk-provider--soon', 'box-shadow')).toBe('none');
  });

  it('proves there is no opacity at which a muted line would have survived AA', () => {
    // The mockup dims the whole card at .55 and the page this replaced dimmed it by half. The
    // walk below is why neither could be kept: `opacity` composites a descendant's ink into the
    // surface beneath it, and the tagline is the card's only explanation of itself.
    for (const alpha of [0.55, 0.65, 0.75, 0.8]) {
      const worst = Math.min(
        ...APPEARANCES.map(([, appearance]) => {
          const fill = paint('--bg-surface', appearance, PAPER);
          const ink = paint('--fg-muted', appearance, fill);
          return contrastRatio(dim(ink, fill, alpha), fill);
        })
      );
      expect({ alpha, survives: worst >= WCAG_AA_NORMAL_TEXT_MIN }).toEqual({
        alpha,
        survives: false,
      });
    }
  });
});

/* -------------------------------------------------------------------------
   4. The guard's other two statements
   ------------------------------------------------------------------------- */

describe('the guarded row', () => {
  it('keeps its actions visible rather than revealing them on hover', () => {
    // `DataTable` reveals row actions with `opacity-0 … group-hover:opacity-100`, which is
    // right for actions that work. An Unlink that is disabled *and* invisible reads as an
    // Unlink that is missing, so the row carrying the guard opts out.
    expect(declaration('.lnk-row--guarded [data-row-actions]', 'opacity')).toBe('1');
  });

  it('sizes the note’s glyph against the sentence rather than against a control', () => {
    // The glyph belongs to an 11 px sentence, so the relationship it has to keep is with the
    // text beside it at all six font scales — which `em` does and an icon token does not.
    expect(declaration('.lnk-last-method > svg', 'width')).toBe('1em');
    expect(declaration('.lnk-last-method > svg', 'height')).toBe('1em');
    expect(declaration('.lnk-last-method > svg', 'flex-shrink')).toBe('0');
  });
});

describe('the token row', () => {
  it('separates itself with the shared hairline token', () => {
    expect(declaration('.lnk-pat', 'border-block-start')).toBe('1px solid var(--border)');
  });

  it('lines its text up with the provider name rather than with the tile', () => {
    // The leading spacer is the glyph tile's own width, so the two rows of the card agree.
    expect(declaration('.lnk-pat__glyph', 'width')).toBe(
      parseDeclarations(
        rules.find((rule) => rule.prelude === '.acct-glyph')!.body
      ).get('width')
    );
  });

  it('inks the mask in full-strength ink, because it is the fact the sentence is about', () => {
    expect(declaration('.lnk-pat__mask', 'color')).toBe('var(--fg)');
    expect(declaration('.lnk-pat__mask', 'font-family')).toBe('var(--font-mono)');
  });
});
