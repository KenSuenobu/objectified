/**
 * Render tests for MCP section tabs — hidden until at least one server is in the catalog.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockUsePathname = jest.fn<string, []>();
const mockUseSession = jest.fn<{ data: unknown }, []>();

jest.mock('next/navigation', () => ({
  usePathname: () => mockUsePathname(),
}));

jest.mock('@lib/auth/session-client', () => ({
  useAuthSession: () => mockUseSession(),
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { McpSectionTabs } from '../src/app/components/ade/dashboard/mcp/McpSectionTabs';

describe('McpSectionTabs', () => {
  beforeEach(() => {
    mockUsePathname.mockReturnValue('/ade/dashboard/mcp');
    mockUseSession.mockReturnValue({
      data: { user: { current_tenant_id: 'tenant-1' } },
    });
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('hides the tabs when hasServers is false', () => {
    const { container } = render(<McpSectionTabs hasServers={false} />);
    expect(container).toBeEmptyDOMElement();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('renders the section tabs when hasServers is true', () => {
    render(<McpSectionTabs hasServers />);
    const nav = screen.getByRole('navigation', { name: 'MCP Servers sections' });
    expect(nav).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Catalog' })).toHaveAttribute(
      'href',
      '/ade/dashboard/mcp',
    );
    expect(screen.getByRole('link', { name: 'Capability Directory' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Catalog Analytics/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Server Comparison' })).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('probes the browse catalog and stays hidden when empty', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ groups: [] }),
    });

    const { container } = render(<McpSectionTabs />);
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith('/api/mcp/browse', { credentials: 'include' });
    });
    expect(container).toBeEmptyDOMElement();
  });

  it('probes the browse catalog and shows tabs when a server exists', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        groups: [
          {
            host: 'mcp.example.com',
            endpoints: [{ id: 'ep-1', name: 'demo', slug: 'demo', host: 'mcp.example.com' }],
          },
        ],
      }),
    });

    render(<McpSectionTabs />);
    await waitFor(() => {
      expect(
        screen.getByRole('navigation', { name: 'MCP Servers sections' }),
      ).toBeInTheDocument();
    });
  });
});
