'use client';

/**
 * The Hive palette, as a Monaco theme (HIVE-5.7, #5310).
 *
 * Authority: `docs/mockups/assets/hive.css` §16 (`.code`, and the five `.c-*` syntax
 * classes), `docs/mockups/DESIGN.md` §3.1.
 *
 * ### The problem this solves
 *
 * Every one of the ~19 Monaco editors in the app is hard-coded to `vs-dark`, a handful to
 * `isDark ? 'vs-dark' : 'light'`. That is a dark grey pane with VS Code's blues and reds in
 * it, dropped into a page painted in warm paper and honey — and it stays that grey pane in
 * all nine Hive themes, because `vs-dark` knows nothing about `data-theme`. The custom-rules
 * editor is the first surface where the editor *is* the screen rather than a preview inside
 * one, which is why HIVE-5.7 is where this gets built; 6.4 (the spec editor) and 8.3 (the
 * export studio) inherit it rather than each doing it again.
 *
 * ### Why it is read at runtime rather than written down
 *
 * Monaco measures and paints in its own canvas: its theme is a plain object of **literal
 * colours**, and it cannot read a CSS custom property. A table of nine themes × forty
 * colours transcribed into TypeScript would be a second palette to keep in step with
 * `globals.css`, and the first token swap would silently desynchronise it.
 *
 * So the palette is *resolved from the live document* instead — `getComputedStyle` on
 * `<html>` returns the substituted value of each token under whatever theme is painted, and
 * that is what the theme is built from. One consequence worth stating: this only works in a
 * browser with the stylesheet compiled. Under jsdom every token reads empty, so every
 * lookup falls back to {@link LIGHT_FALLBACK_PALETTE} — the light defaults, copied from the
 * token layer — and the editor still gets a valid theme rather than a crash.
 *
 * ### Following the theme
 *
 * `ThemeProvider` writes `html[data-theme]`, and "follow system" resolves through
 * `prefers-color-scheme`. {@link useHiveMonacoTheme} watches both — a `MutationObserver` on
 * the attribute and a media-query listener — and re-defines the theme under the same id, so
 * a live theme switch repaints the editor without remounting it. The hook deliberately does
 * **not** use `useTheme()`: that hook throws outside a `ThemeProvider`, and an editor
 * rendered in a test, a portal or a route that never mounts the provider must still paint.
 */

import * as React from 'react';

// ---------------------------------------------------------------------------------------
// The token set
// ---------------------------------------------------------------------------------------

/**
 * The design tokens an editor is painted from.
 *
 * Deliberately small. An editor is a well with text in it: a surface, ink, a hairline, the
 * five syntax roles the mockup's `.c-*` classes name, and the three status hues its markers
 * use. Anything more would be a second design language living in this file.
 */
export interface HiveEditorPalette {
  /** `--bg-inset` — the well the code sits in, as `.code` paints it. */
  background: string;
  /** `--fg` — ordinary code ink. */
  foreground: string;
  /** `--fg-faint` — line numbers, which are chrome rather than text. */
  lineNumber: string;
  /** `--fg-muted` — the active line's number, and punctuation. */
  muted: string;
  /** `--fg-subtle` — comments (`.c-c`), the one place §3.1 allows the faintest ink. */
  subtle: string;
  /** `--border-strong` — the hairline around a floating widget. */
  border: string;
  /** `--bg-surface` — the ground of a suggestion or hover widget, which floats. */
  surface: string;
  /** `--accent` — the cursor, the selection, and YAML anchors (`.c-n`). */
  accent: string;
  /** `--warn` — a YAML key (`.c-k`), and a warning marker. */
  warn: string;
  /** `--ok` — a string value (`.c-s`). */
  ok: string;
  /** `--violet` — a number or a literal (`.c-p`). */
  violet: string;
  /** `--danger` — an error marker. */
  danger: string;
}

/** Which `--token` each palette entry reads. */
const PALETTE_TOKENS: Readonly<Record<keyof HiveEditorPalette, string>> = {
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

/**
 * The light palette, spelled out.
 *
 * The only literal colours in this module, and they are a *copy* of the `@theme static`
 * block's light defaults rather than a second opinion about them. They are reached in two
 * situations: a document with no compiled stylesheet (jsdom), and a token that a future
 * theme somehow leaves unset. `tests/monaco-hive-theme.test.ts` re-derives them from
 * `globals.css` and fails if the two drift apart — the same guard `config/themes.ts` uses
 * for its preview swatches.
 */
export const LIGHT_FALLBACK_PALETTE: Readonly<HiveEditorPalette> = {
  background: '#E9E8E3',
  foreground: '#1B1A17',
  lineNumber: '#B8B4AC',
  muted: '#625F59',
  subtle: '#8F8B84',
  border: 'rgba(28, 25, 20, 0.18)',
  surface: '#FFFFFF',
  accent: '#1E7FD6',
  warn: '#C77700',
  ok: '#0E8A5F',
  violet: '#6D4FD6',
  danger: '#D6403A',
};

// ---------------------------------------------------------------------------------------
// Colour arithmetic
// ---------------------------------------------------------------------------------------

/** One colour, resolved to channels. `a` is 0–1. */
interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** `#RGB` / `#RGBA` / `#RRGGBB` / `#RRGGBBAA`. */
const HEX_RE = /^#([0-9a-f]{3,8})$/i;

/** `rgb(…)` / `rgba(…)`, comma- or space-separated, with an optional `/ alpha`. */
const RGB_RE = /^rgba?\(([^)]+)\)$/i;

/**
 * Parse a CSS colour into channels.
 *
 * Handles the two spellings the token layer actually uses — hex and `rgb()`/`rgba()` — and
 * nothing else. A token written as `color-mix()` or `oklch()` would return `null` here and
 * fall back to the light default, which is why the tokens this module reads are the plain
 * ones. `tests/monaco-hive-theme.test.ts` asserts that every token in
 * {@link PALETTE_TOKENS} is still spelled in a form this understands.
 *
 * @param value The CSS colour, as `getComputedStyle` returns it.
 * @returns Its channels, or `null` when the spelling is not one of the two.
 */
export function parseCssColor(value: string): Rgba | null {
  const text = value.trim();
  if (!text) return null;

  const hex = HEX_RE.exec(text);
  if (hex) {
    const digits = hex[1];
    const expand = (pair: string) => parseInt(pair.length === 1 ? pair + pair : pair, 16);
    if (digits.length === 3 || digits.length === 4) {
      return {
        r: expand(digits[0]),
        g: expand(digits[1]),
        b: expand(digits[2]),
        a: digits.length === 4 ? expand(digits[3]) / 255 : 1,
      };
    }
    if (digits.length === 6 || digits.length === 8) {
      return {
        r: parseInt(digits.slice(0, 2), 16),
        g: parseInt(digits.slice(2, 4), 16),
        b: parseInt(digits.slice(4, 6), 16),
        a: digits.length === 8 ? parseInt(digits.slice(6, 8), 16) / 255 : 1,
      };
    }
    return null;
  }

  const rgb = RGB_RE.exec(text);
  if (!rgb) return null;
  const parts = rgb[1]
    .replace(/\//g, ' ')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((part) => (part.endsWith('%') ? Number(part.slice(0, -1)) / 100 : Number(part)));
  if (parts.length < 3 || parts.some(Number.isNaN)) return null;
  return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
}

/** One channel as two hex digits, clamped and rounded. */
function channel(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value)))
    .toString(16)
    .padStart(2, '0');
}

/**
 * A colour in the `#RRGGBB` / `#RRGGBBAA` spelling Monaco requires.
 *
 * Monaco parses its theme colours itself and accepts only hex, so every value handed to it
 * goes through here — including the translucent ones, which become the eight-digit form
 * rather than being flattened onto a guess about what is behind them.
 *
 * @param value The CSS colour.
 * @param alpha An opacity to apply on top of the colour's own, 0–1. Omitted keeps it.
 * @param fallback What to return when `value` cannot be parsed.
 * @returns The hex spelling.
 */
export function toMonacoColor(value: string, alpha?: number, fallback = '#000000'): string {
  const parsed = parseCssColor(value);
  if (!parsed) return alpha === undefined ? fallback : toMonacoColor(fallback, alpha);
  const opacity = alpha === undefined ? parsed.a : parsed.a * alpha;
  const base = `#${channel(parsed.r)}${channel(parsed.g)}${channel(parsed.b)}`;
  return opacity >= 1 ? base : `${base}${channel(opacity * 255)}`;
}

/**
 * Whether a colour is dark enough that ink on it must be light.
 *
 * Relative luminance, the WCAG definition. Used to choose Monaco's `base` — `vs` or
 * `vs-dark` — which decides the colours the theme does *not* override (widget shadows,
 * scrollbar arrows, find-match rings). Deriving it from the resolved surface rather than
 * from the theme catalogue is what lets this module stay independent of `ThemeProvider`.
 *
 * @param value The CSS colour of the surface.
 * @returns True when the surface is dark.
 */
export function isDarkSurface(value: string): boolean {
  const parsed = parseCssColor(value);
  if (!parsed) return false;
  const linear = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const luminance =
    0.2126 * linear(parsed.r) + 0.7152 * linear(parsed.g) + 0.0722 * linear(parsed.b);
  return luminance < 0.4;
}

// ---------------------------------------------------------------------------------------
// Reading the document
// ---------------------------------------------------------------------------------------

/**
 * Resolve the palette from a live document.
 *
 * @param root The element the tokens are declared on — `<html>` in the app.
 * @returns Every entry, with the light default standing in for anything unreadable.
 */
export function readHiveEditorPalette(root?: Element | null): HiveEditorPalette {
  const element =
    root ?? (typeof document === 'undefined' ? null : document.documentElement);
  if (!element || typeof window === 'undefined' || !window.getComputedStyle) {
    return { ...LIGHT_FALLBACK_PALETTE };
  }

  const computed = window.getComputedStyle(element);
  const palette = { ...LIGHT_FALLBACK_PALETTE } as HiveEditorPalette;
  for (const [key, token] of Object.entries(PALETTE_TOKENS)) {
    const raw = computed.getPropertyValue(token).trim();
    // Kept only when it is a colour this module can spell for Monaco; an unparseable value
    // leaves the light default in place rather than reaching Monaco as `''`, which it
    // rejects with an exception that would take the whole editor down.
    if (raw && parseCssColor(raw)) palette[key as keyof HiveEditorPalette] = raw;
  }
  return palette;
}

// ---------------------------------------------------------------------------------------
// The theme
// ---------------------------------------------------------------------------------------

/**
 * The one theme id every Hive editor asks for.
 *
 * A single id, redefined in place on each theme change, rather than one id per theme:
 * Monaco's `defineTheme` overwrites by name and `setTheme` re-reads it, so redefining is
 * how a live swap repaints, and one id means a caller never has to know which of the nine
 * themes is painted.
 */
export const HIVE_MONACO_THEME_ID = 'hive';

/** A syntax rule, in the shape `monaco.editor.defineTheme` takes. */
interface ThemeRule {
  token: string;
  foreground?: string;
  fontStyle?: string;
}

/** The subset of the Monaco namespace this module calls. */
export interface MonacoThemeHost {
  editor: {
    defineTheme: (name: string, data: unknown) => void;
    setTheme: (name: string) => void;
  };
}

/**
 * Build the theme object for one palette.
 *
 * The five syntax roles are the mockup's own, mapped one for one:
 * `.c-k` → `--warn` (a YAML key), `.c-s` → `--ok` (a string), `.c-n` → `--accent` (a name
 * or anchor), `.c-p` → `--violet` (a number or literal), `.c-c` → `--fg-subtle`, italic.
 * They are stated for the token names Monaco's YAML, JSON and JavaScript tokenizers emit,
 * so one theme covers the three languages the app's editors actually open.
 *
 * @param palette The resolved tokens.
 * @returns The theme data, ready for `defineTheme`.
 */
export function buildHiveMonacoTheme(palette: HiveEditorPalette) {
  const dark = isDarkSurface(palette.background);
  const hex = (value: string, alpha?: number) => toMonacoColor(value, alpha, palette.foreground);

  const rules: ThemeRule[] = [
    { token: '', foreground: hex(palette.foreground) },
    { token: 'comment', foreground: hex(palette.subtle), fontStyle: 'italic' },
    { token: 'string', foreground: hex(palette.ok) },
    { token: 'string.yaml', foreground: hex(palette.ok) },
    { token: 'string.value.json', foreground: hex(palette.ok) },
    { token: 'number', foreground: hex(palette.violet) },
    { token: 'constant', foreground: hex(palette.violet) },
    { token: 'keyword', foreground: hex(palette.violet) },
    // A YAML mapping key, a JSON property and an XML attribute are the same thing to a
    // reader — the name of the value beside it — so all three take `.c-k`'s honey.
    { token: 'type', foreground: hex(palette.warn) },
    { token: 'type.yaml', foreground: hex(palette.warn) },
    { token: 'string.key.json', foreground: hex(palette.warn) },
    { token: 'attribute.name', foreground: hex(palette.warn) },
    { token: 'tag', foreground: hex(palette.accent) },
    { token: 'variable', foreground: hex(palette.accent) },
    { token: 'identifier', foreground: hex(palette.foreground) },
    { token: 'delimiter', foreground: hex(palette.muted) },
    { token: 'operators', foreground: hex(palette.muted) },
    { token: 'invalid', foreground: hex(palette.danger) },
  ];

  return {
    // The base decides everything this theme does not name — widget shadows, the scrollbar
    // arrows, the find-match ring. Chosen from the resolved surface rather than from the
    // theme id, so a palette that is dark for any reason gets the dark base.
    base: dark ? 'vs-dark' : 'vs',
    inherit: true,
    rules,
    colors: {
      'editor.background': hex(palette.background),
      'editor.foreground': hex(palette.foreground),
      'editorLineNumber.foreground': hex(palette.lineNumber),
      'editorLineNumber.activeForeground': hex(palette.muted),
      'editorCursor.foreground': hex(palette.accent),
      'editor.selectionBackground': hex(palette.accent, 0.24),
      'editor.inactiveSelectionBackground': hex(palette.accent, 0.12),
      'editor.selectionHighlightBackground': hex(palette.accent, 0.12),
      'editor.wordHighlightBackground': hex(palette.accent, 0.12),
      'editor.findMatchBackground': hex(palette.warn, 0.34),
      'editor.findMatchHighlightBackground': hex(palette.warn, 0.18),
      // The current line, and the marks in the gutter beside it. `--fg` at a few percent
      // rather than a named grey: it tints with the palette instead of turning into a
      // smudge on the six dark themes.
      'editor.lineHighlightBackground': hex(palette.foreground, 0.05),
      'editorIndentGuide.background': hex(palette.foreground, 0.08),
      'editorIndentGuide.activeBackground': hex(palette.foreground, 0.18),
      'editorWhitespace.foreground': hex(palette.foreground, 0.16),
      'editorGutter.background': hex(palette.background),
      'editorError.foreground': hex(palette.danger),
      'editorWarning.foreground': hex(palette.warn),
      'editorInfo.foreground': hex(palette.accent),
      'editorOverviewRuler.border': hex(palette.border),
      'editorOverviewRuler.errorForeground': hex(palette.danger),
      'editorOverviewRuler.warningForeground': hex(palette.warn),
      'editorOverviewRuler.infoForeground': hex(palette.accent),
      // Widgets float *above* the well, so they take the surface a card takes rather than
      // the inset the code sits in — the same relationship a dialog has to a page.
      'editorWidget.background': hex(palette.surface),
      'editorWidget.foreground': hex(palette.foreground),
      'editorWidget.border': hex(palette.border),
      'editorSuggestWidget.background': hex(palette.surface),
      'editorSuggestWidget.foreground': hex(palette.foreground),
      'editorSuggestWidget.border': hex(palette.border),
      'editorSuggestWidget.selectedBackground': hex(palette.accent, 0.16),
      'editorSuggestWidget.highlightForeground': hex(palette.accent),
      'editorHoverWidget.background': hex(palette.surface),
      'editorHoverWidget.border': hex(palette.border),
      'input.background': hex(palette.surface),
      'input.foreground': hex(palette.foreground),
      'input.border': hex(palette.border),
      'scrollbarSlider.background': hex(palette.foreground, 0.16),
      'scrollbarSlider.hoverBackground': hex(palette.foreground, 0.24),
      'scrollbarSlider.activeBackground': hex(palette.foreground, 0.32),
      'minimap.background': hex(palette.background),
    },
  };
}

/**
 * Define the Hive theme on a Monaco namespace and make it current.
 *
 * Safe to call repeatedly and from more than one editor: `defineTheme` overwrites by name,
 * and re-applying the same id is how a theme change repaints an editor that is already
 * mounted.
 *
 * @param monaco The Monaco namespace, as `beforeMount` / `onMount` hands it over.
 * @param root The element the tokens are declared on. Defaults to `<html>`.
 * @returns True when the theme was applied; false when Monaco rejected it.
 */
export function applyHiveMonacoTheme(monaco: MonacoThemeHost, root?: Element | null): boolean {
  try {
    monaco.editor.defineTheme(HIVE_MONACO_THEME_ID, buildHiveMonacoTheme(readHiveEditorPalette(root)));
    monaco.editor.setTheme(HIVE_MONACO_THEME_ID);
    return true;
  } catch {
    // A malformed colour is the only way this throws, and an editor that paints in the
    // base theme is better than a page that does not render. The fallbacks above make it
    // very nearly unreachable; the guard is here so "very nearly" is not load-bearing.
    return false;
  }
}

// ---------------------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------------------

/** What {@link useHiveMonacoTheme} hands an editor. */
export interface HiveMonacoTheme {
  /** Pass as `<Editor theme={…}>`. */
  theme: string;
  /**
   * Pass as `<Editor beforeMount={…}>`.
   *
   * `beforeMount` rather than `onMount`: the wrapper calls `setTheme` with the `theme` prop
   * as it creates the editor, and a theme that is not defined by then paints in `vs` for a
   * frame before the first repaint catches up.
   */
  beforeMount: (monaco: MonacoThemeHost) => void;
}

/** `matchMedia` query "follow system" resolves through. */
const DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)';

/**
 * Keep an editor painted in the current Hive theme.
 *
 * ```tsx
 * const monacoTheme = useHiveMonacoTheme();
 * <Editor language="yaml" theme={monacoTheme.theme} beforeMount={monacoTheme.beforeMount} />
 * ```
 *
 * @returns The theme id to pass, and the `beforeMount` handler that defines it.
 */
export function useHiveMonacoTheme(): HiveMonacoTheme {
  const monacoRef = React.useRef<MonacoThemeHost | null>(null);

  const repaint = React.useCallback(() => {
    if (monacoRef.current) applyHiveMonacoTheme(monacoRef.current);
  }, []);

  const beforeMount = React.useCallback(
    (monaco: MonacoThemeHost) => {
      monacoRef.current = monaco;
      repaint();
    },
    [repaint]
  );

  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    // Two sources, because a theme changes in two ways: the provider writes `data-theme`
    // when a theme is chosen, and the OS changes underneath "follow system" without any
    // attribute moving at all.
    const observer = new MutationObserver(repaint);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });

    const media = window.matchMedia?.(DARK_MEDIA_QUERY);
    media?.addEventListener?.('change', repaint);

    return () => {
      observer.disconnect();
      media?.removeEventListener?.('change', repaint);
    };
  }, [repaint]);

  return { theme: HIVE_MONACO_THEME_ID, beforeMount };
}
