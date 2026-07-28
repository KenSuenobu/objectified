"""Evidence-backed verification policy API — ECA-3.1 (#4734).

Governance surface for the gate that :mod:`app.verification_policy_evaluate` produces:

* ``GET  …/governance/verification-policy`` — policy in force (documented default when none).
* ``PUT  …/governance/verification-policy`` — append a new immutable version (tenant admin).
* ``GET  …/governance/verification-policy/versions`` — version history.
* ``POST …/governance/verification-policy/evaluate`` — auditable decision citing evidence IDs.
* ``GET  …/governance/verification-policy/evaluations`` — recent decisions.

Every evaluate persists a ``verification_policy_evaluations`` row and writes
``governance.verification_policy.evaluate`` to access audit. Breaking posture is whole-spec
via ``version_changelogs`` (#4475); consumer-aware acknowledgment is #4479 follow-up.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from .auth import get_authenticated_user_id, validate_authentication
from .database import db
from .models import (
    VerificationPolicyDecisionOut,
    VerificationPolicyEvaluateRequest,
    VerificationPolicyEvaluationListResponse,
    VerificationPolicyEvaluationOut,
    VerificationPolicyGateResultOut,
    VerificationPolicyOut,
    VerificationPolicyPutRequest,
    VerificationPolicyVersionListResponse,
)
from .verification_policy import VerificationPolicy, policy_from_row
from .verification_policy_evaluate import PolicyDecision
from .verification_policy_store import (
    PolicyValidationError,
    evaluate_and_record,
    list_evaluations,
    list_policy_versions,
    load_tenant_policy,
    save_tenant_policy,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/tenants", tags=["governance"])

AUDIT_POLICY_UPDATE = "governance.verification_policy.update"
AUDIT_POLICY_EVALUATE = "governance.verification_policy.evaluate"


def _tenant_id(auth_data: Dict[str, Any]) -> str:
    """Return the authenticated tenant id, or fail loudly when the context is missing."""
    tenant_id = auth_data.get("tenant_id")
    if not tenant_id:
        raise HTTPException(status_code=500, detail="Missing tenant context")
    return str(tenant_id)


def _require_tenant_admin(auth_data: Dict[str, Any]) -> str:
    """Gate a policy mutation to tenant administrators; returns the tenant id."""
    tenant_id = _tenant_id(auth_data)
    user_id = get_authenticated_user_id(auth_data)
    if not user_id or not db.is_user_tenant_admin(tenant_id, user_id):
        raise HTTPException(
            status_code=403,
            detail=(
                "Only tenant administrators can manage the verification publish/deploy policy"
            ),
        )
    return tenant_id


def _policy_out(
    policy: VerificationPolicy, row: Optional[Dict[str, Any]] = None
) -> VerificationPolicyOut:
    """Project a policy onto the wire model."""
    return VerificationPolicyOut(
        policy_version_id=policy.policy_version_id,
        version_number=policy.version_number,
        content_fingerprint=policy.content_fingerprint,
        is_default=policy.is_default,
        required_suite_digests=list(policy.required_suite_digests),
        max_evidence_age_seconds=policy.max_evidence_age_seconds,
        required_target_network_class=policy.required_target_network_class,
        purpose=policy.purpose,
        breaking_change_action=policy.breaking_change_action,
        enforcement=policy.enforcement,
        actor_label=(row or {}).get("actor_label"),
        created_at=(row or {}).get("created_at"),
    )


def _decision_out(
    decision: PolicyDecision, evaluation_id: Optional[str]
) -> VerificationPolicyDecisionOut:
    """Project a pure decision (+ optional persisted id) onto the shared wire shape."""
    return VerificationPolicyDecisionOut(
        passed=decision.passed,
        enforcement=decision.enforcement,
        policy_version_id=decision.policy_version_id,
        policy_content_fingerprint=decision.policy_content_fingerprint,
        evaluation_id=evaluation_id,
        evidence_run_ids=list(decision.evidence_run_ids),
        gate_results=[
            VerificationPolicyGateResultOut(
                gate=g.gate,
                passed=g.passed,
                detail=dict(g.detail),
                action=g.action,
            )
            for g in decision.gate_results
        ],
        warnings=[dict(w) for w in decision.warnings],
        purpose=decision.purpose,
        skipped=decision.skipped,
    )


def _evaluation_out(row: Dict[str, Any]) -> VerificationPolicyEvaluationOut:
    """Adapt a stored evaluation row onto the wire model."""
    evidence_ids = row.get("evidence_run_ids") or []
    if isinstance(evidence_ids, str):
        evidence_ids = [evidence_ids]
    return VerificationPolicyEvaluationOut(
        id=str(row["id"]),
        tenant_id=str(row["tenant_id"]),
        project_id=str(row["project_id"]) if row.get("project_id") else None,
        version_record_id=(
            str(row["version_record_id"]) if row.get("version_record_id") else None
        ),
        policy_version_id=(
            str(row["policy_version_id"]) if row.get("policy_version_id") else None
        ),
        policy_content_fingerprint=str(row.get("policy_content_fingerprint") or ""),
        purpose=str(row.get("purpose") or ""),
        passed=bool(row.get("passed")),
        enforcement=str(row.get("enforcement") or "advisory"),
        gate_results=list(row.get("gate_results") or []),
        evidence_run_ids=[str(x) for x in evidence_ids],
        warnings=list(row.get("warnings") or []),
        actor_label=row.get("actor_label"),
        actor_kind=row.get("actor_kind"),
        evaluated_at=row.get("evaluated_at"),
    )


def _audit(
    *,
    tenant_id: str,
    action: str,
    auth_data: Dict[str, Any],
    target: Optional[str],
    detail: Dict[str, Any],
) -> None:
    """Write one governance audit row (best-effort)."""
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
    except Exception:  # noqa: BLE001
        logger.warning("Failed to audit %s for tenant %s", action, tenant_id, exc_info=True)


def _resolve_subject(
    *,
    tenant_id: str,
    tenant_slug: str,
    body: VerificationPolicyEvaluateRequest,
) -> tuple[Optional[str], Optional[str]]:
    """Resolve ``(project_id, version_record_id)`` from the evaluate request.

    Raises:
        HTTPException: 422 when the subject cannot be resolved.
    """
    project_id = body.project_id
    version_record_id = body.version_id

    if body.project_slug and not project_id:
        project = db.get_project_by_slug(body.project_slug, tenant_id)
        if not project:
            raise HTTPException(
                status_code=422,
                detail=f"Project not found: {body.project_slug!r}",
            )
        project_id = str(project["id"])

    if body.version_slug:
        if not body.project_slug and not project_id:
            raise HTTPException(
                status_code=422,
                detail="versionSlug requires projectSlug or projectId",
            )
        project_slug = body.project_slug
        if not project_slug and project_id:
            proj = db.get_project_by_id(project_id, tenant_id)
            project_slug = str((proj or {}).get("slug") or "")
        if not project_slug:
            raise HTTPException(status_code=422, detail="Could not resolve project slug")
        version = db.get_version_by_slugs(tenant_slug, project_slug, body.version_slug)
        if not version:
            raise HTTPException(
                status_code=422,
                detail=f"Version not found: {body.version_slug!r}",
            )
        version_record_id = str(version["id"])
        if not project_id:
            project_id = str(version.get("project_id") or "") or None

    if version_record_id and not project_id:
        version = db.get_version_by_id(version_record_id, tenant_id)
        if not version:
            raise HTTPException(
                status_code=422,
                detail=f"Version not found: {version_record_id}",
            )
        project_id = str(version.get("project_id") or "") or None

    return project_id, version_record_id


@router.get(
    "/{tenant_slug}/governance/verification-policy",
    response_model=VerificationPolicyOut,
    summary="Get the tenant's evidence-backed verification policy",
    description=(
        "The publish/deploy verification policy in force (ECA-3.1). A tenant that has never "
        "saved one gets the documented default — advisory, no required digests, warn on "
        "whole-spec breaking — with ``isDefault: true``."
    ),
)
async def get_verification_policy(
    tenant_slug: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> VerificationPolicyOut:
    _ = tenant_slug
    tenant_id = _tenant_id(auth_data)
    row = db.get_latest_verification_policy(tenant_id)
    return _policy_out(policy_from_row(row), row)


@router.get(
    "/{tenant_slug}/governance/verification-policy/versions",
    response_model=VerificationPolicyVersionListResponse,
    summary="List saved verification-policy versions",
)
async def list_verification_policy_versions(
    tenant_slug: str,
    limit: int = Query(50, ge=1, le=200),
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> VerificationPolicyVersionListResponse:
    _ = tenant_slug
    tenant_id = _tenant_id(auth_data)
    rows = list_policy_versions(tenant_id, limit=limit)
    versions = [_policy_out(policy_from_row(row), row) for row in rows]
    return VerificationPolicyVersionListResponse(versions=versions, count=len(versions))


@router.put(
    "/{tenant_slug}/governance/verification-policy",
    response_model=VerificationPolicyOut,
    summary="Save a new version of the tenant's verification policy",
    description=(
        "Append a new policy version (ECA-3.1). Rows are immutable. Omitted fields carry "
        "forward from the current version. Tenant administrators only."
    ),
)
async def put_verification_policy(
    tenant_slug: str,
    body: VerificationPolicyPutRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> VerificationPolicyOut:
    _ = tenant_slug
    tenant_id = _require_tenant_admin(auth_data)
    current = load_tenant_policy(tenant_id)

    digests = (
        list(body.required_suite_digests)
        if body.required_suite_digests is not None
        else list(current.required_suite_digests)
    )
    if body.clear_max_evidence_age_seconds:
        max_age: Optional[int] = None
    elif body.max_evidence_age_seconds is not None:
        max_age = body.max_evidence_age_seconds
    else:
        max_age = current.max_evidence_age_seconds

    if body.clear_required_target_network_class:
        network: Optional[str] = None
    elif body.required_target_network_class is not None:
        network = body.required_target_network_class
    else:
        network = current.required_target_network_class

    purpose = body.purpose if body.purpose is not None else current.purpose
    breaking = (
        body.breaking_change_action
        if body.breaking_change_action is not None
        else current.breaking_change_action
    )
    enforcement = (
        body.enforcement if body.enforcement is not None else current.enforcement
    )

    try:
        policy = save_tenant_policy(
            tenant_id=tenant_id,
            required_suite_digests=digests,
            max_evidence_age_seconds=max_age,
            required_target_network_class=network,
            purpose=purpose,
            breaking_change_action=breaking,
            enforcement=enforcement,
            actor_user_id=get_authenticated_user_id(auth_data),
            actor_label=auth_data.get("email") or auth_data.get("username"),
        )
    except PolicyValidationError as exc:
        raise HTTPException(status_code=422, detail=exc.errors) from exc

    row = db.get_latest_verification_policy(tenant_id)
    _audit(
        tenant_id=tenant_id,
        action=AUDIT_POLICY_UPDATE,
        auth_data=auth_data,
        target=policy.policy_version_id,
        detail={
            "policyVersionId": policy.policy_version_id,
            "versionNumber": policy.version_number,
            "contentFingerprint": policy.content_fingerprint,
            "requiredSuiteDigests": list(policy.required_suite_digests),
            "maxEvidenceAgeSeconds": policy.max_evidence_age_seconds,
            "requiredTargetNetworkClass": policy.required_target_network_class,
            "purpose": policy.purpose,
            "breakingChangeAction": policy.breaking_change_action,
            "enforcement": policy.enforcement,
        },
    )
    return _policy_out(policy, row)


@router.post(
    "/{tenant_slug}/governance/verification-policy/evaluate",
    response_model=VerificationPolicyDecisionOut,
    summary="Evaluate publish/deploy policy against evidence",
    description=(
        "Evaluate the tenant's verification policy for a subject revision. The decision "
        "cites exact ECA-1.3 evidence run IDs, persists an evaluation row, and is the same "
        "payload the dashboard and publish precheck consume. Breaking findings are "
        "whole-spec via version changelogs (#4475); consumer-aware acknowledgment is #4479."
    ),
)
async def evaluate_verification_policy_route(
    tenant_slug: str,
    body: VerificationPolicyEvaluateRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> VerificationPolicyDecisionOut:
    tenant_id = _tenant_id(auth_data)
    purpose = (body.purpose or "").strip().lower()
    if purpose not in ("publish", "deploy"):
        raise HTTPException(
            status_code=422, detail="purpose must be 'publish' or 'deploy'"
        )

    project_id, version_record_id = _resolve_subject(
        tenant_id=tenant_id, tenant_slug=tenant_slug, body=body
    )

    actor_kind = "api_key" if auth_data.get("auth_method") == "api_key" else "user"
    decision, evaluation_id = evaluate_and_record(
        tenant_id=tenant_id,
        purpose=purpose,
        project_id=project_id,
        version_record_id=version_record_id,
        actor_user_id=get_authenticated_user_id(auth_data),
        actor_label=auth_data.get("email") or auth_data.get("username"),
        actor_kind=actor_kind,
    )
    out = _decision_out(decision, evaluation_id)
    _audit(
        tenant_id=tenant_id,
        action=AUDIT_POLICY_EVALUATE,
        auth_data=auth_data,
        target=evaluation_id or version_record_id,
        detail=out.model_dump(by_alias=True),
    )
    return out


@router.get(
    "/{tenant_slug}/governance/verification-policy/evaluations",
    response_model=VerificationPolicyEvaluationListResponse,
    summary="List recent verification-policy evaluations",
)
async def list_verification_policy_evaluations_route(
    tenant_slug: str,
    version_record_id: Optional[str] = Query(
        None,
        alias="versionRecordId",
        description="Optional catalog revision filter.",
    ),
    limit: int = Query(50, ge=1, le=200),
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> VerificationPolicyEvaluationListResponse:
    _ = tenant_slug
    tenant_id = _tenant_id(auth_data)
    rows = list_evaluations(
        tenant_id, version_record_id=version_record_id, limit=limit
    )
    evaluations = [_evaluation_out(row) for row in rows]
    return VerificationPolicyEvaluationListResponse(
        evaluations=evaluations, count=len(evaluations)
    )


def decision_payload_for_http(decision: PolicyDecision, evaluation_id: Optional[str]) -> Dict[str, Any]:
    """CamelCase decision dict for HTTPException detail (publish precheck)."""
    return _decision_out(decision, evaluation_id).model_dump(by_alias=True)
