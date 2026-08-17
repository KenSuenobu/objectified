/**
 * The shortcut vocabulary and the registry that serves it (HIVE-3.7, #5293).
 *
 * Two halves, tested in the order they compose:
 *
 *   1. **`lib/shortcuts.ts`** — pure. Does this event match that chord, what does the chip
 *      say, and does the chip say the same thing the matcher accepts. That last one is the
 *      whole point of the module: the chip is *derived* from the matcher's own data, so the
 *      assertions here are about a single declaration rather than about two lists agreeing.
 *   2. **`src/app/hooks/useShortcuts.ts`** — the registry and its one listener. The
 *      acceptance criteria live here: nothing fires while the reader is typing, a sequence
 *      gives up after a second, and a binding is gone the moment its owner unmounts.
 */

import React from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import '@testing-library/jest-dom';

import {
  DATA_TABLE_SHORTCUTS,
  JUMP_SHORTCUTS,
  LIST_ACTION_SHORTCUTS,
  PALETTE_SHORTCUT,
  PREFERENCES_SHORTCUT,
  RAIL_SHORTCUT,
  SEARCH_SHORTCUT,
  SHORTCUT_SCOPE_ORDER,
  SHORTCUT_SEQUENCE_TIMEOUT_MS,
  SHORTCUT_SHEET_SHORTCUT,
  formatShortcutKeys,
  groupShortcutsByScope,
  isTypingTarget,
  matchesShortcutChord,
  spellShortcut,
  type ShortcutBinding,
} from '../lib/shortcuts';
import {
  getActiveShortcuts,
  registerShortcuts,
  resetShortcutSequence,
  useShortcuts,
} from '../src/app/hooks/useShortcuts';
import { PALETTE_ACTIONS } from '../src/app/components/shell/commandPaletteModel';

/** A keydown as the matcher sees it, with everything not mentioned left off. */
function press(key: string, overrides: Partial<KeyboardEvent> = {}) {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  } as KeyboardEvent;
}

/** A component that registers bindings for as long as it is mounted. */
function Bound({ bindings }: { bindings: readonly ShortcutBinding[] }) {
  useShortcuts(bindings);
  return null;
}

afterEach(() => {
  resetShortcutSequence();
});

describe('matching a chord', () => {
  it('accepts either command modifier, because ⌘ and Ctrl are the same intent', () => {
    const chord = PALETTE_SHORTCUT.chord!;

    expect(matchesShortcutChord(press('k', { metaKey: true }), chord)).toBe(true);
    expect(matchesShortcutChord(press('K', { ctrlKey: true }), chord)).toBe(true);
  });

  it('rejects a bare key where the chord asks for a modifier, and the reverse', () => {
    expect(matchesShortcutChord(press('k'), PALETTE_SHORTCUT.chord!)).toBe(false);
    expect(matchesShortcutChord(press('/', { metaKey: true }), SEARCH_SHORTCUT.chord!)).toBe(
      false
    );
  });

  it('rejects extra modifiers, which belong to some other binding', () => {
    const chord = RAIL_SHORTCUT.chord!;

    expect(matchesShortcutChord(press('\\', { metaKey: true, shiftKey: true }), chord)).toBe(
      false
    );
    expect(matchesShortcutChord(press('\\', { metaKey: true, altKey: true }), chord)).toBe(false);
  });

  it('checks shift for a letter and ignores it for punctuation', () => {
    // `⇧N` is a second chord; a reader holding shift did not mean "new".
    expect(matchesShortcutChord(press('N', { shiftKey: true }), { key: 'n' })).toBe(false);
    expect(matchesShortcutChord(press('n'), { key: 'n' })).toBe(true);

    // `?` is shifted on most layouts and not on others, and the produced character has
    // already said which key was pressed.
    expect(
      matchesShortcutChord(press('?', { shiftKey: true }), SHORTCUT_SHEET_SHORTCUT.chord!)
    ).toBe(true);
    expect(matchesShortcutChord(press('?'), SHORTCUT_SHEET_SHORTCUT.chord!)).toBe(true);
  });
});

describe('the chips a shortcut prints', () => {
  it('derives them from the very chord it matches', () => {
    expect(formatShortcutKeys(PALETTE_SHORTCUT)).toEqual(['⌘', 'K']);
    expect(formatShortcutKeys(PREFERENCES_SHORTCUT)).toEqual(['⌘', ',']);
    expect(formatShortcutKeys(SEARCH_SHORTCUT)).toEqual(['/']);
  });

  it('draws a sequence as its two keys, and spells it as one then the other', () => {
    const projects = JUMP_SHORTCUTS.find((jump) => jump.navItemId === 'projects')!;

    expect(formatShortcutKeys(projects)).toEqual(['G', 'P']);
    expect(spellShortcut(projects)).toBe('G then P');
  });

  it('lets a documentation-only row state its own legends', () => {
    const move = DATA_TABLE_SHORTCUTS.find((shortcut) => shortcut.id === 'list-move')!;

    expect(formatShortcutKeys(move)).toEqual(['↑', '↓']);
    // Nothing matches it: the table answers those keys on the focused row itself.
    expect(move.chord).toBeUndefined();
    expect(move.sequence).toBeUndefined();
  });

  it('agrees with the chips the palette already prints on its action rows', () => {
    // HIVE-3.6 printed `N` and `I` beside "New project…" and "Import a spec…" and said this
    // ticket would bind them. Two spellings of one chord is exactly the drift to catch.
    for (const declaration of LIST_ACTION_SHORTCUTS) {
      const action = PALETTE_ACTIONS.find((entry) => entry.id === declaration.paletteActionId);

      expect(action).toBeDefined();
      expect(action!.keys).toEqual(formatShortcutKeys(declaration));
    }
  });
});

describe('where a printable shortcut may fire', () => {
  it.each([
    ['a text input', () => document.createElement('input')],
    ['a search input', () => Object.assign(document.createElement('input'), { type: 'search' })],
    ['a textarea', () => document.createElement('textarea')],
    ['a select', () => document.createElement('select')],
  ])('treats %s as somewhere the reader is typing', (_label, make) => {
    expect(isTypingTarget(make())).toBe(true);
  });

  it.each([
    ['a checkbox', 'checkbox'],
    ['a radio', 'radio'],
    ['a button', 'button'],
    ['a range', 'range'],
  ])('leaves %s alone — nothing is being typed there', (_label, type) => {
    const input = document.createElement('input');
    input.type = type;
    expect(isTypingTarget(input)).toBe(false);
  });

  it('treats a contenteditable subtree as typing, and a plain element as not', () => {
    const editable = document.createElement('div');
    // jsdom does not implement `isContentEditable`; the attribute alone leaves it false,
    // so the property is what the matcher reads and what this stands in for.
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    expect(isTypingTarget(editable)).toBe(true);

    expect(isTypingTarget(document.createElement('div'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('the registry', () => {
  it('fires a registered chord, and stops the moment its owner unmounts', () => {
    const run = jest.fn();
    const bindings = [{ ...PALETTE_SHORTCUT, run }];

    const { unmount } = render(<Bound bindings={bindings} />);
    expect(getActiveShortcuts()).toHaveLength(1);

    fireEvent.keyDown(document.body, { key: 'k', metaKey: true });
    expect(run).toHaveBeenCalledTimes(1);

    unmount();
    expect(getActiveShortcuts()).toHaveLength(0);

    fireEvent.keyDown(document.body, { key: 'k', metaKey: true });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('takes the keystroke, so the browser does not also act on it', () => {
    const bindings = [{ ...PALETTE_SHORTCUT, run: jest.fn() }];
    render(<Bound bindings={bindings} />);

    // `Ctrl+K` focuses the search bar in some browsers; taking it is the point.
    const answered = !fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    expect(answered).toBe(true);
  });

  it('lets the most recent registration win, so a page can take a key back', () => {
    const shell = jest.fn();
    const page = jest.fn();

    render(<Bound bindings={[{ ...SEARCH_SHORTCUT, run: shell }]} />);
    const later = render(<Bound bindings={[{ ...SEARCH_SHORTCUT, run: page }]} />);

    fireEvent.keyDown(document.body, { key: '/' });
    expect(page).toHaveBeenCalledTimes(1);
    expect(shell).not.toHaveBeenCalled();

    // …and hands it back when it goes.
    later.unmount();
    fireEvent.keyDown(document.body, { key: '/' });
    expect(shell).toHaveBeenCalledTimes(1);
  });

  it('never fires a printable shortcut while the reader is typing', () => {
    const run = jest.fn();
    render(<Bound bindings={[{ ...SEARCH_SHORTCUT, run }]} />);

    const field = document.createElement('input');
    document.body.appendChild(field);
    field.focus();

    fireEvent.keyDown(field, { key: '/' });
    expect(run).not.toHaveBeenCalled();

    field.remove();
  });

  it('does fire a command-modifier chord there, which is what its declaration asks for', () => {
    const run = jest.fn();
    render(<Bound bindings={[{ ...PALETTE_SHORTCUT, run }]} />);

    const field = document.createElement('textarea');
    document.body.appendChild(field);
    field.focus();

    fireEvent.keyDown(field, { key: 'k', metaKey: true });
    expect(run).toHaveBeenCalledTimes(1);

    field.remove();
  });

  it('ignores a keystroke something closer to the focus has already answered', () => {
    const run = jest.fn();
    render(<Bound bindings={[{ ...PALETTE_SHORTCUT, run }]} />);

    const event = new KeyboardEvent('keydown', {
      key: 'k',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    event.preventDefault();
    act(() => {
      document.body.dispatchEvent(event);
    });

    expect(run).not.toHaveBeenCalled();
  });

  it('ignores a held key: one gesture is one shortcut', () => {
    const run = jest.fn();
    render(<Bound bindings={[{ ...PALETTE_SHORTCUT, run }]} />);

    fireEvent.keyDown(document.body, { key: 'k', metaKey: true, repeat: true });
    expect(run).not.toHaveBeenCalled();
  });

  it('never matches a documentation-only row, whoever registered it', () => {
    const run = jest.fn();
    render(<Bound bindings={[{ ...DATA_TABLE_SHORTCUTS[0], run }]} />);

    fireEvent.keyDown(document.body, { key: 'ArrowDown' });
    fireEvent.keyDown(document.body, { key: 'ArrowUp' });
    expect(run).not.toHaveBeenCalled();
  });

  it('takes the key for a gated binding but does not run it', () => {
    const run = jest.fn();
    render(
      <Bound
        bindings={[
          { ...LIST_ACTION_SHORTCUTS[0], run, disabledReason: 'Select a workspace to use it.' },
        ]}
      />
    );

    const answered = !fireEvent.keyDown(document.body, { key: 'n' });
    expect(answered).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('a sequence — G, then a letter', () => {
  const projects = JUMP_SHORTCUTS.find((jump) => jump.navItemId === 'projects')!;
  const catalog = JUMP_SHORTCUTS.find((jump) => jump.navItemId === 'catalog')!;

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('fires on the second key, and not on the first', () => {
    const run = jest.fn();
    render(<Bound bindings={[{ ...projects, run }]} />);

    fireEvent.keyDown(document.body, { key: 'g' });
    expect(run).not.toHaveBeenCalled();

    fireEvent.keyDown(document.body, { key: 'p' });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('gives up after a second, so a later keystroke is its own again', () => {
    const jump = jest.fn();
    const sheet = jest.fn();
    render(
      <Bound
        bindings={[
          { ...projects, run: jump },
          { ...SHORTCUT_SHEET_SHORTCUT, run: sheet },
        ]}
      />
    );

    fireEvent.keyDown(document.body, { key: 'g' });
    act(() => {
      jest.advanceTimersByTime(SHORTCUT_SEQUENCE_TIMEOUT_MS + 1);
    });

    fireEvent.keyDown(document.body, { key: 'p' });
    expect(jump).not.toHaveBeenCalled();

    // …and the leader is not still swallowing keys a second later.
    fireEvent.keyDown(document.body, { key: '?' });
    expect(sheet).toHaveBeenCalledTimes(1);
  });

  it('still answers a chord typed after the leader, rather than eating it', () => {
    const jump = jest.fn();
    const sheet = jest.fn();
    render(
      <Bound
        bindings={[
          { ...projects, run: jump },
          { ...SHORTCUT_SHEET_SHORTCUT, run: sheet },
        ]}
      />
    );

    fireEvent.keyDown(document.body, { key: 'g' });
    fireEvent.keyDown(document.body, { key: '?' });

    expect(jump).not.toHaveBeenCalled();
    expect(sheet).toHaveBeenCalledTimes(1);
  });

  it('tells apart two jumps that share a leader', () => {
    const toProjects = jest.fn();
    const toCatalog = jest.fn();
    render(
      <Bound
        bindings={[
          { ...projects, run: toProjects },
          { ...catalog, run: toCatalog },
        ]}
      />
    );

    fireEvent.keyDown(document.body, { key: 'g' });
    fireEvent.keyDown(document.body, { key: 'c' });

    expect(toCatalog).toHaveBeenCalledTimes(1);
    expect(toProjects).not.toHaveBeenCalled();
  });

  it('never starts while the reader is typing', () => {
    const run = jest.fn();
    render(<Bound bindings={[{ ...projects, run }]} />);

    const field = document.createElement('input');
    document.body.appendChild(field);
    field.focus();

    fireEvent.keyDown(field, { key: 'g' });
    fireEvent.keyDown(field, { key: 'p' });
    expect(run).not.toHaveBeenCalled();

    field.remove();
  });
});

describe('grouping the registry for the sheet', () => {
  it('prints scopes in reading order and drops the ones nothing is in', () => {
    const sections = groupShortcutsByScope([
      { ...DATA_TABLE_SHORTCUTS[0] },
      { ...PALETTE_SHORTCUT },
    ]);

    expect(sections.map((section) => section.scope)).toEqual(['global', 'list']);
    expect(SHORTCUT_SCOPE_ORDER.indexOf('global')).toBeLessThan(
      SHORTCUT_SCOPE_ORDER.indexOf('list')
    );
  });

  it('keeps one row per id, and it is the most recent registration', () => {
    const sections = groupShortcutsByScope([
      { ...SEARCH_SHORTCUT, description: 'the shell’s' },
      { ...SEARCH_SHORTCUT, description: 'the page’s' },
    ]);

    expect(sections).toHaveLength(1);
    expect(sections[0].shortcuts).toHaveLength(1);
    expect(sections[0].shortcuts[0].description).toBe('the page’s');
  });

  it('reads in the sheet’s order rather than in mount order', () => {
    // Registered back to front: the palette host mounts after the preferences host.
    const sections = groupShortcutsByScope([
      { ...SHORTCUT_SHEET_SHORTCUT },
      { ...PREFERENCES_SHORTCUT },
      { ...PALETTE_SHORTCUT },
    ]);

    expect(sections[0].shortcuts.map((shortcut) => shortcut.id)).toEqual([
      'palette',
      'preferences',
      'shortcuts',
    ]);
  });

  it('puts a shortcut nobody ordered at the end rather than hiding it', () => {
    const custom: ShortcutBinding = {
      id: 'surface-thing',
      scope: 'global',
      description: 'Something a page contributed',
      chord: { key: 'j' },
    };
    const sections = groupShortcutsByScope([custom, { ...PALETTE_SHORTCUT }]);

    expect(sections[0].shortcuts.map((shortcut) => shortcut.id)).toEqual([
      'palette',
      'surface-thing',
    ]);
  });
});

describe('registering without React', () => {
  it('accepts a plain array, for a caller that is not a component', () => {
    const run = jest.fn();
    const unregister = registerShortcuts([{ ...SEARCH_SHORTCUT, run }]);

    fireEvent.keyDown(document.body, { key: '/' });
    expect(run).toHaveBeenCalledTimes(1);

    unregister();
    fireEvent.keyDown(document.body, { key: '/' });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
