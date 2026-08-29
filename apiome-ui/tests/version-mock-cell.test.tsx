/**
 * Render/interaction tests for the version mock settings cell (#4443, SIM-2.2).
 *
 * Acceptance criteria under test:
 * - Toggle round-trips `PUT /api/versions/{id}/mock` and reports the persisted server state.
 * - Copying the mock URL shows a confirmation toast.
 * - The 30-day usage sparkline renders from rollup data and handles the empty state.
 * - Draft versions can enable a private mock (key-gated at runtime).
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { VersionMockCell } from '../src/app/components/ade/dashboard/VersionMockCell';
import { toast } from 'sonner';

jest.mock('sonner', () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}));

const MOCK_URL = 'http://localhost:8775/acme/petstore/1.0.0';

const baseProps = {
  versionRecordId: 'rev-1',
  projectId: 'proj-1',
  versionLabel: '1.0.0',
  published: true,
  mockEnabled: false,
  mockBaseUrl: null as string | null,
  onMockChanged: jest.fn(),
};

const renderCell = (overrides: Partial<React.ComponentProps<typeof VersionMockCell>> = {}) =>
  render(<VersionMockCell {...baseProps} {...overrides} />);

const getToggle = () => screen.getByRole('switch', { name: 'Mock for version 1.0.0' });

let consoleErrorSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  (global as { fetch: unknown }).fetch = jest.fn();
  // Failure-path tests intentionally exercise the component's console.error logging.
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
});

describe('VersionMockCell — toggle', () => {
  it('allows enabling a private draft mock', async () => {
    const onMockChanged = jest.fn();
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        version: { mockEnabled: true, mockPrivate: true, mockBaseUrl: MOCK_URL },
      }),
    });
    renderCell({ published: false, onMockChanged });

    fireEvent.click(getToggle());

    await waitFor(() =>
      expect(onMockChanged).toHaveBeenCalledWith({
        mockEnabled: true,
        mockBaseUrl: MOCK_URL,
        mockPrivate: true,
      })
    );
  });

  it('shows the private badge for an enabled draft mock', () => {
    renderCell({ published: false, mockEnabled: true, mockPrivate: true, mockBaseUrl: MOCK_URL });
    expect(screen.getByText('Private')).toBeInTheDocument();
  });

  it('round-trips enabling through the proxy route and reports server state', async () => {
    const onMockChanged = jest.fn();
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        version: { mockEnabled: true, mockBaseUrl: MOCK_URL },
      }),
    });
    renderCell({ onMockChanged });

    fireEvent.click(getToggle());

    await waitFor(() =>
      expect(onMockChanged).toHaveBeenCalledWith({
        mockEnabled: true,
        mockBaseUrl: MOCK_URL,
        mockPrivate: false,
      })
    );
    expect(global.fetch).toHaveBeenCalledWith('/api/versions/rev-1/mock', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'proj-1', enabled: true }),
    });
    expect(toast.success).toHaveBeenCalledWith(
      'Mock enabled for v1.0.0 — the mock URL is ready to share.'
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('round-trips disabling and clears the URL', async () => {
    const onMockChanged = jest.fn();
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, version: { mockEnabled: false, mockBaseUrl: null } }),
    });
    renderCell({ mockEnabled: true, mockBaseUrl: MOCK_URL, onMockChanged });

    fireEvent.click(getToggle());

    await waitFor(() =>
      expect(onMockChanged).toHaveBeenCalledWith({ mockEnabled: false, mockBaseUrl: null, mockPrivate: false })
    );
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/versions/rev-1/mock',
      expect.objectContaining({ body: JSON.stringify({ projectId: 'proj-1', enabled: false }) })
    );
    expect(toast.success).toHaveBeenCalledWith('Mock disabled for v1.0.0.');
  });

  it('surfaces the REST error and keeps state when the toggle fails', async () => {
    const onMockChanged = jest.fn();
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      json: async () => ({ success: false, error: 'Mock can only be enabled on a published version.' }),
    });
    renderCell({ onMockChanged });

    fireEvent.click(getToggle());

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Mock can only be enabled on a published version.')
    );
    expect(onMockChanged).not.toHaveBeenCalled();
  });

  it('falls back to a generic error toast when the request throws', async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error('network down'));
    renderCell();

    fireEvent.click(getToggle());

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Failed to enable mock for v1.0.0.')
    );
  });
});

describe('VersionMockCell — mock URL', () => {
  it('shows the URL and copies it with a confirmation toast', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderCell({ mockEnabled: true, mockBaseUrl: MOCK_URL });

    expect(screen.getByText(MOCK_URL)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy mock URL for version 1.0.0' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(MOCK_URL));
    expect(toast.success).toHaveBeenCalledWith('Mock URL copied to clipboard.');
  });

  it('shows an error toast when the clipboard write fails', async () => {
    Object.assign(navigator, { clipboard: { writeText: jest.fn().mockRejectedValue(new Error('denied')) } });
    renderCell({ mockEnabled: true, mockBaseUrl: MOCK_URL });

    fireEvent.click(screen.getByRole('button', { name: 'Copy mock URL for version 1.0.0' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to copy mock URL to clipboard.'));
  });

  it('hides the URL block while the mock is disabled', () => {
    renderCell({ mockEnabled: false, mockBaseUrl: null });
    expect(screen.queryByRole('button', { name: /Copy mock URL/ })).not.toBeInTheDocument();
  });
});

describe('VersionMockCell — usage sparkline', () => {
  it('renders the 30-day sparkline from rollup data', () => {
    const series = Array.from({ length: 30 }, (_, i) => i);
    renderCell({ mockEnabled: true, mockBaseUrl: MOCK_URL, usageSeries: series });
    // The metrics kit names the shape and then describes it (HIVE-2.6): `<label> — <summary>`.
    expect(
      screen.getByRole('img', { name: /^Mock requests for v1\.0\.0, last 30 days — 30 points/ })
    ).toBeInTheDocument();
  });

  it('says "No requests yet" when no usage was recorded (HIVE-6.2)', () => {
    renderCell({ mockEnabled: true, mockBaseUrl: MOCK_URL, usageSeries: [] });
    expect(screen.queryByRole('img', { name: /last 30 days/ })).not.toBeInTheDocument();
    expect(screen.getByText('No requests yet')).toBeInTheDocument();
  });

  it('renders no sparkline while usage is still loading', () => {
    renderCell({ mockEnabled: true, mockBaseUrl: MOCK_URL, usageSeries: undefined });
    expect(screen.queryByRole('img', { name: /last 30 days/ })).not.toBeInTheDocument();
  });

  it('renders no sparkline when the mock is disabled', () => {
    renderCell({ mockEnabled: false, usageSeries: [1, 2, 3] });
    expect(screen.queryByRole('img', { name: /last 30 days/ })).not.toBeInTheDocument();
  });
});

describe('VersionMockCell — editors (MSC-1.3, #5529)', () => {
  it('offers both mock editors beside an enabled mock', () => {
    renderCell({ mockEnabled: true, mockBaseUrl: MOCK_URL });

    expect(screen.getByTestId('version-mock-scenarios-button-rev-1')).toBeInTheDocument();
    expect(screen.getByTestId('version-mock-correlation-button-rev-1')).toBeInTheDocument();
  });

  it('opens the correlation editor on its own, leaving the scenario editor closed', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, correlation: null, operations: [], fixtures: [] }),
    });
    renderCell({ mockEnabled: true, mockBaseUrl: MOCK_URL });

    fireEvent.click(screen.getByTestId('version-mock-correlation-button-rev-1'));

    expect(await screen.findByTestId('mock-correlation-editor-rev-1')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-scenario-editor-rev-1')).not.toBeInTheDocument();
  });

  it('offers neither editor while the mock is disabled', () => {
    renderCell({ mockEnabled: false });

    expect(screen.queryByTestId('version-mock-correlation-button-rev-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('version-mock-scenarios-button-rev-1')).not.toBeInTheDocument();
  });
});
