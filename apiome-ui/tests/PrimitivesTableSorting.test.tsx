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

/** Header label per sortable column, as `DataTable` draws it. */
const HEADER_LABEL: Record<string, string> = {
  name: 'Name',
  namespace: 'Namespace',
  category: 'Category',
  description: 'Description',
  usage: 'Usage',
  type: 'Type',
};

/**
 * The types table, located via its caption — the screen also renders the Type collections
 * table, so `getByRole('table')` is ambiguous here.
 */
function typesTable(): HTMLTableElement {
  return screen.getByRole('table', { name: 'Primitives' }) as HTMLTableElement;
}

/** One column's `<th>` in the types table. */
function sortHeader(column: string): HTMLTableCellElement {
  return within(typesTable()).getByRole('columnheader', {
    name: new RegExp(`^${HEADER_LABEL[column]}$`, 'i'),
  }) as HTMLTableCellElement;
}

/** The button inside that header, which is what a click on the column hits. */
function sortControl(column: string): HTMLButtonElement {
  return within(sortHeader(column)).getByRole('button') as HTMLButtonElement;
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
  await waitFor(() => expect(sortHeader('name')).toBeInTheDocument());
  await waitFor(() => expect(renderedNameOrder().length).toBe(3));
}

describe('Primitives table — column sorting', () => {
  afterEach(() => jest.restoreAllMocks());

  it('opens sorted by name ascending, with that column marked', async () => {
    await renderTable();

    expect(renderedNameOrder()).toEqual(['address', 'balance', 'charge']);
    expect(sortHeader('name')).toHaveAttribute(
      'aria-sort',
      'ascending'
    );
  });

  it('offers a sort control on every data column but not on Actions', async () => {
    await renderTable();

    for (const column of ['name', 'namespace', 'category', 'description', 'usage', 'type']) {
      expect(sortControl(column)).toBeInTheDocument();
    }
    const actionsHeader = within(typesTable()).getByRole('columnheader', { name: 'Actions' });
    expect(within(actionsHeader).queryByRole('button')).not.toBeInTheDocument();
  });

  it('reverses the order when the active column is clicked again', async () => {
    await renderTable();

    fireEvent.click(sortControl('name'));

    expect(renderedNameOrder()).toEqual(['charge', 'balance', 'address']);
    expect(sortHeader('name')).toHaveAttribute(
      'aria-sort',
      'descending'
    );
  });

  it('sorts usage numerically, most-used first on the second click', async () => {
    await renderTable();

    fireEvent.click(sortControl('usage'));
    expect(renderedNameOrder()).toEqual(['balance', 'charge', 'address']);

    fireEvent.click(sortControl('usage'));
    expect(renderedNameOrder()).toEqual(['address', 'charge', 'balance']);
  });

  it('sorts by type, system types first', async () => {
    await renderTable();

    fireEvent.click(sortControl('type'));
    expect(renderedNameOrder()[0]).toBe('address');

    fireEvent.click(sortControl('type'));
    expect(renderedNameOrder()[2]).toBe('address');
  });

  it('keeps a type with no namespace at the bottom in both directions', async () => {
    await renderTable();

    fireEvent.click(sortControl('namespace'));
    // `charge` has no namespace, so it trails the two that do.
    expect(renderedNameOrder()[2]).toBe('charge');

    fireEvent.click(sortControl('namespace'));
    expect(renderedNameOrder()[2]).toBe('charge');
  });

  it('moves the sort indicator to whichever column is active', async () => {
    await renderTable();

    fireEvent.click(sortControl('category'));

    expect(sortHeader('category')).toHaveAttribute(
      'aria-sort',
      'ascending'
    );
    expect(sortHeader('name')).toHaveAttribute(
      'aria-sort',
      'none'
    );
  });

  it('keeps the chosen sort while the search filter narrows the list', async () => {
    await renderTable();

    fireEvent.click(sortControl('usage'));
    fireEvent.click(sortControl('usage'));
    expect(renderedNameOrder()).toEqual(['address', 'charge', 'balance']);

    // Filtering re-runs the sort; it must not fall back to name-ascending.
    fireEvent.change(screen.getByPlaceholderText('Search primitives...'), {
      target: { value: 'a' },
    });

    await waitFor(() => expect(renderedNameOrder()).toEqual(['address', 'charge', 'balance']));
  });
});
