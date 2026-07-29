/**
 * The "detected namespaces" picker in the New namespace dialog.
 *
 * Registering a namespace that types already sit in is the fix for an imported namespace missing
 * from Type collections, so the paths already in use are offered rather than retyped.
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

import NamespaceEditorDialog from '../src/app/ade/dashboard/primitives/NamespaceEditorDialog';
import type { TypeNamespaceCollection } from '../src/app/ade/dashboard/primitives/primitivesRegistryTypes';

const DETECTED = [
  { namespace: 'self/v1/schemas/api/schemas', typeCount: 1 },
  { namespace: 'tenant/acme/v1/types', typeCount: 4 },
];

const EXISTING: TypeNamespaceCollection = {
  id: 'ns-1',
  tenant_id: 't-1',
  namespace: 'tenant/acme/v1/types',
  base_uri: 'https://api.apiome.app/types/tenant/acme/v1/types/',
  version_root: 'v1',
  description: null,
  scope: 'tenant',
  is_system: false,
  is_public: false,
  is_default: false,
  type_count: 4,
};

function renderDialog(props: Partial<React.ComponentProps<typeof NamespaceEditorDialog>> = {}) {
  return render(
    <NamespaceEditorDialog
      namespace={null}
      detectedNamespaces={DETECTED}
      onClose={jest.fn()}
      onSaved={jest.fn()}
      onMessage={jest.fn()}
      {...props}
    />,
  );
}

const pathInput = () => screen.getByLabelText('Namespace path') as HTMLInputElement;

describe('NamespaceEditorDialog — detected namespaces', () => {
  it('offers the detected namespaces with their type counts', () => {
    renderDialog();

    const select = screen.getByTestId('detected-namespace-select');
    expect(select).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /self\/v1\/schemas\/api\/schemas \(1 type\)/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /tenant\/acme\/v1\/types \(4 types\)/ })).toBeInTheDocument();
  });

  it('fills the namespace path when one is selected', () => {
    renderDialog();

    expect(pathInput().value).toBe('');

    fireEvent.change(screen.getByTestId('detected-namespace-select'), {
      target: { value: 'self/v1/schemas/api/schemas' },
    });

    expect(pathInput().value).toBe('self/v1/schemas/api/schemas');
  });

  it('leaves the path alone when the placeholder option is re-selected', () => {
    renderDialog();

    fireEvent.change(screen.getByTestId('detected-namespace-select'), {
      target: { value: 'tenant/acme/v1/types' },
    });
    fireEvent.change(screen.getByTestId('detected-namespace-select'), { target: { value: '' } });

    expect(pathInput().value).toBe('tenant/acme/v1/types');
  });

  it('is absent when nothing was detected', () => {
    renderDialog({ detectedNamespaces: [] });
    expect(screen.queryByTestId('detected-namespace-select')).not.toBeInTheDocument();
  });

  it('is absent when editing, where the path is immutable', () => {
    renderDialog({ namespace: EXISTING });

    expect(screen.queryByTestId('detected-namespace-select')).not.toBeInTheDocument();
    expect(pathInput()).toBeDisabled();
  });

  it('lets a selected path still be edited by hand before saving', () => {
    renderDialog();

    fireEvent.change(screen.getByTestId('detected-namespace-select'), {
      target: { value: 'self/v1/schemas/api/schemas' },
    });
    fireEvent.change(pathInput(), { target: { value: 'tenant/acme/v2/types' } });

    expect(pathInput().value).toBe('tenant/acme/v2/types');
  });
});
