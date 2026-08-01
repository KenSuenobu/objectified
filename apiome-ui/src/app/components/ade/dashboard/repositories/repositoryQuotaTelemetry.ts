/**
 * Quota & rate-limit telemetry — types and presentation rules (REPO-7.3, #2801).
 *
 * The REST projection deliberately ships raw numbers and a `unit`, not formatted strings: a
 * byte count rounded to "0 MB" server-side would make a 400 KB day indistinguishable from an
 * idle one, and no client could recover the difference. This module is where those raw values
 * become something a panel can render — units, tones, and the sentence a headline number
 * needs to be unambiguous.
 *
 * It is deliberately React-free so every rule here is unit-testable without a DOM, mirroring
 * `repositoryHealth.ts` next to it.
 */

import type { ChartSeriesTone } from '@/app/components/ui/mcp/charts/chartTokens';

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
 * Series colour per metric. Deferral metrics take amber — the palette's "this is pressure,
 * not an outage" tone — so a glance at the panel separates work done from work postponed
 * without reading a single label.
 */
const METRIC_TONES: Record<string, ChartSeriesTone> = {
  [METRIC_POLLS]: 'indigo',
  [METRIC_POLLS_DEFERRED]: 'amber',
  [METRIC_FILES_DEFERRED]: 'amber',
  [METRIC_SCANS]: 'emerald',
  [METRIC_BYTES_SCANNED]: 'blue',
};

/**
 * Resolve the chart tone for one metric.
 *
 * @param metric - The metric, or its id.
 * @returns The tone to paint its series with; `neutral` for a metric this build does not
 *   recognise, so a newer server adding a sixth counter renders in gray rather than crashing.
 */
export function quotaMetricTone(metric: QuotaTelemetryMetric | string): ChartSeriesTone {
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
