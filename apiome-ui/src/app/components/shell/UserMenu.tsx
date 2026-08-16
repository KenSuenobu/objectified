'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  ArrowUpRight,
  Ellipsis,
  Keyboard,
  LayoutGrid,
  LogOut,
  Settings2,
  ShieldHalf,
  Sparkles,
  type LucideIcon,
} from 'lucide-react';
import { Avatar } from '@/app/components/ui/Avatar';
import { Kbd } from '@/app/components/ui/Kbd';
import { ICON_SIZE, ICON_STROKE_WIDTH } from '@/app/components/ui/iconSizes';
import WhatsNewDialog from '@/app/components/ade/WhatsNewDialog';
import {
  openPreferences,
  type PreferencesTabId,
} from '@/app/components/ade/preferences/preferencesDrawerBus';
import { PLATFORM_USER_MENU_ITEMS } from '@lib/platform-nav';
import { resolvePlatformNavIcon } from '@lib/platform-nav-icons';
import { APP_VERSION_BADGE } from '@lib/app-version';
import { signOutEverywhere } from '@lib/auth/sign-out-client';
import { cn } from '@lib/utils';
import { ADMIN_CONSOLE_ROUTE, LAUNCHER_ROUTE } from './appShellRoutes';
import { RAIL_ITEM_HOVER_CLASS, RailTooltip } from './railChrome';
import {
  RAIL_MENU_ABOVE_CLASS,
  RAIL_MENU_ITEM_CLASS,
  RAIL_MENU_SEPARATOR_CLASS,
  RAIL_MENU_SURFACE_CLASS,
  useRailMenu,
} from './railMenu';
import { useWhatsNewUnread } from './whatsNewSeen';

/**
 * The rail footer's user menu (HIVE-3.4, #5290; `DESIGN.md` §5.2 region 5, §5.4).
 *
 * This is where the top bar's profile menu, its version badge and its What's New dialog
 * went — and where four things that were never in a menu at all now live. `TopHeader`
 * offered three rows (View profile, Preferences, Sign out) and a badge; the reader had to
 * *know* that `/admin` existed, that `/ade` was the launcher, that linked accounts had a
 * page, and that the shortcut list was a tab inside preferences. Every one of those is a
 * row here, which is the whole point of the ticket: discovery, not relocation.
 *
 * ### Where the rows come from
 *
 * Profile and Linked accounts are read from {@link PLATFORM_USER_MENU_ITEMS} — HIVE-3.2's
 * navigation model already reserves them for exactly this menu, so the destinations are
 * declared once and the command palette (HIVE-3.6) will find them there too. The rest are
 * shell affordances rather than modelled destinations: two of them open something in
 * place, one leaves the app, and one ends the session.
 *
 * ### The honey dot
 *
 * What's new carries a dot until the running build's notes have been opened
 * (`whatsNewSeen.ts`). "Seen" is per build string, so a reader who has read the notes sees
 * nothing until the next release — and the dot is decorative, with the unread state also
 * written into the row's accessible name.
 *
 * ### Opening upward
 *
 * The menu is anchored at the bottom of the rail, so it grows up rather than down
 * ({@link RAIL_MENU_ABOVE_CLASS}). Everything else — the roving arrow keys, `Esc` back to
 * the trigger, dismissal on an outside click or on focus leaving — is `railMenu.tsx`, the
 * same module the workspace switcher above it uses. The two menus behave identically
 * because they *are* the same menu.
 */

/** Copy for a session that has not resolved a display name. */
const FALLBACK_USER_NAME = 'Your account';

/** What the trigger promises, for a reader who cannot see the avatar or the ellipsis. */
const TRIGGER_ACTION = 'Account menu';

/** `id` of the popup, so the trigger's `aria-controls` can point at it. */
const MENU_POPUP_ID = 'rail-user-menu';

/** Accessible name of the menu itself. */
const MENU_LABEL = 'Account';

/**
 * One row of the menu.
 *
 * A row is either a destination (`href`) or an action (`onSelect`); a row with both is a
 * programming error the type deliberately does not permit.
 */
type UserMenuRow = {
  /** Stable id — the React key and the row's `data-testid` suffix. */
  id: string;
  /** The label, in the sentence case DESIGN.md §10 asks for. */
  label: string;
  /** Leading glyph. */
  icon: LucideIcon;
  /** Optional chord chip, right-aligned. */
  kbd?: readonly string[];
  /** True to draw the honey unread dot instead of a chord. */
  unread?: boolean;
  /** True to mark the row as leaving the Hive chrome (a trailing ↗). */
  leavesApp?: boolean;
  /** True for the destructive row: danger ink, per `hive.css` §17 `.is-danger`. */
  danger?: boolean;
} & ({ href: string; onSelect?: never } | { href?: never; onSelect: () => void });

/** Props for {@link UserMenu}. */
export interface UserMenuProps {
  /** Display name of the signed-in user, when the session carries one. */
  userName?: string | null;
  /** Their email address — the second line of the trigger and of the menu's identity block. */
  userEmail?: string | null;
  /** Stable id the avatar tint is hashed from; falls back to the name. */
  userId?: string | null;
  /** Whether the rail is drawing icon-only, in which case the name moves to a tooltip. */
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
 * The rail footer's user button and its menu.
 *
 * @param props See {@link UserMenuProps}.
 * @returns The user row and, when open, the 260 px menu it controls.
 */
export default function UserMenu({
  userName,
  userEmail,
  userId,
  iconRail,
  signOutTo = '/login',
}: UserMenuProps) {
  const [open, setOpen] = React.useState(false);
  const [whatsNewOpen, setWhatsNewOpen] = React.useState(false);
  const { unread, markSeen } = useWhatsNewUnread();

  const name = userName?.trim() || FALLBACK_USER_NAME;

  const {
    anchorRef,
    triggerRef,
    menuRef,
    closeMenu,
    onMenuKeyDown,
    focusFirstItem,
    focusLastItem,
    itemTabIndex,
    onItemFocus,
  } = useRailMenu({ open, onClose: () => setOpen(false) });

  /**
   * Which end of the list the next open should land on.
   *
   * A ref rather than state: it is read once, by the effect below, in the same commit the
   * menu opens — rendering never depends on it, so making it state would only add a render.
   */
  const landOnLastRef = React.useRef(false);

  // Opening a menu moves the caret into it (the WAI-ARIA menu-button pattern). Without
  // this the reader would open the menu and still be on the trigger, with `Tab` — not the
  // arrow keys — as the only way in; and the arrow handler lives on the menu element, so
  // it would not be listening yet either.
  React.useEffect(() => {
    if (!open) return;
    if (landOnLastRef.current) focusLastItem();
    else focusFirstItem();
    landOnLastRef.current = false;
  }, [open, focusFirstItem, focusLastItem]);

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

  /**
   * Close the menu, then open the preferences pane on a given tab.
   *
   * Order matters: the pane restores focus to whatever was focused when it opened, and a
   * menu row that is about to unmount is not somewhere focus can go back to. Closing with
   * `restoreFocus` first puts the caret on the trigger, which survives.
   *
   * @param tab Which tab the pane should land on.
   */
  const handleOpenPreferences = React.useCallback(
    (tab?: PreferencesTabId) => {
      closeMenu(true);
      openPreferences(tab);
    },
    [closeMenu]
  );

  /** Show the release notes and, in doing so, mark this build's notes as read. */
  const handleOpenWhatsNew = React.useCallback(() => {
    closeMenu(true);
    markSeen();
    setWhatsNewOpen(true);
  }, [closeMenu, markSeen]);

  /**
   * The rows, grouped by the separators `DESIGN.md` §5.4 draws between them.
   *
   * Rebuilt when the unread flag or a handler changes, which is what keeps the honey dot
   * and the row's accessible name in step.
   */
  const groups: readonly (readonly UserMenuRow[])[] = React.useMemo(
    () => [
      [
        ...PLATFORM_USER_MENU_ITEMS.map((item) => ({
          id: item.id,
          label: item.label,
          icon: resolvePlatformNavIcon(item.icon),
          href: item.href,
        })),
        {
          id: 'preferences',
          label: 'Preferences',
          icon: Settings2,
          kbd: ['⌘', ','],
          onSelect: () => handleOpenPreferences(),
        },
        {
          id: 'whats-new',
          label: "What's new",
          icon: Sparkles,
          unread,
          onSelect: handleOpenWhatsNew,
        },
        {
          id: 'shortcuts',
          label: 'Keyboard shortcuts',
          icon: Keyboard,
          kbd: ['?'],
          onSelect: () => handleOpenPreferences('shortcuts'),
        },
      ],
      [
        {
          id: 'admin-console',
          label: 'Admin console',
          icon: ShieldHalf,
          href: ADMIN_CONSOLE_ROUTE,
          leavesApp: true,
        },
        { id: 'all-apps', label: 'All apps', icon: LayoutGrid, href: LAUNCHER_ROUTE },
      ],
      [{ id: 'sign-out', label: 'Sign out', icon: LogOut, danger: true, onSelect: handleSignOut }],
    ],
    [handleOpenPreferences, handleOpenWhatsNew, handleSignOut, unread]
  );

  /** Every row in the order the arrow keys walk them; the roving index counts through it. */
  const flatRows = React.useMemo(() => groups.flat(), [groups]);

  return (
    <div ref={anchorRef} className="relative">
      <RailTooltip label={`${name} — ${TRIGGER_ACTION.toLowerCase()}`} when={iconRail}>
        <button
          ref={triggerRef}
          type="button"
          data-testid="rail-user"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? MENU_POPUP_ID : undefined}
          onClick={() => setOpen((current) => !current)}
          onKeyDown={(event) => {
            // ↓ opens onto the first row, ↑ onto the last — the two chords a menu button
            // is expected to answer even when it is closed.
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            event.preventDefault();
            landOnLastRef.current = event.key === 'ArrowUp';
            setOpen(true);
          }}
          className={cn(
            'rail-item flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left',
            'transition-colors duration-[var(--dur-fast)]',
            RAIL_ITEM_HOVER_CLASS
          )}
        >
          {/* Decorative: the name is written beside it, and read out by the `sr-only`
              span below once the collapsed rail has taken the label away. */}
          <Avatar size="sm" seed={userId ?? undefined} name={name} className="shrink-0" />
          <span className="sr-only">
            {TRIGGER_ACTION}
            {unread ? ' — 1 unread release note' : ''}
          </span>
          <span className="rail-label min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-semibold leading-tight text-fg">{name}</span>
            {userEmail ? (
              // `--fg-muted`, not `--fg-subtle`: the quieter step measures 2.8–2.9:1 on the
              // rail in the two lightest themes, and this is a line meant to be read. The
              // workspace row above it (HIVE-3.3) makes the same call for its meta line.
              <span className="truncate text-2xs text-fg-muted">{userEmail}</span>
            ) : null}
          </span>
          {/* The dot rides the trigger too, because a collapsed rail hides the label that
              would otherwise carry it — and an unread badge nobody can see is not one. */}
          {unread && (
            <span
              data-testid="rail-user-unread"
              aria-hidden
              className="size-2 shrink-0 rounded-full bg-honey"
            />
          )}
          <span className="rail-label shrink-0 items-center text-fg-subtle">
            <Ellipsis size={ICON_SIZE.button} aria-hidden />
          </span>
        </button>
      </RailTooltip>

      {open && (
        <div
          id={MENU_POPUP_ID}
          data-testid="user-menu"
          className={cn(RAIL_MENU_SURFACE_CLASS, RAIL_MENU_ABOVE_CLASS, 'w-65')}
        >
          {/*
           * The identity block and the build string are chrome *around* the menu, not part
           * of it: neither is actionable in the first case, and the second is a button —
           * and `role="menu"` may own nothing but menu items (axe `aria-required-children`,
           * critical). So the popup itself carries no role and `role="menu"` sits on the
           * element holding only the rows, exactly as the workspace switcher does with its
           * filter field.
           */}
          <div className="flex items-center gap-2 px-2.5 pb-2.5 pt-1.5">
            <Avatar size="default" seed={userId ?? undefined} name={name} className="shrink-0" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-semibold leading-tight text-fg">{name}</span>
              {userEmail ? (
                <span className="truncate text-xs text-fg-muted">{userEmail}</span>
              ) : null}
            </span>
          </div>

          <div
            ref={menuRef}
            role="menu"
            aria-label={MENU_LABEL}
            onKeyDown={onMenuKeyDown}
            className="flex flex-col"
          >
            {groups.map((rows, groupIndex) => (
              <React.Fragment key={rows[0].id}>
                {/* `role="none"`: the grouping is visual, and announced separators would
                    make the menu longer to listen to without making it clearer. */}
                {groupIndex > 0 && <div role="none" className={RAIL_MENU_SEPARATOR_CLASS} />}
                {rows.map((row) => (
                  <UserMenuItem
                    key={row.id}
                    row={row}
                    // The roving index is a position in the *flattened* list, because that
                    // is the order the arrow keys walk it.
                    index={flatRows.indexOf(row)}
                    itemTabIndex={itemTabIndex}
                    onItemFocus={onItemFocus}
                    onNavigate={() => closeMenu(false)}
                  />
                ))}
              </React.Fragment>
            ))}
          </div>

          {/*
           * The build string, and the third way to reach the release notes — the top bar's
           * version badge was a button that opened them, and retiring the bar must not
           * retire the affordance.
           */}
          <button
            type="button"
            data-testid="rail-build-badge"
            onClick={handleOpenWhatsNew}
            className={cn(
              'mono mt-1 rounded-sm px-2.5 py-1 text-left text-2xs text-fg-muted',
              'transition-colors duration-[var(--dur-fast)] hover:bg-subtle hover:text-fg'
            )}
          >
            {APP_VERSION_BADGE}
            <span className="sr-only"> — see what&apos;s new</span>
          </button>
        </div>
      )}

      <WhatsNewDialog isOpen={whatsNewOpen} onClose={() => setWhatsNewOpen(false)} />
    </div>
  );
}

/** Props for {@link UserMenuItem}. */
interface UserMenuItemProps {
  /** The row to draw. */
  row: UserMenuRow;
  /** Its position in the flattened row list. */
  index: number;
  /** `tabIndex` for that position, from `useRailMenu`. */
  itemTabIndex: (index: number) => number;
  /** Tell `useRailMenu` the pointer moved the roving index. */
  onItemFocus: (index: number) => void;
  /** Called when a destination row is chosen, so the menu can put itself away. */
  onNavigate: () => void;
}

/**
 * One menu row, as a link or a button depending on whether it goes somewhere.
 *
 * A destination is a real `<a>`, so middle-click, ⌘-click and "copy link address" all work
 * — a menu built entirely from buttons quietly takes those away. An action is a `<button>`,
 * because it is not a place.
 *
 * @param props See {@link UserMenuItemProps}.
 * @returns The row.
 */
function UserMenuItem({ row, index, itemTabIndex, onItemFocus, onNavigate }: UserMenuItemProps) {
  const Icon = row.icon;

  const content = (
    <>
      <Icon
        size={ICON_SIZE.dense}
        strokeWidth={ICON_STROKE_WIDTH}
        aria-hidden
        className={cn('shrink-0', row.danger ? 'text-danger' : 'text-fg-subtle')}
      />
      <span className="min-w-0 flex-1 truncate">{row.label}</span>
      {row.unread && (
        <>
          <span
            data-testid="whats-new-unread-dot"
            aria-hidden
            className="size-2 shrink-0 rounded-full bg-honey"
          />
          {/* The dot is colour alone; this is the same fact in words. */}
          <span className="sr-only">Unread</span>
        </>
      )}
      {row.kbd && <Kbd keys={row.kbd} className="shrink-0" />}
      {row.leavesApp && (
        <>
          <ArrowUpRight size={ICON_SIZE.button} aria-hidden className="shrink-0 text-fg-subtle" />
          <span className="sr-only">Opens outside this app</span>
        </>
      )}
    </>
  );

  const shared = {
    role: 'menuitem' as const,
    tabIndex: itemTabIndex(index),
    onFocus: () => onItemFocus(index),
    'data-testid': `user-menu-${row.id}`,
    className: cn(RAIL_MENU_ITEM_CLASS, row.danger && 'text-danger-fg'),
  };

  if (row.href) {
    return (
      <Link href={row.href} onClick={onNavigate} {...shared}>
        {content}
      </Link>
    );
  }

  return (
    <button type="button" onClick={row.onSelect} {...shared}>
      {content}
    </button>
  );
}
