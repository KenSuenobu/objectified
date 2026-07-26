"""Unit tests for the http-file ImportSource (IXH-7.4 / #5129)."""

from __future__ import annotations

import pytest

from app.fileset import IntakeFileset
from app.http_file_import_source import HttpFileImportSource
from app.http_file_parser import parse_http_file, parse_http_fileset
from app.import_preview_manifest import CoverageClass, build_import_preview_manifest, paginate_import_preview_manifest
from app.import_source import DetectionInput, ImportSourceError


@pytest.fixture
def adapter() -> HttpFileImportSource:
    return HttpFileImportSource()


MINIMAL = """\
GET https://api.example.com/ping
"""

TYPICAL = """\
@host = https://api.example.com
@token = secret-token

### List users
# @name listUsers
GET {{host}}/users?limit=10
Authorization: Bearer {{token}}
Accept: application/json

###
POST {{host}}/users
Content-Type: application/json

{
  "name": "Ada",
  "email": "ada@example.com"
}
"""

COMPOSITION = """\
GET https://api.example.com/users/1

###
GET https://api.example.com/users/2

###
GET https://api.example.com/users/42
"""

CURL = """\
curl -X POST 'https://api.example.com/pets' \\
  -H 'Content-Type: application/json' \\
  -H 'Authorization: Bearer tok_abc' \\
  -d '{"name":"fido"}'
"""


def test_detect_claims_http_extension(adapter: HttpFileImportSource) -> None:
    result = adapter.detect(DetectionInput(text=MINIMAL, filename="api.http"))
    assert result.confidence >= 0.9
    assert result.format == "http-file"


def test_detect_claims_curl_paste(adapter: HttpFileImportSource) -> None:
    result = adapter.detect(DetectionInput(text=CURL))
    assert result.confidence >= 0.9
    assert result.format == "http-file"


def test_detect_declines_openapi(adapter: HttpFileImportSource) -> None:
    openapi = '{"openapi":"3.0.3","info":{"title":"x","version":"1"},"paths":{}}'
    result = adapter.detect(DetectionInput(text=openapi, filename="spec.json"))
    assert result.confidence == 0.0


def test_parse_normalize_minimal(adapter: HttpFileImportSource) -> None:
    document = adapter.parse(MINIMAL, source_label="minimal.http")
    model = adapter.normalize(document)
    assert model.format == "http-file"
    assert model.extras["provenance"] == "inferred"
    ops = model.services[0].operations
    assert len(ops) == 1
    assert ops[0].http_method == "GET"
    assert ops[0].http_path == "/ping"
    assert ops[0].extras["provenance"] == "inferred"


def test_path_templating_recorded_in_ledger(adapter: HttpFileImportSource) -> None:
    document = adapter.parse(COMPOSITION, source_label="users.http")
    model = adapter.normalize(document)
    op = model.services[0].operations[0]
    assert op.http_path == "/users/{id}"
    assert op.extras["sample_count"] == 3
    page = paginate_import_preview_manifest(
        build_import_preview_manifest(model, adapter_key="http-file", options={})
    )
    assert any(e.coverage is CoverageClass.INFERRED for e in page.entities)
    path_rows = [r for r in page.coverage if r.source_construct.startswith("path-template#")]
    assert path_rows
    assert all(r.coverage is CoverageClass.INFERRED for r in path_rows)


def test_variables_and_auth_inferred(adapter: HttpFileImportSource) -> None:
    model = adapter.normalize(adapter.parse(TYPICAL, source_label="typical.http"))
    assert "bearer" in model.extras.get("inferred_auth_schemes", [])
    paths = {op.http_path for op in model.services[0].operations}
    assert "/users" in paths


def test_curl_parse(adapter: HttpFileImportSource) -> None:
    model = adapter.normalize(adapter.parse(CURL, source_label="curl"))
    op = model.services[0].operations[0]
    assert op.http_method == "POST"
    assert op.http_path == "/pets"
    assert any(m.role.value == "request" for m in op.messages)


def test_parse_rejects_openapi_wrong_format(adapter: HttpFileImportSource) -> None:
    openapi = '{"openapi":"3.0.3","info":{"title":"x","version":"1"},"paths":{}}'
    with pytest.raises(ImportSourceError) as exc_info:
        adapter.parse(openapi)
    assert exc_info.value.code == "FORMAT_MISMATCH"


def test_parse_rejects_empty(adapter: HttpFileImportSource) -> None:
    with pytest.raises(ImportSourceError) as exc_info:
        adapter.parse("   \n")
    assert exc_info.value.code == "INPUT_MALFORMED"


def test_parse_rejects_truncated(adapter: HttpFileImportSource) -> None:
    with pytest.raises(ImportSourceError) as exc_info:
        adapter.parse("POST https://api.example.com/x\nContent-Type: application/json\n\n{")
    assert exc_info.value.code == "INPUT_TRUNCATED"


def test_multi_file_merge_with_per_file_provenance(adapter: HttpFileImportSource) -> None:
    fileset = IntakeFileset(
        root="a.http",
        members={
            "a.http": "GET https://api.example.com/ping\n",
            "b.http": "GET https://api.example.com/health\n",
            "http-client.env.json": '{"dev": {"host": "https://api.example.com"}}',
        },
    )
    document = adapter.parse_fileset(fileset)
    model = adapter.normalize(document)
    by_path = {op.http_path: op for op in model.services[0].operations}
    assert by_path["/ping"].extras["source_files"] == ["a.http"]
    assert by_path["/health"].extras["source_files"] == ["b.http"]


def test_env_substitution_in_fileset() -> None:
    document = parse_http_fileset(
        {
            ".env": "host=https://api.example.com\n",
            "api.http": "GET {{host}}/v1/status\n",
        },
        root="api.http",
    )
    assert document.observations[0].url == "https://api.example.com/v1/status"


def test_unresolved_variables_stay_literal() -> None:
    document = parse_http_file("GET {{missing}}/x\n")
    assert "{{missing}}" in document.observations[0].url
