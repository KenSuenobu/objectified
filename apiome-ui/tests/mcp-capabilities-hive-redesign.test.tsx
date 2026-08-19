/**
 * The MCP capability-directory redesign, rendered (HIVE-7.9, #5326).
 *
 * `mcp-capability-directory-ui.test.ts` holds the parser, the query builder, the presets and the
 * two summary lines; `mcp-capabilities-css.test.ts` pins the declarations. This holds the *screen*
 * — what `McpCapabilityDirectoryClient` composes out of them against a mocked
 * `/api/mcp/capabilities`.
 *
 * What it pins is the ticket's third and fourth acceptance criteria and the mockup's
 * **Notes → Keeps (1:1)**, **Adds** and **States** lists:
 *
 *   3. **The capability table sorts and pages server-side, as today.** Every control — the five
 *      filters, the three sortable headers, the sort select, the pager and the four preset tiles —
 *      is asserted by the *request it makes*, not by the rows it leaves on screen. That is the
 *      criterion: a screen that filtered the fifty rows in hand would look identical here and be
 *      wrong on page two.
 *   4. **Empty states.** No rows matched, the read failed, and the session has no workspace are
 *      three different states with three different exits.
 *
 * Plus the mockup's Adds — the preset row with its real counts, the grade glyph beside each server
 * and the Add-MCP-server shortcut — and the seven things the screen got wrong that this fixes.
 *
 * The table is `ui/DataTable` now, so the queries here follow its contract rather than the old
 * hand-built one: a row is `tr[data-row-id]`, and a sort header is the `<button>` inside a
 * `columnheader` carrying `aria-sort`.
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

/** The current path, so the section tabs light the Capabilities tab. */
const pathname = '/ade/dashboard/mcp/capabilities';

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

import McpCapabilityDirectoryClient from '../src/app/ade/dashboard/mcp/capabilities/McpCapabilityDirectoryClient';
import {
  MCP_CAPABILITY_DIRECTORY_EMPTY_TITLE,
  MCP_CAPABILITY_DIRECTORY_ERROR_TITLE,
  MCP_CAPABILITY_DIRECTORY_PAGE_SIZE,
  MCP_CAPABILITY_DIRECTORY_PRESETS,
  MCP_CAPABILITY_DIRECTORY_TITLE,
} from '../src/app/components/ade/dashboard/mcp/mcpCapabilityDirectoryUi';

// ---------------------------------------------------------------------------------------
// Fixtures — the directory `sources/mcp-capabilities.html` draws
// ---------------------------------------------------------------------------------------

/** One directory row, with the payload's own defaults filled in. */
function entry(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: 'tool',
    item_id: 'it-1',
    item_name: 'geo.search',
    item_title: 'Search geo features',
    description: 'Find places, addresses and POIs near a point.',
    endpoint_id: 'ep-geo',
    endpoint_name: 'Globex geo tools',
    endpoint_slug: 'globex-geo',
    host: 'tools.globex.io',
    endpoint_url: 'https://tools.globex.io/mcp',
    category: 'geo',
    visibility: 'private',
    current_version_id: 'v-1',
    score: 82,
    grade: 'B',
    ...overrides,
  };
}

const ROWS = [
  entry({}),
  entry({
    item_id: 'it-2',
    item_name: 'geo.reverse',
    item_title: 'Reverse geocode',
    description: 'Coordinates → structured address.',
  }),
  entry({
    kind: 'prompt',
    item_id: 'it-3',
    item_name: 'summarize',
    item_title: 'Search summary',
    description: 'Summarize a search result set for a customer.',
    endpoint_id: 'ep-pay',
    endpoint_name: 'Payments tools',
    endpoint_slug: 'payments',
    host: 'mcp.acme.dev',
    category: 'finance',
    score: 94,
    grade: 'A',
  }),
];

/** How the mocked `fetch` answers, keyed by the query it is asked with. */
let directory: { status?: number; body: unknown };

/** The `total` each preset's `limit=1` count read reports, by `type`/`visibility`. */
const PRESET_TOTALS: Record<string, number> = {
  'type=tool': 44,
  'type=resource': 12,
  'type=prompt': 5,
  'visibility=public': 9,
};

/** Every URL the screen requested, in order. */
let requests: string[];

/** Only the reads that fetch a *page* — the counting reads use `limit=1`. */
function pageRequests(): URLSearchParams[] {
  return requests
    .filter((url) => url.includes(`limit=${MCP_CAPABILITY_DIRECTORY_PAGE_SIZE}`))
    .map((url) => new URLSearchParams(url.split('?')[1] ?? ''));
}

/** The query behind the most recent page read. */
function lastQuery(): URLSearchParams {
  const queries = pageRequests();
  return queries[queries.length - 1];
}

function stubFetch(): void {
  requests = [];
  global.fetch = jest.fn(async (input: unknown) => {
    const url = String(input);
    requests.push(url);
    const params = new URLSearchParams(url.split('?')[1] ?? '');

    // A preset's count read: `limit=1`, and only `total` is looked at.
    if (params.get('limit') === '1') {
      const key = params.get('type')
        ? `type=${params.get('type')}`
        : `visibility=${params.get('visibility')}`;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ success: true, items: [], total: PRESET_TOTALS[key] ?? 0 }),
      };
    }

    return {
      ok: (directory.status ?? 200) < 400,
      status: directory.status ?? 200,
      statusText: 'Bad Gateway',
      json: async () => directory.body,
    };
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSessionUser.current_tenant_id = 't-acme';
  directory = { body: { success: true, items: ROWS, total: 3, limit: 50, offset: 0 } };
  stubFetch();
});

/** Render the screen and wait for the first page to land. */
async function renderDirectory(): Promise<void> {
  render(<McpCapabilityDirectoryClient />);
  await screen.findByText('Search geo features');
}

/** The sort button inside one column header. */
function sortHeader(name: RegExp): HTMLElement {
  return within(screen.getByRole('columnheader', { name })).getByRole('button');
}

// ---------------------------------------------------------------------------------------
// The page frame
// ---------------------------------------------------------------------------------------

describe('the page frame', () => {
  test('is Page + PageHeader + PageBody, with no <main> of its own', async () => {
    const { container } = render(<McpCapabilityDirectoryClient />);
    await screen.findByText('Search geo features');

    expect(container.querySelector('main')).toBeNull();
    expect(container.querySelector('.page')).toBeInTheDocument();
    expect(screen.getByTestId('page-header')).toBeInTheDocument();
    expect(container.querySelector('.page-body')).toBeInTheDocument();
  });

  test('names the page once, as an h1, with the trail above it', async () => {
    await renderDirectory();

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      MCP_CAPABILITY_DIRECTORY_TITLE,
    );
    const crumbs = within(screen.getByTestId('page-breadcrumb'));
    expect(crumbs.getByRole('link', { name: 'MCP servers' })).toHaveAttribute(
      'href',
      '/ade/dashboard/mcp',
    );
    expect(crumbs.getByText('Capabilities')).toHaveAttribute('aria-current', 'page');
  });

  test('offers the mockup’s Add-MCP-server shortcut as the one primary action', async () => {
    await renderDirectory();
    const actions = within(screen.getByTestId('page-header-actions'));
    expect(actions.getByTestId('mcp-capabilities-add')).toHaveAttribute(
      'href',
      '/ade/dashboard/mcp',
    );
  });
});

// ---------------------------------------------------------------------------------------
// Acceptance criterion 3 — server-side sorting and paging
// ---------------------------------------------------------------------------------------

describe('the table sorts and pages server-side', () => {
  test('opens on server ascending, page one, fifty rows', async () => {
    await renderDirectory();
    const query = lastQuery();
    expect(query.get('sort')).toBe('server');
    expect(query.get('direction')).toBe('asc');
    expect(query.get('offset')).toBe('0');
    expect(query.get('limit')).toBe(String(MCP_CAPABILITY_DIRECTORY_PAGE_SIZE));
  });

  test('a sort header re-reads the page rather than reordering the rows in hand', async () => {
    const user = userEvent.setup();
    await renderDirectory();

    const before = pageRequests().length;
    await user.click(sortHeader(/^Capability/));

    await waitFor(() => expect(pageRequests().length).toBeGreaterThan(before));
    expect(lastQuery().get('sort')).toBe('name');
    expect(lastQuery().get('direction')).toBe('asc');
  });

  test('a second click on the same header asks for the other direction', async () => {
    const user = userEvent.setup();
    await renderDirectory();

    await user.click(sortHeader(/^Capability/));
    await waitFor(() => expect(lastQuery().get('sort')).toBe('name'));
    await user.click(sortHeader(/^Capability/));

    await waitFor(() => expect(lastQuery().get('direction')).toBe('desc'));
  });

  test('the third click returns to the default order rather than to no order', async () => {
    // `ui/DataTable` cycles asc → desc → unsorted. This endpoint has no unsorted order — it always
    // orders by one of server/name/type — so the third click resolves to `server ascending`.
    const user = userEvent.setup();
    await renderDirectory();

    await user.click(sortHeader(/^Capability/));
    await waitFor(() => expect(lastQuery().get('sort')).toBe('name'));
    await user.click(sortHeader(/^Capability/));
    await waitFor(() => expect(lastQuery().get('direction')).toBe('desc'));
    await user.click(sortHeader(/^Capability/));

    await waitFor(() => expect(lastQuery().get('sort')).toBe('server'));
    expect(lastQuery().get('direction')).toBe('asc');
  });

  test('the sorted column is announced, and an unsorted one reads `none`', async () => {
    await renderDirectory();
    expect(screen.getByRole('columnheader', { name: /^Server/ })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );
    expect(screen.getByRole('columnheader', { name: /^Capability/ })).toHaveAttribute(
      'aria-sort',
      'none',
    );
  });

  test('the pager moves the offset by a whole page', async () => {
    const user = userEvent.setup();
    directory = { body: { success: true, items: ROWS, total: 120, limit: 50, offset: 0 } };
    await renderDirectory();

    await user.click(screen.getByRole('button', { name: 'Page 2' }));

    await waitFor(() => expect(lastQuery().get('offset')).toBe('50'));
  });

  test('each of the five filters travels as a query parameter', async () => {
    const user = userEvent.setup();
    await renderDirectory();

    // Name: typed into a draft, applied on Enter or Apply — never on every keystroke.
    await user.type(screen.getByLabelText('Name'), 'search');
    expect(lastQuery().get('name')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(lastQuery().get('name')).toBe('search'));

    // Host: applies as it is typed.
    await user.type(screen.getByLabelText('Host'), 'mcp.acme.dev');
    await waitFor(() => expect(lastQuery().get('host')).toBe('mcp.acme.dev'));
  });

  test('the name filter also applies on Enter', async () => {
    const user = userEvent.setup();
    await renderDirectory();

    await user.type(screen.getByLabelText('Name'), 'geo{Enter}');

    await waitFor(() => expect(lastQuery().get('name')).toBe('geo'));
  });

  test('any filter change returns the reader to page one', async () => {
    const user = userEvent.setup();
    directory = { body: { success: true, items: ROWS, total: 120, limit: 50, offset: 0 } };
    await renderDirectory();

    await user.click(screen.getByRole('button', { name: 'Page 2' }));
    await waitFor(() => expect(lastQuery().get('offset')).toBe('50'));

    await user.type(screen.getByLabelText('Host'), 'acme');
    await waitFor(() => expect(lastQuery().get('offset')).toBe('0'));
  });

  test('the foot states the query — what matched, the page size and the order', async () => {
    await renderDirectory();
    expect(screen.getByTestId('mcp-capabilities-foot')).toHaveTextContent(
      '3 capabilities · page size 50 · sorted by server ascending',
    );
    expect(screen.getByTestId('mcp-capabilities-range')).toHaveTextContent('1–3 of 3');
  });
});

// ---------------------------------------------------------------------------------------
// The mockup's Adds — presets and the grade glyph
// ---------------------------------------------------------------------------------------

describe('the preset tiles', () => {
  test('draws one tile per preset, each with a count read from the server', async () => {
    await renderDirectory();

    const presets = within(screen.getByTestId('mcp-capability-presets'));
    for (const preset of MCP_CAPABILITY_DIRECTORY_PRESETS) {
      const tile = presets.getByTestId(`mcp-capability-preset-${preset.id}`);
      expect(tile).toHaveTextContent(preset.label);
      expect(tile).toHaveAttribute('aria-pressed', 'false');
    }
    await waitFor(() =>
      expect(presets.getByTestId('mcp-capability-preset-tools')).toHaveTextContent('44'),
    );
    expect(presets.getByTestId('mcp-capability-preset-public')).toHaveTextContent('9');
  });

  test('a tile applies its filter server-side and reads as pressed', async () => {
    const user = userEvent.setup();
    await renderDirectory();

    await user.click(screen.getByTestId('mcp-capability-preset-prompts'));

    await waitFor(() => expect(lastQuery().get('type')).toBe('prompt'));
    expect(screen.getByTestId('mcp-capability-preset-prompts')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('clicking the active tile again clears back to the unfiltered directory', async () => {
    const user = userEvent.setup();
    await renderDirectory();

    await user.click(screen.getByTestId('mcp-capability-preset-prompts'));
    await waitFor(() => expect(lastQuery().get('type')).toBe('prompt'));
    await user.click(screen.getByTestId('mcp-capability-preset-prompts'));

    await waitFor(() => expect(lastQuery().get('type')).toBeNull());
    expect(screen.getByTestId('mcp-capability-preset-prompts')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  test('a preset replaces the whole filter set, so its caption stays true', async () => {
    const user = userEvent.setup();
    await renderDirectory();

    await user.type(screen.getByLabelText('Host'), 'mcp.acme.dev');
    await waitFor(() => expect(lastQuery().get('host')).toBe('mcp.acme.dev'));

    await user.click(screen.getByTestId('mcp-capability-preset-tools'));

    await waitFor(() => expect(lastQuery().get('type')).toBe('tool'));
    // "Operations an assistant can call" describes the catalog, not one host's slice of it.
    expect(lastQuery().get('host')).toBeNull();
  });

  test('drops a count it could not read rather than printing a zero', async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn(async (input: unknown) => {
      const url = String(input);
      requests.push(url);
      const params = new URLSearchParams(url.split('?')[1] ?? '');
      if (params.get('limit') === '1') {
        return { ok: false, status: 502, statusText: 'Bad Gateway', json: async () => ({}) };
      }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => directory.body,
      };
    }) as unknown as typeof fetch;

    try {
      await renderDirectory();
      const tile = screen.getByTestId('mcp-capability-preset-tools');
      // "none" and "not counted" are different facts; the tile says neither rather than lying.
      expect(tile).not.toHaveTextContent('· 0');
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('the rows', () => {
  test('leads each server with its grade glyph and links to the endpoint', async () => {
    await renderDirectory();

    const link = screen.getAllByRole('link', { name: /Globex geo tools/ })[0];
    expect(link).toHaveAttribute('href', '/ade/dashboard/mcp/ep-geo');
    // The glyph is the shared one, so the letter is announced rather than only drawn.
    expect(link).toHaveTextContent('B');
  });

  test('prints a capability as title, description and mono identifier', async () => {
    await renderDirectory();

    const row = document.querySelector('tr[data-row-id="ep-geo:it-1"]') as HTMLElement;
    expect(row).toBeInTheDocument();
    const cells = within(row);
    expect(cells.getByText('Search geo features')).toBeInTheDocument();
    expect(cells.getByText('Find places, addresses and POIs near a point.')).toBeInTheDocument();
    expect(cells.getByText('geo.search')).toHaveClass('mono');
    expect(cells.getByText('tools.globex.io')).toBeInTheDocument();
  });

  test('badges a tool as the filled variant and everything else as secondary', async () => {
    await renderDirectory();

    const tool = within(document.querySelector('tr[data-row-id="ep-geo:it-1"]') as HTMLElement);
    const prompt = within(document.querySelector('tr[data-row-id="ep-pay:it-3"]') as HTMLElement);
    expect(tool.getByText('Tool')).toBeInTheDocument();
    expect(prompt.getByText('Prompt')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------
// Acceptance criterion 4 — the states
// ---------------------------------------------------------------------------------------

describe('the three states', () => {
  test('no rows is an empty state that names a filter as the likely cause', async () => {
    directory = { body: { success: true, items: [], total: 0, limit: 50, offset: 0 } };
    render(<McpCapabilityDirectoryClient />);

    expect(await screen.findByText(MCP_CAPABILITY_DIRECTORY_EMPTY_TITLE)).toBeInTheDocument();
    // The toolbar and the foot stay where they were, so the filter that caused it is still there.
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
    expect(screen.getByTestId('mcp-capabilities-range')).toHaveTextContent('No capabilities');
  });

  test('a failed read is an error whose retry re-runs the same request', async () => {
    const user = userEvent.setup();
    directory = { status: 502, body: { error: 'GET /api/mcp/capabilities → 502' } };
    render(<McpCapabilityDirectoryClient />);

    expect(await screen.findByText(MCP_CAPABILITY_DIRECTORY_ERROR_TITLE)).toBeInTheDocument();
    expect(screen.getByText('GET /api/mcp/capabilities → 502')).toBeInTheDocument();

    const before = pageRequests().length;
    directory = { body: { success: true, items: ROWS, total: 3, limit: 50, offset: 0 } };
    await user.click(screen.getByRole('button', { name: /try again/i }));

    await screen.findByText('Search geo features');
    expect(pageRequests().length).toBeGreaterThan(before);
  });

  test('a session with no workspace is gated before anything is read', async () => {
    mockSessionUser.current_tenant_id = undefined;
    render(<McpCapabilityDirectoryClient />);

    expect(await screen.findByText(/pick a workspace first/i)).toBeInTheDocument();
    expect(screen.queryByTestId('mcp-capability-presets')).not.toBeInTheDocument();
    expect(requests).toHaveLength(0);
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
 *       tests/mcp-capabilities-hive-redesign.test.tsx -t fixtures
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
   * The page column, with control state written into the attributes.
   *
   * `outerHTML` writes *attributes*, and a value typed into a field has only the `value`
   * **property** — so a fixture of a filled filter bar would arrive in the browser empty.
   *
   * @returns The markup.
   */
  const pageColumn = () => {
    const page = document.querySelector('.page') as HTMLElement;
    page.querySelectorAll('input').forEach((input) => {
      if (input.value) input.setAttribute('value', input.value);
    });
    return page.outerHTML;
  };

  test('renders the populated directory (and writes its fixture on request)', async () => {
    const user = userEvent.setup();
    await renderDirectory();
    // One preset lit, so the fixture carries the chosen-tile hairline the CSS suite measures.
    await user.click(screen.getByTestId('mcp-capability-preset-tools'));
    await waitFor(() => expect(lastQuery().get('type')).toBe('tool'));
    write('capabilities', pageColumn());
  });
});
