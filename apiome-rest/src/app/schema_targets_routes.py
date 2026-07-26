"""``GET /v1/tenants/{tenant_slug}/schemas/{schema_ref}/targets`` — IXH-5.3 (#5115).

The REST surface of the schema-targets listing (:mod:`app.schema_targets_service`): what a
revision offers the Schema Test Bench to validate against — its named types and the operation
request/response bodies that resolve to them.

``schema_ref`` is the same path-shaped reference the IXH-5.1 validate and IXH-5.2 synthesize
endpoints take, *without* the trailing type segment (``project/petstore/1.0.0``), declared with
the ``:path`` converter for the same reason those are: an ASGI server percent-decodes
``scope["path"]`` before routing, so a ``%2F``-encoded reference in a single segment would be
split back apart and never match.

The endpoint is read-only and gated on ``types:view`` exactly like validate/synthesize: listing
a revision's schemas reads the schemas and writes nothing.
"""

from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException

from .auth import validate_authentication
from .database import db
from .permissions import Action, Resource, enforce_permission
from .schema_reference import SchemaReferenceError
from .schema_targets_service import SchemaTargetsResponse, list_schema_targets

__all__ = ["router"]

router = APIRouter(prefix="/v1/tenants", tags=["schema-validation"])


@router.get(
    "/{tenant_slug}/schemas/{schema_ref:path}/targets",
    response_model=SchemaTargetsResponse,
    summary="List the schemas a revision offers as validation targets",
    description=(
        "Enumerate everything one revision offers the Schema Test Bench (IXH-5.3): its named "
        "types and the operation request/response bodies that resolve to a named type, each "
        "addressable by appending the type key to the same reference the validate (IXH-5.1) "
        "and synthesize (IXH-5.2) endpoints take.\n\n"
        "**Addressing.** ``schema_ref`` is the IXH-5.1 path-shaped reference *without* its "
        "trailing type segment — ``project/{project_slug}/{version}`` or "
        "``catalog/{item}/{version}``; ``{version}`` is a version label, a revision id, or "
        "``latest``. A ``registry/…`` reference is rejected with 400: a registry type is a "
        "single stored schema, already enumerated by the type-registry API.\n\n"
        "**Determinism.** Types are sorted by key; operation bodies by operation key, role, "
        "then status code — two calls over the same revision are byte-identical.\n\n"
        "**Honesty.** A body defined inline (no named type) cannot be addressed by the "
        "reference grammar; such bodies are counted in a diagnostic, never silently dropped "
        "and never invented. Nothing is persisted.\n\n"
        "Only addressing faults are HTTP errors — 400 for a malformed, registry, or "
        "type-qualified reference, 404 for one that names nothing visible, 422 for one that "
        "resolves to material no canonical model can be rebuilt from."
    ),
)
async def list_targets_for_schema_ref(
    tenant_slug: str,
    schema_ref: str,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> SchemaTargetsResponse:
    """List the validation targets of the revision named by ``schema_ref``.

    Args:
        tenant_slug: The tenant in the URL (the authenticated tenant is what actually scopes
            every lookup).
        schema_ref: The path-shaped revision reference (no type segment).
        auth_data: The authenticated principal, injected by
            :func:`app.auth.validate_authentication`.

    Returns:
        The targets listing.

    Raises:
        HTTPException: 400/404/422 for an addressing fault, 403 without ``types:view``.
    """
    # ``types:view`` rather than a write action: this lists schemas and writes nothing. A
    # caller who may not see types has no business enumerating them.
    enforce_permission(db, auth_data, Resource.TYPES, Action.VIEW)
    tenant_id = auth_data.get("tenant_id")
    if not tenant_id:
        raise HTTPException(status_code=403, detail="No tenant context for this credential.")
    _ = tenant_slug

    try:
        return list_schema_targets(schema_ref, tenant_id=str(tenant_id))
    except SchemaReferenceError as exc:
        detail: Dict[str, Any] = {"message": str(exc)}
        if exc.candidates:
            detail["candidates"] = exc.candidates
        raise HTTPException(status_code=exc.status_code, detail=detail) from exc
