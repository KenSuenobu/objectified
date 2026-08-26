/**
 * The Export Studio's mock-server test drive (MFX-44.5, #4371).
 *
 * The panel and the hook together are the ticket's four acceptances, so this suite states them as
 * behaviour rather than as markup:
 *
 *  1. **Emitted OpenAPI gets a live mock URL in one click** — Start posts the export coordinates
 *     (never a document) and the base URL lands on screen, copyable.
 *  2. **Requests round-trip with schema-shaped responses** — Send calls the mock through the
 *     bridge with the path the user's parameter values build, and the answer, its status and the
 *     schema verdict come back into the panel and the log.
 *  3. **Instances expire** — the countdown is on screen while the mock is alive, and an expired
 *     instance says so instead of silently going quiet.
 *  4. **Absent infra degrades to hidden/disabled** — a target the engine cannot serve renders
 *     nothing; a server with no mock infrastructure renders a disabled Start with its reason.
 */

import React from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

import { MockTestDrivePanel } from '../src/app/components/ade/dashboard/export/MockTestDrivePanel';
import {
  resetMockCapabilityCache,
  useExportMockTestDrive,
} from '../src/app/components/ade/dashboard/export/useExportMockTestDrive';
import type {
  ExportMockCapability,
  ExportMockInstance,
  ExportMockRequestLog,
} from '../src/app/components/ade/dashboard/export/exportMockTestDrive';
import type { UseExportMockTestDriveResult } from '../src/app/components/ade/dashboard/export/useExportMockTestDrive';

const CAPABILITY: ExportMockCapability = {
  available: true,
  reason: null,
  supportedTargets: ['openapi'],
  defaultTtlMinutes: 30,
  maxTtlMinutes: 240,
  maxPerTenant: 3,
  rateLimitPerMinute: 60,
};

const INSTANCE: ExportMockInstance = {
  id: 'mock-1',
  baseUrl: 'http://rest.test/v1/mock/mock-1',
  status: 'active',
  target: 'openapi-3.1',
  targetKey: 'openapi',
  targetLabel: 'OpenAPI 3.1',
  artifact: 'artifact-1',
  version: '1.0.0',
  operationCount: 2,
  operations: [
    { method: 'GET', path: '/widgets', operationId: 'listWidgets' },
    { method: 'GET', path: '/widgets/{widgetId}', operationId: 'getWidget' },
  ],
  scenarios: ['happy-path', 'server-error'],
  activeScenario: 'happy-path',
  rateLimitPerMinute: 60,
  requestCount: 0,
  expiresInSeconds: 1800,
};

const LOG: ExportMockRequestLog = {
  mockId: 'mock-1',
  entries: [
    {
      at: '2026-08-26T14:22:07.000Z',
      method: 'GET',
      path: '/widgets',
      status: 200,
      matched: true,
      scenario: 'happy-path',
      operationId: 'GET /widgets',
      schemaValid: true,
      durationMs: 4,
    },
    {
      at: '2026-08-26T14:22:01.000Z',
      method: 'GET',
      path: '/nope',
      status: 404,
      matched: false,
      scenario: 'happy-path',
      operationId: null,
      schemaValid: null,
      durationMs: 1,
    },
  ],
  retained: 2,
  capacity: 50,
  truncated: false,
};

function testDrive(
  overrides: Partial<UseExportMockTestDriveResult> = {},
): UseExportMockTestDriveResult {
  return {
    capability: CAPABILITY,
    capabilityLoading: false,
    instance: null,
    reattached: false,
    busy: false,
    error: null,
    log: null,
    lastResult: null,
    sending: false,
    start: jest.fn(async () => undefined),
    stop: jest.fn(async () => undefined),
    restart: jest.fn(async () => undefined),
    send: jest.fn(async () => undefined),
    clearResult: jest.fn(),
    ...overrides,
  };
}

function renderPanel(overrides: Partial<UseExportMockTestDriveResult> = {}, targetKey = 'openapi') {
  const drive = testDrive(overrides);
  render(
    <MockTestDrivePanel testDrive={drive} targetKey={targetKey} targetLabel="OpenAPI 3.1" />,
  );
  return drive;
}

/* ------------------------------------------------------------------------ */
/* 4. Absent infrastructure degrades to hidden / disabled                    */
/* ------------------------------------------------------------------------ */

describe('a server or target that cannot mock', () => {
  it('renders nothing at all for a target the mock engine cannot serve', () => {
    renderPanel({}, 'protobuf');
    expect(screen.queryByTestId('mock-test-drive-panel')).not.toBeInTheDocument();
  });

  it('renders a disabled Start carrying the server’s own reason when infra is absent', () => {
    renderPanel({
      capability: { ...CAPABILITY, available: false, reason: 'The Mock Server is not enabled.' },
    });
    expect(screen.getByTestId('mock-unavailable')).toHaveTextContent(
      'The Mock Server is not enabled.',
    );
    expect(screen.getByTestId('mock-start')).toBeDisabled();
  });

  it('says it is still checking while the capability call is in flight', () => {
    renderPanel({ capability: null, capabilityLoading: true });
    expect(screen.getByTestId('mock-capability-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-start')).not.toBeInTheDocument();
  });

  it('never offers Start when the capability could not be read at all', () => {
    renderPanel({ capability: null, capabilityLoading: false });
    expect(screen.getByTestId('mock-start')).toBeDisabled();
  });
});

/* ------------------------------------------------------------------------ */
/* 1. One click, one live URL                                                */
/* ------------------------------------------------------------------------ */

describe('starting a mock', () => {
  it('offers one explicit action, and states the time limit before it is taken', () => {
    renderPanel();
    expect(screen.getByTestId('mock-start-prompt')).toHaveTextContent('30 minutes');
    expect(screen.getByTestId('mock-start')).toBeEnabled();
  });

  it('starts nothing on render — the mock exists only after the button', () => {
    const drive = renderPanel();
    expect(drive.start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('mock-start'));
    expect(drive.start).toHaveBeenCalledTimes(1);
  });

  it('shows the live base URL, copyable, once one is running', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderPanel({ instance: INSTANCE });

    expect(screen.getByTestId('mock-base-url')).toHaveTextContent(
      'http://rest.test/v1/mock/mock-1',
    );
    fireEvent.click(screen.getByTestId('mock-copy-url'));
    expect(writeText).toHaveBeenCalledWith('http://rest.test/v1/mock/mock-1');
    await waitFor(() => expect(screen.getByTestId('mock-copy-url')).toHaveTextContent('Copied'));
  });

  it('claims nothing when the browser has no clipboard to write to', async () => {
    Object.assign(navigator, { clipboard: undefined });
    renderPanel({ instance: INSTANCE });
    fireEvent.click(screen.getByTestId('mock-copy-url'));
    await waitFor(() =>
      expect(screen.getByTestId('mock-copy-url')).toHaveTextContent('Copy URL'),
    );
  });

  it('reports a refused start without gating the export', () => {
    renderPanel({ error: 'This workspace already has 3 live test-drive mocks (the limit is 3).' });
    expect(screen.getByTestId('mock-error')).toHaveTextContent('already has 3 live');
    // The artifact is untouched: Start is still offered, so the user can act on the reason.
    expect(screen.getByTestId('mock-start')).toBeInTheDocument();
  });

  it('labels a mock it found already running, and offers to restart it', () => {
    renderPanel({ instance: INSTANCE, reattached: true });
    expect(screen.getByTestId('mock-reattached')).toBeInTheDocument();
    expect(screen.getByTestId('mock-restart')).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------------ */
/* 3. Instances expire                                                       */
/* ------------------------------------------------------------------------ */

describe('the expiry of a running mock', () => {
  it('shows the countdown while it is alive', () => {
    renderPanel({ instance: INSTANCE });
    expect(screen.getByTestId('mock-live')).toHaveTextContent('Expires in 30:00');
  });

  it('says an expired mock has stopped answering instead of going quiet', () => {
    renderPanel({ instance: { ...INSTANCE, status: 'expired', expiresInSeconds: 0 } });
    expect(screen.getByTestId('mock-live')).toHaveTextContent('Expired');
    expect(screen.getByTestId('mock-expired-note')).toHaveTextContent('no longer answers');
    // Nothing can be sent to a mock that has stopped serving.
    expect(screen.queryByTestId('mock-try')).not.toBeInTheDocument();
  });

  it('lets the user stop it early', () => {
    const drive = renderPanel({ instance: INSTANCE });
    fireEvent.click(screen.getByTestId('mock-stop'));
    expect(drive.stop).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------------ */
/* 2. Requests round-trip with schema-shaped responses                       */
/* ------------------------------------------------------------------------ */

describe('sending a request to the mock', () => {
  it('lists every operation the frozen document declares', () => {
    renderPanel({ instance: INSTANCE });
    expect(screen.getByTestId('mock-operation-GET /widgets')).toBeInTheDocument();
    expect(screen.getByTestId('mock-operation-GET /widgets/{widgetId}')).toBeInTheDocument();
  });

  it('sends the chosen operation with the active scenario', () => {
    const drive = renderPanel({ instance: INSTANCE });
    fireEvent.click(screen.getByTestId('mock-send-GET /widgets'));
    expect(drive.send).toHaveBeenCalledWith(INSTANCE.operations[0], {}, 'happy-path');
  });

  it('carries the path-parameter values the user typed', () => {
    const drive = renderPanel({ instance: INSTANCE });
    const row = screen.getByTestId('mock-operation-GET /widgets/{widgetId}');
    fireEvent.change(row.querySelector('input') as HTMLInputElement, {
      target: { value: '42' },
    });
    fireEvent.click(screen.getByTestId('mock-send-GET /widgets/{widgetId}'));
    expect(drive.send).toHaveBeenCalledWith(
      INSTANCE.operations[1],
      { widgetId: '42' },
      'happy-path',
    );
  });

  it('sends under the scenario the user selected', () => {
    const drive = renderPanel({ instance: INSTANCE });
    fireEvent.change(screen.getByTestId('mock-scenario'), {
      target: { value: 'server-error' },
    });
    fireEvent.click(screen.getByTestId('mock-send-GET /widgets'));
    expect(drive.send).toHaveBeenCalledWith(INSTANCE.operations[0], {}, 'server-error');
  });

  it('shows the response body, its status and how long it took', () => {
    renderPanel({
      instance: INSTANCE,
      lastResult: {
        request: { method: 'GET', path: '/widgets', url: '/v1/mock/mock-1/widgets' },
        status: 200,
        durationMs: 7,
        headers: { 'x-mock-schema-valid': 'true', 'x-mock-scenario': 'happy-path' },
        body: '{"id":1,"name":"widget"}',
        truncated: false,
      },
    });
    expect(screen.getByTestId('mock-result-status')).toHaveTextContent('HTTP 200');
    expect(screen.getByTestId('mock-result-body')).toHaveTextContent('"name":"widget"');
    expect(screen.getByTestId('mock-result')).toHaveTextContent('7 ms');
  });

  it('calls out a response the document’s own schema does not describe', () => {
    renderPanel({
      instance: INSTANCE,
      lastResult: {
        request: { method: 'GET', path: '/widgets', url: '/v1/mock/mock-1/widgets' },
        status: 200,
        durationMs: 7,
        headers: { 'x-mock-schema-valid': 'false' },
        body: '{}',
        truncated: false,
      },
    });
    expect(screen.getByTestId('mock-result-schema-warning')).toHaveTextContent(
      'response it cannot satisfy',
    );
  });
});

/* ------------------------------------------------------------------------ */
/* The request log                                                           */
/* ------------------------------------------------------------------------ */

describe('the request log', () => {
  it('invites the first request when nothing has been served', () => {
    renderPanel({ instance: INSTANCE });
    expect(screen.getByTestId('mock-log-empty')).toHaveTextContent('No requests yet');
  });

  it('states each row’s outcome in words, not only in colour', () => {
    renderPanel({ instance: INSTANCE, log: LOG });
    const rows = screen.getAllByTestId('mock-log-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Schema-shaped response');
    expect(rows[0]).toHaveTextContent('/widgets');
    expect(rows[1]).toHaveTextContent('No operation matched');
    expect(rows[1]).toHaveTextContent('404');
  });

  it('admits when older traffic has rolled off the ring buffer', () => {
    renderPanel({ instance: INSTANCE, log: { ...LOG, truncated: true } });
    expect(screen.getByTestId('mock-log-truncated')).toHaveTextContent('most recent 50');
  });
});

/* ------------------------------------------------------------------------ */
/* The hook's own wiring                                                     */
/* ------------------------------------------------------------------------ */

describe('the test-drive hook', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    resetMockCapabilityCache();
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  const json = (body: unknown, ok = true) => ({
    ok,
    json: async () => body,
  });

  function routeFetch(handlers: Record<string, unknown>) {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${url}`;
      if (!(key in handlers)) return Promise.resolve(json({ success: false, error: 'unrouted' }, false));
      return Promise.resolve(json(handlers[key]));
    });
  }

  it('sends only the export coordinates when starting — never a document', async () => {
    routeFetch({
      'GET /api/export/mock/capability': { success: true, ...CAPABILITY },
      'GET /api/export/mock': { success: true, instances: [] },
      'POST /api/export/mock': { success: true, ...INSTANCE },
    });

    const { result } = renderHook(() =>
      useExportMockTestDrive('artifact-1', '1.0.0', 'openapi', { flatten: true }, true),
    );
    await waitFor(() => expect(result.current.capability).not.toBeNull());
    await act(async () => {
      await result.current.start();
    });

    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(post?.[1]?.body as string)).toEqual({
      artifact: 'artifact-1',
      version: '1.0.0',
      target: 'openapi',
      options: { flatten: true },
    });
    expect(result.current.instance?.baseUrl).toBe(INSTANCE.baseUrl);
  });

  it('surfaces the server’s refusal message rather than a generic failure', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/export/mock/capability') {
        return Promise.resolve(json({ success: true, ...CAPABILITY }));
      }
      if (url === '/api/export/mock' && init?.method === 'POST') {
        return Promise.resolve(
          json({ success: false, error: 'Stop one before starting another.' }, false),
        );
      }
      return Promise.resolve(json({ success: true, instances: [] }));
    });

    const { result } = renderHook(() =>
      useExportMockTestDrive('artifact-1', null, 'openapi', null, true),
    );
    await waitFor(() => expect(result.current.capability).not.toBeNull());
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.error).toBe('Stop one before starting another.');
    expect(result.current.instance).toBeNull();
  });

  it('adopts a mock already running for the same configuration', async () => {
    routeFetch({
      'GET /api/export/mock/capability': { success: true, ...CAPABILITY },
      'GET /api/export/mock': { success: true, instances: [INSTANCE] },
    });

    const { result } = renderHook(() =>
      useExportMockTestDrive('artifact-1', '1.0.0', 'openapi', null, true),
    );
    await waitFor(() => expect(result.current.instance?.id).toBe('mock-1'));
    expect(result.current.reattached).toBe(true);
  });

  it('does not adopt a mock of a different target or revision', async () => {
    routeFetch({
      'GET /api/export/mock/capability': { success: true, ...CAPABILITY },
      'GET /api/export/mock': {
        success: true,
        instances: [{ ...INSTANCE, version: '2.0.0' }],
      },
    });

    const { result } = renderHook(() =>
      useExportMockTestDrive('artifact-1', '1.0.0', 'openapi', null, true),
    );
    await waitFor(() => expect(result.current.capability).not.toBeNull());
    expect(result.current.instance).toBeNull();
  });

  it('reads the capability once per page load, however many panels ask', async () => {
    routeFetch({
      'GET /api/export/mock/capability': { success: true, ...CAPABILITY },
      'GET /api/export/mock': { success: true, instances: [] },
    });

    const first = renderHook(() =>
      useExportMockTestDrive('artifact-1', null, 'openapi', null, true),
    );
    await waitFor(() => expect(first.result.current.capability).not.toBeNull());
    const second = renderHook(() =>
      useExportMockTestDrive('artifact-2', null, 'openapi', null, true),
    );
    await waitFor(() => expect(second.result.current.capability).not.toBeNull());

    const capabilityCalls = fetchMock.mock.calls.filter(
      ([url]) => url === '/api/export/mock/capability',
    );
    expect(capabilityCalls).toHaveLength(1);
  });

  it('treats an unreadable capability as no infrastructure', async () => {
    fetchMock.mockResolvedValue(json({ success: false, error: 'boom' }, false));
    const { result } = renderHook(() =>
      useExportMockTestDrive('artifact-1', null, 'openapi', null, true),
    );
    await waitFor(() => expect(result.current.capabilityLoading).toBe(false));
    expect(result.current.capability).toBeNull();
  });

  it('drops the instance when the export configuration changes', async () => {
    routeFetch({
      'GET /api/export/mock/capability': { success: true, ...CAPABILITY },
      'GET /api/export/mock': { success: true, instances: [] },
      'POST /api/export/mock': { success: true, ...INSTANCE },
    });

    const { result, rerender } = renderHook(
      ({ target }: { target: string }) =>
        useExportMockTestDrive('artifact-1', '1.0.0', target, null, true),
      { initialProps: { target: 'openapi' } },
    );
    await waitFor(() => expect(result.current.capability).not.toBeNull());
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.instance).not.toBeNull();

    rerender({ target: 'protobuf' });
    await waitFor(() => expect(result.current.instance).toBeNull());
  });
});
