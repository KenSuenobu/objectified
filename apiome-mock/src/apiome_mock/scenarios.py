"""Scenario overrides for the hosted mock (#4454, SIM-4.2).

Named scenarios ("happy path", "quota exceeded", ...) are authored in the
Control Panel and stored in the ``versions.mock_settings`` JSONB column under
the ``"scenarios"`` key::

    {
      "scenarios": {
        "quota-exceeded": {
          "description": "Every list call is throttled.",
          "operations": {
            "GET /pets": {
              "responses": [
                {"status": 429, "headers": {"Retry-After": "60"}, "body": {...}}
              ]
            }
          }
        }
      }
    }

Consumers select a scenario per request with the ``X-Mock-Scenario`` header.
An operation entry with one response is a fixed canned response; two or more
responses form a *sequence* (first call -> first response, second call ->
second response, ...; calls past the end stick on the last response). The
sequence position is tracked in the SIM-4.1 session store, keyed by the
``X-Mock-Session`` token when present, else by scenario + client IP.

Declarative rules and templates (#4744, PMR-2.1): an operation entry may also
carry ordered ``rules`` — request predicates (``when``, evaluated by
``app.mock_match``) plus the responses they select. The first rule whose
predicates hold serves its responses; the plain ``responses`` list is the
fallback, and with neither the request falls through to the default
spec-driven flow. Response bodies and header values may embed the bounded
``{{ ... }}`` templates rendered by ``app.mock_template`` from request
fields, seeded randomness, and fixture data — deterministic for a given
``__seed``, with CPU and output limits enforced per render.

Parsing here is deliberately lenient: invalid entries are skipped so a
malformed stored settings blob can never break the runtime. Author-time
validation (including spec response-schema checks) happens in apiome-rest
when the scenarios are saved.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Mapping

from app.mock_match import CompiledWhen, MatchContext, compile_when, evaluate_when
from app.mock_template import (
    RenderBudget,
    RenderEnv,
    make_rng,
    render_text,
    render_value,
    value_references_request_body,
)
from fastapi import Request
from fastapi.responses import JSONResponse, Response

from apiome_mock.chaos import ChaosConfig, parse_chaos_block
from apiome_mock.session_store import SessionKey, SessionStore, SessionStoreError

MOCK_SCENARIO_HEADER = "X-Mock-Scenario"
"""Request header naming the scenario to apply; absent -> default behavior."""

SCENARIO_CALL_HEADER = "X-Mock-Scenario-Call"
"""Response header echoing the 1-based sequence call number (sequences only)."""

SCENARIO_RULE_HEADER = "X-Mock-Scenario-Rule"
"""Response header echoing the 1-based matched rule number (#4744, PMR-2.1)."""

_SEQUENCE_NAMESPACE = "__mock_scenario_sequence__"
_IP_SESSION_PREFIX = "__mock_scenario_ip__"

# Headers a canned response may never set: they are managed by the framework
# and overriding them can corrupt the HTTP framing of the response.
_RESERVED_HEADERS = frozenset({"content-length", "transfer-encoding", "connection"})

_MIN_STATUS = 100
_MAX_STATUS = 599


@dataclass(frozen=True)
class ScenarioResponse:
    """One canned response (status + headers + optional body)."""

    status: int
    headers: tuple[tuple[str, str], ...]
    body: Any
    has_body: bool
    media_type: str


@dataclass(frozen=True)
class ScenarioRule:
    """One declarative rule: predicates plus the response sequence they select (#4744, PMR-2.1)."""

    when: CompiledWhen
    responses: tuple[ScenarioResponse, ...]


@dataclass(frozen=True)
class OperationOverride:
    """Everything one scenario declares for one operation.

    Attributes:
        rules: Ordered declarative rules; the first whose ``when`` holds serves its responses.
        responses: Fallback responses served when no rule matches (may be empty).
        needs_body: Whether serving needs the parsed request body (predicates or templates).
    """

    rules: tuple[ScenarioRule, ...] = ()
    responses: tuple[ScenarioResponse, ...] = ()
    needs_body: bool = False


@dataclass(frozen=True)
class Scenario:
    """A named scenario mapping operation keys to their overrides."""

    name: str
    description: str
    operations: Mapping[str, OperationOverride]
    chaos: ChaosConfig | None = None
    """Scenario-scoped chaos knobs (#4455, SIM-4.3); ``None`` -> version-level chaos applies."""


def normalize_operation_key(raw: Any) -> str | None:
    """Normalize an operation key to canonical ``"METHOD /template"`` form.

    Returns ``None`` when ``raw`` is not a ``"method path"`` string (method
    alphabetic, path starting with ``/``).
    """
    if not isinstance(raw, str):
        return None
    parts = raw.strip().split(None, 1)
    if len(parts) != 2:
        return None
    method, path = parts
    if not method.isalpha() or not path.startswith("/"):
        return None
    return f"{method.upper()} {path}"


def parse_mock_scenario_name(request: Request) -> str | None:
    """Return the ``X-Mock-Scenario`` header value, or ``None`` when absent/blank."""
    raw = request.headers.get(MOCK_SCENARIO_HEADER)
    if raw is None:
        return None
    name = raw.strip()
    return name or None


def _parse_headers(raw: Any) -> tuple[tuple[str, str], ...]:
    """Extract string->string header pairs, skipping anything malformed."""
    if not isinstance(raw, dict):
        return ()
    pairs: list[tuple[str, str]] = []
    for name, value in raw.items():
        if not isinstance(name, str) or not name.strip():
            continue
        if not isinstance(value, str) or "\r" in value or "\n" in value:
            continue
        if name.strip().lower() in _RESERVED_HEADERS:
            continue
        pairs.append((name.strip(), value))
    return tuple(pairs)


def _parse_response(raw: Any) -> ScenarioResponse | None:
    """Build one :class:`ScenarioResponse`; ``None`` when the entry is invalid."""
    if not isinstance(raw, dict):
        return None
    status = raw.get("status")
    if isinstance(status, bool) or not isinstance(status, int):
        return None
    if not _MIN_STATUS <= status <= _MAX_STATUS:
        return None

    headers = _parse_headers(raw.get("headers"))
    has_body = "body" in raw

    media_type = raw.get("mediaType")
    if not isinstance(media_type, str) or not media_type.strip():
        media_type = next(
            (value for name, value in headers if name.lower() == "content-type"),
            "application/json",
        )

    return ScenarioResponse(
        status=status,
        headers=headers,
        body=raw.get("body"),
        has_body=has_body,
        media_type=media_type.strip(),
    )


def _parse_responses(raw: Any) -> tuple[ScenarioResponse, ...]:
    """Parse a raw response list, skipping malformed entries."""
    if not isinstance(raw, list):
        return ()
    return tuple(parsed for entry in raw if (parsed := _parse_response(entry)) is not None)


def _parse_rule(raw: Any) -> ScenarioRule | None:
    """Build one :class:`ScenarioRule`; ``None`` when the entry is unusable.

    A rule whose ``when`` block fails to compile is dropped entirely — matching
    more broadly than the author intended is worse than not matching at all.
    """
    if not isinstance(raw, dict):
        return None
    when = compile_when(raw.get("when"))
    if when is None:
        return None
    responses = _parse_responses(raw.get("responses"))
    if not responses:
        return None
    return ScenarioRule(when=when, responses=responses)


def _response_uses_body(response: ScenarioResponse) -> bool:
    """Whether a canned response's templates read the request body."""
    if response.has_body and value_references_request_body(response.body):
        return True
    return any(value_references_request_body(value) for _, value in response.headers)


def _parse_override(raw: Any) -> OperationOverride | None:
    """Build one :class:`OperationOverride`; ``None`` when it declares nothing servable."""
    if not isinstance(raw, dict):
        return None
    rules_raw = raw.get("rules")
    rules: tuple[ScenarioRule, ...] = ()
    if isinstance(rules_raw, list):
        rules = tuple(parsed for entry in rules_raw if (parsed := _parse_rule(entry)) is not None)
    responses = _parse_responses(raw.get("responses"))
    if not rules and not responses:
        return None
    needs_body = any(rule.when.needs_body for rule in rules) or any(
        _response_uses_body(response)
        for response in (*(entry for rule in rules for entry in rule.responses), *responses)
    )
    return OperationOverride(rules=rules, responses=responses, needs_body=needs_body)


def _parse_scenario(name: str, raw: Any) -> Scenario | None:
    """Build one :class:`Scenario`; ``None`` when the entry is unusable."""
    if not isinstance(raw, dict):
        return None
    description = raw.get("description")
    operations_raw = raw.get("operations")
    operations: dict[str, OperationOverride] = {}
    if isinstance(operations_raw, dict):
        for op_key_raw, override_raw in operations_raw.items():
            op_key = normalize_operation_key(op_key_raw)
            if op_key is None:
                continue
            override = _parse_override(override_raw)
            if override is not None:
                operations[op_key] = override
    return Scenario(
        name=name,
        description=description if isinstance(description, str) else "",
        operations=operations,
        chaos=parse_chaos_block(raw.get("chaos")),
    )


def parse_scenarios(mock_settings: Any) -> dict[str, Scenario]:
    """Parse ``versions.mock_settings`` into scenario definitions by name.

    Accepts the raw JSONB value (dict, JSON text, or ``None``) and never
    raises: unusable scenarios / operations / responses are silently skipped.
    """
    settings: Any = mock_settings
    if isinstance(settings, str):
        try:
            settings = json.loads(settings)
        except json.JSONDecodeError:
            return {}
    if not isinstance(settings, dict):
        return {}
    scenarios_raw = settings.get("scenarios")
    if not isinstance(scenarios_raw, dict):
        return {}

    scenarios: dict[str, Scenario] = {}
    for name, raw in scenarios_raw.items():
        if not isinstance(name, str) or not name.strip():
            continue
        scenario = _parse_scenario(name.strip(), raw)
        if scenario is not None:
            scenarios[scenario.name] = scenario
    return scenarios


async def build_match_context(
    request: Request,
    *,
    path_params: Mapping[str, str],
    needs_body: bool,
) -> MatchContext:
    """Build the :class:`MatchContext` predicates and templates read (#4744, PMR-2.1).

    The request body is only read (and JSON-parsed, best effort) when the override actually
    references it; a non-JSON or unparseable body leaves ``body`` as ``None`` while still
    reporting ``body_present`` so ``exists`` predicates behave sensibly.
    """
    query: dict[str, tuple[str, ...]] = {}
    for name, value in request.query_params.multi_items():
        query[name] = (*query.get(name, ()), value)
    headers = {name.lower(): value for name, value in request.headers.items()}

    body: Any = None
    body_present = False
    if needs_body:
        raw = await request.body()
        body_present = bool(raw)
        if body_present:
            try:
                body = json.loads(raw)
            except (json.JSONDecodeError, UnicodeDecodeError):
                body = None
    return MatchContext(
        method=request.method.upper(),
        path_params=dict(path_params),
        query=query,
        headers=headers,
        body=body,
        body_present=body_present,
    )


def select_scenario_responses(
    override: OperationOverride,
    ctx: MatchContext,
) -> tuple[int | None, tuple[ScenarioResponse, ...]] | None:
    """Pick the response sequence one request gets from an override (#4744, PMR-2.1).

    Returns ``(rule_index, responses)`` for the first rule whose predicates hold,
    ``(None, responses)`` for the fallback list, or ``None`` when nothing applies —
    the caller then falls through to the default spec-driven flow.
    """
    for index, rule in enumerate(override.rules):
        if evaluate_when(rule.when, ctx):
            return index, rule.responses
    if override.responses:
        return None, override.responses
    return None


async def _sequence_call_number(
    *,
    scenario: Scenario,
    operation_key: str,
    rule_index: int | None,
    tenant: str,
    project: str,
    version: str,
    session_token: str | None,
    client_ip: str,
    store: SessionStore | None,
) -> int:
    """Allocate the 1-based call number for a sequence.

    The counter lives in the SIM-4.1 session store under the caller's
    ``X-Mock-Session`` token, so a new token (or session expiry) resets the
    sequence. Without a session header the counter falls back to a synthetic
    scenario + client IP session. When no store is available, or the store is
    at capacity, the sequence serves its first response.
    """
    if store is None:
        return 1
    token = session_token or f"{_IP_SESSION_PREFIX}:{scenario.name}:{client_ip}"
    key = SessionKey(tenant=tenant, project=project, version=version, session_token=token)
    collection_path = f"{_SEQUENCE_NAMESPACE}/{scenario.name}/{operation_key}"
    if rule_index is not None:
        # Each rule advances its own sequence; the fallback list keeps the
        # pre-rule path so existing sessions keep their position.
        collection_path = f"{collection_path}/rule/{rule_index}"
    try:
        return await store.next_integer_id(key, collection_path)
    except SessionStoreError:
        return 1


def _build_response(canned: ScenarioResponse) -> Response:
    """Serialize one canned response into a FastAPI :class:`Response`."""
    media_type = canned.media_type
    response: Response
    if not canned.has_body:
        response = Response(status_code=canned.status)
    elif media_type.endswith("json") or media_type.endswith("+json"):
        response = JSONResponse(status_code=canned.status, content=canned.body, media_type=media_type)
    elif isinstance(canned.body, str):
        response = Response(content=canned.body, status_code=canned.status, media_type=media_type)
    elif canned.body is None:
        response = Response(status_code=canned.status, media_type=media_type)
    else:
        # Non-string body under a non-JSON media type: keep the declared media
        # type but serialize the JSON value as text.
        response = Response(
            content=json.dumps(canned.body),
            status_code=canned.status,
            media_type=media_type,
        )
    for name, value in canned.headers:
        response.headers[name] = value
    return response


def _render_canned(
    canned: ScenarioResponse,
    *,
    ctx: MatchContext,
    seed: int,
    fixtures: Mapping[str, Any],
    scenario_name: str,
    operation_key: str,
    rule_index: int | None,
    response_index: int,
) -> ScenarioResponse:
    """Render one canned response's templates (#4744, PMR-2.1).

    The RNG is scoped to (seed, scenario, operation, rule, response), so the same stored
    response and ``__seed`` always render byte-identical output. Rendered header values that
    gain CR/LF characters are dropped — a template must never enable header injection.

    Raises:
        app.mock_template.TemplateLimitError: When the render budget is exhausted.
    """
    env = RenderEnv(
        ctx=ctx,
        rng=make_rng(seed, scenario_name, operation_key, str(rule_index), str(response_index)),
        fixtures=fixtures,
    )
    budget = RenderBudget()
    body = render_value(canned.body, env, budget) if canned.has_body else canned.body
    headers: list[tuple[str, str]] = []
    for name, value in canned.headers:
        rendered = render_text(value, env, budget)
        if "\r" in rendered or "\n" in rendered:
            continue
        headers.append((name, rendered))
    return ScenarioResponse(
        status=canned.status,
        headers=tuple(headers),
        body=body,
        has_body=canned.has_body,
        media_type=canned.media_type,
    )


async def serve_scenario_response(
    *,
    scenario: Scenario,
    responses: tuple[ScenarioResponse, ...],
    operation_key: str,
    rule_index: int | None,
    ctx: MatchContext,
    seed: int,
    fixtures: Mapping[str, Any],
    tenant: str,
    project: str,
    version: str,
    session_token: str | None,
    client_ip: str,
    store: SessionStore | None,
) -> Response:
    """Return the canned response for one scenario-overridden operation.

    Single-response overrides always serve that response. Sequences advance
    per call (position from :func:`_sequence_call_number`) and stick on the
    last response once exhausted. Templates in the chosen response render
    against ``ctx`` with seeded randomness and fixture data (#4744, PMR-2.1).
    The response echoes the scenario name in ``X-Mock-Scenario``, the matched
    rule number in ``X-Mock-Scenario-Rule`` (rules only), and, for sequences,
    the call number in ``X-Mock-Scenario-Call``.

    Raises:
        app.mock_template.TemplateLimitError: When template rendering
            exhausts its CPU or output budget (the caller maps this to a
            problem response).
    """
    call_number = 1
    if len(responses) > 1:
        call_number = await _sequence_call_number(
            scenario=scenario,
            operation_key=operation_key,
            rule_index=rule_index,
            tenant=tenant,
            project=project,
            version=version,
            session_token=session_token,
            client_ip=client_ip,
            store=store,
        )
    index = min(call_number - 1, len(responses) - 1)
    rendered = _render_canned(
        responses[index],
        ctx=ctx,
        seed=seed,
        fixtures=fixtures,
        scenario_name=scenario.name,
        operation_key=operation_key,
        rule_index=rule_index,
        response_index=index,
    )
    response = _build_response(rendered)
    response.headers[MOCK_SCENARIO_HEADER] = scenario.name
    if rule_index is not None:
        response.headers[SCENARIO_RULE_HEADER] = str(rule_index + 1)
    if len(responses) > 1:
        response.headers[SCENARIO_CALL_HEADER] = str(call_number)
    return response
