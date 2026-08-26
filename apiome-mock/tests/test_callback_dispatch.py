"""Callback delivery tests (#4746, PMR-2.3).

These cover the four gates a delivery runs — render, validate, authorize, deliver — plus the
observability the acceptance criteria ask for: every outcome recorded, and retries that replay
identically. The transport is a recording double, so an attempt timeline can be asserted exactly
without a socket and without waiting out a backoff.
"""

from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import patch

import pytest
from app.mock_callbacks import CALLBACK_FORMAT
from app.mock_match import MatchContext

from apiome_mock.callback_dispatch import (
    CALLBACK_ATTEMPT_HEADER,
    CALLBACK_HEADER,
    CallbackDispatcher,
    DeliveryLog,
    DeliveryRecord,
    DispatchRequest,
    OutboundRequest,
    TransportError,
    build_dispatcher,
    redact_destination,
)
from apiome_mock.callbacks import CallbackDefinition, parse_callbacks

DESTINATION = "https://hooks.example.com/orders"

BASE_CALLBACK = {
    "callbackFormat": CALLBACK_FORMAT,
    "destinations": [DESTINATION],
    "request": {"headers": {"X-Event": "order.created"}, "body": {"id": "{{request.body#/id}}"}},
    "retry": {"maxAttempts": 3, "backoffMs": 10, "backoffMultiplier": 2.0, "retryOn": [503]},
}


def _definition(**overrides: Any) -> CallbackDefinition:
    """Parse one definition through the runtime loader, with overrides applied."""
    raw = {**BASE_CALLBACK, **overrides}
    return parse_callbacks({"callbacks": {"order-created": raw}})["order-created"]


def _ctx(body: Any = None) -> MatchContext:
    return MatchContext(
        method="POST",
        path_params={},
        query={},
        headers={},
        body=body,
        body_present=body is not None,
    )


class RecordingTransport:
    """A transport that replays a scripted sequence of statuses and records what it was sent."""

    def __init__(self, script: list[int | TransportError] | None = None) -> None:
        self.script: list[int | TransportError] = list(script or [200])
        self.sent: list[OutboundRequest] = []

    async def send(self, request: OutboundRequest) -> int:
        self.sent.append(request)
        outcome = self.script[min(len(self.sent) - 1, len(self.script) - 1)]
        if isinstance(outcome, TransportError):
            raise outcome
        return outcome


class Sleeper:
    """Records the backoff waits the dispatcher asks for instead of performing them."""

    def __init__(self) -> None:
        self.waits: list[float] = []

    async def __call__(self, seconds: float) -> None:
        self.waits.append(seconds)


@pytest.fixture
def sleeper() -> Sleeper:
    return Sleeper()


def _deliver(
    dispatcher: CallbackDispatcher,
    definition: CallbackDefinition,
    request: DispatchRequest,
) -> DeliveryRecord:
    """Run one delivery to completion on a fresh event loop.

    apiome-mock has no async plugin installed, so async behavior is exercised the way the rest of
    the suite does it: one ``asyncio.run`` per call. Nothing in a dispatcher is loop-bound, so
    consecutive calls against the same dispatcher accumulate into the same delivery log.
    """
    return asyncio.run(dispatcher.dispatch(definition, request))


def _dispatcher(transport: RecordingTransport, sleeper: Sleeper, **kwargs: Any) -> CallbackDispatcher:
    return CallbackDispatcher(
        transport=transport,
        # Every destination in these tests is a public example.com host, so the DNS-backed SSRF
        # check is skipped: the allowlist and policy behavior are asserted directly below.
        allow_private_destinations=True,
        sleeper=sleeper,
        **kwargs,
    )


# ---------------------------------------------------------------------------
# Rendering and schema validation
# ---------------------------------------------------------------------------


def test_renders_the_payload_from_the_triggering_request(sleeper: Sleeper) -> None:
    transport = RecordingTransport([200])
    record = _deliver(
        _dispatcher(transport, sleeper),
        _definition(),
        DispatchRequest(ctx=_ctx({"id": "order-7"}), trigger="POST /orders"),
    )
    assert record.outcome == "delivered"
    assert transport.sent[0].body == '{"id": "order-7"}'
    assert ("X-Event", "order.created") in transport.sent[0].headers


def test_stamps_provenance_headers_on_every_attempt(sleeper: Sleeper) -> None:
    transport = RecordingTransport([503, 200])
    _deliver(_dispatcher(transport, sleeper), _definition(), DispatchRequest(ctx=_ctx({"id": "x"})))
    attempts = [dict(request.headers) for request in transport.sent]
    assert [entry[CALLBACK_ATTEMPT_HEADER] for entry in attempts] == ["1", "2"]
    assert all(entry[CALLBACK_HEADER] == "order-created" for entry in attempts)


def test_seeded_randomness_makes_a_payload_reproducible(sleeper: Sleeper) -> None:
    definition = _definition(request={"body": {"id": "{{random.uuid()}}"}})
    bodies = []
    for _ in range(2):
        transport = RecordingTransport([200])
        _deliver(_dispatcher(transport, sleeper), definition, DispatchRequest(ctx=_ctx(), seed=42))
        bodies.append(transport.sent[0].body)
    assert bodies[0] == bodies[1]


def test_a_payload_failing_the_declared_schema_is_never_delivered(sleeper: Sleeper) -> None:
    definition = _definition(
        request={"body": {"id": 7}},
        payloadSchema={"type": "object", "properties": {"id": {"type": "string"}}},
    )
    transport = RecordingTransport([200])
    record = _deliver(_dispatcher(transport, sleeper), definition, DispatchRequest(ctx=_ctx()))
    assert record.outcome == "invalid-payload"
    assert record.attempts == ()
    assert transport.sent == []


def test_a_payload_matching_the_declared_schema_is_delivered(sleeper: Sleeper) -> None:
    definition = _definition(
        request={"body": {"id": "abc"}},
        payloadSchema={"type": "object", "required": ["id"], "properties": {"id": {"type": "string"}}},
    )
    transport = RecordingTransport([200])
    record = _deliver(_dispatcher(transport, sleeper), definition, DispatchRequest(ctx=_ctx()))
    assert record.outcome == "delivered"


def test_a_payload_schema_ref_resolves_against_the_served_spec(sleeper: Sleeper) -> None:
    spec = {"components": {"schemas": {"OrderEvent": {"type": "object", "required": ["id"]}}}}
    definition = _definition(
        request={"body": ["not-an-object"]},
        payloadSchema={"$ref": "#/components/schemas/OrderEvent"},
    )
    transport = RecordingTransport([200])
    record = _deliver(_dispatcher(transport, sleeper), definition, DispatchRequest(ctx=_ctx(), schema_root=spec))
    assert record.outcome == "invalid-payload"


def test_a_definition_without_a_body_sends_none(sleeper: Sleeper) -> None:
    transport = RecordingTransport([204])
    record = _deliver(
        _dispatcher(transport, sleeper), _definition(request={"method": "GET"}), DispatchRequest(ctx=_ctx())
    )
    assert record.outcome == "delivered"
    assert transport.sent[0].body is None
    assert all(name != "Content-Type" for name, _ in transport.sent[0].headers)


def test_an_explicit_payload_replaces_the_template(sleeper: Sleeper) -> None:
    transport = RecordingTransport([200])
    _deliver(
        _dispatcher(transport, sleeper),
        _definition(),
        DispatchRequest(ctx=_ctx(), payload_override={"id": "manual"}, has_payload_override=True),
    )
    assert transport.sent[0].body == '{"id": "manual"}'


# ---------------------------------------------------------------------------
# Destination authorization
# ---------------------------------------------------------------------------


def test_a_destination_outside_the_allowlist_is_rejected_before_rendering(sleeper: Sleeper) -> None:
    transport = RecordingTransport([200])
    record = _deliver(
        _dispatcher(transport, sleeper),
        _definition(),
        DispatchRequest(ctx=_ctx(), destination="https://evil.example.com/steal"),
    )
    assert record.outcome == "rejected"
    assert "not allowlisted" in record.detail
    assert transport.sent == []


def test_an_allowlisted_descendant_destination_is_delivered_to(sleeper: Sleeper) -> None:
    transport = RecordingTransport([200])
    record = _deliver(
        _dispatcher(transport, sleeper),
        _definition(),
        DispatchRequest(ctx=_ctx(), destination=f"{DESTINATION}/42"),
    )
    assert record.outcome == "delivered"
    assert transport.sent[0].url == f"{DESTINATION}/42"


def test_a_private_destination_is_refused_when_the_deployment_is_fail_closed(
    sleeper: Sleeper,
) -> None:
    definition = _definition(destinations=["http://127.0.0.1:9000/hook"])
    transport = RecordingTransport([200])
    dispatcher = CallbackDispatcher(transport=transport, allow_private_destinations=False, sleeper=sleeper)
    # Pinned rather than inherited: APIOME_SSRF_ALLOW_PRIVATE is a documented local-development
    # escape hatch, and this assertion is about the default posture.
    with patch("app.ssrf_guard.settings.ssrf_allow_private", False):
        record = _deliver(dispatcher, definition, DispatchRequest(ctx=_ctx()))
    assert record.outcome == "rejected"
    assert "outbound network policy" in record.detail
    assert transport.sent == []


def test_a_private_destination_is_delivered_when_the_deployment_opts_in(sleeper: Sleeper) -> None:
    definition = _definition(destinations=["http://127.0.0.1:9000/hook"])
    transport = RecordingTransport([202])
    record = _deliver(_dispatcher(transport, sleeper), definition, DispatchRequest(ctx=_ctx()))
    assert record.outcome == "delivered"
    assert transport.sent[0].url == "http://127.0.0.1:9000/hook"


# ---------------------------------------------------------------------------
# Retries: deterministic by construction
# ---------------------------------------------------------------------------


def test_retries_follow_the_declared_schedule_and_stop_on_success(sleeper: Sleeper) -> None:
    transport = RecordingTransport([503, 503, 200])
    record = _deliver(_dispatcher(transport, sleeper), _definition(), DispatchRequest(ctx=_ctx()))
    assert record.outcome == "delivered"
    assert [attempt.delay_ms for attempt in record.attempts] == [0, 10, 20]
    assert [attempt.status for attempt in record.attempts] == [503, 503, 200]
    assert sleeper.waits == [0.010, 0.020]


def test_a_non_retryable_status_stops_after_one_attempt(sleeper: Sleeper) -> None:
    transport = RecordingTransport([500])
    record = _deliver(_dispatcher(transport, sleeper), _definition(), DispatchRequest(ctx=_ctx()))
    assert record.outcome == "failed"
    assert len(record.attempts) == 1
    assert sleeper.waits == []


def test_attempts_are_capped_by_max_attempts(sleeper: Sleeper) -> None:
    transport = RecordingTransport([503])
    record = _deliver(_dispatcher(transport, sleeper), _definition(), DispatchRequest(ctx=_ctx()))
    assert record.outcome == "failed"
    assert len(record.attempts) == 3
    assert record.status == 503


def test_a_transport_failure_is_retried_and_reported(sleeper: Sleeper) -> None:
    transport = RecordingTransport([TransportError("ConnectError: refused"), 200])
    record = _deliver(_dispatcher(transport, sleeper), _definition(), DispatchRequest(ctx=_ctx()))
    assert record.outcome == "delivered"
    assert record.attempts[0].status is None
    assert record.attempts[0].error == "ConnectError: refused"


def test_the_same_definition_replays_an_identical_timeline(sleeper: Sleeper) -> None:
    """Fixture-driven retries are deterministic: no jitter, no clock, no per-run variance."""

    def _timeline(record: DeliveryRecord) -> list[tuple[int, int, int | None]]:
        return [(a.attempt, a.delay_ms, a.status) for a in record.attempts]

    first = _deliver(
        _dispatcher(RecordingTransport([503, 503, 200]), Sleeper()),
        _definition(),
        DispatchRequest(ctx=_ctx()),
    )
    second = _deliver(
        _dispatcher(RecordingTransport([503, 503, 200]), Sleeper()),
        _definition(),
        DispatchRequest(ctx=_ctx()),
    )
    assert _timeline(first) == _timeline(second)
    assert first.id == second.id == "delivery-1"


def test_a_single_attempt_definition_never_waits(sleeper: Sleeper) -> None:
    definition = _definition(retry={"maxAttempts": 1})
    transport = RecordingTransport([503])
    record = _deliver(_dispatcher(transport, sleeper), definition, DispatchRequest(ctx=_ctx()))
    assert len(record.attempts) == 1
    assert sleeper.waits == []


def test_the_deployment_timeout_caps_the_definition(sleeper: Sleeper) -> None:
    definition = _definition(retry={"maxAttempts": 1, "timeoutMs": 30_000})
    transport = RecordingTransport([200])
    dispatcher = _dispatcher(transport, sleeper, timeout_seconds=2.0)
    _deliver(dispatcher, definition, DispatchRequest(ctx=_ctx()))
    assert transport.sent[0].timeout_seconds == 2.0


# ---------------------------------------------------------------------------
# Observability
# ---------------------------------------------------------------------------


def test_every_outcome_lands_in_the_delivery_log(sleeper: Sleeper) -> None:
    dispatcher = _dispatcher(RecordingTransport([200]), sleeper)
    _deliver(dispatcher, _definition(), DispatchRequest(ctx=_ctx(), trigger="POST /orders"))
    _deliver(dispatcher, _definition(), DispatchRequest(ctx=_ctx(), destination="https://evil.example.com/x"))
    outcomes = [record.outcome for record in dispatcher.log.recent()]
    assert outcomes == ["delivered", "rejected"]
    assert [record.id for record in dispatcher.log.recent()] == ["delivery-1", "delivery-2"]


def test_the_delivery_log_is_bounded_and_filterable(sleeper: Sleeper) -> None:
    log = DeliveryLog(max_records=2)
    dispatcher = _dispatcher(RecordingTransport([200]), sleeper, log=log)
    for _ in range(3):
        _deliver(dispatcher, _definition(), DispatchRequest(ctx=_ctx()))
    assert [record.id for record in log.recent()] == ["delivery-2", "delivery-3"]
    assert log.recent(limit=1)[0].id == "delivery-3"
    assert log.recent(callback="nope") == ()
    log.clear()
    assert log.recent() == ()


def test_a_record_carries_the_definition_digest_and_trigger(sleeper: Sleeper) -> None:
    definition = _definition()
    record = _deliver(
        _dispatcher(RecordingTransport([200]), sleeper),
        definition,
        DispatchRequest(ctx=_ctx(), trigger="POST /orders", session="test-1"),
    )
    assert record.digest == definition.digest
    assert record.trigger == "POST /orders"
    assert record.session == "test-1"
    assert record.delivered is True


def test_a_record_redacts_the_destination_query_string(sleeper: Sleeper) -> None:
    record = _deliver(
        _dispatcher(RecordingTransport([200]), sleeper),
        _definition(),
        DispatchRequest(ctx=_ctx(), destination=f"{DESTINATION}?token=super-secret"),
    )
    assert record.destination == DESTINATION
    assert "super-secret" not in str(record.as_dict())


def test_redact_destination_keeps_origin_and_path() -> None:
    assert redact_destination("https://h.example.com:8443/a/b?x=1#f") == "https://h.example.com:8443/a/b"
    assert redact_destination("not a url") == "not a url"


def test_build_dispatcher_returns_none_when_callbacks_are_disabled() -> None:
    assert build_dispatcher(enabled=False, allow_private_destinations=False, timeout_seconds=5.0) is None
    dispatcher = build_dispatcher(enabled=True, allow_private_destinations=True, timeout_seconds=5.0)
    assert dispatcher is not None
    assert dispatcher.allow_private_destinations is True


def test_a_misbehaving_transport_becomes_an_outcome_not_an_exception(sleeper: Sleeper) -> None:
    """A delivery fault must never turn a correct mocked response into a 500."""

    class BrokenTransport:
        async def send(self, request: OutboundRequest) -> int:
            raise ZeroDivisionError("boom")

    dispatcher = CallbackDispatcher(transport=BrokenTransport(), allow_private_destinations=True, sleeper=sleeper)
    record = _deliver(dispatcher, _definition(), DispatchRequest(ctx=_ctx()))
    assert record.outcome == "error"
    assert "ZeroDivisionError" in record.detail


def test_aclose_is_safe_for_a_transport_that_holds_nothing(sleeper: Sleeper) -> None:
    asyncio.run(_dispatcher(RecordingTransport([200]), sleeper).aclose())
