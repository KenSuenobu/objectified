"""Tests for the COBOL copybook native-analysis extractor (CPDO-1.2, #4795).

A copybook normalizes into records and fields with types — which is what a canonical model can hold,
and roughly half of what the copybook said. These tests pin the other half surviving the import:
level numbers, PICTURE and USAGE clauses, OCCURS bounds, 88-level condition names, and the source
line each was declared on.

They also pin the honesty rule the ticket asks for. The parser behind this extractor reads
``REDEFINES`` (CPDO-2.3, #4799) but not ``COPY … REPLACING`` or level-66 renames; a copybook that
uses an unmodelled clause is analysed as far as the parser understands it, and the record says so
with a warning and a ``partial`` status rather than presenting a partial tree as a complete one.
"""

from __future__ import annotations

from typing import Any, List

import pytest
from corpus_loader import unique_corpus_entry

from app.cobolcopybook_analysis import (
    COBOL_ANALYZER_KEY,
    KIND_CONDITION,
    KIND_FIELD,
    KIND_GROUP,
    KIND_RECORD,
    WARNING_LAYOUT_ASSUMPTIONS,
    WARNING_ODO_CONTROLLER_UNRESOLVED,
    WARNING_REDEFINES_SIZE_MISMATCH,
    WARNING_REDEFINES_TARGET_MISSING,
    WARNING_UNSIZED_ITEM,
    WARNING_VARIABLE_LENGTH_RECORD,
    analyze_cobolcopybook,
    cobolcopybook_capabilities,
)
from app.cobolcopybook_import_source import CobolCopybookImportSource
from app.cobolcopybook_parser import iter_definition_lines, parse_cobolcopybook
from app.import_source import ImportSourceError
from app.payload_analysis import (
    REASON_UNSUPPORTED_FORMAT,
    SEVERITY_INFO,
    SEVERITY_WARNING,
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
_CUSTOMER = unique_corpus_entry(format="cobolcopybook", features=("occurs",)).read_text()
_REDEFINES = unique_corpus_entry(
    format="cobolcopybook", features=("redefines", "level-88")
).read_text()
_WAREHOUSE = unique_corpus_entry(format="cobolcopybook", features=("binary",)).read_text()


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


def test_redefines_is_described_as_the_overlay_it_is() -> None:
    """CPDO-2.3 parses REDEFINES, so a redefining item is no longer an unexplained absence *or* an
    independent field: it is the same storage, laid out a second way, and says so from both ends."""
    document = analyze_cobolcopybook(parse_cobolcopybook(_REDEFINES))

    # Nothing is missing from the analysis, so nothing about it is partial.
    assert document.status == STATUS_AVAILABLE
    assert not [w for w in document.warnings if w.code == "copybook.redefines"]

    card = _by_name(document, "CARD-DETAIL")
    detail = _by_name(document, "PAYMENT-DETAIL")
    assert card.kind == KIND_GROUP
    assert card.attributes["redefines"] == "PAYMENT-DETAIL"
    # And from the target's side, so selecting the redefined item shows what claims its bytes.
    assert detail.attributes["redefinedBy"] == ["CARD-DETAIL", "BANK-DETAIL"]


def test_a_copybook_using_no_unmodelled_clause_is_available(customer) -> None:
    assert customer.status == STATUS_AVAILABLE
    assert customer.status_reason is None
    # Every warning it does carry is informational — a variable-length record and the assumptions
    # its computed lengths rest on are facts about the layout, not gaps in the analysis.
    assert customer.warnings
    assert all(warning.severity == SEVERITY_INFO for warning in customer.warnings)


def test_capabilities_name_what_the_parser_does_not_read() -> None:
    capabilities = cobolcopybook_capabilities()

    assert "copybook.picture_clauses" in capabilities.supported
    assert "copybook.condition_names_88" in capabilities.supported
    # CPDO-2.3 moved these four across: the parser reads REDEFINES and continuation lines, and the
    # analysis computes storage from PICTURE/USAGE.
    for construct in (
        "copybook.redefines",
        "copybook.multi_line_clauses",
        "copybook.computed_storage_length",
        "copybook.storage_offsets",
    ):
        assert construct in capabilities.supported, construct
    # The encoding a length assumes is never detected, only declared.
    assert "copybook.character_encoding_detection" in capabilities.unsupported
    assert not set(capabilities.supported) & set(capabilities.unsupported)


def test_a_clause_continued_onto_a_second_line_is_read_as_one_clause(customer) -> None:
    """``OCCURS 1 TO 5 TIMES`` and its ``DEPENDING ON`` sit on two lines in the shipped fixture. A
    COBOL entry ends at a period, not at a line break, so both belong to the one table."""
    phones = _by_name(customer, "CUST-PHONES")

    assert phones.attributes["occursMin"] == 1
    assert phones.attributes["occursMax"] == 5
    assert phones.attributes["dependingOn"] == "CUST-PHONE-COUNT"
    assert "copybook.multi_line_clauses" in customer.capabilities.supported


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


# ===========================================================================
# CPDO-2.3 (#4799) — the layout inspector's evidence
# ===========================================================================


#: A copybook whose PICTURE the calculator cannot read, so its storage is genuinely unknown.
_UNSIZED = (
    "       01  UNSIZED-REC.\n"
    "           05  KNOWN-FIELD             PIC X(4).\n"
    "           05  NATIONAL-FIELD          PIC N(6).\n"
)

#: A copybook whose REDEFINES needs more storage than the item it redefines.
_OVERSIZED_REDEFINES = (
    "       01  TIGHT-REC.\n"
    "           05  SMALL-AREA              PIC X(4).\n"
    "           05  BIG-VIEW REDEFINES SMALL-AREA.\n"
    "               10  BIG-PART            PIC X(9).\n"
)


# ---------------------------------------------------------------------------
# AC: calculable offsets and lengths
# ---------------------------------------------------------------------------


def test_every_item_carries_the_offset_and_length_it_occupies(customer) -> None:
    record = _by_name(customer, "CUSTOMER-RECORD")
    first = _by_name(customer, "CUST-ID")
    name_group = _by_name(customer, "CUST-NAME")

    assert record.attributes["offset"] == 1
    assert first.attributes["offset"] == 1
    assert first.attributes["length"] == 8
    # A group's length is the sum of what is under it, and the next item starts after all of it.
    assert name_group.attributes["offset"] == 9
    assert name_group.attributes["length"] == 40
    assert _by_name(customer, "CUST-STATUS").attributes["offset"] == 49


def test_a_packed_field_records_its_basis_digits_and_decimals(customer) -> None:
    """``PIC S9(9)V99 COMP-3`` is 11 digits in 6 bytes. Recording the basis is what lets a reader
    see *why* a length is what it is rather than being handed a number with no derivation."""
    balance = _by_name(customer, "CUST-BALANCE")

    assert balance.attributes["length"] == 6
    assert balance.attributes["storageBasis"] == "packed"
    assert balance.attributes["digits"] == 11
    assert balance.attributes["decimals"] == 2
    assert balance.attributes["signed"] is True


def test_binary_and_display_bases_are_distinguished() -> None:
    document = analyze_cobolcopybook(parse_cobolcopybook(_WAREHOUSE), source=_WAREHOUSE)

    assert _by_name(document, "WH-REGION-CODE").attributes["storageBasis"] == "binary"
    assert _by_name(document, "WH-CAPACITY-UNITS").attributes["storageBasis"] == "binary"
    assert _by_name(document, "WH-CAPACITY-UNITS").attributes["length"] == 4
    assert _by_name(document, "WH-ID").attributes["storageBasis"] == "display"


def test_a_fixed_length_record_records_one_length_and_no_range() -> None:
    ach = unique_corpus_entry(
        format="cobolcopybook", features=("fixed-length-record",)
    ).read_text()
    document = analyze_cobolcopybook(parse_cobolcopybook(ach), source=ach)
    record = _by_name(document, "ACH-ENTRY-DETAIL")

    assert record.attributes["totalLength"] == 94
    assert "minTotalLength" not in record.attributes
    assert "variableLength" not in record.attributes


# ---------------------------------------------------------------------------
# AC: ambiguous or unsized layouts surface warnings
# ---------------------------------------------------------------------------


def test_a_variable_length_record_states_its_range_rather_than_a_size(customer) -> None:
    record = _by_name(customer, "CUSTOMER-RECORD")

    assert record.attributes["variableLength"] is True
    assert record.attributes["minTotalLength"] == 81
    assert record.attributes["totalLength"] == 145

    notes = [w for w in customer.warnings if w.code == WARNING_VARIABLE_LENGTH_RECORD]
    assert len(notes) == 1
    assert notes[0].severity == SEVERITY_INFO
    assert "81–145 bytes" in notes[0].message
    # A property of the layout the copybook declared, so nothing about the analysis is partial.
    assert customer.status == STATUS_AVAILABLE


def test_an_item_after_a_variable_table_says_its_offset_is_variable(customer) -> None:
    created = _by_name(customer, "CUST-CREATED-DATE")

    assert created.attributes["offsetVariable"] is True
    assert "offset" not in created.attributes
    # Its own size is known perfectly well — only its position is not.
    assert created.attributes["length"] == 8


def test_an_unsized_item_warns_and_makes_the_record_partial() -> None:
    """A PICTURE this analyzer cannot read is a boundary of the *analyzer*, so unlike a
    variable-length record it does make the record partial — offsets after it are not computed."""
    document = analyze_cobolcopybook(parse_cobolcopybook(_UNSIZED), source=_UNSIZED)

    assert document.status == STATUS_PARTIAL
    assert document.status_reason == REASON_UNSUPPORTED_FORMAT
    unsized = [w for w in document.warnings if w.code == WARNING_UNSIZED_ITEM]
    assert len(unsized) == 1
    assert unsized[0].severity == SEVERITY_WARNING
    assert "NATIONAL-FIELD" in unsized[0].message
    # The item that *could* be sized still is.
    assert _by_name(document, "KNOWN-FIELD").attributes["length"] == 4
    assert "length" not in _by_name(document, "NATIONAL-FIELD").attributes


def test_an_unresolved_odo_controller_is_stated_without_calling_the_copybook_wrong() -> None:
    source = (
        "       01  ELSEWHERE-REC.\n"
        "           05  ROWS OCCURS 1 TO 4 TIMES DEPENDING ON OUTER-COUNT.\n"
        "               10  ROW-CODE            PIC X(2).\n"
    )
    document = analyze_cobolcopybook(parse_cobolcopybook(source), source=source)

    notes = [w for w in document.warnings if w.code == WARNING_ODO_CONTROLLER_UNRESOLVED]
    assert len(notes) == 1
    assert notes[0].severity == SEVERITY_INFO
    assert "OUTER-COUNT" in notes[0].message
    assert "surrounding copybook" in notes[0].message
    # The controller may well exist elsewhere, so this is not a partiality.
    assert document.status == STATUS_AVAILABLE


def test_a_resolved_odo_controller_raises_no_note(customer) -> None:
    assert not [w for w in customer.warnings if w.code == WARNING_ODO_CONTROLLER_UNRESOLVED]


# ---------------------------------------------------------------------------
# AC: REDEFINES parsing and representation
# ---------------------------------------------------------------------------


def test_redefining_items_share_their_target_offset() -> None:
    document = analyze_cobolcopybook(parse_cobolcopybook(_REDEFINES), source=_REDEFINES)

    target = _by_name(document, "PAYMENT-DETAIL")
    card = _by_name(document, "CARD-DETAIL")
    bank = _by_name(document, "BANK-DETAIL")

    assert card.attributes["offset"] == target.attributes["offset"]
    assert bank.attributes["offset"] == target.attributes["offset"]
    # The overlays lay their own children over that shared storage.
    assert _by_name(document, "CARD-NUMBER").attributes["offset"] == 18
    assert _by_name(document, "BANK-ROUTING").attributes["offset"] == 18


def test_an_overlay_does_not_push_the_record_along() -> None:
    document = analyze_cobolcopybook(parse_cobolcopybook(_REDEFINES), source=_REDEFINES)

    assert _by_name(document, "PAYMENT-POSTED-DATE").attributes["offset"] == 48
    assert _by_name(document, "PAYMENT-RECORD").attributes["totalLength"] == 55


def test_an_oversized_overlay_is_recorded_rather_than_reconciled() -> None:
    """A fact about the copybook, not a limit of the analyzer — so both lengths stand as computed
    and the record stays available, exactly as an X12 control-total mismatch does (CPDO-2.2)."""
    document = analyze_cobolcopybook(
        parse_cobolcopybook(_OVERSIZED_REDEFINES), source=_OVERSIZED_REDEFINES
    )

    notes = [w for w in document.warnings if w.code == WARNING_REDEFINES_SIZE_MISMATCH]
    assert len(notes) == 1
    assert notes[0].severity == SEVERITY_INFO
    assert "BIG-VIEW needs 9 bytes over SMALL-AREA's 4" in notes[0].message
    assert document.status == STATUS_AVAILABLE
    assert _by_name(document, "SMALL-AREA").attributes["length"] == 4
    assert _by_name(document, "BIG-VIEW").attributes["length"] == 9


def test_a_redefines_naming_a_missing_target_is_stated_and_left_unplaced() -> None:
    source = (
        "       01  ORPHAN-REC.\n"
        "           05  REAL-FIELD              PIC X(4).\n"
        "           05  GHOST REDEFINES NOT-HERE PIC X(4).\n"
    )
    document = analyze_cobolcopybook(parse_cobolcopybook(source), source=source)

    notes = [w for w in document.warnings if w.code == WARNING_REDEFINES_TARGET_MISSING]
    assert len(notes) == 1
    assert "GHOST REDEFINES NOT-HERE" in notes[0].message
    ghost = _by_name(document, "GHOST")
    assert "offset" not in ghost.attributes
    assert ghost.attributes["redefines"] == "NOT-HERE"


def test_a_copybook_with_no_overlays_records_no_redefines_attributes(customer) -> None:
    """An item that redefines nothing carries nothing, rather than its own name — the two are
    different facts and a renderer must be able to tell them apart."""
    for node in _walk(customer.tree):
        assert "redefines" not in node.attributes
        assert "redefinedBy" not in node.attributes


# ---------------------------------------------------------------------------
# AC: no semantics are guessed from absent source data
# ---------------------------------------------------------------------------


def test_the_assumptions_behind_every_length_ship_with_the_record(customer) -> None:
    """A computed length is only true under conditions the copybook does not state, so the record
    carries them rather than presenting arithmetic as observation."""
    notes = [w for w in customer.warnings if w.code == WARNING_LAYOUT_ASSUMPTIONS]

    assert len(notes) == 1
    assert notes[0].severity == SEVERITY_INFO
    for phrase in ("single-byte", "COMP-3", "SYNCHRONIZED", "SIGN IS SEPARATE"):
        assert phrase in notes[0].message, phrase


def test_an_attribute_that_is_present_was_computed(customer) -> None:
    """No key is ever a placeholder: an offset of zero standing in for 'not worked out' is exactly
    the confusion the whole module is built to prevent."""
    for node in _walk(customer.tree):
        for key in ("offset", "length", "totalLength", "minTotalLength", "digits", "decimals"):
            if key in node.attributes:
                assert isinstance(node.attributes[key], int)
                assert node.attributes[key] > 0
        # The two ways of saying "no offset" are never both present.
        assert not ("offset" in node.attributes and "offsetVariable" in node.attributes)


def test_condition_names_carry_their_literal_and_no_storage() -> None:
    """An 88-level name is a value enumeration, not a field: it occupies no storage of its own, and
    claiming an offset for it would invent a position the copybook never declared."""
    document = analyze_cobolcopybook(parse_cobolcopybook(_REDEFINES), source=_REDEFINES)
    condition = _by_name(document, "PAY-BY-CARD")

    assert condition.attributes["level"] == 88
    assert condition.attributes["conditionValue"] == "C"
    assert "offset" not in condition.attributes
    assert "length" not in condition.attributes


def test_the_same_copybook_still_produces_the_same_record() -> None:
    """Offsets, lengths and overlays are all derived, so re-analysing the same bytes must still
    fingerprint identically — otherwise every sweep would append a redundant sequence."""
    a = analyze_cobolcopybook(parse_cobolcopybook(_REDEFINES), source=_REDEFINES)
    b = analyze_cobolcopybook(parse_cobolcopybook(_REDEFINES), source=_REDEFINES)

    assert analysis_content_fingerprint(a) == analysis_content_fingerprint(b)


# ---------------------------------------------------------------------------
# AC: fixed-format source line navigation
# ---------------------------------------------------------------------------


def test_every_item_still_points_at_the_fixed_format_line_it_came_from() -> None:
    """The copybooks are fixed-format — sequence area, indicator column, code in 8-72 — and the line
    a reader is sent to must be the line the item was declared on, comment banner included."""
    document = analyze_cobolcopybook(parse_cobolcopybook(_REDEFINES), source=_REDEFINES)
    source_lines = _REDEFINES.splitlines()

    for name in ("PAYMENT-RECORD", "CARD-DETAIL", "BANK-ACCOUNT", "PAYMENT-POSTED-DATE"):
        node = _by_name(document, name)
        line = node.location.line
        assert line is not None, name
        assert name in source_lines[line - 1], name


def test_a_repeated_filler_resolves_to_its_own_line() -> None:
    document = analyze_cobolcopybook(parse_cobolcopybook(_REDEFINES), source=_REDEFINES)
    fillers = [node for node in _walk(document.tree) if node.name == "FILLER"]

    assert len(fillers) == 2
    lines = [node.location.line for node in fillers]
    assert all(line is not None for line in lines)
    assert lines[0] != lines[1]
