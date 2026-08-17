/**
 * The channel every surface uses to ask for the shortcuts sheet (HIVE-3.7, #5293).
 *
 * The same shape as `preferences/preferencesDrawerBus.ts` and `commandPaletteBus.ts`, for
 * the same reason and deliberately not a third pattern: the sheet has entry points in three
 * different component trees — the `?` chord, the rail user menu's *Keyboard shortcuts* row
 * and the preferences pane's Shortcuts tab — and none of them is a component that could
 * sensibly own the dialog for the others. A {@link ShortcutsHost} registers itself here and
 * any component anywhere calls {@link openShortcutSheet}.
 *
 * Registration is a stack and only the most recently mounted host answers, so a surface that
 * ends up with two hosts opens one sheet rather than two.
 *
 * With no host mounted, {@link openShortcutSheet} is a no-op and reports `false`, which is
 * what lets a caller fall back rather than offer a row that does nothing.
 */

/** Mounted hosts, most recent last. */
const hosts: Array<() => void> = [];

/** Anyone watching for a host to appear or go — see {@link subscribeShortcutSheet}. */
const listeners = new Set<() => void>();

/** Tell every watcher that the set of mounted hosts changed. */
function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * Register a host's open callback for the life of its mount.
 *
 * @param open Called when a surface asks for the sheet.
 * @returns The unregister function, for the effect's cleanup.
 */
export function registerShortcutSheetHost(open: () => void): () => void {
  hosts.push(open);
  notify();
  return () => {
    const index = hosts.lastIndexOf(open);
    if (index !== -1) hosts.splice(index, 1);
    notify();
  };
}

/**
 * Open the shortcuts sheet.
 *
 * @returns `true` when a host answered; `false` when none is mounted, which is the case on a
 *          surface that has not adopted the shell's overlays.
 */
export function openShortcutSheet(): boolean {
  const host = hosts[hosts.length - 1];
  if (!host) return false;
  host();
  return true;
}

/**
 * Whether a host is mounted right now.
 *
 * @returns `true` when {@link openShortcutSheet} would reach a sheet.
 */
export function isShortcutSheetMounted(): boolean {
  return hosts.length > 0;
}

/**
 * Watch for a host arriving or leaving.
 *
 * Effects commit child-first, so a control inside the shell that asked once — on its own
 * mount — would be told "no sheet" and never hear otherwise. Pair it with
 * {@link isShortcutSheetMounted} through `useSyncExternalStore`, as `RailSearchTrigger`
 * does for the palette.
 *
 * @param listener Called whenever the set of mounted hosts changes.
 * @returns The unsubscribe function.
 */
export function subscribeShortcutSheet(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
