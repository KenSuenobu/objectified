/**
 * Presentation rules for quota & rate-limit telemetry (REPO-7.3, #2801).
 *
 * REST ships raw numbers plus a `unit`; every decision about how those become something an
 * operator can read lives in `repositoryQuotaTelemetry.ts`. These tests pin the ones that
 * would quietly mislead if they were wrong: a sub-megabyte volume that rounds to "0 MB", a
 * deferral metric that looks like work, and a percentage that claims a ceiling exists when
 * none is being enforced.
 */

import { describe, test, expect } from '@jest/globals';

import {
  BYTES_PER_MEGABYTE,
  METRIC_BYTES_SCANNED,
  METRIC_FILES_DEFERRED,
  METRIC_POLLS,
  METRIC_POLLS_DEFERRED,
  METRIC_SCANS,
  QUOTA_TELEMETRY_RANGES,
  type QuotaTelemetryMetric,
  type RepositoryPollingQuota,
  formatByteSize,
  formatQuotaMetricValue,
  isQuotaTelemetryRange,
  quotaMetricSeries,
  quotaMetricTone,
  quotaPressure,
  quotaPressureCopy,
  quotaRangeLabel,
  quotaUsagePercent,
  quotaWindowLabel,
} from '@/app/components/ade/dashboard/repositories/repositoryQuotaTelemetry';

function metric(overrides: Partial<QuotaTelemetryMetric> = {}): QuotaTelemetryMetric {
  return {
    metric: METRIC_POLLS,
    label: 'Polls',
    description: 'Refresh jobs the sweep enqueued.',
    windowKind: 'hour',
    unit: 'count',
    deferral: false,
    points: [
      { date: '2026-07-29', value: 1 },
      { date: '2026-07-30', value: 4 },
      { date: '2026-07-31', value: 2 },
    ],
    total: 7,
    peak: 4,
    currentWindow: 2,
    ...overrides,
  };
}

function quota(overrides: Partial<RepositoryPollingQuota> = {}): RepositoryPollingQuota {
  return {
    pollsPerHour: 600,
    effectivePollsPerHour: 600,
    windowSeconds: 3600,
    usedThisWindow: 42,
    remainingThisWindow: 558,
    enforced: true,
    ...overrides,
  };
}

describe('byte formatting', () => {
  test('a sub-megabyte volume keeps a unit it can be seen in', () => {
    // Rounding 400 KB to "0 MB" makes a slow-but-alive scanner look like a stopped one.
    expect(formatByteSize(400 * 1024)).toBe('400 KB');
  });

  test('zero and nonsense both read as zero rather than NaN', () => {
    expect(formatByteSize(0)).toBe('0 B');
    expect(formatByteSize(Number.NaN)).toBe('0 B');
    expect(formatByteSize(-1)).toBe('0 B');
  });

  test('megabytes keep a decimal until they stop needing one', () => {
    expect(formatByteSize(1.5 * BYTES_PER_MEGABYTE)).toBe('1.5 MB');
    expect(formatByteSize(48 * BYTES_PER_MEGABYTE)).toBe('48 MB');
  });

  test('a large volume steps up to gigabytes', () => {
    expect(formatByteSize(2.5 * 1024 * BYTES_PER_MEGABYTE)).toBe('2.5 GB');
  });
});

describe('metric values', () => {
  test('a count is grouped, not rendered as bytes', () => {
    expect(formatQuotaMetricValue(metric(), 1234)).toBe((1234).toLocaleString());
  });

  test('a byte metric is rendered in a byte unit', () => {
    const bytes = metric({ metric: METRIC_BYTES_SCANNED, unit: 'bytes', windowKind: 'day' });
    expect(formatQuotaMetricValue(bytes, 2 * BYTES_PER_MEGABYTE)).toBe('2.0 MB');
  });

  test('a byte series is plotted in megabytes so its summary reads in the headline unit', () => {
    const bytes = metric({
      metric: METRIC_BYTES_SCANNED,
      unit: 'bytes',
      points: [
        { date: '2026-07-30', value: BYTES_PER_MEGABYTE },
        { date: '2026-07-31', value: 2.5 * BYTES_PER_MEGABYTE },
      ],
    });
    expect(quotaMetricSeries(bytes)).toEqual([1, 2.5]);
  });

  test('a count series is plotted as stored', () => {
    expect(quotaMetricSeries(metric())).toEqual([1, 4, 2]);
  });

  test('a negative or non-finite point plots as zero rather than inverting the chart', () => {
    const odd = metric({
      points: [
        { date: '2026-07-30', value: -3 },
        { date: '2026-07-31', value: Number.NaN },
      ],
    });
    expect(quotaMetricSeries(odd)).toEqual([0, 0]);
  });
});

describe('metric tones', () => {
  test('deferral metrics share a tone distinct from work performed', () => {
    const deferred = quotaMetricTone(METRIC_POLLS_DEFERRED);
    expect(quotaMetricTone(METRIC_FILES_DEFERRED)).toBe(deferred);
    expect(quotaMetricTone(METRIC_POLLS)).not.toBe(deferred);
    expect(quotaMetricTone(METRIC_SCANS)).not.toBe(deferred);
  });

  test('a metric this build does not know renders neutral rather than crashing', () => {
    // A newer server adding a sixth counter must not take the panel down.
    expect(quotaMetricTone('api_calls')).toBe('neutral');
  });
});

describe('window labels', () => {
  test('an hourly metric says so, so its headline is not read as a daily figure', () => {
    expect(quotaWindowLabel(metric({ windowKind: 'hour' }))).toBe('this hour');
  });

  test('a daily metric says today', () => {
    expect(quotaWindowLabel(metric({ windowKind: 'day' }))).toBe('today');
  });
});

describe('quota pressure', () => {
  test('an unenforced quota has no percentage to report', () => {
    expect(quotaUsagePercent(quota({ enforced: false, effectivePollsPerHour: null }))).toBeNull();
    expect(quotaPressure(quota({ enforced: false, effectivePollsPerHour: null }))).toBe(
      'unlimited'
    );
  });

  test('usage is reported as a percentage of the enforced ceiling', () => {
    expect(quotaUsagePercent(quota({ usedThisWindow: 300, effectivePollsPerHour: 600 }))).toBe(50);
  });

  test('overshoot is clamped rather than reported above the ceiling', () => {
    expect(quotaUsagePercent(quota({ usedThisWindow: 900, effectivePollsPerHour: 600 }))).toBe(100);
  });

  test('pressure escalates before deferrals begin', () => {
    // By the time polls_deferred moves, work has already been postponed — the warning has to
    // arrive earlier than that.
    expect(quotaPressure(quota({ usedThisWindow: 100 }))).toBe('comfortable');
    expect(quotaPressure(quota({ usedThisWindow: 500 }))).toBe('approaching');
    expect(quotaPressure(quota({ usedThisWindow: 600 }))).toBe('exhausted');
  });

  test('the exhausted copy says deferral is not failure', () => {
    const copy = quotaPressureCopy(quota({ usedThisWindow: 600 }));
    expect(copy).toMatch(/deferred/i);
    expect(copy).toMatch(/never marked failed/i);
  });
});

describe('range handling', () => {
  test('the default range is the week the ticket asks for', () => {
    expect(QUOTA_TELEMETRY_RANGES[0]).toBe(7);
  });

  test('only offered ranges are recognised', () => {
    expect(isQuotaTelemetryRange(7)).toBe(true);
    expect(isQuotaTelemetryRange(14)).toBe(false);
  });

  test('the range label spans the reported window', () => {
    const label = quotaRangeLabel({
      days: 7,
      rangeStart: '2026-07-25T00:00:00+00:00',
      rangeEnd: '2026-07-31T00:00:00+00:00',
      available: true,
      metrics: [],
    });
    expect(label).toContain('–');
    expect(label).toMatch(/Jul/);
  });

  test('an unparseable range degrades to nothing rather than to "Invalid Date"', () => {
    expect(
      quotaRangeLabel({
        days: 7,
        rangeStart: 'not-a-date',
        rangeEnd: 'not-a-date',
        available: true,
        metrics: [],
      })
    ).toBe('');
  });
});
