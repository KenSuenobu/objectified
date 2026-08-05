"""Consumption-index reads — DUW-1.4 (private-suite#2571).

Exercises :mod:`app.consumption_index_store` against a scripted fake connection, following the
``test_workspace_summary_store.py`` precedent. No live Postgres here: this asserts the SQL these
functions emit, the number of statements they emit it in, and which tables they read. That the SQL
*finds the right rows* is proven against a server in ``test_consumption_index_db.py``.

The properties that get the most attention, because each fails silently:

* **Seven statements, whatever the scope.** Hydrating an operation's schemas through the per-
  operation reads is three round trips each; a 218-path catalog would be six hundred. An N+1 here
  passes every functional test and only surfaces as latency on a catalog no fixture has.
* **The scope narrows paths, never classes.** A nested edge routinely leaves the scoped folder, so
  the class statements must stay whole-version however narrow the request is.
* **`shared/` survives the join.** ``IS NOT DISTINCT FROM``, because ``NULL = NULL`` would answer
  "empty" for the largest folder in most catalogs.
* **Only the tables the emitter reads are indexed.** The V028-era response and schema tables were
  superseded by V031–V034; indexing them would invent edges no exported document contains.
* **Reads commit.** A SELECT opens a transaction too; leaving the shared connection idle in one
  holds locks and blocks VACUUM.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence

import pytest

from app.consumption_index_store import (
    SHARED_DOMAIN_ID,
    domain_scope,
    id_scope,
    load_version_facts,
    whole_version_scope,
)

VERSION = "11111111-1111-1111-1111-111111111111"
DOMAIN = "22222222-2222-2222-2222-2222222222aa"
PATH_A = "33333333-3333-3333-3333-33333333aaaa"
PATH_B = "33333333-3333-3333-3333-33333333bbbb"

#: How many statements one read costs. Asserted as a number rather than a range, because the whole
#: point is that it does not move with the size of the catalog or the narrowness of the scope.
STATEMENTS = 7


class FakeCursor:
    """Records every statement and replays scripted results in order."""

    def __init__(self, conn: "FakeConnection") -> None:
        self.conn = conn

    def execute(self, query: str, params: Sequence[Any] = ()) -> None:
        self.conn.statements.append((" ".join(query.split()), tuple(params)))
        self.conn._advance()

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


def run(scope, results: Optional[List[Any]] = None):
    """Load facts through a fake connection, returning ``(facts, connection)``."""
    conn = FakeConnection(results)
    facts = load_version_facts(FakeDb(conn), version_id=VERSION, scope=scope)
    return facts, conn


def statement_reading(conn: FakeConnection, table: str) -> Optional[tuple]:
    """The first recorded statement mentioning a table, or None."""
    for statement in conn.statements:
        if table in statement[0]:
            return statement
    return None


# ─── Scope selectors ─────────────────────────────────────────────────────────


class TestScopes:
    """Each selector describes itself, so a response can say which question it answered."""

    def test_whole_version_adds_no_predicate(self):
        scope = whole_version_scope()
        assert scope.sql == ""
        assert scope.params == ()
        assert scope.kind == "version"
        assert scope.domain_id is None
        assert scope.path_ids == ()

    def test_domain_scope_joins_shared_with_is_not_distinct_from(self):
        """``NULL = NULL`` would answer 'empty' for the largest folder in most catalogs."""
        scope = domain_scope(None)
        assert "IS NOT DISTINCT FROM" in scope.sql
        assert " = %s" not in scope.sql
        assert scope.params == (None,)
        assert scope.kind == "domain"

    def test_domain_scope_carries_the_folder(self):
        scope = domain_scope(DOMAIN)
        assert scope.params == (DOMAIN,)
        assert scope.domain_id == DOMAIN

    def test_id_scope_binds_an_array(self):
        scope = id_scope([PATH_A, PATH_B])
        assert "= ANY(%s::uuid[])" in scope.sql
        assert scope.params == ([PATH_A, PATH_B],)
        assert scope.kind == "path_ids"
        assert scope.path_ids == (PATH_A, PATH_B)

    def test_shared_token_is_the_one_shared_by_every_workspace_read(self):
        assert SHARED_DOMAIN_ID == "shared"


# ─── The read ────────────────────────────────────────────────────────────────


class TestStatementBudget:
    """Cost tracks the catalog once, never the operation count."""

    @pytest.mark.parametrize(
        "scope",
        [whole_version_scope(), domain_scope(DOMAIN), domain_scope(None), id_scope([PATH_A])],
        ids=["version", "domain", "shared", "path_ids"],
    )
    def test_seven_statements_for_every_scope(self, scope):
        _, conn = run(scope)
        assert len(conn.statements) == STATEMENTS

    def test_statement_count_does_not_move_with_the_catalog(self):
        """A hundred paths cost what one costs — the N+1 this module exists to avoid."""
        paths = [{"id": f"p{i}", "pathname": f"/p{i}", "domain_id": None} for i in range(100)]
        operations = [
            {
                "id": f"o{i}",
                "version_path_id": f"p{i}",
                "operation": "GET",
                "operation_id": None,
                "summary": None,
                "deprecated": False,
            }
            for i in range(100)
        ]
        _, conn = run(whole_version_scope(), [[], [], paths, operations, [], [], []])
        assert len(conn.statements) == STATEMENTS


class TestScopeApplication:
    """The scope narrows the path side of the read, and only the path side."""

    @pytest.mark.parametrize("table", ["apiome.classes", "apiome.class_properties"])
    def test_class_statements_are_never_scoped(self, table):
        """A nested edge leaves the folder — ``customers/`` returning Customer drags in Address."""
        _, conn = run(domain_scope(DOMAIN))
        statement = statement_reading(conn, table)
        assert statement is not None
        assert statement[1] == (VERSION,)
        assert "domain_id" not in statement[0]

    def test_every_path_side_statement_carries_the_scope(self):
        """The five path-side statements — paths, operations, requests, responses, parameters."""
        _, conn = run(domain_scope(DOMAIN))
        scoped = [s for s in conn.statements if "IS NOT DISTINCT FROM" in s[0]]
        assert len(scoped) == STATEMENTS - 2
        assert all(statement[1] == (VERSION, DOMAIN) for statement in scoped)

    def test_every_statement_is_scoped_by_version(self):
        _, conn = run(whole_version_scope())
        assert all(statement[1][0] == VERSION for statement in conn.statements)
        assert all("version_id = %s::uuid" in statement[0] for statement in conn.statements)

    def test_soft_deleted_classes_are_excluded(self):
        _, conn = run(whole_version_scope())
        for table in ("apiome.classes", "apiome.class_properties"):
            assert "deleted_at IS NULL" in statement_reading(conn, table)[0]


class TestSchemaSources:
    """Only the tables the emitter reads, because an edge must match the exported document."""

    @pytest.mark.parametrize(
        "table",
        [
            "apiome.shared_path_request_body_content",
            "apiome.shared_path_response",
            "apiome.shared_path_response_content",
            "apiome.shared_path_parameter",
        ],
    )
    def test_reads_the_tables_the_emitter_reads(self, table):
        _, conn = run(whole_version_scope())
        assert statement_reading(conn, table) is not None

    @pytest.mark.parametrize(
        "table",
        [
            "apiome.path_response ",
            "apiome.path_response_content",
            "apiome.path_operation_schema",
            "apiome.path_parameter_schema",
            "apiome.path_parameter ",
        ],
    )
    def test_ignores_the_superseded_v028_tables(self, table):
        """V031–V034 replaced these; nothing writes them, so indexing them would invent edges."""
        _, conn = run(whole_version_scope())
        assert statement_reading(conn, table) is None

    def test_responses_left_join_their_content_types(self):
        """The fallback exists: a response may carry its schema on the response row itself."""
        _, conn = run(whole_version_scope())
        statement = statement_reading(conn, "apiome.shared_path_response_content")[0]
        assert "LEFT JOIN apiome.shared_path_response_content" in statement
        assert "content_class_id" in statement


class TestProjection:
    """Rows arrive in the seven buckets the resolver expects, in statement order."""

    def test_each_statements_rows_land_in_their_own_bucket(self):
        results = [
            [{"id": "c1"}],
            [{"class_id": "c1"}],
            [{"id": PATH_A}],
            [{"id": "o1"}],
            [{"path_operation_id": "o1"}],
            [{"path_operation_id": "o1", "status_code": "200"}],
            [{"path_operation_id": "o1", "data": {}}],
        ]
        facts, _ = run(whole_version_scope(), results)
        assert facts.classes == results[0]
        assert facts.class_properties == results[1]
        assert facts.paths == results[2]
        assert facts.operations == results[3]
        assert facts.request_contents == results[4]
        assert facts.response_contents == results[5]
        assert facts.parameters == results[6]

    def test_an_empty_version_yields_empty_buckets_rather_than_none(self):
        facts, _ = run(whole_version_scope())
        assert facts.classes == []
        assert facts.paths == []
        assert facts.parameters == []


class TestTransactions:
    """A bare SELECT opens a transaction, so a read that does not end one leaks it."""

    def test_a_successful_read_commits(self):
        _, conn = run(whole_version_scope())
        assert (conn.commits, conn.rollbacks) == (1, 0)

    def test_a_failing_read_rolls_back_and_propagates(self):
        conn = FakeConnection()
        conn.raise_on = ("apiome.shared_path_parameter", RuntimeError("boom"))
        with pytest.raises(RuntimeError):
            load_version_facts(FakeDb(conn), version_id=VERSION, scope=whole_version_scope())
        assert (conn.commits, conn.rollbacks) == (0, 1)
