'use client';

import Link from 'next/link';
import React from 'react';
import { ChevronRight, Link as LinkIcon, User } from 'lucide-react';

/**
 * The Account tab of the preferences pane (HIVE-1.4, #5277; `DESIGN.md` §4.1).
 *
 * Deliberately only links. Name, email, password, two-factor and the linked identity
 * providers are account state with server-side rules of their own and full pages that
 * already own them; a second copy in a drawer would be a second place for those rules to
 * be enforced — and the design document says in as many words that the pane never
 * duplicates them.
 */

/** One destination the tab offers. */
interface AccountLink {
  /** Stable id, and the React key. */
  id: string;
  /** Route to send the reader to. */
  href: string;
  /** Link title. */
  title: string;
  /** What is managed there. */
  description: string;
  /** Leading icon. */
  icon: typeof User;
}

/** The account pages, in the order the rail lists them. */
const ACCOUNT_LINKS: readonly AccountLink[] = [
  {
    id: 'profile',
    href: '/ade/dashboard/profile',
    title: 'Profile',
    description: 'Name, email, password and two-factor authentication.',
    icon: User,
  },
  {
    id: 'linked-accounts',
    href: '/ade/dashboard/linked-accounts',
    title: 'Linked accounts',
    description: 'Identity providers connected to this account.',
    icon: LinkIcon,
  },
];

export interface AccountTabProps {
  /** Close the pane — following a link navigates away from the screen behind it. */
  onNavigate: () => void;
}

export default function AccountTab({ onNavigate }: AccountTabProps) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-fg-muted">
        Account details live on their own pages, so there is one place each setting is
        changed.
      </p>
      {ACCOUNT_LINKS.map((link) => {
        const Icon = link.icon;

        return (
          <Link
            key={link.id}
            href={link.href}
            onClick={onNavigate}
            data-account-link={link.id}
            className="flex items-center gap-3 rounded-md border border-border p-3 no-underline transition-colors hover:border-border-strong hover:bg-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <Icon className="h-4 w-4 shrink-0 text-fg-muted" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-fg">{link.title}</span>
              <span className="block text-xs text-fg-muted">{link.description}</span>
            </span>
            <ChevronRight className="h-4 w-4 shrink-0 text-fg-faint" aria-hidden />
          </Link>
        );
      })}
    </div>
  );
}
