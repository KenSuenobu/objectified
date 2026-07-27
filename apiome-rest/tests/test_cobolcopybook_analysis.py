"""Tests for the COBOL copybook native-analysis extractor (CPDO-1.2, #4795).

A copybook normalizes into records and fields with types — which is what a canonical model can hold,
and roughly half of what the copybook said. These tests pin the other half surviving the import:
level numbers, PICTURE and USAGE clauses, OCCURS bounds, 88-level condition names, and the source
line each was declared on.

They also pin the honesty rule the ticket asks for. The parser behind this extractor does not read
``REDEFINES`` or ``COPY … REPLACING``; a copybook that uses them is analysed as far as the parser
understands it, and the record says so with a warning and a ``partial`` status rather than presenting
a partial tree as a complete one.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, List

import pytest

from app.cobolcopybook_analysis import (
    COBOL_ANALYZER_KEY,
    KIND_CONDITION,
    KIND_FIELD,
    KIND_GROUP,
    KIND_RECORD,
    analyze_cobolcopybook,
    cobolcopybook_capabilities,
)
from app.cobolcopybook_import_source import CobolCopybookImportSource
from app.cobolcopybook_parser import iter_definition_lines, parse_cobolcopybook
from app.import_source import ImportSourceError
from app.payload_analysis import (
    REASON_UNSUPPORTED_FORMAT,
    SEVERITY_WARNING,
    STATUS_AVAILABLE,
    STATUS_PARTIAL,
    ValueVisibility,
    analysis_content_fingerprint,
    apply_value_visibility,
    source_digest,
)

_EXAMPLES = Path(__file__).resolve().parents[2] / "apiome-ui/examples/cobol-copybook"
_CUSTOMER = (_EXAMPLES / "01-customer-record.cpy").read_text(encoding="utf-8")
_REDEFINES = (_EXAMPLES / "03-payment-redefines.cpy").read_text(encoding="utf-8")
_WAREHOUSE = (_EXAMPLES / "04-warehouse-stress.cpy").read_text(encoding="utf-8")


def _walk(nodes) -> List[Any]:
    """Yield every node in a stored tree, depth-first."""
    out: List[Any] = []
    stack = list(reversed(list(nodes)))
    while stack:
        node = stack.pop()
        out.append(node)
        stack.extend(reversed(node.children))
    return out


def _by_name(document, name: str):
    for node in _walk(document.tree):
        if node.name == name:
            return node
    raise AssertionError(f"no node named {name!r} in the analysis")


@pytest.fixture()
def customer():
    return analyze_cobolcopybook(parse_cobolcopybook(_CUSTOMER))


# ---------------------------------------------------------------------------
# What the tree says
# ---------------------------------------------------------------------------


def test_the_level_01_item_is_the_record_and_groups_are_distinguished(customer) -> None:
    assert customer.tree[0].kind == KIND_RECORD
    assert customer.tree[0].name == "CUSTOMER-RECORD"
    assert _by_name(customer, "CUST-NAME").kind == KIND_GROUP
    assert _by_name(customer, "CUST-FIRST-NAME").kind == KIND_FIELD


def test_picture_and_usage_clauses_survive_the_import(customer) -> None:
    balance = _by_name(customer, "CUST-BALANCE")

    assert balance.attributes["level"] == 5
    assert balance.attributes["picture"] == "S9(9)V99"
    assert balance.attributes["usage"] == "COMP-3"


def test_a_field_without_a_clause_omits_it_rather_than_recording_a_null(customer) -> None:
    """An attribute bag that always carried ``"usage": null`` could not be told apart from one where
    the analyzer failed to read the clause. A key that is present was observed."""
    assert "usage" not in _by_name(customer, "CUST-ID").attributes
    assert "picture" not in _by_name(customer, "CUST-NAME").attributes


def test_occurs_bounds_and_their_control_field_are_recorded() -> None:
    document = analyze_cobolcopybook(parse_cobolcopybook(_WAREHOUSE))
    bins = _by_name(document, "WH-BINS")

    assert bins.attributes["occursMin"] >= 1
    assert bins.attributes["occursMax"] >= bins.attributes["occursMin"]
    assert bins.attributes["dependingOn"]


def test_condition_names_are_recorded_under_the_field_they_qualify(customer) -> None:
    status = _by_name(customer, "CUST-STATUS")
    conditions = [child for child in status.children if child.kind == KIND_CONDITION]

    assert [node.name for node in conditions] == [
        "CUST-ACTIVE",
        "CUST-SUSPENDED",
        "CUST-CLOSED",
    ]
    assert conditions[0].attributes == {"level": 88, "conditionValue": "A"}


def test_paths_read_as_the_copybook_reads(customer) -> None:
    assert _by_name(customer, "CUST-FIRST-NAME").location.path == (
        "CUSTOMER-RECORD/CUST-NAME/CUST-FIRST-NAME"
    )


# ---------------------------------------------------------------------------
# Source lines
# ---------------------------------------------------------------------------


def test_source_lines_are_recovered_for_fields_and_conditions(customer) -> None:
    """The parsed tree carries no positions; the lines are recovered from the source so a reader can
    be pointed at the clause itself."""
    assert _by_name(customer, "CUSTOMER-RECORD").location.line == 13
    assert _by_name(customer, "CUST-ID").location.line == 14
    assert _by_name(customer, "CUST-ACTIVE").location.line == 19


def test_a_repeated_name_resolves_to_its_own_declaration() -> None:
    """``FILLER`` appears in two different groups; each must get its own line, not the first one."""
    document = analyze_cobolcopybook(parse_cobolcopybook(_REDEFINES))
    fillers = [node for node in _walk(document.tree) if node.name == "FILLER"]

    assert [node.location.line for node in fillers] == [17, 21]


def test_definition_lines_skip_comments_and_blank_lines() -> None:
    entries = iter_definition_lines(_CUSTOMER)

    assert entries[0].line == 13
    assert entries[0].level == 1
    assert entries[0].name == "CUSTOMER-RECORD"
    assert any(entry.is_condition and entry.name == "CUST-ACTIVE" for entry in entries)


# ---------------------------------------------------------------------------
# Honesty about what is not modelled
# ---------------------------------------------------------------------------


def test_redefines_makes_the_record_partial_with_a_stated_reason() -> None:
    document = analyze_cobolcopybook(parse_cobolcopybook(_REDEFINES))

    assert document.status == STATUS_PARTIAL
    assert document.status_reason == REASON_UNSUPPORTED_FORMAT
    warnings = [w for w in document.warnings if w.code == "copybook.redefines"]
    assert len(warnings) == 1
    assert warnings[0].severity == SEVERITY_WARNING
    assert "3 occurrence(s)" in warnings[0].message
    # The tree is still real — the redefining items are described, just not as overlays.
    assert _by_name(document, "CARD-DETAIL").kind == KIND_GROUP


def test_a_copybook_using_no_unmodelled_clause_is_available(customer) -> None:
    assert customer.status == STATUS_AVAILABLE
    assert customer.status_reason is None
    assert customer.warnings == []


def test_capabilities_name_what_the_parser_does_not_read() -> None:
    capabilities = cobolcopybook_capabilities()

    assert "copybook.picture_clauses" in capabilities.supported
    assert "copybook.condition_names_88" in capabilities.supported
    assert "copybook.redefines" in capabilities.unsupported
    # The DEPENDING ON in 01-customer-record.cpy is on a continuation line and is therefore not read.
    assert "copybook.multi_line_clauses" in capabilities.unsupported


def test_a_continued_clause_is_absent_from_the_tree_and_declared_in_capabilities(
    customer,
) -> None:
    phones = _by_name(customer, "CUST-PHONES")

    assert phones.attributes["occursMax"] == 5
    assert "dependingOn" not in phones.attributes
    assert "copybook.multi_line_clauses" in customer.capabilities.unsupported


# ---------------------------------------------------------------------------
# Redaction and determinism
# ---------------------------------------------------------------------------


def test_a_copybook_analysis_carries_no_payload_values(customer) -> None:
    """A copybook is a layout, not a payload: there is nothing observed to withhold, so the record
    is identical under every visibility policy."""
    assert all(node.value is None for node in _walk(customer.tree))

    stored = apply_value_visibility(customer, ValueVisibility.NONE)
    assert stored.redaction.redacted_node_count == 0
    assert stored.contract_violations() == []


def test_the_same_copybook_always_produces_the_same_record() -> None:
    a = analyze_cobolcopybook(parse_cobolcopybook(_CUSTOMER))
    b = analyze_cobolcopybook(parse_cobolcopybook(_CUSTOMER))

    assert analysis_content_fingerprint(a) == analysis_content_fingerprint(b)


def test_the_record_names_the_bytes_it_analysed(customer) -> None:
    assert customer.source_hash == source_digest(_CUSTOMER)
    assert customer.source_format == COBOL_ANALYZER_KEY
    assert customer.analyzer.tool_versions["cobolcopybook_parser"]


# ---------------------------------------------------------------------------
# Through the adapter SPI
# ---------------------------------------------------------------------------


def test_the_adapter_routes_analysis_to_the_native_extractor() -> None:
    adapter = CobolCopybookImportSource()
    document = adapter.analyze(adapter.parse(_CUSTOMER), source=_CUSTOMER)

    assert document.analyzer.key == COBOL_ANALYZER_KEY
    assert adapter.analyzer_key == COBOL_ANALYZER_KEY
    assert document.tree[0].name == "CUSTOMER-RECORD"


def test_the_adapter_rejects_an_ast_that_is_not_a_copybook() -> None:
    adapter = CobolCopybookImportSource()

    with pytest.raises(ImportSourceError):
        adapter.analyze({"not": "a copybook"}, source="x")
