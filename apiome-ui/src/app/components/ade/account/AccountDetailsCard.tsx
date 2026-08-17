'use client';

/**
 * Profile's Account details card (HIVE-4.7, #5301).
 *
 * Authority: `docs/mockups/account/profile.html` §"Account details".
 *
 * Five tiles over two columns: name, address, user id, workspace, and — full width — the last
 * login. Every one of them is a fact the session or the users table already carries; the card
 * adds nothing and, per the mockup's Keeps list, loses nothing either.
 *
 * ### The copy affordance
 *
 * Both identifiers copy, and both confirm for two seconds by swapping the glyph for a check.
 * The confirmation is announced as well as drawn: the button's accessible name changes from
 * "Copy User ID" to "Copied User ID", so the feedback is not colour-and-shape alone
 * (DESIGN.md §9). The old button hard-coded `text-emerald-500` for the tick and
 * `hover:bg-indigo-50 dark:hover:bg-indigo-900/30` for its hover — the tick is `--ok` now and
 * the hover belongs to `Button`'s `ghost` variant.
 */

import * as React from 'react';
import { Building2, Check, Copy, LogIn, Pencil, User } from 'lucide-react';

import { Avatar } from '@/app/components/ui/Avatar';
import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/app/components/ui/Card';
import { ICON_SIZE } from '@/app/components/ui/iconSizes';
import { formatLoginStamp } from './accountModel';

/** How long the copy confirmation stays up, in milliseconds. */
const COPIED_RESET_MS = 2000;

/** Props for {@link CopyIdButton}. */
interface CopyIdButtonProps {
  /** What is being copied, as it appears in the button's name: `"User ID"`. */
  field: string;
  /** The value itself. */
  value: string;
  /** Whether this button is the one currently showing its confirmation. */
  copied: boolean;
  /**
   * Copy it.
   *
   * @param field The field name, which the parent uses as the confirmation's key.
   * @param value The value to write to the clipboard.
   */
  onCopy: (field: string, value: string) => void;
}

/**
 * The little copy button that lives at the trailing edge of an identifier tile.
 *
 * @param props See {@link CopyIdButtonProps}.
 * @returns The button.
 */
function CopyIdButton({ field, value, copied, onCopy }: CopyIdButtonProps) {
  const label = copied ? `Copied ${field}` : `Copy ${field}`;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="acct-tile__action"
      onClick={() => onCopy(field, value)}
      aria-label={label}
      title={label}
      data-testid={`profile-copy-${field.replace(/\s+/g, '-').toLowerCase()}`}
    >
      {copied ? <Check className="text-ok" aria-hidden /> : <Copy aria-hidden />}
    </Button>
  );
}

/** Props for {@link InfoTile}. */
interface InfoTileProps {
  /** The tile's caps label. */
  label: string;
  /** The value, already formatted. */
  children: React.ReactNode;
  /** Draw the value in the mono face — identifiers only. */
  mono?: boolean;
  /** Something pinned to the trailing edge: a copy button, a pencil, a badge. */
  action?: React.ReactNode;
  /** Run the tile across both columns. */
  wide?: boolean;
  /**
   * The full text, for a value the tile clips. A long address or a uuid is truncated to keep
   * the tile one line — the `title` is how the whole of it stays reachable with a pointer,
   * and the copy button is how it stays reachable without one.
   */
  title?: string;
  /** Test hook. */
  testId?: string;
}

/**
 * One labelled fact.
 *
 * @param props See {@link InfoTileProps}.
 * @returns The tile.
 */
function InfoTile({ label, children, mono, action, wide, title, testId }: InfoTileProps) {
  return (
    <div className={wide ? 'acct-tile acct-tile--wide' : 'acct-tile'} data-testid={testId}>
      <div className="acct-tile__label">{label}</div>
      <div className="acct-tile__value">
        <span className={mono ? 'acct-tile__text mono' : 'acct-tile__text'} title={title}>
          {children}
        </span>
        {action}
      </div>
    </div>
  );
}

/** Props for {@link AccountDetailsCard}. */
export interface AccountDetailsCardProps {
  /** The reader's display name, or nothing when unset. */
  name?: string | null;
  /** Their address. */
  email?: string | null;
  /** Whether the address has been verified, as the session reports it. */
  emailVerified?: boolean;
  /** The account's id. */
  userId?: string | null;
  /** The current workspace's id, or nothing when none is selected. */
  tenantId?: string | null;
  /** The current workspace's display name, once the membership context resolves it. */
  workspaceName?: string | null;
  /**
   * The last-login timestamp: `undefined` while the lookup is in flight, `null` when the
   * account has none, otherwise the stamp. The three states are three different sentences.
   */
  lastLoginAt?: string | null;
  /** Open the Edit name dialog. */
  onEditName: () => void;
}

/**
 * Draw the card.
 *
 * @param props See {@link AccountDetailsCardProps}.
 * @returns The Account details card.
 */
export function AccountDetailsCard({
  name,
  email,
  emailVerified,
  userId,
  tenantId,
  workspaceName,
  lastLoginAt,
  onEditName,
}: AccountDetailsCardProps) {
  const [copiedField, setCopiedField] = React.useState('');

  // One timer, cleared on unmount: without this, a reader who copies an id and navigates
  // away inside the two seconds gets a `setState` on an unmounted component.
  const resetTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    []
  );

  const handleCopy = React.useCallback(async (field: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(field);
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopiedField(''), COPIED_RESET_MS);
    } catch {
      // Clipboard unavailable (an insecure origin, a denied permission). Nothing is copied
      // and nothing is claimed to have been — the confirmation deliberately does not appear.
    }
  }, []);

  const loginStamp =
    lastLoginAt === undefined ? '…' : (formatLoginStamp(lastLoginAt) ?? '—');

  return (
    <Card data-testid="profile-account-details">
      <CardHeader className="acct-card__header">
        <CardTitle className="acct-card__title">
          <User size={ICON_SIZE.dense} aria-hidden />
          Account details
        </CardTitle>
        <span className="acct-card__note">Your identity and workspace information</span>
      </CardHeader>
      <CardContent>
        <div className="acct-tiles">
          <InfoTile
            label="Full name"
            testId="profile-tile-name"
            action={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="acct-tile__action"
                onClick={onEditName}
                aria-label="Edit name"
                title="Edit name"
                data-testid="profile-edit-name-tile"
              >
                <Pencil aria-hidden />
              </Button>
            }
          >
            {name || 'Not set'}
          </InfoTile>

          <InfoTile
            label="Email"
            testId="profile-tile-email"
            title={email ?? undefined}
            action={emailVerified ? <Badge status="verified">Verified</Badge> : undefined}
          >
            {email || 'Not set'}
          </InfoTile>

          <InfoTile
            label="User ID"
            mono
            testId="profile-tile-user-id"
            title={userId ?? undefined}
            action={
              userId ? (
                <CopyIdButton
                  field="User ID"
                  value={userId}
                  copied={copiedField === 'User ID'}
                  onCopy={handleCopy}
                />
              ) : undefined
            }
          >
            {userId ?? '—'}
          </InfoTile>

          {tenantId ? (
            <InfoTile
              label="Current tenant"
              testId="profile-tile-tenant"
              title={workspaceName ? `${workspaceName} · ${tenantId}` : tenantId}
              action={
                <CopyIdButton
                  field="Tenant ID"
                  value={tenantId}
                  copied={copiedField === 'Tenant ID'}
                  onCopy={handleCopy}
                />
              }
            >
              <span className="acct-tile__tenant">
                <Avatar size="xs" shape="hex" tone="brand" name={workspaceName || 'Workspace'} seed={tenantId} />
                {workspaceName ? <span className="acct-tile__tenant-name">{workspaceName}</span> : null}
                <span className="mono acct-tile__tenant-id">{tenantId}</span>
              </span>
            </InfoTile>
          ) : (
            <InfoTile label="Current tenant" testId="profile-tile-tenant">
              <span className="inline-flex items-center gap-1.5">
                <Building2 size={ICON_SIZE.dense} aria-hidden />
                None selected
              </span>
            </InfoTile>
          )}

          <InfoTile label="Last login" wide testId="profile-tile-last-login">
            <span className="inline-flex items-center gap-1.5">
              <LogIn size={ICON_SIZE.dense} aria-hidden />
              <span className="tabular-nums">{loginStamp}</span>
            </span>
          </InfoTile>
        </div>
      </CardContent>
    </Card>
  );
}

export default AccountDetailsCard;
