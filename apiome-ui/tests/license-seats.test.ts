/**
 * Unit tests for the shared member-seat helpers (OLO-6.3, #4220).
 *
 * These pure functions back both the tenant License panel (OLO-5.5) and the
 * member-management screen (OLO-6.3); they decide when a tenant is "at
 * capacity" (must agree with the apiome-rest OLO-5.3 guard) and how seat usage
 * reads. The seat surface reports `{ used, max }` with a negative `max`
 * meaning unlimited (Sponsor tier).
 */

import {
  SEAT_WARNING_PERCENT,
  formatSeatUsage,
  seatMeterAppearance,
  seatsExhausted,
  seatsUnlimited,
} from '../src/app/ade/dashboard/tenants/licenseSeats';

describe('seatsUnlimited', () => {
  it('is true only for a negative seat maximum', () => {
    expect(seatsUnlimited({ used: 3, max: -1 })).toBe(true);
    expect(seatsUnlimited({ used: 3, max: 5 })).toBe(false);
    expect(seatsUnlimited({ used: 0, max: 0 })).toBe(false);
  });
});

describe('seatsExhausted', () => {
  it('is true once used reaches a finite maximum', () => {
    expect(seatsExhausted({ used: 5, max: 5 })).toBe(true);
    expect(seatsExhausted({ used: 6, max: 5 })).toBe(true);
  });

  it('is false below the maximum', () => {
    expect(seatsExhausted({ used: 4, max: 5 })).toBe(false);
  });

  it('is never exhausted on an unlimited plan', () => {
    expect(seatsExhausted({ used: 999, max: -1 })).toBe(false);
  });
});

describe('formatSeatUsage', () => {
  it('reads "used of max seats" for a finite plan', () => {
    expect(formatSeatUsage({ used: 4, max: 5 })).toBe('4 of 5 seats used');
  });

  it('singularizes a single occupied seat', () => {
    expect(formatSeatUsage({ used: 1, max: 5 })).toBe('1 of 5 seat used');
  });

  it('omits the cap on an unlimited plan', () => {
    expect(formatSeatUsage({ used: 4, max: -1 })).toBe('4 seats used');
  });
});

// HIVE-2.6 (#5285) moved the palette out: the helper now projects the shared quota bands of
// `components/ui/metrics/metricTiers.ts`, so its tones are Hive tokens that follow the theme
// rather than the frozen `bg-emerald-500` / `bg-amber-500` / `bg-red-500` it used to carry.
describe('seatMeterAppearance', () => {
  it('is quiet well below the warning threshold', () => {
    expect(seatMeterAppearance(3, 10)).toEqual({
      percent: 30,
      tone: 'accent',
      countClass: 'text-accent-fg',
    });
  });

  it('warns at the warning threshold and turns danger when full', () => {
    expect(seatMeterAppearance(SEAT_WARNING_PERCENT / 10, 10).tone).toBe('warn');
    expect(seatMeterAppearance(10, 10).tone).toBe('danger');
  });

  it('clamps overflow to 100% and treats a zero maximum as full', () => {
    expect(seatMeterAppearance(12, 10).percent).toBe(100);
    expect(seatMeterAppearance(0, 0)).toEqual(
      expect.objectContaining({ percent: 100, tone: 'danger' }),
    );
  });

  it('spends no colour on a number nobody needs to read', () => {
    // Half a quota is not an achievement — `ok` is reserved for "this is finished".
    expect(seatMeterAppearance(5, 10).tone).not.toBe('ok');
  });
});
