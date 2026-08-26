"""Outbound callback/webhook delivery for the mock runtime (#4746, PMR-2.3).

:mod:`apiome_mock.callbacks` parses *what* a version promises to send; this module actually sends
it, and is where the acceptance boundary of PMR-2.3 is enforced. One delivery runs four gates, in
this order, and stops at the first one that fails:

1. **Render.** The payload and header values are rendered with the same bounded template engine
   scenario responses use (:mod:`app.mock_template`), so an event body can be driven by fixture
   packs (``{{fixture.<name>}}``) and by the triggering request, deterministically for a seed.
2. **Validate.** The rendered payload is checked against the definition's declared
   ``payloadSchema``. A payload that does not validate is *never* delivered — the runtime refuses
   to teach a consumer a shape the contract does not promise.
3. **Authorize.** The target must match the definition's destination allowlist, and it must
   satisfy the SSRF policy (:mod:`app.ssrf_guard`): public addresses only, no credentials in the
   URL, ``http``/``https`` only. Deployments that legitimately deliver to a local receiver (a CI
   job's own listener) opt in explicitly with ``allow_private_destinations``.
4. **Deliver.** Attempts follow the definition's :class:`~apiome_mock.callbacks.RetryPolicy`,
   whose delays are a pure function of the stored knobs — no jitter, no clock input — so the same
   fixture-driven event always produces the same attempt timeline.

Every delivery, including one that never left the process, produces a :class:`DeliveryRecord`:
appended to a bounded in-memory :class:`DeliveryLog` (served by ``__mock__/callbacks/deliveries``)
and emitted as structured log lines, one per attempt plus one terminal line. Records and logs
carry the destination's origin and path but never its query string, never header values, and
never the payload — a webhook URL routinely carries a bearer token in its query, and a mock must
not be the thing that writes it to a CI log.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal, Mapping, Protocol
from urllib.parse import urlsplit, urlunsplit

import httpx
import structlog
from app.mock_match import MatchContext
from app.mock_template import RenderBudget, RenderEnv, TemplateLimitError, make_rng, render_text, render_value
from app.ssrf_guard import SSRFError, build_guarded_async_client, validate_url, validate_url_policy

from apiome_mock.callbacks import CallbackDefinition
from apiome_mock.schema_synthesizer import validate_value

__all__ = [
    "CALLBACK_ATTEMPT_HEADER",
    "CALLBACK_HEADER",
    "CALLBACK_URL_HEADER",
    "DEFAULT_DELIVERY_LOG_SIZE",
    "CallbackDispatcher",
    "CallbackTransport",
    "DeliveryAttempt",
    "DeliveryLog",
    "DeliveryRecord",
    "HttpxCallbackTransport",
    "OutboundRequest",
    "TransportError",
    "build_dispatcher",
    "redact_destination",
]

_log = structlog.get_logger(__name__)

#: Two directions, one name. On the response to a triggering request it summarizes what fired
#: (``name=outcome`` pairs); on the outbound callback it names the definition that produced it.
CALLBACK_HEADER = "X-Mock-Callback"

#: Header stamped on every outbound callback carrying the 1-based attempt number, so a receiver
#: can tell a retry from a fresh event without diffing payloads.
CALLBACK_ATTEMPT_HEADER = "X-Mock-Callback-Attempt"

#: Request header a consumer sets to choose *its own* receiver for the callbacks a request fires.
#: The value still has to match the definition's allowlist — naming a destination is a choice
#: among authorized ones, never a way to add one.
CALLBACK_URL_HEADER = "X-Mock-Callback-Url"

#: Delivery records held per runtime before the oldest is dropped.
DEFAULT_DELIVERY_LOG_SIZE = 100

#: Terminal outcomes of one delivery.
Outcome = Literal["delivered", "failed", "rejected", "invalid-payload", "render-failed", "error"]


class TransportError(RuntimeError):
    """One delivery attempt never produced a response (timeout, DNS, connection refused)."""


@dataclass(frozen=True)
class OutboundRequest:
    """One outbound callback request, fully rendered and authorized.

    Attributes:
        method: HTTP method.
        url: Absolute destination URL (already allowlist- and SSRF-checked).
        headers: Header pairs to send, the runtime's own markers included.
        body: Serialized request body, or ``None`` when the definition declares none.
        timeout_seconds: Per-attempt timeout.
    """

    method: str
    url: str
    headers: tuple[tuple[str, str], ...]
    body: str | None
    timeout_seconds: float


class CallbackTransport(Protocol):
    """How the dispatcher puts one request on the wire.

    Extracted as a protocol so tests can assert the full retry timeline without a socket, and so
    a deployment can substitute a transport with its own connection policy.
    """

    async def send(self, request: OutboundRequest) -> int:
        """Send one request and return the response status.

        Args:
            request: The rendered, authorized outbound request.

        Returns:
            The destination's HTTP response status.

        Raises:
            TransportError: The attempt produced no response at all.
        """
        ...  # pragma: no cover - protocol declaration


@dataclass(frozen=True)
class DeliveryAttempt:
    """One attempt within a delivery.

    Attributes:
        attempt: 1-based attempt number.
        delay_ms: Delay waited *before* this attempt (0 for the first).
        status: Response status, or ``None`` when the attempt produced no response.
        error: Transport error message when ``status`` is ``None``.
        duration_ms: Wall-clock duration of the attempt itself, excluding the delay.
    """

    attempt: int
    delay_ms: int
    status: int | None = None
    error: str | None = None
    duration_ms: float = 0.0

    def as_dict(self) -> dict[str, Any]:
        """Render the attempt for JSON output and structured logs."""
        return {
            "attempt": self.attempt,
            "delayMs": self.delay_ms,
            "status": self.status,
            "error": self.error,
            "durationMs": round(self.duration_ms, 3),
        }


@dataclass(frozen=True)
class DeliveryRecord:
    """The observable outcome of one callback delivery.

    Attributes:
        id: Monotonic per-runtime identifier (``"delivery-1"``), stable across replays.
        callback: The definition's name.
        digest: The definition's content digest.
        outcome: Terminal outcome (see :data:`Outcome`).
        detail: One human-readable sentence explaining the outcome.
        destination: The delivery target, with its query string redacted.
        method: Outbound HTTP method.
        trigger: What fired the delivery — an operation key, or ``"manual"``.
        status: Status of the final attempt, when there was one.
        attempts: Every attempt made, in order.
        session: The ``X-Mock-Session`` token of the triggering request, when present.
    """

    id: str
    callback: str
    digest: str
    outcome: Outcome
    detail: str
    destination: str
    method: str
    trigger: str
    status: int | None = None
    attempts: tuple[DeliveryAttempt, ...] = ()
    session: str | None = None

    @property
    def delivered(self) -> bool:
        """Whether the destination accepted the callback."""
        return self.outcome == "delivered"

    def as_dict(self) -> dict[str, Any]:
        """Render the record for the deliveries endpoint and structured logs."""
        return {
            "id": self.id,
            "callback": self.callback,
            "digest": self.digest,
            "outcome": self.outcome,
            "detail": self.detail,
            "destination": self.destination,
            "method": self.method,
            "trigger": self.trigger,
            "status": self.status,
            "session": self.session,
            "attempts": [attempt.as_dict() for attempt in self.attempts],
        }


def redact_destination(url: str) -> str:
    """Return a destination safe to log: origin and path only.

    A webhook URL routinely carries a token in its query string (``?key=...``). Delivery records
    and log lines are read in CI output and bug reports, so the query and fragment are dropped
    rather than trusted to be boring.

    Args:
        url: The delivery target.

    Returns:
        ``scheme://host[:port]/path``, or the input unchanged when it cannot be parsed.
    """
    try:
        parts = urlsplit(url)
    except ValueError:  # pragma: no cover - urlsplit is extremely permissive
        return url
    if not parts.scheme or not parts.netloc:
        return url
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))


class DeliveryLog:
    """A bounded, in-order record of the runtime's most recent callback deliveries.

    The log is what makes delivery outcomes *assertable* rather than merely printed: a test drives
    the triggering request, then reads ``__mock__/callbacks/deliveries`` and checks the exact
    attempt timeline. It is deliberately in-memory and bounded — a mock's observability should
    never become a place data accumulates.
    """

    def __init__(self, max_records: int = DEFAULT_DELIVERY_LOG_SIZE) -> None:
        """Create a log holding at most ``max_records`` deliveries.

        Args:
            max_records: Records kept before the oldest is discarded (at least 1).
        """
        self._records: deque[DeliveryRecord] = deque(maxlen=max(1, max_records))
        self._sequence = 0

    def next_id(self) -> str:
        """Allocate the next delivery identifier.

        Identifiers are a monotonic counter rather than a random or time-based value, so two runs
        of the same test produce byte-identical delivery records.

        Returns:
            ``"delivery-<n>"``.
        """
        self._sequence += 1
        return f"delivery-{self._sequence}"

    def record(self, record: DeliveryRecord) -> DeliveryRecord:
        """Append one record and return it unchanged (for call-site chaining)."""
        self._records.append(record)
        return record

    def recent(self, limit: int | None = None, *, callback: str | None = None) -> tuple[DeliveryRecord, ...]:
        """Return recorded deliveries, newest last.

        Args:
            limit: Maximum records to return (the most recent ones); ``None`` for all.
            callback: Return only records for this definition name when given.

        Returns:
            The selected records in delivery order.
        """
        records = [record for record in self._records if callback is None or record.callback == callback]
        if limit is not None:
            records = records[-limit:] if limit > 0 else []
        return tuple(records)

    def clear(self) -> None:
        """Drop every recorded delivery (the identifier counter keeps advancing)."""
        self._records.clear()


class HttpxCallbackTransport:
    """The default transport: one guarded ``httpx.AsyncClient`` per dispatcher.

    Redirects are never followed. A webhook receiver that answers 302 is answering; chasing the
    redirect would deliver the payload to a URL no allowlist entry ever authorized.
    """

    def __init__(self, *, allow_private_destinations: bool = False) -> None:
        """Create the transport.

        Args:
            allow_private_destinations: Relax the SSRF hook to shape checks only, for a
                deployment that delivers to a local receiver on purpose.
        """
        self._allow_private = allow_private_destinations
        self._client: httpx.AsyncClient | None = None

    async def send(self, request: OutboundRequest) -> int:
        """Send one request through the guarded client and return its status."""
        client = self._ensure_client()
        try:
            response = await client.request(
                request.method,
                request.url,
                headers=dict(request.headers),
                content=request.body,
                timeout=request.timeout_seconds,
            )
        except SSRFError as exc:
            raise TransportError(str(exc)) from exc
        except Exception as exc:  # httpx transport/timeout errors
            raise TransportError(f"{type(exc).__name__}: {exc}") from exc
        return int(response.status_code)

    def _ensure_client(self) -> httpx.AsyncClient:
        """Build the guarded client on first use, so a dispatcher that never delivers costs nothing."""
        if self._client is None:
            self._client = build_guarded_async_client(
                allow_private=self._allow_private,
                follow_redirects=False,
            )
        return self._client

    async def aclose(self) -> None:
        """Close the underlying client, if one was ever built."""
        if self._client is not None:
            await self._client.aclose()
            self._client = None


@dataclass
class DispatchRequest:
    """Everything one delivery needs beyond the definition itself.

    Attributes:
        ctx: Template/predicate view of the triggering request (``None`` for a manual trigger
            with no request context, which renders against an empty context).
        seed: Seed for the template engine's randomness, so payloads are reproducible.
        fixtures: Fixture data readable as ``{{fixture.<name>}}``.
        schema_root: The OpenAPI document ``payloadSchema`` ``$ref``s resolve against.
        destination: The caller's requested target, or ``None`` for the definition's default.
        trigger: What fired this delivery (an operation key, or ``"manual"``).
        session: The triggering request's ``X-Mock-Session`` token, when present.
        payload_override: A payload supplied by an explicit trigger, replacing the template.
    """

    ctx: MatchContext | None = None
    seed: int = 0
    fixtures: Mapping[str, Any] = field(default_factory=dict)
    schema_root: dict[str, Any] | None = None
    destination: str | None = None
    trigger: str = "manual"
    session: str | None = None
    payload_override: Any = None
    has_payload_override: bool = False


_EMPTY_CTX = MatchContext(method="", path_params={}, query={}, headers={}, body=None, body_present=False)


class CallbackDispatcher:
    """Renders, validates, authorizes, and delivers one callback at a time.

    A dispatcher owns the deployment-level policy (are outbound callbacks enabled at all, may they
    reach private addresses, how long may one attempt take) and the runtime's
    :class:`DeliveryLog`. The per-callback policy — payload, schema, allowlist, retries — comes
    from the definition.
    """

    def __init__(
        self,
        *,
        transport: CallbackTransport | None = None,
        allow_private_destinations: bool = False,
        timeout_seconds: float = 5.0,
        log: DeliveryLog | None = None,
        sleeper: Callable[[float], Awaitable[None]] | None = None,
    ) -> None:
        """Create a dispatcher.

        Args:
            transport: How requests reach the wire; defaults to :class:`HttpxCallbackTransport`.
            allow_private_destinations: Permit loopback/RFC1918 targets. Off by default: a mock
                must not become a confused deputy for internal services just because a tenant
                allowlisted one.
            timeout_seconds: Deployment ceiling on one attempt; a definition's ``timeoutMs`` may
                lower it but never raise it.
            log: The delivery log to record into; a fresh bounded one by default.
            sleeper: Awaitable used for retry backoff, defaulting to :func:`asyncio.sleep`.
                Tests substitute a recorder so the deterministic schedule can be asserted without
                actually waiting.
        """
        self._transport = (
            transport
            if transport is not None
            else HttpxCallbackTransport(allow_private_destinations=allow_private_destinations)
        )
        self._allow_private = allow_private_destinations
        self._timeout_seconds = timeout_seconds
        self.log = log if log is not None else DeliveryLog()
        self._sleep: Callable[[float], Awaitable[None]] = sleeper if sleeper is not None else asyncio.sleep

    @property
    def allow_private_destinations(self) -> bool:
        """Whether this deployment permits non-public delivery targets."""
        return self._allow_private

    async def aclose(self) -> None:
        """Release the transport's resources, if it holds any.

        Called from the runtime's shutdown path. Transports are free not to implement it (a test
        double usually holds nothing), so the capability is probed rather than required.
        """
        closer = getattr(self._transport, "aclose", None)
        if closer is not None:
            await closer()

    async def dispatch(self, definition: CallbackDefinition, request: DispatchRequest) -> DeliveryRecord:
        """Run one callback delivery end to end and return its record.

        The record is appended to the dispatcher's :class:`DeliveryLog` and logged before it is
        returned, so an outcome is observable even when the caller discards it.

        Args:
            definition: The callback to deliver.
            request: The delivery's context (see :class:`DispatchRequest`).

        Returns:
            The :class:`DeliveryRecord`, whose ``outcome`` names which gate the delivery reached.
        """
        record_id = self.log.next_id()
        target = definition.authorized_destination(request.destination)
        redacted = redact_destination(target if target is not None else (request.destination or ""))

        def _finish(
            outcome: Outcome,
            detail: str,
            *,
            status: int | None = None,
            attempts: tuple[DeliveryAttempt, ...] = (),
        ) -> DeliveryRecord:
            """Record, log, and return the delivery's terminal outcome."""
            record = DeliveryRecord(
                id=record_id,
                callback=definition.name,
                digest=definition.digest,
                outcome=outcome,
                detail=detail,
                destination=redacted,
                method=definition.method,
                trigger=request.trigger,
                session=request.session,
                status=status,
                attempts=attempts,
            )
            self.log.record(record)
            _log.info(
                "mock_callback_delivery",
                callback=record.callback,
                digest=record.digest,
                outcome=record.outcome,
                destination=record.destination,
                method=record.method,
                trigger=record.trigger,
                status=record.status,
                attempts=len(record.attempts),
                detail=record.detail,
            )
            return record

        if target is None:
            return _finish(
                "rejected",
                "Destination is not allowlisted for this callback.",
            )

        try:
            payload, headers, has_payload = self._render(definition, request)
        except TemplateLimitError as exc:
            return _finish("render-failed", f"Payload template exceeded its render limits: {exc}")

        if definition.payload_schema is not None:
            error = validate_value(payload, definition.payload_schema, request.schema_root)
            if error is not None:
                return _finish("invalid-payload", f"Rendered payload does not match the declared schema: {error}")

        authorization_error = await self._authorize(target)
        if authorization_error is not None:
            return _finish("rejected", authorization_error)

        try:
            attempts, status = await self._deliver(
                definition,
                target=target,
                payload=payload,
                has_payload=has_payload,
                headers=headers,
            )
        except Exception as exc:  # a transport that misbehaves is a callback problem, not a serving one
            # The mocked response itself is already correct and is about to be returned; letting a
            # delivery fault escape would turn a good 201 into a 500 for a reason the consumer did
            # not ask about. The fault becomes an observable outcome instead.
            _log.warning("mock_callback_dispatch_error", callback=definition.name, error=str(exc))
            return _finish("error", f"Callback delivery failed unexpectedly: {type(exc).__name__}: {exc}")
        if status is not None and 200 <= status < 400:
            return _finish(
                "delivered",
                f"Destination accepted the callback with {status}.",
                status=status,
                attempts=attempts,
            )
        detail = (
            f"Destination answered {status} on the final attempt."
            if status is not None
            else f"No response on the final attempt: {attempts[-1].error}"
        )
        return _finish("failed", detail, status=status, attempts=attempts)

    def _render(
        self,
        definition: CallbackDefinition,
        request: DispatchRequest,
    ) -> tuple[Any, tuple[tuple[str, str], ...], bool]:
        """Render the outbound payload and headers.

        The RNG is scoped to ``(seed, "callback", name)`` — not to the destination — so the same
        event renders byte-identically no matter where it is delivered.

        Returns:
            ``(payload, headers, has_payload)``; ``has_payload`` is ``False`` when the definition
            declares no body and no trigger supplied one, in which case nothing is sent.

        Raises:
            app.mock_template.TemplateLimitError: The render budget was exhausted.
        """
        env = RenderEnv(
            ctx=request.ctx if request.ctx is not None else _EMPTY_CTX,
            rng=make_rng(request.seed, "callback", definition.name),
            fixtures=request.fixtures,
        )
        budget = RenderBudget()
        has_payload = request.has_payload_override or definition.has_body
        if request.has_payload_override:
            payload = request.payload_override
        elif definition.has_body:
            payload = render_value(definition.body, env, budget)
        else:
            payload = None

        headers: list[tuple[str, str]] = []
        for name, value in definition.headers:
            rendered = render_text(value, env, budget)
            if "\r" in rendered or "\n" in rendered:
                # A rendered header that gained CR/LF would enable request splitting downstream.
                continue
            headers.append((name, rendered))
        return payload, tuple(headers), has_payload

    async def _authorize(self, target: str) -> str | None:
        """Apply the SSRF policy to an allowlisted target.

        The allowlist says which URLs an author *intended*; this says which of them the network
        policy permits. Both must hold. DNS resolution runs off the event loop.

        Args:
            target: The allowlisted delivery target.

        Returns:
            ``None`` when delivery may proceed, else the rejection detail.
        """
        try:
            if self._allow_private:
                validate_url_policy(target)
            else:
                await asyncio.to_thread(validate_url, target)
        except SSRFError as exc:
            return f"Destination failed the outbound network policy: {exc}"
        return None

    async def _deliver(
        self,
        definition: CallbackDefinition,
        *,
        target: str,
        payload: Any,
        has_payload: bool,
        headers: tuple[tuple[str, str], ...],
    ) -> tuple[tuple[DeliveryAttempt, ...], int | None]:
        """Run the definition's attempt schedule against ``target``.

        Returns:
            ``(attempts, final_status)`` — every attempt made, and the last status seen
            (``None`` when the final attempt produced no response).
        """
        body = json.dumps(payload) if has_payload else None
        timeout = min(definition.retry.timeout_ms / 1000.0, self._timeout_seconds)
        attempts: list[DeliveryAttempt] = []
        status: int | None = None

        for index in range(definition.retry.max_attempts):
            delay_ms = definition.retry.delays_ms[index - 1] if index > 0 else 0
            if delay_ms > 0:
                await self._sleep(delay_ms / 1000.0)

            outbound = OutboundRequest(
                method=definition.method,
                url=target,
                headers=(
                    *headers,
                    *((("Content-Type", "application/json"),) if body is not None else ()),
                    (CALLBACK_HEADER, definition.name),
                    (CALLBACK_ATTEMPT_HEADER, str(index + 1)),
                ),
                body=body,
                timeout_seconds=timeout,
            )
            started = time.perf_counter()
            error: str | None = None
            try:
                status = await self._transport.send(outbound)
            except TransportError as exc:
                status = None
                error = str(exc)
            duration_ms = (time.perf_counter() - started) * 1000

            attempt = DeliveryAttempt(
                attempt=index + 1,
                delay_ms=delay_ms,
                status=status,
                error=error,
                duration_ms=duration_ms,
            )
            attempts.append(attempt)
            _log.info(
                "mock_callback_attempt",
                callback=definition.name,
                destination=redact_destination(target),
                attempt=attempt.attempt,
                delay_ms=attempt.delay_ms,
                status=attempt.status,
                error=attempt.error,
                duration_ms=round(attempt.duration_ms, 3),
            )
            if not definition.retry.should_retry(status):
                break
        return tuple(attempts), status


def build_dispatcher(
    *,
    enabled: bool,
    allow_private_destinations: bool,
    timeout_seconds: float,
) -> CallbackDispatcher | None:
    """Build the runtime's dispatcher from resolved deployment settings.

    Both runtimes decide "outbound callbacks are off" the same way — by having no dispatcher at
    all — so a disabled deployment cannot deliver even if a definition, a bundle, or a control
    route asks it to.

    Args:
        enabled: Whether this deployment delivers callbacks at all.
        allow_private_destinations: Whether non-public destinations are permitted.
        timeout_seconds: Ceiling on one delivery attempt.

    Returns:
        The dispatcher, or ``None`` when callbacks are disabled.
    """
    if not enabled:
        return None
    return CallbackDispatcher(
        allow_private_destinations=allow_private_destinations,
        timeout_seconds=timeout_seconds,
    )
