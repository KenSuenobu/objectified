/**
 * The Hive palette as a Monaco theme (HIVE-5.7, #5310).
 *
 * The ticket's first acceptance criterion is that **Monaco follows the active theme**, and
 * it is shared with HIVE-6.4 and 8.3 — so what is pinned here is the module's contract
 * rather than one screen's use of it:
 *
 *   1. **Every colour handed to Monaco is hex.** Monaco parses its own theme and rejects
 *      anything else with an exception that takes the editor down; the token layer is full
 *      of `rgba()`, so the conversion is load-bearing.
 *   2. **The fallback palette is the light token layer**, re-derived from `globals.css`
 *      here — the same guard `theme-catalog.test.ts` puts on the theme picker's swatches.
 *      Without it, a token swap would silently desynchronise the jsdom/SSR fallback.
 *   3. **Every token the module reads is spelled in a form it can parse.** A future token
 *      rewritten as `color-mix()` would fall back to the light default in *every* theme,
 *      which is exactly the failure "Monaco follows the theme" is meant to exclude.
 *   4. **The base flips with the surface**, which is what decides the colours the theme does
 *      not name — measured against all nine palettes rather than against a theme id.
 */

import {
  HIVE_MONACO_THEME_ID,
  LIGHT_FALLBACK_PALETTE,
  applyHiveMonacoTheme,
  buildHiveMonacoTheme,
  isDarkSurface,
  parseCssColor,
  readHiveEditorPalette,
  toMonacoColor,
  type HiveEditorPalette,
} from '../src/app/components/ui/code/monacoHiveTheme';
import {
  readGlobalsCss,
  readThemeBlocks,
  readTokenLayer,
  resolveThemeToken,
} from './helpers/design-tokens';

const css = readGlobalsCss();
const tokens = readTokenLayer(css);

/** The light default, then every `html[data-theme]` block — the nine appearances. */
const APPEARANCES = [
  ['light', undefined] as const,
  ...[...readThemeBlocks(css).entries()].map(([id, block]) => [id, block] as const),
];

/**
 * The token each palette entry reads, mirrored from the module.
 *
 * Stated again here rather than exported from the module: the point of this suite is to
 * catch a *change* to that mapping that nobody meant, and a table read from the thing under
 * test cannot do that.
 */
const PALETTE_TOKENS: Record<keyof HiveEditorPalette, string> = {
  background: '--bg-inset',
  foreground: '--fg',
  lineNumber: '--fg-faint',
  muted: '--fg-muted',
  subtle: '--fg-subtle',
  border: '--border-strong',
  surface: '--bg-surface',
  accent: '--accent',
  warn: '--warn',
  ok: '--ok',
  violet: '--violet',
  danger: '--danger',
};

/** The six dark-based palettes, by the base Monaco has to take under each. */
const DARK_THEMES = new Set(['dark', 'high-contrast', 'blueprint', 'nord', 'darcula', 'solarized']);

// ---------------------------------------------------------------------------------------
// 1. Colour arithmetic
// ---------------------------------------------------------------------------------------

describe('parseCssColor', () => {
  it('reads every hex spelling', () => {
    expect(parseCssColor('#abc')).toEqual({ r: 170, g: 187, b: 204, a: 1 });
    expect(parseCssColor('#1E7FD6')).toEqual({ r: 30, g: 127, b: 214, a: 1 });
    expect(parseCssColor('#1E7FD680')).toMatchObject({ r: 30, g: 127, b: 214 });
    expect(parseCssColor('#1E7FD680')!.a).toBeCloseTo(128 / 255, 3);
  });

  it('reads both `rgb()` spellings, comma- and space-separated', () => {
    expect(parseCssColor('rgb(28, 25, 20)')).toEqual({ r: 28, g: 25, b: 20, a: 1 });
    expect(parseCssColor('rgba(28, 25, 20, 0.18)')).toEqual({ r: 28, g: 25, b: 20, a: 0.18 });
    expect(parseCssColor('rgb(28 25 20 / 50%)')).toEqual({ r: 28, g: 25, b: 20, a: 0.5 });
  });

  it('refuses what it cannot spell for Monaco', () => {
    expect(parseCssColor('')).toBeNull();
    expect(parseCssColor('color-mix(in srgb, var(--fg) 30%, transparent)')).toBeNull();
    expect(parseCssColor('oklch(0.7 0.1 250)')).toBeNull();
    expect(parseCssColor('#12345')).toBeNull();
  });
});

describe('toMonacoColor', () => {
  it('always returns hex, whatever it was given', () => {
    expect(toMonacoColor('#1E7FD6')).toBe('#1e7fd6');
    expect(toMonacoColor('rgb(30, 127, 214)')).toBe('#1e7fd6');
  });

  it('keeps a translucent colour translucent rather than guessing a backdrop', () => {
    expect(toMonacoColor('rgba(28, 25, 20, 0.18)')).toBe('#1c19142e');
  });

  it('multiplies an extra opacity onto the colour’s own', () => {
    expect(toMonacoColor('#1E7FD6', 0.25)).toBe('#1e7fd640');
    // 0.5 of an already-half-opaque colour is a quarter.
    expect(toMonacoColor('rgba(30, 127, 214, 0.5)', 0.5)).toBe('#1e7fd640');
  });

  it('falls back rather than handing Monaco something it will reject', () => {
    expect(toMonacoColor('color-mix(in srgb, red, blue)', undefined, '#123456')).toBe('#123456');
    expect(toMonacoColor('', 0.5, '#123456')).toBe('#12345680');
  });
});

describe('isDarkSurface', () => {
  it('reads the light and dark canvases the app actually ships', () => {
    expect(isDarkSurface('#E9E8E3')).toBe(false);
    expect(isDarkSurface('#1B1A17')).toBe(true);
  });

  it('treats an unreadable colour as light, which is the `:root` default', () => {
    expect(isDarkSurface('color-mix(in srgb, red, blue)')).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// 2. The fallback palette is the token layer
// ---------------------------------------------------------------------------------------

describe('the light fallback palette', () => {
  it.each(Object.entries(PALETTE_TOKENS))(
    'matches what %s resolves to in the light theme',
    (key, token) => {
      const declared = resolveThemeToken(token, tokens, undefined);
      const fallback = LIGHT_FALLBACK_PALETTE[key as keyof HiveEditorPalette];
      // Compared as *colours*, not as strings: `#FFFFFF` and `#ffffff` are the same paint,
      // and so are `rgba(28, 25, 20, .18)` and `rgba(28,25,20,0.18)`.
      expect(toMonacoColor(fallback)).toBe(toMonacoColor(declared));
    }
  );
});

describe('every token the module reads', () => {
  it.each(APPEARANCES)('is a colour Monaco can be given under %s', (_id, block) => {
    for (const token of Object.values(PALETTE_TOKENS)) {
      const value = resolveThemeToken(token, tokens, block);
      expect({ token, value, parsed: parseCssColor(value) !== null }).toMatchObject({
        token,
        value,
        parsed: true,
      });
    }
  });
});

// ---------------------------------------------------------------------------------------
// 3. The theme object
// ---------------------------------------------------------------------------------------

/**
 * The palette one appearance resolves to.
 *
 * @param block The theme block, or `undefined` for the light default.
 * @returns The palette, as `readHiveEditorPalette` would have read it from a browser.
 */
function paletteFor(block: (typeof APPEARANCES)[number][1]): HiveEditorPalette {
  const palette = {} as HiveEditorPalette;
  for (const [key, token] of Object.entries(PALETTE_TOKENS)) {
    palette[key as keyof HiveEditorPalette] = resolveThemeToken(token, tokens, block);
  }
  return palette;
}

describe('buildHiveMonacoTheme', () => {
  it.each(APPEARANCES)('names nothing but hex under %s', (_id, block) => {
    const theme = buildHiveMonacoTheme(paletteFor(block));
    for (const [key, value] of Object.entries(theme.colors)) {
      expect({ key, hex: /^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(value) }).toEqual({ key, hex: true });
    }
    for (const rule of theme.rules) {
      if (rule.foreground === undefined) continue;
      expect(/^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(rule.foreground)).toBe(true);
    }
  });

  it.each(APPEARANCES)('takes the base its surface calls for under %s', (id, block) => {
    const theme = buildHiveMonacoTheme(paletteFor(block));
    expect(theme.base).toBe(DARK_THEMES.has(id) ? 'vs-dark' : 'vs');
  });

  it('maps the mockup’s five syntax roles onto their tokens', () => {
    const theme = buildHiveMonacoTheme(LIGHT_FALLBACK_PALETTE);
    const foreground = (token: string) =>
      theme.rules.find((rule) => rule.token === token)?.foreground;

    // `.c-k` honey, `.c-s` green, `.c-p` violet, `.c-c` subtle-and-italic — hive.css §16.
    expect(foreground('type')).toBe(toMonacoColor(LIGHT_FALLBACK_PALETTE.warn));
    expect(foreground('string')).toBe(toMonacoColor(LIGHT_FALLBACK_PALETTE.ok));
    expect(foreground('number')).toBe(toMonacoColor(LIGHT_FALLBACK_PALETTE.violet));
    expect(foreground('comment')).toBe(toMonacoColor(LIGHT_FALLBACK_PALETTE.subtle));
    expect(theme.rules.find((rule) => rule.token === 'comment')?.fontStyle).toBe('italic');
  });

  it('paints the well, the cursor and the two marker hues from tokens', () => {
    const theme = buildHiveMonacoTheme(LIGHT_FALLBACK_PALETTE);
    expect(theme.colors['editor.background']).toBe(toMonacoColor(LIGHT_FALLBACK_PALETTE.background));
    expect(theme.colors['editorCursor.foreground']).toBe(toMonacoColor(LIGHT_FALLBACK_PALETTE.accent));
    expect(theme.colors['editorError.foreground']).toBe(toMonacoColor(LIGHT_FALLBACK_PALETTE.danger));
    expect(theme.colors['editorWarning.foreground']).toBe(toMonacoColor(LIGHT_FALLBACK_PALETTE.warn));
    // A widget floats above the well, so it takes the card surface rather than the inset.
    expect(theme.colors['editorWidget.background']).toBe(toMonacoColor(LIGHT_FALLBACK_PALETTE.surface));
  });

  it('inherits, so the base still supplies what the theme does not name', () => {
    expect(buildHiveMonacoTheme(LIGHT_FALLBACK_PALETTE).inherit).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------
// 4. Reading a document, and applying the result
// ---------------------------------------------------------------------------------------

describe('readHiveEditorPalette', () => {
  it('falls back to the light palette where no stylesheet is compiled', () => {
    // jsdom resolves no custom property, which is also the SSR and the test case.
    expect(readHiveEditorPalette(document.documentElement)).toEqual(LIGHT_FALLBACK_PALETTE);
  });

  it('prefers what the document says when it says something usable', () => {
    document.documentElement.style.setProperty('--fg', 'rgb(1, 2, 3)');
    document.documentElement.style.setProperty('--accent', 'not-a-colour');
    try {
      const palette = readHiveEditorPalette(document.documentElement);
      expect(toMonacoColor(palette.foreground)).toBe('#010203');
      // An unparseable value leaves the default in place rather than reaching Monaco.
      expect(palette.accent).toBe(LIGHT_FALLBACK_PALETTE.accent);
    } finally {
      document.documentElement.style.removeProperty('--fg');
      document.documentElement.style.removeProperty('--accent');
    }
  });
});

describe('applyHiveMonacoTheme', () => {
  it('defines the one theme id and makes it current', () => {
    const defineTheme = jest.fn();
    const setTheme = jest.fn();

    expect(applyHiveMonacoTheme({ editor: { defineTheme, setTheme } })).toBe(true);
    expect(defineTheme).toHaveBeenCalledWith(HIVE_MONACO_THEME_ID, expect.objectContaining({ base: 'vs' }));
    expect(setTheme).toHaveBeenCalledWith(HIVE_MONACO_THEME_ID);
  });

  it('reports a refusal instead of taking the page down with it', () => {
    const monaco = {
      editor: {
        defineTheme: () => {
          throw new Error('nope');
        },
        setTheme: jest.fn(),
      },
    };
    expect(applyHiveMonacoTheme(monaco)).toBe(false);
  });
});
