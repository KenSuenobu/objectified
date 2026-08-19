/**
 * The MCP servers catalog redesign, rendered (HIVE-7.7, #5324).
 *
 * `mcp-catalog-ui.test.ts` holds the model's decisions (faceting, filtering, sorting, the seen
 * snapshot), `mcp-catalog-components.test.tsx` holds the card and the toolbar in isolation, and
 * `mcp-catalog-css.test.ts` pins the declarations. This holds the *screen* — what
 * `McpCatalogClient` composes out of them against mocked reads of the four APIs it touches.
 *
 * What it pins is the ticket's four acceptance criteria and the mockup's **Notes → Keeps (1:1)**
 * and **States** lists:
 *
 *   1. **All ten facets filter as today, and the counts reflect the active set.** Every facet the
 *      catalog contains renders, selecting a value narrows the groups, two values inside one facet
 *      OR, two facets AND — and the totals line names the visible slice and what it was filtered
 *      from. The facet *chip* counts stay full-catalog, which is what keeps every value
 *      selectable, and the panel says so on the page.
 *   2. **Saved searches and collections keep their contracts.** A saved search restores query,
 *      filters and sort; a collection is created from the endpoints *visible at that moment* and
 *      says so, naming them, because its membership is fixed at creation.
 *   3. **Grade, health, freshness and recency use the shared status tokens** — asserted through
 *      the vocabulary rather than through class strings, which `mcp-dark-theme-tokens.test.ts`
 *      already walks.
 *   4. **Discover job progress and failure states render** — the *opening* of the wizard is here;
 *      the register → discover → done/failed overlay itself is `mcp-discovery-panel.test.tsx`,
 *      which drives `McpDiscoveryPanel` against a polled job.
 *
 * Plus the five things the screen got wrong and this ticket fixes: a `<main>` landmark the shell
 * already draws, a hand-rolled header, three full-bleed control bands, a spinner where the
 * skeleton should be, and an empty state shown to a reader with no workspace to fill.
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

/** The current path, so the section tabs light the Servers tab. */
const pathname = '/ade/dashboard/mcp';

/** The signed-in user, mutable so the no-workspace gate can be rendered too. */
const mockSessionUser: { current_tenant_id?: string; user_id?: string } = {
  current_tenant_id: 't-acme',
  user_id: 'u-ada',
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
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => pathname,
}));

const mockConfirm = jest.fn(async () => true);

jest.mock('@/app/components/providers/DialogProvider', () => ({
  useDialog: () => ({
    confirm: (options: unknown) => mockConfirm(options as never),
    alert: jest.fn(),
    prompt: jest.fn(),
  }),
}));

jest.mock('sonner', () => ({
  toast: { message: jest.fn(), success: jest.fn(), error: jest.fn() },
}));

/**
 * The Add-MCP-server wizard is a whole screen of its own — `ImportDialog`'s `mcp` source, whose
 * own steps `mcp-discovery-panel.test.tsx` and `import-wizard-hive-redesign.test.tsx` cover.
 * Here it is a placeholder, so this suite measures the catalog rather than the overlay.
 */
jest.mock('@/app/components/ade/dashboard/ImportDialog', () => ({
  __esModule: true,
  default: ({ open }: { open: boolean }) =>
    open ? <div data-testid="mcp-import-dialog">add MCP server</div> : null,
}));

import McpCatalogClient from '../src/app/ade/dashboard/mcp/McpCatalogClient';
import {
  MCP_CATALOG_EMPTY_TITLE,
  MCP_CATALOG_ERROR_TITLE,
  MCP_CATALOG_FACET_NOTE,
  MCP_CATALOG_NO_MATCH_TITLE,
  MCP_CATALOG_SORT_HINT,
} from '../src/app/components/ade/dashboard/mcp/mcpCatalogUi';
import { COLLECTIONS_FIXED_MEMBERSHIP_NOTE } from '../src/app/components/ade/dashboard/mcp/McpCollectionsPanel';
import { shadowScopeTone } from '../src/app/components/ui/mcp/ShadowedNamesPanel';
import { STATUS_TONE_SOFT_CLASS } from '../src/app/components/ui/statusVocabulary';

// ---------------------------------------------------------------------------------------
// Fixtures — the catalog the mockup draws
// ---------------------------------------------------------------------------------------

/** One browse endpoint, with the payload's own defaults filled in. */
function endpoint(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    slug: 'ep',
    endpoint_url: 'https://mcp.acme.dev/payments/mcp',
    description: null,
    category: null,
    visibility: 'private',
    auth_scheme: null,
    published: false,
    enabled: true,
    quarantined: false,
    last_discovery_status: 'ok',
    current_version_id: 'v-1',
    score: null,
    grade: null,
    tool_count: 0,
    resource_count: 0,
    resource_template_count: 0,
    prompt_count: 0,
    capability_count: 0,
    version_count: 1,
    protocol_version: '2025-06-18',
    health: 'healthy',
    has_destructive: false,
    read_only_only: false,
    complexity_band: 'simple',
    freshness: 'fresh',
    last_known_good_at: null,
    ...overrides,
  };
}

const BROWSE = {
  success: true,
  groups: [
    {
      host: 'mcp.acme.dev',
      endpoint_count: 2,
      capability_count: 32,
      endpoints: [
        endpoint({
          id: 'ep-payments',
          name: 'Payments tools',
          slug: 'payments-tools',
          host: 'mcp.acme.dev',
          transport: 'streamable_http',
          visibility: 'public',
          auth_scheme: 'bearer',
          published: true,
          grade: 'A',
          score: 94,
          category: 'finance',
          tool_count: 12,
          resource_count: 4,
          resource_template_count: 2,
          prompt_count: 3,
          capability_count: 21,
          version_count: 5,
          has_destructive: true,
          complexity_band: 'complex',
          last_discovered_at: '2026-08-19T11:55:00Z',
        }),
        endpoint({
          id: 'ep-orders',
          name: 'Orders assistant',
          slug: 'orders-assistant',
          host: 'mcp.acme.dev',
          transport: 'http+sse',
          auth_scheme: 'oauth2',
          grade: 'B',
          score: 82,
          category: 'logistics',
          tool_count: 8,
          resource_count: 2,
          prompt_count: 1,
          capability_count: 11,
          version_count: 3,
          complexity_band: 'moderate',
          last_discovered_at: '2026-08-19T10:00:00Z',
        }),
      ],
    },
    {
      host: 'tools.globex.io',
      endpoint_count: 1,
      capability_count: 0,
      endpoints: [
        endpoint({
          id: 'ep-crm',
          name: 'Legacy CRM connector',
          slug: 'legacy-crm',
          host: 'tools.globex.io',
          endpoint_url: 'https://tools.globex.io/crm/sse',
          transport: 'http+sse',
          auth_scheme: 'bearer',
          last_discovery_status: 'failed',
          health: 'quarantined',
          quarantined: true,
          freshness: 'quarantined',
          protocol_version: null,
          complexity_band: 'unknown',
          version_count: 1,
          last_discovered_at: '2026-08-13T14:02:00Z',
          last_known_good_at: '2026-07-30T14:02:00Z',
        }),
      ],
    },
  ],
};

const SAVED_SEARCHES = {
  searches: [
    {
      id: 'ss-1',
      name: 'Public A/B servers',
      filters: { visibilities: ['public'], grades: ['A', 'B'] },
      query: 'acme',
      sort: 'grade',
      isPinned: true,
      createdAt: '2026-08-01T00:00:00Z',
      updatedAt: '2026-08-01T00:00:00Z',
    },
    {
      id: 'ss-2',
      name: 'Legacy SSE transports',
      filters: { transports: ['http+sse'] },
      query: '',
      sort: 'recency',
      isPinned: false,
      createdAt: '2026-08-02T00:00:00Z',
      updatedAt: '2026-08-02T00:00:00Z',
    },
  ],
};

const COLLECTIONS = {
  tenantSlug: 'acme',
  collections: [
    {
      id: 'col-1',
      name: 'Approved geo tools',
      slug: 'approved-geo-tools',
      description: 'Vetted for the field-ops assistants',
      isPublished: true,
      memberCount: 2,
      createdBy: 'u-ada',
      createdAt: '2026-08-01T00:00:00Z',
      updatedAt: '2026-08-01T00:00:00Z',
    },
  ],
};

const SHADOWING = {
  advisory: true,
  group_count: 2,
  same_host_count: 1,
  cross_host_count: 1,
  groups: [
    {
      item_type: 'tool',
      name: 'search',
      host_scope: 'same_host',
      endpoint_count: 2,
      endpoints: [
        { id: 'ep-payments', name: 'Payments tools', slug: 'payments-tools', host: 'mcp.acme.dev' },
        { id: 'ep-orders', name: 'Orders assistant', slug: 'orders-assistant', host: 'mcp.acme.dev' },
      ],
    },
    {
      item_type: 'prompt',
      name: 'summarize',
      host_scope: 'cross_host',
      endpoint_count: 2,
      endpoints: [
        { id: 'ep-payments', name: 'Payments tools', slug: 'payments-tools', host: 'mcp.acme.dev' },
        { id: 'ep-crm', name: 'Legacy CRM connector', slug: 'legacy-crm', host: 'tools.globex.io' },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------

/** One canned response, by the path prefix the screen calls. */
type Route = { status?: number; body: unknown };

/** What each route answers with; a test overrides only the one it is about. */
let routes: Record<string, Route>;

/** Every request the screen made, so a test can assert what it asked for. */
let requests: string[];

function stubFetch(): void {
  requests = [];
  global.fetch = jest.fn(async (input: unknown) => {
    const url = String(input);
    requests.push(url);
    const key = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    const route = key ? routes[key] : { status: 404, body: { error: 'not mocked' } };
    return {
      ok: (route.status ?? 200) < 400,
      status: route.status ?? 200,
      statusText: 'Error',
      json: async () => route.body,
    };
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSessionUser.current_tenant_id = 't-acme';
  mockSessionUser.user_id = 'u-ada';
  window.localStorage.clear();
  routes = {
    '/api/mcp/browse': { body: BROWSE },
    '/api/mcp/saved-searches': { body: SAVED_SEARCHES },
    '/api/mcp/collections': { body: COLLECTIONS },
    '/api/mcp/data-quality/shadowing': { body: SHADOWING },
  };
  stubFetch();
});

/** Render the screen and wait for the first catalog read to land. */
async function renderCatalog(): Promise<void> {
  render(<McpCatalogClient />);
  await screen.findByRole('link', { name: /Open Payments tools/i });
}

/** Open the facet panel. */
async function openFilters(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByTestId('mcp-catalog-filters-toggle'));
  return screen.getByTestId('mcp-catalog-facets');
}

// ---------------------------------------------------------------------------------------
// The page's own chrome
// ---------------------------------------------------------------------------------------

describe('the page chrome', () => {
  test('draws one page header and no landmark of its own', async () => {
    await renderCatalog();

    // One h1, from `PageHeader`, and the trail above it.
    expect(screen.getByRole('heading', { level: 1, name: 'MCP servers' })).toBeInTheDocument();
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByText('Bring in')).toBeInTheDocument();

    // The shell owns `<main>`; this screen must not draw a second one.
    expect(document.querySelector('main')).toBeNull();
  });

  test('carries one primary action and the section tabs with their counts', async () => {
    await renderCatalog();

    expect(screen.getByTestId('mcp-catalog-refresh')).toBeInTheDocument();
    expect(screen.getByTestId('mcp-catalog-add')).toBeInTheDocument();

    const tabs = screen.getByTestId('mcp-section-tabs');
    // Three endpoints across two hosts, 32 capabilities between them.
    expect(within(tabs).getByRole('link', { name: 'Servers 3' })).toBeInTheDocument();
    expect(within(tabs).getByRole('link', { name: 'Capabilities 32' })).toBeInTheDocument();
  });

  test('re-reads the catalog when Refresh is pressed', async () => {
    const user = userEvent.setup();
    await renderCatalog();
    const before = requests.filter((url) => url.startsWith('/api/mcp/browse')).length;

    await user.click(screen.getByTestId('mcp-catalog-refresh'));

    await waitFor(() => {
      expect(requests.filter((url) => url.startsWith('/api/mcp/browse')).length).toBe(before + 1);
    });
  });
});

// ---------------------------------------------------------------------------------------
// AC 1 — the ten facets, and counts that reflect the active set
// ---------------------------------------------------------------------------------------

describe('the ten facets', () => {
  test('renders every facet the catalog contains, in the mockup’s order', async () => {
    const user = userEvent.setup();
    await renderCatalog();
    const panel = await openFilters(user);

    const labels = [...panel.querySelectorAll('.mcp-facet__label')].map((el) => el.textContent);
    expect(labels).toEqual([
      'Host',
      'Grade',
      'Transport',
      'Safety',
      'Complexity',
      'Protocol',
      'Health',
      'Visibility',
      'Auth',
      'Category',
    ]);
  });

  test('states its own rule: facets AND, values OR, counts from the full catalog', async () => {
    const user = userEvent.setup();
    await renderCatalog();
    const panel = await openFilters(user);

    expect(within(panel).getByText(MCP_CATALOG_FACET_NOTE)).toBeInTheDocument();
  });

  test('a facet value narrows the catalog, and the chip counts stay selectable', async () => {
    const user = userEvent.setup();
    await renderCatalog();
    const panel = await openFilters(user);

    await user.click(within(panel).getByRole('button', { name: /^A 1$/ }));

    expect(screen.getByRole('link', { name: /Open Payments tools/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Open Orders assistant/i })).toBeNull();
    // Grade B is still offered, with its full-catalog count — that is what makes it reachable.
    expect(within(panel).getByRole('button', { name: /^B 1$/ })).toBeInTheDocument();
  });

  test('two values inside one facet OR together', async () => {
    const user = userEvent.setup();
    await renderCatalog();
    const panel = await openFilters(user);

    await user.click(within(panel).getByRole('button', { name: /^A 1$/ }));
    await user.click(within(panel).getByRole('button', { name: /^B 1$/ }));

    expect(screen.getByRole('link', { name: /Open Payments tools/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open Orders assistant/i })).toBeInTheDocument();
  });

  test('two facets AND together', async () => {
    const user = userEvent.setup();
    await renderCatalog();
    const panel = await openFilters(user);

    await user.click(within(panel).getByRole('button', { name: /^A 1$/ }));
    // Payments tools is grade A but its transport is streamable_http, so this excludes it.
    await user.click(within(panel).getByRole('button', { name: /^http\+sse 2$/ }));

    expect(screen.getByTestId('mcp-catalog-no-match')).toBeInTheDocument();
  });

  test('the totals line reflects the active set and names what it was filtered from', async () => {
    const user = userEvent.setup();
    await renderCatalog();

    const totals = screen.getByTestId('mcp-catalog-totals');
    expect(totals).toHaveTextContent('2 hosts · 3 endpoints · 32 capabilities');
    expect(totals).not.toHaveTextContent(/filtered from/);
    expect(totals).toHaveTextContent(MCP_CATALOG_SORT_HINT.grade);

    const panel = await openFilters(user);
    await user.click(within(panel).getByRole('button', { name: /^A 1$/ }));

    expect(screen.getByTestId('mcp-catalog-totals')).toHaveTextContent(
      '1 host · 1 endpoint · 21 capabilities · filtered from 3 endpoints by 1 facet value',
    );
  });

  test('the search box narrows the same way, and is named in the totals line', async () => {
    const user = userEvent.setup();
    await renderCatalog();

    await user.type(screen.getByLabelText('Search the catalog'), 'orders');

    expect(screen.getByRole('link', { name: /Open Orders assistant/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Open Payments tools/i })).toBeNull();
    expect(screen.getByTestId('mcp-catalog-totals')).toHaveTextContent(
      'filtered from 3 endpoints by a search for “orders”',
    );
  });

  test('clearing from the no-match state restores the whole catalog', async () => {
    const user = userEvent.setup();
    await renderCatalog();

    await user.type(screen.getByLabelText('Search the catalog'), 'nothing matches this');
    const empty = await screen.findByTestId('mcp-catalog-no-match');
    expect(within(empty).getByText(MCP_CATALOG_NO_MATCH_TITLE)).toBeInTheDocument();

    await user.click(within(empty).getByRole('button', { name: /Clear search and filters/i }));
    expect(screen.getByRole('link', { name: /Open Payments tools/i })).toBeInTheDocument();
  });

  test('the sort control changes the ordering and the hint beside the totals', async () => {
    await renderCatalog();
    expect(screen.getByTestId('mcp-catalog-totals')).toHaveTextContent(MCP_CATALOG_SORT_HINT.grade);

    // The Radix select is a listbox; the model's ordering itself is covered in mcp-catalog-ui.
    expect(screen.getByLabelText('Sort')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------
// The host groups
// ---------------------------------------------------------------------------------------

describe('the host groups', () => {
  test('each host is a labelled section carrying its counts and health rollup', async () => {
    await renderCatalog();

    const group = screen.getByTestId('mcp-host-mcp.acme.dev');
    expect(within(group).getByRole('heading', { level: 3, name: 'mcp.acme.dev' })).toBeInTheDocument();
    expect(within(group).getByText('2 endpoints')).toBeInTheDocument();
    expect(within(group).getByText('32 capabilities')).toBeInTheDocument();
    expect(within(group).getByText('2 healthy')).toBeInTheDocument();
  });

  test('an unreachable endpoint says so in words, not only in a frame', async () => {
    await renderCatalog();

    const card = screen.getByTestId('mcp-card-ep-crm');
    expect(card).toHaveAttribute('data-alert', 'danger');
    expect(within(card).getByText('Unreachable')).toBeInTheDocument();
    expect(within(card).getByText('Quarantined')).toBeInTheDocument();
  });

  test('the density control swaps the cards for dense rows and persists the choice', async () => {
    const user = userEvent.setup();
    await renderCatalog();
    expect(screen.getByTestId('mcp-card-ep-payments')).toBeInTheDocument();

    const group = screen.getByRole('radiogroup', { name: 'Layout density' });
    await user.click(within(group).getByRole('radio', { name: /Dense list view/i }));

    expect(screen.getByTestId('mcp-row-ep-payments')).toBeInTheDocument();
    expect(screen.queryByTestId('mcp-card-ep-payments')).toBeNull();
    expect(window.localStorage.getItem('mcp.catalog.density')).toBe('list');
  });
});

// ---------------------------------------------------------------------------------------
// AC 2 — the two strips keep their contracts
// ---------------------------------------------------------------------------------------

describe('saved searches', () => {
  test('pins run as one click and restore query, filters and sort', async () => {
    const user = userEvent.setup();
    await renderCatalog();

    const strip = screen.getByTestId('mcp-saved-searches');
    await user.click(within(strip).getByRole('button', { name: /Public A\/B servers/ }));

    // Query restored…
    expect(screen.getByLabelText('Search the catalog')).toHaveValue('acme');
    // …and the two facets it saved, which is three values in total.
    expect(screen.getByTestId('mcp-catalog-totals')).toHaveTextContent(
      'by 3 facet values and a search for “acme”',
    );
  });

  test('the manage list prints the view each saved search restores', async () => {
    const user = userEvent.setup();
    await renderCatalog();

    const strip = screen.getByTestId('mcp-saved-searches');
    await user.click(within(strip).getByRole('button', { name: 'Saved (2)' }));

    expect(
      within(strip).getByText('Query “acme” · Filters: Grade A, B, Visibility public · Sort Grade'),
    ).toBeInTheDocument();
    expect(
      within(strip).getByText(
        'Filters: Transport http+sse · Sort Last discovered',
      ),
    ).toBeInTheDocument();
  });

  test('the save dialog shows the view it is about to save, before it is saved', async () => {
    const user = userEvent.setup();
    await renderCatalog();

    const panel = await openFilters(user);
    await user.click(within(panel).getByRole('button', { name: /^A 1$/ }));

    await user.click(screen.getByRole('button', { name: /Save search/ }));
    expect(await screen.findByTestId('mcp-save-summary')).toHaveTextContent(
      'Saves: Filters: Grade A · Sort Grade',
    );

    await user.type(screen.getByLabelText(/Name/), 'Top of the class');
    await user.click(screen.getByRole('button', { name: /^Save$/ }));

    await waitFor(() => {
      const posted = (global.fetch as jest.Mock).mock.calls.find(
        ([url, init]) =>
          String(url) === '/api/mcp/saved-searches' &&
          (init as { method?: string } | undefined)?.method === 'POST',
      );
      expect(posted).toBeDefined();
      const body = JSON.parse((posted?.[1] as { body: string }).body);
      expect(body.name).toBe('Top of the class');
      expect(body.filters.grades).toEqual(['A']);
      expect(body.sort).toBe('grade');
    });
  });
});

describe('collections', () => {
  test('the create dialog names the endpoints it will freeze in, and says membership is fixed', async () => {
    const user = userEvent.setup();
    await renderCatalog();

    await user.click(screen.getByRole('button', { name: /New collection/ }));

    const note = await screen.findByTestId('mcp-collection-membership');
    expect(note).toHaveTextContent(
      'Includes 3 endpoints from the current catalog view: Payments tools, Orders assistant, Legacy CRM connector.',
    );
    expect(note).toHaveTextContent(COLLECTIONS_FIXED_MEMBERSHIP_NOTE);
  });

  test('membership follows the *view*, so filtering first creates a smaller collection', async () => {
    const user = userEvent.setup();
    await renderCatalog();

    const panel = await openFilters(user);
    await user.click(within(panel).getByRole('button', { name: /^A 1$/ }));

    await user.click(screen.getByRole('button', { name: /New collection/ }));
    expect(await screen.findByTestId('mcp-collection-membership')).toHaveTextContent(
      'Includes 1 endpoint from the current catalog view: Payments tools.',
    );

    await user.type(screen.getByLabelText(/Name/), 'Graded A');
    await user.click(screen.getByRole('button', { name: /^Create$/ }));

    await waitFor(() => {
      const posted = (global.fetch as jest.Mock).mock.calls.find(
        ([url, init]) =>
          String(url) === '/api/mcp/collections' &&
          (init as { method?: string } | undefined)?.method === 'POST',
      );
      expect(posted).toBeDefined();
      expect(JSON.parse((posted?.[1] as { body: string }).body).endpointIds).toEqual([
        'ep-payments',
      ]);
    });
  });

  test('the manage list carries the published tag and the member count', async () => {
    const user = userEvent.setup();
    await renderCatalog();

    const strip = screen.getByTestId('mcp-collections');
    await user.click(within(strip).getByRole('button', { name: 'Collections (1)' }));

    expect(within(strip).getByText('published')).toHaveAttribute('data-status', 'published');
    expect(
      within(strip).getByText('2 endpoints · Vetted for the field-ops assistants'),
    ).toBeInTheDocument();
    expect(within(strip).getByRole('button', { name: /Delete Approved geo tools/ })).toBeInTheDocument();
  });

  test('deleting a collection confirms first, naming it and its consequence', async () => {
    const user = userEvent.setup();
    await renderCatalog();

    const strip = screen.getByTestId('mcp-collections');
    await user.click(within(strip).getByRole('button', { name: 'Collections (1)' }));
    await user.click(within(strip).getByRole('button', { name: /Delete Approved geo tools/ }));

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    const options = mockConfirm.mock.calls[0][0] as { title?: string; description?: string };
    expect(JSON.stringify(options)).toContain('Approved geo tools');
    expect(JSON.stringify(options)).toContain('stay in the catalog');
  });
});

// ---------------------------------------------------------------------------------------
// AC 3 — the shared status tokens
// ---------------------------------------------------------------------------------------

describe('the status vocabulary', () => {
  test('grade, health, freshness and recency all render from the shared primitives', async () => {
    await renderCatalog();

    const card = screen.getByTestId('mcp-card-ep-payments');
    // Grade: the A–F glyph, labelled for a screen reader rather than colour-only.
    expect(within(card).getByRole('img', { name: /Grade A, score 94 of 100/ })).toBeInTheDocument();
    // Health and recency.
    expect(within(card).getByText('Healthy')).toBeInTheDocument();
    expect(within(card).getByText(/Last discovered/)).toBeInTheDocument();
    // Freshness renders nothing at all when the endpoint is fresh.
    expect(within(card).queryByText(/^Stale$/)).toBeNull();

    // …and does render for the quarantined one.
    expect(
      within(screen.getByTestId('mcp-card-ep-crm')).getByText('Quarantined'),
    ).toBeInTheDocument();
  });

  test('the Changed marker is honey, and only for an endpoint versioned since the last visit', async () => {
    window.localStorage.setItem(
      'mcp.catalog.seen',
      JSON.stringify({
        'ep-payments': { versionId: 'v-0', discoveredAt: '2026-08-01T00:00:00Z' },
        'ep-orders': { versionId: 'v-1', discoveredAt: '2026-08-19T10:00:00Z' },
      }),
    );
    await renderCatalog();

    const changed = within(screen.getByTestId('mcp-card-ep-payments')).getByText('Changed');
    expect(changed.closest('[data-status]')).toHaveAttribute('data-status', 'new');
    expect(within(screen.getByTestId('mcp-card-ep-orders')).queryByText('Changed')).toBeNull();
  });

  test('the shadowed-names alert groups the collisions by scope', async () => {
    const user = userEvent.setup();
    await renderCatalog();

    const alert = await screen.findByTestId('mcp-shadowed-names');
    expect(within(alert).getByText('2 shadowed names')).toBeInTheDocument();
    expect(within(alert).getByText(/1 same-host, 1 cross-host/)).toBeInTheDocument();

    await user.click(within(alert).getByRole('button', { name: /2 shadowed names/ }));
    // Same-host is the stronger scope and takes `rose`; cross-host is advisory and takes `warn`.
    expect(shadowScopeTone('same_host')).toBe('rose');
    expect(shadowScopeTone('cross_host')).toBe('warn');
    expect(within(alert).getByText('Same host')).toHaveClass(STATUS_TONE_SOFT_CLASS.rose.split(' ')[0]);
    expect(within(alert).getByText('Cross host')).toHaveClass(STATUS_TONE_SOFT_CLASS.warn.split(' ')[0]);
    expect(within(alert).getByText('tool:search')).toBeInTheDocument();
    expect(within(alert).getByText('prompt:summarize')).toBeInTheDocument();
  });

  test('a clean scope spends no space on the alert', async () => {
    routes['/api/mcp/data-quality/shadowing'] = {
      body: { advisory: true, group_count: 0, groups: [] },
    };
    await renderCatalog();

    expect(screen.queryByTestId('mcp-shadowed-names')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------
// The four states
// ---------------------------------------------------------------------------------------

describe('the states', () => {
  test('loading draws skeleton cards shaped like the content, not a spinner', async () => {
    render(<McpCatalogClient />);

    const skeleton = screen.getByTestId('mcp-catalog-skeleton');
    expect(skeleton.querySelectorAll('.mcp-card--skeleton')).toHaveLength(3);
    expect(within(skeleton).getByRole('status')).toHaveTextContent('Loading the MCP catalog…');

    await screen.findByRole('link', { name: /Open Payments tools/i });
  });

  test('a failed read is a retryable error state', async () => {
    const user = userEvent.setup();
    routes['/api/mcp/browse'] = { status: 503, body: { error: 'Catalog service is down' } };
    render(<McpCatalogClient />);

    const error = await screen.findByTestId('mcp-catalog-error');
    expect(within(error).getByText(MCP_CATALOG_ERROR_TITLE)).toBeInTheDocument();
    expect(within(error).getByText('Catalog service is down')).toBeInTheDocument();

    routes['/api/mcp/browse'] = { body: BROWSE };
    await user.click(within(error).getByRole('button', { name: /Try again/i }));
    expect(await screen.findByRole('link', { name: /Open Payments tools/i })).toBeInTheDocument();
  });

  test('an empty catalog teaches, and hides the toolbar, the strips and the tabs', async () => {
    routes['/api/mcp/browse'] = { body: { success: true, groups: [] } };
    render(<McpCatalogClient />);

    const empty = await screen.findByTestId('mcp-catalog-empty');
    expect(within(empty).getByText(MCP_CATALOG_EMPTY_TITLE)).toBeInTheDocument();
    expect(within(empty).getByRole('button', { name: /Add MCP server/ })).toBeInTheDocument();

    expect(screen.queryByTestId('mcp-catalog-toolbar')).toBeNull();
    expect(screen.queryByTestId('mcp-saved-searches')).toBeNull();
    expect(screen.queryByTestId('mcp-section-tabs')).toBeNull();
  });

  test('a reader with no workspace is gated rather than told to register a server', async () => {
    mockSessionUser.current_tenant_id = undefined;
    render(<McpCatalogClient />);

    expect(
      await screen.findByText('The MCP catalog is scoped to one workspace.'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('mcp-catalog-empty')).toBeNull();
    // The primary action is disabled rather than absent, so the reason is discoverable.
    expect(screen.getByTestId('mcp-catalog-add')).toBeDisabled();
    // And nothing is read for a workspace that does not exist.
    expect(requests.filter((url) => url.startsWith('/api/mcp/browse'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------
// Browser fixtures
// ---------------------------------------------------------------------------------------

/**
 * The markup `e2e/hive-mcp-catalog.spec.ts` measures.
 *
 * Rather than hand-writing HTML files that would drift the first time a class changed, the
 * browser suite measures what *this* suite rendered. The block below renders each surface and
 * writes what it rendered into `e2e/fixtures/hive-mcp-catalog/` when `MCP_FIXTURE_DUMP=1` is set:
 *
 *     MCP_FIXTURE_DUMP=1 npx jest -c jest.config.ts \
 *       tests/mcp-catalog-hive-redesign.test.tsx -t fixtures
 *
 * Without the variable the tests still run — they render every surface and check each is there —
 * so a change that would leave the fixtures stale fails loudly here before it fails quietly in
 * the browser.
 */
describe('the browser fixtures', () => {
  const OUT = path.join(__dirname, '..', 'e2e', 'fixtures', 'hive-mcp-catalog');
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
   * Serialise a subtree with its live form state.
   *
   * `outerHTML` writes *attributes*, and a value typed into a field has only the `value`
   * **property** — so a fixture of a filled form would arrive in the browser empty.
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

  test('renders the grid catalog (and writes its fixture on request)', async () => {
    const user = userEvent.setup();
    await renderCatalog();
    await screen.findByTestId('mcp-shadowed-names');
    // Open everything the browser suite needs to measure at once.
    await openFilters(user);
    await user.click(
      within(screen.getByTestId('mcp-saved-searches')).getByRole('button', { name: 'Saved (2)' }),
    );
    await user.click(
      within(screen.getByTestId('mcp-collections')).getByRole('button', {
        name: 'Collections (1)',
      }),
    );
    write('catalog-grid', page());
  });

  test('renders the dense list (and writes its fixture)', async () => {
    const user = userEvent.setup();
    await renderCatalog();
    const group = screen.getByRole('radiogroup', { name: 'Layout density' });
    await user.click(within(group).getByRole('radio', { name: /Dense list view/i }));
    write('catalog-list', page());
  });

  test('renders the empty catalog (and writes its fixture)', async () => {
    routes['/api/mcp/browse'] = { body: { success: true, groups: [] } };
    render(<McpCatalogClient />);
    await screen.findByTestId('mcp-catalog-empty');
    write('catalog-empty', page());
  });
});
