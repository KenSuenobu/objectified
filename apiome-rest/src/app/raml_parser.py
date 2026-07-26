"""RAML 1.0 parser — MFI-16.1.

Parses RAML REST API definitions into a typed :class:`RamlDocument` AST using
:mod:`yaml` (RAML is a YAML dialect with a mandatory ``#%RAML`` header). Syntax
errors surface as :class:`RamlParseError`.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional, Tuple

import yaml

__all__ = [
    "RamlParseError",
    "RamlTypeField",
    "RamlType",
    "RamlParameter",
    "RamlOperation",
    "RamlDocument",
    "is_raml",
    "parse_raml",
]

_RAMl_HEADER_RE = re.compile(r"^\s*#%RAML\s+(\d+\.\d+)", re.IGNORECASE)
_HTTP_METHODS = frozenset({"get", "post", "put", "patch", "delete", "head", "options"})
_RESOURCE_META_KEYS = frozenset(
    {
        "description",
        "displayName",
        "uriParameters",
        "queryParameters",
        "type",
        "is",
        "securedBy",
        "protocols",
        "baseUriParameters",
    }
)
_RAML_PRIMITIVES = frozenset(
    {
        "string",
        "number",
        "integer",
        "boolean",
        "object",
        "array",
        "date-only",
        "time-only",
        "datetime-only",
        "datetime",
        "file",
        "nil",
        "any",
    }
)


class RamlParseError(ValueError):
    """Raised when RAML text cannot be parsed."""


@dataclass(frozen=True)
class RamlTypeField:
    name: str
    type_expr: str
    required: bool
    description: Optional[str] = None


@dataclass(frozen=True)
class RamlType:
    name: str
    description: Optional[str]
    fields: Tuple[RamlTypeField, ...]
    enum_values: Tuple[str, ...] = ()


@dataclass(frozen=True)
class RamlParameter:
    name: str
    location: str
    type_expr: str
    required: bool
    description: Optional[str] = None


@dataclass(frozen=True)
class RamlOperation:
    path: str
    method: str
    description: Optional[str]
    parameters: Tuple[RamlParameter, ...]
    request_type: Optional[str]
    response_types: Tuple[Tuple[str, str], ...]


@dataclass(frozen=True)
class RamlDocument:
    raml_version: str
    title: str
    version: Optional[str]
    base_uri: Optional[str]
    description: Optional[str]
    media_type: Optional[str]
    types: Tuple[RamlType, ...]
    operations: Tuple[RamlOperation, ...]
    raw: str


def is_raml(content: str) -> bool:
    """Return ``True`` when ``content`` looks like a RAML document."""
    if not content or not isinstance(content, str):
        return False
    trimmed = content.strip()
    if not trimmed:
        return False
    if _RAMl_HEADER_RE.match(trimmed):
        return True
    try:
        parsed = yaml.safe_load(trimmed)
    except yaml.YAMLError:
        return False
    return _is_raml_mapping(parsed)


def _is_raml_mapping(doc: Any) -> bool:
    if not isinstance(doc, Mapping):
        return False
    if doc.get("openapi") or doc.get("swagger") or doc.get("asyncapi") or doc.get("openrpc"):
        return False
    # Google API Discovery rest descriptions also carry title + version/schemas.
    kind = doc.get("kind")
    if isinstance(kind, str) and kind.strip() == "discovery#restDescription":
        return False
    if isinstance(doc.get("discoveryVersion"), str) and (
        "resources" in doc or "schemas" in doc
    ):
        return False
    has_title = isinstance(doc.get("title"), str)
    has_indicator = any(
        key in doc
        for key in ("baseUri", "version", "types", "schemas")
    ) or any(str(key).startswith("/") for key in doc)
    return has_title and has_indicator


def _type_expr_from_value(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, Mapping):
        if "type" in value:
            inner = value["type"]
            if isinstance(inner, str) and inner.endswith("[]"):
                return inner
            if isinstance(inner, str):
                return inner
        return "object"
    return "string"


def _parse_type_fields(properties: Any) -> Tuple[RamlTypeField, ...]:
    if not isinstance(properties, Mapping):
        return ()
    fields: List[RamlTypeField] = []
    for raw_name, raw_value in properties.items():
        name = str(raw_name).rstrip("?")
        required = not str(raw_name).endswith("?")
        description: Optional[str] = None
        type_expr = "string"
        if isinstance(raw_value, Mapping):
            type_expr = _type_expr_from_value(raw_value)
            desc = raw_value.get("description")
            if isinstance(desc, str):
                description = desc
            if raw_value.get("required") is False:
                required = False
        else:
            type_expr = _type_expr_from_value(raw_value)
        fields.append(
            RamlTypeField(
                name=name,
                type_expr=type_expr,
                required=required,
                description=description,
            )
        )
    return tuple(fields)


def _parse_types(root: Mapping[str, Any]) -> Tuple[RamlType, ...]:
    types_source = root.get("types") or root.get("schemas")
    if not isinstance(types_source, Mapping):
        return ()
    parsed: List[RamlType] = []
    for name, decl in types_source.items():
        if not isinstance(name, str):
            continue
        description: Optional[str] = None
        fields: Tuple[RamlTypeField, ...] = ()
        enum_values: Tuple[str, ...] = ()
        if isinstance(decl, Mapping):
            desc = decl.get("description")
            if isinstance(desc, str):
                description = desc
            if isinstance(decl.get("enum"), list):
                enum_values = tuple(str(v) for v in decl["enum"])
            fields = _parse_type_fields(decl.get("properties"))
        parsed.append(
            RamlType(
                name=name,
                description=description,
                fields=fields,
                enum_values=enum_values,
            )
        )
    return tuple(parsed)


def _extract_body_type(method_spec: Mapping[str, Any]) -> Optional[str]:
    body = method_spec.get("body")
    if not isinstance(body, Mapping):
        return None
    for _media, media_spec in body.items():
        if isinstance(media_spec, Mapping) and isinstance(media_spec.get("type"), str):
            return media_spec["type"].removesuffix("[]")
        if isinstance(media_spec, str):
            return media_spec.removesuffix("[]")
    return None


def _extract_response_types(method_spec: Mapping[str, Any]) -> Tuple[Tuple[str, str], ...]:
    responses = method_spec.get("responses")
    if not isinstance(responses, Mapping):
        return ()
    pairs: List[Tuple[str, str]] = []
    for status, response_spec in responses.items():
        if not isinstance(response_spec, Mapping):
            continue
        body = response_spec.get("body")
        if not isinstance(body, Mapping):
            continue
        for _media, media_spec in body.items():
            if isinstance(media_spec, Mapping) and isinstance(media_spec.get("type"), str):
                pairs.append((str(status), media_spec["type"].removesuffix("[]")))
                break
            if isinstance(media_spec, str):
                pairs.append((str(status), media_spec.removesuffix("[]")))
                break
    return tuple(pairs)


def _parse_parameters(
    resource_spec: Mapping[str, Any],
    method_spec: Mapping[str, Any],
) -> Tuple[RamlParameter, ...]:
    params: List[RamlParameter] = []
    for location_key, location in (("uriParameters", "path"), ("queryParameters", "query")):
        block = resource_spec.get(location_key) or method_spec.get(location_key)
        if not isinstance(block, Mapping):
            continue
        for name, spec in block.items():
            if not isinstance(name, str):
                continue
            required = True
            description: Optional[str] = None
            type_expr = "string"
            if isinstance(spec, Mapping):
                type_expr = _type_expr_from_value(spec)
                if isinstance(spec.get("description"), str):
                    description = spec["description"]
                if spec.get("required") is False:
                    required = False
            params.append(
                RamlParameter(
                    name=name,
                    location=location,
                    type_expr=type_expr,
                    required=required,
                    description=description,
                )
            )
    return tuple(params)


def _collect_operations(
    node: Mapping[str, Any],
    *,
    parent_path: str = "",
) -> List[RamlOperation]:
    operations: List[RamlOperation] = []
    for key, value in node.items():
        if not isinstance(key, str) or not key.startswith("/"):
            continue
        if not isinstance(value, Mapping):
            continue
        full_path = f"{parent_path}{key}"
        for method in _HTTP_METHODS:
            method_spec = value.get(method)
            if not isinstance(method_spec, Mapping):
                continue
            description = method_spec.get("description")
            operations.append(
                RamlOperation(
                    path=full_path,
                    method=method,
                    description=description if isinstance(description, str) else None,
                    parameters=_parse_parameters(value, method_spec),
                    request_type=_extract_body_type(method_spec),
                    response_types=_extract_response_types(method_spec),
                )
            )
        nested = {
            nested_key: nested_value
            for nested_key, nested_value in value.items()
            if isinstance(nested_key, str) and nested_key.startswith("/")
        }
        if nested:
            operations.extend(_collect_operations(nested, parent_path=full_path))
    return operations


def _extract_raml_version(content: str) -> str:
    match = _RAMl_HEADER_RE.match(content)
    return match.group(1) if match else "1.0"


def parse_raml(content: str, *, source_label: Optional[str] = None) -> RamlDocument:
    """Parse RAML text into a :class:`RamlDocument`."""
    if not content or not content.strip():
        raise RamlParseError("Invalid or empty RAML document")
    if not is_raml(content):
        raise RamlParseError("Content does not appear to be a RAML document")

    try:
        root = yaml.safe_load(content)
    except yaml.YAMLError as exc:
        raise RamlParseError(f"Malformed YAML: {exc}") from exc

    if not isinstance(root, Mapping):
        raise RamlParseError("RAML document must be a YAML mapping at the top level")
    if not _is_raml_mapping(root):
        raise RamlParseError("YAML mapping is not a RAML root document")

    title = root.get("title")
    if not isinstance(title, str) or not title.strip():
        raise RamlParseError("RAML document is missing a `title`")

    types = _parse_types(root)
    operations = tuple(_collect_operations(root))
    if not types and not operations:
        label = f" ({source_label})" if source_label else ""
        raise RamlParseError(f"No RAML types or resources found{label}")

    return RamlDocument(
        raml_version=_extract_raml_version(content),
        title=title.strip(),
        version=root.get("version") if isinstance(root.get("version"), str) else None,
        base_uri=root.get("baseUri") if isinstance(root.get("baseUri"), str) else None,
        description=root.get("description") if isinstance(root.get("description"), str) else None,
        media_type=root.get("mediaType") if isinstance(root.get("mediaType"), str) else None,
        types=types,
        operations=operations,
        raw=content,
    )
