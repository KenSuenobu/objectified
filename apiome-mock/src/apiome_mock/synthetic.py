"""Turning a described request into a real one, and a real response back into JSON (#5532, MSC-2.2).

Two callers need to serve a request the runtime did not receive over its own socket: the dry-run
preview (#5528, MSC-1.2) and the hosted sandbox (:mod:`apiome_mock.sandbox`), which serves the
ephemeral instances apiome-rest provisions. Both are handed a *description* of a request over an
internal HTTP hop and must produce something :func:`apiome_mock.handler.serve_compiled_request`
cannot tell apart from live traffic, then render what came back as JSON the caller can read.

That translation is this module, factored out of ``preview`` so the two paths cannot drift. It is
the only reason a request built here is trustworthy: the ASGI scope mirrors what uvicorn would
produce for the equivalent live call — full URL path, encoded query string, the caller's headers,
and a receive channel that yields the body exactly once — so nothing inside the serving path can
branch on how it was invoked.
"""

from __future__ import annotations

import base64
import json
from dataclasses import dataclass, field
from typing import Any, Mapping, Sequence
from urllib.parse import urlencode

from fastapi import Request

from apiome_mock.scenarios import MOCK_SCENARIO_HEADER

__all__ = [
    "ENCODING_BASE64",
    "ENCODING_EMPTY",
    "ENCODING_JSON",
    "ENCODING_TEXT",
    "SyntheticRequest",
    "build_synthetic_request",
    "decode_response_body",
]

#: Media types whose body is returned as parsed JSON rather than text.
_JSON_SUFFIXES = ("json",)

#: Body encodings reported alongside a rendered body.
ENCODING_JSON = "json"
ENCODING_TEXT = "text"
ENCODING_BASE64 = "base64"
ENCODING_EMPTY = "empty"

#: Query parameter that pins synthesis. Declared here rather than imported from
#: :mod:`apiome_mock.handler` to keep this module free of the serving path it feeds.
SEED_QUERY_PARAM = "__seed"


@dataclass(frozen=True)
class SyntheticRequest:
    """A request described over the wire rather than received on a socket.

    Attributes:
        method: HTTP method; case-insensitive, upper-cased before routing.
        path: Path *relative to* the version root (``/pets/42``, not
            ``/acme/petstore/1.0.0/pets/42``). A ``?query`` suffix is accepted and merged into
            ``query``, so a pasted URL works.
        headers: Request headers. ``scenario`` and ``seed`` below are sugar over the header and
            query parameter the data plane reads, and never overwrite an explicit value.
        query: Query parameters; a bare string value is treated as a single-valued parameter.
        body: Request body. A mapping or sequence is JSON-encoded (and defaults the content type
            to ``application/json``); a string is sent as-is; ``None`` sends no body.
        scenario: Convenience for the ``X-Mock-Scenario`` header.
        seed: Convenience for the ``?__seed=`` query parameter that pins synthesis.
    """

    method: str = "GET"
    path: str = "/"
    headers: Mapping[str, str] = field(default_factory=dict)
    query: Mapping[str, str | Sequence[str]] = field(default_factory=dict)
    body: Any = None
    scenario: str | None = None
    seed: int | None = None

    @property
    def relative_path(self) -> str:
        """The spec-relative path with any ``?`` suffix stripped and a leading slash guaranteed."""
        path, _, _ = self.path.partition("?")
        return "/" + path.strip("/") if path.strip("/") else "/"

    @property
    def inline_query(self) -> str:
        """The query string carried inside :attr:`path`, empty when there is none."""
        _, _, query = self.path.partition("?")
        return query


def _normalized_query(spec: SyntheticRequest) -> list[tuple[str, str]]:
    """Flatten the declared query parameters, the inline ``?`` suffix, and the seed sugar.

    Args:
        spec: The described request.

    Returns:
        Ordered ``(name, value)`` pairs ready to URL-encode. A declared ``__seed`` always wins over
        the :attr:`SyntheticRequest.seed` shorthand.
    """
    pairs: list[tuple[str, str]] = []
    for chunk in spec.inline_query.split("&"):
        if not chunk:
            continue
        inline_name, _, inline_value = chunk.partition("=")
        pairs.append((inline_name, inline_value))
    for name, value in spec.query.items():
        if isinstance(value, (list, tuple)):
            pairs.extend((name, str(item)) for item in value)
        else:
            pairs.append((name, str(value)))
    if spec.seed is not None and not any(name == SEED_QUERY_PARAM for name, _ in pairs):
        pairs.append((SEED_QUERY_PARAM, str(spec.seed)))
    return pairs


def _encoded_body(body: Any, headers: dict[str, str]) -> bytes:
    """Encode the declared request body, defaulting the content type for JSON values.

    Args:
        body: The declared body (mapping/sequence, string, bytes, or ``None``).
        headers: The header map, mutated to add ``content-type`` when a JSON value needs one.

    Returns:
        The request body bytes (empty when no body was declared).
    """
    if body is None:
        return b""
    if isinstance(body, bytes):
        return body
    if isinstance(body, str):
        return body.encode("utf-8")
    headers.setdefault("content-type", "application/json")
    return json.dumps(body).encode("utf-8")


def build_synthetic_request(
    spec: SyntheticRequest,
    *,
    tenant: str,
    project: str,
    version: str,
    host: str = "internal.invalid",
) -> Request:
    """Build the Starlette request the serving pass will read.

    Args:
        spec: The described request.
        tenant: Tenant slug, for the URL path.
        project: Project slug, for the URL path.
        version: Version label, for the URL path.
        host: Host header to synthesise when the caller declared none.

    Returns:
        The request, ready to hand to the serving pass.
    """
    headers = {name.lower(): value for name, value in spec.headers.items()}
    if spec.scenario and MOCK_SCENARIO_HEADER.lower() not in headers:
        headers[MOCK_SCENARIO_HEADER.lower()] = spec.scenario
    payload = _encoded_body(spec.body, headers)
    query_string = urlencode(_normalized_query(spec))

    suffix = spec.relative_path.lstrip("/")
    full_path = f"/{tenant}/{project}/{version}" + (f"/{suffix}" if suffix else "")
    raw_headers = [(name.encode("latin-1"), value.encode("latin-1")) for name, value in headers.items()]
    if not any(name == b"host" for name, _ in raw_headers):
        raw_headers.append((b"host", host.encode("latin-1")))

    scope: dict[str, Any] = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": spec.method.upper(),
        "scheme": "https",
        "path": full_path,
        "raw_path": full_path.encode("utf-8"),
        "root_path": "",
        "query_string": query_string.encode("latin-1"),
        "headers": raw_headers,
        "client": ("127.0.0.1", 0),
        "server": (host, 443),
    }

    delivered = False

    async def receive() -> dict[str, Any]:
        """Yield the body once, then hold the connection open the way a real one would."""
        nonlocal delivered
        if delivered:
            return {"type": "http.disconnect"}
        delivered = True
        return {"type": "http.request", "body": payload, "more_body": False}

    return Request(scope, receive)


def decode_response_body(payload: bytes, media_type: str) -> tuple[Any, str]:
    """Decode a served response body into the shape a JSON client can read.

    Args:
        payload: The response body bytes exactly as the data plane would put them on the wire.
        media_type: The response media type.

    Returns:
        ``(body, encoding)`` — parsed JSON, decoded text, base64 for binary, or ``(None, "empty")``.
    """
    if not payload:
        return None, ENCODING_EMPTY
    base = media_type.split(";", 1)[0].strip().lower()
    if base.endswith(_JSON_SUFFIXES):
        try:
            return json.loads(payload), ENCODING_JSON
        except (json.JSONDecodeError, UnicodeDecodeError):
            pass
    try:
        return payload.decode("utf-8"), ENCODING_TEXT
    except UnicodeDecodeError:
        return base64.b64encode(payload).decode("ascii"), ENCODING_BASE64
