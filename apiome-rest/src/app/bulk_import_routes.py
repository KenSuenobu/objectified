"""Bulk import of independent specs — REST contract (MFI-29.5, #4392).

Three endpoints turn *"here is our ``specs/`` folder"* into N ordinary import jobs:

``POST /v1/tenants/{tenant_slug}/import/bulk/plan``
    Unpack the archive (or read the repository selection), partition it into
    independent items with :mod:`app.bulk_intake`, and describe each one — root
    document, members, detected format, predicted destination, suggested catalog
    identity — without writing anything.

``POST /v1/tenants/{tenant_slug}/import/bulk``
    Re-plan the same payload server-side and start one import job per selected item.
    Each item is gated, built, and scheduled **independently**, so a document that
    fails detection or is refused by the tenant's quality policy fails only its own
    row: the batch always reports every item and never aborts partway.

``POST /v1/tenants/{tenant_slug}/import/bulk/status``
    Fan out over the returned job ids and roll them up into a per-item result list
    plus a counted summary — the batch view of jobs that are otherwise perfectly
    ordinary ``GET …/imports/{job_id}`` jobs.

Nothing here is a second import pipeline. Every item runs the unchanged chain —
quality gate, ``run_adapter_import_job``, routing (§0.2), catalog persistence — and
the batch is only the fan-out plus the roll-up. A batch is therefore stateless: the
client holds the ``(key, job_id)`` pairs it was handed, and each job outlives the
batch in the shared job store exactly as a single import does.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import uuid
from typing import Any, Dict, List, Literal, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from .archive_intake import ArchiveIntakeError, is_archive_payload, unpack_archive_members
from .auth import get_authenticated_user_id, validate_authentication
from .bulk_intake import (
    BulkGroup,
    BulkPlan,
    group_document_bytes,
    plan_bulk_import,
    predicted_import_target,
    suggested_item_name,
)
from .config import settings
from .database import db
from .git_import_routes import resolve_stored_git_token
from .git_intake import GitFilesetResult, GitIntakeError, GitSelector, fetch_git_fileset
from .import_export_quality_policy import QualityGateError, enforce_import_quality_gate
from .intake_error_taxonomy import descriptor_for
from .models import (
    SpecImportGitSource,
    SpecImportJobError,
    SpecImportJobStatus,
    SpecImportOptions,
    SpecImportProjectTarget,
    SpecImportStartJsonRequest,
    SpecImportStartMetadata,
    SpecImportVersionTarget,
)
from .permissions import Action, Resource, enforce_permission
from .spec_import_engine import (
    get_spec_import_status as engine_get_spec_import_status,
)
from .spec_import_engine import (
    schedule_spec_import,
)

router = APIRouter(prefix="/v1/tenants", tags=["spec-import"])

#: Version assigned to every catalog revision a bulk item creates. Bulk intake carries
#: no per-item version input, and the adapter pipeline keys identity off the normalized
#: model rather than this string (see ``build_adapter_import_body`` in the CLI).
_DEFAULT_ITEM_VERSION = "1.0.0"

#: Job states that will not change again, so the batch is done when every item is one.
_TERMINAL_STATES = frozenset({"completed", "failed", "canceled", "rolled-back"})


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------


class BulkImportGitSelector(BaseModel):
    """A repository selection to plan or import in bulk (MFI-29.3 selection rules)."""

    model_config = ConfigDict(extra="forbid")

    repo_url: str = Field(description="Repository URL, for example https://github.com/owner/repo.")
    ref: Optional[str] = Field(
        default=None,
        description="Branch, tag, or commit sha. Defaults to the repository's default branch.",
    )
    path: str = Field(
        default="",
        description=(
            "Path or glob selecting the files to consider — a directory ('specs/'), an "
            "exact file, or a glob ('**/*.yaml'). Empty selects the whole tree."
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


class BulkImportSourceRequest(BaseModel):
    """The payload to partition: an uploaded archive or a repository selection."""

    model_config = ConfigDict(extra="forbid")

    document_base64: Optional[str] = Field(
        default=None,
        description=(
            "Standard base64 of a .zip / .tar.gz / .tgz archive holding the documents to "
            "import. Mutually exclusive with 'git'."
        ),
    )
    filename: Optional[str] = Field(
        default=None, description="Archive filename, used as the source label in messages."
    )
    git: Optional[BulkImportGitSelector] = Field(
        default=None,
        description=(
            "Repository selection to read instead of an uploaded archive (MFI-29.3). "
            "Mutually exclusive with 'document_base64'."
        ),
    )


class BulkImportPlanRequest(BulkImportSourceRequest):
    """Plan a bulk import: partition the payload and describe each item."""

    include_documents: bool = Field(
        default=False,
        description=(
            "Include each item's ready-to-import bytes in the response. Off by default: "
            "the submit endpoint re-plans the same payload server-side, so a client that "
            "only renders the plan never needs them."
        ),
    )


class BulkImportSkippedMember(BaseModel):
    """A file in the payload that is part of no item, and why."""

    model_config = ConfigDict(extra="forbid")

    path: str = Field(description="Module-relative path of the skipped file.")
    reason: str = Field(
        description=(
            "Why it is not part of any item: 'no-recognisable-format' (nothing in its "
            "group detected as an importable format) or 'over-item-limit'."
        )
    )


class BulkImportPlanItem(BaseModel):
    """One independent spec found in the payload — a candidate import job."""

    model_config = ConfigDict(extra="forbid")

    key: str = Field(
        description=(
            "Stable item identifier (the root document path). Pass it in the submit "
            "request's 'keys' to import a subset."
        )
    )
    root_path: str = Field(description="Root document of the item, relative to the payload.")
    members: List[str] = Field(
        default_factory=list,
        description="Every file the item compiles — the root plus its referenced siblings.",
    )
    total_bytes: int = Field(description="Decoded size of the item's members, in bytes.")
    source_kind: Optional[str] = Field(
        default=None,
        description="Adapter registry key detected for the root, or null when unimportable.",
    )
    format: Optional[str] = Field(
        default=None, description="Detected format key of the root document."
    )
    confidence: Optional[float] = Field(
        default=None, description="Detection confidence for the root document (0..1)."
    )
    importable: bool = Field(
        description="Whether a registered adapter can import this item today."
    )
    predicted_target: Literal["project", "catalog"] = Field(
        description=(
            "Where the item is expected to land per the §0.2 routing policy — predicted "
            "from the detected format. The authoritative decision is recorded on the job."
        )
    )
    input_kind: Literal["file", "fileset"] = Field(
        description="How the item is submitted: verbatim single file, or packed fileset."
    )
    suggested_name: str = Field(description="Catalog item name derived from the item.")
    suggested_slug: str = Field(description="Catalog slug derived from the suggested name.")
    reason: str = Field(description="Why these files are one item.")
    document_base64: Optional[str] = Field(
        default=None,
        description="The item's import payload, when include_documents was requested.",
    )


class BulkImportPlanSummary(BaseModel):
    """Counted roll-up of a plan, for the wizard's and CLI's summary line."""

    model_config = ConfigDict(extra="forbid")

    items: int = Field(description="Items in this plan.")
    importable: int = Field(description="Items a registered adapter can import today.")
    unimportable: int = Field(description="Items whose format has no adapter.")
    skipped_files: int = Field(description="Files that are part of no item.")
    by_target: Dict[str, int] = Field(
        default_factory=dict, description="Item counts by predicted destination."
    )
    by_format: Dict[str, int] = Field(
        default_factory=dict, description="Item counts by detected format key."
    )


class BulkImportPlanResponse(BaseModel):
    """The partition of one payload into independent items."""

    model_config = ConfigDict(extra="forbid")

    items: List[BulkImportPlanItem] = Field(default_factory=list)
    skipped: List[BulkImportSkippedMember] = Field(default_factory=list)
    truncated: bool = Field(
        default=False,
        description=(
            "True when the payload holds more items than one batch may carry; the extra "
            "items are listed in 'skipped' with reason 'over-item-limit'."
        ),
    )
    total_items: int = Field(
        description="Items found before the batch ceiling was applied.",
    )
    max_items: int = Field(description="The batch ceiling in force for this deployment.")
    source_label: str = Field(description="Label used for the payload in messages.")
    git_source: Optional[SpecImportGitSource] = Field(
        default=None,
        description="Repository provenance when the payload came from a git selection.",
    )
    summary: BulkImportPlanSummary


class BulkImportStartRequest(BulkImportSourceRequest):
    """Start one import job per selected item of a bulk payload."""

    keys: List[str] = Field(
        default_factory=list,
        description=(
            "Item keys to import (from the plan). Empty imports every importable item. "
            "A key that is not in the plan is reported as a failed item, not an error."
        ),
    )
    dry_run: bool = Field(
        default=False,
        description="Run every item as a dry run: validate and plan without persisting.",
    )


class BulkImportStartItem(BaseModel):
    """The outcome of *starting* one item — accepted with a job, or failed before one."""

    model_config = ConfigDict(extra="forbid")

    key: str
    root_path: str
    source_kind: Optional[str] = None
    format: Optional[str] = None
    predicted_target: Literal["project", "catalog"] = "catalog"
    name: str = Field(description="Catalog item name the job was started with.")
    slug: str = Field(description="Catalog slug the job was started with.")
    state: Literal["accepted", "failed"] = Field(
        description="'accepted' when a job was created; 'failed' when this item never started."
    )
    job_id: Optional[str] = Field(default=None, description="The started job's id.")
    status_path: Optional[str] = Field(
        default=None, description="Relative URL for GET …/imports/{job_id}."
    )
    error: Optional[SpecImportJobError] = Field(
        default=None, description="Why this item did not start (taxonomy-coded)."
    )


class BulkImportStartSummary(BaseModel):
    """Counted roll-up of a submit call."""

    model_config = ConfigDict(extra="forbid")

    requested: int = Field(description="Items the request selected.")
    accepted: int = Field(description="Items that started a job.")
    failed: int = Field(description="Items that failed before a job existed.")


class BulkImportStartResponse(BaseModel):
    """Per-item start results for one batch. Partial failure is normal, not fatal."""

    model_config = ConfigDict(extra="forbid")

    batch_id: str = Field(
        description=(
            "Correlation id for this submission. The batch itself is stateless — poll the "
            "per-item job ids (or the bulk status endpoint) for progress."
        )
    )
    items: List[BulkImportStartItem] = Field(default_factory=list)
    skipped: List[BulkImportSkippedMember] = Field(default_factory=list)
    summary: BulkImportStartSummary


class BulkImportStatusRef(BaseModel):
    """One item to look up: the key it was planned under and the job it started."""

    model_config = ConfigDict(extra="forbid")

    key: str = Field(description="The plan item key, echoed back on the result row.")
    job_id: str = Field(description="Job id returned by the submit call.")


class BulkImportStatusRequest(BaseModel):
    """Roll up the jobs of one batch into a per-item result list."""

    model_config = ConfigDict(extra="forbid")

    items: List[BulkImportStatusRef] = Field(
        default_factory=list, description="The (key, job_id) pairs the submit call returned."
    )


class BulkImportStatusItem(BaseModel):
    """The current state of one item's job, flattened for a result list."""

    model_config = ConfigDict(extra="forbid")

    key: str
    job_id: str
    state: str = Field(
        description="Job state, or 'not-found' when the job id is unknown to this tenant."
    )
    percent: int = Field(default=0, ge=0, le=100)
    target: Optional[str] = Field(
        default=None,
        description="Authoritative routing destination recorded by the job (project/catalog/types).",
    )
    project_slug: Optional[str] = Field(
        default=None, description="Slug of the catalog item or project the import created."
    )
    project_id: Optional[str] = Field(default=None, description="Id of the created item.")
    error: Optional[SpecImportJobError] = Field(
        default=None, description="Taxonomy-coded failure, when the job failed."
    )


class BulkImportStatusSummary(BaseModel):
    """Counted roll-up of a batch's jobs."""

    model_config = ConfigDict(extra="forbid")

    total: int
    completed: int
    failed: int
    running: int
    not_found: int


class BulkImportStatusResponse(BaseModel):
    """Batch progress: one row per item plus the counts a summary line needs."""

    model_config = ConfigDict(extra="forbid")

    items: List[BulkImportStatusItem] = Field(default_factory=list)
    summary: BulkImportStatusSummary
    done: bool = Field(
        description="True when every item reached a terminal state (or is unknown)."
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def bulk_item_slug(name: str) -> str:
    """Lowercase and hyphenate an item name into a URL-safe catalog slug.

    Args:
        name: The suggested item name.

    Returns:
        A non-empty slug (``imported-source`` when nothing survives normalization).
    """
    out: List[str] = []
    previous_hyphen = False
    for char in name.lower():
        if char.isalnum():
            out.append(char)
            previous_hyphen = False
        elif not previous_hyphen:
            out.append("-")
            previous_hyphen = True
    return "".join(out).strip("-") or "imported-source"


def _taxonomy_error(code: str, message: str) -> SpecImportJobError:
    """Build a per-item error from the intake taxonomy, so codes stay consistent."""
    descriptor = descriptor_for(code)
    return SpecImportJobError(
        code=code,
        category=descriptor.category.value if descriptor else "input",
        message=message,
        remediation=descriptor.remediation if descriptor else "",
        retriable=bool(descriptor.retriable) if descriptor else False,
    )


def _http_error(code: str, message: str, status_code: int) -> HTTPException:
    """Adapt a whole-payload failure into an HTTP error carrying its taxonomy code."""
    error = _taxonomy_error(code, message)
    return HTTPException(status_code=status_code, detail=error.model_dump())


def _decode_archive(document_base64: str) -> bytes:
    """Decode the request's base64 archive, or fail with a 422."""
    try:
        return base64.standard_b64decode(document_base64)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(
            status_code=422, detail=f"document_base64 is not valid base64: {exc}"
        ) from exc


async def _resolve_payload(
    body: BulkImportSourceRequest,
    *,
    tenant_id: str,
    user_id: str,
) -> Tuple[Dict[str, str], str, Optional[GitFilesetResult]]:
    """Resolve the request's source into the members to partition.

    Exactly one of ``document_base64`` / ``git`` must be set: an archive is unpacked
    under the MFI-29.1 sandbox policy, a repository selection is read at an immutable
    commit under the identical budget (MFI-29.3). Both arrive here as the same
    ``{path: text}`` mapping, which is the whole point — bulk mode adds no third
    intake path.

    Args:
        body: The plan or submit request.
        tenant_id: The importing tenant (credential resolution).
        user_id: The acting user (credential resolution).

    Returns:
        ``(members, source_label, git_result)``; ``git_result`` is ``None`` for an
        uploaded archive.

    Raises:
        HTTPException: For a missing/ambiguous source, an invalid archive, or an
            unreadable repository selection.
    """
    if bool(body.document_base64) == bool(body.git):
        raise HTTPException(
            status_code=422,
            detail="Provide exactly one of 'document_base64' (an archive) or 'git'.",
        )

    if body.document_base64:
        raw = _decode_archive(body.document_base64)
        label = body.filename or "archive"
        if not is_archive_payload(raw, body.filename):
            raise _http_error(
                "INPUT_ARCHIVE_INVALID",
                (
                    "Bulk import needs an archive (.zip / .tar.gz / .tgz) or a repository "
                    f"selection holding several documents; {label!r} is a single document."
                ),
                422,
            )
        try:
            # Members only: an archive of *independent* specs has no single root by
            # definition, so whole-archive root resolution would reject exactly the
            # payload bulk mode exists for. Roots are resolved per item, in the planner.
            members = await asyncio.to_thread(
                unpack_archive_members, raw, source_label=body.filename
            )
        except ArchiveIntakeError as exc:
            raise _http_error(
                getattr(exc, "code", "INPUT_ARCHIVE_INVALID"), str(exc), 422
            ) from exc
        return dict(members), label, None

    selector = body.git
    assert selector is not None  # guarded above
    token = await asyncio.to_thread(
        resolve_stored_git_token,
        tenant_id,
        user_id,
        repository_id=selector.repository_id,
        linked_account_id=selector.linked_account_id,
    )
    try:
        result = await asyncio.to_thread(
            fetch_git_fileset,
            GitSelector(
                repo_url=selector.repo_url,
                ref=selector.ref,
                path=selector.path or "",
                root=None,
            ),
            access_token=token,
            # A repository holding several independent specs has no single root, which
            # is the premise here rather than a fault: the planner resolves one per item.
            require_root=False,
        )
    except GitIntakeError as exc:
        code = getattr(exc, "code", "SOURCE_UNREACHABLE")
        status = {
            "SOURCE_NOT_FOUND": 404,
            "SOURCE_AUTH_REQUIRED": 403,
            "SOURCE_UNREACHABLE": 502,
            "INPUT_TOO_LARGE": 413,
        }.get(code, 422)
        raise _http_error(code, str(exc), status) from exc
    label = f"{result.provenance.repo}@{result.provenance.commit_sha[:7]}"
    return dict(result.members), label, result


def _max_items() -> int:
    """Return the deployment's bulk item ceiling."""
    return max(1, int(settings.bulk_import_max_items))


def _plan_item(group: BulkGroup, *, include_document: bool) -> BulkImportPlanItem:
    """Adapt one planned group into its API row.

    The item's bytes are built only when the caller asked for them: packing a fileset
    zip per item just to draw a list would double the cost of a plan the submit
    endpoint recomputes anyway.
    """
    detected = group.detection.detected
    document = group_document_bytes(group)[0] if include_document else None
    input_kind = "file" if len(group.members) == 1 else "fileset"
    name = suggested_item_name(group)
    return BulkImportPlanItem(
        key=group.key,
        root_path=group.root_path,
        members=sorted(group.members),
        total_bytes=group.total_bytes(),
        source_kind=group.source_kind,
        format=group.format,
        confidence=detected.confidence if detected else None,
        importable=bool(detected and detected.importable and detected.source_key),
        predicted_target=predicted_import_target(group.format),  # type: ignore[arg-type]
        input_kind=input_kind,  # type: ignore[arg-type]
        suggested_name=name,
        suggested_slug=bulk_item_slug(name),
        reason=group.reason,
        document_base64=(
            base64.standard_b64encode(document).decode("ascii") if document is not None else None
        ),
    )


def _plan_summary(items: List[BulkImportPlanItem], skipped_files: int) -> BulkImportPlanSummary:
    """Count a plan by destination and format for the summary line."""
    by_target: Dict[str, int] = {}
    by_format: Dict[str, int] = {}
    importable = 0
    for item in items:
        by_target[item.predicted_target] = by_target.get(item.predicted_target, 0) + 1
        key = item.format or "unrecognised"
        by_format[key] = by_format.get(key, 0) + 1
        if item.importable:
            importable += 1
    return BulkImportPlanSummary(
        items=len(items),
        importable=importable,
        unimportable=len(items) - importable,
        skipped_files=skipped_files,
        by_target=by_target,
        by_format=by_format,
    )


def _item_git_source(
    result: Optional[GitFilesetResult], group: BulkGroup
) -> Optional[SpecImportGitSource]:
    """Build per-item repository provenance pointing at *this item's* root document.

    Every item of a repository batch shares the repo, ref, and commit, but each one
    came from its own path — recording the batch's selection path on all of them would
    make four catalog items claim the same origin. The item's own root is appended to
    the selection so a later re-import-on-change comparison (EPIC-31) knows what to
    re-read.

    Args:
        result: The fetched repository selection, or ``None`` for an archive upload.
        group: The planned item.

    Returns:
        The item's provenance, or ``None`` when the payload was not a repository.
    """
    if result is None:
        return None
    provenance = result.provenance
    base = provenance.path.rstrip("/")
    item_path = f"{base}/{group.root_path}" if base else group.root_path
    browse = (
        f"https://github.com/{provenance.owner}/{provenance.repo}/blob/"
        f"{provenance.commit_sha}/{item_path}"
    )
    return SpecImportGitSource(
        provider=provenance.provider,
        repo_url=provenance.repo_url,
        owner=provenance.owner,
        repo=provenance.repo,
        ref=provenance.ref,
        commit_sha=provenance.commit_sha,
        path=item_path,
        browse_url=browse,
    )


def _plan_payload(members: Dict[str, str], *, source_label: str) -> BulkPlan:
    """Partition members into items, mapping planner failures onto HTTP errors."""
    where = f" ({source_label})" if source_label else ""
    try:
        return plan_bulk_import(members, max_items=_max_items(), where=where)
    except ValueError as exc:
        raise _http_error("SOURCE_SELECTION_EMPTY", str(exc), 422) from exc


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.post(
    "/{tenant_slug}/import/bulk/plan",
    response_model=BulkImportPlanResponse,
    summary="Plan a bulk import: partition an archive or repository into independent items",
    description=(
        "Partition one archive upload or repository selection into the **independent** "
        "specs it holds (MFI-29.5) and describe each as a candidate import job: root "
        "document, the sibling files it compiles, the detected format and adapter, the "
        "predicted destination under the §0.2 routing policy, and a suggested catalog "
        "name and slug.\n\n"
        "Grouping follows references between files — protobuf `import`, JSON/YAML `$ref`, "
        "XSD/WSDL `schemaLocation` — so a proto tree with cross-directory imports stays "
        "**one** item while two unrelated AsyncAPI documents are two. Files that belong to "
        "no importable item are reported in `skipped` with a reason, never dropped "
        "silently, and a payload holding more items than the batch ceiling reports "
        "`truncated` rather than importing a silent prefix.\n\n"
        "Nothing is persisted and no job is created. Item bytes are returned only when "
        "`include_documents` is set; the submit endpoint re-plans the same payload itself, "
        "so a client that just renders the list does not need them."
    ),
)
async def plan_bulk_import_payload(
    tenant_slug: str,
    body: BulkImportPlanRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> BulkImportPlanResponse:
    # Same gate as the pre-flight and git intake: planning is the first step of the import
    # flow and writes nothing, so a caller who may not import has no use for it.
    _ = tenant_slug
    enforce_permission(db, auth_data, Resource.IMPORTS, Action.CREATE)
    tenant_id, user_id = _require_tenant_and_user(auth_data)

    members, label, git_result = await _resolve_payload(
        body, tenant_id=tenant_id, user_id=user_id
    )
    plan = _plan_payload(members, source_label=label)
    items = [_plan_item(group, include_document=body.include_documents) for group in plan.groups]
    skipped = [
        BulkImportSkippedMember(path=entry.path, reason=entry.reason) for entry in plan.skipped
    ]
    return BulkImportPlanResponse(
        items=items,
        skipped=skipped,
        truncated=plan.truncated,
        total_items=plan.total_groups,
        max_items=_max_items(),
        source_label=label,
        git_source=(
            SpecImportGitSource(**git_result.provenance.as_dict()) if git_result else None
        ),
        summary=_plan_summary(items, len(skipped)),
    )


@router.post(
    "/{tenant_slug}/import/bulk",
    response_model=BulkImportStartResponse,
    summary="Start one import job per independent spec in a bulk payload",
    description=(
        "Re-plan the payload server-side (identical bytes always yield an identical plan) "
        "and start **one ordinary import job per item** (MFI-29.5). Pass `keys` to import "
        "a subset of the planned items; omit it to attempt every planned item.\n\n"
        "Each item is gated and scheduled independently: an item whose format has no "
        "adapter, whose key is not in the plan, or which the tenant's import quality policy "
        "refuses (IXH-2.3) is reported as a **failed row with a taxonomy code** while every "
        "other item still starts — a partial failure never aborts the batch. Items that do "
        "start run the unchanged import chain, including the §0.2 routing that decides "
        "Catalog vs Projects, so nothing about a bulk import differs from importing the "
        "same document on its own.\n\n"
        "The response is the batch's per-item start result. The batch itself holds no "
        "server state: poll the returned job ids individually or roll them up with "
        "`POST …/import/bulk/status`."
    ),
)
async def start_bulk_import(
    tenant_slug: str,
    body: BulkImportStartRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> BulkImportStartResponse:
    enforce_permission(db, auth_data, Resource.IMPORTS, Action.CREATE)
    tenant_id, user_id = _require_tenant_and_user(auth_data)

    members, label, git_result = await _resolve_payload(
        body, tenant_id=tenant_id, user_id=user_id
    )
    plan = _plan_payload(members, source_label=label)
    by_key = {group.key: group for group in plan.groups}

    requested_keys = [key.strip() for key in body.keys if key and key.strip()]
    selected: List[Tuple[str, Optional[BulkGroup]]] = (
        [(key, by_key.get(key)) for key in requested_keys]
        if requested_keys
        else [(group.key, group) for group in plan.groups]
    )

    items: List[BulkImportStartItem] = []
    for key, group in selected:
        items.append(
            await _start_bulk_item(
                key,
                group,
                tenant_slug=tenant_slug,
                tenant_id=tenant_id,
                user_id=user_id,
                source_label=label,
                dry_run=body.dry_run,
                git_result=git_result,
            )
        )

    accepted = sum(1 for item in items if item.state == "accepted")
    return BulkImportStartResponse(
        batch_id=str(uuid.uuid4()),
        items=items,
        skipped=[
            BulkImportSkippedMember(path=entry.path, reason=entry.reason)
            for entry in plan.skipped
        ],
        summary=BulkImportStartSummary(
            requested=len(items), accepted=accepted, failed=len(items) - accepted
        ),
    )


async def _start_bulk_item(
    key: str,
    group: Optional[BulkGroup],
    *,
    tenant_slug: str,
    tenant_id: str,
    user_id: str,
    source_label: str,
    dry_run: bool,
    git_result: Optional[GitFilesetResult],
) -> BulkImportStartItem:
    """Gate and schedule one item, converting any refusal into a failed row.

    Every failure mode of a single import — unknown key, unrecognised format, a
    blocking quality policy — is a per-item outcome here, because the batch's contract
    is that one bad document cannot cost the user the other nineteen.

    Args:
        key: The requested item key.
        group: The planned item, or ``None`` when the key is not in the plan.
        tenant_slug: The importing tenant's slug.
        tenant_id: Its id.
        user_id: The acting user.
        source_label: Label of the whole payload, for the item's filename hint.
        dry_run: Whether to run the item without persisting.
        git_result: The repository selection, when the payload came from git.

    Returns:
        The item's start result — ``accepted`` with a job id, or ``failed`` with a
        taxonomy-coded error.
    """
    if group is None:
        return BulkImportStartItem(
            key=key,
            root_path=key,
            name=key,
            slug=bulk_item_slug(key),
            state="failed",
            error=_taxonomy_error(
                "FORMAT_UNRECOGNIZED",
                f"{key!r} is not an item of this payload's plan; re-plan and use a listed key.",
            ),
        )

    name = suggested_item_name(group)
    slug = bulk_item_slug(name)
    detected = group.detection.detected
    source_kind = group.source_kind
    row = BulkImportStartItem(
        key=group.key,
        root_path=group.root_path,
        source_kind=source_kind,
        format=group.format,
        predicted_target=predicted_import_target(group.format),  # type: ignore[arg-type]
        name=name,
        slug=slug,
        state="failed",
    )

    if not source_kind or not detected or not detected.importable:
        row.error = _taxonomy_error(
            "FORMAT_UNRECOGNIZED",
            (
                f"No registered adapter can import {group.root_path!r}"
                + (f" (detected {group.format})." if group.format else ".")
            ),
        )
        return row

    document, input_kind, archive_root = group_document_bytes(group)
    filename = f"{source_label}:{group.root_path}" if source_label else group.root_path

    try:
        await enforce_import_quality_gate(
            tenant_id=tenant_id,
            tenant_slug=tenant_slug,
            user_id=user_id,
            raw=document,
            filename=filename,
            content_type=None,
            source_kind=source_kind,
            import_target=None,
            input_kind=input_kind,
            archive_root=archive_root,
        )
    except QualityGateError as exc:
        row.error = _taxonomy_error("QUALITY_POLICY_BLOCKED", exc.verdict.reason)
        return row

    request = SpecImportStartJsonRequest(
        metadata=SpecImportStartMetadata(
            source_kind=source_kind,
            project=SpecImportProjectTarget(name=name, slug=slug),
            version=SpecImportVersionTarget(version_id=_DEFAULT_ITEM_VERSION),
            options=SpecImportOptions(
                dry_run=dry_run,
                input_kind=input_kind,  # type: ignore[arg-type]
                archive_root=archive_root,
                git_source=_item_git_source(git_result, group),
            ),
        ),
        document_base64=base64.standard_b64encode(document).decode("ascii"),
        filename=filename,
    )
    accepted = await schedule_spec_import(tenant_slug, tenant_id, user_id, request)
    row.state = "accepted"
    row.job_id = accepted.job_id
    row.status_path = accepted.status_path
    row.error = None
    return row


@router.post(
    "/{tenant_slug}/import/bulk/status",
    response_model=BulkImportStatusResponse,
    summary="Roll up the jobs of one bulk batch into a per-item result list",
    description=(
        "Fan out over the `(key, job_id)` pairs a bulk submit returned and report each "
        "item's state, its authoritative routing destination and created item once it "
        "completes, and its taxonomy-coded error when it fails — plus the counts a summary "
        "line needs and a `done` flag that is true once every item is terminal.\n\n"
        "This is a convenience roll-up, not a second source of truth: each row is the same "
        "payload `GET …/imports/{job_id}` returns. A job id this tenant does not own is "
        "reported as state `not-found` rather than failing the whole call, so one stale id "
        "cannot blind a client to the rest of its batch."
    ),
)
async def bulk_import_status(
    tenant_slug: str,
    body: BulkImportStatusRequest,
    auth_data: Dict[str, Any] = Depends(validate_authentication),
) -> BulkImportStatusResponse:
    _ = auth_data
    rows: List[BulkImportStatusItem] = []
    for ref in body.items:
        rows.append(await _status_row(tenant_slug, ref))

    completed = sum(1 for row in rows if row.state == "completed")
    failed = sum(1 for row in rows if row.state in {"failed", "canceled", "rolled-back"})
    not_found = sum(1 for row in rows if row.state == "not-found")
    running = len(rows) - completed - failed - not_found
    return BulkImportStatusResponse(
        items=rows,
        summary=BulkImportStatusSummary(
            total=len(rows),
            completed=completed,
            failed=failed,
            running=running,
            not_found=not_found,
        ),
        done=all(row.state in _TERMINAL_STATES or row.state == "not-found" for row in rows),
    )


async def _status_row(tenant_slug: str, ref: BulkImportStatusRef) -> BulkImportStatusItem:
    """Flatten one job's status into a batch result row.

    Args:
        tenant_slug: The tenant that owns the batch.
        ref: The item key and its job id.

    Returns:
        The row, with state ``not-found`` when the job is unknown to this tenant.
    """
    try:
        status: SpecImportJobStatus = await engine_get_spec_import_status(tenant_slug, ref.job_id)
    except HTTPException as exc:
        if exc.status_code != 404:
            raise
        return BulkImportStatusItem(key=ref.key, job_id=ref.job_id, state="not-found")

    summary = status.summary if isinstance(status.summary, dict) else {}
    routing = summary.get("routing") if isinstance(summary.get("routing"), dict) else {}
    return BulkImportStatusItem(
        key=ref.key,
        job_id=status.job_id,
        state=status.state,
        percent=status.percent,
        target=routing.get("target") if isinstance(routing, dict) else None,
        project_slug=status.result.project_slug if status.result else None,
        project_id=status.result.project_id if status.result else None,
        error=status.error,
    )


def _require_tenant_and_user(auth_data: Dict[str, Any]) -> Tuple[str, str]:
    """Resolve the acting tenant and user, or refuse the request.

    Args:
        auth_data: The validated authentication context.

    Returns:
        ``(tenant_id, user_id)``.

    Raises:
        HTTPException: 403 when either is missing.
    """
    user_id = get_authenticated_user_id(auth_data)
    if not user_id:
        raise HTTPException(
            status_code=403,
            detail="An authenticated user id is required for bulk import.",
        )
    tenant_id = auth_data.get("tenant_id")
    if not tenant_id:
        raise HTTPException(status_code=403, detail="Tenant id missing from authentication context.")
    return str(tenant_id), str(user_id)
