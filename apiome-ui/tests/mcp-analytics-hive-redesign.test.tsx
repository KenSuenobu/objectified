/**
 * The MCP catalog-analytics redesign, rendered (HIVE-7.9, #5326).
 *
 * `mcp-catalog-insight-ui.test.ts` holds the parser and the projections,
 * `mcp-catalog-analytics-dashboard.test.tsx` holds the tiles in isolation, and
 * `mcp-analytics-css.test.ts` pins the declarations. This holds the *screen* — what
 * `McpCatalogAnalyticsClient` composes out of them against a mocked read of the one API it
 * touches.
 *
 * What it pins is the ticket's first and fourth acceptance criteria and the mockup's
 * **Notes → Keeps (1:1)**, **Adds** and **States** lists:
 *
 *   1. **Charts render from the shared kit with no bespoke SVG colours.** Every mark on the screen
 *      is an `ui/mcp/charts` primitive, and every class those primitives paint with resolves to a
 *      Hive role token — asserted through `CHART_TONE_ROLE` and a walk over the rendered SVG rather
 *      than through a fixed class string, so a chart that grew a literal fails here.
 *   4. **Empty states for "no servers registered".** The empty catalog is a first-run state, not an
 *      error, and it hides the section tabs; a failed read is an error with a retry that re-runs
 *      the same request; a session with no workspace is gated before either.
 *
 * Plus the mockup's Adds — the Preview marker beside the title, the public/private split under
 * *Published*, the Export CSV action, and the counts the tab strip prints — and the five things
 * the screen got wrong that this ticket fixes.
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

/** The current path, so the section tabs light the Analytics tab. */
const pathname = '/ade/dashboard/mcp/analytics';

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

import McpCatalogAnalyticsClient from '../src/app/ade/dashboard/mcp/analytics/McpCatalogAnalyticsClient';
import {
  MCP_ANALYTICS_CSV_FILENAME,
  MCP_ANALYTICS_EMPTY_TITLE,
  MCP_ANALYTICS_ERROR_TITLE,
  MCP_ANALYTICS_TITLE,
  mcpCatalogInsightCsv,
  mcpCatalogInsightFromPayload,
} from '../src/app/components/ade/dashboard/mcp/mcpCatalogInsightUi';
import { CHART_TONE_ROLE } from '../src/app/components/ui/mcp/charts/chartTokens';

// ---------------------------------------------------------------------------------------
// Fixtures — the catalog `sources/mcp-analytics.html` draws
// ---------------------------------------------------------------------------------------

const CATALOG = {
  success: true,
  endpoint_count: 6,
  published_count: 2,
  public_count: 2,
  private_count: 4,
  discovered_count: 5,
  scored_count: 5,
  average_score: 71.8,
  type_counts: { tools: 44, resources: 12, resource_templates: 4, prompts: 5, total: 65 },
  grade_distribution: { A: 1, B: 2, C: 1, D: 1, F: 0 },
  category_distribution: [
    { label: 'finance', count: 2 },
    { label: 'geo', count: 1 },
    { label: 'logistics', count: 1 },
    { label: 'developer-tools', count: 1 },
    { label: 'crm', count: 1 },
  ],
  transport_distribution: [
    { label: 'streamable_http', count: 3 },
    { label: 'http+sse', count: 2 },
    { label: 'stdio', count: 1 },
  ],
  protocol_version_distribution: [
    { label: '2025-06-18', count: 3 },
    { label: '2025-03-26', count: 2 },
    { label: 'unknown', count: 1 },
  ],
  tool_count_distribution: [
    { label: '0', count: 1 },
    { label: '1–5', count: 2 },
    { label: '6–10', count: 1 },
    { label: '11–20', count: 2 },
    { label: '21–50', count: 0 },
    { label: '50+', count: 0 },
  ],
  discovery_health: [
    { label: 'healthy', count: 4 },
    { label: 'failing', count: 1 },
    { label: 'quarantined', count: 1 },
  ],
  change_leaders: [
    { endpoint_id: 'ep-geo', name: 'Globex geo tools', change_count: 11 },
    { endpoint_id: 'ep-pay', name: 'Payments tools', change_count: 9 },
  ],
  top_capabilities: [
    { item_type: 'tool', item_name: 'search', endpoint_count: 3 },
    { item_type: 'prompt', item_name: 'summarize', endpoint_count: 2 },
  ],
};

const EMPTY_CATALOG = {
  success: true,
  endpoint_count: 0,
  published_count: 0,
  public_count: 0,
  private_count: 0,
  discovered_count: 0,
  scored_count: 0,
  average_score: null,
  type_counts: { tools: 0, resources: 0, resource_templates: 0, prompts: 0, total: 0 },
  grade_distribution: {},
};

/** What the mocked `fetch` answers `/api/mcp/insight/catalog` with. */
let route: { status?: number; body: unknown };

/** Every URL the screen requested, in order. */
let requests: string[];

function stubFetch(): void {
  requests = [];
  global.fetch = jest.fn(async (input: unknown) => {
    requests.push(String(input));
    return {
      ok: (route.status ?? 200) < 400,
      status: route.status ?? 200,
      statusText: 'Service Unavailable',
      json: async () => route.body,
    };
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSessionUser.current_tenant_id = 't-acme';
  route = { body: CATALOG };
  stubFetch();
});

/** Render the screen and wait for the first roll-up to land. */
async function renderAnalytics(): Promise<void> {
  render(<McpCatalogAnalyticsClient />);
  await screen.findByTestId('mcp-analytics');
}

// ---------------------------------------------------------------------------------------
// The page frame
// ---------------------------------------------------------------------------------------

describe('the page frame', () => {
  test('is Page + PageHeader + PageBody, with no <main> of its own', async () => {
    const { container } = render(<McpCatalogAnalyticsClient />);
    await screen.findByTestId('mcp-analytics');

    // The shell draws the landmark; a second one inside it is the bug this replaces.
    expect(container.querySelector('main')).toBeNull();
    expect(container.querySelector('.page')).toBeInTheDocument();
    expect(screen.getByTestId('page-header')).toBeInTheDocument();
    expect(container.querySelector('.page-body')).toBeInTheDocument();
  });

  test('names the page once, as an h1, with the trail above it', async () => {
    await renderAnalytics();

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(MCP_ANALYTICS_TITLE);
    const crumbs = within(screen.getByTestId('page-breadcrumb'));
    expect(crumbs.getByRole('link', { name: 'MCP servers' })).toHaveAttribute(
      'href',
      '/ade/dashboard/mcp',
    );
    expect(crumbs.getByText('Analytics')).toHaveAttribute('aria-current', 'page');
  });

  test('marks the feature Preview beside the title rather than inside it', async () => {
    await renderAnalytics();
    const heading = within(screen.getByRole('heading', { level: 1 }));
    // `accent` is the tone DESIGN.md §3.1 gives maturity markers; honey is reserved for `new`.
    expect(heading.getByText('Preview')).toHaveAttribute('data-status', 'preview');
  });

  test('gives the screen exactly one primary action', async () => {
    await renderAnalytics();
    const actions = within(screen.getByTestId('page-header-actions'));
    expect(actions.getByTestId('mcp-analytics-refresh')).toHaveAccessibleName(/refresh/i);
    expect(actions.getByTestId('mcp-analytics-export')).toHaveAccessibleName(/export csv/i);
  });

  test('prints the endpoint and capability counts on the tab strip', async () => {
    await renderAnalytics();
    const tabs = within(screen.getByTestId('mcp-section-tabs'));
    expect(tabs.getByTestId('mcp-section-tab-servers')).toHaveTextContent('6');
    expect(tabs.getByTestId('mcp-section-tab-capabilities')).toHaveTextContent('65');
    // The strip is told what this screen already knows, so it never probes /api/mcp/browse.
    expect(requests.filter((url) => url.startsWith('/api/mcp/browse'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------
// Acceptance criterion 1 — the shared chart kit, no bespoke SVG colours
// ---------------------------------------------------------------------------------------

describe('charts render from the shared kit', () => {
  /** Every Tailwind ramp class, which is what "bespoke" means once the kit is token-driven. */
  const PALETTE_LITERAL =
    /\b(?:bg|text|border|ring|stroke|fill)-(?:slate|gray|zinc|neutral|stone|emerald|green|lime|amber|yellow|orange|red|rose|pink|violet|purple|indigo|blue|sky|cyan|teal)-\d{2,3}\b/;

  test('every mark paints a role token — no ramp class, no hex, no inline fill', async () => {
    const { container } = render(<McpCatalogAnalyticsClient />);
    await screen.findByTestId('mcp-analytics');

    const marks = container.querySelectorAll('svg *');
    expect(marks.length).toBeGreaterThan(20);
    for (const mark of marks) {
      expect(mark.getAttribute('class') ?? '').not.toMatch(PALETTE_LITERAL);
      // A colour spelled as an SVG presentation attribute would bypass the token layer entirely.
      for (const attribute of ['fill', 'stroke', 'style']) {
        const value = mark.getAttribute(attribute);
        if (value) expect(value).not.toMatch(/#[0-9a-f]{3,6}\b|rgb\(|hsl\(/i);
      }
    }
  });

  test('the legend swatch and its donut segment resolve the same role', async () => {
    const { container } = render(<McpCatalogAnalyticsClient />);
    await screen.findByTestId('mcp-analytics');

    const tile = container.querySelector('[data-testid="mcp-analytics-category-mix"]')!;
    const swatches = [...tile.querySelectorAll('.mcpa-legend__swatch')].map(
      (node) => node.className.match(/bg-([a-z-]+)/)?.[1],
    );
    const slices = [...tile.querySelectorAll('svg path, svg circle')]
      .map((node) => node.getAttribute('class')?.match(/fill-([a-z-]+)/)?.[1])
      .filter((role): role is string => !!role && role !== 'inset');

    // The mockup's own category-donut order: accent, ok, violet, warn, rose.
    expect(swatches.slice(0, 5)).toEqual(['accent', 'ok', 'violet', 'warn', 'rose']);
    expect(slices.slice(0, 5)).toEqual(swatches.slice(0, 5));
  });

  test('the grade ring is toned by band rather than by position', async () => {
    const { container } = render(<McpCatalogAnalyticsClient />);
    await screen.findByTestId('mcp-analytics');

    const tile = container.querySelector('[data-testid="mcp-analytics-grade-mix"]')!;
    const swatches = [...tile.querySelectorAll('.mcpa-legend__swatch')].map(
      (node) => node.className.match(/bg-([a-z-]+)/)?.[1],
    );
    // A and B are `ok`, C is `warn`, D and F are `danger` — the meaning, not the sequence.
    expect(swatches).toEqual([
      CHART_TONE_ROLE.emerald,
      CHART_TONE_ROLE.emerald,
      CHART_TONE_ROLE.amber,
      CHART_TONE_ROLE.red,
      CHART_TONE_ROLE.red,
    ]);
  });

  test('every chart states its own data as text, so colour is never the only signal', async () => {
    const { container } = render(<McpCatalogAnalyticsClient />);
    await screen.findByTestId('mcp-analytics');

    const charts = container.querySelectorAll('svg[role="img"]');
    expect(charts.length).toBe(6);
    for (const chart of charts) {
      // A `<title>` and an `aria-label`, plus the kit's own `sr-only` data table beside it.
      expect(chart).toHaveAccessibleName();
      expect(chart.querySelector('title')?.textContent).toBeTruthy();
      expect(chart.closest('figure')?.querySelector('.sr-only')).toBeInTheDocument();
    }
  });
});

// ---------------------------------------------------------------------------------------
// Acceptance criterion 4 — the states
// ---------------------------------------------------------------------------------------

describe('the four states', () => {
  test('an empty catalog is a first-run state, and it hides the section tabs', async () => {
    route = { body: EMPTY_CATALOG };
    render(<McpCatalogAnalyticsClient />);

    expect(await screen.findByTestId('mcp-analytics-empty')).toHaveTextContent(
      MCP_ANALYTICS_EMPTY_TITLE,
    );
    // "Nothing to browse yet" is not the moment to offer three more views of nothing.
    expect(screen.queryByTestId('mcp-section-tabs')).not.toBeInTheDocument();
    // And it is not an error: the export has nothing to export, so it is off.
    expect(screen.getByTestId('mcp-analytics-export')).toBeDisabled();
  });

  test('a failed read is an error whose retry re-runs the same request', async () => {
    const user = userEvent.setup();
    route = { status: 503, body: { error: 'insight service unavailable' } };
    render(<McpCatalogAnalyticsClient />);

    const state = await screen.findByTestId('mcp-analytics-error');
    expect(state).toHaveTextContent(MCP_ANALYTICS_ERROR_TITLE);
    expect(state).toHaveTextContent('insight service unavailable');

    const before = requests.length;
    route = { body: CATALOG };
    await user.click(within(state).getByRole('button', { name: /try again/i }));

    await screen.findByTestId('mcp-analytics');
    expect(requests.length).toBeGreaterThan(before);
    expect(requests.at(-1)).toBe('/api/mcp/insight/catalog');
  });

  test('a session with no workspace is gated before anything is read', async () => {
    mockSessionUser.current_tenant_id = undefined;
    render(<McpCatalogAnalyticsClient />);

    expect(await screen.findByText(/pick a workspace first/i)).toBeInTheDocument();
    expect(screen.queryByTestId('mcp-analytics')).not.toBeInTheDocument();
    // Refresh cannot reload a catalog the session has no workspace for.
    expect(screen.getByTestId('mcp-analytics-refresh')).toBeDisabled();
  });

  test('a populated catalog renders the stat strip, the six charts and both leaderboards', async () => {
    await renderAnalytics();

    expect(screen.getByTestId('mcp-analytics-stats')).toBeInTheDocument();
    for (const testId of [
      'mcp-analytics-category-mix',
      'mcp-analytics-transport-mix',
      'mcp-analytics-grade-mix',
      'mcp-analytics-protocol',
      'mcp-analytics-tool-counts',
      'mcp-analytics-health',
      'mcp-analytics-change-leaders',
      'mcp-analytics-top-capabilities',
    ]) {
      expect(screen.getByTestId(testId)).toBeInTheDocument();
    }
  });
});

// ---------------------------------------------------------------------------------------
// The mockup's Adds
// ---------------------------------------------------------------------------------------

describe('Export CSV', () => {
  test('offers the whole dashboard under one filename, built from the same roll-up', async () => {
    const user = userEvent.setup();

    const created: string[] = [];
    const revoked: string[] = [];
    let captured = '';
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = jest.fn((blob: unknown) => {
      captured = (blob as { __text?: string }).__text ?? '';
      created.push('blob:mcp');
      return 'blob:mcp';
    }) as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = jest.fn((url: string) => {
      revoked.push(url);
    }) as unknown as typeof URL.revokeObjectURL;

    // jsdom's Blob does not expose its parts, so capture the text on the way in.
    const OriginalBlob = global.Blob;
    global.Blob = class extends OriginalBlob {
      __text: string;
      constructor(parts: BlobPart[], options?: BlobPropertyBag) {
        super(parts, options);
        this.__text = parts.map(String).join('');
      }
    } as unknown as typeof Blob;

    let downloadName = '';
    const clicked = jest.fn();
    const originalCreateElement = document.createElement.bind(document);
    jest.spyOn(document, 'createElement').mockImplementation((tag: string, options?: unknown) => {
      const element = originalCreateElement(tag, options as never);
      if (tag === 'a') {
        Object.defineProperty(element, 'click', {
          value: () => {
            downloadName = (element as HTMLAnchorElement).download;
            clicked();
          },
        });
      }
      return element;
    });

    try {
      await renderAnalytics();
      await user.click(screen.getByTestId('mcp-analytics-export'));

      expect(clicked).toHaveBeenCalledTimes(1);
      expect(downloadName).toBe(MCP_ANALYTICS_CSV_FILENAME);
      // The sheet is the same projection the tiles render, so the two cannot disagree.
      expect(captured).toBe(mcpCatalogInsightCsv(mcpCatalogInsightFromPayload(CATALOG)!));
      // The object URL is released rather than pinning its blob for the document's lifetime.
      expect(revoked).toEqual(created);
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
      global.Blob = OriginalBlob;
      jest.restoreAllMocks();
    }
  });
});

describe('the headline strip', () => {
  test('renders the public/private split the payload always carried', async () => {
    await renderAnalytics();
    const stats = within(screen.getByTestId('mcp-analytics-stats'));
    expect(stats.getByText('2 public · 4 private')).toBeInTheDocument();
    expect(stats.getByText('of 6')).toBeInTheDocument();
  });

  test('states the average score to one decimal, against what it averages', async () => {
    await renderAnalytics();
    const stats = within(screen.getByTestId('mcp-analytics-stats'));
    expect(stats.getByText('71.8')).toBeInTheDocument();
    expect(stats.getByText('across scored endpoints')).toBeInTheDocument();
  });

  test('prints an em dash rather than a zero when nothing has been scored', async () => {
    route = { body: { ...CATALOG, scored_count: 0, average_score: null } };
    render(<McpCatalogAnalyticsClient />);
    await screen.findByTestId('mcp-analytics');

    const stats = within(screen.getByTestId('mcp-analytics-stats'));
    expect(stats.getByText('—')).toBeInTheDocument();
    expect(stats.getByText('6 unscored')).toBeInTheDocument();
  });
});

describe('Refresh', () => {
  test('re-reads the roll-up', async () => {
    const user = userEvent.setup();
    await renderAnalytics();

    const before = requests.length;
    await user.click(screen.getByTestId('mcp-analytics-refresh'));

    await waitFor(() => expect(requests.length).toBeGreaterThan(before));
    expect(requests.at(-1)).toBe('/api/mcp/insight/catalog');
  });
});

// ---------------------------------------------------------------------------------------
// Browser fixtures
// ---------------------------------------------------------------------------------------

/**
 * The markup `e2e/hive-mcp-analytics.spec.ts` measures.
 *
 * Rather than hand-writing HTML that would drift the first time a class changed, the browser
 * suite measures what *this* suite rendered. The block below renders each surface and writes it
 * into `e2e/fixtures/hive-mcp-analytics/` when `MCP_FIXTURE_DUMP=1` is set:
 *
 *     MCP_FIXTURE_DUMP=1 npx jest -c jest.config.ts \
 *       tests/mcp-analytics-hive-redesign.test.tsx -t fixtures
 *
 * Without the variable the tests still run — they render every surface and check each is there —
 * so a change that would leave the fixtures stale fails loudly here before it fails quietly in
 * the browser.
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

  /** The page column the shell would put this screen in. */
  const pageColumn = () => (document.querySelector('.page') as HTMLElement).outerHTML;

  test('renders the populated dashboard (and writes its fixture on request)', async () => {
    await renderAnalytics();
    write('dashboard', pageColumn());
  });

  test('renders the empty catalog (and writes its fixture)', async () => {
    route = { body: EMPTY_CATALOG };
    render(<McpCatalogAnalyticsClient />);
    await screen.findByTestId('mcp-analytics-empty');
    write('empty', pageColumn());
  });
});
