"""Runtime callback/webhook definition loading (#4746, PMR-2.3).

Callback definitions are the outbound half of a contract: what the mock sends, where it is
allowed to send it, what the payload must look like, and how it retries. The author-time format
lives in :mod:`app.mock_callbacks`; this module is the *runtime* half, turning the ``callbacks``
key of stored mock settings (hosted: ``versions.mock_settings``; portable: the bundled settings
document) into immutable :class:`CallbackDefinition` objects the dispatcher delivers from.

Parsing follows the runtime's leniency rule (like :mod:`apiome_mock.scenarios` and
:mod:`apiome_mock.fixture_packs`): a malformed definition, destination, or header is skipped,
never raised, so a stored blob can never break serving. A definition that declares an
*unsupported* format id or version is skipped whole — misreading a future shape would be worse
than ignoring it. A definition left with no usable destination is dropped entirely: it could
never be delivered, and keeping it would only produce rejections that look like configuration
that "almost" works.

Each parsed definition carries the same digest the authoring API computed on save
(:func:`app.mock_callbacks.callback_digest` over the canonicalized document), so a test can pin
exactly which callback contract it exercised.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Mapping

from app.mock_callbacks import (
    ALLOWED_METHODS,
    CALLBACK_FORMAT,
    CALLBACK_FORMAT_VERSION,
    CALLBACK_NAME_PATTERN,
    DEFAULT_MAX_ATTEMPTS,
    DEFAULT_METHOD,
    DEFAULT_RETRY_ON,
    DEFAULT_TIMEOUT_MS,
    MAX_ATTEMPTS,
    MAX_TIMEOUT_MS,
    SUPPORTED_CALLBACK_FORMAT_VERSIONS,
    callback_digest,
    match_destination,
    normalize_destination,
    retry_delays,
)
from app.mock_template import value_references_request_body

__all__ = [
    "CallbackDefinition",
    "RetryPolicy",
    "callback_summary",
    "parse_callbacks",
]

#: Headers the runtime stamps on every outbound callback; a definition may not override them.
_RESERVED_HEADERS = frozenset(
    {"content-length", "transfer-encoding", "connection", "host", "x-mock-callback", "x-mock-callback-attempt"}
)


@dataclass(frozen=True)
class RetryPolicy:
    """The deterministic delivery schedule for one callback.

    Attributes:
        max_attempts: Total attempts, the initial one included (always ``>= 1``).
        delays_ms: Delay before each retry, in order. ``len(delays_ms) == max_attempts - 1``.
        retry_on: Response statuses that make another attempt worthwhile.
        timeout_ms: Per-attempt request timeout.
    """

    max_attempts: int = DEFAULT_MAX_ATTEMPTS
    delays_ms: tuple[int, ...] = ()
    retry_on: frozenset[int] = frozenset(DEFAULT_RETRY_ON)
    timeout_ms: int = DEFAULT_TIMEOUT_MS

    def should_retry(self, status: int | None) -> bool:
        """Whether a response status warrants another attempt.

        Args:
            status: The destination's response status, or ``None`` when the attempt never got
                one (a timeout or connection failure), which is always retryable.

        Returns:
            ``True`` when another attempt should be made (subject to :attr:`max_attempts`).
        """
        return status is None or status in self.retry_on


@dataclass(frozen=True)
class CallbackDefinition:
    """One parsed callback definition, ready to dispatch.

    Attributes:
        name: The definition's name (the key it is stored under).
        description: Author-provided description ("" when absent).
        digest: ``sha256:<hex>`` over the canonical document — its stable identity.
        format_version: The declared ``callbackFormatVersion``.
        operation_key: ``"METHOD /path"`` whose response fires this callback; ``None`` means the
            definition only ever fires from an explicit ``__mock__`` trigger.
        trigger_statuses: Response statuses that fire it; empty means "any 2xx".
        destinations: Canonical allowlist entries — the only authorized delivery targets.
        method: Outbound HTTP method.
        headers: Outbound header templates, in stored order.
        body: The outbound body template (rendered per delivery).
        has_body: Whether the definition declares a body at all.
        payload_schema: The declared payload schema the rendered body must satisfy, or ``None``.
        retry: The deterministic retry schedule.
        needs_request_body: Whether rendering reads the triggering request's body.
    """

    name: str
    description: str
    digest: str
    format_version: int
    operation_key: str | None = None
    trigger_statuses: tuple[int, ...] = ()
    destinations: tuple[str, ...] = ()
    method: str = DEFAULT_METHOD
    headers: tuple[tuple[str, str], ...] = ()
    body: Any = None
    has_body: bool = False
    payload_schema: Mapping[str, Any] | None = None
    retry: RetryPolicy = field(default_factory=RetryPolicy)
    needs_request_body: bool = False

    @property
    def default_destination(self) -> str:
        """The destination used when a caller names none — the first allowlisted entry."""
        return self.destinations[0]

    def fires_for(self, operation_key: str, status: int) -> bool:
        """Whether a served response should fire this callback.

        Args:
            operation_key: The canonical key of the operation that was served.
            status: The status the mock answered with.

        Returns:
            ``True`` when the definition names this operation *and* the status matches its
            declared trigger statuses (or, when it declares none, the status is 2xx). A
            definition with no ``trigger.operation`` never fires automatically.
        """
        if self.operation_key is None or self.operation_key != operation_key:
            return False
        if self.trigger_statuses:
            return status in self.trigger_statuses
        return 200 <= status < 300

    def authorized_destination(self, requested: str | None) -> str | None:
        """Resolve and authorize a delivery target against the allowlist.

        Args:
            requested: The caller's requested destination, or ``None`` to use
                :attr:`default_destination`.

        Returns:
            The URL to deliver to (the caller's, preserved verbatim apart from being a real
            absolute URL), or ``None`` when no allowlist entry authorizes it.
        """
        if requested is None:
            return self.default_destination
        if match_destination(requested, self.destinations) is None:
            return None
        return requested.strip()


def _parse_headers(raw: Any) -> tuple[tuple[str, str], ...]:
    """Extract string->string outbound header pairs, skipping anything malformed or reserved."""
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


def _parse_retry(raw: Any) -> RetryPolicy:
    """Build the retry policy, clamping every knob into its supported range."""
    block = raw if isinstance(raw, dict) else {}
    delays = retry_delays(block)
    attempts = len(delays) + 1

    raw_attempts = block.get("maxAttempts")
    if isinstance(raw_attempts, int) and not isinstance(raw_attempts, bool):
        attempts = max(1, min(raw_attempts, MAX_ATTEMPTS))

    retry_on: frozenset[int] = frozenset(DEFAULT_RETRY_ON)
    raw_retry_on = block.get("retryOn")
    if isinstance(raw_retry_on, list):
        codes = {code for code in raw_retry_on if isinstance(code, int) and not isinstance(code, bool)}
        if codes:
            retry_on = frozenset(codes)

    timeout_ms = DEFAULT_TIMEOUT_MS
    raw_timeout = block.get("timeoutMs")
    if isinstance(raw_timeout, int) and not isinstance(raw_timeout, bool) and raw_timeout > 0:
        timeout_ms = min(raw_timeout, MAX_TIMEOUT_MS)

    return RetryPolicy(
        max_attempts=attempts,
        delays_ms=delays,
        retry_on=retry_on,
        timeout_ms=timeout_ms,
    )


def _parse_trigger(raw: Any) -> tuple[str | None, tuple[int, ...]]:
    """Parse the ``trigger`` block into ``(operation_key, statuses)``."""
    if not isinstance(raw, dict):
        return None, ()
    operation_key: str | None = None
    operation = raw.get("operation")
    if isinstance(operation, str):
        parts = operation.strip().split(None, 1)
        if len(parts) == 2 and parts[0].isalpha() and parts[1].startswith("/"):
            operation_key = f"{parts[0].upper()} {parts[1]}"
    statuses: tuple[int, ...] = ()
    raw_statuses = raw.get("statuses")
    if isinstance(raw_statuses, list):
        statuses = tuple(
            sorted({code for code in raw_statuses if isinstance(code, int) and not isinstance(code, bool)})
        )
    return operation_key, statuses


def _parse_destinations(raw: Any) -> tuple[str, ...]:
    """Normalize the allowlist, dropping unusable entries and preserving stored order."""
    if not isinstance(raw, list):
        return ()
    destinations: list[str] = []
    for entry in raw:
        normalized = normalize_destination(entry)
        if normalized is not None and normalized not in destinations:
            destinations.append(normalized)
    return tuple(destinations)


def _parse_callback(name: str, raw: Any) -> CallbackDefinition | None:
    """Build one :class:`CallbackDefinition`; ``None`` when the entry is unusable."""
    if not isinstance(raw, dict):
        return None
    declared_format = raw.get("callbackFormat", CALLBACK_FORMAT)
    if declared_format != CALLBACK_FORMAT:
        return None
    declared_version = raw.get("callbackFormatVersion", CALLBACK_FORMAT_VERSION)
    if isinstance(declared_version, bool) or declared_version not in SUPPORTED_CALLBACK_FORMAT_VERSIONS:
        return None

    destinations = _parse_destinations(raw.get("destinations"))
    if not destinations:
        # No authorized target: the definition could never deliver, so it is not a definition.
        return None

    request = raw.get("request")
    request_block = request if isinstance(request, dict) else {}
    method = request_block.get("method")
    method = method.upper() if isinstance(method, str) and method.upper() in ALLOWED_METHODS else DEFAULT_METHOD
    headers = _parse_headers(request_block.get("headers"))
    has_body = "body" in request_block
    body = request_block.get("body")

    payload_schema = raw.get("payloadSchema")
    schema: Mapping[str, Any] | None = payload_schema if isinstance(payload_schema, dict) and payload_schema else None

    description = raw.get("description")
    operation_key, statuses = _parse_trigger(raw.get("trigger"))

    needs_request_body = (has_body and value_references_request_body(body)) or any(
        value_references_request_body(value) for _, value in headers
    )

    return CallbackDefinition(
        name=name,
        description=description if isinstance(description, str) else "",
        # Digest the *surviving* content in the shared canonical shape, so a fully valid stored
        # definition digests identically to what the authoring API reported on save.
        digest=callback_digest(raw),
        format_version=int(declared_version),
        operation_key=operation_key,
        trigger_statuses=statuses,
        destinations=destinations,
        method=method,
        headers=headers,
        body=body,
        has_body=has_body,
        payload_schema=schema,
        retry=_parse_retry(raw.get("retry")),
        needs_request_body=needs_request_body,
    )


def parse_callbacks(mock_settings: Any) -> dict[str, CallbackDefinition]:
    """Parse the ``callbacks`` key of raw mock settings into definitions by name.

    Accepts the raw settings value (dict, JSON text, or ``None``) and never raises; unusable
    definitions are skipped. Names must match the author-time name pattern — anything else could
    not have been saved through the API and is not trusted.

    Args:
        mock_settings: The raw ``versions.mock_settings`` value (or bundled settings document).

    Returns:
        The parsed definitions keyed by name (possibly empty).
    """
    settings: Any = mock_settings
    if isinstance(settings, str):
        try:
            settings = json.loads(settings)
        except json.JSONDecodeError:
            return {}
    if not isinstance(settings, dict):
        return {}
    raw_callbacks = settings.get("callbacks")
    if not isinstance(raw_callbacks, dict):
        return {}

    callbacks: dict[str, CallbackDefinition] = {}
    for name, raw in raw_callbacks.items():
        if not isinstance(name, str) or not CALLBACK_NAME_PATTERN.match(name):
            continue
        definition = _parse_callback(name, raw)
        if definition is not None:
            callbacks[definition.name] = definition
    return callbacks


def callback_summary(definition: CallbackDefinition) -> dict[str, Any]:
    """Describe one definition for the ``__mock__/callbacks`` listing endpoint.

    The summary carries identity, trigger, allowlist, and retry schedule but no payload template
    and no header values — so it is always small, never leaks a templated secret, and is safe to
    log.

    Args:
        definition: The parsed definition to describe.

    Returns:
        A JSON-serializable summary.
    """
    return {
        "name": definition.name,
        "description": definition.description,
        "digest": definition.digest,
        "callbackFormat": CALLBACK_FORMAT,
        "callbackFormatVersion": definition.format_version,
        "trigger": {
            "operation": definition.operation_key,
            "statuses": list(definition.trigger_statuses),
        },
        "destinations": list(definition.destinations),
        "method": definition.method,
        "headers": [name for name, _ in definition.headers],
        "hasPayloadSchema": definition.payload_schema is not None,
        "retry": {
            "maxAttempts": definition.retry.max_attempts,
            "delaysMs": list(definition.retry.delays_ms),
            "retryOn": sorted(definition.retry.retry_on),
            "timeoutMs": definition.retry.timeout_ms,
        },
    }
