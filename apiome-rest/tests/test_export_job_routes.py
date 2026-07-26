"""Contract tests for the async export job REST surface — MFX-3.1 (#3844).

Pins the route contract, mirroring the spec-import contract tests
(``test_spec_import_contract.py``) so the two job surfaces stay symmetric:

* all routes require authentication and are tenant-scoped;
* ``POST …/jobs`` answers 202 with ``{job_id, status_path}`` and the job then runs to a
  terminal state observable through ``GET …/jobs/{job_id}`` — the import-shaped
  ``{job_id, state, percent, events, progress, result}`` poll payload, plus the MFX-3.4
  terminal contract: a completed export exposes ``result.download_path``, a failed one a
  structured ``error``;
* an unknown target is rejected at submit time (400), invalid emit options 422 —
  matching the synchronous ``/export/document`` behaviour;
* ``dry_run`` completes with the fidelity envelope and no files;
* ``DELETE …/jobs/{job_id}`` requests cancellation (204) and 404s for unknown jobs;
* the job paths are present in the OpenAPI document.

The DB-backed source loader is faked (covered in ``test_export_source.py``); the emitter
runs the real registry/SPI so an emitter genuinely runs end-to-end through the job API.
"""

from __future__ import annotations

import time
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.canonical_model import (
    ApiIdentity,
    ApiParadigm,
    CanonicalApi,
    CanonicalField,
    Operation,
    OperationKind,
    Service,
    Type,
    TypeKind,
    TypeRef,
)
from app.export_source import ExportSource, ExportSourceError
from app.main import app

client = TestClient(app)

_MOCK_AUTH = {
    "tenant_id": "550e8400-e29b-41d4-a716-446655440000",
    "tenant_slug": "acme",
    "user_id": "660e8400-e29b-41d4-a716-446655440001",
    "auth_method": "jwt",
}


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
def _clear_export_jobs_between_tests():
    from app import export_job_engine as eje

    eje._jobs.clear()
    yield
    eje._jobs.clear()


def _source() -> ExportSource:
    """A loaded source: a REST API with one operation + one type, at a fixed revision."""
    widget = Type(
        key="Widget",
        name="Widget",
        kind=TypeKind.RECORD,
        fields=[CanonicalField(key="Widget.id", name="id", type=TypeRef(name="string"))],
    )
    op = Operation(key="GET /widgets", name="listWidgets", kind=OperationKind.QUERY)
    service = Service(key="widgets", name="widgets", operations=[op])
    api = CanonicalApi(
        paradigm=ApiParadigm.REST,
        format="openapi-3.1",
        identity=ApiIdentity(name="widgets"),
        services=[service],
        types=[widget],
    )
    return ExportSource(
        api=api,
        artifact_id="artifact-1",
        version_record_id="rev-uuid-1",
        version_label="1.0.0",
    )


def _wait_terminal(job_id: str, tenant: str = "acme") -> dict:
    """Poll GET …/jobs/{job_id} until the job reaches a terminal state."""
    for _ in range(500):
        r = client.get(f"/v1/export/{tenant}/jobs/{job_id}")
        assert r.status_code == 200, r.text
        body = r.json()
        if body["state"] in ("completed", "failed", "canceled"):
            return body
        time.sleep(0.01)
    raise AssertionError("export job did not reach a terminal state")


# ---------------------------------------------------------------------------
# OpenAPI + auth
# ---------------------------------------------------------------------------
def test_openapi_lists_export_job_paths_and_operations():
    spec = app.openapi()
    paths = spec["paths"]
    base = "/v1/export/{tenant_slug}/jobs"
    job = f"{base}/{{job_id}}"
    assert base in paths
    assert "get" in paths[base]
    assert "post" in paths[base]
    assert job in paths
    assert "get" in paths[job]
    assert "delete" in paths[job]


def test_routes_require_auth():
    app.dependency_overrides.pop(validate_authentication, None)
    assert client.get("/v1/export/acme/jobs").status_code == 401
    assert (
        client.post(
            "/v1/export/acme/jobs", json={"artifact": "a", "target": "openapi"}
        ).status_code
        == 401
    )
    assert client.get("/v1/export/acme/jobs/nope").status_code == 401
    assert client.delete("/v1/export/acme/jobs/nope").status_code == 401


# ---------------------------------------------------------------------------
# Submit + poll (the acceptance criterion: an emitter end-to-end via the job API)
# ---------------------------------------------------------------------------
def test_submit_and_poll_full_export_job():
    """202-accept, then poll to completed: fidelity + file manifest, import-shaped status."""
    with patch("app.export_job_engine.load_export_source", return_value=_source()):
        r = client.post(
            "/v1/export/acme/jobs",
            json={"artifact": "artifact-1", "version": "1.0.0", "target": "openapi"},
        )
        assert r.status_code == 202, r.text
        accepted = r.json()
        assert accepted["status_path"] == f"/v1/export/acme/jobs/{accepted['job_id']}"

        body = _wait_terminal(accepted["job_id"])

    # The poll payload carries the same field vocabulary as an import job status,
    # plus the MFX-3.4 structured ``error`` slot (null here — the job succeeded).
    assert set(body) >= {"job_id", "state", "percent", "events", "progress", "result", "error"}
    assert body["state"] == "completed"
    assert body["percent"] == 100
    assert body["error"] is None

    result = body["result"]
    assert result["artifact"] == "artifact-1"
    assert result["version_record_id"] == "rev-uuid-1"
    assert result["dry_run"] is False
    assert len(result["files"]) == 1
    assert result["files"][0]["path"]
    assert result["files"][0]["size_bytes"] > 0
    assert result["fidelity"]["summary"]["tier"] == "lossless"
    assert result["fidelity"]["summary"]["total"] > 0
    assert result["fidelity"]["advisory"] is not None
    # MFX-3.4: a terminal completed export hands the poller a download ref.
    assert result["download_path"] == f"/v1/export/acme/jobs/{accepted['job_id']}/download"

    codes = [e["code"] for e in body["events"]]
    assert codes[0] == "EXPORT_STARTED"
    assert codes[-1] == "EXPORT_COMPLETED"


def test_dry_run_job_returns_report_without_artifact():
    """dry_run=true completes with the fidelity envelope and an empty file manifest."""
    with patch("app.export_job_engine.load_export_source", return_value=_source()):
        r = client.post(
            "/v1/export/acme/jobs",
            json={"artifact": "artifact-1", "target": "openapi", "dry_run": True},
        )
        assert r.status_code == 202, r.text
        body = _wait_terminal(r.json()["job_id"])

    assert body["state"] == "completed"
    result = body["result"]
    assert result["dry_run"] is True
    assert result["files"] == []
    assert result["media_type"] is None
    assert result["download_path"] is None  # MFX-3.4: no artifact ⇒ no download ref
    assert result["fidelity"]["summary"]["preserved_percent"] == 100


def test_source_failure_surfaces_in_job_status_not_submit():
    """An unknown artifact accepts (202) and then fails asynchronously, like imports."""
    with patch(
        "app.export_job_engine.load_export_source",
        side_effect=ExportSourceError("Artifact 'missing' was not found.", status_code=404),
    ):
        r = client.post(
            "/v1/export/acme/jobs", json={"artifact": "missing", "target": "openapi"}
        )
        assert r.status_code == 202, r.text
        body = _wait_terminal(r.json()["job_id"])

    assert body["state"] == "failed"
    assert body["result"] is None
    errors = [e for e in body["events"] if e["level"] == "error"]
    assert errors and errors[0]["code"] == "SOURCE_LOAD_FAILED"
    # MFX-3.4: the terminal failure is also a structured error on the poll payload.
    assert body["error"]["code"] == "SOURCE_LOAD_FAILED"
    assert body["error"]["context"] == {"status_code": 404}


# ---------------------------------------------------------------------------
# Submit-time validation (fail fast, matching /export/document semantics)
# ---------------------------------------------------------------------------
def test_unknown_target_is_rejected_at_submit():
    r = client.post(
        "/v1/export/acme/jobs", json={"artifact": "artifact-1", "target": "not-a-format"}
    )
    assert r.status_code == 400
    assert "Unsupported export target" in r.json()["detail"]


def test_invalid_options_are_rejected_at_submit():
    r = client.post(
        "/v1/export/acme/jobs",
        json={
            "artifact": "artifact-1",
            "target": "openapi",
            "options": {"no_such_option": True},
        },
    )
    assert r.status_code == 422


def test_unknown_body_fields_are_rejected():
    r = client.post(
        "/v1/export/acme/jobs",
        json={"artifact": "artifact-1", "target": "openapi", "bogus": 1},
    )
    assert r.status_code == 422


# ---------------------------------------------------------------------------
# List / cancel / tenant scoping
# ---------------------------------------------------------------------------
def test_list_returns_summary_rows():
    with patch("app.export_job_engine.load_export_source", return_value=_source()):
        r = client.post(
            "/v1/export/acme/jobs",
            json={"artifact": "artifact-1", "target": "openapi", "dry_run": True},
        )
        job_id = r.json()["job_id"]
        _wait_terminal(job_id)

        listing = client.get("/v1/export/acme/jobs")
    assert listing.status_code == 200
    jobs = listing.json()["jobs"]
    assert [j["job_id"] for j in jobs] == [job_id]
    assert jobs[0]["artifact"] == "artifact-1"
    assert jobs[0]["target"] == "openapi"
    assert jobs[0]["dry_run"] is True
    assert jobs[0]["status_path"] == f"/v1/export/acme/jobs/{job_id}"
    # Summary rows never carry the event log or the fidelity envelope.
    assert "events" not in jobs[0]
    assert "result" not in jobs[0]


def test_job_is_tenant_scoped():
    """Another tenant's slug cannot see, poll, or cancel the job."""
    with patch("app.export_job_engine.load_export_source", return_value=_source()):
        r = client.post(
            "/v1/export/acme/jobs", json={"artifact": "artifact-1", "target": "openapi"}
        )
        job_id = r.json()["job_id"]
        _wait_terminal(job_id)

    assert client.get(f"/v1/export/other/jobs/{job_id}").status_code == 404
    assert client.delete(f"/v1/export/other/jobs/{job_id}").status_code == 404
    assert client.get("/v1/export/other/jobs").json()["jobs"] == []


def test_cancel_unknown_job_404s():
    assert client.delete("/v1/export/acme/jobs/does-not-exist").status_code == 404


def test_cancel_terminal_job_is_a_204_noop():
    with patch("app.export_job_engine.load_export_source", return_value=_source()):
        r = client.post(
            "/v1/export/acme/jobs",
            json={"artifact": "artifact-1", "target": "openapi", "dry_run": True},
        )
        job_id = r.json()["job_id"]
        _wait_terminal(job_id)

    assert client.delete(f"/v1/export/acme/jobs/{job_id}").status_code == 204
    assert client.get(f"/v1/export/acme/jobs/{job_id}").json()["state"] == "completed"


def test_unknown_job_status_404s():
    assert client.get("/v1/export/acme/jobs/does-not-exist").status_code == 404


# ---------------------------------------------------------------------------
# Artifact download — MFX-4.1 single file (#3848) / MFX-4.2 zip bundle (#3849)
# ---------------------------------------------------------------------------
def test_openapi_lists_the_download_path():
    spec = app.openapi()
    download = "/v1/export/{tenant_slug}/jobs/{job_id}/download"
    assert download in spec["paths"]
    assert "get" in spec["paths"][download]


def test_download_requires_auth():
    app.dependency_overrides.pop(validate_authentication, None)
    assert client.get("/v1/export/acme/jobs/nope/download").status_code == 401


def test_download_serves_the_completed_artifact_with_filename_and_type():
    """A completed job's download_path serves the emitted document with a filename header."""
    with patch("app.export_job_engine.load_export_source", return_value=_source()):
        r = client.post(
            "/v1/export/acme/jobs",
            json={"artifact": "artifact-1", "target": "openapi"},
        )
        assert r.status_code == 202, r.text
        job_id = r.json()["job_id"]
        body = _wait_terminal(job_id)

    download_path = body["result"]["download_path"]
    assert download_path == f"/v1/export/acme/jobs/{job_id}/download"

    dl = client.get(download_path)
    assert dl.status_code == 200, dl.text
    # A Content-Disposition attachment with the emitter's filename.
    disposition = dl.headers["content-disposition"]
    assert disposition.startswith("attachment; filename=")
    filename = body["result"]["files"][0]["path"].rsplit("/", 1)[-1]
    assert filename in disposition
    # The content type is the emitted file's media type (OpenAPI JSON here).
    assert dl.headers["content-type"].startswith("application/")
    # The served body length matches the size the manifest reported.
    assert len(dl.content) == body["result"]["files"][0]["size_bytes"]
    # It is the emitted document — parseable JSON with the OpenAPI marker.
    assert dl.json()["openapi"].startswith("3.")
    # IXH-6.1 integrity headers: Digest + hex SHA-256 of the exact body bytes.
    assert "digest" in {k.lower() for k in dl.headers.keys()}
    assert len(dl.headers["x-content-sha256"]) == 64
    import hashlib

    assert dl.headers["x-content-sha256"] == hashlib.sha256(dl.content).hexdigest()


def test_download_from_non_owning_instance_via_shared_store():
    """After clearing the in-memory owner record, the route still serves via shared store."""
    from app import export_job_engine as eje

    with patch("app.export_job_engine.load_export_source", return_value=_source()):
        r = client.post(
            "/v1/export/acme/jobs",
            json={"artifact": "artifact-1", "target": "openapi"},
        )
        assert r.status_code == 202, r.text
        job_id = r.json()["job_id"]
        body = _wait_terminal(job_id)

    download_path = body["result"]["download_path"]
    eje._jobs.clear()
    dl = client.get(download_path)
    assert dl.status_code == 200, dl.text
    assert dl.json()["openapi"].startswith("3.")
    assert len(dl.headers["x-content-sha256"]) == 64


def test_download_serves_a_zip_bundle_for_a_multi_file_export():
    """A multi-file export's download_path serves an application/zip bundle (MFX-4.2)."""
    import io
    import zipfile

    from app.emitter import EmitResult, EmittedFile
    from app.export_validation import EmittedArtifactValidation

    def _multi(*args, **kwargs):
        return EmitResult(
            files=[
                EmittedFile(path="widgets.proto", content='syntax = "proto3";\n',
                            media_type="text/plain"),
                EmittedFile(path="pkg/common.proto", content='syntax = "proto3";\nmessage C {}\n',
                            media_type="text/plain"),
            ],
            media_type="text/plain",
        )

    # The crafted proto files are not a valid ``openapi`` artifact; this test isolates the
    # multi-file zip delivery path, so stub the MFX-5.1 validation as passing.
    async def _passing_validation(*args, **kwargs):
        return EmittedArtifactValidation(
            target="openapi-3.1", applicable=True, validated=True, valid=True
        )

    with patch("app.export_job_engine.load_export_source", return_value=_source()), patch(
        "app.export_job_engine.emit_canonical", side_effect=_multi
    ), patch("app.export_job_engine.validate_emitted_artifact", _passing_validation):
        r = client.post(
            "/v1/export/acme/jobs", json={"artifact": "artifact-1", "target": "openapi"}
        )
        assert r.status_code == 202, r.text
        job_id = r.json()["job_id"]
        body = _wait_terminal(job_id)

    # The poll payload advertised two files and a download ref — the delivery route now honours it.
    assert len(body["result"]["files"]) == 2
    download_path = body["result"]["download_path"]
    dl = client.get(download_path)
    assert dl.status_code == 200, dl.text
    assert dl.headers["content-type"] == "application/zip"
    disposition = dl.headers["content-disposition"]
    assert disposition.startswith("attachment; filename=")
    assert ".zip" in disposition

    # The response body is a genuine zip carrying both files and the manifest.
    with zipfile.ZipFile(io.BytesIO(dl.content)) as archive:
        assert set(archive.namelist()) == {"widgets.proto", "pkg/common.proto", "manifest.json"}
        manifest = archive.read("manifest.json").decode("utf-8")
    assert '"file_count": 2' in manifest


def test_download_of_dry_run_job_is_409():
    with patch("app.export_job_engine.load_export_source", return_value=_source()):
        r = client.post(
            "/v1/export/acme/jobs",
            json={"artifact": "artifact-1", "target": "openapi", "dry_run": True},
        )
        job_id = r.json()["job_id"]
        _wait_terminal(job_id)

    dl = client.get(f"/v1/export/acme/jobs/{job_id}/download")
    assert dl.status_code == 409
    assert "dry-run" in dl.json()["detail"]


def test_download_of_unknown_job_is_404():
    assert client.get("/v1/export/acme/jobs/does-not-exist/download").status_code == 404


def test_download_is_tenant_scoped():
    with patch("app.export_job_engine.load_export_source", return_value=_source()):
        r = client.post(
            "/v1/export/acme/jobs", json={"artifact": "artifact-1", "target": "openapi"}
        )
        job_id = r.json()["job_id"]
        _wait_terminal(job_id)

    assert client.get(f"/v1/export/other/jobs/{job_id}/download").status_code == 404


# ---------------------------------------------------------------------------
# Streaming download & temp artifact retention — MFX-4.3 (#3850)
# ---------------------------------------------------------------------------
def test_download_streams_with_a_content_length_header():
    """The download advertises Content-Length and streams a body of exactly that size."""
    with patch("app.export_job_engine.load_export_source", return_value=_source()):
        r = client.post(
            "/v1/export/acme/jobs", json={"artifact": "artifact-1", "target": "openapi"}
        )
        job_id = r.json()["job_id"]
        body = _wait_terminal(job_id)

    dl = client.get(f"/v1/export/acme/jobs/{job_id}/download")
    assert dl.status_code == 200, dl.text
    size = body["result"]["files"][0]["size_bytes"]
    # Content-Length is present, matches the manifest size, and matches the delivered body.
    assert dl.headers["content-length"] == str(size)
    assert len(dl.content) == size
    assert dl.json()["openapi"].startswith("3.")


def test_download_of_expired_artifact_is_410():
    """Once the retention window elapses the route answers 410 Gone (MFX-4.3)."""
    from app import export_job_engine as eje

    with patch("app.export_job_engine.load_export_source", return_value=_source()):
        r = client.post(
            "/v1/export/acme/jobs", json={"artifact": "artifact-1", "target": "openapi"}
        )
        job_id = r.json()["job_id"]
        _wait_terminal(job_id)

    # Force the deadline into the past, then the download is 410 with a resubmit hint.
    eje._jobs[job_id].artifact_expires_at_ms = int(time.time() * 1000) - 1
    dl = client.get(f"/v1/export/acme/jobs/{job_id}/download")
    assert dl.status_code == 410
    assert "expired" in dl.json()["detail"]
