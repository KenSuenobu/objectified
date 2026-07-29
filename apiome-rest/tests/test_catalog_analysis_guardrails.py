"""Performance, redaction, audit, and observability guardrails — CPDO-4.2 (#4805).

Pins the four guarantees the ticket adds on top of the CPDO-1.x contract:

* **Budgets** — a client can lazily fetch only the top of an oversized stored tree
  (``maxNodes`` / ``maxDepth``), truncation stays declared, and serving a maximally
  sized tree fits the soft CI wall-clock budget.
* **Authorization** — the raw source read is gated on ``imports:view`` like the
  analysis tree and projection graph, checked after the item lookup.
* **Audit** — every successful raw-source and analysis-tree serve writes a
  content-free ``access_audit`` row.
* **Telemetry** — reads and page serves advance privacy-safe counters, the UI
  ingest endpoint accepts only whitelisted shapes, and the ops metrics payload
  exposes the counters so dashboards can reveal analyzer failures without content.
"""

from __future__ import annotations

import time
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from test_catalog_analysis_routes import _CATALOG_ITEM, _analysis_row, _wire_store

from app.analysis_telemetry import analysis_telemetry
from app.auth import validate_authentication
from app.main import app
from app.payload_analysis import (
    MAX_TREE_NODES,
    READ_BOUND_SOFT_BUDGET_SECONDS,
    REASON_BOUNDS_EXCEEDED,
    STATUS_AVAILABLE,
    STATUS_PARTIAL,
    AnalysisNode,
    AnalyzerInfo,
    PayloadAnalysisDocument,
    ValueVisibility,
    apply_value_visibility,
    bound_document,
    bound_tree,
    source_digest,
)

client = TestClient(app)

_MOCK_AUTH = {
    "tenant_id": "test-tenant-id",
    "user_id": "test-user-id",
    "user_email": "test@example.com",
    "auth_method": "jwt",
}


def _override_auth():
    return _MOCK_AUTH


@pytest.fixture(autouse=True)
def _reset_telemetry():
    analysis_telemetry.reset()
    yield
    analysis_telemetry.reset()


@pytest.fixture()
def _authed():
    app.dependency_overrides[validate_authentication] = _override_auth
    yield
    app.dependency_overrides.pop(validate_authentication, None)


def _wide_document(children: int) -> PayloadAnalysisDocument:
    """An ``available`` structural document with one root and ``children`` leaf nodes."""
    tree, metrics = bound_tree(
        [
            AnalysisNode(
                id="root",
                kind="interchange",
                name="ISA",
                children=[
                    AnalysisNode(id=f"seg-{i}", kind="segment", name=f"SEG{i}")
                    for i in range(children)
                ],
            )
        ]
    )
    document = PayloadAnalysisDocument(
        status=STATUS_AVAILABLE,
        source_format="edi-x12",
        source_hash=source_digest("ISA*00*"),
        analyzer=AnalyzerInfo(key="edix12", version="1.0.0"),
        tree=tree,
        metrics=metrics,
    )
    return apply_value_visibility(document, ValueVisibility.STRUCTURAL)


# ---------------------------------------------------------------------------
# bound_document — the read-time budget primitive
# ---------------------------------------------------------------------------
def test_bound_document_is_a_noop_when_the_budget_is_wider() -> None:
    document = _wide_document(children=5)
    assert bound_document(document, max_nodes=100, max_depth=10) is document


def test_bound_document_truncates_and_stays_declared() -> None:
    document = _wide_document(children=10)
    bounded = bound_document(document, max_nodes=4, max_depth=32)
    assert bounded.metrics.node_count == 4
    assert bounded.metrics.truncated is True
    assert bounded.metrics.dropped_node_count == 7
    assert bounded.status == STATUS_PARTIAL
    assert bounded.status_reason == REASON_BOUNDS_EXCEEDED
    # The result still satisfies the storage contract's truthfulness invariants.
    assert bounded.contract_violations() == []


def test_bound_document_accumulates_prior_truncation() -> None:
    """A tree already bounded on write reports write-time + read-time drops together."""
    document = _wide_document(children=10)
    once = bound_document(document, max_nodes=8, max_depth=32)
    twice = bound_document(once, max_nodes=4, max_depth=32)
    assert twice.metrics.dropped_node_count == 7
    assert twice.status == STATUS_PARTIAL
    # A partial record keeps its (already truthful) reason.
    assert twice.status_reason == REASON_BOUNDS_EXCEEDED


def test_bound_document_depth_budget_drops_subtrees() -> None:
    document = _wide_document(children=3)
    bounded = bound_document(document, max_nodes=MAX_TREE_NODES, max_depth=1)
    assert bounded.metrics.max_depth == 1
    assert bounded.tree[0].children == []
    assert bounded.metrics.truncated is True


def test_serving_a_maximally_sized_tree_fits_the_soft_budget() -> None:
    """Re-bounding + read-time redaction over a MAX_TREE_NODES tree fits the CI budget."""
    document = _wide_document(children=MAX_TREE_NODES - 1)
    started = time.perf_counter()
    bounded = bound_document(document, max_nodes=MAX_TREE_NODES // 2, max_depth=32)
    apply_value_visibility(bounded, ValueVisibility.NONE, policy_source="request")
    elapsed = time.perf_counter() - started
    assert elapsed < READ_BOUND_SOFT_BUDGET_SECONDS, (
        f"read-time bounding took {elapsed:.3f}s (budget {READ_BOUND_SOFT_BUDGET_SECONDS}s)"
    )


# ---------------------------------------------------------------------------
# Lazy analysis reads (maxNodes / maxDepth)
# ---------------------------------------------------------------------------
def test_analysis_max_nodes_returns_a_declared_prefix(_authed) -> None:
    with patch("app.catalog_routes.db") as mock_db, patch(
        "app.payload_analysis_store.db"
    ) as mock_store_db:
        mock_db.get_catalog_item_by_id.return_value = _CATALOG_ITEM
        mock_db.user_has_permission.return_value = True
        _wire_store(mock_store_db, row=_analysis_row())
        response = client.get("/v1/catalog/test-tenant/cat-1/analysis?maxNodes=1")

    assert response.status_code == 200
    analysis = response.json()["analysis"]
    assert analysis["metrics"]["nodeCount"] == 1
    assert analysis["metrics"]["truncated"] is True
    assert analysis["status"] == STATUS_PARTIAL
    assert analysis["statusReason"] == REASON_BOUNDS_EXCEEDED


def test_analysis_wide_budget_changes_nothing(_authed) -> None:
    with patch("app.catalog_routes.db") as mock_db, patch(
        "app.payload_analysis_store.db"
    ) as mock_store_db:
        mock_db.get_catalog_item_by_id.return_value = _CATALOG_ITEM
        mock_db.user_has_permission.return_value = True
        _wire_store(mock_store_db, row=_analysis_row())
        response = client.get("/v1/catalog/test-tenant/cat-1/analysis?maxNodes=5000")

    analysis = response.json()["analysis"]
    assert analysis["status"] == STATUS_AVAILABLE
    assert analysis["metrics"]["truncated"] is False


def test_analysis_rejects_a_zero_node_budget(_authed) -> None:
    with patch("app.catalog_routes.db") as mock_db:
        mock_db.get_catalog_item_by_id.return_value = _CATALOG_ITEM
        mock_db.user_has_permission.return_value = True
        response = client.get("/v1/catalog/test-tenant/cat-1/analysis?maxNodes=0")
    assert response.status_code == 422


# ---------------------------------------------------------------------------
# Audit — raw/analysis access leaves a content-free ledger row
# ---------------------------------------------------------------------------
def test_analysis_read_writes_a_content_free_audit_row(_authed) -> None:
    with patch("app.catalog_routes.db") as mock_db, patch(
        "app.payload_analysis_store.db"
    ) as mock_store_db:
        mock_db.get_catalog_item_by_id.return_value = _CATALOG_ITEM
        mock_db.user_has_permission.return_value = True
        _wire_store(mock_store_db, row=_analysis_row())
        response = client.get("/v1/catalog/test-tenant/cat-1/analysis")

    assert response.status_code == 200
    mock_db.write_access_audit.assert_called_once()
    kwargs = mock_db.write_access_audit.call_args.kwargs
    assert kwargs["action"] == "catalog.analysis.view"
    assert kwargs["target"] == "catalog:cat-1:analysis"
    assert kwargs["actor_id"] == "test-user-id"
    # Counts and statuses only — nothing from the tree itself.
    assert "SENSITIVE-ACCOUNT-42" not in str(kwargs["detail"])
    assert kwargs["detail"]["nodeCount"] == 2


def test_source_read_is_gated_on_imports_view(_authed) -> None:
    with patch("app.catalog_routes.db") as mock_db:
        mock_db.get_catalog_item_by_id.return_value = _CATALOG_ITEM
        mock_db.user_has_permission.return_value = False
        response = client.get("/v1/catalog/test-tenant/cat-1/source")
    assert response.status_code == 403
    assert "imports:view" in response.json()["detail"]


def test_missing_item_404s_before_the_source_permission(_authed) -> None:
    """A cross-tenant id must 404, not 403 — a 403 would confirm the id exists."""
    with patch("app.catalog_routes.db") as mock_db:
        mock_db.get_catalog_item_by_id.return_value = None
        mock_db.user_has_permission.return_value = False
        response = client.get("/v1/catalog/test-tenant/cat-other-tenant/source")
    assert response.status_code == 404


def test_source_read_writes_a_content_free_audit_row(_authed) -> None:
    with patch("app.catalog_routes.db") as mock_db:
        mock_db.get_catalog_item_by_id.return_value = _CATALOG_ITEM
        mock_db.user_has_permission.return_value = True
        response = client.get("/v1/catalog/test-tenant/cat-1/source")

    assert response.status_code == 200
    kwargs = mock_db.write_access_audit.call_args.kwargs
    assert kwargs["action"] == "catalog.source.view"
    assert kwargs["target"] == "catalog:cat-1:source"
    assert kwargs["detail"] == {"mode": "inline"}
    snap = analysis_telemetry.snapshot()
    assert snap["source_access"] == 1
    assert snap["source_access:inline"] == 1


# ---------------------------------------------------------------------------
# Telemetry — reads advance counters; the ingest endpoint is a strict whitelist
# ---------------------------------------------------------------------------
def test_analysis_read_advances_the_read_counter(_authed) -> None:
    with patch("app.catalog_routes.db") as mock_db, patch(
        "app.payload_analysis_store.db"
    ) as mock_store_db:
        mock_db.get_catalog_item_by_id.return_value = _CATALOG_ITEM
        mock_db.user_has_permission.return_value = True
        _wire_store(mock_store_db, row=_analysis_row())
        client.get("/v1/catalog/test-tenant/cat-1/analysis")

    snap = analysis_telemetry.snapshot()
    assert snap["analysis_read"] == 1
    assert snap["analysis_read:available"] == 1


def test_metric_ingest_records_a_ui_latency(_authed) -> None:
    response = client.post(
        "/v1/catalog/test-tenant/analysis-metrics",
        json={"kind": "ui_latency", "surface": "format_tab", "latency_ms": 120.5},
    )
    assert response.status_code == 200
    assert response.json() == {"recorded": True, "kind": "ui_latency"}
    assert analysis_telemetry.snapshot()["ui_latency:format_tab"] == 1


def test_metric_ingest_refuses_an_unknown_surface(_authed) -> None:
    response = client.post(
        "/v1/catalog/test-tenant/analysis-metrics",
        json={"kind": "ui_latency", "surface": "ISA*00*leaky-surface"},
    )
    assert response.status_code == 422
    assert analysis_telemetry.snapshot() == {}


def test_metric_ingest_refuses_a_server_side_kind(_authed) -> None:
    """The UI may report latency only; server-side kinds cannot be forged through the proxy."""
    response = client.post(
        "/v1/catalog/test-tenant/analysis-metrics",
        json={"kind": "analysis_failure", "surface": "format_tab"},
    )
    assert response.status_code == 422


def test_metric_ingest_refuses_extra_fields(_authed) -> None:
    """``extra="forbid"`` keeps payload material out of telemetry by construction."""
    response = client.post(
        "/v1/catalog/test-tenant/analysis-metrics",
        json={
            "kind": "ui_latency",
            "surface": "format_tab",
            "node_names": ["NM101"],
        },
    )
    assert response.status_code == 422


def test_metric_ingest_requires_auth() -> None:
    response = client.post(
        "/v1/catalog/test-tenant/analysis-metrics",
        json={"kind": "ui_latency", "surface": "format_tab"},
    )
    assert response.status_code == 401


# ---------------------------------------------------------------------------
# Ops visibility — dashboards see counters, never content
# ---------------------------------------------------------------------------
def test_ops_metrics_payload_exposes_analysis_counters() -> None:
    from app.ops_routes import _metrics_payload

    analysis_telemetry.record("analysis_failure", reason_category="analyzer_failed")
    payload = _metrics_payload()
    assert payload["catalog_analysis"]["analysis_failure"] == 1
    assert payload["catalog_analysis"]["analysis_failure:analyzer_failed"] == 1


# ---------------------------------------------------------------------------
# Import-time recording — completions and failures, categories only
# ---------------------------------------------------------------------------
def test_pipeline_records_a_completed_analysis() -> None:
    from app.import_source_pipeline import _record_analysis_telemetry

    _record_analysis_telemetry(
        _wide_document(children=3), latency_ms=12.0, payload_bytes=64
    )
    snap = analysis_telemetry.snapshot()
    assert snap["analysis_completed"] == 1
    assert snap["analysis_completed:available"] == 1


def test_pipeline_records_a_failed_analysis_by_category() -> None:
    from app.import_source_pipeline import _record_analysis_telemetry
    from app.payload_analysis import REASON_ANALYZER_FAILED, unavailable_document

    _record_analysis_telemetry(
        unavailable_document(REASON_ANALYZER_FAILED, failed=True),
        latency_ms=5.0,
        payload_bytes=None,
    )
    snap = analysis_telemetry.snapshot()
    assert snap["analysis_failure"] == 1
    assert snap["analysis_failure:analyzer_failed"] == 1
