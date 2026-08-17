'use client';

/**
 * The Profile identity hero (HIVE-4.7, #5301).
 *
 * Authority: `docs/mockups/account/profile.html` §"Identity hero".
 *
 * The card the page opens with: a brand band, the reader's initials on it, their name, and
 * the one-line answer to "which account am I signed in as, and where?".
 *
 * What it replaced named three colours in a row — `from-indigo-500 via-violet-500
 * to-purple-500` for the band and `from-indigo-500 to-violet-600` for the avatar, with a
 * `ring-white dark:ring-gray-800` around it. None of those could follow a theme: in
 * Solarized the band stayed indigo and the ring stayed the wrong grey. The band is now the
 * mockup's honey→accent→surface wash, all three tokens, and the ring is `--bg-surface`,
 * which *is* the card it is cut out of.
 */

import * as React from 'react';
import { Building2, ShieldCheck } from 'lucide-react';

import { Avatar } from '@/app/components/ui/Avatar';
import { Badge } from '@/app/components/ui/Badge';
import { Card } from '@/app/components/ui/Card';

/** Props for {@link IdentityHero}. */
export interface IdentityHeroProps {
  /** The reader's display name, or nothing when they have not set one. */
  name?: string | null;
  /** Their address. */
  email?: string | null;
  /** The stable id the avatar's tint is hashed from, so the tint never moves. */
  seed?: string | null;
  /** The current workspace's display name, once the membership context has resolved it. */
  workspaceName?: string | null;
  /** The reader's role in it — `"Owner"`, `"Editor"` — when the context enriched the row. */
  workspaceRole?: string | null;
  /** Whether the session has a current workspace at all. */
  hasWorkspace: boolean;
  /** Whether authenticator 2FA is enrolled, for the summary badge. */
  twoFactorEnabled: boolean;
}

/**
 * The line under the name: address, workspace state, workspace and role.
 *
 * @param props See {@link IdentityHeroProps}.
 * @returns The parts that are actually known, in reading order.
 */
function IdentityMeta({
  email,
  workspaceName,
  workspaceRole,
  hasWorkspace,
}: Pick<IdentityHeroProps, 'email' | 'workspaceName' | 'workspaceRole' | 'hasWorkspace'>) {
  // The workspace line is drawn only once its name is known: "· Owner" beside nothing, or a
  // raw tenant uuid where a name belongs, is worse than the row being one item shorter for
  // the moment the membership context is in flight.
  const workspace = hasWorkspace && workspaceName
    ? [workspaceName, workspaceRole].filter(Boolean).join(' · ')
    : null;

  return (
    <div className="acct-identity__meta">
      {email ? <span className="acct-identity__email">{email}</span> : null}
      {hasWorkspace ? (
        <Badge status="active">
          <Building2 aria-hidden />
          Tenant active
        </Badge>
      ) : null}
      {workspace ? <span>{workspace}</span> : null}
    </div>
  );
}

/**
 * Draw the hero.
 *
 * @param props See {@link IdentityHeroProps}.
 * @returns The identity card.
 */
export function IdentityHero({
  name,
  email,
  seed,
  workspaceName,
  workspaceRole,
  hasWorkspace,
  twoFactorEnabled,
}: IdentityHeroProps) {
  return (
    <Card className="acct-identity" data-testid="profile-identity">
      <div className="acct-identity__band" aria-hidden />
      <div className="acct-identity__row">
        <Avatar
          size="xl"
          shape="hex"
          tone="brand"
          name={name || email}
          seed={seed}
          className="acct-identity__avatar"
        />
        <div className="acct-identity__body">
          <h2 className="acct-identity__name">{name || 'Unnamed user'}</h2>
          <IdentityMeta
            email={email}
            workspaceName={workspaceName}
            workspaceRole={workspaceRole}
            hasWorkspace={hasWorkspace}
          />
        </div>
        <div className="acct-identity__badges">
          <Badge variant="outline" size="lg" data-testid="profile-2fa-summary">
            <ShieldCheck aria-hidden />
            {twoFactorEnabled ? '2FA on' : '2FA off'}
          </Badge>
        </div>
      </div>
    </Card>
  );
}

export default IdentityHero;
