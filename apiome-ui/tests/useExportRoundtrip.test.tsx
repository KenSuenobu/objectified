/**
 * useExportRoundtrip — the explicit round-trip comparison hook (IXH-4.4, #5112).
 *
 * The round trip is a real emit + re-import, so the hook must be **explicit only**: nothing
 * fetches on render, there is no auto mode, and `run` is the single entry point. The rest
 * mirrors the verify hook's configuration discipline (shared `verifyConfigKey` + session
 * cache): a result never outlives its (artifact, version, target, options), re-entering a
 * measured configuration settles instantly without a request, and failures are retryable
 * (never cached).
 */

import { renderHook, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { jest } from '@jest/globals';

import {
  useExportRoundtrip,
  __resetRoundtripCacheForTests,
} from '../src/app/components/ade/dashboard/export/useExportRoundtrip';

const RESULT = {
  success: true,
  artifact: 'proj-1',
  version: null,
  version_record_id: 'rev-1',
  version_label: '1.0.0',
  target: 'openapi-3.1',
  emit_key: 'openapi',
  adapter_key: 'openapi',
  status: 'pass',
  reason: null,
  diff_count: 0,
  matched_count: 0,
  matched: [],
  unexplained: [],
  overclaims: [],
  loss_drop: 0,
  loss_approx: 0,
  loss_synth: 0,
  loss_ok: 4,
  source_fingerprint: 'aaaa',
  reimported_fingerprint: 'aaaa',
  emitter_version: '1.0',
  apiome_version: '1.107.0',
  registry_version: '1',
};

beforeEach(() => __resetRoundtripCacheForTests());
afterEach(() => jest.restoreAllMocks());

describe('useExportRoundtrip', () => {
  it('never runs implicitly — rendering fires no request (the bounded-action AC)', () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const { result, rerender } = renderHook(() =>
      useExportRoundtrip('proj-1', null, 'openapi', null),
    );
    rerender();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.hasRun).toBe(false);
    expect(result.current.running).toBe(false);
  });

  it('does nothing when no target is selected', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const { result } = renderHook(() => useExportRoundtrip('proj-1', null, null, null));
    await act(async () => {
      await result.current.run();
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('runs on demand, posting the configuration to /api/export/roundtrip', async () => {
    const fetchMock = jest.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(RESULT) }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const { result } = renderHook(() =>
      useExportRoundtrip('proj-1', 'rev-1', 'openapi', { flatten: true }),
    );
    await act(async () => {
      await result.current.run();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/export/roundtrip');
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body).toEqual({
      artifact: 'proj-1',
      version: 'rev-1',
      target: 'openapi',
      options: { flatten: true },
    });
    expect(result.current.result?.status).toBe('pass');
    expect(result.current.fromCache).toBe(false);
  });

  it('serves an unchanged configuration from the session cache without a request', async () => {
    const fetchMock = jest.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(RESULT) }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const first = renderHook(() => useExportRoundtrip('proj-1', null, 'openapi', null));
    await act(async () => {
      await first.result.current.run();
    });
    first.unmount();

    const second = renderHook(() => useExportRoundtrip('proj-1', null, 'openapi', null));
    await act(async () => {
      await second.result.current.run();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.result.current.fromCache).toBe(true);
  });

  it('force re-runs past the cache (the "Re-run" action)', async () => {
    const fetchMock = jest.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(RESULT) }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const { result } = renderHook(() => useExportRoundtrip('proj-1', null, 'openapi', null));
    await act(async () => {
      await result.current.run();
    });
    await act(async () => {
      await result.current.run(true);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces a failed run and leaves it retryable (never cached)', async () => {
    const fetchMock = jest.fn(() =>
      Promise.resolve({ ok: false, json: () => Promise.resolve({ error: 'boom' }) }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const { result } = renderHook(() => useExportRoundtrip('proj-1', null, 'openapi', null));
    await act(async () => {
      await result.current.run();
    });
    expect(result.current.error).toBe('boom');
    expect(result.current.result).toBeNull();
    await act(async () => {
      await result.current.run();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('drops the result when the configuration changes (a comparison never outlives it)', async () => {
    const fetchMock = jest.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(RESULT) }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const { result, rerender } = renderHook(
      ({ target }: { target: string }) => useExportRoundtrip('proj-1', null, target, null),
      { initialProps: { target: 'openapi' } },
    );
    await act(async () => {
      await result.current.run();
    });
    expect(result.current.result).not.toBeNull();
    rerender({ target: 'proto' });
    expect(result.current.result).toBeNull();
    expect(result.current.hasRun).toBe(false);
  });

  it('reset evicts the cache entry so the next run re-measures', async () => {
    const fetchMock = jest.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(RESULT) }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const { result } = renderHook(() => useExportRoundtrip('proj-1', null, 'openapi', null));
    await act(async () => {
      await result.current.run();
    });
    act(() => {
      result.current.reset();
    });
    expect(result.current.result).toBeNull();
    await act(async () => {
      await result.current.run();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
