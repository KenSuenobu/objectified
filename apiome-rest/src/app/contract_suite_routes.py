"""``POST /v1/tenants/{tenant_slug}/contracts/{version_ref}/suite`` — ECA-1.1 (#4729).

The REST surface of the contract-suite compiler (:mod:`app.contract_suite_service`).

``version_ref`` is the same path-shaped reference the schema endpoints take, minus the trailing
type segment (``project/petstore/1.0.0``), declared with the ``:path`` converter for the same
reason: an ASGI server percent-decodes ``scope["path"]`` before routing, so a ``%2F``-encoded
reference in a single segment would be split back apart and never match.

The endpoint is read-only and gated on ``versions:view``. Compiling a suite reads a version and
writes nothing — no job, no revision, no audit row — and a caller who may not see a version has
no business compiling its contract.
"""

from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException

from .auth import validate_authentication
from .contract_suite_service import (
    ContractSuiteCompileRequest,
    ContractSuiteResponse,
    SchemaReferenceError,
    compile_version_contract_suite,
)
from .database import db
from .permissions import Action, Resource, enforce_permission

__all__ = ["router"]

router = APIRouter(prefix="/v1/tenants", tags=["contract-assurance"])


@router.post(
    "/{tenant_slug}/contracts/{version_ref:path}/suite",
    response_model=ContractSuiteResponse,
    summary="Compile a deterministic contract suite from a version",
    description=(
        "Compile a published version into an executable contract suite (ECA-1.1): one case "
        "per declared example, per schema-valid generated body, and per required negative "
        "case, with the operation, the source, and the expected outcome on every one of "
        "them.\n\n"
        "**Addressing** is the schema-reference grammar without a type segment — "
        "``project/{project_slug}/{version}`` for a Project revision or "
        "``catalog/{item}/{version}`` for a Catalog revision — so a suite is compiled from the "
        "same coordinate a payload is validated against.\n\n"
        "**Compilation is deterministic.** The same version and the same options produce a "
        "byte-identical manifest and therefore the same ``digest``, which is what lets a CI "
        "gate assert that a deployment was verified against a specific contract.\n\n"
        "**Declared examples come first.** A request body the author wrote is compiled ahead "
        "of anything generated, and is the only kind of case marked ``synthetic: false``. An "
        "example that does not satisfy its own schema is reported and left out rather than "
        "compiled into a test a correct implementation would fail.\n\n"
        "**Nothing is skipped silently.** A streaming operation, a non-HTTP paradigm, an "
        "XML-only body, a structured parameter, an undeclared status code — each appears in "
        "``findings`` with a stable code, so partial coverage can never read as full "
        "coverage.\n\n"
        "**A suite carries no target and no credentials.** Paths are relative and security "
        "requirements are reported for the runner to satisfy; targets are configured "
        "separately.\n\n"
        "Nothing is persisted. A version that yields no suite is **not** an HTTP error: the "
        "response is a 200 with ``ok: false`` and a stable intake-taxonomy ``error`` code plus "
        "remediation. Only addressing faults are HTTP errors — 400 for a malformed or "
        "type-qualified reference, 404 for one that names nothing visible, 422 for one that "
        "resolves to material no canonical model can be rebuilt from."
    ),
)
async def compile_contract_suite_for_version(
    tenant_slug: str,
    version_ref: str,
    body: ContractSuiteCompileRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> ContractSuiteResponse:
    """Compile the contract suite for the version named by ``version_ref``.

    Args:
        tenant_slug: The tenant in the URL (the authenticated tenant is what actually scopes
            every lookup).
        version_ref: The path-shaped version reference.
        body: The compiler options.
        auth_data: The authenticated principal, injected by
            :func:`app.auth.validate_authentication`.

    Returns:
        The compiled suite.

    Raises:
        HTTPException: 400/404/422 for an addressing fault, 403 without ``versions:view``.
    """
    enforce_permission(db, auth_data, Resource.VERSIONS, Action.VIEW)
    tenant_id = auth_data.get("tenant_id")
    if not tenant_id:
        raise HTTPException(status_code=403, detail="No tenant context for this credential.")
    _ = tenant_slug

    try:
        return compile_version_contract_suite(version_ref, body, tenant_id=str(tenant_id))
    except SchemaReferenceError as exc:
        detail: Dict[str, Any] = {"message": str(exc)}
        if exc.candidates:
            detail["candidates"] = exc.candidates
        raise HTTPException(status_code=exc.status_code, detail=detail) from exc
