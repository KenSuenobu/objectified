'use client';

/**
 * useConversionProjection (CPDO-3.1, #4801) — load a catalog item's conversion projection
 * manifest behind the conversion preview.
 *
 * Walks `POST /api/catalog/{itemId}/projection` (CPDO-1.3) cursor pages with **no scope**,
 * which pages every edge scope (checklist → construct → loss → analysis) in the manifest's
 * one canonical order — so a completed walk holds exactly `summary.edge_count` edges and
 * the renderer can reconcile its counts against the manifest's own tallies.
 *
 * The windowed-walk discipline is the export evidence reader's
 * (`../export/useProjectionEvidence.ts`): fetch up to {@link PROJECTION_PAGES_PER_WINDOW}
 * pages per window with `loadMore()` to continue, so a huge manifest cannot stall the
 * dialog; integrity-check every page (`conversionEvidencePageIssues`) and refuse the whole
 * view — never partially render — when a page is incoherent or a mid-walk page changes
 * snapshot; invalidate in-flight walks with a monotonic token on config change/unmount.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CONVERSION_PROJECTION_PAGE_LIMIT,
  conversionEvidencePageIssues,
  fetchConversionProjection,
  type ConversionEvidencePageSource,
  type ConversionManifestSummary,
  type ConversionProjectionEdge,
  type ConversionProjectionNode,
} from '@/app/utils/conversion-projection';
import { cleanDefaults, type ConversionDefaults } from '@/app/utils/conversion-fidelity';
import { metricNow, trackCatalogAnalysisMetric } from './catalogAnalysisMetrics';

/** Pages fetched per window — one auto-load walks at most this many cursors. */
export const PROJECTION_PAGES_PER_WINDOW = 5;

export interface UseConversionProjectionResult {
  /** The snapshot summary from the first page (hash, full status/scope/reason tallies). */
  summary: ConversionManifestSummary | null;
  /** Every node loaded so far, deduplicated by id. */
  nodes: ConversionProjectionNode[];
  /** Every edge loaded so far, in the manifest's canonical order. */
  edges: ConversionProjectionEdge[];
  /** Whether a page walk is in flight. */
  loading: boolean;
  /** Fetch/transport error; the section degrades to a retryable message. */
  error: string | null;
  /**
   * Integrity problems found in a page (structural issues + cross-page snapshot identity).
   * Non-empty means the evidence must be refused, not partially rendered.
   */
  integrityIssues: string[];
  /** True once every page has been loaded (no cursor remains). */
  complete: boolean;
  /** Continue the cursor walk for another window; no-op while loading or when complete. */
  loadMore: () => void;
  /** Abandon state and start the walk over (the error affordance). */
  retry: () => void;
}

/**
 * Load the conversion projection manifest for one catalog item.
 *
 * @param enabled Only fetch while truthy (the preview's projection section is expanded).
 * @param itemId The catalog item id (a project id); no fetch while null.
 * @param pageLimit Edges per page (tests pass a small value to exercise the walk).
 * @param defaults Approved gap-filling defaults (CPDO-3.2). They fold into the snapshot
 *   hash, so a change is a new snapshot: the walk restarts from scratch, which is what keeps
 *   the graph and the recomputed fidelity report describing the same manifest.
 * @param source Optional page source override (CPDO-3.3): the conversion-history reader walks
 *   a persisted evidence snapshot through this instead of the live rebuild endpoint, under the
 *   same integrity discipline. When set, `defaults` no longer affect the fetch (a stored
 *   snapshot fixed its defaults at commit time).
 */
export function useConversionProjection(
  enabled: boolean,
  itemId: string | null,
  pageLimit: number = CONVERSION_PROJECTION_PAGE_LIMIT,
  defaults?: ConversionDefaults,
  source?: ConversionEvidencePageSource,
): UseConversionProjectionResult {
  const [summary, setSummary] = useState<ConversionManifestSummary | null>(null);
  const [nodes, setNodes] = useState<ConversionProjectionNode[]>([]);
  const [edges, setEdges] = useState<ConversionProjectionEdge[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [integrityIssues, setIntegrityIssues] = useState<string[]>([]);
  const [complete, setComplete] = useState(false);
  // Bumped by retry() to re-run the walk effect with fresh state.
  const [attempt, setAttempt] = useState(0);

  // Walk bookkeeping, not render state: survives between windows without re-rendering.
  const cursorRef = useRef<string | null>(null);
  const seenNodeIdsRef = useRef<Set<string>>(new Set());
  const firstHashRef = useRef<string | null>(null);
  // Monotonic token: a config change or unmount invalidates any in-flight walk.
  const walkToken = useRef(0);

  // A stable identity for the cleaned defaults, so an equivalent object (e.g. a fresh `{}`
  // each render) does not restart the walk, while an approved change does.
  const defaultsKey = JSON.stringify(cleanDefaults(defaults ?? {}));
  const cleanedDefaults = useMemo(
    () => JSON.parse(defaultsKey) as ConversionDefaults,
    [defaultsKey],
  );

  /** Walk up to one window of pages from the given cursor, accumulating results. */
  const fetchWindow = useCallback(
    async (token: number, startCursor: string | null) => {
      if (!itemId) return;
      setLoading(true);
      setError(null);
      const startedAt = metricNow();
      try {
        let cursor = startCursor;
        for (let pageIndex = 0; pageIndex < PROJECTION_PAGES_PER_WINDOW; pageIndex += 1) {
          const response = source
            ? await source({ cursor, limit: pageLimit })
            : await fetchConversionProjection(itemId, {
                defaults: cleanedDefaults,
                cursor,
                limit: pageLimit,
              });
          if (token !== walkToken.current) return;

          const issues = conversionEvidencePageIssues(response.page);
          if (firstHashRef.current == null) {
            firstHashRef.current = response.page.manifest_hash;
          } else if (response.page.manifest_hash !== firstHashRef.current) {
            issues.push(
              `page snapshot '${response.page.manifest_hash}' does not match the walk's ` +
                `snapshot '${firstHashRef.current}' — the source changed mid-walk`,
            );
          }
          if (response.page.manifest_hash !== response.summary.manifest_hash) {
            issues.push(
              `page snapshot '${response.page.manifest_hash}' does not match its own ` +
                `summary '${response.summary.manifest_hash}'`,
            );
          }
          if (issues.length > 0) {
            // An untrusted page refuses the whole evidence view — never partially render.
            setIntegrityIssues(issues);
            setComplete(false);
            return;
          }

          const freshNodes = response.page.nodes.filter(
            (node) => !seenNodeIdsRef.current.has(node.id),
          );
          for (const node of freshNodes) seenNodeIdsRef.current.add(node.id);
          setSummary((current) => current ?? response.summary);
          if (freshNodes.length > 0) setNodes((current) => [...current, ...freshNodes]);
          if (response.page.edges.length > 0) {
            setEdges((current) => [...current, ...response.page.edges]);
          }

          cursor = response.page.next_cursor ?? null;
          cursorRef.current = cursor;
          if (cursor == null) {
            setComplete(true);
            return;
          }
        }
      } catch (e) {
        if (token !== walkToken.current) return;
        setError(e instanceof Error ? e.message : 'Could not load the projection graph.');
      } finally {
        if (token === walkToken.current) {
          setLoading(false);
          // Privacy-safe UI latency report (CPDO-4.2): how long one evidence window took
          // to fetch and integrate. A duration only — no labels, no source coordinates.
          void trackCatalogAnalysisMetric({
            kind: 'ui_latency',
            surface: 'projection_graph',
            latency_ms: metricNow() - startedAt,
          });
        }
      }
    },
    [itemId, pageLimit, cleanedDefaults, source],
  );

  useEffect(() => {
    if (!enabled || !itemId) return;
    const token = ++walkToken.current;
    // A new item (or retry) is a new walk: reset the accumulation before the first window.
    cursorRef.current = null;
    seenNodeIdsRef.current = new Set();
    firstHashRef.current = null;
    setSummary(null);
    setNodes([]);
    setEdges([]);
    setIntegrityIssues([]);
    setComplete(false);
    void fetchWindow(token, null);
    return () => {
      // Invalidate the in-flight walk so a late page cannot settle stale state.
      walkToken.current += 1;
    };
  }, [enabled, itemId, attempt, fetchWindow]);

  const loadMore = useCallback(() => {
    if (loading || complete || integrityIssues.length > 0 || cursorRef.current == null) return;
    void fetchWindow(walkToken.current, cursorRef.current);
  }, [loading, complete, integrityIssues, fetchWindow]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return { summary, nodes, edges, loading, error, integrityIssues, complete, loadMore, retry };
}
