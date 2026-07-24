/**
 * Render tests for the trust-drift and shadowing panels (CLX-3.4, #4858).
 *
 * Each panel owns its fetch; these mock `global.fetch` and assert the classified rendering: a
 * security regression reads as such (not a bare "changed"), a missing baseline prompts approval, and
 * a shadowed name is grouped with its host scope.
 */

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

import { TrustDriftAlertsPanel } from '../src/app/components/ui/mcp/TrustDriftAlertsPanel';
import { ShadowedNamesPanel } from '../src/app/components/ui/mcp/ShadowedNamesPanel';

function mockFetch(status: number, body: unknown) {
  return jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);
}

afterEach(() => {
  jest.restoreAllMocks();
});

const DRIFT_BODY = {
  drift: {
    unchanged: false,
    alert_severity: 'security_regression',
    has_regression: true,
    category_counts: { security_regression: 1 },
    gate: { status: 'blocked', blocking_categories: ['security_regression'], reason: 'x', enforced: false },
    changes: [
      {
        category: 'security_regression',
        component: 'capability',
        path: 'tool:search',
        summary: "tool 'search' no longer declares readOnlyHint",
        evidence: { baseline: {}, current: {} },
      },
    ],
  },
  notified: [],
};

describe('TrustDriftAlertsPanel', () => {
  it('renders the classified security regression and the gate', async () => {
    global.fetch = mockFetch(200, DRIFT_BODY) as unknown as typeof fetch;
    render(<TrustDriftAlertsPanel endpointId="11111111-1111-4111-8111-111111111111" />);
    await waitFor(() => expect(screen.getByText(/tool:search/)).toBeInTheDocument());
    // "Security regression" appears both as a count chip and the change chip.
    expect(screen.getAllByText(/Security regression/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Gate: blocked/i)).toBeInTheDocument();
  });

  it('prompts to approve a baseline when none exists (404)', async () => {
    global.fetch = mockFetch(404, { success: false }) as unknown as typeof fetch;
    render(<TrustDriftAlertsPanel endpointId="11111111-1111-4111-8111-111111111111" />);
    await waitFor(() => expect(screen.getByText(/No approved baseline yet/i)).toBeInTheDocument());
  });
});

describe('ShadowedNamesPanel', () => {
  it('renders a compact bell alert and expands to the shadowed groups', async () => {
    global.fetch = mockFetch(200, {
      advisory: true,
      group_count: 1,
      same_host_count: 0,
      cross_host_count: 1,
      groups: [
        {
          item_type: 'tool',
          name: 'search',
          host_scope: 'cross_host',
          endpoint_count: 2,
          endpoints: [
            { id: 'ep1', name: 'A', slug: 'a', host: 'a.example' },
            { id: 'ep2', name: 'B', slug: 'b', host: 'b.example' },
          ],
        },
      ],
    }) as unknown as typeof fetch;
    render(<ShadowedNamesPanel />);
    await waitFor(() => expect(screen.getByText(/1 shadowed name/i)).toBeInTheDocument());
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText(/tool:search/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /1 shadowed name/i }));
    await waitFor(() => expect(screen.getByText(/tool:search/)).toBeInTheDocument());
    expect(screen.getByText(/Cross host/i)).toBeInTheDocument();
  });

  it('renders nothing when the catalog has no shadowed names', async () => {
    global.fetch = mockFetch(200, {
      advisory: true,
      group_count: 0,
      groups: [],
    }) as unknown as typeof fetch;
    const { container } = render(<ShadowedNamesPanel />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(screen.queryByText(/No shadowed names/i)).not.toBeInTheDocument();
  });
});
