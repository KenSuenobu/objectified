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


@dataclass
class _ServeTrace:
    """What the serving pass learned that the callback pass needs (#4746, PMR-2.3).

    :func:`_serve_matched_request` has many exit points; rather than thread a return tuple through
    every one of them, it records the matched operation and its path parameters here, and the
    public wrapper reads them once the response exists.

    Attributes:
        operation: The operation the request matched, or ``None`` when nothing matched.
        path_params: Path template parameters extracted from the request.
    """

    operation: MockOperation | None = None
    path_params: Mapping[str, str] = field(default_factory=dict)


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

    Returns:
        The mock response (a spec-derived response, a canned scenario response, or a problem+json
        document describing why no response could be served).
    """
    trace = _ServeTrace()
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
    trace: _ServeTrace,
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
            return method_not_allowed(
                f"Method {request.method.upper()} is not allowed for {relative_path}.",
                instance=instance,
                allow=allowed_methods,
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
    chaos_config = scenario.chaos if scenario is not None and scenario.chaos is not None else compiled.chaos
    chaos_knobs = effective_knobs(chaos_config, operation.key)
    applied_delay_ms = await apply_chaos_delay(compute_delay_ms(chaos_knobs), tenant=tenant)

    def _with_chaos_delay(response: Response) -> Response:
        """Stamp the applied injected delay on an outgoing response."""
        if applied_delay_ms > 0:
            response.headers[CHAOS_DELAY_HEADER] = str(applied_delay_ms)
        return response

    seed = parse_mock_seed(request.query_params.get(SEED_QUERY_PARAM))

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
                client = request.client
                try:
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

    resolved = resolve_response_body(
        response_obj,
        compiled.spec,
        accept=accept,
        prefer_header=prefer_header,
        seed=default_seed,
        op_key=operation.key,
    )
    if resolved.not_acceptable:
        return _with_chaos_delay(
            not_acceptable(
                "No response content type satisfies the request Accept header.",
                instance=instance,
            )
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
            )
        except TemplateLimitError as exc:
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
    if not outcome.changed:
        return outcome.body, headers

    schema = response_schema_for_media_type(response_obj, compiled.spec, media_type)
    error = validate_value(outcome.body, schema, compiled.spec) if schema is not None else None
    headers[SCHEMA_VALID_HEADER] = "false" if error else "true"
    if error:
        _log.warning(
            "mock.correlation.schema_drift",
            operation=operation.key,
            applied=list(outcome.applied),
            violation=error,
        )
    return outcome.body, headers
