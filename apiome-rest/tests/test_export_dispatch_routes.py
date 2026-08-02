"""Tests for the synchronous dispatch route — ``POST /v1/export/{tenant_slug}/dispatch`` — MFX-3.2 (#3845).

Pins the route contract:

* the endpoint requires authentication and is tenant-scoped;
* a real dispatch returns the emitted document **inline** alongside the full fidelity envelope
  (report + advisory + summary) and the resolved revision coordinates;
* ``dry_run: true`` returns the report with no files (the ``/preview`` shape);
* the loader's not-found (404) and no-source (422) errors, an unknown target (400), and invalid
  emit options (422) map to the right HTTP status.

The source loader is faked (its own DB-backed logic is exercised in ``test_export_source.py``),
so these tests pin only the route wiring; the emitter path runs the real registry/SPI. The route
loads the source itself (rather than through ``dispatch_export``) since IXH-2.5, so that it can
run the delivery gate before any emit — hence the loader is patched on ``app.export_routes``.
"""

from __future__ import annotations

from unittest.mock import patch

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

_MOCK_AUTH = {"tenant_id": "test-tenant-id", "user_id": "test-user-id", "auth_method": "jwt"}


def _override_auth():
    return _MOCK_AUTH


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


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------
def test_dispatch_requires_auth():
    response = client.post(
        "/v1/export/test-tenant/dispatch",
        json={"artifact": "artifact-1", "target": "openapi"},
    )
    assert response.status_code == 401


# ---------------------------------------------------------------------------
# POST /export/{tenant}/dispatch
# ---------------------------------------------------------------------------
def test_dispatch_returns_document_and_fidelity_together():
    """A real dispatch returns the emitted document inline plus the full fidelity envelope."""
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.export_routes.load_export_source", return_value=_source()):
            response = client.post(
                "/v1/export/test-tenant/dispatch",
                json={"artifact": "artifact-1", "version": "1.0.0", "target": "openapi"},
            )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    body = response.json()
    assert body["artifact"] == "artifact-1"
    assert body["version"] == "1.0.0"
    assert body["version_record_id"] == "rev-uuid-1"
    assert body["version_label"] == "1.0.0"
    assert body["target"].startswith("openapi")
    assert body["dry_run"] is False

    # The emitted document is inline.
    assert len(body["files"]) == 1
    assert body["files"][0]["content"]["openapi"].startswith("3.")
    assert body["media_type"] == "application/vnd.oai.openapi+json"

    # The fidelity envelope rides along: lossless REST → OpenAPI.
    assert body["fidelity"]["summary"]["tier"] == "lossless"
    assert body["fidelity"]["summary"]["preserved_percent"] == 100
    assert body["fidelity"]["advisory"] is not None


def test_dispatch_dry_run_returns_report_without_artifact():
    """``dry_run`` returns the fidelity report and no files (the /preview shape)."""
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.export_routes.load_export_source", return_value=_source()):
            response = client.post(
                "/v1/export/test-tenant/dispatch",
                json={"artifact": "artifact-1", "target": "openapi", "dry_run": True},
            )
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 200
    body = response.json()
    assert body["dry_run"] is True
    assert body["files"] == []
    assert body["media_type"] is None
    assert body["fidelity"]["summary"]["tier"] == "lossless"


def test_dispatch_404_when_source_not_found():
    """The loader's 404 (unknown artifact/version) surfaces as an HTTP 404."""
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch(
            "app.export_routes.load_export_source",
            side_effect=ExportSourceError("Artifact 'nope' was not found.", status_code=404),
        ):
            response = client.post(
                "/v1/export/test-tenant/dispatch",
                json={"artifact": "nope", "target": "openapi"},
            )
    finally:
        app.dependency_overrides.clear()
    assert response.status_code == 404
    assert "not found" in response.json()["detail"].lower()


def test_dispatch_422_when_source_has_no_reconstructable_model():
    """The loader's 422 (no captured source) surfaces as an HTTP 422."""
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch(
            "app.export_routes.load_export_source",
            side_effect=ExportSourceError("no captured source", status_code=422),
        ):
            response = client.post(
                "/v1/export/test-tenant/dispatch",
                json={"artifact": "artifact-1", "target": "openapi"},
            )
    finally:
        app.dependency_overrides.clear()
    assert response.status_code == 422


def test_dispatch_400_when_target_unknown():
    """An unknown target maps to a 400."""
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.export_routes.load_export_source", return_value=_source()):
            response = client.post(
                "/v1/export/test-tenant/dispatch",
                json={"artifact": "artifact-1", "target": "does-not-exist"},
            )
    finally:
        app.dependency_overrides.clear()
    assert response.status_code == 400


def test_dispatch_422_when_options_invalid():
    """Invalid per-target emit options map to a 422."""
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.export_routes.load_export_source", return_value=_source()):
            response = client.post(
                "/v1/export/test-tenant/dispatch",
                json={
                    "artifact": "artifact-1",
                    "target": "openapi",
                    "options": {"include_paths": "not-a-bool"},
                },
            )
    finally:
        app.dependency_overrides.clear()
    assert response.status_code == 422
