/**
 * Wire contract + fetch helper for the catalog conversion projection manifest (CPDO-3.1, #4801).
 *
 * The server side is CPDO-1.3 (#4800): `POST /v1/catalog/{tenant}/{item}/projection` rebuilds the
 * deterministic conversion manifest for a catalog item's latest revision and returns one
 * cursor-paginated page of its edges plus the snapshot summary. This module mirrors that contract
 * field-for-field (apiome-rest `app/conversion_projection.py` / `app/models.py`) so responses
 * deserialize directly, and carries the client-side page integrity checks the renderer refuses
 * untrusted pages with — the same discipline as the export evidence reader
 * (`components/ade/dashboard/export/projectionEvidence.ts`).
 *
 * Serialization note: only the top-level `CatalogProjectionResponse` uses camelCase aliases
 * (`itemId`, `versionRecordId`); everything nested — summary, page, edges, nodes — is snake_case,
 * exactly as the server dumps it.
 *
 * Everything here is pure apart from {@link fetchConversionProjection}; keep the vocabulary in
 * sync with `apiome-rest/src/app/projection_taxonomy.py`.
 */

import { cleanDefaults, type ConversionDefaults } from './conversion-fidelity';

// ---------------------------------------------------------------------------
// Vocabulary (mirrors projection_taxonomy.py)
// ---------------------------------------------------------------------------

/** How a construct fared in the conversion (mirrors `ConversionStatus`). */
export type ConversionProjectionStatus =
  | 'retained'
  | 'transformed'
  | 'inferred'
  | 'dropped'
  | 'unavailable'
  | 'not-applicable';

/** Every conversion status, in worst-first order (the server's admission order). */
export const CONVERSION_PROJECTION_STATUSES: readonly ConversionProjectionStatus[] = [
  'dropped',
  'unavailable',
  'inferred',
  'transformed',
  'not-applicable',
  'retained',
];

/** Why a construct did not fully carry over (mirrors `ProjectionReason`). */
export type ConversionProjectionReason =
  | 'destination_unsupported'
  | 'emitter_unsupported'
  | 'source_incomplete'
  | 'source_parse_limit'
  | 'option_excluded'
  | 'security_redacted'
  | 'target_tool_unavailable'
  | 'not_applicable';

/** The four edge scopes — four sources of truth (mirrors `ConversionEdgeScope`). */
export type ConversionEdgeScope = 'checklist' | 'construct' | 'loss' | 'analysis';

/** Edge severities (shared with the fidelity losses). */
export type ConversionEdgeSeverity = 'info' | 'warn' | 'critical';

// ---------------------------------------------------------------------------
// Graph shapes (snake_case, as serialized)
// ---------------------------------------------------------------------------

/** Source-native provenance carried on a `source` node (may be absent). */
export interface ConversionSourceEvidence {
  native_id: string | null;
  native_name: string | null;
  /** Parser-recorded source location (e.g. a line), as free text. */
  source_location: string | null;
  /** Coarse construct class: operation / channel / type / field / checklist / loss / analysis. */
  construct_kind: string | null;
}

/** Target-side location carried on a `target` node. */
export interface ConversionTargetLocation {
  json_pointer: string | null;
  native_path: string | null;
}

/** One graph node: a source construct or an emitted-document location. */
export interface ConversionProjectionNode {
  id: string;
  kind: 'source' | 'target';
  /** Display label — imported text; sanitize before rendering. */
  label: string;
  construct_key: string | null;
  source: ConversionSourceEvidence | null;
  target: ConversionTargetLocation | null;
}

/** One evidence reference an edge carries (analysis node, document pointer, construct). */
export interface ConversionEvidenceRef {
  kind: 'analysis-node' | 'document-pointer' | 'source-construct';
  ref: string;
  location: {
    file: string | null;
    line: number | null;
    column: number | null;
    offset: number | null;
    length: number | null;
    ordinal: number | null;
    path: string | null;
  } | null;
}

/** One projection edge: what one construct became, or why it did not. */
export interface ConversionProjectionEdge {
  id: string;
  scope: ConversionEdgeScope;
  /** Source node id. */
  source: string;
  /** Target node id, or null when nothing in the document corresponds. */
  target: string | null;
  status: ConversionProjectionStatus;
  /** Required by the server whenever the status is not `retained`. */
  reason: ConversionProjectionReason | null;
  severity: ConversionEdgeSeverity;
  /** Human explanation — interpolates imported text; sanitize before rendering. */
  detail: string;
  /** Conversion-phrased fix, null only for `retained`. */
  remediation: string | null;
  evidence: ConversionEvidenceRef[];
  /** Instances this edge stands for (checklist rows aggregate); >= 1. */
  count: number;
}

// ---------------------------------------------------------------------------
// Summary + page (snake_case, as serialized)
// ---------------------------------------------------------------------------

/** Where the manifest's source came from. */
export interface ConversionManifestSourceRef {
  project_id: string | null;
  version_record_id: string | null;
  source_format: string | null;
  source_protocol: string | null;
  source_version_label: string | null;
  paradigm: string | null;
  analysis: {
    available: boolean;
    status: string;
    status_reason: string | null;
    analyzer_key: string | null;
    analyzer_version: string | null;
    node_count: number;
    truncated: boolean;
    unsupported_constructs: string[];
  };
}

/** The bounded snapshot summary (also embedded in the dry-run response as `projection`). */
export interface ConversionManifestSummary {
  schema_version: string;
  /** sha256 hex — the snapshot identity every page must agree on. */
  manifest_hash: string;
  source: ConversionManifestSourceRef;
  target_format: string;
  conversion_mode: string;
  tool_versions: Record<string, string>;
  defaults: { title?: string; version?: string; servers?: string[] };
  /** Per-status edge tally, zero-filled over every status. */
  status_counts: Record<string, number>;
  reason_counts: Record<string, number>;
  scope_counts: Record<string, number>;
  node_count: number;
  edge_count: number;
  total_constructs: number;
  is_lossless: boolean;
  worst_severity: ConversionEdgeSeverity | null;
  /** True when the server's own edge bounds dropped construct/analysis edges. */
  truncated: boolean;
  dropped_edge_count: number;
}

/** One cursor page of edges plus the nodes those edges reference. */
export interface ConversionEvidencePage {
  manifest_hash: string;
  edges: ConversionProjectionEdge[];
  nodes: ConversionProjectionNode[];
  next_cursor: string | null;
  /** Total edges in the paged scope (the whole manifest when no scope was given). */
  total: number;
}

/** The projection endpoint's response (top level is camelCase). */
export interface CatalogProjectionResponse {
  itemId: string;
  versionRecordId: string | null;
  target: string;
  summary: ConversionManifestSummary;
  page: ConversionEvidencePage;
}

/**
 * A pluggable page source for the projection walk (CPDO-3.3, #4803).
 *
 * The live preview walks the rebuild endpoint; a conversion-history reader walks a *persisted*
 * evidence snapshot instead. Both hand the walk hook a function of this shape, so every
 * integrity check (per-page structure, cross-page snapshot identity, windowing) applies to
 * stored evidence exactly as it does to a fresh rebuild.
 */
export type ConversionEvidencePageSource = (opts: {
  cursor: string | null;
  limit: number;
}) => Promise<CatalogProjectionResponse>;

// ---------------------------------------------------------------------------
// Page integrity
// ---------------------------------------------------------------------------

const KNOWN_STATUSES: ReadonlySet<string> = new Set(CONVERSION_PROJECTION_STATUSES);
const KNOWN_SCOPES: ReadonlySet<string> = new Set(['checklist', 'construct', 'loss', 'analysis']);

/**
 * Structural problems that make a page untrustworthy to render.
 *
 * A page is refused — never partially rendered — when an edge references a node the page did
 * not bundle, carries an unknown status/scope, or a non-retained edge arrives without a reason
 * (the server enforces reasons on its model, so absence means the payload is not what the
 * server sent). Mirrors the export reader's `evidencePageIssues` discipline.
 *
 * @param page The page as deserialized from the response.
 * @returns Human-readable issue strings; empty when the page is coherent.
 */
export function conversionEvidencePageIssues(page: ConversionEvidencePage): string[] {
  const issues: string[] = [];
  const nodeIds = new Set(page.nodes.map((node) => node.id));
  for (const edge of page.edges) {
    if (!nodeIds.has(edge.source)) {
      issues.push(`edge '${edge.id}' references source node '${edge.source}' missing from the page`);
    }
    if (edge.target != null && !nodeIds.has(edge.target)) {
      issues.push(`edge '${edge.id}' references target node '${edge.target}' missing from the page`);
    }
    if (!KNOWN_STATUSES.has(edge.status)) {
      issues.push(`edge '${edge.id}' carries unknown status '${edge.status}'`);
    }
    if (!KNOWN_SCOPES.has(edge.scope)) {
      issues.push(`edge '${edge.id}' carries unknown scope '${edge.scope}'`);
    }
    if (edge.status !== 'retained' && edge.reason == null) {
      issues.push(`edge '${edge.id}' is '${edge.status}' but carries no reason code`);
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/** Edges requested per page (within the server's hard cap of 500). */
export const CONVERSION_PROJECTION_PAGE_LIMIT = 200;

/** Options for one projection page fetch. */
export interface FetchConversionProjectionOptions {
  /** Gap-filling defaults — must match the previewed conversion for snapshot identity. */
  defaults?: ConversionDefaults;
  /** Restrict to one edge scope; omitted pages every scope in canonical order. */
  scope?: ConversionEdgeScope;
  /** Opaque continuation cursor from the previous page. */
  cursor?: string | null;
  /** Page size (server-clamped to [1, 500]). */
  limit?: number;
  signal?: AbortSignal;
}

/**
 * Fetch one page of a catalog item's conversion projection manifest (CPDO-1.3).
 *
 * POSTs the Next proxy `/api/catalog/{itemId}/projection`, which forwards to REST
 * `POST /v1/catalog/{tenant}/{item}/projection`. Read-only despite the verb — the body
 * carries the defaults folded into the snapshot hash plus the page window.
 *
 * @param itemId The catalog item id (a project id).
 * @param options Defaults, scope, cursor, limit, abort signal.
 * @returns The snapshot summary and one page of edges.
 * @throws Error with the server's message when the request fails.
 */
export async function fetchConversionProjection(
  itemId: string,
  options?: FetchConversionProjectionOptions,
): Promise<CatalogProjectionResponse> {
  const cleaned = options?.defaults ? cleanDefaults(options.defaults) : undefined;
  const response = await fetch(`/api/catalog/${encodeURIComponent(itemId)}/projection`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      target: 'openapi',
      defaults: cleaned && Object.keys(cleaned).length > 0 ? cleaned : undefined,
      scope: options?.scope,
      cursor: options?.cursor ?? undefined,
      limit: options?.limit ?? CONVERSION_PROJECTION_PAGE_LIMIT,
    }),
    signal: options?.signal,
  });
  const data = (await response.json().catch(() => null)) as
    | (CatalogProjectionResponse & { success?: boolean; error?: string; detail?: string })
    | null;
  if (!response.ok || !data || data.success === false) {
    const message =
      (data && (data.error || data.detail)) ||
      `Failed to load the projection graph (HTTP ${response.status})`;
    throw new Error(typeof message === 'string' ? message : 'Failed to load the projection graph');
  }
  return data;
}
