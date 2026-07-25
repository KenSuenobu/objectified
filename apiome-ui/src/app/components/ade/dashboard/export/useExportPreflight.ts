'use client';

import { useEffect, useMemo, useState } from 'react';
import { readinessByTarget, type ExportPreflightReport, type ExportPreflightTarget } from './exportReadiness';

export interface UseExportPreflightResult {
  /** The pre-flight report once loaded, else null. */
  report: ExportPreflightReport | null;
  /** The report's targets indexed by registry key, for O(1) lookup while rendering cards. */
  readiness: Record<string, ExportPreflightTarget>;
  loading: boolean;
  /** Load error; the grid degrades to its registry ordering rather than blocking on it. */
  error: string | null;
}

/**
 * Load the export pre-flight ranking for one source revision (IXH-2.4, #5099).
 *
 * Fetches `POST /api/export/preflight` — every target's readiness score, band, and rationale, plus
 * the source's own lint grade — while `enabled` is truthy. Findings are not requested: the grid
 * renders grades and rationales, not the finding list, so the payload stays small.
 *
 * The ranking is an **enhancement**: a failure leaves `readiness` empty and the caller keeps the
 * registry ordering the grid has always had, rather than showing an error where a target list
 * belongs.
 *
 * @param enabled Only fetch while truthy (e.g. while the export surface is open).
 * @param artifact The artifact (project) id to export.
 * @param version The revision to rank (UUID or label); the latest revision when omitted.
 */
export function useExportPreflight(
  enabled: boolean,
  artifact: string,
  version?: string | null,
): UseExportPreflightResult {
  const [report, setReport] = useState<ExportPreflightReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !artifact) return;

    let cancelled = false;

    // All state mutations live inside this async helper (not the effect body) so we never call
    // setState synchronously during the effect — which would trigger cascading renders.
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch('/api/export/preflight', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            artifact,
            version: version ?? null,
            include_findings: false,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data?.success === false) {
          throw new Error(
            typeof data?.error === 'string' ? data.error : 'Could not rank export targets.',
          );
        }
        if (cancelled) return;
        setReport(data as ExportPreflightReport);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Could not rank export targets.');
        setReport(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [enabled, artifact, version]);

  const readiness = useMemo(() => readinessByTarget(report), [report]);

  return { report, readiness, loading, error };
}
