"""Git-repository intake — REST contract (MFI-29.3, #4390).

``POST /v1/tenants/{tenant_slug}/import/git/fileset`` turns *"import ``protos/**``
from this repo at this ref"* into the payload the existing import chain already
accepts: the selected files packed as a deterministic archive, plus the detected
format, the resolved root document, and the commit the selection was read at.

The caller (the Catalog import wizard's Git card, or ``apiome import git``) then
runs the **unchanged** import flow with those bytes — pre-flight, quality gate,
``POST …/imports`` — passing the returned ``git_source`` back in
``options.git_source`` so the created revision records its repository provenance.
Splitting it this way means git intake adds a source, not a parallel pipeline: every
guard, verdict, and preview that already applies to an archive upload applies here.

Credentials are never accepted in the request body. A private repository is read
with a **stored** linked-account token (:func:`resolve_stored_git_token`), resolved
either from a registered tenant repository or from the acting user's own linked
account; nothing else can authorize the read.
"""

from __future__ import annotations

import asyncio
import base64
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from .auth import get_authenticated_user_id, validate_authentication
from .database import db
from .git_intake import (
    GitFilesetResult,
    GitIntakeError,
    GitSelector,
    fetch_git_fileset,
    pack_fileset_zip,
)
from .import_sources_routes import DetectFormatResponse
from .intake_error_taxonomy import descriptor_for
from .models import SpecImportGitSource
from .permissions import Action, Resource, enforce_permission

router = APIRouter(prefix="/v1/tenants", tags=["spec-import"])

#: Taxonomy code → HTTP status. Anything unlisted is a 422 (the caller's selection).
_STATUS_BY_CODE: Dict[str, int] = {
    "SOURCE_NOT_FOUND": 404,
    "SOURCE_AUTH_REQUIRED": 403,
    "SOURCE_UNREACHABLE": 502,
    "INPUT_TOO_LARGE": 413,
}


class GitFilesetRequest(BaseModel):
    """A repository selection to fetch as an importable fileset."""

    model_config = ConfigDict(extra="forbid")

    repo_url: str = Field(
        description="Repository URL, for example https://github.com/owner/repo."
    )
    ref: Optional[str] = Field(
        default=None,
        description="Branch, tag, or commit sha. Defaults to the repository's default branch.",
    )
    path: str = Field(
        default="",
        description=(
            "Path or glob selecting the files to import — a directory ('protos/'), an exact "
            "file, or a glob ('**/*.proto'). Empty selects the whole tree. The static prefix "
            "is stripped from member paths so sibling imports/refs keep resolving."
        ),
    )
    root: Optional[str] = Field(
        default=None,
        description=(
            "Explicit root document, relative to the selection. Required only when root "
            "auto-detection reports the selection as ambiguous."
        ),
    )
    repository_id: Optional[str] = Field(
        default=None,
        description=(
            "Registered tenant repository whose stored linked-account credential authorizes "
            "the read (private repositories)."
        ),
    )
    linked_account_id: Optional[str] = Field(
        default=None,
        description=(
            "The acting user's linked account whose stored token authorizes the read, when no "
            "registered repository is used."
        ),
    )
    include_document: bool = Field(
        default=True,
        description=(
            "Include the packed archive bytes in the response (the import payload). Set false "
            "to preview the selection — members, root, detection, commit — without them."
        ),
    )


class GitFilesetSkippedMember(BaseModel):
    """A repository file excluded from the selection, and why."""

    model_config = ConfigDict(extra="forbid")

    path: str = Field(description="Repository-relative path of the skipped file.")
    reason: str = Field(
        description=(
            "Why it was skipped: dotfile, binary-file, excluded-directory, or too-large."
        )
    )


class GitFilesetResponse(BaseModel):
    """The fetched selection: import payload, detection, and commit provenance."""

    model_config = ConfigDict(extra="forbid")

    git_source: SpecImportGitSource = Field(
        description="Provenance to echo back in options.git_source when starting the import."
    )
    filename: str = Field(
        description="Suggested filename for the packed archive (the import's source label)."
    )
    document_base64: Optional[str] = Field(
        default=None,
        description=(
            "Standard base64 of the packed archive, ready for /import/preflight and "
            "POST …/imports. Null when include_document was false."
        ),
    )
    archive_root: str = Field(
        description="Module-relative root document inside the packed archive."
    )
    members: List[str] = Field(
        default_factory=list, description="Sorted module-relative member paths."
    )
    skipped: List[GitFilesetSkippedMember] = Field(
        default_factory=list,
        description="Repository files the selection matched but did not ingest, with reasons.",
    )
    total_bytes: int = Field(description="Decoded size of every selected member, in bytes.")
    source_kind: Optional[str] = Field(
        default=None,
        description="Registry key of the adapter detection picked for the root, when importable.",
    )
    detection: DetectFormatResponse = Field(
        description="Format detection for the resolved root document."
    )


def resolve_stored_git_token(
    tenant_id: str,
    user_id: str,
    *,
    repository_id: Optional[str],
    linked_account_id: Optional[str],
) -> Optional[str]:
    """Resolve a stored credential for a private-repository read.

    Reuses the existing vault of linked-account tokens rather than introducing a
    second credential path: a registered tenant repository carries the linked
    account it was added with, and a user may otherwise name their own linked
    account. No token is ever accepted from the request.

    Args:
        tenant_id: The importing tenant.
        user_id: The acting user (a linked account is only usable by its owner).
        repository_id: Registered repository to borrow credentials from, if any.
        linked_account_id: The user's own linked account, if any.

    Returns:
        The access token, or ``None`` when the read must be anonymous.

    Raises:
        HTTPException: 404 when the named repository does not exist for this tenant.
    """
    if repository_id:
        repo_row = db.get_tenant_repository(tenant_id, repository_id)
        if not repo_row:
            raise HTTPException(status_code=404, detail="Repository not found for this tenant.")
        linked = repo_row.get("linked_account_id")
        owner = repo_row.get("created_by") or user_id
        if linked:
            oauth = db.get_external_auth_provider_for_user(str(linked), str(owner))
            if oauth and oauth.get("access_token"):
                return str(oauth["access_token"])
        return None

    if linked_account_id:
        oauth = db.get_external_auth_provider_for_user(str(linked_account_id), str(user_id))
        if oauth and oauth.get("access_token"):
            return str(oauth["access_token"])
    return None


def _http_error(exc: GitIntakeError) -> HTTPException:
    """Adapt a git intake failure to an HTTP error carrying its taxonomy code."""
    code = getattr(exc, "code", "SOURCE_UNREACHABLE")
    descriptor = descriptor_for(code)
    return HTTPException(
        status_code=_STATUS_BY_CODE.get(code, 422),
        detail={
            "code": code,
            "category": descriptor.category.value if descriptor else "transport",
            "message": str(exc),
            "remediation": descriptor.remediation if descriptor else "",
            "retriable": bool(descriptor.retriable) if descriptor else False,
        },
    )


def _suggested_filename(result: GitFilesetResult) -> str:
    """Name the packed archive after the repository, ref, and short commit."""
    provenance = result.provenance
    safe_ref = provenance.ref.replace("/", "-")
    return f"{provenance.repo}-{safe_ref}-{provenance.commit_sha[:7]}.zip"


def build_git_fileset_response(
    result: GitFilesetResult, *, include_document: bool
) -> GitFilesetResponse:
    """Adapt a fetched selection into the REST response shape.

    Args:
        result: The fetched fileset (members, root, detection, provenance).
        include_document: Whether to pack and return the archive bytes.

    Returns:
        The response payload, with ``document_base64`` populated only when asked for.
    """
    detection = DetectFormatResponse.from_detection(result.detection)
    document: Optional[str] = None
    if include_document:
        document = base64.standard_b64encode(pack_fileset_zip(result.members)).decode("ascii")
    return GitFilesetResponse(
        git_source=SpecImportGitSource(**result.provenance.as_dict()),
        filename=_suggested_filename(result),
        document_base64=document,
        archive_root=result.root_path,
        members=sorted(result.members),
        skipped=[
            GitFilesetSkippedMember(path=item.path, reason=item.reason)
            for item in result.skipped
        ],
        total_bytes=result.total_bytes(),
        source_kind=detection.detected.source_key if detection.detected else None,
        detection=detection,
    )


@router.post(
    "/{tenant_slug}/import/git/fileset",
    response_model=GitFilesetResponse,
    summary="Fetch a git repository selection as an importable fileset",
    description=(
        "Read a repository path or glob at a ref (MFI-29.3) and return it as the payload the "
        "import flow already accepts: the selected files packed as a deterministic archive "
        "(``document_base64``), the resolved root document, the detected format, and the "
        "**commit** the files were read at.\n\n"
        "Pass the returned bytes to ``POST /import/preflight`` and ``POST …/imports`` exactly "
        "as you would an uploaded archive, and echo ``git_source`` back in "
        "``options.git_source`` so the created revision records repository, ref, and commit "
        "provenance. Nothing is persisted by this call.\n\n"
        "Only github.com repositories are supported today. Private repositories are read with "
        "a **stored** linked-account credential — named either by ``repository_id`` (a "
        "registered tenant repository) or ``linked_account_id`` (the caller's own linked "
        "account); tokens are never accepted in the request. Files that cannot be imported "
        "(dotfiles, binaries, vendored trees, oversized blobs) are reported in ``skipped`` "
        "rather than silently dropped."
    ),
)
async def fetch_git_import_fileset(
    tenant_slug: str,
    body: GitFilesetRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> GitFilesetResponse:
    # Same gate as the pre-flight: fetching a candidate fileset is the first step of the
    # import flow and writes nothing, so a caller who may not import has no use for it.
    _ = tenant_slug
    enforce_permission(db, auth_data, Resource.IMPORTS, Action.CREATE)
    user_id = get_authenticated_user_id(auth_data)
    if not user_id:
        raise HTTPException(
            status_code=403,
            detail="An authenticated user id is required for git import intake.",
        )
    tenant_id = auth_data.get("tenant_id")
    if not tenant_id:
        raise HTTPException(status_code=403, detail="Tenant id missing from authentication context.")

    token = await asyncio.to_thread(
        resolve_stored_git_token,
        str(tenant_id),
        str(user_id),
        repository_id=body.repository_id,
        linked_account_id=body.linked_account_id,
    )

    selector = GitSelector(
        repo_url=body.repo_url,
        ref=body.ref,
        path=body.path or "",
        root=body.root,
    )
    try:
        # Blocking HTTP + packing: keep it off the event loop.
        result = await asyncio.to_thread(fetch_git_fileset, selector, access_token=token)
        return await asyncio.to_thread(
            build_git_fileset_response, result, include_document=body.include_document
        )
    except GitIntakeError as exc:
        raise _http_error(exc) from exc
