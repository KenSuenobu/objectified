"""Author-time projection of correlation over the spec, for the ADE editor (#5529, MSC-1.3).

Correlation is configuration a version owner sets once and then trusts. Trusting it means being
able to see, *before* saving, which response properties inference decided to bind and to what —
which is what this module produces. It walks the version's generated OpenAPI document and answers,
per operation:

* what an author can put in a ``{{request.*}}`` expression — the operation's own path, query and
  header parameters, and its request-body fields;
* where an explicit binding can point — the JSON Pointers the success response body actually has;
* what the ``path-params`` and ``inferred`` passes would bind if the version switched to them.

The name-matching rules are *not* re-implemented: they come from
:mod:`app.mock_correlation_rules`, the module :mod:`apiome_mock.correlation` applies at serve time.
The difference is only what they are applied to — a response **schema** here, a materialized
response body there — so a preview cannot promise a binding the runtime declines to make.

Two honest limits the preview inherits from working on the schema rather than a body:

* the runtime binds inside *every* array member; a pointer here names member ``0`` and is flagged
  ``repeated``, because a schema has no members to enumerate;
* a ``oneOf``/``anyOf`` schema has no single shape, so the first branch is projected. The runtime
  binds whichever branch synthesis actually produced.

Both are reported to the caller rather than hidden, and neither can invent a binding: every
pointer listed corresponds to a property the schema declares.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence, Set, Tuple

from .mock_correlation_rules import (
    ECHOED_METHODS,
    SERVER_OWNED_FIELDS,
    normalize_property_name,
    path_parameter_aliases,
)
from .mock_routing import MockOperation, extract_operations

__all__ = [
    "MAX_BINDING_DEPTH",
    "MAX_POINTERS_PER_OPERATION",
    "OperationBinding",
    "OperationCatalogue",
    "OperationParameter",
    "ResponsePointer",
    "build_operation_catalogue",
    "catalogue_payload",
    "fixture_names",
]

MAX_BINDING_DEPTH = 6
"""How deep the response-schema walk descends.

Deep enough for the envelope-plus-resource shapes correlation is for, shallow enough that a
recursive schema (``Node.children: Node[]``) cannot produce an unbounded pointer list.
"""

MAX_POINTERS_PER_OPERATION = 200
"""Cap on the pointers listed for one operation, so a very wide schema stays a usable picker."""

#: Parameter locations the editor offers as ``{{request.*}}`` roots, in the spelling the template
#: language uses (``in: path`` -> ``request.path.<name>``).
_TEMPLATE_LOCATIONS = ("path", "query", "header")


@dataclass(frozen=True)
class OperationParameter:
    """One request parameter an author can reference from a template expression.

    Attributes:
        name: The parameter name as the spec declares it.
        location: ``"path"``, ``"query"`` or ``"header"``.
        required: Whether the spec marks it required.
        type: The declared JSON type, when the schema states one.
        token: The ready-to-insert template expression (``{{request.path.petId}}``).
    """

    name: str
    location: str
    required: bool = False
    type: Optional[str] = None
    token: str = ""


@dataclass(frozen=True)
class ResponsePointer:
    """One JSON Pointer into the operation's success response body.

    Attributes:
        pointer: RFC 6901 pointer (``/owner/id``).
        type: The declared JSON type at that pointer, when the schema states one.
        repeated: True when the pointer passes through an array — the runtime binds every member,
            while the pointer can only name one.
    """

    pointer: str
    type: Optional[str] = None
    repeated: bool = False


@dataclass(frozen=True)
class OperationBinding:
    """One binding an inference pass would make, as the editor lists it.

    Attributes:
        pointer: Where in the response body the value lands.
        source: The request value it takes, written as the template expression that would produce
            the same result (``{{request.path.petId}}``) — so an author who wants to pin the
            binding explicitly can read the expression straight off the preview.
        pass_name: Which pass makes it: ``"path-params"`` or ``"inferred"``.
        repeated: True when the pointer passes through an array (every member binds).
    """

    pointer: str
    source: str
    pass_name: str
    repeated: bool = False


@dataclass(frozen=True)
class OperationCatalogue:
    """Everything the correlation editor needs about one operation.

    Attributes:
        key: Canonical ``"METHOD /template"`` identifier — the key the ``operations`` map uses.
        method: Upper-case HTTP method.
        path: The path template.
        summary: The operation's ``summary``, or its ``operationId``, or ``""``.
        parameters: Path, query and header parameters, in that order.
        request_fields: Top-level request-body property names (write methods only).
        response_pointers: Pointers into the success response body.
        success_status: The status the mock's default path answers with.
        bindings: What ``path-params`` and ``inferred`` would bind, in pass order.
    """

    key: str
    method: str
    path: str
    summary: str = ""
    parameters: Tuple[OperationParameter, ...] = ()
    request_fields: Tuple[str, ...] = ()
    response_pointers: Tuple[ResponsePointer, ...] = ()
    success_status: int = 200
    bindings: Tuple[OperationBinding, ...] = ()


@dataclass
class _Walk:
    """Mutable state shared by one operation's schema walk (bounds and ref cycle guard)."""

    spec: Mapping[str, Any]
    seen_refs: Set[str] = field(default_factory=set)
    emitted: int = 0


def _resolve(node: Any, walk: _Walk) -> Optional[Dict[str, Any]]:
    """Resolve local ``$ref`` chains to a schema object, refusing to follow a cycle.

    Args:
        node: A schema, a ``$ref`` wrapper, or anything else.
        walk: The current walk, whose ``seen_refs`` guards against a self-referential schema.

    Returns:
        The resolved schema object, or ``None`` when ``node`` is not one (or the ref cycles).
    """
    current = node
    for _ in range(MAX_BINDING_DEPTH):
        if not isinstance(current, dict):
            return None
        ref = current.get("$ref")
        if not isinstance(ref, str) or not ref.startswith("#/"):
            return current
        if ref in walk.seen_refs:
            return None
        walk.seen_refs.add(ref)
        target: Any = walk.spec
        for segment in ref[2:].split("/"):
            segment = segment.replace("~1", "/").replace("~0", "~")
            if not isinstance(target, dict) or segment not in target:
                return None
            target = target[segment]
        current = target
    return None


def _flatten_schema(schema: Mapping[str, Any], walk: _Walk) -> Dict[str, Any]:
    """Collapse ``allOf`` (and the first ``oneOf``/``anyOf`` branch) into one schema object.

    ``allOf`` composition is merged because every branch applies at once. ``oneOf``/``anyOf`` has
    no single shape at author time, so the first branch is projected — the limit this module's
    docstring states.

    Args:
        schema: The schema to flatten.
        walk: The current walk (for ref resolution).

    Returns:
        A schema object with ``properties``/``items``/``type`` merged from the composition.
    """
    merged: Dict[str, Any] = {k: v for k, v in schema.items() if k not in ("allOf", "oneOf", "anyOf")}
    branches: List[Any] = []
    all_of = schema.get("allOf")
    if isinstance(all_of, list):
        branches.extend(all_of)
    for keyword in ("oneOf", "anyOf"):
        alternatives = schema.get(keyword)
        if isinstance(alternatives, list) and alternatives and not branches:
            branches.append(alternatives[0])
    for branch in branches:
        resolved = _resolve(branch, walk)
        if resolved is None:
            continue
        flattened = _flatten_schema(resolved, walk)
        for key, value in flattened.items():
            if key == "properties" and isinstance(value, dict):
                properties = merged.setdefault("properties", {})
                if isinstance(properties, dict):
                    for name, prop in value.items():
                        properties.setdefault(name, prop)
            elif key not in merged:
                merged[key] = value
    return merged


def _escape_token(name: str) -> str:
    """Escape one property name for use as a JSON Pointer segment (RFC 6901)."""
    return name.replace("~", "~0").replace("/", "~1")


def _schema_type(schema: Mapping[str, Any]) -> Optional[str]:
    """Read a schema's declared JSON type, tolerating the 3.1 list form."""
    declared = schema.get("type")
    if isinstance(declared, str):
        return declared
    if isinstance(declared, list):
        for entry in declared:
            if isinstance(entry, str) and entry != "null":
                return entry
    if isinstance(schema.get("properties"), dict):
        return "object"
    return None


def _collect_pointers(
    schema: Any,
    walk: _Walk,
    *,
    prefix: str = "",
    depth: int = 0,
    repeated: bool = False,
    out: Optional[List[ResponsePointer]] = None,
) -> List[ResponsePointer]:
    """List the JSON Pointers a response body of this schema would have.

    Args:
        schema: The schema at ``prefix``.
        walk: The current walk (ref cycle guard and emitted-pointer budget).
        prefix: The pointer built so far (``""`` is the whole body).
        depth: How many levels have been descended.
        repeated: Whether ``prefix`` passes through an array.
        out: Accumulator, created on the first call.

    Returns:
        The accumulated pointers, in document order.
    """
    pointers = out if out is not None else []
    if depth > MAX_BINDING_DEPTH or walk.emitted >= MAX_POINTERS_PER_OPERATION:
        return pointers
    resolved = _resolve(schema, walk)
    if resolved is None:
        return pointers
    flattened = _flatten_schema(resolved, walk)

    properties = flattened.get("properties")
    if isinstance(properties, dict):
        for name, child in properties.items():
            if walk.emitted >= MAX_POINTERS_PER_OPERATION:
                break
            child_schema = _resolve(child, walk) or {}
            child_pointer = f"{prefix}/{_escape_token(str(name))}"
            pointers.append(
                ResponsePointer(
                    pointer=child_pointer,
                    type=_schema_type(_flatten_schema(child_schema, walk)) if child_schema else None,
                    repeated=repeated,
                )
            )
            walk.emitted += 1
            _collect_pointers(
                child, walk, prefix=child_pointer, depth=depth + 1, repeated=repeated, out=pointers
            )
        return pointers

    items = flattened.get("items")
    if items is not None:
        _collect_pointers(items, walk, prefix=f"{prefix}/0", depth=depth + 1, repeated=True, out=pointers)
    return pointers


def _parameters(
    operation: MockOperation, spec: Mapping[str, Any], path_item: Mapping[str, Any]
) -> List[OperationParameter]:
    """Collect the operation's path/query/header parameters, path-level ones included.

    OpenAPI lets a path item declare parameters every one of its operations inherits; an author
    picking tokens needs both, and an operation-level entry with the same name and location
    overrides the inherited one.

    Args:
        operation: The operation being described.
        spec: The whole document (for ``$ref`` parameters).
        path_item: The path item the operation belongs to.

    Returns:
        Parameters ordered path, then query, then header.
    """
    walk = _Walk(spec=spec)
    collected: Dict[Tuple[str, str], OperationParameter] = {}
    declared: List[Any] = []
    for source in (path_item.get("parameters"), operation.operation.get("parameters")):
        if isinstance(source, list):
            declared.extend(source)
    for raw in declared:
        walk.seen_refs = set()
        parameter = _resolve(raw, walk)
        if not isinstance(parameter, dict):
            continue
        name = parameter.get("name")
        location = parameter.get("in")
        if not isinstance(name, str) or location not in _TEMPLATE_LOCATIONS:
            continue
        schema = _resolve(parameter.get("schema"), walk) or {}
        collected[(location, name)] = OperationParameter(
            name=name,
            location=location,
            required=bool(parameter.get("required")) or location == "path",
            type=_schema_type(schema) if schema else None,
            token=f"{{{{request.{location}.{name}}}}}",
        )
    order = {location: index for index, location in enumerate(_TEMPLATE_LOCATIONS)}
    return [collected[key] for key in sorted(collected, key=lambda key: (order[key[0]], key[1]))]


def _success_response_schema(
    operation: Mapping[str, Any], spec: Mapping[str, Any], walk: _Walk
) -> Tuple[int, Optional[Any]]:
    """Pick the response the mock's default path answers with, and its JSON schema.

    Mirrors ``apiome_mock.response_resolver.select_default_success_status``: the lowest 2xx, else
    ``default``, else the first declared response, else a bare 200.

    Args:
        operation: The raw operation object.
        spec: The whole document.
        walk: The current walk.

    Returns:
        ``(status, schema)``; ``schema`` is ``None`` when the response declares no JSON body.
    """
    responses = operation.get("responses")
    if not isinstance(responses, dict) or not responses:
        return 200, None
    codes = sorted(int(code) for code in responses if str(code).isdigit() and 200 <= int(code) < 300)
    if codes:
        status = codes[0]
        raw = responses.get(status, responses.get(str(status)))
    elif "default" in responses:
        status, raw = 200, responses.get("default")
    else:
        first = sorted(responses.keys(), key=str)[0]
        status = int(first) if str(first).isdigit() else 200
        raw = responses[first]
    response_obj = _resolve(raw, walk)
    if not isinstance(response_obj, dict):
        return status, None
    content = response_obj.get("content")
    if not isinstance(content, dict):
        return status, None
    for media_type, media_obj in content.items():
        if isinstance(media_type, str) and "json" in media_type.lower() and isinstance(media_obj, dict):
            return status, media_obj.get("schema")
    return status, None


def _request_body_schema(operation: Mapping[str, Any], walk: _Walk) -> Optional[Any]:
    """Return the operation's JSON request-body schema, or ``None`` when it has none."""
    request_body = _resolve(operation.get("requestBody"), walk)
    if not isinstance(request_body, dict):
        return None
    content = request_body.get("content")
    if not isinstance(content, dict):
        return None
    for media_type, media_obj in content.items():
        if isinstance(media_type, str) and "json" in media_type.lower() and isinstance(media_obj, dict):
            return media_obj.get("schema")
    return None


def _object_properties(schema: Any, walk: _Walk) -> Dict[str, Any]:
    """Return one schema's object properties, following refs and ``allOf`` (``{}`` when none)."""
    resolved = _resolve(schema, walk)
    if resolved is None:
        return {}
    flattened = _flatten_schema(resolved, walk)
    properties = flattened.get("properties")
    return properties if isinstance(properties, dict) else {}


def _path_param_bindings(
    schema: Any, walk: _Walk, aliases: Mapping[str, str], *, prefix: str = "", depth: int = 0, repeated: bool = False
) -> List[OperationBinding]:
    """Project the ``path-params`` pass over a response schema.

    Mirrors ``apiome_mock.correlation._bind_path_params``: a property whose normalized name matches
    a path parameter takes the request's value, at every depth and inside array members, but only
    when the property is a scalar — the runtime leaves objects and arrays alone.

    Args:
        schema: The schema at ``prefix``.
        walk: The current walk.
        aliases: Normalized property name to the path parameter that claims it.
        prefix: The pointer built so far.
        depth: How many levels have been descended.
        repeated: Whether ``prefix`` passes through an array.

    Returns:
        The bindings, in document order.
    """
    bindings: List[OperationBinding] = []
    if depth > MAX_BINDING_DEPTH:
        return bindings
    resolved = _resolve(schema, walk)
    if resolved is None:
        return bindings
    flattened = _flatten_schema(resolved, walk)

    properties = flattened.get("properties")
    if isinstance(properties, dict):
        for name, child in properties.items():
            child_pointer = f"{prefix}/{_escape_token(str(name))}"
            child_schema = _resolve(child, walk)
            child_type = _schema_type(_flatten_schema(child_schema, walk)) if child_schema else None
            parameter = aliases.get(normalize_property_name(str(name)))
            if parameter is not None and child_type not in ("object", "array"):
                bindings.append(
                    OperationBinding(
                        pointer=child_pointer,
                        source=f"{{{{request.path.{parameter}}}}}",
                        pass_name="path-params",
                        repeated=repeated,
                    )
                )
                continue
            bindings.extend(
                _path_param_bindings(
                    child, walk, aliases, prefix=child_pointer, depth=depth + 1, repeated=repeated
                )
            )
        return bindings

    items = flattened.get("items")
    if items is not None:
        bindings.extend(
            _path_param_bindings(items, walk, aliases, prefix=f"{prefix}/0", depth=depth + 1, repeated=True)
        )
    return bindings


def _echo_bindings(
    response_schema: Any,
    request_properties: Mapping[str, Any],
    request_prefix: str,
    walk: _Walk,
    *,
    prefix: str = "",
    depth: int = 0,
    repeated: bool = False,
) -> List[OperationBinding]:
    """Project the ``inferred`` request-body echo over a response schema.

    Mirrors ``apiome_mock.correlation._echo_request_body``, including its envelope rule: a response
    object that matches *nothing* in the request body is treated as a wrapper and the same request
    level is offered to its children, but once a level has matched at least one field its unmatched
    siblings are left alone rather than searched again.

    Args:
        response_schema: The response schema at ``prefix``.
        request_properties: The request-body properties aligned with this response level.
        request_prefix: The pointer into the request body those properties sit at.
        walk: The current walk.
        prefix: The response pointer built so far.
        depth: How many levels have been descended.
        repeated: Whether ``prefix`` passes through an array.

    Returns:
        The bindings, in document order.
    """
    bindings: List[OperationBinding] = []
    if depth > MAX_BINDING_DEPTH or not request_properties:
        return bindings
    resolved = _resolve(response_schema, walk)
    if resolved is None:
        return bindings
    flattened = _flatten_schema(resolved, walk)

    properties = flattened.get("properties")
    if isinstance(properties, dict):
        by_normalized = {
            normalize_property_name(str(name)): (str(name), value)
            for name, value in request_properties.items()
        }
        matched: Dict[str, Tuple[str, Any]] = {}
        for name in properties:
            normalized = normalize_property_name(str(name))
            if normalized in SERVER_OWNED_FIELDS:
                continue
            candidate = by_normalized.get(normalized)
            if candidate is not None:
                matched[str(name)] = candidate
        for name, child in properties.items():
            child_pointer = f"{prefix}/{_escape_token(str(name))}"
            if str(name) in matched:
                request_name, request_schema = matched[str(name)]
                request_pointer = f"{request_prefix}/{_escape_token(request_name)}"
                child_properties = _object_properties(child, walk)
                if child_properties and _object_properties(request_schema, walk):
                    bindings.extend(
                        _echo_bindings(
                            child,
                            _object_properties(request_schema, walk),
                            request_pointer,
                            walk,
                            prefix=child_pointer,
                            depth=depth + 1,
                            repeated=repeated,
                        )
                    )
                else:
                    bindings.append(
                        OperationBinding(
                            pointer=child_pointer,
                            source=f"{{{{request.body#{request_pointer}}}}}",
                            pass_name="inferred",
                            repeated=repeated,
                        )
                    )
                continue
            if not matched:
                bindings.extend(
                    _echo_bindings(
                        child,
                        request_properties,
                        request_prefix,
                        walk,
                        prefix=child_pointer,
                        depth=depth + 1,
                        repeated=repeated,
                    )
                )
        return bindings

    items = flattened.get("items")
    if items is not None:
        bindings.extend(
            _echo_bindings(
                items,
                request_properties,
                request_prefix,
                walk,
                prefix=f"{prefix}/0",
                depth=depth + 1,
                repeated=True,
            )
        )
    return bindings


def _path_parameter_names(path_template: str, parameters: Sequence[OperationParameter]) -> Dict[str, str]:
    """Order the operation's path parameters the way routing extracts them.

    ``path_parameter_aliases`` gives the *last* ``…Id`` parameter the bare ``id`` alias, so the
    order matters: it has to be template order, not the order the spec happens to declare the
    parameter objects in.

    Args:
        path_template: The operation's path template.
        parameters: The operation's declared parameters.

    Returns:
        ``{parameter name: parameter name}`` in template order — the shape
        :func:`path_parameter_aliases` consumes, with the name standing in for the request value so
        the resulting aliases map a normalized property name to the parameter that claims it.
    """
    declared = {parameter.name for parameter in parameters if parameter.location == "path"}
    ordered: Dict[str, str] = {}
    for segment in path_template.split("/"):
        if segment.startswith("{") and segment.endswith("}"):
            name = segment[1:-1]
            if name in declared or not declared:
                ordered[name] = name
    for name in sorted(declared - set(ordered)):
        ordered[name] = name
    return ordered


def _describe(operation: MockOperation, spec: Mapping[str, Any], path_item: Mapping[str, Any]) -> OperationCatalogue:
    """Build one operation's catalogue entry.

    Args:
        operation: The flattened operation.
        spec: The version's generated OpenAPI document.
        path_item: The path item the operation belongs to.

    Returns:
        The entry the editor renders.
    """
    walk = _Walk(spec=spec)
    parameters = _parameters(operation, spec, path_item)
    status, response_schema = _success_response_schema(operation.operation, spec, _Walk(spec=spec))
    pointers = tuple(_collect_pointers(response_schema, walk)) if response_schema is not None else ()

    request_schema = _request_body_schema(operation.operation, _Walk(spec=spec))
    request_properties = _object_properties(request_schema, _Walk(spec=spec)) if request_schema is not None else {}

    bindings: List[OperationBinding] = []
    if response_schema is not None:
        aliases = path_parameter_aliases(_path_parameter_names(operation.path_template, parameters))
        bindings.extend(_path_param_bindings(response_schema, _Walk(spec=spec), aliases))
        if operation.method in ECHOED_METHODS and request_properties:
            bound = {binding.pointer for binding in bindings}
            bindings.extend(
                binding
                for binding in _echo_bindings(response_schema, request_properties, "", _Walk(spec=spec))
                if binding.pointer not in bound
            )

    summary = operation.operation.get("summary") or operation.operation.get("operationId") or ""
    return OperationCatalogue(
        key=operation.key,
        method=operation.method,
        path=operation.path_template,
        summary=str(summary),
        parameters=tuple(parameters),
        request_fields=tuple(str(name) for name in request_properties),
        response_pointers=pointers,
        success_status=status,
        bindings=tuple(bindings),
    )


def build_operation_catalogue(spec: Mapping[str, Any]) -> List[OperationCatalogue]:
    """Describe every operation in one spec for the correlation and scenario editors.

    Args:
        spec: The version's generated OpenAPI document.

    Returns:
        One entry per operation, in document order.
    """
    document = dict(spec)
    paths = document.get("paths")
    path_items: Dict[str, Mapping[str, Any]] = {}
    if isinstance(paths, dict):
        for template, path_item in paths.items():
            if isinstance(path_item, dict):
                path_items[str(template)] = path_item
    return [
        _describe(operation, document, path_items.get(operation.path_template, {}))
        for operation in extract_operations(document)
    ]


def fixture_names(mock_settings: Any) -> List[str]:
    """List the fixture names ``{{fixture.<name>}}`` can read on this version.

    Fixture data comes from the version's packs, merged in sorted pack-name order exactly as
    ``apiome_mock.fixture_packs.merged_template_data`` merges them, so what the editor offers is
    what a template would actually resolve.

    Args:
        mock_settings: The raw ``versions.mock_settings`` value (a mapping, JSON text, or ``None``).

    Returns:
        The available fixture names, sorted; empty when the value is unusable.
    """
    settings: Any = mock_settings
    if isinstance(settings, str):
        try:
            settings = json.loads(settings)
        except json.JSONDecodeError:
            return []
    if not isinstance(settings, Mapping):
        return []
    packs = settings.get("fixturePacks")
    if not isinstance(packs, Mapping):
        return []
    names: Set[str] = set()
    for pack in packs.values():
        if not isinstance(pack, Mapping):
            continue
        data = pack.get("data")
        if isinstance(data, Mapping):
            names.update(str(name) for name in data)
    return sorted(names)


def catalogue_payload(spec: Mapping[str, Any], mock_settings: Any) -> Dict[str, Any]:
    """Build the whole catalogue in the camelCase wire shape the editors read.

    The dataclasses above are the readable form; this is the one that crosses the wire.
    ``pass`` is a Python keyword, so the binding's field is ``pass_name`` here and ``pass`` there —
    the one place the two spellings meet.

    Args:
        spec: The version's generated OpenAPI document.
        mock_settings: The raw ``versions.mock_settings`` value, for the fixture names.

    Returns:
        ``{"operations": [...], "fixtures": [...]}``, ready for
        :class:`app.models.VersionMockOperationsResponse`.
    """
    return {
        "operations": [
            {
                "key": entry.key,
                "method": entry.method,
                "path": entry.path,
                "summary": entry.summary,
                "parameters": [
                    {
                        "name": parameter.name,
                        "location": parameter.location,
                        "required": parameter.required,
                        "type": parameter.type,
                        "token": parameter.token,
                    }
                    for parameter in entry.parameters
                ],
                "requestFields": list(entry.request_fields),
                "responsePointers": [
                    {"pointer": pointer.pointer, "type": pointer.type, "repeated": pointer.repeated}
                    for pointer in entry.response_pointers
                ],
                "successStatus": entry.success_status,
                "bindings": [
                    {
                        "pointer": binding.pointer,
                        "source": binding.source,
                        "pass": binding.pass_name,
                        "repeated": binding.repeated,
                    }
                    for binding in entry.bindings
                ],
            }
            for entry in build_operation_catalogue(spec)
        ],
        "fixtures": fixture_names(mock_settings),
    }
