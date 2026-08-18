/**
 * The stylesheet half of the Projects redesign (HIVE-6.1, #5312).
 *
 * `projects-hive-redesign.test.tsx` renders the screen and pins its markup; it cannot pin
 * anything that makes it *look* right, because jsdom compiles no stylesheet. So this suite
 * reads `globals.css` the way `style-guides-css.test.ts` and `lint-workspace-css.test.ts` do,
 * and pins what the components lean on:
 *
 *   1. **The skin is tokens only.** What this replaced named colour outright in more than
 *      sixty places across the card, the table, the two charts, the scores dialog and the
 *      project form — `from-indigo-500 to-purple-500` avatars, `bg-violet-100`,
 *      `border-amber-200/60`, `bg-emerald-100`, `#6366f1` four times inside one chart, and a
 *      `text-gray-500 dark:text-gray-400` hint under nine separate fields. Every one froze
 *      the surface on one palette.
 *   2. **Nothing is frozen in pixels.** The mockup's page-local block fixes the filter field
 *      at 280px, the template select at 240px, the summary block at 40px, the new-project
 *      tile at 220px, the sparkline at 72×28 and the two chart areas at 140/160px; all are
 *      `rem`, a token or an `aspect-ratio` here.
 *   3. **Every multi-column grid collapses**, so neither the card grid nor the two-column
 *      project form can scroll the document sideways at any font scale.
 *   4. **Quiet text is `--fg-muted`**, not the mockup's `--fg-subtle` or `--fg-faint`,
 *      neither of which clears AA at these sizes — measured here in all nine appearances.
 *   5. **The one `opacity` in the block is on a control, never on text.** The screen this
 *      replaces faded a whole deleted card to `.9` and a whole deleted row to `.75`, which
 *      fades the text most likely to be read; the amber frame carries it now.
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

/** WCAG 1.4.11 for a non-text mark — an icon, a bar, a gridline. */
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
const PROJECT_PRELUDES = [
  '.prj-quiet',
  '.prj-num',
  '.prj-stamp',
  '.prj-menu__item--danger[data-highlighted], .prj-menu__item--danger:hover',
  '.prj-menu__item--danger[data-highlighted] > svg, .prj-menu__item--danger:hover > svg',
  '.prj-sort-mark',
  '.prj-deleted-switch',
  '.prj-deleted-switch label',
  '.prj-cards-panel',
  '.prj-cards-panel__empty',
  '.prj-grid',
  '.prj-card',
  '.prj-card:hover',
  '.prj-card[data-lifecycle="disabled"], .prj-card[data-lifecycle="deleted"]',
  '.prj-card--skeleton',
  '.prj-card__body',
  '.prj-card__head',
  '.prj-card__identity',
  '.prj-card__title-line',
  '.prj-card__name',
  '.prj-card__link',
  '.prj-card__link::after',
  '.prj-card__link:hover',
  '.prj-card__link:focus-visible::after',
  '.prj-card__id',
  '.prj-card__summary',
  '.prj-card__meter',
  '.prj-card__scores',
  '.prj-card__versions',
  '.prj-card__above',
  '.prj-card__actions',
  '.prj-card:hover .prj-card__actions, .prj-card:focus-within .prj-card__actions',
  '.prj-card__footer',
  '.prj-card[data-lifecycle="deleted"] .prj-card__footer',
  '.prj-card__creator',
  '.prj-card__creator-name',
  '.prj-orb',
  '.prj-orb__label',
  '.prj-orb--action',
  '.prj-orb--action:hover',
  '.prj-orb--action:hover .prj-orb__label',
  '.prj-tile',
  '.prj-tile:hover',
  '.prj-tile__title',
  '.prj-tile__desc',
  '.prj-identity',
  '.prj-identity__text',
  '.prj-identity__line',
  '.prj-identity__link',
  '.prj-identity__link:hover',
  '.prj-desc',
  '.prj-status',
  '.prj-creator',
  '.prj-col-glyph',
  '.prj-row--deleted',
  '.prj-restore',
  '.prj-trend',
  '.prj-trend--action',
  '.prj-trend--action:hover',
  '.prj-trend__spark',
  '.prj-trend__value',
  '.prj-trend__grade',
  '.prj-portfolio__header',
  '.prj-portfolio__title',
  '.prj-portfolio__title > svg',
  '.prj-portfolio__note',
  '.prj-portfolio__chart',
  '.prj-portfolio__chart > svg',
  '.prj-portfolio__grid line',
  '.prj-portfolio__ticks text',
  '.prj-portfolio__line',
  '.prj-portfolio__area',
  '.prj-portfolio__dot',
  '.prj-portfolio__axis',
  '.prj-template',
  '.prj-template__text',
  '.prj-template__title',
  '.prj-template__desc, .prj-template__hint',
  '.prj-template__hint',
  '.prj-template__select',
  '.prj-form',
  '.prj-form__col',
  '.prj-form__title',
  '.prj-form__title-aside',
  '.prj-form__pair',
  '.prj-form__url',
  '.prj-form__url > input',
  '.prj-dialog',
  '.prj-dialog__header',
  '.prj-dialog__heading',
  '.prj-dialog__body',
  '.prj-dialog__body--chat',
  '.prj-chat',
  '.prj-dialog__footer',
  '.prj-dialog__footnote',
  '.prj-tab-glyph',
  '.prj-chip-glyph',
  '.prj-edit-stats',
  '.pqh-dialog',
  '.pqh-dialog__head',
  '.pqh-dialog__body',
  '.pqh-panel',
  '.pqh-lede',
  '.pqh-chart',
  '.pqh-chart__svg',
  '.pqh-chart__grid line',
  '.pqh-chart__ticks text',
  '.pqh-chart__line',
  '.pqh-chart__area',
  '.pqh-chart__dot',
  '.pqh-chart__axis',
  '.pqh-table-wrap',
  '.pqh-table',
  '.pqh-table th',
  '.pqh-table td',
  '.pqh-score',
  '.pqh-headline',
  '.pqh-headline__grade',
  '.pqh-headline__note',
  '.pqh-categories',
  '.pqh-category',
  '.pqh-category__label',
  '.pqh-category__value',
  '.pqh-list',
  '.pqh-finding',
  '.pqh-finding__head',
  '.pqh-finding__title',
  '.pqh-finding__note',
  '.pqh-finding__path',
] as const;

/**
 * Look one of this ticket's rules up.
 *
 * @param prelude The rule's selector, exactly as {@link PROJECT_PRELUDES} lists it.
 * @returns The rule.
 */
function projectRule(prelude: string): CssRule {
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
  const value = parseDeclarations(projectRule(prelude).body).get(property);
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
 * The projects block, from its banner to the start of whatever section follows it.
 *
 * Bounded rather than run to the end of the file, for the reason `api-keys-css.test.ts`
 * records: `globals.css` grows one section per redesign ticket, and a slice that ended at EOF
 * would make every assertion below a claim about every *later* section too.
 */
const SECTION = (() => {
  const start = css.indexOf('PROJECTS  (HIVE-6.1, #5312)');
  if (start < 0) throw new Error('globals.css has no projects section');
  const bannerStart = css.lastIndexOf('/* =', start);
  const next = css.indexOf('/* =', start);
  return css.slice(bannerStart < 0 ? start : bannerStart, next < 0 ? css.length : next);
})();

/** The same block with its comments removed. */
const SECTION_CODE = SECTION.replace(/\/\*[\s\S]*?\*\//g, '');

/* -------------------------------------------------------------------------
   1. The section exists, and names no colour
   ------------------------------------------------------------------------- */

describe('the projects section of globals.css', () => {
  it('declares every rule the components reference', () => {
    const missing = PROJECT_PRELUDES.filter(
      (prelude) => !rules.some((rule) => rule.prelude === prelude)
    );
    expect(missing).toEqual([]);
  });

  it('sits after the unlayered p and h1–h4 base rules it has to outrank', () => {
    // `.prj-card__name` and `.prj-form__title` are `h3`s, and `.prj-card__summary`,
    // `.pqh-lede` and `.prj-template__desc` are `p`s; both base rules are unlayered, so a
    // rule declared before them would lose whatever its specificity.
    for (const prelude of PROJECT_PRELUDES) {
      expect(projectRule(prelude).line).toBeGreaterThan(BASE_TYPE_RULE_LINE);
    }
  });

  it('names no colour — every hue resolves through the token layer', () => {
    for (const prelude of PROJECT_PRELUDES) {
      for (const [property, value] of parseDeclarations(projectRule(prelude).body)) {
        expect({ prelude, property, value }).toMatchObject({ prelude, property });
        expect(value).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        expect(value.replace(/color-mix\([^)]*\)/g, '')).not.toMatch(
          /\b(?:rgb|rgba|hsl|hsla|oklch)\(/
        );
      }
    }
  });

  it('does not reintroduce the palette classes the two views named', () => {
    for (const banned of [
      'indigo-',
      'purple-',
      'emerald-',
      'violet-1',
      'amber-',
      'gray-',
      'slate-',
      'rose-1',
    ]) {
      expect(SECTION_CODE).not.toContain(banned);
    }
  });

  it('leaves the hex fence of the stylesheet intact', () => {
    expect(findUnfencedHex(css).map((entry) => `${entry.line}: ${entry.text}`)).toEqual([]);
  });

  it('fades a control that is revealed on hover, and never a word of text', () => {
    // The screen this replaces put `opacity: .9` on a whole deleted card and `.75` on a whole
    // deleted row — which fades the amber warning along with everything else. The frame and
    // the tinted footer carry that now, and the only `opacity` left is the row-actions
    // reveal `DataTable` already uses, which never covers text a reader has to read.
    const faded = rules.filter(
      (rule) =>
        PROJECT_PRELUDES.includes(rule.prelude as (typeof PROJECT_PRELUDES)[number]) &&
        parseDeclarations(rule.body).has('opacity')
    );
    expect(faded.map((rule) => rule.prelude)).toEqual([
      '.prj-card__actions',
      '.prj-card:hover .prj-card__actions, .prj-card:focus-within .prj-card__actions',
    ]);
    // And it is a full reveal, not a permanent dimming.
    expect(
      declaration('.prj-card:hover .prj-card__actions, .prj-card:focus-within .prj-card__actions', 'opacity')
    ).toBe('1');
  });
});

/* -------------------------------------------------------------------------
   2. Nothing is frozen in pixels
   ------------------------------------------------------------------------- */

describe('density and font-scale independence', () => {
  it('states no font size or control metric in px', () => {
    // `1px` is exempt everywhere — a hairline is one device pixel by definition — and `2px`
    // only in a ring, a border or a stroke. All are gaps between two strokes rather than
    // font metrics or control heights: they must *not* grow with the font scale.
    const RULE_PROPERTIES = new Set([
      'outline',
      'outline-offset',
      'box-shadow',
      'border',
      'border-block-start',
      'border-inline-start',
      'stroke-width',
      'text-underline-offset',
    ]);
    for (const prelude of PROJECT_PRELUDES) {
      for (const [property, value] of parseDeclarations(projectRule(prelude).body)) {
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

  it('sizes the two charts by ratio rather than by the mockup’s 140px and 160px', () => {
    // Both SVGs carry `preserveAspectRatio="none"`, so a fixed height would squash the curve
    // at one viewport and stretch it at another. The ratio is the `viewBox`'s own.
    expect(declaration('.prj-portfolio__chart', 'aspect-ratio')).toBe('800 / 140');
    expect(declaration('.pqh-chart__svg', 'aspect-ratio')).toBe('700 / 160');
    expect(declaration('.prj-portfolio__chart', 'min-block-size')).toMatch(/rem$/);
  });

  it('states the sparkline’s width in rem and lets the kit’s ratio set its height', () => {
    expect(declaration('.prj-trend__spark', 'inline-size')).toBe('4.5rem');
    expect(parseDeclarations(projectRule('.prj-trend__spark').body).has('block-size')).toBe(false);
  });

  it('sizes every glyph from the shared icon metrics', () => {
    for (const prelude of ['.prj-tab-glyph']) {
      expect(declaration(prelude, 'inline-size')).toBe('var(--icon-dense)');
      expect(declaration(prelude, 'block-size')).toBe('var(--icon-dense)');
    }
    // Two glyphs ride the type instead: each sits inside a 12px label whose size is a
    // font-scale token, and an icon metric there would drift away from the letters beside it.
    expect(declaration('.prj-col-glyph', 'inline-size')).toBe('var(--fs-xs)');
    expect(declaration('.prj-chip-glyph', 'inline-size')).toBe('var(--fs-xs)');
    expect(declaration('.prj-portfolio__title > svg', 'inline-size')).toBe('var(--icon-rail)');
  });

  it('spends spacing tokens rather than literal gaps, so Compact is genuinely compact', () => {
    for (const [prelude, property] of [
      ['.prj-grid', 'gap'],
      ['.prj-grid', 'padding'],
      ['.prj-card__body', 'padding'],
      ['.prj-card__body', 'gap'],
      ['.prj-card__head', 'gap'],
      ['.prj-card__footer', 'padding'],
      ['.prj-orb', 'gap'],
      ['.prj-form', 'gap'],
      ['.prj-form__col', 'gap'],
      ['.prj-form__pair', 'gap'],
      ['.prj-template', 'padding'],
      ['.pqh-panel', 'gap'],
      ['.pqh-table th', 'padding'],
      ['.pqh-categories', 'gap'],
    ] as const) {
      expect(declaration(prelude, property)).toMatch(/var\(--space-/);
    }
  });

  it('states every font size as a scale token', () => {
    for (const prelude of PROJECT_PRELUDES) {
      const size = parseDeclarations(projectRule(prelude).body).get('font-size');
      if (size === undefined) continue;
      expect({ prelude, size }).toMatchObject({
        prelude,
        size: expect.stringMatching(/var\(--fs-/),
      });
    }
  });

  it('clamps the card’s two-line summary in type units, not in pixels', () => {
    // The mockup pins the block at 40px. Two lines of `--fs-sm` at `--lh-normal` is the same
    // rhythm at every font scale — and it is what keeps a grid of cards aligned whether or
    // not a project has a description.
    expect(declaration('.prj-card__summary', '-webkit-line-clamp')).toBe('2');
    expect(declaration('.prj-card__summary', 'min-block-size')).toBe(
      'calc(var(--fs-sm) * var(--lh-normal) * 2)'
    );
  });

  it('states the card grid’s breakpoint in rem, so it follows the font scale', () => {
    const media = SECTION.match(/@media \([^)]*\)/g) ?? [];
    expect(media.length).toBeGreaterThanOrEqual(2);
    for (const query of media) {
      // `(hover: none)` is a capability query, not a width — it has no unit to get wrong.
      if (query.includes('hover')) continue;
      expect(query).toMatch(/rem\)/);
      expect(query).not.toMatch(/\d+px/);
    }
  });
});

/* -------------------------------------------------------------------------
   3. Nothing scrolls the document sideways
   ------------------------------------------------------------------------- */

describe('horizontal containment', () => {
  it('collapses the card grid and the project form to one column', () => {
    // `auto-fit` over a `rem` minimum: three columns at the default scale, two and then one
    // as the type grows — which is what stops the Largest scale pushing a scrollbar onto the
    // document. Below the phone breakpoint the grid is pinned to a single track.
    expect(declaration('.prj-grid', 'grid-template-columns')).toBe(
      'repeat(auto-fit, minmax(18rem, 1fr))'
    );
    expect(declaration('.prj-form', 'grid-template-columns')).toBe(
      'repeat(auto-fit, minmax(18rem, 1fr))'
    );
    expect(declaration('.prj-form__pair', 'grid-template-columns')).toBe(
      'repeat(auto-fit, minmax(11rem, 1fr))'
    );
    expect(declaration('.pqh-categories', 'grid-template-columns')).toBe(
      'repeat(auto-fit, minmax(13rem, 1fr))'
    );

    const collapsed = rules.filter(
      (rule) => rule.prelude.startsWith('@media') && rule.body.includes('.prj-grid {')
    );
    expect(collapsed.length).toBeGreaterThan(0);
    expect(collapsed[0].body).toContain('grid-template-columns: minmax(0, 1fr)');
  });

  it('gives every elidable cell a floor to shrink to', () => {
    for (const prelude of [
      '.prj-card',
      '.prj-card__head',
      '.prj-card__identity',
      '.prj-card__title-line',
      '.prj-card__name',
      '.prj-identity',
      '.prj-identity__text',
      '.prj-identity__line',
      '.prj-form__col',
      '.prj-form__url',
      '.prj-form__url > input',
      '.prj-template__text',
      '.prj-dialog__heading',
    ]) {
      expect(declaration(prelude, 'min-inline-size')).toBe('0');
    }
  });

  it('caps the description cell in rem, on the block inside the cell', () => {
    // An auto-layout table ignores a `<td>`'s own `max-width` outright — HIVE-5.8 measured
    // 533px against a 400px clamp — so the ceiling lives on the block the cell holds.
    expect(declaration('.prj-desc', 'max-inline-size')).toBe('22rem');
    expect(declaration('.prj-desc', 'text-overflow')).toBe('ellipsis');
  });

  it('scrolls the scores table inside its own wrapper', () => {
    expect(declaration('.pqh-table-wrap', 'overflow-x')).toBe('auto');
  });

  it('wraps every strip that could otherwise widen its parent', () => {
    for (const prelude of [
      '.prj-card__meter',
      '.prj-card__scores',
      '.prj-card__footer',
      '.prj-status',
      '.prj-template',
      '.pqh-headline',
      '.pqh-finding__head',
      '.prj-portfolio__title',
    ]) {
      expect(declaration(prelude, 'flex-wrap')).toBe('wrap');
    }
  });
});

/* -------------------------------------------------------------------------
   4. Quiet text still clears AA, in all nine appearances
   ------------------------------------------------------------------------- */

describe('contrast', () => {
  /** Every quiet line in the block, with the ground it is drawn on. */
  const QUIET = [
    ['.prj-quiet', '--bg-surface'],
    ['.prj-stamp', '--bg-surface'],
    ['.prj-card__id', '--bg-surface'],
    ['.prj-card__summary', '--bg-surface'],
    ['.prj-card__versions', '--bg-surface'],
    ['.prj-orb__label', '--bg-surface'],
    ['.prj-tile__desc', '--bg-surface'],
    ['.prj-desc', '--bg-surface'],
    ['.prj-trend__grade', '--bg-surface'],
    ['.prj-portfolio__note', '--bg-surface'],
    ['.prj-portfolio__axis', '--bg-surface'],
    ['.prj-template__desc, .prj-template__hint', '--bg-surface'],
    ['.prj-form__title-aside', '--bg-surface'],
    ['.prj-dialog__footnote', '--bg-surface'],
    ['.pqh-lede', '--bg-surface'],
    ['.pqh-headline__note', '--bg-surface'],
    ['.pqh-category__label', '--bg-surface'],
    ['.pqh-finding__note', '--bg-surface'],
    ['.pqh-finding__path', '--bg-surface'],
    ['.prj-sort-mark', '--bg-surface'],
    ['.prj-deleted-switch', '--bg-surface'],
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

  it.each(APPEARANCES)(
    'clears AA for the deleted card’s amber footer in the %s appearance',
    (_id, block) => {
      // The pair those inks were chosen for: `--warn-fg` on `--warn-soft`, not `--warn` on
      // the surface — which HIVE-5.8 measured at 3.06:1 in High contrast.
      expect(declaration('.prj-card[data-lifecycle="deleted"] .prj-card__footer', 'color')).toBe(
        'var(--warn-fg)'
      );
      expect(
        declaration('.prj-card[data-lifecycle="deleted"] .prj-card__footer', 'background')
      ).toBe('var(--warn-soft)');
      const ratio = contrastRatio(
        paint('--warn-fg', block, PAPER),
        paint('--warn-soft', block, paint('--bg-surface', block, PAPER))
      );
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
    }
  );

  it.each(APPEARANCES)(
    'inks the destructive menu row only where it has a ground for it, in the %s appearance',
    (_id, block) => {
      // The mockup inks `.menu__item.is-danger` red at rest. No red in the token layer can
      // do that and stay readable: `--danger-fg` is calibrated against `--danger-soft` and
      // measures 1.47:1 on the surface in Nord, while the saturated `--danger` reaches only
      // 2.46:1 there. So the row takes the designed soft/ink pair when it is highlighted,
      // and is plain text otherwise.
      const highlighted =
        '.prj-menu__item--danger[data-highlighted], .prj-menu__item--danger:hover';
      expect(declaration(highlighted, 'background')).toBe('var(--danger-soft)');
      expect(declaration(highlighted, 'color')).toBe('var(--danger-fg)');
      const ratio = contrastRatio(
        paint('--danger-fg', block, PAPER),
        paint('--danger-soft', block, paint('--bg-surface', block, PAPER))
      );
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
    }
  );

  it.each(APPEARANCES)('clears the 3:1 mark floor for the Undelete glyph in the %s appearance', (_id, block) => {
    // An icon-only button: WCAG 1.4.11 asks 3:1 of a mark, not the 4.5:1 a word needs, and
    // the button's accessible name is what carries the meaning.
    expect(declaration('.prj-restore', 'color')).toBe('var(--ok)');
    const ratio = contrastRatio(paint('--ok', block, PAPER), paint('--bg-surface', block, PAPER));
    expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NON_TEXT_MIN);
  });
});

/* -------------------------------------------------------------------------
   5. The stretched link, and the two charts' one paint channel
   ------------------------------------------------------------------------- */

describe('the card’s stretched link', () => {
  it('covers the whole card, so one link is the whole hit area', () => {
    expect(declaration('.prj-card__link::after', 'content')).toBe('""');
    expect(declaration('.prj-card__link::after', 'position')).toBe('absolute');
    expect(declaration('.prj-card__link::after', 'inset')).toBe('0');
    expect(declaration('.prj-card', 'position')).toBe('relative');
  });

  it('lifts every control above it rather than under it', () => {
    expect(declaration('.prj-card__above', 'position')).toBe('relative');
    expect(declaration('.prj-card__above', 'z-index')).toBe('1');
    expect(declaration('.prj-card__actions', 'z-index')).toBe('1');
  });

  it('draws the focus ring on the card, which is what the link activates', () => {
    expect(declaration('.prj-card__link:focus-visible::after', 'box-shadow')).toBe(
      'var(--shadow-focus)'
    );
  });

  it('keeps the row menu reachable where there is no hover to reveal it', () => {
    const touch = rules.find(
      (rule) => rule.prelude === '@media (hover: none)' && rule.body.includes('.prj-card__actions')
    );
    expect(touch).toBeDefined();
    expect(touch!.body).toContain('opacity: 1');
  });
});

describe('the charts paint from one channel', () => {
  it('takes the line, the area and the dot from currentColor', () => {
    for (const prelude of ['.prj-portfolio__line', '.pqh-chart__line']) {
      expect(declaration(prelude, 'stroke')).toBe('currentColor');
    }
    for (const prelude of ['.prj-portfolio__area', '.pqh-chart__area']) {
      expect(declaration(prelude, 'fill')).toBe(
        'color-mix(in srgb, currentColor 12%, transparent)'
      );
    }
    expect(declaration('.prj-portfolio__dot', 'fill')).toBe('currentColor');
    // The scores dialog's dots are hollow so overlapping points stay countable.
    expect(declaration('.pqh-chart__dot', 'fill')).toBe('var(--bg-surface)');
    expect(declaration('.pqh-chart__dot', 'stroke')).toBe('currentColor');
  });

  it('rules the gridlines in the border token, not in a grey', () => {
    for (const prelude of ['.prj-portfolio__grid line', '.pqh-chart__grid line']) {
      expect(declaration(prelude, 'stroke')).toBe('var(--border-strong)');
      expect(declaration(prelude, 'vector-effect')).toBe('non-scaling-stroke');
    }
    for (const prelude of ['.prj-portfolio__ticks text', '.pqh-chart__ticks text']) {
      expect(declaration(prelude, 'fill')).toBe('var(--fg-muted)');
    }
  });
});
