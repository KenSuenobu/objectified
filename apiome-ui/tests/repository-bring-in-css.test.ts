/**
 * The stylesheet half of the bring-in surfaces redesign (HIVE-7.6, #5323).
 *
 * `repository-bring-in-hive-redesign.test.tsx` renders the three screens and pins their markup;
 * it cannot pin anything that makes them *look* right, because jsdom compiles no stylesheet. So
 * this suite reads `globals.css` the way `repository-detail-css.test.ts` and
 * `add-repository-css.test.ts` do, and pins what the components lean on:
 *
 *   1. **The skin is tokens only.** What this replaces named colour outright in about 150
 *      places across the three screens — `bg-emerald-100 text-emerald-700
 *      dark:bg-emerald-900/40` status pills, `border-amber-300 dark:border-amber-700` pressure
 *      frames, an `bg-indigo-600 text-white` range switch, `border-red-200 bg-red-50` error
 *      panels and `border-gray-300 bg-white dark:border-gray-600 dark:bg-gray-800` inputs.
 *      Every one froze the surface on one light palette and one dark one.
 *   2. **Nothing is frozen in pixels.** The three mockups fix the search field at 240/340px,
 *      the filter selects at 160–190px, the sparkline at 44px, the bar track at 64px, the CIDR
 *      chip at 22px and three button offsets at 18px; all are `rem`, a token or a grid
 *      alignment here.
 *   3. **Every multi-column grid collapses**, so no row on these three routes can scroll the
 *      document sideways at any font scale.
 *   4. **Quiet text is `--fg-muted`**, not the mockups' `--fg-subtle`, which does not clear AA
 *      at these sizes — measured here in all nine appearances.
 *   5. **A tone ink never sits on the plain surface.** `--warn-fg` and `--danger-fg` measure
 *      1.5–2.6:1 on a card in the six themes that inherit the light semantic pairs, which is
 *      the exposure HIVE-7.2 recorded. Each `-fg` below is paired with its own `-soft` ground,
 *      and both pairs are measured.
 *   6. **A frame is never the only signal.** DESIGN.md §6: the deferral card and the overdue
 *      provider card both carry a word and a glyph beside their tinted frame, and the frame
 *      itself clears the 3:1 non-text floor wherever it can — the one theme where it cannot is
 *      recorded as a stated limit rather than left to be discovered.
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
 * Listed rather than pattern-matched so a rule that is *renamed* fails here instead of silently
 * dropping out of the token-only walk below.
 */
const BRING_IN_PRELUDES = [
  // Discovered specs
  '.spec-filters',
  '.spec-filters__row',
  '.spec-filters__row--flags',
  '.spec-filters__search',
  '.spec-filters__facet',
  '.spec-filters__facet--sort',
  '.spec-filters__facet[data-active]',
  '.spec-filters__flag',
  '.spec-filters__clear',
  '.spec-filters__note',
  '.spec-cell',
  '.spec-path',
  '.spec-path:hover',
  '.spec-path__dir',
  '.spec-path__file',
  '.spec-refs',
  '.spec-link',
  '.spec-link:hover',
  '.spec-branch',
  '.spec-branch > svg',
  '.spec-unmapped',
  '.spec-num',
  '.spec-pager',
  '.spec-vocab',
  '.spec-vocab__row',
  '.spec-vocab__row > dt',
  '.spec-vocab__desc',
  // Quota
  '.quota-panel__head',
  '.quota-panel__title',
  '.quota-panel__title > svg',
  '.quota-panel__copy',
  '.quota-figures',
  '.quota-figure__label',
  '.quota-figure__value',
  '.quota-panel__meter',
  '.quota-panel__share',
  '.quota-metrics',
  '.quota-metric[data-deferral="true"]',
  '.quota-metric__body',
  '.quota-metric__head',
  '.quota-metric__label',
  '.quota-metric__flag',
  '.quota-metric__window',
  '.quota-metric__value',
  '.quota-metric__spark',
  '.quota-metric__foot',
  '.quota-metric__foot > div',
  '.quota-metric__foot dd',
  '.quota-metric__desc',
  '.quota-bars-card__head',
  '.quota-bars-card__title',
  '.quota-bars-card__title > svg',
  '.quota-bars-card__window',
  '.quota-bars',
  '.quota-bars__bar',
  '.quota-bars__bar[data-count="0"]',
  '.quota-bars__axis',
  '.quota-bars__total',
  // Allowlist
  '.wal-posture__body',
  '.wal-posture__text',
  '.wal-posture__title',
  '.wal-posture__desc',
  '.wal-posture__reason',
  '.wal-tile',
  '.wal-tile > svg',
  '.wal-tile[data-tone="ok"]',
  '.wal-tile[data-tone="warn"]',
  '.wal-facts',
  '.wal-fact__label',
  '.wal-fact__value',
  '.wal-providers',
  '.wal-provider[data-overdue="true"]',
  '.wal-provider__body',
  '.wal-provider__head',
  '.wal-provider__name',
  '.wal-provider__name > svg',
  '.wal-provider__refresh[data-overdue="true"]',
  '.wal-provider__error',
  '.wal-provider__chips',
  '.wal-provider__empty',
  '.wal-cidr',
  '.wal-ranges__head',
  '.wal-ranges__title',
  '.wal-ranges__title > svg',
  '.wal-ranges__count',
  '.wal-ranges__desc',
  '.wal-ranges__empty',
  '.wal-add',
  '.wal-add__field',
  '.wal-add__submit',
  '.wal-entries',
  '.wal-entry',
  '.wal-entry + .wal-entry',
  '.wal-entry__meta',
  '.wal-entry__nodesc',
  '.wal-entry__actions',
  '.wal-enforce',
  '.wal-enforce__desc',
  '.wal-enforce__field',
  '.wal-enforce__submit',
  '.wal-enforce__restore',
  '.wal-enforce__changed',
] as const;

/**
 * Look one of this ticket's rules up.
 *
 * @param prelude The rule's selector, exactly as {@link BRING_IN_PRELUDES} lists it.
 * @returns The rule.
 */
function bringInRule(prelude: string): CssRule {
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
  const value = parseDeclarations(bringInRule(prelude).body).get(property);
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
 * reason `repositories-css.test.ts` and `api-keys-css.test.ts` both record: a nested `/* =`
 * would silently cut this slice short and turn every assertion below into a claim about half
 * the block.
 */
const SECTION = (() => {
  const start = css.indexOf('DISCOVERED SPECS · QUOTA · WEBHOOK ALLOWLIST  (HIVE-7.6, #5323)');
  if (start < 0) throw new Error('globals.css has no bring-in surfaces section');
  const bannerStart = css.lastIndexOf('/* =', start);
  const next = css.indexOf('/* =', start + 1);
  return css.slice(bannerStart < 0 ? start : bannerStart, next < 0 ? css.length : next);
})();

/** The same block with its comments removed. */
const SECTION_CODE = SECTION.replace(/\/\*[\s\S]*?\*\//g, '');

/* -------------------------------------------------------------------------
   1. The section exists, and names no colour
   ------------------------------------------------------------------------- */

describe('the bring-in surfaces section of globals.css', () => {
  it('declares every rule the three screens reference', () => {
    const missing = BRING_IN_PRELUDES.filter(
      (prelude) => !rules.some((rule) => rule.prelude === prelude)
    );
    expect(missing).toEqual([]);
  });

  it('is the whole block — no nested banner truncates the slice', () => {
    expect(SECTION).toContain('.spec-filters');
    expect(SECTION).toContain('.wal-enforce__changed');
    expect(SECTION).toContain('@media (max-width: 40rem)');
  });

  it('sits after the unlayered p and h1–h4 base rules it has to outrank', () => {
    // `.wal-posture__title`, `.quota-metric__label` and `.wal-provider__name` are headings and
    // most of the quiet lines are `p`s; both base rules are unlayered, so a rule declared
    // before them would lose whatever its specificity.
    for (const prelude of BRING_IN_PRELUDES) {
      expect(bringInRule(prelude).line).toBeGreaterThan(BASE_TYPE_RULE_LINE);
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

  it('draws no colour except through a role token or currentColor', () => {
    const colourish = [...SECTION_CODE.matchAll(/\b(?:color|background)\s*:\s*([^;]+);/g)].map(
      (match) => match[1].trim()
    );
    expect(colourish.length).toBeGreaterThan(20);
    for (const value of colourish) {
      expect({
        value,
        ok: /^(var\(--|currentColor|transparent|inherit|none|linear-gradient\()/.test(value),
      }).toEqual({ value, ok: true });
    }
  });

  it('names no provider hue of its own — HIVE-7.3’s table paints the provider marks', () => {
    // `.wal-provider` carries `.repo-provider` + `data-provider`, so the tint comes from the
    // repositories block. A second table here is how two screens end up disagreeing.
    expect(SECTION_CODE).not.toMatch(/data-provider/);
  });

  it('names no status of its own — the shared vocabulary paints every pill', () => {
    // The four catalog states, the four pressure levels and the four postures all resolve
    // through `ui/statusVocabulary`; a `[data-status]` rule here would be a second opinion.
    expect(SECTION_CODE).not.toMatch(/data-status/);
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

  it('sizes the mockups’ frozen fields in rem rather than at 240/340/160/190px', () => {
    expect(declaration('.spec-filters__search', 'flex')).toBe('1 1 15rem');
    expect(declaration('.spec-filters__search', 'max-inline-size')).toBe('21rem');
    expect(declaration('.spec-filters__facet', 'inline-size')).toBe('10.5rem');
    expect(declaration('.spec-filters__facet--sort', 'inline-size')).toBe('12rem');
  });

  it('gives every filter select one width, so the row does not read as a mistake', () => {
    // The call HIVE-7.3 recorded for `.repo-filter`: four selects that are almost but not
    // quite the same width look like a bug. The sort menu is the one deliberate exception,
    // because "Sort: Recent activity" is the longest label in the row.
    expect(declaration('.spec-filters__facet', 'block-size')).toBe('var(--control-h-sm)');
    expect(declaration('.spec-filters__facet', 'font-size')).toBe('var(--fs-xs)');
  });

  it('sizes the CIDR chip from its own type rather than at the mockup’s 22px', () => {
    expect(declaration('.wal-cidr', 'min-block-size')).toBe('calc(var(--fs-2xs) * 2)');
    expect(declaration('.wal-cidr', 'font-size')).toBe('var(--fs-2xs)');
  });

  it('sizes the posture tile from its own type, and keeps it square', () => {
    expect(declaration('.wal-tile', 'inline-size')).toBe(
      declaration('.wal-tile', 'block-size')
    );
    expect(declaration('.wal-tile', 'inline-size')).toBe('calc(var(--fs-md) * 2.5)');
  });

  it('sizes every glyph from the type around it', () => {
    for (const [prelude, token] of [
      ['.quota-panel__title > svg', 'var(--fs-md)'],
      ['.quota-metric__flag', 'var(--fs-sm)'],
      ['.quota-bars-card__title > svg', 'var(--fs-sm)'],
      ['.wal-provider__name > svg', 'var(--fs-md)'],
      ['.wal-ranges__title > svg', 'var(--fs-md)'],
      ['.spec-branch > svg', 'var(--fs-2xs)'],
      ['.wal-tile > svg', 'var(--fs-lg)'],
    ] as const) {
      expect({ prelude, size: declaration(prelude, 'inline-size') }).toEqual({
        prelude,
        size: token,
      });
    }
  });

  it('replaces the mockups’ 18px button offsets with a baseline alignment', () => {
    // `margin-top:18px` held a button level with a labelled field at exactly one font scale.
    // `align-items: end` holds it at all six.
    expect(declaration('.wal-add', 'align-items')).toBe('end');
    expect(declaration('.wal-enforce', 'align-items')).toBe('end');
    expect(SECTION_CODE).not.toMatch(/margin-(?:top|block-start)\s*:\s*1\.125rem/);
  });

  it('lets the metrics set own the sparkline’s proportion rather than freezing 44px', () => {
    // `.hive-sparkline` states the 5:1 aspect once, so every trend in the product is the same
    // shape and a reader learns to compare them by eye.
    const spark = parseDeclarations(bringInRule('.quota-metric__spark').body);
    expect(spark.get('inline-size')).toBe('100%');
    expect(spark.has('block-size')).toBe(false);
    expect(spark.has('aspect-ratio')).toBe(false);
  });
});

/* -------------------------------------------------------------------------
   3. Nothing can scroll the document sideways
   ------------------------------------------------------------------------- */

describe('layout that cannot scroll the document sideways', () => {
  it('auto-fits every card grid at a rem minimum rather than a fixed column count', () => {
    for (const [prelude, track] of [
      ['.quota-metrics', 'repeat(auto-fit, minmax(17rem, 1fr))'],
      ['.wal-providers', 'repeat(auto-fit, minmax(17rem, 1fr))'],
      ['.quota-figures', 'repeat(auto-fit, minmax(9rem, 1fr))'],
      ['.wal-facts', 'repeat(auto-fit, minmax(13rem, 1fr))'],
    ] as const) {
      expect({ prelude, track: declaration(prelude, 'grid-template-columns') }).toEqual({
        prelude,
        track,
      });
    }
  });

  it('collapses the card grids to one column on a phone', () => {
    // The block declares one `@media (max-width: 30rem)` per grid, beside the grid it folds,
    // so each is found by its own body rather than by position.
    const phoneBlocks = [
      ...SECTION.matchAll(/@media \(max-width: 30rem\) \{([\s\S]*?)\n\}/g),
    ].map((match) => match[1]);
    expect(phoneBlocks.length).toBeGreaterThanOrEqual(2);
    for (const selector of ['.quota-metrics', '.wal-providers']) {
      const block = phoneBlocks.find((body) => body.includes(`${selector} {`));
      expect({ selector, collapses: block !== undefined }).toEqual({
        selector,
        collapses: true,
      });
      expect(block).toContain('minmax(0, 1fr)');
    }
  });

  it('gives the filter row full-width controls before the document can scroll', () => {
    const media = SECTION.slice(SECTION.indexOf('@media (max-width: 40rem)'));
    expect(media).toContain('.spec-filters__facet');
    expect(media).toContain('.spec-filters__search');
    expect(media).toContain('inline-size: 100%');
  });

  it('folds the entry row so a long reason cannot push its buttons off the edge', () => {
    expect(declaration('.wal-entry', 'grid-template-columns')).toBe(
      'auto minmax(0, 1fr) auto'
    );
    const media = SECTION.slice(SECTION.indexOf('@media (max-width: 40rem)'));
    const at = media.indexOf('.wal-entry {');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(media.slice(at, at + 120)).toContain('minmax(0, 1fr) auto');
    expect(media).toContain('.wal-entry__meta');
  });

  it('lets a 90-character spec path break rather than hold its row open', () => {
    // `overflow-wrap` only works because every ancestor carries `min-inline-size: 0` — the
    // chain the browser suite measures.
    expect(declaration('.spec-path', 'overflow-wrap')).toBe('anywhere');
    expect(declaration('.spec-path', 'min-inline-size')).toBe('0');
    expect(declaration('.spec-cell', 'min-inline-size')).toBe('0');
  });

  it('caps a long prose line at a measure rather than at the card’s width', () => {
    for (const prelude of [
      '.quota-panel__copy',
      '.wal-posture__desc',
      '.wal-ranges__desc',
      '.wal-enforce__desc',
    ]) {
      expect({ prelude, measure: declaration(prelude, 'max-inline-size') }).toEqual({
        prelude,
        measure: '80ch',
      });
    }
  });

  it('scrolls a long provider range list inside its own card', () => {
    expect(declaration('.wal-provider__chips', 'max-block-size')).toBe('11rem');
    expect(declaration('.wal-provider__chips', 'overflow-y')).toBe('auto');
  });
});

/* -------------------------------------------------------------------------
   4. Quiet text clears AA in every appearance
   ------------------------------------------------------------------------- */

describe('quiet text', () => {
  /** Every rule on these screens whose whole job is to be the quieter line. */
  const QUIET = [
    '.spec-filters__flag',
    '.spec-filters__note',
    '.spec-path__dir',
    '.spec-unmapped',
    '.spec-vocab__desc',
    '.quota-panel__copy',
    '.quota-figure__label',
    '.quota-panel__share',
    '.quota-metric__window',
    '.quota-metric__foot',
    '.quota-metric__desc',
    '.quota-bars-card__window',
    '.quota-bars__axis',
    '.wal-posture__desc',
    '.wal-posture__reason',
    '.wal-fact__label',
    '.wal-provider__empty',
    '.wal-cidr',
    '.wal-ranges__count',
    '.wal-ranges__desc',
    '.wal-ranges__empty',
    '.wal-entry__meta',
    '.wal-enforce__desc',
    '.wal-enforce__changed',
  ] as const;

  it('uses --fg-muted, never the --fg-subtle the mockups reach for', () => {
    for (const prelude of QUIET) {
      expect({ prelude, ink: declaration(prelude, 'color') }).toEqual({
        prelude,
        ink: 'var(--fg-muted)',
      });
    }
  });

  it('clears AA on every ground it is drawn on, in all nine appearances', () => {
    for (const [name, appearance] of APPEARANCES) {
      const surface = paint('--bg-surface', appearance, PAPER);
      const inset = paint('--bg-inset', appearance, surface);
      const ink = paint('--fg-muted', appearance, surface);
      const insetInk = paint('--fg-muted', appearance, inset);
      expect({ name, onSurface: contrastRatio(ink, surface) >= WCAG_AA_NORMAL_TEXT_MIN }).toEqual(
        { name, onSurface: true }
      );
      // `.wal-cidr` is muted ink on `--bg-inset`, which is a different pair.
      expect({ name, onInset: contrastRatio(insetInk, inset) >= WCAG_AA_NORMAL_TEXT_MIN }).toEqual(
        { name, onInset: true }
      );
    }
  });
});

/* -------------------------------------------------------------------------
   5. A tone ink never sits on the plain surface
   ------------------------------------------------------------------------- */

describe('tone inks and their grounds', () => {
  it('gives an overdue refresh line and a provider error their own tinted ground', () => {
    expect(declaration('.wal-provider__refresh[data-overdue="true"]', 'background')).toBe(
      'var(--warn-soft)'
    );
    expect(declaration('.wal-provider__refresh[data-overdue="true"]', 'color')).toBe(
      'var(--warn-fg)'
    );
    expect(declaration('.wal-provider__error', 'background')).toBe('var(--danger-soft)');
    expect(declaration('.wal-provider__error', 'color')).toBe('var(--danger-fg)');
  });

  it('gives the posture tile its own tinted ground per tone', () => {
    expect(declaration('.wal-tile[data-tone="ok"]', 'background')).toBe('var(--ok-soft)');
    expect(declaration('.wal-tile[data-tone="ok"]', 'color')).toBe('var(--ok-fg)');
    expect(declaration('.wal-tile[data-tone="warn"]', 'background')).toBe('var(--warn-soft)');
    expect(declaration('.wal-tile[data-tone="warn"]', 'color')).toBe('var(--warn-fg)');
  });

  it('measures each pair on its own ground in all nine appearances', () => {
    for (const [name, appearance] of APPEARANCES) {
      const surface = paint('--bg-surface', appearance, PAPER);
      for (const tone of ['warn', 'danger', 'ok'] as const) {
        const ground = paint(`--${tone}-soft`, appearance, surface);
        const ink = paint(`--${tone}-fg`, appearance, ground);
        expect({
          name,
          tone,
          ok: contrastRatio(ink, ground) >= WCAG_AA_NORMAL_TEXT_MIN,
        }).toEqual({ name, tone, ok: true });
      }
    }
  });

  it('proves the deviation: the same inks would fail on the plain card', () => {
    // The reason every tone ink above is paired with its own `-soft` ground rather than being
    // painted on the card. If this ever stops being true the deviation can be revisited.
    const failures: string[] = [];
    for (const [name, appearance] of APPEARANCES) {
      const surface = paint('--bg-surface', appearance, PAPER);
      for (const tone of ['warn', 'danger'] as const) {
        const bare = paint(`--${tone}-fg`, appearance, surface);
        if (contrastRatio(bare, surface) < WCAG_AA_NORMAL_TEXT_MIN) failures.push(`${name}/${tone}`);
      }
    }
    expect(failures.length).toBeGreaterThan(0);
  });

  it('never inks a tone -fg directly on the card', () => {
    // Every `-fg` in the block is preceded, in its own rule, by the matching `-soft` ground.
    for (const rule of rules.filter((candidate) =>
      SECTION.includes(`${candidate.prelude} {`)
    )) {
      const declarations = parseDeclarations(rule.body);
      const ink = declarations.get('color');
      if (!ink) continue;
      const match = /var\(--(warn|danger|ok)-fg\)/.exec(ink);
      if (!match) continue;
      expect({
        prelude: rule.prelude,
        ground: declarations.get('background'),
      }).toEqual({ prelude: rule.prelude, ground: `var(--${match[1]}-soft)` });
    }
  });
});

/* -------------------------------------------------------------------------
   6. A frame is never the only signal
   ------------------------------------------------------------------------- */

describe('frames that carry emphasis, not meaning', () => {
  it('draws the deferral card and the overdue provider as a hairline inset', () => {
    expect(declaration('.quota-metric[data-deferral="true"]', 'box-shadow')).toBe(
      'inset 0 0 0 1px var(--warn), var(--shadow-sm)'
    );
    expect(declaration('.wal-provider[data-overdue="true"]', 'box-shadow')).toBe(
      'inset 0 0 0 1px var(--warn), var(--shadow-sm)'
    );
  });

  it('paints an empty day from a neutral token rather than from the tone scale', () => {
    // A day with nothing in it is a measurement. Painting it in the accent would report
    // activity; leaving it out entirely would report nothing measured.
    expect(declaration('.quota-bars__bar[data-count="0"]', 'background')).toBe(
      'var(--fg-faint)'
    );
    expect(declaration('.quota-bars__bar', 'background')).toBe('currentColor');
  });

  it('keeps a disabled entry at full contrast rather than fading its text', () => {
    // The mockup dims the row to 60 %. Dimming fades its text with it — the call HIVE-7.3
    // recorded for the zero refresh chip. The `disabled` badge carries the state instead.
    expect(SECTION_CODE).not.toMatch(/\.wal-entry\[data-enabled="false"\]/);
    expect(SECTION_CODE).not.toMatch(/opacity\s*:\s*\.?[0-9]/);
  });

  it('marks an active facet with a hairline as well as a colour', () => {
    expect(declaration('.spec-filters__facet[data-active]', 'box-shadow')).toBe(
      'inset 0 0 0 1px var(--accent)'
    );
  });
});
