"""DAO contract for the webhook source-IP allowlist (REPO-7.6, #2804).

Statement-level tests over the ``Database`` methods behind the filter. They run against a
recording cursor rather than a database, so what they pin is the SQL contract — and for a
security filter that contract is most of the security:

* the guard's tenant lookup must not select a signing secret, because it runs *before*
  verification and a query that fetched one would be a refactor away from using it;
* the range refresh must be a replace inside one transaction, so a decommissioned range
  stops being trusted and no reader ever sees a provider with zero ranges mid-refresh;
* every tenant-facing read and write must be scoped by ``tenant_id`` as well as by id, so
  one workspace cannot reach another's entries by guessing a UUID.
"""

from typing import Any, Dict, List, Optional, Tuple

import pytest

from app.database import Database

_TENANT = "550e8400-e29b-41d4-a716-446655440000"
_ENTRY = "aa0e8400-e29b-41d4-a716-44665544000a"


class _RecordingCursor:
    """Captures executed SQL; every write reports one affected row."""

    def __init__(self, row: Optional[Dict[str, Any]] = None) -> None:
        self.executed: List[Tuple[str, Any]] = []
        self.rowcount = 1
        self._row = row

    def __enter__(self) -> "_RecordingCursor":
        return self

    def __exit__(self, *exc: Any) -> bool:
        return False

    def execute(self, query: str, params: Any = None) -> None:
        self.executed.append((query, params))

    def fetchone(self) -> Optional[Dict[str, Any]]:
        return self._row

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


# --- the guard's tenant lookup -----------------------------------------------------------


def test_the_guard_lookup_never_selects_a_signing_secret() -> None:
    """It runs before verification. A query that fetched the secret on that path would be
    one careless edit away from comparing against it."""
    recorder = _QueryRecorder([{"tenant_id": _TENANT}])
    db = Database()
    db.execute_query = recorder  # type: ignore[method-assign]
    db.list_repository_webhook_tenant_ids("github", "octocat/hello-world")
    assert "secret" not in recorder.sql.lower()


def test_the_guard_lookup_excludes_removed_repositories() -> None:
    """A repository the tenant deleted must not keep its allowlist alive because a
    provider hook was left behind."""
    recorder = _QueryRecorder([])
    db = Database()
    db.execute_query = recorder  # type: ignore[method-assign]
    db.list_repository_webhook_tenant_ids("github", "octocat/hello-world")
    assert "r.deleted_at IS NULL" in recorder.sql
    assert recorder.params == ("github", "octocat/hello-world")


def test_the_guard_lookup_returns_each_tenant_once() -> None:
    recorder = _QueryRecorder([])
    db = Database()
    db.execute_query = recorder  # type: ignore[method-assign]
    db.list_repository_webhook_tenant_ids("github", "octocat/hello-world")
    assert "SELECT DISTINCT s.tenant_id" in recorder.sql


# --- the provider range cache ------------------------------------------------------------


def test_the_range_read_is_scoped_to_one_provider() -> None:
    recorder = _QueryRecorder([])
    db = Database()
    db.execute_query = recorder  # type: ignore[method-assign]
    db.list_webhook_provider_ip_ranges("github")
    assert "WHERE provider = %s" in recorder.sql
    assert recorder.params == ("github",)


def test_a_refresh_deletes_the_ranges_the_provider_no_longer_publishes() -> None:
    """Append-only would keep a decommissioned address range trusted forever."""
    cursor = _RecordingCursor()
    _db_with(cursor).replace_webhook_provider_ip_ranges(
        "github", [{"cidr": "192.30.252.0/22", "family": 4, "source": "provider"}]
    )
    delete_sql, delete_params = cursor.executed[0]
    assert "DELETE FROM apiome.webhook_provider_ip_range" in delete_sql
    assert "cidr <> ALL(%s)" in delete_sql
    assert delete_params == ("github", ["192.30.252.0/22"])


def test_a_refresh_is_one_transaction() -> None:
    """Delete-then-insert across two transactions would leave a window in which the
    provider has no ranges — and in strict mode that window rejects everything."""
    cursor = _RecordingCursor()
    conn = _RecordingConn(cursor)
    db = Database()
    db.connect = lambda: conn  # type: ignore[method-assign]
    db.replace_webhook_provider_ip_ranges(
        "github",
        [
            {"cidr": "192.30.252.0/22", "family": 4, "source": "provider"},
            {"cidr": "2a0a:a440::/29", "family": 6, "source": "provider"},
        ],
    )
    assert conn.commits == 1
    assert len(cursor.executed) == 3  # one delete, two upserts


def test_a_surviving_range_is_upserted_not_recreated() -> None:
    """`created_at` has to keep meaning "first seen"; only `refreshed_at` moves."""
    cursor = _RecordingCursor()
    _db_with(cursor).replace_webhook_provider_ip_ranges(
        "github", [{"cidr": "192.30.252.0/22", "family": 4, "source": "provider"}]
    )
    insert_sql = cursor.executed[1][0]
    assert "ON CONFLICT (provider, cidr) DO UPDATE" in insert_sql
    assert "refreshed_at = CURRENT_TIMESTAMP" in insert_sql
    assert "created_at" not in insert_sql.split("ON CONFLICT", 1)[1]


def test_the_cache_can_never_be_emptied_through_this_method() -> None:
    """The caller treats an empty fetch as a failure precisely so this cannot happen; the
    guard rail is here as well because the consequence is a filter with nothing in it."""
    cursor = _RecordingCursor()
    with pytest.raises(ValueError, match="refusing to empty"):
        _db_with(cursor).replace_webhook_provider_ip_ranges("github", [])
    assert cursor.executed == []


def test_a_failed_refresh_rolls_back_rather_than_half_applying() -> None:
    class _Exploding(_RecordingCursor):
        def execute(self, query: str, params: Any = None) -> None:
            super().execute(query, params)
            raise RuntimeError("deadlock detected")

    cursor = _Exploding()
    conn = _RecordingConn(cursor)
    db = Database()
    db.connect = lambda: conn  # type: ignore[method-assign]
    with pytest.raises(RuntimeError):
        db.replace_webhook_provider_ip_ranges(
            "github", [{"cidr": "192.30.252.0/22", "family": 4, "source": "provider"}]
        )
    assert conn.rollbacks == 1
    assert conn.commits == 0


# --- refresh state -----------------------------------------------------------------------


def test_only_a_success_advances_the_success_timestamp() -> None:
    """The gap between the attempt and success timestamps is the staleness signal; a
    single `refreshed_at` could not distinguish "fresh" from "failing since Tuesday"."""
    cursor = _RecordingCursor()
    _db_with(cursor).record_webhook_provider_ip_refresh(
        "github", outcome="failure", error="503", range_count=None
    )
    assert "last_attempt_at = CURRENT_TIMESTAMP" in cursor.sql
    assert cursor.params[1] is False  # the success flag


def test_a_failure_leaves_the_previous_range_count_alone() -> None:
    """Zeroing it would make the panel claim the cache is empty when the cache is intact
    and merely stale."""
    cursor = _RecordingCursor()
    _db_with(cursor).record_webhook_provider_ip_refresh("github", outcome="failure")
    assert "ELSE apiome.webhook_provider_ip_refresh.range_count" in cursor.sql


def test_refresh_state_is_upserted_per_provider() -> None:
    cursor = _RecordingCursor()
    _db_with(cursor).record_webhook_provider_ip_refresh(
        "github", outcome="success", range_count=12
    )
    assert "ON CONFLICT (provider) DO UPDATE" in cursor.sql
    assert cursor.params[1] is True


# --- tenant entries ----------------------------------------------------------------------


def test_the_delivery_path_read_excludes_disabled_entries() -> None:
    recorder = _QueryRecorder([])
    db = Database()
    db.execute_query = recorder  # type: ignore[method-assign]
    db.list_tenant_webhook_ip_allowlist(_TENANT, enabled_only=True)
    assert "%s::boolean IS FALSE OR enabled IS TRUE" in recorder.sql
    assert recorder.params == (_TENANT, True)


def test_the_panel_read_includes_disabled_entries() -> None:
    recorder = _QueryRecorder([])
    db = Database()
    db.execute_query = recorder  # type: ignore[method-assign]
    db.list_tenant_webhook_ip_allowlist(_TENANT)
    assert recorder.params == (_TENANT, False)


def test_re_adding_an_existing_range_updates_and_re_enables_it() -> None:
    """A re-submitted form should leave the operator with what they asked for, not a 409
    and an entry that is still disabled."""
    cursor = _RecordingCursor({"id": _ENTRY})
    _db_with(cursor).add_tenant_webhook_ip_allowlist_entry(
        _TENANT, cidr="203.0.113.0/24", family=4, description="relay"
    )
    assert "ON CONFLICT (tenant_id, cidr) DO UPDATE" in cursor.sql
    assert "enabled = TRUE" in cursor.sql


def test_toggling_an_entry_is_scoped_by_tenant_as_well_as_id() -> None:
    """The id alone would let one workspace disable another's entry by guessing a UUID."""
    cursor = _RecordingCursor({"id": _ENTRY})
    _db_with(cursor).set_tenant_webhook_ip_allowlist_entry_enabled(_TENANT, _ENTRY, False)
    assert "WHERE id = %s::uuid AND tenant_id = %s::uuid" in cursor.sql
    assert cursor.params == (False, _ENTRY, _TENANT)


def test_deleting_an_entry_is_scoped_by_tenant_and_returns_what_it_removed() -> None:
    """The audit row has to name the CIDR that stopped being allowed, and the row is gone
    by the time the caller could read it back."""
    cursor = _RecordingCursor({"id": _ENTRY, "cidr": "203.0.113.0/24"})
    removed = _db_with(cursor).delete_tenant_webhook_ip_allowlist_entry(_TENANT, _ENTRY)
    assert "WHERE id = %s::uuid AND tenant_id = %s::uuid" in cursor.sql
    assert "RETURNING" in cursor.sql
    assert removed["cidr"] == "203.0.113.0/24"


# --- the tenant policy -------------------------------------------------------------------


def test_a_tenant_with_no_policy_row_reads_as_none() -> None:
    recorder = _QueryRecorder([])
    db = Database()
    db.execute_query = recorder  # type: ignore[method-assign]
    assert db.get_tenant_webhook_ip_policy(_TENANT) is None
    assert recorder.params == (_TENANT,)


def test_setting_the_policy_is_an_upsert_that_records_who_changed_it() -> None:
    cursor = _RecordingCursor({"tenant_id": _TENANT, "enforcement_enabled": False})
    _db_with(cursor).set_tenant_webhook_ip_policy(
        _TENANT,
        enforcement_enabled=False,
        bypass_reason="vendor relay",
        updated_by="660e8400-e29b-41d4-a716-446655440001",
    )
    assert "ON CONFLICT (tenant_id) DO UPDATE" in cursor.sql
    assert cursor.params[1] is False
    assert cursor.params[2] == "vendor relay"
    assert cursor.params[3] == "660e8400-e29b-41d4-a716-446655440001"
