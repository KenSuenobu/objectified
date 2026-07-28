"""The contract-suite compilation service — ECA-1.1 (#4729).

Answers *give me the executable contract for this version* and composes exactly the pieces that
already exist:

* :mod:`app.schema_reference` turns the URL's reference into a revision's canonical model — the
  same ``project/{slug}/{version}`` grammar the IXH-5.1 validate, IXH-5.2 generate, and IXH-5.3
  targets endpoints take, so a caller addresses one version one way across the whole surface;
* :mod:`app.contract_suite` compiles the model into a deterministic manifest;
* :mod:`app.database` supplies the one fact the compiler cannot know — whether the resolved
  revision is **published** — which is echoed on the manifest rather than assumed.

**Nothing is persisted.** Compiling is a pure read: no job, no revision, no audit row. The
manifest is derived from the version, so it can always be re-derived; ECA-1.3 is where a *run's*
evidence gets stored, and it will reference this manifest by digest.

**Failure shape** follows the intake convention the rest of this surface uses: a version that
cannot yield a suite is a 200 carrying ``ok = false`` and a stable
:mod:`app.intake_error_taxonomy` code with remediation, never a 5xx. Only *addressing* faults are
HTTP errors, and those come out of :mod:`app.schema_reference` unchanged — 400 for a malformed
reference, 404 for one that names nothing visible, 422 for one that resolves to material no
canonical model can be rebuilt from.

**A suite is not a target.** No URL, no credential, and no environment reaches this module. The
manifest describes requests relative to a base URL the runner supplies, and a version with
security requirements gets a finding saying so. Target definitions are ECA-1.2's job.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from pydantic import BaseModel, ConfigDict, Field

from .contract_suite import (
    ContractSuiteManifest,
    ContractSuiteOptions,
    SuiteSourceInfo,
    compile_contract_suite,
)
from .database import db
from .import_source_pipeline import build_job_error
from .models import SpecImportJobError
from .schema_reference import (
    SchemaReferenceError,
    parse_schema_reference,
    resolve_revision_model,
)

__all__ = [
    "ContractSuiteCompileRequest",
    "ContractSuiteResponse",
    # Re-exported so a route can catch the addressing fault without a second import.
    "SchemaReferenceError",
    "compile_version_contract_suite",
]


class ContractSuiteCompileRequest(BaseModel):
    """What to compile for the version named in the URL.

    The options are wrapped rather than inlined so the request can grow a sibling field without
    changing the meaning of an existing body. An empty body compiles everything under the
    default options.
    """

    model_config = ConfigDict(extra="forbid")

    options: ContractSuiteOptions = Field(
        default_factory=ContractSuiteOptions,
        description=(
            "Compiler options. They are echoed on the manifest and hashed into its digest, so "
            "the same version compiled with the same options always yields the same suite."
        ),
    )


class ContractSuiteResponse(BaseModel):
    """The compiled suite for one version."""

    model_config = ConfigDict(extra="forbid")

    ok: bool = Field(description="Whether a suite could be compiled at all.")
    version_ref: str = Field(description="The reference exactly as it was requested.")
    manifest: Optional[ContractSuiteManifest] = Field(
        default=None,
        description=(
            "The compiled suite. Present whenever `ok` is true — including when it contains "
            "no cases, which is a real answer about a version that declares no operations."
        ),
    )
    error: Optional[SpecImportJobError] = Field(
        default=None,
        description="Populated when `ok` is false: stable taxonomy code plus remediation.",
    )


def compile_version_contract_suite(
    version_ref: str,
    request: ContractSuiteCompileRequest,
    *,
    tenant_id: str,
) -> ContractSuiteResponse:
    """Compile the contract suite for the version at ``version_ref``.

    Args:
        version_ref: A ``project/{slug}/{version}`` or ``catalog/{item}/{version}`` reference —
            the schema-reference grammar without a trailing type segment.
        request: The compiler options.
        tenant_id: The caller's authenticated tenant; every lookup is scoped to it.

    Returns:
        The :class:`ContractSuiteResponse`.

    Raises:
        SchemaReferenceError: When the reference is malformed or type-qualified (400), names
            nothing visible (404), or resolves to material no canonical model can be rebuilt
            from (422). Every *other* failure is a 200 with ``ok = false``.
    """
    reference = parse_schema_reference(version_ref)
    if reference.type_name is not None:
        raise SchemaReferenceError(
            "A contract suite is compiled from a whole version; drop the trailing type segment "
            f"(use `{reference.kind}/{reference.artifact}/{reference.version}`).",
            status_code=400,
        )

    revision = resolve_revision_model(reference, tenant_id=tenant_id)

    if not revision.api.services:
        return ContractSuiteResponse(
            ok=False,
            version_ref=version_ref,
            error=build_job_error(
                "FORMAT_MISMATCH",
                "This version declares no operations, so there is no contract to execute. A "
                "contract suite is compiled from callable operations; a data-schema artifact "
                "(Avro, XSD, JSON Schema) has none. Validate payloads against its types "
                "instead.",
            ),
        )

    manifest = compile_contract_suite(
        revision.api,
        options=request.options,
        source=_source_info(version_ref, revision.coordinates, tenant_id=tenant_id),
    )
    return ContractSuiteResponse(ok=True, version_ref=version_ref, manifest=manifest)


def _source_info(
    version_ref: str, coordinates: Dict[str, Any], *, tenant_id: str
) -> SuiteSourceInfo:
    """Build the manifest's provenance block from the resolved coordinates.

    Publication state is looked up rather than inferred, and stays ``None`` when the revision
    row cannot be read — a suite must never claim a version is published when nothing checked.

    Args:
        version_ref: The reference as requested.
        coordinates: The coordinates :func:`app.schema_reference.resolve_revision_model` echoed.
        tenant_id: The caller's tenant, which scopes the revision lookup.

    Returns:
        The :class:`~app.contract_suite.SuiteSourceInfo` to echo on the manifest.
    """
    revision_id = coordinates.get("revision_id")
    published: Optional[bool] = None
    if revision_id:
        row = db.get_version_by_id(str(revision_id), tenant_id)
        if row is not None:
            published = bool(row.get("published"))

    return SuiteSourceInfo(
        kind=coordinates.get("kind"),
        reference=version_ref,
        artifact_id=_text(coordinates.get("artifact_id")),
        artifact_slug=_text(coordinates.get("artifact_slug")),
        revision_id=_text(revision_id),
        version_label=_text(coordinates.get("version_label")),
        source_format=_text(coordinates.get("source_format")),
        published=published,
    )


def _text(value: Any) -> Optional[str]:
    """Render a coordinate as a string, preserving ``None`` (a UUID arrives as an object)."""
    return None if value is None else str(value)
