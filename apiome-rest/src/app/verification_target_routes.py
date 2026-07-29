"""``/v1/tenants/{tenant_slug}/verification-targets`` — ECA-1.2 (#4730).

The REST surface of the environment and target registry: define where a compiled contract suite
(ECA-1.1) is executed, and select one for a run.

**Authorization** uses the ``verification_targets`` RBAC resource added by apiome-db V211.
Managing a target is a security decision — it names a URL and a credential reference — so
create/edit/delete require the matching action, which the built-in grids give Owner and Admin.
*Viewing* is what resolving needs, and every member (including the default Editor grid) has it, so
a developer or a CI runner can verify their own work without being able to redefine where
verification points.

**Selection is a POST, not a GET**, because ``/resolve`` is not a read: it re-checks the target
against its network policy and writes an audit entry either way. That is also why a denial here
still leaves a trace — a probe for target names is exactly what an auditor wants to see.

**No response from this router can contain a credential.** The stored schema cannot hold one
(V211's CHECK constraints), and a resolve returns the *reference* — an environment-variable name
the runner reads itself, or a vault id the runner service unseals at request time.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, ConfigDict, Field

from .auth import validate_authentication
from .database import db
from .permissions import Action, Resource, enforce_permission
from .verification_target import (
    CODE_NOT_FOUND,
    CODE_SLUG_TAKEN,
    ResolvedTarget,
    TargetValidationError,
    VerificationTargetInput,
    VerificationTargetPatch,
    VerificationTargetRecord,
)
from .verification_target_store import (
    TARGET_AUDIT_ACTIONS,
    actor_from_auth,
    create_target,
    delete_target,
    get_target,
    list_audit,
    list_targets,
    resolve_target,
    update_target,
)

__all__ = ["router"]

router = APIRouter(prefix="/v1/tenants", tags=["contract-assurance"])

# A refusal maps onto the HTTP status that matches *what kind* of refusal it is, so a client can
# act on the status and read the code for the detail.
_STATUS_BY_CODE = {
    CODE_NOT_FOUND: 404,
    CODE_SLUG_TAKEN: 409,
}


class VerificationTargetListResponse(BaseModel):
    """Every live target defined in the tenant."""

    model_config = ConfigDict(extra="forbid")

    targets: List[VerificationTargetRecord] = Field(
        default_factory=list, description="The tenant's live targets, newest first."
    )
    count: int = Field(description="How many targets were returned.")


class ResolveTargetRequest(BaseModel):
    """What a runner says when it selects a target."""

    model_config = ConfigDict(extra="forbid")

    suite_digest: Optional[str] = Field(
        default=None,
        description=(
            "The ECA-1.1 suite digest this run will execute. Recorded on the audit entry so a "
            "target selection can be tied to the exact contract it was selected for."
        ),
        max_length=200,
    )


class TargetAuditEntry(BaseModel):
    """One entry from the target audit ledger."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(description="Audit entry id.")
    target_id: Optional[str] = Field(default=None, description="Target acted on, when found.")
    target_slug: Optional[str] = Field(default=None, description="Slug as named at the time.")
    action: str = Field(description=f"One of: {', '.join(TARGET_AUDIT_ACTIONS)}.")
    outcome: str = Field(description="`success`, `denied`, or `failure`.")
    reason: Optional[str] = Field(default=None, description="Stable code for a non-success.")
    actor_id: Optional[str] = Field(default=None, description="Acting user, when attributable.")
    actor_label: Optional[str] = Field(default=None, description="Actor email/name at the time.")
    actor_kind: str = Field(description="`user`, `api_key` (a CI runner), or `system`.")
    detail: Dict[str, Any] = Field(
        default_factory=dict, description="Non-secret context; never credential material."
    )
    created_at: Optional[str] = Field(default=None, description="When the action happened.")


class TargetAuditResponse(BaseModel):
    """The audit ledger read."""

    model_config = ConfigDict(extra="forbid")

    entries: List[TargetAuditEntry] = Field(
        default_factory=list, description="Ledger entries, newest first."
    )
    count: int = Field(description="How many entries were returned.")


def _tenant_id(auth_data: Dict[str, Any]) -> str:
    """Return the authenticated tenant id, or refuse.

    Args:
        auth_data: The resolved auth context.

    Returns:
        The tenant id.

    Raises:
        HTTPException: 403 when the credential carries no tenant.
    """
    tenant_id = auth_data.get("tenant_id")
    if not tenant_id:
        raise HTTPException(status_code=403, detail="No tenant context for this credential.")
    return str(tenant_id)


def _http_error(exc: TargetValidationError) -> HTTPException:
    """Translate a taxonomy error into the HTTP error a client sees.

    Args:
        exc: The refusal.

    Returns:
        The ``HTTPException`` to raise — 404 for an unknown target, 409 for a taken slug, and 400
        for every definition fault, always carrying ``{"code", "message"}`` so a client branches
        on the code rather than the prose.
    """
    return HTTPException(
        status_code=_STATUS_BY_CODE.get(exc.code, 400),
        detail={"code": exc.code, "message": str(exc)},
    )


@router.get(
    "/{tenant_slug}/verification-targets",
    response_model=VerificationTargetListResponse,
    summary="List the tenant's verification targets",
    description=(
        "Every live verification target defined in the tenant, newest first.\n\n"
        "A target is **secret-free by construction**: it carries a credential *reference* (an "
        "environment-variable name, or an id in the encrypted credential vault), never a "
        "credential, so this response needs no redacted variant.\n\n"
        "Requires `verification_targets:view` — the same permission a run needs to resolve one."
    ),
)
async def list_verification_targets(
    tenant_slug: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> VerificationTargetListResponse:
    """List the tenant's live targets.

    Args:
        tenant_slug: The tenant in the URL (the authenticated tenant is what actually scopes it).
        auth_data: The authenticated principal.

    Returns:
        The targets.

    Raises:
        HTTPException: 403 without ``verification_targets:view``.
    """
    enforce_permission(db, auth_data, Resource.VERIFICATION_TARGETS, Action.VIEW)
    _ = tenant_slug
    records = list_targets(_tenant_id(auth_data))
    return VerificationTargetListResponse(targets=records, count=len(records))


@router.post(
    "/{tenant_slug}/verification-targets",
    response_model=VerificationTargetRecord,
    status_code=201,
    summary="Define a verification target",
    description=(
        "Define where a compiled contract suite may be executed.\n\n"
        "**The URL is vetted before anything is stored.** http/https only, no `user:pass@` "
        "authority, and — for the default `public` network class — every address the host "
        "resolves to must be globally routable. A target that must reach an internal address "
        "declares `network_class: private`, which requires an `approval_reason`; the "
        "authenticated caller is recorded as its approver.\n\n"
        "**The credential is a reference, never a value.** `auth.kind: env` stores an "
        "environment-variable NAME the runner reads from its own environment; `auth.kind: "
        "stored` stores the id of a row in the encrypted credential vault. Both shapes are "
        "validated here and constrained again in the database, so a pasted token is rejected "
        "rather than stored.\n\n"
        "Requires `verification_targets:create`."
    ),
)
async def create_verification_target(
    tenant_slug: str,
    body: VerificationTargetInput,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> VerificationTargetRecord:
    """Define a new target.

    Args:
        tenant_slug: The tenant in the URL.
        body: The target definition.
        auth_data: The authenticated principal.

    Returns:
        The stored target.

    Raises:
        HTTPException: 400 for a rejected definition, 409 for a slug already in use, 403 without
            ``verification_targets:create``.
    """
    user_id = enforce_permission(
        db, auth_data, Resource.VERIFICATION_TARGETS, Action.CREATE, target=body.slug
    )
    _ = tenant_slug
    try:
        return create_target(
            _tenant_id(auth_data), body, actor=actor_from_auth(auth_data, user_id)
        )
    except TargetValidationError as exc:
        raise _http_error(exc) from exc


@router.get(
    "/{tenant_slug}/verification-targets/{target_ref}",
    response_model=VerificationTargetRecord,
    summary="Read one verification target",
    description=(
        "Read a target by its slug or its id. Accepting both is what lets CI name a stable "
        "handle (`staging`) while an evidence record names an immutable id.\n\n"
        "Requires `verification_targets:view`."
    ),
)
async def get_verification_target(
    tenant_slug: str,
    target_ref: str,
    include_deleted: bool = Query(
        default=False,
        description=(
            "Resolve retired targets too. Evidence records name a target id, and that reference "
            "has to keep resolving after the target is retired."
        ),
    ),
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> VerificationTargetRecord:
    """Read one target.

    Args:
        tenant_slug: The tenant in the URL.
        target_ref: The target's slug or id.
        include_deleted: Include retired targets.
        auth_data: The authenticated principal.

    Returns:
        The target.

    Raises:
        HTTPException: 404 when nothing matches, 403 without ``verification_targets:view``.
    """
    enforce_permission(db, auth_data, Resource.VERIFICATION_TARGETS, Action.VIEW)
    _ = tenant_slug
    try:
        return get_target(_tenant_id(auth_data), target_ref, include_deleted=include_deleted)
    except TargetValidationError as exc:
        raise _http_error(exc) from exc


@router.patch(
    "/{tenant_slug}/verification-targets/{target_ref}",
    response_model=VerificationTargetRecord,
    summary="Update a verification target",
    description=(
        "Apply a partial update. Omitted fields are left alone; `auth` and `policy` are replaced "
        "wholesale when present, because a half-applied credential reference is exactly the "
        "state that puts a value in the wrong column.\n\n"
        "The result is validated as a whole: supplying `network_class: private` and its "
        "`approval_reason` together is one coherent change, and moving a target back to `public` "
        "re-runs the address check its URL previously skipped.\n\n"
        "Requires `verification_targets:edit`."
    ),
)
async def update_verification_target(
    tenant_slug: str,
    target_ref: str,
    body: VerificationTargetPatch,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> VerificationTargetRecord:
    """Update a target.

    Args:
        tenant_slug: The tenant in the URL.
        target_ref: The target's slug or id.
        body: The changes.
        auth_data: The authenticated principal.

    Returns:
        The updated target.

    Raises:
        HTTPException: 400 for a rejected change, 404 when nothing matches, 403 without
            ``verification_targets:edit``.
    """
    user_id = enforce_permission(
        db, auth_data, Resource.VERIFICATION_TARGETS, Action.EDIT, target=target_ref
    )
    _ = tenant_slug
    tenant_id = _tenant_id(auth_data)
    try:
        record = get_target(tenant_id, target_ref)
        return update_target(
            tenant_id, record, body, actor=actor_from_auth(auth_data, user_id)
        )
    except TargetValidationError as exc:
        raise _http_error(exc) from exc


@router.delete(
    "/{tenant_slug}/verification-targets/{target_ref}",
    status_code=204,
    summary="Retire a verification target",
    description=(
        "Soft-delete a target. The definition stays readable by id (`?include_deleted=true`) so "
        "an evidence record that names it keeps resolving, and the slug is freed for reuse.\n\n"
        "Requires `verification_targets:delete`."
    ),
)
async def delete_verification_target(
    tenant_slug: str,
    target_ref: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> Response:
    """Retire a target.

    Args:
        tenant_slug: The tenant in the URL.
        target_ref: The target's slug or id.
        auth_data: The authenticated principal.

    Returns:
        An empty 204 response.

    Raises:
        HTTPException: 404 when nothing matches, 403 without ``verification_targets:delete``.
    """
    # NB: return a Response (not `-> None`) — under `from __future__ import annotations`
    # FastAPI evaluates a `None` return annotation to NoneType and asserts that a 204
    # cannot carry a body. Mirrors the spec-import and export-job cancel routes.
    user_id = enforce_permission(
        db, auth_data, Resource.VERIFICATION_TARGETS, Action.DELETE, target=target_ref
    )
    _ = tenant_slug
    tenant_id = _tenant_id(auth_data)
    try:
        record = get_target(tenant_id, target_ref)
    except TargetValidationError as exc:
        raise _http_error(exc) from exc
    delete_target(tenant_id, record, actor=actor_from_auth(auth_data, user_id))
    return Response(status_code=204)


@router.post(
    "/{tenant_slug}/verification-targets/{target_ref}/resolve",
    response_model=ResolvedTarget,
    summary="Resolve a verification target for a run",
    description=(
        "Select a target for a verification run — **the audited moment a definition becomes "
        "traffic**.\n\n"
        "Everything a read tolerates is refused here: a retired target, a disabled one, and a "
        "URL that no longer satisfies its network class. That last check is re-run at resolve "
        "time on purpose: DNS moves, so a hostname that resolved publicly when the target was "
        "defined can point at an internal address today while the definition looks unchanged.\n\n"
        "Success **and** refusal are written to the audit ledger, with the acting user or CI "
        "runner, so \"which target did this run use\" and \"what was turned away\" are answered "
        "from the same place.\n\n"
        "The response carries the target identity, the base URL, the policy the runner must "
        "honour, and the credential *reference* — never a credential.\n\n"
        "Requires `verification_targets:view`."
    ),
)
async def resolve_verification_target(
    tenant_slug: str,
    target_ref: str,
    body: Optional[ResolveTargetRequest] = None,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> ResolvedTarget:
    """Resolve a target for a run.

    Args:
        tenant_slug: The tenant in the URL.
        target_ref: The target's slug or id.
        body: Optional run context (the suite digest being executed).
        auth_data: The authenticated principal — a user or a CI runner.

    Returns:
        The resolved target.

    Raises:
        HTTPException: 404 when nothing matches, 400 when the target cannot be used, 403 without
            ``verification_targets:view``.
    """
    user_id = enforce_permission(
        db, auth_data, Resource.VERIFICATION_TARGETS, Action.VIEW, target=target_ref
    )
    _ = tenant_slug
    try:
        return resolve_target(
            _tenant_id(auth_data),
            target_ref,
            actor=actor_from_auth(auth_data, user_id),
            suite_digest=body.suite_digest if body else None,
        )
    except TargetValidationError as exc:
        raise _http_error(exc) from exc


@router.get(
    "/{tenant_slug}/verification-targets-audit",
    response_model=TargetAuditResponse,
    summary="Read the verification-target audit ledger",
    description=(
        "The append-only record of every target definition change and every target *selection*, "
        "including denials, newest first.\n\n"
        "Entries carry the actor and whether they were an interactive user or a CI runner "
        "(`actor_kind: api_key`). The `detail` block holds non-secret context only — an update "
        "records which field names changed, never their values, and a resolve records the "
        "credential reference *kind* but never the reference itself.\n\n"
        "Requires `verification_targets:view`."
    ),
)
async def read_verification_target_audit(
    tenant_slug: str,
    target_id: Optional[str] = Query(
        default=None, description="Restrict the ledger to one target's history."
    ),
    limit: int = Query(default=100, ge=1, le=500, description="Maximum entries to return."),
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> TargetAuditResponse:
    """Read the audit ledger.

    Args:
        tenant_slug: The tenant in the URL.
        target_id: Restrict to one target.
        limit: Maximum entries.
        auth_data: The authenticated principal.

    Returns:
        The ledger entries.

    Raises:
        HTTPException: 403 without ``verification_targets:view``.
    """
    enforce_permission(db, auth_data, Resource.VERIFICATION_TARGETS, Action.VIEW)
    _ = tenant_slug
    rows = list_audit(_tenant_id(auth_data), target_id=target_id, limit=limit)
    entries = [
        TargetAuditEntry(
            id=str(row.get("id")),
            target_id=_optional_text(row.get("target_id")),
            target_slug=row.get("target_slug"),
            action=str(row.get("action") or ""),
            outcome=str(row.get("outcome") or ""),
            reason=row.get("reason"),
            actor_id=_optional_text(row.get("actor_id")),
            actor_label=row.get("actor_label"),
            actor_kind=str(row.get("actor_kind") or "user"),
            detail=row.get("detail") if isinstance(row.get("detail"), dict) else {},
            created_at=_optional_text(row.get("created_at")),
        )
        for row in rows
    ]
    return TargetAuditResponse(entries=entries, count=len(entries))


def _optional_text(value: Any) -> Optional[str]:
    """Render a value as a string, preserving ``None``.

    Ids arrive as UUID objects and timestamps as ``datetime``; a timestamp is rendered in ISO-8601
    so a client parses it the same way it parses every other timestamp on this API.

    Args:
        value: The value to render.

    Returns:
        The string form, or ``None``.
    """
    if value is None:
        return None
    isoformat = getattr(value, "isoformat", None)
    return isoformat() if callable(isoformat) else str(value)
