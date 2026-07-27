'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ExportVerifyResponse } from './exportVerify';
import {
  sessionVerifyCache,
  verifyConfigKey,
  type VerifyResultCache,
} from './exportVerifyCache';

/** How long the auto re-verify waits after the last configuration change before running. */
export const VERIFY_AUTO_DEBOUNCE_MS = 600;

export interface UseExportVerifyResult {
  /** The verify result for the *current* configuration, else null (unrun, failed, or changed). */
  result: ExportVerifyResponse | null;
  /** Whether a verification for the current configuration is in flight. */
  running: boolean;
  /** Whether a verification has settled for the current configuration (from a run or the cache). */
  hasRun: boolean;
  /** The error from a failed run, else null. Unlike the advisory preview, a verify failure has no coarse fallback — the gate stays closed. */
  error: string | null;
  /**
   * Trigger a verification for the current (source, target, options). A cached result for that
   * configuration settles instantly without a request; pass `force` (the "Re-run verification"
   * action) to bypass the cache and re-measure.
   */
  run: (force?: boolean) => Promise<void>;
  /** Drop the verdict *and* its cache entry for the current configuration, so the next run re-fetches. */
  reset: () => void;
  /** The stable key of the current configuration; null when there is nothing to verify. */
  configKey: string | null;
  /** Whether the displayed result was served from the session cache rather than a fresh run. */
  fromCache: boolean;
}

/** Options controlling how the hook re-verifies (MFX-42.6). */
export interface UseExportVerifyOptions {
  /**
   * Re-verify automatically, debounced, whenever the configuration changes and has no settled
   * verdict yet. Off by default: verification is real compute, so it stays an explicit action
   * unless the user opts in with the workbench's "Verify automatically" toggle.
   */
  auto?: boolean;
  /** Debounce before an automatic run, in ms. */
  debounceMs?: number;
  /** The result cache to use; defaults to the per-session one. Injected by tests. */
  cache?: VerifyResultCache<ExportVerifyResponse>;
}

/** What a settled run left behind, and the configuration it describes. */
interface SettledVerify {
  /** The configuration key the result/error belongs to. */
  key: string;
  /** The settled result, or null when the run failed. */
  result: ExportVerifyResponse | null;
  /** The failure message, or null when the run succeeded. */
  error: string | null;
  /** Whether this was served from the cache rather than measured. */
  fromCache: boolean;
}

/**
 * Run the one-call, pre-generation Verify for one export (MFX-42.1, #4354) with change
 * invalidation and per-session result caching (MFX-42.6, #4359).
 *
 * Unlike `useExportPreview` (which auto-fetches the advisory fidelity report while a step is
 * shown), verification is **explicit** by default: the Verify workbench's "Run verification" action
 * calls {@link UseExportVerifyResult.run}, which POSTs to `/api/export/verify` (MFX-42.5) and
 * returns all three lenses + verdict in one dry-run. It is a real emit, so it never runs on every
 * render, and its result gates Generate until it settles with a passing (or lossy-acknowledged)
 * verdict.
 *
 * **A verdict can never outlive its configuration.** Every settled result is filed under the
 * {@link verifyConfigKey} of the (artifact, version, target, options) it was measured for, and the
 * hook only ever exposes a result whose key matches what is configured *now*. Changing a target or
 * an option therefore re-locks Generate structurally — no caller has to remember to reset.
 *
 * **Re-entering a configuration is instant.** Successful results are also written to a bounded,
 * expiring session cache, so returning to a configuration verified earlier (target A → B → A)
 * shows its verdict immediately, with no second request. `reset` evicts that entry, so an explicit
 * "this is stale" invalidation (e.g. the EFP-3.1 stale-preview recovery) really does re-measure.
 * Failures are never cached — they are retryable.
 *
 * With {@link UseExportVerifyOptions.auto} on, a configuration with no settled verdict verifies
 * itself after a debounce, so an option-tweaking user does not have to click through each change.
 * A failed run stops the automatic loop (the failure counts as settled) until the user retries.
 *
 * A run in flight is tracked by a monotonic token so a superseded response (e.g. a rapid re-run)
 * cannot settle stale state — though it still populates the cache, since the measurement is valid
 * for the configuration it was made for.
 *
 * @param artifact The artifact (project / catalog-item) id to export.
 * @param version The revision to verify (UUID or label); the latest revision when null.
 * @param target The chosen target emitter key; `run` is a no-op while null.
 * @param options The changed (non-default) option overrides sent with the verification.
 * @param settings Auto re-verify + cache injection (MFX-42.6).
 */
export function useExportVerify(
  artifact: string,
  version: string | null | undefined,
  target: string | null,
  options: Record<string, unknown> | null,
  settings: UseExportVerifyOptions = {},
): UseExportVerifyResult {
  const {
    auto = false,
    debounceMs = VERIFY_AUTO_DEBOUNCE_MS,
    cache = sessionVerifyCache,
  } = settings;

  const [settled, setSettled] = useState<SettledVerify | null>(null);
  const [runningKey, setRunningKey] = useState<string | null>(null);
  // Monotonic token: only the newest run may settle state; superseded runs are dropped.
  const runToken = useRef(0);

  const configKey = useMemo(
    () => verifyConfigKey({ artifact, version, target, options }),
    [artifact, version, target, options],
  );

  // What to display: the settled run when it describes the current configuration, else a cached
  // result for it, else nothing. Derived — never stored — so a configuration change can never
  // leave a stale verdict on screen or in the Generate gate.
  const cached = cache.get(configKey);
  const active: SettledVerify | null =
    settled && settled.key === configKey
      ? settled
      : configKey && cached
        ? { key: configKey, result: cached, error: null, fromCache: true }
        : null;

  // Release a settled run once its configuration is no longer the one on screen. The render-time
  // derivation above already refuses to show it, so this is bookkeeping rather than correctness:
  // it lets a later return to that configuration come back through the cache — and therefore be
  // reported (and labelled) as restored rather than freshly measured.
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
        const res = await fetch('/api/export/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ artifact, version: version || null, target, options: options ?? null }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data?.success === false) {
          throw new Error(
            typeof data?.error === 'string' ? data.error : 'Could not verify this export.',
          );
        }
        // Cache the measurement even when it has been superseded: it is a valid verdict for the
        // configuration it was made for, and re-entering that configuration should be instant.
        cache.set(key, data as ExportVerifyResponse);
        if (token !== runToken.current) return;
        setSettled({ key, result: data as ExportVerifyResponse, error: null, fromCache: false });
      } catch (e) {
        if (token !== runToken.current) return;
        setSettled({
          key,
          result: null,
          error: e instanceof Error ? e.message : 'Could not verify this export.',
          fromCache: false,
        });
      } finally {
        if (token === runToken.current) setRunningKey(null);
      }
    },
    [artifact, version, target, options, configKey, cache],
  );

  const reset = useCallback(() => {
    // Invalidate any in-flight run so its late response cannot settle a stale verdict, and evict
    // the cached verdict so the next run really re-measures.
    runToken.current += 1;
    cache.delete(configKey);
    setSettled(null);
    setRunningKey(null);
  }, [cache, configKey]);

  // Auto re-verify (MFX-42.6): once the user has opted in, a configuration without a settled
  // verdict verifies itself after a debounce. Changing an option restarts the timer, so a burst of
  // edits costs one run — and a run already in flight (or a settled failure) is left alone.
  const hasRun = Boolean(active);
  useEffect(() => {
    if (!auto || !configKey || hasRun || runningKey === configKey) return undefined;
    const timer = setTimeout(() => {
      void run();
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [auto, configKey, hasRun, runningKey, run, debounceMs]);

  return {
    result: active?.result ?? null,
    running: Boolean(configKey) && runningKey === configKey,
    hasRun,
    error: active?.error ?? null,
    run,
    reset,
    configKey,
    fromCache: active?.fromCache ?? false,
  };
}
