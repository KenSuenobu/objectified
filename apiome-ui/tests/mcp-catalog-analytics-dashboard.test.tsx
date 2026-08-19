/**
 * Render tests for the Catalog analytics dashboard (V2-MCP-32.1 / MCAT-18.1; redesigned HIVE-7.9,
 * #5326).
 *
 * Covers the acceptance criteria that live in the component (the pure projections are unit-tested in
 * `mcp-catalog-insight-ui.test.ts`): loading / error / empty-catalog states, and that a populated
 * catalog renders every tile — the stat row, the category / transport / grade mixes, the protocol /
 * tool-count / discovery distributions, the change-frequency leaders (linked to the endpoint), and
 * the top-capabilities leaderboard — all from a fixture built through the real parser.
 *
 * Two things the redesign changed that this suite now pins: each headline figure carries the
 * mockup's footnote (and *omits* it rather than printing a zero when there is no gap to report),
 * and each chart carries its tile's heading as its accessible name — which is why the tile-level
 * assertions are scoped by `data-testid` rather than matching a bare string that now appears twice.
 */
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';

import { CatalogAnalyticsDashboard } from '../src/app/components/ui/mcp/CatalogAnalyticsDashboard';
import {
  mcpCatalogInsightFromPayload,
  type McpCatalogInsight,
} from '../src/app/components/ade/dashboard/mcp/mcpCatalogInsightUi';

/** The wire payload the populated fixture is parsed from, reused for one-field variants. */
const RAW_POPULATED = {
  success: true,
  endpoint_count: 12,
  published_count: 7,
  public_count: 5,
  private_count: 7,
  discovered_count: 10,
  scored_count: 9,
  average_score: 78.4,
  type_counts: { tools: 84, resources: 22, resource_templates: 5, prompts: 8, total: 119 },
  grade_distribution: { A: 3, B: 4, C: 1, D: 1 },
  category_distribution: [
    { label: 'search', count: 4 },
    { label: 'Uncategorized', count: 2 },
  ],
  transport_distribution: [{ label: 'streamable_http', count: 8 }],
  protocol_version_distribution: [{ label: '2025-06-18', count: 6 }],
  tool_count_distribution: [
    { label: '0', count: 2 },
    { label: '1–5', count: 4 },
  ],
  discovery_health: [{ label: 'ok', count: 9 }],
  change_leaders: [{ endpoint_id: 'ep-1', name: 'Acme Search', change_count: 23 }],
  top_capabilities: [{ item_type: 'tool', item_name: 'vector_search', endpoint_count: 6 }],
};

const POPULATED: McpCatalogInsight = mcpCatalogInsightFromPayload(RAW_POPULATED)!;

const EMPTY: McpCatalogInsight = mcpCatalogInsightFromPayload({
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
})!;

describe('CatalogAnalyticsDashboard', () => {
  it('shows the loading state while first loading', () => {
    render(<CatalogAnalyticsDashboard data={null} loading error={null} />);
    expect(screen.getByText(/loading catalog analytics/i)).toBeInTheDocument();
  });

  it('shows the error state with the message', () => {
    render(<CatalogAnalyticsDashboard data={null} loading={false} error="boom" />);
    expect(screen.getByText(/catalog analytics unavailable/i)).toBeInTheDocument();
    expect(screen.getByText('boom')).toBeInTheDocument();
  });

  it('shows the empty-catalog first-run state', () => {
    render(<CatalogAnalyticsDashboard data={EMPTY} loading={false} error={null} />);
    expect(screen.getByText(/no servers in the catalog yet/i)).toBeInTheDocument();
  });

  it('renders the headline stat row from real aggregates', () => {
    render(<CatalogAnalyticsDashboard data={POPULATED} loading={false} error={null} />);
    // Scoped to the strip: since HIVE-7.9 each donut also prints its total as a centre label, so
    // `12` appears three times on the screen and only one of them is the Endpoints figure.
    const stats = within(screen.getByTestId('mcp-analytics-stats'));
    expect(stats.getByText('Endpoints')).toBeInTheDocument();
    expect(stats.getByText('12')).toBeInTheDocument();
    // average score, rendered to one decimal.
    expect(stats.getByText('78.4')).toBeInTheDocument();
  });

  it('carries the mockup’s footnote under each headline figure', () => {
    render(<CatalogAnalyticsDashboard data={POPULATED} loading={false} error={null} />);
    const stats = within(screen.getByTestId('mcp-analytics-stats'));
    // The public/private split was parsed but never rendered before this redesign.
    expect(stats.getByText('5 public · 7 private')).toBeInTheDocument();
    expect(stats.getByText('2 never discovered')).toBeInTheDocument();
    expect(stats.getByText('3 unscored')).toBeInTheDocument();
    expect(stats.getByText('119 capabilities')).toBeInTheDocument();
  });

  it('drops a gap footnote entirely rather than printing a zero', () => {
    const complete = mcpCatalogInsightFromPayload({
      ...RAW_POPULATED,
      discovered_count: 12,
      scored_count: 12,
    })!;
    render(<CatalogAnalyticsDashboard data={complete} loading={false} error={null} />);
    const stats = within(screen.getByTestId('mcp-analytics-stats'));
    expect(stats.queryByText(/never discovered/)).not.toBeInTheDocument();
    expect(stats.queryByText(/unscored/)).not.toBeInTheDocument();
  });

  it('renders the composition tiles', () => {
    render(<CatalogAnalyticsDashboard data={POPULATED} loading={false} error={null} />);
    // Each tile's heading is also the chart's accessible name, so the string appears twice — once
    // as the card's title and once inside the SVG. Assert the tile, not the string.
    for (const [testId, title] of [
      ['mcp-analytics-category-mix', 'Category mix'],
      ['mcp-analytics-transport-mix', 'Transport mix'],
      ['mcp-analytics-grade-mix', 'Grade distribution'],
      ['mcp-analytics-protocol', 'Protocol version adoption'],
      ['mcp-analytics-tool-counts', 'Tool-count distribution'],
      ['mcp-analytics-health', 'Discovery health'],
    ] as const) {
      const tile = screen.getByTestId(testId);
      expect(tile).toHaveTextContent(title);
      expect(within(tile).getByRole('img', { name: new RegExp(title, 'i') })).toBeInTheDocument();
    }
  });

  it('prints every donut slice as `label · value (pct%)` beside the ring', () => {
    const { container } = render(
      <CatalogAnalyticsDashboard data={POPULATED} loading={false} error={null} />,
    );
    // Scoped to the legend: the chart states the same series again in its own `sr-only` table,
    // which is the point — the figures are readable without seeing the ring at all.
    const legend = container.querySelector(
      '[data-testid="mcp-analytics-category-mix"] .mcpa-legend',
    ) as HTMLElement;
    const rows = within(legend);
    // 4 of 12 endpoints, so 33% — the ring and the legend read from one projection.
    expect(rows.getByText('search')).toBeInTheDocument();
    expect(rows.getByText('(33%)')).toBeInTheDocument();
    expect(rows.getByText('(17%)')).toBeInTheDocument();
  });

  it('labels a bar tile’s axis and repeats the buckets in words beneath it', () => {
    const { container } = render(
      <CatalogAnalyticsDashboard data={POPULATED} loading={false} error={null} />,
    );
    const tile = '[data-testid="mcp-analytics-tool-counts"]';
    const axis = within(container.querySelector(`${tile} .mcpa-axis`) as HTMLElement);
    const counts = within(container.querySelector(`${tile} .mcpa-counts`) as HTMLElement);
    expect(axis.getByText('1–5')).toBeInTheDocument();
    // The list prints `label · count`, so the label is one text node inside its `<li>`.
    expect(counts.getByText('1–5', { exact: false })).toBeInTheDocument();
    expect(counts.getByText('4')).toBeInTheDocument();
  });

  it('hides the axis from assistive tech, so the series is announced once', () => {
    const { container } = render(
      <CatalogAnalyticsDashboard data={POPULATED} loading={false} error={null} />,
    );
    // The chart's own `sr-only` table already states every bucket; a duplicated axis would make a
    // screen reader read the histogram three times.
    for (const axis of container.querySelectorAll('.mcpa-axis')) {
      expect(axis).toHaveAttribute('aria-hidden', 'true');
    }
  });

  it('links each change-frequency leader to its endpoint detail', () => {
    render(<CatalogAnalyticsDashboard data={POPULATED} loading={false} error={null} />);
    const link = screen.getByRole('link', { name: 'Acme Search' });
    expect(link).toHaveAttribute('href', '/ade/dashboard/mcp/ep-1');
    expect(screen.getByText(/23 changes/)).toBeInTheDocument();
  });

  it('renders the top-capabilities leaderboard', () => {
    render(<CatalogAnalyticsDashboard data={POPULATED} loading={false} error={null} />);
    expect(screen.getByText('Top capabilities')).toBeInTheDocument();
    expect(screen.getByText('vector_search')).toBeInTheDocument();
    expect(screen.getByText(/6 endpoints/)).toBeInTheDocument();
  });

  it('renders nothing when data is null and not loading (no error)', () => {
    const { container } = render(
      <CatalogAnalyticsDashboard data={null} loading={false} error={null} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
