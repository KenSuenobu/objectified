/**
 * The stylesheet half of the lint posture workspace redesign (HIVE-5.8, #5311).
 *
 * `lint-workspace-hive-redesign.test.tsx` renders the screen and pins its markup; it cannot
 * pin anything that makes it *look* right, because jsdom compiles no stylesheet. So this
 * suite reads `globals.css` the way `audit-css.test.ts` and `style-guides-css.test.ts` do,
 * and pins what the components lean on:
 *
 *   1. **The skin is tokens only.** What this replaced named colour outright in more than
 *      forty places — `text-rose-600`, `bg-indigo-50`, `border-amber-200`, `bg-violet-500`,
 *      each doubled for dark mode. Every one froze the surface on one palette, and several
 *      disagreed with the shared vocabulary about the same state.
 *   2. **Where a *band* or a *tone* decides the colour, this section says nothing at all.**
 *      The grade tiles, the histogram bars and the report's letter take
 *      `GRADE_BANDS[…].solidClass`; the badges take their status tone. A rule here that also
 *      painted them would be a second opinion.
 *   3. **Nothing is frozen in pixels.** The mockup's page-local block fixes the Finding
 *      column at 400px, the search field at 300px, four selects at 120–150px, the owner
 *      field at 180px, the grade chip at 48px, the rank bars at 44px and the split bar at
 *      8px. All are `rem` or a token here, so they follow all six font scales.
 *   4. **The inverted bulk bar paints from its own ink**, so its rule and its owner field
 *      read the same on the six dark palettes as on the three light ones — which a fixed
 *      white overlay would not.
 *   5. **Nothing can scroll the document sideways**: the widest cell has a ceiling, the
 *      message clamps, the digest wraps, and every three-way grid collapses at a breakpoint
 *      stated in `em` so it travels with the font-size preference.
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

/** The line the unlayered `p` base rule is declared on, found rather than assumed. */
const BASE_TYPE_RULE_LINE = (() => {
  const rule = rules.find((candidate) => candidate.prelude === 'p');
  if (!rule) throw new Error('globals.css no longer declares a bare `p` rule');
  return rule.line;
})();

/**
 * Every top-level rule this ticket added, by prelude.
 *
 * Listed rather than pattern-matched so a rule that is *renamed* fails here instead of
 * silently dropping out of the token-only walk below.
 */
const LINT_PRELUDES = [
  '.lw-caps',
  '.lw-caps__aside',
  '.lw-quiet',
  '.lw-inline',
  '.lw-tab-glyph',
  '.lw-summary',
  '.lw-tile',
  '.lw-tile:hover',
  '.lw-tile__callout',
  '.lw-tile-skeleton',
  '.lw-tile-skeleton__label',
  '.lw-tile-skeleton__value',
  '.lw-tile-skeleton__foot',
  '.lw-bands',
  '.lw-bands__skeleton',
  '.lw-chip-row',
  '.lw-grade-chip',
  '.lw-grade-chip__letter',
  '.lw-grade-chip__count',
  '.lw-views',
  '.lw-view-chip',
  '.lw-view-chip.is-current',
  '.lw-view-chip__apply',
  '.lw-view-chip__apply:hover',
  '.lw-view-chip__pinned',
  '.lw-view-chip__action',
  '.lw-view-chip__action:hover',
  '.lw-view-chip__action > svg',
  '.lw-views__note',
  '.lw-form',
  '.lw-form__row',
  '.lw-check-row',
  '.lw-query',
  '.lw-toolbar-field',
  '.lw-select',
  '.lw-facets',
  '.lw-facet-group',
  '.lw-facet-group > .lw-caps',
  '.lw-facet-dot',
  ".lw-facet-dot[data-tone='danger']",
  ".lw-facet-dot[data-tone='warn']",
  ".lw-facet-dot[data-tone='accent']",
  ".lw-facet-dot[data-tone='ok']",
  ".lw-facet-dot[data-tone='orange']",
  ".lw-facet-dot[data-tone='violet']",
  ".lw-facet-dot[data-tone='neutral']",
  ".lw-facet-dot[data-tone='honey']",
  ".lw-facet-dot[data-tone='outline']",
  ".lw-facet-chip[aria-pressed='true'] .lw-facet-dot",
  '.lw-url',
  '.lw-url > svg',
  '.lw-url__path',
  '.lw-url__query',
  '.lw-url__note',
  '.lw-finding',
  '.lw-finding__head',
  '.lw-finding__rule',
  '.lw-finding__message',
  '.lw-finding__path',
  '.lw-subject',
  '.lw-subject__meta',
  '.lw-subject__ungraded',
  '.lw-grade-sq',
  '.lw-axis',
  '.lw-source',
  '.lw-bulk-rule',
  '.lw-bulk-owner',
  '.lw-bulk-owner::placeholder',
  '.lw-drawer-head',
  '.lw-drawer-title',
  '.lw-drawer-desc',
  '.lw-drawer-body',
  '.lw-section-head',
  '.lw-kv',
  '.lw-kv dt',
  '.lw-kv dd',
  '.lw-fingerprint',
  '.lw-link',
  '.lw-link:hover',
  '.lw-link > svg',
  '.lw-timeline',
  '.lw-timeline__item',
  '.lw-timeline__item::before',
  ".lw-timeline__item[data-tone='ok']::before",
  ".lw-timeline__item[data-tone='warn']::before",
  ".lw-timeline__item[data-tone='danger']::before",
  ".lw-timeline__item[data-tone='orange']::before",
  ".lw-timeline__item[data-tone='violet']::before",
  ".lw-timeline__item[data-tone='accent']::before",
  '.lw-timeline__title',
  '.lw-timeline__why',
  '.lw-timeline__meta',
  '.lw-history-skeleton',
  '.lw-history-skeleton__row',
  '.lw-card-head',
  '.lw-card-title',
  '.lw-card-title > svg',
  '.lw-card-title__window',
  '.lw-card-body',
  '.lw-note',
  '.lw-trends',
  '.lw-series',
  '.lw-series__head',
  '.lw-series__label',
  '.lw-series__total',
  '.lw-series__chart',
  '.lw-ranks',
  '.lw-ranks__head',
  '.lw-ranks__title',
  '.lw-ranks__grid',
  '.lw-rank',
  '.lw-rank__meta',
  '.lw-rank__stats',
  '.lw-mini-stat',
  '.lw-mini-stat__label',
  '.lw-mini-stat__value',
  '.lw-rank__charts',
  '.lw-rank__spark',
  '.lw-rank__attribution-head',
  '.lw-bars',
  '.lw-bars__col',
  '.lw-bars__fill',
  '.lw-bars__axis',
  '.lw-split',
  '.lw-split__adapter',
  '.lw-split__spec',
  '.lr-headline',
  '.lr-grade',
  '.lr-headline__text',
  '.lr-headline__marks',
  '.lr-score',
  '.lr-score__max',
  '.lr-findings',
  '.lr-findings--expanded',
  '.lr-rule',
  '.lr-rule-link',
  '.lr-rule-link:hover',
  '.lr-rule-link > svg',
] as const;

/**
 * Look one of this ticket's rules up.
 *
 * @param prelude The rule's selector, exactly as {@link LINT_PRELUDES} lists it.
 * @returns The rule.
 */
function lintRule(prelude: string): CssRule {
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
  const value = parseDeclarations(lintRule(prelude).body).get(property);
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
 * The lint-workspace block, from its banner to the end of the file.
 *
 * Unlike the earlier sections this one *is* last, and it is bounded that way deliberately:
 * the report-dialog rules are part of the same ticket and sit after it. The next redesign
 * ticket appends its own banner, at which point this slice narrows on its own.
 */
const LINT_SECTION = (() => {
  const start = css.indexOf('LINT POSTURE WORKSPACE  (HIVE-5.8, #5311)');
  if (start < 0) throw new Error('globals.css has no lint-posture-workspace section');
  const bannerStart = css.lastIndexOf('/* =', start);
  const next = css.indexOf('/* =', start + 1);
  return css.slice(bannerStart < 0 ? start : bannerStart, next < 0 ? css.length : next);
})();

/** The same block with its comments removed. */
const LINT_SECTION_CODE = LINT_SECTION.replace(/\/\*[\s\S]*?\*\//g, '');

/* -------------------------------------------------------------------------
   1. The section exists, and names no colour of its own
   ------------------------------------------------------------------------- */

describe('the lint-posture section of globals.css', () => {
  it('declares every rule the components reference', () => {
    const missing = LINT_PRELUDES.filter(
      (prelude) => !rules.some((rule) => rule.prelude === prelude)
    );
    expect(missing).toEqual([]);
  });

  it('sits after the unlayered p base rule it has to outrank', () => {
    // `.lw-quiet`, `.lw-note`, `.lw-timeline__meta`, `.lw-views__note` and `.lw-finding__*`
    // are all `p` elements; the bare `p { color: … }` rule is unlayered, so a rule declared
    // before it would lose whatever its specificity.
    for (const prelude of LINT_PRELUDES) {
      expect(lintRule(prelude).line).toBeGreaterThan(BASE_TYPE_RULE_LINE);
    }
  });

  it('names no colour — every hue resolves through the token layer', () => {
    for (const prelude of LINT_PRELUDES) {
      for (const [property, value] of parseDeclarations(lintRule(prelude).body)) {
        expect({ prelude, property, value }).toMatchObject({ prelude, property });
        expect(value).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        expect(value.replace(/color-mix\([^)]*\)/g, '')).not.toMatch(
          /\b(?:rgb|rgba|hsl|hsla|oklch)\(/
        );
      }
    }
  });

  it('does not reintroduce the palette classes the old screen named', () => {
    for (const banned of [
      'rose-6',
      'emerald-6',
      'indigo-',
      'amber-2',
      'sky-1',
      'violet-5',
      'slate-',
      'gray-',
    ]) {
      expect(LINT_SECTION_CODE).not.toContain(banned);
    }
  });

  it('ports none of the mockup’s page-local class names, which are components now', () => {
    // Every one of these is a `<style>` rule in `govern/lint-posture.html`. `.tile-btn` is
    // `Stat as="button"`, `.clamp-2` is `.lw-finding__message`, and the rest were renamed
    // into this section's own namespace rather than landing in the global one.
    for (const leaked of ['.tile-btn', '.clamp-2', '.facets ', '.url-line', '.rank-card', '.view-chip']) {
      expect(LINT_SECTION_CODE).not.toContain(leaked);
    }
  });

  it('leaves the hex fence of the stylesheet intact', () => {
    expect(findUnfencedHex(css).map((entry) => `${entry.line}: ${entry.text}`)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------
   2. The bands and the tones keep their one definition
   ------------------------------------------------------------------------- */

describe('what this section deliberately does not paint', () => {
  it('leaves every grade tile to the shared band, which is the component’s class', () => {
    // `GRADE_BANDS[letter].solidClass` is on the element; a fill here would be a second
    // opinion about the same B, and the two would drift.
    for (const prelude of ['.lw-grade-chip__letter', '.lw-grade-sq', '.lw-bars__fill', '.lr-grade']) {
      const declarations = parseDeclarations(lintRule(prelude).body);
      expect({ prelude, background: declarations.get('background') }).toEqual({
        prelude,
        background: undefined,
      });
      expect({ prelude, color: declarations.get('color') }).toEqual({ prelude, color: undefined });
    }
  });

  it('leaves the stat tile’s own ground to the strip that owns it', () => {
    // `.hive-stat-grid > *` paints the cell. A base `background` here has the same
    // specificity and would win by source order, freezing the surface.
    expect(parseDeclarations(lintRule('.lw-tile').body).get('background')).toBeUndefined();
    expect(declaration('.lw-tile:hover', 'background')).toBe('var(--bg-subtle)');
  });

  it('paints the inverted bulk bar’s two controls from the bar’s own ink', () => {
    for (const [prelude, property] of [
      ['.lw-bulk-rule', 'background'],
      ['.lw-bulk-owner', 'background'],
      ['.lw-bulk-owner', 'box-shadow'],
      ['.lw-bulk-owner::placeholder', 'color'],
    ] as const) {
      expect(declaration(prelude, property)).toContain('currentColor');
    }
    expect(declaration('.lw-bulk-owner', 'color')).toBe('inherit');
  });

  it('drops the facet dot’s hue on the inked chip, where a swatch cannot be read', () => {
    expect(declaration(".lw-facet-chip[aria-pressed='true'] .lw-facet-dot", 'background')).toBe(
      'currentColor'
    );
  });
});

/* -------------------------------------------------------------------------
   3. Nothing is frozen in pixels
   ------------------------------------------------------------------------- */

describe('density and font-scale independence', () => {
  it('states no font size or control metric in px', () => {
    // `1px` is exempt everywhere — a hairline is one device pixel by definition — and `2px`
    // only in a border, a ring or the histogram's floor, which is the weight the design
    // language spends on a rule.
    const RULE_PROPERTIES = new Set([
      'outline',
      'outline-offset',
      'box-shadow',
      'border-inline-start',
      'border-block-end',
      'inline-size',
      'min-block-size',
      'padding',
      'gap',
      // The app-wide underline offset, as `.sg-identity__link:hover` and the rest spell it.
      'text-underline-offset',
    ]);
    for (const prelude of LINT_PRELUDES) {
      for (const [property, value] of parseDeclarations(lintRule(prelude).body)) {
        const allowed = RULE_PROPERTIES.has(property) ? ['1px', '2px'] : ['1px'];
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

  it('states every font size as a scale token', () => {
    for (const prelude of LINT_PRELUDES) {
      const size = parseDeclarations(lintRule(prelude).body).get('font-size');
      if (size === undefined) continue;
      expect({ prelude, size }).toMatchObject({
        prelude,
        size: expect.stringMatching(/var\(--fs-/),
      });
    }
  });

  it('sizes the toolbar select in rem, and to the shared control height', () => {
    expect(declaration('.lw-select', 'inline-size')).toMatch(/rem$/);
    expect(declaration('.lw-select', 'max-inline-size')).toBe('100%');
    expect(declaration('.lw-select', 'block-size')).toBe('var(--control-h-sm)');
  });

  it('sizes the owner field to the same metric, so the bulk bar is one row of controls', () => {
    expect(declaration('.lw-bulk-owner', 'inline-size')).toMatch(/rem$/);
    expect(declaration('.lw-bulk-owner', 'block-size')).toBe('var(--control-h-sm)');
    expect(declaration('.lw-view-chip', 'block-size')).toBe('var(--control-h-sm)');
  });

  it('sizes every glyph from a type or icon token, so a mark grows with its text', () => {
    for (const prelude of ['.lw-tab-glyph', '.lw-card-title > svg']) {
      expect(declaration(prelude, 'inline-size')).toBe('var(--icon-dense)');
      expect(declaration(prelude, 'block-size')).toBe('var(--icon-dense)');
    }
    for (const prelude of ['.lw-url > svg', '.lw-link > svg', '.lw-view-chip__pinned']) {
      expect(declaration(prelude, 'inline-size')).toMatch(/var\(--fs-/);
      expect(declaration(prelude, 'block-size')).toMatch(/var\(--fs-/);
    }
  });

  it('spends spacing tokens rather than literal gaps, so Compact is genuinely compact', () => {
    for (const [prelude, property] of [
      ['.lw-summary', 'gap'],
      ['.lw-bands', 'gap'],
      ['.lw-views', 'gap'],
      ['.lw-form', 'gap'],
      ['.lw-facets', 'gap'],
      ['.lw-kv', 'gap'],
      ['.lw-timeline', 'gap'],
      ['.lw-rank__stats', 'gap'],
      ['.lw-trends', 'gap'],
      ['.lr-headline', 'gap'],
    ] as const) {
      expect(declaration(prelude, property)).toMatch(/var\(--space-/);
    }
  });

  it('sizes the card paddings from the density-aware card metric', () => {
    expect(declaration('.lw-bands', 'padding')).toBe('var(--card-pad)');
    expect(declaration('.lw-tile-skeleton', 'padding')).toContain('var(--card-pad)');
  });
});

/* -------------------------------------------------------------------------
   4. Quiet text is muted, not subtle
   ------------------------------------------------------------------------- */

describe('quiet text', () => {
  it('uses --fg-muted rather than --fg-subtle, which does not clear AA at these sizes', () => {
    for (const prelude of [
      '.lw-caps',
      '.lw-quiet',
      '.lw-grade-chip',
      '.lw-views__note',
      '.lw-query',
      '.lw-toolbar-field',
      '.lw-url',
      '.lw-finding__message',
      '.lw-finding__path',
      '.lw-subject__ungraded',
      '.lw-source',
      '.lw-kv dt',
      '.lw-timeline__why',
      '.lw-timeline__meta',
      '.lw-card-title__window',
      '.lw-card-title > svg',
      '.lw-note',
      '.lw-series__total',
      '.lw-mini-stat__label',
      '.lw-bars__axis',
      '.lw-drawer-desc',
      '.lr-score__max',
    ]) {
      expect(declaration(prelude, 'color')).toBe('var(--fg-muted)');
    }
  });

  it('never fades anything — an opacity is a contrast check nobody can run', () => {
    expect(LINT_SECTION_CODE).not.toMatch(/(?<!-)\bopacity\s*:/);
  });

  it('keeps --fg-muted above AA on the surface in every theme', () => {
    for (const [name, appearance] of APPEARANCES) {
      const surface = paint('--bg-surface', appearance, PAPER);
      const ink = paint('--fg-muted', appearance, surface);
      expect({ theme: name, ratio: contrastRatio(ink, surface) }).toMatchObject({
        theme: name,
        ratio: expect.any(Number),
      });
      expect(contrastRatio(ink, surface)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
    }
  });

  it('keeps the query box and the rule chip readable on their recessed ground, in every theme', () => {
    expect(declaration('.lw-query', 'background')).toBe('var(--bg-inset)');
    expect(declaration('.lr-rule', 'background')).toBe('var(--bg-inset)');
    for (const [name, appearance] of APPEARANCES) {
      const ground = paint('--bg-inset', appearance, PAPER);
      for (const token of ['--fg', '--fg-muted']) {
        const ink = paint(token, appearance, ground);
        const ratio = contrastRatio(ink, ground);
        expect({ theme: name, token, ratio }).toMatchObject({ theme: name, token });
        expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
      }
    }
  });

  it('gives the current view its own soft ground rather than bare tinted text', () => {
    // `--accent-fg` is chosen to clear AA on its *own* soft fill; as loose text on the sheet
    // it does not, which is the trap HIVE-5.4 and 5.5 each measured once.
    expect(declaration('.lw-view-chip.is-current', 'background')).toBe('var(--accent-soft)');
    expect(declaration('.lw-view-chip.is-current', 'color')).toBe('var(--accent-fg)');
    for (const [name, appearance] of APPEARANCES) {
      const surface = paint('--bg-surface', appearance, PAPER);
      const chip = paint('--accent-soft', appearance, surface);
      const ink = paint('--accent-fg', appearance, chip);
      const ratio = contrastRatio(ink, chip);
      expect({ theme: name, ratio }).toMatchObject({ theme: name });
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
    }
  });

  it('keeps every toned callout above AA on the ground it actually sits on', () => {
    // The tile's trailing callout is a chip on its tone's soft fill, which is the pair those
    // inks were chosen for. Bare `--danger-fg` on the surface is 3.06:1 in High contrast.
    for (const [name, appearance] of APPEARANCES) {
      const surface = paint('--bg-surface', appearance, PAPER);
      for (const tone of ['danger', 'warn', 'ok']) {
        const ground = paint(`--${tone}-soft`, appearance, surface);
        const ink = paint(`--${tone}-fg`, appearance, ground);
        const ratio = contrastRatio(ink, ground);
        expect({ theme: name, tone, ratio }).toMatchObject({ theme: name, tone });
        expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
      }
    }
  });

  it('keeps the link ink above AA on the surface in every theme', () => {
    expect(declaration('.lw-link', 'color')).toBe('var(--accent-fg)');
    expect(declaration('.lr-rule-link', 'color')).toBe('var(--accent-fg)');
    for (const [name, appearance] of APPEARANCES) {
      const surface = paint('--bg-surface', appearance, PAPER);
      const ink = paint('--accent-fg', appearance, surface);
      const ratio = contrastRatio(ink, surface);
      expect({ theme: name, ratio }).toMatchObject({ theme: name });
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
    }
  });
});

/* -------------------------------------------------------------------------
   5. Nothing scrolls the document sideways
   ------------------------------------------------------------------------- */

describe('horizontal containment', () => {
  it('caps the widest cell so its message has something to clamp against', () => {
    // The ceiling is on the block *inside* the cell: an auto-layout table ignores a `<td>`'s
    // `max-width` outright, which `e2e/hive-lint-workspace.spec.ts` measured at 533px against
    // a 400px clamp before this moved.
    expect(declaration('.lw-finding', 'max-width')).toMatch(/rem$/);
    expect(declaration('.lw-finding', 'min-width')).toBe('0');
    expect(rules.some((rule) => rule.prelude === '.lw-col-finding')).toBe(false);
  });

  it('clamps the message to two lines and elides the path to one', () => {
    expect(declaration('.lw-finding__message', '-webkit-line-clamp')).toBe('2');
    expect(declaration('.lw-finding__message', 'overflow')).toBe('hidden');
    expect(declaration('.lw-finding__path', 'text-overflow')).toBe('ellipsis');
    expect(declaration('.lw-finding__path', 'white-space')).toBe('nowrap');
  });

  it('wraps a 64-character digest inside the drawer rather than widening the sheet', () => {
    expect(declaration('.lw-fingerprint', 'overflow-wrap')).toBe('anywhere');
    expect(declaration('.lw-kv dd', 'overflow-wrap')).toBe('anywhere');
    expect(declaration('.lw-drawer-title', 'overflow-wrap')).toBe('anywhere');
    // Never elided and never dimmed: these are characters an auditor compares by eye.
    expect(parseDeclarations(lintRule('.lw-fingerprint').body).get('text-overflow')).toBeUndefined();
  });

  it('wraps the query string and the URL line rather than scrolling them', () => {
    expect(declaration('.lw-query', 'overflow-wrap')).toBe('anywhere');
    expect(declaration('.lw-url__path', 'overflow-wrap')).toBe('anywhere');
  });

  it('wraps every cluster that can outgrow its row', () => {
    for (const prelude of [
      '.lw-chip-row',
      '.lw-views',
      '.lw-facets',
      '.lw-facet-group',
      '.lw-finding__head',
      '.lw-subject__meta',
      '.lw-drawer-head',
      '.lw-card-head',
      '.lw-ranks__head',
      '.lw-rank__meta',
      '.lr-headline',
      '.lr-headline__marks',
    ]) {
      expect(declaration(prelude, 'flex-wrap')).toBe('wrap');
    }
  });

  it('collapses each multi-column grid at a breakpoint stated in rem, never px', () => {
    // A length in a media query is resolved against the browser's initial font size rather
    // than against `html { font-size }`, so this does not follow the in-app font-size
    // preference — what it does follow is a reader who has enlarged type in their browser,
    // which a `px` query would not.
    const collapses = rules.filter(
      (rule) =>
        rule.prelude.startsWith('@media') &&
        rule.line > BASE_TYPE_RULE_LINE &&
        /\.lw-(bands|form__row|trends)\b/.test(rule.body)
    );
    expect(collapses).toHaveLength(3);
    for (const rule of collapses) {
      expect(rule.prelude).toMatch(/rem\)/);
      expect(rule.prelude).not.toMatch(/\dpx\)/);
      expect(rule.body).toContain('grid-template-columns: minmax(0, 1fr)');
    }
  });

  it('lets the rank grid reflow on its own rather than fixing a column count', () => {
    expect(declaration('.lw-ranks__grid', 'grid-template-columns')).toMatch(
      /repeat\(auto-fit, minmax\([\d.]+rem, 1fr\)\)/
    );
    expect(declaration('.lw-rank', 'min-width')).toBe('0');
  });

  it('scrolls the report’s findings inside their own box', () => {
    expect(declaration('.lr-findings', 'overflow-y')).toBe('auto');
    expect(declaration('.lr-findings', 'max-block-size')).toBe('50vh');
    // Expanded: the cap is lifted and the box flexes into whatever the dialog gives it.
    expect(declaration('.lr-findings--expanded', 'max-block-size')).toBe('none');
    expect(declaration('.lr-findings--expanded', 'min-block-size')).toBe('0');
  });
});

/* -------------------------------------------------------------------------
   6. The two marks that are shapes, not text
   ------------------------------------------------------------------------- */

describe('the histogram and the attribution bar', () => {
  it('draws six equal columns and keeps an empty bucket’s place', () => {
    expect(declaration('.lw-bars', 'grid-template-columns')).toBe('repeat(6, minmax(0, 1fr))');
    expect(declaration('.lw-bars__axis', 'grid-template-columns')).toBe('repeat(6, minmax(0, 1fr))');
    expect(declaration('.lw-bars', 'align-items')).toBe('end');
    expect(declaration('.lw-bars', 'block-size')).toMatch(/rem$/);
  });

  it('gives the attribution bar the two role tokens, in the order its sentence names them', () => {
    expect(declaration('.lw-split__adapter', 'background')).toBe('var(--violet)');
    expect(declaration('.lw-split__spec', 'background')).toBe('var(--accent)');
    expect(declaration('.lw-split', 'background')).toBe('var(--bg-inset)');
    expect(declaration('.lw-split', 'block-size')).toMatch(/rem$/);
  });

  it('tones the timeline marker from the state the entry moved to', () => {
    for (const tone of ['ok', 'warn', 'danger', 'orange', 'violet', 'accent']) {
      expect(declaration(`.lw-timeline__item[data-tone='${tone}']::before`, 'background')).toBe(
        `var(--${tone})`
      );
    }
    expect(declaration('.lw-timeline__item::before', 'background')).toBe('var(--neutral)');
  });
});
