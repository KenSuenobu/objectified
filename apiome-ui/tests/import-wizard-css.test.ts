/**
 * The stylesheet half of the import-wizard redesign (HIVE-6.4, #5315).
 *
 * `import-wizard-hive-redesign.test.tsx` renders the wizard and pins its markup; it cannot pin
 * anything that makes it *look* right, because jsdom compiles no stylesheet. So this suite reads
 * `globals.css` the way `versions-css.test.ts` and `version-dialogs-css.test.ts` do, and pins
 * what the wizard's fourteen surfaces lean on:
 *
 *   1. **The skin is tokens only.** What this replaced named colour outright in more than three
 *      hundred places: the source picker's `from-indigo-50 to-purple-50` gradient panel, the
 *      four gradient metric tiles on Analyze, the five-entry per-category accent table, the ten
 *      hand-tinted status boxes, and the two class-string helpers in
 *      `lib/import-execution-error-indicators.ts` that chose `bg-red-50 dark:bg-red-950/30` in
 *      TypeScript where no theme could reach it.
 *   2. **Nothing is frozen in pixels.** The mockup fixes the wizard's width, its card height,
 *      the drop zone's padding and the gauge's diameter; all are `rem` or a token here, so the
 *      dialog follows all six font scales.
 *   3. **Every multi-column grid collapses**, so no step can scroll the document sideways at
 *      1280 px — the source grid and the preview tiles are `auto-fit`, which is what lets them
 *      hold seven cards on Projects and five on the Catalog without a per-count media query.
 *   4. **Quiet text is `--fg-muted`**, measured in all nine appearances — not `--fg-subtle` or
 *      `--fg-faint`, neither of which clears AA at these sizes.
 *   5. **No `-fg` ink on the surface and no `--fg` on a `-soft` fill.** Outside the light and
 *      dark themes those pairs are not calibrated for each other, which is why the drop zone's
 *      over state, the log's severities and the AI transcript's own-turn bubble take a
 *      `color-mix` wash rather than a `-soft` fill.
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
 * Every rule the wizard's components reference, in the order the block declares them.
 *
 * Stated rather than derived so a rule added without a test — or renamed on one side only —
 * fails the round-trip below rather than going unmeasured.
 */
const IMPORT_PRELUDES = [
  '.imp-wizard',
  '.imp-wizard__head',
  '.imp-wizard__heading',
  '.imp-wizard__head-actions',
  '.imp-wizard__steps',
  '.imp-wizard__body',
  '.imp-wizard__foot',
  '.imp-wizard__foot-lead, .imp-wizard__foot-trail',
  '.imp-wizard__foot-trail',
  '.imp-heading',
  '.imp-cards',
  '.imp-card',
  '.imp-card:disabled',
  '.imp-card__text',
  '.imp-card__title',
  '.imp-card__desc',
  '.imp-drop',
  '.imp-drop:hover',
  '.imp-drop--over',
  '.imp-drop__glyph',
  '.imp-drop__glyph > svg',
  '.imp-drop__browse',
  '.imp-tiles',
  '.imp-tile',
  '.imp-tile__label',
  '.imp-tile__value',
  '.imp-tile__value > svg',
  '.imp-log',
  '.imp-log__line',
  '.imp-log__line[data-level="error"]',
  '.imp-log__line[data-level="warn"]',
  '.imp-log__line[data-level="skipped"]',
  '.imp-log__level',
  '.imp-log__line[data-level="error"] .imp-log__level',
  '.imp-log__line[data-level="warn"] .imp-log__level',
  '.imp-log__line[data-level="skipped"] .imp-log__level',
  '.imp-log__time',
  '.imp-log__context',
  '.imp-row',
  '.imp-row[data-level="error"]',
  '.imp-row[data-level="warn"]',
  '.imp-row[data-level="skipped"]',
  '.imp-row__note',
  '.imp-stages',
  '.imp-stage',
  '.imp-stage__num',
  '.imp-stage[data-state="done"] .imp-stage__num',
  '.imp-stage[data-state="active"] .imp-stage__num',
  '.imp-stage[data-state="failed"] .imp-stage__num',
  '.imp-select',
  '.imp-select:disabled',
  '.imp-check',
  '.imp-kv',
  '.imp-kv > dt',
  '.imp-kv > dd',
  '.imp-schema-row',
  '.imp-schema-row:hover',
  '.imp-schema-row[data-selected]',
  '.imp-schema-row__meta',
  '.imp-chat',
  '.imp-bubble',
  '.imp-bubble--user',
  '.imp-bubble--ai',
] as const;

/**
 * Look one of this ticket's rules up.
 *
 * @param prelude The rule's selector, exactly as {@link IMPORT_PRELUDES} lists it.
 * @returns The rule.
 */
function importRule(prelude: string): CssRule {
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
  const value = parseDeclarations(importRule(prelude).body).get(property);
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
 * The import-wizard block, from its banner to the start of whatever section follows it.
 *
 * Bounded rather than run to the end of the file: `globals.css` grows one section per redesign
 * ticket, and a slice that ended at EOF would make every assertion below a claim about every
 * *later* section too.
 */
const SECTION = (() => {
  const start = css.indexOf('IMPORT WIZARD  (HIVE-6.4, #5315)');
  if (start < 0) throw new Error('globals.css has no import-wizard section');
  const bannerStart = css.lastIndexOf('/* =', start);
  const next = css.indexOf('/* =', start + 10);
  return css.slice(bannerStart < 0 ? start : bannerStart, next < 0 ? css.length : next);
})();

/** The same block with its comments removed — the banned-word walk must not read prose. */
const SECTION_CODE = SECTION.replace(/\/\*[\s\S]*?\*\//g, '');

/* -------------------------------------------------------------------------
   1. The section exists, and names no colour
   ------------------------------------------------------------------------- */

describe('the import-wizard section of globals.css', () => {
  it('declares every rule the components reference', () => {
    const missing = IMPORT_PRELUDES.filter(
      (prelude) => !rules.some((rule) => rule.prelude === prelude)
    );
    expect(missing).toEqual([]);
  });

  it('declares nothing this list does not know about', () => {
    const declared = rules
      .filter((rule) => rule.line >= importRule('.imp-wizard').line && !rule.prelude.startsWith('@media'))
      .filter((rule) => SECTION.includes(`${rule.prelude} {`))
      .map((rule) => rule.prelude);
    const unknown = declared.filter((prelude) => !IMPORT_PRELUDES.includes(prelude as never));
    expect(unknown).toEqual([]);
  });

  it('sits after the unlayered p and h1–h4 base rules it has to outrank', () => {
    // `.imp-heading` is an `h2`, whose unlayered `clamp()` font-size outranks any utility, and
    // `.imp-card__desc` and `.imp-row__note` are drawn as `p`s — a rule declared before those
    // base rules would lose whatever its specificity.
    for (const prelude of IMPORT_PRELUDES) {
      expect(importRule(prelude).line).toBeGreaterThan(BASE_TYPE_RULE_LINE);
    }
  });

  it('names no colour — every hue resolves through the token layer', () => {
    for (const prelude of IMPORT_PRELUDES) {
      for (const [property, value] of parseDeclarations(importRule(prelude).body)) {
        expect({ prelude, property, value }).toMatchObject({ prelude, property });
        expect(value).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        expect(value.replace(/color-mix\([^)]*\)/g, '')).not.toMatch(
          /\b(?:rgb|rgba|hsl|hsla|oklch)\(/
        );
      }
    }
  });

  it('does not reintroduce the palette classes the wizard named', () => {
    for (const banned of [
      'indigo-',
      'purple-',
      'emerald-',
      'amber-',
      'gray-',
      'slate-',
      'yellow-',
      'orange-',
      'sky-',
      'teal-',
    ]) {
      expect(SECTION_CODE).not.toContain(banned);
    }
  });

  it('leaves the hex fence of the stylesheet intact', () => {
    expect(findUnfencedHex(css).map((entry) => `${entry.line}: ${entry.text}`)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------
   2. Nothing is frozen in pixels
   ------------------------------------------------------------------------- */

describe('the wizard follows the reader’s font scale', () => {
  it('measures every length in rem, a token, or a viewport unit', () => {
    // `px` survives only where it is a hairline: a 1 px rule and the drop zone's 1.5 px dash
    // are strokes, not sizes, and scaling a hairline makes it a border.
    const offenders: string[] = [];
    for (const prelude of IMPORT_PRELUDES) {
      for (const [property, value] of parseDeclarations(importRule(prelude).body)) {
        for (const match of value.matchAll(/(-?[\d.]+)px/g)) {
          if (Math.abs(Number(match[1])) <= 2) continue;
          offenders.push(`${prelude} { ${property}: ${value} }`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('sizes the drop zone’s glyph and the stage badge in rem', () => {
    expect(declaration('.imp-drop__glyph', 'inline-size')).toMatch(/rem$/);
    expect(declaration('.imp-drop__glyph > svg', 'inline-size')).toMatch(/rem$/);
    expect(declaration('.imp-stage__num', 'inline-size')).toMatch(/rem$/);
  });

  it('gives the log and its context a rem cap rather than a pixel one', () => {
    expect(declaration('.imp-log', 'max-block-size')).toMatch(/rem$/);
    expect(declaration('.imp-log__context', 'max-block-size')).toMatch(/rem$/);
  });

  it('states the section heading’s size, because the base `h2` rule outranks a utility', () => {
    expect(declaration('.imp-heading', 'font-size')).toBe('var(--fs-sm)');
    // The document's `h1, h2, h3, h4` rule also sets a tighter tracking, meant for a page
    // title; at 13 px it closes the letters up, so it is reset rather than inherited.
    expect(declaration('.imp-heading', 'letter-spacing')).toBe('normal');
  });

  it('takes the controls’ heights from the density-aware metrics', () => {
    expect(declaration('.imp-select', 'block-size')).toBe('var(--control-h)');
    expect(declaration('.imp-drop__browse', 'block-size')).toBe('var(--control-h-sm)');
    expect(declaration('.imp-schema-row', 'min-block-size')).toBe('var(--control-h)');
    expect(declaration('.imp-check', 'inline-size')).toBe('var(--icon-dense)');
  });
});

/* -------------------------------------------------------------------------
   3. Every grid collapses
   ------------------------------------------------------------------------- */

describe('no step can scroll the document sideways', () => {
  it('lays the source grid out with auto-fit, so it collapses at any card count', () => {
    // The grid is data-driven: seven cards on Projects, five on the Catalog, more when a
    // registry adapter is added. A fixed column count would need one media query per count.
    expect(declaration('.imp-cards', 'grid-template-columns')).toMatch(
      /repeat\(auto-fit,\s*minmax\([\d.]+rem,\s*1fr\)\)/
    );
  });

  it('lays the preview tiles out the same way', () => {
    expect(declaration('.imp-tiles', 'grid-template-columns')).toMatch(
      /repeat\(auto-fit,\s*minmax\([\d.]+rem,\s*1fr\)\)/
    );
  });

  it('lets the wizard’s head, footer and stage rail wrap', () => {
    expect(declaration('.imp-wizard__head-actions', 'flex-wrap')).toBe('wrap');
    expect(declaration('.imp-wizard__foot', 'flex-wrap')).toBe('wrap');
    expect(declaration('.imp-wizard__foot-lead, .imp-wizard__foot-trail', 'flex-wrap')).toBe('wrap');
    expect(declaration('.imp-stages', 'flex-wrap')).toBe('wrap');
  });

  it('scrolls the wizard’s body rather than the page', () => {
    expect(declaration('.imp-wizard', 'overflow')).toBe('hidden');
    expect(declaration('.imp-wizard__body', 'overflow-y')).toBe('auto');
    // Without this the body cannot shrink below its content, and the dialog grows instead.
    expect(declaration('.imp-wizard__body', 'min-block-size')).toBe('0');
  });

  it('wraps a long identifier inside the key/value list instead of widening it', () => {
    expect(declaration('.imp-kv > dd', 'overflow-wrap')).toBe('anywhere');
    expect(declaration('.imp-kv', 'grid-template-columns')).toContain('minmax(0, 1fr)');
  });
});

/* -------------------------------------------------------------------------
   4. Quiet text clears AA in all nine appearances
   ------------------------------------------------------------------------- */

describe('the wizard’s quiet text is readable in every appearance', () => {
  /** Every place this block puts muted ink, and the surface it sits on. */
  const MUTED_ON: ReadonlyArray<{ prelude: string; on: string }> = [
    { prelude: '.imp-card__desc', on: '--bg-surface' },
    { prelude: '.imp-tile__label', on: '--bg-surface' },
    { prelude: '.imp-log__line', on: '--bg-inset' },
    { prelude: '.imp-log__time', on: '--bg-inset' },
    { prelude: '.imp-log__context', on: '--bg-inset' },
    { prelude: '.imp-row__note', on: '--bg-surface' },
    { prelude: '.imp-stage', on: '--bg-surface' },
    { prelude: '.imp-stage__num', on: '--bg-inset' },
    { prelude: '.imp-schema-row__meta', on: '--bg-surface' },
    { prelude: '.imp-kv > dt', on: '--bg-surface' },
  ];

  it.each(MUTED_ON)('$prelude is --fg-muted', ({ prelude }) => {
    expect(declaration(prelude, 'color')).toBe('var(--fg-muted)');
  });

  it.each(APPEARANCES)('clears AA in the %s appearance', (_id, appearance) => {
    for (const { on } of MUTED_ON) {
      const backdrop = paint(on, appearance, paint('--bg-canvas', appearance, PAPER));
      const ink = compositeOver(
        resolveThemeToken('--fg-muted', tokens, appearance as never),
        backdrop
      );
      expect(contrastRatio(ink, backdrop)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
    }
  });
});

/* -------------------------------------------------------------------------
   5. The two uncalibrated pairings are avoided
   ------------------------------------------------------------------------- */

describe('the wizard never pairs a tint with ink the theme did not calibrate for it', () => {
  /** Every rule that both fills and inks. */
  const FILLED = IMPORT_PRELUDES.filter((prelude) => {
    const declarations = parseDeclarations(importRule(prelude).body);
    return declarations.has('background') && declarations.has('color');
  });

  it('puts no `--fg` on a `-soft` fill', () => {
    for (const prelude of FILLED) {
      const declarations = parseDeclarations(importRule(prelude).body);
      const background = declarations.get('background') ?? '';
      const color = declarations.get('color') ?? '';
      if (!/-soft\)/.test(background)) continue;
      expect({ prelude, color }).toMatchObject({ prelude });
      expect(color).not.toMatch(/var\(--fg\)/);
    }
  });

  it('puts no `-fg` ink straight on the surface', () => {
    // `--ink-fg` is deliberately not in this list: it is not a semantic tone but the ink of the
    // primary button, and the token layer calibrates it against `--ink` in all nine themes.
    // The one rule that uses it sets that fill, which the next test pins.
    for (const prelude of IMPORT_PRELUDES) {
      const declarations = parseDeclarations(importRule(prelude).body);
      const background = declarations.get('background');
      const color = declarations.get('color') ?? '';
      if (background && background !== 'var(--bg-surface)') continue;
      expect({ prelude, color }).toMatchObject({ prelude });
      expect(color).not.toMatch(/var\(--(?:ok|warn|danger|accent|honey|violet|neutral)-fg\)/);
    }
  });

  it('draws the browse affordance in the primary button’s own pair', () => {
    // It cannot *be* a `Button` — the whole drop zone is the label that opens the file picker,
    // and a button inside a label is a second thing the pointer can land on. So it borrows the
    // pair rather than inventing one.
    expect(declaration('.imp-drop__browse', 'background')).toBe('var(--ink)');
    expect(declaration('.imp-drop__browse', 'color')).toBe('var(--ink-fg)');
  });

  it('washes the tinted grounds into the surface instead of filling them', () => {
    // The checklist row and the AI bubble hold arbitrary text in `--fg`; a `-soft` fill under
    // it is the pairing that is not calibrated outside light and dark, so each takes a
    // `color-mix` wash of the tone into the ground it sits on.
    for (const prelude of [
      '.imp-row[data-level="error"]',
      '.imp-row[data-level="warn"]',
      '.imp-row[data-level="skipped"]',
      '.imp-drop--over',
      '.imp-schema-row[data-selected]',
      '.imp-bubble--user',
    ]) {
      expect(declaration(prelude, 'background')).toContain('color-mix(');
    }
  });

  it('does not wash a log line at all', () => {
    // Measured, not preferred: the well is already `--bg-inset`, and a tint on top of it moved
    // the ground under the quiet `[LEVEL]`, timestamp and context text far enough that all
    // three fell under AA at 11 px — the warn prefix measured 2.5:1 in the browser.
    for (const level of ['error', 'warn', 'skipped']) {
      expect(
        parseDeclarations(importRule(`.imp-log__line[data-level="${level}"]`).body).has('background')
      ).toBe(false);
    }
  });

  it('gives the done and failed stage badges the calibrated `-soft` / `-fg` pair', () => {
    // The mockup draws white on a solid `--ok`; the system has no "ink on a solid role fill"
    // token, and inventing one would be a colour the nine themes never agreed on.
    expect(declaration('.imp-stage[data-state="done"] .imp-stage__num', 'background')).toBe(
      'var(--ok-soft)'
    );
    expect(declaration('.imp-stage[data-state="done"] .imp-stage__num', 'color')).toBe(
      'var(--ok-fg)'
    );
    expect(declaration('.imp-stage[data-state="failed"] .imp-stage__num', 'background')).toBe(
      'var(--danger-soft)'
    );
    expect(declaration('.imp-stage[data-state="failed"] .imp-stage__num', 'color')).toBe(
      'var(--danger-fg)'
    );
  });

  it('inks the active stage badge in the one pair that always contrasts', () => {
    expect(declaration('.imp-stage[data-state="active"] .imp-stage__num', 'background')).toBe(
      'var(--fg)'
    );
    expect(declaration('.imp-stage[data-state="active"] .imp-stage__num', 'color')).toBe(
      'var(--bg-surface)'
    );
  });
});

/* -------------------------------------------------------------------------
   6. The severities stay distinguishable
   ------------------------------------------------------------------------- */

describe('the log’s four severities are told apart by more than a wash', () => {
  it('gives each level its own [data-level] rule', () => {
    for (const level of ['error', 'warn', 'skipped']) {
      expect(rules.some((rule) => rule.prelude === `.imp-log__line[data-level="${level}"]`)).toBe(
        true
      );
      expect(rules.some((rule) => rule.prelude === `.imp-row[data-level="${level}"]`)).toBe(true);
    }
  });

  it('marks each level with a rule down its leading edge', () => {
    // The bar is what survives a high-contrast theme and a reader who cannot separate two
    // washes; every line reserves the space for it so none of them shifts when it appears.
    expect(declaration('.imp-log__line', 'border-inline-start')).toBe('2px solid transparent');
    expect(
      declaration('.imp-log__line[data-level="error"]', 'border-inline-start-color')
    ).toBe('var(--danger)');
    expect(declaration('.imp-log__line[data-level="warn"]', 'border-inline-start-color')).toBe(
      'var(--warn)'
    );
    expect(
      declaration('.imp-log__line[data-level="skipped"]', 'border-inline-start-color')
    ).toBe('var(--border-strong)');
  });

  it('draws the `[LEVEL]` prefix as a chip in its tone’s calibrated pair', () => {
    for (const [prelude, tone] of [
      ['.imp-log__level', 'accent'],
      ['.imp-log__line[data-level="error"] .imp-log__level', 'danger'],
      ['.imp-log__line[data-level="warn"] .imp-log__level', 'warn'],
      ['.imp-log__line[data-level="skipped"] .imp-log__level', 'neutral'],
    ] as const) {
      expect(declaration(prelude, 'background')).toBe(`var(--${tone}-soft)`);
      expect(declaration(prelude, 'color')).toBe(`var(--${tone}-fg)`);
    }
  });

  it.each(APPEARANCES)('clears AA for every log prefix in the %s appearance', (_id, appearance) => {
    // The measurement the browser caught, held here for all nine so it cannot regress in a
    // theme nobody opened. Tinted text on the bare well was what failed: the saturated hues
    // measured 2.5–3.4:1 at 11 px and the `-fg` steps 1.95–2.7:1 in the dark-based themes.
    const well = paint('--bg-inset', appearance, paint('--bg-surface', appearance, PAPER));
    for (const tone of ['accent', 'danger', 'warn', 'neutral']) {
      const fill = paint(`--${tone}-soft`, appearance, well);
      const ink = compositeOver(
        resolveThemeToken(`--${tone}-fg`, tokens, appearance as never),
        fill
      );
      expect({ tone, ok: contrastRatio(ink, fill) >= WCAG_AA_NORMAL_TEXT_MIN }).toEqual({
        tone,
        ok: true,
      });
    }
  });
});
