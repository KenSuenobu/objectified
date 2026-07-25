'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EXPORT_MANIFEST_PAGES_PER_WINDOW } from '@/app/utils/preview-budgets';
import {
  EXPORT_MANIFEST_PAGE_SIZE,
  mergeManifestEntityPages,
  type ExportManifestEntity,
  type ExportPreviewManifestPage,
  type ExportPreviewManifestResponse,
} from './exportPreviewManifest';

/** Pages fetched per walk window — the central budget (IXH-3.6 registry), re-exported. */
export const MANIFEST_PAGES_PER_WINDOW = EXPORT_MANIFEST_PAGES_PER_WINDOW;

export interface UseExportPreviewManifestResult {
  /** The first page's identity block (hash, target, full counts, file table), or null. */
  page: ExportPreviewManifestPage | null;
  /** Every entity loaded so far, deduplicated and in stable full-tree order. */
  entities: ExportManifestEntity[];
  /** Whether a page walk is in flight. */
  loading: boolean;
  /** Fetch/transport error; the explorer degrades to the plain file view. */
  error: string | null;
  /** True once every entity page has been loaded (no cursor remains). */
  complete: boolean;
  /** Continue the cursor walk for another window; no-op while loading or when complete. */
  loadMore: () => void;
}

/**
 * Load the structural export preview manifest behind the Review step (IXH-4.1, #5109).
 *
 * Walks `POST /api/export/preview-manifest` cursor pages for the given
 * `(artifact, version, target, options)` — the same coordinates the export ran with, so
 * the manifest describes exactly the artifact under review. Fetches up to
 * {@link MANIFEST_PAGES_PER_WINDOW} pages per window at the server's maximum page size
 * and exposes {@link UseExportPreviewManifestResult.loadMore} to continue, so a huge
 * manifest cannot stall the step; the full counts always ride on the page identity, so
 * nothing is silently hidden while more pages remain.
 *
 * Every subsequent page must carry the first page's `manifest_hash` — a mid-walk
 * snapshot change (the source moved) refuses the manifest rather than mixing snapshots.
 *
 * @param enabled Only fetch while truthy (the Review step is showing an artifact).
 * @param artifact The artifact (project) id that was exported.
 * @param version The revision (UUID or label); the latest revision when null.
 * @param target The chosen target emitter key; no fetch while null.
 * @param options The changed (non-default) option overrides the export ran with, or null.
 */
export function useExportPreviewManifest(
  enabled: boolean,
  artifact: string,
  version: string | null | undefined,
  target: string | null,
  options: Record<string, unknown> | null,
): UseExportPreviewManifestResult {
  const [page, setPage] = useState<ExportPreviewManifestPage | null>(null);
  const [pages, setPages] = useState<ExportManifestEntity[][]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);

  // Walk bookkeeping, not render state: survives between windows without re-rendering.
  const cursorRef = useRef<string | null>(null);
  const firstHashRef = useRef<string | null>(null);
  // Monotonic token: a config change or unmount invalidates any in-flight walk.
  const walkToken = useRef(0);

  // A stable key for the options object so the effect re-runs on content, not identity.
  const optionsKey = useMemo(() => JSON.stringify(options ?? null), [options]);

  const entities = useMemo(() => mergeManifestEntityPages(pages), [pages]);

  /** Walk up to one window of pages from the current cursor, accumulating entities. */
  const fetchWindow = useCallback(
    async (token: number, startCursor: string | null) => {
      setLoading(true);
      setError(null);
      try {
        let cursor = startCursor;
        for (let pageIndex = 0; pageIndex < MANIFEST_PAGES_PER_WINDOW; pageIndex += 1) {
          const res = await fetch('/api/export/preview-manifest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
              artifact,
              version: version || null,
              target,
              options: options ?? null,
              cursor,
              page_size: EXPORT_MANIFEST_PAGE_SIZE,
            }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data?.success === false) {
            throw new Error(
              typeof data?.error === 'string'
                ? data.error
                : 'Could not load the artifact manifest.',
            );
          }
          if (token !== walkToken.current) return;

          const response = data as ExportPreviewManifestResponse;
          const manifest = response.manifest;
          if (firstHashRef.current == null) {
            firstHashRef.current = manifest.manifest_hash;
          } else if (manifest.manifest_hash !== firstHashRef.current) {
            throw new Error(
              'The artifact changed while the manifest was loading — re-open the review step.',
            );
          }

          setPage((current) => current ?? manifest);
          if (manifest.entities.length > 0) {
            setPages((current) => [...current, manifest.entities]);
          }

          cursor = manifest.next_cursor ?? null;
          cursorRef.current = cursor;
          if (cursor == null) {
            setComplete(true);
            return;
          }
        }
      } catch (e) {
        if (token !== walkToken.current) return;
        setError(e instanceof Error ? e.message : 'Could not load the artifact manifest.');
      } finally {
        if (token === walkToken.current) setLoading(false);
      }
    },
    [artifact, version, target, options],
  );

  useEffect(() => {
    if (!enabled || !artifact || !target) return;
    const token = ++walkToken.current;
    // A new configuration is a new walk: reset the accumulation before the first window.
    cursorRef.current = null;
    firstHashRef.current = null;
    setPage(null);
    setPages([]);
    setComplete(false);
    setError(null);
    void fetchWindow(token, null);
    return () => {
      // Invalidate the in-flight walk so a late page cannot settle stale state.
      walkToken.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- optionsKey stands in for `options` content
  }, [enabled, artifact, version, target, optionsKey]);

  const loadMore = useCallback(() => {
    if (loading || complete || cursorRef.current == null) return;
    void fetchWindow(walkToken.current, cursorRef.current);
  }, [loading, complete, fetchWindow]);

  return { page, entities, loading, error, complete, loadMore };
}

export default useExportPreviewManifest;
