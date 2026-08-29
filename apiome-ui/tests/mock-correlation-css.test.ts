/**
 * The stylesheet half of the response correlation editor (#5529, MSC-1.3).
 *
 * `mock-correlation-editor.test.tsx` renders the dialog and pins its markup; it cannot pin
 * anything that makes it *look* right, because jsdom compiles no stylesheet. So this suite reads
 * `globals.css` and pins what the components lean on:
 *
 *   1. **Every rule the components reference exists**, listed rather than pattern-matched so a
 *      renamed class fails here instead of silently dropping out of the checks below.
 *   2. **The skin is tokens only** — no hard-coded colour anywhere in the block, which is what
 *      keeps it correct in all nine appearances rather than in whichever one it was written in.
 *   3. **The choice control is scoped the way HIVE-2.1 requires**: the ring is raised by the
 *      radio's own focus and not by anything nested, because the chosen card carries a scrolling
 *      bindings preview and a focused control inside it must not light the whole card up.
 *   4. **A chosen card restates its ink**: the ground becomes `--accent-soft`, where the muted
 *      grey the description is normally painted in no longer measures.
 *   5. **Nothing can scroll the dialog sideways** — every list and body that can overflow owns its
 *      own scroll, and every flex child that holds text can shrink.
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

/**
 * The opaque colour a token resolves to in one appearance, flattened onto its backdrop.
 *
 * @param name - The token.
 * @param appearance - The theme block, or `undefined` for the light default.
 * @param backdrop - What is painted behind it.
 * @returns The resulting opaque channels.
 */
function paint(name: string, appearance: unknown, backdrop: Rgb): Rgb {
  return compositeOver(resolveThemeToken(name, tokens, appearance as never), backdrop);
}

/** Every top-level rule this ticket added, by prelude. */
const MSC_PRELUDES = [
  '.mock-corr__modes',
  '.mock-corr__mode',
  '.mock-corr__mode:hover',
  ".mock-corr__mode:has(input[type='radio']:checked)",
  ".mock-corr__mode:has(> input[type='radio']:focus-visible)",
  ".mock-corr__mode > input[type='radio']",
  '.mock-corr__mode-body',
  '.mock-corr__mode-title',
  '.mock-corr__mode-desc',
  '.mock-corr__inferred',
  '.mock-corr__inferred-op',
  '.mock-corr__inferred-key',
  '.mock-corr__inferred-rows',
  '.mock-corr__inferred-note',
  '.mock-corr__row',
  '.mock-corr__op',
  '.mock-corr__pointer',
  '.mock-corr__expression',
  '.mock-corr__row-errors',
  '.mock-tok',
  '.mock-tok__toggle',
  '.mock-tok__chevron--open',
  '.mock-tok__panel',
  '.mock-tok__group',
  '.mock-tok__group-title',
  '.mock-tok__chips',
  '.mock-tok__chip',
  '.mock-tok__chip:hover',
  '.mock-tok__chip:focus-visible',
  '.mock-prev',
  '.mock-prev__request',
  '.mock-prev__line',
  '.mock-prev__method',
  '.mock-prev__path',
  '.mock-prev__fields',
  '.mock-prev__field',
  '.mock-prev__textarea',
  '.mock-prev__result',
  '.mock-prev__trace',
  '.mock-prev__detail',
  '.mock-prev__body',
] as const;

/**
 * Look one of this ticket's rules up.
 *
 * @param prelude - The rule's selector, exactly as {@link MSC_PRELUDES} lists it.
 * @returns The rule.
 */
function mscRule(prelude: string): CssRule {
  const rule = rules.find((candidate) => candidate.prelude === prelude);
  if (!rule) throw new Error(`globals.css declares no rule \`${prelude}\``);
  return rule;
}

/**
 * Read one declaration out of one of this ticket's rules.
 *
 * @param prelude - The rule's selector.
 * @param property - The property to read.
 * @returns Its value, whitespace-collapsed.
 */
function declaration(prelude: string, property: string): string {
  const value = parseDeclarations(mscRule(prelude).body).get(property);
  if (value === undefined) throw new Error(`\`${prelude}\` declares no \`${property}\``);
  return value;
}

/**
 * The MSC-1.3 block, bounded by the section banner that follows it.
 *
 * Bounded rather than run to the end of the file, so nothing asserted here becomes a claim about
 * every later section too.
 */
const MSC_SECTION = (() => {
  const start = css.indexOf('8b · Response correlation, tokens & live preview');
  if (start < 0) throw new Error('globals.css has no MSC-1.3 section');
  const next = css.indexOf('/* ---- 9 · The test bench', start);
  return css.slice(start, next < 0 ? css.length : next);
})();

describe('the MSC-1.3 section of globals.css', () => {
  it('declares every rule the components reference', () => {
    const missing = MSC_PRELUDES.filter((prelude) => !rules.some((r) => r.prelude === prelude));
    expect(missing).toEqual([]);
  });

  it('names no colour outright', () => {
    const inSection = findUnfencedHex(css).filter(
      (hit) => css.indexOf(MSC_SECTION) <= hit.index && hit.index < css.indexOf(MSC_SECTION) + MSC_SECTION.length
    );
    expect(inSection).toEqual([]);
    // The other two ways a colour gets frozen into a block.
    expect(MSC_SECTION).not.toMatch(/\b(?:rgb|rgba|hsl|hsla)\(/);
    expect(MSC_SECTION).not.toMatch(/:\s*(?:white|black|red|green|blue|gray|grey)\b/);
  });

  it('spends every colour through a token', () => {
    for (const property of ['background', 'color', 'box-shadow', 'outline', 'accent-color']) {
      const declarations = [...MSC_SECTION.matchAll(new RegExp(`${property}:\\s*([^;]+);`, 'g'))];
      for (const [, value] of declarations) {
        if (value.trim() === 'none') continue;
        expect(value).toMatch(/var\(--/);
      }
    }
  });
});

describe('the mode cards follow the HIVE-2.1 scoped choice-control pattern', () => {
  it('raises the ring from the radio itself, never from a nested control', () => {
    // The chosen card holds a scrolling bindings preview; `:has(input:focus-visible)` without the
    // child combinator would light the whole card up when anything inside it took focus.
    const prelude = ".mock-corr__mode:has(> input[type='radio']:focus-visible)";
    expect(mscRule(prelude).prelude).toContain('> input');
    expect(declaration(prelude, 'outline')).toContain('var(--focus-ring)');
  });

  it('tints the chosen card and restates the ink that sits on the tint', () => {
    expect(declaration(".mock-corr__mode:has(input[type='radio']:checked)", 'background')).toBe(
      'var(--accent-soft)'
    );
    const inkRule = rules.find(
      (rule) =>
        rule.prelude.includes('.mock-corr__mode-title') &&
        rule.prelude.includes(":has(input[type='radio']:checked)")
    );
    expect(inkRule).toBeDefined();
    expect(parseDeclarations(inkRule!.body).get('color')).toBe('var(--accent-fg)');
  });

  it('restates the nested preview’s own surface so it does not read as description', () => {
    expect(declaration('.mock-corr__inferred', 'background')).toBe('var(--bg-surface)');
  });
});

describe('nothing can scroll the dialog sideways', () => {
  it('gives every list and body that can overflow its own scroll', () => {
    expect(declaration('.mock-corr__inferred', 'overflow-y')).toBe('auto');
    expect(declaration('.mock-tok__panel', 'overflow-y')).toBe('auto');
    expect(declaration('.mock-prev__body', 'overflow')).toBe('auto');
  });

  it('lets every flex child that holds text shrink below its content', () => {
    // Without `min-inline-size: 0` a flex item refuses to shrink past its longest unbroken token,
    // which for a mono operation key or a JSON body is wider than the dialog.
    for (const prelude of [
      '.mock-corr__mode-body',
      '.mock-corr__op',
      '.mock-corr__pointer',
      '.mock-corr__expression',
      '.mock-prev__path',
      '.mock-prev__field',
    ]) {
      expect(declaration(prelude, 'min-inline-size')).toBe('0');
    }
  });

  it('wraps an unbreakable operation key and body rather than widening the panel', () => {
    expect(declaration('.mock-prev__body', 'overflow-wrap')).toBe('anywhere');
    // Preludes are whitespace-collapsed by the reader, so the two-selector rule is one string.
    const media = mscRule('.mock-prev__media, .mock-prev__op');
    expect(parseDeclarations(media.body).get('overflow-wrap')).toBe('anywhere');
  });

  it('collapses the preview’s request fields before the dialog can scroll', () => {
    expect(declaration('.mock-prev__fields', 'grid-template-columns')).toContain('auto-fit');
  });
});

describe('nothing is frozen in pixels', () => {
  it('measures every length in rem or a spacing token', () => {
    // `box-shadow` and `outline` are exempt: a 1px inset ring and a 2px focus outline are the
    // shared vocabulary's hairlines, spelled that way everywhere in this stylesheet, and scaling
    // them with the type size would thicken every border on the page.
    const offenders: string[] = [];
    for (const prelude of MSC_PRELUDES) {
      for (const [property, value] of parseDeclarations(mscRule(prelude).body)) {
        if (property === 'box-shadow' || property === 'outline' || property === 'outline-offset') {
          continue;
        }
        if (/\d+px/.test(value)) offenders.push(`${prelude} { ${property}: ${value} }`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/* -------------------------------------------------------------------------
   Every ink is measured against the ground it actually lands on
   ------------------------------------------------------------------------- */

describe('contrast, in all nine appearances', () => {
  it.each(APPEARANCES)('the chosen mode card clears AA in the %s appearance', (_id, block) => {
    // The pair `version-dialogs-css.test.ts` exempts by name: the tint is on the card, the ink on
    // its children, which is what the HIVE-2.1 scoped choice control requires. Measured here so the
    // exemption rests on a number rather than on the pattern's say-so.
    const surface = paint('--bg-surface', block, PAPER);
    const tint = paint('--accent-soft', block, surface);
    expect(contrastRatio(paint('--accent-fg', block, tint), tint)).toBeGreaterThanOrEqual(
      WCAG_AA_NORMAL_TEXT_MIN
    );
  });

  it.each(APPEARANCES)('a row’s errors clear AA in the %s appearance', (_id, block) => {
    // `--danger-fg` is calibrated against `--danger-soft` and against nothing else: on the plain
    // `--bg-subtle` override panel it measures 1.26:1 in Nord, which is why the row's messages
    // carry the tint rather than sitting on the panel.
    const surface = paint('--bg-surface', block, PAPER);
    const subtle = paint('--bg-subtle', block, surface);
    const tint = paint('--danger-soft', block, subtle);
    expect(contrastRatio(paint('--danger-fg', block, tint), tint)).toBeGreaterThanOrEqual(
      WCAG_AA_NORMAL_TEXT_MIN
    );
  });

  it.each(APPEARANCES)('the quiet lines clear AA in the %s appearance', (_id, block) => {
    // The token panel, the bindings preview and the preview's trace lines are all `--fg-muted` on
    // `--bg-surface`. They are raised cards rather than `--bg-subtle` tints for exactly this
    // reason: the same ink measures 4.35:1 on `--bg-subtle` in Solarized, just under AA.
    const surface = paint('--bg-surface', block, PAPER);
    expect(contrastRatio(paint('--fg-muted', block, surface), surface)).toBeGreaterThanOrEqual(
      WCAG_AA_NORMAL_TEXT_MIN
    );
  });

  it('keeps those quiet surfaces off the tint the measurement rules out', () => {
    for (const prelude of ['.mock-tok__panel', '.mock-prev__result', '.mock-corr__inferred']) {
      expect({ prelude, background: declaration(prelude, 'background') }).toEqual({
        prelude,
        background: 'var(--bg-surface)',
      });
    }
  });
});
