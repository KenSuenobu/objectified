// SideNav.tsx
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import React from 'react';
import { useAuthSession } from '@lib/auth/session-client';
import { Settings2 } from 'lucide-react';
import { useDarkMode } from '@/app/hooks/useDarkMode';
import { openPreferences } from '@/app/components/ade/preferences/preferencesDrawerBus';
import { ICON_SIZE } from '@/app/components/ui/iconSizes';
import {
  getPlatformNavGroups,
  getPlatformUserMenuItems,
  isPlatformNavItemActive,
  type ResolvedPlatformNavItem,
} from '@lib/platform-nav';
import { resolvePlatformNavIcon } from '@lib/platform-nav-icons';

/**
 * The dashboard sidebar.
 *
 * Since HIVE-3.2 (#5288) it renders entirely from the navigation model in
 * `lib/platform-nav.ts`: this component owns the *chrome* — headings, hover and
 * active treatment, the tenant-gated disabled state — and knows nothing about
 * which destinations exist, where they live or when they are reachable. Adding
 * a nav entry is a change to the model, not to this file.
 *
 * Two later tickets consume the same model: HIVE-3.1 replaces this sidebar with
 * the collapsible `AppShell` rail, and HIVE-3.8 deletes this component once
 * nothing renders it.
 */

/** One rendered run of destinations: a model group, or the account footer. */
interface SideNavSection {
  /** Stable key. */
  id: string;
  /** Heading; omitted for the leading, unlabelled run (Home). */
  label?: string;
  items: ResolvedPlatformNavItem[];
}

/**
 * Heading for the account destinations.
 *
 * DESIGN.md §6 files Profile and Linked accounts under the rail footer's user
 * menu, which arrives with HIVE-3.4. Until it does they keep their own section
 * here so neither route becomes unreachable — the *items* still come from the
 * model, only this heading is local.
 */
const ACCOUNT_SECTION_LABEL = 'Account';

const DashboardSideNav: React.FC = () => {
  const pathname = usePathname();
  const { data: session } = useAuthSession();
  const isDark = useDarkMode();

  const currentTenantId = (session?.user as { current_tenant_id?: string })?.current_tenant_id;

  const sections: SideNavSection[] = [
    ...getPlatformNavGroups({ currentTenantId }),
    {
      id: 'account',
      label: ACCOUNT_SECTION_LABEL,
      items: getPlatformUserMenuItems({ currentTenantId }),
    },
  ];

  const sidebarBg = isDark
    ? 'linear-gradient(180deg, #172033 0%, #0f172a 100%)'
    : 'linear-gradient(180deg, #ffffff 0%, #f8fafc 100%)';
  const sidebarShadow = isDark ? '4px 0 18px rgba(2, 6, 23, 0.32)' : '4px 0 18px rgba(15, 23, 42, 0.06)';

  return (
    <aside
      /* `w-sidenav` is `--sidenav-w` (17.5rem = the old 280px), so the column travels with
         the font-size preference instead of clipping its own labels at the larger scales
         (HIVE-1.6). The inline `width: 280` that used to shadow this class is gone with it. */
      className="flex h-full w-sidenav shrink-0 flex-col border-r-0"
      style={{
        boxSizing: 'border-box',
        background: sidebarBg,
        boxShadow: sidebarShadow,
      }}
    >
      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-4">
        {sections.map((section, index) => (
          <div key={section.id} className={index < sections.length - 1 ? 'mb-6' : ''}>
            {section.label ? (
            <div
              className="flex items-center gap-2 px-3 py-2 font-semibold text-2xs uppercase tracking-[0.08em]"
              style={{ color: isDark ? '#94a3b8' : '#64748b' }}
            >
              <span
                className="w-1 h-1 rounded-full opacity-60"
                style={{ backgroundColor: '#6366f1' }}
              />
              {section.label}
            </div>
            ) : null}
            <ul className={`m-0 list-none space-y-1 p-0 ${section.label ? 'mt-1' : ''}`}>
              {section.items.map((item) => {
                const Icon = resolvePlatformNavIcon(item.icon);
                const active = isPlatformNavItemActive(item, pathname);

                const pillEl =
                  item.pill != null && item.pill !== '' ? (
                    <span
                      className="inline-flex shrink-0 items-center rounded-md border border-amber-200/90 bg-amber-50 px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wide text-amber-900 dark:border-amber-700/80 dark:bg-amber-950/60 dark:text-amber-100"
                      title="Feature in preview"
                    >
                      {item.pill}
                    </span>
                  ) : null;

                return (
                  <li key={item.id} className="mb-1">
                    {item.disabled ? (
                      <div
                        className="flex min-h-nav-item cursor-not-allowed items-center gap-3 rounded-lg px-3 py-2 opacity-40"
                        title={item.disabledReason}
                        aria-disabled="true"
                        style={{
                          color: isDark ? '#e2e8f0' : '#334155',
                        }}
                      >
                        <Icon size={ICON_SIZE.rail} className="flex-shrink-0 text-slate-500 dark:text-slate-400" />
                        <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
                          <span className="min-w-0 flex-1 truncate pr-1 text-sm font-medium">{item.label}</span>
                          {pillEl}
                        </span>
                      </div>
                    ) : (
                      <Link
                        href={item.href}
                        aria-current={active ? 'page' : undefined}
                        className={`flex min-h-nav-item items-center gap-3 rounded-lg px-3 py-2 transition-all duration-200 hover:bg-indigo-500/10 ${
                          active
                            ? 'border border-indigo-200 bg-indigo-500/10 dark:border-indigo-700/70'
                            : ''
                        }`}
                      >
                        <Icon
                          size={ICON_SIZE.rail}
                          className={`flex-shrink-0 transition-colors ${active ? 'text-indigo-500' : 'text-slate-500 dark:text-slate-400'}`}
                        />
                        <span
                          className="flex min-w-0 flex-1 items-center justify-between gap-2"
                          style={{
                            fontWeight: active ? 600 : 500,
                            color: active ? '#6366f1' : isDark ? '#e2e8f0' : '#334155',
                          }}
                        >
                          <span className="min-w-0 flex-1 truncate pr-1 text-sm">{item.label}</span>
                          {pillEl}
                        </span>
                        {active && <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-indigo-500" />}
                      </Link>
                    )}
                  </li>
                );
              })}
            </ul>
            {index < sections.length - 1 && (
              <hr className="my-4 border-indigo-500/10" />
            )}
          </div>
        ))}
      </div>
      {/*
       * Rail footer (HIVE-1.4, #5277) — the sidebar's own way into the preferences pane,
       * alongside the user menu and `⌘,`. The pane itself is hosted by `TopHeader`, which
       * renders on every route this sidebar does.
       */}
      <div className="shrink-0 border-t border-indigo-500/10 p-4">
        <button
          type="button"
          data-testid="sidenav-preferences"
          onClick={() => openPreferences()}
          title="Preferences (⌘,)"
          className="flex min-h-nav-item w-full cursor-pointer items-center gap-3 rounded-lg bg-transparent px-3 py-2 text-left transition-colors duration-200 hover:bg-indigo-500/10"
          style={{ color: isDark ? '#e2e8f0' : '#334155' }}
        >
          <Settings2 size={ICON_SIZE.rail} className="flex-shrink-0 text-slate-500 dark:text-slate-400" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">Preferences</span>
        </button>
      </div>
    </aside>
  );
};

export default DashboardSideNav;
