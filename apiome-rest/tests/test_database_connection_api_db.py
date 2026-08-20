"""Guards on the ``Database`` write paths that drive a connection directly (#5325 follow-up).

Nine methods called a ``self.get_connection()`` that has never existed on ``Database``, so every
one of them raised ``AttributeError`` and returned a 500 the first time it ran. The route tests
never caught it because they patch the whole ``db`` object, so the method bodies never execute.

Two guards live here: a static sweep that fails on *any* call to a ``self.<name>()`` the class does
not define, and behavioural tests that run each repaired method against a mocked connection.
"""

import ast
from pathlib import Path
from unittest.mock import MagicMock

import psycopg2

from app.database import Database

_DB_SOURCE = Path(__file__).resolve().parents[1] / "src" / "app" / "database.py"

_TENANT = "660e8400-e29b-41d4-a716-446655440000"
_USER = "660e8400-e29b-41d4-a716-446655440001"
_EP = "11111111-1111-1111-1111-111111111111"
_NOTE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
_COLL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

_UNSET = object()  # so a caller can ask for a fetchone() of None


def _db(rowcount=1, fetchone=_UNSET):
    """A ``Database`` whose ``connect()`` hands back a mocked psycopg2 connection."""
    db = Database()
    conn = MagicMock()
    # ``_begin_tx`` inspects the transaction status and restores ``autocommit`` in a finally.
    conn.info.transaction_status = psycopg2.extensions.TRANSACTION_STATUS_IDLE
    conn.autocommit = False
    cursor = conn.cursor.return_value.__enter__.return_value
    cursor.rowcount = rowcount
    if fetchone is not _UNSET:
        if isinstance(fetchone, list):
            cursor.fetchone.side_effect = fetchone
        else:
            cursor.fetchone.return_value = fetchone
    db.connect = MagicMock(return_value=conn)
    return db, conn, cursor


def _sql(cursor, index=0):
    return cursor.execute.call_args_list[index][0][0]


# --- static guard ------------------------------------------------------------------------------


def test_database_calls_no_undefined_self_methods():
    """Every ``self.<name>()`` inside ``Database`` must resolve to a real attribute.

    This is the check that would have caught ``get_connection`` at all nine call sites.
    """
    tree = ast.parse(_DB_SOURCE.read_text())
    cls = next(
        n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "Database"
    )
    missing = {
        f"{node.func.attr} (line {node.lineno})"
        for node in ast.walk(cls)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and isinstance(node.func.value, ast.Name)
        and node.func.value.id == "self"
        and not hasattr(Database, node.func.attr)
    }
    assert not missing, f"Database calls undefined self methods: {sorted(missing)}"


# --- single-statement writes -------------------------------------------------------------------


def test_delete_lint_workspace_saved_view_reports_rowcount():
    db, conn, cursor = _db(rowcount=1)
    assert db.delete_lint_workspace_saved_view(_TENANT, _USER, "view-1") is True
    assert "DELETE FROM apiome.lint_workspace_saved_views" in _sql(cursor)
    conn.commit.assert_called_once()


def test_delete_lint_workspace_saved_view_false_when_no_row_matched():
    db, _, _ = _db(rowcount=0)
    assert db.delete_lint_workspace_saved_view(_TENANT, _USER, "view-1") is False


def test_delete_mcp_saved_search_reports_rowcount():
    db, conn, cursor = _db(rowcount=1)
    assert db.delete_mcp_saved_search(_TENANT, _USER, "search-1") is True
    assert "DELETE FROM apiome.mcp_saved_searches" in _sql(cursor)
    conn.commit.assert_called_once()


def test_update_mcp_endpoint_note_writes_then_reloads():
    db, conn, cursor = _db(rowcount=1)
    db.get_mcp_endpoint_note = MagicMock(return_value={"id": _NOTE, "body": "edited"})

    row = db.update_mcp_endpoint_note(_TENANT, _EP, _NOTE, _USER, body="edited")

    assert row == {"id": _NOTE, "body": "edited"}
    sql, params = cursor.execute.call_args_list[0][0]
    assert "UPDATE apiome.mcp_endpoint_notes" in sql
    assert params == ("edited", _USER, _NOTE, _TENANT, _EP)
    conn.commit.assert_called_once()
    db.get_mcp_endpoint_note.assert_called_once_with(_TENANT, _EP, _NOTE)


def test_update_mcp_endpoint_note_returns_none_when_nothing_matched():
    db, _, _ = _db(rowcount=0)
    db.get_mcp_endpoint_note = MagicMock()
    assert db.update_mcp_endpoint_note(_TENANT, _EP, _NOTE, _USER, body="x") is None
    db.get_mcp_endpoint_note.assert_not_called()


def test_delete_mcp_endpoint_note_reports_rowcount():
    db, conn, cursor = _db(rowcount=1)
    assert db.delete_mcp_endpoint_note(_TENANT, _EP, _NOTE) is True
    assert "DELETE FROM apiome.mcp_endpoint_notes" in _sql(cursor)
    conn.commit.assert_called_once()


def test_delete_mcp_collection_reports_rowcount():
    db, conn, cursor = _db(rowcount=0)
    assert db.delete_mcp_collection(_TENANT, _COLL) is False
    assert "DELETE FROM apiome.mcp_collections" in _sql(cursor)
    conn.commit.assert_called_once()


# --- multi-statement transactions --------------------------------------------------------------


def test_create_mcp_collection_inserts_collection_and_members():
    db, conn, cursor = _db(fetchone={"id": _COLL, "name": "Core"})
    db._next_available_collection_slug = MagicMock(return_value="core")
    db._validate_collection_endpoint_ids = MagicMock()
    db.get_mcp_collection = MagicMock(return_value={"id": _COLL, "member_count": 2})

    out = db.create_mcp_collection(
        _TENANT,
        _USER,
        name="Core",
        slug="core",
        description=None,
        is_published=False,
        endpoint_ids=[_EP, _NOTE],
    )

    assert out == {"id": _COLL, "member_count": 2}
    assert "INSERT INTO apiome.mcp_collections" in _sql(cursor, 0)
    assert "INSERT INTO apiome.mcp_collection_members" in _sql(cursor, 1)
    assert cursor.execute.call_count == 3  # collection + one row per endpoint
    conn.commit.assert_called_once()
    # The transaction ran in manual-commit mode and restored the previous setting.
    assert conn.autocommit is False


def test_create_mcp_collection_rolls_back_on_failure():
    db, conn, cursor = _db(fetchone={"id": _COLL})
    db._next_available_collection_slug = MagicMock(return_value="core")
    db._validate_collection_endpoint_ids = MagicMock(
        side_effect=ValueError("Unknown endpoint id(s): x")
    )

    try:
        db.create_mcp_collection(
            _TENANT,
            _USER,
            name="Core",
            slug="core",
            description=None,
            is_published=False,
            endpoint_ids=["x"],
        )
        raise AssertionError("expected ValueError")
    except ValueError:
        pass

    conn.rollback.assert_called_once()
    conn.commit.assert_not_called()
    assert conn.autocommit is False


def test_replace_mcp_collection_members_rewrites_the_list():
    db, conn, cursor = _db(fetchone={"?column?": 1})
    db._validate_collection_endpoint_ids = MagicMock()
    db.list_mcp_collection_members = MagicMock(return_value=[{"endpoint_id": _EP}])

    out = db.replace_mcp_collection_members(_TENANT, _COLL, [_EP])

    assert out == [{"endpoint_id": _EP}]
    executed = [c[0][0] for c in cursor.execute.call_args_list]
    assert any("DELETE FROM apiome.mcp_collection_members" in s for s in executed)
    assert any("INSERT INTO apiome.mcp_collection_members" in s for s in executed)
    assert any("UPDATE apiome.mcp_collections" in s for s in executed)
    conn.commit.assert_called_once()


def test_replace_mcp_collection_members_returns_empty_for_unknown_collection():
    db, conn, _ = _db(fetchone=None)
    db.list_mcp_collection_members = MagicMock()
    assert db.replace_mcp_collection_members(_TENANT, _COLL, [_EP]) == []
    conn.rollback.assert_called_once()
    conn.commit.assert_not_called()


def test_add_mcp_collection_members_appends_after_the_last_position():
    db, conn, cursor = _db(fetchone=[{"?column?": 1}, {"max_pos": 2}])
    db._validate_collection_endpoint_ids = MagicMock()
    db.list_mcp_collection_members = MagicMock(return_value=[])

    db.add_mcp_collection_members(_TENANT, _COLL, [_EP])

    inserts = [
        c[0] for c in cursor.execute.call_args_list
        if "INSERT INTO apiome.mcp_collection_members" in c[0][0]
    ]
    assert len(inserts) == 1
    assert inserts[0][1][-1] == 3  # max_pos 2 -> next position is 3
    conn.commit.assert_called_once()


def test_add_mcp_collection_members_short_circuits_on_empty_list():
    db, conn, _ = _db()
    db.list_mcp_collection_members = MagicMock(return_value=[])
    assert db.add_mcp_collection_members(_TENANT, _COLL, []) == []
    conn.cursor.assert_not_called()


def test_remove_mcp_collection_member_touches_updated_at_when_a_row_went():
    db, conn, cursor = _db(rowcount=1)
    assert db.remove_mcp_collection_member(_TENANT, _COLL, _EP) is True
    executed = [c[0][0] for c in cursor.execute.call_args_list]
    assert "DELETE FROM apiome.mcp_collection_members" in executed[0]
    assert "UPDATE apiome.mcp_collections" in executed[1]
    conn.commit.assert_called_once()


def test_remove_mcp_collection_member_skips_touch_when_nothing_matched():
    db, _, cursor = _db(rowcount=0)
    assert db.remove_mcp_collection_member(_TENANT, _COLL, _EP) is False
    assert cursor.execute.call_count == 1  # no updated_at bump
