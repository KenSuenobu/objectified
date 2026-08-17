/**
 * How strong a new password is, measured against the rules the server actually enforces
 * (HIVE-4.7, #5301).
 *
 * Authority: `docs/mockups/account/profile.html` → Change password, whose Adds list asks for
 * a strength meter beside the new-password field; and `validatePassword` in `lib/db/helper.ts`,
 * which is the rule this measures against.
 *
 * ### Why it is derived from the server's rules rather than from an entropy estimate
 *
 * A meter that scored entropy would happily call `Tr0ub4dor` "Strong" and then watch the
 * server reject it, because the server does not score entropy — it checks four things. A
 * meter is only useful if a full bar means *the next button will work*, so the bar is the
 * server's own checklist plus one honest bonus for length. If `validatePassword` gains a
 * rule, this module gains a requirement and `tests/password-strength.test.ts` fails until
 * both agree.
 *
 * ### Three requirements, four points
 *
 * The dialog has always printed three bullets, and those exact strings are part of what this
 * ticket must keep 1:1 — so the requirements are the bullets, not the four regexes behind
 * them (upper and lower share a line). The fourth point is the length bonus: twelve
 * characters or more. It cannot be a *requirement*, because the server accepts eight; it can
 * be the difference between a bar that is full and one that is nearly full, which is what
 * separates "this will be accepted" from "this is a good password".
 */

import type { MetricTone } from '@/app/components/ui/metrics/metricTiers';

/** The length the server rejects below. */
export const PASSWORD_MIN_LENGTH = 8;

/** The length past which a compliant password reads as strong rather than merely valid. */
export const PASSWORD_STRONG_LENGTH = 12;

/** One line of the dialog's requirements list, and the test behind it. */
export interface PasswordRequirement {
  /** Stable key, for React and for the suite. */
  id: string;
  /** The line the dialog prints. These strings are pinned by the ticket — do not reword. */
  label: string;
  /**
   * Whether a candidate satisfies it.
   *
   * @param password The candidate.
   * @returns `true` when this requirement is met.
   */
  test: (password: string) => boolean;
}

/**
 * The three requirements, in the order the dialog has always listed them.
 *
 * The character-class expression is the server's, character for character, so a password this
 * list calls complete is one `validatePassword` accepts.
 */
export const PASSWORD_REQUIREMENTS: readonly PasswordRequirement[] = [
  {
    id: 'length',
    label: 'At least 8 characters',
    test: (password) => password.length >= PASSWORD_MIN_LENGTH,
  },
  {
    id: 'case',
    label: 'One uppercase and one lowercase letter',
    test: (password) => /[A-Z]/.test(password) && /[a-z]/.test(password),
  },
  {
    id: 'symbol',
    label: 'One number or special character',
    test: (password) => /[0-9!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(password),
  },
];

/** The most points a candidate can score: one per requirement, plus the length bonus. */
export const PASSWORD_MAX_POINTS = PASSWORD_REQUIREMENTS.length + 1;

/** What the meter beside the new-password field draws. */
export interface PasswordStrength {
  /** 0 – {@link PASSWORD_MAX_POINTS}. */
  points: number;
  /** `points` as a whole-percent share, which is what the bar's width is. */
  percent: number;
  /** The word beside the bar: `Weak` · `Fair` · `Strong`. */
  label: string;
  /** The bar's tone — `danger` until the server would accept it, then `warn`, then `ok`. */
  tone: MetricTone;
  /** Whether every requirement is met, i.e. whether the server would accept this password. */
  meetsAll: boolean;
  /** Which requirements are met, in {@link PASSWORD_REQUIREMENTS} order. */
  met: readonly boolean[];
}

/**
 * Score a candidate password.
 *
 * An empty string returns `null` rather than a zeroed meter: a bar sitting at 0 % under an
 * untouched field reads as a failure the reader has not had a chance to cause yet.
 *
 * @param password What the reader has typed so far.
 * @returns The meter's figures, or `null` when there is nothing to measure.
 */
export function passwordStrength(password: string): PasswordStrength | null {
  if (!password) return null;

  const met = PASSWORD_REQUIREMENTS.map((requirement) => requirement.test(password));
  const meetsAll = met.every(Boolean);
  const isLong = password.length >= PASSWORD_STRONG_LENGTH;
  const points = met.filter(Boolean).length + (isLong ? 1 : 0);

  // The label reads off `meetsAll`, not off `points`: two requirements plus the length bonus
  // scores the same three points as all three requirements on a short password, and only one
  // of those two will be accepted. The reader is told which one they are in.
  const label = !meetsAll ? 'Weak' : isLong ? 'Strong' : 'Fair';
  const tone: MetricTone = !meetsAll ? 'danger' : isLong ? 'ok' : 'warn';

  return {
    points,
    percent: Math.round((points / PASSWORD_MAX_POINTS) * 100),
    label,
    tone,
    meetsAll,
    met,
  };
}
