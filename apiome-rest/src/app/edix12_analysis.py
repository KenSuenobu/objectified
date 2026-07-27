"""EDI X12 native-analysis extractor — CPDO-1.2 (#4795).

The X12 canonical normalizer (:mod:`app.edix12_normalizer`) reads
``interchange.functional_groups[0].transaction_sets[0]`` and normalizes that one transaction set into
types. It is the right thing for a *canonical* model — one interchange describes one schema — but it
means a file carrying an 850 and an 810 in two functional groups imports as though the second did not
exist. Nothing downstream can tell an interchange that had one transaction set from one that had six.

This extractor is where the rest survives. It walks **every** functional group and **every**
transaction set the parser produced, in source order, and describes them in X12's own vocabulary:

.. code-block:: text

    interchange            ISA — delimiters, control number, sender/receiver
      functional_group     GS  — functional id, version, group control number
        transaction_set    ST  — set id (850/810/…), transaction control number
          segment          BEG, N1, PO1 … in position order
            element        BEG01 … with presence and length
            composite      BEG05 — with its component sub-elements

Guarantees
----------
**Every group and transaction set is kept.** A bounded analysis drops leaves, never envelopes: the
node budget is raised, if needed, to at least the number of envelope nodes the interchange contains
(:func:`_envelope_node_count`), so elements are what a large interchange loses. That is the ordering
the record is useful under — an envelope explains what a payload *is*, an arbitrary handful of its
elements does not.

**Composites are modelled, not flattened.** ``pyx12`` reports a composite's components as separate
values sharing one element position (``BEG05``, refdes ``BEG05-1``/``BEG05-2``), and
:mod:`app.edix12_parser` keeps them as sibling elements. Here they are regrouped under a
``composite`` node, so the analysis says what the source said.

Limits, stated rather than implied
----------------------------------
``pyx12``'s value iterator skips empty elements entirely, so an element that was present-and-empty is
indistinguishable from one that was absent — the analysis reports what it can see, and declares
``x12.empty_elements`` unsupported rather than inventing positions. The parser likewise discards
``TA1`` acknowledgements and ``IEA`` trailers before this extractor sees the AST, and it does not
infer ``HL`` hierarchies. Each of those is a capability boundary the record names, so a reader asking
"why is there no TA1 here?" gets an answer instead of an absence.
"""

from __future__ import annotations

from collections import Counter
from typing import Dict, List, Optional, Sequence

from .edix12_parser import (
    EdiX12Document,
    X12Element,
    X12FunctionalGroup,
    X12Interchange,
    X12Segment,
    X12TransactionSet,
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
    "KIND_SEGMENT",
    "KIND_TRANSACTION_SET",
    "WARNING_HL_HIERARCHY_FLATTENED",
    "analyze_edix12",
    "edix12_capabilities",
    "edix12_tool_versions",
]

#: Analyzer key recorded on every record this module produces.
EDIX12_ANALYZER_KEY = "edix12"
#: Version of this extractor. Bump when the emitted tree changes shape.
EDIX12_ANALYZER_VERSION = "1.0.0"

#: The X12 envelope, in nesting order.
KIND_INTERCHANGE = "interchange"
KIND_FUNCTIONAL_GROUP = "functional_group"
KIND_TRANSACTION_SET = "transaction_set"
KIND_SEGMENT = "segment"
KIND_ELEMENT = "element"
KIND_COMPOSITE = "composite"
KIND_COMPONENT = "component"

#: Emitted when a transaction set carries ``HL`` segments. They are all in the tree, in order — what
#: is missing is the *hierarchy* they encode, which this extractor does not infer. Informational on
#: purpose: nothing observed was dropped, so the record stays ``available``.
WARNING_HL_HIERARCHY_FLATTENED = "x12.hl_hierarchy_flattened"


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


def edix12_capabilities(*, max_nodes: int = MAX_TREE_NODES) -> AnalyzerCapabilities:
    """Return what this extractor models, and what it knowingly does not.

    Args:
        max_nodes: The node budget the record was produced under. It is recorded rather than assumed
            because :func:`analyze_edix12` raises it when an interchange has more envelope nodes than
            the default budget, and a reader comparing two records should see that.

    Returns:
        The :class:`~app.payload_analysis.AnalyzerCapabilities` for an X12 analysis.
    """
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
        ],
        unsupported=[
            # pyx12's value iterator omits empty elements, so a present-but-empty element and an
            # absent one arrive here identically. Positions are never invented to cover the gap.
            "x12.empty_elements",
            # HL loops are described as the segments they are, not as the hierarchy they encode.
            "x12.hl_hierarchy",
            # The parser drops these before this extractor sees the AST.
            "x12.ta1_acknowledgement",
            "x12.iea_trailer",
            # Repetition separators are not split into repeated occurrences.
            "x12.repeating_elements",
            # The AST carries no source positions, so nodes locate by ordinal and path only.
            "x12.byte_offsets",
            # No 4010/5010 implementation-guide conformance is evaluated.
            "x12.implementation_guide_validation",
        ],
        limits=analysis_limits(max_nodes=max_nodes),
    )


def _element_nodes(
    elements: Sequence[X12Element],
    *,
    segment_path: str,
) -> List[NativeNode]:
    """Describe one segment's elements, regrouping composite components.

    ``pyx12`` reports a composite as several values sharing one element position, distinguished by a
    ``SEG05-2``-style refdes. Elements are therefore grouped by position: a position with a single
    non-composite value becomes an ``element``; a position with components becomes a ``composite``
    whose children are its ``component``\\s, in source order.

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
                    attributes={"position": member.position},
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
                attributes={"position": position, "componentCount": len(members)},
                location=SourceLocation(ordinal=ordinal, path=composite_path),
                children=[
                    NativeNode(
                        kind=KIND_COMPONENT,
                        name=member.ref,
                        ordinal=component_ordinal,
                        attributes={"position": member.position},
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


def _segment_node(segment: X12Segment, *, ordinal: int, transaction_path: str) -> NativeNode:
    """Describe one segment and its elements.

    Args:
        segment: The parsed segment.
        ordinal: Its position within the transaction set, 0-based.
        transaction_path: The parent transaction set's path.

    Returns:
        The ``segment`` node; its elements are built lazily so a segment the budget refuses costs
        nothing to skip.
    """
    path = f"{transaction_path}/{segment.id}[{ordinal}]"
    return NativeNode(
        kind=KIND_SEGMENT,
        name=segment.id,
        ordinal=ordinal,
        attributes={"segmentId": segment.id, "elementCount": len(segment.elements)},
        location=SourceLocation(ordinal=ordinal, path=path),
        children=lambda: _element_nodes(segment.elements, segment_path=path),
    )


def _transaction_node(
    transaction: X12TransactionSet, *, ordinal: int, group_path: str
) -> NativeNode:
    """Describe one transaction set and its segments."""
    path = f"{group_path}/ST[{ordinal}]"
    return NativeNode(
        kind=KIND_TRANSACTION_SET,
        name=transaction.set_id,
        label=f"Transaction set {transaction.set_id} ({transaction.control_number})",
        ordinal=ordinal,
        attributes={
            "setId": transaction.set_id,
            "controlNumber": transaction.control_number,
            "segmentCount": len(transaction.segments),
        },
        location=SourceLocation(ordinal=ordinal, path=path),
        children=lambda: [
            _segment_node(segment, ordinal=index, transaction_path=path)
            for index, segment in enumerate(transaction.segments)
        ],
    )


def _group_node(group: X12FunctionalGroup, *, ordinal: int, interchange_path: str) -> NativeNode:
    """Describe one functional group and its transaction sets."""
    path = f"{interchange_path}/GS[{ordinal}]"
    return NativeNode(
        kind=KIND_FUNCTIONAL_GROUP,
        name=group.functional_id,
        label=f"Functional group {group.functional_id} ({group.control_number})",
        ordinal=ordinal,
        attributes={
            "functionalId": group.functional_id,
            "version": group.version,
            "sender": group.sender,
            "receiver": group.receiver,
            "controlNumber": group.control_number,
            "transactionSetCount": len(group.transaction_sets),
        },
        location=SourceLocation(ordinal=ordinal, path=path),
        children=lambda: [
            _transaction_node(transaction, ordinal=index, group_path=path)
            for index, transaction in enumerate(group.transaction_sets)
        ],
    )


def _interchange_node(interchange: X12Interchange) -> NativeNode:
    """Describe the interchange envelope and its functional groups.

    Envelope identifiers (sender, receiver, control numbers) and the delimiters sit in
    ``attributes`` rather than in ``value``: they are the interchange's *structure*, they are already
    what the canonical model records in its ``x12_envelope`` extras, and a renderer needs them to
    label the tree at all. Element values — the payload — stay in ``value``, where the
    value-visibility policy governs them.
    """
    return NativeNode(
        kind=KIND_INTERCHANGE,
        name="ISA",
        label=f"Interchange {interchange.control_number}",
        ordinal=0,
        attributes={
            "senderId": interchange.sender_id,
            "receiverId": interchange.receiver_id,
            "interchangeVersion": interchange.version,
            "controlNumber": interchange.control_number,
            "elementSeparator": interchange.element_separator,
            "segmentTerminator": interchange.segment_terminator,
            "functionalGroupCount": len(interchange.functional_groups),
        },
        location=SourceLocation(ordinal=0, path="ISA"),
        children=lambda: [
            _group_node(group, ordinal=index, interchange_path="ISA")
            for index, group in enumerate(interchange.functional_groups)
        ],
    )


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
        source: The exact interchange text analysed, hashed into ``source_hash``. Defaults to the
            document's own retained ``raw`` text, which is what was parsed.
        source_format: Adapter key recorded on the record.
        max_nodes: Node budget. Raised, if it is smaller, to fit every envelope node the interchange
            contains — a bounded X12 analysis drops elements, never groups or transaction sets.
        max_depth: Depth budget; the X12 envelope is six levels deep, so the default is ample.

    Returns:
        The analysis document, with observed element values still on it —
        :func:`app.payload_analysis_store.store_analysis` applies the value-visibility policy.
    """
    interchange = document.interchange
    # Never below the requested budget, never above what a single analysis may visit: an interchange
    # whose envelope alone exceeds the visit cap is bounded like anything else, and says so.
    effective_nodes = min(MAX_VISITED_NODES, max(max_nodes, _envelope_node_count(interchange)))

    return build_analysis_document(
        roots=[_interchange_node(interchange)],
        analyzer=AnalyzerInfo(
            key=EDIX12_ANALYZER_KEY,
            version=EDIX12_ANALYZER_VERSION,
            tool_versions=edix12_tool_versions(),
        ),
        capabilities=edix12_capabilities(max_nodes=effective_nodes),
        source=source if source is not None else document.raw,
        source_format=source_format,
        warnings=_hierarchy_warnings(interchange),
        max_nodes=effective_nodes,
        max_depth=max_depth,
    )
