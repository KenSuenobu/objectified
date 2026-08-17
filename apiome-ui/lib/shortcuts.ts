/**
 * The shortcut vocabulary (HIVE-3.7, #5293).
 *
 * Authority: `docs/mockups/DESIGN.md` §8 (*Keyboard*) and the sheet in
 * `docs/mockups/assets/hive.js` (`#shortcuts`).
 *
 * Before this module every chord was a hand-written matcher beside the component that
 * bound it, and the reference list was a second hand-written array beside those matchers.
 * Two hand-written lists cannot be kept in step, and #1326's "Keyboard Shortcut Manager"
 * was the ticket that never shipped to fix it.
 *
 * So a shortcut is *declared once*, as data:
 *
 * ```ts
 * const SAVE: ShortcutDefinition = {
 *   id: 'save', scope: 'dialog', description: 'Save', chord: { key: 'Enter', mod: true },
 * };
 * ```
 *
 * and everything else is derived from that one declaration — the matcher
 * ({@link matchesShortcutChord}), the chips the sheet and the menus print
 * ({@link formatShortcutKeys}), and whether it may fire where the reader is typing
 * ({@link firesWhileTyping}). A chord and its chip therefore cannot drift, because there is
 * only one of them.
 *
 * ### What is here and what is not
 *
 * This module is **pure** — no React, no DOM registration, no side effects — for the same
 * reason `lib/platform-nav.ts` is: the interesting questions (does this event match that
 * chord, what does the chip say, may it fire in a text field) are answerable without a
 * document, so they are tested without one.
 *
 * The *runtime* half — which bindings are live right now, the single document listener, the
 * `G` then `P` sequence buffer — is `src/app/hooks/useShortcuts.ts`. The **sheet** that
 * prints them is `components/shell/ShortcutSheet.tsx`, and it reads the live registry
 * rather than any list in this file, so it can only ever show shortcuts that work.
 *
 * ### The house rule
 *
 * A documented shortcut must work, and a working shortcut must be documented. Both halves
 * fall out of registration: an owner registers a binding to make it work, and registering
 * is what puts it in the sheet.
 */

/* -------------------------------------------------------------------------
   Scopes
   ------------------------------------------------------------------------- */

/**
 * Where a shortcut applies — the sheet's sections, in the order it prints them.
 *
 * - `global` — live on every route, bound by the shell.
 * - `jump` — the `G` then *letter* sequences, also the shell's.
 * - `list` — a list page: new, import, move, open, select, row actions.
 * - `dialog` — inside a dialog or a wizard step.
 * - `surface` — one screen's own chords (the Studio canvas, a workbench).
 */
export type ShortcutScope = 'global' | 'jump' | 'list' | 'dialog' | 'surface';

/** The scopes in the order the sheet prints them (`hive.js` §`#shortcuts`). */
export const SHORTCUT_SCOPE_ORDER: readonly ShortcutScope[] = [
  'global',
  'jump',
  'list',
  'dialog',
  'surface',
];

/**
 * Each scope's heading, in the sentence case `DESIGN.md` §10 asks for.
 *
 * The heading is what makes a row honest without a per-row caveat: "New item" under *On a
 * list* promises nothing on a page that has no list, so the sheet does not have to say so
 * twice.
 */
export const SHORTCUT_SCOPE_HEADINGS: Readonly<Record<ShortcutScope, string>> = {
  global: 'Global',
  jump: 'Jump (press G, then…)',
  list: 'On a list',
  dialog: 'Dialogs and wizards',
  surface: 'On this page',
};

/* -------------------------------------------------------------------------
   Chords
   ------------------------------------------------------------------------- */

/**
 * One key with its modifiers.
 *
 * `key` is the DOM `KeyboardEvent.key`, i.e. the *character produced* — `,` and not
 * `Comma`, `?` and not `Shift+Slash`. That is what makes a chord layout-independent: a
 * reader whose keyboard puts `?` somewhere else still presses the key that types a question
 * mark.
 */
export interface ShortcutChord {
  /** `KeyboardEvent.key`. Letters are matched case-insensitively. */
  key: string;
  /** The command modifier: `⌘` on macOS, `Ctrl` elsewhere. Either is accepted. */
  mod?: boolean;
  /**
   * Whether shift must be held.
   *
   * Left out, shift is checked only for *letters* (where `⇧N` would be a second chord),
   * and ignored for punctuation — `?` is shifted on some layouts and not on others, and
   * the produced character has already told us which key was pressed.
   */
  shift?: boolean;
  /** Whether alt/option must be held. Left out, it must not be. */
  alt?: boolean;
}

/**
 * A shortcut, as data.
 *
 * Exactly one of {@link chord}, {@link sequence} and {@link keys} decides how it is
 * matched:
 *
 * | Field | Matched by | Example |
 * | --- | --- | --- |
 * | `chord` | the engine, on one keystroke | `⌘K` |
 * | `sequence` | the engine, on two within a second | `G` then `P` |
 * | `keys` alone | **nobody** — it is documentation | `Esc`, `↑` `↓` |
 *
 * The third row is not a loophole. Some chords are implemented by something that is not the
 * shortcut engine and could not be: `Esc` is Radix's, closing whichever overlay is in front;
 * `↑` `↓` `↵` `X` `.` are `DataTable`'s, and only while the focus is on a row. Declaring
 * them here lets their owner put them in the sheet — which is the honest place for them —
 * without the engine also binding a key it would then have to fight over.
 */
export interface ShortcutDefinition {
  /** Stable id: the React key, the registry's identity and the test handle. */
  id: string;
  /** Which section of the sheet prints it. */
  scope: ShortcutScope;
  /** What it does, in the shared status vocabulary. */
  description: string;
  /** A single keystroke. */
  chord?: ShortcutChord;
  /** Two keystrokes within {@link SHORTCUT_SEQUENCE_TIMEOUT_MS} — `['g', 'p']`. */
  sequence?: readonly [string, string];
  /**
   * Chips to print, when the derived ones would be wrong.
   *
   * Set it for a documentation-only row (`['Esc']`), or where one row stands for a pair the
   * reader presses one at a time (`['↑', '↓']`).
   */
  keys?: readonly string[];
  /**
   * Whether the chord fires while the reader is typing.
   *
   * Defaults to **false** for every printable shortcut, which is the acceptance criterion:
   * a bare `N` in a filter box types an N. The three command-modifier chords the shell
   * shipped before this registry (`⌘K`, `⌘,`, `⌘\`) set it deliberately — those produce no
   * text, every desktop platform already binds them, and a palette a reader cannot open
   * half-way through a filter is a palette that fails at the one moment it is wanted.
   */
  allowWhileTyping?: boolean;
}

/**
 * A declaration with the behaviour an owner attaches when it registers.
 *
 * The split is what keeps the sheet truthful: the declaration says what the chord *is*, the
 * owner says what it *does* right now, and nothing reaches the sheet that no owner has
 * claimed.
 */
export interface ShortcutBinding extends ShortcutDefinition {
  /**
   * What to run. Absent, the row is documentation — see {@link ShortcutDefinition}.
   *
   * @param event The keydown that matched, already `preventDefault()`ed by the engine.
   *   Absent when the sheet ran it from a click: a reader who cannot press the chord can
   *   still reach what it does, so a handler must not require the event.
   */
  run?: (event?: KeyboardEvent) => void;
  /**
   * Why it cannot be used right now — "Select a workspace to use Projects."
   *
   * A disabled binding keeps its row and states the reason, exactly as a gated palette row
   * does: hiding it would leave a reader wondering whether they misremembered the chord.
   */
  disabledReason?: string;
}

/** How long the first key of a sequence waits for the second (`DESIGN.md` §8). */
export const SHORTCUT_SEQUENCE_TIMEOUT_MS = 1000;

/** The command modifier's chip, on every platform — the sheet prints the footnote. */
export const MOD_KEY_LEGEND = '⌘';

/* -------------------------------------------------------------------------
   Matching
   ------------------------------------------------------------------------- */

/** A single letter, which is the one key kind where `⇧` makes a different chord. */
const LETTER_KEY = /^[a-z]$/i;

/**
 * Whether a keydown is this chord.
 *
 * @param event The keydown, or anything with the same modifier fields (tests pass literals).
 * @param chord The chord to match — see {@link ShortcutChord}.
 * @returns `true` when the reader pressed exactly this.
 */
export function matchesShortcutChord(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  chord: ShortcutChord
): boolean {
  if (!sameKey(event.key, chord.key)) return false;

  // Either command modifier, never both roles at once: `mod: true` means "⌘ or Ctrl", and
  // an unmodified chord must stay unmodified or `⌘N` would open a project *and* a window.
  const mod = event.metaKey || event.ctrlKey;
  if (Boolean(chord.mod) !== mod) return false;
  if (Boolean(chord.alt) !== event.altKey) return false;

  if (chord.shift === undefined) {
    return !(LETTER_KEY.test(chord.key) && event.shiftKey);
  }
  return chord.shift === event.shiftKey;
}

/**
 * Whether two `KeyboardEvent.key` values are the same key.
 *
 * @param pressed What the event reported.
 * @param wanted What the chord asked for.
 * @returns `true` when they match, case-insensitively for single characters.
 */
function sameKey(pressed: string | undefined, wanted: string): boolean {
  if (!pressed) return false;
  if (wanted.length === 1) return pressed.toLowerCase() === wanted.toLowerCase();
  return pressed === wanted;
}

/**
 * Whether a binding may fire while the reader is composing text.
 *
 * @param definition The binding.
 * @returns `true` only when the declaration says so — the default is silence.
 */
export function firesWhileTyping(definition: ShortcutDefinition): boolean {
  return definition.allowWhileTyping === true;
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

/* -------------------------------------------------------------------------
   Chips
   ------------------------------------------------------------------------- */

/**
 * How a key is drawn on a chip, where the character itself will not do.
 *
 * The spellings are the mockup's (`hive.js` §`#shortcuts`): arrows as arrows, Enter as `↵`,
 * `Esc` capitalised the way every other application capitalises it.
 */
const KEY_LEGENDS: Readonly<Record<string, string>> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Enter: '↵',
  Escape: 'Esc',
  Backspace: '⌫',
  Delete: 'Del',
  Tab: 'tab',
  ' ': 'space',
};

/**
 * One key's chip legend.
 *
 * @param key A `KeyboardEvent.key` value.
 * @returns What the chip says: a named legend, an upper-cased letter, or the key itself.
 */
export function formatShortcutKey(key: string): string {
  const named = KEY_LEGENDS[key];
  if (named) return named;
  return key.length === 1 ? key.toUpperCase() : key;
}

/**
 * The chips for a shortcut, derived from the very declaration that matches it.
 *
 * That derivation is the point: a chip cannot promise a chord the matcher does not accept,
 * because it is generated from the matcher's own data.
 *
 * @param definition The shortcut.
 * @returns One legend per chip, in reading order.
 */
export function formatShortcutKeys(definition: ShortcutDefinition): readonly string[] {
  if (definition.keys) return definition.keys;
  if (definition.sequence) return definition.sequence.map(formatShortcutKey);

  const chord = definition.chord;
  if (!chord) return [];

  const legends: string[] = [];
  if (chord.mod) legends.push(MOD_KEY_LEGEND);
  if (chord.alt) legends.push('⌥');
  // Only an *explicit* shift is a chip: the `?` of `⇧/` is one key to the reader.
  if (chord.shift) legends.push('⇧');
  legends.push(formatShortcutKey(chord.key));
  return legends;
}

/**
 * The chord spelled for assistive technology, since `Kbd` renders chips `aria-hidden`.
 *
 * @param definition The shortcut.
 * @returns e.g. `"⌘ K"`, or `"G then P"` for a sequence.
 */
export function spellShortcut(definition: ShortcutDefinition): string {
  const keys = formatShortcutKeys(definition);
  if (definition.sequence && !definition.keys) return keys.join(' then ');
  return keys.join(' ');
}

/* -------------------------------------------------------------------------
   The shell's own declarations
   ------------------------------------------------------------------------- */

/**
 * `⌘K` — the command palette (HIVE-3.6, #5292). Registered by `CommandPaletteHost`.
 *
 * Fires inside text fields deliberately: a reader half-way through a filter box should be
 * able to leave for somewhere else without first clearing what they typed. The browser
 * claims `Ctrl+K` on some platforms (Firefox focuses its search bar), so the engine takes
 * the event.
 */
export const PALETTE_SHORTCUT: ShortcutDefinition = {
  id: 'palette',
  scope: 'global',
  description: 'Open the command palette',
  chord: { key: 'k', mod: true, shift: false },
  allowWhileTyping: true,
};

/** `/` — hand the reader to the palette's search field. Registered by `CommandPaletteHost`. */
export const SEARCH_SHORTCUT: ShortcutDefinition = {
  id: 'search',
  scope: 'global',
  description: 'Search or filter',
  chord: { key: '/' },
};

/**
 * `⌘,` — preferences (HIVE-1.4, #5277). Registered by `PreferencesDrawerHost`.
 *
 * The chord every desktop platform already means "settings" by, which is why it fires
 * inside fields as well: a comma with a command modifier produces no text.
 */
export const PREFERENCES_SHORTCUT: ShortcutDefinition = {
  id: 'preferences',
  scope: 'global',
  description: 'Open preferences',
  chord: { key: ',', mod: true, shift: false },
  allowWhileTyping: true,
};

/** `⌘\` — collapse or expand the rail (HIVE-3.1, #5287). Registered by `AppShell`. */
export const RAIL_SHORTCUT: ShortcutDefinition = {
  id: 'rail',
  scope: 'global',
  description: 'Collapse or expand the sidebar',
  chord: { key: '\\', mod: true, shift: false },
  allowWhileTyping: true,
};

/**
 * `?` — this sheet. Registered by `ShortcutsHost`.
 *
 * A printable keystroke, so it is suppressed wherever the reader is typing. Modifiers are
 * rejected outright rather than ignored: `⌘?` and `Ctrl+?` are browser and OS bindings.
 */
export const SHORTCUT_SHEET_SHORTCUT: ShortcutDefinition = {
  id: 'shortcuts',
  scope: 'global',
  description: 'Show the keyboard shortcuts',
  chord: { key: '?' },
};

/**
 * `Esc` — documentation only. Radix closes whichever overlay is in front, per overlay, and
 * an engine binding would be a second opinion about which one that is.
 */
export const CLOSE_OVERLAY_SHORTCUT: ShortcutDefinition = {
  id: 'close-overlay',
  scope: 'global',
  description: 'Close the pane, dialog or menu in front',
  keys: ['Esc'],
};

/** A `G`-then-letter jump, and the navigation-model destination it goes to. */
export interface JumpShortcutDefinition extends ShortcutDefinition {
  /** `PlatformNavItem.id` — resolved through `getPlatformNavGroups()` so gating follows. */
  navItemId: string;
}

/**
 * The five jumps of `DESIGN.md` §8, registered by `ShortcutsHost`.
 *
 * Each names a destination by **id** rather than by route: the href, the label and whether
 * this session may go there all come from the HIVE-3.2 navigation model, so a jump and the
 * rail row above it can never disagree.
 */
export const JUMP_SHORTCUTS: readonly JumpShortcutDefinition[] = [
  { id: 'jump-home', scope: 'jump', description: 'Home', sequence: ['g', 'h'], navItemId: 'home' },
  {
    id: 'jump-projects',
    scope: 'jump',
    description: 'Projects',
    sequence: ['g', 'p'],
    navItemId: 'projects',
  },
  {
    id: 'jump-catalog',
    scope: 'jump',
    description: 'Catalog',
    sequence: ['g', 'c'],
    navItemId: 'catalog',
  },
  {
    id: 'jump-lint',
    scope: 'jump',
    description: 'Lint posture',
    sequence: ['g', 'l'],
    navItemId: 'lint-workspace',
  },
  {
    id: 'jump-members',
    scope: 'jump',
    description: 'Members',
    sequence: ['g', 'm'],
    navItemId: 'members',
  },
];

/** A list action whose chord the shell binds, and the palette row it is the same thing as. */
export interface ListActionShortcutDefinition extends ShortcutDefinition {
  /** `PaletteActionDefinition.id` in `commandPaletteModel.ts` — the label, route and gate. */
  paletteActionId: string;
}

/**
 * `N` and `I` — the two list actions of `DESIGN.md` §8, registered by `ShortcutsHost`.
 *
 * The palette has printed these chips on its Actions rows since HIVE-3.6 (#5292) and said
 * that this ticket would bind them. It binds them to the *same* rows rather than to a second
 * copy of the flow: {@link paletteActionId} resolves to the palette action, so the chord,
 * the chip beside it and the row a reader clicks instead all lead to one dialog.
 *
 * They are `list` scope because that is where a reader meets them, and because a list page
 * that owns a better `N` (its own "New…" dialog, no navigation) registers over the top of
 * this one for as long as it is mounted.
 */
export const LIST_ACTION_SHORTCUTS: readonly ListActionShortcutDefinition[] = [
  {
    id: 'list-new',
    scope: 'list',
    description: 'New item',
    chord: { key: 'n' },
    paletteActionId: 'action-new-project',
  },
  {
    id: 'list-import',
    scope: 'list',
    description: 'Import',
    chord: { key: 'i' },
    paletteActionId: 'action-import-spec',
  },
];

/**
 * What a table already does with the keyboard (HIVE-2.3), declared so the sheet can say so.
 *
 * `DataTable` implements every one of these on the focused `<tr>` itself, which is the only
 * place they can mean anything — a document-level binding could not know which row the
 * reader meant. Registering them from the table is therefore documentation of behaviour
 * that is already there, and it appears in the sheet exactly while a table is on screen.
 */
export const DATA_TABLE_SHORTCUTS: readonly ShortcutDefinition[] = [
  {
    id: 'list-move',
    scope: 'list',
    description: 'Move between rows',
    keys: ['↑', '↓'],
  },
  { id: 'list-open', scope: 'list', description: 'Open the focused row', keys: ['↵'] },
  { id: 'list-select', scope: 'list', description: 'Select the focused row', keys: ['X'] },
  { id: 'list-actions', scope: 'list', description: 'Reach the row’s actions', keys: ['.'] },
];

/* -------------------------------------------------------------------------
   Grouping, for the sheet
   ------------------------------------------------------------------------- */

/**
 * Reading order inside a section.
 *
 * Ordering **only**: an id that is not here sorts after the ones that are, in registration
 * order, so a page contributing a shortcut needs no edit to this list and nothing can be
 * hidden by being left out of it. It exists because a reference sheet has a reading order —
 * the palette before the sidebar, the way `hive.js` §`#shortcuts` prints them — and mount
 * order is not it.
 */
export const SHORTCUT_DISPLAY_ORDER: readonly string[] = [
  'palette',
  'preferences',
  'rail',
  'search',
  'close-overlay',
  'shortcuts',
  ...JUMP_SHORTCUTS.map((jump) => jump.id),
  'list-new',
  'list-import',
  ...DATA_TABLE_SHORTCUTS.map((shortcut) => shortcut.id),
];

/** One section of the sheet: a scope's heading and the bindings live in it. */
export interface ShortcutSection {
  /** The scope this section prints. */
  scope: ShortcutScope;
  /** Its heading — {@link SHORTCUT_SCOPE_HEADINGS}. */
  heading: string;
  /** The bindings, in reading order. */
  shortcuts: readonly ShortcutBinding[];
}

/**
 * Turn the live registry into the sheet's sections.
 *
 * Two rules, both of which the sheet would otherwise have to know:
 *
 *   - **One row per id.** Two hosts can be mounted at once (a gallery, a shell inside a
 *     shell) and the reader has one keyboard, so the *most recent* registration is the one
 *     printed — the same binding the engine would fire.
 *   - **No empty sections.** A scope with nothing live is a scope the reader is not in;
 *     printing "On a list" on a page with no list is exactly the drift this ticket removes.
 *
 * @param bindings The registry, oldest registration first.
 * @returns Sections in {@link SHORTCUT_SCOPE_ORDER}, each non-empty.
 */
export function groupShortcutsByScope(
  bindings: readonly ShortcutBinding[]
): readonly ShortcutSection[] {
  /** id → the winning binding and the position its row keeps. */
  const byId = new Map<string, { binding: ShortcutBinding; seen: number }>();

  bindings.forEach((binding, index) => {
    const existing = byId.get(binding.id);
    byId.set(binding.id, { binding, seen: existing ? existing.seen : index });
  });

  const rank = (binding: ShortcutBinding): number => {
    const declared = SHORTCUT_DISPLAY_ORDER.indexOf(binding.id);
    return declared === -1 ? Number.MAX_SAFE_INTEGER : declared;
  };

  return SHORTCUT_SCOPE_ORDER.map((scope) => {
    const shortcuts = [...byId.values()]
      .filter((entry) => entry.binding.scope === scope)
      .sort((a, b) => rank(a.binding) - rank(b.binding) || a.seen - b.seen)
      .map((entry) => entry.binding);

    return { scope, heading: SHORTCUT_SCOPE_HEADINGS[scope], shortcuts };
  }).filter((section) => section.shortcuts.length > 0);
}
