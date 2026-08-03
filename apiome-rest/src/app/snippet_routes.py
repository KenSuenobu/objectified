"""Per-operation snippet endpoints — SDK-2.3 (#4487).

The HTTP surface over :mod:`app.snippet_render`, the single source of truth for
per-operation usage snippets (install + call code in ``ts`` / ``python`` / ``curl``).
Two routes share the renderer:

* **``GET /v1/versions/{tenant_slug}/{project_id}/{version_record_id}/snippets/{operation_id}``**
  — authenticated (JWT or API key). Follows the sibling agent-outputs API: the URL
  ``tenant_slug`` is decorative and the token's ``tenant_id`` scopes every read, only
  **published** revisions are eligible (400 otherwise), and the canonical content comes
  from :func:`app.canonical_persistence.load_canonical_api`.
* **``GET /v1/browse/tenants/{tenant_slug}/projects/{project_slug}/versions/{version_slug}/snippets/{operation_id}``**
  — anonymous, slug-addressed, for the public browse surface (SDK-3.3 snippet tabs and
  the SIM-3.5 Try It copy-as-code). Resolves through
  :func:`app.export_source.load_public_export_source`, so private / draft / unknown
  versions are a uniform 404, and shares the MFX-7.3 public-export rate limit.

Both take ``?lang=`` (``ts`` / ``python`` / ``curl``, with browse aliases ``fetch`` /
``httpx``), address the operation by OpenAPI ``operationId``, canonical name, or the
canonical key itself (``operation_id`` is a ``:path`` parameter, so URL-encoded keys like
``GET%20/pets/%7Bid%7D`` resolve for paradigms without operationIds), and serve
deterministic, content-addressed responses with ``ETag`` / ``If-None-Match`` 304 support.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from .auth import validate_authentication
from .canonical_model import CanonicalApi, Operation
from .canonical_persistence import load_canonical_api
from .database import db
from .export_source import ExportSourceError, load_public_export_source
from .public_export_guards import enforce_public_export_rate_limit
from .revision_deprecation import is_uuid_string
from .snippet_render import (
    SUPPORTED_LANGS,
    SnippetRenderError,
    find_operation,
    render_snippet,
    resolve_lang,
)

versions_router = APIRouter(prefix="/v1/versions", tags=["snippets"])
browse_router = APIRouter(prefix="/v1/browse", tags=["browse"])

# Short enough that a re-publish propagates promptly; the ETag makes repeat reads free.
_SNIPPET_MAX_AGE = 300

_LANG_QUERY = Query(
    ...,
    description="Snippet language: ts | python | curl (aliases: fetch → ts, httpx → python).",
)

_COMMON_RESPONSES = {
    304: {"description": "Not modified (ETag matched If-None-Match)."},
    400: {"description": "Unknown lang value."},
    404: {"description": "Operation not found in the version's canonical content."},
    422: {"description": "The operation has no HTTP binding (no snippet is defined)."},
}


# ===========================================================================
# Response models
# ===========================================================================


class SnippetOperationRef(BaseModel):
    """The resolved operation a snippet was rendered for."""

    model_config = ConfigDict(extra="forbid")

    operation_id: Optional[str] = Field(
        default=None, description="The source operationId, when the format declares one."
    )
    name: str = Field(description="The canonical operation name.")
    key: str = Field(description="The stable canonical key (e.g. ``GET /pets/{id}``).")
    method: str = Field(description="Upper-case HTTP method.")
    path: str = Field(description="The route template (e.g. ``/pets/{id}``).")


class SnippetPlaceholderModel(BaseModel):
    """One token in the snippet the caller should substitute before running it."""

    model_config = ConfigDict(extra="forbid")

    token: str = Field(description="The literal token in the snippet (``PET_ID``, ``$API_KEY``).")
    kind: str = Field(description="path | query | header | server | secret.")
    name: str = Field(description="The source parameter/variable name.")
    location: Optional[str] = Field(
        default=None,
        description="For secret placeholders, where the credential travels (header | query).",
    )


class SnippetRequestModel(BaseModel):
    """The synthesized example request the snippet encodes (for value substitution)."""

    model_config = ConfigDict(extra="forbid")

    method: str = Field(description="Upper-case HTTP method.")
    url: str = Field(description="Absolute example URL with placeholder values filled in.")
    headers: Dict[str, str] = Field(
        default_factory=dict, description="Example request headers, placeholders applied."
    )
    body: Optional[str] = Field(
        default=None, description="Raw example body text, or null for body-less requests."
    )


class SnippetResponse(BaseModel):
    """One rendered install + call snippet for one operation and language."""

    model_config = ConfigDict(extra="forbid")

    lang: str = Field(description="The canonical language the snippet was rendered in.")
    install: Optional[str] = Field(
        default=None, description="Shell command installing the dependency, or null."
    )
    code: str = Field(description="The runnable call snippet.")
    operation: SnippetOperationRef
    request: SnippetRequestModel
    placeholders: List[SnippetPlaceholderModel] = Field(default_factory=list)


class PublicSnippetResponse(SnippetResponse):
    """The anonymous-surface snippet response, echoing the resolved slug coordinates."""

    tenant_slug: str = Field(description="The owning tenant's slug, as requested.")
    project_slug: str = Field(description="The project (artifact) slug, as requested.")
    version_slug: str = Field(description="The version label, as requested (e.g. ``1.0.0``).")
    version_record_id: str = Field(description="The resolved revision (``versions.id``).")
    version_label: Optional[str] = Field(
        default=None, description="The resolved revision's source-declared version label."
    )


# ===========================================================================
# Shared helpers
# ===========================================================================


def _require_public_snippet_rate_limit(request: Request) -> None:
    """FastAPI dependency: reuse the MFX-7.3 public-export rate limit for snippet reads."""
    enforce_public_export_rate_limit(request)


def _resolve_lang_or_400(lang: str) -> str:
    """Resolve the requested ``lang`` to its canonical key, or raise 400."""
    resolved = resolve_lang(lang)
    if resolved is None:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown lang '{lang}'; expected one of {', '.join(SUPPORTED_LANGS)} "
            "(aliases: fetch, httpx)",
        )
    return resolved


def _find_operation_or_404(api: CanonicalApi, operation_id: str) -> Operation:
    """Find the addressed operation in the canonical content, or raise 404."""
    op = find_operation(api, operation_id)
    if op is None:
        raise HTTPException(status_code=404, detail=f"Operation not found: {operation_id}")
    return op


def _render_or_422(api: CanonicalApi, op: Operation, lang: str) -> SnippetResponse:
    """Render one snippet, mapping non-HTTP operations to 422."""
    try:
        render = render_snippet(api, op, lang)
    except SnippetRenderError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return SnippetResponse(
        lang=render.lang,
        install=render.install,
        code=render.code,
        operation=SnippetOperationRef(
            operation_id=op.extras.get("operationId"),
            name=op.name,
            key=op.key,
            method=render.request.method,
            path=op.http_path or "",
        ),
        request=SnippetRequestModel(
            method=render.request.method,
            url=render.request.url,
            headers=render.request.headers,
            body=render.request.body,
        ),
        placeholders=[
            SnippetPlaceholderModel(
                token=p.token, kind=p.kind, name=p.name, location=p.location
            )
            for p in render.placeholders
        ],
    )


def _etag_for(payload: BaseModel) -> str:
    """Content-addressed strong ETag over the response JSON (rendering is deterministic)."""
    digest = hashlib.sha256(
        json.dumps(payload.model_dump(), sort_keys=True).encode("utf-8")
    ).hexdigest()
    return f'"{digest}"'


def _if_none_match_hit(if_none_match: Optional[str], etag: str) -> bool:
    """Return ``True`` when the client's ``If-None-Match`` already holds ``etag``.

    Tolerates the weak-validator ``W/`` prefix, the ``*`` wildcard, and a comma-separated
    candidate list (same semantics as the sibling agent-outputs route).
    """
    if not if_none_match:
        return False
    for candidate in if_none_match.split(","):
        token = candidate.strip()
        if token == "*":
            return True
        if token.startswith("W/"):
            token = token[2:].strip()
        if token == etag:
            return True
    return False


def _cached_json_response(
    payload: BaseModel, if_none_match: Optional[str], cache_scope: str
) -> Response:
    """Serialize ``payload`` with ETag/Cache-Control, honoring ``If-None-Match`` (304)."""
    etag = _etag_for(payload)
    headers = {"Cache-Control": f"{cache_scope}, max-age={_SNIPPET_MAX_AGE}", "ETag": etag}
    if _if_none_match_hit(if_none_match, etag):
        return Response(status_code=304, headers=headers)
    return Response(
        content=payload.model_dump_json(),
        media_type="application/json",
        headers=headers,
    )


# ===========================================================================
# Authenticated surface
# ===========================================================================


@versions_router.get(
    "/{tenant_slug}/{project_id}/{version_record_id}/snippets/{operation_id:path}",
    responses={
        **_COMMON_RESPONSES,
        400: {"description": "Malformed project id, unknown lang, or unpublished revision."},
        404: {"description": "Project, version, or operation not found in tenant."},
    },
    summary="Render a usage snippet for one operation of a published revision",
)
async def get_version_operation_snippet(
    tenant_slug: str,
    project_id: str,
    version_record_id: str,
    operation_id: str,
    lang: str = _LANG_QUERY,
    if_none_match: Optional[str] = Header(None, alias="If-None-Match"),
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> Response:
    """Return the install + call snippet for one operation of a published revision.

    Resolves the project and version within the caller's tenant, requires the revision to
    be published, loads its canonical content, addresses the operation by operationId /
    name / URL-encoded canonical key, and renders the requested language deterministically
    with a content-addressed ``ETag``. A matching ``If-None-Match`` short-circuits to 304.

    Args:
        tenant_slug: Decorative; the token's tenant scopes every read.
        project_id: The project UUID within the tenant.
        version_record_id: The revision UUID (``versions.id``).
        operation_id: operationId, canonical name, or URL-encoded canonical key.
        lang: ``ts`` / ``python`` / ``curl`` (aliases ``fetch`` / ``httpx``).
        if_none_match: Standard conditional-request header.
        auth_data: The authenticated tenant context (JWT or API key).

    Returns:
        The :class:`SnippetResponse` JSON, or an empty 304.
    """
    _ = tenant_slug
    tenant_id = auth_data["tenant_id"]

    resolved_lang = _resolve_lang_or_400(lang)

    project_ref = (project_id or "").strip()
    if not is_uuid_string(project_ref):
        raise HTTPException(status_code=400, detail=f"Invalid project id: {project_id}")
    project = db.get_project_by_id(project_ref, tenant_id)
    if not project:
        raise HTTPException(status_code=404, detail=f"Project not found: {project_id}")

    if not is_uuid_string((version_record_id or "").strip()):
        raise HTTPException(status_code=404, detail=f"Version not found: {version_record_id}")
    version = db.get_version_by_id(version_record_id, tenant_id)
    if not version:
        raise HTTPException(status_code=404, detail=f"Version not found: {version_record_id}")
    if str(version.get("project_id")) != str(project["id"]):
        raise HTTPException(status_code=404, detail=f"Version not found in project: {project_id}")
    if not version.get("published"):
        raise HTTPException(
            status_code=400,
            detail="Snippets are only defined for published revisions",
        )

    canonical = load_canonical_api(db, tenant_id=tenant_id, version_id=str(version["id"]))
    if canonical is None:
        # A published revision with no persisted canonical content has no operations.
        raise HTTPException(status_code=404, detail=f"Operation not found: {operation_id}")

    op = _find_operation_or_404(canonical, operation_id)
    payload = _render_or_422(canonical, op, resolved_lang)
    return _cached_json_response(payload, if_none_match, cache_scope="private")


# ===========================================================================
# Anonymous browse surface
# ===========================================================================


@browse_router.get(
    "/tenants/{tenant_slug}/projects/{project_slug}/versions/{version_slug}/snippets/{operation_id:path}",
    responses={
        **_COMMON_RESPONSES,
        404: {
            "description": (
                "No published public version matches the slugs (private, draft, and unknown "
                "versions are indistinguishable), or the operation is unknown."
            )
        },
        429: {"description": "Public export rate limit exceeded (MFX-7.3)."},
    },
    dependencies=[Depends(_require_public_snippet_rate_limit)],
    summary="Render a usage snippet for one operation of a published public version (no auth)",
)
async def get_public_operation_snippet(
    tenant_slug: str,
    project_slug: str,
    version_slug: str,
    operation_id: str,
    lang: str = _LANG_QUERY,
    if_none_match: Optional[str] = Header(None, alias="If-None-Match"),
) -> Response:
    """Return the install + call snippet for one operation of a published public version.

    The anonymous counterpart of the authenticated snippet route, addressed by URL slugs.
    Backs the browse operation pages' snippet tabs (SDK-3.3) and the Try It copy-as-code
    feature (SIM-3.5) so both consume one source of truth.

    Args:
        tenant_slug: The owning tenant's slug.
        project_slug: The project (artifact) slug within the tenant.
        version_slug: The version label (e.g. ``1.0.0``) of the published revision.
        operation_id: operationId, canonical name, or URL-encoded canonical key.
        lang: ``ts`` / ``python`` / ``curl`` (aliases ``fetch`` / ``httpx``).
        if_none_match: Standard conditional-request header.

    Returns:
        The :class:`PublicSnippetResponse` JSON, or an empty 304.
    """
    resolved_lang = _resolve_lang_or_400(lang)

    try:
        source = load_public_export_source(tenant_slug, project_slug, version_slug)
    except ExportSourceError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc

    op = _find_operation_or_404(source.api, operation_id)
    base = _render_or_422(source.api, op, resolved_lang)
    payload = PublicSnippetResponse(
        **base.model_dump(),
        tenant_slug=tenant_slug,
        project_slug=project_slug,
        version_slug=version_slug,
        version_record_id=source.version_record_id,
        version_label=source.version_label,
    )
    return _cached_json_response(payload, if_none_match, cache_scope="public")
