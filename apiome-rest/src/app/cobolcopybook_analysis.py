"""COBOL copybook native-analysis extractor — CPDO-1.2 (#4795).

A copybook normalizes into records and fields with types, which is what a canonical model can hold
and roughly half of what a copybook says. The level numbers that give a record its shape, the
PICTURE clauses that give a field its storage, the USAGE that says how it is encoded, the OCCURS
bounds and their DEPENDING ON control field, the 88-level condition names that enumerate a field's
meaningful values — all of it is derived at import and then exists nowhere.

This extractor keeps it, in the copybook's own vocabulary:

.. code-block:: text

    record            01 CUSTOMER-RECORD
      group           05 CUSTOMER-NAME
        field         10 FIRST-NAME  PIC X(20)
      field           05 STATUS      PIC X
        condition     88 ACTIVE      VALUE 'A'

Source lines
------------
The parsed tree carries no positions, so line numbers are recovered from the source by
:func:`~app.cobolcopybook_parser.iter_definition_lines` and matched to fields by name, in order — a
name that repeats (``FILLER``, most often) resolves to its occurrences in the order the source
declared them. A field the match cannot place keeps its structural location and loses only its line,
which is the honest degradation: a wrong line number would be worse than none.

Constructs this extractor does not model
----------------------------------------
:mod:`app.cobolcopybook_parser` reads level numbers, PICTURE, USAGE, OCCURS and 88-conditions. It
does not read ``REDEFINES``, ``RENAMES``, ``COPY … REPLACING`` or ``VALUE`` clauses on ordinary
fields, and it reads a clause only as far as its first source line — and a copybook using any of
those is not a copybook this analysis fully describes. Rather than let that surface as a mysteriously
missing field, the source is scanned for those keywords and each one found is recorded as a warning,
which makes the record ``partial`` with a stated reason. A copybook that uses none of them is
``available``, and means it. The rest — the limits with no keyword to scan for — are named in the
record's capability declaration.
"""

from __future__ import annotations

import re
from collections import deque
from typing import Deque, Dict, List, Optional, Tuple

from .cobolcopybook_parser import (
    Cobol88Condition,
    CobolCopybookDocument,
    CobolField,
    iter_definition_lines,
)
from .payload_analysis import (
    MAX_TREE_DEPTH,
    MAX_TREE_NODES,
    SEVERITY_WARNING,
    AnalysisWarning,
    AnalyzerCapabilities,
    AnalyzerInfo,
    PayloadAnalysisDocument,
    SourceLocation,
    analyzer_capabilities,
)
from .payload_analyzer import NativeNode, analysis_limits, build_analysis_document

__all__ = [
    "COBOL_ANALYZER_KEY",
    "COBOL_ANALYZER_VERSION",
    "KIND_CONDITION",
    "KIND_FIELD",
    "KIND_GROUP",
    "KIND_RECORD",
    "UNMODELLED_CLAUSES",
    "analyze_cobolcopybook",
    "cobolcopybook_capabilities",
    "cobolcopybook_tool_versions",
]

#: Analyzer key recorded on every record this module produces.
COBOL_ANALYZER_KEY = "cobolcopybook"
#: Version of this extractor. Bump when the emitted tree changes shape.
COBOL_ANALYZER_VERSION = "1.0.0"
#: Version of the in-repo copybook parser the extractor reads through, recorded as a tool version so
#: a parser change is visible on records produced after it.
COBOL_PARSER_VERSION = "1.0.0"

#: Node kinds, in nesting order. ``record`` is the level-01 item, ``group`` any item with children,
#: ``field`` an elementary item, ``condition`` an 88-level condition name.
KIND_RECORD = "record"
KIND_GROUP = "group"
KIND_FIELD = "field"
KIND_CONDITION = "condition"

#: Clauses the parser behind this extractor does not read, and the capability key each maps to. A
#: copybook containing one is analysed as far as the parser understands it and says so — the
#: alternative is a field silently missing from the record with nothing to explain it.
UNMODELLED_CLAUSES: Tuple[Tuple[str, str, str], ...] = (
    (
        r"\bREDEFINES\b",
        "copybook.redefines",
        "REDEFINES clauses are not modelled; the redefining and redefined items are described as "
        "independent fields.",
    ),
    (
        r"^\s*66\s+",
        "copybook.renames_66",
        "RENAMES (level 66) items are not modelled.",
    ),
    (
        r"\bCOPY\s+[\w-]+",
        "copybook.copy_statement",
        "Nested COPY statements are not expanded; the copied members are not part of this analysis.",
    ),
    (
        r"\bREPLACING\b",
        "copybook.copy_replacing",
        "COPY … REPLACING substitutions are not applied.",
    ),
)

#: Compiled once: the scan runs over every line of every imported copybook.
_UNMODELLED_PATTERNS: Tuple[Tuple[re.Pattern, str, str], ...] = tuple(
    (re.compile(pattern, re.IGNORECASE | re.MULTILINE), code, message)
    for pattern, code, message in UNMODELLED_CLAUSES
)


def cobolcopybook_tool_versions() -> Dict[str, str]:
    """Return the parser versions behind a copybook analysis.

    Returns:
        ``{"cobolcopybook_parser": <version>}`` — the in-repo parser whose reading of the copybook
        the record describes.
    """
    return {"cobolcopybook_parser": COBOL_PARSER_VERSION}


def cobolcopybook_capabilities() -> AnalyzerCapabilities:
    """Return what this extractor models, and what it knowingly does not.

    Returns:
        The :class:`~app.payload_analysis.AnalyzerCapabilities` for a copybook analysis.
    """
    return analyzer_capabilities(
        supported=[
            "copybook.level_numbers",
            "copybook.group_items",
            "copybook.elementary_items",
            "copybook.picture_clauses",
            "copybook.usage_clauses",
            "copybook.occurs_bounds",
            "copybook.occurs_depending_on",
            "copybook.condition_names_88",
            "copybook.source_lines",
        ],
        unsupported=[
            "copybook.redefines",
            "copybook.renames_66",
            "copybook.copy_statement",
            "copybook.copy_replacing",
            # VALUE on an ordinary field is not read (only on 88-level condition names).
            "copybook.value_clauses",
            "copybook.sign_and_synchronized_clauses",
            # A clause continued onto the following source line is read only as far as the first
            # line goes, so e.g. a DEPENDING ON split across lines is not picked up.
            "copybook.multi_line_clauses",
            # Storage sizes are not computed from PICTURE/USAGE.
            "copybook.computed_storage_length",
        ],
        limits=analysis_limits(),
    )


class _LineIndex:
    """Resolves a definition name to the source line it was declared on.

    One FIFO queue per name, consumed in traversal order — which is source order — so a copybook
    with three ``FILLER``\\s resolves each to its own line instead of all three to the first.
    """

    def __init__(self, content: str) -> None:
        """Build the index from copybook source.

        Args:
            content: The copybook source text.
        """
        self._fields: Dict[str, Deque[int]] = {}
        self._conditions: Dict[str, Deque[int]] = {}
        for entry in iter_definition_lines(content):
            bucket = self._conditions if entry.is_condition else self._fields
            bucket.setdefault(entry.name, deque()).append(entry.line)

    def take(self, name: str, *, condition: bool = False) -> Optional[int]:
        """Consume and return the next source line declared for ``name``.

        Args:
            name: The data name.
            condition: True when looking up an 88-level condition name.

        Returns:
            The 1-based line number, or ``None`` when the name cannot be placed — in which case the
            node simply carries no line rather than a guessed one.
        """
        bucket = self._conditions if condition else self._fields
        queue = bucket.get(name)
        if not queue:
            return None
        return queue.popleft()


def _condition_node(
    condition: Cobol88Condition,
    *,
    ordinal: int,
    parent_path: str,
    lines: _LineIndex,
) -> NativeNode:
    """Describe one 88-level condition name.

    The condition's VALUE is a literal from the *copybook* — schema text, not observed payload — so
    it sits in ``attributes`` where a renderer can always show it, rather than in ``value`` where the
    value-visibility policy would (correctly, for payload) withhold it.
    """
    line = lines.take(condition.name, condition=True)
    return NativeNode(
        kind=KIND_CONDITION,
        name=condition.name,
        ordinal=ordinal,
        attributes={"level": 88, "conditionValue": condition.value},
        location=SourceLocation(line=line, ordinal=ordinal, path=f"{parent_path}/{condition.name}"),
    )


def _field_attributes(field: CobolField) -> Dict[str, object]:
    """Collect the clauses observed on one field, omitting the ones it did not carry.

    Omission is deliberate: an attribute bag that always carries ``"picture": null`` cannot be told
    apart from one where the analyzer failed to read a PICTURE clause. A key that is present was
    observed.
    """
    attributes: Dict[str, object] = {"level": field.level}
    if field.picture is not None:
        attributes["picture"] = field.picture
    if field.usage is not None:
        attributes["usage"] = field.usage
    if field.occurs_min is not None:
        attributes["occursMin"] = field.occurs_min
    if field.occurs_max is not None:
        attributes["occursMax"] = field.occurs_max
    if field.depending_on is not None:
        attributes["dependingOn"] = field.depending_on
    if field.conditions:
        attributes["conditionCount"] = len(field.conditions)
    if field.children:
        attributes["childCount"] = len(field.children)
    return attributes


def _field_node(
    field: CobolField,
    *,
    ordinal: int,
    parent_path: str,
    lines: _LineIndex,
    root: bool = False,
) -> NativeNode:
    """Describe one copybook item and everything under it.

    Children are built eagerly rather than lazily: line numbers are consumed from a shared FIFO in
    traversal order, so the traversal must happen once, in source order, regardless of what the node
    budget later admits. Copybooks are small — a large one is thousands of lines, not the hundreds of
    thousands of elements an interchange can carry — so the cost of building the whole description is
    bounded by the source itself.

    Args:
        field: The parsed item.
        ordinal: Its position among its siblings.
        parent_path: The parent's path, extended for this node.
        lines: The source-line index, consumed as the traversal proceeds.
        root: True for the level-01 item, which is recorded as a ``record``.

    Returns:
        The node.
    """
    path = f"{parent_path}/{field.name}" if parent_path else field.name
    line = lines.take(field.name)
    if root:
        kind = KIND_RECORD
    elif field.children:
        kind = KIND_GROUP
    else:
        kind = KIND_FIELD

    children: List[NativeNode] = [
        _field_node(child, ordinal=index, parent_path=path, lines=lines)
        for index, child in enumerate(field.children)
    ]
    children.extend(
        _condition_node(
            condition, ordinal=len(children) + index, parent_path=path, lines=lines
        )
        for index, condition in enumerate(field.conditions)
    )

    return NativeNode(
        kind=kind,
        name=field.name,
        ordinal=ordinal,
        attributes=_field_attributes(field),
        location=SourceLocation(line=line, ordinal=ordinal, path=path),
        children=children,
    )


def _unmodelled_clause_warnings(content: str) -> List[AnalysisWarning]:
    """Report copybook clauses the parser behind this extractor does not read.

    Scanning the source rather than the tree is the only way to find them: a ``REDEFINES`` clause the
    parser ignored leaves no trace in the parsed tree at all. Each hit is a ``warning``, which makes
    the record ``partial`` — the tree is real, and it is not the whole copybook.

    Args:
        content: The copybook source text.

    Returns:
        One warning per distinct unmodelled clause found, in declaration order.
    """
    warnings: List[AnalysisWarning] = []
    for pattern, code, message in _UNMODELLED_PATTERNS:
        hits = pattern.findall(content)
        if not hits:
            continue
        warnings.append(
            AnalysisWarning(
                code=code,
                severity=SEVERITY_WARNING,
                message=f"{message} ({len(hits)} occurrence(s)).",
            )
        )
    return warnings


def analyze_cobolcopybook(
    document: CobolCopybookDocument,
    *,
    source: Optional[str] = None,
    source_format: str = COBOL_ANALYZER_KEY,
    max_nodes: int = MAX_TREE_NODES,
    max_depth: int = MAX_TREE_DEPTH,
) -> PayloadAnalysisDocument:
    """Describe a parsed COBOL copybook as a payload analysis.

    Args:
        document: The parsed copybook (:func:`app.cobolcopybook_parser.parse_cobolcopybook`).
        source: The exact copybook text analysed, hashed into ``source_hash``. Defaults to the
            document's own retained ``raw`` text, which is what was parsed.
        source_format: Adapter key recorded on the record.
        max_nodes: Node budget.
        max_depth: Depth budget. COBOL allows 49 nesting levels, more than the default tree depth, so
            a pathologically deep copybook is bounded and says so.

    Returns:
        The analysis document. A copybook is a *layout*, not a payload — no field carries an observed
        value — so the record is structural whatever value-visibility policy stores it.
    """
    content = source if source is not None else document.raw
    lines = _LineIndex(content or "")
    root = _field_node(document.root, ordinal=0, parent_path="", lines=lines, root=True)

    return build_analysis_document(
        roots=[root],
        analyzer=AnalyzerInfo(
            key=COBOL_ANALYZER_KEY,
            version=COBOL_ANALYZER_VERSION,
            tool_versions=cobolcopybook_tool_versions(),
        ),
        capabilities=cobolcopybook_capabilities(),
        source=content,
        source_format=source_format,
        warnings=_unmodelled_clause_warnings(content or ""),
        max_nodes=max_nodes,
        max_depth=max_depth,
    )
