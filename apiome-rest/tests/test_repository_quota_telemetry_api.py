"""The quota telemetry REST surface (REPO-7.3, #2801).

``GET /v1/tenants/{slug}/repository-quota-telemetry`` is the operator read behind the
dashboard. These tests pin what it puts on the wire — the camelCase contract the UI binds
to, the full metric set regardless of stored rows, and the degradations that must not turn
into an error page: a counter read that fails still has to answer "what is my quota".
"""

from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.auth import validate_authentication
from app.main import app
from app.repository_quota_window import (
    ALL_METRICS,
    MAX_TELEMETRY_DAYS,
    METRIC_BYTES_SCANNED,
    METRIC_FILES_DEFERRED,
    METRIC_POLLS,
    METRIC_POLLS_DEFERRED,
    WINDOW_DAY,
    WINDOW_HOUR,
    floor_to_window,
)

client = TestClient(app)

_TENANT_ID = "550e8400-e29b-41d4-a716-446655440000"
_URL = "/v1/tenants/acme/repository-quota-telemetry"

_JWT = {
    "tenant_id": _TENANT_ID,
    "tenant_slug": "acme",
    "user_id": "660e8400-e29b-41d4-a716-446655440001",
    "auth_method": "jwt",
}


@pytest.fixture(autouse=True)
def auth_jwt():
    app.dependency_overrides[validate_authentication] = lambda: _JWT
    yield
    app.dependency_overrides.pop(validate_authentication, None)


def _call(
    *,
    rows: Optional[List[Dict[str, Any]]] = None,
    read_error: bool = False,
    polls_per_hour: Optional[int] = 600,
    used: int = 42,
    params: Optional[Dict[str, Any]] = None,
):
    """Drive the endpoint against a mocked database, returning (response, db mock)."""
    with patch("app.tenant_repositories_routes.db") as db, patch(
        "app.tenant_repositories_routes.enforce_permission"
    ):
        db.get_tenant_repository_polls_per_hour.return_value = polls_per_hour
        db.count_recent_repository_refresh_jobs_by_tenant.return_value = {_TENANT_ID: used}
        if read_error:
            db.list_repository_quota_windows.side_effect = RuntimeError("connection refused")
        else:
            db.list_repository_quota_windows.return_value = rows or []
        response = client.get(_URL, params=params or {})
    return response, db


def _metric(body: Dict[str, Any], metric: str) -> Dict[str, Any]:
    return next(m for m in body["telemetry"]["metrics"] if m["metric"] == metric)


def _row(metric: str, window_start: datetime, amount: int) -> Dict[str, Any]:
    return {"metric": metric, "window_start": window_start, "amount": amount}


# --- the shape on the wire ---------------------------------------------------------------


def test_the_read_reports_every_metric_even_with_no_activity() -> None:
    """A tenant that has never been deferred needs a flat zero line, not a missing panel
    an operator would read as "telemetry is broken"."""
    response, _ = _call()
    assert response.status_code == 200
    body = response.json()
    assert [m["metric"] for m in body["telemetry"]["metrics"]] == list(ALL_METRICS)


def test_the_default_range_is_a_week() -> None:
    response, _ = _call()
    telemetry = response.json()["telemetry"]
    assert telemetry["days"] == 7
    assert all(len(m["points"]) == 7 for m in telemetry["metrics"])


def test_the_range_is_configurable_within_the_supported_span() -> None:
    response, _ = _call(params={"days": 30})
    assert response.json()["telemetry"]["days"] == 30


@pytest.mark.parametrize("days", [0, -1, MAX_TELEMETRY_DAYS + 1])
def test_a_range_outside_the_supported_span_is_rejected_not_silently_shrunk(days: int) -> None:
    """A caller that asked for a year and got a week without being told would draw
    conclusions about a range it never saw."""
    response, _ = _call(params={"days": days})
    assert response.status_code == 422


def test_the_payload_is_camel_case_for_the_dashboard() -> None:
    response, _ = _call()
    body = response.json()
    assert "rangeStart" in body["telemetry"]
    assert "rangeEnd" in body["telemetry"]
    polls = _metric(body, METRIC_POLLS)
    assert "windowKind" in polls
    assert "currentWindow" in polls


def test_each_metric_names_the_window_it_resets_on() -> None:
    response, _ = _call()
    body = response.json()
    assert _metric(body, METRIC_POLLS)["windowKind"] == WINDOW_HOUR
    assert _metric(body, METRIC_BYTES_SCANNED)["windowKind"] == WINDOW_DAY


def test_deferrals_are_flagged_apart_from_work_performed() -> None:
    """`polls` and `polls_deferred` answer different questions; a client that could not
    tell them apart would chart "we were throttled" as "we were busy"."""
    response, _ = _call()
    body = response.json()
    assert _metric(body, METRIC_POLLS)["deferral"] is False
    assert _metric(body, METRIC_POLLS_DEFERRED)["deferral"] is True
    assert _metric(body, METRIC_FILES_DEFERRED)["deferral"] is True


# --- the numbers -------------------------------------------------------------------------


def test_stored_counters_reach_the_series() -> None:
    now = datetime.now(timezone.utc)
    rows = [
        _row(METRIC_POLLS, floor_to_window(now, WINDOW_HOUR), 8),
        _row(METRIC_POLLS, floor_to_window(now, WINDOW_HOUR) - timedelta(days=1), 5),
    ]
    response, _ = _call(rows=rows)
    polls = _metric(response.json(), METRIC_POLLS)
    assert polls["total"] == 13
    assert polls["points"][-1]["value"] == 8
    assert polls["currentWindow"] == 8


def test_the_read_is_scoped_to_the_authenticated_tenant_not_the_path_slug() -> None:
    _, db = _call()
    assert db.list_repository_quota_windows.call_args.args[0] == _TENANT_ID


# --- the quota position ------------------------------------------------------------------


def test_the_current_quota_ships_with_the_history() -> None:
    """"42 of 600 this hour" and "here is the week" are one question; two requests to
    answer it would let the panel render them out of step."""
    response, _ = _call(polls_per_hour=600, used=42)
    quota = response.json()["quota"]
    assert quota["pollsPerHour"] == 600
    assert quota["usedThisWindow"] == 42
    assert quota["remainingThisWindow"] == 558


def test_an_unlimited_tenant_reports_no_ceiling() -> None:
    response, _ = _call(polls_per_hour=0)
    quota = response.json()["quota"]
    assert quota["enforced"] is False
    assert quota["effectivePollsPerHour"] is None


# --- degradation -------------------------------------------------------------------------


def test_a_failed_counter_read_still_answers_the_quota_question() -> None:
    response, _ = _call(read_error=True)
    assert response.status_code == 200
    assert response.json()["quota"]["pollsPerHour"] == 600


def test_a_failed_counter_read_says_the_zeros_are_absence_of_data() -> None:
    """Without the flag, "we could not read the counters" and "nothing happened all week"
    render identically — and only one of them warrants a page."""
    response, _ = _call(read_error=True)
    telemetry = response.json()["telemetry"]
    assert telemetry["available"] is False
    assert all(m["total"] == 0 for m in telemetry["metrics"])


def test_a_successful_read_is_marked_available() -> None:
    response, _ = _call()
    assert response.json()["telemetry"]["available"] is True


# --- authorization -----------------------------------------------------------------------


def test_the_read_requires_the_imports_view_permission() -> None:
    with patch("app.tenant_repositories_routes.db"), patch(
        "app.tenant_repositories_routes.enforce_permission"
    ) as enforce:
        client.get(_URL)
    assert enforce.called
