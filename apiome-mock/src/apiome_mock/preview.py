"""Dry-run mock rendering: "given this request, what does the mock return?" (#5528, MSC-1.2).

A stored mock configuration is validated when it is saved, so it is guaranteed well-formed. That
answers the wrong question. The one an author actually has is *what comes back* — and until this
module existed the only way to find out was to enable a mock, send a real request to the data
plane with the right headers, and read the result.

Preview answers it without any of that. It takes a synthetic request and a compiled spec and hands
back the status, headers, media type and body the mock would serve, plus a **decision trace** that
names which layer produced the body: a scenario (and which rule), session-scoped CRUD, correlation
(and which pointers), or a declared example versus schema synthesis. Without the trace an author
can see *that* a value appeared but not *why*, which is most of the value of a preview.

Two properties make the answer trustworthy:

* **It is the real path.** :func:`render_preview` builds a Starlette request and calls
  :func:`apiome_mock.handler.serve_compiled_request` — the same function the hosted data plane and
  the portable runtime call, not a re-implementation of the sequence. A preview therefore cannot
  disagree with the served response; there is no second resolver to drift.
* **It never writes.** Session state goes to a store created for this one call and discarded with
  it, outbound callbacks are not dispatched, and no usage, audit or provisioning row is touched.
  Preview works on a version whose mock is disabled and one that has never been provisioned.

Chaos is the single deliberate departure, and it is *reported rather than applied*: a preview that
slept for a configured latency, or that randomly answered 500, would be answering a different
question than the one asked. The suppression is expressed as a compiled spec with its chaos knobs
removed rather than as a flag inside the serving path, so the shared code stays exactly the code
the data plane runs, and :attr:`PreviewResult.chaos` reports what would have applied.
"""

from __future__ import annotations

import base64
import json
from dataclasses import dataclass, field, replace
from typing import Any, Mapping, Sequence
from urllib.parse import urlencode

from fastapi import Request

from apiome_mock.chaos import EMPTY_CHAOS, ChaosKnobs, effective_knobs
from apiome_mock.handler import SEED_QUERY_PARAM, ServeTrace, serve_compiled_request
from apiome_mock.memory_session_store import InMemorySessionStore
from apiome_mock.scenarios import MOCK_SCENARIO_HEADER
from apiome_mock.session_store import SessionCaps
from apiome_mock.spec_loader import CompiledSpec

__all__ = [
    "ENCODING_BASE64",
    "ENCODING_EMPTY",
    "ENCODING_JSON",
    "ENCODING_TEXT",
    "PREVIEW_SESSION_CAPS",
    "PreviewChaos",
    "PreviewRequest",
    "PreviewResult",
    "render_preview",
    "trace_as_dict",
]

#: Caps for the throwaway session store one preview gets. Generous enough that a stateful preview
#: behaves like the real thing, and irrelevant to anyone else because the store is discarded when
#: the call returns.
PREVIEW_SESSION_CAPS = SessionCaps(
    ttl_seconds=60.0,
    max_resources=200,
    max_bytes=1_048_576,
    max_sessions=8,
)

#: Media types whose body is returned as parsed JSON rather than text.
_JSON_SUFFIXES = ("json",)

#: Body encodings reported alongside :attr:`PreviewResult.body`.
ENCODING_JSON = "json"
ENCODING_TEXT = "text"
ENCODING_BASE64 = "base64"
ENCODING_EMPTY = "empty"


@dataclass(frozen=True)
class PreviewRequest:
    """The synthetic request to render.

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


@dataclass(frozen=True)
class PreviewChaos:
    """The chaos the data plane would have applied to this request, and did not here.

    Attributes:
        suppressed: True when the version (or the active scenario) configures chaos for the
            matched operation. False means chaos changes nothing for this request, so the preview
            and the live response are identical in this respect too.
        delay_ms: Base injected delay the data plane would have slept, in milliseconds.
        jitter_ms: Uniform jitter half-width around that delay, in milliseconds.
        error_rate: Percent probability the data plane would have answered with an injected error.
    """

    suppressed: bool = False
    delay_ms: int = 0
    jitter_ms: int = 0
    error_rate: float = 0.0

    def as_dict(self) -> dict[str, Any]:
        """Render for JSON output."""
        return {
            "suppressed": self.suppressed,
            "delayMs": self.delay_ms,
            "jitterMs": self.jitter_ms,
            "errorRate": self.error_rate,
        }


@dataclass(frozen=True)
class PreviewResult:
    """What the mock would serve, and why.

    Attributes:
        operation: The canonical ``"METHOD /template"`` key of the matched operation; ``None``
            when nothing matched (the trace then says so, and ``status``/``body`` carry the
            problem document the data plane would have returned).
        path_params: Path template parameters routing extracted from the request.
        status: The HTTP status the mock would return.
        headers: The response headers the mock would return, including the ``X-Mock-*`` family.
        media_type: The negotiated response media type.
        body: The response body — parsed JSON, decoded text, or base64, per ``body_encoding``.
        body_encoding: One of ``json``, ``text``, ``base64``, ``empty``.
        trace: The decision trace naming which layer produced the body.
        chaos: What chaos the data plane would have applied.
    """

    operation: str | None
    path_params: Mapping[str, str]
    status: int
    headers: Mapping[str, str]
    media_type: str
    body: Any
    body_encoding: str
    trace: ServeTrace
    chaos: PreviewChaos

    def as_dict(self) -> dict[str, Any]:
        """Render the whole result as the JSON shape clients consume."""
        return {
            "operation": self.operation,
            "pathParams": dict(self.path_params),
            "status": self.status,
            "headers": dict(self.headers),
            "mediaType": self.media_type,
            "body": self.body,
            "bodyEncoding": self.body_encoding,
            "trace": trace_as_dict(self.trace),
            "chaos": self.chaos.as_dict(),
        }


def trace_as_dict(trace: ServeTrace) -> dict[str, Any]:
    """Render a :class:`~apiome_mock.handler.ServeTrace` as the preview's JSON trace object.

    Args:
        trace: The trace the serving pass filled in.

    Returns:
        A JSON-serializable object; keys whose value is absent are still present with ``null`` so
        clients can read a stable shape.
    """
    return {
        "layer": trace.layer,
        "detail": trace.detail,
        "scenario": trace.scenario,
        "scenarioSource": trace.scenario_source,
        "ruleIndex": trace.rule_index,
        "seed": trace.seed,
        "seedSource": trace.seed_source,
        "correlationMode": trace.correlation_mode,
        "correlationApplied": list(trace.correlation_applied),
        "correlationPointers": list(trace.correlation_pointers),
        "schemaValid": trace.schema_valid,
        "bodySource": trace.body_source,
        "exampleName": trace.example_name,
    }


def _normalized_query(spec: PreviewRequest, inline: str) -> list[tuple[str, str]]:
    """Flatten the declared query parameters, the inline ``?`` suffix, and the seed sugar.

    Args:
        spec: The preview request.
        inline: The query string found after ``?`` in :attr:`PreviewRequest.path`, if any.

    Returns:
        Ordered ``(name, value)`` pairs ready to URL-encode. A declared ``__seed`` always wins over
        the :attr:`PreviewRequest.seed` shorthand.
    """
    pairs: list[tuple[str, str]] = []
    for chunk in inline.split("&"):
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


def _build_request(
    spec: PreviewRequest,
    *,
    tenant: str,
    project: str,
    version: str,
    relative_path: str,
    inline_query: str,
) -> Request:
    """Build the Starlette request the serving pass will read.

    The scope mirrors what uvicorn would produce for the equivalent live call, so nothing in the
    serving path can tell the difference: the full hosted URL path, the encoded query string, the
    caller's headers, and a receive channel that yields the body exactly once.

    Args:
        spec: The preview request.
        tenant: Tenant slug, for the URL path.
        project: Project slug, for the URL path.
        version: Version label, for the URL path.
        relative_path: The spec-relative path, leading-slash normalized.
        inline_query: The query string carried in :attr:`PreviewRequest.path`, if any.

    Returns:
        The request, ready to hand to the serving pass.
    """
    headers = {name.lower(): value for name, value in spec.headers.items()}
    if spec.scenario and MOCK_SCENARIO_HEADER.lower() not in headers:
        headers[MOCK_SCENARIO_HEADER.lower()] = spec.scenario
    payload = _encoded_body(spec.body, headers)
    query_string = urlencode(_normalized_query(spec, inline_query))

    suffix = relative_path.lstrip("/")
    full_path = f"/{tenant}/{project}/{version}" + (f"/{suffix}" if suffix else "")
    raw_headers = [(name.encode("latin-1"), value.encode("latin-1")) for name, value in headers.items()]
    if not any(name == b"host" for name, _ in raw_headers):
        raw_headers.append((b"host", b"preview.invalid"))

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
        "server": ("preview.invalid", 443),
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


def _without_chaos(compiled: CompiledSpec) -> CompiledSpec:
    """Return the same compiled spec with every chaos knob removed.

    Suppressing chaos this way — as data handed to the serving pass — is what lets the preview
    share the data plane's code verbatim instead of growing a "previewing?" branch inside it.

    Args:
        compiled: The compiled spec to render against.

    Returns:
        A copy whose version-level and scenario-level chaos configuration is empty.
    """
    scenarios = {
        name: replace(scenario, chaos=None) if scenario.chaos is not None else scenario
        for name, scenario in compiled.scenarios.items()
    }
    return replace(compiled, chaos=EMPTY_CHAOS, scenarios=scenarios)


def _chaos_report(
    compiled: CompiledSpec,
    *,
    scenario_name: str | None,
    operation_key: str | None,
) -> PreviewChaos:
    """Describe the chaos the data plane would have applied to this request.

    Args:
        compiled: The *original* compiled spec, chaos intact.
        scenario_name: The active scenario, whose chaos block replaces the version-level one.
        operation_key: The matched operation, or ``None`` when nothing matched.

    Returns:
        The resolved knobs, marked suppressed when they would have changed anything.
    """
    if operation_key is None:
        return PreviewChaos()
    scenario = compiled.scenarios.get(scenario_name) if scenario_name else None
    config = scenario.chaos if scenario is not None and scenario.chaos is not None else compiled.chaos
    knobs: ChaosKnobs = effective_knobs(config, operation_key)
    if knobs.is_zero:
        return PreviewChaos()
    return PreviewChaos(
        suppressed=True,
        delay_ms=knobs.delay_ms,
        jitter_ms=knobs.jitter_ms,
        error_rate=knobs.error_rate,
    )


def _decode_body(payload: bytes, media_type: str) -> tuple[Any, str]:
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


async def render_preview(compiled: CompiledSpec, spec: PreviewRequest) -> PreviewResult:
    """Render one synthetic request against a compiled spec and report how it was answered.

    Nothing here decides *what* the mock returns — :func:`serve_compiled_request` does, exactly as
    it does for live traffic. This function's whole job is to hand that function a request it can
    read, give it somewhere harmless to keep session state, and translate the response (and the
    trace the serving pass recorded on the way through) into a result an editor or a CLI can show.

    Args:
        compiled: The compiled spec to render against — from Postgres, a bundle, or a draft the
            caller assembled but has not saved.
        spec: The synthetic request.

    Returns:
        The rendered response and its decision trace.
    """
    path, _, inline_query = spec.path.partition("?")
    relative_path = "/" + path.strip("/") if path.strip("/") else "/"

    request = _build_request(
        spec,
        tenant=compiled.tenant_slug,
        project=compiled.project_slug,
        version=compiled.version_label,
        relative_path=relative_path,
        inline_query=inline_query,
    )

    trace = ServeTrace()
    response = await serve_compiled_request(
        request,
        compiled=_without_chaos(compiled),
        tenant=compiled.tenant_slug,
        project=compiled.project_slug,
        version=compiled.version_label,
        path=relative_path,
        # A store created here and dropped when this call returns: stateful CRUD behaves, and the
        # deployment's real session state is never read or written.
        session_store=InMemorySessionStore(PREVIEW_SESSION_CAPS),
        # No dispatcher, so a preview never fires an outbound callback at anybody.
        callback_dispatcher=None,
        trace=trace,
    )

    media_type = response.headers.get("content-type", "application/json")
    body, encoding = _decode_body(bytes(response.body or b""), media_type)
    operation_key = trace.operation.key if trace.operation is not None else None

    return PreviewResult(
        operation=operation_key,
        path_params=dict(trace.path_params),
        status=response.status_code,
        headers={name: value for name, value in response.headers.items()},
        media_type=media_type.split(";", 1)[0].strip() or "application/json",
        body=body,
        body_encoding=encoding,
        trace=trace,
        chaos=_chaos_report(compiled, scenario_name=trace.scenario, operation_key=operation_key),
    )
