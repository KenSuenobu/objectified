/**
 * The channel every surface uses to ask for the preferences pane (HIVE-1.4, #5277).
 *
 * The pane is reachable from three places — the sidebar footer, the user menu and `⌘,` —
 * which sit in three different component trees. Rather than lift the drawer above all of
 * them (a provider each shell would have to remember to mount, including the commercial
 * Studio, which renders `TopHeader` under a layout of its own), a
 * {@link PreferencesDrawerHost} registers itself here and any component anywhere calls
 * {@link openPreferences}.
 *
 * Registration is a stack, and only the most recently mounted host answers. Two hosts are
 * not expected — `ConditionalHeader` renders `TopHeader` on every route except `/ade`,
 * which is exactly where `AdeHome` mounts its own — but if it ever happens, one drawer
 * opens rather than two stacked on top of each other.
 *
 * With no host mounted, {@link openPreferences} is a no-op and reports `false`, so a
 * caller can hide its entry point rather than offer a button that does nothing.
 */

/** Mounted hosts, most recent last. */
const hosts: Array<() => void> = [];

/**
 * Register a host's open callback for the life of its mount.
 *
 * @param open Called when a surface asks for the pane.
 * @returns The unregister function, for the effect's cleanup.
 */
export function registerPreferencesDrawerHost(open: () => void): () => void {
  hosts.push(open);
  return () => {
    const index = hosts.lastIndexOf(open);
    if (index !== -1) hosts.splice(index, 1);
  };
}

/**
 * Open the preferences pane.
 *
 * @returns `true` when a host answered; `false` when none is mounted, which is the case in
 *          a shell that has not adopted the pane yet.
 */
export function openPreferences(): boolean {
  const host = hosts[hosts.length - 1];
  if (!host) return false;
  host();
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
