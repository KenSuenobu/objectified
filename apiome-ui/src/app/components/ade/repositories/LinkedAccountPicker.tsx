'use client';

/**
 * The "Linked accounts" card (HIVE-7.4, #5321).
 *
 * Authority: `docs/mockups/sources/repository-new.html` card 2 (`.acct-tile`) — provider tiles
 * with the handle in mono, "Manage linked accounts →", auto-selection when exactly one account
 * is linked, and the empty sentence.
 *
 * ### The limitation is stated, not discovered
 *
 * The ticket's first acceptance criterion. Remote browsing has always been GitHub-only, and the
 * screen this replaces only admitted it *after* the reader had selected a GitLab account and
 * watched the picker fail to appear. {@link BROWSE_LIMITATION_NOTE} is drawn under the tiles
 * whenever a non-GitHub account is linked, and each such tile carries the same fact as a chip,
 * so the choice is informed before it is made rather than explained after.
 *
 * A non-browsable account is still selectable: it is a real account, and the reader may have
 * opened the card to check which handle is connected. What it does is show the picker's note
 * instead of a repository list.
 */

import * as React from 'react';
import Link from 'next/link';
import { Link2 } from 'lucide-react';

import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import { EmptyState } from '@/app/components/ui/EmptyState';
import { LoadingState } from '@/app/components/ui/LoadingState';
import { RadioGroup, RadioGroupItem } from '@/app/components/ui/RadioGroup';
import { cn } from '@lib/utils';

import { ProviderGlyph } from './ProviderBadge';
import {
  ACCOUNTS_AUTOSELECT_NOTE,
  ACCOUNTS_EMPTY_BODY,
  ACCOUNTS_EMPTY_TITLE,
  ACCOUNTS_LOADING,
  BROWSE_LIMITATION_NOTE,
  LINKED_ACCOUNTS_HREF,
  canBrowseRemotes,
  linkedAccountLabel,
  linkedAccountProvider,
  linkedAccountProviderName,
  type LinkedAccount,
} from './addRepositoryModel';

export interface LinkedAccountPickerProps {
  /** The accounts, already parsed. */
  accounts: readonly LinkedAccount[];
  /** Which account is selected, or null. */
  selectedId: string | null;
  /** Called with the newly selected account's id. */
  onSelect: (accountId: string) => void;
  /** The read is still in flight. */
  loading: boolean;
}

/**
 * Render the account tiles. See {@link LinkedAccountPickerProps}.
 *
 * @returns The loading state, the empty state, or the tiles with their notes.
 */
export function LinkedAccountPicker({
  accounts,
  selectedId,
  onSelect,
  loading,
}: LinkedAccountPickerProps) {
  const hasNonBrowsable = accounts.some((account) => !canBrowseRemotes(account.provider));

  if (loading) return <LoadingState message={ACCOUNTS_LOADING} />;

  if (accounts.length === 0) {
    return (
      <EmptyState
        variant="compact"
        tone="neutral"
        titleAs="h3"
        surface={false}
        icon={<Link2 />}
        title={ACCOUNTS_EMPTY_TITLE}
        description={ACCOUNTS_EMPTY_BODY}
        data-testid="repo-accounts-empty"
        action={
          <Button asChild variant="primary">
            <Link href={LINKED_ACCOUNTS_HREF}>Connect an account</Link>
          </Button>
        }
      />
    );
  }

  return (
    <>
      <RadioGroup
        value={selectedId ?? ''}
        onValueChange={onSelect}
        aria-label="Linked account"
        className="repo-new-accounts"
      >
        {accounts.map((account) => {
          const provider = linkedAccountProvider(account.provider);
          const browsable = canBrowseRemotes(account.provider);
          return (
            <RadioGroupItem
              key={account.id}
              value={account.id}
              id={`repo-account-${account.id}`}
              name="repo-account"
              data-testid={`repo-account-${account.id}`}
              className={cn('repo-new-account', account.id === selectedId && 'is-selected')}
              label={
                <>
                  {/* `.repo-provider` + `data-provider` is HIVE-7.3's tint table, reused
                      whole rather than restated: one provider palette in the product. */}
                  <span
                    className="repo-provider repo-new-account__mark"
                    data-provider={provider}
                    aria-hidden
                  >
                    <ProviderGlyph provider={provider} />
                  </span>
                  <span className="repo-new-account__text">
                    <span className="repo-new-account__provider">
                      {linkedAccountProviderName(account.provider)}
                    </span>
                    <span className="repo-new-account__handle mono">
                      {linkedAccountLabel(account)}
                    </span>
                  </span>
                  {browsable ? null : (
                    <Badge variant="outline" className="repo-new-account__chip">
                      URL only
                    </Badge>
                  )}
                </>
              }
            />
          );
        })}
      </RadioGroup>

      {accounts.length === 1 ? (
        <p className="repo-new-note" data-testid="repo-accounts-autoselect">
          {ACCOUNTS_AUTOSELECT_NOTE}
        </p>
      ) : null}

      {hasNonBrowsable ? (
        <p className="repo-new-note" data-testid="repo-browse-limitation">
          {BROWSE_LIMITATION_NOTE}
        </p>
      ) : null}
    </>
  );
}

export default LinkedAccountPicker;
