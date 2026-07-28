"""COBOL copybook native-analysis extractor — CPDO-1.2 (#4795), extended by CPDO-2.3 (#4799).

A copybook normalizes into records and fields with types, which is what a canonical model can hold
and roughly half of what a copybook says. The level numbers that give a record its shape, the
PICTURE clauses that give a field its storage, the USAGE that says how it is encoded, the OCCURS
bounds and their DEPENDING ON control field, the 88-level condition names that enumerate a field's
meaningful values — all of it is derived at import and then exists nowhere.

This extractor keeps it, in the copybook's own vocabulary:

.. code-block:: text

    record            01 CUSTOMER-RECORD              offset 1   len 81-145
      group           05 CUSTOMER-NAME                offset 9   len 40
        field         10 FIRST-NAME  PIC X(20)        offset 9   len 20
      field           05 STATUS      PIC X            offset 49  len 1
        condition     88 ACTIVE      VALUE 'A'

Positions, not just names (CPDO-2.3)
------------------------------------
A copybook is a *positional* description, and the position is the half a field list cannot hold.
:mod:`app.cobolcopybook_layout` computes it: every item's byte offset within the record, the bytes
one occurrence takes, the bytes every occurrence takes, and the record's own length — as a **range**
when a variable table makes it one.

It computes nothing it cannot know. A PICTURE the calculator does not read sizes to *unknown*, and
that unknown propagates: the group containing it has no length either, and neither does anything
after it. An item that follows a variable-length table has no single offset at all, because where it
starts depends on a value that exists only at runtime — so it carries none, rather than carrying its
minimum dressed up as its offset.

Every computed length rests on assumptions the copybook does not state (a single-byte encoding, the
packed-decimal representation, the binary width table, no SYNCHRONIZED slack). They are published as
:data:`~app.cobolcopybook_layout.LAYOUT_ASSUMPTIONS` on the record's provenance and named in its
capability declaration, so a reader sees a length as conditional — which is what it is.

REDEFINES
---------
The parser now reads ``REDEFINES`` (CPDO-2.3), so a redefining item is described as what it is: the
**same storage** as its target, laid out a second way. It starts at the target's offset and does not
advance the record. Each item records what it redefines and what redefines it, and a redefining item
larger than its target is reported rather than reconciled — that is a fact about the copybook, and
the analysis is not the place to correct it.

The canonical model still describes the two overlays as independent fields; representing them as a
union is #3991's, and normalization is deliberately unchanged here.

Source lines
------------
The parsed tree carries no positions, so line numbers are recovered from the source by
:func:`~app.cobolcopybook_parser.iter_definition_lines` and matched to fields by name, in order — a
name that repeats (``FILLER``, most often) resolves to its occurrences in the order the source
declared them. A field the match cannot place keeps its structural location and loses only its line,
which is the honest degradation: a wrong line number would be worse than none.

Constructs this extractor does not model
----------------------------------------
:mod:`app.cobolcopybook_parser` reads level numbers, PICTURE, USAGE, OCCURS (fixed and variable),
DEPENDING ON, REDEFINES and 88-conditions, and joins an entry's continuation lines so a clause split
across two lines is read as the one clause it is. It does not read ``RENAMES``, ``COPY … REPLACING``
or ``VALUE`` on ordinary fields — and a copybook using any of those is not a copybook this analysis
fully describes. Rather than let that surface as a mysteriously missing field, the source is scanned
for those keywords and each one found is recorded as a warning, which makes the record ``partial``
with a stated reason. A copybook that uses none of them is ``available``, and means it. The rest —
the limits with no keyword to scan for — are named in the record's capability declaration.
"""

from __future__ import annotations

import re
from collections import deque
from typing import Deque, Dict, List, Optional, Tuple

from .cobolcopybook_layout import (
    LAYOUT_ASSUMPTIONS,
    FieldLayout,
    compute_layout,
    resolve_odo_controllers,
)
from .cobolcopybook_parser import (
    Cobol88Condition,
    CobolCopybookDocument,
    CobolField,
    iter_definition_lines,
)
from .payload_analysis import (
    MAX_TREE_DEPTH,
    MAX_TREE_NODES,
    SEVERITY_INFO,
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
    "WARNING_LAYOUT_ASSUMPTIONS",
    "WARNING_ODO_CONTROLLER_UNRESOLVED",
    "WARNING_REDEFINES_SIZE_MISMATCH",
    "WARNING_REDEFINES_TARGET_MISSING",
    "WARNING_UNSIZED_ITEM",
    "WARNING_VARIABLE_LENGTH_RECORD",
    "analyze_cobolcopybook",
    "cobolcopybook_capabilities",
    "cobolcopybook_tool_versions",
]

#: Analyzer key recorded on every record this module produces.
COBOL_ANALYZER_KEY = "cobolcopybook"
#: Version of this extractor. Bumped by CPDO-2.3: the tree gained storage offsets and lengths,
#: REDEFINES overlays and ODO controller resolution.
COBOL_ANALYZER_VERSION = "1.1.0"
#: Version of the in-repo copybook parser the extractor reads through, recorded as a tool version so
#: a parser change is visible on records produced after it. Bumped by CPDO-2.3, which taught it
#: REDEFINES, fixed-size OCCURS and continuation lines.
COBOL_PARSER_VERSION = "1.1.0"

#: Node kinds, in nesting order. ``record`` is the level-01 item, ``group`` any item with children,
#: ``field`` an elementary item, ``condition`` an 88-level condition name.
KIND_RECORD = "record"
KIND_GROUP = "group"
KIND_FIELD = "field"
KIND_CONDITION = "condition"

#: Emitted once per record, naming the assumptions every computed length rests on. Informational:
#: nothing is missing from the analysis, and a reader who does not know the assumptions cannot
#: judge whether a length applies to their data.
WARNING_LAYOUT_ASSUMPTIONS = "copybook.layout_assumptions"

#: Emitted when an item's storage length could not be computed. A genuine boundary of this analyzer
#: — a PICTURE it does not read, or an item with neither PICTURE nor children — so it is a
#: ``warning`` and the record is ``partial``. The alternative is a record whose offsets are quietly
#: wrong from that item onwards.
WARNING_UNSIZED_ITEM = "copybook.unsized_item"

#: Emitted when the record's length is a range because it carries a variable table. Informational:
#: this is a property of the layout the copybook declared, not a gap in the analysis.
WARNING_VARIABLE_LENGTH_RECORD = "copybook.variable_length_record"

#: Emitted when a ``DEPENDING ON`` names an item this copybook does not declare. Informational: the
#: controller may well live in a surrounding copybook this one is copied into, so this states what
#: was observed rather than calling the copybook wrong.
WARNING_ODO_CONTROLLER_UNRESOLVED = "copybook.odo_controller_unresolved"

#: Emitted when a ``REDEFINES`` names a sibling that is not declared before it. Informational for
#: the same reason: the analysis reports the copybook, it does not grade it.
WARNING_REDEFINES_TARGET_MISSING = "copybook.redefines_target_missing"

#: Emitted when a redefining item needs more storage than the item it redefines. Informational: a
#: fact about the copybook, recorded rather than reconciled.
WARNING_REDEFINES_SIZE_MISMATCH = "copybook.redefines_size_mismatch"

#: Clauses the parser behind this extractor does not read, and the capability key each maps to. A
#: copybook containing one is analysed as far as the parser understands it and says so — the
#: alternative is a field silently missing from the record with nothing to explain it.
#:
#: ``REDEFINES`` left this list in CPDO-2.3: it is parsed and laid out now, so scanning for it would
#: report a construct the record actually describes.
UNMODELLED_CLAUSES: Tuple[Tuple[str, str, str], ...] = (
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
            # CPDO-2.3.
            "copybook.redefines",
            "copybook.computed_storage_length",
            "copybook.storage_offsets",
            "copybook.variable_length_records",
            "copybook.multi_line_clauses",
        ],
        unsupported=[
            "copybook.renames_66",
            "copybook.copy_statement",
            "copybook.copy_replacing",
            # VALUE on an ordinary field is not read (only on 88-level condition names).
            "copybook.value_clauses",
            "copybook.sign_and_synchronized_clauses",
            # Lengths are computed under stated assumptions; the encoding itself is never detected,
            # and a DBCS/national item is not sized at all.
            "copybook.character_encoding_detection",
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


def _layout_attributes(layout: FieldLayout) -> Dict[str, object]:
    """Collect what the storage calculator worked out for one item.

    Every key here is omitted when its value is unknown, so an attribute that is *present* was
    computed. A reader never sees an offset of zero standing in for "this could not be worked out" —
    the two are different facts, and ``offsetVariable`` is how the second one is said.

    Args:
        layout: The item's computed layout.

    Returns:
        The attributes to merge onto the node.
    """
    attributes: Dict[str, object] = {}
    if layout.offset is not None:
        attributes["offset"] = layout.offset
    if layout.offset_variable:
        # The item follows a variable table, so it has a *range* of offsets rather than an offset.
        attributes["offsetVariable"] = True
    if layout.length is not None:
        attributes["length"] = layout.length
    if layout.total_length is not None:
        attributes["totalLength"] = layout.total_length
    if layout.min_total_length is not None and layout.min_total_length != layout.total_length:
        attributes["minTotalLength"] = layout.min_total_length
    if layout.variable:
        attributes["variableLength"] = True
    if layout.redefines is not None:
        attributes["redefines"] = layout.redefines

    picture = layout.picture
    if picture is not None:
        if picture.basis is not None:
            attributes["storageBasis"] = picture.basis
        if picture.digits is not None:
            attributes["digits"] = picture.digits
        if picture.decimals is not None:
            attributes["decimals"] = picture.decimals
        if picture.signed:
            attributes["signed"] = True
    return attributes


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


def _redefined_by(field: CobolField) -> Dict[str, List[str]]:
    """Map each item name to the sibling names that redefine it.

    Args:
        field: A group item whose children are being described.

    Returns:
        ``target name → [redefining names]``, for the children of this group only. Recorded on the
        *target* so a reader who selects the redefined item can see what else lays claim to its
        bytes, which is the direction the question is usually asked in.
    """
    overlays: Dict[str, List[str]] = {}
    for child in field.children:
        if child.redefines:
            overlays.setdefault(child.redefines, []).append(child.name)
    return overlays


def _field_node(
    field: CobolField,
    *,
    ordinal: int,
    parent_path: str,
    lines: _LineIndex,
    layouts: Dict[int, FieldLayout],
    overlays: Dict[str, List[str]],
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
        layouts: Computed storage layout per item, keyed by object identity.
        overlays: ``target name → redefining names`` among this item's siblings.
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

    attributes = _field_attributes(field)
    layout = layouts.get(id(field))
    if layout is not None:
        attributes.update(_layout_attributes(layout))
    redefined_by = overlays.get(field.name)
    if redefined_by:
        attributes["redefinedBy"] = list(redefined_by)

    child_overlays = _redefined_by(field)
    children: List[NativeNode] = [
        _field_node(
            child,
            ordinal=index,
            parent_path=path,
            lines=lines,
            layouts=layouts,
            overlays=child_overlays,
        )
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
        attributes=attributes,
        location=SourceLocation(line=line, ordinal=ordinal, path=path),
        children=children,
    )


def _unmodelled_clause_warnings(content: str) -> List[AnalysisWarning]:
    """Report copybook clauses the parser behind this extractor does not read.

    Scanning the source rather than the tree is the only way to find them: a ``RENAMES`` clause the
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


def _iter_fields(field: CobolField) -> List[CobolField]:
    """Return every item in the tree, depth-first in source order."""
    items = [field]
    for child in field.children:
        items.extend(_iter_fields(child))
    return items


def _layout_warnings(
    root: CobolField, layouts: Dict[int, FieldLayout]
) -> List[AnalysisWarning]:
    """Report what the storage calculation could and could not establish.

    Exactly one of these is a ``warning``: an item whose storage this analyzer cannot compute is a
    boundary of the analyzer, and the record is ``partial`` because of it. The rest are ``info`` —
    a variable-length record, an unresolved ODO controller, a REDEFINES that does not fit are all
    facts about the *copybook*, recorded rather than graded, exactly as a control-total mismatch is
    for an X12 interchange (CPDO-2.2).

    Args:
        root: The level-01 item.
        layouts: The computed layouts.

    Returns:
        The warnings, most-structural first.
    """
    warnings: List[AnalysisWarning] = []
    fields = _iter_fields(root)

    unsized = [
        field
        for field in fields
        if (layout := layouts.get(id(field))) is not None
        and layout.length is None
        and not field.children
    ]
    if unsized:
        named = ", ".join(field.name for field in unsized[:5])
        more = "" if len(unsized) <= 5 else f" and {len(unsized) - 5} more"
        reason = next(
            (
                layouts[id(field)].reason
                for field in unsized
                if layouts[id(field)].reason is not None
            ),
            "",
        )
        warnings.append(
            AnalysisWarning(
                code=WARNING_UNSIZED_ITEM,
                severity=SEVERITY_WARNING,
                message=(
                    f"{len(unsized)} item(s) have no computable storage length ({named}{more}). "
                    f"{reason} Offsets after an unsized item are not computed either."
                ).strip(),
            )
        )

    record_layout = layouts.get(id(root))
    if record_layout is not None and record_layout.variable:
        minimum = record_layout.min_total_length
        maximum = record_layout.total_length
        span = (
            f"{minimum}–{maximum} bytes"
            if minimum is not None and maximum is not None
            else "a range this analysis could not compute"
        )
        warnings.append(
            AnalysisWarning(
                code=WARNING_VARIABLE_LENGTH_RECORD,
                severity=SEVERITY_INFO,
                message=(
                    f"This record carries a variable-length table, so one record occupies {span} "
                    "rather than a fixed size. Items after that table have a range of offsets "
                    "rather than an offset, and are recorded with none."
                ),
            )
        )

    unresolved = [
        controller
        for controller, resolved in resolve_odo_controllers(root).items()
        if not resolved
    ]
    if unresolved:
        warnings.append(
            AnalysisWarning(
                code=WARNING_ODO_CONTROLLER_UNRESOLVED,
                severity=SEVERITY_INFO,
                message=(
                    "DEPENDING ON names "
                    + ", ".join(sorted(set(unresolved)))
                    + ", which this copybook does not declare. The controller may be declared in a "
                    "surrounding copybook this one is copied into."
                ),
            )
        )

    warnings.extend(_redefines_warnings(root, layouts))
    return warnings


def _redefines_warnings(
    root: CobolField, layouts: Dict[int, FieldLayout]
) -> List[AnalysisWarning]:
    """Report REDEFINES clauses whose target is missing or too small.

    Args:
        root: The level-01 item.
        layouts: The computed layouts.

    Returns:
        Informational warnings — both conditions are properties of the copybook, not limits of this
        analyzer, so neither makes the record ``partial``.
    """
    warnings: List[AnalysisWarning] = []
    missing: List[str] = []
    mismatched: List[str] = []

    for group in _iter_fields(root):
        if not group.children:
            continue
        sizes = {child.name: layouts.get(id(child)) for child in group.children}
        for child in group.children:
            if not child.redefines:
                continue
            target = sizes.get(child.redefines)
            if target is None:
                missing.append(f"{child.name} REDEFINES {child.redefines}")
                continue
            overlay = layouts.get(id(child))
            if (
                overlay is not None
                and overlay.total_length is not None
                and target.total_length is not None
                and overlay.total_length > target.total_length
            ):
                mismatched.append(
                    f"{child.name} needs {overlay.total_length} bytes over "
                    f"{child.redefines}'s {target.total_length}"
                )

    if missing:
        warnings.append(
            AnalysisWarning(
                code=WARNING_REDEFINES_TARGET_MISSING,
                severity=SEVERITY_INFO,
                message=(
                    "REDEFINES names an item not declared before it in the same group ("
                    + "; ".join(sorted(missing))
                    + "). The redefining item is described, and it carries no offset."
                ),
            )
        )
    if mismatched:
        warnings.append(
            AnalysisWarning(
                code=WARNING_REDEFINES_SIZE_MISMATCH,
                severity=SEVERITY_INFO,
                message=(
                    "A redefining item needs more storage than the item it redefines ("
                    + "; ".join(sorted(mismatched))
                    + "). Both lengths are recorded as computed; neither is adjusted to fit."
                ),
            )
        )
    return warnings


def _assumption_warning() -> AnalysisWarning:
    """State the assumptions every computed length in this record rests on.

    The copybook declares none of them, and no runtime data exists to infer them from, so a computed
    length is conditional. Publishing the conditions with the record is what keeps it evidence
    rather than an assertion.

    Returns:
        One informational warning listing :data:`~app.cobolcopybook_layout.LAYOUT_ASSUMPTIONS`.
    """
    return AnalysisWarning(
        code=WARNING_LAYOUT_ASSUMPTIONS,
        severity=SEVERITY_INFO,
        message=(
            "Storage offsets and lengths are computed under assumptions this copybook does not "
            "state: " + " ".join(LAYOUT_ASSUMPTIONS)
        ),
    )


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
    layouts = compute_layout(document.root)
    root = _field_node(
        document.root,
        ordinal=0,
        parent_path="",
        lines=lines,
        layouts=layouts,
        overlays={},
        root=True,
    )

    warnings = (
        _unmodelled_clause_warnings(content or "")
        + _layout_warnings(document.root, layouts)
        + [_assumption_warning()]
    )

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
        warnings=warnings,
        max_nodes=max_nodes,
        max_depth=max_depth,
    )
