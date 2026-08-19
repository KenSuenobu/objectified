/**
 * Quota & rate limits — the rules behind `/ade/dashboard/repositories/telemetry`
 * (HIVE-7.6, #5323).
 *
 * Authority: `docs/mockups/sources/repository-telemetry.html` and its **Notes → Keeps (1:1)**
 * list; DESIGN.md §7 (metrics) and §8 (dashboard page).
 *
 * The REST projection deliberately ships raw numbers and a `unit`, not formatted strings: a
 * byte count rounded to "0 MB" server-side would make a 400 KB day indistinguishable from an
 * idle one, and no client could recover the difference. This module is where those raw values
 * become something a panel can render — units, tones, and the sentence a headline number
 * needs to be unambiguous.
 *
 * It is deliberately React-free so every rule here is unit-testable without a DOM, mirroring
 * `repositoryHealth.ts` next to it.
 *
 * ### What HIVE-7.6 changed
 *
 * `quotaMetricTone` returned a `ChartSeriesTone` from the MCP analytics kit, whose palette is
 * *categorical* — it exists to tell five series apart. A quota panel is not a five-series
 * chart: polls are work, deferrals are pressure, and the tone has to say which. So a metric
 * now resolves to a `MetricTone` from `ui/metrics`, the ordered scale the meter and the badge
 * beside it already read, and the deferral metrics take the same amber the pressure badge does.
 *
 * The panel's copy — every state in the mockup's **States** list, the deferral notice, the
 * word the pressure badge prints — is a constant here rather than a string inside a component,
 * so the rendered suite and the browser fixture assert against what the screen prints.
 */

import type { MetricTone } from '@/app/components/ui/metrics/metricTiers';

/** Bytes in one megabyte — the divisor the `bytes` unit implies. */
export const BYTES_PER_MEGABYTE = 1024 * 1024;

/** Trailing ranges the panel offers. 7 is the REPO-7.3 default; 90 is the API's ceiling. */
export const QUOTA_TELEMETRY_RANGES = [7, 30, 90] as const;

/** A range the panel can request. */
export type QuotaTelemetryRange = (typeof QUOTA_TELEMETRY_RANGES)[number];

/** One day of one metric. */
export interface QuotaTelemetryPoint {
  /** ISO 8601 date (UTC) the point covers. */
  date: string;
  /** The metric's total for that day, in the metric's stored unit. */
  value: number;
}

/** One metric's trailing series and headline numbers. */
export interface QuotaTelemetryMetric {
  /** Stable id: `polls`, `polls_deferred`, `files_deferred`, `scans`, `bytes_scanned`. */
  metric: string;
  /** Short human-readable name, supplied by REST so the vocabulary lives in one place. */
  label: string;
  /** One sentence on what the metric counts. */
  description: string;
  /** The bucket the counter resets on: `hour` or `day`. */
  windowKind: string;
  /** Unit of every value in this metric: `count` or `bytes`. */
  unit: string;
  /** True when the metric counts work the quota deferred rather than work performed. */
  deferral: boolean;
  /** One point per day in the range, oldest first. */
  points: QuotaTelemetryPoint[];
  /** Sum of every point in the range. */
  total: number;
  /** Largest single day in the range. */
  peak: number;
  /** The metric's value in its live bucket — the current hour, or today. */
  currentWindow: number;
}

/** The telemetry half of the response. */
export interface RepositoryQuotaTelemetry {
  days: number;
  rangeStart: string;
  rangeEnd: string;
  /** False when the counters could not be read — the zeros mean "unknown", not "idle". */
  available: boolean;
  metrics: QuotaTelemetryMetric[];
}

/** The tenant's current polling-quota position (REPO-4.6). */
export interface RepositoryPollingQuota {
  pollsPerHour: number;
  effectivePollsPerHour: number | null;
  windowSeconds: number;
  usedThisWindow: number;
  remainingThisWindow: number | null;
  enforced: boolean;
}

/** What `GET /api/repositories/quota-telemetry` returns. */
export interface QuotaTelemetryResponse {
  success: boolean;
  quota: RepositoryPollingQuota;
  telemetry: RepositoryQuotaTelemetry;
  error?: string;
}

/** Metric ids, so a consumer can single one out without repeating a string literal. */
export const METRIC_POLLS = 'polls';
export const METRIC_POLLS_DEFERRED = 'polls_deferred';
export const METRIC_FILES_DEFERRED = 'files_deferred';
export const METRIC_SCANS = 'scans';
export const METRIC_BYTES_SCANNED = 'bytes_scanned';

/**
 * Series colour per metric.
 *
 * Deferral metrics take `warn` — the ordered scale's "this is pressure, not an outage" step —
 * so a glance at the panel separates work done from work postponed without reading a single
 * label. The tones come from `ui/metrics`, which is a projection of the status vocabulary, so
 * a deferral sparkline is the same amber as the `approaching` badge above it.
 */
const METRIC_TONES: Record<string, MetricTone> = {
  [METRIC_POLLS]: 'accent',
  [METRIC_POLLS_DEFERRED]: 'warn',
  [METRIC_FILES_DEFERRED]: 'warn',
  [METRIC_SCANS]: 'ok',
  [METRIC_BYTES_SCANNED]: 'violet',
};

/**
 * Resolve the mark tone for one metric.
 *
 * @param metric - The metric, or its id.
 * @returns The tone to paint its series with; `neutral` for a metric this build does not
 *   recognise, so a newer server adding a sixth counter renders in grey rather than crashing.
 */
export function quotaMetricTone(metric: QuotaTelemetryMetric | string): MetricTone {
  const id = typeof metric === 'string' ? metric : metric.metric;
  return METRIC_TONES[id] ?? 'neutral';
}

/**
 * Format a byte count for display, choosing the largest unit that keeps it readable.
 *
 * Sub-megabyte volumes keep a KB unit rather than rounding to `0 MB`: "we scanned 400 KB"
 * and "we scanned nothing" are different operational facts, and the second one is the only
 * one worth investigating.
 *
 * @param bytes - Raw byte count. Non-finite or negative input reads as 0.
 * @returns A short string such as `0 B`, `412 KB`, `1.4 MB`, `2.3 GB`.
 */
export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < BYTES_PER_MEGABYTE) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * BYTES_PER_MEGABYTE) {
    const mb = bytes / BYTES_PER_MEGABYTE;
    return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  }
  return `${(bytes / (1024 * BYTES_PER_MEGABYTE)).toFixed(1)} GB`;
}

/**
 * Format one value in a metric's own unit.
 *
 * @param metric - The metric the value belongs to (supplies the unit).
 * @param value - The raw value, as stored.
 * @returns A display string: a locale-grouped count, or a byte size.
 */
export function formatQuotaMetricValue(metric: QuotaTelemetryMetric, value: number): string {
  const safe = Number.isFinite(value) && value > 0 ? value : 0;
  return metric.unit === 'bytes' ? formatByteSize(safe) : Math.round(safe).toLocaleString();
}

/**
 * Convert a metric's points into the numbers its sparkline plots.
 *
 * Byte metrics are converted to megabytes so the chart's accessible summary ("latest 1.4")
 * reads in the same unit as the headline beside it rather than in nine-digit byte counts.
 *
 * @param metric - The metric to plot.
 * @returns One number per day, oldest first.
 */
export function quotaMetricSeries(metric: QuotaTelemetryMetric): number[] {
  return metric.points.map((point) => {
    const raw = Number.isFinite(point.value) && point.value > 0 ? point.value : 0;
    if (metric.unit !== 'bytes') return raw;
    return Math.round((raw / BYTES_PER_MEGABYTE) * 100) / 100;
  });
}

/**
 * Name the live bucket a `currentWindow` value belongs to.
 *
 * @param metric - The metric whose bucket to name.
 * @returns `this hour` or `today` — the phrase that stops "42" being read as a daily figure
 *   when it is an hourly one.
 */
export function quotaWindowLabel(metric: QuotaTelemetryMetric): string {
  return metric.windowKind === 'hour' ? 'this hour' : 'today';
}

/**
 * How much of the tenant's polling quota is spent in the current window.
 *
 * @param quota - The quota projection.
 * @returns A percentage in `[0, 100]`, or `null` when nothing is being enforced (an
 *   unlimited tenant has no meaningful "percent used").
 */
export function quotaUsagePercent(quota: RepositoryPollingQuota): number | null {
  const limit = quota.effectivePollsPerHour;
  if (!quota.enforced || limit === null || limit <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((quota.usedThisWindow / limit) * 100)));
}

/** How close to its ceiling a tenant is, as a word the panel can style on. */
export type QuotaPressure = 'unlimited' | 'comfortable' | 'approaching' | 'exhausted';

/**
 * Classify a tenant's position against its polling quota.
 *
 * The thresholds exist so the panel says something before deferrals begin: by the time
 * `polls_deferred` moves, work has already been postponed.
 *
 * @param quota - The quota projection.
 * @returns `unlimited` when nothing is enforced, `exhausted` at the ceiling, `approaching`
 *   from 80% of it, `comfortable` below that.
 */
export function quotaPressure(quota: RepositoryPollingQuota): QuotaPressure {
  const percent = quotaUsagePercent(quota);
  if (percent === null) return 'unlimited';
  if (percent >= 100) return 'exhausted';
  if (percent >= 80) return 'approaching';
  return 'comfortable';
}

/** One sentence per pressure level, so the panel never has to invent copy inline. */
const PRESSURE_COPY: Record<QuotaPressure, string> = {
  unlimited: 'No polling ceiling is being enforced for this workspace.',
  comfortable: 'Polling is comfortably inside this workspace’s hourly ceiling.',
  approaching:
    'Polling is approaching this workspace’s hourly ceiling. Repositories are deferred, not failed, once it is reached.',
  exhausted:
    'This workspace has spent its hourly polling budget. Remaining repositories are deferred to the next window — they stay due and are never marked failed.',
};

/**
 * The sentence describing a tenant's quota position.
 *
 * @param quota - The quota projection.
 * @returns Operator-facing copy for the current pressure level.
 */
export function quotaPressureCopy(quota: RepositoryPollingQuota): string {
  return PRESSURE_COPY[quotaPressure(quota)];
}

/**
 * Format the trailing range as a human date span.
 *
 * @param telemetry - The telemetry projection.
 * @returns Something like `25 Jul – 31 Jul`, or an empty string when the range is unparseable.
 */
export function quotaRangeLabel(telemetry: RepositoryQuotaTelemetry): string {
  const start = new Date(telemetry.rangeStart);
  const end = new Date(telemetry.rangeEnd);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return '';
  const format = (value: Date) =>
    value.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${format(start)} – ${format(end)}`;
}

/**
 * Whether a range is one the API will accept.
 *
 * @param days - A candidate range.
 * @returns True when `days` is one of {@link QUOTA_TELEMETRY_RANGES}.
 */
export function isQuotaTelemetryRange(days: number): days is QuotaTelemetryRange {
  return (QUOTA_TELEMETRY_RANGES as readonly number[]).includes(days);
}

// ---------------------------------------------------------------------------------------
// The pressure badge, and the notice under it
// ---------------------------------------------------------------------------------------

/**
 * The word the badge beside the *Polling quota* heading prints.
 *
 * It is the pressure level itself, lower-case, exactly as the mockup draws it. A single word
 * beside the heading is what lets a reader answer "are we being throttled?" before reading
 * four figures — and because it is a word rather than only a colour, DESIGN.md §6 is met.
 */
export const QUOTA_PRESSURE_LABEL: Readonly<Record<QuotaPressure, string>> = {
  unlimited: 'unlimited',
  comfortable: 'comfortable',
  approaching: 'approaching',
  exhausted: 'exhausted',
};

/**
 * The status string the pressure badge resolves its tone through.
 *
 * The four levels are not in `ui/statusVocabulary`'s table and should not be: they are this
 * panel's own scale, not a product-wide lifecycle. Mapping them onto vocabulary strings the
 * table *does* hold keeps the badge inside the shared tone set without adding four entries
 * that only one screen would ever ask for.
 */
export const QUOTA_PRESSURE_STATUS: Readonly<Record<QuotaPressure, string>> = {
  unlimited: 'unknown',
  comfortable: 'ok',
  approaching: 'warning',
  exhausted: 'failed',
};

/** The heading of the polling-quota panel. */
export const QUOTA_PANEL_TITLE = 'Polling quota';

/** The live region while the first read is in flight. */
export const QUOTA_TELEMETRY_LOADING = 'Loading quota telemetry…';

/** The heading a failed read gets. The message beside it is whatever the server said. */
export const QUOTA_TELEMETRY_ERROR_TITLE = 'Quota telemetry unavailable';

/** The fallback message when a failed read carried no explanation of its own. */
export const QUOTA_TELEMETRY_ERROR_FALLBACK = 'Could not load quota telemetry.';

/**
 * What `available: false` means, said out loud.
 *
 * Without this the same zeros that mean "a quiet week" would be read as a quiet week. The
 * sentence is the whole reason the flag is on the projection.
 */
export const QUOTA_TELEMETRY_UNAVAILABLE =
  'The counters could not be read, so every series below is showing zero. That is missing data, not a quiet week.';

/** The workspace gate: quota is metered per tenant. */
export const QUOTA_TELEMETRY_NO_TENANT =
  'Quota telemetry is metered per workspace, so pick one to see how much of its budget is being spent.';

/**
 * The amber notice above the metric cards, or null when nothing was deferred.
 *
 * A deferral is the one number on this screen that changes what an operator should do, so it
 * gets a sentence of its own above the cards rather than only a figure inside one. The second
 * half is the part that stops it reading as an outage: a deferred repository is still due.
 *
 * @param telemetry - The telemetry projection.
 * @returns The notice, or null when the range deferred nothing — in which case there is
 *   nothing to warn about and a banner saying "0 deferred" would be noise.
 */
export function quotaDeferralNotice(telemetry: RepositoryQuotaTelemetry): string | null {
  const deferred = telemetry.metrics
    .filter((metric) => metric.deferral && metric.metric === METRIC_POLLS_DEFERRED)
    .reduce((total, metric) => total + (Number.isFinite(metric.total) ? metric.total : 0), 0);
  if (deferred <= 0) return null;
  return `${deferred.toLocaleString()} poll${deferred === 1 ? ' was' : 's were'} deferred in this range — quota pressure is shaping the scan schedule. Deferred repositories stay due; nothing is marked failed.`;
}

// ---------------------------------------------------------------------------------------
// Polls by day — the distribution card the mockup's **Adds** list introduces
// ---------------------------------------------------------------------------------------

/** How many days the distribution card draws. The mockup's own window. */
export const QUOTA_BARS_DAYS = 14;

/** One bar of the daily distribution. */
export interface QuotaDayBar {
  /** The ISO date the bar covers. */
  date: string;
  /** The day's raw value, in the metric's stored unit. */
  value: number;
  /** Height as a whole percentage of the busiest day in the window, 0–100. */
  percent: number;
  /** The tone the bar is painted in — `neutral` for a day with nothing in it. */
  tone: MetricTone;
}

/**
 * The trailing distribution of one metric, as bars.
 *
 * Heights are relative to the busiest day *in the window*, not to the range's peak: the card
 * is about shape — which days are heavy, where the weekend dip falls — and scaling to a peak
 * that is off the left edge would flatten the whole thing.
 *
 * The tone bands are the meter's, so the busiest quarter of a fortnight reads in the same
 * amber a meter over 80 % does. A day with no activity keeps `neutral` rather than a 0 %
 * accent fill, because "nothing happened" is a measurement and should look like one.
 *
 * @param metric - The metric to distribute, or null when the server reported none.
 * @param days - How many trailing days to draw (default {@link QUOTA_BARS_DAYS}).
 * @returns One bar per day, oldest first; an empty array when there is nothing to draw.
 */
export function quotaDayBars(
  metric: QuotaTelemetryMetric | null | undefined,
  days: number = QUOTA_BARS_DAYS
): QuotaDayBar[] {
  if (!metric || metric.points.length === 0 || days <= 0) return [];
  const window = metric.points.slice(-days);
  const peak = window.reduce(
    (highest, point) => (Number.isFinite(point.value) ? Math.max(highest, point.value) : highest),
    0
  );
  return window.map((point) => {
    const value = Number.isFinite(point.value) && point.value > 0 ? point.value : 0;
    const percent = peak > 0 ? Math.round((value / peak) * 100) : 0;
    return { date: point.date, value, percent, tone: quotaDayBarTone(value, percent) };
  });
}

/**
 * The tone one bar takes.
 *
 * @param value - The day's raw value.
 * @param percent - Its share of the window's busiest day.
 * @returns `neutral` for an empty day, `warn` from 80 % of the peak, `accent` below that —
 *   the same bands `meterTier` uses, so a heavy day and a full meter agree.
 */
function quotaDayBarTone(value: number, percent: number): MetricTone {
  if (value <= 0) return 'neutral';
  return percent >= 80 ? 'warn' : 'accent';
}

/**
 * The axis labels under the distribution: the first day, the last day, and the total.
 *
 * @param bars - The bars, as {@link quotaDayBars} returned them.
 * @returns `{ from, to, total }` as display strings; empty strings when there are no bars.
 */
export function quotaDayBarsAxis(bars: readonly QuotaDayBar[]): {
  from: string;
  to: string;
  total: string;
} {
  if (bars.length === 0) return { from: '', to: '', total: '' };
  const label = (iso: string) => {
    const parsed = new Date(iso);
    if (Number.isNaN(parsed.getTime())) return iso;
    return parsed.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
  };
  const total = bars.reduce((sum, bar) => sum + bar.value, 0);
  return {
    from: label(bars[0].date),
    to: label(bars[bars.length - 1].date),
    total: `${total.toLocaleString()} in ${bars.length} days`,
  };
}

/**
 * Look one metric up by id.
 *
 * @param telemetry - The telemetry projection, or null.
 * @param metric - The metric id, e.g. {@link METRIC_POLLS}.
 * @returns The metric, or null when this server did not report it — which is the honest
 *   answer, and the reason the distribution card renders nothing rather than an empty axis.
 */
export function findQuotaMetric(
  telemetry: RepositoryQuotaTelemetry | null | undefined,
  metric: string
): QuotaTelemetryMetric | null {
  return telemetry?.metrics.find((candidate) => candidate.metric === metric) ?? null;
}
