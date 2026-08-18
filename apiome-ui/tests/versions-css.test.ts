/**
 * The stylesheet half of the Versions redesign (HIVE-6.2, #5313).
 *
 * `versions-hive-redesign.test.tsx` renders the screen and pins its markup; it cannot pin
 * anything that makes it *look* right, because jsdom compiles no stylesheet. So this suite
 * reads `globals.css` the way `projects-css.test.ts` and `lint-workspace-css.test.ts` do, and
 * pins what the components lean on:
 *
 *   1. **The skin is tokens only.** What this replaced named colour outright in more than a
 *      hundred places across the table, the row menu, the five dialogs, the gate panels, the
 *      mock cell and the lint chip — `text-indigo-600`, `bg-blue-100`, `bg-amber-100`,
 *      `border-violet-200`, `text-emerald-600`, `bg-rose-100`, and `text-gray-500
 *      dark:text-gray-400` under every hint. Every one froze the surface on one palette.
 *   2. **Nothing is frozen in pixels.** The mockup's page-local block fixes six column
 *      widths, the project select, the search box, the author select, the date inputs, the
 *      aside, the mock URL, the sparkline, the copy button, the flag, the row menu and the
 *      spec editor; all are `rem`, a token, or a viewport length here.
 *   3. **Every multi-column grid collapses**, so neither the overview grid, the publish
 *      dialog's two columns nor the dialogs' field pairs can scroll the document sideways.
 *   4. **Quiet text is `--fg-muted`**, not the mockup's `--fg-subtle` or `--fg-faint`,
 *      neither of which clears AA at these sizes — measured here in all nine appearances.
 *   5. **The one `opacity` in the block is on a disabled control, never on text.** The mockup
 *      fades the archived row to `.8`, the deleted artifact row to `.7` and the banner body
 *      to `.9`; the pills, the strike-through and the weight carry those now.
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

/** WCAG 1.4.11 for a non-text mark — an icon, a hairline. */
const WCAG_AA_NON_TEXT_MIN = 3;

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
const VERSION_PRELUDES = [
  '.ver-flag',
  '.ver-flag > svg',
  '.ver-quiet',
  '.ver-link',
  '.ver-header .page-header__title',
  '.ver-header__badges',
  '.ver-desc-link',
  '.ver-desc-link:hover',
  '.ver-project-select',
  '.ver-tab-glyph',
  '.ver-header__gitlike',
  '.ver-panel',
  '.ver-banners',
  '.ver-banner__glyph',
  '.ver-banner__title',
  '.ver-banner__body',
  '.ver-banner__detail',
  '.ver-overview',
  '.rart',
  '.rart__header',
  '.rart__title',
  '.rart__title > svg',
  '.rart__all',
  '.rart__all:hover',
  '.rart__list',
  '.rart__row',
  '.rart__row + .rart__row',
  '.rart__row:hover',
  '.rart__body',
  '.rart__name',
  '.rart__name-deleted',
  '.rart__link',
  '.rart__link:hover',
  '.rart__meta',
  '.rart__empty',
  '.rart__footer',
  '.rart__suggest',
  '.rart__suggestions',
  '.rart__suggestion',
  '.rart__suggestion-name',
  '.rart__suggestion-reason',
  '.ver-facts',
  '.ver-facts__title',
  '.ver-kv',
  '.ver-kv dt',
  '.ver-kv dd',
  '.ver-facts__rule',
  '.ver-facts__links',
  '.ver-facts__links > *',
  '.ver-filters',
  '.ver-filters__row',
  '.ver-filters__label',
  '.ver-filters__search',
  '.ver-filters__author',
  '.ver-filters__date',
  '.ver-filters__date > input',
  '.ver-gitlike',
  '.ver-gitlike__row',
  '.ver-gitlike__group',
  '.ver-gitlike__label',
  '.ver-gitlike__label > svg',
  '.ver-gitlike__chip-set',
  '.ver-chip',
  '.ver-chip > svg',
  '.ver-chip .mono',
  '.ver-chip.is-active',
  '.ver-chip.is-active .mono',
  '.ver-chip.is-active .ver-chip__badge',
  '.ver-chip__mark',
  '.ver-chip--static',
  '.ver-gitlike__remove:hover',
  '.ver-gitlike__note',
  '.ver-gitlike__em',
  '.ver-graph-card',
  '.ver-graph-card__head',
  '.ver-graph-card__head > svg',
  '.ver-graph-card__title',
  '.ver-col-version',
  '.ver-col-status',
  '.ver-col-mock',
  '.ver-col-creator',
  '.ver-col-created',
  '.ver-col-actions',
  '.ver-table td',
  '.ver-table td[data-row-actions], .ver-table [data-row-actions]',
  '.ver-cell',
  '.ver-cell__line',
  '.ver-cell__link',
  '.ver-cell__link:hover',
  '.ver-cell__id',
  '.ver-tag',
  '.ver-fork',
  '.ver-fork > svg',
  '.ver-fork__word',
  '.ver-note',
  '.ver-note__title, .ver-note__sub',
  '.ver-status',
  '.ver-creator',
  '.ver-stamp',
  '.ver-stamp__published',
  '.ver-stamp__published > svg',
  '.ver-row-action--publish',
  '.ver-menu',
  '.ver-menu__sep',
  '.ver-menu__item[data-disabled]',
  '.ver-menu__flag',
  '.ver-menu__item--publish > svg',
  '.ver-menu__item--danger[data-highlighted], .ver-menu__item--danger:hover',
  '.ver-menu__item--danger[data-highlighted] > svg, .ver-menu__item--danger:hover > svg',
  '.ver-toolbar-select',
  '.ver-toolbar-select--history',
  '.ver-sort-mark',
  '.ver-foot-side',
  '.ver-mock',
  '.ver-mock__row',
  '.ver-mock__switch',
  '.ver-mock__label',
  '.ver-mock__private',
  '.ver-mock__url',
  '.ver-mock__url > code',
  '.ver-mock__copy',
  '.ver-mock__scenarios',
  '.ver-mock__scenarios:hover',
  '.ver-mock__scenarios > svg',
  '.ver-mock__spark',
  '.ver-mock__quiet',
  '.ver-lint-badge',
  '.ver-lint-badge:hover',
  '.ver-dialog',
  '.ver-dialog__head',
  '.ver-dialog__heading',
  '.ver-dialog__title-mono',
  '.ver-dialog__body',
  '.ver-dialog__grid',
  '.ver-dialog__span-2',
  '.ver-dialog__stack',
  '.ver-form-section + .ver-form-section',
  '.ver-form-section__title',
  '.ver-field',
  '.ver-field__label',
  '.ver-hint',
  '.ver-hint--row',
  '.ver-hint--row > svg',
  '.ver-hint__em',
  '.ver-dialog__note',
  '.ver-dialog__subnote',
  '.ver-dialog__subnote-title',
  '.ver-callout',
  '.ver-dialog__footer',
  '.ver-dialog__footnote',
  '.ver-lineage',
  '.ver-lineage__note, .ver-lineage__loading',
  '.ver-lineage__loading',
  '.ver-lineage__head',
  '.ver-lineage__label',
  '.ver-lineage__hint',
  '.ver-lineage__chain',
  '.ver-lineage__step',
  '.ver-lineage__arrow',
  '.ver-lineage__cur',
  '.ver-lineage__source',
  '.ver-lineage__merge',
  '.ver-lineage__merge-word',
  '.ver-lineage__ascii',
  '.ver-publish',
  '.ver-publish__form',
  '.ver-publish__visibility',
  '.ver-radio-card',
  '.ver-radio-card:hover',
  '.ver-radio-card.is-selected',
  '.ver-radio-card > input',
  '.ver-radio-card > span',
  '.ver-radio-card__title',
  '.ver-radio-card__desc',
  '.ver-publish__force',
  '.ver-check',
  '.ver-publish__gates',
  '.ver-publish__gates-title',
  '.ver-cr',
  '.ver-cr--inert',
  '.ver-cr__head',
  '.ver-cr__title',
  '.ver-cr__note',
  '.ver-cr__pair',
  '.ver-cr__preview',
  '.ver-cr__preview-part',
  '.ver-gate',
  '.ver-gate--warn',
  '.ver-gate__head',
  '.ver-gate__title',
  '.ver-gate__title > svg',
  '.ver-gate__badges',
  '.ver-gate__sub',
  '.ver-gate__em',
  '.ver-gate__banner',
  '.ver-gate__note',
  '.ver-gate__loading',
  '.ver-gate__disclosure',
  '.ver-gate__toggle',
  '.ver-gate__toggle > svg',
  '.ver-gate__findings',
  '.ver-gate__findings--gates',
  '.ver-gate__finding',
  '.ver-gate__tag',
  '.ver-gate__path',
  '.ver-gate__message',
  '.ver-gate__truncated',
  '.ver-gate__gate-row',
  '.ver-gate__warnings',
  '.ver-spec__format',
  '.ver-spec__editor',
  '.ver-spec__loading',
  '.ver-spec__filename',
] as const;

/**
 * Look one of this ticket's rules up.
 *
 * @param prelude The rule's selector, exactly as {@link VERSION_PRELUDES} lists it.
 * @returns The rule.
 */
function versionRule(prelude: string): CssRule {
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
  const value = parseDeclarations(versionRule(prelude).body).get(property);
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
 * The versions block, from its banner to the start of whatever section follows it.
 *
 * Bounded rather than run to the end of the file, for the reason `api-keys-css.test.ts`
 * records: `globals.css` grows one section per redesign ticket, and a slice that ended at EOF
 * would make every assertion below a claim about every *later* section too.
 */
const SECTION = (() => {
  const start = css.indexOf('VERSIONS  (HIVE-6.2, #5313)');
  if (start < 0) throw new Error('globals.css has no versions section');
  const bannerStart = css.lastIndexOf('/* =', start);
  const next = css.indexOf('/* =', start);
  return css.slice(bannerStart < 0 ? start : bannerStart, next < 0 ? css.length : next);
})();

/** The same block with its comments removed. */
const SECTION_CODE = SECTION.replace(/\/\*[\s\S]*?\*\//g, '');

/* -------------------------------------------------------------------------
   1. The section exists, and names no colour
   ------------------------------------------------------------------------- */

describe('the versions section of globals.css', () => {
  it('declares every rule the components reference', () => {
    const missing = VERSION_PRELUDES.filter(
      (prelude) => !rules.some((rule) => rule.prelude === prelude)
    );
    expect(missing).toEqual([]);
  });

  it('declares nothing this list does not know about', () => {
    // The reverse: every rule in the block is one the list names, so a rule added without a
    // test — or renamed on one side only — fails here rather than going unmeasured.
    const declared = rules
      .filter((rule) => rule.line >= versionRule('.ver-flag').line && !rule.prelude.startsWith('@media'))
      .filter((rule) => SECTION.includes(`${rule.prelude} {`))
      .map((rule) => rule.prelude);
    const unknown = declared.filter((prelude) => !VERSION_PRELUDES.includes(prelude as never));
    expect(unknown).toEqual([]);
  });

  it('sits after the unlayered p and h1–h4 base rules it has to outrank', () => {
    // `.ver-facts__title`, `.ver-form-section__title` and `.ver-gate__title` are `h2`/`h3`s,
    // and `.ver-hint`, `.ver-gate__sub` and `.rart__empty` are `p`s; both base rules are
    // unlayered, so a rule declared before them would lose whatever its specificity.
    for (const prelude of VERSION_PRELUDES) {
      expect(versionRule(prelude).line).toBeGreaterThan(BASE_TYPE_RULE_LINE);
    }
  });

  it('names no colour — every hue resolves through the token layer', () => {
    for (const prelude of VERSION_PRELUDES) {
      for (const [property, value] of parseDeclarations(versionRule(prelude).body)) {
        expect({ prelude, property, value }).toMatchObject({ prelude, property });
        expect(value).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        expect(value.replace(/color-mix\([^)]*\)/g, '')).not.toMatch(
          /\b(?:rgb|rgba|hsl|hsla|oklch)\(/
        );
      }
    }
  });

  it('does not reintroduce the palette classes the screen named', () => {
    for (const banned of [
      'indigo-',
      'purple-',
      'emerald-',
      'violet-1',
      'amber-',
      'gray-',
      'slate-',
      'rose-1',
      'blue-1',
      'cyan-',
      'teal-',
    ]) {
      expect(SECTION_CODE).not.toContain(banned);
    }
  });

  it('leaves the hex fence of the stylesheet intact', () => {
    expect(findUnfencedHex(css).map((entry) => `${entry.line}: ${entry.text}`)).toEqual([]);
  });

  it('dims only a disabled menu item, and never a word of text', () => {
    // The mockup fades the archived row to `.8`, a deleted artifact row to `.7` and every
    // banner body to `.9`. None of that survives: the Archived pill, the strike-through and
    // the title's weight carry the meaning, and the one `opacity` left is the disabled state
    // of an inert menu item — a control, in a build where the git-like items are drawn but
    // cannot be used.
    const faded = rules.filter(
      (rule) =>
        VERSION_PRELUDES.includes(rule.prelude as (typeof VERSION_PRELUDES)[number]) &&
        parseDeclarations(rule.body).has('opacity')
    );
    expect(faded.map((rule) => rule.prelude)).toEqual(['.ver-menu__item[data-disabled]']);
  });
});

/* -------------------------------------------------------------------------
   2. Nothing is frozen in pixels
   ------------------------------------------------------------------------- */

describe('density and font-scale independence', () => {
  it('states no font size or control metric in px', () => {
    // `1px` is exempt everywhere — a hairline is one device pixel by definition — and `2px`
    // and `3px` only in a ring, a border or an inset rule. All are gaps between two strokes
    // rather than font metrics or control heights: they must *not* grow with the font scale.
    const RULE_PROPERTIES = new Set([
      'outline',
      'outline-offset',
      'box-shadow',
      'border',
      'border-top',
      'border-block-start',
      'border-inline-start',
      'stroke-width',
      'text-underline-offset',
    ]);
    for (const prelude of VERSION_PRELUDES) {
      for (const [property, value] of parseDeclarations(versionRule(prelude).body)) {
        const allowed = RULE_PROPERTIES.has(property) ? ['1px', '1.5px', '2px', '3px'] : ['1px'];
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

  it('states the mockup’s twelve frozen widths in rem, a token or a viewport length', () => {
    expect(declaration('.ver-col-version', 'inline-size')).toBe('14.6875rem');
    expect(declaration('.ver-col-status', 'inline-size')).toBe('6.875rem');
    expect(declaration('.ver-col-mock', 'inline-size')).toBe('11.125rem');
    expect(declaration('.ver-project-select', 'inline-size')).toBe('12rem');
    expect(declaration('.ver-filters__search', 'inline-size')).toBe('14.375rem');
    expect(declaration('.ver-filters__author', 'inline-size')).toBe('9.375rem');
    expect(declaration('.ver-filters__date > input', 'inline-size')).toBe('8.75rem');
    expect(declaration('.ver-overview', 'grid-template-columns')).toBe('minmax(0, 1fr) 23.75rem');
    expect(declaration('.ver-mock__url', 'max-inline-size')).toBe('10.3125rem');
    expect(declaration('.ver-mock__spark', 'inline-size')).toBe('5rem');
    expect(declaration('.ver-mock__copy', 'inline-size')).toBe('1.375rem');
    expect(declaration('.ver-flag', 'block-size')).toBe('1rem');
    expect(declaration('.ver-menu', 'min-inline-size')).toBe('18rem');
    expect(declaration('.ver-spec__editor', 'block-size')).toBe('min(50vh, 32rem)');
    expect(declaration('.ver-cr__preview', 'max-block-size')).toBe('min(20rem, 40vh)');
  });

  it('sizes every glyph from the shared icon metrics or from a rem', () => {
    expect(declaration('.ver-tab-glyph', 'inline-size')).toBe('var(--icon-dense)');
    expect(declaration('.ver-banner__glyph', 'inline-size')).toBe('var(--icon-dense)');
    expect(declaration('.ver-graph-card__head > svg', 'inline-size')).toBe('var(--icon-dense)');
    expect(declaration('.ver-gate__toggle > svg', 'inline-size')).toBe('var(--icon-dense)');
    expect(declaration('.rart__title > svg', 'inline-size')).toBe('var(--icon-button)');
    for (const prelude of ['.ver-flag > svg', '.ver-fork > svg', '.ver-chip > svg', '.ver-mock__scenarios > svg', '.ver-gate__title > svg']) {
      expect(declaration(prelude, 'inline-size')).toMatch(/rem$/);
    }
  });

  it('spends spacing tokens rather than literal gaps, so Compact is genuinely compact', () => {
    for (const [prelude, property] of [
      ['.ver-banners', 'gap'],
      ['.ver-overview', 'gap'],
      ['.rart__row', 'padding'],
      ['.rart__footer', 'padding'],
      ['.ver-facts', 'padding'],
      ['.ver-kv', 'gap'],
      ['.ver-filters', 'padding'],
      ['.ver-filters__row', 'gap'],
      ['.ver-gitlike', 'padding'],
      ['.ver-cell', 'gap'],
      ['.ver-cell__line', 'gap'],
      ['.ver-mock', 'gap'],
      ['.ver-dialog', 'gap'],
      ['.ver-dialog__grid', 'gap'],
      ['.ver-publish', 'gap'],
      ['.ver-gate', 'padding'],
      ['.ver-gate', 'gap'],
      ['.ver-lineage', 'gap'],
    ] as const) {
      expect(declaration(prelude, property)).toMatch(/var\(--(?:space-|card-pad)/);
    }
  });

  it('states every font size as a scale token', () => {
    for (const prelude of VERSION_PRELUDES) {
      const size = parseDeclarations(versionRule(prelude).body).get('font-size');
      if (size === undefined) continue;
      expect({ prelude, size }).toMatchObject({
        prelude,
        size: expect.stringMatching(/var\(--fs-/),
      });
    }
  });

  it('sizes the flag from the smallest type step, not the mockup’s frozen 10px', () => {
    expect(declaration('.ver-flag', 'font-size')).toBe('var(--fs-2xs)');
    expect(declaration('.ver-flag', 'background')).toBe('var(--honey-soft)');
    expect(declaration('.ver-flag', 'color')).toBe('var(--honey-fg)');
  });

  it('states every breakpoint in rem, so it follows the font scale', () => {
    const media = SECTION.match(/@media \([^)]*\)/g) ?? [];
    expect(media.length).toBeGreaterThanOrEqual(4);
    for (const query of media) {
      expect(query).toMatch(/rem\)/);
      expect(query).not.toMatch(/\d+px/);
    }
  });
});

/* -------------------------------------------------------------------------
   3. Nothing scrolls the document sideways
   ------------------------------------------------------------------------- */

describe('horizontal containment', () => {
  it('collapses the overview grid, the publish dialog, the visibility pair and the field grid', () => {
    const collapsed = (selector: string) =>
      rules.filter((rule) => rule.prelude.startsWith('@media') && rule.body.includes(`${selector} {`));
    for (const selector of ['.ver-overview', '.ver-publish', '.ver-publish__visibility', '.ver-dialog__grid']) {
      const hits = collapsed(selector);
      expect({ selector, collapses: hits.length > 0 }).toEqual({ selector, collapses: true });
      expect(hits[0].body).toContain('grid-template-columns: minmax(0, 1fr)');
    }
    expect(declaration('.ver-publish', 'grid-template-columns')).toBe('minmax(0, 1fr) 23.75rem');
    expect(declaration('.ver-dialog__grid', 'grid-template-columns')).toBe('repeat(2, minmax(0, 1fr))');
  });

  it('gives every elidable block a floor to shrink to', () => {
    for (const prelude of [
      '.rart',
      '.rart__body',
      '.ver-cell',
      '.ver-note',
      '.ver-kv dd',
      '.ver-dialog__heading',
      '.ver-publish__form',
      '.ver-publish__gates',
      '.ver-field',
      '.ver-mock__url > code',
      '.ver-radio-card > span',
    ]) {
      expect(declaration(prelude, 'min-inline-size')).toBe('0');
    }
  });

  it('caps the note cell in rem, on the block inside the cell', () => {
    // An auto-layout table ignores a `<td>`'s own `max-width` outright — HIVE-5.8 measured
    // 533px against a 400px clamp — so the ceiling lives on the block the cell holds.
    expect(declaration('.ver-note', 'max-inline-size')).toBe('16.25rem');
    expect(declaration('.ver-note__title, .ver-note__sub', 'text-overflow')).toBe('ellipsis');
    expect(declaration('.ver-mock__url > code', 'text-overflow')).toBe('ellipsis');
  });

  it('wraps every strip that could otherwise widen its parent', () => {
    for (const prelude of [
      '.ver-header .page-header__title',
      '.ver-header__badges',
      '.ver-cell__line',
      '.ver-status',
      '.ver-filters__row',
      '.ver-gitlike__row',
      '.ver-gitlike__group',
      '.rart__meta',
      '.ver-gate__head',
      '.ver-gate__badges',
      '.ver-lineage__chain',
      '.ver-cr__head',
    ]) {
      expect(declaration(prelude, 'flex-wrap')).toBe('wrap');
    }
  });

  it('scrolls the long lists inside their own boxes', () => {
    expect(declaration('.ver-gate__findings', 'overflow-y')).toBe('auto');
    expect(declaration('.ver-cr__preview', 'overflow-y')).toBe('auto');
    expect(declaration('.ver-lineage__ascii', 'overflow-x')).toBe('auto');
    expect(declaration('.ver-menu', 'max-inline-size')).toBe('min(24rem, calc(100vw - 1rem))');
  });
});

/* -------------------------------------------------------------------------
   4. Quiet text still clears AA, in all nine appearances
   ------------------------------------------------------------------------- */

describe('contrast', () => {
  /** Every quiet line in the block, with the ground it is drawn on. */
  const QUIET = [
    ['.ver-quiet', '--bg-surface'],
    ['.ver-filters__label', '--bg-surface'],
    ['.ver-filters__date', '--bg-surface'],
    ['.ver-gitlike__label', '--bg-surface'],
    ['.ver-gitlike__note', '--bg-surface'],
    ['.ver-graph-card__head', '--bg-surface'],
    ['.ver-stamp', '--bg-surface'],
    ['.ver-mock__label', '--bg-surface'],
    ['.ver-mock__url', '--bg-surface'],
    ['.ver-mock__quiet', '--bg-surface'],
    ['.ver-kv dt', '--bg-surface'],
    ['.rart__meta', '--bg-surface'],
    ['.rart__empty', '--bg-surface'],
    ['.rart__name-deleted', '--bg-surface'],
    ['.rart__suggestion-reason', '--bg-surface'],
    ['.ver-hint', '--bg-surface'],
    ['.ver-dialog__title-mono', '--bg-surface'],
    ['.ver-dialog__footnote', '--bg-surface'],
    ['.ver-cr__note', '--bg-surface'],
    ['.ver-cr__pair', '--bg-surface'],
    ['.ver-gate__sub', '--bg-surface'],
    ['.ver-gate__note', '--bg-surface'],
    ['.ver-gate__path', '--bg-surface'],
    ['.ver-gate__message', '--bg-surface'],
    ['.ver-gate__truncated', '--bg-surface'],
    ['.ver-radio-card__desc', '--bg-surface'],
    ['.ver-publish__gates-title', '--bg-surface'],
    ['.ver-sort-mark', '--bg-surface'],
    ['.ver-lineage__hint', '--bg-surface'],
    ['.ver-lineage__label', '--bg-surface'],
    ['.ver-lineage__chain', '--bg-surface'],
    ['.ver-lineage__ascii', '--bg-surface'],
    ['.ver-callout', '--bg-surface'],
    ['.ver-stamp__published', '--bg-surface'],
  ] as const;

  it('draws every quiet line in --fg-muted rather than --fg-subtle or --fg-faint', () => {
    for (const [prelude] of QUIET) {
      expect({ prelude, color: declaration(prelude, 'color') }).toEqual({
        prelude,
        color: 'var(--fg-muted)',
      });
    }
  });

  it.each(APPEARANCES)('clears AA for quiet text in the %s appearance', (_id, block) => {
    const ink = paint('--fg-muted', block, PAPER);
    for (const [prelude, ground] of QUIET) {
      const backdrop = paint(ground, block, PAPER);
      const ratio = contrastRatio(ink, backdrop);
      expect({ prelude, ratio: ratio >= WCAG_AA_NORMAL_TEXT_MIN }).toEqual({
        prelude,
        ratio: true,
      });
    }
  });

  it.each(APPEARANCES)('clears AA for the honey flag and the amber tag in the %s appearance', (_id, block) => {
    // Both are `--honey-fg` on `--honey-soft` — the pair the token layer calibrated.
    for (const prelude of ['.ver-flag', '.ver-tag']) {
      expect(declaration(prelude, 'color')).toBe('var(--honey-fg)');
      expect(declaration(prelude, 'background')).toBe('var(--honey-soft)');
    }
    const ratio = contrastRatio(
      paint('--honey-fg', block, PAPER),
      paint('--honey-soft', block, paint('--bg-surface', block, PAPER))
    );
    expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
  });

  it.each(APPEARANCES)('clears AA for the violet fork box in the %s appearance', (_id, block) => {
    expect(declaration('.ver-fork', 'color')).toBe('var(--violet-fg)');
    expect(declaration('.ver-fork', 'background')).toBe('var(--violet-soft)');
    const ratio = contrastRatio(
      paint('--violet-fg', block, PAPER),
      paint('--violet-soft', block, paint('--bg-surface', block, PAPER))
    );
    expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
  });

  it('pairs every `-fg` ink with its own `-soft` fill, and never draws either alone', () => {
    // Outside the light and dark themes the semantic pairs are not calibrated for anything
    // but each other: `--ok-fg` measures 1.5:1 on Nord's surface and `--fg` 1.1:1 on Nord's
    // `--warn-soft`. So a rule that inks `--X-fg` must fill `--X-soft`, and vice versa —
    // which is what the highlighted danger row and the Remove hover do — and nothing else in
    // the block touches either half. `--accent-fg` is the exception: it is the app's link ink
    // and clears 7:1 on the surface in all nine appearances.
    for (const prelude of VERSION_PRELUDES) {
      const declarations = parseDeclarations(versionRule(prelude).body);
      const ink = declarations.get('color')?.match(/var\(--(ok|warn|danger|orange|rose|neutral|violet|honey)-fg\)/)?.[1];
      const fill = declarations
        .get('background')
        ?.match(/var\(--(ok|warn|danger|orange|rose|neutral|violet|honey)-soft\)/)?.[1];
      expect({ prelude, ink: ink ?? null, fill: fill ?? null }).toEqual({
        prelude,
        ink: ink ?? null,
        fill: ink ?? null,
      });
    }
    expect(declaration('.ver-stamp__published', 'color')).toBe('var(--fg-muted)');
    expect(declaration('.ver-gate--warn', 'box-shadow')).toBe('inset 0 0 0 1px var(--warn)');
    expect(parseDeclarations(versionRule('.ver-gate--warn').body).has('background')).toBe(false);
  });

  it.each(APPEARANCES)('clears the 3:1 mark floor for the ok glyphs in the %s appearance', (_id, block) => {
    // The published date's check and the publish verb's lock take `--ok`, the saturated fill:
    // WCAG 1.4.11 asks 3:1 of a mark, and the words beside each glyph carry the meaning.
    expect(declaration('.ver-stamp__published > svg', 'color')).toBe('var(--ok)');
    expect(declaration('.ver-row-action--publish', 'color')).toBe('var(--ok)');
    expect(declaration('.ver-menu__item--publish > svg', 'color')).toBe('var(--ok)');
    const ratio = contrastRatio(paint('--ok', block, PAPER), paint('--bg-surface', block, PAPER));
    expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NON_TEXT_MIN);
  });

  it.each(APPEARANCES)('clears AA for links at rest in the %s appearance', (_id, block) => {
    // `--accent-fg`, not `--accent`: the fill measures 4.1:1 as ink in four themes.
    for (const prelude of ['.ver-link', '.ver-desc-link', '.rart__all', '.ver-mock__scenarios']) {
      expect(declaration(prelude, 'color')).toBe('var(--accent-fg)');
    }
    const ratio = contrastRatio(paint('--accent-fg', block, PAPER), paint('--bg-surface', block, PAPER));
    expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
  });

  it.each(APPEARANCES)('inks the destructive menu row only where it has a ground for it, in the %s appearance', (_id, block) => {
    // The mockup inks `.menu__item.is-danger` red at rest. No red in the token layer can do
    // that and stay readable — the 6.1 measurement — so the row takes the designed soft/ink
    // pair when it is highlighted, and is plain text otherwise.
    const highlighted = '.ver-menu__item--danger[data-highlighted], .ver-menu__item--danger:hover';
    expect(declaration(highlighted, 'background')).toBe('var(--danger-soft)');
    expect(declaration(highlighted, 'color')).toBe('var(--danger-fg)');
    const ratio = contrastRatio(
      paint('--danger-fg', block, PAPER),
      paint('--danger-soft', block, paint('--bg-surface', block, PAPER))
    );
    expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
  });

});

/* -------------------------------------------------------------------------
   5. The rules the mockup's markup depends on
   ------------------------------------------------------------------------- */

describe('the table’s two departures from DataTable', () => {
  it('top-aligns the cells, since the version and mock cells are two and three lines', () => {
    expect(declaration('.ver-table td', 'vertical-align')).toBe('top');
    expect(declaration('.ver-table td', 'padding-block')).toMatch(/var\(--space-2\)/);
  });

  it('floors the version column so its chip line never folds under the head', () => {
    expect(declaration('.ver-col-version', 'min-inline-size')).toBe('14.6875rem');
  });
});

describe('the dialog head', () => {
  it('lays the tile and the title block on one row, over DialogHeader’s column', () => {
    expect(declaration('.ver-dialog__head', 'flex-direction')).toBe('row');
    expect(declaration('.ver-dialog__head', 'align-items')).toBe('flex-start');
  });

  it('marks the selected visibility card with the accent ring, not a fill', () => {
    expect(declaration('.ver-radio-card.is-selected', 'box-shadow')).toBe('0 0 0 2px var(--accent), var(--shadow-sm)');
    expect(declaration('.ver-radio-card', 'cursor')).toBe('pointer');
  });
});
