"""Tenant import/export quality policy and waiver API — IXH-2.3 (#5098).

The governance surface for the gate that :mod:`app.import_export_quality_policy` evaluates:

* ``GET  …/governance/quality-policy`` — the policy in force (the advisory default when the
  tenant has never saved one), readable by any tenant member so the import wizard can explain
  a verdict it did not set.
* ``PUT  …/governance/quality-policy`` — save a new **version**. Policy rows are immutable, so
  every save appends; the write is tenant-administrator-only and audit-logged.
* ``GET  …/governance/quality-policy/versions`` — the version history, newest first.
* ``POST …/governance/quality-waivers`` — record accepted risk against a blocking verdict.
  Permitted only when the policy allows an override **and** names the caller's effective role;
  the check is here, on the server, so a client cannot grant itself one.
* ``GET  …/governance/quality-waivers`` — the waiver ledger.

Every mutation writes an ``access_audit`` row (``governance.quality_policy.update`` /
``governance.quality_waiver.grant``) carrying the policy body or the waived verdict, so a
change of gate can always be attributed.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from .auth import get_authenticated_user_id, validate_authentication
from .database import db
from .import_export_quality_policy import (
    DEFAULT_OVERRIDE_ROLES,
    DEFAULT_WAIVER_TTL_HOURS,
    SCOPE_EXPORT,
    SCOPE_IMPORT,
    QualityPolicy,
    QualityThresholds,
    effective_role_slug,
    load_tenant_policy,
    policy_content_fingerprint,
    policy_from_row,
    record_quality_waiver,
    role_may_override,
)
from .models import (
    QualityPolicyOut,
    QualityPolicyPutRequest,
    QualityPolicyThresholdsOut,
    QualityPolicyVersionListResponse,
    QualityWaiverCreateRequest,
    QualityWaiverListResponse,
    QualityWaiverOut,
    quality_waiver_out_from_row,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/tenants", tags=["governance"])

#: Audit actions this module writes.
AUDIT_POLICY_UPDATE = "governance.quality_policy.update"
AUDIT_WAIVER_GRANT = "governance.quality_waiver.grant"


def _tenant_id(auth_data: Dict[str, Any]) -> str:
    """Return the authenticated tenant id, or fail loudly when the context is missing."""
    tenant_id = auth_data.get("tenant_id")
    if not tenant_id:
        raise HTTPException(status_code=500, detail="Missing tenant context")
    return str(tenant_id)


def _require_tenant_admin(auth_data: Dict[str, Any]) -> str:
    """Gate a policy mutation to tenant administrators; returns the tenant id.

    The quality policy decides what may enter the catalog and what may leave it, so editing it
    is the same admin-only, user-session-only operation style guides are (an API key carries no
    administrator).
    """
    tenant_id = _tenant_id(auth_data)
    user_id = get_authenticated_user_id(auth_data)
    if not user_id or not db.is_user_tenant_admin(tenant_id, user_id):
        raise HTTPException(
            status_code=403,
            detail="Only tenant administrators can manage the import/export quality policy",
        )
    return tenant_id


def _thresholds_out(thresholds: QualityThresholds) -> QualityPolicyThresholdsOut:
    """Project resolved thresholds onto the wire model."""
    return QualityPolicyThresholdsOut(
        min_grade=thresholds.min_grade,
        min_score=thresholds.min_score,
        block_on_severity=thresholds.block_on_severity,
        min_fidelity=thresholds.min_fidelity,
        enforcement=thresholds.enforcement,
    )


def _policy_out(
    policy: QualityPolicy, row: Optional[Dict[str, Any]] = None
) -> QualityPolicyOut:
    """Project a policy (and, when present, its stored row) onto the wire model."""
    return QualityPolicyOut(
        policy_version_id=policy.policy_version_id,
        version_number=policy.version_number,
        content_fingerprint=policy.content_fingerprint,
        is_default=policy.is_default,
        import_policy=_thresholds_out(policy.import_thresholds),
        export_policy=_thresholds_out(policy.export_thresholds),
        format_overrides=dict(policy.format_overrides or {}),
        allow_override=policy.allow_override,
        override_roles=list(policy.override_roles),
        waiver_ttl_hours=policy.waiver_ttl_hours,
        actor_label=(row or {}).get("actor_label"),
        created_at=(row or {}).get("created_at"),
    )


def _audit(
    *,
    tenant_id: str,
    action: str,
    auth_data: Dict[str, Any],
    target: Optional[str],
    detail: Dict[str, Any],
) -> None:
    """Write one governance audit row (best-effort).

    Audit failures are logged and swallowed: a policy change that succeeded must not be
    reported as a failure because its audit row could not be appended — the same contract
    :mod:`app.registry_audit` uses.
    """
    try:
        db.write_access_audit(
            tenant_id=tenant_id,
            action=action,
            actor_id=get_authenticated_user_id(auth_data),
            actor_label=auth_data.get("email") or auth_data.get("username"),
            target=target,
            source="api",
            detail=detail,
        )
    except Exception:  # noqa: BLE001 - auditing never fails the governed action
        logger.warning("Failed to audit %s for tenant %s", action, tenant_id, exc_info=True)


@router.get(
    "/{tenant_slug}/governance/quality-policy",
    response_model=QualityPolicyOut,
    summary="Get the tenant's import/export quality policy",
    description=(
        "The quality policy in force for this tenant (IXH-2.3). A tenant that has never saved "
        "one gets the documented default — no floors, advisory only, override permitted — with "
        "``isDefault: true``, so an upgrade changes no behaviour.\n\n"
        "Readable by any tenant member: the import wizard renders the verdict it produces, and "
        "a user who cannot see the policy cannot understand why a commit was refused."
    ),
)
async def get_quality_policy(
    tenant_slug: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> QualityPolicyOut:
    _ = tenant_slug
    tenant_id = _tenant_id(auth_data)
    row = db.get_latest_import_export_quality_policy(tenant_id)
    return _policy_out(policy_from_row(row), row)


@router.get(
    "/{tenant_slug}/governance/quality-policy/versions",
    response_model=QualityPolicyVersionListResponse,
    summary="List saved quality-policy versions",
    description=(
        "The tenant's saved policy versions, newest first. Policy rows are immutable, so this "
        "is the change history: every verdict names the ``policyVersionId`` it applied."
    ),
)
async def list_quality_policy_versions(
    tenant_slug: str,
    limit: int = Query(50, ge=1, le=200, description="Maximum versions to return."),
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> QualityPolicyVersionListResponse:
    _ = tenant_slug
    tenant_id = _tenant_id(auth_data)
    rows = db.list_import_export_quality_policy_versions(tenant_id, limit=limit)
    versions = [_policy_out(policy_from_row(row), row) for row in rows]
    return QualityPolicyVersionListResponse(versions=versions, count=len(versions))


def _merged_thresholds(
    current: QualityThresholds, requested: Optional[QualityPolicyThresholdsOut]
) -> QualityThresholds:
    """Apply a requested scope block over the current one.

    An omitted scope keeps what the tenant already has, so raising the import floor never
    silently resets the export contract.
    """
    if requested is None:
        return current
    return QualityThresholds(
        min_grade=requested.min_grade,
        min_score=requested.min_score,
        block_on_severity=requested.block_on_severity,
        min_fidelity=requested.min_fidelity,
        enforcement=requested.enforcement,
    )


def _thresholds_body(thresholds: QualityThresholds, *, scope: str) -> Dict[str, Any]:
    """The canonical body fragment for one scope — the fingerprint and audit input.

    ``minFidelity`` is emitted **only when set** and **only for the export scope**: the floor is
    export-only (an import has no target to project fidelity against), and omitting an unset floor
    keeps the fingerprint of a policy that does not use it byte-identical to what pre-IXH-2.5
    saves produced, so re-saving an unchanged policy does not read as a content change.

    Args:
        thresholds: The resolved thresholds for the scope.
        scope: ``import`` | ``export``.

    Returns:
        The camelCase body fragment.
    """
    body: Dict[str, Any] = {
        "minGrade": thresholds.min_grade,
        "minScore": thresholds.min_score,
        "blockOnSeverity": thresholds.block_on_severity,
        "enforcement": thresholds.enforcement,
    }
    if scope != SCOPE_IMPORT and thresholds.min_fidelity is not None:
        body["minFidelity"] = thresholds.min_fidelity
    return body


def _validate_format_overrides(overrides: Dict[str, Any]) -> Dict[str, Any]:
    """Reject an override map the resolver could not interpret.

    Silently ignoring a malformed override would be the worst outcome: the tenant believes a
    format is gated and it is not. The shape is ``{format key: {scope: {field: value}}}``.

    Args:
        overrides: The requested override map.

    Returns:
        The normalized map (format keys lowercased, as the resolver matches them).

    Raises:
        HTTPException: 422 when the map is not the documented shape.
    """
    normalized: Dict[str, Any] = {}
    for key, block in (overrides or {}).items():
        if not isinstance(block, dict):
            raise HTTPException(
                status_code=422,
                detail=f"formatOverrides['{key}'] must be an object of scope blocks",
            )
        scoped: Dict[str, Any] = {}
        for scope, fields in block.items():
            if scope not in ("import", "export"):
                raise HTTPException(
                    status_code=422,
                    detail=(
                        f"formatOverrides['{key}'] has unknown scope '{scope}' "
                        "(expected 'import' or 'export')"
                    ),
                )
            if not isinstance(fields, dict):
                raise HTTPException(
                    status_code=422,
                    detail=f"formatOverrides['{key}']['{scope}'] must be an object",
                )
            # Validate through the same model the tenant tier uses, so an override cannot
            # express a grade, score, severity, or enforcement mode the resolver would drop.
            try:
                QualityPolicyThresholdsOut.model_validate(fields)
            except Exception as exc:  # noqa: BLE001 - surfaced as a 422 with the field detail
                raise HTTPException(
                    status_code=422,
                    detail=f"formatOverrides['{key}']['{scope}'] is invalid: {exc}",
                ) from exc
            scoped[scope] = dict(fields)
        normalized[str(key).strip().lower()] = scoped
    return normalized


@router.put(
    "/{tenant_slug}/governance/quality-policy",
    response_model=QualityPolicyOut,
    summary="Save a new version of the tenant's import/export quality policy",
    description=(
        "Append a new policy version (IXH-2.3). Policy rows are immutable so that a verdict "
        "recorded against a version stays reproducible; omitted sections carry forward from the "
        "current version.\n\n"
        "Tenant administrators only. The change is written to the access audit with the full "
        "policy body."
    ),
)
async def put_quality_policy(
    tenant_slug: str,
    body: QualityPolicyPutRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> QualityPolicyOut:
    _ = tenant_slug
    tenant_id = _require_tenant_admin(auth_data)
    current = load_tenant_policy(tenant_id)

    import_thresholds = _merged_thresholds(current.import_thresholds, body.import_policy)
    export_thresholds = _merged_thresholds(current.export_thresholds, body.export_policy)
    overrides = (
        _validate_format_overrides(body.format_overrides)
        if body.format_overrides is not None
        else dict(current.format_overrides or {})
    )
    allow_override = (
        body.allow_override if body.allow_override is not None else current.allow_override
    )
    override_roles = (
        [str(role).strip().lower() for role in body.override_roles if str(role or "").strip()]
        if body.override_roles is not None
        else list(current.override_roles or DEFAULT_OVERRIDE_ROLES)
    )
    ttl_hours = (
        body.waiver_ttl_hours
        if body.waiver_ttl_hours is not None
        else (current.waiver_ttl_hours or DEFAULT_WAIVER_TTL_HOURS)
    )

    import_body = _thresholds_body(import_thresholds, scope=SCOPE_IMPORT)
    export_body = _thresholds_body(export_thresholds, scope=SCOPE_EXPORT)
    fingerprint = policy_content_fingerprint(
        {
            "import": import_body,
            "export": export_body,
            "formatOverrides": overrides,
            "allowOverride": allow_override,
            "overrideRoles": sorted(override_roles),
            "waiverTtlHours": ttl_hours,
        }
    )

    try:
        row = db.insert_import_export_quality_policy(
            tenant_id=tenant_id,
            content_fingerprint=fingerprint,
            import_min_grade=import_thresholds.min_grade,
            import_min_score=import_thresholds.min_score,
            import_block_on_severity=import_thresholds.block_on_severity,
            import_enforcement=import_thresholds.enforcement,
            export_min_grade=export_thresholds.min_grade,
            export_min_score=export_thresholds.min_score,
            export_block_on_severity=export_thresholds.block_on_severity,
            export_enforcement=export_thresholds.enforcement,
            export_min_fidelity=export_thresholds.min_fidelity,
            format_overrides=overrides,
            allow_override=allow_override,
            override_roles=override_roles,
            waiver_ttl_hours=int(ttl_hours),
            actor_user_id=get_authenticated_user_id(auth_data),
            actor_label=auth_data.get("email") or auth_data.get("username"),
        )
    except Exception as exc:  # noqa: BLE001 - a rejected policy is a 400, never a 500
        logger.exception("Failed to save the quality policy for tenant %s", tenant_id)
        raise HTTPException(
            status_code=400, detail=f"Could not save the quality policy: {exc}"
        ) from exc
    if not row:
        raise HTTPException(status_code=400, detail="Could not save the quality policy")

    saved = policy_from_row(row)
    _audit(
        tenant_id=tenant_id,
        action=AUDIT_POLICY_UPDATE,
        auth_data=auth_data,
        target=saved.policy_version_id,
        detail={
            "versionNumber": saved.version_number,
            "contentFingerprint": saved.content_fingerprint,
            "import": import_body,
            "export": export_body,
            "formatOverrides": overrides,
            "allowOverride": allow_override,
            "overrideRoles": override_roles,
            "waiverTtlHours": int(ttl_hours),
            "previousVersionId": current.policy_version_id,
        },
    )
    return _policy_out(saved, row)


@router.get(
    "/{tenant_slug}/governance/quality-waivers",
    response_model=QualityWaiverListResponse,
    summary="List import/export quality waivers",
    description=(
        "The tenant's recorded waivers, newest first (IXH-2.3). By default only waivers that "
        "are still honoured are returned; pass ``activeOnly=false`` to include expired ones, "
        "which the shared waiver-expiry sweep has already notified on."
    ),
)
async def list_quality_waivers(
    tenant_slug: str,
    scope: Optional[str] = Query(
        None, description="Restrict to 'import' or 'export'; omit for both."
    ),
    active_only: bool = Query(
        True, alias="activeOnly", description="Drop waivers whose expiry has passed."
    ),
    limit: int = Query(100, ge=1, le=500, description="Maximum waivers to return."),
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> QualityWaiverListResponse:
    _ = tenant_slug
    tenant_id = _tenant_id(auth_data)
    if scope is not None and scope not in ("import", "export"):
        raise HTTPException(status_code=422, detail="scope must be 'import' or 'export'")
    rows: List[Dict[str, Any]] = db.list_import_export_quality_waivers(
        tenant_id, scope=scope, active_only=active_only, limit=limit
    )
    waivers = [quality_waiver_out_from_row(row) for row in rows]
    return QualityWaiverListResponse(waivers=waivers, count=len(waivers))


@router.post(
    "/{tenant_slug}/governance/quality-waivers",
    response_model=QualityWaiverOut,
    status_code=201,
    summary="Record a waiver against a blocking quality verdict",
    description=(
        "Record accepted risk so a blocked import (or delivery) may proceed (IXH-2.3). The "
        "waiver carries the actor, the reason, the scope, and an expiry of the policy's "
        "``waiverTtlHours``; the gate honours it until then, after which the shared "
        "waiver-expiry sweep has already warned the tenant.\n\n"
        "Refused with 403 when the policy forbids overrides or does not name the caller's "
        "effective role — the check is server-side, so a client cannot grant itself one."
    ),
)
async def create_quality_waiver(
    tenant_slug: str,
    body: QualityWaiverCreateRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> QualityWaiverOut:
    _ = tenant_slug
    tenant_id = _tenant_id(auth_data)
    user_id = get_authenticated_user_id(auth_data)
    if not user_id:
        raise HTTPException(
            status_code=403,
            detail=(
                "Recording a quality waiver requires an authenticated user; an API key carries "
                "no role the policy could name."
            ),
        )

    policy = load_tenant_policy(tenant_id)
    role = effective_role_slug(tenant_id, user_id)
    if not policy.allow_override:
        raise HTTPException(
            status_code=403,
            detail="The tenant's quality policy does not permit overrides",
        )
    if not role_may_override(policy, role):
        permitted = ", ".join(policy.override_roles) or "no role"
        raise HTTPException(
            status_code=403,
            detail=(
                f"Your role ({role or 'none'}) may not waive this policy; "
                f"permitted roles: {permitted}"
            ),
        )

    try:
        row = record_quality_waiver(
            tenant_id=tenant_id,
            scope=body.scope or SCOPE_IMPORT,
            subject_key=body.subject_key,
            reason=body.reason,
            policy=policy,
            actor_user_id=user_id,
            actor_label=auth_data.get("email") or auth_data.get("username"),
            actor_role=role,
            subject_label=body.subject_label,
            format_key=body.format_key,
            report_fingerprint=body.report_fingerprint,
            score=body.score,
            grade=body.grade,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - a rejected waiver is a 400, never a 500
        logger.exception("Failed to record a quality waiver for tenant %s", tenant_id)
        raise HTTPException(
            status_code=400, detail=f"Could not record the waiver: {exc}"
        ) from exc
    if not row:
        raise HTTPException(status_code=400, detail="Could not record the waiver")

    waiver = quality_waiver_out_from_row(row)
    _audit(
        tenant_id=tenant_id,
        action=AUDIT_WAIVER_GRANT,
        auth_data=auth_data,
        target=waiver.id,
        detail={
            "scope": waiver.scope,
            "subjectKey": waiver.subject_key,
            "subjectLabel": waiver.subject_label,
            "formatKey": waiver.format_key,
            "reportFingerprint": waiver.report_fingerprint,
            "score": waiver.score,
            "grade": waiver.grade,
            "reason": waiver.reason,
            "expiresAt": str(waiver.expires_at) if waiver.expires_at else None,
            "actorRole": role,
            "policyVersionId": waiver.policy_version_id,
        },
    )
    return waiver
