"""SQL contract of the repository health-signals DAO (REPO-6.5, #2798).

``Database.get_repository_health_signals`` is one query that feeds every health badge on
the repositories screen, so what matters is not its exact text but the invariants a wrong
assembly would break: tenant scoping, the window the scan rate is measured over, the
predicate that must match the V231 partial index, parameter/placeholder alignment, and the
fact that a token's *value* is never selected.
"""

from typing import Any, Dict, List, Tuple
from unittest.mock import patch

import pytest

from app.database import Database

_TENANT = "550e8400-e29b-41d4-a716-446655440000"
_REPO = "880e8400-e29b-41d4-a716-446655440003"
_OTHER_REPO = "880e8400-e29b-41d4-a716-446655440009"


class _Recorder:
    """Stands in for ``Database.execute_query``, recording the (sql, params) pair."""

    def __init__(self) -> None:
        self.calls: List[Tuple[str, Tuple[Any, ...]]] = []

    def __call__(self, sql: str, params: Tuple[Any, ...] = ()) -> List[Dict[str, Any]]:
        self.calls.append((sql, tuple(params or ())))
        return []

    @property
    def only_call(self) -> Tuple[str, Tuple[Any, ...]]:
        assert len(self.calls) == 1, f"expected one query, got {len(self.calls)}"
        return self.calls[0]


def _run(**kwargs) -> Tuple[str, Tuple[Any, ...]]:
    db = Database.__new__(Database)  # no connection: execute_query is the only I/O seam
    rec = _Recorder()
    with patch.object(Database, "execute_query", rec):
        db.get_repository_health_signals(_TENANT, **kwargs)
    return rec.only_call


# --- scoping ----------------------------------------------------------------------------


def test_the_query_is_scoped_to_the_tenant() -> None:
    sql, params = _run()
    assert "r.tenant_id = %s::uuid" in sql
    assert _TENANT in params


def test_soft_deleted_repositories_are_excluded() -> None:
    sql, _ = _run()
    assert "r.deleted_at IS NULL" in sql


def test_a_repository_subset_is_filtered_in_sql_not_in_python() -> None:
    """The detail view reads one repository; it must not pull the whole tenant to do it."""
    sql, params = _run(repository_ids=[_REPO])
    assert "r.id = ANY(%s::uuid[])" in sql
    assert [_REPO] in params


def test_no_subset_reads_every_live_repository() -> None:
    sql, _ = _run()
    assert "ANY(" not in sql


def test_an_empty_subset_is_treated_as_no_subset() -> None:
    """An empty list is "no filter given", never "match nothing" — the latter would blank
    every badge on the page."""
    sql, _ = _run(repository_ids=[])
    assert "ANY(" not in sql


def test_repository_ids_are_stringified_for_the_driver() -> None:
    import uuid as _uuid

    rid = _uuid.UUID(_REPO)
    _, params = _run(repository_ids=[rid])
    assert [_REPO] in params


# --- the scan-rate window ---------------------------------------------------------------


def test_the_scan_window_is_thirty_days_by_default() -> None:
    _, params = _run()
    assert params[0] == 30


def test_the_scan_window_is_applied_in_sql() -> None:
    sql, _ = _run()
    assert "make_interval(days => %s)" in sql
    assert "j.created_at >=" in sql


def test_a_caller_can_narrow_the_window() -> None:
    _, params = _run(window_days=7)
    assert params[0] == 7


@pytest.mark.parametrize("bad", [0, -5, None])
def test_a_nonsensical_window_is_clamped_to_one_day(bad) -> None:
    """A zero or negative interval would silently make every repository look unscanned."""
    _, params = _run(window_days=bad)
    assert params[0] == 1


def test_only_terminal_scan_jobs_count_towards_the_rate() -> None:
    """A queued or running job has no outcome to be right or wrong about."""
    sql, _ = _run()
    assert "FILTER (WHERE j.status IN ('succeeded', 'failed'))" in sql
    assert "FILTER (WHERE j.status = 'succeeded')" in sql
    assert "FILTER (WHERE j.status = 'failed')" in sql


def test_a_job_with_no_finish_time_still_dates_itself() -> None:
    """Rows predating the finished_at bookkeeping must not erase the factor's timestamp."""
    sql, _ = _run()
    assert "MAX(COALESCE(j.finished_at, j.created_at))" in sql


# --- the parse-error count --------------------------------------------------------------


def test_parse_errors_are_counted_on_the_default_branch_only() -> None:
    """A spec that fails to parse on a feature branch is not the repository's health."""
    sql, _ = _run()
    assert "f.branch = COALESCE(NULLIF(r.default_branch, ''), 'main')" in sql


def test_the_parse_error_predicate_matches_the_partial_index(repo_root) -> None:
    """V231's partial index only helps if the DAO filters on exactly its predicate."""
    sql, _ = _run()
    predicate = "f.quality_status = 'error' OR f.quality_reason = 'parse-failed'"
    assert predicate in sql
    migration = (
        repo_root / "apiome-db/scripts/V231__repository_health_badge_indexes_repo_6_5.sql"
    ).read_text()
    assert "quality_status = 'error' OR quality_reason = 'parse-failed'" in migration


def test_the_last_parse_error_is_dated() -> None:
    sql, _ = _run()
    assert "MAX(f.quality_scored_at) AS last_parse_error_at" in sql


# --- token health -----------------------------------------------------------------------


def test_token_health_reads_the_linked_account_of_the_repository() -> None:
    sql, _ = _run()
    assert "LEFT JOIN apiome.external_auth_providers eap" in sql
    assert "eap.id = r.linked_account_id" in sql


def test_only_linked_account_repositories_require_a_token() -> None:
    sql, _ = _run()
    assert "(r.source = 'linked_account') AS token_required" in sql


def test_the_access_token_value_is_never_selected() -> None:
    """The badge needs to know a token *exists*, never what it is; a secret that is not
    read cannot leak through a listing response."""
    sql, _ = _run()
    assert "AS has_access_token" in sql
    assert "eap.access_token AS" not in sql
    assert "eap.access_token," not in sql


def test_a_blank_access_token_counts_as_no_token() -> None:
    sql, _ = _run()
    assert "btrim(eap.access_token) <> ''" in sql


# --- shape ------------------------------------------------------------------------------


def test_missing_aggregates_default_to_zero_rather_than_null() -> None:
    """A repository with no scan jobs at all must read as "0 attempted", not as NULL."""
    sql, _ = _run()
    assert "COALESCE(s.scans_attempted, 0) AS scans_attempted" in sql
    assert "COALESCE(s.scans_succeeded, 0) AS scans_succeeded" in sql
    assert "COALESCE(q.parse_error_count, 0) AS parse_error_count" in sql


def test_both_aggregates_are_correlated_laterals_so_the_batch_is_one_round_trip() -> None:
    sql, _ = _run(repository_ids=[_REPO, _OTHER_REPO])
    assert sql.count("LEFT JOIN LATERAL") == 2


def test_placeholders_and_parameters_line_up() -> None:
    for kwargs in ({}, {"repository_ids": [_REPO]}, {"window_days": 7}):
        sql, params = _run(**kwargs)
        assert sql.count("%s") == len(params), kwargs


def test_the_row_carries_every_field_the_health_module_reads() -> None:
    """Keeps the projection and ``repository_health.signals_from_row`` from drifting."""
    sql, _ = _run()
    for column in (
        "repository_id",
        "token_required",
        "linked_account_present",
        "has_access_token",
        "token_expires_at",
        "scans_attempted",
        "scans_succeeded",
        "last_scan_finished_at",
        "last_scan_failed_at",
        "parse_error_count",
        "last_parse_error_at",
    ):
        assert column in sql, column


def test_the_query_reads_and_does_not_write() -> None:
    sql, _ = _run()
    upper = sql.upper()
    for forbidden in ("INSERT ", "UPDATE ", "DELETE ", "ALTER ", "DROP "):
        assert forbidden not in upper, forbidden
