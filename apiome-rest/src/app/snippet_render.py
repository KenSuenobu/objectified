"""Per-operation usage-snippet rendering — SDK-2.3 (#4487).

Pure functions that turn one HTTP operation of a persisted :class:`~app.canonical_model.CanonicalApi`
into a runnable usage snippet (install line + call code) for ``ts`` (built-in ``fetch``),
``python`` (``httpx``) or ``curl``. This module is the **single source of truth** for
per-operation snippets: the browse operation pages (SDK-3.3) and the Try It copy-as-code
feature (SIM-3.5) consume it through :mod:`app.snippet_routes` instead of hand-rolling their
own generators.

Output parity: the emitted curl/fetch/httpx shapes, string escaping, and secret-placeholder
tokens intentionally mirror the client-side generators in
``apiome-browse/lib/tryit/snippet.ts`` and ``apiome-browse/lib/tryit/secrets.ts`` — when one
side changes, change the other. Unlike the client (which redacts real user-entered values),
this module synthesizes placeholder values directly, so no credential material ever exists
server-side.

Determinism: request synthesis uses fixed defaults and the seed-0 instance synthesizer
(:func:`app.schema_instance_synthesis.synthesize_instances`), so repeated renders of the same
canonical content are byte-identical — which is what lets the routes serve content-addressed
``ETag``s.

Known limitation: the canonical model does not record security schemes, so auth material in
snippets comes only from *name-based* inference over declared header/query parameters (the
same rule set the browse Try It panel applies). Operations whose auth is declared solely via
OpenAPI ``security`` render without auth headers.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote, unquote

from .canonical_json_schema import build_ref_json_schema
from .canonical_model import (
    CanonicalApi,
    Message,
    MessageRole,
    Operation,
    Parameter,
    ParameterLocation,
    Server,
)
from .schema_instance_synthesis import synthesize_instances

# ===========================================================================
# Language registry
# ===========================================================================

# Canonical language keys, in documentation order.
SUPPORTED_LANGS: Tuple[str, ...] = ("ts", "python", "curl")

# Browse Try It vocabulary accepted as aliases (`SnippetTarget` in snippet.ts).
LANG_ALIASES: Dict[str, str] = {"fetch": "ts", "httpx": "python"}

# Install line per canonical language; ``None`` means nothing to install
# (fetch is built into modern runtimes, curl ships with the OS).
INSTALL_LINES: Dict[str, Optional[str]] = {
    "ts": None,
    "python": "pip install httpx",
    "curl": None,
}

# Base URL used when the canonical model declares no servers at all.
FALLBACK_SERVER_URL = "https://api.example.com"


def resolve_lang(raw: str) -> Optional[str]:
    """Resolve a requested ``lang`` value to its canonical key.

    Args:
        raw: The raw query-parameter value (canonical key or browse alias).

    Returns:
        One of :data:`SUPPORTED_LANGS`, or ``None`` when the value is unknown.
    """
    token = (raw or "").strip().lower()
    token = LANG_ALIASES.get(token, token)
    return token if token in SUPPORTED_LANGS else None


# ===========================================================================
# Operation lookup
# ===========================================================================


def find_operation(api: CanonicalApi, operation_id: str) -> Optional[Operation]:
    """Find one operation by id, name, or canonical key.

    Candidates are compared in declaration order; per operation the match precedence is
    ``extras["operationId"]`` → ``name`` → ``key``. The requested id is URL-unquoted first,
    so canonical keys containing spaces/slashes (``GET /pets/{id}``) are addressable as
    ``GET%20%2Fpets%2F%7Bid%7D`` by paradigms that have no operationId. (The routes declare
    ``operation_id`` as a ``:path`` parameter, so a key whose slashes survive the transport
    decode still arrives whole and matches here without further decoding.)

    Args:
        api: The canonical model to search.
        operation_id: The requested identifier (possibly URL-encoded).

    Returns:
        The first matching :class:`~app.canonical_model.Operation`, or ``None``.
    """
    wanted = unquote(operation_id or "")
    for op in api.operations():
        candidates = (op.extras.get("operationId"), op.name, op.key)
        if any(candidate == wanted for candidate in candidates if candidate):
            return op
    return None


# ===========================================================================
# Secret placeholder parity (port of apiome-browse/lib/tryit/secrets.ts)
# ===========================================================================

SECRET_HEADER_NAMES = re.compile(
    r"^(authorization|proxy-authorization|x-api-key|api-key|x-auth-token|x-access-token)$",
    re.IGNORECASE,
)

SECRET_QUERY_NAMES = re.compile(r"^(api_key|apikey|access_token|token|key)$", re.IGNORECASE)

_API_KEY_NAME = re.compile(r"api.?key", re.IGNORECASE)
_TOKEN_NAME = re.compile(r"token", re.IGNORECASE)


def placeholder_for_header(name: str) -> str:
    """Placeholder token for a credential-carrying header (parity with secrets.ts)."""
    if re.fullmatch(r"authorization", name, re.IGNORECASE):
        return "$AUTHORIZATION"
    if _API_KEY_NAME.search(name):
        return "$API_KEY"
    if _TOKEN_NAME.search(name):
        return "$ACCESS_TOKEN"
    return "$SECRET"


def placeholder_for_query_param(name: str) -> str:
    """Placeholder token for a credential-carrying query parameter (parity with secrets.ts)."""
    if _API_KEY_NAME.search(name):
        return "$API_KEY"
    if _TOKEN_NAME.search(name):
        return "$ACCESS_TOKEN"
    return "$SECRET"


# ===========================================================================
# Result shapes
# ===========================================================================


@dataclass(frozen=True)
class SnippetPlaceholder:
    """One substitutable token the caller should replace before running the snippet.

    Attributes:
        token: The literal token appearing in the snippet (``PET_ID``, ``$API_KEY``).
        kind: What the token stands in for — ``path`` / ``query`` / ``header`` /
            ``server`` for structural placeholders, ``secret`` for credentials.
        name: The source parameter/variable name the token derives from.
        location: For ``secret`` placeholders, where the credential travels
            (``header`` or ``query``); ``None`` otherwise.
    """

    token: str
    kind: str
    name: str
    location: Optional[str] = None


@dataclass(frozen=True)
class SnippetRequest:
    """The synthesized request a snippet renders — mirrors ``SnippetRequest`` in snippet.ts.

    Attributes:
        method: Upper-case HTTP method.
        url: Absolute target URL (server base + filled path + query string).
        headers: Request headers, including ``Content-Type`` when a body is present.
        body: Raw request body text, or ``None`` for body-less requests.
        body_json: The parsed body value when the body is JSON, else ``None`` (lets the
            httpx renderer emit a Python literal without re-parsing ``body``).
    """

    method: str
    url: str
    headers: Dict[str, str]
    body: Optional[str]
    body_json: Optional[Any] = None


@dataclass(frozen=True)
class SnippetRender:
    """One rendered snippet plus the structured request it encodes.

    Attributes:
        lang: The canonical language key (``ts`` / ``python`` / ``curl``).
        install: Shell command installing the snippet's dependency, or ``None``.
        code: The runnable call snippet.
        request: The synthesized request the code was rendered from.
        placeholders: Every substitutable token in the request, in synthesis order.
    """

    lang: str
    install: Optional[str]
    code: str
    request: SnippetRequest
    placeholders: List[SnippetPlaceholder] = field(default_factory=list)


class SnippetRenderError(Exception):
    """Raised when an operation cannot be rendered as an HTTP snippet (routes map to 422)."""


# ===========================================================================
# Request synthesis
# ===========================================================================


def _upper_snake(name: str) -> str:
    """Derive a shouting-snake placeholder token from a parameter/variable name.

    ``petId`` → ``PET_ID``; non-alphanumeric runs collapse to a single underscore.
    """
    spaced = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", name or "")
    token = re.sub(r"[^A-Za-z0-9]+", "_", spaced).strip("_").upper()
    return token or "VALUE"


def resolve_server_base(api: CanonicalApi) -> Tuple[str, List[SnippetPlaceholder]]:
    """Pick the base URL: first declared server with variable defaults substituted.

    Variables without a default become upper-snake placeholder tokens; a model with no
    servers falls back to :data:`FALLBACK_SERVER_URL` (recorded as a ``server`` placeholder
    so consumers know the base URL is not real). Any trailing slash is trimmed, so a caller
    can concatenate a path onto the result.

    Public because the bulk request-file emitter
    (:class:`app.http_file_emitter.HttpFileEmitter`) writes this exact string as its
    ``@baseUrl`` variable: taking it from here rather than re-deriving it is what stops the
    emitted variable and the emitted request lines from disagreeing (FMT-2.4, #5422).

    Args:
        api: The canonical model whose servers are consulted.

    Returns:
        ``(base_url, placeholders)`` — the base URL and any server-variable placeholders it
        still contains.
    """
    placeholders: List[SnippetPlaceholder] = []
    if not api.servers:
        placeholders.append(
            SnippetPlaceholder(token=FALLBACK_SERVER_URL, kind="server", name="server")
        )
        return FALLBACK_SERVER_URL, placeholders

    server: Server = api.servers[0]
    url = server.url or FALLBACK_SERVER_URL
    defaults = {v.name: v.default for v in server.variables}
    for var_name in re.findall(r"\{([^{}]+)\}", url):
        default = defaults.get(var_name)
        if default is not None and str(default) != "":
            url = url.replace("{" + var_name + "}", str(default))
        else:
            token = _upper_snake(var_name)
            url = url.replace("{" + var_name + "}", token)
            placeholders.append(SnippetPlaceholder(token=token, kind="server", name=var_name))
    return url.rstrip("/"), placeholders


def _placeholder_value(param: Parameter) -> str:
    """Value for a non-secret parameter: its declared default, else an upper-snake token."""
    if param.default is not None and str(param.default) != "":
        return str(param.default)
    return _upper_snake(param.name)


def _request_message(op: Operation) -> Optional[Message]:
    """Return the operation's first request-role message, if any."""
    for message in op.messages:
        if message.role == MessageRole.REQUEST:
            return message
    return None


def _pick_content_type(message: Message) -> str:
    """Choose the body content type: first JSON-ish declared type, else first, else JSON."""
    for content_type in message.content_types:
        if "json" in content_type.lower():
            return content_type
    if message.content_types:
        return message.content_types[0]
    return "application/json"


def _synthesize_body(api: CanonicalApi, message: Message) -> Optional[Any]:
    """Produce the minimal valid instance for a request message's payload schema.

    Returns ``None`` when no schema is available or the synthesizer cannot produce a
    minimal instance (the snippet degrades to body-less rather than failing).
    """
    schema: Optional[Dict[str, Any]] = None
    if message.payload_schema is not None:
        schema = message.payload_schema
    elif message.payload is not None:
        schema = build_ref_json_schema(api, message.payload).document
    if not isinstance(schema, dict):
        return None
    try:
        result = synthesize_instances(
            schema,
            include_full=False,
            include_branches=False,
            include_mutants=False,
        )
    except Exception:
        return None
    for instance in result.instances:
        if instance.kind == "minimal" and instance.expected_valid:
            return instance.instance
    return None


def synthesize_request(
    api: CanonicalApi, op: Operation
) -> Tuple[SnippetRequest, List[SnippetPlaceholder]]:
    """Compose the deterministic example request one operation's snippets render.

    Fills path parameters with defaults or upper-snake tokens, includes only *required*
    query and header parameters (credential-named ones get ``$``-tokens per the secrets.ts
    parity rules), picks a content type from the request message, and synthesizes a minimal
    JSON body from the payload schema when one exists.

    Args:
        api: The canonical model the operation belongs to.
        op: The operation to synthesize a request for.

    Returns:
        The composed :class:`SnippetRequest` and its placeholder inventory.

    Raises:
        SnippetRenderError: When the operation has no HTTP binding (gRPC/GraphQL/event
            operations without ``http_method``/``http_path``).
    """
    if not op.http_method or not op.http_path:
        raise SnippetRenderError(
            f"Operation '{op.name or op.key}' has no HTTP binding; "
            "snippets are only available for HTTP operations"
        )

    base_url, placeholders = resolve_server_base(api)
    method = op.http_method.upper()

    path = op.http_path if op.http_path.startswith("/") else "/" + op.http_path
    for param in op.parameters:
        if param.location != ParameterLocation.PATH:
            continue
        value = _placeholder_value(param)
        if param.default is None or str(param.default) == "":
            placeholders.append(SnippetPlaceholder(token=value, kind="path", name=param.name))
        path = path.replace("{" + param.name + "}", quote(value, safe=""))

    query_parts: List[str] = []
    for param in op.parameters:
        if param.location != ParameterLocation.QUERY or not param.required:
            continue
        if SECRET_QUERY_NAMES.match(param.name):
            token = placeholder_for_query_param(param.name)
            placeholders.append(
                SnippetPlaceholder(token=token, kind="secret", name=param.name, location="query")
            )
            query_parts.append(f"{quote(param.name, safe='')}={token}")
        else:
            value = _placeholder_value(param)
            if param.default is None or str(param.default) == "":
                placeholders.append(
                    SnippetPlaceholder(token=value, kind="query", name=param.name)
                )
                # Tokens stay literal (they are meant to be substituted by the reader).
                query_parts.append(f"{quote(param.name, safe='')}={value}")
            else:
                query_parts.append(f"{quote(param.name, safe='')}={quote(value, safe='')}")

    url = base_url + path + ("?" + "&".join(query_parts) if query_parts else "")

    headers: Dict[str, str] = {}
    for param in op.parameters:
        if param.location != ParameterLocation.HEADER or not param.required:
            continue
        if SECRET_HEADER_NAMES.match(param.name):
            token = placeholder_for_header(param.name)
            placeholders.append(
                SnippetPlaceholder(token=token, kind="secret", name=param.name, location="header")
            )
            headers[param.name] = token
        else:
            value = _placeholder_value(param)
            if param.default is None or str(param.default) == "":
                placeholders.append(
                    SnippetPlaceholder(token=value, kind="header", name=param.name)
                )
            headers[param.name] = value

    body: Optional[str] = None
    body_json: Optional[Any] = None
    message = _request_message(op)
    if message is not None and (message.payload_schema is not None or message.payload is not None):
        content_type = _pick_content_type(message)
        if "json" in content_type.lower():
            instance = _synthesize_body(api, message)
            if instance is not None:
                body_json = instance
                body = json.dumps(instance, indent=2)
                headers["Content-Type"] = content_type
        # Non-JSON bodies (multipart, binary, …) are omitted: there is no meaningful
        # deterministic example to synthesize, and a wrong one is worse than none.

    request = SnippetRequest(
        method=method, url=url, headers=headers, body=body, body_json=body_json
    )
    return request, placeholders


# ===========================================================================
# String escaping (parity with snippet.ts)
# ===========================================================================


def shell_quote(value: str) -> str:
    """POSIX shell single-quoted string with embedded single quotes escaped."""
    if value == "":
        return "''"
    return "'" + value.replace("'", "'\\''") + "'"


def js_single_quote(value: str) -> str:
    """JavaScript single-quoted string literal."""
    escaped = (
        value.replace("\\", "\\\\")
        .replace("'", "\\'")
        .replace("\n", "\\n")
        .replace("\r", "\\r")
        .replace("\t", "\\t")
    )
    return f"'{escaped}'"


def python_double_quote(value: str) -> str:
    """Python double-quoted string literal."""
    escaped = (
        value.replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\n", "\\n")
        .replace("\r", "\\r")
        .replace("\t", "\\t")
    )
    return f'"{escaped}"'


def format_python_literal(value: Any, indent_level: int) -> str:
    """Render a JSON-compatible value as a Python literal (dict/list/str/number/bool/None)."""
    indent = "    " * indent_level
    child_indent = "    " * (indent_level + 1)
    if value is None:
        return "None"
    if isinstance(value, bool):
        return "True" if value else "False"
    if isinstance(value, (int, float)):
        return json.dumps(value)
    if isinstance(value, str):
        return python_double_quote(value)
    if isinstance(value, list):
        if not value:
            return "[]"
        items = [
            f"{child_indent}{format_python_literal(entry, indent_level + 1)}," for entry in value
        ]
        return "[\n" + "\n".join(items) + f"\n{indent}]"
    if isinstance(value, dict):
        if not value:
            return "{}"
        lines = [
            f"{child_indent}{python_double_quote(str(key))}: "
            f"{format_python_literal(entry, indent_level + 1)},"
            for key, entry in value.items()
        ]
        return "{\n" + "\n".join(lines) + f"\n{indent}}}"
    return python_double_quote(str(value))


# ===========================================================================
# Per-language renderers (parity with snippet.ts)
# ===========================================================================


def render_curl(request: SnippetRequest) -> str:
    """Render one synthesized request as a single-line ``curl`` command.

    ``-X`` appears only for non-GET methods, one ``-H`` per header in synthesis order,
    and ``--data-raw`` for a body — every argument POSIX-quoted by :func:`shell_quote`.

    Public because the bulk request-file emitter
    (:class:`app.http_file_emitter.HttpFileEmitter`) renders its ``curl`` output mode
    through *this* function, which is what makes a single-operation snippet and the
    whole-API script byte-identical for the same operation (FMT-2.4, #5422).

    Args:
        request: The synthesized request to render.

    Returns:
        The one-line ``curl`` command.
    """
    parts = ["curl"]
    if request.method != "GET":
        parts.extend(["-X", request.method])
    parts.append(shell_quote(request.url))
    for name, value in request.headers.items():
        parts.extend(["-H", shell_quote(f"{name}: {value}")])
    if request.body is not None:
        parts.extend(["--data-raw", shell_quote(request.body)])
    return " ".join(parts)


def _render_fetch(request: SnippetRequest) -> str:
    """``await fetch(...)`` call; ``method:`` omitted for GET, trailing ``response.json()``."""
    lines = [f"const response = await fetch({js_single_quote(request.url)}, {{"]
    if request.method != "GET":
        lines.append(f"  method: {js_single_quote(request.method)},")
    if request.headers:
        lines.append("  headers: {")
        for name, value in request.headers.items():
            lines.append(f"    {js_single_quote(name)}: {js_single_quote(value)},")
        lines.append("  },")
    if request.body is not None:
        lines.append(f"  body: {js_single_quote(request.body)},")
    lines.append("});")
    lines.append("")
    lines.append("const data = await response.json();")
    return "\n".join(lines)


def _render_httpx(request: SnippetRequest) -> str:
    """``httpx.request(...)`` call; JSON bodies as ``json=`` Python literals."""
    lines = ["import httpx", "", "response = httpx.request("]
    lines.append(f"    {python_double_quote(request.method)},")
    lines.append(f"    {python_double_quote(request.url)},")
    if request.headers:
        lines.append("    headers={")
        for name, value in request.headers.items():
            lines.append(f"        {python_double_quote(name)}: {python_double_quote(value)},")
        lines.append("    },")
    if request.body is not None:
        if request.body_json is not None:
            lines.append(f"    json={format_python_literal(request.body_json, 1)},")
        else:
            lines.append(f"    content={python_double_quote(request.body)},")
    lines.append(")")
    lines.append("response.raise_for_status()")
    return "\n".join(lines)


_RENDERERS = {"curl": render_curl, "ts": _render_fetch, "python": _render_httpx}


def render_snippet(api: CanonicalApi, op: Operation, lang: str) -> SnippetRender:
    """Render the install + call snippet for one operation in one canonical language.

    Args:
        api: The canonical model the operation belongs to.
        op: The operation to render (must have an HTTP binding).
        lang: A canonical language key from :data:`SUPPORTED_LANGS`.

    Returns:
        The :class:`SnippetRender` with code, install line, request, and placeholders.

    Raises:
        SnippetRenderError: When the operation has no HTTP binding.
        KeyError: When ``lang`` is not a canonical key (routes validate via
            :func:`resolve_lang` first).
    """
    request, placeholders = synthesize_request(api, op)
    return SnippetRender(
        lang=lang,
        install=INSTALL_LINES[lang],
        code=_RENDERERS[lang](request),
        request=request,
        placeholders=placeholders,
    )
