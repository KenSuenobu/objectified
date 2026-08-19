/**
 * The stylesheet half of the repository-detail redesign (HIVE-7.5, #5322).
 *
 * `repository-detail-hive-redesign.test.tsx` renders the screen and pins its markup; it cannot
 * pin anything that makes it *look* right, because jsdom compiles no stylesheet. So this suite
 * reads `globals.css` the way `repositories-css.test.ts` and `add-repository-css.test.ts` do,
 * and pins what the components lean on:
 *
 *   1. **The skin is tokens only.** What this replaces named colour outright in about 1,250
 *      places across five components — a `from-emerald-500 to-teal-500` medallion,
 *      `bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40` status pills,
 *      `bg-indigo-50/60 dark:bg-indigo-900/10` selected rows, `bg-purple-50/60` diverged rows,
 *      a `border-rose-200 bg-rose-50` danger zone, and four literal hex values in the
 *      relationship diagram. Every one froze the surface on one light palette and one dark one.
 *   2. **Nothing is frozen in pixels.** The mockup's page-local block fixes the refresh chip at
 *      20px, the filter fields at 250/220/180px, the branch popover at 300px, the row menu at
 *      220px and the source viewer at 320px; all are `rem` or a token here.
 *   3. **Every multi-column grid collapses**, so no row on this route can scroll the document
 *      sideways at any font scale — and the two tables that cannot collapse scroll inside their
 *      own wrapper instead.
 *   4. **Quiet text is `--fg-muted`**, not the mockup's `--fg-subtle`, which does not clear AA
 *      at these sizes — measured here in all nine appearances.
 *   5. **Every tone ink sits on the `-soft` ground it was calibrated against.** `--ok-fg` /
 *      `--warn-fg` / `--danger-fg` on the plain card measure 1.5–3.5:1 in the six themes that
 *      inherit the light semantic pairs, which is the exposure HIVE-7.3 recorded. Each `-fg`
 *      here is paired with its own `-soft` ground, and every pair is measured.
 *   6. **A selected row and a chosen card are never colour alone.** DESIGN.md §6: the accent
 *      tint is joined by an accent hairline that clears 3:1 as a non-text mark in every
 *      appearance, and both re-ink their quiet lines where the muted step fails on the tint.
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

/** WCAG 1.4.11 for a non-text mark — an icon, a bar, a hairline. */
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
const REPOSITORY_DETAIL_PRELUDES = [
  '.repo-det-note',
  '.repo-det-note--tight',
  '.repo-det-link',
  '.repo-det-link:hover',
  '.repo-det-link:focus-visible',
  '.repo-det-card__title',
  '.repo-det-card__title > svg',
  '.repo-det-card__head',
  '.repo-det-caps',
  '.repo-det-chips',
  '.repo-det-split',
  '.repo-det-rows > * + *',
  '.repo-det-row',
  '.repo-det-row__end',
  '.repo-det-mix',
  '.repo-det-mix__row',
  '.repo-det-mix__value',
  '.repo-det-table-wrap',
  '.repo-det-table-scroll',
  '.repo-det-table',
  '.repo-det-table thead th',
  '.repo-det-table tbody td',
  '.repo-det-table tbody tr + tr td',
  '.repo-det-table tbody tr:hover td',
  '.repo-det-table .repo-det-num',
  '.repo-det-subcell',
  '.repo-det-table__state',
  '.repo-det-table__state[data-tone=\'danger\']',
  '.repo-det-table__foot',
  '.repo-det-table__bar',
  '.repo-det-table__bar-end',
  '.repo-files-branchbar',
  '.repo-files-branchbar__note',
  '.repo-files-branchbar__note > svg',
  '.repo-files-branchbar__end',
  '.repo-files-branch',
  '.repo-files-branch__label',
  '.repo-files-branch__name',
  '.repo-files-branch-menu',
  '.repo-files-branch-menu__head',
  '.repo-files-branch-menu__list',
  '.repo-files-branch-menu__foot',
  '.repo-files-branch-menu__item',
  '.repo-files-branch-menu__tick',
  '.repo-files-branch-menu__tick[data-checked=\'false\']',
  '.repo-files-branch-menu__name',
  '.repo-files-filters',
  '.repo-files-filters__fields',
  '.repo-files-filters__switches',
  '.repo-files-filters__actions',
  '.repo-files-check',
  '.repo-files-check:has(input:disabled)',
  '.repo-files-check > input',
  '.repo-files-table .repo-files-table__path',
  '.repo-files-table .repo-files-table__check',
  '.repo-files-table__link',
  '.repo-files-table__link:hover',
  '.repo-files-table__link:focus-visible',
  '.repo-files-table tbody tr[data-selected=\'true\'] td',
  '.repo-files-table tbody tr[data-selected=\'true\']:hover td',
  '.repo-files-table tbody tr[data-selected=\'true\'] td:first-child',
  '.repo-files-table tbody tr[data-selected=\'true\'] .repo-det-quiet-cell',
  '.repo-det-quiet-cell',
  '.repo-files-table[data-loading=\'true\']',
  '.repo-file-split',
  '.repo-file-split--source-only',
  '.repo-file-column',
  '.repo-file-head',
  '.repo-file-head__text',
  '.repo-file-head__path',
  '.repo-file-head__marks',
  '.repo-file-kv',
  '.repo-file-kv > dt',
  '.repo-file-kv > dd',
  '.repo-file-verdict',
  '.repo-file-verdict[data-tone=\'ok\']',
  '.repo-file-verdict[data-tone=\'warn\']',
  '.repo-file-verdict[data-tone=\'danger\']',
  '.repo-file-verdict__detail',
  '.repo-file-verdict-facts',
  '.repo-file-verdict-facts li',
  '.repo-file-verdict-facts svg',
  '.repo-file-viewer',
  '.repo-file-viewer__bar',
  '.repo-file-viewer__syntax',
  '.repo-file-viewer__code',
  '.repo-file-tables',
  '.repo-file-tables__section',
  '.repo-file-sort',
  '.repo-file-sort:hover',
  '.repo-file-sort:focus-visible',
  '.repo-file-sort > svg',
  '.repo-file-sort[data-sorted=\'none\'] > svg',
  '.repo-file-sort[data-sorted=\'asc\'] > svg, .repo-file-sort[data-sorted=\'desc\'] > svg',
  '.repo-flow',
  '.repo-flow__minimap',
  '.repo-flow-node',
  '.repo-flow-node[data-composed=\'true\']',
  '.repo-flow-node__head',
  '.repo-flow-node__name',
  '.repo-flow-node__count',
  '.repo-flow-node__handle',
  '.repo-map-grid',
  '.repo-map-column',
  '.repo-map-choice',
  '.repo-map-choice:hover',
  '.repo-map-choice:has(input[type=\'radio\']:checked)',
  '.repo-map-choice:has(> input[type=\'radio\']:focus-visible)',
  '.repo-map-choice > input[type=\'radio\']',
  '.repo-map-choice__body',
  '.repo-map-choice__title',
  '.repo-map-choice__title > svg',
  '.repo-map-choice__desc',
  '.repo-map-choice:has(input[type=\'radio\']:checked) .repo-map-choice__title, .repo-map-choice:has(input[type=\'radio\']:checked) .repo-map-choice__desc',
  '.repo-map-choice__fields',
  '.repo-map-choice:has(input[type=\'radio\']:checked) .repo-map-choice__fields :is(input, button, select)',
  '.repo-map-facts',
  '.repo-map-fact__label',
  '.repo-map-fact__value',
  '.repo-map-tiles',
  '.repo-map-tile',
  '.repo-map-tile__value',
  '.repo-map-tile__label',
  '.repo-map-actions',
  '.repo-map-actions__help',
  '.repo-map-actions__help[data-tone=\'ok\']',
  '.repo-map-actions__help > svg',
  '.repo-specs-chip',
  '.repo-specs-table tbody tr[data-status=\'diverged\'] td',
  '.repo-specs-table tbody tr[data-status=\'diverged\']:hover td',
  '.repo-specs-notice',
  '.repo-specs-notice[data-tone=\'ok\']',
  '.repo-specs-notice[data-tone=\'danger\']',
  '.repo-set-kv',
  '.repo-set-kv > dt',
  '.repo-set-kv > dd',
  '.repo-set-switch',
  '.repo-set-switch__text',
  '.repo-set-stub',
  '.repo-set-stub__grid',
  '.repo-set-policy',
  '.repo-set-policy:hover',
  '.repo-set-policy[data-selected=\'true\']',
  '.repo-set-policy:has(input:focus-visible)',
  '.repo-set-policy:has(input:disabled)',
  '.repo-set-policy > input',
  '.repo-set-policy__body',
  '.repo-set-policy__title',
  '.repo-set-policy__desc',
  '.repo-set-policy[data-selected=\'true\'] .repo-set-policy__title, .repo-set-policy[data-selected=\'true\'] .repo-set-policy__desc',
  '.repo-set-override-form',
  '.repo-set-danger',
  '.repo-set-danger__title',
  '.repo-set-danger__row',
  '.repo-set-danger__copy',
] as const;

/**
 * Look one of this ticket's rules up.
 *
 * @param prelude The rule's selector, exactly as {@link REPOSITORY_DETAIL_PRELUDES} lists it.
 * @returns The rule.
 */
function detailRule(prelude: string): CssRule {
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
  const value = parseDeclarations(detailRule(prelude).body).get(property);
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
 * It is the last section in `globals.css`, so unlike the earlier blocks there is no following
 * banner to stop at — and there is deliberately no *second* banner inside it either, for the
 * reason `repositories-css.test.ts` and `add-repository-css.test.ts` both record: a nested
 * `/* =` would silently cut this slice short and turn every assertion below into a claim about
 * half the block.
 */
const SECTION = (() => {
  const start = css.indexOf('REPOSITORY DETAIL  (HIVE-7.5, #5322)');
  if (start < 0) throw new Error('globals.css has no repository-detail section');
  const bannerStart = css.lastIndexOf('/* =', start);
  const next = css.indexOf('/* =', start + 1);
  return css.slice(bannerStart < 0 ? start : bannerStart, next < 0 ? css.length : next);
})();

/** The same block with its comments removed. */
const SECTION_CODE = SECTION.replace(/\/\*[\s\S]*?\*\//g, '');

/* -------------------------------------------------------------------------
   1. The section exists, and names no colour
   ------------------------------------------------------------------------- */

describe('the repository-detail section of globals.css', () => {
  it('declares every rule the components reference', () => {
    const missing = REPOSITORY_DETAIL_PRELUDES.filter(
      (prelude) => !rules.some((rule) => rule.prelude === prelude)
    );
    expect(missing).toEqual([]);
  });

  it('is the whole block — no nested banner truncates the slice', () => {
    expect(SECTION).toContain('.repo-det-note');
    expect(SECTION).toContain('.repo-set-danger__copy');
    expect(SECTION).toContain('@media (max-width: 40rem)');
  });

  it('sits after the unlayered p and h1–h4 base rules it has to outrank', () => {
    // `.repo-det-card__title`, `.repo-file-head__path` and `.repo-set-danger__title` are
    // `h2`/`h3`s and `.repo-det-note`, `.repo-map-choice__desc` and `.repo-flow-node__count`
    // are `p`s; both base rules are unlayered, so a rule declared before them would lose
    // whatever its specificity.
    for (const prelude of REPOSITORY_DETAIL_PRELUDES) {
      expect(detailRule(prelude).line).toBeGreaterThan(BASE_TYPE_RULE_LINE);
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

  it('draws no colour except through a role token', () => {
    const colourish = [...SECTION_CODE.matchAll(/\b(?:color|background)\s*:\s*([^;]+);/g)].map(
      (match) => match[1].trim()
    );
    expect(colourish.length).toBeGreaterThan(30);
    for (const value of colourish) {
      expect({
        value,
        ok: /^(var\(--|currentColor|transparent|inherit|none|color-mix\()/.test(value),
      }).toEqual({ value, ok: true });
    }
  });

  it('names no status, health or refresh state of its own', () => {
    // All four vocabularies resolve through `ui/statusVocabulary.ts`; a second table here is
    // how two screens end up disagreeing about what "stale" looks like.
    expect(SECTION_CODE).not.toMatch(/data-status=["'](?!diverged)/);
    expect(SECTION_CODE).not.toMatch(/data-health/);
    expect(SECTION_CODE).not.toMatch(/data-provider/);
  });
});

/* -------------------------------------------------------------------------
   2. Nothing is frozen in pixels
   ------------------------------------------------------------------------- */

describe('type-relative sizing', () => {
  it('states every length in rem, a token, a percentage or a viewport unit — never in px', () => {
    // The one exception is the hairline: a 1px rule is a hairline by definition and does not
    // scale with text. The focus ring's 2px outline is the platform's own, not a length.
    const lengths = [...SECTION_CODE.matchAll(/(\d+(?:\.\d+)?)px/g)].map((match) =>
      Number(match[1])
    );
    expect(lengths.length).toBeGreaterThan(0);
    for (const px of lengths) {
      expect({ px, hairline: px <= 2 }).toEqual({ px, hairline: true });
    }
  });

  it('sizes the mockup’s frozen widths in rem', () => {
    // 300px branch popover → 21rem; 320px source viewer → 32.5rem capped at 70vh.
    expect(declaration('.repo-files-branch-menu', 'inline-size')).toBe(
      'min(calc(100vw - 2rem), 21rem)'
    );
    expect(declaration('.repo-files-branch-menu__list', 'max-block-size')).toBe('15rem');
    expect(declaration('.repo-file-viewer__code', 'block-size')).toBe('min(32.5rem, 70vh)');
    expect(declaration('.repo-flow', 'block-size')).toBe('min(32.5rem, 70vh)');
  });

  it('sizes every glyph from the icon token rather than from a pixel count', () => {
    for (const prelude of [
      '.repo-det-card__title > svg',
      '.repo-files-branchbar__note > svg',
      '.repo-files-branch-menu__tick',
      '.repo-files-check > input',
      '.repo-file-verdict-facts svg',
      '.repo-file-sort > svg',
      '.repo-map-choice > input[type=\'radio\']',
      '.repo-map-choice__title > svg',
      '.repo-map-actions__help > svg',
      '.repo-set-policy > input',
    ]) {
      expect({ prelude, size: declaration(prelude, 'inline-size') }).toEqual({
        prelude,
        size: 'var(--icon-dense)',
      });
    }
  });

  it('gives the refresh chip a height derived from its own type', () => {
    expect(declaration('.repo-specs-chip', 'min-block-size')).toBe('calc(var(--fs-2xs) * 2)');
  });
});

/* -------------------------------------------------------------------------
   3. Nothing can scroll the document sideways
   ------------------------------------------------------------------------- */

describe('layout that cannot scroll the document sideways', () => {
  it('auto-fits every field and tile grid at a rem minimum', () => {
    for (const [prelude, minimum] of [
      ['.repo-files-filters__fields', '13rem'],
      ['.repo-map-choice__fields', '12rem'],
      ['.repo-map-facts', '8rem'],
      ['.repo-map-tiles', '6rem'],
      ['.repo-set-stub__grid', '14rem'],
      ['.repo-set-override-form', '11rem'],
    ] as const) {
      expect({ prelude, columns: declaration(prelude, 'grid-template-columns') }).toEqual({
        prelude,
        columns: `repeat(auto-fit, minmax(${minimum}, 1fr))`,
      });
    }
  });

  it('collapses every fixed-column grid before a phone, in rem breakpoints', () => {
    const media = SECTION.slice(SECTION.indexOf('@media (max-width: 64rem)'));
    for (const selector of ['.repo-det-split', '.repo-file-split', '.repo-map-grid']) {
      expect({ selector, collapses: media.includes(selector) }).toEqual({
        selector,
        collapses: true,
      });
    }
    expect(media).toContain('minmax(0, 1fr)');

    const phone = SECTION.slice(SECTION.indexOf('@media (max-width: 40rem)'));
    for (const selector of ['.repo-file-kv', '.repo-set-kv']) {
      expect({ selector, collapses: phone.includes(selector) }).toEqual({
        selector,
        collapses: true,
      });
    }
  });

  it('lets a wide table scroll inside its own wrapper, never taking the page with it', () => {
    // Eight columns cannot collapse, so the only other answer is a document that scrolls.
    expect(declaration('.repo-det-table-scroll', 'overflow-x')).toBe('auto');
    expect(declaration('.repo-det-table-scroll', 'min-inline-size')).toBe('0');
    expect(declaration('.repo-det-table-wrap', 'min-inline-size')).toBe('0');
  });

  it('keeps the branch list scrolling inside the popover', () => {
    expect(declaration('.repo-files-branch-menu__list', 'overflow-y')).toBe('auto');
    expect(declaration('.repo-files-branch-menu__list', 'overscroll-behavior')).toBe('contain');
  });

  it('gives every truncating child a floor of zero so its ancestor cannot be held open', () => {
    // `text-overflow: ellipsis` on a flex child only works when the chain above it can shrink.
    for (const prelude of [
      '.repo-files-branch',
      '.repo-files-branch__name',
      '.repo-files-branchbar__note',
      '.repo-files-branch-menu__item',
      '.repo-files-branch-menu__name',
      '.repo-file-head__text',
      '.repo-file-column',
      '.repo-map-column',
      '.repo-flow-node__head',
      '.repo-flow-node__name',
    ]) {
      expect({ prelude, min: declaration(prelude, 'min-inline-size') }).toEqual({
        prelude,
        min: '0',
      });
    }
  });

  it('wraps every action cluster rather than squeezing it', () => {
    for (const prelude of [
      '.repo-det-card__head',
      '.repo-det-table__bar',
      '.repo-det-table__bar-end',
      '.repo-det-table__foot',
      '.repo-files-branchbar',
      '.repo-files-branchbar__end',
      '.repo-files-filters__switches',
      '.repo-file-head',
      '.repo-file-head__marks',
      '.repo-set-switch',
      '.repo-set-danger__row',
    ]) {
      expect({ prelude, wrap: declaration(prelude, 'flex-wrap') }).toEqual({
        prelude,
        wrap: 'wrap',
      });
    }
  });

  it('lets a long path break rather than hold a cell open', () => {
    for (const prelude of [
      '.repo-files-table__link',
      '.repo-file-head__path',
      '.repo-file-kv > dd',
      '.repo-set-kv > dd',
      '.repo-file-verdict__detail',
    ]) {
      expect({ prelude, wrap: declaration(prelude, 'overflow-wrap') }).toEqual({
        prelude,
        wrap: 'anywhere',
      });
    }
  });
});

/* -------------------------------------------------------------------------
   4. Contrast, in all nine appearances
   ------------------------------------------------------------------------- */

describe('quiet text clears AA in every theme', () => {
  it('uses --fg-muted, never the mockup’s --fg-subtle', () => {
    for (const prelude of [
      '.repo-det-note',
      '.repo-det-caps',
      '.repo-det-row__end',
      '.repo-det-subcell',
      '.repo-det-table__state',
      '.repo-det-table__foot',
      '.repo-det-quiet-cell',
      '.repo-files-branchbar__note',
      '.repo-files-branch__label',
      '.repo-files-check',
      '.repo-file-kv > dt',
      '.repo-file-verdict-facts',
      '.repo-map-choice__desc',
      '.repo-map-fact__label',
      '.repo-map-tile__label',
      '.repo-map-actions__help',
      '.repo-flow-node__count',
      '.repo-set-kv > dt',
      '.repo-set-policy__desc',
      '.repo-set-danger__copy',
    ]) {
      expect({ prelude, ink: declaration(prelude, 'color') }).toEqual({
        prelude,
        ink: 'var(--fg-muted)',
      });
    }
    // One `--fg-subtle` remains, on `.repo-det-card__title > svg`: a decorative glyph beside
    // a heading is a mark, not copy, and it is the step `.hive-stat__label > svg` already
    // takes. Nothing that carries words may use it.
    const subtleRules = [...SECTION_CODE.matchAll(/([^{}]+)\{([^{}]*--fg-subtle[^{}]*)\}/g)].map(
      (match) => match[1].trim().replace(/\s+/g, ' ')
    );
    expect(subtleRules).toEqual(['.repo-det-card__title > svg']);
  });

  it('never grounds the muted step on --bg-subtle, where Solarized measures 4.34:1', () => {
    // The finding axe reported on the wizard's Source card, which was `Card variant="soft"`.
    // Every quiet line on this screen sits on `--bg-surface` or on `--bg-inset`.
    const subtleGrounds = [...SECTION_CODE.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(
      ([, , body]) => /background:\s*var\(--bg-subtle\)/.test(body) && /--fg-muted/.test(body)
    );
    expect(subtleGrounds).toEqual([]);
  });

  it('inks a link-styled control with --accent-fg, not the saturated --accent', () => {
    // `ui/Button`'s `link` variant inks `text-accent`, which measures 4.14:1 at `--fs-xs` on
    // the light surface — a serious axe finding. Every link on this screen re-inks.
    expect(declaration('.repo-det-link', 'color')).toBe('var(--accent-fg)');
    for (const [name, block] of APPEARANCES) {
      const surface = paint('--bg-surface', block, PAPER);
      const ink = paint('--accent-fg', block, surface);
      expect({ name, ok: contrastRatio(ink, surface) >= WCAG_AA_NORMAL_TEXT_MIN }).toEqual({
        name,
        ok: true,
      });
    }
  });

  it('measures --fg-muted on the card surface at 4.5:1 or better, nine times', () => {
    for (const [name, block] of APPEARANCES) {
      const surface = paint('--bg-surface', block, PAPER);
      const ink = paint('--fg-muted', block, surface);
      expect({ name, ok: contrastRatio(ink, surface) >= WCAG_AA_NORMAL_TEXT_MIN }).toEqual({
        name,
        ok: true,
      });
    }
  });

  it('grounds the table head on --bg-inset, where the muted step still clears AA', () => {
    // Measured: `--fg-muted` on `--bg-subtle` is 4.35:1 in Solarized — the pair a table head
    // reaches for first, and the one that fails. On `--bg-inset` it is 5.02 worst-of-nine.
    expect(declaration('.repo-det-table thead th', 'background')).toBe('var(--bg-inset)');
    expect(declaration('.repo-file-viewer__syntax', 'background')).toBe('var(--bg-inset)');

    for (const [name, block] of APPEARANCES) {
      const surface = paint('--bg-surface', block, PAPER);
      const head = paint('--bg-inset', block, surface);
      const ink = paint('--fg-muted', block, head);
      expect({ name, ok: contrastRatio(ink, head) >= WCAG_AA_NORMAL_TEXT_MIN }).toEqual({
        name,
        ok: true,
      });
    }
  });

  it('hovers a row onto --bg-inset too, so its quiet cells stay readable', () => {
    expect(declaration('.repo-det-table tbody tr:hover td', 'background')).toBe(
      'var(--bg-inset)'
    );
  });

  it('raises a selected row’s quiet cells to --fg, where the muted step fails on the tint', () => {
    // Measured: `--fg-muted` on `--accent-soft` is 3.86:1 in Solarized — the finding HIVE-7.4
    // recorded. `--fg` is 6.51 worst-of-nine.
    expect(
      declaration(
        ".repo-files-table tbody tr[data-selected='true'] .repo-det-quiet-cell",
        'color'
      )
    ).toBe('var(--fg)');

    for (const [name, block] of APPEARANCES) {
      const surface = paint('--bg-surface', block, PAPER);
      const tint = paint('--accent-soft', block, surface);
      const ink = paint('--fg', block, tint);
      expect({ name, ok: contrastRatio(ink, tint) >= WCAG_AA_NORMAL_TEXT_MIN }).toEqual({
        name,
        ok: true,
      });
    }
  });

  it('re-inks a chosen choice card with the tint’s own calibrated pair', () => {
    for (const prelude of [
      ".repo-map-choice:has(input[type='radio']:checked) .repo-map-choice__title, .repo-map-choice:has(input[type='radio']:checked) .repo-map-choice__desc",
      ".repo-set-policy[data-selected='true'] .repo-set-policy__title, .repo-set-policy[data-selected='true'] .repo-set-policy__desc",
    ]) {
      expect({ prelude, ink: declaration(prelude, 'color') }).toEqual({
        prelude,
        ink: 'var(--accent-fg)',
      });
    }

    for (const [name, block] of APPEARANCES) {
      const surface = paint('--bg-surface', block, PAPER);
      const tint = paint('--accent-soft', block, surface);
      const ink = paint('--accent-fg', block, tint);
      expect({ name, ok: contrastRatio(ink, tint) >= WCAG_AA_NORMAL_TEXT_MIN }).toEqual({
        name,
        ok: true,
      });
    }
  });
});

describe('every tinted strip is a calibrated pair', () => {
  /** The three tones the verdict and the notice draw, with their grounds and inks. */
  const STRIPS = [
    ['.repo-file-verdict', '--neutral-soft', '--neutral-fg'],
    [".repo-file-verdict[data-tone='ok']", '--ok-soft', '--ok-fg'],
    [".repo-file-verdict[data-tone='warn']", '--warn-soft', '--warn-fg'],
    [".repo-file-verdict[data-tone='danger']", '--danger-soft', '--danger-fg'],
    ['.repo-specs-notice', '--neutral-soft', '--neutral-fg'],
    [".repo-specs-notice[data-tone='ok']", '--ok-soft', '--ok-fg'],
    [".repo-specs-notice[data-tone='danger']", '--danger-soft', '--danger-fg'],
    // The two lines that would otherwise be a tone ink on the plain surface: `--danger-fg`
    // measures 1.47:1 in Nord and `--ok-fg` 1.54:1, so both are strips.
    [".repo-det-table__state[data-tone='danger']", '--danger-soft', '--danger-fg'],
    [".repo-map-actions__help[data-tone='ok']", '--ok-soft', '--ok-fg'],
  ] as const;

  it('pairs each `-fg` ink with its own `-soft` ground, never with the plain surface', () => {
    for (const [prelude, ground, ink] of STRIPS) {
      expect({ prelude, ground: declaration(prelude, 'background') }).toEqual({
        prelude,
        ground: `var(${ground})`,
      });
      expect({ prelude, ink: declaration(prelude, 'color') }).toEqual({
        prelude,
        ink: `var(${ink})`,
      });
    }
  });

  it('measures every pair at 4.5:1 or better in all nine appearances', () => {
    for (const [prelude, ground, inkToken] of STRIPS) {
      for (const [name, block] of APPEARANCES) {
        const surface = paint('--bg-surface', block, PAPER);
        const fill = paint(ground, block, surface);
        const ink = paint(inkToken, block, fill);
        expect({
          prelude,
          name,
          ok: contrastRatio(ink, fill) >= WCAG_AA_NORMAL_TEXT_MIN,
        }).toEqual({ prelude, name, ok: true });
      }
    }
  });

  it('keeps the danger heading off the plain surface, where no red clears AA', () => {
    // `--danger-fg` on `--bg-surface` measures under 4.5:1 in Nord and Darcula, so the
    // heading takes a `--danger-soft` chip of its own rather than sitting on the card.
    expect(declaration('.repo-set-danger__title', 'background')).toBe('var(--danger-soft)');
    expect(declaration('.repo-set-danger__title', 'color')).toBe('var(--danger-fg)');
  });
});

describe('a state is never colour alone', () => {
  it('joins a selected row’s tint with an accent hairline', () => {
    expect(
      declaration(".repo-files-table tbody tr[data-selected='true'] td:first-child", 'box-shadow')
    ).toContain('var(--accent)');
    expect(
      declaration(".repo-map-choice:has(input[type='radio']:checked)", 'box-shadow')
    ).toContain('var(--accent)');
    expect(declaration(".repo-set-policy[data-selected='true']", 'box-shadow')).toContain(
      'var(--accent)'
    );
  });

  it('measures --accent as a mark against the tint it sits on, nine times', () => {
    for (const [name, block] of APPEARANCES) {
      const surface = paint('--bg-surface', block, PAPER);
      const mark = paint('--accent', block, surface);
      expect({ name, ok: contrastRatio(mark, surface) >= WCAG_AA_NON_TEXT_MIN }).toEqual({
        name,
        ok: true,
      });
    }
  });

  it('states the danger frame’s limit rather than claiming it is a signal', () => {
    // The frame is `--danger` at full strength and it does *not* clear 3:1 everywhere: 2.46:1
    // in Nord, 2.81 in Solarized. That is allowed only because the frame is emphasis and never
    // the only channel — the heading chip below carries the meaning in words and in a pair
    // that does clear AA, and the one control inside is a destructive button.
    expect(declaration('.repo-set-danger', 'box-shadow')).toContain('var(--danger)');

    const failing = APPEARANCES.filter(([, block]) => {
      const surface = paint('--bg-surface', block, PAPER);
      return contrastRatio(paint('--danger', block, surface), surface) < WCAG_AA_NON_TEXT_MIN;
    }).map(([name]) => name);

    // Pinned, so a theme that *starts* failing is a change someone has to look at.
    expect(failing.sort()).toEqual(['nord', 'solarized']);

    // The channel that does carry it, measured in all nine.
    for (const [name, block] of APPEARANCES) {
      const surface = paint('--bg-surface', block, PAPER);
      const chip = paint('--danger-soft', block, surface);
      const ink = paint('--danger-fg', block, chip);
      expect({ name, ok: contrastRatio(ink, chip) >= WCAG_AA_NORMAL_TEXT_MIN }).toEqual({
        name,
        ok: true,
      });
    }
  });

  it('washes a diverged row rather than tinting it flat, so it resolves on any ground', () => {
    // A flat `--violet` at 6 % assumes a light canvas and inverts into a bruise on the four
    // dark appearances; a `color-mix` resolves against whatever surface it lands on.
    expect(
      declaration(".repo-specs-table tbody tr[data-status='diverged'] td", 'background')
    ).toMatch(/^color-mix\(in srgb, var\(--violet\)/);
  });

  it('marks a composed diagram node with a hairline, not only with a hue', () => {
    expect(declaration(".repo-flow-node[data-composed='true']", 'box-shadow')).toContain(
      'var(--violet)'
    );
  });
});

describe('focus is visible on every choice', () => {
  it('raises the ring on the card the reader is aiming at, from the control they focused', () => {
    for (const prelude of [
      '.repo-det-link:focus-visible',
      '.repo-files-table__link:focus-visible',
      '.repo-file-sort:focus-visible',
      ".repo-map-choice:has(> input[type='radio']:focus-visible)",
      '.repo-set-policy:has(input:focus-visible)',
    ]) {
      expect({ prelude, ring: declaration(prelude, 'outline') }).toEqual({
        prelude,
        ring: '2px solid var(--focus-ring)',
      });
    }
  });

  it('scopes the wizard card’s ring to its own radio, not to a nested field', () => {
    // `> input` rather than a descendant selector: tabbing into the project select must not
    // light the whole card up, or the ring stops meaning "this is what you are choosing".
    expect(
      REPOSITORY_DETAIL_PRELUDES.includes(
        ".repo-map-choice:has(> input[type='radio']:focus-visible)"
      )
    ).toBe(true);
  });
});

describe('the stub treatment', () => {
  it('dims an unwired fieldset rather than hiding it', () => {
    expect(declaration('.repo-set-stub', 'opacity')).toBe('0.6');
  });

  it('leaves the diff placeholder untinted — three coloured tiles would claim a measurement', () => {
    expect(declaration('.repo-map-tile', 'background')).toBe('var(--bg-inset)');
    expect(declaration('.repo-map-tile__value', 'color')).toBe('var(--fg-faint)');
  });

  it('dims the file table while a read is in flight rather than replacing its rows', () => {
    expect(declaration(".repo-files-table[data-loading='true']", 'opacity')).toBe('0.6');
  });
});
