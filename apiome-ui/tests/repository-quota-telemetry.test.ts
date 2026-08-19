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
  QUOTA_PRESSURE_LABEL,
  QUOTA_PRESSURE_STATUS,
  type RepositoryQuotaTelemetry,
  findQuotaMetric,
  quotaDayBars,
  quotaDayBarsAxis,
  quotaDeferralNotice,
} from '@/app/components/ade/repositories/quotaTelemetryModel';
import { statusTone } from '@/app/components/ui/statusVocabulary';
import { meterTier } from '@/app/components/ui/metrics/metricTiers';

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

// ---------------------------------------------------------------------------------------
// HIVE-7.6 (#5323) — the redesign's own rules
// ---------------------------------------------------------------------------------------

describe('the pressure badge', () => {
  test('every level has a word, so the tone is never the only signal', () => {
    for (const level of ['unlimited', 'comfortable', 'approaching', 'exhausted'] as const) {
      expect(QUOTA_PRESSURE_LABEL[level].length).toBeGreaterThan(0);
    }
  });

  test('each level resolves its tone through a string the shared table already holds', () => {
    // Four levels that only one screen uses do not belong in the product-wide vocabulary; they
    // map onto strings it does hold, so the badge stays inside the one tone set.
    expect(statusTone(QUOTA_PRESSURE_STATUS.comfortable)).toBe('ok');
    expect(statusTone(QUOTA_PRESSURE_STATUS.approaching)).toBe('warn');
    expect(statusTone(QUOTA_PRESSURE_STATUS.exhausted)).toBe('danger');
    expect(statusTone(QUOTA_PRESSURE_STATUS.unlimited)).toBe('neutral');
  });

  test('the escalation the badge prints is the one the meter derives', () => {
    // The ticket's "quota meter thresholds match server semantics": one percentage, one set of
    // bands. `meterTier` is what `<Meter>` paints with, so a badge saying "approaching" over a
    // meter drawn in the quiet tone would be this screen disagreeing with itself.
    const at = (used: number) =>
      quotaPressure({
        pollsPerHour: 100,
        effectivePollsPerHour: 100,
        windowSeconds: 3600,
        usedThisWindow: used,
        remainingThisWindow: 100 - used,
        enforced: true,
      });
    expect(at(50)).toBe('comfortable');
    expect(meterTier(50)).toBe('accent');
    expect(at(80)).toBe('approaching');
    expect(meterTier(80)).toBe('warn');
    expect(at(100)).toBe('exhausted');
    expect(meterTier(100)).toBe('danger');
  });
});

describe('the deferral notice', () => {
  /** A telemetry projection carrying one deferral metric with the given range total. */
  const withDeferrals = (total: number): RepositoryQuotaTelemetry => ({
    days: 30,
    rangeStart: '2026-07-17T00:00:00Z',
    rangeEnd: '2026-08-15T00:00:00Z',
    available: true,
    metrics: [
      metric({ metric: METRIC_POLLS, deferral: false, total: 86420 }),
      metric({ metric: METRIC_POLLS_DEFERRED, deferral: true, total }),
    ],
  });

  test('a range that deferred nothing raises no notice', () => {
    expect(quotaDeferralNotice(withDeferrals(0))).toBeNull();
  });

  test('a range that deferred work says how much, and that nothing failed', () => {
    const notice = quotaDeferralNotice(withDeferrals(128));
    expect(notice).toContain('128 polls were deferred');
    expect(notice).toContain('stay due');
    expect(notice).toContain('nothing is marked failed');
  });

  test('one deferral reads as one, not as “1 polls”', () => {
    expect(quotaDeferralNotice(withDeferrals(1))).toContain('1 poll was deferred');
  });
});

describe('the daily distribution', () => {
  /** A metric whose points climb from 0 to `days - 1`. */
  const ramp = (days: number) =>
    metric({
      points: Array.from({ length: days }, (_, index) => ({
        date: `2026-08-${String(index + 1).padStart(2, '0')}`,
        value: index,
      })),
    });

  test('only the trailing window is drawn', () => {
    expect(quotaDayBars(ramp(30), 14)).toHaveLength(14);
    expect(quotaDayBars(ramp(30), 14)[0].date).toBe('2026-08-17');
  });

  test('heights are relative to the busiest day in the window, not to the whole range', () => {
    const bars = quotaDayBars(ramp(30), 14);
    expect(bars[bars.length - 1].percent).toBe(100);
    // The window's own minimum, which is 16 in a 30-day ramp — not 0, which is off the left
    // edge. Scaling to a peak nobody can see would flatten the whole card.
    expect(bars[0].percent).toBe(Math.round((16 / 29) * 100));
  });

  test('an empty day keeps a neutral tone rather than a 0 % accent fill', () => {
    const bars = quotaDayBars(metric({ points: [{ date: '2026-08-01', value: 0 }] }), 14);
    expect(bars[0]).toMatchObject({ value: 0, percent: 0, tone: 'neutral' });
  });

  test('the busiest days take the meter’s warn band, so a heavy day reads like a full meter', () => {
    const bars = quotaDayBars(ramp(15), 14);
    const heavy = bars.filter((bar) => bar.tone === 'warn');
    expect(heavy.length).toBeGreaterThan(0);
    for (const bar of heavy) expect(bar.percent).toBeGreaterThanOrEqual(80);
    for (const bar of bars.filter((bar) => bar.tone === 'accent')) {
      expect(bar.percent).toBeLessThan(80);
    }
  });

  test('a metric with no points draws nothing rather than an empty axis', () => {
    expect(quotaDayBars(metric({ points: [] }), 14)).toEqual([]);
    expect(quotaDayBars(null, 14)).toEqual([]);
  });

  test('the axis names both ends and totals the window, for a reader who cannot see bars', () => {
    const axis = quotaDayBarsAxis(quotaDayBars(ramp(15), 14));
    expect(axis.from).not.toBe('');
    expect(axis.to).not.toBe('');
    // 1 + 2 + … + 14 = 105.
    expect(axis.total).toBe('105 in 14 days');
  });

  test('no bars means no axis to draw', () => {
    expect(quotaDayBarsAxis([])).toEqual({ from: '', to: '', total: '' });
  });
});

describe('finding one metric', () => {
  const telemetry: RepositoryQuotaTelemetry = {
    days: 7,
    rangeStart: '2026-08-09T00:00:00Z',
    rangeEnd: '2026-08-15T00:00:00Z',
    available: true,
    metrics: [metric({ metric: METRIC_POLLS })],
  };

  test('a metric the server reported is returned', () => {
    expect(findQuotaMetric(telemetry, METRIC_POLLS)?.metric).toBe(METRIC_POLLS);
  });

  test('a metric it did not report is null, not an empty stand-in', () => {
    expect(findQuotaMetric(telemetry, METRIC_SCANS)).toBeNull();
    expect(findQuotaMetric(null, METRIC_POLLS)).toBeNull();
  });
});
