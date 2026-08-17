'use client';

import * as React from 'react';
import {
  SHORTCUT_SEQUENCE_TIMEOUT_MS,
  firesWhileTyping,
  formatShortcutKeys,
  isTypingTarget,
  matchesShortcutChord,
  type ShortcutBinding,
} from '@lib/shortcuts';

/**
 * The shortcut registry and the one keydown listener that serves it (HIVE-3.7, #5293).
 *
 * `lib/shortcuts.ts` says what a shortcut *is*; this says which ones are live, and turns a
 * keystroke into the right one. Two things follow from having a registry at all, and they
 * are the whole reason it exists:
 *
 *   1. **One listener, not fifteen.** Before this, four components each added their own
 *      `keydown` listener with a hand-written matcher. Sequences
 *      (`G` then `P`) are impossible that way — a leader key has to be remembered *across*
 *      handlers — and every new binding was another chance to forget the typing guard.
 *   2. **The sheet cannot lie.** `ShortcutSheet` renders {@link useActiveShortcuts}, so a
 *      shortcut is in the reference exactly while some component is answering it.
 *
 * ### Registering
 *
 * ```tsx
 * const bindings = React.useMemo(
 *   () => [{ ...SEARCH_SHORTCUT, scope: 'surface', run: () => inputRef.current?.focus() }],
 *   []
 * );
 * useShortcuts(bindings);
 * ```
 *
 * Registration is a stack and the **most recent registration wins**, so a list page that
 * binds `/` to its own filter box takes the key from the shell's palette for as long as it
 * is mounted, and hands it back when it unmounts. That is the same rule the preferences and
 * command-palette buses already use for their hosts.
 *
 * ### Where a keystroke may fire
 *
 * Nothing fires while the reader is typing unless its declaration says so
 * (`allowWhileTyping`, which only the three command-modifier chords set). A binding with no
 * `chord` and no `sequence` is documentation — see `lib/shortcuts.ts` — and the engine never
 * matches it, which is how `Esc` and a table's arrow keys appear in the sheet without this
 * module taking keys that belong to Radix and to `DataTable`.
 */

/** A live registration: a getter, so an owner's handlers stay current between renders. */
interface ShortcutSource {
  /** The bindings this owner is answering right now. */
  read: () => readonly ShortcutBinding[];
}

/** Mounted sources, most recent last. */
const sources: ShortcutSource[] = [];

/** Anyone watching the registry — the sheet, and any surface printing live chips. */
const listeners = new Set<() => void>();

/**
 * The flattened registry, oldest registration first, as React sees it.
 *
 * Cached because `useSyncExternalStore` compares snapshots by identity: rebuilding the array
 * on every read would re-render the sheet for ever. It is therefore a *view*, refreshed when
 * something registers or unregisters — the engine reads {@link liveBindings} instead, so a
 * handler that closed over last render's state is never what answers a keystroke.
 */
let snapshot: readonly ShortcutBinding[] = Object.freeze([]);

/** The empty snapshot the server renders against — nothing is registered during SSR. */
const SERVER_SNAPSHOT: readonly ShortcutBinding[] = Object.freeze([]);

/** Rebuild {@link snapshot} and tell every watcher. */
function notify(): void {
  snapshot = Object.freeze(liveBindings());
  for (const listener of listeners) listener();
}

/* -------------------------------------------------------------------------
   The engine
   ------------------------------------------------------------------------- */

/** The first key of a sequence, while it waits for the second. */
let pendingLeader: string | null = null;

/** The timer that gives up on that wait — `DESIGN.md` §8 allows one second. */
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

/** Forget a half-typed sequence. */
function clearPending(): void {
  pendingLeader = null;
  if (pendingTimer !== null) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
}

/**
 * Abandon any half-typed sequence.
 *
 * Exported for tests and for a surface that knows the reader has moved on (a route change,
 * an overlay opening): a leader left pending would otherwise turn the next keystroke into a
 * jump the reader did not ask for, up to a second later.
 */
export function resetShortcutSequence(): void {
  clearPending();
}

/**
 * Every registered binding as of *now*, read through each owner's ref.
 *
 * Not {@link snapshot}: that is refreshed only when the set of registrations changes, and a
 * component whose handler closes over its own state (`toggleRail` over the current rail)
 * hands out a new function on every render without ever re-registering. Reading live is what
 * makes the second press of `⌘\` the opposite of the first.
 *
 * @returns The registry, oldest registration first, as a fresh array the caller may reorder.
 */
function liveBindings(): ShortcutBinding[] {
  return sources.flatMap((source) => source.read());
}

/**
 * The bindings to consider for this keystroke, most recent registration first.
 *
 * @param typing Whether the event came from somewhere the reader is composing text.
 * @returns Candidate bindings, in precedence order.
 */
function candidates(typing: boolean): readonly ShortcutBinding[] {
  const ordered = liveBindings().reverse();
  return typing ? ordered.filter(firesWhileTyping) : ordered;
}

/**
 * Answer a binding: take the key, and run it unless it is disabled.
 *
 * A disabled binding still takes the event. The chord *is* bound — it simply cannot do
 * anything for this session — and letting the key fall through to the browser would make a
 * gated shortcut behave differently from a live one for no reason the reader could see.
 *
 * @param binding The matched binding.
 * @param event The keydown.
 */
function fire(binding: ShortcutBinding, event: KeyboardEvent): void {
  event.preventDefault();
  if (binding.disabledReason) return;
  binding.run?.(event);
}

/**
 * The one handler, for every registered binding.
 *
 * @param event The keydown, from the window (see {@link startListening}).
 */
function handleKeyDown(event: KeyboardEvent): void {
  // `defaultPrevented`: another handler has already answered this keystroke — a Radix menu's
  // type-ahead, a cmdk list. `repeat`: a held key is one gesture, not forty.
  if (event.defaultPrevented || event.repeat) return;

  const typing = isTypingTarget(event.target);
  const available = candidates(typing);

  // A sequence in progress takes the keystroke first: `G` then `P` must reach the jump even
  // though `P` on its own might one day be a chord of its own.
  if (pendingLeader !== null) {
    const leader = pendingLeader;
    clearPending();

    const completion = available.find(
      (binding) =>
        binding.sequence !== undefined &&
        sameKeyPress(binding.sequence[0], leader) &&
        sameKeyPress(binding.sequence[1], event.key)
    );
    if (completion) {
      fire(completion, event);
      return;
    }
    // Not a sequence after all — fall through, so `G` then `?` still opens the sheet.
  }

  const chord = available.find(
    (binding) => binding.chord !== undefined && matchesShortcutChord(event, binding.chord)
  );
  if (chord) {
    fire(chord, event);
    return;
  }

  // Nothing matched outright: this may be the first key of a sequence. Sequences are always
  // printable, so they never start while the reader is typing.
  if (typing || event.metaKey || event.ctrlKey || event.altKey) return;

  const startsSequence = available.some(
    (binding) => binding.sequence !== undefined && sameKeyPress(binding.sequence[0], event.key)
  );
  if (!startsSequence) return;

  event.preventDefault();
  pendingLeader = event.key;
  pendingTimer = setTimeout(clearPending, SHORTCUT_SEQUENCE_TIMEOUT_MS);
}

/**
 * Whether two key presses are the same key, case-insensitively.
 *
 * @param a One `KeyboardEvent.key`.
 * @param b The other.
 * @returns `true` when they are the same keystroke.
 */
function sameKeyPress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Whether the listener is on the window right now. */
let listening = false;

/**
 * Put the one listener on the window, if it is not there already.
 *
 * The **window** and not the document, for two reasons. A keydown dispatched on the
 * document bubbles up to the window, so this hears everything a document listener would;
 * and it runs *after* every document-level listener — Radix's `Esc`, cmdk's arrows — so the
 * `defaultPrevented` guard in {@link handleKeyDown} sees a keystroke that has already been
 * answered closer to the focus, rather than racing it.
 */
function startListening(): void {
  if (listening || typeof window === 'undefined') return;
  window.addEventListener('keydown', handleKeyDown);
  listening = true;
}

/** Take it off again once nothing is registered, so a torn-down tree leaves nothing behind. */
function stopListening(): void {
  if (!listening) return;
  window.removeEventListener('keydown', handleKeyDown);
  listening = false;
  clearPending();
}

/* -------------------------------------------------------------------------
   Registration
   ------------------------------------------------------------------------- */

/**
 * Register bindings for as long as the caller wants them.
 *
 * @param source The bindings, or a ref-like object holding them. A ref is what
 *   {@link useShortcuts} passes, so a re-rendered owner's handlers are always the current
 *   ones without the registry churning on every render.
 * @returns The unregister function.
 */
export function registerShortcuts(
  source: readonly ShortcutBinding[] | { readonly current: readonly ShortcutBinding[] }
): () => void {
  const entry: ShortcutSource = Array.isArray(source)
    ? { read: () => source as readonly ShortcutBinding[] }
    : { read: () => (source as { current: readonly ShortcutBinding[] }).current ?? [] };

  sources.push(entry);
  startListening();
  notify();

  return () => {
    const index = sources.lastIndexOf(entry);
    if (index !== -1) sources.splice(index, 1);
    if (sources.length === 0) stopListening();
    notify();
  };
}

/**
 * Every live binding, oldest registration first.
 *
 * @returns The registry snapshot — a stable array until something registers or unregisters.
 */
export function getActiveShortcuts(): readonly ShortcutBinding[] {
  return snapshot;
}

/**
 * Watch the registry.
 *
 * @param listener Called whenever a registration arrives or leaves.
 * @returns The unsubscribe function.
 */
export function subscribeShortcuts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * What the registry would have to change for the sheet to look different.
 *
 * Handlers are deliberately reduced to *whether there is one*: a component that rebuilds an
 * arrow function every render would otherwise re-register on every render, and nothing a
 * reader can see would have changed.
 *
 * @param bindings The bindings a caller is registering.
 * @returns A string that changes exactly when the printed reference does.
 */
function shortcutSignature(bindings: readonly ShortcutBinding[]): string {
  return bindings
    .map((binding) =>
      [
        binding.id,
        binding.scope,
        binding.description,
        binding.disabledReason ?? '',
        formatShortcutKeys(binding).join('+'),
        binding.run ? 'run' : 'doc',
      ].join(' ')
    )
    .join('');
}

/**
 * Register shortcuts for the life of a component.
 *
 * @param bindings What this component answers. Rebuilt every render is fine — the registry
 *   re-reads handlers through a ref and only re-publishes when the *documentation* changes
 *   (see {@link shortcutSignature}) — but memoising is still the tidier spelling.
 */
export function useShortcuts(bindings: readonly ShortcutBinding[]): void {
  const signature = shortcutSignature(bindings);

  const latest = React.useRef(bindings);
  // Every commit, before the registration effect below can re-run: the engine reads handlers
  // through this ref, so a stale closure is never what answers a keystroke.
  React.useEffect(() => {
    latest.current = bindings;
  });

  React.useEffect(() => registerShortcuts(latest), [signature]);
}

/**
 * The live registry, as React state.
 *
 * @returns Every registered binding, oldest first. Empty during SSR, so the sheet paints
 *   nothing the client then has to take away.
 */
export function useActiveShortcuts(): readonly ShortcutBinding[] {
  return React.useSyncExternalStore(
    subscribeShortcuts,
    getActiveShortcuts,
    () => SERVER_SNAPSHOT
  );
}
