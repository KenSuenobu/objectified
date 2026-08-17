/**
 * Tenant MCP policy history panel — MTG-5.2 (#4786).
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { jest } from '@jest/globals';

import TenantMcpPolicyHistory from '../src/app/ade/dashboard/tenants/TenantMcpPolicyHistory';

const HISTORY = {
  changes: [
    {
      id: 'c1',
      actor_user_id: 'u1',
      actor_label: 'dana@acme.io',
      created_at: '2026-07-14T18:00:00Z',
      before_policy: {
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
      },
      after_policy: {
        default_mode: 'all',
        allow_anonymous_mcp: true,
        tools: [
          {
            tool_id: 'ping',
            in_ceiling: true,
            default_enabled: false,
            anonymous_enabled: true,
          },
        ],
      },
    },
  ],
};

function jsonResponse(payload: unknown) {
  return Promise.resolve({
    status: 200,
    ok: true,
    json: () => Promise.resolve(payload),
  } as Response);
}

beforeEach(() => {
  // @ts-expect-error test double
  global.fetch = jest.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/tenants/mcp-policy/history')) {
      return jsonResponse({ success: true, data: HISTORY });
    }
    return jsonResponse({ success: false, error: `Unhandled ${url}` });
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('TenantMcpPolicyHistory', () => {
  // HIVE-5.1 (#5304): the section no longer collapses itself — the manage drawer's
  // "Policy history" tab is the disclosure, and it only mounts this on first open. So
  // mounting *is* the request, and there is no expand button left to press.
  it('loads on mount, because the tab that mounts it is the disclosure', async () => {
    render(<TenantMcpPolicyHistory />);

    expect(
      screen.getByRole('heading', { name: /Policy history/i, level: 3 }),
    ).toBeInTheDocument();
    expect(await screen.findByText('dana@acme.io')).toBeInTheDocument();
    expect(global.fetch).toHaveBeenCalled();
  });

  it('expands a row to show before/after tool flags', async () => {
    render(<TenantMcpPolicyHistory />);

    expect(await screen.findByText('dana@acme.io')).toBeInTheDocument();
    expect(screen.getByText(/1 tool flag/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Toggle details/i }));

    await waitFor(() => {
      expect(screen.getByText('Tool-flag changes')).toBeInTheDocument();
    });
    // The diff line names the tool and the flag together, then the two values.
    expect(screen.getByText('ping · Default')).toBeInTheDocument();
    expect(screen.getByText('on')).toBeInTheDocument();
    expect(screen.getByText('off')).toBeInTheDocument();
  });

  it('refetches when reloadToken changes', async () => {
    const { rerender } = render(<TenantMcpPolicyHistory reloadToken={0} />);
    await screen.findByText('dana@acme.io');
    const callsAfterOpen = (global.fetch as jest.Mock).mock.calls.length;

    rerender(<TenantMcpPolicyHistory reloadToken={1} />);
    await waitFor(() => {
      expect((global.fetch as jest.Mock).mock.calls.length).toBeGreaterThan(callsAfterOpen);
    });
  });

  it('offers Refresh without needing to be expanded first', async () => {
    render(<TenantMcpPolicyHistory />);
    await screen.findByText('dana@acme.io');
    const before = (global.fetch as jest.Mock).mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: /Refresh policy history/i }));

    await waitFor(() => {
      expect((global.fetch as jest.Mock).mock.calls.length).toBeGreaterThan(before);
    });
  });
});
