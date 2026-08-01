"""DAO contract for the repository notification policy (REPO-7.2, #2800).

Statement-level tests over the ``Database`` methods behind the opt-out gate, the hourly
throttle and channel resolution. They run against a recording cursor rather than a database,
so what they pin is the SQL contract — the tenant scoping, the conflict target the throttle
depends on, the fact that the claim decision and the timestamp write are one statement, and
the fact that channel resolution never selects a secret.
"""

from typing import Any, Dict, List, Optional, Tuple

import pytest

from app.database import Database

_TENANT = "550e8400-e29b-41d4-a716-446655440000"
_REPO = "880e8400-e29b-41d4-a716-446655440003"
_EVENT = "repository.refresh.auto_paused"


class _RecordingCursor:
    """Captures executed SQL and hands back canned rows, one per ``fetchone`` in order."""

    def __init__(self, fetchone_results: Optional[List[Any]] = None):
        self.executed: List[Tuple[str, Any]] = []
        self._fetchone_results = list(fetchone_results or [])

    def __enter__(self) -> "_RecordingCursor":
        return self

    def __exit__(self, *exc: Any) -> bool:
        return False

    def execute(self, query: str, params: Any = None) -> None:
        self.executed.append((query, params))

    def fetchone(self) -> Any:
        if not self._fetchone_results:
            return None
        return self._fetchone_results.pop(0)

    def fetchall(self) -> List[Dict[str, Any]]:
        return []

    @property
    def statements(self) -> List[str]:
        return [query for query, _ in self.executed]


class _RecordingConn:
    def __init__(self, cursor: _RecordingCursor):
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

    def __init__(self, rows: Optional[List[Dict[str, Any]]] = None):
        self.calls: List[Tuple[str, Tuple[Any, ...]]] = []
        self._rows = rows or []

    def __call__(self, sql: str, params: Tuple[Any, ...] = ()) -> List[Dict[str, Any]]:
        self.calls.append((sql, tuple(params or ())))
        return list(self._rows)

    @property
    def only_call(self) -> Tuple[str, Tuple[Any, ...]]:
        assert len(self.calls) == 1, f"expected one query, got {len(self.calls)}"
        return self.calls[0]


def _db_reading(rows: Optional[List[Dict[str, Any]]] = None) -> Tuple[Database, _QueryRecorder]:
    db = Database.__new__(Database)  # no connection: execute_query is the only I/O seam
    recorder = _QueryRecorder(rows)
    db.execute_query = recorder  # type: ignore[method-assign]
    return db, recorder


# --- the opt-out read the dispatcher gates on --------------------------------------------


def test_the_gate_read_selects_only_the_muted_rows() -> None:
    """It must match the V232 partial index; a full scan of preferences would be paid on
    every notifiable event."""
    db, recorder = _db_reading()
    db.list_muted_repository_notification_events(_TENANT, _REPO)
    sql, params = recorder.only_call
    assert "enabled = FALSE" in sql
    assert params == (_TENANT, _REPO)


def test_the_gate_read_is_scoped_to_the_tenant_as_well_as_the_repository() -> None:
    db, recorder = _db_reading()
    db.list_muted_repository_notification_events(_TENANT, _REPO)
    sql, _ = recorder.only_call
    assert "tenant_id = %s::uuid" in sql
    assert "repository_id = %s::uuid" in sql


def test_the_gate_read_returns_plain_event_type_strings() -> None:
    db, _ = _db_reading([{"event_type": _EVENT}])
    assert db.list_muted_repository_notification_events(_TENANT, _REPO) == [_EVENT]


def test_the_preferences_read_returns_only_what_was_explicitly_stored() -> None:
    """Filling in the defaults is the projection layer's job, not the DAO's."""
    db, recorder = _db_reading()
    db.list_repository_notification_preferences(_TENANT, _REPO)
    sql, params = recorder.only_call
    assert "FROM apiome.repository_notification_preference" in sql
    assert "enabled = FALSE" not in sql
    assert params == (_TENANT, _REPO)


def test_the_preferences_read_is_ordered_so_the_api_answer_is_stable() -> None:
    db, recorder = _db_reading()
    db.list_repository_notification_preferences(_TENANT, _REPO)
    assert "ORDER BY event_type" in recorder.only_call[0]


# --- writing an opt-out ------------------------------------------------------------------


def test_setting_a_preference_verifies_the_repository_belongs_to_the_tenant_first() -> None:
    """The foreign key would happily accept another tenant's repository id."""
    cursor = _RecordingCursor([{"id": _REPO}, {"event_type": _EVENT, "enabled": False}])
    _db_with(cursor).set_repository_notification_preference(_TENANT, _REPO, _EVENT, False)
    first = cursor.statements[0]
    assert "FROM apiome.tenant_repositories" in first
    assert "tenant_id = %s::uuid" in first
    assert "deleted_at IS NULL" in first


def test_setting_a_preference_for_a_foreign_repository_writes_nothing() -> None:
    cursor = _RecordingCursor([None])
    stored = _db_with(cursor).set_repository_notification_preference(
        _TENANT, _REPO, _EVENT, False
    )
    assert stored is None
    assert len(cursor.executed) == 1


def test_setting_a_preference_upserts_rather_than_accumulating_rows() -> None:
    cursor = _RecordingCursor([{"id": _REPO}, {"event_type": _EVENT, "enabled": False}])
    _db_with(cursor).set_repository_notification_preference(_TENANT, _REPO, _EVENT, False)
    upsert = cursor.statements[1]
    assert "ON CONFLICT (repository_id, event_type) DO UPDATE" in upsert
    assert "SET enabled = EXCLUDED.enabled" in upsert


def test_setting_a_preference_returns_the_stored_row() -> None:
    cursor = _RecordingCursor([{"id": _REPO}, {"event_type": _EVENT, "enabled": True}])
    stored = _db_with(cursor).set_repository_notification_preference(
        _TENANT, _REPO, _EVENT, True
    )
    assert stored == {"event_type": _EVENT, "enabled": True}


# --- the throttle claim ------------------------------------------------------------------


def test_the_claim_decides_and_stamps_in_one_statement() -> None:
    """A read-then-write throttle lets two sweep workers both see a stale timestamp and both
    notify. The conditional upsert makes the decision the write."""
    cursor = _RecordingCursor([{"id": "throttle-1"}])
    _db_with(cursor).claim_repository_notification_slot(_TENANT, _REPO, _EVENT, 3600)
    claim = cursor.statements[0]
    assert "INSERT INTO apiome.repository_notification_throttle AS t" in claim
    assert "ON CONFLICT (repository_id, event_type) DO UPDATE" in claim
    assert "SET last_notified_at = CURRENT_TIMESTAMP" in claim
    assert "WHERE %s <= 0" in claim
    assert "t.last_notified_at <= CURRENT_TIMESTAMP - make_interval(secs => %s)" in claim


def test_a_winning_claim_is_reported_as_won() -> None:
    cursor = _RecordingCursor([{"id": "throttle-1"}])
    assert _db_with(cursor).claim_repository_notification_slot(
        _TENANT, _REPO, _EVENT, 3600
    )


def test_a_winning_claim_does_not_count_itself_as_suppressed() -> None:
    cursor = _RecordingCursor([{"id": "throttle-1"}])
    _db_with(cursor).claim_repository_notification_slot(_TENANT, _REPO, _EVENT, 3600)
    assert len(cursor.executed) == 1


def test_a_losing_claim_is_reported_as_lost_and_counted() -> None:
    """"Quiet" and "muffled" have to be distinguishable after the fact."""
    cursor = _RecordingCursor([None])
    assert not _db_with(cursor).claim_repository_notification_slot(
        _TENANT, _REPO, _EVENT, 3600
    )
    bump = cursor.statements[1]
    assert "SET suppressed_count = suppressed_count + 1" in bump


def test_the_window_is_passed_to_both_places_the_statement_needs_it() -> None:
    cursor = _RecordingCursor([{"id": "throttle-1"}])
    _db_with(cursor).claim_repository_notification_slot(_TENANT, _REPO, _EVENT, 900)
    _, params = cursor.executed[0]
    assert params == (_TENANT, _REPO, _EVENT, 900, 900)


def test_a_non_positive_window_disables_throttling_in_the_statement_itself() -> None:
    """The ``%s <= 0`` disjunct is what makes a zero window always win, without the caller
    having to know to skip the claim."""
    cursor = _RecordingCursor([{"id": "throttle-1"}])
    _db_with(cursor).claim_repository_notification_slot(_TENANT, _REPO, _EVENT, 0)
    _, params = cursor.executed[0]
    assert params[3] == 0


def test_a_string_window_is_coerced_before_it_reaches_make_interval() -> None:
    cursor = _RecordingCursor([{"id": "throttle-1"}])
    _db_with(cursor).claim_repository_notification_slot(_TENANT, _REPO, _EVENT, "1800")
    _, params = cursor.executed[0]
    assert params[3] == 1800


# --- reading throttle state --------------------------------------------------------------


def test_reading_throttle_state_never_claims_a_slot() -> None:
    """It is a support/API read; claiming here would consume the operator's own quiet hour."""
    db, recorder = _db_reading()
    db.get_repository_notification_throttle(_TENANT, _REPO)
    sql, params = recorder.only_call
    assert sql.strip().startswith("SELECT")
    assert "INSERT" not in sql.upper()
    assert params == (_TENANT, _REPO)


def test_reading_throttle_state_reports_both_halves_of_the_story() -> None:
    db, recorder = _db_reading()
    db.get_repository_notification_throttle(_TENANT, _REPO)
    sql, _ = recorder.only_call
    assert "last_notified_at" in sql
    assert "suppressed_count" in sql


# --- channel resolution ------------------------------------------------------------------


def test_channel_resolution_selects_only_what_routing_needs() -> None:
    """A secret pulled into a fan-out is a secret in a log line one exception away."""
    db, recorder = _db_reading()
    db.list_active_push_webhook_subscription_channels(_TENANT)
    sql, params = recorder.only_call
    assert "SELECT id, url" in sql
    for secret in ("signing_secret", "secret_enc", "secret_hash"):
        assert secret not in sql
    assert params == (_TENANT,)


def test_channel_resolution_skips_inactive_and_deleted_subscriptions() -> None:
    """A notification queued for a channel that cannot receive it only ever dead-letters."""
    db, recorder = _db_reading()
    db.list_active_push_webhook_subscription_channels(_TENANT)
    sql, _ = recorder.only_call
    assert "active = true" in sql
    assert "deleted_at IS NULL" in sql


def test_channel_resolution_stringifies_ids_for_the_dispatcher() -> None:
    import uuid as _uuid

    subscription_id = _uuid.UUID("990e8400-e29b-41d4-a716-446655440007")
    db, _ = _db_reading([{"id": subscription_id, "url": "https://a.test/h"}])
    channels = db.list_active_push_webhook_subscription_channels(_TENANT)
    assert channels == [{"id": str(subscription_id), "url": "https://a.test/h"}]


@pytest.mark.parametrize(
    "method, args",
    [
        ("list_muted_repository_notification_events", (_TENANT, _REPO)),
        ("list_repository_notification_preferences", (_TENANT, _REPO)),
        ("get_repository_notification_throttle", (_TENANT, _REPO)),
        ("list_active_push_webhook_subscription_channels", (_TENANT,)),
    ],
)
def test_every_policy_read_is_a_single_round_trip(method: str, args: Tuple[Any, ...]) -> None:
    """These run inside the sweep's per-repository tick; a second query per event would be
    paid on every failing repository, every tick."""
    db, recorder = _db_reading()
    getattr(db, method)(*args)
    assert len(recorder.calls) == 1
