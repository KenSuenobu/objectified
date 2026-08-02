"""
Catalog-wide lint posture and remediation workspace API (CLX-4.1, #4859).

The persistent triage surface over the CLX-1.x substrate:

* ``GET  /v1/lint/workspace/findings``       — cross-catalog findings queue (filters, facets).
* ``GET  /v1/lint/workspace/summary``        — tenant posture rollup (grades, axes, coverage).
* ``GET  /v1/lint/workspace/trends``         — daily remediation-vs-policy series.
* ``GET  /v1/lint/workspace/quality-ranks``  — per-format import/export grade drift (IXH-2.7).
* ``POST /v1/lint/workspace/decisions/bulk`` — authorized, audited, reversible bulk actions.
* ``GET/POST/PATCH/DELETE …/views``          — per-user saved workspace views.

Tenant scope comes from the token (``auth_data["tenant_id"]``, the decisions-router pattern);
project scope is the optional ``projectId`` query parameter. Reads are tenant-scoped like the
existing per-revision lint reads; mutations are RBAC-guarded on the ``lint_findings`` resource
(``edit`` for triage, ``publish`` for waiver approval — see :mod:`app.lint_workspace`).
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from psycopg2 import errors as pg_errors

from .auth import get_authenticated_user_id, validate_authentication
from .database import db
from .lint_workspace import (
    ACTION_PUBLISH,
    BULK_ITEM_CAP,
    WorkspaceValidationError,
    build_summary,
    build_trends,
    build_workspace_index,
    facet_counts,
    filter_findings,
    load_trend_inputs,
    normalize_filters,
    normalize_sort,
    paginate,
    required_action_for_transition,
    sort_findings,
    transition_error,
)
from .models import (
    LintWorkspaceBulkDecisionRequest,
    LintWorkspaceBulkDecisionResponse,
    LintWorkspaceBulkItemResultOut,
    LintWorkspaceFindingsResponse,
    LintWorkspaceSavedViewCreate,
    LintWorkspaceSavedViewListResponse,
    LintWorkspaceSavedViewOut,
    LintWorkspaceSavedViewUpdate,
    LintWorkspaceSummaryResponse,
    LintWorkspaceTrendsResponse,
    QualityRankSeriesResponse,
    lint_workspace_finding_out_from_row,
    lint_workspace_saved_view_out_from_row,
)
from .permissions import Action, Resource, enforce_permission, has_permission
from .policy_evaluate import match_decision_for_fingerprint
from .quality_rank_telemetry import (
    MAX_WINDOW_DAYS,
    SCOPE_EXPORT,
    SCOPE_IMPORT,
    STAGE_COMMITTED,
    STAGE_PREFLIGHT,
    build_quality_rank_series,
    load_quality_rank_observations,
)

router = APIRouter(prefix="/v1/lint/workspace", tags=["lint-workspace"])


def _require_user_id(auth_data: Dict[str, Any]) -> str:
    """Resolve the authenticated user; saved views are per-user."""
    user_id = get_authenticated_user_id(auth_data)
    if not user_id:
        raise HTTPException(
            status_code=403,
            detail="Saved views require an attributable user",
        )
    return user_id


def _query_filters(
    severity: Optional[str],
    state: Optional[str],
    axis: Optional[str],
    grade: Optional[str],
    coverage: Optional[str],
    profile: Optional[str],
    scanner: Optional[str],
    subject_type: Optional[str],
    project_id: Optional[str],
    owner_user_id: Optional[str],
    rule_id: Optional[str],
    category: Optional[str],
    new: Optional[bool],
    q: Optional[str],
) -> Dict[str, Any]:
    """Fold query params into the canonical filter dict (400 on unknown values)."""
    raw: Dict[str, Any] = {
        "severity": severity,
        "state": state,
        "axis": axis,
        "grade": grade,
        "coverage": coverage,
        "profile": profile,
        "scanner": scanner,
        "subject_type": subject_type,
        "project_id": project_id,
        "owner_user_id": owner_user_id,
        "rule_id": rule_id,
        "category": category,
        "new": new,
        "q": q,
    }
    try:
        return normalize_filters(raw)
    except WorkspaceValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/findings", response_model=LintWorkspaceFindingsResponse)
async def list_workspace_findings(
    severity: Optional[str] = Query(default=None, description="CSV of error,warning,info"),
    state: Optional[str] = Query(
        default=None, description="CSV of effective decision states"
    ),
    axis: Optional[str] = Query(default=None, description="CSV of scoring axis keys"),
    grade: Optional[str] = Query(default=None, description="CSV of composite grades A–F"),
    coverage: Optional[str] = Query(default=None, description="missing | met"),
    profile: Optional[str] = Query(default=None, description="CSV of execution profiles"),
    scanner: Optional[str] = Query(default=None, description="CSV of scanner ids (source)"),
    subject_type: Optional[str] = Query(
        default=None,
        alias="subjectType",
        description="catalog_revision | mcp_endpoint_version",
    ),
    project_id: Optional[str] = Query(default=None, alias="projectId"),
    owner_user_id: Optional[str] = Query(default=None, alias="ownerUserId"),
    rule_id: Optional[str] = Query(default=None, alias="ruleId"),
    category: Optional[str] = Query(default=None),
    new: Optional[bool] = Query(
        default=None, description="True restricts to regressions (new since previous run)"
    ),
    q: Optional[str] = Query(default=None, description="Free-text search"),
    sort: Optional[str] = Query(default=None, description="severity | newest | rule | subject"),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> LintWorkspaceFindingsResponse:
    """Cross-catalog findings queue over the latest evidence per subject (CLX-4.1, #4859).

    "All new unwaived security errors" (acceptance criterion 1) is
    ``?new=true&severity=error&axis=security&state=open``; missing required coverage lives in
    ``GET /summary``'s coverage block. Facets are computed over the filtered, pre-pagination
    set so the toolbar can show counts for the current queue.
    """
    tenant_id = str(auth_data["tenant_id"])
    filters = _query_filters(
        severity, state, axis, grade, coverage, profile, scanner,
        subject_type, project_id, owner_user_id, rule_id, category, new, q,
    )
    try:
        sort_key = normalize_sort(sort)
    except WorkspaceValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    index = build_workspace_index(tenant_id, project_id=filters.get("project_id"))
    filtered = filter_findings(index["findings"], filters)
    ordered = sort_findings(filtered, sort_key)
    page, total = paginate(ordered, limit=limit, offset=offset)
    return LintWorkspaceFindingsResponse(
        findings=[lint_workspace_finding_out_from_row(f) for f in page],
        count=len(page),
        total=total,
        limit=limit,
        offset=offset,
        facets=facet_counts(filtered),
    )


@router.get("/summary", response_model=LintWorkspaceSummaryResponse)
async def workspace_summary(
    project_id: Optional[str] = Query(default=None, alias="projectId"),
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> LintWorkspaceSummaryResponse:
    """Tenant-wide posture rollup: grades, axes, coverage gaps, finding/waiver counts."""
    tenant_id = str(auth_data["tenant_id"])
    index = build_workspace_index(tenant_id, project_id=project_id)
    summary = build_summary(index)
    return LintWorkspaceSummaryResponse(**summary)


@router.get("/trends", response_model=LintWorkspaceTrendsResponse)
async def workspace_trends(
    days: int = Query(default=30, ge=1, le=365),
    project_id: Optional[str] = Query(default=None, alias="projectId"),
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> LintWorkspaceTrendsResponse:
    """Daily series separating genuine remediation from policy / waiver / coverage change.

    ``remediatedFindings`` counts only fingerprints that disappeared from evidence and were
    NOT waived or false-positived; waiver grants, expiries, false-positive marks, and policy
    pack publications are their own series (acceptance criterion 4).
    """
    tenant_id = str(auth_data["tenant_id"])
    since = datetime.now(timezone.utc) - timedelta(days=days)
    inputs = load_trend_inputs(tenant_id, project_id=project_id, since=since)
    trends = build_trends(days=days, **inputs)
    return LintWorkspaceTrendsResponse(**trends)


@router.get("/quality-ranks", response_model=QualityRankSeriesResponse)
async def workspace_quality_ranks(
    days: int = Query(default=30, ge=1, le=MAX_WINDOW_DAYS),
    scope: Optional[str] = Query(
        default=None, description="import | export (both when omitted)"
    ),
    stage: Optional[str] = Query(
        default=None, description="preflight | committed (both when omitted)"
    ),
    project_id: Optional[str] = Query(default=None, alias="projectId"),
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> QualityRankSeriesResponse:
    """Per-format import/export grade distribution and drift over a window (IXH-2.7, #5102).

    Scores are captured per revision, but a single revision's grade cannot show that a team's
    imports are trending downward or that one format grades low because its *adapter* is
    incomplete. This series answers both: grades are grouped by ``(scope, format)`` and each
    group reports its distribution, its drift (``scoreDelta`` — newest scored observation minus
    the oldest in the window), the style-guide versions that produced those grades, and the
    **attribution split** that separates adapter-attributable findings from spec-attributable
    ones. Export readiness ranks ride the same series, so a target whose readiness is sliding
    shows up beside the specs feeding it.

    The window is bounded (``days`` ≤ 180, matching the retention default) and the response
    describes at most 24 format groups, stating ``truncated`` when it dropped any.
    """
    tenant_id = str(auth_data["tenant_id"])
    if scope is not None and scope not in (SCOPE_IMPORT, SCOPE_EXPORT):
        raise HTTPException(
            status_code=400, detail="scope must be import or export"
        )
    if stage is not None and stage not in (STAGE_PREFLIGHT, STAGE_COMMITTED):
        raise HTTPException(
            status_code=400, detail="stage must be preflight or committed"
        )
    now = datetime.now(timezone.utc)
    since = now - timedelta(days=days)
    rows = load_quality_rank_observations(
        tenant_id, since=since, project_id=project_id, scope=scope, stage=stage
    )
    return QualityRankSeriesResponse(**build_quality_rank_series(rows, days=days, now=now))


@router.post("/decisions/bulk", response_model=LintWorkspaceBulkDecisionResponse)
async def bulk_decision_action(
    body: LintWorkspaceBulkDecisionRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> LintWorkspaceBulkDecisionResponse:
    """Apply one decision change to up to :data:`BULK_ITEM_CAP` findings (CLX-4.1, #4859).

    **Authorized**: requires ``lint_findings:edit``; items whose transition is approval-tier
    (entering/leaving ``waived``, resolving a ``waiver_requested`` row) additionally require
    ``lint_findings:publish`` and fail per-item without it.
    **Audited**: every applied item appends an immutable ``lint_finding_decision_events`` row
    (plus the standard denial audit on 403).
    **Reversible**: each result carries ``beforeState`` so the client can issue the exact
    inverse request; approval-tier inversions require the same publish permission.
    """
    tenant_id = str(auth_data["tenant_id"])
    if len(body.items) > BULK_ITEM_CAP:
        raise HTTPException(
            status_code=400,
            detail=f"Bulk requests are capped at {BULK_ITEM_CAP} items",
        )

    target_state = (body.set.state or "").strip().lower() or None
    if target_state is not None:
        error = transition_error(
            target_state,
            rationale=body.set.rationale,
            expires_at=body.set.expires_at,
        )
        if error:
            raise HTTPException(status_code=400, detail=error)
    elif body.set.owner_user_id is None:
        raise HTTPException(
            status_code=400,
            detail="Bulk actions must set a state and/or an owner",
        )

    # Every bulk action needs at least edit; approval-tier items are checked per item so a
    # mixed batch degrades per-finding instead of failing wholesale.
    actor = enforce_permission(
        db,
        auth_data,
        Resource.LINT_FINDINGS,
        Action.EDIT,
        target=f"lint-workspace:bulk:{len(body.items)}",
    )
    can_approve = has_permission(db, auth_data, Resource.LINT_FINDINGS, Action.PUBLISH)

    # Current decisions for before-state / transition checks, one query for the whole batch.
    fingerprints = [item.source_fingerprint.strip() for item in body.items]
    current_decisions = db.list_lint_finding_decisions(
        tenant_id, fingerprints=fingerprints or None
    )

    results: list[LintWorkspaceBulkItemResultOut] = []
    applied = 0
    for item in body.items:
        fingerprint = item.source_fingerprint.strip()
        current = match_decision_for_fingerprint(
            current_decisions, fingerprint, project_id=item.project_id
        )
        before_state = str(current["state"]) if current else None
        after_state = target_state or str((current or {}).get("state") or "open")

        item_error: Optional[str] = None
        if target_state is not None:
            required = required_action_for_transition(before_state, target_state)
            if required == ACTION_PUBLISH and not can_approve:
                item_error = (
                    "Permission denied: lint_findings:publish is required for this transition"
                )
        if item_error is None and item.project_id:
            project = db.get_project_by_id(item.project_id, tenant_id)
            if not project:
                item_error = "Project not found"

        if item_error:
            results.append(
                LintWorkspaceBulkItemResultOut(
                    source_fingerprint=fingerprint,
                    project_id=item.project_id,
                    decision_id=str(current["id"]) if current else None,
                    before_state=before_state,
                    after_state=None,
                    ok=False,
                    error=item_error,
                )
            )
            continue

        try:
            row = db.upsert_lint_finding_decision(
                tenant_id=tenant_id,
                source_fingerprint=fingerprint,
                state=after_state,
                project_id=item.project_id,
                rule_id=item.rule_id,
                owner_user_id=(
                    body.set.owner_user_id
                    if body.set.owner_user_id is not None
                    else (current or {}).get("owner_user_id")
                ),
                rationale=(body.set.rationale or "").strip()
                or (current or {}).get("rationale"),
                linked_ticket=(
                    body.set.linked_ticket
                    if body.set.linked_ticket is not None
                    else (current or {}).get("linked_ticket")
                ),
                expires_at=(
                    body.set.expires_at
                    if body.set.expires_at is not None
                    else (current or {}).get("expires_at")
                ),
                policy_version_id=(
                    body.set.policy_version_id
                    if body.set.policy_version_id is not None
                    else (
                        str((current or {}).get("policy_version_id"))
                        if (current or {}).get("policy_version_id")
                        else None
                    )
                ),
                evidence_fingerprint_at_decision=fingerprint,
                actor_user_id=actor,
                actor_label=actor,
            )
            applied += 1
            results.append(
                LintWorkspaceBulkItemResultOut(
                    source_fingerprint=fingerprint,
                    project_id=item.project_id,
                    decision_id=str(row["id"]),
                    before_state=before_state,
                    after_state=str(row["state"]),
                    ok=True,
                )
            )
        except Exception as exc:  # noqa: BLE001 - continue on per-item failure by design
            results.append(
                LintWorkspaceBulkItemResultOut(
                    source_fingerprint=fingerprint,
                    project_id=item.project_id,
                    decision_id=str(current["id"]) if current else None,
                    before_state=before_state,
                    after_state=None,
                    ok=False,
                    error=str(exc),
                )
            )

    return LintWorkspaceBulkDecisionResponse(
        results=results,
        applied_count=applied,
        failed_count=len(results) - applied,
    )


# --- Saved views ---------------------------------------------------------------------------------


def _normalized_view_fields(
    *,
    name: Optional[str] = None,
    filters: Optional[Dict[str, Any]] = None,
    query: Optional[str] = None,
    sort: Optional[str] = None,
    is_pinned: Optional[bool] = None,
) -> Dict[str, Any]:
    """Validate saved-view fields; only supplied fields are returned (422 on bad values)."""
    fields: Dict[str, Any] = {}
    if name is not None:
        trimmed = name.strip()
        if not trimmed:
            raise HTTPException(status_code=422, detail="Saved views require a name")
        fields["name"] = trimmed
    try:
        if filters is not None:
            fields["filters"] = normalize_filters(filters)
        if sort is not None:
            fields["sort"] = normalize_sort(sort)
    except WorkspaceValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if query is not None:
        fields["query"] = query.strip()
    if is_pinned is not None:
        fields["is_pinned"] = bool(is_pinned)
    return fields


@router.get("/views", response_model=LintWorkspaceSavedViewListResponse)
async def list_workspace_saved_views(
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> LintWorkspaceSavedViewListResponse:
    """List the caller's saved workspace views (pinned first, then newest)."""
    tenant_id = str(auth_data["tenant_id"])
    user_id = _require_user_id(auth_data)
    rows = db.list_lint_workspace_saved_views(tenant_id, user_id)
    return LintWorkspaceSavedViewListResponse(
        views=[lint_workspace_saved_view_out_from_row(r) for r in rows],
        count=len(rows),
    )


@router.post("/views", response_model=LintWorkspaceSavedViewOut, status_code=201)
async def create_workspace_saved_view(
    body: LintWorkspaceSavedViewCreate,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> LintWorkspaceSavedViewOut:
    """Save the current workspace filter bundle under a name."""
    tenant_id = str(auth_data["tenant_id"])
    user_id = _require_user_id(auth_data)
    fields = _normalized_view_fields(
        name=body.name,
        filters=body.filters,
        query=body.query,
        sort=body.sort,
        is_pinned=body.is_pinned,
    )
    try:
        row = db.create_lint_workspace_saved_view(
            tenant_id,
            user_id,
            name=fields["name"],
            filters=fields.get("filters") or {},
            query=fields.get("query") or "",
            sort=fields.get("sort") or "severity",
            is_pinned=fields.get("is_pinned", False),
        )
    except pg_errors.UniqueViolation as exc:
        raise HTTPException(
            status_code=409,
            detail="A saved view with that name already exists",
        ) from exc
    return lint_workspace_saved_view_out_from_row(row)


@router.patch("/views/{view_id}", response_model=LintWorkspaceSavedViewOut)
async def update_workspace_saved_view(
    view_id: uuid.UUID,
    body: LintWorkspaceSavedViewUpdate,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> LintWorkspaceSavedViewOut:
    """Update a saved workspace view owned by the caller."""
    tenant_id = str(auth_data["tenant_id"])
    user_id = _require_user_id(auth_data)
    fields = _normalized_view_fields(
        name=body.name,
        filters=body.filters,
        query=body.query,
        sort=body.sort,
        is_pinned=body.is_pinned,
    )
    if not fields:
        row = db.get_lint_workspace_saved_view(tenant_id, user_id, str(view_id))
        if row is None:
            raise HTTPException(status_code=404, detail="Saved view not found")
        return lint_workspace_saved_view_out_from_row(row)
    try:
        row = db.update_lint_workspace_saved_view(
            tenant_id, user_id, str(view_id), **fields
        )
    except pg_errors.UniqueViolation as exc:
        raise HTTPException(
            status_code=409,
            detail="A saved view with that name already exists",
        ) from exc
    if row is None:
        raise HTTPException(status_code=404, detail="Saved view not found")
    return lint_workspace_saved_view_out_from_row(row)


@router.delete("/views/{view_id}")
async def delete_workspace_saved_view(
    view_id: uuid.UUID,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> Dict[str, bool]:
    """Delete a saved workspace view owned by the caller."""
    tenant_id = str(auth_data["tenant_id"])
    user_id = _require_user_id(auth_data)
    deleted = db.delete_lint_workspace_saved_view(tenant_id, user_id, str(view_id))
    if not deleted:
        raise HTTPException(status_code=404, detail="Saved view not found")
    return {"success": True}


__all__ = ["router"]
