'use client';

/**
 * The Repositories sub-nav (HIVE-7.3, #5320).
 *
 * Authority: `docs/mockups/sources/repositories.html` — the `tabs` row under the page title,
 * which the mockup's **Notes → Adds** list introduces as the replacement for the four
 * `secondary` buttons the page header used to carry.
 *
 * ### Why this is a tab row and not four buttons
 *
 * The four screens are siblings: Repositories, Discovered specs, Quota & rate limits and
 * Webhook IP allowlist are four views of the same subject, and only one of them is ever on
 * screen. Drawn as buttons beside "Add repository" they read as four *actions* on the current
 * page, and at the Largest font scale they pushed the primary action onto a second line.
 *
 * ### Why the strip is links rather than `ui/Tabs`
 *
 * Each tab is a route. Radix's `Tabs` owns a selected value and swaps panels inside one
 * document, which is the wrong model for four separate pages — it would announce a tablist
 * whose panels do not exist. So the strip is `<nav>` + `<Link>`, wearing the shared tab
 * classes from `ui/tabStyles` so it is visually the same control, with `aria-current="page"`
 * carrying "you are here" instead of `aria-selected`.
 *
 * Selection is derived from `usePathname()` by longest matching prefix, so
 * `/ade/dashboard/repositories/new` and `/ade/dashboard/repositories/{id}` still light the
 * Repositories tab rather than falling through to nothing.
 */

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Activity, FolderGit2, Library, ShieldCheck } from 'lucide-react';

import { TAB_COUNT_CLASS, TAB_LIST_CLASS, tabTriggerClass } from '@/app/components/ui/tabStyles';
import { REPOSITORIES_NAV_TABS, type RepositoriesNavTab } from './repositoriesModel';

/** The glyph each tab draws, matching the mockup's lucide names. */
const TAB_ICON: Readonly<
  Record<RepositoriesNavTab['id'], React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>>
> = {
  list: FolderGit2,
  catalog: Library,
  telemetry: Activity,
  allowlist: ShieldCheck,
};

/**
 * Which tab a path belongs to.
 *
 * Longest matching `href` wins, so a nested route (`…/repositories/catalog/anything`) resolves
 * to its own tab and everything else under `…/repositories` resolves to the list.
 *
 * @param pathname The current path, or null before the router has one.
 * @returns The active tab's id, or null when the path is not under this section at all.
 */
export function activeRepositoriesTab(
  pathname: string | null | undefined
): RepositoriesNavTab['id'] | null {
  if (!pathname) return null;
  let best: RepositoriesNavTab | null = null;
  for (const tab of REPOSITORIES_NAV_TABS) {
    if (pathname === tab.href || pathname.startsWith(`${tab.href}/`)) {
      if (!best || tab.href.length > best.href.length) best = tab;
    }
  }
  return best?.id ?? null;
}

export interface RepositoriesSubNavProps {
  /**
   * Counts to print beside a tab's label, by tab id.
   *
   * Only the tabs whose figure this screen actually knows are passed: the list page knows how
   * many repositories it loaded, and nothing else. A tab with no entry draws no chip rather
   * than a zero, because "none" and "not counted" are different facts.
   */
  counts?: Partial<Record<RepositoriesNavTab['id'], number>>;
  /** Force the active tab instead of deriving it from the path (for the gallery and tests). */
  active?: RepositoriesNavTab['id'];
}

/**
 * Render the sub-nav. See {@link RepositoriesSubNavProps}.
 *
 * @returns A navigation landmark holding the four route links.
 */
export function RepositoriesSubNav({ counts, active }: RepositoriesSubNavProps) {
  const pathname = usePathname();
  const current = active ?? activeRepositoriesTab(pathname) ?? 'list';

  return (
    <nav aria-label="Repositories sections" className={TAB_LIST_CLASS} data-testid="repositories-subnav">
      {REPOSITORIES_NAV_TABS.map((tab) => {
        const Icon = TAB_ICON[tab.id];
        const isActive = tab.id === current;
        const count = counts?.[tab.id];
        return (
          <Link
            key={tab.id}
            href={tab.href}
            title={tab.description}
            aria-current={isActive ? 'page' : undefined}
            data-testid={`repositories-tab-${tab.id}`}
            className={tabTriggerClass({ active: isActive })}
          >
            <Icon className="repo-tab__glyph" aria-hidden />
            {tab.label}
            {typeof count === 'number' ? <span className={TAB_COUNT_CLASS}>{count.toLocaleString()}</span> : null}
          </Link>
        );
      })}
    </nav>
  );
}

export default RepositoriesSubNav;
