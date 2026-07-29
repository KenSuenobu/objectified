"""Tests for the catalog → OpenAPI conversion projection manifest — CPDO-1.3 (#4800).

Pins the acceptance criteria of the manifest contract:

* **it reconciles with the fidelity report** — one checklist edge per report row, one loss edge per
  report loss, and a per-status tally equal to the report's ``coverage_counts`` mapped through
  :data:`~app.conversion_projection.STATUS_FOR_COVERAGE`; a deliberately inconsistent manifest is a
  hard :class:`~app.conversion_projection.ConversionReconciliationError`, never a silent divergence;
* **stable ids and ordering** — the same model, defaults and tool versions produce an equal manifest
  and an equal hash, while a changed default or converter version produces a different one;
* **every non-retained edge names a cause** — enforced on the model itself, so no construction path
  can produce an unexplained outcome;
* **bounded / paginated** — a large model truncates worst-status-first (keeping the drops), and the
  cursor pagination is deterministic and clamped;

plus the honesty properties the module exists for: a construct whose OpenAPI location cannot be
resolved is ``unavailable`` rather than ``dropped``, a channel (which OpenAPI genuinely cannot carry)
*is* ``dropped``, and a missing payload analysis is stated rather than omitted.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

import pytest

from app.canonical_model import (
    ApiIdentity,
    ApiParadigm,
    CanonicalApi,
    CanonicalField,
    Channel,
    Message,
    MessageRole,
    Operation,
    OperationKind,
    Server,
    Service,
    Type,
    TypeKind,
    TypeRef,
)
from app.conversion_projection import (
    CONVERSION_MANIFEST_SCHEMA_VERSION,
    MAX_CONSTRUCT_EDGES,
    MAX_EVIDENCE_PAGE_SIZE,
    STATUS_FOR_COVERAGE,
    ConversionAnalysisRef,
    ConversionEdge,
    ConversionEdgeScope,
    ConversionManifest,
    ConversionManifestSource,
    ConversionReconciliationError,
    build_conversion_manifest,
    normalize_defaults_for_hash,
    paginate_conversion_evidence,
    reconcile_with_fidelity,
    summarize_conversion_manifest,
)
from app.emitter import EmitResult
from app.export_service import emit_canonical
from app.fidelity import Coverage, FidelityReport, analyze_fidelity
from app.lossiness import LossinessSeverity
from app.payload_analysis import (
    AnalysisMetrics,
    AnalysisWarning,
    AnalyzerInfo,
    PayloadAnalysisDocument,
    SourceLocation,
    analyzer_capabilities,
)
from app.projection_taxonomy import ConversionStatus, ProjectionReason

# ---------------------------------------------------------------------------
# Fixtures — small, real canonical models put through the real emitter
# ---------------------------------------------------------------------------


def _record(key: str, name: str, field_name: str = "name") -> Type:
    """A one-field RECORD type usable as a component schema."""
    return Type(
        key=key,
        name=name,
        kind=TypeKind.RECORD,
        fields=[CanonicalField(key=f"{key}.{field_name}", name=field_name, type=TypeRef(name="string"))],
    )


def _rest_api() -> CanonicalApi:
    """A REST model that converts near-losslessly: declared route, servers, title, version."""
    return CanonicalApi(
        paradigm=ApiParadigm.REST,
        format="openapi-3.1",
        identity=ApiIdentity(name="widgets"),
        title="Widgets",
        version="1.4.0",
        description="Widget management.",
        servers=[Server(url="https://api.example.com")],
        services=[
            Service(
                key="widgets",
                name="Widgets",
                operations=[
                    Operation(
                        key="GET /widgets",
                        name="listWidgets",
                        kind=OperationKind.REQUEST_RESPONSE,
                        http_method="GET",
                        http_path="/widgets",
                        messages=[
                            Message(
                                key="GET /widgets#200",
                                role=MessageRole.RESPONSE,
                                status_code="200",
                                content_types=["application/json"],
                                payload=TypeRef(name="Widget"),
                            )
                        ],
                    )
                ],
            )
        ],
        types=[_record("Widget", "Widget")],
    )


def _rpc_api() -> CanonicalApi:
    """An RPC model whose route must be synthesized — the ``inferred`` path."""
    return CanonicalApi(
        paradigm=ApiParadigm.RPC,
        format="protobuf",
        identity=ApiIdentity(name="pets"),
        title="Pets",
        services=[
            Service(
                key="acme.PetService",
                name="PetService",
                operations=[
                    Operation(
                        key="acme.PetService.GetPet",
                        name="GetPet",
                        kind=OperationKind.REQUEST_RESPONSE,
                    )
                ],
            )
        ],
        types=[_record("Pet", "Pet")],
    )


def _event_api() -> CanonicalApi:
    """An event-driven model carrying a channel, which OpenAPI genuinely cannot represent."""
    return CanonicalApi(
        paradigm=ApiParadigm.EVENT,
        format="asyncapi-3",
        identity=ApiIdentity(name="signups"),
        title="Signups",
        version="2.0.0",
        channels=[Channel(key="user/signedup", address="user/signedup", name="User signed up")],
        services=[
            Service(
                key="signups",
                name="Signups",
                operations=[
                    Operation(
                        key="user/signedup#publish",
                        name="publishSignedUp",
                        kind=OperationKind.PUBLISH,
                        channel_ref="user/signedup",
                    )
                ],
            )
        ],
        types=[_record("Signup", "Signup")],
    )


def _build(
    api: CanonicalApi,
    *,
    defaults: Optional[Dict[str, Any]] = None,
    analysis: Optional[PayloadAnalysisDocument] = None,
    tool_versions: Optional[Dict[str, str]] = None,
) -> tuple[ConversionManifest, FidelityReport, EmitResult]:
    """Emit ``api``, analyze it, and build the manifest — the exact triple the job uses."""
    result = emit_canonical(api, "openapi-3.1")
    report = analyze_fidelity(api, result)
    manifest = build_conversion_manifest(
        api=api,
        document=result.document,
        report=report,
        emit_result=result,
        target_format="openapi-3.1",
        conversion_mode="lossy",
        tool_versions=tool_versions or {"apiome-rest": "1.0.0", "emitter": "openapi-3.1"},
        defaults=defaults,
        analysis=analysis,
    )
    return manifest, report, result


def _edge_by_id(manifest: ConversionManifest, edge_id: str) -> ConversionEdge:
    """Return the edge with ``edge_id``, failing the test loudly when it is absent."""
    for edge in manifest.edges:
        if edge.id == edge_id:
            return edge
    raise AssertionError(f"no edge {edge_id!r} in {[e.id for e in manifest.edges]}")


# ---------------------------------------------------------------------------
# AC: the manifest schema validates and reconciles with the fidelity report
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("factory", [_rest_api, _rpc_api, _event_api], ids=["rest", "rpc", "event"])
def test_manifest_reconciles_with_the_fidelity_report(factory) -> None:
    """Across paradigms, checklist and loss edges tally exactly with the report they came from."""
    manifest, report, _ = _build(factory())

    checklist = manifest.edges_in_scope(ConversionEdgeScope.CHECKLIST)
    assert len(checklist) == len(report.items)

    expected = {status.value: 0 for status in ConversionStatus}
    for coverage_value, count in report.coverage_counts.items():
        expected[STATUS_FOR_COVERAGE[Coverage(coverage_value)].value] += count
    actual = {status.value: 0 for status in ConversionStatus}
    for edge in checklist:
        actual[edge.status.value] += 1
    assert actual == expected

    assert len(manifest.edges_in_scope(ConversionEdgeScope.LOSS)) == len(report.losses)


def test_reconciliation_rejects_a_manifest_that_lost_a_checklist_row() -> None:
    """A manifest missing a checklist row is a hard error, not a quiet divergence."""
    manifest, report, _ = _build(_rest_api())
    manifest.edges = [
        edge
        for edge in manifest.edges
        if not (edge.scope is ConversionEdgeScope.CHECKLIST and edge.id.endswith("servers"))
    ]
    with pytest.raises(ConversionReconciliationError, match="checklist rows"):
        reconcile_with_fidelity(manifest, report)


def test_reconciliation_rejects_a_mismatched_status_tally() -> None:
    """Re-labelling one checklist edge breaks the tally and is refused."""
    manifest, report, _ = _build(_rest_api())
    for edge in manifest.edges:
        if edge.scope is ConversionEdgeScope.CHECKLIST and edge.status is ConversionStatus.RETAINED:
            edge.status = ConversionStatus.DROPPED
            edge.reason = ProjectionReason.SOURCE_INCOMPLETE
            break
    with pytest.raises(ConversionReconciliationError, match="status counts"):
        reconcile_with_fidelity(manifest, report)


def test_reconciliation_rejects_a_missing_loss_edge() -> None:
    """Dropping a loss edge is refused: losses are one of the two reconciling scopes."""
    manifest, report, _ = _build(_rpc_api())
    assert report.losses, "the RPC fixture must produce at least one projection loss"
    manifest.edges = [
        edge for edge in manifest.edges if edge.scope is not ConversionEdgeScope.LOSS
    ]
    with pytest.raises(ConversionReconciliationError, match="loss edge count"):
        reconcile_with_fidelity(manifest, report)


# ---------------------------------------------------------------------------
# AC: same source revision / defaults yield stable ids and ordering
# ---------------------------------------------------------------------------


def test_identical_inputs_yield_an_identical_manifest_and_hash() -> None:
    """The builder is pure: rebuild from the same inputs and everything compares equal."""
    first, _, _ = _build(_rest_api())
    second, _, _ = _build(_rest_api())
    assert first.manifest_hash == second.manifest_hash
    assert [n.id for n in first.nodes] == [n.id for n in second.nodes]
    assert [e.id for e in first.edges] == [e.id for e in second.edges]
    assert first.model_dump(mode="json") == second.model_dump(mode="json")


def test_the_hash_excludes_the_source_ids_so_it_is_content_addressed() -> None:
    """The same bytes converted in another project are the same snapshot, not a different one."""
    base, report, result = _build(_rest_api())
    relocated = build_conversion_manifest(
        api=_rest_api(),
        document=result.document,
        report=report,
        emit_result=result,
        target_format="openapi-3.1",
        conversion_mode="lossy",
        tool_versions={"apiome-rest": "1.0.0", "emitter": "openapi-3.1"},
        project_id="some-other-project",
        version_record_id="some-other-revision",
    )
    assert relocated.manifest_hash == base.manifest_hash
    assert relocated.source.project_id == "some-other-project"


def test_different_defaults_are_a_different_snapshot() -> None:
    """Gap-filling defaults change what is converted, so they change the snapshot."""
    plain, _, _ = _build(_rest_api())
    with_defaults, _, _ = _build(_rest_api(), defaults={"title": "Renamed"})
    assert with_defaults.manifest_hash != plain.manifest_hash
    assert with_defaults.defaults == {"title": "Renamed"}


def test_a_converter_upgrade_is_a_different_snapshot() -> None:
    """Tool versions are folded in, so an emitter upgrade is visibly a new snapshot."""
    old, _, _ = _build(_rest_api(), tool_versions={"apiome-rest": "1.0.0"})
    new, _, _ = _build(_rest_api(), tool_versions={"apiome-rest": "2.0.0"})
    assert old.manifest_hash != new.manifest_hash


def test_blank_defaults_normalize_to_the_no_defaults_snapshot() -> None:
    """``{"title": "  "}`` fills no gap, so it must not read as a different conversion."""
    assert normalize_defaults_for_hash({"title": "   ", "servers": ["", "  "]}) == {}
    assert normalize_defaults_for_hash(None) == {}
    assert normalize_defaults_for_hash({"servers": ["https://b", "https://a", "https://b"]}) == {
        "servers": ["https://a", "https://b"]
    }
    plain, _, _ = _build(_rest_api())
    blank, _, _ = _build(_rest_api(), defaults={"title": "", "version": None, "servers": []})
    assert blank.manifest_hash == plain.manifest_hash


def test_manifest_ordering_is_canonical_regardless_of_construction_order() -> None:
    """Re-validating a shuffled manifest restores the canonical order and re-derives the counts."""
    manifest, _, _ = _build(_rest_api())
    shuffled = manifest.model_dump(mode="json")
    shuffled["edges"] = list(reversed(shuffled["edges"]))
    shuffled["nodes"] = list(reversed(shuffled["nodes"]))
    revalidated = ConversionManifest.model_validate(shuffled)
    assert [e.id for e in revalidated.edges] == [e.id for e in manifest.edges]
    assert [n.id for n in revalidated.nodes] == [n.id for n in manifest.nodes]
    assert revalidated.status_counts == manifest.status_counts


# ---------------------------------------------------------------------------
# AC: every non-retained edge carries a reason code
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("factory", [_rest_api, _rpc_api, _event_api], ids=["rest", "rpc", "event"])
def test_every_non_retained_edge_names_a_cause_and_a_remedy(factory) -> None:
    """The AC, checked over every edge of every scope."""
    manifest, _, _ = _build(factory())
    assert manifest.edges, "the fixture must produce edges"
    for edge in manifest.edges:
        if edge.status is ConversionStatus.RETAINED:
            assert edge.reason is None
            assert edge.remediation is None
        else:
            assert edge.reason is not None, edge.id
            assert edge.remediation, edge.id


@pytest.mark.parametrize("factory", [_rest_api, _rpc_api, _event_api], ids=["rest", "rpc", "event"])
def test_every_drop_and_inference_joins_displayable_evidence(factory) -> None:
    """CPDO-3.2 (#4802): every drop/inference the drawer can show has evidence behind it.

    Each ``dropped`` / ``unavailable`` / ``inferred`` edge must join a bundled source node
    with a non-empty label, and that node must carry source-native evidence (or the edge its
    own references) — so the drawer never presents an outcome it cannot substantiate.
    """
    manifest, _, _ = _build(factory())
    nodes = {node.id: node for node in manifest.nodes}
    displayed = {ConversionStatus.DROPPED, ConversionStatus.UNAVAILABLE, ConversionStatus.INFERRED}
    checked = 0
    for edge in manifest.edges:
        if edge.status not in displayed:
            continue
        checked += 1
        source = nodes[edge.source]
        assert source.label.strip(), edge.id
        assert edge.detail.strip(), edge.id
        assert source.source is not None or edge.evidence, edge.id
    assert checked, "the fixture must produce at least one drop/inference"


def test_the_model_itself_refuses_an_unexplained_outcome() -> None:
    """Enforced on the model, so storage round-trips cannot smuggle one in either."""
    with pytest.raises(ValueError, match="requires a reason code"):
        ConversionEdge(
            id="construct:type:Widget",
            scope=ConversionEdgeScope.CONSTRUCT,
            source="source:construct:Widget",
            target=None,
            status=ConversionStatus.DROPPED,
            detail="gone",
        )


def test_a_model_limit_is_not_reported_as_a_source_gap() -> None:
    """``license`` is ``n/a`` because *apiome* drops it — the reason must not blame the source."""
    manifest, _, _ = _build(_rest_api())
    edge = _edge_by_id(manifest, "checklist:info.license")
    assert edge.status is ConversionStatus.NOT_APPLICABLE
    assert edge.reason is ProjectionReason.EMITTER_UNSUPPORTED


def test_an_absent_source_construct_is_reported_as_not_applicable() -> None:
    """A row that is ``n/a`` because the source has none of it stays ``not_applicable``."""
    manifest, _, _ = _build(_rpc_api())
    edge = _edge_by_id(manifest, "checklist:parameters")
    assert edge.status is ConversionStatus.NOT_APPLICABLE
    assert edge.reason is ProjectionReason.NOT_APPLICABLE


# ---------------------------------------------------------------------------
# Which source construct became which OpenAPI construct
# ---------------------------------------------------------------------------


def test_a_declared_rest_route_is_retained_at_its_own_pointer() -> None:
    """A REST operation keeps its source method+path, and the edge points at it."""
    manifest, _, _ = _build(_rest_api())
    edge = _edge_by_id(manifest, "construct:operation:GET /widgets")
    assert edge.status is ConversionStatus.RETAINED
    assert edge.target == "target:/paths/~1widgets/get"
    pointers = {ref.ref for ref in edge.evidence if ref.kind == "document-pointer"}
    assert pointers == {"/paths/~1widgets/get"}


def test_a_synthesized_rpc_route_is_inferred_not_retained() -> None:
    """An RPC method with no HTTP binding lands at a synthesized pointer, marked ``inferred``."""
    manifest, _, _ = _build(_rpc_api())
    edge = _edge_by_id(manifest, "construct:operation:acme.PetService.GetPet")
    assert edge.status is ConversionStatus.INFERRED
    assert edge.reason is ProjectionReason.SOURCE_INCOMPLETE
    assert edge.target == "target:/paths/~1acme.PetService~1GetPet/post"


def test_named_types_and_their_fields_map_onto_component_schemas() -> None:
    """A named type lands in ``components.schemas``; its field lands under ``properties``."""
    manifest, _, _ = _build(_rest_api())
    type_edge = _edge_by_id(manifest, "construct:type:Widget")
    field_edge = _edge_by_id(manifest, "construct:field:Widget.name")
    assert type_edge.target == "target:/components/schemas/Widget"
    assert field_edge.target == "target:/components/schemas/Widget/properties/name"
    assert type_edge.status is ConversionStatus.RETAINED
    assert field_edge.status is ConversionStatus.RETAINED


def test_a_channel_is_dropped_because_openapi_has_no_counterpart() -> None:
    """OpenAPI genuinely cannot carry a channel, so this is a proven destination limit."""
    manifest, _, _ = _build(_event_api())
    edge = _edge_by_id(manifest, "construct:channel:user/signedup")
    assert edge.status is ConversionStatus.DROPPED
    assert edge.reason is ProjectionReason.DESTINATION_UNSUPPORTED
    assert edge.target is None
    assert edge.severity is LossinessSeverity.WARN


def test_an_unplaceable_construct_is_unavailable_not_dropped() -> None:
    """A construct with no addressable location is *unknown*, and must not be claimed as a loss."""
    api = _rest_api()
    api.types.append(
        Type(key="Colour", name="Colour", kind=TypeKind.ENUM, enum_values=[])
    )
    result = emit_canonical(api, "openapi-3.1")
    # Simulate an emitter that did not place the type: the manifest must not assert it was dropped.
    result.files[0].content["components"]["schemas"].pop("Colour", None)
    report = analyze_fidelity(api, result)
    manifest = build_conversion_manifest(
        api=api,
        document=result.document,
        report=report,
        emit_result=result,
        target_format="openapi-3.1",
        conversion_mode="lossy",
        tool_versions={"apiome-rest": "1.0.0"},
    )
    edge = _edge_by_id(manifest, "construct:type:Colour")
    assert edge.status is ConversionStatus.UNAVAILABLE
    assert edge.reason is ProjectionReason.EMITTER_UNSUPPORTED
    assert edge.target is None


def test_a_loss_reuses_the_construct_node_it_names() -> None:
    """A loss pointing at a construct joins that construct's node rather than duplicating it."""
    manifest, report, _ = _build(_rpc_api())
    loss_edges = manifest.edges_in_scope(ConversionEdgeScope.LOSS)
    assert loss_edges
    assert any(edge.source == "source:construct:acme.PetService.GetPet" for edge in loss_edges)


def test_the_passthrough_path_needs_no_provenance_trail() -> None:
    """Without an EmitResult, a resolvable pointer is faithful by construction (no false inferences)."""
    api = _rest_api()
    result = emit_canonical(api, "openapi-3.1")
    report = analyze_fidelity(api, result)
    manifest = build_conversion_manifest(
        api=api,
        document=result.document,
        report=report,
        emit_result=None,
        target_format="openapi-3.1",
        conversion_mode="passthrough",
        tool_versions={"apiome-rest": "1.0.0", "emitter": "passthrough"},
    )
    assert _edge_by_id(manifest, "construct:type:Widget").status is ConversionStatus.RETAINED
    assert manifest.conversion_mode == "passthrough"


# ---------------------------------------------------------------------------
# Whether the input data was incomplete (the analysis lane)
# ---------------------------------------------------------------------------


def _analysis(**overrides: Any) -> PayloadAnalysisDocument:
    """An ``available`` analysis with declared capabilities, overridable per test."""
    fields: Dict[str, Any] = {
        "status": "available",
        "source_format": "edix12",
        "source_hash": "sha256:" + "0" * 64,
        "analyzer": AnalyzerInfo(key="edix12", version="1.0.0"),
        "capabilities": analyzer_capabilities(
            supported=["x12.interchange"], unsupported=["x12.hl_hierarchy"]
        ),
        "metrics": AnalysisMetrics(node_count=12, max_depth=3),
    }
    fields.update(overrides)
    return PayloadAnalysisDocument(**fields)


def test_a_missing_analysis_is_stated_rather_than_omitted() -> None:
    """"We never looked" is a fact the manifest reports, not a silence it leaves behind."""
    manifest, _, _ = _build(_rest_api(), analysis=None)
    assert manifest.source.analysis.available is False
    edge = _edge_by_id(manifest, "analysis:absent")
    assert edge.status is ConversionStatus.UNAVAILABLE
    assert edge.reason is ProjectionReason.SOURCE_INCOMPLETE


def test_an_analyzer_capability_gap_becomes_its_own_edge() -> None:
    """A construct the analyzer cannot model is distinguished from one the source lacks."""
    manifest, _, _ = _build(_rest_api(), analysis=_analysis())
    edge = _edge_by_id(manifest, "analysis:unsupported:x12.hl_hierarchy")
    assert edge.status is ConversionStatus.UNAVAILABLE
    assert edge.reason is ProjectionReason.SOURCE_PARSE_LIMIT
    assert "does not model" in edge.detail
    assert manifest.source.analysis.available is True
    assert manifest.source.analysis.unsupported_constructs == ["x12.hl_hierarchy"]


def test_a_bounded_analysis_reports_its_dropped_node_floor() -> None:
    """A truncated native tree is a parser limit the manifest names with a number."""
    analysis = _analysis(
        status="partial",
        status_reason="bounds_exceeded",
        metrics=AnalysisMetrics(node_count=5000, truncated=True, dropped_node_count=317),
    )
    manifest, _, _ = _build(_rest_api(), analysis=analysis)
    bounds_edge = _edge_by_id(manifest, "analysis:bounds")
    assert bounds_edge.reason is ProjectionReason.SOURCE_PARSE_LIMIT
    assert "317" in bounds_edge.detail
    status_edge = _edge_by_id(manifest, "analysis:status")
    assert "bounds_exceeded" in status_edge.detail


def test_an_analysis_warning_cites_the_node_and_its_source_location() -> None:
    """A node-scoped warning becomes an edge a reader can follow into the source viewer."""
    analysis = _analysis(
        warnings=[
            AnalysisWarning(
                code="copybook.redefines_unsupported",
                severity="warning",
                message="REDEFINES is not modelled",
                node_id="n-42",
                location=SourceLocation(line=17),
            )
        ]
    )
    manifest, _, _ = _build(_rest_api(), analysis=analysis)
    edge = _edge_by_id(manifest, "analysis:warning:copybook.redefines_unsupported:n-42")
    assert edge.evidence[0].kind == "analysis-node"
    assert edge.evidence[0].ref == "n-42"
    assert edge.evidence[0].location is not None
    assert edge.evidence[0].location.line == 17


# ---------------------------------------------------------------------------
# AC: large results are bounded or paginated
# ---------------------------------------------------------------------------


def test_a_large_model_is_bounded_worst_status_first() -> None:
    """Truncation keeps the drops and sheds the uneventful rows, and says that it did."""
    api = _rest_api()
    # One channel per extra construct: each is a genuine ``dropped``, so they must all survive
    # while the far more numerous ``retained`` type rows are the ones bounding sheds.
    api.channels = [
        Channel(key=f"topic/{i:05d}", address=f"topic/{i:05d}") for i in range(50)
    ]
    api.types = [_record(f"T{i:05d}", f"T{i:05d}") for i in range(MAX_CONSTRUCT_EDGES)]

    manifest, report, _ = _build(api)
    construct_edges = manifest.edges_in_scope(ConversionEdgeScope.CONSTRUCT)
    assert len(construct_edges) == MAX_CONSTRUCT_EDGES
    assert manifest.truncated is True
    assert manifest.dropped_edge_count > 0
    assert manifest.bounds["maxConstructEdges"] == MAX_CONSTRUCT_EDGES

    dropped_edges = [e for e in construct_edges if e.status is ConversionStatus.DROPPED]
    assert len(dropped_edges) == 50, "every channel drop must survive bounding"

    # Bounding must never break reconciliation: the two reconciling scopes are exempt from it.
    reconcile_with_fidelity(manifest, report)

    # And no node is left behind pointing at an edge that was bounded away.
    referenced = {e.source for e in manifest.edges} | {
        e.target for e in manifest.edges if e.target
    }
    assert {node.id for node in manifest.nodes} == referenced


def test_pagination_is_deterministic_and_covers_every_edge() -> None:
    """Walking the cursors visits each edge exactly once, in the manifest's canonical order."""
    manifest, _, _ = _build(_event_api())
    seen: List[str] = []
    cursor: Optional[str] = None
    while True:
        page = paginate_conversion_evidence(manifest, cursor=cursor, limit=3)
        assert page.manifest_hash == manifest.manifest_hash
        assert page.total == len(manifest.edges)
        seen.extend(edge.id for edge in page.edges)
        # Every node an edge on this page references travels with it.
        page_node_ids = {node.id for node in page.nodes}
        for edge in page.edges:
            assert edge.source in page_node_ids
            if edge.target:
                assert edge.target in page_node_ids
        cursor = page.next_cursor
        if cursor is None:
            break
    assert seen == [edge.id for edge in manifest.edges]


def test_pagination_can_be_restricted_to_one_scope() -> None:
    """A renderer that only wants the construct lane pages just that lane."""
    manifest, _, _ = _build(_rest_api())
    page = paginate_conversion_evidence(
        manifest, scope=ConversionEdgeScope.CONSTRUCT, limit=MAX_EVIDENCE_PAGE_SIZE
    )
    assert page.total == len(manifest.edges_in_scope(ConversionEdgeScope.CONSTRUCT))
    assert all(edge.scope is ConversionEdgeScope.CONSTRUCT for edge in page.edges)


def test_the_page_limit_is_clamped_to_the_hard_cap() -> None:
    """A client cannot turn pagination off by asking for everything."""
    manifest, _, _ = _build(_rest_api())
    page = paginate_conversion_evidence(manifest, limit=10_000)
    assert len(page.edges) <= MAX_EVIDENCE_PAGE_SIZE
    assert len(paginate_conversion_evidence(manifest, limit=0).edges) == 1


def test_a_malformed_cursor_is_rejected() -> None:
    """A cursor that is not a valid token is a caller error, not a silent restart from zero."""
    manifest, _, _ = _build(_rest_api())
    with pytest.raises(ValueError, match="cursor"):
        paginate_conversion_evidence(manifest, cursor="not-a-cursor!!")


# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------


def test_the_summary_describes_the_same_snapshot_as_the_manifest() -> None:
    """A summary is a projection of the manifest, so every identity field agrees with it."""
    manifest, _, _ = _build(_rpc_api())
    summary = summarize_conversion_manifest(manifest)
    assert summary.manifest_hash == manifest.manifest_hash
    assert summary.schema_version == CONVERSION_MANIFEST_SCHEMA_VERSION
    assert summary.node_count == len(manifest.nodes)
    assert summary.edge_count == len(manifest.edges)
    assert summary.status_counts == manifest.status_counts
    assert summary.tool_versions == manifest.tool_versions
    assert summary.is_lossless is False
    assert summary.worst_severity is not None


def test_a_summary_round_trips_through_json() -> None:
    """The summary is persisted as JSONB, so it must survive a serialize/validate round-trip."""
    from app.conversion_projection import ConversionManifestSummary

    manifest, _, _ = _build(_rest_api())
    summary = summarize_conversion_manifest(manifest)
    restored = ConversionManifestSummary.model_validate(summary.model_dump(mode="json"))
    assert restored == summary


def test_an_empty_analysis_ref_is_constructible_for_stored_rows() -> None:
    """Pre-CPDO-1.3 provenance rows read back as a declared-unavailable analysis, not a crash."""
    ref = ConversionAnalysisRef(available=False, status="unavailable")
    source = ConversionManifestSource(analysis=ref)
    assert source.analysis.node_count == 0
    assert source.project_id is None


def test_duplicate_analysis_declarations_do_not_duplicate_edge_ids() -> None:
    """Edge ids must stay unique: two edges sharing one id break stable ids and node lookup."""
    warning = AnalysisWarning(code="x12.dupe", message="seen twice", node_id="n-1")
    analysis = _analysis(
        capabilities=analyzer_capabilities(unsupported=["x12.hl_hierarchy"]),
        warnings=[warning, warning.model_copy()],
    )
    # A directly-constructed capabilities block that ``analyzer_capabilities`` did not normalize.
    analysis.capabilities.unsupported = ["x12.hl_hierarchy", "x12.hl_hierarchy"]

    manifest, _, _ = _build(_rest_api(), analysis=analysis)
    ids = [edge.id for edge in manifest.edges]
    assert len(ids) == len(set(ids))
    assert ids.count("analysis:unsupported:x12.hl_hierarchy") == 1
    assert ids.count("analysis:warning:x12.dupe:n-1") == 1
