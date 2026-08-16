'use client';

import React from 'react';
import { Kbd } from '../../ui/Kbd';
import {
  isCommandPaletteMounted,
  openCommandPalette,
  subscribeCommandPalette,
} from '../../shell/commandPaletteBus';
import { closePreferences } from './preferencesDrawerBus';
import { SHELL_SHORTCUTS, SURFACE_SHORTCUTS, type ShortcutEntry } from './shortcuts';

/**
 * The Shortcuts tab of the preferences pane (HIVE-1.4, #5277; `DESIGN.md` §4.1).
 *
 * The design has this tab *open* the shared shortcut sheet, which HIVE-3.7 builds. Until
 * that sheet exists the reference lives here rather than nowhere: the tab prints the same
 * registry the sheet will read (`./shortcuts.ts`), so 3.7 replaces a panel, not a source of
 * truth.
 *
 * Only shortcuts that actually work are listed, and one that belongs to a single surface
 * says so — a reference that promises a chord the reader cannot find is worse than no
 * reference.
 *
 * The command-palette row is the one entry that can be *used* from here as well as read
 * (HIVE-3.6, #5292 — the sheet is one of the palette's three entry points). It closes this
 * pane before opening the palette, so the reader ends with one overlay rather than two.
 */

/** Registry id of the row that opens the command palette. */
const PALETTE_SHORTCUT_ID = 'palette';

export default function ShortcutsTab() {
  // Whether a palette host is mounted at all. Subscribed rather than read once, for the
  // same reason `RailSearchTrigger` subscribes: hosts register in effects.
  const paletteAvailable = React.useSyncExternalStore(
    subscribeCommandPalette,
    isCommandPaletteMounted,
    () => false
  );

  /** Hand the reader over to the palette: this pane first, then the dialog. */
  const openPalette = React.useCallback(() => {
    closePreferences();
    openCommandPalette();
  }, []);

  return (
    <div className="flex flex-col gap-5" data-testid="preferences-shortcuts">
      <ShortcutList
        title="Everywhere"
        shortcuts={SHELL_SHORTCUTS}
        onRun={paletteAvailable ? { [PALETTE_SHORTCUT_ID]: openPalette } : undefined}
      />
      <ShortcutList title="Studio canvas" shortcuts={SURFACE_SHORTCUTS} />
      <p className="text-xs text-fg-subtle">
        On Windows and Linux, <Kbd>⌘</Kbd> is <Kbd>Ctrl</Kbd>.
      </p>
    </div>
  );
}

/**
 * One headed group of shortcut rows.
 *
 * @param props.title The group heading.
 * @param props.shortcuts The rows, in registry order.
 * @param props.onRun Registry id → what to run when the row is activated. A row with no
 *   entry here is a description and stays plain text; a row with one becomes a button, so
 *   the chord is reachable by a reader who cannot press it.
 */
function ShortcutList({
  title,
  shortcuts,
  onRun,
}: {
  title: string;
  shortcuts: readonly ShortcutEntry[];
  onRun?: Readonly<Record<string, () => void>>;
}) {
  return (
    <section>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">{title}</h3>
      <dl className="mt-2 flex flex-col">
        {shortcuts.map((shortcut) => {
          const run = onRun?.[shortcut.id];

          return (
            <div
              key={shortcut.id}
              data-shortcut={shortcut.id}
              className="flex items-center justify-between gap-4 border-b border-border py-2 last:border-b-0"
            >
              <dt className="text-sm text-fg">
                {run ? (
                  <button
                    type="button"
                    onClick={run}
                    data-testid={`shortcut-run-${shortcut.id}`}
                    className="rounded-xs text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    {shortcut.description}
                  </button>
                ) : (
                  shortcut.description
                )}
              </dt>
              <dd className="flex shrink-0 items-center gap-1">
                {/* The chips are decorative — `Kbd` hides the group from assistive
                    technology — so the row reads "Open preferences, ⌘ ," from the visually
                    hidden spelling beside them, which the keyboard-hints preference leaves
                    alone. */}
                <Kbd keys={shortcut.keys} />
                <span className="sr-only">{shortcut.keys.join(' ')}</span>
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}
