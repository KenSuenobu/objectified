/**
 * Type collections: unassigned types and unregistered namespaces.
 *
 * The panel lists `apiome.type_namespaces` rows, but a type's namespace is only a string on the
 * primitive and nothing registers it. Two whole classes of type were therefore invisible here: those
 * in a namespace nobody created (every import that named its own target), and those with no
 * namespace at all. These tests pin that both now have a row and both are selectable.
 */

import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom';

import PrimitivesNamespaceCollections from '../src/app/ade/dashboard/primitives/PrimitivesNamespaceCollections';
import type { TypeNamespaceCollection } from '../src/app/ade/dashboard/primitives/primitivesRegistryTypes';

const REGISTERED: TypeNamespaceCollection[] = [
  {
    id: 'ns-1',
    tenant_id: null,
    namespace: 'std/v0/types',
    base_uri: 'https://api.apiome.dev/types/std/v0/types/',
    version_root: 'v0',
    description: 'Core derived types.',
    scope: 'system',
    is_system: true,
    is_public: true,
    is_default: true,
    type_count: 9,
  },
];

const DETECTED = [{ namespace: 'self/v1/schemas/api/schemas', typeCount: 1 }];

/** A multi-row registry for the sort tests: deliberately not in any column's sorted order. */
const MANY: TypeNamespaceCollection[] = [
  { ...REGISTERED[0], id: 'ns-mid', namespace: 'tenant/v1/orders', scope: 'tenant', is_system: false, is_default: false, type_count: 12 },
  { ...REGISTERED[0], id: 'ns-low', namespace: 'std/v0/primitives', scope: 'system', type_count: 3 },
  { ...REGISTERED[0], id: 'ns-high', namespace: 'tenant/v1/billing', scope: 'tenant', is_system: false, is_default: false, type_count: 40 },
];

/**
 * The name line of each body row's Namespace cell, top to bottom — the first paragraph only, so the
 * description line underneath it does not become part of the compared order.
 */
function renderedNamespaceOrder(): string[] {
  const rows = screen.getAllByRole('row').slice(1); // drop the header row
  return rows.map(
    (row) => within(row).getAllByRole('cell')[0].querySelector('p')?.textContent ?? ''
  );
}

function renderPanel(overrides: Partial<React.ComponentProps<typeof PrimitivesNamespaceCollections>> = {}) {
  const props = {
    namespaces: REGISTERED,
    unresolvedByNamespace: {},
    scopeFilter: 'all' as const,
    onScopeFilterChange: jest.fn(),
    onNamespaceSelect: jest.fn(),
    unassignedCount: 38,
    detectedNamespaces: DETECTED,
    loading: false,
    ...overrides,
  };
  return { props, ...render(<PrimitivesNamespaceCollections {...props} />) };
}

describe('Type collections — unassigned namespaces', () => {
  it('shows a row for types that have no namespace, with the count', () => {
    renderPanel();

    const row = screen.getByTestId('unassigned-namespaces-row');
    expect(within(row).getByText('Unassigned namespaces')).toBeInTheDocument();
    expect(row).toHaveTextContent('38');
  });

  it('selects the unassigned group when its row is clicked', () => {
    const { props } = renderPanel();

    fireEvent.click(screen.getByTestId('unassigned-namespaces-row'));

    // The empty string is the sentinel the type filter matches null/blank namespaces with.
    expect(props.onNamespaceSelect).toHaveBeenCalledWith('');
  });

  it('hides the row when every type has a namespace', () => {
    renderPanel({ unassignedCount: 0 });
    expect(screen.queryByTestId('unassigned-namespaces-row')).not.toBeInTheDocument();
  });

  it('counts the unassigned types in the footer', () => {
    renderPanel();
    expect(screen.getByTestId('unassigned-type-count')).toHaveTextContent('38 unassigned');
  });
});

describe('Type collections — unregistered namespaces', () => {
  it('lists a namespace that types use but that has no collection row', () => {
    renderPanel();

    const row = screen.getByTestId('detected-namespace-self/v1/schemas/api/schemas');
    expect(row).toHaveTextContent('self/v1/schemas/api/schemas');
    expect(row).toHaveTextContent('unregistered');
    expect(row).toHaveTextContent('1');
  });

  it('selects the namespace when its row is clicked', () => {
    const { props } = renderPanel();

    fireEvent.click(screen.getByTestId('detected-namespace-self/v1/schemas/api/schemas'));

    expect(props.onNamespaceSelect).toHaveBeenCalledWith('self/v1/schemas/api/schemas');
  });

  it('counts the unregistered namespaces in the footer', () => {
    renderPanel();
    expect(screen.getByTestId('detected-namespace-count')).toHaveTextContent('1 unregistered');
  });
});

describe('Type collections — interaction with the scope filters', () => {
  it('hides both extra rows under a scope filter, since neither has a scope', () => {
    renderPanel({ scopeFilter: 'system' });

    expect(screen.queryByTestId('unassigned-namespaces-row')).not.toBeInTheDocument();
    expect(screen.queryByTestId('detected-namespace-self/v1/schemas/api/schemas')).not.toBeInTheDocument();
    // The registered system namespace still shows.
    expect(screen.getByText('std/v0/types')).toBeInTheDocument();
  });

  it('renders the table when the only content is unassigned types', () => {
    // Previously the panel short-circuited to "No namespace collections match this filter".
    renderPanel({ namespaces: [], detectedNamespaces: [], unassignedCount: 4 });

    expect(screen.getByTestId('unassigned-namespaces-row')).toBeInTheDocument();
    expect(screen.queryByText(/no namespace collections match/i)).not.toBeInTheDocument();
  });

  it('still shows the empty state when there is genuinely nothing', () => {
    renderPanel({ namespaces: [], detectedNamespaces: [], unassignedCount: 0 });

    expect(screen.getByText(/no namespace collections match/i)).toBeInTheDocument();
  });
});

describe('Type collections — column sorting', () => {
  function renderSortable() {
    const rendered = renderPanel({ namespaces: MANY, detectedNamespaces: [], unassignedCount: 0 });
    // Sorting of a grouped table is covered in `primitives-namespace-groups.test.ts`; these tests
    // pin the flat ordering, so the grouping the panel applies by default is switched off.
    fireEvent.click(screen.getByTestId('namespace-group-toggle'));
    return rendered;
  }

  it('opens in the registry order, with every column offering a sort control', () => {
    renderSortable();

    expect(renderedNamespaceOrder()).toEqual([
      'tenant/v1/orders',
      'std/v0/primitives',
      'tenant/v1/billing',
    ]);
    for (const column of ['namespace', 'scope', 'types', 'draft', 'status']) {
      expect(screen.getByTestId(`namespace-collections-sort-${column}`)).toBeInTheDocument();
    }
    // Nothing is sorted yet, so no header claims a direction.
    for (const header of screen.getAllByRole('columnheader')) {
      expect(header).toHaveAttribute('aria-sort', 'none');
    }
  });

  it('sorts by namespace ascending on the first click and descending on the second', () => {
    renderSortable();
    const header = screen.getByTestId('namespace-collections-sort-namespace');

    fireEvent.click(header);
    expect(renderedNamespaceOrder()).toEqual([
      'std/v0/primitives',
      'tenant/v1/billing',
      'tenant/v1/orders',
    ]);
    expect(header.closest('th')).toHaveAttribute('aria-sort', 'ascending');

    fireEvent.click(header);
    expect(renderedNamespaceOrder()).toEqual([
      'tenant/v1/orders',
      'tenant/v1/billing',
      'std/v0/primitives',
    ]);
    expect(header.closest('th')).toHaveAttribute('aria-sort', 'descending');
  });

  it('sorts the type count numerically in both directions', () => {
    renderSortable();
    const header = screen.getByTestId('namespace-collections-sort-types');

    fireEvent.click(header);
    expect(renderedNamespaceOrder()).toEqual([
      'std/v0/primitives',
      'tenant/v1/orders',
      'tenant/v1/billing',
    ]);

    fireEvent.click(header);
    expect(renderedNamespaceOrder()).toEqual([
      'tenant/v1/billing',
      'tenant/v1/orders',
      'std/v0/primitives',
    ]);
  });

  it('sorts by scope, system before tenant', () => {
    renderSortable();

    fireEvent.click(screen.getByTestId('namespace-collections-sort-scope'));
    expect(renderedNamespaceOrder()[0]).toBe('std/v0/primitives');

    fireEvent.click(screen.getByTestId('namespace-collections-sort-scope'));
    expect(renderedNamespaceOrder()[2]).toBe('std/v0/primitives');
  });

  it('sorts by status, unresolved namespaces last ascending', () => {
    renderPanel({
      namespaces: MANY,
      detectedNamespaces: [],
      unassignedCount: 0,
      unresolvedByNamespace: { 'tenant/v1/orders': 5 },
    });
    fireEvent.click(screen.getByTestId('namespace-group-toggle'));

    fireEvent.click(screen.getByTestId('namespace-collections-sort-status'));
    expect(renderedNamespaceOrder()[2]).toBe('tenant/v1/orders');

    fireEvent.click(screen.getByTestId('namespace-collections-sort-status'));
    expect(renderedNamespaceOrder()[0]).toBe('tenant/v1/orders');
  });

  it('sorts the unregistered and unassigned rows along with the registered ones', () => {
    // These rows used to be pinned below the table; a sort has to move them or the ordering lies.
    renderPanel({ namespaces: MANY, detectedNamespaces: DETECTED, unassignedCount: 38 });
    fireEvent.click(screen.getByTestId('namespace-group-toggle'));

    fireEvent.click(screen.getByTestId('namespace-collections-sort-types'));
    fireEvent.click(screen.getByTestId('namespace-collections-sort-types'));

    const order = renderedNamespaceOrder();
    // 38 unassigned outranks every collection except the 40-type one.
    expect(order[0]).toBe('tenant/v1/billing');
    expect(order[1]).toContain('Unassigned namespaces');
    // The single-type unregistered namespace lands at the bottom.
    expect(order[order.length - 1]).toContain('self/v1/schemas/api/schemas');
  });

  it('keeps a row clickable while sorted', () => {
    const { props } = renderSortable();

    fireEvent.click(screen.getByTestId('namespace-collections-sort-namespace'));
    fireEvent.click(screen.getAllByRole('row')[1]);

    expect(props.onNamespaceSelect).toHaveBeenCalledWith('std/v0/primitives');
  });
});

describe('Type collections — grouping by parent namespace', () => {
  /** Two families plus a loner: `tenant/v1` has two members, `std/v0/types` has none. */
  const TENANT = { ...REGISTERED[0], scope: 'tenant' as const, is_system: false, is_default: false };
  const FAMILY: TypeNamespaceCollection[] = [
    { ...TENANT, id: 'ns-a', namespace: 'tenant/v1/orders', description: null, type_count: 4 },
    { ...TENANT, id: 'ns-b', namespace: 'tenant/v1/billing', description: null, type_count: 6 },
    { ...REGISTERED[0], id: 'ns-solo', namespace: 'std/v0/types', description: null, type_count: 9 },
  ];

  function renderGrouped(
    overrides: Partial<React.ComponentProps<typeof PrimitivesNamespaceCollections>> = {}
  ) {
    return renderPanel({
      namespaces: FAMILY,
      detectedNamespaces: [],
      unassignedCount: 0,
      ...overrides,
    });
  }

  it('collapses namespaces that share a parent into one row, aggregating the counts', () => {
    renderGrouped();

    const group = screen.getByTestId('namespace-group-tenant/v1');
    expect(group).toHaveTextContent('tenant/v1');
    expect(group).toHaveTextContent('2 namespaces · 10 types');
    // Collapsed by default: the members are folded away behind the group row.
    expect(screen.queryByText('tenant/v1/orders')).not.toBeInTheDocument();
    expect(screen.queryByText('tenant/v1/billing')).not.toBeInTheDocument();
  });

  it('leaves a namespace with no siblings as a top-level row', () => {
    renderGrouped();

    expect(screen.getByText('std/v0/types')).toBeInTheDocument();
    expect(screen.queryByTestId('namespace-group-std/v0')).not.toBeInTheDocument();
  });

  it('expands and collapses the group from its chevron', () => {
    renderGrouped();
    const toggle = screen.getByTestId('namespace-group-expand-tenant/v1');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('tenant/v1/orders')).toBeInTheDocument();
    expect(screen.getByText('tenant/v1/billing')).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('tenant/v1/orders')).not.toBeInTheDocument();
  });

  it('expanding does not also select the group', () => {
    // The chevron and the row are different affordances in the same row; the chevron must not fire
    // the row's filter as well.
    const { props } = renderGrouped();

    fireEvent.click(screen.getByTestId('namespace-group-expand-tenant/v1'));

    expect(props.onNamespaceSelect).not.toHaveBeenCalled();
  });

  it('selects the whole family when the group row is clicked', () => {
    const { props } = renderGrouped();

    fireEvent.click(screen.getByTestId('namespace-group-tenant/v1'));

    expect(props.onNamespaceSelect).toHaveBeenCalledWith('tenant/v1', { includeDescendants: true });
  });

  it('still selects one namespace when a member inside the group is clicked', () => {
    const { props } = renderGrouped();

    fireEvent.click(screen.getByTestId('namespace-group-expand-tenant/v1'));
    fireEvent.click(screen.getByText('tenant/v1/orders').closest('tr')!);

    expect(props.onNamespaceSelect).toHaveBeenCalledWith('tenant/v1/orders');
  });

  it('marks the collection registered at the group prefix as its root', () => {
    renderGrouped({
      namespaces: [
        ...FAMILY,
        { ...REGISTERED[0], id: 'ns-root', namespace: 'tenant/v1', description: null, type_count: 1 },
      ],
    });

    fireEvent.click(screen.getByTestId('namespace-group-expand-tenant/v1'));

    const root = screen.getByText('root').closest('tr');
    expect(root).toHaveTextContent('tenant/v1');
    // The root is the family's first member, ahead of its descendants.
    const bodyRows = screen.getAllByRole('row').slice(1);
    expect(bodyRows[1]).toBe(root);
  });

  it('reports a mixed-scope group rather than claiming one scope', () => {
    renderGrouped({
      namespaces: [
        FAMILY[0],
        { ...FAMILY[1], scope: 'system' as const },
        FAMILY[2],
      ],
    });

    expect(screen.getByTestId('namespace-group-tenant/v1')).toHaveTextContent('Mixed');
  });

  it('sums unresolved refs across the family onto the group row', () => {
    renderGrouped({ unresolvedByNamespace: { 'tenant/v1/orders': 2, 'tenant/v1/billing': 3 } });

    expect(screen.getByTestId('namespace-group-tenant/v1')).toHaveTextContent('5 unresolved');
  });

  it('counts the groups in the footer', () => {
    renderGrouped();
    expect(screen.getByTestId('namespace-group-count')).toHaveTextContent('1 group');
  });

  it('flattens back to one row per namespace when grouping is switched off', () => {
    renderGrouped();

    fireEvent.click(screen.getByTestId('namespace-group-toggle'));

    expect(screen.queryByTestId('namespace-group-tenant/v1')).not.toBeInTheDocument();
    expect(screen.getByText('tenant/v1/orders')).toBeInTheDocument();
    expect(screen.getByText('tenant/v1/billing')).toBeInTheDocument();
    expect(screen.queryByTestId('namespace-group-count')).not.toBeInTheDocument();
  });

  it('groups unregistered namespaces with each other, and never the unassigned bucket', () => {
    renderGrouped({
      namespaces: [],
      detectedNamespaces: [
        { namespace: 'self/v1/schemas/a', typeCount: 1 },
        { namespace: 'self/v1/schemas/b', typeCount: 2 },
      ],
      unassignedCount: 38,
    });

    expect(screen.getByTestId('namespace-group-self/v1/schemas')).toHaveTextContent(
      '2 namespaces · 3 types'
    );
    // The unassigned row sits on no path, so it stays a top-level row of its own.
    expect(screen.getByTestId('unassigned-namespaces-row')).toBeInTheDocument();
  });

  it('sorts group rows by their aggregate against ungrouped rows', () => {
    renderGrouped();

    // The tenant/v1 family totals 10 types; the lone std/v0/types row has 9.
    fireEvent.click(screen.getByTestId('namespace-collections-sort-types'));
    let bodyRows = screen.getAllByRole('row').slice(1);
    expect(bodyRows[0]).toHaveTextContent('std/v0/types');
    expect(bodyRows[1]).toHaveTextContent('tenant/v1');

    fireEvent.click(screen.getByTestId('namespace-collections-sort-types'));
    bodyRows = screen.getAllByRole('row').slice(1);
    expect(bodyRows[0]).toHaveTextContent('tenant/v1');
    expect(bodyRows[1]).toHaveTextContent('std/v0/types');
  });
});
