'use client';

import React from 'react';
import { Kbd } from '../../ui/Kbd';
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
 */

export default function ShortcutsTab() {
  return (
    <div className="flex flex-col gap-5" data-testid="preferences-shortcuts">
      <ShortcutList title="Everywhere" shortcuts={SHELL_SHORTCUTS} />
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
 */
function ShortcutList({
  title,
  shortcuts,
}: {
  title: string;
  shortcuts: readonly ShortcutEntry[];
}) {
  return (
    <section>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">{title}</h3>
      <dl className="mt-2 flex flex-col">
        {shortcuts.map((shortcut) => (
          <div
            key={shortcut.id}
            data-shortcut={shortcut.id}
            className="flex items-center justify-between gap-4 border-b border-border py-2 last:border-b-0"
          >
            <dt className="text-sm text-fg">{shortcut.description}</dt>
            <dd className="flex shrink-0 items-center gap-1">
              {/* The chips are decorative — `Kbd` hides the group from assistive
                  technology — so the row reads "Open preferences, ⌘ ," from the visually
                  hidden spelling beside them, which the keyboard-hints preference leaves
                  alone. */}
              <Kbd keys={shortcut.keys} />
              <span className="sr-only">{shortcut.keys.join(' ')}</span>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
