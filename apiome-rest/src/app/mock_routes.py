"""Mock Server HTTP routes (#3615 RC1-2.2; folded onto one engine by #5532, MSC-2.2).

Two planes share this module:

* **Management plane** (``/v1/mocks/{tenant_slug}/...``) — authenticated, tenant-scoped CRUD for mock
  instances: provision from a published version, list, inspect, switch the active scenario, destroy.
* **Data plane** (``/v1/mock/{mock_id}/...``) — the public, unauthenticated mock itself.

The "stable base URL" returned at provision time is ``/v1/mock/{mock_id}`` — it never changes for the
life of the instance because the spec is frozen at provision time (published versions are immutable).

**What MSC-2.2 changed.** The data plane used to *resolve* responses itself, from a second mock
engine that lived in this package: scenarios as a list of rules, no templates, no match predicates,
no stateful CRUD, no fixture packs, no chaos. apiome-mock had all of those and read a different
scenario schema, so every mock feature was either built twice or invisible on one of the two
surfaces. That engine is deleted. This module now owns only what a *sandbox* is — does the instance
exist, has it expired, is the caller inside its rate limit, what should be recorded — and forwards
the request itself to apiome-mock through :mod:`app.mock_sandbox`, which answers it with the same
function that serves every other mock request. There is no second resolver left to disagree.

The consequence worth stating: this deployment must be able to reach apiome-mock
(``APIOME_MOCK_INTERNAL_BASE_URL`` / ``APIOME_MOCK_INTERNAL_TOKEN``) for the data plane to serve.
Unconfigured, it answers ``503`` with a message saying so, and never falls back to a local engine —
having no local engine is the point.

The instance's stored scenarios and its default scenario now live in the ``settings`` column, in
the same shape ``versions.mock_settings`` uses, with ``active_scenario`` folded onto
``activeScenario`` (#5531, MSC-2.1). The legacy ``config`` column is kept unread as the pre-fold
record; :mod:`app.mock_instance_config` is the one translator between the two.
"""

from __future__ import annotations

import base64
import logging
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, Response

from .auth import get_authenticated_user_id, validate_authentication
from .config import settings
from .database import db
from .export_mock import mock_request_log
from .mock_instance_config import (
    ACTIVE_SCENARIO_KEY,
    DEFAULT_SCENARIO_NAME,
    fold_instance_config,
)
from .mock_routing import extract_operations
from .mock_sandbox import (
    FORWARDED_SANDBOX_STATUSES,
    NOT_CONFIGURED_DETAIL,
    MockSandboxError,
    MockSandboxRejected,
    MockSandboxUnavailable,
    request_sandbox_serve,
    sandbox_bundle,
    sandbox_is_configured,
)
from .mock_settings_util import parse_mock_settings
from .models import (
    MockInstanceResponse,
    MockProvisionRequest,
    MockScenarioSwitchRequest,
    MockUsageDailyRollup,
    MockUsageResponse,
)
from .openapi_generator import generate_openapi_spec
from .rate_limit import FixedWindowRateLimiter

logger = logging.getLogger(__name__)

# Management plane is tenant-scoped (plural "mocks"); the public data plane lives under the distinct
# singular "mock" segment so the two never collide on routing.
router = APIRouter(prefix="/v1/mocks", tags=["mock-server"])
data_router = APIRouter(prefix="/v1/mock", tags=["mock-server"])

# Per-instance fixed-window rate limiter for the data plane. Reuses the same limiter used for the
# global per-tenant limits (#3612) but keyed by mock instance id with each instance's own budget.
_mock_limiter = FixedWindowRateLimiter()

_ALL_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]

#: Scenario names every mock resolves, supplied by ``apiome_mock.builtin_scenarios`` at serve time.
#: Mirrored here (this package cannot import apiome-mock, which depends on it) so the management
#: plane can list and validate them. apiome-mock's ``test_builtin_scenarios.py`` asserts the two
#: lists agree — it is the only place both sides are importable.
BUILTIN_SCENARIO_NAMES: Tuple[str, ...] = ("happy-path", "server-error", "not-found", "slow")

#: Headers that describe *this* connection rather than the request or response, and so must not be
#: copied across the hop in either direction: the framing ones are recomputed for the body actually
#: sent, and ``host`` names a server the mock engine is not.
_HOP_BY_HOP_HEADERS = frozenset(
    {"content-length", "transfer-encoding", "connection", "keep-alive", "host"}
)


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

    Expiry stayed with this service after MSC-2.2 on purpose: a TTL is a property of the *sandbox*
    the control plane provisioned, not of the mock configuration the engine serves. Public because
    the export test-drive surface (MFX-44.5) reports the same expiry on the same rows; both planes
    must agree on when an instance stops serving.

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


def instance_settings(instance: Dict[str, Any]) -> Dict[str, Any]:
    """Return the apiome-mock-shaped settings an instance is served from, folding on first read.

    Instances provisioned before MSC-2.2 carry only the legacy ``config``. Rather than requiring a
    maintenance window, the fold happens the first time either plane reads such a row and the
    result is written back (best effort — a failed write just means the next read folds it again,
    which is deterministic and cheap). Instances provisioned since carry ``settings`` already and
    take the fast path.

    Args:
        instance: A ``mock_instances`` row. Mutated in place so callers within one request see the
            folded settings without a second query.

    Returns:
        The settings mapping to build the sandbox bundle from.
    """
    stored = instance.get("settings")
    if stored is not None:
        return parse_mock_settings(stored)

    fold = fold_instance_config(instance.get("config"), instance.get("spec"))
    instance["settings"] = fold.settings
    instance["migration_notes"] = fold.notes
    db.fold_mock_instance_config(str(instance["id"]), fold.settings, fold.notes)
    if fold.notes:
        logger.info(
            "Folded legacy mock instance %s with %d untranslatable rule(s).",
            instance["id"],
            len(fold.notes),
        )
    return fold.settings


def instance_scenario_names(settings_map: Dict[str, Any]) -> List[str]:
    """List every scenario name an instance resolves, built-ins first.

    Args:
        settings_map: The instance's folded settings.

    Returns:
        The built-in names in their declared order, then any stored scenarios not shadowing one.
    """
    stored = settings_map.get("scenarios")
    stored_names = list(stored) if isinstance(stored, dict) else []
    names = list(BUILTIN_SCENARIO_NAMES)
    names.extend(name for name in stored_names if name not in names)
    return names


def instance_active_scenario(settings_map: Dict[str, Any]) -> str:
    """The scenario an instance serves when a request sends no ``X-Mock-Scenario`` header.

    Args:
        settings_map: The instance's folded settings.

    Returns:
        The stored ``activeScenario``, or ``happy-path`` — which is what "no stored default" means
        to the runtime, and what the retired engine called the same thing.
    """
    stored = settings_map.get(ACTIVE_SCENARIO_KEY)
    if isinstance(stored, str) and stored.strip():
        return stored.strip()
    return DEFAULT_SCENARIO_NAME


def _instance_seed(instance: Dict[str, Any]) -> int:
    """The instance's stored generation seed.

    apiome-mock takes a seed per request (``?__seed=``) rather than storing one, so the sandbox hop
    carries the instance's seed on every request that does not pin its own.

    Args:
        instance: A ``mock_instances`` row.

    Returns:
        The seed, or ``0`` when none was stored.
    """
    config = instance.get("config") or {}
    raw = config.get("seed") if isinstance(config, dict) else None
    return int(raw) if isinstance(raw, int) and not isinstance(raw, bool) else 0


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
    settings_map = instance_settings(instance)
    base = str(request.base_url).rstrip("/")
    status = "expired" if mock_instance_is_expired(instance) else instance.get("status", "active")
    notes = instance.get("migration_notes")
    return MockInstanceResponse(
        id=str(instance["id"]),
        name=instance["name"],
        base_url=f"{base}/v1/mock/{instance['id']}",
        tenant_slug=instance["tenant_slug"],
        project_slug=instance["project_slug"],
        version_slug=instance["version_slug"],
        status=status,
        active_scenario=instance_active_scenario(settings_map),
        scenarios=instance_scenario_names(settings_map),
        operation_count=len(extract_operations(spec)),
        rate_limit_per_minute=instance["rate_limit_per_minute"],
        request_count=instance.get("request_count", 0),
        created_at=_iso(instance.get("created_at")),
        expires_at=_iso(instance.get("expires_at")),
        last_activity_at=_iso(instance.get("last_activity_at")),
        migration_notes=list(notes) if isinstance(notes, list) else [],
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

    Caller-supplied scenarios keep the RC1-2.2 request shape — a list of rules — and are folded into
    the engine's settings shape at provision time (#5532, MSC-2.2), with the same translator that
    migrates instances provisioned before the fold. Rules that cannot be translated are reported on
    the instance rather than dropped.
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

    config: Dict[str, Any] = {
        "scenarios": [s.model_dump(by_alias=False) for s in payload.scenarios] if payload.scenarios else [],
        "active_scenario": payload.active_scenario or DEFAULT_SCENARIO_NAME,
        "seed": payload.seed if payload.seed is not None else 0,
    }
    fold = fold_instance_config(config, spec)

    available = set(instance_scenario_names(fold.settings))
    if config["active_scenario"] not in available:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown active scenario '{config['active_scenario']}'. Available: {sorted(available)}",
        )

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
        settings=fold.settings,
        migration_notes=fold.notes,
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
    """Switch the instance's default scenario (takes effect immediately, no restart).

    The switch writes ``activeScenario`` into the instance's settings — the same key, read the same
    way, as a version's stored active scenario (#5531, MSC-2.1). The two spellings that used to
    describe this one concept are now one.
    """
    _require_enabled()
    tenant_id = auth_data["tenant_id"]
    instance = db.get_mock_instance_for_tenant(mock_id, tenant_id)
    if not instance:
        raise HTTPException(status_code=404, detail=f"Mock instance not found: {mock_id}")

    settings_map = dict(instance_settings(instance))
    available = set(instance_scenario_names(settings_map))
    if payload.active_scenario not in available:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown scenario '{payload.active_scenario}'. Available: {sorted(available)}",
        )
    settings_map[ACTIVE_SCENARIO_KEY] = payload.active_scenario
    updated = db.update_mock_instance_settings(mock_id, tenant_id, settings_map)
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


async def _request_body(request: Request) -> Any:
    """Read the incoming body in the shape the sandbox hop carries.

    Args:
        request: The incoming data-plane request.

    Returns:
        The decoded text body, or ``None`` when the request carried none. Bodies that are not
        UTF-8 are dropped rather than mangled: the mock's predicates and templates read JSON, and
        a binary payload has nothing for them to read.

    Raises:
        HTTPException: ``413`` when the body exceeds what the hop will carry. The mock engine reads
            a request body only to evaluate predicates and templates against it, so a body past
            this size would be carried across a service boundary to be ignored.
    """
    raw = await request.body()
    if not raw:
        return None
    if len(raw) > settings.mock_sandbox_max_body_bytes:
        raise HTTPException(
            status_code=413,
            detail=(
                f"Request body is too large for a mock: {len(raw)} bytes exceeds the "
                f"{settings.mock_sandbox_max_body_bytes}-byte limit."
            ),
        )
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return None


def _sandbox_request(request: Request, sub_path: str, seed: int) -> Dict[str, Any]:
    """Project the incoming request into the payload the sandbox hop carries.

    Args:
        request: The incoming data-plane request.
        sub_path: The path relative to the instance base URL.
        seed: The instance's stored generation seed, applied when the caller pins none.

    Returns:
        The request projection, without its body (added by the caller, which must await it).
    """
    query: Dict[str, Any] = {}
    for name, value in request.query_params.multi_items():
        existing = query.get(name)
        if existing is None:
            query[name] = value
        elif isinstance(existing, list):
            existing.append(value)
        else:
            query[name] = [existing, value]
    return {
        "method": request.method,
        "path": "/" + sub_path.lstrip("/"),
        "headers": {
            name: value
            for name, value in request.headers.items()
            if name.lower() not in _HOP_BY_HOP_HEADERS
        },
        "query": query,
        "seed": seed,
    }


def _response_from_sandbox(result: Dict[str, Any], extra_headers: Dict[str, str]) -> Response:
    """Rebuild the mock's response for the original caller.

    The engine's headers are forwarded except the framing ones, which describe a body this service
    re-encodes and must be recomputed rather than copied.

    Args:
        result: The sandbox hop's payload.
        extra_headers: Headers this service adds (rate limits, matched/operation).

    Returns:
        The response to return to the data-plane caller.
    """
    headers = {
        name: value
        for name, value in (result.get("headers") or {}).items()
        if name.lower() not in _HOP_BY_HOP_HEADERS
    }
    headers.update(extra_headers)

    status = int(result.get("status") or 200)
    media_type = str(result.get("mediaType") or "application/json")
    encoding = result.get("bodyEncoding")
    body = result.get("body")

    if encoding == "json":
        return JSONResponse(status_code=status, content=body, headers=headers, media_type=media_type)
    if encoding == "text":
        return Response(content=str(body), status_code=status, headers=headers, media_type=media_type)
    if encoding == "base64":
        return Response(
            content=base64.b64decode(str(body)),
            status_code=status,
            headers=headers,
            media_type=media_type,
        )
    return Response(status_code=status, headers=headers)


async def _serve_mock(mock_id: str, sub_path: str, request: Request) -> Response:
    """Serve one data-plane request for a mock instance.

    Enforces (in order): feature flag, instance existence, expiry, per-instance rate limit — the
    sandbox's own lifecycle, which this service owns. The response itself is resolved by
    apiome-mock, which is the only mock engine (#5532, MSC-2.2): this function builds the
    instance's portable bundle, forwards the request, and rebuilds what came back.

    Args:
        mock_id: The instance id from the URL.
        sub_path: The path below the instance base URL.
        request: The incoming request.

    Returns:
        The mock's response, or a problem response describing why it could not be served.

    Raises:
        HTTPException: ``404`` when the feature is off or the instance is unknown, ``410`` once it
            has expired, ``502`` when the mock engine could not be reached, ``503`` when this
            deployment has no mock engine configured.
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
    # the served response below must describe the same path.
    relative_request_path = "/" + sub_path if not sub_path.startswith("/") else sub_path

    settings_map = instance_settings(instance)
    active_scenario = instance_active_scenario(settings_map)

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
            scenario=active_scenario,
            operation_key=None,
            schema_valid=None,
            duration_ms=int((time.perf_counter() - started) * 1000),
        )
        return JSONResponse(
            status_code=429,
            content={"detail": "Mock rate limit exceeded. Slow down and retry later."},
            headers={**rate_headers, "Retry-After": str(retry_after)},
        )

    if not sandbox_is_configured():
        # No local engine to fall back to, by design. Say so plainly rather than serving something
        # a second resolver invented.
        raise HTTPException(status_code=503, detail=NOT_CONFIGURED_DETAIL)

    sandbox_request = _sandbox_request(request, relative_request_path, _instance_seed(instance))
    sandbox_request["body"] = await _request_body(request)

    try:
        result = await request_sandbox_serve(
            sandbox_id=str(instance["id"]),
            bundle=sandbox_bundle(instance),
            request=sandbox_request,
        )
    except MockSandboxUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except MockSandboxRejected as exc:
        # A refusal about the caller's own payload is forwarded verbatim. Anything else — a
        # rejected service token, an internal fault — is a deployment problem the caller can do
        # nothing about and must not be told the details of, so it becomes a plain 502.
        if exc.status_code in FORWARDED_SANDBOX_STATUSES:
            raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
        logger.error("Mock engine refused to serve sandbox %s with %s: %s", mock_id, exc.status_code, exc.detail)
        raise HTTPException(status_code=502, detail="The mock engine refused to serve this request.") from exc
    except MockSandboxError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    db.touch_mock_instance(mock_id)

    operation_key = result.get("operation")
    matched = operation_key is not None
    schema_valid = result.get("schemaValid")
    extra_headers = {
        **rate_headers,
        "X-Mock-Matched": "true" if matched else "false",
    }
    if operation_key:
        extra_headers["X-Mock-Operation"] = str(operation_key)
    scenario = result.get("scenario") or active_scenario

    # Record what was served for the export test drive's request-log panel (MFX-44.5). The store is
    # a bounded in-memory ring buffer, so this adds no DB write to the hot path and cannot fail the
    # response.
    mock_request_log.record(
        mock_id,
        method=request.method,
        path=relative_request_path,
        status=int(result.get("status") or 200),
        matched=matched,
        scenario=str(scenario),
        operation_key=str(operation_key) if operation_key else None,
        schema_valid=schema_valid if isinstance(schema_valid, bool) else None,
        duration_ms=int((time.perf_counter() - started) * 1000),
    )

    return _response_from_sandbox(result, extra_headers)


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
