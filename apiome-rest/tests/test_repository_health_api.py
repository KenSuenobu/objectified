"""The health badge on the repository REST surface (REPO-6.5, #2798).

The badge is rendered from ``GET /v1/tenants/{slug}/repositories`` (the REPO-6.1 rows) and
``GET /v1/tenants/{slug}/repositories/{id}`` (the REPO-6.2 header), so these tests pin what
those two endpoints put on the wire: that every row carries a badge, that the signals are
fetched in one batched query rather than one per row, that the detail read asks only for
its own repository, and that a health failure degrades the badge instead of the response.
"""

from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.main import app

client = TestClient(app)

_TENANT_ID = "550e8400-e29b-41d4-a716-446655440000"
_REPO_ID = "880e8400-e29b-41d4-a716-446655440003"
_OTHER_REPO_ID = "880e8400-e29b-41d4-a716-446655440009"

_JWT = {
    "tenant_id": _TENANT_ID,
    "tenant_slug": "acme",
    "user_id": "660e8400-e29b-41d4-a716-446655440001",
    "auth_method": "jwt",
}

_LIST_URL = "/v1/tenants/acme/repositories"
_DETAIL_URL = f"/v1/tenants/acme/repositories/{_REPO_ID}"


@pytest.fixture(autouse=True)
def auth_jwt():
    app.dependency_overrides[validate_authentication] = lambda: _JWT
    yield
    app.dependency_overrides.pop(validate_authentication, None)


def _repo_row(repository_id: str = _REPO_ID, **overrides: Any) -> Dict[str, Any]:
    """One row as ``Database.list_tenant_repositories`` returns it."""
    row = {
        "id": repository_id,
        "tenant_id": _TENANT_ID,
        "source": "linked_account",
        "provider": "github",
        "clone_url": "https://github.com/acme/api-platform.git",
        "repository_full_name": "acme/api-platform",
        "description": "Platform APIs",
        "default_branch": "main",
        "visibility": "private",
        "status": "ready",
        "created_at": "2026-06-01T10:00:00Z",
        "updated_at": "2026-07-01T10:00:00Z",
        "last_scanned_at": "2026-07-30T10:00:00Z",
        "total_files": 1200,
        "importable_count": 14,
        "branch_count": 7,
        "auto_refresh_enabled": True,
        "refresh_consecutive_failures": 0,
        "refresh_backoff_until": None,
        "refresh_paused_at": None,
        "refresh_pause_reason": None,
    }
    row.update(overrides)
    return row


def _signal_row(repository_id: str = _REPO_ID, **overrides: Any) -> Dict[str, Any]:
    """One row as ``Database.get_repository_health_signals`` returns it (all healthy)."""
    row = {
        "repository_id": repository_id,
        "scans_attempted": 12,
        "scans_succeeded": 12,
        "last_scan_finished_at": datetime(2026, 7, 30, 10, tzinfo=timezone.utc),
        "last_scan_failed_at": None,
        "parse_error_count": 0,
        "last_parse_error_at": None,
        "token_required": True,
        "linked_account_present": True,
        "has_access_token": True,
        "token_expires_at": datetime.now(timezone.utc) + timedelta(days=180),
    }
    row.update(overrides)
    return row


def _get_list(repo_rows: List[Dict[str, Any]], signal_rows: List[Dict[str, Any]]):
    with patch("app.tenant_repositories_routes.db") as db:
        db.list_tenant_repositories.return_value = repo_rows
        db.get_repository_health_signals.return_value = signal_rows
        response = client.get(_LIST_URL)
    return response, db


def _get_detail(repo_row, signal_rows: List[Dict[str, Any]]):
    with patch("app.tenant_repositories_routes.db") as db:
        db.get_tenant_repository.return_value = repo_row
        db.get_repository_health_signals.return_value = signal_rows
        response = client.get(_DETAIL_URL)
    return response, db


# --- the list surface (REPO-6.1 rows) ---------------------------------------------------


def test_every_listed_repository_carries_a_health_badge() -> None:
    response, _ = _get_list(
        [_repo_row(), _repo_row(_OTHER_REPO_ID)],
        [_signal_row(), _signal_row(_OTHER_REPO_ID)],
    )
    assert response.status_code == 200
    repos = response.json()["repositories"]
    assert len(repos) == 2
    assert {r["health"]["level"] for r in repos} == {"healthy"}


def test_the_badge_is_matched_to_the_right_repository() -> None:
    """A mis-keyed lookup would paint one repository's problem onto another's row."""
    response, _ = _get_list(
        [_repo_row(), _repo_row(_OTHER_REPO_ID)],
        [
            _signal_row(scans_attempted=10, scans_succeeded=1),
            _signal_row(_OTHER_REPO_ID),
        ],
    )
    by_id = {r["id"]: r for r in response.json()["repositories"]}
    assert by_id[_REPO_ID]["health"]["level"] == "error"
    assert by_id[_OTHER_REPO_ID]["health"]["level"] == "healthy"


def test_the_signals_are_read_once_for_the_whole_page() -> None:
    """One query per row would make the repositories screen N+1 on its hottest read."""
    _, db = _get_list(
        [_repo_row(), _repo_row(_OTHER_REPO_ID)],
        [_signal_row(), _signal_row(_OTHER_REPO_ID)],
    )
    assert db.get_repository_health_signals.call_count == 1


def test_the_batched_read_is_not_narrowed_to_a_subset() -> None:
    _, db = _get_list([_repo_row()], [_signal_row()])
    args, _kwargs = db.get_repository_health_signals.call_args
    assert args[0] == _TENANT_ID
    assert args[1] is None


def test_an_empty_repository_list_does_not_query_health_at_all() -> None:
    _, db = _get_list([], [])
    assert db.get_repository_health_signals.call_count == 0


def test_a_repository_with_no_signal_row_simply_has_no_badge() -> None:
    """Missing signals must not be rendered as a health verdict Apiome cannot support."""
    response, _ = _get_list([_repo_row(), _repo_row(_OTHER_REPO_ID)], [_signal_row()])
    by_id = {r["id"]: r for r in response.json()["repositories"]}
    assert by_id[_REPO_ID]["health"] is not None
    assert by_id[_OTHER_REPO_ID]["health"] is None


def test_a_health_query_failure_does_not_fail_the_listing() -> None:
    """The badge is a decoration on the listing, never its point of failure."""
    with patch("app.tenant_repositories_routes.db") as db:
        db.list_tenant_repositories.return_value = [_repo_row()]
        db.get_repository_health_signals.side_effect = RuntimeError("relation missing")
        response = client.get(_LIST_URL)
    assert response.status_code == 200
    repos = response.json()["repositories"]
    assert len(repos) == 1
    assert repos[0]["health"] is None
    assert repos[0]["full_name"] == "acme/api-platform"


# --- the detail surface (REPO-6.2 header) -----------------------------------------------


def test_the_detail_read_carries_the_badge() -> None:
    response, _ = _get_detail(_repo_row(), [_signal_row()])
    assert response.status_code == 200
    assert response.json()["repository"]["health"]["level"] == "healthy"


def test_the_detail_read_asks_only_for_its_own_repository() -> None:
    _, db = _get_detail(_repo_row(), [_signal_row()])
    args, _kwargs = db.get_repository_health_signals.call_args
    assert args[0] == _TENANT_ID
    assert args[1] == [_REPO_ID]


def test_a_missing_repository_is_still_a_404() -> None:
    with patch("app.tenant_repositories_routes.db") as db:
        db.get_tenant_repository.return_value = None
        response = client.get(_DETAIL_URL)
    assert response.status_code == 404
    assert db.get_repository_health_signals.call_count == 0


# --- the payload contract ---------------------------------------------------------------


def test_a_degraded_repository_reports_its_factors_and_a_tooltip_factor() -> None:
    response, _ = _get_detail(
        _repo_row(),
        [
            _signal_row(
                scans_attempted=10,
                scans_succeeded=3,
                last_scan_failed_at=datetime(2026, 7, 20, tzinfo=timezone.utc),
                parse_error_count=2,
                last_parse_error_at=datetime(2026, 7, 29, tzinfo=timezone.utc),
            )
        ],
    )
    health = response.json()["repository"]["health"]
    assert health["level"] == "error"
    assert [f["code"] for f in health["factors"]] == ["scan-failing", "parse-errors"]
    # The most recent contributing factor leads the tooltip, even though it is not the
    # most severe one.
    assert health["primary_factor"]["code"] == "parse-errors"
    assert health["primary_factor"]["summary"]


def test_a_healthy_repository_reports_no_factors() -> None:
    response, _ = _get_detail(_repo_row(), [_signal_row()])
    health = response.json()["repository"]["health"]
    assert health["level"] == "healthy"
    assert health["factors"] == []
    assert health["primary_factor"] is None
    assert health["score"] == 100


def test_a_token_problem_is_visible_on_an_otherwise_spotless_repository() -> None:
    response, _ = _get_detail(
        _repo_row(),
        [_signal_row(linked_account_present=False, has_access_token=False)],
    )
    health = response.json()["repository"]["health"]
    assert health["level"] == "error"
    assert health["primary_factor"]["code"] == "token-unlinked"


def test_the_badge_reports_the_window_it_measured() -> None:
    response, _ = _get_detail(_repo_row(), [_signal_row()])
    health = response.json()["repository"]["health"]
    assert health["window_days"] == 30
    assert health["scans_attempted"] == 12
    assert health["scans_succeeded"] == 12
    assert health["scan_success_rate"] == 1.0


def test_the_badge_does_not_leak_the_access_token() -> None:
    """Whatever else the projection carries, a credential is never part of it."""
    response, _ = _get_detail(_repo_row(), [_signal_row()])
    body = response.text.lower()
    assert "access_token" not in body
    assert "linked_account_id" not in body
