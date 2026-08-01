"""The audit-export REST surface (REPO-7.5, #2803).

``GET /v1/tenants/{slug}/repository-audit-export`` is the compliance download. These
tests pin the contract: tenant administrators only (API keys refused), both wire
formats with their content types and dateable attachment names, the inclusive range
reaching the ledger query, batched streaming past a single fetch, and the export
leaving its own ``repository.audit_exported`` row behind.
"""

import csv
import io
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.main import app
from app.repository_audit_export import (
    AUDIT_EXPORTED_ACTION,
    EXPORT_COLUMNS,
    REPOSITORY_ACTION_PREFIX,
)

client = TestClient(app)

_TENANT_ID = "550e8400-e29b-41d4-a716-446655440000"
_USER_ID = "660e8400-e29b-41d4-a716-446655440001"
_URL = "/v1/tenants/acme/repository-audit-export"

_JWT = {
    "tenant_id": _TENANT_ID,
    "tenant_slug": "acme",
    "user_id": _USER_ID,
    "auth_method": "jwt",
}

_BASE_TS = datetime(2026, 7, 1, 12, 0, 0, tzinfo=timezone.utc)


def _row(index: int, **overrides: Any) -> Dict[str, Any]:
    row: Dict[str, Any] = {
        "id": f"00000000-0000-0000-0000-{index:012d}",
        "tenant_id": _TENANT_ID,
        "project_id": None,
        "version_id": None,
        "action": "repository.refresh.cycle",
        "outcome": "success",
        "actor_id": None,
        "detail": {"index": index},
        "created_at": _BASE_TS + timedelta(seconds=index),
    }
    row.update(overrides)
    return row


@pytest.fixture()
def auth_jwt():
    app.dependency_overrides[validate_authentication] = lambda: _JWT
    yield
    app.dependency_overrides.pop(validate_authentication, None)


def _call(
    *,
    batches: Optional[List[List[Dict[str, Any]]]] = None,
    is_admin: bool = True,
    params: Optional[Dict[str, Any]] = None,
):
    """Drive the endpoint against a mocked database, returning (response, db mock)."""
    with patch("app.tenant_repositories_routes.db") as db:
        db.is_user_tenant_admin.return_value = is_admin
        served = list(batches) if batches is not None else [[]]
        # After the scripted batches the walk sees an empty page and stops.
        db.list_workflow_audit_for_export.side_effect = served + [[]] * 3
        response = client.get(_URL, params=params or {})
    return response, db


# --- authorization ---------------------------------------------------------------------


def test_a_non_admin_member_is_refused(auth_jwt) -> None:
    """The ledger names every actor in the workspace; membership alone must not
    be enough to walk out with it."""
    response, db = _call(is_admin=False)
    assert response.status_code == 403
    assert not db.list_workflow_audit_for_export.called


def test_an_api_key_is_refused_even_for_an_admin_tenant() -> None:
    app.dependency_overrides[validate_authentication] = lambda: {
        "tenant_id": _TENANT_ID,
        "auth_method": "api_key",
    }
    try:
        response, db = _call()
    finally:
        app.dependency_overrides.pop(validate_authentication, None)
    assert response.status_code == 403
    assert not db.list_workflow_audit_for_export.called


def test_a_refused_caller_leaves_no_export_audit_row(auth_jwt) -> None:
    _, db = _call(is_admin=False)
    assert not db.insert_workflow_audit.called


# --- parameter validation ----------------------------------------------------------------


def test_an_unknown_format_is_a_400(auth_jwt) -> None:
    response, _ = _call(params={"format": "xlsx"})
    assert response.status_code == 400
    assert "format" in response.json()["detail"].lower()


def test_a_malformed_bound_is_a_400_naming_the_parameter(auth_jwt) -> None:
    response, _ = _call(params={"from": "last tuesday"})
    assert response.status_code == 400
    assert "from" in response.json()["detail"]


def test_an_inverted_range_is_a_400(auth_jwt) -> None:
    response, _ = _call(
        params={"from": "2026-07-31T00:00:00Z", "to": "2026-01-01T00:00:00Z"}
    )
    assert response.status_code == 400


# --- the JSON document ---------------------------------------------------------------


def test_json_is_the_default_format(auth_jwt) -> None:
    response, _ = _call(batches=[[_row(0)]])
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")
    body = response.json()
    assert body["export"]["format"] == "json"
    assert body["rowCount"] == 1


def test_the_json_envelope_is_scoped_to_the_token_tenant_not_the_path_slug(
    auth_jwt,
) -> None:
    response, db = _call(batches=[[_row(0)]])
    assert response.json()["export"]["tenantId"] == _TENANT_ID
    assert (
        db.list_workflow_audit_for_export.call_args.args[0] == _TENANT_ID
    )


def test_entries_carry_the_camel_case_columns(auth_jwt) -> None:
    response, _ = _call(
        batches=[[_row(3, actor_id=_USER_ID, outcome="failure")]]
    )
    entry = response.json()["entries"][0]
    assert list(entry.keys()) == list(EXPORT_COLUMNS)
    assert entry["actorId"] == _USER_ID
    assert entry["outcome"] == "failure"
    assert entry["detail"] == {"index": 3}


# --- the CSV document ----------------------------------------------------------------


def test_csv_ships_with_its_content_type_and_a_dateable_filename(auth_jwt) -> None:
    response, _ = _call(
        batches=[[_row(0)]],
        params={
            "format": "csv",
            "from": "2026-01-01T00:00:00Z",
            "to": "2026-07-31T23:59:59Z",
        },
    )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    assert (
        response.headers["content-disposition"]
        == 'attachment; filename="repository-audit-export_20260101-20260731.csv"'
    )


def test_csv_has_the_header_and_one_line_per_row(auth_jwt) -> None:
    response, _ = _call(batches=[[_row(0), _row(1)]], params={"format": "csv"})
    parsed = list(csv.reader(io.StringIO(response.text)))
    assert parsed[0] == list(EXPORT_COLUMNS)
    assert len(parsed) == 3


def test_an_unbounded_export_gets_the_plain_filename(auth_jwt) -> None:
    response, _ = _call(params={"format": "json"})
    assert (
        response.headers["content-disposition"]
        == 'attachment; filename="repository-audit-export.json"'
    )


# --- the range and the walk --------------------------------------------------------------


def test_the_bounds_reach_the_ledger_query_inclusive_and_utc(auth_jwt) -> None:
    _, db = _call(
        params={"from": "2026-07-01T00:00:00Z", "to": "2026-07-31T00:00:00Z"}
    )
    kwargs = db.list_workflow_audit_for_export.call_args.kwargs
    assert kwargs["since"] == datetime(2026, 7, 1, tzinfo=timezone.utc)
    assert kwargs["until"] == datetime(2026, 7, 31, tzinfo=timezone.utc)
    assert kwargs["action_prefix"] == REPOSITORY_ACTION_PREFIX


def test_a_large_export_streams_across_multiple_batches(auth_jwt) -> None:
    """The >10k-row criterion at the surface: a full first batch forces a second
    keyset query, and every row of both still reaches the document."""
    full = [_row(i) for i in range(1000)]
    tail = [_row(1000 + i) for i in range(5)]
    response, db = _call(batches=[full, tail])
    body = response.json()
    assert body["rowCount"] == 1005
    assert len(body["entries"]) == 1005
    assert db.list_workflow_audit_for_export.call_count >= 2
    second = db.list_workflow_audit_for_export.call_args_list[1].kwargs
    assert second["cursor_id"] == str(full[-1]["id"])


# --- the export is itself audited ------------------------------------------------------


def test_a_completed_export_writes_its_own_ledger_row(auth_jwt) -> None:
    _, db = _call(batches=[[_row(0), _row(1)]], params={"format": "csv"})
    assert db.insert_workflow_audit.called
    args = db.insert_workflow_audit.call_args.args
    (tenant_id, _project, _version, action, outcome, actor_id, detail) = args
    assert tenant_id == _TENANT_ID
    assert action == AUDIT_EXPORTED_ACTION
    assert outcome == "success"
    assert actor_id == _USER_ID
    assert detail["rowCount"] == 2
    assert detail["format"] == "csv"
    assert detail["completed"] is True
