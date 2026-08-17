'use client';

import React from 'react';
import {
  SWITCH_PREFERENCES,
  type DensityId,
  type FontScaleId,
  type PreferenceKey,
  type Preferences,
} from '../../../config/preferences';
import type { Theme } from '../../../config/themes';
import DensitySegmented from './DensitySegmented';
import FontScaleSlider from './FontScaleSlider';
import SwitchRow from './SwitchRow';
import ThemeRadioGroup from './ThemeRadioGroup';

/**
 * The Appearance tab of the preferences pane (HIVE-1.4, #5277; `DESIGN.md` §4.1).
 *
 * Theme, then font size, then density, then the switches — the order the design document
 * lists them in, which is also roughest-to-finest: the palette, the scale everything is
 * measured in, how tightly it packs, and finally the details.
 *
 * Every control here writes through and applies immediately. There is no Save button and
 * no local draft state: what the pane shows is read back out of the same store the shell
 * renders from, so the pane cannot disagree with the app behind it.
 */

export interface AppearanceTabProps {
  /** Every selectable theme, in picker order. */
  themes: readonly Theme[];
  /** The current theme choice — `system` when following the OS. */
  themeChoice: string;
  /** What "follow system" resolves to, when that is the choice; omitted otherwise. */
  systemResolvedName?: string;
  /** Select a theme. */
  onSelectTheme: (themeId: string) => void;
  /** The current preference values. */
  preferences: Preferences;
  /** Set one preference. */
  onSetPreference: <K extends PreferenceKey>(key: K, value: Preferences[K]) => void;
}

export default function AppearanceTab({
  themes,
  themeChoice,
  systemResolvedName,
  onSelectTheme,
  preferences,
  onSetPreference,
}: AppearanceTabProps) {
  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="preferences-theme-heading">
        {/* `t-h4` — DESIGN.md §3.2's 14 px section step. A section title set at the same
            13 px as the nine card names underneath it stops separating the block from its
            contents, and the tab reads as one undifferentiated column. */}
        <h3 id="preferences-theme-heading" className="text-base font-semibold text-fg">
          Theme
        </h3>
        <p className="mb-3 text-xs text-fg-muted">
          A theme is a token swap: surfaces, ink, accent. Layout and type never change.
        </p>
        <ThemeRadioGroup
          themes={themes}
          value={themeChoice}
          systemResolvedName={systemResolvedName}
          onSelect={onSelectTheme}
        />
      </section>

      <section>
        <FontScaleSlider
          value={preferences.fontScale}
          onChange={(fontScale: FontScaleId) => onSetPreference('fontScale', fontScale)}
        />
      </section>

      <section>
        <DensitySegmented
          value={preferences.density}
          onChange={(density: DensityId) => onSetPreference('density', density)}
        />
      </section>

      <section aria-label="Interface options">
        {SWITCH_PREFERENCES.map((row) => (
          <SwitchRow
            key={row.key}
            name={row.key}
            title={row.title}
            description={row.description}
            checked={preferences[row.key] === row.on}
            onCheckedChange={(checked) =>
              // The stored value, not a boolean: `motion` is `reduce`/`auto` and `rail` is
              // `collapsed`/`expanded`, and the descriptor says which way round each reads.
              onSetPreference(row.key, (checked ? row.on : row.off) as Preferences[typeof row.key])
            }
          />
        ))}
      </section>
    </div>
  );
}
