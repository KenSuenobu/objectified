/**
 * Column sorting on the primitives (types) table of the Primitives dashboard.
 *
 * The comparator itself is unit-tested in `unit/primitives-table-sort.test.ts`; these tests pin the
 * wiring the comparator cannot see — that every data column has a header control, that a click
 * reorders the rendered rows, that a second click reverses them, and that sorting composes with the
 * search/category filters instead of being reset by them.
 */

import React from 'react';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

jest.mock('@lib/auth/session-client', () => ({
  useAuthSession: () => ({ data: { user: { current_tenant_id: 'tenant-1' } } }),
}));

import PrimitivesManagementClient from '../src/app/ade/dashboard/primitives/PrimitivesManagementClient';
import { DialogProvider } from '../src/app/components/providers/DialogProvider';

const PRIMITIVES = [
  {
    id: 'p-charge',
    tenant_id: 'tenant-1',
    name: 'charge',
    description: 'A payment charge.',
    category: 'object',
    schema: {},
    tags: [],
    created_by: null,
    is_system: false,
    is_public: false,
    usage_count: 12,
    enabled: true,
    namespace: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 'p-address',
    tenant_id: null,
    name: 'address',
    description: null,
    category: 'object',
    schema: {},
    tags: [],
    created_by: null,
    is_system: true,
    is_public: true,
    usage_count: 40,
    enabled: true,
    namespace: 'std/v0/types',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 'p-balance',
    tenant_id: 'tenant-1',
    name: 'balance',
    description: 'An account balance.',
    category: 'numeric',
    schema: {},
    tags: [],
    created_by: null,
    is_system: false,
    is_public: false,
    usage_count: 3,
    enabled: true,
    namespace: 'tenant/acme/v1/types',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
];

/**
 * Route every dashboard fetch the screen fires on mount. Only `/api/primitives` carries content —
 * the registry-overview payloads still need their real shapes, since the screen reads into them.
 */
function mockDashboardFetch() {
  const payloads: Record<string, unknown> = {
    '/api/primitives': { success: true, primitives: PRIMITIVES },
    '/api/primitives/stats': { success: true, stats: null },
    '/api/types/namespaces': { success: true, namespaces: [] },
    '/api/primitives/imports?limit=8': { success: true, imports: [] },
    '/api/primitives/unresolved': { success: true, unresolved: { primitives: [] } },
  };
  return jest.fn().mockImplementation((url: string) =>
    Promise.resolve({
      ok: true,
      json: async () => payloads[url] ?? { success: true },
    })
  );
}

/**
 * The types table, located via one of its own headers — the screen also renders the Type collections
 * table, so `getByRole('table')` is ambiguous here.
 */
function typesTable(): HTMLTableElement {
  return screen.getByTestId('primitives-sort-name').closest('table') as HTMLTableElement;
}

/** The Name cell of each body row, top to bottom. */
function renderedNameOrder(): string[] {
  const rows = within(typesTable()).getAllByRole('row').slice(1); // drop the header row
  return rows.map((row) => within(row).getAllByRole('cell')[0].textContent?.trim() ?? '');
}

async function renderTable() {
  global.fetch = mockDashboardFetch() as unknown as typeof fetch;
  render(
    <DialogProvider>
      <PrimitivesManagementClient />
    </DialogProvider>
  );
  await waitFor(() => expect(screen.getByTestId('primitives-sort-name')).toBeInTheDocument());
  await waitFor(() => expect(renderedNameOrder().length).toBe(3));
}

describe('Primitives table — column sorting', () => {
  afterEach(() => jest.restoreAllMocks());

  it('opens sorted by name ascending, with that column marked', async () => {
    await renderTable();

    expect(renderedNameOrder()).toEqual(['address', 'balance', 'charge']);
    expect(screen.getByTestId('primitives-sort-name').closest('th')).toHaveAttribute(
      'aria-sort',
      'ascending'
    );
  });

  it('offers a sort control on every data column but not on Actions', async () => {
    await renderTable();

    for (const column of ['name', 'namespace', 'category', 'description', 'usage', 'type']) {
      expect(screen.getByTestId(`primitives-sort-${column}`)).toBeInTheDocument();
    }
    const actionsHeader = screen.getByText('Actions').closest('th')!;
    expect(within(actionsHeader).queryByRole('button')).not.toBeInTheDocument();
  });

  it('reverses the order when the active column is clicked again', async () => {
    await renderTable();

    fireEvent.click(screen.getByTestId('primitives-sort-name'));

    expect(renderedNameOrder()).toEqual(['charge', 'balance', 'address']);
    expect(screen.getByTestId('primitives-sort-name').closest('th')).toHaveAttribute(
      'aria-sort',
      'descending'
    );
  });

  it('sorts usage numerically, most-used first on the second click', async () => {
    await renderTable();

    fireEvent.click(screen.getByTestId('primitives-sort-usage'));
    expect(renderedNameOrder()).toEqual(['balance', 'charge', 'address']);

    fireEvent.click(screen.getByTestId('primitives-sort-usage'));
    expect(renderedNameOrder()).toEqual(['address', 'charge', 'balance']);
  });

  it('sorts by type, system types first', async () => {
    await renderTable();

    fireEvent.click(screen.getByTestId('primitives-sort-type'));
    expect(renderedNameOrder()[0]).toBe('address');

    fireEvent.click(screen.getByTestId('primitives-sort-type'));
    expect(renderedNameOrder()[2]).toBe('address');
  });

  it('keeps a type with no namespace at the bottom in both directions', async () => {
    await renderTable();

    fireEvent.click(screen.getByTestId('primitives-sort-namespace'));
    // `charge` has no namespace, so it trails the two that do.
    expect(renderedNameOrder()[2]).toBe('charge');

    fireEvent.click(screen.getByTestId('primitives-sort-namespace'));
    expect(renderedNameOrder()[2]).toBe('charge');
  });

  it('moves the sort indicator to whichever column is active', async () => {
    await renderTable();

    fireEvent.click(screen.getByTestId('primitives-sort-category'));

    expect(screen.getByTestId('primitives-sort-category').closest('th')).toHaveAttribute(
      'aria-sort',
      'ascending'
    );
    expect(screen.getByTestId('primitives-sort-name').closest('th')).toHaveAttribute(
      'aria-sort',
      'none'
    );
  });

  it('keeps the chosen sort while the search filter narrows the list', async () => {
    await renderTable();

    fireEvent.click(screen.getByTestId('primitives-sort-usage'));
    fireEvent.click(screen.getByTestId('primitives-sort-usage'));
    expect(renderedNameOrder()).toEqual(['address', 'charge', 'balance']);

    // Filtering re-runs the sort; it must not fall back to name-ascending.
    fireEvent.change(screen.getByPlaceholderText('Search primitives...'), {
      target: { value: 'a' },
    });

    await waitFor(() => expect(renderedNameOrder()).toEqual(['address', 'charge', 'balance']));
  });
});
