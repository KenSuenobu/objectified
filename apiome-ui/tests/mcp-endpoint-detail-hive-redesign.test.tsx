/**
 * The MCP endpoint-detail redesign, rendered (HIVE-7.8, #5325).
 *
 * `mcp-insight-tab.test.tsx` holds the Insight rail and its fourteen views,
 * `mcp-version-history-deeplink.test.tsx` holds the churn deep-link,
 * `mcp-settings-components.test.tsx` holds the settings model, and
 * `mcp-endpoint-detail-css.test.ts` pins the declarations. This holds the *screen* — what
 * `McpEndpointDetailClient` composes out of them against mocked reads of the APIs it touches.
 *
 * What it pins is the ticket's four acceptance criteria and the mockup's **Notes → Keeps (1:1)**
 * and **States** lists:
 *
 *   1. **All 14 insight views render with the shared chart kit** — the rail itself is
 *      `mcp-insight-tab.test.tsx`'s ("exposes all fourteen insight views"); what is here is that
 *      the screen mounts the Insight panel at all, and only when its tab is selected.
 *   2. **Version diff supports side-by-side and unified** — the layout switch is a `Segmented`
 *      radiogroup with both options, and the choice persists.
 *   3. **The typed-DELETE confirmation is preserved** — the dialog names the cascade, the button
 *      stays disabled until the word is typed exactly, and the teardown summary comes back.
 *   4. **Nested tab groups switch independently** — switching an Insight *view* leaves the outer
 *      strip on Insight, and switching the outer strip does not disturb the rail.
 *
 * Plus the five things the screen got wrong and this ticket fixes: a `<main>` landmark the shell
 * already draws, a hand-rolled header with a back link instead of a breadcrumb, four
 * `dashboardPanelPaddedClass` tiles where the metrics set belongs, a tab strip inside the body
 * rather than in the header, and a trust-posture panel that existed and was mounted nowhere.
 */

import * as fs from 'fs';
import * as path from 'path';
import React from 'react';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { jest } from '@jest/globals';

// ---------------------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------------------

const mockPush = jest.fn();

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/ade/dashboard/mcp/ep-1',
}));

jest.mock('sonner', () => ({
  toast: { message: jest.fn(), info: jest.fn(), success: jest.fn(), error: jest.fn() },
}));

jest.mock('@/app/components/providers/DialogProvider', () => ({
  useDialog: () => ({ confirm: async () => true, alert: jest.fn(), prompt: jest.fn() }),
}));

/**
 * The Insight tab is fourteen panels and eight reads of its own — `mcp-insight-tab.test.tsx`
 * drives all of it. Here it is a placeholder, so this suite measures the *screen*: that the
 * panel mounts when its tab is selected, and not before.
 */
jest.mock('@/app/ade/dashboard/mcp/[endpointId]/McpEndpointInsight', () => ({
  __esModule: true,
  default: () => <div data-testid="insight-stub">insight</div>,
}));

import McpEndpointDetailClient from '../src/app/ade/dashboard/mcp/[endpointId]/McpEndpointDetailClient';
import { MCP_ENDPOINT_PROPOSED_LABEL } from '../src/app/components/ade/dashboard/mcp/McpEndpointTabs';
import { MCP_NOTES_SUBTITLE } from '../src/app/components/ade/dashboard/mcp/McpEndpointNotesPanel';
import { MCP_DELETE_CONFIRM_WORD } from '../src/app/components/ade/dashboard/mcp/mcpSettingsForm';
import { mcpCapabilityAnchorId } from '../src/app/components/ade/dashboard/mcp/mcpLintUi';

// ---------------------------------------------------------------------------------------
// Fixtures — the endpoint the mockup draws
// ---------------------------------------------------------------------------------------

const ENDPOINT_ID = 'ep-payments';
const V5 = 'v-5';
const V4 = 'v-4';

function endpointPayload(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    endpoint: {
      id: ENDPOINT_ID,
      name: 'Payments tools',
      slug: 'payments-tools',
      endpoint_url: 'https://mcp.acme.dev/payments/mcp',
      transport: 'streamable_http',
      description: null,
      category: 'finance',
      visibility: 'public',
      published: true,
      enabled: true,
      discovery_cadence_seconds: 21600,
      current_version_id: V5,
      last_discovered_at: '2026-08-15T09:07:12Z',
      last_discovery_status: 'changed',
      added_via: 'manual',
      ...overrides,
    },
  };
}

/** The current snapshot: three tools, one resource, one prompt — one of each mockup section. */
function versionPayload() {
  return {
    success: true,
    version: {
      id: V5,
      version_seq: 5,
      version_tag: '2026.08.15-a',
      server_name: 'acme-payments',
      server_title: 'Acme Payments MCP',
      server_version: '2.3.0',
      protocol_version: '2025-06-18',
      instructions: 'Use `payments.search` before `payments.refund`.',
      score: 94,
      grade: 'A',
      is_current: true,
      discovered_at: '2026-08-15T09:07:12Z',
      items: [
        {
          item_type: 'tool',
          name: 'payments.search',
          title: 'Search payments',
          description: 'Find payments by customer, status, or date range.',
          uri: null,
          uri_template: null,
          input_schema: { type: 'object' },
          output_schema: null,
          annotations: { readOnlyHint: true, idempotentHint: true },
          ordinal: 0,
          lifecycle: { stage: 'stable', signals: [{ source: 'annotations', matched: 'stable' }] },
        },
        {
          item_type: 'tool',
          name: 'payments.refund',
          title: 'Refund a payment',
          description: 'Issue a full or partial refund.',
          uri: null,
          uri_template: null,
          input_schema: { type: 'object' },
          output_schema: null,
          annotations: { destructiveHint: true, openWorldHint: true },
          ordinal: 1,
          lifecycle: null,
        },
        {
          item_type: 'resource',
          name: 'merchant-profile',
          title: 'Merchant profile',
          description: 'Current merchant configuration.',
          uri: 'acme://payments/merchant',
          uri_template: null,
          input_schema: null,
          output_schema: null,
          annotations: null,
          ordinal: 0,
          lifecycle: null,
        },
        {
          item_type: 'prompt',
          name: 'summarize',
          title: 'Summarize disputes',
          description: 'Draft a dispute summary.',
          uri: null,
          uri_template: null,
          input_schema: { type: 'object' },
          output_schema: null,
          annotations: null,
          ordinal: 0,
          lifecycle: null,
        },
      ],
    },
  };
}

/** A lint report with one SHOULD finding that deep-links to `payments.refund`. */
function lintPayload() {
  return {
    success: true,
    endpoint_id: ENDPOINT_ID,
    version_id: V5,
    version_seq: 5,
    version_tag: '2026.08.15-a',
    score: 94,
    grade: 'A',
    source: 'stored',
    scored_at: '2026-08-15T09:07:12Z',
    report_fingerprint: '9f2c1a7e4b0d',
    rule_hits: { 'mcp-output-schema': 1 },
    severity_counts: { warning: 1 },
    findings: [
      {
        id: 'f-1',
        path: 'tools.payments.refund',
        category: 'annotation',
        rule: 'mcp-output-schema',
        severity: 'warning',
        message: 'Tool has no output schema.',
      },
    ],
  };
}

function versionsPayload() {
  const base = { endpoint_id: ENDPOINT_ID, server_name: 'acme-payments', server_title: null, server_version: '2.3.0', protocol_version: '2025-06-18' };
  return {
    success: true,
    versions: [
      { ...base, id: V5, version_seq: 5, version_tag: '2026.08.15-a', is_current: true, score: 94, grade: 'A', change_counts: { added: 0, removed: 0, modified: 2 } },
      { ...base, id: V4, version_seq: 4, version_tag: null, is_current: false, score: 90, grade: 'A', change_counts: { added: 3, removed: 1, modified: 2 } },
    ],
  };
}

function comparePayload() {
  return {
    success: true,
    base: { id: V4, version_seq: 4, version_tag: null, surface_fingerprint: 'fp4' },
    target: { id: V5, version_seq: 5, version_tag: '2026.08.15-a', surface_fingerprint: 'fp5' },
    fingerprint_changed: true,
    counts: { added: 0, removed: 0, modified: 1 },
    changes: [
      {
        item_type: 'tool',
        item_name: 'payments.refund',
        change_type: 'modified',
        detail: { fields: [{ field: 'inputSchema' }], before: { a: 1 }, after: { a: 2 } },
      },
    ],
  };
}

function notesPayload(bodies: string[] = ['Prefer the staging endpoint for QA.']) {
  return {
    success: true,
    notes: bodies.map((body, index) => ({
      id: `n-${index}`,
      endpoint_id: ENDPOINT_ID,
      body,
      created_by: 'u-grace',
      created_by_name: 'Grace Hopper',
      created_by_email: 'grace@example.com',
      created_at: '2026-08-12T16:40:00Z',
      updated_at: '2026-08-12T16:40:00Z',
    })),
  };
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, statusText: ok ? 'OK' : 'Error', json: async () => body } as Response;
}

/** Every write the screen makes, so a test can assert what it sent. */
let writes: Array<{ url: string; method: string; body: unknown }> = [];

/** Route every read the screen makes; `overrides` replaces one route's answer. */
function routeFetch(overrides: Partial<Record<string, () => Response>> = {}) {
  global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method !== 'GET') {
      writes.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.includes('/notes')) return jsonResponse({ success: true });
      if (method === 'DELETE') {
        return jsonResponse({ success: true, removed_versions: 5, removed_jobs: 72, purged_credentials: true });
      }
      return jsonResponse(endpointPayload());
    }
    if (url.includes('/notes')) return (overrides.notes ?? (() => jsonResponse(notesPayload())))();
    if (url.includes('/versions/compare')) return (overrides.compare ?? (() => jsonResponse(comparePayload())))();
    if (url.includes('/lint')) return (overrides.lint ?? (() => jsonResponse(lintPayload())))();
    if (/\/versions\/[^/?]+$/.test(url)) return (overrides.version ?? (() => jsonResponse(versionPayload())))();
    if (url.includes('/versions')) return (overrides.versions ?? (() => jsonResponse(versionsPayload())))();
    if (url.includes('/trust-posture')) return (overrides.posture ?? (() => jsonResponse({ success: false })))();
    if (/\/api\/mcp\/endpoints\/[^/?]+$/.test(url)) {
      return (overrides.endpoint ?? (() => jsonResponse(endpointPayload())))();
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

/** Render the screen and wait for its first paint. */
async function renderScreen() {
  render(<McpEndpointDetailClient endpointId={ENDPOINT_ID} />);
  await waitFor(() =>
    expect(screen.getByRole('heading', { level: 1, name: /Payments tools/ })).toBeInTheDocument(),
  );
}

/** Switch the outer tab strip. */
async function openTab(name: string | RegExp) {
  await userEvent.click(screen.getByRole('tab', { name }));
}

beforeEach(() => {
  writes = [];
  routeFetch();
});

afterEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------------------
// 1. The header the screen used to draw for itself
// ---------------------------------------------------------------------------------------

describe('the page header', () => {
  it('is the shell’s header — a breadcrumb, one h1, and no <main> of its own', async () => {
    await renderScreen();

    // The trail replaces the "← Back to MCP Catalog" link the screen drew.
    const crumbs = screen.getByTestId('page-breadcrumb');
    expect(within(crumbs).getByRole('link', { name: 'MCP servers' })).toHaveAttribute(
      'href',
      '/ade/dashboard/mcp',
    );
    expect(within(crumbs).getByText('Payments tools')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /back to mcp catalog/i })).not.toBeInTheDocument();

    // Exactly one `h1`, and no `<main>`: the shell already draws that landmark.
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.queryByRole('main')).not.toBeInTheDocument();
  });

  it('keeps the meta row 1:1 with the mockup — URL, transport, visibility, recency, state', async () => {
    await renderScreen();

    const header = screen.getByTestId('page-header');
    expect(within(header).getByText('https://mcp.acme.dev/payments/mcp')).toBeInTheDocument();
    expect(within(header).getByText('streamable_http')).toBeInTheDocument();
    expect(within(header).getByText('Public')).toBeInTheDocument();
    expect(within(header).getByText(/Last discovered/)).toBeInTheDocument();
    expect(within(header).getByText('Enabled')).toBeInTheDocument();
    expect(within(header).getByText('Published')).toBeInTheDocument();
  });

  it('carries the grade beside the title once the lint report lands', async () => {
    await renderScreen();
    await waitFor(() =>
      expect(screen.getByRole('img', { name: 'Grade A, score 94 of 100' })).toBeInTheDocument(),
    );
  });

  it('gives the screen one primary action, and disables all three while any is in flight', async () => {
    await renderScreen();

    const actions = screen.getByTestId('page-header-actions');
    const rediscover = within(actions).getByRole('button', { name: /Re-discover/ });
    const publish = within(actions).getByRole('button', { name: /Unpublish/ });
    const enable = within(actions).getByRole('button', { name: /Disable/ });

    // Publishing writes `published` *and* `visibility` together — the public catalog needs both.
    await userEvent.click(publish);
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].method).toBe('PATCH');
    expect(writes[0].body).toEqual({ published: false, visibility: 'private' });

    expect(rediscover).toBeInTheDocument();
    expect(enable).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------
// 2. The summary strip and the cataloger commentary
// ---------------------------------------------------------------------------------------

describe('the summary strip', () => {
  it('is the metrics set’s four tiles, not four hand-rolled panels', async () => {
    await renderScreen();

    const strip = screen.getByTestId('mcp-endpoint-summary');
    for (const label of ['Quality grade', 'Current version', 'Server', 'Last discovered']) {
      expect(within(strip).getByText(label)).toBeInTheDocument();
    }
    // The figures the mockup prints: the sequence leads, the release tag sits under it.
    expect(within(strip).getByText('v5')).toBeInTheDocument();
    expect(within(strip).getByText('2026.08.15-a')).toBeInTheDocument();
    expect(within(strip).getByText('Acme Payments MCP')).toBeInTheDocument();
    expect(within(strip).getByText('MCP protocol 2025-06-18')).toBeInTheDocument();
    await waitFor(() => expect(within(strip).getByText('94')).toBeInTheDocument());
    expect(within(strip).getByText('0 MUST')).toBeInTheDocument();
    expect(within(strip).getByText('1 SHOULD')).toBeInTheDocument();
  });
});

describe('the cataloger commentary', () => {
  it('is the one honey panel on the route, and says what it is', async () => {
    await renderScreen();

    const notes = await screen.findByTestId('mcp-endpoint-notes');
    expect(within(notes).getByText('Cataloger commentary')).toBeInTheDocument();
    expect(within(notes).getByText(MCP_NOTES_SUBTITLE)).toBeInTheDocument();
    await waitFor(() =>
      expect(within(notes).getByText('Prefer the staging endpoint for QA.')).toBeInTheDocument(),
    );
    expect(within(notes).getByText(/Grace Hopper/)).toBeInTheDocument();
  });

  it('keeps its CRUD: an inline composer, an edit in place, and a delete', async () => {
    await renderScreen();
    const notes = await screen.findByTestId('mcp-endpoint-notes');
    await waitFor(() =>
      expect(within(notes).getByText('Prefer the staging endpoint for QA.')).toBeInTheDocument(),
    );

    // Create.
    await userEvent.click(within(notes).getByTestId('mcp-endpoint-note-add'));
    const composer = within(notes).getByLabelText('Add a note');
    const save = within(notes).getByRole('button', { name: 'Save note' });
    expect(save).toBeDisabled();
    await userEvent.type(composer, 'Rate limit is 60 req/min.');
    expect(save).toBeEnabled();
    await userEvent.click(save);
    await waitFor(() => expect(writes.some((w) => w.method === 'POST')).toBe(true));
    expect(writes.find((w) => w.method === 'POST')?.body).toEqual({
      body: 'Rate limit is 60 req/min.',
    });

    // Edit and delete are on every note.
    expect(within(notes).getByRole('button', { name: 'Edit note' })).toBeInTheDocument();
    await userEvent.click(within(notes).getByRole('button', { name: 'Delete note' }));
    await waitFor(() => expect(writes.some((w) => w.method === 'DELETE')).toBe(true));
  });
});

// ---------------------------------------------------------------------------------------
// 3. The tab strip
// ---------------------------------------------------------------------------------------

describe('the tab strip', () => {
  it('is in the page header, in the mockup’s order, with the proposed tab last', async () => {
    await renderScreen();

    const header = screen.getByTestId('page-header');
    const strip = within(header).getByTestId('mcp-endpoint-tabs');
    expect(
      within(strip)
        .getAllByRole('tab')
        .map((tab) => (tab.textContent ?? '').replace(MCP_ENDPOINT_PROPOSED_LABEL, '').trim()),
    ).toEqual([
      'Capabilities4',
      'Insight',
      'Versions',
      'Lint & score',
      'Settings',
      'Trust posture',
    ]);

    // The proposal is marked as one, on the screen rather than in a roadmap.
    const trust = within(strip).getByTestId('mcp-endpoint-tab-trust');
    expect(within(trust).getByText(MCP_ENDPOINT_PROPOSED_LABEL)).toBeInTheDocument();
  });

  it('mounts one panel at a time, and points each at its own tab', async () => {
    await renderScreen();

    expect(screen.getByTestId('mcp-endpoint-panel-capabilities')).toBeInTheDocument();
    expect(screen.queryByTestId('insight-stub')).not.toBeInTheDocument();

    await openTab('Insight');
    expect(screen.getByTestId('insight-stub')).toBeInTheDocument();
    expect(screen.queryByTestId('mcp-endpoint-panel-capabilities')).not.toBeInTheDocument();

    const panel = screen.getByTestId('mcp-endpoint-panel-insight');
    expect(panel).toHaveAttribute('aria-labelledby', 'mcp-endpoint-tab-insight');
    expect(screen.getByTestId('mcp-endpoint-tab-insight')).toHaveAttribute(
      'aria-controls',
      'mcp-endpoint-panel-insight',
    );
  });

  it('is arrow-navigable, with one tab stop for the whole strip', async () => {
    await renderScreen();

    const capabilities = screen.getByTestId('mcp-endpoint-tab-capabilities');
    expect(capabilities).toHaveAttribute('tabindex', '0');
    expect(screen.getByTestId('mcp-endpoint-tab-insight')).toHaveAttribute('tabindex', '-1');

    fireEvent.keyDown(capabilities, { key: 'ArrowRight' });
    expect(screen.getByTestId('mcp-endpoint-tab-insight')).toHaveAttribute('aria-selected', 'true');

    // End jumps to the proposal, Home comes back, and the arrows wrap at both ends.
    fireEvent.keyDown(screen.getByTestId('mcp-endpoint-tab-insight'), { key: 'End' });
    expect(screen.getByTestId('mcp-endpoint-tab-trust')).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(screen.getByTestId('mcp-endpoint-tab-trust'), { key: 'Home' });
    expect(capabilities).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(capabilities, { key: 'ArrowLeft' });
    expect(screen.getByTestId('mcp-endpoint-tab-trust')).toHaveAttribute('aria-selected', 'true');
  });
});

// ---------------------------------------------------------------------------------------
// 4. Capabilities
// ---------------------------------------------------------------------------------------

describe('the Capabilities panel', () => {
  it('leads with the server instructions and groups the surface by kind', async () => {
    await renderScreen();

    expect(screen.getByText('Instructions')).toBeInTheDocument();
    expect(
      screen.getByText('Use `payments.search` before `payments.refund`.'),
    ).toBeInTheDocument();

    const tools = screen.getByTestId('mcp-capability-group-tool');
    expect(within(tools).getByText('Tools')).toBeInTheDocument();
    expect(within(tools).getByText('Search payments')).toBeInTheDocument();
    expect(within(tools).getByText('payments.search')).toBeInTheDocument();
    // Only *asserted* hints get a chip, and a declared lifecycle earns its own.
    expect(within(tools).getByText('readOnly')).toBeInTheDocument();
    expect(within(tools).getByText('idempotent')).toBeInTheDocument();
    expect(within(tools).getByText('destructive')).toBeInTheDocument();
    expect(within(tools).getByText('stable (declared)')).toBeInTheDocument();

    // The three smaller kinds sit beside each other, as the mockup's two-column block draws them.
    expect(screen.getByTestId('mcp-capability-group-resource')).toBeInTheDocument();
    expect(screen.getByTestId('mcp-capability-group-prompt')).toBeInTheDocument();
  });

  it('keeps the deep-link anchor ids a lint finding points at', async () => {
    await renderScreen();

    // `mcpCapabilityAnchorId` folds anything outside `[A-Za-z0-9_-]` to a dash, so a dotted tool
    // name and a URI both produce an id an `#anchor` can actually address.
    expect(document.getElementById(mcpCapabilityAnchorId('tool', 'payments.search'))).not.toBeNull();
    expect(document.getElementById('mcp-cap-tool-payments-search')).not.toBeNull();
    expect(document.getElementById('mcp-cap-resource-merchant-profile')).not.toBeNull();
  });

  it('follows a lint finding back to its capability, and says which one it landed on', async () => {
    await renderScreen();

    await openTab(/Lint & score/);
    const finding = await screen.findByRole('button', { name: /tools\.payments\.refund/ });
    await userEvent.click(finding);

    // The strip switches back to Capabilities and the item wears the deep-link ring.
    await waitFor(() =>
      expect(screen.getByTestId('mcp-endpoint-tab-capabilities')).toHaveAttribute(
        'aria-selected',
        'true',
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByTestId('mcp-capability-tool-payments.refund'),
      ).toHaveAttribute('aria-current', 'location'),
    );
  });

  it('offers discovery from the never-discovered state rather than only describing it', async () => {
    routeFetch({ endpoint: () => jsonResponse(endpointPayload({ current_version_id: null })) });
    await renderScreen();

    const empty = await screen.findByTestId('mcp-endpoint-undiscovered');
    expect(within(empty).getByText('Not yet discovered')).toBeInTheDocument();
    expect(within(empty).getByRole('button', { name: /Re-discover/ })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------
// 5. Versions — the second acceptance criterion
// ---------------------------------------------------------------------------------------

describe('the Versions panel', () => {
  it('offers both diff layouts, side-by-side selected first', async () => {
    await renderScreen();
    await openTab(/Versions/);

    const layout = await screen.findByTestId('mcp-diff-layout');
    expect(layout).toHaveAttribute('role', 'radiogroup');
    expect(layout).toHaveAccessibleName('Diff layout');
    const [split, unified] = within(layout).getAllByRole('radio');
    expect(split).toHaveTextContent('Side-by-side');
    expect(unified).toHaveTextContent('Unified');
    expect(split).toHaveAttribute('aria-checked', 'true');

    await userEvent.click(unified);
    await waitFor(() => expect(unified).toHaveAttribute('aria-checked', 'true'));
    // The choice is remembered across visits.
    expect(window.localStorage.getItem('mcp-versions-diff-mode')).toBe('unified');
  });

  it('opens on the two newest snapshots and states what changed', async () => {
    await renderScreen();
    await openTab(/Versions/);

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'v4 → v5' })).toBeInTheDocument(),
    );
    expect(screen.getByText('~1 modified')).toBeInTheDocument();
    expect(screen.getByTestId('mcp-change-tool-payments.refund')).toBeInTheDocument();

    // Both snapshots are ticked into the compare selection.
    expect(screen.getByTestId(`mcp-version-row-${V5}`)).toHaveAttribute('data-selected', '');
    expect(screen.getByTestId(`mcp-version-row-${V4}`)).toHaveAttribute('data-selected', '');
  });
});

// ---------------------------------------------------------------------------------------
// 6. Settings — the third acceptance criterion
// ---------------------------------------------------------------------------------------

describe('the Settings panel', () => {
  it('keeps the typed-DELETE confirmation exactly as it was', async () => {
    await renderScreen();
    await openTab('Settings');

    await userEvent.click(await screen.findByRole('button', { name: /Delete endpoint/ }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/Delete “Payments tools”\?/)).toBeInTheDocument();
    // The dialog names the cascade rather than saying "are you sure".
    expect(within(dialog).getByText(/versions/)).toBeInTheDocument();
    expect(within(dialog).getByText(/discovery jobs/)).toBeInTheDocument();
    expect(within(dialog).getByText(/credentials/)).toBeInTheDocument();

    const confirm = within(dialog).getByRole('button', { name: /Delete endpoint/ });
    const input = within(dialog).getByLabelText(/to confirm/i);
    expect(confirm).toBeDisabled();

    // Case-sensitive: the near-miss does not unlock it.
    await userEvent.type(input, MCP_DELETE_CONFIRM_WORD.toLowerCase());
    expect(confirm).toBeDisabled();

    await userEvent.clear(input);
    await userEvent.type(input, MCP_DELETE_CONFIRM_WORD);
    expect(confirm).toBeEnabled();

    await userEvent.click(confirm);
    await waitFor(() => expect(writes.some((w) => w.method === 'DELETE')).toBe(true));
    // And the screen returns to the catalog with the teardown summary.
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/ade/dashboard/mcp'));
  });

  it('marks unsaved changes, and sends only the fields that actually changed', async () => {
    await renderScreen();
    await openTab('Settings');

    const name = await screen.findByLabelText(/^Name/);
    expect(screen.queryByTestId('mcp-settings-dirty')).not.toBeInTheDocument();

    await userEvent.clear(name);
    await userEvent.type(name, 'Payments tools (prod)');
    expect(screen.getByTestId('mcp-settings-dirty')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Save changes/ }));
    await waitFor(() => expect(writes.some((w) => w.method === 'PATCH')).toBe(true));
    expect(writes.find((w) => w.method === 'PATCH')?.body).toEqual({
      name: 'Payments tools (prod)',
    });
  });

  it('states a validation failure in words, with the glyph as emphasis', async () => {
    await renderScreen();
    await openTab('Settings');

    const url = await screen.findByLabelText(/Endpoint URL/);
    await userEvent.clear(url);
    await userEvent.type(url, 'not-a-url');
    await userEvent.click(screen.getByRole('button', { name: /Save changes/ }));

    const error = await screen.findByTestId('mcp-settings-error');
    expect(error).toHaveAttribute('role', 'alert');
    expect(error).toHaveTextContent(/valid URL/i);
    expect(writes.filter((w) => w.method === 'PATCH')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------
// 7. Trust posture — the tab the mockup adds
// ---------------------------------------------------------------------------------------

describe('the proposed Trust posture tab', () => {
  it('mounts the panel that had no route, and reports honestly when it cannot load', async () => {
    await renderScreen();
    await openTab(/Trust posture/);

    // The report read is made — the panel is genuinely mounted, not stubbed out.
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/trust-posture'),
        expect.anything(),
      ),
    );
  });

  it('explains itself rather than erroring when there is no snapshot to assess', async () => {
    routeFetch({ endpoint: () => jsonResponse(endpointPayload({ current_version_id: null })) });
    await renderScreen();
    await openTab(/Trust posture/);

    const empty = await screen.findByTestId('mcp-endpoint-trust-undiscovered');
    expect(within(empty).getByText('No snapshot to assess')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------
// 8. The fourth acceptance criterion: the two tab groups are independent
// ---------------------------------------------------------------------------------------

describe('the nested tab groups', () => {
  it('leaves the outer strip alone when an Insight view is chosen, and vice versa', async () => {
    // Unmock the Insight tab for this one assertion: the point *is* the nesting.
    jest.unmock('@/app/ade/dashboard/mcp/[endpointId]/McpEndpointInsight');

    await renderScreen();
    await openTab('Insight');

    // The outer strip is on Insight and its panel is mounted…
    expect(screen.getByTestId('mcp-endpoint-tab-insight')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // …and switching back and forth on the outer strip does not leave the inner one behind.
    await openTab(/Versions/);
    expect(screen.getByTestId('mcp-endpoint-tab-versions')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.queryByTestId('insight-stub')).not.toBeInTheDocument();

    await openTab('Insight');
    expect(screen.getByTestId('insight-stub')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------
// 9. States
// ---------------------------------------------------------------------------------------

describe('the screen’s three states', () => {
  it('draws a skeleton shaped like the content, not a spinner in a box', async () => {
    let resolve: ((value: Response) => void) | null = null;
    global.fetch = jest.fn(
      () => new Promise<Response>((r) => {
        resolve = r;
      }),
    ) as unknown as typeof fetch;

    render(<McpEndpointDetailClient endpointId={ENDPOINT_ID} />);
    const skeleton = await screen.findByTestId('mcp-endpoint-skeleton');
    expect(skeleton).toHaveAttribute('aria-busy', 'true');
    expect(within(skeleton).getByRole('status')).toHaveTextContent('Loading endpoint…');

    resolve?.(jsonResponse(endpointPayload()));
  });

  it('offers a retry when the endpoint cannot be read', async () => {
    routeFetch({ endpoint: () => jsonResponse({ error: 'Endpoint not found' }, false, 404) });

    render(<McpEndpointDetailClient endpointId={ENDPOINT_ID} />);
    const error = await screen.findByTestId('mcp-endpoint-error');
    expect(within(error).getByText('Endpoint unavailable')).toBeInTheDocument();
    expect(within(error).getByText('Endpoint not found')).toBeInTheDocument();
    expect(within(error).getByRole('button', { name: /try again|retry/i })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------
// 10. Browser fixtures
// ---------------------------------------------------------------------------------------

/**
 * The markup `e2e/hive-mcp-endpoint.spec.ts` measures.
 *
 * Rather than hand-writing HTML files that would drift the first time a class changed, the
 * browser suite measures what *this* suite rendered. The block below renders each surface and
 * writes what it rendered into `e2e/fixtures/hive-mcp-endpoint/` when `MCP_FIXTURE_DUMP=1` is
 * set:
 *
 *     MCP_FIXTURE_DUMP=1 npx jest -c jest.config.ts \
 *       tests/mcp-endpoint-detail-hive-redesign.test.tsx -t fixtures
 *
 * Without the variable the tests still run — they render every surface and check each is there —
 * so a change that would leave the fixtures stale fails loudly here before it fails quietly in
 * the browser.
 */
describe('the browser fixtures', () => {
  const OUT = path.join(__dirname, '..', 'e2e', 'fixtures', 'hive-mcp-endpoint');
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
  const pageColumn = () => serialize(document.querySelector('.page') as HTMLElement);

  test('renders the capabilities surface (and writes its fixture on request)', async () => {
    await renderScreen();
    await screen.findByTestId('mcp-endpoint-notes');
    await waitFor(() =>
      expect(screen.getByTestId('mcp-capability-group-prompt')).toBeInTheDocument(),
    );
    write('capabilities', pageColumn());
  });

  test('renders the versions surface (and writes its fixture)', async () => {
    await renderScreen();
    await openTab(/Versions/);
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'v4 → v5' })).toBeInTheDocument(),
    );
    write('versions', pageColumn());
  });

  test('renders the lint surface (and writes its fixture)', async () => {
    await renderScreen();
    await openTab(/Lint & score/);
    await screen.findByTestId('mcp-lint-findings');
    write('lint', pageColumn());
  });

  test('renders the settings surface (and writes its fixture)', async () => {
    await renderScreen();
    await openTab('Settings');
    await screen.findByTestId('mcp-settings-danger');
    write('settings', pageColumn());
  });
});
