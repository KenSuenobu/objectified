/**
 * Reference Resolver view (#3470).
 *
 * Verifies the resolver renders the dependency table/graph from the resolve API,
 * shows resolved/unresolved/circular states, filters by status, and re-resolves
 * (calling the API again and announcing the result).
 */

import React from 'react';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom';

import ResolverPanel from '../src/app/components/ade/primitives/ResolverPanel';

const RESOLVE_RESPONSE = {
  total_primitives: 3,
  ref_count: 4,
  resolved_ref_count: 2,
  unresolved_ref_count: 1,
  affected_primitive_count: 1,
  reresolved_primitive_count: 2,
  primitives: [
    {
      id: 'p-date',
      name: 'date',
      namespace: 'std/v0/types',
      base_uri: 'https://api.apiome.dev/types/std/v0/types/',
      ref_count: 1,
      resolved_count: 1,
      unresolved_count: 0,
      refs: [
        {
          relative_ref: '../primitives/string',
          resolved_target: 'https://api.apiome.dev/types/std/v0/primitives/string',
          status: 'resolved',
          target_id: 'p-string',
          target_name: 'string',
        },
      ],
    },
    {
      id: 'p-charge',
      name: 'charge',
      namespace: 'tenant/acme/v1/payments',
      base_uri: 'https://api.apiome.dev/types/tenant/acme/v1/payments/',
      ref_count: 2,
      resolved_count: 1,
      unresolved_count: 1,
      refs: [
        {
          relative_ref: '../../../std/v0/types/money',
          resolved_target: 'https://api.apiome.dev/types/std/v0/types/money',
          status: 'resolved',
          target_id: 'p-money',
          target_name: 'money',
        },
        {
          relative_ref: './discount',
          resolved_target: 'https://api.apiome.dev/types/tenant/acme/v1/payments/discount',
          status: 'unresolved',
          target_id: null,
          target_name: null,
        },
      ],
    },
    {
      id: 'p-node',
      name: 'node',
      namespace: 'tenant/globex/v2/types',
      base_uri: 'https://api.apiome.dev/types/tenant/globex/v2/types/',
      ref_count: 1,
      resolved_count: 0,
      unresolved_count: 0,
      refs: [
        {
          relative_ref: './edge',
          resolved_target: 'https://api.apiome.dev/types/tenant/globex/v2/types/edge',
          status: 'circular',
          target_id: 'p-edge',
          target_name: 'edge',
        },
      ],
    },
  ],
};

function mockResolve(payload: unknown = RESOLVE_RESPONSE) {
  return jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, resolve: payload }),
  });
}

describe('ResolverPanel', () => {
  afterEach(() => jest.restoreAllMocks());

  it('resolves on mount and renders summary chips, graph, and the resolution table', async () => {
    global.fetch = mockResolve() as unknown as typeof fetch;
    render(<ResolverPanel />);

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Reference resolution' })).toBeInTheDocument()
    );

    // POST resolve fired on mount.
    expect(global.fetch).toHaveBeenCalledWith('/api/types/resolve', { method: 'POST' });

    // Summary chips: 2 resolved · 1 unresolved · 1 circular.
    const summary = screen.getByRole('region', { name: 'Resolution summary' });
    expect(within(summary).getByTestId('resolver-summary-resolved')).toHaveTextContent('Resolved 2');
    expect(within(summary).getByTestId('resolver-summary-unresolved')).toHaveTextContent(
      'Unresolved 1'
    );
    expect(within(summary).getByTestId('resolver-summary-circular')).toHaveTextContent('Circular 1');

    // Resolution table shows source types and the three statuses.
    const table = screen.getByRole('table');
    expect(within(table).getByText('std/v0/types/date')).toBeInTheDocument();
    // charge has two edges → its source label appears on both rows.
    expect(within(table).getAllByText('tenant/acme/v1/payments/charge')).toHaveLength(2);
    expect(within(table).getAllByText('Resolved').length).toBeGreaterThanOrEqual(1);
    expect(within(table).getByText('Unresolved')).toBeInTheDocument();
    expect(within(table).getByText('Circular')).toBeInTheDocument();

    // Cross-scope tenant → core edge is flagged.
    expect(screen.getAllByText('cross-scope').length).toBeGreaterThanOrEqual(1);

    // Read-only resolution base from the data.
    expect(screen.getByText('https://api.apiome.dev/types/')).toBeInTheDocument();

    // "4 of 4 references shown" footer (no filter).
    expect(screen.getByText(/4 of 4 references shown/i)).toBeInTheDocument();
  });

  it('filters the table by status', async () => {
    global.fetch = mockResolve() as unknown as typeof fetch;
    render(<ResolverPanel />);
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());

    // The status filter is a `Segmented`, whose options are radios rather than buttons.
    fireEvent.click(screen.getByRole('radio', { name: 'Unresolved' }));

    const table = screen.getByRole('table');
    expect(within(table).getByText('tenant/acme/v1/payments/charge')).toBeInTheDocument();
    expect(within(table).queryByText('std/v0/types/date')).not.toBeInTheDocument();
    expect(screen.getByText(/1 of 4 references shown/i)).toBeInTheDocument();
  });

  it('re-resolves on button click and announces how many primitives were updated', async () => {
    global.fetch = mockResolve() as unknown as typeof fetch;
    const onMessage = jest.fn();
    render(<ResolverPanel onMessage={onMessage} />);
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Re-resolve/i }));

    await waitFor(() =>
      expect(onMessage).toHaveBeenCalledWith('success', expect.stringContaining('2 primitives updated'))
    );
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('shows an empty state when no primitive carries a $ref', async () => {
    global.fetch = mockResolve({ ...RESOLVE_RESPONSE, primitives: [] }) as unknown as typeof fetch;
    render(<ResolverPanel />);

    await waitFor(() =>
      expect(screen.getByText(/No references to resolve/i)).toBeInTheDocument()
    );
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('surfaces an error through onMessage when resolve fails', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ success: false, error: 'Tenant not found' }),
    }) as unknown as typeof fetch;
    const onMessage = jest.fn();
    render(<ResolverPanel onMessage={onMessage} />);

    await waitFor(() => expect(onMessage).toHaveBeenCalledWith('error', 'Tenant not found'));
  });
});

describe('ResolverPanel — opening a resolved target', () => {
  afterEach(() => jest.restoreAllMocks());

  async function renderResolved() {
    global.fetch = mockResolve() as unknown as typeof fetch;
    render(<ResolverPanel />);
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());
  }

  it('links each resolved target in the table to that type’s detail screen', async () => {
    await renderResolved();

    // std/v0/types/date → std/v0/primitives/string (target p-string).
    const link = screen.getByTestId('table-target-link-p-date:0');
    expect(link).toHaveAttribute('href', '/ade/dashboard/primitives/p-string');
    expect(link).toHaveTextContent('std/v0/primitives/string');
    expect(link).toHaveAccessibleName('View details for std/v0/primitives/string');
  });

  it('links the resolved target in the reference graph as well', async () => {
    await renderResolved();

    const link = screen.getByTestId('graph-target-link-p-charge:0');
    expect(link).toHaveAttribute('href', '/ade/dashboard/primitives/p-money');
    expect(link).toHaveTextContent('std/v0/types/money');
  });

  it('leaves an unresolved target as plain text in both surfaces', async () => {
    await renderResolved();

    // p-charge:1 is the unresolved ./discount edge — no target row, so nothing to open.
    expect(screen.queryByTestId('table-target-link-p-charge:1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('graph-target-link-p-charge:1')).not.toBeInTheDocument();
    // The target path is still shown, just not as a link.
    expect(
      screen.getAllByText('tenant/acme/v1/payments/discount').length
    ).toBeGreaterThanOrEqual(1);
  });

  it('links a circular edge, which still names a real type', async () => {
    await renderResolved();

    expect(screen.getByTestId('table-target-link-p-node:0')).toHaveAttribute(
      'href',
      '/ade/dashboard/primitives/p-edge'
    );
  });

  it('keeps the cross-scope badge outside the link', async () => {
    await renderResolved();

    const link = screen.getByTestId('table-target-link-p-charge:0');
    expect(link).not.toHaveTextContent('cross-scope');
    expect(link.closest('td')).toHaveTextContent('cross-scope');
  });

  it('drops the links along with the rows when a filter excludes them', async () => {
    await renderResolved();

    // The status filter is a `Segmented`, whose options are radios rather than buttons.
    fireEvent.click(screen.getByRole('radio', { name: 'Unresolved' }));

    expect(screen.queryByTestId('table-target-link-p-date:0')).not.toBeInTheDocument();
    expect(screen.queryByTestId('graph-target-link-p-date:0')).not.toBeInTheDocument();
  });
});
