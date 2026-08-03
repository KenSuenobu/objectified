"""Unit tests for the Gateway API HTTPRoute ImportSource (IXH-7.8 / #5133)."""

from __future__ import annotations

import pytest

from app.fileset import IntakeFileset
from app.gateway_api_import_source import GatewayApiImportSource
from app.import_preview_manifest import (
    CoverageClass,
    build_import_preview_manifest,
    paginate_import_preview_manifest,
)
from app.import_routing import decide_import_routing
from app.import_source import DetectionInput, ImportSourceError, get_import_source


@pytest.fixture
def adapter() -> GatewayApiImportSource:
    return GatewayApiImportSource()


MINIMAL = """\
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: ping
spec:
  rules:
    - matches:
        - path: {type: Exact, value: /ping}
          method: GET
      backendRefs:
        - name: ping-svc
          port: 8080
"""

STREAM_WITH_GATEWAY = """\
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata: {name: main-gateway}
spec: {gatewayClassName: istio}
---
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: orders
  namespace: shop
spec:
  hostnames: [shop.example.com]
  rules:
    - matches:
        - path: {type: PathPrefix, value: /orders}
          method: GET
        - path: {type: PathPrefix, value: /orders}
          method: POST
      backendRefs:
        - name: orders-svc
          port: 8080
"""

MATCHES_AND_FILTERS = """\
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: reports
  namespace: analytics
spec:
  hostnames: [api.example.com]
  rules:
    - matches:
        - path: {type: RegularExpression, value: "/tenants/(?<tenantId>[a-z0-9-]+)/usage"}
          method: GET
          headers:
            - name: x-tenant
              value: acme
          queryParams:
            - name: window
              value: 30d
      filters:
        - type: ExtensionRef
          extensionRef: {group: policy.example.com, kind: AuthPolicy, name: reports-auth}
      backendRefs:
        - name: usage-svc
          port: 8081
          weight: 100
"""


def test_detect_claims_httproute(adapter: GatewayApiImportSource) -> None:
    result = adapter.detect(DetectionInput(text=MINIMAL, filename="route.yaml"))
    assert result.confidence >= 0.9
    assert result.format == "gateway-api"


def test_detect_declines_crd_and_kong(adapter: GatewayApiImportSource) -> None:
    crd = (
        "apiVersion: apiextensions.k8s.io/v1\nkind: CustomResourceDefinition\n"
        "metadata: {name: widgets.example.com}\nspec: {}\n"
    )
    assert adapter.detect(DetectionInput(text=crd, filename="widgets.yaml")).confidence == 0.0
    kong = '_format_version: "3.0"\nservices: []\n'
    assert adapter.detect(DetectionInput(text=kong, filename="kong.yaml")).confidence == 0.0


def test_crd_adapter_does_not_claim_httproute(adapter: GatewayApiImportSource) -> None:
    crd_adapter = get_import_source("k8s-crd")
    assert crd_adapter is not None
    assert crd_adapter.detect(DetectionInput(text=MINIMAL, filename="route.yaml")).confidence == 0.0


def test_parse_normalize_minimal(adapter: GatewayApiImportSource) -> None:
    model = adapter.normalize(adapter.parse(MINIMAL, source_label="route.yaml"))
    assert model.format == "gateway-api"
    ops = model.operations()
    assert [op.key for op in ops] == ["GET /ping"]
    assert ops[0].messages == []  # the format carries no schemas
    assert ops[0].extras["backends"] == [{"name": "ping-svc", "port": 8080}]


def test_stream_imports_routes_and_reports_gateway_as_ignored(
    adapter: GatewayApiImportSource,
) -> None:
    model = adapter.normalize(adapter.parse(STREAM_WITH_GATEWAY, source_label="stream.yaml"))
    assert {op.key for op in model.operations()} == {"GET /orders", "POST /orders"}
    assert [server.url for server in model.servers] == ["https://shop.example.com"]
    ignored = model.extras["gateway"]["ignored_constructs"]
    assert any(entry["construct"] == "Gateway" for entry in ignored)


def test_header_query_matches_become_parameters(adapter: GatewayApiImportSource) -> None:
    model = adapter.normalize(adapter.parse(MATCHES_AND_FILTERS, source_label="reports.yaml"))
    op = model.operations()[0]
    assert op.http_path == "/tenants/{tenantId}/usage"
    by_location = {}
    for parameter in op.parameters:
        by_location.setdefault(parameter.location.value, []).append(parameter.name)
    assert by_location["path"] == ["tenantId"]
    assert by_location["header"] == ["x-tenant"]
    assert by_location["query"] == ["window"]
    # The ExtensionRef filter has no canonical mapping; it is preserved in extras.
    assert "ExtensionRef" in op.extras["plugins"]


def test_routing_is_catalog_non_publishable_with_reason(
    adapter: GatewayApiImportSource,
) -> None:
    model = adapter.normalize(adapter.parse(MINIMAL, source_label="route.yaml"))
    decision = decide_import_routing(adapter, model)
    assert decision.target.value == "catalog"
    assert decision.publishable is False
    assert "no request/response schemas" in decision.reason


def test_coverage_ledger_states_schema_capability_limit(
    adapter: GatewayApiImportSource,
) -> None:
    model = adapter.normalize(adapter.parse(STREAM_WITH_GATEWAY, source_label="stream.yaml"))
    page = paginate_import_preview_manifest(
        build_import_preview_manifest(model, adapter_key="gateway-api", options={})
    )
    rows = {r.source_construct: r for r in page.coverage}
    schema_row = rows["gateway#request-response-schemas"]
    assert schema_row.coverage is CoverageClass.INFERRED
    assert schema_row.reason is not None and schema_row.reason.value == "source_incomplete"
    assert "not a drop" in schema_row.detail
    assert rows["gateway#Gateway"].coverage is CoverageClass.UNSUPPORTED_BY_CANONICAL_MODEL
    # The adapter's declared parser limit names its construct class.
    assert any(
        row.coverage is CoverageClass.NOT_PARSED_BY_ADAPTER and not row.document_scoped
        for row in page.coverage
    )


def test_parse_rejects_wrong_format(adapter: GatewayApiImportSource) -> None:
    deployment = "apiVersion: apps/v1\nkind: Deployment\nmetadata: {name: x}\nspec: {}\n"
    with pytest.raises(ImportSourceError) as exc_info:
        adapter.parse(deployment)
    assert exc_info.value.code == "FORMAT_MISMATCH"


def test_parse_rejects_gateway_only_stream_as_semantic(
    adapter: GatewayApiImportSource,
) -> None:
    gateway_only = (
        "apiVersion: gateway.networking.k8s.io/v1\nkind: Gateway\n"
        "metadata: {name: g}\nspec: {gatewayClassName: istio}\n"
    )
    with pytest.raises(ImportSourceError) as exc_info:
        adapter.parse(gateway_only)
    assert exc_info.value.code == "INPUT_SEMANTIC_INVALID"


def test_parse_rejects_truncated(adapter: GatewayApiImportSource) -> None:
    truncated = (
        "apiVersion: gateway.networking.k8s.io/v1\nkind: HTTPRoute\n"
        "metadata: {name: cut}\nspec:\n  rules:\n    - matches:\n        - path: {type: Exact, value:"
    )
    with pytest.raises(ImportSourceError) as exc_info:
        adapter.parse(truncated)
    assert exc_info.value.code == "INPUT_TRUNCATED"


def test_parse_rejects_binary_input(adapter: GatewayApiImportSource) -> None:
    with pytest.raises(ImportSourceError) as exc_info:
        adapter.parse("apiVersion: gateway.networking.k8s.io/v1\x00kind: HTTPRoute")
    assert exc_info.value.code == "INPUT_ENCODING_INVALID"


def test_parse_rejects_empty(adapter: GatewayApiImportSource) -> None:
    with pytest.raises(ImportSourceError) as exc_info:
        adapter.parse("   \n")
    assert exc_info.value.code == "INPUT_MALFORMED"


def test_fileset_merges_manifest_directory(adapter: GatewayApiImportSource) -> None:
    fileset = IntakeFileset(
        root="routes-a.yaml",
        members={
            "routes-a.yaml": MINIMAL,
            "routes-b.yaml": STREAM_WITH_GATEWAY,
            "kustomization.yaml": "resources:\n  - routes-a.yaml\n  - routes-b.yaml\n",
        },
    )
    model = adapter.normalize(adapter.parse_fileset(fileset))
    assert {op.key for op in model.operations()} == {
        "GET /ping",
        "GET /orders",
        "POST /orders",
    }
