"""Native-analysis extractors and the analyzer SPI — CPDO-1.2 (#4795).

CPDO-1.1 defined what a payload analysis *is* (:mod:`app.payload_analysis`) and where it lives
(:mod:`app.payload_analysis_store`), and left every revision reading back as a declared
``unavailable`` record because nothing produced one. This module is what produces them.

The shape of the problem
------------------------
An import parses its source into the format's own AST, normalizes that AST into the canonical model,
and drops the AST on the floor. Everything the canonical model has no word for — an X12 functional
group, a segment's position in its transaction set, a copybook level number or OCCURS bound — exists
only for the duration of one function call. A catalog detail read that wants it has to re-parse the
source, which means the answer depends on today's parser rather than on what was actually imported.

So the AST is analysed **while it is still in hand**: after parse, before persistence. The analysis
is a bounded, redaction-safe description of what the analyzer observed, stored against the revision
it describes.

What an analyzer is
-------------------
An analyzer is three things an adapter declares (see :class:`~app.import_source.ImportSource`):

* :attr:`~app.import_source.ImportSource.analyzer_key` / ``analyzer_version`` — identity, so a record
  produced by ``edix12@1.0.0`` is never mistaken for one produced by a later extractor;
* :meth:`~app.import_source.ImportSource.analysis_capabilities` — what it models and what it
  knowingly does not, so an absent construct is explainable rather than ambiguous;
* :meth:`~app.import_source.ImportSource.analyze` — the extractor itself, which walks the native AST
  and emits :class:`NativeNode`\\s.

An adapter that declares none of them still gets an analysis: the default implementation runs
:func:`generic_analysis` over whatever the AST is (mappings, sequences, dataclasses, Pydantic
models), which produces a real — if format-blind — structural record. A format with a native
extractor overrides ``analyze`` and produces its own vocabulary
(:mod:`app.edix12_analysis`, :mod:`app.cobolcopybook_analysis`).

Why :class:`NativeNode` and not :class:`~app.payload_analysis.AnalysisNode`
--------------------------------------------------------------------------
An analyzer describes the source; the *budget* decides how much of that description is kept. If
analyzers built :class:`~app.payload_analysis.AnalysisNode` trees directly, a large interchange
would materialise hundreds of thousands of validated models before anything trimmed them — the
budget would bound what is *stored* without bounding what is *built*.

:class:`NativeNode` is the cheap description an analyzer emits, and its children may be a *callable*
so a subtree is only realised if the budget will admit it. :func:`build_analysis_tree` walks those
descriptions breadth-first, admitting whole levels in order until the node budget runs out. That
ordering is the reason an X12 record keeps every interchange, functional group and transaction set
even when its elements are dropped: envelopes sit at the top of the tree, and the top of the tree is
what a breadth-first budget keeps.

Bounding is bounded in turn. Counting what was dropped means visiting it, so visiting is itself
capped at :data:`MAX_VISITED_NODES`; past that the record says its dropped count is a floor rather
than quietly reporting a small number for an enormous source.

Values
------
Extractors emit observed values on the nodes that have them, and **never** in ``attributes``.
:func:`~app.payload_analysis.apply_value_visibility` — run by
:func:`~app.payload_analysis_store.store_analysis` before the write — is what decides whether those
values are kept, and under the default ``structural`` policy they are not. That split is deliberate:
an extractor's job is to observe accurately, and exactly one place decides what may be stored. An
extractor that hid values from itself would make the ``full`` policy unimplementable, and one that
put them in ``attributes`` would route them around the policy entirely.
"""

from __future__ import annotations

import dataclasses
import logging
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence, Tuple, Union

from pydantic import BaseModel

from .payload_analysis import (
    MAX_TREE_DEPTH,
    MAX_TREE_NODES,
    MAX_VALUE_PREVIEW_CHARS,
    REASON_ANALYZER_FAILED,
    REASON_BOUNDS_EXCEEDED,
    REASON_NO_SOURCE_CAPTURED,
    REASON_UNSUPPORTED_FORMAT,
    SEVERITY_ERROR,
    SEVERITY_INFO,
    SEVERITY_WARNING,
    STATUS_AVAILABLE,
    STATUS_PARTIAL,
    AnalysisNode,
    AnalysisWarning,
    AnalyzerCapabilities,
    AnalyzerInfo,
    PayloadAnalysisDocument,
    SourceLocation,
    analyzer_capabilities,
    bound_tree,
    source_digest,
    unavailable_document,
)

logger = logging.getLogger(__name__)

__all__ = [
    "BuiltTree",
    "GENERIC_ANALYZER_KEY",
    "GENERIC_ANALYZER_VERSION",
    "GENERIC_CAPABILITIES",
    "KIND_ARRAY",
    "KIND_OBJECT",
    "KIND_OPAQUE",
    "KIND_SCALAR",
    "MAX_VISITED_NODES",
    "NativeNode",
    "WARNING_SCAN_BUDGET_EXHAUSTED",
    "analysis_limits",
    "analyze_import",
    "build_analysis_document",
    "build_analysis_tree",
    "generic_analysis",
    "generic_native_nodes",
]


# ---------------------------------------------------------------------------
# Vocabulary
# ---------------------------------------------------------------------------

#: Analyzer key used when an adapter declares no native extractor of its own.
GENERIC_ANALYZER_KEY = "generic"
#: Version of the generic extractor below. Bumped when the tree it produces changes shape, so a
#: reader can tell a record produced by this walk from one produced by a later one.
GENERIC_ANALYZER_VERSION = "1.0.0"

#: A JSON-object-shaped construct (a mapping, a dataclass, a Pydantic model).
KIND_OBJECT = "object"
#: An ordered collection.
KIND_ARRAY = "array"
#: A leaf that carried a value.
KIND_SCALAR = "scalar"
#: A leaf the generic walk has no vocabulary for. It is recorded — with its Python type — rather than
#: dropped, because "the analyzer met something it could not describe" is information, and rendering
#: an unknown object's ``repr`` into the record would be a way to smuggle payload material past the
#: value-visibility policy.
KIND_OPAQUE = "opaque"

#: How many native constructs one analysis may *visit*. Admission is capped at
#: :data:`~app.payload_analysis.MAX_TREE_NODES`; this caps the counting of what was dropped, which is
#: otherwise unbounded — a 200 MB interchange must not be walked in full just to report how much of
#: it did not fit. Past this cap the record says so (:data:`WARNING_SCAN_BUDGET_EXHAUSTED`) and its
#: ``droppedNodeCount`` is a floor.
MAX_VISITED_NODES = 10 * MAX_TREE_NODES

#: Warning code raised when :data:`MAX_VISITED_NODES` was reached, so a reader knows the dropped
#: count is a lower bound rather than an exact one.
WARNING_SCAN_BUDGET_EXHAUSTED = "analysis.visit_budget_exhausted"

#: Attribute-container nesting the record keeps. Attributes carry format semantics (PIC clauses,
#: element positions), not payload structure — anything deeper is the tree's job.
_MAX_ATTRIBUTE_DEPTH = 2


def analysis_limits(
    *, max_nodes: int = MAX_TREE_NODES, max_depth: int = MAX_TREE_DEPTH
) -> Dict[str, int]:
    """Return the numeric bounds an analysis ran under, for its capability block.

    Args:
        max_nodes: The node budget in force.
        max_depth: The depth budget in force.

    Returns:
        The limits mapping recorded on :class:`~app.payload_analysis.AnalyzerCapabilities`.
    """
    return {
        "maxNodes": int(max_nodes),
        "maxDepth": int(max_depth),
        "maxVisitedNodes": int(MAX_VISITED_NODES),
        "valuePreviewChars": int(MAX_VALUE_PREVIEW_CHARS),
    }


#: What the generic walk can say about any AST: containers, ordered collections, and leaves. It
#: models no format semantics at all, and says so — a reader looking for X12 envelopes in a record
#: produced by this analyzer learns from ``unsupported`` that their absence is the analyzer's
#: boundary and not the source's content.
GENERIC_CAPABILITIES = analyzer_capabilities(
    supported=[
        "generic.object",
        "generic.array",
        "generic.scalar",
        "generic.value_presence",
    ],
    unsupported=[
        "generic.format_semantics",
        "generic.source_locations",
    ],
    limits=analysis_limits(),
)


# ---------------------------------------------------------------------------
# The analyzer-facing node description
# ---------------------------------------------------------------------------

#: Children of a :class:`NativeNode`: either a materialised sequence, or a callable returning one so
#: a subtree the budget will refuse is never built.
ChildSource = Union[Sequence["NativeNode"], Callable[[], Sequence["NativeNode"]]]


@dataclass(frozen=True)
class NativeNode:
    """One observed construct, as the analyzer that saw it describes it.

    The cheap counterpart of :class:`~app.payload_analysis.AnalysisNode`: same information, no
    validation, and children that may still be unrealised. :func:`build_analysis_tree` converts the
    ones that fit the budget and never touches the ones that do not.

    Attributes:
        kind: The analyzer's own term for this construct (``segment``, ``element``, ``group``).
        name: Its name in the source (segment id, field name, element reference).
        label: Human-facing label, when ``name`` alone reads poorly.
        ordinal: Position among its siblings, preserving source order.
        attributes: Format semantics — PICTURE clauses, OCCURS bounds, element positions. Never
            payload values: attributes are outside the value-visibility policy.
        location: Where the construct sits in the source.
        value_present: Whether the source carried a value here. An X12 element can be present and
            empty, which is not the same as absent.
        value_length: Length of the observed value.
        value: The observed value. Kept only if the record's value-visibility policy allows it — the
            analyzer states what it saw and the store decides what is kept.
        children: Child constructs, in source order, or a callable returning them.
    """

    kind: str
    name: Optional[str] = None
    label: Optional[str] = None
    ordinal: Optional[int] = None
    attributes: Mapping[str, Any] = field(default_factory=dict)
    location: Optional[SourceLocation] = None
    value_present: Optional[bool] = None
    value_length: Optional[int] = None
    value: Optional[str] = None
    children: ChildSource = ()

    def child_nodes(self) -> Sequence["NativeNode"]:
        """Realise this node's children.

        Returns:
            The child nodes; the empty tuple when it has none. Calling a child *callable* is the
            moment a lazy subtree is built, which is why :func:`build_analysis_tree` only calls it
            for nodes it has already admitted.
        """
        source = self.children
        if callable(source):
            return tuple(source())
        return tuple(source)


@dataclass(frozen=True)
class BuiltTree:
    """The outcome of walking an analyzer's :class:`NativeNode`\\s under a budget.

    Attributes:
        roots: The admitted :class:`~app.payload_analysis.AnalysisNode` roots.
        dropped: How many constructs the budget refused. A floor rather than an exact count when
            ``visit_exhausted``.
        visit_exhausted: True when :data:`MAX_VISITED_NODES` was reached, so counting stopped before
            the source did.
    """

    roots: List[AnalysisNode]
    dropped: int
    visit_exhausted: bool

    @property
    def truncated(self) -> bool:
        """Whether anything the source contained is missing from :attr:`roots`."""
        return self.dropped > 0


# ---------------------------------------------------------------------------
# Budgeted construction
# ---------------------------------------------------------------------------


def _safe_attribute(value: Any, depth: int = 0) -> Any:
    """Coerce one attribute value into something JSON-storable, or drop it.

    Attributes are format semantics an analyzer chose to record, and they are stored verbatim in
    JSONB — so anything that is not a JSON scalar or a small container of them is dropped rather
    than stringified. Stringifying would put an arbitrary object's ``repr`` into the record, which is
    both non-deterministic (ids, addresses) and a way for payload material to reach storage without
    passing the value-visibility policy.

    Args:
        value: The attribute value an analyzer supplied.
        depth: Current container nesting; containers deeper than :data:`_MAX_ATTRIBUTE_DEPTH` are
            dropped.

    Returns:
        The JSON-storable value, or ``None`` when it cannot be represented.
    """
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    if depth >= _MAX_ATTRIBUTE_DEPTH:
        return None
    if isinstance(value, Mapping):
        out: Dict[str, Any] = {}
        for key, item in value.items():
            coerced = _safe_attribute(item, depth + 1)
            if coerced is not None:
                out[str(key)] = coerced
        return out or None
    if isinstance(value, (list, tuple, set, frozenset)):
        items = [_safe_attribute(item, depth + 1) for item in value]
        kept = [item for item in items if item is not None]
        return kept or None
    return None


def _safe_attributes(attributes: Mapping[str, Any]) -> Dict[str, Any]:
    """Coerce an analyzer's attribute bag, dropping what cannot be stored.

    Args:
        attributes: The analyzer-supplied attributes.

    Returns:
        The storable subset, in the analyzer's own key order (which is deterministic for a given
        parse, and is what a renderer reads top to bottom).
    """
    out: Dict[str, Any] = {}
    for key, value in attributes.items():
        coerced = _safe_attribute(value)
        if coerced is not None:
            out[str(key)] = coerced
    return out


def _node_id(path: Tuple[int, ...]) -> str:
    """Return the stable node id for a position in the tree.

    The id is the dotted index path from the root (``0``, ``0.3``, ``0.3.11``), so it depends only on
    where the construct sits in the source — not on admission order, not on how many siblings were
    dropped. That is what lets a warning or a later projection reference cite a node and still
    resolve against a re-analysis of the same bytes.

    Args:
        path: The index path from the root.

    Returns:
        The node id.
    """
    return ".".join(str(index) for index in path)


def _to_analysis_node(native: NativeNode, path: Tuple[int, ...]) -> AnalysisNode:
    """Convert one admitted :class:`NativeNode` into a contract node (without its children)."""
    return AnalysisNode(
        id=_node_id(path),
        kind=native.kind,
        name=native.name,
        label=native.label,
        ordinal=native.ordinal,
        attributes=_safe_attributes(native.attributes),
        location=native.location,
        value_present=native.value_present,
        value_length=native.value_length,
        value=native.value,
        children=[],
    )


def build_analysis_tree(
    roots: Sequence[NativeNode],
    *,
    max_nodes: int = MAX_TREE_NODES,
    max_depth: int = MAX_TREE_DEPTH,
    max_visits: int = MAX_VISITED_NODES,
) -> BuiltTree:
    """Walk an analyzer's node descriptions under the node/depth budget.

    Breadth-first, admitting whole levels in source order until the node budget is spent, so what
    survives a bounded analysis is the *top* of the structure. For an X12 interchange that means
    every functional group and transaction set is kept and elements are what get dropped, which is
    the ordering the record is useful under: an envelope explains a payload, an arbitrary handful of
    its leaves does not.

    Children of an admitted node are realised (a lazy child callable is invoked here); children of a
    refused node are realised only to be counted, and only while the visit budget lasts.

    Args:
        roots: The analyzer's root descriptions.
        max_nodes: Maximum nodes to admit.
        max_depth: Maximum depth to admit; a node below it is refused with its subtree.
        max_visits: Maximum constructs to visit at all. Reaching it stops the walk and marks the
            dropped count as a floor.

    Returns:
        The :class:`BuiltTree`.
    """
    node_budget = max(0, int(max_nodes))
    depth_budget = max(0, int(max_depth))
    visit_budget = max(0, int(max_visits))

    admitted_roots: List[AnalysisNode] = []
    admitted = 0
    dropped = 0
    visited = 0
    visit_exhausted = False

    # (native, parent node or None for a root, index path, depth, whether it may be admitted at all)
    queue: deque = deque(
        (native, None, (index,), 1, True) for index, native in enumerate(roots)
    )

    while queue:
        native, parent, path, depth, attachable = queue.popleft()
        visited += 1
        if visited > visit_budget:
            # Stop expanding: the remaining queue is counted, its descendants are not, and the record
            # says as much rather than reporting a comfortable number.
            visit_exhausted = True
            dropped += 1
            continue

        admit = attachable and admitted < node_budget and depth <= depth_budget
        node: Optional[AnalysisNode] = None
        if admit:
            node = _to_analysis_node(native, path)
            admitted += 1
            if parent is None:
                admitted_roots.append(node)
            else:
                parent.children.append(node)
        else:
            dropped += 1

        for index, child in enumerate(native.child_nodes()):
            queue.append((child, node, path + (index,), depth + 1, admit))

    return BuiltTree(roots=admitted_roots, dropped=dropped, visit_exhausted=visit_exhausted)


# ---------------------------------------------------------------------------
# Document assembly
# ---------------------------------------------------------------------------


def build_analysis_document(
    *,
    roots: Sequence[NativeNode],
    analyzer: AnalyzerInfo,
    capabilities: AnalyzerCapabilities,
    source: Optional[Union[str, bytes]],
    source_format: Optional[str] = None,
    warnings: Sequence[AnalysisWarning] = (),
    max_nodes: int = MAX_TREE_NODES,
    max_depth: int = MAX_TREE_DEPTH,
    max_visits: int = MAX_VISITED_NODES,
) -> PayloadAnalysisDocument:
    """Assemble one analyzer's output into a storable analysis document.

    The single place that decides a record's *status*, so every extractor reports absence and
    partiality the same way:

    * no source bytes to name → ``unavailable`` / ``no_source_captured``. A record that described
      bytes it cannot identify would not be checkable, so it is not written;
    * the analyzer produced nothing → ``unavailable`` / ``unsupported_format``. An empty tree
      claiming to be ``available`` is the exact lie CPDO-1.1 exists to prevent;
    * the budget dropped something → ``partial`` / ``bounds_exceeded``;
    * the analyzer warned about a construct it could not model → ``partial`` /
      ``unsupported_format``. The tree is real and incomplete, and the warning says where;
    * otherwise → ``available``.

    Args:
        roots: The analyzer's root node descriptions.
        analyzer: Identity of the analyzer that produced them.
        capabilities: What that analyzer models and does not.
        source: The exact material analysed, hashed into ``source_hash``.
        source_format: Adapter key of the analysed source.
        warnings: What the analyzer could not do. An ``info`` warning is commentary; a ``warning`` or
            ``error`` one makes the record ``partial``.
        max_nodes: Node budget.
        max_depth: Depth budget.
        max_visits: Visit budget; reaching it makes the record's dropped count a floor and says so.

    Returns:
        A storable :class:`~app.payload_analysis.PayloadAnalysisDocument`. Values (if any) are still
        on it — :func:`~app.payload_analysis_store.store_analysis` applies the visibility policy.
    """
    collected: List[AnalysisWarning] = list(warnings)

    if source is None:
        return unavailable_document(
            REASON_NO_SOURCE_CAPTURED,
            source_format=source_format,
            message="No source material was captured for this revision, so there is nothing to analyze.",
            analyzer=analyzer,
            capabilities=capabilities,
        )

    built = build_analysis_tree(
        roots, max_nodes=max_nodes, max_depth=max_depth, max_visits=max_visits
    )
    if not built.roots:
        return unavailable_document(
            REASON_UNSUPPORTED_FORMAT,
            source_format=source_format,
            message=(
                f"The {analyzer.key!r} analyzer produced no native structure for this source."
            ),
            analyzer=analyzer,
            capabilities=capabilities,
        )

    if built.visit_exhausted:
        collected.append(
            AnalysisWarning(
                code=WARNING_SCAN_BUDGET_EXHAUSTED,
                severity=SEVERITY_INFO,
                message=(
                    f"Stopped after visiting {max_visits} constructs; the dropped-node count is a "
                    "lower bound."
                ),
            )
        )

    # A second pass through the shared budget: the walk above already respects it, so this is a
    # no-op in practice and the single enforcement point in principle. Its metrics describe the
    # stored tree; the walk's own drop count is what the source had beyond it.
    tree, metrics = bound_tree(built.roots, max_nodes=max_nodes, max_depth=max_depth)
    dropped_total = built.dropped + metrics.dropped_node_count
    truncated = built.truncated or metrics.truncated
    metrics = metrics.model_copy(
        update={
            "truncated": truncated,
            "dropped_node_count": dropped_total,
            "warning_count": len(collected),
        }
    )

    blocking = any(
        warning.severity in (SEVERITY_WARNING, SEVERITY_ERROR) for warning in collected
    )
    if truncated:
        status, reason = STATUS_PARTIAL, REASON_BOUNDS_EXCEEDED
    elif blocking:
        status, reason = STATUS_PARTIAL, REASON_UNSUPPORTED_FORMAT
    else:
        status, reason = STATUS_AVAILABLE, None

    return PayloadAnalysisDocument(
        status=status,
        status_reason=reason,
        source_format=source_format,
        source_hash=source_digest(source),
        analyzer=analyzer,
        capabilities=capabilities,
        tree=tree,
        metrics=metrics,
        warnings=collected,
    )


# ---------------------------------------------------------------------------
# The generic extractor
# ---------------------------------------------------------------------------


def _mapping_of(value: Any) -> Optional[Mapping[str, Any]]:
    """Return ``value`` as a name→value mapping when it is object-shaped, else ``None``.

    Recognises plain mappings, dataclass instances, and Pydantic models — the three shapes an
    adapter's native AST is built from in this codebase — so the generic walk describes a typed AST
    as usefully as it describes a parsed JSON document.
    """
    if isinstance(value, Mapping):
        return value
    if isinstance(value, BaseModel):
        return {name: getattr(value, name, None) for name in type(value).model_fields}
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {f.name: getattr(value, f.name, None) for f in dataclasses.fields(value)}
    return None


def _generic_node(
    value: Any,
    *,
    name: Optional[str],
    ordinal: Optional[int],
    path: str,
) -> NativeNode:
    """Describe one native value, deferring its children until the budget asks for them.

    Args:
        value: The native value.
        name: Its key in the parent mapping, when it had one.
        ordinal: Its index in the parent collection, when it had one.
        path: The ``$.a.b[0]``-style path recorded as the node's source location, which is all the
            location a format-blind walk can honestly claim (it has no line or offset information).

    Returns:
        The :class:`NativeNode`.
    """
    location = SourceLocation(path=path)
    mapping = _mapping_of(value)
    if mapping is not None:
        items = list(mapping.items())
        attributes: Dict[str, Any] = {"memberCount": len(items)}
        if not isinstance(value, Mapping):
            attributes["nativeType"] = type(value).__name__
        return NativeNode(
            kind=KIND_OBJECT,
            name=name,
            ordinal=ordinal,
            attributes=attributes,
            location=location,
            children=lambda: [
                _generic_node(item, name=str(key), ordinal=index, path=f"{path}.{key}")
                for index, (key, item) in enumerate(items)
            ],
        )

    if isinstance(value, (list, tuple)):
        items = list(value)
        return NativeNode(
            kind=KIND_ARRAY,
            name=name,
            ordinal=ordinal,
            attributes={"itemCount": len(items)},
            location=location,
            children=lambda: [
                _generic_node(item, name=None, ordinal=index, path=f"{path}[{index}]")
                for index, item in enumerate(items)
            ],
        )

    if value is None:
        return NativeNode(
            kind=KIND_SCALAR,
            name=name,
            ordinal=ordinal,
            attributes={"scalarType": "null"},
            location=location,
            value_present=False,
        )

    if isinstance(value, bool):
        text = "true" if value else "false"
        return NativeNode(
            kind=KIND_SCALAR,
            name=name,
            ordinal=ordinal,
            attributes={"scalarType": "boolean"},
            location=location,
            value_present=True,
            value_length=len(text),
            value=text,
        )

    if isinstance(value, (int, float)):
        text = str(value)
        return NativeNode(
            kind=KIND_SCALAR,
            name=name,
            ordinal=ordinal,
            attributes={"scalarType": "number"},
            location=location,
            value_present=True,
            value_length=len(text),
            value=text,
        )

    if isinstance(value, str):
        return NativeNode(
            kind=KIND_SCALAR,
            name=name,
            ordinal=ordinal,
            attributes={"scalarType": "string"},
            location=location,
            value_present=True,
            value_length=len(value),
            value=value,
        )

    if isinstance(value, (bytes, bytearray)):
        # Length only, never a decode: binary source material has no business being re-encoded into
        # a structural record.
        return NativeNode(
            kind=KIND_SCALAR,
            name=name,
            ordinal=ordinal,
            attributes={"scalarType": "bytes"},
            location=location,
            value_present=True,
            value_length=len(value),
        )

    return NativeNode(
        kind=KIND_OPAQUE,
        name=name,
        ordinal=ordinal,
        attributes={"nativeType": type(value).__name__},
        location=location,
    )


def generic_native_nodes(native_ast: Any) -> List[NativeNode]:
    """Describe any native AST structurally, without knowing its format.

    Mappings become objects, sequences become arrays, leaves become scalars, and anything else
    becomes an ``opaque`` leaf naming its Python type. Cycles are not tracked: the depth budget ends
    a cyclic walk at :data:`~app.payload_analysis.MAX_TREE_DEPTH`, which is cheaper than maintaining
    ancestry through a lazy, breadth-first expansion and produces the same bounded record.

    Args:
        native_ast: The adapter's parsed AST.

    Returns:
        A single-root list; empty only when the AST is ``None``, which is the honest "there was
        nothing to describe".
    """
    if native_ast is None:
        return []
    return [_generic_node(native_ast, name=None, ordinal=None, path="$")]


def generic_analysis(
    native_ast: Any,
    *,
    analyzer: Optional[AnalyzerInfo] = None,
    capabilities: Optional[AnalyzerCapabilities] = None,
    source: Optional[Union[str, bytes]],
    source_format: Optional[str] = None,
) -> PayloadAnalysisDocument:
    """Analyse a native AST with the format-blind walk.

    The default every adapter gets. It records real structure — nesting, ordering, value presence
    and length — and declares in its capabilities that it records no format semantics, so a reader
    is never left guessing whether an absent X12 envelope means the source had none or the analyzer
    had no word for one.

    Args:
        native_ast: The adapter's parsed AST.
        analyzer: Identity to record; defaults to ``generic`` at this module's version.
        capabilities: Capabilities to record; defaults to :data:`GENERIC_CAPABILITIES`.
        source: The exact material analysed, hashed into ``source_hash``.
        source_format: Adapter key of the analysed source.

    Returns:
        The analysis document.
    """
    return build_analysis_document(
        roots=generic_native_nodes(native_ast),
        analyzer=analyzer
        or AnalyzerInfo(key=GENERIC_ANALYZER_KEY, version=GENERIC_ANALYZER_VERSION),
        capabilities=capabilities or GENERIC_CAPABILITIES,
        source=source,
        source_format=source_format,
    )


# ---------------------------------------------------------------------------
# The import-time entry point
# ---------------------------------------------------------------------------


def analyze_import(
    adapter: Any,
    native_ast: Any,
    *,
    source: Optional[Union[str, bytes]],
) -> PayloadAnalysisDocument:
    """Run an adapter's analyzer over a freshly parsed AST, without ever raising.

    The import pipeline's door into this module. An analysis is *evidence about* an import, not part
    of it: a source that parsed, normalized and linted must still land in the catalog when its
    analyzer has a bug. So every failure is caught and turned into a declared ``failed`` record —
    explicit, attributable to an analyzer key and version, and visible in the import summary —
    rather than either propagating or silently producing nothing.

    The failure message names the exception *type* only. A parser error quotes the source span that
    broke it, and that span may be a credential (IXH-1.4); the type plus the analyzer key is enough
    to find the bug.

    Args:
        adapter: The :class:`~app.import_source.ImportSource` that parsed the source.
        native_ast: The AST it produced.
        source: The exact material analysed, hashed into ``source_hash``.

    Returns:
        The analysis document; never ``None``, never a raise.
    """
    key = getattr(adapter, "analyzer_key", GENERIC_ANALYZER_KEY) or GENERIC_ANALYZER_KEY
    try:
        return adapter.analyze(native_ast, source=source)
    except Exception as exc:  # noqa: BLE001 - a broken analyzer must not break an import
        logger.warning(
            "payload analyzer %r raised %s; recording a failed analysis",
            key,
            type(exc).__name__,
            exc_info=True,
        )
        try:
            analyzer = adapter.analyzer_info()
            capabilities = adapter.analysis_capabilities()
        except Exception:  # noqa: BLE001 - the adapter is already suspect; fall back to its key
            analyzer = AnalyzerInfo(key=key, version=GENERIC_ANALYZER_VERSION)
            capabilities = AnalyzerCapabilities()
        return unavailable_document(
            REASON_ANALYZER_FAILED,
            source_format=getattr(adapter, "key", None),
            message=f"The {key!r} payload analyzer failed with {type(exc).__name__}.",
            analyzer=analyzer,
            capabilities=capabilities,
            failed=True,
        )
