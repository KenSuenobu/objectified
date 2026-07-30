"""``$ref`` rewrite + core-format mapping for the Primitives import pipeline (#3463).

The parser (#3461) and bundle importer (#3462) detect each imported definition and
*capture* its intra-source ``$ref`` edges (``#/$defs/Money`` / ``#/definitions/Money`` /
``#/types/Money``) as ``internal`` edges, marked for this stage. They do **not** change
the refs themselves: an imported definition still points at its sibling by a *document*
pointer, which means nothing about its place in the registry once each definition becomes
its own ``apiome.primitives`` row in a target namespace.

This module closes that gap. Given an imported definition's schema and the base URI it is
committed under, it produces the schema actually persisted, with two rewrites applied:

* **Intra-source refs → relative registry refs.** Each sibling pointer is rewritten to a
  registry-relative ref at the sibling's committed ``$id`` — ``#/$defs/Money`` → ``./money``
  (``./<slug(name)>``, matching :func:`app.schema_validation.derive_schema_id`'s leaf), so a
  bundle of N definitions committed into one namespace cross-references by relative ref. A
  trailing JSON Pointer beyond the type name (``#/$defs/Money/properties/c``) is preserved as
  a fragment on the rewritten ref (``./money#/properties/c``).
* **Recognized formats → core types.** A string subschema carrying a recognized JSON Schema
  ``format`` (``email``, ``uuid``, ``uri``, ``date``, ``date-time``, ``time``) and no ``$ref``
  of its own is mapped to the seeded ``std/v0/types`` core type for that format by injecting a
  registry-relative ``$ref`` to it (mirroring the seed's ``{"$ref": "../primitives/string",
  "format": "email"}`` shape). This is the "map external known refs → core types where
  recognized" half of the ticket.

Both rewrites turn import-local structure into ordinary registry-relative ``$ref`` values, so
the **existing** resolver (#3456, :func:`app.primitives_resolver.build_ref_edges`) — run by the
commit path right after this — resolves them against the base URI into persisted
``{relative_ref, resolved_target, status}`` edges. No separate edge bookkeeping is needed: the
rewrite makes the refs first-class, and resolution is unchanged. This is the acceptance
criterion — imported refs are stored relative and resolve via Epic 3, and core-format mapping
works for recognized formats.

Everything here is pure and side-effect free (no network/DB): it rewrites a parsed schema and
reports what it changed, so it is unit-testable on a document and shared by every import path.
"""

from __future__ import annotations

import posixpath
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlsplit

from .primitives_parser import _unescape_pointer_token
from .schema_validation import REGISTRY_BASE_URL, _slug

__all__ = [
    "CORE_TYPES_NAMESPACE",
    "CORE_FORMAT_TO_TYPE",
    "core_type_uri",
    "registry_relative_ref",
    "rewrite_internal_ref",
    "rewrite_import_schema",
]

# Document pointer prefixes that name a sibling definition in an import source. ``$defs`` is
# the draft 2020-12 keyword, ``definitions`` the pre-2020 equivalent, and ``types`` the
# Apiome bundle container (#3462). A ``$ref`` under any of these targets a sibling that
# becomes its own primitive, so it is rewritten to that sibling's relative registry ref.
_INTERNAL_PREFIXES: Tuple[str, ...] = ("#/$defs/", "#/definitions/", "#/types/")

# Namespace the seeded core ``std/v0`` derived types live under (#3449). A recognized
# ``format`` maps to ``<this>/<leaf>`` — e.g. ``email`` → ``std/v0/types/email``.
CORE_TYPES_NAMESPACE = "std/v0/types"

# JSON Schema ``format`` value → core ``std/v0/types`` leaf name. Limited to the formats that
# have a seeded core type so a mapped ref resolves; ``decimal`` / ``currency-code`` / ``money``
# are core types too but are not expressed as ``format`` keywords, so they are not mapped here.
CORE_FORMAT_TO_TYPE: Dict[str, str] = {
    "email": "email",
    "uuid": "uuid",
    "uri": "uri",
    "date": "date",
    "date-time": "date-time",
    "time": "time",
}


def core_type_uri(leaf: str) -> str:
    """Return the absolute registry ``$id`` of a seeded core ``std/v0/types`` type.

    Args:
        leaf: The core type's leaf name (e.g. ``email``).

    Returns:
        The absolute registry URI (e.g.
        ``https://api.apiome.dev/types/std/v0/types/email``).
    """
    return f"{REGISTRY_BASE_URL}{CORE_TYPES_NAMESPACE}/{leaf}"


def registry_relative_ref(base_uri: str, target_uri: str) -> str:
    """Compute a registry-relative ``$ref`` from a base URI to an absolute registry target.

    Resolution is the inverse of :func:`app.primitives_scope.resolve_registry_uri`: the
    returned ref, ``urljoin``-ed against ``base_uri``, yields ``target_uri`` again. A target
    in the same namespace as the base resolves to ``./<leaf>``; one in another namespace walks
    up with ``../`` segments (``../../std/v0/types/email``). When the two URIs do not share the
    registry root (so no relative path is meaningful), the absolute ``target_uri`` is returned
    unchanged — it still resolves, just not relatively.

    Args:
        base_uri: The base URI the owning type's relative refs resolve against (the type's
            namespace; conventionally ends in a slash).
        target_uri: The absolute registry URI to reference.

    Returns:
        A ``$ref`` value that resolves to ``target_uri`` against ``base_uri``.
    """
    base_path = urlsplit(base_uri).path
    target_path = urlsplit(target_uri).path
    if not base_path or not target_path:
        return target_uri
    # relpath needs a *directory* to resolve against; a base URI names the namespace dir, so
    # drop a trailing slash to use it as the start directory (./ and ../ then walk from there).
    start_dir = base_path.rstrip("/")
    rel = posixpath.relpath(target_path, start_dir)
    # Same-namespace targets come back bare (``email``); mark them as explicitly relative so the
    # ref reads as a sibling reference and never as a network-path or scheme-relative URI.
    if not rel.startswith("."):
        rel = f"./{rel}"
    return rel


def rewrite_internal_ref(ref: str) -> Optional[str]:
    """Rewrite an intra-source document pointer into a relative registry ref, or ``None``.

    A ``$ref`` at a sibling definition (``#/$defs/Money``, ``#/definitions/Money``,
    ``#/types/Money``) is rewritten to ``./<slug(name)>`` — the sibling's committed ``$id``
    leaf, matching :func:`app.schema_validation.derive_schema_id`. Any JSON Pointer beyond the
    type name is preserved as a fragment (``#/$defs/Money/properties/c`` → ``./money#/properties/c``).
    A ref that is not an intra-source pointer (a registry-relative ref, an absolute URL, a bare
    ``#`` root, or a pointer elsewhere in the document) is left for the resolver and yields ``None``.

    Args:
        ref: The ``$ref`` value exactly as written in the source document.

    Returns:
        The rewritten relative registry ref, or ``None`` when ``ref`` is not an intra-source
        sibling pointer.
    """
    if not isinstance(ref, str):
        return None
    for prefix in _INTERNAL_PREFIXES:
        if ref.startswith(prefix):
            rest = ref[len(prefix):]
            name, _, sub = rest.partition("/")
            if not name:
                return None
            rewritten = f"./{_slug(_unescape_pointer_token(name))}"
            if sub:
                # Preserve a deeper pointer into the sibling as a fragment on the new ref.
                rewritten = f"{rewritten}#/{sub}"
            return rewritten
    return None


def _core_format_ref(node: Dict[str, Any], base_uri: str) -> Optional[str]:
    """Return the relative core-type ``$ref`` a format-bearing subschema maps to, or ``None``.

    A subschema is mapped when it carries a recognized string ``format`` (see
    :data:`CORE_FORMAT_TO_TYPE`) and does not already declare a ``$ref`` of its own (an explicit
    ref is the author's and is never overridden).

    Args:
        node: The (already ref-rewritten) subschema object.
        base_uri: The base URI the owning type's refs resolve against.

    Returns:
        A registry-relative ``$ref`` to the core type for the node's format, or ``None`` when
        the node has no recognized format or already carries a ``$ref``.
    """
    if "$ref" in node:
        return None
    fmt = node.get("format")
    if not isinstance(fmt, str):
        return None
    leaf = CORE_FORMAT_TO_TYPE.get(fmt)
    if leaf is None:
        return None
    return registry_relative_ref(base_uri, core_type_uri(leaf))


def _rewrite_node(
    node: Any, base_uri: str, map_core_formats: bool, rewrites: List[Dict[str, str]]
) -> Any:
    """Recursively rewrite one schema node, recording each change in ``rewrites``.

    Args:
        node: The schema node (object, array, or scalar).
        base_uri: The base URI relative refs resolve against (for core-format mapping).
        map_core_formats: Whether to map recognized formats to core types.
        rewrites: The change log, appended to in place; each entry is
            ``{"from", "to", "kind"}`` with ``kind`` ``"internal"`` or ``"core-format"``.

    Returns:
        A new node with rewrites applied; the input is not mutated.
    """
    if isinstance(node, dict):
        new_node: Dict[str, Any] = {}
        for key, value in node.items():
            if key == "$ref" and isinstance(value, str):
                rewritten = rewrite_internal_ref(value)
                if rewritten is not None:
                    rewrites.append({"from": value, "to": rewritten, "kind": "internal"})
                    new_node[key] = rewritten
                else:
                    new_node[key] = value
            else:
                new_node[key] = _rewrite_node(value, base_uri, map_core_formats, rewrites)
        if map_core_formats:
            core_ref = _core_format_ref(new_node, base_uri)
            if core_ref is not None:
                rewrites.append(
                    {"from": new_node["format"], "to": core_ref, "kind": "core-format"}
                )
                new_node["$ref"] = core_ref
        return new_node
    if isinstance(node, list):
        return [_rewrite_node(item, base_uri, map_core_formats, rewrites) for item in node]
    return node


def rewrite_import_schema(
    schema: Any, *, base_uri: str, map_core_formats: bool = True
) -> Tuple[Any, List[Dict[str, str]]]:
    """Rewrite an imported definition's schema for its place in the registry (#3463).

    Applies both rewrites described in the module docstring — intra-source pointers to relative
    registry refs, and (when ``map_core_formats``) recognized formats to core ``std/v0/types``
    refs — returning the schema to persist plus a change log. The returned refs are ordinary
    registry-relative ``$ref`` values, so the commit path's existing resolver (#3456) turns them
    into persisted ``refs`` edges with no further bookkeeping.

    Args:
        schema: The parsed schema fragment of one imported definition.
        base_uri: The base URI the committed primitive's refs resolve against (its namespace).
        map_core_formats: Whether to map recognized formats to core types (default ``True``).

    Returns:
        ``(rewritten_schema, rewrites)`` — a new schema with rewrites applied (the input is not
        mutated) and the list of ``{"from", "to", "kind"}`` changes, in document order.
    """
    rewrites: List[Dict[str, str]] = []
    rewritten = _rewrite_node(schema, base_uri, map_core_formats, rewrites)
    return rewritten, rewrites
