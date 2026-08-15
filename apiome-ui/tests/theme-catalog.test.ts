/**
 * Theme catalogue — `src/app/config/themes.ts` (HIVE-1.2, #5275).
 *
 * The catalogue and the stylesheet describe the same nine themes from two sides: the
 * stylesheet owns the palette, the catalogue owns what the picker shows and how a choice
 * resolves. Two things can silently drift between them and neither would throw:
 *
 *   • a theme's `appearance` disagreeing with the `color-scheme` its block declares, which
 *     would put the `.dark` class (and therefore every un-migrated `dark:` utility) on the
 *     wrong palette;
 *   • a preview swatch showing a colour the theme no longer applies.
 *
 * So this suite re-derives both from `globals.css` and compares. The stylesheet is the
 * authority: when a case here fails, the fix is almost always to update the catalogue.
 */

import {
  hexToRgb,
  readGlobalsCss,
  readThemeBlocks,
  readTokenLayer,
  resolveThemeToken,
  type TokenLayer,
} from './helpers/design-tokens';
import {
  appearanceOf,
  getDefaultTheme,
  getThemeById,
  resolveTheme,
  themes,
  type Theme,
  type ThemeColors,
  DARK_THEME_ID,
  LIGHT_THEME_ID,
  SYSTEM_THEME_ID,
} from '../src/app/config/themes';

const layer: TokenLayer = readTokenLayer(readGlobalsCss());
const blocks = readThemeBlocks();

/**
 * The design token each preview swatch previews.
 *
 * Restated here rather than imported so the test states the contract independently of the
 * module it checks.
 */
const SWATCH_TOKENS: Record<keyof ThemeColors, string> = {
  background: '--color-canvas',
  foreground: '--color-fg',
  primary: '--color-ink',
  primaryForeground: '--color-ink-fg',
  secondary: '--color-subtle',
  secondaryForeground: '--color-fg',
  muted: '--color-inset',
  mutedForeground: '--color-fg-muted',
  border: '--color-border-strong',
  accent: '--color-accent',
  accentForeground: '--color-accent-fg',
  card: '--color-surface',
  cardForeground: '--color-fg',
  popover: '--color-surface',
  popoverForeground: '--color-fg',
  destructive: '--color-danger',
  destructiveForeground: '--color-fg-on-accent',
};

/** Themes with a palette of their own — everything but the `system` entry. */
const palettes: Theme[] = themes.filter((theme) => theme.id !== SYSTEM_THEME_ID);

describe('catalogue shape', () => {
  it('offers "follow system" first, then the palettes', () => {
    expect(themes[0].id).toBe(SYSTEM_THEME_ID);
    expect(themes[1].id).toBe(LIGHT_THEME_ID);
    expect(themes[2].id).toBe(DARK_THEME_ID);
  });

  it('uses each id once', () => {
    expect(new Set(themes.map((theme) => theme.id)).size).toBe(themes.length);
  });

  it('has exactly one entry that follows the OS', () => {
    expect(themes.filter((theme) => theme.appearance === 'system')).toHaveLength(1);
  });

  it.each(themes.map((theme) => [theme.id, theme] as const))('%s carries a name and a description', (_id, theme) => {
    expect(theme.name.trim().length).toBeGreaterThan(0);
    expect(theme.description.trim().length).toBeGreaterThan(0);
  });
});

describe('appearance agrees with the stylesheet', () => {
  it.each(palettes.map((theme) => [theme.id, theme] as const))(
    '%s declares the same base as its block',
    (id, theme) => {
      // `light` is the `:root` default and has no block; every other palette states its
      // `color-scheme` and must agree with what the provider will do with `.dark`.
      const declared = blocks.get(id)?.declarations.get('color-scheme') ?? 'light';
      expect(theme.appearance).toBe(declared);
    },
  );

  it('reports the light base for the system entry, which has no palette of its own', () => {
    expect(appearanceOf(getThemeById(SYSTEM_THEME_ID)!)).toBe('light');
  });
});

describe('preview swatches match the palette they preview', () => {
  it.each(
    palettes.flatMap((theme) =>
      (Object.keys(SWATCH_TOKENS) as Array<keyof ThemeColors>).map((role) => [theme.id, role] as const),
    ),
  )('%s previews %s with the token it applies', (id, role) => {
    const block = id === LIGHT_THEME_ID ? undefined : blocks.get(id);
    expect(getThemeById(id)!.colors[role]).toBe(resolveThemeToken(SWATCH_TOKENS[role], layer, block));
  });

  it('previews the system entry with the light palette it falls back to', () => {
    expect(getThemeById(SYSTEM_THEME_ID)!.colors).toEqual(getThemeById(LIGHT_THEME_ID)!.colors);
  });

  it.each(palettes.map((theme) => [theme.id, theme] as const))('%s previews an opaque background', (_id, theme) => {
    // The swatch is painted directly on the card, so a translucent background would show
    // the *current* theme through the preview of another one.
    expect(() => hexToRgb(theme.colors.background)).not.toThrow();
    expect(() => hexToRgb(theme.colors.card)).not.toThrow();
  });
});

describe('choice resolution', () => {
  it('resolves "system" from the OS preference', () => {
    expect(resolveTheme(SYSTEM_THEME_ID, true).id).toBe(DARK_THEME_ID);
    expect(resolveTheme(SYSTEM_THEME_ID, false).id).toBe(LIGHT_THEME_ID);
  });

  it.each(palettes.map((theme) => theme.id))('resolves %s to itself, whatever the OS prefers', (id) => {
    expect(resolveTheme(id, true).id).toBe(id);
    expect(resolveTheme(id, false).id).toBe(id);
  });

  it('falls back to the default when an id no longer exists', () => {
    // A theme dropped from the catalogue must not leave a device with no palette.
    expect(resolveTheme('midnight-commander', false).id).toBe(LIGHT_THEME_ID);
    expect(getDefaultTheme().id).toBe(LIGHT_THEME_ID);
  });

  it('reports the base of whatever it resolved', () => {
    expect(appearanceOf(resolveTheme(SYSTEM_THEME_ID, true))).toBe('dark');
    expect(appearanceOf(resolveTheme('whiteboard', true))).toBe('light');
    expect(appearanceOf(resolveTheme('nord', false))).toBe('dark');
  });
});
