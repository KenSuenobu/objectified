"""Unit tests for the unresolved-``$ref`` DB aggregates & reconcile helper (#3457).

The SQL itself runs against Postgres in the integration suite; these guard the Python-side
contract — result shaping for the counts, and the parameter wiring (and order) for the
in-place ``UPDATE`` that re-resolves dependents. The connection/cursor is mocked.
"""

from unittest.mock import MagicMock, patch

from app.database import Database

_TID = "tenant-1"
_TARGET = "https://api.apiome.dev/types/std/v0/primitives/string"


def test_count_unresolved_refs_shapes_result():
    db = Database()
    with patch.object(
        db,
        "execute_query",
        return_value=[{"unresolved_ref_count": 3, "affected_primitive_count": 2}],
    ) as mq:
        out = db.count_unresolved_refs(_TID)
    assert out == {"unresolved_ref_count": 3, "affected_primitive_count": 2}
    # Aggregate is scoped to the tenant.
    assert mq.call_args.args[1] == (_TID,)


def test_count_unresolved_refs_defaults_to_zero():
    db = Database()
    # COUNT() never returns NULL, but guard the empty/None path anyway.
    with patch.object(
        db,
        "execute_query",
        return_value=[{"unresolved_ref_count": None, "affected_primitive_count": None}],
    ):
        assert db.count_unresolved_refs(_TID) == {
            "unresolved_ref_count": 0,
            "affected_primitive_count": 0,
        }


def test_get_primitives_with_unresolved_refs_is_tenant_scoped():
    db = Database()
    rows = [{"id": "p1", "name": "money", "refs": []}]
    with patch.object(db, "execute_query", return_value=rows) as mq:
        assert db.get_primitives_with_unresolved_refs(_TID) is rows
    assert mq.call_args.args[1] == (_TID,)


def test_mark_refs_resolved_to_target_param_order_and_count():
    db = Database()
    mock_conn = MagicMock()
    mock_cursor = MagicMock()
    mock_cursor.rowcount = 2
    mock_cm = MagicMock()
    mock_cm.__enter__.return_value = mock_cursor
    mock_cm.__exit__.return_value = False
    mock_conn.cursor.return_value = mock_cm

    with patch.object(db, "connect", return_value=mock_conn):
        affected = db.mark_refs_resolved_to_target(_TID, _TARGET)

    assert affected == 2
    # Params are (target, tenant, target) — matching the SET subquery, the tenant
    # filter, and the EXISTS guard in that textual order.
    assert mock_cursor.execute.call_args.args[1] == (_TARGET, _TID, _TARGET)
    mock_conn.commit.assert_called_once()


def test_mark_refs_resolved_to_target_rolls_back_on_error():
    db = Database()
    mock_conn = MagicMock()
    mock_cursor = MagicMock()
    mock_cursor.execute.side_effect = RuntimeError("boom")
    mock_cm = MagicMock()
    mock_cm.__enter__.return_value = mock_cursor
    mock_cm.__exit__.return_value = False
    mock_conn.cursor.return_value = mock_cm

    with patch.object(db, "connect", return_value=mock_conn):
        try:
            db.mark_refs_resolved_to_target(_TID, _TARGET)
            assert False, "expected the error to propagate"
        except RuntimeError:
            pass

    mock_conn.rollback.assert_called_once()
    mock_conn.commit.assert_not_called()
