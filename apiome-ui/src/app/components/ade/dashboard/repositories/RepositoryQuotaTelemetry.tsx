'use client';

/**
 * Repository quota & rate-limit telemetry panel (REPO-7.3, #2801).
 *
 * The polling quota (REPO-4.6) and the scan budget (REPO-2.5) both do their work silently.
 * Until this panel, the only evidence a workspace was parked against its ceiling lived in a
 * log line and a per-replica counter that died with the process — so "are we being deferred,
 * or is the repository just quiet?" had no answer anyone could give.
 *
 * Three things are deliberate here:
 *
 *  * **Deferrals are shown apart from work.** `polls` and `polls_deferred` sit in separate
 *    cards with separate tones. Charting them together would turn "the quota postponed our
 *    refreshes" into "we refreshed less", which is the one confusion this page exists to end.
 *  * **A zero is a real answer, an unknown is not.** Every metric renders every day in the
 *    range, so a quiet week draws a flat line rather than a gap. When the counters cannot be
 *    read at all the page says so explicitly rather than letting the same zeros imply calm.
 *  * **The units come from the server.** Each metric carries its own `unit` and `windowKind`,
 *    so this component never hard-codes which counter is bytes and which resets hourly.
 */

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Activity, AlertTriangle, ArrowLeft, Gauge, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { useAuthSession } from '@lib/auth/session-client';
import { cn } from '@lib/utils';
import { Button } from '@/app/components/ui/Button';
import { LoadingState } from '@/app/components/ui/LoadingState';
import { Sparkline } from '@/app/components/ui/mcp/charts/Sparkline';
import {
  dashboardContentStackClass,
  dashboardMainClass,
  dashboardPanelPaddedClass,
} from '@/app/components/ade/dashboard/dashboardScreenClasses';
import {
  QUOTA_TELEMETRY_RANGES,
  type QuotaTelemetryMetric,
  type QuotaTelemetryRange,
  type QuotaTelemetryResponse,
  type QuotaPressure,
  type RepositoryPollingQuota,
  formatQuotaMetricValue,
  quotaMetricSeries,
  quotaMetricTone,
  quotaPressure,
  quotaPressureCopy,
  quotaRangeLabel,
  quotaUsagePercent,
  quotaWindowLabel,
} from '@/app/components/ade/dashboard/repositories/repositoryQuotaTelemetry';

/** Panel accent per quota pressure level, so the ceiling reads before the numbers do. */
const PRESSURE_PANEL_CLASSES: Record<QuotaPressure, string> = {
  unlimited: 'border-gray-200 dark:border-gray-700',
  comfortable: 'border-emerald-200 dark:border-emerald-800',
  approaching: 'border-amber-300 dark:border-amber-700',
  exhausted: 'border-red-300 dark:border-red-700',
};

/** Meter fill per pressure level. */
const PRESSURE_BAR_CLASSES: Record<QuotaPressure, string> = {
  unlimited: 'bg-gray-400 dark:bg-gray-500',
  comfortable: 'bg-emerald-500 dark:bg-emerald-400',
  approaching: 'bg-amber-500 dark:bg-amber-400',
  exhausted: 'bg-red-500 dark:bg-red-400',
};

/** A labelled figure inside the quota summary. */
function QuotaFigure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-2xs uppercase tracking-wider text-gray-500 dark:text-gray-400">
        {label}
      </dt>
      <dd className="mt-0.5 font-mono text-lg text-gray-900 dark:text-gray-100">{value}</dd>
    </div>
  );
}

/**
 * The current polling-quota position: how much of this hour's budget is spent, and what
 * happens when it runs out.
 *
 * @param quota - The tenant's quota projection.
 */
function QuotaSummary({ quota }: { quota: RepositoryPollingQuota }) {
  const pressure = quotaPressure(quota);
  const percent = quotaUsagePercent(quota);

  return (
    <section
      className={cn(dashboardPanelPaddedClass, PRESSURE_PANEL_CLASSES[pressure])}
      aria-label="Polling quota"
      data-testid="quota-summary"
      data-pressure={pressure}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
          <Gauge className="h-4 w-4 shrink-0 text-indigo-500" aria-hidden />
          Polling quota
        </h2>
        <p className="max-w-xl text-xs text-gray-500 dark:text-gray-400">
          {quotaPressureCopy(quota)}
        </p>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <QuotaFigure label="Used this hour" value={quota.usedThisWindow.toLocaleString()} />
        <QuotaFigure
          label="Ceiling"
          value={
            quota.effectivePollsPerHour === null
              ? 'Unlimited'
              : quota.effectivePollsPerHour.toLocaleString()
          }
        />
        <QuotaFigure
          label="Remaining"
          value={
            quota.remainingThisWindow === null ? '—' : quota.remainingThisWindow.toLocaleString()
          }
        />
        <QuotaFigure label="Window" value={`${Math.round(quota.windowSeconds / 60)} min`} />
      </dl>

      {percent === null ? null : (
        <div className="mt-4">
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-700"
            role="meter"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Polling budget used this hour"
          >
            <div
              className={cn('h-full rounded-full transition-all', PRESSURE_BAR_CLASSES[pressure])}
              style={{ width: `${percent}%` }}
            />
          </div>
          <p className="mt-1 text-right text-2xs text-gray-500 dark:text-gray-400">
            {percent}% of this hour’s budget
          </p>
        </div>
      )}
    </section>
  );
}

/**
 * One metric card: its live-bucket value, a 7-day trend, and the range's total and peak.
 *
 * @param metric - The metric to render.
 */
function MetricCard({ metric }: { metric: QuotaTelemetryMetric }) {
  const series = quotaMetricSeries(metric);
  const tone = quotaMetricTone(metric);

  return (
    <section
      className={cn(
        dashboardPanelPaddedClass,
        metric.deferral && 'border-amber-200 dark:border-amber-800'
      )}
      aria-label={metric.label}
      data-testid="quota-metric-card"
      data-metric={metric.metric}
      data-deferral={metric.deferral ? 'true' : 'false'}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 truncate text-sm font-semibold text-gray-900 dark:text-gray-100">
            {metric.deferral ? (
              <AlertTriangle
                className="h-3.5 w-3.5 shrink-0 text-amber-500 dark:text-amber-400"
                aria-hidden
              />
            ) : null}
            {metric.label}
          </h3>
          <p className="mt-1 font-mono text-2xl text-gray-900 dark:text-gray-100">
            {formatQuotaMetricValue(metric, metric.currentWindow)}
          </p>
          <p className="text-2xs text-gray-500 dark:text-gray-400">
            {quotaWindowLabel(metric)}
          </p>
        </div>
        <Sparkline
          data={series}
          tone={tone}
          className="h-10 w-28 shrink-0"
          title={`${metric.label} — last ${metric.points.length} days`}
        />
      </div>

      <dl className="mt-3 flex items-center gap-4 text-2xs text-gray-500 dark:text-gray-400">
        <div className="flex items-center gap-1">
          <dt>Range total</dt>
          <dd className="font-mono text-gray-700 dark:text-gray-300">
            {formatQuotaMetricValue(metric, metric.total)}
          </dd>
        </div>
        <div className="flex items-center gap-1">
          <dt>Busiest day</dt>
          <dd className="font-mono text-gray-700 dark:text-gray-300">
            {formatQuotaMetricValue(metric, metric.peak)}
          </dd>
        </div>
      </dl>

      <p className="mt-2 text-xs leading-snug text-gray-500 dark:text-gray-400">
        {metric.description}
      </p>
    </section>
  );
}

/**
 * The quota telemetry screen: one workspace's polling and scanning volume over a trailing
 * range, with the quota's deferrals surfaced as their own metrics.
 */
export function RepositoryQuotaTelemetry() {
  const { data: session } = useAuthSession();
  const currentTenantId = (session?.user as { current_tenant_id?: string })?.current_tenant_id;

  const [days, setDays] = useState<QuotaTelemetryRange>(QUOTA_TELEMETRY_RANGES[0]);
  const [data, setData] = useState<QuotaTelemetryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!currentTenantId) {
      setData(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/repositories/quota-telemetry?days=${days}`, {
        credentials: 'include',
      });
      const payload = (await res.json().catch(() => ({}))) as QuotaTelemetryResponse;
      if (!res.ok) {
        throw new Error(typeof payload.error === 'string' ? payload.error : res.statusText);
      }
      setData(payload);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not load quota telemetry.';
      setData(null);
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, [currentTenantId, days]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!currentTenantId) {
    return (
      <main className={dashboardMainClass}>
        <div
          className={cn(
            dashboardPanelPaddedClass,
            'border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-900/20'
          )}
        >
          <h2 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
            No tenant selected
          </h2>
          <p className="mt-1 text-sm text-amber-800 dark:text-amber-300">
            Quota telemetry is scoped to one workspace. Choose a tenant to continue.
          </p>
          <Link
            href="/ade/dashboard/tenants"
            className="mt-3 inline-block text-sm font-medium text-amber-900 underline dark:text-amber-200"
          >
            Go to tenants
          </Link>
        </div>
      </main>
    );
  }

  const telemetry = data?.telemetry ?? null;

  return (
    <main className={dashboardMainClass} aria-busy={loading}>
      <div className={dashboardContentStackClass}>
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <Link
              href="/ade/dashboard/repositories"
              className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-indigo-600 dark:text-gray-400 dark:hover:text-indigo-400"
            >
              <ArrowLeft className="h-3.5 w-3.5 shrink-0" aria-hidden />
              Repositories
            </Link>
            <h1 className="mt-1 flex items-center gap-2 text-xl font-semibold text-gray-900 dark:text-gray-100">
              <Activity className="h-5 w-5 shrink-0 text-indigo-500" aria-hidden />
              Quota &amp; rate limits
            </h1>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              How much this workspace polls and scans, and how much the quota has deferred.
              {telemetry ? <> {quotaRangeLabel(telemetry)}.</> : null}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <div
              className="inline-flex overflow-hidden rounded-md border border-gray-200 dark:border-gray-700"
              role="group"
              aria-label="Trailing range"
            >
              {QUOTA_TELEMETRY_RANGES.map((range) => (
                <button
                  key={range}
                  type="button"
                  onClick={() => setDays(range)}
                  aria-pressed={range === days}
                  className={cn(
                    'px-3 py-1.5 text-xs font-medium transition-colors',
                    range === days
                      ? 'bg-indigo-600 text-white dark:bg-indigo-500'
                      : 'bg-white text-gray-600 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'
                  )}
                >
                  {range}d
                </button>
              ))}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void load()}
              disabled={loading}
            >
              <RefreshCw className={cn('mr-2 h-3.5 w-3.5', loading && 'animate-spin')} aria-hidden />
              Refresh
            </Button>
          </div>
        </header>

        {loading && !data ? (
          <LoadingState className="min-h-[30vh]" message="Loading quota telemetry…" />
        ) : null}

        {error ? (
          <div
            className={cn(
              dashboardPanelPaddedClass,
              'border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-900/20'
            )}
            role="alert"
          >
            <h2 className="text-sm font-semibold text-red-900 dark:text-red-200">
              Quota telemetry unavailable
            </h2>
            <p className="mt-1 text-sm text-red-800 dark:text-red-300">{error}</p>
          </div>
        ) : null}

        {data && telemetry ? (
          <>
            <QuotaSummary quota={data.quota} />

            {telemetry.available ? null : (
              <div
                className={cn(
                  dashboardPanelPaddedClass,
                  'border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-900/20'
                )}
                role="status"
                data-testid="telemetry-unavailable"
              >
                <p className="text-sm text-amber-800 dark:text-amber-300">
                  The counters could not be read, so every series below is showing zero. That is
                  missing data, not a quiet week.
                </p>
              </div>
            )}

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {telemetry.metrics.map((metric) => (
                <MetricCard key={metric.metric} metric={metric} />
              ))}
            </div>
          </>
        ) : null}
      </div>
    </main>
  );
}
