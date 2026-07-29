"""Conversion provenance evidence history — CPDO-3.3 (#4803).

The read side of the evidence snapshots the commit path stores (:mod:`app.conversion_job` writes
them via ``Database.upsert_conversion_evidence_snapshot``, V215). Both surfaces — the catalog item's
history (``catalog_routes``) and the converted Project's history (``projects_routes``) — build their
responses through this module so a provenance row, a degrade state, and an evidence page look
identical no matter which side asked.

Three jobs:

* :func:`provenance_entry` — normalize one ledger row (with the V215 history enrichment) onto the
  wire model, mapping the empty-string storage sentinels (``projection_manifest_hash``,
  ``source_hash``) to ``None``.
* :func:`current_source_digest` — digest the item's *currently captured* source so a client can mark
  rows whose stored ``source_hash`` differs as historic. Best-effort by design: a broken source read
  yields ``None``, never an error, because the history list must stay readable.
* :func:`evidence_response` — serve one page of a stored snapshot's graph, or the truthful degrade
  (``predates_snapshots`` / ``snapshot_missing`` / ``unreadable``) as HTTP 200. The graph is served
  from the snapshot store only — never rebuilt — so it is the evidence the conversion was approved
  with, regardless of how the source or the converter changed since.
"""

import logging
from typing import Any, Dict, Optional

from fastapi import HTTPException

from .catalog_detail import resolve_source_payload
from .conversion_projection import (
    ConversionEdgeScope,
    ConversionManifest,
    paginate_conversion_evidence,
    summarize_conversion_manifest,
)
from .models import (
    ConversionEvidenceResponse,
    ConversionProvenanceEntry,
    ConversionSnapshotState,
)
from .payload_analysis import source_digest

logger = logging.getLogger(__name__)

__all__ = [
    "provenance_entry",
    "current_source_digest",
    "evidence_response",
    "parse_evidence_scope",
]


def parse_evidence_scope(scope: Optional[str]) -> Optional[ConversionEdgeScope]:
    """Parse an optional evidence-scope query value; unknown scopes are a 400, like the projection."""
    if scope is None:
        return None
    try:
        return ConversionEdgeScope(scope.strip().lower())
    except ValueError as exc:
        allowed = ", ".join(member.value for member in ConversionEdgeScope)
        raise HTTPException(
            status_code=400,
            detail=f"Unknown projection scope {scope!r}; expected one of: {allowed}.",
        ) from exc


def _none_if_empty(value: Any) -> Optional[str]:
    """Map the ledger's empty-string sentinels to ``None`` for the wire contract."""
    if not value:
        return None
    return str(value)


def provenance_entry(row: Dict[str, Any]) -> ConversionProvenanceEntry:
    """Project one enriched ``conversion_provenance`` row onto its wire model.

    Args:
        row: A row from ``Database.get_conversions_for_source`` /
            ``get_conversions_for_project`` / ``get_conversion_provenance_by_id`` — the ledger
            columns plus ``snapshot_available`` and the joined project display columns.

    Returns:
        The normalized :class:`~app.models.ConversionProvenanceEntry`.
    """
    tool_versions = row.get("converter_tool_versions") or {}
    summary = row.get("projection_manifest") or {}
    return ConversionProvenanceEntry(
        provenance_id=str(row["id"]),
        created_at=row.get("created_at"),
        created_by=_none_if_empty(row.get("created_by")),
        reconverted=bool(row.get("reconverted")),
        conversion_mode=tool_versions.get("conversion-mode"),
        source_project_id=_none_if_empty(row.get("source_project_id")),
        source_project_name=row.get("source_project_name"),
        source_format=row.get("source_format"),
        source_version_id=_none_if_empty(row.get("source_version_id")),
        target_project_id=str(row["target_project_id"]),
        target_project_name=row.get("target_project_name"),
        target_project_slug=row.get("target_project_slug"),
        target_project_deleted=row.get("target_project_deleted_at") is not None,
        target_version_label=row.get("target_version_label"),
        target_version_record_id=_none_if_empty(row.get("target_version_id")),
        fidelity_score=row.get("fidelity_score"),
        fidelity_grade=row.get("fidelity_grade"),
        fidelity_tier=row.get("fidelity_tier"),
        tool_versions=tool_versions,
        defaults=summary.get("defaults") or {},
        schema_version=summary.get("schema_version"),
        manifest_hash=_none_if_empty(row.get("projection_manifest_hash")),
        source_hash=_none_if_empty(row.get("source_hash")),
        snapshot_available=bool(row.get("snapshot_available")),
    )


def current_source_digest(item: Dict[str, Any]) -> Optional[str]:
    """Digest of a catalog item's currently captured source text, or ``None``.

    ``None`` covers every non-content case truthfully: no captured source, a URL-only source, or a
    broken source read. The history list stays readable either way — the client simply cannot say
    whether the source changed.
    """
    try:
        payload = resolve_source_payload(item)
    except Exception:  # noqa: BLE001 - a broken source read must not break the history list
        logger.warning(
            "Source payload unreadable for catalog item %s", item.get("id"), exc_info=True
        )
        return None
    if not payload or payload.get("mode") != "content":
        return None
    content = payload.get("content")
    if not content:
        return None
    return source_digest(content)


def _unavailable(
    row: Dict[str, Any],
    reason: str,
    *,
    item_id: Optional[str],
    project_id: Optional[str],
) -> ConversionEvidenceResponse:
    """The degrade shape: snapshot unavailable for ``reason``, summary/page null, HTTP 200."""
    return ConversionEvidenceResponse(
        provenance_id=str(row["id"]),
        item_id=item_id,
        project_id=project_id,
        manifest_hash=_none_if_empty(row.get("projection_manifest_hash")),
        source_hash=_none_if_empty(row.get("source_hash")),
        snapshot=ConversionSnapshotState(status="unavailable", reason=reason),
        summary=None,
        page=None,
    )


def evidence_response(
    *,
    row: Dict[str, Any],
    snapshot_row: Optional[Dict[str, Any]],
    cursor: Optional[str],
    limit: int,
    scope: Optional[ConversionEdgeScope],
    item_id: Optional[str] = None,
    project_id: Optional[str] = None,
) -> ConversionEvidenceResponse:
    """Serve one page of a historical conversion's stored evidence graph, or the truthful degrade.

    Args:
        row: The provenance row being served (already authorized by the caller).
        snapshot_row: The content-addressed snapshot row for the provenance row's manifest hash, or
            ``None`` when no snapshot is stored.
        cursor: Opaque page cursor; ``None`` starts at the beginning.
        limit: Maximum edges per page (clamped by the paginator).
        scope: Restrict the page to one edge scope; ``None`` pages every scope.
        item_id: Catalog item id to echo, on the catalog surface.
        project_id: Target Project id to echo, on the project surface.

    Returns:
        The :class:`~app.models.ConversionEvidenceResponse`. Degrade states are data, not errors:
        ``predates_snapshots`` (empty manifest hash — committed before snapshots existed),
        ``snapshot_missing`` (a hash with no stored snapshot — the best-effort write failed), or
        ``unreadable`` (the stored manifest no longer validates against this reader's contract).

    Raises:
        ValueError: When ``cursor`` is malformed (the routes map this to HTTP 422).
    """
    if not row.get("projection_manifest_hash"):
        return _unavailable(row, "predates_snapshots", item_id=item_id, project_id=project_id)
    if snapshot_row is None:
        return _unavailable(row, "snapshot_missing", item_id=item_id, project_id=project_id)

    try:
        manifest = ConversionManifest.model_validate(snapshot_row.get("manifest") or {})
    except Exception:  # noqa: BLE001 - a snapshot this reader cannot parse degrades, never 500s
        logger.warning(
            "Stored conversion evidence snapshot %s failed validation",
            row.get("projection_manifest_hash"),
            exc_info=True,
        )
        return _unavailable(row, "unreadable", item_id=item_id, project_id=project_id)

    page = paginate_conversion_evidence(manifest, cursor=cursor, limit=limit, scope=scope)
    return ConversionEvidenceResponse(
        provenance_id=str(row["id"]),
        item_id=item_id,
        project_id=project_id,
        manifest_hash=_none_if_empty(row.get("projection_manifest_hash")),
        source_hash=_none_if_empty(row.get("source_hash")),
        snapshot=ConversionSnapshotState(status="available", reason=None),
        summary=summarize_conversion_manifest(manifest).model_dump(mode="json"),
        page=page.model_dump(mode="json"),
    )
