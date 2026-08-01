"""The tenant polling-quota REST surface (REPO-4.6, #2784).

``GET/PUT /v1/tenants/{slug}/repository-polling-quota`` is how an operator reads and tunes the
bound the auto-refresh scheduler applies to a tenant. These tests pin the projection's shape
(camelCase aliases, the null-means-unbounded convention), the fact that the tenant scope comes
from the token rather than the path, and the validation rails on the update.
"""

from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

import app.config as config
from app.auth import validate_authentication
from app.main import app

client = TestClient(app)

_TENANT_ID = "550e8400-e29b-41d4-a716-446655440000"
_OTHER_TENANT_ID = "550e8400-e29b-41d4-a716-4466554400ff"

_JWT = {
    "tenant_id": _TENANT_ID,
    "tenant_slug": "acme",
    "user_id": "660e8400-e29b-41d4-a716-446655440001",
    "auth_method": "jwt",
}

_URL = "/v1/tenants/acme/repository-polling-quota"


@pytest.fixture
def auth_jwt():
    app.dependency_overrides[validate_authentication] = lambda: _JWT
    yield
    app.dependency_overrides.pop(validate_authentication, None)


@pytest.fixture(autouse=True)
def default_settings(monkeypatch):
    """Pin the deployment default and window so assertions are about the tenant."""
    monkeypatch.setattr(config.settings, "refresh_tenant_quota_jobs", 60)
    monkeypatch.setattr(config.settings, "refresh_tenant_quota_window_seconds", 3600)


# --- read -------------------------------------------------------------------------------


def test_the_read_reports_the_persisted_quota_and_window_usage(auth_jwt) -> None:
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.get_tenant_repository_polls_per_hour.return_value = 600
        mdb.count_recent_repository_refresh_jobs_by_tenant.return_value = {_TENANT_ID: 42}
        r = client.get(_URL)

    assert r.status_code == 200
    quota = r.json()["quota"]
    assert quota["pollsPerHour"] == 600
    assert quota["effectivePollsPerHour"] == 600
    assert quota["windowSeconds"] == 3600
    assert quota["usedThisWindow"] == 42
    assert quota["remainingThisWindow"] == 558
    assert quota["enforced"] is True


def test_a_tenant_with_no_stored_value_reports_the_default(auth_jwt) -> None:
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.get_tenant_repository_polls_per_hour.return_value = None
        mdb.count_recent_repository_refresh_jobs_by_tenant.return_value = {}
        r = client.get(_URL)

    quota = r.json()["quota"]
    assert quota["pollsPerHour"] == 60
    assert quota["effectivePollsPerHour"] == 60
    assert quota["remainingThisWindow"] == 60


def test_zero_reports_as_unlimited_not_as_no_budget(auth_jwt) -> None:
    """The convention the UI reads: null effective bound means nothing is enforced."""
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.get_tenant_repository_polls_per_hour.return_value = 0
        mdb.count_recent_repository_refresh_jobs_by_tenant.return_value = {_TENANT_ID: 5000}
        r = client.get(_URL)

    quota = r.json()["quota"]
    assert quota["pollsPerHour"] == 0
    assert quota["effectivePollsPerHour"] is None
    assert quota["remainingThisWindow"] is None
    assert quota["enforced"] is False
    assert quota["usedThisWindow"] == 5000


def test_the_read_is_scoped_by_the_token_not_the_path(auth_jwt) -> None:
    """A different slug in the path must not read another tenant's quota."""
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.get_tenant_repository_polls_per_hour.return_value = 60
        mdb.count_recent_repository_refresh_jobs_by_tenant.return_value = {}
        client.get("/v1/tenants/somebody-else/repository-polling-quota")

    assert mdb.get_tenant_repository_polls_per_hour.call_args.args[0] == _TENANT_ID


def test_the_read_requires_authentication() -> None:
    assert client.get(_URL).status_code in (401, 403)


# --- update -----------------------------------------------------------------------------


def test_the_update_persists_and_returns_the_new_quota(auth_jwt) -> None:
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.set_tenant_repository_polls_per_hour.return_value = 600
        mdb.get_tenant_repository_polls_per_hour.return_value = 600
        mdb.count_recent_repository_refresh_jobs_by_tenant.return_value = {}
        r = client.put(_URL, json={"pollsPerHour": 600})

    assert r.status_code == 200
    assert mdb.set_tenant_repository_polls_per_hour.call_args.args == (_TENANT_ID, 600)
    assert r.json()["quota"]["pollsPerHour"] == 600


def test_zero_is_accepted_as_the_unlimited_opt_out(auth_jwt) -> None:
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.set_tenant_repository_polls_per_hour.return_value = 0
        mdb.get_tenant_repository_polls_per_hour.return_value = 0
        mdb.count_recent_repository_refresh_jobs_by_tenant.return_value = {}
        r = client.put(_URL, json={"pollsPerHour": 0})

    assert r.status_code == 200
    assert mdb.set_tenant_repository_polls_per_hour.call_args.args == (_TENANT_ID, 0)
    assert r.json()["quota"]["enforced"] is False


def test_a_negative_quota_is_rejected(auth_jwt) -> None:
    with patch("app.tenant_repositories_routes.db"):
        r = client.put(_URL, json={"pollsPerHour": -1})
    assert r.status_code == 422


def test_an_absurd_quota_is_rejected(auth_jwt) -> None:
    """The upper rail catches a typo; unlimited is spelled 0, not 999999999."""
    with patch("app.tenant_repositories_routes.db"):
        r = client.put(_URL, json={"pollsPerHour": 999_999_999})
    assert r.status_code == 422


def test_a_missing_quota_field_is_rejected(auth_jwt) -> None:
    with patch("app.tenant_repositories_routes.db"):
        r = client.put(_URL, json={})
    assert r.status_code == 422


def test_an_unknown_tenant_is_a_404(auth_jwt) -> None:
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.set_tenant_repository_polls_per_hour.return_value = None
        r = client.put(_URL, json={"pollsPerHour": 120})

    assert r.status_code == 404
    assert r.json()["detail"] == "tenant not found"


def test_the_update_never_touches_another_tenant(auth_jwt) -> None:
    with patch("app.tenant_repositories_routes.db") as mdb:
        mdb.set_tenant_repository_polls_per_hour.return_value = 120
        mdb.get_tenant_repository_polls_per_hour.return_value = 120
        mdb.count_recent_repository_refresh_jobs_by_tenant.return_value = {}
        client.put("/v1/tenants/somebody-else/repository-polling-quota", json={"pollsPerHour": 120})

    assert mdb.set_tenant_repository_polls_per_hour.call_args.args[0] == _TENANT_ID
    assert _OTHER_TENANT_ID not in str(mdb.set_tenant_repository_polls_per_hour.call_args)
