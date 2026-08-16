'use client';

import * as React from 'react';
import Link from 'next/link';
import { ChevronsLeft } from 'lucide-react';
import { BrandMark } from '@/app/components/brand';
import { TooltipProvider } from '@/app/components/ui/Tooltip';
import { ICON_SIZE } from '@/app/components/ui/iconSizes';
import { PreferencesBoundary, usePreferences } from '@/app/providers/PreferencesProvider';
import PreferencesDrawerHost from '@/app/components/ade/preferences/PreferencesDrawerHost';
import { matchesRailShortcut } from '@/app/components/ade/preferences/shortcuts';
import { cn } from '@lib/utils';
import type { ResolvedPlatformNavGroup } from '@lib/platform-nav';
import RailNav from './RailNav';
import { RAIL_ITEM_HOVER_CLASS, RailTooltip } from './railChrome';
import { useIconRail } from './useIconRail';

/**
 * `AppShell` — one chrome for the signed-in application (HIVE-3.1, #5287).
 *
 * Authority: `docs/mockups/DESIGN.md` §5.1–5.2 and `docs/mockups/foundations/shell.html`.
 *
 * The shell is a two-column CSS grid: a rail, then the page. It replaces the pair of
 * chromes `/ade/dashboard/**` used to draw — `TopHeader` above `DashboardSideNav`, roughly
 * 330 px of furniture before any content, with Home and Control Panel reachable from both
 * — with a single navigation system and nothing at all above the page.
 *
 * ### Regions, top to bottom
 *
 * | # | Region | Owner |
 * | --- | --- | --- |
 * | 1 | Brand lock-up → the app launcher | HIVE-1.5, here |
 * | 2 | Workspace switcher | HIVE-3.3's `WorkspaceSwitcher`, in the `workspace` slot |
 * | 3 | Search trigger (`⌘K`) | HIVE-3.6 (#5292) — `search` slot |
 * | 4 | Grouped navigation | HIVE-3.2's model, drawn by `RailNav` |
 * | 5 | Footer: preferences, user, sign out | HIVE-3.4 (#5290) — `footer` slot |
 *
 * Regions 2, 3 and 5 are **slots** rather than components, because each is a whole ticket
 * of behaviour that this one deliberately does not contain. They are render props, taking
 * the rail's own state, so a region can move a label into a tooltip exactly when the rail
 * does — the alternative, every region reaching for `useIconRail()` itself, spreads the
 * shell's state across components that have no other reason to know it.
 *
 * ### What is *not* React state
 *
 * Whether the rail is expanded or icon-only is decided in CSS, from `data-rail` (written
 * before first paint by the preferences boot script) and from a 900 px media query. React
 * never renders two different rails, so there is no hydration flip and no flash — see
 * `globals.css` § "Application shell and rail". {@link useIconRail} exists only for the
 * behaviour CSS cannot carry: which rows need a tooltip.
 */

/** What a rail region is told about the rail it sits in. */
export interface RailRegionContext {
  /** True when the rail is drawing icon-only, so labels are off screen. */
  iconRail: boolean;
}

/** A rail region: a function of the rail's state, so it can follow the collapse. */
export type RailRegion = (context: RailRegionContext) => React.ReactNode;

/** Props for {@link AppShell}. */
export interface AppShellProps {
  /** The page. Rendered inside `<main id="main-content">`. */
  children: React.ReactNode;
  /** Navigation groups from `getPlatformNavGroups()`, gating already resolved. */
  groups: readonly ResolvedPlatformNavGroup[];
  /** Current `usePathname()` value, for active state. */
  pathname: string | null;
  /** Where the brand lock-up goes — the "All apps" launcher (`DESIGN.md` §5.2). */
  brandHref?: string;
  /** The word under the brand: `Platform` in the app shell. */
  brandSub?: string;
  /** Region 2 — the workspace switcher. */
  workspace?: RailRegion;
  /** Region 3 — the command-palette trigger. */
  search?: RailRegion;
  /** Region 5 — the rail footer. */
  footer?: RailRegion;
}

/** Tooltip delay shared with the dashboard's own provider, so hovers feel identical. */
const TOOLTIP_DELAY_MS = 400;

/**
 * The shell frame: everything that needs the preferences and tooltip contexts.
 *
 * @param props See {@link AppShellProps}.
 * @returns The grid, the rail and the page.
 */
function AppShellFrame({
  children,
  groups,
  pathname,
  brandHref = '/ade',
  brandSub = 'Platform',
  workspace,
  search,
  footer,
}: AppShellProps) {
  const { preferences, toggleRail } = usePreferences();
  const iconRail = useIconRail();
  const collapsed = preferences.rail === 'collapsed';

  // `⌘\` (`Ctrl+\`) flips the rail from anywhere in the shell. It writes the *preference*,
  // which is what makes the state survive a reload and a route change without this
  // component owning any state of its own — `DESIGN.md` §5.2 lists the handle, the
  // shortcut and the Preferences switch as three ways to set one thing.
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!matchesRailShortcut(event)) return;
      event.preventDefault();
      toggleRail();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleRail]);

  const context: RailRegionContext = { iconRail };

  return (
    <div className="hive-shell relative">
      {/* First tab stop on every page in the shell: a keyboard reader should not have to
          walk twenty destinations to reach the content (`DESIGN.md` §9). */}
      <a
        href="#main-content"
        className={cn(
          'sr-only rounded-md px-3 py-2 text-sm font-medium',
          'focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50',
          'focus:bg-surface focus:text-fg focus:shadow-md'
        )}
      >
        Skip to content
      </a>

      <aside
        data-testid="app-rail"
        className="rail relative flex h-full min-h-0 flex-col overflow-visible border-r border-border bg-rail"
      >
        {/* The collapse handle rides the rail's edge: invisible until the rail is hovered
            or the handle itself is focused, and permanent once collapsed, because it is
            then the only way back (`.rail-handle` in globals.css). */}
        <button
          type="button"
          onClick={toggleRail}
          data-testid="rail-collapse"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar (⌘\\)' : 'Collapse sidebar (⌘\\)'}
          className={cn(
            'rail-handle absolute -right-3 top-6 z-10 grid size-6 place-items-center',
            'rounded-full border border-border bg-surface text-fg-subtle shadow-sm',
            'transition-colors duration-[var(--dur-fast)] hover:text-fg'
          )}
        >
          <ChevronsLeft
            size={ICON_SIZE.button}
            aria-hidden
            className={cn('transition-transform duration-[var(--dur-base)]', collapsed && 'rotate-180')}
          />
        </button>

        <div className="shrink-0 space-y-2 px-3 pb-2 pt-3">
          <RailTooltip label="Apiome — all apps" when={iconRail}>
            <Link
              href={brandHref}
              data-testid="rail-brand"
              aria-label="Apiome home"
              className={cn(
                'rail-item flex w-full items-center rounded-md px-1.5 py-1',
                'transition-colors duration-[var(--dur-fast)]',
                RAIL_ITEM_HOVER_CLASS
              )}
            >
              {/* Decorative: the link already carries the name, and the lock-up would
                  otherwise announce "Apiome" twice. */}
              <BrandMark variant="lockup" sub={brandSub} decorative />
            </Link>
          </RailTooltip>

          {workspace?.(context)}
          {search?.(context)}
        </div>

        <RailNav groups={groups} pathname={pathname} iconRail={iconRail} />

        {footer?.(context)}
      </aside>

      {/* The page scrolls inside itself, never the document: one scrollbar, and the rail
          stays put while a long table moves. */}
      <main
        id="main-content"
        // `-1` so the skip link *moves focus* into the page rather than only scrolling to
        // it: an anchor to a non-focusable element leaves the caret in the rail, and the
        // next Tab walks the destinations the reader just skipped.
        tabIndex={-1}
        className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-canvas outline-none"
      >
        {children}
      </main>

      {/* The preferences pane lives with the shell now that no header renders above it —
          `⌘,`, the footer row and anything else calling `openPreferences()` reach it here
          (HIVE-1.4's bus; only the newest host answers, so panes never stack). */}
      <PreferencesDrawerHost />
    </div>
  );
}

/**
 * The application shell.
 *
 * @param props See {@link AppShellProps}.
 * @returns The rail-and-page grid, with the contexts its rows need.
 */
export default function AppShell(props: AppShellProps) {
  return (
    // `PreferencesBoundary` rather than `PreferencesProvider`: this app always has one
    // above (root layout), and the boundary is what keeps the shell mountable by a host
    // that does not — the same guarantee the preferences pane makes.
    <PreferencesBoundary>
      <TooltipProvider delayDuration={TOOLTIP_DELAY_MS}>
        <AppShellFrame {...props} />
      </TooltipProvider>
    </PreferencesBoundary>
  );
}
