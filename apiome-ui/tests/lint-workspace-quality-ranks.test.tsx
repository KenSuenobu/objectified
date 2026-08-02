/**
 * Quality-rank telemetry & grade drift — IXH-2.7 (#5102).
 *
 * Covers the payload coercion (gaps stay gaps, malformed rows degrade), the adapter-share
 * helper, and the panel's rendering contract: per-format split, drift direction, the
 * adapter-versus-spec attribution readout, export readiness, the window selector, and the
 * truncation / style-guide-change notices.
 */

import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import LintWorkspaceQualityRanksPanel, {
  QUALITY_RANK_WINDOWS,
} from '../src/app/components/ade/dashboard/lint/workspace/LintWorkspaceQualityRanksPanel';
import {
  adapterAttributionShare,
  qualityRankSeriesFromPayload,
  type QualityRankFormat,
  type QualityRankSeries,
} from '../src/app/utils/lint-workspace';

function formatEntry(overrides: Partial<QualityRankFormat> = {}): QualityRankFormat {
  return {
    scope: 'import',
    formatKey: 'openapi-3.1',
    adapterKeys: ['openapi'],
    styleGuideVersions: ['guide-a'],
    observations: 6,
    gradeDistribution: { A: 1, B: 3, C: 1, D: 0, F: 1, ungraded: 0 },
    averageScore: 78,
    averageReadiness: null,
    latestScore: 71,
    latestGrade: 'C',
    scoreDelta: -9,
    outcomes: { pass: 4, warn: 1, block: 1, error: 0 },
    blockedCount: 1,
    bestRank: null,
    adapterFindingCount: 3,
    specFindingCount: 9,
    declaredParserLimits: 0,
    attribution: { adapter: { 'intake-resolution': 3 }, spec: { documentation: 9 } },
    points: [
      {
        date: '2026-08-01',
        observations: 3,
        averageScore: 84,
        averageReadiness: null,
        gradeDistribution: { A: 1, B: 2 },
      },
      {
        date: '2026-08-02',
        observations: 3,
        averageScore: 71,
        averageReadiness: null,
        gradeDistribution: { C: 1, F: 1, B: 1 },
      },
    ],
    ...overrides,
  };
}

function series(overrides: Partial<QualityRankSeries> = {}): QualityRankSeries {
  return {
    days: 30,
    windowStart: '2026-07-04',
    windowEnd: '2026-08-02',
    observationCount: 6,
    truncated: false,
    formatLimit: 24,
    stages: { preflight: 4, committed: 2 },
    outcomes: { pass: 4, warn: 1, block: 1, error: 0 },
    formats: [formatEntry()],
    ...overrides,
  };
}

// --- Payload coercion -------------------------------------------------------------------------

describe('qualityRankSeriesFromPayload', () => {
  it('coerces the enveloped response into the series shape', () => {
    const parsed = qualityRankSeriesFromPayload({
      success: true,
      days: 7,
      windowStart: '2026-07-27',
      windowEnd: '2026-08-02',
      observationCount: 2,
      truncated: true,
      formatLimit: 24,
      stages: { preflight: 2, committed: 0 },
      outcomes: { pass: 2 },
      formats: [
        {
          scope: 'export',
          formatKey: 'grpc',
          adapterKeys: ['grpc'],
          styleGuideVersions: ['g1', 'g2'],
          observations: 2,
          gradeDistribution: { B: 2 },
          averageScore: 80,
          averageReadiness: 91,
          latestScore: 80,
          latestGrade: 'B',
          scoreDelta: 0,
          outcomes: { pass: 2 },
          blockedCount: 0,
          bestRank: 1,
          adapterFindingCount: 0,
          specFindingCount: 4,
          declaredParserLimits: 2,
          attribution: { adapter: {}, spec: { naming: 4 } },
          points: [
            { date: '2026-08-02', observations: 2, averageScore: 80, averageReadiness: 91 },
          ],
        },
      ],
    });

    expect(parsed.days).toBe(7);
    expect(parsed.truncated).toBe(true);
    expect(parsed.formats).toHaveLength(1);
    expect(parsed.formats[0].bestRank).toBe(1);
    expect(parsed.formats[0].styleGuideVersions).toEqual(['g1', 'g2']);
    expect(parsed.formats[0].attribution.spec).toEqual({ naming: 4 });
    expect(parsed.formats[0].points[0].gradeDistribution).toEqual({});
  });

  it('keeps a missing average as a gap rather than turning it into zero', () => {
    const parsed = qualityRankSeriesFromPayload({
      formats: [
        {
          formatKey: 'thrift',
          averageScore: null,
          points: [{ date: '2026-08-02', observations: 0, averageScore: null }],
        },
      ],
    });
    expect(parsed.formats[0].averageScore).toBeNull();
    expect(parsed.formats[0].points[0].averageScore).toBeNull();
    expect(parsed.formats[0].points[0].observations).toBe(0);
  });

  it('degrades a malformed payload instead of throwing', () => {
    const parsed = qualityRankSeriesFromPayload({ formats: 'nope', stages: 7 });
    expect(parsed.formats).toEqual([]);
    expect(parsed.stages).toEqual({});
    expect(parsed.observationCount).toBe(0);
  });
});

// --- Attribution share ------------------------------------------------------------------------

describe('adapterAttributionShare', () => {
  it('reports the adapter percentage of the finding split', () => {
    expect(adapterAttributionShare(formatEntry())).toBe(25);
  });

  it('is null when nothing was found, because a share of nothing is not zero percent', () => {
    expect(
      adapterAttributionShare(
        formatEntry({ adapterFindingCount: 0, specFindingCount: 0 }),
      ),
    ).toBeNull();
  });
});

// --- Panel ------------------------------------------------------------------------------------

describe('LintWorkspaceQualityRanksPanel', () => {
  const noop = () => {};

  it('renders one card per format with its distribution and trend', () => {
    render(
      <LintWorkspaceQualityRanksPanel
        series={series({
          formats: [
            formatEntry(),
            formatEntry({ scope: 'export', formatKey: 'grpc', adapterKeys: ['grpc'] }),
          ],
        })}
        days={30}
        onDaysChange={noop}
      />,
    );
    expect(screen.getByTestId('quality-rank-import-openapi-3.1')).toBeInTheDocument();
    expect(screen.getByTestId('quality-rank-export-grpc')).toBeInTheDocument();
    expect(screen.getByTestId('grade-distribution-openapi-3.1')).toBeInTheDocument();
    expect(screen.getByTestId('score-trend-openapi-3.1')).toBeInTheDocument();
  });

  it('renders an em dash rather than a zero for an unmeasured statistic', () => {
    render(
      <LintWorkspaceQualityRanksPanel
        series={series({ formats: [formatEntry({ averageScore: null })] })}
        days={30}
        onDaysChange={noop}
      />,
    );
    const stat = screen.getByTestId('stat-average-score');
    expect(within(stat).getByText('—')).toBeInTheDocument();
  });

  it('states the drift direction of the window', () => {
    render(
      <LintWorkspaceQualityRanksPanel series={series()} days={30} onDaysChange={noop} />,
    );
    expect(screen.getByText(/-9 pts over the window/)).toBeInTheDocument();
  });

  it('says so when there is not enough scored history to state a drift', () => {
    render(
      <LintWorkspaceQualityRanksPanel
        series={series({ formats: [formatEntry({ scoreDelta: null })] })}
        days={30}
        onDaysChange={noop}
      />,
    );
    expect(screen.getByText(/No drift/)).toBeInTheDocument();
  });

  it('separates adapter-attributable findings from spec-attributable ones', () => {
    render(
      <LintWorkspaceQualityRanksPanel series={series()} days={30} onDaysChange={noop} />,
    );
    const split = screen.getByTestId('attribution-import-openapi-3.1');
    expect(within(split).getByText(/25% adapter · 75% specification/)).toBeInTheDocument();
    expect(
      within(split).getByText(/3 adapter-attributable · 9 specification-attributable/),
    ).toBeInTheDocument();
  });

  it('reports declared parser limits as adapter evidence, not as findings', () => {
    render(
      <LintWorkspaceQualityRanksPanel
        series={series({
          formats: [
            formatEntry({
              formatKey: 'thrift',
              adapterKeys: ['thrift'],
              declaredParserLimits: 1,
              adapterFindingCount: 0,
              specFindingCount: 4,
              attribution: { adapter: {}, spec: { documentation: 4 } },
            }),
          ],
        })}
        days={30}
        onDaysChange={noop}
      />,
    );
    const split = screen.getByTestId('attribution-import-thrift');
    expect(within(split).getByText(/0% adapter · 100% specification/)).toBeInTheDocument();
    expect(
      within(split).getByText(/1 construct this adapter declares it cannot read yet/),
    ).toBeInTheDocument();
  });

  it('shows export readiness and rank in the same series', () => {
    render(
      <LintWorkspaceQualityRanksPanel
        series={series({
          formats: [
            formatEntry({
              scope: 'export',
              formatKey: 'grpc',
              averageReadiness: 88,
              bestRank: 2,
            }),
          ],
        })}
        days={30}
        onDaysChange={noop}
      />,
    );
    const card = screen.getByTestId('quality-rank-export-grpc');
    const readiness = within(card).getByTestId('stat-secondary');
    expect(within(readiness).getByText('Average readiness')).toBeInTheDocument();
    expect(within(readiness).getByText('88')).toBeInTheDocument();
    const rank = within(card).getByTestId('stat-tertiary');
    expect(within(rank).getByText('Best rank')).toBeInTheDocument();
    expect(within(rank).getByText('2')).toBeInTheDocument();
  });

  it('offers the documented windows and reports the selection', () => {
    const onDaysChange = jest.fn();
    render(
      <LintWorkspaceQualityRanksPanel series={series()} days={30} onDaysChange={onDaysChange} />,
    );
    for (const window of QUALITY_RANK_WINDOWS) {
      expect(screen.getByRole('button', { name: `${window}d` })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: '30d' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: '90d' }));
    expect(onDaysChange).toHaveBeenCalledWith(90);
  });

  it('warns when more than one style-guide version produced the grades', () => {
    render(
      <LintWorkspaceQualityRanksPanel
        series={series({
          formats: [formatEntry({ styleGuideVersions: ['guide-a', 'guide-b'] })],
        })}
        days={30}
        onDaysChange={noop}
      />,
    );
    expect(screen.getByText(/2 style-guide versions produced these grades/)).toBeInTheDocument();
  });

  it('states truncation rather than silently dropping formats', () => {
    render(
      <LintWorkspaceQualityRanksPanel
        series={series({ truncated: true, formatLimit: 24 })}
        days={30}
        onDaysChange={noop}
      />,
    );
    expect(screen.getByText(/the busiest 24 are/)).toBeInTheDocument();
  });

  it('renders an explanatory empty state when nothing was graded', () => {
    render(
      <LintWorkspaceQualityRanksPanel
        series={series({ formats: [], observationCount: 0 })}
        days={7}
        onDaysChange={noop}
      />,
    );
    expect(screen.getByText(/No grades were recorded in this window/)).toBeInTheDocument();
  });
});
