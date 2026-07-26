'use client';

import { useEffect, useState } from 'react';
import type { ExportTargetsResponse } from './exportTargetCatalog';

export interface UseExportTargetsResult {
  /** The targets response once loaded (targets + resolved source coordinates), else null. */
  response: ExportTargetsResponse | null;
  loading: boolean;
  /** Load error; the dialog surfaces it and offers a retry by reopening. */
  error: string | null;
  /**
   * The HTTP status of a failed load (null while ok/loading). The Export Studio uses it to explain
   * a stale deep link — a deleted version (404) or a source outside the viewer's tenant (403) —
   * instead of repeating the generic loader message (MFX-41.4).
   */
  status: number | null;
}

/**
 * Load the export-target list for one source revision (MFX-6.1, #3855).
 *
 * Fetches `GET /api/export/targets?artifact=…&version=…` — every registered emitter with its
 * per-source fidelity badge (MFX-2.5) — while `enabled` is truthy (i.e. while the ExportDialog
 * is open). Mirrors `../useImportSources`; unlike the import grid there are no built-in cards,
 * so the dialog shows a loading state until the response lands.
 *
 * @param enabled Only fetch while truthy (e.g. while the dialog is open).
 * @param artifact The artifact (project) id to export.
 * @param version The revision to measure (UUID or label); the latest revision when omitted.
 */
export function useExportTargets(
  enabled: boolean,
  artifact: string,
  version?: string | null,
): UseExportTargetsResult {
  const [response, setResponse] = useState<ExportTargetsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled || !artifact) return;

    let cancelled = false;

    // All state mutations live inside this async helper (not the effect body) so we never call
    // setState synchronously during the effect — which would trigger cascading renders.
    const load = async () => {
      setLoading(true);
      setError(null);
      setStatus(null);
      try {
        const params = new URLSearchParams({ artifact });
        if (version) params.set('version', version);
        const res = await fetch(`/api/export/targets?${params.toString()}`, {
          credentials: 'include',
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data?.success === false) {
          if (!cancelled) setStatus(typeof res.status === 'number' ? res.status : null);
          throw new Error(
            typeof data?.error === 'string' ? data.error : 'Could not load export targets.',
          );
        }
        if (cancelled) return;
        setResponse(data as ExportTargetsResponse);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Could not load export targets.');
        setResponse(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [enabled, artifact, version]);

  return { response, loading, error, status };
}
