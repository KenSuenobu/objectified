"""Incoming request validation against OpenAPI operation specs (SIM-1.4)."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from app.mock_routing import MockOperation
from fastapi import Request

from apiome_mock.response_resolver import match_request_content_type
from apiome_mock.schema_synthesizer import validate_value

MOCK_CONTROL_QUERY_PARAMS = frozenset({"__seed", "__status"})


@dataclass(frozen=True)
class ValidationFailure:
    """A request that failed spec validation."""

    status: int
    detail: str
    violations: tuple[dict[str, Any], ...] = ()


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


def _deref_schema(schema: Any, root: dict[str, Any]) -> dict[str, Any]:
    if isinstance(schema, dict) and "$ref" in schema:
        return _resolve_ref(schema["$ref"], root)
    return schema if isinstance(schema, dict) else {}


def _resolve_parameter(param: Any, root: dict[str, Any]) -> dict[str, Any] | None:
    if not isinstance(param, dict):
        return None
    if "$ref" in param:
        resolved = _resolve_ref(param["$ref"], root)
        return resolved if resolved else None
    return param


def _schema_type(schema: dict[str, Any]) -> str | None:
    t = schema.get("type")
    if isinstance(t, list):
        for candidate in t:
            if candidate != "null":
                return str(candidate)
        return str(t[0]) if t else None
    if t:
        return str(t)
    if "properties" in schema:
        return "object"
    if "items" in schema or "prefixItems" in schema:
        return "array"
    return None


def _coerce_scalar(raw: str, schema: dict[str, Any]) -> Any:
    jtype = _schema_type(schema)
    if jtype == "integer":
        return int(raw)
    if jtype == "number":
        return float(raw)
    if jtype == "boolean":
        lowered = raw.strip().lower()
        if lowered in ("true", "1"):
            return True
        if lowered in ("false", "0"):
            return False
        raise ValueError(f"invalid boolean: {raw!r}")
    if jtype == "array":
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            parsed = [part.strip() for part in raw.split(",") if part.strip()]
        if not isinstance(parsed, list):
            raise ValueError(f"expected array, got {type(parsed).__name__}")
        items_schema = schema.get("items")
        if isinstance(items_schema, dict):
            return [_coerce_scalar(str(item), items_schema) for item in parsed]
        return parsed
    return raw


def _coerce_param_value(raw: str, schema: dict[str, Any], spec: dict[str, Any]) -> Any:
    schema = _deref_schema(schema, spec)
    if not schema:
        return raw
    return _coerce_scalar(raw, schema)


def _collect_parameters(operation: dict[str, Any], spec: dict[str, Any]) -> list[dict[str, Any]]:
    raw = operation.get("parameters")
    if not isinstance(raw, list):
        return []
    resolved: list[dict[str, Any]] = []
    for entry in raw:
        param = _resolve_parameter(entry, spec)
        if param is not None:
            resolved.append(param)
    return resolved


def _header_lookup(headers: Any, name: str) -> str | None:
    if headers is None:
        return None
    direct = headers.get(name)
    if direct is not None:
        return str(direct)
    lowered = name.lower()
    for key, value in headers.items():
        if str(key).lower() == lowered:
            return str(value)
    return None


def _violation(location: str, message: str) -> dict[str, Any]:
    return {"location": location, "message": message}


async def validate_operation_request(
    request: Request,
    operation: MockOperation,
    path_params: dict[str, str],
    spec: dict[str, Any],
) -> ValidationFailure | None:
    """Validate path, query, header params, and request body; return failure or ``None``."""
    violations: list[dict[str, Any]] = []
    op_obj = operation.operation

    for param in _collect_parameters(op_obj, spec):
        location = param.get("in")
        name = param.get("name")
        if not isinstance(location, str) or not isinstance(name, str):
            continue
        schema = param.get("schema")
        if not isinstance(schema, dict):
            schema = {}
        required = bool(param.get("required", location == "path"))

        if location == "path":
            raw = path_params.get(name)
            if raw is None:
                if required:
                    violations.append(_violation(f"path.{name}", "required path parameter is missing"))
                continue
            try:
                value = _coerce_param_value(raw, schema, spec)
            except (TypeError, ValueError) as exc:
                violations.append(_violation(f"path.{name}", str(exc)))
                continue
            error = validate_value(value, schema, spec)
            if error:
                violations.append(_violation(f"path.{name}", error))
            continue

        if location == "query":
            if name in MOCK_CONTROL_QUERY_PARAMS:
                continue
            raw_values = request.query_params.getlist(name)
            if not raw_values:
                if required:
                    violations.append(_violation(f"query.{name}", "required query parameter is missing"))
                continue
            if len(raw_values) == 1:
                try:
                    value = _coerce_param_value(raw_values[0], schema, spec)
                except (TypeError, ValueError) as exc:
                    violations.append(_violation(f"query.{name}", str(exc)))
                    continue
            else:
                item_schema = schema.get("items", schema) if schema.get("type") == "array" else schema
                try:
                    value = [_coerce_param_value(str(item), item_schema, spec) for item in raw_values]
                except (TypeError, ValueError) as exc:
                    violations.append(_violation(f"query.{name}", str(exc)))
                    continue
            error = validate_value(value, schema, spec)
            if error:
                violations.append(_violation(f"query.{name}", error))
            continue

        if location == "header":
            raw = _header_lookup(request.headers, name)
            if raw is None:
                if required:
                    violations.append(_violation(f"header.{name}", "required header parameter is missing"))
                continue
            try:
                value = _coerce_param_value(raw, schema, spec)
            except (TypeError, ValueError) as exc:
                violations.append(_violation(f"header.{name}", str(exc)))
                continue
            error = validate_value(value, schema, spec)
            if error:
                violations.append(_violation(f"header.{name}", error))

    request_body = op_obj.get("requestBody")
    if isinstance(request_body, dict):
        body_required = bool(request_body.get("required", False))
        content = request_body.get("content")
        allowed_types = list(content.keys()) if isinstance(content, dict) else []
        body_bytes = await request.body()
        has_body = bool(body_bytes)

        if body_required and not has_body:
            violations.append(_violation("body", "request body is required"))
        elif has_body and allowed_types:
            content_type = _header_lookup(request.headers, "content-type")
            matched = match_request_content_type(content_type, allowed_types)
            if matched is None:
                return ValidationFailure(
                    status=415,
                    detail="Request Content-Type is not supported for this operation.",
                    violations=tuple(
                        violations
                        + [
                            _violation(
                                "header.Content-Type",
                                f"expected one of {', '.join(allowed_types)}",
                            )
                        ]
                    ),
                )
            media_obj = content.get(matched) if isinstance(content, dict) else None
            schema = media_obj.get("schema") if isinstance(media_obj, dict) else None
            if isinstance(schema, dict):
                try:
                    if matched.endswith("json") or matched.endswith("+json"):
                        parsed = json.loads(body_bytes)
                    else:
                        parsed = body_bytes.decode("utf-8")
                except (json.JSONDecodeError, UnicodeDecodeError) as exc:
                    violations.append(_violation("body", f"invalid request body: {exc}"))
                else:
                    error = validate_value(parsed, schema, spec)
                    if error:
                        violations.append(_violation("body", error))

    if not violations:
        return None
    return ValidationFailure(
        status=400,
        detail="Request failed OpenAPI validation.",
        violations=tuple(violations),
    )
