"""DAO tests for the per-tenant polling quota (REPO-4.6, #2784).

Statement-level tests over the three ``Database`` methods the scheduler and the REST surface
use to read and write ``apiome.tenants.repository_polls_per_hour``. They run against a
recording cursor rather than a database, so what they pin is the SQL contract: the tenant
scoping, the soft-delete exclusion, and the rails the setter applies before the column's CHECK
would have to.
"""

from typing import Any, Dict, List, Optional

import pytest

from app.database import Database

_TENANT = "550e8400-e29b-41d4-a716-446655440000"


class _RecordingCursor:
    """Captures executed SQL; returns canned rows for reads."""

    def __init__(self, rows: Optional[List[Dict[str, Any]]] = None, rowcount: int = 1):
        self.rows = rows if rows is not None else []
        self.executed: List[Any] = []
        self.rowcount = rowcount

    def __enter__(self) -> "_RecordingCursor":
        return self

    def __exit__(self, *exc: Any) -> bool:
        return False

    def execute(self, query: str, params: Any = None) -> None:
        self.executed.append((query, params))

    def fetchall(self) -> List[Dict[str, Any]]:
        return list(self.rows)


class _RecordingConn:
    def __init__(self, cursor: _RecordingCursor):
        self._cursor = cursor

    def cursor(self) -> _RecordingCursor:
        return self._cursor

    def commit(self) -> None:
        pass

    def rollback(self) -> None:  # pragma: no cover - error paths only
        pass


def _db_with(cursor: _RecordingCursor) -> Database:
    db = Database()
    db.connect = lambda: _RecordingConn(cursor)  # type: ignore[method-assign]
    return db


# --- single-tenant read -----------------------------------------------------------------


def test_get_reads_the_column_for_a_live_tenant() -> None:
    cursor = _RecordingCursor([{"repository_polls_per_hour": 600}])
    assert _db_with(cursor).get_tenant_repository_polls_per_hour(_TENANT) == 600

    query, params = cursor.executed[0]
    assert "SELECT repository_polls_per_hour" in query
    assert "FROM apiome.tenants" in query
    assert "WHERE id = %s::uuid AND deleted_at IS NULL" in query
    assert params == (_TENANT,)


def test_get_returns_zero_rather_than_treating_it_as_missing() -> None:
    """0 is a real, meaningful value (unlimited) — it must survive the read."""
    cursor = _RecordingCursor([{"repository_polls_per_hour": 0}])
    assert _db_with(cursor).get_tenant_repository_polls_per_hour(_TENANT) == 0


def test_get_returns_none_for_an_unknown_tenant() -> None:
    cursor = _RecordingCursor([])
    assert _db_with(cursor).get_tenant_repository_polls_per_hour(_TENANT) is None


def test_get_returns_none_for_a_null_column() -> None:
    cursor = _RecordingCursor([{"repository_polls_per_hour": None}])
    assert _db_with(cursor).get_tenant_repository_polls_per_hour(_TENANT) is None


# --- bulk read (one per sweep tick) ------------------------------------------------------


def test_list_returns_every_live_tenant_keyed_by_id() -> None:
    cursor = _RecordingCursor(
        [
            {"id": "t1", "repository_polls_per_hour": 60},
            {"id": "t2", "repository_polls_per_hour": 600},
            {"id": "t3", "repository_polls_per_hour": 0},
        ]
    )
    assert _db_with(cursor).list_tenant_repository_polls_per_hour() == {
        "t1": 60,
        "t2": 600,
        "t3": 0,
    }


def test_list_excludes_soft_deleted_tenants() -> None:
    """A deleted tenant has no due repositories to bound."""
    cursor = _RecordingCursor([])
    _db_with(cursor).list_tenant_repository_polls_per_hour()
    query, _ = cursor.executed[0]
    assert "WHERE deleted_at IS NULL" in query


def test_list_omits_rows_the_caller_cannot_use() -> None:
    """A NULL quota is omitted so the caller's default applies rather than a bogus 0."""
    cursor = _RecordingCursor(
        [
            {"id": "t1", "repository_polls_per_hour": None},
            {"id": None, "repository_polls_per_hour": 60},
            {"id": "t2", "repository_polls_per_hour": 60},
        ]
    )
    assert _db_with(cursor).list_tenant_repository_polls_per_hour() == {"t2": 60}


# --- write -------------------------------------------------------------------------------


def test_set_updates_the_scoped_live_tenant() -> None:
    cursor = _RecordingCursor(rowcount=1)
    assert _db_with(cursor).set_tenant_repository_polls_per_hour(_TENANT, 600) == 600

    query, params = cursor.executed[0]
    assert "UPDATE apiome.tenants" in query
    assert "SET repository_polls_per_hour = %s" in query
    assert "updated_at = CURRENT_TIMESTAMP" in query
    assert "WHERE id = %s::uuid AND deleted_at IS NULL" in query
    assert params == (600, _TENANT)


def test_set_accepts_zero_as_the_unlimited_opt_out() -> None:
    cursor = _RecordingCursor(rowcount=1)
    assert _db_with(cursor).set_tenant_repository_polls_per_hour(_TENANT, 0) == 0
    assert cursor.executed[0][1] == (0, _TENANT)


def test_set_rejects_a_negative_quota_before_touching_the_database() -> None:
    """Fail in the DAO with a clear message rather than as a CHECK violation."""
    cursor = _RecordingCursor()
    with pytest.raises(ValueError, match="zero or positive"):
        _db_with(cursor).set_tenant_repository_polls_per_hour(_TENANT, -1)
    assert cursor.executed == []


def test_set_returns_none_when_no_live_tenant_matched() -> None:
    cursor = _RecordingCursor(rowcount=0)
    assert _db_with(cursor).set_tenant_repository_polls_per_hour(_TENANT, 120) is None
