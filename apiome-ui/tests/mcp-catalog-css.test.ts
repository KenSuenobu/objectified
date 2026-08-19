/**
 * The stylesheet half of the MCP servers catalog redesign (HIVE-7.7, #5324).
 *
 * `mcp-catalog-hive-redesign.test.tsx` renders the screen and pins its markup; it cannot pin
 * anything that makes it *look* right, because jsdom compiles no stylesheet. So this suite reads
 * `globals.css` the way `repository-bring-in-css.test.ts` and `catalog-css.test.ts` do, and pins
 * what the components lean on:
 *
 *   1. **The skin is tokens only.** What this replaces named colour outright in about seventy
 *      places — the card's `border-gray-200 bg-white … dark:bg-gray-800` frame and its
 *      `group-hover:text-indigo-600` name, the toolbar's `bg-indigo-600 text-white` density pair
 *      and `border-indigo-200 bg-indigo-50 text-indigo-700` facet chips, the strips'
 *      `border-amber-200 bg-amber-50` pins and `text-emerald-600` published word, two
 *      `text-red-600 hover:text-red-700` delete buttons, and the shadowed-names banner's
 *      `border-red-200 bg-red-50 … dark:bg-red-900/20` box. Every one froze the surface on one
 *      light palette and one dark one.
 *   2. **Nothing is frozen in pixels.** The mockup fixes the search field at 340px, the sort
 *      select at 170px, the facet grid at three columns behind a 1100px media query, the dense
 *      row's timestamp at 70px and the grade letter at 28px; all are `rem`, a token or an
 *      intrinsic grid here.
 *   3. **Every multi-column grid collapses**, so no row on this route can scroll the document
 *      sideways at any font scale.
 *   4. **Quiet text is `--fg-muted`**, not the mockup's `--fg-subtle`, which does not clear AA at
 *      these sizes — measured here in all nine appearances, on both grounds it lands on.
 *   5. **The two wells land on `--bg-inset`**, not the mockup's `--bg-subtle`: the hovered dense
 *      row carries a muted sub-line and the facet panel is almost entirely quiet text, and only
 *      one of the two grounds clears AA under either. Both are measured, so the deviation is a
 *      fact rather than a preference.
 *   6. **An active facet chip is a hairline, not a fill.** `--fg-muted` on `--accent-soft` fails
 *      in Solarized, which is why the chip keeps the surface and takes an accent hairline.
 *   7. **A frame is never the only signal.** The unreachable card's danger inset is measured, and
 *      the one theme where it cannot clear the 3:1 non-text floor is recorded as a stated limit
 *      rather than left to be discovered.
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

/** WCAG AA for a non-text mark (a hairline, a dot, a bar). */
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
 * Listed rather than pattern-matched so a rule that is *renamed* fails here instead of silently
 * dropping out of the token-only walk below.
 */
const MCP_PRELUDES = [
  // Toolbar
  '.mcp-toolbar',
  '.mcp-toolbar__search',
  '.mcp-toolbar__controls',
  '.mcp-toolbar__sort',
  '.mcp-toolbar__sort-control',
  // Facet panel
  '.mcp-facet-panel',
  '.mcp-facets',
  '.mcp-facet',
  '.mcp-facet__label',
  '.mcp-facet__chips',
  '.mcp-facet__chip',
  '.mcp-facet__chip:hover',
  '.mcp-facet__chip[data-active]',
  '.mcp-facet__value',
  '.mcp-facet__count',
  '.mcp-facet__dot',
  '.mcp-facet-panel__foot',
  '.mcp-facet-panel__note',
  // The two strips
  '.mcp-strips',
  '.mcp-strip',
  '.mcp-strip__head',
  '.mcp-strip__lead',
  '.mcp-strip__label',
  '.mcp-strip__actions',
  '.mcp-strip__body',
  '.mcp-strip__note',
  '.mcp-strip__list',
  '.mcp-strip__row',
  '.mcp-strip__row-main',
  '.mcp-strip__row-title',
  '.mcp-strip__row-sub',
  '.mcp-strip__row-actions',
  '.mcp-strip__danger',
  // The two dialogs
  '.mcp-dialog__body',
  '.mcp-dialog__summary',
  '.mcp-dialog__check',
  // Totals
  '.mcp-totals',
  '.mcp-totals__counts',
  '.mcp-totals__hint',
  // Shadowed names
  '.mcp-shadow-alert',
  '.mcp-shadow-alert__summary',
  '.mcp-shadow-alert__chevron',
  '.mcp-shadow-alert__chevron--open',
  '.mcp-shadow-alert__text',
  '.mcp-shadow-alert__count',
  '.mcp-shadow-alert__hint',
  '.mcp-shadow-list',
  '.mcp-shadow-row',
  '.mcp-shadow-row__head',
  '.mcp-shadow-row__name',
  '.mcp-shadow-row__endpoints',
  // Host group
  '.mcp-host',
  '.mcp-host__tile',
  '.mcp-host__name',
  '.mcp-host__health',
  // The two densities
  '.mcp-grid',
  '.mcp-list',
  // The grid card
  '.mcp-card',
  '.mcp-card--skeleton',
  '.mcp-card__head',
  '.mcp-card__ident',
  '.mcp-card__title',
  '.mcp-card__name',
  '.mcp-card__logo',
  '.mcp-card__logo > img',
  '.mcp-card__host',
  '.mcp-card__badges',
  '.mcp-card__foot',
  '.mcp-card__foot:last-child',
  '.mcp-card__metrics > [aria-hidden]',
  '.mcp-card__caps',
  // The dense row
  '.mcp-row',
  '.mcp-row + .mcp-row',
  '.mcp-row:hover',
  '.mcp-row__main',
  '.mcp-row__title',
  '.mcp-row__name',
  '.mcp-row__sub',
  '.mcp-row__sub > [aria-hidden]',
  '.mcp-row__when',
] as const;

/** The rules this ticket declares under more than one selector at once. */
const MCP_GROUPED_PRELUDES = [
  '.mcp-shadow-alert__bell, .mcp-shadow-alert__chevron',
  '.mcp-shadow-row__meta, .mcp-shadow-row__endpoints',
  '.mcp-card[data-alert="danger"], .mcp-row[data-alert="danger"]',
  '.mcp-card__go, .mcp-row__go',
  '.mcp-card:hover .mcp-card__go, .mcp-row:hover .mcp-row__go',
  '.mcp-card__metrics, .mcp-card__marks',
  '.mcp-row__badges, .mcp-row__when',
] as const;

/**
 * Look one of this ticket's rules up.
 *
 * @param prelude The rule's selector, exactly as the lists above spell it.
 * @returns The rule.
 */
function mcpRule(prelude: string): CssRule {
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
  const value = parseDeclarations(mcpRule(prelude).body).get(property);
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
 * This ticket's block, from its banner to the end of the file.
 *
 * It is the last section in `globals.css`, so there is no following banner to stop at — and
 * there is deliberately no *second* banner inside it either, for the reason every sibling suite
 * records: a nested `/* =` would silently cut this slice short and turn every assertion below
 * into a claim about half the block.
 */
const SECTION = (() => {
  const start = css.indexOf('MCP SERVERS CATALOG  (HIVE-7.7, #5324)');
  if (start < 0) throw new Error('globals.css has no MCP servers catalog section');
  const bannerStart = css.lastIndexOf('/* =', start);
  const next = css.indexOf('/* =', start + 1);
  return css.slice(bannerStart < 0 ? start : bannerStart, next < 0 ? css.length : next);
})();

/** The same block with its comments removed. */
const SECTION_CODE = SECTION.replace(/\/\*[\s\S]*?\*\//g, '');

/** The first line of this ticket's block, so its rules can be found by position. */
const SECTION_FIRST_LINE = css.slice(0, css.indexOf(SECTION)).split('\n').length;

/** Every top-level rule declared in this ticket's block, however its prelude is wrapped. */
const MCP_RULES: CssRule[] = rules.filter((rule) => rule.line >= SECTION_FIRST_LINE);

/* -------------------------------------------------------------------------
   1. The section exists, and names no colour
   ------------------------------------------------------------------------- */

describe('the MCP servers catalog section of globals.css', () => {
  it('declares every rule the screen references', () => {
    const missing = [...MCP_PRELUDES, ...MCP_GROUPED_PRELUDES].filter(
      (prelude) => !rules.some((rule) => rule.prelude === prelude)
    );
    expect(missing).toEqual([]);
  });

  it('is the whole block — no nested banner truncates the slice', () => {
    expect(SECTION).toContain('.mcp-toolbar');
    expect(SECTION).toContain('.mcp-row__when');
    expect(SECTION).toContain('@media (min-width: 60rem)');
  });

  it('sits after the unlayered p and h1–h4 base rules it has to outrank', () => {
    // `.mcp-host__name` is an `h3` and most of the quiet lines are `p`s; both base rules are
    // unlayered, so a rule declared before them would lose whatever its specificity.
    for (const prelude of [...MCP_PRELUDES, ...MCP_GROUPED_PRELUDES]) {
      expect(mcpRule(prelude).line).toBeGreaterThan(BASE_TYPE_RULE_LINE);
    }
  });

  it('names no colour — every value is a token', () => {
    const start = css.indexOf(SECTION);
    const unfenced = findUnfencedHex(css).filter(
      (hit) => hit.index >= start && hit.index < start + SECTION.length
    );
    expect(unfenced).toEqual([]);
    expect(SECTION_CODE).not.toMatch(/:\s*(?:red|green|blue|orange|purple|gold|teal)\b/);
    expect(SECTION_CODE).not.toMatch(/\b(?:rgba?|hsla?)\(/);
  });

  it('draws no colour except through a role token or an inherited one', () => {
    const colourish = [...SECTION_CODE.matchAll(/\b(?:color|background)\s*:\s*([^;]+);/g)].map(
      (match) => match[1].trim()
    );
    expect(colourish.length).toBeGreaterThan(15);
    for (const value of colourish) {
      expect({
        value,
        ok: /^(var\(--|currentColor|transparent|inherit|none)/.test(value),
      }).toEqual({ value, ok: true });
    }
  });

  it('names no status of its own — the shared vocabulary paints every mark', () => {
    // Grade, health, freshness and the facet dots all resolve through `ui/statusVocabulary`; a
    // `[data-status]` or `[data-grade]` rule here would be a second opinion.
    expect(SECTION_CODE).not.toMatch(/data-status/);
    expect(SECTION_CODE).not.toMatch(/data-grade/);
  });

  it('restates neither the icon tile nor the input gutter it borrows', () => {
    // `.tnt-icon-tile` (HIVE-5.1) and `.input-wrap` (HIVE-2.1) are used as-is; the block only
    // resizes the tile, which is what a modifier is for.
    expect(SECTION_CODE).not.toMatch(/\.tnt-icon-tile\s*\{/);
    expect(SECTION_CODE).not.toMatch(/\.input-wrap\s*\{/);
    expect(declaration('.mcp-host__tile', 'inline-size')).toBe(
      declaration('.mcp-host__tile', 'block-size')
    );
  });
});

/* -------------------------------------------------------------------------
   2. Nothing is frozen in pixels
   ------------------------------------------------------------------------- */

describe('type-relative sizing', () => {
  it('states every length in rem, a token or a percentage — never in px', () => {
    // The one exception is the hairline: a 1px rule is a hairline by definition and does not
    // scale with text.
    const lengths = [...SECTION_CODE.matchAll(/(\d+(?:\.\d+)?)px/g)].map((match) =>
      Number(match[1])
    );
    expect(lengths.length).toBeGreaterThan(0);
    for (const px of lengths) {
      expect({ px, hairline: px <= 2 }).toEqual({ px, hairline: true });
    }
  });

  it('sizes the mockup’s frozen search field and sort select in rem', () => {
    expect(declaration('.mcp-toolbar__search', 'flex')).toBe('1 1 17rem');
    expect(declaration('.mcp-toolbar__search', 'max-inline-size')).toBe('22rem');
    expect(declaration('.mcp-toolbar__sort-control', 'inline-size')).toBe('11rem');
    expect(declaration('.mcp-toolbar__sort-control', 'block-size')).toBe('var(--control-h-sm)');
  });

  it('sizes the dense row’s timestamp in rem rather than at the mockup’s 70px', () => {
    expect(declaration('.mcp-row__when', 'inline-size')).toBe('5rem');
  });

  it('sizes every glyph and swatch from the type or the icon token around it', () => {
    expect(declaration('.mcp-card__go, .mcp-row__go', 'inline-size')).toBe('var(--icon-dense)');
    expect(declaration('.mcp-shadow-alert__bell, .mcp-shadow-alert__chevron', 'inline-size')).toBe(
      'var(--icon-dense)'
    );
    expect(declaration('.mcp-facet__dot', 'inline-size')).toBe(
      declaration('.mcp-facet__dot', 'block-size')
    );
  });

  it('states every type size as a scale token, so all six font scales hold', () => {
    const sizes = [...SECTION_CODE.matchAll(/font-size\s*:\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(sizes.length).toBeGreaterThan(10);
    for (const size of sizes) {
      expect({ size, token: /^var\(--fs-/.test(size) }).toEqual({ size, token: true });
    }
  });
});

/* -------------------------------------------------------------------------
   3. Nothing can scroll the document sideways
   ------------------------------------------------------------------------- */

describe('layout that cannot scroll the document sideways', () => {
  it('auto-sizes every grid at a rem minimum rather than a fixed column count', () => {
    for (const [prelude, track] of [
      ['.mcp-facets', 'repeat(auto-fit, minmax(15rem, 1fr))'],
      ['.mcp-strips', 'repeat(auto-fit, minmax(24rem, 1fr))'],
      ['.mcp-grid', 'repeat(auto-fill, minmax(19rem, 1fr))'],
    ] as const) {
      expect({ prelude, track: declaration(prelude, 'grid-template-columns') }).toEqual({
        prelude,
        track,
      });
    }
  });

  it('replaces the mockup’s 1100px facet breakpoint with an intrinsic track', () => {
    expect(SECTION_CODE).not.toMatch(/max-width:\s*(?:1100px|68\.75rem)/);
  });

  it('drops the dense row’s badges and timestamp before the row can overflow', () => {
    // Below the breakpoint the card grid is the better view, and the density control is one
    // click away — so the row sheds the two things that cannot shrink rather than scrolling.
    expect(declaration('.mcp-row__badges, .mcp-row__when', 'display')).toBe('none');
    const media = SECTION.slice(SECTION.indexOf('@media (min-width: 60rem)'));
    expect(media).toContain('.mcp-row__badges');
    expect(media).toContain('.mcp-row__when');
  });

  it('lets a long name, host or summary break rather than hold its row open', () => {
    // `overflow-wrap`/`text-overflow` only work because every ancestor carries
    // `min-inline-size: 0` — the chain the browser suite measures.
    for (const prelude of ['.mcp-card__head', '.mcp-card__ident', '.mcp-card__title']) {
      expect({ prelude, min: declaration(prelude, 'min-inline-size') }).toEqual({
        prelude,
        min: '0',
      });
    }
    expect(declaration('.mcp-card__name', 'text-overflow')).toBe('ellipsis');
    expect(declaration('.mcp-strip__row-sub', 'overflow-wrap')).toBe('anywhere');
    expect(declaration('.mcp-host__name', 'overflow-wrap')).toBe('anywhere');
    expect(declaration('.mcp-shadow-row__name', 'overflow-wrap')).toBe('anywhere');
  });

  it('wraps every control row rather than letting it push the page wide', () => {
    for (const prelude of [
      '.mcp-toolbar',
      '.mcp-toolbar__controls',
      '.mcp-facet__chips',
      '.mcp-strip__head',
      '.mcp-strip__actions'.replace('__actions', '__lead'),
      '.mcp-totals',
      '.mcp-card__badges',
      '.mcp-card__foot',
    ]) {
      expect({ prelude, wrap: declaration(prelude, 'flex-wrap') }).toEqual({
        prelude,
        wrap: 'wrap',
      });
    }
  });
});

/* -------------------------------------------------------------------------
   4. Quiet text clears AA in every appearance
   ------------------------------------------------------------------------- */

describe('quiet text', () => {
  /** Every rule on this screen whose whole job is to be the quieter line. */
  const QUIET = [
    '.mcp-facet__label',
    '.mcp-facet__count',
    '.mcp-facet-panel__note',
    '.mcp-strip__label',
    '.mcp-strip__note',
    '.mcp-strip__row-sub',
    '.mcp-dialog__summary',
    '.mcp-totals__hint',
    '.mcp-shadow-row__meta, .mcp-shadow-row__endpoints',
    '.mcp-host__health',
    '.mcp-card__host',
    '.mcp-card__caps',
    '.mcp-row__sub',
  ] as const;

  it('uses --fg-muted, never the --fg-subtle the mockup reaches for', () => {
    for (const prelude of QUIET) {
      expect({ prelude, ink: declaration(prelude, 'color') }).toEqual({
        prelude,
        ink: 'var(--fg-muted)',
      });
    }
    expect(SECTION_CODE).not.toContain('var(--fg-subtle)');
  });

  it('spends --fg-faint only on the decorative marks', () => {
    const faint = MCP_RULES.filter(
      (rule) => parseDeclarations(rule.body).get('color') === 'var(--fg-faint)'
    );
    expect(faint.map((rule) => rule.prelude).sort()).toEqual([
      '.mcp-card__go, .mcp-row__go',
      '.mcp-card__metrics > [aria-hidden]',
      '.mcp-row__sub > [aria-hidden]',
    ]);
  });

  it('clears AA on both grounds it is drawn on, in all nine appearances', () => {
    for (const [name, appearance] of APPEARANCES) {
      const surface = paint('--bg-surface', appearance, PAPER);
      const inset = paint('--bg-inset', appearance, surface);
      expect({
        name,
        // The card, the strips and the totals line sit on the surface…
        onSurface:
          contrastRatio(paint('--fg-muted', appearance, surface), surface) >=
          WCAG_AA_NORMAL_TEXT_MIN,
        // …the facet panel and the hovered dense row on the well below it.
        onInset:
          contrastRatio(paint('--fg-muted', appearance, inset), inset) >=
          WCAG_AA_NORMAL_TEXT_MIN,
      }).toEqual({ name, onSurface: true, onInset: true });
    }
  });

  it('puts the facet panel on --bg-inset rather than the mockup’s --bg-subtle', () => {
    // The panel is almost entirely quiet text — ten caps labels, ten counts and the rule note.
    expect(declaration('.mcp-facet-panel', 'background')).toBe('var(--bg-inset)');
  });
});

/* -------------------------------------------------------------------------
   5. The two measured deviations from the mockup
   ------------------------------------------------------------------------- */

describe('the two wells: the hovered row and the facet panel', () => {
  it('both land on --bg-inset rather than the mockup’s --bg-subtle', () => {
    expect(declaration('.mcp-row:hover', 'background')).toBe('var(--bg-inset)');
    expect(declaration('.mcp-facet-panel', 'background')).toBe('var(--bg-inset)');
    // The one `--bg-subtle` left in the block is the skeleton card, which carries no text.
    const onSubtle = MCP_RULES.filter(
      (rule) => parseDeclarations(rule.body).get('background') === 'var(--bg-subtle)'
    );
    expect(onSubtle.map((rule) => rule.prelude)).toEqual(['.mcp-card--skeleton']);
  });

  it('proves the deviation: muted text fails on --bg-subtle somewhere', () => {
    // If this ever stops being true, the mockup's ground can be restored.
    const failures = APPEARANCES.filter(([, appearance]) => {
      const surface = paint('--bg-surface', appearance, PAPER);
      const subtle = paint('--bg-subtle', appearance, surface);
      return contrastRatio(paint('--fg-muted', appearance, subtle), subtle) < WCAG_AA_NORMAL_TEXT_MIN;
    });
    expect(failures.length).toBeGreaterThan(0);
  });
});

describe('the active facet chip', () => {
  it('is an accent hairline over the surface, not an accent fill', () => {
    expect(declaration('.mcp-facet__chip', 'background')).toBe('var(--bg-surface)');
    expect(declaration('.mcp-facet__chip[data-active]', 'box-shadow')).toBe(
      'inset 0 0 0 1px var(--accent)'
    );
    expect(declaration('.mcp-facet__chip[data-active]', 'color')).toBe('var(--accent-fg)');
    // A chip that is on has no fill of its own, so nothing below it changes ground.
    expect(parseDeclarations(mcpRule('.mcp-facet__chip[data-active]').body).has('background')).toBe(
      false
    );
  });

  it('measures the hairline as a mark and the ink as text, in all nine appearances', () => {
    for (const [name, appearance] of APPEARANCES) {
      const surface = paint('--bg-surface', appearance, PAPER);
      expect({
        name,
        mark: contrastRatio(paint('--accent', appearance, surface), surface) >= WCAG_AA_NON_TEXT_MIN,
        ink:
          contrastRatio(paint('--accent-fg', appearance, surface), surface) >=
          WCAG_AA_NORMAL_TEXT_MIN,
      }).toEqual({ name, mark: true, ink: true });
    }
  });

  it('proves the deviation: a muted count on --accent-soft would fail', () => {
    // The mockup fills a selected chip with `--accent-soft`. The count beside the value stays
    // quiet, and that pair does not survive every theme — so the chip keeps the surface.
    const failures = APPEARANCES.filter(([, appearance]) => {
      const surface = paint('--bg-surface', appearance, PAPER);
      const soft = paint('--accent-soft', appearance, surface);
      return contrastRatio(paint('--fg-muted', appearance, soft), soft) < WCAG_AA_NORMAL_TEXT_MIN;
    });
    expect(failures.length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------
   6. A frame carries emphasis, not meaning
   ------------------------------------------------------------------------- */

describe('the unreachable card’s frame', () => {
  it('is a hairline inset that keeps the card’s own elevation', () => {
    expect(declaration('.mcp-card[data-alert="danger"], .mcp-row[data-alert="danger"]', 'box-shadow')).toBe(
      'inset 0 0 0 1px var(--danger), var(--shadow-sm)'
    );
  });

  it('records the stated limit rather than claiming the frame clears 3:1 everywhere', () => {
    // The block header says this: the frame is emphasis, and the card's health pill prints
    // "Unreachable" in words on its own tinted ground. The measurement is kept here so the
    // claim stays honest if a theme's `--danger` ever moves.
    const failing = APPEARANCES.filter(([, appearance]) => {
      const surface = paint('--bg-surface', appearance, PAPER);
      return contrastRatio(paint('--danger', appearance, surface), surface) < WCAG_AA_NON_TEXT_MIN;
    }).map(([name]) => name);
    expect(failing).toContain('nord');
  });

  it('fades nothing — a quarantined endpoint keeps its text at full contrast', () => {
    // Dimming a row fades its words with it, which is the call HIVE-7.3 recorded.
    expect(SECTION_CODE).not.toMatch(/opacity\s*:\s*0?\.[0-9]/);
  });
});
