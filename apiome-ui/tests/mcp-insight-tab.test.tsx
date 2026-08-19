/**
 * Render/interaction tests for the MCP endpoint-detail "Insight" tab (V2-MCP-28.4 / MCAT-14.4).
 *
 * Covers the scaffold's contract: lazy data fetch (versions + surface) on mount, the never-discovered
 * empty state, a surface-fetch error state, the live baseline rendered from the 14.2 metrics, the
 * version selector re-fetching insight for a different snapshot, and the "changed since last view"
 * digest (MCAT-16.5) rendering + advancing the seen-marker.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

import McpEndpointInsight from '../src/app/ade/dashboard/mcp/[endpointId]/McpEndpointInsight';

const ENDPOINT_ID = '11111111-1111-4111-8111-111111111111';
const V3 = '33333333-3333-4333-8333-333333333333';
const V2 = '22222222-2222-4222-8222-222222222222';

/** Two-snapshot version-history payload (newest first), v3 current. */
function versionsPayload() {
  return {
    success: true,
    versions: [
      {
        id: V3,
        endpoint_id: ENDPOINT_ID,
        version_seq: 3,
        version_tag: '2026-07-06',
        is_current: true,
        server_name: 'acme-search',
        server_title: 'Acme Search',
        server_version: '1.4.0',
        protocol_version: '2025-06-18',
        score: 90,
        grade: 'A',
        change_counts: { added: 1, removed: 0, modified: 0 },
      },
      {
        id: V2,
        endpoint_id: ENDPOINT_ID,
        version_seq: 2,
        version_tag: '2026-06-01',
        is_current: false,
        server_name: 'acme-search',
        server_title: 'Acme Search',
        server_version: '1.3.0',
        protocol_version: '2025-03-26',
        score: 80,
        grade: 'B',
        change_counts: { added: 2, removed: 1, modified: 0 },
      },
    ],
  };
}

/** A minimal endpoint record as threaded from the detail page for the profile-card header. */
function endpointRecord() {
  return {
    id: ENDPOINT_ID,
    name: 'acme-search-prod',
    slug: 'acme',
    endpoint_url: 'https://mcp.acme.dev/search',
    transport: 'streamable_http',
    description: null,
    category: null,
    visibility: 'public',
    published: true,
    enabled: true,
    discovery_cadence_seconds: null,
    current_version_id: V3,
    last_discovered_at: '2026-07-06T10:00:00Z',
    last_discovery_status: 'changed',
  };
}

/** A surface payload with the given tool count, so different snapshots render distinguishably. */
function surfacePayload(versionId: string, versionSeq: number, tools: number) {
  return {
    success: true,
    endpoint_id: ENDPOINT_ID,
    version_id: versionId,
    version_seq: versionSeq,
    version_tag: null,
    is_current: versionSeq === 3,
    metrics: {
      type_counts: {
        tools,
        resources: 2,
        resource_templates: 0,
        prompts: 1,
        total: tools + 3,
      },
      tool_complexity: [],
      output_schema_count: tools,
      annotation_coverage: {
        tool_count: tools,
        annotated_tools: tools,
        read_only_hint: tools,
        destructive_hint: 0,
        idempotent_hint: 0,
        open_world_hint: 0,
      },
      documentation_coverage: {
        item_count: tools + 3,
        described_items: tools + 3,
        titled_items: tools,
        description_pct: 100,
        title_pct: 60,
        tool_param_count: 4,
        documented_tool_params: 4,
        tool_param_description_pct: 100,
      },
      metrics_fingerprint: `fp-${versionSeq}`,
    },
  };
}

/**
 * Match the baseline headline span whose (whitespace-normalized) text is exactly
 * "<total> capabilities in this snapshot" — the number and phrase live in separate text nodes, so a
 * plain string/regex matcher can't span them.
 */
function headlineMatcher(total: number) {
  return (_content: string, el: Element | null) =>
    !!el &&
    el.tagName === 'SPAN' &&
    (el.textContent ?? '').replace(/\s+/g, ' ').trim() === `${total} capabilities in this snapshot`;
}

/** Switch the left-nav insight view. Radix hides inactive panels, so assertions must open the target view first. */
async function openInsightView(label: string) {
  await userEvent.click(screen.getByRole('tab', { name: label }));
}

/**
 * Pick a snapshot from the version selector.
 *
 * The selector was a native `<select>` until HIVE-7.8 (#5325) and is `ui/Select` now, which is
 * Radix — so it is a `combobox` button rather than a form control, and it opens on `pointerdown`
 * (which jsdom does not synthesise) or on Enter. Driving it by keyboard is what works in jsdom
 * and is also the path a keyboard user takes.
 *
 * @param optionName Accessible name of the option to choose, as a substring or a matcher.
 */
async function pickSnapshot(optionName: RegExp) {
  const trigger = screen.getByLabelText('Snapshot');
  fireEvent.keyDown(trigger, { key: 'Enter' });
  const option = await screen.findByRole('option', { name: optionName });
  await userEvent.click(option);
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => body,
  } as Response;
}

/** A version-detail payload carrying the given capability items, for the safety panel (MCAT-15.4). */
function detailPayload(versionId: string, items: Array<Record<string, unknown>>) {
  return {
    success: true,
    version: {
      id: versionId,
      version_seq: 3,
      version_tag: '2026-07-06',
      server_name: 'acme-search',
      server_version: '1.4.0',
      server_title: 'Acme Search',
      protocol_version: '2025-06-18',
      instructions: null,
      score: 90,
      grade: 'A',
      is_current: true,
      discovered_at: '2026-07-06T10:00:00Z',
      items,
    },
  };
}

/** A two-point evolution series (oldest first) for the churn timeline (MCAT-16.1). */
function evolutionPayload() {
  return {
    success: true,
    endpoint_id: ENDPOINT_ID,
    series: [
      {
        version_id: V2,
        version_seq: 2,
        version_tag: '2026-06-01',
        discovered_at: '2026-06-01T10:00:00Z',
        is_current: false,
        type_counts: { tools: 3, resources: 2, resource_templates: 0, prompts: 1, total: 6 },
        score: 80,
        grade: 'B',
        change_counts: { added: 2, removed: 1, modified: 0, total: 3 },
        severity_counts: { breaking: 1, additive: 2, review: 0, total: 3 },
      },
      {
        version_id: V3,
        version_seq: 3,
        version_tag: '2026-07-06',
        discovered_at: '2026-07-06T10:00:00Z',
        is_current: true,
        type_counts: { tools: 4, resources: 2, resource_templates: 0, prompts: 1, total: 7 },
        score: 90,
        grade: 'A',
        change_counts: { added: 1, removed: 0, modified: 3, total: 4 },
        severity_counts: { breaking: 0, additive: 4, review: 0, total: 4 },
      },
    ],
  };
}

/** A redacted credential-status payload with the given `auth_type` (MCAT-15.4 auth cross-reference). */
function credentialsPayload(authType: string) {
  return {
    success: true,
    credential: {
      endpoint_id: ENDPOINT_ID,
      auth_type: authType,
      configured: authType !== 'none',
    },
  };
}

/**
 * Route the mocked `fetch` by URL so each lazy request resolves independently regardless of call
 * order. Beyond `versions` + `surface`, the safety panel (MCAT-15.4) also fetches the version
 * *detail* (`/versions/{id}`) and the endpoint's redacted `credentials` status; both default to an
 * empty/anonymous shape so scaffold tests need not care about them.
 */
function routeFetch(handlers: {
  versions: () => Response;
  surface: (versionId: string | null) => Response;
  graph?: (versionId: string | null) => Response;
  detail?: (versionId: string) => Response;
  credentials?: () => Response;
  evolution?: () => Response;
  digest?: () => Response;
  views?: () => Response;
  reliability?: () => Response;
  lint?: (versionId: string) => Response;
  trust?: () => Response;
  percentile?: () => Response;
}) {
  (global.fetch as jest.Mock).mockImplementation(async (url: string) => {
    if (url.includes('/insight/percentile')) {
      const gap = (key: string, label: string) => ({
        key,
        label,
        percentile: null,
        available: false,
        detail: 'Not enough peers yet',
        methodology: `How ${label} is ranked.`,
      });
      return handlers.percentile
        ? handlers.percentile()
        : jsonResponse({
            success: true,
            endpoint_id: ENDPOINT_ID,
            category: null,
            profile: {
              axes: [
                gap('grade', 'Grade'),
                gap('safety', 'Safety'),
                gap('documentation', 'Documentation'),
                gap('latency', 'Latency'),
              ],
              available_count: 0,
              axis_count: 4,
              peer_count: 0,
            },
          });
    }
    if (url.includes('/insight/trust')) {
      // The composite trust profile (MCAT-17.4) loads endpoint-level; default to an all-gap profile
      // so tests that don't care about it render the panel's "not enough signal yet" empty state.
      const gap = (key: string, label: string) => ({
        key,
        label,
        value: null,
        available: false,
        detail: 'Not measured',
        methodology: `How ${label} is computed.`,
      });
      return handlers.trust
        ? handlers.trust()
        : jsonResponse({
            success: true,
            endpoint_id: ENDPOINT_ID,
            version_id: V3,
            auth_type: 'none',
            profile: {
              axes: [
                gap('quality', 'Quality'),
                gap('safety', 'Safety'),
                gap('documentation', 'Documentation'),
                gap('stability', 'Stability'),
                gap('responsiveness', 'Responsiveness'),
              ],
              overall: null,
              available_count: 0,
              axis_count: 5,
            },
          });
    }
    if (url.includes('/insight/digest')) {
      // The "changed since last view" digest (MCAT-16.5) loads per-user; default to an up-to-date
      // digest so tests that don't care about it render the calm "up to date" state.
      return handlers.digest
        ? handlers.digest()
        : jsonResponse({
            success: true,
            endpoint_id: ENDPOINT_ID,
            new_to_you: false,
            has_changes: false,
            last_seen_version_id: V3,
            last_seen_version_seq: 3,
            last_seen_at: '2026-07-06T10:00:00Z',
            current_version_id: V3,
            current_version_seq: 3,
            current_version_tag: '2026-07-06',
            current_type_counts: { tools: 4, resources: 2, resource_templates: 0, prompts: 1, total: 7 },
            change_counts: { added: 0, removed: 0, modified: 0, total: 0 },
            severity_counts: { breaking: 0, additive: 0, review: 0, total: 0 },
            changes: [],
          });
    }
    if (url.includes('/views')) {
      // Recording a view advances the seen-marker (MCAT-16.5); default to a benign success.
      return handlers.views
        ? handlers.views()
        : jsonResponse({
            success: true,
            endpoint_id: ENDPOINT_ID,
            last_seen_version_id: V3,
            seen_at: '2026-07-06T10:00:00Z',
          });
    }
    if (url.includes('/insight/reliability')) {
      // The discovery health timeline (MCAT-17.1) loads endpoint-level; default to an empty history
      // so tests that don't care about it render the panel's "no history yet" state.
      return handlers.reliability
        ? handlers.reliability()
        : jsonResponse({
            success: true,
            endpoint_id: ENDPOINT_ID,
            discovery: {
              job_count: 0,
              completed_count: 0,
              failed_count: 0,
              running_count: 0,
              queued_count: 0,
              success_rate: 0,
              latency: { count: 0 },
            },
            invocation: {
              call_count: 0,
              error_count: 0,
              success_count: 0,
              error_rate: 0,
              latency: { count: 0 },
            },
            health: { timeline: [], window: 50 },
            tools: {
              tools: [],
              tool_count: 0,
              call_count: 0,
              error_count: 0,
              success_count: 0,
              error_rate: 0,
              latency_distribution: [],
              window_days: 30,
            },
          });
    }
    if (url.includes('/insight/evolution')) {
      // The churn timeline (MCAT-16.1) loads the whole per-version series; default to empty so tests
      // that don't care about evolution render its "no history" state rather than erroring.
      return handlers.evolution
        ? handlers.evolution()
        : jsonResponse({ success: true, endpoint_id: ENDPOINT_ID, series: [] });
    }
    if (url.includes('/insight/graph')) {
      const versionId = new URL(url, 'http://test').searchParams.get('version_id');
      // The capability graph (MCAT-15.2) loads in parallel with the surface; default to an empty graph
      // so the scaffold assertions stay focused on the surface baseline unless a test opts in.
      return handlers.graph
        ? handlers.graph(versionId)
        : jsonResponse({
            success: true,
            endpoint_id: ENDPOINT_ID,
            version_id: versionId ?? V3,
            version_seq: 3,
            version_tag: '2026-07-06',
            is_current: true,
            graph: {
              nodes: [],
              edges: [],
              node_count: 0,
              edge_count: 0,
              isolated_count: 0,
              graph_fingerprint: 'empty',
            },
          });
    }
    if (url.includes('/insight/surface')) {
      const versionId = new URL(url, 'http://test').searchParams.get('version_id');
      return handlers.surface(versionId);
    }
    if (url.includes('/credentials')) {
      // Auth is endpoint-level; default to anonymous so a destructive tool with no auth would flag.
      return handlers.credentials ? handlers.credentials() : jsonResponse(credentialsPayload('none'));
    }
    if (url.includes('/lint')) {
      // Version lint report (`/versions/{id}/lint`) — the score-breakdown panel (MCAT-17.3). Default
      // to a clean, fully-scored report so tests that don't care render its "clean bill" state.
      const versionId = url.split('/versions/')[1].split('/')[0];
      return handlers.lint
        ? handlers.lint(versionId)
        : jsonResponse({
            success: true,
            endpointId: ENDPOINT_ID,
            versionId,
            versionSeq: 3,
            versionTag: '2026-07-06',
            score: 100,
            grade: 'A',
            findings: [],
            ruleHits: {},
            severityCounts: { error: 0, warning: 0, info: 0 },
            reportFingerprint: 'clean',
            source: 'stored',
            scoredAt: '2026-07-06T00:00:00Z',
          });
    }
    if (url.includes('/versions/')) {
      // Version *detail* (`/versions/{id}`) — the safety panel's per-tool items. Default: no items.
      const versionId = url.split('/versions/')[1].split('?')[0];
      return handlers.detail ? handlers.detail(versionId) : jsonResponse(detailPayload(versionId, []));
    }
    if (url.includes('/versions')) {
      return handlers.versions();
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

beforeEach(() => {
  global.fetch = jest.fn();
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('McpEndpointInsight — scaffold', () => {
  it('lazy-loads versions + surface and renders the capability baseline', async () => {
    routeFetch({
      versions: () => jsonResponse(versionsPayload()),
      surface: (vid) => jsonResponse(surfacePayload(vid ?? V3, 3, 4)),
    });

    render(<McpEndpointInsight endpointId={ENDPOINT_ID} currentVersionId={V3} />);

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Capability counts' })).toBeInTheDocument(),
    );
    await openInsightView('Capability counts');

    // Baseline headline reflects the current snapshot's total (4 tools + 2 resources + 1 prompt = 7).
    await waitFor(() =>
      expect(screen.getByText(headlineMatcher(7))).toBeInTheDocument(),
    );

    // The left-nav exposes every insight view, grouped by the roadmap arc.
    expect(screen.getByRole('tab', { name: 'Capability counts' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Churn timeline' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Trust profile' })).toBeInTheDocument();

    // Every section is now filled with live panels — no reserved "Coming soon" placeholders remain.
    expect(screen.queryByText('Coming soon')).not.toBeInTheDocument();
    await openInsightView('Trust profile');
    await waitFor(() =>
      expect(screen.getByText('Composite trust profile')).toBeInTheDocument(),
    );

    // Surface was fetched for the current version by default.
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/insight/surface?version_id=${V3}`),
      expect.anything(),
    );
  });

  /**
   * The ticket's first acceptance criterion: **all 14 insight views render**.
   *
   * The rail's fourteen entries, in the four groups the roadmap arc gives them, each mounting a
   * panel of its own when selected — asserted as a set rather than one by one, so a view that is
   * *added* or *dropped* fails here instead of quietly changing what "all fourteen" means.
   * Whether each panel then draws the right chart is its own suite's job (there are fourteen of
   * them); this pins the rail and the mounting.
   */
  it('exposes all fourteen insight views, and mounts one panel at a time (HIVE-7.8)', async () => {
    routeFetch({
      versions: () => jsonResponse(versionsPayload()),
      surface: (vid) => jsonResponse(surfacePayload(vid ?? V3, 3, 4)),
    });

    render(
      <McpEndpointInsight
        endpointId={ENDPOINT_ID}
        currentVersionId={V3}
        endpoint={endpointRecord()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Overview' })).toBeInTheDocument(),
    );

    const rail = screen.getByRole('tablist', { name: 'Insight views' });
    const views = within(rail)
      .getAllByRole('tab')
      .map((tab) => (tab.textContent ?? '').trim());

    expect(views).toEqual([
      // Summary
      'Overview',
      // Capability surface
      'Capability counts',
      'Relationship graph',
      'Schema complexity',
      'Safety posture',
      'Documentation',
      // Surface evolution
      'Churn timeline',
      'Lifespan & presence',
      'Grade & size trend',
      // Reliability & trust
      'Discovery health',
      'Tool latency',
      'Score breakdown',
      'Trust profile',
      'Peer ranking',
    ]);
    expect(views).toHaveLength(14);

    // The four group labels the rail files them under.
    for (const group of ['Capability surface', 'Surface evolution', 'Reliability & trust']) {
      expect(within(rail).getByText(group)).toBeInTheDocument();
    }

    // Exactly one panel is mounted at a time — the whole point of the rail, since the alternative
    // is the ~18k-px stack of charts it replaced.
    for (const label of views) {
      await openInsightView(label);
      expect(
        within(rail)
          .getAllByRole('tab')
          .filter((tab) => tab.getAttribute('data-state') === 'active')
          .map((tab) => (tab.textContent ?? '').trim()),
      ).toEqual([label]);
    }
  });

  it('shows a helpful empty state for a never-discovered endpoint', async () => {
    routeFetch({
      versions: () => jsonResponse({ success: true, versions: [] }),
      surface: () => jsonResponse({}, false, 404),
    });

    render(<McpEndpointInsight endpointId={ENDPOINT_ID} currentVersionId={null} />);

    await waitFor(() => expect(screen.getByText('No insight yet')).toBeInTheDocument());
    expect(screen.getByText(/never been discovered/i)).toBeInTheDocument();
    // No surface request when there is no snapshot to summarize.
    expect(global.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/insight/surface'),
      expect.anything(),
    );
  });

  it('surfaces an insight-fetch error without blanking the tab', async () => {
    routeFetch({
      versions: () => jsonResponse(versionsPayload()),
      surface: () => jsonResponse({ error: 'metrics engine down' }, false, 502),
    });

    render(<McpEndpointInsight endpointId={ENDPOINT_ID} currentVersionId={V3} />);

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Capability counts' })).toBeInTheDocument(),
    );
    await openInsightView('Capability counts');

    await waitFor(() => expect(screen.getByText('Insight unavailable')).toBeInTheDocument());
    expect(screen.getByText('metrics engine down')).toBeInTheDocument();
    // The nav framework still renders around the error.
    expect(screen.getByRole('tab', { name: 'Capability counts' })).toBeInTheDocument();
  });

  it('renders the server-profile header and shows instructions only for the current snapshot', async () => {
    routeFetch({
      versions: () => jsonResponse(versionsPayload()),
      surface: (vid) =>
        vid === V2 ? jsonResponse(surfacePayload(V2, 2, 9)) : jsonResponse(surfacePayload(V3, 3, 4)),
    });

    render(
      <McpEndpointInsight
        endpointId={ENDPOINT_ID}
        currentVersionId={V3}
        endpoint={endpointRecord()}
        currentInstructions="Use search for queries."
      />,
    );

    // The profile card leads with the server identity from the selected (current) snapshot.
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /Acme Search/ })).toBeInTheDocument(),
    );
    expect(screen.getByText('MCP 2025-06-18')).toBeInTheDocument();
    expect(screen.getByText('streamable_http')).toBeInTheDocument();
    // Instructions render for the current snapshot.
    expect(screen.getByText('Use search for queries.')).toBeInTheDocument();

    // Switching to a historical snapshot drops the (current-only) instructions.
    await pickSnapshot(/v2/);
    await waitFor(() =>
      expect(screen.queryByText('Use search for queries.')).not.toBeInTheDocument(),
    );
    // The older snapshot negotiated the 2025-03-26 protocol.
    expect(screen.getByText('MCP 2025-03-26')).toBeInTheDocument();
  });

  it('re-fetches insight when the version selector changes snapshot', async () => {
    routeFetch({
      versions: () => jsonResponse(versionsPayload()),
      // v3 → 4 tools (total 7); v2 → 9 tools (total 12) so the baseline visibly changes.
      surface: (vid) =>
        vid === V2 ? jsonResponse(surfacePayload(V2, 2, 9)) : jsonResponse(surfacePayload(V3, 3, 4)),
    });

    render(<McpEndpointInsight endpointId={ENDPOINT_ID} currentVersionId={V3} />);

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Capability counts' })).toBeInTheDocument(),
    );
    await openInsightView('Capability counts');

    await waitFor(() =>
      expect(screen.getByText(headlineMatcher(7))).toBeInTheDocument(),
    );

    await pickSnapshot(/v2/);

    // The older snapshot's larger surface (total 12) is fetched and rendered.
    await waitFor(() =>
      expect(screen.getByText(headlineMatcher(12))).toBeInTheDocument(),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/insight/surface?version_id=${V2}`),
      expect.anything(),
    );
  });

  it('renders the tool schema-shape & complexity cards from the surface metrics', async () => {
    const withTools = () => {
      const payload = surfacePayload(V3, 3, 2);
      payload.metrics.tool_complexity = [
        {
          name: 'ping',
          property_count: 0,
          required_count: 0,
          optional_count: 0,
          documented_property_count: 0,
          max_nesting_depth: 0,
          uses_enum: false,
          uses_one_of: false,
          has_output_schema: false,
        },
        {
          name: 'orchestrate',
          property_count: 12,
          required_count: 4,
          optional_count: 8,
          documented_property_count: 6,
          max_nesting_depth: 5,
          uses_enum: true,
          uses_one_of: true,
          has_output_schema: true,
        },
      ];
      return jsonResponse(payload);
    };
    routeFetch({
      versions: () => jsonResponse(versionsPayload()),
      surface: withTools,
    });

    render(<McpEndpointInsight endpointId={ENDPOINT_ID} currentVersionId={V3} />);

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Schema complexity' })).toBeInTheDocument(),
    );
    await openInsightView('Schema complexity');

    // The 15.3 panel heading and its per-tool cards render (most complex first).
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 5, name: 'orchestrate' })).toBeInTheDocument(),
    );
    expect(screen.getByText('Tool schema shape & complexity')).toBeInTheDocument();
    const toolCards = screen.getAllByRole('heading', { level: 5 });
    expect(toolCards.map((h) => h.textContent)).toEqual(['orchestrate', 'ping']);
    // The sort/filter toolbar is wired.
    expect(screen.getByLabelText('Sort')).toBeInTheDocument();
    expect(screen.getByLabelText('Filter')).toBeInTheDocument();
  });

  it('renders the safety posture panel and flags destructive tools reachable with no auth', async () => {
    routeFetch({
      versions: () => jsonResponse(versionsPayload()),
      surface: (vid) => jsonResponse(surfacePayload(vid ?? V3, 3, 2)),
      // Two tools: a read-only search and a destructive delete.
      detail: (vid) =>
        jsonResponse(
          detailPayload(vid, [
            { item_type: 'tool', name: 'search', ordinal: 0, annotations: { readOnlyHint: true } },
            {
              item_type: 'tool',
              name: 'delete_record',
              ordinal: 1,
              annotations: { destructiveHint: true },
            },
          ]),
        ),
      // Anonymous endpoint → the destructive tool is reachable with no auth.
      credentials: () => jsonResponse(credentialsPayload('none')),
    });

    render(<McpEndpointInsight endpointId={ENDPOINT_ID} currentVersionId={V3} />);

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Safety posture' })).toBeInTheDocument(),
    );
    await openInsightView('Safety posture');

    // The 15.4 panel heading renders, and the destructive+no-auth alert names the destructive tool.
    await waitFor(() =>
      expect(screen.getByText('Safety & annotation posture')).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByText(/reachable with no auth/i)).toBeInTheDocument(),
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('delete_record');

    // The version-detail items and credential status were both fetched.
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/versions/${V3}`),
      expect.anything(),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/credentials'),
      expect.anything(),
    );
  });

  it('renders the documentation coverage gauges and drills down to under-documented items', async () => {
    routeFetch({
      versions: () => jsonResponse(versionsPayload()),
      surface: (vid) => jsonResponse(surfacePayload(vid ?? V3, 3, 2)),
      // One documented tool and one undocumented tool, so a coverage meter has a real drill-down.
      detail: (vid) =>
        jsonResponse(
          detailPayload(vid, [
            {
              item_type: 'tool',
              name: 'search',
              ordinal: 0,
              description: 'Finds records',
              title: 'Search',
            },
            { item_type: 'tool', name: 'undocumented_tool', ordinal: 1, description: null, title: null },
          ]),
        ),
    });

    render(<McpEndpointInsight endpointId={ENDPOINT_ID} currentVersionId={V3} />);

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Documentation' })).toBeInTheDocument(),
    );
    await openInsightView('Documentation');

    // The 15.5 panel heading renders, and the coverage gauges drill to the undocumented tool once the
    // snapshot's capability items resolve.
    await waitFor(() =>
      expect(screen.getByText('Documentation & schema coverage')).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getAllByText('undocumented_tool').length).toBeGreaterThan(0),
    );
    // At least one meter (e.g. items described, 1 / 2) exposes a drill-down summary.
    expect(screen.getAllByText(/under-documented →/).length).toBeGreaterThan(0);
  });

  it('renders the capability churn timeline and deep-links a column to its diff', async () => {
    const onOpenVersionDiff = jest.fn();
    routeFetch({
      versions: () => jsonResponse(versionsPayload()),
      surface: (vid) => jsonResponse(surfacePayload(vid ?? V3, 3, 4)),
      evolution: () => jsonResponse(evolutionPayload()),
    });

    render(
      <McpEndpointInsight
        endpointId={ENDPOINT_ID}
        currentVersionId={V3}
        onOpenVersionDiff={onOpenVersionDiff}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Churn timeline' })).toBeInTheDocument(),
    );
    await openInsightView('Churn timeline');

    // The churn panel loads its own series and surfaces the busiest release (v3, 4 changes).
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Busiest release/ })).toBeInTheDocument(),
    );
    // The evolution series was fetched (endpoint-level, no version_id).
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/insight/evolution'),
      expect.anything(),
    );

    // Clicking the current snapshot's column deep-links to V3's diff. Match by V3's unique churn
    // split (+1 −0 ~3) so we select the column, not the busiest-release callout that shares its date.
    fireEvent.click(screen.getByRole('button', { name: /\+1 −0 ~3/ }));
    expect(onOpenVersionDiff).toHaveBeenCalledWith(V3);
  });

  it('renders the grade & surface-size trend and deep-links a breaking-change release to its diff', async () => {
    const onOpenVersionDiff = jest.fn();
    routeFetch({
      versions: () => jsonResponse(versionsPayload()),
      surface: (vid) => jsonResponse(surfacePayload(vid ?? V3, 3, 4)),
      evolution: () => jsonResponse(evolutionPayload()),
    });

    render(
      <McpEndpointInsight
        endpointId={ENDPOINT_ID}
        currentVersionId={V3}
        onOpenVersionDiff={onOpenVersionDiff}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Grade & size trend' })).toBeInTheDocument(),
    );
    await openInsightView('Grade & size trend');

    // The trend panel renders both trends once the shared evolution series loads.
    await waitFor(() =>
      expect(screen.getByText('Grade & surface-size trend')).toBeInTheDocument(),
    );
    expect(screen.getByText('Quality score')).toBeInTheDocument();
    expect(screen.getByText('Surface size')).toBeInTheDocument();

    // v2 introduced a breaking change → a clickable chip deep-links to its diff.
    const chip = await screen.findByRole('button', { name: /v2.*1 breaking/ });
    fireEvent.click(chip);
    expect(onOpenVersionDiff).toHaveBeenCalledWith(V2);
  });

  it('reconstructs the capability presence matrix from every snapshot and deep-links a column', async () => {
    const onOpenVersionDiff = jest.fn();
    // Per-version detail: v2 has only `search`; v3 (current) adds `summarize`.
    const matrixDetail = (vid: string) => {
      const seq = vid === V3 ? 3 : 2;
      const items =
        vid === V3
          ? [
              { item_type: 'tool', name: 'search', ordinal: 0 },
              { item_type: 'tool', name: 'summarize', ordinal: 1 },
            ]
          : [{ item_type: 'tool', name: 'search', ordinal: 0 }];
      return jsonResponse({
        success: true,
        version: {
          id: vid,
          version_seq: seq,
          version_tag: null,
          server_name: 'acme-search',
          server_version: '1.4.0',
          server_title: 'Acme Search',
          protocol_version: '2025-06-18',
          instructions: null,
          score: 90,
          grade: 'A',
          is_current: vid === V3,
          discovered_at: '2026-07-06T10:00:00Z',
          items,
        },
      });
    };
    routeFetch({
      versions: () => jsonResponse(versionsPayload()),
      surface: (vid) => jsonResponse(surfacePayload(vid ?? V3, 3, 4)),
      detail: matrixDetail,
    });

    render(
      <McpEndpointInsight
        endpointId={ENDPOINT_ID}
        currentVersionId={V3}
        onOpenVersionDiff={onOpenVersionDiff}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Lifespan & presence' })).toBeInTheDocument(),
    );
    await openInsightView('Lifespan & presence');

    // The lifespan panel renders a row per capability once every snapshot's items resolve. Scope to
    // the presence-matrix table by its caption, since the safety panel also renders tool rowheaders.
    await waitFor(() =>
      expect(screen.getByText('Capability lifespan & presence')).toBeInTheDocument(),
    );
    const matrixTable = await screen.findByRole('table', {
      name: /Capability presence across discovery snapshots/i,
    });
    await waitFor(() =>
      expect(within(matrixTable).getByRole('rowheader', { name: /summarize/ })).toBeInTheDocument(),
    );
    // `summarize` first appears in the current snapshot → New; `search` is present throughout → Stable.
    expect(
      within(within(matrixTable).getByRole('rowheader', { name: /summarize/ })).getByText('New'),
    ).toBeInTheDocument();
    expect(
      within(within(matrixTable).getByRole('rowheader', { name: /search/ })).getByText('Stable'),
    ).toBeInTheDocument();

    // Both snapshots' details were fetched to build the matrix.
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/versions/${V2}`),
      expect.anything(),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/versions/${V3}`),
      expect.anything(),
    );

    // Clicking a matrix column header deep-links to that snapshot's diff.
    fireEvent.click(screen.getByRole('button', { name: /v2 .* open this snapshot's diff/ }));
    expect(onOpenVersionDiff).toHaveBeenCalledWith(V2);
  });

  it('renders the "changed since last view" digest and advances the seen-marker after reading it', async () => {
    const onOpenVersionDiff = jest.fn();
    routeFetch({
      versions: () => jsonResponse(versionsPayload()),
      surface: (vid) => jsonResponse(surfacePayload(vid ?? V3, 3, 4)),
      // A digest with a delta since the user's last view: one added tool and one breaking removal.
      digest: () =>
        jsonResponse({
          success: true,
          endpoint_id: ENDPOINT_ID,
          new_to_you: false,
          has_changes: true,
          last_seen_version_id: V2,
          last_seen_version_seq: 2,
          last_seen_at: '2026-06-01T10:00:00Z',
          current_version_id: V3,
          current_version_seq: 3,
          current_version_tag: '2026-07-06',
          current_type_counts: { tools: 4, resources: 2, resource_templates: 0, prompts: 1, total: 7 },
          change_counts: { added: 1, removed: 1, modified: 0, total: 2 },
          severity_counts: { breaking: 1, additive: 1, review: 0, total: 2 },
          changes: [
            { change_type: 'added', item_type: 'tool', item_name: 'summarize', severity: 'additive' },
            { change_type: 'removed', item_type: 'tool', item_name: 'legacy_search', severity: 'breaking' },
          ],
        }),
    });

    render(
      <McpEndpointInsight
        endpointId={ENDPOINT_ID}
        currentVersionId={V3}
        onOpenVersionDiff={onOpenVersionDiff}
      />,
    );

    // The digest header + its breaking-change callout and the changed items render.
    await waitFor(() =>
      expect(screen.getByText('Changed since your last view')).toBeInTheDocument(),
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/breaking change/i);
    expect(screen.getByText('summarize')).toBeInTheDocument();
    expect(screen.getByText('legacy_search')).toBeInTheDocument();

    // The digest was fetched, and reading it advanced the seen-marker to the current version.
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/insight/digest'),
      expect.anything(),
    );
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining(`/endpoints/${ENDPOINT_ID}/views`),
        expect.objectContaining({ method: 'POST' }),
      ),
    );

    // "Review changes" deep-links to the current version's diff.
    fireEvent.click(screen.getByRole('button', { name: /Review changes/ }));
    expect(onOpenVersionDiff).toHaveBeenCalledWith(V3);
  });

  it('shows the "new to you" digest on a first visit', async () => {
    routeFetch({
      versions: () => jsonResponse(versionsPayload()),
      surface: (vid) => jsonResponse(surfacePayload(vid ?? V3, 3, 4)),
      digest: () =>
        jsonResponse({
          success: true,
          endpoint_id: ENDPOINT_ID,
          new_to_you: true,
          has_changes: false,
          last_seen_version_id: null,
          last_seen_version_seq: null,
          last_seen_at: null,
          current_version_id: V3,
          current_version_seq: 3,
          current_version_tag: '2026-07-06',
          current_type_counts: { tools: 4, resources: 2, resource_templates: 0, prompts: 1, total: 7 },
          change_counts: { added: 0, removed: 0, modified: 0, total: 0 },
          severity_counts: { breaking: 0, additive: 0, review: 0, total: 0 },
          changes: [],
        }),
    });

    render(<McpEndpointInsight endpointId={ENDPOINT_ID} currentVersionId={V3} />);

    await waitFor(() => expect(screen.getByText('New to you')).toBeInTheDocument());
    expect(screen.getByText(/haven't viewed this endpoint before/i)).toBeInTheDocument();
  });

  it('renders the discovery health timeline with availability from the reliability fetch', async () => {
    routeFetch({
      versions: () => jsonResponse(versionsPayload()),
      surface: (vid) => jsonResponse(surfacePayload(vid ?? V3, 3, 4)),
      reliability: () =>
        jsonResponse({
          success: true,
          endpoint_id: ENDPOINT_ID,
          discovery: {
            job_count: 4,
            completed_count: 3,
            failed_count: 1,
            running_count: 0,
            queued_count: 0,
            success_rate: 0.75,
            latency: { count: 0 },
          },
          invocation: {
            call_count: 0,
            error_count: 0,
            success_count: 0,
            error_rate: 0,
            latency: { count: 0 },
          },
          health: {
            timeline: [
              { job_id: 'j4', state: 'completed', trigger: 'sweep', outcome: 'ok', created_at: '2026-07-06T12:00:00Z' },
              { job_id: 'j3', state: 'failed', trigger: 'sweep', outcome: 'connect_error', error_code: 'connect_error', created_at: '2026-07-06T06:00:00Z' },
              { job_id: 'j2', state: 'completed', trigger: 'sweep', outcome: 'ok', created_at: '2026-07-06T00:00:00Z' },
              { job_id: 'j1', state: 'completed', trigger: 'sweep', outcome: 'ok', created_at: '2026-07-05T18:00:00Z' },
            ],
            window: 50,
            last_status: 'unchanged',
            last_discovered_at: '2026-07-06T12:00:00Z',
          },
        }),
    });

    render(<McpEndpointInsight endpointId={ENDPOINT_ID} currentVersionId={V3} />);

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Discovery health' })).toBeInTheDocument(),
    );
    await openInsightView('Discovery health');

    // The discovery-health panel renders once the reliability fetch resolves.
    await waitFor(() =>
      expect(screen.getByText('Discovery health & availability')).toBeInTheDocument(),
    );
    // 3 ok / (3 ok + 1 failed) = 75% availability, and the failure breakdown names the code.
    expect(screen.getByText('75%')).toBeInTheDocument();
    expect(screen.getByText('Unreachable')).toBeInTheDocument();
    // The endpoint-level reliability endpoint was fetched.
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/insight/reliability'),
      expect.anything(),
    );
  });

  it('flags a quarantined endpoint in the discovery health panel', async () => {
    routeFetch({
      versions: () => jsonResponse(versionsPayload()),
      surface: (vid) => jsonResponse(surfacePayload(vid ?? V3, 3, 4)),
      reliability: () =>
        jsonResponse({
          success: true,
          endpoint_id: ENDPOINT_ID,
          discovery: {
            job_count: 1,
            completed_count: 0,
            failed_count: 1,
            running_count: 0,
            queued_count: 0,
            success_rate: 0,
            latency: { count: 0 },
          },
          invocation: {
            call_count: 0,
            error_count: 0,
            success_count: 0,
            error_rate: 0,
            latency: { count: 0 },
          },
          health: {
            timeline: [
              { job_id: 'q1', state: 'failed', trigger: 'sweep', outcome: 'connect_error', error_code: 'connect_error', created_at: '2026-07-06T12:00:00Z' },
            ],
            window: 50,
            quarantined: true,
            quarantined_at: '2026-07-06T12:00:00Z',
            quarantine_reason: 'connect_error: connection refused',
            consecutive_failures: 5,
            last_status: 'connect_error',
            last_discovered_at: '2026-07-06T12:00:00Z',
          },
        }),
    });

    render(<McpEndpointInsight endpointId={ENDPOINT_ID} currentVersionId={V3} />);

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Discovery health' })).toBeInTheDocument(),
    );
    await openInsightView('Discovery health');

    await waitFor(() =>
      expect(screen.getByText(/Quarantined — auto-excluded/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/connection refused/)).toBeInTheDocument();
  });

  it('renders the tool latency & error-rate panel from the reliability fetch (MCAT-17.2)', async () => {
    routeFetch({
      versions: () => jsonResponse(versionsPayload()),
      surface: (vid) => jsonResponse(surfacePayload(vid ?? V3, 3, 4)),
      reliability: () =>
        jsonResponse({
          success: true,
          endpoint_id: ENDPOINT_ID,
          discovery: {
            job_count: 0,
            completed_count: 0,
            failed_count: 0,
            running_count: 0,
            queued_count: 0,
            success_rate: 0,
            latency: { count: 0 },
          },
          invocation: {
            call_count: 0,
            error_count: 0,
            success_count: 0,
            error_rate: 0,
            latency: { count: 0 },
          },
          health: { timeline: [], window: 50 },
          tools: {
            tools: [
              {
                tool_name: 'search',
                call_count: 4,
                error_count: 1,
                success_count: 3,
                error_rate: 0.25,
                latency: { count: 4, avg_ms: 25, min_ms: 10, max_ms: 40, p50_ms: 25, p95_ms: 40, p99_ms: 40 },
              },
              {
                tool_name: 'write',
                call_count: 2,
                error_count: 2,
                success_count: 0,
                error_rate: 1,
                latency: { count: 2, avg_ms: 200, min_ms: 100, max_ms: 300, p50_ms: 200, p95_ms: 300, p99_ms: 300 },
              },
            ],
            tool_count: 2,
            call_count: 6,
            error_count: 3,
            success_count: 3,
            error_rate: 0.5,
            latency_distribution: [
              { label: '0–50 ms', upper_ms: 50, count: 4 },
              { label: '250–500 ms', upper_ms: 500, count: 2 },
            ],
            window_days: 30,
          },
        }),
    });

    render(<McpEndpointInsight endpointId={ENDPOINT_ID} currentVersionId={V3} />);

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Tool latency' })).toBeInTheDocument(),
    );
    await openInsightView('Tool latency');

    // The tool-latency panel renders once the reliability fetch resolves.
    await waitFor(() =>
      expect(screen.getByText('Tool latency & error rate')).toBeInTheDocument(),
    );
    // 3 errored / 6 calls = 50% endpoint-wide error rate.
    expect(screen.getByText('50%')).toBeInTheDocument();
    // The flakiest ranking surfaces the fully-failing tool.
    expect(screen.getByText('Flakiest tools')).toBeInTheDocument();
    expect(screen.getByText('Slowest tools')).toBeInTheDocument();
  });

  it('renders the score & lint breakdown from the selected snapshot lint report (MCAT-17.3)', async () => {
    const onNavigateToItem = jest.fn();
    routeFetch({
      versions: () => jsonResponse(versionsPayload()),
      surface: (vid) => jsonResponse(surfacePayload(vid ?? V3, 3, 4)),
      lint: (versionId) =>
        jsonResponse({
          success: true,
          endpointId: ENDPOINT_ID,
          versionId,
          versionSeq: 3,
          versionTag: '2026-07-06',
          score: 86,
          grade: 'B',
          findings: [
            { id: 'f1', path: 'tools.write_record', category: 'security', rule: 'security.no-auth', severity: 'error', message: 'Destructive tool reachable with no auth.' },
            { id: 'f2', path: 'tools.search', category: 'annotation', rule: 'annotation.hint', severity: 'warning', message: 'Missing readOnlyHint.' },
          ],
          ruleHits: { 'security.no-auth': 1, 'annotation.hint': 1 },
          severityCounts: { error: 1, warning: 1, info: 0 },
          reportFingerprint: 'fp',
          source: 'stored',
          scoredAt: '2026-07-06T00:00:00Z',
        }),
    });

    render(
      <McpEndpointInsight
        endpointId={ENDPOINT_ID}
        currentVersionId={V3}
        onNavigateToItem={onNavigateToItem}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Score breakdown' })).toBeInTheDocument(),
    );
    await openInsightView('Score breakdown');

    // The score-breakdown panel renders from the version's lint report.
    await waitFor(() =>
      expect(screen.getByText('Score & lint breakdown')).toBeInTheDocument(),
    );
    // 10 (error) + 4 (warning) = 14 points deducted across 2 rule groups; security leads.
    await waitFor(() => expect(screen.getByText('−14')).toBeInTheDocument());
    expect(screen.getByText('Points lost by rule group')).toBeInTheDocument();
    expect(screen.getByText('Security')).toBeInTheDocument();
    // The lint report was fetched for the selected snapshot.
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/versions/${V3}/lint`),
      expect.anything(),
    );

    // A finding deep-links to its offending capability item.
    fireEvent.click(screen.getByRole('button', { name: /tools\.write_record/i }));
    expect(onNavigateToItem).toHaveBeenCalledWith('tool', 'write_record');
  });

  it('renders the composite trust profile radar from insight/trust (MCAT-17.4)', async () => {
    const axis = (
      key: string,
      label: string,
      value: number | null,
      available: boolean,
      detail: string,
    ) => ({ key, label, value, available, detail, methodology: `How ${label} is computed.` });
    routeFetch({
      versions: () => jsonResponse(versionsPayload()),
      surface: (vid) => jsonResponse(surfacePayload(vid ?? V3, 3, 4)),
      trust: () =>
        jsonResponse({
          success: true,
          endpoint_id: ENDPOINT_ID,
          version_id: V3,
          auth_type: 'none',
          profile: {
            axes: [
              axis('quality', 'Quality', 90, true, 'Grade A · 90/100'),
              axis('safety', 'Safety', 75, true, '2/2 tools annotated · anonymous'),
              axis('documentation', 'Documentation', 50, true, '100% described · 0% titled'),
              axis('stability', 'Stability', null, false, 'Not enough history'),
              axis('responsiveness', 'Responsiveness', null, false, 'Never tested'),
            ],
            overall: 72,
            available_count: 3,
            axis_count: 5,
          },
        }),
    });

    render(<McpEndpointInsight endpointId={ENDPOINT_ID} currentVersionId={V3} />);

    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Trust profile' })).toBeInTheDocument(),
    );
    await openInsightView('Trust profile');

    // The trust-profile panel renders once the insight/trust fetch resolves.
    await waitFor(() =>
      expect(screen.getByText('Composite trust profile')).toBeInTheDocument(),
    );
    // The overall composite headline + "3 of 5 signals measured" caption.
    expect(screen.getByText('72')).toBeInTheDocument();
    expect(screen.getByText(/signals measured/i)).toBeInTheDocument();
    // A measured axis shows its score; the gaps show "Not measured", never a zero.
    expect(screen.getByText('Grade A · 90/100')).toBeInTheDocument();
    expect(screen.getAllByText('Not measured').length).toBeGreaterThanOrEqual(2);
    // The trust profile was fetched endpoint-level.
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/insight/trust'),
      expect.anything(),
    );
  });
});
