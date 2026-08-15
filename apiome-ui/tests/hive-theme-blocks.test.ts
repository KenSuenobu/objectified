/**
 * Per-theme token swaps — `src/app/globals.css` (HIVE-1.2, #5275).
 *
 * HIVE-1.1 established that colour has exactly one definition. This ticket's premise is
 * that a *theme* is a swap of those definitions and nothing else, so the suite locks the
 * properties that premise rests on and that nothing else can observe from a Jest run:
 *
 *   1. every theme in the catalogue has a block, `light` excepted — it is the `:root`
 *      default — and each block swaps only names the token layer actually declares;
 *   2. a block declares *custom properties and `color-scheme` only*. That is the static
 *      form of the acceptance criterion "switching theme changes only colour": a rule that
 *      cannot set a length, a font or a radius cannot move an element, so a screenshot
 *      diff between two themes has nothing to differ on but colour;
 *   3. nothing anywhere in the stylesheet re-tints a fixed identity (`.fmt--*` format
 *      pills, `.method--*` HTTP chips) per theme;
 *   4. the pre-Hive `.theme-*` class system, its `!important` background overrides and
 *      its two-variable `prefers-color-scheme` fallback are gone from the whole codebase;
 *   5. every palette stays legible — body ink at AAA, secondary ink and status chips at
 *      AA, and High contrast at AAA with an opaque `--border-strong`.
 *
 * Rendered contrast stays the Playwright/axe suite's job; this is the deterministic guard
 * that stops a token regressing between browser runs.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  alphaOf,
  compositeOver,
  contrastRatio,
  hexToRgb,
  readGlobalsCss,
  parseDeclarations,
  readThemeBlocks,
  readTokenLayer,
  resolveThemeToken,
  topLevelRules,
  type ThemeBlock,
  type TokenLayer,
} from './helpers/design-tokens';
import {
  relativeLuminance,
  WCAG_AA_LARGE_TEXT_MIN,
  WCAG_AA_NORMAL_TEXT_MIN,
  type Rgb,
} from './helpers/tailwind-contrast';
import { themes } from '../src/app/config/themes';

/** Minimum contrast for body text at WCAG 2.2 AAA (SC 1.4.6). */
const WCAG_AAA_NORMAL_TEXT_MIN = 7;

const css = readGlobalsCss();
const layer: TokenLayer = readTokenLayer(css);
const blocks = readThemeBlocks(css);

/** Themes that own a block, in the order `DESIGN.md` §4.1 lists them. */
const THEMED_IDS = ['dark', 'high-contrast', 'blueprint', 'whiteboard', 'solarized', 'nord', 'darcula'];

/** Every palette a user can end up looking at, `light` (the `:root` default) included. */
const PALETTE_IDS = ['light', ...THEMED_IDS];

/** Status families that pair a `-soft` fill with a `-fg` ink. */
const SEMANTIC_FAMILIES = ['ok', 'warn', 'danger', 'violet', 'orange', 'rose', 'neutral', 'accent', 'honey'];

/** Themes whose palette sits on a dark base (`DESIGN.md` §4.2). */
const DARK_BASED_IDS = ['dark', 'high-contrast', 'blueprint', 'solarized', 'nord', 'darcula'];

/**
 * The block for a palette id.
 *
 * @param id Palette id. `light` has no block and resolves against `:root` alone.
 * @returns The theme block, or `undefined` for `light`.
 */
function blockOf(id: string): ThemeBlock | undefined {
  return id === 'light' ? undefined : blocks.get(id);
}

/**
 * Resolve a token under a palette and parse it as a colour.
 *
 * @param token Custom-property name.
 * @param id Palette id.
 * @returns The literal, ready for {@link compositeOver} or {@link hexToRgb}.
 */
function tokenOf(token: string, id: string): string {
  return resolveThemeToken(token, layer, blockOf(id));
}

/**
 * An opaque colour token under a palette.
 *
 * @param token Custom-property name naming an opaque colour.
 * @param id Palette id.
 * @returns The sRGB channels.
 */
function colorOf(token: string, id: string): Rgb {
  return hexToRgb(tokenOf(token, id));
}

/**
 * Every file under a directory, recursively.
 *
 * @param directory Absolute path to walk.
 * @param extensions File extensions to keep, with the leading dot.
 * @returns Absolute paths, in traversal order.
 */
function walk(directory: string, extensions: string[]): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...walk(path, extensions));
    else if (extensions.some((extension) => entry.endsWith(extension))) found.push(path);
  }
  return found;
}

/**
 * Every top-level rule whose selector mentions a theme.
 *
 * @returns The rules, in source order — token swaps and theme-scoped component rules alike.
 */
function themeScopedRules() {
  return topLevelRules(css).filter((rule) => rule.prelude.includes('[data-theme'));
}

describe('theme blocks — one per theme, ported from hive.css §4', () => {
  it('defines a block for every theme but `light`, in DESIGN.md §4.1 order', () => {
    expect([...blocks.keys()]).toEqual(THEMED_IDS);
  });

  it('leaves `light` to `:root`, so the default palette is never restated', () => {
    expect(blocks.has('light')).toBe(false);
    expect(css).not.toContain('[data-theme="light"]');
  });

  it('covers every theme the catalogue offers', () => {
    const selectable = themes.filter((theme) => theme.appearance !== 'system').map((theme) => theme.id);
    expect(selectable.sort()).toEqual(PALETTE_IDS.slice().sort());
  });

  it('rides the dark palette on `.dark` until a choice is made', () => {
    // next-themes sets `.dark` from a blocking script, and on routes that never mount
    // ThemeProvider (login/signup) it is the only signal there is.
    expect(blocks.get('dark')?.prelude).toContain('html.dark:not([data-theme])');
  });

  it.each(THEMED_IDS)('%s swaps only names the token layer declares', (id) => {
    const unknown = [...blocks.get(id)!.declarations.keys()].filter(
      (name) => name.startsWith('--') && !layer.theme.has(name) && !layer.root.has(name),
    );
    expect(unknown).toEqual([]);
  });

  it.each(THEMED_IDS)('%s restates the surfaces and ink that give it its character', (id) => {
    const declared = blocks.get(id)!.declarations;
    for (const token of ['--color-canvas', '--color-surface', '--color-fg', '--color-accent', '--color-ink']) {
      expect(declared.has(token)).toBe(true);
    }
  });

  it.each(THEMED_IDS)('%s declares the colour scheme its palette implies', (id) => {
    expect(blocks.get(id)!.declarations.get('color-scheme')).toBe(
      DARK_BASED_IDS.includes(id) ? 'dark' : 'light',
    );
  });
});

describe('a theme swaps colour and never geometry', () => {
  it.each(THEMED_IDS)('%s declares custom properties and `color-scheme` only', (id) => {
    // The static form of "a screenshot diff between two themes shows identical element
    // geometry": a rule that declares no length, font or radius cannot move anything.
    const offenders = [...blocks.get(id)!.declarations.keys()].filter(
      (property) => !property.startsWith('--') && property !== 'color-scheme',
    );
    expect(offenders).toEqual([]);
  });

  it.each(THEMED_IDS)('%s swaps no sizing token either', (id) => {
    const sizing = /^--(space|control|row-h|page-pad|card-pad|nav-item-h|radius|r|fs|lh|track|rail-w|page-max|content-max|font)/;
    const offenders = [...blocks.get(id)!.declarations.keys()].filter((token) => sizing.test(token));
    expect(offenders).toEqual([]);
  });

  it('applies a token swap to the document root and nowhere else', () => {
    // A swap that could match a subtree would let one theme restyle part of a page.
    const swaps = themeScopedRules().filter((rule) =>
      [...parseDeclarations(rule.body).keys()].some((property) => property.startsWith('--')),
    );
    const reachingInside = swaps.filter((rule) =>
      rule.prelude.split(',').some((selector) => /\s/.test(selector.trim())),
    );
    expect(reachingInside.map((rule) => `${rule.line}: ${rule.prelude}`)).toEqual([]);
  });

  it('lets a theme-scoped component rule read tokens, never restate colour', () => {
    // The projection panel is the one component still scoped to a theme (EFP-3.2); it
    // borrows the palette rather than carrying one, so it cannot drift from it.
    const scoped = themeScopedRules().filter((rule) =>
      rule.prelude.split(',').some((selector) => /\s/.test(selector.trim())),
    );
    expect(scoped.length).toBeGreaterThan(0);

    const literals = scoped.flatMap((rule) =>
      [...parseDeclarations(rule.body).entries()]
        .filter(([, value]) => /#[0-9a-f]{3}|\brgba?\(/i.test(value))
        .map(([property, value]) => `${rule.line}: ${property}: ${value}`),
    );
    expect(literals).toEqual([]);
  });

  it('never re-tints a fixed identity per theme', () => {
    // Format pills and HTTP method chips are identities, not decoration (DESIGN.md §4.2).
    const tinted = topLevelRules(css).filter(
      (rule) => rule.prelude.includes('[data-theme=') && /\.(fmt|method)/.test(rule.prelude),
    );
    expect(tinted.map((rule) => rule.prelude)).toEqual([]);
  });
});

describe('the pre-Hive theme system is gone', () => {
  it('keeps no `theme-*` class anywhere in the app or its tests', () => {
    const root = join(__dirname, '..');
    const sources = [
      ...walk(join(root, 'src'), ['.ts', '.tsx', '.css']),
      ...walk(join(root, 'lib'), ['.ts', '.tsx']),
      ...walk(__dirname, ['.ts', '.tsx']),
      ...walk(join(root, 'e2e'), ['.ts']),
    ];
    const legacy = /['"`.\s]theme-(system|light|dark|high-contrast|blueprint|whiteboard|solarized|nord|darcula)\b/;

    const offenders = sources.filter((path) => legacy.test(readFileSync(path, 'utf8')));
    expect(offenders.map((path) => path.slice(root.length + 1))).toEqual([]);
  });

  it('drops the `!important` background overrides the legacy themes needed', () => {
    // The pre-Hive themes had to out-shout `dark:bg-gray-900` on individual elements;
    // a token swap simply changes what those utilities resolve to.
    const shouted = themeScopedRules().filter((rule) => rule.body.includes('!important'));
    expect(shouted.map((rule) => `${rule.line}: ${rule.prelude}`)).toEqual([]);
  });

  it('resolves the system preference in JavaScript, not in a media query', () => {
    // `prefers-color-scheme` was a two-variable fallback; ThemeProvider now resolves the
    // preference to a real theme id and the `.dark` companion selector covers first paint.
    expect(css).not.toContain('prefers-color-scheme');
  });

  it('points the legacy colour utilities straight at the tokens', () => {
    expect(layer.theme.get('--color-background')).toBe('var(--color-canvas)');
    expect(layer.theme.get('--color-foreground')).toBe('var(--color-fg)');
  });
});

describe('every palette stays legible', () => {
  it.each(PALETTE_IDS)('%s clears AAA for body text on the canvas', (id) => {
    expect(contrastRatio(colorOf('--color-fg', id), colorOf('--color-canvas', id))).toBeGreaterThanOrEqual(
      WCAG_AAA_NORMAL_TEXT_MIN,
    );
  });

  it.each(PALETTE_IDS)('%s clears AAA for body text on a card', (id) => {
    expect(contrastRatio(colorOf('--color-fg', id), colorOf('--color-surface', id))).toBeGreaterThanOrEqual(
      WCAG_AAA_NORMAL_TEXT_MIN,
    );
  });

  it.each(PALETTE_IDS)('%s clears AA for secondary ink', (id) => {
    expect(
      contrastRatio(colorOf('--color-fg-muted', id), colorOf('--color-surface', id)),
    ).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
  });

  it.each(PALETTE_IDS)('%s clears AA for accent marks and links', (id) => {
    expect(contrastRatio(colorOf('--color-accent', id), colorOf('--color-surface', id))).toBeGreaterThanOrEqual(
      WCAG_AA_LARGE_TEXT_MIN,
    );
  });

  it.each(PALETTE_IDS)('%s keeps the primary button at AAA', (id) => {
    // "Dark-based themes flip --ink light so the primary button keeps highest contrast."
    expect(contrastRatio(colorOf('--color-ink-fg', id), colorOf('--color-ink', id))).toBeGreaterThanOrEqual(
      WCAG_AAA_NORMAL_TEXT_MIN,
    );
  });

  it.each(PALETTE_IDS.flatMap((id) => SEMANTIC_FAMILIES.map((family) => [id, family] as const)))(
    '%s keeps the %s chip readable',
    (id, family) => {
      // A chip is `background: var(--x-soft); color: var(--x-fg)`, and `-soft` is often
      // translucent, so both are composited onto the card the chip sits on.
      const surface = colorOf('--color-surface', id);
      const fill = compositeOver(tokenOf(`--color-${family}-soft`, id), surface);
      const ink = compositeOver(tokenOf(`--color-${family}-fg`, id), fill);
      expect(contrastRatio(ink, fill)).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
    },
  );

  it.each(DARK_BASED_IDS)('%s paints the primary button in light ink', (id) => {
    // The flip itself, not just its contrast: on a dark base the button fill is the light
    // end of the palette, which is what keeps it the most prominent control on the page.
    expect(relativeLuminance(colorOf('--color-ink', id))).toBeGreaterThan(
      relativeLuminance(colorOf('--color-canvas', id)),
    );
  });

  it.each(PALETTE_IDS)('%s keeps --border-strong the more visible of the two lines', (id) => {
    const surface = colorOf('--color-surface', id);
    const hairline = contrastRatio(compositeOver(tokenOf('--color-border', id), surface), surface);
    const strong = contrastRatio(compositeOver(tokenOf('--color-border-strong', id), surface), surface);
    expect(strong).toBeGreaterThan(hairline);
  });

  it('makes the High contrast border opaque and unmissable', () => {
    const border = tokenOf('--color-border-strong', 'high-contrast');
    expect(alphaOf(border)).toBe(1);
    expect(contrastRatio(hexToRgb(border), colorOf('--color-canvas', 'high-contrast'))).toBeGreaterThanOrEqual(
      WCAG_AAA_NORMAL_TEXT_MIN,
    );
  });
});
