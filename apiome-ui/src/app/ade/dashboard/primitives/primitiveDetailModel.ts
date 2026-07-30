/**
 * Pure, view-model helpers for the Primitives type-detail page (#3468).
 *
 * The detail page renders a single registry type "beyond the edit dialog": its
 * resolved `$ref` table, base chain, dependents, metadata and a generated example
 * instance. The presentation-free derivations live here so they can be unit-tested
 * without rendering React, and reused by the client component.
 */

/** A single outgoing relative-`$ref` edge as persisted on `apiome.primitives.refs`. */
export interface RefEdge {
  relative_ref?: string;
  resolved_target?: string;
  status?: string;
  /**
   * The type this edge points at, resolved server-side by `annotate_ref_targets` — the stored edge
   * holds only the target's `$id`, which is enough to show but not to navigate to. Both are
   * `null`/absent when the `$ref` resolves to nothing.
   */
  target_id?: string | null;
  target_name?: string | null;
}

/**
 * The dashboard route for the type an edge references, or `null` when there is nothing to open.
 *
 * An unresolved `$ref` has no target type — that is what unresolved means — so its `$ref` stays
 * plain text rather than becoming a dead link.
 */
export function refEdgeTargetHref(edge: Pick<RefEdge, 'target_id'>): string | null {
  return edge.target_id ? `/ade/dashboard/primitives/${edge.target_id}` : null;
}

/** Tooltip/screen-reader label for the link that opens an edge's target type. */
export function refEdgeTargetLabel(edge: Pick<RefEdge, 'target_name' | 'resolved_target'>): string {
  return `View details for ${edge.target_name || edge.resolved_target || 'reference target'}`;
}

/**
 * The same two helpers for a base-chain node, which carries the target identity under camelCase
 * names. They delegate rather than re-derive, so the route and label can never drift apart.
 */
export function baseChainNodeHref(node: Pick<BaseChainNode, 'targetId'>): string | null {
  return refEdgeTargetHref({ target_id: node.targetId });
}

export function baseChainNodeLabel(node: Pick<BaseChainNode, 'targetName' | 'target'>): string {
  return refEdgeTargetLabel({ target_name: node.targetName, resolved_target: node.target });
}

/**
 * A type that references this primitive, from the reverse index the single-type GET
 * computes (#3477). One entry per referencing `$ref` edge, so a type that references
 * this one from two properties appears twice.
 */
export interface DependentRef {
  /** The referencing type's id, for linking to its detail page. */
  id?: string | null;
  schema_id?: string | null;
  namespace?: string | null;
  name?: string | null;
  /** The property carrying the reference; `null` when the whole type is the reference. */
  property?: string | null;
  scope?: 'system' | 'tenant';
  tenant_label?: string | null;
}

/** The dashboard route for a dependent type, or `null` when it carries no id. */
export function dependentHref(dep: Pick<DependentRef, 'id'>): string | null {
  return refEdgeTargetHref({ target_id: dep.id });
}

/** One node in the base chain: the type itself, then each of its ref edges. */
export interface BaseChainNode {
  /** The display label — the type name for the head node, else the relative `$ref`. */
  label: string;
  /** The absolute/registry target a ref edge resolves to (undefined for the head). */
  target?: string;
  /** `self` for the head node, `ref` for each edge. */
  kind: 'self' | 'ref';
  /** Resolution status carried from the edge (`resolved` / `unresolved`). */
  status?: string;
  /**
   * The referenced type's id, carried from the edge so a chain node can link to it. Absent on the
   * `self` head node and on any edge that resolves to nothing.
   */
  targetId?: string | null;
  /** The referenced type's name, for the link's label. */
  targetName?: string | null;
}

/** Aggregate "used in" counters shown in the right-rail mini-stats. */
export interface UsageSummary {
  /** Number of distinct types that reference this primitive. */
  dependentTypes: number;
  /** Number of property bindings (the primitive's `usage_count`). */
  properties: number;
  /** Number of distinct tenants among the dependents. */
  tenants: number;
}

/**
 * Build the base chain for a type: the type itself followed by one node per
 * outgoing `$ref` edge, in declaration order.
 *
 * @param typeName - The primitive's display name (head node).
 * @param refs - The primitive's resolved `$ref` edges (may be undefined/empty).
 * @returns Ordered chain nodes, always beginning with the type's own `self` node.
 */
export function buildBaseChain(typeName: string, refs?: RefEdge[]): BaseChainNode[] {
  const head: BaseChainNode = { label: typeName, kind: 'self' };
  const edges = (refs ?? [])
    .filter((edge) => Boolean(edge.relative_ref))
    .map<BaseChainNode>((edge) => ({
      label: edge.relative_ref as string,
      target: edge.resolved_target ?? undefined,
      status: edge.status ?? undefined,
      kind: 'ref',
      targetId: edge.target_id ?? null,
      targetName: edge.target_name ?? null,
    }));
  return [head, ...edges];
}

/**
 * The registry mount segment every derived `$id` hangs off.
 *
 * The API builds identity as `{REGISTRY_BASE_URL}{namespace}/{name-slug}` where `REGISTRY_BASE_URL`
 * is `https://api.apiome.dev/types/` (``schema_validation.derive_base_uri`` / ``derive_schema_id``).
 * Matching on the path segment rather than the whole base URL keeps this working for self-hosted
 * deployments serving the same registry layout from a different host.
 */
const REGISTRY_MOUNT_SEGMENT = 'types';

/** What a `$id` says about where its schema lives. */
export interface SchemaIdNamespace {
  /** The namespace path, or `null` when the id has no path above the type name. */
  namespace: string | null;
  /**
   * Whether the id sits under the registry mount, which makes {@link namespace} this deployment's
   * registry placement rather than a foreign document's own namespace. Callers that care about
   * registry placement (the type-detail screen) weigh the two differently.
   */
  registryMounted: boolean;
}

/**
 * Read the target namespace a JSON Schema `$id` declares.
 *
 * The namespace is the id's path with the trailing type-name segment removed — the same shape any
 * `$id`-addressed schema collection uses, not just this registry's:
 *
 * - `https://api.apiome.dev/types/std/v0/types/money` → `std/v0/types`
 * - `https://schemas.sourcemeta.com/self/v1/schemas/api/schemas/position` → `self/v1/schemas/api/schemas`
 *
 * The one special case is this registry's own mount: the API roots ids at
 * `{REGISTRY_BASE_URL}{namespace}/{name-slug}` (``schema_validation.derive_base_uri`` /
 * ``derive_schema_id``), so a leading `types` segment is the mount rather than part of the
 * namespace and is dropped. Foreign ids keep every segment, since nothing there is a mount.
 *
 * The result carries no leading slash, matching the namespace grammar the API accepts
 * (``_NAMESPACE_RE`` in ``type_namespaces_routes.py``).
 *
 * @param schemaId - The `$id` to read (from a schema document or the `schema_id` column).
 * @returns The namespace and whether it came from under the registry mount.
 */
export function parseSchemaIdNamespace(schemaId?: string | null): SchemaIdNamespace {
  const id = (schemaId ?? '').trim();
  if (!id) {
    return { namespace: null, registryMounted: false };
  }

  let path = id;
  try {
    path = new URL(id).pathname;
  } catch {
    // Not an absolute URL — read the value as a bare path.
  }

  const segments = path
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });

  const registryMounted = segments[0] === REGISTRY_MOUNT_SEGMENT;
  // Drop the mount (when present) and the trailing type-name segment; the rest is the namespace.
  const namespaceSegments = (registryMounted ? segments.slice(1) : segments).slice(0, -1);

  return {
    namespace: namespaceSegments.length > 0 ? namespaceSegments.join('/') : null,
    registryMounted,
  };
}

/**
 * Extract a JSON Schema's target namespace from its `$id`.
 *
 * @param schemaId - The `$id` to read.
 * @returns The namespace path, or `null` when the id is just a bare type name.
 */
export function namespaceFromSchemaId(schemaId?: string | null): string | null {
  return parseSchemaIdNamespace(schemaId).namespace;
}

/**
 * The namespace to display for a registry type.
 *
 * An `$id` under the registry mount states this deployment's own placement, so it wins outright.
 * Otherwise the type was given an explicit `base_uri` or an author-declared `$id` pointing outside
 * the registry, and the stored `namespace` column describes where it actually sits better than the
 * foreign id's path does — so the column is preferred, with the id's own namespace as a last resort.
 *
 * @param schemaId - The primitive's `$id`.
 * @param storedNamespace - The `namespace` column.
 * @returns The effective namespace path, or `null` when neither source has one.
 */
export function effectiveNamespace(
  schemaId?: string | null,
  storedNamespace?: string | null
): string | null {
  const { namespace, registryMounted } = parseSchemaIdNamespace(schemaId);
  if (namespace && registryMounted) {
    return namespace;
  }
  return storedNamespace ?? namespace ?? null;
}

/**
 * Derive the version-root segment (e.g. `v0`, `v1`) from a namespace path or base
 * URI. The registry organizes types under a version root; this reads the first
 * `v<digits>` path segment it finds.
 *
 * @param namespace - The namespace path (e.g. `std/v0/types`), if known.
 * @param baseUri - The absolute base URI, used as a fallback source.
 * @returns The version-root segment, or `null` when none is present.
 */
export function deriveVersionRoot(
  namespace?: string | null,
  baseUri?: string | null
): string | null {
  const source = namespace || baseUri || '';
  const match = source.match(/(?:^|[/])(v\d+)(?:[/]|$)/);
  return match ? match[1] : null;
}

/**
 * The human label for a type's storage scope.
 *
 * @param isSystem - Whether the primitive is a system-core type.
 * @returns `System · core` for system types, otherwise `Tenant`.
 */
export function scopeLabel(isSystem: boolean): string {
  return isSystem ? 'System · core' : 'Tenant';
}

/**
 * Derive the owning principal of a type for the metadata panel.
 *
 * @param isSystem - Whether the primitive is system-core (owned by `system`).
 * @param namespace - The namespace path; a `tenant/<slug>/…` path yields the slug.
 * @returns `system` for core types, the tenant slug when derivable, else `tenant`.
 */
export function deriveOwner(isSystem: boolean, namespace?: string | null): string {
  if (isSystem) {
    return 'system';
  }
  const match = (namespace ?? '').match(/^tenant\/([^/]+)/);
  return match ? match[1] : 'tenant';
}

/**
 * Aggregate the "used in" counters from the dependents list and binding count.
 *
 * Dependents arrive one entry per referencing `$ref` edge (#3477), so the type counter
 * de-duplicates: a type that references this one twice is one dependent type, not two.
 *
 * @param dependents - Types referencing this primitive (may be undefined/empty).
 * @param usageCount - The primitive's property-binding `usage_count`.
 * @returns Counts of dependent types, bound properties, and distinct tenants.
 */
export function summarizeUsage(
  dependents: DependentRef[] | undefined,
  usageCount: number
): UsageSummary {
  const list = dependents ?? [];
  const types = new Set(list.map((dep, index) => dep.id || dep.schema_id || `${dep.name}-${index}`));
  const tenants = new Set(
    list
      .filter((dep) => dep.scope !== 'system')
      .map((dep) => dep.tenant_label || dep.namespace || '')
      .filter((label) => label.length > 0)
  );
  return {
    dependentTypes: types.size,
    properties: Math.max(0, usageCount),
    tenants: tenants.size,
  };
}

/**
 * The filename used when exporting a type's JSON Schema. The name is slugified so
 * the download is filesystem-safe regardless of the primitive's display name.
 *
 * @param name - The primitive's display name.
 * @returns A `<slug>.schema.json` filename (falls back to `primitive.schema.json`).
 */
export function exportFileName(name: string): string {
  const slug = (name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'primitive'}.schema.json`;
}

/**
 * Serialize a type's JSON Schema document for export as pretty-printed JSON.
 *
 * @param schema - The primitive's JSON Schema document.
 * @returns A 2-space-indented JSON string (empty object when schema is absent).
 */
export function serializeSchemaExport(schema: Record<string, unknown> | undefined): string {
  return JSON.stringify(schema ?? {}, null, 2);
}

/** Internal: depth-bounded example generation guard to avoid runaway recursion. */
const MAX_EXAMPLE_DEPTH = 6;

/**
 * Best-effort generation of an example instance from a JSON Schema document.
 *
 * Resolution order at each node: an explicit `examples[0]`, then `default`, then
 * `const`, then `enum[0]`, then a value derived from `type`. Object properties are
 * walked recursively (depth-bounded); a property whose schema is only a `$ref` is
 * omitted because the target cannot be resolved client-side. Returns `null` when no
 * meaningful example can be produced, so the caller can hide the section.
 *
 * @param schema - The JSON Schema document (or sub-schema) to derive an example for.
 * @returns A representative instance value, or `null` when none can be produced.
 */
export function buildExampleInstance(schema: unknown): unknown {
  return generateExample(schema, 0);
}

function generateExample(schema: unknown, depth: number): unknown {
  if (depth > MAX_EXAMPLE_DEPTH || schema === null || typeof schema !== 'object') {
    return null;
  }
  const node = schema as Record<string, unknown>;

  if (Array.isArray(node.examples) && node.examples.length > 0) {
    return node.examples[0];
  }
  if ('default' in node) {
    return node.default;
  }
  if ('const' in node) {
    return node.const;
  }
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    return node.enum[0];
  }

  // A property that is purely a `$ref` cannot be resolved here — signal "no example".
  if (typeof node.$ref === 'string' && node.type === undefined && node.properties === undefined) {
    return null;
  }

  const type = Array.isArray(node.type) ? node.type[0] : node.type;
  switch (type) {
    case 'string':
      return typeof node.format === 'string' ? node.format : 'string';
    case 'integer':
    case 'number':
      return 0;
    case 'boolean':
      return true;
    case 'null':
      return null;
    case 'array':
      return [];
    case 'object':
    default: {
      const properties = node.properties;
      if (properties === null || typeof properties !== 'object') {
        return null;
      }
      const result: Record<string, unknown> = {};
      for (const [key, propSchema] of Object.entries(properties as Record<string, unknown>)) {
        const value = generateExample(propSchema, depth + 1);
        if (value !== null || isExplicitNull(propSchema)) {
          result[key] = value;
        }
      }
      return Object.keys(result).length > 0 ? result : null;
    }
  }
}

/** Whether a sub-schema legitimately produces a `null` example (vs. "unknown"). */
function isExplicitNull(schema: unknown): boolean {
  if (schema === null || typeof schema !== 'object') {
    return false;
  }
  const node = schema as Record<string, unknown>;
  const type = Array.isArray(node.type) ? node.type[0] : node.type;
  return type === 'null' || node.default === null || node.const === null;
}
