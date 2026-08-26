'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildRequestPath,
  mockIsLive,
  type ExportMockCapability,
  type ExportMockInstance,
  type ExportMockOperation,
  type ExportMockRequestEntry,
  type ExportMockRequestLog,
  type ExportMockTryResult,
} from './exportMockTestDrive';

/**
 * The mock capability is server-wide static reference data — the same answer for every source,
 * every target and every panel on the page — so one fetch per page load is shared through this
 * module cache, exactly as `useCapabilityReasons` shares the destination registry. A settled
 * `null` records a failure the panel degrades on; a page reload retries.
 */
let cachedCapability: ExportMockCapability | null = null;
let pendingCapability: Promise<ExportMockCapability | null> | null = null;

/** Empty the capability cache — test hook only. */
export function resetMockCapabilityCache(): void {
  cachedCapability = null;
  pendingCapability = null;
}

/** Fetch the capability report; null on any transport or contract failure. */
async function fetchCapability(): Promise<ExportMockCapability | null> {
  try {
    const res = await fetch('/api/export/mock/capability', { credentials: 'include' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.success === false) return null;
    if (typeof data?.available !== 'boolean' || !Array.isArray(data?.supportedTargets)) return null;
    return data as ExportMockCapability;
  } catch {
    return null;
  }
}

/** Load the capability once per page load, sharing one in-flight request between callers. */
async function loadCapability(): Promise<ExportMockCapability | null> {
  if (cachedCapability) return cachedCapability;
  if (!pendingCapability) {
    pendingCapability = fetchCapability().then((snapshot) => {
      cachedCapability = snapshot;
      return snapshot;
    });
  }
  return pendingCapability;
}

/** How often a live mock is re-read from the server (countdown resync + request log). */
const POLL_INTERVAL_MS = 10_000;

/** How often the countdown ticks locally between server reads. */
const TICK_INTERVAL_MS = 1_000;

/** What the test-drive hook exposes to the panel. */
export interface UseExportMockTestDriveResult {
  /** The server's mock capability, or null while loading / after a failed load. */
  capability: ExportMockCapability | null;
  /** Whether the capability call is still in flight. */
  capabilityLoading: boolean;
  /** The running (or just-expired) mock for this configuration, else null. */
  instance: ExportMockInstance | null;
  /** True when this instance was found already running rather than started here. */
  reattached: boolean;
  /** Whether a start or stop is in flight. */
  busy: boolean;
  /** The failure message from the last start/stop/send, else null. */
  error: string | null;
  /** The mock's retained request log, or null before the first read. */
  log: ExportMockRequestLog | null;
  /** The most recent try-it result, else null. */
  lastResult: ExportMockTryResult | null;
  /** Whether a try-it request is in flight. */
  sending: boolean;
  /** Start a mock of the current configuration. */
  start: () => Promise<void>;
  /** Stop the running mock now (also clears the panel). */
  stop: () => Promise<void>;
  /** Stop the running mock and immediately start a fresh one for the current configuration. */
  restart: () => Promise<void>;
  /** Send one request to the running mock and refresh the log. */
  send: (
    operation: ExportMockOperation,
    values?: Record<string, string>,
    scenario?: string | null,
  ) => Promise<void>;
  /** Drop the last try-it result (the panel's "clear" affordance). */
  clearResult: () => void;
}

/** Read a `{ success, ... }` proxy envelope, throwing the server's message on failure. */
async function readEnvelope(res: Response, fallback: string): Promise<Record<string, unknown>> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.success === false) {
    throw new Error(typeof data?.error === 'string' ? data.error : fallback);
  }
  return data as Record<string, unknown>;
}

/**
 * Drive an ephemeral mock of the emitted export artifact (MFX-44.5, #4371).
 *
 * The hook owns four things the panel should not: the shared capability load, the lifecycle of one
 * mock instance, the countdown, and the request log.
 *
 * **Explicit only.** Provisioning a mock costs a server-side emit and a row with a TTL, so — like
 * the round-trip comparison beside it — nothing happens on render. A mock exists only after the
 * user presses Start.
 *
 * **Reattachment.** Test-drive mocks outlive the component (that is what a TTL means), so on mount
 * the hook lists the workspace's live mocks and adopts one already running for this
 * `(artifact, version, target)`. Without that, leaving Review and coming back would strand the
 * running instance against the per-workspace cap with no way to stop it. Adoption matches the
 * coordinates but not the emit *options*, so an adopted mock is reported through `reattached` and
 * the panel offers Restart — the user is told what they are looking at rather than being left to
 * assume it reflects their current options.
 *
 * **The countdown.** `expiresInSeconds` is computed server-side (immune to browser clock skew) and
 * resynced on every poll; between polls it ticks down locally so the clock moves once a second
 * without a request a second.
 *
 * @param artifact The artifact (project) id being exported.
 * @param version The revision (UUID or label); the latest revision when null.
 * @param target The chosen target emitter key; the hook is inert while null.
 * @param options The changed (non-default) option overrides sent with the start.
 * @param enabled Whether the mock tool applies at all (the capability-driven gate).
 */
export function useExportMockTestDrive(
  artifact: string,
  version: string | null | undefined,
  target: string | null,
  options: Record<string, unknown> | null,
  enabled = true,
): UseExportMockTestDriveResult {
  const [capability, setCapability] = useState<ExportMockCapability | null>(cachedCapability);
  const [capabilityLoading, setCapabilityLoading] = useState(!cachedCapability);
  const [instance, setInstance] = useState<ExportMockInstance | null>(null);
  const [reattached, setReattached] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<ExportMockRequestLog | null>(null);
  const [lastResult, setLastResult] = useState<ExportMockTryResult | null>(null);
  const [sending, setSending] = useState(false);

  // The configuration this hook's state belongs to. A change to any part of it invalidates the
  // panel's instance reference — the mock on screen must always describe what is on screen.
  const configKey = useMemo(
    () => JSON.stringify([artifact, version ?? null, target ?? null]),
    [artifact, version, target],
  );

  // Latest values for callbacks that must not be re-created on every keystroke elsewhere.
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const instanceRef = useRef<ExportMockInstance | null>(null);
  instanceRef.current = instance;

  // ---- capability ---------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    if (cachedCapability) {
      setCapability(cachedCapability);
      setCapabilityLoading(false);
      return () => {
        cancelled = true;
      };
    }
    setCapabilityLoading(true);
    loadCapability().then((snapshot) => {
      if (cancelled) return;
      setCapability(snapshot);
      setCapabilityLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- configuration changes ---------------------------------------------
  // Release the previous configuration's instance without deleting it: the mock is ephemeral and
  // expires on its own, and the reattachment pass below picks it up again if the user returns.
  useEffect(() => {
    setInstance(null);
    setReattached(false);
    setLog(null);
    setLastResult(null);
    setError(null);
  }, [configKey]);

  // ---- reattachment -------------------------------------------------------
  useEffect(() => {
    if (!enabled || !artifact || !target) return;
    if (!capability?.available) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/export/mock', { credentials: 'include' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data?.success === false || !Array.isArray(data?.instances)) return;
        const match = (data.instances as ExportMockInstance[]).find(
          (candidate) =>
            candidate.artifact === artifact &&
            candidate.targetKey === target &&
            (candidate.version ?? null) === (version ?? null) &&
            mockIsLive(candidate),
        );
        if (cancelled || !match) return;
        setInstance(match);
        setReattached(true);
      } catch {
        // A failed listing simply means no reattachment; Start still works.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, artifact, target, version, capability?.available, configKey]);

  // ---- polling + local countdown -----------------------------------------
  const refresh = useCallback(async (mockId: string) => {
    try {
      const [instanceRes, logRes] = await Promise.all([
        fetch(`/api/export/mock/${encodeURIComponent(mockId)}`, { credentials: 'include' }),
        fetch(`/api/export/mock/${encodeURIComponent(mockId)}/requests`, {
          credentials: 'include',
        }),
      ]);
      const instanceData = await instanceRes.json().catch(() => ({}));
      if (instanceRes.ok && instanceData?.success !== false && instanceData?.id) {
        setInstance((current) =>
          current && current.id === mockId ? (instanceData as ExportMockInstance) : current,
        );
      }
      const logData = await logRes.json().catch(() => ({}));
      if (logRes.ok && logData?.success !== false && Array.isArray(logData?.entries)) {
        setLog(logData as ExportMockRequestLog);
      }
    } catch {
      // A dropped poll is not a failure worth surfacing — the next tick retries, and an expired
      // mock is reported by the countdown reaching zero regardless.
    }
  }, []);

  const live = mockIsLive(instance);
  useEffect(() => {
    if (!instance || !live) return;
    const mockId = instance.id;
    const poll = setInterval(() => void refresh(mockId), POLL_INTERVAL_MS);
    const tick = setInterval(() => {
      setInstance((current) =>
        current && current.id === mockId && current.expiresInSeconds > 0
          ? { ...current, expiresInSeconds: current.expiresInSeconds - 1 }
          : current,
      );
    }, TICK_INTERVAL_MS);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
    // Depend on the id + liveness rather than the whole instance: the local tick replaces the
    // object every second, and re-creating the intervals each time would reset the countdown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance?.id, live, refresh]);

  // ---- lifecycle ----------------------------------------------------------
  const start = useCallback(async () => {
    if (!artifact || !target) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/export/mock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          artifact,
          version: version || null,
          target,
          options: optionsRef.current ?? null,
        }),
      });
      const data = await readEnvelope(res, 'Could not start the mock.');
      setInstance(data as unknown as ExportMockInstance);
      setReattached(false);
      setLog(null);
      setLastResult(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the mock.');
    } finally {
      setBusy(false);
    }
  }, [artifact, version, target]);

  const stop = useCallback(async () => {
    const running = instanceRef.current;
    if (!running) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/export/mock/${encodeURIComponent(running.id)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      await readEnvelope(res, 'Could not stop the mock.');
      setInstance(null);
      setReattached(false);
      setLog(null);
      setLastResult(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not stop the mock.');
    } finally {
      setBusy(false);
    }
  }, []);

  const restart = useCallback(async () => {
    await stop();
    await start();
  }, [stop, start]);

  const send = useCallback(
    async (
      operation: ExportMockOperation,
      values: Record<string, string> = {},
      scenario: string | null = null,
    ) => {
      const running = instanceRef.current;
      if (!running) return;
      setSending(true);
      setError(null);
      try {
        const res = await fetch(`/api/export/mock/${encodeURIComponent(running.id)}/try`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            method: operation.method,
            path: buildRequestPath(operation.path, values),
            scenario,
          }),
        });
        const data = await readEnvelope(res, 'The mock did not answer.');
        setLastResult(data as unknown as ExportMockTryResult);
        await refresh(running.id);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'The mock did not answer.');
      } finally {
        setSending(false);
      }
    },
    [refresh],
  );

  const clearResult = useCallback(() => setLastResult(null), []);

  return {
    capability,
    capabilityLoading,
    instance,
    reattached,
    busy,
    error,
    log,
    lastResult,
    sending,
    start,
    stop,
    restart,
    send,
    clearResult,
  };
}

/** Re-exported for the panel's row rendering, so it imports one module for the log's shape. */
export type { ExportMockRequestEntry };
