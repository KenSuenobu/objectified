"""Tests for GET /v1/tenants/{slug}/repository-imports/{id}/spec (RAR-1.5).

Covers the by-id lookup, the ``?path=`` lookup variant, tenant-scoped 404s, and
the upgrade-on-read of a legacy (unversioned) options blob.
"""

from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.main import app
from app.models import REPOSITORY_IMPORT_SPEC_SCHEMA_VERSION

client = TestClient(app)

_TENANT_ID = "550e8400-e29b-41d4-a716-446655440000"
_USER_ID = "660e8400-e29b-41d4-a716-446655440001"
_SPEC_ID = "990e8400-e29b-41d4-a716-446655440009"
_REPO_ID = "880e8400-e29b-41d4-a716-446655440003"
_PROJECT_ID = "770e8400-e29b-41d4-a716-446655440002"

_API_KEY_AUTH = {
    "tenant_id": _TENANT_ID,
    "tenant_slug": "acme",
    "auth_method": "api_key",
}


def _spec_row(**overrides):
    """A stored ``apiome.repository_import_spec`` row with current-shape options."""
    row = {
        "id": _SPEC_ID,
        "tenant_id": _TENANT_ID,
        "repository_id": _REPO_ID,
        "branch": "main",
        "path": "openapi/petstore.yaml",
        "project_id": _PROJECT_ID,
        "source_kind": "openapi-3",
        "format_override": "swagger",
        "content_type": "application/yaml",
        "options_json": {
            "apply_naming_convention": True,
            "class_naming_convention": "PascalCase",
            "skip_duplicate_versions": True,
        },
        "spec_schema_version": REPOSITORY_IMPORT_SPEC_SCHEMA_VERSION,
        "created_by": _USER_ID,
        "last_imported_commit_sha": "tipcommitsha1234",
        "last_imported_committed_at": "2026-06-20T10:00:00Z",
        "last_imported_blob_sha": "blobsha5678",
        "backfilled": False,
        "created_at": None,
        "updated_at": None,
    }
    row.update(overrides)
    return row


@pytest.fixture(autouse=True)
def _auth_api_key():
    app.dependency_overrides[validate_authentication] = lambda: _API_KEY_AUTH
    yield
    app.dependency_overrides.pop(validate_authentication, None)


def test_read_spec_by_id_ok():
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.get_repository_import_spec_by_id.return_value = _spec_row()
        r = client.get(f"/v1/tenants/acme/repository-imports/{_SPEC_ID}/spec")
    assert r.status_code == 200
    body = r.json()
    assert body["spec_schema_version"] == REPOSITORY_IMPORT_SPEC_SCHEMA_VERSION
    assert body["source_kind"] == "openapi-3"
    assert body["format_override"] == "swagger"
    assert body["content_type"] == "application/yaml"
    assert body["options"]["apply_naming_convention"] is True
    assert body["options"]["class_naming_convention"] == "PascalCase"
    assert body["options"]["skip_duplicate_versions"] is True
    # Freshness signals captured at import are exposed via RAR-1.5 (RAR-2.1, #3518).
    assert body["last_imported_commit_sha"] == "tipcommitsha1234"
    assert body["last_imported_committed_at"] == "2026-06-20T10:00:00Z"
    assert body["last_imported_blob_sha"] == "blobsha5678"
    # Tenant scope comes from the auth token, not the path slug.
    mdb.get_repository_import_spec_by_id.assert_called_once_with(_TENANT_ID, _SPEC_ID)
    mdb.get_repository_import_spec_by_path.assert_not_called()


def test_read_spec_by_id_not_found_returns_404():
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.get_repository_import_spec_by_id.return_value = None
        r = client.get(f"/v1/tenants/acme/repository-imports/{_SPEC_ID}/spec")
    assert r.status_code == 404
    assert r.json()["detail"] == "import spec not found"


def test_read_spec_by_path_with_branch_ok():
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.get_repository_import_spec_by_path.return_value = _spec_row()
        r = client.get(
            f"/v1/tenants/acme/repository-imports/{_REPO_ID}/spec",
            params={"path": "openapi/petstore.yaml", "branch": "main"},
        )
    assert r.status_code == 200
    body = r.json()
    assert body["source_kind"] == "openapi-3"
    # ``import_id`` is reinterpreted as the repository id under ``?path=``.
    mdb.get_repository_import_spec_by_path.assert_called_once_with(
        _TENANT_ID, _REPO_ID, "openapi/petstore.yaml", "main"
    )
    mdb.get_repository_import_spec_by_id.assert_not_called()


def test_read_spec_by_path_without_branch_resolves_latest():
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.get_repository_import_spec_by_path.return_value = _spec_row()
        r = client.get(
            f"/v1/tenants/acme/repository-imports/{_REPO_ID}/spec",
            params={"path": "openapi/petstore.yaml"},
        )
    assert r.status_code == 200
    mdb.get_repository_import_spec_by_path.assert_called_once_with(
        _TENANT_ID, _REPO_ID, "openapi/petstore.yaml", None
    )


def test_read_spec_by_path_not_found_returns_404():
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.get_repository_import_spec_by_path.return_value = None
        r = client.get(
            f"/v1/tenants/acme/repository-imports/{_REPO_ID}/spec",
            params={"path": "missing.yaml"},
        )
    assert r.status_code == 404


def test_read_spec_empty_path_returns_400():
    with patch("app.tenant_repositories_routes.db") as mdb:
        r = client.get(
            f"/v1/tenants/acme/repository-imports/{_REPO_ID}/spec",
            params={"path": "   "},
        )
    assert r.status_code == 400
    mdb.get_repository_import_spec_by_path.assert_not_called()
    mdb.get_repository_import_spec_by_id.assert_not_called()


def test_read_spec_blank_branch_treated_as_latest():
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.get_repository_import_spec_by_path.return_value = _spec_row()
        r = client.get(
            f"/v1/tenants/acme/repository-imports/{_REPO_ID}/spec",
            params={"path": "openapi/petstore.yaml", "branch": "  "},
        )
    assert r.status_code == 200
    mdb.get_repository_import_spec_by_path.assert_called_once_with(
        _TENANT_ID, _REPO_ID, "openapi/petstore.yaml", None
    )


def test_read_spec_upgrades_legacy_unversioned_options():
    # A version-0 (unmarked) blob carrying a key the current model no longer
    # recognizes must upgrade-on-read: the dropped key is gone and the response
    # reports the current envelope version.
    legacy = _spec_row(
        spec_schema_version=None,
        options_json={
            "apply_naming_convention": True,
            "legacy_dropped_flag": "x",
        },
    )
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.get_repository_import_spec_by_id.return_value = legacy
        r = client.get(f"/v1/tenants/acme/repository-imports/{_SPEC_ID}/spec")
    assert r.status_code == 200
    body = r.json()
    assert body["spec_schema_version"] == REPOSITORY_IMPORT_SPEC_SCHEMA_VERSION
    assert body["options"]["apply_naming_convention"] is True
    assert "legacy_dropped_flag" not in body["options"]


def test_read_spec_surfaces_backfilled_flag():
    # RAR-1.6 (#3517): a spec seeded by the historical backfill migration reports
    # backfilled=true so the UI can label it "imported before spec capture".
    row = _spec_row(backfilled=True, options_json={})
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.get_repository_import_spec_by_id.return_value = row
        r = client.get(f"/v1/tenants/acme/repository-imports/{_SPEC_ID}/spec")
    assert r.status_code == 200
    body = r.json()
    assert body["backfilled"] is True
    # A backfilled spec is the system defaults: empty options validate into the
    # current-shape defaults, keeping it replayable by the refresh worker.
    assert body["options"]["selected_schemas"] == []
    assert body["options"]["apply_naming_convention"] is False


def test_read_spec_backfilled_defaults_false_for_captured_specs():
    # Captured (user-authored) specs — including rows read before the DAO
    # surfaced the column — report backfilled=false.
    row = _spec_row()
    row.pop("backfilled")
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.get_repository_import_spec_by_id.return_value = row
        r = client.get(f"/v1/tenants/acme/repository-imports/{_SPEC_ID}/spec")
    assert r.status_code == 200
    assert r.json()["backfilled"] is False


def test_read_spec_null_descriptor_fields_serialize():
    row = _spec_row(format_override=None, content_type=None, options_json={})
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.get_repository_import_spec_by_id.return_value = row
        r = client.get(f"/v1/tenants/acme/repository-imports/{_SPEC_ID}/spec")
    assert r.status_code == 200
    body = r.json()
    assert body["format_override"] is None
    assert body["content_type"] is None
    # Defaulted options round-trip.
    assert body["options"]["apply_naming_convention"] is False


def test_read_spec_null_freshness_signals_serialize():
    # A spec captured before a scan recorded recency (or for a non-repository
    # import) has NULL anchors; the read model must surface them as null (RAR-2.1).
    row = _spec_row(
        last_imported_commit_sha=None,
        last_imported_committed_at=None,
        last_imported_blob_sha=None,
    )
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.get_repository_import_spec_by_id.return_value = row
        r = client.get(f"/v1/tenants/acme/repository-imports/{_SPEC_ID}/spec")
    assert r.status_code == 200
    body = r.json()
    assert body["last_imported_commit_sha"] is None
    assert body["last_imported_committed_at"] is None
    assert body["last_imported_blob_sha"] is None


def test_read_spec_refresh_status_stale_when_remote_newer():
    # A newer remote commit with changed content materializes as stale (RAR-2.3).
    row = _spec_row(
        last_imported_committed_at="2026-06-20T10:00:00Z",
        last_imported_blob_sha="blob-old",
        remote_committed_at="2026-06-21T10:00:00Z",
        remote_blob_sha="blob-new",
    )
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.get_repository_import_spec_by_id.return_value = row
        r = client.get(f"/v1/tenants/acme/repository-imports/{_SPEC_ID}/spec")
    assert r.status_code == 200
    assert r.json()["refresh_status"] == "stale"


def test_read_spec_refresh_status_up_to_date_when_remote_matches():
    # Same recency and content is the steady state -> up-to-date (RAR-2.3).
    row = _spec_row(
        last_imported_committed_at="2026-06-21T10:00:00Z",
        last_imported_blob_sha="blob-x",
        remote_committed_at="2026-06-21T10:00:00Z",
        remote_blob_sha="blob-x",
    )
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.get_repository_import_spec_by_id.return_value = row
        r = client.get(f"/v1/tenants/acme/repository-imports/{_SPEC_ID}/spec")
    assert r.status_code == 200
    assert r.json()["refresh_status"] == "up-to-date"


def test_read_spec_refresh_status_diverged_overlay():
    # A divergence hold (RAR-4.4) overlays the recency axis even when stale.
    row = _spec_row(
        last_imported_committed_at="2026-06-20T10:00:00Z",
        last_imported_blob_sha="blob-old",
        remote_committed_at="2026-06-21T10:00:00Z",
        remote_blob_sha="blob-new",
        diverged=True,
    )
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.get_repository_import_spec_by_id.return_value = row
        r = client.get(f"/v1/tenants/acme/repository-imports/{_SPEC_ID}/spec")
    assert r.status_code == 200
    assert r.json()["refresh_status"] == "diverged"
