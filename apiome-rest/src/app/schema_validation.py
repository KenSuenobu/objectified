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
from typing import Any, Dict, List, Optional

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

# Containers of named sub-definitions in a JSON Schema document: ``$defs`` is the draft
# 2020-12 keyword, ``definitions`` the pre-2020 equivalent. Import paths read both.
IMPORT_CONTAINER_KEYS: tuple[str, ...] = ("$defs", "definitions")

# Keywords whose presence means a document *asserts* something about itself — it constrains
# instances, rather than merely holding sub-definitions. A document carrying any of these is
# imported as a type in its own right *alongside* its ``$defs`` / ``definitions`` members: a
# schema like ``.../api/list/response.json`` declares an ``$id``, a ``type``, and
# ``properties`` and also carries ``$defs`` of the sub-schemas it refs, so reading only the
# containers imports the parts and drops the whole.
#
# This set is only the *alongside-its-definitions* test. A document with no definitions to be
# read instead of is a type whenever it is a schema at all (:func:`is_root_type_document`) —
# asserting nothing is what the empty schema does, not a reason to reject a document.
#
# Mirrored by ``ROOT_SCHEMA_KEYWORDS`` in the import wizard
# (apiome-ui/src/app/ade/dashboard/primitives/primitiveImportModel.ts) so the client preview
# and the server review agree on what a document contains.
ROOT_SCHEMA_KEYWORDS: tuple[str, ...] = (
    "type",
    "properties",
    "anyOf",
    "oneOf",
    "allOf",
    "not",
    "enum",
    "const",
    "items",
    "prefixItems",
    "patternProperties",
    "$ref",
)

# The full draft 2020-12 keyword vocabulary — core, applicator, unevaluated, validation,
# meta-data, format and content — plus the pre-2020 spellings and the OpenAPI 3.0 dialect's
# extras that documents in the wild still carry. This answers the *broader* question
# :data:`ROOT_SCHEMA_KEYWORDS` does not: "is this mapping a JSON Schema at all?".
#
# The distinction matters because a schema is not required to constrain anything. A document
# that carries only annotations — a ``$schema``, an ``$id``, a title and an ``examples`` array —
# is a perfectly valid schema; it is the *empty* schema, which accepts any instance and whose
# category is therefore ``object`` (see ``determine_category_from_schema``). Such a document has
# to import as a type, because it is the only type the document describes.
#
# What this set excludes is the case the import paths must still refuse: arbitrary JSON that
# merely happens to be an object (a ``package.json``, a config file). Those carry no JSON Schema
# keyword at all, so importing one would create a type that describes nothing.
JSON_SCHEMA_KEYWORDS: frozenset[str] = frozenset(
    {
        # Core
        "$schema", "$id", "$ref", "$anchor", "$dynamicRef", "$dynamicAnchor",
        "$vocabulary", "$comment", "$defs",
        # Applicator
        "allOf", "anyOf", "oneOf", "not", "if", "then", "else", "dependentSchemas",
        "prefixItems", "items", "contains", "properties", "patternProperties",
        "additionalProperties", "propertyNames",
        # Unevaluated
        "unevaluatedItems", "unevaluatedProperties",
        # Validation
        "type", "const", "enum", "multipleOf", "maximum", "exclusiveMaximum", "minimum",
        "exclusiveMinimum", "maxLength", "minLength", "pattern", "maxItems", "minItems",
        "uniqueItems", "maxContains", "minContains", "maxProperties", "minProperties",
        "required", "dependentRequired",
        # Meta-data
        "title", "description", "default", "deprecated", "readOnly", "writeOnly", "examples",
        # Format & content
        "format", "contentEncoding", "contentMediaType", "contentSchema",
        # Pre-2020 drafts and the OpenAPI 3.0 dialect
        "definitions", "dependencies", "$recursiveRef", "$recursiveAnchor",
        "example", "nullable", "discriminator",
    }
)

# The keywords that, on their own, mark a container-less document as a schema. The definition
# containers are excluded: they are stripped from a root before it is imported, so a document
# that is *only* an (empty) ``$defs`` box describes nothing and is not a type.
_STANDALONE_SCHEMA_KEYWORDS: frozenset[str] = JSON_SCHEMA_KEYWORDS - set(IMPORT_CONTAINER_KEYS)

# Collapses any run of non-url-safe characters into a single hyphen for the
# ``$id`` leaf segment (e.g. "Email Address" -> "email-address").
_SLUG_NONWORD_RE = re.compile(r"[^a-z0-9]+")

# One shared meta-schema validator. Constructing the draft 2020-12 validator with
# its own ``META_SCHEMA`` as the schema makes ``iter_errors(document)`` report every
# way ``document`` fails to be a valid 2020-12 schema. Reused across all calls so the
# meta-schema and its vocabulary registry are resolved exactly once.
_META_VALIDATOR = Draft202012Validator(Draft202012Validator.META_SCHEMA)


#: Advisory shown for a definition that constrains nothing at all. Importing it is correct —
#: the empty schema is a valid type — but a reader who *meant* to declare a shape and left it
#: out gets a type that accepts any instance, which no validator will ever complain about.
#: Mirrored verbatim by ``UNTYPED_SCHEMA_WARNING`` in the import wizard.
UNTYPED_SCHEMA_WARNING = (
    "No type was specified in the JSON Schema: this might lead to erroneous behavior"
)


def untyped_schema_warning(schema: Any) -> Optional[str]:
    """Return the untyped-schema advisory for a definition, or ``None`` when it has a shape.

    Fires only when the definition asserts *nothing* — no ``type`` and none of the other
    :data:`ROOT_SCHEMA_KEYWORDS` a shape can be read from. A schema that omits ``type`` beside
    ``properties`` (an object), an ``enum`` (its values' type), or a ``$ref``/combinator (the
    referenced type) is not guessed at and is not warned about; warning on those would fire on
    most real-world documents and teach readers to ignore the advisory.

    Args:
        schema: The definition fragment.

    Returns:
        :data:`UNTYPED_SCHEMA_WARNING` when the definition is the empty schema, else ``None``.
    """
    if not isinstance(schema, dict):
        return None
    if any(keyword in schema for keyword in ROOT_SCHEMA_KEYWORDS):
        return None
    return UNTYPED_SCHEMA_WARNING


def merge_definition_containers(document: Any) -> Dict[str, Any]:
    """Return the merged ``name -> schema`` members of a document's definition containers.

    ``$defs`` is the draft 2020-12 container and ``definitions`` the pre-2020 equivalent; a
    document may legally carry both, so every import path reads both and merges them in that
    order. Shared so the primitives ``/import`` endpoints and the adapter pipeline resolve the
    same members from the same document.

    Args:
        document: The parsed source document (anything non-mapping yields no members).

    Returns:
        The merged members, in declaration order. Empty when the document declares no
        container, or declares one with nothing in it.
    """
    container: Dict[str, Any] = {}
    if not isinstance(document, dict):
        return container
    for key in IMPORT_CONTAINER_KEYS:
        block = document.get(key)
        if isinstance(block, dict):
            container.update(block)
    return container


def is_root_type_document(document: Any, *, has_definitions: bool) -> bool:
    """Whether a document's own root is a type to import, beside any definitions it holds.

    Two questions, in order:

    1. Does the root **assert** something about itself (:data:`ROOT_SCHEMA_KEYWORDS`)? Then it
       is a type whether or not it also carries ``$defs`` — a response schema that declares a
       ``type`` and ``properties`` *and* the ``$defs`` it refs describes both.
    2. Otherwise, does it hold definitions that are the types instead? A pure container
       (``{"$defs": {...}}`` with only a title beside it) contributes no root type; its members
       are the types.

    With neither — nothing asserted and nothing held — the root is a type as long as it is a
    schema at all, i.e. it carries some JSON Schema keyword (:data:`JSON_SCHEMA_KEYWORDS`).
    A document that constrains nothing is the **empty schema**: it accepts any instance, and
    the registry categorizes it as ``object``. So a schema published as documentation — a
    ``$schema``, an ``$id``, a title, a description and an ``examples`` array — imports as the
    single type it describes, rather than being refused for declaring no ``type``.

    The keyword requirement is what still refuses arbitrary JSON that merely parses as an
    object (a ``package.json``): it carries no JSON Schema keyword, so there is no type in it.

    Args:
        document: The parsed source document.
        has_definitions: Whether the document's ``$defs`` / ``definitions`` containers hold
            any members (see :func:`merge_definition_containers`).

    Returns:
        ``True`` when the document's root should be imported as a type of its own.
    """
    if not isinstance(document, dict):
        return False
    if any(keyword in document for keyword in ROOT_SCHEMA_KEYWORDS):
        return True
    if has_definitions:
        return False
    return any(keyword in document for keyword in _STANDALONE_SCHEMA_KEYWORDS)


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
