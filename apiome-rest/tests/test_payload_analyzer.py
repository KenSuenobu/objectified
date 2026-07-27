"""Tests for the native-analysis extractor SPI and the generic analyzer (CPDO-1.2, #4795).

:mod:`app.payload_analyzer` is the machinery every extractor shares: the budgeted breadth-first walk
that turns an analyzer's cheap node descriptions into a stored tree, the status decision that keeps a
record from claiming more than it observed, and the failure wrapper that stops a broken analyzer from
failing an import.

The properties pinned here are the ones the acceptance criteria name:

* output is **deterministic** — the same AST and bytes fingerprint identically, so a re-analysis that
  changed nothing is recognised rather than appended;
* output is **redaction-safe** — observed values live only where the value-visibility policy can
  reach them, never in ``attributes``;
* bounds are **reported, not hidden** — a truncated record is ``partial``, and a record whose drop
  count is a floor says so;
* an analyzer failure is **non-fatal but explicit** — a declared ``failed`` record naming the
  analyzer, never an exception and never silence.
"""

from __future__ import annotations

import dataclasses
from typing import Any, List, Optional

import pytest

from app.canonical_model import ApiParadigm, CanonicalApi
from app.import_source import ImportSource, ImportSourceError
from app.payload_analysis import (
    MAX_TREE_NODES,
    REASON_ANALYZER_FAILED,
    REASON_BOUNDS_EXCEEDED,
    REASON_NO_SOURCE_CAPTURED,
    REASON_UNSUPPORTED_FORMAT,
    SEVERITY_INFO,
    SEVERITY_WARNING,
    STATUS_AVAILABLE,
    STATUS_FAILED,
    STATUS_PARTIAL,
    STATUS_UNAVAILABLE,
    AnalysisWarning,
    AnalyzerInfo,
    ValueVisibility,
    analysis_content_fingerprint,
    analyzer_capabilities,
    apply_value_visibility,
    source_digest,
)
from app.payload_analyzer import (
    GENERIC_ANALYZER_KEY,
    GENERIC_CAPABILITIES,
    KIND_ARRAY,
    KIND_OBJECT,
    KIND_OPAQUE,
    KIND_SCALAR,
    WARNING_SCAN_BUDGET_EXHAUSTED,
    NativeNode,
    analyze_import,
    build_analysis_document,
    build_analysis_tree,
    generic_analysis,
)

_AST = {"envelope": {"id": "A-1", "size": 3}, "items": ["x", "y"], "empty": None}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _walk(nodes) -> List[Any]:
    """Yield every node in a stored tree, depth-first."""
    out: List[Any] = []
    stack = list(reversed(list(nodes)))
    while stack:
        node = stack.pop()
        out.append(node)
        stack.extend(reversed(node.children))
    return out


def _leaf(index: int) -> NativeNode:
    return NativeNode(kind="leaf", name=f"leaf-{index}", ordinal=index)


def _wide_tree(*, breadth: int, depth: int) -> List[NativeNode]:
    """A ``breadth``-ary tree of the given depth, built eagerly (small by construction)."""

    def level(remaining: int) -> List[NativeNode]:
        if remaining == 0:
            return []
        return [
            NativeNode(kind=f"level-{remaining}", ordinal=index, children=level(remaining - 1))
            for index in range(breadth)
        ]

    return level(depth)


class _StubAdapter(ImportSource):
    """A minimal adapter that keeps every analyzer default."""

    key = "stub-analyzer"
    label = "Stub"
    description = "Test adapter"
    paradigm = ApiParadigm.DATA_SCHEMA

    def detect(self, payload):  # pragma: no cover - not exercised here
        raise NotImplementedError

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> Any:
        return {"raw": raw}

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:  # pragma: no cover
        raise NotImplementedError


class _ExplodingAdapter(_StubAdapter):
    """An adapter whose analyzer raises — the case that must not fail an import."""

    key = "exploding-analyzer"
    analyzer_key = "exploding"

    def analyze(self, native_ast: Any, *, source: Optional[str] = None):
        raise RuntimeError("token=sk-live-should-never-be-logged")


class _TotallyBrokenAdapter(_ExplodingAdapter):
    """An adapter whose analyzer *and* its metadata raise."""

    key = "broken-analyzer"

    def analyzer_info(self):
        raise RuntimeError("metadata is broken too")

    def analysis_capabilities(self):
        raise RuntimeError("metadata is broken too")


# ---------------------------------------------------------------------------
# The generic walk
# ---------------------------------------------------------------------------


def test_generic_analysis_describes_containers_and_leaves() -> None:
    document = generic_analysis(_AST, source="raw-bytes", source_format="stub")

    assert document.status == STATUS_AVAILABLE
    assert document.status_reason is None
    assert document.source_hash == source_digest("raw-bytes")
    assert document.source_format == "stub"
    assert document.analyzer.key == GENERIC_ANALYZER_KEY
    kinds = document.metrics.kind_counts
    assert kinds[KIND_OBJECT] == 2  # the root and the nested envelope
    assert kinds[KIND_ARRAY] == 1
    assert kinds[KIND_SCALAR] == 5  # id, size, two items, and the null


def test_node_ids_are_index_paths_and_are_stable_across_runs() -> None:
    first = generic_analysis(_AST, source="s")
    second = generic_analysis(_AST, source="s")

    ids = [node.id for node in _walk(first.tree)]
    assert ids[:4] == ["0", "0.0", "0.0.0", "0.0.1"]
    assert ids == [node.id for node in _walk(second.tree)]


def test_generic_analysis_is_deterministic() -> None:
    """The same AST and bytes must fingerprint identically — a re-analysis that changed nothing
    must be recognised by content rather than appended as a new sequence."""
    a = generic_analysis(_AST, source="same")
    b = generic_analysis(dict(_AST), source="same")

    assert analysis_content_fingerprint(a) == analysis_content_fingerprint(b)


def test_locations_record_the_path_the_walk_took() -> None:
    document = generic_analysis(_AST, source="s")
    paths = [node.location.path for node in _walk(document.tree) if node.location]

    assert "$" in paths
    assert "$.envelope.id" in paths
    assert "$.items[1]" in paths


def test_scalar_values_are_observed_and_measured() -> None:
    document = generic_analysis({"note": "hello"}, source="s")
    leaf = _walk(document.tree)[-1]

    assert (leaf.value, leaf.value_present, leaf.value_length) == ("hello", True, 5)


def test_an_absent_value_is_recorded_as_absent_not_as_empty() -> None:
    document = generic_analysis({"missing": None}, source="s")
    leaf = _walk(document.tree)[-1]

    assert leaf.value_present is False
    assert leaf.value is None


def test_bytes_are_measured_never_decoded() -> None:
    document = generic_analysis({"blob": b"\x00\x01\x02\x03"}, source="s")
    leaf = _walk(document.tree)[-1]

    assert leaf.value_length == 4
    assert leaf.value is None
    assert leaf.attributes["scalarType"] == "bytes"


def test_unknown_objects_are_recorded_by_type_not_by_repr() -> None:
    """An unknown object's ``repr`` could carry payload material and is never deterministic."""

    class Mystery:
        def __repr__(self) -> str:  # pragma: no cover - the point is that it is never called
            return "Mystery(secret='hunter2')"

    document = generic_analysis({"thing": Mystery()}, source="s")
    leaf = _walk(document.tree)[-1]

    assert leaf.kind == KIND_OPAQUE
    assert leaf.attributes == {"nativeType": "Mystery"}
    assert leaf.value is None


def test_dataclass_and_model_asts_are_described_as_objects() -> None:
    @dataclasses.dataclass
    class Record:
        name: str
        count: int

    document = generic_analysis(Record(name="orders", count=2), source="s")
    root = document.tree[0]

    assert root.kind == KIND_OBJECT
    assert root.attributes["nativeType"] == "Record"
    assert [child.name for child in root.children] == ["name", "count"]


# ---------------------------------------------------------------------------
# Redaction safety
# ---------------------------------------------------------------------------


def test_observed_values_never_reach_attributes() -> None:
    """Attributes sit outside the value-visibility policy, so a value there would be a way around
    it. The walk keeps observed values in ``value`` only."""
    document = generic_analysis({"account": "4111111111111111"}, source="s")

    for node in _walk(document.tree):
        assert "4111111111111111" not in str(node.attributes)


def test_the_default_policy_withholds_every_observed_value() -> None:
    document = generic_analysis({"account": "4111111111111111"}, source="s")
    stored = apply_value_visibility(document, ValueVisibility.DEFAULT)

    leaf = _walk(stored.tree)[-1]
    assert leaf.value is None
    assert leaf.value_present is True
    assert leaf.value_length == 16
    assert leaf.redacted is True
    assert stored.contract_violations() == []


def test_a_raw_generic_document_is_not_storable_until_a_policy_has_run() -> None:
    """The pre-policy document carries values; the contract refuses it, which is what stops raw
    analyzer output from being stored as though a policy had been applied."""
    document = generic_analysis({"account": "4111111111111111"}, source="s")

    assert document.redaction.value_visibility == ValueVisibility.DEFAULT
    assert document.contract_violations() != []


# ---------------------------------------------------------------------------
# Bounds
# ---------------------------------------------------------------------------


def test_the_budget_keeps_the_top_of_the_tree_and_reports_what_it_dropped() -> None:
    document = build_analysis_document(
        roots=_wide_tree(breadth=4, depth=3),
        analyzer=AnalyzerInfo(key="test", version="1.0.0"),
        capabilities=GENERIC_CAPABILITIES,
        source="s",
        max_nodes=5,
    )

    assert document.status == STATUS_PARTIAL
    assert document.status_reason == REASON_BOUNDS_EXCEEDED
    assert document.metrics.truncated is True
    assert document.metrics.node_count == 5
    # Breadth-first: the whole first level survives before anything below it is admitted.
    assert [node.kind for node in document.tree] == ["level-3"] * 4
    assert document.metrics.dropped_node_count == (4 + 16 + 64) - 5


def test_the_depth_budget_drops_everything_below_it() -> None:
    document = build_analysis_document(
        roots=_wide_tree(breadth=2, depth=4),
        analyzer=AnalyzerInfo(key="test", version="1.0.0"),
        capabilities=GENERIC_CAPABILITIES,
        source="s",
        max_depth=2,
    )

    assert document.metrics.max_depth == 2
    assert document.metrics.truncated is True
    assert document.status_reason == REASON_BOUNDS_EXCEEDED


def test_a_bounded_record_can_never_report_itself_as_available() -> None:
    document = build_analysis_document(
        roots=_wide_tree(breadth=3, depth=2),
        analyzer=AnalyzerInfo(key="test", version="1.0.0"),
        capabilities=GENERIC_CAPABILITIES,
        source="s",
        max_nodes=2,
    )

    assert document.status != STATUS_AVAILABLE
    assert document.contract_violations() == []


def test_a_subtree_the_budget_will_not_admit_is_never_realised() -> None:
    """Laziness is what keeps a huge source from being materialised only to be thrown away."""
    realised: List[str] = []

    def grandchildren() -> List[NativeNode]:
        realised.append("grandchildren")
        return [_leaf(0)]

    def children() -> List[NativeNode]:
        realised.append("children")
        return [NativeNode(kind="child", children=grandchildren)]

    build_analysis_tree(
        [NativeNode(kind="root", children=children)], max_nodes=1, max_visits=1
    )

    assert realised == ["children"]


def test_counting_what_was_dropped_is_itself_bounded() -> None:
    """Counting a dropped subtree means visiting it, so visiting is capped too — otherwise a
    200 MB interchange would be walked in full just to report how much of it did not fit."""
    roots = _wide_tree(breadth=5, depth=3)  # 5 + 25 + 125 = 155 constructs

    exact = build_analysis_tree(roots, max_nodes=2)
    capped = build_analysis_tree(roots, max_nodes=2, max_visits=10)

    assert exact.visit_exhausted is False
    assert exact.dropped == 155 - 2
    assert capped.visit_exhausted is True
    assert capped.dropped < exact.dropped


def test_an_exhausted_visit_budget_is_stated_on_the_record() -> None:
    document = build_analysis_document(
        roots=_wide_tree(breadth=5, depth=3),
        analyzer=AnalyzerInfo(key="test", version="1.0.0"),
        capabilities=GENERIC_CAPABILITIES,
        source="s",
        max_nodes=2,
        max_visits=10,
    )

    codes = [warning.code for warning in document.warnings]
    assert WARNING_SCAN_BUDGET_EXHAUSTED in codes
    # An informational statement about the count, not a claim that a construct is unmodelled: the
    # record is still partial, and its reason is still the bound that caused it.
    assert document.status == STATUS_PARTIAL
    assert document.status_reason == REASON_BOUNDS_EXCEEDED


# ---------------------------------------------------------------------------
# Status decisions
# ---------------------------------------------------------------------------


def test_an_analysis_with_no_source_bytes_is_declared_unavailable() -> None:
    """A record that cannot name what it described is not checkable, so it is not written."""
    document = generic_analysis(_AST, source=None, source_format="stub")

    assert document.status == STATUS_UNAVAILABLE
    assert document.status_reason == REASON_NO_SOURCE_CAPTURED
    assert document.tree == []
    assert document.source_hash is None


def test_an_analyzer_that_produced_nothing_is_unsupported_not_empty_available() -> None:
    document = build_analysis_document(
        roots=[],
        analyzer=AnalyzerInfo(key="test", version="1.0.0"),
        capabilities=GENERIC_CAPABILITIES,
        source="s",
    )

    assert document.status == STATUS_UNAVAILABLE
    assert document.status_reason == REASON_UNSUPPORTED_FORMAT
    assert document.tree == []


def test_a_warning_about_an_unmodelled_construct_makes_the_record_partial() -> None:
    document = build_analysis_document(
        roots=[_leaf(0)],
        analyzer=AnalyzerInfo(key="test", version="1.0.0"),
        capabilities=GENERIC_CAPABILITIES,
        source="s",
        warnings=[AnalysisWarning(code="fmt.redefines", severity=SEVERITY_WARNING)],
    )

    assert document.status == STATUS_PARTIAL
    assert document.status_reason == REASON_UNSUPPORTED_FORMAT
    assert document.metrics.warning_count == 1


def test_an_informational_warning_leaves_the_record_available() -> None:
    """Commentary about how something is described is not a claim that something is missing."""
    document = build_analysis_document(
        roots=[_leaf(0)],
        analyzer=AnalyzerInfo(key="test", version="1.0.0"),
        capabilities=GENERIC_CAPABILITIES,
        source="s",
        warnings=[AnalysisWarning(code="fmt.flattened", severity=SEVERITY_INFO)],
    )

    assert document.status == STATUS_AVAILABLE
    assert document.metrics.warning_count == 1


# ---------------------------------------------------------------------------
# Capabilities
# ---------------------------------------------------------------------------


def test_capabilities_are_sorted_and_deduplicated() -> None:
    """The block is part of the canonicalized document, so an unsorted declaration would make an
    otherwise identical re-analysis look new."""
    capabilities = analyzer_capabilities(
        supported=["b.two", "a.one", "b.two", "  "],
        unsupported=["z.last", "m.mid"],
        limits={"maxNodes": 10},
    )

    assert capabilities.supported == ["a.one", "b.two"]
    assert capabilities.unsupported == ["m.mid", "z.last"]
    assert capabilities.limits == {"maxNodes": 10}


def test_the_generic_analyzer_declares_that_it_models_no_format_semantics() -> None:
    assert "generic.format_semantics" in GENERIC_CAPABILITIES.unsupported
    assert GENERIC_CAPABILITIES.limits["maxNodes"] == MAX_TREE_NODES


# ---------------------------------------------------------------------------
# The SPI defaults and the failure wrapper
# ---------------------------------------------------------------------------


def test_an_adapter_with_no_extractor_still_produces_a_real_analysis() -> None:
    adapter = _StubAdapter()
    document = adapter.analyze(adapter.parse("hello"), source="hello")

    assert document.status == STATUS_AVAILABLE
    assert document.analyzer.key == GENERIC_ANALYZER_KEY
    assert document.source_format == "stub-analyzer"
    assert document.capabilities.unsupported == GENERIC_CAPABILITIES.unsupported


def test_a_crashing_analyzer_yields_a_declared_failed_record_rather_than_raising() -> None:
    document = analyze_import(_ExplodingAdapter(), {"a": 1}, source="s")

    assert document.status == STATUS_FAILED
    assert document.status_reason == REASON_ANALYZER_FAILED
    assert document.tree == []
    assert document.analyzer.key == "exploding"


def test_a_failure_message_names_the_exception_type_and_never_its_text() -> None:
    """A parser error quotes the source span that broke it, and that span may be a credential."""
    document = analyze_import(_ExplodingAdapter(), {"a": 1}, source="s")

    message = " ".join(warning.message for warning in document.warnings)
    assert "RuntimeError" in message
    assert "sk-live" not in message


def test_an_adapter_whose_metadata_also_raises_still_yields_a_record() -> None:
    document = analyze_import(_TotallyBrokenAdapter(), {"a": 1}, source="s")

    assert document.status == STATUS_FAILED
    assert document.analyzer.key == "exploding"


def test_an_extractor_that_rejects_the_ast_is_reported_not_propagated() -> None:
    """An adapter's own type guard raises :class:`ImportSourceError`; the wrapper catches it too."""

    class _PickyAdapter(_StubAdapter):
        key = "picky-analyzer"

        def analyze(self, native_ast, *, source=None):
            raise ImportSourceError("wrong AST type")

    document = analyze_import(_PickyAdapter(), object(), source="s")

    assert document.status == STATUS_FAILED
    assert document.status_reason == REASON_ANALYZER_FAILED


@pytest.mark.parametrize("visibility", [ValueVisibility.NONE, ValueVisibility.STRUCTURAL])
def test_every_generic_record_is_storable_once_a_policy_has_run(visibility: str) -> None:
    document = generic_analysis(_AST, source="s")

    assert apply_value_visibility(document, visibility).contract_violations() == []
