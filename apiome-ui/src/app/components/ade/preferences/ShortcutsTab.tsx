'use client';

import React from 'react';
import { Keyboard } from 'lucide-react';
import { Button } from '../../ui/Button';
import { Kbd } from '../../ui/Kbd';
import { ICON_SIZE } from '../../ui/iconSizes';
import {
  SHORTCUT_SHEET_SHORTCUT,
  formatShortcutKeys,
  groupShortcutsByScope,
  spellShortcut,
} from '@lib/shortcuts';
import { useActiveShortcuts } from '@/app/hooks/useShortcuts';
import {
  isShortcutSheetMounted,
  openShortcutSheet,
  subscribeShortcutSheet,
} from '../../shell/shortcutSheetBus';
import { closePreferences } from './preferencesDrawerBus';

/**
 * The Shortcuts tab of the preferences pane (HIVE-1.4, #5277; HIVE-3.7, #5293).
 *
 * `docs/mockups/foundations/settings-pane.html` describes this tab in one line — *"Opens
 * the shortcut sheet (`?`)"* — and that is now what it does. The full reference is
 * `ShortcutSheet`, generated from the live registry, and a second copy of it in the pane
 * would be exactly the drift HIVE-3.7 removed.
 *
 * What stays here is the glance list: the shortcuts that work *everywhere*, so a reader who
 * opened preferences to remind themselves of one chord does not have to be sent to another
 * overlay for it. Those rows come from the same registry the sheet reads, so the two cannot
 * disagree either.
 *
 * Handing off closes this pane first. A sheet stacked on the pane that launched it is two
 * overlays where the reader asked for one — the same rule the command-palette row follows.
 */

/** The scope whose rows this tab prints inline: what works on every route. */
const GLANCE_SCOPE = 'global';

export default function ShortcutsTab() {
  const active = useActiveShortcuts();

  // Whether a sheet host is mounted at all. Subscribed rather than read once, because hosts
  // register in effects and this pane may well render before the one above it does.
  const sheetAvailable = React.useSyncExternalStore(
    subscribeShortcutSheet,
    isShortcutSheetMounted,
    () => false
  );

  const glance = groupShortcutsByScope(active).find((section) => section.scope === GLANCE_SCOPE);

  /** Hand the reader over to the sheet: this pane first, then the dialog. */
  const openSheet = React.useCallback(() => {
    closePreferences();
    openShortcutSheet();
  }, []);

  return (
    <div className="flex flex-col gap-5" data-testid="preferences-shortcuts">
      <section>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">
          Everywhere
        </h3>
        <dl className="mt-2 flex flex-col">
          {glance?.shortcuts.map((shortcut) => (
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
                <Kbd keys={formatShortcutKeys(shortcut)} />
                <span className="sr-only">{spellShortcut(shortcut)}</span>
              </dd>
            </div>
          ))}
        </dl>
      </section>

      {sheetAvailable && (
        <div>
          <Button
            variant="soft"
            onClick={openSheet}
            data-testid="open-shortcut-sheet"
            kbd={spellShortcut(SHORTCUT_SHEET_SHORTCUT)}
          >
            <Keyboard size={ICON_SIZE.button} aria-hidden />
            All keyboard shortcuts
          </Button>
        </div>
      )}

      <p className="text-xs text-fg-subtle">
        The sheet lists what is bound on the screen behind this pane — a list page has rows a
        detail page does not. On Windows and Linux, <Kbd>⌘</Kbd> is <Kbd>Ctrl</Kbd>.
      </p>
    </div>
  );
}
