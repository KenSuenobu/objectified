"""
Tenant Git repositories: list and register (dashboard).

POST requires JWT so we can verify linked GitHub accounts via ``external_auth_providers``.
"""

from __future__ import annotations

import logging
import re
import uuid
from typing import Any, Dict, List, Optional

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
    RepositoryImportSpecRead,
    repository_import_spec_read_from_row,
    RepositoryRefreshNowRequest,
    RepositoryRefreshNowResponse,
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
from .repository_refresh_audit import RefreshOutcome, RefreshTrigger
from .repository_file_scan import _github_owner_repo, fetch_github_repository_file_text
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


def _row_to_record(row: Dict[str, Any]) -> TenantRepositoryRecord:
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


@router.get("/{tenant_slug}/repositories", response_model=TenantRepositoriesListResponse)
async def list_tenant_repositories(
    tenant_slug: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> TenantRepositoriesListResponse:
    _ = tenant_slug
    tenant_id = str(auth_data["tenant_id"])
    rows = db.list_tenant_repositories(tenant_id)
    return TenantRepositoriesListResponse(
        success=True,
        repositories=[_row_to_record(r) for r in rows],
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
    _ = tenant_slug
    tenant_id = str(auth_data["tenant_id"])
    row = db.get_tenant_repository(tenant_id, str(repository_id))
    if not row:
        raise HTTPException(status_code=404, detail="repository not found")
    return TenantRepositoryGetResponse(success=True, repository=_row_to_record(row))


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
    return TenantRepositoryGetResponse(success=True, repository=_row_to_record(row))


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
