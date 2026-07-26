"""Walk a spec's ``example``/``examples`` blocks and check each against its schema — IXH-5.4 (#5116).

Specs routinely ship examples that do not satisfy the schema sitting right next to them. That is
a defect the author ships to every consumer — the docs render it, mock servers replay it, client
generators seed fixtures from it — and no existing rule pack catches it: the packs check
structure and style, never whether a payload conforms.

This module is the pure core that closes that gap. It answers two questions:

1. **Where are the examples, and what schema governs each?** :func:`walk_example_sites` walks the
   document and yields one :class:`ExampleSite` per example, carrying the JSON Pointer to the
   example *and* the JSON Pointer to its governing schema. The set of locations walked is
   declared per format in :data:`EXAMPLE_FAMILIES` — machine-readable, so the capability matrix
   and the tests read the same table the walker does, and coverage cannot silently drift from
   what is documented.

2. **Does each example conform?** :func:`check_example_conformance` validates every site through
   the IXH-5.1 validator (:func:`app.schema_instance_validation.validate_json_instance`) rather
   than re-implementing JSON Schema. Nothing is fetched: the whole document is handed to the
   validator as a single in-memory resource under :data:`SPEC_BASE_URI`, and the governing schema
   is addressed as ``{"$ref": "<base>#<schema pointer>"}``. A ``$ref`` *inside* the document
   (``#/components/schemas/Pet``) therefore resolves against the document exactly as the spec
   author intended, while a ``$ref`` pointing anywhere else is unresolvable by construction.

**Two kinds of example, and they are not interchangeable.** A *schema* example (``example``, or
``examples`` as an array in 2020-12 dialects) is an instance of the schema it sits in. A
*carrier* example — on an OpenAPI parameter, media type, or header — is an instance of that
carrier's ``schema`` sub-object, and its ``examples`` is a **map of Example Objects** whose
instance lives under ``value``. Conflating the two produces nonsense findings, so the walker
keeps them apart and each family declares which of the two shapes it uses where.

**Dialects.** An example is only as checkable as its schema's dialect. OpenAPI 3.0 and Swagger 2
spell ``exclusiveMinimum`` as a *boolean* modifier, which draft 2020-12 reads as a number and
rejects as an invalid schema — so those families are checked under **draft-04**, where the
boolean form is native. OpenAPI 3.1 and AsyncAPI 3 are 2020-12; AsyncAPI 2 is draft-07. A JSON
Schema document declares its own dialect. Getting this wrong does not merely lose coverage: it
would report the *schema's* dialect mismatch as the *example's* failure.

**Honesty.** A schema that will not compile, or one whose ``$ref``s cannot be resolved inside the
document, yields **no finding** — the example was not checked, and saying nothing is the only
truthful answer. Those sites are counted in
:attr:`ExampleConformanceReport.sites_unchecked` so the count is visible rather than implied.

Pure: no I/O, no clock, no network. Deterministic: sites are emitted in a fixed traversal order
(sorted keys at every mapping), and issues follow site order then the validator's own
deterministic finding order.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any, Dict, List, Mapping, Optional, Tuple

from .schema_instance_validation import DEFAULT_MAX_FINDINGS, validate_json_instance

__all__ = [
    "EXAMPLE_FAMILIES",
    "MAX_EXAMPLE_SITES",
    "MAX_ISSUES_PER_SITE",
    "MAX_SCHEMA_WALK_DEPTH",
    "SPEC_BASE_URI",
    "ExampleConformanceIssue",
    "ExampleConformanceReport",
    "ExampleFamily",
    "ExampleSite",
    "check_example_conformance",
    "family_for_format",
    "resolve_example_family",
    "supported_example_formats",
    "supports_example_conformance",
    "walk_example_sites",
]

#: Base URI the document is registered under while its examples are checked. A ``urn:`` with no
#: authority cannot be dereferenced by anything, which is the point: the validator's registry is
#: seeded with this one in-memory resource and can reach nothing else.
SPEC_BASE_URI = "urn:apiome:spec"

#: Ceiling on how many example sites one document contributes. A generated spec can carry an
#: example on every property of every schema; the walk stays linear, but the *validation* is the
#: expensive half, so the site count is what is bounded. Truncation is reported, never silent.
MAX_EXAMPLE_SITES = 2000

#: Ceiling on findings kept per site. One example that misses its schema in forty places is one
#: defect; the first few reasons are what a user acts on.
MAX_ISSUES_PER_SITE = 5

#: Depth ceiling for the recursive schema walk. Far above real schemas, and it makes a
#: self-referential document (a schema that is its own ``additionalProperties``) terminate.
MAX_SCHEMA_WALK_DEPTH = 40

# JSON Schema dialect tokens (as :func:`app.schema_validation.derive_draft` spells them).
_DRAFT_04 = "04"
_DRAFT_07 = "07"
_DRAFT_2020_12 = "2020-12"


@dataclass(frozen=True)
class ExampleFamily:
    """One spec family the walker understands, and what it walks there.

    Attributes:
        key: Stable family key (``openapi-3.1``, ``asyncapi-2``, ``json-schema``, …).
        dialect: JSON Schema dialect the family's schemas are written in — see the module
            docstring on why this is per family and not a constant.
        schema_examples_array: Whether an ``examples`` **array** inside a schema is an example
            list in this family. It is in 2020-12-era dialects; in OpenAPI 3.0 and Swagger 2 a
            schema has only the singular ``example``, so an ``examples`` key there is a
            vendor extension the walker must not misread as instances.
        locations: Human-readable list of every location this family walks — the documented
            answer to "which examples are covered?", published through the lint capability
            matrix and asserted by the tests.
    """

    key: str
    dialect: str
    schema_examples_array: bool
    locations: Tuple[str, ...]


#: The location set walked per family. This table **is** the documentation the acceptance
#: criteria call for: the walker dispatches on it, the capability matrix publishes it, and the
#: tests assert every listed location is exercised, so the three cannot drift apart.
EXAMPLE_FAMILIES: Dict[str, ExampleFamily] = {
    "openapi-3.1": ExampleFamily(
        key="openapi-3.1",
        dialect=_DRAFT_2020_12,
        schema_examples_array=True,
        locations=(
            "components.schemas.*  (schema example / examples array, recursively)",
            "components.parameters.* / components.headers.*  (carrier example / examples map)",
            "components.requestBodies.*.content.*  (carrier)",
            "components.responses.*.content.* and .headers.*  (carrier)",
            "paths.*.parameters[*] and paths.*.<method>.parameters[*]  (carrier)",
            "paths.*.<method>.requestBody.content.*  (carrier)",
            "paths.*.<method>.responses.*.content.* and .headers.*  (carrier)",
            "webhooks.*.<method>.*  (same carriers as paths)",
        ),
    ),
    "openapi-3.0": ExampleFamily(
        key="openapi-3.0",
        dialect=_DRAFT_04,
        schema_examples_array=False,
        locations=(
            "components.schemas.*  (schema example, recursively)",
            "components.parameters.* / components.headers.*  (carrier example / examples map)",
            "components.requestBodies.*.content.*  (carrier)",
            "components.responses.*.content.* and .headers.*  (carrier)",
            "paths.*.parameters[*] and paths.*.<method>.parameters[*]  (carrier)",
            "paths.*.<method>.requestBody.content.*  (carrier)",
            "paths.*.<method>.responses.*.content.* and .headers.*  (carrier)",
        ),
    ),
    "swagger-2": ExampleFamily(
        key="swagger-2",
        dialect=_DRAFT_04,
        schema_examples_array=False,
        locations=(
            "definitions.*  (schema example, recursively)",
            "paths.*.<method>.parameters[*].schema  (body parameter schema example)",
            "paths.*.<method>.responses.*  (response schema example, and examples.<mime>)",
            "parameters.* / responses.*  (top-level reusable objects)",
        ),
    ),
    "asyncapi-2": ExampleFamily(
        key="asyncapi-2",
        dialect=_DRAFT_07,
        schema_examples_array=True,
        locations=(
            "components.schemas.*  (schema example / examples array, recursively)",
            "components.messages.*.payload and .headers  (schema examples)",
            "components.messages.*.examples[*].payload / .headers  (message example objects)",
            "channels.*.publish|subscribe.message  (inline message, incl. oneOf variants)",
        ),
    ),
    "asyncapi-3": ExampleFamily(
        key="asyncapi-3",
        dialect=_DRAFT_2020_12,
        schema_examples_array=True,
        locations=(
            "components.schemas.*  (schema example / examples array, recursively)",
            "components.messages.*.payload and .headers  (schema examples)",
            "components.messages.*.examples[*].payload / .headers  (message example objects)",
            "channels.*.messages.*  (same as components.messages)",
        ),
    ),
    "json-schema": ExampleFamily(
        key="json-schema",
        dialect=_DRAFT_2020_12,
        schema_examples_array=True,
        locations=(
            "the document root schema and every subschema it reaches "
            "(properties, items, prefixItems, $defs, definitions, allOf/anyOf/oneOf, "
            "additionalProperties, patternProperties) — example and examples array",
        ),
    ),
}

#: Format keys (as adapters and the catalog spell them) → family key. A family may be reachable
#: under several format tokens; the *document's own* version marker still wins (see
#: :func:`resolve_example_family`), because a mislabeled revision must not be checked under the
#: wrong dialect.
_FORMAT_KEY_ALIASES: Dict[str, str] = {
    # OpenAPI: 3.1 and 3.2 are draft 2020-12; 3.0 is the draft-04-shaped dialect. A bare
    # ``openapi`` token (the adapter registry key both major lines import under) is assumed
    # 3.1 only as a fallback — a real 3.0 document overrides it by declaring its version.
    "openapi": "openapi-3.1",
    "openapi-3": "openapi-3.1",
    "openapi-3.1": "openapi-3.1",
    "openapi-3.2": "openapi-3.1",
    "openapi-3.0": "openapi-3.0",
    "swagger": "swagger-2",
    "swagger-2": "swagger-2",
    "swagger-2.0": "swagger-2",
    "asyncapi": "asyncapi-3",
    "asyncapi-2": "asyncapi-2",
    "asyncapi-3": "asyncapi-3",
    "json-schema": "json-schema",
    "json-schema-2020-12": "json-schema",
    "jsonschema": "json-schema",
}

#: Sub-object keys whose value is itself a schema.
_SCHEMA_CHILD_KEYS = ("items", "additionalProperties", "not", "if", "then", "else", "contains")

#: Sub-object keys whose value is a *mapping* of name → schema.
_SCHEMA_MAP_KEYS = ("properties", "patternProperties", "$defs", "definitions")

#: Sub-object keys whose value is a *list* of schemas.
_SCHEMA_LIST_KEYS = ("allOf", "anyOf", "oneOf", "prefixItems")

#: HTTP methods an OpenAPI path item may carry.
_HTTP_METHODS = ("get", "put", "post", "delete", "options", "head", "patch", "trace")


@dataclass(frozen=True)
class ExampleSite:
    """One example found in a document, paired with the schema that governs it.

    Attributes:
        example_pointer: RFC 6901 JSON Pointer to the example value in the document.
        schema_pointer: JSON Pointer to the governing schema in the same document.
        value: The example instance itself.
        label: Short human location (``response 200 'application/json' example 'adult'``), used
            in the finding message so a reader knows where to look without decoding a pointer.
        dialect: JSON Schema dialect the governing schema is written in.
    """

    example_pointer: str
    schema_pointer: str
    value: Any
    label: str
    dialect: str


@dataclass(frozen=True)
class ExampleConformanceIssue:
    """One example that does not satisfy its schema.

    Attributes:
        example_pointer: JSON Pointer to the offending example.
        schema_pointer: JSON Pointer to the schema it failed.
        label: The site's human location label.
        keyword: The schema keyword the example violated.
        instance_pointer: Pointer *within the example* to the offending value (``""`` at its
            root) — so a 40-property example names the one property at fault.
        message: Human-readable description of the violation.
    """

    example_pointer: str
    schema_pointer: str
    label: str
    keyword: str
    instance_pointer: str
    message: str


@dataclass(frozen=True)
class ExampleConformanceReport:
    """The outcome of checking every example in one document.

    Attributes:
        family: The family the document was checked as, or ``None`` when it is not a family
            this module walks (in which case nothing was checked).
        issues: Non-conforming examples, in site order then validator order.
        sites_checked: How many example sites were actually validated.
        sites_unchecked: Sites whose schema could not compile or resolve, so no verdict was
            reached — counted rather than silently dropped.
        truncated: Whether the walk hit :data:`MAX_EXAMPLE_SITES`.
    """

    family: Optional[ExampleFamily]
    issues: Tuple[ExampleConformanceIssue, ...] = ()
    sites_checked: int = 0
    sites_unchecked: int = 0
    truncated: bool = False


# ===========================================================================
# Family resolution
# ===========================================================================


def supported_example_formats() -> Tuple[str, ...]:
    """Return every format token that resolves to a walked family, sorted."""
    return tuple(sorted(_FORMAT_KEY_ALIASES))


def supports_example_conformance(format_key: Optional[str]) -> bool:
    """Return whether ``format_key`` names a format whose examples this module walks."""
    return family_for_format(format_key) is not None


def family_for_format(format_key: Optional[str]) -> Optional[ExampleFamily]:
    """Resolve a format/catalog token to the family it is walked as, or ``None``.

    The document-free half of :func:`resolve_example_family`: it answers "would this format's
    examples be walked at all?", which is what the lint capability matrix publishes per format.
    When a document is in hand, prefer :func:`resolve_example_family` — the document's own
    version marker is authoritative over its stored format key.

    Args:
        format_key: An adapter or catalog format token (``openapi-3.0``, ``asyncapi-2``, …).

    Returns:
        The matching :class:`ExampleFamily`, or ``None`` for a format with no walked examples.
    """
    key = (format_key or "").strip().lower()
    family_key = _FORMAT_KEY_ALIASES.get(key)
    return EXAMPLE_FAMILIES.get(family_key) if family_key else None


def resolve_example_family(
    document: Any, format_key: Optional[str] = None
) -> Optional[ExampleFamily]:
    """Decide which family a document belongs to, preferring its own version marker.

    The document's ``openapi`` / ``swagger`` / ``asyncapi`` version string is authoritative: a
    revision stored under the format key ``openapi`` may hold a 3.0 document, and checking 3.0
    schemas under 2020-12 would report the *dialect* mismatch as the *example's* fault. The
    format key is only consulted when the document declares nothing (which is the normal case
    for a bare JSON Schema).

    Args:
        document: The parsed source document.
        format_key: The adapter/catalog format token, used as a fallback hint.

    Returns:
        The :class:`ExampleFamily` to walk under, or ``None`` when the document is not one
        this module covers.
    """
    if not isinstance(document, Mapping):
        return None

    version = document.get("openapi")
    if isinstance(version, str) and version.strip():
        return EXAMPLE_FAMILIES[
            "openapi-3.0" if version.strip().startswith("3.0") else "openapi-3.1"
        ]

    swagger = document.get("swagger")
    if isinstance(swagger, str) and swagger.strip().startswith("2"):
        return EXAMPLE_FAMILIES["swagger-2"]

    asyncapi = document.get("asyncapi")
    if isinstance(asyncapi, str) and asyncapi.strip():
        return EXAMPLE_FAMILIES[
            "asyncapi-2" if asyncapi.strip().startswith("2") else "asyncapi-3"
        ]

    hinted = family_for_format(format_key)
    if hinted is not None:
        return hinted

    # An unlabeled document that declares a JSON Schema dialect is a JSON Schema.
    if isinstance(document.get("$schema"), str):
        return EXAMPLE_FAMILIES["json-schema"]
    return None


# ===========================================================================
# Pointer helpers
# ===========================================================================


def _escape(token: Any) -> str:
    """Escape one JSON Pointer reference token per RFC 6901."""
    return str(token).replace("~", "~0").replace("/", "~1")


def _join(pointer: str, *tokens: Any) -> str:
    """Append reference tokens to a JSON Pointer."""
    return pointer + "".join(f"/{_escape(token)}" for token in tokens)


def _mapping(value: Any) -> Optional[Mapping[str, Any]]:
    """Return ``value`` when it is a mapping, else ``None`` (defensive against odd documents)."""
    return value if isinstance(value, Mapping) else None


def _sorted_keys(mapping: Mapping[str, Any]) -> List[str]:
    """Return a mapping's string keys, sorted — the walk's determinism comes from here."""
    return sorted(k for k in mapping if isinstance(k, str))


# ===========================================================================
# Walking
# ===========================================================================


class _Walk:
    """Accumulator for one document walk: collected sites plus the site budget."""

    def __init__(self, family: ExampleFamily, max_sites: int) -> None:
        self.family = family
        self.max_sites = max_sites
        self.sites: List[ExampleSite] = []
        self.truncated = False

    def add(self, *, example_pointer: str, schema_pointer: str, value: Any, label: str) -> None:
        """Record one site, marking the walk truncated once the budget is spent."""
        if len(self.sites) >= self.max_sites:
            self.truncated = True
            return
        self.sites.append(
            ExampleSite(
                example_pointer=example_pointer,
                schema_pointer=schema_pointer,
                value=value,
                label=label,
                dialect=self.family.dialect,
            )
        )


def walk_example_sites(
    document: Any,
    *,
    format_key: Optional[str] = None,
    max_sites: int = MAX_EXAMPLE_SITES,
) -> Tuple[List[ExampleSite], Optional[ExampleFamily], bool]:
    """Collect every example in ``document`` with the schema that governs it.

    Args:
        document: The parsed source document.
        format_key: Adapter/catalog format token, used only as a fallback family hint.
        max_sites: Ceiling on collected sites.

    Returns:
        ``(sites, family, truncated)``. ``family`` is ``None`` — and ``sites`` empty — when the
        document is not one of the walked families.
    """
    family = resolve_example_family(document, format_key)
    if family is None or not isinstance(document, Mapping):
        return [], None, False

    walk = _Walk(family, max_sites)
    if family.key in ("openapi-3.1", "openapi-3.0"):
        _walk_openapi3(document, walk)
    elif family.key == "swagger-2":
        _walk_swagger2(document, walk)
    elif family.key in ("asyncapi-2", "asyncapi-3"):
        _walk_asyncapi(document, walk)
    else:
        _walk_schema(document, "", walk, label="schema", depth=0)
    return walk.sites, family, walk.truncated


# --- schema subtrees --------------------------------------------------------


def _walk_schema(
    schema: Any, pointer: str, walk: _Walk, *, label: str, depth: int
) -> None:
    """Collect a schema's own examples, then recurse into its subschemas.

    A schema's ``example`` is one instance of *that* schema; its ``examples`` is an array of
    instances, but only in the dialects that define it that way (see
    :attr:`ExampleFamily.schema_examples_array`) — elsewhere the key is a vendor extension and
    reading it as instances would invent findings.

    Args:
        schema: The candidate schema node.
        pointer: JSON Pointer to ``schema`` in the document.
        walk: The accumulator.
        label: Human location prefix for sites found here.
        depth: Current recursion depth, bounded by :data:`MAX_SCHEMA_WALK_DEPTH`.
    """
    node = _mapping(schema)
    if node is None or depth > MAX_SCHEMA_WALK_DEPTH:
        return

    if "example" in node:
        walk.add(
            example_pointer=_join(pointer, "example"),
            schema_pointer=pointer,
            value=node["example"],
            label=f"{label} example",
        )
    if walk.family.schema_examples_array and isinstance(node.get("examples"), list):
        for index, value in enumerate(node["examples"]):
            walk.add(
                example_pointer=_join(pointer, "examples", index),
                schema_pointer=pointer,
                value=value,
                label=f"{label} examples[{index}]",
            )

    for key in _SCHEMA_CHILD_KEYS:
        if key in node:
            _walk_schema(
                node[key], _join(pointer, key), walk, label=f"{label}.{key}", depth=depth + 1
            )
    for key in _SCHEMA_MAP_KEYS:
        children = _mapping(node.get(key))
        if children is None:
            continue
        for name in _sorted_keys(children):
            _walk_schema(
                children[name],
                _join(pointer, key, name),
                walk,
                label=f"{label}.{name}",
                depth=depth + 1,
            )
    for key in _SCHEMA_LIST_KEYS:
        children = node.get(key)
        if not isinstance(children, list):
            continue
        for index, child in enumerate(children):
            _walk_schema(
                child,
                _join(pointer, key, index),
                walk,
                label=f"{label}.{key}[{index}]",
                depth=depth + 1,
            )


# --- carriers (parameter / media type / header) ------------------------------


def _walk_carrier(carrier: Any, pointer: str, walk: _Walk, *, label: str) -> None:
    """Collect a carrier object's examples against its ``schema`` sub-object.

    A *carrier* is an OpenAPI Parameter, Header, or Media Type Object: it holds a ``schema``
    plus either a singular ``example`` or an ``examples`` **map** of Example Objects whose
    instance lives under ``value``. An Example Object with ``externalValue`` points at content
    that is not in the document, so there is nothing to check and it is skipped rather than
    reported. The carrier's schema subtree is also walked, since it may carry its own examples.

    Args:
        carrier: The candidate carrier object.
        pointer: JSON Pointer to ``carrier``.
        walk: The accumulator.
        label: Human location prefix.
    """
    node = _mapping(carrier)
    if node is None:
        return
    schema_pointer = _join(pointer, "schema")
    has_schema = _mapping(node.get("schema")) is not None

    if has_schema:
        if "example" in node:
            walk.add(
                example_pointer=_join(pointer, "example"),
                schema_pointer=schema_pointer,
                value=node["example"],
                label=f"{label} example",
            )
        examples = _mapping(node.get("examples"))
        if examples is not None:
            for name in _sorted_keys(examples):
                entry = _mapping(examples[name])
                if entry is None or "value" not in entry:
                    # No inline instance (``externalValue``, or a bare ``$ref``): nothing to check.
                    continue
                walk.add(
                    example_pointer=_join(pointer, "examples", name, "value"),
                    schema_pointer=schema_pointer,
                    value=entry["value"],
                    label=f"{label} example '{name}'",
                )
        _walk_schema(node["schema"], schema_pointer, walk, label=f"{label} schema", depth=0)


def _walk_content(content: Any, pointer: str, walk: _Walk, *, label: str) -> None:
    """Walk every media type under an OpenAPI ``content`` mapping."""
    media_types = _mapping(content)
    if media_types is None:
        return
    for media_type in _sorted_keys(media_types):
        _walk_carrier(
            media_types[media_type],
            _join(pointer, media_type),
            walk,
            label=f"{label} '{media_type}'",
        )


def _walk_headers(headers: Any, pointer: str, walk: _Walk, *, label: str) -> None:
    """Walk every header object under an OpenAPI ``headers`` mapping."""
    node = _mapping(headers)
    if node is None:
        return
    for name in _sorted_keys(node):
        _walk_carrier(node[name], _join(pointer, name), walk, label=f"{label} header '{name}'")


def _walk_parameter_list(parameters: Any, pointer: str, walk: _Walk, *, label: str) -> None:
    """Walk a positional OpenAPI ``parameters`` array.

    A ``$ref``-only entry is skipped: its target lives under ``components.parameters`` and is
    walked there, so following the ref would report the same defect twice.
    """
    if not isinstance(parameters, list):
        return
    for index, parameter in enumerate(parameters):
        node = _mapping(parameter)
        if node is None or "$ref" in node:
            continue
        name = node.get("name")
        suffix = f" '{name}'" if isinstance(name, str) else f"[{index}]"
        _walk_carrier(
            parameter, _join(pointer, index), walk, label=f"{label} parameter{suffix}"
        )


# --- OpenAPI 3.x -------------------------------------------------------------


def _walk_openapi3(document: Mapping[str, Any], walk: _Walk) -> None:
    """Walk every documented OpenAPI 3.x example location."""
    components = _mapping(document.get("components"))
    if components is not None:
        schemas = _mapping(components.get("schemas"))
        if schemas is not None:
            for name in _sorted_keys(schemas):
                _walk_schema(
                    schemas[name],
                    _join("", "components", "schemas", name),
                    walk,
                    label=f"schema '{name}'",
                    depth=0,
                )
        for section, noun in (("parameters", "parameter"), ("headers", "header")):
            carriers = _mapping(components.get(section))
            if carriers is None:
                continue
            for name in _sorted_keys(carriers):
                _walk_carrier(
                    carriers[name],
                    _join("", "components", section, name),
                    walk,
                    label=f"{noun} '{name}'",
                )
        bodies = _mapping(components.get("requestBodies"))
        if bodies is not None:
            for name in _sorted_keys(bodies):
                body = _mapping(bodies[name])
                if body is None:
                    continue
                _walk_content(
                    body.get("content"),
                    _join("", "components", "requestBodies", name, "content"),
                    walk,
                    label=f"requestBody '{name}'",
                )
        responses = _mapping(components.get("responses"))
        if responses is not None:
            for name in _sorted_keys(responses):
                response = _mapping(responses[name])
                if response is None:
                    continue
                base = _join("", "components", "responses", name)
                _walk_content(
                    response.get("content"),
                    _join(base, "content"),
                    walk,
                    label=f"response '{name}'",
                )
                _walk_headers(
                    response.get("headers"),
                    _join(base, "headers"),
                    walk,
                    label=f"response '{name}'",
                )

    for section in ("paths", "webhooks"):
        items = _mapping(document.get(section))
        if items is None:
            continue
        for path_name in _sorted_keys(items):
            path_item = _mapping(items[path_name])
            if path_item is None:
                continue
            base = _join("", section, path_name)
            _walk_parameter_list(
                path_item.get("parameters"),
                _join(base, "parameters"),
                walk,
                label=f"{path_name}",
            )
            for method in _HTTP_METHODS:
                operation = _mapping(path_item.get(method))
                if operation is None:
                    continue
                _walk_operation(
                    operation, _join(base, method), walk, label=f"{method.upper()} {path_name}"
                )


def _walk_operation(
    operation: Mapping[str, Any], pointer: str, walk: _Walk, *, label: str
) -> None:
    """Walk one OpenAPI operation's parameters, request body, and responses."""
    _walk_parameter_list(
        operation.get("parameters"), _join(pointer, "parameters"), walk, label=label
    )
    request_body = _mapping(operation.get("requestBody"))
    if request_body is not None:
        _walk_content(
            request_body.get("content"),
            _join(pointer, "requestBody", "content"),
            walk,
            label=f"{label} requestBody",
        )
    responses = _mapping(operation.get("responses"))
    if responses is None:
        return
    for code in _sorted_keys(responses):
        response = _mapping(responses[code])
        if response is None:
            continue
        base = _join(pointer, "responses", code)
        _walk_content(
            response.get("content"),
            _join(base, "content"),
            walk,
            label=f"{label} response {code}",
        )
        _walk_headers(
            response.get("headers"),
            _join(base, "headers"),
            walk,
            label=f"{label} response {code}",
        )


# --- Swagger 2 ---------------------------------------------------------------


def _walk_swagger2(document: Mapping[str, Any], walk: _Walk) -> None:
    """Walk every documented Swagger 2 example location.

    Swagger 2 has no Media Type Object: a body parameter carries ``schema`` directly, and a
    response carries ``schema`` plus an ``examples`` map keyed by **MIME type** (not by example
    name), whose value is the instance itself rather than an Example Object.
    """
    definitions = _mapping(document.get("definitions"))
    if definitions is not None:
        for name in _sorted_keys(definitions):
            _walk_schema(
                definitions[name],
                _join("", "definitions", name),
                walk,
                label=f"definition '{name}'",
                depth=0,
            )

    top_parameters = _mapping(document.get("parameters"))
    if top_parameters is not None:
        for name in _sorted_keys(top_parameters):
            _walk_body_parameter(
                top_parameters[name],
                _join("", "parameters", name),
                walk,
                label=f"parameter '{name}'",
            )

    top_responses = _mapping(document.get("responses"))
    if top_responses is not None:
        for name in _sorted_keys(top_responses):
            _walk_swagger2_response(
                top_responses[name],
                _join("", "responses", name),
                walk,
                label=f"response '{name}'",
            )

    paths = _mapping(document.get("paths"))
    if paths is None:
        return
    for path_name in _sorted_keys(paths):
        path_item = _mapping(paths[path_name])
        if path_item is None:
            continue
        for method in _HTTP_METHODS:
            operation = _mapping(path_item.get(method))
            if operation is None:
                continue
            label = f"{method.upper()} {path_name}"
            base = _join("", "paths", path_name, method)
            parameters = operation.get("parameters")
            if isinstance(parameters, list):
                for index, parameter in enumerate(parameters):
                    _walk_body_parameter(
                        parameter, _join(base, "parameters", index), walk, label=label
                    )
            responses = _mapping(operation.get("responses"))
            if responses is None:
                continue
            for code in _sorted_keys(responses):
                _walk_swagger2_response(
                    responses[code],
                    _join(base, "responses", code),
                    walk,
                    label=f"{label} response {code}",
                )


def _walk_body_parameter(parameter: Any, pointer: str, walk: _Walk, *, label: str) -> None:
    """Walk a Swagger 2 body parameter's schema (non-body parameters carry no example)."""
    node = _mapping(parameter)
    if node is None or "$ref" in node:
        return
    schema = _mapping(node.get("schema"))
    if schema is None:
        return
    name = node.get("name")
    suffix = f" '{name}'" if isinstance(name, str) else ""
    _walk_schema(
        schema,
        _join(pointer, "schema"),
        walk,
        label=f"{label} body{suffix}",
        depth=0,
    )


def _walk_swagger2_response(response: Any, pointer: str, walk: _Walk, *, label: str) -> None:
    """Walk a Swagger 2 response: its schema's examples, plus its per-MIME ``examples`` map."""
    node = _mapping(response)
    if node is None or "$ref" in node:
        return
    schema = _mapping(node.get("schema"))
    if schema is None:
        return
    schema_pointer = _join(pointer, "schema")
    examples = _mapping(node.get("examples"))
    if examples is not None:
        for mime in _sorted_keys(examples):
            walk.add(
                example_pointer=_join(pointer, "examples", mime),
                schema_pointer=schema_pointer,
                value=examples[mime],
                label=f"{label} example '{mime}'",
            )
    _walk_schema(schema, schema_pointer, walk, label=f"{label} schema", depth=0)


# --- AsyncAPI 2 / 3 ----------------------------------------------------------


def _walk_asyncapi(document: Mapping[str, Any], walk: _Walk) -> None:
    """Walk every documented AsyncAPI example location (both major versions)."""
    components = _mapping(document.get("components"))
    if components is not None:
        schemas = _mapping(components.get("schemas"))
        if schemas is not None:
            for name in _sorted_keys(schemas):
                _walk_schema(
                    schemas[name],
                    _join("", "components", "schemas", name),
                    walk,
                    label=f"schema '{name}'",
                    depth=0,
                )
        messages = _mapping(components.get("messages"))
        if messages is not None:
            for name in _sorted_keys(messages):
                _walk_message(
                    messages[name],
                    _join("", "components", "messages", name),
                    walk,
                    label=f"message '{name}'",
                )

    channels = _mapping(document.get("channels"))
    if channels is None:
        return
    for channel_name in _sorted_keys(channels):
        channel = _mapping(channels[channel_name])
        if channel is None:
            continue
        base = _join("", "channels", channel_name)
        # AsyncAPI 3: channels.<c>.messages.<m>
        messages = _mapping(channel.get("messages"))
        if messages is not None:
            for name in _sorted_keys(messages):
                _walk_message(
                    messages[name],
                    _join(base, "messages", name),
                    walk,
                    label=f"channel '{channel_name}' message '{name}'",
                )
        # AsyncAPI 2: channels.<c>.publish|subscribe.message (possibly a oneOf list)
        for action in ("publish", "subscribe"):
            operation = _mapping(channel.get(action))
            if operation is None:
                continue
            message = _mapping(operation.get("message"))
            if message is None:
                continue
            message_pointer = _join(base, action, "message")
            variants = message.get("oneOf")
            if isinstance(variants, list):
                for index, variant in enumerate(variants):
                    _walk_message(
                        variant,
                        _join(message_pointer, "oneOf", index),
                        walk,
                        label=f"channel '{channel_name}' {action} message[{index}]",
                    )
            else:
                _walk_message(
                    message,
                    message_pointer,
                    walk,
                    label=f"channel '{channel_name}' {action} message",
                )


def _walk_message(message: Any, pointer: str, walk: _Walk, *, label: str) -> None:
    """Walk one AsyncAPI message: its payload/headers schemas and its example objects.

    A message's ``examples`` is a **list** of Message Example Objects, each of which may carry a
    ``payload`` and/or ``headers`` instance — validated against the message's ``payload`` and
    ``headers`` schemas respectively. A ``$ref``-only message is skipped: its target under
    ``components.messages`` is walked directly.
    """
    node = _mapping(message)
    if node is None or "$ref" in node:
        return

    for part in ("payload", "headers"):
        schema = _mapping(node.get(part))
        if schema is not None:
            _walk_schema(
                schema, _join(pointer, part), walk, label=f"{label} {part}", depth=0
            )

    examples = node.get("examples")
    if not isinstance(examples, list):
        return
    for index, example in enumerate(examples):
        entry = _mapping(example)
        if entry is None:
            continue
        name = entry.get("name")
        suffix = f" '{name}'" if isinstance(name, str) else f"[{index}]"
        for part in ("payload", "headers"):
            if part not in entry or _mapping(node.get(part)) is None:
                continue
            walk.add(
                example_pointer=_join(pointer, "examples", index, part),
                schema_pointer=_join(pointer, part),
                value=entry[part],
                label=f"{label} example{suffix} {part}",
            )


# ===========================================================================
# Checking
# ===========================================================================


def _is_binary_float_artifact(keyword: str, actual: Any, expected: Any) -> bool:
    """Return whether a ``multipleOf`` miss exists only because of binary floating point.

    ``multipleOf`` is defined as "division by this value results in an integer", and every
    Python-side validator performs that division in **binary** floating point — where ``0.01``
    is not exactly representable, so ``273.15 / 0.01`` lands a hair off an integer and a
    perfectly reasonable example is rejected. The JSON Schema specification itself warns that
    ``multipleOf`` with a non-integer divisor is subject to representation limits, and
    implementations disagree.

    A finding an author cannot act on — the only "fix" is deleting the constraint — is noise, so
    the division is redone in **decimal**, which is the arithmetic the document was written in.
    A value that divides exactly there is treated as conforming. A genuine miss (``7`` against
    ``multipleOf: 2``) still divides unevenly in decimal and is still reported.

    Args:
        keyword: The failing schema keyword.
        actual: The instance value the validator rejected.
        expected: The keyword's value (the divisor).

    Returns:
        ``True`` when the finding should be dropped as a representation artifact.
    """
    if keyword != "multipleOf":
        return False
    if isinstance(actual, bool) or isinstance(expected, bool):
        return False
    if not isinstance(actual, (int, float)) or not isinstance(expected, (int, float)):
        return False
    try:
        divisor = Decimal(str(expected))
        if divisor == 0:
            return False
        return Decimal(str(actual)) % divisor == 0
    except (InvalidOperation, ValueError, ArithmeticError):
        return False


def check_example_conformance(
    document: Any,
    *,
    format_key: Optional[str] = None,
    max_sites: int = MAX_EXAMPLE_SITES,
    max_issues_per_site: int = MAX_ISSUES_PER_SITE,
) -> ExampleConformanceReport:
    """Validate every example in ``document`` against the schema that governs it.

    Each site is validated through the IXH-5.1 validator with the whole document registered as
    one in-memory resource, so a ``$ref`` inside the document resolves and a ``$ref`` anywhere
    else does not — there is no code path here that reads a file or opens a socket.

    Args:
        document: The parsed source document.
        format_key: Adapter/catalog format token, used only as a fallback family hint.
        max_sites: Ceiling on example sites walked.
        max_issues_per_site: Ceiling on reported violations per example.

    Returns:
        The :class:`ExampleConformanceReport`. A document from an unwalked family yields an
        empty report with ``family = None`` — never a claim that its examples are fine.
    """
    sites, family, truncated = walk_example_sites(
        document, format_key=format_key, max_sites=max_sites
    )
    if family is None:
        return ExampleConformanceReport(family=None)

    def retrieve(uri: str) -> Optional[Dict[str, Any]]:
        """Serve the one document under test, and nothing else."""
        return dict(document) if uri == SPEC_BASE_URI else None

    issues: List[ExampleConformanceIssue] = []
    checked = 0
    unchecked = 0
    for site in sites:
        try:
            result = validate_json_instance(
                {"$ref": f"{SPEC_BASE_URI}#{site.schema_pointer}"},
                site.value,
                dialect=site.dialect,
                retrieve=retrieve,
                max_findings=min(max_issues_per_site, DEFAULT_MAX_FINDINGS),
            )
        except Exception:  # noqa: BLE001 — see below; a broken schema must not break the lint
            # The governing schema is addressed by ``$ref``, so the validator's own
            # ``check_schema`` only ever sees the one-line wrapper — a malformed *target*
            # (``{"type": 17}``) is not caught there and surfaces as an arbitrary exception
            # from deep inside the keyword implementations. Enumerating those is not possible
            # across validator versions, so any fault is treated the same way a failed
            # ``check_schema`` is: the example was not checked, and nothing is claimed about
            # it. A lint run over a broken document must degrade, never crash.
            unchecked += 1
            continue
        if not result.validated:
            # The schema would not compile, or a reference in it could not be resolved. The
            # example was not checked, so nothing is claimed about it.
            unchecked += 1
            continue
        checked += 1
        for finding in result.findings:
            if _is_binary_float_artifact(finding.keyword, finding.actual, finding.expected):
                continue
            issues.append(
                ExampleConformanceIssue(
                    example_pointer=site.example_pointer,
                    schema_pointer=site.schema_pointer,
                    label=site.label,
                    keyword=finding.keyword,
                    instance_pointer=finding.pointer,
                    message=finding.message,
                )
            )

    return ExampleConformanceReport(
        family=family,
        issues=tuple(issues),
        sites_checked=checked,
        sites_unchecked=unchecked,
        truncated=truncated,
    )
