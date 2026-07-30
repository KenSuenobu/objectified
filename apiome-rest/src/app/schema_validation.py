"""
JSON Schema draft 2020-12 validation and identity derivation for primitives (#3452).

The Primitives CRUD layer stores arbitrary JSON Schema documents in
``apiome.primitives.schema``. Before this module those documents were only validated
client-side (AJV in the UI editor); the REST service persisted whatever it was
given. This module makes the REST service the authority:

* :func:`validate_schema_document` checks that a document is itself a *valid*
  JSON Schema under the draft 2020-12 dialect (it validates the document against
  the 2020-12 **meta-schema**), returning structured, field-level errors.
* :func:`derive_schema_id` computes the stable JSON Schema ``$id`` for a
  primitive (the ``schema_id`` column on ``apiome.primitives``) from a namespace
  base URI and the primitive name, honoring an author-declared ``$id``.
* :func:`derive_draft` reads the dialect (``draft``) from the document's
  ``$schema`` URI, defaulting to ``2020-12``.
* :func:`stamp_identity` returns a copy of the document with its ``$id`` /
  ``$schema`` filled in so the persisted JSON Schema is self-describing.

Everything here is pure and side-effect free so the create, update, and import
paths can share exactly one validator (an acceptance criterion of #3452).
"""

from __future__ import annotations

import re
from typing import Any, Dict, List

from jsonschema.validators import Draft202012Validator

# The dialect this service validates against, in both its short and URI forms.
DRAFT_2020_12 = "2020-12"
DRAFT_2020_12_META_URI = "https://json-schema.org/draft/2020-12/schema"

# Registry root every derived ``$id`` / namespace base URI hangs off. Matches the
# seeded ``std/v0`` primitives (#3449) and ``type_namespaces_routes.REGISTRY_BASE_URL``.
REGISTRY_BASE_URL = "https://api.apiome.dev/types/"

# Extracts the draft token from a ``$schema`` URI, e.g.
# ``.../draft/2020-12/schema`` -> ``2020-12`` and ``.../draft-07/schema`` -> ``07``.
_DRAFT_URI_RE = re.compile(r"draft[/-](?P<draft>\d{4}-\d{2}|\d+)")

# Collapses any run of non-url-safe characters into a single hyphen for the
# ``$id`` leaf segment (e.g. "Email Address" -> "email-address").
_SLUG_NONWORD_RE = re.compile(r"[^a-z0-9]+")

# One shared meta-schema validator. Constructing the draft 2020-12 validator with
# its own ``META_SCHEMA`` as the schema makes ``iter_errors(document)`` report every
# way ``document`` fails to be a valid 2020-12 schema. Reused across all calls so the
# meta-schema and its vocabulary registry are resolved exactly once.
_META_VALIDATOR = Draft202012Validator(Draft202012Validator.META_SCHEMA)


class SchemaValidationError(Exception):
    """Raised when a JSON Schema document fails draft 2020-12 meta-validation.

    Attributes:
        errors: Structured, field-level errors as returned by
            :func:`validate_schema_document` (never empty for this exception).
    """

    def __init__(self, errors: List[Dict[str, str]]):
        self.errors = errors
        super().__init__(
            f"Schema failed JSON Schema draft 2020-12 validation "
            f"({len(errors)} error(s))"
        )


def validate_schema_document(schema: Any) -> List[Dict[str, str]]:
    """Validate a JSON Schema document against the draft 2020-12 meta-schema.

    This answers "is ``schema`` a valid JSON Schema?" — not "does some instance
    satisfy ``schema``?". A malformed schema (an unknown ``type``, a negative
    ``maxLength``, a non-array ``required``, …) is reported here.

    Args:
        schema: The candidate JSON Schema document (typically a ``dict``).

    Returns:
        A list of structured errors, deduplicated and ordered by location. Each
        entry has:
            * ``path``: a slash-joined location within the document of the
              offending keyword (``"(root)"`` for the top level);
            * ``message``: the human-readable validator message;
            * ``keyword``: the JSON Schema keyword that failed (e.g. ``type``).
        The list is empty when the document is a valid 2020-12 schema.
    """
    errors: List[Dict[str, str]] = []
    seen: set = set()
    for error in sorted(
        _META_VALIDATOR.iter_errors(schema),
        key=lambda e: list(map(str, e.absolute_path)),
    ):
        path = "/".join(str(part) for part in error.absolute_path)
        # The 2020-12 meta-schema is a union of vocabulary subschemas, so a single
        # structural fault can surface from several branches with the same message;
        # collapse those to one field-level error per (location, message).
        dedupe_key = (path, error.message)
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        errors.append(
            {
                "path": path or "(root)",
                "message": error.message,
                "keyword": str(error.validator),
            }
        )
    return errors


def assert_valid_schema_document(schema: Any) -> None:
    """Validate ``schema`` and raise :class:`SchemaValidationError` if it is invalid.

    Args:
        schema: The candidate JSON Schema document.

    Raises:
        SchemaValidationError: If the document is not a valid draft 2020-12 schema;
            the exception carries the field-level error list.
    """
    errors = validate_schema_document(schema)
    if errors:
        raise SchemaValidationError(errors)


def derive_draft(schema: Dict[str, Any]) -> str:
    """Derive the JSON Schema dialect (``draft``) for a document.

    Args:
        schema: The JSON Schema document; its ``$schema`` URI, when present and
            recognizable, names the dialect.

    Returns:
        The draft token (e.g. ``"2020-12"``), defaulting to :data:`DRAFT_2020_12`
        when ``$schema`` is absent or unrecognized.
    """
    declared = schema.get("$schema") if isinstance(schema, dict) else None
    if isinstance(declared, str):
        match = _DRAFT_URI_RE.search(declared)
        if match:
            return match.group("draft")
    return DRAFT_2020_12


def _slug(name: str) -> str:
    """Return a lowercase, hyphen-separated, url-safe leaf for an ``$id``."""
    slug = _SLUG_NONWORD_RE.sub("-", (name or "").strip().lower()).strip("-")
    return slug or "type"


def derive_schema_id(schema: Dict[str, Any], *, name: str, base_uri: str) -> str:
    """Derive the stable JSON Schema ``$id`` (the ``schema_id`` column) for a primitive.

    An author-declared, non-empty ``$id`` on the document wins — identity is the
    author's to assert and the seeded ``std/v0`` types rely on it. Otherwise the id
    is the namespace ``base_uri`` joined with a url-safe slug of ``name``, which is
    deterministic: the same name in the same namespace always yields the same id.

    Args:
        schema: The JSON Schema document (may carry an explicit ``$id``).
        name: The primitive's name, used for the derived leaf segment.
        base_uri: The namespace base URI the id hangs off (trailing slash optional).

    Returns:
        The resolved ``$id`` string.
    """
    declared = schema.get("$id") if isinstance(schema, dict) else None
    if isinstance(declared, str) and declared.strip():
        return declared.strip()
    base = (base_uri or "").strip().rstrip("/")
    return f"{base}/{_slug(name)}"


def derive_base_uri(namespace: str | None, base_uri: str | None, tenant_slug: str) -> str:
    """Resolve the namespace base URI a primitive's ``$id`` is computed against.

    Precedence: an explicit ``base_uri`` wins; else a ``namespace`` path is rooted
    under :data:`REGISTRY_BASE_URL`; else a stable tenant-default base is used so a
    primitive created without registry placement still gets a deterministic id.

    Args:
        namespace: Optional registry namespace path (e.g. ``tenant/acme/v1/types``).
        base_uri: Optional explicit base URI (wins when provided).
        tenant_slug: The tenant slug, used for the default base.

    Returns:
        A base URI ending in a single trailing slash.
    """
    if base_uri and base_uri.strip():
        resolved = base_uri.strip()
    elif namespace and namespace.strip():
        resolved = f"{REGISTRY_BASE_URL}{namespace.strip().strip('/')}/"
    else:
        resolved = f"{REGISTRY_BASE_URL}tenant/{tenant_slug.strip().strip('/')}/"
    return resolved if resolved.endswith("/") else resolved + "/"


def stamp_identity(schema: Dict[str, Any], *, schema_id: str, draft: str) -> Dict[str, Any]:
    """Return a copy of ``schema`` with its ``$id`` / ``$schema`` filled in.

    Persisting the derived identity into the stored document keeps the JSON Schema
    self-describing (matching the seeded ``std/v0`` rows). The canonical ``$id`` is
    always written; ``$schema`` is only added when missing so an author who pinned a
    specific dialect URI keeps it.

    Args:
        schema: The validated JSON Schema document.
        schema_id: The resolved ``$id`` to stamp.
        draft: The dialect token (used only to pick the meta URI when ``$schema``
            is absent and the draft is :data:`DRAFT_2020_12`).

    Returns:
        A new dict; the input is not mutated.
    """
    stamped = dict(schema)
    stamped["$id"] = schema_id
    if "$schema" not in stamped and draft == DRAFT_2020_12:
        stamped["$schema"] = DRAFT_2020_12_META_URI
    return stamped
