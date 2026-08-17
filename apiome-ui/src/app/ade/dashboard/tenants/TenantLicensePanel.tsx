'use client';

/**
 * Tenant license & plan — OLO-5.5 (#4215), redrawn as a drawer section by HIVE-5.1 (#5304).
 *
 * Authority: `docs/mockups/workspace/tenants.html` `[data-tab-panel="m-license"]`.
 *
 * Loads the OLO-5.4 license surface (`/api/tenants/license`) for the session's current
 * tenant and shows:
 *
 * - a plan card (name + billing type, or the Free-tier fallback note when the tenant has no
 *   license attachment) with the upgrade CTA;
 * - a member seat-usage meter (used vs. max, warning tint from 80 %, and the OLO-5.3
 *   `license-seats-exhausted` guidance when full);
 * - the stored plan quota limits (#64);
 * - the effective feature list (license bundle ∪ tenant overrides) with source and
 *   Preview/Enabled/Disabled pills.
 *
 * Read-only: any member holding `billing:view` (every built-in role) can read the same data
 * via REST, so no admin gating is applied here beyond the drawer's own visibility rules.
 * Errors from the proxy are run through `describeLicenseError` so stable OLO-5.3 codes render
 * as friendly guidance rather than raw API errors.
 *
 * ### What HIVE-5.1 changed
 *
 * The panel no longer collapses itself — inside the manage drawer the "License & plan" tab
 * is the disclosure, so mounting is the request to load — and every hard-coded
 * `gray-`/`indigo-`/`emerald-`/`amber-` class is now a design token, so the section follows
 * all nine themes. The plan-type badge in particular went from three bespoke palettes to
 * {@link Badge} tones, which is also what makes `paid` the same green here as everywhere
 * else the app says a thing is on.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ArrowUpCircle,
  BadgeCheck,
  FolderKanban,
  GaugeCircle,
  GitBranch,
  Sparkles,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';
import { Alert } from '@/app/components/ui/Alert';
import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import { LoadingState } from '@/app/components/ui/LoadingState';
import {
  fetchTenantLicense,
  type TenantLicenseFeature,
  type TenantLicenseQuotas,
  type TenantLicenseResponse,
} from './licenseApi';
import { describeLicenseError, LICENSE_SEATS_EXHAUSTED_CODE } from './licenseErrors';
import { Meter } from '@/app/components/ui/metrics';
import { seatMeterAppearance, seatsExhausted } from './licenseSeats';

// Re-exported for existing consumers/tests that import the seat-meter helper
// from this component; the logic now lives in the shared ./licenseSeats module.
export { seatMeterAppearance } from './licenseSeats';

export interface TenantLicensePanelProps {
  /** True when this row is the session's current tenant (loads live data). */
  isCurrentTenant: boolean;
  /** Tenant display name for the non-current-tenant helper. */
  tenantName?: string;
}

/** Copy shown under the upgrade CTA stub (no billing in this pack). */
const UPGRADE_STUB_COPY =
  'Plan upgrades and billing management are coming soon. Contact your operator to change plans today.';

/** Badge copy per feature `source` value from the REST composition. */
const FEATURE_SOURCE_LABELS: Record<string, string> = {
  license: 'Included in plan',
  'tenant-override': 'Tenant override',
};

/**
 * Badge tone per plan billing type.
 *
 * Tones from the shared vocabulary rather than three hand-built palettes: `paid` is the same
 * "this is on" green the rest of the app uses, `sponsor` borrows the violet that marks a
 * privileged role, and an unknown type falls back to neutral rather than to a colour that
 * would imply something about it.
 */
const PLAN_TYPE_BADGE_TONE: Record<string, 'neutral' | 'ok' | 'violet'> = {
  free: 'neutral',
  paid: 'ok',
  sponsor: 'violet',
};

/**
 * Render a stored plan quota limit for display (#64).
 *
 * @param value The limit from the license (`-1` = unlimited).
 * @param zeroLabel Copy shown when the limit is exactly `0` (e.g. "Not included"
 *   for an AI cap the plan does not grant). Defaults to `'0'`.
 * @returns Human copy: "Unlimited" for a negative value, `zeroLabel` for `0`,
 *   otherwise the number as a string.
 */
export function formatQuotaLimit(value: number, zeroLabel = '0'): string {
  if (value < 0) return 'Unlimited';
  if (value === 0) return zeroLabel;
  return String(value);
}

/** One row in the plan-limits card. */
function QuotaRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <li className="tnt-limit-row">
      <span className="flex items-center gap-2 text-sm text-fg-muted">
        {icon}
        {label}
      </span>
      <span className="text-sm font-semibold tabular-nums text-fg">{value}</span>
    </li>
  );
}

/** Stored plan quota limits card: projects / versions / AI (#64). */
function PlanLimits({ quotas }: { quotas: TenantLicenseQuotas }) {
  return (
    <div className="tnt-card">
      <div className="tnt-card__header">
        <p className="flex items-center gap-2 text-sm font-semibold text-fg">
          <GaugeCircle className="size-[var(--icon-dense)] text-fg-subtle" aria-hidden />
          Plan limits
        </p>
        <p className="mt-0.5 text-xs text-fg-muted">
          What your plan allows. Unlimited plans show no cap.
        </p>
      </div>
      <ul className="tnt-card__body">
        <QuotaRow
          icon={<FolderKanban className="size-[var(--icon-dense)] text-fg-subtle" aria-hidden />}
          label="Projects"
          value={formatQuotaLimit(quotas.max_projects)}
        />
        <QuotaRow
          icon={<GitBranch className="size-[var(--icon-dense)] text-fg-subtle" aria-hidden />}
          label="Published versions per project"
          value={formatQuotaLimit(quotas.max_versions)}
        />
        <QuotaRow
          icon={<Sparkles className="size-[var(--icon-dense)] text-fg-subtle" aria-hidden />}
          label="AI assistant requests"
          value={formatQuotaLimit(quotas.max_ai_requests, 'Not included')}
        />
      </ul>
    </div>
  );
}

/** One row in the effective feature list. */
function FeatureRow({ feature }: { feature: TenantLicenseFeature }) {
  return (
    <li className="tnt-feature-row">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-fg">{feature.label || feature.name}</span>
          <span className="font-mono text-xs text-fg-muted">{feature.name}</span>
          {feature.is_preview && <Badge variant="accent">Preview</Badge>}
        </div>
        {feature.description && (
          <p className="mt-0.5 text-xs text-fg-muted">{feature.description}</p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className="text-xs text-fg-muted">
          {FEATURE_SOURCE_LABELS[feature.source] ?? feature.source}
        </span>
        <Badge status={feature.enabled ? 'active' : 'disabled'}>
          {feature.enabled ? 'Enabled' : 'Disabled'}
        </Badge>
      </div>
    </li>
  );
}

export default function TenantLicensePanel({
  isCurrentTenant,
  tenantName,
}: TenantLicensePanelProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [license, setLicense] = useState<TenantLicenseResponse | null>(null);
  const [loadedOnce, setLoadedOnce] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setLicense(await fetchTenantLicense());
      setLoadedOnce(true);
    } catch (err) {
      // Prefer friendly OLO-5.3 guidance when the payload carries a stable code.
      const friendly = describeLicenseError(err);
      const message =
        friendly ?? (err instanceof Error ? err.message : 'Failed to load license details');
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Mounting is the request: the section is only created when its tab is first opened.
  useEffect(() => {
    if (!isCurrentTenant || loadedOnce) return;
    void load();
  }, [isCurrentTenant, loadedOnce, load]);

  const handleUpgradeClick = () => {
    toast.info(UPGRADE_STUB_COPY);
  };

  const seats = license?.seats;
  const meter = seats ? seatMeterAppearance(seats.used, seats.max) : null;
  const seatsAtCapacity = Boolean(seats && seatsExhausted(seats));

  return (
    <section aria-labelledby="tnt-license-heading" className="space-y-4">
      <div className="min-w-0">
        <h3 id="tnt-license-heading" className="tnt-section-title">
          License &amp; plan
        </h3>
        <p className="tnt-section-desc">
          What this tenant is licensed for. Data is shown for the current tenant only.
        </p>
      </div>

      {!isCurrentTenant ? (
        <p className="tnt-lock-note">
          Select{tenantName ? ` ${tenantName}` : ' this tenant'} as your current tenant to view
          its license details.
        </p>
      ) : (
        <>
          {error && <Alert variant="error">{error}</Alert>}

          {loading && !license ? (
            <LoadingState message="Loading license details…" minHeightClassName="min-h-[8rem]" />
          ) : license ? (
            <>
              {/* Plan card */}
              <div className="tnt-card tnt-card--pad">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span className="tnt-icon-tile" data-tone="honey">
                      <BadgeCheck aria-hidden />
                    </span>
                    <div>
                      <p className="tnt-caps">Current plan</p>
                      {license.plan ? (
                        <div className="flex items-center gap-2">
                          <span className="text-lg font-semibold text-fg">
                            {license.plan.name}
                          </span>
                          <Badge
                            variant={PLAN_TYPE_BADGE_TONE[license.plan.type] ?? 'neutral'}
                            className="capitalize"
                          >
                            {license.plan.type}
                          </Badge>
                        </div>
                      ) : (
                        <span className="text-sm text-fg-muted">
                          No plan attached — Free-tier limits apply
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={handleUpgradeClick}>
                      <ArrowUpCircle aria-hidden />
                      Upgrade plan
                    </Button>
                    <Badge variant="honey">Coming soon</Badge>
                  </div>
                </div>
              </div>

              <div className="grid items-start gap-4 sm:grid-cols-2">
                {/* Seat usage meter */}
                <div className="tnt-card tnt-card--pad">
                  <div className="flex items-center justify-between gap-2">
                    <p className="flex items-center gap-2 text-sm font-semibold text-fg">
                      <Users className="size-[var(--icon-dense)] text-fg-subtle" aria-hidden />
                      Member seats
                    </p>
                    {meter && seats && (
                      <p className={`text-xs font-semibold tabular-nums ${meter.countClass}`}>
                        {seats.used} of {seats.max} used
                      </p>
                    )}
                  </div>
                  {meter && seats && (
                    <div className="mt-2">
                      <Meter
                        label="Member seats used"
                        value={seats.used}
                        max={seats.max}
                        valueText={`${seats.used} of ${seats.max} seats used`}
                        showValue={false}
                      />
                    </div>
                  )}
                  <p className="mt-2 text-xs text-fg-muted">
                    Warning tint from 80 % · at 100 % inviting is blocked.
                  </p>
                  {seatsAtCapacity && (
                    <div className="mt-3">
                      <Alert variant="warning">
                        {describeLicenseError({ code: LICENSE_SEATS_EXHAUSTED_CODE })}
                      </Alert>
                    </div>
                  )}
                </div>

                {/* Stored plan quota limits (#64) */}
                {license.quotas && <PlanLimits quotas={license.quotas} />}
              </div>

              {/* Effective feature list */}
              <div className="tnt-card">
                <div className="tnt-card__header">
                  <p className="flex items-center gap-2 text-sm font-semibold text-fg">
                    <Sparkles className="size-[var(--icon-dense)] text-fg-subtle" aria-hidden />
                    Features
                  </p>
                  <p className="mt-0.5 text-xs text-fg-muted">
                    What your plan includes, with any per-tenant overrides applied.
                  </p>
                </div>
                {license.features.length === 0 ? (
                  <p className="px-4 py-6 text-center text-sm text-fg-muted">
                    No features are configured for this tenant.
                  </p>
                ) : (
                  <ul className="tnt-card__body">
                    {license.features.map((feature) => (
                      <FeatureRow key={feature.name} feature={feature} />
                    ))}
                  </ul>
                )}
              </div>
            </>
          ) : null}
        </>
      )}
    </section>
  );
}
