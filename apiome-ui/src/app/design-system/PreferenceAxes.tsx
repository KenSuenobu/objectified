'use client';

import * as React from 'react';
import { DENSITIES, FONT_SCALES } from '@/app/config/preferences';
import { SYSTEM_THEME_ID, appearanceOf, themes } from '@/app/config/themes';

/**
 * The theme / density / font-scale switchers every design-system route carries.
 *
 * The cross-cutting acceptance criteria of the redesign ask the same question of every
 * surface — *does it work in all nine themes, both densities and all six font scales?* — so
 * every gallery route needs the same three selects, writing to the same three attributes.
 * Extracted here when HIVE-3.5 (#5291) added its second gallery, rather than copied: a
 * theme added to `config/themes` has to reach both routes, and the `.dark` companion below
 * is exactly the sort of detail a copy loses.
 *
 * The axes are derived from the catalogues the preferences pane reads (HIVE-1.2/1.3), so a
 * palette or scale added there shows up here for free.
 */

/** One preference axis: an attribute on `<html>`, and the values it accepts. */
interface PreferenceAxis {
  /** The `<html>` attribute the preferences pane writes. */
  attribute: string;
  /** What the reader sees beside the select. */
  label: string;
  /** The value the app boots at, so the select opens on the truth. */
  initial: string;
  /** The choices. */
  options: readonly { value: string; label: string }[];
}

/**
 * The three axes.
 *
 * `system` is excluded from the theme list: it is a *choice*, not a palette, and
 * `ThemeProvider` writes the resolved id to `data-theme`. Writing `system` there would
 * match no block at all.
 */
export const PREFERENCE_AXES: readonly PreferenceAxis[] = [
  {
    attribute: 'data-theme',
    label: 'Theme',
    initial: 'light',
    options: themes
      .filter((theme) => theme.id !== SYSTEM_THEME_ID)
      .map((theme) => ({ value: theme.id, label: theme.name })),
  },
  {
    attribute: 'data-density',
    label: 'Density',
    initial: 'comfortable',
    options: DENSITIES.map((entry) => ({ value: entry.id, label: entry.label })),
  },
  {
    attribute: 'data-font-scale',
    label: 'Font scale',
    initial: 'md',
    options: FONT_SCALES.map((scale) => ({ value: scale.id, label: scale.label })),
  },
];

/**
 * Write a preference axis onto `<html>`, the same place the preferences pane writes it.
 *
 * @param attribute The axis attribute, e.g. `data-theme`.
 * @param value The chosen value.
 */
export function setPreferenceAxis(attribute: string, value: string): void {
  document.documentElement.setAttribute(attribute, value);

  // `ThemeProvider` hands next-themes the resolved *appearance*, which is what puts `.dark`
  // on `<html>` for every dark-based palette. A gallery route has no provider, so it does
  // the same thing by hand — otherwise the rules keyed on `.dark` (the format pill's
  // dark-base settling, and every `dark:` utility not yet migrated) would be missing here
  // and only here, which is the one place a reviewer looks to catch them.
  if (attribute === 'data-theme') {
    const theme = themes.find((entry) => entry.id === value);
    document.documentElement.classList.toggle(
      'dark',
      theme ? appearanceOf(theme) === 'dark' : false
    );
  }
}

/** Props for {@link PreferenceAxes}. */
export interface PreferenceAxesProps {
  /** Extra classes on the row of selects. */
  className?: string;
}

/**
 * The three selects, as a wrapping row.
 *
 * @param props See {@link PreferenceAxesProps}.
 * @returns A labelled select per axis, each writing straight to `<html>`.
 */
export default function PreferenceAxes({ className }: PreferenceAxesProps) {
  return (
    <div className={className ?? 'flex flex-wrap gap-4'} data-testid="preference-axes">
      {PREFERENCE_AXES.map((axis) => (
        <label key={axis.attribute} className="flex items-center gap-2 text-sm text-fg-muted">
          {axis.label}
          <select
            className="hive-control h-[var(--control-h)] rounded-md bg-surface px-3 text-sm text-fg"
            defaultValue={axis.initial}
            onChange={(event) => setPreferenceAxis(axis.attribute, event.target.value)}
          >
            {axis.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      ))}
    </div>
  );
}
