'use client';

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useTheme as useNextTheme } from 'next-themes';
import {
  Theme,
  themes,
  appearanceOf,
  getDefaultTheme,
  getThemeById,
  resolveTheme,
  SYSTEM_THEME_ID,
} from '../config/themes';
import { readStoredThemeChoice, storeThemeChoice } from '../config/preferences';

/**
 * Theme provider (HIVE-1.2, #5275).
 *
 * A theme is a token swap in `globals.css`, so all this provider does is state *which*
 * swap applies. It writes three things to `<html>` and nothing else:
 *
 * | Attribute / property | Value | Read by |
 * | --- | --- | --- |
 * | `data-theme` | the **resolved** theme id — never `system` | the `html[data-theme="…"]` blocks |
 * | `data-theme-choice` | the **raw** choice, `system` included | the picker, and anything that needs to know the OS is in charge |
 * | `style.color-scheme` | `light` \| `dark` | the browser, for scrollbars and built-in controls |
 *
 * It deliberately does *not* write `body.style`, and no longer toggles per-theme classes:
 * both belonged to the pre-Hive system where a theme was two colours applied by hand.
 * next-themes keeps owning the `.dark` class, which the components that have not yet
 * adopted tokens still read through their `dark:` utilities.
 *
 * Since HIVE-1.3 the same three values are written once more, earlier: the blocking
 * preferences script in `<head>` resolves the stored choice before first paint, so this
 * provider re-states rather than introduces them. Both read the storage rules from
 * `config/preferences`, which is what keeps them from disagreeing.
 */

/** The query "follow system" resolves against. */
const DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)';

interface ThemeContextType {
  /** What the user chose — the `system` entry when following the OS. */
  currentTheme: Theme;
  /** What is actually painted: `currentTheme`, or light/dark while following the OS. */
  resolvedTheme: Theme;
  /** Select a theme by id; persists, applies immediately, and re-resolves `system` live. */
  setTheme: (themeId: string) => void;
  /** Every selectable theme, in picker order. */
  availableThemes: Theme[];
  /** Whether the choice is "follow system". */
  isSystemTheme: boolean;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

/**
 * Whether the OS currently asks for a dark palette.
 *
 * @returns `true` when `(prefers-color-scheme: dark)` matches; `false` during SSR, where
 *          there is no preference to read and `light` is the `:root` default.
 */
function prefersDarkNow(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(DARK_MEDIA_QUERY).matches;
}

/**
 * The theme choice to start from on this device.
 *
 * The keys, their order and the write-back live in `config/preferences`, because the
 * blocking boot script of HIVE-1.3 resolves the very same choice before first paint and
 * the two must not disagree. "No preference at all" means "follow system", the app
 * default.
 *
 * @returns The stored choice, or the `system` entry when nothing valid is stored.
 */
function readStoredChoice(): Theme {
  const systemTheme = getThemeById(SYSTEM_THEME_ID) ?? getDefaultTheme();
  const stored = readStoredThemeChoice();
  return (stored && getThemeById(stored)) || systemTheme;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Server and first client render agree on the app default (follow system); the mount
  // effect below reconciles with what this device actually stored.
  const initialChoice = getThemeById(SYSTEM_THEME_ID) ?? getDefaultTheme();
  const [currentTheme, setCurrentTheme] = useState<Theme>(initialChoice);
  const [resolvedTheme, setResolvedTheme] = useState<Theme>(() => resolveTheme(initialChoice.id, false));
  const { setTheme: setNextTheme } = useNextTheme();

  // The media-query listener is registered once per choice; this keeps the handler
  // reading the current choice without re-subscribing on every render.
  const choiceRef = useRef<Theme>(initialChoice);

  /**
   * Resolve a choice and write it to `<html>`.
   *
   * @param choice The raw choice, `system` included.
   * @returns The theme that ended up painted.
   */
  const applyTheme = useCallback(
    (choice: Theme): Theme => {
      const resolved = resolveTheme(choice.id, prefersDarkNow());
      const html = document.documentElement;

      html.setAttribute('data-theme', resolved.id);
      html.setAttribute('data-theme-choice', choice.id);
      // Tells the browser which built-ins (scrollbars, form controls, spell-check
      // underlines) to paint dark. The stylesheet declares it too, for the pre-hydration
      // pass; setting it here keeps the two in step once a choice is made.
      html.style.colorScheme = appearanceOf(resolved);

      // next-themes still drives `.dark` for the `dark:` utilities that have not yet been
      // migrated to tokens. Following the OS is delegated wholesale so its own listener
      // keeps the class in step with the palette this provider resolves.
      setNextTheme(choice.id === SYSTEM_THEME_ID ? SYSTEM_THEME_ID : appearanceOf(resolved));

      choiceRef.current = choice;
      setCurrentTheme(choice);
      setResolvedTheme(resolved);
      return resolved;
    },
    [setNextTheme],
  );

  // Apply the stored choice once, after hydration.
  useEffect(() => {
    const choice = readStoredChoice();
    applyTheme(choice);
    storeThemeChoice(choice.id);
    // `applyTheme` is stable for the life of the provider; re-running this effect would
    // undo a theme the user picked in the meantime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // "Follow system" re-resolves live: no reload, and no listener while a fixed theme is
  // selected.
  const isSystemTheme = currentTheme.id === SYSTEM_THEME_ID;
  useEffect(() => {
    if (!isSystemTheme || typeof window === 'undefined') return;

    const media = window.matchMedia(DARK_MEDIA_QUERY);
    const handleChange = () => applyTheme(choiceRef.current);

    media.addEventListener('change', handleChange);
    return () => media.removeEventListener('change', handleChange);
  }, [isSystemTheme, applyTheme]);

  /**
   * Select a theme.
   *
   * @param themeId A theme id, `system` included. Unknown ids are ignored so a stale
   *                deep link cannot blank the palette.
   */
  const setTheme = useCallback(
    (themeId: string) => {
      const choice = getThemeById(themeId);
      if (!choice) return;

      applyTheme(choice);
      storeThemeChoice(choice.id);
    },
    [applyTheme],
  );

  return (
    <ThemeContext.Provider
      value={{ currentTheme, resolvedTheme, setTheme, availableThemes: themes, isSystemTheme }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

/**
 * Read the current theme state.
 *
 * @returns The theme context.
 * @throws If called outside a `ThemeProvider`.
 */
export function useTheme() {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
