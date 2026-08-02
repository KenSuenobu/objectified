'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ExportRoundtripResponse } from './exportRoundtrip';
import {
  createVerifyResultCache,
  verifyConfigKey,
  type VerifyResultCache,
} from './exportVerifyCache';

/** What the round-trip hook exposes to the panel. */
export interface UseExportRoundtripResult {
  /** The result for the *current* configuration, else null (unrun, failed, or changed). */
  result: ExportRoundtripResponse | null;
  /** Whether a round trip for the current configuration is in flight. */
  running: boolean;
  /** Whether a round trip has settled for the current configuration (from a run or the cache). */
  hasRun: boolean;
  /** The error from a failed run, else null. */
  error: string | null;
  /**
   * Run the round trip for the current (source, target, options). A cached result for that
   * configuration settles instantly without a request; pass `force` (the "Re-run" action) to
   * bypass the cache and re-measure.
   */
  run: (force?: boolean) => Promise<void>;
  /** Drop the result *and* its cache entry for the current configuration. */
  reset: () => void;
  /** The stable key of the current configuration; null when there is nothing to compare. */
  configKey: string | null;
  /** Whether the displayed result was served from the session cache rather than a fresh run. */
  fromCache: boolean;
}

/** What a settled run left behind, and the configuration it describes. */
interface SettledRoundtrip {
  /** The configuration key the result/error belongs to. */
  key: string;
  /** The settled result, or null when the run failed. */
  result: ExportRoundtripResponse | null;
  /** The failure message, or null when the run succeeded. */
  error: string | null;
  /** Whether this was served from the cache rather than measured. */
  fromCache: boolean;
}

/** The browser-side store behind {@link sessionRoundtripCache}. */
const browserRoundtripCache = createVerifyResultCache<ExportRoundtripResponse>();

/** A cache that holds nothing — the server-render instance (see `exportVerifyCache.ts`). */
const inertRoundtripCache: VerifyResultCache<ExportRoundtripResponse> = {
  get: () => null,
  set: () => undefined,
  delete: () => undefined,
  clear: () => undefined,
  get size() {
    return 0;
  },
};

/**
 * The per-browser-session round-trip result cache. Module-level for the same reason the
 * verify cache is (leaving the Studio and returning to the same configuration stays instant),
 * memory-only for the same reason (results describe a customer's API surface), and inert on
 * the server for the same reason (one module instance would span every tenant's render).
 */
export const sessionRoundtripCache: VerifyResultCache<ExportRoundtripResponse> =
  typeof window === 'undefined' ? inertRoundtripCache : browserRoundtripCache;

/** Empty the session cache — for tests, which must not inherit cached results. */
export function __resetRoundtripCacheForTests(): void {
  browserRoundtripCache.clear();
}

/** Options for {@link useExportRoundtrip}; tests inject a cache. */
export interface UseExportRoundtripOptions {
  /** The result cache to use; defaults to the per-session one. */
  cache?: VerifyResultCache<ExportRoundtripResponse>;
}

/**
 * Run the on-demand round-trip comparison for one export (IXH-4.4, #5112).
 *
 * The round trip is a real emit **plus** a real re-import, so — unlike the fidelity preview,
 * and even more firmly than Verify — it is **explicit only**: there is no auto mode, and the
 * loop runs solely when the panel's action calls {@link UseExportRoundtripResult.run}. It
 * never runs implicitly on a preview or a render (the ticket's bounded-action acceptance).
 *
 * Everything else mirrors `useExportVerify`, sharing its configuration-key and session-cache
 * machinery: a result can never outlive its (artifact, version, target, options)
 * configuration, re-entering a configuration measured earlier settles instantly from the
 * bounded expiring cache, failures are never cached (they are retryable), and a monotonic
 * run token keeps a superseded response from settling stale state.
 *
 * @param artifact The artifact (project / catalog-item) id to round-trip.
 * @param version The revision (UUID or label); the latest revision when null.
 * @param target The chosen target emitter key; `run` is a no-op while null.
 * @param options The changed (non-default) option overrides sent with the run.
 * @param settings Cache injection for tests.
 */
export function useExportRoundtrip(
  artifact: string,
  version: string | null | undefined,
  target: string | null,
  options: Record<string, unknown> | null,
  settings: UseExportRoundtripOptions = {},
): UseExportRoundtripResult {
  const { cache = sessionRoundtripCache } = settings;

  const [settled, setSettled] = useState<SettledRoundtrip | null>(null);
  const [runningKey, setRunningKey] = useState<string | null>(null);
  // Monotonic token: only the newest run may settle state; superseded runs are dropped.
  const runToken = useRef(0);

  const configKey = useMemo(
    () => verifyConfigKey({ artifact, version, target, options }),
    [artifact, version, target, options],
  );

  // What to display: the settled run when it describes the current configuration, else a cached
  // result for it, else nothing. Derived — never stored — so a configuration change can never
  // leave a stale comparison on screen.
  const cached = cache.get(configKey);
  const active: SettledRoundtrip | null =
    settled && settled.key === configKey
      ? settled
      : configKey && cached
        ? { key: configKey, result: cached, error: null, fromCache: true }
        : null;

  // Bookkeeping: release a settled run once its configuration left the screen, so a later
  // return to it comes back through the cache and is labelled as restored.
  useEffect(() => {
    setSettled((current) => (current && current.key !== configKey ? null : current));
  }, [configKey]);

  const run = useCallback(
    async (force = false) => {
      if (!artifact || !target || !configKey) return;
      const key = configKey;
      if (!force) {
        const hit = cache.get(key);
        if (hit) {
          // Instant re-entry: nothing to measure, and any in-flight run is superseded.
          runToken.current += 1;
          setRunningKey(null);
          setSettled({ key, result: hit, error: null, fromCache: true });
          return;
        }
      }
      const token = ++runToken.current;
      setRunningKey(key);
      try {
        const res = await fetch('/api/export/roundtrip', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            artifact,
            version: version || null,
            target,
            options: options ?? null,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data?.success === false) {
          throw new Error(
            typeof data?.error === 'string' ? data.error : 'Could not run the round-trip comparison.',
          );
        }
        // Cache the measurement even when superseded: it is valid for its configuration.
        cache.set(key, data as ExportRoundtripResponse);
        if (token !== runToken.current) return;
        setSettled({ key, result: data as ExportRoundtripResponse, error: null, fromCache: false });
      } catch (e) {
        if (token !== runToken.current) return;
        setSettled({
          key,
          result: null,
          error: e instanceof Error ? e.message : 'Could not run the round-trip comparison.',
          fromCache: false,
        });
      } finally {
        if (token === runToken.current) setRunningKey(null);
      }
    },
    [artifact, version, target, options, configKey, cache],
  );

  const reset = useCallback(() => {
    // Invalidate any in-flight run and evict the cached result so the next run re-measures.
    runToken.current += 1;
    cache.delete(configKey);
    setSettled(null);
    setRunningKey(null);
  }, [cache, configKey]);

  return {
    result: active?.result ?? null,
    running: Boolean(configKey) && runningKey === configKey,
    hasRun: Boolean(active),
    error: active?.error ?? null,
    run,
    reset,
    configKey,
    fromCache: active?.fromCache ?? false,
  };
}
