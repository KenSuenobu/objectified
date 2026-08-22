"""API Blueprint 1A parser.

Parses API Blueprint markdown into a typed :class:`ApiblueprintDocument` AST using
a lightweight line-oriented parser so catalog imports do not depend on the
external ``drafter`` CLI.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import List, Optional, Tuple

__all__ = [
    "ApiblueprintParseError",
    "ApiblueprintField",
    "ApiblueprintType",
    "ApiblueprintParameter",
    "ApiblueprintOperation",
    "ApiblueprintDocument",
    "is_apiblueprint",
    "parse_apiblueprint",
]

_FORMAT_RE = re.compile(r"^\s*FORMAT\s*:\s*(\S+)\s*$", re.IGNORECASE | re.MULTILINE)
#: The *detection* marker, deliberately narrower than :data:`_FORMAT_RE` (FMT-5.1).
#:
#: API Blueprint's ``FORMAT: 1A`` is a metadata line at column zero declaring the
#: blueprint revision. The parser's permissive form matches ``format:`` **anywhere** at
#: **any** indentation with **any** value, which is also how every YAML document in the
#: world spells a JSON-Schema ``format: int32`` or an ODCS server's ``format: parquet`` —
#: so used as a sniff it claimed documents that are not blueprints at all. Detection
#: therefore requires both halves of the real marker: column zero, and a ``1A``-line
#: revision. Reading a parsed document still uses the permissive form, so nothing a
#: blueprint can legally say stops being read.
_FORMAT_MARKER_RE = re.compile(r"^FORMAT\s*:\s*1A[0-9]*\s*$", re.IGNORECASE | re.MULTILINE)
_HOST_RE = re.compile(r"^\s*HOST\s*:\s*(\S+)\s*$", re.IGNORECASE | re.MULTILINE)
_RESOURCE_RE = re.compile(r"^##\s+(.+?)\s+\[([^\]]+)\]\s*$")
_ACTION_RE = re.compile(r"^###\s+(.+?)\s+\[([A-Z]+)(?:\s+([^\]]+))?\]\s*$")
_TYPE_DEF_RE = re.compile(r"^##\s+(\w+)\s*\((\w+)\)\s*$")
_FIELD_RE = re.compile(
    r"^\s*\+\s+(\w+):\s*(?:(?:`([^`]*)`)|(\S+))?\s*\(([^)]+)\)\s*(?:-\s*(.*))?$"
)
_PARAM_RE = re.compile(r"^\s*\+\s+(\w+)\s*\(([^)]+)\)\s*(?:-\s*(.*))?$")
_ATTRIBUTES_RE = re.compile(r"^\s*\+\s+Attributes\s*\(([^)]+)\)\s*$")
_REQUEST_RE = re.compile(r"^\s*\+\s+Request\s*\(([^)]+)\)\s*$")
_RESPONSE_RE = re.compile(r"^\s*\+\s+Response\s+(\d{3})(?:\s*\(([^)]+)\))?\s*$")
_ENUM_MEMBER_RE = re.compile(r"^\s*\+\s+(\w+)\s*$")
_DATA_STRUCTURES_RE = re.compile(r"^#\s+Data Structures\s*$", re.IGNORECASE)


class ApiblueprintParseError(ValueError):
    """Raised when API Blueprint text cannot be parsed."""


@dataclass(frozen=True)
class ApiblueprintField:
    name: str
    type_expr: str
    required: bool
    sample: Optional[str]
    description: Optional[str]


@dataclass(frozen=True)
class ApiblueprintType:
    name: str
    kind: str
    fields: Tuple[ApiblueprintField, ...]
    enum_values: Tuple[str, ...]
    description: Optional[str] = None


@dataclass(frozen=True)
class ApiblueprintParameter:
    name: str
    type_expr: str
    required: bool
    description: Optional[str] = None


@dataclass(frozen=True)
class ApiblueprintOperation:
    name: str
    method: str
    path: str
    description: Optional[str]
    parameters: Tuple[ApiblueprintParameter, ...]
    request_media_type: Optional[str]
    request_type: Optional[str]
    responses: Tuple[Tuple[str, Optional[str], Optional[str]], ...]


@dataclass(frozen=True)
class ApiblueprintDocument:
    format_version: str
    title: str
    host: Optional[str]
    description: Optional[str]
    types: Tuple[ApiblueprintType, ...]
    operations: Tuple[ApiblueprintOperation, ...]
    raw: str


def is_apiblueprint(content: str) -> bool:
    """Return ``True`` when ``content`` looks like an API Blueprint document.

    Claims a document carrying the ``FORMAT: 1A`` metadata marker at column zero — see
    :data:`_FORMAT_MARKER_RE` for why both halves of that marker are required.

    Args:
        content: The candidate document text.

    Returns:
        ``True`` when the API Blueprint reader claims the text.
    """
    if not content or not isinstance(content, str):
        return False
    return bool(_FORMAT_MARKER_RE.search(content.strip()))


def _parse_type_modifiers(modifiers: str) -> Tuple[str, bool]:
    parts = [part.strip() for part in modifiers.split(",") if part.strip()]
    required = any(part.lower() == "required" for part in parts)
    if any(part.lower() == "optional" for part in parts):
        required = False
    type_parts = [
        part
        for part in parts
        if part.lower() not in {"required", "optional"}
    ]
    return (type_parts[0] if type_parts else "string"), required


def _normalize_path(path: str) -> str:
    cleaned = path.strip()
    if not cleaned.startswith("/"):
        cleaned = "/" + cleaned
    return cleaned


def _join_paths(base: str, suffix: Optional[str]) -> str:
    base_path = _normalize_path(base)
    if not suffix:
        return base_path
    suffix = suffix.strip()
    if suffix.startswith("/"):
        return _normalize_path(suffix)
    if not base_path.endswith("/"):
        base_path += "/"
    return _normalize_path(base_path + suffix)


def _path_parameters(path: str) -> List[ApiblueprintParameter]:
    params: List[ApiblueprintParameter] = []
    for name in re.findall(r"\{([^}]+)\}", path):
        params.append(
            ApiblueprintParameter(
                name=name,
                type_expr="string",
                required=True,
                description=None,
            )
        )
    return params


def _parse_parameter_line(line: str) -> Optional[ApiblueprintParameter]:
    match = _PARAM_RE.match(line)
    if not match:
        return None
    type_expr, required = _parse_type_modifiers(match.group(2))
    return ApiblueprintParameter(
        name=match.group(1),
        type_expr=type_expr,
        required=required,
        description=match.group(3).strip() if match.group(3) else None,
    )


def _parse_field_line(line: str) -> Optional[ApiblueprintField]:
    match = _FIELD_RE.match(line)
    if not match:
        return None
    sample = match.group(2) if match.group(2) is not None else match.group(3)
    type_expr, required = _parse_type_modifiers(match.group(4))
    return ApiblueprintField(
        name=match.group(1),
        type_expr=type_expr,
        required=required,
        sample=sample,
        description=match.group(5).strip() if match.group(5) else None,
    )


def _finalize_operation(
    *,
    name: str,
    method: str,
    path: str,
    resource_params: List[ApiblueprintParameter],
    action_params: List[ApiblueprintParameter],
    request_media_type: Optional[str],
    request_type: Optional[str],
    responses: List[Tuple[str, Optional[str], Optional[str]]],
) -> ApiblueprintOperation:
    params_by_name = {param.name: param for param in _path_parameters(path)}
    for param in resource_params:
        params_by_name[param.name] = param
    for param in action_params:
        params_by_name[param.name] = param
    return ApiblueprintOperation(
        name=name,
        method=method,
        path=path,
        description=None,
        parameters=tuple(params_by_name.values()),
        request_media_type=request_media_type,
        request_type=request_type,
        responses=tuple(responses),
    )


def parse_apiblueprint(content: str, *, source_label: Optional[str] = None) -> ApiblueprintDocument:
    """Parse API Blueprint text into an :class:`ApiblueprintDocument`."""
    if not content or not content.strip():
        raise ApiblueprintParseError("Invalid or empty API Blueprint document")
    if not is_apiblueprint(content):
        raise ApiblueprintParseError("Content does not appear to be an API Blueprint document")

    lines = content.splitlines()
    format_version = "1A"
    host: Optional[str] = None
    title = source_label or "API Blueprint"
    description_lines: List[str] = []
    types: List[ApiblueprintType] = []
    operations: List[ApiblueprintOperation] = []

    index = 0
    while index < len(lines):
        line = lines[index]
        stripped = line.strip()
        if not stripped:
            index += 1
            continue
        format_match = _FORMAT_RE.match(stripped)
        if format_match:
            format_version = format_match.group(1)
            index += 1
            continue
        host_match = _HOST_RE.match(stripped)
        if host_match:
            host = host_match.group(1)
            index += 1
            continue
        if stripped.startswith("#"):
            break
        index += 1

    if index < len(lines) and lines[index].startswith("# ") and not lines[index].startswith("##"):
        title = lines[index][2:].strip() or title
        index += 1

    current_resource_path: Optional[str] = None
    resource_params: List[ApiblueprintParameter] = []
    current_type: Optional[ApiblueprintType] = None
    type_fields: List[ApiblueprintField] = []
    type_enum_values: List[str] = []
    in_data_structures = False
    in_parameters_block = False
    action_name: Optional[str] = None
    action_method: Optional[str] = None
    action_path: Optional[str] = None
    action_params: List[ApiblueprintParameter] = []
    request_media_type: Optional[str] = None
    request_type: Optional[str] = None
    responses: List[Tuple[str, Optional[str], Optional[str]]] = []
    pending_response_status: Optional[str] = None
    pending_response_media: Optional[str] = None

    def flush_pending_response() -> None:
        nonlocal pending_response_status, pending_response_media
        if pending_response_status is not None and action_name is not None:
            responses.append(
                (pending_response_status, pending_response_media, None)
            )
        pending_response_status = None
        pending_response_media = None

    def flush_type() -> None:
        nonlocal current_type, type_fields, type_enum_values
        if current_type is None:
            return
        types.append(
            ApiblueprintType(
                name=current_type.name,
                kind=current_type.kind,
                fields=tuple(type_fields),
                enum_values=tuple(type_enum_values),
                description=current_type.description,
            )
        )
        current_type = None
        type_fields = []
        type_enum_values = []

    def flush_operation() -> None:
        nonlocal action_name, action_method, action_path, action_params
        nonlocal request_media_type, request_type, responses
        nonlocal pending_response_status, pending_response_media
        if action_name is None or action_method is None or action_path is None:
            flush_pending_response()
            action_name = None
            action_method = None
            action_path = None
            action_params = []
            request_media_type = None
            request_type = None
            responses = []
            pending_response_status = None
            pending_response_media = None
            return
        flush_pending_response()
        operations.append(
            _finalize_operation(
                name=action_name,
                method=action_method,
                path=action_path,
                resource_params=resource_params,
                action_params=action_params,
                request_media_type=request_media_type,
                request_type=request_type,
                responses=responses,
            )
        )
        action_name = None
        action_method = None
        action_path = None
        action_params = []
        request_media_type = None
        request_type = None
        responses = []
        pending_response_status = None
        pending_response_media = None

    while index < len(lines):
        line = lines[index]
        stripped = line.strip()

        if _DATA_STRUCTURES_RE.match(stripped):
            flush_operation()
            flush_type()
            in_data_structures = True
            current_resource_path = None
            resource_params = []
            in_parameters_block = False
            index += 1
            continue

        if in_data_structures:
            type_match = _TYPE_DEF_RE.match(stripped)
            if type_match:
                flush_type()
                current_type = ApiblueprintType(
                    name=type_match.group(1),
                    kind=type_match.group(2).lower(),
                    fields=(),
                    enum_values=(),
                )
                index += 1
                continue
            if current_type is not None:
                field = _parse_field_line(line)
                if field is not None:
                    type_fields.append(field)
                    index += 1
                    continue
                enum_member = _ENUM_MEMBER_RE.match(stripped)
                if enum_member and current_type.kind == "enum":
                    type_enum_values.append(enum_member.group(1))
                    index += 1
                    continue
            index += 1
            continue

        resource_match = _RESOURCE_RE.match(stripped)
        if resource_match:
            flush_operation()
            current_resource_path = _normalize_path(resource_match.group(2))
            resource_params = []
            in_parameters_block = False
            index += 1
            continue

        action_match = _ACTION_RE.match(stripped)
        if action_match and current_resource_path is not None:
            flush_operation()
            action_name = action_match.group(1).strip()
            action_method = action_match.group(2).upper()
            action_path = _join_paths(current_resource_path, action_match.group(3))
            action_params = []
            in_parameters_block = False
            index += 1
            continue

        if stripped == "+ Parameters":
            in_parameters_block = True
            index += 1
            continue

        if in_parameters_block:
            param = _parse_parameter_line(line)
            if param is not None:
                if action_name is not None:
                    action_params.append(param)
                else:
                    resource_params.append(param)
                index += 1
                continue
            if stripped.startswith("+") or stripped.startswith("#"):
                in_parameters_block = False
                continue
            index += 1
            continue

        request_match = _REQUEST_RE.match(stripped)
        if request_match and action_name is not None:
            request_media_type = request_match.group(1).strip()
            index += 1
            continue

        response_match = _RESPONSE_RE.match(stripped)
        if response_match and action_name is not None:
            flush_pending_response()
            pending_response_status = response_match.group(1)
            pending_response_media = (
                response_match.group(2).strip() if response_match.group(2) else None
            )
            index += 1
            continue

        attributes_match = _ATTRIBUTES_RE.match(stripped)
        if attributes_match and action_name is not None:
            type_name = attributes_match.group(1).strip()
            if pending_response_status is not None:
                responses.append(
                    (pending_response_status, pending_response_media, type_name)
                )
                pending_response_status = None
                pending_response_media = None
            elif request_media_type is not None:
                request_type = type_name
            index += 1
            continue

        if (
            action_name is None
            and current_resource_path is None
            and stripped
            and not stripped.startswith("+")
            and not stripped.startswith("#")
        ):
            description_lines.append(stripped)

        index += 1

    flush_operation()
    flush_type()

    if not types and not operations:
        label = f" ({source_label})" if source_label else ""
        raise ApiblueprintParseError(f"No API Blueprint resources or data structures found{label}")

    description = "\n".join(description_lines).strip() or None
    return ApiblueprintDocument(
        format_version=format_version,
        title=title,
        host=host,
        description=description,
        types=tuple(types),
        operations=tuple(operations),
        raw=content,
    )
