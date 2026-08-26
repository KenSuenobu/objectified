"""Export test-drive mocks — the binding between an emitted artifact and the Mock Server engine.

MFX-44.5 (#4371). "Test the format" at its strongest is *hit a live mock of the exported API*.
The Mock Server epic (#3615, RC1-2.2) already owns the engine: it freezes an OpenAPI document into
``apiome.mock_instances.spec`` and replays schema-shaped responses from it on the public data plane
(``/v1/mock/{mock_id}/…``). What it could not do is start from an **emitted** artifact — its only
provisioning path requires a *published version*, and an export under review has neither.

This module is that binding, and deliberately **not a second mock engine**:

* :func:`mock_servable_targets` answers *which export targets can be mocked at all*, derived from
  the emitter registry (:func:`app.emitter.describe_emit_targets`) rather than from a hand-kept
  list, so a new OpenAPI-family emitter is mockable the day it registers;
* :func:`export_mock_availability` answers *can this server mock anything right now* — the honest
  capability signal the Studio hides (or disables) its Test-drive tab on when the mock
  infrastructure is not deployed;
* :func:`document_from_emit` turns an :class:`~app.emitter.EmitResult` into the frozen spec dict
  the engine replays from, refusing anything that is not a single serve-able OpenAPI document;
* :class:`ExportMockRequestLog` records what the data plane served, so the Studio's request-log
  panel can show the round-trip the user just made.

**Scope of the request log.** Like the rate limiter it sits beside (:mod:`app.rate_limit`), the log
lives in process memory: it is a bounded, per-replica ring buffer, not a durable audit trail. That
is the right lifetime for a mock that is itself measured in minutes, and it keeps a UI affordance
from adding a write to the hot data-plane path. A horizontally scaled deployment would show each
replica's own slice — the same documented limitation the rate limiter carries.
"""

from __future__ import annotations

import json
import threading
from collections import OrderedDict, deque
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Deque, Dict, List, Optional, Tuple

from pydantic import AliasChoices, BaseModel, ConfigDict, Field

from .config import settings
from .emitter import EmitResult, describe_emit_targets

__all__ = [
    "EXPORT_MOCK_ORIGIN",
    "ExportMockAvailability",
    "ExportMockCapabilityResponse",
    "ExportMockError",
    "ExportMockInstanceResponse",
    "ExportMockOperation",
    "ExportMockProvisionRequest",
    "ExportMockRequestEntryResponse",
    "ExportMockRequestLog",
    "ExportMockRequestLogResponse",
    "MOCK_SERVABLE_FORMAT_PREFIXES",
    "MockRequestEntry",
    "clamp_ttl_minutes",
    "document_from_emit",
    "export_mock_availability",
    "expiry_from_now",
    "instance_is_export_mock",
    "is_mock_servable_target",
    "mock_request_log",
    "mock_servable_targets",
    "operation_summaries",
]


#: Marker written into a test-drive instance's ``config`` JSONB. It is what separates an ephemeral
#: export mock from a hosted mock provisioned off a published version (#3615) — the two share the
#: table, the engine and the data plane, but only export mocks are counted against the test-drive
#: concurrency cap and only they are reachable through the ``/v1/export/…/mock`` surface.
EXPORT_MOCK_ORIGIN = "export-test-drive"

#: Registry ``format`` prefixes whose emitted document the mock engine can serve. The engine reads
#: ``paths`` → operations → response schemas, so it serves the OpenAPI family (and its Swagger 2.0
#: ancestor) and nothing else. Kept as *prefixes* so ``openapi-3.0`` / ``openapi-3.1`` /
#: ``openapi-3.2`` all qualify without enumerating dialects, and kept **here** rather than in the
#: UI so the Studio stays capability-driven (it asks; it never decides).
MOCK_SERVABLE_FORMAT_PREFIXES: Tuple[str, ...] = ("openapi", "swagger")


class ExportMockError(Exception):
    """Raised when a test-drive mock cannot be provisioned from an emitted artifact.

    Carries an HTTP ``status_code`` so the route surfaces the right refusal without a stack trace:
    ``400`` for a target the engine cannot serve, ``409`` for the per-tenant cap, ``413`` for an
    over-large document, ``422`` for an emit that produced nothing serve-able, and ``503`` when the
    mock infrastructure is not available on this server.
    """

    def __init__(self, message: str, *, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


# ---------------------------------------------------------------------------
# Which targets can be mocked, and can this server mock at all
# ---------------------------------------------------------------------------


def mock_servable_targets() -> List[str]:
    """Return the export target keys whose emitted document the mock engine can serve.

    Derived from the emitter registry rather than a hand-kept list: every registered emitter whose
    registry ``format`` starts with one of :data:`MOCK_SERVABLE_FORMAT_PREFIXES` qualifies, so a new
    OpenAPI-family emitter becomes mockable the day it registers and needs no change here (nor,
    since the Studio reads this list from the capability endpoint, in the UI).

    Returns:
        The target emitter keys (e.g. ``["openapi"]``), sorted and de-duplicated.
    """
    keys = {
        entry.descriptor.key
        for entry in describe_emit_targets()
        if entry.descriptor.format.lower().startswith(MOCK_SERVABLE_FORMAT_PREFIXES)
    }
    return sorted(keys)


def is_mock_servable_target(target_format: str) -> bool:
    """Is ``target_format`` a registry format the mock engine can serve?

    Args:
        target_format: A resolved registry format key (e.g. ``openapi-3.1``).

    Returns:
        ``True`` when the format is in the OpenAPI family the engine replays from.
    """
    return (target_format or "").lower().startswith(MOCK_SERVABLE_FORMAT_PREFIXES)


@dataclass(frozen=True)
class ExportMockAvailability:
    """Whether this server can start test-drive mocks, and the bounds it will apply.

    The Studio renders its Test-drive tab from this: :attr:`available` decides whether the tab
    appears at all, :attr:`reason` is the sentence shown when it is disabled rather than hidden,
    and the bounds let the panel state the TTL and the cap *before* the user clicks Start.
    """

    available: bool
    reason: Optional[str]
    supported_targets: List[str]
    default_ttl_minutes: int
    max_ttl_minutes: int
    max_per_tenant: int
    rate_limit_per_minute: int


def export_mock_availability() -> ExportMockAvailability:
    """Describe this server's test-drive mock capability.

    Two switches gate it, and the reason names which one is down so an operator reading the UI can
    act on it: the Mock Server engine itself (``mock_server_enabled`` — no engine, nothing to bind
    to) and the export test-drive binding (``export_mock_enabled``).

    Returns:
        The capability descriptor, always fully populated — an unavailable server still reports the
        bounds it *would* apply, so the disabled panel can explain itself.
    """
    reason: Optional[str] = None
    if not settings.mock_server_enabled:
        reason = "The Mock Server is not enabled on this server, so an export cannot be mocked."
    elif not settings.export_mock_enabled:
        reason = "Export test-drive mocks are disabled on this server."

    return ExportMockAvailability(
        available=reason is None,
        reason=reason,
        supported_targets=mock_servable_targets(),
        default_ttl_minutes=max(1, settings.export_mock_default_ttl_minutes),
        max_ttl_minutes=max(1, settings.export_mock_max_ttl_minutes),
        max_per_tenant=max(1, settings.export_mock_max_per_tenant),
        rate_limit_per_minute=max(1, settings.mock_rate_limit_per_minute),
    )


def clamp_ttl_minutes(requested: Optional[int]) -> int:
    """Clamp a requested test-drive TTL into the configured band.

    Args:
        requested: The caller's TTL in minutes, or ``None`` to take the configured default.

    Returns:
        A TTL of at least one minute and at most ``export_mock_max_ttl_minutes``.
    """
    availability = export_mock_availability()
    minutes = requested if requested is not None else availability.default_ttl_minutes
    return max(1, min(int(minutes), availability.max_ttl_minutes))


def expiry_from_now(ttl_minutes: int, *, now: Optional[datetime] = None) -> datetime:
    """Compute the auto-teardown timestamp for a test-drive mock.

    Args:
        ttl_minutes: The clamped TTL (see :func:`clamp_ttl_minutes`).
        now: Reference time; defaults to the current UTC time (injectable for tests).

    Returns:
        The UTC instant the data plane starts answering ``410 Gone`` at.
    """
    reference = now or datetime.now(timezone.utc)
    return reference + timedelta(minutes=ttl_minutes)


# ---------------------------------------------------------------------------
# The emitted artifact → frozen spec
# ---------------------------------------------------------------------------


def document_from_emit(emit: Optional[EmitResult], *, target_label: str) -> Dict[str, Any]:
    """Extract the serve-able OpenAPI document from an emit result.

    The mock engine replays from a single structured document, so a multi-file bundle or a
    text-only emit cannot be mocked — this refuses both explicitly rather than mocking the first
    file and pretending the rest exists.

    Args:
        emit: The emitter's output bundle, or ``None`` when the emit produced nothing.
        target_label: Human label of the target, used in the refusal message.

    Returns:
        The emitted document as a plain dict, ready to freeze into ``mock_instances.spec``.

    Raises:
        ExportMockError: ``422`` when the emit produced no document, produced a non-structured
            one, or produced a bundle rather than a single document; ``413`` when the document
            exceeds ``export_mock_max_document_bytes``.
    """
    if emit is None or not emit.files:
        raise ExportMockError(
            f"{target_label} produced no document to mock.", status_code=422
        )
    if len(emit.files) > 1:
        raise ExportMockError(
            f"{target_label} emits a {len(emit.files)}-file bundle; a mock needs one document.",
            status_code=422,
        )

    document = emit.files[0].content
    if not isinstance(document, dict):
        raise ExportMockError(
            f"{target_label} emits text, not a structured document a mock can replay.",
            status_code=422,
        )
    if not isinstance(document.get("paths"), dict) or not document["paths"]:
        raise ExportMockError(
            "The emitted document declares no paths, so a mock of it would serve nothing.",
            status_code=422,
        )

    # Guard the frozen-spec column (and the engine's per-request walk) against an artifact far
    # larger than a test drive warrants. Measured on the serialized form, which is what is stored —
    # and serializing it here is also what proves the row can be written at all.
    try:
        size = len(json.dumps(document, separators=(",", ":")).encode("utf-8"))
    except (TypeError, ValueError) as exc:
        raise ExportMockError(
            f"{target_label} produced a document that cannot be stored as JSON: {exc}",
            status_code=422,
        ) from exc
    limit = settings.export_mock_max_document_bytes
    if size > limit:
        raise ExportMockError(
            f"The emitted document is {size:,} bytes; test-drive mocks are capped at {limit:,}.",
            status_code=413,
        )
    return document


def operation_summaries(operations: List[Any]) -> List[Dict[str, Optional[str]]]:
    """Project the engine's extracted operations into the shape the try-it panel offers.

    Args:
        operations: :class:`~app.mock_engine.MockOperation` values from
            :func:`app.mock_engine.extract_operations`.

    Returns:
        One ``{"method", "path", "operationId"}`` entry per operation, ordered by path then method
        so the panel's list is stable across refreshes.
    """
    summaries: List[Dict[str, Optional[str]]] = [
        {
            "method": op.method.upper(),
            "path": op.path_template,
            "operation_id": str(op.operation.get("operationId") or "") or None,
        }
        for op in operations
    ]
    return sorted(summaries, key=lambda entry: (entry["path"] or "", entry["method"] or ""))


# ---------------------------------------------------------------------------
# Instance classification
# ---------------------------------------------------------------------------


def instance_is_export_mock(instance: Dict[str, Any]) -> bool:
    """Was this ``mock_instances`` row provisioned by the export test drive?

    Args:
        instance: A mock-instance row (or any mapping with a ``config``).

    Returns:
        ``True`` when the row carries the :data:`EXPORT_MOCK_ORIGIN` marker.
    """
    config = instance.get("config") or {}
    return isinstance(config, dict) and config.get("origin") == EXPORT_MOCK_ORIGIN


# ---------------------------------------------------------------------------
# The request log
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class MockRequestEntry:
    """One data-plane request the mock served."""

    at: datetime
    method: str
    path: str
    status: int
    matched: bool
    scenario: str
    operation_key: Optional[str]
    schema_valid: Optional[bool]
    duration_ms: int


class ExportMockRequestLog:
    """A bounded, in-memory ring buffer of served data-plane requests, keyed by mock instance.

    Two bounds keep it honest as a UI affordance rather than a memory leak: at most
    ``export_mock_request_log_size`` entries per instance, and at most :data:`MAX_TRACKED_INSTANCES`
    instances (the least recently written is evicted first). Both reads and writes are guarded by a
    lock, because the data plane serves concurrently.

    Like :class:`app.rate_limit.FixedWindowRateLimiter`, the store is **per replica** — a scaled-out
    deployment shows each replica its own slice. That is acceptable for a log attached to a mock
    that expires in minutes, and it keeps a write off the hot response path.
    """

    #: Ceiling on distinct instances tracked at once; oldest-written is evicted beyond it.
    MAX_TRACKED_INSTANCES = 200

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._entries: "OrderedDict[str, Deque[MockRequestEntry]]" = OrderedDict()

    def record(
        self,
        mock_id: str,
        *,
        method: str,
        path: str,
        status: int,
        matched: bool,
        scenario: str,
        operation_key: Optional[str],
        schema_valid: Optional[bool],
        duration_ms: int,
        at: Optional[datetime] = None,
    ) -> None:
        """Record one served request.

        Args:
            mock_id: The instance that served it.
            method: Request HTTP method.
            path: Request path *relative to the mock base URL*.
            status: The status the mock answered with.
            matched: Whether an operation in the frozen spec matched.
            scenario: The scenario in force for the request.
            operation_key: The matched operation key (``"GET /pets/{petId}"``), or ``None``.
            schema_valid: Whether the body agreed with the response schema; ``None`` when no
                operation matched, so there was no schema to check against.
            duration_ms: Wall time the mock spent, in milliseconds.
            at: Timestamp; defaults to now (injectable for tests).
        """
        entry = MockRequestEntry(
            at=at or datetime.now(timezone.utc),
            method=method.upper(),
            path=path,
            status=status,
            matched=matched,
            scenario=scenario,
            operation_key=operation_key,
            schema_valid=schema_valid,
            duration_ms=max(0, int(duration_ms)),
        )
        capacity = max(1, settings.export_mock_request_log_size)
        with self._lock:
            bucket = self._entries.get(mock_id)
            if bucket is None or bucket.maxlen != capacity:
                # New instance, or the configured capacity changed under us — rebuild the deque
                # preserving whatever the old one still holds (newest entries win on shrink).
                previous = list(bucket)[-capacity:] if bucket else []
                bucket = deque(previous, maxlen=capacity)
                self._entries[mock_id] = bucket
            bucket.append(entry)
            self._entries.move_to_end(mock_id)
            while len(self._entries) > self.MAX_TRACKED_INSTANCES:
                self._entries.popitem(last=False)

    def entries(self, mock_id: str, *, limit: Optional[int] = None) -> List[MockRequestEntry]:
        """Return an instance's requests, newest first.

        Args:
            mock_id: The instance to read.
            limit: Cap on entries returned; ``None`` returns everything retained.

        Returns:
            The retained entries in newest-first order (empty for an unknown instance).
        """
        with self._lock:
            bucket = self._entries.get(mock_id)
            recorded = list(bucket) if bucket else []
        recorded.reverse()
        return recorded[:limit] if limit is not None else recorded

    def forget(self, mock_id: str) -> None:
        """Drop an instance's log — called when the instance is torn down.

        Args:
            mock_id: The instance whose entries to discard.
        """
        with self._lock:
            self._entries.pop(mock_id, None)

    def clear(self) -> None:
        """Empty the whole store (tests)."""
        with self._lock:
            self._entries.clear()


#: The process-wide request log the data plane writes to and the export surface reads.
mock_request_log = ExportMockRequestLog()


# ---------------------------------------------------------------------------
# The REST contract
# ---------------------------------------------------------------------------


class ExportMockCapabilityResponse(BaseModel):
    """Whether this server can start test-drive mocks, and the bounds it applies (MFX-44.5).

    The Studio calls this **before** it renders anything mock-shaped: an unavailable server means
    no Test-drive tab (or a disabled one carrying :attr:`reason`), and ``supported_targets`` keeps
    the decision of *which* targets can be mocked on the server, where the emitter registry lives.
    """

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    available: bool = Field(description="Whether a mock can be provisioned on this server now.")
    reason: Optional[str] = Field(
        default=None,
        description="Why mocking is unavailable, or ``null`` when it is available.",
    )
    supported_targets: List[str] = Field(
        serialization_alias="supportedTargets",
        description="Target emitter keys whose emitted document the mock engine can serve.",
    )
    default_ttl_minutes: int = Field(
        serialization_alias="defaultTtlMinutes",
        description="TTL applied when a provision request names none.",
    )
    max_ttl_minutes: int = Field(
        serialization_alias="maxTtlMinutes",
        description="Ceiling a requested TTL is clamped to.",
    )
    max_per_tenant: int = Field(
        serialization_alias="maxPerTenant",
        description="Concurrent live test-drive mocks one tenant may hold.",
    )
    rate_limit_per_minute: int = Field(
        serialization_alias="rateLimitPerMinute",
        description="Per-instance request budget the data plane enforces.",
    )


class ExportMockProvisionRequest(BaseModel):
    """Start a test-drive mock for one (source, target, options) export configuration.

    The same coordinates ``/verify``, ``/document`` and ``/roundtrip`` take, so the mock serves
    *exactly* the artifact the Studio is showing: the emit is re-run server-side from the source
    revision rather than trusting a document posted by the browser.
    """

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    artifact: str = Field(description="The artifact (project) id to mock an export of.")
    version: Optional[str] = Field(
        default=None,
        description="Revision UUID, version label (``1.0.0``), or null for the latest revision.",
    )
    target: str = Field(
        description="Target emitter key (``openapi``) or format key (``openapi-3.1``).",
    )
    options: Optional[Dict[str, Any]] = Field(
        default=None,
        description="Per-target emit options (MFX-1.4); null or empty applies the target defaults.",
    )
    ttl_minutes: Optional[int] = Field(
        default=None,
        ge=1,
        validation_alias=AliasChoices("ttlMinutes", "ttl_minutes"),
        description="Auto-teardown TTL in minutes; clamped to the configured maximum.",
    )
    seed: Optional[int] = Field(
        default=None,
        description="Deterministic response-generation seed; defaults to 0 (stable bodies).",
    )


class ExportMockOperation(BaseModel):
    """One operation the mock will answer — what the try-it control offers."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    method: str = Field(description="Upper-case HTTP method.")
    path: str = Field(description="Templated path relative to the mock base URL.")
    operation_id: Optional[str] = Field(
        default=None,
        serialization_alias="operationId",
        description="The document's ``operationId`` for this operation, when it declares one.",
    )


class ExportMockInstanceResponse(BaseModel):
    """A live test-drive mock: where to reach it, what it serves, and when it disappears."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    id: str = Field(description="The mock instance id.")
    base_url: str = Field(
        serialization_alias="baseUrl",
        description="Stable base URL of the mock's data plane; append an operation path to it.",
    )
    status: str = Field(description="``active`` while it serves, ``expired`` once past its TTL.")
    target: str = Field(description="The resolved target format key the mock was emitted from.")
    target_key: str = Field(
        serialization_alias="targetKey",
        description="The emitter *key* the mock was started for (``openapi``) — what the Studio "
        "holds, so it can recognise a mock of the configuration it is showing.",
    )
    target_label: str = Field(
        serialization_alias="targetLabel",
        description="Human label of that target (e.g. ``OpenAPI 3.1``).",
    )
    artifact: str = Field(description="The artifact (project) id the mock was provisioned from.")
    version: Optional[str] = Field(
        default=None, description="The resolved revision's version label, when it has one."
    )
    operation_count: int = Field(
        serialization_alias="operationCount",
        description="How many operations the frozen document exposes.",
    )
    operations: List[ExportMockOperation] = Field(
        default_factory=list,
        description="The operations themselves, ordered by path then method.",
    )
    scenarios: List[str] = Field(
        default_factory=list,
        description="Selectable scenario names; send one as ``X-Mock-Scenario`` per request.",
    )
    active_scenario: str = Field(
        serialization_alias="activeScenario",
        description="The scenario in force when a request names none.",
    )
    rate_limit_per_minute: int = Field(
        serialization_alias="rateLimitPerMinute",
        description="Per-instance request budget the data plane enforces.",
    )
    request_count: int = Field(
        serialization_alias="requestCount",
        description="Lifetime data-plane requests served (best-effort).",
    )
    created_at: Optional[str] = Field(
        default=None, serialization_alias="createdAt", description="ISO-8601 provision time."
    )
    expires_at: Optional[str] = Field(
        default=None, serialization_alias="expiresAt", description="ISO-8601 auto-teardown time."
    )
    expires_in_seconds: int = Field(
        serialization_alias="expiresInSeconds",
        description="Seconds until auto-teardown, computed server-side so the countdown is "
        "immune to browser clock skew; ``0`` once expired.",
    )
    last_activity_at: Optional[str] = Field(
        default=None,
        serialization_alias="lastActivityAt",
        description="ISO-8601 time of the last served request, or null if none yet.",
    )


class ExportMockRequestEntryResponse(BaseModel):
    """One request the mock served, as the Studio's request-log panel renders it."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    at: str = Field(description="ISO-8601 time the request was served.")
    method: str = Field(description="Request HTTP method.")
    path: str = Field(description="Request path relative to the mock base URL.")
    status: int = Field(description="Status the mock answered with.")
    matched: bool = Field(description="Whether an operation in the frozen document matched.")
    scenario: str = Field(description="The scenario in force for this request.")
    operation_id: Optional[str] = Field(
        default=None,
        serialization_alias="operationId",
        description="The matched operation key (``GET /pets/{petId}``), or null when unmatched.",
    )
    schema_valid: Optional[bool] = Field(
        default=None,
        serialization_alias="schemaValid",
        description="Whether the body agreed with the response schema; null when no operation "
        "matched, so there was no schema to check against.",
    )
    duration_ms: int = Field(
        serialization_alias="durationMs",
        description="Wall time the mock spent on the request, in milliseconds.",
    )


class ExportMockRequestLogResponse(BaseModel):
    """The retained request log for one mock instance, newest first."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    mock_id: str = Field(serialization_alias="mockId", description="The instance the log is for.")
    entries: List[ExportMockRequestEntryResponse] = Field(
        default_factory=list, description="Retained requests, newest first."
    )
    retained: int = Field(description="How many requests the log currently holds.")
    capacity: int = Field(
        description="How many the ring buffer retains per instance before discarding the oldest.",
    )
    truncated: bool = Field(
        description="True when the instance has served more requests than the log retains.",
    )
