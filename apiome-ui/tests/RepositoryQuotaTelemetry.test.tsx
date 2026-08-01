/**
 * Integration tests for the quota & rate-limit telemetry page (REPO-7.3, #2801).
 *
 * These drive the real component against a stubbed `/api/repositories/quota-telemetry` and
 * assert the behaviours the ticket's acceptance criteria name:
 *
 *  - the last 7 days are shown for every metric, including metrics with no activity;
 *  - deferral counts are surfaced separately from the work that was performed;
 *  - the range is server-side — changing it re-requests rather than slicing what is held.
 *
 * Plus the degradation that matters most: counters that could not be read must not render as
 * a quiet week.
 */

import { describe, test, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

/** Mutable so one test can drive the "no tenant selected" guard. */
let currentTenantId: string | undefined = 'tenant-1';

jest.mock('@lib/auth/session-client', () => ({
  useAuthSession: () => ({ data: { user: { current_tenant_id: currentTenantId } } }),
}));

jest.mock('sonner', () => ({
  toast: { error: jest.fn(), message: jest.fn(), success: jest.fn() },
}));

import { RepositoryQuotaTelemetry } from '@/app/components/ade/dashboard/repositories/RepositoryQuotaTelemetry';

const MB = 1024 * 1024;

/** Seven ascending dates, oldest first, matching the API's zero-filled series. */
const DAYS = [
  '2026-07-25',
  '2026-07-26',
  '2026-07-27',
  '2026-07-28',
  '2026-07-29',
  '2026-07-30',
  '2026-07-31',
];

function points(values: number[]) {
  return DAYS.map((date, index) => ({ date, value: values[index] ?? 0 }));
}

function metrics() {
  return [
    {
      metric: 'polls',
      label: 'Polls',
      description: 'Refresh jobs the auto-refresh sweep enqueued for this tenant.',
      windowKind: 'hour',
      unit: 'count',
      deferral: false,
      points: points([10, 12, 9, 14, 20, 18, 11]),
      total: 94,
      peak: 20,
      currentWindow: 3,
    },
    {
      metric: 'polls_deferred',
      label: 'Repositories deferred',
      description: 'Due repositories the sweep skipped because the tenant was out of budget.',
      windowKind: 'hour',
      unit: 'count',
      deferral: true,
      points: points([0, 0, 0, 0, 6, 4, 0]),
      total: 10,
      peak: 6,
      currentWindow: 0,
    },
    {
      metric: 'files_deferred',
      label: 'Files deferred',
      description: 'Stale files left unenqueued when the budget ran out part-way.',
      windowKind: 'hour',
      unit: 'count',
      deferral: true,
      points: points([0, 0, 0, 0, 0, 0, 0]),
      total: 0,
      peak: 0,
      currentWindow: 0,
    },
    {
      metric: 'scans',
      label: 'Scans',
      description: 'Repository branch scan passes.',
      windowKind: 'day',
      unit: 'count',
      deferral: false,
      points: points([3, 3, 2, 4, 5, 4, 2]),
      total: 23,
      peak: 5,
      currentWindow: 2,
    },
    {
      metric: 'bytes_scanned',
      label: 'Content scanned',
      description: 'Repository content indexed by those scan passes.',
      windowKind: 'day',
      unit: 'bytes',
      deferral: false,
      points: points([MB, 2 * MB, MB, 3 * MB, 4 * MB, 2 * MB, 5 * MB]),
      total: 18 * MB,
      peak: 5 * MB,
      currentWindow: 5 * MB,
    },
  ];
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    quota: {
      pollsPerHour: 600,
      effectivePollsPerHour: 600,
      windowSeconds: 3600,
      usedThisWindow: 42,
      remainingThisWindow: 558,
      enforced: true,
    },
    telemetry: {
      days: 7,
      rangeStart: '2026-07-25T00:00:00+00:00',
      rangeEnd: '2026-07-31T00:00:00+00:00',
      available: true,
      metrics: metrics(),
    },
    ...overrides,
  };
}

let fetchMock: jest.Mock;

/** Query parameters of the most recent request. */
function lastQuery(): URLSearchParams {
  const calls = fetchMock.mock.calls;
  const url = (calls[calls.length - 1] as unknown[])[0] as string;
  return new URL(url, 'http://localhost').searchParams;
}

function stubFetch(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  fetchMock = jest.fn(async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: 'OK',
    json: async () => body,
  }));
  (globalThis as { fetch?: unknown }).fetch = fetchMock;
}

beforeEach(() => {
  jest.clearAllMocks();
  currentTenantId = 'tenant-1';
  stubFetch(payload());
});

afterEach(() => {
  delete (globalThis as { fetch?: unknown }).fetch;
});

describe('the metric panels', () => {
  test('shows every metric the server reported', async () => {
    render(<RepositoryQuotaTelemetry />);

    await waitFor(() => expect(screen.getAllByTestId('quota-metric-card')).toHaveLength(5));
    expect(screen.getByRole('heading', { name: 'Polls' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Repositories deferred/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Content scanned' })).toBeInTheDocument();
  });

  test('a metric with no activity all week still renders its panel', async () => {
    // Absence of deferrals is the answer an operator came for; a missing card reads as
    // "telemetry is broken" instead.
    render(<RepositoryQuotaTelemetry />);

    await waitFor(() => expect(screen.getAllByTestId('quota-metric-card')).toHaveLength(5));
    const card = screen
      .getAllByTestId('quota-metric-card')
      .find((node) => node.getAttribute('data-metric') === 'files_deferred');
    expect(card).toBeDefined();
    expect(within(card!).getByRole('heading', { name: /Files deferred/ })).toBeInTheDocument();
  });

  test('deferral metrics are marked apart from work performed', async () => {
    render(<RepositoryQuotaTelemetry />);

    await waitFor(() => expect(screen.getAllByTestId('quota-metric-card')).toHaveLength(5));
    const byMetric = Object.fromEntries(
      screen
        .getAllByTestId('quota-metric-card')
        .map((node) => [node.getAttribute('data-metric'), node.getAttribute('data-deferral')])
    );
    expect(byMetric['polls']).toBe('false');
    expect(byMetric['scans']).toBe('false');
    expect(byMetric['polls_deferred']).toBe('true');
    expect(byMetric['files_deferred']).toBe('true');
  });

  test('each metric plots one point per day in the range', async () => {
    render(<RepositoryQuotaTelemetry />);

    await waitFor(() => expect(screen.getAllByTestId('quota-metric-card')).toHaveLength(5));
    const polls = screen
      .getAllByTestId('quota-metric-card')
      .find((node) => node.getAttribute('data-metric') === 'polls')!;
    // The sparkline's accessible fallback is a row per point.
    expect(within(polls).getAllByRole('row')).toHaveLength(DAYS.length);
  });

  test('a byte metric is rendered in a byte unit, not as a raw count', async () => {
    render(<RepositoryQuotaTelemetry />);

    await waitFor(() => expect(screen.getAllByTestId('quota-metric-card')).toHaveLength(5));
    const scanned = screen
      .getAllByTestId('quota-metric-card')
      .find((node) => node.getAttribute('data-metric') === 'bytes_scanned')!;
    expect(within(scanned).getAllByText('5.0 MB').length).toBeGreaterThan(0);
    expect(within(scanned).getByText('18 MB')).toBeInTheDocument();
    expect(within(scanned).queryByText((18 * MB).toLocaleString())).not.toBeInTheDocument();
  });

  test('an hourly metric labels its headline as an hourly figure', async () => {
    render(<RepositoryQuotaTelemetry />);

    await waitFor(() => expect(screen.getAllByTestId('quota-metric-card')).toHaveLength(5));
    const polls = screen
      .getAllByTestId('quota-metric-card')
      .find((node) => node.getAttribute('data-metric') === 'polls')!;
    expect(within(polls).getByText('this hour')).toBeInTheDocument();
  });
});

describe('the quota summary', () => {
  test('reports the current window against the enforced ceiling', async () => {
    render(<RepositoryQuotaTelemetry />);

    const summary = await screen.findByTestId('quota-summary');
    expect(within(summary).getByText('42')).toBeInTheDocument();
    expect(within(summary).getByText('600')).toBeInTheDocument();
    expect(within(summary).getByText('558')).toBeInTheDocument();
  });

  test('an unlimited workspace shows no meter and says no ceiling is enforced', async () => {
    stubFetch(
      payload({
        quota: {
          pollsPerHour: 0,
          effectivePollsPerHour: null,
          windowSeconds: 3600,
          usedThisWindow: 42,
          remainingThisWindow: null,
          enforced: false,
        },
      })
    );
    render(<RepositoryQuotaTelemetry />);

    const summary = await screen.findByTestId('quota-summary');
    expect(summary).toHaveAttribute('data-pressure', 'unlimited');
    expect(within(summary).queryByRole('meter')).not.toBeInTheDocument();
    expect(within(summary).getByText(/No polling ceiling/i)).toBeInTheDocument();
  });

  test('a workspace at its ceiling is flagged before the deferral series is read', async () => {
    stubFetch(
      payload({
        quota: {
          pollsPerHour: 600,
          effectivePollsPerHour: 600,
          windowSeconds: 3600,
          usedThisWindow: 600,
          remainingThisWindow: 0,
          enforced: true,
        },
      })
    );
    render(<RepositoryQuotaTelemetry />);

    const summary = await screen.findByTestId('quota-summary');
    expect(summary).toHaveAttribute('data-pressure', 'exhausted');
    expect(within(summary).getByRole('meter')).toHaveAttribute('aria-valuenow', '100');
  });
});

describe('the range', () => {
  test('requests seven days by default', async () => {
    render(<RepositoryQuotaTelemetry />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(lastQuery().get('days')).toBe('7');
  });

  test('changing the range re-requests rather than slicing what is already held', async () => {
    render(<RepositoryQuotaTelemetry />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    await userEvent.click(screen.getByRole('button', { name: '30d' }));

    await waitFor(() => expect(lastQuery().get('days')).toBe('30'));
  });
});

describe('degradation', () => {
  test('counters that could not be read are called out, not shown as a quiet week', async () => {
    stubFetch(
      payload({
        telemetry: {
          days: 7,
          rangeStart: '2026-07-25T00:00:00+00:00',
          rangeEnd: '2026-07-31T00:00:00+00:00',
          available: false,
          metrics: metrics().map((m) => ({
            ...m,
            points: points([]),
            total: 0,
            peak: 0,
            currentWindow: 0,
          })),
        },
      })
    );
    render(<RepositoryQuotaTelemetry />);

    const banner = await screen.findByTestId('telemetry-unavailable');
    expect(banner).toHaveTextContent(/missing data, not a quiet week/i);
  });

  test('a failed request surfaces the error instead of an empty dashboard', async () => {
    stubFetch({ success: false, error: 'Repository API unavailable' }, { ok: false, status: 503 });
    render(<RepositoryQuotaTelemetry />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Repository API unavailable');
    expect(screen.queryByTestId('quota-metric-card')).not.toBeInTheDocument();
  });

  test('with no tenant selected the page asks for one instead of requesting nothing', async () => {
    currentTenantId = undefined;
    render(<RepositoryQuotaTelemetry />);

    expect(await screen.findByText('No tenant selected')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Go to tenants/i })).toHaveAttribute(
      'href',
      '/ade/dashboard/tenants'
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
