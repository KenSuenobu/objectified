/**
 * The pure half of the account surfaces (HIVE-4.7, #5301).
 *
 * `profile-hive-redesign.test.tsx` renders the page; this suite pins the four decisions the
 * page makes before any of it is drawn, because each one has a way of being quietly wrong:
 *
 *   1. **A stamp that does not parse is `null`, not today.** `new Date('nonsense')` is an
 *      `Invalid Date`, every arithmetic on it is `NaN`, and `NaN` renders as the literal text
 *      "NaN" three components downstream.
 *   2. **The session meter counts time spent, out of the lifetime Better Auth is configured
 *      with** — not out of the mockup's illustrative seven days, and never below zero for a
 *      session that has already lapsed.
 *   3. **A user-agent is a hint.** Every Chromium browser claims to be Safari and two of them
 *      claim to be Chrome, so the order the tokens are matched in *is* the algorithm; anything
 *      unrecognised comes back `null` rather than as a guess.
 *   4. **The sign-in list is the reader's, not the product's.** Password first, then the
 *      linked identities in the order the query returns them, with the handle the provider
 *      actually gave.
 */

import {
  SESSION_LIFETIME_DAYS,
  buildSignInMethods,
  describeDevice,
  formatLoginStamp,
  providerLabel,
  readSessionLifetime,
} from '@/app/components/ade/account/accountModel';
import { SESSION_EXPIRES_IN_SECONDS } from '@lib/auth/better-auth-session';

/* -------------------------------------------------------------------------
   1. Login stamps
   ------------------------------------------------------------------------- */

describe('formatLoginStamp', () => {
  it('prints MM/DD/YY hh:mm AM, the shape Profile has always shown', () => {
    // Built from local components rather than parsed from a UTC string, so the assertion is
    // about the *format* rather than about the machine's time zone.
    expect(formatLoginStamp(new Date(2026, 7, 15, 9, 12))).toBe('08/15/26 09:12 AM');
  });

  it('uses a 12-hour clock with a PM marker after noon', () => {
    expect(formatLoginStamp(new Date(2026, 0, 2, 17, 5))).toBe('01/02/26 05:05 PM');
  });

  it('accepts an ISO string, which is what the users table hands it', () => {
    const iso = new Date(2026, 7, 15, 9, 12).toISOString();
    expect(formatLoginStamp(iso)).toBe('08/15/26 09:12 AM');
  });

  it('answers null for nothing, and for anything that is not a date', () => {
    expect(formatLoginStamp(null)).toBeNull();
    expect(formatLoginStamp(undefined)).toBeNull();
    expect(formatLoginStamp('')).toBeNull();
    expect(formatLoginStamp('not a date')).toBeNull();
  });
});

/* -------------------------------------------------------------------------
   2. The session meter
   ------------------------------------------------------------------------- */

describe('readSessionLifetime', () => {
  /** A fixed "now" so nothing here depends on when the suite runs. */
  const NOW = new Date(2026, 7, 17, 12, 0, 0);

  /**
   * A moment a whole number of days after {@link NOW}.
   *
   * @param days How many days ahead.
   * @returns The date.
   */
  function inDays(days: number): Date {
    return new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000);
  }

  it('reads its denominator from the Better Auth configuration, not from a literal', () => {
    expect(SESSION_LIFETIME_DAYS).toBe(SESSION_EXPIRES_IN_SECONDS / (60 * 60 * 24));
    expect(SESSION_LIFETIME_DAYS).toBe(30);
  });

  it('counts days remaining, and spends the rest of the lifetime', () => {
    const lifetime = readSessionLifetime(inDays(24), NOW);
    expect(lifetime?.daysRemaining).toBe(24);
    expect(lifetime?.totalDays).toBe(30);
    expect(lifetime?.daysElapsed).toBe(6);
    expect(lifetime?.valueLabel).toBe('24d left of 30');
  });

  it('never reports a negative remainder for a session that already lapsed', () => {
    const lifetime = readSessionLifetime(inDays(-3), NOW);
    expect(lifetime?.daysRemaining).toBe(0);
    expect(lifetime?.daysElapsed).toBe(30);
    expect(lifetime?.valueLabel).toBe('0d left of 30');
  });

  it('never reports more than the lifetime, however far ahead the expiry is', () => {
    const lifetime = readSessionLifetime(inDays(400), NOW);
    expect(lifetime?.daysRemaining).toBe(30);
    expect(lifetime?.daysElapsed).toBe(0);
  });

  it('floors the remainder, so most of a day left is not rounded up to two', () => {
    const almostTwo = new Date(NOW.getTime() + (1.9 * 24 * 60 * 60 * 1000));
    expect(readSessionLifetime(almostTwo, NOW)?.daysRemaining).toBe(1);
  });

  it('prints the absolute stamp and the long weekday date the card has always shown', () => {
    const expires = new Date(2026, 7, 22, 9, 12);
    const lifetime = readSessionLifetime(expires, NOW);
    expect(lifetime?.absolute).toBe(expires.toLocaleString());
    expect(lifetime?.weekday).toBe('Saturday, August 22, 2026');
  });

  it('answers null rather than an empty meter when there is no readable expiry', () => {
    expect(readSessionLifetime(null, NOW)).toBeNull();
    expect(readSessionLifetime('', NOW)).toBeNull();
    expect(readSessionLifetime('whenever', NOW)).toBeNull();
  });
});

/* -------------------------------------------------------------------------
   3. The device line
   ------------------------------------------------------------------------- */

describe('describeDevice', () => {
  const AGENTS: Readonly<Record<string, string>> = {
    'Chrome on macOS':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    'Safari on macOS':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    'Firefox on Windows':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
    'Edge on Windows':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0',
    'Chrome on Android':
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36',
    'Safari on iOS':
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    'Firefox on Linux':
      'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
  };

  it.each(Object.entries(AGENTS))('names %s', (expected, agent) => {
    expect(describeDevice(agent)).toBe(expected);
  });

  it('prefers the Chromium wrapper over the Chrome and Safari tokens it also carries', () => {
    // The whole reason the token lists are ordered. Edge advertises Chrome *and* Safari;
    // matching in declaration order is what stops it being called either.
    expect(describeDevice(AGENTS['Edge on Windows'])).toBe('Edge on Windows');
    expect(describeDevice(AGENTS['Chrome on macOS'])).toBe('Chrome on macOS');
  });

  it('names whichever half it can when it cannot name both', () => {
    expect(describeDevice('Mozilla/5.0 (Windows NT 10.0)')).toBe('Windows');
    expect(describeDevice('Firefox/127.0')).toBe('Firefox');
  });

  it('says nothing rather than guessing', () => {
    expect(describeDevice(null)).toBeNull();
    expect(describeDevice(undefined)).toBeNull();
    expect(describeDevice('')).toBeNull();
    expect(describeDevice('curl/8.6.0')).toBeNull();
  });
});

/* -------------------------------------------------------------------------
   4. Sign-in methods
   ------------------------------------------------------------------------- */

describe('buildSignInMethods', () => {
  it('lists the password first, then the linked identities in query order', () => {
    const rows = buildSignInMethods({
      hasPassword: true,
      accounts: [
        { provider: 'github', provider_username: 'ada-lovelace' },
        { provider: 'gitlab', provider_email: 'ada@example.com' },
      ],
    });

    expect(rows.map((row) => row.id)).toEqual(['password', 'github', 'gitlab']);
    expect(rows.map((row) => row.label)).toEqual(['Password', 'GitHub', 'GitLab']);
    expect(rows.map((row) => row.detail)).toEqual(['Set', 'ada-lovelace', 'ada@example.com']);
    expect(rows.map((row) => row.badge)).toEqual(['Active', 'Linked', 'Linked']);
  });

  it('omits the password row for an OAuth-only account', () => {
    const rows = buildSignInMethods({
      hasPassword: false,
      accounts: [{ provider: 'github', provider_username: 'ada' }],
    });
    expect(rows.map((row) => row.id)).toEqual(['github']);
    expect(rows[0].isPassword).toBe(false);
  });

  it('prefers the handle over the address, and says nothing when it has neither', () => {
    const rows = buildSignInMethods({
      hasPassword: false,
      accounts: [
        { provider: 'github', provider_username: 'ada', provider_email: 'ada@example.com' },
        { provider: 'okta' },
      ],
    });
    expect(rows[0].detail).toBe('ada');
    expect(rows[1].detail).toBeNull();
  });

  it('speaks the shared status vocabulary rather than inventing a state', () => {
    const rows = buildSignInMethods({
      hasPassword: true,
      accounts: [{ provider: 'github' }],
    });
    for (const row of rows) expect(row.status).toBe('active');
  });

  it('is empty for an account with no resolvable method at all', () => {
    expect(buildSignInMethods({ hasPassword: false, accounts: [] })).toEqual([]);
  });
});

describe('providerLabel', () => {
  it('uses the provider’s own capitalisation', () => {
    expect(providerLabel('github')).toBe('GitHub');
    expect(providerLabel('gitlab')).toBe('GitLab');
    expect(providerLabel('azure')).toBe('Microsoft');
    expect(providerLabel('oidc')).toBe('OpenID Connect');
  });

  it('still reads as a word for a provider this build no longer knows', () => {
    expect(providerLabel('someprovider')).toBe('Someprovider');
  });
});
