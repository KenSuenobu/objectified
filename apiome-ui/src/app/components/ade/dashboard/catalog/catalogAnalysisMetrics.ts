/**
 * Privacy-safe catalog analysis metrics client (CPDO-4.2, #4805).
 *
 * Posts a whitelisted `{ kind, surface, latency_ms?, page_total? }` payload to
 * `/api/catalog/analysis-metrics` so operations can watch UI latency on the
 * payload-detail surfaces. Never send node names, values, source locations, or
 * item names — the REST handler rejects unknown fields, unknown kinds, and
 * unknown surfaces.
 */

/** The screen regions allowed to report latency (mirrors the REST allowlist). */
export type CatalogAnalysisSurface =
  | 'format_tab'
  | 'x12_inspector'
  | 'copybook_inspector'
  | 'projection_graph'
  | 'evidence_drawer'
  | 'conversion_history'
  | 'source_viewer';

export interface CatalogAnalysisMetricPayload {
  /** The only kind the UI may report; server-side kinds cannot be forged from here. */
  kind: 'ui_latency';
  /** Which surface measured itself — a controlled vocabulary, never content. */
  surface: CatalogAnalysisSurface;
  /** Wall-clock latency the surface measured, in milliseconds. */
  latency_ms?: number;
  /** Optional integer row/edge total (no labels). */
  page_total?: number;
}

/**
 * Record one privacy-safe catalog analysis metric. Failures are swallowed —
 * telemetry must never block or break the catalog UI.
 *
 * @param payload Whitelisted kind + surface + integer/duration fields only.
 */
export async function trackCatalogAnalysisMetric(
  payload: CatalogAnalysisMetricPayload,
): Promise<void> {
  try {
    await fetch('/api/catalog/analysis-metrics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(payload),
    });
  } catch {
    // Best-effort; ignore transport errors.
  }
}

/**
 * Millisecond timestamp for latency measurement — `performance.now()` when the
 * environment has it (browsers, jsdom), wall clock otherwise (SSR safety).
 */
export function metricNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
