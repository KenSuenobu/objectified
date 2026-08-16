'use client';

import * as React from 'react';
import Link from 'next/link';
import { LogOut, Settings2 } from 'lucide-react';
import { Avatar } from '@/app/components/ui/Avatar';
import { Kbd } from '@/app/components/ui/Kbd';
import { ICON_SIZE, ICON_STROKE_WIDTH } from '@/app/components/ui/iconSizes';
import { openPreferences } from '@/app/components/ade/preferences/preferencesDrawerBus';
import { cn } from '@lib/utils';
import { signOutEverywhere } from '@lib/auth/sign-out-client';
import { RAIL_ITEM_CLASS, RAIL_ITEM_HOVER_CLASS, RailTooltip } from './railChrome';

/**
 * The rail footer — interim (HIVE-3.1, #5287; `DESIGN.md` §5.2 region 5).
 *
 * The finished footer is **HIVE-3.4 (#5290)**: Help & docs, Preferences, and a user button
 * opening a menu of Profile · Linked accounts · Preferences · What's new · Shortcuts ·
 * Admin console · All apps · Sign out, with the build string beneath. That menu depends on
 * this shell, so it cannot land in the same ticket.
 *
 * What ships here is the subset that must not disappear the moment the top bar stops
 * rendering — the pane the reader can already reach with `⌘,`, the profile page, and the
 * way out. Each is a plain row rather than a menu, so HIVE-3.4 replaces the region whole
 * instead of unpicking a half-built menu.
 *
 * *Not* here, and reachable elsewhere in the meantime: the workspace switcher (the row
 * above, `RailWorkspaceLink`), What's new and the build badge (HIVE-3.4), and the app
 * launcher — which is the rail's brand link, at the top.
 */

/** Props for {@link RailFooter}. */
export interface RailFooterProps {
  /** Display name of the signed-in user, when the session carries one. */
  userName?: string | null;
  /** Their email address — the second line of the user row. */
  userEmail?: string | null;
  /** Stable id the avatar tint is hashed from; falls back to the name. */
  userId?: string | null;
  /** Where the user row goes. */
  profileHref: string;
  /** Whether the rail is drawing icon-only, in which case every label moves to a tooltip. */
  iconRail: boolean;
  /**
   * Where sign-out returns to.
   *
   * Defaults to the login page, which is what `TopHeader` has always passed — the argument
   * exists so a test can assert the call without navigating a jsdom window.
   */
  signOutTo?: string;
}

/** Copy for a session that has not resolved a display name. */
const FALLBACK_USER_NAME = 'Your account';

/**
 * The rail footer.
 *
 * @param props See {@link RailFooterProps}.
 * @returns Preferences, the user row and sign-out, above a hairline.
 */
export default function RailFooter({
  userName,
  userEmail,
  userId,
  profileHref,
  iconRail,
  signOutTo = '/login',
}: RailFooterProps) {
  const name = userName?.trim() || FALLBACK_USER_NAME;

  /**
   * Sign out of every device, then land on the login page.
   *
   * The failure is logged rather than surfaced: `signOutEverywhere` already clears the
   * local session before it reaches the server, so a network error here means the reader
   * is signed out locally and the page they are on will bounce to `/login` anyway.
   */
  const handleSignOut = React.useCallback(() => {
    void signOutEverywhere(signOutTo).catch((error: unknown) => {
      console.error('Sign out failed:', error);
    });
  }, [signOutTo]);

  return (
    <div className="shrink-0 space-y-0.5 border-t border-border px-3 py-2">
      <RailTooltip label="Preferences (⌘,)" when={iconRail}>
        <button
          type="button"
          onClick={() => openPreferences()}
          data-testid="rail-preferences"
          className={cn(RAIL_ITEM_CLASS, RAIL_ITEM_HOVER_CLASS, 'text-fg-muted')}
        >
          <Settings2
            size={ICON_SIZE.rail}
            strokeWidth={ICON_STROKE_WIDTH}
            aria-hidden
            className="shrink-0 text-fg-subtle group-hover/item:text-fg"
          />
          <span className="rail-label min-w-0 flex-1 items-center justify-between gap-2">
            <span className="truncate">Preferences</span>
            <Kbd keys={['⌘', ',']} />
          </span>
        </button>
      </RailTooltip>

      <RailTooltip label={`${name} — profile`} when={iconRail}>
        <Link
          href={profileHref}
          data-testid="rail-user"
          className={cn(
            'rail-item flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left',
            'transition-colors duration-[var(--dur-fast)]',
            RAIL_ITEM_HOVER_CLASS
          )}
        >
          <Avatar size="sm" seed={userId ?? undefined} name={name} className="shrink-0" />
          <span className="rail-label min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-semibold leading-tight text-fg">{name}</span>
            {userEmail ? (
              <span className="truncate text-2xs text-fg-subtle">{userEmail}</span>
            ) : null}
          </span>
        </Link>
      </RailTooltip>

      <RailTooltip label="Sign out" when={iconRail}>
        <button
          type="button"
          onClick={handleSignOut}
          data-testid="rail-sign-out"
          className={cn(RAIL_ITEM_CLASS, RAIL_ITEM_HOVER_CLASS, 'text-fg-muted')}
        >
          <LogOut
            size={ICON_SIZE.rail}
            strokeWidth={ICON_STROKE_WIDTH}
            aria-hidden
            className="shrink-0 text-fg-subtle group-hover/item:text-fg"
          />
          <span className="rail-label min-w-0 flex-1 items-center">
            <span className="truncate">Sign out</span>
          </span>
        </button>
      </RailTooltip>
    </div>
  );
}
