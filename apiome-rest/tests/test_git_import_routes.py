"""REST contract for git-repository intake — MFI-29.3 (#4390).

Drives ``POST /v1/tenants/{tenant}/import/git/fileset`` with the network boundary
replaced by the in-memory repository client from :mod:`tests.test_git_intake`, so the
route's contract (payload shape, provenance, credential resolution, error mapping) is
tested without touching GitHub.
"""

from __future__ import annotations

import base64
from typing import Any, Dict, Optional

import pytest
from fastapi.testclient import TestClient
from test_git_intake import _COMMIT, _REPO_URL, FakeRepositoryClient, _proto_repo

from app import git_import_routes
from app.archive_intake import unpack_archive
from app.auth import validate_authentication
from app.git_intake import GitIntakeError, GitSelector, fetch_git_fileset
from app.main import app

client = TestClient(app)

TENANT_ID = "550e8400-e29b-41d4-a716-446655440000"
TENANT_SLUG = "acme"
USER_ID = "660e8400-e29b-41d4-a716-446655440001"
REPOSITORY_ID = "770e8400-e29b-41d4-a716-446655440002"
LINKED_ACCOUNT_ID = "880e8400-e29b-41d4-a716-446655440003"

_MOCK_AUTH = {
    "tenant_id": TENANT_ID,
    "tenant_slug": TENANT_SLUG,
    "user_id": USER_ID,
    "auth_method": "jwt",
}

_ENDPOINT = f"/v1/tenants/{TENANT_SLUG}/import/git/fileset"

#: The real resolver, captured before the autouse fixture stubs the module attribute
#: (the route-level tests want it stubbed; the resolver tests below want the real one).
_resolve_token = git_import_routes.resolve_stored_git_token


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
def _no_stored_credentials(monkeypatch):
    """Default: no linked account, so reads are anonymous unless a test says otherwise."""
    monkeypatch.setattr(
        git_import_routes, "resolve_stored_git_token", lambda *args, **kwargs: None
    )


def _use_repository(monkeypatch, repo: FakeRepositoryClient) -> Dict[str, Any]:
    """Point the route at *repo* and record the token it fetched with."""
    seen: Dict[str, Any] = {}

    def _fetch(selector: GitSelector, *, access_token: Optional[str] = None, **kwargs: Any):
        seen["access_token"] = access_token
        seen["selector"] = selector
        return fetch_git_fileset(selector, access_token=access_token, client=repo, **kwargs)

    monkeypatch.setattr(git_import_routes, "fetch_git_fileset", _fetch)
    return seen


def _post(**overrides: Any):
    body: Dict[str, Any] = {"repo_url": _REPO_URL, "ref": "main", "path": "protos/"}
    body.update(overrides)
    return client.post(_ENDPOINT, json=body)


def test_fetches_a_proto_directory_as_an_importable_archive(monkeypatch) -> None:
    _use_repository(monkeypatch, _proto_repo())

    response = _post()

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["members"] == ["common/types.proto", "user/user_service.proto"]
    assert body["archive_root"] == "user/user_service.proto"
    assert body["source_kind"] == "grpc"
    assert body["detection"]["matched"] is True
    assert body["filename"] == f"specs-main-{_COMMIT[:7]}.zip"
    assert body["total_bytes"] > 0

    # The returned bytes are exactly what archive intake accepts (MFI-29.1).
    unpacked = unpack_archive(base64.standard_b64decode(body["document_base64"]))
    assert sorted(unpacked.members) == body["members"]
    assert unpacked.root_path == body["archive_root"]


def test_response_carries_commit_provenance_to_echo_back(monkeypatch) -> None:
    _use_repository(monkeypatch, _proto_repo())

    body = _post(ref="v2.1.0").json()

    assert body["git_source"] == {
        "provider": "github",
        "repo_url": _REPO_URL,
        "owner": "acme",
        "repo": "specs",
        "ref": "v2.1.0",
        "commit_sha": _COMMIT,
        "path": "protos",
        "browse_url": f"{_REPO_URL}/tree/{_COMMIT}/protos",
    }


def test_skipped_files_are_reported_not_silently_dropped(monkeypatch) -> None:
    _use_repository(monkeypatch, _proto_repo())

    body = _post(path="").json()

    reasons = {item["path"]: item["reason"] for item in body["skipped"]}
    assert reasons["docs/logo.png"] == "binary-file"
    assert reasons["node_modules/pkg/index.proto"] == "excluded-directory"


def test_preview_mode_omits_the_document_bytes(monkeypatch) -> None:
    _use_repository(monkeypatch, _proto_repo())

    body = _post(include_document=False).json()

    assert body["document_base64"] is None
    assert body["members"] == ["common/types.proto", "user/user_service.proto"]


def test_explicit_root_is_honoured(monkeypatch) -> None:
    _use_repository(monkeypatch, _proto_repo())

    body = _post(root="common/types.proto").json()

    assert body["archive_root"] == "common/types.proto"


def test_empty_selection_returns_the_taxonomy_code(monkeypatch) -> None:
    _use_repository(monkeypatch, _proto_repo())

    response = _post(path="schemas/**")

    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["code"] == "SOURCE_SELECTION_EMPTY"
    assert detail["category"] == "input"
    assert detail["remediation"]
    assert detail["retriable"] is False


@pytest.mark.parametrize(
    ("code", "expected_status", "expected_retriable"),
    [
        ("SOURCE_NOT_FOUND", 404, False),
        ("SOURCE_AUTH_REQUIRED", 403, False),
        ("SOURCE_UNREACHABLE", 502, True),
        ("INPUT_TOO_LARGE", 413, False),
    ],
)
def test_intake_failures_map_to_their_http_status(
    monkeypatch, code: str, expected_status: int, expected_retriable: bool
) -> None:
    def _raise(*_args: Any, **_kwargs: Any):
        raise GitIntakeError("upstream said no", code=code)

    monkeypatch.setattr(git_import_routes, "fetch_git_fileset", _raise)

    response = _post()

    assert response.status_code == expected_status
    detail = response.json()["detail"]
    assert detail["code"] == code
    assert detail["retriable"] is expected_retriable
    assert detail["message"] == "upstream said no"


def test_unsupported_provider_is_a_422(monkeypatch) -> None:
    _use_repository(monkeypatch, _proto_repo())

    response = _post(repo_url="https://gitlab.com/acme/specs")

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "SOURCE_PROVIDER_UNSUPPORTED"


def test_stored_linked_account_token_is_used_for_private_reads(monkeypatch) -> None:
    seen = _use_repository(monkeypatch, _proto_repo())
    monkeypatch.setattr(
        git_import_routes,
        "resolve_stored_git_token",
        lambda *args, **kwargs: "stored-token",
    )

    assert _post().status_code == 200
    assert seen["access_token"] == "stored-token"


def test_request_cannot_smuggle_a_token(monkeypatch) -> None:
    _use_repository(monkeypatch, _proto_repo())

    response = _post(access_token="attacker-supplied")

    assert response.status_code == 422


# ---------------------------------------------------------------------------
# Credential resolution
# ---------------------------------------------------------------------------


class _FakeDb:
    """Minimal stand-in for the credential lookups the resolver performs."""

    def __init__(self, repo_row: Optional[Dict[str, Any]], oauth: Optional[Dict[str, Any]]):
        self.repo_row = repo_row
        self.oauth = oauth
        self.calls: list[tuple[str, str]] = []

    def get_tenant_repository(self, tenant_id: str, repository_id: str):
        return self.repo_row

    def get_external_auth_provider_for_user(self, linked_account_id: str, user_id: str):
        self.calls.append((linked_account_id, user_id))
        return self.oauth


def test_token_resolves_from_a_registered_repository(monkeypatch) -> None:
    fake = _FakeDb(
        {"linked_account_id": LINKED_ACCOUNT_ID, "created_by": USER_ID},
        {"access_token": "repo-token"},
    )
    monkeypatch.setattr(git_import_routes, "db", fake)

    token = _resolve_token(
        TENANT_ID, USER_ID, repository_id=REPOSITORY_ID, linked_account_id=None
    )

    assert token == "repo-token"
    assert fake.calls == [(LINKED_ACCOUNT_ID, USER_ID)]


def test_token_resolves_from_the_users_own_linked_account(monkeypatch) -> None:
    fake = _FakeDb(None, {"access_token": "user-token"})
    monkeypatch.setattr(git_import_routes, "db", fake)

    token = _resolve_token(
        TENANT_ID, USER_ID, repository_id=None, linked_account_id=LINKED_ACCOUNT_ID
    )

    assert token == "user-token"


def test_unknown_repository_is_a_404(monkeypatch) -> None:
    monkeypatch.setattr(git_import_routes, "db", _FakeDb(None, None))

    from fastapi import HTTPException

    with pytest.raises(HTTPException) as excinfo:
        _resolve_token(TENANT_ID, USER_ID, repository_id=REPOSITORY_ID, linked_account_id=None)
    assert excinfo.value.status_code == 404


def test_no_credential_named_reads_anonymously(monkeypatch) -> None:
    fake = _FakeDb(None, {"access_token": "never-used"})
    monkeypatch.setattr(git_import_routes, "db", fake)

    token = _resolve_token(
        TENANT_ID, USER_ID, repository_id=None, linked_account_id=None
    )

    assert token is None
    assert fake.calls == []
