"""Database tests for the registry audit ledger queries (#3481, 7.4).

These exercise the SQL builders directly with ``execute_query`` mocked: the tenant scope, the
filter WHERE fragments, and the offset-vs-cursor pagination switch. The append-only insert is
verified to be best-effort (a DB error is swallowed, not raised).
"""

from datetime import datetime, timezone
from unittest.mock import MagicMock

from app.database import Database

_TENANT = "tenant-1"
_NOW = datetime(2026, 6, 23, 12, 0, 0, tzinfo=timezone.utc)


def test_count_registry_audit_filtered_scopes_to_tenant():
    db = Database()
    db.execute_query = MagicMock(return_value=[{"cnt": 7}])
    out = db.count_registry_audit_filtered(_TENANT)
    assert out == 7
    sql, params = db.execute_query.call_args[0]
    assert "FROM apiome.registry_audit ra" in sql
    assert "ra.tenant_id = %s" in sql
    assert params == (_TENANT,)


def test_count_registry_audit_filtered_empty_is_zero():
    db = Database()
    db.execute_query = MagicMock(return_value=[])
    assert db.count_registry_audit_filtered(_TENANT) == 0


def test_search_registry_audit_offset_mode_builds_filters():
    db = Database()
    db.execute_query = MagicMock(return_value=[])
    db.search_registry_audit(
        _TENANT,
        primitive_id="p1",
        actions=["primitive.create", "primitive.update"],
        actor_id="u1",
        outcome="success",
        schema_id="https://api.apiome.dev/types/tenant/acme/my-type",
        limit=25,
        offset=50,
    )
    sql, params = db.execute_query.call_args[0]
    # Newest-first ordering and offset pagination (no cursor predicate).
    assert "ORDER BY ra.created_at DESC, ra.id DESC" in sql
    assert "OFFSET %s" in sql
    assert "(ra.created_at, ra.id) <" not in sql
    # Tenant first, then each filter in order, then limit + offset.
    assert params[0] == _TENANT
    assert "p1" in params
    assert "primitive.create" in params and "primitive.update" in params
    assert "u1" in params and "success" in params
    assert params[-2:] == (25, 50)


def test_search_registry_audit_cursor_mode_uses_keyset_predicate():
    db = Database()
    db.execute_query = MagicMock(return_value=[])
    db.search_registry_audit(
        _TENANT,
        limit=10,
        cursor_created_at=_NOW,
        cursor_id="aaaaaaaa-bbbb-cccc-dddd-000000000001",
    )
    sql, params = db.execute_query.call_args[0]
    # Cursor mode adds a keyset predicate and omits OFFSET.
    assert "(ra.created_at, ra.id) < (%s, %s::uuid)" in sql
    assert "OFFSET %s" not in sql
    assert params[-1] == 10  # limit is last, no trailing offset


def test_insert_registry_audit_is_best_effort():
    db = Database()
    conn = MagicMock()
    conn.cursor.side_effect = RuntimeError("db down")
    db.connect = MagicMock(return_value=conn)
    # Must not raise even though the connection blows up mid-insert.
    db.insert_registry_audit(_TENANT, "primitive.create", "success", primitive_id="p1")
    conn.rollback.assert_called_once()
