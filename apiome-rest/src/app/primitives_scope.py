"""Scope & visibility enforcement for the Primitives type registry (#3453).

The Primitives layer stores types from two scopes in one ``apiome.primitives`` table:

* **system-core** rows (``is_system = true``, namespaces under ``std/*``) are shared
  with every tenant and are read-only to tenants;
* **tenant** rows (``tenant_id``-owned, private) are visible only to their owner.

Two rules follow from that split, and both are enforced here so create / update /
import share exactly one implementation (mirroring how :mod:`app.schema_validation`
centralizes draft 2020-12 validation):

1. **Reference direction.** A system-core type must never ``$ref`` a tenant
   namespace (a shared type may not depend on a private one); the reverse —
   tenant→core — is allowed. See :func:`find_forbidden_refs`.
2. **Cross-tenant isolation.** A tenant type must never ``$ref`` a *different*
   tenant's namespace. (Read isolation is enforced in the DB layer; this closes
   the same gap at the reference layer.)

Everything here is pure and side-effect free. The read-scope half of #3453
(``reads = is_system ∪ current tenant``) lives in the DB layer
(:meth:`app.database.Database.get_primitives_for_tenant` /
:meth:`app.database.Database.get_primitive_by_id`).
"""

from __future__ import annotations

from typing import Any, Dict, Iterator, List, Optional
from urllib.parse import urljoin

from .schema_validation import REGISTRY_BASE_URL

__all__ = [
    "ScopeViolationError",
    "iter_refs",
    "iter_ref_locations",
    "registry_namespace_of_ref",
    "tenant_segment_of",
    "resolve_registry_uri",
    "is_core_namespace",
    "find_forbidden_refs",
    "enforce_ref_scope",
]


class ScopeViolationError(Exception):
    """Raised when a type's ``$ref`` set violates a registry scope rule (#3453).

    Attributes:
        message: A human-readable summary of the violation.
        violations: One entry per offending ``$ref``; each has ``$ref`` (the value
            as written), ``target`` (the resolved registry namespace path), and
            ``reason`` (``"core-to-tenant"`` or ``"cross-tenant"``). Never empty.
    """

    def __init__(self, message: str, violations: List[Dict[str, str]]):
        self.message = message
        self.violations = violations
        super().__init__(message)


def iter_refs(node: Any) -> Iterator[str]:
    """Yield every ``$ref`` *string* value anywhere within a JSON Schema document.

    Walks objects and arrays recursively. A ``$ref`` whose value is not a string
    (malformed) is ignored — meta-validation is the place that rejects those.

    Args:
        node: Any node of a parsed JSON Schema document (object, array, or scalar).

    Yields:
        Each ``$ref`` value found, in document order.
    """
    for ref, _path in iter_ref_locations(node):
        yield ref


def iter_ref_locations(
    node: Any, path: tuple = ()
) -> Iterator[tuple]:
    """Yield every ``$ref`` string with the document path it was found at.

    The path-aware form of :func:`iter_refs`: each result is a
    ``(ref, path)`` pair where ``path`` is the tuple of object keys and array
    indices walked to reach the ``$ref`` keyword's owning schema — ``()`` for a
    ``$ref`` at the document root, ``("properties", "amount")`` for one on the
    ``amount`` property. Callers turn that into a human-readable location (see
    :func:`app.primitives_routes.ref_location_label`, which labels a dependent's
    reference on the type-detail page).

    Args:
        node: Any node of a parsed JSON Schema document (object, array, or scalar).
        path: The path walked so far; callers start at the default root.

    Yields:
        ``(ref, path)`` for each ``$ref`` value found, in document order.
    """
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "$ref" and isinstance(value, str):
                yield value, path
            else:
                yield from iter_ref_locations(value, path + (key,))
    elif isinstance(node, list):
        for index, item in enumerate(node):
            yield from iter_ref_locations(item, path + (index,))


def resolve_registry_uri(ref: str, base_uri: Optional[str]) -> Optional[str]:
    """Resolve a ``$ref`` to its absolute registry URI, or ``None`` if it is not one.

    A same-document fragment (``#/$defs/X``) targets the type itself and is never a
    cross-type reference. A relative ``$ref`` is resolved against ``base_uri`` using
    ordinary URL semantics (so ``./`` and ``../`` walk the namespace tree). Only refs
    that land under :data:`app.schema_validation.REGISTRY_BASE_URL` are registry
    targets; anything else (``https://json-schema.org/...``, vendor URLs) is external.
    Any trailing fragment is dropped so a path-plus-anchor ref resolves by its path.

    This is the single URL-resolution primitive shared by namespace classification
    (#3453, :func:`registry_namespace_of_ref`) and reference resolution (#3456,
    :func:`app.primitives_resolver.build_ref_edges`).

    Args:
        ref: The ``$ref`` value as written in the document.
        base_uri: The base URI the owning type's relative refs resolve against.

    Returns:
        The absolute registry URI the ref targets (e.g.
        ``https://api.apiome.dev/types/std/v0/primitives/string``), or ``None``
        when the ref is a fragment or points outside the registry.
    """
    if not isinstance(ref, str) or not ref or ref.startswith("#"):
        return None
    absolute = urljoin(base_uri or "", ref)
    if not absolute.startswith(REGISTRY_BASE_URL):
        return None
    return absolute.split("#", 1)[0]


def registry_namespace_of_ref(ref: str, base_uri: Optional[str]) -> Optional[str]:
    """Resolve a ``$ref`` to its registry namespace path, or ``None`` if it is not one.

    A thin wrapper over :func:`resolve_registry_uri` that strips the registry root,
    leaving the namespace-plus-leaf path used for scope classification.

    Args:
        ref: The ``$ref`` value as written in the document.
        base_uri: The base URI the owning type's relative refs resolve against.

    Returns:
        The registry path the ref targets (e.g. ``tenant/acme/v1/types/money``),
        or ``None`` when the ref is a fragment or points outside the registry.
    """
    absolute = resolve_registry_uri(ref, base_uri)
    if absolute is None:
        return None
    return absolute[len(REGISTRY_BASE_URL):].strip("/")


def tenant_segment_of(path: Optional[str]) -> Optional[str]:
    """Return the ``tenant/<slug>`` owner segment of a registry path, if any.

    Tenant namespaces are rooted at ``tenant/<slug>/...``; that two-segment prefix
    identifies the owning tenant and is what cross-tenant comparisons key on.

    Args:
        path: A registry namespace path (e.g. ``tenant/acme/v1/types/money``).

    Returns:
        ``tenant/<slug>`` (e.g. ``tenant/acme``), or ``None`` when the path is not
        tenant-rooted (``std/*``, ``vendor/*``, …) or has no slug segment.
    """
    if not path:
        return None
    segments = path.strip("/").split("/")
    if len(segments) >= 2 and segments[0] == "tenant":
        return f"tenant/{segments[1]}"
    return None


def is_core_namespace(namespace: Optional[str]) -> bool:
    """Return whether a namespace path belongs to the system-core (``std/*``) scope.

    Args:
        namespace: A registry namespace path, or ``None``.

    Returns:
        True when the path is ``std`` or rooted at ``std/``.
    """
    if not namespace:
        return False
    norm = namespace.strip().strip("/")
    return norm == "std" or norm.startswith("std/")


def find_forbidden_refs(
    schema: Dict[str, Any],
    *,
    is_core: bool,
    base_uri: Optional[str],
    own_tenant_segment: Optional[str],
) -> List[Dict[str, str]]:
    """Return the ``$ref`` values in ``schema`` that violate a registry scope rule.

    Args:
        schema: The JSON Schema document being saved.
        is_core: Whether the owning type is system-core (shared, read-only). A core
            type may not reference any tenant namespace.
        base_uri: The base URI the document's relative refs resolve against.
        own_tenant_segment: The owning type's ``tenant/<slug>`` segment, or ``None``
            for a core type or when it cannot be derived. A tenant type may not
            reference a *different* tenant's namespace.

    Returns:
        One entry per offending ref (``$ref`` / ``target`` / ``reason``), in
        document order, de-duplicated by the ref value. Empty when all refs are
        allowed.
    """
    violations: List[Dict[str, str]] = []
    seen: set = set()
    for ref in iter_refs(schema):
        if ref in seen:
            continue
        target = registry_namespace_of_ref(ref, base_uri)
        target_tenant = tenant_segment_of(target)
        if target_tenant is None:
            # External, fragment, or a non-tenant (std/vendor) registry target — allowed.
            continue
        if is_core:
            seen.add(ref)
            violations.append({"$ref": ref, "target": target or "", "reason": "core-to-tenant"})
        elif own_tenant_segment is not None and target_tenant != own_tenant_segment:
            seen.add(ref)
            violations.append({"$ref": ref, "target": target or "", "reason": "cross-tenant"})
    return violations


def enforce_ref_scope(
    schema: Dict[str, Any],
    *,
    is_core: bool,
    base_uri: Optional[str],
    own_tenant_segment: Optional[str],
) -> None:
    """Enforce the registry reference-direction rules, raising on any violation.

    Args:
        schema: The JSON Schema document being saved.
        is_core: Whether the owning type is system-core (see :func:`find_forbidden_refs`).
        base_uri: The base URI relative refs resolve against.
        own_tenant_segment: The owning type's ``tenant/<slug>`` segment, or ``None``.

    Raises:
        ScopeViolationError: When one or more ``$ref`` values violate a scope rule;
            the exception carries the per-ref ``violations`` list.
    """
    violations = find_forbidden_refs(
        schema,
        is_core=is_core,
        base_uri=base_uri,
        own_tenant_segment=own_tenant_segment,
    )
    if not violations:
        return
    if any(v["reason"] == "core-to-tenant" for v in violations):
        message = "A system-core type may not $ref a tenant namespace"
    else:
        message = "A type may not $ref another tenant's namespace"
    raise ScopeViolationError(message, violations)
