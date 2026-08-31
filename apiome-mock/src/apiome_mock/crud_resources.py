"""Infer collection/item CRUD pairs from OpenAPI path templates (#4453)."""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from enum import Enum
from typing import Any, Literal

from app.mock_routing import MockOperation

_PARAM_RE = re.compile(r"^\{(.+?)\}$")


def _resolve_ref(ref: str, root: dict[str, Any]) -> dict[str, Any]:
    if not ref.startswith("#/"):
        return {}
    node: Any = root
    for token in ref[2:].split("/"):
        token = token.replace("~1", "/").replace("~0", "~")
        if isinstance(node, dict) and token in node:
            node = node[token]
        else:
            return {}
    return node if isinstance(node, dict) else {}


def _deref(schema: Any, root: dict[str, Any]) -> dict[str, Any]:
    if isinstance(schema, dict) and "$ref" in schema:
        resolved = _resolve_ref(schema["$ref"], root)
        if resolved:
            return resolved
    return schema if isinstance(schema, dict) else {}


class CrudAction(str, Enum):
    """CRUD verb inferred for a matched operation."""

    LIST = "list"
    CREATE = "create"
    READ = "read"
    UPDATE = "update"
    DELETE = "delete"


@dataclass(frozen=True)
class CrudResource:
    """A collection path paired with its single-param item path."""

    collection_path: str
    item_path: str
    id_param: str


@dataclass(frozen=True)
class CrudMatch:
    """Result of classifying a matched operation as CRUD-shaped."""

    resource: CrudResource
    action: CrudAction
    resource_id: str | None = None


def _normalize_template(template: str) -> str:
    return "/" + template.strip("/")


def _segments(template: str) -> list[str]:
    return [s for s in _normalize_template(template).split("/") if s]


def _param_name(segment: str) -> str | None:
    match = _PARAM_RE.fullmatch(segment)
    return match.group(1) if match else None


def build_crud_resources(operations: tuple[MockOperation, ...] | list[MockOperation]) -> list[CrudResource]:
    """Pair collection templates with single-param item templates."""
    templates = {_normalize_template(op.path_template) for op in operations}
    resources: list[CrudResource] = []
    seen: set[str] = set()

    for template in sorted(templates):
        segs = _segments(template)
        if len(segs) < 2:
            continue
        param = _param_name(segs[-1])
        if param is None:
            continue
        if any(_param_name(s) is not None for s in segs[:-1]):
            continue
        collection = "/" + "/".join(segs[:-1])
        if collection not in templates:
            continue
        if collection in seen:
            continue
        seen.add(collection)
        resources.append(
            CrudResource(
                collection_path=collection,
                item_path=template,
                id_param=param,
            ),
        )
    return resources


def match_crud_operation(
    operation: MockOperation,
    path_params: dict[str, str],
    resources: list[CrudResource],
) -> CrudMatch | None:
    """Classify ``operation`` against inferred CRUD resources, or ``None`` to fall through."""
    template = _normalize_template(operation.path_template)
    method = operation.method.upper()

    for resource in resources:
        if template == resource.collection_path:
            if method == "GET":
                return CrudMatch(resource=resource, action=CrudAction.LIST)
            if method == "POST":
                return CrudMatch(resource=resource, action=CrudAction.CREATE)
            return None
        if template == resource.item_path:
            resource_id = path_params.get(resource.id_param)
            if resource_id is None:
                # Path matcher may sanitize group names; try first value.
                if len(path_params) == 1:
                    resource_id = next(iter(path_params.values()))
                else:
                    return None
            if method == "GET":
                return CrudMatch(resource=resource, action=CrudAction.READ, resource_id=resource_id)
            if method in ("PUT", "PATCH"):
                return CrudMatch(resource=resource, action=CrudAction.UPDATE, resource_id=resource_id)
            if method == "DELETE":
                return CrudMatch(resource=resource, action=CrudAction.DELETE, resource_id=resource_id)
            return None
    return None


def _schema_property_type(schema: dict[str, Any], prop_name: str, root: dict[str, Any]) -> str | None:
    props = schema.get("properties")
    if not isinstance(props, dict) or prop_name not in props:
        return None
    prop = _deref(props[prop_name], root)
    prop_type = prop.get("type")
    if isinstance(prop_type, list):
        for candidate in prop_type:
            if candidate != "null":
                return str(candidate)
        return None
    if isinstance(prop_type, str):
        return prop_type
    if prop.get("format") == "uuid":
        return "string"
    return None


def _object_schema_from_operation(
    operation: MockOperation,
    *,
    root: dict[str, Any],
    prefer: Literal["request", "response"] = "request",
) -> dict[str, Any]:
    """Best-effort object schema for id field inference."""
    op = operation.operation

    def from_content(content: Any) -> dict[str, Any] | None:
        if not isinstance(content, dict):
            return None
        for media in content.values():
            if not isinstance(media, dict):
                continue
            schema = media.get("schema")
            if not isinstance(schema, dict):
                continue
            resolved = _deref(schema, root)
            if resolved.get("type") == "array":
                items = resolved.get("items")
                if isinstance(items, dict):
                    return _deref(items, root)
            return resolved
        return None

    if prefer == "request":
        body = op.get("requestBody")
        if isinstance(body, dict):
            found = from_content(body.get("content"))
            if found is not None:
                return found
    responses = op.get("responses")
    if isinstance(responses, dict):
        for code in sorted(responses.keys(), key=lambda c: (not str(c).isdigit(), str(c))):
            if str(code).isdigit() and not (200 <= int(code) < 300):
                continue
            response_obj = responses[code]
            if not isinstance(response_obj, dict):
                continue
            found = from_content(response_obj.get("content"))
            if found is not None:
                return found
    if prefer == "response":
        body = op.get("requestBody")
        if isinstance(body, dict):
            found = from_content(body.get("content"))
            if found is not None:
                return found
    return {}


def resolve_id_field_name(resource: CrudResource, schema: dict[str, Any]) -> str:
    """Prefer path-param name when present on the schema, else ``id``."""
    props = schema.get("properties") if isinstance(schema, dict) else None
    if isinstance(props, dict):
        if resource.id_param in props:
            return resource.id_param
        if "id" in props:
            return "id"
    if resource.id_param:
        return resource.id_param
    return "id"


def extract_or_synthesize_id(
    body: dict[str, Any],
    *,
    resource: CrudResource,
    operation: MockOperation,
    spec: dict[str, Any],
    next_int: int,
) -> tuple[str, dict[str, Any], Any]:
    """Return ``(resource_id_str, body_with_id, raw_id_value)`` for a create payload."""
    schema = _object_schema_from_operation(operation, root=spec, prefer="request")
    if not schema:
        schema = _object_schema_from_operation(operation, root=spec, prefer="response")
    field = resolve_id_field_name(resource, schema)
    payload = dict(body)
    if field in payload and payload[field] is not None and payload[field] != "":
        raw = payload[field]
        return str(raw), payload, raw

    prop_type = _schema_property_type(schema, field, spec) if schema else None
    if prop_type == "integer" or prop_type == "number":
        raw_id: Any = next_int
    elif prop_type == "string" or schema.get("properties", {}).get(field, {}).get("format") == "uuid":
        raw_id = str(uuid.uuid4())
    else:
        # Default: integer ids for Petstore-like schemas; uuid otherwise.
        if field == "id" or field.endswith("Id") or field.endswith("_id"):
            raw_id = next_int
        else:
            raw_id = str(uuid.uuid4())
    payload[field] = raw_id
    return str(raw_id), payload, raw_id
