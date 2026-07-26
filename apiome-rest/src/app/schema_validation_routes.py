"""``POST /v1/tenants/{tenant_slug}/schemas/{schema_ref}/validate`` — IXH-5.1 (#5113).

The REST surface of the instance-validation service (:mod:`app.schema_instance_service`).

``schema_ref`` is a **path-shaped** reference (``project/petstore/1.0.0/Pet``), so the route
declares it with the ``:path`` converter and the whole tail up to ``/validate`` is the reference.
That is deliberate: an ASGI server percent-decodes ``scope["path"]`` before routing, so a
``%2F``-encoded reference in a single segment would be split back apart and never match. The
grammar avoids ``#`` for the same class of reason — a fragment is never transmitted to a server.

The endpoint is read-only and gated on ``types:view``: validating a payload reads a schema and
writes nothing at all — no job, no revision, no audit row.
"""

from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException

from .auth import validate_authentication
from .database import db
from .permissions import Action, Resource, enforce_permission
from .schema_instance_service import (
    SchemaInstanceValidationRequest,
    SchemaInstanceValidationResponse,
    SchemaReferenceError,
    validate_schema_instance,
)

__all__ = ["router"]

router = APIRouter(prefix="/v1/tenants", tags=["schema-validation"])


@router.post(
    "/{tenant_slug}/schemas/{schema_ref:path}/validate",
    response_model=SchemaInstanceValidationResponse,
    summary="Validate a JSON or XML payload against a cataloged schema",
    description=(
        "Answer 'does this payload satisfy this schema?' for any schema Apiome holds "
        "(IXH-5.1). Nothing is persisted.\n\n"
        "**Addressing.** ``schema_ref`` is a path-shaped reference naming one of three "
        "sources:\n\n"
        "* ``project/{project_slug}/{version}[/{type}]`` — a publishable Project's revision;\n"
        "* ``catalog/{item}/{version}[/{type}]`` — a Catalog item's revision, by slug or id;\n"
        "* ``registry/{namespace}/{name}`` — a type-registry type, addressed by the same path "
        "a relative ``$ref`` inside the registry would use.\n\n"
        "``{version}`` is a source-declared version label (``1.0.0``), a revision id, or "
        "``latest``. ``{type}`` names one canonical type by its stable key (``acme.Pet``) or "
        "its source name (``Pet``); omit it to address the whole revision, which XML "
        "validation needs and which JSON validation accepts when the revision defines exactly "
        "one type.\n\n"
        "**Findings** carry the JSON Pointer into the instance, the failing keyword, what the "
        "schema expected, what the instance actually held, a human-readable message, and the "
        "JSON Pointer into the schema. Order is deterministic — instance pointer (array "
        "indices numerically), then schema pointer, keyword, message — so two runs over the "
        "same input are byte-identical and reports diff cleanly across revisions.\n\n"
        "**``valid`` is never guessed.** It is ``true`` only when a validator ran and found "
        "nothing, ``false`` only when a validator ran and found something, and ``null`` "
        "whenever no validator ran — for instance on a deployment without the XML toolchain, "
        "which reports ``validated: false`` with an ``ADAPTER_UNAVAILABLE`` diagnostic rather "
        "than passing an unchecked payload.\n\n"
        "**Bounds.** ``$ref`` resolution is depth- and fan-out-bounded and cycle-safe, and "
        "resolves only against this tenant's registry — validation performs no network fetch, "
        "and a reference that cannot be resolved is reported as a diagnostic, never ignored. "
        "The instance is bounded by the import resource guards (size, alias expansion, nesting "
        "depth); XML documents additionally pass the hardened XML parser, so no DTD, entity, "
        "or external reference is ever expanded.\n\n"
        "A payload that cannot be checked is **not** an HTTP error: the response is a 200 with "
        "``ok: false`` and a stable intake-taxonomy ``error`` code plus remediation. Only "
        "addressing faults are HTTP errors — 400 for a malformed reference, 404 for one that "
        "names nothing visible, 422 for one that resolves to material no schema can be derived "
        "from."
    ),
)
async def validate_instance_against_schema(
    tenant_slug: str,
    schema_ref: str,
    body: SchemaInstanceValidationRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> SchemaInstanceValidationResponse:
    """Validate ``body``'s payload against the schema named by ``schema_ref``.

    Args:
        tenant_slug: The tenant in the URL (the authenticated tenant is what actually scopes
            every lookup).
        schema_ref: The path-shaped schema reference.
        body: The payload and validation options.
        auth_data: The authenticated principal, injected by
            :func:`app.auth.validate_authentication`.

    Returns:
        The validation report.

    Raises:
        HTTPException: 400/404/422 for an addressing fault, 403 without ``types:view``.
    """
    # ``types:view`` rather than a write action: this reads a schema and checks a payload
    # against it. A caller who may not see types has no business validating against them.
    enforce_permission(db, auth_data, Resource.TYPES, Action.VIEW)
    tenant_id = auth_data.get("tenant_id")
    if not tenant_id:
        raise HTTPException(status_code=403, detail="No tenant context for this credential.")
    _ = tenant_slug

    try:
        return await validate_schema_instance(
            schema_ref, body, tenant_id=str(tenant_id)
        )
    except SchemaReferenceError as exc:
        detail: Dict[str, Any] = {"message": str(exc)}
        if exc.candidates:
            detail["candidates"] = exc.candidates
        raise HTTPException(status_code=exc.status_code, detail=detail) from exc
