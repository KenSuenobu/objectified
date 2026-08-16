/**
 * Shared member-seat presentation helpers (OLO-5.5 / OLO-6.3).
 *
 * Both the tenant License panel (OLO-5.5, #4215) and the member-management
 * screen (OLO-6.3, #4220) render a tenant's member-seat usage against its
 * license limit and gate seat-consuming actions on the same
 * `license-seats-exhausted` condition apiome-rest enforces (OLO-5.3). Keeping
 * the pure logic here — rather than duplicating it per surface — guarantees the
 * two screens agree on when a tenant is "at capacity" and how the usage reads.
 *
 * Seat data arrives from the OLO-5.4 license surface as `{ used, max }` (see
 * {@link ./licenseApi}.TenantLicenseSeats). A negative `max` means the plan
 * grants unlimited seats (Sponsor tier); those tenants are never at capacity.
 */

import {
  METER_WARN_PERCENT,
  METRIC_TONE_INK_CLASS,
  meterPercent,
  meterTier,
  type MetricTone,
} from '@/app/components/ui/metrics';
import type { TenantLicenseSeats } from './licenseApi';

/**
 * Seat-usage fraction (0–100) at which the meter switches to the warning tint.
 *
 * Re-exported from the shared metrics bands (HIVE-2.6, #5285) rather than restated: the seat
 * meter's 80 % line and every other quota meter's are the same line, and the two drifting apart
 * is exactly the kind of per-screen decision that ticket removes.
 */
export const SEAT_WARNING_PERCENT = METER_WARN_PERCENT;

/**
 * Whether the license grants unlimited member seats.
 *
 * @param seats Seat usage from the license surface.
 * @returns True when `max` is negative (the OLO-5.4 unlimited sentinel).
 */
export function seatsUnlimited(seats: TenantLicenseSeats): boolean {
  return seats.max < 0;
}

/**
 * Whether every licensed member seat is occupied.
 *
 * Mirrors the apiome-rest guard (OLO-5.3): a seat-consuming action (invite /
 * reinstate) is refused once `used` reaches `max`. Unlimited plans (negative
 * `max`) are never exhausted.
 *
 * @param seats Seat usage from the license surface.
 * @returns True when the tenant is at capacity and further invites will 403.
 */
export function seatsExhausted(seats: TenantLicenseSeats): boolean {
  return seats.max >= 0 && seats.used >= seats.max;
}

/**
 * Human summary of seat usage for a compact, always-visible indicator.
 *
 * @param seats Seat usage from the license surface.
 * @returns e.g. `"4 of 5 seats used"`, or `"4 seats used"` for an unlimited plan.
 */
export function formatSeatUsage(seats: TenantLicenseSeats): string {
  const noun = seats.used === 1 ? 'seat' : 'seats';
  if (seatsUnlimited(seats)) {
    return `${seats.used} ${noun} used`;
  }
  return `${seats.used} of ${seats.max} ${noun} used`;
}

/**
 * The seat meter's share, tone and label ink.
 *
 * A thin projection of the shared quota bands (HIVE-2.6, #5285) rather than a palette of its
 * own: before that ticket this function carried `bg-emerald-500` / `bg-amber-500` /
 * `bg-red-500`, which followed no theme and agreed with nothing else in the product that
 * measures a quota. The bands, the rounding and the 80 % line now all come from
 * `components/ui/metrics/metricTiers.ts`.
 *
 * The two seat surfaces render the bar with `<Meter>`, which derives the same tone itself — what
 * they still need from here is the ink for the `"3 of 10 used"` figure they print in their own
 * headers, so it agrees with the bar beside it.
 *
 * @param used Seats occupied.
 * @param max Seat limit (0 or negative renders as full — an unlimited plan should not draw a
 *   meter at all; see {@link seatsUnlimited}).
 * @returns The whole-percent share, the metric tone it falls in, and the token ink class for a
 *   figure printed in that tone.
 */
export function seatMeterAppearance(
  used: number,
  max: number,
): { percent: number; tone: MetricTone; countClass: string } {
  const percent = meterPercent(used, max);
  const tone = meterTier(percent);
  return { percent, tone, countClass: METRIC_TONE_INK_CLASS[tone] };
}
