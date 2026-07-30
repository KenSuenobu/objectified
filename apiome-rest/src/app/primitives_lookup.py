"""Local-only ``$ref`` target lookup for the Primitives type registry.

Every type in the registry is a **local** type: whatever ``$id`` an imported document
declared for itself, the type *lives* at a namespace + name in this registry, and that
placement is the only address references resolve through. A ``$ref`` therefore resolves in
two steps, both local:

1. the ref is resolved against the owning type's namespace base URI into an absolute URI
   under :data:`app.schema_validation.REGISTRY_BASE_URL` (anything else is not a registry
   reference and never becomes an edge);
2. that URI is dereferenced **by placement** — its path names ``<namespace>/<leaf>``, and
   the type answering to that placement is the target, regardless of what foreign ``$id``
   its ``schema_id`` column happens to carry.

The ``schema_id`` column is still consulted first: for types created locally (and the
seeded ``std/v0`` core set) the derived ``$id`` *is* the local URI, so that hit is exact
and cheap. The placement lookup is what keeps resolution local when a document was
imported with an author-declared remote ``$id`` — the reference resolves to the local
type; the remote URI is never fetched, stored, or matched against.

This is deliberately the same model the import wizard's client-side preview uses
(``primitiveRefResolution.ts`` matches by registry path), so the preview, the review, the
commit, the re-resolve pass, and the type-detail page all answer "where does this ref
point?" identically.

Functions take the ``db`` handle as an argument rather than importing it, so each route
module passes its own (test-patchable) reference.
"""

from __future__ import annotations

from typing import Any, Dict, Optional, Tuple

from .schema_validation import REGISTRY_BASE_URL

__all__ = ["registry_placement_of", "find_primitive_by_registry_uri", "local_registry_uri"]


def registry_placement_of(uri: str) -> Optional[Tuple[str, str]]:
    """Split a local registry URI into its ``(namespace, leaf)`` placement.

    Args:
        uri: An absolute URI (a ref's resolved target).

    Returns:
        ``(namespace, leaf)`` when ``uri`` is under :data:`REGISTRY_BASE_URL` and carries
        both a namespace path and a leaf, else ``None`` (a foreign URI, the registry root,
        or a root-level leaf with no namespace to place it in).
    """
    if not isinstance(uri, str) or not uri.startswith(REGISTRY_BASE_URL):
        return None
    path = uri[len(REGISTRY_BASE_URL):].split("#", 1)[0].strip("/")
    if not path or "/" not in path:
        return None
    namespace, leaf = path.rsplit("/", 1)
    return (namespace, leaf) if namespace and leaf else None


def find_primitive_by_registry_uri(
    db: Any, uri: str, tenant_id: str
) -> Optional[Dict[str, Any]]:
    """Dereference a resolved registry URI to the local type it names, or ``None``.

    The exact ``schema_id`` match is tried first (locally-created and seeded types store
    the local URI as their ``$id``); otherwise the URI's placement — namespace + leaf —
    finds the type, which is what makes resolution independent of any foreign ``$id`` an
    imported document declared. Both lookups are tenant-scoped (system-core ∪ own).

    Args:
        db: The database handle of the calling route module.
        uri: The absolute registry URI a ref resolved to.
        tenant_id: The caller's tenant id.

    Returns:
        The matching primitive row, or ``None`` when no visible type answers.
    """
    row = db.get_primitive_by_schema_id(uri, tenant_id)
    if row is not None:
        return row
    placement = registry_placement_of(uri)
    if placement is None:
        return None
    namespace, leaf = placement
    return db.get_primitive_by_namespace_name(namespace, leaf, tenant_id)


def local_registry_uri(base_uri: str, leaf: str) -> str:
    """The local registry URI for a placement — ``base_uri`` joined with ``leaf``.

    Args:
        base_uri: A namespace base URI (trailing slash optional).
        leaf: The placement leaf (a slug).

    Returns:
        The absolute local URI.
    """
    return f"{(base_uri or '').rstrip('/')}/{leaf}"
