"""DAO contract for the quota telemetry counters (REPO-7.3, #2801).

Statement-level tests over the three ``Database`` methods behind the rolling window.
They run against a recording cursor rather than a database, so what they pin is the SQL
contract: that an increment is one atomic upsert (two replicas sweeping the same tenant
converge on one row instead of each creating their own), that the read is tenant-scoped
and bounded, and that the prune is bounded by age rather than unqualified.
"""

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import pytest

from app.database import Database
from app.repository_quota_window import (
    METRIC_BYTES_SCANNED,
    METRIC_POLLS,
    WINDOW_DAY,
    WINDOW_HOUR,
)

_TENANT = "550e8400-e29b-41d4-a716-446655440000"
_WINDOW = datetime(2026, 7, 31, 14, 0, tzinfo=timezone.utc)


class _RecordingCursor:
    """Captures executed SQL; every write reports one affected row."""

    def __init__(self) -> None:
        self.executed: List[Tuple[str, Any]] = []
        self.rowcount = 1

    def __enter__(self) -> "_RecordingCursor":
        return self

    def __exit__(self, *exc: Any) -> bool:
        return False

    def execute(self, query: str, params: Any = None) -> None:
        self.executed.append((query, params))

    def fetchall(self) -> List[Dict[str, Any]]:
        return []

    @property
    def sql(self) -> str:
        return self.executed[0][0]

    @property
    def params(self) -> Any:
        return self.executed[0][1]


class _RecordingConn:
    def __init__(self, cursor: _RecordingCursor) -> None:
        self._cursor = cursor
        self.commits = 0
        self.rollbacks = 0

    def cursor(self) -> _RecordingCursor:
        return self._cursor

    def commit(self) -> None:
        self.commits += 1

    def rollback(self) -> None:
        self.rollbacks += 1


def _db_with(cursor: _RecordingCursor) -> Database:
    db = Database()
    db.connect = lambda: _RecordingConn(cursor)  # type: ignore[method-assign]
    return db


class _QueryRecorder:
    """Stands in for ``Database.execute_query``, recording the (sql, params) pair."""

    def __init__(self, rows: Optional[List[Dict[str, Any]]] = None) -> None:
        self.calls: List[Tuple[str, Tuple[Any, ...]]] = []
        self._rows = rows or []

    def __call__(self, sql: str, params: Tuple[Any, ...] = ()) -> List[Dict[str, Any]]:
        self.calls.append((sql, tuple(params or ())))
        return self._rows

    @property
    def sql(self) -> str:
        return self.calls[0][0]

    @property
    def params(self) -> Tuple[Any, ...]:
        return self.calls[0][1]


# --- the increment -----------------------------------------------------------------------


def test_an_increment_is_a_single_upsert() -> None:
    """Read-then-write would let two replicas in the same window each read 0 and each
    write 1, losing half the tenant's traffic."""
    cursor = _RecordingCursor()
    _db_with(cursor).increment_repository_quota_window(
        tenant_id=_TENANT,
        metric=METRIC_POLLS,
        window_kind=WINDOW_HOUR,
        window_start=_WINDOW,
        amount=3,
    )
    assert len(cursor.executed) == 1
    assert "INSERT INTO apiome.repository_quota_window" in cursor.sql
    assert "ON CONFLICT (tenant_id, metric, window_start) DO UPDATE" in cursor.sql


def test_the_upsert_adds_to_the_stored_amount_rather_than_replacing_it() -> None:
    cursor = _RecordingCursor()
    _db_with(cursor).increment_repository_quota_window(
        tenant_id=_TENANT,
        metric=METRIC_POLLS,
        window_kind=WINDOW_HOUR,
        window_start=_WINDOW,
        amount=3,
    )
    assert (
        "SET amount = apiome.repository_quota_window.amount + EXCLUDED.amount" in cursor.sql
    )


def test_the_increment_stores_the_bucket_the_caller_computed() -> None:
    """Truncating in SQL instead would put the writer and the reader on two different
    definitions of "which window is this", and would make a clock override untestable."""
    cursor = _RecordingCursor()
    _db_with(cursor).increment_repository_quota_window(
        tenant_id=_TENANT,
        metric=METRIC_BYTES_SCANNED,
        window_kind=WINDOW_DAY,
        window_start=_WINDOW,
        amount=4096,
    )
    assert cursor.params == (_TENANT, METRIC_BYTES_SCANNED, WINDOW_DAY, _WINDOW, 4096)


def test_the_increment_commits() -> None:
    cursor = _RecordingCursor()
    db = Database()
    conn = _RecordingConn(cursor)
    db.connect = lambda: conn  # type: ignore[method-assign]
    db.increment_repository_quota_window(
        tenant_id=_TENANT,
        metric=METRIC_POLLS,
        window_kind=WINDOW_HOUR,
        window_start=_WINDOW,
        amount=1,
    )
    assert conn.commits == 1
    assert conn.rollbacks == 0


# --- the dashboard read ------------------------------------------------------------------


def test_the_read_is_scoped_to_one_tenant() -> None:
    db = Database()
    recorder = _QueryRecorder()
    db.execute_query = recorder  # type: ignore[method-assign]
    db.list_repository_quota_windows(_TENANT, _WINDOW)
    assert "tenant_id = %s::uuid" in recorder.sql
    assert recorder.params[0] == _TENANT


def test_the_read_is_bounded_by_the_range_start() -> None:
    """Without the bound a long-lived tenant's dashboard read grows with the age of the
    deployment rather than with the range asked for."""
    db = Database()
    recorder = _QueryRecorder()
    db.execute_query = recorder  # type: ignore[method-assign]
    db.list_repository_quota_windows(_TENANT, _WINDOW)
    assert "window_start >= %s" in recorder.sql
    assert recorder.params[1] == _WINDOW


def test_the_read_returns_every_metric_in_one_round_trip() -> None:
    """One query per metric would make the panel cost five round trips to say the same
    thing."""
    db = Database()
    recorder = _QueryRecorder()
    db.execute_query = recorder  # type: ignore[method-assign]
    db.list_repository_quota_windows(_TENANT, _WINDOW)
    assert "metric = " not in recorder.sql
    assert "SELECT metric, window_kind, window_start, amount" in recorder.sql


def test_the_read_is_ordered_oldest_window_first() -> None:
    db = Database()
    recorder = _QueryRecorder()
    db.execute_query = recorder  # type: ignore[method-assign]
    db.list_repository_quota_windows(_TENANT, _WINDOW)
    assert "ORDER BY window_start ASC" in recorder.sql


def test_the_read_hands_back_what_the_database_returned() -> None:
    db = Database()
    rows = [{"metric": METRIC_POLLS, "window_start": _WINDOW, "amount": 2}]
    db.execute_query = _QueryRecorder(rows)  # type: ignore[method-assign]
    assert db.list_repository_quota_windows(_TENANT, _WINDOW) == rows


# --- retention ---------------------------------------------------------------------------


def test_the_prune_deletes_only_windows_older_than_the_cutoff() -> None:
    """An unqualified DELETE here would erase the dashboard rather than trim it."""
    cursor = _RecordingCursor()
    _db_with(cursor).prune_repository_quota_windows(older_than=_WINDOW)
    assert cursor.sql.strip().startswith("DELETE FROM apiome.repository_quota_window")
    assert "WHERE window_start < %s" in cursor.sql
    assert cursor.params == (_WINDOW,)


def test_the_prune_reports_how_much_it_removed() -> None:
    cursor = _RecordingCursor()
    cursor.rowcount = 17
    assert _db_with(cursor).prune_repository_quota_windows(older_than=_WINDOW) == 17


@pytest.mark.parametrize(
    "sql_fragment", ["DROP", "TRUNCATE", "UPDATE apiome.repository_quota_window SET amount = 0"]
)
def test_the_dao_never_zeroes_a_counter(sql_fragment: str) -> None:
    """A window boundary is the reset. A statement that zeroed a live counter would make
    the history lie about a window that had already been read."""
    cursor = _RecordingCursor()
    db = _db_with(cursor)
    db.increment_repository_quota_window(
        tenant_id=_TENANT,
        metric=METRIC_POLLS,
        window_kind=WINDOW_HOUR,
        window_start=_WINDOW,
        amount=1,
    )
    db.prune_repository_quota_windows(older_than=_WINDOW)
    assert all(sql_fragment not in sql for sql, _ in cursor.executed)
