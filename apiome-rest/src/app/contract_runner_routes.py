"""``POST /v1/tenants/{tenant_slug}/contracts/{version_ref}/run`` — ECA-2.1 (#4732).

Compile a version's contract suite, resolve a verification target, execute every case under
the target's policy, and record immutable ECA-1.3 evidence.

Authorization requires both ``versions:view`` (to compile the suite) and
``verification_evidence:create`` (to persist the run). Target selection is audited through
the existing resolve path (``verification_targets:view``).
"""

from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException, Response

from .auth import validate_authentication
from .contract_runner_service import (
    ContractRunRequest,
    ContractRunResponse,
    SchemaReferenceError,
    run_version_contract_suite,
)
from .database import db
from .permissions import Action, Resource, enforce_permission
from .verification_evidence import EvidenceValidationError
from .verification_evidence_store import actor_from_auth
from .verification_target import CODE_NOT_FOUND, TargetValidationError

__all__ = ["router"]

router = APIRouter(prefix="/v1/tenants", tags=["contract-assurance"])

_TARGET_STATUS_BY_CODE = {
    CODE_NOT_FOUND: 404,
}


def _tenant_id(auth_data: Dict[str, Any]) -> str:
    """Return the authenticated tenant id, or refuse."""
    tenant_id = auth_data.get("tenant_id")
    if not tenant_id:
        raise HTTPException(status_code=403, detail="No tenant context for this credential.")
    return str(tenant_id)


@router.post(
    "/{tenant_slug}/contracts/{version_ref:path}/run",
    response_model=ContractRunResponse,
    summary="Execute a contract suite against a verification target",
    description=(
        "Compile the version's deterministic contract suite (ECA-1.1), resolve the named "
        "verification target (ECA-1.2), execute every case under the target's policy "
        "(timeouts, concurrency, transport-only retries, mutating-method gate), validate "
        "status codes and response schemas, and **always** persist the result as immutable "
        "verification evidence (ECA-1.3).\n\n"
        "**Retries never mask a contract failure.** A status or schema mismatch ends the "
        "case immediately; only transport failures (connect/timeout/network) honour "
        "`policy.retry_attempts`.\n\n"
        "**A suite carries no credentials.** Auth comes from the target's secret-free "
        "reference (`env` or `stored`); evidence snapshots the target identity only.\n\n"
        "A version that cannot yield executable cases answers **200** with `ok: false` and "
        "a stable taxonomy `error`. Addressing faults are HTTP errors (400/404/422). Target "
        "resolution faults are 400/404. Evidence submission faults are 400."
    ),
)
async def run_contract_suite_for_version(
    tenant_slug: str,
    version_ref: str,
    body: ContractRunRequest,
    response: Response,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> ContractRunResponse:
    """Run the contract suite for ``version_ref`` against ``body.target_ref``.

    Args:
        tenant_slug: Tenant in the URL (auth tenant scopes the work).
        version_ref: Path-shaped version reference.
        body: Target, compiler options, optional idempotency key and CI context.
        response: FastAPI response — status is 201 for new evidence, 200 for replay.
        auth_data: Authenticated principal.

    Returns:
        The run response with evidence when ``ok`` is true.

    Raises:
        HTTPException: Permission denials, addressing faults, target faults, evidence faults.
    """
    enforce_permission(db, auth_data, Resource.VERSIONS, Action.VIEW)
    enforce_permission(db, auth_data, Resource.VERIFICATION_EVIDENCE, Action.CREATE)
    tenant_id = _tenant_id(auth_data)
    _ = tenant_slug

    actor = actor_from_auth(auth_data)
    try:
        result = run_version_contract_suite(
            version_ref, body, tenant_id=tenant_id, actor=actor
        )
    except SchemaReferenceError as exc:
        detail: Dict[str, Any] = {"message": str(exc)}
        if exc.candidates:
            detail["candidates"] = exc.candidates
        raise HTTPException(status_code=exc.status_code, detail=detail) from exc
    except TargetValidationError as exc:
        raise HTTPException(
            status_code=_TARGET_STATUS_BY_CODE.get(exc.code, 400),
            detail={"code": exc.code, "message": str(exc)},
        ) from exc
    except EvidenceValidationError as exc:
        raise HTTPException(
            status_code=400,
            detail={"code": exc.code, "message": str(exc)},
        ) from exc

    if result.ok and result.created is True:
        response.status_code = 201
    return result
