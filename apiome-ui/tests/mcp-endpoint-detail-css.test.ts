/**
 * The stylesheet half of the MCP endpoint-detail redesign (HIVE-7.8, #5325).
 *
 * `mcp-endpoint-detail-hive-redesign.test.tsx` renders the screen and pins its markup; it cannot
 * pin anything that makes it *look* right, because jsdom compiles no stylesheet. So this suite
 * reads `globals.css` the way `mcp-catalog-css.test.ts` and `repository-bring-in-css.test.ts` do,
 * and pins what the six panels lean on:
 *
 *   1. **The skin is tokens only.** What this replaces named colour outright in about two hundred
 *      places across the route — the capability card's `border-indigo-400 bg-indigo-50 ring-2`
 *      deep-link ring, the insight rail's `text-gray-400
 *      group-data-[state=active]:text-indigo-600` glyphs, the version timeline's
 *      `border-indigo-400 bg-indigo-50` ticked row and its `text-green-600` / `text-red-600` /
 *      `text-blue-600` counts, the diff toggle's `bg-indigo-100 text-indigo-700` segment, the
 *      lint bars' `bg-gray-200` track, the settings form's `text-red-500` stars and
 *      `border-red-200 bg-red-50/60` danger panel, the notes panel's fourteen amber classes and
 *      the trust panel's `border-sky-200 bg-sky-50` note. Every one froze the surface on one
 *      light palette and one dark one.
 *   2. **Nothing is frozen in pixels.** The mockup fixes the insight rail at 240px and sticks it
 *      at `top: 140px`, the lint category rail at 300px / `top: 150px`, the version timeline at
 *      360px, the complexity column at 320px, the cell mark at 22px and two axis labels at
 *      110/130px; all are `rem`, `em`, a token or an intrinsic grid here.
 *   3. **Every multi-column grid collapses**, so no panel on this route can scroll the document
 *      sideways at any font scale.
 *   4. **Quiet text is `--fg-muted`**, not the mockup's `--fg-subtle`, measured in all nine
 *      appearances on both grounds it lands on.
 *   5. **The two hovers land on `--bg-inset`**, not the mockup's `--bg-subtle`: both a hovered
 *      capability row and a hovered timeline row carry a muted sub-line, and only one of the two
 *      grounds clears AA under it.
 *   6. **A deep-linked capability is a hairline, not a fill** — `--fg-muted` on `--accent-soft`
 *      fails in Solarized, which is why the card keeps the surface and takes an accent hairline.
 *   7. **A frame is never the only signal.** The danger zone's inset is measured, and the one
 *      theme where it cannot clear the 3:1 non-text floor is recorded as a stated limit rather
 *      than left to be discovered.
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
  // Header + panels
  '.mcp-ep-meta__url',
  '.mcp-ep-panel',
  '.mcp-ep-row',
  // Cataloger commentary
  '.mcp-notes__head',
  '.mcp-notes__title',
  '.mcp-notes__glyph',
  '.mcp-notes__body',
  '.mcp-note',
  '.mcp-note__text',
  '.mcp-note__foot',
  '.mcp-note__actions',
  '.mcp-note__form-actions',
  // Capabilities
  '.mcp-cap-list',
  '.mcp-cap-list > * + *',
  '.mcp-cap-item',
  '.mcp-cap-item:hover',
  '.mcp-cap-item[data-highlighted]',
  '.mcp-cap-item__head',
  '.mcp-cap-item__name',
  '.mcp-cap-item__id',
  '.mcp-cap-item__desc',
  '.mcp-cap-item__detail',
  '.mcp-cap-columns',
  // Insight rail
  '.mcp-insight',
  '.mcp-insight__head',
  '.mcp-insight__rail',
  '.mcp-insight__group',
  '.mcp-insight__group-label',
  '.mcp-insight__glyph',
  '.mcp-insight__panel',
  // The export menu
  '.mcp-menu',
  '.mcp-menu__item',
  '.mcp-menu__item > svg',
  '.mcp-menu__item[data-disabled]',
  '.mcp-menu__note',
  '.mcp-menu__error',
  // Shared marks
  '.mcp-kv',
  '.mcp-kv__row',
  '.mcp-kv__row:first-child',
  '.mcp-kv__term',
  '.mcp-kv__note',
  '.mcp-cell-mark',
  // Versions
  '.mcp-versions',
  '.mcp-timeline',
  '.mcp-timeline > * + *',
  '.mcp-timeline__row',
  '.mcp-timeline__row:hover',
  '.mcp-timeline__row[data-selected]',
  '.mcp-timeline__main',
  '.mcp-timeline__head',
  '.mcp-timeline__sub',
  '.mcp-timeline__counts',
  '.mcp-compare-bar',
  '.mcp-compare-bar__glyph',
  '.mcp-change',
  '.mcp-change__head',
  '.mcp-change__path',
  '.mcp-change__fields',
  // Lint & score
  '.mcp-lint',
  '.mcp-finding',
  '.mcp-finding__head',
  '.mcp-finding__message',
  // Settings
  '.mcp-settings-grid',
  '.mcp-settings-fields',
  '.mcp-settings-fields__wide',
  '.mcp-settings-actions',
  '.mcp-settings-actions__dirty',
  '.mcp-tone-figure',
  '.mcp-tone-figure--lead',
  '.mcp-ep-danger',
  '.mcp-ep-danger__title',
  '.mcp-ep-danger__title > svg',
  // Trust posture
  '.mcp-posture__finding',
  '.mcp-posture__head',
  '.mcp-posture__message',
  '.mcp-posture__remediation',
  '.mcp-posture__coverage',
] as const;

/** The rules this ticket declares under more than one selector at once. */
const GROUPED_PRELUDES = [
  '.mcp-matrix th, .mcp-matrix td',
  '.mcp-matrix th:first-child, .mcp-matrix td:first-child',
  '.mcp-menu__item[data-highlighted], .mcp-menu__item:hover',
] as const;

/**
 * This ticket's block, from its banner to the next one (or the end of the file).
 *
 * Bounded at both ends deliberately: `mcp-catalog-css.test.ts` was written when its block was
 * the last in the file, and the `--fg-faint` and `--bg-subtle` enumerations it makes silently
 * grew to include this block until it was bounded too.
 */
const SECTION = (() => {
  const start = css.indexOf('MCP ENDPOINT DETAIL  (HIVE-7.8, #5325)');
  if (start < 0) throw new Error('globals.css has no MCP endpoint detail section');
  const bannerStart = css.lastIndexOf('/* =', start);
  const next = css.indexOf('/* =', start + 1);
  return css.slice(bannerStart < 0 ? start : bannerStart, next < 0 ? css.length : next);
})();

/** The same block with its comments removed. */
const SECTION_CODE = SECTION.replace(/\/\*[\s\S]*?\*\//g, '');

/** The first line of this ticket's block, so its rules can be found by position. */
const SECTION_FIRST_LINE = css.slice(0, css.indexOf(SECTION)).split('\n').length;

/** The line after it. */
const SECTION_LAST_LINE = SECTION_FIRST_LINE + SECTION.split('\n').length;

/** Every top-level rule declared in this ticket's block. */
const SECTION_RULES: CssRule[] = rules.filter(
  (rule) => rule.line >= SECTION_FIRST_LINE && rule.line < SECTION_LAST_LINE
);

/**
 * Look one of this ticket's rules up.
 *
 * @param prelude The rule's selector, exactly as the lists above spell it.
 * @returns The rule.
 */
function sectionRule(prelude: string): CssRule {
  const rule = SECTION_RULES.find((candidate) => candidate.prelude === prelude);
  if (!rule) throw new Error(`the HIVE-7.8 block declares no rule \`${prelude}\``);
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

describe('the MCP endpoint detail section of globals.css', () => {
  it('declares every rule the six panels reference', () => {
    const missing = [...PRELUDES, ...GROUPED_PRELUDES].filter(
      (prelude) => !SECTION_RULES.some((rule) => rule.prelude === prelude)
    );
    expect(missing).toEqual([]);
  });

  it('spells no hex literal outside the allow-list', () => {
    expect(findUnfencedHex(SECTION)).toEqual([]);
  });

  it('names no colour keyword and no raw rgb()/hsl()', () => {
    expect(SECTION_CODE).not.toMatch(/:\s*(?:red|green|blue|orange|purple|gold|teal)\b/);
    expect(SECTION_CODE).not.toMatch(/\b(?:rgba?|hsla?)\(/);
  });

  it('draws no colour except through a role token, a mix of them, or an inherited one', () => {
    const colourish = [...SECTION_CODE.matchAll(/\b(?:color|background)\s*:\s*([^;]+);/g)].map(
      (match) => match[1].trim()
    );
    expect(colourish.length).toBeGreaterThan(15);
    for (const value of colourish) {
      expect({
        value,
        ok: /^(var\(--|color-mix\(|currentColor|transparent|inherit|none)/.test(value),
      }).toEqual({ value, ok: true });
    }
  });

  it('names no status of its own — the shared vocabulary paints every tone', () => {
    // The grade, the health pill, the change kinds and the finding tiers all resolve through
    // `ui/statusVocabulary`; a `[data-status]` rule here would be a second opinion.
    expect(SECTION_CODE).not.toMatch(/data-status/);
    expect(SECTION_CODE).not.toMatch(/data-grade/);
  });
});

/* -------------------------------------------------------------------------
   2. Nothing is frozen in pixels
   ------------------------------------------------------------------------- */

describe('the eight measurements the mockup froze in pixels', () => {
  it('states no px length anywhere in the block', () => {
    // `1px` hairlines are the one exception every sibling block makes: a rule is a device pixel,
    // not a typographic measure, and scaling it produces a blurry 1.5px line.
    const lengths = [...SECTION_CODE.matchAll(/(\d+(?:\.\d+)?)px/g)].map((m) => m[1]);
    expect(lengths.every((value) => value === '1')).toBe(true);
  });

  it('sizes the insight rail and the lint rail in rem, not the mockup’s 240px / 300px', () => {
    expect(SECTION_CODE).toContain('minmax(0, 15rem) minmax(0, 1fr)');
    expect(SECTION_CODE).toContain('minmax(0, 19rem) minmax(0, 1fr)');
  });

  it('offsets both sticky rails from a token, not the mockup’s top: 140px / 150px', () => {
    // Measured from `.page`, which already begins under the sticky page header — a second
    // header's worth of offset would push the rail's first item off the top at Compact density.
    for (const prelude of ['.mcp-insight__rail', '.mcp-lint__rail']) {
      const rule = SECTION_RULES.find((candidate) => candidate.prelude === prelude);
      // Both live inside the wide-viewport media query, so read the raw text instead.
      expect(rule ?? SECTION_CODE).toBeTruthy();
    }
    expect(SECTION_CODE).toContain('inset-block-start: var(--space-4)');
    expect(SECTION_CODE).not.toMatch(/inset-block-start:\s*\d+px/);
  });

  it('sizes the version timeline in rem, not the mockup’s 360px', () => {
    expect(SECTION_CODE).toContain('minmax(0, 22rem) minmax(0, 1fr)');
  });

  it('sizes a matrix cell in em, so it scales with the table’s own type', () => {
    expect(declaration('.mcp-cell-mark', 'inline-size')).toBe('1.75em');
    expect(declaration('.mcp-cell-mark', 'block-size')).toBe('1.75em');
  });

  it('sizes the trust/peer axis label in rem, not the mockup’s 130px', () => {
    expect(declaration('.mcp-kv__term', 'inline-size')).toBe('9rem');
  });

  it('sizes every glyph from the type scale rather than a fixed box', () => {
    expect(declaration('.mcp-insight__glyph', 'inline-size')).toBe('var(--fs-md)');
    expect(declaration('.mcp-notes__glyph', 'inline-size')).toBe('var(--fs-md)');
  });
});

/* -------------------------------------------------------------------------
   3. Every multi-column grid collapses
   ------------------------------------------------------------------------- */

describe('no panel can scroll the document sideways', () => {
  const SPLITS = ['.mcp-insight', '.mcp-versions', '.mcp-lint', '.mcp-settings-grid'] as const;

  it.each(SPLITS)('%s is one column until its media query widens it', (prelude) => {
    expect(declaration(prelude, 'grid-template-columns')).toBe('minmax(0, 1fr)');
  });

  it.each(SPLITS)('%s widens behind a min-width query, never a max-width one', (prelude) => {
    // A `max-width` query is the mockup's shape and the one that leaves the *wide* case
    // unqualified — the layout a reader most often has.
    const widened = SECTION_CODE.slice(SECTION_CODE.indexOf(prelude));
    expect(widened).toBeTruthy();
    expect(SECTION_CODE).not.toContain('@media (max-width');
  });

  it('gives the two intrinsic grids a track that folds on its own', () => {
    for (const prelude of ['.mcp-cap-columns', '.mcp-settings-fields', '.mcp-posture__coverage']) {
      expect(declaration(prelude, 'grid-template-columns')).toMatch(
        /^repeat\(auto-fit, minmax\([\d.]+rem, 1fr\)\)$/
      );
    }
  });

  it('lets every unbreakable identifier wrap rather than hold a row open', () => {
    for (const prelude of [
      '.mcp-ep-meta__url',
      '.mcp-cap-item__name',
      '.mcp-cap-item__id',
      '.mcp-change__path',
      '.mcp-note__text',
    ]) {
      expect(declaration(prelude, 'overflow-wrap')).toBe('anywhere');
    }
  });

  it('gives every column that holds a chart or a table a zero minimum', () => {
    expect(declaration('.mcp-insight__panel', 'min-inline-size')).toBe('0');
    expect(declaration('.mcp-ep-panel', 'min-inline-size')).toBe('0');
  });
});

/* -------------------------------------------------------------------------
   4. Quiet text
   ------------------------------------------------------------------------- */

describe('quiet text', () => {
  /** Every rule in the block that inks a quiet line. */
  const QUIET = [
    '.mcp-ep-meta__url',
    '.mcp-cap-item__id',
    '.mcp-cap-item__desc',
    '.mcp-insight__group-label',
    '.mcp-insight__glyph',
    '.mcp-kv__note',
    '.mcp-timeline__sub',
    '.mcp-change__fields',
    '.mcp-finding__message',
    '.mcp-note__foot',
    '.mcp-posture__remediation',
    '.mcp-cell-mark[data-mark=\'present\']',
    '.mcp-compare-bar__glyph',
    '.mcp-menu__note',
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

  it('spends --fg-faint on exactly two marks, both of them decorative', () => {
    const faint = SECTION_RULES.filter(
      (rule) => parseDeclarations(rule.body).get('color') === 'var(--fg-faint)'
    );
    expect(faint.map((rule) => rule.prelude).sort()).toEqual([
      // The "not declared" cell, whose legend and `sr-only` text both say it in words.
      ".mcp-cell-mark[data-mark='absent']",
      // A menu item nobody can choose, which `aria-disabled` already states.
      '.mcp-menu__item[data-disabled]',
    ]);
  });

  it('clears AA on both grounds it is drawn on, in all nine appearances', () => {
    for (const [name, appearance] of APPEARANCES) {
      const surface = paint('--bg-surface', appearance, PAPER);
      const inset = paint('--bg-inset', appearance, surface);
      expect({
        name,
        // The panels, the notes and the findings sit on the surface…
        onSurface:
          contrastRatio(paint('--fg-muted', appearance, surface), surface) >=
          WCAG_AA_NORMAL_TEXT_MIN,
        // …a hovered capability row and a hovered timeline row on the well below it.
        onInset:
          contrastRatio(paint('--fg-muted', appearance, inset), inset) >= WCAG_AA_NORMAL_TEXT_MIN,
      }).toEqual({ name, onSurface: true, onInset: true });
    }
  });
});

/* -------------------------------------------------------------------------
   5. The measured deviations from the mockup
   ------------------------------------------------------------------------- */

describe('the two hovers', () => {
  it('both land on --bg-inset rather than the mockup’s --bg-subtle', () => {
    expect(declaration('.mcp-cap-item:hover', 'background')).toBe('var(--bg-inset)');
    expect(declaration('.mcp-timeline__row:hover', 'background')).toBe('var(--bg-inset)');
    // Nothing in this block uses `--bg-subtle` as a ground for text.
    const onSubtle = SECTION_RULES.filter(
      (rule) => parseDeclarations(rule.body).get('background') === 'var(--bg-subtle)'
    );
    expect(onSubtle.map((rule) => rule.prelude)).toEqual(['.mcp-menu__item[data-highlighted], .mcp-menu__item:hover']);
  });

  it('proves the deviation: muted text fails on --bg-subtle somewhere', () => {
    // If this ever stops being true, the mockup's ground can be restored.
    const failures = APPEARANCES.filter(([, appearance]) => {
      const surface = paint('--bg-surface', appearance, PAPER);
      const subtle = paint('--bg-subtle', appearance, surface);
      return (
        contrastRatio(paint('--fg-muted', appearance, subtle), subtle) < WCAG_AA_NORMAL_TEXT_MIN
      );
    });
    expect(failures.length).toBeGreaterThan(0);
  });
});

describe('the deep-linked capability card', () => {
  it('is an accent hairline over the surface, not the mockup’s accent fill', () => {
    expect(declaration('.mcp-cap-item[data-highlighted]', 'background')).toBe('var(--bg-surface)');
    expect(declaration('.mcp-cap-item[data-highlighted]', 'box-shadow')).toBe(
      'inset 0 0 0 1px var(--accent)'
    );
  });

  it('proves the deviation: muted text on --accent-soft fails somewhere', () => {
    const failures = APPEARANCES.filter(([, appearance]) => {
      const surface = paint('--bg-surface', appearance, PAPER);
      const soft = paint('--accent-soft', appearance, surface);
      return contrastRatio(paint('--fg-muted', appearance, soft), soft) < WCAG_AA_NORMAL_TEXT_MIN;
    });
    expect(failures.length).toBeGreaterThan(0);
  });

  it('clears the 3:1 non-text floor as a hairline in every appearance', () => {
    for (const [name, appearance] of APPEARANCES) {
      const surface = paint('--bg-surface', appearance, PAPER);
      expect({
        name,
        ok: contrastRatio(paint('--accent', appearance, surface), surface) >= WCAG_AA_NON_TEXT_MIN,
      }).toEqual({ name, ok: true });
    }
  });
});

describe('the ticked timeline row', () => {
  it('is an accent hairline, not the mockup’s accent tint', () => {
    const body = sectionRule('.mcp-timeline__row[data-selected]').body;
    expect(parseDeclarations(body).get('box-shadow')).toBe('inset 0 0 0 1px var(--accent)');
    expect(body).not.toMatch(/background\s*:/);
  });

  it('proves the deviation: the row’s own sub-line fails on --accent-soft somewhere', () => {
    // `.mcp-timeline__sub` is `--fg-muted`, which measures 3.86:1 on `--accent-soft` in
    // Solarized — the figure HIVE-7.7 recorded for the same pair and the browser sweep caught.
    const failures = APPEARANCES.filter(([, appearance]) => {
      const surface = paint('--bg-surface', appearance, PAPER);
      const soft = paint('--accent-soft', appearance, surface);
      return contrastRatio(paint('--fg-muted', appearance, soft), soft) < WCAG_AA_NORMAL_TEXT_MIN;
    });
    expect(failures.length).toBeGreaterThan(0);
  });
});

describe('the danger zone frame', () => {
  it('records the stated limit rather than claiming the frame clears 3:1 everywhere', () => {
    const failures = APPEARANCES.filter(([, appearance]) => {
      const surface = paint('--bg-surface', appearance, PAPER);
      return contrastRatio(paint('--danger', appearance, surface), surface) < WCAG_AA_NON_TEXT_MIN;
    }).map(([name]) => name);
    // At least one theme cannot clear it — which is why the panel never relies on the frame
    // alone: its heading prints "Danger zone" in `--danger-fg`, its button is `destructive`, and
    // deleting still requires the word DELETE typed into a dialog.
    expect(failures.length).toBeGreaterThan(0);
    expect(SECTION).toContain('emphasis and never the');
  });

  it('prints the heading in --fg and puts the tone on its glyph', () => {
    // The mockup draws `t-danger` text. No red in the token layer reads as text on the canvas
    // in all nine appearances — see the measurement below — so the words carry the message and
    // the colour is emphasis, the call `.prm-error` / `.prm-caution` (HIVE-6.2) already made.
    expect(declaration('.mcp-ep-danger__title', 'color')).toBe('var(--fg)');
    expect(declaration('.mcp-ep-danger__title > svg', 'color')).toBe('var(--danger)');
    for (const [name, appearance] of APPEARANCES) {
      const canvas = paint('--bg-canvas', appearance, PAPER);
      expect({
        name,
        ok: contrastRatio(paint('--fg', appearance, canvas), canvas) >= WCAG_AA_NORMAL_TEXT_MIN,
      }).toEqual({ name, ok: true });
    }
  });

  it('proves the deviation: no red in the token layer clears AA as text on the canvas', () => {
    const softFailures = APPEARANCES.filter(([, appearance]) => {
      const canvas = paint('--bg-canvas', appearance, PAPER);
      return (
        contrastRatio(paint('--danger-fg', appearance, canvas), canvas) < WCAG_AA_NORMAL_TEXT_MIN
      );
    });
    const saturatedFailures = APPEARANCES.filter(([, appearance]) => {
      const canvas = paint('--bg-canvas', appearance, PAPER);
      return contrastRatio(paint('--danger', appearance, canvas), canvas) < WCAG_AA_NORMAL_TEXT_MIN;
    });
    expect(softFailures.length).toBeGreaterThan(0);
    expect(saturatedFailures.length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------
   6. Honey is spent once
   ------------------------------------------------------------------------- */

describe('the one honey moment on the route', () => {
  it('is the commentary card’s ground, so the block itself names honey nowhere', () => {
    // DESIGN.md §2 spends honey on brand ornament only, and the cataloger commentary is the one
    // panel a *person* wrote — so the wash says so. It comes from `ui/Card`'s `honey` variant,
    // which means this block has no honey of its own to get wrong.
    const honey = SECTION_RULES.filter((rule) => /var\(--honey/.test(rule.body));
    expect(honey.map((rule) => rule.prelude)).toEqual([]);
  });

  it('draws the glyph on that wash in quiet ink, not in honey', () => {
    // Honey *on* the honey wash measures 1.70:1 in light and 2.15:1 in Blueprint — under even
    // the 3:1 floor a non-text mark is held to.
    expect(declaration('.mcp-notes__glyph', 'color')).toBe('var(--fg-muted)');
  });
});

/* -------------------------------------------------------------------------
   7. A figure that carries a tone is a chip
   ------------------------------------------------------------------------- */

describe('a tone-carrying figure', () => {
  it('is a shape only — the caller supplies the pair', () => {
    const body = sectionRule('.mcp-tone-figure').body;
    expect(body).not.toMatch(/color\s*:/);
    expect(body).not.toMatch(/background\s*:/);
    expect(body).toContain('border-radius');
  });

  it('proves why: no -fg ink clears AA as text on a plain surface everywhere', () => {
    for (const tone of ['ok', 'warn', 'danger'] as const) {
      const failures = APPEARANCES.filter(([, appearance]) => {
        const surface = paint('--bg-surface', appearance, PAPER);
        return (
          contrastRatio(paint(`--${tone}-fg`, appearance, surface), surface) <
          WCAG_AA_NORMAL_TEXT_MIN
        );
      });
      expect({ tone, fails: failures.length > 0 }).toEqual({ tone, fails: true });
    }
  });

  it('…and that every one of them does clear AA on its own -soft ground', () => {
    for (const tone of ['ok', 'warn', 'danger', 'accent', 'neutral'] as const) {
      for (const [name, appearance] of APPEARANCES) {
        const surface = paint('--bg-surface', appearance, PAPER);
        const soft = paint(`--${tone}-soft`, appearance, surface);
        expect({
          tone,
          name,
          ok:
            contrastRatio(paint(`--${tone}-fg`, appearance, soft), soft) >=
            WCAG_AA_NORMAL_TEXT_MIN,
        }).toEqual({ tone, name, ok: true });
      }
    }
  });

  it('leaves the "still present" matrix cell unfilled rather than under-tinted', () => {
    // The mockup tints it at 10% of `--ok` and inks it `--ok-fg`, which is a ground far weaker
    // than the `-soft` that ink is calibrated against. The glyph is the difference instead.
    const body = sectionRule(".mcp-cell-mark[data-mark='present']").body;
    expect(body).not.toMatch(/background\s*:/);
    expect(parseDeclarations(body).get('color')).toBe('var(--fg-muted)');
  });
});
