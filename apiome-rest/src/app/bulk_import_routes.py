"""Bulk import of independent specs — REST contract (MFI-29.5, #4392).

Three endpoints turn *"here is our ``specs/`` folder"* into N ordinary import jobs:

``POST /v1/tenants/{tenant_slug}/import/bulk/plan``
    Unpack the archive (or read the repository selection), partition it into
    independent items with :mod:`app.bulk_intake`, describe each one — root document,
    members, detected format, predicted destination, suggested catalog identity — and
    **reconcile** it against the tenant's existing projects with
    :mod:`app.bulk_import_reconciliation` (BLK-1.2), so each row says whether it would
    append a version to a project that already exists or create a new one. All reads:
    it still writes nothing.

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
from typing import Any, Dict, List, Literal, Optional, Sequence, Tuple

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .archive_intake import ArchiveIntakeError, is_archive_payload, unpack_archive_members
from .auth import get_authenticated_user_id, validate_authentication
from .bulk_import_apply import (
    ItemOverride,
    ItemTarget,
    ItemTargetError,
    OverrideMode,
    decide_item_target,
)
from .bulk_import_plan_fingerprint import (
    TARGET_PLAN_STALE,
    ReviewedItem,
    decode_plan_fingerprint,
    detect_plan_drift,
    encode_plan_fingerprint,
)
from .bulk_import_reconciliation import (
    ItemResolution,
    ProjectReconciler,
    ProposedVersion,
    Resolution,
    ResolvedVersionPolicy,
    VersionDerivation,
    VersionPolicy,
    reconcile_item,
    resolve_version_policy,
)
from .bulk_import_selection import (
    NOT_AN_ITEM_ROOT,
    normalize_selection_paths,
    partition_requested_roots,
    repository_relative_path,
)
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
from .git_intake import (
    GitFilesetResult,
    GitIntakeError,
    GitSelector,
    fetch_git_files,
    fetch_git_fileset,
)
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

#: The batch's **fallback** first version — no longer its universal answer (BLK-1.3).
#:
#: Until BLK-1.3 every item of every batch was submitted at this label, so a batch could only
#: mint new projects at 1.0.0 and never append a real version. It now applies exactly where it
#: is the truth: a project that does not exist yet has no history to derive a label from, so
#: its first revision takes this. Every append derives its label from the target project's own
#: versions (:func:`app.bulk_import_reconciliation.propose_version`), and an explicit per-item
#: override replaces both.
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
    paths: Optional[List[str]] = Field(
        default=None,
        description=(
            "Import exactly these repository-relative files — what a reader ticked in the "
            "repository's Files tab (BLK-1.5). **Replaces 'path'**, which is ignored when this "
            "is set: instead of reading a selection, the batch reads these files plus every "
            "document they reference, following '$ref' targets, protobuf imports and XSD/WSDL "
            "locations until the set closes over itself. A ticked 'orders.proto' therefore "
            "arrives with the 'common/types.proto' it imports, wherever in the repository that "
            "lives, and a monorepo whose whole tree is over the intake limit can still have "
            "four files imported from it.\n\n"
            "Members are keyed from the repository root, so an item's path is the one the "
            "Files tab shows. A listed path that is not an item root — a shared type file "
            "another listed item already compiles — is reported in 'skipped' with reason "
            "'not-an-item-root' rather than dropped silently, and a path the commit no longer "
            "holds is skipped rather than failing the batch. Omitted (or empty) reads 'path' "
            "as a selection, which is the unchanged behaviour."
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


class BulkImportMatchedProject(BaseModel):
    """The existing project a planned item resolves to (BLK-1.2)."""

    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(
        description=(
            "The matched project's id — what an apply step passes as 'project.project_id' "
            "(BLK-1.1) to append this revision to it."
        )
    )
    name: str = Field(description="The matched project's display name.")
    slug: str = Field(description="The matched project's slug.")


class BulkImportProposedVersion(BaseModel):
    """The version label an item would create, and how it was derived (BLK-1.2)."""

    model_config = ConfigDict(extra="forbid")

    version_id: str = Field(description="The version label this item would create.")
    derived_from: Literal["default", "version-bump", "next-available"] = Field(
        description=(
            "How the label was reached: 'default' (the batch's first version — a new project, "
            "or a matched project with no revisions), 'version-bump' (the next free minor "
            "after the matched project's highest semantic version) or 'next-available' (the "
            "matched project's labels are not semantic versions, so the first free label at "
            "or after the default was taken — what the importer itself would allocate)."
        )
    )
    previous_version_id: Optional[str] = Field(
        default=None,
        description="The label this one follows, set only for 'version-bump'.",
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
    resolution: Literal["append-version", "create-project", "unresolved"] = Field(
        description=(
            "What would happen to this item if the plan were applied now (BLK-1.2): "
            "'append-version' adds a new version to 'matched_project', 'create-project' "
            "creates a project, and 'unresolved' means the tenant's 'always-ask' policy "
            "defers the choice to an explicit per-item decision at apply time."
        )
    )
    matched_project: Optional[BulkImportMatchedProject] = Field(
        default=None,
        description=(
            "The existing project this item resolves to, or null when it is genuinely new. "
            "Reported even under the 'always-create' policy, which ignores the match rather "
            "than hiding it."
        ),
    )
    match_basis: Optional[Literal["repository-provenance", "slug", "spec-identity"]] = Field(
        default=None,
        description=(
            "Why it matched: 'repository-provenance' (a prior import from the same repository "
            "and path — the strongest signal), 'slug' (an existing project already uses this "
            "item's suggested slug), or 'spec-identity' (an existing project is named for the "
            "same API, which is how a file that moved within the repository still matches)."
        ),
    )
    match_detail: Optional[str] = Field(
        default=None,
        description="One sentence explaining the match, so a verify screen can justify it.",
    )
    match_confidence: Optional[float] = Field(
        default=None,
        description=(
            "Confidence in the *match* (0..1) — deliberately not named 'confidence', which is "
            "already this item's format-detection confidence and answers a different question."
        ),
    )
    proposed_version: Optional[BulkImportProposedVersion] = Field(
        default=None,
        description=(
            "The version label this item would create, and how it was derived. An "
            "'unresolved' item reports the label the default 'append-when-matched' policy "
            "would produce — the candidate the user is being asked to confirm."
        ),
    )
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
    by_resolution: Dict[str, int] = Field(
        default_factory=dict,
        description=(
            "Item counts by reconciliation outcome (BLK-1.2) — the '12 items · 9 new versions "
            "· 3 new projects' line. Counts every planned item, importable or not, so the "
            "totals reconcile with the per-item rows exactly as 'by_target' does."
        ),
    )
    matched: int = Field(
        default=0,
        description=(
            "Items that matched an existing project, whatever the policy did with the match. "
            "Under 'always-create' this is how many matches the plan is ignoring."
        ),
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
    version_policy: Literal["append-when-matched", "always-create", "always-ask"] = Field(
        description=(
            "The reconciliation policy this plan was resolved under (BLK-1.2): "
            "'append-when-matched' (the default — matched items append a version, unmatched "
            "items create a project), 'always-create' (every item creates a project; matches "
            "are still reported) or 'always-ask' (every item is unresolved and needs a "
            "per-item choice at apply time)."
        )
    )
    version_policy_source: Literal["repository", "tenant", "default"] = Field(
        description=(
            "Which tier supplied the policy — the registered repository's override, the "
            "tenant's default, or the built-in default when neither is set."
        )
    )
    plan_fingerprint: str = Field(
        description=(
            "Opaque token describing the reconciliation this plan reports (BLK-1.3). Echo it "
            "verbatim as the submit request's 'plan_fingerprint' and the apply refuses to run "
            "a plan that has drifted since you reviewed it — someone else creating the project "
            "one of your items was going to mint, or taking the version another proposed — "
            "naming the rows that moved instead of importing what you never saw. Do not parse "
            "it: its encoding is the server's business and may change. Two plans of the same "
            "payload with the same fingerprint would do the same thing."
        )
    )
    summary: BulkImportPlanSummary


class BulkImportItemOverride(BaseModel):
    """One reviewer decision for one item, replacing what the plan resolved (BLK-1.3).

    Overrides are **sparse**: an item with no entry applies its BLK-1.2 resolution, so
    applying a plan you agree with stays one click and disagreeing with one row of twelve
    costs one entry rather than the batch.
    """

    model_config = ConfigDict(extra="forbid")

    key: str = Field(
        description=(
            "The plan item this decision is about — the same stable key 'keys' takes. An "
            "override naming an item this batch is not importing is reported as a failed row "
            "rather than ignored."
        )
    )
    mode: Optional[Literal["existing", "new"]] = Field(
        default=None,
        description=(
            "Where this item goes, overriding the plan: 'existing' appends a version to a "
            "project that already exists ('project_id' when given, else the item's matched "
            "project), 'new' creates a project whatever the plan matched. Omit to keep the "
            "plan's resolution. Required for an item the plan left 'unresolved'."
        ),
    )
    project_id: Optional[str] = Field(
        default=None,
        description=(
            "The existing project to append to. Naming one implies mode 'existing'. The "
            "project must belong to this tenant and be publishable — a catalog item named "
            "here is refused for this item with TARGET_NOT_PUBLISHABLE, exactly as BLK-1.1 "
            "refuses it for a single import."
        ),
    )
    version_id: Optional[str] = Field(
        default=None,
        description=(
            "The version label to create, replacing the derived one. Set it on its own to "
            "carry a real version number without changing where the item lands. Omitted, an "
            "append derives the next label from the target project's own versions and a "
            "create takes the batch's first version."
        ),
    )

    @model_validator(mode="after")
    def _reject_contradictions(self) -> "BulkImportItemOverride":
        """Refuse an override that asks for two different things (BLK-1.3)."""
        if not self.key.strip():
            raise ValueError("override 'key' must name a plan item")
        if self.mode == "new" and (self.project_id or "").strip():
            raise ValueError(
                "override mode 'new' creates a project, so it cannot also name a "
                "'project_id' to append to"
            )
        return self


class BulkImportStartRequest(BulkImportSourceRequest):
    """Start one import job per selected item of a bulk payload."""

    keys: List[str] = Field(
        default_factory=list,
        description=(
            "Item keys to import (from the plan). Empty imports every importable item. "
            "A key that is not in the plan is reported as a failed item, not an error."
        ),
    )
    overrides: List[BulkImportItemOverride] = Field(
        default_factory=list,
        description=(
            "Per-item decisions overriding the plan's reconciliation (BLK-1.3), keyed by the "
            "plan's stable item key. Absent for an item means 'apply what the plan resolved'."
        ),
    )
    plan_fingerprint: Optional[str] = Field(
        default=None,
        description=(
            "The 'plan_fingerprint' of the plan you reviewed, echoed verbatim (BLK-1.3). When "
            "set, the batch re-plans and refuses with TARGET_PLAN_STALE — naming the drift per "
            "item and writing nothing — if the payload would now do something other than what "
            "you reviewed. Omit it to apply whatever re-planning produces."
        ),
    )
    dry_run: bool = Field(
        default=False,
        description=(
            "Verify instead of apply: every item is resolved and validated exactly as the "
            "apply would resolve and validate it — the response's per-item 'resolution', "
            "'target_project_id' and 'version_id' are the same computation — and nothing is "
            "persisted. No project, version or catalog row is written."
        ),
    )

    @model_validator(mode="after")
    def _reject_duplicate_overrides(self) -> "BulkImportStartRequest":
        """One decision per item: two entries for a key would make the batch order-dependent."""
        seen = set()
        for entry in self.overrides:
            key = entry.key.strip()
            if key in seen:
                raise ValueError(f"overrides name {key!r} more than once")
            seen.add(key)
        return self


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
    resolution: Optional[Literal["append-version", "create-project"]] = Field(
        default=None,
        description=(
            "What this item's job was started to do (BLK-1.3) — the applied form of the plan's "
            "'resolution', after any override. Null for an item that never got that far (an "
            "unknown key, or a format no adapter can import). A 'dry_run' batch reports the "
            "same value the apply would, because it is the same computation."
        ),
    )
    target_project_id: Optional[str] = Field(
        default=None,
        description=(
            "The existing project this item appends to, or null when it creates one. Set for "
            "every 'append-version' row, including one landing on a catalog item — which takes "
            "the revision by slug rather than by project id, so the job carries no "
            "'project.project_id' even though the destination is this project."
        ),
    )
    version_id: Optional[str] = Field(
        default=None,
        description=(
            "The version label the job was started with: derived from the target project's own "
            "versions for an append, the batch's first version for a create, or the override's "
            "own value when one was given."
        ),
    )
    overridden: bool = Field(
        default=False,
        description="Whether a per-item override, rather than the plan, decided this row.",
    )
    resolution_detail: Optional[str] = Field(
        default=None,
        description="One sentence stating the decision, for a verify screen or a CLI table.",
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
    dry_run: bool = Field(
        default=False,
        description=(
            "Whether this was a verify pass. True means the rows describe what an apply would "
            "do and nothing was persisted."
        ),
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
    version_id: Optional[str] = Field(
        default=None,
        description="Version label the import actually created on that project (BLK-1.3).",
    )
    outcome: Optional[Literal["project-created", "version-appended"]] = Field(
        default=None,
        description=(
            "What this item **did** to the tenant (BLK-1.3), read back from the catalog rather "
            "than from what the submit predicted: 'version-appended' when the revision joined a "
            "project that already had versions, 'project-created' when it is that project's "
            "only one. Null until the job completes, and for a dry run, which creates nothing "
            "to read back."
        ),
    )
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
    created: int = Field(
        default=0, description="Completed items that produced a project of their own."
    )
    appended: int = Field(
        default=0, description="Completed items that added a version to an existing project."
    )


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
    # Two different reads, because ticked files and a selection are different questions.
    #
    # A selection ("specs/", "**/*.yaml") is answered by reading everything it matches. Ticked
    # files cannot be: narrowing the read to their shared directory drops the siblings they
    # compile — `protos/orders/orders.proto` imports `protos/common/types.proto`, one level up —
    # and *not* narrowing it means reading the whole tree, which a monorepo refuses outright
    # with INPUT_TOO_LARGE however small the ticked files are. `fetch_git_files` reads from the
    # other end instead: the ticked files, then whatever they reference, until the set closes.
    requested_paths = normalize_selection_paths(selector.paths)
    git_selector = GitSelector(
        repo_url=selector.repo_url,
        ref=selector.ref,
        path=selector.path or "",
        root=None,
    )
    try:
        if requested_paths:
            result = await asyncio.to_thread(
                fetch_git_files, git_selector, requested_paths, access_token=token
            )
        else:
            result = await asyncio.to_thread(
                fetch_git_fileset,
                git_selector,
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


def _plan_item(
    group: BulkGroup, resolved: ItemResolution, *, include_document: bool
) -> BulkImportPlanItem:
    """Adapt one planned group and its reconciliation into the item's API row.

    The item's bytes are built only when the caller asked for them: packing a fileset
    zip per item just to draw a list would double the cost of a plan the submit
    endpoint recomputes anyway.

    Args:
        group: The planned item.
        resolved: Its BLK-1.2 reconciliation — what applying the plan would do, against
            which project, and as which version.
        include_document: Whether to pack and attach the item's import payload.

    Returns:
        The plan row.
    """
    detected = group.detection.detected
    document = group_document_bytes(group)[0] if include_document else None
    input_kind = "file" if len(group.members) == 1 else "fileset"
    name = suggested_item_name(group)
    match = resolved.match
    proposed = resolved.proposed_version
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
        resolution=resolved.resolution.value,  # type: ignore[arg-type]
        matched_project=(
            BulkImportMatchedProject(
                project_id=match.project_id, name=match.name, slug=match.slug
            )
            if match
            else None
        ),
        match_basis=match.basis.value if match else None,  # type: ignore[arg-type]
        match_detail=match.detail if match else None,
        match_confidence=match.confidence if match else None,
        proposed_version=BulkImportProposedVersion(
            version_id=proposed.version_id,
            derived_from=proposed.derived_from.value,  # type: ignore[arg-type]
            previous_version_id=proposed.previous_version_id,
        ),
        document_base64=(
            base64.standard_b64encode(document).decode("ascii") if document is not None else None
        ),
    )


def _plan_summary(items: List[BulkImportPlanItem], skipped_files: int) -> BulkImportPlanSummary:
    """Count a plan by destination, format and reconciliation outcome for the summary line."""
    by_target: Dict[str, int] = {}
    by_format: Dict[str, int] = {}
    by_resolution: Dict[str, int] = {}
    importable = 0
    matched = 0
    for item in items:
        by_target[item.predicted_target] = by_target.get(item.predicted_target, 0) + 1
        key = item.format or "unrecognised"
        by_format[key] = by_format.get(key, 0) + 1
        by_resolution[item.resolution] = by_resolution.get(item.resolution, 0) + 1
        if item.importable:
            importable += 1
        if item.matched_project is not None:
            matched += 1
    return BulkImportPlanSummary(
        items=len(items),
        importable=importable,
        unimportable=len(items) - importable,
        skipped_files=skipped_files,
        by_target=by_target,
        by_format=by_format,
        by_resolution=by_resolution,
        matched=matched,
    )


def _resolve_plan_policy(
    body: BulkImportSourceRequest, *, tenant_id: str
) -> ResolvedVersionPolicy:
    """Resolve the reconciliation policy for one plan (BLK-1.2).

    Reads the two stored tiers — the registered repository's override, when the payload names
    one, and the tenant's default — and lets
    :func:`app.bulk_import_reconciliation.resolve_version_policy` apply the precedence. An
    archive upload names no repository, so only the tenant tier applies to it.

    Blocking DB work — call via ``asyncio.to_thread``.

    Args:
        body: The plan request.
        tenant_id: The acting tenant.

    Returns:
        The policy in force and the tier it came from.
    """
    repository_policy: Optional[Any] = None
    repository_id = body.git.repository_id if body.git else None
    if repository_id:
        repository = db.get_tenant_repository(tenant_id, repository_id) or {}
        repository_policy = repository.get("bulk_import_version_policy")
    return resolve_version_policy(
        repository_policy=repository_policy,
        tenant_policy=db.get_tenant_bulk_import_version_policy(tenant_id),
    )


def _reconcile_groups(
    groups: List[BulkGroup],
    *,
    tenant_id: str,
    policy: VersionPolicy,
    git_result: Optional[GitFilesetResult],
    reconciler: Optional[ProjectReconciler] = None,
) -> List[ItemResolution]:
    """Reconcile every planned item against the tenant's existing projects (BLK-1.2).

    One :class:`~app.bulk_import_reconciliation.ProjectReconciler` serves the whole plan, so
    the batch's DB cost is proportional to the *distinct* paths, slugs and titles it holds
    rather than to its item count.

    Every planned item is reconciled, including one no adapter can import: it still has an
    identity that may already exist, and skipping it would make ``by_resolution`` disagree
    with the rows it summarises. ``importable`` remains the flag that says whether the item
    can actually run.

    Blocking DB work — call via ``asyncio.to_thread``.

    Args:
        groups: The planned items, in plan order.
        tenant_id: The acting tenant; every lookup is scoped to it.
        policy: The resolved reconciliation policy.
        git_result: The repository selection, or ``None`` for an archive upload.
        reconciler: An existing reconciler to reuse. The submit path passes the one it will
            also derive each item's version from (BLK-1.3), so a project's labels are read
            once for the whole batch rather than once to plan it and again to apply it.

    Returns:
        One resolution per group, positionally aligned with ``groups``.
    """
    reconciler = reconciler or ProjectReconciler(db, tenant_id=tenant_id)
    repo_url = git_result.provenance.repo_url if git_result else None
    resolutions: List[ItemResolution] = []
    for group in groups:
        name = suggested_item_name(group)
        resolutions.append(
            reconcile_item(
                reconciler,
                policy=policy,
                repo_url=repo_url,
                git_path=_item_git_path(git_result, group),
                slug=bulk_item_slug(name),
                title=name,
                default_version_id=_DEFAULT_ITEM_VERSION,
            )
        )
    return resolutions


def _item_git_path(result: Optional[GitFilesetResult], group: BulkGroup) -> Optional[str]:
    """Return the item's own path inside the repository, or ``None`` for an archive.

    The batch's selection path plus the item's root document — the one string that identifies
    *this* item's origin, and the value recorded as ``format_metadata.gitPath`` on the
    revision an earlier import of it produced.

    Args:
        result: The fetched repository selection, or ``None``.
        group: The planned item.

    Returns:
        The repository-relative path, or ``None`` when the payload was not a repository.
    """
    if result is None:
        return None
    base = result.provenance.path.rstrip("/")
    return f"{base}/{group.root_path}" if base else group.root_path


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
    item_path = _item_git_path(result, group)
    if result is None or item_path is None:
        return None
    provenance = result.provenance
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


def _plan_payload(
    members: Dict[str, str], *, source_label: str, max_items: Optional[int] = None
) -> BulkPlan:
    """Partition members into items, mapping planner failures onto HTTP errors.

    Args:
        members: The unpacked payload.
        source_label: Label for the payload, appended to planner errors.
        max_items: Ceiling override. Defaults to the deployment ceiling. A ticked-files
            request (BLK-1.5) passes one high enough to never truncate, because the ceiling
            has to apply to the *ticked* items rather than to everything the read happened to
            fetch — otherwise a file ticked in a large directory could be cut before it was
            ever considered.

    Returns:
        The plan.
    """
    where = f" ({source_label})" if source_label else ""
    try:
        return plan_bulk_import(
            members, max_items=_max_items() if max_items is None else max_items, where=where
        )
    except ValueError as exc:
        raise _http_error("SOURCE_SELECTION_EMPTY", str(exc), 422) from exc


def _requested_paths(body: BulkImportSourceRequest) -> Tuple[str, ...]:
    """The repository-relative files this request ticked, normalized (BLK-1.5)."""
    return normalize_selection_paths(body.git.paths) if body.git else ()


def _narrow_to_requested(
    plan: BulkPlan,
    *,
    requested: Sequence[str],
    git_result: Optional[GitFilesetResult],
) -> Tuple[List[BulkGroup], List[BulkImportSkippedMember], bool, int]:
    """Keep only the planned items whose root is a file the reader ticked (BLK-1.5).

    Grouping has already run over the whole fetched selection, so each kept item still carries
    the siblings it compiles — narrowing here removes *items*, never members. A ticked path
    that is no item's root is reported rather than dropped: it is almost always a shared type
    file another item already compiles, and saying so is the difference between a batch that
    explains itself and one that quietly imports fewer things than were asked for.

    Args:
        plan: The plan over the whole fetched selection, built without truncation.
        requested: Normalized repository-relative paths the reader ticked. Empty means no
            narrowing, and everything is returned unchanged.
        git_result: The repository selection, needed to re-anchor member paths onto the
            repository root; ``None`` for an archive upload, which cannot tick files.

    Returns:
        ``(groups, extra_skipped, truncated, total_items)`` — the items to plan, the rows to
        add to ``skipped``, whether the batch ceiling cut the ticked set, and how many ticked
        items were found before that cut.
    """
    if not requested or git_result is None:
        return list(plan.groups), [], plan.truncated, plan.total_groups

    prefix = git_result.provenance.path
    roots = [
        (group.key, repository_relative_path(prefix, group.root_path)) for group in plan.groups
    ]
    kept_keys, unmatched = partition_requested_roots(roots, requested)
    by_key = {group.key: group for group in plan.groups}
    root_by_key = dict(roots)
    kept = [by_key[key] for key in kept_keys]

    extra = [
        BulkImportSkippedMember(path=path, reason=NOT_AN_ITEM_ROOT) for path in unmatched
    ]

    # The ceiling applies to what was ticked, not to what the read fetched.
    ceiling = _max_items()
    total = len(kept)
    truncated = total > ceiling
    if truncated:
        extra.extend(
            BulkImportSkippedMember(path=root_by_key[group.key], reason="over-item-limit")
            for group in kept[ceiling:]
        )
        kept = kept[:ceiling]
    return kept, extra, truncated, total


# --------------------------------------------------------------- apply (BLK-1.3)


def _reviewed_items(
    groups: Sequence[BulkGroup], resolutions: Sequence[ItemResolution]
) -> List[ReviewedItem]:
    """Reduce a plan to the decisions a fingerprint compares (BLK-1.3).

    Only the fields that decide what an apply *does* — the resolution, the project it would
    land in, the version it would create. Everything else about a plan row (its members, its
    detection confidence, the sentence explaining the match) can change without changing the
    import, and folding those in would make a plan look stale when it is not.

    That is also why a ``create-project`` row records no project. Under ``always-create`` an
    item reports the match it is *ignoring*, and a colleague creating a project that happens
    to match it does not change what applying the plan does — the item still creates one.
    Treating that as drift would refuse a batch nothing had actually changed about.

    Args:
        groups: The planned items, in plan order.
        resolutions: Their reconciliations, positionally aligned.

    Returns:
        One :class:`~app.bulk_import_plan_fingerprint.ReviewedItem` per group.
    """
    return [
        ReviewedItem(
            key=group.key,
            resolution=resolved.resolution.value,
            project_id=(
                resolved.match.project_id
                if resolved.match and resolved.resolution is not Resolution.CREATE_PROJECT
                else ""
            ),
            version_id=resolved.proposed_version.version_id,
        )
        for group, resolved in zip(groups, resolutions)
    ]


def _enforce_plan_fingerprint(
    token: Optional[str],
    groups: Sequence[BulkGroup],
    resolutions: Sequence[ItemResolution],
    *,
    keys: Sequence[str],
) -> None:
    """Refuse to apply a plan that no longer says what it said when it was reviewed.

    The check runs **before** any item is gated or scheduled, so a stale batch writes nothing
    at all rather than importing a prefix and then noticing.

    Args:
        token: The client's echoed ``plan_fingerprint``, or ``None`` to skip the check.
        groups: The items this submit re-planned.
        resolutions: Their freshly computed reconciliations.
        keys: The item keys this batch will act on; empty means every planned item.

    Raises:
        HTTPException: 422 when the token is not one this server issued, 409 carrying a
            per-item ``drift`` list when the plan has moved.
    """
    if not token or not token.strip():
        return

    reviewed = decode_plan_fingerprint(token.strip())
    if reviewed is None:
        raise _http_error(
            TARGET_PLAN_STALE,
            (
                "'plan_fingerprint' is not a fingerprint this server issued. Send the value "
                "from the plan response verbatim, or omit it."
            ),
            422,
        )

    drifts = detect_plan_drift(reviewed, _reviewed_items(groups, resolutions), keys=keys)
    if not drifts:
        return

    moved = ", ".join(drift.key for drift in drifts[:3])
    if len(drifts) > 3:
        moved += f" and {len(drifts) - 3} more"
    error = _taxonomy_error(
        TARGET_PLAN_STALE,
        (
            f"The plan you reviewed no longer describes this batch: {len(drifts)} item(s) "
            f"changed ({moved}). Nothing was imported."
        ),
    )
    detail: Dict[str, Any] = error.model_dump()
    detail["drift"] = [drift.as_dict() for drift in drifts]
    raise HTTPException(status_code=409, detail=detail)


def _item_override(entry: BulkImportItemOverride) -> ItemOverride:
    """Adapt one request override into the decision :mod:`app.bulk_import_apply` takes."""
    return ItemOverride(
        mode=OverrideMode(entry.mode) if entry.mode else None,
        project_id=entry.project_id,
        version_id=entry.version_id,
    )


def _target_refusal(exc: HTTPException) -> SpecImportJobError:
    """Adapt a scheduling refusal into this item's failed row, never the batch's failure.

    ``schedule_spec_import`` raises for a BLK-1.1 target it cannot honour — an id this tenant
    cannot see, a catalog item, a version label already taken. Those are HTTP errors for a
    single import and **per-item** outcomes for a batch, because one reviewer's bad override
    must not cost the other nineteen items their import.

    Args:
        exc: The refusal raised while scheduling.

    Returns:
        The taxonomy-coded error for this item's row.
    """
    detail = exc.detail if isinstance(exc.detail, dict) else {}
    code = str(detail.get("code") or "").strip()
    message = str(detail.get("message") or detail or exc.detail or "Import could not start.")
    if code:
        return _taxonomy_error(code, message)
    return _taxonomy_error("INTERNAL_WORKER_FAULT", message)


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
        "Every item is then **reconciled** against the tenant's existing projects (BLK-1.2), "
        "so the plan answers the question that decides the batch: *which of these is a new "
        "version of something I already have?* An item resolves to `append-version` or "
        "`create-project`, naming the `matched_project`, the `match_basis` that found it "
        "(repository provenance, then slug, then the document's own identity — which is how a "
        "file that moved within the repository still matches), a `match_confidence` distinct "
        "from the format-detection `confidence`, and the `proposed_version` it would create. "
        "What a match *means* comes from the reconciliation policy — the registered "
        "repository's override, else the tenant default, else `append-when-matched` — "
        "reported as `version_policy` / `version_policy_source`. `always-create` reports the "
        "matches it is ignoring rather than hiding them, and `always-ask` marks every item "
        "`unresolved` for a per-item choice at apply time.\n\n"
        "The response carries a `plan_fingerprint` (BLK-1.3) describing exactly these "
        "resolutions. Echo it on the submit call and the apply refuses to run a plan that has "
        "drifted since you read it — someone else creating the project one of your items was "
        "going to mint, or taking the version another proposed — naming the rows that moved "
        "rather than importing something you never saw.\n\n"
        "Nothing is persisted and no job is created — reconciliation is reads only. Item "
        "bytes are returned only when `include_documents` is set; the submit endpoint "
        "re-plans the same payload itself, so a client that just renders the list does not "
        "need them."
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
    requested = _requested_paths(body)
    plan = _plan_payload(
        members,
        source_label=label,
        # Ticked files (BLK-1.5) group over the whole fetched selection and are capped after
        # narrowing, so grouping must not truncate first. One item per member is the ceiling
        # nothing can exceed.
        max_items=len(members) if requested else None,
    )
    groups, narrowed_skipped, truncated, total_items = _narrow_to_requested(
        plan, requested=requested, git_result=git_result
    )

    # Reconciliation (BLK-1.2): the plan's other half — which of these items is a new version
    # of something the tenant already has. Both steps are synchronous DB work, so they run off
    # the event loop; both are reads, which is what keeps the endpoint's write-nothing
    # guarantee intact.
    policy = await asyncio.to_thread(_resolve_plan_policy, body, tenant_id=tenant_id)
    resolutions = await asyncio.to_thread(
        _reconcile_groups,
        groups,
        tenant_id=tenant_id,
        policy=policy.policy,
        git_result=git_result,
    )

    items = [
        _plan_item(group, resolved, include_document=body.include_documents)
        for group, resolved in zip(groups, resolutions)
    ]
    skipped = [
        BulkImportSkippedMember(path=entry.path, reason=entry.reason) for entry in plan.skipped
    ] + narrowed_skipped
    return BulkImportPlanResponse(
        items=items,
        skipped=skipped,
        truncated=truncated,
        total_items=total_items,
        max_items=_max_items(),
        source_label=label,
        git_source=(
            SpecImportGitSource(**git_result.provenance.as_dict()) if git_result else None
        ),
        version_policy=policy.policy.value,
        version_policy_source=policy.source.value,
        plan_fingerprint=encode_plan_fingerprint(_reviewed_items(groups, resolutions)),
        summary=_plan_summary(items, len(skipped)),
    )


@router.post(
    "/{tenant_slug}/import/bulk",
    response_model=BulkImportStartResponse,
    summary="Start one import job per independent spec in a bulk payload",
    description=(
        "Re-plan the payload server-side (identical bytes always yield an identical plan), "
        "**reconcile it exactly as the plan endpoint did**, and start one ordinary import job "
        "per item (MFI-29.5). Pass `keys` to import a subset of the planned items; omit it to "
        "attempt every planned item.\n\n"
        "Each item is applied at the destination its plan row resolved to (BLK-1.2): a matched "
        "item appends its proposed version to that project, an unmatched item creates one. "
        "**`overrides` change that per item** — `mode: existing` (optionally with a "
        "`project_id`) appends where the plan would have created, `mode: new` creates where it "
        "would have appended, and `version_id` alone carries a real version number without "
        "moving the item. An item with no override applies the plan, so agreeing with the plan "
        "costs nothing to express. Every started row reports its `resolution`, "
        "`target_project_id` and `version_id`, so the response states what was done rather "
        "than only that something was.\n\n"
        "**`dry_run` is the verify pass**, not a lesser one: it resolves and validates every "
        "item through the same computation the apply uses and persists nothing — no project, "
        "no version, no catalog row — so the rows it returns are the import it would perform. "
        "\n\n"
        "**Send `plan_fingerprint`** and a plan that drifted since it was reviewed is refused "
        "with `TARGET_PLAN_STALE` (409), carrying a `drift` list naming each item that moved "
        "and what it moved from — checked before any item starts, so nothing is written.\n\n"
        "Each item is otherwise gated and scheduled independently: an item whose format has no "
        "adapter, whose key is not in the plan, which the tenant's import quality policy "
        "refuses (IXH-2.3), or whose target BLK-1.1 will not honour (an unknown project, a "
        "catalog item named explicitly, a version label already taken) is reported as a "
        "**failed row with a taxonomy code** while every other item still starts — a partial "
        "failure never aborts the batch. Items that do start run the unchanged import chain, "
        "including the §0.2 routing that decides Catalog vs Projects, so nothing about a bulk "
        "import differs from importing the same document on its own.\n\n"
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
    requested = _requested_paths(body)
    plan = _plan_payload(
        members, source_label=label, max_items=len(members) if requested else None
    )
    # The submit re-plans the same payload the plan endpoint described, so it has to narrow it
    # the same way — otherwise `keys` would be checked against a different item set than the
    # one the reader was shown.
    groups, narrowed_skipped, _truncated, _total = _narrow_to_requested(
        plan, requested=requested, git_result=git_result
    )
    by_key = {group.key: group for group in groups}

    # Reconcile before anything is started: the apply's destinations are the plan's answer
    # (BLK-1.2) plus the reviewer's overrides, and the drift check needs the fresh answer to
    # compare against the one that was reviewed. One reconciler serves the whole batch and is
    # handed on to the per-item version derivation, so each project is read once.
    reconciler = ProjectReconciler(db, tenant_id=tenant_id)
    policy = await asyncio.to_thread(_resolve_plan_policy, body, tenant_id=tenant_id)
    resolutions = await asyncio.to_thread(
        _reconcile_groups,
        groups,
        tenant_id=tenant_id,
        policy=policy.policy,
        git_result=git_result,
        reconciler=reconciler,
    )
    resolved_by_key = dict(zip((group.key for group in groups), resolutions))

    requested_keys = [key.strip() for key in body.keys if key and key.strip()]
    overrides = {
        entry.key.strip(): _item_override(entry)
        for entry in body.overrides
        if entry.key.strip()
    }
    overrides = {key: value for key, value in overrides.items() if not value.is_empty()}

    _enforce_plan_fingerprint(body.plan_fingerprint, groups, resolutions, keys=requested_keys)

    selected: List[Tuple[str, Optional[BulkGroup]]] = (
        [(key, by_key.get(key)) for key in requested_keys]
        if requested_keys
        else [(group.key, group) for group in groups]
    )
    # An override for an item this batch is not importing is a mistake worth reporting: it says
    # the reviewer believes a decision is being applied that is not. It joins the result list as
    # its own failed row rather than being dropped.
    chosen = {key for key, _ in selected}
    selected += [(key, None) for key in overrides if key not in chosen]

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
                resolved=resolved_by_key.get(key),
                override=overrides.get(key),
                reconciler=reconciler,
            )
        )

    accepted = sum(1 for item in items if item.state == "accepted")
    return BulkImportStartResponse(
        batch_id=str(uuid.uuid4()),
        dry_run=body.dry_run,
        items=items,
        skipped=[
            BulkImportSkippedMember(path=entry.path, reason=entry.reason)
            for entry in plan.skipped
        ]
        + narrowed_skipped,
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
    resolved: Optional[ItemResolution] = None,
    override: Optional[ItemOverride] = None,
    reconciler: Optional[ProjectReconciler] = None,
) -> BulkImportStartItem:
    """Gate, target and schedule one item, converting any refusal into a failed row.

    Every failure mode of a single import — unknown key, unrecognised format, a
    blocking quality policy, a target BLK-1.1 refuses — is a per-item outcome here,
    because the batch's contract is that one bad document cannot cost the user the
    other nineteen.

    Args:
        key: The requested item key.
        group: The planned item, or ``None`` when the key is not in the plan.
        tenant_slug: The importing tenant's slug.
        tenant_id: Its id.
        user_id: The acting user.
        source_label: Label of the whole payload, for the item's filename hint.
        dry_run: Whether to run the item without persisting.
        git_result: The repository selection, when the payload came from git.
        resolved: The item's BLK-1.2 reconciliation, or ``None`` when it is not a planned
            item (an unknown key never reaches the target decision).
        override: The reviewer's per-item decision, when one was sent (BLK-1.3).
        reconciler: The batch's reconciler, used to read the target project's existing
            version labels when deriving the version to create.

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

    # Where this item goes, and as which version (BLK-1.3). Blocking DB reads hide behind
    # ``version_labels``, so the decision runs off the event loop like the reconciliation did.
    try:
        target = await asyncio.to_thread(
            _decide_target,
            resolved,
            override,
            tenant_id=tenant_id,
            suggested_name=name,
            suggested_slug=slug,
            reconciler=reconciler,
        )
    except ItemTargetError as exc:
        row.error = _taxonomy_error(exc.code, exc.message)
        return row

    row.resolution = target.action.value  # type: ignore[assignment]
    row.target_project_id = target.lands_on
    row.version_id = target.version_id
    row.overridden = target.overridden
    row.resolution_detail = target.detail
    row.name = target.name
    row.slug = target.slug

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
            project=SpecImportProjectTarget(
                project_id=target.project_id, name=target.name, slug=target.slug
            ),
            version=SpecImportVersionTarget(version_id=target.version_id),
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
    try:
        accepted = await schedule_spec_import(tenant_slug, tenant_id, user_id, request)
    except HTTPException as exc:
        # BLK-1.1 refuses a target it cannot honour by raising. For one import that is the
        # response; for a batch it is one row.
        row.error = _target_refusal(exc)
        return row
    row.state = "accepted"
    row.job_id = accepted.job_id
    row.status_path = accepted.status_path
    row.error = None
    return row


def _decide_target(
    resolved: Optional[ItemResolution],
    override: Optional[ItemOverride],
    *,
    tenant_id: str,
    suggested_name: str,
    suggested_slug: str,
    reconciler: Optional[ProjectReconciler],
) -> ItemTarget:
    """Resolve one item's destination, reading version labels through the batch reconciler.

    Blocking DB work (label reads) — call via ``asyncio.to_thread``.

    Args:
        resolved: The item's reconciliation. ``None`` only for a caller that skipped the plan,
            which is treated as "nothing matched" so the item creates a project.
        override: The reviewer's decision for this item, or ``None``.
        tenant_id: The acting tenant, scoping the label reads.
        suggested_name: The item's catalog name.
        suggested_slug: Its slug.
        reconciler: The batch's reconciler; a fresh one is built when a caller has none.

    Returns:
        The :class:`~app.bulk_import_apply.ItemTarget` this item's job is built from.

    Raises:
        ItemTargetError: The item is undecided and no override said what to do.
    """
    handle = reconciler or ProjectReconciler(db, tenant_id=tenant_id)
    if resolved is None:
        resolved = ItemResolution(
            resolution=Resolution.CREATE_PROJECT,
            match=None,
            proposed_version=ProposedVersion(
                version_id=_DEFAULT_ITEM_VERSION, derived_from=VersionDerivation.DEFAULT
            ),
        )
    return decide_item_target(
        resolved,
        override,
        suggested_name=suggested_name,
        suggested_slug=suggested_slug,
        default_version_id=_DEFAULT_ITEM_VERSION,
        version_labels=handle.version_labels,
    )


@router.post(
    "/{tenant_slug}/import/bulk/status",
    response_model=BulkImportStatusResponse,
    summary="Roll up the jobs of one bulk batch into a per-item result list",
    description=(
        "Fan out over the `(key, job_id)` pairs a bulk submit returned and report each "
        "item's state, its authoritative routing destination and created item once it "
        "completes, and its taxonomy-coded error when it fails — plus the counts a summary "
        "line needs and a `done` flag that is true once every item is terminal.\n\n"
        "A completed row also names its **realized destination** (BLK-1.3): `outcome` is "
        "`version-appended` or `project-created`, with the `project_id`, `project_slug` and "
        "`version_id` it landed on, and the summary counts both. That is read back from the "
        "catalog rather than echoed from what the submit predicted, so the roll-up states what "
        "happened.\n\n"
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
    tenant_id = str(auth_data.get("tenant_id") or "")
    # One label read per *distinct* project, so a batch of twenty revisions on one project
    # costs one query rather than twenty.
    labels: Dict[str, Tuple[str, ...]] = {}
    rows: List[BulkImportStatusItem] = []
    for ref in body.items:
        rows.append(await _status_row(tenant_slug, ref, tenant_id=tenant_id, labels=labels))

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
            created=sum(1 for row in rows if row.outcome == "project-created"),
            appended=sum(1 for row in rows if row.outcome == "version-appended"),
        ),
        done=all(row.state in _TERMINAL_STATES or row.state == "not-found" for row in rows),
    )


async def _status_row(
    tenant_slug: str,
    ref: BulkImportStatusRef,
    *,
    tenant_id: str = "",
    labels: Optional[Dict[str, Tuple[str, ...]]] = None,
) -> BulkImportStatusItem:
    """Flatten one job's status into a batch result row.

    Args:
        tenant_slug: The tenant that owns the batch.
        ref: The item key and its job id.
        tenant_id: The acting tenant's id, scoping the realized-destination read. Empty skips
            it, which only costs the row its ``outcome``.
        labels: Per-call cache of ``project_id -> version labels``, shared across the batch.

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
    result = status.result
    project_id = result.project_id if result else None
    return BulkImportStatusItem(
        key=ref.key,
        job_id=status.job_id,
        state=status.state,
        percent=status.percent,
        target=routing.get("target") if isinstance(routing, dict) else None,
        project_slug=result.project_slug if result else None,
        project_id=project_id,
        version_id=result.version_id if result else None,
        outcome=await _realized_outcome(
            status.state, project_id, tenant_id=tenant_id, labels=labels
        ),
        error=status.error,
    )


async def _realized_outcome(
    state: str,
    project_id: Optional[str],
    *,
    tenant_id: str,
    labels: Optional[Dict[str, Tuple[str, ...]]],
) -> Optional[str]:
    """Say what a finished item **did** to the tenant, read back from the catalog (BLK-1.3).

    Read back rather than echoed, because a roll-up that repeated the submit's prediction
    could not tell the user that the prediction was wrong. The catalog answers it directly:
    a revision that is its project's only version is a project this batch produced, and one
    that joined other versions was appended to a project that was already there. That holds
    for both submit shapes — a catalog item takes its append by slug rather than by project
    id (see :mod:`app.bulk_import_apply`), and the version count says the same thing either
    way.

    The read is a snapshot, so a project that gains an unrelated version between the import
    finishing and this call can read as an append. That is the same tolerance every other
    row of this endpoint has, and the alternative — trusting what the client says it asked
    for — is what the ticket rules out.

    Args:
        state: The job's state; only a completed job has a destination to report.
        project_id: The project the job recorded, or ``None`` when it produced none.
        tenant_id: The acting tenant, scoping the read. Empty skips it.
        labels: The per-call label cache, or ``None`` to read uncached.

    Returns:
        ``"project-created"``, ``"version-appended"``, or ``None`` when there is nothing to
        report yet.
    """
    if state != "completed" or not project_id or not tenant_id:
        return None
    cache = labels if labels is not None else {}
    if project_id not in cache:
        try:
            found = await asyncio.to_thread(
                db.list_project_version_labels, project_id, tenant_id
            )
        except Exception:  # noqa: BLE001 - a roll-up must never fail on a decoration
            return None
        cache[project_id] = tuple(found or ())
    return "version-appended" if len(cache[project_id]) > 1 else "project-created"


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
