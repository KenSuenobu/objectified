"""Resolve and authorize the project a specification import writes to (BLK-1.1, #5523).

A start request names its destination in :class:`app.models.SpecImportProjectTarget`, which
has two shapes:

* ``name`` + ``slug`` — create (or reuse) a project from that identity. Unchanged behaviour;
  this module does nothing for it.
* ``project_id`` — append a new version to a project that already exists.

The second shape needs answers this module supplies *before* the job is scheduled, so a
refused import costs nothing to clean up and writes nothing:

``TARGET_PROJECT_NOT_FOUND``
    The id names no live project of the acting tenant. A cross-tenant id is indistinguishable
    from a missing one on purpose — reporting 404 rather than 403 is the tenant-scoping
    convention the rest of the import routes follow, and it does not confirm the id exists.
``TARGET_NOT_PUBLISHABLE``
    The id names a **catalog item** (``apiome.projects.publishable = false``, the MFI-23.1
    slice). A catalog item keeps its uploaded source verbatim until the user runs the
    convert-to-OpenAPI flow, so it can never take an imported API version. The database
    already makes the flag write-once through the ``projects_forbid_publishable_change``
    trigger (``apiome-db/scripts/V138__catalog_item_publishable_guarantee_4010.sql``); this
    is the API-side twin, so a caller gets a reason and the name of the flow that fixes it
    instead of a constraint violation.
``TARGET_VERSION_EXISTS``
    The requested ``version.version_id`` is already a live version of the target project.
    Appending is *append* — it never silently overwrites, and never silently renames the way
    ``allocate_version_id`` does for the create-a-project branch. The one exception is the
    ``skip_duplicate_versions`` option, whose documented contract is exactly "a repeat import
    of this version line is an idempotent no-op".

Normalization
-------------
The two persistence paths — the ``apiome-ui`` tsx worker (OpenAPI) and the in-process adapter
pipeline (:func:`app.import_source_pipeline.persist_adapter_import`) — both already know how
to append to an existing project: they read ``metadata.existing_project_id``. So resolution
ends by folding ``project.project_id`` onto that field and backfilling the target project's
real ``name``/``slug``, which keeps job results and status rows reporting the project the
revision actually landed in. That leaves exactly one seam that has to know about the new
field, and no downstream reader changes.

Deliberately not checked
------------------------
* **Format vs. target.** A non-OpenAPI source appended to a publishable Project is allowed:
  ``publishable`` is a property of the *project*, and each revision records its own source
  format. Which formats a batch may aim at which targets is BLK-1.2's routing question.
* **The window between check and write.** These reads are not held under the job's write
  transaction, so a concurrent import could take the same version label in between. The
  unique ``(project_id, version_id)`` constraint is still the authority; this check exists so
  the ordinary collision is reported as an actionable refusal before a job is even created,
  not so it can be the only guard.
"""

from __future__ import annotations

import uuid
from typing import Any, Dict

from fastapi import HTTPException

from .intake_error_taxonomy import descriptor_for
from .models import SpecImportStartMetadata

__all__ = [
    "TARGET_NOT_PUBLISHABLE",
    "TARGET_PROJECT_NOT_FOUND",
    "TARGET_VERSION_EXISTS",
    "ImportProjectTargetError",
    "resolve_import_project_target",
]

#: The target id names no live project this tenant can see (404).
TARGET_PROJECT_NOT_FOUND = "TARGET_PROJECT_NOT_FOUND"
#: The target is a non-publishable catalog item, which cannot take an imported version (409).
TARGET_NOT_PUBLISHABLE = "TARGET_NOT_PUBLISHABLE"
#: The requested version id already exists on the target project (409).
TARGET_VERSION_EXISTS = "TARGET_VERSION_EXISTS"


class ImportProjectTargetError(Exception):
    """A start request whose existing-project target cannot be honored (BLK-1.1).

    Carries a taxonomy code rather than only a message so a caller keys guidance off the code,
    the same contract terminal import failures follow. Raised as an exception (not an
    ``HTTPException``) so non-HTTP callers — the bulk submit path of BLK-1.2, the CLI — can
    map it onto their own per-item error shape; :meth:`as_http_exception` produces the HTTP
    form for the routes.

    Attributes:
        code: The :mod:`app.intake_error_taxonomy` code for this refusal.
        message: What is wrong with *this* request, naming the offending id/version.
        status_code: The HTTP status the REST surface reports it as.
    """

    def __init__(self, *, code: str, message: str, status_code: int) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code

    def as_detail(self) -> Dict[str, Any]:
        """The typed error body: code, category, message, remediation and retriability.

        Returns:
            The ``detail`` payload, shaped like every other typed import refusal (compare the
            ``QUALITY_POLICY_BLOCKED`` gate in :mod:`app.spec_import_routes`).
        """
        descriptor = descriptor_for(self.code)
        return {
            "code": self.code,
            "category": descriptor.category.value if descriptor else "input",
            "message": self.message,
            "remediation": descriptor.remediation if descriptor else "",
            "retriable": bool(descriptor.retriable) if descriptor else False,
        }

    def as_http_exception(self) -> HTTPException:
        """This refusal as the ``HTTPException`` a REST route should raise."""
        return HTTPException(status_code=self.status_code, detail=self.as_detail())


def _looks_like_project_id(value: str) -> bool:
    """Whether ``value`` could be a project primary key at all.

    ``apiome.projects.id`` is a UUID column, so a malformed id would make the lookup raise
    inside the driver. Screening the shape here turns that into the same clean "no such
    project" answer a well-formed but unknown id gets.

    Args:
        value: The caller-supplied project id.

    Returns:
        True when ``value`` parses as a UUID.
    """
    try:
        uuid.UUID(value)
    except (ValueError, AttributeError, TypeError):
        return False
    return True


def resolve_import_project_target(
    metadata: SpecImportStartMetadata, *, tenant_id: str
) -> SpecImportStartMetadata:
    """Authorize an existing-project import target and normalize it for the worker paths.

    Blocking DB work (the psycopg driver is synchronous) — call via ``asyncio.to_thread``
    from async code.

    Args:
        metadata: The start request's metadata.
        tenant_id: The acting tenant; the target project must belong to it.

    Returns:
        ``metadata`` unchanged when no ``project.project_id`` was supplied (the create-a-project
        branch), otherwise a copy whose ``existing_project_id`` is the resolved project and
        whose ``project.name``/``project.slug`` are the target project's own.

    Raises:
        ImportProjectTargetError: The target is unknown to this tenant
            (``TARGET_PROJECT_NOT_FOUND``), is a non-publishable catalog item
            (``TARGET_NOT_PUBLISHABLE``), or already holds the requested version
            (``TARGET_VERSION_EXISTS``).
    """
    target_id = (metadata.project.project_id or "").strip()
    if not target_id:
        return metadata

    from .database import db

    project = (
        db.get_project_by_id(target_id, tenant_id) if _looks_like_project_id(target_id) else None
    )
    if not project:
        raise ImportProjectTargetError(
            code=TARGET_PROJECT_NOT_FOUND,
            message=f"No project {target_id!r} exists for this tenant.",
            status_code=404,
        )

    if not project.get("publishable"):
        raise ImportProjectTargetError(
            code=TARGET_NOT_PUBLISHABLE,
            message=(
                f"Project {target_id!r} is a catalog item, which stores its source verbatim "
                "and cannot receive an imported API version. Convert it to OpenAPI first "
                "and import into the Project that conversion produces."
            ),
            status_code=409,
        )

    version_id = metadata.version.version_id
    if not metadata.options.skip_duplicate_versions and db.get_version_by_version_id(
        target_id, version_id, tenant_id
    ):
        raise ImportProjectTargetError(
            code=TARGET_VERSION_EXISTS,
            message=(
                f"Project {target_id!r} already has version {version_id!r}. Choose an unused "
                "version id, or set options.skip_duplicate_versions to make a repeat import "
                "a no-op."
            ),
            status_code=409,
        )

    resolved_project = metadata.project.model_copy(
        update={
            "name": project.get("name") or metadata.project.name,
            "slug": project.get("slug") or metadata.project.slug,
        }
    )
    return metadata.model_copy(
        update={"project": resolved_project, "existing_project_id": target_id}
    )
