"""COBOL copybook storage layout — CPDO-2.3 (#4799).

A copybook is a *positional* description. ``PIC S9(9)V99 COMP-3`` does not merely say "a number
with two decimal places": it says six bytes, packed two digits per byte with a sign nibble, and the
field after it starts six bytes further into the record. That arithmetic is what makes a copybook a
record layout rather than a list of names, and it is the half a normalized field list cannot hold.

This module is that arithmetic, and nothing else — no parsing, no analysis document, no I/O. It
takes the :class:`~app.cobolcopybook_parser.CobolField` tree the parser produced and returns one
:class:`FieldLayout` per item: how many bytes it occupies, where it starts, and — the part that
matters more — **whether either of those is actually knowable**.

What it refuses to do
---------------------
Three situations make an offset or a length unknowable, and every one of them is reported as
unknown rather than filled in with a plausible number:

``an unreadable PICTURE``
    A picture this module does not understand sizes to nothing. The item's length is unknown, and so
    is the length of every group containing it and the offset of every item after it.

``a variable-length table``
    ``OCCURS 1 TO 10 TIMES DEPENDING ON`` makes the record's length a *range*. Items after such a
    table have no single offset — where they start depends on a value that only exists at runtime —
    so their offset is reported as **variable**, with the range it spans, and never as its minimum.

``an item with neither PICTURE nor children``
    Nothing to size. It is not assumed to be zero bytes.

Assumptions, declared rather than asserted
------------------------------------------
Storage arithmetic is only true under an encoding and a compiler's representation choices, and this
module cannot observe either — the copybook does not state them and the analysis has no runtime data
to infer them from. :data:`LAYOUT_ASSUMPTIONS` names each one, and the caller publishes them as
capability/provenance so a reader sees a computed length as *conditional*, which is what it is.

.. code-block:: text

    01 PAYMENT-RECORD                       offset 1   len 55
      05 PAYMENT-ID       PIC 9(10)         offset 1   len 10
      05 PAYMENT-TYPE     PIC X(1)          offset 11  len 1
      05 PAYMENT-AMOUNT   PIC S9(9)V99 C-3  offset 12  len 6
      05 PAYMENT-DETAIL   PIC X(30)         offset 18  len 30
      05 CARD-DETAIL      REDEFINES         offset 18  len 30   ← same storage
      05 BANK-DETAIL      REDEFINES         offset 18  len 30   ← same storage
      05 PAYMENT-POSTED-DATE PIC 9(8)       offset 48  len 8
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

from .cobolcopybook_parser import CobolField

__all__ = [
    "BASIS_BINARY",
    "BASIS_DISPLAY",
    "BASIS_FLOAT",
    "BASIS_PACKED",
    "LAYOUT_ASSUMPTIONS",
    "FieldLayout",
    "PictureSize",
    "compute_layout",
    "picture_size",
]

#: The assumptions every computed length in this module rests on. Published by the analyzer as
#: capability/provenance, never as a property of the customer's data: the copybook states none of
#: them, so a length is only true where they hold.
LAYOUT_ASSUMPTIONS: Tuple[str, ...] = (
    "One byte per character position — a single-byte encoding (EBCDIC or ASCII). DBCS and "
    "national (PIC N / USAGE NATIONAL) items are not sized.",
    "COMP-3 items are packed two digits per byte with a trailing sign nibble, so a picture of "
    "n digits occupies (n div 2) + 1 bytes whether or not it is signed.",
    "COMP / COMP-4 / BINARY items occupy 2, 4 or 8 bytes by digit count, the common IBM "
    "representation; a compiler set to allocate by truncation rules may differ.",
    "A sign is assumed to be overpunched on the trailing digit rather than held in its own byte, "
    "because SIGN IS SEPARATE is not read by the parser.",
    "No SYNCHRONIZED alignment is applied, so no slack bytes are inserted between items.",
)

#: What a computed byte count is derived from. Reported per item so a reader can see *why* a length
#: is what it is, rather than being handed a number with no basis.
BASIS_DISPLAY = "display"
BASIS_PACKED = "packed"
BASIS_BINARY = "binary"
BASIS_FLOAT = "float"

#: USAGE clauses that mean packed decimal.
_PACKED_USAGES = frozenset({"COMP-3", "COMPUTATIONAL-3", "PACKED-DECIMAL"})
#: USAGE clauses that mean a binary integer.
_BINARY_USAGES = frozenset({"COMP", "COMP-4", "COMPUTATIONAL", "COMPUTATIONAL-4", "BINARY"})
#: USAGE clauses that mean a floating-point item, with their fixed widths.
_FLOAT_USAGES: Dict[str, int] = {
    "COMP-1": 4,
    "COMPUTATIONAL-1": 4,
    "COMP-2": 8,
    "COMPUTATIONAL-2": 8,
}

#: Binary width by digit count, the common IBM allocation. Declared in :data:`LAYOUT_ASSUMPTIONS`.
_BINARY_WIDTHS: Tuple[Tuple[int, int], ...] = ((4, 2), (9, 4), (18, 8))

#: One PICTURE symbol group: a character, optionally repeated by a ``(n)`` count.
_PICTURE_SYMBOL = re.compile(r"(?P<symbol>[A-Za-z9/,.+\-*$])(?:\((?P<count>\d+)\))?")

#: PICTURE symbols that occupy a character position each. ``S`` and ``V`` do not: ``S`` is an
#: overpunched sign and ``V`` is an *implied* decimal point, which is why a copybook can describe a
#: decimal value in fewer bytes than it has characters.
_SIZED_SYMBOLS = frozenset("9XAZ0/,.+-*$BEGP")
#: Symbols that contribute a decimal digit.
_DIGIT_SYMBOLS = frozenset("9Z*")


@dataclass(frozen=True)
class PictureSize:
    """What one PICTURE/USAGE pair says about storage.

    Attributes:
        length: Bytes occupied, or ``None`` when the picture could not be read.
        digits: Total decimal digit positions, or ``None`` for a non-numeric item.
        decimals: Digit positions after the implied decimal point (``V``), or ``None``.
        signed: True when the picture carries ``S``.
        basis: Which of :data:`BASIS_DISPLAY` / :data:`BASIS_PACKED` / :data:`BASIS_BINARY` /
            :data:`BASIS_FLOAT` the byte count was derived from, or ``None`` when unknown.
        reason: Why the length is unknown, when it is. ``None`` when it is known — the two are
            never both set, so a caller cannot render a reason beside a number.
    """

    length: Optional[int]
    digits: Optional[int]
    decimals: Optional[int]
    signed: bool
    basis: Optional[str]
    reason: Optional[str] = None


@dataclass(frozen=True)
class FieldLayout:
    """Where one copybook item sits, and how much room it takes.

    Attributes:
        offset: 1-based byte offset of the item's first occurrence within the record, or ``None``
            when no single offset exists (see :attr:`offset_variable`) or an earlier item's size is
            unknown.
        length: Bytes for **one** occurrence, or ``None`` when unknown.
        total_length: Bytes for every occurrence — ``length`` times the maximum occurrence count.
            Equal to ``length`` for a non-table item.
        min_total_length: Bytes at the *minimum* occurrence count, which is what makes a record
            carrying a variable table a length range rather than a number.
        offset_variable: True when the item follows a variable-length table, so its real offset
            depends on a runtime value. The recorded ``offset`` is then ``None`` — a minimum offset
            rendered as *the* offset is the single most misleading thing this module could emit.
        variable: True when the item itself, or anything inside it, is a variable-length table.
        picture: The :class:`PictureSize` for an elementary item; ``None`` for a group.
        redefines: The sibling name whose storage this item shares.
        reason: Why the length is unknown, when it is.
    """

    offset: Optional[int]
    length: Optional[int]
    total_length: Optional[int]
    min_total_length: Optional[int]
    offset_variable: bool
    variable: bool
    picture: Optional[PictureSize]
    redefines: Optional[str]
    reason: Optional[str] = None


def _normalize_usage(usage: Optional[str]) -> str:
    """Return a USAGE clause upper-cased and hyphen-normalised, or ``""`` when absent."""
    return (usage or "").strip().upper().replace("_", "-")


def _read_symbols(picture: str) -> Tuple[int, int, int, bool, bool]:
    """Walk a PICTURE character-string once.

    Args:
        picture: The picture text, without the ``PIC`` keyword.

    Returns:
        ``(positions, digits, decimals, signed, understood)``. ``understood`` is False when the
        string carried a symbol this module does not size, which is what stops an unfamiliar picture
        from being silently rounded down to the part that happened to parse.
    """
    text = picture.strip().upper().rstrip(".")
    positions = digits = decimals = 0
    signed = False
    after_v = False
    understood = bool(text)
    index = 0

    while index < len(text):
        if text[index] == "S":
            signed = True
            index += 1
            continue
        if text[index] == "V":
            after_v = True
            index += 1
            continue
        match = _PICTURE_SYMBOL.match(text, index)
        if not match:
            understood = False
            index += 1
            continue
        symbol = match.group("symbol")
        count = int(match.group("count") or 1)
        if symbol not in _SIZED_SYMBOLS:
            # A symbol this module has no width for — most importantly ``N`` (national/DBCS), whose
            # width depends on an encoding the copybook does not state.
            understood = False
        else:
            positions += count
            if symbol in _DIGIT_SYMBOLS:
                digits += count
                if after_v:
                    decimals += count
        index = match.end()

    return positions, digits, decimals, signed, understood


def picture_size(picture: Optional[str], usage: Optional[str]) -> PictureSize:
    """Size one elementary item from its PICTURE and USAGE.

    Args:
        picture: The picture character-string, or ``None``.
        usage: The USAGE clause, or ``None`` (which means ``DISPLAY``).

    Returns:
        The :class:`PictureSize`. An item this module cannot size returns ``length=None`` **with a
        stated reason** rather than a zero — a zero-length field would silently shift every offset
        after it, which is exactly the failure this whole module exists to avoid.
    """
    normalized_usage = _normalize_usage(usage)

    if normalized_usage in _FLOAT_USAGES:
        # COMP-1/COMP-2 are fixed-width floating point; a PICTURE is not permitted on them, so the
        # width comes from the usage alone and no digit count is claimed.
        return PictureSize(
            length=_FLOAT_USAGES[normalized_usage],
            digits=None,
            decimals=None,
            signed=False,
            basis=BASIS_FLOAT,
        )

    if not picture or not picture.strip():
        return PictureSize(
            length=None,
            digits=None,
            decimals=None,
            signed=False,
            basis=None,
            reason="The item declares no PICTURE, so it has no size this analysis can compute.",
        )

    positions, digits, decimals, signed, understood = _read_symbols(picture)
    if not understood or positions == 0:
        return PictureSize(
            length=None,
            digits=digits or None,
            decimals=decimals or None,
            signed=signed,
            basis=None,
            reason=(
                f"The PICTURE {picture.strip()!r} uses a symbol this analysis does not size, so its "
                "storage length is not computed."
            ),
        )

    if normalized_usage in _PACKED_USAGES:
        if digits == 0:
            return PictureSize(
                length=None,
                digits=None,
                decimals=None,
                signed=signed,
                basis=None,
                reason=(
                    f"The PICTURE {picture.strip()!r} declares no digit positions, so a packed-"
                    "decimal length cannot be computed for it."
                ),
            )
        return PictureSize(
            length=digits // 2 + 1,
            digits=digits,
            decimals=decimals,
            signed=signed,
            basis=BASIS_PACKED,
        )

    if normalized_usage in _BINARY_USAGES:
        if digits == 0:
            return PictureSize(
                length=None,
                digits=None,
                decimals=None,
                signed=signed,
                basis=None,
                reason=(
                    f"The PICTURE {picture.strip()!r} declares no digit positions, so a binary "
                    "length cannot be computed for it."
                ),
            )
        for ceiling, width in _BINARY_WIDTHS:
            if digits <= ceiling:
                return PictureSize(
                    length=width,
                    digits=digits,
                    decimals=decimals,
                    signed=signed,
                    basis=BASIS_BINARY,
                )
        return PictureSize(
            length=None,
            digits=digits,
            decimals=decimals,
            signed=signed,
            basis=None,
            reason=(
                f"The PICTURE {picture.strip()!r} declares {digits} digits, more than a binary item "
                "holds, so no length is computed."
            ),
        )

    if normalized_usage and normalized_usage != "DISPLAY":
        return PictureSize(
            length=None,
            digits=digits or None,
            decimals=decimals or None,
            signed=signed,
            basis=None,
            reason=(
                f"USAGE {normalized_usage} is not one this analysis sizes, so the item's storage "
                "length is not computed."
            ),
        )

    return PictureSize(
        length=positions,
        digits=digits or None,
        decimals=decimals or None,
        signed=signed,
        basis=BASIS_DISPLAY,
    )


def _occurrence_bounds(field: CobolField) -> Tuple[int, int, bool]:
    """Return ``(minimum, maximum, variable)`` occurrence counts for one item.

    Args:
        field: The parsed item.

    Returns:
        ``(1, 1, False)`` for an item with no OCCURS; the declared bounds otherwise, with
        ``variable`` true only when they differ. A fixed table (``OCCURS 5 TIMES``) is *not*
        variable: its length is a number, not a range.
    """
    maximum = field.occurs_max
    if maximum is None:
        return 1, 1, False
    minimum = field.occurs_min if field.occurs_min is not None else maximum
    return minimum, maximum, minimum != maximum


def _multiply(length: Optional[int], count: int) -> Optional[int]:
    """Multiply a possibly-unknown length by an occurrence count, keeping unknown unknown."""
    return None if length is None else length * count


def compute_layout(root: CobolField) -> Dict[int, FieldLayout]:
    """Compute every item's offset and length within one record.

    The walk is a single depth-first pass in source order, carrying a byte cursor. Three rules do
    all the work:

    * an item's length is its PICTURE's, or — for a group — the sum of its children's;
    * a **REDEFINES** item starts where the item it redefines started and does **not** advance the
      cursor, because it is the same storage described a second way;
    * a variable-length table advances the cursor by an amount that is not a number, so everything
      after it has a *range* of offsets rather than an offset, and is recorded as having none.

    Args:
        root: The level-01 item.

    Returns:
        ``id(field) → FieldLayout`` for every item in the tree, including the root. Keying by object
        identity rather than by name is deliberate: copybook names repeat (``FILLER`` most of all),
        and two items with one name have two different offsets.
    """
    layouts: Dict[int, FieldLayout] = {}

    def walk(field: CobolField, start: Optional[int], *, offset_variable: bool) -> FieldLayout:
        """Lay out one item at ``start``, recording it and everything under it.

        Args:
            field: The item.
            start: Its 1-based offset, or ``None`` when no single offset exists.
            offset_variable: Whether ``start`` is unknowable because a variable table precedes it.

        Returns:
            The item's layout.
        """
        minimum, maximum, table_is_variable = _occurrence_bounds(field)

        if field.children:
            single, min_single, children_variable, reason = _lay_out_children(
                field, start, offset_variable=offset_variable
            )
            size: Optional[PictureSize] = None
        else:
            size = picture_size(field.picture, field.usage)
            single = size.length
            min_single = size.length
            children_variable = False
            reason = size.reason

        layout = FieldLayout(
            offset=None if offset_variable else start,
            length=single,
            total_length=_multiply(single, maximum),
            min_total_length=_multiply(min_single, minimum),
            offset_variable=offset_variable,
            variable=table_is_variable or children_variable,
            picture=size,
            redefines=field.redefines,
            reason=reason,
        )
        layouts[id(field)] = layout
        return layout

    def _lay_out_children(
        field: CobolField, start: Optional[int], *, offset_variable: bool
    ) -> Tuple[Optional[int], Optional[int], bool, Optional[str]]:
        """Lay out one group's children, returning the group's own size.

        Returns:
            ``(length, min_length, variable, reason)`` for a single occurrence of the group.
        """
        # Offsets of already-placed siblings, so a REDEFINES can start where its target started.
        placed: Dict[str, Tuple[Optional[int], bool]] = {}
        cursor = start
        cursor_variable = offset_variable
        total: Optional[int] = 0
        min_total: Optional[int] = 0
        variable = False
        reason: Optional[str] = None

        for child in field.children:
            if child.redefines:
                # Same storage, described again: start where the target started and leave the
                # cursor alone. A target this group does not declare leaves the item unplaced
                # rather than placed at the cursor, which would be a different item's storage.
                target_offset, target_variable = placed.get(child.redefines, (None, True))
                walk(child, target_offset, offset_variable=target_variable)
                continue

            child_layout = walk(child, cursor, offset_variable=cursor_variable)
            placed[child.name] = (child_layout.offset, cursor_variable)

            if child_layout.variable:
                variable = True
            if child_layout.reason is not None and reason is None:
                reason = child_layout.reason

            total = (
                None
                if total is None or child_layout.total_length is None
                else total + child_layout.total_length
            )
            min_total = (
                None
                if min_total is None or child_layout.min_total_length is None
                else min_total + child_layout.min_total_length
            )

            if child_layout.variable:
                # Everything after a variable table has a range of offsets rather than an offset.
                cursor = None
                cursor_variable = True
            elif cursor is not None and child_layout.total_length is not None:
                cursor += child_layout.total_length
            else:
                cursor = None
                cursor_variable = cursor_variable or child_layout.total_length is None

        if total is None and reason is None:
            reason = "A subordinate item's storage length is unknown, so this group's is too."
        return total, min_total, variable, reason

    walk(root, 1, offset_variable=False)
    return layouts


def record_length_range(layout: FieldLayout) -> Tuple[Optional[int], Optional[int]]:
    """Return one record's ``(minimum, maximum)`` byte length.

    Args:
        layout: The level-01 item's layout.

    Returns:
        The two lengths, equal for a fixed-length record. Either may be ``None`` when an item's
        storage could not be computed — an unknown length is never reported as a bound.
    """
    return layout.min_total_length, layout.total_length


def resolve_odo_controllers(root: CobolField) -> Dict[str, bool]:
    """Check that each ``DEPENDING ON`` names an item this copybook declares.

    A controller the copybook does not declare is not necessarily an error — it may live in a
    surrounding copybook this one is copied into — but it is a fact a reader needs, because the
    table's bounds cannot be reasoned about from this file alone.

    Args:
        root: The level-01 item.

    Returns:
        ``controller name → whether an item of that name is declared in this copybook``.
    """
    names: set[str] = set()
    controllers: List[str] = []

    def collect(field: CobolField) -> None:
        names.add(field.name)
        if field.depending_on:
            controllers.append(field.depending_on)
        for child in field.children:
            collect(child)

    collect(root)
    return {controller: controller in names for controller in controllers}
