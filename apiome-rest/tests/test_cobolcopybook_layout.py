"""Tests for the COBOL copybook storage-layout calculator (CPDO-2.3, #4799).

A copybook is a *positional* description, and this module is the arithmetic that recovers the
positions. Two things are being pinned here, and the second matters more than the first:

1. **the sums are right** — display, packed, binary and floating widths, group totals, tables, and
   REDEFINES sharing one span of storage rather than following it;
2. **the unknowns stay unknown** — an unreadable PICTURE, an item with nothing to size, and an item
   after a variable-length table each produce *no* number rather than a plausible one, and the
   unknown propagates outward exactly as far as it really goes.

``05-ach-entry-detail.cpy`` reconstructs the NACHA ACH Entry Detail record, which the public file
format fixes at **94 characters** — an arithmetic check this suite can make against something other
than itself.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.cobolcopybook_layout import (
    BASIS_BINARY,
    BASIS_DISPLAY,
    BASIS_FLOAT,
    BASIS_PACKED,
    LAYOUT_ASSUMPTIONS,
    compute_layout,
    picture_size,
    record_length_range,
    resolve_odo_controllers,
)
from app.cobolcopybook_parser import CobolField, parse_cobolcopybook

_EXAMPLES = Path(__file__).resolve().parents[2] / "apiome-ui/examples/cobol-copybook"
_CUSTOMER = (_EXAMPLES / "01-customer-record.cpy").read_text(encoding="utf-8")
_REDEFINES = (_EXAMPLES / "03-payment-redefines.cpy").read_text(encoding="utf-8")
_WAREHOUSE = (_EXAMPLES / "04-warehouse-stress.cpy").read_text(encoding="utf-8")
_ACH = (_EXAMPLES / "05-ach-entry-detail.cpy").read_text(encoding="utf-8")


def _layout_by_name(source: str):
    """Return ``name → FieldLayout`` plus the root layout, for one copybook."""
    root = parse_cobolcopybook(source).root
    layouts = compute_layout(root)

    named = {}

    def walk(field: CobolField) -> None:
        # Last writer wins for a repeated name; every test below that cares uses a unique one.
        named[field.name] = layouts[id(field)]
        for child in field.children:
            walk(child)

    walk(root)
    return named, layouts[id(root)]


# ---------------------------------------------------------------------------
# PICTURE / USAGE widths
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("picture", "usage", "length", "basis"),
    [
        ("X(20)", None, 20, BASIS_DISPLAY),
        ("X", None, 1, BASIS_DISPLAY),
        ("9(8)", None, 8, BASIS_DISPLAY),
        ("A(5)", None, 5, BASIS_DISPLAY),
        ("XXX", None, 3, BASIS_DISPLAY),
        ("999", None, 3, BASIS_DISPLAY),
        # S is an overpunched sign and V an implied point: neither takes a character position, which
        # is how a copybook stores 11 digits of money in 9 display bytes.
        ("S9(9)V99", None, 11, BASIS_DISPLAY),
        # Packed: two digits per byte plus a sign nibble.
        ("S9(9)V99", "COMP-3", 6, BASIS_PACKED),
        ("9(8)", "COMP-3", 5, BASIS_PACKED),
        ("S9(3)V9(2)", "COMP-3", 3, BASIS_PACKED),
        ("9", "PACKED-DECIMAL", 1, BASIS_PACKED),
        # Binary widths by digit count.
        ("9(2)", "COMP", 2, BASIS_BINARY),
        ("9(4)", "BINARY", 2, BASIS_BINARY),
        ("9(8)", "BINARY", 4, BASIS_BINARY),
        ("9(9)", "COMP-4", 4, BASIS_BINARY),
        ("9(18)", "COMP", 8, BASIS_BINARY),
        # Floating point is fixed-width and carries no picture.
        (None, "COMP-1", 4, BASIS_FLOAT),
        (None, "COMP-2", 8, BASIS_FLOAT),
    ],
)
def test_picture_widths(picture, usage, length, basis) -> None:
    size = picture_size(picture, usage)

    assert size.length == length
    assert size.basis == basis
    assert size.reason is None


def test_digit_and_decimal_counts_come_from_the_picture() -> None:
    size = picture_size("S9(9)V99", "COMP-3")

    assert (size.digits, size.decimals, size.signed) == (11, 2, True)


def test_an_unsigned_picture_is_not_reported_as_signed() -> None:
    assert picture_size("9(4)", None).signed is False


def test_usage_is_read_case_insensitively() -> None:
    assert picture_size("9(4)", "comp-3").length == picture_size("9(4)", "COMP-3").length


@pytest.mark.parametrize(
    ("picture", "usage"),
    [
        # A national/DBCS item's width depends on an encoding the copybook does not state.
        ("N(10)", None),
        # A usage this module has no width table for.
        ("9(4)", "COMP-5"),
        # Digits beyond what a binary item holds.
        ("9(20)", "COMP"),
        # Nothing to size.
        (None, None),
        ("", None),
        ("   ", None),
    ],
)
def test_an_item_this_module_cannot_size_reports_no_length_and_says_why(picture, usage) -> None:
    """A zero would silently shift every offset after it — which is the failure this whole module
    exists to avoid — so an unsizable item reports ``None`` with a stated reason instead."""
    size = picture_size(picture, usage)

    assert size.length is None
    assert size.reason


def test_a_length_and_a_reason_are_never_both_present() -> None:
    """A reason rendered beside a number would read as a caveat on a figure that is actually sound."""
    for picture, usage in [("X(4)", None), ("N(4)", None), ("9(4)", "COMP-3"), (None, "COMP-5")]:
        size = picture_size(picture, usage)
        assert (size.length is None) == (size.reason is not None)


# ---------------------------------------------------------------------------
# Offsets within a record
# ---------------------------------------------------------------------------


def test_a_fixed_record_lays_out_end_to_end_from_offset_one() -> None:
    named, root = _layout_by_name(_ACH)

    assert named["ACH-RECORD-TYPE"].offset == 1
    assert named["ACH-TRANSACTION-CODE"].offset == 2
    assert named["ACH-DFI-ACCOUNT-NUMBER"].offset == 13
    assert named["ACH-TRACE-NUMBER"].offset == 80
    assert root.variable is False


def test_the_ach_entry_detail_record_computes_to_its_documented_94_characters() -> None:
    """An arithmetic check against something other than this suite: the public ACH file format
    fixes the Entry Detail record at 94 characters."""
    _, root = _layout_by_name(_ACH)

    assert record_length_range(root) == (94, 94)


def test_a_group_is_the_sum_of_what_is_under_it() -> None:
    named, _ = _layout_by_name(_CUSTOMER)

    assert named["CUST-FIRST-NAME"].total_length == 20
    assert named["CUST-LAST-NAME"].total_length == 20
    assert named["CUST-NAME"].length == 40
    # And the item after the group starts after all of it.
    assert named["CUST-STATUS"].offset == named["CUST-NAME"].offset + 40


def test_nesting_three_levels_deep_still_accumulates_correctly() -> None:
    named, _ = _layout_by_name(_WAREHOUSE)

    # 15-level items inside a 10-level group inside a 05-level table.
    assert named["BIN-WEIGHT-KG"].length == 5
    assert named["BIN-VOLUME-M3"].length == 4
    assert named["BIN-MEASURES"].length == 9
    assert named["BIN-LAST-COUNTED"].offset == named["BIN-MEASURES"].offset + 9


# ---------------------------------------------------------------------------
# Tables
# ---------------------------------------------------------------------------


def test_a_table_multiplies_its_length_but_not_its_first_offset() -> None:
    named, _ = _layout_by_name(_CUSTOMER)
    phones = named["CUST-PHONES"]

    # One occurrence is 16 bytes; five of them are 80; one is the minimum.
    assert phones.length == 16
    assert phones.total_length == 80
    assert phones.min_total_length == 16
    assert phones.offset == named["CUST-PHONE-COUNT"].offset + 2


def test_a_variable_table_makes_the_record_a_length_range() -> None:
    _, root = _layout_by_name(_CUSTOMER)

    minimum, maximum = record_length_range(root)
    assert minimum == 81
    assert maximum == 145
    assert root.variable is True


def test_an_item_after_a_variable_table_has_no_offset_rather_than_its_minimum() -> None:
    """Where it starts depends on a value that exists only at runtime. Reporting the minimum as
    *the* offset is the single most misleading number this module could emit."""
    named, _ = _layout_by_name(_CUSTOMER)
    created = named["CUST-CREATED-DATE"]

    assert created.offset is None
    assert created.offset_variable is True
    # Its own size is still perfectly well known — only its position is not.
    assert created.length == 8


def test_a_group_after_a_variable_table_carries_the_unknown_down_to_its_children() -> None:
    named, _ = _layout_by_name(_WAREHOUSE)

    assert named["WH-AUDIT"].offset_variable is True
    assert named["WH-AUDIT-USER"].offset_variable is True
    assert named["WH-AUDIT-USER"].offset is None


def test_a_fixed_table_is_not_a_variable_one() -> None:
    """``OCCURS 5 TIMES`` has a length, not a range — so nothing after it becomes unknowable."""
    source = (
        "       01  FIXED-TABLE-REC.\n"
        "           05  TABLE-ROWS OCCURS 5 TIMES.\n"
        "               10  ROW-CODE            PIC X(2).\n"
        "           05  TRAILER                 PIC X(3).\n"
    )
    named, root = _layout_by_name(source)

    assert named["TABLE-ROWS"].total_length == 10
    assert named["TABLE-ROWS"].variable is False
    assert named["TRAILER"].offset == 11
    assert named["TRAILER"].offset_variable is False
    assert record_length_range(root) == (13, 13)


# ---------------------------------------------------------------------------
# REDEFINES
# ---------------------------------------------------------------------------


def test_a_redefining_item_starts_where_its_target_starts() -> None:
    named, _ = _layout_by_name(_REDEFINES)

    assert named["PAYMENT-DETAIL"].offset == 18
    assert named["CARD-DETAIL"].offset == 18
    assert named["BANK-DETAIL"].offset == 18
    assert named["CARD-DETAIL"].redefines == "PAYMENT-DETAIL"


def test_a_redefining_item_does_not_advance_the_record() -> None:
    """It is the same storage described again, so the item after the overlays follows the *target*
    — a redefining item that pushed the record along would corrupt every offset after it."""
    named, root = _layout_by_name(_REDEFINES)

    assert named["PAYMENT-POSTED-DATE"].offset == 48
    assert record_length_range(root) == (55, 55)


def test_a_redefining_group_lays_out_its_own_children_over_the_shared_storage() -> None:
    named, _ = _layout_by_name(_REDEFINES)

    assert named["CARD-NUMBER"].offset == 18
    assert named["CARD-EXPIRY-YYMM"].offset == 34
    assert named["BANK-ROUTING"].offset == 18
    assert named["BANK-ACCOUNT"].offset == 27


def test_a_redefines_naming_an_undeclared_item_leaves_it_unplaced() -> None:
    """Placing it at the cursor would put it on a different item's bytes."""
    source = (
        "       01  ORPHAN-REC.\n"
        "           05  REAL-FIELD              PIC X(4).\n"
        "           05  GHOST REDEFINES NOT-HERE PIC X(4).\n"
    )
    named, _ = _layout_by_name(source)

    assert named["GHOST"].offset is None
    assert named["GHOST"].redefines == "NOT-HERE"
    # The item it could not be placed over is unaffected.
    assert named["REAL-FIELD"].offset == 1


# ---------------------------------------------------------------------------
# Unknowns propagate
# ---------------------------------------------------------------------------


def test_an_unsized_item_leaves_its_group_unsized() -> None:
    source = (
        "       01  MIXED-REC.\n"
        "           05  KNOWN-FIELD             PIC X(4).\n"
        "           05  NATIONAL-FIELD          PIC N(6).\n"
    )
    named, root = _layout_by_name(source)

    assert named["KNOWN-FIELD"].length == 4
    assert named["NATIONAL-FIELD"].length is None
    assert root.total_length is None
    assert root.reason


def test_an_item_after_an_unsized_item_has_no_offset() -> None:
    source = (
        "       01  MIXED-REC.\n"
        "           05  NATIONAL-FIELD          PIC N(6).\n"
        "           05  AFTER-FIELD             PIC X(4).\n"
    )
    named, _ = _layout_by_name(source)

    assert named["AFTER-FIELD"].offset is None
    # Its own length is still known — only where it sits is not.
    assert named["AFTER-FIELD"].length == 4


def test_a_record_of_known_items_reports_no_reason() -> None:
    _, root = _layout_by_name(_ACH)

    assert root.reason is None
    assert root.total_length == 94


# ---------------------------------------------------------------------------
# ODO controllers
# ---------------------------------------------------------------------------


def test_an_odo_controller_declared_in_the_copybook_resolves() -> None:
    assert resolve_odo_controllers(parse_cobolcopybook(_CUSTOMER).root) == {
        "CUST-PHONE-COUNT": True
    }


def test_an_odo_controller_the_copybook_does_not_declare_is_reported_unresolved() -> None:
    """Not necessarily an error — the controller may live in a surrounding copybook — but a fact a
    reader needs, because the table's bounds cannot be reasoned about from this file alone."""
    source = (
        "       01  ELSEWHERE-REC.\n"
        "           05  ROWS OCCURS 1 TO 4 TIMES DEPENDING ON OUTER-COUNT.\n"
        "               10  ROW-CODE            PIC X(2).\n"
    )
    assert resolve_odo_controllers(parse_cobolcopybook(source).root) == {"OUTER-COUNT": False}


def test_a_copybook_with_no_tables_names_no_controllers() -> None:
    assert resolve_odo_controllers(parse_cobolcopybook(_ACH).root) == {}


# ---------------------------------------------------------------------------
# Assumptions
# ---------------------------------------------------------------------------


def test_the_assumptions_are_declared_rather_than_left_implicit() -> None:
    """Every computed length is only true under conditions the copybook does not state, so the
    conditions ship with the number."""
    joined = " ".join(LAYOUT_ASSUMPTIONS).lower()

    assert "single-byte" in joined
    assert "comp-3" in joined
    assert "sign" in joined
    assert "synchronized" in joined


def test_identity_keying_gives_two_fillers_two_offsets() -> None:
    """Copybook names repeat — FILLER most of all — so layouts are keyed by object identity. Keying
    by name would give every FILLER in a record the last one's offset."""
    source = (
        "       01  FILLER-REC.\n"
        "           05  FILLER                  PIC X(4).\n"
        "           05  REAL-FIELD              PIC X(2).\n"
        "           05  FILLER                  PIC X(6).\n"
    )
    root = parse_cobolcopybook(source).root
    layouts = compute_layout(root)

    fillers = [layouts[id(child)] for child in root.children if child.name == "FILLER"]
    assert [layout.offset for layout in fillers] == [1, 7]
    assert [layout.length for layout in fillers] == [4, 6]


# ---------------------------------------------------------------------------
# Fixed-format export (CPDO-2.3 caught this; it is layout arithmetic too)
# ---------------------------------------------------------------------------


def _roundtrip(source: str):
    """Emit one copybook back out and re-parse it, returning the re-parsed root."""
    from app.cobolcopybook_emitter import CobolCopybookEmitter
    from app.cobolcopybook_normalizer import CobolCopybookNormalizer

    api = CobolCopybookNormalizer().normalize(parse_cobolcopybook(source))
    emitted = CobolCopybookEmitter().emit(api).files[0].content
    return emitted, parse_cobolcopybook(emitted).root


def _named_fields(root: CobolField):
    """Return ``name → CobolField`` for a re-parsed tree."""
    found = {}

    def visit(field: CobolField) -> None:
        found[field.name] = field
        for child in field.children:
            visit(child)

    visit(root)
    return found


def test_an_entry_too_long_for_the_code_area_wraps_instead_of_being_truncated() -> None:
    """A fixed-format reader stops at column 72, so a clause emitted past it is not merely ugly —
    it is silently cut, and ``DEPENDING ON CUST-PHONE-COUNT`` parses back as a *different, shorter*
    data name. Every emitted line must fit."""
    emitted, root = _roundtrip(_CUSTOMER)

    for line in emitted.splitlines():
        assert len(line) <= 72, line

    assert _named_fields(root)["CUST-PHONES"].depending_on == "CUST-PHONE-COUNT"


def test_a_wrapped_clause_is_never_split_in_half() -> None:
    """Clauses wrap whole. Half of a DEPENDING ON is not a shorter clause, it is a wrong one."""
    emitted, _ = _roundtrip(_CUSTOMER)

    assert "OCCURS 1 TO 5 TIMES" in emitted
    assert "DEPENDING ON CUST-PHONE-COUNT." in emitted


def test_redefines_survives_an_export_and_re_import() -> None:
    """Without it an export turns two overlays into two sequential items and silently changes the
    record's length — from 55 bytes to 115."""
    emitted, root = _roundtrip(_REDEFINES)
    fields = _named_fields(root)

    assert "REDEFINES PAYMENT-DETAIL" in emitted
    assert fields["CARD-DETAIL"].redefines == "PAYMENT-DETAIL"
    assert fields["BANK-DETAIL"].redefines == "PAYMENT-DETAIL"

    # The re-imported copybook lays out to the same record it started as.
    assert record_length_range(compute_layout(root)[id(root)]) == (55, 55)


def test_an_exported_copybook_lays_out_identically_to_its_source() -> None:
    """The strongest statement available: export, re-import, and the byte arithmetic agrees."""
    for source in (_CUSTOMER, _REDEFINES, _WAREHOUSE, _ACH):
        original = parse_cobolcopybook(source).root
        _, reparsed = _roundtrip(source)

        assert record_length_range(compute_layout(reparsed)[id(reparsed)]) == record_length_range(
            compute_layout(original)[id(original)]
        )
