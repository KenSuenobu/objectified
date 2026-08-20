/**
 * The stylesheet half of the Sunset timeline redesign (HIVE-8.2, #5328).
 *
 * `sunset-timeline-hive-redesign.test.tsx` renders the screen and pins its markup; it cannot
 * pin anything that makes it *look* right, because jsdom compiles no stylesheet. So this
 * suite reads `globals.css` the way `published-css.test.ts` and `repositories-css.test.ts`
 * do, and pins what the components lean on:
 *
 *   1. **The skin is tokens only.** What this replaces named colour outright — a
 *      `bg-amber-100 text-amber-900 dark:bg-amber-900/40` imminent badge, a `bg-rose-100
 *      text-rose-900` past badge, a `bg-slate-100 dark:bg-slate-800` scheduled one, a
 *      `text-amber-500` title icon, a `text-indigo-600 dark:text-indigo-400` migration-guide
 *      link and nine `text-slate-*` cells. Every one froze the surface on one light palette
 *      and one dark one.
 *   2. **The drawing and the table agree about a status by construction** — the diamond, the
 *      connector, the chip and the legend swatch for a status all name the same role token,
 *      and it is the token the shared vocabulary resolves that status to.
 *   3. **Nothing is frozen in pixels** but the hairlines and the mark strokes.
 *   4. **The block sits after the unlayered base type rules** it has to outrank.
 *   5. **Quiet text is `--fg-muted`**, not `--fg-subtle`, measured in all nine appearances.
 *   6. **No `-fg` tone ink is painted as words on a plain surface** — `--warn-fg` measures
 *      1.59:1 there in Nord (HIVE-8.1's finding) — and the two inks this block does spend on
 *      a tinted ground are measured against that ground in all nine.
 *   7. **The drawing steps aside below 900 px**, which is an acceptance criterion, and it
 *      leaves the accessibility tree with the pixels.
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
import { SUNSET_STATUSES } from '../src/app/components/ade/sunset/sunsetModel';
import { statusTone } from '../src/app/components/ui/statusVocabulary';

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

/** WCAG 1.4.11 for a non-text mark — a diamond, a rule, a swatch. */
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
const SUNSET_PRELUDES = [
  '.stl-card__header',
  '.stl-card__title',
  '.stl-card__title > svg',
  '.stl-card__note',
  '.stl-card__body',
  '.stl-card__footer',
  '.stl-card__hint',
  '.stl-legend',
  '.stl-legend__item',
  '.stl-legend__item--quiet',
  '.stl-legend__swatch',
  ".stl-legend__swatch[data-status='past']",
  ".stl-legend__swatch[data-status='imminent']",
  ".stl-legend__swatch[data-status='scheduled']",
  '.stl-plot',
  '.stl-svg',
  '.stl-months text',
  '.stl-grid line',
  '.stl-today line',
  '.stl-today rect',
  '.stl-today text',
  '.stl-lane__name',
  '.stl-lane__rule',
  '.stl-connector',
  ".stl-connector[data-status='imminent']",
  ".stl-connector[data-status='scheduled']",
  ".stl-connector[data-status='past']",
  ".stl-chip[data-status='past']",
  ".stl-chip[data-status='imminent']",
  ".stl-chip[data-status='scheduled']",
  '.stl-chip__label',
  ".stl-chip__label[data-status='past']",
  ".stl-chip__label[data-status='imminent']",
  ".stl-chip__label[data-status='scheduled']",
  '.stl-marker__date',
  '.stl-marker',
  '.stl-marker__hit',
  '.stl-marker__ring',
  '.stl-marker:focus-visible .stl-marker__ring, .stl-marker[data-current] .stl-marker__ring',
  '.stl-marker__glyph',
  '.stl-marker:hover .stl-marker__glyph, .stl-marker:focus-visible .stl-marker__glyph',
  ".stl-marker[data-status='past'] .stl-marker__glyph",
  ".stl-marker[data-status='imminent'] .stl-marker__glyph",
  ".stl-marker[data-status='scheduled'] .stl-marker__glyph",
  '.stl-col-version',
  '.stl-col-sunset',
  '.stl-col-lifecycle',
  '.stl-col-successor',
  '.stl-col-notes',
  '.stl-table td',
  '.stl-table-host',
  '.stl-project',
  '.stl-project__name',
  '.stl-project__icon',
  '.stl-version',
  '.stl-instant',
  '.stl-lifecycle',
  '.stl-successor',
  '.stl-absent',
  '.stl-note',
  '.stl-note__text',
  '.stl-note__link',
  '.stl-note__link > svg',
  '.stl-row--current > td',
  '.stl-row--current > td:first-child',
  '.stl-foot__hint',
  '.stl-filter',
] as const;

/**
 * Look one of this ticket's rules up.
 *
 * @param prelude The rule's selector, exactly as {@link SUNSET_PRELUDES} lists it.
 * @returns The rule.
 */
function stlRule(prelude: string): CssRule {
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
  const value = parseDeclarations(stlRule(prelude).body).get(property);
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
 * there is deliberately no *second* banner inside it either, for the reason
 * `published-css.test.ts` and `repositories-css.test.ts` both record: a nested `/* =` would
 * silently cut this slice short and turn every assertion below into a claim about half the
 * block.
 */
const SECTION = (() => {
  const start = css.indexOf('SUNSET TIMELINE  (HIVE-8.2, #5328)');
  if (start < 0) throw new Error('globals.css has no sunset-timeline section');
  const bannerStart = css.lastIndexOf('/* =', start);
  const next = css.indexOf('/* =', start + 1);
  return css.slice(bannerStart < 0 ? start : bannerStart, next < 0 ? css.length : next);
})();

/** The same block with its comments removed. */
const SECTION_CODE = SECTION.replace(/\/\*[\s\S]*?\*\//g, '');

/* -------------------------------------------------------------------------
   1. The section exists, and names no colour
   ------------------------------------------------------------------------- */

describe('the sunset-timeline section of globals.css', () => {
  it('declares every rule the components reference', () => {
    const missing = SUNSET_PRELUDES.filter(
      (prelude) => !rules.some((rule) => rule.prelude === prelude)
    );
    expect(missing).toEqual([]);
  });

  it('is the whole block — no nested banner truncates the slice', () => {
    expect(SECTION).toContain('.stl-card__header');
    expect(SECTION).toContain('.stl-filter');
  });

  it('sits after the unlayered p and h1–h4 base rules it has to outrank', () => {
    // `.stl-note__text` is a `p`, and the quiet lines land on text the base rules also
    // colour, so a rule declared before them would lose whatever its specificity.
    for (const prelude of SUNSET_PRELUDES) {
      expect(stlRule(prelude).line).toBeGreaterThan(BASE_TYPE_RULE_LINE);
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
    const colourish = [
      ...SECTION_CODE.matchAll(/\b(?:color|background|fill|stroke)\s*:\s*([^;]+);/g),
    ].map((match) => match[1].trim());
    expect(colourish.length).toBeGreaterThan(20);
    for (const value of colourish) {
      expect({
        value,
        ok: /^(var\(--|currentColor|transparent|inherit|none)/.test(value),
      }).toEqual({ value, ok: true });
    }
  });

  it('names the mockup and the ticket, so the next reader can find the authority', () => {
    expect(SECTION).toContain('docs/mockups/ship/sunset-timeline.html');
    expect(SECTION).toContain('#5328');
  });
});

/* -------------------------------------------------------------------------
   2. One status, one token — the drawing and the table cannot disagree
   ------------------------------------------------------------------------- */

/** The saturated role token each status is drawn from. */
const STATUS_TOKEN: Readonly<Record<string, string>> = {
  past: '--rose',
  imminent: '--warn',
  scheduled: '--neutral',
};

describe('a status is one colour in both halves of the screen', () => {
  it('spells the same token on the swatch, the diamond and the connector', () => {
    for (const status of SUNSET_STATUSES) {
      const token = `var(${STATUS_TOKEN[status]})`;
      expect({
        status,
        swatch: declaration(`.stl-legend__swatch[data-status='${status}']`, 'background'),
        glyph: declaration(`.stl-marker[data-status='${status}'] .stl-marker__glyph`, 'fill'),
        connector: declaration(`.stl-connector[data-status='${status}']`, 'stroke'),
      }).toEqual({ status, swatch: token, glyph: token, connector: token });
    }
  });

  it('grounds a countdown chip on that token’s own soft step', () => {
    for (const status of SUNSET_STATUSES) {
      expect(declaration(`.stl-chip[data-status='${status}']`, 'fill')).toBe(
        `var(${STATUS_TOKEN[status]}-soft)`
      );
    }
  });

  it('uses the token the shared vocabulary resolves that status to — so the badge agrees', () => {
    // `ui/statusVocabulary` decides the *badge*'s colour from the same status string; if the
    // two ever named different roles, a diamond and its row would be different colours.
    for (const status of SUNSET_STATUSES) {
      expect({ status, tone: statusTone(status) }).toEqual({
        status,
        tone: STATUS_TOKEN[status].replace('--', ''),
      });
    }
  });

  it('inks a chip’s label with that token’s own -fg step, never with the page foreground', () => {
    // The three `-soft` grounds are *fixed light* tints in every appearance — which is what
    // makes a `Badge` a light pill on a dark surface — so `--fg` on one of them measures
    // 1.03:1 in Nord. The `-soft`/`-fg` pair is the calibrated one.
    expect(parseDeclarations(stlRule('.stl-chip__label').body).has('fill')).toBe(false);
    for (const status of SUNSET_STATUSES) {
      expect(declaration(`.stl-chip__label[data-status='${status}']`, 'fill')).toBe(
        `var(${STATUS_TOKEN[status]}-fg)`
      );
    }
  });

  it.each(APPEARANCES)(
    'keeps a chip’s label legible on its own tint in the %s appearance',
    (_id, block) => {
      const surface = paint('--bg-surface', block, PAPER);
      for (const token of Object.values(STATUS_TOKEN)) {
        const tint = compositeOver(
          resolveThemeToken(`${token}-soft`, tokens, block as never),
          surface
        );
        const ink = compositeOver(resolveThemeToken(`${token}-fg`, tokens, block as never), tint);
        expect({ token, ok: contrastRatio(ink, tint) >= WCAG_AA_NORMAL_TEXT_MIN }).toEqual({
          token,
          ok: true,
        });
      }
    }
  );
});

/* -------------------------------------------------------------------------
   2b. The measurement that shaped the drawing
   ------------------------------------------------------------------------- */

describe('the diamonds are shapes before they are colours', () => {
  /** The saturated role token each status is drawn from. */
  const TOKENS = ['--rose', '--warn', '--neutral'] as const;

  it('records that the saturated role step is *not* a legible mark on this surface', () => {
    // This is the finding that put a hairline round every diamond. Stated as a measurement
    // rather than as a comment, so a future change to the token layer that fixes it shows up
    // here as a failing test rather than as a stale note.
    const failures: string[] = [];
    for (const [id, block] of APPEARANCES) {
      const surface = paint('--bg-surface', block, PAPER);
      for (const token of TOKENS) {
        const mark = compositeOver(resolveThemeToken(token, tokens, block as never), surface);
        if (contrastRatio(mark, surface) < WCAG_AA_NON_TEXT_MIN) failures.push(`${id}${token}`);
      }
    }
    expect(failures.length).toBeGreaterThan(0);
  });

  it('draws the contour in --fg-muted, which is legible in every appearance', () => {
    expect(declaration('.stl-marker__glyph', 'stroke')).toBe('var(--fg-muted)');
    expect(declaration('.stl-legend__swatch', 'box-shadow')).toBe('inset 0 0 0 1px var(--fg-muted)');
  });

  it.each(APPEARANCES)(
    'clears the non-text floor with that contour in the %s appearance',
    (_id, block) => {
      const surface = paint('--bg-surface', block, PAPER);
      const contour = compositeOver(
        resolveThemeToken('--fg-muted', tokens, block as never),
        surface
      );
      expect(contrastRatio(contour, surface)).toBeGreaterThanOrEqual(WCAG_AA_NON_TEXT_MIN);
    }
  );

  it('keeps the contour a hairline, so it never becomes the mark itself', () => {
    expect(declaration('.stl-marker__glyph', 'stroke-width')).toBe('1');
    expect(declaration('.stl-marker__glyph', 'vector-effect')).toBe('non-scaling-stroke');
  });
});

/* -------------------------------------------------------------------------
   3. Nothing is frozen in pixels
   ------------------------------------------------------------------------- */

describe('type-relative sizing', () => {
  it('states every length in rem, a token or a percentage — never in px', () => {
    // The exceptions are the hairlines and the two mark strokes: a 1px rule is a hairline by
    // definition, and a 1.5–3px stroke is the *width of a mark inside a viewBox*, which does
    // not scale with text (DESIGN.md §3.2's canvas-geometry exemption).
    const lengths = [...SECTION_CODE.matchAll(/(\d+(?:\.\d+)?)px/g)].map((match) =>
      Number(match[1])
    );
    expect(lengths.length).toBeGreaterThan(0);
    for (const px of lengths) {
      expect({ px, hairline: px <= 1 }).toEqual({ px, hairline: true });
    }
  });

  it('sizes the mockup’s frozen plot width in rem, so it follows all six font scales', () => {
    // The mockup's `.tlx svg { min-width: 900px }`.
    expect(declaration('.stl-svg', 'min-inline-size')).toBe('56.25rem');
  });

  it('sizes the table’s column hints and the filter in rem', () => {
    expect(declaration('.stl-col-sunset', 'inline-size')).toBe('13rem');
    expect(declaration('.stl-col-notes', 'min-inline-size')).toBe('16.25rem');
    expect(declaration('.stl-filter', 'inline-size')).toBe('13.75rem');
  });

  it('sizes the cell padding and the card gaps from the space scale', () => {
    expect(declaration('.stl-table td', 'padding-block')).toBe('calc(var(--space-2) + 0.125rem)');
    expect(declaration('.stl-card__header', 'gap')).toBe('var(--space-3)');
    expect(declaration('.stl-note', 'gap')).toBe('var(--space-1)');
  });

  it('sizes every glyph from the type around it', () => {
    expect(declaration('.stl-card__title > svg', 'inline-size')).toBe('var(--icon-rail)');
    expect(declaration('.stl-project__icon', 'inline-size')).toBe('var(--icon-dense)');
    expect(declaration('.stl-legend__swatch', 'inline-size')).toBe('0.625rem');
  });

  it('takes the type steps from the scale rather than naming a size', () => {
    for (const [prelude, token] of [
      ['.stl-card__note', 'var(--fs-xs)'],
      ['.stl-card__footer', 'var(--fs-xs)'],
      ['.stl-legend', 'var(--fs-xs)'],
      ['.stl-instant', 'var(--fs-xs)'],
      ['.stl-note__text', 'var(--fs-xs)'],
      ['.stl-successor', 'var(--fs-2xs)'],
    ] as const) {
      expect({ prelude, size: declaration(prelude, 'font-size') }).toEqual({ prelude, size: token });
    }
  });

  it('leaves the text *inside* the viewBox to the svgTypography exemption', () => {
    // No `font-size` at all on the SVG text rules: their size is an attribute in user units,
    // set from `ui/svgTypography`, because a label inside a `viewBox` is canvas geometry.
    for (const prelude of ['.stl-months text', '.stl-today text', '.stl-lane__name', '.stl-chip__label']) {
      expect(parseDeclarations(stlRule(prelude).body).has('font-size')).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------
   4. Layout that cannot scroll the document sideways
   ------------------------------------------------------------------------- */

describe('layout that cannot scroll the document sideways', () => {
  it('scrolls a wide drawing inside its own card', () => {
    expect(declaration('.stl-plot', 'overflow-x')).toBe('auto');
    expect(declaration('.stl-plot', 'inline-size')).toBe('100%');
  });

  it('lets the focus ring paint outside the viewBox rather than clipping it in half', () => {
    expect(declaration('.stl-svg', 'overflow')).toBe('visible');
  });

  it('lets the cells shrink — the ellipsis chain needs every ancestor at zero', () => {
    expect(declaration('.stl-table-host', 'min-inline-size')).toBe('0');
    expect(declaration('.stl-project', 'min-inline-size')).toBe('0');
    expect(declaration('.stl-project__name', 'min-inline-size')).toBe('0');
    expect(declaration('.stl-note', 'min-inline-size')).toBe('0');
  });

  it('clips a long project name rather than letting it hold the column open', () => {
    expect(declaration('.stl-project__name', 'text-overflow')).toBe('ellipsis');
    expect(declaration('.stl-project__name', 'overflow')).toBe('hidden');
  });

  it('breaks a long revision id rather than letting it hold the column open', () => {
    expect(declaration('.stl-successor', 'overflow-wrap')).toBe('anywhere');
  });

  it('keeps the whole stored instant on one line, in the column sized for it', () => {
    expect(declaration('.stl-instant', 'white-space')).toBe('nowrap');
    expect(declaration('.stl-instant', 'font-variant-numeric')).toBe('tabular-nums');
  });
});

/* -------------------------------------------------------------------------
   5. Quiet text is the muted step
   ------------------------------------------------------------------------- */

describe('quiet text clears AA in every appearance', () => {
  const QUIET = [
    ['.stl-card__note', 'color'],
    ['.stl-card__footer', 'color'],
    ['.stl-card__hint', 'color'],
    ['.stl-legend', 'color'],
    ['.stl-instant', 'color'],
    ['.stl-lifecycle', 'color'],
    ['.stl-successor', 'color'],
    ['.stl-absent', 'color'],
    ['.stl-note__text', 'color'],
    ['.stl-foot__hint', 'color'],
    // The SVG's own quiet runs. The mockup inks all three `--fg-subtle`.
    ['.stl-months text', 'fill'],
    ['.stl-lane__name', 'fill'],
    ['.stl-marker__date', 'fill'],
  ] as const;

  it('never reaches for --fg-subtle, which does not clear AA at these sizes', () => {
    for (const [prelude, property] of QUIET) {
      expect({ prelude, ink: declaration(prelude, property) }).toEqual({
        prelude,
        ink: 'var(--fg-muted)',
      });
    }
  });

  it.each(APPEARANCES)('clears 4.5:1 on the surface in the %s appearance', (_id, block) => {
    const surface = paint('--bg-surface', block, PAPER);
    const muted = compositeOver(resolveThemeToken('--fg-muted', tokens, block as never), surface);
    expect(contrastRatio(muted, surface)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
  });

  it('records why the mockup’s --fg-subtle could not carry these labels', () => {
    // The subtle step is a *non-text* step; a month label and a lane name are text. It is
    // under the text floor in most appearances, which is the whole reason for the rule above.
    const under = APPEARANCES.filter(([, block]) => {
      const surface = paint('--bg-surface', block, PAPER);
      const subtle = compositeOver(
        resolveThemeToken('--fg-subtle', tokens, block as never),
        surface
      );
      return contrastRatio(subtle, surface) < WCAG_AA_NORMAL_TEXT_MIN;
    });
    expect(under.length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------
   6. The tone inks this block does spend, measured
   ------------------------------------------------------------------------- */

describe('the tone inks', () => {
  /**
   * The rules allowed to spend a `-fg` tone ink, and the ground each is measured against.
   *
   * The `-fg` steps are calibrated against their own `-soft` grounds, so *on the plain
   * surface* they are unmeasured — `--warn-fg` is 1.59:1 in Nord (HIVE-8.1's finding). Every
   * entry here is either drawn on a `-soft` ground (the chips, the today pill) or measured on
   * the surface in all nine below (`--accent-fg`, the migration-guide link).
   */
  const TONE_INK_ALLOWED: ReadonlySet<string> = new Set([
    ".stl-chip__label[data-status='past']",
    ".stl-chip__label[data-status='imminent']",
    ".stl-chip__label[data-status='scheduled']",
    '.stl-today text',
    '.stl-note__link',
  ]);

  it('never paints a -fg tone ink except on a ground it was calibrated for', () => {
    const TONE_INK = /^--(?:neutral|ok|warn|danger|accent|honey|violet|orange|rose)-fg$/;
    const offenders: string[] = [];
    let spent = 0;
    for (const prelude of SUNSET_PRELUDES) {
      const declarations = parseDeclarations(stlRule(prelude).body);
      for (const property of ['color', 'fill'] as const) {
        const match = /^var\((--[a-z-]+)\)$/.exec(declarations.get(property) ?? '');
        if (!match || !TONE_INK.test(match[1])) continue;
        spent += 1;
        if (!TONE_INK_ALLOWED.has(prelude)) offenders.push(`${prelude} { ${property}: ${match[1]} }`);
      }
    }
    expect(spent).toBe(TONE_INK_ALLOWED.size);
    expect(offenders).toEqual([]);
  });

  it('inks the migration-guide link with --accent-fg, not --accent', () => {
    expect(declaration('.stl-note__link', 'color')).toBe('var(--accent-fg)');
  });

  it.each(APPEARANCES)(
    'keeps the migration-guide link legible on the surface in the %s appearance',
    (_id, block) => {
      const surface = paint('--bg-surface', block, PAPER);
      const ink = compositeOver(resolveThemeToken('--accent-fg', tokens, block as never), surface);
      expect(contrastRatio(ink, surface)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
    }
  );

  it('inks the today chip with the accent pair, not the mockup’s solid fill and literal white', () => {
    expect(declaration('.stl-today rect', 'fill')).toBe('var(--accent-soft)');
    expect(declaration('.stl-today text', 'fill')).toBe('var(--accent-fg)');
    // The rule keeps the mockup's azure: a 1.5-unit line is a non-text mark, measured below.
    expect(declaration('.stl-today line', 'stroke')).toBe('var(--accent)');
  });

  it.each(APPEARANCES)('keeps the today chip readable in the %s appearance', (_id, block) => {
    const surface = paint('--bg-surface', block, PAPER);
    const chip = compositeOver(resolveThemeToken('--accent-soft', tokens, block as never), surface);
    const ink = compositeOver(resolveThemeToken('--accent-fg', tokens, block as never), chip);
    expect(contrastRatio(ink, chip)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
  });

  it('records why the mockup’s solid accent fill could not carry the word', () => {
    // `--fg-on-accent` on `--accent` is the app's solid-fill pair; measured it is 1.95:1 in
    // Blueprint and 2.00:1 in Nord — the same limitation `.cat-facet__count` records.
    const under = APPEARANCES.filter(([, block]) => {
      const surface = paint('--bg-surface', block, PAPER);
      const fill = compositeOver(resolveThemeToken('--accent', tokens, block as never), surface);
      const ink = compositeOver(
        resolveThemeToken('--fg-on-accent', tokens, block as never),
        fill
      );
      return contrastRatio(ink, fill) < WCAG_AA_NORMAL_TEXT_MIN;
    });
    expect(under.length).toBeGreaterThan(0);
  });

  it.each(APPEARANCES)('keeps the today rule visible in the %s appearance', (_id, block) => {
    const surface = paint('--bg-surface', block, PAPER);
    const rule = compositeOver(resolveThemeToken('--accent', tokens, block as never), surface);
    expect(contrastRatio(rule, surface)).toBeGreaterThanOrEqual(WCAG_AA_NON_TEXT_MIN);
  });

  it.each(APPEARANCES)('keeps the selected row’s rule visible in the %s appearance', (_id, block) => {
    // A 2px inset rule is a mark, so the non-text floor applies — but it is measured against
    // the *tinted* row, not the plain surface, which is what it is actually drawn on.
    const surface = paint('--bg-surface', block, PAPER);
    const tint = compositeOver(resolveThemeToken('--accent-soft', tokens, block as never), surface);
    const rule = compositeOver(resolveThemeToken('--accent', tokens, block as never), tint);
    expect(contrastRatio(rule, tint)).toBeGreaterThanOrEqual(WCAG_AA_NON_TEXT_MIN);
  });
});

/* -------------------------------------------------------------------------
   7. What this block overrides, and what it takes away below 900px
   ------------------------------------------------------------------------- */

describe('what this block decides on purpose', () => {
  it('top-aligns the multi-line note cell the table would otherwise centre', () => {
    expect(declaration('.stl-table td', 'vertical-align')).toBe('top');
  });

  it('marks the pointed-at row with a rule as well as a tint', () => {
    // DESIGN.md §6: colour is never the only signal.
    expect(declaration('.stl-row--current > td', 'background')).toBe('var(--accent-soft)');
    expect(declaration('.stl-row--current > td:first-child', 'box-shadow')).toBe(
      'inset 0.125rem 0 0 0 var(--accent)'
    );
  });

  it('gives a marker the cursor and the ring a button has', () => {
    expect(declaration('.stl-marker', 'cursor')).toBe('pointer');
    // `outline` is not reliably painted on an SVG group, so the ring is a `<circle>` — and
    // the group's own outline is cleared so no browser draws a second, clipped one.
    expect(declaration('.stl-marker', 'outline')).toBe('none');
    expect(declaration('.stl-marker__ring', 'stroke')).toBe('var(--focus-ring)');
    expect(
      declaration(
        '.stl-marker:focus-visible .stl-marker__ring, .stl-marker[data-current] .stl-marker__ring',
        'opacity'
      )
    ).toBe('1');
  });

  it('gives a marker a hit target larger than the diamond it draws', () => {
    expect(declaration('.stl-marker__hit', 'fill')).toBe('transparent');
  });

  it('hides the whole drawing below 900px, and takes it out of the tab order with it', () => {
    // The acceptance criterion "degrades to the table alone below 900 px". `display: none`
    // rather than a visual hide, so a keyboard reader does not tab through markers that are
    // not on screen.
    const query = SECTION.match(/@media \(max-width: ([\d.]+rem)\) \{\s*\.stl-card \{\s*display: none;/);
    expect(query?.[1]).toBe('56.25rem');
  });

  it('hides nothing else at that width — the table is what remains', () => {
    const start = SECTION_CODE.indexOf('@media');
    const media = SECTION_CODE.slice(start, SECTION_CODE.indexOf('}\n}', start) + 3);
    expect(media).toContain('.stl-card');
    expect(media).not.toContain('.stl-table');
    expect(media).not.toContain('.stl-col-');
    // And it is the only breakpoint in the block: one rule, one thing it does.
    expect(SECTION_CODE.match(/@media/g)).toHaveLength(1);
  });
});
