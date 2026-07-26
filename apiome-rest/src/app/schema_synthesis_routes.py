"""``POST /v1/tenants/{tenant_slug}/schemas/{schema_ref}/synthesize`` — IXH-5.2 (#5114).

The REST surface of the sample-payload synthesizer (:mod:`app.schema_synthesis_service`).

``schema_ref`` is the same path-shaped reference the IXH-5.1 validate endpoint takes
(``project/petstore/1.0.0/Pet``), declared with the ``:path`` converter for the same reason: an
ASGI server percent-decodes ``scope["path"]`` before routing, so a ``%2F``-encoded reference in
a single segment would be split back apart and never match.

The endpoint is read-only and gated on ``types:view``. Generating payloads reads a schema and
writes nothing — no job, no revision, no audit row — and a caller who may not see a type has no
business generating payloads for it.
"""

from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException

from .auth import validate_authentication
from .database import db
from .permissions import Action, Resource, enforce_permission
from .schema_synthesis_service import (
    SchemaReferenceError,
    SchemaSynthesisRequest,
    SchemaSynthesisResponse,
    synthesize_schema_payloads,
)

__all__ = ["router"]

router = APIRouter(prefix="/v1/tenants", tags=["schema-validation"])


@router.post(
    "/{tenant_slug}/schemas/{schema_ref:path}/synthesize",
    response_model=SchemaSynthesisResponse,
    summary="Generate sample payloads — valid instances and single-constraint mutants",
    description=(
        "Generate test payloads for any schema Apiome holds (IXH-5.2): a minimal valid "
        "instance, a full valid instance, one instance per polymorphic branch, and a set of "
        "mutants that each violate exactly one constraint. Nothing is persisted.\n\n"
        "**Addressing** is identical to the validate endpoint — ``schema_ref`` is a "
        "path-shaped reference naming a Project revision "
        "(``project/{project_slug}/{version}[/{type}]``), a Catalog revision "
        "(``catalog/{item}/{version}[/{type}]``), or a type-registry type "
        "(``registry/{namespace}/{name}``) — so a payload can be generated and then validated "
        "against the very same reference.\n\n"
        "**Everything returned is synthetic.** The response, every instance, and every value's "
        "provenance carry an explicit label. These payloads were generated from the schema; "
        "they are not real data and must never be presented as a captured example.\n\n"
        "**Generation is deterministic.** The same schema and ``seed`` produce byte-identical "
        "payloads, so a generated fixture can be committed and re-derived. Values come from "
        "the schema's own ``const``, ``examples``, ``default``, or ``enum`` before anything is "
        "invented, and each value's ``provenance`` records which.\n\n"
        "**Mutants are verified, not assumed.** Each one must provoke exactly one violation, "
        "of exactly the constraint it targets; candidates that fail for the wrong reason (or "
        "do not fail at all) are dropped and counted in ``rejected_mutants``. The available "
        "kinds are `required-missing`, `type-wrong`, `enum-out-of-range`, `pattern-violated`, "
        "`bound-exceeded`, `additional-properties-injected`, and "
        "`discriminator-mismatched`.\n\n"
        "**Recursion terminates.** Generation stops descending into optional structure at "
        "``depth_limit`` and at any reference cycle, and says so in ``diagnostics`` rather "
        "than truncating silently. External ``$ref``s resolve only against this tenant's "
        "registry; no network fetch is ever performed.\n\n"
        "A schema that cannot be generated from is **not** an HTTP error: the response is a "
        "200 with ``ok: false`` and a stable intake-taxonomy ``error`` code plus remediation. "
        "Only addressing faults are HTTP errors — 400 for a malformed reference, 404 for one "
        "that names nothing visible, 422 for one that resolves to material no schema can be "
        "derived from."
    ),
)
async def synthesize_payloads_for_schema(
    tenant_slug: str,
    schema_ref: str,
    body: SchemaSynthesisRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> SchemaSynthesisResponse:
    """Generate sample payloads for the schema named by ``schema_ref``.

    Args:
        tenant_slug: The tenant in the URL (the authenticated tenant is what actually scopes
            every lookup).
        schema_ref: The path-shaped schema reference.
        body: What to generate.
        auth_data: The authenticated principal, injected by
            :func:`app.auth.validate_authentication`.

    Returns:
        The generated payloads.

    Raises:
        HTTPException: 400/404/422 for an addressing fault, 403 without ``types:view``.
    """
    enforce_permission(db, auth_data, Resource.TYPES, Action.VIEW)
    tenant_id = auth_data.get("tenant_id")
    if not tenant_id:
        raise HTTPException(status_code=403, detail="No tenant context for this credential.")
    _ = tenant_slug

    try:
        return synthesize_schema_payloads(schema_ref, body, tenant_id=str(tenant_id))
    except SchemaReferenceError as exc:
        detail: Dict[str, Any] = {"message": str(exc)}
        if exc.candidates:
            detail["candidates"] = exc.candidates
        raise HTTPException(status_code=exc.status_code, detail=detail) from exc
