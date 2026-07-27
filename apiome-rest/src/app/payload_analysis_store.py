"""Persistence for revision-scoped payload analysis — CPDO-1.1 (#4794).

:mod:`app.payload_analysis` defines *what* an analysis is; this module is the only place that reads
and writes one. It sits between the pure contract and ``apiome.payload_analysis`` (apiome-db V209)
so the analyzer SPI (CPDO-1.2), the catalog detail API, and the projection manifest (CPDO-1.3) all
meet the store through one door with the invariants applied once.

What that door enforces
-----------------------

**Absence is declared, never fabricated.** :func:`load_analysis_for_item` always returns a record.
A catalog item with no revision, no captured source, or no analysis yet gets a
:data:`~app.payload_analysis.STATUS_UNAVAILABLE` document with the reason code that is actually
true for it. There is no code path that returns an empty tree while claiming the source was
described.

**A record is redacted before it is stored, and can only be further restricted on read.** The write
path applies the value-visibility policy before the insert, so the store never holds more payload
material than policy allows. The read path may apply a *more* restrictive level, never a wider one —
:func:`~app.payload_analysis.apply_value_visibility` cannot re-materialise values that were dropped
on the way in.

**A record the database would reject never reaches it.** :func:`store_analysis` validates the
document against :meth:`~app.payload_analysis.PayloadAnalysisDocument.contract_violations` — the same
three truthfulness invariants V209 enforces as CHECK constraints — and raises a clear
:class:`PayloadAnalysisContractError` instead of letting an opaque driver error surface from inside
a transaction.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from .catalog_detail import derive_catalog_source
from .database import db
from .payload_analysis import (
    REASON_ANALYZER_FAILED,
    REASON_NO_SOURCE_CAPTURED,
    REASON_NOT_ANALYZED,
    PayloadAnalysisDocument,
    PayloadAnalysisRecord,
    PayloadAnalysisSummary,
    ValueVisibility,
    analysis_content_fingerprint,
    apply_value_visibility,
    record_from_row,
    summarize_document,
    summary_from_row,
    unavailable_document,
)

logger = logging.getLogger(__name__)

__all__ = [
    "DEFAULT_VALUE_VISIBILITY",
    "PayloadAnalysisContractError",
    "analysis_summary_for_item",
    "load_analysis_for_item",
    "store_analysis",
]

#: The value-visibility level an analysis is stored under unless a caller states otherwise.
#: Structural: presence and length, never the value. See :class:`app.payload_analysis.ValueVisibility`.
DEFAULT_VALUE_VISIBILITY = ValueVisibility.DEFAULT


class PayloadAnalysisContractError(ValueError):
    """A document violates the payload-analysis contract and must not be stored.

    Raised by :func:`store_analysis` *before* any write, so a malformed analysis fails at the
    boundary with a message naming every violation, rather than as a ``CheckViolation`` from the
    driver halfway through a transaction.
    """


def _restrict_on_read(
    document: PayloadAnalysisDocument,
    visibility: Optional[str],
) -> PayloadAnalysisDocument:
    """Apply a read-time ``visibility`` request to a document that was already reduced on write.

    Two no-ops, both safe *because the write path already applied a level*: no request at all, and a
    request for the level the record was stored under. Anything else is applied, which — since
    :func:`~app.payload_analysis.apply_value_visibility` can only drop material — can only narrow
    what the caller sees. A request to widen is therefore accepted and simply returns less than was
    asked for, because the values are not in the record to return.

    Args:
        document: The stored document.
        visibility: Requested :class:`~app.payload_analysis.ValueVisibility` level, or ``None``.

    Returns:
        The document, restricted when a different level was requested.
    """
    if not visibility or visibility == document.redaction.value_visibility:
        return document
    return apply_value_visibility(document, visibility, policy_source="request")


def store_analysis(
    *,
    tenant_id: str,
    project_id: str,
    version_id: str,
    document: PayloadAnalysisDocument,
    value_visibility: str = DEFAULT_VALUE_VISIBILITY,
    policy_source: str = "default",
    created_by: Optional[str] = None,
) -> Optional[PayloadAnalysisRecord]:
    """Record an analysis for a source revision.

    Redacts first, validates second, writes third. The redaction happens before validation so the
    fingerprint and the contract check both describe *what is actually stored*, not what the
    analyzer handed over.

    The write itself is append-only and idempotent by content: re-storing an identical analysis for
    the same revision returns the existing row rather than appending a duplicate sequence, so an
    analyzer sweep is safe to re-run.

    Args:
        tenant_id: Tenant that owns the revision.
        project_id: Catalog project the revision belongs to.
        version_id: The analysed source revision.
        document: The analysis, as the analyzer produced it.
        value_visibility: Level to store the record under; defaults to
            :data:`DEFAULT_VALUE_VISIBILITY`.
        policy_source: Where that level came from (``default``, ``tenant``, ``format``).
        created_by: User whose action produced the analysis.

    Returns:
        The stored :class:`~app.payload_analysis.PayloadAnalysisRecord`, or ``None`` when the store
        rejected the scoping ids (not UUIDs) or returned no row.

    Raises:
        PayloadAnalysisContractError: When the document violates the contract. Nothing is written.
    """
    # Unconditionally — never short-circuited on "the document already declares this level". An
    # analyzer hands over a document whose redaction block is still at its default while its tree is
    # still full of observed values; skipping the pass because those two happen to name the same
    # level is precisely how payload material would reach the store.
    redacted = apply_value_visibility(document, value_visibility, policy_source=policy_source)

    violations = redacted.contract_violations()
    if violations:
        raise PayloadAnalysisContractError(
            "Payload analysis violates its contract: " + "; ".join(violations)
        )

    payload = redacted.model_dump(mode="json", by_alias=False)
    row = db.insert_payload_analysis(
        tenant_id=tenant_id,
        project_id=project_id,
        version_id=version_id,
        schema_version=redacted.schema_version,
        content_fingerprint=analysis_content_fingerprint(redacted),
        analyzer_key=redacted.analyzer.key,
        analyzer_version=redacted.analyzer.version,
        status=redacted.status,
        status_reason=redacted.status_reason,
        source_format=redacted.source_format,
        source_hash=redacted.source_hash,
        tool_versions=payload.get("analyzer", {}).get("tool_versions") or {},
        tree=payload.get("tree") or [],
        metrics=payload.get("metrics") or {},
        warnings=payload.get("warnings") or [],
        redaction=payload.get("redaction") or {},
        created_by=created_by,
    )
    if not row:
        return None
    return record_from_row(row)


def _absent_record(
    item: Dict[str, Any],
    version_record_id: Optional[str],
) -> PayloadAnalysisRecord:
    """Build the declared ``unavailable`` record for an item that has no stored analysis.

    The reason code distinguishes two genuinely different situations, and does so from evidence
    rather than assumption:

    * :data:`~app.payload_analysis.REASON_NO_SOURCE_CAPTURED` — the item's provenance shows no source
      material was ever captured, so there is nothing an analyzer could have looked at. That is a
      fact about the import, and it is the honest thing to tell a user asking why there is no detail.
    * :data:`~app.payload_analysis.REASON_NOT_ANALYZED` — source exists but no analysis has been
      recorded (a revision imported before CPDO-1.1, or one the extractors have not reached).

    Args:
        item: The catalog item row.
        version_record_id: The item's latest revision, when it has one.

    Returns:
        A :class:`~app.payload_analysis.PayloadAnalysisRecord` with an empty tree and a stated reason.
    """
    source = derive_catalog_source(item.get("format_metadata"), item.get("metadata"))
    has_source = bool(source.get("has_content")) or bool(source.get("uri"))

    if version_record_id and not has_source:
        reason = REASON_NO_SOURCE_CAPTURED
        message = "No source material was captured for this revision, so there is nothing to analyze."
    else:
        reason = REASON_NOT_ANALYZED
        message = (
            "This revision has no recorded payload analysis. Re-import the source to produce one."
        )

    return PayloadAnalysisRecord(
        tenant_id=item.get("tenant_id"),
        project_id=item.get("id"),
        version_record_id=version_record_id,
        analysis=unavailable_document(
            reason,
            source_format=item.get("source_format"),
            message=message,
        ),
    )


def load_analysis_for_item(
    tenant_id: str,
    item: Dict[str, Any],
    *,
    version_record_id: Optional[str] = None,
    value_visibility: Optional[str] = None,
) -> PayloadAnalysisRecord:
    """Read the analysis in force for a catalog item's latest revision.

    Always returns a record. A revision that was never analysed — including every revision imported
    before this contract existed — yields a declared ``unavailable`` record from
    :func:`_absent_record`, so a caller never has to distinguish "no analysis" from "empty analysis"
    and a UI never has to render a fabricated tree.

    Args:
        tenant_id: Tenant the caller is acting in.
        item: The catalog item row (a project row; its id is the project id).
        version_record_id: The revision to read; resolved to the item's latest when omitted.
        value_visibility: Optional read-time :class:`~app.payload_analysis.ValueVisibility`
            restriction. It can only narrow what the stored record carries.

    Returns:
        The :class:`~app.payload_analysis.PayloadAnalysisRecord` for the revision.
    """
    item_id = item.get("id")
    revision_id = version_record_id or (
        db.get_latest_revision_id_for_project(item_id, tenant_id) if item_id else None
    )

    row = db.get_payload_analysis_for_version(revision_id) if revision_id else None
    if not row:
        record = _absent_record(item, revision_id)
    else:
        record = record_from_row(row)

    return record.model_copy(
        update={"analysis": _restrict_on_read(record.analysis, value_visibility)}
    )


def analysis_summary_for_item(
    tenant_id: str,
    item: Dict[str, Any],
    *,
    version_record_id: Optional[str] = None,
) -> PayloadAnalysisSummary:
    """Project the item's analysis onto the summary a catalog detail read embeds.

    The detail response carries the summary rather than the tree: a tree can be thousands of nodes,
    and the detail screen only needs to know whether to offer the *Format details* tab and what to
    say when it cannot. The summary carries counts and status — never payload material — which is
    why it is readable by anyone who can read the catalog item at all.

    Args:
        tenant_id: Tenant the caller is acting in.
        item: The catalog item row.
        version_record_id: The revision to summarize; resolved to the item's latest when omitted.

    Returns:
        The :class:`~app.payload_analysis.PayloadAnalysisSummary`; a declared ``unavailable`` summary
        when the revision has no analysis, or a ``failed`` one when it could not be read.
    """
    item_id = item.get("id")

    try:
        revision_id = version_record_id or (
            db.get_latest_revision_id_for_project(item_id, tenant_id) if item_id else None
        )
        # Read the summary columns only — the tree stays in the database, so the detail endpoint's
        # cost does not grow with the size of the analysed payload.
        row = (
            db.get_payload_analysis_summary_row_for_version(revision_id) if revision_id else None
        )
    except Exception:
        # The summary is one field of a much larger detail response; a store fault must not take the
        # whole catalog item down with it. It is reported as ``failed`` rather than ``unavailable``,
        # because "we could not read the analysis" and "there is no analysis" are different facts
        # and a user deserves the one that is true.
        logger.warning(
            "Payload analysis summary unreadable for catalog item %s", item_id, exc_info=True
        )
        return summarize_document(
            unavailable_document(
                REASON_ANALYZER_FAILED,
                source_format=item.get("source_format"),
                message="The payload analysis for this revision could not be read.",
                failed=True,
            ),
            version_record_id=version_record_id,
        )

    if row:
        return summary_from_row(row)

    record = _absent_record(item, revision_id)
    return summarize_document(
        record.analysis,
        analysis_id=record.analysis_id,
        version_record_id=record.version_record_id,
        analyzed_at=record.analyzed_at,
    )
