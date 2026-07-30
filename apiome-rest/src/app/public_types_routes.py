"""
Public dereference of a registry type at its JSON Schema ``$id`` (no authentication).

The registry mints identity as ``{REGISTRY_BASE_URL}{namespace}/{slug(name)}``
(``schema_validation.derive_schema_id``), e.g.
``https://api.apiome.dev/types/std/v0/primitives/array``. Those values are stamped into every
schema document and stored in ``apiome.primitives.schema_id``, and relative ``$ref`` edges resolve
against them — but until now nothing served them, so an ``$id`` that looks like a URL answered 404
and no external tooling could follow a ``$ref``.

This module serves them, and **only** the platform-curated core set:

* A type is servable when its row is ``is_system AND is_public`` — the ``std/*`` namespaces V113
  seeds as visible to every tenant.
* Anything else answers 404 with an identical body, including a well-formed ``$id`` for a real
  tenant type. A tenant namespace is therefore not merely forbidden but indistinguishable from a
  path that was never minted, so the endpoint cannot be used to enumerate what a tenant owns.

That gate is the security boundary of an unauthenticated route: a tenant's own type is never
``is_system``, so no guessed path reaches one. Tenant types remain available only through the
authenticated, tenant-scoped ``/v1/primitives/{tenant_slug}/...`` surface.

The route is deliberately mounted at the bare ``/types/`` prefix rather than under ``/v1``, because
the path has to match the ``$id`` byte for byte for a dereference to mean anything.
"""

from __future__ import annotations

import json
from typing import Any, Dict

from fastapi import APIRouter, HTTPException, Response

from .database import db
from .schema_validation import REGISTRY_BASE_URL

router = APIRouter(prefix="/types", tags=["types-public"])

# JSON Schema's own media type (RFC-registered for schema documents). Generic JSON clients still
# parse it, while schema-aware tooling can content-negotiate on it.
SCHEMA_MEDIA_TYPE = "application/schema+json"

# Core types change rarely and are identical for every caller, so a short shared cache is safe and
# spares the database a lookup for every `$ref` a validator follows.
CACHE_CONTROL = "public, max-age=300"


def _not_found(schema_path: str) -> HTTPException:
    """The single 404 every miss returns, whatever the reason.

    A non-existent path, a tenant-owned type, and a private system row all produce this same
    response — distinguishing them would leak whether a given ``$id`` exists.
    """
    return HTTPException(status_code=404, detail=f"No public type at /types/{schema_path}")


@router.get(
    "/{schema_path:path}",
    summary="Get a public registry type by its $id path",
    response_class=Response,
    responses={
        200: {
            "content": {SCHEMA_MEDIA_TYPE: {}},
            "description": "The type's JSON Schema document, as stored (its `$id` included).",
        },
        404: {"description": "No publicly servable type at this path."},
    },
)
async def get_public_type(schema_path: str) -> Response:
    """Serve the JSON Schema document a registry ``$id`` names.

    ``schema_path`` is everything after ``/types/`` — namespace plus type-name slug, e.g.
    ``std/v0/primitives/array``. It is re-joined onto :data:`REGISTRY_BASE_URL` to rebuild the exact
    ``$id`` the registry derived, then matched against the stored column, so this endpoint agrees
    with ``$ref`` resolution by construction rather than by a second parsing rule.

    Args:
        schema_path: The ``$id`` path below the registry mount.

    Returns:
        The stored schema document with the JSON Schema media type.

    Raises:
        HTTPException: 404 when no ``is_system``/``is_public`` type carries that ``$id``.
    """
    path = (schema_path or "").strip().strip("/")
    if not path:
        raise _not_found(schema_path)

    schema_id = f"{REGISTRY_BASE_URL}{path}"
    row: Dict[str, Any] | None = db.get_public_type_by_schema_id(schema_id)
    if not row:
        raise _not_found(path)

    document = row.get("schema")
    if not isinstance(document, dict):
        # A row with no usable document is a data fault, not a client error.
        raise HTTPException(
            status_code=500, detail=f"Type at /types/{path} has no schema document"
        )

    return Response(
        content=json.dumps(document, indent=2, sort_keys=False),
        media_type=SCHEMA_MEDIA_TYPE,
        headers={"Cache-Control": CACHE_CONTROL},
    )
