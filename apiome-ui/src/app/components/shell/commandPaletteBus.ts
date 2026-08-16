/**
 * The channel every surface uses to ask for the command palette (HIVE-3.6, #5292).
 *
 * The palette has three entry points that sit in three different component trees — the
 * rail's search trigger (inside `AppShell`), the `⌘K` chord (bound by the host itself, so
 * it works wherever focus is) and the preferences pane's Shortcuts tab — and none of them
 * is a component that could sensibly own the dialog for the others. So a
 * `CommandPaletteHost` registers itself here and any component anywhere calls
 * {@link openCommandPalette}.
 *
 * This is deliberately the same shape as `preferences/preferencesDrawerBus.ts`, down to the
 * stack-of-hosts rule: the pattern is already what the rail's other overlay uses, and two
 * different channels for two overlays that open from the same rail would be one more thing
 * to remember. Registration is a stack and only the most recently mounted host answers, so
 * a surface that ends up with two hosts opens one palette rather than two stacked.
 *
 * With no host mounted, {@link openCommandPalette} is a no-op and reports `false`, which is
 * what lets the rail hide its trigger rather than offer a button that does nothing — the
 * admin console's rail is specified with no `⌘K` at all (`docs/mockups/foundations/shell.html`,
 * "Admin shell": *no workspace switcher, no ⌘K search*).
 */

/** What a host is asked for: an optional query to open with, for a caller with a subject. */
export interface CommandPaletteRequest {
  /**
   * Text to prefill the palette's input with.
   *
   * A caller that means "show me the commands" passes `>`; the palette's own parser reads
   * the prefix exactly as it would if the reader had typed it.
   */
  query?: string;
}

/** Mounted hosts, most recent last. */
const hosts: Array<(request?: CommandPaletteRequest) => void> = [];

/** Anyone watching for a host to appear or go — see {@link subscribeCommandPalette}. */
const listeners = new Set<() => void>();

/** Tell every watcher that the set of mounted hosts changed. */
function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * Register a host's open callback for the life of its mount.
 *
 * @param open Called when a surface asks for the palette, with whatever it asked for.
 * @returns The unregister function, for the effect's cleanup.
 */
export function registerCommandPaletteHost(
  open: (request?: CommandPaletteRequest) => void
): () => void {
  hosts.push(open);
  notify();
  return () => {
    const index = hosts.lastIndexOf(open);
    if (index !== -1) hosts.splice(index, 1);
    notify();
  };
}

/**
 * Open the command palette.
 *
 * @param request What to open it with. Omitted, the palette opens empty — a caller that
 *   means "search or jump to" should not have to name a query.
 * @returns `true` when a host answered; `false` when none is mounted, which is the case on
 *          a surface that has not adopted the palette.
 */
export function openCommandPalette(request?: CommandPaletteRequest): boolean {
  const host = hosts[hosts.length - 1];
  if (!host) return false;
  host(request);
  return true;
}

/**
 * Whether a host is mounted right now.
 *
 * @returns `true` when {@link openCommandPalette} would reach a palette.
 */
export function isCommandPaletteMounted(): boolean {
  return hosts.length > 0;
}

/**
 * Watch for a host arriving or leaving.
 *
 * The rail's trigger needs this rather than a one-shot read, because effects commit
 * child-first: the trigger sits inside the rail and the host is a later sibling, so a
 * trigger that asked once — on its own mount — would always be told "no palette" and never
 * render. Pair it with {@link isCommandPaletteMounted} through `useSyncExternalStore`.
 *
 * @param listener Called whenever the set of mounted hosts changes.
 * @returns The unsubscribe function.
 */
export function subscribeCommandPalette(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
