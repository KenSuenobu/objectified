"""EDI X12 raw-interchange scanner — CPDO-2.2 (#4798).

:mod:`app.edix12_parser` reads an interchange through ``pyx12``, and ``pyx12`` answers questions
about *values*: it iterates the elements that carry one and reports each with a reference
designator. Three facts an inspector needs are lost on the way through:

``where the segment is``
    The AST carries no positions, so CPDO-1.2 located every X12 node by envelope path and sibling
    ordinal. A reader could not be shown the bytes their selection came from.

``which element positions were empty``
    ``values_iterator`` skips an element with no value, so ``BEG*00*SA*PO-1**20260115`` arrives as
    four elements rather than five — and ``BEG04``, which the source *did* carry and left empty, is
    indistinguishable from a ``BEG04`` that was never written.

``how a value repeats``
    A repetition separator is a delimiter like any other, and the value iterator hands back the
    whole repeated run as one string.

All three are still in the source text, which the analysis already holds in order to hash it. This
module reads them from there — a delimiter-aware scan of the interchange, with **no ``pyx12``
import and no AST**, so it is a second, independent reading of the same bytes rather than a
re-interpretation of the first.

.. code-block:: text

    ISA*00*   …*>~GS*PO*…~ST*850*0001~BEG*00*SA*PO-1**20260115~
    └─ offset 0, len 105 ┘└ offset 106 ┘ …

What it is deliberately not
---------------------------
It is **not a parser**. It splits on delimiters and records where the pieces were; it does not know
what an ``850`` is, does not validate an envelope, and does not decide what any element *means*.
When its reading and ``pyx12``'s disagree, :mod:`app.edix12_analysis` keeps ``pyx12``'s structure
and drops this module's positions — the AST is the analysis, and this is only evidence about where
the AST's constructs sat in the file.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import List, Optional, Sequence, Tuple

__all__ = [
    "ISA_ELEMENT_COUNT",
    "MAX_SCANNED_SEGMENTS",
    "REPETITION_SEPARATOR_MIN_VERSION",
    "X12Delimiters",
    "X12RawSegment",
    "detect_delimiters",
    "is_segment_id",
    "scan_segments",
    "split_components",
    "split_elements",
    "split_repetitions",
]

#: Elements in an ``ISA`` header. ``ISA16`` is the component (sub-element) separator itself, which
#: is why the character after the sixteenth element separator is a delimiter rather than data.
ISA_ELEMENT_COUNT = 16

#: The first X12 version in which ``ISA11`` is the *repetition separator*. At ``00401`` and earlier
#: it is the Interchange Control Standards Identifier (conventionally ``U``), and reading it as a
#: delimiter there would split ordinary values on a ``U``.
REPETITION_SEPARATOR_MIN_VERSION = "00501"

#: Ceiling on the segments one scan records. An interchange larger than this is scanned as far as
#: the cap and the caller is told the scan is short, so the memory a scan costs is bounded by this
#: module rather than by the size of the file. It sits an order of magnitude above the analyzer's
#: 5000-node budget, so a bounded analysis is never *also* short of positions.
MAX_SCANNED_SEGMENTS = 50_000

#: The start of an interchange. Anchored to a line start or the very beginning of the text so an
#: ``ISA`` appearing inside a value cannot be mistaken for the header.
_ISA_START = re.compile(r"(?:^|(?<=[\r\n]))ISA(?=[^A-Za-z0-9])")

#: A segment id: two or three upper-case alphanumerics, which is every id X12 defines.
_SEGMENT_ID = re.compile(r"^[A-Z0-9]{2,3}$")


@dataclass(frozen=True)
class X12Delimiters:
    """The four delimiters one interchange declares in its own ``ISA`` header.

    Attributes:
        element: ``ISA`` position 3 — separates elements within a segment.
        component: ``ISA16`` — separates components within a composite element.
        repetition: ``ISA11`` when the interchange version declares it as a repetition separator,
            else ``None``. ``None`` means "this interchange has no repetition separator", not "one
            could not be found" — see :data:`REPETITION_SEPARATOR_MIN_VERSION`.
        segment: The character terminating every segment.
        version: The interchange control version (``ISA12``), which is what decides whether
            ``ISA11`` is a delimiter at all. Recorded so a record can state the reason.
    """

    element: str
    component: str
    repetition: Optional[str]
    segment: str
    version: str


@dataclass(frozen=True)
class X12RawSegment:
    """One segment as it sits in the source text.

    Attributes:
        segment_id: The segment id (``ISA``, ``GS``, ``BEG``), upper-cased as written.
        ordinal: 0-based position among every scanned segment, in source order.
        offset: 0-based character offset of the segment id in the source.
        length: Characters from ``offset`` to the last character before the terminator, so
            ``source[offset:offset + length]`` is exactly :attr:`text`.
        line: 1-based line the segment starts on.
        column: 1-based column the segment starts at.
        text: The segment without its terminator and without surrounding whitespace.
    """

    segment_id: str
    ordinal: int
    offset: int
    length: int
    line: int
    column: int
    text: str


def _isa_start(source: str) -> int:
    """Return the offset of the interchange's ``ISA`` header, or ``-1`` when there is none."""
    match = _ISA_START.search(source)
    return match.start() if match else -1


def detect_delimiters(source: str) -> Optional[X12Delimiters]:
    """Read an interchange's four delimiters out of its ``ISA`` header.

    The header is read by *counting element separators* rather than by the fixed 106-character
    layout: a file whose ``ISA`` has been re-spaced still declares its delimiters correctly, and
    guessing from a fixed offset on such a file would produce a delimiter that is really data.

    Args:
        source: The interchange text.

    Returns:
        The delimiters, or ``None`` when the text carries no readable ``ISA`` header — no delimiter
        is ever guessed, because every later position in this module depends on them being right.
    """
    start = _isa_start(source)
    if start < 0:
        return None
    element = source[start + 3 : start + 4]
    if not element or element.isalnum() or element.isspace():
        # The character after ``ISA`` must be the element separator. An alphanumeric or a space
        # there means this is not an ``ISA`` header, whatever it looked like.
        return None

    # Walk the header element by element. ``ISA12`` is the version; the walk stops at the separator
    # *preceding* ``ISA16``, because ``ISA16`` is the component separator and is followed by the
    # segment terminator rather than by another element separator.
    cursor = start + 3
    version = ""
    for position in range(1, ISA_ELEMENT_COUNT):
        end = source.find(element, cursor + 1)
        if end < 0:
            return None
        if position == 12:
            version = source[cursor + 1 : end]
        cursor = end
    component = source[cursor + 1 : cursor + 2]
    terminator = source[cursor + 2 : cursor + 3]
    if not component or not terminator or terminator.isalnum():
        return None

    repetition: Optional[str] = None
    if version >= REPETITION_SEPARATOR_MIN_VERSION:
        # ``ISA11`` — the eleventh element, i.e. the character between the tenth and eleventh
        # separators. Only a real, non-alphanumeric delimiter is honoured: a ``00501`` interchange
        # that left ``ISA11`` as ``U`` has no repetition separator to report.
        candidate = _isa_element(source, start, element, 11)
        if candidate and len(candidate) == 1 and not candidate.isalnum() and not candidate.isspace():
            repetition = candidate

    return X12Delimiters(
        element=element,
        component=component,
        repetition=repetition,
        segment=terminator,
        version=version,
    )


def _isa_element(source: str, start: int, element: str, position: int) -> str:
    """Return one ``ISA`` element's raw text.

    Args:
        source: The interchange text.
        start: Offset of the ``ISA`` header.
        element: The element separator.
        position: 1-based element position.

    Returns:
        The element's text, or ``""`` when the header ends before that position.
    """
    cursor = start + 3
    for index in range(1, position + 1):
        end = source.find(element, cursor + 1)
        if end < 0:
            return ""
        if index == position:
            return source[cursor + 1 : end]
        cursor = end
    return ""


def scan_segments(
    source: str, delimiters: X12Delimiters
) -> Tuple[List[X12RawSegment], bool]:
    """Locate every segment in the interchange text.

    Segments are taken between terminators, trimmed of the whitespace that separates them in a
    line-broken file, and reported with the offset and length of what remains — so
    ``source[offset:offset + length]`` is the segment and nothing else, whether the file puts one
    segment per line or the whole interchange on one.

    Args:
        source: The interchange text.
        delimiters: The delimiters :func:`detect_delimiters` read from its header.

    Returns:
        ``(segments, complete)``. ``complete`` is ``False`` when the scan stopped at
        :data:`MAX_SCANNED_SEGMENTS`, so a caller can say the tail carries no positions rather than
        implying the file ended there.
    """
    segments: List[X12RawSegment] = []
    terminator = delimiters.segment
    length = len(source)
    cursor = _isa_start(source)
    if cursor < 0:
        return [], True
    # Newline offsets, so a segment's line is one binary search rather than a re-count of the
    # source: a single-line interchange and a line-broken one then cost the same.
    line_starts = _line_starts(source)

    while cursor < length:
        end = source.find(terminator, cursor)
        raw_end = length if end < 0 else end
        text = source[cursor:raw_end]
        lead = len(text) - len(text.lstrip())
        body = text.strip()
        if body:
            if len(segments) >= MAX_SCANNED_SEGMENTS:
                return segments, False
            offset = cursor + lead
            line, column = _position_of(line_starts, offset)
            segment_id = body.split(delimiters.element, 1)[0].strip().upper()
            segments.append(
                X12RawSegment(
                    segment_id=segment_id,
                    ordinal=len(segments),
                    offset=offset,
                    length=len(body),
                    line=line,
                    column=column,
                    text=body,
                )
            )
        if end < 0:
            break
        cursor = end + len(terminator)

    return segments, True


def _line_starts(source: str) -> List[int]:
    """Return the offset of every line start, first line included.

    Args:
        source: The interchange text.

    Returns:
        Ascending offsets; ``[0]`` for text with no line breaks. ``\\r\\n`` yields one entry, so a
        DOS-terminated file does not report twice the lines it has.
    """
    starts = [0]
    index = 0
    length = len(source)
    while index < length:
        char = source[index]
        if char == "\r":
            index += 2 if source[index + 1 : index + 2] == "\n" else 1
            starts.append(index)
        elif char == "\n":
            index += 1
            starts.append(index)
        else:
            index += 1
    return starts


def _position_of(line_starts: Sequence[int], offset: int) -> Tuple[int, int]:
    """Convert an offset into a 1-based ``(line, column)``.

    Args:
        line_starts: Ascending line-start offsets from :func:`_line_starts`.
        offset: The 0-based character offset.

    Returns:
        The 1-based line and column.
    """
    low, high = 0, len(line_starts) - 1
    while low < high:
        middle = (low + high + 1) // 2
        if line_starts[middle] <= offset:
            low = middle
        else:
            high = middle - 1
    return low + 1, offset - line_starts[low] + 1


def split_elements(segment_text: str, delimiters: X12Delimiters) -> List[str]:
    """Split one segment into its id and its element values.

    Every position the source wrote is returned, **including the empty ones** — that is the whole
    reason this module exists. ``BEG*00*SA*PO-1**20260115`` returns six entries, the fifth of which
    is ``""``: an element that was present and empty, which is a different fact from an element
    that was never written and therefore is not in the list at all.

    Args:
        segment_text: The segment without its terminator.
        delimiters: The interchange's delimiters.

    Returns:
        ``[segment_id, element01, element02, …]``.
    """
    return segment_text.split(delimiters.element)


def split_repetitions(value: str, delimiters: X12Delimiters) -> List[str]:
    """Split one element value into its repeated occurrences.

    Args:
        value: The element's raw text.
        delimiters: The interchange's delimiters.

    Returns:
        The occurrences in order. A single-entry list when the interchange declares no repetition
        separator or the value carries none — a value is always at least one occurrence of itself.
    """
    separator = delimiters.repetition
    if not separator or separator not in value:
        return [value]
    return value.split(separator)


def split_components(value: str, delimiters: X12Delimiters) -> List[str]:
    """Split one element value into its composite components.

    Args:
        value: The element's raw text (one repetition occurrence, if it repeats).
        delimiters: The interchange's delimiters.

    Returns:
        The components in order, empty ones included; a single-entry list when the value carries no
        component separator and is therefore a simple element rather than a composite.
    """
    separator = delimiters.component
    if not separator or separator not in value:
        return [value]
    return value.split(separator)


def is_segment_id(candidate: str) -> bool:
    """Return whether ``candidate`` has the shape of an X12 segment id.

    Used to refuse an alignment against text that is not segments at all, rather than to validate
    an id against a vocabulary — the scanner knows no segment vocabulary and claims none.

    Args:
        candidate: The scanned id.

    Returns:
        True for two or three upper-case alphanumerics.
    """
    return bool(_SEGMENT_ID.match(candidate))
