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

from dataclasses import dataclass, replace
from typing import Any, Mapping

from apiome_mock.chaos import EMPTY_CHAOS, ChaosKnobs, effective_knobs
from apiome_mock.handler import ServeTrace, serve_compiled_request
from apiome_mock.memory_session_store import InMemorySessionStore
from apiome_mock.session_store import SessionCaps
from apiome_mock.spec_loader import CompiledSpec
from apiome_mock.synthetic import (
    ENCODING_BASE64,
    ENCODING_EMPTY,
    ENCODING_JSON,
    ENCODING_TEXT,
    SyntheticRequest,
    build_synthetic_request,
    decode_response_body,
)

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

#: The synthetic request a preview renders. Identical in every respect to the request the hosted
#: sandbox describes, so the two internal surfaces share one shape — see
#: :class:`apiome_mock.synthetic.SyntheticRequest` for the field semantics.
PreviewRequest = SyntheticRequest


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
    relative_path = spec.relative_path
    request = build_synthetic_request(
        spec,
        tenant=compiled.tenant_slug,
        project=compiled.project_slug,
        version=compiled.version_label,
        host="preview.invalid",
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
    body, encoding = decode_response_body(bytes(response.body or b""), media_type)
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
