/**
 * Hive design-token layer — `src/app/globals.css` (HIVE-1.1, #5274).
 *
 * The redesign's premise is that colour, radius, elevation, motion and layout have exactly
 * one definition, in `@theme`, and that every later ticket only ever *swaps* those tokens
 * (HIVE-1.2 per theme, HIVE-1.3 per density) or *reads* them (Epics 2+). This suite locks
 * the four properties that premise rests on:
 *
 *   1. every token the design authority (`docs/mockups/DESIGN.md` §3.1) and the ticket's
 *      scope list name is declared and resolves to a literal — no dangling `var()`;
 *   2. the pre-Hive variable names still resolve, so the ~120 `var(--text-muted)` /
 *      `var(--surface)` call sites keep working through the migration;
 *   3. the layering contract holds — `@theme static`, and no name declared in both
 *      `@theme` and the unlayered `:root` block (either mistake silently pins a token and
 *      breaks the per-theme swaps in `hive-theme-blocks.test.ts` without erroring);
 *   4. raw hex appears only inside a documented `hex-allow-start` / `hex-allow-end` fence.
 *
 * A fifth group covers the Radix Themes reconfiguration on both layouts, which is the one
 * part of the ticket that lives outside the stylesheet.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  contrastRatio,
  designDocColorTokens,
  findUnfencedHex,
  hexToRgb,
  parseBlock,
  readGlobalsCss,
  readTokenLayer,
  resolveToken,
  type TokenLayer,
} from './helpers/design-tokens';
import { WCAG_AA_LARGE_TEXT_MIN, WCAG_AA_NORMAL_TEXT_MIN } from './helpers/tailwind-contrast';

const css = readGlobalsCss();
const layer: TokenLayer = readTokenLayer(css);

/** Semantic families that each carry a base, a `-soft` fill and a `-fg` ink. */
const SEMANTIC_FAMILIES = ['ok', 'warn', 'danger', 'violet', 'orange', 'rose', 'neutral'];

/**
 * The Tailwind-facing tokens the ticket's scope list enumerates, by group.
 *
 * These are the names utilities are generated from (`bg-canvas`, `rounded-lg`,
 * `shadow-raised`, `ease-out`), so they must live in `@theme`, not in `:root`.
 */
const THEME_TOKEN_GROUPS: Record<string, string[]> = {
  surfaces: ['--color-canvas', '--color-rail', '--color-surface', '--color-subtle', '--color-inset', '--color-overlay'],
  ink: ['--color-fg', '--color-fg-muted', '--color-fg-subtle', '--color-fg-faint'],
  lines: ['--color-border', '--color-border-strong'],
  accent: [
    '--color-ink',
    '--color-accent',
    '--color-accent-soft',
    '--color-accent-fg',
    '--color-honey',
    '--color-honey-soft',
    '--color-honey-fg',
  ],
  semantic: SEMANTIC_FAMILIES.flatMap((family) => [
    `--color-${family}`,
    `--color-${family}-soft`,
    `--color-${family}-fg`,
  ]),
  radii: ['--radius-xs', '--radius-sm', '--radius-md', '--radius-lg', '--radius-xl'],
  shadows: ['--shadow-xs', '--shadow-sm', '--shadow-md', '--shadow-lg', '--shadow-raised'],
  motion: ['--ease-out', '--ease-in-out', '--dur-fast', '--dur-base', '--dur-slow'],
  layout: ['--rail-w', '--page-max'],
};

/**
 * Pre-Hive variable names, and the Hive token each now points at.
 *
 * Since HIVE-1.2 (#5275) these are plain pointers with no per-theme override of their
 * own: a theme swaps the token underneath, and the alias follows.
 */
const LEGACY_ALIASES: Record<string, string> = {
  '--background': '--color-canvas',
  '--foreground': '--color-fg',
  '--surface': '--color-surface',
  '--surface-muted': '--color-subtle',
  '--border-subtle': '--color-border',
  '--focus-ring': '--color-accent',
  '--text-muted': '--color-fg-muted',
  '--shadow-subtle': '--shadow-xs',
  '--control-height': '--control-h',
};

/**
 * Read a layout module's source.
 *
 * The layouts are React Server Components wired to auth, theming and session providers;
 * rendering one in jsdom would assert on the mocks rather than on the props, so the Radix
 * configuration is checked at the source.
 *
 * @param segments Path segments below `src/app`.
 * @returns The file's text.
 */
function readLayout(...segments: string[]): string {
  return readFileSync(join(__dirname, '..', 'src', 'app', ...segments), 'utf8');
}

describe('design authority — DESIGN.md §3.1 tokens', () => {
  const documented = designDocColorTokens();

  it('lists the colour families the Hive palette is built from', () => {
    // Guards the parser itself: a §3.1 rewrite that silently stopped matching would make
    // every assertion below vacuous.
    expect(documented).toEqual(expect.arrayContaining(['--bg-canvas', '--fg-muted', '--ink-fg', '--accent-soft']));
    expect(documented.length).toBeGreaterThanOrEqual(30);
  });

  it.each(designDocColorTokens())('%s resolves to a literal at :root', (token) => {
    expect(resolveToken(token, layer)).toMatch(/^(#|rgba?\(|color-mix\()/);
  });
});

describe('@theme token layer — ticket scope list', () => {
  it.each(Object.entries(THEME_TOKEN_GROUPS))('declares every %s token in @theme', (_group, tokens) => {
    const missing = tokens.filter((token) => !layer.theme.has(token));
    expect(missing).toEqual([]);
  });

  it.each(Object.values(THEME_TOKEN_GROUPS).flat())('%s resolves without a dangling var()', (token) => {
    expect(() => resolveToken(token, layer)).not.toThrow();
  });

  it('uses @theme static so no token is tree-shaken out of :root', () => {
    // Plain `@theme` drops variables no utility references — which, in a token layer landed
    // ahead of the components that consume it, is nearly all of them.
    expect(css).toContain('@theme static {');
    expect(css).not.toMatch(/@theme\s+(inline\s+)?\{/);
  });

  it('carries the Hive radius scale rather than Tailwind defaults', () => {
    expect(resolveToken('--radius-xs', layer)).toBe('4px');
    expect(resolveToken('--radius-sm', layer)).toBe('6px');
    expect(resolveToken('--radius-md', layer)).toBe('10px');
    expect(resolveToken('--radius-lg', layer)).toBe('14px');
    expect(resolveToken('--radius-xl', layer)).toBe('20px');
  });

  it('carries the DESIGN.md §3.4 motion durations and easing', () => {
    expect(resolveToken('--dur-fast', layer)).toBe('120ms');
    expect(resolveToken('--dur-base', layer)).toBe('180ms');
    expect(resolveToken('--dur-slow', layer)).toBe('260ms');
    expect(resolveToken('--ease-out', layer)).toBe('cubic-bezier(0.2, 0.8, 0.2, 1)');
  });

  it('carries the DESIGN.md §5.2 rail and page-width constants', () => {
    // The rail is chrome wrapped around type, so HIVE-1.6 (#5279) restated its two widths
    // in `rem` — 16.5rem is §5.2's 264px on a default 16px root, and it follows the
    // font-size preference from there. The page cap stays `px`: it is measured against the
    // viewport, and a cap that grew with the scale would force horizontal scroll.
    expect(resolveToken('--rail-w', layer)).toBe('16.5rem');
    expect(resolveToken('--rail-w-collapsed', layer)).toBe('4rem');
    expect(resolveToken('--page-max', layer)).toBe('1440px');
  });
});

describe('layering contract', () => {
  it('never declares a @theme token again in the unlayered :root block', () => {
    // `:root` is unlayered and `@theme` lands in `@layer theme`, so a duplicate name would
    // pin the token to its `:root` value and silently defeat the HIVE-1.2 theme swap.
    const shadowed = [...layer.root.keys()].filter((name) => layer.theme.has(name));
    expect(shadowed).toEqual([]);
  });

  it('drops the ad-hoc --radius-md that used to override the Tailwind radius scale', () => {
    expect(layer.root.has('--radius-md')).toBe(false);
  });

  it('routes every :root alias at a token instead of restating a value', () => {
    const literals = [...layer.root.entries()].filter(
      ([name, value]) =>
        // Type, spacing and control metrics are defined here outright; colour never is.
        !/^--(app-|font-|fs-|lh-|track-|space-|control-|row-h|page-pad|card-pad|nav-item-h|sidenav-w|table-|r-full)/.test(name) &&
        !value.startsWith('var('),
    );
    expect(literals).toEqual([]);
  });
});

describe('legacy aliases — nothing breaks mid-migration', () => {
  it.each(Object.keys(LEGACY_ALIASES))('%s is still declared at :root', (alias) => {
    expect(layer.root.has(alias)).toBe(true);
  });

  it.each(Object.entries(LEGACY_ALIASES))('%s points at %s', (alias, token) => {
    expect(layer.root.get(alias)).toBe(`var(${token})`);
  });

  it.each(Object.keys(LEGACY_ALIASES))('%s resolves to the same literal as its token', (alias) => {
    expect(resolveToken(alias, layer)).toBe(resolveToken(LEGACY_ALIASES[alias], layer));
  });

  it('keeps the Tailwind colour utilities the legacy names generated', () => {
    for (const utility of [
      '--color-background',
      '--color-foreground',
      '--color-surface',
      '--color-surface-muted',
      '--color-border-subtle',
      '--color-text-muted',
    ]) {
      expect(layer.theme.has(utility)).toBe(true);
    }
  });

  it('keeps --font-inter, which the capability and Mermaid graphs read directly', () => {
    expect(layer.root.get('--font-inter')).toBe('var(--app-font-sans)');
  });
});

describe('sibling-app content scanning', () => {
  it.each(['@source "../";', '@source "../../lib";'])('still declares %s', (directive) => {
    // Sibling apps (private-suite Studio/designer) import this stylesheet; without these,
    // Tailwind roots auto-detection at the consumer and never emits apiome-ui's classes.
    expect(css).toContain(directive);
  });
});

describe('raw-hex allow-list', () => {
  it('finds no hex literal outside a documented fence', () => {
    expect(findUnfencedHex(css).map((hit) => `${hit.line}: ${hit.text}`)).toEqual([]);
  });

  it('documents the allow-list next to the token layer', () => {
    expect(css).toContain('RAW HEX ALLOW-LIST');
    for (const permitted of ['brand', '.fmt--*', '.method--*']) {
      expect(css).toContain(permitted);
    }
  });

  it('balances every fence it opens', () => {
    const opened = css.match(/hex-allow-start/g) ?? [];
    const closed = css.match(/hex-allow-end/g) ?? [];
    expect(opened).toHaveLength(closed.length);
  });

  it('labels every fence with the reason it exists', () => {
    for (const [, label] of css.matchAll(/hex-allow-start:?(.*)/g)) {
      expect(label.trim().replace(/\*\/$/, '').trim().length).toBeGreaterThan(0);
    }
  });
});

describe('light-palette legibility (WCAG 2.2 AA)', () => {
  /**
   * Resolve a token and parse it as an opaque colour.
   *
   * @param token Custom-property name.
   * @returns The token's sRGB channels.
   */
  const colorOf = (token: string) => hexToRgb(resolveToken(token, layer));

  it.each([
    ['--fg', '--bg-canvas'],
    ['--fg', '--bg-surface'],
    ['--fg', '--bg-subtle'],
    ['--fg-muted', '--bg-surface'],
    ['--accent-fg', '--accent-soft'],
    ['--ok-fg', '--ok-soft'],
    ['--warn-fg', '--warn-soft'],
    ['--danger-fg', '--danger-soft'],
    ['--ink-fg', '--ink'],
  ])('%s on %s clears AA for body text', (ink, surface) => {
    expect(contrastRatio(colorOf(ink), colorOf(surface))).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_MIN);
  });

  it.each([
    ['--fg-subtle', '--bg-surface'],
    ['--accent', '--bg-surface'],
  ])('%s on %s clears AA for large text and non-text marks', (ink, surface) => {
    expect(contrastRatio(colorOf(ink), colorOf(surface))).toBeGreaterThanOrEqual(WCAG_AA_LARGE_TEXT_MIN);
  });
});

describe('Radix Themes reconfiguration', () => {
  const layouts: Array<[string, string]> = [
    ['src/app/layout.tsx', readLayout('layout.tsx')],
    ['src/app/ade/layout.tsx', readLayout('ade', 'layout.tsx')],
  ];

  it.each(layouts)('%s configures RadixTheme for the Hive palette', (_path, source) => {
    expect(source).toContain('accentColor="blue"');
    expect(source).toContain('grayColor="sand"');
    expect(source).toContain('radius="large"');
    expect(source).toContain('panelBackground="solid"');
  });

  it.each(layouts)('%s no longer carries the pre-Hive indigo/slate configuration', (_path, source) => {
    expect(source).not.toContain('accentColor="indigo"');
    expect(source).not.toContain('grayColor="slate"');
    expect(source).not.toContain('radius="medium"');
  });
});

describe('Radix typography bridge', () => {
  it('still points the Radix font tokens at the app fonts', () => {
    const radix = parseBlock(css, 'html .radix-themes');
    expect(radix.get('--default-font-family')).toBe('var(--app-font-sans)');
    expect(radix.get('--heading-font-family')).toBe('var(--app-font-sans)');
    expect(radix.get('--code-font-family')).toBe('var(--app-font-mono)');
  });
});
