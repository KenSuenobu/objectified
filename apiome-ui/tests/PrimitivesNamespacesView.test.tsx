/**
 * Namespaces & Scopes view + editor dialog (#3471).
 *
 * Verifies the namespaces table renders scope/visibility/default state, that system-core rows are
 * read-only while tenant rows are editable, and that the create flow POSTs the derived request body
 * to the namespace proxy.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';

// Radix Dialog needs a few browser APIs jsdom doesn't implement.
beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {};
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
  Element.prototype.scrollIntoView = () => {};
});

import PrimitivesNamespacesView, {
  describeNamespaceRemoval,
} from '../src/app/ade/dashboard/primitives/PrimitivesNamespacesView';
import { DialogProvider } from '../src/app/components/providers/DialogProvider';
import type { TypeNamespaceCollection } from '../src/app/ade/dashboard/primitives/primitivesRegistryTypes';

const NAMESPACES: TypeNamespaceCollection[] = [
  {
    id: 'ns-sys',
    tenant_id: null,
    namespace: 'std/v0/types',
    base_uri: 'https://api.apiome.dev/types/std/v0/',
    version_root: 'v0',
    description: null,
    scope: 'system',
    is_system: true,
    is_public: true,
    is_default: true,
    type_count: 56,
  },
  {
    id: 'ns-acme',
    tenant_id: 'tenant-1',
    namespace: 'tenant/acme/v1/types',
    base_uri: 'https://api.apiome.dev/types/tenant/acme/v1/',
    version_root: 'v1',
    description: 'Acme types',
    scope: 'tenant',
    is_system: false,
    is_public: false,
    is_default: false,
    type_count: 48,
  },
];

describe('PrimitivesNamespacesView', () => {
  const onRefresh = jest.fn();
  const onMessage = jest.fn();

  afterEach(() => {
    jest.restoreAllMocks();
    onRefresh.mockReset();
    onMessage.mockReset();
  });

  // The Remove action confirms through the app-wide dialog provider (mounted in `layout.tsx`), so
  // the view is rendered inside it here too.
  function renderView(namespaces = NAMESPACES) {
    return render(
      <DialogProvider>
        <PrimitivesNamespacesView
          namespaces={namespaces}
          unresolvedByNamespace={{}}
          loading={false}
          onRefresh={onRefresh}
          onMessage={onMessage}
        />
      </DialogProvider>
    );
  }

  it('renders the scope explainer cards and precedence order', () => {
    renderView();
    expect(screen.getByText(/System root/i)).toBeInTheDocument();
    expect(screen.getByText('Tenant namespaces')).toBeInTheDocument();
    expect(screen.getByText(/Scope precedence/i)).toBeInTheDocument();
    expect(screen.getByText(/Promote to core/i)).toBeInTheDocument();
  });

  it('lists each namespace with scope, version root, and type count', () => {
    renderView();
    expect(screen.getByText('std/v0/types')).toBeInTheDocument();
    expect(screen.getByText('tenant/acme/v1/types')).toBeInTheDocument();
    expect(screen.getAllByText(/System · core/i).length).toBeGreaterThan(0);
    expect(screen.getByText('48')).toBeInTheDocument();
  });

  it('marks system namespaces read-only and tenant namespaces editable', () => {
    renderView();
    const systemRow = screen.getByText('std/v0/types').closest('tr')!;
    expect(within(systemRow).getByText(/Read-only/i)).toBeInTheDocument();
    expect(within(systemRow).queryByText('Edit')).not.toBeInTheDocument();

    const tenantRow = screen.getByText('tenant/acme/v1/types').closest('tr')!;
    expect(within(tenantRow).getByText('Edit')).toBeInTheDocument();
  });

  it('shows an empty state when there are no namespaces', () => {
    renderView([]);
    expect(screen.getByText('No Namespaces Yet')).toBeInTheDocument();
  });

  it('creates a namespace via POST when the dialog form is submitted', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, namespace: { id: 'ns-new' } }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    renderView();
    fireEvent.click(screen.getByRole('button', { name: /New namespace/i }));

    const pathInput = await screen.findByLabelText('Namespace path');
    fireEvent.change(pathInput, { target: { value: 'tenant/acme/v2/payments' } });

    fireEvent.click(screen.getByRole('button', { name: /Create namespace/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/types/namespaces');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      namespace: 'tenant/acme/v2/payments',
      scope: 'tenant',
      is_default: false,
    });
    await waitFor(() => expect(onMessage).toHaveBeenCalledWith('success', 'Namespace created'));
    expect(onRefresh).toHaveBeenCalled();
  });

  it('blocks submission and surfaces a validation error for a bad path', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    renderView();
    fireEvent.click(screen.getByRole('button', { name: /New namespace/i }));

    const pathInput = await screen.findByLabelText('Namespace path');
    fireEvent.change(pathInput, { target: { value: 'std/v9/types' } });

    const createBtn = screen.getByRole('button', { name: /Create namespace/i });
    expect(createBtn).toBeDisabled();
    fireEvent.click(createBtn);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(/reserved for platform system-core/i)).toBeInTheDocument();
  });

  it('edits a tenant namespace via PUT without sending the immutable path', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, namespace: { id: 'ns-acme' } }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    renderView();
    const tenantRow = screen.getByText('tenant/acme/v1/types').closest('tr')!;
    fireEvent.click(within(tenantRow).getByText('Edit'));

    // The path field is disabled (immutable) in edit mode.
    expect(await screen.findByLabelText('Namespace path')).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /Save changes/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/types/namespaces/ns-acme');
    expect(init.method).toBe('PUT');
    const body = JSON.parse(init.body);
    expect(body).not.toHaveProperty('namespace');
    expect(body.base_uri).toBe('https://api.apiome.dev/types/tenant/acme/v1/');
    await waitFor(() => expect(onMessage).toHaveBeenCalledWith('success', 'Namespace updated'));
  });
});

describe('describeNamespaceRemoval', () => {
  const tenant = NAMESPACES[1];

  it('states that the types survive, and how many there are', () => {
    const message = describeNamespaceRemoval(tenant);
    expect(message).toContain('tenant/acme/v1/types');
    expect(message).toContain('Its 48 types are not deleted');
    expect(message).toContain('unregistered');
  });

  it('says so plainly when nothing uses the namespace', () => {
    expect(describeNamespaceRemoval({ ...tenant, type_count: 0 })).toContain('No types use it.');
  });

  it('uses the singular for a lone type', () => {
    const message = describeNamespaceRemoval({ ...tenant, type_count: 1 });
    expect(message).toContain('Its 1 type is not deleted');
    expect(message).toContain('it keeps this namespace path');
  });

  it('warns when the namespace is the tenant default', () => {
    expect(describeNamespaceRemoval({ ...tenant, is_default: true })).toContain(
      'currently the default namespace'
    );
    expect(describeNamespaceRemoval(tenant)).not.toContain('default namespace');
  });
});

describe('PrimitivesNamespacesView — removing a namespace registration', () => {
  const onRefresh = jest.fn();
  const onMessage = jest.fn();

  afterEach(() => {
    jest.restoreAllMocks();
    onRefresh.mockReset();
    onMessage.mockReset();
  });

  function renderView(namespaces = NAMESPACES) {
    return render(
      <DialogProvider>
        <PrimitivesNamespacesView
          namespaces={namespaces}
          unresolvedByNamespace={{}}
          loading={false}
          onRefresh={onRefresh}
          onMessage={onMessage}
        />
      </DialogProvider>
    );
  }

  async function removeNamespace(namespace: string) {
    fireEvent.click(screen.getByTestId(`remove-namespace-${namespace}`));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
  }

  it('offers Remove on tenant rows but never on read-only system rows', () => {
    renderView();

    expect(screen.getByTestId('remove-namespace-tenant/acme/v1/types')).toBeInTheDocument();
    expect(screen.queryByTestId('remove-namespace-std/v0/types')).not.toBeInTheDocument();
  });

  it('DELETEs the namespace and refreshes once the removal is confirmed', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, namespace: 'tenant/acme/v1/types', unregisteredTypeCount: 48 }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    renderView();
    await removeNamespace('tenant/acme/v1/types');

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/types/namespaces/ns-acme');
    expect(init.method).toBe('DELETE');
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
  });

  it('reports how many types were left unregistered', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, namespace: 'tenant/acme/v1/types', unregisteredTypeCount: 48 }),
    }) as unknown as typeof fetch;

    renderView();
    await removeNamespace('tenant/acme/v1/types');

    await waitFor(() =>
      expect(onMessage).toHaveBeenCalledWith(
        'success',
        'Namespace “tenant/acme/v1/types” removed — 48 types are now unregistered'
      )
    );
  });

  it('omits the unregistered count when the namespace held no types', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, namespace: 'tenant/acme/v1/types', unregisteredTypeCount: 0 }),
    }) as unknown as typeof fetch;

    renderView([NAMESPACES[0], { ...NAMESPACES[1], type_count: 0 }]);
    await removeNamespace('tenant/acme/v1/types');

    await waitFor(() =>
      expect(onMessage).toHaveBeenCalledWith('success', 'Namespace “tenant/acme/v1/types” removed')
    );
  });

  it('does nothing when the confirmation is cancelled', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    renderView();
    fireEvent.click(screen.getByTestId('remove-namespace-tenant/acme/v1/types'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('surfaces the API error and does not refresh when the removal is rejected', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      json: async () => ({
        success: false,
        error: 'System namespaces are read-only; platform administrator role required',
      }),
    }) as unknown as typeof fetch;

    renderView();
    await removeNamespace('tenant/acme/v1/types');

    await waitFor(() =>
      expect(onMessage).toHaveBeenCalledWith(
        'error',
        'System namespaces are read-only; platform administrator role required'
      )
    );
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('surfaces a network failure rather than leaving the row stuck', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    global.fetch = jest.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;

    renderView();
    await removeNamespace('tenant/acme/v1/types');

    await waitFor(() =>
      expect(onMessage).toHaveBeenCalledWith('error', 'Failed to remove namespace')
    );
    // The button is re-enabled, so a retry is possible.
    expect(screen.getByTestId('remove-namespace-tenant/acme/v1/types')).not.toBeDisabled();
  });

  it('shows the referential consequence in the confirmation before anything is sent', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    renderView();
    fireEvent.click(screen.getByTestId('remove-namespace-tenant/acme/v1/types'));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('are not deleted');
    expect(dialog).toHaveTextContent('unregistered');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
