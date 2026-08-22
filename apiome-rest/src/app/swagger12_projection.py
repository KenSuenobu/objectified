"""Swagger 1.2 → Swagger 2.0 projection — FMT-3.6 (#5431).

Swagger **1.2** is not one document but two shapes: a *resource listing*
(``api-docs.json``) that names the resources an API exposes, and one *API
declaration* per resource carrying that resource's operations and models. Apiome
already reads Swagger 2.0 end to end (:class:`app.swagger2_normalizer.Swagger2Normalizer`),
so this module does not add a second REST projection — it **rewrites 1.2 onto the
2.0 document shape** and hands the result to the path that already exists.

The rewrite is mechanical, and every rule below is a spelling difference rather
than a semantic one:

===========================  =========================================================
Swagger 1.2                  Swagger 2.0
===========================  =========================================================
``swaggerVersion: "1.2"``    ``swagger: "2.0"``
``apiVersion``               ``info.version``
``basePath`` (absolute URL)  ``schemes`` + ``host`` + ``basePath``
``apis[].path``              a ``paths`` key
``operations[].method``      the path-item key (lower-cased)
``nickname``                 ``operationId``
``notes``                    ``description``
``paramType: form``          ``in: formData``
``type: "File"``             ``type: "file"``
``allowMultiple: true``      ``collectionFormat: "multi"``
``defaultValue``             ``default``
``models``                   ``definitions``
``$ref: "Order"``            ``$ref: "#/definitions/Order"``
``subTypes`` on the parent   ``allOf: [{$ref: parent}, …]`` on each child
``authorizations``           ``securityDefinitions`` (+ per-operation ``security``)
``responseMessages[]``       ``responses`` entries
operation ``type``/``items``  the success response's ``schema``
===========================  =========================================================

Two 1.2 constructs have no faithful 2.0 spelling, and both are recorded on the
projection's :attr:`Swagger12Provenance.limits` ledger rather than silently
dropped: an OAuth2 authorization declaring **more than one grant type** (2.0
allows exactly one ``flow`` per security definition, so the extra grants become
sibling definitions), and two declarations that disagree about ``basePath`` (2.0
has a single host/basePath pair, so the first wins).

Nothing here touches the Swagger 2.0 reader: a 1.2 import is a 2.0 import of a
rewritten document, which is why its canonical ``format`` is ``swagger-2.0`` and
why it stays publishable exactly like a 2.0 upload. The 1.2 provenance rides on
:class:`Swagger12ProjectedDocument`, a ``dict`` subclass, so the projected
document *is* the parsed 2.0 mapping every existing consumer expects while the
adapter can still publish "this came from 1.2" on the canonical model's extras —
the same seam :mod:`app.openapi_overlay` uses for overlay reports.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple
from urllib.parse import urlsplit

__all__ = [
    "SWAGGER_12_VERSION",
    "Swagger12Error",
    "Swagger12Provenance",
    "Swagger12ProjectedDocument",
    "declaration_resource",
    "is_api_declaration",
    "is_resource_listing",
    "is_swagger12_document",
    "project_swagger12",
    "swagger12_version",
]

#: The only Swagger 1.x revision this projection reads. 1.0/1.1 are recognized
#: (they carry the same ``swaggerVersion`` marker) but rejected as unsupported.
SWAGGER_12_VERSION = "1.2"

#: The Swagger 2.0 version marker the projection writes.
_SWAGGER_20_VERSION = "2.0"

#: ``#/definitions/`` — where a projected model reference points.
_DEFINITIONS_REF_PREFIX = "#/definitions/"

#: 1.2 ``paramType`` → 2.0 ``in``. ``form`` is the only rename.
_PARAM_TYPES: Dict[str, str] = {
    "path": "path",
    "query": "query",
    "header": "header",
    "body": "body",
    "form": "formData",
}

#: The primitive type names 1.2 shares with JSON Schema. Anything else in a
#: ``type`` position names a model.
_PRIMITIVE_TYPES = frozenset({"string", "number", "integer", "boolean", "array", "object"})

#: Keys a 1.2 model carries that have no place on a 2.0 schema object.
_MODEL_ONLY_KEYS = frozenset({"id", "subTypes"})

#: Schema keywords whose 1.2 spelling is a *string* even for numeric types
#: (``"minimum": "1"``), which 2.0 and JSON Schema require to be numbers.
_NUMERIC_KEYWORDS = ("minimum", "maximum")

#: HTTP methods a 1.2 operation may declare, in the order 2.0 path items list them.
_HTTP_METHODS: Tuple[str, ...] = ("get", "put", "post", "delete", "options", "head", "patch")


class Swagger12Error(ValueError):
    """Raised when a Swagger 1.2 document cannot be projected.

    Args:
        message: Human-readable description of what was wrong.
        code: The intake-taxonomy code the import pipeline should report
            (see :mod:`app.intake_error_taxonomy`). The adapter copies it onto
            the :class:`~app.import_source.ImportSourceError` it raises, so a 1.2
            failure lands under its own code instead of the coarse phase default.
    """

    def __init__(self, message: str, *, code: Optional[str] = None) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class Swagger12Provenance:
    """What the projection knows about the 1.2 source it rewrote.

    Attributes:
        source_version: The document's ``swaggerVersion`` (always ``"1.2"``).
        api_version: The source's ``apiVersion``, when it declared one.
        resource_listing: Path/label of the resource listing the import started
            from, or ``None`` when a bare API declaration was imported alone.
        declarations: The resource paths whose declarations were projected, in
            the order they were merged.
        limits: One line per 1.2 construct that 2.0 cannot hold faithfully.
    """

    source_version: str = SWAGGER_12_VERSION
    api_version: Optional[str] = None
    resource_listing: Optional[str] = None
    declarations: Tuple[str, ...] = ()
    limits: Tuple[str, ...] = ()

    def as_extras(self) -> Dict[str, Any]:
        """Render the provenance as the canonical model's ``extras`` payload.

        Returns:
            A JSON-safe mapping with the source version, the resources merged,
            and the capability-limit ledger — the evidence a reader needs to see
            that a Swagger 2.0 canonical model was projected from a 1.2 upload.
        """
        payload: Dict[str, Any] = {"source_version": self.source_version}
        if self.api_version:
            payload["api_version"] = self.api_version
        if self.resource_listing:
            payload["resource_listing"] = self.resource_listing
        if self.declarations:
            payload["declarations"] = list(self.declarations)
        if self.limits:
            payload["limits"] = list(self.limits)
        return payload


class Swagger12ProjectedDocument(dict):
    """A Swagger 2.0 document that was projected from Swagger 1.2.

    A plain ``dict`` to every consumer — the 2.0 detector, normalizer, and linter
    read it exactly as they read an uploaded 2.0 document — with the 1.2
    provenance carried alongside so the adapter can publish it on the canonical
    model's extras.

    Attributes:
        swagger12_provenance: What the projection knows about the 1.2 source.
    """

    swagger12_provenance: Swagger12Provenance

    def __init__(self, document: Mapping[str, Any], provenance: Swagger12Provenance) -> None:
        super().__init__(document)
        self.swagger12_provenance = provenance


# ===========================================================================
# Recognition
# ===========================================================================


def swagger12_version(document: Any) -> Optional[str]:
    """The ``swaggerVersion`` marker of a parsed document, when it has one.

    Args:
        document: A parsed document (any type; non-mappings simply have none).

    Returns:
        The trimmed ``swaggerVersion`` string, or ``None`` when the document is
        not a mapping or declares no 1.x marker. A document that also carries an
        ``openapi``/``swagger`` marker is *not* treated as 1.x — those are the
        newer grammars, and their own markers win.
    """
    if not isinstance(document, Mapping):
        return None
    if isinstance(document.get("openapi"), str) or isinstance(document.get("swagger"), str):
        return None
    version = document.get("swaggerVersion")
    if isinstance(version, str) and version.strip():
        return version.strip()
    return None


def is_swagger12_document(document: Any) -> bool:
    """Whether a parsed document is a Swagger **1.2** resource listing or declaration.

    Args:
        document: A parsed document.

    Returns:
        ``True`` only for ``swaggerVersion: "1.2"``. Swagger 1.0/1.1 carry the same
        marker but a different grammar; :func:`project_swagger12` rejects them with
        ``FORMAT_VERSION_UNSUPPORTED`` rather than mis-reading them here.
    """
    version = swagger12_version(document)
    return version is not None and version.startswith(SWAGGER_12_VERSION)


def is_api_declaration(document: Mapping[str, Any]) -> bool:
    """Whether a 1.2 document is an *API declaration* (it carries operations).

    Args:
        document: A parsed 1.2 document.

    Returns:
        ``True`` when any ``apis[]`` entry declares ``operations`` — the one
        structural difference between a declaration and a resource listing, whose
        ``apis[]`` entries carry only a ``path`` pointing at a declaration.
    """
    for api in _sequence(document.get("apis")):
        if isinstance(api, Mapping) and isinstance(api.get("operations"), list):
            return True
    return False


def is_resource_listing(document: Mapping[str, Any]) -> bool:
    """Whether a 1.2 document is a *resource listing* rather than a declaration.

    Args:
        document: A parsed 1.2 document.

    Returns:
        ``True`` when the document declares no operations. An empty ``apis`` list
        reads as a listing (an empty declaration would be meaningless either way);
        :func:`project_swagger12` rejects both as semantically invalid.
    """
    return not is_api_declaration(document)


def declaration_resource(document: Mapping[str, Any]) -> Optional[str]:
    """The resource path a declaration serves (``/orders``), when it names one.

    Args:
        document: A parsed 1.2 API declaration.

    Returns:
        Its ``resourcePath``, trimmed, or ``None``.
    """
    resource = document.get("resourcePath")
    if isinstance(resource, str) and resource.strip():
        return resource.strip()
    return None


# ===========================================================================
# Projection
# ===========================================================================


@dataclass
class _Projection:
    """Mutable accumulator for a projection that may span several declarations."""

    paths: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    definitions: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    tags: List[Dict[str, Any]] = field(default_factory=list)
    security_definitions: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    limits: List[str] = field(default_factory=list)
    base: Optional[Tuple[List[str], str, str]] = None
    declarations: List[str] = field(default_factory=list)

    def note(self, message: str) -> None:
        """Record a capability limit once, preserving first-seen order."""
        if message not in self.limits:
            self.limits.append(message)


def project_swagger12(
    document: Mapping[str, Any],
    *,
    declarations: Sequence[Tuple[str, Mapping[str, Any]]] = (),
    source_label: Optional[str] = None,
) -> Swagger12ProjectedDocument:
    """Rewrite a Swagger 1.2 import as an equivalent Swagger 2.0 document.

    Accepts either shape the format admits:

    * a **bare API declaration** — projected on its own, with ``declarations``
      left empty (the common single-file upload);
    * a **resource listing** plus the declarations it names, supplied as
      ``(member path, parsed declaration)`` pairs — merged into one 2.0 document
      so the whole API imports as a single API, which is the FMT-3.6 contract.

    Args:
        document: The parsed root — a resource listing or an API declaration.
        declarations: The resource listing's declarations, as ``(path, document)``
            pairs in the order they should merge. Ignored when ``document`` is
            itself a declaration and the sequence is empty.
        source_label: Optional label used only to make error messages specific.

    Returns:
        The projected Swagger 2.0 document, carrying its
        :class:`Swagger12Provenance`.

    Raises:
        Swagger12Error: When the document is not Swagger 1.2
            (``FORMAT_VERSION_UNSUPPORTED`` for 1.0/1.1, which share the marker
            but not the grammar); when a resource listing names no resources or a
            declaration declares no operations (``INPUT_SEMANTIC_INVALID``); or
            when a resource listing's declarations were not supplied
            (``INPUT_REFERENCE_UNRESOLVED`` — the listing alone cannot be
            imported, so the upload has to include them).
    """
    where = f" ({source_label})" if source_label else ""
    version = swagger12_version(document)
    if version is None:
        raise Swagger12Error(
            f"Document{where} is not a Swagger 1.x description (no `swaggerVersion` marker).",
            code="FORMAT_MISMATCH",
        )
    if not version.startswith(SWAGGER_12_VERSION):
        raise Swagger12Error(
            f"Swagger {version} is not readable{where}; only Swagger 1.2 is supported "
            "below 2.0. Re-export the description as Swagger 1.2 or later.",
            code="FORMAT_VERSION_UNSUPPORTED",
        )

    listing: Optional[Mapping[str, Any]] = None
    members: List[Tuple[str, Mapping[str, Any]]] = []
    if is_resource_listing(document):
        listing = document
        members = [(path, decl) for path, decl in declarations]
        if not _sequence(document.get("apis")):
            raise Swagger12Error(
                f"The Swagger 1.2 resource listing{where} names no resources "
                "(`apis` is empty), so there is nothing to import.",
                code="INPUT_SEMANTIC_INVALID",
            )
        if not members:
            missing = ", ".join(_listed_resources(document)) or "its resources"
            raise Swagger12Error(
                f"The Swagger 1.2 resource listing{where} names {missing}, but no API "
                "declaration for them was provided. Upload the listing together with "
                "its declaration files (for example as an archive containing both).",
                code="INPUT_REFERENCE_UNRESOLVED",
            )
    else:
        members = [(source_label or "", document), *declarations]

    projection = _Projection()
    for path, declaration in members:
        _merge_declaration(projection, declaration, member=path)

    if not projection.paths:
        raise Swagger12Error(
            f"The Swagger 1.2 declaration{where} defines no operations, "
            "so there is nothing to import.",
            code="INPUT_SEMANTIC_INVALID",
        )

    root_for_meta = listing if listing is not None else members[0][1]
    # 1.2 lets the listing *and* each declaration declare authorizations; the listing's
    # are the API-wide ones, so they are merged first and a declaration cannot silently
    # redefine a scheme the listing already named.
    if listing is not None:
        _merge_authorizations(projection, listing)
    for _, declaration in members:
        _merge_authorizations(projection, declaration)
    if listing is not None:
        _merge_listing_tags(projection, listing)

    projected: Dict[str, Any] = {"swagger": _SWAGGER_20_VERSION}
    projected["info"] = _info(root_for_meta, members, source_label=source_label)
    if projection.base is not None:
        schemes, host, base_path = projection.base
        if schemes:
            projected["schemes"] = schemes
        if host:
            projected["host"] = host
        projected["basePath"] = base_path
    consumes = _media_types(root_for_meta.get("consumes")) or _first_media_types(
        members, "consumes"
    )
    produces = _media_types(root_for_meta.get("produces")) or _first_media_types(
        members, "produces"
    )
    if consumes:
        projected["consumes"] = consumes
    if produces:
        projected["produces"] = produces
    if projection.tags:
        projected["tags"] = projection.tags
    if projection.security_definitions:
        projected["securityDefinitions"] = projection.security_definitions
    projected["paths"] = projection.paths
    projected["definitions"] = projection.definitions

    provenance = Swagger12Provenance(
        source_version=version,
        api_version=_string(root_for_meta.get("apiVersion")),
        resource_listing=(source_label if listing is not None else None),
        declarations=tuple(projection.declarations),
        limits=tuple(projection.limits),
    )
    return Swagger12ProjectedDocument(projected, provenance)


# ---------------------------------------------------------------------------
# Declaration merge
# ---------------------------------------------------------------------------


def _merge_declaration(
    projection: _Projection,
    declaration: Mapping[str, Any],
    *,
    member: str,
) -> None:
    """Fold one API declaration's paths, models and authorizations into ``projection``.

    Args:
        projection: The accumulator being built.
        declaration: One parsed 1.2 API declaration.
        member: The declaration's member path, used in ledger messages.
    """
    if not isinstance(declaration, Mapping):
        return

    resource = declaration_resource(declaration) or member
    tag = _tag_name(resource)
    if tag:
        projection.declarations.append(resource)

    base = _split_base_path(declaration.get("basePath"))
    if base is not None:
        if projection.base is None:
            projection.base = base
        elif projection.base != base:
            projection.note(
                f"Declaration {member!r} declares a different basePath than the first "
                "declaration; Swagger 2.0 has one host/basePath pair, so the first wins."
            )

    declaration_consumes = _media_types(declaration.get("consumes"))
    declaration_produces = _media_types(declaration.get("produces"))

    for api in _sequence(declaration.get("apis")):
        if not isinstance(api, Mapping):
            continue
        path = _string(api.get("path"))
        if not path:
            continue
        path_item = projection.paths.setdefault(path, {})
        for operation in _sequence(api.get("operations")):
            if not isinstance(operation, Mapping):
                continue
            method = _string(operation.get("method"))
            if not method:
                continue
            method = method.lower()
            if method not in _HTTP_METHODS:
                projection.note(
                    f"Operation {operation.get('nickname') or path!r} declares method "
                    f"{method!r}, which Swagger 2.0 path items do not admit; it was skipped."
                )
                continue
            if method in path_item:
                projection.note(
                    f"More than one declaration defines {method.upper()} {path}; "
                    "the first one wins."
                )
                continue
            path_item[method] = _operation(
                operation,
                projection=projection,
                tag=tag,
                consumes=declaration_consumes,
                produces=declaration_produces,
            )

    _merge_models(projection, declaration.get("models"), member=member)


def _merge_models(
    projection: _Projection,
    models: Any,
    *,
    member: str,
) -> None:
    """Project a declaration's ``models`` block into ``definitions``.

    1.2 states inheritance on the *parent* (``subTypes`` plus ``discriminator``);
    2.0 states it on each *child* (``allOf`` naming the parent). The rewrite walks
    the parents first so every child knows which parent claimed it.

    Args:
        projection: The accumulator being built.
        models: The declaration's ``models`` mapping (anything else is ignored).
        member: The declaration's member path, used in ledger messages.
    """
    if not isinstance(models, Mapping):
        return

    parent_of: Dict[str, str] = {}
    for name, model in models.items():
        if not isinstance(model, Mapping):
            continue
        for sub in _sequence(model.get("subTypes")):
            if isinstance(sub, str) and sub.strip():
                parent_of[sub.strip()] = str(name)

    for name, model in models.items():
        if not isinstance(model, Mapping):
            continue
        key = str(name)
        schema = _model_schema(model)
        parent = parent_of.get(key)
        if parent is not None and parent != key:
            schema = {"allOf": [{"$ref": f"{_DEFINITIONS_REF_PREFIX}{parent}"}, schema]}
        if key in projection.definitions:
            if projection.definitions[key] != schema:
                projection.note(
                    f"Declaration {member!r} redefines model {key!r} with a different "
                    "shape; the first definition wins."
                )
            continue
        projection.definitions[key] = schema


def _model_schema(model: Mapping[str, Any]) -> Dict[str, Any]:
    """Rewrite one 1.2 model as a 2.0 schema object.

    Args:
        model: The 1.2 model definition.

    Returns:
        The schema object, with ``id``/``subTypes`` dropped, ``$ref`` targets
        rewritten to ``#/definitions/…`` and stringly-typed numeric bounds coerced.
    """
    schema: Dict[str, Any] = {}
    for key, value in model.items():
        if key in _MODEL_ONLY_KEYS:
            continue
        if key == "properties" and isinstance(value, Mapping):
            schema["properties"] = {
                str(prop): _property_schema(spec) for prop, spec in value.items()
            }
            continue
        schema[str(key)] = _schema_value(value)
    return schema


def _property_schema(spec: Any) -> Dict[str, Any]:
    """Rewrite one 1.2 model property as a 2.0 schema object."""
    if not isinstance(spec, Mapping):
        return {}
    return _coerce_numeric_keywords(_schema_value(spec))


def _schema_value(value: Any) -> Any:
    """Rewrite ``$ref`` targets inside an arbitrary schema fragment.

    1.2 references a model by bare name (``{"$ref": "Order"}``); 2.0 references it
    by JSON pointer. Anything already pointer-shaped is left alone, and a bare
    ``type`` naming a model becomes a ``$ref`` so the coercer resolves it.

    Args:
        value: Any schema fragment (mapping, list, or scalar).

    Returns:
        The fragment with model references rewritten.
    """
    if isinstance(value, Mapping):
        result: Dict[str, Any] = {}
        for key, item in value.items():
            if key == "$ref" and isinstance(item, str) and item.strip():
                result["$ref"] = _model_ref(item)
                continue
            if key == "type" and isinstance(item, str) and _names_model(item):
                result["$ref"] = _model_ref(item)
                continue
            result[str(key)] = _schema_value(item)
        return result
    if isinstance(value, list):
        return [_schema_value(item) for item in value]
    return value


def _names_model(type_name: str) -> bool:
    """Whether a 1.2 ``type`` value names a model rather than a primitive."""
    name = type_name.strip()
    return bool(name) and name.lower() not in _PRIMITIVE_TYPES and name.lower() != "void"


def _model_ref(name: str) -> str:
    """The ``#/definitions/`` pointer for a bare 1.2 model name."""
    trimmed = name.strip()
    if trimmed.startswith("#/"):
        return trimmed
    return f"{_DEFINITIONS_REF_PREFIX}{trimmed}"


def _coerce_numeric_keywords(schema: Dict[str, Any]) -> Dict[str, Any]:
    """Coerce 1.2's stringly-typed ``minimum``/``maximum`` into numbers.

    Swagger 1.2 spells bounds as strings (``"minimum": "1"``) even for numeric
    types; 2.0 and JSON Schema require numbers, and the canonical constraint
    coercion reads them as numbers.

    Args:
        schema: A projected schema object (mutated in place and returned).

    Returns:
        The same mapping with numeric-looking bounds converted.
    """
    for keyword in _NUMERIC_KEYWORDS:
        value = schema.get(keyword)
        if isinstance(value, str):
            number = _as_number(value)
            if number is not None:
                schema[keyword] = number
    return schema


def _as_number(value: str) -> Optional[Any]:
    """Parse a numeric string into an ``int``/``float``, or ``None`` when it is not one."""
    text = value.strip()
    if not text:
        return None
    try:
        return int(text)
    except ValueError:
        pass
    try:
        return float(text)
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# Operations
# ---------------------------------------------------------------------------


def _operation(
    operation: Mapping[str, Any],
    *,
    projection: _Projection,
    tag: Optional[str],
    consumes: List[str],
    produces: List[str],
) -> Dict[str, Any]:
    """Rewrite one 1.2 operation as a 2.0 operation object.

    Args:
        operation: The 1.2 operation.
        projection: The accumulator, for capability-limit notes.
        tag: The resource tag every operation of this declaration carries, so the
            canonical model groups one Service per 1.2 resource.
        consumes: The declaration's ``consumes``, used when the operation has none.
        produces: The declaration's ``produces``, used when the operation has none.

    Returns:
        The 2.0 operation object.
    """
    result: Dict[str, Any] = {}
    nickname = _string(operation.get("nickname"))
    if nickname:
        result["operationId"] = nickname
    summary = _string(operation.get("summary"))
    if summary:
        result["summary"] = summary
    notes = _string(operation.get("notes"))
    if notes:
        result["description"] = notes
    if _as_bool(operation.get("deprecated")):
        result["deprecated"] = True
    if tag:
        result["tags"] = [tag]

    own_consumes = _media_types(operation.get("consumes")) or consumes
    own_produces = _media_types(operation.get("produces")) or produces
    parameters = [
        _parameter(parameter, projection=projection)
        for parameter in _sequence(operation.get("parameters"))
        if isinstance(parameter, Mapping)
    ]
    parameters = [parameter for parameter in parameters if parameter]
    if parameters:
        result["parameters"] = parameters
        if any(parameter.get("in") == "formData" for parameter in parameters):
            has_file = any(parameter.get("type") == "file" for parameter in parameters)
            own_consumes = (
                ["multipart/form-data"]
                if has_file
                else (own_consumes or ["application/x-www-form-urlencoded"])
            )
    if own_consumes:
        result["consumes"] = own_consumes
    if own_produces:
        result["produces"] = own_produces

    result["responses"] = _responses(operation)
    security = _operation_security(operation)
    if security is not None:
        result["security"] = security
    return result


def _parameter(
    parameter: Mapping[str, Any],
    *,
    projection: _Projection,
) -> Dict[str, Any]:
    """Rewrite one 1.2 parameter as a 2.0 parameter object.

    Args:
        parameter: The 1.2 parameter.
        projection: The accumulator, for capability-limit notes.

    Returns:
        The 2.0 parameter object, or an empty mapping when the parameter names
        neither a location nor a name (2.0 requires both).
    """
    name = _string(parameter.get("name"))
    location = _PARAM_TYPES.get((_string(parameter.get("paramType")) or "").lower())
    if not name or location is None:
        return {}

    result: Dict[str, Any] = {"name": name, "in": location}
    description = _string(parameter.get("description"))
    if description:
        result["description"] = description
    required = _as_bool(parameter.get("required")) or location == "path"
    result["required"] = required

    type_name = _string(parameter.get("type")) or ""
    if location == "body":
        result["schema"] = _body_schema(parameter, type_name)
        return result

    if _names_model(type_name) and type_name.lower() != "file":
        projection.note(
            f"Parameter {name!r} is typed as model {type_name!r} outside a body; "
            "Swagger 2.0 admits only primitives there, so it was read as a string."
        )
        result["type"] = "string"
    elif type_name.lower() == "file":
        result["type"] = "file"
    elif type_name:
        result["type"] = type_name

    for key in ("format", "enum", "uniqueItems", "pattern", "minLength", "maxLength"):
        if key in parameter:
            result[key] = _schema_value(parameter[key])
    items = parameter.get("items")
    if isinstance(items, Mapping):
        result["items"] = _schema_value(items)
    for keyword in _NUMERIC_KEYWORDS:
        if keyword in parameter:
            value = parameter[keyword]
            number = _as_number(value) if isinstance(value, str) else value
            if number is not None:
                result[keyword] = number
    default = parameter.get("defaultValue")
    if default is not None:
        result["default"] = _coerce_default(default, result.get("type"))
    if _as_bool(parameter.get("allowMultiple")):
        if result.get("type") != "array":
            result["items"] = {"type": result.get("type") or "string"}
            result["type"] = "array"
        result["collectionFormat"] = "multi"
    return result


def _body_schema(parameter: Mapping[str, Any], type_name: str) -> Dict[str, Any]:
    """The ``schema`` a 1.2 body parameter projects onto.

    Args:
        parameter: The 1.2 body parameter.
        type_name: Its declared ``type``.

    Returns:
        A 2.0 schema object — a model reference, an array of them, or a primitive.
    """
    ref = parameter.get("$ref")
    if isinstance(ref, str) and ref.strip():
        return {"$ref": _model_ref(ref)}
    if type_name.lower() == "array":
        items = parameter.get("items")
        return {
            "type": "array",
            "items": _schema_value(items) if isinstance(items, Mapping) else {},
        }
    if _names_model(type_name):
        return {"$ref": _model_ref(type_name)}
    if type_name:
        schema: Dict[str, Any] = {"type": type_name}
        fmt = _string(parameter.get("format"))
        if fmt:
            schema["format"] = fmt
        return schema
    return {}


def _responses(operation: Mapping[str, Any]) -> Dict[str, Any]:
    """Build a 2.0 ``responses`` object from a 1.2 operation.

    1.2 splits the response across two places: the operation's own ``type``
    (the *success* payload) and ``responseMessages[]`` (every documented status,
    each optionally naming a ``responseModel``). The projection joins them —
    the success schema lands on the first documented 2xx that names no model, or
    on a synthesized success entry when the operation documents none.

    Args:
        operation: The 1.2 operation.

    Returns:
        The 2.0 ``responses`` object, always with at least one entry.
    """
    type_name = _string(operation.get("type")) or ""
    success_schema = _success_schema(operation, type_name)

    responses: Dict[str, Any] = {}
    successes: List[str] = []
    for message in _sequence(operation.get("responseMessages")):
        if not isinstance(message, Mapping):
            continue
        code = message.get("code")
        status = str(code).strip() if code is not None else ""
        if not status:
            continue
        entry: Dict[str, Any] = {"description": _string(message.get("message")) or status}
        model = _string(message.get("responseModel"))
        if model:
            entry["schema"] = {"$ref": _model_ref(model)}
        responses[status] = entry
        if status.startswith("2"):
            successes.append(status)

    if success_schema is not None:
        target = next(
            (status for status in successes if "schema" not in responses[status]), None
        )
        if target is not None:
            responses[target]["schema"] = success_schema
        elif not successes:
            responses["200"] = {
                "description": "Successful response",
                "schema": success_schema,
            }
    elif not responses:
        status = "204" if type_name.lower() == "void" else "200"
        responses[status] = {"description": "Successful response"}
    return responses


def _success_schema(operation: Mapping[str, Any], type_name: str) -> Optional[Dict[str, Any]]:
    """The schema an operation's own ``type``/``items`` describes, when it has one.

    Args:
        operation: The 1.2 operation.
        type_name: Its declared ``type``.

    Returns:
        The 2.0 schema object, or ``None`` for ``void`` and untyped operations.
    """
    if not type_name or type_name.lower() == "void":
        return None
    if type_name.lower() == "array":
        items = operation.get("items")
        return {
            "type": "array",
            "items": _schema_value(items) if isinstance(items, Mapping) else {},
        }
    if _names_model(type_name):
        return {"$ref": _model_ref(type_name)}
    schema: Dict[str, Any] = {"type": type_name}
    fmt = _string(operation.get("format"))
    if fmt:
        schema["format"] = fmt
    return schema


# ---------------------------------------------------------------------------
# Authorizations
# ---------------------------------------------------------------------------


def _merge_authorizations(projection: _Projection, document: Mapping[str, Any]) -> None:
    """Project a 1.2 ``authorizations`` block into 2.0 ``securityDefinitions``.

    Args:
        projection: The accumulator being built.
        document: The resource listing (or the lone declaration) that declares them.
    """
    authorizations = document.get("authorizations")
    if not isinstance(authorizations, Mapping):
        return
    for name, definition in authorizations.items():
        if not isinstance(definition, Mapping):
            continue
        key = str(name)
        if key in projection.security_definitions:
            continue
        kind = (_string(definition.get("type")) or "").lower()
        if kind == "apikey":
            projection.security_definitions[key] = {
                "type": "apiKey",
                "name": _string(definition.get("keyname")) or key,
                "in": (_string(definition.get("passAs")) or "header").lower(),
            }
            continue
        if kind == "basicauth":
            projection.security_definitions[key] = {"type": "basic"}
            continue
        if kind == "oauth2":
            _merge_oauth2(projection, key, definition)
            continue
        projection.note(
            f"Authorization {key!r} declares type {kind or 'unknown'!r}, which Swagger 2.0 "
            "has no security scheme for; it was not projected."
        )


#: 1.2 OAuth2 grant type → the 2.0 ``flow`` name and the endpoint key it reads.
_OAUTH2_GRANTS: Tuple[Tuple[str, str, str], ...] = (
    ("implicit", "implicit", "loginEndpoint"),
    ("authorization_code", "accessCode", "tokenRequestEndpoint"),
    ("password", "password", "tokenEndpoint"),
    ("client_credentials", "application", "tokenEndpoint"),
)


def _merge_oauth2(
    projection: _Projection,
    key: str,
    definition: Mapping[str, Any],
) -> None:
    """Project one 1.2 OAuth2 authorization into 2.0 security definitions.

    Swagger 2.0 allows exactly one ``flow`` per security definition, while 1.2
    declares every grant type a single authorization supports. The first grant
    keeps the authorization's own name (so per-operation references still
    resolve); each additional grant becomes ``<name>_<flow>`` and is recorded on
    the capability ledger.

    Args:
        projection: The accumulator being built.
        key: The authorization's 1.2 name.
        definition: Its 1.2 definition.
    """
    scopes: Dict[str, str] = {}
    for scope in _sequence(definition.get("scopes")):
        if isinstance(scope, Mapping):
            name = _string(scope.get("scope"))
            if name:
                scopes[name] = _string(scope.get("description")) or ""
        elif isinstance(scope, str) and scope.strip():
            scopes[scope.strip()] = ""

    grant_types = definition.get("grantTypes")
    grants = grant_types if isinstance(grant_types, Mapping) else {}
    projected = 0
    for grant_name, flow, endpoint_key in _OAUTH2_GRANTS:
        grant = grants.get(grant_name)
        if not isinstance(grant, Mapping):
            continue
        entry: Dict[str, Any] = {"type": "oauth2", "flow": flow, "scopes": dict(scopes)}
        authorization_url = _endpoint_url(grant.get(endpoint_key))
        token_url = _endpoint_url(grant.get("tokenEndpoint"))
        if flow in ("implicit", "accessCode") and authorization_url:
            entry["authorizationUrl"] = authorization_url
        if flow != "implicit" and token_url:
            entry["tokenUrl"] = token_url
        name = key if projected == 0 else f"{key}_{flow}"
        if projected:
            projection.note(
                f"Authorization {key!r} declares more than one OAuth2 grant type; "
                f"Swagger 2.0 allows one flow per definition, so {grant_name!r} was "
                f"projected as the separate definition {name!r}."
            )
        projection.security_definitions[name] = entry
        projected += 1

    if projected == 0:
        projection.security_definitions[key] = {
            "type": "oauth2",
            "flow": "implicit",
            "scopes": dict(scopes),
        }


def _endpoint_url(endpoint: Any) -> Optional[str]:
    """The ``url`` of a 1.2 OAuth2 endpoint object, when it declares one."""
    if isinstance(endpoint, Mapping):
        return _string(endpoint.get("url"))
    if isinstance(endpoint, str):
        return _string(endpoint)
    return None


def _operation_security(operation: Mapping[str, Any]) -> Optional[List[Dict[str, List[str]]]]:
    """Project a 1.2 operation's ``authorizations`` into a 2.0 ``security`` array.

    Args:
        operation: The 1.2 operation.

    Returns:
        The ``security`` array, or ``None`` when the operation declares none.
    """
    authorizations = operation.get("authorizations")
    if not isinstance(authorizations, Mapping) or not authorizations:
        return None
    requirement: Dict[str, List[str]] = {}
    for name, scopes in authorizations.items():
        selected: List[str] = []
        for scope in _sequence(scopes):
            if isinstance(scope, Mapping):
                value = _string(scope.get("scope"))
                if value:
                    selected.append(value)
            elif isinstance(scope, str) and scope.strip():
                selected.append(scope.strip())
        requirement[str(name)] = selected
    return [requirement]


# ---------------------------------------------------------------------------
# Document metadata
# ---------------------------------------------------------------------------


def _info(
    document: Mapping[str, Any],
    members: Sequence[Tuple[str, Mapping[str, Any]]],
    *,
    source_label: Optional[str],
) -> Dict[str, Any]:
    """Build the 2.0 ``info`` block from a 1.2 listing/declaration.

    Args:
        document: The resource listing, or the lone declaration.
        members: Every declaration being merged, used to fall back on a title.
        source_label: The upload's label, the last fallback for a title.

    Returns:
        The 2.0 ``info`` object; ``title`` and ``version`` are always present
        because 2.0 requires them.
    """
    info = document.get("info") if isinstance(document.get("info"), Mapping) else {}
    title = _string(info.get("title"))
    if not title:
        resource = next(
            (declaration_resource(decl) for _, decl in members if declaration_resource(decl)),
            None,
        )
        title = _title_from(resource) or _title_from(source_label) or "Untitled API"

    result: Dict[str, Any] = {
        "title": title,
        "version": _string(document.get("apiVersion")) or "1.0.0",
    }
    description = _string(info.get("description"))
    if description:
        result["description"] = description
    terms = _string(info.get("termsOfServiceUrl"))
    if terms:
        result["termsOfService"] = terms
    contact = info.get("contact")
    if isinstance(contact, str) and contact.strip():
        # 1.2 states a bare contact string; 2.0 wants a contact object, and every
        # 1.2 example in the wild puts an email address there.
        key = "email" if "@" in contact else "url" if "://" in contact else "name"
        result["contact"] = {key: contact.strip()}
    elif isinstance(contact, Mapping):
        result["contact"] = dict(contact)
    license_name = _string(info.get("license"))
    license_url = _string(info.get("licenseUrl"))
    if license_name or license_url:
        license_block: Dict[str, Any] = {"name": license_name or "See licence URL"}
        if license_url:
            license_block["url"] = license_url
        result["license"] = license_block
    return result


def _merge_listing_tags(projection: _Projection, listing: Mapping[str, Any]) -> None:
    """Carry a resource listing's per-resource descriptions onto 2.0 tags.

    Args:
        projection: The accumulator being built.
        listing: The 1.2 resource listing.
    """
    described: Dict[str, str] = {}
    for api in _sequence(listing.get("apis")):
        if not isinstance(api, Mapping):
            continue
        tag = _tag_name(_string(api.get("path")) or "")
        description = _string(api.get("description"))
        if tag and description:
            described[tag] = description
    for tag in projection.declarations:
        name = _tag_name(tag)
        if not name:
            continue
        if any(existing.get("name") == name for existing in projection.tags):
            continue
        entry: Dict[str, Any] = {"name": name}
        if name in described:
            entry["description"] = described[name]
        projection.tags.append(entry)


def _listed_resources(listing: Mapping[str, Any]) -> List[str]:
    """The resource paths a resource listing names, for an error message."""
    return [
        path
        for api in _sequence(listing.get("apis"))
        if isinstance(api, Mapping)
        for path in [_string(api.get("path"))]
        if path
    ]


def _split_base_path(value: Any) -> Optional[Tuple[List[str], str, str]]:
    """Split a 1.2 ``basePath`` into 2.0 ``schemes``/``host``/``basePath``.

    Args:
        value: The declaration's ``basePath`` — an absolute URL in practice, but
            a bare path is tolerated.

    Returns:
        ``(schemes, host, basePath)``, or ``None`` when there is nothing to split.
        ``schemes`` and ``host`` are empty for a relative base path, which leaves
        the 2.0 defaults in place.
    """
    base = _string(value)
    if not base:
        return None
    if "://" not in base:
        return ([], "", base if base.startswith("/") else f"/{base}")
    parts = urlsplit(base)
    path = parts.path or "/"
    if len(path) > 1:
        path = path.rstrip("/") or "/"
    return ([parts.scheme] if parts.scheme else [], parts.netloc, path)


def _tag_name(resource: str) -> Optional[str]:
    """The tag (and therefore canonical Service) name for a 1.2 resource path.

    Args:
        resource: A ``resourcePath`` such as ``/orders`` or a member filename.

    Returns:
        A slug such as ``orders``, or ``None`` when nothing usable remains.
    """
    cleaned = re.sub(r"\.[A-Za-z0-9]+$", "", resource.strip())
    cleaned = cleaned.strip("/")
    cleaned = re.sub(r"[^A-Za-z0-9]+", "-", cleaned).strip("-")
    return cleaned or None


def _title_from(value: Optional[str]) -> Optional[str]:
    """A human-ish title derived from a resource path or filename."""
    tag = _tag_name(value or "") if value else None
    if not tag:
        return None
    return tag.replace("-", " ").strip().title()


# ---------------------------------------------------------------------------
# Small shared helpers
# ---------------------------------------------------------------------------


def _sequence(value: Any) -> List[Any]:
    """``value`` when it is a list, else an empty list."""
    return list(value) if isinstance(value, list) else []


def _string(value: Any) -> Optional[str]:
    """``value`` trimmed when it is a non-empty string, else ``None``."""
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _as_bool(value: Any) -> bool:
    """Read a 1.2 boolean, which JSON exports sometimes spell as a string."""
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() == "true"
    return False


def _coerce_default(value: Any, type_name: Optional[str]) -> Any:
    """Coerce a 1.2 ``defaultValue`` (always a string) to its declared type.

    Args:
        value: The declared default.
        type_name: The parameter's projected ``type``.

    Returns:
        The default as an ``int``/``float``/``bool`` when the type says so and the
        text parses, else the value unchanged.
    """
    if not isinstance(value, str):
        return value
    if type_name in ("integer", "number"):
        number = _as_number(value)
        return number if number is not None else value
    if type_name == "boolean":
        lowered = value.strip().lower()
        if lowered in ("true", "false"):
            return lowered == "true"
    return value


def _media_types(value: Any) -> List[str]:
    """The string entries of a 1.2 ``consumes``/``produces`` list."""
    return [item.strip() for item in _sequence(value) if isinstance(item, str) and item.strip()]


def _first_media_types(
    members: Sequence[Tuple[str, Mapping[str, Any]]],
    key: str,
) -> List[str]:
    """The first non-empty ``consumes``/``produces`` across merged declarations."""
    for _, declaration in members:
        types = _media_types(declaration.get(key))
        if types:
            return types
    return []
