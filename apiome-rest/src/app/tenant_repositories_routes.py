"""
Tenant Git repositories: list and register (dashboard).

POST requires JWT so we can verify linked GitHub accounts via ``external_auth_providers``.
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from typing import Any, Dict, List, Optional, Tuple

_logger = logging.getLogger(__name__)

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from psycopg2 import errors as pg_errors

from .auth import get_authenticated_user_id, validate_authentication
from .database import db
from .permissions import enforce_permission, Resource, Action
from .models import (
    RefreshHistoryEntryOut,
    RefreshHistoryPageResponse,
    RefreshHistoryPaginationOut,
    RepositoryHealthOut,
    RepositoryImportSpecRead,
    RepositoryNotificationPreferenceOut,
    RepositoryNotificationPreferencesResponse,
    RepositoryNotificationPreferencesUpdate,
    RepositoryPollingQuotaOut,
    RepositoryPollingQuotaResponse,
    RepositoryPollingQuotaUpdate,
    RepositoryQuotaTelemetryOut,
    RepositoryQuotaTelemetryResponse,
    repository_import_spec_read_from_row,
    RepositoryRefreshNowRequest,
    RepositoryRefreshNowResponse,
    RepositoryWebhookEventOut,
    RepositoryWebhookRotateRequest,
    RepositoryWebhookRotateResponse,
    RepositoryWebhookStatusResponse,
    RepositoryWebhookSubscriptionOut,
    SpecCatalogFacetOption,
    SpecCatalogFacets,
    SpecCatalogResponse,
    SpecCatalogRow,
    TenantRepositoryCreate,
    TenantRepositoryCreateResponse,
    TenantRepositoryFileContentResponse,
    TenantRepositoryFileRow,
    TenantRepositoryFilesListResponse,
    TenantRepositoryGetResponse,
    TenantRepositoryRecord,
    TenantRepositoryUpdate,
    TenantRepositoriesListResponse,
)
from .repository_event_notifications import (
    ALL_EVENT_TYPES as ALL_REPOSITORY_NOTIFICATION_EVENTS,
    coerce_event as coerce_repository_notification_event,
    DEFAULT_THROTTLE_WINDOW_SECONDS,
    describe_repository_notification_preferences,
)
from .repository_health import health_payloads_for_rows
from .repository_refresh_audit import RefreshOutcome, RefreshTrigger
from .repository_spec_catalog import (
    SPEC_FORMAT_LABELS,
    format_facet_options,
    normalize_format,
    normalize_sort,
    normalize_status,
    status_facet_options,
    validate_search_term,
)
from .repository_quota_window import (
    DEFAULT_TELEMETRY_DAYS,
    MAX_TELEMETRY_DAYS,
    describe_quota_telemetry,
)
from .repository_refresh_quota import describe_tenant_polling_quota
from .repository_file_scan import _github_owner_repo, fetch_github_repository_file_text
from .repository_webhook_rotation import (
    RotationError,
    resolve_linked_account_token,
    rotate_repository_webhook_secret,
)
from .repository_webhook_subscriptions import (
    describe_subscription,
    provision_repository_webhook,
)
from .repository_validation import (
    fetch_github_repo_with_token,
    normalize_clone_url_for_dedup,
    parse_github_owner_repo_from_url,
    parse_owner_repo_slash,
    validate_public_clone_url,
)

router = APIRouter(prefix="/v1/tenants", tags=["tenant-repositories"])

# Importable-type preset → comma-separated globs (Repository Store README).
_PRESET_GLOB_CSV: Dict[str, str] = {
    "openapi": (
        "**/openapi*.yaml,**/openapi*.yml,**/openapi*.json,"
        "**/swagger*.yaml,**/swagger*.yml,**/swagger*.json"
    ),
    "arazzo": "**/arazzo*.yaml,**/arazzo*.yml,**/*.arazzo.yaml,**/*.arazzo.yml,**/arazzo*.json",
    "asyncapi": "**/asyncapi*.yaml,**/asyncapi*.yml,**/asyncapi*.json",
    "json_schema": "**/*.schema.json,**/schemas/**/*.json",
    "graphql": "**/*.graphql,**/*.gql",
    "protobuf": "**/*.proto",
    "avro": "**/*.avsc",
    "postman": "**/*.postman_collection.json,**/postman_collection.json",
    "sql_ddl": "**/*.sql,**/*.ddl",
}


def _glob_token_to_sql_like(token: str) -> str:
    """Turn one glob fragment into a SQL ILIKE pattern (``*`` / ``**`` → ``%``)."""
    t = token.strip()
    if not t:
        return "%"
    s = t.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    s = s.replace("**", "\x00").replace("*", "\x01")
    s = s.replace("\x00", "%").replace("\x01", "%")
    return s


def _preset_like_patterns(preset: str) -> List[str]:
    key = (preset or "").strip().lower()
    if not key or key == "custom":
        return []
    if key == "all":
        merged: List[str] = []
        for csv in _PRESET_GLOB_CSV.values():
            for piece in csv.split(","):
                p = piece.strip()
                if p:
                    merged.append(_glob_token_to_sql_like(p))
        return merged
    raw = _PRESET_GLOB_CSV.get(key)
    if not raw:
        return []
    return [_glob_token_to_sql_like(p.strip()) for p in raw.split(",") if p.strip()]


def _external_ref_summary(raw: Any) -> Tuple[Optional[str], Optional[int]]:
    """Summarize a file's REPO-3.9 ``external_ref_warning`` for the Files listing.

    Args:
        raw: The stored JSONB warning — a mapping, a JSON string (some drivers surface JSONB
            that way), or ``None`` for a file with no unresolved external references.

    Returns:
        ``(policy, unresolved_count)``, both ``None`` when there is no usable warning. A
        malformed warning degrades to ``(None, None)`` rather than failing the listing: it is
        an informational badge, not something a caller is blocked on.
    """
    warning: Any = raw
    if isinstance(warning, str):
        try:
            warning = json.loads(warning)
        except ValueError:
            return None, None
    if not isinstance(warning, dict):
        return None, None
    policy = warning.get("policy")
    count = warning.get("unresolved_count")
    return (
        str(policy) if policy else None,
        int(count) if isinstance(count, int) and count >= 0 else None,
    )


def _display_kind(detected: Optional[str], path: str) -> str:
    if not detected:
        return "Uncategorised"
    k = detected.lower()
    pl = path.lower()
    if k.startswith("openapi") or k.startswith("swagger"):
        return "OpenAPI"
    if k.startswith("arazzo"):
        return "Arazzo"
    if k.startswith("asyncapi"):
        return "AsyncAPI"
    if k.startswith("json"):
        if ".schema.json" in pl or "/schemas/" in pl:
            return "JSON Schema"
        return "JSON (unclassified)"
    if k.startswith("yaml"):
        return "YAML (unclassified)"
    if k.startswith("graphql"):
        return "GraphQL"
    if k.startswith("protobuf"):
        return "Protobuf"
    if k.startswith("postman"):
        return "Postman"
    if k.startswith("sql-ddl"):
        return "SQL DDL"
    if k.startswith("prisma"):
        return "Prisma"
    if k.startswith("avro"):
        return "Avro"
    if k.startswith("dbml"):
        return "DBML"
    return detected.replace("-", " ").replace("_", " ").title()


def _ts(value: Any) -> Optional[str]:
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()  # type: ignore[no-any-return]
    return str(value)


def _repository_health_by_id(
    tenant_id: str,
    repository_ids: Optional[List[str]] = None,
) -> Dict[str, Dict[str, Any]]:
    """Compute the REPO-6.5 health badge for a tenant's repositories, keyed by id.

    One query for the whole batch, so the repositories list costs the same round trip
    whether the tenant has one repository or fifty.

    A health roll-up is a decoration on a listing, never its point of failure: if the
    signal query cannot run (an older schema, a transient database problem) this logs and
    returns an empty mapping, and the affected rows simply carry no badge.

    Args:
        tenant_id: Tenant whose repositories to read.
        repository_ids: Optional subset (the detail view passes exactly one).

    Returns:
        ``{repository_id: health payload}``; empty when the signals could not be read.
    """
    try:
        rows = db.get_repository_health_signals(tenant_id, repository_ids)
    except Exception:
        _logger.warning(
            "repository health signals unavailable tenant_id=%s", tenant_id, exc_info=True
        )
        return {}
    return health_payloads_for_rows(rows)


def _row_to_record(
    row: Dict[str, Any],
    health: Optional[Dict[str, Any]] = None,
) -> TenantRepositoryRecord:
    full = (row.get("repository_full_name") or "").strip()
    name = full.rsplit("/", 1)[-1] if full else "repository"
    if not name:
        name = "repository"
    return TenantRepositoryRecord(
        id=str(row["id"]),
        name=name,
        full_name=full or str(row.get("clone_url") or ""),
        description=row.get("description"),
        provider=str(row.get("provider") or "github"),
        default_branch=str(row.get("default_branch") or "main"),
        visibility=str(row["visibility"]) if row.get("visibility") is not None else None,
        status=str(row.get("status") or "pending"),
        clone_url=str(row["clone_url"]) if row.get("clone_url") else None,
        source=str(row["source"]) if row.get("source") else None,
        last_scanned_at=_ts(row.get("last_scanned_at")) if row.get("last_scanned_at") is not None else None,
        total_files=row.get("total_files") if isinstance(row.get("total_files"), int) else None,
        importable_count=row.get("importable_count") if isinstance(row.get("importable_count"), int) else None,
        branch_count=row.get("branch_count") if isinstance(row.get("branch_count"), int) else None,
        # Default-on so a repo whose row predates the RAR-3.3 column reads as enabled.
        auto_refresh_enabled=bool(row.get("auto_refresh_enabled", True)),
        # RAR-3.4 backoff/auto-pause state; healthy defaults for pre-column rows.
        refresh_consecutive_failures=int(row.get("refresh_consecutive_failures") or 0),
        refresh_backoff_until=_ts(row.get("refresh_backoff_until")),
        refresh_paused_at=_ts(row.get("refresh_paused_at")),
        refresh_pause_reason=(
            str(row["refresh_pause_reason"]) if row.get("refresh_pause_reason") else None
        ),
        # REPO-6.5 badge; omitted (null) when health signals could not be read.
        health=RepositoryHealthOut(**health) if health else None,
        created_at=_ts(row.get("created_at")),
        updated_at=_ts(row.get("updated_at")),
    )


def _require_jwt_user(auth_data: Dict[str, Any]) -> str:
    uid = get_authenticated_user_id(auth_data)
    if not uid:
        raise HTTPException(
            status_code=403,
            detail="JWT authentication is required to register repositories",
        )
    return str(uid)


@router.get(
    "/{tenant_slug}/repository-polling-quota",
    response_model=RepositoryPollingQuotaResponse,
    response_model_by_alias=True,
)
async def get_tenant_repository_polling_quota(
    tenant_slug: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> RepositoryPollingQuotaResponse:
    """Report this tenant's repository polling quota and window usage (REPO-4.6, #2784).

    The quota bounds how many poll (refresh) jobs the auto-refresh scheduler may enqueue for
    the tenant per rolling window, so one noisy tenant cannot starve the scheduler for
    everyone else. This is the read an operator makes to answer "are we being deferred, and
    how close to the ceiling are we?" — it reports the persisted bound, the bound actually
    being enforced (which differs when quotas are disabled deployment-wide), and how much of
    the current window is already spent.

    Args:
        tenant_slug: Tenant slug from the path (scoping comes from the token).
        auth_data: Authenticated principal; supplies the tenant scope.

    Returns:
        The tenant's quota projection.
    """
    enforce_permission(db, auth_data, Resource.IMPORTS, Action.VIEW)
    _ = tenant_slug
    tenant_id = str(auth_data["tenant_id"])
    return RepositoryPollingQuotaResponse(
        success=True,
        quota=RepositoryPollingQuotaOut(**describe_tenant_polling_quota(db, tenant_id)),
    )


@router.put(
    "/{tenant_slug}/repository-polling-quota",
    response_model=RepositoryPollingQuotaResponse,
    response_model_by_alias=True,
)
async def set_tenant_repository_polling_quota(
    tenant_slug: str,
    payload: RepositoryPollingQuotaUpdate,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> RepositoryPollingQuotaResponse:
    """Configure this tenant's repository polling quota (REPO-4.6, #2784).

    Persists ``tenants.repository_polls_per_hour``, which the scheduler reads once per tick.
    ``0`` marks the tenant unlimited. The change takes effect on the next sweep tick; it does
    not retroactively release repositories already deferred in the current one, and it never
    touches any repository's failure bookkeeping.

    Args:
        tenant_slug: Tenant slug from the path (scoping comes from the token).
        payload: The new quota.
        auth_data: Authenticated principal; supplies the tenant scope.

    Returns:
        The tenant's quota projection after the update.

    Raises:
        HTTPException: 404 when the authenticated tenant no longer exists.
    """
    enforce_permission(db, auth_data, Resource.IMPORTS, Action.EDIT)
    _ = tenant_slug
    tenant_id = str(auth_data["tenant_id"])

    stored = db.set_tenant_repository_polls_per_hour(tenant_id, payload.polls_per_hour)
    if stored is None:
        raise HTTPException(status_code=404, detail="tenant not found")
    _logger.info(
        "repository polling quota updated tenant_id=%s polls_per_hour=%s",
        tenant_id,
        stored,
    )
    return RepositoryPollingQuotaResponse(
        success=True,
        quota=RepositoryPollingQuotaOut(**describe_tenant_polling_quota(db, tenant_id)),
    )


@router.get(
    "/{tenant_slug}/repository-quota-telemetry",
    response_model=RepositoryQuotaTelemetryResponse,
    response_model_by_alias=True,
)
async def get_tenant_repository_quota_telemetry(
    tenant_slug: str,
    days: int = Query(
        DEFAULT_TELEMETRY_DAYS,
        ge=1,
        le=MAX_TELEMETRY_DAYS,
        description="Trailing range to report, in days.",
    ),
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> RepositoryQuotaTelemetryResponse:
    """Report this tenant's quota and rate-limit telemetry (REPO-7.3, #2801).

    The polling quota (REPO-4.6) and the scan budget (REPO-2.5) both work silently: without
    this read, the only evidence a tenant is parked against its ceiling is a log line and a
    per-replica counter that dies with the process. This returns the durable rolling-window
    counters — polls and scan volume, with the quota's deferrals counted separately — plus
    the tenant's current quota position, so a dashboard can render "where are we right now"
    and "how did we get here" from one request.

    Every metric is present in every response, zero-filled across the whole range, so a
    tenant that has never been deferred renders a flat line rather than a missing panel. A
    counter read that fails comes back with ``available: false`` and zeros rather than an
    error, so the quota position is still answered.

    Args:
        tenant_slug: Tenant slug from the path (scoping comes from the token).
        days: Trailing range in days; defaults to 7 and is capped at 90.
        auth_data: Authenticated principal; supplies the tenant scope.

    Returns:
        The tenant's quota projection and its telemetry series.
    """
    enforce_permission(db, auth_data, Resource.IMPORTS, Action.VIEW)
    _ = tenant_slug
    tenant_id = str(auth_data["tenant_id"])
    return RepositoryQuotaTelemetryResponse(
        success=True,
        quota=RepositoryPollingQuotaOut(**describe_tenant_polling_quota(db, tenant_id)),
        telemetry=RepositoryQuotaTelemetryOut(
            **describe_quota_telemetry(db, tenant_id, days=days)
        ),
    )


@router.get("/{tenant_slug}/repositories", response_model=TenantRepositoriesListResponse)
async def list_tenant_repositories(
    tenant_slug: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> TenantRepositoriesListResponse:
    """List the tenant's registered repositories, each with its REPO-6.5 health badge.

    Args:
        tenant_slug: Tenant slug from the path (scoping comes from the token).
        auth_data: Authenticated principal; supplies the tenant scope.

    Returns:
        Every live repository for the tenant, newest registration first.
    """
    _ = tenant_slug
    tenant_id = str(auth_data["tenant_id"])
    rows = db.list_tenant_repositories(tenant_id)
    health = _repository_health_by_id(tenant_id) if rows else {}
    return TenantRepositoriesListResponse(
        success=True,
        repositories=[_row_to_record(r, health.get(str(r.get("id")))) for r in rows],
    )


@router.get(
    "/{tenant_slug}/repositories/{repository_id}",
    response_model=TenantRepositoryGetResponse,
)
async def get_tenant_repository(
    tenant_slug: str,
    repository_id: uuid.UUID,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> TenantRepositoryGetResponse:
    """Read one registered repository, with its REPO-6.5 health badge.

    Args:
        tenant_slug: Tenant slug from the path (scoping comes from the token).
        repository_id: The repository to read.
        auth_data: Authenticated principal; supplies the tenant scope.

    Returns:
        The repository record.

    Raises:
        HTTPException: 404 when the repository does not exist in this tenant.
    """
    _ = tenant_slug
    tenant_id = str(auth_data["tenant_id"])
    row = db.get_tenant_repository(tenant_id, str(repository_id))
    if not row:
        raise HTTPException(status_code=404, detail="repository not found")
    health = _repository_health_by_id(tenant_id, [str(repository_id)])
    return TenantRepositoryGetResponse(
        success=True,
        repository=_row_to_record(row, health.get(str(repository_id))),
    )


def _notification_preference_out(row: Dict[str, Any]) -> RepositoryNotificationPreferenceOut:
    """Project one described notification preference into its API model (REPO-7.2, #2800)."""
    return RepositoryNotificationPreferenceOut(
        event_type=str(row["event_type"]),
        enabled=bool(row["enabled"]),
        description=str(row["description"]),
        last_notified_at=_ts(row.get("last_notified_at")),
        suppressed_count=int(row.get("suppressed_count") or 0),
        updated_at=_ts(row.get("updated_at")),
    )


def _notification_preferences_response(
    tenant_id: str, repository_id: str
) -> RepositoryNotificationPreferencesResponse:
    """Build the preferences envelope for one repository (REPO-7.2, #2800)."""
    return RepositoryNotificationPreferencesResponse(
        success=True,
        repository_id=repository_id,
        throttle_window_seconds=DEFAULT_THROTTLE_WINDOW_SECONDS,
        preferences=[
            _notification_preference_out(row)
            for row in describe_repository_notification_preferences(
                db, tenant_id, repository_id
            )
        ],
    )


@router.get(
    "/{tenant_slug}/repositories/{repository_id}/notification-preferences",
    response_model=RepositoryNotificationPreferencesResponse,
    response_model_by_alias=True,
)
async def get_tenant_repository_notification_preferences(
    tenant_slug: str,
    repository_id: uuid.UUID,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> RepositoryNotificationPreferencesResponse:
    """Read this repository's scan/sync notification settings (REPO-7.2, #2800).

    Reports every event type REPO-7.2 defines — not only the ones an operator has already
    written a preference for — so this is the whole picture of what the repository will and
    will not tell anyone about. Each entry also carries the throttle state for that event,
    which is how "we have heard nothing" is distinguished from "we have been suppressing it".

    Args:
        tenant_slug: Tenant slug from the path (scoping comes from the token).
        repository_id: The repository to read preferences for.
        auth_data: Authenticated principal; supplies the tenant scope.

    Returns:
        One entry per event type, plus the throttle window being enforced.

    Raises:
        HTTPException: 404 when the repository does not exist in this tenant.
    """
    enforce_permission(db, auth_data, Resource.IMPORTS, Action.VIEW)
    _ = tenant_slug
    tenant_id = str(auth_data["tenant_id"])
    if not db.get_tenant_repository(tenant_id, str(repository_id)):
        raise HTTPException(status_code=404, detail="repository not found")
    return _notification_preferences_response(tenant_id, str(repository_id))


@router.put(
    "/{tenant_slug}/repositories/{repository_id}/notification-preferences",
    response_model=RepositoryNotificationPreferencesResponse,
    response_model_by_alias=True,
)
async def set_tenant_repository_notification_preferences(
    tenant_slug: str,
    repository_id: uuid.UUID,
    payload: RepositoryNotificationPreferencesUpdate,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> RepositoryNotificationPreferencesResponse:
    """Mute or restore this repository's scan/sync notifications (REPO-7.2, #2800).

    A partial update: event types the request does not mention keep whatever state they
    already had, so a client that renders fewer events than the server knows about cannot
    silently reset the rest. Unknown event types and duplicates are rejected outright rather
    than being ignored or resolved by write order — an opt-out that quietly did nothing is
    the one failure an operator would not notice until the pager went off.

    Changing a preference never touches the throttle: un-muting an event does not grant it a
    fresh slot inside a window it has already used.

    Args:
        tenant_slug: Tenant slug from the path (scoping comes from the token).
        repository_id: The repository to update preferences for.
        payload: The preference changes to apply.
        auth_data: Authenticated principal; supplies the tenant scope.

    Returns:
        Every event type's state after the update.

    Raises:
        HTTPException: 400 when an event type is unknown or repeated; 404 when the
            repository does not exist in this tenant.
    """
    enforce_permission(db, auth_data, Resource.IMPORTS, Action.EDIT)
    _ = tenant_slug
    tenant_id = str(auth_data["tenant_id"])

    seen: Dict[str, bool] = {}
    for change in payload.preferences:
        event = coerce_repository_notification_event(change.event_type)
        if event is None:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"unknown notification event type: {change.event_type!r}; "
                    f"expected one of {', '.join(ALL_REPOSITORY_NOTIFICATION_EVENTS)}"
                ),
            )
        if event.value in seen:
            raise HTTPException(
                status_code=400,
                detail=f"duplicate notification event type: {event.value}",
            )
        seen[event.value] = change.enabled

    for event_type, enabled in seen.items():
        stored = db.set_repository_notification_preference(
            tenant_id, str(repository_id), event_type, enabled
        )
        if stored is None:
            raise HTTPException(status_code=404, detail="repository not found")
        _logger.info(
            "repository notification preference updated repository_id=%s event=%s enabled=%s",
            repository_id,
            event_type,
            enabled,
        )

    return _notification_preferences_response(tenant_id, str(repository_id))


@router.get(
    "/{tenant_slug}/repositories/{repository_id}/files",
    response_model=TenantRepositoryFilesListResponse,
)
async def list_tenant_repository_files(
    tenant_slug: str,
    repository_id: uuid.UUID,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
    branch: Optional[str] = None,
    preset: Optional[str] = None,
    glob: Optional[str] = None,
    regex: Optional[str] = None,
    hide_non_importable: bool = False,
    skip_vendor: bool = True,
    include_hidden: bool = False,
    path_prefix: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
) -> TenantRepositoryFilesListResponse:
    _ = tenant_slug
    tenant_id = str(auth_data["tenant_id"])
    rid = str(repository_id)
    row = db.get_tenant_repository(tenant_id, rid)
    if not row:
        raise HTTPException(status_code=404, detail="repository not found")

    default_b = str(row.get("default_branch") or "main").strip() or "main"
    br = (branch or default_b).strip() or default_b

    rx = (regex or "").strip()
    if "\x00" in rx:
        raise HTTPException(status_code=400, detail="invalid regex")
    if len(rx) > 512:
        raise HTTPException(status_code=400, detail="regex too long")
    if rx:
        try:
            re.compile(rx)
        except re.error as exc:
            raise HTTPException(status_code=400, detail=f"invalid regex: {exc}") from exc

    likes: List[str] = []
    if not rx:
        # ``like_patterns`` are OR'd in SQL. Combining preset path patterns with user ``glob``
        # would union matches (widen), so a custom glob could never narrow results while preset
        # is ``all`` / ``openapi`` / etc. When ``glob`` is non-empty, path matching uses only
        # those fragments; preset still affects nothing for path shape (``hide_non_importable``
        # continues to restrict by detected kind when enabled).
        glob_str = (glob or "").strip()
        if glob_str:
            for piece in glob.split(","):
                g = piece.strip()
                if g:
                    likes.append(_glob_token_to_sql_like(g))
        else:
            pk = (preset or "").strip().lower()
            if pk:
                likes.extend(_preset_like_patterns(pk))

    raw = db.tenant_repository_files_stats_and_page(
        tenant_id,
        rid,
        br,
        path_regex=rx or None,
        like_patterns=likes if not rx else None,
        hide_non_importable=hide_non_importable,
        skip_vendor=skip_vendor,
        include_hidden=include_hidden,
        path_prefix=(path_prefix or "").strip() or None,
        limit=limit,
        offset=offset,
    )
    if raw is None:
        raise HTTPException(status_code=404, detail="repository not found")

    branches = db.list_tenant_repository_file_branches(tenant_id, rid)
    if default_b not in branches:
        branches = sorted(set([*branches, default_b]))

    files_out: List[TenantRepositoryFileRow] = []
    for fr in raw["rows"]:
        path = str(fr.get("path") or "")
        dk = fr.get("detected_kind")
        dk_s = str(dk) if dk is not None else None
        blob = fr.get("blob_sha")
        sz = fr.get("size_bytes")
        qscore = fr.get("quality_score")
        ref_policy, ref_unresolved = _external_ref_summary(fr.get("external_ref_warning"))
        files_out.append(
            TenantRepositoryFileRow(
                id=str(fr["id"]),
                path=path,
                name=str(fr.get("name") or ""),
                ext=str(fr["ext"]) if fr.get("ext") else None,
                size_bytes=int(sz) if isinstance(sz, int) else None,
                blob_sha=str(blob) if blob else None,
                detected_kind=dk_s,
                display_kind=_display_kind(dk_s, path),
                confidence="filename",
                # REPO-2.8: informational only. The browser renders it as a badge; nothing
                # downstream reads it as a gate.
                quality_score=int(qscore) if isinstance(qscore, int) else None,
                quality_grade=str(fr["quality_grade"]) if fr.get("quality_grade") else None,
                quality_status=str(fr["quality_status"]) if fr.get("quality_status") else None,
                quality_reason=str(fr["quality_reason"]) if fr.get("quality_reason") else None,
                # REPO-3.9: the tally only. The itemized references live on the row's
                # `external_ref_warning` JSONB so a 500-file page stays small.
                external_ref_policy=ref_policy,
                external_ref_unresolved_count=ref_unresolved,
            )
        )

    return TenantRepositoryFilesListResponse(
        branch=br,
        branches=branches,
        indexed_total=int(raw["indexed_total"]),
        match_count=int(raw["match_count"]),
        importable_match_count=int(raw["importable_match_count"]),
        limit=int(raw["limit"]),
        offset=int(raw["offset"]),
        files=files_out,
    )


def _catalog_row(raw: Dict[str, Any]) -> SpecCatalogRow:
    """Project one catalog DAO row onto its API shape.

    Args:
        raw: A row from :meth:`app.database.Database.tenant_repository_spec_catalog`.

    Returns:
        The wire model. Nullable numeric columns are coerced defensively — a row whose
        ``quality_score`` predates the REPO-2.8 column must still render.
    """
    fmt = str(raw.get("format_key") or "unclassified")
    size = raw.get("size_bytes")
    score = raw.get("quality_score")
    _, ref_unresolved = _external_ref_summary(raw.get("external_ref_warning"))
    return SpecCatalogRow(
        id=str(raw["id"]),
        repository_id=str(raw["repository_id"]),
        repository_full_name=str(raw.get("repository_full_name") or ""),
        repository_provider=str(raw.get("provider") or "github"),
        branch=str(raw.get("branch") or ""),
        path=str(raw.get("path") or ""),
        name=str(raw.get("name") or ""),
        ext=str(raw["ext"]) if raw.get("ext") else None,
        size_bytes=int(size) if isinstance(size, int) else None,
        blob_sha=str(raw["blob_sha"]) if raw.get("blob_sha") else None,
        detected_kind=str(raw["detected_kind"]) if raw.get("detected_kind") else None,
        format=fmt,
        display_kind=SPEC_FORMAT_LABELS.get(fmt, fmt),
        status=str(raw.get("status_key") or "discovered"),
        project_id=str(raw["project_id"]) if raw.get("project_id") else None,
        project_name=str(raw["project_name"]) if raw.get("project_name") else None,
        project_slug=str(raw["project_slug"]) if raw.get("project_slug") else None,
        version_id=str(raw["version_id"]) if raw.get("version_id") else None,
        last_imported_at=_ts(raw.get("last_imported_at")),
        discovered_at=_ts(raw.get("discovered_at")),
        quality_score=int(score) if isinstance(score, int) else None,
        quality_grade=str(raw["quality_grade"]) if raw.get("quality_grade") else None,
        quality_status=str(raw["quality_status"]) if raw.get("quality_status") else None,
        external_ref_unresolved_count=ref_unresolved,
    )


def _catalog_facets(raw: Dict[str, Any]) -> SpecCatalogFacets:
    """Turn the DAO's raw facet tallies into labelled filter options.

    Args:
        raw: The ``facets`` payload from the catalog DAO.

    Returns:
        The wire model. Repository and project options are already count-ordered by SQL;
        format and status options are ordered by their own module's rules.
    """
    return SpecCatalogFacets(
        formats=[SpecCatalogFacetOption(**o) for o in format_facet_options(raw["formats"])],
        statuses=[SpecCatalogFacetOption(**o) for o in status_facet_options(raw["statuses"])],
        repositories=[
            SpecCatalogFacetOption(value=o["id"], label=o["label"] or o["id"], count=o["count"])
            for o in raw["repositories"]
        ],
        projects=[
            SpecCatalogFacetOption(value=o["id"], label=o["label"] or o["id"], count=o["count"])
            for o in raw["projects"]
        ],
    )


@router.get("/{tenant_slug}/repository-files", response_model=SpecCatalogResponse)
async def list_tenant_repository_spec_catalog(
    tenant_slug: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
    q: Optional[str] = Query(
        default=None,
        description=(
            "Free-text search, matched as a case-insensitive substring against the file path, "
            "its detected kind, the repository full name and the mapped project name."
        ),
    ),
    format: Optional[str] = Query(  # noqa: A002 - the query parameter is named `format` on the wire
        default=None, description="Format family key, or `all`."
    ),
    repository_id: Optional[uuid.UUID] = Query(default=None),
    project_id: Optional[uuid.UUID] = Query(default=None),
    status: Optional[str] = Query(default=None, description="Catalog status key, or `all`."),
    importable_only: bool = Query(
        default=True,
        description="Restrict to files classified as an importable spec type.",
    ),
    all_branches: bool = Query(
        default=False,
        description=(
            "List every tracked branch. Off by default so each spec appears once, on its "
            "repository's default branch."
        ),
    ),
    sort: Optional[str] = Query(
        default=None, description="`repository` (default), `path`, `format`, `status`, `recent`."
    ),
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    include_facets: bool = Query(
        default=False,
        description=(
            "Also return the filter dropdown options. Request it once when the page mounts; "
            "paging and re-filtering do not need it."
        ),
    ),
) -> SpecCatalogResponse:
    """Tenant-wide catalog of every discovered spec across all repositories (REPO-6.4).

    The per-repository Files listing answers "what is in this repo"; this answers "where does
    this spec live" across the whole tenant. Search, filtering, ordering and pagination are all
    evaluated in SQL so the response carries only the requested page.

    Args:
        tenant_slug: Present for URL symmetry only — the tenant is always taken from the
            authenticated token, never from the path.
        auth_data: Injected auth context.
        q: Free-text search term.
        format: Format-family filter.
        repository_id: Single-repository filter.
        project_id: Filter to specs mapped or imported into one project.
        status: Derived-status filter.
        importable_only: Whether to hide indexed files that are not spec candidates.
        all_branches: Whether to list non-default branches.
        sort: Ordering key.
        limit: Page size (1..500).
        offset: Rows to skip.
        include_facets: Whether to compute filter options.

    Returns:
        One page of catalog rows plus the total and matched counts.

    Raises:
        HTTPException: 400 when a filter names an unknown format or status, or the search term
            is unusable.
    """
    _ = tenant_slug
    enforce_permission(db, auth_data, Resource.IMPORTS, Action.VIEW)
    tenant_id = str(auth_data["tenant_id"])

    try:
        term = validate_search_term(q)
        fmt = normalize_format(format)
        st = normalize_status(status)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    page = db.tenant_repository_spec_catalog(
        tenant_id,
        search=term,
        repository_id=str(repository_id) if repository_id else None,
        project_id=str(project_id) if project_id else None,
        format_key=fmt,
        status_key=st,
        importable_only=importable_only,
        all_branches=all_branches,
        sort=normalize_sort(sort),
        limit=limit,
        offset=offset,
        include_facets=include_facets,
    )

    return SpecCatalogResponse(
        success=True,
        catalog_total=int(page["catalog_total"]),
        match_count=int(page["match_count"]),
        limit=int(page["limit"]),
        offset=int(page["offset"]),
        sort=str(page["sort"]),
        specs=[_catalog_row(r) for r in page["rows"]],
        facets=_catalog_facets(page["facets"]) if page.get("facets") else None,
    )


_MAX_FILE_CONTENT_BYTES = 900_000


@router.get(
    "/{tenant_slug}/repositories/{repository_id}/files/{file_id}/content",
    response_model=TenantRepositoryFileContentResponse,
)
async def get_tenant_repository_file_content(
    tenant_slug: str,
    repository_id: uuid.UUID,
    file_id: uuid.UUID,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> TenantRepositoryFileContentResponse:
    """
    Stream file bytes from the source provider (GitHub) for one indexed ``tenant_repository_files`` row.
    """
    _ = tenant_slug
    tenant_id = str(auth_data["tenant_id"])
    rid = str(repository_id)
    fid = str(file_id)

    fr = db.get_tenant_repository_file_row(tenant_id, rid, fid)
    if not fr:
        raise HTTPException(status_code=404, detail="file not found")

    provider = str(fr.get("provider") or "").lower()
    if provider != "github":
        raise HTTPException(
            status_code=501,
            detail="file contents are only implemented for GitHub repositories in this release",
        )

    path = str(fr.get("path") or "").strip()
    branch = str(fr.get("branch") or "").strip()
    if not path or not branch:
        raise HTTPException(status_code=400, detail="indexed file row missing path or branch")

    sz = fr.get("size_bytes")
    if isinstance(sz, int) and sz > _MAX_FILE_CONTENT_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"file too large to fetch in one response ({sz} bytes; max {_MAX_FILE_CONTENT_BYTES})",
        )

    token: Optional[str] = None
    linked = fr.get("linked_account_id")
    created_by = fr.get("created_by")
    if linked and created_by:
        oauth = db.get_external_auth_provider_for_user(str(linked), str(created_by))
        if oauth and oauth.get("access_token"):
            token = str(oauth["access_token"])

    vis = str(fr.get("visibility") or "").lower()
    if vis == "private" and not token:
        raise HTTPException(
            status_code=403,
            detail="private repository requires a linked account token to read file contents",
        )

    try:
        owner, repo = _github_owner_repo(fr)
        text, truncated = fetch_github_repository_file_text(
            owner, repo, path, branch, token, max_bytes=_MAX_FILE_CONTENT_BYTES
        )
    except ValueError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except Exception as exc:
        _logger.exception("repository file content fetch failed")
        raise HTTPException(status_code=502, detail=str(exc) or "upstream error") from exc

    dk = fr.get("detected_kind")
    dk_s = str(dk) if dk is not None else None
    blob = fr.get("blob_sha")
    sz_out = int(sz) if isinstance(sz, int) else None

    actor_id = get_authenticated_user_id(auth_data)
    db.insert_workflow_audit(
        tenant_id,
        project_id=None,
        version_id=None,
        action="repository_file_open",
        outcome="success",
        actor_id=actor_id,
        detail={
            "repository_id": rid,
            "file_id": fid,
            "path": path,
            "branch": branch,
            "truncated": truncated,
        },
    )

    return TenantRepositoryFileContentResponse(
        path=path,
        branch=branch,
        display_kind=_display_kind(dk_s, path),
        confidence="filename",
        blob_sha=str(blob) if blob else None,
        size_bytes=sz_out,
        content=text,
        truncated=truncated,
    )


@router.get(
    "/{tenant_slug}/repository-imports/{import_id}/spec",
    response_model=RepositoryImportSpecRead,
)
async def read_repository_import_spec(
    tenant_slug: str,
    import_id: uuid.UUID,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
    path: Optional[str] = None,
    branch: Optional[str] = None,
) -> RepositoryImportSpecRead:
    """Read the stored import spec for an imported repository file (RAR-1.5).

    Two lookup modes share this route, mirroring the ticket's
    ``GET …/repository-imports/{id}/spec`` plus ``?path=`` variant:

    - **By import id (default).** ``import_id`` is the
      ``apiome.repository_import_spec`` row id; the spec for that file lineage is
      returned. This is the "read the spec for a file/import id" path.
    - **By path (``?path=`` present).** ``import_id`` is reinterpreted as the
      *repository* id and the latest spec for that repository / ``branch`` /
      ``path`` lineage is resolved. ``branch`` is optional: when omitted the most
      recently updated spec across branches for that path is returned.

    In both modes the lookup is scoped to the caller's tenant (from the auth
    token), so a spec belonging to another tenant returns 404 rather than
    leaking. The returned ``options`` blob is upgraded on read to the current
    envelope shape (RAR-1.4), and ``spec_schema_version`` reports that current
    version.

    Args:
        tenant_slug: Tenant slug from the path (scoping comes from the token).
        import_id: Import-spec row id, or repository id when ``path`` is given.
        auth_data: Authenticated principal; supplies the tenant scope.
        path: Repository-relative file path for the ``?path=`` lookup variant.
        branch: Optional branch filter for the ``?path=`` lookup variant.

    Returns:
        The current-shape import spec for the resolved file.

    Raises:
        HTTPException: 404 when no spec exists for the id/path within the tenant.
    """
    _ = tenant_slug
    tenant_id = str(auth_data["tenant_id"])

    if path is not None:
        path_value = path.strip()
        if not path_value:
            raise HTTPException(status_code=400, detail="path must not be empty")
        branch_value = branch.strip() if branch is not None else None
        row = db.get_repository_import_spec_by_path(
            tenant_id, str(import_id), path_value, branch_value or None
        )
    else:
        row = db.get_repository_import_spec_by_id(tenant_id, str(import_id))

    if not row:
        raise HTTPException(status_code=404, detail="import spec not found")

    return repository_import_spec_read_from_row(row)


@router.post("/{tenant_slug}/repositories", response_model=TenantRepositoryCreateResponse)
async def create_tenant_repository(
    tenant_slug: str,
    body: TenantRepositoryCreate,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> TenantRepositoryCreateResponse:
    enforce_permission(db, auth_data, Resource.IMPORTS, Action.CREATE)
    _ = tenant_slug
    tenant_id = str(auth_data["tenant_id"])
    user_id = _require_jwt_user(auth_data)

    linked_account_id: Optional[str] = None
    # Kept from the linked-account branch so the REPO-4.3 webhook provisioning below can try
    # to create the provider hook. A public-URL registration has no token and stays local.
    access_token: Optional[str] = None

    if body.source == "public_url":
        requested_clone = str(body.clone_url).strip()
        try:
            meta = validate_public_clone_url(requested_clone)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        canonical_clone = str(meta.get("canonical_clone_url") or requested_clone).strip()
    else:
        linked_id = str(body.linked_account_id).strip()
        linked_account_id = linked_id
        full_name_raw = str(body.repository_full_name).strip()
        parts = parse_owner_repo_slash(full_name_raw)
        if not parts:
            raise HTTPException(
                status_code=400,
                detail="repository_full_name must be owner/repo",
            )
        owner, repo = parts

        row_oauth = db.get_external_auth_provider_for_user(linked_id, user_id)
        if not row_oauth:
            raise HTTPException(status_code=404, detail="linked account not found for this user")
        provider = str(row_oauth.get("provider") or "").lower()
        if provider != "github":
            raise HTTPException(
                status_code=400,
                detail="linked repository registration is only supported for GitHub in this release",
            )
        token = row_oauth.get("access_token")
        if not token:
            raise HTTPException(status_code=401, detail="no access token for linked account; re-link GitHub")
        access_token = str(token)

        try:
            meta = fetch_github_repo_with_token(str(token), owner, repo)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        api_full = str(meta.get("repository_full_name") or "")
        if api_full.lower() != full_name_raw.lower():
            raise HTTPException(
                status_code=400,
                detail="repository_full_name does not match GitHub metadata for this token",
            )

        canonical_clone = str(meta.get("canonical_clone_url") or "").strip()
        if not canonical_clone:
            raise HTTPException(status_code=500, detail="GitHub response missing clone URL")

        if body.clone_url and str(body.clone_url).strip():
            req_clone = str(body.clone_url).strip()
            req_parts = parse_github_owner_repo_from_url(req_clone)
            can_parts = parse_github_owner_repo_from_url(canonical_clone)
            if req_parts and can_parts and req_parts != can_parts:
                raise HTTPException(
                    status_code=400,
                    detail="clone_url does not match the selected GitHub repository",
                )

    try:
        normalized = normalize_clone_url_for_dedup(canonical_clone)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    description = meta.get("description")
    desc_str = str(description).strip() if description is not None else None
    if desc_str == "":
        desc_str = None

    visibility = meta.get("visibility")
    vis_str = str(visibility) if visibility is not None else None

    default_branch = str(meta.get("default_branch") or "main")
    bc_raw = meta.get("branch_count")
    branch_count_i = bc_raw if isinstance(bc_raw, int) else None

    try:
        inserted = db.insert_tenant_repository(
            tenant_id=tenant_id,
            source=body.source,
            provider=str(meta.get("provider") or "github"),
            clone_url=canonical_clone,
            clone_url_normalized=normalized,
            repository_full_name=meta.get("repository_full_name"),
            description=desc_str,
            default_branch=default_branch,
            visibility=vis_str,
            status="scanning",
            created_by=user_id,
            linked_account_id=linked_account_id,
            branch_count=branch_count_i,
        )
    except pg_errors.UniqueViolation as exc:
        raise HTTPException(
            status_code=409,
            detail="this repository is already registered for this tenant",
        ) from exc

    try:
        db.enqueue_repository_file_scan_job(tenant_id, str(inserted["id"]), default_branch)
    except Exception as exc:
        _logger.warning(
            "repository registered but file scan job was not enqueued (check migration 20260501-120000): %s",
            exc,
        )

    # Webhook subscription (REPO-4.3, #2781). Provisioned here — the REPO-1.4 registration
    # path the ticket names — so a repository is ready to accept signed deliveries from the
    # moment it exists. Never fatal: a repository whose hook could not be created still syncs
    # on the RAR-3.1 polling cadence, and the subscription records why it stayed local.
    webhook = provision_repository_webhook(
        db,
        tenant_id=tenant_id,
        repository_id=str(inserted["id"]),
        provider=str(inserted.get("provider") or "github"),
        repo_full_name=inserted.get("repository_full_name"),
        access_token=access_token,
        actor_id=user_id,
    )
    if webhook.error:
        _logger.info(
            "repository webhook provisioning did not complete repository_id=%s state=%s: %s",
            inserted["id"],
            webhook.state,
            webhook.error,
        )

    record = _row_to_record(inserted)
    return TenantRepositoryCreateResponse(success=True, repository=record)


@router.patch(
    "/{tenant_slug}/repositories/{repository_id}",
    response_model=TenantRepositoryGetResponse,
)
async def update_tenant_repository(
    tenant_slug: str,
    repository_id: uuid.UUID,
    payload: TenantRepositoryUpdate,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> TenantRepositoryGetResponse:
    """Patch mutable repository settings (RAR-3.3 auto-refresh toggle, #3524).

    Applies only the fields present in the request body. Currently the per-repo
    ``auto_refresh_enabled`` opt-out: when set to False the auto-refresh sweep skips
    this repository (manual "Refresh Now" is unaffected). Returns the updated
    repository record. 404 when the repository does not belong to the tenant.
    """
    enforce_permission(db, auth_data, Resource.IMPORTS, Action.EDIT)
    _ = tenant_slug
    tenant_id = str(auth_data["tenant_id"])
    rid = str(repository_id)

    if payload.auto_refresh_enabled is not None:
        updated = db.set_repository_auto_refresh_enabled(
            tenant_id, rid, payload.auto_refresh_enabled
        )
        if updated is None:
            raise HTTPException(status_code=404, detail="repository not found")

    row = db.get_tenant_repository(tenant_id, rid)
    if not row:
        raise HTTPException(status_code=404, detail="repository not found")
    health = _repository_health_by_id(tenant_id, [rid])
    return TenantRepositoryGetResponse(
        success=True, repository=_row_to_record(row, health.get(rid))
    )


@router.post(
    "/{tenant_slug}/repositories/{repository_id}/refresh/resume",
    response_model=TenantRepositoryGetResponse,
)
async def resume_tenant_repository_refresh(
    tenant_slug: str,
    repository_id: uuid.UUID,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> TenantRepositoryGetResponse:
    """Manually resume a repository whose auto-refresh was paused (RAR-3.4, #3525).

    A repository auto-pauses after ``APIOME_REFRESH_AUTO_PAUSE_THRESHOLD``
    consecutive refresh failures (extending REPO-4.5 to the refresh loop). This
    clears the pause and resets the failure counter and backoff anchor, so the
    repository is immediately eligible for the sweep again on its normal cadence.
    Safe to call on a repository that is not paused (it just resets the failure
    bookkeeping). Returns the updated repository record.

    Args:
        tenant_slug: Tenant slug from the path (scoping comes from the token).
        repository_id: The repository to resume.
        auth_data: Authenticated principal; supplies the tenant scope.

    Returns:
        The updated repository record (pause fields cleared).

    Raises:
        HTTPException: 404 when the repository does not belong to the tenant.
    """
    enforce_permission(db, auth_data, Resource.IMPORTS, Action.EDIT)
    _ = tenant_slug
    tenant_id = str(auth_data["tenant_id"])
    rid = str(repository_id)

    resumed = db.resume_repository_refresh(tenant_id, rid)
    if resumed is None:
        raise HTTPException(status_code=404, detail="repository not found")
    if resumed.get("was_paused"):
        _logger.info(
            "repository auto-refresh manually resumed repository_id=%s tenant_id=%s",
            rid,
            tenant_id,
        )

    row = db.get_tenant_repository(tenant_id, rid)
    if not row:
        raise HTTPException(status_code=404, detail="repository not found")
    health = _repository_health_by_id(tenant_id, [rid])
    return TenantRepositoryGetResponse(
        success=True, repository=_row_to_record(row, health.get(rid))
    )


@router.get(
    "/{tenant_slug}/repositories/{repository_id}/webhook",
    response_model=RepositoryWebhookStatusResponse,
    response_model_by_alias=True,
)
async def get_tenant_repository_webhook(
    tenant_slug: str,
    repository_id: uuid.UUID,
    limit: int = Query(
        default=20, ge=1, le=200, description="Maximum recent deliveries to return."
    ),
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> RepositoryWebhookStatusResponse:
    """Report a repository's webhook subscription and its recent deliveries (REPO-4.3, #2781).

    This is how an operator answers "is the hook actually firing, and is the provider holding
    the secret I think it is". The **signing secret is never part of this response** — the
    projection is built by :func:`repository_webhook_subscriptions.describe_subscription`
    from an explicit field list, and the underlying read does not even select the ciphertext
    column. What is returned is a truncated fingerprint of the secret, which confirms
    identity without revealing it.

    A repository registered before this feature — or one whose provisioning could not store a
    subscription — reports ``subscription: null`` rather than an error: it simply has no
    webhook, and still syncs on its polling cadence.

    Args:
        tenant_slug: Tenant slug from the path (scoping comes from the token).
        repository_id: The repository to report on.
        limit: How many recent deliveries to include.
        auth_data: Authenticated principal; supplies the tenant scope.

    Returns:
        The subscription projection (or ``None``) plus the recent delivery ledger.

    Raises:
        HTTPException: 404 when the repository does not belong to the tenant.
    """
    enforce_permission(db, auth_data, Resource.IMPORTS, Action.VIEW)
    _ = tenant_slug
    tenant_id = str(auth_data["tenant_id"])
    rid = str(repository_id)

    if not db.get_tenant_repository(tenant_id, rid):
        raise HTTPException(status_code=404, detail="repository not found")

    row = db.get_repository_webhook_subscription(tenant_id, rid)
    projection = describe_subscription(row)
    events = db.list_repository_webhook_events(tenant_id, rid, limit)

    return RepositoryWebhookStatusResponse(
        success=True,
        subscription=(
            RepositoryWebhookSubscriptionOut(**projection) if projection else None
        ),
        events=[
            RepositoryWebhookEventOut(
                id=str(e["id"]),
                provider=str(e.get("provider") or ""),
                delivery_id=e.get("delivery_id"),
                event_type=e.get("event_type"),
                action=e.get("action"),
                branch=e.get("branch"),
                head_sha=e.get("head_sha"),
                pr_number=e.get("pr_number"),
                outcome=str(e.get("outcome") or ""),
                reason=e.get("reason"),
                jobs_enqueued=int(e.get("jobs_enqueued") or 0),
                received_at=_ts(e.get("received_at")),
            )
            for e in events
        ],
    )


@router.post(
    "/{tenant_slug}/repositories/{repository_id}/webhook/rotate",
    response_model=RepositoryWebhookRotateResponse,
    response_model_by_alias=True,
)
async def rotate_tenant_repository_webhook_secret(
    tenant_slug: str,
    repository_id: uuid.UUID,
    payload: RepositoryWebhookRotateRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> RepositoryWebhookRotateResponse:
    """Rotate a repository's webhook signing secret (REPO-4.7, #2785).

    Mints a new secret, keeps the outgoing one verifying for a grace window (24h by default),
    and updates the provider's hook to the new secret. The old secret expires on its own — the
    background sweep retires it when the window closes, and keeps retrying the provider update
    until then.

    **No secret is returned**, new or old. There is nothing for an operator to copy: when the
    provider hook is ours to edit we edit it, and when it is not (``providerSecretSynced``
    false) the rotation is recorded with the reason so it can be repaired at the provider.
    The response carries fingerprints and a deadline, which is what an operator actually needs
    to answer "which secret is where, and how long do I have".

    A rotation that reached the store is a success even when the provider could not be
    updated: the new secret exists, the old one still works, and rolling the store back would
    leave the tenant with an unchanged, aging secret and no record that anybody tried.
    ``providerSecretSynced`` is where that distinction lives, not the status code.

    Args:
        tenant_slug: Tenant slug from the path (scoping comes from the token).
        repository_id: The repository whose subscription to rotate.
        payload: Optional grace-window override.
        auth_data: Authenticated principal; supplies the tenant scope and the audit actor.

    Returns:
        The rotated subscription projection, the applied grace window, and whether the
        provider hook now holds the new secret.

    Raises:
        HTTPException: 404 when the repository does not belong to the tenant or has no
            webhook subscription; 409 when the deployment cannot store a rotated secret
            (no encryption key, or a subscription that never held one); 500 when the store
            refused the write.
    """
    enforce_permission(db, auth_data, Resource.IMPORTS, Action.EDIT)
    _ = tenant_slug
    tenant_id = str(auth_data["tenant_id"])
    rid = str(repository_id)

    repo_row = db.get_tenant_repository(tenant_id, rid)
    if not repo_row:
        raise HTTPException(status_code=404, detail="repository not found")

    try:
        result = rotate_repository_webhook_secret(
            db,
            tenant_id=tenant_id,
            repository_id=rid,
            grace_seconds=payload.grace_seconds,
            actor_id=get_authenticated_user_id(auth_data),
            access_token=resolve_linked_account_token(db, repo_row),
        )
    except RotationError as exc:
        status = {
            "no_subscription": 404,
            "no_encryption_key": 409,
            "no_secret_to_rotate": 409,
        }.get(exc.code, 500)
        raise HTTPException(
            status_code=status, detail={"code": exc.code, "message": str(exc)}
        ) from exc

    projection = describe_subscription(result.subscription)
    return RepositoryWebhookRotateResponse(
        success=True,
        subscription=RepositoryWebhookSubscriptionOut(**projection),
        grace_seconds=result.grace_seconds,
        provider_secret_synced=result.provider_synced,
        provider_error=result.provider_error,
    )


@router.post(
    "/{tenant_slug}/repositories/{repository_id}/refresh",
    response_model=RepositoryRefreshNowResponse,
)
async def refresh_tenant_repository_now(
    tenant_slug: str,
    repository_id: uuid.UUID,
    payload: RepositoryRefreshNowRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> RepositoryRefreshNowResponse:
    """Trigger a one-shot manual "Refresh Now" (RAR-5.2, #3533).

    Runs the same spec-faithful re-import path as the periodic sweep (RAR-4.1) for
    a single file or the whole repository, on demand. It uses the stored import
    spec (not defaults), honors the RAR-2.2 freshness gate (only files newer than
    the last import enqueue) and the RAR-4.4 divergence guard (applied downstream
    by the executor), and works even when scheduled auto-refresh is disabled —
    the cadence and the ``auto_refresh_enabled`` / kill-switch gates are
    deliberately bypassed.

    Request body (all optional): ``path`` for a single file, ``branch`` to scope a
    branch; omit both to refresh every branch that has a stored spec.

    Args:
        tenant_slug: Tenant slug from the path (scoping comes from the token).
        repository_id: The repository to refresh.
        payload: Optional ``path`` / ``branch`` selectors.
        auth_data: Authenticated principal; supplies the tenant scope.

    Returns:
        Counts of jobs enqueued / skipped and the branches evaluated.

    Raises:
        HTTPException: 404 when the repository does not belong to the tenant.
    """
    enforce_permission(db, auth_data, Resource.IMPORTS, Action.EDIT)
    _ = tenant_slug
    tenant_id = str(auth_data["tenant_id"])

    path_value = payload.path.strip() if payload.path else None
    branch_value = payload.branch.strip() if payload.branch else None

    from .repository_manual_refresh import refresh_repository_now

    result = refresh_repository_now(
        db,
        tenant_id=tenant_id,
        repository_id=str(repository_id),
        branch=branch_value or None,
        path=path_value or None,
    )
    if result is None:
        raise HTTPException(status_code=404, detail="repository not found")

    return RepositoryRefreshNowResponse(
        success=True,
        enqueued=result.enqueued,
        skipped=result.skipped,
        branches=result.branches,
    )


_REFRESH_HISTORY_MAX_LIMIT = 200
_REFRESH_HISTORY_DEFAULT_LIMIT = 50


def _parse_history_datetime(label: str, raw: Optional[str]) -> Optional[datetime]:
    """Parse an inclusive ISO-8601 bound, assuming UTC when no offset is given."""
    if raw is None or str(raw).strip() == "":
        return None
    s = str(raw).strip().replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(s)
    except ValueError as e:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid {label}: expected ISO 8601 datetime ({e})",
        ) from e
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _normalize_enum_filter(
    label: str, raw: Optional[str], enum_cls
) -> Optional[str]:
    """Validate an optional enum-valued filter against its allowed wire codes."""
    if raw is None or str(raw).strip() == "":
        return None
    value = str(raw).strip()
    allowed = {m.value for m in enum_cls}
    if value not in allowed:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid {label}: expected one of {sorted(allowed)}",
        )
    return value


def _refresh_audit_row_to_entry(row: Dict[str, Any]) -> RefreshHistoryEntryOut:
    """Project one ``apiome.workflow_audit`` refresh-cycle row to the wire entry."""
    detail = row.get("detail")
    if not isinstance(detail, dict):
        detail = {}
    ca = row.get("created_at")
    if hasattr(ca, "isoformat"):
        ca_s = ca.isoformat()
    elif ca is None:
        ca_s = ""
    else:
        ca_s = str(ca)
    return RefreshHistoryEntryOut(
        id=str(row["id"]),
        repository_id=detail.get("repositoryId"),
        branch=detail.get("branch"),
        path=detail.get("path"),
        trigger=detail.get("trigger"),
        decision=detail.get("decision"),
        outcome=detail.get("outcome"),
        project_id=str(row["project_id"]) if row.get("project_id") is not None else None,
        version_id=detail.get("versionId")
        or (str(row["version_id"]) if row.get("version_id") is not None else None),
        parent_version_id=detail.get("parentVersionId"),
        change_report_id=detail.get("changeReportId"),
        source_commit_sha=detail.get("sourceCommitSha"),
        actor_id=str(row["actor_id"]) if row.get("actor_id") is not None else None,
        detail=detail or None,
        created_at=ca_s,
    )


@router.get(
    "/{tenant_slug}/repositories/{repository_id}/refresh-history",
    response_model=RefreshHistoryPageResponse,
    response_model_by_alias=True,
)
async def list_repository_refresh_history(
    tenant_slug: str,
    repository_id: uuid.UUID,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
    path: Optional[str] = Query(
        None,
        description="Restrict to a single imported file (per-file history).",
    ),
    branch: Optional[str] = Query(
        None,
        description="Restrict to a single branch.",
    ),
    trigger: Optional[str] = Query(
        None,
        description="Filter by trigger: scheduled | manual | webhook.",
    ),
    outcome: Optional[str] = Query(
        None,
        description="Filter by outcome: new-version | unchanged | diverged | failed.",
    ),
    since: Optional[str] = Query(
        None,
        description="Inclusive lower bound on createdAt (ISO 8601).",
    ),
    until: Optional[str] = Query(
        None,
        description="Inclusive upper bound on createdAt (ISO 8601).",
    ),
    limit: int = Query(_REFRESH_HISTORY_DEFAULT_LIMIT, ge=1, le=_REFRESH_HISTORY_MAX_LIMIT),
    offset: int = Query(0, ge=0),
) -> RefreshHistoryPageResponse:
    """List refresh-cycle audit history for a repository (RAR-5.3, #3534).

    Each refresh cycle records who/what triggered it, the freshness decision, the
    outcome (new-version / unchanged / diverged / failed), and the change-report and
    version links. The history is queryable **per repo** (this endpoint) and **per
    file** (add ``?path=``). Newest first.

    Args:
        tenant_slug: Tenant slug from the path (scoping comes from the token).
        repository_id: The repository whose refresh history to list.
        path: Optional file path for per-file history.
        branch: Optional branch scope.
        trigger: Optional trigger filter.
        outcome: Optional outcome filter.
        since: Optional inclusive ISO-8601 lower bound on ``createdAt``.
        until: Optional inclusive ISO-8601 upper bound on ``createdAt``.
        limit: Page size (1..200).
        offset: Page offset.

    Returns:
        A paginated, newest-first page of refresh-cycle entries.

    Raises:
        HTTPException: 404 when the repository does not belong to the tenant.
    """
    _ = tenant_slug
    tenant_id = str(auth_data["tenant_id"])
    rid = str(repository_id)

    if not db.get_tenant_repository(tenant_id, rid):
        raise HTTPException(status_code=404, detail="repository not found")

    trigger_f = _normalize_enum_filter("trigger", trigger, RefreshTrigger)
    outcome_f = _normalize_enum_filter("outcome", outcome, RefreshOutcome)
    path_f = path.strip() if path and path.strip() else None
    branch_f = branch.strip() if branch and branch.strip() else None
    since_dt = _parse_history_datetime("since", since)
    until_dt = _parse_history_datetime("until", until)

    total = db.count_repository_refresh_audit(
        tenant_id,
        repository_id=rid,
        branch=branch_f,
        path=path_f,
        trigger=trigger_f,
        outcome=outcome_f,
        since=since_dt,
        until=until_dt,
    )
    rows = db.search_repository_refresh_audit(
        tenant_id,
        repository_id=rid,
        branch=branch_f,
        path=path_f,
        trigger=trigger_f,
        outcome=outcome_f,
        since=since_dt,
        until=until_dt,
        limit=limit,
        offset=offset,
    )

    has_more = offset + len(rows) < total
    next_offset = (offset + len(rows)) if has_more else None
    pagination = RefreshHistoryPaginationOut(
        limit=limit,
        total=total,
        offset=offset,
        has_more=has_more,
        next_offset=next_offset,
    )
    items = [_refresh_audit_row_to_entry(r) for r in rows]
    return RefreshHistoryPageResponse(items=items, pagination=pagination)


@router.delete("/{tenant_slug}/repositories/{repository_id}")
async def delete_tenant_repository(
    tenant_slug: str,
    repository_id: uuid.UUID,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> Dict[str, bool]:
    enforce_permission(db, auth_data, Resource.IMPORTS, Action.DELETE)
    _ = tenant_slug
    tenant_id = str(auth_data["tenant_id"])
    if not db.delete_tenant_repository(tenant_id, str(repository_id)):
        raise HTTPException(status_code=404, detail="repository not found")
    return {"success": True}
