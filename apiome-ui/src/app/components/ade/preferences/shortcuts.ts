/**
 * Keyboard shortcuts the app-wide shell owns (HIVE-1.4, #5277).
 *
 * Two things live here and are deliberately kept together: the *matcher* for each
 * shortcut, so no component re-implements "⌘ or Ctrl, no other modifier", and the
 * *reference list* the preferences pane's Shortcuts tab prints. A shortcut that works but
 * is undocumented, or documented but does not work, is the failure this file exists to
 * prevent — `tests/preferences-drawer.test.tsx` drives every entry that carries a matcher
 * and asserts it fires.
 *
 * Scope is the shell. Surface-specific bindings stay with their surface — the Studio git
 * palette in `utils/studio-keybindings.ts`, a panel's type-ahead in the panel — and get
 * folded in when HIVE-3.7 promotes this list into the shared shortcut sheet.
 */

/**
 * Whether a keyboard event is the "open preferences" shortcut: `⌘,` on macOS, `Ctrl+,`
 * elsewhere.
 *
 * The comma is not a text-producing combination with a command modifier held, so this
 * deliberately fires inside text fields as well — on every platform the same chord already
 * means "settings" in the browser and the OS.
 *
 * @param event The keydown event.
 * @returns `true` when the pane should open.
 */
export function matchesPreferencesShortcut(event: KeyboardEvent): boolean {
  if (event.defaultPrevented) return false;
  if (event.repeat) return false;
  if (event.key !== ',') return false;
  if (!(event.metaKey || event.ctrlKey)) return false;
  if (event.altKey || event.shiftKey) return false;
  return true;
}

/** One row in the Shortcuts tab. */
export interface ShortcutEntry {
  /** Stable id, used as the React key and by tests. */
  id: string;
  /** The chord, one chip per element, spelled the way the mockups spell it. */
  keys: readonly string[];
  /** What it does, in the shared status vocabulary. */
  description: string;
  /**
   * Whether this shell owns the binding — i.e. it is live on every route.
   *
   * `false` documents a chord that only exists on a particular surface, so the tab can say
   * so rather than promise something a reader will find does not work here.
   */
  global: boolean;
}

/** The shell shortcuts, in the order the tab lists them. */
export const SHELL_SHORTCUTS: readonly ShortcutEntry[] = [
  {
    id: 'preferences',
    keys: ['⌘', ','],
    description: 'Open preferences',
    global: true,
  },
  {
    id: 'close-overlay',
    keys: ['Esc'],
    description: 'Close the pane, dialog or menu in front',
    global: true,
  },
];

/** Shortcuts that belong to one surface, printed under a heading of their own. */
export const SURFACE_SHORTCUTS: readonly ShortcutEntry[] = [
  {
    id: 'studio-git-palette',
    keys: ['⌘', 'G'],
    description: 'Open the git command palette (Studio canvas)',
    global: false,
  },
  {
    id: 'studio-ai-panel',
    keys: ['⌘', '⇧', 'A'],
    description: 'Toggle the AI assistant panel (Studio canvas)',
    global: false,
  },
];
