/**
 * Render/interaction tests for the MCP catalog card grid components (V2-MCP-24.8 / MCAT-10.8).
 *
 * Covers the grade-led card (grid + dense-list forms, badges, health, recency, the "Changed"
 * marker) and the toolbar (search, sort select, density toggle, composable facet filters).
 */
import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom';

import { McpCatalogCard } from '../src/app/components/ade/dashboard/mcp/McpCatalogCard';
import { McpCatalogToolbar } from '../src/app/components/ade/dashboard/mcp/McpCatalogToolbar';
import {
  mcpBrowseEndpointFromPayload,
  type McpBrowseEndpoint,
} from '../src/app/components/ade/dashboard/mcp/mcpBrowseUi';
import {
  MCP_CATALOG_EMPTY_FILTERS,
  mcpCatalogFacets,
  type McpCatalogFilters,
} from '../src/app/components/ade/dashboard/mcp/mcpCatalogUi';

// next/link renders an <a> in jsdom; no mock needed beyond the default.

function ep(overrides: Partial<McpBrowseEndpoint> & { id: string }): McpBrowseEndpoint {
  return mcpBrowseEndpointFromPayload({
    name: overrides.id,
    host: 'mcp.acme.example',
    transport: 'streamable_http',
    visibility: 'private',
    ...overrides,
  });
}

describe('McpCatalogCard (grid)', () => {
  const endpoint = ep({
    id: 'ep-1',
    name: 'Acme Weather',
    grade: 'B',
    score: 82,
    transport: 'streamable_http',
    visibility: 'private',
    auth_scheme: 'bearer',
    tool_count: 3,
    resource_count: 2,
    resource_template_count: 1,
    prompt_count: 4,
    version_count: 3,
    last_discovery_status: 'ok',
    last_discovered_at: '2026-06-26T12:00:00Z',
  });

  it('leads with the grade glyph, links to the endpoint, and shows badges + counts', () => {
    render(<McpCatalogCard endpoint={endpoint} href="/ade/dashboard/mcp/ep-1" />);
    const link = screen.getByRole('link', { name: /Open Acme Weather/i });
    expect(link).toHaveAttribute('href', '/ade/dashboard/mcp/ep-1');
    expect(screen.getByRole('img', { name: /Grade B/i })).toBeInTheDocument();
    expect(screen.getByText('Acme Weather')).toBeInTheDocument();
    expect(within(link).getByText(/3t · 2r · 1rt · 4p/)).toBeInTheDocument();
    expect(within(link).getByText('3 versions')).toBeInTheDocument();
    expect(within(link).getByText('streamable_http')).toBeInTheDocument();
    expect(within(link).getByText('Unpublished')).toBeInTheDocument();
    expect(within(link).getByText('Private')).toBeInTheDocument();
    expect(within(link).getByText('bearer')).toBeInTheDocument();
    expect(within(link).getByText('Healthy')).toBeInTheDocument();
  });

  it('omits the auth badge when the endpoint has no auth scheme', () => {
    render(<McpCatalogCard endpoint={ep({ id: 'x', name: 'No Auth' })} href="/x" />);
    expect(screen.queryByText('bearer')).not.toBeInTheDocument();
  });

  it('renders the Changed marker only when changed is set', () => {
    const { rerender } = render(
      <McpCatalogCard endpoint={endpoint} href="/x" changed={false} />,
    );
    expect(screen.queryByText('Changed')).not.toBeInTheDocument();
    rerender(<McpCatalogCard endpoint={endpoint} href="/x" changed />);
    expect(screen.getByText('Changed')).toBeInTheDocument();
  });

  it('shows a quarantined chip when the endpoint is quarantined', () => {
    render(<McpCatalogCard endpoint={ep({ id: 'q', quarantined: true })} href="/x" />);
    expect(screen.getByText('Quarantined')).toBeInTheDocument();
  });

  it('shows Published when the endpoint is published', () => {
    render(
      <McpCatalogCard
        endpoint={ep({ id: 'pub', name: 'Public Svc', published: true, visibility: 'public' })}
        href="/x"
      />,
    );
    expect(screen.getByText('Published')).toBeInTheDocument();
    expect(screen.queryByText('Unpublished')).not.toBeInTheDocument();
  });
});

describe('McpCatalogCard (dense list)', () => {
  it('renders a compact row that still links and shows the name + counts', () => {
    const endpoint = ep({ id: 'ep-2', name: 'Calendar', grade: 'A', score: 95, tool_count: 5, version_count: 1 });
    render(<McpCatalogCard endpoint={endpoint} href="/ade/dashboard/mcp/ep-2" density="list" changed />);
    const link = screen.getByRole('link', { name: /Open Calendar/i });
    expect(link).toHaveAttribute('href', '/ade/dashboard/mcp/ep-2');
    expect(screen.getByText('Calendar')).toBeInTheDocument();
    expect(screen.getByText('Changed')).toBeInTheDocument();
    expect(screen.getByText('1 version')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Grade A/i })).toBeInTheDocument();
  });
});

describe('McpCatalogToolbar', () => {
  const groups = [
    {
      host: 'acme.example',
      endpoint_count: 2,
      capability_count: 7,
      endpoints: [
        ep({ id: 'a', grade: 'A', transport: 'streamable_http', visibility: 'private', category: 'weather' }),
        ep({ id: 'b', grade: 'C', transport: 'http+sse', visibility: 'public', category: 'time' }),
      ],
    },
  ];
  const facets = mcpCatalogFacets(groups);

  function Harness(props: { initialFilters?: McpCatalogFilters }) {
    const [search, setSearch] = React.useState('');
    const [sort, setSort] = React.useState<'grade' | 'name'>('grade');
    const [density, setDensity] = React.useState<'grid' | 'list'>('grid');
    const [filters, setFilters] = React.useState<McpCatalogFilters>(
      props.initialFilters ?? MCP_CATALOG_EMPTY_FILTERS,
    );
    return (
      <McpCatalogToolbar
        search={search}
        onSearchChange={setSearch}
        sort={sort}
        onSortChange={(s) => setSort(s as 'grade' | 'name')}
        density={density}
        onDensityChange={setDensity}
        facets={facets}
        filters={filters}
        onFiltersChange={setFilters}
      />
    );
  }

  it('renders the search box and updates on typing', () => {
    render(<Harness />);
    const input = screen.getByLabelText('Search the catalog') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'weather' } });
    expect(input.value).toBe('weather');
  });

  // Since HIVE-7.7 (#5324) the density pair is `ui/Segmented`, so its options are `role="radio"`
  // in one radiogroup rather than two `aria-pressed` buttons.
  it('exposes the density toggle as one radiogroup and reflects the selection', () => {
    render(<Harness />);
    const group = screen.getByRole('radiogroup', { name: 'Layout density' });
    const grid = within(group).getByRole('radio', { name: /Grid view/i });
    const list = within(group).getByRole('radio', { name: /Dense list view/i });
    expect(grid).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(list);
    expect(list).toHaveAttribute('aria-checked', 'true');
    expect(grid).toHaveAttribute('aria-checked', 'false');
  });

  it('opens the filter panel and toggles a facet value, updating the active count', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /^Filters/i }));
    // The grade facet chip for "A" is present once the panel is open.
    const chipA = screen.getByRole('button', { name: /^A 1$/i });
    expect(chipA).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(chipA);
    expect(chipA).toHaveAttribute('aria-pressed', 'true');
    // The Filters button now shows the active count badge "1".
    const filtersButton = screen.getByRole('button', { name: /^Filters/i });
    expect(within(filtersButton).getByText('1')).toBeInTheDocument();
  });

  it('clears all filters from the panel', () => {
    render(<Harness initialFilters={{ ...MCP_CATALOG_EMPTY_FILTERS, grades: ['A'] }} />);
    fireEvent.click(screen.getByRole('button', { name: /^Filters/i }));
    fireEvent.click(screen.getByRole('button', { name: /Clear all filters/i }));
    expect(screen.getByRole('button', { name: /^A 1$/i })).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('McpCatalogToolbar (35.1 facet dimensions, #4660)', () => {
  const groups = [
    {
      host: 'acme.example',
      endpoint_count: 2,
      capability_count: 5,
      endpoints: [
        ep({
          id: 'risky',
          grade: 'C',
          has_destructive: true,
          health: 'failing',
          complexity_band: 'complex',
          protocol_version: '2025-06-18',
        }),
        ep({ id: 'quiet', grade: 'A', read_only_only: true, health: 'healthy', complexity_band: 'simple' }),
      ],
    },
  ];
  const facets = mcpCatalogFacets(groups);

  function Harness() {
    const [filters, setFilters] = React.useState<McpCatalogFilters>(MCP_CATALOG_EMPTY_FILTERS);
    return (
      <McpCatalogToolbar
        search=""
        onSearchChange={() => undefined}
        sort="grade"
        onSortChange={() => undefined}
        density="grid"
        onDensityChange={() => undefined}
        facets={facets}
        filters={filters}
        onFiltersChange={setFilters}
      />
    );
  }

  it('renders the new facet groups with human-labelled safety chips and counts', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /^Filters/i }));
    expect(screen.getByText('Safety')).toBeInTheDocument();
    expect(screen.getByText('Complexity')).toBeInTheDocument();
    expect(screen.getByText('Protocol')).toBeInTheDocument();
    expect(screen.getByText('Health')).toBeInTheDocument();
    // Machine-named safety values render their human labels.
    expect(screen.getByRole('button', { name: /^Has destructive 1$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Read-only only 1$/i })).toBeInTheDocument();
  });

  it('toggles a safety chip into the active filter count', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /^Filters/i }));
    const chip = screen.getByRole('button', { name: /^Has destructive 1$/i });
    fireEvent.click(chip);
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    const filtersButton = screen.getByRole('button', { name: /^Filters/i });
    expect(within(filtersButton).getByText('1')).toBeInTheDocument();
  });
});
