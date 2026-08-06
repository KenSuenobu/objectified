"""Custom palette action persistence — DUW-5.5 (private-suite#2592).

Exercises :mod:`app.workspace_custom_action_store` against a scripted fake connection, following
the ``test_domains_store.py`` precedent: no live Postgres, just the SQL these functions emit and
the transaction discipline around it. The database's own guarantees — the CHECKs, the partial
unique index — are proven against a real server in ``test_workspace_custom_action_migration.py``.

The properties that get the most attention, because each fails silently:

* **Every statement carries the tenant.** Scoping by ``tenant_id`` in the WHERE clause is what
  makes another tenant's action unreadable rather than merely unlisted; a query that forgot it
  would pass any single-tenant test.
* **Every write commits, and a failed one rolls back.**
* **A delete is an UPDATE of ``deleted_at``, never a DELETE.**
* **Absent and null are different PATCH values for ``name_contains``** — the one nullable field.
* **A malformed id short-circuits** to None/False without touching the connection, so garbage in
  a path segment cannot become a driver-level cast error.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional, Sequence

import pytest

from app.workspace_custom_action_store import (
    CustomActionConflictError,
    create_action,
    delete_action,
    get_action,
    list_actions,
    update_action,
)

TENANT = "11111111-1111-1111-1111-111111111111"
ACTION = "22222222-2222-2222-2222-222222222222"
USER = "66666666-6666-6666-6666-666666666666"


class FakeCursor:
    """Records every statement and replays scripted results in order."""

    def __init__(self, conn: "FakeConnection") -> None:
        self.conn = conn

    def execute(self, query: str, params: Sequence[Any] = ()) -> None:
        self.conn.statements.append((" ".join(query.split()), tuple(params)))
        self.conn._advance()

    def fetchone(self) -> Optional[Dict[str, Any]]:
        return self.conn._take()

    def fetchall(self) -> List[Dict[str, Any]]:
        value = self.conn._take()
        return value if isinstance(value, list) else ([] if value is None else [value])

    def __enter__(self) -> "FakeCursor":
        return self

    def __exit__(self, *exc: Any) -> None:
        return None


class FakeConnection:
    """A psycopg2-shaped connection whose results are scripted per statement."""

    def __init__(self, results: Optional[List[Any]] = None) -> None:
        self.results = list(results or [])
        self.statements: List[tuple] = []
        self.commits = 0
        self.rollbacks = 0
        self._pending: Any = None
        self.raise_on: Optional[tuple] = None

    def _advance(self) -> None:
        if self.raise_on and self.raise_on[0] in self.statements[-1][0]:
            raise self.raise_on[1]
        self._pending = self.results.pop(0) if self.results else None

    def _take(self) -> Any:
        value = self._pending
        self._pending = None
        return value

    def cursor(self) -> FakeCursor:
        return FakeCursor(self)

    def commit(self) -> None:
        self.commits += 1

    def rollback(self) -> None:
        self.rollbacks += 1


class FakeDb:
    """Minimal ``_DbLike`` returning one connection."""

    def __init__(self, conn: FakeConnection) -> None:
        self._conn = conn

    def connect(self) -> FakeConnection:
        return self._conn


class UniqueViolationError(Exception):
    """Stands in for psycopg2's unique-violation, identified by SQLSTATE like the real one."""

    pgcode = "23505"

    def __init__(self) -> None:
        super().__init__(
            'duplicate key value violates unique constraint '
            '"uq_workspace_custom_actions_tenant_name"'
        )


def row(**overrides) -> Dict[str, Any]:
    base = {
        "id": ACTION,
        "tenant_id": TENANT,
        "created_by": USER,
        "name": "Open runbook",
        "subject": "class",
        "name_contains": None,
        "effects": [{"type": "hydrate-set"}],
        "deleted_at": None,
        "created_at": "2026-08-05T00:00:00Z",
        "updated_at": "2026-08-05T00:00:00Z",
    }
    base.update(overrides)
    return base


class TestListActions:
    def test_it_reads_live_rows_of_one_tenant_in_name_order(self):
        conn = FakeConnection(results=[[row()]])
        actions = list_actions(FakeDb(conn), tenant_id=TENANT)

        assert actions == [row()]
        query, params = conn.statements[0]
        assert "tenant_id = %s::uuid" in query
        assert "deleted_at IS NULL" in query
        assert "ORDER BY lower(name)" in query
        assert params == (TENANT,)

    def test_the_read_commits_so_the_shared_connection_leaves_no_transaction_open(self):
        conn = FakeConnection(results=[[]])
        list_actions(FakeDb(conn), tenant_id=TENANT)
        assert conn.commits == 1


class TestGetAction:
    def test_it_scopes_by_id_and_tenant_together(self):
        conn = FakeConnection(results=[row()])
        assert get_action(FakeDb(conn), tenant_id=TENANT, action_id=ACTION) == row()

        query, params = conn.statements[0]
        assert "id = %s::uuid AND tenant_id = %s::uuid" in query
        assert "deleted_at IS NULL" in query
        assert params == (ACTION, TENANT)

    def test_a_malformed_id_answers_none_without_touching_the_database(self):
        conn = FakeConnection()
        assert get_action(FakeDb(conn), tenant_id=TENANT, action_id="not-a-uuid") is None
        assert conn.statements == []


class TestCreateAction:
    def test_it_inserts_the_definition_with_effects_as_jsonb(self):
        conn = FakeConnection(results=[row()])
        effects = [{"type": "open-url", "url": "https://example.com/{subject}"}]

        created = create_action(
            FakeDb(conn),
            tenant_id=TENANT,
            created_by=USER,
            name="Open runbook",
            subject="class",
            name_contains="Invoice",
            effects=effects,
        )

        assert created == row()
        query, params = conn.statements[0]
        assert "INSERT INTO apiome.workspace_custom_actions" in query
        assert "%s::jsonb" in query
        assert params == (TENANT, USER, "Open runbook", "class", "Invoice", json.dumps(effects))
        assert conn.commits == 1

    def test_a_unique_violation_surfaces_as_a_typed_conflict_and_rolls_back(self):
        conn = FakeConnection()
        conn.raise_on = ("INSERT", UniqueViolationError())

        with pytest.raises(CustomActionConflictError) as excinfo:
            create_action(
                FakeDb(conn),
                tenant_id=TENANT,
                created_by=USER,
                name="Open runbook",
                subject="class",
                name_contains=None,
                effects=[{"type": "hydrate-set"}],
            )

        assert excinfo.value.name == "Open runbook"
        assert conn.rollbacks == 1
        assert conn.commits == 0


class TestUpdateAction:
    def test_only_supplied_fields_are_written(self):
        conn = FakeConnection(results=[row(name="Renamed")])
        update_action(FakeDb(conn), tenant_id=TENANT, action_id=ACTION, name="Renamed")

        query, params = conn.statements[0]
        # Only the SET clause is inspected: every column legitimately appears in RETURNING.
        set_clause = query.split("WHERE")[0].split("SET", 1)[1]
        assert set_clause.strip() == "name = %s"
        assert params == ("Renamed", ACTION, TENANT)
        assert conn.commits == 1

    def test_an_update_only_reaches_live_rows_of_the_callers_tenant(self):
        conn = FakeConnection(results=[row()])
        update_action(FakeDb(conn), tenant_id=TENANT, action_id=ACTION, name="Renamed")

        query, _ = conn.statements[0]
        assert "id = %s::uuid AND tenant_id = %s::uuid AND deleted_at IS NULL" in query

    def test_supplying_none_clears_the_narrowing_while_absent_leaves_it(self):
        # None is a value for the one nullable column…
        conn = FakeConnection(results=[row()])
        update_action(
            FakeDb(conn), tenant_id=TENANT, action_id=ACTION, name_contains=None
        )
        query, params = conn.statements[0]
        assert "name_contains = %s" in query
        assert params == (None, ACTION, TENANT)

        # …and not supplying it emits no assignment at all: nothing to write means the current
        # row is read back instead of an empty UPDATE being sent.
        conn = FakeConnection(results=[row()])
        update_action(FakeDb(conn), tenant_id=TENANT, action_id=ACTION)
        query, _ = conn.statements[0]
        assert query.startswith("SELECT")

    def test_new_effects_travel_as_jsonb(self):
        conn = FakeConnection(results=[row()])
        effects = [{"type": "lens-switch", "lens": "combined"}]
        update_action(FakeDb(conn), tenant_id=TENANT, action_id=ACTION, effects=effects)

        query, params = conn.statements[0]
        assert "effects = %s::jsonb" in query
        assert params == (json.dumps(effects), ACTION, TENANT)

    def test_a_unique_violation_surfaces_as_a_typed_conflict(self):
        conn = FakeConnection()
        conn.raise_on = ("UPDATE", UniqueViolationError())

        with pytest.raises(CustomActionConflictError):
            update_action(FakeDb(conn), tenant_id=TENANT, action_id=ACTION, name="Taken")
        assert conn.rollbacks == 1

    def test_a_malformed_id_answers_none_without_touching_the_database(self):
        conn = FakeConnection()
        assert (
            update_action(FakeDb(conn), tenant_id=TENANT, action_id="nope", name="X") is None
        )
        assert conn.statements == []


class TestDeleteAction:
    def test_a_delete_is_a_soft_delete(self):
        conn = FakeConnection(results=[{"id": ACTION}])
        assert delete_action(FakeDb(conn), tenant_id=TENANT, action_id=ACTION) is True

        query, params = conn.statements[0]
        assert query.startswith("UPDATE")
        assert "SET deleted_at = CURRENT_TIMESTAMP" in query
        assert "DELETE" not in query.replace("deleted_at", "")
        assert "id = %s::uuid AND tenant_id = %s::uuid AND deleted_at IS NULL" in query
        assert params == (ACTION, TENANT)
        assert conn.commits == 1

    def test_nothing_live_to_delete_answers_false(self):
        conn = FakeConnection(results=[None])
        assert delete_action(FakeDb(conn), tenant_id=TENANT, action_id=ACTION) is False

    def test_a_malformed_id_answers_false_without_touching_the_database(self):
        conn = FakeConnection()
        assert delete_action(FakeDb(conn), tenant_id=TENANT, action_id="nope") is False
        assert conn.statements == []
