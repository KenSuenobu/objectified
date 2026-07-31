"""Tests for GET/POST /v1/tenants/{slug}/repositories."""

from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from psycopg2 import errors as pg_errors

from app.auth import validate_authentication
from app.main import app

client = TestClient(app)

_TENANT_ID = "550e8400-e29b-41d4-a716-446655440000"
_USER_ID = "660e8400-e29b-41d4-a716-446655440001"
_LINKED_ACCOUNT_ID = "770e8400-e29b-41d4-a716-446655440002"

_JWT = {
    "tenant_id": _TENANT_ID,
    "tenant_slug": "acme",
    "user_id": _USER_ID,
    "auth_method": "jwt",
}

_API_KEY_AUTH = {
    "tenant_id": _TENANT_ID,
    "tenant_slug": "acme",
    "auth_method": "api_key",
}

_LIST_ROW = {
    "id": "880e8400-e29b-41d4-a716-446655440003",
    "tenant_id": _TENANT_ID,
    "source": "public_url",
    "provider": "github",
    "clone_url": "https://github.com/octocat/Hello-World.git",
    "repository_full_name": "octocat/Hello-World",
    "description": "Hi",
    "default_branch": "main",
    "visibility": "public",
    "status": "scanning",
    "created_at": None,
    "updated_at": None,
    "linked_account_id": None,
    "last_scanned_at": None,
    "total_files": None,
    "importable_count": None,
    "branch_count": None,
}


@pytest.fixture(autouse=True)
def _auth_jwt():
    app.dependency_overrides[validate_authentication] = lambda: _JWT
    yield
    app.dependency_overrides.pop(validate_authentication, None)


def test_list_repositories_ok():
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.list_tenant_repositories.return_value = [_LIST_ROW]
        r = client.get("/v1/tenants/acme/repositories")
    assert r.status_code == 200
    data = r.json()
    assert data["success"] is True
    assert len(data["repositories"]) == 1
    assert data["repositories"][0]["full_name"] == "octocat/Hello-World"


def test_get_repository_ok():
    rid = _LIST_ROW["id"]
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.get_tenant_repository.return_value = _LIST_ROW
        r = client.get(f"/v1/tenants/acme/repositories/{rid}")
    assert r.status_code == 200
    body = r.json()
    assert body["success"] is True
    assert body["repository"]["id"] == rid
    assert body["repository"]["full_name"] == "octocat/Hello-World"


def test_get_repository_not_found():
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.get_tenant_repository.return_value = None
        r = client.get("/v1/tenants/acme/repositories/880e8400-e29b-41d4-a716-446655440099")
    assert r.status_code == 404


def test_create_public_url_ok():
    meta = {
        "provider": "github",
        "repository_full_name": "octocat/Hello-World",
        "description": None,
        "default_branch": "main",
        "visibility": "public",
        "canonical_clone_url": "https://github.com/octocat/Hello-World.git",
    }
    inserted = {**_LIST_ROW, "clone_url": meta["canonical_clone_url"]}
    with (
        patch("app.tenant_repositories_routes.validate_public_clone_url", return_value=meta),
        patch("app.tenant_repositories_routes.db") as mdb,
    ):
        mdb.insert_tenant_repository.return_value = inserted
        r = client.post(
            "/v1/tenants/acme/repositories",
            json={"source": "public_url", "clone_url": "https://github.com/octocat/Hello-World.git"},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["success"] is True
        assert body["repository"]["provider"] == "github"
        assert body["repository"]["status"] == "scanning"
        mdb.insert_tenant_repository.assert_called_once()
        assert mdb.insert_tenant_repository.call_args.kwargs.get("status") == "scanning"
        mdb.enqueue_repository_file_scan_job.assert_called_once_with(
            _TENANT_ID,
            _LIST_ROW["id"],
            "main",
        )


def test_create_public_url_validation_error():
    with patch(
        "app.tenant_repositories_routes.validate_public_clone_url",
        side_effect=ValueError("nope"),
    ):
        r = client.post(
            "/v1/tenants/acme/repositories",
            json={"source": "public_url", "clone_url": "https://example.com/x.git"},
        )
    assert r.status_code == 400
    assert r.json()["detail"] == "nope"


def test_create_linked_github_ok():
    meta = {
        "provider": "github",
        "repository_full_name": "octocat/Hello-World",
        "description": None,
        "default_branch": "main",
        "visibility": "public",
        "canonical_clone_url": "https://github.com/octocat/Hello-World.git",
    }
    oauth_row = {"id": _LINKED_ACCOUNT_ID, "provider": "github", "access_token": "tok"}
    inserted = {**_LIST_ROW}
    with (
        patch("app.tenant_repositories_routes.db") as mdb,
        patch(
            "app.tenant_repositories_routes.fetch_github_repo_with_token",
            return_value=meta,
        ),
    ):
        mdb.get_external_auth_provider_for_user.return_value = oauth_row
        mdb.insert_tenant_repository.return_value = inserted
        r = client.post(
            "/v1/tenants/acme/repositories",
            json={
                "source": "linked_account",
                "linked_account_id": _LINKED_ACCOUNT_ID,
                "repository_full_name": "octocat/Hello-World",
                "clone_url": "https://github.com/octocat/Hello-World.git",
            },
        )
    assert r.status_code == 200
    mdb.get_external_auth_provider_for_user.assert_called_once()
    assert mdb.insert_tenant_repository.call_args.kwargs.get("status") == "scanning"
    assert mdb.insert_tenant_repository.call_args.kwargs.get("linked_account_id") == _LINKED_ACCOUNT_ID
    mdb.enqueue_repository_file_scan_job.assert_called_once()


def test_create_duplicate_conflict():
    meta = {
        "provider": "github",
        "repository_full_name": "octocat/Hello-World",
        "description": None,
        "default_branch": "main",
        "visibility": "public",
        "canonical_clone_url": "https://github.com/octocat/Hello-World.git",
    }
    with (
        patch("app.tenant_repositories_routes.validate_public_clone_url", return_value=meta),
        patch("app.tenant_repositories_routes.db") as mdb,
    ):
        mdb.insert_tenant_repository.side_effect = pg_errors.UniqueViolation()
        r = client.post(
            "/v1/tenants/acme/repositories",
            json={"source": "public_url", "clone_url": "https://github.com/octocat/Hello-World.git"},
        )
    assert r.status_code == 409


def test_create_requires_jwt():
    app.dependency_overrides[validate_authentication] = lambda: _API_KEY_AUTH
    try:
        r = client.post(
            "/v1/tenants/acme/repositories",
            json={"source": "public_url", "clone_url": "https://github.com/octocat/Hello-World.git"},
        )
    finally:
        app.dependency_overrides[validate_authentication] = lambda: _JWT
    assert r.status_code == 403


def test_resume_refresh_ok():
    """POST .../refresh/resume clears the pause and returns the updated record (RAR-3.4)."""
    rid = _LIST_ROW["id"]
    resumed_row = {
        **_LIST_ROW,
        "refresh_consecutive_failures": 0,
        "refresh_backoff_until": None,
        "refresh_paused_at": None,
        "refresh_pause_reason": None,
    }
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.resume_repository_refresh.return_value = {"was_paused": True}
        mdb.get_tenant_repository.return_value = resumed_row
        r = client.post(f"/v1/tenants/acme/repositories/{rid}/refresh/resume")
    assert r.status_code == 200
    body = r.json()
    assert body["success"] is True
    assert body["repository"]["refresh_paused_at"] is None
    assert body["repository"]["refresh_consecutive_failures"] == 0
    mdb.resume_repository_refresh.assert_called_once_with(_TENANT_ID, rid)


def test_resume_refresh_not_found():
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.resume_repository_refresh.return_value = None
        r = client.post(
            "/v1/tenants/acme/repositories/880e8400-e29b-41d4-a716-446655440099/refresh/resume"
        )
    assert r.status_code == 404


def test_repository_record_surfaces_pause_state():
    """A paused repo's record carries the RAR-3.4 failure/pause fields."""
    rid = _LIST_ROW["id"]
    paused_row = {
        **_LIST_ROW,
        "refresh_consecutive_failures": 8,
        "refresh_backoff_until": "2026-07-31T12:00:00+00:00",
        "refresh_paused_at": "2026-07-30T09:00:00+00:00",
        "refresh_pause_reason": "branch main: 401 bad credentials",
    }
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.get_tenant_repository.return_value = paused_row
        r = client.get(f"/v1/tenants/acme/repositories/{rid}")
    assert r.status_code == 200
    repo = r.json()["repository"]
    assert repo["refresh_consecutive_failures"] == 8
    assert repo["refresh_paused_at"] == "2026-07-30T09:00:00+00:00"
    assert repo["refresh_backoff_until"] == "2026-07-31T12:00:00+00:00"
    assert repo["refresh_pause_reason"] == "branch main: 401 bad credentials"


def test_repository_record_defaults_healthy_for_pre_column_rows():
    """A row predating the RAR-3.4 columns reads as healthy (0 failures, unpaused)."""
    rid = _LIST_ROW["id"]
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.get_tenant_repository.return_value = dict(_LIST_ROW)
        r = client.get(f"/v1/tenants/acme/repositories/{rid}")
    assert r.status_code == 200
    repo = r.json()["repository"]
    assert repo["refresh_consecutive_failures"] == 0
    assert repo["refresh_paused_at"] is None
    assert repo["refresh_backoff_until"] is None
    assert repo["refresh_pause_reason"] is None


def test_delete_repository_ok():
    rid = _LIST_ROW["id"]
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.delete_tenant_repository.return_value = True
        r = client.delete(f"/v1/tenants/acme/repositories/{rid}")
    assert r.status_code == 200
    assert r.json() == {"success": True}
    mdb.delete_tenant_repository.assert_called_once_with(_TENANT_ID, rid)


def test_delete_repository_not_found():
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.delete_tenant_repository.return_value = False
        r = client.delete("/v1/tenants/acme/repositories/880e8400-e29b-41d4-a716-446655440099")
    assert r.status_code == 404


def test_list_repository_files_ok():
    rid = _LIST_ROW["id"]
    sample = {
        "indexed_total": 10,
        "match_count": 2,
        "importable_match_count": 1,
        "limit": 50,
        "offset": 0,
        "rows": [
            {
                "id": "990e8400-e29b-41d4-a716-446655440001",
                "path": "openapi/a.yaml",
                "name": "a.yaml",
                "ext": "yaml",
                "size_bytes": 100,
                "blob_sha": "deadbeefcafe",
                "detected_kind": "openapi-candidate",
            },
        ],
    }
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.get_tenant_repository.return_value = _LIST_ROW
        mdb.tenant_repository_files_stats_and_page.return_value = sample
        mdb.list_tenant_repository_file_branches.return_value = ["main"]
        r = client.get(f"/v1/tenants/acme/repositories/{rid}/files?branch=main&preset=openapi")
    assert r.status_code == 200
    body = r.json()
    assert body["success"] is True
    assert body["branch"] == "main"
    assert body["indexed_total"] == 10
    assert body["match_count"] == 2
    assert body["importable_match_count"] == 1
    assert len(body["files"]) == 1
    assert body["files"][0]["path"] == "openapi/a.yaml"
    assert body["files"][0]["display_kind"] == "OpenAPI"
    assert body["files"][0]["confidence"] == "filename"


def test_list_repository_files_glob_without_preset_union():
    """Non-empty ``glob`` must not be OR'd with preset patterns (that widened matches)."""
    rid = _LIST_ROW["id"]
    sample = {
        "indexed_total": 10,
        "match_count": 1,
        "importable_match_count": 1,
        "limit": 50,
        "offset": 0,
        "rows": [
            {
                "id": "990e8400-e29b-41d4-a716-446655440001",
                "path": "services/api.yaml",
                "name": "api.yaml",
                "ext": "yaml",
                "size_bytes": 100,
                "blob_sha": "deadbeefcafe",
                "detected_kind": "openapi-candidate",
            },
        ],
    }
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.get_tenant_repository.return_value = _LIST_ROW
        mdb.tenant_repository_files_stats_and_page.return_value = sample
        mdb.list_tenant_repository_file_branches.return_value = ["main"]
        r = client.get(
            f"/v1/tenants/acme/repositories/{rid}/files?branch=main&preset=all&glob=**/services/*.yaml"
        )
    assert r.status_code == 200
    mdb.tenant_repository_files_stats_and_page.assert_called_once()
    kwargs = mdb.tenant_repository_files_stats_and_page.call_args.kwargs
    pats = kwargs.get("like_patterns") or []
    assert len(pats) == 1
    assert pats[0] == "%/services/%.yaml"


def test_list_repository_files_not_found():
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.get_tenant_repository.return_value = None
        r = client.get(f"/v1/tenants/acme/repositories/{_LIST_ROW['id']}/files")
    assert r.status_code == 404


def test_list_repository_files_invalid_regex():
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.get_tenant_repository.return_value = _LIST_ROW
        r = client.get(f"/v1/tenants/acme/repositories/{_LIST_ROW['id']}/files?regex=(unclosed")
    assert r.status_code == 400


_FILE_ROW = {
    "id": "990e8400-e29b-41d4-a716-446655440099",
    "repository_id": _LIST_ROW["id"],
    "branch": "main",
    "path": "README.md",
    "name": "README.md",
    "ext": "md",
    "size_bytes": 12,
    "blob_sha": "abc1234",
    "detected_kind": "yaml-candidate",
    "provider": "github",
    "clone_url": "https://github.com/octocat/Hello-World.git",
    "repository_full_name": "octocat/Hello-World",
    "linked_account_id": None,
    "created_by": _USER_ID,
    "visibility": "public",
}


def test_get_repository_file_content_ok():
    rid = _LIST_ROW["id"]
    fid = _FILE_ROW["id"]
    with (
        patch("app.tenant_repositories_routes.db") as mdb,
        patch(
            "app.tenant_repositories_routes.fetch_github_repository_file_text",
            return_value=("hello: world\n", False),
        ),
    ):
        mdb.get_tenant_repository_file_row.return_value = _FILE_ROW
        r = client.get(f"/v1/tenants/acme/repositories/{rid}/files/{fid}/content")
    assert r.status_code == 200
    body = r.json()
    assert body["success"] is True
    assert body["path"] == "README.md"
    assert body["branch"] == "main"
    assert body["content"] == "hello: world\n"
    assert body["truncated"] is False
    assert body["display_kind"] == "YAML (unclassified)"
    mdb.insert_workflow_audit.assert_called_once()


def test_get_repository_file_content_not_found():
    rid = _LIST_ROW["id"]
    fid = _FILE_ROW["id"]
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.get_tenant_repository_file_row.return_value = None
        r = client.get(f"/v1/tenants/acme/repositories/{rid}/files/{fid}/content")
    assert r.status_code == 404
