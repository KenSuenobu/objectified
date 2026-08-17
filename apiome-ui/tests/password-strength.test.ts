/**
 * The Change password strength meter (HIVE-4.7, #5301).
 *
 * The meter's whole value is that a full bar means *the save will succeed*, so the one thing
 * this suite really guards is the agreement between {@link PASSWORD_REQUIREMENTS} and the
 * server's own `validatePassword` (`lib/db/helper.ts`). That function is not importable here —
 * it lives in a module that opens a connection pool at import time — so the rules are restated
 * as a local oracle and every case below is checked against both.
 */

import {
  PASSWORD_MAX_POINTS,
  PASSWORD_MIN_LENGTH,
  PASSWORD_REQUIREMENTS,
  PASSWORD_STRONG_LENGTH,
  passwordStrength,
} from '@/app/components/ade/account/passwordStrength';

/**
 * The server's rule, transcribed from `validatePassword` in `lib/db/helper.ts`.
 *
 * @param password The candidate.
 * @returns `true` when the server would accept it.
 */
function serverWouldAccept(password: string): boolean {
  if (!password || password.length < 8) return false;
  if (!/[A-Z]/.test(password)) return false;
  if (!/[a-z]/.test(password)) return false;
  if (!/[0-9!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(password)) return false;
  return true;
}

/** Candidates spanning every combination the meter has to tell apart. */
const CANDIDATES = [
  'a',
  'abcdefgh',
  'ABCDEFGH',
  'Abcdefgh',
  'Abcdefg1',
  'Abcdefg!',
  'Abcdefghijk1',
  'abcdefghijk1',
  'CorrectHorse4Battery',
  '12345678',
  'Ab1!',
] as const;

describe('the requirements list', () => {
  it('states the three lines the dialog has always printed, unchanged', () => {
    expect(PASSWORD_REQUIREMENTS.map((requirement) => requirement.label)).toEqual([
      'At least 8 characters',
      'One uppercase and one lowercase letter',
      'One number or special character',
    ]);
  });

  it('uses the minimum the server enforces', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(8);
    expect(PASSWORD_REQUIREMENTS[0].test('a'.repeat(7))).toBe(false);
    expect(PASSWORD_REQUIREMENTS[0].test('a'.repeat(8))).toBe(true);
  });

  it('scores one point per requirement plus one for length', () => {
    expect(PASSWORD_MAX_POINTS).toBe(PASSWORD_REQUIREMENTS.length + 1);
    expect(PASSWORD_MAX_POINTS).toBe(4);
  });
});

describe('passwordStrength', () => {
  it('draws nothing for an untouched field', () => {
    // A bar at 0 % under a field nobody has typed in reads as a failure the reader has not
    // had the chance to cause yet.
    expect(passwordStrength('')).toBeNull();
  });

  it.each(CANDIDATES)('agrees with the server about "%s"', (candidate) => {
    expect(passwordStrength(candidate)?.meetsAll).toBe(serverWouldAccept(candidate));
  });

  it('only reads Fair or Strong for a password the server would accept', () => {
    for (const candidate of CANDIDATES) {
      const strength = passwordStrength(candidate);
      if (!strength) continue;
      const accepted = serverWouldAccept(candidate);
      expect(['Fair', 'Strong'].includes(strength.label)).toBe(accepted);
      expect(strength.label === 'Weak').toBe(!accepted);
    }
  });

  it('separates a merely valid password from a long one', () => {
    const short = passwordStrength('Abcdefg1');
    const long = passwordStrength('Abcdefghijk1');

    expect(short?.label).toBe('Fair');
    expect(short?.tone).toBe('warn');
    expect(long?.label).toBe('Strong');
    expect(long?.tone).toBe('ok');
    expect(long?.percent).toBe(100);
    expect(PASSWORD_STRONG_LENGTH).toBe(12);
  });

  it('does not let the length bonus alone dress an invalid password up as a valid one', () => {
    // Long, lower-case only: two of the three requirements plus the bonus is three points —
    // the same score a short but complete password gets, and the server rejects it.
    const long = passwordStrength('abcdefghijk1');
    const complete = passwordStrength('Abcdefg1');

    expect(long?.points).toBe(complete?.points);
    expect(long?.label).toBe('Weak');
    expect(long?.tone).toBe('danger');
    expect(serverWouldAccept('abcdefghijk1')).toBe(false);
  });

  it('reports which requirements are met, in list order', () => {
    expect(passwordStrength('abcdefgh')?.met).toEqual([true, false, false]);
    expect(passwordStrength('Abcdefgh')?.met).toEqual([true, true, false]);
    expect(passwordStrength('Abcdefg1')?.met).toEqual([true, true, true]);
    expect(passwordStrength('Ab1!')?.met).toEqual([false, true, true]);
  });

  it('keeps the bar inside the track', () => {
    for (const candidate of CANDIDATES) {
      const strength = passwordStrength(candidate);
      expect(strength?.percent).toBeGreaterThanOrEqual(0);
      expect(strength?.percent).toBeLessThanOrEqual(100);
    }
  });
});
