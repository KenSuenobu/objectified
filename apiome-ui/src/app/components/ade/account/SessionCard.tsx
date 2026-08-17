'use client';

/**
 * Profile's Session card (HIVE-4.7, #5301).
 *
 * Authority: `docs/mockups/account/profile.html` §"Session". Its Keeps list fixes the two
 * lines the card has always printed — the caps EXPIRES label over `toLocaleString()`, and the
 * long weekday date under it — and its Adds list asks for "remaining time + device" and
 * "Sign out everywhere".
 *
 * ### Why the meter counts time *spent*
 *
 * A `role="meter"` is a share of a finite quota where more is worse (`ui/metrics/Meter`), and
 * its tone is derived on that assumption: quiet, then warn at 80 %, then danger at the cap.
 * Feeding it days *remaining* would invert every one of those bands — a session with a day
 * left would read as healthy and a fresh one as critical. So the number is days elapsed out
 * of the session's 30-day lifetime, and the sentence beside it is the one the reader wants:
 * how many days are left.
 *
 * ### The device line
 *
 * `navigator.userAgent`, read in an effect rather than during render: it does not exist on
 * the server, and a component that reached for it while rendering would either crash the
 * server render or hydrate to different markup than it produced. It is a hint, so when
 * nothing recognisable comes back the line is simply not drawn (`describeDevice`).
 */

import * as React from 'react';
import { LogOut, MonitorSmartphone, Timer } from 'lucide-react';

import { Alert } from '@/app/components/ui/Alert';
import { Button } from '@/app/components/ui/Button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/app/components/ui/Card';
import { Meter } from '@/app/components/ui/metrics/Meter';
import { ICON_SIZE } from '@/app/components/ui/iconSizes';
import { revokeAllSessionsAndSignOut } from '@lib/auth/sign-out-client';
import { describeDevice, readSessionLifetime } from './accountModel';

/** Where a reader lands after signing every session out. */
const SIGN_OUT_DESTINATION = '/login';

/** Props for {@link SessionCard}. */
export interface SessionCardProps {
  /** The session's expiry, as `session.expires` carries it. */
  expires?: string | null;
  /**
   * Injectable sign-out, for the suite. Defaults to
   * {@link revokeAllSessionsAndSignOut} — the real one navigates, which a jsdom test cannot.
   */
  onSignOutEverywhere?: (callbackUrl: string) => Promise<boolean>;
}

/**
 * Draw the card.
 *
 * @param props See {@link SessionCardProps}.
 * @returns The Session card.
 */
export function SessionCard({
  expires,
  onSignOutEverywhere = revokeAllSessionsAndSignOut,
}: SessionCardProps) {
  const [device, setDevice] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    setDevice(describeDevice(typeof navigator === 'undefined' ? null : navigator.userAgent));
  }, []);

  const lifetime = readSessionLifetime(expires);

  const handleSignOut = React.useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const revoked = await onSignOutEverywhere(SIGN_OUT_DESTINATION);
      // The navigation is the success case, so this only ever runs when the revoke failed and
      // the local sign-out has not taken the page away yet.
      if (!revoked) setError('Other sessions could not be revoked. This browser was signed out.');
    } catch {
      setError('Could not sign out. Try again.');
    } finally {
      setBusy(false);
    }
  }, [onSignOutEverywhere]);

  return (
    <Card data-testid="profile-session">
      <CardHeader className="acct-card__header">
        <CardTitle className="acct-card__title">
          <Timer size={ICON_SIZE.dense} aria-hidden />
          Session
        </CardTitle>
        <span className="acct-card__note">Your current sign-in session</span>
      </CardHeader>
      <CardContent className="acct-session">
        <div className="acct-caps">Expires</div>
        {lifetime ? (
          <>
            <p className="acct-session__value" data-testid="profile-session-expires">
              {lifetime.absolute}
            </p>
            <p className="acct-session__date">{lifetime.weekday}</p>
            <div className="acct-session__meter">
              <Meter
                label="Session time used"
                value={lifetime.daysElapsed}
                max={lifetime.totalDays}
                showValue={false}
                data-testid="profile-session-meter"
              />
              {/* The figure is printed here rather than by the meter, in muted ink rather than
                  in the derived tone's. `METRIC_TONE_INK_CLASS.warn` is `--warn-fg`, which the
                  High contrast theme leaves at its light-palette value (`#8A5300`) — 3.31:1 on
                  that theme's black surface, a serious axe finding. The *bar* still carries the
                  tone, and `--warn` itself is re-tinted correctly, so nothing is lost: the tone
                  says "running out" and this says how much is left. */}
              <span className="acct-session__left" data-testid="profile-session-left">
                {lifetime.valueLabel}
              </span>
            </div>
          </>
        ) : (
          <p className="acct-session__value" data-testid="profile-session-expires">
            —
          </p>
        )}

        {device ? (
          <p className="acct-session__device" data-testid="profile-session-device">
            <MonitorSmartphone size={ICON_SIZE.dense} aria-hidden />
            {device}
          </p>
        ) : null}

        {error ? (
          <Alert variant="error" className="mt-3">
            {error}
          </Alert>
        ) : null}
      </CardContent>
      <CardFooter className="acct-card__footer">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleSignOut}
          disabled={busy}
          data-testid="profile-sign-out-everywhere"
        >
          <LogOut aria-hidden />
          {busy ? 'Signing out…' : 'Sign out everywhere'}
        </Button>
      </CardFooter>
    </Card>
  );
}

export default SessionCard;
