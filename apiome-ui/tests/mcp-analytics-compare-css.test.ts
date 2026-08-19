/**
 * The stylesheet half of the MCP analytics / capabilities / compare redesign (HIVE-7.9, #5326).
 *
 * The three `*-hive-redesign` suites render the screens and pin their markup; none of them can pin
 * anything that makes those screens *look* right, because jsdom compiles no stylesheet. So this
 * suite reads `globals.css` the way `mcp-catalog-css.test.ts` and `mcp-endpoint-detail-css.test.ts`
 * do, and pins what the three surfaces lean on:
 *
 *   1. **The skin is tokens only.** What this replaces named colour outright — the analytics
 *      tiles' `rounded-xl border border-gray-200 bg-white dark:bg-gray-800` frame repeated eight
 *      times, the leaderboards' `text-indigo-600 hover:underline` names, the directory's
 *      `text-indigo-600 dark:text-indigo-400` sort headers over a `divide-gray-200` table, the
 *      comparison's `bg-amber-50/60 dark:bg-amber-900/10` differing row and its
 *      `border-amber-300 bg-amber-50 text-amber-900` protocol banner, and the picker's
 *      `accent-indigo-600` boxes over `border-indigo-300 bg-indigo-50` selected rows. Every one
 *      froze the surface on one light palette and one dark one.
 *   2. **Nothing is frozen in pixels.** The mockups fix the donut at 112px with a 14px hole, the
 *      legend swatch at 10px, the rank medallion at 22px, the bar strip at 96px, the compare aside
 *      at 340px with a `top: 150px` sticky offset, and the radar at 120px; all are `rem`, `em`, a
 *      token or an intrinsic grid here.
 *   3. **Every multi-column grid collapses**, so no panel on these three routes can scroll the
 *      document sideways at any font scale — and the one element that *may* scroll is a card.
 *   4. **Quiet text is `--fg-muted`**, not the mockups' `--fg-subtle`, measured in all nine
 *      appearances on each ground it lands on.
 *   5. **The two hovers land on `--bg-inset`**, not the mockups' `--bg-subtle`: both a hovered
 *      preset tile and a hovered picker row carry a muted second line, and only one of the two
 *      grounds clears AA under it.
 *   6. **A chosen thing is a hairline, not a fill** — `--fg-muted` on `--accent-soft` fails in
 *      Solarized, which is why the selected preset and the ticked picker row keep the surface.
 *   7. **The differing-row wash is emphasis, never the only signal** — measured, and recorded as a
 *      stated limit rather than left to be discovered.
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

/** WCAG AA for a non-text mark (a hairline, a rule, a dot). */
const WCAG_AA_NON_TEXT_MIN = 3;

/** Pure white, the last thing behind every surface. */
const PAPER: Rgb = { r: 255, g: 255, b: 255 };

/**
 * Every top-level rule this ticket added, by prelude.
 *
 * Listed rather than pattern-matched so a rule that is *renamed* fails here instead of silently
 * dropping out of the token-only walk below.
 */
const PRELUDES = [
  // Catalog analytics
  '.mcpa',
  '.mcpa-row',
  '.mcpa-row--pair',
  '.mcpa-tile__title',
  '.mcpa-tile__title > svg',
  '.mcpa-tile__unit',
  '.mcpa-card__head',
  '.mcpa-donut',
  '.mcpa-donut__ring',
  '.mcpa-legend',
  '.mcpa-legend__row',
  '.mcpa-legend__empty',
  '.mcpa-legend__swatch',
  '.mcpa-legend__label',
  '.mcpa-legend__value',
  '.mcpa-legend__pct',
  '.mcpa-bars',
  '.mcpa-axis',
  '.mcpa-counts',
  '.mcpa-counts__value',
  '.mcpa-ranks',
  '.mcpa-rank',
  '.mcpa-rank:first-child',
  '.mcpa-rank__pos',
  '.mcpa-rank__name',
  '.mcpa-rank__value',
  '.mcpa-note',
  // Capability directory
  '.mcpc-section-title',
  '.mcpc-section-title > h2',
  '.mcpc-section-title > span',
  '.mcpc-presets',
  '.mcpc-preset',
  '.mcpc-preset:hover',
  '.mcpc-preset[aria-pressed="true"]',
  '.mcpc-preset__body',
  '.mcpc-preset__label',
  '.mcpc-preset__desc',
  '.mcpc-toolbar',
  '.mcpc-toolbar > *',
  '.mcpc-toolbar__pair',
  '.mcpc-toolbar__range',
  '.mcpc-name',
  '.mcpc-desc',
  '.mcpc-server',
  '.mcpc-server:hover',
  '.mcpc-server__name',
  '.mcpc-host',
  // Server comparison
  '.mcpx-layout',
  '.mcpx-picker',
  '.mcpx-picker__body',
  '.mcpx-picker__foot',
  '.mcpx-picks',
  '.mcpx-pick',
  '.mcpx-pick:hover',
  '.mcpx-pick[data-selected]',
  '.mcpx-pick[data-at-cap]',
  '.mcpx-pick__body',
  '.mcpx-pick__name',
  '.mcpx-pick__sub',
  '.mcpx-results',
  '.mcpx-panel',
  '.mcpx-table-card',
  '.mcpx-scroll',
  '.mcpx-table',
  '.mcpx-table thead th',
  '.mcpx-metric',
  '.mcpx-metric--head',
  '.mcpx-value',
  '.mcpx-col',
  '.mcpx-col__id',
  '.mcpx-col__name',
  '.mcpx-col__sub',
  '.mcpx-col__chips',
  '.mcpx-section > th',
  '.mcpx-radar',
  '.mcpx-gap',
  '.mcpx-table-foot',
  '.mcpx-card__head',
  '.mcpx-card__title',
  '.mcpx-card__title > svg',
  '.mcpx-card__note',
  '.mcpx-overlap',
  '.mcpx-matrix',
  '.mcpx-matrix thead th',
  '.mcpx-matrix__server',
  '.mcpx-matrix__cell',
  '.mcpx-present',
  '.mcpx-absent',
  '.mcpx-note',
  '.mcpx-unique',
  '.mcpx-unique__card',
  '.mcpx-unique__title',
  '.mcpx-unique__list',
] as const;

/** The rules this ticket declares under more than one selector at once. */
const GROUPED_PRELUDES = [
  'a.mcpa-rank__name,\n.mcpa-link',
  'a.mcpa-rank__name:hover,\n.mcpa-link:hover',
  '.mcpx-table th,\n.mcpx-table td',
  '.mcpx-differs > th,\n.mcpx-differs > td',
  '.mcpx-matrix th,\n.mcpx-matrix td',
] as const;

/**
 * This ticket's block, from its banner to the next one (or the end of the file).
 *
 * Bounded at both ends deliberately, as `mcp-endpoint-detail-css.test.ts` records: a block that is
 * only bounded at the start silently grows to include whatever is appended after it. The three
 * screens share one banner and divide it with `/* ---- ... ----` sub-headings rather than with
 * further `===` banners, precisely so this bound stays one block wide.
 */
const SECTION = (() => {
  const start = css.indexOf('MCP ANALYTICS · CAPABILITIES · COMPARE  (HIVE-7.9, #5326)');
  if (start < 0) throw new Error('globals.css has no MCP analytics/capabilities/compare section');
  const bannerStart = css.lastIndexOf('/* =', start);
  const next = css.indexOf('/* =', start + 1);
  return css.slice(bannerStart < 0 ? start : bannerStart, next < 0 ? css.length : next);
})();

/** The same block with its comments removed. */
const BLOCK_CODE = SECTION.replace(/\/\*[\s\S]*?\*\//g, '');

/** The first line of this ticket's block, so its rules can be found by position. */
const SECTION_FIRST_LINE = css.slice(0, css.indexOf(SECTION)).split('\n').length;

/** The line after it. */
const SECTION_LAST_LINE = SECTION_FIRST_LINE + SECTION.split('\n').length;

/** Every top-level rule declared in this ticket's block. */
const SECTION_RULES: CssRule[] = rules.filter(
  (rule) => rule.line >= SECTION_FIRST_LINE && rule.line < SECTION_LAST_LINE
);

/** A selector with its line breaks and runs of spaces collapsed, so a grouped rule compares. */
function normalise(prelude: string): string {
  return prelude.replace(/\s+/g, ' ').trim();
}

/**
 * Look one of this ticket's rules up.
 *
 * @param prelude The rule's selector, as the lists above spell it. Whitespace is insignificant,
 *   because a rule grouping two selectors is authored across two lines.
 * @returns The rule.
 */
function sectionRule(prelude: string): CssRule {
  const wanted = normalise(prelude);
  const rule = SECTION_RULES.find((candidate) => normalise(candidate.prelude) === wanted);
  if (!rule) throw new Error(`the HIVE-7.9 block declares no rule \`${prelude}\``);
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
  const value = parseDeclarations(sectionRule(prelude).body).get(property);
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

/* -------------------------------------------------------------------------
   1. The section exists, and names no colour
   ------------------------------------------------------------------------- */

describe('the HIVE-7.9 section of globals.css', () => {
  it('declares every rule the three screens reference', () => {
    const declared = new Set(SECTION_RULES.map((rule) => normalise(rule.prelude)));
    const missing = [...PRELUDES, ...GROUPED_PRELUDES].filter(
      (prelude) => !declared.has(normalise(prelude))
    );
    expect(missing).toEqual([]);
  });

  it('spells no hex literal outside the allow-list', () => {
    expect(findUnfencedHex(SECTION)).toEqual([]);
  });

  it('names no colour keyword and no raw rgb()/hsl()', () => {
    expect(BLOCK_CODE).not.toMatch(/:\s*(?:red|green|blue|orange|purple|gold|teal)\b/);
    expect(BLOCK_CODE).not.toMatch(/\b(?:rgba?|hsla?)\(/);
  });

  it('draws no colour except through a role token, a mix of them, or an inherited one', () => {
    const colourish = [...BLOCK_CODE.matchAll(/\b(?:color|background)\s*:\s*([^;]+);/g)].map(
      (match) => match[1].trim()
    );
    expect(colourish.length).toBeGreaterThan(20);
    for (const value of colourish) {
      expect({
        value,
        ok: /^(var\(--|color-mix\(|currentColor|transparent|inherit|none)/.test(value),
      }).toEqual({ value, ok: true });
    }
  });

  it('names no status of its own — the shared vocabulary paints every tone', () => {
    // The grade glyph, the transport chip, the capability-kind badge and the preset tile's own
    // icon square all resolve through `ui/statusVocabulary` or the borrowed `.tnt-icon-tile`.
    expect(BLOCK_CODE).not.toMatch(/data-status/);
    expect(BLOCK_CODE).not.toMatch(/data-grade/);
    expect(BLOCK_CODE).not.toMatch(/data-tone/);
  });
});

/* -------------------------------------------------------------------------
   2. Nothing is frozen in pixels
   ------------------------------------------------------------------------- */

describe('the eleven measurements the mockups froze in pixels', () => {
  it('states no px length anywhere in the block', () => {
    // `1px` hairlines are the one exception every sibling block makes: a rule is a device pixel,
    // not a typographic measure, and scaling it produces a blurry 1.5px line.
    const lengths = [...BLOCK_CODE.matchAll(/(\d+(?:\.\d+)?)px/g)].map((match) => match[1]);
    expect(lengths.every((value) => value === '1')).toBe(true);
  });

  it('sizes the donut and the radar in rem, not the mockups’ 112px / 120px', () => {
    expect(declaration('.mcpa-donut__ring', 'inline-size')).toBe('7rem');
    expect(declaration('.mcpx-radar', 'inline-size')).toBe('7rem');
  });

  it('sizes the legend swatch and the rank medallion in em, so both scale with their line', () => {
    expect(declaration('.mcpa-legend__swatch', 'inline-size')).toBe('0.75em');
    expect(declaration('.mcpa-rank__pos', 'inline-size')).toBe('1.5em');
    expect(declaration('.mcpx-present', 'inline-size')).toBe('1em');
  });

  it('sizes the bar strip in rem, not the mockup’s 96px', () => {
    expect(declaration('.mcpa-bars', 'block-size')).toBe('6rem');
  });

  it('sizes the compare aside in rem, not the mockup’s 340px', () => {
    expect(BLOCK_CODE).toContain('minmax(0, 21rem) minmax(0, 1fr)');
    expect(declaration('.mcpx-picker__body', 'max-block-size')).toBe('16rem');
  });

  it('offsets the sticky picker from a token, not the mockup’s top: 150px', () => {
    // Measured from `.page`, which already begins under the sticky page header — a second
    // header's worth of offset would push the picker's first row off the top at Compact density.
    expect(BLOCK_CODE).toContain('inset-block-start: var(--space-4)');
    expect(BLOCK_CODE).not.toMatch(/inset-block-start:\s*\d+px/);
  });

  it('sizes every tile glyph from the type scale rather than a fixed box', () => {
    expect(declaration('.mcpa-tile__title > svg', 'inline-size')).toBe('var(--fs-md)');
    expect(declaration('.mcpx-card__title > svg', 'inline-size')).toBe('var(--fs-md)');
  });

  it('keeps the metric table’s column widths as proportions, which are not frozen sizes', () => {
    expect(declaration('.mcpx-metric', 'inline-size')).toBe('28%');
    expect(declaration('.mcpx-col', 'inline-size')).toBe('24%');
    // …but the server column still has a floor, so three columns of figures never crush.
    expect(declaration('.mcpx-col', 'min-inline-size')).toBe('9rem');
  });

  it('states every other length in rem, em, %, ch or a token', () => {
    const lengths = [...BLOCK_CODE.matchAll(/:\s*[^;]*?(\d+(?:\.\d+)?)(px|pt|cm|in)\b/g)];
    expect(lengths.map((match) => `${match[1]}${match[2]}`).filter((value) => value !== '1px')).toEqual(
      []
    );
  });
});

/* -------------------------------------------------------------------------
   3. Every multi-column grid collapses
   ------------------------------------------------------------------------- */

describe('no panel on these three routes can scroll the document sideways', () => {
  const AUTO_FIT = ['.mcpa-row', '.mcpa-row--pair', '.mcpc-presets', '.mcpx-unique'] as const;

  it.each(AUTO_FIT)('%s is an auto-fit track that folds on its own', (prelude) => {
    const value = declaration(prelude, 'grid-template-columns');
    expect(value).toMatch(/^repeat\(auto-fit, minmax\(min\(100%, [\d.]+rem\), 1fr\)\)$/);
  });

  it('the compare split is one column until a min-width query widens it', () => {
    expect(declaration('.mcpx-layout', 'grid-template-columns')).toBe('minmax(0, 1fr)');
    expect(BLOCK_CODE).toContain('@media (min-width: 64rem)');
    expect(BLOCK_CODE).not.toMatch(/@media\s*\(max-width/);
  });

  it('lets exactly one element scroll sideways, and it is a card rather than the document', () => {
    expect(declaration('.mcpx-scroll', 'overflow-x')).toBe('auto');
    expect(declaration('.mcpx-scroll', 'min-inline-size')).toBe('0');
    // Every column that holds one carries `min-inline-size: 0`, which is what stops an intrinsic
    // minimum from holding the grid open at its content width.
    for (const prelude of ['.mcpx-results', '.mcpx-panel', '.mcpx-picker', '.mcpc-toolbar > *']) {
      expect(declaration(prelude, 'min-inline-size')).toBe('0');
    }
  });

  it('breaks the three unbreakable strings anywhere rather than scrolling', () => {
    // A mono identifier, a host and a tool name have no spaces to break at.
    for (const prelude of ['.mcpc-desc', '.mcpc-host', '.mcpx-unique__list']) {
      expect(declaration(prelude, 'overflow-wrap')).toBe('anywhere');
    }
  });
});

/* -------------------------------------------------------------------------
   4. Quiet text is `--fg-muted`, in all nine appearances
   ------------------------------------------------------------------------- */

describe('quiet text clears AA on every ground it lands on', () => {
  /** Every `--fg-muted` line in the block, with the ground it is drawn on. */
  const MUTED_ON: ReadonlyArray<readonly [string, string]> = [
    ['.mcpa-tile__unit', '--bg-surface'],
    ['.mcpa-axis', '--bg-surface'],
    ['.mcpa-counts', '--bg-surface'],
    ['.mcpa-rank__value', '--bg-surface'],
    ['.mcpa-rank__pos', '--bg-inset'],
    ['.mcpa-note', '--bg-surface'],
    ['.mcpc-preset__desc', '--bg-surface'],
    ['.mcpc-toolbar__range', '--bg-surface'],
    ['.mcpc-host', '--bg-surface'],
    ['.mcpx-pick__sub', '--bg-surface'],
    ['.mcpx-metric', '--bg-surface'],
    // The two grounds the browser sweep found before this suite did: the metric table's header
    // strip and its section rules both carry `--fg-muted`, and both sit on their own fill.
    ['.mcpx-col__sub', '--bg-inset'],
    ['.mcpx-section > th', '--bg-inset'],
    ['.mcpx-gap', '--bg-surface'],
    ['.mcpx-table-foot', '--bg-surface'],
    ['.mcpx-card__note', '--bg-surface'],
    ['.mcpx-note', '--bg-surface'],
    // On the surface behind a `Card variant="flat"` hairline, not the mockup's tinted `card--soft`.
    ['.mcpx-unique__list', '--bg-surface'],
  ];

  it.each(MUTED_ON)('%s draws its quiet line in --fg-muted, not --fg-subtle', (prelude) => {
    expect(declaration(prelude, 'color')).toBe('var(--fg-muted)');
  });

  it.each(MUTED_ON)('%s clears 4.5:1 in all nine appearances on %s', (prelude, ground) => {
    void prelude;
    for (const [id, appearance] of APPEARANCES) {
      const background = paint(ground, appearance, PAPER);
      const ratio = contrastRatio(paint('--fg-muted', appearance, background), background);
      expect({ theme: id, ratio: Number(ratio.toFixed(2)) }).toEqual({
        theme: id,
        ratio: expect.any(Number),
      });
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
    }
  });

  it('never paints --fg-muted onto --bg-subtle, the one ground that fails under it', () => {
    // Every fill this block declares, so a *new* one has to be measured rather than added
    // quietly. `--bg-subtle` measures 4.34:1 under `--fg-muted` in Solarized, which is what the
    // browser sweep caught on the metric table's header strip and on its section rules.
    const fills = [...BLOCK_CODE.matchAll(/background:\s*var\(--bg-([a-z]+)\)/g)].map(
      (match) => match[1]
    );
    expect(new Set(fills)).toEqual(new Set(['surface', 'inset']));
  });

  it('spends `--fg-faint` on exactly one mark, and that mark is announced in words', () => {
    // The "absent" cell of the shared-tool matrix; the cell carries `aria-label="absent"`.
    const faint = [...BLOCK_CODE.matchAll(/color:\s*var\(--fg-faint\)/g)];
    expect(faint).toHaveLength(1);
    expect(declaration('.mcpx-absent', 'color')).toBe('var(--fg-faint)');
  });

  it('never spends `--fg-subtle` on a line of copy', () => {
    expect(BLOCK_CODE).not.toContain('var(--fg-subtle)');
  });
});

/* -------------------------------------------------------------------------
   5. The two hovers land on `--bg-inset`
   ------------------------------------------------------------------------- */

describe('a hovered row keeps its muted second line legible', () => {
  const HOVERS = ['.mcpc-preset:hover', '.mcpx-pick:hover'] as const;

  it.each(HOVERS)('%s hovers onto --bg-inset, not the mockups’ --bg-subtle', (prelude) => {
    expect(declaration(prelude, 'background')).toBe('var(--bg-inset)');
  });

  it('is the ground that clears AA under --fg-muted in every theme, unlike --bg-subtle', () => {
    let subtleFails = 0;
    for (const [, appearance] of APPEARANCES) {
      const inset = paint('--bg-inset', appearance, PAPER);
      expect(contrastRatio(paint('--fg-muted', appearance, inset), inset)).toBeGreaterThanOrEqual(
        WCAG_AA_NORMAL_TEXT_MIN
      );

      const subtle = paint('--bg-subtle', appearance, PAPER);
      if (contrastRatio(paint('--fg-muted', appearance, subtle), subtle) < WCAG_AA_NORMAL_TEXT_MIN) {
        subtleFails += 1;
      }
    }
    // Solarized is the one HIVE-6.5 recorded; if this ever reaches zero the deviation can be
    // reconsidered rather than carried forward by habit.
    expect(subtleFails).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------
   6. A chosen thing is a hairline, not a fill
   ------------------------------------------------------------------------- */

describe('a chosen preset and a ticked picker row', () => {
  const CHOSEN = ['.mcpc-preset[aria-pressed="true"]', '.mcpx-pick[data-selected]'] as const;

  it.each(CHOSEN)('%s is an --accent hairline over the surface, not an accent fill', (prelude) => {
    expect(declaration(prelude, 'box-shadow')).toBe('inset 0 0 0 1px var(--accent)');
    // No `background` at all: the row keeps whatever surface it was on.
    expect(parseDeclarations(sectionRule(prelude).body).has('background')).toBe(false);
  });

  it('clears the 3:1 non-text floor in all nine appearances', () => {
    for (const [id, appearance] of APPEARANCES) {
      const surface = paint('--bg-surface', appearance, PAPER);
      const ratio = contrastRatio(paint('--accent', appearance, surface), surface);
      expect({ theme: id, ok: ratio >= WCAG_AA_NON_TEXT_MIN }).toEqual({ theme: id, ok: true });
    }
  });

  it('is why the fill was rejected: --fg-muted on --accent-soft fails somewhere', () => {
    let softFails = 0;
    for (const [, appearance] of APPEARANCES) {
      const soft = paint('--accent-soft', appearance, PAPER);
      if (contrastRatio(paint('--fg-muted', appearance, soft), soft) < WCAG_AA_NORMAL_TEXT_MIN) {
        softFails += 1;
      }
    }
    expect(softFails).toBeGreaterThan(0);
  });

  it('says "at the cap" with a real disabled control as well as with opacity', () => {
    // Opacity alone is not a state a reader can query; the box is genuinely `disabled` and the
    // row carries the mockup's own `title`.
    expect(declaration('.mcpx-pick[data-at-cap]', 'cursor')).toBe('not-allowed');
    expect(declaration('.mcpx-pick[data-at-cap]', 'opacity')).toBe('0.55');
  });
});

/* -------------------------------------------------------------------------
   7. The differing-row wash, and its stated limit
   ------------------------------------------------------------------------- */

describe('the differing-row wash', () => {
  const DIFFERS = '.mcpx-differs > th,\n.mcpx-differs > td';

  it('mixes --warn into the surface rather than into an unknown ground', () => {
    expect(declaration(DIFFERS, 'background')).toBe(
      'color-mix(in srgb, var(--warn) 9%, var(--bg-surface))'
    );
  });

  it('keeps --fg legible on top of it in all nine appearances', () => {
    for (const [id, appearance] of APPEARANCES) {
      const surface = paint('--bg-surface', appearance, PAPER);
      const warn = paint('--warn', appearance, surface);
      // 9% of `--warn` over the surface, composited by hand.
      const washed: Rgb = {
        r: Math.round(warn.r * 0.09 + surface.r * 0.91),
        g: Math.round(warn.g * 0.09 + surface.g * 0.91),
        b: Math.round(warn.b * 0.09 + surface.b * 0.91),
      };
      const ratio = contrastRatio(paint('--fg', appearance, washed), washed);
      expect({ theme: id, ok: ratio >= WCAG_AA_NORMAL_TEXT_MIN }).toEqual({ theme: id, ok: true });
    }
  });

  it('is under the 3:1 non-text floor against the row beside it — the stated limit', () => {
    // Recorded rather than hidden: this is why the table's foot prints the convention in words
    // and every differing row carries `data-differs` for the browser sweep to read.
    for (const [id, appearance] of APPEARANCES) {
      const surface = paint('--bg-surface', appearance, PAPER);
      const warn = paint('--warn', appearance, surface);
      const washed: Rgb = {
        r: Math.round(warn.r * 0.09 + surface.r * 0.91),
        g: Math.round(warn.g * 0.09 + surface.g * 0.91),
        b: Math.round(warn.b * 0.09 + surface.b * 0.91),
      };
      expect({ theme: id, mark: contrastRatio(washed, surface) < WCAG_AA_NON_TEXT_MIN }).toEqual({
        theme: id,
        mark: true,
      });
    }
    expect(SECTION).toContain('emphasis and never the only signal');
  });

  it('marks the presence check in --ok, which does clear the non-text floor', () => {
    expect(declaration('.mcpx-present', 'color')).toBe('var(--ok)');
    for (const [id, appearance] of APPEARANCES) {
      const surface = paint('--bg-surface', appearance, PAPER);
      const ratio = contrastRatio(paint('--ok', appearance, surface), surface);
      expect({ theme: id, ok: ratio >= WCAG_AA_NON_TEXT_MIN }).toEqual({ theme: id, ok: true });
    }
  });
});

/* -------------------------------------------------------------------------
   8. Links are `--accent-fg`, which is the only semantic ink that clears AA
   ------------------------------------------------------------------------- */

describe('every link on the three routes', () => {
  it('draws its ink from --accent-fg, never the saturated --accent', () => {
    expect(declaration('a.mcpa-rank__name,\n.mcpa-link', 'color')).toBe('var(--accent-fg)');
    expect(declaration('.mcpc-server', 'color')).toBe('var(--accent-fg)');
  });

  it('clears AA as text in all nine appearances', () => {
    for (const [id, appearance] of APPEARANCES) {
      const surface = paint('--bg-surface', appearance, PAPER);
      const ratio = contrastRatio(paint('--accent-fg', appearance, surface), surface);
      expect({ theme: id, ok: ratio >= WCAG_AA_NORMAL_TEXT_MIN }).toEqual({ theme: id, ok: true });
    }
  });

  it('underlines on hover, so colour is not the only thing marking a link', () => {
    expect(declaration('a.mcpa-rank__name:hover,\n.mcpa-link:hover', 'text-decoration')).toBe(
      'underline'
    );
    expect(declaration('.mcpc-server:hover', 'text-decoration')).toBe('underline');
  });
});
