"""Request handling: spec resolution, routing, and example-first mock responses."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Mapping

import structlog
from app.mock_engine import MockOperation
from app.mock_template import RenderBudget, RenderEnv, TemplateLimitError, make_rng
from fastapi import Request
from fastapi.responses import JSONResponse, Response
from psycopg_pool import AsyncConnectionPool

from apiome_mock.api_key import ValidatedApiKey
from apiome_mock.callback_dispatch import (
    CALLBACK_HEADER,
    CALLBACK_URL_HEADER,
    CallbackDispatcher,
    DispatchRequest,
)
from apiome_mock.capture import CaptureProxy, parse_capture_policy, wants_capture
from apiome_mock.chaos import (
    CHAOS_DELAY_HEADER,
    CHAOS_HEADER,
    apply_chaos_delay,
    compute_delay_ms,
    effective_knobs,
    should_inject_error,
)
from apiome_mock.correlation import (
    CORRELATION_HEADER,
    SCHEMA_VALID_HEADER,
    correlate_response_body,
    derive_request_seed,
)
from apiome_mock.lifecycle import handle_lifecycle_request, is_lifecycle_path
from apiome_mock.problems import (
    bad_request,
    chaos_injected_error,
    method_not_allowed,
    mock_disabled,
    not_acceptable,
    not_found,
    template_limits_exceeded,
    unauthorized,
    undefined_response_status,
    unknown_scenario,
    unsupported_media_type,
)
from apiome_mock.request_validator import ValidationFailure, validate_operation_request
from apiome_mock.response_resolver import (
    AUTHORED_SOURCES,
    SOURCE_EXAMPLE,
    SOURCE_EXAMPLES,
    SOURCE_SCHEMA_DEFAULT,
    SOURCE_SCHEMA_ENUM,
    SOURCE_SCHEMA_EXAMPLE,
    SOURCE_SYNTHESIS,
    ResolvedResponseBody,
    parse_forced_status,
    resolve_response_body,
    response_schema_for_media_type,
    select_default_success_status,
    select_response_by_status,
)
from apiome_mock.routing import match_request
from apiome_mock.scenarios import (
    build_match_context,
    parse_mock_scenario_name,
    select_scenario_responses,
    serve_scenario_response,
)
from apiome_mock.schema_synthesizer import parse_mock_seed, validate_value
from apiome_mock.session_store import SessionStore
from apiome_mock.spec_cache import SpecCache
from apiome_mock.spec_loader import CompiledSpec, get_mock_access_status, load_compiled_spec
from apiome_mock.stateful_handler import parse_mock_session_token, try_handle_stateful_crud

_log = structlog.get_logger(__name__)

SEED_QUERY_PARAM = "__seed"
"""Query parameter that pins the synthesis seed; present means the caller chose it."""


#: Decision-trace layers, in the order the serving pass can reach them. ``layer`` names *what
#: produced the response*, which is the question an author previewing a request is actually
#: asking (#5528, MSC-1.2).
LAYER_UNRESOLVED = "unresolved"
"""Nothing recorded a decision — the trace's default, so a new exit point that forgets to record
shows up as "unresolved" rather than quietly claiming one of the real layers."""

LAYER_LIFECYCLE = "lifecycle"
"""The reserved ``__mock__`` data-lifecycle control plane answered."""

LAYER_NO_OPERATION = "no-operation"
"""No operation in the spec matches the request path."""

LAYER_METHOD_NOT_ALLOWED = "method-not-allowed"
"""The path matches an operation, but not for this method."""

LAYER_UNKNOWN_SCENARIO = "unknown-scenario"
"""``X-Mock-Scenario`` named a scenario this version does not define."""

LAYER_SCENARIO = "scenario"
"""A scenario override served a canned (possibly templated) response."""

LAYER_FORCED_STATUS = "forced-status"
"""``Prefer: code=`` or ``?__status=`` pinned the status; the body came from that response."""

LAYER_REQUEST_INVALID = "request-invalid"
"""Request validation rejected the request (400/415)."""

LAYER_CHAOS_ERROR = "chaos-error"
"""Chaos injection replaced the response with an error."""

LAYER_STATEFUL = "stateful"
"""Session-scoped CRUD (``X-Mock-Session``) produced the body."""

LAYER_CORRELATION = "correlation"
"""Correlation rewrote the default-path body with values from the request."""

LAYER_EXAMPLE = "example"
"""The default path served an author-provided example, default, or enum member."""

LAYER_SYNTHESIS = "synthesis"
"""The default path synthesized the body from the response schema."""

LAYER_EMPTY = "empty"
"""The matched response declares no body."""

LAYER_NOT_ACCEPTABLE = "not-acceptable"
"""No declared content type satisfies the request's ``Accept`` header."""

LAYER_TEMPLATE_LIMIT = "template-limit"
"""A template exhausted its render budget; the limit problem was served instead."""


@dataclass
class ServeTrace:
    """What the serving pass learned about how it answered one request.

    Two callers read this. The callback pass (#4746, PMR-2.3) needs the matched operation and its
    path parameters: :func:`_serve_matched_request` has many exit points, so rather than thread a
    return tuple through every one of them it records them here and the public wrapper reads them
    once the response exists. The dry-run preview (#5528, MSC-1.2) needs the rest — which layer
    produced the body, and enough of *why* to answer an author's real question.

    Nothing here changes the response. A caller that does not pass a trace still gets one (the
    serving pass always allocates), so recording is unconditional and the two paths cannot drift.

    Attributes:
        operation: The operation the request matched, or ``None`` when nothing matched.
        path_params: Path template parameters extracted from the request.
        layer: Which layer produced the response — one of the ``LAYER_*`` constants.
        detail: One human-readable sentence naming what happened, safe to show an author.
        scenario: The active scenario's name, when one applied.
        rule_index: Zero-based index of the matched declarative rule within the operation's
            ``rules`` array (``None`` for the plain fallback response list). Zero-based because it
            addresses the stored array the editor edits; the ``X-Mock-Scenario-Rule`` response
            header stays one-based for humans reading a live response.
        seed: The synthesis seed the response was rendered with.
        seed_source: Where that seed came from — ``"request"`` (``?__seed=``), ``"correlation"``
            (derived from method + path template + path parameters), or ``"default"``.
        correlation_mode: The version's correlation mode, when correlation ran.
        correlation_applied: The correlation passes that bound something.
        correlation_pointers: The explicit JSON Pointers correlation wrote to.
        schema_valid: Whether the served body validates against the response schema. ``None`` when
            no schema was checked.
        body_source: The finer example-first source (a ``response_resolver.SOURCE_*`` value) for a
            default-path body.
        example_name: The named example used, when one was.
    """

    operation: MockOperation | None = None
    path_params: Mapping[str, str] = field(default_factory=dict)
    layer: str = LAYER_UNRESOLVED
    detail: str = ""
    scenario: str | None = None
    rule_index: int | None = None
    seed: int | None = None
    seed_source: str = "default"
    correlation_mode: str | None = None
    correlation_applied: tuple[str, ...] = ()
    correlation_pointers: tuple[str, ...] = ()
    schema_valid: bool | None = None
    body_source: str | None = None
    example_name: str | None = None

    def record(self, layer: str, detail: str) -> None:
        """Record the layer that produced the response and a one-line explanation.

        Args:
            layer: One of the ``LAYER_*`` constants.
            detail: A human-readable sentence naming what happened.
        """
        self.layer = layer
        self.detail = detail


def _instance_path(tenant: str, project: str, version: str, path: str) -> str:
    suffix = path.strip("/")
    base = f"/{tenant}/{project}/{version}"
    return f"{base}/{suffix}" if suffix else base


def _response_for_body(
    *,
    status: int,
    body: Any,
    media_type: str,
) -> Response:
    if body is None:
        return Response(status_code=status, media_type=media_type)
    if media_type.endswith("json") or media_type.endswith("+json"):
        return JSONResponse(status_code=status, content=body, media_type=media_type)
    if isinstance(body, (bytes, bytearray)):
        payload: bytes | str = bytes(body)
    elif isinstance(body, str):
        payload = body
    else:
        payload = json.dumps(body)
        media_type = "application/json"
    return Response(content=payload, status_code=status, media_type=media_type)


def _resolve_operation_response(
    *,
    status: int,
    operation: MockOperation,
    spec: dict[str, Any],
    accept: str | None,
    prefer_header: str | None,
    seed: int,
    instance: str,
) -> Response:
    """Resolve and return the mock response for a concrete operation status code."""
    _, response_obj = select_response_by_status(operation.operation, status)
    if response_obj is None:
        return undefined_response_status(
            f"Status {status} is not defined for {operation.key}.",
            instance=instance,
            requested_status=status,
        )

    resolved = resolve_response_body(
        response_obj,
        spec,
        accept=accept,
        prefer_header=prefer_header,
        seed=seed,
        op_key=operation.key,
    )
    if resolved.not_acceptable:
        return not_acceptable(
            "No response content type satisfies the request Accept header.",
            instance=instance,
        )
    return _response_for_body(status=status, body=resolved.body, media_type=resolved.media_type)


def _select_injected_error_status(operation: MockOperation) -> int | None:
    """Pick the 5xx status chaos injection serves: 500 when defined, else the lowest defined 5xx."""
    responses = operation.operation.get("responses")
    if not isinstance(responses, dict):
        return None
    codes = sorted(int(code) for code in responses if str(code).isdigit() and 500 <= int(code) <= 599)
    if not codes:
        return None
    return 500 if 500 in codes else codes[0]


def _injected_error_response(
    *,
    operation: MockOperation,
    spec: dict[str, Any],
    accept: str | None,
    prefer_header: str | None,
    seed: int,
    instance: str,
) -> Response:
    """Build the chaos-injected error response (#4455, SIM-4.3).

    Serves the operation's spec-defined 5xx (500 preferred, else the lowest
    5xx) with its resolved example body; when the spec defines no 5xx (or no
    body satisfies the Accept header) falls back to problem+json 500. The
    response is marked with the ``X-Mock-Chaos: error`` header.
    """
    response: Response | None = None
    status = _select_injected_error_status(operation)
    if status is not None:
        _, response_obj = select_response_by_status(operation.operation, status)
        resolved = resolve_response_body(
            response_obj,
            spec,
            accept=accept,
            prefer_header=prefer_header,
            seed=seed,
            op_key=operation.key,
        )
        if not resolved.not_acceptable:
            response = _response_for_body(status=status, body=resolved.body, media_type=resolved.media_type)
    if response is None:
        response = chaos_injected_error(
            f"Chaos error injected for {operation.key}.",
            instance=instance,
        )
    response.headers[CHAOS_HEADER] = "error"
    return response


def _validation_problem_response(
    failure: ValidationFailure,
    *,
    operation: MockOperation,
    spec: dict[str, Any],
    accept: str | None,
    prefer_header: str | None,
    seed: int,
    instance: str,
) -> Response:
    """Return a spec-true 400/415 body when defined, else problem+json."""
    _, response_obj = select_response_by_status(operation.operation, failure.status)
    if response_obj is not None:
        resolved = resolve_response_body(
            response_obj,
            spec,
            accept=accept,
            prefer_header=prefer_header,
            seed=seed,
            op_key=operation.key,
        )
        if not resolved.not_acceptable:
            return _response_for_body(
                status=failure.status,
                body=resolved.body,
                media_type=resolved.media_type,
            )

    extra = {"violations": list(failure.violations)} if failure.violations else None
    if failure.status == 415:
        return unsupported_media_type(failure.detail, instance=instance, extra=extra)
    return bad_request(failure.detail, instance=instance, extra=extra)


async def resolve_compiled_spec(
    pool: AsyncConnectionPool,
    cache: SpecCache,
    *,
    tenant: str,
    project: str,
    version: str,
    api_key: ValidatedApiKey | None = None,
) -> Any:
    """Return a compiled spec from cache or Postgres."""
    cached = cache.get(tenant, project, version)
    if cached is not None:
        return cached
    compiled = await load_compiled_spec(
        pool,
        tenant=tenant,
        project=project,
        version=version,
        api_key=api_key,
    )
    if compiled is not None:
        cache.put(compiled)
    return compiled


async def handle_mock_request(
    request: Request,
    *,
    tenant: str,
    project: str,
    version: str,
    path: str,
    pool: AsyncConnectionPool,
    cache: SpecCache,
    api_key: ValidatedApiKey | None = None,
    session_store: SessionStore | None = None,
    callback_dispatcher: CallbackDispatcher | None = None,
    capture_proxy: CaptureProxy | None = None,
) -> Response:
    """Serve a mock response for ``/{tenant}/{project}/{version}/{path}`` (hosted, Postgres-backed).

    Resolves access and the compiled spec from the database, then delegates the actual behavior to
    :func:`serve_compiled_request` — unless the request opted into guarded proxy capture, in which
    case it is forwarded to an allowlisted upstream and recorded instead (#4747, PMR-2.4).

    Capture lives here rather than in :func:`serve_compiled_request` on purpose: it needs the
    control-plane database for both the grant and the review queue, so it is structurally
    unavailable to the portable runtime, which shares only the serving function.

    Args:
        request: The incoming request.
        tenant: Tenant slug from the URL.
        project: Project slug from the URL.
        version: Version label from the URL.
        path: Request path relative to the version prefix.
        pool: Database pool backing spec resolution, capture storage, and the audit ledger.
        cache: Compiled-spec cache.
        api_key: The validated tenant API key, when the caller sent one.
        session_store: Store backing ``X-Mock-Session`` state.
        callback_dispatcher: Delivers contract callbacks (#4746, PMR-2.3).
        capture_proxy: Guarded upstream proxy (#4747, PMR-2.4); ``None`` disables capture for the
            whole deployment, whatever any version's policy says.

    Returns:
        The mock (or, when capturing, the upstream) response.
    """
    instance = _instance_path(tenant, project, version, path)
    raw_api_key = request.headers.get("X-Api-Key") or request.headers.get("x-api-key")
    if raw_api_key and api_key is None:
        return unauthorized(
            "Invalid or expired API key.",
            instance=instance,
        )

    access = await get_mock_access_status(
        pool,
        tenant=tenant,
        project=project,
        version=version,
        api_key=api_key,
    )
    if access == "disabled":
        return mock_disabled(
            f"Mock is disabled for {tenant}/{project}/{version}.",
            instance=instance,
        )
    if access == "missing":
        return not_found(
            f"No published spec for {tenant}/{project}/{version}.",
            instance=instance,
        )

    compiled = await resolve_compiled_spec(
        pool,
        cache,
        tenant=tenant,
        project=project,
        version=version,
        api_key=api_key,
    )
    if compiled is None:
        return not_found(
            f"No published spec for {tenant}/{project}/{version}.",
            instance=instance,
        )

    if capture_proxy is not None and wants_capture(request):
        relative_path = "/" + path.strip("/") if path.strip("/") else "/"
        operation, _, _ = match_request(compiled.operations, request.method, relative_path)
        return await capture_proxy.capture(
            request,
            spec=compiled.spec,
            policy=compiled.capture_policy or parse_capture_policy(None),
            operation=operation,
            tenant=tenant,
            project=project,
            version=version,
            relative_path=relative_path,
            instance=instance,
            api_key=api_key,
            pool=pool,
        )

    return await serve_compiled_request(
        request,
        compiled=compiled,
        tenant=tenant,
        project=project,
        version=version,
        path=path,
        session_store=session_store,
        callback_dispatcher=callback_dispatcher,
    )


async def serve_compiled_request(
    request: Request,
    *,
    compiled: CompiledSpec,
    tenant: str,
    project: str,
    version: str,
    path: str,
    session_store: SessionStore | None = None,
    callback_dispatcher: CallbackDispatcher | None = None,
    trace: ServeTrace | None = None,
) -> Response:
    """Serve a mock response from an already-resolved :class:`CompiledSpec`.

    This is the whole of the mock's request behavior — routing, scenarios, chaos, validation,
    stateful CRUD, example-first response resolution, request correlation, and outbound callback
    delivery — with no dependency on Postgres. The hosted path (:func:`handle_mock_request`) reaches it after
    resolving the spec from the database; the portable runtime (:mod:`apiome_mock.portable`)
    reaches it with the spec compiled from a mock bundle. Sharing this function is what makes the
    two runtimes behave identically.

    Args:
        request: The incoming request.
        compiled: The compiled spec to serve.
        tenant: Tenant slug, used for problem ``instance`` paths and chaos delay accounting.
        project: Project slug, used for problem ``instance`` paths.
        version: Version label, used for problem ``instance`` paths.
        path: Request path *relative to* the ``/{tenant}/{project}/{version}`` prefix.
        session_store: Store backing ``X-Mock-Session`` state; ``None`` disables stateful CRUD.
        callback_dispatcher: Delivers contract callbacks the served response fires (#4746,
            PMR-2.3); ``None`` disables outbound delivery entirely.
        trace: Optional recorder the serving pass fills in with the decision it made. The data
            plane ignores it; the dry-run preview (#5528, MSC-1.2) passes one and reads it, which
            is how a preview reports *why* a value appeared without a second resolution path.

    Returns:
        The mock response (a spec-derived response, a canned scenario response, or a problem+json
        document describing why no response could be served).
    """
    trace = trace if trace is not None else ServeTrace()
    response = await _serve_matched_request(
        request,
        compiled=compiled,
        tenant=tenant,
        project=project,
        version=version,
        path=path,
        session_store=session_store,
        callback_dispatcher=callback_dispatcher,
        trace=trace,
    )
    if callback_dispatcher is not None and trace.operation is not None and compiled.callbacks:
        await _fire_callbacks(
            request,
            compiled=compiled,
            response=response,
            operation_key=trace.operation.key,
            path_params=trace.path_params,
            dispatcher=callback_dispatcher,
        )
    return response


async def _fire_callbacks(
    request: Request,
    *,
    compiled: CompiledSpec,
    response: Response,
    operation_key: str,
    path_params: Mapping[str, str],
    dispatcher: CallbackDispatcher,
) -> None:
    """Deliver every callback the served response fires, then stamp the outcome on it.

    Deliveries are awaited *before* the response is returned rather than fired into the
    background. A mock exists to make behavior observable and reproducible: a consumer that drove
    the triggering operation can read ``X-Mock-Callback`` on the very response it got, and a test
    never has to poll for an outcome that may or may not have happened yet. The cost is bounded by
    the definitions themselves — each carries a capped attempt count, per-attempt timeout, and
    total backoff, all validated at save time.

    Args:
        request: The triggering request, read for template context and the session token.
        compiled: The compiled spec being served (source of definitions and fixture data).
        response: The response about to be returned; annotated in place with the outcomes.
        operation_key: The canonical key of the operation that was served.
        path_params: Path template parameters, for ``{{request.path.<name>}}`` templates.
        dispatcher: The deployment's dispatcher.
    """
    fired = [
        definition
        for definition in compiled.callbacks.values()
        if definition.fires_for(operation_key, response.status_code)
    ]
    if not fired:
        return

    ctx = await build_match_context(
        request,
        path_params=path_params,
        needs_body=any(definition.needs_request_body for definition in fired),
    )
    seed = parse_mock_seed(request.query_params.get(SEED_QUERY_PARAM))
    session_token = parse_mock_session_token(request)
    requested = request.headers.get(CALLBACK_URL_HEADER)

    outcomes: list[str] = []
    for definition in sorted(fired, key=lambda entry: entry.name):
        record = await dispatcher.dispatch(
            definition,
            DispatchRequest(
                ctx=ctx,
                seed=seed,
                fixtures=compiled.fixtures,
                schema_root=compiled.spec,
                destination=requested,
                trigger=operation_key,
                session=session_token,
            ),
        )
        outcomes.append(f"{record.callback}={record.outcome}")
    response.headers[CALLBACK_HEADER] = ", ".join(outcomes)


def _default_body_layer(source: str) -> str:
    """Map an example-first resolution source onto the trace layer that names it.

    Args:
        source: A :mod:`apiome_mock.response_resolver` ``SOURCE_*`` value.

    Returns:
        :data:`LAYER_EXAMPLE`, :data:`LAYER_SYNTHESIS`, or :data:`LAYER_EMPTY`.
    """
    if source in AUTHORED_SOURCES:
        return LAYER_EXAMPLE
    if source == SOURCE_SYNTHESIS:
        return LAYER_SYNTHESIS
    return LAYER_EMPTY


def _default_body_detail(
    resolved: ResolvedResponseBody,
    *,
    operation_key: str,
    status: int,
) -> str:
    """Explain, in one sentence, where a default-path body came from.

    Args:
        resolved: The resolved response body.
        operation_key: The matched operation's canonical key.
        status: The status code being served.

    Returns:
        A sentence naming the source, safe to show an author previewing a request.
    """
    where = f"{operation_key}'s {status} response"
    if resolved.source == SOURCE_EXAMPLES:
        named = f" '{resolved.example_name}'" if resolved.example_name else ""
        return f"The named example{named} declared on {where} was served verbatim."
    if resolved.source == SOURCE_EXAMPLE:
        return f"The example declared on {where} was served verbatim."
    if resolved.source == SOURCE_SCHEMA_EXAMPLE:
        return f"The example on {where}'s schema was served verbatim."
    if resolved.source == SOURCE_SCHEMA_DEFAULT:
        return f"The default on {where}'s schema was served verbatim."
    if resolved.source == SOURCE_SCHEMA_ENUM:
        return f"The first enum member of {where}'s schema was served."
    if resolved.source == SOURCE_SYNTHESIS:
        return f"No example is declared, so the body was synthesized from {where}'s schema."
    return f"{where} declares no body."


async def _serve_matched_request(
    request: Request,
    *,
    compiled: CompiledSpec,
    tenant: str,
    project: str,
    version: str,
    path: str,
    session_store: SessionStore | None,
    callback_dispatcher: CallbackDispatcher | None,
    trace: ServeTrace,
) -> Response:
    """Produce the mock response itself, recording the matched operation in ``trace``.

    Split out of :func:`serve_compiled_request` so the callback pass has the matched operation
    without every one of this function's exit points having to carry it.
    """
    instance = _instance_path(tenant, project, version, path)
    relative_path = "/" + path.strip("/") if path.strip("/") else "/"

    # Data lifecycle control plane (#4745, PMR-2.2): the __mock__ segment is reserved ahead of
    # spec routing, and control responses skip scenarios and chaos — a chaos-delayed or
    # scenario-overridden reset would defeat the point of a deterministic test hook.
    if is_lifecycle_path(relative_path):
        trace.record(LAYER_LIFECYCLE, f"The reserved data-lifecycle endpoint {relative_path} answered.")
        return await handle_lifecycle_request(
            request,
            relative_path=relative_path,
            compiled=compiled,
            tenant=tenant,
            project=project,
            version=version,
            instance=instance,
            store=session_store,
            dispatcher=callback_dispatcher,
        )

    operation, path_params, allowed_methods = match_request(compiled.operations, request.method, relative_path)
    if operation is None:
        if allowed_methods:
            trace.record(
                LAYER_METHOD_NOT_ALLOWED,
                f"{relative_path} exists but declares no {request.method.upper()} operation "
                f"(allowed: {', '.join(allowed_methods)}).",
            )
            return method_not_allowed(
                f"Method {request.method.upper()} is not allowed for {relative_path}.",
                instance=instance,
                allow=allowed_methods,
            )
        trace.record(
            LAYER_NO_OPERATION,
            f"No operation in this version matches {request.method.upper()} {relative_path}.",
        )
        return not_found(
            f"No operation matches {request.method.upper()} {relative_path}.",
            instance=instance,
        )

    trace.operation = operation
    trace.path_params = path_params

    session_token = parse_mock_session_token(request)

    # Scenario overrides (#4454, SIM-4.2): an X-Mock-Scenario header selects a
    # curated situation authored in the Control Panel. Overridden operations
    # return their canned response(s) verbatim (highest precedence); operations
    # the scenario does not override fall through to the default flow below.
    scenario = None
    scenario_name = parse_mock_scenario_name(request)
    if scenario_name is not None:
        scenario = compiled.scenarios.get(scenario_name)
        if scenario is None:
            trace.record(
                LAYER_UNKNOWN_SCENARIO,
                f"No scenario named '{scenario_name}' is defined for this version.",
            )
            return unknown_scenario(
                f"No scenario named '{scenario_name}' is defined for {tenant}/{project}/{version}.",
                instance=instance,
                available=sorted(compiled.scenarios),
            )

    # Chaos injection (#4455, SIM-4.3): a scenario-scoped chaos block replaces
    # the version-level one when that scenario is active. The configured delay
    # applies to every matched-operation response (canned, forced, validation
    # problem, or resolved); error injection further down replaces only the
    # normal resolved response.
    if scenario is not None:
        trace.scenario = scenario.name

    chaos_config = scenario.chaos if scenario is not None and scenario.chaos is not None else compiled.chaos
    chaos_knobs = effective_knobs(chaos_config, operation.key)
    applied_delay_ms = await apply_chaos_delay(compute_delay_ms(chaos_knobs), tenant=tenant)

    def _with_chaos_delay(response: Response) -> Response:
        """Stamp the applied injected delay on an outgoing response."""
        if applied_delay_ms > 0:
            response.headers[CHAOS_DELAY_HEADER] = str(applied_delay_ms)
        return response

    seed = parse_mock_seed(request.query_params.get(SEED_QUERY_PARAM))
    trace.seed = seed
    if request.query_params.get(SEED_QUERY_PARAM) is not None:
        trace.seed_source = "request"

    if scenario is not None:
        override = scenario.operations.get(operation.key)
        if override is not None:
            # Declarative rules (#4744, PMR-2.1): the first rule whose request
            # predicates hold serves its responses; the plain responses list is
            # the fallback; with neither, the request falls through to the
            # default flow below as if the scenario did not cover the operation.
            ctx = await build_match_context(
                request,
                path_params=path_params,
                needs_body=override.needs_body,
            )
            selection = select_scenario_responses(override, ctx)
            if selection is not None:
                rule_index, canned_responses = selection
                trace.rule_index = rule_index
                client = request.client
                try:
                    trace.record(
                        LAYER_SCENARIO,
                        f"Scenario '{scenario.name}' overrides {operation.key}"
                        + (
                            f" and its rule at index {rule_index} matched this request."
                            if rule_index is not None
                            else " with a fallback response."
                        ),
                    )
                    return _with_chaos_delay(
                        await serve_scenario_response(
                            scenario=scenario,
                            responses=canned_responses,
                            operation_key=operation.key,
                            rule_index=rule_index,
                            ctx=ctx,
                            seed=seed,
                            fixtures=compiled.fixtures,
                            tenant=tenant,
                            project=project,
                            version=version,
                            session_token=session_token,
                            client_ip=client.host if client and client.host else "unknown",
                            store=session_store,
                        )
                    )
                except TemplateLimitError as exc:
                    trace.record(
                        LAYER_TEMPLATE_LIMIT,
                        f"Scenario '{scenario.name}' response template for {operation.key} "
                        f"exceeded its render limits: {exc}",
                    )
                    return _with_chaos_delay(
                        template_limits_exceeded(
                            f"Scenario '{scenario.name}' response template for {operation.key} "
                            f"exceeded its render limits: {exc}",
                            instance=instance,
                        )
                    )

    prefer_header = request.headers.get("prefer")
    accept = request.headers.get("accept")
    forced_status = parse_forced_status(prefer_header, request.query_params)
    if forced_status is not None:
        # The pin wins outright, so it is the whole explanation: whether the operation actually
        # declares that status (and what body it carries) is visible in the response itself.
        trace.record(
            LAYER_FORCED_STATUS,
            f"The request pinned status {forced_status} for {operation.key}.",
        )
        return _with_chaos_delay(
            _resolve_operation_response(
                status=forced_status,
                operation=operation,
                spec=compiled.spec,
                accept=accept,
                prefer_header=prefer_header,
                seed=seed,
                instance=instance,
            )
        )

    failure = await validate_operation_request(request, operation, path_params, compiled.spec)
    if failure is not None:
        trace.record(
            LAYER_REQUEST_INVALID,
            f"The request does not satisfy {operation.key}: {failure.detail}",
        )
        return _with_chaos_delay(
            _validation_problem_response(
                failure,
                operation=operation,
                spec=compiled.spec,
                accept=accept,
                prefer_header=prefer_header,
                seed=seed,
                instance=instance,
            )
        )

    if should_inject_error(chaos_knobs):
        trace.record(LAYER_CHAOS_ERROR, f"Chaos injection replaced the response for {operation.key}.")
        return _with_chaos_delay(
            _injected_error_response(
                operation=operation,
                spec=compiled.spec,
                accept=accept,
                prefer_header=prefer_header,
                seed=seed,
                instance=instance,
            )
        )

    if session_token is not None and session_store is not None:
        stateful = await try_handle_stateful_crud(
            request,
            tenant=tenant,
            project=project,
            version=version,
            relative_path=relative_path,
            instance=instance,
            operation=operation,
            path_params=path_params,
            operations=compiled.operations,
            spec=compiled.spec,
            store=session_store,
            session_token=session_token,
        )
        if stateful is not None:
            trace.record(
                LAYER_STATEFUL,
                f"Session-scoped CRUD state answered {operation.key} for this X-Mock-Session.",
            )
            return _with_chaos_delay(stateful)

    status, response_obj = select_default_success_status(operation.operation)

    # Request-correlated responses (#5527, MSC-1.1). This is the path a consumer you do not
    # control actually takes — no scenario header, no session header — so correlation is
    # configuration on the version rather than an opt-in per request. It runs *after* the default
    # body is resolved and *before* the schema re-check below, and only here: an active scenario
    # override and stateful CRUD both returned above, and both still win.
    correlating = compiled.correlation.applies_to(operation.key)
    default_seed = seed
    if correlating and request.query_params.get(SEED_QUERY_PARAM) is None:
        default_seed = derive_request_seed(request.method, operation.path_template, path_params)
        trace.seed_source = "correlation"
    trace.seed = default_seed
    if correlating:
        trace.correlation_mode = compiled.correlation.mode

    resolved = resolve_response_body(
        response_obj,
        compiled.spec,
        accept=accept,
        prefer_header=prefer_header,
        seed=default_seed,
        op_key=operation.key,
    )
    if resolved.not_acceptable:
        trace.record(
            LAYER_NOT_ACCEPTABLE,
            f"{operation.key} declares no response content type the request's Accept header allows.",
        )
        return _with_chaos_delay(
            not_acceptable(
                "No response content type satisfies the request Accept header.",
                instance=instance,
            )
        )

    trace.body_source = resolved.source
    trace.example_name = resolved.example_name
    if resolved.source == SOURCE_SYNTHESIS:
        # Synthesis is the only source the resolver schema-checks; an authored example is served
        # as written (author-time validation owns that contract), so there is no verdict to report.
        trace.schema_valid = resolved.validation_error is None
    trace.record(
        _default_body_layer(resolved.source),
        _default_body_detail(resolved, operation_key=operation.key, status=status),
    )

    body = resolved.body
    correlation_headers: dict[str, str] = {}
    if correlating:
        try:
            body, correlation_headers = await _correlate_default_body(
                request,
                compiled=compiled,
                operation=operation,
                path_params=path_params,
                response_obj=response_obj,
                media_type=resolved.media_type,
                body=body,
                seed=default_seed,
                trace=trace,
            )
        except TemplateLimitError as exc:
            trace.record(
                LAYER_TEMPLATE_LIMIT,
                f"Response correlation for {operation.key} exceeded its render limits: {exc}",
            )
            return _with_chaos_delay(
                template_limits_exceeded(
                    f"Response correlation for {operation.key} exceeded its render limits: {exc}",
                    instance=instance,
                )
            )

    response = _response_for_body(status=status, body=body, media_type=resolved.media_type)
    for name, value in correlation_headers.items():
        response.headers[name] = value
    return _with_chaos_delay(response)


async def _correlate_default_body(
    request: Request,
    *,
    compiled: CompiledSpec,
    operation: MockOperation,
    path_params: Mapping[str, str],
    response_obj: dict[str, Any] | None,
    media_type: str,
    body: Any,
    seed: int,
    trace: ServeTrace,
) -> tuple[Any, dict[str, str]]:
    """Correlate one resolved default-path body and report the outcome (#5527, MSC-1.1).

    Builds the same :class:`~app.mock_template.RenderEnv` the scenario renderer uses — so explicit
    pointer expressions read exactly the request fields, seeded randomness, and fixture data a
    scenario template can — then re-validates the correlated body against the response schema. A
    correlated body that drifts from the contract is still served (refusing it would make a mock
    less useful than the static one it replaces) but is *surfaced*: the response carries
    ``X-Mock-Schema-Valid: false`` and the drift is logged with the operation and the violation.

    Args:
        request: The incoming request.
        compiled: The compiled spec being served (correlation settings and fixture data).
        operation: The matched operation.
        path_params: Path template parameters extracted by routing.
        response_obj: The operation's response object for the served status.
        media_type: The media type actually being served.
        body: The resolved default-path body.
        seed: The seed the body was synthesized with, reused for ``random.*`` expressions.
        trace: The serving pass's decision recorder; annotated with which passes bound, which
            pointers they wrote, and whether the correlated body still matches the schema.

    Returns:
        ``(body, headers)`` — the correlated body and the response headers describing what happened.

    Raises:
        TemplateLimitError: When an explicit expression exhausts its render budget.
    """
    correlation = compiled.correlation
    ctx = await build_match_context(
        request,
        path_params=path_params,
        needs_body=correlation.needs_request_body(operation.key),
    )
    env = RenderEnv(
        ctx=ctx,
        rng=make_rng(seed, operation.key, "correlation"),
        fixtures=compiled.fixtures,
    )
    outcome = correlate_response_body(
        body,
        config=correlation,
        operation_key=operation.key,
        env=env,
        budget=RenderBudget(),
    )
    headers = {CORRELATION_HEADER: outcome.header_value()}
    trace.correlation_applied = outcome.applied
    trace.correlation_pointers = outcome.pointers
    if not outcome.changed:
        return outcome.body, headers

    trace.record(
        LAYER_CORRELATION,
        f"Correlation ({', '.join(outcome.applied)}) rewrote the {operation.key} response with "
        "values from the request" + (f" at {', '.join(outcome.pointers)}." if outcome.pointers else "."),
    )

    schema = response_schema_for_media_type(response_obj, compiled.spec, media_type)
    error = validate_value(outcome.body, schema, compiled.spec) if schema is not None else None
    headers[SCHEMA_VALID_HEADER] = "false" if error else "true"
    trace.schema_valid = not error
    if error:
        _log.warning(
            "mock.correlation.schema_drift",
            operation=operation.key,
            applied=list(outcome.applied),
            violation=error,
        )
    return outcome.body, headers
