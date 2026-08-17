/**
 * The stylesheet half of the shortcuts sheet (HIVE-3.7, #5293).
 *
 * `tests/shortcut-sheet.test.tsx` drives the sheet and pins what it *says*. It cannot pin
 * any of the things that make the sheet readable, because jsdom compiles no stylesheet: the
 * columns that appear and disappear with the reader's font scale, the gated row's ink, and
 * the fact that none of it is a hard-coded colour or a frozen pixel size.
 *
 * So this suite reads `globals.css` the way `command-palette-css.test.ts` and
 * `page-chrome-css.test.ts` do, and pins four things:
 *
 *   1. The columns come from `auto-fit` over one declared measure, so the sheet reflows with
 *      the font-size and density preferences instead of at a breakpoint per stop — and never
 *      forces the dialog wider than the viewport (roadmap §6: no horizontal scroll).
 *   2. A chord never wraps, and a long description does not push the chips off the row.
 *   3. Every ink is a token, and every quiet ink is one that clears WCAG AA on the surface it
 *      is painted on, in every theme.
 *   4. Every class the component draws with has a rule, so a renamed class is a failure here
 *      rather than an unstyled row in production.
 */

import {
  contrastRatio,
  hexToRgb,
  parseDeclarations,
  readGlobalsCss,
  readThemeBlocks,
  readTokenLayer,
  resolveThemeToken,
  topLevelRules,
  type CssRule,
} from './helpers/design-tokens';

const css = readGlobalsCss();
const rules = topLevelRules(css);
const tokens = readTokenLayer(css);

/** WCAG AA for normal-size text — the bar `DESIGN.md` §9 sets for anything meant to be read. */
const WCAG_AA_NORMAL_TEXT_MIN = 4.5;

/**
 * The one top-level rule with this prelude.
 *
 * @param prelude Exact prelude, whitespace-collapsed.
 * @returns The rule.
 * @throws When the stylesheet has none, or more than one.
 */
function ruleFor(prelude: string): CssRule {
  const matches = rules.filter((rule) => rule.prelude === prelude);
  if (matches.length !== 1) {
    throw new Error(`globals.css has ${matches.length} \`${prelude}\` rules; expected exactly 1`);
  }
  return matches[0];
}

/**
 * The declarations of a top-level rule.
 *
 * @param prelude Exact prelude.
 * @returns Property to value.
 */
function declarationsOf(prelude: string): Map<string, string> {
  return parseDeclarations(ruleFor(prelude).body);
}

/** Every `.shortcut-sheet*` rule the stylesheet carries, at the top level. */
const sheetRules = rules.filter((rule) => rule.prelude.includes('.shortcut-sheet'));

describe('the columns', () => {
  it('declares the column measure once, in rem, on the sheet itself', () => {
    const sheet = declarationsOf('.shortcut-sheet');
    const measure = sheet.get('--shortcut-col');

    expect(measure).toBeDefined();
    expect(measure).toMatch(/rem$/);
  });

  it('grows and drops columns from the measure rather than at a breakpoint', () => {
    const grid = declarationsOf('.shortcut-sheet__grid');
    const columns = grid.get('grid-template-columns') ?? '';

    expect(grid.get('display')).toBe('grid');
    expect(columns).toContain('auto-fit');
    expect(columns).toContain('var(--shortcut-col)');
  });

  it('never makes a column wider than the viewport, so the page cannot scroll sideways', () => {
    // `minmax(<measure>, 1fr)` alone forces the track to the measure on a narrow screen and
    // pushes the dialog past the viewport; `min(<measure>, 100%)` is what prevents it.
    const columns = declarationsOf('.shortcut-sheet__grid').get('grid-template-columns') ?? '';
    expect(columns).toContain('min(var(--shortcut-col), 100%)');
  });

  it('spends the spacing scale rather than measuring its own gaps', () => {
    const gap = declarationsOf('.shortcut-sheet__grid').get('gap') ?? '';
    expect(gap.match(/var\(--space-\d+\)/g) ?? []).toHaveLength(2);
  });
});

describe('a row', () => {
  it('keeps the chips beside the first line of a label that has wrapped', () => {
    const row = declarationsOf('.shortcut-sheet__row');
    expect(row.get('display')).toBe('flex');
    expect(row.get('align-items')).toBe('baseline');
    expect(row.get('justify-content')).toBe('space-between');
  });

  it('lets a long description shrink instead of pushing the chord off the row', () => {
    // A flex item can only shrink below its content once its automatic minimum size is
    // lifted — the rule the page header (HIVE-3.5) and the palette (HIVE-3.6) both needed.
    expect(declarationsOf('.shortcut-sheet__label').get('min-width')).toBe('0');
  });

  it('never breaks a chord across two lines', () => {
    const keys = declarationsOf('.shortcut-sheet__keys');
    expect(keys.get('white-space')).toBe('nowrap');
    expect(keys.get('flex-shrink')).toBe('0');
    expect(keys.get('margin-left')).toBe('auto');
  });

  it('states a gated shortcut’s reason under it rather than beside it', () => {
    const reason = declarationsOf('.shortcut-sheet__reason');
    expect(reason.get('display')).toBe('block');
    expect(reason.get('color')).toBe('var(--fg-muted)');
  });
});

describe('the stylesheet’s own rules', () => {
  it('paints nothing with a literal colour', () => {
    for (const rule of sheetRules) {
      for (const [property, value] of parseDeclarations(rule.body)) {
        if (!/color|background|border|shadow|fill/.test(property)) continue;
        expect(`${rule.prelude} { ${property}: ${value} }`).not.toMatch(/#[0-9a-f]{3,8}\b/i);
        expect(`${rule.prelude} { ${property}: ${value} }`).not.toMatch(/\brgba?\(/i);
      }
    }
  });

  it('freezes no type size', () => {
    for (const rule of sheetRules) {
      const size = parseDeclarations(rule.body).get('font-size');
      if (size) expect(size).toMatch(/^var\(--fs-/);
    }
  });

  it('has a rule for every class the component draws with', () => {
    const preludes = sheetRules.map((rule) => rule.prelude).join(' ');
    for (const className of [
      '.shortcut-sheet',
      '.shortcut-sheet__grid',
      '.shortcut-sheet__caps',
      '.shortcut-sheet__list',
      '.shortcut-sheet__row',
      '.shortcut-sheet__label',
      '.shortcut-sheet__reason',
      '.shortcut-sheet__keys',
      '.shortcut-sheet__action',
      '.shortcut-sheet__note',
      '.shortcut-sheet__empty',
    ]) {
      expect(preludes).toContain(className);
    }
  });
});

describe('quiet text a reader has to read', () => {
  /** The `light` default plus every theme block that restates the token. */
  const themeBlocks = readThemeBlocks(css);
  const themes: readonly (string | undefined)[] = [undefined, ...themeBlocks.keys()];

  it('reads the light default and every theme block, so a new theme cannot slip past', () => {
    expect(themes.length).toBeGreaterThanOrEqual(8);
  });

  it('clears WCAG AA for the headings, the reason line and the footnote', () => {
    for (const theme of themes) {
      const block = theme ? themeBlocks.get(theme) : undefined;
      const ratio = contrastRatio(
        hexToRgb(resolveThemeToken('--color-fg-muted', tokens, block)),
        hexToRgb(resolveThemeToken('--color-surface', tokens, block))
      );
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
    }
  });

  it('clears WCAG AA for a row that can be run, in every theme', () => {
    // `--accent` is a *fill* colour: as ink on the surface it measures 4.1:1, which axe
    // reports as serious. `--accent-fg` is the step meant to be read.
    for (const theme of themes) {
      const block = theme ? themeBlocks.get(theme) : undefined;
      const ratio = contrastRatio(
        hexToRgb(resolveThemeToken('--color-accent-fg', tokens, block)),
        hexToRgb(resolveThemeToken('--color-surface', tokens, block))
      );
      expect(ratio).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
    }
  });

  it('uses no `--fg-subtle` anywhere in the sheet’s own rules', () => {
    // The reason line is where a *gated* shortcut explains itself: the one piece of copy in
    // the sheet a reader most needs. `--fg-subtle` measures 2.8–4.0:1 in every theme.
    for (const rule of sheetRules) {
      expect(rule.body).not.toContain('--fg-subtle');
    }
  });
});
