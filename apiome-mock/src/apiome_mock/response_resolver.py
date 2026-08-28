"""Example-first response body resolver for the mock data plane (SIM-1.2).

Given an OpenAPI response object, resolve the response body and media type using
author-provided examples before schema-driven synthesis. Honors ``Accept`` for
media-type negotiation and ``Prefer: example=<name>`` for named example selection.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from apiome_mock.schema_synthesizer import generate_example, validate_value

_NOT_FOUND = object()


@dataclass(frozen=True)
class ResolvedResponseBody:
    """A resolved mock response body for one operation status."""

    body: Any
    media_type: str
    validation_error: str | None = None
    not_acceptable: bool = False


def parse_prefer_code(prefer_header: str | None) -> int | None:
    """Return the ``code=<status>`` token from an RFC 7240 ``Prefer`` header."""
    if not prefer_header or not prefer_header.strip():
        return None
    for token in prefer_header.split(","):
        part = token.strip()
        if not part.lower().startswith("code="):
            continue
        raw = part.split("=", 1)[1].strip()
        if raw.startswith('"') and raw.endswith('"') and len(raw) >= 2:
            raw = raw[1:-1]
        try:
            return int(raw)
        except ValueError:
            continue
    return None


def parse_forced_status(prefer_header: str | None, query_params: Any) -> int | None:
    """Return a forced HTTP status from ``Prefer: code=`` or ``?__status=``."""
    code = parse_prefer_code(prefer_header)
    if code is not None:
        return code
    raw = query_params.get("__status")
    if raw is None:
        return None
    try:
        return int(str(raw).strip())
    except ValueError:
        return None


def select_response_by_status(
    operation: dict[str, Any],
    status: int,
) -> tuple[int, dict[str, Any] | None]:
    """Locate the response object for ``status`` (exact code, then ``default``)."""
    responses = operation.get("responses")
    if not isinstance(responses, dict):
        return status, None
    if str(status) in responses:
        response_obj = responses[str(status)]
        return status, response_obj if isinstance(response_obj, dict) else None
    if status in responses:
        response_obj = responses[status]
        return status, response_obj if isinstance(response_obj, dict) else None
    default_obj = responses.get("default")
    return status, default_obj if isinstance(default_obj, dict) else None


def match_request_content_type(
    request_content_type: str | None,
    allowed_types: list[str],
) -> str | None:
    """Return the declared request media type that matches ``Content-Type``, if any."""
    if not allowed_types:
        return None
    if not request_content_type or not request_content_type.strip():
        return None
    primary = request_content_type.split(";", 1)[0].strip().lower()
    for media_type in allowed_types:
        if primary == media_type.strip().lower() or _media_type_matches(primary, media_type):
            return media_type
    return None


def parse_prefer_example(prefer_header: str | None) -> str | None:
    """Return the ``example=<name>`` token from an RFC 7240 ``Prefer`` header."""
    if not prefer_header or not prefer_header.strip():
        return None
    for token in prefer_header.split(","):
        part = token.strip()
        if not part.lower().startswith("example="):
            continue
        name = part.split("=", 1)[1].strip()
        if name.startswith('"') and name.endswith('"') and len(name) >= 2:
            name = name[1:-1]
        return name or None
    return None


def select_default_success_status(operation: dict[str, Any]) -> tuple[int, dict[str, Any] | None]:
    """Pick the lowest 2xx response for an operation, else ``default``, else 200."""
    responses = operation.get("responses")
    if not isinstance(responses, dict) or not responses:
        return 200, None
    success_codes = sorted(int(code) for code in responses if str(code).isdigit() and 200 <= int(code) < 300)
    if success_codes:
        code = success_codes[0]
        response_obj = responses.get(code)
        if response_obj is None:
            response_obj = responses.get(str(code))
        return code, response_obj if isinstance(response_obj, dict) else None
    if "default" in responses:
        default_obj = responses.get("default")
        return 200, default_obj if isinstance(default_obj, dict) else None
    first = sorted(responses.keys(), key=str)[0]
    status = int(first) if str(first).isdigit() else 200
    response_obj = responses[first]
    return status, response_obj if isinstance(response_obj, dict) else None


def _parse_accept_header(accept: str | None) -> list[tuple[str, float]]:
    if not accept or not accept.strip():
        return [("*/*", 1.0)]
    ranges: list[tuple[str, float]] = []
    for part in accept.split(","):
        piece = part.strip()
        if not piece:
            continue
        media = piece
        quality = 1.0
        if ";" in piece:
            media, _, params = piece.partition(";")
            media = media.strip()
            for param in params.split(";"):
                param = param.strip()
                if param.lower().startswith("q="):
                    try:
                        quality = float(param[2:].strip())
                    except ValueError:
                        quality = 1.0
        if quality <= 0:
            continue
        ranges.append((media.lower(), quality))
    return ranges


def _media_type_matches(accept_range: str, media_type: str) -> bool:
    accept_range = accept_range.strip().lower()
    media_type = media_type.strip().lower()
    if accept_range == "*/*":
        return True
    if "/" not in accept_range or "/" not in media_type:
        return False
    accept_type, _, accept_subtype = accept_range.partition("/")
    media_type_name, _, media_subtype = media_type.partition("/")
    if accept_subtype == "*":
        return accept_type == media_type_name
    return accept_type == media_type_name and accept_subtype == media_subtype


def _accepts_media_type(accept: str | None, media_type: str) -> bool:
    if not accept or not accept.strip():
        return True
    return any(_media_type_matches(rng, media_type) for rng, _ in _parse_accept_header(accept))


def negotiate_media_type(accept: str | None, content_types: list[str]) -> str | None:
    """Choose the best response media type for ``accept``; ``None`` means 406."""
    if not content_types:
        return None
    if not accept or not accept.strip():
        if "application/json" in content_types:
            return "application/json"
        return content_types[0]

    scored: list[tuple[float, int, int, int, str]] = []
    for index, media_type in enumerate(content_types):
        for accept_index, (accept_range, quality) in enumerate(_parse_accept_header(accept)):
            if not _media_type_matches(accept_range, media_type):
                continue
            if accept_range == "*/*":
                specificity = 0
            elif accept_range.endswith("/*"):
                specificity = 1
            else:
                specificity = 2
            scored.append((quality, specificity, -accept_index, -index, media_type))
            break
    if not scored:
        return None
    scored.sort(reverse=True)
    return scored[0][4]


def _example_value(entry: Any) -> Any:
    if isinstance(entry, dict) and "value" in entry:
        return entry["value"]
    return entry


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


def _resolve_body_at_media_type(
    media_obj: dict[str, Any],
    spec: dict[str, Any],
    *,
    prefer_example: str | None,
    seed: int,
    field: str,
) -> tuple[Any, str | None]:
    """Resolve a body for one media type object; ``_NOT_FOUND`` when nothing applies."""
    examples = media_obj.get("examples")
    if isinstance(examples, dict) and examples:
        if prefer_example and prefer_example in examples:
            return _example_value(examples[prefer_example]), None
        first_key = next(iter(examples))
        return _example_value(examples[first_key]), None

    if "example" in media_obj:
        return media_obj["example"], None

    schema = media_obj.get("schema")
    if not isinstance(schema, dict):
        return _NOT_FOUND, None

    schema = _deref_schema(schema, spec)
    if "example" in schema:
        return schema["example"], None
    if "default" in schema:
        return schema["default"], None
    enum = schema.get("enum")
    if isinstance(enum, list) and enum:
        return enum[0], None

    body = generate_example(schema, spec, seed=seed, field=field)
    error = validate_value(body, schema, spec)
    return body, error


def response_schema_for_media_type(
    response_obj: dict[str, Any] | None,
    spec: dict[str, Any],
    media_type: str,
) -> dict[str, Any] | None:
    """Return the response schema declared for one media type, ``$ref`` resolved.

    Correlation (#5527, MSC-1.1) rewrites a resolved body *after* it is chosen, so it needs the
    same schema :func:`resolve_response_body` validated the synthesized body against in order to
    re-check the correlated one. Kept here rather than duplicated in the caller so both the
    resolution and the re-check read the response object the same way.

    Args:
        response_obj: The operation's response object for the served status.
        spec: The full OpenAPI document, for ``$ref`` resolution.
        media_type: The media type actually served.

    Returns:
        The schema object, or ``None`` when the response declares no schema for that media type.
    """
    if not isinstance(response_obj, dict):
        return None
    content = response_obj.get("content")
    if not isinstance(content, dict):
        return None
    media_obj = content.get(media_type)
    if not isinstance(media_obj, dict):
        return None
    schema = media_obj.get("schema")
    if not isinstance(schema, dict):
        return None
    resolved = _deref_schema(schema, spec)
    return resolved or None


def _candidate_media_types(
    content: dict[str, Any],
    accept: str | None,
    negotiated: str,
) -> list[str]:
    ordered = list(content.keys())
    candidates = [negotiated]
    for media_type in ordered:
        if media_type == negotiated:
            continue
        if _accepts_media_type(accept, media_type):
            candidates.append(media_type)
    return candidates


def resolve_response_body(
    response_obj: dict[str, Any] | None,
    spec: dict[str, Any],
    *,
    accept: str | None = None,
    prefer_header: str | None = None,
    seed: int = 0,
    op_key: str = "root",
) -> ResolvedResponseBody:
    """Resolve body + media type for a response object using the example-first chain."""
    prefer_example = parse_prefer_example(prefer_header)
    if not isinstance(response_obj, dict):
        return ResolvedResponseBody(body=None, media_type="application/json")

    content = response_obj.get("content")
    if not isinstance(content, dict) or not content:
        return ResolvedResponseBody(body=None, media_type="application/json")

    content_types = list(content.keys())
    negotiated = negotiate_media_type(accept, content_types)
    if negotiated is None:
        return ResolvedResponseBody(
            body=None,
            media_type="application/json",
            not_acceptable=True,
        )

    for media_type in _candidate_media_types(content, accept, negotiated):
        media_obj = content.get(media_type)
        if not isinstance(media_obj, dict):
            continue
        body, validation_error = _resolve_body_at_media_type(
            media_obj,
            spec,
            prefer_example=prefer_example,
            seed=seed,
            field=op_key,
        )
        if body is not _NOT_FOUND:
            return ResolvedResponseBody(
                body=body,
                media_type=media_type,
                validation_error=validation_error,
            )

    return ResolvedResponseBody(
        body=None,
        media_type=negotiated,
    )
