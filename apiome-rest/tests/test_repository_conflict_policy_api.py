"""The repository conflict-policy REST surface (RAR-4.5, #3531).

``GET/PUT /v1/tenants/{slug}/repositories/{id}/conflict-policy`` and its
``/file`` sibling are how an operator chooses what an auto-refresh does when it
meets a hand-edited version. These tests pin the projection's shape (camelCase
aliases, the default and the accepted tokens reported alongside the stored value),
the per-file override write/clear round trip, the validation rails, and the fact
that the tenant scope comes from the token rather than the path.
"""

from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.main import app

client = TestClient(app)

_TENANT_ID = "550e8400-e29b-41d4-a716-446655440000"
_USER_ID = "660e8400-e29b-41d4-a716-446655440001"
_REPO_ID = "770e8400-e29b-41d4-a716-446655440002"

_JWT = {
    "tenant_id": _TENANT_ID,
    "tenant_slug": "acme",
    "user_id": _USER_ID,
    "auth_method": "jwt",
}

_URL = f"/v1/tenants/acme/repositories/{_REPO_ID}/conflict-policy"
_FILE_URL = f"{_URL}/file"


@pytest.fixture
def auth_jwt():
    app.dependency_overrides[validate_authentication] = lambda: _JWT
    yield
    app.dependency_overrides.pop(validate_authentication, None)


def _repo_row(policy: str = "hold-for-review") -> dict:
    """A minimal repository row as ``get_tenant_repository`` returns it."""
    return {
        "id": _REPO_ID,
        "tenant_id": _TENANT_ID,
        "repository_full_name": "acme/specs",
        "provider": "github",
        "default_branch": "main",
        "status": "ready",
        "refresh_conflict_policy": policy,
    }


def _override_row(path: str, policy: str) -> dict:
    return {
        "branch": "main",
        "path": path,
        "policy": policy,
        "created_by": _USER_ID,
        "created_at": None,
        "updated_at": None,
    }


# --- read -------------------------------------------------------------------------------


def test_the_read_reports_the_stored_policy_and_its_overrides(auth_jwt) -> None:
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.get_tenant_repository.return_value = _repo_row("overwrite")
        mdb.list_repository_conflict_policy_overrides.return_value = [
            _override_row("specs/petstore.yaml", "hold-for-review")
        ]
        r = client.get(_URL)

    assert r.status_code == 200
    policy = r.json()["conflictPolicy"]
    assert policy["repositoryId"] == _REPO_ID
    assert policy["policy"] == "overwrite"
    assert policy["defaultPolicy"] == "hold-for-review"
    assert policy["availablePolicies"] == ["overwrite", "hold-for-review", "new-branch"]
    assert policy["overrides"] == [
        {
            "branch": "main",
            "path": "specs/petstore.yaml",
            "policy": "hold-for-review",
            "createdBy": _USER_ID,
            "createdAt": None,
            "updatedAt": None,
        }
    ]


def test_a_repository_with_no_stored_policy_reports_the_default(auth_jwt) -> None:
    """A row predating the column must never read as "overwrite"."""
    with patch("app.tenant_repositories_routes.db") as mdb:
        row = _repo_row()
        row.pop("refresh_conflict_policy")
        mdb.get_tenant_repository.return_value = row
        mdb.list_repository_conflict_policy_overrides.return_value = []
        r = client.get(_URL)

    assert r.status_code == 200
    assert r.json()["conflictPolicy"]["policy"] == "hold-for-review"


def test_an_unknown_repository_is_a_404(auth_jwt) -> None:
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.get_tenant_repository.return_value = None
        r = client.get(_URL)

    assert r.status_code == 404


def test_the_read_scopes_to_the_token_tenant_not_the_path_slug(auth_jwt) -> None:
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.get_tenant_repository.return_value = _repo_row()
        mdb.list_repository_conflict_policy_overrides.return_value = []
        r = client.get(f"/v1/tenants/some-other-slug/repositories/{_REPO_ID}/conflict-policy")

    assert r.status_code == 200
    mdb.get_tenant_repository.assert_called_with(_TENANT_ID, _REPO_ID)


# --- repository-wide update -------------------------------------------------------------


def test_the_update_persists_the_policy_and_returns_the_projection(auth_jwt) -> None:
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.set_repository_conflict_policy.return_value = "new-branch"
        mdb.get_tenant_repository.return_value = _repo_row("new-branch")
        mdb.list_repository_conflict_policy_overrides.return_value = []
        r = client.put(_URL, json={"policy": "new-branch"})

    assert r.status_code == 200
    mdb.set_repository_conflict_policy.assert_called_once_with(
        _TENANT_ID, _REPO_ID, "new-branch"
    )
    assert r.json()["conflictPolicy"]["policy"] == "new-branch"


def test_an_unrecognised_policy_is_a_400_listing_the_accepted_tokens(auth_jwt) -> None:
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.set_repository_conflict_policy.side_effect = ValueError(
            "unrecognised conflict policy: 'yolo'"
        )
        r = client.put(_URL, json={"policy": "yolo"})

    assert r.status_code == 400
    detail = r.json()["detail"]
    assert "overwrite" in detail and "hold-for-review" in detail and "new-branch" in detail


def test_updating_an_unknown_repository_is_a_404(auth_jwt) -> None:
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.set_repository_conflict_policy.return_value = None
        r = client.put(_URL, json={"policy": "overwrite"})

    assert r.status_code == 404


def test_the_repository_patch_also_accepts_the_policy(auth_jwt) -> None:
    """The dashboard's existing PATCH carries the policy alongside the RAR-3.3 toggle."""
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.set_repository_conflict_policy.return_value = "overwrite"
        mdb.get_tenant_repository.return_value = _repo_row("overwrite")
        mdb.get_repository_health_signals.return_value = []
        r = client.patch(
            f"/v1/tenants/acme/repositories/{_REPO_ID}",
            json={"refreshConflictPolicy": "overwrite"},
        )

    assert r.status_code == 200
    mdb.set_repository_conflict_policy.assert_called_once_with(
        _TENANT_ID, _REPO_ID, "overwrite"
    )
    assert r.json()["repository"]["refresh_conflict_policy"] == "overwrite"


# --- per-file override ------------------------------------------------------------------


def test_setting_a_file_override_writes_it_and_stamps_the_actor(auth_jwt) -> None:
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.set_repository_file_conflict_policy.return_value = _override_row(
            "specs/petstore.yaml", "overwrite"
        )
        mdb.get_tenant_repository.return_value = _repo_row()
        mdb.list_repository_conflict_policy_overrides.return_value = [
            _override_row("specs/petstore.yaml", "overwrite")
        ]
        r = client.put(
            _FILE_URL,
            json={"branch": "main", "path": "specs/petstore.yaml", "policy": "overwrite"},
        )

    assert r.status_code == 200
    mdb.set_repository_file_conflict_policy.assert_called_once_with(
        _TENANT_ID, _REPO_ID, "main", "specs/petstore.yaml", "overwrite", actor_id=_USER_ID
    )
    overrides = r.json()["conflictPolicy"]["overrides"]
    assert overrides[0]["policy"] == "overwrite"


def test_a_null_policy_clears_the_override(auth_jwt) -> None:
    """Clearing is a delete, so the file inherits whatever the repository says next."""
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.clear_repository_file_conflict_policy.return_value = True
        mdb.get_tenant_repository.return_value = _repo_row("new-branch")
        mdb.list_repository_conflict_policy_overrides.return_value = []
        r = client.put(
            _FILE_URL,
            json={"branch": "main", "path": "specs/petstore.yaml", "policy": None},
        )

    assert r.status_code == 200
    mdb.clear_repository_file_conflict_policy.assert_called_once_with(
        _TENANT_ID, _REPO_ID, "main", "specs/petstore.yaml"
    )
    mdb.set_repository_file_conflict_policy.assert_not_called()
    assert r.json()["conflictPolicy"]["overrides"] == []


def test_clearing_an_override_that_does_not_exist_is_not_an_error(auth_jwt) -> None:
    """The requested end state — this file inherits — already holds."""
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.clear_repository_file_conflict_policy.return_value = False
        mdb.get_tenant_repository.return_value = _repo_row()
        mdb.list_repository_conflict_policy_overrides.return_value = []
        r = client.put(
            _FILE_URL, json={"branch": "main", "path": "specs/gone.yaml", "policy": None}
        )

    assert r.status_code == 200


def test_a_blank_file_key_is_a_400(auth_jwt) -> None:
    with patch("app.tenant_repositories_routes.db") as mdb:
        r = client.put(
            _FILE_URL, json={"branch": "  ", "path": "specs/petstore.yaml", "policy": "overwrite"}
        )

    assert r.status_code == 400
    mdb.set_repository_file_conflict_policy.assert_not_called()


def test_an_unrecognised_file_policy_is_a_400(auth_jwt) -> None:
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.set_repository_file_conflict_policy.side_effect = ValueError(
            "unrecognised conflict policy: 'nope'"
        )
        r = client.put(
            _FILE_URL,
            json={"branch": "main", "path": "specs/petstore.yaml", "policy": "nope"},
        )

    assert r.status_code == 400


def test_an_override_on_an_unknown_repository_is_a_404(auth_jwt) -> None:
    """The DAO returns None when the repository is not the token tenant's."""
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.set_repository_file_conflict_policy.return_value = None
        r = client.put(
            _FILE_URL,
            json={"branch": "main", "path": "specs/petstore.yaml", "policy": "overwrite"},
        )

    assert r.status_code == 404
