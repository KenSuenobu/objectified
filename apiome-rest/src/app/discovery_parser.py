"""Google API Discovery parser — IXH-7.1 (#5126).

Parses Google API Discovery Service REST descriptions
(``kind: discovery#restDescription``) into a typed :class:`DiscoveryDocument` AST.
Syntax and shape errors surface as :class:`DiscoveryParseError`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Tuple

from .import_ingestion import IngestionError, parse_document

__all__ = [
    "DiscoveryParseError",
    "DiscoveryParameter",
    "DiscoveryMethod",
    "DiscoveryResource",
    "DiscoveryDocument",
    "is_discovery",
    "is_discovery_document",
    "is_discovery_directory",
    "parse_discovery",
]

_API_MARKERS = ("openapi", "swagger", "asyncapi", "arazzo", "openrpc")
_KIND_REST = "discovery#restDescription"
_KIND_DIRECTORY = "discovery#directoryList"


class DiscoveryParseError(ValueError):
    """Raised when Discovery text cannot be parsed into a rest description."""


@dataclass(frozen=True)
class DiscoveryParameter:
    """A method or document-level parameter from a Discovery document."""

    name: str
    location: str
    required: bool
    type_name: Optional[str]
    description: Optional[str]
    enum_values: Tuple[str, ...]
    schema: Dict[str, Any]


@dataclass(frozen=True)
class DiscoveryMethod:
    """A single HTTP method under a Discovery resource."""

    id: Optional[str]
    name: str
    path: str
    http_method: str
    description: Optional[str]
    parameters: Tuple[DiscoveryParameter, ...]
    request_schema: Optional[Dict[str, Any]]
    response_schema: Optional[Dict[str, Any]]
    resource_path: str


@dataclass(frozen=True)
class DiscoveryResource:
    """A named resource node (may nest further resources)."""

    name: str
    methods: Tuple[DiscoveryMethod, ...]
    resources: Tuple["DiscoveryResource", ...]


@dataclass(frozen=True)
class DiscoveryDocument:
    """Parsed Google API Discovery rest description."""

    discovery_version: str
    kind: str
    name: str
    version: Optional[str]
    title: Optional[str]
    description: Optional[str]
    id: Optional[str]
    base_url: Optional[str]
    root_url: Optional[str]
    service_path: Optional[str]
    base_path: Optional[str]
    documentation_link: Optional[str]
    schemas: Dict[str, Any]
    parameters: Tuple[DiscoveryParameter, ...]
    resources: Tuple[DiscoveryResource, ...]
    methods: Tuple[DiscoveryMethod, ...]
    raw: str


def _is_discovery_mapping(document: Any) -> bool:
    if not isinstance(document, Mapping):
        return False
    if any(marker in document for marker in _API_MARKERS):
        return False
    kind = document.get("kind")
    if isinstance(kind, str) and kind.strip() == _KIND_REST:
        return True
    version = document.get("discoveryVersion")
    if not isinstance(version, str) or not version.strip():
        return False
    # A rest description always carries resources and/or schemas; decline bare
    # directory lists and other discovery-flavored JSON that lack both.
    if "resources" in document or "schemas" in document:
        return True
    return False


def is_discovery_document(document: Any) -> bool:
    """Return ``True`` when a parsed mapping looks like a Discovery rest description."""
    return _is_discovery_mapping(document)


def is_discovery_directory(document: Any) -> bool:
    """Return ``True`` when a parsed mapping is a Discovery directory listing."""
    if not isinstance(document, Mapping):
        return False
    kind = document.get("kind")
    if isinstance(kind, str) and kind.strip() == _KIND_DIRECTORY:
        return True
    return isinstance(document.get("items"), list) and "discoveryVersion" in document


def is_discovery(content: str) -> bool:
    """Return ``True`` when ``content`` looks like a Discovery rest description."""
    if not content or not isinstance(content, str) or not content.strip():
        return False
    try:
        document = parse_document(content)
    except IngestionError:
        return False
    return _is_discovery_mapping(document)


def _as_optional_str(value: Any) -> Optional[str]:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _parse_parameter(name: str, entry: Mapping[str, Any]) -> DiscoveryParameter:
    location = entry.get("location")
    if not isinstance(location, str) or not location.strip():
        location = "query"
    enum_raw = entry.get("enum")
    enum_values: Tuple[str, ...] = ()
    if isinstance(enum_raw, list):
        enum_values = tuple(str(item) for item in enum_raw if item is not None)
    type_name = entry.get("type")
    if not isinstance(type_name, str):
        type_name = None
    schema = {key: value for key, value in entry.items() if key not in ("location", "required")}
    return DiscoveryParameter(
        name=name,
        location=location.strip().lower(),
        required=entry.get("required") is True,
        type_name=type_name,
        description=_as_optional_str(entry.get("description")),
        enum_values=enum_values,
        schema=schema,
    )


def _parse_parameters(raw: Any) -> Tuple[DiscoveryParameter, ...]:
    if not isinstance(raw, Mapping):
        return ()
    params: List[DiscoveryParameter] = []
    for name, entry in raw.items():
        if not isinstance(name, str) or not name.strip():
            continue
        if not isinstance(entry, Mapping):
            continue
        params.append(_parse_parameter(name.strip(), entry))
    return tuple(params)


def _join_resource_path(parent: str, name: str) -> str:
    if not parent:
        return name
    return f"{parent}/{name}"


def _parse_methods(
    raw_methods: Any,
    *,
    resource_path: str,
) -> Tuple[DiscoveryMethod, ...]:
    if not isinstance(raw_methods, Mapping):
        return ()
    methods: List[DiscoveryMethod] = []
    for name, entry in raw_methods.items():
        if not isinstance(name, str) or not name.strip():
            continue
        if not isinstance(entry, Mapping):
            continue
        http_method = entry.get("httpMethod")
        if not isinstance(http_method, str) or not http_method.strip():
            continue
        path = entry.get("path")
        if not isinstance(path, str):
            path = ""
        request = entry.get("request")
        response = entry.get("response")
        methods.append(
            DiscoveryMethod(
                id=_as_optional_str(entry.get("id")),
                name=name.strip(),
                path=path,
                http_method=http_method.strip().upper(),
                description=_as_optional_str(entry.get("description")),
                parameters=_parse_parameters(entry.get("parameters")),
                request_schema=request if isinstance(request, dict) else None,
                response_schema=response if isinstance(response, dict) else None,
                resource_path=resource_path,
            )
        )
    return tuple(methods)


def _parse_resources(raw: Any, *, parent_path: str = "") -> Tuple[DiscoveryResource, ...]:
    if not isinstance(raw, Mapping):
        return ()
    resources: List[DiscoveryResource] = []
    for name, entry in raw.items():
        if not isinstance(name, str) or not name.strip():
            continue
        if not isinstance(entry, Mapping):
            continue
        resource_path = _join_resource_path(parent_path, name.strip())
        resources.append(
            DiscoveryResource(
                name=name.strip(),
                methods=_parse_methods(entry.get("methods"), resource_path=resource_path),
                resources=_parse_resources(entry.get("resources"), parent_path=resource_path),
            )
        )
    return tuple(resources)


def _flatten_methods(resources: Tuple[DiscoveryResource, ...]) -> Tuple[DiscoveryMethod, ...]:
    flat: List[DiscoveryMethod] = []

    def walk(nodes: Tuple[DiscoveryResource, ...]) -> None:
        for node in nodes:
            flat.extend(node.methods)
            walk(node.resources)

    walk(resources)
    return tuple(flat)


def parse_discovery(content: str, *, source_label: Optional[str] = None) -> DiscoveryDocument:
    """Parse Discovery JSON into a :class:`DiscoveryDocument`.

    Args:
        content: Raw Discovery rest-description text (JSON or YAML).
        source_label: Optional label used in error messages.

    Returns:
        The typed :class:`DiscoveryDocument`.

    Raises:
        DiscoveryParseError: If the text is empty, not Discovery-shaped, or lacks a name.
    """
    if not content or not content.strip():
        raise DiscoveryParseError("Invalid or empty Discovery document")
    try:
        document = parse_document(content, source_label=source_label)
    except IngestionError as exc:
        raise DiscoveryParseError(str(exc)) from exc

    if is_discovery_directory(document):
        label = f" ({source_label})" if source_label else ""
        raise DiscoveryParseError(
            f"Content is a Discovery directory listing{label}; pass a rest description URL "
            "or select an API from the directory"
        )

    if not _is_discovery_mapping(document):
        raise DiscoveryParseError("Content does not appear to be a Google API Discovery document")

    name = document.get("name")
    if not isinstance(name, str) or not name.strip():
        title = document.get("title")
        if isinstance(title, str) and title.strip():
            name = title.strip()
        else:
            raise DiscoveryParseError("Discovery document is missing `name` (and `title`)")
    else:
        name = name.strip()

    schemas = document.get("schemas")
    if not isinstance(schemas, dict):
        schemas = {}

    resources = _parse_resources(document.get("resources"))
    methods = _flatten_methods(resources)
    # Top-level methods (rare; some older docs place unbound methods at the root).
    root_methods = _parse_methods(document.get("methods"), resource_path="")
    if root_methods:
        methods = root_methods + methods

    if not methods and not schemas:
        label = f" ({source_label})" if source_label else ""
        raise DiscoveryParseError(f"No Discovery methods or schemas found{label}")

    discovery_version = document.get("discoveryVersion")
    if not isinstance(discovery_version, str) or not discovery_version.strip():
        discovery_version = "v1"

    kind = document.get("kind")
    if not isinstance(kind, str) or not kind.strip():
        kind = _KIND_REST

    return DiscoveryDocument(
        discovery_version=discovery_version.strip(),
        kind=kind.strip(),
        name=name,
        version=_as_optional_str(document.get("version")),
        title=_as_optional_str(document.get("title")),
        description=_as_optional_str(document.get("description")),
        id=_as_optional_str(document.get("id")),
        base_url=_as_optional_str(document.get("baseUrl")),
        root_url=_as_optional_str(document.get("rootUrl")),
        service_path=_as_optional_str(document.get("servicePath")),
        base_path=_as_optional_str(document.get("basePath")),
        documentation_link=_as_optional_str(document.get("documentationLink")),
        schemas=dict(schemas),
        parameters=_parse_parameters(document.get("parameters")),
        resources=resources,
        methods=methods,
        raw=content,
    )
