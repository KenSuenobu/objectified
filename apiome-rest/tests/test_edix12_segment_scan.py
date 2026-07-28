"""Tests for the EDI X12 raw-interchange scanner (CPDO-2.2, #4798).

The scanner is the second, independent reading of the bytes ``pyx12`` already parsed, and it exists
to answer the three questions the AST cannot: where a segment sits, which element positions were
written and left empty, and how a repeated value divides. Everything here is about those three —
plus the one property that makes the whole thing safe to build on, which is that the scanner reads
each interchange's *own* declared delimiters rather than assuming ``*``, ``>`` and ``~``.
"""

from __future__ import annotations

from pathlib import Path

from app.edix12_segment_scan import (
    MAX_SCANNED_SEGMENTS,
    detect_delimiters,
    is_segment_id,
    scan_segments,
    split_components,
    split_elements,
    split_repetitions,
)

_EXAMPLES = Path(__file__).resolve().parents[2] / "apiome-ui/examples/edi-x12"
_PO_850 = (_EXAMPLES / "01-850-purchase-order.edi").read_text(encoding="utf-8")

#: A ``00401`` interchange laid out on one line — the shape most real X12 files arrive in.
_ONE_LINE = (
    "ISA*00*          *00*          *ZZ*SENDERID       *ZZ*RECEIVERID     "
    "*260115*0830*U*00401*000000001*0*P*>~"
    "GS*PO*SENDERID*RECEIVERID*20260115*0830*1*X*004010~"
    "ST*850*0001~"
    "BEG*00*SA*PO-1**20260115~"
    "SE*3*0001~"
    "GE*1*1~"
    "IEA*1*000000001~"
)

#: The same interchange under non-default delimiters: ``|`` elements, ``:`` components, ``'``
#: terminator — every one of which appears in real EDIFACT-influenced X12 traffic.
_ALTERNATE_DELIMITERS = (
    "ISA|00|          |00|          |ZZ|SENDERID       |ZZ|RECEIVERID     "
    "|260115|0830|U|00401|000000001|0|P|:'"
    "GS|PO|SENDERID|RECEIVERID|20260115|0830|1|X|004010'"
    "ST|850|0001'"
    "BEG|00|SA|PO-1||20260115'"
    "SE|3|0001'"
    "GE|1|1'"
    "IEA|1|000000001'"
)

#: A ``00501`` interchange, where ``ISA11`` *is* the repetition separator.
_FIVE_010 = (
    "ISA*00*          *00*          *ZZ*SENDERID       *ZZ*RECEIVERID     "
    "*260115*0830*^*00501*000000001*0*T*>~"
    "GS*HC*SENDERID*RECEIVERID*20260115*0830*1*X*005010X222A1~"
    "ST*837*0001*005010X222A1~"
    "REF*D9*A^B^C~"
    "SE*3*0001~"
    "GE*1*1~"
    "IEA*1*000000001~"
)


# ---------------------------------------------------------------------------
# Delimiters
# ---------------------------------------------------------------------------


def test_delimiters_come_from_the_header_rather_than_from_a_default() -> None:
    delimiters = detect_delimiters(_ALTERNATE_DELIMITERS)

    assert delimiters is not None
    assert (delimiters.element, delimiters.component, delimiters.segment) == ("|", ":", "'")
    assert delimiters.version == "00401"


def test_the_shipped_example_declares_the_conventional_delimiters() -> None:
    delimiters = detect_delimiters(_PO_850)

    assert delimiters is not None
    assert (delimiters.element, delimiters.component, delimiters.segment) == ("*", ">", "~")


def test_isa11_is_a_repetition_separator_only_from_version_00501() -> None:
    """At ``00401`` that position is the Interchange Control Standards Identifier, conventionally
    ``U``. Reading it as a delimiter there would split every value containing a ``U``."""
    four_010 = detect_delimiters(_ONE_LINE)
    five_010 = detect_delimiters(_FIVE_010)

    assert four_010 is not None and four_010.repetition is None
    assert five_010 is not None and five_010.repetition == "^"


def test_a_00501_interchange_that_left_isa11_alphanumeric_declares_no_separator() -> None:
    """The version permits a repetition separator; this sender did not supply one. A ``U`` is not
    promoted to a delimiter just because the version would have allowed it to be."""
    source = _FIVE_010.replace("*0830*^*00501*", "*0830*U*00501*", 1)

    delimiters = detect_delimiters(source)
    assert delimiters is not None
    assert delimiters.repetition is None


def test_text_with_no_isa_header_yields_no_delimiters() -> None:
    """Nothing is guessed: every position the scanner reports depends on these being right."""
    assert detect_delimiters("GS*PO*A*B*20260115*0830*1*X*004010~") is None
    assert detect_delimiters("") is None
    # An "ISA" that is really part of a word is not a header.
    assert detect_delimiters("ISAAC*00*...~") is None


def test_a_truncated_header_yields_no_delimiters() -> None:
    assert detect_delimiters("ISA*00*          *00*~") is None


# ---------------------------------------------------------------------------
# Scanning
# ---------------------------------------------------------------------------


def test_a_one_line_interchange_scans_to_exact_offsets() -> None:
    delimiters = detect_delimiters(_ONE_LINE)
    assert delimiters is not None
    segments, complete = scan_segments(_ONE_LINE, delimiters)

    assert complete is True
    assert [segment.segment_id for segment in segments] == [
        "ISA",
        "GS",
        "ST",
        "BEG",
        "SE",
        "GE",
        "IEA",
    ]
    for segment in segments:
        # The offset/length pair is the contract a UI highlights on, so it must be exact.
        assert _ONE_LINE[segment.offset : segment.offset + segment.length] == segment.text
        assert segment.line == 1


def test_a_line_broken_interchange_reports_the_line_each_segment_starts_on() -> None:
    delimiters = detect_delimiters(_PO_850)
    assert delimiters is not None
    segments, _ = scan_segments(_PO_850, delimiters)

    assert [segment.line for segment in segments[:4]] == [1, 2, 3, 4]
    for segment in segments:
        assert _PO_850[segment.offset : segment.offset + segment.length] == segment.text
        # The newline separating segments belongs to neither of them.
        assert not segment.text.startswith("\n")
        assert segment.column == 1


def test_crlf_line_endings_do_not_double_the_line_count() -> None:
    source = _PO_850.replace("\n", "\r\n")
    delimiters = detect_delimiters(source)
    assert delimiters is not None
    segments, _ = scan_segments(source, delimiters)

    assert [segment.line for segment in segments[:3]] == [1, 2, 3]
    for segment in segments:
        assert source[segment.offset : segment.offset + segment.length] == segment.text


def test_a_final_segment_with_no_terminator_is_still_scanned() -> None:
    source = _ONE_LINE.rstrip("~")
    delimiters = detect_delimiters(source)
    assert delimiters is not None
    segments, _ = scan_segments(source, delimiters)

    assert segments[-1].segment_id == "IEA"
    assert source[segments[-1].offset : segments[-1].offset + segments[-1].length] == segments[-1].text


def test_the_scan_is_capped_and_says_so_rather_than_stopping_silently() -> None:
    """Memory is bounded by this module, not by the size of the file — and a short scan reports
    itself so a caller can say the tail carries no positions rather than that it does not exist."""
    delimiters = detect_delimiters(_ONE_LINE)
    assert delimiters is not None
    header, _, _ = _ONE_LINE.partition("~")
    padded = header + "~" + "REF*DP*X~" * (MAX_SCANNED_SEGMENTS + 5)

    segments, complete = scan_segments(padded, delimiters)
    assert complete is False
    assert len(segments) == MAX_SCANNED_SEGMENTS


def test_text_with_no_header_scans_to_nothing() -> None:
    delimiters = detect_delimiters(_ONE_LINE)
    assert delimiters is not None
    assert scan_segments("not an interchange at all", delimiters) == ([], True)


# ---------------------------------------------------------------------------
# Splitting
# ---------------------------------------------------------------------------


def test_element_splitting_keeps_the_positions_pyx12_omits() -> None:
    """The reason this module exists: ``BEG04`` was written and left empty, and the source proves
    it by carrying the delimiter. ``pyx12``'s value iterator skips the position entirely."""
    delimiters = detect_delimiters(_ONE_LINE)
    assert delimiters is not None

    parts = split_elements("BEG*00*SA*PO-1**20260115", delimiters)
    assert parts == ["BEG", "00", "SA", "PO-1", "", "20260115"]


def test_trailing_empty_positions_are_kept() -> None:
    delimiters = detect_delimiters(_ONE_LINE)
    assert delimiters is not None
    assert split_elements("NM1*IL*1***", delimiters) == ["NM1", "IL", "1", "", "", ""]


def test_components_split_on_the_declared_separator_only() -> None:
    delimiters = detect_delimiters(_ALTERNATE_DELIMITERS)
    assert delimiters is not None

    assert split_components("11:B:1", delimiters) == ["11", "B", "1"]
    # ``>`` is data under these delimiters, not a component separator.
    assert split_components("11>B>1", delimiters) == ["11>B>1"]


def test_a_value_with_no_component_separator_is_one_component() -> None:
    delimiters = detect_delimiters(_ONE_LINE)
    assert delimiters is not None
    assert split_components("PLAIN", delimiters) == ["PLAIN"]


def test_repetitions_split_only_where_the_interchange_declares_a_separator() -> None:
    four_010 = detect_delimiters(_ONE_LINE)
    five_010 = detect_delimiters(_FIVE_010)
    assert four_010 is not None and five_010 is not None

    assert split_repetitions("A^B^C", five_010) == ["A", "B", "C"]
    # The same value under 00401 is one value that happens to contain a caret.
    assert split_repetitions("A^B^C", four_010) == ["A^B^C"]


# ---------------------------------------------------------------------------
# Shape guard
# ---------------------------------------------------------------------------


def test_segment_ids_are_recognised_by_shape_not_by_vocabulary() -> None:
    assert is_segment_id("ISA")
    assert is_segment_id("N1")
    assert is_segment_id("W09")
    # The scanner knows no segment vocabulary and claims none — only the shape is checked.
    assert is_segment_id("ZZZ")
    assert not is_segment_id("")
    assert not is_segment_id("n1")
    assert not is_segment_id("SEGMENT")
