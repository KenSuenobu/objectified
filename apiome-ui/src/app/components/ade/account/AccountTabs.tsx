'use client';

/**
 * The account tab strip — Profile · Linked accounts · Preferences (HIVE-4.7, #5301).
 *
 * Authority: `docs/mockups/account/profile.html` and `account/linked-accounts.html`, which
 * draw the same strip in the page header, and `docs/mockups/DESIGN.md` §5.3 (a page header
 * may carry an underline tab row).
 *
 * The three personal surfaces used to be one click apart only through the rail's user menu:
 * Profile linked to Linked accounts in a card footer, Linked accounts linked back nowhere,
 * and the theme picker was a select box on Profile itself. The strip makes them a set.
 *
 * ### Why the third entry is a button
 *
 * Preferences is not a route — it is HIVE-1.4's right-hand pane, opened through
 * `preferencesDrawerBus`. Giving it an `href` would mean inventing a page that does not
 * exist; giving it a `<button>` inside the strip says plainly that it opens something here.
 * The `⌘,` chip is `Kbd`, which renders `aria-hidden` and disappears with the "Show keyboard
 * hints" preference, so the chord is advertised without being promised to a screen reader.
 *
 * ### `nav`, not `tablist`
 *
 * `role="tablist"` (which the mockup's static markup uses) tells assistive technology that
 * the controls select panels *on this page*. Two of these three navigate to another
 * document, so the honest landmark is a `nav`, with `aria-current="page"` on the entry the
 * reader is already on — the same pattern `PageHeader`'s breadcrumb uses.
 */

import * as React from 'react';
import Link from 'next/link';
import { CircleUser, Link as LinkIcon, Settings2 } from 'lucide-react';

import { Kbd } from '@/app/components/ui/Kbd';
import { ICON_SIZE } from '@/app/components/ui/iconSizes';
import { TAB_COUNT_CLASS, tabListClass, tabTriggerClass } from '@/app/components/ui/tabStyles';
import { openPreferences } from '@/app/components/ade/preferences/preferencesDrawerBus';

/** Which entry of the strip is the current one. */
export type AccountTabId = 'profile' | 'linked-accounts';

/** Route of the profile page. */
export const PROFILE_ROUTE = '/ade/dashboard/profile';

/** Route of the linked-accounts page. */
export const LINKED_ACCOUNTS_ROUTE = '/ade/dashboard/linked-accounts';

/** The two entries that are pages, in reading order. */
const ROUTE_TABS: readonly { id: AccountTabId; label: string; href: string; icon: React.ElementType }[] = [
  { id: 'profile', label: 'Profile', href: PROFILE_ROUTE, icon: CircleUser },
  { id: 'linked-accounts', label: 'Linked accounts', href: LINKED_ACCOUNTS_ROUTE, icon: LinkIcon },
];

/** Props for {@link AccountTabs}. */
export interface AccountTabsProps {
  /** The page drawing the strip. */
  current: AccountTabId;
  /**
   * A count beside the Linked accounts entry, as the mockup shows it.
   *
   * Omitted while the count is still loading, so the strip never flashes a `0` that is about
   * to become a `2`. A count of zero draws no chip either: "Linked accounts 0" reads as a
   * defect where the plain label reads as an invitation.
   */
  linkedCount?: number;
}

/**
 * Draw the strip.
 *
 * @param props See {@link AccountTabsProps}.
 * @returns The `nav` to hand `PageHeader`'s `tabs` slot.
 */
export function AccountTabs({ current, linkedCount }: AccountTabsProps) {
  return (
    <nav aria-label="Account" data-testid="account-tabs" className={tabListClass()}>
      {ROUTE_TABS.map((tab) => {
        const Icon = tab.icon;
        const active = tab.id === current;
        return (
          <Link
            key={tab.id}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            data-testid={`account-tab-${tab.id}`}
            className={tabTriggerClass({ active })}
          >
            <Icon size={ICON_SIZE.dense} aria-hidden />
            {tab.label}
            {tab.id === 'linked-accounts' && typeof linkedCount === 'number' && linkedCount > 0 ? (
              <span className={TAB_COUNT_CLASS}>{linkedCount}</span>
            ) : null}
          </Link>
        );
      })}

      <button
        type="button"
        onClick={() => openPreferences()}
        data-testid="account-tab-preferences"
        className={tabTriggerClass()}
      >
        <Settings2 size={ICON_SIZE.dense} aria-hidden />
        Preferences
        <Kbd keys={['⌘', ',']} />
      </button>
    </nav>
  );
}

export default AccountTabs;
