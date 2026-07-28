"""COBOL copybook parser — MFI-22.7.

Parses COBOL copybook record layouts into a typed :class:`CobolCopybookDocument` AST using
lightweight line parsing (level numbers, ``PIC`` clauses, ``OCCURS``, and ``88`` conditions).
Syntax errors surface as :class:`CobolCopybookParseError`.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field, replace
from typing import Dict, List, Optional, Tuple

__all__ = [
    "CobolCopybookParseError",
    "Cobol88Condition",
    "CobolField",
    "CobolCopybookDocument",
    "CopybookSourceLine",
    "is_cobolcopybook",
    "iter_definition_lines",
    "parse_cobolcopybook",
]

_PIC_RE = re.compile(
    r"PIC(?:TURE)?\s+(.+?)(?:\s+(COMP-\d+|BINARY|COMP))?(?:\.\s*)?$",
    re.IGNORECASE,
)
_OCCURS_RE = re.compile(
    r"OCCURS\s+(\d+)\s+TO\s+(\d+)\s+TIMES(?:\s+DEPENDING\s+ON\s+([\w-]+))?",
    re.IGNORECASE,
)
#: A fixed-size table — ``OCCURS 5 TIMES``, with ``TIMES`` optional as most compilers allow. Read
#: only when the variable form above did not match, so ``OCCURS 1 TO 5 TIMES`` is never mistaken for
#: a fixed table of one. A fixed table's bounds are equal, which is what makes it fixed.
_FIXED_OCCURS_RE = re.compile(r"OCCURS\s+(\d+)(?:\s+TIMES)?\b", re.IGNORECASE)
#: ``REDEFINES <name>`` — the item shares the storage of a previously declared sibling rather than
#: following it. Read here (CPDO-2.3) so the layout analysis can overlay the two; the canonical
#: model's union representation is #3991's, and normalization is deliberately unchanged by this.
_REDEFINES_RE = re.compile(r"\bREDEFINES\s+([\w-]+)", re.IGNORECASE)
_FIELD_RE = re.compile(r"^(\d{2})\s+([\w-]+)\.?(?:\s+(.*))?$")
_CONDITION_RE = re.compile(
    r"^88\s+([\w-]+)\s+VALUE\s+(.+?)\.?\s*$",
    re.IGNORECASE,
)


class CobolCopybookParseError(ValueError):
    """Raised when COBOL copybook text cannot be parsed."""


@dataclass(frozen=True)
class Cobol88Condition:
    name: str
    value: str


@dataclass
class CobolField:
    """One data-definition entry.

    Attributes:
        level: COBOL level number.
        name: The data name as declared.
        picture: The PICTURE character-string, without the ``PIC`` keyword.
        usage: The USAGE clause (``COMP-3``, ``BINARY``, …), upper-cased.
        occurs_min: Minimum occurrences. Equal to ``occurs_max`` for a fixed table.
        occurs_max: Maximum occurrences.
        depending_on: The ODO controller named by ``DEPENDING ON``.
        redefines: The name of the sibling whose storage this item redefines (CPDO-2.3). ``None``
            for an ordinary item — the two are different facts, so an item that redefines nothing
            carries nothing rather than its own name.
        conditions: 88-level condition names declared under this item.
        children: Subordinate items.
    """

    level: int
    name: str
    picture: Optional[str] = None
    usage: Optional[str] = None
    occurs_min: Optional[int] = None
    occurs_max: Optional[int] = None
    depending_on: Optional[str] = None
    redefines: Optional[str] = None
    conditions: Tuple[Cobol88Condition, ...] = ()
    children: List["CobolField"] = field(default_factory=list)


@dataclass(frozen=True)
class CobolCopybookDocument:
    root: CobolField
    raw: str


@dataclass(frozen=True)
class CopybookSourceLine:
    """One data-definition line, with the source line it came from — CPDO-1.2 (#4795).

    The parsed :class:`CobolField` tree deliberately carries no positions: a normalizer has no use
    for them. A *payload analysis* does — pointing a reader at the line a PICTURE clause came from is
    most of what makes a copybook record navigable — so this is the one place the line numbers are
    recovered, by classifying source lines exactly the way :func:`_parse_flat_fields` does.

    Attributes:
        line: 1-based line number in the copybook source.
        level: COBOL level number (``88`` for a condition-name line).
        name: The data name declared on the line.
        is_condition: True for an ``88`` condition-name line, which belongs to the entry above it.
    """

    line: int
    level: int
    name: str
    is_condition: bool


def _effective_line(line: str) -> Optional[str]:
    raw = line.rstrip("\n\r")
    if not raw.strip():
        return None
    if len(raw) >= 7 and raw[6] in "*-/":
        return None
    # Fixed-format copybooks: columns 1-6 sequence, column 7 indicator, 8-72 code.
    if len(raw) >= 8 and (raw[:6].isspace() or raw[:6].strip().isdigit()):
        content = raw[7:72].strip()
    else:
        content = raw.strip()
    if not content or content.startswith("*"):
        return None
    return content


def is_cobolcopybook(content: str) -> bool:
    """Return ``True`` when ``content`` looks like a COBOL copybook."""
    if not content or not isinstance(content, str):
        return False
    if not content.strip():
        return False
    if content.lstrip().startswith("{") or content.lstrip().startswith("MSH|"):
        return False
    has_level_01 = False
    has_pic = False
    for line in content.splitlines():
        effective = _effective_line(line)
        if not effective:
            continue
        if _CONDITION_RE.match(effective):
            continue
        match = _FIELD_RE.match(effective)
        if not match:
            continue
        level = int(match.group(1))
        remainder = (match.group(3) or "").strip()
        if level == 1:
            has_level_01 = True
        if _PIC_RE.search(remainder) or _PIC_RE.search(effective):
            has_pic = True
    return has_level_01 and has_pic


def _parse_picture(remainder: str) -> tuple[Optional[str], Optional[str]]:
    match = _PIC_RE.search(remainder)
    if not match:
        return None, None
    picture = match.group(1).strip().rstrip(".")
    usage = match.group(2).upper() if match.group(2) else None
    return picture, usage


def _parse_occurs(remainder: str) -> tuple[Optional[int], Optional[int], Optional[str]]:
    """Read the OCCURS bounds and any DEPENDING ON controller from one entry's clause text.

    Args:
        remainder: The entry text after its level and name.

    Returns:
        ``(occurs_min, occurs_max, depending_on)``. A fixed table (``OCCURS 5 TIMES``) reports equal
        bounds and no controller; an item with no OCCURS reports three ``None``\\s, which is a
        different fact from a table of one and is kept as one.
    """
    match = _OCCURS_RE.search(remainder)
    if match:
        return int(match.group(1)), int(match.group(2)), match.group(3)
    fixed = _FIXED_OCCURS_RE.search(remainder)
    if fixed:
        count = int(fixed.group(1))
        return count, count, None
    return None, None, None


def _parse_redefines(remainder: str) -> Optional[str]:
    """Read the name this entry redefines, if it redefines one.

    Args:
        remainder: The entry text after its level and name.

    Returns:
        The redefined data name, or ``None``.
    """
    match = _REDEFINES_RE.search(remainder)
    return match.group(1) if match else None


def iter_definition_lines(content: str) -> List[CopybookSourceLine]:
    """Return every data-definition line in ``content``, in source order.

    Classifies lines with the same helpers :func:`_parse_flat_fields` uses — the fixed-format column
    handling, the condition-name pattern, then the field pattern — so the entries line up one-for-one
    with the fields the parser produced. Lines that are comments, blank, or not definitions are
    skipped, exactly as the parser skips them.

    Args:
        content: The copybook source text.

    Returns:
        The definition lines in source order.
    """
    lines: List[CopybookSourceLine] = []
    for number, line in enumerate(content.splitlines(), start=1):
        effective = _effective_line(line)
        if not effective:
            continue
        condition = _CONDITION_RE.match(effective)
        if condition:
            lines.append(
                CopybookSourceLine(
                    line=number, level=88, name=condition.group(1), is_condition=True
                )
            )
            continue
        match = _FIELD_RE.match(effective)
        if not match:
            continue
        lines.append(
            CopybookSourceLine(
                line=number,
                level=int(match.group(1)),
                name=match.group(2),
                is_condition=False,
            )
        )
    return lines


def _parse_flat_fields(content: str) -> List[CobolField]:
    """Read every data-definition entry in ``content``, in source order.

    A COBOL data-description entry ends at a period, not at a line break, so an entry's clauses may
    continue onto following lines::

        05  CUST-PHONES OCCURS 1 TO 5 TIMES
                       DEPENDING ON CUST-PHONE-COUNT.

    A line that declares no level number and no condition name is therefore a **continuation** of the
    entry above it: it is joined onto that entry's clause text and the clauses are re-read from the
    whole. Before CPDO-2.3 such a line was skipped, which silently lost the ``DEPENDING ON``
    controller of any table that declared it on a second line.

    Args:
        content: The copybook source text.

    Returns:
        The entries, flat and in source order — :func:`_build_tree` gives them their nesting.
    """
    entries: List[CobolField] = []
    # The clause text of the entry currently open, so a continuation line can be joined onto it.
    # Reset whenever an entry is completed by a period or a new entry begins.
    open_remainder: Optional[str] = None

    for line in content.splitlines():
        effective = _effective_line(line)
        if not effective:
            continue
        if (
            open_remainder is not None
            and entries
            and not _CONDITION_RE.match(effective)
            and not _FIELD_RE.match(effective)
        ):
            # A continuation: re-read the clauses over the joined text, so a clause split across
            # lines is read as the one clause it is.
            joined = f"{open_remainder} {effective}".strip()
            previous = entries[-1]
            picture, usage = _parse_picture(joined)
            occurs_min, occurs_max, depending_on = _parse_occurs(joined)
            entries[-1] = replace(
                previous,
                picture=picture if picture is not None else previous.picture,
                usage=usage if usage is not None else previous.usage,
                occurs_min=occurs_min if occurs_min is not None else previous.occurs_min,
                occurs_max=occurs_max if occurs_max is not None else previous.occurs_max,
                depending_on=depending_on if depending_on is not None else previous.depending_on,
                redefines=_parse_redefines(joined) or previous.redefines,
            )
            open_remainder = None if joined.rstrip().endswith(".") else joined
            continue

        open_remainder = None
        condition_match = _CONDITION_RE.match(effective)
        if condition_match:
            if not entries:
                continue
            previous = entries[-1]
            entries[-1] = CobolField(
                level=previous.level,
                name=previous.name,
                picture=previous.picture,
                usage=previous.usage,
                occurs_min=previous.occurs_min,
                occurs_max=previous.occurs_max,
                depending_on=previous.depending_on,
                redefines=previous.redefines,
                conditions=previous.conditions
                + (Cobol88Condition(condition_match.group(1), condition_match.group(2).strip("'\""),),),
                children=list(previous.children),
            )
            continue
        match = _FIELD_RE.match(effective)
        if not match:
            continue
        level = int(match.group(1))
        name = match.group(2)
        remainder = (match.group(3) or "").strip()
        picture, usage = _parse_picture(remainder)
        occurs_min, occurs_max, depending_on = _parse_occurs(remainder)
        entries.append(
            CobolField(
                level=level,
                name=name,
                picture=picture,
                usage=usage,
                occurs_min=occurs_min,
                occurs_max=occurs_max,
                depending_on=depending_on,
                redefines=_parse_redefines(remainder),
            )
        )
        # The entry stays open for continuation lines until a period closes it.
        open_remainder = None if effective.rstrip().endswith(".") else remainder
    return entries


def _build_tree(entries: List[CobolField]) -> CobolField:
    if not entries:
        raise CobolCopybookParseError("No COBOL data definitions found")
    root = entries[0]
    if root.level != 1:
        raise CobolCopybookParseError("COBOL copybook must begin with a level-01 group item")
    stack: List[CobolField] = [root]
    for entry in entries[1:]:
        while len(stack) > 1 and stack[-1].level >= entry.level:
            stack.pop()
        stack[-1].children.append(entry)
        stack.append(entry)
    return root


def parse_cobolcopybook(content: str, *, source_label: Optional[str] = None) -> CobolCopybookDocument:
    """Parse COBOL copybook source into a :class:`CobolCopybookDocument`."""
    if not content or not content.strip():
        raise CobolCopybookParseError("Invalid or empty COBOL copybook content")
    if not is_cobolcopybook(content):
        raise CobolCopybookParseError("Content does not appear to be a COBOL copybook")

    entries = _parse_flat_fields(content)
    if not entries:
        label = f" ({source_label})" if source_label else ""
        raise CobolCopybookParseError(f"No COBOL data definitions found{label}")

    root = _build_tree(entries)
    return CobolCopybookDocument(root=root, raw=content)


def field_template(field: CobolField) -> Dict[str, object]:
    """Serialize a :class:`CobolField` for round-trip extras."""
    return {
        "level": field.level,
        "name": field.name,
        "picture": field.picture,
        "usage": field.usage,
        "occurs_min": field.occurs_min,
        "occurs_max": field.occurs_max,
        "depending_on": field.depending_on,
        "redefines": field.redefines,
        "conditions": [
            {"name": condition.name, "value": condition.value}
            for condition in field.conditions
        ],
        "children": [field_template(child) for child in field.children],
    }
