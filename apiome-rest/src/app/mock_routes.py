"""Mock Server HTTP routes (#3615, RC1-2.2).

Two planes share this module:

* **Management plane** (``/v1/mocks/{tenant_slug}/...``) — authenticated, tenant-scoped CRUD for mock
  instances: provision from a published version, list, inspect, switch the active scenario, destroy.
* **Data plane** (``/v1/mock/{mock_id}/...``) — the public, unauthenticated mock itself. It replays
  schema-valid responses from the frozen spec, applies the selected scenario, and enforces the
  free-tier guardrails (auto-expiry → ``410 Gone``; per-instance rate limit → ``429``).

The "stable base URL" returned at provision time is ``/v1/mock/{mock_id}`` — it never changes for the
life of the instance because the spec is frozen at provision time (published versions are immutable).

The instance config's ``active_scenario`` and the version setting ``mock_settings.activeScenario``
(#5531, MSC-2.1) are the **same concept** under two spellings: the scenario the mock serves when a
request sends no ``X-Mock-Scenario`` header. This module's spelling belongs to the in-REST engine
serving ``/v1/mock/...``; the hosted data plane in apiome-mock reads the other. #5532 (MSC-2.2)
folds this plane away and migrates ``active_scenario`` onto ``activeScenario``.
"""

from __future__ import annotations

import asyncio
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, Response

from .auth import get_authenticated_user_id, validate_authentication
from .config import settings
from .database import db
from .export_mock import mock_request_log
from .mock_engine import (
    MockResponse,
    extract_operations,
    normalize_scenarios,
    resolve_response,
)
from .models import (
    MockInstanceResponse,
    MockProvisionRequest,
    MockScenarioSwitchRequest,
    MockUsageDailyRollup,
    MockUsageResponse,
)
from .openapi_generator import generate_openapi_spec
from .rate_limit import FixedWindowRateLimiter

# Management plane is tenant-scoped (plural "mocks"); the public data plane lives under the distinct
# singular "mock" segment so the two never collide on routing.
router = APIRouter(prefix="/v1/mocks", tags=["mock-server"])
data_router = APIRouter(prefix="/v1/mock", tags=["mock-server"])

# Per-instance fixed-window rate limiter for the data plane. Reuses the same limiter used for the
# global per-tenant limits (#3612) but keyed by mock instance id with each instance's own budget.
_mock_limiter = FixedWindowRateLimiter()

_ALL_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]


def _require_enabled() -> None:
    """Reject every mock route when the feature is disabled by configuration."""
    if not settings.mock_server_enabled:
        raise HTTPException(status_code=404, detail="Mock Server is disabled.")


def _now() -> datetime:
    """Current UTC time (wrapped so tests can monkeypatch the clock)."""
    return datetime.now(timezone.utc)


def _iso(value: Any) -> Optional[str]:
    """Render a datetime as an ISO-8601 string; pass through ``None``."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def mock_instance_is_expired(instance: Dict[str, Any]) -> bool:
    """Has the instance passed its ``expires_at``?

    Public because the export test-drive surface (MFX-44.5) reports the same expiry on the
    same rows; both planes must agree on when an instance stops serving.

    Args:
        instance: A ``mock_instances`` row.

    Returns:
        ``True`` once the row's ``expires_at`` is in the past.
    """
    expires_at = instance.get("expires_at")
    if not isinstance(expires_at, datetime):
        return False
    # Compare in UTC; DB timestamps are timezone-aware (TIMESTAMPTZ).
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    return _now() >= expires_at


def _schema_valid_flag(result: MockResponse) -> Optional[bool]:
    """Whether the served body was schema-checked, and the outcome, for the request log.

    Mirrors the ``X-Mock-Schema-Valid`` response header exactly: ``False`` when the body drifted
    from the response schema, ``True`` when an operation matched and it did not, and ``None`` when
    no operation matched at all — there is no schema to have been valid against.

    Args:
        result: The resolved mock response.

    Returns:
        The tri-state schema-validity flag.
    """
    if result.validation_error:
        return False
    if result.matched:
        return True
    return None


def _build_spec_for_version(
    version: Dict[str, Any], tenant_slug: str, project_slug: str, version_slug: str
) -> Dict[str, Any]:
    """Generate the OpenAPI document for a published version (same path as /v1/schema)."""
    classes = db.get_classes_for_version(version["id"])
    all_properties: Dict[str, List[Dict[str, Any]]] = {}
    for class_data in classes:
        all_properties[class_data["id"]] = db.get_properties_for_class(class_data["id"])
    return generate_openapi_spec(
        tenant_slug,
        project_slug,
        version_slug,
        classes,
        all_properties,
        version.get("project_description"),
        version_db_id=version["id"],
        revision_metadata=version.get("metadata"),
        project_metadata=version.get("project_metadata"),
    )


def _instance_to_response(instance: Dict[str, Any], request: Request) -> MockInstanceResponse:
    """Project a stored row into the public response, computing the stable base URL + op count."""
    spec = instance.get("spec") or {}
    config = instance.get("config") or {}
    scenario_names = [s["name"] for s in normalize_scenarios(config.get("scenarios"))]
    active = config.get("active_scenario") or "happy-path"
    base = str(request.base_url).rstrip("/")
    status = "expired" if mock_instance_is_expired(instance) else instance.get("status", "active")
    return MockInstanceResponse(
        id=str(instance["id"]),
        name=instance["name"],
        base_url=f"{base}/v1/mock/{instance['id']}",
        tenant_slug=instance["tenant_slug"],
        project_slug=instance["project_slug"],
        version_slug=instance["version_slug"],
        status=status,
        active_scenario=active,
        scenarios=scenario_names,
        operation_count=len(extract_operations(spec)),
        rate_limit_per_minute=instance["rate_limit_per_minute"],
        request_count=instance.get("request_count", 0),
        created_at=_iso(instance.get("created_at")),
        expires_at=_iso(instance.get("expires_at")),
        last_activity_at=_iso(instance.get("last_activity_at")),
    )


# ---------------------------------------------------------------------------
# Management plane
# ---------------------------------------------------------------------------


@router.post("/{tenant_slug}", response_model=MockInstanceResponse, status_code=201)
async def provision_mock(
    tenant_slug: str,
    request: Request,
    payload: MockProvisionRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> MockInstanceResponse:
    """Provision a mock instance from a published version and return its stable base URL.

    The version must be published. Its OpenAPI document is generated once and frozen into the
    instance so the mock is stable for its lifetime. Free-tier expiry and the per-instance rate limit
    are applied from configuration (overridable within bounds).
    """
    _require_enabled()
    tenant_id = auth_data["tenant_id"]

    version = db.get_version_by_slugs(tenant_slug, payload.project_slug, payload.version_slug)
    if not version:
        raise HTTPException(
            status_code=404,
            detail=f"Version not found: {tenant_slug}/{payload.project_slug}/{payload.version_slug}",
        )
    if not version.get("published"):
        raise HTTPException(
            status_code=400,
            detail="A mock can only be provisioned from a published version.",
        )

    spec = _build_spec_for_version(
        version, tenant_slug, payload.project_slug, payload.version_slug
    )

    # Merge any caller scenarios with the built-ins; validate the requested active scenario.
    scenarios = normalize_scenarios(
        [s.model_dump(by_alias=False) for s in payload.scenarios] if payload.scenarios else None
    )
    scenario_names = {s["name"] for s in scenarios}
    active_scenario = payload.active_scenario or "happy-path"
    if active_scenario not in scenario_names:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown active scenario '{active_scenario}'. Available: {sorted(scenario_names)}",
        )

    config: Dict[str, Any] = {
        "scenarios": scenarios,
        "active_scenario": active_scenario,
        "seed": payload.seed if payload.seed is not None else 0,
    }

    ttl_hours = payload.ttl_hours or settings.mock_default_ttl_hours
    ttl_hours = max(1, min(ttl_hours, settings.mock_max_ttl_hours))
    expires_at = _now() + timedelta(hours=ttl_hours)

    requested_rate = payload.rate_limit_per_minute or settings.mock_rate_limit_per_minute
    rate_limit = max(1, requested_rate)

    name = (payload.name or "").strip() or (
        f"{payload.project_slug} {payload.version_slug} mock"
    )

    instance = db.create_mock_instance(
        tenant_id=tenant_id,
        version_id=version["id"],
        tenant_slug=tenant_slug,
        project_slug=payload.project_slug,
        version_slug=payload.version_slug,
        name=name,
        spec=spec,
        config=config,
        rate_limit_per_minute=rate_limit,
        created_by=get_authenticated_user_id(auth_data),
        expires_at=expires_at,
    )
    return _instance_to_response(instance, request)


@router.get("/{tenant_slug}", response_model=List[MockInstanceResponse])
async def list_mocks(
    tenant_slug: str,
    request: Request,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> List[MockInstanceResponse]:
    """List the tenant's mock instances, newest first."""
    _require_enabled()
    instances = db.list_mock_instances(auth_data["tenant_id"])
    return [_instance_to_response(row, request) for row in instances]


@router.get("/{tenant_slug}/usage", response_model=MockUsageResponse)
async def get_mock_usage(
    tenant_slug: str,
    days: int = 30,
    project_slug: Optional[str] = None,
    version_label: Optional[str] = None,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> MockUsageResponse:
    """Return mock usage counters and daily rollups for the tenant (#4420, SIM-1.5).

    Note: ``project_slug`` and ``version_label`` filter the ``dailyRollups`` only.
    ``monthlyRequestCount``, ``monthlyQuota``, and ``mockRps`` are always tenant-wide
    totals, regardless of any filter parameters.
    """
    _require_enabled()
    tenant_id = auth_data["tenant_id"]
    limits = db.get_mock_license_limits_for_tenant(tenant_id)
    rollups = db.list_mock_usage_rollups(
        tenant_id,
        days=days,
        project_slug=project_slug,
        version_label=version_label,
    )
    daily = [
        MockUsageDailyRollup(
            usage_date=row["usage_date"].isoformat()
            if hasattr(row["usage_date"], "isoformat")
            else str(row["usage_date"]),
            project_slug=row["project_slug"],
            version_label=row["version_label"],
            request_count=int(row["request_count"]),
        )
        for row in rollups
    ]
    return MockUsageResponse(
        monthly_request_count=db.get_mock_monthly_usage(tenant_id),
        monthly_quota=int(limits["mock_requests_per_month"]),
        mock_rps=float(limits["mock_rps"]),
        daily_rollups=daily,
    )


@router.get("/{tenant_slug}/{mock_id}", response_model=MockInstanceResponse)
async def get_mock(
    tenant_slug: str,
    mock_id: str,
    request: Request,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> MockInstanceResponse:
    """Inspect one mock instance owned by the tenant."""
    _require_enabled()
    instance = db.get_mock_instance_for_tenant(mock_id, auth_data["tenant_id"])
    if not instance:
        raise HTTPException(status_code=404, detail=f"Mock instance not found: {mock_id}")
    return _instance_to_response(instance, request)


@router.put("/{tenant_slug}/{mock_id}/active-scenario", response_model=MockInstanceResponse)
async def switch_active_scenario(
    tenant_slug: str,
    mock_id: str,
    request: Request,
    payload: MockScenarioSwitchRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> MockInstanceResponse:
    """Switch the instance's default scenario (takes effect immediately, no restart)."""
    _require_enabled()
    tenant_id = auth_data["tenant_id"]
    instance = db.get_mock_instance_for_tenant(mock_id, tenant_id)
    if not instance:
        raise HTTPException(status_code=404, detail=f"Mock instance not found: {mock_id}")

    config = dict(instance.get("config") or {})
    available = {s["name"] for s in normalize_scenarios(config.get("scenarios"))}
    if payload.active_scenario not in available:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown scenario '{payload.active_scenario}'. Available: {sorted(available)}",
        )
    config["active_scenario"] = payload.active_scenario
    updated = db.update_mock_instance_config(mock_id, tenant_id, config)
    if not updated:
        raise HTTPException(status_code=404, detail=f"Mock instance not found: {mock_id}")
    return _instance_to_response(updated, request)


@router.delete("/{tenant_slug}/{mock_id}", status_code=204)
async def destroy_mock(
    tenant_slug: str,
    mock_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> Response:
    """Destroy a mock instance and all of its state."""
    _require_enabled()
    deleted = db.delete_mock_instance(mock_id, auth_data["tenant_id"])
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Mock instance not found: {mock_id}")
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# Data plane
# ---------------------------------------------------------------------------


async def _serve_mock(mock_id: str, sub_path: str, request: Request) -> Response:
    """Resolve and return the mock response for a data-plane request.

    Enforces (in order): feature flag, instance existence, expiry, per-instance rate limit. Then
    matches the operation, applies the active scenario, optionally sleeps for injected latency, and
    returns a schema-valid (or scenario-overridden) body.
    """
    _require_enabled()
    started = time.perf_counter()
    instance = db.get_mock_instance(mock_id)
    if not instance:
        raise HTTPException(status_code=404, detail=f"Mock instance not found: {mock_id}")

    if mock_instance_is_expired(instance):
        raise HTTPException(
            status_code=410,
            detail="This mock instance has expired. Provision a new one to continue.",
        )

    # The request path relative to the mock base URL, resolved once: the rate-limit log entry and
    # the operation match below must describe the same path.
    relative_request_path = "/" + sub_path if not sub_path.startswith("/") else sub_path

    # Per-instance free-tier rate limit.
    limit = instance["rate_limit_per_minute"]
    allowed, remaining, reset_after, retry_after = _mock_limiter.check(
        f"mock:{mock_id}", limit, 60, time.monotonic()
    )
    rate_headers = {
        "X-RateLimit-Limit": str(limit),
        "X-RateLimit-Remaining": str(remaining),
        "X-RateLimit-Reset": str(reset_after),
    }
    if not allowed:
        # A throttled request is still something the caller did — the export test drive's request
        # log (MFX-44.5) has to show it, or a user hitting the budget sees silence instead of 429s.
        mock_request_log.record(
            mock_id,
            method=request.method,
            path=relative_request_path,
            status=429,
            matched=False,
            scenario=str((instance.get("config") or {}).get("active_scenario") or "happy-path"),
            operation_key=None,
            schema_valid=None,
            duration_ms=int((time.perf_counter() - started) * 1000),
        )
        return JSONResponse(
            status_code=429,
            content={"detail": "Mock rate limit exceeded. Slow down and retry later."},
            headers={**rate_headers, "Retry-After": str(retry_after)},
        )

    spec = instance.get("spec") or {}
    config = instance.get("config") or {}
    operations = extract_operations(spec)

    result = resolve_response(
        spec,
        config,
        operations,
        request.method,
        relative_request_path,
        scenario_header=request.headers.get("x-mock-scenario"),
        seed=int(config.get("seed", 0) or 0),
    )

    if result.latency_ms > 0:
        await asyncio.sleep(result.latency_ms / 1000.0)

    db.touch_mock_instance(mock_id)

    headers = {
        **rate_headers,
        "X-Mock-Scenario": result.scenario,
        "X-Mock-Matched": "true" if result.matched else "false",
    }
    if result.operation_key:
        headers["X-Mock-Operation"] = result.operation_key
    if result.validation_error:
        # The response still goes out, but flag that synthesis drifted from the schema so callers
        # (and our own tests/telemetry) can notice. Schema-valid responses carry "pass".
        headers["X-Mock-Schema-Valid"] = "false"
    elif result.matched:
        headers["X-Mock-Schema-Valid"] = "true"

    # Record what was served for the export test drive's request-log panel (MFX-44.5). Every
    # instance is recorded — the store is keyed by mock id and only the export surface reads it, so
    # one code path here serves both planes. The store is a bounded in-memory ring buffer, so this
    # adds no DB write to the hot path and cannot fail the response.
    mock_request_log.record(
        mock_id,
        method=request.method,
        path=relative_request_path,
        status=result.status,
        matched=result.matched,
        scenario=result.scenario,
        operation_key=result.operation_key,
        schema_valid=_schema_valid_flag(result),
        duration_ms=int((time.perf_counter() - started) * 1000),
    )

    if result.body is None:
        return Response(status_code=result.status, headers=headers)
    return JSONResponse(status_code=result.status, content=result.body, headers=headers)


def _make_root_handler(method: str):  # type: ignore[return]
    async def _handler(mock_id: str, request: Request) -> Response:
        """Serve the mock for a request to the instance root path."""
        return await _serve_mock(mock_id, "", request)

    _handler.__name__ = f"serve_mock_root_{method.lower()}"
    return _handler


def _make_path_handler(method: str):  # type: ignore[return]
    async def _handler(mock_id: str, sub_path: str, request: Request) -> Response:
        """Serve the mock for any request path under the instance base URL."""
        return await _serve_mock(mock_id, sub_path, request)

    _handler.__name__ = f"serve_mock_path_{method.lower()}"
    return _handler


for _method in _ALL_METHODS:
    data_router.api_route("/{mock_id}", methods=[_method])(_make_root_handler(_method))
    data_router.api_route("/{mock_id}/{sub_path:path}", methods=[_method])(_make_path_handler(_method))
