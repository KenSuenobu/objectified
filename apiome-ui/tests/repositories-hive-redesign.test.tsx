/**
 * The Repositories redesign, rendered (HIVE-7.3, #5320).
 *
 * `repositories-model.test.ts` holds the decisions and `repositories-css.test.ts` pins the
 * declarations; this holds the screen that makes them, against a mocked `/api/repositories`
 * returning the documented `{repositories: […]}` envelope. What it pins is the ticket's four
 * acceptance criteria and the mockup's **Notes → Keeps (1:1)** list:
 *
 *   1. **The four provider badges are distinguishable** — each carries its own glyph *and* its
 *      own name, in both views, so neither colour nor shape is the only signal.
 *   2. **Health states map to the shared status vocabulary** — the badge's tone comes from
 *      `statusTone`, asserted on the rendered class.
 *   3. **The sub-nav preserves the current routes**, with the current one marked
 *      `aria-current="page"`.
 *   4. **The empty state explains how to connect the first repository**, and is a different
 *      sentence from the filtered miss.
 *
 * Plus the five things the screen this replaces got wrong and this ticket fixes: five buttons
 * in the page header, a failed read that looked like an empty workspace, a card and a table
 * that offered different verbs, a card that was a stretched link over `pointer-events: none`
 * content, and a rescan reachable only in bulk.
 */

import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { jest } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

const mockPush = jest.fn();
const mockConfirm = jest.fn<Promise<boolean>, [unknown]>(() => Promise.resolve(true));
const mockAlert = jest.fn<Promise<void>, [unknown]>(() => Promise.resolve());

jest.mock('@lib/auth/session-client', () => ({
  useAuthSession: () => ({
    data: { user: { user_id: 'u-ada', current_tenant_id: 't-acme', email: 'ada@acme.io' } },
    status: 'authenticated',
    update: jest.fn(),
  }),
  AuthSessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/ade/dashboard/repositories',
}));

jest.mock('@/app/components/providers/DialogProvider', () => ({
  useDialog: () => ({
    confirm: (options: unknown) => mockConfirm(options),
    alert: (options: unknown) => mockAlert(options),
  }),
}));

const mockToastMessage = jest.fn();
const mockToastSuccess = jest.fn();
const mockToastError = jest.fn();

jest.mock('sonner', () => ({
  toast: {
    message: (...args: unknown[]) => mockToastMessage(...(args as [])),
    success: (...args: unknown[]) => mockToastSuccess(...(args as [])),
    error: (...args: unknown[]) => mockToastError(...(args as [])),
  },
}));

import RepositoriesClient from '../src/app/ade/dashboard/repositories/RepositoriesClient';
import { TooltipProvider } from '../src/app/components/ui/Tooltip';
import { statusTone } from '../src/app/components/ui/statusVocabulary';
import { REPOSITORY_STATUS_POLL_MS } from '../src/app/components/ade/dashboard/repositories/repositoryStoreUi';

// ---------------------------------------------------------------------------------------
// Fixtures — the four repositories the mockup draws
// ---------------------------------------------------------------------------------------

const PAYMENTS = {
  id: '4d1e9a00-0000-4000-8000-000000000001',
  name: 'payments-specs',
  full_name: 'acme/payments-specs',
  description: 'OpenAPI and AsyncAPI sources for the payments platform; scanned on push.',
  provider: 'github',
  default_branch: 'main',
  visibility: 'private',
  status: 'ready',
  last_scanned_at: '2026-08-18T10:00:00.000Z',
  total_files: 1204,
  importable_count: 180,
  recent_scans: [
    { branch: 'main', finished_at: '2026-08-14T10:00:00.000Z', status: 'succeeded' },
    { branch: 'main', finished_at: '2026-08-15T10:00:00.000Z', status: 'failed' },
    { branch: 'main', finished_at: '2026-08-16T10:00:00.000Z', status: 'succeeded' },
    { branch: 'main', finished_at: '2026-08-17T10:00:00.000Z', status: 'succeeded' },
    { branch: 'main', finished_at: '2026-08-18T10:00:00.000Z', status: 'succeeded' },
  ],
  health: {
    level: 'warnings',
    score: 74,
    window_days: 30,
    scans_attempted: 4,
    scans_succeeded: 3,
    scan_success_rate: 0.75,
    parse_error_count: 0,
    primary_factor: {
      code: 'scan-failures',
      level: 'warnings',
      summary: '3 of 4 scans succeeded in the last 30 days.',
      observed_at: '2026-08-15T10:00:00.000Z',
    },
    factors: [],
  },
};

const ORDERS = {
  id: '7c21e900-0000-4000-8000-000000000002',
  name: 'orders-contracts',
  full_name: 'acme/orders-contracts',
  description: 'Order lifecycle contracts, JSON Schema + Protobuf.',
  provider: 'github',
  default_branch: 'main',
  visibility: 'private',
  status: 'scanning',
  last_scanned_at: null,
  total_files: 0,
  importable_count: null,
  recent_scans: [],
  health: {
    level: 'healthy',
    score: 100,
    window_days: 30,
    scans_attempted: 8,
    scans_succeeded: 8,
    scan_success_rate: 1,
    parse_error_count: 0,
    primary_factor: null,
    factors: [],
  },
};

const PLATFORM = {
  id: 'b00b1e00-0000-4000-8000-000000000003',
  name: 'platform-schemas',
  full_name: 'acme-group/platform-schemas',
  description: null,
  provider: 'gitlab',
  default_branch: 'master',
  visibility: 'private',
  status: 'ready',
  last_scanned_at: '2026-08-17T09:00:00.000Z',
  total_files: 412,
  importable_count: 140,
  recent_scans: [],
  health: {
    level: 'healthy',
    score: 100,
    window_days: 30,
    scans_attempted: 6,
    scans_succeeded: 6,
    scan_success_rate: 1,
    parse_error_count: 0,
    primary_factor: null,
    factors: [],
  },
};

const LEGACY = {
  id: 'c0ffee00-0000-4000-8000-000000000004',
  name: 'legacy-soap',
  full_name: 'git.example.org/acme/legacy-soap',
  description: 'WSDL archive registered by public URL. Last scan failed: clone timed out.',
  provider: 'public_url',
  default_branch: 'trunk',
  visibility: 'public',
  status: 'error',
  last_scanned_at: '2026-08-10T09:00:00.000Z',
  total_files: 0,
  importable_count: null,
  recent_scans: [],
  health: {
    level: 'error',
    score: 10,
    window_days: 30,
    scans_attempted: 0,
    scans_succeeded: 0,
    scan_success_rate: null,
    parse_error_count: 0,
    primary_factor: {
      code: 'no-scans',
      level: 'error',
      summary: 'No scans finished in the last 30 days.',
      observed_at: null,
    },
    factors: [],
  },
};

const ALL = [PAYMENTS, ORDERS, PLATFORM, LEGACY];

/** The refresh-activity payload — two affected repositories, one healthy. */
const REFRESH_SIGNALS = [
  {
    repository_id: PAYMENTS.id,
    repository_full_name: PAYMENTS.full_name,
    clone_url: null,
    branch: 'main',
    path: 'specs/payments.yaml',
    last_imported_committed_at: '2026-08-10T00:00:00Z',
    last_imported_blob_sha: 'blob-a',
    remote_committed_at: '2026-08-16T00:00:00Z',
    remote_blob_sha: 'blob-b',
    is_refreshing: false,
    last_refresh_failed: false,
    last_refreshed_at: null,
  },
  {
    repository_id: LEGACY.id,
    repository_full_name: LEGACY.full_name,
    clone_url: null,
    branch: 'trunk',
    path: 'wsdl/legacy.wsdl',
    last_imported_committed_at: '2026-08-10T00:00:00Z',
    last_imported_blob_sha: 'blob-a',
    remote_committed_at: '2026-08-10T00:00:00Z',
    remote_blob_sha: 'blob-a',
    is_refreshing: false,
    last_refresh_failed: true,
    last_refreshed_at: null,
  },
  {
    repository_id: PLATFORM.id,
    repository_full_name: PLATFORM.full_name,
    clone_url: null,
    branch: 'master',
    path: 'schemas/core.json',
    last_imported_committed_at: '2026-08-10T00:00:00Z',
    last_imported_blob_sha: 'blob-a',
    remote_committed_at: '2026-08-10T00:00:00Z',
    remote_blob_sha: 'blob-a',
    is_refreshing: false,
    last_refresh_failed: false,
    last_refreshed_at: null,
  },
];

// ---------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------

/** One `fetch` reply. */
function reply(body: unknown, ok = true, statusText = 'OK') {
  return Promise.resolve({
    ok,
    status: ok ? 200 : 500,
    statusText,
    json: () => Promise.resolve(body),
  } as unknown as Response);
}

interface RouteOverrides {
  /** The repositories the list read returns, or `null` to fail it. */
  repositories?: unknown[] | null;
  /** The refresh-activity signals, or `null` to fail that read. */
  signals?: unknown[] | null;
  /** What `DELETE /api/repositories/{id}` answers. */
  remove?: { ok: boolean; error?: string };
}

/** Install a `fetch` that answers the screen's three routes. */
function mockRoutes({ repositories = ALL, signals = REFRESH_SIGNALS, remove }: RouteOverrides = {}) {
  const fetchMock = jest.fn((input: unknown, init?: { method?: string }) => {
    const url = String(input);
    if (init?.method === 'DELETE') {
      return remove?.ok === false
        ? reply({ error: remove.error ?? 'Refused' }, false, remove.error ?? 'Refused')
        : reply({ success: true });
    }
    if (url.includes('refresh-activity')) {
      return signals === null
        ? reply({ success: false, error: 'no refresh activity' }, false, 'Server error')
        : reply({ success: true, signals });
    }
    if (url.includes('/api/repositories')) {
      return repositories === null
        ? reply({ error: 'Repositories unavailable' }, false, 'Repositories unavailable')
        : reply({ repositories });
    }
    return reply({});
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

/**
 * Mount the screen and wait for the first read to settle.
 *
 * `TooltipProvider` is what `src/app/ade/dashboard/layout.tsx` wraps every dashboard screen in,
 * so mounting it here is reproducing the real tree rather than propping the test up.
 */
async function renderRepositories(overrides?: RouteOverrides) {
  const fetchMock = mockRoutes(overrides);
  const view = render(
    <TooltipProvider>
      <RepositoriesClient />
    </TooltipProvider>
  );
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  return { ...view, fetchMock };
}

/** Switch to the table view. */
async function showTable() {
  fireEvent.click(screen.getByTestId('repositories-view-list'));
  await screen.findByTestId('repositories-table');
}

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
});

afterEach(() => {
  delete (global as { fetch?: unknown }).fetch;
});

// ---------------------------------------------------------------------------------------

describe('the page chrome', () => {
  it('has one primary action and a sub-nav instead of five header buttons', async () => {
    await renderRepositories();
    await screen.findByText('payments-specs');

    const header = screen.getByRole('heading', { level: 1, name: 'Repositories' });
    expect(header).toBeInTheDocument();

    // The four navigations are a tab row now, and the header keeps Rescan all + Add repository.
    expect(screen.getByTestId('repositories-rescan-all')).toBeInTheDocument();
    expect(screen.getByTestId('repositories-add')).toHaveAttribute(
      'href',
      '/ade/dashboard/repositories/new'
    );
  });

  it('preserves the four sibling routes and marks the current one', async () => {
    await renderRepositories();
    await screen.findByText('payments-specs');

    const nav = screen.getByTestId('repositories-subnav');
    expect(within(nav).getByTestId('repositories-tab-list')).toHaveAttribute(
      'aria-current',
      'page'
    );
    expect(within(nav).getByTestId('repositories-tab-catalog')).toHaveAttribute(
      'href',
      '/ade/dashboard/repositories/catalog'
    );
    expect(within(nav).getByTestId('repositories-tab-telemetry')).toHaveAttribute(
      'href',
      '/ade/dashboard/repositories/telemetry'
    );
    expect(within(nav).getByTestId('repositories-tab-allowlist')).toHaveAttribute(
      'href',
      '/ade/dashboard/repositories/webhook-ip-allowlist'
    );
  });

  it('counts the loaded repositories on its own tab, and only once loaded', async () => {
    await renderRepositories();
    await screen.findByText('payments-specs');
    expect(screen.getByTestId('repositories-tab-list')).toHaveTextContent('Repositories4');
  });

  it('summarises the workspace under the title', async () => {
    await renderRepositories();
    await screen.findByText('payments-specs');
    expect(
      screen.getByText('4 repositories · 1,616 files indexed · 1 needs attention')
    ).toBeInTheDocument();
  });
});

describe('the KPI strip', () => {
  it('splits the count by provider and names the ones at zero on hover', async () => {
    await renderRepositories();
    await screen.findByText('payments-specs');

    const count = screen.getByTestId('repositories-kpi-count');
    expect(count).toHaveTextContent('4');
    expect(count).toHaveTextContent('2 GitHub · 1 GitLab · 1 Public URL');
    expect(count).toHaveAttribute('title', '2 GitHub · 1 GitLab · 0 Bitbucket · 1 Public URL');
  });

  it('keeps Imports (30d) an em dash with the reason on it', async () => {
    await renderRepositories();
    await screen.findByText('payments-specs');

    const imports = screen.getByTestId('repositories-kpi-imports');
    expect(imports).toHaveTextContent('—');
    expect(imports).toHaveAttribute(
      'title',
      'Needs import-event aggregation per tenant + repo (API not wired yet).'
    );
  });

  it('is absent above an empty workspace — a strip of zeros says it twice', async () => {
    await renderRepositories({ repositories: [] });
    await screen.findByText('No repositories yet');
    expect(screen.queryByTestId('repositories-kpis')).not.toBeInTheDocument();
  });
});

describe('the refresh activity panel', () => {
  it('tallies the states and drills in to the affected repositories', async () => {
    await renderRepositories();
    await screen.findByTestId('refresh-activity-card');

    expect(screen.getByTestId('refresh-activity-count-stale')).toHaveTextContent('Stale1');
    expect(screen.getByTestId('refresh-activity-count-failed')).toHaveTextContent('Failed1');
    expect(screen.getByTestId('refresh-activity-count-diverged')).toHaveTextContent('Diverged0');

    const links = screen.getAllByTestId('refresh-activity-repo-link');
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute(
      'href',
      `/ade/dashboard/repositories/${PAYMENTS.id}/preview?tab=specs`
    );
  });
});

describe('the cards view', () => {
  it('draws one card per repository, the whole card a single link', async () => {
    await renderRepositories();
    const cards = await screen.findAllByTestId('repository-card');
    expect(cards).toHaveLength(4);

    const payments = cards.find((card) => within(card).queryByText('payments-specs'));
    expect(payments).toBeDefined();
    // One link, not a button full of buttons: the name is the link and it stretches.
    const links = within(payments as HTMLElement).getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute(
      'href',
      `/ade/dashboard/repositories/${PAYMENTS.id}/preview`
    );
    expect(payments as HTMLElement).not.toHaveAttribute('role', 'button');
  });

  it('says "No description" rather than leaving a hole', async () => {
    await renderRepositories();
    await screen.findByText('platform-schemas');
    expect(screen.getByText('No description')).toBeInTheDocument();
  });

  it('offers the Add-repository tile as the last cell of the grid', async () => {
    await renderRepositories();
    await screen.findByText('payments-specs');
    expect(screen.getByTestId('repositories-add-tile')).toHaveAttribute(
      'href',
      '/ade/dashboard/repositories/new'
    );
  });

  it('carries the provider chip with both its glyph and its name', async () => {
    await renderRepositories();
    await screen.findByText('payments-specs');

    const providers = screen.getAllByTestId('repository-provider');
    const drawn = new Map(
      providers.map((chip) => [chip.getAttribute('data-provider'), chip.textContent])
    );
    expect(drawn.get('github')).toBe('GitHub');
    expect(drawn.get('gitlab')).toBe('GitLab');
    expect(drawn.get('public_url')).toBe('Public URL');
    // …and the glyph is a distinct mark inside each, not the chip's only content.
    for (const chip of providers) {
      expect(chip.querySelector('svg')).not.toBeNull();
    }
  });

  it('takes the health badge tone from the shared status vocabulary', async () => {
    await renderRepositories();
    await screen.findByText('payments-specs');

    const badges = screen.getAllByTestId('repository-health-badge');
    const warnings = badges.find((badge) => badge.dataset.healthLevel === 'warnings');
    const error = badges.find((badge) => badge.dataset.healthLevel === 'error');
    expect(statusTone('warnings')).toBe('warn');
    expect(statusTone('error')).toBe('danger');
    expect(warnings?.className).toContain('bg-warn-soft');
    expect(error?.className).toContain('bg-danger-soft');
  });

  it('marks a failed repository on its frame, not by fading its text', async () => {
    await renderRepositories();
    const cards = await screen.findAllByTestId('repository-card');
    const legacy = cards.find((card) => within(card).queryByText('legacy-soap'));
    expect(legacy).toHaveAttribute('data-status', 'error');
    expect(legacy?.className).not.toMatch(/opacity/);
    expect(within(legacy as HTMLElement).getByText('Scan failed')).toBeInTheDocument();
  });

  it('draws the scan strip for a repository with history and the meter for one without', async () => {
    await renderRepositories();
    const cards = await screen.findAllByTestId('repository-card');

    const payments = cards.find((card) => within(card).queryByText('payments-specs'));
    const strip = within(payments as HTMLElement).getByTestId('repository-scanbars');
    expect(strip.children).toHaveLength(5);
    expect(strip).toHaveAttribute('aria-label', expect.stringContaining('1 failed'));

    const platform = cards.find((card) => within(card).queryByText('platform-schemas'));
    expect(within(platform as HTMLElement).getByTestId('repository-index-meter')).toHaveAttribute(
      'aria-valuetext',
      expect.stringContaining('140 of 412')
    );
  });
});

describe('the table view', () => {
  it('draws the mockup nine columns, each header named', async () => {
    await renderRepositories();
    await screen.findByText('payments-specs');
    await showTable();

    const headers = screen
      .getAllByRole('columnheader')
      .map((header) => header.textContent?.trim());
    expect(headers).toEqual([
      'Repository',
      'Provider',
      'Branch',
      'Files',
      'Health',
      'Status',
      'Last scan',
      'Importable',
      'Actions',
    ]);
  });

  it('states the foot in the mockup words', async () => {
    await renderRepositories();
    await screen.findByText('payments-specs');
    await showTable();
    expect(screen.getByText('Showing 4 of 4 repositories')).toBeInTheDocument();
  });

  it('opens a repository when its row is activated', async () => {
    await renderRepositories();
    await screen.findByText('payments-specs');
    await showTable();

    fireEvent.click(screen.getByText('legacy-soap'));
    expect(mockPush).toHaveBeenCalledWith(`/ade/dashboard/repositories/${LEGACY.id}/preview`);
  });

  it('draws an em dash, not a green badge, when the API computed no health', async () => {
    await renderRepositories({
      repositories: [{ ...PLATFORM, health: undefined }],
    });
    await screen.findByText('platform-schemas');
    await showTable();
    expect(screen.queryByTestId('repository-health-badge')).not.toBeInTheDocument();
  });

  it('persists the chosen view', async () => {
    await renderRepositories();
    await screen.findByText('payments-specs');
    await showTable();
    expect(window.localStorage.getItem('apiome-dashboard-repositories-view')).toBe('list');
  });
});

describe('narrowing', () => {
  it('searches the name, the full name and the branch', async () => {
    const user = userEvent.setup();
    await renderRepositories();
    await screen.findByText('payments-specs');

    await user.type(screen.getByTestId('repositories-search'), 'trunk');
    await waitFor(() => expect(screen.getAllByTestId('repository-card')).toHaveLength(1));
    expect(screen.getByText('legacy-soap')).toBeInTheDocument();
  });

  it('offers the filtered-miss state with a way back, not the first-run invitation', async () => {
    const user = userEvent.setup();
    await renderRepositories();
    await screen.findByText('payments-specs');

    await user.type(screen.getByTestId('repositories-search'), 'nothing-matches-this');
    await screen.findByText('No matches');
    expect(screen.getByText('Try adjusting search or filters.')).toBeInTheDocument();
    expect(screen.queryByText('No repositories yet')).not.toBeInTheDocument();

    await user.click(screen.getByTestId('repositories-clear-filters'));
    await waitFor(() => expect(screen.getAllByTestId('repository-card')).toHaveLength(4));
  });

  it('explains how to connect the first repository when there is none', async () => {
    await renderRepositories({ repositories: [] });
    await screen.findByText('No repositories yet');
    expect(
      screen.getByText(
        'Register a Git repository through a linked account or a public clone URL. After the API is enabled, scans and file indexing appear here.'
      )
    ).toBeInTheDocument();
    expect(screen.getByTestId('repositories-empty-add')).toHaveAttribute(
      'href',
      '/ade/dashboard/repositories/new'
    );
  });
});

describe('the row menu', () => {
  it('offers the same three verbs from a card and from a row', async () => {
    const user = userEvent.setup();
    await renderRepositories();
    await screen.findByText('payments-specs');

    await user.click(screen.getAllByTestId('repository-row-menu')[0]);
    const fromCard = (await screen.findAllByRole('menuitem')).map((item) => item.textContent);
    await user.keyboard('{Escape}');

    await showTable();
    await user.click(screen.getAllByTestId('repository-row-menu')[0]);
    const fromRow = (await screen.findAllByRole('menuitem')).map((item) => item.textContent);

    expect(fromCard).toEqual(['Open detail', 'Rescan', 'Remove from list']);
    expect(fromRow).toEqual(fromCard);
  });

  it('asks before removing, then reloads the list', async () => {
    const user = userEvent.setup();
    const { fetchMock } = await renderRepositories();
    await screen.findByText('payments-specs');

    await user.click(screen.getAllByTestId('repository-row-menu')[0]);
    await user.click(await screen.findByTestId('repository-menu-remove'));

    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
    expect(mockConfirm.mock.calls[0][0]).toMatchObject({
      variant: 'danger',
      confirmLabel: 'Remove from list',
    });
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([, init]) => (init as { method?: string } | undefined)?.method === 'DELETE'
        )
      ).toBe(true)
    );
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith('Repository removed.'));
  });

  it('does not remove anything when the confirm is declined', async () => {
    const user = userEvent.setup();
    mockConfirm.mockResolvedValueOnce(false);
    const { fetchMock } = await renderRepositories();
    await screen.findByText('payments-specs');

    await user.click(screen.getAllByTestId('repository-row-menu')[0]);
    await user.click(await screen.findByTestId('repository-menu-remove'));

    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
    expect(
      fetchMock.mock.calls.some(
        ([, init]) => (init as { method?: string } | undefined)?.method === 'DELETE'
      )
    ).toBe(false);
  });

  it('reports a refused removal as a sentence rather than as a thrown object', async () => {
    const user = userEvent.setup();
    await renderRepositories({ remove: { ok: false, error: 'Repository is locked' } });
    await screen.findByText('payments-specs');

    await user.click(screen.getAllByTestId('repository-row-menu')[0]);
    await user.click(await screen.findByTestId('repository-menu-remove'));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('Repository is locked'));
  });

  it('keeps Rescan honest about being a stub, from the row and from the header', async () => {
    const user = userEvent.setup();
    await renderRepositories();
    await screen.findByText('payments-specs');

    await user.click(screen.getAllByTestId('repository-row-menu')[0]);
    await user.click(await screen.findByTestId('repository-menu-rescan'));
    expect(mockToastMessage).toHaveBeenCalledWith(
      'Rescan will run when scan jobs are wired to the API.'
    );

    await user.click(screen.getByTestId('repositories-rescan-all'));
    expect(mockToastMessage).toHaveBeenCalledWith(
      'Rescan all repositories will run when scan jobs are wired to the API.'
    );
  });
});

describe('reads that fail', () => {
  it('shows the failure with a retry rather than an empty workspace', async () => {
    await renderRepositories({ repositories: null });
    await screen.findByText('Could not load repositories.');
    expect(screen.queryByText('No repositories yet')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('surfaces the failure in the table view too', async () => {
    await renderRepositories({ repositories: null });
    await screen.findByText('Could not load repositories.');
    await showTable();
    expect(screen.getByRole('alert')).toHaveTextContent('Repositories unavailable');
  });
});

describe('the poll', () => {
  it('re-reads while a repository is still scanning, without raising the skeleton', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
    try {
      const fetchMock = mockRoutes();
      render(
        <TooltipProvider>
          <RepositoriesClient />
        </TooltipProvider>
      );
      await waitFor(() => expect(screen.queryAllByTestId('repository-card')).toHaveLength(4));

      const before = fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith('/api/repositories')
      ).length;
      jest.advanceTimersByTime(REPOSITORY_STATUS_POLL_MS + 50);
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/repositories')).length
        ).toBeGreaterThan(before)
      );
      // The rows stay on screen: a silent poll must not flash the skeleton every two seconds.
      expect(screen.getAllByTestId('repository-card')).toHaveLength(4);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not poll when nothing is pending or scanning', async () => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
    try {
      const fetchMock = mockRoutes({ repositories: [PAYMENTS, PLATFORM] });
      render(
        <TooltipProvider>
          <RepositoriesClient />
        </TooltipProvider>
      );
      await waitFor(() => expect(screen.queryAllByTestId('repository-card')).toHaveLength(2));

      const before = fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith('/api/repositories')
      ).length;
      jest.advanceTimersByTime(REPOSITORY_STATUS_POLL_MS * 3);
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/repositories')).length
      ).toBe(before);
    } finally {
      jest.useRealTimers();
    }
  });
});

/**
 * The browser fixtures.
 *
 * `e2e/hive-repositories.spec.ts` measures computed layout, which jsdom cannot do. Rather than
 * hand-writing HTML that would drift from the components, this renders the real screen and
 * writes what it rendered into `e2e/fixtures/hive-repositories/` when
 * `REPOSITORIES_FIXTURE_DUMP=1` is set:
 *
 *     REPOSITORIES_FIXTURE_DUMP=1 npx jest tests/repositories-hive-redesign.test.tsx -t fixtures
 *
 * Without the variable the test still runs — it renders every surface and checks each is there
 * — so a change that would leave the fixtures stale fails loudly here before it fails quietly
 * in the browser.
 */
describe('the browser fixtures', () => {
  const OUT = path.join(__dirname, '..', 'e2e', 'fixtures', 'hive-repositories');
  const dump = process.env.REPOSITORIES_FIXTURE_DUMP === '1';

  /** Write one fixture, or just assert it could be. */
  const write = (name: string, html: string) => {
    expect(html.length).toBeGreaterThan(0);
    if (!dump) return;
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, `${name}.html`), html);
  };

  /** The page column the shell would put this screen in. */
  const page = () => document.querySelector('.page') as HTMLElement;

  it('renders every surface the browser spec mounts (and writes the fixtures on request)', async () => {
    await renderRepositories();
    await screen.findByText('payments-specs');

    write('cards', page().outerHTML);

    await showTable();
    write('table', page().outerHTML);
  });

  it('renders the empty state (and writes its fixture on request)', async () => {
    await renderRepositories({ repositories: [], signals: [] });
    await screen.findByText('No repositories yet');
    write('empty', page().outerHTML);
  });
});
