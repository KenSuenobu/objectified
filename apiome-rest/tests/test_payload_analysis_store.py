"""Tests for the payload-analysis store (CPDO-1.1, #4794).

``app.payload_analysis_store`` is the single door between the pure contract and
``apiome.payload_analysis``. These tests pin the invariants that door applies, against a stubbed
data layer:

* a record is redacted **before** it is stored, so the store never holds more payload material than
  policy allows, and the fingerprint describes what is actually stored;
* a record the database would reject never reaches it;
* the write is append-only and idempotent by content;
* a revision with no analysis reads back as a *declared* ``unavailable`` record with the reason that
  is actually true for it — never a fabricated tree;
* a read-time visibility request can only narrow what the stored record carries.
"""

from unittest.mock import patch

import pytest

from app.payload_analysis import (
    REASON_NO_SOURCE_CAPTURED,
    REASON_NOT_ANALYZED,
    STATUS_AVAILABLE,
    STATUS_UNAVAILABLE,
    AnalysisNode,
    AnalyzerInfo,
    PayloadAnalysisDocument,
    ValueVisibility,
    analysis_content_fingerprint,
    apply_value_visibility,
    bound_tree,
    source_digest,
)
from app.payload_analysis_store import (
    PayloadAnalysisContractError,
    analysis_summary_for_item,
    load_analysis_for_item,
    store_analysis,
)

_HASH = source_digest("ISA*00*          *00*          *ZZ*SENDER")
_TENANT = "11111111-1111-4111-8111-111111111111"
_PROJECT = "22222222-2222-4222-8222-222222222222"
_VERSION = "33333333-3333-4333-8333-333333333333"


def _document() -> PayloadAnalysisDocument:
    """An ``available`` record whose leaf element carries an observed value."""
    tree, metrics = bound_tree(
        [
            AnalysisNode(
                id="isa",
                kind="interchange",
                name="ISA",
                children=[
                    AnalysisNode(
                        id="nm1-01",
                        kind="element",
                        name="NM101",
                        value="SENSITIVE-ACCOUNT-42",
                        value_present=True,
                    )
                ],
            )
        ]
    )
    return PayloadAnalysisDocument(
        status=STATUS_AVAILABLE,
        source_format="edi-x12",
        source_hash=_HASH,
        analyzer=AnalyzerInfo(key="edix12", version="1.0.0", tool_versions={"edix12": "1.4.0"}),
        tree=tree,
        metrics=metrics,
    )


class _StubDb:
    """A minimal stand-in for ``app.database.db`` that records what the store asked it to do."""

    def __init__(self, *, analysis_row=None, summary_row=None, revision_id=_VERSION):
        self.analysis_row = analysis_row
        self.summary_row = summary_row if summary_row is not None else analysis_row
        self.revision_id = revision_id
        self.inserts = []

    def get_latest_revision_id_for_project(self, project_id, tenant_id):
        return self.revision_id

    def get_payload_analysis_for_version(self, version_id):
        return self.analysis_row

    def get_payload_analysis_summary_row_for_version(self, version_id):
        if self.summary_row is None:
            return None
        return {k: v for k, v in self.summary_row.items() if k != "tree"}

    def insert_payload_analysis(self, **kwargs):
        self.inserts.append(kwargs)
        payload = dict(kwargs)
        existing = self.analysis_row
        if existing and existing.get("content_fingerprint") == kwargs["content_fingerprint"]:
            return existing
        row = {
            "id": "an-new",
            "tenant_id": kwargs["tenant_id"],
            "project_id": kwargs["project_id"],
            "version_id": kwargs["version_id"],
            "analysis_sequence": (existing or {}).get("analysis_sequence", 0) + 1,
            "created_by": kwargs.get("created_by"),
            "created_at": "2026-07-27T00:00:00+00:00",
            **{
                key: payload[key]
                for key in (
                    "schema_version",
                    "content_fingerprint",
                    "source_format",
                    "source_hash",
                    "analyzer_key",
                    "analyzer_version",
                    "tool_versions",
                    "status",
                    "status_reason",
                    "tree",
                    "metrics",
                    "warnings",
                    "redaction",
                )
            },
        }
        self.analysis_row = row
        return row


def _stored_row(document: PayloadAnalysisDocument, **overrides) -> dict:
    """A stored-row dict for ``document``, as the data layer returns one."""
    payload = document.model_dump(mode="json", by_alias=False)
    row = {
        "id": "an-1",
        "tenant_id": _TENANT,
        "project_id": _PROJECT,
        "version_id": _VERSION,
        "analysis_sequence": 1,
        "schema_version": document.schema_version,
        "content_fingerprint": analysis_content_fingerprint(document),
        "source_format": document.source_format,
        "source_hash": document.source_hash,
        "analyzer_key": document.analyzer.key,
        "analyzer_version": document.analyzer.version,
        "tool_versions": document.analyzer.tool_versions,
        "status": document.status,
        "status_reason": document.status_reason,
        "tree": payload["tree"],
        "metrics": payload["metrics"],
        "warnings": payload["warnings"],
        "redaction": payload["redaction"],
        "created_by": None,
        "created_at": "2026-07-27T00:00:00+00:00",
    }
    row.update(overrides)
    return row


_ITEM_WITH_SOURCE = {
    "id": _PROJECT,
    "tenant_id": _TENANT,
    "source_format": "edi-x12",
    "format_metadata": {"sourceLabel": "claim.edi", "inputKind": "file", "sourceContent": "ISA*00*"},
    "metadata": {},
}

_ITEM_WITHOUT_SOURCE = {
    "id": _PROJECT,
    "tenant_id": _TENANT,
    "source_format": "edi-x12",
    "format_metadata": {"inputKind": "file"},
    "metadata": {},
}


# ---------------------------------------------------------------------------
# store_analysis
# ---------------------------------------------------------------------------
def test_store_redacts_before_writing():
    """The observed value never reaches the store — redaction is applied on the way in."""
    stub = _StubDb()
    with patch("app.payload_analysis_store.db", stub):
        record = store_analysis(
            tenant_id=_TENANT,
            project_id=_PROJECT,
            version_id=_VERSION,
            document=_document(),
        )

    written = stub.inserts[0]
    assert "SENSITIVE-ACCOUNT-42" not in str(written["tree"])
    assert written["redaction"]["value_visibility"] == ValueVisibility.STRUCTURAL
    assert written["redaction"]["redacted_node_count"] == 1
    assert record.analysis.tree[0].children[0].value is None


def test_store_fingerprints_what_it_actually_stored():
    """The fingerprint describes the redacted record, not the analyzer's unredacted output."""
    stub = _StubDb()
    with patch("app.payload_analysis_store.db", stub):
        store_analysis(
            tenant_id=_TENANT,
            project_id=_PROJECT,
            version_id=_VERSION,
            document=_document(),
        )

    expected = analysis_content_fingerprint(
        apply_value_visibility(_document(), ValueVisibility.STRUCTURAL)
    )
    assert stub.inserts[0]["content_fingerprint"] == expected


def test_store_can_be_asked_to_withhold_everything():
    """A stricter policy is honoured at write time, so the store holds even less."""
    stub = _StubDb()
    with patch("app.payload_analysis_store.db", stub):
        store_analysis(
            tenant_id=_TENANT,
            project_id=_PROJECT,
            version_id=_VERSION,
            document=_document(),
            value_visibility=ValueVisibility.NONE,
            policy_source="tenant",
        )

    redaction = stub.inserts[0]["redaction"]
    assert redaction["value_visibility"] == ValueVisibility.NONE
    assert redaction["policy_source"] == "tenant"


def test_store_refuses_a_document_the_database_would_reject():
    """Contract violations fail at the boundary with a message, and nothing is written."""
    stub = _StubDb()
    broken = PayloadAnalysisDocument(status=STATUS_AVAILABLE, tree=_document().tree)

    with patch("app.payload_analysis_store.db", stub):
        with pytest.raises(PayloadAnalysisContractError) as excinfo:
            store_analysis(
                tenant_id=_TENANT,
                project_id=_PROJECT,
                version_id=_VERSION,
                document=broken,
            )

    assert "source_hash" in str(excinfo.value)
    assert stub.inserts == []


def test_store_refuses_a_fabricated_tree_on_an_unavailable_record():
    """An "unavailable" record carrying a tree is exactly the failure this ticket prevents."""
    stub = _StubDb()
    fabricated = PayloadAnalysisDocument(
        status=STATUS_UNAVAILABLE,
        status_reason=REASON_NOT_ANALYZED,
        tree=_document().tree,
    )
    with patch("app.payload_analysis_store.db", stub):
        with pytest.raises(PayloadAnalysisContractError):
            store_analysis(
                tenant_id=_TENANT,
                project_id=_PROJECT,
                version_id=_VERSION,
                document=fabricated,
            )
    assert stub.inserts == []


def test_store_is_idempotent_by_content():
    """Re-storing an unchanged analysis returns the existing row rather than appending a sequence."""
    stored = apply_value_visibility(_document(), ValueVisibility.STRUCTURAL)
    stub = _StubDb(analysis_row=_stored_row(stored))

    with patch("app.payload_analysis_store.db", stub):
        record = store_analysis(
            tenant_id=_TENANT,
            project_id=_PROJECT,
            version_id=_VERSION,
            document=_document(),
        )

    assert record.analysis_id == "an-1"
    assert record.analysis_sequence == 1


def test_store_appends_a_new_sequence_when_the_analysis_changed():
    """A changed analysis appends; the old row is not rewritten (records are immutable)."""
    stored = apply_value_visibility(_document(), ValueVisibility.STRUCTURAL)
    stub = _StubDb(analysis_row=_stored_row(stored))
    upgraded = _document().model_copy(
        update={"analyzer": AnalyzerInfo(key="edix12", version="2.0.0")}
    )

    with patch("app.payload_analysis_store.db", stub):
        record = store_analysis(
            tenant_id=_TENANT,
            project_id=_PROJECT,
            version_id=_VERSION,
            document=upgraded,
        )

    assert record.analysis_sequence == 2
    assert record.analysis.analyzer.version == "2.0.0"


def test_store_returns_none_for_a_non_uuid_scope():
    """A malformed scoping id is refused by the data layer, and the store says so plainly."""
    stub = _StubDb()
    stub.insert_payload_analysis = lambda **kwargs: None
    with patch("app.payload_analysis_store.db", stub):
        assert (
            store_analysis(
                tenant_id="not-a-uuid",
                project_id=_PROJECT,
                version_id=_VERSION,
                document=_document(),
            )
            is None
        )


# ---------------------------------------------------------------------------
# load_analysis_for_item
# ---------------------------------------------------------------------------
def test_load_returns_the_stored_record():
    """A revision with an analysis reads it back, identity included."""
    stored = apply_value_visibility(_document(), ValueVisibility.STRUCTURAL)
    stub = _StubDb(analysis_row=_stored_row(stored))

    with patch("app.payload_analysis_store.db", stub):
        record = load_analysis_for_item(_TENANT, _ITEM_WITH_SOURCE)

    assert record.analysis.status == STATUS_AVAILABLE
    assert record.analysis_id == "an-1"
    assert record.version_record_id == _VERSION


def test_load_declares_not_analyzed_for_a_legacy_revision():
    """A revision imported before this contract existed reports why, and carries no tree."""
    stub = _StubDb(analysis_row=None)

    with patch("app.payload_analysis_store.db", stub):
        record = load_analysis_for_item(_TENANT, _ITEM_WITH_SOURCE)

    assert record.analysis.status == STATUS_UNAVAILABLE
    assert record.analysis.status_reason == REASON_NOT_ANALYZED
    assert record.analysis.tree == []
    assert record.analysis.source_format == "edi-x12"
    assert record.analysis_id is None


def test_load_declares_no_source_captured_when_nothing_was_captured():
    """"Nothing was captured" is a fact about the import, and it is reported as its own reason."""
    stub = _StubDb(analysis_row=None)

    with patch("app.payload_analysis_store.db", stub):
        record = load_analysis_for_item(_TENANT, _ITEM_WITHOUT_SOURCE)

    assert record.analysis.status_reason == REASON_NO_SOURCE_CAPTURED


def test_load_declares_not_analyzed_when_the_item_has_no_revision():
    """With no revision at all there is nothing to have analysed; the reason stays generic."""
    stub = _StubDb(analysis_row=None, revision_id=None)

    with patch("app.payload_analysis_store.db", stub):
        record = load_analysis_for_item(_TENANT, _ITEM_WITHOUT_SOURCE)

    assert record.analysis.status_reason == REASON_NOT_ANALYZED
    assert record.version_record_id is None


def test_load_applies_a_read_time_restriction():
    """A caller may ask for less than the record holds."""
    stored = apply_value_visibility(_document(), ValueVisibility.STRUCTURAL)
    stub = _StubDb(analysis_row=_stored_row(stored))

    with patch("app.payload_analysis_store.db", stub):
        record = load_analysis_for_item(
            _TENANT, _ITEM_WITH_SOURCE, value_visibility=ValueVisibility.NONE
        )

    element = record.analysis.tree[0].children[0]
    assert (element.value, element.value_present, element.value_length) == (None, None, None)
    assert record.analysis.redaction.value_visibility == ValueVisibility.NONE
    assert record.analysis.redaction.policy_source == "request"


def test_read_time_request_cannot_widen_a_stored_restriction():
    """Asking for ``full`` over a structurally-stored record returns no values — they are not there."""
    stored = apply_value_visibility(_document(), ValueVisibility.STRUCTURAL)
    stub = _StubDb(analysis_row=_stored_row(stored))

    with patch("app.payload_analysis_store.db", stub):
        record = load_analysis_for_item(
            _TENANT, _ITEM_WITH_SOURCE, value_visibility=ValueVisibility.FULL
        )

    assert record.analysis.tree[0].children[0].value is None


# ---------------------------------------------------------------------------
# analysis_summary_for_item
# ---------------------------------------------------------------------------
def test_summary_is_built_without_reading_the_tree():
    """The detail read's cost does not grow with the analysed payload: no tree column is read."""
    stored = apply_value_visibility(_document(), ValueVisibility.STRUCTURAL)
    stub = _StubDb(analysis_row=_stored_row(stored))
    stub.get_payload_analysis_for_version = lambda version_id: pytest.fail(
        "the summary path must not read the tree"
    )

    with patch("app.payload_analysis_store.db", stub):
        summary = analysis_summary_for_item(_TENANT, _ITEM_WITH_SOURCE)

    assert summary.available is True
    assert summary.node_count == 2
    assert summary.analysis_id == "an-1"


def test_summary_declares_absence_for_an_unanalysed_revision():
    """The detail read still gets a status and a reason when there is no record."""
    stub = _StubDb(analysis_row=None)

    with patch("app.payload_analysis_store.db", stub):
        summary = analysis_summary_for_item(_TENANT, _ITEM_WITH_SOURCE)

    assert summary.available is False
    assert summary.status == STATUS_UNAVAILABLE
    assert summary.status_reason == REASON_NOT_ANALYZED
