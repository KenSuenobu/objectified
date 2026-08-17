/**
 * Per-key MCP capability editor — MTG-4.3 (#4782) / MTG-4.4 (#4783).
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { jest } from '@jest/globals';

jest.mock('sonner', () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
  },
}));

import TenantMcpKeyCapabilitiesEditor from '../src/app/ade/dashboard/tenants/TenantMcpKeyCapabilitiesEditor';

const CATALOG = [
  { id: 'ping', description: 'Health check', toolset: 'health' },
  { id: 'spec.list', description: 'List specs', toolset: 'catalog' },
  { id: 'spec.search', description: 'Search specs', toolset: 'search' },
];

const CEILING = ['ping', 'spec.list'];

const KEYS = {
  keys: [
    {
      id: 'key-inherit',
      prefix: 'mcp_a',
      label: 'Inherit key',
      scope_json: { tenants: [], projects: [] },
      capability_mode: 'inherit',
      enabled_tools: [],
      created_at: '2026-07-01T00:00:00Z',
      revoked_at: null,
    },
    {
      id: 'key-custom',
      prefix: 'mcp_b',
      label: 'Custom key',
      scope_json: { tenants: [], projects: [] },
      capability_mode: 'explicit',
      enabled_tools: ['ping', 'spec.list'],
      created_at: '2026-07-02T00:00:00Z',
      revoked_at: null,
    },
  ],
};

let calls: { url: string; method: string; body: unknown }[] = [];

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
    const body = init?.body ? JSON.parse(init.body as string) : null;
    calls.push({ url, method, body });

    if (url.includes('/api/tenants/mcp-keys') && method === 'GET' && !url.includes('/capabilities')) {
      return jsonResponse({ success: true, data: KEYS });
    }
    if (url.includes('/capabilities/preview') && method === 'POST') {
      const mode = body?.mode;
      const enabled =
        mode === 'inherit'
          ? ['ping', 'spec.list']
          : (body?.enabled_tools as string[]) ?? [];
      return jsonResponse({
        success: true,
        data: {
          tools: [
            { tool_id: 'ping', enabled: enabled.includes('ping'), deny_reason: null },
            {
              tool_id: 'spec.list',
              enabled: enabled.includes('spec.list'),
              deny_reason: enabled.includes('spec.list') ? null : 'not_in_key_enable_set',
            },
            {
              tool_id: 'spec.search',
              enabled: false,
              deny_reason: 'not_in_ceiling',
            },
          ],
        },
      });
    }
    if (url.includes('/capabilities') && method === 'PUT') {
      return jsonResponse({
        success: true,
        data: {
          mode: body?.mode,
          enabled_tools: body?.mode === 'inherit' ? [] : body?.enabled_tools ?? [],
        },
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
  jest.useFakeTimers({ advanceTimers: true });
  mockFetch();
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

async function flushPreview() {
  await act(async () => {
    jest.advanceTimersByTime(300);
  });
  await waitFor(() => {
    expect(calls.some((c) => c.url.includes('/preview'))).toBe(true);
  });
}

describe('TenantMcpKeyCapabilitiesEditor', () => {
  it('lists keys and loads inherit mode by default for first key', async () => {
    render(
      <TenantMcpKeyCapabilitiesEditor
        catalog={CATALOG}
        ceilingToolIds={CEILING}
        policyRevision={0}
      />,
    );

    expect(await screen.findByText(/MCP API keys/i)).toBeInTheDocument();
    expect(await screen.findByLabelText(/Select MCP API key/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Inherit tenant defaults/i)).toBeChecked();
    expect(screen.getByLabelText(/Enable health for key/i)).toBeDisabled();
  });

  it('locks tools outside the ceiling in custom mode', async () => {
    render(
      <TenantMcpKeyCapabilitiesEditor
        catalog={CATALOG}
        ceilingToolIds={CEILING}
        policyRevision={0}
      />,
    );

    await screen.findByText(/MCP API keys/i);
    fireEvent.click(screen.getByLabelText(/Custom enable-set/i));

    expect(screen.getByLabelText(/spec.search enabled for key/i)).toBeDisabled();
    expect(screen.getByLabelText(/spec.search locked by ceiling/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Enable search for key/i)).toBeDisabled();
  });

  it('saves explicit capabilities with PUT body ⊆ ceiling', async () => {
    render(
      <TenantMcpKeyCapabilitiesEditor
        catalog={CATALOG}
        ceilingToolIds={CEILING}
        policyRevision={0}
      />,
    );

    await screen.findByText(/MCP API keys/i);

    fireEvent.click(screen.getByLabelText(/Custom enable-set/i));
    fireEvent.click(screen.getByLabelText(/Enable health for key/i));

    expect(
      await screen.findByText(/Unsaved key capability changes/i),
    ).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Save capabilities/i }));
    });

    await waitFor(() => {
      const put = calls.find(
        (c) => c.method === 'PUT' && c.url.includes('/capabilities') && !c.url.includes('/preview'),
      );
      expect(put?.body).toEqual({
        mode: 'explicit',
        enabled_tools: ['ping'],
      });
    });
  });

  it('shows effective summary from preview', async () => {
    render(
      <TenantMcpKeyCapabilitiesEditor
        catalog={CATALOG}
        ceilingToolIds={CEILING}
        policyRevision={0}
      />,
    );

    await screen.findByText(/MCP API keys/i);
    await flushPreview();

    const summary = screen.getByText(/Effective summary/i).closest('div')?.parentElement;
    expect(summary).toBeTruthy();
    expect(within(summary as HTMLElement).getByText(/tools enabled for calls/i)).toBeInTheDocument();
    expect(within(summary as HTMLElement).getByText(/ping/i)).toBeInTheDocument();
  });

  it('shows empty state with create CTA for admins when tenant has no MCP keys', async () => {
    // @ts-expect-error test double
    global.fetch = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method || 'GET';
      if (url.includes('/api/tenants/mcp-keys') && method === 'POST') {
        return jsonResponse({
          success: true,
          data: {
            id: 'key-new',
            prefix: 'mcp_n',
            label: 'Agent',
            scope_json: { tenants: [], projects: [] },
            capability_mode: 'inherit',
            enabled_tools: [],
            created_at: '2026-07-13T00:00:00Z',
            secret: 'mcp_n_one_time_secret',
          },
        });
      }
      return jsonResponse({ success: true, data: { keys: [] } });
    });

    render(
      <TenantMcpKeyCapabilitiesEditor
        catalog={CATALOG}
        ceilingToolIds={CEILING}
        policyRevision={0}
        isAdmin
      />,
    );

    expect(await screen.findByText(/No MCP API keys yet/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create MCP key/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Create MCP key/i }));
    fireEvent.change(screen.getByLabelText(/Label/i), { target: { value: 'Agent' } });
    fireEvent.click(screen.getByRole('button', { name: /^Create key$/i }));

    expect(await screen.findByText(/MCP API key created/i)).toBeInTheDocument();
    expect(screen.getByText('mcp_n_one_time_secret')).toBeInTheDocument();
  });

  it('hides create CTA for non-admins on empty keys', async () => {
    // @ts-expect-error test double
    global.fetch = jest.fn(() =>
      jsonResponse({ success: true, data: { keys: [] } }),
    );

    render(
      <TenantMcpKeyCapabilitiesEditor
        catalog={CATALOG}
        ceilingToolIds={CEILING}
        policyRevision={0}
        isAdmin={false}
      />,
    );

    expect(await screen.findByText(/No MCP API keys yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create MCP key/i })).not.toBeInTheDocument();
  });
});
