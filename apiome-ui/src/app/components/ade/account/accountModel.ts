/**
 * What the account surfaces know, with no React in it (HIVE-4.7, #5301).
 *
 * Authority: `docs/mockups/account/profile.html` and `docs/mockups/DESIGN.md` §7 (the status
 * vocabulary), §10 (copy is sentence case, numbers are tabular).
 *
 * Profile is the densest form cluster in the app, so everything it can decide *without* a
 * DOM is decided here: how a login stamp reads, how much of a session is left, what browser
 * the reader is on, and which sign-in methods the account actually has. Those are the parts
 * a jsdom render cannot check the look of but can check the truth of, and pulling them out
 * is what lets `tests/account-model.test.ts` pin them directly.
 *
 * The rule the whole module follows: **it never invents a fact.** A stamp that does not
 * parse comes back `null` rather than as today's date, an unknown user-agent comes back
 * `null` rather than as "Chrome", and a session whose expiry is unreadable has no meter
 * instead of an empty one. The page prints the em dash; this module says there is nothing
 * to print.
 */

import { SESSION_EXPIRES_IN_SECONDS } from '@lib/auth/better-auth-session';

/** Seconds in a day, for the session arithmetic below. */
const SECONDS_PER_DAY = 60 * 60 * 24;

/** Milliseconds in a day. */
const MS_PER_DAY = SECONDS_PER_DAY * 1000;

/**
 * How long a session lives, in whole days — **30**, read from the Better Auth configuration
 * rather than restated.
 *
 * The session card's meter needs a denominator, and a hard-coded 7 (the mockup's number) or
 * 30 (today's real one) would silently start lying the day `SESSION_EXPIRES_IN_SECONDS`
 * moves. It is the same constant `buildBetterAuthSessionOptions()` hands the server.
 */
export const SESSION_LIFETIME_DAYS = Math.round(SESSION_EXPIRES_IN_SECONDS / SECONDS_PER_DAY);

/**
 * Parse a timestamp, refusing anything that is not one.
 *
 * `new Date(x)` answers `Invalid Date` for junk and every arithmetic on it yields `NaN`,
 * which renders as the literal text "NaN" several components later. One check, here.
 *
 * @param value An ISO timestamp, a `Date`, or nothing at all.
 * @returns The date, or `null` when there is no readable one.
 */
function readDate(value: string | Date | null | undefined): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The last-login stamp, in the format Profile has always printed: `MM/DD/YY hh:mm AM`.
 *
 * Fixed to `en-US` because the format itself is — a `MM/DD/YY` shape rendered with the
 * reader's own locale would put the day first for most of the world while still being read
 * as a US date by the rest of the row.
 *
 * @param value The `users.last_login_at` timestamp.
 * @returns The stamp, or `null` when there is no readable timestamp to print.
 */
export function formatLoginStamp(value: string | Date | null | undefined): string | null {
  const date = readDate(value);
  if (!date) return null;
  const datePart = date.toLocaleDateString('en-US', {
    month: '2-digit',
    day: '2-digit',
    year: '2-digit',
  });
  const timePart = date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
  return `${datePart} ${timePart}`;
}

/** Everything the Session card prints about the reader's current sign-in. */
export interface SessionLifetime {
  /** When it lapses. */
  expiresAt: Date;
  /** The absolute stamp, in the reader's own locale — what the card has always shown. */
  absolute: string;
  /** The same moment written out: `"Friday, August 22, 2026"`. */
  weekday: string;
  /** Whole days left, floored, never negative — an expired session reads 0 rather than -3. */
  daysRemaining: number;
  /** The session's full length in days ({@link SESSION_LIFETIME_DAYS}). */
  totalDays: number;
  /**
   * Days already spent, `totalDays - daysRemaining`, clamped into range.
   *
   * This is the meter's value, not `daysRemaining`: a meter is a share of a *quota* and more
   * of it is worse, so spent-time is the number whose warn and danger bands mean what the
   * component's derived tones already say (`ui/metrics/Meter`).
   */
  daysElapsed: number;
  /** The figure printed beside the bar: `"6d left of 30"`. */
  valueLabel: string;
}

/**
 * Read everything the Session card needs out of the session's expiry.
 *
 * Better Auth slides an active session's expiry forward at most once a day
 * (`SESSION_UPDATE_AGE_SECONDS`), so `daysElapsed` is near zero for a reader who has been
 * using the app — which is the truth, and is what the meter should show.
 *
 * @param expires The session's expiry, as `session.expires` carries it.
 * @param now The moment to measure from; injectable so the suite is not clock-dependent.
 * @returns The card's figures, or `null` when the expiry is missing or unreadable.
 */
export function readSessionLifetime(
  expires: string | Date | null | undefined,
  now: Date = new Date()
): SessionLifetime | null {
  const expiresAt = readDate(expires);
  if (!expiresAt) return null;

  const totalDays = SESSION_LIFETIME_DAYS;
  const rawDays = Math.floor((expiresAt.getTime() - now.getTime()) / MS_PER_DAY);
  const daysRemaining = Math.min(Math.max(rawDays, 0), totalDays);

  return {
    expiresAt,
    absolute: expiresAt.toLocaleString(),
    weekday: expiresAt.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    }),
    daysRemaining,
    totalDays,
    daysElapsed: totalDays - daysRemaining,
    valueLabel: `${daysRemaining}d left of ${totalDays}`,
  };
}

/**
 * Browser families, most specific first.
 *
 * Order is the whole algorithm: Edge and Opera both advertise `Chrome` in their user-agent
 * strings, and every Chromium browser advertises `Safari`, so a naive scan calls all four
 * Chrome. Matching in this order is the standard way round that.
 */
const BROWSER_TOKENS: readonly (readonly [pattern: RegExp, name: string])[] = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\bOPR\/|\bOpera\//, 'Opera'],
  [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
  [/\bChrome\/|\bCriOS\//, 'Chrome'],
  [/\bSafari\//, 'Safari'],
];

/** Operating systems, most specific first — iOS advertises `like Mac OS X`. */
const PLATFORM_TOKENS: readonly (readonly [pattern: RegExp, name: string])[] = [
  [/\b(?:iPhone|iPad|iPod)\b/, 'iOS'],
  [/\bAndroid\b/, 'Android'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bWindows\b/, 'Windows'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bLinux\b/, 'Linux'],
];

/**
 * Name the browser the reader is signed in from — `"Chrome on macOS"`.
 *
 * A user-agent string is a *hint*, not a fact, which is why this is only ever used as the
 * quiet line under the session's expiry and never as an identifier. Anything unrecognised
 * yields `null` and the line is not drawn, rather than the row claiming "Unknown on Unknown".
 *
 * @param userAgent `navigator.userAgent`, or nothing when there is no browser (SSR, jsdom
 *   without one configured).
 * @returns The device description, or `null` when neither half could be named.
 */
export function describeDevice(userAgent: string | null | undefined): string | null {
  if (!userAgent) return null;
  const browser = BROWSER_TOKENS.find(([pattern]) => pattern.test(userAgent))?.[1] ?? null;
  const platform = PLATFORM_TOKENS.find(([pattern]) => pattern.test(userAgent))?.[1] ?? null;
  if (browser && platform) return `${browser} on ${platform}`;
  return browser ?? platform;
}

/** One row of the Sign-in methods card. */
export interface SignInMethodRow {
  /** Stable key: `"password"`, or the provider-registry id (`"github"`). */
  id: string;
  /** What the reader sees — `"Password"`, `"GitHub"`. */
  label: string;
  /** The quiet second line: the provider handle or email, when one is known. */
  detail: string | null;
  /**
   * The vocabulary string behind the row's badge (`ui/statusVocabulary`).
   *
   * Both kinds of method are `active`: they are ways the reader can sign in *today*, which
   * is exactly what the members and keys row of DESIGN.md §3.1 means by the word. The badge
   * *label* differs ("Active" / "Linked") because the two read differently in a list, but the
   * tone comes from the shared table rather than from this card.
   */
  status: 'active';
  /** The badge's text. */
  badge: string;
  /** `true` for the password row, which draws the lock glyph rather than a provider mark. */
  isPassword: boolean;
}

/** A linked identity, as far as this card is concerned. */
export interface LinkedIdentity {
  /** Provider-registry id. */
  provider: string;
  /** The handle at the provider, when it has one. */
  provider_username?: string | null;
  /** The address at the provider, when it has one. */
  provider_email?: string | null;
}

/** Display names for the providers this build knows; anything else is title-cased. */
const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  azure: 'Microsoft',
  google: 'Google',
  okta: 'Okta',
  aws: 'AWS',
  keycloak: 'Keycloak',
  oidc: 'OpenID Connect',
  auth0: 'Auth0',
  line: 'LINE',
  vk: 'VK',
  wechat: 'WeChat',
};

/**
 * The reader-facing name of a provider.
 *
 * @param provider The registry id.
 * @returns Its display name, or the id with its first letter capitalised — a provider this
 *   build no longer knows still reads as a word rather than as a slug.
 */
export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

/**
 * The concrete list of ways this account can be signed into.
 *
 * The card used to be prose alone — "Link providers like GitHub, GitLab, or Microsoft" — which
 * is true of the product and says nothing about *this reader*. The mockup's Adds list asks for
 * the methods themselves, and the two facts behind them are already loaded on this page's
 * neighbour: `getUserHasPassword` and `getLinkedAccountsForUser`.
 *
 * @param options.hasPassword Whether a password is set on the account.
 * @param options.accounts The linked identities, newest first as the query returns them.
 * @returns One row per method, password first. Empty when the account has neither — a state
 *   the last-method guard (OLO-2.4) prevents, and which the card answers with its empty line.
 */
export function buildSignInMethods({
  hasPassword,
  accounts,
}: {
  hasPassword: boolean;
  accounts: readonly LinkedIdentity[];
}): SignInMethodRow[] {
  const rows: SignInMethodRow[] = [];

  if (hasPassword) {
    rows.push({
      id: 'password',
      label: 'Password',
      detail: 'Set',
      status: 'active',
      badge: 'Active',
      isPassword: true,
    });
  }

  for (const account of accounts) {
    rows.push({
      id: account.provider,
      label: providerLabel(account.provider),
      detail: account.provider_username || account.provider_email || null,
      status: 'active',
      badge: 'Linked',
      isPassword: false,
    });
  }

  return rows;
}
