'use client';

import React, { useCallback, useRef } from 'react';
import type { Theme } from '../../../config/themes';
import {
  DARK_THEME_ID,
  LIGHT_THEME_ID,
  SYSTEM_THEME_ID,
  getThemeById,
} from '../../../config/themes';

/**
 * The theme picker inside the preferences pane (HIVE-1.4, #5277; `DESIGN.md` §4.1 item 1).
 *
 * A real radiogroup rather than a grid of buttons: one tab stop for the whole set, arrow
 * keys move between cards, and selection follows focus — which is what the WAI-ARIA radio
 * pattern specifies and what the ticket asks for. Choosing applies immediately; there is
 * no Save, so "selected" and "applied" are never out of step.
 *
 * The card previews the palette it applies, using the swatches in `config/themes.ts` —
 * values re-derived from `globals.css` by `tests/theme-catalog.test.ts`, so a card can
 * never advertise a colour the theme does not paint. `system` has no palette of its own
 * and gets the split light/dark preview the mockups use.
 */

/** Keys that move the selection within the group. */
const NAVIGATION_KEYS = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];

export interface ThemeRadioGroupProps {
  /** Every selectable theme, in picker order. */
  themes: readonly Theme[];
  /** The id of the current *choice* — `system` when following the OS, never the resolved id. */
  value: string;
  /**
   * What "follow system" currently resolves to, when that is the choice.
   *
   * Omitted while a fixed theme is selected: nothing is following the OS then, and naming
   * the *active* palette on the `system` card would claim the OS had chosen it.
   */
  systemResolvedName?: string;
  /** Select a theme. Applies immediately. */
  onSelect: (themeId: string) => void;
}

export default function ThemeRadioGroup({
  themes,
  value,
  systemResolvedName,
  onSelect,
}: ThemeRadioGroupProps) {
  /** The card buttons, indexed as `themes` is, so a key press can focus its neighbour. */
  const cardRefs = useRef<Array<HTMLButtonElement | null>>([]);

  /**
   * Move selection with the keyboard.
   *
   * Selection follows focus (the radio pattern): the neighbour is selected *and* focused,
   * so a reader arrowing through the group sees each theme applied as they land on it.
   * The group wraps, and `Home`/`End` jump to the ends.
   *
   * @param event The keydown on a card.
   * @param index The card's position in {@link ThemeRadioGroupProps.themes}.
   */
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
      if (!NAVIGATION_KEYS.includes(event.key)) return;
      event.preventDefault();

      const last = themes.length - 1;
      let next = index;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = index === last ? 0 : index + 1;
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = index === 0 ? last : index - 1;
      else if (event.key === 'Home') next = 0;
      else next = last;

      onSelect(themes[next].id);
      cardRefs.current[next]?.focus();
    },
    [onSelect, themes],
  );

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      data-testid="preferences-theme-group"
      className="grid grid-cols-2 gap-2 sm:grid-cols-3"
    >
      {themes.map((theme, index) => {
        const selected = theme.id === value;

        return (
          <button
            key={theme.id}
            ref={(node) => {
              cardRefs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            /* Roving tabindex: the group is one stop, and Tab lands on the current choice. */
            tabIndex={selected ? 0 : -1}
            data-theme-card={theme.id}
            onClick={() => onSelect(theme.id)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            className={`cursor-pointer rounded-md border p-2 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
              selected
                ? 'border-accent ring-1 ring-accent'
                : 'border-border hover:border-border-strong'
            }`}
          >
            <ThemePreview theme={theme} />
            <span className="mt-2 block text-sm font-semibold text-fg">{theme.name}</span>
            <span className="mt-0.5 block text-xs leading-snug text-fg-subtle">
              {theme.description}
            </span>
            {theme.id === SYSTEM_THEME_ID && systemResolvedName && (
              <span className="mt-1 block text-xs font-medium text-fg-muted">
                Currently: {systemResolvedName}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The swatch above a theme card: canvas, the surface that sits on it, and the ink and
 * accent that sit on the surface — the four values the mockups preview a theme with.
 *
 * `system` paints no palette of its own, so it previews the two it chooses between.
 *
 * @param props.theme The theme being previewed.
 */
function ThemePreview({ theme }: { theme: Theme }) {
  if (theme.id === SYSTEM_THEME_ID) {
    // The two palettes it chooses between, read from the catalogue rather than restated —
    // `tests/theme-catalog.test.ts` keeps those in step with `globals.css`.
    const light = getThemeById(LIGHT_THEME_ID) ?? theme;
    const dark = getThemeById(DARK_THEME_ID) ?? theme;

    return (
      <span
        aria-hidden
        className="grid h-12 w-full grid-cols-2 overflow-hidden rounded-sm ring-1 ring-inset ring-border"
      >
        <span style={{ background: light.colors.background }} />
        <span style={{ background: dark.colors.background }} />
      </span>
    );
  }

  return (
    <span
      aria-hidden
      className="block h-12 w-full overflow-hidden rounded-sm px-2 pt-2 ring-1 ring-inset ring-border"
      style={{ background: theme.colors.background }}
    >
      <span
        className="flex h-full items-start gap-1 rounded-t-sm p-1.5"
        style={{ background: theme.colors.card }}
      >
        <span
          className="block h-1.5 w-2/5 rounded-full"
          style={{ background: theme.colors.foreground }}
        />
        <span
          className="block h-1.5 w-1/5 rounded-full"
          style={{ background: theme.colors.accent }}
        />
      </span>
    </span>
  );
}
