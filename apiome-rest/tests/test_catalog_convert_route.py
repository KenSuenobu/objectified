"""Tests for the catalog → OpenAPI conversion endpoint — MFI-22.6 (#4007).

Pins the route contract for ``POST /v1/catalog/{tenant_slug}/{item_id}/convert`` — the single verb
behind the UI preview (MFI-22.4), the CLI, and the API:

* auth is required; a non-catalog id is 404; an unsupported target is 400;
* ``dryRun=true`` returns the fidelity report + the would-be OpenAPI document with **no side effects**
  (``run_conversion`` is never called), and the ``dryRun`` query param is authoritative over the body;
* ``dryRun=false`` runs the commit job and returns the created ids + report (the job itself is faked
  here — its own logic is covered in ``test_conversion_job.py``);
* an item with no captured source to reconstruct from surfaces the loader's 422.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.conversion_job import ConversionResult, LintScore
from app.fidelity import FidelityReport, FidelityTier
from app.main import app

client = TestClient(app)

_MOCK_AUTH = {"tenant_id": "test-tenant-id", "user_id": "test-user-id", "auth_method": "jwt"}


def _override_auth():
    return _MOCK_AUTH


# A catalog item whose captured GraphQL source reconstructs into a real canonical model.
_GRAPHQL_SDL = "type Query { ping: String }"
_CATALOG_ITEM = {
    "id": "cat-1",
    "tenant_id": "test-tenant-id",
    "name": "Ping API",
    "slug": "ping-api",
    "publishable": False,
    "source_format": "graphql",
    "protocol": None,
    "tool_versions": {"graphql-lib": "1.2"},
    "format_metadata": {"sourceContent": _GRAPHQL_SDL, "sourceLabel": "schema.graphql"},
}

# A catalog item with only format-provenance and no captured source text.
_CATALOG_ITEM_NO_SOURCE = {
    **_CATALOG_ITEM,
    "id": "cat-nosrc",
    "format_metadata": {"package": "acme.v1"},
}


def _fake_report() -> FidelityReport:
    return FidelityReport(
        score=74, grade="C", tier=FidelityTier.MEDIUM,
        items=[], losses=[], coverage_counts={}, penalty=26,
    )


# ---------------------------------------------------------------------------
# Auth + basic contract
# ---------------------------------------------------------------------------
def test_convert_requires_auth():
    """The convert endpoint requires authentication."""
    response = client.post("/v1/catalog/test-tenant/cat-1/convert")
    assert response.status_code == 401


def test_convert_404_when_not_catalog_item():
    """A publishable Project's id (or an unknown id) is not a catalog item → 404."""
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.catalog_routes.db") as mock_db:
            mock_db.get_catalog_item_by_id.return_value = None
            response = client.post("/v1/catalog/test-tenant/proj-x/convert")
        assert response.status_code == 404
        assert "not found" in response.json()["detail"].lower()
    finally:
        app.dependency_overrides.pop(validate_authentication, None)


def test_convert_unsupported_target_400():
    """Only 'openapi' is a supported target today; anything else is 400."""
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.catalog_routes.db") as mock_db:
            mock_db.get_catalog_item_by_id.return_value = _CATALOG_ITEM
            response = client.post(
                "/v1/catalog/test-tenant/cat-1/convert",
                json={"target": "graphql", "dryRun": True},
            )
        assert response.status_code == 400
        assert "target" in response.json()["detail"].lower()
    finally:
        app.dependency_overrides.pop(validate_authentication, None)


# ---------------------------------------------------------------------------
# Dry-run — report + document, no side effects
# ---------------------------------------------------------------------------
def test_convert_dry_run_returns_report_and_document():
    """dryRun=true returns the fidelity report + would-be OpenAPI doc and never commits."""
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.catalog_routes.db") as mock_db, patch(
            "app.catalog_routes.run_conversion", new_callable=AsyncMock
        ) as mock_run:
            mock_db.get_catalog_item_by_id.return_value = _CATALOG_ITEM
            mock_db.get_latest_revision_id_for_project.return_value = "rev-1"
            response = client.post(
                "/v1/catalog/test-tenant/cat-1/convert?dryRun=true",
                json={"target": "openapi", "dryRun": True},
            )
        assert response.status_code == 200
        body = response.json()
        assert body["target"] == "openapi"
        assert body["sourceFormat"] == "graphql"
        assert body["conversionMode"] == "lossy"
        assert body["report"]["grade"] in {"A", "B", "C", "D", "F"}
        assert body["openapi"]["openapi"].startswith("3.1")
        # No commit side effect.
        mock_run.assert_not_called()
    finally:
        app.dependency_overrides.pop(validate_authentication, None)


def test_convert_defaults_to_dry_run_with_empty_body():
    """With no body and no query flag, the endpoint defaults to a safe dry-run (never commits)."""
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.catalog_routes.db") as mock_db, patch(
            "app.catalog_routes.run_conversion", new_callable=AsyncMock
        ) as mock_run:
            mock_db.get_catalog_item_by_id.return_value = _CATALOG_ITEM
            mock_db.get_latest_revision_id_for_project.return_value = "rev-1"
            response = client.post("/v1/catalog/test-tenant/cat-1/convert")
        assert response.status_code == 200
        assert "report" in response.json()
        mock_run.assert_not_called()
    finally:
        app.dependency_overrides.pop(validate_authentication, None)


def test_convert_query_param_overrides_body_dry_run():
    """The dryRun query param is authoritative: ?dryRun=false commits even if the body says true."""
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.catalog_routes.db") as mock_db, patch(
            "app.catalog_routes.run_conversion", new_callable=AsyncMock
        ) as mock_run:
            mock_db.get_catalog_item_by_id.return_value = _CATALOG_ITEM
            mock_db.get_latest_revision_id_for_project.return_value = "rev-1"
            mock_run.return_value = ConversionResult(
                project_id="proj-9", project_slug="ping-api-openapi", version_id="1.0.0",
                version_record_id="ver-9", created_project=True, reconverted=False,
                fidelity=_fake_report(), lint=LintScore(score=90, grade="A"),
                provenance_id="prov-9", document={"openapi": "3.1.0"},
            )
            response = client.post(
                "/v1/catalog/test-tenant/cat-1/convert?dryRun=false",
                json={"target": "openapi", "dryRun": True},
            )
        assert response.status_code == 200
        mock_run.assert_awaited_once()
        body = response.json()
        assert body["projectId"] == "proj-9"
        assert body["versionId"] == "1.0.0"
        assert body["conversionMode"] == "lossy"
        assert body["versionRecordId"] == "ver-9"
        assert body["createdProject"] is True
        assert body["provenanceId"] == "prov-9"
        assert body["report"]["grade"] == "C"
    finally:
        app.dependency_overrides.pop(validate_authentication, None)


def test_convert_forwards_defaults_to_the_job():
    """User-supplied defaults flow into run_conversion so they land in the committed spec."""
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.catalog_routes.db") as mock_db, patch(
            "app.catalog_routes.run_conversion", new_callable=AsyncMock
        ) as mock_run:
            mock_db.get_catalog_item_by_id.return_value = _CATALOG_ITEM
            mock_db.get_latest_revision_id_for_project.return_value = "rev-1"
            mock_run.return_value = ConversionResult(
                project_id="p", project_slug="s", version_id="1.0.0", version_record_id="v",
                created_project=True, reconverted=False, fidelity=_fake_report(),
                lint=None, provenance_id="pr", document={"openapi": "3.1.0"},
            )
            client.post(
                "/v1/catalog/test-tenant/cat-1/convert?dryRun=false",
                json={
                    "target": "openapi",
                    "defaults": {"title": "My API", "version": "2.0.0", "servers": ["https://x"]},
                },
            )
        _, kwargs = mock_run.call_args
        defaults = kwargs["defaults"]
        assert defaults.title == "My API"
        assert defaults.version == "2.0.0"
        assert defaults.servers == ["https://x"]
    finally:
        app.dependency_overrides.pop(validate_authentication, None)


def test_convert_422_when_no_captured_source():
    """An item with no captured source to reconstruct from surfaces the loader's 422."""
    app.dependency_overrides[validate_authentication] = _override_auth
    try:
        with patch("app.catalog_routes.db") as mock_db:
            mock_db.get_catalog_item_by_id.return_value = _CATALOG_ITEM_NO_SOURCE
            mock_db.get_latest_revision_id_for_project.return_value = "rev-1"
            response = client.post("/v1/catalog/test-tenant/cat-nosrc/convert?dryRun=true")
        assert response.status_code == 422
        assert "source" in response.json()["detail"].lower()
    finally:
        app.dependency_overrides.pop(validate_authentication, None)
