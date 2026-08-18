/**
 * Type Registry Settings view (#3472).
 *
 * Verifies the view loads settings + storage health, renders the registry-defaults banner,
 * persists only changed fields via a PUT, resets to defaults, and surfaces load/save errors.
 */

import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

import RegistrySettingsPanel from '../src/app/components/ade/primitives/RegistrySettingsPanel';
import { DEFAULT_SETTINGS } from '../src/app/ade/dashboard/primitives/primitivesSettingsModel';

const DEFAULTS_RESPONSE = { ...DEFAULT_SETTINGS, is_default: true };

const HEALTH_HEALTHY = {
  status: 'healthy',
  service: 'primitives-registry',
  database: 'apiome-db',
  connection: 'connected',
  storage_present: true,
};

/**
 * Mock fetch routing by URL: GET /api/types/settings, GET /api/primitives/health, and
 * PUT /api/types/settings. `settings` is the GET payload; `putResult` the PUT echo.
 */
function mockFetch({
  settings = DEFAULTS_RESPONSE,
  health = HEALTH_HEALTHY,
  putResult,
}: {
  settings?: Record<string, unknown>;
  health?: Record<string, unknown> | null;
  putResult?: Record<string, unknown>;
} = {}) {
  const put = jest.fn();
  const fetchMock = jest.fn((url: string, init?: RequestInit) => {
    if (url === '/api/types/settings' && init?.method === 'PUT') {
      put(JSON.parse(init.body as string));
      return Promise.resolve({
        ok: true,
        json: async () => ({ success: true, settings: putResult ?? { ...settings, is_default: false } }),
      });
    }
    if (url === '/api/types/settings') {
      return Promise.resolve({ ok: true, json: async () => ({ success: true, settings }) });
    }
    if (url === '/api/primitives/health') {
      return Promise.resolve({
        ok: true,
        json: async () =>
          health ? { success: true, health } : { success: false, error: 'no health' },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return { fetchMock, put };
}

describe('RegistrySettingsPanel', () => {
  afterEach(() => jest.restoreAllMocks());

  it('loads settings + health, shows the defaults banner and Connected status', async () => {
    const { fetchMock } = mockFetch();
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<RegistrySettingsPanel />);

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Registry storage' })).toBeInTheDocument()
    );

    expect(fetchMock).toHaveBeenCalledWith('/api/types/settings');
    expect(fetchMock).toHaveBeenCalledWith('/api/primitives/health');
    expect(screen.getByText(/using the registry defaults/i)).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
    // Default draft control reflects the loaded value.
    expect((screen.getByLabelText('Default draft') as HTMLSelectElement).value).toBe('2020-12');
  });

  it('disables Save until a field changes, then PUTs only the changed field', async () => {
    const { fetchMock, put } = mockFetch();
    global.fetch = fetchMock as unknown as typeof fetch;
    const onMessage = jest.fn();
    render(<RegistrySettingsPanel onMessage={onMessage} />);

    await waitFor(() => expect(screen.getByLabelText('Default draft')).toBeInTheDocument());

    const save = screen.getByRole('button', { name: /Save settings/i });
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Default draft'), { target: { value: '2019-09' } });
    expect(save).toBeEnabled();

    fireEvent.click(save);

    await waitFor(() => expect(put).toHaveBeenCalledWith({ default_draft: '2019-09' }));
    await waitFor(() =>
      expect(onMessage).toHaveBeenCalledWith('success', 'Registry settings saved')
    );
  });

  it('toggles the remote allowlist enable/disable state with the remote-$ref switch', async () => {
    const { fetchMock } = mockFetch();
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<RegistrySettingsPanel />);

    await waitFor(() => expect(screen.getByLabelText('Remote host allowlist')).toBeInTheDocument());

    const allowlist = screen.getByLabelText('Remote host allowlist') as HTMLTextAreaElement;
    expect(allowlist).toBeDisabled(); // allow_remote_refs defaults to false

    fireEvent.click(screen.getByRole('switch', { name: /Allow remote \$ref/i }));
    expect(allowlist).toBeEnabled();
  });

  it('resets edited fields back to the registry defaults', async () => {
    const saved = { ...DEFAULT_SETTINGS, default_draft: 'draft-07', is_default: false };
    const { fetchMock } = mockFetch({ settings: saved });
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<RegistrySettingsPanel />);

    await waitFor(() =>
      expect((screen.getByLabelText('Default draft') as HTMLSelectElement).value).toBe('draft-07')
    );

    fireEvent.click(screen.getByRole('button', { name: /Reset to defaults/i }));
    expect((screen.getByLabelText('Default draft') as HTMLSelectElement).value).toBe('2020-12');
    // Reset is a local change vs the saved baseline → Save becomes enabled.
    expect(screen.getByRole('button', { name: /Save settings/i })).toBeEnabled();
  });

  it('surfaces a load error through onMessage', async () => {
    const fetchMock = jest.fn((url: string) => {
      if (url === '/api/types/settings') {
        return Promise.resolve({ ok: false, json: async () => ({ success: false, error: 'No tenant' }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ success: true, health: HEALTH_HEALTHY }) });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const onMessage = jest.fn();
    render(<RegistrySettingsPanel onMessage={onMessage} />);

    await waitFor(() => expect(onMessage).toHaveBeenCalledWith('error', 'No tenant'));
  });

  it('shows Unavailable when the registry storage probe is unhealthy', async () => {
    const { fetchMock } = mockFetch({
      health: { status: 'unhealthy', connection: 'disconnected', storage_present: false, error: 'boom' },
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<RegistrySettingsPanel />);

    await waitFor(() => expect(screen.getByText('Unavailable')).toBeInTheDocument());
    expect(screen.getByText('boom')).toBeInTheDocument();
  });
});
