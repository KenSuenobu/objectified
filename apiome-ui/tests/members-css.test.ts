/**
 * The stylesheet half of the Members redesign (HIVE-5.2, #5305).
 *
 * `members-hive-redesign.test.tsx` renders the page and pins its markup; it cannot pin
 * anything that makes it *look* right, because jsdom compiles no stylesheet. So this suite
 * reads `globals.css` the way `tenants-css.test.ts` does, and pins what the components lean
 * on:
 *
 *   1. **The skin is tokens only.** What this replaced named colour outright in eight places
 *      — `bg-emerald-100 text-emerald-700` for an active member, `bg-amber-100` for a pending
 *      one, `bg-rose-100` for a suspended one, `bg-purple-100` for the Admin pill and
 *      `bg-indigo-600` for the header mark. Every one of those froze the surface on one
 *      palette, and none of them agreed with the shared status vocabulary.
 *   2. **Nothing is frozen in pixels.** The mockup's page-local block set the role select at
 *      150 px and the rows-per-page select at 64 px; both are `rem` here, so they follow all
 *      six font scales.
 *   3. **Nothing can scroll the document sideways.** Every grid track that holds content is
 *      `minmax(0, …)`, the identity cell elides, and both fixed grids collapse below a stated
 *      width.
 *   4. **A pending row is distinguished by a tint, never by a fade.** That is the measured
 *      choice, and it is proved in both directions: the tint keeps AA in all nine themes, and
 *      the block spends no `opacity` at all.
 *   5. **The `@container` trap is avoided** — a container query with no `container-type`
 *      above it never matches, so the responsive fallbacks are `@media` rules.
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
const MEMBER_PRELUDES = [
  '.mbr-seat-strip',
  '.mbr-seat-figure',
  '.mbr-identity',
  '.mbr-identity__text',
  '.mbr-identity__name',
  '.mbr-identity__sub',
  '.mbr-identity__self',
  '.mbr-invite-mark',
  '.mbr-invite-mark > svg',
  '.mbr-row--pending',
  '.mbr-role-select',
  '.mbr-role-select:disabled',
  '.mbr-row-actions',
  '.mbr-kv',
  '.mbr-kv dt',
  '.mbr-kv dd',
  '.mbr-caps',
  '.mbr-tag',
  '.mbr-activity',
  '.mbr-activity + .mbr-activity',
  '.mbr-activity__action',
  '.mbr-activity__when',
  '.mbr-idp-grid',
  '.mbr-idp-card',
  '.mbr-idp-card__desc',
] as const;

/**
 * Look one of this ticket's rules up.
 *
 * @param prelude The rule's selector, exactly as {@link MEMBER_PRELUDES} lists it.
 * @returns The rule.
 */
function memberRule(prelude: string): CssRule {
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
  const value = parseDeclarations(memberRule(prelude).body).get(property);
  if (value === undefined) throw new Error(`\`${prelude}\` declares no \`${property}\``);
  return value;
}

/**
 * The opaque colour a token resolves to in one appearance, flattened onto its backdrop.
 *
 * The `-soft` tints are deliberately translucent in the dark themes, so a contrast claim about
 * one has to composite it first, the way a browser does.
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
 * `compositeOver` reads colour *literals*, and a `color-mix()` is an expression — so the row
 * tint has to be evaluated here before it can be measured. Mixing with `transparent` in sRGB
 * is the same arithmetic as painting the token at that alpha, which is what this does.
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
 * The members block, from its banner to the start of whatever section follows it.
 *
 * Bounded rather than run to the end of the file, for the reason `api-keys-css.test.ts`
 * records and HIVE-6.3 (#5314) made concrete: `globals.css` grows one section per redesign
 * ticket, and a slice that ended at EOF made every assertion below — the banned-palette walk
 * in particular — a claim about every *later* section too. The version-dialogs block spends
 * `var(--rose-soft)` on a lane chip, which contains the substring `rose-`, and this suite
 * reported it as a members regression.
 */
const MEMBER_SECTION = (() => {
  const start = css.indexOf('MEMBERS (HIVE-5.2, #5305)');
  if (start < 0) throw new Error('globals.css has no members section');
  const next = css.indexOf('/* =', start);
  return css.slice(start, next < 0 ? css.length : next);
})();

/** The same block with its comments removed. */
const MEMBER_SECTION_CODE = MEMBER_SECTION.replace(/\/\*[\s\S]*?\*\//g, '');

/* -------------------------------------------------------------------------
   1. The section exists, and names no colour
   ------------------------------------------------------------------------- */

describe('the members section of globals.css', () => {
  it('declares every rule the components reference', () => {
    const missing = MEMBER_PRELUDES.filter(
      (prelude) => !rules.some((rule) => rule.prelude === prelude)
    );
    expect(missing).toEqual([]);
  });

  it('sits after the unlayered h2 and p base rules it has to outrank', () => {
    for (const prelude of MEMBER_PRELUDES) {
      expect(memberRule(prelude).line).toBeGreaterThan(BASE_TYPE_RULE_LINE);
    }
  });

  it('names no colour — every hue resolves through the token layer', () => {
    for (const prelude of MEMBER_PRELUDES) {
      for (const [property, value] of parseDeclarations(memberRule(prelude).body)) {
        expect({ prelude, property, value }).toMatchObject({ prelude, property });
        expect(value).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        // `color-mix(in srgb, var(--warn) …)` is a token expression, not a colour: it names
        // no channel of its own. A literal `rgb(…)`/`hsl(…)` would be.
        expect(value.replace(/color-mix\([^)]*\)/g, '')).not.toMatch(
          /\b(?:rgb|rgba|hsl|hsla|oklch)\(/
        );
      }
    }
  });

  it('does not reintroduce the palette classes it replaced', () => {
    for (const banned of ['emerald-', 'amber-', 'rose-', 'purple-', 'indigo-', 'slate-', 'gray-']) {
      expect(MEMBER_SECTION_CODE).not.toContain(banned);
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
    // `1px` is exempt and only `1px`: a hairline is one device pixel by definition and must
    // not grow with the font scale.
    for (const prelude of MEMBER_PRELUDES) {
      for (const [property, value] of parseDeclarations(memberRule(prelude).body)) {
        const offending = value.match(/(?<!\d)(\d*\.?\d+)px/g)?.filter((px) => px !== '1px');
        expect({ prelude, property, offending: offending ?? [] }).toMatchObject({
          prelude,
          property,
          offending: [],
        });
      }
    }
  });

  it('sizes the role select in rem, not the mockup’s 150px, and lets it shrink', () => {
    expect(declaration('.mbr-role-select', 'inline-size')).toBe('9.5rem');
    // Without this it would hold its column open at 9.5rem inside a narrower table.
    expect(declaration('.mbr-role-select', 'max-inline-size')).toBe('100%');
  });

  it('takes its height from the shared control metric rather than naming one', () => {
    expect(declaration('.mbr-role-select', 'block-size')).toBe('var(--control-h-sm)');
  });

  it('spends spacing tokens rather than literal gaps, so Compact is genuinely compact', () => {
    for (const [prelude, property] of [
      ['.mbr-seat-strip', 'gap'],
      ['.mbr-identity', 'gap'],
      ['.mbr-kv', 'gap'],
      ['.mbr-idp-grid', 'gap'],
      ['.mbr-idp-card', 'padding'],
    ] as const) {
      expect(declaration(prelude, property)).toContain('var(--space-');
    }
  });

  it('draws every quiet line from the type scale', () => {
    for (const [prelude, expected] of [
      ['.mbr-seat-figure', 'var(--fs-sm)'],
      ['.mbr-identity__name', 'var(--fs-sm)'],
      ['.mbr-identity__sub', 'var(--fs-2xs)'],
      ['.mbr-identity__self', 'var(--fs-2xs)'],
      ['.mbr-role-select', 'var(--fs-xs)'],
      ['.mbr-kv', 'var(--fs-sm)'],
      ['.mbr-kv dt', 'var(--fs-xs)'],
      ['.mbr-caps', 'var(--fs-2xs)'],
      ['.mbr-tag', 'var(--fs-2xs)'],
      ['.mbr-activity', 'var(--fs-xs)'],
      ['.mbr-idp-card__desc', 'var(--fs-sm)'],
    ] as const) {
      expect(declaration(prelude, 'font-size')).toBe(expected);
    }
  });

  it('reuses the shared radii rather than inventing corners', () => {
    for (const prelude of ['.mbr-invite-mark', '.mbr-role-select', '.mbr-tag', '.mbr-idp-card']) {
      expect(declaration(prelude, 'border-radius')).toMatch(/^var\(--r-/);
    }
  });

  it('sizes the envelope mark’s glyph from the §3.5 icon vocabulary', () => {
    expect(declaration('.mbr-invite-mark > svg', 'inline-size')).toBe('var(--icon-dense)');
    expect(declaration('.mbr-invite-mark > svg', 'block-size')).toBe('var(--icon-dense)');
  });
});

/* -------------------------------------------------------------------------
   3. Nothing can scroll the document sideways
   ------------------------------------------------------------------------- */

describe('no horizontal document scroll at ≥1280px', () => {
  it('gives every content-bearing grid track a zero minimum', () => {
    // A grid track's automatic minimum is its *content*, so a long address or a long action
    // string would hold its column open at intrinsic width without this.
    for (const prelude of ['.mbr-seat-strip', '.mbr-kv', '.mbr-activity']) {
      expect(declaration(prelude, 'grid-template-columns')).toContain('minmax(0,');
    }
  });

  it('caps the identity cell, so the ellipsis below it can actually engage', () => {
    // A `<td>` in an auto-layout table grows to its content regardless of the `overflow:
    // hidden` inside it, so the elision is only reachable behind a ceiling.
    //
    // Spelled physically on purpose: measured in a browser, the build's CSS transform drops
    // `max-inline-size` from *this* rule (it survives in `.mbr-role-select`, which carries no
    // `min-width` beside it), and `e2e/hive-members.spec.ts` is what caught the difference
    // between a declaration this file can see and one the browser is actually given.
    expect(declaration('.mbr-identity', 'max-width')).toBe('22rem');
  });

  it('elides a long name and a long address rather than widening the User column', () => {
    for (const prelude of ['.mbr-identity__name', '.mbr-identity__sub']) {
      const decls = parseDeclarations(memberRule(prelude).body);
      expect(decls.get('overflow')).toBe('hidden');
      expect(decls.get('text-overflow')).toBe('ellipsis');
      expect(decls.get('white-space')).toBe('nowrap');
    }
    // Eliding only works if the text column may actually be narrower than its content.
    expect(declaration('.mbr-identity', 'min-width')).toBe('0');
    expect(declaration('.mbr-identity__text', 'min-width')).toBe('0');
  });

  it('elides a ledger action rather than pushing its timestamp off the row', () => {
    const decls = parseDeclarations(memberRule('.mbr-activity__action').body);
    expect(decls.get('min-width')).toBe('0');
    expect(decls.get('text-overflow')).toBe('ellipsis');
    expect(declaration('.mbr-activity__when', 'white-space')).toBe('nowrap');
  });

  it('breaks a long value in the membership list rather than widening the sheet', () => {
    const decls = parseDeclarations(memberRule('.mbr-kv dd').body);
    expect(decls.get('min-width')).toBe('0');
    expect(decls.get('word-break')).toBe('break-word');
  });

  it('lets the identity-provider cards reflow instead of overflowing a narrow drawer', () => {
    // `min(100%, 18rem)` is the whole point: a bare `minmax(18rem, 1fr)` overflows any
    // container narrower than 18rem, which is exactly where a reflow was wanted.
    expect(declaration('.mbr-idp-grid', 'grid-template-columns')).toBe(
      'repeat(auto-fit, minmax(min(100%, 18rem), 1fr))'
    );
  });

  it('lets the row’s action cluster wrap rather than overflow', () => {
    expect(declaration('.mbr-row-actions', 'flex-wrap')).toBe('wrap');
  });
});

/* -------------------------------------------------------------------------
   4. The responsive fallbacks are reachable
   ------------------------------------------------------------------------- */

describe('the responsive fallbacks', () => {
  it('uses @media, not @container — nothing above these rules is a container', () => {
    // A `@container` query with no `container-type` ancestor never matches at all, which is
    // the quiet way a "responsive" rule turns out to be dead code.
    expect(MEMBER_SECTION_CODE).not.toContain('@container');
  });

  it('stacks the seat strip before its figure is squeezed off the card', () => {
    const block = MEMBER_SECTION.match(/@media \(max-width: 40rem\) \{[\s\S]*?\n\}/)?.[0];
    expect(block).toBeDefined();
    expect(block).toContain('.mbr-seat-strip');
    expect(block).toContain('grid-template-columns: minmax(0, 1fr);');
  });

  it('stacks the membership list’s terms and values on a narrow sheet', () => {
    const block = MEMBER_SECTION.match(/@media \(max-width: 30rem\) \{[\s\S]*?\n\}/)?.[0];
    expect(block).toBeDefined();
    expect(block).toContain('.mbr-kv');
    expect(block).toContain('grid-template-columns: minmax(0, 1fr);');
  });
});

/* -------------------------------------------------------------------------
   5. A pending row is tinted, never faded
   ------------------------------------------------------------------------- */

describe('how a pending invitation is distinguished', () => {
  it('tints the row from the warn token rather than a second, hand-picked amber', () => {
    expect(declaration('.mbr-row--pending', 'background')).toBe(
      'color-mix(in srgb, var(--warn) 6%, transparent)'
    );
  });

  it('paints the envelope mark’s ink on the tint it was calibrated for', () => {
    expect(declaration('.mbr-invite-mark', 'background')).toBe('var(--warn-soft)');
    expect(declaration('.mbr-invite-mark', 'color')).toBe('var(--warn-fg)');
  });

  it.each(APPEARANCES)('clears AA for the envelope mark in %s', (_id, appearance) => {
    const surface = paint('--bg-surface', appearance, PAPER);
    const tint = paint('--warn-soft', appearance, surface);
    const ink = paint('--warn-fg', appearance, tint);
    expect(contrastRatio(ink, tint)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
  });

  it.each(APPEARANCES)('keeps body ink legible on the tinted row in %s', (_id, appearance) => {
    // The row tint sits under ordinary table ink, so what has to hold is `--fg` on it — a 6 %
    // wash of `--warn` over `--bg-surface`.
    const surface = paint('--bg-surface', appearance, PAPER);
    const tint = mixOver('--warn', appearance, surface, 6);
    const ink = paint('--fg', appearance, tint);
    expect(contrastRatio(ink, tint)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
  });

  it('spends no opacity anywhere in the block', () => {
    // The mockup fades a suspended row to 85 % and the identity-provider cards to 72 %.
    // HIVE-4.8 measured both: `--fg-muted` behind `opacity: .85` is 4.45:1 on paper, under
    // AA, because a fade dims the words along with the mark. A tint changes the backdrop and
    // not the ink, which is the one of the two that cannot fail a contrast check.
    for (const prelude of MEMBER_PRELUDES) {
      expect({ prelude, opacity: parseDeclarations(memberRule(prelude).body).get('opacity') })
        .toEqual({ prelude, opacity: undefined });
    }
  });
});

/* -------------------------------------------------------------------------
   6. Shared vocabulary, not a second spelling of it
   ------------------------------------------------------------------------- */

describe('what the block borrows rather than reinvents', () => {
  it('tracks its caps labels with the shared caps tracking', () => {
    for (const prelude of ['.mbr-kv dt', '.mbr-caps']) {
      expect(declaration(prelude, 'letter-spacing')).toBe('var(--track-caps)');
    }
  });

  it('draws its hairlines as the shared inset ring rather than a border', () => {
    for (const prelude of ['.mbr-idp-card']) {
      expect(declaration(prelude, 'box-shadow')).toBe('inset 0 0 0 1px var(--border)');
    }
  });

  it('leaves the role select’s hairline and focus ring to `.hive-control`', () => {
    // The components compose `hive-control mbr-role-select`, so this rule must not declare a
    // `box-shadow` of its own — it would be a second, unlayered answer to the same question.
    expect(parseDeclarations(memberRule('.mbr-role-select').body).has('box-shadow')).toBe(false);
    expect(parseDeclarations(memberRule('.mbr-role-select').body).has('border')).toBe(false);
  });

  it('quiets a disabled select with muted ink and a cursor, never by fading it', () => {
    const decls = parseDeclarations(memberRule('.mbr-role-select:disabled').body);
    expect(decls.get('color')).toBe('var(--fg-muted)');
    expect(decls.get('cursor')).toBe('not-allowed');
    expect(decls.has('opacity')).toBe(false);
  });

  it('draws a permission tag as a mono chip on the inset surface', () => {
    expect(declaration('.mbr-tag', 'font-family')).toBe('var(--font-mono)');
    expect(declaration('.mbr-tag', 'background')).toBe('var(--bg-inset)');
  });

  it('keeps the seat figure’s digits from jittering as seats are taken and returned', () => {
    expect(declaration('.mbr-seat-figure', 'font-variant-numeric')).toBe('tabular-nums');
  });
});
