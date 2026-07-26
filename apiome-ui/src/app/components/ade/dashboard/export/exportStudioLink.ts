/**
 * Export Studio deep-link contract (MFX-41.1, #4348).
 *
 * The Studio route `…/ade/dashboard/export/studio` is always scoped to a source — it is never a
 * bare global screen. This module is the single place that builds and reads that scoped URL, so
 * the ExportDialog's "Open in Export Studio" escalation and the Studio page agree on the query
 * parameters:
 *  - `artifact` (required) — the artifact (project / catalog-item) id to export;
 *  - `version` — the revision selector (UUID or label); the latest revision when omitted;
 *  - `label` — a human name for the source, shown in the header (falls back to the id);
 *  - `target` — a pre-selected emitter key carried from the dialog's current selection;
 *  - `from` — where the export was launched from, so the Studio's back link returns there;
 *  - `sourceFormat` — the source's original import format (e.g. `graphql`), so the Studio can
 *    hide the redundant same-format target and offer the original source unchanged.
 *  - `opts` — a compact (base64url-JSON) map of non-default option overrides, so a "re-run in
 *    Studio" (MFX-41.3) or a shared link (MFX-41.4) reopens the Studio with those option values
 *    pre-filled. Credential-shaped keys are never encoded; the legacy plain-JSON `options` param
 *    still decodes, so links minted before MFX-41.4 keep working.
 *  - `step` — the stepper stop to resume on (MFX-41.4), so a copied link reproduces the session
 *    where its author left it. Omitted for the first (`source`) step.
 *
 * Reading a Studio URL back — validation, graceful degradation, and step clamping — lives in
 * `exportStudioUrlState.ts`, which this module builds on.
 */

import {
  encodeStudioOptions,
  decodeStudioOptions,
  STUDIO_OPTIONS_PARAM,
  STUDIO_STEP_PARAM,
  type ExportStudioStep,
} from './exportStudioUrlState';

/** The base path of the Export Studio route (tenant-scoped by the dashboard layout). */
export const EXPORT_STUDIO_PATH = '/ade/dashboard/export/studio';

/** Where an export was launched from — determines the Studio's "back" destination. */
export type ExportStudioOrigin = 'versions' | 'catalog';

/** A resolved back-link target: where to return and what to call it. */
export interface ExportStudioBackTarget {
  href: string;
  label: string;
}

/** The known launch origins and the screen each returns to. */
const STUDIO_BACK_TARGETS: Record<ExportStudioOrigin, ExportStudioBackTarget> = {
  versions: { href: '/ade/dashboard/versions', label: 'Versions' },
  catalog: { href: '/ade/dashboard/catalog', label: 'Catalog' },
};

/** The fallback origin when none was carried (the version view is the primary export entry). */
const DEFAULT_STUDIO_ORIGIN: ExportStudioOrigin = 'versions';

/**
 * Resolve the Studio's back-link target for a carried origin. Unknown or missing origins fall
 * back to the Versions screen, so the link is always valid.
 */
export function resolveStudioBack(origin: string | null | undefined): ExportStudioBackTarget {
  if (origin && Object.prototype.hasOwnProperty.call(STUDIO_BACK_TARGETS, origin)) {
    return STUDIO_BACK_TARGETS[origin as ExportStudioOrigin];
  }
  return STUDIO_BACK_TARGETS[DEFAULT_STUDIO_ORIGIN];
}

/** The scoped source the Studio opens against, carried in the deep link. */
export interface ExportStudioScope {
  /** The artifact (project / catalog-item) id to export. Required — no bare global screen. */
  artifact: string;
  /** The revision selector (UUID or label); the latest revision when null/undefined. */
  version?: string | null;
  /** A human name for the source, shown in the header. */
  label?: string | null;
  /** A pre-selected emitter key (the dialog's current target selection), when escalating. */
  target?: string | null;
  /** Where the export was launched from, so the Studio's back link returns there. */
  origin?: ExportStudioOrigin | null;
  /** The source's original import format (e.g. `graphql`), when known (catalog sources). */
  sourceFormat?: string | null;
  /**
   * Non-default option overrides to pre-fill (the `changedOptions` payload of a prior run), so a
   * "re-run in Studio" (MFX-41.3) reproduces that run's configuration. Omitted/empty carries no
   * `opts` param, leaving the target at its defaults. Credential-shaped keys are stripped before
   * encoding — a delivery secret never rides in a URL (MFX-41.4).
   */
  options?: Record<string, unknown> | null;
  /**
   * The stepper stop to resume on (MFX-41.4). Omitted for `source`, which is where a link with no
   * step opens anyway. The Studio clamps this to what the link can actually establish.
   */
  step?: ExportStudioStep | null;
}

/**
 * Build the Export Studio href for a scoped source. Empty/undefined optional fields are omitted
 * so the URL only carries what was actually selected.
 *
 * @param scope The source (and optional pre-selected target / origin / format) to open against.
 * @returns A root-relative URL, e.g. `/ade/dashboard/export/studio?artifact=proj-1&target=proto`.
 */
export function exportStudioHref(scope: ExportStudioScope): string {
  const params = new URLSearchParams({ artifact: scope.artifact });
  if (scope.version) params.set('version', scope.version);
  if (scope.label) params.set('label', scope.label);
  if (scope.target) params.set('target', scope.target);
  if (scope.origin) params.set('from', scope.origin);
  if (scope.sourceFormat) params.set('sourceFormat', scope.sourceFormat);
  const encodedOptions = encodeStudioOptions(scope.options);
  if (encodedOptions) params.set(STUDIO_OPTIONS_PARAM, encodedOptions);
  if (scope.step && scope.step !== 'source') params.set(STUDIO_STEP_PARAM, scope.step);
  return `${EXPORT_STUDIO_PATH}?${params.toString()}`;
}

/**
 * Build the absolute, shareable URL for a Studio session — what the Studio's "Copy link" action
 * puts on the clipboard (MFX-41.4).
 *
 * @param scope The session to reproduce (source, target, options, step).
 * @param baseUrl The origin to resolve against; defaults to the current page's origin in the
 *                browser. Without either (server-side rendering) the root-relative href is returned.
 * @returns An absolute URL when an origin is known, else the root-relative href.
 */
export function buildExportStudioShareUrl(scope: ExportStudioScope, baseUrl?: string): string {
  const href = exportStudioHref(scope);
  const origin =
    baseUrl ?? (typeof window !== 'undefined' ? window.location.origin : undefined);
  if (!origin) return href;
  try {
    return new URL(href, origin).toString();
  } catch {
    return href;
  }
}

/**
 * Parse the Studio's option-overrides deep-link param back into an override map — the compact
 * `opts` form or the legacy plain-JSON `options` one. Tolerant by design: a missing, malformed, or
 * non-object value yields null, so a hand-edited URL can never break the Studio — it simply opens
 * the target at its defaults.
 *
 * @param raw The raw query-string value (e.g. from `searchParams.get('opts')`).
 * @returns The decoded, secret-free override map, or null when absent/unparseable.
 */
export function parseExportStudioOptions(
  raw: string | null | undefined,
): Record<string, unknown> | null {
  return decodeStudioOptions(raw);
}
