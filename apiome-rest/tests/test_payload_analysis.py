"""Contract tests for revision-scoped payload analysis (CPDO-1.1, #4794).

These pin the *pure* contract in ``app.payload_analysis`` — no database, no HTTP client. What they
protect, in the order the ticket's acceptance criteria state it:

* the documented Pydantic/JSON-Schema contract and its vocabulary;
* the three truthfulness invariants that mirror the apiome-db V209 CHECK constraints, so a record
  the database would reject is caught at the boundary;
* that absence is *declared* — a legacy or unanalysable source yields ``unavailable`` with a reason
  code, never a fabricated tree;
* that bounding is reported rather than silent, and a bounded record cannot claim to be complete;
* that redaction only ever removes payload material, and says how much it removed.
"""

import pytest

from app.payload_analysis import (
    ANALYSIS_REASONS,
    ANALYSIS_STATUSES,
    MAX_VALUE_PREVIEW_CHARS,
    PAYLOAD_ANALYSIS_SCHEMA_VERSION,
    REASON_ANALYZER_FAILED,
    REASON_BOUNDS_EXCEEDED,
    REASON_NO_SOURCE_CAPTURED,
    REASON_NOT_ANALYZED,
    REASON_UNSUPPORTED_FORMAT,
    SEVERITY_ERROR,
    SEVERITY_INFO,
    STATUS_AVAILABLE,
    STATUS_FAILED,
    STATUS_PARTIAL,
    STATUS_UNAVAILABLE,
    AnalysisMetrics,
    AnalysisNode,
    AnalysisWarning,
    AnalyzerInfo,
    PayloadAnalysisDocument,
    RedactionInfo,
    SourceLocation,
    ValueVisibility,
    analysis_content_fingerprint,
    apply_value_visibility,
    bound_tree,
    document_from_row,
    document_json_schema,
    record_from_row,
    source_digest,
    summarize_document,
    summary_from_row,
    unavailable_document,
)

# A digest of real shape, so records under test satisfy the source_hash CHECK.
_HASH = source_digest("ISA*00*          *00*          *ZZ*SENDER")


def _x12_tree() -> list:
    """A miniature X12 hierarchy: interchange → group → transaction set → segment → element."""
    return [
        AnalysisNode(
            id="isa",
            kind="interchange",
            name="ISA",
            attributes={"elementSeparator": "*", "segmentTerminator": "~"},
            location=SourceLocation(line=1, offset=0, length=106, ordinal=0),
            children=[
                AnalysisNode(
                    id="gs-0",
                    kind="functional_group",
                    name="GS",
                    ordinal=0,
                    children=[
                        AnalysisNode(
                            id="st-0",
                            kind="transaction_set",
                            name="ST",
                            attributes={"transactionSetId": "837", "version": "005010X222A1"},
                            children=[
                                AnalysisNode(
                                    id="nm1-0",
                                    kind="segment",
                                    name="NM1",
                                    ordinal=0,
                                    children=[
                                        AnalysisNode(
                                            id="nm1-01",
                                            kind="element",
                                            name="NM101",
                                            value="85",
                                            value_present=True,
                                        ),
                                        AnalysisNode(
                                            id="nm1-02",
                                            kind="element",
                                            name="NM102",
                                            value="",
                                            value_present=True,
                                        ),
                                    ],
                                )
                            ],
                        )
                    ],
                )
            ],
        )
    ]


def _available_document() -> PayloadAnalysisDocument:
    """Raw analyzer output over :func:`_x12_tree` — values still in it, no policy applied yet."""
    tree, metrics = bound_tree(_x12_tree())
    return PayloadAnalysisDocument(
        status=STATUS_AVAILABLE,
        source_format="edi-x12",
        source_hash=_HASH,
        analyzer=AnalyzerInfo(key="edix12", version="1.0.0", tool_versions={"edix12": "1.4.0"}),
        tree=tree,
        metrics=metrics,
    )


def _stored_document() -> PayloadAnalysisDocument:
    """The same analysis after the value-visibility policy has run — what actually gets stored."""
    return apply_value_visibility(_available_document(), ValueVisibility.STRUCTURAL)


# ---------------------------------------------------------------------------
# Vocabulary
# ---------------------------------------------------------------------------
def test_status_vocabulary_is_closed_and_ordered():
    """The four statuses are exactly what apiome-db V209's CHECK constraint permits."""
    assert ANALYSIS_STATUSES == (
        STATUS_AVAILABLE,
        STATUS_PARTIAL,
        STATUS_UNAVAILABLE,
        STATUS_FAILED,
    )


def test_reason_vocabulary_is_closed():
    """Reason codes are a closed set: a UI cannot explain absence from free text."""
    assert set(ANALYSIS_REASONS) == {
        REASON_NOT_ANALYZED,
        REASON_NO_SOURCE_CAPTURED,
        REASON_UNSUPPORTED_FORMAT,
        REASON_BOUNDS_EXCEEDED,
        REASON_ANALYZER_FAILED,
    }


def test_value_visibility_default_withholds_values():
    """The default policy is structural — presence and length, never the value itself."""
    assert ValueVisibility.DEFAULT == ValueVisibility.STRUCTURAL
    assert ValueVisibility.ALL == (
        ValueVisibility.NONE,
        ValueVisibility.STRUCTURAL,
        ValueVisibility.FULL,
    )


# ---------------------------------------------------------------------------
# Contract invariants (mirrors of the V209 CHECK constraints)
# ---------------------------------------------------------------------------
def test_available_document_is_storable():
    """A well-formed available record, once its visibility policy has run, has no violations."""
    document = _stored_document()
    assert document.contract_violations() == []
    assert document.is_storable


def test_raw_analyzer_output_is_not_storable_until_redacted():
    """Values still in the tree under a non-``full`` declared visibility is itself a violation.

    This is what stops a document whose redaction block merely *says* ``structural`` — the default —
    from being stored while its nodes still carry everything the analyzer observed.
    """
    document = _available_document()
    assert document.redaction.value_visibility == ValueVisibility.STRUCTURAL
    assert any("forbids" in problem for problem in document.contract_violations())
    assert _stored_document().contract_violations() == []


def test_none_visibility_forbids_even_value_metadata():
    """A record declaring ``none`` may not carry presence or length either."""
    document = _stored_document().model_copy(
        update={"redaction": RedactionInfo(value_visibility=ValueVisibility.NONE)}
    )
    assert any("value metadata" in problem for problem in document.contract_violations())


def test_full_visibility_permits_retained_values():
    """A record that declares ``full`` may legitimately carry what it observed."""
    document = apply_value_visibility(_available_document(), ValueVisibility.FULL)
    assert document.contract_violations() == []
    assert _element_nodes(document)[0].value == "85"


@pytest.mark.parametrize("status", [STATUS_AVAILABLE, STATUS_PARTIAL])
def test_analyzed_status_requires_a_source_hash(status):
    """A record that claims to describe source bytes must name them."""
    document = PayloadAnalysisDocument(
        status=status,
        status_reason=REASON_BOUNDS_EXCEEDED,
        tree=_x12_tree(),
    )
    assert any("source_hash" in problem for problem in document.contract_violations())


@pytest.mark.parametrize("status", [STATUS_UNAVAILABLE, STATUS_FAILED])
def test_absent_status_requires_an_empty_tree(status):
    """A record that describes nothing must contain nothing — no fabricated tree."""
    document = PayloadAnalysisDocument(
        status=status,
        status_reason=REASON_NOT_ANALYZED,
        tree=_x12_tree(),
    )
    assert any("empty tree" in problem for problem in document.contract_violations())


@pytest.mark.parametrize("status", [STATUS_PARTIAL, STATUS_UNAVAILABLE, STATUS_FAILED])
def test_non_available_status_requires_a_reason(status):
    """Anything other than ``available`` must say why."""
    document = PayloadAnalysisDocument(status=status, source_hash=_HASH)
    assert any("status_reason" in problem for problem in document.contract_violations())


def test_unknown_status_is_a_violation():
    """A status outside the vocabulary is refused before the database sees it."""
    document = PayloadAnalysisDocument(status="mostly-fine", source_hash=_HASH)
    assert any("not one of" in problem for problem in document.contract_violations())


def test_truncated_record_cannot_claim_to_be_available():
    """A bounded view is ``partial`` by definition; claiming completeness is a violation."""
    document = _stored_document()
    truncated = document.model_copy(
        update={"metrics": document.metrics.model_copy(update={"truncated": True})}
    )
    assert any("truncated" in problem for problem in truncated.contract_violations())


# ---------------------------------------------------------------------------
# Declared absence
# ---------------------------------------------------------------------------
def test_unavailable_document_is_declared_not_fabricated():
    """The absence constructor produces a storable, empty, reason-bearing record."""
    document = unavailable_document(REASON_NOT_ANALYZED, source_format="cobol-copybook")
    assert document.status == STATUS_UNAVAILABLE
    assert document.status_reason == REASON_NOT_ANALYZED
    assert document.tree == []
    assert document.source_format == "cobol-copybook"
    assert document.redaction.value_visibility == ValueVisibility.NONE
    assert document.contract_violations() == []


def test_unavailable_document_records_its_message_as_an_info_warning():
    """An explanation rides as a warning, so it is machine-readable rather than prose in a field."""
    document = unavailable_document(
        REASON_NO_SOURCE_CAPTURED, message="Nothing was captured for this revision."
    )
    assert [w.severity for w in document.warnings] == [SEVERITY_INFO]
    assert document.warnings[0].code == REASON_NO_SOURCE_CAPTURED
    assert document.metrics.warning_count == 1


def test_failed_analysis_is_distinguishable_from_absent_analysis():
    """An analyzer that errored is ``failed``, not ``unavailable`` — a different fact."""
    document = unavailable_document(
        REASON_ANALYZER_FAILED, message="Segment terminator not found.", failed=True
    )
    assert document.status == STATUS_FAILED
    assert [w.severity for w in document.warnings] == [SEVERITY_ERROR]
    assert document.contract_violations() == []


def test_unsupported_format_is_not_a_parse_failure():
    """A capability boundary and a parse failure are separate reasons with separate statuses."""
    unsupported = unavailable_document(REASON_UNSUPPORTED_FORMAT)
    assert unsupported.status == STATUS_UNAVAILABLE
    assert unsupported.status_reason == REASON_UNSUPPORTED_FORMAT


# ---------------------------------------------------------------------------
# Bounds
# ---------------------------------------------------------------------------
def test_bound_tree_keeps_everything_within_budget():
    """A tree inside the budget is kept whole and reported as untruncated."""
    tree, metrics = bound_tree(_x12_tree())
    assert metrics.truncated is False
    assert metrics.dropped_node_count == 0
    assert metrics.node_count == 6
    assert metrics.max_depth == 5
    assert metrics.kind_counts == {
        "interchange": 1,
        "functional_group": 1,
        "transaction_set": 1,
        "segment": 1,
        "element": 2,
    }
    assert tree[0].children[0].children[0].children[0].children[0].name == "NM101"


def test_bound_tree_reports_what_it_dropped():
    """Bounding is never silent: the metrics state the drop, so a caller must mark it partial."""
    tree, metrics = bound_tree(_x12_tree(), max_nodes=3)
    assert metrics.truncated is True
    assert metrics.node_count == 3
    assert metrics.dropped_node_count == 3


def test_bound_tree_keeps_the_top_of_the_structure():
    """Admission is breadth-first, so envelopes survive and deep leaves are what get dropped."""
    tree, _ = bound_tree(_x12_tree(), max_nodes=2)
    assert tree[0].kind == "interchange"
    assert [child.kind for child in tree[0].children] == ["functional_group"]
    assert tree[0].children[0].children == []


def test_bound_tree_applies_the_depth_budget():
    """Nodes below the depth budget are dropped with their subtrees."""
    tree, metrics = bound_tree(_x12_tree(), max_depth=2)
    assert metrics.max_depth == 2
    assert metrics.truncated is True
    assert tree[0].children[0].children == []


def test_bound_tree_does_not_mutate_its_input():
    """The analyzer's own tree is left intact — bounding returns a copy."""
    original = _x12_tree()
    bound_tree(original, max_nodes=1)
    assert original[0].children[0].children != []


def test_bound_tree_handles_an_empty_tree():
    """An empty tree bounds to an empty tree with zeroed metrics, not an error."""
    tree, metrics = bound_tree([])
    assert tree == []
    assert metrics.node_count == 0
    assert metrics.max_depth == 0
    assert metrics.truncated is False


def test_bounded_record_is_storable_as_partial():
    """The intended pairing — bounded tree plus ``partial`` plus the bounds reason — is storable."""
    tree, metrics = bound_tree(_x12_tree(), max_nodes=2)
    document = PayloadAnalysisDocument(
        status=STATUS_PARTIAL,
        status_reason=REASON_BOUNDS_EXCEEDED,
        source_hash=_HASH,
        tree=tree,
        metrics=metrics,
    )
    assert document.contract_violations() == []


# ---------------------------------------------------------------------------
# Redaction
# ---------------------------------------------------------------------------
def _element_nodes(document: PayloadAnalysisDocument) -> list:
    """The two leaf element nodes of the X12 fixture, wherever they sit in the tree."""
    node = document.tree[0]
    while node.children and node.children[0].kind != "element":
        node = node.children[0]
    return node.children


def test_structural_visibility_keeps_shape_and_drops_values():
    """Presence and length survive; the value does not. An empty element stays distinguishable."""
    reduced = apply_value_visibility(_available_document(), ValueVisibility.STRUCTURAL)
    first, second = _element_nodes(reduced)

    assert first.value is None
    assert first.value_present is True
    assert first.value_length == 2
    assert first.redacted is True

    # The empty-but-present element is still distinguishable from an absent one.
    assert second.value_present is True
    assert second.value_length == 0

    assert reduced.redaction.value_visibility == ValueVisibility.STRUCTURAL
    assert reduced.redaction.redacted_node_count == 2


def test_none_visibility_drops_presence_metadata_too():
    """``none`` withholds everything about the value, including whether there was one."""
    reduced = apply_value_visibility(_available_document(), ValueVisibility.NONE)
    first, second = _element_nodes(reduced)

    assert (first.value, first.value_present, first.value_length) == (None, None, None)
    assert (second.value, second.value_present, second.value_length) == (None, None, None)
    assert reduced.redaction.value_visibility == ValueVisibility.NONE
    assert reduced.redaction.redacted_node_count == 2


def test_none_visibility_does_not_count_a_node_that_had_nothing_to_withhold():
    """A node whose value was observed *absent* is stripped but not counted as redacted."""
    document = PayloadAnalysisDocument(
        status=STATUS_AVAILABLE,
        source_hash=_HASH,
        tree=[AnalysisNode(id="e", kind="element", value_present=False)],
    )
    reduced = apply_value_visibility(document, ValueVisibility.NONE)
    assert reduced.tree[0].redacted is False
    assert reduced.redaction.redacted_node_count == 0


def test_full_visibility_retains_values_but_truncates_them():
    """``full`` keeps what was observed, capped — an analysis is not a payload archive."""
    long_value = "X" * (MAX_VALUE_PREVIEW_CHARS + 50)
    document = PayloadAnalysisDocument(
        status=STATUS_AVAILABLE,
        source_hash=_HASH,
        tree=[AnalysisNode(id="e", kind="element", value=long_value, value_present=True)],
    )
    reduced = apply_value_visibility(document, ValueVisibility.FULL)
    assert reduced.tree[0].value == "X" * MAX_VALUE_PREVIEW_CHARS
    assert reduced.redaction.redacted_node_count == 0


def test_redaction_is_monotonic_and_cannot_be_widened():
    """Restricting then asking for ``full`` cannot re-materialise what was already dropped."""
    structural = apply_value_visibility(_available_document(), ValueVisibility.STRUCTURAL)
    widened = apply_value_visibility(structural, ValueVisibility.FULL)
    assert all(node.value is None for node in _element_nodes(widened))


def test_unknown_visibility_withholds_rather_than_discloses():
    """An unrecognised policy level fails closed to ``none``."""
    reduced = apply_value_visibility(_available_document(), "everything-please")
    assert reduced.redaction.value_visibility == ValueVisibility.NONE
    assert all(node.value is None for node in _element_nodes(reduced))


def test_redaction_accumulates_across_successive_applications():
    """Applying a second, narrower level adds to the count rather than resetting it."""
    structural = apply_value_visibility(_available_document(), ValueVisibility.STRUCTURAL)
    assert structural.redaction.redacted_node_count == 2
    narrowed = apply_value_visibility(structural, ValueVisibility.NONE)
    assert narrowed.redaction.redacted_node_count == 4


def test_redaction_records_its_policy_source():
    """Where the level came from rides on the record, so nobody has to guess which tier applied."""
    reduced = apply_value_visibility(
        _available_document(), ValueVisibility.NONE, policy_source="request"
    )
    assert reduced.redaction.policy_source == "request"


def test_redaction_does_not_mutate_its_input():
    """Redaction returns a copy; the caller's document keeps its values."""
    document = _available_document()
    apply_value_visibility(document, ValueVisibility.NONE)
    assert _element_nodes(document)[0].value == "85"


# ---------------------------------------------------------------------------
# Fingerprinting and digests
# ---------------------------------------------------------------------------
def test_source_digest_is_algorithm_prefixed_and_stable():
    """The digest matches the shape V209's source_hash CHECK requires."""
    assert source_digest("hello") == source_digest(b"hello")
    assert source_digest("hello").startswith("sha256:")
    assert len(source_digest("hello")) == len("sha256:") + 64


def test_content_fingerprint_is_deterministic_for_equal_content():
    """Identical analysis content fingerprints identically, so a no-op re-analysis is detectable."""
    assert analysis_content_fingerprint(_available_document()) == analysis_content_fingerprint(
        _available_document()
    )


def test_content_fingerprint_changes_when_the_analysis_changes():
    """Any change to the stored content — including redaction — changes the fingerprint."""
    baseline = analysis_content_fingerprint(_available_document())
    redacted = analysis_content_fingerprint(
        apply_value_visibility(_available_document(), ValueVisibility.NONE)
    )
    assert baseline != redacted


# ---------------------------------------------------------------------------
# Projection
# ---------------------------------------------------------------------------
def test_summary_marks_available_for_available_and_partial_only():
    """``available`` on the summary means "a tree is fetchable", which is true of two statuses."""
    assert summarize_document(_available_document()).available is True

    tree, metrics = bound_tree(_x12_tree(), max_nodes=2)
    partial = PayloadAnalysisDocument(
        status=STATUS_PARTIAL,
        status_reason=REASON_BOUNDS_EXCEEDED,
        source_hash=_HASH,
        tree=tree,
        metrics=metrics,
    )
    assert summarize_document(partial).available is True

    assert summarize_document(unavailable_document()).available is False
    assert summarize_document(unavailable_document(failed=True)).available is False


def test_summary_carries_counts_and_never_payload_values():
    """The summary is counts and status only — it is the half readable without imports:view."""
    summary = summarize_document(
        apply_value_visibility(_available_document(), ValueVisibility.STRUCTURAL),
        analysis_id="an-1",
        version_record_id="ver-1",
        analyzed_at="2026-07-27T00:00:00+00:00",
    )
    assert summary.node_count == 6
    assert summary.kind_counts["element"] == 2
    assert summary.analyzer_key == "edix12"
    assert summary.analysis_id == "an-1"
    assert summary.version_record_id == "ver-1"
    assert "85" not in summary.model_dump_json()


def test_summary_reports_the_reason_for_absence():
    """A user asking why there is no detail gets a code, not a blank."""
    summary = summarize_document(unavailable_document(REASON_NO_SOURCE_CAPTURED))
    assert summary.status == STATUS_UNAVAILABLE
    assert summary.status_reason == REASON_NO_SOURCE_CAPTURED
    assert summary.node_count == 0


# ---------------------------------------------------------------------------
# Row adaptation
# ---------------------------------------------------------------------------
def _row(document: PayloadAnalysisDocument, **overrides) -> dict:
    """A stored-row dict for ``document``, as the data layer returns one."""
    payload = document.model_dump(mode="json", by_alias=False)
    row = {
        "id": "an-1",
        "tenant_id": "tenant-1",
        "project_id": "cat-1",
        "version_id": "ver-1",
        "analysis_sequence": 2,
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


def test_document_round_trips_through_a_stored_row():
    """A stored row rebuilds the document it was written from, field for field."""
    document = apply_value_visibility(_available_document(), ValueVisibility.STRUCTURAL)
    rebuilt = document_from_row(_row(document))
    assert rebuilt.model_dump(mode="json") == document.model_dump(mode="json")


def test_record_from_row_carries_the_citable_identity():
    """A record is citable: id, sequence and fingerprint come back with the document."""
    document = _available_document()
    record = record_from_row(_row(document))
    assert record.analysis_id == "an-1"
    assert record.version_record_id == "ver-1"
    assert record.analysis_sequence == 2
    assert record.content_fingerprint == analysis_content_fingerprint(document)
    assert record.analysis.status == STATUS_AVAILABLE


def test_malformed_jsonb_degrades_instead_of_raising():
    """A record that cannot be fully read still reads — a detail request must not 500."""
    row = _row(_available_document(), tree="not-a-list", metrics=None, warnings=7, redaction=[])
    document = document_from_row(row)
    assert document.tree == []
    assert document.metrics == AnalysisMetrics()
    assert document.warnings == []
    assert document.redaction == RedactionInfo()


def test_summary_from_row_needs_no_tree():
    """The detail read's summary is built without the tree column, whatever its size."""
    document = _available_document()
    row = _row(document)
    row.pop("tree")
    summary = summary_from_row(row)
    assert summary.available is True
    assert summary.node_count == 6
    assert summary.analysis_id == "an-1"
    assert summary.value_visibility == document.redaction.value_visibility


def test_summary_from_row_matches_the_document_projection():
    """Both summary paths agree, so a detail read and a full read never disagree about status."""
    document = apply_value_visibility(_available_document(), ValueVisibility.STRUCTURAL)
    row = _row(document)
    from_row = summary_from_row(row)
    from_document = summarize_document(
        document,
        analysis_id=row["id"],
        version_record_id=row["version_id"],
        analyzed_at=row["created_at"],
    )
    assert from_row.model_dump() == from_document.model_dump()


# ---------------------------------------------------------------------------
# Published JSON Schema
# ---------------------------------------------------------------------------
def test_json_schema_publishes_the_serialized_field_names():
    """The published contract uses the names the API actually emits."""
    schema = document_json_schema()
    assert set(schema["properties"]) >= {
        "schemaVersion",
        "status",
        "statusReason",
        "sourceFormat",
        "sourceHash",
        "analyzer",
        "tree",
        "metrics",
        "warnings",
        "redaction",
    }


def test_json_schema_defines_the_recursive_node_shape():
    """The node definition is present and self-referential, so a consumer can validate a tree."""
    schema = document_json_schema()
    node = schema["$defs"]["AnalysisNode"]
    assert set(node["properties"]) >= {"id", "kind", "children", "valuePresent", "redacted"}


def test_contract_models_reject_unknown_fields():
    """Every contract model forbids extras, so a drifting producer fails loudly."""
    for model in (
        PayloadAnalysisDocument,
        AnalysisNode,
        AnalysisWarning,
        AnalysisMetrics,
        AnalyzerInfo,
        RedactionInfo,
        SourceLocation,
    ):
        assert model.model_config.get("extra") == "forbid"


def test_schema_version_is_stated_on_every_document():
    """A reader can always tell which contract a record was written under."""
    assert _available_document().schema_version == PAYLOAD_ANALYSIS_SCHEMA_VERSION
    assert unavailable_document().schema_version == PAYLOAD_ANALYSIS_SCHEMA_VERSION
