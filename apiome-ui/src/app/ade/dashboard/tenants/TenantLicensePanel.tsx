'use client';

/**
 * Tenant license panel — OLO-5.5 (#4215).
 *
 * Expandable "License & Plan" section of the tenant administration panel.
 * Loads the OLO-5.4 license surface (`/api/tenants/license`) for the
 * session's current tenant and shows:
 *
 * - a plan card (name + billing type, or the Free-tier fallback note when the
 *   tenant has no license attachment);
 * - a member seat-usage meter (used vs. max, with a warning tint near the
 *   limit and the OLO-5.3 `license-seats-exhausted` guidance when full);
 * - the effective feature list (license bundle ∪ tenant overrides) with
 *   Preview/source badges;
 * - an upgrade CTA stub — billing checkout is out of scope for this pack
 *   (#3484 territory), so the button only explains that upgrades are coming.
 *
 * Read-only: any member holding `billing:view` (every built-in role) can
 * read the same data via REST, so no admin gating is applied here beyond the
 * parent panel's own visibility rules. Errors from the proxy are run through
 * `describeLicenseError` so stable OLO-5.3 codes render as friendly guidance
 * rather than raw API errors.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ArrowUpCircle,
  BadgeCheck,
  ChevronDown,
  ChevronUp,
  CreditCard,
  FolderKanban,
  GaugeCircle,
  GitBranch,
  Loader2,
  Lock,
  Sparkles,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';
import { Alert } from '@/app/components/ui/Alert';
import { Button } from '@/app/components/ui/Button';
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

/** Badge styling per plan billing type; unknown types fall back to gray. */
const PLAN_TYPE_BADGE_CLASSES: Record<string, string> = {
  free: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300 border border-gray-200 dark:border-gray-600',
  paid: 'bg-indigo-50 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-700',
  sponsor:
    'bg-purple-50 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300 border border-purple-200 dark:border-purple-700',
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
    <li className="flex items-center justify-between gap-4 px-4 py-3">
      <span className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
        {icon}
        {label}
      </span>
      <span className="text-sm font-semibold text-gray-900 dark:text-white">{value}</span>
    </li>
  );
}

/** Stored plan quota limits card: projects / versions / AI (#64). */
function PlanLimits({ quotas }: { quotas: TenantLicenseQuotas }) {
  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
      <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-700">
        <p className="text-sm font-semibold text-gray-700 dark:text-gray-300 flex items-center gap-2">
          <GaugeCircle className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
          Plan limits
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
          What your plan allows. Unlimited plans show no cap.
        </p>
      </div>
      <ul className="divide-y divide-gray-100 dark:divide-gray-700">
        <QuotaRow
          icon={<FolderKanban className="h-4 w-4 text-gray-400 dark:text-gray-500" />}
          label="Projects"
          value={formatQuotaLimit(quotas.max_projects)}
        />
        <QuotaRow
          icon={<GitBranch className="h-4 w-4 text-gray-400 dark:text-gray-500" />}
          label="Published versions per project"
          value={formatQuotaLimit(quotas.max_versions)}
        />
        <QuotaRow
          icon={<Sparkles className="h-4 w-4 text-gray-400 dark:text-gray-500" />}
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
    <li className="flex items-start justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold text-gray-900 dark:text-white">
            {feature.label || feature.name}
          </span>
          <span className="text-xs font-mono text-gray-400 dark:text-gray-500">{feature.name}</span>
          {feature.is_preview && (
            <span className="inline-flex px-2 py-0.5 text-xs font-semibold rounded-full bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 border border-amber-200 dark:border-amber-700">
              Preview
            </span>
          )}
        </div>
        {feature.description && (
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{feature.description}</p>
        )}
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        <span className="text-xs text-gray-400 dark:text-gray-500">
          {FEATURE_SOURCE_LABELS[feature.source] ?? feature.source}
        </span>
        {feature.enabled ? (
          <span className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-lg bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-700">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
            Enabled
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-lg bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400 border border-gray-200 dark:border-gray-600">
            <span className="w-1.5 h-1.5 rounded-full bg-gray-400"></span>
            Disabled
          </span>
        )}
      </div>
    </li>
  );
}

export default function TenantLicensePanel({
  isCurrentTenant,
  tenantName,
}: TenantLicensePanelProps) {
  const [expanded, setExpanded] = useState(false);
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

  useEffect(() => {
    if (!isCurrentTenant || !expanded || loadedOnce) return;
    void load();
  }, [isCurrentTenant, expanded, loadedOnce, load]);

  const handleUpgradeClick = () => {
    toast.info(UPGRADE_STUB_COPY);
  };

  const seats = license?.seats;
  const meter = seats ? seatMeterAppearance(seats.used, seats.max) : null;
  const seatsAtCapacity = Boolean(seats && seatsExhausted(seats));

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-base font-semibold flex items-center gap-2 cursor-pointer text-gray-700 dark:text-gray-300 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
          aria-expanded={expanded}
        >
          <div className="p-1.5 rounded-lg bg-indigo-50 dark:bg-indigo-900/30">
            <CreditCard className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
          </div>
          License &amp; Plan
          {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
      </div>

      {expanded && (
        <div className="space-y-4">
          {!isCurrentTenant ? (
            <div className="flex items-start gap-3 rounded-lg border border-slate-300 bg-slate-100 p-4 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
              <Lock className="mt-0.5 h-5 w-5 flex-shrink-0" aria-hidden />
              <p className="text-sm text-slate-500 dark:text-slate-400">
                Select{tenantName ? ` ${tenantName}` : ' this tenant'} as your current tenant to
                view its license details.
              </p>
            </div>
          ) : (
            <>
              {error && <Alert variant="error">{error}</Alert>}

              {loading && !license ? (
                <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 py-4">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading license details…
                </div>
              ) : license ? (
                <>
                  {/* Plan card */}
                  <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
                    <div className="flex items-center justify-between gap-4 flex-wrap">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/25">
                          <BadgeCheck className="h-5 w-5 text-white" />
                        </div>
                        <div>
                          <p className="text-xs uppercase tracking-wide text-gray-400 dark:text-gray-500">
                            Current plan
                          </p>
                          {license.plan ? (
                            <div className="flex items-center gap-2">
                              <span className="text-lg font-bold text-gray-900 dark:text-white">
                                {license.plan.name}
                              </span>
                              <span
                                className={`inline-flex px-2 py-0.5 text-xs font-semibold rounded-full capitalize ${
                                  PLAN_TYPE_BADGE_CLASSES[license.plan.type] ??
                                  PLAN_TYPE_BADGE_CLASSES.free
                                }`}
                              >
                                {license.plan.type}
                              </span>
                            </div>
                          ) : (
                            <span className="text-sm text-gray-600 dark:text-gray-400">
                              No plan attached — Free-tier limits apply
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        <Button variant="outline" size="sm" onClick={handleUpgradeClick}>
                          <ArrowUpCircle className="h-4 w-4" />
                          Upgrade plan
                        </Button>
                        <p className="text-xs text-gray-400 dark:text-gray-500">Coming soon</p>
                      </div>
                    </div>
                  </div>

                  {/* Seat usage meter */}
                  <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-sm font-semibold text-gray-700 dark:text-gray-300 flex items-center gap-2">
                        <Users className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
                        Member seats
                      </p>
                      {meter && seats && (
                        <p className={`text-sm font-semibold ${meter.countClass}`}>
                          {seats.used} of {seats.max} used
                        </p>
                      )}
                    </div>
                    {meter && seats && (
                      <Meter
                        label="Member seats used"
                        value={seats.used}
                        max={seats.max}
                        valueText={`${seats.used} of ${seats.max} seats used`}
                        showValue={false}
                      />
                    )}
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

                  {/* Effective feature list */}
                  <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
                    <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-700">
                      <p className="text-sm font-semibold text-gray-700 dark:text-gray-300">
                        Features
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                        What your plan includes, with any per-tenant overrides applied.
                      </p>
                    </div>
                    {license.features.length === 0 ? (
                      <p className="px-4 py-6 text-sm text-gray-500 dark:text-gray-400 text-center">
                        No features are configured for this tenant.
                      </p>
                    ) : (
                      <ul className="divide-y divide-gray-100 dark:divide-gray-700">
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
        </div>
      )}
    </div>
  );
}
