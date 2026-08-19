/**
 * The bring-in surfaces redesign, rendered (HIVE-7.6, #5323).
 *
 * `repository-spec-catalog.test.ts`, `repository-quota-telemetry.test.ts` and
 * `repository-webhook-ip-allowlist.test.ts` hold the three models' decisions;
 * `repository-bring-in-css.test.ts` pins the declarations; and the three
 * `*-client.test.tsx` suites beside this one hold the behaviour the redesign had to carry
 * over. This holds what the redesign *added*, against mocked reads of all three APIs.
 *
 * What it pins is the ticket's four acceptance criteria and the three mockups'
 * **Notes → Adds** lists:
 *
 *   1. **Discovered-specs filters stay in the URL and are shareable** — the view is written
 *      back to the address bar on every change, and a shared link is honoured on first load.
 *   2. **Quota meter thresholds match server semantics** — the badge's word, the meter's tone
 *      and `quotaPressure`'s classification are one decision, taken once.
 *   3. **Allowlist edits confirm before weakening enforcement** — removing a range and
 *      bypassing enforcement each open a confirm that names what is about to happen; enabling
 *      a range and restoring enforcement, which narrow what is accepted, stay one click.
 *   4. **All three have empty and error states** — every sentence in the three **States** lists
 *      is rendered from the model rather than written inline.
 *
 * Plus the four things the screens got wrong and this ticket fixes: four `<main>` landmarks
 * where the shell already draws one, three back-links where the section has a sub-nav, four
 * hand-rolled inputs, and two mutations that happened on click.
 */

import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { jest } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------------------

const mockReplace = jest.fn();
const mockPush = jest.fn();

/** The current query string, mutable so a shared link can be rendered too. */
let searchParams = new URLSearchParams();

/** The current path, mutable so each screen lights its own sub-nav tab. */
let pathname = '/ade/dashboard/repositories/catalog';

/** The signed-in user, mutable so the no-workspace gate can be rendered too. */
const mockSessionUser: { current_tenant_id?: string; email: string } = {
  current_tenant_id: 't-acme',
  email: 'ada@acme.io',
};

jest.mock('@lib/auth/session-client', () => ({
  useAuthSession: () => ({
    data: { user: mockSessionUser },
    status: 'authenticated',
    update: jest.fn(),
  }),
  AuthSessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  useSearchParams: () => searchParams,
  usePathname: () => pathname,
}));

const mockToastError = jest.fn();
const mockToastSuccess = jest.fn();

jest.mock('sonner', () => ({
  toast: {
    message: jest.fn(),
    success: (...args: unknown[]) => mockToastSuccess(...(args as [])),
    error: (...args: unknown[]) => mockToastError(...(args as [])),
  },
}));

import { DiscoveredSpecsClient } from '../src/app/ade/dashboard/repositories/catalog/DiscoveredSpecsClient';
import { QuotaTelemetryClient } from '../src/app/ade/dashboard/repositories/telemetry/QuotaTelemetryClient';
import { WebhookAllowlistClient } from '../src/app/ade/dashboard/repositories/webhook-ip-allowlist/WebhookAllowlistClient';
import {
  ADDITIONAL_RANGES_EMPTY,
  QUOTA_TELEMETRY_UNAVAILABLE,
  SPEC_CATALOG_EMPTY_TITLE,
  SPEC_CATALOG_ERROR_TITLE,
  SPEC_CATALOG_FILTERED_TITLE,
  SPEC_CATALOG_URL_NOTE,
  SPEC_CATALOG_VOCABULARY_TITLE,
} from '../src/app/components/ade/repositories';

// ---------------------------------------------------------------------------------------
// Fixtures — what the three mockups draw
// ---------------------------------------------------------------------------------------

const REPO_ID = '880e8400-e29b-41d4-a716-446655440003';
const PROJECT_ID = '770e8400-e29b-41d4-a716-446655440002';
const ENTRY_ID = 'aa0e8400-e29b-41d4-a716-44665544000a';

/** One catalog row. */
function spec(overrides: Record<string, unknown> = {}) {
  return {
    id: 'file-1',
    repository_id: REPO_ID,
    repository_full_name: 'acme/payments-specs',
    repository_provider: 'github',
    branch: 'main',
    path: 'specs/payments/openapi.yaml',
    name: 'openapi.yaml',
    ext: 'yaml',
    size_bytes: 65536,
    blob_sha: 'aaa111',
    detected_kind: 'openapi-3.1',
    format: 'openapi',
    display_kind: 'OpenAPI',
    status: 'imported',
    project_id: PROJECT_ID,
    project_name: 'Payments API',
    project_slug: 'payments-api',
    version_id: 'v-1',
    last_imported_at: '2026-08-15T09:30:00Z',
    discovered_at: '2026-08-01T10:00:00Z',
    quality_score: 87,
    quality_grade: 'B',
    quality_status: 'scored',
    external_ref_unresolved_count: null,
    ...overrides,
  };
}

const CATALOG_PAGE = {
  success: true,
  catalog_total: 128,
  match_count: 3,
  limit: 50,
  offset: 0,
  sort: 'repository',
  specs: [
    spec(),
    spec({
      id: 'file-2',
      path: 'specs/refunds/openapi.yaml',
      name: 'openapi.yaml',
      status: 'needs_attention',
      external_ref_unresolved_count: 2,
      size_bytes: 38912,
    }),
    spec({
      id: 'file-3',
      path: 'schemas/money.schema.json',
      name: 'money.schema.json',
      repository_full_name: 'acme/platform-schemas',
      branch: 'master',
      format: 'json_schema',
      display_kind: 'JSON Schema',
      status: 'discovered',
      project_id: null,
      project_name: null,
      project_slug: null,
      last_imported_at: null,
      size_bytes: 4096,
    }),
  ],
  facets: {
    formats: [
      { value: 'openapi', label: 'OpenAPI', count: 64 },
      { value: 'json_schema', label: 'JSON Schema', count: 31 },
    ],
    statuses: [
      { value: 'needs_attention', label: 'Needs attention', count: 3 },
      { value: 'imported', label: 'Imported', count: 17 },
    ],
    repositories: [{ value: REPO_ID, label: 'acme/payments-specs', count: 41 }],
    projects: [{ value: PROJECT_ID, label: 'Payments API', count: 9 }],
  },
};

/** Fourteen ascending days, so the distribution card has a shape to draw. */
const DAYS = Array.from({ length: 14 }, (_, index) => `2026-08-${String(index + 2).padStart(2, '0')}`);

/** One telemetry metric. */
function metric(overrides: Record<string, unknown> = {}) {
  return {
    metric: 'polls',
    label: 'Polls',
    description: 'Provider API calls made by the scheduler.',
    windowKind: 'hour',
    unit: 'count',
    deferral: false,
    points: DAYS.map((date, index) => ({ date, value: 10 + index * 3 })),
    total: 86420,
    peak: 4211,
    currentWindow: 412,
    ...overrides,
  };
}

const TELEMETRY_PAYLOAD = {
  success: true,
  quota: {
    pollsPerHour: 500,
    effectivePollsPerHour: 500,
    windowSeconds: 3600,
    usedThisWindow: 412,
    remainingThisWindow: 88,
    enforced: true,
  },
  telemetry: {
    days: 30,
    rangeStart: '2026-08-09T00:00:00Z',
    rangeEnd: '2026-08-15T00:00:00Z',
    available: true,
    metrics: [
      metric(),
      metric({
        metric: 'polls_deferred',
        label: 'Polls deferred',
        description: 'Polls pushed to the next window by the quota.',
        deferral: true,
        total: 128,
        peak: 41,
        currentWindow: 36,
      }),
      metric({
        metric: 'files_deferred',
        label: 'Files deferred',
        description: 'File re-index jobs held back with their poll.',
        windowKind: 'day',
        deferral: true,
        total: 64,
        peak: 18,
        currentWindow: 12,
      }),
      metric({
        metric: 'scans',
        label: 'Scans',
        description: 'Full repository scans that ran to completion.',
        windowKind: 'day',
        total: 211,
        peak: 14,
        currentWindow: 7,
      }),
      metric({
        metric: 'bytes_scanned',
        label: 'Bytes scanned',
        description: 'Bytes read from provider blobs.',
        windowKind: 'day',
        unit: 'bytes',
        total: 2469606195,
        peak: 432013312,
        currentWindow: 432013312,
      }),
    ],
  },
};

/** The allowlist projection the mockup draws. */
function allowlist(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    enforcementEnabled: true,
    strict: true,
    refreshIntervalSeconds: 86400,
    trustedProxyHops: 1,
    tenantEnforcementEnabled: true,
    bypassReason: null,
    policyUpdatedAt: '2026-08-01T09:00:00Z',
    providers: [
      {
        provider: 'github',
        sourceUrl: 'https://api.github.com/meta',
        note: 'Ranges from the GitHub meta API (hooks section).',
        rangeCount: 3,
        ranges: [
          { cidr: '192.30.252.0/22', family: 4, source: 'provider', refreshedAt: null },
          { cidr: '185.199.108.0/22', family: 4, source: 'provider', refreshedAt: null },
          { cidr: '2a0a:a440::/29', family: 6, source: 'provider', refreshedAt: null },
        ],
        lastAttemptAt: '2026-08-19T07:00:00Z',
        lastSuccessAt: '2026-08-19T07:00:00Z',
        lastOutcome: 'success',
        lastError: null,
        stale: false,
      },
      {
        provider: 'gitlab',
        sourceUrl: 'https://gitlab.com/ranges',
        note: 'gitlab.com published webhook egress ranges.',
        rangeCount: 2,
        ranges: [
          { cidr: '34.74.90.64/28', family: 4, source: 'provider', refreshedAt: null },
          { cidr: '34.74.226.0/24', family: 4, source: 'provider', refreshedAt: null },
        ],
        lastAttemptAt: '2026-08-19T07:00:00Z',
        lastSuccessAt: '2026-08-15T07:00:00Z',
        lastOutcome: 'failure',
        lastError: 'HTTP 503 fetching the range list.',
        stale: true,
      },
      {
        provider: 'bitbucket',
        sourceUrl: null,
        note: 'No range list to fetch — configure ranges for this provider if it delivers here.',
        rangeCount: 0,
        ranges: [],
        lastAttemptAt: null,
        lastSuccessAt: null,
        lastOutcome: 'skipped',
        lastError: null,
        stale: true,
      },
    ],
    entries: [
      {
        id: ENTRY_ID,
        cidr: '203.0.113.0/24',
        family: 4,
        description: 'Self-hosted GitLab runner',
        enabled: true,
        createdAt: '2026-08-02T09:00:00Z',
        updatedAt: null,
      },
      {
        id: 'bb0e8400-e29b-41d4-a716-44665544000b',
        cidr: '198.51.100.7',
        family: 4,
        description: null,
        enabled: false,
        createdAt: '2026-07-18T09:00:00Z',
        updatedAt: null,
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------

let fetchMock: jest.Mock;

/** Every request the screens have made, as `{ url, init }`. */
const calls: { url: string; init?: RequestInit }[] = [];

/**
 * Answer every read with the fixture for its route.
 *
 * @param handler Optional override, for the tests that need a failure or a second projection.
 */
function stubFetch(
  handler?: (url: string, init?: RequestInit) => { status?: number; body: unknown }
) {
  fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const answer = handler?.(url, init) ?? { body: defaultBody(url) };
    const status = answer.status ?? 200;
    return {
      ok: status < 400,
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      json: async () => answer.body,
    };
  }) as unknown as jest.Mock;
  (globalThis as { fetch?: unknown }).fetch = fetchMock;
}

/**
 * The fixture one route answers with.
 *
 * @param url The requested URL.
 * @returns Its payload.
 */
function defaultBody(url: string): unknown {
  if (url.includes('/api/repositories/catalog')) return CATALOG_PAGE;
  if (url.includes('/api/repositories/quota-telemetry')) return TELEMETRY_PAYLOAD;
  return allowlist();
}

beforeEach(() => {
  jest.clearAllMocks();
  calls.length = 0;
  searchParams = new URLSearchParams();
  pathname = '/ade/dashboard/repositories/catalog';
  mockSessionUser.current_tenant_id = 't-acme';
  stubFetch();
});

afterEach(() => {
  delete (globalThis as { fetch?: unknown }).fetch;
});

/** Render the catalog and wait for its first page. */
async function renderCatalog() {
  pathname = '/ade/dashboard/repositories/catalog';
  const view = render(<DiscoveredSpecsClient />);
  await screen.findByTestId('spec-catalog-vocabulary');
  await waitFor(() => expect(document.querySelectorAll('tbody tr[data-row-id]').length).toBe(3));
  return view;
}

/** Render the telemetry screen and wait for its metric grid. */
async function renderTelemetry() {
  pathname = '/ade/dashboard/repositories/telemetry';
  const view = render(<QuotaTelemetryClient />);
  await screen.findByTestId('quota-metrics');
  return view;
}

/** Render the allowlist and wait for its posture banner. */
async function renderAllowlist() {
  pathname = '/ade/dashboard/repositories/webhook-ip-allowlist';
  const view = render(<WebhookAllowlistClient />);
  await screen.findByTestId('allowlist-posture');
  return view;
}

// ---------------------------------------------------------------------------------------
// The shell every one of the three now wears
// ---------------------------------------------------------------------------------------

describe('the page shell', () => {
  test.each([
    ['catalog', renderCatalog, 'Discovered specs', 'catalog'],
    ['telemetry', renderTelemetry, 'Quota & rate limits', 'telemetry'],
    ['allowlist', renderAllowlist, 'Webhook IP allowlist', 'allowlist'],
  ])('%s draws the shared header and lights its own sub-nav tab', async (_id, mount, title, tab) => {
    await (mount as () => Promise<unknown>)();

    expect(screen.getByRole('heading', { level: 1, name: title as string })).toBeInTheDocument();
    const nav = screen.getByTestId('repositories-subnav');
    expect(within(nav).getByTestId(`repositories-tab-${tab}`)).toHaveAttribute(
      'aria-current',
      'page'
    );
  });

  test.each([
    ['catalog', renderCatalog],
    ['telemetry', renderTelemetry],
    ['allowlist', renderAllowlist],
  ])('%s draws no <main> of its own — the shell already owns that landmark', async (_id, mount) => {
    await (mount as () => Promise<unknown>)();
    expect(document.querySelectorAll('main')).toHaveLength(0);
    expect(document.querySelectorAll('.page')).toHaveLength(1);
  });

  test.each([
    ['catalog', renderCatalog],
    ['telemetry', renderTelemetry],
    ['allowlist', renderAllowlist],
  ])('%s replaces its back link with a breadcrumb trail', async (_id, mount) => {
    await (mount as () => Promise<unknown>)();
    const trail = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(trail).getByRole('link', { name: 'Repositories' })).toHaveAttribute(
      'href',
      '/ade/dashboard/repositories'
    );
  });

  test.each([
    ['catalog', () => <DiscoveredSpecsClient />, '/ade/dashboard/repositories/catalog'],
    ['telemetry', () => <QuotaTelemetryClient />, '/ade/dashboard/repositories/telemetry'],
    [
      'allowlist',
      () => <WebhookAllowlistClient />,
      '/ade/dashboard/repositories/webhook-ip-allowlist',
    ],
  ])('%s gates on a workspace with the shared lock', async (_id, element, route) => {
    // Rendered directly rather than through the helpers above: with no workspace there is no
    // read to wait for, which is the whole point of the gate (HIVE-2.5, #5284).
    mockSessionUser.current_tenant_id = undefined;
    pathname = route as string;
    render((element as () => React.ReactElement)());

    expect(await screen.findByText('Pick a workspace first')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------
// 1. Discovered specs
// ---------------------------------------------------------------------------------------

describe('discovered specs', () => {
  test('the filters are mirrored to the address bar, and say so', async () => {
    const user = userEvent.setup();
    await renderCatalog();

    expect(screen.getByText(SPEC_CATALOG_URL_NOTE)).toBeInTheDocument();

    await user.click(screen.getByLabelText('Format'));
    await user.click(await screen.findByRole('option', { name: /JSON Schema \(31\)/ }));

    await waitFor(() =>
      expect(mockReplace).toHaveBeenLastCalledWith(
        '/ade/dashboard/repositories/catalog?format=json_schema',
        { scroll: false }
      )
    );
  });

  test('a shared link is honoured on first load, filters and page alike', async () => {
    searchParams = new URLSearchParams({ format: 'openapi', status: 'imported', offset: '50' });
    await renderCatalog();

    const query = new URL(String(calls[0].url), 'http://localhost').searchParams;
    expect(query.get('format')).toBe('openapi');
    expect(query.get('status')).toBe('imported');
    expect(query.get('offset')).toBe('50');
  });

  test('a narrowing facet is marked as narrowing, not just as chosen', async () => {
    searchParams = new URLSearchParams({ format: 'openapi' });
    await renderCatalog();

    expect(screen.getByTestId('spec-catalog-filter-format')).toHaveAttribute('data-active');
    expect(screen.getByTestId('spec-catalog-filter-status')).not.toHaveAttribute('data-active');
  });

  test('the status pills come from the shared vocabulary, not from a palette of their own', async () => {
    await renderCatalog();

    const pills = screen.getAllByTestId('spec-catalog-status');
    expect(pills[0]).toHaveAttribute('data-status', 'imported');
    expect(pills[1]).toHaveAttribute('data-status', 'needs_attention');
    expect(pills[2]).toHaveAttribute('data-status', 'discovered');
    for (const pill of pills) {
      expect(pill.className).not.toMatch(/emerald|amber|blue-|gray-/);
    }
  });

  test('the vocabulary card explains every state the rows can be in', async () => {
    await renderCatalog();

    const card = screen.getByTestId('spec-catalog-vocabulary');
    expect(within(card).getByText(SPEC_CATALOG_VOCABULARY_TITLE)).toBeInTheDocument();
    for (const label of ['Needs attention', 'Imported', 'Mapped', 'Discovered']) {
      expect(within(card).getByText(label)).toBeInTheDocument();
    }
    // The meaning is on the page, not only in a `title` a pointer has to hover.
    expect(
      within(card).getByText(/Indexed by the scanner and not yet mapped to a project/)
    ).toBeInTheDocument();
  });

  test('an unresolved external $ref is called out on the row that has one', async () => {
    await renderCatalog();

    const flags = screen.getAllByTestId('spec-catalog-unresolved');
    expect(flags).toHaveLength(1);
    expect(flags[0]).toHaveTextContent('2 unresolved external $refs');
  });

  test('the empty state and the filtered miss are different sentences', async () => {
    stubFetch(() => ({ body: { ...CATALOG_PAGE, specs: [], match_count: 0, catalog_total: 0 } }));
    pathname = '/ade/dashboard/repositories/catalog';
    render(<DiscoveredSpecsClient />);
    expect(await screen.findByText(SPEC_CATALOG_EMPTY_TITLE)).toBeInTheDocument();

    screen.getByTestId('spec-catalog-vocabulary');
    searchParams = new URLSearchParams({ q: 'nothing-matches' });
    render(<DiscoveredSpecsClient />);
    expect(await screen.findByText(SPEC_CATALOG_FILTERED_TITLE)).toBeInTheDocument();
  });

  test('a failed read names this screen’s read rather than “this list”', async () => {
    stubFetch(() => ({ status: 503, body: { success: false, error: 'Repository API down' } }));
    pathname = '/ade/dashboard/repositories/catalog';
    render(<DiscoveredSpecsClient />);

    const error = await screen.findByTestId('spec-catalog-error');
    expect(within(error).getByText(SPEC_CATALOG_ERROR_TITLE)).toBeInTheDocument();
    expect(within(error).getByText('Repository API down')).toBeInTheDocument();
    expect(within(error).getByRole('button', { name: /Try again/ })).toBeInTheDocument();
    // The filter panel survives the failure, so a retry can be a narrower request.
    expect(screen.getByTestId('spec-catalog-filters')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------
// 2. Quota & rate limits
// ---------------------------------------------------------------------------------------

describe('quota and rate limits', () => {
  test('the pressure level is a word beside the heading, not only a frame colour', async () => {
    await renderTelemetry();

    const badge = screen.getByTestId('quota-pressure-badge');
    expect(badge).toHaveTextContent('approaching');
    expect(badge).toHaveAttribute('data-status', 'warning');
    expect(screen.getByTestId('quota-summary')).toHaveAttribute('data-pressure', 'approaching');
  });

  test('the meter reports the same share the badge classifies', async () => {
    await renderTelemetry();

    const meter = within(screen.getByTestId('quota-summary')).getByRole('meter');
    // 412 of 500 is 82 %, which is the `approaching` band on both sides.
    expect(meter).toHaveAttribute('aria-valuenow', '82');
    expect(meter).toHaveAttribute('data-tone', 'warn');
  });

  test('the range deferred work, so the screen says so above the cards', async () => {
    await renderTelemetry();

    const notice = screen.getByTestId('quota-deferral-notice');
    expect(notice).toHaveTextContent('128 polls were deferred');
    expect(notice).toHaveTextContent('nothing is marked failed');
  });

  test('a range that deferred nothing raises no notice', async () => {
    stubFetch((url) =>
      url.includes('quota-telemetry')
        ? {
            body: {
              ...TELEMETRY_PAYLOAD,
              telemetry: {
                ...TELEMETRY_PAYLOAD.telemetry,
                metrics: TELEMETRY_PAYLOAD.telemetry.metrics.map((m) =>
                  m.metric === 'polls_deferred' ? { ...m, total: 0 } : m
                ),
              },
            },
          }
        : { body: defaultBody(url) }
    );
    await renderTelemetry();

    expect(screen.queryByTestId('quota-deferral-notice')).not.toBeInTheDocument();
  });

  test('the distribution card draws one bar per day and prints the total in words', async () => {
    await renderTelemetry();

    const card = screen.getByTestId('quota-day-bars');
    expect(card.querySelectorAll('.quota-bars__bar')).toHaveLength(DAYS.length);
    // The figure the fourteen rectangles stand for, for a reader who cannot see them.
    expect(within(card).getByText(/in 14 days/)).toBeInTheDocument();
  });

  test('the range group is one choice, not three independent toggles', async () => {
    await renderTelemetry();

    const group = screen.getByTestId('quota-range');
    expect(group).toHaveAttribute('role', 'radiogroup');
    expect(within(group).getByRole('radio', { name: '7d' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(within(group).getByRole('radio', { name: '30d' })).toHaveAttribute(
      'aria-checked',
      'false'
    );
  });

  test('counters that could not be read say so, rather than reading as a quiet week', async () => {
    stubFetch((url) =>
      url.includes('quota-telemetry')
        ? {
            body: {
              ...TELEMETRY_PAYLOAD,
              telemetry: { ...TELEMETRY_PAYLOAD.telemetry, available: false },
            },
          }
        : { body: defaultBody(url) }
    );
    await renderTelemetry();

    expect(screen.getByTestId('telemetry-unavailable')).toHaveTextContent(
      QUOTA_TELEMETRY_UNAVAILABLE
    );
  });

  test('a failed read is a retryable error state, not a rose panel', async () => {
    stubFetch(() => ({ status: 503, body: { success: false, error: 'Counters unavailable' } }));
    pathname = '/ade/dashboard/repositories/telemetry';
    render(<QuotaTelemetryClient />);

    const error = await screen.findByTestId('quota-error');
    expect(within(error).getByText('Quota telemetry unavailable')).toBeInTheDocument();
    expect(within(error).getByRole('button', { name: /Try again/ })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------
// 3. Webhook IP allowlist
// ---------------------------------------------------------------------------------------

describe('the webhook allowlist', () => {
  test('the posture is stated with a word, a glyph and a tone', async () => {
    await renderAllowlist();

    const banner = screen.getByTestId('allowlist-posture');
    expect(banner).toHaveAttribute('data-posture', 'enforced');
    expect(banner).toHaveAttribute('data-tone', 'ok');
    expect(within(banner).getByText('Enforced')).toBeInTheDocument();
    expect(banner.querySelector('.wal-tile')).toHaveAttribute('data-tone', 'ok');
  });

  test('an overdue provider is framed, and says “overdue” in words as well', async () => {
    await renderAllowlist();

    const cards = screen.getAllByTestId('provider-card');
    const gitlab = cards.find((card) => card.getAttribute('data-provider') === 'gitlab')!;
    expect(gitlab).toHaveAttribute('data-overdue', 'true');
    expect(within(gitlab).getByTestId('refresh-summary')).toHaveTextContent(/overdue/);
    expect(within(gitlab).getByTestId('provider-error')).toHaveTextContent('HTTP 503');
  });

  test('a provider with no list to fetch is settled, not framed as overdue', async () => {
    await renderAllowlist();

    const cards = screen.getAllByTestId('provider-card');
    const bitbucket = cards.find((card) => card.getAttribute('data-provider') === 'bitbucket')!;
    expect(bitbucket).toHaveAttribute('data-stale', 'true');
    expect(bitbucket).not.toHaveAttribute('data-overdue');
    expect(within(bitbucket).queryByTestId('provider-error')).not.toBeInTheDocument();
  });

  test('removing a range confirms first, and cancelling changes nothing', async () => {
    const user = userEvent.setup();
    await renderAllowlist();

    await user.click(screen.getByRole('button', { name: 'Remove 203.0.113.0/24' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText('Remove 203.0.113.0/24?')).toBeInTheDocument();

    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(calls.some((call) => call.init?.method === 'DELETE')).toBe(false);
  });

  test('disabling a range does not confirm — it narrows nothing and is one click back', async () => {
    const user = userEvent.setup();
    await renderAllowlist();

    await user.click(screen.getAllByRole('button', { name: 'Disable' })[0]);

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    await waitFor(() => expect(calls.some((call) => call.init?.method === 'PATCH')).toBe(true));
  });

  test('restoring enforcement does not confirm — it is the safe direction', async () => {
    stubFetch((url, init) =>
      init?.method === 'PUT'
        ? { body: allowlist() }
        : { body: allowlist({ tenantEnforcementEnabled: false, bypassReason: 'Vendor relay' }) }
    );
    const user = userEvent.setup();
    await renderAllowlist();

    await user.click(screen.getByRole('button', { name: /Restore enforcement/ }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    await waitFor(() => {
      const put = calls.find((call) => call.init?.method === 'PUT');
      expect(JSON.parse(String(put!.init!.body))).toEqual({
        enforcementEnabled: true,
        bypassReason: null,
      });
    });
  });

  test('an empty allowlist says the provider ranges are the whole filter', async () => {
    stubFetch((url) =>
      url.includes('webhook-ip-allowlist') ? { body: allowlist({ entries: [] }) } : { body: defaultBody(url) }
    );
    await renderAllowlist();

    expect(screen.getByTestId('allowlist-empty')).toHaveTextContent(ADDITIONAL_RANGES_EMPTY);
  });

  test('a failed read is a retryable error state, not a rose panel', async () => {
    stubFetch(() => ({ status: 503, body: { success: false, error: 'Allowlist API down' } }));
    pathname = '/ade/dashboard/repositories/webhook-ip-allowlist';
    render(<WebhookAllowlistClient />);

    const error = await screen.findByTestId('allowlist-error');
    expect(within(error).getByText('Allowlist unavailable')).toBeInTheDocument();
    expect(within(error).getByRole('button', { name: /Try again/ })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------
// Browser fixtures
// ---------------------------------------------------------------------------------------

/**
 * The markup `e2e/hive-repository-bring-in.spec.ts` measures.
 *
 * Rather than hand-writing five HTML files that would drift the first time a class changed,
 * the browser suite measures what *this* suite rendered. The block below renders every
 * surface and writes what it rendered into `e2e/fixtures/hive-repository-bring-in/` when
 * `BRING_IN_FIXTURE_DUMP=1` is set:
 *
 *     BRING_IN_FIXTURE_DUMP=1 npx jest -c jest.config.ts \
 *       tests/repository-bring-in-hive-redesign.test.tsx -t fixtures
 *
 * Without the variable the test still runs — it renders every surface and checks each is
 * there — so a change that would leave the fixtures stale fails loudly here before it fails
 * quietly in the browser.
 */
describe('the browser fixtures', () => {
  const OUT = path.join(__dirname, '..', 'e2e', 'fixtures', 'hive-repository-bring-in');
  const dump = process.env.BRING_IN_FIXTURE_DUMP === '1';

  /**
   * Write one fixture, or just assert it could be written.
   *
   * @param name The fixture's file name, without the extension.
   * @param html The markup to write.
   */
  const write = (name: string, html: string) => {
    expect(html.length).toBeGreaterThan(0);
    if (!dump) return;
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, `${name}.html`), html);
  };

  /**
   * Serialise a subtree with its live form state.
   *
   * `outerHTML` writes *attributes*, and a value typed into a field has only the `value`
   * **property** — so a fixture of a filled form would arrive in the browser empty, and the
   * browser suite would measure the wrong thing.
   *
   * @param node The subtree to serialise.
   * @returns Its markup, with control state written into the attributes.
   */
  const serialize = (node: HTMLElement) => {
    node.querySelectorAll('input').forEach((input) => {
      if (input.type === 'checkbox' || input.type === 'radio') {
        if (input.checked) input.setAttribute('checked', '');
        else input.removeAttribute('checked');
      } else if (input.value) {
        input.setAttribute('value', input.value);
      }
    });
    return node.outerHTML;
  };

  /** The page column the shell would put this screen in. */
  const page = () => serialize(document.querySelector('.page') as HTMLElement);

  /** An overlay, which portals to the body rather than into the page column. */
  const overlay = (testId: string) =>
    serialize(screen.getByTestId(testId).closest('[role="alertdialog"]') as HTMLElement);

  test('renders the discovered-specs table (and writes its fixture on request)', async () => {
    await renderCatalog();
    write('catalog', page());
  });

  test('renders the discovered-specs empty state (and writes its fixture)', async () => {
    stubFetch(() => ({ body: { ...CATALOG_PAGE, specs: [], match_count: 0, catalog_total: 0 } }));
    pathname = '/ade/dashboard/repositories/catalog';
    render(<DiscoveredSpecsClient />);
    await screen.findByText(SPEC_CATALOG_EMPTY_TITLE);
    write('catalog-empty', page());
  });

  test('renders the quota telemetry screen (and writes its fixture)', async () => {
    await renderTelemetry();
    write('telemetry', page());
  });

  test('renders the webhook allowlist (and writes its fixture)', async () => {
    await renderAllowlist();
    write('allowlist', page());
  });

  test('renders the remove-range confirm (and writes its fixture)', async () => {
    const user = userEvent.setup();
    await renderAllowlist();
    await user.click(screen.getByRole('button', { name: 'Remove 203.0.113.0/24' }));
    await screen.findByRole('alertdialog');
    write('remove-range', overlay('allowlist-remove-confirm'));
  });
});
