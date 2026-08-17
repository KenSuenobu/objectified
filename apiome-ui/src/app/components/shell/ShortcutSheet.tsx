'use client';

import * as React from 'react';
import { Button } from '@/app/components/ui/Button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/app/components/ui/Dialog';
import { Kbd } from '@/app/components/ui/Kbd';
import {
  SHORTCUT_SHEET_SHORTCUT,
  formatShortcutKeys,
  groupShortcutsByScope,
  spellShortcut,
  type ShortcutBinding,
} from '@lib/shortcuts';
import { useActiveShortcuts } from '@/app/hooks/useShortcuts';

/**
 * The keyboard shortcuts sheet (HIVE-3.7, #5293).
 *
 * Authority: `docs/mockups/assets/hive.js` §`#shortcuts` — a `lg` dialog of two columns,
 * one section per scope, a footnote about the chips preference and a single *Done*.
 *
 * ### Nothing here is written down
 *
 * Every row comes from {@link useActiveShortcuts}: the registry of what is *bound right
 * now*. There is no list of shortcuts in this file to fall out of step with the bindings,
 * which is the acceptance criterion — and it also means the sheet is different on different
 * screens, which is the honest answer. Open it on a list and the *On a list* section is
 * there because a table is registering those keys; open it on a page without one and the
 * section is not, rather than promising keys that would do nothing.
 *
 * A gated binding (`Select a workspace to use Projects.`) keeps its row and states the
 * reason underneath, the same way a gated palette row does — a reader who cannot use `G P`
 * today still needs to know it is `G P`.
 *
 * ### A row can be pressed as well as read
 *
 * A binding that can run *right now* draws its description as a button, so the sheet is a
 * way to do the thing and not only to learn the chord. That is not a convenience: a reader
 * who cannot press `⌘K` — one hand, a switch device, a keyboard without the key — reaches
 * the palette from here, which is the entry point the preferences pane's shortcut list used
 * to be (HIVE-3.6, #5292). The sheet closes first, so the reader ends with one overlay.
 *
 * ### Announcing a chord
 *
 * `Kbd` is decorative by design (HIVE-2.2): the chips are `aria-hidden` so the "Show
 * keyboard hints" preference can hide them in CSS without hiding anything a screen reader
 * needs. Each row therefore carries the chord in words in an `sr-only` span *outside* the
 * chip group, where the preference does not reach it.
 */

/** Props for {@link ShortcutSheet}. */
export interface ShortcutSheetProps {
  /** Whether the sheet is open. */
  open: boolean;
  /** Called when it wants to close — `Esc`, the scrim, the close button or *Done*. */
  onOpenChange: (open: boolean) => void;
}

/** The dialog's accessible name. */
export const SHORTCUT_SHEET_TITLE = 'Keyboard shortcuts';

/** Its one-line description, read after the name. */
const SHEET_DESCRIPTION = 'Press ? anywhere outside a text field to open this sheet.';

/** The footnote of the mockup's footer — where the chips on buttons can be turned off. */
const SHEET_NOTE = 'Shortcut chips on buttons can be hidden in Preferences.';

/** What the platform footnote says, since every chip prints `⌘` on every platform. */
const MOD_NOTE = 'On Windows and Linux, ⌘ is Ctrl.';

/**
 * One row: what it does, and what to press.
 *
 * @param props.shortcut The binding to print.
 * @param props.onRun Run the binding and close the sheet. Absent, the row is plain text —
 *   which is the case for a documentation-only row, a gated one, and for `?` itself, whose
 *   only effect from here would be to close and reopen the sheet the reader is looking at.
 * @returns The `dt`/`dd` pair, keyed by the binding's id.
 */
function ShortcutRow({
  shortcut,
  onRun,
}: {
  shortcut: ShortcutBinding;
  onRun?: (shortcut: ShortcutBinding) => void;
}) {
  return (
    <div className="shortcut-sheet__row" data-shortcut={shortcut.id}>
      <dt className="shortcut-sheet__label">
        {onRun ? (
          <button
            type="button"
            onClick={() => onRun(shortcut)}
            data-testid={`shortcut-run-${shortcut.id}`}
            className="shortcut-sheet__action"
          >
            {shortcut.description}
          </button>
        ) : (
          shortcut.description
        )}
        {shortcut.disabledReason && (
          <span className="shortcut-sheet__reason">{shortcut.disabledReason}</span>
        )}
      </dt>
      <dd className="shortcut-sheet__keys">
        <Kbd keys={formatShortcutKeys(shortcut)} />
        {/* Outside the chip group on purpose: `html[data-kbd-hints="off"]` hides the group,
            and the chord must not be hidden with it. */}
        <span className="sr-only">{spellShortcut(shortcut)}</span>
      </dd>
    </div>
  );
}

/**
 * Whether a row should be pressable as well as readable.
 *
 * @param shortcut The binding.
 * @returns `true` when running it from here would do something the reader asked for.
 */
function isRunnable(shortcut: ShortcutBinding): boolean {
  if (!shortcut.run || shortcut.disabledReason) return false;
  // `?` is the chord that opened this. Running it from inside would close and reopen the
  // sheet, which is a loop rather than an affordance.
  return shortcut.id !== SHORTCUT_SHEET_SHORTCUT.id;
}

/**
 * The shortcuts sheet.
 *
 * @param props See {@link ShortcutSheetProps}.
 * @returns The dialog; Radix keeps a closed dialog out of the DOM.
 */
export default function ShortcutSheet({ open, onOpenChange }: ShortcutSheetProps) {
  const sections = groupShortcutsByScope(useActiveShortcuts());

  /**
   * Do what a row says, then get out of the way.
   *
   * Closing first is what lets the sheet give focus back to whatever opened it before a
   * chosen row navigates — the same order `CommandPaletteHost` uses when a palette row is
   * chosen.
   */
  const runShortcut = React.useCallback(
    (shortcut: ShortcutBinding) => {
      onOpenChange(false);
      shortcut.run?.();
    },
    [onOpenChange]
  );

  /**
   * What had focus before the sheet opened, so closing gives it back.
   *
   * Captured in a *layout* effect and restored from `onCloseAutoFocus`, which is the same
   * call `CommandPalette` and `PreferencesDrawerHost` make: React runs every layout effect
   * before any passive one, and Radix moves focus into the dialog from a passive effect, so
   * this is the last moment the trigger is still the active element.
   */
  const previouslyFocused = React.useRef<HTMLElement | null>(null);
  const wasOpen = React.useRef(false);
  React.useLayoutEffect(() => {
    if (open && !wasOpen.current) {
      const active = document.activeElement;
      previouslyFocused.current = active instanceof HTMLElement ? active : null;
    }
    wasOpen.current = open;
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="lg"
        className="shortcut-sheet"
        data-testid="shortcut-sheet"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const trigger = previouslyFocused.current;
          previouslyFocused.current = null;
          // The trigger can be gone: the rail menu that held it closes behind the sheet.
          if (trigger?.isConnected) trigger.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{SHORTCUT_SHEET_TITLE}</DialogTitle>
          <DialogDescription>{SHEET_DESCRIPTION}</DialogDescription>
        </DialogHeader>

        {sections.length === 0 ? (
          <p className="shortcut-sheet__empty" data-testid="shortcut-sheet-empty">
            No shortcuts are bound on this screen.
          </p>
        ) : (
          <div className="shortcut-sheet__grid">
            {sections.map((section) => (
              <section key={section.scope} data-shortcut-scope={section.scope}>
                <h3 className="shortcut-sheet__caps">{section.heading}</h3>
                <dl className="shortcut-sheet__list">
                  {section.shortcuts.map((shortcut) => (
                    <ShortcutRow
                      key={shortcut.id}
                      shortcut={shortcut}
                      onRun={isRunnable(shortcut) ? runShortcut : undefined}
                    />
                  ))}
                </dl>
              </section>
            ))}
          </div>
        )}

        <DialogFooter className="sm:justify-between">
          <p className="shortcut-sheet__note">
            {SHEET_NOTE} {MOD_NOTE}
          </p>
          <Button variant="soft" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
