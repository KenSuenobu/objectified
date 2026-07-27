"""COBOL copybook parser — MFI-22.7.

Parses COBOL copybook record layouts into a typed :class:`CobolCopybookDocument` AST using
lightweight line parsing (level numbers, ``PIC`` clauses, ``OCCURS``, and ``88`` conditions).
Syntax errors surface as :class:`CobolCopybookParseError`.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
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
    level: int
    name: str
    picture: Optional[str] = None
    usage: Optional[str] = None
    occurs_min: Optional[int] = None
    occurs_max: Optional[int] = None
    depending_on: Optional[str] = None
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
    match = _OCCURS_RE.search(remainder)
    if not match:
        return None, None, None
    return int(match.group(1)), int(match.group(2)), match.group(3)


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
    entries: List[CobolField] = []
    for line in content.splitlines():
        effective = _effective_line(line)
        if not effective:
            continue
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
            )
        )
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
        "conditions": [
            {"name": condition.name, "value": condition.value}
            for condition in field.conditions
        ],
        "children": [field_template(child) for child in field.children],
    }
