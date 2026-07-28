"""EDI X12 native-analysis extractor — CPDO-1.2 (#4795), extended by CPDO-2.2 (#4798).

The X12 canonical normalizer (:mod:`app.edix12_normalizer`) reads
``interchange.functional_groups[0].transaction_sets[0]`` and normalizes that one transaction set into
types. It is the right thing for a *canonical* model — one interchange describes one schema — but it
means a file carrying an 850 and an 810 in two functional groups imports as though the second did not
exist. Nothing downstream can tell an interchange that had one transaction set from one that had six.

This extractor is where the rest survives. It walks **every** functional group and **every**
transaction set the parser produced, in source order, and describes them in X12's own vocabulary:

.. code-block:: text

    interchange            ISA — delimiters, controls, sender/receiver, usage indicator
      functional_group     GS  — functional id, version, group control number, control total
        transaction_set    ST  — set id (850/810/…), control number, implementation convention
          segment          BEG, N1, PO1 … in position order, with its repeat index
            element        BEG01 … with its position, presence and length
              repetition   BEG01[0] … only where a repetition separator split the value
            composite      BEG05 — with its component sub-elements

Two readings of the same bytes
------------------------------
``pyx12`` answers questions about *values*, and that is the AST this extractor describes. Three
facts it cannot answer — where a segment sits in the file, which element positions were written and
left empty, and how a repeated value divides — are read from the interchange text itself by
:mod:`app.edix12_segment_scan`, and **aligned** to the AST segment by segment.

The alignment is the safety property. Both readings are in source order, so walking them together is
a match on segment ids and nothing more; the moment the ids stop agreeing, the scan is abandoned
whole and the record falls back to CPDO-1.2's path-and-ordinal locations. A record therefore either
carries positions that were checked against the parse or carries none, and
:func:`edix12_capabilities` is stamped **per record** with which of the two happened — the analyzer
never declares a capability the record in hand did not exercise.

Guarantees
----------
**Every group and transaction set is kept.** A bounded analysis drops leaves, never envelopes: the
node budget is raised, if needed, to at least the number of envelope nodes the interchange contains
(:func:`_envelope_node_count`), so elements are what a large interchange loses. That is the ordering
the record is useful under — an envelope explains what a payload *is*, an arbitrary handful of its
elements does not.

**Present-and-empty is not absent.** An element position the source wrote and left empty is a node
with ``value_present`` true and ``value_length`` zero; a position the source never wrote is not a
node at all. ``pyx12`` alone cannot tell those apart, which is why the scan exists.

**Repetition is counted, not concatenated.** Where the interchange declares a repetition separator
(``ISA11`` at ``00501`` and later — never at ``00401``, where that position is an ordinary code),
an element that repeats carries its occurrences as ``repetition`` children and states its count.

**Business values stay in ``value``.** Envelope identity, delimiters, control totals, positions and
repeat counts are *structure* and sit in ``attributes``. Every observed element, component and
repetition value sits in ``value``, which is the only field
:func:`~app.payload_analysis.apply_value_visibility` governs — so the stored record carries exactly
what the value-visibility policy in force allows and no attribute can smuggle a payload value past
it.

Limits, stated rather than implied
----------------------------------
The parser discards ``TA1`` acknowledgements and ``IEA``/``GE``/``SE`` trailers before this extractor
sees the AST, and it does not infer ``HL`` hierarchies. The trailers' **control totals** are read
back off the raw scan and recorded beside the observed counts, so a reader can see the interchange
disagree with itself; the trailer segments themselves are still not tree nodes, and the capability
declaration says so. No 4010/5010 implementation-guide conformance is evaluated at any point: this
record describes what the interchange *said*, never whether it was allowed to say it.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Tuple

from .edix12_parser import (
    EdiX12Document,
    X12Element,
    X12FunctionalGroup,
    X12Interchange,
    X12Segment,
    X12TransactionSet,
)
from .edix12_segment_scan import (
    X12Delimiters,
    X12RawSegment,
    detect_delimiters,
    is_segment_id,
    scan_segments,
    split_components,
    split_elements,
    split_repetitions,
)
from .payload_analysis import (
    MAX_TREE_DEPTH,
    MAX_TREE_NODES,
    SEVERITY_INFO,
    AnalysisWarning,
    AnalyzerCapabilities,
    AnalyzerInfo,
    PayloadAnalysisDocument,
    SourceLocation,
    analyzer_capabilities,
)
from .payload_analyzer import (
    MAX_VISITED_NODES,
    NativeNode,
    analysis_limits,
    build_analysis_document,
)

__all__ = [
    "EDIX12_ANALYZER_KEY",
    "EDIX12_ANALYZER_VERSION",
    "KIND_COMPOSITE",
    "KIND_COMPONENT",
    "KIND_ELEMENT",
    "KIND_FUNCTIONAL_GROUP",
    "KIND_INTERCHANGE",
    "KIND_REPETITION",
    "KIND_SEGMENT",
    "KIND_TRANSACTION_SET",
    "WARNING_CANONICAL_SUBSET",
    "WARNING_HL_HIERARCHY_FLATTENED",
    "WARNING_SCAN_UNALIGNED",
    "WARNING_SCAN_TRUNCATED",
    "WARNING_TRAILERS_DROPPED",
    "analyze_edix12",
    "edix12_capabilities",
    "edix12_tool_versions",
]

#: Analyzer key recorded on every record this module produces.
EDIX12_ANALYZER_KEY = "edix12"
#: Version of this extractor. Bumped by CPDO-2.2: the tree gained source ranges, empty element
#: positions, repetition occurrences, segment repeat counts and envelope control totals.
EDIX12_ANALYZER_VERSION = "1.1.0"

#: The X12 envelope, in nesting order.
KIND_INTERCHANGE = "interchange"
KIND_FUNCTIONAL_GROUP = "functional_group"
KIND_TRANSACTION_SET = "transaction_set"
KIND_SEGMENT = "segment"
KIND_ELEMENT = "element"
KIND_COMPOSITE = "composite"
KIND_COMPONENT = "component"
#: One occurrence of an element that a repetition separator split. Emitted only where the
#: interchange declares such a separator *and* the value actually carries it, so a tree with no
#: ``repetition`` nodes means the source repeated nothing — not that repetition went unread.
KIND_REPETITION = "repetition"

#: Emitted when a transaction set carries ``HL`` segments. They are all in the tree, in order — what
#: is missing is the *hierarchy* they encode, which this extractor does not infer. Informational on
#: purpose: nothing observed was dropped, so the record stays ``available``.
WARNING_HL_HIERARCHY_FLATTENED = "x12.hl_hierarchy_flattened"

#: Emitted when the canonical projection describes less of the interchange than the analysis does —
#: more than one functional group, or more than one transaction set in the first. The AC behind this
#: module: a reader must be told *explicitly* when the OpenAPI conversion was derived from a subset
#: of what the source carried, rather than being left to compare two screens.
WARNING_CANONICAL_SUBSET = "x12.canonical_projection_subset"

#: Emitted when the raw scan and the parse disagree about the segments present, so no source
#: positions are claimed at all. Informational: the tree is complete, only its locations are coarser.
WARNING_SCAN_UNALIGNED = "x12.source_positions_unavailable"

#: Emitted when the interchange has more segments than one scan records, so the tail carries no
#: source positions. The nodes are all there; the positions stop.
WARNING_SCAN_TRUNCATED = "x12.source_positions_truncated"

#: Emitted when the source carried ``TA1`` acknowledgement segments, which the parser removes before
#: the AST reaches this extractor. The envelope trailers it also removes (``SE``/``GE``/``IEA``) do
#: not warn: everything they carry beyond a duplicate control number is a control total, and those
#: are recorded on the envelope each one closes.
WARNING_TRAILERS_DROPPED = "x12.ta1_acknowledgement_dropped"

#: ``ISA15`` — the usage indicator, and the one envelope control whose meaning a reader must never
#: have to look up. An unlisted code is reported verbatim rather than guessed at.
_USAGE_INDICATORS = {"P": "Production", "T": "Test", "I": "Information"}


def edix12_tool_versions() -> Dict[str, str]:
    """Return the parser versions behind an X12 analysis.

    The X12 AST is ``pyx12``'s reading of the interchange, so the record names the release that read
    it: a segment vocabulary that changes between ``pyx12`` releases changes the analysis, and a
    reader comparing two records needs to see that rather than guess it.

    Returns:
        ``{"pyx12": <version>}``; the version is ``"unknown"`` when the distribution metadata cannot
        be read, which is a statement about this runtime rather than a reason to fail an import.
    """
    from importlib.metadata import PackageNotFoundError, version

    try:
        pyx12_version = version("pyx12")
    except PackageNotFoundError:  # pragma: no cover - pyx12 is a hard dependency
        pyx12_version = "unknown"
    return {"pyx12": pyx12_version}


def edix12_capabilities(
    *, max_nodes: int = MAX_TREE_NODES, source_positions: bool = False
) -> AnalyzerCapabilities:
    """Return what this extractor modelled for **this record**, and what it knowingly did not.

    Capabilities are recorded per record rather than per format (CPDO-1.2), and CPDO-2.2 is the
    reason that matters: three constructs — source ranges, empty element positions and repeated
    elements — are readable only from an interchange text this analysis could align to the parse. A
    record whose alignment failed declares them **unsupported**, because for that record they are.
    The cross-format statement of what the analyzer can do *in general* is CPDO-2.4's registry.

    Args:
        max_nodes: The node budget the record was produced under. It is recorded rather than assumed
            because :func:`analyze_edix12` raises it when an interchange has more envelope nodes than
            the default budget, and a reader comparing two records should see that.
        source_positions: Whether the raw scan aligned to the parse, so the record carries byte
            offsets, empty element positions and split repetitions.

    Returns:
        The :class:`~app.payload_analysis.AnalyzerCapabilities` for this X12 analysis.
    """
    scan_constructs = [
        # Every element position the source wrote, empty ones included.
        "x12.empty_elements",
        # A repeated element's occurrences, split on the declared repetition separator.
        "x12.repeating_elements",
        # Offset/length/line for every segment, checked against the parse.
        "x12.byte_offsets",
        # Declared control totals (IEA01/GE01/SE01) beside the observed counts.
        "x12.envelope_control_totals",
    ]
    return analyzer_capabilities(
        supported=[
            "x12.interchange_envelope",
            "x12.functional_group",
            "x12.transaction_set",
            "x12.segment",
            "x12.element",
            "x12.composite_elements",
            "x12.delimiters",
            "x12.control_numbers",
            "x12.segment_ordinals",
            "x12.segment_repeat_counts",
        ]
        + (scan_constructs if source_positions else []),
        unsupported=(
            [] if source_positions else scan_constructs
        )
        + [
            # HL loops are described as the segments they are, not as the hierarchy they encode.
            "x12.hl_hierarchy",
            # The parser drops these before this extractor sees the AST; only their totals survive.
            "x12.ta1_acknowledgement",
            "x12.iea_trailer",
            # No 4010/5010 implementation-guide conformance is evaluated.
            "x12.implementation_guide_validation",
        ],
        limits=analysis_limits(max_nodes=max_nodes),
    )


# ===========================================================================
# Aligning the raw scan to the parsed AST
# ===========================================================================


@dataclass(frozen=True)
class _AlignedScan:
    """The raw scan, matched to the AST it describes.

    Attributes:
        delimiters: The interchange's own four delimiters.
        interchange: The raw ``ISA`` segment.
        groups: Raw ``GS``/``GE`` per functional group, indexed by group ordinal.
        transactions: Raw ``ST``/``SE`` per transaction set, keyed by ``(group, transaction)``.
        segments: Raw body segments, keyed by ``(group, transaction, segment)``.
        trailer: The raw ``IEA`` segment, when the source carried one.
        dropped_ids: Ids of segments the parser removed from the AST without recovering what they
            carried, with their counts — ``TA1`` and nothing else.
        complete: False when the scan stopped at its cap, so the tail carries no positions.
    """

    delimiters: X12Delimiters
    interchange: X12RawSegment
    groups: Dict[int, Tuple[Optional[X12RawSegment], Optional[X12RawSegment]]]
    transactions: Dict[Tuple[int, int], Tuple[Optional[X12RawSegment], Optional[X12RawSegment]]]
    segments: Dict[Tuple[int, int, int], X12RawSegment]
    trailer: Optional[X12RawSegment]
    dropped_ids: Dict[str, int]
    complete: bool


class _ScanCursor:
    """A one-way walk over the scanned segments, matched by id in source order.

    Both readings of the interchange are in source order, so alignment is a forward search for the
    next segment carrying the id the AST expects. Nothing is ever matched backwards, so a segment
    can be consumed at most once and a repeated id resolves to its own occurrence.
    """

    def __init__(self, segments: Sequence[X12RawSegment]) -> None:
        self._segments = segments
        self._cursor = 0
        self.aligned = True

    def take(self, segment_id: str) -> Optional[X12RawSegment]:
        """Consume the next scanned segment with ``segment_id``.

        Args:
            segment_id: The id the AST expects next.

        Returns:
            The raw segment, or ``None`` when the scan has no such segment left — which is a
            disagreement between the two readings, and latches :attr:`aligned` off.
        """
        for index in range(self._cursor, len(self._segments)):
            if self._segments[index].segment_id == segment_id:
                self._cursor = index + 1
                return self._segments[index]
        self.aligned = False
        return None


def _align_scan(interchange: X12Interchange, source: str) -> Optional[_AlignedScan]:
    """Match a delimiter scan of the source text against the parsed interchange.

    The walk visits exactly what the parser visited, in the order it visited it —
    ``ISA``, then per group ``GS`` → per transaction ``ST`` → body segments → ``SE``, then ``GE``,
    then the closing ``IEA``. A single unmatched id abandons the whole scan: half-aligned positions
    would put a reader in front of the wrong bytes, which is worse than putting them in front of
    none.

    Args:
        interchange: The parsed interchange.
        source: The exact interchange text the analysis names in its ``source_hash``.

    Returns:
        The aligned scan, or ``None`` when the source has no readable header, is not segment-shaped,
        or disagrees with the parse.
    """
    delimiters = detect_delimiters(source)
    if delimiters is None:
        return None
    scanned, complete = scan_segments(source, delimiters)
    if not scanned or scanned[0].segment_id != "ISA":
        return None
    if not all(is_segment_id(segment.segment_id) for segment in scanned):
        return None

    cursor = _ScanCursor(scanned)
    isa = cursor.take("ISA")
    if isa is None:
        return None

    groups: Dict[int, Tuple[Optional[X12RawSegment], Optional[X12RawSegment]]] = {}
    transactions: Dict[Tuple[int, int], Tuple[Optional[X12RawSegment], Optional[X12RawSegment]]] = {}
    segments: Dict[Tuple[int, int, int], X12RawSegment] = {}

    for group_index, group in enumerate(interchange.functional_groups):
        gs = cursor.take("GS")
        for transaction_index, transaction in enumerate(group.transaction_sets):
            st = cursor.take("ST")
            for segment_index, segment in enumerate(transaction.segments):
                raw = cursor.take(segment.id)
                if raw is not None:
                    segments[(group_index, transaction_index, segment_index)] = raw
            se = cursor.take("SE")
            transactions[(group_index, transaction_index)] = (st, se)
        ge = cursor.take("GE")
        groups[group_index] = (gs, ge)

    if not cursor.aligned:
        return None

    # The closing trailer is searched for rather than required: an interchange truncated before its
    # ``IEA`` still aligns everything up to that point, and simply has no declared group total.
    trailer = next((segment for segment in reversed(scanned) if segment.segment_id == "IEA"), None)

    # Only ``TA1`` is counted as *lost*. ``SE``/``GE``/``IEA`` are also removed from the AST, but
    # everything they carry beyond a duplicate control number is a control total, and those are
    # recorded on the envelope each one closes — so reporting them as dropped would overstate it.
    dropped = Counter(segment.segment_id for segment in scanned if segment.segment_id == "TA1")
    return _AlignedScan(
        delimiters=delimiters,
        interchange=isa,
        groups=groups,
        transactions=transactions,
        segments=segments,
        trailer=trailer,
        dropped_ids=dict(dropped),
        complete=complete,
    )


def _location(raw: Optional[X12RawSegment], *, ordinal: int, path: str) -> SourceLocation:
    """Build a node's location, carrying source positions only where the scan supplied them.

    Args:
        raw: The aligned raw segment, when there is one.
        ordinal: The node's sibling ordinal.
        path: The node's envelope path.

    Returns:
        A :class:`~app.payload_analysis.SourceLocation` with offset/length/line/column when the scan
        aligned, and with the CPDO-1.2 path-and-ordinal alone when it did not. Nothing in between is
        emitted: a location either addresses bytes that were checked, or addresses structure.
    """
    if raw is None:
        return SourceLocation(ordinal=ordinal, path=path)
    return SourceLocation(
        line=raw.line,
        column=raw.column,
        offset=raw.offset,
        length=raw.length,
        ordinal=ordinal,
        path=path,
    )


def _element_value(raw: Optional[X12RawSegment], delimiters: X12Delimiters, position: int) -> str:
    """Return one raw element's text by 1-based position, or ``""`` when it is not there."""
    if raw is None:
        return ""
    parts = split_elements(raw.text, delimiters)
    return parts[position] if 0 < position < len(parts) else ""


def _int_or_none(value: str) -> Optional[int]:
    """Return ``value`` as an int, or ``None`` when it is not a plain integer.

    A control total that is not a number is not reported as zero — an unreadable declaration and a
    declaration of nothing are different facts, and only the first should ever look like a fault.
    """
    text = value.strip()
    if not text or not text.lstrip("+-").isdigit():
        return None
    return int(text)


# ===========================================================================
# Node construction
# ===========================================================================


def _component_nodes(
    value: str,
    delimiters: X12Delimiters,
    *,
    parent_path: str,
    reference: str,
) -> List[NativeNode]:
    """Describe one composite value's components, empty ones included.

    Args:
        value: The composite element's raw text.
        delimiters: The interchange's delimiters.
        parent_path: The composite node's path.
        reference: The composite's reference designator (``CLM05``), extended per component.

    Returns:
        ``component`` nodes in source order, each carrying its own presence and length.
    """
    components = split_components(value, delimiters)
    return [
        NativeNode(
            kind=KIND_COMPONENT,
            name=f"{reference}-{index + 1}",
            ordinal=index,
            attributes={"position": f"{index + 1:02d}", "reference": f"{reference}-{index + 1}"},
            location=SourceLocation(
                ordinal=index, path=f"{parent_path}/{reference}-{index + 1}"
            ),
            value_present=True,
            value_length=len(component),
            value=component,
        )
        for index, component in enumerate(components)
    ]


def _scanned_element_nodes(
    raw: X12RawSegment,
    delimiters: X12Delimiters,
    *,
    segment_path: str,
) -> List[NativeNode]:
    """Describe a segment's elements from the source text.

    This is the reading that can see what ``pyx12`` cannot: a position written and left empty is a
    node with a zero-length present value, a position never written is not a node, and a value the
    declared repetition separator divides becomes an element with its occurrences underneath it.

    Args:
        raw: The aligned raw segment.
        delimiters: The interchange's delimiters.
        segment_path: The parent segment's path.

    Returns:
        The element/composite nodes, in position order.
    """
    parts = split_elements(raw.text, delimiters)
    segment_id = raw.segment_id
    # ``ISA16`` *is* the component separator, so splitting the header's own values on it would turn
    # a declared delimiter into two empty components. The header is read as flat elements.
    composites_readable = segment_id != "ISA"

    nodes: List[NativeNode] = []
    for index, value in enumerate(parts[1:], start=1):
        position = f"{index:02d}"
        reference = f"{segment_id}{position}"
        path = f"{segment_path}/{reference}"
        attributes: Dict[str, object] = {"position": position, "reference": reference}
        location = SourceLocation(ordinal=index - 1, path=path)

        occurrences = split_repetitions(value, delimiters) if composites_readable else [value]
        if len(occurrences) > 1:
            nodes.append(
                NativeNode(
                    kind=KIND_ELEMENT,
                    name=reference,
                    label=f"{reference} ×{len(occurrences)}",
                    ordinal=index - 1,
                    attributes={**attributes, "repeatCount": len(occurrences)},
                    location=location,
                    children=[
                        NativeNode(
                            kind=KIND_REPETITION,
                            name=f"{reference}[{occurrence_index}]",
                            ordinal=occurrence_index,
                            attributes={"repeatIndex": occurrence_index},
                            location=SourceLocation(
                                ordinal=occurrence_index,
                                path=f"{path}[{occurrence_index}]",
                            ),
                            value_present=True,
                            value_length=len(occurrence),
                            value=occurrence,
                        )
                        for occurrence_index, occurrence in enumerate(occurrences)
                    ],
                )
            )
            continue

        components = split_components(value, delimiters) if composites_readable else [value]
        if len(components) > 1:
            nodes.append(
                NativeNode(
                    kind=KIND_COMPOSITE,
                    name=reference,
                    ordinal=index - 1,
                    attributes={**attributes, "componentCount": len(components)},
                    location=location,
                    children=_component_nodes(
                        value, delimiters, parent_path=path, reference=reference
                    ),
                )
            )
            continue

        nodes.append(
            NativeNode(
                kind=KIND_ELEMENT,
                name=reference,
                ordinal=index - 1,
                attributes=attributes,
                location=location,
                # The position exists in the source: that is what the delimiter proves. Whether it
                # carried anything is the length, and a zero length here means observed-and-empty.
                value_present=True,
                value_length=len(value),
                value=value,
            )
        )
    return nodes


def _parsed_element_nodes(
    elements: Sequence[X12Element],
    *,
    segment_path: str,
) -> List[NativeNode]:
    """Describe one segment's elements from the AST alone, regrouping composite components.

    The CPDO-1.2 reading, kept as the fallback for a source whose scan could not be aligned.
    ``pyx12`` reports a composite as several values sharing one element position, distinguished by a
    ``SEG05-2``-style refdes. Elements are therefore grouped by position: a position with a single
    non-composite value becomes an ``element``; a position with components becomes a ``composite``
    whose children are its ``component``\\s, in source order. Empty positions are absent from this
    reading entirely, which is why the record that uses it declares ``x12.empty_elements``
    unsupported.

    Args:
        elements: The segment's elements, in source order.
        segment_path: The parent segment's path, extended for each element node.

    Returns:
        The element/composite nodes, in position order.
    """
    grouped: Dict[str, List[X12Element]] = {}
    order: List[str] = []
    for element in elements:
        if element.position not in grouped:
            grouped[element.position] = []
            order.append(element.position)
        grouped[element.position].append(element)

    nodes: List[NativeNode] = []
    for ordinal, position in enumerate(order):
        members = grouped[position]
        is_composite = len(members) > 1 or any("-" in member.ref for member in members)
        if not is_composite:
            member = members[0]
            nodes.append(
                NativeNode(
                    kind=KIND_ELEMENT,
                    name=member.ref,
                    ordinal=ordinal,
                    attributes={"position": member.position, "reference": member.ref},
                    location=SourceLocation(
                        ordinal=ordinal, path=f"{segment_path}/{member.ref}"
                    ),
                    value_present=True,
                    value_length=len(member.value),
                    value=member.value,
                )
            )
            continue

        composite_name = f"{members[0].ref.split('-', 1)[0]}"
        composite_path = f"{segment_path}/{composite_name}"
        nodes.append(
            NativeNode(
                kind=KIND_COMPOSITE,
                name=composite_name,
                ordinal=ordinal,
                attributes={
                    "position": position,
                    "reference": composite_name,
                    "componentCount": len(members),
                },
                location=SourceLocation(ordinal=ordinal, path=composite_path),
                children=[
                    NativeNode(
                        kind=KIND_COMPONENT,
                        name=member.ref,
                        ordinal=component_ordinal,
                        attributes={"position": member.position, "reference": member.ref},
                        location=SourceLocation(
                            ordinal=component_ordinal,
                            path=f"{composite_path}/{member.ref}",
                        ),
                        value_present=True,
                        value_length=len(member.value),
                        value=member.value,
                    )
                    for component_ordinal, member in enumerate(members)
                ],
            )
        )
    return nodes


def _segment_node(
    segment: X12Segment,
    *,
    ordinal: int,
    transaction_path: str,
    repeat_index: int,
    repeat_count: int,
    raw: Optional[X12RawSegment],
    scan: Optional[_AlignedScan],
) -> NativeNode:
    """Describe one segment, its repeat position and its elements.

    A transaction set that carries four ``HL`` segments carries four rows that would otherwise read
    identically. ``repeatIndex``/``repeatCount`` and the label make each one nameable — which is the
    difference between "this 856 has an HL loop" and "this HL is the third of four".

    Args:
        segment: The parsed segment.
        ordinal: Its position within the transaction set, 0-based.
        transaction_path: The parent transaction set's path.
        repeat_index: 0-based occurrence of this segment id within the transaction set.
        repeat_count: Total occurrences of this segment id within the transaction set.
        raw: The aligned raw segment, when the scan supplied one.
        scan: The aligned scan, when there is one — its delimiters drive the element reading.

    Returns:
        The ``segment`` node; its elements are built lazily so a segment the budget refuses costs
        nothing to skip.
    """
    path = f"{transaction_path}/{segment.id}[{ordinal}]"
    attributes: Dict[str, object] = {
        "segmentId": segment.id,
        "elementCount": len(segment.elements),
        "repeatIndex": repeat_index,
        "repeatCount": repeat_count,
    }

    def children() -> List[NativeNode]:
        """Realise this segment's elements — from the source text when the scan aligned to it."""
        if raw is not None and scan is not None:
            return _scanned_element_nodes(raw, scan.delimiters, segment_path=path)
        return _parsed_element_nodes(segment.elements, segment_path=path)

    if raw is not None and scan is not None:
        # The scan can see element positions the value iterator skipped, so the two counts differ on
        # any segment with an empty position. Both are recorded; neither is presented as the other.
        attributes["elementPositionCount"] = max(
            0, len(split_elements(raw.text, scan.delimiters)) - 1
        )

    return NativeNode(
        kind=KIND_SEGMENT,
        name=segment.id,
        label=(
            f"{segment.id} ({repeat_index + 1} of {repeat_count})" if repeat_count > 1 else None
        ),
        ordinal=ordinal,
        attributes=attributes,
        location=_location(raw, ordinal=ordinal, path=path),
        children=children,
    )


def _transaction_node(
    transaction: X12TransactionSet,
    *,
    ordinal: int,
    group_path: str,
    group_index: int,
    scan: Optional[_AlignedScan],
) -> NativeNode:
    """Describe one transaction set, its declared controls and its segments."""
    path = f"{group_path}/ST[{ordinal}]"
    st, se = (scan.transactions.get((group_index, ordinal), (None, None)) if scan else (None, None))

    attributes: Dict[str, object] = {
        "setId": transaction.set_id,
        "controlNumber": transaction.control_number,
        "segmentCount": len(transaction.segments),
    }
    if scan is not None:
        # ``ST03`` names the implementation convention the sender claims to have followed. It is
        # recorded as a claim; nothing here checks the interchange against that guide.
        convention = _element_value(st, scan.delimiters, 3).strip()
        if convention:
            attributes["implementationConventionReference"] = convention
        declared = _int_or_none(_element_value(se, scan.delimiters, 1))
        if declared is not None:
            # ``SE01`` counts ST through SE inclusive, so the comparable observed figure is the body
            # segment count plus those two envelope segments.
            attributes["declaredSegmentCount"] = declared
            attributes["envelopeSegmentCount"] = len(transaction.segments) + 2

    # Repeat positions are counted per transaction set, which is the scope a reader reads a segment
    # in: "the third HL" means the third in this transaction, never the third in the file. They are
    # resolved here rather than inside the lazy child builder, so realising the children twice
    # cannot renumber them.
    totals = Counter(segment.id for segment in transaction.segments)
    seen: Counter = Counter()
    repeats: List[int] = []
    for segment in transaction.segments:
        repeats.append(seen[segment.id])
        seen[segment.id] += 1

    def children() -> List[NativeNode]:
        """Realise this transaction set's segments, each knowing which repeat of its id it is."""
        return [
            _segment_node(
                segment,
                ordinal=index,
                transaction_path=path,
                repeat_index=repeats[index],
                repeat_count=totals[segment.id],
                raw=scan.segments.get((group_index, ordinal, index)) if scan else None,
                scan=scan,
            )
            for index, segment in enumerate(transaction.segments)
        ]

    return NativeNode(
        kind=KIND_TRANSACTION_SET,
        name=transaction.set_id,
        label=f"Transaction set {transaction.set_id} ({transaction.control_number})",
        ordinal=ordinal,
        attributes=attributes,
        location=_location(st, ordinal=ordinal, path=path),
        children=children,
    )


def _group_node(
    group: X12FunctionalGroup,
    *,
    ordinal: int,
    interchange_path: str,
    scan: Optional[_AlignedScan],
) -> NativeNode:
    """Describe one functional group, its declared controls and its transaction sets."""
    path = f"{interchange_path}/GS[{ordinal}]"
    gs, ge = (scan.groups.get(ordinal, (None, None)) if scan else (None, None))

    attributes: Dict[str, object] = {
        "functionalId": group.functional_id,
        "version": group.version,
        "sender": group.sender,
        "receiver": group.receiver,
        "controlNumber": group.control_number,
        "transactionSetCount": len(group.transaction_sets),
    }
    if scan is not None:
        date = _element_value(gs, scan.delimiters, 4).strip()
        time = _element_value(gs, scan.delimiters, 5).strip()
        agency = _element_value(gs, scan.delimiters, 7).strip()
        if date:
            attributes["date"] = date
        if time:
            attributes["time"] = time
        if agency:
            attributes["responsibleAgencyCode"] = agency
        declared = _int_or_none(_element_value(ge, scan.delimiters, 1))
        if declared is not None:
            attributes["declaredTransactionSetCount"] = declared

    return NativeNode(
        kind=KIND_FUNCTIONAL_GROUP,
        name=group.functional_id,
        label=f"Functional group {group.functional_id} ({group.control_number})",
        ordinal=ordinal,
        attributes=attributes,
        location=_location(gs, ordinal=ordinal, path=path),
        children=lambda: [
            _transaction_node(
                transaction,
                ordinal=index,
                group_path=path,
                group_index=ordinal,
                scan=scan,
            )
            for index, transaction in enumerate(group.transaction_sets)
        ],
    )


def _interchange_node(interchange: X12Interchange, scan: Optional[_AlignedScan]) -> NativeNode:
    """Describe the interchange envelope, its delimiters and its functional groups.

    Envelope identifiers (sender, receiver, control numbers), the delimiters and the declared
    control totals sit in ``attributes`` rather than in ``value``: they are the interchange's
    *structure*, they are already what the canonical model records in its ``x12_envelope`` extras,
    and a renderer needs them to label the tree at all. Element values — the payload — stay in
    ``value``, where the value-visibility policy governs them.
    """
    attributes: Dict[str, object] = {
        "senderId": interchange.sender_id,
        "receiverId": interchange.receiver_id,
        "interchangeVersion": interchange.version,
        "controlNumber": interchange.control_number,
        "elementSeparator": interchange.element_separator,
        "segmentTerminator": interchange.segment_terminator,
        "functionalGroupCount": len(interchange.functional_groups),
    }
    if scan is not None:
        delimiters = scan.delimiters
        attributes["componentSeparator"] = delimiters.component
        # A ``00401`` interchange has no repetition separator at all — the flag says which of "no
        # separator was declared" and "one was declared and nothing repeated" is true here.
        attributes["repetitionSeparatorDeclared"] = delimiters.repetition is not None
        if delimiters.repetition is not None:
            attributes["repetitionSeparator"] = delimiters.repetition
        raw = scan.interchange
        date = _element_value(raw, delimiters, 9).strip()
        time = _element_value(raw, delimiters, 10).strip()
        acknowledgment = _element_value(raw, delimiters, 14).strip()
        usage = _element_value(raw, delimiters, 15).strip()
        if date:
            attributes["date"] = date
        if time:
            attributes["time"] = time
        if acknowledgment:
            attributes["acknowledgmentRequested"] = acknowledgment
        if usage:
            attributes["usageIndicator"] = usage
            attributes["usageIndicatorLabel"] = _USAGE_INDICATORS.get(usage, "Unrecognised code")
        declared = _int_or_none(_element_value(scan.trailer, delimiters, 1))
        if declared is not None:
            attributes["declaredFunctionalGroupCount"] = declared

    return NativeNode(
        kind=KIND_INTERCHANGE,
        name="ISA",
        label=f"Interchange {interchange.control_number}",
        ordinal=0,
        attributes=attributes,
        location=_location(scan.interchange if scan else None, ordinal=0, path="ISA"),
        children=lambda: [
            _group_node(group, ordinal=index, interchange_path="ISA", scan=scan)
            for index, group in enumerate(interchange.functional_groups)
        ],
    )


# ===========================================================================
# Warnings
# ===========================================================================


def _envelope_node_count(interchange: X12Interchange) -> int:
    """Count the interchange/group/transaction-set nodes an analysis must keep.

    The AC behind this module is that a stored X12 analysis retains *all* observed groups and
    transaction sets. Breadth-first admission already keeps envelopes before leaves, but only while
    the budget lasts — an interchange with more envelope nodes than the default budget would still
    lose the tail. Counting them lets :func:`analyze_edix12` raise the budget to fit, so the
    guarantee holds by construction rather than by the shape of a typical file.

    Args:
        interchange: The parsed interchange.

    Returns:
        ``1 + groups + transaction sets``.
    """
    groups = interchange.functional_groups
    return 1 + len(groups) + sum(len(group.transaction_sets) for group in groups)


def _hierarchy_warnings(interchange: X12Interchange) -> List[AnalysisWarning]:
    """Note ``HL`` segments, whose hierarchy this extractor describes only as flat segments.

    Informational, not a partiality: every ``HL`` segment and every element on it is in the tree, in
    source order. What is absent is the parent/child nesting the ``HL`` elements encode, and saying
    so is the difference between a reader concluding "this 837 has no hierarchy" and "this analyzer
    does not build one".

    Args:
        interchange: The parsed interchange.

    Returns:
        A one-entry list when any transaction set carries ``HL`` segments, else empty.
    """
    counts: Counter = Counter()
    for group in interchange.functional_groups:
        for transaction in group.transaction_sets:
            for segment in transaction.segments:
                if segment.id == "HL":
                    counts[transaction.set_id] += 1
    if not counts:
        return []
    total = sum(counts.values())
    sets = ", ".join(sorted(counts))
    return [
        AnalysisWarning(
            code=WARNING_HL_HIERARCHY_FLATTENED,
            severity=SEVERITY_INFO,
            message=(
                f"{total} HL segment(s) in transaction set(s) {sets} are described as segments; "
                "their hierarchy is not modelled."
            ),
        )
    ]


def _canonical_subset_warnings(interchange: X12Interchange) -> List[AnalysisWarning]:
    """State, explicitly, when the canonical conversion read less than the analysis did.

    The normalizer takes the first functional group's first transaction set, because a canonical
    model describes one schema. That is a correct decision and an invisible one: the OpenAPI a
    reader is looking at may have been derived from a fraction of the interchange they imported,
    and nothing on the conversion screens says which fraction. The analysis knows, so it says.

    Args:
        interchange: The parsed interchange.

    Returns:
        A one-entry ``info`` list when more than one transaction set was observed, else empty.
        Informational because nothing was dropped from the *analysis* — every set is in the tree.
    """
    groups = interchange.functional_groups
    observed = sum(len(group.transaction_sets) for group in groups)
    if observed <= 1:
        return []
    first_group = groups[0]
    converted = first_group.transaction_sets[0] if first_group.transaction_sets else None
    converted_label = (
        f"{converted.set_id} ({converted.control_number})" if converted else "the first"
    )
    return [
        AnalysisWarning(
            code=WARNING_CANONICAL_SUBSET,
            severity=SEVERITY_INFO,
            message=(
                f"The canonical model is derived from transaction set {converted_label} in "
                f"functional group {first_group.functional_id} alone. This interchange carries "
                f"{observed} transaction set(s) across {len(groups)} functional group(s); the "
                f"remaining {observed - 1} are described here and nowhere else."
            ),
        )
    ]


def _scan_warnings(scan: Optional[_AlignedScan], *, scan_attempted: bool) -> List[AnalysisWarning]:
    """Note what the source scan could and could not supply.

    Args:
        scan: The aligned scan, when the two readings agreed.
        scan_attempted: Whether there was source text to scan at all.

    Returns:
        Informational warnings: the positions are missing, the positions stop partway, or the parser
        dropped envelope/acknowledgement segments the source carried. All ``info`` — the tree is
        complete in every case, and only its locations or its trailers are affected.
    """
    warnings: List[AnalysisWarning] = []
    if scan is None:
        if scan_attempted:
            warnings.append(
                AnalysisWarning(
                    code=WARNING_SCAN_UNALIGNED,
                    severity=SEVERITY_INFO,
                    message=(
                        "The interchange text could not be matched to the parsed segments, so "
                        "constructs locate by envelope path and ordinal rather than by source "
                        "range, and element positions left empty are not distinguishable."
                    ),
                )
            )
        return warnings

    if not scan.complete:
        warnings.append(
            AnalysisWarning(
                code=WARNING_SCAN_TRUNCATED,
                severity=SEVERITY_INFO,
                message=(
                    "The interchange has more segments than one scan records, so constructs past "
                    "the scan limit carry no source range. Every construct is still in the tree."
                ),
            )
        )

    acknowledgements = scan.dropped_ids.get("TA1", 0)
    if acknowledgements:
        warnings.append(
            AnalysisWarning(
                code=WARNING_TRAILERS_DROPPED,
                severity=SEVERITY_INFO,
                message=(
                    f"This interchange carries {acknowledgements} TA1 acknowledgement segment(s). "
                    "The parser removes them before this analysis, so they are in your source and "
                    "not in this tree."
                ),
            )
        )
    return warnings


# ===========================================================================
# Entry point
# ===========================================================================


def analyze_edix12(
    document: EdiX12Document,
    *,
    source: Optional[str] = None,
    source_format: str = EDIX12_ANALYZER_KEY,
    max_nodes: int = MAX_TREE_NODES,
    max_depth: int = MAX_TREE_DEPTH,
) -> PayloadAnalysisDocument:
    """Describe a parsed X12 interchange as a payload analysis.

    Args:
        document: The parsed interchange (:func:`app.edix12_parser.parse_edix12`).
        source: The exact interchange text analysed, hashed into ``source_hash`` and scanned for
            source positions. Defaults to the document's own retained ``raw`` text, which is what
            was parsed — so the scan and the parse describe the same bytes by construction.
        source_format: Adapter key recorded on the record.
        max_nodes: Node budget. Raised, if it is smaller, to fit every envelope node the interchange
            contains — a bounded X12 analysis drops elements, never groups or transaction sets.
        max_depth: Depth budget; the X12 envelope is seven levels deep with repetitions, so the
            default is ample.

    Returns:
        The analysis document, with observed element values still on it —
        :func:`app.payload_analysis_store.store_analysis` applies the value-visibility policy.
    """
    interchange = document.interchange
    text = source if source is not None else document.raw
    scan = _align_scan(interchange, text) if text else None

    # Never below the requested budget, never above what a single analysis may visit: an interchange
    # whose envelope alone exceeds the visit cap is bounded like anything else, and says so.
    effective_nodes = min(MAX_VISITED_NODES, max(max_nodes, _envelope_node_count(interchange)))

    warnings = (
        _hierarchy_warnings(interchange)
        + _canonical_subset_warnings(interchange)
        + _scan_warnings(scan, scan_attempted=bool(text))
    )

    return build_analysis_document(
        roots=[_interchange_node(interchange, scan)],
        analyzer=AnalyzerInfo(
            key=EDIX12_ANALYZER_KEY,
            version=EDIX12_ANALYZER_VERSION,
            tool_versions=edix12_tool_versions(),
        ),
        capabilities=edix12_capabilities(
            max_nodes=effective_nodes, source_positions=scan is not None
        ),
        source=text,
        source_format=source_format,
        warnings=warnings,
        max_nodes=effective_nodes,
        max_depth=max_depth,
    )
