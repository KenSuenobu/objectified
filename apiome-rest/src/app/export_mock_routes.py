"""Export test-drive mock REST surface — MFX-44.5 (#4371).

The Export Studio's strongest "test the format" affordance: turn the artifact under review into a
**live** API for a few minutes and send it real requests. The endpoints here are deliberately thin —
they are the *binding* between the export pipeline and the mock engine, not a second mock engine —
which since #5532 (MSC-2.2) is a statement about the whole tree, not just this module:

* ``GET    /v1/export/{tenant_slug}/mock/capability``          → can this server mock, and within what bounds
* ``POST   /v1/export/{tenant_slug}/mock``                     → 201, provision a mock from an emitted artifact
* ``GET    /v1/export/{tenant_slug}/mock``                     → the tenant's live test-drive mocks
* ``GET    /v1/export/{tenant_slug}/mock/{mock_id}``           → one instance (fresh countdown + request count)
* ``GET    /v1/export/{tenant_slug}/mock/{mock_id}/requests``  → the retained request log
* ``DELETE /v1/export/{tenant_slug}/mock/{mock_id}``           → 204, tear it down early

What a provision actually does: load the source revision the same way ``/verify`` and ``/document``
do, re-run the emitter for the requested (target, options), and freeze the resulting document into
an ``apiome.mock_instances`` row with a **minutes-scale** TTL and the
:data:`~app.export_mock.EXPORT_MOCK_ORIGIN` marker. From there the existing public data plane
(``/v1/mock/{mock_id}/…``) serves it unchanged — same rate limit, same ``410 Gone`` at expiry, and
since #5532 the same *engine* as every other mock, so a test drive now gets templates, predicates,
stateful CRUD, fixtures and chaos it never had.

The emit is re-run **server-side** rather than accepting a document from the browser: the mock then
provably serves what the source revision emits, and a caller cannot mint a mock of arbitrary bytes.

Every route is tenant-scoped (JWT or API key) via :func:`app.auth.validate_authentication`, and an
instance is only reachable through this surface when it is *this* tenant's *and* was provisioned by
the test drive — a hosted mock (#3615) is managed on ``/v1/mocks/…``, not here.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response

from .auth import get_authenticated_user_id, validate_authentication
from .config import settings
from .database import db
from .emitter import describe_emit_targets
from .export_mock import (
    EXPORT_MOCK_ORIGIN,
    ExportMockCapabilityResponse,
    ExportMockError,
    ExportMockInstanceResponse,
    ExportMockOperation,
    ExportMockProvisionRequest,
    ExportMockRequestEntryResponse,
    ExportMockRequestLogResponse,
    clamp_ttl_minutes,
    document_from_emit,
    expiry_from_now,
    export_mock_availability,
    instance_is_export_mock,
    is_mock_servable_target,
    mock_request_log,
    operation_summaries,
)
from .export_service import ExportError, emit_canonical, resolve_emit_format
from .export_source import ExportSourceError, load_export_source
from .mock_routes import (
    instance_active_scenario,
    instance_scenario_names,
    instance_settings,
    mock_instance_is_expired,
)
from .mock_routing import extract_operations

_logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/export", tags=["export-mock"])

#: Placeholder written into the row's ``project_slug`` / ``version_slug`` columns (both ``NOT NULL``)
#: when the source revision carries no version label. A test-drive mock is not addressed by slug —
#: its URL is ``/v1/mock/{id}`` — so these are display coordinates only.
_UNLABELLED_VERSION = "emitted"


def _require_available() -> None:
    """Refuse every route when this server cannot start test-drive mocks.

    Raises:
        HTTPException: ``503`` with the capability's own reason, so an operator reading the refusal
            learns which switch is off rather than that "something" failed.
    """
    availability = export_mock_availability()
    if not availability.available:
        raise HTTPException(status_code=503, detail=availability.reason)


def _descriptor_for(target_format: str) -> Optional[Any]:
    """The registered emitter descriptor for a resolved target format.

    Args:
        target_format: A resolved registry format key (e.g. ``openapi-3.1``).

    Returns:
        The descriptor, or ``None`` when no registered emitter produces that format.
    """
    for entry in describe_emit_targets():
        if entry.descriptor.format == target_format:
            return entry.descriptor
    return None


def _target_label(target_format: str) -> str:
    """Human label for a resolved target format, falling back to the format key itself.

    Args:
        target_format: A resolved registry format key (e.g. ``openapi-3.1``).

    Returns:
        The emitter descriptor's label, or ``target_format`` when no descriptor matches.
    """
    descriptor = _descriptor_for(target_format)
    return descriptor.label if descriptor else target_format


def _target_key(target_format: str) -> str:
    """The emitter *key* for a resolved target format (``openapi-3.1`` → ``openapi``).

    The Studio holds the key, not the format, so echoing it back is what lets the panel recognise
    a still-running mock of the configuration it is currently showing.

    Args:
        target_format: A resolved registry format key.

    Returns:
        The emitter descriptor's key, or ``target_format`` when no descriptor matches.
    """
    descriptor = _descriptor_for(target_format)
    return descriptor.key if descriptor else target_format


def _seconds_until(expires_at: Any, *, now: Optional[datetime] = None) -> int:
    """Seconds remaining before an instance auto-tears-down, floored at zero.

    Computed server-side so the Studio's countdown does not depend on the browser clock.

    Args:
        expires_at: The row's ``expires_at`` (a datetime, or anything else for "no expiry").
        now: Reference time; defaults to the current UTC time.

    Returns:
        Whole seconds remaining; ``0`` once expired or when the row has no expiry.
    """
    if not isinstance(expires_at, datetime):
        return 0
    deadline = expires_at if expires_at.tzinfo else expires_at.replace(tzinfo=timezone.utc)
    remaining = (deadline - (now or datetime.now(timezone.utc))).total_seconds()
    return max(0, int(remaining))


def _iso(value: Any) -> Optional[str]:
    """Render a datetime as an ISO-8601 string; pass through ``None``.

    Args:
        value: A datetime, ``None``, or any other value (stringified).

    Returns:
        The ISO-8601 rendering, or ``None``.
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def _instance_response(instance: Dict[str, Any], request: Request) -> ExportMockInstanceResponse:
    """Project a stored row into the test-drive response the Studio renders.

    The base URL is the same stable ``/v1/mock/{id}`` the hosted management plane reports, so a
    URL copied out of the Studio is the URL ``curl`` and Swagger UI hit.

    Args:
        instance: The ``mock_instances`` row.
        request: The inbound request, for deriving the public base URL.

    Returns:
        The populated instance response, including the operations the try-it control offers.
    """
    spec = instance.get("spec") or {}
    config = instance.get("config") or {}
    settings_map = instance_settings(instance)
    operations = extract_operations(spec)
    base = str(request.base_url).rstrip("/")
    expired = mock_instance_is_expired(instance)
    target_format = str(config.get("target") or "")
    return ExportMockInstanceResponse(
        id=str(instance["id"]),
        base_url=f"{base}/v1/mock/{instance['id']}",
        status="expired" if expired else str(instance.get("status") or "active"),
        target=target_format,
        target_key=str(config.get("target_key") or _target_key(target_format)),
        target_label=str(config.get("target_label") or _target_label(target_format)),
        artifact=str(config.get("artifact") or instance.get("project_slug") or ""),
        version=config.get("version_label"),
        operation_count=len(operations),
        operations=[ExportMockOperation(**summary) for summary in operation_summaries(operations)],
        scenarios=instance_scenario_names(settings_map),
        active_scenario=instance_active_scenario(settings_map),
        rate_limit_per_minute=int(instance["rate_limit_per_minute"]),
        request_count=int(instance.get("request_count") or 0),
        created_at=_iso(instance.get("created_at")),
        expires_at=_iso(instance.get("expires_at")),
        expires_in_seconds=0 if expired else _seconds_until(instance.get("expires_at")),
        last_activity_at=_iso(instance.get("last_activity_at")),
    )


def _partition_export_mocks(tenant_id: str) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Split the tenant's test-drive mock rows into the live ones and the lapsed ones.

    Args:
        tenant_id: The owning tenant.

    Returns:
        ``(live, expired)``, newest first within each. Rows without the test-drive origin marker —
        hosted mocks provisioned from a published version (#3615) — appear in neither: they share
        the table but not this surface's budget or its lifecycle.
    """
    live: List[Dict[str, Any]] = []
    expired: List[Dict[str, Any]] = []
    for row in db.list_mock_instances(tenant_id):
        if not instance_is_export_mock(row):
            continue
        (expired if mock_instance_is_expired(row) else live).append(row)
    return live, expired


def _live_export_mocks(tenant_id: str) -> List[Dict[str, Any]]:
    """The tenant's test-drive mock rows that have not expired, newest first.

    Args:
        tenant_id: The owning tenant.

    Returns:
        The set the per-tenant concurrency cap is measured against.
    """
    return _partition_export_mocks(tenant_id)[0]


def _reap_expired(tenant_id: str, expired: List[Dict[str, Any]]) -> None:
    """Delete this tenant's lapsed test-drive mocks and forget their request logs.

    A test drive lives for minutes, so its rows would otherwise pile up far faster than a hosted
    mock's. The reaping is deliberately narrow — it runs on the provision path, where the caller
    has already read the list, and only ever touches rows this tenant owns that carry the
    test-drive marker and are past their TTL. Hosted mocks keep their own lifecycle.

    Failures are swallowed: tidying up must never turn into a refusal to start a new mock.

    Args:
        tenant_id: The owning tenant.
        expired: The lapsed rows, as returned by :func:`_partition_export_mocks`.
    """
    for row in expired:
        mock_id = str(row["id"])
        try:
            db.delete_mock_instance(mock_id, tenant_id)
        except Exception:  # pragma: no cover - cleanup must never break provisioning
            _logger.warning("Could not reap expired test-drive mock %s", mock_id)
            continue
        mock_request_log.forget(mock_id)


def _owned_export_mock(mock_id: str, tenant_id: str) -> Dict[str, Any]:
    """Fetch one test-drive mock owned by the tenant.

    Args:
        mock_id: The instance id.
        tenant_id: The owning tenant.

    Returns:
        The row.

    Raises:
        HTTPException: ``404`` when the id is unknown, belongs to another tenant, or names a
            hosted mock — which is managed on ``/v1/mocks/…``, not through the export surface.
    """
    instance = db.get_mock_instance_for_tenant(mock_id, tenant_id)
    if not instance or not instance_is_export_mock(instance):
        raise HTTPException(status_code=404, detail=f"Test-drive mock not found: {mock_id}")
    return instance


# ---------------------------------------------------------------------------
# Capability
# ---------------------------------------------------------------------------


@router.get(
    "/{tenant_slug}/mock/capability",
    response_model=ExportMockCapabilityResponse,
    summary="Can this server start a mock of an emitted artifact?",
    description=(
        "The capability signal the Export Studio renders its Test-drive tab from (MFX-44.1's "
        "flag, answered for the mock tool). Reports whether the Mock Server engine is deployed "
        "and the export binding enabled, which target keys the engine can serve, and the TTL / "
        "concurrency / rate bounds a provision will apply — so a disabled panel can say why and "
        "an enabled one can state the terms before the user clicks Start."
    ),
)
async def get_export_mock_capability(
    tenant_slug: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> ExportMockCapabilityResponse:
    """Report this server's export test-drive mock capability.

    Args:
        tenant_slug: The tenant slug (scopes the request; the capability itself is server-wide).
        auth_data: Authenticated tenant context (JWT or API key).

    Returns:
        The capability descriptor. Never raises for an unavailable server — the whole point is to
        answer "no, because …" honestly rather than fail.
    """
    availability = export_mock_availability()
    return ExportMockCapabilityResponse(
        available=availability.available,
        reason=availability.reason,
        supported_targets=availability.supported_targets,
        default_ttl_minutes=availability.default_ttl_minutes,
        max_ttl_minutes=availability.max_ttl_minutes,
        max_per_tenant=availability.max_per_tenant,
        rate_limit_per_minute=availability.rate_limit_per_minute,
    )


# ---------------------------------------------------------------------------
# Provision / inspect / tear down
# ---------------------------------------------------------------------------


@router.post(
    "/{tenant_slug}/mock",
    response_model=ExportMockInstanceResponse,
    status_code=201,
    summary="Start an ephemeral mock of an emitted export artifact",
    description=(
        "Emit the source revision to the requested target, freeze the resulting OpenAPI document "
        "into a short-lived, tenant-scoped mock instance, and return its live base URL. The "
        "instance is served by the existing Mock Server data plane (``/v1/mock/{mock_id}/…``) and "
        "auto-tears-down at its TTL — after which the same URL answers ``410 Gone``. Only targets "
        "the engine can serve (the capability endpoint's ``supportedTargets``) are accepted."
    ),
)
async def provision_export_mock(
    tenant_slug: str,
    request: Request,
    payload: ExportMockProvisionRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> ExportMockInstanceResponse:
    """Provision a test-drive mock from an emitted artifact.

    Args:
        tenant_slug: The tenant slug (scopes the artifact lookup and the instance).
        request: The inbound request, for deriving the mock's public base URL.
        payload: Source coordinates + target + emit options + optional TTL and seed.
        auth_data: Authenticated tenant context (JWT or API key).

    Returns:
        The provisioned instance: base URL, operations, scenarios, and its expiry countdown.

    Raises:
        HTTPException: ``503`` when mocking is unavailable here; ``404``/``422`` when the source
            revision cannot be loaded; ``400`` when the target is unknown or is a format the mock
            engine cannot serve; ``409`` when the tenant already holds the maximum number of live
            test-drive mocks; ``413`` when the emitted document exceeds the size ceiling; ``422``
            when the emit produced nothing a mock can replay.
    """
    _require_available()
    tenant_id = str(auth_data["tenant_id"])

    try:
        target_format = resolve_emit_format(payload.target)
    except ExportError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

    label = _target_label(target_format)
    if not is_mock_servable_target(target_format):
        raise HTTPException(
            status_code=400,
            detail=(
                f"{label} is not a format the mock engine can serve. "
                f"Mockable targets: {', '.join(export_mock_availability().supported_targets)}."
            ),
        )

    # The cap is measured against *live* test-drive mocks only, so an expired instance never blocks
    # a new one; the lapsed rows are reaped here rather than left to accumulate. The read-then-count
    # is deliberately not transactional — the cap is a courtesy guardrail against a runaway loop,
    # not a licence boundary, and two concurrent starts racing to the same slot is harmless.
    cap = export_mock_availability().max_per_tenant
    live, expired = _partition_export_mocks(tenant_id)
    _reap_expired(tenant_id, expired)
    if len(live) >= cap:
        raise HTTPException(
            status_code=409,
            detail=(
                f"This workspace already has {len(live)} live test-drive mocks (the limit is "
                f"{cap}). Stop one before starting another."
            ),
        )

    try:
        source = load_export_source(tenant_id, payload.artifact, payload.version)
    except ExportSourceError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

    # Re-emit rather than trusting a client-supplied document: the mock then provably serves what
    # this revision emits for these options. The emit is read-only (no persistence context).
    try:
        emit = emit_canonical(source.api, target_format, opts=payload.options)
    except ExportError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

    try:
        document = document_from_emit(emit, target_label=label)
    except ExportMockError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

    ttl_minutes = clamp_ttl_minutes(payload.ttl_minutes)
    version_label = source.version_label or None
    config: Dict[str, Any] = {
        "origin": EXPORT_MOCK_ORIGIN,
        "target": target_format,
        "target_key": _target_key(target_format),
        "target_label": label,
        "artifact": source.artifact_id,
        "version_label": version_label,
        "version_record_id": source.version_record_id,
        "ttl_minutes": ttl_minutes,
        # A test drive starts on the built-in scenarios alone, which the engine supplies to every
        # mock (#5532, MSC-2.2); there is nothing instance-specific to store.
        "scenarios": [],
        "active_scenario": "happy-path",
        "seed": int(payload.seed or 0),
    }

    instance = db.create_mock_instance(
        tenant_id=tenant_id,
        # A test drive is not bound to a published version, so the row carries no ``version_id``;
        # the column is nullable precisely for rows whose originating version is not available.
        version_id=None,
        tenant_slug=tenant_slug,
        project_slug=source.artifact_id,
        version_slug=version_label or _UNLABELLED_VERSION,
        name=f"{label} test drive",
        spec=document,
        config=config,
        rate_limit_per_minute=max(1, settings.mock_rate_limit_per_minute),
        created_by=get_authenticated_user_id(auth_data),
        expires_at=expiry_from_now(ttl_minutes),
        settings={},
        migration_notes=[],
    )
    return _instance_response(instance, request)


@router.get(
    "/{tenant_slug}/mock",
    response_model=List[ExportMockInstanceResponse],
    summary="List the tenant's live test-drive mocks",
    description=(
        "The live test-drive mocks this workspace holds, newest first — what the per-tenant "
        "concurrency cap is measured against. Expired instances are omitted; hosted mocks "
        "provisioned from a published version (#3615) are managed on ``/v1/mocks/…`` and never "
        "appear here."
    ),
)
async def list_export_mocks(
    tenant_slug: str,
    request: Request,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> List[ExportMockInstanceResponse]:
    """List the tenant's live test-drive mocks.

    Args:
        tenant_slug: The tenant slug (scopes the listing).
        request: The inbound request, for deriving each mock's public base URL.
        auth_data: Authenticated tenant context (JWT or API key).

    Returns:
        One entry per live test-drive instance, newest first.

    Raises:
        HTTPException: ``503`` when mocking is unavailable on this server.
    """
    _require_available()
    tenant_id = str(auth_data["tenant_id"])
    return [_instance_response(row, request) for row in _live_export_mocks(tenant_id)]


@router.get(
    "/{tenant_slug}/mock/{mock_id}",
    response_model=ExportMockInstanceResponse,
    summary="Inspect one test-drive mock",
    description=(
        "One instance with a freshly computed expiry countdown and request count — what the "
        "Studio polls while a mock is live, and how it learns the mock has expired."
    ),
)
async def get_export_mock(
    tenant_slug: str,
    mock_id: str,
    request: Request,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> ExportMockInstanceResponse:
    """Inspect one test-drive mock owned by the tenant.

    Args:
        tenant_slug: The tenant slug (scopes the lookup).
        mock_id: The instance id.
        request: The inbound request, for deriving the mock's public base URL.
        auth_data: Authenticated tenant context (JWT or API key).

    Returns:
        The instance, reporting ``expired`` once past its TTL rather than 404 — the Studio shows
        an expired mock as expired instead of as an error.

    Raises:
        HTTPException: ``503`` when mocking is unavailable here; ``404`` when the id is unknown,
            belongs to another tenant, or names a hosted mock.
    """
    _require_available()
    instance = _owned_export_mock(mock_id, str(auth_data["tenant_id"]))
    return _instance_response(instance, request)


@router.get(
    "/{tenant_slug}/mock/{mock_id}/requests",
    response_model=ExportMockRequestLogResponse,
    summary="Read a test-drive mock's request log",
    description=(
        "The requests this mock served, newest first: method, path, status, whether an operation "
        "matched, the scenario in force, and whether the body agreed with the response schema. "
        "The log is a bounded in-memory ring buffer scoped to the serving replica — a live view "
        "of a mock that expires in minutes, not a durable audit trail."
    ),
)
async def get_export_mock_requests(
    tenant_slug: str,
    mock_id: str,
    limit: int = Query(default=50, ge=1, le=500, description="Most entries to return."),
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> ExportMockRequestLogResponse:
    """Read the retained request log for one test-drive mock.

    Args:
        tenant_slug: The tenant slug (scopes the lookup).
        mock_id: The instance id.
        limit: Cap on entries returned (newest first).
        auth_data: Authenticated tenant context (JWT or API key).

    Returns:
        The retained entries plus the buffer's capacity and whether the instance has served more
        requests than the log still holds.

    Raises:
        HTTPException: ``503`` when mocking is unavailable here; ``404`` when the id is unknown,
            belongs to another tenant, or names a hosted mock.
    """
    _require_available()
    instance = _owned_export_mock(mock_id, str(auth_data["tenant_id"]))
    entries = mock_request_log.entries(mock_id, limit=limit)
    retained = len(mock_request_log.entries(mock_id))
    return ExportMockRequestLogResponse(
        mock_id=mock_id,
        entries=[
            ExportMockRequestEntryResponse(
                at=entry.at.isoformat(),
                method=entry.method,
                path=entry.path,
                status=entry.status,
                matched=entry.matched,
                scenario=entry.scenario,
                operation_id=entry.operation_key,
                schema_valid=entry.schema_valid,
                duration_ms=entry.duration_ms,
            )
            for entry in entries
        ],
        retained=retained,
        capacity=max(1, settings.export_mock_request_log_size),
        truncated=int(instance.get("request_count") or 0) > retained,
    )


@router.delete(
    "/{tenant_slug}/mock/{mock_id}",
    status_code=204,
    summary="Stop a test-drive mock now",
    description=(
        "Tear the instance down before its TTL and discard its request log. The base URL stops "
        "resolving immediately, and the workspace's concurrency budget is freed."
    ),
)
async def destroy_export_mock(
    tenant_slug: str,
    mock_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> Response:
    """Destroy a test-drive mock and forget its request log.

    Args:
        tenant_slug: The tenant slug (scopes the lookup).
        mock_id: The instance id.
        auth_data: Authenticated tenant context (JWT or API key).

    Returns:
        An empty ``204`` response.

    Raises:
        HTTPException: ``503`` when mocking is unavailable here; ``404`` when the id is unknown,
            belongs to another tenant, or names a hosted mock.
    """
    _require_available()
    tenant_id = str(auth_data["tenant_id"])
    _owned_export_mock(mock_id, tenant_id)
    db.delete_mock_instance(mock_id, tenant_id)
    mock_request_log.forget(mock_id)
    return Response(status_code=204)
