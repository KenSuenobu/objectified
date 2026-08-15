"""
Persisted per-revision lint reports: content fingerprint, capture and freshness (#5259).

The quality/lint report for a schema revision is **stored on the version record**
(``versions.quality_score`` / ``quality_grade`` / ``quality_report_fingerprint`` /
``quality_report``, V124 + V160) so it can be read back without re-linting. Linting runs when
a revision is *imported* or *changed* (push, fork, publish, an explicit report open after the
schema content changed) — never merely because a list of versions was rendered.

This module owns the three seams every capture site shares:

* :func:`openapi_source_fingerprint` — a stable hash of the reconstructed OpenAPI document the
  report was scored from. Persisted inside ``quality_report`` as ``source_fingerprint`` so a
  later reader can tell whether the stored report still describes the current content by
  *rebuilding the document* (a handful of queries) instead of re-running the linter and the
  external validation pack.
* :func:`persist_version_lint_report` — best-effort write of a scored
  :class:`~app.schema_lint.LintResult` (plus the source fingerprint and the guide it was scored
  under) onto the revision. Never raises: the revision is already committed and a failed
  capture only leaves the report for the next explicit lint to fill.
* :func:`capture_version_quality_score` — reconstruct + lint + persist (+ external evidence)
  for a revision id. Used after spec imports and after revision-creating pushes/forks.
"""

from __future__ import annotations

import hashlib
import json
import logging
from typing import Any, Dict, Mapping, Optional

logger = logging.getLogger(__name__)

#: Key under which the persisted ``quality_report`` carries the content fingerprint.
SOURCE_FINGERPRINT_KEY = "source_fingerprint"


def openapi_source_fingerprint(spec: Mapping[str, Any]) -> str:
    """Return a stable ``sha256:`` fingerprint of a reconstructed OpenAPI document.

    The hash is taken over the canonical JSON serialization (sorted keys, compact separators)
    so it depends only on the document content, not on dict ordering. Two reconstructions of
    an unchanged revision therefore yield the same fingerprint, and any schema edit (class,
    property, path, metadata that reaches the document) changes it.

    Args:
        spec: The OpenAPI document produced by ``openapi_for_revision``.

    Returns:
        ``"sha256:<hex>"``.
    """
    blob = json.dumps(
        spec, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str
    )
    return f"sha256:{hashlib.sha256(blob.encode('utf-8')).hexdigest()}"


def persistable_lint_report(
    result: Any,
    spec: Optional[Mapping[str, Any]] = None,
    *,
    guide: Any = None,
) -> Dict[str, Any]:
    """Build the ``quality_report`` JSON to store for a scored OpenAPI revision.

    Extends :meth:`app.schema_lint.LintResult.report_dict` with the content fingerprint of the
    document that was linted and the identity of the style guide it was scored under, so a
    stored report can be (a) checked for freshness without re-linting and (b) served with the
    same guide context the live report carries.

    Args:
        result: The :class:`~app.schema_lint.LintResult` (or any object exposing
            ``report_dict()``) to persist.
        spec: The reconstructed OpenAPI document ``result`` was computed from. When omitted the
            report is stored without a content fingerprint (it is then served as-is until the
            next explicit re-lint).
        guide: The resolved style guide (``guide_id`` / ``name`` / ``source`` attributes), or
            ``None`` when unknown.

    Returns:
        A JSON-ready dict suitable for ``db.set_version_quality_score(..., quality_report=...)``.
    """
    report: Dict[str, Any] = dict(result.report_dict())
    if spec is not None:
        report[SOURCE_FINGERPRINT_KEY] = openapi_source_fingerprint(spec)
    if guide is not None:
        report["guide_id"] = getattr(guide, "guide_id", None)
        report["guide_name"] = getattr(guide, "name", None)
        report["guide_source"] = getattr(guide, "source", None)
    return report


def stored_report_is_current(
    stored_report: Optional[Mapping[str, Any]], spec: Mapping[str, Any]
) -> bool:
    """Return True when ``stored_report`` was scored from content identical to ``spec``.

    A stored report is *current* when it carries a ``source_fingerprint`` that equals the
    fingerprint of ``spec``. A report without a fingerprint (imported before #5259, or a
    canonical-model report for a non-OpenAPI import) cannot be compared and reads as *not*
    current — callers decide whether such legacy reports are served as-is.

    Args:
        stored_report: The persisted ``quality_report`` dict (may be empty / None).
        spec: The freshly reconstructed OpenAPI document for the revision.

    Returns:
        True only when both fingerprints exist and match.
    """
    if not stored_report:
        return False
    stored_fp = stored_report.get(SOURCE_FINGERPRINT_KEY)
    if not stored_fp:
        return False
    return str(stored_fp) == openapi_source_fingerprint(spec)


def persist_version_lint_report(
    version_record_id: str,
    tenant_id: str,
    result: Any,
    spec: Optional[Mapping[str, Any]] = None,
    *,
    guide: Any = None,
    guide_revision_id: Optional[str] = None,
) -> bool:
    """Best-effort: store a scored lint result (and its content fingerprint) on a revision.

    Args:
        version_record_id: The ``versions.id`` that was linted.
        tenant_id: The tenant owning the revision (scopes the write).
        result: The :class:`~app.schema_lint.LintResult` to persist.
        spec: The OpenAPI document ``result`` was computed from (fingerprinted for freshness).
        guide: The style guide the report was scored under (stored for guide context).
        guide_revision_id: The immutable guide revision to pin (GOV-1.6); resolved by the DB
            layer when omitted.

    Returns:
        True when the revision row was updated; False when nothing was written (unknown
        revision, another tenant's revision, or any failure — which is logged, never raised).
    """
    try:
        from .database import db

        return bool(
            db.set_version_quality_score(
                version_record_id,
                tenant_id,
                int(result.score),
                str(result.grade),
                result.report_fingerprint,
                quality_report=persistable_lint_report(result, spec, guide=guide),
                guide_revision_id=guide_revision_id,
            )
        )
    except Exception:  # noqa: BLE001 - persistence is strictly best-effort
        logger.warning(
            "Failed to persist lint report for revision %s", version_record_id, exc_info=True
        )
        return False


def capture_version_quality_score(
    tenant_slug: str, tenant_id: str, version_record_id: str
) -> None:
    """Best-effort: compute and persist the lint/quality score for a revision.

    Runs after a completed spec import (#3609 follow-up) and after a revision-creating push
    or fork (#5259) so every revision carries a stored score the versions/projects lists can
    surface without linting on read. Strictly best-effort: the revision is already committed,
    so any failure here just leaves the score for an on-demand lint to fill and never affects
    the caller's outcome. Imported lazily to avoid a heavy import-time dependency cycle.

    Args:
        tenant_slug: The tenant slug (used to reconstruct the OpenAPI document).
        tenant_id: The tenant owning the revision.
        version_record_id: The ``versions.id`` to score.
    """
    try:
        from .compatibility_engine import openapi_for_revision
        from .database import db
        from .style_guide_engine import guided_lint_openapi_spec

        version = db.get_version_by_id(version_record_id, tenant_id)
        if not version:
            return
        spec = openapi_for_revision(version, tenant_slug, tenant_id)
        # GOV-1.4: score under the revision's resolved style guide (project → tenant →
        # default), so the captured score matches what the lint route reports.
        project_id = str(version.get("project_id") or "") or None
        result, guide = guided_lint_openapi_spec(spec, tenant_id, project_id=project_id)
        db.set_version_quality_score(
            version_record_id,
            tenant_id,
            result.score,
            result.grade,
            result.report_fingerprint,
            quality_report=persistable_lint_report(result, spec, guide=guide),
        )
        try:
            from .openapi_validation_evidence import (
                capture_openapi_external_validation_evidence_sync,
            )

            capture_openapi_external_validation_evidence_sync(
                spec,
                version_record_id=version_record_id,
                tenant_id=tenant_id,
                project_id=project_id,
            )
        except Exception:  # noqa: BLE001
            logger.warning(
                "Failed to capture external OpenAPI validation evidence for %s",
                version_record_id,
                exc_info=True,
            )
    except Exception:  # noqa: BLE001 - capture is strictly best-effort
        logger.warning(
            "Failed to capture quality score for revision %s",
            version_record_id,
            exc_info=True,
        )
