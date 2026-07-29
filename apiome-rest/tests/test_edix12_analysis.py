"""Tests for the EDI X12 native-analysis extractor (CPDO-1.2 #4795, CPDO-2.2 #4798).

The CPDO-1.2 problem statement in one sentence: *the X12 canonical normalizer uses only the first
group/transaction, so native observability can be lost*. The first test here is that sentence turned
into an assertion — the normalizer keeps one transaction set, the analysis keeps all of them — and the
rest pin the properties that make the record trustworthy: every envelope survives a bound, composites
are modelled rather than flattened, element values are governed by the redaction policy, and the same
interchange always produces the same record.

CPDO-2.2 adds the second reading of the same bytes, and the section at the bottom of this file is
its acceptance criteria turned into assertions: a segment carries the exact source range it was read
from, an element position written and left empty is not an absent one, a repeated segment is not the
segment before it, an interchange that converts from a subset of itself says so, and every one of
those new facts is still governed by the value-visibility policy rather than around it.
"""

from __future__ import annotations

from typing import Any, List

import pytest
from corpus_loader import unique_corpus_entry

from app.edix12_analysis import (
    EDIX12_ANALYZER_KEY,
    KIND_COMPONENT,
    KIND_COMPOSITE,
    KIND_ELEMENT,
    KIND_FUNCTIONAL_GROUP,
    KIND_INTERCHANGE,
    KIND_REPETITION,
    KIND_SEGMENT,
    KIND_TRANSACTION_SET,
    WARNING_CANONICAL_SUBSET,
    WARNING_HL_HIERARCHY_FLATTENED,
    WARNING_SCAN_UNALIGNED,
    WARNING_TRAILERS_DROPPED,
    analyze_edix12,
    edix12_capabilities,
)
from app.edix12_import_source import EdiX12ImportSource
from app.edix12_normalizer import EdiX12Normalizer
from app.edix12_parser import parse_edix12
from app.payload_analysis import (
    REASON_BOUNDS_EXCEEDED,
    SEVERITY_INFO,
    STATUS_AVAILABLE,
    STATUS_PARTIAL,
    ValueVisibility,
    analysis_content_fingerprint,
    apply_value_visibility,
    source_digest,
)

# Fixtures come from the manifest-tracked corpus, selected by tag (CPDO-4.1): a fixture that
# leaves the manifest, or stops carrying the construct a test pins, fails loudly here instead of
# silently reading a stale file.
_PO_850 = unique_corpus_entry(
    format="edix12", features=("850-purchase-order", "iea-trailer")
).read_text()
_MULTI_GROUP = unique_corpus_entry(
    format="edix12", features=("multi-functional-group",)
).read_text()
_HIERARCHICAL = unique_corpus_entry(format="edix12", features=("hl-loops",)).read_text()

#: A hand-built interchange whose CLM05 is a composite (``11>B>1`` under the ``>`` sub-element
#: separator declared in ISA16). None of the shipped examples carry one.
_COMPOSITE = (
    "ISA*00*          *00*          *ZZ*SENDERID       *ZZ*RECEIVERID     "
    "*260115*0830*U*00401*000000001*0*P*>~"
    "GS*HC*SENDERID*RECEIVERID*20260115*0830*1*X*004010~"
    "ST*837*0001~"
    "CLM*CLAIM-1*500***11>B>1~"
    "SE*3*0001~"
    "GE*1*1~"
    "IEA*1*000000001~"
)


def _walk(nodes) -> List[Any]:
    """Yield every node in a stored tree, depth-first."""
    out: List[Any] = []
    stack = list(reversed(list(nodes)))
    while stack:
        node = stack.pop()
        out.append(node)
        stack.extend(reversed(node.children))
    return out


def _of_kind(document, kind: str) -> List[Any]:
    return [node for node in _walk(document.tree) if node.kind == kind]


@pytest.fixture()
def multi_group():
    return analyze_edix12(parse_edix12(_MULTI_GROUP))


# ---------------------------------------------------------------------------
# The acceptance criterion: all groups and transaction sets are retained
# ---------------------------------------------------------------------------


def test_the_analysis_keeps_the_groups_the_canonical_model_drops() -> None:
    """The 04 fixture carries an 850 in a ``PO`` group and a 997 in an ``FA`` group. The canonical
    model describes the first; the analysis describes both, which is the whole point of storing it."""
    parsed = parse_edix12(_MULTI_GROUP)

    canonical = EdiX12Normalizer().normalize(parsed)
    assert canonical.extras["x12_set_id"] == "850"
    assert "997" not in {
        transaction["set_id"] for transaction in canonical.extras["x12_transactions"]
    }

    document = analyze_edix12(parsed)
    assert [node.name for node in _of_kind(document, KIND_FUNCTIONAL_GROUP)] == ["PO", "FA"]
    assert [node.name for node in _of_kind(document, KIND_TRANSACTION_SET)] == ["850", "997"]


def test_every_transaction_set_keeps_its_own_control_number_and_segment_count(
    multi_group,
) -> None:
    transactions = _of_kind(multi_group, KIND_TRANSACTION_SET)

    assert [node.attributes["controlNumber"] for node in transactions] == ["0001", "0002"]
    assert [node.attributes["segmentCount"] for node in transactions] == [3, 2]


def test_the_envelope_survives_a_budget_too_small_to_hold_it(multi_group) -> None:
    """A bounded X12 analysis drops elements, never envelopes: the node budget is raised to fit
    every interchange/group/transaction-set node before anything else is admitted."""
    document = analyze_edix12(parse_edix12(_MULTI_GROUP), max_nodes=2)

    assert document.status == STATUS_PARTIAL
    assert document.status_reason == REASON_BOUNDS_EXCEEDED
    assert len(_of_kind(document, KIND_INTERCHANGE)) == 1
    assert len(_of_kind(document, KIND_FUNCTIONAL_GROUP)) == 2
    assert len(_of_kind(document, KIND_TRANSACTION_SET)) == 2
    # Everything below the envelope is what the budget refused.
    assert _of_kind(document, KIND_SEGMENT) == []
    assert document.metrics.dropped_node_count > 0
    # The record states the budget it actually ran under, not the default it was asked for.
    assert document.capabilities.limits["maxNodes"] == 5


# ---------------------------------------------------------------------------
# What the tree says
# ---------------------------------------------------------------------------


def test_the_interchange_records_its_delimiters_and_control_numbers() -> None:
    document = analyze_edix12(parse_edix12(_PO_850))
    interchange = _of_kind(document, KIND_INTERCHANGE)[0]

    assert interchange.attributes["elementSeparator"] == "*"
    assert interchange.attributes["segmentTerminator"] == "~"
    assert interchange.attributes["controlNumber"] == "000000001"
    assert interchange.attributes["functionalGroupCount"] == 1


def test_segments_keep_their_position_within_the_transaction_set() -> None:
    document = analyze_edix12(parse_edix12(_PO_850))
    segments = _of_kind(document, KIND_SEGMENT)

    assert [node.name for node in segments] == [
        "BEG",
        "REF",
        "PER",
        "N1",
        "PO1",
        "PO1",
        "CTT",
    ]
    assert [node.ordinal for node in segments] == list(range(7))
    # The repeated PO1s are distinguishable by their ordinal, which the canonical model collapses.
    assert segments[4].location.path.endswith("PO1[4]")
    assert segments[5].location.path.endswith("PO1[5]")


def test_elements_record_presence_and_length() -> None:
    document = analyze_edix12(parse_edix12(_PO_850))
    element = _of_kind(document, KIND_ELEMENT)[0]

    assert element.name == "BEG01"
    assert element.attributes["position"] == "01"
    assert element.value_present is True
    assert element.value_length == len(element.value)


def test_composite_elements_are_regrouped_with_their_components() -> None:
    """``pyx12`` reports a composite's components as siblings sharing one element position; the
    analysis says what the source said."""
    document = analyze_edix12(parse_edix12(_COMPOSITE))

    composites = _of_kind(document, KIND_COMPOSITE)
    assert [node.name for node in composites] == ["CLM05"]
    assert composites[0].attributes["componentCount"] == 3
    components = _of_kind(document, KIND_COMPONENT)
    assert [node.name for node in components] == ["CLM05-1", "CLM05-2", "CLM05-3"]
    assert [node.value for node in components] == ["11", "B", "1"]


def test_hl_segments_are_reported_as_flattened_without_hiding_them() -> None:
    """Every HL segment is in the tree; what is missing is the hierarchy they encode, and saying so
    is the difference between "no hierarchy here" and "this analyzer does not build one"."""
    document = analyze_edix12(parse_edix12(_HIERARCHICAL))

    hl_segments = [node for node in _of_kind(document, KIND_SEGMENT) if node.name == "HL"]
    assert len(hl_segments) >= 3

    warnings = [w for w in document.warnings if w.code == WARNING_HL_HIERARCHY_FLATTENED]
    assert len(warnings) == 1
    assert warnings[0].severity == SEVERITY_INFO
    # Nothing observed was dropped, so the record is complete about what it describes.
    assert document.status == STATUS_AVAILABLE


def test_capabilities_name_the_constructs_the_parser_cannot_show() -> None:
    capabilities = edix12_capabilities(source_positions=True)

    assert "x12.functional_group" in capabilities.supported
    assert "x12.composite_elements" in capabilities.supported
    # Boundaries of the analyzer itself, true of every X12 record it will ever write.
    assert "x12.ta1_acknowledgement" in capabilities.unsupported
    assert "x12.hl_hierarchy" in capabilities.unsupported
    assert "x12.implementation_guide_validation" in capabilities.unsupported


def test_capabilities_narrow_when_the_record_has_no_source_positions() -> None:
    """The three constructs that are only readable from an aligned interchange text are declared
    per record, so a record whose scan failed says they are absent from *it* rather than implying
    the analyzer cannot do them at all."""
    with_scan = edix12_capabilities(source_positions=True)
    without_scan = edix12_capabilities(source_positions=False)

    for construct in (
        "x12.byte_offsets",
        "x12.empty_elements",
        "x12.repeating_elements",
        "x12.envelope_control_totals",
    ):
        assert construct in with_scan.supported, construct
        assert construct in without_scan.unsupported, construct

    # Neither declaration may ever claim a construct twice.
    for capabilities in (with_scan, without_scan):
        assert not set(capabilities.supported) & set(capabilities.unsupported)


# ---------------------------------------------------------------------------
# Redaction and determinism
# ---------------------------------------------------------------------------


def test_element_values_are_withheld_by_the_default_policy() -> None:
    document = analyze_edix12(parse_edix12(_PO_850))
    assert any(node.value for node in _of_kind(document, KIND_ELEMENT))

    stored = apply_value_visibility(document, ValueVisibility.DEFAULT)
    elements = _of_kind(stored, KIND_ELEMENT)

    assert all(node.value is None for node in elements)
    assert all(node.value_present is True for node in elements)
    # Every element that *carried* something has it withheld. An element observed present-and-empty
    # (CPDO-2.2) is not marked redacted, because there was nothing in it to withhold — and calling
    # it redacted would make it indistinguishable from an element whose real value was suppressed.
    assert all(node.redacted is True for node in elements if node.value_length)
    assert all(node.redacted is False for node in elements if not node.value_length)
    assert any(node.value_length == 0 for node in elements)
    assert stored.contract_violations() == []


def test_envelope_identifiers_stay_in_attributes_and_payload_values_do_not() -> None:
    """Envelope identity labels the tree and is already in the canonical model's extras; element
    values are payload and must stay where the visibility policy can reach them."""
    document = analyze_edix12(parse_edix12(_PO_850))
    stored = apply_value_visibility(document, ValueVisibility.NONE)

    interchange = _of_kind(stored, KIND_INTERCHANGE)[0]
    assert interchange.attributes["senderId"] == "SENDERID"
    for node in _of_kind(stored, KIND_ELEMENT):
        # Position and reference designator are structure — where in the segment the element sat and
        # what X12 calls it. Nothing observed rides along with them.
        assert set(node.attributes) <= {"position", "reference", "repeatCount"}


def test_the_same_interchange_always_produces_the_same_record() -> None:
    a = analyze_edix12(parse_edix12(_PO_850))
    b = analyze_edix12(parse_edix12(_PO_850))

    assert analysis_content_fingerprint(a) == analysis_content_fingerprint(b)


def test_the_record_names_the_bytes_it_analysed() -> None:
    document = analyze_edix12(parse_edix12(_PO_850))

    assert document.source_hash == source_digest(_PO_850)
    assert document.source_format == EDIX12_ANALYZER_KEY


def test_the_record_names_the_parser_release_that_read_the_interchange() -> None:
    document = analyze_edix12(parse_edix12(_PO_850))

    assert "pyx12" in document.analyzer.tool_versions
    assert document.analyzer.tool_versions["pyx12"]


# ---------------------------------------------------------------------------
# Through the adapter SPI
# ---------------------------------------------------------------------------


def test_the_adapter_routes_analysis_to_the_native_extractor() -> None:
    adapter = EdiX12ImportSource()
    document = adapter.analyze(adapter.parse(_MULTI_GROUP), source=_MULTI_GROUP)

    assert document.analyzer.key == EDIX12_ANALYZER_KEY
    assert adapter.analyzer_key == EDIX12_ANALYZER_KEY
    assert len(_of_kind(document, KIND_TRANSACTION_SET)) == 2


def test_the_adapter_rejects_an_ast_that_is_not_an_interchange() -> None:
    from app.import_source import ImportSourceError

    adapter = EdiX12ImportSource()
    with pytest.raises(ImportSourceError):
        adapter.analyze({"not": "an interchange"}, source="x")


# ===========================================================================
# CPDO-2.2 (#4798) — the interchange and transaction-set inspector
# ===========================================================================


#: A ``00501`` interchange carrying everything the inspector has to tell apart: an element written
#: and left empty (``CLM03``/``CLM04``), a composite (``CLM05``), a repeated element (``REF02``
#: under the ``^`` separator ``ISA11`` declares at this version), a segment that repeats (``NM1``),
#: an ``ST03`` implementation-convention claim, and control totals that agree with the body.
_FIVE_010 = (
    "ISA*00*          *00*          *ZZ*SENDERID       *ZZ*RECEIVERID     "
    "*260115*0830*^*00501*000000001*0*T*>~"
    "GS*HC*SENDERID*RECEIVERID*20260115*0830*1*X*005010X222A1~"
    "ST*837*0001*005010X222A1~"
    "CLM*CLAIM-1*500***11>B>1~"
    "REF*D9*A^B^C~"
    "NM1*IL*1*DOE*JOHN~"
    "NM1*82*1*ROE*JANE~"
    "SE*6*0001~"
    "GE*1*1~"
    "IEA*1*000000001~"
)


def _named(document, kind: str, name: str) -> List[Any]:
    return [node for node in _of_kind(document, kind) if node.name == name]


# ---------------------------------------------------------------------------
# AC: segment selection highlights a raw source range when available
# ---------------------------------------------------------------------------


def test_every_construct_carries_the_exact_source_range_it_was_read_from() -> None:
    """The range is what a UI highlights, so it is asserted against the bytes rather than against a
    remembered number: slicing the source at each location must reproduce that construct's text."""
    document = analyze_edix12(parse_edix12(_PO_850), source=_PO_850)

    located = [
        node
        for kind in (KIND_INTERCHANGE, KIND_FUNCTIONAL_GROUP, KIND_TRANSACTION_SET, KIND_SEGMENT)
        for node in _of_kind(document, kind)
    ]
    assert located

    for node in located:
        location = node.location
        assert location is not None
        assert location.offset is not None and location.length is not None
        text = _PO_850[location.offset : location.offset + location.length]
        expected = "ISA" if node.kind == KIND_INTERCHANGE else (
            "GS" if node.kind == KIND_FUNCTIONAL_GROUP else (
                "ST" if node.kind == KIND_TRANSACTION_SET else node.name
            )
        )
        assert text.startswith(expected), (node.kind, node.name, text[:12])
        # The envelope path survives alongside the range — the range is an addition, not a swap.
        assert location.path


def test_segments_report_the_line_they_start_on() -> None:
    """The shipped examples put one segment per line, so a copybook-style line jump works for them
    too. A single-line interchange reports line 1 for everything, which is the truth about it."""
    document = analyze_edix12(parse_edix12(_PO_850), source=_PO_850)
    segments = _of_kind(document, KIND_SEGMENT)

    # ISA, GS, ST occupy lines 1-3; the body follows.
    assert [node.location.line for node in segments] == [4, 5, 6, 7, 8, 9, 10]
    assert all(node.location.column == 1 for node in segments)


@pytest.mark.parametrize(
    "source",
    [
        # No readable ISA header, so no delimiter can be trusted and nothing is guessed.
        "ISA*not*really*an*interchange~",
        # A readable header whose body is not the body that was parsed: the walk runs out of
        # segments to match and the whole scan is abandoned rather than half-applied.
        _MULTI_GROUP.split("\n")[0] + "\nZZ*1~\nZZ*2~\n",
    ],
    ids=["unreadable-header", "body-disagrees-with-the-parse"],
)
def test_a_source_that_cannot_be_aligned_falls_back_to_paths_and_says_so(source: str) -> None:
    """Half-aligned positions would put a reader in front of the wrong bytes. The scan is abandoned
    whole, the tree is unchanged, and both the warning and the record's capabilities state it."""
    document = analyze_edix12(parse_edix12(_PO_850), source=source)

    assert document.status == STATUS_AVAILABLE
    assert [node.name for node in _of_kind(document, KIND_TRANSACTION_SET)] == ["850"]
    for node in _of_kind(document, KIND_SEGMENT):
        assert node.location.offset is None
        assert node.location.path
    # The elements fall back to the parser's reading, which cannot see an empty position at all.
    assert "BEG04" not in {node.name for node in _of_kind(document, KIND_ELEMENT)}
    assert any(w.code == WARNING_SCAN_UNALIGNED for w in document.warnings)
    for construct in ("x12.byte_offsets", "x12.empty_elements", "x12.repeating_elements"):
        assert construct in document.capabilities.unsupported, construct


# ---------------------------------------------------------------------------
# AC: repeated segments and empty elements are distinguishable
# ---------------------------------------------------------------------------


def test_an_element_written_and_left_empty_is_not_an_absent_one() -> None:
    """``BEG*00*SA*PO-0001**20260115`` writes five positions and leaves the fourth empty. ``pyx12``
    reports four. The record reports five, and the empty one says it was present."""
    document = analyze_edix12(parse_edix12(_PO_850), source=_PO_850)
    elements = {node.name: node for node in _of_kind(document, KIND_ELEMENT)}

    assert [name for name in elements if name.startswith("BEG")] == [
        "BEG01",
        "BEG02",
        "BEG03",
        "BEG04",
        "BEG05",
    ]
    empty = elements["BEG04"]
    assert empty.value_present is True
    assert empty.value_length == 0
    # A position the source never wrote is simply not a node — never a node claiming absence.
    assert "BEG06" not in elements


def test_the_segment_records_both_counts_it_knows() -> None:
    """``elementCount`` is what the parser reported and ``elementPositionCount`` is what the source
    wrote. On a segment with an empty position they differ, and neither is presented as the other."""
    document = analyze_edix12(parse_edix12(_PO_850), source=_PO_850)
    beg = _named(document, KIND_SEGMENT, "BEG")[0]

    assert beg.attributes["elementCount"] == 4
    assert beg.attributes["elementPositionCount"] == 5


def test_repeated_segments_name_which_repeat_they_are() -> None:
    """Four ``HL`` rows that read identically are four rows a reader cannot act on. Each states its
    occurrence within its transaction set — never within the file, which is not how they are read."""
    document = analyze_edix12(parse_edix12(_HIERARCHICAL), source=_HIERARCHICAL)
    hl_segments = _named(document, KIND_SEGMENT, "HL")

    first_set = [node for node in hl_segments if "/ST[0]/" in node.location.path]
    second_set = [node for node in hl_segments if "/ST[1]/" in node.location.path]

    assert [node.attributes["repeatIndex"] for node in first_set] == [0, 1, 2, 3]
    assert all(node.attributes["repeatCount"] == 4 for node in first_set)
    assert [node.label for node in first_set] == [
        "HL (1 of 4)",
        "HL (2 of 4)",
        "HL (3 of 4)",
        "HL (4 of 4)",
    ]
    # The second transaction set restarts its own numbering.
    assert [node.attributes["repeatIndex"] for node in second_set] == [0, 1, 2]
    assert all(node.attributes["repeatCount"] == 3 for node in second_set)


def test_a_segment_that_occurs_once_is_not_labelled_as_a_repeat() -> None:
    document = analyze_edix12(parse_edix12(_PO_850), source=_PO_850)
    ctt = _named(document, KIND_SEGMENT, "CTT")[0]

    assert ctt.attributes["repeatCount"] == 1
    assert ctt.label is None


def test_a_repeated_element_carries_its_occurrences_rather_than_one_run_on_value() -> None:
    document = analyze_edix12(parse_edix12(_FIVE_010), source=_FIVE_010)
    ref02 = _named(document, KIND_ELEMENT, "REF02")[0]

    assert ref02.attributes["repeatCount"] == 3
    assert ref02.value is None
    assert [child.value for child in ref02.children] == ["A", "B", "C"]
    assert [child.attributes["repeatIndex"] for child in ref02.children] == [0, 1, 2]
    assert all(child.kind == KIND_REPETITION for child in ref02.children)


def test_a_repetition_separator_is_only_honoured_where_the_version_declares_one() -> None:
    """The same caret at ``00401`` is data. Splitting on it would invent occurrences the source
    never wrote — the exact failure mode this analyzer refuses everywhere else."""
    four_010 = _FIVE_010.replace("*0830*^*00501*", "*0830*U*00401*", 1)
    document = analyze_edix12(parse_edix12(four_010), source=four_010)
    ref02 = _named(document, KIND_ELEMENT, "REF02")[0]

    assert "repeatCount" not in ref02.attributes
    assert ref02.value == "A^B^C"
    assert _of_kind(document, KIND_REPETITION) == []

    interchange = _of_kind(document, KIND_INTERCHANGE)[0]
    assert interchange.attributes["repetitionSeparatorDeclared"] is False
    assert "repetitionSeparator" not in interchange.attributes


# ---------------------------------------------------------------------------
# AC: envelope controls, separators, transaction-set ids and versions
# ---------------------------------------------------------------------------


def test_the_interchange_records_every_separator_it_declared() -> None:
    document = analyze_edix12(parse_edix12(_FIVE_010), source=_FIVE_010)
    interchange = _of_kind(document, KIND_INTERCHANGE)[0]

    assert interchange.attributes["elementSeparator"] == "*"
    assert interchange.attributes["componentSeparator"] == ">"
    assert interchange.attributes["repetitionSeparator"] == "^"
    assert interchange.attributes["segmentTerminator"] == "~"
    assert interchange.attributes["repetitionSeparatorDeclared"] is True


def test_the_usage_indicator_is_recorded_with_the_word_it_means() -> None:
    """``T`` is the difference between a customer's real claims and a test file, and no reader
    should have to look the code up to find out which they are looking at."""
    document = analyze_edix12(parse_edix12(_FIVE_010), source=_FIVE_010)
    interchange = _of_kind(document, KIND_INTERCHANGE)[0]

    assert interchange.attributes["usageIndicator"] == "T"
    assert interchange.attributes["usageIndicatorLabel"] == "Test"

    production = analyze_edix12(parse_edix12(_PO_850), source=_PO_850)
    assert _of_kind(production, KIND_INTERCHANGE)[0].attributes["usageIndicatorLabel"] == "Production"


def test_an_unrecognised_usage_indicator_is_not_guessed_at() -> None:
    source = _FIVE_010.replace("*0*T*>~", "*0*Q*>~", 1)
    document = analyze_edix12(parse_edix12(source), source=source)
    interchange = _of_kind(document, KIND_INTERCHANGE)[0]

    assert interchange.attributes["usageIndicator"] == "Q"
    assert interchange.attributes["usageIndicatorLabel"] == "Unrecognised code"


def test_declared_control_totals_sit_beside_the_counts_actually_observed() -> None:
    """The trailers are not tree nodes, but what they declare is evidence — and an interchange that
    disagrees with itself can only be seen to when both numbers are on the record."""
    document = analyze_edix12(parse_edix12(_FIVE_010), source=_FIVE_010)

    interchange = _of_kind(document, KIND_INTERCHANGE)[0]
    assert interchange.attributes["functionalGroupCount"] == 1
    assert interchange.attributes["declaredFunctionalGroupCount"] == 1

    group = _of_kind(document, KIND_FUNCTIONAL_GROUP)[0]
    assert group.attributes["transactionSetCount"] == 1
    assert group.attributes["declaredTransactionSetCount"] == 1

    transaction = _of_kind(document, KIND_TRANSACTION_SET)[0]
    # ``SE01`` counts ST through SE inclusive, so the comparable figure includes both envelopes.
    assert transaction.attributes["declaredSegmentCount"] == 6
    assert transaction.attributes["envelopeSegmentCount"] == 6


def test_a_control_total_that_disagrees_is_recorded_rather_than_reconciled() -> None:
    """Nothing here corrects the interchange or fails the record: the two numbers are both stated,
    and a record stays ``available`` because the analysis is complete — the *source* is what is odd."""
    source = _FIVE_010.replace("SE*6*0001~", "SE*9*0001~", 1)
    document = analyze_edix12(parse_edix12(source), source=source)
    transaction = _of_kind(document, KIND_TRANSACTION_SET)[0]

    assert transaction.attributes["declaredSegmentCount"] == 9
    assert transaction.attributes["envelopeSegmentCount"] == 6
    assert document.status == STATUS_AVAILABLE


def test_an_unreadable_control_total_is_omitted_rather_than_read_as_zero() -> None:
    source = _FIVE_010.replace("GE*1*1~", "GE**1~", 1)
    document = analyze_edix12(parse_edix12(source), source=source)
    group = _of_kind(document, KIND_FUNCTIONAL_GROUP)[0]

    assert "declaredTransactionSetCount" not in group.attributes


def test_the_transaction_set_records_its_id_version_and_convention_claim() -> None:
    document = analyze_edix12(parse_edix12(_FIVE_010), source=_FIVE_010)
    transaction = _of_kind(document, KIND_TRANSACTION_SET)[0]
    group = _of_kind(document, KIND_FUNCTIONAL_GROUP)[0]

    assert transaction.attributes["setId"] == "837"
    assert transaction.attributes["implementationConventionReference"] == "005010X222A1"
    assert group.attributes["version"] == "005010X222A1"
    assert group.attributes["responsibleAgencyCode"] == "X"
    # The claim is recorded; nothing validates the interchange against that guide.
    assert "x12.implementation_guide_validation" in document.capabilities.unsupported


def test_a_transaction_set_without_st03_records_no_convention() -> None:
    document = analyze_edix12(parse_edix12(_PO_850), source=_PO_850)
    transaction = _of_kind(document, KIND_TRANSACTION_SET)[0]

    assert "implementationConventionReference" not in transaction.attributes


# ---------------------------------------------------------------------------
# AC: the canonical conversion reads a subset, and the record says which
# ---------------------------------------------------------------------------


def test_an_interchange_that_converts_from_a_subset_of_itself_says_so() -> None:
    document = analyze_edix12(parse_edix12(_MULTI_GROUP), source=_MULTI_GROUP)

    subset = [w for w in document.warnings if w.code == WARNING_CANONICAL_SUBSET]
    assert len(subset) == 1
    assert subset[0].severity == SEVERITY_INFO
    # It names the set the conversion came from and how many it did not.
    assert "850 (0001)" in subset[0].message
    assert "2 transaction set(s)" in subset[0].message
    # Informational: every set is in the tree, so nothing about the analysis is partial.
    assert document.status == STATUS_AVAILABLE


def test_a_single_transaction_interchange_makes_no_subset_claim() -> None:
    document = analyze_edix12(parse_edix12(_PO_850), source=_PO_850)

    assert not [w for w in document.warnings if w.code == WARNING_CANONICAL_SUBSET]


def test_two_transaction_sets_in_one_group_also_count_as_a_subset() -> None:
    """The 856 fixture has one functional group and two transaction sets in it. Counting groups
    alone would call that a complete conversion, which it is not."""
    document = analyze_edix12(parse_edix12(_HIERARCHICAL), source=_HIERARCHICAL)

    subset = [w for w in document.warnings if w.code == WARNING_CANONICAL_SUBSET]
    assert len(subset) == 1
    assert "1 functional group(s)" in subset[0].message


def test_a_ta1_acknowledgement_the_parser_drops_is_named_rather_than_vanishing() -> None:
    document = analyze_edix12(parse_edix12(_HIERARCHICAL), source=_HIERARCHICAL)

    dropped = [w for w in document.warnings if w.code == WARNING_TRAILERS_DROPPED]
    assert len(dropped) == 1
    assert dropped[0].severity == SEVERITY_INFO
    assert "TA1" in dropped[0].message
    assert "not in this tree" in dropped[0].message


def test_ordinary_envelope_trailers_do_not_warn() -> None:
    """``SE``/``GE``/``IEA`` are removed from the AST too, but their control totals are recovered —
    so warning about them on every interchange would be noise that means nothing."""
    document = analyze_edix12(parse_edix12(_PO_850), source=_PO_850)

    assert not [w for w in document.warnings if w.code == WARNING_TRAILERS_DROPPED]


# ---------------------------------------------------------------------------
# AC: redaction prevents exposed business values, by policy
# ---------------------------------------------------------------------------


def test_no_construct_carries_an_observed_value_outside_the_value_field() -> None:
    """The visibility policy governs ``value`` and nothing else, so an attribute holding a payload
    value would be a value the policy cannot reach. Asserted over every node of a record that
    carries names, an account reference and a claim amount."""
    source = _FIVE_010
    document = analyze_edix12(parse_edix12(source), source=source)
    stored = apply_value_visibility(document, ValueVisibility.NONE)

    observed = {"CLAIM-1", "DOE", "JANE", "JOHN", "ROE", "A^B^C"}

    def walk(nodes):
        for node in nodes:
            yield node
            yield from walk(node.children)

    for node in walk(stored.tree):
        for name, value in node.attributes.items():
            assert str(value) not in observed, (node.kind, node.name, name)
        assert node.value is None


def test_repetitions_and_components_are_redacted_like_any_other_value() -> None:
    """The two node kinds CPDO-2.2 added carry observed payload, so they must be governed by the
    same policy — a new kind that quietly escaped redaction would be a disclosure surface."""
    document = analyze_edix12(parse_edix12(_FIVE_010), source=_FIVE_010)
    stored = apply_value_visibility(document, ValueVisibility.DEFAULT)

    repetitions = _of_kind(stored, KIND_REPETITION)
    components = _of_kind(stored, KIND_COMPONENT)
    assert repetitions and components

    for node in repetitions + components:
        assert node.value is None
        assert node.redacted is True
        assert node.value_length is not None
    assert stored.contract_violations() == []


def test_the_record_is_deterministic_with_the_scan_in_play() -> None:
    """Source ranges, repeat counts and control totals are all derived, so re-analysing the same
    bytes must still fingerprint identically — otherwise every sweep would append a redundant
    sequence to every X12 revision."""
    a = analyze_edix12(parse_edix12(_FIVE_010), source=_FIVE_010)
    b = analyze_edix12(parse_edix12(_FIVE_010), source=_FIVE_010)

    assert analysis_content_fingerprint(a) == analysis_content_fingerprint(b)


def test_a_bounded_record_still_keeps_every_envelope_with_the_scan_in_play() -> None:
    """CPDO-1.2's guarantee, re-asserted now that envelopes carry more attributes: bounding drops
    elements, never groups or transaction sets."""
    document = analyze_edix12(parse_edix12(_HIERARCHICAL), source=_HIERARCHICAL, max_nodes=2)

    assert document.status == STATUS_PARTIAL
    assert document.status_reason == REASON_BOUNDS_EXCEEDED
    assert len(_of_kind(document, KIND_TRANSACTION_SET)) == 2
    assert _of_kind(document, KIND_ELEMENT) == []
