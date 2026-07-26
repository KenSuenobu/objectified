"""Load an export source's canonical model for a (tenant, artifact, version) — MFX-2.5 (#3842).

The export fidelity surface (``GET /export/targets``, ``POST /export/preview``) is
**version-scoped**: it predicts loss for a *specific* revision of an artifact the user is
viewing (Projects → project → version → Export). This module is the loader that turns those
coordinates into the :class:`~app.canonical_model.CanonicalApi` the fidelity engine consumes.

It reuses the convert path's reconstruction (:func:`app.catalog_conversion.build_conversion_source`,
MFI-22.6): resolve the requested revision, project its captured-source fields
(:meth:`app.database.Database.get_version_source_projection`), and parse + normalize that
captured source back into a canonical model — the same model the artifact was imported from.
Every way this can fail (unknown artifact/version, a revision with no captured source, an
unparseable source) is surfaced as an :class:`ExportSourceError` carrying an HTTP status the
route maps straight through, so a caller never has to re-classify it.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from pydantic import BaseModel, ConfigDict, Field

from .canonical_model import CanonicalApi
from .catalog_conversion import build_conversion_source
from .conversion_job import ConversionError
from .database import db
from .revision_deprecation import is_uuid_string

__all__ = [
    "ExportSourceError",
    "ExportSource",
    "load_export_source",
    "load_public_export_source",
    "resolve_revision_id",
]


class ExportSourceError(Exception):
    """Raised when an export source's canonical model cannot be loaded.

    Carries an HTTP ``status_code`` (``404`` for an unknown artifact/version, ``422`` for a
    revision that has no reconstructable source) so the route surfaces the right status without
    leaking a stack trace.
    """

    def __init__(self, message: str, *, status_code: int = 404) -> None:
        super().__init__(message)
        self.status_code = status_code


class ExportSource(BaseModel):
    """A loaded export source: its canonical model plus the coordinates it resolved to.

    The canonical model is what the fidelity engine walks; the ``artifact_id`` /
    ``version_record_id`` / ``version_label`` are echoed back in the REST response so the caller
    can confirm exactly which revision the fidelity was computed for.
    """

    model_config = ConfigDict(extra="forbid", arbitrary_types_allowed=True)

    api: CanonicalApi = Field(description="The reconstructed source canonical model.")
    artifact_id: str = Field(description="The owning artifact (project) id.")
    version_record_id: str = Field(description="The resolved revision (``versions.id``).")
    version_label: Optional[str] = Field(
        default=None, description="The revision's source-declared version label (e.g. ``1.0.0``)."
    )


def _resolve_revision_id(
    tenant_id: str, artifact_id: str, version: Optional[str]
) -> str:
    """Resolve ``(artifact, version)`` to a concrete revision (``versions.id``).

    ``version`` may be a revision UUID, a source-declared version label (``1.0.0``), or ``None``
    (the artifact's latest revision). Tenant scoping is enforced by every lookup.

    Args:
        tenant_id: Owning tenant id.
        artifact_id: The artifact (project) id.
        version: A revision UUID, a version label, or ``None`` for the latest revision.

    Returns:
        The resolved revision id.

    Raises:
        ExportSourceError: When the version (or, when omitted, any revision) cannot be found.
    """
    requested = (version or "").strip()
    if not requested:
        latest = db.get_latest_revision_id_for_project(artifact_id, tenant_id)
        if not latest:
            raise ExportSourceError(
                f"Artifact {artifact_id!r} has no versions to export.", status_code=404
            )
        return str(latest)

    if is_uuid_string(requested):
        # A revision UUID — validated (and matched to the artifact) by the projection lookup.
        return requested

    row = db.get_version_by_version_id(artifact_id, requested, tenant_id)
    if not row:
        raise ExportSourceError(
            f"Version {requested!r} was not found for artifact {artifact_id!r}.",
            status_code=404,
        )
    return str(row["id"])


#: Public alias for the revision resolver. The export loader is not the only surface that has to
#: turn ``(artifact, "1.0.0" | uuid | None)`` into a concrete ``versions.id`` — schema-reference
#: resolution (IXH-5.1, #5113) needs exactly the same three-way rule, and re-deriving it there
#: would let the two drift apart.
resolve_revision_id = _resolve_revision_id


def load_export_source(
    tenant_id: str, artifact_id: str, version: Optional[str] = None
) -> ExportSource:
    """Load the canonical model for a (tenant, artifact, version) export source.

    Resolves the requested revision, rebuilds its canonical model from the captured source (the
    same parse + normalize the import ran), and returns it with the resolved coordinates.

    Args:
        tenant_id: Owning tenant id (the caller's authenticated tenant).
        artifact_id: The artifact (project) id to export.
        version: A revision UUID, a version label (``1.0.0``), or ``None`` for the latest revision.

    Returns:
        The loaded :class:`ExportSource`.

    Raises:
        ExportSourceError: When the artifact/version is unknown (``404``) or the revision has no
            reconstructable source (``422``).
    """
    revision_id = _resolve_revision_id(tenant_id, artifact_id, version)

    projection = db.get_version_source_projection(revision_id, tenant_id)
    if projection is None or str(projection["id"]) != str(artifact_id):
        # Either the revision does not exist for this tenant, or it belongs to a different
        # artifact than the one requested — both are "not found" to the caller.
        raise ExportSourceError(
            f"Version {version!r} was not found for artifact {artifact_id!r}."
            if version
            else f"Artifact {artifact_id!r} was not found.",
            status_code=404,
        )

    item: Dict[str, Any] = {
        "id": str(projection["id"]),
        "slug": projection.get("project_slug"),
        "source_format": projection.get("source_format"),
        "protocol": projection.get("protocol"),
        "format_metadata": projection.get("format_metadata"),
        "tool_versions": projection.get("tool_versions"),
        "metadata": projection.get("metadata"),
    }

    try:
        source = build_conversion_source(item, source_version_id=revision_id)
    except ConversionError as exc:
        # No captured source / unresolvable adapter / unparseable text — nothing to compute
        # fidelity against. Surface with the conversion path's status (422/400).
        raise ExportSourceError(str(exc), status_code=exc.status_code) from exc

    return ExportSource(
        api=source.api,
        artifact_id=str(artifact_id),
        version_record_id=revision_id,
        version_label=projection.get("version_label"),
    )


def load_public_export_source(
    tenant_slug: str, project_slug: str, version_slug: str
) -> ExportSource:
    """Load the canonical model for a **published, public** revision, resolved by slugs (MFX-7.1).

    The public browse export path is anonymous: there is no authenticated tenant to scope by, so
    the source is resolved from the URL coordinates (tenant slug / project slug / version label)
    and hard-gated to the published+public slice by
    :meth:`app.database.Database.get_public_version_source_projection`. Anything outside that
    slice — a private version, an unpublished draft, an unknown slug — raises the same ``404`` so
    an anonymous caller can never probe for hidden artifacts. The canonical-model rebuild is the
    same parse + normalize the authenticated loader uses.

    Args:
        tenant_slug: The owning tenant's slug.
        project_slug: The project (artifact) slug within the tenant.
        version_slug: The version label (e.g. ``1.0.0``) of the published revision.

    Returns:
        The loaded :class:`ExportSource`.

    Raises:
        ExportSourceError: ``404`` when no published public revision matches the slugs; ``422``
            when the revision has no reconstructable captured source.
    """
    projection = db.get_public_version_source_projection(
        tenant_slug, project_slug, version_slug
    )
    if projection is None:
        raise ExportSourceError(
            f"Published version {version_slug!r} was not found for "
            f"{tenant_slug!r}/{project_slug!r}.",
            status_code=404,
        )

    revision_id = str(projection["version_record_id"])
    item: Dict[str, Any] = {
        "id": str(projection["id"]),
        "slug": projection.get("project_slug"),
        "source_format": projection.get("source_format"),
        "protocol": projection.get("protocol"),
        "format_metadata": projection.get("format_metadata"),
        "tool_versions": projection.get("tool_versions"),
        "metadata": projection.get("metadata"),
    }

    try:
        source = build_conversion_source(item, source_version_id=revision_id)
    except ConversionError as exc:
        # No captured source / unresolvable adapter / unparseable text — mirror the
        # authenticated loader's classification (422/400) for the public path.
        raise ExportSourceError(str(exc), status_code=exc.status_code) from exc

    return ExportSource(
        api=source.api,
        artifact_id=str(projection["id"]),
        version_record_id=revision_id,
        version_label=projection.get("version_label"),
    )
