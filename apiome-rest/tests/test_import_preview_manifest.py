"""Import preview manifest — IXH-3.1 (#5103).

Pins the ticket's acceptance criteria for
``POST /v1/tenants/{slug}/import/preview-manifest``:

* **determinism** — the manifest is byte-stable for a fixed input, adapter version, and
  options, and its ``manifest_hash`` changes when the options change;
* **stable keys + source locations** — every canonical entity carries its stable key
  and, where the parser provides one, a source location (never fabricated);
* **coverage ledger** — ``unsupported-by-canonical-model`` and ``not-parsed-by-adapter``
  are never conflated (different reason codes), and every not-parsed entry names its
  CLX-2.4 capability-registry reference;
* **shared vocabulary (CPDO-1.3 / #4800)** — the import graph reuses the export
  projection manifest's node/edge models, enums, id schemes, ordering, and cursor codec
  (the shared contract test lives here);
* **bounded + paginated** — large inputs page over the entity tree with the truncation
  stated in the payload, never silent;
* **count reconciliation** — manifest counts equal the pre-flight's counts and the
  committed import summary's counts for the same document;
* **nothing persisted** — the persistence hooks are booby-trapped for every test.
"""

from __future__ import annotations

import base64
from typing import Any, Dict, List, Optional

import pytest
from fastapi.testclient import TestClient

from app import import_preview_manifest as manifest_module
from app import import_source_pipeline
from app.auth import validate_authentication
from app.canonical_model import (
    ApiIdentity,
    ApiParadigm,
    CanonicalApi,
    Channel,
    Operation,
    OperationKind,
    Service,
    Type,
    TypeKind,
)
from app.export_projection import (
    NATIVE_ID_EXTRA_KEYS,
    SOURCE_LOCATION_EXTRA_KEYS,
    ProjectionEdge,
    ProjectionEdgeRelation,
    ProjectionNode,
    ProjectionNodeKind,
    build_projection_manifest,
    decode_page_cursor,
    encode_page_cursor,
)
from app.import_preflight import clear_preflight_cache
from app.import_preview_manifest import (
    KNOWN_PARSER_LIMITS,
    MAX_ENTITY_PAGE_SIZE,
    PROVENANCE_EXTRA_KEYS,
    STATUS_FOR_COVERAGE,
    CoverageClass,
    ImportPreviewManifestRequest,
    build_import_preview_manifest,
    clear_preview_manifest_cache,
    coverage_for_outcome,
    paginate_import_preview_manifest,
    preview_manifest_cache_size,
)
from app.import_source import get_import_source, load_builtin_import_sources
from app.import_source_pipeline import run_adapter_import_job
from app.main import app
from app.openapi_emitter import OpenApiEmitter
from app.projection_taxonomy import ProjectionReason, ProjectionStatus

load_builtin_import_sources()

client = TestClient(app)

TENANT_ID = "550e8400-e29b-41d4-a716-446655440000"
TENANT_SLUG = "acme"
USER_ID = "660e8400-e29b-41d4-a716-446655440001"

_MOCK_AUTH = {
    "tenant_id": TENANT_ID,
    "tenant_slug": TENANT_SLUG,
    "user_id": USER_ID,
    "auth_method": "jwt",
}

ROUTE = f"/v1/tenants/{TENANT_SLUG}/import/preview-manifest"

#: A GraphQL schema producing a service, operations, and types through a real adapter.
GRAPHQL_DOC = """
type Query {
  order(id: ID!): Order
  orders: [Order]
}

type Order {
  id: ID!
  total: Float
}
""".strip()

#: Syntactically broken GraphQL — must yield ``ok=false`` with a taxonomy error.
BROKEN_GRAPHQL_DOC = "type Query { order(id: ID! : Order"


def _b64(text: str) -> str:
    return base64.standard_b64encode(text.encode("utf-8")).decode("ascii")


def _post(payload: Dict[str, Any]):
    return client.post(ROUTE, json=payload)


def _graphql_payload(**overrides: Any) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "document_base64": _b64(GRAPHQL_DOC),
        "filename": "schema.graphql",
    }
    payload.update(overrides)
    return payload


@pytest.fixture(autouse=True)
def _auth_override():
    def _fake_auth(tenant_slug: str):
        return {**_MOCK_AUTH, "tenant_slug": tenant_slug}

    app.dependency_overrides[validate_authentication] = _fake_auth
    app.openapi_schema = None
    yield
    app.dependency_overrides.pop(validate_authentication, None)
    app.openapi_schema = None


@pytest.fixture(autouse=True)
def _clean_caches():
    """Every test starts and ends with empty pre-flight and manifest caches."""
    clear_preflight_cache()
    clear_preview_manifest_cache()
    yield
    clear_preflight_cache()
    clear_preview_manifest_cache()


@pytest.fixture(autouse=True)
def _no_persistence(monkeypatch):
    """Booby-trap every persistence hook: the manifest must never write anything."""
    reached: List[str] = []

    def _trap(name: str):
        def _hook(*args: Any, **kwargs: Any):
            reached.append(name)
            raise AssertionError(f"preview manifest reached {name}")

        return _hook

    monkeypatch.setattr(
        import_source_pipeline, "persist_adapter_import", _trap("persist_adapter_import")
    )
    monkeypatch.setattr(
        import_source_pipeline, "persist_types_as_current", _trap("persist_types_as_current")
    )
    monkeypatch.setattr(
        import_source_pipeline,
        "capture_canonical_quality_score",
        _trap("capture_canonical_quality_score"),
    )
    return reached


# ---------------------------------------------------------------------------
# Hand-built models for the pure builder tests
# ---------------------------------------------------------------------------


def _model(
    *,
    types: Optional[List[Type]] = None,
    root_extras: Optional[Dict[str, Any]] = None,
    format_key: str = "graphql",
) -> CanonicalApi:
    """A small deterministic model: one service, two operations, a channel, and types."""
    operations = [
        Operation(
            key="Query.order",
            name="order",
            kind=OperationKind.QUERY,
            extras={"source_location": "3:3"},
        ),
        Operation(key="Query.orders", name="orders", kind=OperationKind.QUERY),
    ]
    service = Service(key="Query", name="Query", operations=operations)
    channel = Channel(key="order/created", address="order/created", protocol="kafka")
    return CanonicalApi(
        paradigm=ApiParadigm.GRAPH,
        format=format_key,
        identity=ApiIdentity(name="Orders"),
        services=[service],
        channels=[channel],
        types=types
        if types is not None
        else [
            Type(
                key="Order",
                name="Order",
                kind=TypeKind.RECORD,
                extras={"source_location": "7:1", "native_id": "Order#7"},
            )
        ],
        extras=dict(root_extras or {}),
    )


def _wide_model(type_count: int) -> CanonicalApi:
    """A model with many types, for the pagination tests."""
    return _model(
        types=[
            Type(key=f"T{index:03d}", name=f"T{index:03d}", kind=TypeKind.RECORD)
            for index in range(type_count)
        ]
    )


# ---------------------------------------------------------------------------
# Contract surface
# ---------------------------------------------------------------------------


def test_openapi_exposes_the_preview_manifest_operation():
    spec = app.openapi()
    path = "/v1/tenants/{tenant_slug}/import/preview-manifest"
    assert path in spec["paths"], "preview-manifest route missing from the OpenAPI contract"
    schema_ref = spec["paths"][path]["post"]["responses"]["200"]["content"][
        "application/json"
    ]["schema"]["$ref"]
    assert schema_ref.endswith("ImportPreviewManifestResponse")


def test_route_returns_manifest_with_entity_tree_and_preflight():
    response = _post(_graphql_payload())
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is True
    assert body["preflight"]["detection"]["adapter_key"] == "graphql"
    assert body["preflight"]["routing"] is not None

    manifest = body["manifest"]
    assert manifest is not None
    kinds = {entity["entity_kind"] for entity in manifest["entities"]}
    assert {"service", "operation", "type"} <= kinds
    operations = [e for e in manifest["entities"] if e["entity_kind"] == "operation"]
    assert operations, "expected operation entities"
    # Every operation is parented to its service; every entity carries its stable key.
    services = {e["key"] for e in manifest["entities"] if e["entity_kind"] == "service"}
    for operation in operations:
        assert operation["parent_key"] in services
        assert operation["key"]

    assert manifest["adapter"]["adapter_key"] == "graphql"
    assert manifest["adapter"]["capability"]["format"]
    assert manifest["manifest_hash"]


def test_unimportable_candidate_reports_error_and_no_manifest():
    response = _post({"document_base64": _b64(BROKEN_GRAPHQL_DOC), "filename": "x.graphql"})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is False
    assert body["manifest"] is None
    assert body["preflight"]["error"]["code"], "expected a stable intake-taxonomy code"


@pytest.mark.anyio
async def test_preview_manifest_never_persists(_no_persistence):
    response = _post(_graphql_payload())
    assert response.status_code == 200
    assert _no_persistence == [], "preview manifest reached a persistence hook"


# ---------------------------------------------------------------------------
# Determinism / byte stability
# ---------------------------------------------------------------------------


def test_builder_is_byte_stable_for_fixed_input_and_options():
    api = _model()
    options = {"source_kind": "graphql"}
    first = build_import_preview_manifest(api, adapter_key="graphql", options=options)
    second = build_import_preview_manifest(api, adapter_key="graphql", options=options)
    page_a = paginate_import_preview_manifest(first)
    page_b = paginate_import_preview_manifest(second)
    assert page_a.model_dump_json() == page_b.model_dump_json()
    assert first.manifest_hash == second.manifest_hash


def test_manifest_hash_changes_with_options():
    api = _model()
    plain = build_import_preview_manifest(api, adapter_key="graphql", options={})
    targeted = build_import_preview_manifest(
        api, adapter_key="graphql", options={"import_target": "types"}
    )
    assert plain.manifest_hash != targeted.manifest_hash


def test_route_is_deterministic_across_calls_and_serves_the_manifest_cache():
    first = _post(_graphql_payload())
    assert preview_manifest_cache_size() == 1
    second = _post(_graphql_payload())
    assert first.json()["manifest"]["manifest_hash"] == second.json()["manifest"]["manifest_hash"]
    assert first.json()["manifest"] == second.json()["manifest"]
    assert preview_manifest_cache_size() == 1


def test_paging_does_not_rebuild_the_manifest(monkeypatch):
    calls: List[str] = []
    real_build = manifest_module.build_import_preview_manifest

    def _counting_build(*args: Any, **kwargs: Any):
        calls.append("build")
        return real_build(*args, **kwargs)

    monkeypatch.setattr(manifest_module, "build_import_preview_manifest", _counting_build)
    first = _post(_graphql_payload(page_size=1))
    cursor = first.json()["manifest"]["next_cursor"]
    assert cursor is not None
    second = _post(_graphql_payload(page_size=1, cursor=cursor))
    assert second.status_code == 200
    assert calls == ["build"], "paging a cached manifest must not re-run the build"


# ---------------------------------------------------------------------------
# Stable keys, source locations, provenance
# ---------------------------------------------------------------------------


def test_entities_carry_stable_keys_and_parser_provided_source_locations():
    full = build_import_preview_manifest(_model(), adapter_key="graphql", options={})
    page = paginate_import_preview_manifest(full)
    by_key = {entity.key: entity for entity in page.entities}

    located = by_key["Query.order"]
    assert located.source_location == "3:3"

    typed = by_key["Order"]
    assert typed.source_location == "7:1"
    assert typed.native_id == "Order#7"

    # No location captured → None, never fabricated.
    assert by_key["Query.orders"].source_location is None
    # Provenance-only extras never count as unmodeled source attributes.
    assert located.unmodeled_extras == []
    assert located.coverage is CoverageClass.MAPPED


def test_provenance_keys_match_the_export_manifest():
    """Both manifests must read provenance from the same extras keys."""
    assert PROVENANCE_EXTRA_KEYS == frozenset(SOURCE_LOCATION_EXTRA_KEYS) | frozenset(
        NATIVE_ID_EXTRA_KEYS
    )


# ---------------------------------------------------------------------------
# Coverage ledger
# ---------------------------------------------------------------------------


def test_entity_with_unmodeled_extras_is_partially_mapped():
    api = _model(
        types=[
            Type(
                key="Order",
                name="Order",
                kind=TypeKind.RECORD,
                extras={"x-custom-directive": True, "source_location": "7:1"},
            )
        ]
    )
    full = build_import_preview_manifest(api, adapter_key="graphql", options={})
    page = paginate_import_preview_manifest(full)
    entity = next(e for e in page.entities if e.key == "Order")
    assert entity.coverage is CoverageClass.PARTIALLY_MAPPED
    assert entity.unmodeled_extras == ["x-custom-directive"]
    row = next(r for r in page.coverage if r.entity_key == "Order")
    assert row.status is ProjectionStatus.APPROXIMATED
    assert row.reason is ProjectionReason.DESTINATION_UNSUPPORTED
    assert "x-custom-directive" in row.detail


def test_document_level_extras_are_unsupported_by_canonical_model():
    api = _model(root_extras={"x-vendor-policy": {"tier": "gold"}})
    full = build_import_preview_manifest(api, adapter_key="graphql", options={})
    page = paginate_import_preview_manifest(full)
    row = next(
        r for r in page.coverage if r.coverage is CoverageClass.UNSUPPORTED_BY_CANONICAL_MODEL
    )
    assert row.source_construct == "document#x-vendor-policy"
    assert row.status is ProjectionStatus.DROPPED
    assert row.reason is ProjectionReason.DESTINATION_UNSUPPORTED
    assert row.document_scoped is True
    # The drop is stated in the shared graph too: a projects edge to nowhere.
    edge = next(e for e in page.edges if e.id == "projects:document#x-vendor-policy#0")
    assert edge.target is None
    assert edge.status is ProjectionStatus.DROPPED


def test_declared_parser_limits_are_not_parsed_by_adapter_with_registry_reference():
    api = _model(format_key="thrift")
    full = build_import_preview_manifest(api, adapter_key="thrift", options={})
    page = paginate_import_preview_manifest(full)
    rows = [r for r in page.coverage if r.coverage is CoverageClass.NOT_PARSED_BY_ADAPTER]
    assert rows, "thrift declares a parser limit"
    for row in rows:
        assert row.status is ProjectionStatus.DROPPED
        assert row.reason is ProjectionReason.SOURCE_PARSE_LIMIT
        assert row.document_scoped is False, "a declared limit is not a per-document claim"
        assert row.capability_reference is not None, "AC: names the capability-registry entry"
        assert row.capability_reference.format
    assert page.adapter.parser_limits == [
        limit.construct for limit in KNOWN_PARSER_LIMITS["thrift"]
    ]


def test_the_two_dropped_classes_are_never_conflated():
    """'The model cannot hold this' and 'our parser does not read this' differ by reason."""
    unsupported = STATUS_FOR_COVERAGE[CoverageClass.UNSUPPORTED_BY_CANONICAL_MODEL]
    not_parsed = STATUS_FOR_COVERAGE[CoverageClass.NOT_PARSED_BY_ADAPTER]
    assert unsupported[0] is not_parsed[0] is ProjectionStatus.DROPPED
    assert unsupported[1] is not not_parsed[1]
    assert not_parsed[1] is ProjectionReason.SOURCE_PARSE_LIMIT


def test_every_declared_parser_limit_names_a_registered_adapter():
    load_builtin_import_sources()
    for adapter_key in KNOWN_PARSER_LIMITS:
        assert get_import_source(adapter_key) is not None, (
            f"KNOWN_PARSER_LIMITS names {adapter_key!r}, which is not a registered adapter"
        )


# ---------------------------------------------------------------------------
# Shared CPDO-1.3 vocabulary contract (AC: the two manifests agree)
# ---------------------------------------------------------------------------


def test_import_manifest_reuses_the_shared_taxonomy_identically():
    """The import module re-exports — never redefines — the shared enums and models."""
    from app import export_projection, projection_taxonomy

    assert manifest_module.ProjectionStatus is projection_taxonomy.ProjectionStatus
    assert manifest_module.ProjectionReason is projection_taxonomy.ProjectionReason
    assert manifest_module.ProjectionNode is export_projection.ProjectionNode
    assert manifest_module.ProjectionEdge is export_projection.ProjectionEdge
    assert manifest_module.ProjectionNodeKind is export_projection.ProjectionNodeKind
    assert manifest_module.ProjectionEdgeRelation is export_projection.ProjectionEdgeRelation
    assert manifest_module.encode_page_cursor is export_projection.encode_page_cursor
    assert manifest_module.decode_page_cursor is export_projection.decode_page_cursor


def test_coverage_classes_are_a_bijection_over_shared_status_reason_pairs():
    pairs = set()
    for coverage in CoverageClass:
        status, reason = STATUS_FOR_COVERAGE[coverage]
        assert isinstance(status, ProjectionStatus)
        assert reason is None or isinstance(reason, ProjectionReason)
        assert (status, reason) not in pairs, "two coverage classes share a (status, reason)"
        pairs.add((status, reason))
        assert coverage_for_outcome(status, reason) is coverage
    assert coverage_for_outcome(ProjectionStatus.SYNTHESIZED, None) is None


def test_import_and_export_graphs_share_id_schemes_ordering_and_validation():
    """Build both manifests and assert the structural contract is one contract."""
    api = _model(format_key="openapi-3.1")
    import_full = build_import_preview_manifest(api, adapter_key="openapi", options={})
    import_page = paginate_import_preview_manifest(import_full)
    export_manifest = build_projection_manifest(api, OpenApiEmitter)

    def _id_prefixes(nodes, edges):
        return (
            {node.id.split(":", 1)[0] for node in nodes},
            {edge.id.split(":", 1)[0] for edge in edges},
        )

    import_node_prefixes, import_edge_prefixes = _id_prefixes(import_page.nodes, import_page.edges)
    export_node_prefixes, export_edge_prefixes = _id_prefixes(
        export_manifest.nodes, export_manifest.edges
    )
    assert import_node_prefixes <= {"native", "canonical", "target"}
    assert import_node_prefixes <= export_node_prefixes | {"target"}
    assert import_edge_prefixes == {"derives", "projects"} == export_edge_prefixes

    # Both surfaces order nodes by (kind lane, id) and edges by id.
    kind_order = {
        ProjectionNodeKind.NATIVE: 0,
        ProjectionNodeKind.CANONICAL: 1,
        ProjectionNodeKind.TARGET: 2,
    }
    for nodes in (import_page.nodes, export_manifest.nodes):
        assert [n.id for n in nodes] == [
            n.id for n in sorted(nodes, key=lambda n: (kind_order[n.kind], n.id))
        ]
    for edges in (import_page.edges, export_manifest.edges):
        assert [e.id for e in edges] == [e.id for e in sorted(edges, key=lambda e: e.id)]

    # Every node/edge in both graphs is an instance of the one shared model.
    assert all(isinstance(node, ProjectionNode) for node in import_page.nodes)
    assert all(isinstance(edge, ProjectionEdge) for edge in import_page.edges)
    assert all(isinstance(node, ProjectionNode) for node in export_manifest.nodes)
    assert all(isinstance(edge, ProjectionEdge) for edge in export_manifest.edges)


def test_shared_edge_model_enforces_reason_codes_for_the_import_direction_too():
    """A dropped outcome edge without a reason is invalid — same rule both directions."""
    with pytest.raises(ValueError):
        ProjectionEdge(
            id="projects:X#0",
            relation=ProjectionEdgeRelation.PROJECTS,
            source="native:X",
            target=None,
            status=ProjectionStatus.DROPPED,
            detail="dropped without a reason",
        )


def test_cursor_codec_is_shared_and_round_trips():
    assert decode_page_cursor(encode_page_cursor(42)) == 42
    with pytest.raises(ValueError):
        decode_page_cursor("not-a-cursor!")


# ---------------------------------------------------------------------------
# Bounded, paginated output
# ---------------------------------------------------------------------------


def test_pagination_covers_every_entity_exactly_once_and_states_truncation():
    full = build_import_preview_manifest(_wide_model(25), adapter_key="graphql", options={})
    seen: List[str] = []
    coverage_rows = 0
    cursor: Optional[str] = None
    pages = 0
    while True:
        page = paginate_import_preview_manifest(full, cursor=cursor, page_size=10)
        pages += 1
        seen.extend(entity.key for entity in page.entities)
        coverage_rows += len(page.coverage)
        assert page.total_entities == full.total_entities
        assert page.total_coverage_entries == full.total_coverage_entries
        assert page.manifest_hash == full.manifest_hash
        if page.next_cursor is None:
            assert page.truncated == (pages > 1), "a multi-page walk states its truncation"
            break
        assert page.truncated is True, "truncation must be stated, never silent"
        cursor = page.next_cursor
    assert pages == 3
    assert len(seen) == len(set(seen)) == full.total_entities
    assert coverage_rows == full.total_coverage_entries


def test_single_page_manifest_is_not_truncated():
    full = build_import_preview_manifest(_model(), adapter_key="graphql", options={})
    page = paginate_import_preview_manifest(full)
    assert page.next_cursor is None
    assert page.truncated is False
    assert len(page.entities) == full.total_entities


def test_page_size_is_clamped_to_the_hard_cap():
    full = build_import_preview_manifest(_model(), adapter_key="graphql", options={})
    page = paginate_import_preview_manifest(full, page_size=10_000_000)
    assert page.page_size == MAX_ENTITY_PAGE_SIZE


def test_document_scope_rows_ride_on_the_first_page_only():
    api = _model(root_extras={"x-vendor-policy": True})
    full = build_import_preview_manifest(api, adapter_key="graphql", options={})
    first = paginate_import_preview_manifest(full, page_size=2)
    rest = paginate_import_preview_manifest(full, cursor=first.next_cursor, page_size=2)
    assert any(r.source_construct.startswith("document#") for r in first.coverage)
    assert not any(r.source_construct.startswith("document#") for r in rest.coverage)


def test_malformed_cursor_is_a_422_not_a_500():
    response = _post(_graphql_payload(cursor="!!!bad!!!"))
    assert response.status_code == 422


# ---------------------------------------------------------------------------
# Count reconciliation (AC: manifest counts == committed import counts)
# ---------------------------------------------------------------------------


def test_manifest_counts_match_preflight_counts_over_the_route():
    body = _post(_graphql_payload()).json()
    assert body["manifest"]["counts"] == body["preflight"]["counts"]
    entities = body["manifest"]["entities"]
    by_kind = {
        kind: sum(1 for e in entities if e["entity_kind"] == kind)
        for kind in ("service", "operation", "type", "channel")
    }
    counts = body["manifest"]["counts"]
    assert by_kind["service"] == counts["services"]
    assert by_kind["operation"] == counts["operations"]
    assert by_kind["type"] == counts["types"]
    assert by_kind["channel"] == counts["channels"]


@pytest.mark.anyio
async def test_manifest_counts_reconcile_with_the_committed_import_summary():
    """The same document through the committing pipeline reports the same counts."""
    adapter = get_import_source("graphql")
    status = await run_adapter_import_job(
        adapter,
        {
            "document_base64": _b64(GRAPHQL_DOC),
            "filename": "schema.graphql",
            "tenant_id": TENANT_ID,
            "tenant_slug": TENANT_SLUG,
            "user_id": USER_ID,
            "rest_job_id": "manifest-reconcile-test",
            "metadata": {
                "source_kind": "graphql",
                "project": {"name": "Orders", "slug": "orders"},
                "version": {"version_id": "0.0.1"},
                "options": {"dry_run": True},
            },
        },
    )
    assert status.state == "completed", status.error
    summary_counts = status.summary["counts"]

    body = _post(_graphql_payload()).json()
    assert body["manifest"]["counts"] == summary_counts


# ---------------------------------------------------------------------------
# Status/coverage count invariants
# ---------------------------------------------------------------------------


def test_counts_are_zero_filled_over_the_full_shared_vocabulary():
    full = build_import_preview_manifest(_model(), adapter_key="graphql", options={})
    page = paginate_import_preview_manifest(full)
    assert set(page.coverage_counts) == {coverage.value for coverage in CoverageClass}
    assert set(page.status_counts) == {status.value for status in ProjectionStatus}
    assert set(page.reason_counts) == {reason.value for reason in ProjectionReason}
    assert sum(page.coverage_counts.values()) == page.total_coverage_entries


def test_request_model_rejects_unknown_fields():
    with pytest.raises(Exception):
        ImportPreviewManifestRequest(document_base64=_b64("x"), unknown_field=1)
