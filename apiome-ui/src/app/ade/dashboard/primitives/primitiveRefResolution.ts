/**
 * `$ref` resolution and repair for the Primitives import wizard.
 *
 * A document exported from one namespace and imported into another carries relative refs written
 * against *its* old base — most often with the wrong number of `../` steps. The API resolves a ref
 * with ordinary URL semantics (``primitives_scope.resolve_registry_uri``: `urljoin`, then the result
 * must sit under the registry root), and a ref that walks up too far lands outside the registry
 * entirely. Such a ref is not recorded as a broken edge — it is not recorded *at all*, because it no
 * longer looks like a registry reference:
 *
 * ```
 * base https://api.apiome.dev/types/tenant/acme/v1/types/
 *   ../../../../std/v0/types/uri   → …/types/std/v0/types/uri   ✓ a registry edge
 *   ../../../../../std/v0/types/uri → …/std/v0/types/uri         ✗ outside the registry, dropped
 * ```
 *
 * This module closes that gap before the document is sent. Each ref is resolved as written; when
 * that fails, the ref's *path* (its `../` prefix stripped) is matched against the types the import
 * can see — the tenant's registry plus the document's own definitions — and a match rewrites the ref
 * to the canonical relative form for the target namespace. That is the "check the levels higher than
 * the current namespace" rule: the depth is treated as advisory, the path as the intent.
 *
 * Repair is never silent — every ref comes back with its status, and refs that match nothing are
 * reported so the reader is told the reference was attempted and could not be satisfied.
 *
 * Everything here is pure (no network, no DOM) so the resolution table unit-tests directly.
 */

/** The registry root every resolvable `$ref` must land under (mirrors `REGISTRY_BASE_URL`). */
export const REGISTRY_BASE_URL = 'https://api.apiome.dev/types/';

/** A type the import can resolve a `$ref` against. */
export interface KnownTarget {
  /** Registry path, no leading slash — e.g. `std/v0/types/uri`. */
  path: string;
  /** Whether it already exists in the registry, or arrives with this import. */
  origin: 'registry' | 'import';
}

/** What became of one `$ref`. */
export type RefStatus =
  /** Resolves as written, and the target is known. */
  | 'resolved'
  /** Did not resolve as written; matched by path and rewritten to the canonical ref. */
  | 'repaired'
  /** Looks like a registry reference, but nothing known matches it. */
  | 'unresolved'
  /** An absolute URL outside the registry (`https://json-schema.org/...`) — left alone. */
  | 'external';

/** The verdict for one `$ref` occurrence. */
export interface RefResolution {
  /** The definition the ref was found in. */
  typeName: string;
  /** The `$ref` exactly as written in the document. */
  ref: string;
  status: RefStatus;
  /** The registry path the ref was matched to, when it was matched. */
  target?: string;
  /** Whether the matched target exists already or arrives with this import. */
  origin?: 'registry' | 'import';
  /** The replacement `$ref` value, set only when `status` is `repaired`. */
  rewrittenTo?: string;
  /**
   * Why nothing could be matched, set only when `status` is `unresolved`.
   *
   * The per-edge diagnosis — "no type of that name" versus "not a registry reference at all". The
   * import panel does not render it per row: every unresolved row in a given document tends to
   * carry the same sentence, so the panel states the consequence once under the list instead. Kept
   * on the model because the distinction is real and a caller that wants to explain one specific
   * edge (a tooltip, a detail view) has nowhere else to get it.
   */
  reason?: string;
}

/** Lowercase, hyphen-separated leaf, mirroring `schema_validation._slug`. */
export function slugifyTypeName(name: string): string {
  const slug = (name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'type';
}

/** The base URI relative refs resolve against for a namespace (`null` when unknown). */
export function baseUriForNamespace(namespace: string | null | undefined): string | null {
  const trimmed = (namespace ?? '').trim().replace(/^\/+|\/+$/g, '');
  return trimmed ? `${REGISTRY_BASE_URL}${trimmed}/` : null;
}

/** The registry path of an absolute URI, or `null` when it is not under the registry root. */
export function registryPathOf(absoluteUri: string): string | null {
  if (!absoluteUri.startsWith(REGISTRY_BASE_URL)) return null;
  const path = absoluteUri.slice(REGISTRY_BASE_URL.length).split('#')[0];
  return path.replace(/^\/+|\/+$/g, '') || null;
}

/**
 * The path a ref *names*, with its `./` and `../` prefix discarded.
 *
 * This is what makes an over-walking ref recoverable: `../../../../../std/v0/types/uri` and
 * `../../../../std/v0/types/uri` both name `std/v0/types/uri`, and only the depth differs.
 */
export function refTailPath(ref: string): string | null {
  const withoutFragment = ref.split('#')[0];
  if (!withoutFragment) return null;

  // An absolute registry URI already states its path.
  const asRegistryPath = registryPathOf(withoutFragment);
  if (asRegistryPath) return asRegistryPath;

  const segments = withoutFragment
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
  return segments.length > 0 ? segments.join('/') : null;
}

/** Whether a ref is an absolute URL (has a scheme) rather than a relative path. */
function isAbsoluteUrl(ref: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(ref);
}

/**
 * Build the canonical `$ref` from a namespace to a registry path.
 *
 * Mirrors ``primitives_rewrite.registry_relative_ref``: a target in the same namespace becomes
 * `./<leaf>`, one elsewhere walks up with `../` steps. With no namespace to anchor to, the absolute
 * registry URI is returned — it still resolves, just not relatively.
 *
 * @param namespace - The namespace the importing type will live in.
 * @param targetPath - The registry path being referenced (e.g. `std/v0/types/uri`).
 * @returns A `$ref` value that resolves to `targetPath` from `namespace`.
 */
export function canonicalRef(namespace: string | null | undefined, targetPath: string): string {
  const base = (namespace ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!base) {
    return `${REGISTRY_BASE_URL}${targetPath}`;
  }

  const baseSegments = base.split('/').filter(Boolean);
  const targetSegments = targetPath.split('/').filter(Boolean);

  let common = 0;
  while (
    common < baseSegments.length &&
    common < targetSegments.length - 1 &&
    baseSegments[common] === targetSegments[common]
  ) {
    common += 1;
  }

  const up = baseSegments.length - common;
  const down = targetSegments.slice(common).join('/');
  return up === 0 ? `./${down}` : `${'../'.repeat(up)}${down}`;
}

/** Walk every `$ref` string in a schema, in document order. */
export function collectRefs(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const entry of node) collectRefs(entry, found);
    return found;
  }
  if (node === null || typeof node !== 'object') return found;

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === '$ref' && typeof value === 'string') {
      found.push(value);
    } else {
      collectRefs(value, found);
    }
  }
  return found;
}

/**
 * Assemble the targets an import can resolve against.
 *
 * @param registryTypes - The tenant's existing types (`schema_id` preferred, else namespace + name).
 * @param importedNames - The definition names arriving with this import.
 * @param targetNamespace - The namespace the import lands in; imported siblings hang off it.
 * @returns Deduped targets, registry entries first.
 */
export function buildKnownTargets(
  registryTypes: Array<{ schema_id?: string | null; namespace?: string | null; name?: string | null }>,
  importedNames: string[],
  targetNamespace: string | null | undefined
): KnownTarget[] {
  const byPath = new Map<string, KnownTarget>();

  for (const type of registryTypes) {
    const fromId = type.schema_id ? registryPathOf(type.schema_id) : null;
    const namespace = (type.namespace ?? '').trim().replace(/^\/+|\/+$/g, '');
    const fallback = namespace && type.name ? `${namespace}/${slugifyTypeName(type.name)}` : null;
    const path = fromId ?? fallback;
    if (path && !byPath.has(path)) {
      byPath.set(path, { path, origin: 'registry' });
    }
  }

  const namespace = (targetNamespace ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (namespace) {
    for (const name of importedNames) {
      const path = `${namespace}/${slugifyTypeName(name)}`;
      if (!byPath.has(path)) {
        byPath.set(path, { path, origin: 'import' });
      }
    }
  }

  return [...byPath.values()];
}

/**
 * Resolve every `$ref` in the detected definitions, repairing what can be repaired.
 *
 * Same-document fragment refs (`#/$defs/Money`) are skipped: they name a sibling by document
 * pointer and the API rewrites them itself (``primitives_rewrite.rewrite_import_schema``).
 *
 * @param definitions - The `name -> schema` map from `extractDefinitions`.
 * @param options - The target namespace the import lands in, and the targets it can resolve against.
 * @returns One entry per distinct ref per definition, in document order.
 */
export function resolveImportRefs(
  definitions: Record<string, Record<string, unknown>>,
  options: { targetNamespace: string | null | undefined; knownTargets: KnownTarget[] }
): RefResolution[] {
  const { targetNamespace, knownTargets } = options;
  const baseUri = baseUriForNamespace(targetNamespace);
  const targetsByPath = new Map(knownTargets.map((target) => [target.path, target]));

  const resolutions: RefResolution[] = [];

  for (const [typeName, schema] of Object.entries(definitions)) {
    const seen = new Set<string>();

    for (const ref of collectRefs(schema)) {
      if (seen.has(ref)) continue;
      seen.add(ref);

      // A document pointer targets a sibling in this same source; the API rewrites those.
      if (!ref || ref.startsWith('#')) continue;

      const fragment = ref.includes('#') ? ref.slice(ref.indexOf('#')) : '';

      // 1. Resolve as written, exactly as the API would.
      if (baseUri) {
        try {
          const asWritten = registryPathOf(new URL(ref, baseUri).toString());
          if (asWritten && targetsByPath.has(asWritten)) {
            const target = targetsByPath.get(asWritten) as KnownTarget;
            resolutions.push({ typeName, ref, status: 'resolved', target: target.path, origin: target.origin });
            continue;
          }
        } catch {
          // Not a resolvable URL reference — fall through to path matching.
        }
      }

      // 2. Match on the path the ref names, ignoring how far it tried to walk.
      const tail = refTailPath(ref);
      const matched = tail ? targetsByPath.get(tail) : undefined;
      if (matched) {
        const rewritten = `${canonicalRef(targetNamespace, matched.path)}${fragment}`;
        resolutions.push({
          typeName,
          ref,
          // A ref that already reads exactly as the canonical form needs no repair — that only
          // happens when the target is known but the base was not, so call it resolved.
          status: rewritten === ref ? 'resolved' : 'repaired',
          target: matched.path,
          origin: matched.origin,
          ...(rewritten === ref ? {} : { rewrittenTo: rewritten }),
        });
        continue;
      }

      // 3. An absolute URL somewhere else entirely is a deliberate external reference.
      if (isAbsoluteUrl(ref) && !ref.startsWith(REGISTRY_BASE_URL)) {
        resolutions.push({ typeName, ref, status: 'external' });
        continue;
      }

      resolutions.push({
        typeName,
        ref,
        status: 'unresolved',
        reason: tail
          ? `No type matching "${tail}" currently exists in the registry or in this import.`
          : 'The reference does not name a registry type.',
      });
    }
  }

  return resolutions;
}

/** The rewrite map (`original $ref` → `replacement`) implied by a resolution table. */
export function refRewriteMap(resolutions: RefResolution[]): Map<string, string> {
  const rewrites = new Map<string, string>();
  for (const resolution of resolutions) {
    if (resolution.status === 'repaired' && resolution.rewrittenTo) {
      rewrites.set(resolution.ref, resolution.rewrittenTo);
    }
  }
  return rewrites;
}

/**
 * Return a copy of a document with every repaired `$ref` replaced.
 *
 * The input is never mutated — the wizard keeps the parsed source as the reader supplied it and
 * sends the rewritten copy, so re-running detection always starts from the original document.
 *
 * @param node - The document (or sub-schema) to rewrite.
 * @param rewrites - The map from {@link refRewriteMap}.
 * @returns A deep copy with the rewrites applied; the same value when there is nothing to do.
 */
export function applyRefRewrites<T>(node: T, rewrites: Map<string, string>): T {
  if (rewrites.size === 0) return node;

  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value === null || typeof value !== 'object') return value;

    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === '$ref' && typeof child === 'string' && rewrites.has(child)) {
        output[key] = rewrites.get(child) as string;
      } else {
        output[key] = walk(child);
      }
    }
    return output;
  };

  return walk(node) as T;
}

/** Counts for the import wizard's `$ref` summary line. */
export interface RefResolutionSummary {
  /** Refs that resolve, whether they needed repair or not. */
  resolved: number;
  /** Refs rewritten to make them resolve. */
  repaired: number;
  /** Refs that match nothing known. */
  unresolved: number;
  /** Absolute references outside the registry, left untouched. */
  external: number;
}

/** Summarize a resolution table for display. */
export function summarizeRefResolutions(resolutions: RefResolution[]): RefResolutionSummary {
  const summary: RefResolutionSummary = { resolved: 0, repaired: 0, unresolved: 0, external: 0 };
  for (const resolution of resolutions) {
    if (resolution.status === 'resolved') summary.resolved += 1;
    else if (resolution.status === 'repaired') {
      summary.resolved += 1;
      summary.repaired += 1;
    } else if (resolution.status === 'unresolved') summary.unresolved += 1;
    else summary.external += 1;
  }
  return summary;
}
