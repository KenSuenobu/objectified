"""
Versions API Routes

Provides CRUD endpoints for managing versions within projects.
All endpoints are tenant and project-scoped and require authentication via JWT token or API key.
"""

import logging
import re
from datetime import date as date_cls
from datetime import datetime, timezone
from typing import Any, Dict, List, Literal, Optional
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from fastapi import APIRouter, BackgroundTasks, Body, Depends, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse, RedirectResponse

from .auth import get_authenticated_user_id, validate_authentication
from .branch_push_policy import effective_require_merge_path
from .breaking_publish_guardrail import assess_breaking_publish
from .compatibility_engine import CompatibilityCheckEngine, compat_audit_detail, openapi_for_revision
from .config import settings
from .database import BranchNotFoundError, StaleHeadPushError, db
from .mock_bundle import BundleIdentity, build_bundle
from .mock_callbacks import (
    callback_digests,
    callbacks_from_storage,
    callbacks_to_storage,
    validate_mock_callbacks,
)
from .mock_capture import (
    MAX_AUTHORIZATION_HOURS,
    authorization_block,
    canonical_capture_policy,
    capture_authorization_state,
    capture_policy_digest,
    capture_policy_from_storage,
    capture_policy_to_storage,
    fixture_pack_from_captures,
    validate_capture_policy,
)
from .mock_fixture_packs import (
    PACK_NAME_PATTERN,
    canonical_pack_provenance,
    fixture_pack_digest,
    fixture_pack_digests,
    fixture_packs_from_storage,
    fixture_packs_to_storage,
    validate_fixture_packs,
)
from .mock_scenario_settings import (
    chaos_from_storage,
    chaos_to_storage,
    scenarios_from_storage,
    scenarios_to_storage,
    validate_mock_chaos,
    validate_mock_scenarios,
)
from .models import (
    BreakingPublishGuardrailOut,
    MockCapturePolicySpec,
    MockCaptureSummary,
    MockChaosSpec,
    MockCallbackSpec,
    MockFixturePackProvenanceSpec,
    MockFixturePackSpec,
    MockScenarioSpec,
    SunsetTimelineEntryOut,
    SunsetTimelineResponse,
    VersionCreateRequest,
    VersionForkRequest,
    VersionMockCallbacksRequest,
    VersionMockCallbacksResponse,
    VersionMockCapturePolicyRequest,
    VersionMockCapturePolicyResponse,
    VersionMockCapturePublishRequest,
    VersionMockCapturePublishResponse,
    VersionMockCaptureReviewRequest,
    VersionMockCaptureReviewResponse,
    VersionMockCapturesResponse,
    VersionMockFixturePacksRequest,
    VersionMockFixturePacksResponse,
    VersionMockScenariosRequest,
    VersionMockScenariosResponse,
    VersionMockToggleRequest,
    VersionPublishRequest,
    VersionSchema,
    VersionUpdateRequest,
)
from .openapi_generator import generate_openapi_spec
from .publication_change_report import (
    generate_change_report_on_publish,
    validate_manual_baseline_revision,
)
from .publication_changelog import generate_version_changelog_on_publish
from .publish_notifications import notify_version_published_on_publish
from .permissions import enforce_permission, Resource, Action
from .published_immutability import IMMUTABLE_DETAIL, revision_is_published_immutable
from .revision_deprecation import (
    coerce_metadata,
    parse_calendar_date,
    sunset_timeline_fields,
    warnings_for_revision,
)
from .revision_lifecycle import (
    LIFECYCLE_ARCHIVED,
    LIFECYCLE_VALUES,
    effective_lifecycle,
)
from .schema_compatibility import CompatibilityRules
from .version_notes import (
    CommitPolicyViolation,
    commit_policy_http_exception,
    effective_commit_policy,
    enforce_max_commit_payload,
    validate_version_notes,
)
from .version_publish_prechecks import enforce_publish_prechecks
from .version_pull_delta import SCHEMA_PULL_DELTA_GUARANTEE, build_schema_pull_delta
from .version_pull_payload import filter_version_pull_dump, resolve_pull_sections
from .version_quality_capture import capture_version_quality_score

from .mock_settings_util import is_private_mock_mode

router = APIRouter(prefix="/v1/versions", tags=["versions"])

logger = logging.getLogger(__name__)


_DEFAULT_COMMIT_METADATA_MAX_CHARS = 10_000
_AUTHOR_OR_REF_MAX_CHARS = 500


def _mock_base_url(
    tenant_slug: str,
    project_slug: Optional[str],
    version_label: Optional[str],
    *,
    mock_enabled: bool,
    published: bool,
    mock_private: bool = False,
) -> Optional[str]:
    if not mock_enabled or not project_slug or not version_label:
        return None
    if not published and not mock_private:
        return None
    return f"{settings.mock_public_base_url.rstrip('/')}/{tenant_slug}/{project_slug}/{version_label}"


def _version_schema_response(version_row: Dict[str, Any], tenant_slug: str) -> VersionSchema:
    row = dict(version_row)
    published = bool(row.get("published"))
    mock_private = is_private_mock_mode(row.get("mock_settings"), published=published)
    row["mock_private"] = mock_private
    row["mock_base_url"] = _mock_base_url(
        tenant_slug,
        row.get("project_slug"),
        row.get("version_id"),
        mock_enabled=bool(row.get("mock_enabled")),
        published=published,
        mock_private=mock_private,
    )
    return VersionSchema(**row)


def _optional_commit_metadata_str(
    value: Optional[str],
    *,
    field_name: str = "value",
    max_length: int = _DEFAULT_COMMIT_METADATA_MAX_CHARS,
) -> Optional[str]:
    """Normalize optional commit metadata and reject overlong values (#2563)."""
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    if len(s) > max_length:
        raise HTTPException(
            status_code=400,
            detail=f"{field_name} must be at most {max_length} characters",
        )
    return s


_SUCCESSOR_RESOLUTION_DESC = (
    "none: return the requested revision only. "
    "resolve: follow metadata.successorRevisionId (same project, #748); JSON body is the final revision; "
    "see X-Apiome-* response headers. "
    "redirect: HTTP 307 to this path with the final revision id and successorResolution=none."
)


def _successor_resolution_headers(
    *,
    requested_id: str,
    final_id: str,
    hops: List[str],
    status: str,
    missing_id: Optional[str],
) -> Dict[str, str]:
    h: Dict[str, str] = {"X-Apiome-Successor-Resolution-Status": status}
    if requested_id != final_id:
        h["X-Apiome-Resolved-From"] = requested_id
    if hops:
        h["X-Apiome-Successor-Chain"] = ",".join(hops)
    if missing_id:
        h["X-Apiome-Missing-Successor-Id"] = missing_id
    return h


def _strong_etag_for_revision(revision_id: str) -> str:
    """Strong ETag for conditional GET (P0-06); value is the revision id (same as push head identity)."""
    return f'"{str(revision_id).strip()}"'


def _if_none_match_matches_revision(revision_id: str, if_none_match: Optional[str]) -> bool:
    """
    True when If-None-Match lists this revision's strong ETag, or when the
    header value is ``*``.  Per RFC 9110 §13.1.2, ``*`` on a GET/HEAD request
    matches any current representation of the resource, so a 304 is
    appropriate whenever the resource exists.
    """
    if not if_none_match or not str(if_none_match).strip():
        return False
    header = str(if_none_match).strip()
    if header == "*":
        return True
    rid = str(revision_id).strip().lower()
    for raw in header.split(","):
        token = raw.strip()
        if not token:
            continue
        if token == "*":
            return True
        if token.startswith("W/"):
            token = token[2:].strip()
        if len(token) >= 2 and token[0] == '"' and token[-1] == '"':
            token = token[1:-1]
        if token.strip().lower() == rid:
            return True
    return False


def _not_modified_revision_response(
    *,
    revision_id: str,
    extra_headers: Optional[Dict[str, str]] = None,
) -> Response:
    headers: Dict[str, str] = {"ETag": _strong_etag_for_revision(revision_id)}
    if extra_headers:
        headers.update(extra_headers)
    return Response(status_code=304, headers=headers)


def _optional_since_revision_query(raw: Optional[str]) -> Optional[str]:
    if raw is None:
        return None
    s = str(raw).strip()
    return s or None


def _redirect_successor_resolution_none(request: Request, *, new_path: str) -> RedirectResponse:
    """307 with ``successorResolution=none``, preserving other query params (e.g. pull sections, #2591)."""
    p = urlparse(str(request.url))
    q = [
        (key, value)
        for key, value in parse_qsl(p.query, keep_blank_values=True)
        if key != "successorResolution"
    ]
    q.append(("successorResolution", "none"))
    loc = urlunparse((p.scheme, p.netloc, new_path, p.params, urlencode(q, doseq=True), p.fragment))
    return RedirectResponse(loc, status_code=307)


def _validated_since_row_for_schema_pull_delta(
    since_revision_id: str,
    *,
    head_revision_id: str,
    project_id: str,
    tenant_id: str,
) -> Dict[str, Any]:
    """Ensure since revision exists, matches project, and lies on the ancestor walk to head (#2592)."""
    row = db.get_version_by_id(since_revision_id, tenant_id)
    if not row:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "UNKNOWN_REVISION_ID",
                "message": f"No revision exists for sinceRevisionId {since_revision_id!r}.",
                "sinceRevisionId": since_revision_id,
            },
        )
    if str(row["project_id"]) != str(project_id):
        raise HTTPException(
            status_code=400,
            detail={
                "code": "REVISION_PROJECT_MISMATCH",
                "message": "sinceRevisionId belongs to a different project than this pull.",
                "sinceRevisionId": since_revision_id,
            },
        )
    ancestors = db.collect_revision_ancestors(str(head_revision_id), tenant_id)
    anc_norm = {str(a) for a in ancestors}
    if str(since_revision_id) not in anc_norm:
        raise HTTPException(
            status_code=400,
            detail={
                "code": "SINCE_NOT_ANCESTOR_OF_HEAD",
                "message": (
                    "sinceRevisionId must name the requested head revision or an ancestor in the "
                    "revision parent graph (parent_version_id / merge_parent_version_id)."
                ),
                "sinceRevisionId": since_revision_id,
                "headRevisionId": str(head_revision_id),
            },
        )
    return row


def _schema_pull_delta_for_head(
    since_revision_id: str,
    *,
    tenant_slug: str,
    tenant_id: str,
    project_id: str,
    head_row: Dict[str, Any],
    since_row: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Build ``schemaPullDelta`` for OpenAPI components.schemas between since and head."""
    if since_row is None:
        since_row = _validated_since_row_for_schema_pull_delta(
            since_revision_id,
            head_revision_id=str(head_row["id"]),
            project_id=project_id,
            tenant_id=tenant_id,
        )
    head_revision_id = str(head_row["id"])
    if str(since_row["id"]) == head_revision_id:
        return {
            "sinceRevisionId": since_revision_id,
            "headRevisionId": head_revision_id,
            "removedSchemaNames": [],
            "schemas": {},
            "guarantee": SCHEMA_PULL_DELTA_GUARANTEE,
        }
    since_spec = openapi_for_revision(since_row, tenant_slug, tenant_id)
    head_spec = openapi_for_revision(head_row, tenant_slug, tenant_id)
    return build_schema_pull_delta(
        since_spec,
        head_spec,
        since_revision_id=since_revision_id,
        head_revision_id=head_revision_id,
    )


def _version_pull_http_response(
    version_row: Dict[str, Any],
    *,
    tenant_slug: str,
    include_sections: Optional[str],
    exclude_sections: Optional[str],
    response: Response,
    etag_revision_id: str,
    schema_pull_delta: Optional[Dict[str, Any]] = None,
):
    """
    JSON body for GET version (pull). Same strong ETag as the full representation (#2568); the ETag
    identifies the revision, not the selected field set (#2591).

    When *schema_pull_delta* is set (#2592), the body is always JSON and includes ``schemaPullDelta``
    alongside the version fields (same keys as VersionSchema wire format, subject to section filters).
    """
    try:
        inc, exc = resolve_pull_sections(include_sections, exclude_sections)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    vs = _version_schema_response(version_row, tenant_slug)
    etag = _strong_etag_for_revision(etag_revision_id)
    response.headers["ETag"] = etag
    if schema_pull_delta is None and inc is None and exc is None:
        return vs
    dump = vs.model_dump(by_alias=True, mode="json")
    filtered = filter_version_pull_dump(dump, include_sections=inc, exclude_sections=exc)
    if schema_pull_delta is not None:
        filtered["schemaPullDelta"] = schema_pull_delta
    return JSONResponse(content=filtered, headers=dict(response.headers))


def _workflow_audit_push(
    tenant_id: str,
    project_id: str,
    version_id: Optional[str],
    outcome: str,
    actor_id: Optional[str],
    detail: Optional[Dict[str, Any]] = None,
) -> None:
    db.insert_workflow_audit(
        tenant_id,
        project_id,
        version_id,
        "version.push",
        outcome,
        actor_id,
        detail,
    )


def _workflow_audit_pull(
    tenant_id: str,
    project_id: str,
    version_id: Optional[str],
    outcome: str,
    actor_id: Optional[str],
    detail: Optional[Dict[str, Any]] = None,
) -> None:
    db.insert_workflow_audit(
        tenant_id,
        project_id,
        version_id,
        "version.pull",
        outcome,
        actor_id,
        detail,
    )


def parse_semantic_version(version: str) -> Optional[Dict[str, int]]:
    """Parse a semantic version string into components."""
    match = re.match(r'^(\d+)\.(\d+)\.(\d+)$', version)
    if match:
        return {
            'major': int(match.group(1)),
            'minor': int(match.group(2)),
            'patch': int(match.group(3))
        }
    return None


def bump_patch_version(version: str) -> str:
    """Increment the patch version."""
    parsed = parse_semantic_version(version)
    if parsed:
        return f"{parsed['major']}.{parsed['minor']}.{parsed['patch'] + 1}"
    return '0.1.0'


def bump_minor_version(version: str) -> str:
    """Increment the minor version and reset patch to 0."""
    parsed = parse_semantic_version(version)
    if parsed:
        return f"{parsed['major']}.{parsed['minor'] + 1}.0"
    return '0.1.0'


def _push_guard_published_immutable(
    *,
    tenant_id: str,
    project_id: str,
    parent_version_id: Optional[str],
    creator_id: Optional[str],
    override: bool,
    override_reason: Optional[str],
) -> None:
    """Block push from an immutable published tip unless tenant admin override with audit (#2586)."""
    if not parent_version_id:
        return
    base_ver = db.get_version_by_id(parent_version_id, tenant_id)
    if not base_ver or not revision_is_published_immutable(base_ver):
        return
    is_admin = bool(creator_id and db.is_user_tenant_admin(tenant_id, creator_id))
    if override and not is_admin:
        raise HTTPException(
            status_code=403,
            detail="overridePublishedImmutability requires tenant administrator",
        )
    if not (override and is_admin):
        _workflow_audit_push(
            tenant_id,
            project_id,
            parent_version_id,
            "failure",
            creator_id,
            {"httpStatus": 409, "detail": IMMUTABLE_DETAIL},
        )
        raise HTTPException(status_code=409, detail=IMMUTABLE_DETAIL)
    reason = (override_reason or "").strip() or None
    db.insert_workflow_audit(
        tenant_id,
        project_id,
        parent_version_id,
        "version.immutability_override",
        "success",
        creator_id,
        {"operation": "push", "reason": reason},
    )


def _push_stale_head_detail(*, tenant_id: str, head_revision_id: str) -> Dict[str, Any]:
    """
    409 body for optimistic push conflicts (#2566).
    P0-05 UI: read ``code`` == ``STALE_HEAD``, ``currentHeadRevisionId``, ``currentHead`` (subset).
    """
    head_ver = db.get_version_by_id(head_revision_id, tenant_id)
    out: Dict[str, Any] = {
        "message": "Branch tip does not match baseRevisionId (stale head or wrong base).",
        "code": "STALE_HEAD",
        "currentHeadRevisionId": head_revision_id,
    }
    if head_ver:
        out["currentHead"] = {
            "revisionId": str(head_ver["id"]),
            "versionId": head_ver.get("version_id"),
            "shortMessage": head_ver.get("description"),
            "createdAt": head_ver.get("created_at"),
        }
    return out


def _resolve_expected_push_head(
    project_id: str,
    tenant_id: str,
    branch_name: Optional[str],
) -> tuple[Optional[str], Optional[Dict[str, Any]]]:
    """
    Expected head revision id before push, and optional branch row to advance.
    """
    branches = db.list_version_branches_for_project(project_id, tenant_id)
    bn = (branch_name or "").strip() or None

    if bn:
        b = db.get_version_branch_by_name(project_id, tenant_id, bn)
        if not b:
            raise HTTPException(status_code=404, detail=f"Branch not found: {bn}")
        return (str(b["tip_version_id"]), b)

    n = len(branches)
    if n == 0:
        tip = db.get_latest_revision_id_for_project(project_id, tenant_id)
        return (tip, None)
    if n == 1:
        b = branches[0]
        return (str(b["tip_version_id"]), b)

    raise HTTPException(
        status_code=400,
        detail={
            "message": "branchName is required when the project has multiple branches",
            "code": "BRANCH_NAME_REQUIRED",
        },
    )


@router.get("/{tenant_slug}/sunset-timeline", response_model=SunsetTimelineResponse)
async def get_sunset_timeline(
    tenant_slug: str,
    project_id: Optional[str] = Query(None, alias="projectId"),
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> SunsetTimelineResponse:
    """
    Aggregate deprecation and sunset dates across projects (#508).
    Must be registered before ``/{tenant_slug}/{project_id}`` so ``sunset-timeline`` is not parsed as a project id.
    """
    tid = auth_data["tenant_id"]
    if project_id:
        proj = db.get_project_by_id(project_id, tid)
        if not proj:
            raise HTTPException(status_code=404, detail=f"Project not found: {project_id}")

    rows = db.list_sunset_timeline_entries(tid, project_id)
    decorated: List[tuple] = []
    for row in rows:
        meta = row.get("metadata")
        t_status, life, norm = sunset_timeline_fields(meta)
        m = coerce_metadata(meta)
        raw_msg = m.get("deprecationMessage") or m.get("message")
        msg: Optional[str] = None
        if isinstance(raw_msg, str) and raw_msg.strip():
            msg = raw_msg.strip()
        succ = m.get("successorRevisionId") or m.get("successor_revision_id")
        succ_str = succ.strip() if isinstance(succ, str) and succ.strip() else None
        warns = warnings_for_revision(
            revision_id=row["id"],
            version_label=row["version_id"],
            role="head",
            metadata=meta,
        )
        sort_date = parse_calendar_date(norm) if norm else None
        decorated.append(
            (
                sort_date or date_cls(9999, 12, 31),
                row,
                t_status,
                life,
                norm,
                msg,
                succ_str,
                warns,
            )
        )

    decorated.sort(
        key=lambda x: (x[0], (x[1].get("project_name") or ""), (x[1].get("version_id") or ""))
    )

    entries: List[SunsetTimelineEntryOut] = []
    for _, row, t_status, life, norm, msg, succ_str, warns in decorated:
        entries.append(
            SunsetTimelineEntryOut(
                revision_id=row["id"],
                project_id=row["project_id"],
                project_name=row.get("project_name"),
                project_slug=row.get("project_slug"),
                version_line=row["version_id"],
                sunset_date=norm,
                sunset_at=norm,
                timeline_status=t_status,
                lifecycle_phase=life,
                deprecation_message=msg,
                successor_revision_id=succ_str,
                published=bool(row.get("published")),
                deprecation_warnings=warns,
            )
        )

    return SunsetTimelineResponse(entries=entries)


@router.get("/{tenant_slug}/{project_id}")
async def list_versions(
    tenant_slug: str,
    project_id: str,
    lifecycle: Optional[str] = Query(
        None,
        description="Filter catalog/history by revision lifecycle tag (#739): stable, beta, deprecated, archived.",
    ),
    q: Optional[str] = Query(
        None,
        description="Search revision note, changelog, full commit message body, and commit author (case-insensitive, #2579).",
    ),
    creator_id: Optional[str] = Query(
        None,
        alias="creatorId",
        description="Filter by creator user id (#2579).",
    ),
    created_after: Optional[datetime] = Query(
        None,
        alias="createdAfter",
        description="Include revisions with created_at on or after this instant (ISO 8601, #2579).",
    ),
    created_before: Optional[datetime] = Query(
        None,
        alias="createdBefore",
        description="Include revisions with created_at on or before this instant (ISO 8601, #2579).",
    ),
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> List[VersionSchema]:
    """
    List all versions for a project.

    Supports authentication via:
    - JWT token in Authorization header (Bearer token)
    - API key in X-API-Key header

    Args:
        tenant_slug: The tenant slug
        project_id: The project ID
        auth_data: Authentication data (injected by dependency)

    Returns:
        List of versions for the project
    """
    # Verify project belongs to tenant
    project = db.get_project_by_id(project_id, auth_data['tenant_id'])
    if not project:
        raise HTTPException(
            status_code=404,
            detail=f"Project not found: {project_id}"
        )

    lc_filter: Optional[str] = None
    if lifecycle is not None and str(lifecycle).strip() != "":
        lc_norm = str(lifecycle).strip().lower()
        if lc_norm not in LIFECYCLE_VALUES:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid lifecycle filter; expected one of: {', '.join(sorted(LIFECYCLE_VALUES))}",
            )
        lc_filter = lc_norm

    mq = (q or "").strip()
    cid = (creator_id or "").strip()

    versions = db.get_versions_for_project(
        project_id,
        auth_data["tenant_id"],
        lifecycle=lc_filter,
        message_q=mq or None,
        creator_id=cid or None,
        created_after=created_after,
        created_before=created_before,
    )

    return [_version_schema_response(v, tenant_slug) for v in versions]


@router.get(
    "/{tenant_slug}/{project_id}/{version_record_id}",
    response_model=None,
    responses={
        200: {
            "model": VersionSchema,
            "description": (
                "Full VersionSchema, or JSON with includeSections/excludeSections (#2591), or JSON with "
                "schemaPullDelta when sinceRevisionId is set (#2592)."
            ),
        }
    },
)
async def get_version(
    request: Request,
    response: Response,
    tenant_slug: str,
    project_id: str,
    version_record_id: str,
    successor_resolution: Literal["none", "resolve", "redirect"] = Query(
        "none",
        alias="successorResolution",
        description=_SUCCESSOR_RESOLUTION_DESC,
    ),
    audit_successor_resolution: bool = Query(
        False,
        alias="auditSuccessorResolution",
        description="When true, emit version_protection_audit for successor resolution (#749).",
    ),
    include_sections: Optional[str] = Query(
        None,
        alias="includeSections",
        description=(
            "Comma-separated pull payload sections to include (#2591). Always includes id, "
            "project_id, and version_id. Mutually exclusive with excludeSections. "
            "Sections: core, commit, publish, lineage, governance, creator, project, timestamps."
        ),
    ),
    exclude_sections: Optional[str] = Query(
        None,
        alias="excludeSections",
        description=(
            "Comma-separated sections to omit from the pull body (#2591). Core identifiers "
            "cannot be removed. Mutually exclusive with includeSections."
        ),
    ),
    since_revision_id: Optional[str] = Query(
        None,
        alias="sinceRevisionId",
        description=(
            "When set, the JSON body includes schemaPullDelta with changed OpenAPI components.schemas "
            "entities since this revision (#2592). Must be the resolved head revision or an ancestor "
            "in the revision parent graph."
        ),
    ),
    auth_data: Dict[str, Any] = Depends(validate_authentication),
):
    """
    Get a specific version by ID.

    Supports authentication via JWT token or API key.

    Successor resolution (#749): when ``successorResolution`` is ``resolve`` or ``redirect``, follows
    ``metadata.successorRevisionId`` (#748) within the project until a revision has no successor, hits a
    protected branch tip / protected tag target (#504), or errors. Loops return 409 ``SUCCESSOR_CYCLE``.

    Pull payload selection (#2591): ``includeSections`` / ``excludeSections`` reduce JSON size for CI;
    the strong ETag still identifies the revision only (same as full body, #2568).

    Delta pull (#2592): ``sinceRevisionId`` adds ``schemaPullDelta`` (changed schema entities only).
    """
    tenant_id = auth_data["tenant_id"]
    pull_actor = get_authenticated_user_id(auth_data)
    version = db.get_version_by_id(version_record_id, tenant_id)

    if not version:
        _workflow_audit_pull(
            tenant_id,
            project_id,
            None,
            "failure",
            pull_actor,
            {
                "reason": "not_found",
                "httpStatus": 404,
                "requestedRevisionId": version_record_id,
            },
        )
        raise HTTPException(
            status_code=404,
            detail=f"Version not found: {version_record_id}",
        )

    if version["project_id"] != project_id:
        _workflow_audit_pull(
            tenant_id,
            project_id,
            str(version["id"]),
            "failure",
            pull_actor,
            {
                "reason": "project_mismatch",
                "httpStatus": 404,
                "requestedProjectId": project_id,
            },
        )
        raise HTTPException(
            status_code=404,
            detail=f"Version not found in project: {project_id}",
        )

    # Validate section params early so we don't record a 200 audit that becomes a 400 (#2591).
    try:
        resolve_pull_sections(include_sections, exclude_sections)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    since_q = _optional_since_revision_query(since_revision_id)
    if_none_match = request.headers.get("if-none-match")

    if successor_resolution == "none":
        etag_id = str(version["id"])
        since_row_none = (
            _validated_since_row_for_schema_pull_delta(
                since_q,
                head_revision_id=etag_id,
                project_id=project_id,
                tenant_id=tenant_id,
            )
            if since_q
            else None
        )
        if _if_none_match_matches_revision(etag_id, if_none_match):
            _workflow_audit_pull(
                tenant_id,
                project_id,
                etag_id,
                "success",
                pull_actor,
                {"httpStatus": 304},
            )
            return _not_modified_revision_response(revision_id=etag_id)
        _workflow_audit_pull(
            tenant_id,
            project_id,
            etag_id,
            "success",
            pull_actor,
            {"httpStatus": 200},
        )
        delta_none = (
            _schema_pull_delta_for_head(
                since_q,
                tenant_slug=tenant_slug,
                tenant_id=tenant_id,
                project_id=project_id,
                head_row=version,
                since_row=since_row_none,
            )
            if since_q
            else None
        )
        return _version_pull_http_response(
            version,
            tenant_slug=tenant_slug,
            include_sections=include_sections,
            exclude_sections=exclude_sections,
            response=response,
            etag_revision_id=etag_id,
            schema_pull_delta=delta_none,
        )

    final_id, hops, status, missing_id = db.resolve_successor_revision_chain(
        version_record_id,
        auth_data["tenant_id"],
        project_id,
    )

    if status == "cycle":
        raise HTTPException(
            status_code=409,
            detail={
                "code": "SUCCESSOR_CYCLE",
                "message": "Successor chain contains a cycle",
                "chain": hops,
            },
        )

    if status == "max_hops_exceeded":
        raise HTTPException(
            status_code=409,
            detail={
                "code": "SUCCESSOR_MAX_HOPS_EXCEEDED",
                "message": "Successor chain exceeds maximum allowed hops",
                "chain": hops,
            },
        )

    if status == "project_mismatch":
        raise HTTPException(
            status_code=409,
            detail={
                "code": "SUCCESSOR_PROJECT_MISMATCH",
                "message": "Successor revision is not in this project",
            },
        )

    final_row = db.get_version_by_id(final_id, auth_data["tenant_id"])
    if not final_row:
        raise HTTPException(
            status_code=404,
            detail=f"Version not found: {final_id}",
        )

    _audit_resolution = bool(
        hops or status not in ("none", "resolved")
    )
    if audit_successor_resolution and successor_resolution != "none" and _audit_resolution:
        uid = get_authenticated_user_id(auth_data)
        db.insert_version_protection_audit(
            auth_data["tenant_id"],
            project_id,
            uid,
            "version.successor_resolution",
            "version",
            final_id,
            "allowed",
            {
                "fromRevisionId": version_record_id,
                "mode": successor_resolution,
                "chain": hops,
                "status": status,
            },
        )

    if successor_resolution == "redirect":
        if final_id == version_record_id:
            etag_id = str(version["id"])
            since_row_redir = (
                _validated_since_row_for_schema_pull_delta(
                    since_q,
                    head_revision_id=etag_id,
                    project_id=project_id,
                    tenant_id=tenant_id,
                )
                if since_q
                else None
            )
            if _if_none_match_matches_revision(etag_id, if_none_match):
                return _not_modified_revision_response(revision_id=etag_id)
            delta_redir_same = (
                _schema_pull_delta_for_head(
                    since_q,
                    tenant_slug=tenant_slug,
                    tenant_id=tenant_id,
                    project_id=project_id,
                    head_row=version,
                    since_row=since_row_redir,
                )
                if since_q
                else None
            )
            return _version_pull_http_response(
                version,
                tenant_slug=tenant_slug,
                include_sections=include_sections,
                exclude_sections=exclude_sections,
                response=response,
                etag_revision_id=etag_id,
                schema_pull_delta=delta_redir_same,
            )
        base = request.url.path.rstrip("/").rsplit("/", 1)[0]
        return _redirect_successor_resolution_none(request, new_path=f"{base}/{final_id}")

    succ_headers = _successor_resolution_headers(
        requested_id=version_record_id,
        final_id=final_id,
        hops=hops,
        status=status,
        missing_id=missing_id,
    )
    since_row_resolve = (
        _validated_since_row_for_schema_pull_delta(
            since_q,
            head_revision_id=final_id,
            project_id=project_id,
            tenant_id=tenant_id,
        )
        if since_q
        else None
    )
    if _if_none_match_matches_revision(final_id, if_none_match):
        return _not_modified_revision_response(revision_id=final_id, extra_headers=succ_headers)
    for k, v in succ_headers.items():
        response.headers[k] = v
    delta_resolve = (
        _schema_pull_delta_for_head(
            since_q,
            tenant_slug=tenant_slug,
            tenant_id=tenant_id,
            project_id=project_id,
            head_row=final_row,
            since_row=since_row_resolve,
        )
        if since_q
        else None
    )
    return _version_pull_http_response(
        final_row,
        tenant_slug=tenant_slug,
        include_sections=include_sections,
        exclude_sections=exclude_sections,
        response=response,
        etag_revision_id=final_id,
        schema_pull_delta=delta_resolve,
    )


@router.get(
    "/{tenant_slug}/{project_id}/by-version/{version_id}",
    response_model=None,
    responses={
        200: {
            "model": VersionSchema,
            "description": (
                "Full VersionSchema, or JSON with includeSections/excludeSections (#2591), or JSON with "
                "schemaPullDelta when sinceRevisionId is set (#2592)."
            ),
        }
    },
)
async def get_version_by_version_id(
    request: Request,
    response: Response,
    tenant_slug: str,
    project_id: str,
    version_id: str,
    successor_resolution: Literal["none", "resolve", "redirect"] = Query(
        "none",
        alias="successorResolution",
        description=_SUCCESSOR_RESOLUTION_DESC,
    ),
    audit_successor_resolution: bool = Query(
        False,
        alias="auditSuccessorResolution",
        description="When true, emit version_protection_audit for successor resolution (#749).",
    ),
    include_sections: Optional[str] = Query(
        None,
        alias="includeSections",
        description=(
            "Comma-separated pull payload sections to include (#2591). Always includes id, "
            "project_id, and version_id. Mutually exclusive with excludeSections. "
            "Sections: core, commit, publish, lineage, governance, creator, project, timestamps."
        ),
    ),
    exclude_sections: Optional[str] = Query(
        None,
        alias="excludeSections",
        description=(
            "Comma-separated sections to omit from the pull body (#2591). Core identifiers "
            "cannot be removed. Mutually exclusive with includeSections."
        ),
    ),
    since_revision_id: Optional[str] = Query(
        None,
        alias="sinceRevisionId",
        description=(
            "When set, the JSON body includes schemaPullDelta with changed OpenAPI components.schemas "
            "entities since this revision (#2592). Must be the resolved head revision or an ancestor "
            "in the revision parent graph."
        ),
    ),
    auth_data: Dict[str, Any] = Depends(validate_authentication),
):
    """
    Get a specific version by version ID string (e.g., '1.0.0').

    Supports authentication via JWT token or API key.
    Successor resolution (#749) matches ``GET .../{version_record_id}``.
    Pull payload selection (#2591) matches ``GET .../{version_record_id}``.
    Delta pull (#2592) matches ``GET .../{version_record_id}``.
    """
    tenant_id = auth_data["tenant_id"]
    pull_actor = get_authenticated_user_id(auth_data)
    version = db.get_version_by_version_id(project_id, version_id, tenant_id)

    if not version:
        _workflow_audit_pull(
            tenant_id,
            project_id,
            None,
            "failure",
            pull_actor,
            {
                "reason": "not_found",
                "httpStatus": 404,
                "requestedVersionLine": version_id,
            },
        )
        raise HTTPException(
            status_code=404,
            detail=f"Version '{version_id}' not found in project",
        )

    version_record_id = str(version["id"])

    # Validate section params early so we don't record a 200 audit that becomes a 400 (#2591).
    try:
        resolve_pull_sections(include_sections, exclude_sections)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    since_q = _optional_since_revision_query(since_revision_id)
    if_none_match = request.headers.get("if-none-match")

    if successor_resolution == "none":
        etag_id = str(version["id"])
        since_row_bv_none = (
            _validated_since_row_for_schema_pull_delta(
                since_q,
                head_revision_id=etag_id,
                project_id=project_id,
                tenant_id=tenant_id,
            )
            if since_q
            else None
        )
        if _if_none_match_matches_revision(etag_id, if_none_match):
            _workflow_audit_pull(
                tenant_id,
                project_id,
                etag_id,
                "success",
                pull_actor,
                {"httpStatus": 304, "byVersionLine": True},
            )
            return _not_modified_revision_response(revision_id=etag_id)
        _workflow_audit_pull(
            tenant_id,
            project_id,
            etag_id,
            "success",
            pull_actor,
            {"httpStatus": 200, "byVersionLine": True},
        )
        delta_bv_none = (
            _schema_pull_delta_for_head(
                since_q,
                tenant_slug=tenant_slug,
                tenant_id=tenant_id,
                project_id=project_id,
                head_row=version,
                since_row=since_row_bv_none,
            )
            if since_q
            else None
        )
        return _version_pull_http_response(
            version,
            tenant_slug=tenant_slug,
            include_sections=include_sections,
            exclude_sections=exclude_sections,
            response=response,
            etag_revision_id=etag_id,
            schema_pull_delta=delta_bv_none,
        )

    final_id, hops, status, missing_id = db.resolve_successor_revision_chain(
        version_record_id,
        auth_data["tenant_id"],
        project_id,
    )

    if status == "cycle":
        raise HTTPException(
            status_code=409,
            detail={
                "code": "SUCCESSOR_CYCLE",
                "message": "Successor chain contains a cycle",
                "chain": hops,
            },
        )

    if status == "max_hops_exceeded":
        raise HTTPException(
            status_code=409,
            detail={
                "code": "SUCCESSOR_MAX_HOPS_EXCEEDED",
                "message": "Successor chain exceeds maximum allowed hops",
                "chain": hops,
            },
        )

    if status == "project_mismatch":
        raise HTTPException(
            status_code=409,
            detail={
                "code": "SUCCESSOR_PROJECT_MISMATCH",
                "message": "Successor revision is not in this project",
            },
        )

    final_row = db.get_version_by_id(final_id, auth_data["tenant_id"])
    if not final_row:
        raise HTTPException(
            status_code=404,
            detail=f"Version not found: {final_id}",
        )

    _audit_resolution = bool(
        hops or status not in ("none", "resolved")
    )
    if audit_successor_resolution and successor_resolution != "none" and _audit_resolution:
        uid = get_authenticated_user_id(auth_data)
        db.insert_version_protection_audit(
            auth_data["tenant_id"],
            project_id,
            uid,
            "version.successor_resolution",
            "version",
            final_id,
            "allowed",
            {
                "fromRevisionId": version_record_id,
                "mode": successor_resolution,
                "chain": hops,
                "status": status,
            },
        )

    if successor_resolution == "redirect":
        if final_id == version_record_id:
            etag_id = str(version["id"])
            since_row_bv_redir = (
                _validated_since_row_for_schema_pull_delta(
                    since_q,
                    head_revision_id=etag_id,
                    project_id=project_id,
                    tenant_id=tenant_id,
                )
                if since_q
                else None
            )
            if _if_none_match_matches_revision(etag_id, if_none_match):
                return _not_modified_revision_response(revision_id=etag_id)
            delta_bv_redir = (
                _schema_pull_delta_for_head(
                    since_q,
                    tenant_slug=tenant_slug,
                    tenant_id=tenant_id,
                    project_id=project_id,
                    head_row=version,
                    since_row=since_row_bv_redir,
                )
                if since_q
                else None
            )
            return _version_pull_http_response(
                version,
                tenant_slug=tenant_slug,
                include_sections=include_sections,
                exclude_sections=exclude_sections,
                response=response,
                etag_revision_id=etag_id,
                schema_pull_delta=delta_bv_redir,
            )
        base = request.url.path.rstrip("/").rsplit("/", 1)[0]
        return _redirect_successor_resolution_none(
            request,
            new_path=f"{base}/{final_row['version_id']}",
        )

    succ_headers = _successor_resolution_headers(
        requested_id=version_record_id,
        final_id=final_id,
        hops=hops,
        status=status,
        missing_id=missing_id,
    )
    since_row_bv_resolve = (
        _validated_since_row_for_schema_pull_delta(
            since_q,
            head_revision_id=final_id,
            project_id=project_id,
            tenant_id=tenant_id,
        )
        if since_q
        else None
    )
    if _if_none_match_matches_revision(final_id, if_none_match):
        return _not_modified_revision_response(revision_id=final_id, extra_headers=succ_headers)
    for k, v in succ_headers.items():
        response.headers[k] = v
    delta_bv_resolve = (
        _schema_pull_delta_for_head(
            since_q,
            tenant_slug=tenant_slug,
            tenant_id=tenant_id,
            project_id=project_id,
            head_row=final_row,
            since_row=since_row_bv_resolve,
        )
        if since_q
        else None
    )
    return _version_pull_http_response(
        final_row,
        tenant_slug=tenant_slug,
        include_sections=include_sections,
        exclude_sections=exclude_sections,
        response=response,
        etag_revision_id=final_id,
        schema_pull_delta=delta_bv_resolve,
    )


@router.post("/{tenant_slug}/{project_id}")
async def create_version(
    tenant_slug: str,
    project_id: str,
    request: VersionCreateRequest,
    background_tasks: BackgroundTasks,
    auth_data: Dict[str, Any] = Depends(validate_authentication)
) -> VersionSchema:
    """
    Create a new version (push).

    Supports authentication via JWT token or API key.
    When using JWT, the creator_id field will be set to the authenticated user.

    **Optimistic locking (#2566):** ``baseRevisionId`` is required. It must match the server head
    (branch tip, or latest revision when there are no branches) before this push. If another client
    advanced the head, the API returns **409** with ``code: STALE_HEAD`` and ``currentHead`` metadata.

    If version_id is not provided, it will be auto-generated by bumping the latest version.
    Use bump_strategy='minor' for minor version bump, or 'patch' (default) for patch bump.

    If source_version_id is provided, classes will be copied from that version.

    A push is a *version change*, so the new revision's quality/lint score is captured onto its
    record after the response is sent (#5259) — the versions list then renders the badge from
    the stored score instead of linting on read.

    Args:
        tenant_slug: The tenant slug
        project_id: The project ID
        request: Version creation data
        background_tasks: FastAPI background tasks (post-response lint capture)
        auth_data: Authentication data (injected by dependency)

    Returns:
        The created version
    """
    enforce_permission(db, auth_data, Resource.VERSIONS, Action.CREATE)
    tenant_id = auth_data["tenant_id"]
    push_actor = get_authenticated_user_id(auth_data)
    # Verify project belongs to tenant
    project = db.get_project_by_id(project_id, tenant_id)
    if not project:
        _workflow_audit_push(
            tenant_id,
            project_id,
            None,
            "failure",
            push_actor,
            {"reason": "project_not_found", "httpStatus": 404},
        )
        raise HTTPException(
            status_code=404,
            detail=f"Project not found: {project_id}"
        )

    # Determine version_id
    version_id = request.version_id
    if not version_id or not version_id.strip():
        # Auto-generate by bumping latest version
        latest_version = db.get_latest_version_for_project(project_id, tenant_id)
        if latest_version:
            if request.bump_strategy == 'minor':
                version_id = bump_minor_version(latest_version)
            else:
                version_id = bump_patch_version(latest_version)
        else:
            version_id = '0.1.0'
    else:
        version_id = version_id.strip()

    # Validate semantic versioning format
    if not parse_semantic_version(version_id):
        _workflow_audit_push(
            tenant_id,
            project_id,
            None,
            "failure",
            push_actor,
            {
                "reason": "invalid_semver",
                "httpStatus": 400,
                "versionLine": version_id,
            },
        )
        raise HTTPException(
            status_code=400,
            detail="Version ID must follow semantic versioning format (e.g., 1.0.0)"
        )

    try:
        creator_id = get_authenticated_user_id(auth_data)
        if creator_id is None:
            raise HTTPException(
                status_code=400,
                detail=(
                    "Cannot resolve creator user for this tenant (versions.creator_id is required). "
                    "With API keys: apply DB migration 20260509-220000.sql, create a new key from the UI "
                    "(stores created_by_user_id), or ensure the tenant has at least one member."
                ),
            )

        limits = effective_commit_policy(tenant_id, project.get("metadata"))
        try:
            enforce_max_commit_payload(request, limits)
            sm, cl = validate_version_notes(
                request.short_message,
                request.changelog,
                limits,
                require_short_message=limits.require_short_message,
            )
        except CommitPolicyViolation as pe:
            he = commit_policy_http_exception(pe)
            _workflow_audit_push(
                tenant_id,
                project_id,
                None,
                "failure",
                creator_id,
                {"httpStatus": he.status_code, "detail": he.detail},
            )
            raise he from pe

        # Validate and normalize commit metadata before DB call so 400s surface correctly
        commit_author = _optional_commit_metadata_str(
            request.author, field_name="author", max_length=_AUTHOR_OR_REF_MAX_CHARS
        )
        commit_message = _optional_commit_metadata_str(request.message, field_name="message")
        commit_external_ref = _optional_commit_metadata_str(
            request.external_ref, field_name="externalRef", max_length=_AUTHOR_OR_REF_MAX_CHARS
        )

        base = (request.base_revision_id or "").strip()
        try:
            expected_tip, branch_row = _resolve_expected_push_head(
                project_id, tenant_id, request.branch_name
            )
        except HTTPException as he:
            _workflow_audit_push(
                tenant_id,
                project_id,
                None,
                "failure",
                creator_id,
                {"httpStatus": he.status_code, "detail": he.detail},
            )
            raise

        if expected_tip is None:
            if base:
                _workflow_audit_push(
                    tenant_id,
                    project_id,
                    None,
                    "failure",
                    creator_id,
                    {
                        "reason": "invalid_base",
                        "httpStatus": 400,
                        "detail": {
                            "message": "baseRevisionId must be empty when there is no current revision",
                            "code": "INVALID_BASE",
                        },
                    },
                )
                raise HTTPException(
                    status_code=400,
                    detail={
                        "message": "baseRevisionId must be empty when there is no current revision",
                        "code": "INVALID_BASE",
                    },
                )
            parent_version_id: Optional[str] = None
        else:
            if base != expected_tip:
                stale_detail = _push_stale_head_detail(
                    tenant_id=tenant_id, head_revision_id=expected_tip
                )
                _workflow_audit_push(
                    tenant_id,
                    project_id,
                    expected_tip,
                    "failure",
                    creator_id,
                    {"httpStatus": 409, "detail": stale_detail},
                )
                raise HTTPException(
                    status_code=409,
                    detail=stale_detail,
                )
            parent_version_id = expected_tip

        if branch_row is not None and effective_require_merge_path(
            project_metadata=project.get("metadata"),
            branch_row=branch_row,
        ):
            uid_push = creator_id
            if not uid_push or not db.is_user_tenant_admin(tenant_id, uid_push):
                bn = str(branch_row.get("name") or "")
                merge_detail: Dict[str, Any] = {
                    "message": (
                        "Direct push is not allowed for this branch; use the merge workflow "
                        "to advance the branch tip."
                    ),
                    "code": "MERGE_PATH_REQUIRED",
                    "reason": "merge_path_required",
                    "branchName": bn or None,
                }
                _workflow_audit_push(
                    tenant_id,
                    project_id,
                    str(branch_row.get("tip_version_id")) if branch_row.get("tip_version_id") else None,
                    "failure",
                    creator_id,
                    {"httpStatus": 403, "detail": merge_detail},
                )
                raise HTTPException(status_code=403, detail=merge_detail)

        _push_guard_published_immutable(
            tenant_id=tenant_id,
            project_id=project_id,
            parent_version_id=parent_version_id,
            creator_id=creator_id,
            override=bool(request.override_published_immutability),
            override_reason=request.override_reason,
        )

        copy_source_id: Optional[str] = None
        copy_warning: Optional[str] = None
        if request.source_version_id and request.source_version_id.strip():
            copy_source_id = request.source_version_id.strip()
            source_version = db.get_version_by_id(copy_source_id, tenant_id)
            if not source_version:
                copy_warning = f"Source version not found: {copy_source_id}"
                copy_source_id = None

        try:
            version, copied_count = db.create_version_push_transaction(
                project_id=project_id,
                tenant_id=tenant_id,
                creator_id=creator_id,
                version_id=version_id,
                description=sm,
                change_log=cl,
                commit_author=commit_author,
                commit_message=commit_message,
                external_ref=commit_external_ref,
                parent_version_id=parent_version_id,
                source_version_id=copy_source_id,
                branch_row=branch_row,
                client_base_revision_id=base,
                source_commit_sha=_optional_commit_metadata_str(
                    request.source_commit_sha,
                    field_name="sourceCommitSha",
                    max_length=_AUTHOR_OR_REF_MAX_CHARS,
                ),
                source_committed_at=request.source_committed_at,
            )
        except StaleHeadPushError as sh:
            stale_detail = _push_stale_head_detail(
                tenant_id=tenant_id, head_revision_id=sh.current_tip_revision_id
            )
            _workflow_audit_push(
                tenant_id,
                project_id,
                sh.current_tip_revision_id,
                "failure",
                creator_id,
                {"httpStatus": 409, "detail": stale_detail},
            )
            raise HTTPException(
                status_code=409,
                detail=stale_detail,
            ) from sh
        except BranchNotFoundError as bnf:
            _workflow_audit_push(
                tenant_id,
                project_id,
                None,
                "failure",
                creator_id,
                {
                    "httpStatus": 404,
                    "reason": "branch_not_found",
                    "branchId": bnf.branch_id,
                },
            )
            raise HTTPException(
                status_code=404,
                detail=f"Branch not found or inaccessible: {bnf.branch_id}",
            ) from bnf

        detail_ok: Dict[str, Any] = {
            "versionLine": version.get("version_id"),
            "branchName": (request.branch_name or "").strip() or None,
        }
        if copied_count > 0:
            detail_ok["copiedClasses"] = copied_count
        if copy_warning:
            detail_ok["copyWarning"] = copy_warning
        _workflow_audit_push(
            tenant_id,
            project_id,
            str(version["id"]),
            "success",
            creator_id,
            detail_ok,
        )

        if parent_version_id:
            try:
                pver = db.get_version_by_id(parent_version_id, tenant_id)
                if pver:
                    push_spec_base = openapi_for_revision(pver, tenant_slug, tenant_id)
                    push_spec_head = openapi_for_revision(version, tenant_slug, tenant_id)
                    push_cr = CompatibilityCheckEngine.run(
                        push_spec_base, push_spec_head, CompatibilityRules()
                    )
                    try:
                        db.insert_workflow_audit(
                            tenant_id,
                            project_id,
                            str(version["id"]),
                            "schema.compatibility",
                            "success",
                            creator_id,
                            compat_audit_detail(
                                pipeline="version.push",
                                base_revision_id=parent_version_id,
                                head_revision_id=str(version["id"]),
                                result=push_cr,
                            ),
                        )
                    except Exception:
                        pass
            except Exception:
                logger.warning(
                    "post-push compatibility audit failed for revision %s",
                    str(version.get("id")),
                    exc_info=True,
                )

        # #5259: lint on version change — capture the stored score for the new revision once
        # the response is sent (best-effort; never delays or fails the push).
        background_tasks.add_task(
            capture_version_quality_score, tenant_slug, tenant_id, str(version["id"])
        )

        response_data = {**version}
        if copy_warning:
            response_data["copy_warning"] = copy_warning
        elif copied_count > 0:
            response_data["copied_classes"] = copied_count

        return VersionSchema(**response_data)
    except HTTPException:
        raise
    except Exception as e:
        # Check for unique constraint violation
        if "unique constraint" in str(e).lower() or "23505" in str(e):
            _workflow_audit_push(
                tenant_id,
                project_id,
                None,
                "failure",
                push_actor,
                {
                    "httpStatus": 409,
                    "reason": "duplicate_version_line",
                    "versionLine": version_id,
                    "message": f"A version with ID '{version_id}' already exists in this project",
                },
            )
            raise HTTPException(
                status_code=409,
                detail=f"A version with ID '{version_id}' already exists in this project"
            )
        _workflow_audit_push(
            tenant_id,
            project_id,
            None,
            "failure",
            push_actor,
            {"httpStatus": 500, "reason": "unexpected_error", "message": str(e)},
        )
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/{tenant_slug}/{project_id}/fork")
async def fork_version_from_revision(
    tenant_slug: str,
    project_id: str,
    request: VersionForkRequest,
    background_tasks: BackgroundTasks,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> VersionSchema:
    """
    Fork a schema version line into this project from a source revision in another project (sandbox / provenance).

    Not the same as a named branch within one project (#500): fork is cross-project isolation with recorded lineage.
    The forked revision's quality/lint score is captured after the response is sent (#5259).
    """
    enforce_permission(db, auth_data, Resource.VERSIONS, Action.CREATE)
    target_project = db.get_project_by_id(project_id, auth_data["tenant_id"])
    if not target_project:
        raise HTTPException(status_code=404, detail=f"Project not found: {project_id}")

    src_id = (request.source_revision_id or "").strip()
    if not src_id:
        raise HTTPException(status_code=400, detail="sourceRevisionId is required")

    version_id = (request.version_id or "").strip() if request.version_id else ""
    if not version_id:
        latest_version = db.get_latest_version_for_project(project_id, auth_data["tenant_id"])
        if latest_version:
            if request.bump_strategy == "minor":
                version_id = bump_minor_version(latest_version)
            else:
                version_id = bump_patch_version(latest_version)
        else:
            version_id = "0.1.0"
    else:
        version_id = version_id.strip()

    if not parse_semantic_version(version_id):
        raise HTTPException(
            status_code=400,
            detail="Version ID must follow semantic versioning format (e.g., 1.0.0)",
        )

    creator_id = get_authenticated_user_id(auth_data)
    if not creator_id:
        raise HTTPException(status_code=403, detail="Forking requires user authentication (JWT token)")

    limits = effective_commit_policy(auth_data["tenant_id"], target_project.get("metadata"))
    try:
        enforce_max_commit_payload(request, limits)
        sm, cl = validate_version_notes(
            request.short_message,
            request.changelog,
            limits,
            require_short_message=limits.require_short_message,
        )
    except CommitPolicyViolation as pe:
        raise commit_policy_http_exception(pe) from pe

    upstream_opt = (request.upstream_project_id or "").strip() or None

    result = db.create_forked_version(
        target_project_id=project_id,
        tenant_id=auth_data["tenant_id"],
        creator_id=creator_id,
        version_id=version_id,
        description=sm,
        change_log=cl,
        source_revision_id=src_id,
        upstream_project_id=upstream_opt,
        commit_author=_optional_commit_metadata_str(
            request.author, field_name="author", max_length=_AUTHOR_OR_REF_MAX_CHARS
        ),
        commit_message=_optional_commit_metadata_str(request.message, field_name="message"),
        external_ref=_optional_commit_metadata_str(
            request.external_ref, field_name="externalRef", max_length=_AUTHOR_OR_REF_MAX_CHARS
        ),
    )

    if not result.get("success"):
        err = result.get("error", "Fork failed")
        if "different target project" in err or "Branch from here" in err:
            raise HTTPException(status_code=400, detail=err)
        if "not found" in err.lower():
            raise HTTPException(status_code=404, detail=err)
        raise HTTPException(status_code=400, detail=err)

    version = result["version"]
    # #5259: a fork is a version change — capture the stored score once the response is sent.
    background_tasks.add_task(
        capture_version_quality_score, tenant_slug, auth_data["tenant_id"], str(version["id"])
    )
    return VersionSchema(**version)


@router.put("/{tenant_slug}/{project_id}/{version_record_id}")
async def update_version(
    tenant_slug: str,
    project_id: str,
    version_record_id: str,
    request: VersionUpdateRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication)
) -> VersionSchema:
    """
    Update an existing version.

    Supports authentication via JWT token or API key.
    Published versions cannot be updated (they are frozen).

    Args:
        tenant_slug: The tenant slug
        project_id: The project ID
        version_record_id: The version record ID
        request: Version update data
        auth_data: Authentication data (injected by dependency)

    Returns:
        The updated version
    """
    enforce_permission(db, auth_data, Resource.VERSIONS, Action.EDIT)
    # Check if version exists
    existing = db.get_version_by_id(version_record_id, auth_data['tenant_id'])
    if not existing:
        raise HTTPException(
            status_code=404,
            detail=f"Version not found: {version_record_id}"
        )

    # Verify version belongs to the specified project
    if existing['project_id'] != project_id:
        raise HTTPException(
            status_code=404,
            detail=f"Version not found in project: {project_id}"
        )

    try:
        proj_row = db.get_project_by_id(project_id, auth_data["tenant_id"])
        limits = effective_commit_policy(auth_data["tenant_id"], proj_row.get("metadata") if proj_row else None)
        try:
            enforce_max_commit_payload(request, limits)
        except CommitPolicyViolation as pe:
            raise commit_policy_http_exception(pe) from pe

        existing_lc = effective_lifecycle(existing.get("metadata"))
        tenant_id = auth_data["tenant_id"]
        uid_session = get_authenticated_user_id(auth_data)
        tenant_admin = bool(uid_session and db.is_user_tenant_admin(tenant_id, uid_session))

        if existing_lc == LIFECYCLE_ARCHIVED:
            if not tenant_admin:
                raise HTTPException(
                    status_code=403,
                    detail="Archived revisions are read-only (#739). Tenant admins may update lifecycle or revision lock only.",
                )
            if request.enabled is not None and request.enabled != existing.get("enabled"):
                raise HTTPException(
                    status_code=403,
                    detail="Cannot change enabled on an archived revision.",
                )
            note_keys_block = {"short_message", "changelog"}
            if request.model_fields_set & note_keys_block:
                raise HTTPException(
                    status_code=403,
                    detail="Cannot edit version notes on an archived revision.",
                )

        updates: Dict[str, Any] = {}
        if request.enabled is not None:
            updates["enabled"] = request.enabled

        if "revision_locked" in request.model_fields_set:
            uid_lock = get_authenticated_user_id(auth_data)
            if not uid_lock or not db.is_user_tenant_admin(auth_data["tenant_id"], uid_lock):
                raise HTTPException(
                    status_code=403,
                    detail="Only tenant administrators can lock or unlock revisions",
                )
            updates["revision_locked"] = bool(request.revision_locked)

        note_keys = {"short_message", "changelog"}
        if request.model_fields_set & note_keys:
            merged_sm = existing.get("description")
            merged_cl = existing.get("change_log")
            if "short_message" in request.model_fields_set:
                merged_sm = request.short_message
            if "changelog" in request.model_fields_set:
                merged_cl = request.changelog
            try:
                merged_sm, merged_cl = validate_version_notes(
                    merged_sm,
                    merged_cl,
                    limits,
                    require_short_message=limits.require_short_message,
                )
            except CommitPolicyViolation as pe:
                raise commit_policy_http_exception(pe) from pe
            if "short_message" in request.model_fields_set:
                updates["description"] = merged_sm
            if "changelog" in request.model_fields_set:
                updates["change_log"] = merged_cl

        if "metadata" in request.model_fields_set and request.metadata is not None:
            if existing.get("published"):
                uid_meta = get_authenticated_user_id(auth_data)
                if not uid_meta or not db.is_user_tenant_admin(
                    auth_data["tenant_id"], uid_meta
                ):
                    raise HTTPException(
                        status_code=403,
                        detail="Only tenant administrators can update revision metadata on published versions",
                    )
            updates["metadata"] = request.metadata

        # Update version
        version = db.update_version(
            version_record_id,
            auth_data["tenant_id"],
            updates,
            lifecycle_admin=tenant_admin,
        )

        if not version:
            raise HTTPException(
                status_code=404,
                detail=f"Version not found: {version_record_id}"
            )

        if "revision_locked" in request.model_fields_set:
            uid_audit = get_authenticated_user_id(auth_data)
            db.insert_version_protection_audit(
                auth_data["tenant_id"],
                existing.get("project_id"),
                uid_audit,
                "version.revision_lock",
                "version",
                version_record_id,
                "policy_change",
                {"revision_locked": bool(request.revision_locked)},
            )

        return VersionSchema(**version)
    except HTTPException:
        raise
    except CommitPolicyViolation as pe:
        raise commit_policy_http_exception(pe) from pe
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve)) from ve
    except Exception as e:
        if "published" in str(e).lower() and "frozen" in str(e).lower():
            raise HTTPException(
                status_code=403,
                detail="Cannot edit a published version. Published versions are frozen."
            )
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/{tenant_slug}/{project_id}/{version_record_id}/publish")
async def publish_version(
    tenant_slug: str,
    project_id: str,
    version_record_id: str,
    background_tasks: BackgroundTasks,
    request: VersionPublishRequest = Body(default_factory=VersionPublishRequest),
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> VersionSchema:
    """
    Publish a version.

    Only the version creator or a tenant administrator can publish a version.
    Published versions are frozen and cannot be modified.

    Args:
        tenant_slug: The tenant slug
        project_id: The project ID
        version_record_id: The version record ID
        request: Optional publish options (visibility)
        auth_data: Authentication data (injected by dependency)

    Returns:
        The published version
    """
    enforce_permission(db, auth_data, Resource.VERSIONS, Action.PUBLISH)
    # Check if version exists
    existing = db.get_version_by_id(version_record_id, auth_data['tenant_id'])
    if not existing:
        raise HTTPException(
            status_code=404,
            detail=f"Version not found: {version_record_id}"
        )

    # Verify version belongs to the specified project
    if existing['project_id'] != project_id:
        raise HTTPException(
            status_code=404,
            detail=f"Version not found in project: {project_id}"
        )

    if existing.get('published'):
        raise HTTPException(
            status_code=400,
            detail="Version is already published"
        )

    proj_pub = db.get_project_by_id(project_id, auth_data["tenant_id"])

    # Non-publishable enforcement (MFI-23.8, #4017): a catalog item is the `publishable = false`
    # slice of projects (MFI-23.1) — an OpenAPI-worthy *non*-OpenAPI import that may be incomplete
    # and is therefore never a publish candidate. The "no publish" rule is enforced here in REST,
    # not merely hidden in the UI, so a direct API call against a catalog item is refused with a
    # message pointing at the only supported path to a publishable artifact: the convert-to-OpenAPI
    # flow (MFI-EPIC-22), which mints a *new* publishable Project rather than promoting this one.
    # Only an explicit `publishable = false` blocks; a missing/None/True flag publishes as before.
    if proj_pub is not None and proj_pub.get("publishable") is False:
        raise HTTPException(
            status_code=409,
            detail=(
                "This is a catalog item (a non-OpenAPI import) and cannot be published — catalog "
                "items are not publish candidates because they may be incomplete. Use the "
                "convert-to-OpenAPI flow to mint a publishable OpenAPI project from this source, "
                "then publish that project."
            ),
        )

    # Get user_id from auth data
    user_id = get_authenticated_user_id(auth_data)
    if not user_id:
        raise HTTPException(
            status_code=403,
            detail="Publishing requires user authentication (JWT token)"
        )

    visibility = request.visibility if request.visibility is not None else "private"
    if visibility not in ("public", "private"):
        visibility = "private"

    limits = effective_commit_policy(auth_data["tenant_id"], proj_pub.get("metadata") if proj_pub else None)
    try:
        enforce_max_commit_payload(request, limits)
        merged_sm = existing.get("description")
        merged_cl = existing.get("change_log")
        note_keys = {"short_message", "changelog"}
        if request.model_fields_set & note_keys:
            if "short_message" in request.model_fields_set:
                merged_sm = request.short_message
            if "changelog" in request.model_fields_set:
                merged_cl = request.changelog
        merged_sm, merged_cl = validate_version_notes(
            merged_sm,
            merged_cl,
            limits,
            require_short_message=limits.require_short_message,
        )
    except CommitPolicyViolation as pe:
        raise commit_policy_http_exception(pe) from pe

    pub_immutable = (
        request.published_immutable
        if request.published_immutable is not None
        else True
    )

    if request.change_report_baseline_mode == "manual" and request.change_report_baseline_revision_id:
        validate_manual_baseline_revision(
            auth_data["tenant_id"],
            project_id,
            version_record_id,
            request.change_report_baseline_revision_id,
        )

    precheck = enforce_publish_prechecks(
        tenant_slug=tenant_slug,
        tenant_id=auth_data["tenant_id"],
        project_id=project_id,
        existing=existing,
        request=request,
    )

    version = db.publish_version(
        version_record_id,
        auth_data["tenant_id"],
        user_id,
        visibility,
        description=merged_sm,
        change_log=merged_cl,
        published_immutable=bool(pub_immutable),
    )

    if not version:
        raise HTTPException(
            status_code=403,
            detail="Only the version creator or a tenant administrator can publish this version"
        )

    if bool(request.skip_publish_checks):
        db.insert_workflow_audit(
            auth_data["tenant_id"],
            project_id,
            version_record_id,
            "version.publish_checks_override",
            "success",
            user_id,
            {
                "reason": request.force_publish_reason,
                "visibility": visibility,
            },
        )

    _audit_breaking_publish_guardrail(
        tenant_slug=tenant_slug,
        tenant_id=auth_data["tenant_id"],
        project_id=project_id,
        version_record_id=version_record_id,
        existing=existing,
        guardrail=precheck.breaking_publish_guardrail,
        forced=bool(request.skip_publish_checks),
        force_reason=request.force_publish_reason,
        actor_id=user_id,
    )

    background_tasks.add_task(
        generate_change_report_on_publish,
        tenant_slug=tenant_slug,
        tenant_id=auth_data["tenant_id"],
        project_id=project_id,
        published_revision_id=version_record_id,
        actor_id=user_id,
        change_report_baseline_mode=request.change_report_baseline_mode,
        change_report_baseline_revision_id=request.change_report_baseline_revision_id,
    )
    background_tasks.add_task(
        generate_version_changelog_on_publish,
        tenant_slug=tenant_slug,
        tenant_id=auth_data["tenant_id"],
        project_id=project_id,
        published_revision_id=version_record_id,
        actor_id=user_id,
    )
    # Must stay after the changelog task: background tasks run in order, so the
    # webhook payload (CTG-3.3, #4477) sees the persisted version_changelogs row.
    background_tasks.add_task(
        notify_version_published_on_publish,
        tenant_id=auth_data["tenant_id"],
        project_id=project_id,
        published_revision_id=version_record_id,
        actor_id=user_id,
    )

    return VersionSchema(**version)


#: Workflow-audit action for every breaking publish the CTG-3.4 guardrail flagged.
BREAKING_PUBLISH_GUARDRAIL_AUDIT_ACTION = "version.breaking_publish_guardrail"


def _audit_breaking_publish_guardrail(
    *,
    tenant_slug: str,
    tenant_id: str,
    project_id: str,
    version_record_id: str,
    existing: Dict[str, Any],
    guardrail: Optional[Dict[str, Any]],
    forced: bool,
    force_reason: Optional[str],
    actor_id: Optional[str],
) -> None:
    """Record a flagged breaking publish in the workflow audit trail (CTG-3.4, #4478).

    Two publishes reach this point with something to record: one the guardrail *warned*
    about and let through, and one that was *forced* past a block. The forced case has no
    precheck assessment — ``skip_publish_checks`` skips the prechecks wholesale — so it is
    assessed here, which is precisely the case where an audit trail matters most.

    Args:
        tenant_slug: Tenant slug, for materializing the baseline OpenAPI.
        tenant_id: Tenant context.
        project_id: Project of the published revision.
        version_record_id: The published revision.
        existing: The revision row as it was read before publish.
        guardrail: The precheck's assessment payload, when the prechecks ran.
        forced: Whether this publish set ``skipPublishChecks``.
        force_reason: The recorded force-publish reason, when forced.
        actor_id: The publishing user.

    Returns:
        None. Best-effort: an assessment or audit fault never fails a successful publish.
    """
    try:
        payload = guardrail
        if forced:
            payload = assess_breaking_publish(
                tenant_slug=tenant_slug,
                tenant_id=tenant_id,
                project_id=project_id,
                head_version=existing,
            ).as_payload()
        if not payload or not payload.get("triggered"):
            return
        db.insert_workflow_audit(
            tenant_id,
            project_id,
            version_record_id,
            BREAKING_PUBLISH_GUARDRAIL_AUDIT_ACTION,
            "success",
            actor_id,
            {
                "action": "forced" if forced else "warned",
                "reason": force_reason if forced else None,
                "guardrail": payload,
            },
        )
    except Exception:  # noqa: BLE001 - auditing must not fail an already-successful publish
        logger.warning(
            "Failed to audit the breaking-publish guardrail for revision %s",
            version_record_id,
            exc_info=True,
        )


@router.get(
    "/{tenant_slug}/{project_id}/{version_record_id}/breaking-publish-guardrail",
    response_model=BreakingPublishGuardrailOut,
)
async def get_breaking_publish_guardrail(
    tenant_slug: str,
    project_id: str,
    version_record_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> BreakingPublishGuardrailOut:
    """
    Preflight the breaking-publish guardrail for a revision (CTG-3.4, #4478).

    What the publish dialog calls before showing Publish: it reports whether this revision
    would break consumers without a major-version bump, which changes are breaking, and
    whether the tenant's policy warns or blocks. Read-only — nothing is published or stored.

    Args:
        tenant_slug: The tenant slug
        project_id: The project ID
        version_record_id: The version record ID
        auth_data: Authentication data (injected by dependency)

    Returns:
        The guardrail assessment; ``status`` is ``unavailable`` (never an error) when the
        comparison could not be made.

    Raises:
        HTTPException: 404 when the revision does not exist in this project.
    """
    enforce_permission(db, auth_data, Resource.VERSIONS, Action.VIEW)
    existing = db.get_version_by_id(version_record_id, auth_data["tenant_id"])
    if not existing or str(existing.get("project_id")) != str(project_id):
        raise HTTPException(
            status_code=404,
            detail=f"Version not found: {version_record_id}",
        )

    assessment = assess_breaking_publish(
        tenant_slug=tenant_slug,
        tenant_id=auth_data["tenant_id"],
        project_id=project_id,
        head_version=existing,
    )
    return BreakingPublishGuardrailOut.model_validate(assessment.as_payload())


@router.put("/{tenant_slug}/{project_id}/{version_record_id}/mock")
async def set_version_mock(
    tenant_slug: str,
    project_id: str,
    version_record_id: str,
    request: VersionMockToggleRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> VersionSchema:
    """Enable or disable the hosted mock for a version (#4422 SIM-2.1, #4446 SIM-2.5)."""
    enforce_permission(db, auth_data, Resource.VERSIONS, Action.EDIT)
    existing = db.get_version_by_id(version_record_id, auth_data["tenant_id"])
    if not existing:
        raise HTTPException(status_code=404, detail=f"Version not found: {version_record_id}")
    if existing["project_id"] != project_id:
        raise HTTPException(status_code=404, detail=f"Version not found in project: {project_id}")

    user_id = get_authenticated_user_id(auth_data)
    if not user_id:
        raise HTTPException(
            status_code=403,
            detail="Mock settings require user authentication (JWT token or API key with attribution)",
        )

    updated = db.set_version_mock_enabled(
        version_record_id,
        auth_data["tenant_id"],
        user_id,
        enabled=request.enabled,
        published=bool(existing.get("published")),
    )
    if not updated:
        raise HTTPException(
            status_code=403,
            detail="Only the version creator or a tenant administrator can change mock settings",
        )
    return _version_schema_response(updated, tenant_slug)


def _generated_spec_for_version(version: Dict[str, Any], tenant_slug: str) -> Dict[str, Any]:
    """Generate the version's OpenAPI document (same path as /v1/schema) for validation."""
    classes = db.get_classes_for_version(version["id"])
    all_properties: Dict[str, List[Dict[str, Any]]] = {}
    for class_data in classes:
        all_properties[class_data["id"]] = db.get_properties_for_class(class_data["id"])
    return generate_openapi_spec(
        tenant_slug,
        str(version.get("project_slug") or version["project_id"]),
        str(version["version_id"]),
        classes,
        all_properties,
        version.get("project_description"),
        version_db_id=version["id"],
        revision_metadata=version.get("metadata"),
        project_metadata=version.get("project_metadata"),
    )


def _get_version_for_mock_scenarios(
    project_id: str, version_record_id: str, tenant_id: str
) -> Dict[str, Any]:
    """Fetch the version row for the scenario routes, 404ing on any mismatch."""
    existing = db.get_version_by_id(version_record_id, tenant_id)
    if not existing:
        raise HTTPException(status_code=404, detail=f"Version not found: {version_record_id}")
    if existing["project_id"] != project_id:
        raise HTTPException(status_code=404, detail=f"Version not found in project: {project_id}")
    return existing


def _parse_stored_chaos(mock_settings: Any, version_record_id: str) -> Optional[MockChaosSpec]:
    """Parse the stored chaos block for a response; malformed blobs are omitted (#4455 SIM-4.3)."""
    stored_chaos, _ = chaos_from_storage(mock_settings)
    if stored_chaos is None:
        return None
    try:
        return MockChaosSpec.model_validate(stored_chaos)
    except ValueError:
        # A malformed stored entry never breaks the editor; it is simply omitted
        # (the runtime skips it the same way).
        logger.warning("Skipping malformed mock chaos block on version %s", version_record_id)
        return None


@router.get("/{tenant_slug}/{project_id}/{version_record_id}/mock/scenarios")
async def get_version_mock_scenarios(
    tenant_slug: str,
    project_id: str,
    version_record_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> VersionMockScenariosResponse:
    """Return the version's mock scenario definitions (#4454 SIM-4.2)."""
    enforce_permission(db, auth_data, Resource.VERSIONS, Action.VIEW)
    existing = _get_version_for_mock_scenarios(project_id, version_record_id, auth_data["tenant_id"])

    stored, _ = scenarios_from_storage(existing.get("mock_settings"))
    scenarios: Dict[str, MockScenarioSpec] = {}
    for name, raw in stored.items():
        try:
            scenarios[name] = MockScenarioSpec.model_validate(raw)
        except ValueError:
            # A malformed stored entry never breaks the editor; it is simply omitted
            # (the runtime skips it the same way).
            logger.warning("Skipping malformed mock scenario %r on version %s", name, version_record_id)
    return VersionMockScenariosResponse(
        scenarios=scenarios,
        chaos=_parse_stored_chaos(existing.get("mock_settings"), version_record_id),
    )


@router.put("/{tenant_slug}/{project_id}/{version_record_id}/mock/scenarios")
async def set_version_mock_scenarios(
    tenant_slug: str,
    project_id: str,
    version_record_id: str,
    request: VersionMockScenariosRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> VersionMockScenariosResponse:
    """Replace the version's mock scenario definitions (#4454 SIM-4.2).

    Canned responses are validated against the version's generated OpenAPI
    document (operation exists, status defined, media type declared, body
    matches the response schema); a response may opt out with ``offSpec``.
    Definitions persist in ``versions.mock_settings`` alongside other mock
    knobs and survive publish/republish and mock toggles.

    The request also carries the version-level latency/chaos knobs (#4455
    SIM-4.3): ``chaos`` replaces the stored block, and omitting it (or
    sending ``null``) clears the stored block.
    """
    enforce_permission(db, auth_data, Resource.VERSIONS, Action.EDIT)
    existing = _get_version_for_mock_scenarios(project_id, version_record_id, auth_data["tenant_id"])

    user_id = get_authenticated_user_id(auth_data)
    if not user_id:
        raise HTTPException(
            status_code=403,
            detail="Mock settings require user authentication (JWT token or API key with attribution)",
        )

    spec = _generated_spec_for_version(existing, tenant_slug)
    errors = validate_mock_scenarios(request.scenarios, spec)
    errors.extend(validate_mock_chaos(request.chaos, spec))
    if errors:
        raise HTTPException(
            status_code=422,
            detail={"message": "Scenario definitions failed validation.", "errors": errors},
        )

    storage = scenarios_to_storage(request.scenarios)
    chaos_storage = chaos_to_storage(request.chaos) if request.chaos is not None else None
    updated = db.set_version_mock_scenarios(
        version_record_id,
        auth_data["tenant_id"],
        user_id,
        scenarios=storage,
        chaos=chaos_storage,
    )
    if not updated:
        raise HTTPException(
            status_code=403,
            detail="Only the version creator or a tenant administrator can change mock settings",
        )

    stored, _ = scenarios_from_storage(updated.get("mock_settings"))
    return VersionMockScenariosResponse(
        scenarios={name: MockScenarioSpec.model_validate(raw) for name, raw in stored.items()},
        chaos=_parse_stored_chaos(updated.get("mock_settings"), version_record_id),
    )


def _stored_fixture_packs_response(mock_settings: Any, version_record_id: str) -> VersionMockFixturePacksResponse:
    """Build the fixture-packs response from a stored ``mock_settings`` value (#4745, PMR-2.2).

    Malformed stored entries never break the editor; they are omitted (the runtime skips them
    the same way) and logged.
    """
    stored = fixture_packs_from_storage(mock_settings)
    packs: Dict[str, MockFixturePackSpec] = {}
    for name, raw in stored.items():
        try:
            packs[name] = MockFixturePackSpec.model_validate(raw)
        except ValueError:
            logger.warning("Skipping malformed mock fixture pack %r on version %s", name, version_record_id)
    return VersionMockFixturePacksResponse(
        packs=packs,
        digests=fixture_pack_digests({name: stored[name] for name in packs}),
    )


def _capture_provenance_errors(proposed: Dict[str, Any], mock_settings: Any) -> List[str]:
    """Reject hand-written claims of capture provenance on a fixture pack (#4747, PMR-2.4).

    A pack's ``provenance`` block is the answer to "where did this fixture come from", and the
    runtime reports it verbatim on every listing and reset. A ``source: capture`` block that an
    author simply typed would turn that answer into a claim, so it is only accepted when it
    matches — byte for byte, in canonical form — what publishing captures already stored under the
    same pack name. Editing a capture-derived pack through the normal editor therefore keeps its
    provenance, and minting a fresh capture claim is impossible.

    Args:
        proposed: The proposed ``{name: pack}`` mapping.
        mock_settings: The version's current raw ``mock_settings``.

    Returns:
        One error sentence per pack that claims unearned capture provenance (empty when clean).
    """
    stored = fixture_packs_from_storage(mock_settings)
    errors: List[str] = []
    for name, pack in proposed.items():
        provenance = canonical_pack_provenance(pack.get("provenance") if isinstance(pack, dict) else None)
        if provenance.get("source") != "capture":
            continue
        current = stored.get(name)
        existing_provenance = canonical_pack_provenance(
            current.get("provenance") if isinstance(current, dict) else None
        )
        if provenance != existing_provenance:
            errors.append(
                f"Pack '{name}': capture provenance cannot be set by hand. Publish reviewed "
                "captures with POST .../mock/captures/publish instead."
            )
    return errors


@router.get("/{tenant_slug}/{project_id}/{version_record_id}/mock/fixture-packs")
async def get_version_mock_fixture_packs(
    tenant_slug: str,
    project_id: str,
    version_record_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> VersionMockFixturePacksResponse:
    """Return the version's mock fixture packs and their content digests (#4745, PMR-2.2)."""
    enforce_permission(db, auth_data, Resource.VERSIONS, Action.VIEW)
    existing = _get_version_for_mock_scenarios(project_id, version_record_id, auth_data["tenant_id"])
    return _stored_fixture_packs_response(existing.get("mock_settings"), version_record_id)


@router.put("/{tenant_slug}/{project_id}/{version_record_id}/mock/fixture-packs")
async def set_version_mock_fixture_packs(
    tenant_slug: str,
    project_id: str,
    version_record_id: str,
    request: VersionMockFixturePacksRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> VersionMockFixturePacksResponse:
    """Replace the version's mock fixture packs (#4745, PMR-2.2).

    Packs are validated against the versioned fixture pack schema (format id and version, name
    shapes, collection path/resource rules, size caps) and stored canonically in
    ``versions.mock_settings`` under ``fixturePacks``, alongside the other mock knobs. The
    response echoes each pack's content digest — the identity a test asserts when it resets a
    session to the pack. An empty ``packs`` map clears them.
    """
    enforce_permission(db, auth_data, Resource.VERSIONS, Action.EDIT)
    existing = _get_version_for_mock_scenarios(project_id, version_record_id, auth_data["tenant_id"])

    user_id = get_authenticated_user_id(auth_data)
    if not user_id:
        raise HTTPException(
            status_code=403,
            detail="Mock settings require user authentication (JWT token or API key with attribution)",
        )

    proposed = {
        name: spec.model_dump(by_alias=True, exclude_none=True)
        for name, spec in request.packs.items()
    }
    errors = validate_fixture_packs(proposed)
    errors.extend(_capture_provenance_errors(proposed, existing.get("mock_settings")))
    if errors:
        raise HTTPException(
            status_code=422,
            detail={"message": "Fixture packs failed validation.", "errors": errors},
        )

    storage = fixture_packs_to_storage(proposed)
    updated = db.set_version_mock_fixture_packs(
        version_record_id,
        auth_data["tenant_id"],
        user_id,
        packs=storage,
    )
    if not updated:
        raise HTTPException(
            status_code=403,
            detail="Only the version creator or a tenant administrator can change mock settings",
        )
    return _stored_fixture_packs_response(updated.get("mock_settings"), version_record_id)


def _stored_callbacks_response(mock_settings: Any, version_record_id: str) -> VersionMockCallbacksResponse:
    """Build the callbacks response from a stored ``mock_settings`` value (#4746, PMR-2.3).

    Malformed stored entries never break the editor; they are omitted (the runtime skips them the
    same way) and logged.
    """
    stored = callbacks_from_storage(mock_settings)
    callbacks: Dict[str, MockCallbackSpec] = {}
    for name, raw in stored.items():
        try:
            callbacks[name] = MockCallbackSpec.model_validate(raw)
        except ValueError:
            logger.warning("Skipping malformed mock callback %r on version %s", name, version_record_id)
    return VersionMockCallbacksResponse(
        callbacks=callbacks,
        digests=callback_digests({name: stored[name] for name in callbacks}),
    )


@router.get("/{tenant_slug}/{project_id}/{version_record_id}/mock/callbacks")
async def get_version_mock_callbacks(
    tenant_slug: str,
    project_id: str,
    version_record_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> VersionMockCallbacksResponse:
    """Return the version's mock callback definitions and their content digests (#4746, PMR-2.3)."""
    enforce_permission(db, auth_data, Resource.VERSIONS, Action.VIEW)
    existing = _get_version_for_mock_scenarios(project_id, version_record_id, auth_data["tenant_id"])
    return _stored_callbacks_response(existing.get("mock_settings"), version_record_id)


@router.put("/{tenant_slug}/{project_id}/{version_record_id}/mock/callbacks")
async def set_version_mock_callbacks(
    tenant_slug: str,
    project_id: str,
    version_record_id: str,
    request: VersionMockCallbacksRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> VersionMockCallbacksResponse:
    """Replace the version's mock callback definitions (#4746, PMR-2.3).

    Definitions are validated against the versioned callback schema *and* against this version's
    generated OpenAPI document: a trigger must name a real operation, a ``payloadSchema`` ``$ref``
    must resolve, every destination must be a safe absolute http(s) URL, and the retry schedule
    must stay inside its cost ceiling. Valid definitions are stored canonically in
    ``versions.mock_settings`` under ``callbacks``, alongside the other mock knobs, and travel
    inside portable mock bundles. The response echoes each definition's content digest — the
    identity a test asserts when it exercises the callback. An empty ``callbacks`` map clears them.
    """
    enforce_permission(db, auth_data, Resource.VERSIONS, Action.EDIT)
    existing = _get_version_for_mock_scenarios(project_id, version_record_id, auth_data["tenant_id"])

    user_id = get_authenticated_user_id(auth_data)
    if not user_id:
        raise HTTPException(
            status_code=403,
            detail="Mock settings require user authentication (JWT token or API key with attribution)",
        )

    proposed = {
        name: spec.model_dump(by_alias=True, exclude_none=True)
        for name, spec in request.callbacks.items()
    }
    spec = _generated_spec_for_version(existing, tenant_slug)
    errors = validate_mock_callbacks(proposed, spec)
    if errors:
        raise HTTPException(
            status_code=422,
            detail={"message": "Callback definitions failed validation.", "errors": errors},
        )

    storage = callbacks_to_storage(proposed)
    updated = db.set_version_mock_callbacks(
        version_record_id,
        auth_data["tenant_id"],
        user_id,
        callbacks=storage,
    )
    if not updated:
        raise HTTPException(
            status_code=403,
            detail="Only the version creator or a tenant administrator can change mock settings",
        )
    return _stored_callbacks_response(updated.get("mock_settings"), version_record_id)


# ==================================================================================================
# Guarded proxy capture (#4747, PMR-2.4)
# ==================================================================================================


def _capture_policy_response(
    mock_settings: Any,
    *,
    version_record_id: str,
    tenant_id: str,
) -> VersionMockCapturePolicyResponse:
    """Build the capture-policy response from a stored ``mock_settings`` value (#4747, PMR-2.4).

    Reports the policy, its digest, *why* capture is or is not live right now, and how many
    recorded exchanges are waiting in each review state — the four things an owner needs to answer
    "is my mock recording, and what has it recorded".
    """
    stored = capture_policy_from_storage(mock_settings)
    if not stored:
        return VersionMockCapturePolicyResponse(
            policy=None,
            digest=None,
            state="unconfigured",
            captures=db.count_mock_capture_exchanges(version_record_id, tenant_id),
        )
    canonical = canonical_capture_policy(stored)
    try:
        policy = MockCapturePolicySpec.model_validate(canonical)
    except ValueError:
        # A malformed stored blob never breaks the editor; it is reported as unconfigured and
        # logged, exactly as the runtime skips it.
        logger.warning("Skipping malformed mock capture policy on version %s", version_record_id)
        return VersionMockCapturePolicyResponse(
            policy=None,
            digest=None,
            state="unconfigured",
            captures=db.count_mock_capture_exchanges(version_record_id, tenant_id),
        )
    return VersionMockCapturePolicyResponse(
        policy=policy,
        digest=capture_policy_digest(canonical),
        state=capture_authorization_state(canonical, now=datetime.now(timezone.utc)),
        captures=db.count_mock_capture_exchanges(version_record_id, tenant_id),
    )


def _require_mock_owner(
    project_id: str, version_record_id: str, auth_data: Dict[str, Any]
) -> str:
    """Resolve the acting user and confirm they own this version's mock configuration.

    Capture grants, review decisions, and publication all change what a mock will record or serve,
    so they carry the same ownership rule as every other mock-settings write: the version creator
    or a tenant administrator, acting as an identifiable user.

    Args:
        project_id: The project that must own the version.
        version_record_id: The version record id.
        auth_data: The authentication context.

    Returns:
        The acting user id.

    Raises:
        HTTPException: 403 when the caller is anonymous or does not own the mock; 404 when the
            version does not exist in the project.
    """
    _get_version_for_mock_scenarios(project_id, version_record_id, auth_data["tenant_id"])
    user_id = get_authenticated_user_id(auth_data)
    if not user_id:
        raise HTTPException(
            status_code=403,
            detail="Mock settings require user authentication (JWT token or API key with attribution)",
        )
    if not db.user_owns_version_mock_settings(version_record_id, auth_data["tenant_id"], user_id):
        raise HTTPException(
            status_code=403,
            detail="Only the version creator or a tenant administrator can change mock settings",
        )
    return user_id


def _capture_summary(row: Dict[str, Any], *, include_exchange: bool) -> MockCaptureSummary:
    """Project one stored capture row into its API representation."""
    redactions = row.get("redactions")
    validation_errors = row.get("validation_errors")
    return MockCaptureSummary(
        id=str(row["id"]),
        upstream=str(row.get("upstream") or ""),
        allowlist_entry=str(row.get("allowlist_entry") or ""),
        policy_digest=str(row.get("policy_digest") or ""),
        captured_at=_isoformat(row.get("captured_at")),
        operation_key=row.get("operation_key"),
        method=str(row.get("request_method") or ""),
        path=str(row.get("request_path") or ""),
        status=int(row.get("status_code") or 0),
        digest=str(row.get("exchange_digest") or ""),
        redaction_count=int(row.get("redaction_count") or 0),
        redactions=redactions if isinstance(redactions, list) else [],
        schema_valid=row.get("schema_valid"),
        validation_errors=validation_errors if isinstance(validation_errors, list) else [],
        review_state=str(row.get("review_state") or "pending"),
        review_note=row.get("review_note"),
        published_pack=row.get("published_pack"),
        expires_at=_isoformat(row.get("expires_at")),
        exchange=row.get("exchange") if include_exchange else None,
    )


def _isoformat(value: Any) -> str:
    """Render a timestamp column as an ISO 8601 string (``""`` when absent)."""
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value) if value is not None else ""


@router.get("/{tenant_slug}/{project_id}/{version_record_id}/mock/capture-policy")
async def get_version_mock_capture_policy(
    tenant_slug: str,
    project_id: str,
    version_record_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> VersionMockCapturePolicyResponse:
    """Return the version's guarded proxy capture policy and its current state (#4747, PMR-2.4)."""
    enforce_permission(db, auth_data, Resource.VERSIONS, Action.VIEW)
    existing = _get_version_for_mock_scenarios(project_id, version_record_id, auth_data["tenant_id"])
    return _capture_policy_response(
        existing.get("mock_settings"),
        version_record_id=version_record_id,
        tenant_id=auth_data["tenant_id"],
    )


@router.put("/{tenant_slug}/{project_id}/{version_record_id}/mock/capture-policy")
async def set_version_mock_capture_policy(
    tenant_slug: str,
    project_id: str,
    version_record_id: str,
    request: VersionMockCapturePolicyRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> VersionMockCapturePolicyResponse:
    """Authorize (or switch off) guarded proxy capture for a version (#4747, PMR-2.4).

    Capture lets the hosted mock forward a request to a **real** upstream and record the exchange
    as a reviewable fixture candidate. Three things gate it, and this endpoint is where two of them
    are set:

    * **Explicit owner authorization.** The caller must own the mock (version creator or tenant
      administrator) and must set ``acknowledged`` — an affirmative statement that they are
      permitted to record traffic from these upstreams. The ``authorization`` block recording who
      they were, when, and when the grant lapses is stamped by the server; it is never accepted
      from the client, and it is clamped to at most ``MAX_AUTHORIZATION_HOURS``. Capture stops on
      its own when the grant expires.
    * **An upstream allowlist.** ``upstreams`` is the complete set of base URLs capture may ever
      fetch. A request whose path does not fall under one of them is refused rather than proxied,
      which is what keeps capture from becoming an SSRF pivot.

    The third gate — address-level SSRF policy, public addresses only, re-checked on every redirect
    hop — is enforced by the runtime at fetch time and cannot be configured away here.

    ``redaction`` adds rules on top of the always-on credential rules; it can never subtract from
    them. Sending ``enabled: false`` keeps the allowlist but stops recording.
    """
    enforce_permission(db, auth_data, Resource.VERSIONS, Action.EDIT)
    user_id = _require_mock_owner(project_id, version_record_id, auth_data)

    if request.enabled and not request.acknowledged:
        raise HTTPException(
            status_code=422,
            detail={
                "message": "Capture requires explicit authorization.",
                "errors": [
                    "Set 'acknowledged' to true to confirm you are permitted to record traffic "
                    "from the listed upstreams."
                ],
            },
        )
    if request.ttl_hours is not None and request.ttl_hours > MAX_AUTHORIZATION_HOURS:
        raise HTTPException(
            status_code=422,
            detail={
                "message": "Capture policy failed validation.",
                "errors": [
                    f"ttlHours may not exceed {MAX_AUTHORIZATION_HOURS}; renew the grant instead."
                ],
            },
        )

    proposed: Dict[str, Any] = {
        "enabled": bool(request.enabled),
        "upstreams": list(request.upstreams),
        "validateResponses": bool(request.validate_responses),
        "authorization": authorization_block(
            authorized_by=user_id,
            now=datetime.now(timezone.utc),
            ttl_hours=request.ttl_hours,
        ),
    }
    if request.redaction is not None:
        proposed["redaction"] = request.redaction.model_dump(by_alias=True, exclude_none=True)

    errors = validate_capture_policy(proposed)
    if errors:
        raise HTTPException(
            status_code=422,
            detail={"message": "Capture policy failed validation.", "errors": errors},
        )

    updated = db.set_version_mock_capture_policy(
        version_record_id,
        auth_data["tenant_id"],
        user_id,
        policy=capture_policy_to_storage(proposed),
    )
    if not updated:
        raise HTTPException(
            status_code=403,
            detail="Only the version creator or a tenant administrator can change mock settings",
        )
    return _capture_policy_response(
        updated.get("mock_settings"),
        version_record_id=version_record_id,
        tenant_id=auth_data["tenant_id"],
    )


@router.delete("/{tenant_slug}/{project_id}/{version_record_id}/mock/capture-policy")
async def delete_version_mock_capture_policy(
    tenant_slug: str,
    project_id: str,
    version_record_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> VersionMockCapturePolicyResponse:
    """Revoke guarded proxy capture entirely (#4747, PMR-2.4).

    Removes the policy — allowlist, authorization, redaction rules — so nothing can be recorded
    until a new grant is made. Already-recorded exchanges are deliberately left alone: revoking
    permission to record must not destroy the evidence of what was recorded. Discard those
    explicitly with ``DELETE .../mock/captures``.
    """
    enforce_permission(db, auth_data, Resource.VERSIONS, Action.EDIT)
    user_id = _require_mock_owner(project_id, version_record_id, auth_data)
    updated = db.set_version_mock_capture_policy(
        version_record_id, auth_data["tenant_id"], user_id, policy=None
    )
    if not updated:
        raise HTTPException(
            status_code=403,
            detail="Only the version creator or a tenant administrator can change mock settings",
        )
    return _capture_policy_response(
        updated.get("mock_settings"),
        version_record_id=version_record_id,
        tenant_id=auth_data["tenant_id"],
    )


@router.get("/{tenant_slug}/{project_id}/{version_record_id}/mock/captures")
async def list_version_mock_captures(
    tenant_slug: str,
    project_id: str,
    version_record_id: str,
    state: Optional[Literal["pending", "approved", "rejected", "published"]] = Query(
        default=None, description="Filter by review state."
    ),
    limit: int = Query(default=50, ge=1, le=500, description="Maximum captures to return."),
    offset: int = Query(default=0, ge=0, description="Captures to skip, for paging."),
    include_exchange: bool = Query(
        default=False,
        alias="includeExchange",
        description="Include each capture's full redacted document, not only its summary.",
    ),
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> VersionMockCapturesResponse:
    """List the exchanges guarded capture has recorded for this version (#4747, PMR-2.4).

    This is the review queue. Every entry is already redacted — the runtime never stores anything
    else — and carries the full list of redaction decisions plus the provenance of the fetch, so a
    reviewer can see what was removed and where the data came from before approving anything.
    """
    enforce_permission(db, auth_data, Resource.VERSIONS, Action.VIEW)
    _get_version_for_mock_scenarios(project_id, version_record_id, auth_data["tenant_id"])
    rows = db.list_mock_capture_exchanges(
        version_record_id,
        auth_data["tenant_id"],
        review_state=state,
        limit=limit,
        offset=offset,
    )
    return VersionMockCapturesResponse(
        captures=[_capture_summary(row, include_exchange=include_exchange) for row in rows],
        counts=db.count_mock_capture_exchanges(version_record_id, auth_data["tenant_id"]),
    )


@router.post("/{tenant_slug}/{project_id}/{version_record_id}/mock/captures/review")
async def review_version_mock_captures(
    tenant_slug: str,
    project_id: str,
    version_record_id: str,
    request: VersionMockCaptureReviewRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> VersionMockCaptureReviewResponse:
    """Approve or reject recorded exchanges (#4747, PMR-2.4).

    Nothing a capture recorded reaches a fixture pack without passing through here first. A capture
    already published is never re-decided: the pack that carries its provenance would otherwise be
    left claiming a source that disowns it.
    """
    enforce_permission(db, auth_data, Resource.VERSIONS, Action.EDIT)
    user_id = _require_mock_owner(project_id, version_record_id, auth_data)
    if not request.capture_ids:
        raise HTTPException(status_code=422, detail="captureIds must name at least one capture.")

    reviewed = db.review_mock_capture_exchanges(
        version_record_id,
        auth_data["tenant_id"],
        user_id,
        capture_ids=request.capture_ids,
        review_state="approved" if request.decision == "approve" else "rejected",
        note=request.note,
    )
    return VersionMockCaptureReviewResponse(
        reviewed=reviewed,
        counts=db.count_mock_capture_exchanges(version_record_id, auth_data["tenant_id"]),
    )


@router.post("/{tenant_slug}/{project_id}/{version_record_id}/mock/captures/publish")
async def publish_version_mock_captures(
    tenant_slug: str,
    project_id: str,
    version_record_id: str,
    request: VersionMockCapturePublishRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> VersionMockCapturePublishResponse:
    """Convert approved captures into a fixture pack (#4747, PMR-2.4).

    The publish half of "review before publish": only captures an owner has explicitly **approved**
    are converted, and the resulting pack is stamped with a ``provenance`` block naming the
    upstreams it drew from, how many captures went into it, and how many redactions were applied.
    That block is what the runtime reports back on every pack listing and session reset, so a
    fixture replayed months later still says where it came from.

    Successful JSON responses whose operation identifies a CRUD collection become session seed
    resources; everything else becomes named template fixture data. Anything that could not be
    converted is reported in ``notes`` rather than dropped silently. Publishing to an existing pack
    name replaces that pack.
    """
    enforce_permission(db, auth_data, Resource.VERSIONS, Action.EDIT)
    user_id = _require_mock_owner(project_id, version_record_id, auth_data)

    pack_name = request.pack_name.strip()
    if not PACK_NAME_PATTERN.match(pack_name):
        raise HTTPException(
            status_code=422,
            detail={
                "message": "Fixture pack name is invalid.",
                "errors": [f"Pack names must match {PACK_NAME_PATTERN.pattern}."],
            },
        )

    page_size = 500
    approved = db.list_mock_capture_exchanges(
        version_record_id,
        auth_data["tenant_id"],
        review_state="approved",
        limit=page_size,
    )
    truncated = len(approved) == page_size
    if request.capture_ids:
        wanted = set(request.capture_ids)
        approved = [row for row in approved if str(row["id"]) in wanted]
    if not approved:
        raise HTTPException(
            status_code=409,
            detail="No approved captures to publish; approve captures before publishing them.",
        )

    approved_at = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    pack, notes = fixture_pack_from_captures(
        [row["exchange"] for row in approved if isinstance(row.get("exchange"), dict)],
        description=request.description,
        approved_by=user_id,
        approved_at=approved_at,
    )
    if truncated:
        # Never truncate silently: a partial publication that reads as complete is how a fixture
        # pack ends up quietly missing half the traffic it claims to represent.
        notes.append(
            f"Only the {page_size} most recent approved captures were considered; "
            "publish again to convert the rest."
        )

    existing = _get_version_for_mock_scenarios(project_id, version_record_id, auth_data["tenant_id"])
    packs = fixture_packs_from_storage(existing.get("mock_settings"))
    packs[pack_name] = pack
    errors = validate_fixture_packs(packs)
    if errors:
        raise HTTPException(
            status_code=422,
            detail={"message": "The converted fixture pack failed validation.", "errors": errors},
        )

    updated = db.set_version_mock_fixture_packs(
        version_record_id,
        auth_data["tenant_id"],
        user_id,
        packs=fixture_packs_to_storage(packs),
    )
    if not updated:
        raise HTTPException(
            status_code=403,
            detail="Only the version creator or a tenant administrator can change mock settings",
        )

    published = db.mark_mock_captures_published(
        version_record_id,
        auth_data["tenant_id"],
        capture_ids=[str(row["id"]) for row in approved],
        pack_name=pack_name,
    )
    return VersionMockCapturePublishResponse(
        pack_name=pack_name,
        digest=fixture_pack_digest(pack),
        published=published,
        notes=notes,
        provenance=MockFixturePackProvenanceSpec.model_validate(pack["provenance"]),
    )


@router.delete("/{tenant_slug}/{project_id}/{version_record_id}/mock/captures")
async def delete_version_mock_captures(
    tenant_slug: str,
    project_id: str,
    version_record_id: str,
    state: Optional[Literal["pending", "approved", "rejected", "published"]] = Query(
        default=None, description="Discard only captures in this review state."
    ),
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> Dict[str, Any]:
    """Discard recorded exchanges (#4747, PMR-2.4).

    Recorded traffic is the one thing here that should never accumulate: this removes it outright
    rather than flagging it. Captures also expire on their own; this is the manual path for an
    owner who wants them gone now.
    """
    enforce_permission(db, auth_data, Resource.VERSIONS, Action.EDIT)
    _require_mock_owner(project_id, version_record_id, auth_data)
    removed = db.delete_mock_capture_exchanges(
        version_record_id, auth_data["tenant_id"], review_state=state
    )
    return {
        "deleted": removed,
        "counts": db.count_mock_capture_exchanges(version_record_id, auth_data["tenant_id"]),
    }


def _bundle_filename(project_slug: str, version_label: str) -> str:
    """Build the bundle download filename, stripped to header-safe characters (#4741, PMR-1.1).

    Version labels are free text, so every character outside ``[A-Za-z0-9._-]`` is replaced with an
    underscore; a quote or newline reaching a ``Content-Disposition`` header would otherwise let a
    label break out of the header.

    Args:
        project_slug: The project slug.
        version_label: The version label (e.g. ``"1.0.0"``).

    Returns:
        A safe ``<project>-<version>-mock-bundle.json`` filename.
    """
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", f"{project_slug}-{version_label}")
    return f"{safe}-mock-bundle.json"


@router.get("/{tenant_slug}/{project_id}/{version_record_id}/mock/bundle")
async def get_version_mock_bundle(
    tenant_slug: str,
    project_id: str,
    version_record_id: str,
    response: Response,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> Dict[str, Any]:
    """Export the version's portable mock bundle (#4741, PMR-1.1).

    The bundle pins the version snapshot (its generated OpenAPI document), the portable subset of
    ``versions.mock_settings`` (scenarios and chaos knobs), and fixture digests into one
    self-contained, signed JSON document that apiome-mock can serve offline — in CI, on a laptop,
    or inside an air-gapped network.

    The document is deterministic: exporting the same version with the same settings always yields
    the same ``manifestDigest``, which is the identifier release proofs attach (PMR-3.2). Tenant
    credentials never travel: only allowlisted settings keys are bundled, and credential-shaped
    fields inside them are dropped and listed in ``manifest.redactions``.

    Args:
        tenant_slug: The tenant slug.
        project_id: The project ID that must own the version.
        version_record_id: The version record ID (UUID) to export.
        response: Injected so the export can advertise a download filename.
        auth_data: Authentication context; requires ``versions:view``.

    Returns:
        The bundle document (``bundleFormat``, ``manifest``, ``manifestDigest``, ``signature``,
        ``spec``, ``settings``, ``fixtures``).

    Raises:
        HTTPException: 404 when the version does not exist in the project, 409 when mock serving
            is not enabled for the version.
    """
    enforce_permission(db, auth_data, Resource.VERSIONS, Action.VIEW)
    existing = _get_version_for_mock_scenarios(project_id, version_record_id, auth_data["tenant_id"])

    if not existing.get("mock_enabled"):
        raise HTTPException(
            status_code=409,
            detail="Mock serving is not enabled for this version; enable it before exporting a bundle.",
        )

    project_slug = str(existing.get("project_slug") or existing["project_id"])
    version_label = str(existing["version_id"])
    bundle = build_bundle(
        identity=BundleIdentity(
            tenant=tenant_slug,
            project=project_slug,
            version=version_label,
            revision_id=str(existing["id"]),
            published=bool(existing.get("published")),
            protocol="openapi",
        ),
        spec=_generated_spec_for_version(existing, tenant_slug),
        mock_settings=existing.get("mock_settings"),
        secret=settings.mock_bundle_signing_secret,
    )
    response.headers["Content-Disposition"] = (
        f'attachment; filename="{_bundle_filename(project_slug, version_label)}"'
    )
    return bundle


@router.post("/{tenant_slug}/{project_id}/{version_record_id}/unpublish")
async def unpublish_version(
    tenant_slug: str,
    project_id: str,
    version_record_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication)
) -> VersionSchema:
    """
    Unpublish a version.

    Only the version creator or a tenant administrator can unpublish a version.

    Args:
        tenant_slug: The tenant slug
        project_id: The project ID
        version_record_id: The version record ID
        auth_data: Authentication data (injected by dependency)

    Returns:
        The unpublished version
    """
    enforce_permission(db, auth_data, Resource.VERSIONS, Action.PUBLISH)
    # Check if version exists
    existing = db.get_version_by_id(version_record_id, auth_data['tenant_id'])
    if not existing:
        raise HTTPException(
            status_code=404,
            detail=f"Version not found: {version_record_id}"
        )

    # Verify version belongs to the specified project
    if existing['project_id'] != project_id:
        raise HTTPException(
            status_code=404,
            detail=f"Version not found in project: {project_id}"
        )

    if not existing.get('published'):
        raise HTTPException(
            status_code=400,
            detail="Version is not published"
        )

    # Block unpublish if any data_record exists for this version's class schemas
    if db.version_has_data_records(version_record_id):
        raise HTTPException(
            status_code=409,
            detail={
                "code": "VERSION_HAS_DATA",
                "message": "This version has data records and cannot be unpublished. Create a new version or a new minor version to make changes."
            }
        )

    # Get user_id from auth data
    user_id = get_authenticated_user_id(auth_data)
    if not user_id:
        raise HTTPException(
            status_code=403,
            detail="Unpublishing requires user authentication (JWT token)"
        )

    version = db.unpublish_version(version_record_id, auth_data['tenant_id'], user_id)

    if not version:
        raise HTTPException(
            status_code=403,
            detail="Only the version creator or a tenant administrator can unpublish this version"
        )

    return VersionSchema(**version)


@router.post("/{tenant_slug}/{project_id}/{version_record_id}/freeze-schema")
async def freeze_version_schema(
    tenant_slug: str,
    project_id: str,
    version_record_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication)
) -> VersionSchema:
    """
    Freeze (capture) class schemas into apiome.class_schema for this version.
    Only available when the version has no class_schema rows yet (e.g. published before schema capture existed).
    Only the version creator or a tenant administrator can freeze schema.
    """
    enforce_permission(db, auth_data, Resource.VERSIONS, Action.EDIT)
    existing = db.get_version_by_id(version_record_id, auth_data["tenant_id"])
    if not existing:
        raise HTTPException(
            status_code=404,
            detail=f"Version not found: {version_record_id}"
        )
    if existing["project_id"] != project_id:
        raise HTTPException(
            status_code=404,
            detail=f"Version not found in project: {project_id}"
        )
    if db.version_has_class_schema(version_record_id):
        raise HTTPException(
            status_code=400,
            detail="Schema already frozen for this version. Class schemas are already captured."
        )
    user_id = get_authenticated_user_id(auth_data)
    if not user_id:
        raise HTTPException(
            status_code=403,
            detail="Freeze schema requires user authentication (JWT token)"
        )
    version = db.freeze_version_schema(version_record_id, auth_data["tenant_id"], user_id)
    if not version:
        raise HTTPException(
            status_code=403,
            detail="Only the version creator or a tenant administrator can freeze schema for this version"
        )
    return VersionSchema(**version)


@router.delete("/{tenant_slug}/{project_id}/{version_record_id}")
async def delete_version(
    tenant_slug: str,
    project_id: str,
    version_record_id: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication)
) -> Dict[str, str]:
    """
    Delete a version (soft delete).

    Supports authentication via JWT token or API key.

    Args:
        tenant_slug: The tenant slug
        project_id: The project ID
        version_record_id: The version record ID
        auth_data: Authentication data (injected by dependency)

    Returns:
        Success message
    """
    enforce_permission(db, auth_data, Resource.VERSIONS, Action.DELETE)
    # Check if version exists
    existing = db.get_version_by_id(version_record_id, auth_data['tenant_id'])
    if not existing:
        raise HTTPException(
            status_code=404,
            detail=f"Version not found: {version_record_id}"
        )

    # Verify version belongs to the specified project
    if existing['project_id'] != project_id:
        raise HTTPException(
            status_code=404,
            detail=f"Version not found in project: {project_id}"
        )

    uid = get_authenticated_user_id(auth_data)
    success, err = db.delete_version(version_record_id, auth_data["tenant_id"], uid)

    if not success:
        if err == "not_found":
            raise HTTPException(status_code=404, detail=f"Version not found: {version_record_id}")
        if err == "forbidden":
            raise HTTPException(
                status_code=403,
                detail="Only the version creator or a tenant admin can delete this version",
            )
        if err == "revision_locked":
            raise HTTPException(
                status_code=403,
                detail="This revision is locked by policy and cannot be deleted",
            )
        raise HTTPException(status_code=500, detail="Failed to delete version")

    return {"message": f"Version '{existing['version_id']}' deleted successfully"}
