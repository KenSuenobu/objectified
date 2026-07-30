/**
 * Pure model + helpers for the Reference Resolver view (#3470).
 *
 * Mirrors the REST resolver API response (`POST /v1/types/{tenant_slug}/resolve`, #3459)
 * and turns it into the flattened per-edge rows, namespace/status filters, and summary
 * counts the resolver view renders. Kept free of React/DOM so it is unit-testable.
 *
 * Edge status is `resolved` / `unresolved` today; `circular` is reserved for cycle
 * detection (#3458) and already handled throughout so the UI lights up when that lands.
 */

/** Resolution status of a single dependency edge. */
export type RefStatus = 'resolved' | 'unresolved' | 'circular';

/** One re-resolved `$ref` dependency edge of a primitive (REST `ResolvedRefEdge`). */
export interface ResolvedRefEdge {
  relative_ref: string | null;
  resolved_target: string | null;
  status: RefStatus;
  target_id?: string | null;
  target_name?: string | null;
}

/** A primitive and its re-resolved dependency edges (REST `ResolvedPrimitiveRefs`). */
export interface ResolvedPrimitiveRefs {
  id: string;
  name: string;
  schema_id?: string | null;
  namespace?: string | null;
  base_uri?: string | null;
  ref_count: number;
  resolved_count: number;
  unresolved_count: number;
  refs: ResolvedRefEdge[];
}

/** Tenant-wide re-resolution result (REST `ResolveResponse`). */
export interface ResolveResponse {
  total_primitives: number;
  ref_count: number;
  resolved_ref_count: number;
  unresolved_ref_count: number;
  affected_primitive_count: number;
  reresolved_primitive_count: number;
  primitives: ResolvedPrimitiveRefs[];
}

/** Filter over the resolution table by edge status. */
export type ResolverStatusFilter = 'all' | RefStatus;

/** Registry import-source root — the read-only "resolution base" shown in the control. */
export const REGISTRY_BASE_URL = 'https://api.apiome.dev/types/';

/** A single flattened row of the resolution table: one source primitive → one `$ref`. */
export interface ResolverEdgeRow {
  /** Stable React key. */
  key: string;
  sourceId: string;
  /** `namespace/name` (or bare `name` when the primitive has no namespace). */
  sourceLabel: string;
  sourceNamespace: string | null;
  relativeRef: string;
  /** Resolved target with the registry base stripped for display. */
  resolvedTarget: string;
  /** Resolved target exactly as persisted (absolute or already-relative). */
  resolvedTargetRaw: string | null;
  /**
   * The primitive this edge points at, when the resolver found one (REST `_reresolve_edges` sets it
   * alongside the status). Its presence — not the status — is what makes a target openable.
   */
  targetId: string | null;
  targetName: string | null;
  status: RefStatus;
  /** A tenant type resolving to a system/core (`std/…`) target. */
  crossScope: boolean;
}

/** An empty response, used as the initial/error state. */
export function emptyResolveResponse(): ResolveResponse {
  return {
    total_primitives: 0,
    ref_count: 0,
    resolved_ref_count: 0,
    unresolved_ref_count: 0,
    affected_primitive_count: 0,
    reresolved_primitive_count: 0,
    primitives: [],
  };
}

/** Build the `namespace/name` label for a source primitive (falls back to bare name). */
export function sourceLabel(primitive: Pick<ResolvedPrimitiveRefs, 'name' | 'namespace'>): string {
  const namespace = primitive.namespace?.trim();
  return namespace ? `${namespace}/${primitive.name}` : primitive.name;
}

/**
 * Strip the registry base URL from a resolved target so the table shows the registry
 * path (`std/v0/primitives/string`) rather than the full absolute URI. Targets that are
 * already relative (or empty) are returned unchanged.
 */
export function shortenTarget(resolvedTarget: string | null, base: string = REGISTRY_BASE_URL): string {
  if (!resolvedTarget) return '';
  return resolvedTarget.startsWith(base) ? resolvedTarget.slice(base.length) : resolvedTarget;
}

/**
 * Derive the read-only resolution base from the data: the registry root up to and
 * including `/types/`. Falls back to {@link REGISTRY_BASE_URL} when no base URI is present.
 */
export function deriveResolutionBase(primitives: ResolvedPrimitiveRefs[]): string {
  const marker = '/types/';
  for (const primitive of primitives) {
    const base = primitive.base_uri;
    if (base) {
      const idx = base.indexOf(marker);
      if (idx >= 0) return base.slice(0, idx + marker.length);
    }
  }
  return REGISTRY_BASE_URL;
}

/** True when a tenant-scoped source resolves to a system/core (`std/…`) target. */
export function isCrossScope(sourceNamespace: string | null, shortenedTarget: string): boolean {
  return Boolean(sourceNamespace?.startsWith('tenant/')) && shortenedTarget.startsWith('std/');
}

/**
 * Flatten the per-primitive listing into one row per `$ref` edge, in source order.
 * Edges with no `relative_ref` (malformed/legacy rows) are skipped.
 */
export function flattenResolverEdges(
  primitives: ResolvedPrimitiveRefs[],
  base: string = REGISTRY_BASE_URL
): ResolverEdgeRow[] {
  const rows: ResolverEdgeRow[] = [];
  for (const primitive of primitives) {
    const namespace = primitive.namespace ?? null;
    const label = sourceLabel(primitive);
    primitive.refs.forEach((edge, index) => {
      if (!edge.relative_ref) return;
      const shortened = shortenTarget(edge.resolved_target, base);
      rows.push({
        key: `${primitive.id}:${index}`,
        sourceId: primitive.id,
        sourceLabel: label,
        sourceNamespace: namespace,
        relativeRef: edge.relative_ref,
        resolvedTarget: shortened,
        resolvedTargetRaw: edge.resolved_target ?? null,
        targetId: edge.target_id ?? null,
        targetName: edge.target_name ?? null,
        status: edge.status,
        crossScope: isCrossScope(namespace, shortened),
      });
    });
  }
  return rows;
}

/**
 * The dashboard route for a resolved target's details, or `null` when there is nothing to open.
 *
 * An unresolved edge has no target row — that is what "unresolved" means — so its target is plain
 * text rather than a dead link. Reuses the same type-detail screen the primitives list opens.
 */
export function resolverTargetHref(row: Pick<ResolverEdgeRow, 'targetId'>): string | null {
  return row.targetId ? `/ade/dashboard/primitives/${row.targetId}` : null;
}

/** A screen-reader/tooltip label for the link that opens a target's details. */
export function resolverTargetLinkLabel(row: Pick<ResolverEdgeRow, 'resolvedTarget' | 'targetName'>): string {
  return `View details for ${row.resolvedTarget || row.targetName || 'resolved target'}`;
}

/** Unique, sorted source namespaces present in the listing (for the namespace filter). */
export function collectNamespaces(primitives: ResolvedPrimitiveRefs[]): string[] {
  const set = new Set<string>();
  for (const primitive of primitives) {
    const namespace = primitive.namespace?.trim();
    if (namespace) set.add(namespace);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

/** Filter flattened rows by namespace (`all` → no filter) and status (`all` → no filter). */
export function filterResolverRows(
  rows: ResolverEdgeRow[],
  options: { namespace: string; status: ResolverStatusFilter }
): ResolverEdgeRow[] {
  return rows.filter((row) => {
    if (options.namespace !== 'all' && row.sourceNamespace !== options.namespace) return false;
    if (options.status !== 'all' && row.status !== options.status) return false;
    return true;
  });
}

/** Count edges by status across all rows (forward-compatible with `circular`, #3458). */
export function summarizeStatuses(rows: ResolverEdgeRow[]): {
  resolved: number;
  unresolved: number;
  circular: number;
} {
  const summary = { resolved: 0, unresolved: 0, circular: 0 };
  for (const row of rows) {
    if (row.status === 'resolved') summary.resolved += 1;
    else if (row.status === 'unresolved') summary.unresolved += 1;
    else if (row.status === 'circular') summary.circular += 1;
  }
  return summary;
}

/** Human label for a status badge. */
export function statusLabel(status: RefStatus): string {
  switch (status) {
    case 'resolved':
      return 'Resolved';
    case 'unresolved':
      return 'Unresolved';
    case 'circular':
      return 'Circular';
    default:
      return status;
  }
}

/** Tailwind badge classes for a status (emerald / amber / red). */
export function statusBadgeClass(status: RefStatus): string {
  switch (status) {
    case 'resolved':
      return 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300';
    case 'unresolved':
      return 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300';
    case 'circular':
      return 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300';
    default:
      return 'bg-gray-100 text-gray-700 dark:bg-gray-900/40 dark:text-gray-300';
  }
}
