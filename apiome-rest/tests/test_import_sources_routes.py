"""Endpoint tests for the import-source enumeration API (MFI-1.3, #3735)."""

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_session_credentials
from app.import_source import (
    _REGISTRY,
    ApiParadigm,
    ImportSource,
    InputKind,
)
from app.main import app

client = TestClient(app)

_MOCK_AUTH = {"tenant_id": "t1", "user_id": "u1", "auth_method": "jwt"}


def _override_auth():
    return _MOCK_AUTH


@pytest.fixture(autouse=True)
def _auth():
    app.dependency_overrides[validate_session_credentials] = _override_auth
    yield
    app.dependency_overrides.clear()


def test_list_import_sources_returns_registered_adapters():
    r = client.get("/v1/import/sources")
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body["sources"], list)
    by_key = {s["key"]: s for s in body["sources"]}

    # The reference OpenAPI adapter (MFI-1.1) is always present and self-describes.
    assert "openapi" in by_key
    openapi = by_key["openapi"]
    assert openapi["label"] == "OpenAPI / Swagger"
    assert openapi["icon"] == "file-json"
    assert openapi["paradigm"] == "rest"
    # IXH-7.7: fileset intake carries a base document plus Overlay 1.0 overlays.
    assert openapi["input_kinds"] == ["file", "url", "paste", "fileset"]
    assert openapi["supports_live_discovery"] is False
    assert "openapi-3.1" in openapi["formats"]


def test_list_import_sources_is_sorted_by_key():
    r = client.get("/v1/import/sources")
    keys = [s["key"] for s in r.json()["sources"]]
    assert keys == sorted(keys)


def test_list_import_sources_requires_authentication():
    # Drop the override so the real dependency runs and rejects the anonymous call.
    # An unauthenticated call must be 401 — *not* 422. A 422 here would mean the
    # endpoint declares a required request parameter (the tenant-scoped dependency's
    # ``tenant_slug`` leaking in as a required query param) and would reject every real
    # authenticated UI call too — the #4084-adjacent 422 regression this guards against.
    app.dependency_overrides.clear()
    r = client.get("/v1/import/sources")
    assert r.status_code == 401


def test_list_import_sources_has_no_required_request_params():
    # The enumeration endpoint is non-tenant registry metadata: it must not require any
    # query/path parameter (only header credentials). Guards against reintroducing a
    # tenant-scoped auth dependency that would make ``tenant_slug`` a required query
    # param and 422 every real call (see /api/import/sources returning 422).
    schema = app.openapi()
    params = schema["paths"]["/v1/import/sources"]["get"].get("parameters", [])
    required_non_header = [
        p["name"] for p in params if p.get("required") and p["in"] != "header"
    ]
    assert required_non_header == []


def test_new_adapter_appears_without_route_changes():
    """Registering an adapter server-side surfaces a new entry — the contract that
    lets a new source card appear in the UI with no UI/route code change."""

    class _ProbeImportSource(ImportSource):  # not auto-registered
        key = "probe-format"
        label = "Probe Format"
        description = "A throwaway adapter used only by this test."
        icon = "boxes"
        paradigm = ApiParadigm.REST
        input_kinds = (InputKind.FILE, InputKind.PASTE)
        supports_live_discovery = False
        formats = ("probe-1.0",)

        def detect(self, payload):  # pragma: no cover - not exercised here
            from app.import_source import NO_MATCH

            return NO_MATCH

        def parse(self, raw, *, source_label=None):  # pragma: no cover
            return raw

        def normalize(self, native_ast, *, include_raw=True):  # pragma: no cover
            raise NotImplementedError

    _REGISTRY["probe-format"] = _ProbeImportSource
    try:
        r = client.get("/v1/import/sources")
        by_key = {s["key"]: s for s in r.json()["sources"]}
        assert "probe-format" in by_key
        probe = by_key["probe-format"]
        assert probe["label"] == "Probe Format"
        assert probe["icon"] == "boxes"
        assert probe["input_kinds"] == ["file", "paste"]
    finally:
        _REGISTRY.pop("probe-format", None)


# ---------------------------------------------------------------------------
# file_extensions on the payload (FMT-1.1, #5412)
# ---------------------------------------------------------------------------


def test_source_list_publishes_file_extensions():
    """The pickers derive `accept` from this field, so it must be on the wire."""
    r = client.get("/v1/import/sources")
    by_key = {s["key"]: s for s in r.json()["sources"]}

    assert by_key["typespec"]["file_extensions"][0] == ".tsp"
    assert ".cpy" in by_key["cobolcopybook"]["file_extensions"]
    assert ".edi" in by_key["edix12"]["file_extensions"]
    assert ".hl7" in by_key["hl7v2"]["file_extensions"]
    # A fileset adapter's archive suffixes ride along, appended by the descriptor.
    assert ".zip" in by_key["openapi"]["file_extensions"]
    # Paste-only `sample` has no filename to accept, so it declares none.
    assert by_key["sample"]["file_extensions"] == []


def test_source_list_extensions_reach_far_past_the_old_hard_coded_ten():
    """Thirty-three formats were built and invisible; the payload now names them."""
    r = client.get("/v1/import/sources")
    union = {ext for s in r.json()["sources"] for ext in s["file_extensions"]}
    assert {".tsp", ".fbs", ".capnp", ".idl", ".x", ".wsdl", ".xsd", ".edmx"} <= union
    assert {".cpy", ".cbl", ".edi", ".hl7", ".asn1", ".wit", ".smithy"} <= union
    assert {".apib", ".http", ".rest"} <= union


def test_new_adapter_widens_the_published_accept_list():
    """Registering an adapter server-side widens every picker with no UI change."""

    class _ExoticImportSource(ImportSource):  # not auto-registered
        key = "probe-exotic"
        label = "Probe Exotic"
        description = "A throwaway adapter with an extension nothing else claims."
        icon = "boxes"
        paradigm = ApiParadigm.REST
        input_kinds = (InputKind.FILE,)
        formats = ("probe-exotic-1.0",)
        file_extensions = (".probeexotic",)

        def detect(self, payload):  # pragma: no cover - not exercised here
            from app.import_source import NO_MATCH

            return NO_MATCH

        def parse(self, raw, *, source_label=None):  # pragma: no cover
            return raw

        def normalize(self, native_ast, *, include_raw=True):  # pragma: no cover
            raise NotImplementedError

    def _published_extensions():
        payload = client.get("/v1/import/sources").json()
        return {ext for s in payload["sources"] for ext in s["file_extensions"]}

    assert ".probeexotic" not in _published_extensions()
    _REGISTRY["probe-exotic"] = _ExoticImportSource
    try:
        assert ".probeexotic" in _published_extensions()
    finally:
        _REGISTRY.pop("probe-exotic", None)
    assert ".probeexotic" not in _published_extensions()


# ---------------------------------------------------------------------------
# POST /v1/import/detect — format auto-detection (MFI-1.5)
# ---------------------------------------------------------------------------


def test_detect_format_routes_importable_raml():
    r = client.post(
        "/v1/import/detect",
        json={"text": "#%RAML 1.0\ntitle: Example\nbaseUri: https://api.example.com\n/books:\n  get:\n"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["matched"] is True
    assert body["detected"]["format"] == "raml"
    assert body["detected"]["importable"] is True
    assert body["detected"]["source_key"] == "raml"
    assert body["ambiguous"] is False


def test_detect_format_routes_importable_grpc():
    # MFI-9.6 registered the gRPC / Protobuf adapter: a .proto is recognized and importable.
    r = client.post(
        "/v1/import/detect",
        json={"text": 'syntax = "proto3";\npackage foo;\nmessage M { string id = 1; }\n'},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["detected"]["format"] == "protobuf"
    assert body["detected"]["importable"] is True
    assert body["detected"]["source_key"] == "grpc"
    assert body["ambiguous"] is False


def test_detect_format_routes_importable_graphql():
    # MFI-10.6 registered the GraphQL adapter: SDL is recognized and importable.
    r = client.post("/v1/import/detect", json={"text": "type Query {\n  hello: String\n}\n"})
    assert r.status_code == 200
    body = r.json()
    assert body["detected"]["format"] == "graphql"
    assert body["detected"]["importable"] is True
    assert body["detected"]["source_key"] == "graphql"
    assert body["ambiguous"] is False


def test_detect_format_routes_importable_openapi():
    r = client.post(
        "/v1/import/detect",
        json={"text": '{"openapi": "3.1.0", "info": {}, "paths": {}}'},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["detected"]["format"] == "openapi-3.1"
    assert body["detected"]["importable"] is True
    assert body["detected"]["source_key"] == "openapi"


def test_detect_format_flags_ambiguous_input():
    r = client.post("/v1/import/detect", json={"text": "namespace com.example.bare\n"})
    assert r.status_code == 200
    body = r.json()
    assert body["ambiguous"] is True
    formats = {c["format"] for c in body["ambiguous_candidates"]}
    assert formats == {"smithy", "typespec"}


def test_detect_format_rejects_traversal_in_archive() -> None:
    import base64
    import io
    import zipfile

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as archive:
        archive.writestr("../escape.proto", 'syntax = "proto3";\n')
    r = client.post(
        "/v1/import/detect",
        json={
            "document_base64": base64.standard_b64encode(buf.getvalue()).decode("ascii"),
            "filename": "bad.zip",
        },
    )
    assert r.status_code == 422


def test_detect_format_unpacks_proto_archive() -> None:
    import base64
    from pathlib import Path

    fixtures = Path(__file__).parent / "fixtures" / "proto"
    common = (fixtures / "common" / "types.proto").read_text(encoding="utf-8")
    user = (fixtures / "user" / "user_service.proto").read_text(encoding="utf-8")
    import io
    import zipfile

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as archive:
        archive.writestr("common/types.proto", common)
        archive.writestr("user/user_service.proto", user)
    r = client.post(
        "/v1/import/detect",
        json={
            "document_base64": base64.standard_b64encode(buf.getvalue()).decode("ascii"),
            "filename": "protos.zip",
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["matched"] is True
    assert body["archive_root"] == "user/user_service.proto"
    assert "common/types.proto" in body["archive_members"]


def test_detect_format_no_match():
    r = client.post("/v1/import/detect", json={"text": "no markers here"})
    assert r.status_code == 200
    body = r.json()
    assert body["matched"] is False
    assert body["detected"] is None
    assert body["candidates"] == []


def test_detect_format_requires_authentication():
    # As with /sources: unauthenticated is 401, never 422 — a 422 would signal a
    # required request param (leaked ``tenant_slug`` query) that breaks every real call.
    app.dependency_overrides.clear()
    r = client.post("/v1/import/detect", json={"text": "type Query { a: String }"})
    assert r.status_code == 401


def test_detect_format_has_no_required_query_or_path_params():
    # Only the JSON body + header credentials; no required query/path param (no leaked
    # tenant_slug). Regression guard for the /api/import/detect 422 class of bug.
    schema = app.openapi()
    params = schema["paths"]["/v1/import/detect"]["post"].get("parameters", [])
    required_non_header = [
        p["name"] for p in params if p.get("required") and p["in"] != "header"
    ]
    assert required_non_header == []
