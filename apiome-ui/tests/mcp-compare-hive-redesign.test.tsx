/**
 * The MCP server-comparison redesign, rendered (HIVE-7.9, #5326).
 *
 * `mcp-server-compare-ui.test.ts` holds the pure model — the sections, the `differs` flag, the
 * overlap sets and the protocol cross-check; `mcp-server-comparison-panel.test.tsx` holds the panel
 * in isolation; `mcp-compare-css.test.ts` pins the declarations. This holds the *screen* — what
 * `McpServerCompareClient` composes out of them against mocked reads of the four APIs it touches.
 *
 * What it pins is the ticket's second and fourth acceptance criteria and the mockup's
 * **Notes → Keeps (1:1)**, **Adds** and **States** lists:
 *
 *   2. **The comparison highlights only genuinely differing rows.** Asserted from both sides: a row
 *      whose columns disagree is marked, and a row where every column reports the same figure —
 *      including the same *zero*, and including the same *absence* — is not. The tint is emphasis,
 *      so the marker the suite reads is `data-differs`, which is also what the browser sweep reads.
 *   4. **Empty states.** A catalog with nothing comparable, a comparison that has not been run, a
 *      failed catalog read, a failed comparison, and a session with no workspace are five different
 *      states with five different exits. (The "pick two or three" prompt belongs to the panel and
 *      is driven directly in `mcp-server-comparison-panel.test.tsx`; from the screen it is
 *      unreachable, because the disabled Compare button cannot produce a one-column comparison.)
 *
 * Plus the mockup's Adds — the mirrored Compare (n) in the header and the sticky picker — and the
 * seven things the screen got wrong that this ticket fixes.
 */

import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { jest } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------------------

/** The current path, so the section tabs light the Compare tab. */
const pathname = '/ade/dashboard/mcp/compare';

/** The signed-in user, mutable so the no-workspace gate can be rendered too. */
const mockSessionUser: { current_tenant_id?: string } = { current_tenant_id: 't-acme' };

jest.mock('@lib/auth/session-client', () => ({
  useAuthSession: () => ({
    data: { user: mockSessionUser },
    status: 'authenticated',
    update: jest.fn(),
  }),
  AuthSessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => pathname,
}));

import McpServerCompareClient from '../src/app/ade/dashboard/mcp/compare/McpServerCompareClient';
import {
  MCP_COMPARE_AT_CAP_HINT,
  MCP_COMPARE_CATALOG_ERROR_TITLE,
  MCP_COMPARE_ERROR_TITLE,
  MCP_COMPARE_MAX_SELECTION,
  MCP_COMPARE_PICKER_EMPTY_TITLE,
  MCP_COMPARE_TABLE_FOOT,
  MCP_COMPARE_TITLE,
} from '../src/app/components/ade/dashboard/mcp/mcpServerCompareUi';

// ---------------------------------------------------------------------------------------
// Fixtures — the catalog `sources/mcp-compare.html` draws
// ---------------------------------------------------------------------------------------

/** One browse endpoint, with the payload's own defaults filled in. */
function endpoint(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'ep-pay',
    name: 'Payments tools',
    slug: 'payments',
    host: 'mcp.acme.dev',
    endpoint_url: 'https://mcp.acme.dev/payments',
    transport: 'streamable_http',
    description: null,
    category: 'finance',
    visibility: 'private',
    auth_scheme: 'bearer',
    published: false,
    enabled: true,
    quarantined: false,
    last_discovered_at: '2026-08-01T00:00:00Z',
    last_discovery_status: 'ok',
    current_version_id: 'v-pay',
    score: 94,
    grade: 'A',
    server_branding: null,
    tool_count: 12,
    resource_count: 4,
    resource_template_count: 2,
    prompt_count: 3,
    capability_count: 21,
    version_count: 3,
    protocol_version: '2025-06-18',
    health: 'healthy',
    has_destructive: true,
    read_only_only: false,
    complexity_band: 'moderate',
    freshness: 'fresh',
    ...overrides,
  };
}

const PAYMENTS = endpoint({});
const ORDERS = endpoint({
  id: 'ep-ord',
  name: 'Orders assistant',
  slug: 'orders',
  current_version_id: 'v-ord',
  score: 82,
  grade: 'B',
  transport: 'http+sse',
  tool_count: 8,
});
const GEO = endpoint({
  id: 'ep-geo',
  name: 'Globex geo tools',
  slug: 'globex-geo',
  host: 'tools.globex.io',
  category: 'geo',
  current_version_id: 'v-geo',
  score: 78,
  grade: 'B',
  tool_count: 15,
});
/** Never discovered, so it has no surface to align and must not reach the picker. */
const UNDISCOVERED = endpoint({
  id: 'ep-new',
  name: 'Aardvark draft',
  slug: 'aardvark',
  current_version_id: null,
});

const BROWSE = {
  success: true,
  groups: [
    { host: 'mcp.acme.dev', endpoints: [PAYMENTS, ORDERS, UNDISCOVERED] },
    { host: 'tools.globex.io', endpoints: [GEO] },
  ],
};

/** One capability item, with the snapshot payload's own defaults filled in. */
function item(item_type: string, name: string): Record<string, unknown> {
  return {
    item_type,
    name,
    title: null,
    description: 'Documented.',
    uri: null,
    uri_template: null,
    input_schema: null,
    output_schema: null,
    annotations: null,
    ordinal: 0,
  };
}

/** A version snapshot per endpoint, keyed by its version id. */
const VERSIONS: Record<string, unknown> = {
  'v-pay': {
    success: true,
    version: {
      id: 'v-pay',
      protocol_version: '2025-06-18',
      grade: 'A',
      score: 94,
      server_name: 'Acme Payments MCP',
      server_title: 'Acme Payments MCP',
      items: [item('tool', 'search'), item('tool', 'payments.refund'), item('prompt', 'summarize')],
    },
  },
  'v-ord': {
    success: true,
    version: {
      id: 'v-ord',
      protocol_version: '2025-03-26',
      grade: 'B',
      score: 82,
      server_name: 'Orders assistant',
      server_title: null,
      items: [item('tool', 'search'), item('tool', 'list_orders')],
    },
  },
  'v-geo': {
    success: true,
    version: {
      id: 'v-geo',
      protocol_version: '2025-06-18',
      grade: 'B',
      score: 78,
      server_name: 'Globex Geo',
      server_title: 'Globex Geo',
      items: [item('tool', 'search'), item('tool', 'geo.reverse')],
    },
  },
};

/** What the mocked `fetch` answers `/api/mcp/browse` with. */
let browse: { status?: number; body: unknown };

/** Set to make the version read of one endpoint reject, for the comparison error state. */
let failVersionRead = false;

/** Every URL the screen requested, in order. */
let requests: string[];

function stubFetch(): void {
  requests = [];
  global.fetch = jest.fn(async (input: unknown) => {
    const url = String(input);
    requests.push(url);

    if (url.startsWith('/api/mcp/browse')) {
      return {
        ok: (browse.status ?? 200) < 400,
        status: browse.status ?? 200,
        statusText: 'Bad Gateway',
        json: async () => browse.body,
      };
    }

    const version = /\/versions\/(v-[a-z]+)/.exec(url)?.[1];
    if (version) {
      if (failVersionRead) throw new Error('version read failed');
      return { ok: true, status: 200, statusText: 'OK', json: async () => VERSIONS[version] };
    }

    // Trust and reliability degrade independently: an endpoint with neither still compares.
    return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) };
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSessionUser.current_tenant_id = 't-acme';
  browse = { body: BROWSE };
  failVersionRead = false;
  stubFetch();
});

/** Render the screen and wait for the picker to fill. */
async function renderCompare(): Promise<void> {
  render(<McpServerCompareClient />);
  await screen.findByTestId('mcp-compare-picker');
}

/** The picker row for one endpoint, by its visible name. */
function pick(name: string): HTMLElement {
  return screen.getByRole('checkbox', { name: new RegExp(name) });
}

/** Tick `names` and run the comparison from the header's primary. */
async function compare(
  user: ReturnType<typeof userEvent.setup>,
  ...names: string[]
): Promise<void> {
  for (const name of names) await user.click(pick(name));
  await user.click(screen.getByTestId('mcp-compare-run-header'));
  await screen.findByTestId('mcp-compare-table');
}

// ---------------------------------------------------------------------------------------
// The page frame
// ---------------------------------------------------------------------------------------

describe('the page frame', () => {
  test('is Page + PageHeader + PageBody, with no <main> of its own', async () => {
    const { container } = render(<McpServerCompareClient />);
    await screen.findByTestId('mcp-compare-picker');

    expect(container.querySelector('main')).toBeNull();
    expect(container.querySelector('.page')).toBeInTheDocument();
    expect(screen.getByTestId('page-header')).toBeInTheDocument();
    expect(container.querySelector('.page-body')).toBeInTheDocument();
  });

  test('names the page once, as an h1, with the trail above it', async () => {
    await renderCompare();

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(MCP_COMPARE_TITLE);
    const crumbs = within(screen.getByTestId('page-breadcrumb'));
    expect(crumbs.getByRole('link', { name: 'MCP servers' })).toHaveAttribute(
      'href',
      '/ade/dashboard/mcp',
    );
    expect(crumbs.getByText('Compare')).toHaveAttribute('aria-current', 'page');
  });

  test('mirrors Compare (n) as the header primary, disabled until two are picked', async () => {
    const user = userEvent.setup();
    await renderCompare();

    const run = screen.getByTestId('mcp-compare-run-header');
    expect(run).toBeDisabled();
    expect(run).toHaveTextContent(/^Compare$/);

    await user.click(pick('Payments tools'));
    expect(run).toBeDisabled();

    await user.click(pick('Orders assistant'));
    expect(run).toBeEnabled();
    expect(run).toHaveTextContent('Compare (2)');
  });
});

// ---------------------------------------------------------------------------------------
// The picker
// ---------------------------------------------------------------------------------------

describe('the picker', () => {
  test('lists only endpoints with a current version, name-sorted', async () => {
    await renderCompare();

    const names = within(screen.getByTestId('mcp-compare-picker'))
      .getAllByRole('checkbox')
      .map((box) => box.closest('label')?.textContent ?? '');
    expect(names.map((line) => line.split('mcp.')[0].split('tools.')[0].split('(local)')[0])).toEqual(
      ['Globex geo tools', 'Orders assistant', 'Payments tools'],
    );
    // A never-discovered endpoint has no surface to align, so it is not offered at all.
    expect(screen.queryByText('Aardvark draft')).not.toBeInTheDocument();
  });

  test('prints each row’s host and tool count', async () => {
    await renderCompare();
    expect(screen.getByText('mcp.acme.dev · 12 tools')).toBeInTheDocument();
    expect(screen.getByText('tools.globex.io · 15 tools')).toBeInTheDocument();
  });

  test('counts the selection against the cap, and marks a chosen row', async () => {
    const user = userEvent.setup();
    await renderCompare();

    for (const name of ['Payments tools', 'Orders assistant', 'Globex geo tools']) {
      await user.click(pick(name));
    }
    expect(screen.getByTestId('mcp-compare-selection-count')).toHaveTextContent(
      `${MCP_COMPARE_MAX_SELECTION} of ${MCP_COMPARE_MAX_SELECTION} selected`,
    );

    // A chosen row says so twice: the checkbox's own state, and the hairline the attribute drives.
    const row = pick('Payments tools').closest('label') as HTMLElement;
    expect(row).toHaveAttribute('data-selected');
    expect(row).not.toHaveAttribute('data-at-cap');

    // Unticking one frees a slot again — the cap is a live rule, not a one-way latch.
    await user.click(pick('Globex geo tools'));
    expect(screen.getByTestId('mcp-compare-selection-count')).toHaveTextContent('2 of 3 selected');
  });

  test('locks the untickable rows once three are chosen, with the mockup’s reason', async () => {
    const user = userEvent.setup();
    browse = {
      body: {
        success: true,
        groups: [
          {
            host: 'mcp.acme.dev',
            endpoints: [
              PAYMENTS,
              ORDERS,
              GEO,
              endpoint({ id: 'ep-4', name: 'Zeta bridge', slug: 'zeta', current_version_id: 'v-z' }),
            ],
          },
        ],
      },
    };
    await renderCompare();

    for (const name of ['Payments tools', 'Orders assistant', 'Globex geo tools']) {
      await user.click(pick(name));
    }

    const locked = pick('Zeta bridge');
    expect(locked).toBeDisabled();
    const row = locked.closest('label') as HTMLElement;
    expect(row).toHaveAttribute('data-at-cap');
    expect(row).toHaveAttribute('title', MCP_COMPARE_AT_CAP_HINT);
  });

  test('Clear empties the selection', async () => {
    const user = userEvent.setup();
    await renderCompare();

    await user.click(pick('Payments tools'));
    await user.click(pick('Orders assistant'));
    await user.click(screen.getByTestId('mcp-compare-clear'));

    expect(screen.getByTestId('mcp-compare-selection-count')).toHaveTextContent('0 of 3 selected');
    expect(screen.getByTestId('mcp-compare-run-header')).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------------------
// Acceptance criterion 2 — only genuinely differing rows
// ---------------------------------------------------------------------------------------

describe('the comparison highlights only genuinely differing rows', () => {
  /** The metric row whose label is `label`, by its row header. */
  function metricRow(label: string): HTMLElement {
    const cell = within(screen.getByTestId('mcp-compare-table')).getByRole('rowheader', {
      name: label,
    });
    return cell.closest('tr') as HTMLElement;
  }

  test('marks a row whose columns disagree', async () => {
    const user = userEvent.setup();
    await renderCompare();
    await compare(user, 'Payments tools', 'Orders assistant');

    // 2 tools against 2 tools is equal; the prompts count is 1 against 0.
    expect(metricRow('Prompts')).toHaveAttribute('data-differs', 'true');
    expect(metricRow('Score')).toHaveAttribute('data-differs', 'true');
  });

  test('leaves a row alone when every column reports the same figure', async () => {
    const user = userEvent.setup();
    await renderCompare();
    await compare(user, 'Payments tools', 'Orders assistant');

    // Both snapshots expose two tools, so the row agrees and must not be marked.
    expect(metricRow('Tools')).not.toHaveAttribute('data-differs');
  });

  test('treats a shared zero as agreement, not as a difference', async () => {
    const user = userEvent.setup();
    await renderCompare();
    await compare(user, 'Payments tools', 'Orders assistant');

    // Neither snapshot has a resource, and `0 === 0` is a real answer.
    expect(metricRow('Resources')).not.toHaveAttribute('data-differs');
    expect(metricRow('Resources')).toHaveTextContent('0');
  });

  test('treats a shared absence as agreement, and prints it as an em dash', async () => {
    const user = userEvent.setup();
    await renderCompare();
    await compare(user, 'Payments tools', 'Orders assistant');

    // Both reliability reads 404 in this fixture, so neither column measured a p95.
    const row = metricRow('Slowest tool (p95)');
    expect(row).not.toHaveAttribute('data-differs');
    expect(row).toHaveTextContent('—');
  });

  test('states both conventions in words under the table', async () => {
    const user = userEvent.setup();
    await renderCompare();
    await compare(user, 'Payments tools', 'Orders assistant');

    // The tint is a 9% wash — emphasis, never the only signal.
    expect(screen.getByText(MCP_COMPARE_TABLE_FOOT)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------
// The comparison's own regions
// ---------------------------------------------------------------------------------------

describe('the comparison', () => {
  test('heads each column with the snapshot’s title, its endpoint name and its chips', async () => {
    const user = userEvent.setup();
    await renderCompare();
    await compare(user, 'Payments tools', 'Orders assistant');

    const header = within(screen.getByTestId('mcp-compare-table')).getAllByRole('columnheader')[1];
    // The snapshot's advertised title leads; the catalog name follows only when it differs.
    expect(header).toHaveTextContent('Acme Payments MCP');
    expect(header).toHaveTextContent('Payments tools');
    expect(header).toHaveTextContent('streamable_http');
    expect(header).toHaveTextContent('finance');
  });

  test('omits the endpoint subtitle when it repeats the display name', async () => {
    const user = userEvent.setup();
    await renderCompare();
    await compare(user, 'Payments tools', 'Orders assistant');

    const header = within(screen.getByTestId('mcp-compare-table')).getAllByRole('columnheader')[2];
    expect(header.querySelector('.mcpx-col__sub')).toBeNull();
  });

  test('warns when the servers negotiated different protocol revisions', async () => {
    const user = userEvent.setup();
    await renderCompare();
    await compare(user, 'Payments tools', 'Orders assistant');

    const banner = screen.getByTestId('mcp-compare-protocol');
    expect(banner).toHaveTextContent('Protocol versions differ.');
    expect(banner).toHaveTextContent('2025-03-26, 2025-06-18');
  });

  test('says nothing about the protocol when the servers agree', async () => {
    const user = userEvent.setup();
    await renderCompare();
    await compare(user, 'Payments tools', 'Globex geo tools');

    expect(screen.queryByTestId('mcp-compare-protocol')).not.toBeInTheDocument();
  });

  test('separates the shared tools from the ones unique to each server', async () => {
    const user = userEvent.setup();
    await renderCompare();
    await compare(user, 'Payments tools', 'Orders assistant');

    const overlap = within(screen.getByTestId('mcp-compare-overlap'));
    expect(overlap.getByText(/3 distinct tools across these servers/)).toBeInTheDocument();
    // `search` is on both; the presence marks are announced in words, not only drawn.
    expect(overlap.getByText('search')).toBeInTheDocument();
    expect(overlap.getAllByLabelText('present')).toHaveLength(2);
    expect(overlap.getByText('payments.refund')).toBeInTheDocument();
    expect(overlap.getByText('list_orders')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------
// Acceptance criterion 4 — the states
// ---------------------------------------------------------------------------------------

describe('the states', () => {
  test('a catalog with nothing comparable is an empty picker, not an empty page', async () => {
    browse = {
      body: { success: true, groups: [{ host: 'mcp.acme.dev', endpoints: [UNDISCOVERED] }] },
    };
    render(<McpServerCompareClient />);

    expect(await screen.findByText(MCP_COMPARE_PICKER_EMPTY_TITLE)).toBeInTheDocument();
    expect(screen.getByTestId('mcp-compare-run-header')).toBeDisabled();
  });

  test('before a comparison is run the results column draws nothing at all', async () => {
    await renderCompare();
    expect(screen.queryByTestId('mcp-compare-panel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mcp-compare-prompt')).not.toBeInTheDocument();
  });

  test('a failed catalog read is an error with a retry', async () => {
    const user = userEvent.setup();
    browse = { status: 502, body: { error: 'catalog unavailable' } };
    render(<McpServerCompareClient />);

    expect(await screen.findByText(MCP_COMPARE_CATALOG_ERROR_TITLE)).toBeInTheDocument();
    expect(screen.getByText('catalog unavailable')).toBeInTheDocument();

    browse = { body: BROWSE };
    await user.click(screen.getByRole('button', { name: /try again/i }));
    await screen.findByTestId('mcp-compare-picker');
  });

  test('a failed comparison is an error whose retry re-runs it', async () => {
    const user = userEvent.setup();
    await renderCompare();

    failVersionRead = true;
    await user.click(pick('Payments tools'));
    await user.click(pick('Orders assistant'));
    await user.click(screen.getByTestId('mcp-compare-run-header'));

    const state = await screen.findByTestId('mcp-compare-error');
    expect(state).toHaveTextContent(MCP_COMPARE_ERROR_TITLE);

    failVersionRead = false;
    await user.click(within(state).getByRole('button', { name: /try again/i }));
    await screen.findByTestId('mcp-compare-table');
  });

  test('a session with no workspace is gated before anything is read', async () => {
    mockSessionUser.current_tenant_id = undefined;
    render(<McpServerCompareClient />);

    expect(await screen.findByText(/pick a workspace first/i)).toBeInTheDocument();
    expect(screen.queryByTestId('mcp-compare-picker')).not.toBeInTheDocument();
    expect(requests).toHaveLength(0);
  });

  test('a missing trust profile degrades to “Not measured” rather than sinking the run', async () => {
    const user = userEvent.setup();
    await renderCompare();
    await compare(user, 'Payments tools', 'Orders assistant');

    // Trust and reliability both 404 in this fixture; the surface and quality rows still render.
    expect(screen.getAllByText('Not measured').length).toBeGreaterThan(0);
    expect(screen.getByTestId('mcp-compare-table')).toHaveTextContent('Total capabilities');
  });
});

// ---------------------------------------------------------------------------------------
// Browser fixtures
// ---------------------------------------------------------------------------------------

/**
 * The markup `e2e/hive-mcp-analytics.spec.ts` measures for this route.
 *
 * See the equivalent block in `mcp-analytics-hive-redesign.test.tsx` for why the fixtures are
 * rendered rather than hand-written, and how to refresh them:
 *
 *     MCP_FIXTURE_DUMP=1 npx jest -c jest.config.ts \
 *       tests/mcp-compare-hive-redesign.test.tsx -t fixtures
 */
describe('the browser fixtures', () => {
  const OUT = path.join(__dirname, '..', 'e2e', 'fixtures', 'hive-mcp-analytics');
  const dump = process.env.MCP_FIXTURE_DUMP === '1';

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
   * The page column, with checkbox state written into the attributes.
   *
   * A Radix checkbox is a `<button role="checkbox">` carrying `data-state`, which serialises;
   * the hidden `<input>` behind it carries only the property, so it is written out too.
   *
   * @returns The markup.
   */
  const pageColumn = () => {
    const page = document.querySelector('.page') as HTMLElement;
    page.querySelectorAll('input').forEach((input) => {
      if (input.type === 'checkbox' && input.checked) input.setAttribute('checked', '');
    });
    return page.outerHTML;
  };

  test('renders a three-server comparison (and writes its fixture on request)', async () => {
    const user = userEvent.setup();
    await renderCompare();
    await compare(user, 'Payments tools', 'Orders assistant', 'Globex geo tools');
    write('compare', pageColumn());
  });
});
