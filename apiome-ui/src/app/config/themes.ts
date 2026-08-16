/**
 * Application-wide theme configuration (HIVE-1.2, #5275).
 *
 * A theme is a **token swap** and nothing else: the palette itself lives in
 * `src/app/globals.css` as an `html[data-theme="…"]` block ported from
 * `docs/mockups/assets/hive.css` §4, and `light` is the `:root` default. This module owns
 * only the *catalogue* — which themes exist, what they are called, whether each paints on
 * a light or a dark base, and the swatches the theme picker previews them with.
 *
 * `system` is a choice rather than a palette: it resolves to `light` or `dark` from
 * `prefers-color-scheme`, live (`resolveTheme`). Keeping that resolution here — as a
 * pure function of the id and one boolean — is what lets `ThemeProvider` stay a thin
 * DOM writer and lets both be tested without a browser.
 */

/**
 * Which base a theme paints on.
 *
 * Dark-based themes flip `--color-ink` light so the primary button keeps the highest
 * contrast on the page (`docs/mockups/DESIGN.md` §4.2), and drive the `.dark` class that
 * the not-yet-migrated `dark:` utilities still read.
 */
export type ThemeAppearance = 'light' | 'dark';

/**
 * Preview swatches for one theme.
 *
 * Every value is a copy of the literal the matching design token resolves to under that
 * theme, so a card previews the palette it will actually apply. `tests/theme-catalog.test.ts`
 * re-derives them from `globals.css` and fails if the two drift apart; edit the stylesheet
 * first, never this file alone.
 */
export interface ThemeColors {
  /** `--color-canvas` — the page background. */
  background: string;
  /** `--color-fg` — primary ink. */
  foreground: string;
  /** `--color-ink` — the primary button fill. */
  primary: string;
  /** `--color-ink-fg` — ink on the primary button. */
  primaryForeground: string;
  /** `--color-subtle` — hover fills and secondary buttons. */
  secondary: string;
  /** `--color-fg` — ink on a subtle fill. */
  secondaryForeground: string;
  /** `--color-inset` — wells, code blocks and tracks. */
  muted: string;
  /** `--color-fg-muted` — secondary ink. */
  mutedForeground: string;
  /** `--color-border-strong` — the visible hairline. */
  border: string;
  /** `--color-accent` — links, focus and selection. */
  accent: string;
  /** `--color-accent-fg` — ink on an accent-soft fill. */
  accentForeground: string;
  /** `--color-surface` — cards, tables and dialogs. */
  card: string;
  /** `--color-fg` — ink on a card. */
  cardForeground: string;
  /** `--color-surface` — popovers share the card surface. */
  popover: string;
  /** `--color-fg` — ink in a popover. */
  popoverForeground: string;
  /** `--color-danger` — destructive actions. */
  destructive: string;
  /** `--color-fg-on-accent` — ink on a filled destructive control. */
  destructiveForeground: string;
}

/** One selectable entry in the theme picker. */
export interface Theme {
  /** Stable id, written to `html[data-theme-choice]` and to `localStorage['hive.theme']`. */
  id: string;
  /** Human-readable label. */
  name: string;
  /** One-line description shown under the label. */
  description: string;
  /**
   * The base this theme paints on, or `'system'` for the entry that follows the OS.
   *
   * Replaces the hard-coded dark-theme array the provider used to carry, so adding a
   * theme is a single edit here plus its block in `globals.css`.
   */
  appearance: ThemeAppearance | 'system';
  /** Swatches for the picker; see {@link ThemeColors}. */
  colors: ThemeColors;
}

/** The id of the entry that follows the operating-system preference. */
export const SYSTEM_THEME_ID = 'system';

/** The `:root` default palette — also the fallback whenever an id cannot be resolved. */
export const LIGHT_THEME_ID = 'light';

/** The palette `system` resolves to when the OS asks for dark. */
export const DARK_THEME_ID = 'dark';

export const themes: Theme[] = [
  {
    id: 'system',
    name: 'Follow System',
    description: 'Automatically matches your system light/dark preference',
    appearance: 'system',
    /* Mirrors `light`: the picker draws a dedicated split swatch for this entry, so these
       values are only ever a fallback. */
    colors: {
      background: '#F6F5F2',
      foreground: '#1B1A17',
      primary: '#16265C',
      primaryForeground: '#FFFFFF',
      secondary: '#F3F2EE',
      secondaryForeground: '#1B1A17',
      muted: '#E9E8E3',
      mutedForeground: '#625F59',
      border: 'rgba(28, 25, 20, 0.18)',
      accent: '#1E7FD6',
      accentForeground: '#12539A',
      card: '#FFFFFF',
      cardForeground: '#1B1A17',
      popover: '#FFFFFF',
      popoverForeground: '#1B1A17',
      destructive: '#D6403A',
      destructiveForeground: '#FFFFFF',
    },
  },
  {
    id: 'light',
    name: 'Light',
    description: 'Warm paper canvas with a navy primary — the default palette',
    appearance: 'light',
    colors: {
      background: '#F6F5F2',
      foreground: '#1B1A17',
      primary: '#16265C',
      primaryForeground: '#FFFFFF',
      secondary: '#F3F2EE',
      secondaryForeground: '#1B1A17',
      muted: '#E9E8E3',
      mutedForeground: '#625F59',
      border: 'rgba(28, 25, 20, 0.18)',
      accent: '#1E7FD6',
      accentForeground: '#12539A',
      card: '#FFFFFF',
      cardForeground: '#1B1A17',
      popover: '#FFFFFF',
      popoverForeground: '#1B1A17',
      destructive: '#D6403A',
      destructiveForeground: '#FFFFFF',
    },
  },
  {
    id: 'dark',
    name: 'Dark',
    description: 'Easy on the eyes for low-light environments',
    appearance: 'dark',
    colors: {
      background: '#141311',
      foreground: '#EDEBE6',
      primary: '#EDEBE6',
      primaryForeground: '#16150F',
      secondary: '#23221F',
      secondaryForeground: '#EDEBE6',
      muted: '#2A2825',
      mutedForeground: '#A8A49C',
      border: 'rgba(255, 250, 240, 0.18)',
      accent: '#5AA6F2',
      accentForeground: '#9CCBF8',
      card: '#1B1A18',
      cardForeground: '#EDEBE6',
      popover: '#1B1A18',
      popoverForeground: '#EDEBE6',
      destructive: '#F26A63',
      destructiveForeground: '#FFFFFF',
    },
  },
  {
    id: 'high-contrast',
    name: 'High Contrast',
    description: 'Maximum readability with stark contrasts',
    appearance: 'dark',
    colors: {
      background: '#000000',
      foreground: '#FFFFFF',
      primary: '#FFFFFF',
      primaryForeground: '#000000',
      secondary: '#111111',
      secondaryForeground: '#FFFFFF',
      muted: '#1A1A1A',
      mutedForeground: '#E6E6E6',
      border: '#FFFFFF',
      accent: '#6FB8FF',
      accentForeground: '#BFE0FF',
      card: '#000000',
      cardForeground: '#FFFFFF',
      popover: '#000000',
      popoverForeground: '#FFFFFF',
      destructive: '#FF7B7B',
      destructiveForeground: '#FFFFFF',
    },
  },
  {
    id: 'blueprint',
    name: 'Blueprint',
    description: 'Professional blueprint style with deep navy surfaces',
    appearance: 'dark',
    colors: {
      background: '#0C1E3A',
      foreground: '#E3F2FD',
      primary: '#E3F2FD',
      primaryForeground: '#0C1E3A',
      secondary: '#153054',
      secondaryForeground: '#E3F2FD',
      muted: '#0B1E36',
      mutedForeground: '#A9C4DE',
      border: 'rgba(160, 200, 255, 0.3)',
      accent: '#6FC1FF',
      accentForeground: '#B6E1FF',
      card: '#102645',
      cardForeground: '#E3F2FD',
      popover: '#102645',
      popoverForeground: '#E3F2FD',
      destructive: '#D6403A',
      destructiveForeground: '#FFFFFF',
    },
  },
  {
    id: 'whiteboard',
    name: 'Whiteboard',
    description: 'Minimal and clean like a physical whiteboard',
    appearance: 'light',
    colors: {
      background: '#FAFAFA',
      foreground: '#212121',
      primary: '#111827',
      primaryForeground: '#FFFFFF',
      secondary: '#F3F4F6',
      secondaryForeground: '#212121',
      muted: '#E9EBEF',
      mutedForeground: '#5B6470',
      border: 'rgba(30, 40, 60, 0.2)',
      accent: '#2563EB',
      accentForeground: '#1E40AF',
      card: '#FFFFFF',
      cardForeground: '#212121',
      popover: '#FFFFFF',
      popoverForeground: '#212121',
      destructive: '#D6403A',
      destructiveForeground: '#FFFFFF',
    },
  },
  {
    id: 'solarized',
    name: 'Solarized',
    description: 'Popular theme with carefully chosen colors',
    appearance: 'dark',
    colors: {
      background: '#002B36',
      foreground: '#EEE8D5',
      primary: '#EEE8D5',
      primaryForeground: '#002B36',
      secondary: '#0A3E4C',
      secondaryForeground: '#EEE8D5',
      muted: '#002530',
      mutedForeground: '#93A1A1',
      border: 'rgba(147, 161, 161, 0.35)',
      accent: '#2AA198',
      accentForeground: '#6FD3CB',
      card: '#073642',
      cardForeground: '#EEE8D5',
      popover: '#073642',
      popoverForeground: '#EEE8D5',
      destructive: '#DC322F',
      destructiveForeground: '#FFFFFF',
    },
  },
  {
    id: 'nord',
    name: 'Nord',
    description: 'Arctic, north-bluish color palette',
    appearance: 'dark',
    colors: {
      background: '#2E3440',
      foreground: '#ECEFF4',
      primary: '#ECEFF4',
      primaryForeground: '#2E3440',
      secondary: '#434C5E',
      secondaryForeground: '#ECEFF4',
      muted: '#2A2F3A',
      mutedForeground: '#C7CFDC',
      border: 'rgba(216, 222, 233, 0.26)',
      accent: '#88C0D0',
      accentForeground: '#B6DEE9',
      card: '#3B4252',
      cardForeground: '#ECEFF4',
      popover: '#3B4252',
      popoverForeground: '#ECEFF4',
      destructive: '#BF616A',
      destructiveForeground: '#FFFFFF',
    },
  },
  {
    id: 'darcula',
    name: 'Darcula',
    description: 'IntelliJ-inspired dark theme',
    appearance: 'dark',
    colors: {
      background: '#2B2B2B',
      foreground: '#E8E8E8',
      primary: '#E8E8E8',
      primaryForeground: '#2B2B2B',
      secondary: '#3A3D3F',
      secondaryForeground: '#E8E8E8',
      muted: '#262829',
      mutedForeground: '#B9BCC0',
      border: 'rgba(255, 255, 255, 0.22)',
      accent: '#6897BB',
      accentForeground: '#A9C7E0',
      card: '#313335',
      cardForeground: '#E8E8E8',
      popover: '#313335',
      popoverForeground: '#E8E8E8',
      destructive: '#FF6B68',
      destructiveForeground: '#FFFFFF',
    },
  },
];

/**
 * Look a theme up by id.
 *
 * @param id Theme id, e.g. `nord`.
 * @returns The matching theme, or `undefined` when no theme carries that id.
 */
export const getThemeById = (id: string): Theme | undefined => {
  return themes.find((theme) => theme.id === id);
};

/**
 * The theme used when nothing is stored and when a stored id no longer exists.
 *
 * @returns The `light` entry — the palette `:root` already paints, so falling back to it
 *          never leaves the DOM disagreeing with the stylesheet.
 */
export const getDefaultTheme = (): Theme => {
  return getThemeById(LIGHT_THEME_ID) ?? themes[0];
};

/**
 * Resolve a *choice* to the theme actually painted.
 *
 * Every id but `system` resolves to itself; `system` resolves to `dark` or `light`
 * according to the current OS preference, which is why the caller passes it in rather
 * than the function reading `matchMedia` — the resolution stays pure and testable.
 *
 * @param choiceId The user's stored choice, `system` included. Unknown ids fall back to
 *                 {@link getDefaultTheme}.
 * @param prefersDark Whether `(prefers-color-scheme: dark)` currently matches.
 * @returns The theme to paint.
 */
export const resolveTheme = (choiceId: string, prefersDark: boolean): Theme => {
  if (choiceId === SYSTEM_THEME_ID) {
    return getThemeById(prefersDark ? DARK_THEME_ID : LIGHT_THEME_ID) ?? getDefaultTheme();
  }
  return getThemeById(choiceId) ?? getDefaultTheme();
};

/**
 * The base a resolved theme paints on.
 *
 * @param theme A resolved theme — never the `system` entry, which has no palette of its own.
 * @returns `'dark'` for the dark-based palettes, `'light'` otherwise. A `system` entry that
 *          reaches this function is reported as `'light'`, matching {@link getDefaultTheme}.
 */
export const appearanceOf = (theme: Theme): ThemeAppearance => {
  return theme.appearance === 'dark' ? 'dark' : 'light';
};
