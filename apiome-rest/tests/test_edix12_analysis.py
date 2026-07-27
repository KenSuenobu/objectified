"""Tests for the EDI X12 native-analysis extractor (CPDO-1.2, #4795).

The ticket's problem statement in one sentence: *the X12 canonical normalizer uses only the first
group/transaction, so native observability can be lost*. The first test here is that sentence turned
into an assertion — the normalizer keeps one transaction set, the analysis keeps all of them — and the
rest pin the properties that make the record trustworthy: every envelope survives a bound, composites
are modelled rather than flattened, element values are governed by the redaction policy, and the same
interchange always produces the same record.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, List

import pytest

from app.edix12_analysis import (
    EDIX12_ANALYZER_KEY,
    KIND_COMPONENT,
    KIND_COMPOSITE,
    KIND_ELEMENT,
    KIND_FUNCTIONAL_GROUP,
    KIND_INTERCHANGE,
    KIND_SEGMENT,
    KIND_TRANSACTION_SET,
    WARNING_HL_HIERARCHY_FLATTENED,
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

_EXAMPLES = Path(__file__).resolve().parents[2] / "apiome-ui/examples/edi-x12"
_PO_850 = (_EXAMPLES / "01-850-purchase-order.edi").read_text(encoding="utf-8")
_MULTI_GROUP = (_EXAMPLES / "04-multi-group-po-ack.edi").read_text(encoding="utf-8")
_HIERARCHICAL = (_EXAMPLES / "05-856-asn-hierarchical.edi").read_text(encoding="utf-8")

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
    capabilities = edix12_capabilities()

    assert "x12.functional_group" in capabilities.supported
    assert "x12.composite_elements" in capabilities.supported
    # pyx12 omits empty element positions, so present-and-empty is indistinguishable from absent.
    assert "x12.empty_elements" in capabilities.unsupported
    assert "x12.ta1_acknowledgement" in capabilities.unsupported
    assert "x12.hl_hierarchy" in capabilities.unsupported


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
    assert all(node.redacted is True for node in elements)
    assert stored.contract_violations() == []


def test_envelope_identifiers_stay_in_attributes_and_payload_values_do_not() -> None:
    """Envelope identity labels the tree and is already in the canonical model's extras; element
    values are payload and must stay where the visibility policy can reach them."""
    document = analyze_edix12(parse_edix12(_PO_850))
    stored = apply_value_visibility(document, ValueVisibility.NONE)

    interchange = _of_kind(stored, KIND_INTERCHANGE)[0]
    assert interchange.attributes["senderId"] == "SENDERID"
    for node in _of_kind(stored, KIND_ELEMENT):
        assert node.attributes == {"position": node.attributes["position"]}


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
