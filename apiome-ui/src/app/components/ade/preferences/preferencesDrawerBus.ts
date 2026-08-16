/**
 * The channel every surface uses to ask for the preferences pane (HIVE-1.4, #5277).
 *
 * The pane is reachable from several places — the rail footer, the rail user menu, the
 * legacy header's profile menu and `⌘,` — which sit in different component trees. Rather
 * than lift the drawer above all of them (a provider each shell would have to remember to
 * mount, including the commercial Studio, which renders `TopHeader` under a layout of its
 * own), a {@link PreferencesDrawerHost} registers itself here and any component anywhere
 * calls {@link openPreferences}.
 *
 * Registration is a stack, and only the most recently mounted host answers. Two hosts are
 * not expected — `ConditionalHeader` renders `TopHeader` on every route except `/ade`,
 * which is exactly where `AdeHome` mounts its own — but if it ever happens, one drawer
 * opens rather than two stacked on top of each other.
 *
 * With no host mounted, {@link openPreferences} is a no-op and reports `false`, so a
 * caller can hide its entry point rather than offer a button that does nothing.
 */

/**
 * A pane a caller can ask for by name.
 *
 * The strings are `PreferencesDrawer`'s own tab ids. They are restated here rather than
 * imported so that the bus — which every entry point imports — stays free of the drawer's
 * module graph; `tests/preferences-drawer.test.tsx` asserts the two lists agree.
 */
export type PreferencesTabId = 'appearance' | 'account' | 'notifications' | 'shortcuts';

/** What a host can be asked to do. */
interface PreferencesDrawerHostControls {
  /** Show the pane, optionally on a named tab. */
  open: (tab?: PreferencesTabId) => void;
  /** Put it away, as `Esc` would. */
  close: () => void;
}

/** Mounted hosts, most recent last. */
const hosts: PreferencesDrawerHostControls[] = [];

/**
 * Register a host's controls for the life of its mount.
 *
 * @param controls What the host can do — see {@link PreferencesDrawerHostControls}. A
 *   plain function is accepted as the `open` callback alone, which is what every caller
 *   passed before HIVE-3.6 added {@link closePreferences}.
 * @returns The unregister function, for the effect's cleanup.
 */
export function registerPreferencesDrawerHost(
  controls: PreferencesDrawerHostControls | ((tab?: PreferencesTabId) => void)
): () => void {
  const entry: PreferencesDrawerHostControls =
    typeof controls === 'function' ? { open: controls, close: () => {} } : controls;

  hosts.push(entry);
  return () => {
    const index = hosts.lastIndexOf(entry);
    if (index !== -1) hosts.splice(index, 1);
  };
}

/**
 * Open the preferences pane.
 *
 * @param tab Which tab to land on. Omitted, the pane opens where it always does
 *   (Appearance) — a caller that means "settings" should not have to name a tab.
 * @returns `true` when a host answered; `false` when none is mounted, which is the case in
 *          a shell that has not adopted the pane yet.
 */
export function openPreferences(tab?: PreferencesTabId): boolean {
  const host = hosts[hosts.length - 1];
  if (!host) return false;
  host.open(tab);
  return true;
}

/**
 * Close the preferences pane.
 *
 * Exists for the hand-off HIVE-3.6 (#5292) introduced: the Shortcuts tab's command-palette
 * row opens the palette, and a palette stacked on top of the pane that launched it is two
 * overlays where the reader asked for one — worse still after the palette navigates, which
 * would leave the pane open over a page nobody opened it from.
 *
 * @returns `true` when a host answered; `false` when none is mounted.
 */
export function closePreferences(): boolean {
  const host = hosts[hosts.length - 1];
  if (!host) return false;
  host.close();
  return true;
}

/**
 * Whether a host is mounted right now.
 *
 * @returns `true` when {@link openPreferences} would reach a drawer.
 */
export function isPreferencesDrawerMounted(): boolean {
  return hosts.length > 0;
}
