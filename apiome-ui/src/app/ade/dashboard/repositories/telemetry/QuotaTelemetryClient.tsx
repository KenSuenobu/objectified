'use client';

/**
 * Bring in → Quota & rate limits (HIVE-7.6, #5323).
 *
 * Authority: `docs/mockups/sources/repository-telemetry.html`, whose **Notes → Keeps (1:1)**
 * list is this ticket's acceptance criteria for this screen; DESIGN.md §5.3 (page header) and
 * §7 (the metrics set).
 *
 * ### What this screen is
 *
 * The polling quota (REPO-4.6) and the scan budget (REPO-2.5) both do their work silently.
 * Until this page, the only evidence a workspace was parked against its ceiling lived in a log
 * line and a per-replica counter that died with the process — so "are we being deferred, or is
 * the repository just quiet?" had no answer anyone could give.
 *
 * Three things were true before the redesign and still are:
 *
 *  * **Deferrals are shown apart from work.** `polls` and `polls_deferred` sit in separate
 *    cards with separate tones. Charting them together would turn "the quota postponed our
 *    refreshes" into "we refreshed less", which is the one confusion this page exists to end.
 *  * **A zero is a real answer, an unknown is not.** Every metric renders every day in the
 *    range, so a quiet week draws a flat line rather than a gap. When the counters cannot be
 *    read at all the page says so explicitly rather than letting the same zeros imply calm.
 *  * **The units come from the server.** Each metric carries its own `unit` and `windowKind`,
 *    so nothing here hard-codes which counter is bytes and which resets hourly.
 *
 * ### What the redesign changed
 *
 * 1. **The pressure level was a border colour.** It is a badge carrying the level as a word,
 *    which is the ticket's "quota meter thresholds match server semantics" criterion made
 *    legible: the threshold is `quotaPressure`'s, the meter derives the same tone from the
 *    same percentage, and the badge prints the level in text.
 * 2. **The deferral count was only inside a card.** The range's deferrals are a notice above
 *    the grid now — the one figure on this screen that changes what an operator should do.
 * 3. **The range group was three hand-built buttons** with an indigo active fill. It is
 *    `ui/Segmented`.
 * 4. **A failed read was a rose panel.** It is `ui/ErrorState`, with a retry.
 * 5. **The header carried a back link.** It is the shared page header with the Repositories
 *    sub-nav under it.
 *
 * One deviation from the mockup, recorded here because it is a semantics change rather than a
 * paint one: the mockup's range group is three `aria-pressed` toggle buttons. Three mutually
 * exclusive ranges are a single choice, not three independent toggles, so this is the shared
 * `Segmented` — a `radiogroup` whose selected option is `aria-checked`.
 */

import * as React from 'react';
import { RefreshCw, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';

import { useAuthSession } from '@lib/auth/session-client';

import PageHeader from '@/app/components/shell/PageHeader';
import { Page, PageBody } from '@/app/components/shell/pageChrome';
import { Alert, AlertDescription } from '@/app/components/ui/Alert';
import { Button } from '@/app/components/ui/Button';
import { GatedState } from '@/app/components/ui/EmptyState';
import { ErrorState } from '@/app/components/ui/ErrorState';
import { LoadingState } from '@/app/components/ui/LoadingState';
import { Segmented, SegmentedItem } from '@/app/components/ui/Segmented';
import {
  METRIC_POLLS,
  QUOTA_TELEMETRY_ERROR_FALLBACK,
  QUOTA_TELEMETRY_ERROR_TITLE,
  QUOTA_TELEMETRY_LOADING,
  QUOTA_TELEMETRY_NO_TENANT,
  QUOTA_TELEMETRY_RANGES,
  QUOTA_TELEMETRY_UNAVAILABLE,
  QuotaDayBarsCard,
  QuotaMetricCard,
  QuotaPressurePanel,
  RepositoriesSubNav,
  findQuotaMetric,
  isQuotaTelemetryRange,
  quotaDeferralNotice,
  quotaRangeLabel,
  type QuotaTelemetryRange,
  type QuotaTelemetryResponse,
} from '@/app/components/ade/repositories';

/** Where the breadcrumb's first crumb goes. */
const HOME_ROUTE = '/ade/dashboard';

/**
 * The page description: what is being measured, over which dates.
 *
 * @param range The date span, as `quotaRangeLabel` formats it, or an empty string before the
 *   first response.
 * @returns The sentence under the title. The dates are appended only once they are known.
 */
function telemetrySummaryLine(range: string): string {
  const base = 'How much this workspace polls and scans, and how much the quota has deferred.';
  return range ? `${base} ${range}.` : base;
}

/**
 * The quota telemetry screen.
 *
 * @returns The page.
 */
export function QuotaTelemetryClient() {
  const { data: session } = useAuthSession();
  const currentTenantId = (session?.user as { current_tenant_id?: string } | undefined)
    ?.current_tenant_id;

  const [days, setDays] = React.useState<QuotaTelemetryRange>(QUOTA_TELEMETRY_RANGES[0]);
  const [data, setData] = React.useState<QuotaTelemetryResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    if (!currentTenantId) {
      setData(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/repositories/quota-telemetry?days=${days}`, {
        credentials: 'include',
      });
      const payload = (await response.json().catch(() => ({}))) as QuotaTelemetryResponse;
      if (!response.ok) {
        throw new Error(
          typeof payload.error === 'string' ? payload.error : response.statusText
        );
      }
      setData(payload);
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : QUOTA_TELEMETRY_ERROR_FALLBACK;
      setData(null);
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, [currentTenantId, days]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const telemetry = data?.telemetry ?? null;
  const deferralNotice = telemetry ? quotaDeferralNotice(telemetry) : null;
  const pollsMetric = findQuotaMetric(telemetry, METRIC_POLLS);

  return (
    <Page>
      <PageHeader
        breadcrumb={[
          { label: 'Home', href: HOME_ROUTE },
          { label: 'Bring in' },
          { label: 'Repositories', href: '/ade/dashboard/repositories' },
          { label: 'Quota & rate limits' },
        ]}
        title="Quota & rate limits"
        description={telemetrySummaryLine(telemetry ? quotaRangeLabel(telemetry) : '')}
        actions={
          <>
            <Segmented
              value={String(days)}
              onValueChange={(next) => {
                const parsed = Number.parseInt(next, 10);
                if (isQuotaTelemetryRange(parsed)) setDays(parsed);
              }}
              size="sm"
              aria-label="Trailing range"
              data-testid="quota-range"
            >
              {QUOTA_TELEMETRY_RANGES.map((range) => (
                <SegmentedItem
                  key={range}
                  value={String(range)}
                  data-testid={`quota-range-${range}`}
                >
                  {range}d
                </SegmentedItem>
              ))}
            </Segmented>
            <Button
              variant="outline"
              onClick={() => void load()}
              disabled={loading || !currentTenantId}
              data-testid="quota-refresh"
            >
              <RefreshCw className={loading ? 'animate-spin' : undefined} aria-hidden />
              Refresh
            </Button>
          </>
        }
        tabs={<RepositoriesSubNav active="telemetry" />}
      />

      <PageBody>
        {!currentTenantId ? (
          <GatedState description={QUOTA_TELEMETRY_NO_TENANT} />
        ) : error ? (
          <ErrorState
            title={QUOTA_TELEMETRY_ERROR_TITLE}
            description={error}
            onRetry={() => void load()}
            data-testid="quota-error"
          />
        ) : loading && !data ? (
          <LoadingState message={QUOTA_TELEMETRY_LOADING} />
        ) : data && telemetry ? (
          <>
            <QuotaPressurePanel quota={data.quota} />

            {telemetry.available ? null : (
              <Alert variant="warn" data-testid="telemetry-unavailable">
                <AlertDescription>{QUOTA_TELEMETRY_UNAVAILABLE}</AlertDescription>
              </Alert>
            )}

            {deferralNotice ? (
              <Alert
                variant="warn"
                icon={<TriangleAlert className="mt-px size-4 shrink-0" aria-hidden />}
                data-testid="quota-deferral-notice"
              >
                <AlertDescription>{deferralNotice}</AlertDescription>
              </Alert>
            ) : null}

            <div className="quota-metrics" data-testid="quota-metrics">
              {telemetry.metrics.map((metric) => (
                <QuotaMetricCard key={metric.metric} metric={metric} />
              ))}
              {pollsMetric ? <QuotaDayBarsCard metric={pollsMetric} /> : null}
            </div>
          </>
        ) : null}
      </PageBody>
    </Page>
  );
}

export default QuotaTelemetryClient;
