/**
 * Pure model for the Namespaces & Scopes UI (#3471).
 *
 * Backs the namespaces table and the create/edit dialog under
 * Governance → Primitives → Namespaces. Everything here is side-effect free so the form
 * validation and request-building stay aligned with the Namespace CRUD API (#3451,
 * ``type_namespaces_routes.py``) and can be unit-tested without React.
 */

import type { TypeNamespaceCollection } from './primitivesRegistryTypes';

/**
 * Registry root every base URI hangs off. Mirrors ``REGISTRY_BASE_URL`` in
 * ``type_namespaces_routes.py`` so the client-side default matches what the API derives.
 */
export const REGISTRY_BASE_URL = 'https://api.apiome.app/types/';

/** The ``std/`` root is reserved for platform-curated system-core namespaces (read-only here). */
export const SYSTEM_NAMESPACE_ROOT = 'std';

/**
 * A namespace path is one or more lowercase, slash-separated segments (letters, digits, ``_``,
 * ``-``). Mirrors ``_NAMESPACE_RE`` in ``type_namespaces_routes.py`` — e.g. ``tenant/acme/v1/types``.
 */
export const NAMESPACE_PATH_RE = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/;

/** A version-root segment: a ``v`` followed by digits (``v0``, ``v1`` …). */
export const VERSION_SEGMENT_RE = /^v[0-9]+$/;

/** Editable fields of the namespace create/edit form. */
export interface NamespaceFormData {
  /** Slash-separated namespace path. Immutable once created (links the namespace to its types). */
  namespace: string;
  /** Explicit base URI; when blank the API derives one from the namespace path. */
  baseUri: string;
  /** Version-root segment (``v0``, ``v1`` …); when blank the API derives it from the path. */
  versionRoot: string;
  /** Optional human description. */
  description: string;
  /** Whether this is the tenant's default namespace for new types. */
  isDefault: boolean;
}

/** Field-keyed validation errors for the namespace form (empty object means valid). */
export type NamespaceFormErrors = Partial<Record<keyof NamespaceFormData, string>>;

/** An empty form for the "New namespace" flow. */
export function emptyNamespaceForm(): NamespaceFormData {
  return { namespace: '', baseUri: '', versionRoot: '', description: '', isDefault: false };
}

/** Build a form pre-populated from an existing namespace row (for the edit flow). */
export function formFromNamespace(ns: TypeNamespaceCollection): NamespaceFormData {
  return {
    namespace: ns.namespace,
    baseUri: ns.base_uri ?? '',
    versionRoot: ns.version_root ?? '',
    description: ns.description ?? '',
    isDefault: ns.is_default,
  };
}

/** Normalize a namespace path: trim surrounding whitespace and ``/`` (matches the API). */
export function normalizeNamespacePath(raw: string): string {
  return (raw || '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

/** Return the first ``vN`` segment of a namespace path, if any (e.g. ``std/v0/types`` → ``v0``). */
export function deriveVersionRoot(namespace: string): string | null {
  for (const segment of normalizeNamespacePath(namespace).split('/')) {
    if (VERSION_SEGMENT_RE.test(segment)) {
      return segment;
    }
  }
  return null;
}

/** The base URI the API would derive for a namespace path when none is supplied. */
export function defaultBaseUri(namespace: string): string {
  const path = normalizeNamespacePath(namespace);
  return path ? `${REGISTRY_BASE_URL}${path}/` : '';
}

/** True when a namespace path falls under the reserved system-core (``std/``) root. */
export function isSystemNamespacePath(namespace: string): boolean {
  const path = normalizeNamespacePath(namespace);
  return path === SYSTEM_NAMESPACE_ROOT || path.startsWith(`${SYSTEM_NAMESPACE_ROOT}/`);
}

/**
 * Validate the namespace form.
 *
 * @param form The current form values.
 * @param isEdit True when editing an existing namespace (the path is immutable, so it is not
 *   re-validated and the ``std/`` reservation check is skipped — system rows never reach edit here).
 * @returns A field-keyed error map; empty when the form is valid.
 */
export function validateNamespaceForm(
  form: NamespaceFormData,
  isEdit: boolean
): NamespaceFormErrors {
  const errors: NamespaceFormErrors = {};

  if (!isEdit) {
    const path = normalizeNamespacePath(form.namespace);
    if (!path) {
      errors.namespace = 'Namespace is required.';
    } else if (!NAMESPACE_PATH_RE.test(path)) {
      errors.namespace =
        "Use lowercase slash-separated segments of letters, digits, '_' or '-' (e.g. tenant/acme/v1/types).";
    } else if (isSystemNamespacePath(path)) {
      errors.namespace = "The 'std/' root is reserved for platform system-core namespaces.";
    }
  }

  const baseUri = form.baseUri.trim();
  if (baseUri && !/^https?:\/\/.+/i.test(baseUri)) {
    errors.baseUri = 'Base URI must be an absolute http(s) URL.';
  }

  const versionRoot = form.versionRoot.trim();
  if (versionRoot && !VERSION_SEGMENT_RE.test(versionRoot)) {
    errors.versionRoot = "Version root must be a 'v' followed by digits (e.g. v0, v1).";
  }

  return errors;
}

/** True when the form has no validation errors. */
export function isNamespaceFormValid(form: NamespaceFormData, isEdit: boolean): boolean {
  return Object.keys(validateNamespaceForm(form, isEdit)).length === 0;
}

/** Request body for ``POST /api/types/namespaces`` (tenant-scoped create). */
export interface NamespaceCreateBody {
  namespace: string;
  scope: 'tenant';
  base_uri?: string;
  version_root?: string;
  description?: string;
  is_default: boolean;
}

/** Request body for ``PUT /api/types/namespaces/{id}`` (only mutable fields). */
export interface NamespaceUpdateBody {
  base_uri?: string;
  version_root?: string;
  description: string | null;
  is_default: boolean;
}

/**
 * Build the create request body. Blank base URI / version root are omitted so the API derives
 * them from the namespace path; scope is always ``tenant`` (system namespaces are read-only here).
 */
export function buildCreateRequestBody(form: NamespaceFormData): NamespaceCreateBody {
  const body: NamespaceCreateBody = {
    namespace: normalizeNamespacePath(form.namespace),
    scope: 'tenant',
    is_default: form.isDefault,
  };

  const baseUri = form.baseUri.trim();
  if (baseUri) body.base_uri = baseUri;

  const versionRoot = form.versionRoot.trim();
  if (versionRoot) body.version_root = versionRoot;

  const description = form.description.trim();
  if (description) body.description = description;

  return body;
}

/**
 * Build the update request body. The namespace path is immutable, so it is never sent; a blank
 * base URI is omitted (the stored value stays), while description is sent as ``null`` when cleared.
 */
export function buildUpdateRequestBody(form: NamespaceFormData): NamespaceUpdateBody {
  const body: NamespaceUpdateBody = {
    description: form.description.trim() || null,
    is_default: form.isDefault,
  };

  const baseUri = form.baseUri.trim();
  if (baseUri) body.base_uri = baseUri;

  const versionRoot = form.versionRoot.trim();
  body.version_root = versionRoot || undefined;

  return body;
}

/** Human label for a namespace's visibility, used in the table's "Visibility" column. */
export function visibilityLabel(ns: TypeNamespaceCollection): string {
  if (ns.scope === 'system') return 'All tenants';
  return ns.is_public ? 'Public' : 'Tenant only';
}

/**
 * A namespace that types already sit in but that has no `apiome.type_namespaces` row.
 *
 * The registry stores a type's namespace as a plain string on the primitive
 * (``primitives_routes._create_imported_primitive``) while Type collections lists rows from
 * ``apiome.type_namespaces``, and only the Namespace CRUD API ever writes those rows. An import
 * into a namespace nobody created therefore lands types in a namespace the collections list
 * cannot show. These are those namespaces — detected from the types themselves.
 */
export interface DetectedNamespace {
  /** The namespace path found on the types. */
  namespace: string;
  /** How many of the tenant's types are in it. */
  typeCount: number;
}

/** The namespace field of a type, as far as these helpers care. */
interface NamespacedType {
  namespace?: string | null;
}

/** Whether a type carries no namespace at all (`null`, absent, or blank). */
export function isUnassignedNamespace(value: string | null | undefined): boolean {
  return (value ?? '').trim() === '';
}

/**
 * Count the types that belong to no namespace.
 *
 * Both `create_primitive` and the import path accept a null namespace, so these types exist but
 * can never appear under any namespace grouping.
 *
 * @param types - The tenant's types.
 * @returns How many have no namespace.
 */
export function countUnassignedTypes(types: NamespacedType[]): number {
  return types.filter((type) => isUnassignedNamespace(type.namespace)).length;
}

/**
 * Find the namespaces that types use but that are not registered as collections.
 *
 * @param types - The tenant's types (the namespace strings actually in use).
 * @param registered - The namespace rows Type collections lists.
 * @returns One entry per unregistered namespace, most-used first then alphabetical.
 */
export function detectUnregisteredNamespaces(
  types: NamespacedType[],
  registered: Array<{ namespace: string }>
): DetectedNamespace[] {
  const known = new Set(registered.map((row) => row.namespace));
  const counts = new Map<string, number>();

  for (const type of types) {
    const namespace = (type.namespace ?? '').trim();
    // A type with no namespace has nothing to register — it is counted as unassigned instead.
    if (!namespace || known.has(namespace)) continue;
    counts.set(namespace, (counts.get(namespace) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([namespace, typeCount]) => ({ namespace, typeCount }))
    .sort((a, b) => b.typeCount - a.typeCount || a.namespace.localeCompare(b.namespace));
}
