'use client';

import * as React from 'react';
import Link from 'next/link';
import { CircleHelp, Settings2 } from 'lucide-react';
import { Kbd } from '@/app/components/ui/Kbd';
import { ICON_SIZE, ICON_STROKE_WIDTH } from '@/app/components/ui/iconSizes';
import { openPreferences } from '@/app/components/ade/preferences/preferencesDrawerBus';
import { cn } from '@lib/utils';
import { HELP_ROUTE } from './appShellRoutes';
import { RAIL_ITEM_CLASS, RAIL_ITEM_HOVER_CLASS, RailTooltip } from './railChrome';
import UserMenu from './UserMenu';

/**
 * The rail footer (HIVE-3.4, #5290; `DESIGN.md` §5.2 region 5).
 *
 * Three rows, in the order the mockup draws them (`docs/mockups/assets/hive.js`
 * `.rail__bottom`): **Help & docs**, **Preferences** (`⌘,`), and the user button — an
 * avatar with a name and an email that opens the account menu.
 *
 * This region is the reason the top bar can be retired. Everything the header's right-hand
 * cluster carried now has a home: the profile menu and the version badge in
 * {@link UserMenu}, preferences here as a first-class row rather than a menu entry two
 * clicks in. HIVE-3.1 shipped an interim version of this file with a profile *link* where
 * the menu now is; that link is gone, and nothing it reached went with it.
 *
 * Two rows and a menu rather than everything in the menu, because the two are what a
 * reader wants without deciding to go looking: help when they are stuck, and preferences
 * because the theme, the density and the font size are the settings people actually
 * change. `DESIGN.md` §5.2 makes the same call.
 */

/** Props for {@link RailFooter}. */
export interface RailFooterProps {
  /** Display name of the signed-in user, when the session carries one. */
  userName?: string | null;
  /** Their email address — the second line of the user row. */
  userEmail?: string | null;
  /** Stable id the avatar tint is hashed from; falls back to the name. */
  userId?: string | null;
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

/**
 * The rail footer.
 *
 * @param props See {@link RailFooterProps}.
 * @returns Help, preferences and the user menu, above a hairline.
 */
export default function RailFooter({
  userName,
  userEmail,
  userId,
  iconRail,
  signOutTo,
}: RailFooterProps) {
  return (
    <div className="shrink-0 space-y-0.5 border-t border-border px-3 py-2">
      <RailTooltip label="Help & docs" when={iconRail}>
        <Link
          href={HELP_ROUTE}
          data-testid="rail-help"
          className={cn(RAIL_ITEM_CLASS, RAIL_ITEM_HOVER_CLASS, 'text-fg-muted')}
        >
          <CircleHelp
            size={ICON_SIZE.rail}
            strokeWidth={ICON_STROKE_WIDTH}
            aria-hidden
            className="shrink-0 text-fg-subtle group-hover/item:text-fg"
          />
          <span className="rail-label min-w-0 flex-1 items-center">
            <span className="truncate">Help &amp; docs</span>
          </span>
        </Link>
      </RailTooltip>

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

      <UserMenu
        userName={userName}
        userEmail={userEmail}
        userId={userId}
        iconRail={iconRail}
        signOutTo={signOutTo}
      />
    </div>
  );
}
