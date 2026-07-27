"""Tenant intake secret-scrub policy API — MFI-29.6 (#4393).

The governance surface for the mode :mod:`app.intake_scrub_policy` resolves and
:func:`app.import_source_pipeline.scrub_intake_source` applies:

* ``GET  …/governance/secret-scrub-policy`` — the policy in force (the enforce default when
  the tenant has never saved one), readable by any tenant member so the import wizard can
  explain why a stored source came back with ``«redacted»`` in it.
* ``PUT  …/governance/secret-scrub-policy`` — save a new **version**. Policy rows are
  immutable, so every save appends; the write is tenant-administrator-only and audit-logged.
* ``GET  …/governance/secret-scrub-policy/versions`` — the version history, newest first.

Turning redaction off is a security-relevant act, which is why it is administrator-only and
why every save writes an ``access_audit`` row carrying the full policy body: a source that
persisted with a live token in it must be traceable to the decision that allowed it.
"""

from __future__ import annotations

import logging
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException, Query

from .auth import get_authenticated_user_id, validate_authentication
from .database import db
from .intake_scrub_policy import (
    ALWAYS_ENFORCED_FORMATS,
    ScrubPolicy,
    load_tenant_scrub_policy,
    scrub_policy_content_fingerprint,
    scrub_policy_from_row,
)
from .models import (
    SecretScrubPolicyFormatOverride,
    SecretScrubPolicyOut,
    SecretScrubPolicyPutRequest,
    SecretScrubPolicyVersionListResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/tenants", tags=["governance"])

#: Audit action this module writes.
AUDIT_SCRUB_POLICY_UPDATE = "governance.secret_scrub_policy.update"


def _tenant_id(auth_data: Dict[str, Any]) -> str:
    """Return the authenticated tenant id, or fail loudly when the context is missing."""
    tenant_id = auth_data.get("tenant_id")
    if not tenant_id:
        raise HTTPException(status_code=500, detail="Missing tenant context")
    return str(tenant_id)


def _require_tenant_admin(auth_data: Dict[str, Any]) -> str:
    """Gate a policy mutation to tenant administrators; returns the tenant id.

    Relaxing the scrub policy decides whether live credentials may persist in the catalog, so
    editing it is the same admin-only, user-session-only operation the quality policy is (an
    API key carries no administrator).
    """
    tenant_id = _tenant_id(auth_data)
    user_id = get_authenticated_user_id(auth_data)
    if not user_id or not db.is_user_tenant_admin(tenant_id, user_id):
        raise HTTPException(
            status_code=403,
            detail="Only tenant administrators can manage the intake secret-scrub policy",
        )
    return tenant_id


def _policy_out(
    policy: ScrubPolicy, row: Dict[str, Any] | None = None
) -> SecretScrubPolicyOut:
    """Project a policy (and, when present, its stored row) onto the wire model."""
    return SecretScrubPolicyOut(
        policy_version_id=policy.policy_version_id,
        version_number=policy.version_number,
        content_fingerprint=policy.content_fingerprint,
        is_default=policy.is_default,
        mode=policy.mode,
        entropy_detection=policy.entropy_detection,
        format_overrides=dict(policy.format_overrides or {}),
        always_enforced_formats=sorted(ALWAYS_ENFORCED_FORMATS),
        actor_label=(row or {}).get("actor_label"),
        created_at=(row or {}).get("created_at"),
    )


def _audit(
    *,
    tenant_id: str,
    auth_data: Dict[str, Any],
    target: str | None,
    detail: Dict[str, Any],
) -> None:
    """Write the policy-change audit row (best-effort).

    Audit failures are logged and swallowed: a policy change that succeeded must not be
    reported as a failure because its audit row could not be appended — the same contract
    :mod:`app.quality_policy_routes` uses.
    """
    try:
        db.write_access_audit(
            tenant_id=tenant_id,
            action=AUDIT_SCRUB_POLICY_UPDATE,
            actor_id=get_authenticated_user_id(auth_data),
            actor_label=auth_data.get("email") or auth_data.get("username"),
            target=target,
            source="api",
            detail=detail,
        )
    except Exception:  # noqa: BLE001 - auditing never fails the governed action
        logger.warning(
            "Failed to audit %s for tenant %s", AUDIT_SCRUB_POLICY_UPDATE, tenant_id, exc_info=True
        )


def _validate_format_overrides(overrides: Dict[str, Any]) -> Dict[str, Any]:
    """Reject an override map the resolver could not interpret.

    Silently ignoring a malformed override is the worst outcome available here: the tenant
    believes a format runs warn-only (and is surprised by redactions) or believes it is
    enforced (and persists a live token). The shape is ``{format key: {"mode": ...}}``.

    Args:
        overrides: The requested override map.

    Returns:
        The normalized map, format keys lowercased as the resolver matches them.

    Raises:
        HTTPException: 422 when the map is not the documented shape.
    """
    normalized: Dict[str, Any] = {}
    for key, block in (overrides or {}).items():
        if not isinstance(block, dict):
            raise HTTPException(
                status_code=422,
                detail=f"formatOverrides['{key}'] must be an object with a 'mode' field",
            )
        try:
            validated = SecretScrubPolicyFormatOverride.model_validate(block)
        except Exception as exc:  # noqa: BLE001 - surfaced as a 422 with the field detail
            raise HTTPException(
                status_code=422, detail=f"formatOverrides['{key}'] is invalid: {exc}"
            ) from exc
        normalized[str(key).strip().lower()] = {"mode": validated.mode}
    return normalized


@router.get(
    "/{tenant_slug}/governance/secret-scrub-policy",
    response_model=SecretScrubPolicyOut,
    summary="Get the tenant's intake secret-scrub policy",
    description=(
        "The secret-scrub policy in force for this tenant (MFI-29.6). A tenant that has never "
        "saved one gets the documented default — enforce, with entropy detection on — with "
        "``isDefault: true``, which is the behaviour every tenant already had, so an upgrade "
        "changes nothing.\n\n"
        "Readable by any tenant member: an import summary reports what was redacted, and a "
        "user who cannot see the policy cannot understand why."
    ),
)
async def get_secret_scrub_policy(
    tenant_slug: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> SecretScrubPolicyOut:
    _ = tenant_slug
    tenant_id = _tenant_id(auth_data)
    row = db.get_latest_intake_secret_scrub_policy(tenant_id)
    return _policy_out(scrub_policy_from_row(row), row)


@router.get(
    "/{tenant_slug}/governance/secret-scrub-policy/versions",
    response_model=SecretScrubPolicyVersionListResponse,
    summary="List saved secret-scrub policy versions",
    description=(
        "The tenant's saved scrub-policy versions, newest first. Policy rows are immutable, so "
        "this is the change history: every import summary names the ``policyVersionId`` that "
        "governed it."
    ),
)
async def list_secret_scrub_policy_versions(
    tenant_slug: str,
    limit: int = Query(50, ge=1, le=200, description="Maximum versions to return."),
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> SecretScrubPolicyVersionListResponse:
    _ = tenant_slug
    tenant_id = _tenant_id(auth_data)
    rows = db.list_intake_secret_scrub_policy_versions(tenant_id, limit=limit)
    versions = [_policy_out(scrub_policy_from_row(row), row) for row in rows]
    return SecretScrubPolicyVersionListResponse(versions=versions, count=len(versions))


@router.put(
    "/{tenant_slug}/governance/secret-scrub-policy",
    response_model=SecretScrubPolicyOut,
    summary="Save a new version of the tenant's intake secret-scrub policy",
    description=(
        "Append a new policy version (MFI-29.6). Policy rows are immutable so that an import "
        "summary recorded against a version stays reproducible; omitted fields carry forward "
        "from the current version.\n\n"
        "Tenant administrators only, and audited with the full policy body: switching to "
        "``warn_only`` means uploaded credentials persist unredacted, which must be "
        "attributable. Note that the collection and captured-traffic formats listed in "
        "``alwaysEnforcedFormats`` stay enforced unless a per-format override says otherwise."
    ),
)
async def put_secret_scrub_policy(
    tenant_slug: str,
    body: SecretScrubPolicyPutRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> SecretScrubPolicyOut:
    _ = tenant_slug
    tenant_id = _require_tenant_admin(auth_data)
    current = load_tenant_scrub_policy(tenant_id)

    mode = body.mode if body.mode is not None else current.mode
    entropy_detection = (
        body.entropy_detection
        if body.entropy_detection is not None
        else current.entropy_detection
    )
    overrides = (
        _validate_format_overrides(body.format_overrides)
        if body.format_overrides is not None
        else dict(current.format_overrides or {})
    )

    fingerprint = scrub_policy_content_fingerprint(
        mode=mode, entropy_detection=entropy_detection, format_overrides=overrides
    )

    try:
        row = db.insert_intake_secret_scrub_policy(
            tenant_id=tenant_id,
            content_fingerprint=fingerprint,
            mode=mode,
            entropy_detection=bool(entropy_detection),
            format_overrides=overrides,
            actor_user_id=get_authenticated_user_id(auth_data),
            actor_label=auth_data.get("email") or auth_data.get("username"),
        )
    except Exception as exc:  # noqa: BLE001 - a rejected policy is a 400, never a 500
        logger.exception("Failed to save the secret-scrub policy for tenant %s", tenant_id)
        raise HTTPException(
            status_code=400, detail=f"Could not save the secret-scrub policy: {exc}"
        ) from exc
    if not row:
        raise HTTPException(status_code=400, detail="Could not save the secret-scrub policy")

    saved = scrub_policy_from_row(row)
    _audit(
        tenant_id=tenant_id,
        auth_data=auth_data,
        target=saved.policy_version_id,
        detail={
            "versionNumber": saved.version_number,
            "contentFingerprint": saved.content_fingerprint,
            "mode": mode,
            "entropyDetection": bool(entropy_detection),
            "formatOverrides": overrides,
            "previousMode": current.mode,
            "previousVersionId": current.policy_version_id,
        },
    )
    return _policy_out(saved, row)
