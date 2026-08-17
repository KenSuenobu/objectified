'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  getPlatformNavGroups,
  platformNavGatedReason,
  type ResolvedPlatformNavGroup,
  type ResolvedPlatformNavItem,
} from '@lib/platform-nav';
import {
  CLOSE_OVERLAY_SHORTCUT,
  JUMP_SHORTCUTS,
  LIST_ACTION_SHORTCUTS,
  SHORTCUT_SHEET_SHORTCUT,
  type ShortcutBinding,
} from '@lib/shortcuts';
import { useShortcuts } from '@/app/hooks/useShortcuts';
import { PALETTE_ACTIONS } from './commandPaletteModel';
import ShortcutSheet from './ShortcutSheet';
import { registerShortcutSheetHost } from './shortcutSheetBus';

/**
 * Mounts the shortcuts sheet and binds the shortcuts no single component owns
 * (HIVE-3.7, #5293).
 *
 * The other chords in the shell have an obvious owner: `⌘K` belongs to the palette host,
 * `⌘,` to the preferences host, `⌘\` to the shell that draws the rail. These do not —
 * a *jump* is not the rail's, an `N` that reaches the new-project dialog is not the projects
 * page's while the reader is somewhere else — so they live with the sheet that documents
 * them, and are registered through the same registry every other binding uses.
 *
 * ### Where it is mounted, and why exactly once
 *
 * The two places `PreferencesDrawerHost` and `CommandPaletteHost` are mounted, which between
 * them cover every `/ade` route with exactly one host on each: `AppShell` (every route with a
 * rail, Tools included since HIVE-3.8) and `AdeHome` (the launcher, the one route without
 * one). Being a shell route and being the launcher are mutually exclusive, which is what
 * makes *"`?` opens the sheet from anywhere"* true without two sheets ever binding the key.
 *
 * Unlike the palette, this host has no *off* switch. The admin console's rail is specified
 * with no `⌘K` (`docs/mockups/foundations/shell.html`), because it has no workspace scope to
 * search; a shell with no shortcut reference is not a thing the design asks for anywhere.
 *
 * ### What it knows
 *
 * The active workspace, for the same reason the palette host takes it: the jump destinations
 * come from the HIVE-3.2 navigation model resolved for that session, so a jump is gated for
 * exactly the reason the rail row above it is, and says so in the sheet rather than failing
 * silently.
 */

/** Props for {@link ShortcutsHost}. */
export interface ShortcutsHostProps {
  /**
   * Navigation groups to jump within, gating already resolved.
   *
   * Defaults to `getPlatformNavGroups()` for {@link currentTenantId}. A surface that has
   * already resolved commercial destinations (as `AdeAppShell` does for the rail) passes its
   * own list, so a jump and the rail cannot disagree about where a reader can go.
   */
  groups?: readonly ResolvedPlatformNavGroup[];
  /**
   * `current_tenant_id` from the session, if any.
   *
   * Absent, the workspace-scoped jumps and actions are registered but disabled, each stating
   * why in the sheet — the same treatment the palette gives its gated rows.
   */
  currentTenantId?: string | null;
}

/**
 * The sheet, and the shell's unowned bindings.
 *
 * @param props See {@link ShortcutsHostProps}.
 * @returns The sheet dialog; Radix keeps a closed dialog out of the DOM.
 */
export default function ShortcutsHost({ groups, currentTenantId = null }: ShortcutsHostProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);

  const openSheet = React.useCallback(() => setOpen(true), []);

  // Answer `openShortcutSheet()` for as long as this host is mounted.
  React.useEffect(() => registerShortcutSheetHost(openSheet), [openSheet]);

  const derivedGroups = React.useMemo(
    () => groups ?? getPlatformNavGroups({ currentTenantId }),
    [groups, currentTenantId]
  );

  /** Every destination this session can see, by id — what a jump resolves against. */
  const destinations = React.useMemo(() => {
    const byId = new Map<string, ResolvedPlatformNavItem>();
    for (const group of derivedGroups) {
      for (const item of group.items) byId.set(item.id, item);
    }
    return byId;
  }, [derivedGroups]);

  const bindings = React.useMemo<readonly ShortcutBinding[]>(() => {
    const jumps: ShortcutBinding[] = [];
    for (const jump of JUMP_SHORTCUTS) {
      const item = destinations.get(jump.navItemId);
      // A destination this licence does not have is not a shortcut this session has. Nothing
      // is registered, so nothing is printed — the sheet says only what is true here.
      if (!item || item.external) continue;

      jumps.push({
        ...jump,
        // The model's own label, so the sheet and the rail row read the same.
        description: item.label,
        disabledReason: item.disabled ? item.disabledReason : undefined,
        run: () => router.push(item.href),
      });
    }

    const actions: ShortcutBinding[] = [];
    for (const declaration of LIST_ACTION_SHORTCUTS) {
      const action = PALETTE_ACTIONS.find((entry) => entry.id === declaration.paletteActionId);
      if (!action?.href) continue;

      const gated = Boolean(action.requiresTenant) && !currentTenantId;
      const href = action.href;
      actions.push({
        ...declaration,
        description: action.label,
        disabledReason: gated ? platformNavGatedReason(action.label) : undefined,
        run: () => router.push(href),
      });
    }

    return [
      { ...SHORTCUT_SHEET_SHORTCUT, run: openSheet },
      // Documentation, not a binding: Radix closes whichever overlay is in front, and an
      // engine-level `Esc` would be a second opinion about which one that is.
      CLOSE_OVERLAY_SHORTCUT,
      ...jumps,
      ...actions,
    ];
  }, [destinations, currentTenantId, router, openSheet]);

  useShortcuts(bindings);

  return <ShortcutSheet open={open} onOpenChange={setOpen} />;
}
