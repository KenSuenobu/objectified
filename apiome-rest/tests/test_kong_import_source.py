"""Unit tests for the Kong declarative-config ImportSource (IXH-7.8 / #5133)."""

from __future__ import annotations

import pytest

from app.fileset import IntakeFileset
from app.import_preview_manifest import (
    CoverageClass,
    build_import_preview_manifest,
    paginate_import_preview_manifest,
)
from app.import_routing import decide_import_routing
from app.import_source import DetectionInput, ImportSourceError
from app.kong_import_source import KongImportSource


@pytest.fixture
def adapter() -> KongImportSource:
    return KongImportSource()


MINIMAL = """\
_format_version: "3.0"
services:
  - name: ping-service
    url: http://ping.internal:8080
    routes:
      - name: ping
        paths: ["/ping"]
        methods: [GET]
"""

AUTH_AND_REGEX = """\
_format_version: "3.0"
services:
  - name: users-service
    url: https://users.internal:8443/api
    plugins:
      - name: key-auth
        config:
          key_names: [x-api-key]
      - name: hmac-auth
    routes:
      - name: users
        hosts: [api.example.com]
        paths: ["/users", "~/users/(?<userId>\\\\d+)$"]
        methods: [GET]
        protocols: [https]
        strip_path: false
consumers:
  - username: alice
    keyauth_credentials:
      - key: super-secret-key-value
    basicauth_credentials:
      - username: alice
        password: super-secret-password
"""

ANY_METHOD = """\
_format_version: "3.0"
services:
  - name: catchall-service
    routes:
      - name: catchall
        hosts: [any.example.com]
        paths: ["/proxy"]
"""


def test_detect_claims_kong_config(adapter: KongImportSource) -> None:
    result = adapter.detect(DetectionInput(text=MINIMAL, filename="kong.yaml"))
    assert result.confidence >= 0.9
    assert result.format == "kong"


def test_detect_claims_pre_parsed_document(adapter: KongImportSource) -> None:
    document = {"_format_version": "3.0", "services": []}
    result = adapter.detect(DetectionInput(document=document))
    assert result.confidence >= 0.9


def test_detect_declines_openapi_and_httproute(adapter: KongImportSource) -> None:
    openapi = "openapi: 3.1.0\ninfo:\n  title: x\n  version: '1'\npaths: {}\n"
    assert adapter.detect(DetectionInput(text=openapi, filename="spec.yaml")).confidence == 0.0
    httproute = (
        "apiVersion: gateway.networking.k8s.io/v1\nkind: HTTPRoute\n"
        "metadata: {name: r}\nspec: {rules: []}\n"
    )
    assert adapter.detect(DetectionInput(text=httproute, filename="route.yaml")).confidence == 0.0


def test_parse_normalize_minimal(adapter: KongImportSource) -> None:
    model = adapter.normalize(adapter.parse(MINIMAL, source_label="kong.yaml"))
    assert model.format == "kong"
    assert model.paradigm.value == "rest"
    ops = model.operations()
    assert [op.key for op in ops] == ["GET /ping"]
    assert ops[0].messages == []  # the format carries no schemas
    assert model.extras["gateway"]["schemaless_operation_count"] == 1


def test_regex_paths_become_inferred_templates(adapter: KongImportSource) -> None:
    model = adapter.normalize(adapter.parse(AUTH_AND_REGEX, source_label="kong.yaml"))
    by_path = {op.http_path: op for op in model.operations()}
    assert "/users/{userId}" in by_path
    op = by_path["/users/{userId}"]
    path_params = [p for p in op.parameters if p.location.value == "path"]
    assert [p.name for p in path_params] == ["userId"]
    # The parameter is inferred from the regex, with the pattern as evidence.
    assert path_params[0].extras["provenance"] == "inferred"
    assert path_params[0].extras["pattern"].startswith("~/users/")


def test_auth_plugins_map_to_canonical_security(adapter: KongImportSource) -> None:
    model = adapter.normalize(adapter.parse(AUTH_AND_REGEX, source_label="kong.yaml"))
    assert model.extras["inferred_auth_schemes"] == ["apiKey"]
    op = model.operations()[0]
    schemes = {entry["scheme"] for entry in op.extras["security"]}
    assert "apiKey" in schemes
    # hmac-auth has no canonical mapping: preserved as an unmapped hint, never dropped.
    assert None in schemes
    unmapped = model.extras["gateway"]["unmapped_plugins"]
    assert {"name": "hmac-auth", "scope": "service"} in unmapped


def test_consumer_credentials_are_redacted(adapter: KongImportSource) -> None:
    model = adapter.normalize(adapter.parse(AUTH_AND_REGEX, source_label="kong.yaml"))
    assert model.extras["gateway"]["credential_redactions"] == 2
    dumped = model.model_dump_json()
    assert "super-secret-key-value" not in dumped
    assert "super-secret-password" not in dumped


def test_route_without_methods_imports_as_any(adapter: KongImportSource) -> None:
    model = adapter.normalize(adapter.parse(ANY_METHOD, source_label="kong.yaml"))
    op = model.operations()[0]
    assert op.key == "ANY /proxy"
    assert op.extras["methods_unrestricted"] is True


def test_routing_is_catalog_non_publishable_with_reason(adapter: KongImportSource) -> None:
    model = adapter.normalize(adapter.parse(MINIMAL, source_label="kong.yaml"))
    decision = decide_import_routing(adapter, model)
    assert decision.target.value == "catalog"
    assert decision.publishable is False
    assert decision.schemas_only is False
    assert "no request/response schemas" in decision.reason
    assert "convert" in decision.reason


def test_coverage_ledger_states_schema_capability_limit(adapter: KongImportSource) -> None:
    model = adapter.normalize(adapter.parse(AUTH_AND_REGEX, source_label="kong.yaml"))
    page = paginate_import_preview_manifest(
        build_import_preview_manifest(model, adapter_key="kong", options={})
    )
    rows = {r.source_construct: r for r in page.coverage}
    schema_row = rows["gateway#request-response-schemas"]
    # A capability limit of the source format — inferred/source_incomplete, never a drop.
    assert schema_row.coverage is CoverageClass.INFERRED
    assert schema_row.reason is not None and schema_row.reason.value == "source_incomplete"
    assert "not a drop" in schema_row.detail
    assert rows["gateway#auth.key-auth"].coverage is CoverageClass.INFERRED
    assert rows["gateway#plugin.hmac-auth"].coverage is CoverageClass.PARTIALLY_MAPPED
    assert (
        rows["gateway#consumers"].coverage is CoverageClass.UNSUPPORTED_BY_CANONICAL_MODEL
    )
    assert rows["gateway#credential-redactions"].coverage is CoverageClass.MAPPED


def test_parse_rejects_wrong_format(adapter: KongImportSource) -> None:
    openapi = "openapi: 3.1.0\ninfo:\n  title: x\n  version: '1'\npaths: {}\n"
    with pytest.raises(ImportSourceError) as exc_info:
        adapter.parse(openapi)
    assert exc_info.value.code == "FORMAT_MISMATCH"


def test_parse_rejects_routeless_config_as_semantic(adapter: KongImportSource) -> None:
    with pytest.raises(ImportSourceError) as exc_info:
        adapter.parse('_format_version: "3.0"\nservices:\n  - name: routeless\n')
    assert exc_info.value.code == "INPUT_SEMANTIC_INVALID"


def test_parse_rejects_truncated(adapter: KongImportSource) -> None:
    truncated = '_format_version: "3.0"\nservices:\n  - name: a\n    routes:\n      - paths: ['
    with pytest.raises(ImportSourceError) as exc_info:
        adapter.parse(truncated)
    assert exc_info.value.code == "INPUT_TRUNCATED"


def test_parse_rejects_binary_input(adapter: KongImportSource) -> None:
    with pytest.raises(ImportSourceError) as exc_info:
        adapter.parse('_format_version: "3.0"\x00services: []')
    assert exc_info.value.code == "INPUT_ENCODING_INVALID"


def test_parse_rejects_empty(adapter: KongImportSource) -> None:
    with pytest.raises(ImportSourceError) as exc_info:
        adapter.parse("   \n")
    assert exc_info.value.code == "INPUT_MALFORMED"


def test_fileset_merges_split_declarative_config(adapter: KongImportSource) -> None:
    fileset = IntakeFileset(
        root="kong-services.yaml",
        members={
            "kong-services.yaml": MINIMAL,
            "kong-routes.yaml": (
                '_format_version: "3.0"\n'
                "routes:\n"
                "  - name: status\n"
                "    service: ping-service\n"
                '    paths: ["/status"]\n'
                "    methods: [GET]\n"
            ),
            "README.md": "not a kong file\n",
        },
    )
    model = adapter.normalize(adapter.parse_fileset(fileset))
    assert {op.key for op in model.operations()} == {"GET /ping", "GET /status"}
