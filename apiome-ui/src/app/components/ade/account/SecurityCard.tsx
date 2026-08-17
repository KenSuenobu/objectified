'use client';

/**
 * Profile's Security card (HIVE-4.7, #5301).
 *
 * Authority: `docs/mockups/account/profile.html` §"Security" — the password guidance, a rule,
 * the embedded two-factor block, and the page's one primary action across the footer.
 *
 * The two-factor block arrives as a slot rather than as an import so this file stays free of
 * the auth client: the card is a *frame*, and the thing it frames is the route's own
 * `TwoFactorSettings`. That is also what lets the card be rendered in a test with a stub in
 * that slot.
 *
 * ### The one primary action
 *
 * DESIGN.md §7 gives a screen one primary button. On Profile it is **Change password** — the
 * footer of this card — which is why "Edit name" in the page header is `outline` and "Enable
 * 2FA" inside the block is the primary of its own sub-state rather than of the page.
 */

import * as React from 'react';
import { KeyRound, LockKeyhole, Shield } from 'lucide-react';

import { Button } from '@/app/components/ui/Button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/app/components/ui/Card';
import { ICON_SIZE } from '@/app/components/ui/iconSizes';

/** Props for {@link SecurityCard}. */
export interface SecurityCardProps {
  /** The route's `TwoFactorSettings`, or a stand-in for it. */
  twoFactor: React.ReactNode;
  /** Open the Change password dialog. */
  onChangePassword: () => void;
}

/**
 * Draw the card.
 *
 * @param props See {@link SecurityCardProps}.
 * @returns The Security card.
 */
export function SecurityCard({ twoFactor, onChangePassword }: SecurityCardProps) {
  return (
    <Card data-testid="profile-security">
      <CardHeader className="acct-card__header">
        <CardTitle className="acct-card__title">
          <Shield size={ICON_SIZE.dense} aria-hidden />
          Security
        </CardTitle>
        <span className="acct-card__note">Password and account security</span>
      </CardHeader>
      <CardContent className="acct-section">
        <div className="acct-row">
          <span className="acct-glyph acct-glyph--accent" aria-hidden>
            <LockKeyhole />
          </span>
          <div className="acct-row__body">
            <div className="acct-row__title">Password</div>
            <p className="acct-row__desc">
              Use a strong, unique password. Change it periodically or if you suspect it has been
              compromised.
            </p>
          </div>
        </div>

        <hr className="acct-rule" />

        {twoFactor}
      </CardContent>
      <CardFooter className="acct-card__footer">
        <Button
          variant="primary"
          className="w-full"
          onClick={onChangePassword}
          data-testid="profile-change-password-open"
        >
          <KeyRound aria-hidden />
          Change password
        </Button>
      </CardFooter>
    </Card>
  );
}

export default SecurityCard;
