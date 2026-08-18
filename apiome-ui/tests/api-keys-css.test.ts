/**
 * The stylesheet half of the API keys redesign (HIVE-5.4, #5307).
 *
 * `api-keys-hive-redesign.test.tsx` renders the page and pins its markup; it cannot pin
 * anything that makes it *look* right, because jsdom compiles no stylesheet. So this suite
 * reads `globals.css` the way `members-css.test.ts` does, and pins what the components lean
 * on:
 *
 *   1. **The skin is tokens only.** What this replaced named colour outright in eleven places
 *      — `bg-red-50/50` for an expired row, `bg-gray-50/80` for a disabled one,
 *      `bg-emerald-50 text-emerald-700` for Active, `bg-amber-100` for the key mark and a
 *      `from-amber-500 to-orange-500` gradient on the create button. Every one froze the
 *      surface on one palette, and none agreed with the shared status vocabulary.
 *   2. **Nothing is frozen in pixels.** The mockup's page-local block sets the description
 *      clamp at 280 px, the expiry field at 240 px and the secret box's padding at 10 px; all
 *      are `rem` or a spacing token here, so they follow all six font scales.
 *   3. **Expired and disabled rows are distinguished by a tint, never by a fade** — proved in
 *      both directions: each tint keeps ordinary table ink above AA in all nine themes, and
 *      the block spends no `opacity` at all.
 *   4. **The two tints are distinguishable from each other**, which is what "visually
 *      distinct" in the acceptance criteria has to mean when both are washes on one surface.
 *   5. **Nothing can scroll the document sideways**: the `curl` block and the reference grid
 *      each own their overflow, and the Name cell's ellipsis has a ceiling to engage against.
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

/** Pure white, the last thing behind every surface. */
const PAPER: Rgb = { r: 255, g: 255, b: 255 };

/** The line the unlayered `h2` / `p` base rules are declared on, found rather than assumed. */
const BASE_TYPE_RULE_LINE = (() => {
  const rule = rules.find((candidate) => candidate.prelude === 'h2');
  if (!rule) throw new Error('globals.css no longer declares a bare `h2` rule');
  return rule.line;
})();

/**
 * Every top-level rule this ticket added, by prelude.
 *
 * Listed rather than pattern-matched so a rule that is *renamed* fails here instead of
 * silently dropping out of the token-only walk below.
 */
const API_KEY_PRELUDES = [
  '.akey-identity',
  '.akey-identity__text',
  '.akey-identity__name',
  '.akey-identity__desc',
  '.akey-prefix',
  '.akey-prefix__value',
  '.akey-prefix-copy',
  '.akey-scopes',
  '.akey-scopes__full',
  '.akey-stamp',
  '.akey-stamp--past',
  '.akey-toggle',
  '.akey-toggle__label',
  '.akey-row--expired',
  '.akey-row--disabled',
  '.akey-row--expired [data-row-actions]',
  '.akey-foot-legend',
  '.akey-form',
  '.akey-field',
  '.akey-field__hint',
  '.akey-scope-legend',
  '.akey-scope-list',
  '.akey-scope-card',
  '.akey-scope-card:hover',
  '.akey-scope-card:has(.akey-scope-radio:focus-visible)',
  '.akey-scope-card[data-checked]',
  '.akey-scope-card[data-checked] .akey-scope-title, .akey-scope-card[data-checked] .akey-scope-hint',
  '.akey-scope-card[data-checked] .akey-scope-badge',
  '.akey-scope-card:has(.akey-scope-radio:disabled)',
  '.akey-scope-radio',
  '.akey-scope-body',
  '.akey-scope-title',
  '.akey-scope-hint',
  '.akey-expiry-field',
  '.akey-dialog-note',
  '.akey-secret-body',
  '.akey-secret-label',
  '.akey-secret',
  '.akey-secret__value',
  '.akey-secret__copy',
  '.akey-secret-note',
  '.akey-confirm-body',
  '.akey-confirm-identity',
  '.akey-confirm-identity__name',
  '.akey-confirm-identity__prefix',
  '.akey-reference',
  '.akey-ref-card',
  '.akey-ref-card__header',
  '.akey-ref-card__title',
  '.akey-ref-card__title > svg',
  '.akey-ref-card__note',
  '.akey-ref-card__body',
  '.akey-ref-card__body--flush',
  '.akey-ref-card__desc',
  '.akey-code-wrap',
  '.akey-code',
  '.akey-code-copy',
  '.akey-scope-table',
  '.akey-scope-table th',
  '.akey-scope-table td',
  '.akey-scope-table tbody tr:last-child td',
  '.akey-scope-table__allows',
  '.akey-scope-table__count',
  '.akey-gate',
] as const;

/**
 * Look one of this ticket's rules up.
 *
 * @param prelude The rule's selector, exactly as {@link API_KEY_PRELUDES} lists it.
 * @returns The rule.
 */
function keyRule(prelude: string): CssRule {
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
  const value = parseDeclarations(keyRule(prelude).body).get(property);
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
 * A token mixed down over a backdrop, the way `color-mix(in srgb, T n%, transparent)` paints.
 *
 * @param name The token being mixed.
 * @param appearance The theme block, or `undefined` for the light default.
 * @param backdrop The opaque colour painted behind it.
 * @param percent How much of the token the mix keeps.
 * @returns The resulting opaque channels.
 */
function mixOver(name: string, appearance: unknown, backdrop: Rgb, percent: number): Rgb {
  const colour = paint(name, appearance, backdrop);
  const alpha = percent / 100;
  return {
    r: colour.r * alpha + backdrop.r * (1 - alpha),
    g: colour.g * alpha + backdrop.g * (1 - alpha),
    b: colour.b * alpha + backdrop.b * (1 - alpha),
  };
}

/**
 * The API keys block, from its banner to the start of whatever section follows it.
 *
 * Bounded rather than run to the end of the file: `globals.css` grows one section per
 * redesign ticket, and a slice that ended at EOF would make every assertion below a claim
 * about every *later* section too — which is exactly how this ticket broke
 * `roles-css.test.ts`'s "no opacity anywhere" rule by adding a deliberate un-fade of its own.
 */
const API_KEY_SECTION = (() => {
  const start = css.indexOf('API KEYS  (HIVE-5.4, #5307)');
  if (start < 0) throw new Error('globals.css has no API keys section');
  // Every section opens with the same `/* ===…` banner rule; the first one after this
  // section's own opening line is where the next section begins.
  const bannerStart = css.lastIndexOf('/* =', start);
  const next = css.indexOf('/* =', start);
  return css.slice(bannerStart < 0 ? start : bannerStart, next < 0 ? css.length : next);
})();

/** The same block with its comments removed. */
const API_KEY_SECTION_CODE = API_KEY_SECTION.replace(/\/\*[\s\S]*?\*\//g, '');

/* -------------------------------------------------------------------------
   1. The section exists, and names no colour
   ------------------------------------------------------------------------- */

describe('the API keys section of globals.css', () => {
  it('declares every rule the components reference', () => {
    const missing = API_KEY_PRELUDES.filter(
      (prelude) => !rules.some((rule) => rule.prelude === prelude)
    );
    expect(missing).toEqual([]);
  });

  it('sits after the unlayered h2 and p base rules it has to outrank', () => {
    // `.akey-ref-card__title` is an `h2` inside a card; the bare `h2` rule near line 2490 is
    // unlayered, so a rule declared before it would lose whatever its specificity.
    for (const prelude of API_KEY_PRELUDES) {
      expect(keyRule(prelude).line).toBeGreaterThan(BASE_TYPE_RULE_LINE);
    }
  });

  it('names no colour — every hue resolves through the token layer', () => {
    for (const prelude of API_KEY_PRELUDES) {
      for (const [property, value] of parseDeclarations(keyRule(prelude).body)) {
        expect(value).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        // `color-mix(in srgb, var(--danger) …)` is a token expression, not a colour: it names
        // no channel of its own. A literal `rgb(…)`/`hsl(…)` would be.
        expect({ prelude, property, value: value.replace(/color-mix\([^)]*\)/g, '') }).toMatchObject(
          { prelude, property }
        );
        expect(value.replace(/color-mix\([^)]*\)/g, '')).not.toMatch(
          /\b(?:rgb|rgba|hsl|hsla|oklch)\(/
        );
      }
    }
  });

  it('does not reintroduce the palette classes it replaced', () => {
    for (const banned of ['emerald-', 'amber-', 'orange-', 'red-', 'rose-', 'indigo-', 'gray-']) {
      expect(API_KEY_SECTION_CODE).not.toContain(banned);
    }
  });

  it('leaves the hex fence of the stylesheet intact', () => {
    expect(findUnfencedHex(css).map((entry) => `${entry.line}: ${entry.text}`)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------
   2. Nothing is frozen in pixels
   ------------------------------------------------------------------------- */

describe('density and font-scale independence', () => {
  it('states no font size or control metric in px', () => {
    // `1px` is exempt everywhere, and `2px` only inside a ring: a hairline is one device
    // pixel by definition, and the doubled ring is the weight the design language already
    // spends on a *selected* state (the shared `:focus-visible` treatment near line 1480, and
    // the mockup's own `.scope-opt.is-checked`). Neither may grow with the font scale;
    // everything else must be `rem` or a token, which is what this walk is for.
    const RING_PROPERTIES = new Set(['outline', 'outline-offset', 'box-shadow']);
    for (const prelude of API_KEY_PRELUDES) {
      for (const [property, value] of parseDeclarations(keyRule(prelude).body)) {
        const allowed = RING_PROPERTIES.has(property) ? ['1px', '2px'] : ['1px'];
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

  it('caps the expiry field in rem rather than the mockup’s 240px, and lets it shrink', () => {
    expect(declaration('.akey-expiry-field', 'max-inline-size')).toBe('15rem');
  });

  it('spends spacing tokens rather than literal gaps, so Compact is genuinely compact', () => {
    for (const [prelude, property] of [
      ['.akey-identity', 'gap'],
      ['.akey-form', 'gap'],
      ['.akey-field', 'gap'],
      ['.akey-scope-list', 'gap'],
      ['.akey-scope-card', 'padding'],
      ['.akey-secret', 'padding'],
      ['.akey-secret-body', 'gap'],
      ['.akey-confirm-body', 'gap'],
      ['.akey-reference', 'gap'],
      ['.akey-code', 'padding'],
      ['.akey-gate', 'padding'],
    ] as const) {
      expect(declaration(prelude, property)).toContain('var(--space-');
    }
  });

  it('draws every quiet line from the type scale', () => {
    for (const [prelude, expected] of [
      ['.akey-prefix__value', 'var(--fs-xs)'],
      ['.akey-scopes__full', 'var(--fs-sm)'],
      ['.akey-stamp', 'var(--fs-sm)'],
      ['.akey-toggle__label', 'var(--fs-xs)'],
      ['.akey-field__hint', 'var(--fs-xs)'],
      ['.akey-scope-legend', 'var(--fs-sm)'],
      ['.akey-scope-title', 'var(--fs-sm)'],
      ['.akey-scope-hint', 'var(--fs-xs)'],
      ['.akey-dialog-note', 'var(--fs-xs)'],
      ['.akey-secret-label', 'var(--fs-2xs)'],
      ['.akey-secret__value', 'var(--fs-sm)'],
      ['.akey-secret-note', 'var(--fs-xs)'],
      ['.akey-confirm-identity__name', 'var(--fs-sm)'],
      ['.akey-confirm-identity__prefix', 'var(--fs-xs)'],
      ['.akey-ref-card__title', 'var(--fs-sm)'],
      ['.akey-ref-card__note', 'var(--fs-xs)'],
      ['.akey-ref-card__desc', 'var(--fs-xs)'],
      ['.akey-code', 'var(--fs-xs)'],
      ['.akey-scope-table', 'var(--fs-xs)'],
      ['.akey-scope-table th', 'var(--fs-2xs)'],
    ] as const) {
      expect(declaration(prelude, 'font-size')).toBe(expected);
    }
  });

  it('reuses the shared radii rather than inventing corners', () => {
    for (const prelude of [
      '.akey-prefix__value',
      '.akey-scope-card',
      '.akey-secret',
      '.akey-confirm-identity',
      '.akey-ref-card',
      '.akey-code',
      '.akey-gate',
    ]) {
      expect(declaration(prelude, 'border-radius')).toMatch(/^var\(--r-/);
    }
  });

  it('sizes its glyphs and its radio from the §3.5 icon vocabulary', () => {
    for (const prelude of ['.akey-ref-card__title > svg', '.akey-scope-radio']) {
      expect(declaration(prelude, 'inline-size')).toBe('var(--icon-dense)');
      expect(declaration(prelude, 'block-size')).toBe('var(--icon-dense)');
    }
  });

  it('tracks its caps labels with the shared caps tracking', () => {
    for (const prelude of ['.akey-secret-label', '.akey-scope-table th']) {
      expect(declaration(prelude, 'letter-spacing')).toBe('var(--track-caps)');
    }
  });
});

/* -------------------------------------------------------------------------
   3. Expired and disabled rows: tinted, distinct, and never faded
   ------------------------------------------------------------------------- */

describe('how an expired or disabled key is distinguished', () => {
  it('grounds each row from a token rather than a hand-picked wash', () => {
    expect(declaration('.akey-row--expired', 'background')).toBe(
      'color-mix(in srgb, var(--danger) 6%, transparent)'
    );
    // `--bg-inset`, not the mockup's 2.5 % wash of `--fg`. Measured: any wash of the
    // foreground reduces the contrast of the muted ink three of this table's columns are
    // drawn in, and Solarized has none to spare — `--fg-muted` is 4.86:1 on the surface
    // there, and a 4 % wash takes it to 4.40:1.
    expect(declaration('.akey-row--disabled', 'background')).toBe('var(--bg-inset)');
  });

  it('spends no opacity anywhere in the block', () => {
    // The mockup fades a disabled row's ink to `--fg-muted`. HIVE-4.8 measured what that
    // costs: a fade dims the words along with the mark, and a tint changes the backdrop
    // rather than the ink — the one of the two that cannot fail a contrast check. The one
    // `opacity` here is the *un*-fade of an expired row's actions, asserted below.
    for (const prelude of API_KEY_PRELUDES) {
      if (prelude === '.akey-row--expired [data-row-actions]') continue;
      expect({ prelude, opacity: parseDeclarations(keyRule(prelude).body).get('opacity') }).toEqual(
        { prelude, opacity: undefined }
      );
    }
  });

  it('keeps an expired row’s Delete visible rather than hover-revealed', () => {
    // Deleting the dead key is what the page's own banner asks the reader to do, and an
    // action you cannot see reads as one that is not offered.
    expect(declaration('.akey-row--expired [data-row-actions]', 'opacity')).toBe('1');
  });

  it.each(APPEARANCES)('keeps body ink legible on an expired row in %s', (_id, appearance) => {
    const surface = paint('--bg-surface', appearance, PAPER);
    const tint = mixOver('--danger', appearance, surface, 6);
    expect(contrastRatio(paint('--fg', appearance, tint), tint)).toBeGreaterThanOrEqual(
      WCAG_AA_NORMAL_TEXT_MIN
    );
  });

  it.each(APPEARANCES)('keeps both inks legible on a disabled row in %s', (_id, appearance) => {
    const surface = paint('--bg-surface', appearance, PAPER);
    const ground = paint('--bg-inset', appearance, surface);
    for (const ink of ['--fg', '--fg-muted']) {
      expect(contrastRatio(paint(ink, appearance, ground), ground)).toBeGreaterThanOrEqual(
        WCAG_AA_NORMAL_TEXT_MIN
      );
    }
  });

  it.each(APPEARANCES)(
    'keeps the quiet timestamp columns legible on an expired row in %s',
    (_id, appearance) => {
      // `.akey-stamp` is `--fg-muted`, and three of the nine columns are drawn in it — so the
      // tint has to clear AA against the *muted* step as well as against `--fg`.
      const surface = paint('--bg-surface', appearance, PAPER);
      const tint = mixOver('--danger', appearance, surface, 6);
      expect(contrastRatio(paint('--fg-muted', appearance, tint), tint)).toBeGreaterThanOrEqual(
        WCAG_AA_NORMAL_TEXT_MIN
      );
    }
  );

  it.each(APPEARANCES)('draws the three row states apart from each other in %s', (_id, appearance) => {
    // "Visually distinct" is a claim about the rows *next to each other*, not about each
    // against the surface: all three share one card, and a reader scanning the table has to
    // be able to see which is which.
    const surface = paint('--bg-surface', appearance, PAPER);
    const expired = mixOver('--danger', appearance, surface, 6);
    const disabled = paint('--bg-inset', appearance, surface);
    const gap = (left: Rgb, right: Rgb) =>
      Math.abs(left.r - right.r) + Math.abs(left.g - right.g) + Math.abs(left.b - right.b);
    for (const [a, b] of [
      [expired, disabled],
      [expired, surface],
      [disabled, surface],
    ] as const) {
      expect(gap(a, b)).toBeGreaterThan(8);
    }
  });

  it.each(APPEARANCES)('keeps the quiet ink of its two inset grounds legible in %s', (_id, appearance) => {
    // `.akey-confirm-identity` prints the prefix in `--fg-muted`, and `.akey-scope-table th`
    // is 11px `--fg-muted`. Both were `--bg-subtle` first; measured, that pairing is 4.35:1
    // in Solarized.
    const surface = paint('--bg-surface', appearance, PAPER);
    for (const ground of ['--bg-inset', '--bg-surface']) {
      const painted = paint(ground, appearance, surface);
      expect(contrastRatio(paint('--fg-muted', appearance, painted), painted)).toBeGreaterThanOrEqual(
        WCAG_AA_NORMAL_TEXT_MIN
      );
    }
  });

  it('grounds the confirm identity and the scope header where their quiet ink holds', () => {
    expect(declaration('.akey-confirm-identity', 'background')).toBe('var(--bg-inset)');
    expect(declaration('.akey-scope-table th', 'background')).toBe('var(--bg-surface)');
  });

  it('marks a passed expiry by ground and weight as well as by hue', () => {
    // The monochrome themes (blueprint, whiteboard, high-contrast) have very little hue to
    // spend, and a reader who cannot separate red from grey has none at all.
    expect(declaration('.akey-stamp--past', 'font-weight')).toBe('600');
    expect(declaration('.akey-stamp--past', 'color')).toBe('var(--danger-fg)');
    expect(declaration('.akey-stamp--past', 'background')).toBe('var(--danger-soft)');
  });

  it.each(APPEARANCES)('clears AA for a passed expiry in %s', (_id, appearance) => {
    // Measured in a browser first: the mockup's bare red text on the red-tinted row is
    // 1.40:1 in Nord and 2.90:1 in high-contrast, because `--danger-fg` is the ink chosen
    // for `--danger-soft` rather than for a 6 % wash of `--danger`. On its own soft ground
    // — which is what this rule gives it — it clears AA everywhere.
    const surface = paint('--bg-surface', appearance, PAPER);
    const row = mixOver('--danger', appearance, surface, 6);
    const chip = paint('--danger-soft', appearance, row);
    expect(contrastRatio(paint('--danger-fg', appearance, chip), chip)).toBeGreaterThanOrEqual(
      WCAG_AA_NORMAL_TEXT_MIN
    );
  });
});

/* -------------------------------------------------------------------------
   4. The checked scope card
   ------------------------------------------------------------------------- */

describe('the scope preset cards', () => {
  it('marks the chosen card with a ring and a tint, not with the ring alone', () => {
    // Two channels, because the card is the control that decides what a key may do and the
    // ring alone is a 1px difference at the smallest font scale.
    expect(declaration('.akey-scope-card[data-checked]', 'box-shadow')).toBe(
      'inset 0 0 0 2px var(--accent)'
    );
    expect(declaration('.akey-scope-card[data-checked]', 'background')).toBe('var(--accent-soft)');
  });

  it('draws the unchecked card as the shared inset hairline', () => {
    expect(declaration('.akey-scope-card', 'box-shadow')).toBe('inset 0 0 0 1px var(--border)');
  });

  it('keeps a focus ring the card itself can show, since the radio is the focus target', () => {
    expect(declaration('.akey-scope-card:has(.akey-scope-radio:focus-visible)', 'outline')).toBe(
      '2px solid var(--focus-ring)'
    );
    expect(
      declaration('.akey-scope-card:has(.akey-scope-radio:focus-visible)', 'outline-offset')
    ).toBe('2px');
  });

  it('re-inks the chosen card, because --fg-muted on --accent-soft fails AA in Solarized', () => {
    expect(
      declaration(
        '.akey-scope-card[data-checked] .akey-scope-title, .akey-scope-card[data-checked] .akey-scope-hint',
        'color'
      )
    ).toBe('var(--accent-fg)');
  });

  it('lifts the scope badges onto the surface once their card is chosen', () => {
    expect(declaration('.akey-scope-card[data-checked] .akey-scope-badge', 'background')).toBe(
      'var(--bg-surface)'
    );
  });

  it.each(APPEARANCES)('clears AA for a chosen card’s scope badge in %s', (_id, appearance) => {
    // Measured in a browser first: an `--accent-soft` badge on an `--accent-soft` card is
    // the same tint twice, and its `--accent-fg` ink is 4.10:1 in Nord — under the 4.5:1 AA
    // asks of an 11px badge. The surface ground this rule gives it is 7:1 at worst.
    const surface = paint('--bg-surface', appearance, PAPER);
    const card = paint('--accent-soft', appearance, surface);
    const badge = paint('--bg-surface', appearance, card);
    expect(contrastRatio(paint('--accent-fg', appearance, badge), badge)).toBeGreaterThanOrEqual(
      WCAG_AA_NORMAL_TEXT_MIN
    );
  });

  it('tints the native radio so its dot follows a theme swap', () => {
    expect(declaration('.akey-scope-radio', 'accent-color')).toBe('var(--accent)');
  });

  it.each(APPEARANCES)('clears AA for the chosen card’s text in %s', (_id, appearance) => {
    const surface = paint('--bg-surface', appearance, PAPER);
    const tint = paint('--accent-soft', appearance, surface);
    expect(contrastRatio(paint('--fg', appearance, tint), tint)).toBeGreaterThanOrEqual(
      WCAG_AA_NORMAL_TEXT_MIN
    );
    // Both lines of a checked card are re-inked to `--accent-fg`, which is the ink the shared
    // vocabulary calibrated for this tint. Measured: keeping `--fg-muted` here is 3.86:1 in
    // Solarized, which is a serious axe finding for a 12px hint.
    expect(contrastRatio(paint('--accent-fg', appearance, tint), tint)).toBeGreaterThanOrEqual(
      WCAG_AA_NORMAL_TEXT_MIN
    );
  });
});

/* -------------------------------------------------------------------------
   5. The secret box
   ------------------------------------------------------------------------- */

describe('the reveal-once secret box', () => {
  it('wraps the key rather than scrolling it — the reader sees it once', () => {
    expect(declaration('.akey-secret__value', 'word-break')).toBe('break-all');
    expect(declaration('.akey-secret__value', 'min-inline-size')).toBe('0');
  });

  it('lets the key be selected by hand, for when the clipboard is refused', () => {
    expect(declaration('.akey-secret__value', 'user-select')).toBe('all');
    expect(declaration('.akey-prefix__value', 'user-select')).toBe('all');
  });

  it('keeps the copy button from being squeezed out by a long key', () => {
    expect(declaration('.akey-secret__copy', 'flex-shrink')).toBe('0');
  });

  it.each(APPEARANCES)('clears AA for the key on its inset ground in %s', (_id, appearance) => {
    const surface = paint('--bg-surface', appearance, PAPER);
    const inset = paint('--bg-inset', appearance, surface);
    expect(contrastRatio(paint('--fg', appearance, inset), inset)).toBeGreaterThanOrEqual(
      WCAG_AA_NORMAL_TEXT_MIN
    );
  });
});

/* -------------------------------------------------------------------------
   6. Nothing can scroll the document sideways
   ------------------------------------------------------------------------- */

describe('no horizontal document scroll at ≥1280px', () => {
  it('caps the Name cell, so the ellipsis below it can actually engage', () => {
    // A `<td>` in an auto-layout table grows to its content regardless of the `overflow:
    // hidden` inside it. Spelled physically on purpose: measured in HIVE-5.2, the build's CSS
    // transform drops `max-inline-size` from a rule that also carries `min-width`.
    expect(declaration('.akey-identity', 'max-width')).toBe('22rem');
    expect(declaration('.akey-identity', 'min-width')).toBe('0');
    expect(declaration('.akey-identity__text', 'min-width')).toBe('0');
  });

  it('elides a long key name and clamps a long description', () => {
    const name = parseDeclarations(keyRule('.akey-identity__name').body);
    expect(name.get('overflow')).toBe('hidden');
    expect(name.get('text-overflow')).toBe('ellipsis');

    const desc = parseDeclarations(keyRule('.akey-identity__desc').body);
    expect(desc.get('-webkit-line-clamp')).toBe('2');
    expect(desc.get('overflow')).toBe('hidden');
  });

  it('scrolls the example request inside its own box', () => {
    expect(declaration('.akey-code', 'overflow-x')).toBe('auto');
  });

  it('gives every content-bearing grid track a zero minimum', () => {
    expect(declaration('.akey-reference', 'grid-template-columns')).toContain('minmax(0,');
  });

  it('lets the scope badges and the foot legend wrap rather than overflow', () => {
    for (const prelude of ['.akey-scopes', '.akey-foot-legend', '.akey-scope-title', '.akey-confirm-identity']) {
      expect(declaration(prelude, 'flex-wrap')).toBe('wrap');
    }
  });

  it('lets the cards that hold content be narrower than it', () => {
    for (const prelude of [
      '.akey-ref-card',
      '.akey-ref-card__body',
      '.akey-scope-body',
      '.akey-code-wrap',
      '.akey-field',
    ]) {
      expect(declaration(prelude, 'min-inline-size')).toBe('0');
    }
  });
});

/* -------------------------------------------------------------------------
   7. The responsive fallback is reachable
   ------------------------------------------------------------------------- */

describe('the responsive fallback', () => {
  it('uses @media, not @container — nothing above these rules is a container', () => {
    // A `@container` query with no `container-type` ancestor never matches at all, which is
    // the quiet way a "responsive" rule turns out to be dead code.
    expect(API_KEY_SECTION_CODE).not.toContain('@container');
  });

  it('stacks the two reference cards before either is too narrow to read', () => {
    const block = API_KEY_SECTION.match(/@media \(max-width: 60rem\) \{[\s\S]*?\n\}/)?.[0];
    expect(block).toBeDefined();
    expect(block).toContain('.akey-reference');
    expect(block).toContain('grid-template-columns: minmax(0, 1fr);');
  });
});
