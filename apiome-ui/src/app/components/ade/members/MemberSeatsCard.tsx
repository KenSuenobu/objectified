'use client';

import * as React from 'react';
import { Users } from 'lucide-react';

import { Alert } from '@/app/components/ui/Alert';
import { Badge } from '@/app/components/ui/Badge';
import { Meter } from '@/app/components/ui/metrics';
import {
  describeLicenseError,
  LICENSE_SEATS_EXHAUSTED_CODE,
} from '@/app/ade/dashboard/tenants/licenseErrors';
import {
  formatSeatUsage,
  seatMeterAppearance,
  seatsUnlimited,
} from '@/app/ade/dashboard/tenants/licenseSeats';
import type { TenantLicensePlan, TenantLicenseSeats } from '@/app/ade/dashboard/tenants/licenseApi';

import { inviteBlockedBySeats } from './membersModel';

/**
 * Member seats — HIVE-5.2 (#5305).
 *
 * Authority: `docs/mockups/workspace/members.html`, the *Member seats (license)* section, and
 * its Keeps list: `formatSeatUsage` text, a `role="meter"` bar that turns warn at 80 % and
 * danger at 100 %, the unlimited-plan sentence, and the at-capacity warning banner carrying
 * the `license-seats-exhausted` copy.
 *
 * Every one of those is borrowed rather than restated. The thresholds come from the shared
 * quota bands (`metrics/metricTiers`), the figure from `formatSeatUsage`, and the banner's
 * sentence from `describeLicenseError` — the same function that renders the 403 apiome-rest
 * answers with when the invite is actually refused. That is the point: the number the screen
 * shows and the rule the server enforces are one sentence, so they cannot drift.
 *
 * Hidden entirely when the licence read failed. Seat usage is best-effort context (OLO-6.3),
 * and a card that says nothing is better than one that guesses.
 */

/** Props for {@link MemberSeatsCard}. */
export interface MemberSeatsCardProps {
  /** Seat usage from the tenant licence, or `null` when the read failed or is pending. */
  seats: TenantLicenseSeats | null;
  /** The tenant's plan, for the badge beside the title. */
  plan?: TenantLicensePlan | null;
}

/**
 * The seat meter and its at-capacity banner.
 *
 * @param props See {@link MemberSeatsCardProps}.
 * @returns The card, or `null` when there is no licence to describe.
 */
export default function MemberSeatsCard({ seats, plan }: MemberSeatsCardProps) {
  if (!seats) return null;

  const unlimited = seatsUnlimited(seats);
  const atCapacity = inviteBlockedBySeats(seats);
  const usage = formatSeatUsage(seats);
  // An unlimited plan has no share to be a tone of: `meterPercent` reads a non-positive `max`
  // as a full meter, so asking for the tone anyway would paint "12 seats used" in the danger
  // ink on a plan that can never run out. The figure stays in the body ink instead.
  const figureClass = unlimited ? 'text-fg' : seatMeterAppearance(seats.used, seats.max).countClass;

  return (
    <section
      data-testid="member-seat-usage"
      className="rounded-lg bg-surface p-4 shadow-[inset_0_0_0_1px_var(--border)]"
    >
      <div className="mbr-seat-strip">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Users className="size-[var(--icon-dense)] shrink-0 text-fg-muted" aria-hidden />
            <h2 className="text-sm font-semibold text-fg">Member seats</h2>
            {plan?.name && <Badge variant="outline">{plan.name} plan</Badge>}
          </div>

          {unlimited ? (
            <p className="mt-2 text-xs text-fg-muted">
              This plan includes unlimited member seats.
            </p>
          ) : (
            <div className="mt-2">
              <Meter
                label="Member seats used"
                value={seats.used}
                max={seats.max}
                valueText={usage}
                showValue={false}
              />
              <p className="mt-1 text-xs text-fg-muted">
                {usage} · a pending invitation holds its seat until it is accepted or cancelled.
              </p>
            </div>
          )}
        </div>

        <p className={`mbr-seat-figure ${figureClass}`}>{usage}</p>
      </div>

      {atCapacity && (
        <div className="mt-3">
          <Alert variant="warn" data-testid="member-seats-exhausted">
            <strong className="block font-semibold">All member seats are in use</strong>
            {describeLicenseError({ code: LICENSE_SEATS_EXHAUSTED_CODE })}
          </Alert>
        </div>
      )}
    </section>
  );
}
