'use client';

/**
 * useConversionHistory (CPDO-3.3, #4803) — load a conversion provenance history list.
 *
 * Serves both surfaces through one scope union: the catalog item's history
 * (`GET /api/catalog/{itemId}/conversions`) and the converted Project's history
 * (`GET /api/projects/{projectId}/conversions`).
 *
 * One-shot on first enable (the `CatalogVersionsPanel` lazy idiom): the ledger is append-only,
 * so toggling the surface open/closed never refetches — `retry()` is the explicit refresh.
 * In-flight loads are invalidated with a monotonic token + AbortController on scope change or
 * unmount.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchCatalogConversionHistory,
  fetchProjectConversionHistory,
  type ConversionProvenanceRow,
} from '@/app/utils/conversion-provenance';

/** Which surface's history to load. */
export type ConversionHistoryScope =
  | { kind: 'catalog'; itemId: string }
  | { kind: 'project'; projectId: string };

export interface UseConversionHistoryResult {
  /** Provenance rows, newest first (server order). */
  rows: ConversionProvenanceRow[];
  /** Digest of the item's currently captured source; null when unknowable (or project scope). */
  currentSourceHash: string | null;
  /** True once a load has settled successfully (distinguishes "empty" from "not loaded yet"). */
  loaded: boolean;
  loading: boolean;
  error: string | null;
  /** Reload the history (the error affordance and the explicit refresh). */
  retry: () => void;
}

/** A stable identity for a scope, so an equivalent object does not restart the load. */
function scopeKey(scope: ConversionHistoryScope | null): string | null {
  if (!scope) return null;
  return scope.kind === 'catalog' ? `catalog:${scope.itemId}` : `project:${scope.projectId}`;
}

/**
 * Load the conversion history for one catalog item or one converted Project.
 *
 * @param enabled Only fetch while truthy (the owning tab/panel is active).
 * @param scope Which surface to load; no fetch while null.
 */
export function useConversionHistory(
  enabled: boolean,
  scope: ConversionHistoryScope | null,
): UseConversionHistoryResult {
  const [rows, setRows] = useState<ConversionProvenanceRow[]>([]);
  const [currentSourceHash, setCurrentSourceHash] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const key = scopeKey(scope);
  // The scope the current state describes; a different key means state must reset.
  const loadedKeyRef = useRef<string | null>(null);
  const tokenRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!enabled || !scope || !key) return;
    // One-shot: the list is already loaded for this scope and no retry was requested.
    if (loadedKeyRef.current === key && (loaded || loading)) return;

    const token = ++tokenRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    loadedKeyRef.current = key;
    setRows([]);
    setCurrentSourceHash(null);
    setLoaded(false);
    setLoading(true);
    setError(null);

    const load =
      scope.kind === 'catalog'
        ? fetchCatalogConversionHistory(scope.itemId, controller.signal)
        : fetchProjectConversionHistory(scope.projectId, controller.signal);

    load
      .then((history) => {
        if (token !== tokenRef.current) return;
        setRows(history.conversions);
        setCurrentSourceHash(history.currentSourceHash);
        setLoaded(true);
      })
      .catch((e: unknown) => {
        if (token !== tokenRef.current) return;
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setError(e instanceof Error ? e.message : 'Could not load the conversion history.');
        // Allow the effect to re-run after retry() for this same scope.
        loadedKeyRef.current = null;
      })
      .finally(() => {
        if (token === tokenRef.current) setLoading(false);
      });
    // `loaded`/`loading` are guards, not triggers: re-running on their changes would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, key, attempt]);

  useEffect(
    () => () => {
      tokenRef.current += 1;
      abortRef.current?.abort();
    },
    [],
  );

  const retry = useCallback(() => {
    loadedKeyRef.current = null;
    setAttempt((n) => n + 1);
  }, []);

  return { rows, currentSourceHash, loaded, loading, error, retry };
}
