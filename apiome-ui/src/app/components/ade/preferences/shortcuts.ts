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

/**
 * Whether a keyboard event is the "collapse the rail" shortcut: `⌘\` on macOS, `Ctrl+\`
 * elsewhere (HIVE-3.1, #5287; `DESIGN.md` §5.2).
 *
 * Matched the same way as {@link matchesPreferencesShortcut}, and for the same reason: a
 * command modifier with a backslash produces no text, so suppressing it inside a field
 * would only make the shortcut unreliable without protecting anything the reader typed.
 *
 * @param event The keydown event.
 * @returns `true` when the rail should flip between expanded and collapsed.
 */
export function matchesRailShortcut(event: KeyboardEvent): boolean {
  if (event.defaultPrevented) return false;
  if (event.repeat) return false;
  if (event.key !== '\\') return false;
  if (!(event.metaKey || event.ctrlKey)) return false;
  if (event.altKey || event.shiftKey) return false;
  return true;
}

/**
 * Whether a keyboard event is the "show the keyboard shortcuts" chord: a bare `?`
 * (HIVE-3.4, #5290; `DESIGN.md` §5.4 prints the chip beside the menu row).
 *
 * Unlike the two chords above this one *is* a text-producing keystroke, so it is
 * suppressed wherever the reader is typing — see {@link isTypingTarget}. Modifiers are
 * rejected outright rather than ignored: `⌘?` and `Ctrl+?` are browser and OS bindings,
 * and shift is deliberately *not* checked, because `?` is a shifted character on most
 * layouts and is not on others.
 *
 * HIVE-3.7 (#5293) replaces what this opens with the generated shortcut sheet. The chord
 * itself does not change, which is why it is matched here rather than inside the menu.
 *
 * @param event The keydown event.
 * @returns `true` when the shortcuts reference should open.
 */
export function matchesShortcutsShortcut(event: KeyboardEvent): boolean {
  if (event.defaultPrevented) return false;
  if (event.repeat) return false;
  if (event.key !== '?') return false;
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  return !isTypingTarget(event.target);
}

/**
 * Whether an event target is somewhere the reader is composing text.
 *
 * A printable shortcut must never eat a keystroke meant for a field, so this covers the
 * three ways text is entered on the web: a text-accepting `<input>`, a `<textarea>`, and
 * any `contenteditable` subtree. Non-text inputs (checkbox, radio, button, range) are
 * *not* typing targets — a shortcut should still work from a focused checkbox.
 *
 * @param target The event target, as `EventTarget | null`.
 * @returns `true` when a printable key belongs to the target rather than to the app.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;

  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;

  // `type` is normalised by the DOM, so an unknown or missing value reads as `text`.
  const type = (target as HTMLInputElement).type;
  return !NON_TEXT_INPUT_TYPES.has(type);
}

/** `<input type>` values that accept no typed text, so a printable shortcut is safe there. */
const NON_TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

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
    id: 'rail',
    keys: ['⌘', '\\'],
    description: 'Collapse or expand the sidebar',
    global: true,
  },
  {
    id: 'shortcuts',
    keys: ['?'],
    description: 'Show the keyboard shortcuts',
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
