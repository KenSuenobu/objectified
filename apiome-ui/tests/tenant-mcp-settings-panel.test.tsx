/**
 * Tenant MCP settings panel — MTG-4.1 (#4780) / MTG-4.2 (#4781) / MTG-4.4 (#4783)
 * / MTG-4.5 (#4784) / MTG-5.1 (#4785), redrawn as a drawer section by HIVE-5.1 (#5304).
 *
 * The panel no longer collapses itself: inside the manage drawer the "MCP settings" tab is
 * the disclosure, and it only mounts this section on first open — so mounting is the request
 * to load, and none of these tests presses an expand button. The per-key editor and the
 * policy history are siblings now rather than children, which is what the two
 * `not.toBeInTheDocument()` assertions below hold.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { jest } from '@jest/globals';

jest.mock('sonner', () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
  },
}));

const confirmDialog = jest.fn<(opts: unknown) => Promise<boolean>>().mockResolvedValue(true);

jest.mock('@/app/components/providers/DialogProvider', () => ({
  useDialog: () => ({ confirm: confirmDialog, alert: jest.fn() }),
}));

import TenantMcpSettingsPanel from '../src/app/ade/dashboard/tenants/TenantMcpSettingsPanel';

const POLICY = {
  default_mode: 'all',
  allow_anonymous_mcp: true,
  tools: [
    {
      tool_id: 'ping',
      in_ceiling: true,
      default_enabled: true,
      anonymous_enabled: true,
    },
  ],
  updated_at: null,
  updated_by: null,
};

const CATALOG = {
  tools: [
    { id: 'ping', description: 'Health check', toolset: 'health' },
    { id: 'spec.list', description: 'List specs', toolset: 'catalog' },
    { id: 'spec.search', description: 'Search specs', toolset: 'search' },
    { id: 'spec.get_openapi', description: 'Get OpenAPI', toolset: 'document' },
    { id: 'spec.list_operations', description: 'List operations', toolset: 'structure' },
  ],
};

const PRESETS = {
  presets: [
    { id: 'catalog_only', label: 'Catalog only', toolsets: ['health', 'catalog'] },
    {
      id: 'search_catalog',
      label: 'Search + catalog',
      toolsets: ['health', 'catalog', 'search'],
    },
    {
      id: 'full_read',
      label: 'Full read',
      toolsets: ['health', 'catalog', 'search', 'document', 'structure'],
    },
  ],
};

const ACTIVE_KEYS = {
  keys: [
    {
      id: 'key-1',
      prefix: 'mcp_aa',
      label: 'Prod agent',
      scope_json: { tenants: [], projects: [] },
      capability_mode: 'inherit',
      created_at: '2026-01-01T00:00:00Z',
    },
  ],
};

let calls: { url: string; method: string; body: unknown }[] = [];
let keysPayload: { keys: unknown[] } = { keys: [] };

function jsonResponse(payload: unknown) {
  return Promise.resolve({
    status: 200,
    ok: true,
    json: () => Promise.resolve(payload),
  } as Response);
}

function mockFetch() {
  const fn = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method || 'GET';
    calls.push({
      url,
      method,
      body: init?.body ? JSON.parse(init.body as string) : null,
    });

    if (url.includes('/api/tenants/mcp-policy/history') && method === 'GET') {
      return jsonResponse({ success: true, data: { changes: [] } });
    }
    if (url.includes('/api/tenants/mcp-policy') && method === 'GET') {
      return jsonResponse({ success: true, data: POLICY });
    }
    if (url.includes('/api/api-keys/mcp-tools') && method === 'GET') {
      return jsonResponse({ success: true, data: CATALOG });
    }
    if (url.includes('/api/api-keys/mcp-capability-presets') && method === 'GET') {
      return jsonResponse({ success: true, data: PRESETS });
    }
    if (url.includes('/api/tenants/mcp-policy') && method === 'PUT') {
      return jsonResponse({
        success: true,
        data: { ...POLICY, ...(init?.body ? JSON.parse(init.body as string) : {}) },
      });
    }
    if (url.includes('/api/tenants/mcp-keys') && method === 'GET' && !url.includes('/capabilities')) {
      return jsonResponse({ success: true, data: keysPayload });
    }
    if (url.includes('/capabilities/preview') && method === 'POST') {
      return jsonResponse({ success: true, data: { tools: [] } });
    }
    if (url.includes('/capabilities') && method === 'PUT') {
      return jsonResponse({
        success: true,
        data: { mode: 'inherit', enabled_tools: [] },
      });
    }
    return jsonResponse({ success: false, error: `Unhandled ${method} ${url}` });
  });
  // @ts-expect-error test double
  global.fetch = fn;
  return fn;
}

beforeEach(() => {
  calls = [];
  keysPayload = { keys: [] };
  confirmDialog.mockReset();
  confirmDialog.mockResolvedValue(true);
  mockFetch();
  // Radix Select needs these in jsdom.
  // @ts-expect-error jsdom stub
  Element.prototype.hasPointerCapture ??= () => false;
  // @ts-expect-error jsdom stub
  Element.prototype.setPointerCapture ??= () => {};
  // @ts-expect-error jsdom stub
  Element.prototype.releasePointerCapture ??= () => {};
  // @ts-expect-error jsdom stub
  window.HTMLElement.prototype.scrollIntoView ??= () => {};
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('TenantMcpSettingsPanel', () => {
  it('shows switch-tenant note when not current tenant and does not fetch', async () => {
    render(
      <TenantMcpSettingsPanel
        isCurrentTenant={false}
        isAdmin={false}
        tenantName="Acme"
      />,
    );


    expect(
      await screen.findByText(/Select Acme as your current tenant/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Only tenant administrators can change MCP options/i),
    ).not.toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('shows read-only banner and disabled controls for non-admin members', async () => {
    render(<TenantMcpSettingsPanel isCurrentTenant isAdmin={false} />);


    expect(
      await screen.findByText(/Only tenant administrators can change MCP options/i),
    ).toBeInTheDocument();
    const health = await screen.findByRole('switch', { name: /Enable health toolset/i });
    expect(health).toBeDisabled();
    expect(screen.getByRole('switch', { name: /Allow anonymous MCP calls/i })).toBeDisabled();
    expect(screen.queryByText(/Per-key capabilities/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/No MCP API keys yet/i)).not.toBeInTheDocument();

    fireEvent.click(health);
    expect(screen.queryByText(/Unsaved MCP settings changes/i)).not.toBeInTheDocument();
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('loads policy and catalog on mount for a current-tenant admin', async () => {
    render(<TenantMcpSettingsPanel isCurrentTenant isAdmin />);


    expect(
      await screen.findByText(/tools\/list always returns the full catalog/i),
    ).toBeInTheDocument();
    expect(await screen.findByRole('switch', { name: /Enable health toolset/i })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /Enable catalog toolset/i })).toBeInTheDocument();

    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/api/tenants/mcp-policy') && c.method === 'GET')).toBe(
        true,
      );
      expect(calls.some((c) => c.url.includes('/api/api-keys/mcp-tools') && c.method === 'GET')).toBe(
        true,
      );
      expect(
        calls.some(
          (c) => c.url.includes('/api/api-keys/mcp-capability-presets') && c.method === 'GET',
        ),
      ).toBe(true);
    });
  });

  it('capability profile select applies a named pack to the draft', async () => {
    const user = userEvent.setup();
    render(<TenantMcpSettingsPanel isCurrentTenant isAdmin />);

    expect(await screen.findByRole('switch', { name: /Enable search toolset/i })).toBeChecked();

    await user.click(screen.getByRole('combobox', { name: /Capability profile/i }));
    await user.click(await screen.findByRole('option', { name: /^Catalog only$/i }));

    await waitFor(() => {
      expect(screen.getByText(/Unsaved MCP settings changes/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('switch', { name: /Enable health toolset/i })).toBeChecked();
    expect(screen.getByRole('switch', { name: /Enable catalog toolset/i })).toBeChecked();
    expect(screen.getByRole('switch', { name: /Enable search toolset/i })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: /Enable document toolset/i })).not.toBeChecked();
  });

  it('manual toolset edit leaves Custom selectable after a named pack', async () => {
    const user = userEvent.setup();
    render(<TenantMcpSettingsPanel isCurrentTenant isAdmin />);

    expect(await screen.findByRole('switch', { name: /Enable health toolset/i })).toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: /Capability profile/i }));
    await user.click(await screen.findByRole('option', { name: /^Catalog only$/i }));

    const catalog = await screen.findByRole('switch', { name: /Enable catalog toolset/i });
    await user.click(catalog);

    await waitFor(() => {
      expect(catalog).not.toBeChecked();
    });

    await user.click(screen.getByRole('combobox', { name: /Capability profile/i }));
    expect(await screen.findByRole('option', { name: /^Custom$/i })).toBeInTheDocument();
  });

  it('master toolset switch toggles children and save persists via PUT', async () => {
    render(<TenantMcpSettingsPanel isCurrentTenant isAdmin />);

    const health = await screen.findByRole('switch', { name: /Enable health toolset/i });
    expect(health).toBeChecked();

    fireEvent.click(health);
    await waitFor(() => {
      expect(health).not.toBeChecked();
    });

    const save = await screen.findByRole('button', { name: /Save changes/i });
    fireEvent.click(save);

    await waitFor(() => {
      const put = calls.find((c) => c.method === 'PUT' && c.url.includes('/api/tenants/mcp-policy'));
      expect(put).toBeTruthy();
      const tools = (put?.body as { tools: Array<{ tool_id: string; in_ceiling: boolean }> }).tools;
      expect(tools.find((t) => t.tool_id === 'ping')).toMatchObject({
        tool_id: 'ping',
        in_ceiling: false,
      });
      expect(tools.find((t) => t.tool_id === 'spec.list')).toMatchObject({
        tool_id: 'spec.list',
        in_ceiling: true,
      });
    });
  });

  it('confirms before disabling a toolset used by active keys', async () => {
    keysPayload = ACTIVE_KEYS;
    render(<TenantMcpSettingsPanel isCurrentTenant isAdmin />);

    const health = await screen.findByRole('switch', { name: /Enable health toolset/i });
    fireEvent.click(health);

    await waitFor(() => {
      expect(confirmDialog).toHaveBeenCalled();
    });
    const opts = confirmDialog.mock.calls[0][0] as {
      title: string;
      message: string;
      confirmLabel: string;
    };
    expect(opts).toMatchObject({
      title: 'Disable Health toolset?',
      confirmLabel: 'Disable toolset',
    });
    expect(String(opts.message)).toContain('mcp_aa…');
    expect(String(opts.message)).toContain('1 active MCP key');

    await waitFor(() => {
      expect(health).not.toBeChecked();
    });
  });

  it('cancel on impactful disable leaves policy unchanged', async () => {
    keysPayload = ACTIVE_KEYS;
    confirmDialog.mockResolvedValue(false);
    render(<TenantMcpSettingsPanel isCurrentTenant isAdmin />);

    const health = await screen.findByRole('switch', { name: /Enable health toolset/i });
    fireEvent.click(health);

    await waitFor(() => {
      expect(confirmDialog).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(health).toBeChecked();
    });
    expect(screen.queryByText(/Unsaved MCP settings changes/i)).not.toBeInTheDocument();
  });

  it('skips confirm when no active key effective-enables the toolset', async () => {
    keysPayload = {
      keys: [
        {
          id: 'key-1',
          prefix: 'mcp_zz',
          label: 'Explicit none',
          scope_json: { tenants: [], projects: [] },
          capability_mode: 'explicit',
          enabled_tools: [],
          created_at: '2026-01-01T00:00:00Z',
        },
      ],
    };
    render(<TenantMcpSettingsPanel isCurrentTenant isAdmin />);

    const health = await screen.findByRole('switch', { name: /Enable health toolset/i });
    fireEvent.click(health);

    await waitFor(() => {
      expect(health).not.toBeChecked();
    });
    expect(confirmDialog).not.toHaveBeenCalled();
  });

  it('shows individual tools in advanced view', async () => {
    render(<TenantMcpSettingsPanel isCurrentTenant isAdmin />);

    expect(await screen.findByRole('switch', { name: /Enable health toolset/i })).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/Advanced: individual tools/i));

    expect(await screen.findByText('ping')).toBeInTheDocument();
    expect(screen.getByText('spec.list')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /ping in ceiling/i })).toBeChecked();

    const healthSection = screen.getByRole('region', { name: /health toolset/i });
    expect(within(healthSection).getByText('Health check')).toBeInTheDocument();
  });

  it('shows dirty-state save bar and discards changes', async () => {
    render(<TenantMcpSettingsPanel isCurrentTenant isAdmin />);

    const anon = await screen.findByRole('switch', { name: /Allow anonymous MCP calls/i });
    fireEvent.click(anon);

    expect(await screen.findByText(/Unsaved MCP settings changes/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Discard$/i }));

    await waitFor(() => {
      expect(screen.queryByText(/Unsaved MCP settings changes/i)).not.toBeInTheDocument();
    });
    expect(screen.getByRole('switch', { name: /Allow anonymous MCP calls/i })).toBeChecked();
  });
});
