"""Relative ``$ref`` resolution for the Primitives type registry (#3456).

A primitive's JSON Schema may reference other registry types by *relative* ``$ref``
rooted at the type's import-source ``base_uri`` — the defining mechanic of the registry:

    base   = https://api.apiome.dev/types/std/v0/types/   (source: date)
    $ref   = ../primitives/string
    target = https://api.apiome.dev/types/std/v0/primitives/string

This module turns each relative ``$ref`` in a schema into a persisted **edge** stored on
``apiome.primitives.refs`` (a JSONB array). Each edge is
``{"relative_ref", "resolved_target", "status"}`` where:

* ``relative_ref`` is the ``$ref`` exactly as written in the document;
* ``resolved_target`` is the absolute registry URI it resolves to (``base + relative``);
* ``status`` is ``"resolved"`` when a primitive with that ``$id`` exists within the
  source's read scope (system-core ∪ tenant, honoring #3453), else ``"unresolved"``.

Scope is honored by the injected ``target_exists`` lookup, which the route backs with a
tenant-scoped DB query — a tenant therefore resolves only to system-core or its own types,
never to another tenant's private types.

The URL resolution itself (``./``, ``../``, cross-scope ``../../std/...``, fragment and
external-ref handling) is delegated to :func:`app.primitives_scope.resolve_registry_uri`,
the single resolver shared with scope classification. Fragment (``#/...``) and external
(non-registry) refs are intentionally *not* recorded as registry edges.

**Resolution is local-only.** Every ``resolved_target`` this module emits is an absolute URI
under :data:`app.schema_validation.REGISTRY_BASE_URL` — a reference into *this* registry's
namespace tree. A ``$ref`` that resolves anywhere else (a vendor URL, a foreign schema host)
is not a registry reference and never becomes an edge, whatever ``$id`` the source document
declared for itself. Whether a target *exists* is equally a local question: the injected
``target_exists`` predicate is expected to dereference the local URI by **placement**
(namespace + leaf, see :mod:`app.primitives_lookup`), so a type imported with a foreign
author-declared ``$id`` is still found at the local address its namespace and name give it.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List

from .primitives_scope import iter_refs, resolve_registry_uri

__all__ = ["STATUS_RESOLVED", "STATUS_UNRESOLVED", "build_ref_edges"]

# Edge status values. ``circular`` (cycle detection) is a later ticket (#3458); this
# engine emits only resolved / unresolved.
STATUS_RESOLVED = "resolved"
STATUS_UNRESOLVED = "unresolved"


def build_ref_edges(
    schema: Dict[str, Any],
    *,
    base_uri: str,
    target_exists: Callable[[str], bool],
) -> List[Dict[str, str]]:
    """Resolve a schema's relative ``$ref`` values into persisted registry edges (#3456).

    Walks every ``$ref`` in ``schema``, resolves each relative reference against
    ``base_uri`` to an absolute **local** registry URI, and records an edge with its
    resolution status. Same-document fragment refs and external (non-registry) refs are
    skipped — only references into this registry's namespace tree become edges. Duplicate
    ``$ref`` values are recorded once, in first-seen document order.

    Args:
        schema: The (identity-stamped) JSON Schema document of the source primitive.
        base_uri: The source primitive's namespace base URI; relative refs resolve
            against it.
        target_exists: Predicate mapping an absolute local registry URI to whether a
            visible type sits at that placement. The routes back this with the
            tenant-scoped placement lookup (:mod:`app.primitives_lookup`) so scope
            (#3453) is honored and resolution never leaves the registry.

    Returns:
        The list of ``{"relative_ref", "resolved_target", "status"}`` edges, suitable
        for persisting to ``apiome.primitives.refs``. Empty when the schema has no
        cross-type registry references.
    """
    edges: List[Dict[str, str]] = []
    seen: set = set()
    for ref in iter_refs(schema):
        if ref in seen:
            continue
        target = resolve_registry_uri(ref, base_uri)
        if target is None:
            # Fragment (#/...) or external ref — not a registry edge.
            continue
        seen.add(ref)
        status = STATUS_RESOLVED if target_exists(target) else STATUS_UNRESOLVED
        edges.append(
            {"relative_ref": ref, "resolved_target": target, "status": status}
        )
    return edges
