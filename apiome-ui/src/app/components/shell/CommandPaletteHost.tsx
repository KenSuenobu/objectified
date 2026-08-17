'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { getPlatformNavGroups, type ResolvedPlatformNavGroup } from '@lib/platform-nav';
import {
  PALETTE_SHORTCUT,
  SEARCH_SHORTCUT,
  type ShortcutBinding,
} from '@lib/shortcuts';
import { useShortcuts } from '@/app/hooks/useShortcuts';
import CommandPalette from './CommandPalette';
import {
  registerCommandPaletteHost,
  type CommandPaletteRequest,
} from './commandPaletteBus';
import {
  buildCommandGroups,
  parseCommandQuery,
  type PaletteCommand,
} from './commandPaletteModel';
import { useCommandPaletteRecents } from './commandPaletteRecents';

/**
 * Mounts the command palette and answers requests to open it (HIVE-3.6, #5292).
 *
 * The same shape as `PreferencesDrawerHost` (HIVE-1.4), because the palette has the same
 * problem: three entry points in three component trees — the rail's search trigger, the
 * `⌘K` chord and the preferences pane's shortcut row — and no component among them that
 * could sensibly own the dialog for the others. The host registers on
 * `registerCommandPaletteHost()` and every entry point calls `openCommandPalette()`.
 *
 * ### Where it is mounted, and why exactly once
 *
 * The same three places `PreferencesDrawerHost` is mounted, which between them cover every
 * `/ade` route with exactly one host on each: `AppShell` (the dashboard), `AdeHome` (the
 * launcher, which draws no header) and `TopHeader` (everything else — Tools and the
 * commercial studio surface). The three are mutually exclusive by construction —
 * `ConditionalHeader` suppresses the header on the launcher and on every shell route — so
 * the acceptance criterion *`⌘K` opens from any `/ade` route* holds without two palettes
 * ever binding the chord at once.
 *
 * Mounting it in `AppShell` rather than in the `/ade` layout is also what gives the
 * dashboard's palette the *whole* navigation model: the shell has already resolved the
 * commercial destinations this licence is entitled to, and passes them in, so the palette
 * and the rail cannot offer different lists. `AppShell` can be told not to
 * (`commandPalette={false}`), which is what the admin console's rail needs —
 * `docs/mockups/foundations/shell.html` specifies it with *no ⌘K search*, because the admin
 * console has no workspace scope to search within.
 *
 * ### What it knows
 *
 * One field: the active workspace. It is passed in rather than read from the session,
 * because every chrome that mounts this already holds it — `AdeAppShell` from its session,
 * `TopHeader` from its own session bridge — and a second `useAuthSession()` here would both
 * duplicate that read and make the palette unmountable by a surface that injects its
 * session rather than providing one.
 *
 * Everything else follows from it: destinations come from the HIVE-3.2 navigation model
 * resolved for that workspace, exactly as the rail resolves them (commercial destinations
 * can be handed in by a chrome that has already fetched its entitlements —
 * {@link CommandPaletteHostProps.groups}), and Recent rows come from `localStorage`, scoped
 * to it.
 */

/** Props for {@link CommandPaletteHost}. */
export interface CommandPaletteHostProps {
  /**
   * Navigation groups to offer, gating already resolved.
   *
   * Defaults to `getPlatformNavGroups()` for {@link currentTenantId} — the first-party
   * model. A surface that has already resolved commercial destinations (as `AdeAppShell`
   * does for the rail) can pass its own list so the palette and the rail agree.
   */
  groups?: readonly ResolvedPlatformNavGroup[];
  /**
   * `current_tenant_id` from the session, if any.
   *
   * Gates the workspace-scoped rows and scopes the Recent group. Absent, the palette is the
   * one a reader with no workspace sees: every destination still listed, each saying why it
   * cannot be used.
   */
  currentTenantId?: string | null;
}

/**
 * The palette, wired to the surface that mounts it.
 *
 * @param props See {@link CommandPaletteHostProps}.
 * @returns The palette dialog; Radix keeps it out of the DOM while it is closed.
 */
export default function CommandPaletteHost({
  groups,
  currentTenantId = null,
}: CommandPaletteHostProps) {
  const router = useRouter();

  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');

  const { recents, record } = useCommandPaletteRecents(currentTenantId);

  const derivedGroups = React.useMemo(
    () => groups ?? getPlatformNavGroups({ currentTenantId }),
    [groups, currentTenantId]
  );

  const { commandsOnly } = parseCommandQuery(query);
  const commandGroups = React.useMemo(
    () =>
      buildCommandGroups({
        navGroups: derivedGroups,
        recents,
        currentTenantId,
        commandsOnly,
      }),
    [derivedGroups, recents, currentTenantId, commandsOnly]
  );

  /**
   * Open the palette, optionally with something already typed.
   *
   * Every open starts from the request rather than from the last search: a palette that
   * remembered what you typed a route ago would answer a question nobody asked.
   */
  const openPalette = React.useCallback((request?: CommandPaletteRequest) => {
    setQuery(request?.query ?? '');
    setOpen(true);
  }, []);

  // Answer `openCommandPalette()` for as long as this host is mounted.
  React.useEffect(() => registerCommandPaletteHost(openPalette), [openPalette]);

  // `⌘K` / `Ctrl+K` — which works wherever focus is, including inside a filter box, because
  // that is the case the palette exists for — and `/`, the *search* key of `DESIGN.md` §8.
  // Both are registered with the shared registry (HIVE-3.7), so they are in the `?` sheet
  // exactly while a palette is mounted to answer them, and a list page that wants `/` for
  // its own filter box registers over the top of this one while it is on screen.
  const shortcuts = React.useMemo<readonly ShortcutBinding[]>(
    () => [
      { ...PALETTE_SHORTCUT, run: () => openPalette() },
      { ...SEARCH_SHORTCUT, run: () => openPalette() },
    ],
    [openPalette]
  );
  useShortcuts(shortcuts);

  /**
   * Act on a chosen row: close, remember, then go.
   *
   * Closing first is what lets the dialog give focus back to whatever opened it before the
   * route changes — a navigation that happened while the trap was still up would leave the
   * caret in a dialog that no longer exists.
   *
   * Only *destinations* are remembered. An action is a thing you do, not a place you were,
   * and "Recent: New project…" would offer to repeat work rather than to resume it.
   *
   * @param command The row the reader chose.
   */
  const handleSelect = React.useCallback(
    (command: PaletteCommand) => {
      if (command.disabled) return;
      setOpen(false);

      if (command.href) {
        if (command.group !== 'action') {
          record({
            id: command.id.replace(/^recent-/, ''),
            label: command.label,
            href: command.href,
            meta: command.meta,
            icon: command.icon,
          });
        }
        router.push(command.href);
        return;
      }

      command.run?.();
    },
    [record, router]
  );

  return (
    <CommandPalette
      open={open}
      onOpenChange={setOpen}
      groups={commandGroups}
      query={query}
      onQueryChange={setQuery}
      onSelect={handleSelect}
    />
  );
}
