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
    base_uri: 'https://api.apiome.app/types/std/v0/types/',
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
