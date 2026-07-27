/**
 * useExportVerify — the manual "Run verification" hook behind the Studio's Verify workbench
 * (MFX-42.1, #4354). Unlike the auto-fetching preview hook, verification is explicit: `run`
 * POSTs to `/api/export/verify`, and `reset` clears a stale verdict when the config changes.
 *
 * Also covers re-verify-on-change + result caching (MFX-42.6, #4359): a verdict is only ever
 * exposed for the configuration it was measured for, an unchanged configuration re-displays its
 * cached verdict without a request, and the opt-in auto mode re-verifies after a debounce.
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { jest } from '@jest/globals';

import { useExportVerify } from '../src/app/components/ade/dashboard/export/useExportVerify';
import { __resetVerifyCacheForTests } from '../src/app/components/ade/dashboard/export/exportVerifyCache';

const RESULT = {
  success: true,
  artifact: 'proj-1',
  version: null,
  version_record_id: 'rev-1',
  version_label: '1.0.0',
  fidelity: { summary: { tier: 'lossless' } },
  validation: { verdict: 'valid', blocks_delivery: false },
  lint: null,
  verdict: 'clean',
};

/** A fetch mock whose verify response resolves only when `release()` is called (to test in-flight). */
function deferredFetch() {
  let release!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const mock = jest.fn(() => pending.then(() => ({ ok: true, json: () => Promise.resolve(RESULT) })));
  return { mock, release };
}

// The session result cache is a module singleton (MFX-42.6): one test's cached verdict must never
// answer another's run.
beforeEach(() => __resetVerifyCacheForTests());
afterEach(() => jest.restoreAllMocks());

describe('useExportVerify', () => {
  it('is idle before any run', () => {
    global.fetch = jest.fn() as unknown as typeof fetch;
    const { result } = renderHook(() => useExportVerify('proj-1', null, 'openapi', null));
    expect(result.current.hasRun).toBe(false);
    expect(result.current.running).toBe(false);
    expect(result.current.result).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('does nothing when no target is selected', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const { result } = renderHook(() => useExportVerify('proj-1', null, null, null));
    await act(async () => {
      await result.current.run();
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.hasRun).toBe(false);
  });

  it('runs, exposes the settled result, and sends the changed options', async () => {
    const fetchMock = jest.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(RESULT) }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const { result } = renderHook(() =>
      useExportVerify('proj-1', 'rev-1', 'proto', { package: 'com.example' }),
    );

    await act(async () => {
      await result.current.run();
    });

    expect(result.current.hasRun).toBe(true);
    expect(result.current.result?.verdict).toBe('clean');
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(body).toEqual({
      artifact: 'proj-1',
      version: 'rev-1',
      target: 'proto',
      options: { package: 'com.example' },
    });
  });

  it('surfaces a failed run and keeps the gate closed (no result)', async () => {
    const fetchMock = jest.fn(() =>
      Promise.resolve({ ok: false, json: () => Promise.resolve({ error: 'boom' }) }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const { result } = renderHook(() => useExportVerify('proj-1', null, 'proto', null));
    await act(async () => {
      await result.current.run();
    });
    expect(result.current.error).toBe('boom');
    expect(result.current.result).toBeNull();
    expect(result.current.hasRun).toBe(true);
  });

  it('reset clears the result so a stale verdict cannot gate Generate', async () => {
    const fetchMock = jest.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(RESULT) }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const { result } = renderHook(() => useExportVerify('proj-1', null, 'proto', null));
    await act(async () => {
      await result.current.run();
    });
    expect(result.current.result).not.toBeNull();

    act(() => result.current.reset());
    expect(result.current.result).toBeNull();
    expect(result.current.hasRun).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('ignores an in-flight run superseded by reset', async () => {
    const { mock, release } = deferredFetch();
    global.fetch = mock as unknown as typeof fetch;
    const { result } = renderHook(() => useExportVerify('proj-1', null, 'proto', null));

    let runPromise!: Promise<void>;
    act(() => {
      runPromise = result.current.run();
    });
    expect(result.current.running).toBe(true);

    // Reset while the run is still in flight; the late response must not settle state.
    act(() => result.current.reset());
    await act(async () => {
      release(undefined);
      await runPromise;
    });
    expect(result.current.result).toBeNull();
    expect(result.current.hasRun).toBe(false);
    expect(result.current.running).toBe(false);
  });
});

describe('useExportVerify — re-verify on change + caching (MFX-42.6)', () => {
  /** A fetch mock that always resolves the clean verify payload. */
  function okFetch() {
    const mock = jest.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(RESULT) }));
    global.fetch = mock as unknown as typeof fetch;
    return mock;
  }

  /** Render the hook with a changeable configuration. */
  function renderVerify(initial: { target: string | null; options: Record<string, unknown> | null }) {
    return renderHook(
      (props: { target: string | null; options: Record<string, unknown> | null }) =>
        useExportVerify('proj-1', null, props.target, props.options),
      { initialProps: initial },
    );
  }

  it('drops the verdict as soon as the configuration changes', async () => {
    okFetch();
    const { result, rerender } = renderVerify({ target: 'proto', options: null });
    await act(async () => {
      await result.current.run();
    });
    expect(result.current.result?.verdict).toBe('clean');

    // A different target is a different conversion: no verdict, so Generate re-locks upstream.
    rerender({ target: 'openapi', options: null });
    expect(result.current.result).toBeNull();
    expect(result.current.hasRun).toBe(false);

    // …and so is a changed option.
    rerender({ target: 'proto', options: { package: 'com.example' } });
    expect(result.current.result).toBeNull();
    expect(result.current.hasRun).toBe(false);
  });

  it('re-entering a verified configuration is instant — no second request', async () => {
    const fetchMock = okFetch();
    const { result, rerender } = renderVerify({ target: 'proto', options: null });
    await act(async () => {
      await result.current.run();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.fromCache).toBe(false);

    rerender({ target: 'openapi', options: null });
    expect(result.current.hasRun).toBe(false);

    // Back to the first configuration: its verdict is restored from the session cache.
    rerender({ target: 'proto', options: null });
    expect(result.current.result?.verdict).toBe('clean');
    expect(result.current.hasRun).toBe(true);
    expect(result.current.fromCache).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('an option map that differs only in key order is the same cached configuration', async () => {
    const fetchMock = okFetch();
    const { result, rerender } = renderVerify({
      target: 'proto',
      options: { package: 'com.example', emit_services: false },
    });
    await act(async () => {
      await result.current.run();
    });
    rerender({ target: 'proto', options: { emit_services: false, package: 'com.example' } });
    expect(result.current.result?.verdict).toBe('clean');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('run() serves a cached verdict without a request; force re-measures', async () => {
    const fetchMock = okFetch();
    const { result } = renderVerify({ target: 'proto', options: null });
    await act(async () => {
      await result.current.run();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A plain re-run of an unchanged configuration costs nothing…
    await act(async () => {
      await result.current.run();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.fromCache).toBe(true);

    // …while the explicit "Re-run verification" action measures again.
    await act(async () => {
      await result.current.run(true);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.fromCache).toBe(false);
  });

  it('reset evicts the cached verdict so the next run really re-measures', async () => {
    const fetchMock = okFetch();
    const { result } = renderVerify({ target: 'proto', options: null });
    await act(async () => {
      await result.current.run();
    });
    act(() => result.current.reset());
    expect(result.current.result).toBeNull();

    await act(async () => {
      await result.current.run();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never caches a failure — the retry re-requests', async () => {
    const fetchMock = jest.fn(() =>
      Promise.resolve({ ok: false, json: () => Promise.resolve({ error: 'boom' }) }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const { result } = renderVerify({ target: 'proto', options: null });
    await act(async () => {
      await result.current.run();
    });
    expect(result.current.error).toBe('boom');
    await act(async () => {
      await result.current.run();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('auto mode verifies a changed configuration on its own, once per burst', async () => {
    const fetchMock = okFetch();
    const { result, rerender } = renderHook(
      (props: { options: Record<string, unknown> | null }) =>
        useExportVerify('proj-1', null, 'proto', props.options, { auto: true, debounceMs: 20 }),
      { initialProps: { options: null } as { options: Record<string, unknown> | null } },
    );

    await waitFor(() => expect(result.current.result?.verdict).toBe('clean'));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A burst of option edits debounces into one further run for the final configuration.
    rerender({ options: { package: 'a' } });
    rerender({ options: { package: 'ab' } });
    rerender({ options: { package: 'abc' } });
    await waitFor(() => expect(result.current.result?.verdict).toBe('clean'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const lastBody = JSON.parse((fetchMock.mock.calls[1][1] as { body: string }).body);
    expect(lastBody.options).toEqual({ package: 'abc' });
  });

  it('auto mode does not loop on a failure', async () => {
    const fetchMock = jest.fn(() =>
      Promise.resolve({ ok: false, json: () => Promise.resolve({ error: 'boom' }) }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const { result } = renderHook(() =>
      useExportVerify('proj-1', null, 'proto', null, { auto: true, debounceMs: 10 }),
    );
    await waitFor(() => expect(result.current.error).toBe('boom'));
    // The settled failure stops the automatic loop until the user retries explicitly.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('auto mode stays off until it is asked for', async () => {
    const fetchMock = okFetch();
    renderHook(() => useExportVerify('proj-1', null, 'proto', null, { debounceMs: 10 }));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
